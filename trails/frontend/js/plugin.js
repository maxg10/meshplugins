// Trails Plugin for MeshPulse
// Copyright (C) 2026 Mariusz "Max" Gieparda
// Licensed under GPL-3.0
//
// Shows where moving nodes are heading, where they have been, and replays it.
// The backend remembers the fixes; this side only asks for them and draws.
//
//   Vectors  an arrow on every node that moved in the last 30 minutes,
//            as long as the road it covers in 5 minutes
//   Trails   the route each mover left in the last 1, 6 or 24 hours
//   Replay   the whole history again, on a timeline you can play and scrub

var TrailsPlugin = (function () {

    var CHANNEL = 'trails';
    var LAYER = 'trails';
    var MODES = ['off', 'vectors', 'trails', 'replay'];
    var LIVE_S = 1800;            // a vector is only drawn for fixes this fresh
    var VECTOR_AHEAD_S = 300;     // arrow length: the road covered in this long
    var MIN_SPEED = 0.5;          // m/s; slower than this is standing (1.8 km/h)
    var GAP_S = 900;              // a longer silence is a gap, not a straight road
    var HOLD_S = 1800;            // replay keeps a silent mover on screen this long
    var TAIL_S = 1800;            // replay tail length
    var REFRESH_MS = 60000;
    var TRAIL_WINDOWS = [3600, 21600, 86400];
    var REPLAY_RANGES = [86400, 259200, 604800];
    var REPLAY_SPEEDS = [60, 300, 900, 3600];
    var COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

    function Trails() {
        this.api = null;
        this.panel = null;
        this.layer = null;
        this.mode = 'off';
        this.trailWindow = 21600;
        this.replayRange = 86400;
        this.replaySpeed = 300;
        this.data = null;          // last 'tracks' reply
        this.dataKey = null;       // which request produced it
        this.pending = false;
        this.error = null;
        this.req = 0;
        this.focus = null;         // node id the user picked from the list
        this.refreshTimer = null;
        this.renderTimer = null;
        this.timeout = null;
        // replay
        this.rt = null;            // current replay time (s)
        this.playing = false;
        this.raf = null;
        this.lastFrame = 0;
        this.rLayers = {};         // node id -> {dot, tail}
    }

    // ── helpers ─────────────────────────────────────────────────────────

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function now() { return Math.floor(Date.now() / 1000); }

    function colorFor(id) {
        var h = 0;
        for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
        return 'hsl(' + h + ', 85%, 55%)';
    }

    function kmh(ms) { return Math.round(ms * 3.6); }

    function compass(deg) { return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8]; }

    function clock(ts, withDate) {
        var d = new Date(ts * 1000);
        var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        if (!withDate) return hm;
        return d.getDate() + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + ' ' + hm;
    }

    function ago(ts) {
        var s = Math.max(0, now() - ts);
        if (s < 90) return 'just now';
        if (s < 5400) return Math.round(s / 60) + ' min ago';
        if (s < 129600) return Math.round(s / 3600) + ' h ago';
        return Math.round(s / 86400) + ' d ago';
    }

    function span(s) {
        return s >= 86400 ? (s / 86400) + 'd' : (s / 3600) + 'h';
    }

    // Point `dist` metres from (lat, lon) along `bearing` degrees.
    function destination(lat, lon, bearing, dist) {
        var r = 6371008.8, d = dist / r, b = bearing * Math.PI / 180;
        var p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
        var p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
        var l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
        return [p2 * 180 / Math.PI, ((l2 * 180 / Math.PI) + 540) % 360 - 180];
    }

    // Largest index i with pts[i][0] <= t, or -1.
    function indexAt(pts, t) {
        var lo = 0, hi = pts.length - 1, ans = -1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (pts[mid][0] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return ans;
    }

    // Where a track is at time t: {lat, lon, live, i} or null when it is not on screen.
    function positionAt(pts, t) {
        var i = indexAt(pts, t);
        if (i < 0) return null;
        var a = pts[i], b = pts[i + 1];
        if (b && b[0] - a[0] <= GAP_S) {
            var f = (t - a[0]) / Math.max(1, b[0] - a[0]);
            return {lat: a[1] + (b[1] - a[1]) * f, lon: a[2] + (b[2] - a[2]) * f, live: true, i: i};
        }
        if (t - a[0] <= HOLD_S) return {lat: a[1], lon: a[2], live: t - a[0] <= GAP_S, i: i};
        return null;
    }

    Trails.prototype._store = function (key, value) {
        try { if (this.api.storage) this.api.storage.set(key, value); } catch (e) { /* storage is a convenience */ }
    };

    Trails.prototype._load = function (key, fallback) {
        try {
            var v = this.api.storage ? this.api.storage.get(key) : null;
            return v === null || v === undefined ? fallback : v;
        } catch (e) { return fallback; }
    };

    // Map filters apply: a mover the core hides is hidden here too. A node
    // the core no longer knows (expired) can still be in the history.
    Trails.prototype._visibleFilter = function () {
        var vis = {}, known = {};
        var visible = (this.api.nodes.getVisible ? this.api.nodes.getVisible() : this.api.nodes.getAll()) || [];
        visible.forEach(function (n) { vis[n.id] = true; });
        (this.api.nodes.getAll() || []).forEach(function (n) { known[n.id] = n; });
        return function (id) { return vis[id] || !known[id]; };
    };

    // ── asking ──────────────────────────────────────────────────────────

    Trails.prototype._wantKey = function () {
        if (this.mode === 'vectors') return 'v';
        if (this.mode === 'trails') return 't' + this.trailWindow;
        if (this.mode === 'replay') return 'r' + this.replayRange;
        return null;
    };

    Trails.prototype._fetch = function () {
        var key = this._wantKey();
        if (!key) return;
        var since = now() - (this.mode === 'vectors' ? LIVE_S : this.mode === 'trails' ? this.trailWindow : this.replayRange);
        var self = this;
        this.req++;
        this.pending = true;
        this._pendingKey = key;
        this.api.ws.send(CHANNEL, {action: 'tracks', since: since, req: this.req});
        clearTimeout(this.timeout);
        this.timeout = setTimeout(function () {
            if (!self.pending) return;
            self.pending = false;
            self.error = 'The backend did not answer in 30 s.';
            self._renderPanel();
        }, 30000);
        this._renderPanel();
    };

    Trails.prototype._onMessage = function (msg) {
        if (!msg) return;
        if (msg.type === 'fix') { this._onFix(msg); return; }
        if (msg.action !== 'tracks' || (msg.req && msg.req !== this.req)) return;
        clearTimeout(this.timeout);
        this.pending = false;
        if (!msg.ok) {
            this.error = msg.error === 'not-ready' ? 'Trails is still starting up.' : (msg.error || 'unknown error');
            this._renderPanel();
            return;
        }
        this.error = null;
        this.data = msg;
        this.dataKey = this._pendingKey;
        if (this.mode === 'replay') this._replayLoaded();
        else this._draw();
        this._renderPanel();
    };

    // A mover just reported: grow its trail without asking for everything again.
    Trails.prototype._onFix = function (msg) {
        if (!this.data || this.mode === 'off' || this.mode === 'replay' || !msg.p) return;
        var tracks = this.data.tracks, t = null;
        for (var i = 0; i < tracks.length; i++) if (tracks[i].id === msg.id) { t = tracks[i]; break; }
        if (!t) { t = {id: msg.id, name: msg.name || msg.id, pts: []}; tracks.push(t); }
        var last = t.pts[t.pts.length - 1];
        if (last && last[0] >= msg.p[0]) return;
        t.pts.push(msg.p);
        if (msg.name) t.name = msg.name;
        var self = this;
        clearTimeout(this.renderTimer);
        this.renderTimer = setTimeout(function () { self._draw(); self._renderPanel(); }, 500);
    };

    // ── drawing: shared ─────────────────────────────────────────────────

    Trails.prototype._clearMap = function () {
        if (this.api && this.api.map.hasLayer(LAYER)) this.api.map.removeLayer(LAYER);
        this.layer = null;
        this.rLayers = {};
    };

    Trails.prototype._newLayer = function () {
        this._clearMap();
        this.layer = L.layerGroup();
        this.api.map.addLayer(LAYER, this.layer);
        return this.layer;
    };

    // Tracks worth drawing right now, in the order the list shows them.
    Trails.prototype._movers = function () {
        if (!this.data) return [];
        var ok = this._visibleFilter();
        var out = this.data.tracks.filter(function (t) { return t.pts.length && ok(t.id); });
        out.sort(function (a, b) { return b.pts[b.pts.length - 1][0] - a.pts[a.pts.length - 1][0]; });
        return out;
    };

    // Speed and direction a mover has right now, or null when it is standing.
    Trails.prototype._vector = function (t) {
        var last = t.pts[t.pts.length - 1];
        if (!last || now() - last[0] > LIVE_S) return null;
        var speed = last[3], heading = last[4];
        if (speed === null || speed === undefined || heading === null || heading === undefined) return null;
        if (speed < MIN_SPEED) return null;
        // Trackers stop reporting when they stop moving (smart broadcast), so a
        // silence several times longer than its usual rhythm means "arrived",
        // not "still doing 50 km/h".
        var gaps = [];
        for (var i = t.pts.length - 1; i > 0 && gaps.length < 5; i--) {
            var g = t.pts[i][0] - t.pts[i - 1][0];
            if (g <= GAP_S) gaps.push(g);
        }
        gaps.sort(function (a, b) { return a - b; });
        var usual = gaps.length ? gaps[gaps.length >> 1] : 120;
        if (now() - last[0] > Math.max(300, 3 * usual)) return null;
        return {speed: speed, heading: heading, ts: last[0], est: !!last[5]};
    };

    Trails.prototype._draw = function () {
        if (!window.L || !this.api) return;
        if (this.mode === 'vectors') this._drawVectors();
        else if (this.mode === 'trails') this._drawTrails();
        else if (this.mode !== 'replay') this._clearMap();
    };

    // ── vectors ─────────────────────────────────────────────────────────

    Trails.prototype._drawVectors = function () {
        var group = this._newLayer();
        var self = this;
        this._movers().forEach(function (t) {
            var v = self._vector(t);
            if (!v) return;
            var node = self.api.nodes.get ? self.api.nodes.get(t.id) : null;
            var last = t.pts[t.pts.length - 1];
            var from = (node && node.lat && node.lon) ? [node.lat, node.lon] : [last[1], last[2]];
            var len = Math.min(8000, Math.max(250, v.speed * VECTOR_AHEAD_S));
            var tip = destination(from[0], from[1], v.heading, len);
            var color = colorFor(t.id);
            var dim = self.focus && self.focus !== t.id;
            var w = dim ? 0.35 : 1;
            var label = (v.est ? '≈' : '') + kmh(v.speed) + ' km/h ' + compass(v.heading);

            L.polyline([from, tip], {color: '#000', weight: 7, opacity: 0.35 * w, interactive: false}).addTo(group);
            L.polyline([from, tip], {color: color, weight: 4, opacity: w}).addTo(group)
                .bindTooltip(esc(t.name) + ' · ' + label, {sticky: true});
            // Arrowhead: two short barbs back from the tip.
            var barb = Math.min(600, len * 0.28);
            var l1 = destination(tip[0], tip[1], v.heading + 150, barb);
            var r1 = destination(tip[0], tip[1], v.heading - 150, barb);
            L.polygon([tip, l1, r1], {color: color, weight: 1, fillColor: color, fillOpacity: w, opacity: w, interactive: false})
                .addTo(group);
            L.marker(tip, {
                interactive: false, keyboard: false,
                icon: L.divIcon({className: 'tr-label', html: '<span>' + esc(label) + '</span>', iconSize: null})
            }).addTo(group);
        });
    };

    // ── trails ──────────────────────────────────────────────────────────

    Trails.prototype._drawTrails = function () {
        var group = this._newLayer();
        var self = this;
        var t0 = now() - this.trailWindow, t1 = now();
        var withDate = this.trailWindow > 43200;
        this._movers().forEach(function (t) {
            var color = colorFor(t.id);
            var dim = self.focus && self.focus !== t.id;
            var pts = t.pts;
            for (var i = 1; i < pts.length; i++) {
                var a = pts[i - 1], b = pts[i];
                // Older segments fade, so the direction of travel reads at a glance.
                var age = Math.max(0, Math.min(1, (b[0] - t0) / Math.max(1, t1 - t0)));
                var op = (0.25 + 0.75 * age) * (dim ? 0.3 : 1);
                var gap = b[0] - a[0] > GAP_S;
                L.polyline([[a[1], a[2]], [b[1], b[2]]], {
                    color: color, weight: gap ? 2 : 4, opacity: op, dashArray: gap ? '4, 8' : null,
                    interactive: false
                }).addTo(group);
            }
            pts.forEach(function (p, i) {
                var isLast = i === pts.length - 1;
                var tip = '<b>' + esc(t.name) + '</b><br>' + clock(p[0], withDate) +
                    (p[3] !== null && p[3] !== undefined && p[3] >= MIN_SPEED ? ' · ' + (p[5] ? '≈' : '') + kmh(p[3]) + ' km/h' : '') +
                    (p[4] !== null && p[4] !== undefined ? ' ' + compass(p[4]) : '');
                L.circleMarker([p[1], p[2]], {
                    radius: isLast ? 5 : 3, color: isLast ? '#fff' : color, weight: isLast ? 2 : 1,
                    fillColor: color, fillOpacity: dim ? 0.3 : 0.95, opacity: dim ? 0.3 : 1
                }).bindTooltip(tip, {direction: 'top'}).addTo(group);
            });
        });
    };

    // ── replay ──────────────────────────────────────────────────────────

    Trails.prototype._replayLoaded = function () {
        this._stop();
        var d = this.data;
        this.rFrom = d.from;
        this.rTo = d.to;
        // Start where something actually happens, not at an empty hour.
        var first = Infinity;
        d.tracks.forEach(function (t) {
            for (var i = 0; i < t.pts.length; i++) if (t.pts[i][0] >= d.from) { first = Math.min(first, t.pts[i][0]); break; }
        });
        this.rt = isFinite(first) ? Math.max(d.from, first - 300) : d.from;
        this._newLayer();
        this._frame();
    };

    Trails.prototype._frame = function () {
        if (!this.layer || !this.data) return;
        var t = this.rt, self = this, ok = this._visibleFilter();
        var seen = {};
        this.data.tracks.forEach(function (tr) {
            if (!ok(tr.id)) return;
            var pos = positionAt(tr.pts, t);
            var rl = self.rLayers[tr.id];
            if (!pos) {
                if (rl) { self.layer.removeLayer(rl.dot); self.layer.removeLayer(rl.tail); delete self.rLayers[tr.id]; }
                return;
            }
            seen[tr.id] = true;
            // The last half hour behind the dot, cut at the first gap: a tail
            // never bridges a silence the mover did not report.
            var tail = [[pos.lat, pos.lon]];
            for (var j = pos.i; j >= 0; j--) {
                var p = tr.pts[j];
                if (p[0] < t - TAIL_S) break;
                if (j < pos.i && tr.pts[j + 1][0] - p[0] > GAP_S) break;
                tail.unshift([p[1], p[2]]);
            }
            var color = colorFor(tr.id);
            var dim = self.focus && self.focus !== tr.id;
            if (!rl) {
                rl = {
                    tail: L.polyline(tail, {color: color, weight: 4, opacity: 0.8, interactive: false}).addTo(self.layer),
                    dot: L.circleMarker([pos.lat, pos.lon], {radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1})
                        .bindTooltip(esc(tr.name), {permanent: true, direction: 'right', offset: [8, 0], className: 'tr-name'})
                        .addTo(self.layer)
                };
                self.rLayers[tr.id] = rl;
            } else {
                rl.tail.setLatLngs(tail);
                rl.dot.setLatLng([pos.lat, pos.lon]);
            }
            // A mover that has gone quiet is drawn hollow: we know where it was, not where it is.
            rl.dot.setStyle({fillOpacity: pos.live ? (dim ? 0.35 : 1) : 0.15, opacity: dim ? 0.4 : 1});
            rl.tail.setStyle({opacity: dim ? 0.25 : 0.8});
        });
        Object.keys(this.rLayers).forEach(function (id) {
            if (!seen[id]) {
                self.layer.removeLayer(self.rLayers[id].dot);
                self.layer.removeLayer(self.rLayers[id].tail);
                delete self.rLayers[id];
            }
        });
        this._renderClock();
    };

    Trails.prototype._play = function () {
        if (!this.data || this.playing) return;
        if (this.rt >= this.rTo) this.rt = this.rFrom;
        this.playing = true;
        this.lastFrame = 0;
        var self = this;
        function step(ts) {
            if (!self.playing) return;
            if (self.lastFrame) {
                var dt = Math.min(0.25, (ts - self.lastFrame) / 1000);
                self.rt = Math.min(self.rTo, self.rt + dt * self.replaySpeed);
            }
            self.lastFrame = ts;
            self._frame();
            if (self.rt >= self.rTo) { self._stop(); self._renderPanel(); return; }
            self.raf = requestAnimationFrame(step);
        }
        this.raf = requestAnimationFrame(step);
        this._renderPanel();
    };

    Trails.prototype._stop = function () {
        this.playing = false;
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = null;
    };

    Trails.prototype._renderClock = function () {
        if (!this.panel) return;
        var c = this.panel.querySelector('.tr-clock');
        var s = this.panel.querySelector('.tr-slider');
        if (c && this.rt) c.textContent = clock(Math.floor(this.rt), true);
        if (s && this.rTo > this.rFrom && document.activeElement !== s) {
            s.value = String(Math.round(1000 * (this.rt - this.rFrom) / (this.rTo - this.rFrom)));
        }
    };

    // ── panel ───────────────────────────────────────────────────────────

    Trails.prototype._renderPanel = function () {
        if (!this.panel) return;
        var self = this, mode = this.mode;
        var html = '<div class="tr-modes">' + MODES.map(function (m) {
            var label = {off: 'Off', vectors: 'Vectors', trails: 'Trails', replay: '⏱ Replay'}[m];
            return '<button type="button" class="tr-mode' + (m === mode ? ' tr-on' : '') + '" data-mode="' + m + '">' + label + '</button>';
        }).join('') + '</div>';

        if (mode === 'trails') {
            html += '<div class="tr-row">' + TRAIL_WINDOWS.map(function (w) {
                return '<button type="button" class="tr-chip' + (w === self.trailWindow ? ' tr-on' : '') + '" data-window="' + w + '">' + span(w) + '</button>';
            }).join('') + '</div>';
        }
        if (mode === 'replay') {
            html += '<div class="tr-row">' + REPLAY_RANGES.map(function (r) {
                return '<button type="button" class="tr-chip' + (r === self.replayRange ? ' tr-on' : '') + '" data-range="' + r + '">' + span(r) + '</button>';
            }).join('') + '</div>';
            var ready = this.data && this.dataKey === this._wantKey();
            html += '<div class="tr-player">' +
                '<button type="button" class="tr-play"' + (ready ? '' : ' disabled') + '>' + (this.playing ? '❚❚' : '▶') + '</button>' +
                '<input type="range" class="tr-slider" min="0" max="1000" value="0"' + (ready ? '' : ' disabled') + ' aria-label="Replay time">' +
                '</div>' +
                '<div class="tr-row tr-between"><span class="tr-clock">' + (ready && this.rt ? clock(Math.floor(this.rt), true) : '') + '</span>' +
                '<span>' + REPLAY_SPEEDS.map(function (s) {
                    return '<button type="button" class="tr-chip tr-speed' + (s === self.replaySpeed ? ' tr-on' : '') + '" data-speed="' + s + '">' + s + '×</button>';
                }).join('') + '</span></div>';
        }

        html += '<div class="tr-body">' + this._bodyHtml() + '</div>';
        this.panel.querySelector('.tr-content').innerHTML = html;

        this.panel.querySelectorAll('.tr-mode').forEach(function (b) {
            b.addEventListener('click', function () { self.setMode(b.getAttribute('data-mode')); });
        });
        this.panel.querySelectorAll('[data-window]').forEach(function (b) {
            b.addEventListener('click', function () {
                self.trailWindow = Number(b.getAttribute('data-window'));
                self._store('window', self.trailWindow);
                self._fetch();
            });
        });
        this.panel.querySelectorAll('[data-range]').forEach(function (b) {
            b.addEventListener('click', function () {
                self.replayRange = Number(b.getAttribute('data-range'));
                self._store('range', self.replayRange);
                self._stop();
                self._fetch();
            });
        });
        this.panel.querySelectorAll('[data-speed]').forEach(function (b) {
            b.addEventListener('click', function () {
                self.replaySpeed = Number(b.getAttribute('data-speed'));
                self._store('speed', self.replaySpeed);
                self._renderPanel();
            });
        });
        var play = this.panel.querySelector('.tr-play');
        if (play) play.addEventListener('click', function () {
            if (self.playing) { self._stop(); self._renderPanel(); } else self._play();
        });
        var slider = this.panel.querySelector('.tr-slider');
        if (slider) {
            slider.addEventListener('input', function () {
                if (!self.data) return;
                self._stop();
                self.rt = self.rFrom + (self.rTo - self.rFrom) * Number(slider.value) / 1000;
                self._frame();
                var p = self.panel.querySelector('.tr-play');
                if (p) p.textContent = '▶';
            });
            this._renderClock();
        }
        this.panel.querySelectorAll('.tr-mover').forEach(function (b) {
            b.addEventListener('click', function () { self._toggleFocus(b.getAttribute('data-id')); });
        });
    };

    Trails.prototype._bodyHtml = function () {
        var mode = this.mode;
        if (mode === 'off') return '<div class="tr-note">Arrows, trails and a replay for nodes that move.</div>';
        if (this.error) return '<div class="tr-note tr-bad">' + esc(this.error) + '</div>';
        if (!this.data || this.dataKey !== this._wantKey()) return '<div class="tr-note">Loading…</div>';

        var self = this;
        var movers = this._movers();
        if (mode === 'vectors') movers = movers.filter(function (t) { return self._vector(t); });

        var what = mode === 'vectors' ? 'moving now'
            : mode === 'trails' ? 'moved in the last ' + span(this.trailWindow)
            : 'moved in the last ' + span(this.replayRange);
        var head = '<div class="tr-note"><b>' + movers.length + '</b> ' + (movers.length === 1 ? 'node' : 'nodes') + ' ' + what +
            (this.data.truncated ? ' · thinned to fit' : '') + '</div>';
        if (mode === 'replay') {
            head += '<div class="tr-note">Map markers show <b>now</b>; coloured dots show the replay time.</div>';
        }
        if (!movers.length) {
            return head + '<div class="tr-note">A node shows up here once it moves farther than GPS noise ' +
                'and position rounding can explain (100 m by default).</div>';
        }
        return head + '<div class="tr-list">' + movers.slice(0, 30).map(function (t) {
            var last = t.pts[t.pts.length - 1];
            var v = self._vector(t);
            var right = mode === 'replay' ? t.pts.length + ' fixes'
                : v ? (v.est ? '≈' : '') + kmh(v.speed) + ' km/h ' + compass(v.heading) : ago(last[0]);
            return '<button type="button" class="tr-mover' + (self.focus === t.id ? ' tr-on' : '') + '" data-id="' + esc(t.id) + '">' +
                '<span class="tr-swatch" style="background:' + colorFor(t.id) + '"></span>' +
                '<span class="tr-name-l">' + esc(t.name) + '</span>' +
                '<span class="tr-right">' + esc(right) + '</span></button>';
        }).join('') + '</div>';
    };

    Trails.prototype._toggleFocus = function (id) {
        this.focus = this.focus === id ? null : id;
        var t = null;
        if (this.focus && this.data) {
            this.data.tracks.forEach(function (x) { if (x.id === id) t = x; });
            if (t && t.pts.length) {
                var lats = t.pts.map(function (p) { return p[1]; }), lons = t.pts.map(function (p) { return p[2]; });
                var b = [[Math.min.apply(null, lats), Math.min.apply(null, lons)], [Math.max.apply(null, lats), Math.max.apply(null, lons)]];
                if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) this.api.map.panTo(b[0][0], b[0][1]);
                else this.api.map.fitBounds(L.latLngBounds(b).pad(0.2));
            }
        }
        if (this.mode === 'replay') {
            // Picking a mover in the replay jumps to its first trip in the range.
            if (this.focus && t && t.pts.length) {
                this._stop();
                var start = null;
                for (var k = 0; k < t.pts.length; k++) if (t.pts[k][0] >= this.rFrom) { start = t.pts[k][0]; break; }
                if (start !== null) this.rt = Math.max(this.rFrom, start);
            }
            this._frame();
        } else this._draw();
        this._renderPanel();
    };

    Trails.prototype.setMode = function (mode) {
        if (MODES.indexOf(mode) < 0) mode = 'off';
        this._stop();
        this.mode = mode;
        this.focus = null;
        this.error = null;
        this._store('mode', mode);
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
        if (mode === 'off') { this._clearMap(); this.data = null; this._renderPanel(); return; }
        this._clearMap();
        this._fetch();
        if (mode !== 'replay') {
            var self = this;
            // Live modes age out: a vector from 31 minutes ago is no longer news.
            this.refreshTimer = setInterval(function () { self._fetch(); }, REFRESH_MS);
        }
    };

    // ── lifecycle ───────────────────────────────────────────────────────

    Trails.prototype.onEnable = function (api) {
        var self = this;
        this.api = api;
        var panel = document.createElement('div');
        panel.className = 'leaflet-control tr-panel';
        panel.innerHTML = '<div class="tr-head">🧭 Trails</div><div class="tr-content"></div>';
        this.panel = panel;
        if (api.panels && api.panels.register) api.panels.register(panel);
        else api.map.addControl('trails', panel, 'topleft');   // fallback < 2.6.1

        api.ws.subscribe(CHANNEL, function (msg) { self._onMessage(msg); });
        if (api.nodes.onFilterChange) api.nodes.onFilterChange(function () {
            if (self.mode === 'replay') self._frame(); else self._draw();
            self._renderPanel();
        });

        var w = Number(this._load('window', this.trailWindow));
        if (TRAIL_WINDOWS.indexOf(w) >= 0) this.trailWindow = w;
        var r = Number(this._load('range', this.replayRange));
        if (REPLAY_RANGES.indexOf(r) >= 0) this.replayRange = r;
        var s = Number(this._load('speed', this.replaySpeed));
        if (REPLAY_SPEEDS.indexOf(s) >= 0) this.replaySpeed = s;
        var cfg = (api.info && api.info.config) || {};
        var start = this._load('mode', cfg.default_mode || 'off');
        // Replay is something you start on purpose, never on page load.
        this.setMode(start === 'replay' ? 'off' : start);
    };

    Trails.prototype.onConfigUpdate = function () {
        if (this.mode !== 'off') this._fetch();
    };

    Trails.prototype.onDisable = function (api) {
        this._stop();
        clearInterval(this.refreshTimer);
        clearTimeout(this.renderTimer);
        clearTimeout(this.timeout);
        this._clearMap();
        if (api.ws && api.ws.unsubscribe) api.ws.unsubscribe(CHANNEL);
        if (this.panel) {
            if (api.panels && api.panels.unregister) api.panels.unregister(this.panel);
            else api.map.removeControl('trails');
            this.panel = null;
        }
        this.data = null;
        this.api = null;
    };

    return Trails;
})();

window.MeshPlugin = TrailsPlugin;
