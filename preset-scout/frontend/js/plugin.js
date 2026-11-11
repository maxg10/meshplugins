// Preset Scout Plugin for MeshPulse
// Copyright (C) 2026 Mariusz "Max" Gieparda
// Licensed under GPL-3.0
//
// Which LoRa presets does the mesh around here use? The core (2.9.5+) moves
// the radio through the presets picked here, listen-only, counts what it hears
// on each and puts the radio back. This side picks, shows progress, and turns
// the results into a table, a recommendation and dots on the map.

var PresetScoutPlugin = (function () {

    var PANE = 'presetScoutPane';
    var LAYER = 'preset-scout';
    var DWELLS = [120, 300, 600, 900];          // seconds per preset
    // Measured on a Tracker L1: every settings write is CLI, reboot, reconnect,
    // config read and 20 s of a stable link. Putting LoRa and MQTT back is two writes.
    var SWITCH_S = 100;
    var MQTT_S = 100;
    var COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb923c', '#2dd4bf', '#f87171', '#818cf8'];
    var NICE = {
        LONG_FAST: 'LongFast', LONG_SLOW: 'LongSlow', LONG_MODERATE: 'LongModerate', MEDIUM_SLOW: 'MediumSlow',
        MEDIUM_FAST: 'MediumFast', SHORT_SLOW: 'ShortSlow', SHORT_FAST: 'ShortFast', SHORT_TURBO: 'ShortTurbo',
        LONG_TURBO: 'LongTurbo', VERY_LONG_SLOW: 'VeryLongSlow'
    };

    function Scout() {
        this.api = null;
        this.map = null;
        this.panel = null;
        this.layer = null;
        this.state = null;          // last preset_scan_status
        this.options = null;        // what the radio can scan
        this.picked = null;         // preset -> true
        this.dwell = 300;
        this.confirming = false;
        this.history = [];          // finished scans, without node lists
        this.shown = null;          // full record of the scan shown in the table
        this.mapPreset = null;      // preset whose nodes are on the map
        this.msg = null;
        this.tick = null;
    }

    // ── helpers ─────────────────────────────────────────────────────────

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function nice(p) { return NICE[p] || p; }

    function mins(s) { return Math.round(s / 60) + ' min'; }

    function clock(s) {
        s = Math.max(0, Math.round(s));
        return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    }

    // The radio's own counters for one preset. With nothing received at all
    // there is no percentage, but "0 rx" is the strongest sign the air was silent.
    function okCell(r) {
        if (!r) return '-';
        if (r.success_pct !== null && r.success_pct !== undefined) return r.success_pct + '%';
        if (!r.rx && !r.bad) {
            return '<span title="The radio received nothing at all on this preset, not even damaged packets">0 rx</span>';
        }
        return '-';
    }

    function when(ts) {
        // "Nov 10, 22:51" in the browser's own language: 10.11 reads as October in the US.
        var d = new Date(ts * 1000);
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' +
               ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }

    function pct(v) { return v === null || v === undefined ? '-' : (Math.round(v * 10) / 10) + '%'; }

    Scout.prototype._store = function (k, v) {
        try { if (this.api.storage) this.api.storage.set(k, v); } catch (e) {}
    };

    Scout.prototype._load = function (k, d) {
        try { var v = this.api.storage ? this.api.storage.get(k) : null; return v === null || v === undefined ? d : v; }
        catch (e) { return d; }
    };

    // The preset that heard the most nodes; with a tie, the one that heard
    // more of them directly. Returns null when nothing was heard at all.
    function best(steps) {
        var b = null;
        (steps || []).forEach(function (st) {
            if (!st.nodes) return;
            if (!b || st.nodes > b.nodes || (st.nodes === b.nodes && st.direct > b.direct)) b = st;
        });
        return b;
    }

    // ── messages from the core ──────────────────────────────────────────

    Scout.prototype._onMessage = function (m) {
        if (!m) return;
        if (m.type === 'preset_scan_status') {
            var was = this.state && this.state.active;
            this.state = m;
            if (m.options) {
                this.options = m.options;
                if (!this.picked) this._defaultPick();
            }
            if (was && !m.active) {
                // Just finished: load it in full and show it.
                this.api.presetScan.history();
                if (m.id) this.api.presetScan.history(m.id);
            }
            this._render();
        } else if (m.type === 'preset_scan_result') {
            this.confirming = false;
            this.msg = m.ok ? null : (m.error || 'The scan could not start.');
            this._render();
        } else if (m.type === 'preset_scans') {
            if (m.id) {
                if (m.scans && m.scans[0]) {
                    this.shown = m.scans[0];
                    if (this.mapPreset) this._draw();
                }
            } else {
                this.history = m.scans || [];
                if (!this.shown && this.history[0]) this.api.presetScan.history(this.history[0].id);
            }
            this._render();
        }
    };

    Scout.prototype._defaultPick = function () {
        var saved = null;
        try { saved = JSON.parse(this._load('picked', 'null')); } catch (e) {}
        this.picked = {};
        var self = this;
        (this.options.presets || []).forEach(function (p) {
            self.picked[p] = saved ? !!saved[p] : true;
        });
    };

    // ── panel ───────────────────────────────────────────────────────────

    Scout.prototype._render = function () {
        if (!this.panel) return;
        var box = this.panel.querySelector('.ps-content');
        var st = this.state, opt = this.options, h = '';
        if (!this.api.presetScan) {
            box.innerHTML = '<div class="ps-error">Needs MeshPulse 2.9.5 or newer.</div>';
            return;
        }
        if (st && st.active) h += this._renderRunning(st);
        else h += this._renderSetup(opt);
        if (this.msg) h += '<div class="ps-error">' + esc(this.msg) + '</div>';
        h += this._renderResults();
        h += this._renderHistory();
        box.innerHTML = h;
    };

    Scout.prototype._renderSetup = function (opt) {
        if (!opt) return '<div class="ps-dim">Asking the radio…</div>';
        if (opt.problem) return '<div class="ps-error">' + esc(opt.problem) + '</div>';
        var self = this, h = '';
        h += '<div class="ps-dim">Radio on <b>' + esc(nice(opt.current)) + '</b> · ' + esc(opt.region) + '</div>';
        h += '<div class="ps-presets">' + (opt.presets || []).map(function (p) {
            return '<label class="ps-preset' + (p === opt.current ? ' ps-own' : '') + '"><input type="checkbox" data-p="' + p + '"' +
                   (self.picked && self.picked[p] ? ' checked' : '') + '> ' + esc(nice(p)) +
                   (p === opt.current ? ' <span class="ps-tag">yours</span>' : '') + '</label>';
        }).join('') + '</div>';
        h += '<div class="ps-row"><span class="ps-label">Each</span>' + DWELLS.map(function (d) {
            return '<button class="ps-chip ps-dwell' + (d === self.dwell ? ' ps-on' : '') + '" data-v="' + d + '">' + mins(d) + '</button>';
        }).join('') + '</div>';
        var n = this._pickedList().length;
        var mqtt = !!(opt && opt.mqtt_enabled);
        var total = n * (this.dwell + SWITCH_S) + SWITCH_S + (mqtt ? 2 * MQTT_S : 0);
        if (this.dwell < 900) {
            h += '<div class="ps-dim">Short times hear mostly relayed traffic: nodes in direct range often send only every ' +
                 '15 to 60 minutes, so <b>Direct</b> comes out low. Received, bad and duplicate packet counts come from ' +
                 'the radio every 15 minutes, so they only appear with 15 min per preset.</div>';
        }
        if (this.confirming) {
            h += '<div class="ps-warn">For about <b>' + mins(total) + '</b> your radio leaves ' + esc(nice(opt.current)) +
                 ' and only listens: nothing is relayed or sent, MQTT on the radio is off, and the map waits. ' +
                 'Afterwards everything is put back as it was.</div>' +
                 '<div class="ps-row"><button class="ps-btn ps-go">Start the scan</button>' +
                 '<button class="ps-btn ps-ghost ps-cancel">Cancel</button></div>';
        } else {
            h += '<div class="ps-row"><button class="ps-btn ps-ask"' + (n ? '' : ' disabled') + '>Scan ' + n +
                 (n === 1 ? ' preset' : ' presets') + ' · about ' + mins(total) + '</button></div>';
        }
        return h;
    };

    Scout.prototype._renderRunning = function (st) {
        var n = (st.presets || []).length, i = Math.max(1, (st.idx || 0) + 1), h = '';
        var skew = st._skew || 0;
        var label = {
            starting: 'Starting…',
            switching: st.current === 'MQTT off' ? 'Turning MQTT off on the radio…' : 'Switching to ' + nice(st.current) + '…',
            reconnecting: 'The radio went quiet, reconnecting. This preset gets the lost time back…',
            restoring: 'Putting the radio back on ' + nice(st.original_preset) + '…',
            restore_retry: 'Could not put the radio back yet, retrying…'
        }[st.status];
        if (st.status === 'listening') {
            var left = st.step_started + st.dwell_s - (Date.now() / 1000 - skew);
            label = 'Listening on <b>' + esc(nice(st.current)) + '</b>, ' + clock(left) + ' left';
        }
        h += '<div class="ps-run">' + (label || esc(st.status)) + '</div>';
        h += '<div class="ps-bar"><i style="width:' + Math.round(100 * Math.min(n, (st.steps || []).length) / Math.max(1, n)) + '%"></i></div>';
        h += '<div class="ps-dim">Preset ' + Math.min(i, n) + ' of ' + n + '</div>';
        var live = st.live;
        if (live) {
            h += '<div class="ps-live">' + live.nodes + ' nodes so far (' + live.direct + ' direct, ' + live.mesh + ' via mesh), ' +
                 live.packets + ' packets' + (live.channel_util !== null ? ', channel ' + pct(live.channel_util) : '') + '</div>';
        }
        if (st.error) h += '<div class="ps-error">' + esc(st.error) + '</div>';
        if (st.status === 'listening' || st.status === 'switching' || st.status === 'reconnecting') {
            h += '<div class="ps-row"><button class="ps-btn ps-ghost ps-stop">Stop and put the radio back</button></div>';
        }
        if ((st.steps || []).length) h += this._table(st.steps, st.original_preset, false);
        return h;
    };

    Scout.prototype._table = function (steps, own, clickable) {
        var b = best(steps), self = this;
        var rf = steps.some(function (s) { return s.rf; });
        var h = '<table class="ps-table"><tr><th>Preset</th><th title="Nodes heard">Nodes</th><th title="Heard directly">Direct</th>' +
                '<th title="Only through a relay">Mesh</th><th title="Channel utilization">Ch.</th>' + (rf ? '<th title="Received without CRC errors">OK</th>' : '') + '</tr>';
        steps.forEach(function (s, i) {
            var cls = (b && s === b ? ' ps-best' : '') + (clickable ? ' ps-click' : '') + (self.mapPreset === s.preset && clickable ? ' ps-onmap' : '');
            h += '<tr class="' + cls + '" data-p="' + esc(s.preset) + '"><td><i class="ps-dot" style="background:' + COLORS[i % COLORS.length] + '"></i>' +
                 esc(nice(s.preset)) + (s.preset === own ? ' <span class="ps-tag">yours</span>' : '') +
                 (s.link_lost ? ' <span class="ps-tag ps-tag-warn" title="The radio link dropped ' + s.link_lost +
                  (s.link_lost === 1 ? ' time' : ' times') + ' on this preset (' + (s.link_lost_s || 0) +
                  ' s). The time was added back, but treat this row with care.">link</span>' : '') +
                 '</td><td>' + s.nodes + '</td><td>' + s.direct +
                 '</td><td>' + s.mesh + '</td><td>' + pct(s.channel_util) + '</td>' +
                 (rf ? '<td>' + okCell(s.rf) + '</td>' : '') + '</tr>';
        });
        return h + '</table>';
    };

    Scout.prototype._renderResults = function () {
        var sc = this.shown;
        if (!sc || (this.state && this.state.active)) return '';
        var h = '<div class="ps-sep"></div><div class="ps-head2">Scan of ' + when(sc.started) +
                (sc.status !== 'done' ? ' <span class="ps-tag ps-tag-warn">' + esc(sc.status) + '</span>' : '') + '</div>';
        if (!sc.steps || !sc.steps.length) return h + '<div class="ps-dim">No preset finished in this scan.</div>';
        h += this._table(sc.steps, sc.original_preset, true);
        var b = best(sc.steps);
        if (!b) {
            h += '<div class="ps-rec">Nothing was heard on any of these presets.</div>';
        } else if (b.preset === sc.original_preset) {
            h += '<div class="ps-rec">Most nodes on <b>' + esc(nice(b.preset)) + '</b>, the preset you already use (' + b.nodes + ' nodes, ' +
                 b.direct + ' heard directly).</div>';
        } else {
            h += '<div class="ps-rec">Most nodes on <b>' + esc(nice(b.preset)) + '</b>: ' + b.nodes + ' nodes, ' + b.direct +
                 ' heard directly. You are on ' + esc(nice(sc.original_preset)) + '.</div>';
        }
        // How long each preset was really heard: a short scan undercounts nodes in direct range.
        var heard = sc.steps.map(function (s) { return (s.ended || 0) - (s.started || 0); }).filter(function (x) { return x > 0; });
        var shortest = heard.length ? Math.min.apply(null, heard) : 0;
        if (shortest && shortest < 900) {
            h += '<div class="ps-dim">' + mins(shortest) + ' per preset: <b>Direct</b> is only a sample here, since nodes in direct range ' +
                 'often send every 15 to 60 minutes. A longer scan finds more of them.</div>';
        }
        h += '<div class="ps-dim">Click a preset to put its nodes on the map' + (this.mapPreset ? ', again to hide them' : '') + '.</div>';
        if (sc.error && sc.status !== 'done') h += '<div class="ps-dim">' + esc(sc.error) + '</div>';
        return h;
    };

    Scout.prototype._renderHistory = function () {
        if (this.history.length < 2 || (this.state && this.state.active)) return '';
        var self = this;
        return '<div class="ps-sep"></div><div class="ps-head2">Earlier scans</div><div class="ps-hist">' +
            this.history.slice(0, 8).map(function (r) {
                var b = best(r.steps), k = (r.steps || []).length;
                var what = r.status !== 'done' ? r.status : (b ? 'best ' + nice(b.preset) : 'nothing heard');
                return '<button class="ps-histrow' + (self.shown && self.shown.id === r.id ? ' ps-on' : '') + '" data-id="' + esc(r.id) + '">' +
                       when(r.started) + ' · ' + k + (k === 1 ? ' preset' : ' presets') + ' · ' + esc(what) + '</button>';
            }).join('') + '</div>';
    };

    Scout.prototype._pickedList = function () {
        var self = this;
        return ((this.options && this.options.presets) || []).filter(function (p) { return self.picked && self.picked[p]; });
    };

    Scout.prototype._wire = function () {
        var self = this, api = this.api;
        this.panel.addEventListener('change', function (e) {
            var p = e.target.getAttribute && e.target.getAttribute('data-p');
            if (p && self.picked) {
                self.picked[p] = e.target.checked;
                self._store('picked', JSON.stringify(self.picked));
                self.confirming = false;
                self._render();
            }
        });
        this.panel.addEventListener('click', function (e) {
            var t = e.target.closest('button, tr.ps-click');
            if (!t || !self.panel.contains(t)) return;
            if (t.classList.contains('ps-dwell')) { self.dwell = Number(t.getAttribute('data-v')); self._store('dwell', String(self.dwell)); self.confirming = false; }
            else if (t.classList.contains('ps-ask')) { self.confirming = true; self.msg = null; }
            else if (t.classList.contains('ps-cancel')) { self.confirming = false; }
            else if (t.classList.contains('ps-go')) { self.msg = null; api.presetScan.start(self._pickedList(), self.dwell); }
            else if (t.classList.contains('ps-stop')) { api.presetScan.stop(); }
            else if (t.classList.contains('ps-histrow')) { self.mapPreset = null; self._clearMap(); api.presetScan.history(t.getAttribute('data-id')); }
            else if (t.classList.contains('ps-click')) {
                var p = t.getAttribute('data-p');
                self.mapPreset = self.mapPreset === p ? null : p;
                self._draw();
            }
            self._render();
        });
        if (window.L && L.DomEvent) {
            L.DomEvent.disableClickPropagation(this.panel);
            L.DomEvent.disableScrollPropagation(this.panel);
        }
    };

    // ── map ─────────────────────────────────────────────────────────────

    Scout.prototype._clearMap = function () {
        if (this.api && this.api.map.hasLayer(LAYER)) this.api.map.removeLayer(LAYER);
        this.layer = null;
    };

    // Nodes heard on one preset: filled when heard directly, hollow when only
    // through the mesh. Position from the scan itself, else what the map knows.
    Scout.prototype._draw = function () {
        this._clearMap();
        var sc = this.shown;
        if (!this.mapPreset || !sc) return;
        var idx = -1, step = null;
        (sc.steps || []).forEach(function (s, i) { if (s.preset === this.mapPreset) { idx = i; step = s; } }, this);
        if (!step || !step.node_list) return;
        var color = COLORS[idx % COLORS.length], layer = L.layerGroup(), pts = [], api = this.api;
        step.node_list.forEach(function (n) {
            var lat = n.lat, lon = n.lon, fromMap = n.pos === 'map';
            if ((lat === null || lat === undefined) && api.nodes && api.nodes.get) {
                var k = api.nodes.get(n.id);
                if (k && k.lat && k.lon) { lat = k.lat; lon = k.lon; fromMap = true; }
            }
            if (lat === null || lat === undefined || lon === null || lon === undefined) return;
            var direct = n.direct > 0;
            var m = L.circleMarker([lat, lon], {pane: PANE, radius: direct ? 7 : 6, color: color, weight: 2.5,
                                                fill: direct, fillColor: color, fillOpacity: 0.85});
            m.bindPopup('<b>' + esc(n.name) + '</b><br>' + esc(nice(step.preset)) + ': ' + n.n + ' packets, ' +
                        (direct ? n.direct + ' direct' + (n.snr !== null ? ', SNR ' + n.snr + ' dB' : '') : 'only via mesh' +
                        (n.hops_min !== null ? ' (' + n.hops_min + (n.hops_min === 1 ? ' hop)' : ' hops)') : '')) +
                        (fromMap ? '<br><span class="ps-dim">No position heard in the scan: last known position on the map.</span>' : ''));
            layer.addLayer(m);
            pts.push([lat, lon]);
        });
        this.layer = layer;
        this.api.map.addLayer(LAYER, layer);
        if (pts.length) this.map.fitBounds(pts, {padding: [40, 40], maxZoom: 12});
    };

    // ── lifecycle ───────────────────────────────────────────────────────

    Scout.prototype.onEnable = function (api) {
        var self = this;
        this.api = api;
        this.map = api.map.getLeafletMap();
        if (!this.map.getPane(PANE)) {
            var pane = this.map.createPane(PANE);
            pane.style.zIndex = 620;            // above the markers: these dots are the point while shown
        }
        var d = Number(this._load('dwell', this.dwell));
        if (DWELLS.indexOf(d) >= 0) this.dwell = d;

        var panel = document.createElement('div');
        panel.className = 'leaflet-control ps-panel';
        panel.innerHTML = '<div class="ps-head">📡 Preset Scout</div><div class="ps-content"></div>';
        this.panel = panel;
        this._wire();
        if (api.panels && api.panels.register) api.panels.register(panel);
        else api.map.addControl('preset-scout', panel, 'topleft');

        if (!api.presetScan) { this._render(); return; }
        api.presetScan.onMessage(function (m) {
            if (m && m.type === 'preset_scan_status' && m.now) m._skew = Date.now() / 1000 - m.now;
            self._onMessage(m);
        });
        api.presetScan.refresh();
        api.presetScan.history();
        // The countdown moves between status messages.
        this.tick = setInterval(function () { if (self.state && self.state.active) self._render(); }, 1000);
        this._render();
    };

    Scout.prototype.onDisable = function (api) {
        clearInterval(this.tick);
        this._clearMap();
        if (this.panel) {
            if (api.panels && api.panels.unregister) api.panels.unregister(this.panel);
            else api.map.removeControl('preset-scout');
            this.panel = null;
        }
        this.api = null;
        this.map = null;
    };

    return Scout;
})();

window.MeshPlugin = PresetScoutPlugin;
