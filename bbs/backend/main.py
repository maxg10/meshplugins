# Meshtastic BBS Plugin — maxg10/bbs — GPL-3.0
"""FidoNet-inspired BBS plugin: bulletin areas, netmail, node directory, store & forward."""

import asyncio
import json
import os
import re
import sqlite3
import time
from datetime import datetime

from mapper.plugin_api import MeshPlugin


_HERE = os.path.dirname(os.path.abspath(__file__))
_DATA = os.path.join(os.path.dirname(_HERE), 'data')
_DB   = os.path.join(_DATA, 'bbs.sqlite3')

AREAS     = ('GENERAL', 'TECH', 'LOCAL', 'MESH')
MAX_CHUNK = 200


class BbsPlugin(MeshPlugin):

    def __init__(self):
        super().__init__()
        self._db = None

    # ── lifecycle ────────────────────────────────────────────────────────────

    def on_enable(self):
        os.makedirs(_DATA, exist_ok=True)
        self._db = sqlite3.connect(_DB, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._init_schema()
        print(f'[BBS] Enabled — db: {_DB}')

    def on_disable(self):
        if self._db:
            self._db.close()
            self._db = None
        print('[BBS] Disabled')

    def _init_schema(self):
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS messages (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                area      TEXT    NOT NULL,
                from_node TEXT    NOT NULL,
                body      TEXT    NOT NULL,
                ts        INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mail (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                from_node TEXT    NOT NULL,
                to_node   TEXT    NOT NULL,
                body      TEXT    NOT NULL,
                ts        INTEGER NOT NULL,
                read      INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS node_directory (
                node_id    TEXT    PRIMARY KEY,
                short_name TEXT,
                long_name  TEXT,
                first_seen INTEGER NOT NULL,
                last_seen  INTEGER NOT NULL,
                msg_count  INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS sf_queue (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                mail_id      INTEGER NOT NULL,
                to_node      TEXT    NOT NULL,
                from_node    TEXT    NOT NULL,
                ts           INTEGER NOT NULL,
                delivered    INTEGER NOT NULL DEFAULT 0,
                delivered_ts INTEGER
            );
        """)
        self._db.commit()

    # ── node tracking ────────────────────────────────────────────────────────

    def _is_new_node(self, node_id):
        return self._db.execute(
            'SELECT 1 FROM node_directory WHERE node_id=?', (node_id,)
        ).fetchone() is None

    def _upsert_node(self, node_id, short_name=None, long_name=None):
        now = int(time.time())
        self._db.execute(
            'INSERT INTO node_directory (node_id, short_name, long_name, first_seen, last_seen) '
            'VALUES (?,?,?,?,?) '
            'ON CONFLICT(node_id) DO UPDATE SET '
            '  last_seen  = excluded.last_seen, '
            '  short_name = COALESCE(excluded.short_name, short_name), '
            '  long_name  = COALESCE(excluded.long_name,  long_name)',
            (node_id, short_name, long_name, now, now)
        )
        self._db.commit()

    # ── store & forward delivery ─────────────────────────────────────────────

    async def _deliver_sf_queue(self, node_id: str):
        rows = self._db.execute(
            'SELECT id FROM sf_queue WHERE to_node=? AND delivered=0 ORDER BY id',
            (node_id,)
        ).fetchall()
        if not rows:
            return
        count  = len(rows)
        notice = (f'[BBS] {count} new mail item{"s" if count > 1 else ""}.'
                  ' Send BBS INBOX to read.')
        for chunk in self._chunks(notice):
            await self.send_mesh_message(chunk, to_id=node_id, channel=0)
        now = int(time.time())
        ids = [r['id'] for r in rows]
        self._db.execute(
            f'UPDATE sf_queue SET delivered=1, delivered_ts=?'
            f' WHERE id IN ({",".join("?" * len(ids))})',
            [now] + ids
        )
        self._db.commit()

    # ── incoming mesh hooks ──────────────────────────────────────────────────

    async def on_message(self, message: dict):
        from_node = message.get('from_id', '')
        text = (message.get('text') or '').strip()
        to_id = message.get('to_id', '^all')
        is_dm = message.get('is_dm', False)

        if not from_node or not text:
            return

        is_new = self._is_new_node(from_node)
        from_name = message.get('from_name', from_node)
        self._upsert_node(from_node, from_name, from_name)

        if is_new and self.config.get('auto_welcome', True):
            bbs_name = self.config.get('bbs_name', 'MeshBBS')
            welcome = self.config.get('welcome_message',
                        f'Welcome to {bbs_name}! Type !bbs help for commands.')
            await asyncio.sleep(3)
            for chunk in self._chunks(welcome):
                await self.send_mesh_message(chunk, to_id=from_node, channel=0)
                await asyncio.sleep(0.5)
        await self._deliver_sf_queue(from_node)

        # must start with !bbs or bbs
        if not re.match(r'(?i)^!?bbs\b', text):
            return

        self.log(f"Command from {from_name}: {text}")
        cmd = re.sub(r'(?i)^!?bbs\s*', '', text).strip()
        await self._handle(from_node, cmd)

    async def on_node_update(self, node):
        try:
            if node is None:
                return
            node_id = node.get('id') or node.get('node_id')
            name = node.get('name') or node.get('long_name') or node_id
            if not node_id:
                return
            now = int(time.time())
            self._db.execute(
                'INSERT INTO node_directory (node_id, short_name, long_name, first_seen, last_seen) '
                'VALUES (?,?,?,?,?) '
                'ON CONFLICT(node_id) DO UPDATE SET '
                '  last_seen  = excluded.last_seen, '
                '  short_name = COALESCE(excluded.short_name, short_name), '
                '  long_name  = COALESCE(excluded.long_name,  long_name)',
                (node_id, name, name, now, now)
            )
            self._db.commit()
            await self._deliver_sf_queue(node_id)
        except Exception as e:
            self.log(f"on_node_update error: {e}")

    # ── command dispatch ─────────────────────────────────────────────────────

    async def _handle(self, from_node: str, cmd_str: str):
        parts = cmd_str.split(None, 2)
        cmd   = parts[0].upper() if parts else 'HELP'
        args  = parts[1:]

        if cmd in ('HELP', 'H', '?', ''):
            reply = self._c_help()
        elif cmd in ('LIST', 'L', 'AREAS'):
            reply = self._c_list()
        elif cmd in ('READ', 'R'):
            if args and args[0].upper() == 'MAIL':
                mail_id = int(args[1]) if len(args) > 1 and args[1].isdigit() else None
                reply   = self._c_read_mail(from_node, mail_id)
            else:
                area   = args[0].upper() if args else 'GENERAL'
                offset = int(args[1]) if len(args) > 1 and args[1].isdigit() else 0
                reply  = self._c_read(area, offset)
        elif cmd in ('POST', 'P'):
            reply = (self._c_post(from_node, args[0].upper(), args[1])
                     if len(args) >= 2 else 'Usage: BBS POST <AREA> <message>')
        elif cmd in ('MAIL', 'SEND', 'M'):
            reply = (self._c_mail(from_node, args[0], args[1])
                     if len(args) >= 2 else 'Usage: BBS SEND <to_node> <message>')
        elif cmd in ('INBOX', 'I'):
            reply = self._c_inbox(from_node)
        elif cmd in ('DELETE', 'DEL', 'D'):
            if args and args[0].upper() == 'MAIL':
                mail_id = int(args[1]) if len(args) > 1 and args[1].isdigit() else None
                reply   = self._c_delete_mail(from_node, mail_id)
            else:
                reply = 'Usage: BBS DEL MAIL <id>'
        elif cmd in ('WHOIS', 'W'):
            reply = self._c_whois(args[0] if args else '')
        elif cmd in ('NODES', 'N'):
            reply = self._c_nodes()
        elif cmd in ('INFO', 'STATUS', 'S'):
            reply = self._c_info()
        elif cmd in ('ABOUT', 'AB'):
            reply = self._c_about()
        else:
            reply = f'Unknown: {cmd}. Type BBS HELP.'

        await asyncio.sleep(2)
        for chunk in self._chunks(reply):
            await self.send_mesh_message(chunk, to_id=from_node, channel=0)
            await asyncio.sleep(0.5)

        await self.broadcast_ws('bbs_updates', json.dumps(
            {'event': 'command', 'from': from_node, 'cmd': cmd}
        ))

    # ── command implementations ──────────────────────────────────────────────

    def _c_help(self):
        name = self.config.get('bbs_name', 'MeshBBS')
        return (f'{name}: LIST | READ <area> [#] | READ MAIL <id> | POST <area> <msg>'
                ' | SEND <node> <msg> | INBOX | DEL MAIL <id> | WHOIS <node> | NODES | INFO | ABOUT')

    def _c_list(self):
        parts = [
            f'{a}:{self._db.execute("SELECT COUNT(*) FROM messages WHERE area=?", (a,)).fetchone()[0]}'
            for a in AREAS
        ]
        return 'Areas: ' + '  '.join(parts)

    def _c_read(self, area: str, offset: int = 0):
        if area not in AREAS:
            return f'No such area. Try: {", ".join(AREAS)}'
        limit = self.config.get('max_messages_per_read', 3)
        rows  = self._db.execute(
            'SELECT id, from_node, body, ts FROM messages '
            'WHERE area=? ORDER BY id DESC LIMIT ? OFFSET ?',
            (area, limit, offset)
        ).fetchall()
        if not rows:
            return f'{area}: No messages.'
        lines = []
        for r in rows:
            dt  = datetime.fromtimestamp(r['ts']).strftime('%m/%d %H:%M')
            tag = r['from_node'][-4:]
            lines.append(f'#{r["id"]}[{tag} {dt}]: {r["body"][:80]}')
        return ' | '.join(lines)

    def _c_read_mail(self, from_node: str, mail_id):
        if mail_id is None:
            return 'Usage: BBS READ MAIL <id>'
        row = self._db.execute(
            'SELECT id, from_node, body, ts FROM mail WHERE id=? AND to_node=?',
            (mail_id, from_node)
        ).fetchone()
        if not row:
            return f'Mail #{mail_id} not found.'
        self._db.execute('UPDATE mail SET read=1 WHERE id=?', (mail_id,))
        self._db.execute(
            'UPDATE sf_queue SET delivered=1, delivered_ts=? WHERE mail_id=? AND delivered=0',
            (int(time.time()), mail_id)
        )
        self._db.commit()
        dt = datetime.fromtimestamp(row['ts']).strftime('%m/%d %H:%M')
        return f'#{row["id"]} From:{row["from_node"][-8:]} {dt}: {row["body"]}'

    def _c_post(self, from_node: str, area: str, body: str):
        if area not in AREAS:
            return f'No such area. Try: {", ".join(AREAS)}'
        body = body[:200]
        self._db.execute(
            'INSERT INTO messages (area, from_node, body, ts) VALUES (?,?,?,?)',
            (area, from_node, body, int(time.time()))
        )
        self._db.execute(
            'UPDATE node_directory SET msg_count = msg_count + 1 WHERE node_id=?', (from_node,)
        )
        self._db.commit()
        return f'Posted to {area}.'

    def _c_mail(self, from_node: str, to_node: str, body: str):
        body = body[:200]
        now  = int(time.time())
        self._db.execute(
            'INSERT INTO mail (from_node, to_node, body, ts) VALUES (?,?,?,?)',
            (from_node, to_node, body, now)
        )
        self._db.commit()
        mail_id = self._db.execute('SELECT last_insert_rowid()').fetchone()[0]
        self._db.execute(
            'INSERT INTO sf_queue (mail_id, to_node, from_node, ts) VALUES (?,?,?,?)',
            (mail_id, to_node, from_node, now)
        )
        self._db.commit()
        return f'Mail queued for {to_node}.'

    def _c_inbox(self, from_node: str):
        rows = self._db.execute(
            'SELECT id, from_node, body, ts, read FROM mail '
            'WHERE to_node=? ORDER BY id DESC LIMIT 5',
            (from_node,)
        ).fetchall()
        if not rows:
            return 'INBOX: Empty.'
        self._db.execute('UPDATE mail SET read=1 WHERE to_node=?', (from_node,))
        self._db.execute(
            'UPDATE sf_queue SET delivered=1, delivered_ts=? WHERE to_node=? AND delivered=0',
            (int(time.time()), from_node)
        )
        self._db.commit()
        lines = []
        for r in rows:
            dt  = datetime.fromtimestamp(r['ts']).strftime('%m/%d %H:%M')
            tag = r['from_node'][-4:]
            new = '' if r['read'] else '[NEW] '
            lines.append(f'{new}#{r["id"]}[{tag} {dt}]: {r["body"][:60]}')
        return ' | '.join(lines)

    def _c_delete_mail(self, from_node: str, mail_id):
        if mail_id is None:
            return 'Usage: BBS DEL MAIL <id>'
        row = self._db.execute(
            'SELECT id FROM mail WHERE id=? AND to_node=?', (mail_id, from_node)
        ).fetchone()
        if not row:
            return f'Mail #{mail_id} not found.'
        self._db.execute('DELETE FROM mail WHERE id=?', (mail_id,))
        self._db.execute('DELETE FROM sf_queue WHERE mail_id=?', (mail_id,))
        self._db.commit()
        return f'Mail #{mail_id} deleted.'

    def _c_whois(self, node_ref: str):
        if not node_ref:
            return 'Usage: BBS WHOIS <node_id or short_name>'
        ref = node_ref.strip()
        row = self._db.execute(
            'SELECT node_id, short_name, long_name, first_seen, last_seen, msg_count '
            'FROM node_directory '
            'WHERE node_id=? OR short_name=? OR node_id LIKE ? '
            'ORDER BY last_seen DESC LIMIT 1',
            (ref, ref, '%' + ref[-4:])
        ).fetchone()
        if not row:
            return f'WHOIS: {node_ref} not found.'
        first = datetime.fromtimestamp(row['first_seen']).strftime('%m/%d/%y')
        last  = datetime.fromtimestamp(row['last_seen']).strftime('%m/%d %H:%M')
        return (f'{row["short_name"] or "?"} ({row["long_name"] or "?"}) '
                f'ID:{row["node_id"]} First:{first} Last:{last} Msgs:{row["msg_count"]}')

    def _c_nodes(self):
        rows = self._db.execute(
            'SELECT node_id, short_name, last_seen FROM node_directory '
            'ORDER BY last_seen DESC LIMIT 5'
        ).fetchall()
        if not rows:
            return 'NODES: None seen yet.'
        parts = []
        for r in rows:
            dt    = datetime.fromtimestamp(r['last_seen']).strftime('%m/%d %H:%M')
            label = r['short_name'] or r['node_id'][-4:]
            parts.append(f'{label}@{dt}')
        return 'Nodes: ' + ' '.join(parts)

    def _c_info(self):
        name  = self.config.get('bbs_name', 'MeshBBS')
        msgs  = self._db.execute('SELECT COUNT(*) FROM messages').fetchone()[0]
        mail  = self._db.execute('SELECT COUNT(*) FROM mail').fetchone()[0]
        nodes = self._db.execute('SELECT COUNT(*) FROM node_directory').fetchone()[0]
        return f'{name} v1.0 | Msgs:{msgs} Mail:{mail} Nodes:{nodes}'

    def _c_about(self):
        bbs_name = self.config.get('bbs_name', 'MeshBBS')
        default = f'{bbs_name}\n📡 Meshtastic Network Mapper\n🌍 meshtastic.world\nTry it: !bbs help'
        msg = self.config.get('about_message', '') or default
        return msg.replace('\\n', '\n')

    # ── API route handlers ───────────────────────────────────────────────────

    def get_boards(self, request):
        boards = [
            {'name': a, 'message_count': self._db.execute(
                'SELECT COUNT(*) FROM messages WHERE area=?', (a,)).fetchone()[0]}
            for a in AREAS
        ]
        return {'boards': boards}

    def get_messages(self, request):
        area = ((request.get('path_params') or {}).get('area') or '').upper()
        if area not in AREAS:
            return ({'error': f'Unknown area: {area}'}, 404)
        q     = request.get('query') or {}
        page  = int(q.get('page',  0))
        limit = int(q.get('limit', 20))
        rows  = self._db.execute(
            'SELECT id, from_node, body, ts FROM messages '
            'WHERE area=? ORDER BY id DESC LIMIT ? OFFSET ?',
            (area, limit, page * limit)
        ).fetchall()
        total = self._db.execute(
            'SELECT COUNT(*) FROM messages WHERE area=?', (area,)
        ).fetchone()[0]
        return {
            'area': area,
            'messages': [dict(r) for r in rows],
            'total': total, 'page': page, 'limit': limit,
        }

    def post_message(self, request):
        area = ((request.get('path_params') or {}).get('area') or '').upper()
        if area not in AREAS:
            return ({'error': f'Unknown area: {area}'}, 404)
        data      = request.get('body') or {}
        from_node = data.get('from', 'WEB')
        body      = (data.get('body') or '').strip()[:200]
        if not body:
            return ({'error': 'body required'}, 400)
        self._db.execute(
            'INSERT INTO messages (area, from_node, body, ts) VALUES (?,?,?,?)',
            (area, from_node, body, int(time.time()))
        )
        self._db.commit()
        row_id = self._db.execute('SELECT last_insert_rowid()').fetchone()[0]
        return {'status': 'ok', 'id': row_id}

    def get_mail(self, request):
        to_node = (request.get('query') or {}).get('to')
        if to_node:
            rows = self._db.execute(
                'SELECT id, from_node, to_node, body, ts, read FROM mail '
                'WHERE to_node=? ORDER BY id DESC LIMIT 50', (to_node,)
            ).fetchall()
        else:
            rows = self._db.execute(
                'SELECT id, from_node, to_node, body, ts, read FROM mail '
                'ORDER BY id DESC LIMIT 50'
            ).fetchall()
        return {'mail': [dict(r) for r in rows]}

    def send_mail(self, request):
        data      = request.get('body') or {}
        from_node = data.get('from', 'WEB')
        to_node   = (data.get('to')   or '').strip()
        body      = (data.get('body') or '').strip()[:200]
        if not to_node or not body:
            return ({'error': 'to and body are required'}, 400)
        now = int(time.time())
        self._db.execute(
            'INSERT INTO mail (from_node, to_node, body, ts) VALUES (?,?,?,?)',
            (from_node, to_node, body, now)
        )
        self._db.commit()
        mail_id = self._db.execute('SELECT last_insert_rowid()').fetchone()[0]
        self._db.execute(
            'INSERT INTO sf_queue (mail_id, to_node, from_node, ts) VALUES (?,?,?,?)',
            (mail_id, to_node, from_node, now)
        )
        self._db.commit()
        return {'status': 'ok', 'id': mail_id}

    def get_nodes(self, request):
        rows = self._db.execute(
            'SELECT node_id, short_name, long_name, first_seen, last_seen, msg_count '
            'FROM node_directory ORDER BY last_seen DESC'
        ).fetchall()
        return {'nodes': [dict(r) for r in rows]}

    def get_stats(self, request):
        name  = self.config.get('bbs_name', 'MeshBBS')
        stats = {
            'bbs_name': name,
            'version':  '1.0.3',
            'messages': self._db.execute('SELECT COUNT(*) FROM messages').fetchone()[0],
            'mail':     self._db.execute('SELECT COUNT(*) FROM mail').fetchone()[0],
            'nodes':    self._db.execute('SELECT COUNT(*) FROM node_directory').fetchone()[0],
        }
        for a in AREAS:
            stats[f'area_{a.lower()}'] = self._db.execute(
                'SELECT COUNT(*) FROM messages WHERE area=?', (a,)
            ).fetchone()[0]
        return stats

    # ── helpers ──────────────────────────────────────────────────────────────

    def _chunks(self, text: str, size: int = MAX_CHUNK):
        parts = []
        while len(text) > size:
            cut = text.rfind(' ', 0, size)
            if cut == -1:
                cut = size
            parts.append(text[:cut])
            text = text[cut:].lstrip()
        if text:
            parts.append(text)
        return parts or ['']
