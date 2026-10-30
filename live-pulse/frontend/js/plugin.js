// Live Pulse plugin for MeshPulse
// Copyright (C) 2026 Mariusz "Max" Gieparda
// Licensed under GPL-3.0
//
// Radio traffic as it happens: a pulse on the node that just transmitted,
// and a glowing arc along the part of its path this mapper can actually see.
//
// Honest arcs only. The core reports, for every packet its radio heard, how
// many hops it took and (as a last byte, usually) which node handed it over.
// So a packet heard directly gets an arc from its sender to us; a relayed one
// gets a glowing arc from the relay to us and a dashed one from the sender to
// the relay, because the hops in between are unknown. When the last byte fits
// more than one node we heard directly, there is no arc at all: that would be
// a guess.
//
// Everything is drawn on one canvas, and only while something moves. Senders
// and the links that carried their traffic keep a fading afterglow (how long
// is the Persistence setting), redrawn at 10 frames a second; after that
// nothing runs. The Raspberry Pi does nothing
// extra: it already sends the packets (api.packets, MeshPulse 2.9.3+).

var LivePulsePlugin = (function () {
    'use strict';

    var CATS = {
        text:      {label: 'Text',      color: '#fbbf24'},
        position:  {label: 'Position',  color: '#22d3ee'},
        telemetry: {label: 'Telemetry', color: '#4ade80'},
        nodeinfo:  {label: 'Node info', color: '#c084fc'},
        routing:   {label: 'Routing',   color: '#60a5fa'},
        encrypted: {label: 'Encrypted', color: '#f472b6'},
        other:     {label: 'Other',     color: '#fb923c'}
    };
    var CAT_ORDER = ['text', 'position', 'telemetry', 'nodeinfo', 'routing', 'encrypted', 'other'];

    var PANE = 'livePulsePane';
    var RINGS = 3;
    var TRAVEL_MS = 850;
    var HEAT_MIN = 0.03, HEAT_MAX = 6;
    var GLOW_R = 24;                  // px, the sender's afterglow halo

    // How long things stay on screen. "normal" suits a mesh where a packet
    // comes every few seconds; "long" one where they come every half minute.
    //   pulse  one ring's life        gap   delay between rings
    //   fade   an arc fading out      glow  the sender's afterglow (0: none)
    //   heat   half-life of a link's afterglow
    var PERSIST = {
        short:  {pulse: 1800, gap: 260, fade: 900,  glow: 0,      heat: 20000},
        normal: {pulse: 3200, gap: 450, fade: 1500, glow: 60000,  heat: 45000},
        long:   {pulse: 4500, gap: 650, fade: 2500, glow: 180000, heat: 90000}
    };
    var PERSIST_ORDER = ['short', 'normal', 'long'];
    var IDLE_FRAME_MS = 100;          // afterglow only: 10 frames a second
    var NODE_CACHE_MS = 3000;
    var RECENT_MAX = 4;
    var DARK_FILTER = 'invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9) saturate(0.5)';

    function catOf(port) {
        switch (port) {
            case 'TEXT_MESSAGE_APP': case 'TEXT_MESSAGE_COMPRESSED_APP': return 'text';
            case 'POSITION_APP': case 'WAYPOINT_APP': return 'position';
            case 'TELEMETRY_APP': return 'telemetry';
            case 'NODEINFO_APP': return 'nodeinfo';
            case 'ROUTING_APP': case 'TRACEROUTE_APP': case 'NEIGHBORINFO_APP': return 'routing';
            case 'ENCRYPTED': return 'encrypted';
            default: return 'other';
        }
    }

    function portLabel(port) {
        if (!port) return 'packet';
        if (port === 'ENCRYPTED') return 'encrypted';
        return String(port).replace(/_APP$/, '').replace(/_/g, ' ').toLowerCase();
    }

    function hasPos(n) {
        return !!n && isFinite(n.lat) && isFinite(n.lon) && n.lat !== null && n.lon !== null &&
            !(Number(n.lat) === 0 && Number(n.lon) === 0);
    }

    // A node this mapper's own radio heard with zero hops, the same test the
    // core uses for direct links (Meshtastic only, not via MQTT).
    function isDirect(n) {
        return !!n && (n.net || 'MT') === 'MT' && !n.via_mqtt && n.hops === 0;
    }

    function nameOf(n, fallback) {
        return (n && (n.name || n.long_name || n.short_name)) || fallback || '?';
    }

    function rgba(hex, a) {
        var v = parseInt(hex.slice(1), 16);
        return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a.toFixed(3) + ')';
    }

    function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
    function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

    function ago(ms) {
        var s = Math.max(0, Math.round(ms / 1000));
        if (s < 60) return s + ' s';
        return Math.round(s / 60) + ' min';
    }

    function LivePulse() {
        this.api = null;
        this.map = null;
        this.canvas = null;
        this.ctx = null;
        this.dpr = 1;
        this.active = false;
        this.dark = true;
        this.anims = [];
        this.heat = {};
        this.raf = null;
        this._idleTimer = null;
        this._statsTimer = null;
        this.nodes = null;
        this.nodesAt = 0;
        this.minute = [];          // [{t, id}] of the last 60 s
        this.recent = [];          // newest first
        this._control = null;
        this._keys = {};
        this._mapHandlers = null;
        this._visibilityHandler = null;
        this._tileFilter = null;
        this._reduced = false;
        this.persist = 'normal';
        this.glow = {};            // node id -> {ll, color, t}: who was talking lately
    }

    LivePulse.prototype._p = function () { return PERSIST[this.persist] || PERSIST.normal; };

    // ── config ──────────────────────────────────────────────────────────

    LivePulse.prototype._cfg = function () {
        var c = (this.api && this.api.info && this.api.info.config) || {};
        return {
            defaultEnabled: c.default_enabled !== false,
            darkMap: c.dark_map !== false,
            arcs: c.show_arcs !== false,
            persistence: PERSIST[c.persistence] ? c.persistence : 'normal',
            maxAnims: Math.min(300, Math.max(10, Number(c.max_animations) || 80))
        };
    };

    // ── nodes ───────────────────────────────────────────────────────────
    // api.nodes hands out deep copies, so they are read at most every few
    // seconds, not once per packet. Nodes without a position count too: a
    // relay is often a router that never shares one, and leaving it out would
    // make a last byte look unique when it is not.

    LivePulse.prototype._nodeIndex = function () {
        var now = Date.now();
        if (this.nodes && now - this.nodesAt < NODE_CACHE_MS) return this.nodes;
        var byId = {}, visible = null;
        function add(n) { if (n && n.id && !byId[n.id]) byId[n.id] = n; }
        (this.api.nodes.getAll() || []).forEach(add);
        if (this.api.nodes.getNoPosition) (this.api.nodes.getNoPosition() || []).forEach(add);
        if (this.api.nodes.getVisible) {
            visible = {};
            (this.api.nodes.getVisible() || []).forEach(function (n) { if (n && n.id) visible[n.id] = true; });
        }
        var tracker = this.api.nodes.getTracker ? this.api.nodes.getTracker() : null;
        this.nodes = {byId: byId, visible: visible, tracker: tracker};
        this.nodesAt = now;
        return this.nodes;
    };

    LivePulse.prototype._shown = function (n, idx) {
        if (!n) return false;
        if (idx.tracker && n.id === idx.tracker.id) return true;
        return !idx.visible || !!idx.visible[n.id];
    };

    // The node that handed the packet to our radio, or null when that is not
    // known for certain. 'relay_XX' is only a last byte: it counts only when
    // exactly one node we heard directly ends in it, with or without a
    // position (an arc needs one; naming the relay in the list does not).
    LivePulse.prototype._resolveRelay = function (relay, idx) {
        if (!relay || typeof relay !== 'string') return null;
        if (relay.charAt(0) === '!') return idx.byId[relay] || null;
        var m = /^relay_([0-9a-f]{2})$/i.exec(relay);
        if (!m) return null;
        var tail = m[1].toLowerCase();
        var trackerId = idx.tracker && idx.tracker.id;
        var hit = null;
        for (var id in idx.byId) {
            if (!Object.prototype.hasOwnProperty.call(idx.byId, id)) continue;
            if (id === trackerId || id.slice(-2).toLowerCase() !== tail) continue;
            if (!isDirect(idx.byId[id])) continue;
            if (hit) return null;        // two candidates: that would be a guess
            hit = idx.byId[id];
        }
        return hit;
    };

    // ── packets ─────────────────────────────────────────────────────────

    LivePulse.prototype._onPacket = function (p) {
        if (!this.active || !p || !p.from_id) return;
        var now = Date.now();
        var idx = this._nodeIndex();
        var cfg = this._cfg();
        var from = idx.byId[p.from_id] || null;
        var cat = catOf(p.portnum);
        var color = CATS[cat].color;
        var tracker = idx.tracker;
        var relay = p.hops === 0 ? null : this._resolveRelay(p.relay, idx);
        if (relay && relay.id === p.from_id) relay = null;

        this.minute.push({t: now, id: p.from_id});
        this._remember(p, from, relay, cat, now);

        // A hidden tab shows nothing; animating packets later, all at once,
        // would only look like a burst that never happened.
        if (document.hidden) return;

        var fromOnMap = hasPos(from) && this._shown(from, idx);
        var arcsOn = cfg.arcs && hasPos(tracker);
        if (fromOnMap) {
            this._addPulse(from, color, p.snr, 1, now);
            if (this._p().glow) this.glow[from.id] = {ll: [Number(from.lat), Number(from.lon)], color: color, t: now};
        }

        if (arcsOn) {
            if (p.hops === 0 && fromOnMap && from.id !== tracker.id) {
                this._addArc(from, tracker, color, 0, false, now);
            } else if (relay && hasPos(relay) && this._shown(relay, idx)) {
                var delay = 0;
                if (fromOnMap) {
                    this._addArc(from, relay, color, 0, true, now);
                    delay = TRAVEL_MS * 0.8;
                }
                this._addArc(relay, tracker, color, delay, false, now);
            } else {
                // Heard, but the way it came is unknown: a small blip at home.
                this._addPulse(tracker, color, null, 0.35, now);
            }
        }
        this._kick();
    };

    LivePulse.prototype._remember = function (p, from, relay, cat, now) {
        var route = '';
        if (p.hops === 0) route = 'direct';
        else if (relay) route = 'via ' + nameOf(relay, relay.id);
        else if (typeof p.hops === 'number') route = p.hops + (p.hops === 1 ? ' hop' : ' hops');
        this.recent.unshift({
            t: now, id: p.from_id, name: nameOf(from, p.from_id),
            port: portLabel(p.portnum), cat: cat, route: route,
            lat: hasPos(from) ? from.lat : null, lon: hasPos(from) ? from.lon : null
        });
        if (this.recent.length > RECENT_MAX) this.recent.length = RECENT_MAX;
        this._renderStats();
    };

    // ── animations ──────────────────────────────────────────────────────

    LivePulse.prototype._push = function (a) {
        var max = this._cfg().maxAnims;
        while (this.anims.length >= max) this.anims.shift();
        this.anims.push(a);
    };

    LivePulse.prototype._addPulse = function (n, color, snr, scale, now) {
        // Louder is bigger: SNR from -15 dB (small) to +10 dB (large).
        var s = (snr === null || snr === undefined) ? 0.5 : Math.max(0, Math.min(1, (snr + 15) / 25));
        var P = this._p();
        var rings = this._reduced ? 1 : (scale < 1 ? 1 : RINGS);
        var dur = this._reduced ? 900 : P.pulse * (scale < 1 ? 0.6 : 1);
        this._push({
            kind: 'pulse', ll: [Number(n.lat), Number(n.lon)], color: color, t0: now,
            r: (14 + 30 * s) * scale, rings: rings, dur: dur, gap: P.gap,
            total: dur + (rings - 1) * P.gap
        });
    };

    LivePulse.prototype._addArc = function (a, b, color, delay, dashed, now) {
        var P = this._p();
        var travel = this._reduced ? 1 : TRAVEL_MS;
        this._push({
            kind: 'arc', a: [Number(a.lat), Number(a.lon)], b: [Number(b.lat), Number(b.lon)],
            color: color, t0: now + delay, travel: travel, fade: P.fade, dashed: dashed,
            total: travel + P.fade
        });
        if (!dashed) {
            var key = a.id + '>' + b.id;
            var e = this.heat[key];
            var h = e ? e.h * Math.pow(0.5, (now - e.t) / P.heat) : 0;
            this.heat[key] = {a: [Number(a.lat), Number(a.lon)], b: [Number(b.lat), Number(b.lon)],
                              h: Math.min(HEAT_MAX, h + 1), t: now, color: color};
        }
    };

    // ── drawing ─────────────────────────────────────────────────────────

    LivePulse.prototype._kick = function () {
        if (!this.active || this.raf) return;
        if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
        var self = this;
        this.raf = requestAnimationFrame(function () { self.raf = null; self._frame(); });
    };

    LivePulse.prototype._frame = function () {
        if (!this.active) return;
        var now = Date.now();
        this.anims = this.anims.filter(function (a) { return now < a.t0 + a.total; });
        var glowing = this._decayHeat(now);
        this._draw(now);
        if (this.anims.length) {
            this._kick();
        } else if (glowing) {
            var self = this;
            this._idleTimer = setTimeout(function () { self._idleTimer = null; self._kick(); }, IDLE_FRAME_MS);
        }
    };

    // Afterglows (links and senders) fade on their own; returns how many are
    // still visible, so the loop knows whether to keep running.
    LivePulse.prototype._decayHeat = function (now) {
        var n = 0, P = this._p();
        for (var k in this.heat) {
            if (!Object.prototype.hasOwnProperty.call(this.heat, k)) continue;
            var e = this.heat[k];
            e.cur = e.h * Math.pow(0.5, (now - e.t) / P.heat);
            if (e.cur < HEAT_MIN) delete this.heat[k]; else n++;
        }
        for (var id in this.glow) {
            if (!Object.prototype.hasOwnProperty.call(this.glow, id)) continue;
            var g = this.glow[id];
            g.cur = P.glow ? 1 - (now - g.t) / P.glow : 0;
            if (g.cur <= 0) delete this.glow[id]; else n++;
        }
        return n;
    };

    LivePulse.prototype._resize = function () {
        if (!this.canvas || !this.map) return;
        var size = this.map.getSize();
        this.dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.round(size.x * this.dpr);
        this.canvas.height = Math.round(size.y * this.dpr);
        this.canvas.style.width = size.x + 'px';
        this.canvas.style.height = size.y + 'px';
    };

    function ctrl(p0, p1) {
        // A gentle bend, always to the same side for the same direction.
        var mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
        return {x: mx - (p1.y - p0.y) * 0.18, y: my + (p1.x - p0.x) * 0.18};
    }

    function bez(p0, c, p1, t) {
        var u = 1 - t;
        return {x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
                y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y};
    }

    function strokeCurve(ctx, p0, c, p1, upto) {
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        var steps = 24;
        for (var i = 1; i <= steps; i++) {
            var q = bez(p0, c, p1, upto * i / steps);
            ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
    }

    LivePulse.prototype._draw = function (now) {
        var ctx = this.ctx, map = this.map;
        if (!ctx || !map) return;
        // The canvas lives in a map pane, which Leaflet moves while panning:
        // pin it to the top-left corner of the view and draw in view pixels.
        L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0]));
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';

        var size = map.getSize(), margin = 80;
        function onScreen(p) {
            return p.x > -margin && p.y > -margin && p.x < size.x + margin && p.y < size.y + margin;
        }
        function pt(ll) { return map.latLngToContainerPoint(ll); }

        // Afterglow of links that carried traffic: a cheap, shadowless line.
        ctx.shadowBlur = 0;
        ctx.setLineDash([]);
        for (var k in this.heat) {
            if (!Object.prototype.hasOwnProperty.call(this.heat, k)) continue;
            var e = this.heat[k];
            var h0 = pt(e.a), h1 = pt(e.b);
            if (!onScreen(h0) && !onScreen(h1)) continue;
            ctx.strokeStyle = rgba(e.color, Math.min(0.42, 0.07 * e.cur));
            ctx.lineWidth = 1 + e.cur * 0.7;
            strokeCurve(ctx, h0, ctrl(h0, h1), h1, 1);
        }

        // Afterglow of senders: a soft halo under the marker, fading over the
        // persistence time. A gradient, not a shadow, so it costs very little.
        for (var gid in this.glow) {
            if (!Object.prototype.hasOwnProperty.call(this.glow, gid)) continue;
            var g = this.glow[gid];
            var gp = pt(g.ll);
            if (!onScreen(gp)) continue;
            // The marker covers the middle, so the halo has to reach past it.
            var ga = 0.9 * Math.pow(g.cur, 1.2);
            var grad = ctx.createRadialGradient(gp.x, gp.y, 4, gp.x, gp.y, GLOW_R);
            grad.addColorStop(0, rgba(g.color, ga));
            grad.addColorStop(0.4, rgba(g.color, ga * 0.6));
            grad.addColorStop(1, rgba(g.color, 0));
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(gp.x, gp.y, GLOW_R, 0, Math.PI * 2);
            ctx.fill();
        }

        for (var i = 0; i < this.anims.length; i++) {
            var a = this.anims[i];
            var el = now - a.t0;
            if (el < 0) continue;
            if (a.kind === 'pulse') this._drawPulse(ctx, a, el, pt(a.ll), onScreen);
            else this._drawArc(ctx, a, el, pt(a.a), pt(a.b), onScreen);
        }
        ctx.shadowBlur = 0;
        ctx.globalCompositeOperation = 'source-over';
    };

    LivePulse.prototype._drawPulse = function (ctx, a, el, p, onScreen) {
        if (!onScreen(p)) return;
        ctx.setLineDash([]);
        ctx.shadowColor = a.color;
        for (var r = 0; r < a.rings; r++) {
            var t = el - r * a.gap;
            if (t < 0 || t > a.dur) continue;
            var q = t / a.dur;
            ctx.shadowBlur = 10;
            ctx.strokeStyle = rgba(a.color, Math.pow(1 - q, 1.5) * (r === 0 ? 0.9 : 0.55));
            ctx.lineWidth = 2.2 * (1 - q) + 0.6;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3 + a.r * easeOut(q), 0, Math.PI * 2);
            ctx.stroke();
        }
        if (el < 450) {
            ctx.shadowBlur = 16;
            ctx.fillStyle = rgba(a.color, 0.95 * (1 - el / 450));
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
            ctx.fill();
        }
    };

    LivePulse.prototype._drawArc = function (ctx, a, el, p0, p1, onScreen) {
        if (!onScreen(p0) && !onScreen(p1)) return;
        var c = ctrl(p0, p1);
        var prog = Math.min(1, el / a.travel);
        var e = easeInOut(prog);
        var fade = el <= a.travel ? 1 : Math.max(0, 1 - (el - a.travel) / a.fade);

        ctx.shadowColor = a.color;
        if (a.dashed) {
            // The hops before the relay are not known: a faint dashed hint.
            ctx.shadowBlur = 0;
            ctx.setLineDash([3, 6]);
            ctx.strokeStyle = rgba(a.color, 0.45 * fade);
            ctx.lineWidth = 1.2;
            strokeCurve(ctx, p0, c, p1, e);
            ctx.setLineDash([]);
        } else {
            ctx.shadowBlur = 8;
            ctx.strokeStyle = rgba(a.color, 0.6 * fade);
            ctx.lineWidth = 2;
            strokeCurve(ctx, p0, c, p1, e);
        }

        if (prog < 1) {
            var head = bez(p0, c, p1, e);
            ctx.shadowBlur = 14;
            ctx.fillStyle = rgba(a.color, a.dashed ? 0.6 : 1);
            ctx.beginPath();
            ctx.arc(head.x, head.y, a.dashed ? 2.2 : 3.4, 0, Math.PI * 2);
            ctx.fill();
        } else if (!a.dashed) {
            // Arrival: a small ring where it landed.
            var q = (el - a.travel) / a.fade;
            ctx.shadowBlur = 10;
            ctx.strokeStyle = rgba(a.color, 0.8 * (1 - q));
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.arc(p1.x, p1.y, 4 + 14 * easeOut(q), 0, Math.PI * 2);
            ctx.stroke();
        }
    };

    // ── dark map ────────────────────────────────────────────────────────

    LivePulse.prototype._applyDark = function () {
        var pane = this.map && this.map.getPane('tilePane');
        if (!pane) return;
        var want = this.active && this.dark;
        if (want) {
            if (this._tileFilter === null) this._tileFilter = pane.style.filter || '';
            pane.style.filter = DARK_FILTER;
        } else if (this._tileFilter !== null) {
            pane.style.filter = this._tileFilter;
            this._tileFilter = null;
        }
    };

    // ── panel ───────────────────────────────────────────────────────────

    LivePulse.prototype._buildPanel = function (isActive, isDark, persist) {
        var el = document.createElement('div');
        el.className = 'live-pulse-panel';
        var legend = CAT_ORDER.map(function (k) {
            return '<span class="lp-key"><i style="background:' + CATS[k].color + '"></i>' + CATS[k].label + '</span>';
        }).join('');
        el.innerHTML =
            '<label class="lp-toggle">' +
                '<input type="checkbox" class="lp-enable"' + (isActive ? ' checked' : '') + '>' +
                '<span>⚡ Live Pulse</span>' +
            '</label>' +
            '<div class="lp-body"' + (isActive ? '' : ' style="display:none"') + '>' +
                '<label class="lp-toggle lp-sub">' +
                    '<input type="checkbox" class="lp-dark"' + (isDark ? ' checked' : '') + '>' +
                    '<span>Dark map</span>' +
                '</label>' +
                '<div class="lp-persist" role="group" aria-label="Persistence">' +
                    '<span class="lp-persist-label">Persistence</span>' +
                    PERSIST_ORDER.map(function (k) {
                        return '<button type="button" data-persist="' + k + '"' +
                            (k === persist ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' +
                            k.charAt(0).toUpperCase() + k.slice(1) + '</button>';
                    }).join('') +
                '</div>' +
                '<div class="lp-stats">Listening…</div>' +
                '<div class="lp-note" style="display:none"></div>' +
                '<div class="lp-recent"></div>' +
                '<div class="lp-legend">' + legend + '</div>' +
            '</div>';
        return el;
    };

    LivePulse.prototype._wirePanel = function () {
        var self = this, el = this._control;
        el.querySelector('.lp-enable').addEventListener('change', function (e) {
            try { localStorage.setItem(self._keys.active, e.target.checked); } catch (err) {}
            self._setActive(e.target.checked);
        });
        el.querySelector('.lp-dark').addEventListener('change', function (e) {
            self.dark = e.target.checked;
            try { localStorage.setItem(self._keys.dark, self.dark); } catch (err) {}
            self._applyDark();
        });
        Array.prototype.forEach.call(el.querySelectorAll('.lp-persist button'), function (btn) {
            btn.addEventListener('click', function () {
                self.persist = btn.dataset.persist;
                try { localStorage.setItem(self._keys.persist, self.persist); } catch (err) {}
                Array.prototype.forEach.call(el.querySelectorAll('.lp-persist button'), function (b) {
                    var on = b === btn;
                    b.classList.toggle('on', on);
                    b.setAttribute('aria-pressed', on ? 'true' : 'false');
                });
                if (!self._p().glow) self.glow = {};
                self._kick();
            });
        });
        el.querySelector('.lp-recent').addEventListener('click', function (e) {
            var row = e.target.closest('.lp-row');
            if (!row || !self.map || row.dataset.lat === '') return;
            self.map.panTo([Number(row.dataset.lat), Number(row.dataset.lon)]);
        });
    };

    LivePulse.prototype._renderStats = function () {
        if (!this._control) return;
        var now = Date.now();
        this.minute = this.minute.filter(function (m) { return now - m.t < 60000; });
        var talking = {};
        this.minute.forEach(function (m) { talking[m.id] = true; });
        var n = this.minute.length, who = Object.keys(talking).length;
        var stats = this._control.querySelector('.lp-stats');
        if (stats) {
            stats.textContent = n
                ? n + (n === 1 ? ' packet' : ' packets') + ' in the last minute, from ' + who + (who === 1 ? ' node' : ' nodes')
                : 'Listening… nothing heard in the last minute';
        }

        var note = this._control.querySelector('.lp-note');
        if (note && this.api) {
            var idx = this._nodeIndex();
            var noArcs = this._cfg().arcs && !hasPos(idx.tracker);
            note.style.display = noArcs ? '' : 'none';
            note.textContent = noArcs ? 'Your node has no position on the map, so only pulses, no arcs.' : '';
        }

        // Node names come from the air: textContent only, never innerHTML.
        var box = this._control.querySelector('.lp-recent');
        if (!box) return;
        box.textContent = '';
        this.recent.forEach(function (r) {
            var row = document.createElement('div');
            row.className = 'lp-row';
            row.dataset.lat = r.lat === null ? '' : r.lat;
            row.dataset.lon = r.lon === null ? '' : r.lon;
            if (r.lat !== null) row.title = 'Show on map';
            var dot = document.createElement('i');
            dot.style.background = CATS[r.cat].color;
            var name = document.createElement('span');
            name.className = 'lp-name';
            name.textContent = r.name;
            var meta = document.createElement('span');
            meta.className = 'lp-meta';
            meta.textContent = r.port + (r.route ? ', ' + r.route : '') + ' · ' + ago(now - r.t);
            row.appendChild(dot);
            row.appendChild(name);
            row.appendChild(meta);
            box.appendChild(row);
        });
    };

    // ── lifecycle ───────────────────────────────────────────────────────

    LivePulse.prototype._setActive = function (on) {
        this.active = on;
        var body = this._control && this._control.querySelector('.lp-body');
        if (body) body.style.display = on ? '' : 'none';
        if (!on) {
            if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
            if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
            this.anims = [];
            this.heat = {};
            this.glow = {};
            if (this.ctx) {
                this.ctx.setTransform(1, 0, 0, 1, 0, 0);
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            }
        } else {
            this._resize();
            this._renderStats();
        }
        this._applyDark();
    };

    LivePulse.prototype.onEnable = function (api) {
        this.api = api;
        this.map = api.map.getLeafletMap();
        this._keys = {
            active: 'plugin:' + api.info.id + ':active',
            dark: 'plugin:' + api.info.id + ':dark',
            persist: 'plugin:' + api.info.id + ':persist'
        };
        this._reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        var cfg = this._cfg();

        var savedActive = null, savedDark = null, savedPersist = null;
        try {
            savedActive = localStorage.getItem(this._keys.active);
            savedDark = localStorage.getItem(this._keys.dark);
            savedPersist = localStorage.getItem(this._keys.persist);
        } catch (e) {}
        var isActive = savedActive !== null ? savedActive === 'true' : cfg.defaultEnabled;
        this.dark = savedDark !== null ? savedDark === 'true' : cfg.darkMap;
        this.persist = PERSIST[savedPersist] ? savedPersist : cfg.persistence;

        this._control = this._buildPanel(isActive, this.dark, this.persist);
        this._wirePanel();
        if (api.panels && api.panels.register) api.panels.register(this._control);
        else api.map.addControl('live-pulse', this._control, 'topleft');

        if (!api.packets) {
            var stats = this._control.querySelector('.lp-stats');
            if (stats) stats.textContent = 'Needs MeshPulse 2.9.3 or newer.';
            return;
        }

        if (!this.map.getPane(PANE)) {
            // Above the node lines (overlay pane, 400), below the markers (600)
            // and the popups (700).
            var pane = this.map.createPane(PANE);
            pane.style.zIndex = 450;
            pane.style.pointerEvents = 'none';
        }
        this.canvas = document.createElement('canvas');
        // leaflet-zoom-hide: Leaflet hides it during the zoom animation, when
        // the panes are scaled and the canvas would be off by the zoom factor.
        this.canvas.className = 'live-pulse-canvas leaflet-zoom-hide';
        this.map.getPane(PANE).appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');

        var self = this;
        this._mapHandlers = {
            resize: function () { self._resize(); self._kick(); },
            moveend: function () { self._kick(); },
            zoomend: function () { self._kick(); }
        };
        this.map.on(this._mapHandlers);
        this._visibilityHandler = function () { if (!document.hidden) { self.anims = []; self._kick(); } };
        document.addEventListener('visibilitychange', this._visibilityHandler);

        api.packets.onPacket(function (p) { self._onPacket(p); });
        if (api.nodes.onUpdate) api.nodes.onUpdate(function () { self.nodesAt = 0; });
        if (api.nodes.onFilterChange) api.nodes.onFilterChange(function () { self.nodesAt = 0; });
        this._statsTimer = setInterval(function () { if (self.active) self._renderStats(); }, 5000);

        this._setActive(isActive);
    };

    LivePulse.prototype.onConfigUpdate = function () {
        this.nodesAt = 0;
        this._renderStats();
    };

    LivePulse.prototype.onDisable = function (api) {
        this._setActive(false);
        if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
        if (this._mapHandlers && this.map) this.map.off(this._mapHandlers);
        this._mapHandlers = null;
        if (this._visibilityHandler) {
            document.removeEventListener('visibilitychange', this._visibilityHandler);
            this._visibilityHandler = null;
        }
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        this.canvas = null;
        this.ctx = null;
        if (this._control) {
            if (api.panels && api.panels.unregister) api.panels.unregister(this._control);
            else api.map.removeControl('live-pulse');
            this._control = null;
        }
        try {
            if (this._keys.active) localStorage.removeItem(this._keys.active);
            if (this._keys.dark) localStorage.removeItem(this._keys.dark);
            if (this._keys.persist) localStorage.removeItem(this._keys.persist);
        } catch (e) {}
        this.recent = [];
        this.minute = [];
        this.api = null;
        this.map = null;
    };

    return LivePulse;
})();

window.MeshPlugin = LivePulsePlugin;
