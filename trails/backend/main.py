# Trails Plugin for MeshPulse — maxg10/trails — GPL-3.0
# Copyright (C) 2026 Mariusz "Max" Gieparda
"""Remembers where moving nodes have been, so the map can show where they go.

The core keeps one position per node: the latest. That is enough to draw a
map, and not enough to see that a tracker drove across town. This plugin
keeps a short history of fixes in its own database and hands the browser
three things: where each mover is heading now, the trail it left, and the
whole history again for a replay.

Two problems decide most of the design:

* Stationary nodes do not stand still on paper. GPS noise moves a fixed
  router by tens of metres, and a node that rounds its position for privacy
  (position precision) jumps a whole grid cell when the noise crosses a cell
  edge. A fix only counts as movement when it lands farther away than that
  noise could explain.
* Most nodes are stationary, and they report every few minutes. Storing
  every fix would fill the Pi's SD card with copies of the same coordinates,
  so a fix is stored only when the node moved, or as a heartbeat every
  30 minutes so a replay still knows the node was there.

Nothing in the core's stats.db is touched. Everything lives in data.db.
"""

import math
import os
import sqlite3
import threading
import time

from mapper.plugin_api import MeshPlugin

CHANNEL = 'trails'
HEARTBEAT_S = 1800          # store an unmoved node at most this often
PRUNE_EVERY_S = 3600
PRUNE_CHUNK = 2000
PRUNE_MAX_CHUNKS = 10       # bounded work per prune, the rest waits an hour
MAX_POINTS = 60000          # per reply, so a week of replay stays a sane payload
SPEED_MIN_DT = 10           # seconds; closer fixes give nonsense speeds
SPEED_MAX_DT = 3600         # older than this, the straight line says nothing
EARTH_M_PER_DEG = 111320.0


def distance_m(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres (haversine)."""
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1, lon1, lat2, lon2):
    """Initial bearing from point 1 to point 2, degrees from true north."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def precision_cell_m(bits):
    """Size of the grid a rounded position snaps to, in metres.

    Meshtastic keeps the top `bits` of the 32-bit latitude/longitude integer
    (units of 1e-7 degrees). 32 is full precision: no grid, return 0.
    """
    try:
        bits = int(bits)
    except (TypeError, ValueError):
        return 0.0
    if bits <= 0 or bits >= 32:
        return 0.0
    return (2 ** (32 - bits)) * 1e-7 * EARTH_M_PER_DEG


class TrailsPlugin(MeshPlugin):

    def __init__(self):
        super().__init__()
        self._db = None
        self._lock = threading.Lock()
        self._anchor = {}          # node_id -> [lat, lon, n]: where a still node really is
        self._prev = {}            # node_id -> (ts, lat, lon) of the last fix seen, stored or not
        self._stored_ts = {}       # node_id -> ts of the last stored fix
        self._last_prune = 0
        self._retention_days = 7
        self._min_move_m = 100.0
        self._include_mqtt = True

    # ── lifecycle ───────────────────────────────────────────────────────

    def on_enable(self):
        self._apply_config(self.get_config() or {})
        self._open()
        self.register_ws_channel(CHANNEL)
        with self._lock:
            n = self._db.execute('SELECT COUNT(*) FROM fixes').fetchone()[0]
        self.log(f"remembering {n} fixes, {self._retention_days} days kept")

    def on_config_update(self, new_config):
        self._apply_config(new_config or {})

    def on_disable(self):
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None
        self._anchor, self._prev, self._stored_ts = {}, {}, {}

    def _apply_config(self, cfg):
        def num(key, default, lo, hi):
            try:
                v = float(cfg.get(key, default))
            except (TypeError, ValueError):
                v = default
            return min(hi, max(lo, v))
        self._retention_days = int(num('retention_days', 7, 1, 30))
        self._min_move_m = num('min_move_m', 100, 10, 1000)
        self._include_mqtt = cfg.get('include_mqtt', True) is not False

    # ── db ──────────────────────────────────────────────────────────────

    def _open(self):
        path = os.path.join(self.plugin_dir, 'data.db')
        # Hooks and browser requests can arrive on different threads; one
        # connection guarded by a lock is simpler than one per thread.
        db = sqlite3.connect(path, timeout=5, check_same_thread=False)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=NORMAL')
        db.execute('''CREATE TABLE IF NOT EXISTS fixes (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        node_id TEXT NOT NULL,
                        name TEXT,
                        ts INTEGER NOT NULL,
                        lat REAL NOT NULL,
                        lon REAL NOT NULL,
                        alt INTEGER,
                        speed REAL,            -- m/s
                        speed_src TEXT,        -- 'gps' (sender) or 'calc' (from the last fix)
                        heading REAL,          -- degrees from true north
                        precision_bits INTEGER,
                        via_mqtt INTEGER,
                        hops INTEGER,
                        moved INTEGER NOT NULL -- 1 = real movement, 0 = heartbeat or first fix
                     )''')
        db.execute('CREATE INDEX IF NOT EXISTS idx_fixes_ts ON fixes(ts)')
        db.execute('CREATE INDEX IF NOT EXISTS idx_fixes_node_ts ON fixes(node_id, ts)')
        db.commit()
        self._db = db
        # Where everyone was last time, so a restart does not count the first
        # fix after it as a journey.
        rows = db.execute('''SELECT node_id, ts, lat, lon FROM fixes f
                              WHERE ts = (SELECT MAX(ts) FROM fixes g WHERE g.node_id = f.node_id)''').fetchall()
        self._anchor = {r[0]: [r[2], r[3], 1] for r in rows}
        self._prev = {r[0]: (r[1], r[2], r[3]) for r in rows}
        self._stored_ts = {r[0]: r[1] for r in rows}

    def _jitter_m(self, precision_bits):
        """How far a node that did not move can still appear to move."""
        cell = precision_cell_m(precision_bits)
        # A rounded position flips between neighbouring cells when GPS noise
        # crosses a cell edge, so one cell of jump is still standing still.
        return max(self._min_move_m, cell * 1.5)

    def _name(self, node_id):
        try:
            n = self.get_node(node_id) or {}
            return n.get('name') or n.get('long_name') or None
        except Exception:
            return None

    # ── recording ───────────────────────────────────────────────────────

    def record(self, p, now=None):
        """Store a fix if it says something new. Returns the stored row as a
        compact list, or None when it was a repeat."""
        node_id = p.get('node_id')
        try:
            lat = float(p.get('lat'))
            lon = float(p.get('lon'))
        except (TypeError, ValueError):
            return None
        if not node_id or not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
            return None
        via_mqtt = p.get('via_mqtt')
        if via_mqtt and not self._include_mqtt:
            return None

        ts = int(p.get('timestamp') or now or time.time())
        bits = p.get('precision_bits')
        anchor = self._anchor.get(node_id)
        prev = self._prev.get(node_id)
        if prev is not None and ts <= prev[0]:
            return None              # out of order, or a duplicate of the same second
        moved = False
        if anchor is not None:
            # Compared with the average of where the node has been sitting,
            # not with one noisy fix: two noisy points are twice as far apart.
            moved = distance_m(anchor[0], anchor[1], lat, lon) > self._jitter_m(bits)
        self._prev[node_id] = (ts, lat, lon)
        if moved or anchor is None:
            self._anchor[node_id] = [lat, lon, 1]
        else:
            n = min(anchor[2], 19)   # a running mean that still follows a slow drift
            anchor[0] = (anchor[0] * n + lat) / (n + 1)
            anchor[1] = (anchor[1] * n + lon) / (n + 1)
            anchor[2] = n + 1
            if ts - self._stored_ts.get(node_id, 0) < HEARTBEAT_S:
                return None

        speed, src, heading = p.get('speed'), None, p.get('heading')
        if speed is not None:
            src = 'gps'
            try:
                speed = float(speed)
            except (TypeError, ValueError):
                speed, src = None, None
        if moved and prev is not None:
            dt = ts - prev[0]
            if speed is None and SPEED_MIN_DT <= dt <= SPEED_MAX_DT:
                speed, src = distance_m(prev[1], prev[2], lat, lon) / dt, 'calc'
            if heading is None and distance_m(prev[1], prev[2], lat, lon) > 1:
                heading = bearing_deg(prev[1], prev[2], lat, lon)
        if not moved:
            # A heartbeat is not a journey: no direction, and only a speed the sender measured.
            heading = None
            if src != 'gps':
                speed, src = None, None

        name = self._name(node_id)
        row = (node_id, name, ts, round(lat, 6), round(lon, 6), p.get('alt'),
               None if speed is None else round(speed, 2), src,
               None if heading is None else round(float(heading), 1),
               bits, None if via_mqtt is None else int(bool(via_mqtt)), p.get('hops'), int(moved))
        with self._lock:
            if self._db is None:
                return None
            self._db.execute('''INSERT INTO fixes (node_id, name, ts, lat, lon, alt, speed, speed_src,
                                                   heading, precision_bits, via_mqtt, hops, moved)
                                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''', row)
            self._db.commit()
        self._stored_ts[node_id] = ts
        self._maybe_prune(ts)
        return {'id': node_id, 'name': name or node_id, 'moved': moved,
                'p': [ts, row[3], row[4], row[6], row[8], 1 if src == 'calc' else 0], 'src': src}

    def _maybe_prune(self, now):
        if now - self._last_prune < PRUNE_EVERY_S:
            return
        self._last_prune = now
        cutoff = now - self._retention_days * 86400
        with self._lock:
            for _ in range(PRUNE_MAX_CHUNKS):
                cur = self._db.execute('''DELETE FROM fixes WHERE id IN
                                          (SELECT id FROM fixes WHERE ts < ? LIMIT ?)''', (cutoff, PRUNE_CHUNK))
                self._db.commit()
                if cur.rowcount < PRUNE_CHUNK:
                    break

    async def on_position(self, position):
        try:
            fix = self.record(position or {})
        except Exception as e:                      # a bad row must not kill the mapper
            self.log(f"record failed: {e}")
            return
        if fix and fix['moved']:
            # Only real movement goes out live; heartbeats would just be noise.
            await self.broadcast_ws({'type': 'fix', 'id': fix['id'], 'name': fix['name'],
                                     'p': fix['p'], 'src': fix['src']}, CHANNEL)

    # ── reading ─────────────────────────────────────────────────────────

    def tracks(self, since=None, until=None, now=None):
        """Every node that moved in [since, until], with its fixes in order.

        Nodes that only sat still are left out: they are already on the map,
        and drawing them would bury the few that move.
        """
        now = int(now or time.time())
        until = int(until or now)
        since = int(since if since is not None else until - 86400)
        oldest = now - self._retention_days * 86400
        since = max(since, oldest)
        with self._lock:
            if self._db is None:
                return {'ok': False, 'error': 'not-ready'}
            # One fix from before the window too, so a replay knows where a
            # mover started from instead of having it appear out of nowhere.
            rows = self._db.execute(
                '''SELECT node_id, name, ts, lat, lon, speed, heading, speed_src, precision_bits, moved
                     FROM fixes WHERE ts BETWEEN ? AND ? ORDER BY node_id, ts''', (since, until)).fetchall()
            movers_rows = {}
            for r in rows:
                movers_rows.setdefault(r[0], []).append(r)
            movers = {nid for nid, rs in movers_rows.items() if any(x[9] for x in rs)}
            before = {}
            for nid in movers:
                b = self._db.execute(
                    '''SELECT node_id, name, ts, lat, lon, speed, heading, speed_src, precision_bits, moved
                         FROM fixes WHERE node_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1''', (nid, since)).fetchone()
                if b:
                    before[nid] = b

        out = []
        total = 0
        for nid in sorted(movers):
            rs = ([before[nid]] if nid in before else []) + movers_rows[nid]
            name = next((x[1] for x in reversed(rs) if x[1]), None) or nid
            # [ts, lat, lon, speed m/s, heading deg, 1 = speed estimated from fixes]
            pts = [[x[2], x[3], x[4], x[5], x[6], 1 if x[7] == 'calc' else 0] for x in rs]
            total += len(pts)
            out.append({'id': nid, 'name': name, 'pts': pts,
                        'calc': any(x[7] == 'calc' for x in rs)})

        truncated = False
        if total > MAX_POINTS:
            # Thin every track by the same factor; the first and last fix of
            # each always survive so trails keep their ends.
            step = math.ceil(total / MAX_POINTS)
            for t in out:
                p = t['pts']
                if len(p) > 2:
                    t['pts'] = [p[0]] + p[1:-1:step] + [p[-1]]
            truncated = True
        return {'ok': True, 'from': since, 'to': until, 'oldest': oldest,
                'retention_days': self._retention_days, 'tracks': out, 'truncated': truncated}

    def info(self):
        with self._lock:
            if self._db is None:
                return {'ok': False, 'error': 'not-ready'}
            n, oldest, movers = self._db.execute(
                'SELECT COUNT(*), MIN(ts), COUNT(DISTINCT CASE WHEN moved = 1 THEN node_id END) FROM fixes').fetchone()
        return {'ok': True, 'fixes': n, 'oldest': oldest, 'movers': movers,
                'retention_days': self._retention_days}

    # ── browser ─────────────────────────────────────────────────────────

    async def on_ws_request(self, data, channel, reply):
        data = data or {}
        action = data.get('action')
        try:
            if action == 'tracks':
                result = self.tracks(data.get('since'), data.get('until'))
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
