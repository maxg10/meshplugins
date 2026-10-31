// Circles plugin for MeshPulse
// Copyright (C) 2026 Mariusz "Max" Gieparda
// Licensed under GPL-3.0
//
// Your own circles of nodes: family, your own gear, nodes you keep an eye on.
// They get a ring in their circle's colour on the map, a line each in the
// panel (last heard, battery, hops, SNR), and one switch, "Only my circles",
// hides everything else. The core's filter chain does the hiding
// (api.nodes.addFilter), so markers, lines, the No GPS list and every other
// plugin that draws visible nodes (Live Pulse, Weather Overlay, Trails)
// follow it without knowing Circles exists.
//
// With the switch on, the nodes that carry your circles' traffic can be shown
// too: a relay that handed one of their packets to your radio stays on the
// map for a few minutes, the same honest rule Live Pulse uses (a last byte
// counts only when exactly one node heard directly ends in it). Their
// neighbours from NEIGHBORINFO reports can be added as well.
//
// The circles live on the MeshPulse host (api.config.save), so every browser
// and phone sees the same ones; with an admin password set, changing them asks
// for it. What is switched on is remembered per browser.

var CirclesPlugin = (function () {
    'use strict';

    var COLORS = ['#f472b6', '#60a5fa', '#4ade80', '#fbbf24', '#c084fc', '#22d3ee', '#fb923c', '#f87171'];
    var ID_RE = /^![0-9a-f]{8}$/;
    var PANE = 'circlesPane';
    var NODE_CACHE_MS = 3000;
    var RENDER_DEBOUNCE_MS = 800;
    var RELAY_CHECK_MS = 10000;
    var SAVE_TIMEOUT_MS = 70000;
    var MAX_CIRCLES = 12, MAX_MEMBERS = 100, MAX_NAME = 40;

    function normId(s) {
        if (typeof s !== 'string') return null;
        s = s.trim().toLowerCase();
        if (/^[0-9a-f]{8}$/.test(s)) s = '!' + s;
        return ID_RE.test(s) ? s : null;
    }

    function hasPos(n) {
        return !!n && n.lat !== null && n.lon !== null && isFinite(n.lat) && isFinite(n.lon) &&
            !(Number(n.lat) === 0 && Number(n.lon) === 0);
    }

    function isDirect(n) {
        return !!n && (n.net || 'MT') === 'MT' && !n.via_mqtt && n.hops === 0;
    }

    function nameOf(n, id) { return (n && (n.name || n.long_name || n.short_name)) || id; }

    function ago(sec) {
        if (!isFinite(sec) || sec < 0) return '';
        if (sec < 90) return 'just now';
        if (sec < 3600) return Math.round(sec / 60) + ' min ago';
        if (sec < 172800) return Math.round(sec / 3600) + ' h ago';
        return Math.round(sec / 86400) + ' d ago';
    }

    // Circles come from a file anyone with the admin password can edit by
    // hand: keep only what this plugin could have written itself.
    function sanitize(list) {
        if (!Array.isArray(list)) return [];
        var out = [], seen = {};
        list.forEach(function (c) {
            if (!c || typeof c !== 'object' || out.length >= MAX_CIRCLES) return;
            var id = String(c.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
            if (!id || seen[id]) return;
            seen[id] = true;
            var nodes = [], have = {};
            (Array.isArray(c.nodes) ? c.nodes : []).forEach(function (n) {
                var v = normId(n);
                if (v && !have[v] && nodes.length < MAX_MEMBERS) { have[v] = true; nodes.push(v); }
            });
            out.push({
                id: id,
                name: String(c.name || 'Circle').slice(0, MAX_NAME),
                emoji: String(c.emoji || '').slice(0, 8),
                color: COLORS.indexOf(c.color) >= 0 ? c.color : COLORS[out.length % COLORS.length],
                nodes: nodes
            });
        });
        return out;
    }

    function Circles() {
        this.api = null;
        this.map = null;
        this.circles = [];          // as shown
        this.saved = [];            // as last confirmed by the host
        this.focus = false;
        this.hidden = {};           // circle id -> true: left out of rings and focus (this browser)
        this.showRelays = true;
        this.showNeighbours = false;
        this.showRings = true;
        this.relayUntil = {};       // node id -> ms
        this.keep = {};             // node ids the focus filter lets through
        this.nodes = null;
        this.nodesAt = 0;
        this.rings = null;
        this.editing = null;        // circle id being edited
        this.confirmDelete = null;
        this._control = null;
        this._renderTimer = null;
        this._relayTimer = null;
        this._saveTimer = null;
        this._filterFn = null;
    }

    // ── settings ────────────────────────────────────────────────────────

    Circles.prototype._cfg = function () {
        var c = (this.api && this.api.info && this.api.info.config) || {};
        return {
            circles: sanitize(c.circles),
            relayMinutes: Math.min(120, Math.max(1, Number(c.relay_minutes) || 5))
        };
    };

    Circles.prototype._store = function (key, value) {
        try { this.api.storage.set(key, value); } catch (e) {}
    };

    Circles.prototype._load = function (key) {
        try { return this.api.storage.get(key); } catch (e) { return null; }
    };

    // ── nodes ───────────────────────────────────────────────────────────

    Circles.prototype._index = function (fresh) {
        var now = Date.now();
        if (!fresh && this.nodes && now - this.nodesAt < NODE_CACHE_MS) return this.nodes;
        var byId = {};
        function add(n) { if (n && n.id && !byId[n.id]) byId[n.id] = n; }
        (this.api.nodes.getAll() || []).forEach(add);
        if (this.api.nodes.getNoPosition) (this.api.nodes.getNoPosition() || []).forEach(add);
        var tracker = this.api.nodes.getTracker ? this.api.nodes.getTracker() : null;
        this.nodes = {byId: byId, tracker: tracker};
        this.nodesAt = now;
        return this.nodes;
    };

    Circles.prototype._members = function () {
        var self = this, m = {};
        this.circles.forEach(function (c) {
            if (self.hidden[c.id]) return;
            c.nodes.forEach(function (id) { (m[id] = m[id] || []).push(c); });
        });
        return m;
    };

    // Same rule as Live Pulse: a last byte counts only when exactly one node
    // heard directly ends in it, nodes without a position included.
    Circles.prototype._resolveRelay = function (relay, idx) {
        if (!relay || typeof relay !== 'string') return null;
        if (relay.charAt(0) === '!') return idx.byId[relay] || null;
        var m = /^relay_([0-9a-f]{2})$/i.exec(relay);
        if (!m) return null;
        var tail = m[1].toLowerCase(), trackerId = idx.tracker && idx.tracker.id, hit = null;
        for (var id in idx.byId) {
            if (!Object.prototype.hasOwnProperty.call(idx.byId, id)) continue;
            if (id === trackerId || id.slice(-2).toLowerCase() !== tail || !isDirect(idx.byId[id])) continue;
            if (hit) return null;
            hit = idx.byId[id];
        }
        return hit;
    };

    // ── the focus filter ────────────────────────────────────────────────

    Circles.prototype._computeKeep = function () {
        var keep = {}, members = this._members(), now = Date.now();
        Object.keys(members).forEach(function (id) { keep[id] = 'member'; });
        if (this.showRelays) {
            for (var r in this.relayUntil) {
                if (this.relayUntil[r] > now && !keep[r]) keep[r] = 'relay';
            }
        }
        if (this.showNeighbours && this.api.links && this.api.links.getAll) {
            (this.api.links.getAll() || []).forEach(function (e) {
                if (e.kind !== 'neighbor') return;
                if (members[e.from] && !keep[e.to]) keep[e.to] = 'neighbour';
                if (members[e.to] && !keep[e.from]) keep[e.from] = 'neighbour';
            });
        }
        this.keep = keep;
    };

    Circles.prototype._applyFocus = function () {
        var self = this;
        this._computeKeep();
        if (this.focus) {
            if (!this._filterFn) {
                this._filterFn = function (n) { return !!self.keep[n.id]; };
                this.api.nodes.addFilter(this._filterFn);
            } else {
                this.api.nodes.refilter();
            }
        } else if (this._filterFn) {
            this._filterFn = null;
            this.api.nodes.removeFilter();
        }
        this._scheduleRender();
    };

    Circles.prototype._onPacket = function (p) {
        if (!p || !p.from_id || !(p.hops > 0)) return;
        var members = this._members();
        if (!members[p.from_id]) return;
        var idx = this._index();
        var relay = this._resolveRelay(p.relay, idx);
        if (!relay || relay.id === p.from_id || (idx.tracker && relay.id === idx.tracker.id)) return;
        var isNew = !(this.relayUntil[relay.id] > Date.now());
        this.relayUntil[relay.id] = Date.now() + this._cfg().relayMinutes * 60000;
        if (isNew && this.focus && this.showRelays) this._applyFocus();
    };

    Circles.prototype._expireRelays = function () {
        var now = Date.now(), gone = false;
        for (var id in this.relayUntil) {
            if (this.relayUntil[id] <= now) { delete this.relayUntil[id]; gone = true; }
        }
        if (gone && this.focus && this.showRelays) this._applyFocus();
    };

    // ── rings on the map ────────────────────────────────────────────────

    Circles.prototype._drawRings = function (visible) {
        if (!this.rings) return;
        this.rings.clearLayers();
        var self = this, members = this._members();
        var shown = {};
        (visible || this.api.nodes.getVisible() || []).forEach(function (n) { shown[n.id] = n; });
        Object.keys(shown).forEach(function (id) {
            var n = shown[id];
            if (!hasPos(n)) return;
            var ll = [Number(n.lat), Number(n.lon)];
            if (self.showRings && members[id]) {
                members[id].forEach(function (c, i) {
                    L.circleMarker(ll, {
                        pane: PANE, interactive: false, radius: 12 + i * 4,
                        color: c.color, weight: 3, opacity: 0.95, fill: false
                    }).addTo(self.rings);
                });
            } else if (self.focus && self.keep[id] === 'relay') {
                L.circleMarker(ll, {
                    pane: PANE, interactive: false, radius: 12, color: '#e5e7eb',
                    weight: 1.5, opacity: 0.8, dashArray: '3 4', fill: false
                }).addTo(self.rings);
            }
        });
    };

    // ── panel ───────────────────────────────────────────────────────────

    Circles.prototype._el = function (tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;   // names come from the air
        return e;
    };

    Circles.prototype._buildPanel = function () {
        var el = document.createElement('div');
        el.className = 'circles-panel';
        el.innerHTML =
            '<div class="ci-title">⭕ Circles</div>' +
            '<label class="ci-switch"><input type="checkbox" class="ci-focus"> <span>Only my circles</span></label>' +
            '<div class="ci-opts">' +
                '<label><input type="checkbox" class="ci-relays"> <span class="ci-relays-label">Show relays</span></label>' +
                '<label><input type="checkbox" class="ci-neigh"> <span>Show their neighbours</span></label>' +
                '<label><input type="checkbox" class="ci-rings"> <span>Rings on the map</span></label>' +
            '</div>' +
            '<div class="ci-list"></div>' +
            '<div class="ci-add">' +
                '<input type="text" class="ci-search" list="circles-dl" placeholder="Node name or !id" autocomplete="off" spellcheck="false">' +
                '<datalist id="circles-dl"></datalist>' +
                '<div class="ci-add-row"><select class="ci-target" aria-label="Circle"></select>' +
                '<button type="button" class="ci-btn ci-add-btn">Add</button></div>' +
            '</div>' +
            '<button type="button" class="ci-btn ci-new">+ New circle</button>' +
            '<div class="ci-msg" role="status"></div>';
        return el;
    };

    Circles.prototype._wirePanel = function () {
        var self = this, el = this._control;
        function check(cls, val, fn) {
            var box = el.querySelector(cls);
            box.checked = val;
            box.addEventListener('change', function () { fn(box.checked); });
        }
        check('.ci-focus', this.focus, function (v) { self.focus = v; self._store('focus', v ? '1' : '0'); self._applyFocus(); });
        check('.ci-relays', this.showRelays, function (v) { self.showRelays = v; self._store('relays', v ? '1' : '0'); self._applyFocus(); });
        check('.ci-neigh', this.showNeighbours, function (v) { self.showNeighbours = v; self._store('neigh', v ? '1' : '0'); self._applyFocus(); });
        check('.ci-rings', this.showRings, function (v) { self.showRings = v; self._store('rings', v ? '1' : '0'); self._render(); });

        var search = el.querySelector('.ci-search');
        search.addEventListener('input', function () { self._suggest(search.value); });
        search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); self._addFromSearch(); } });
        el.querySelector('.ci-add-btn').addEventListener('click', function () { self._addFromSearch(); });
        el.querySelector('.ci-new').addEventListener('click', function () { self._newCircle(); });

        // One listener for the list, which is rebuilt on every render.
        el.querySelector('.ci-list').addEventListener('click', function (e) { self._onListClick(e); });
        el.querySelector('.ci-list').addEventListener('change', function (e) { self._onListChange(e); });
    };

    Circles.prototype._msg = function (text, bad) {
        var m = this._control && this._control.querySelector('.ci-msg');
        if (!m) return;
        m.textContent = text || '';
        m.classList.toggle('ci-bad', !!bad);
    };

    Circles.prototype._suggest = function (q) {
        var dl = this._control.querySelector('#circles-dl');
        dl.textContent = '';
        q = (q || '').trim().toLowerCase();
        if (q.length < 2) return;
        var idx = this._index(), hits = 0;
        for (var id in idx.byId) {
            if (!Object.prototype.hasOwnProperty.call(idx.byId, id)) continue;
            var n = idx.byId[id], name = nameOf(n, id);
            if (name.toLowerCase().indexOf(q) < 0 && id.indexOf(q) < 0) continue;
            var o = document.createElement('option');
            o.value = name + ' (' + id + ')';
            dl.appendChild(o);
            if (++hits >= 20) break;
        }
    };

    Circles.prototype._addFromSearch = function () {
        var input = this._control.querySelector('.ci-search');
        var raw = (input.value || '').trim();
        var m = /\((![0-9a-fA-F]{8})\)\s*$/.exec(raw);
        var id = normId(m ? m[1] : raw);
        if (!id) {
            // A name typed in full, matching exactly one node, is fine too.
            var idx = this._index(), found = [];
            for (var k in idx.byId) {
                if (Object.prototype.hasOwnProperty.call(idx.byId, k) && nameOf(idx.byId[k], k).toLowerCase() === raw.toLowerCase()) found.push(k);
            }
            if (found.length === 1) id = found[0];
        }
        if (!id) { this._msg('Pick a node from the list, or type its id (!a1b2c3d4).', true); return; }
        var target = this._control.querySelector('.ci-target').value;
        var c = this.circles.filter(function (x) { return x.id === target; })[0];
        if (!c) { this._msg('Create a circle first.', true); return; }
        if (c.nodes.indexOf(id) >= 0) { this._msg('Already in ' + c.name + '.', false); return; }
        if (c.nodes.length >= MAX_MEMBERS) { this._msg('A circle holds at most ' + MAX_MEMBERS + ' nodes.', true); return; }
        c.nodes.push(id);
        input.value = '';
        this._changed();
    };

    Circles.prototype._newCircle = function () {
        if (this.circles.length >= MAX_CIRCLES) { this._msg('At most ' + MAX_CIRCLES + ' circles.', true); return; }
        var used = this.circles.map(function (c) { return c.color; });
        var color = COLORS.filter(function (c) { return used.indexOf(c) < 0; })[0] || COLORS[0];
        var c = {id: 'c' + Date.now().toString(36), name: 'New circle', emoji: '⭕', color: color, nodes: []};
        this.circles.push(c);
        this.editing = c.id;
        this._changed();
    };

    Circles.prototype._circleById = function (id) {
        return this.circles.filter(function (c) { return c.id === id; })[0] || null;
    };

    Circles.prototype._onListClick = function (e) {
        var t = e.target.closest('[data-act]');
        if (!t) return;
        var act = t.dataset.act, c = this._circleById(t.dataset.circle);
        if (act === 'go') {
            var n = this._index().byId[t.dataset.node];
            if (n && hasPos(n) && this.map) this.map.setView([Number(n.lat), Number(n.lon)], Math.max(this.map.getZoom(), 13));
            else this._msg('No position for this node yet.', false);
            return;
        }
        if (!c) return;
        if (act === 'remove') {
            c.nodes = c.nodes.filter(function (x) { return x !== t.dataset.node; });
            this._changed();
        } else if (act === 'edit') {
            this.editing = this.editing === c.id ? null : c.id;
            this.confirmDelete = null;
            this._render();
        } else if (act === 'color') {
            c.color = t.dataset.color;
            this._changed();
        } else if (act === 'delete') {
            if (this.confirmDelete !== c.id) { this.confirmDelete = c.id; this._render(); return; }
            this.circles = this.circles.filter(function (x) { return x !== c; });
            this.editing = null;
            this.confirmDelete = null;
            this._changed();
        }
    };

    Circles.prototype._onListChange = function (e) {
        var t = e.target, c = this._circleById(t.dataset.circle);
        if (!c) return;
        if (t.dataset.act === 'show') {
            if (t.checked) delete this.hidden[c.id]; else this.hidden[c.id] = true;
            this._store('hidden', JSON.stringify(Object.keys(this.hidden)));
            this._applyFocus();
        } else if (t.dataset.act === 'name') {
            c.name = (t.value || '').trim().slice(0, MAX_NAME) || 'Circle';
            this._changed();
        } else if (t.dataset.act === 'emoji') {
            c.emoji = (t.value || '').trim().slice(0, 8);
            this._changed();
        }
    };

    Circles.prototype._render = function () {
        if (!this._control) return;
        var self = this, idx = this._index(true), now = Date.now() / 1000;
        var list = this._control.querySelector('.ci-list');
        list.textContent = '';
        if (!this.circles.length) list.appendChild(this._el('div', 'ci-empty', 'No circles yet. Make one below.'));

        this.circles.forEach(function (c) {
            var box = self._el('div', 'ci-circle');
            box.style.setProperty('--ci-color', c.color);
            var head = self._el('div', 'ci-head');
            var show = document.createElement('input');
            show.type = 'checkbox';
            show.checked = !self.hidden[c.id];
            show.title = 'Show this circle (in this browser)';
            show.dataset.act = 'show';
            show.dataset.circle = c.id;
            head.appendChild(show);
            head.appendChild(self._el('i', 'ci-dot'));
            head.appendChild(self._el('span', 'ci-name', (c.emoji ? c.emoji + ' ' : '') + c.name));
            head.appendChild(self._el('span', 'ci-count', String(c.nodes.length)));
            var edit = self._el('button', 'ci-icon', self.editing === c.id ? '✓' : '✎');
            edit.type = 'button';
            edit.title = self.editing === c.id ? 'Done' : 'Edit circle';
            edit.dataset.act = 'edit';
            edit.dataset.circle = c.id;
            head.appendChild(edit);
            box.appendChild(head);

            if (self.editing === c.id) {
                var ed = self._el('div', 'ci-edit');
                var nm = document.createElement('input');
                nm.type = 'text'; nm.value = c.name; nm.maxLength = MAX_NAME;
                nm.dataset.act = 'name'; nm.dataset.circle = c.id; nm.className = 'ci-in-name';
                var em = document.createElement('input');
                em.type = 'text'; em.value = c.emoji; em.maxLength = 8; em.placeholder = '🙂';
                em.dataset.act = 'emoji'; em.dataset.circle = c.id; em.className = 'ci-in-emoji';
                ed.appendChild(em);
                ed.appendChild(nm);
                var sw = self._el('div', 'ci-swatches');
                COLORS.forEach(function (col) {
                    var b = self._el('button', 'ci-swatch' + (col === c.color ? ' on' : ''));
                    b.type = 'button'; b.style.background = col; b.title = col;
                    b.dataset.act = 'color'; b.dataset.color = col; b.dataset.circle = c.id;
                    sw.appendChild(b);
                });
                ed.appendChild(sw);
                var del = self._el('button', 'ci-btn ci-del', self.confirmDelete === c.id ? 'Click again to delete' : 'Delete circle');
                del.type = 'button'; del.dataset.act = 'delete'; del.dataset.circle = c.id;
                ed.appendChild(del);
                box.appendChild(ed);
            }

            c.nodes.forEach(function (id) {
                var n = idx.byId[id];
                var row = self._el('div', 'ci-member');
                var name = self._el('button', 'ci-link', nameOf(n, id));
                name.type = 'button';
                name.title = id + (n && hasPos(n) ? ' · show on map' : '');
                name.dataset.act = 'go'; name.dataset.node = id;
                var bits = [];
                if (!n) bits.push('not heard yet');
                else {
                    if (n.ts) bits.push(ago(now - n.ts));
                    if (n.battery_level != null) bits.push('🔋 ' + Math.min(100, Math.round(n.battery_level)) + '%');
                    if (n.hops != null) bits.push(n.hops === 0 ? 'direct' : n.hops + (n.hops === 1 ? ' hop' : ' hops'));
                    if (n.snr != null) bits.push(Number(n.snr).toFixed(1) + ' dB');
                    if (!hasPos(n)) bits.push('no GPS');
                }
                var meta = self._el('span', 'ci-meta', bits.join(' · '));
                var x = self._el('button', 'ci-icon ci-x', '×');
                x.type = 'button'; x.title = 'Remove from ' + c.name;
                x.dataset.act = 'remove'; x.dataset.circle = c.id; x.dataset.node = id;
                row.appendChild(name);
                row.appendChild(x);
                row.appendChild(meta);
                box.appendChild(row);
            });
            list.appendChild(box);
        });

        var sel = this._control.querySelector('.ci-target');
        var prev = sel.value;
        sel.textContent = '';
        this.circles.forEach(function (c) {
            var o = document.createElement('option');
            o.value = c.id;
            o.textContent = (c.emoji ? c.emoji + ' ' : '') + c.name;
            sel.appendChild(o);
        });
        if (prev && this._circleById(prev)) sel.value = prev;

        var lbl = this._control.querySelector('.ci-relays-label');
        if (lbl) lbl.textContent = 'Show relays (' + this._cfg().relayMinutes + ' min)';
        this._control.querySelector('.ci-opts').classList.toggle('ci-off', !this.focus);

        if (this.focus && !Object.keys(this._members()).length) {
            this._msg('Nothing to show: add nodes to a circle, or switch one on.', false);
        }
        this._drawRings();
    };

    Circles.prototype._scheduleRender = function () {
        var self = this;
        if (this._renderTimer) return;
        this._renderTimer = setTimeout(function () { self._renderTimer = null; self._render(); }, RENDER_DEBOUNCE_MS);
    };

    // ── saving ──────────────────────────────────────────────────────────

    Circles.prototype._changed = function () {
        var self = this;
        this.circles = sanitize(this.circles);
        this._applyFocus();
        this._render();
        if (!this.api.config || !this.api.config.save) {
            this._msg('This MeshPulse cannot store circles (needs 2.9.4).', true);
            return;
        }
        this._msg('Saving…', false);
        var snapshot = JSON.parse(JSON.stringify(this.circles));
        if (this._saveTimer) clearTimeout(this._saveTimer);
        // With an admin password, an unanswered save means the dialog was closed.
        this._saveTimer = setTimeout(function () {
            self._saveTimer = null;
            self._revert('Not saved: changing circles needs the admin password.');
        }, SAVE_TIMEOUT_MS);
        this.api.config.save({circles: snapshot}, function (r) {
            if (self._saveTimer) { clearTimeout(self._saveTimer); self._saveTimer = null; }
            if (r && r.success) {
                self.saved = snapshot;
                self._msg('Saved on MeshPulse.', false);
            } else {
                self._revert('Not saved: ' + ((r && r.error) || 'unknown error'));
            }
        });
    };

    Circles.prototype._revert = function (why) {
        this.circles = JSON.parse(JSON.stringify(this.saved));
        this._applyFocus();
        this._render();
        this._msg(why, true);
    };

    // ── lifecycle ───────────────────────────────────────────────────────

    Circles.prototype.onEnable = function (api) {
        var self = this;
        this.api = api;
        this.map = api.map.getLeafletMap();
        var cfg = this._cfg();
        this.circles = cfg.circles;
        this.saved = JSON.parse(JSON.stringify(cfg.circles));

        this.focus = this._load('focus') === '1';
        this.showRelays = this._load('relays') !== '0';
        this.showNeighbours = this._load('neigh') === '1';
        this.showRings = this._load('rings') !== '0';
        try {
            (JSON.parse(this._load('hidden') || '[]') || []).forEach(function (id) { self.hidden[id] = true; });
        } catch (e) {}

        if (!this.map.getPane(PANE)) {
            // Just under the markers (600), above lines and Live Pulse (450).
            var pane = this.map.createPane(PANE);
            pane.style.zIndex = 590;
            pane.style.pointerEvents = 'none';
        }
        this.rings = L.layerGroup().addTo(this.map);

        this._control = this._buildPanel();
        this._wirePanel();
        if (api.panels && api.panels.register) api.panels.register(this._control);
        else api.map.addControl('circles', this._control, 'topleft');

        if (!api.nodes.addFilter) {
            this._msg('Needs MeshPulse 2.9.4 or newer.', true);
            this._control.querySelector('.ci-focus').disabled = true;
        }

        if (api.packets) api.packets.onPacket(function (p) { self._onPacket(p); });
        if (api.nodes.onUpdate) api.nodes.onUpdate(function () { self.nodesAt = 0; self._scheduleRender(); });
        if (api.nodes.onFilterChange) api.nodes.onFilterChange(function (visible) { self._drawRings(visible); });
        if (api.links && api.links.onUpdate) {
            api.links.onUpdate(function () { if (self.focus && self.showNeighbours) self._applyFocus(); });
        }
        this._relayTimer = setInterval(function () { self._expireRelays(); }, RELAY_CHECK_MS);

        if (api.nodes.addFilter) this._applyFocus();
        this._render();
    };

    // Another browser saved circles, or the relay time changed in Config.
    Circles.prototype.onConfigUpdate = function () {
        if (this._saveTimer) return;     // our own save is still on its way
        var cfg = this._cfg();
        this.circles = cfg.circles;
        this.saved = JSON.parse(JSON.stringify(cfg.circles));
        this.nodesAt = 0;
        this._applyFocus();
        this._render();
    };

    Circles.prototype.onDisable = function (api) {
        if (this._filterFn && api.nodes.removeFilter) api.nodes.removeFilter();
        this._filterFn = null;
        if (this._relayTimer) { clearInterval(this._relayTimer); this._relayTimer = null; }
        if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
        if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
        if (this.rings && this.map) { this.map.removeLayer(this.rings); }
        this.rings = null;
        if (this._control) {
            if (api.panels && api.panels.unregister) api.panels.unregister(this._control);
            else api.map.removeControl('circles');
            this._control = null;
        }
        this.api = null;
        this.map = null;
    };

    return Circles;
})();

window.MeshPlugin = CirclesPlugin;
