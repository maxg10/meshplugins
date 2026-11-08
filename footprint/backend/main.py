# Footprint Plugin for MeshPulse - maxg10/footprint - GPL-3.0
# Copyright (C) 2026 Mariusz "Max" Gieparda
"""Measured coverage: where your radio really hears, not where it should.

A coverage prediction says where a signal ought to reach. The nodes on the
mesh measure it for free: every position packet tells where its sender was,
and the radio that receives it knows how strong it arrived. This plugin keeps
those measurements.

* A position heard straight from the sender (hops == 0) is a sample of the
  spot it came from, with its SNR and RSSI.
* A position that only arrived through a relay (hops > 0) marks a spot your
  antenna did not hear: Meshtastic drops duplicates, so when a relayed copy
  is the one that got through, the direct one was not decoded. Near you that
  is useful ("the mesh is carrying you here"); far away it is obvious, so
  those cells are only drawn within a radius of your node.

What is measured is one direction only: from them to you. How far your own
transmitter reaches is a different number, and the panel says so.

Storage stays small on purpose. Samples are folded into a 50 m grid, one row
per cell, node and day, so a router that reports every fifteen minutes from
the same roof adds one row a day, not ninety-six. The browser asks for any
coarser grid (100 m to 5 km) and the cells are merged on the fly.

Nothing in the core's stats.db is written. It is opened read-only, once, to
build history from what MeshPulse already recorded.
"""

import bisect
import math
import os
import sqlite3
import threading
import time

from mapper.plugin_api import MeshPlugin

CHANNEL = 'footprint'
BASE_M = 50                     # storage grid
SIZES = (100, 250, 500, 1000, 2000, 5000)   # what the browser may ask for
PREC_FIT = 1.5                  # a sample counts on a grid when its position blur is at most this many cells
M_PER_DEG = 111320.0
PRUNE_EVERY_S = 3600
MIN_RADIUS_M = 3000             # automatic mesh-only radius never goes below this
RADIUS_MARGIN = 1.25            # ... and reaches this far past the farthest direct sample
MATCH_EXACT_S = 5               # history import: a Trails fix this close is the same packet
STATIONARY_S = 3600             # ... or a still node's last fix this recent
DEFAULT_STATS = '/var/www/html/meshpulse/stats.db'


# ── geometry ────────────────────────────────────────────────────────────

def distance_m(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres (haversine)."""
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _row_cos(row, size):
    """Cosine of the latitude at the middle of a grid row."""
    return max(0.01, math.cos(math.radians((row + 0.5) * size / M_PER_DEG)))


def cell_of(lat, lon, size):
    """(row, col) of the cell a point falls in, on a grid of `size` metres.

    Rows are bands of equal latitude; columns are `size` metres wide at the
    middle of their row, so cells stay square on the map at any latitude.
    """
    row = math.floor(lat * M_PER_DEG / size)
    col = math.floor(lon * M_PER_DEG * _row_cos(row, size) / size)
    return row, col


def cell_center(row, col, size):
    c = _row_cos(row, size)
    return (row + 0.5) * size / M_PER_DEG, (col + 0.5) * size / (M_PER_DEG * c)


def cell_bounds(row, col, size):
    """[south, west, north, east] of a cell."""
    c = _row_cos(row, size)
    return [row * size / M_PER_DEG, col * size / (M_PER_DEG * c),
            (row + 1) * size / M_PER_DEG, (col + 1) * size / (M_PER_DEG * c)]


def precision_cell_m(bits):
    """Size of the grid a rounded position snaps to, in metres (0 = not rounded)."""
    try:
        bits = int(bits)
    except (TypeError, ValueError):
        return 0.0
    if bits <= 0 or bits >= 32:
        return 0.0
    return (2 ** (32 - bits)) * 1e-7 * M_PER_DEG


def infer_precision_bits(lat, lon):
    """Read the precision a rounded position was sent with off the position itself.

    The firmware keeps the top `bits` of the 32-bit integer and moves the
    result to the middle of its cell, which leaves bit (31 - bits) as the
    lowest bit set. Both coordinates must agree before a grid is assumed.
    Same reasoning as in the Trails plugin. Returns None for an unrounded one.
    """
    found = []
    for v in (lat, lon):
        i = int(round(float(v) * 1e7)) & 0xFFFFFFFF
        if i == 0:
            return None
        lowest = (i & -i).bit_length() - 1
        found.append(31 - lowest)
    bits = max(found)
    return bits if 0 < bits < 28 else None


def is_placeholder(lat, lon):
    """Positions near (0, 0) are firmware placeholders, not places (same rule as the core)."""
    return abs(lat) < 0.5 and abs(lon) < 0.5


def median(values):
    s = sorted(values)
    n = len(s)
    if not n:
        return None
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


class FootprintPlugin(MeshPlugin):

    def __init__(self):
        super().__init__()
        self._db = None
        self._lock = threading.Lock()
        self._last_prune = 0
        self._retention_days = 90
        self._max_err_m = 1500.0
        self._radius_km = 0.0
        self._import = True
        self._stats_path = DEFAULT_STATS
        self._skipped_imprecise = 0
        self._import_state = None    # None, 'running', or a result dict
        self._import_thread = None
        self._halt = threading.Event()

    # ── lifecycle ───────────────────────────────────────────────────────

    def on_enable(self):
        self._apply_config(self.get_config() or {})
        self._open()
        self.register_ws_channel(CHANNEL)
        self._halt.clear()
        with self._lock:
            n = self._db.execute('SELECT COALESCE(SUM(n_direct), 0), COALESCE(SUM(n_relay), 0) FROM samples').fetchone()
            imported = self._meta('imported')
        self.log(f"{n[0]} direct and {n[1]} relayed samples, {self._retention_days} days kept")
        if imported is None and self._import:
            self._start_import()
        elif imported is not None:
            self._import_state = {'done': True, 'samples': int(imported)}

    def on_config_update(self, new_config):
        self._apply_config(new_config or {})

    def on_disable(self):
        self._halt.set()
        t = self._import_thread
        if t is not None and t.is_alive():
            t.join(timeout=5)
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None

    def _apply_config(self, cfg):
        def num(key, default, lo, hi):
            try:
                v = float(cfg.get(key, default))
            except (TypeError, ValueError):
                v = default
            return min(hi, max(lo, v))
        self._retention_days = int(num('retention_days', 90, 7, 365))
        self._max_err_m = num('max_position_error_m', 1500, 50, 6000)
        self._radius_km = num('mesh_only_radius_km', 0, 0, 200)
        self._import = cfg.get('import_history', True) is not False
        self._stats_path = (str(cfg.get('stats_db_path') or '').strip() or DEFAULT_STATS)

    # ── db ──────────────────────────────────────────────────────────────

    def _open(self):
        # data/ survives plugin upgrades (core 2.7.2+), files beside the code do not.
        data_dir = os.path.join(self.plugin_dir, 'data')
        os.makedirs(data_dir, exist_ok=True)
        db = sqlite3.connect(os.path.join(data_dir, 'footprint.db'), timeout=5, check_same_thread=False)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=NORMAL')
        db.execute('PRAGMA journal_size_limit=1048576')
        # One row per 50 m cell, node and day. SNR is kept as a sum so a cell
        # can be merged with its neighbours without touching single packets.
        db.execute('''CREATE TABLE IF NOT EXISTS samples (
                        row INTEGER NOT NULL,
                        col INTEGER NOT NULL,
                        node_id TEXT NOT NULL,
                        day INTEGER NOT NULL,       -- days since 1970-01-01, UTC
                        n_direct INTEGER NOT NULL DEFAULT 0,
                        snr_sum REAL NOT NULL DEFAULT 0,
                        snr_best REAL,
                        rssi_sum REAL NOT NULL DEFAULT 0,
                        n_rssi INTEGER NOT NULL DEFAULT 0,
                        n_relay INTEGER NOT NULL DEFAULT 0,
                        last_ts INTEGER NOT NULL,
                        prec INTEGER NOT NULL DEFAULT 0,  -- position blur in metres, 0 = exact
                        PRIMARY KEY (row, col, node_id, day)
                     ) WITHOUT ROWID''')
        db.execute('CREATE INDEX IF NOT EXISTS idx_samples_day ON samples(day)')
        db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
        db.execute('CREATE TABLE IF NOT EXISTS names (node_id TEXT PRIMARY KEY, name TEXT)')
        db.commit()
        self._db = db

    def _meta(self, key, value=None):
        """Read (value None) or write a meta value. Caller holds the lock."""
        if value is None:
            r = self._db.execute('SELECT value FROM meta WHERE key = ?', (key,)).fetchone()
            return r[0] if r else None
        self._db.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', (key, str(value)))
        return value

    # ── recording ───────────────────────────────────────────────────────

    def _own_node(self):
        """(node_id, lat, lon) of the radio MeshPulse is connected to; lat/lon may be None."""
        try:
            nid = (self.get_tracker_info() or {}).get('node_id')
        except Exception:
            nid = None
        lat = lon = None
        if nid:
            try:
                n = self.get_node(nid) or {}
                lat, lon = n.get('lat'), n.get('lon')
            except Exception:
                pass
        return nid, lat, lon

    def _name(self, node_id):
        try:
            n = self.get_node(node_id) or {}
            return n.get('name') or n.get('long_name') or None
        except Exception:
            return None

    def classify(self, p, own_id=None):
        """Decide what a position report is worth.

        Returns ('direct', lat, lon, snr, rssi, prec), ('relay', lat, lon, None,
        None, prec) or None when it says nothing about where you can hear.
        prec is how far the sender blurred its position (metres, 0 = exact):
        such a sample is kept, and only counts on grids coarse enough for it.
        """
        node_id = p.get('node_id')
        if not node_id or node_id == own_id:
            return None
        if p.get('via_mqtt'):
            return None                 # the internet carried it, not the air
        hops = p.get('hops')
        try:
            lat, lon = float(p.get('lat')), float(p.get('lon'))
            hops = int(hops)
        except (TypeError, ValueError):
            return None                 # no hop count: old firmware cannot say how it arrived
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or is_placeholder(lat, lon) or hops < 0:
            return None
        bits = p.get('precision_bits') or infer_precision_bits(lat, lon)
        prec = int(round(precision_cell_m(bits)))
        if prec > self._max_err_m:
            self._skipped_imprecise += 1
            return None
        if hops == 0:
            snr = p.get('snr')
            try:
                snr = float(snr)
            except (TypeError, ValueError):
                return None
            if not -40 <= snr <= 40:
                return None
            rssi = p.get('rssi')
            try:
                rssi = int(rssi)
                if not -200 < rssi < 0:
                    rssi = None
            except (TypeError, ValueError):
                rssi = None
            return ('direct', lat, lon, snr, rssi, prec)
        return ('relay', lat, lon, None, None, prec)

    def _add(self, node_id, kind, lat, lon, snr, rssi, prec, ts):
        """Fold one sample into its 50 m cell. Caller holds the lock and commits."""
        row, col = cell_of(lat, lon, BASE_M)
        day = int(ts // 86400)
        if kind == 'direct':
            self._db.execute('''INSERT INTO samples (row, col, node_id, day, n_direct, snr_sum, snr_best,
                                                     rssi_sum, n_rssi, n_relay, last_ts, prec)
                                VALUES (?,?,?,?,1,?,?,?,?,0,?,?)
                                ON CONFLICT(row, col, node_id, day) DO UPDATE SET
                                    n_direct = n_direct + 1,
                                    snr_sum = snr_sum + excluded.snr_sum,
                                    snr_best = MAX(COALESCE(snr_best, -999), excluded.snr_best),
                                    rssi_sum = rssi_sum + excluded.rssi_sum,
                                    n_rssi = n_rssi + excluded.n_rssi,
                                    last_ts = MAX(last_ts, excluded.last_ts),
                                    prec = MAX(prec, excluded.prec)''',
                             (row, col, node_id, day, snr, snr,
                              rssi if rssi is not None else 0, 1 if rssi is not None else 0, ts, prec))
        else:
            self._db.execute('''INSERT INTO samples (row, col, node_id, day, n_relay, last_ts, prec)
                                VALUES (?,?,?,?,1,?,?)
                                ON CONFLICT(row, col, node_id, day) DO UPDATE SET
                                    n_relay = n_relay + 1,
                                    last_ts = MAX(last_ts, excluded.last_ts),
                                    prec = MAX(prec, excluded.prec)''',
                             (row, col, node_id, day, ts, prec))

    def record(self, p, now=None):
        """Store one position report. Returns the classification, or None."""
        own_id, _, _ = self._own_node()
        c = self.classify(p, own_id)
        if c is None:
            return None
        ts = int(p.get('timestamp') or now or time.time())
        node_id = p['node_id']
        name = self._name(node_id)
        with self._lock:
            if self._db is None:
                return None
            self._add(node_id, c[0], c[1], c[2], c[3], c[4], c[5], ts)
            if name and name != node_id:
                self._db.execute('INSERT OR REPLACE INTO names (node_id, name) VALUES (?, ?)', (node_id, name))
            self._db.commit()
        self._maybe_prune(ts)
        return c

    def _maybe_prune(self, now):
        if now - self._last_prune < PRUNE_EVERY_S:
            return
        self._last_prune = now
        cutoff = int(now // 86400) - self._retention_days
        with self._lock:
            if self._db is None:
                return
            self._db.execute('DELETE FROM samples WHERE day < ?', (cutoff,))
            self._db.commit()

    async def on_position(self, position):
        try:
            c = self.record(position or {})
        except Exception as e:                  # a bad row must not kill the mapper
            self.log(f"record failed: {e}")
            return
        if c and c[0] == 'direct':
            # Only direct samples go out live: they are the news. The browser
            # flashes the spot and asks for fresh cells a little later.
            await self.broadcast_ws({'type': 'sample', 'id': position.get('node_id'),
                                     'lat': round(c[1], 5), 'lon': round(c[2], 5),
                                     'snr': round(c[3], 1)}, CHANNEL)

    # ── history import ──────────────────────────────────────────────────

    def _start_import(self):
        self._import_state = 'running'
        t = threading.Thread(target=self._run_import, name='footprint-import', daemon=True)
        self._import_thread = t
        t.start()

    def _trails_path(self):
        # Plugins live in plugins/<author>/<name>/: Trails is a sibling of ours.
        return os.path.join(os.path.dirname(self.plugin_dir), 'trails', 'data', 'trails.db')

    def import_history(self, stats_path=None, trails_path=None):
        """Rebuild samples from packets the core logged before this plugin existed.

        stats.db knows each POSITION_APP packet's hops and SNR but not where it
        came from; Trails knows where nodes were. A packet takes the position
        of a Trails fix logged within a few seconds of it (the same packet,
        seen by both), or of the node's last fix when that node was standing
        still at the time. Everything else is skipped rather than guessed.
        """
        stats_path = stats_path or self._stats_path
        trails_path = trails_path or self._trails_path()
        if not os.path.exists(stats_path):
            return {'done': True, 'samples': 0, 'reason': 'no-stats'}
        if not os.path.exists(trails_path):
            return {'done': True, 'samples': 0, 'reason': 'no-trails'}
        own_id, _, _ = self._own_node()
        since = int(time.time()) - self._retention_days * 86400

        t = sqlite3.connect(f'file:{trails_path}?mode=ro', uri=True, timeout=10)
        try:
            fixes = {}
            for nid, ts, lat, lon, bits, moved, name in t.execute(
                    'SELECT node_id, ts, lat, lon, precision_bits, moved, name FROM fixes ORDER BY node_id, ts'):
                fixes.setdefault(nid, []).append((ts, lat, lon, bits, moved, name))
        finally:
            t.close()
        times = {nid: [f[0] for f in fs] for nid, fs in fixes.items()}

        s = sqlite3.connect(f'file:{stats_path}?mode=ro', uri=True, timeout=10)
        try:
            rows = s.execute('''SELECT ts, from_id, hops, snr, rssi FROM packets
                                 WHERE portnum = 'POSITION_APP' AND COALESCE(via_mqtt, 0) = 0
                                   AND hops IS NOT NULL AND ts >= ? ORDER BY ts''', (since,)).fetchall()
        finally:
            s.close()

        added = direct = 0
        names = {}
        batch = []
        for ts, nid, hops, snr, rssi in rows:
            if self._halt.is_set():
                return {'done': False, 'samples': added, 'reason': 'stopped'}
            fs = fixes.get(nid)
            if not fs:
                continue
            tl = times[nid]
            i = bisect.bisect_right(tl, ts + MATCH_EXACT_S) - 1      # last fix at or just after the packet
            if i < 0:
                continue
            f = fs[i]
            if abs(f[0] - ts) > MATCH_EXACT_S:
                # Not the same packet. Fine only if the node was sitting still:
                # its last fix is recent and the next one did not move away.
                nxt = fs[i + 1] if i + 1 < len(fs) else None
                if ts - f[0] > STATIONARY_S or (nxt is not None and nxt[4]):
                    continue
            p = {'node_id': nid, 'lat': f[1], 'lon': f[2], 'hops': hops, 'snr': snr,
                 'rssi': rssi, 'via_mqtt': False, 'precision_bits': f[3]}
            c = self.classify(p, own_id)
            if c is None:
                continue
            batch.append((nid, c, ts))
            if f[5]:
                names[nid] = f[5]
            added += 1
            direct += c[0] == 'direct'
            if len(batch) >= 2000:
                self._flush(batch)
                batch = []
        self._flush(batch)
        with self._lock:
            if self._db is not None:
                self._db.executemany('INSERT OR IGNORE INTO names (node_id, name) VALUES (?, ?)', names.items())
                self._db.commit()
        return {'done': True, 'samples': added, 'direct': direct}

    def _flush(self, batch):
        if not batch:
            return
        with self._lock:
            if self._db is None:
                return
            for nid, c, ts in batch:
                self._add(nid, c[0], c[1], c[2], c[3], c[4], c[5], ts)
            self._db.commit()

    def _run_import(self):
        t0 = time.time()
        try:
            result = self.import_history()
        except Exception as e:
            result = {'done': True, 'samples': 0, 'reason': f'error: {e}'}
        if result.get('done'):
            with self._lock:
                if self._db is not None:
                    self._meta('imported', result.get('samples', 0))
                    self._db.commit()
        self._import_state = result
        why = f" ({result['reason']})" if result.get('reason') else ''
        self.log(f"history import: {result.get('samples', 0)} samples, "
                 f"{result.get('direct', 0)} direct, {time.time() - t0:.1f} s{why}")

    # ── reading ─────────────────────────────────────────────────────────

    def cells(self, size=500, days=30, now=None):
        """Merge the 50 m rows into cells of `size` metres for the last `days` days."""
        size = int(size) if int(size or 0) in SIZES else 500
        now = int(now or time.time())
        days = max(1, min(int(days or 30), self._retention_days))
        first_day = now // 86400 - days + 1
        own_id, own_lat, own_lon = self._own_node()
        with self._lock:
            if self._db is None:
                return {'ok': False, 'error': 'not-ready'}
            rows = self._db.execute('''SELECT row, col, node_id, day, n_direct, snr_sum, snr_best,
                                              rssi_sum, n_rssi, n_relay, last_ts, prec
                                         FROM samples WHERE day >= ?''', (first_day,)).fetchall()

        merged = {}
        coarse_direct = coarse_relay = 0
        fit = size * PREC_FIT
        for r in rows:
            if r[11] > fit:
                # Blurred by its sender more than this grid can show: it
                # would paint a cell the node may never have been in.
                coarse_direct += r[4]
                coarse_relay += r[9]
                continue
            lat, lon = cell_center(r[0], r[1], BASE_M)
            key = cell_of(lat, lon, size)
            m = merged.get(key)
            if m is None:
                m = merged[key] = {'groups': [], 'nd': 0, 'nr': 0, 'best': None,
                                   'rs': 0.0, 'nrs': 0, 'last': 0, 'nodes': set(), 'dnodes': set()}
            if r[4]:
                m['groups'].append(r[5] / r[4])     # one value per node and day
                m['nd'] += r[4]
                m['best'] = r[6] if m['best'] is None else max(m['best'], r[6])
                m['rs'] += r[7]
                m['nrs'] += r[8]
                m['dnodes'].add(r[2])
            m['nr'] += r[9]
            m['last'] = max(m['last'], r[10])
            m['nodes'].add(r[2])

        # How far 'mesh only' is worth drawing: a little past the farthest
        # spot you have heard directly, unless the config says otherwise.
        far = 0.0
        if own_lat is not None and own_lon is not None:
            for (row, col), m in merged.items():
                if m['nd']:
                    clat, clon = cell_center(row, col, size)
                    far = max(far, distance_m(own_lat, own_lon, clat, clon))
        if self._radius_km > 0:
            radius = self._radius_km * 1000
        else:
            radius = max(MIN_RADIUS_M, far * RADIUS_MARGIN)

        out = []
        direct_cells = relay_cells = 0
        for (row, col), m in merged.items():
            b = cell_bounds(row, col, size)
            if m['nd']:
                direct_cells += 1
                out.append({'k': f'{row}:{col}', 'b': [round(x, 6) for x in b],
                            'med': round(median(m['groups']), 1), 'best': round(m['best'], 1),
                            'rssi': round(m['rs'] / m['nrs']) if m['nrs'] else None,
                            'nd': m['nd'], 'nr': m['nr'], 'nodes': len(m['nodes']), 'last': m['last']})
            elif m['nr']:
                if own_lat is None or own_lon is None:
                    continue
                clat, clon = cell_center(row, col, size)
                if distance_m(own_lat, own_lon, clat, clon) > radius:
                    continue
                relay_cells += 1
                out.append({'k': f'{row}:{col}', 'b': [round(x, 6) for x in b], 'med': None,
                            'nd': 0, 'nr': m['nr'], 'nodes': len(m['nodes']), 'last': m['last']})
        return {'ok': True, 'size': size, 'days': days, 'cells': out,
                'direct_cells': direct_cells, 'relay_cells': relay_cells,
                'own': [own_lat, own_lon] if own_lat is not None else None,
                'radius_m': round(radius), 'auto_radius': self._radius_km <= 0,
                'coarse_direct': coarse_direct, 'coarse_relay': coarse_relay,
                'retention_days': self._retention_days}

    def cell(self, key, size=500, days=30, now=None):
        """Who was heard in one cell: per node, how often and how well."""
        try:
            row, col = (int(x) for x in str(key).split(':'))
        except ValueError:
            return {'ok': False, 'error': 'bad-cell'}
        size = int(size) if int(size or 0) in SIZES else 500
        now = int(now or time.time())
        days = max(1, min(int(days or 30), self._retention_days))
        first_day = now // 86400 - days + 1
        s, w, n, e = cell_bounds(row, col, size)
        # The 50 m rows whose centre falls in the cell: a margin of one base
        # cell finds them all, the exact test below keeps the right ones.
        r0 = math.floor(s * M_PER_DEG / BASE_M) - 1
        r1 = math.floor(n * M_PER_DEG / BASE_M) + 1
        with self._lock:
            if self._db is None:
                return {'ok': False, 'error': 'not-ready'}
            rows = self._db.execute('''SELECT row, col, node_id, n_direct, snr_sum, snr_best,
                                              rssi_sum, n_rssi, n_relay, last_ts, prec
                                         FROM samples WHERE row BETWEEN ? AND ? AND day >= ?''',
                                    (r0, r1, first_day)).fetchall()
            names = dict(self._db.execute('SELECT node_id, name FROM names').fetchall())
        per = {}
        for r in rows:
            if r[10] > size * PREC_FIT:
                continue
            lat, lon = cell_center(r[0], r[1], BASE_M)
            if cell_of(lat, lon, size) != (row, col):
                continue
            p = per.setdefault(r[2], {'nd': 0, 'ss': 0.0, 'best': None, 'rs': 0.0, 'nrs': 0, 'nr': 0, 'last': 0})
            p['nd'] += r[3]
            p['ss'] += r[4]
            if r[5] is not None:
                p['best'] = r[5] if p['best'] is None else max(p['best'], r[5])
            p['rs'] += r[6]
            p['nrs'] += r[7]
            p['nr'] += r[8]
            p['last'] = max(p['last'], r[9])
        nodes = []
        for nid, p in per.items():
            nodes.append({'id': nid, 'name': self._name(nid) or names.get(nid) or nid,
                          'nd': p['nd'], 'snr': round(p['ss'] / p['nd'], 1) if p['nd'] else None,
                          'best': p['best'], 'rssi': round(p['rs'] / p['nrs']) if p['nrs'] else None,
                          'nr': p['nr'], 'last': p['last']})
        nodes.sort(key=lambda x: (-x['nd'], -x['nr']))
        return {'ok': True, 'k': key, 'nodes': nodes[:20], 'more': max(0, len(nodes) - 20)}

    def info(self):
        with self._lock:
            if self._db is None:
                return {'ok': False, 'error': 'not-ready'}
            nd, nr, nodes, first = self._db.execute(
                '''SELECT COALESCE(SUM(n_direct), 0), COALESCE(SUM(n_relay), 0),
                          COUNT(DISTINCT CASE WHEN n_direct > 0 THEN node_id END), MIN(day) FROM samples''').fetchone()
        st = self._import_state
        return {'ok': True, 'direct': nd, 'relay': nr, 'direct_nodes': nodes,
                'since': first * 86400 if first is not None else None,
                'import': 'running' if st == 'running' else st,
                'skipped_imprecise': self._skipped_imprecise,
                'retention_days': self._retention_days}

    # ── browser ─────────────────────────────────────────────────────────

    async def on_ws_request(self, data, channel, reply):
        data = data or {}
        action = data.get('action')
        try:
            if action == 'cells':
                result = self.cells(data.get('size'), data.get('days'))
                result['info'] = self.info()
            elif action == 'cell':
                result = self.cell(data.get('k'), data.get('size'), data.get('days'))
            elif action == 'info':
                result = self.info()
            else:
                return
        except Exception as e:
            self.log(f"{action} failed: {e}")
            result = {'ok': False, 'error': str(e)}
        result['req'] = data.get('req')
        result['action'] = action
        await reply(result)
