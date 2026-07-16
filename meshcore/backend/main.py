# Meshcore Plugin — maxg10/meshcore — GPL-3.0
"""Read-only Meshcore ingestion: connects to a Meshcore companion node
(serial or TCP) and injects its known nodes into the MeshPulse map as
net='MC' nodes."""

import asyncio
import threading

from mapper.plugin_api import MeshPlugin

ROLE_MAP = {1: 'CLIENT', 2: 'REPEATER', 3: 'ROUTER', 4: 'CLIENT'}
TYPE_MAP = {1: 'Companion', 2: 'Repeater', 3: 'Room Server', 4: 'Sensor'}

RETRY_DELAYS = (5, 15, 60)          # reconnect backoff, capped at the last value
MIN_REAL_TIMESTAMP = 1600000000     # device reports last_advert=1 for contacts it never heard directly


def parse_tcp_target(raw):
    """Parse 'host', 'host:port', or '[ipv6]:port' into (host, port).
    Port defaults to 5000 (Meshcore companion standard).
    Returns (host, None) when the port part is present but invalid."""
    raw = (raw or '').strip()
    default_port = 5000
    if raw.startswith('['):            # [ipv6]:port or [ipv6]
        host, _, rest = raw[1:].partition(']')
        port = rest[1:] if rest.startswith(':') else ''
    elif raw.count(':') == 1:          # host:port
        host, _, port = raw.partition(':')
    else:                              # bare host OR bare ipv6 (multiple colons)
        host, port = raw, ''
    if port:
        try:
            p = int(port)
            if not (1 <= p <= 65535):
                raise ValueError
        except ValueError:
            return host, None          # None signals invalid port to caller
        return host, p
    return host, default_port


class MeshcorePlugin(MeshPlugin):

    def __init__(self):
        super().__init__()
        self._thread = None
        self._loop = None
        self._task = None
        self._stop_event = threading.Event()
        self._tcp_host = None
        self._tcp_port = None
        self._unknown_advert_logged = False

    # ── lifecycle ────────────────────────────────────────────────────────────

    def on_enable(self):
        conn_type = self.config.get('connection_type', 'serial')

        if conn_type == 'serial':
            if not (self.config.get('device_path') or '').strip():
                print('[MESHCORE] Not configured — set the serial device path in plugin config')
                return
        elif conn_type == 'tcp':
            raw = (self.config.get('tcp_host') or '').strip()
            if not raw:
                print('[MESHCORE] Not configured — set the TCP host in plugin config')
                return
            host, port = parse_tcp_target(raw)
            if not host or port is None:
                print(f"[MESHCORE] Invalid TCP target '{raw}' — port must be 1-65535, not starting")
                return
            self._tcp_host, self._tcp_port = host, port
        else:
            print(f"[MESHCORE] Unknown connection type '{conn_type}' — not starting")
            return

        self._start_worker()

    def on_disable(self):
        self._stop_worker()
        print('[MESHCORE] Disabled')

    # ── worker thread (daemon thread + stop event, same pattern as MQTT Proxy) ─

    def _start_worker(self):
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._thread_main, daemon=True)
        self._thread.start()

    def _thread_main(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._task = loop.create_task(self._worker())
        try:
            loop.run_until_complete(self._task)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f'[MESHCORE] Worker error: {e}')
        finally:
            self._task = None
            self._loop = None
            loop.close()

    def _stop_worker(self):
        self._stop_event.set()
        loop, task = self._loop, self._task
        if loop and task:
            try:
                loop.call_soon_threadsafe(task.cancel)
            except RuntimeError:
                pass
        if self._thread:
            self._thread.join(timeout=10)
            self._thread = None

    # ── worker ───────────────────────────────────────────────────────────────

    async def _worker(self):
        # Deferred import: plugin_manager installs requirements.txt at enable
        # time, so the library must not be imported when this module loads.
        try:
            from meshcore import MeshCore, EventType
        except ImportError as e:
            print(f'[MESHCORE] meshcore library not installed ({e}) — re-enable the plugin to retry')
            return

        backoff_idx = 0
        while not self._stop_event.is_set():
            mc = None
            try:
                mc = await self._connect(MeshCore)
                backoff_idx = 0
                await self._session(mc, EventType)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f'[MESHCORE] Connection failed: {e}')
            finally:
                if mc is not None:
                    try:
                        await mc.disconnect()
                    except Exception:
                        pass
            if self._stop_event.is_set():
                break
            delay = RETRY_DELAYS[min(backoff_idx, len(RETRY_DELAYS) - 1)]
            backoff_idx += 1
            print(f'[MESHCORE] Reconnecting in {delay}s...')
            await asyncio.sleep(delay)

    async def _connect(self, MeshCore):
        if self.config.get('connection_type', 'serial') == 'tcp':
            print(f'[MESHCORE] Connecting to {self._tcp_host}:{self._tcp_port} (TCP)...')
            return await MeshCore.create_tcp(
                host=self._tcp_host, port=self._tcp_port,
                auto_reconnect=True, max_reconnect_attempts=3)
        device_path = (self.config.get('device_path') or '').strip()
        print(f'[MESHCORE] Connecting to {device_path} (serial)...')
        return await MeshCore.create_serial(
            port=device_path, baudrate=115200,
            auto_reconnect=True, max_reconnect_attempts=3)

    async def _session(self, mc, EventType):
        injected, with_pos = self._inject(mc.self_info, is_self=True)

        await mc.ensure_contacts()
        n, m = self._inject_contacts(mc)
        injected += n
        with_pos += m
        print(f'[MESHCORE] Synced {injected} nodes ({with_pos} with position)')

        def on_event(event):
            self._handle_event(mc, event)

        mc.subscribe(EventType.ADVERTISEMENT, on_event)
        mc.subscribe(EventType.NEW_CONTACT, on_event)

        # Periodic contact re-sync is the primary data path — Meshcore
        # adverts are rare, so events alone would go stale.
        while not self._stop_event.is_set():
            await asyncio.sleep(self._sync_interval())
            await mc.ensure_contacts()
            self._inject(mc.self_info, is_self=True)
            self._inject_contacts(mc)

    def _handle_event(self, mc, event):
        """ADVERTISEMENT / NEW_CONTACT handler. Advert payload shape is not
        fully documented — accept dicts carrying a public_key, log anything
        else once and skip. Runs inside the meshcore dispatcher: never raise."""
        try:
            payload = getattr(event, 'payload', None)
            if not isinstance(payload, dict) or not payload.get('public_key'):
                if not self._unknown_advert_logged:
                    self._unknown_advert_logged = True
                    print(f'[MESHCORE] Unknown advert shape: {payload!r}')
                return
            # Prefer the full contact entry when the node is already known
            src = (mc.contacts or {}).get(payload['public_key']) or payload
            self._inject(src)
        except Exception as e:
            print(f'[MESHCORE] Event handling error: {e}')

    # ── mapping / injection ──────────────────────────────────────────────────

    def _map_node(self, src, is_self=False):
        """Map a Meshcore contact / self_info dict to an inject_node() dict.
        Returns None when the entry has no usable public_key."""
        if not isinstance(src, dict):
            return None
        pubkey = src.get('public_key')
        if not isinstance(pubkey, str) or len(pubkey) < 8:
            return None
        t = src.get('adv_type') if is_self else src.get('type')
        node = {
            'id': 'mc!' + pubkey[:8],
            'net': 'MC',
            'name': src.get('adv_name') or src.get('name') or ('mc!' + pubkey[:8]),
            'pubkey': pubkey,
            'role': ROLE_MAP.get(t, 'CLIENT'),
            'mc_type': TYPE_MAP.get(t, 'Unknown'),
        }
        lat = src.get('adv_lat')
        lon = src.get('adv_lon')
        if (isinstance(lat, (int, float)) and not isinstance(lat, bool)
                and isinstance(lon, (int, float)) and not isinstance(lon, bool)
                and not (lat == 0 and lon == 0)):
            node['lat'] = lat
            node['lon'] = lon
        last_advert = src.get('last_advert')
        if (isinstance(last_advert, (int, float)) and not isinstance(last_advert, bool)
                and last_advert > MIN_REAL_TIMESTAMP):
            node['mc_last_advert'] = int(last_advert)
        if is_self:
            node['mc_self'] = True
        return node

    def _inject(self, src, is_self=False):
        """Map and inject one node. Returns (injected, has_position) as 0/1."""
        node = self._map_node(src, is_self=is_self)
        if node is None:
            return 0, 0
        if self.inject_node(node):
            return 1, 1 if 'lat' in node else 0
        return 0, 0

    def _inject_contacts(self, mc):
        n = m = 0
        for entry in (mc.contacts or {}).values():
            ok, pos = self._inject(entry)
            n += ok
            m += pos
        return n, m

    def _sync_interval(self):
        try:
            interval = int(self.config.get('contact_sync_interval', 300))
        except (TypeError, ValueError):
            interval = 300
        return max(60, min(3600, interval))
