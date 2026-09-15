# Ground Truth Plugin for MeshPulse — maxg10/ground-truth — GPL-3.0
# Copyright (C) 2025-2026 Mariusz "Max" Gieparda
"""Finds links and nodes whose signal has quietly degraded over weeks.

An antenna does not fail; it fades. Water gets into a connector, a mast
shifts, a tree grows. Nobody notices, because every individual packet still
arrives — until the day the link stops working entirely. The mapper has been
recording SNR for months in stats.db, so the evidence is already on disk. This
plugin only asks the right question of it: compared with its own past, is this
link worse than it used to be?

Nothing is written to stats.db. It is opened read-only.
"""

import os
import sqlite3
import statistics
import time

from mapper.plugin_api import MeshPlugin

DEFAULT_DB = '/var/www/html/meshpulse/stats.db'
CHANNEL = 'groundtruth'


class GroundTruthPlugin(MeshPlugin):

    def __init__(self):
        super().__init__()
        self._db_path = DEFAULT_DB

    # ── lifecycle ───────────────────────────────────────────────────────

    def on_enable(self):
        cfg = self.get_config() or {}
        self._db_path = (cfg.get('stats_db_path') or DEFAULT_DB).strip() or DEFAULT_DB
        self.register_ws_channel(CHANNEL)
        if os.path.exists(self._db_path):
            self.log(f"reading history from {self._db_path}")
        else:
            self.log(f"stats.db not found at {self._db_path} — set stats_db_path in the plugin config")

    def on_config_update(self, new_config):
        self._db_path = (new_config.get('stats_db_path') or DEFAULT_DB).strip() or DEFAULT_DB

    def on_disable(self):
        pass

    # ── db ──────────────────────────────────────────────────────────────

    def _connect(self):
        """Read-only, and never anything else. This database belongs to the core."""
        if not os.path.exists(self._db_path):
            return None
        conn = sqlite3.connect(f'file:{self._db_path}?mode=ro', uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    # ── analysis ────────────────────────────────────────────────────────

    def _params(self):
        c = self.get_config() or {}
        return {
            'baseline_days': max(7, int(c.get('baseline_days') or 30)),
            'recent_days': max(1, int(c.get('recent_days') or 3)),
            'min_samples': max(5, int(c.get('min_samples') or 20)),
            'drop_db': float(c.get('drop_db') or 4.0),
            'include_nodes': c.get('include_nodes') is not False,
        }

    @staticmethod
    def _spread(values):
        """Median absolute deviation — how noisy this link is, in dB.

        A link that swings 10 dB on a normal day cannot report a 5 dB drop as
        news, so the spread is what separates a finding from weather.
        """
        if len(values) < 3:
            return None
        med = statistics.median(values)
        return statistics.median([abs(v - med) for v in values])

    def _compare(self, rows_recent, rows_base, p):
        """Two samples of the same thing, taken weeks apart. Is the new one worse?"""
        if len(rows_recent) < p['min_samples'] or len(rows_base) < p['min_samples']:
            return None
        med_recent = statistics.median(rows_recent)
        med_base = statistics.median(rows_base)
        drop = med_base - med_recent
        if drop < p['drop_db']:
            return None
        spread = self._spread(rows_base)
        # A drop the link's own day-to-day noise could have produced is not a finding.
        if spread is not None and drop < 2 * spread:
            return None
        return {
            'baseline_snr': round(med_base, 1),
            'recent_snr': round(med_recent, 1),
            'drop_db': round(drop, 1),
            'spread_db': None if spread is None else round(spread, 1),
            'samples_baseline': len(rows_base),
            'samples_recent': len(rows_recent),
        }

    def analyse(self):
        p = self._params()
        now = int(time.time())
        recent_from = now - p['recent_days'] * 86400
        base_from = now - p['baseline_days'] * 86400
        conn = self._connect()
        if conn is None:
            return {'ok': False, 'error': 'no-db', 'db_path': self._db_path}

        findings = []
        try:
            cur = conn.cursor()

            # ── links, from NEIGHBORINFO reports ────────────────────────
            # Pass one is cheap and stays in SQLite: counts and averages per pair.
            # Only the pairs that look suspicious have their raw values pulled.
            cur.execute(
                """SELECT from_id, neighbor_id,
                          SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS n_recent,
                          SUM(CASE WHEN ts <  ? AND ts >= ? THEN 1 ELSE 0 END) AS n_base,
                          AVG(CASE WHEN ts >= ? THEN snr END) AS avg_recent,
                          AVG(CASE WHEN ts <  ? AND ts >= ? THEN snr END) AS avg_base
                     FROM neighbors
                    WHERE ts >= ? AND snr IS NOT NULL
                 GROUP BY from_id, neighbor_id""",
                (recent_from, recent_from, base_from, recent_from, recent_from, base_from, base_from))
            candidates = []
            for r in cur.fetchall():
                if (r['n_recent'] or 0) < p['min_samples'] or (r['n_base'] or 0) < p['min_samples']:
                    continue
                if r['avg_recent'] is None or r['avg_base'] is None:
                    continue
                if (r['avg_base'] - r['avg_recent']) >= p['drop_db'] * 0.6:
                    candidates.append((r['from_id'], r['neighbor_id']))

            names = {}
            for from_id, nb_id in candidates[:200]:
                cur.execute(
                    """SELECT ts, snr, from_name, neighbor_name FROM neighbors
                        WHERE from_id = ? AND neighbor_id = ? AND ts >= ? AND snr IS NOT NULL""",
                    (from_id, nb_id, base_from))
                rows = cur.fetchall()
                recent = [r['snr'] for r in rows if r['ts'] >= recent_from]
                base = [r['snr'] for r in rows if r['ts'] < recent_from]
                verdict = self._compare(recent, base, p)
                if not verdict:
                    continue
                for r in rows:
                    if r['from_name']:
                        names[from_id] = r['from_name']
                    if r['neighbor_name']:
                        names[nb_id] = r['neighbor_name']
                verdict.update({
                    'kind': 'link', 'from': from_id, 'to': nb_id,
                    'from_name': names.get(from_id, from_id),
                    'to_name': names.get(nb_id, nb_id),
                })
                findings.append(verdict)

            # ── nodes we hear ourselves, direct only ────────────────────
            # hops = 0 keeps the path fixed: one transmitter, one receiver, no
            # repeater in between to explain a change away.
            if p['include_nodes']:
                cur.execute(
                    """SELECT from_id, from_name, ts, snr FROM packets
                        WHERE ts >= ? AND snr IS NOT NULL AND hops = 0 AND via_mqtt = 0""",
                    (base_from,))
                by_node = {}
                node_names = {}
                for r in cur.fetchall():
                    by_node.setdefault(r['from_id'], []).append((r['ts'], r['snr']))
                    if r['from_name']:
                        node_names[r['from_id']] = r['from_name']
                for node_id, pairs in by_node.items():
                    recent = [s for ts, s in pairs if ts >= recent_from]
                    base = [s for ts, s in pairs if ts < recent_from]
                    verdict = self._compare(recent, base, p)
                    if not verdict:
                        continue
                    verdict.update({
                        'kind': 'node', 'from': node_id, 'to': None,
                        'from_name': node_names.get(node_id, node_id), 'to_name': None,
                    })
                    findings.append(verdict)
        finally:
            conn.close()

        findings.sort(key=lambda f: f['drop_db'], reverse=True)
        return {
            'ok': True,
            'generated_at': now,
            'window': {'baseline_days': p['baseline_days'], 'recent_days': p['recent_days'],
                       'drop_db': p['drop_db'], 'min_samples': p['min_samples']},
            'findings': findings[:50],
        }

    # ── browser ─────────────────────────────────────────────────────────

    async def on_ws_request(self, data, channel, reply):
        if (data or {}).get('action') != 'analyse':
            return
        try:
            result = self.analyse()
        except Exception as e:                      # a broken query must not kill the mapper
            self.log(f"analysis failed: {e}")
            result = {'ok': False, 'error': str(e)}
        result['req'] = (data or {}).get('req')
        await reply(result)
