// Footprint Plugin for MeshPulse
// Copyright (C) 2026 Mariusz "Max" Gieparda
// Licensed under GPL-3.0
//
// Measured coverage: where your radio really hears. The backend folds every
// position packet into a grid; this side asks for the grid and draws it.
//
//   coloured cell  heard straight from there, coloured by median SNR
//   purple cell    only heard through a relay: the mesh carries you there
//
// Only the direction "them -> you" is measured, and the panel says so.

var FootprintPlugin = (function () {

    var CHANNEL = 'footprint';
    var LAYER = 'footprint';
    var PANE = 'footprintPane';
    var SIZES = [100, 250, 500, 1000, 2000, 5000];
    var AUTO = 0;                      // grid follows the zoom
    var MIN_CELL_PX = 10;              // Auto picks the finest grid whose cells are at least this big on screen
    var PERIODS = [7, 30, 0];          // days; 0 = everything kept
    var REFRESH_MS = 300000;           // cells age slowly; a live sample triggers its own refresh
    var SAMPLE_REFRESH_MS = 15000;     // after a live sample, refetch at most this often
    var MESH_ONLY = '#a855f7';
    var LEGEND = [
        [5, '#22c55e', '> 5 dB'],
        [0, '#a3e635', '0 to 5'],
        [-5, '#facc15', '-5 to 0'],
        [-10, '#f97316', '-10 to -5'],
        [-999, '#ef4444', '< -10 dB']
    ];

    function Footprint() {
        this.api = null;
        this.map = null;
        this.panel = null;
        this.layer = null;
        this.on = false;
        this.size = AUTO;              // chosen in the panel: AUTO or metres
        this.grid = 1000;              // what is drawn: metres
        this.period = 30;
        this.outline = false;
        this.meshOnly = true;
        this.data = null;
        this.pending = false;
        this.error = null;
        this.req = 0;
        this.popupReq = 0;
        this.popup = null;
        this.refreshTimer = null;
        this.sampleTimer = null;
        this.lastFetch = 0;
        this.timeout = null;
        this.flashes = [];
        this._reduced = false;
    }

    // ── helpers ─────────────────────────────────────────────────────────

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function now() { return Math.floor(Date.now() / 1000); }

    function colorFor(med) {
        if (med === null || med === undefined) return MESH_ONLY;
        for (var i = 0; i < LEGEND.length; i++) if (med >= LEGEND[i][0]) return LEGEND[i][1];
        return LEGEND[LEGEND.length - 1][1];
    }

    function ago(ts) {
        var s = Math.max(0, now() - ts);
        if (s < 90) return 'just now';
        if (s < 5400) return Math.round(s / 60) + ' min ago';
        if (s < 129600) return Math.round(s / 3600) + ' h ago';
        return Math.round(s / 86400) + ' d ago';
    }

    function fmtSize(m) { return m >= 1000 ? (m / 1000) + ' km' : m + ' m'; }

    function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }

    function dB(v) { return v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + Number(v).toFixed(1) + ' dB'; }

    Footprint.prototype._store = function (key, value) {
        try { if (this.api.storage) this.api.storage.set(key, value); } catch (e) { /* storage is a convenience */ }
    };

    Footprint.prototype._load = function (key, fallback) {
        try {
            var v = this.api.storage ? this.api.storage.get(key) : null;
            return v === null || v === undefined ? fallback : v;
        } catch (e) { return fallback; }
    };

    // ── data ────────────────────────────────────────────────────────────

    Footprint.prototype._fetch = function () {
        if (!this.on || !this.api) return;
        var self = this;
        this.req++;
        this.pending = true;
        this.lastFetch = Date.now();
        this.grid = this._gridFor();
        this.api.ws.send(CHANNEL, {action: 'cells', size: this.grid, days: this.period || 365, req: this.req});
        clearTimeout(this.timeout);
        this.timeout = setTimeout(function () {
            if (!self.pending) return;
            self.pending = false;
            self.error = 'The backend did not answer in 30 s.';
            self._renderPanel();
        }, 30000);
        this._renderPanel();
    };

    // The grid to draw: the one picked, or for Auto the finest one whose
    // cells stay at least MIN_CELL_PX wide at the current zoom.
    Footprint.prototype._gridFor = function () {
        if (this.size !== AUTO) return this.size;
        var c = this.map.getCenter();
        var mpp = 156543.03392 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, this.map.getZoom());
        for (var i = 0; i < SIZES.length; i++) if (SIZES[i] / mpp >= MIN_CELL_PX) return SIZES[i];
        return SIZES[SIZES.length - 1];
    };

    Footprint.prototype._onZoom = function () {
        if (!this.on || this.size !== AUTO) return;
        if (this._gridFor() !== this.grid) this._fetch();
    };

    Footprint.prototype._onMessage = function (msg) {
        if (!msg) return;
        if (msg.type === 'sample') { this._onSample(msg); return; }
        if (msg.action === 'cell') { this._onCell(msg); return; }
        if (msg.action !== 'cells' || (msg.req && msg.req !== this.req)) return;
        clearTimeout(this.timeout);
        this.pending = false;
        if (!msg.ok) {
            this.error = msg.error === 'not-ready' ? 'Footprint is still starting up.' : (msg.error || 'unknown error');
            this._renderPanel();
            return;
        }
        this.error = null;
        this.data = msg;
        this._draw();
        this._renderPanel();
        // While the history import runs, keep asking: the map fills as it goes.
        var imp = msg.info && msg.info.import;
        if (imp === 'running') {
            var self = this;
            clearTimeout(this.sampleTimer);
            this.sampleTimer = setTimeout(function () { self._fetch(); }, 5000);
        }
    };

    // A position just came in straight from its sender: flash the spot, and
    // fetch fresh cells soon (not for every packet, a busy mesh sends many).
    Footprint.prototype._onSample = function (msg) {
        if (!this.on || !this.map) return;
        this._flash(Number(msg.lat), Number(msg.lon), colorFor(msg.snr));
        if (this.sampleTimer) return;
        var self = this;
        var wait = Math.max(2000, SAMPLE_REFRESH_MS - (Date.now() - this.lastFetch));
        this.sampleTimer = setTimeout(function () { self.sampleTimer = null; self._fetch(); }, wait);
    };

    // ── drawing ─────────────────────────────────────────────────────────

    Footprint.prototype._clearMap = function () {
        if (this.api && this.api.map.hasLayer(LAYER)) this.api.map.removeLayer(LAYER);
        this.layer = null;
        if (this.map && this.popup) this.map.closePopup(this.popup);
    };

    Footprint.prototype._draw = function () {
        this._clearMap();
        if (!this.on || !this.data) return;
        var self = this;
        var layer = L.layerGroup();
        var cells = this.data.cells || [];
        for (var i = 0; i < cells.length; i++) {
            var c = cells[i];
            var direct = c.nd > 0;
            if (!direct && !this.meshOnly) continue;
            var color = colorFor(direct ? c.med : null);
            var style = this.outline
                ? {pane: PANE, color: color, weight: 2, opacity: 0.95, fill: false}
                : {pane: PANE, color: color, weight: 0.6, opacity: direct ? 0.8 : 0.5,
                   fillColor: color, fillOpacity: direct ? 0.5 : 0.3};
            var rect = L.rectangle([[c.b[0], c.b[1]], [c.b[2], c.b[3]]], style);
            rect.on('click', (function (cell) {
                return function (e) { L.DomEvent.stopPropagation(e); self._openCell(cell, e.latlng); };
            })(c));
            layer.addLayer(rect);
        }
        this.layer = layer;
        this.api.map.addLayer(LAYER, layer);
    };

    Footprint.prototype._flash = function (lat, lon, color) {
        if (!isFinite(lat) || !isFinite(lon)) return;
        var ring = L.circleMarker([lat, lon], {pane: PANE, radius: 4, color: color, weight: 3,
                                               opacity: 1, fill: false, interactive: false}).addTo(this.map);
        var t0 = performance.now(), dur = this._reduced ? 600 : 2200, self = this;
        var item = {ring: ring, raf: null};
        this.flashes.push(item);
        function step(t) {
            var f = Math.min(1, (t - t0) / dur);
            if (!self._reduced) ring.setRadius(4 + 22 * f);
            ring.setStyle({opacity: 1 - f});
            if (f < 1) item.raf = requestAnimationFrame(step);
            else self._dropFlash(item);
        }
        item.raf = requestAnimationFrame(step);
    };

    Footprint.prototype._dropFlash = function (item) {
        if (item.raf) cancelAnimationFrame(item.raf);
        if (this.map && this.map.hasLayer(item.ring)) this.map.removeLayer(item.ring);
        var i = this.flashes.indexOf(item);
        if (i >= 0) this.flashes.splice(i, 1);
    };

    // ── cell details ────────────────────────────────────────────────────

    Footprint.prototype._openCell = function (cell, latlng) {
        var head = cell.nd
            ? '<b>Heard directly</b> · median ' + dB(cell.med) + ' · best ' + dB(cell.best) +
              (cell.rssi !== null && cell.rssi !== undefined ? ' · ' + cell.rssi + ' dBm' : '')
            : '<b style="color:' + MESH_ONLY + '">Mesh only</b>: heard here only through a relay';
        // Kept so the answer can rebuild the whole popup: Leaflet re-renders a
        // popup from its content string, so editing its DOM would not stick.
        this._popHead = '<div class="fp-pop"><div>' + head + '</div>' +
            '<div class="fp-dim">' + fmtNum(cell.nd) + ' direct, ' + fmtNum(cell.nr) + ' relayed · ' +
            cell.nodes + (cell.nodes === 1 ? ' node' : ' nodes') + ' · last ' + ago(cell.last) + '</div>';
        this.popup = L.popup({maxWidth: 320, className: 'fp-popup'}).setLatLng(latlng)
            .setContent(this._popHead + '<div class="fp-who">Loading…</div></div>').openOn(this.map);
        this.popupReq++;
        this.api.ws.send(CHANNEL, {action: 'cell', k: cell.k, size: this.data.size, days: this.period || 365,
                                   req: 'c' + this.popupReq});
    };

    Footprint.prototype._onCell = function (msg) {
        if (!this.popup || msg.req !== 'c' + this.popupReq || !this.popup.isOpen()) return;
        var self = this;
        function show(inner) { self.popup.setContent(self._popHead + '<div class="fp-who">' + inner + '</div></div>'); }
        if (!msg.ok) { show('Could not load: ' + esc(msg.error || 'error')); return; }
        if (!msg.nodes.length) { show('No samples left in this period.'); return; }
        var rows = msg.nodes.map(function (n) {
            var how = n.nd
                ? fmtNum(n.nd) + '× direct, ' + dB(n.snr) + (n.best !== null ? ' (best ' + dB(n.best) + ')' : '')
                : '';
            if (n.nr) how += (how ? ', ' : '') + fmtNum(n.nr) + '× via relay';
            return '<tr><td title="' + esc(n.id) + '">' + esc(n.name) + '</td><td>' + how +
                   '</td><td class="fp-dim">' + ago(n.last) + '</td></tr>';
        });
        show('<table class="fp-table">' + rows.join('') + '</table>' +
             (msg.more ? '<div class="fp-dim">and ' + msg.more + ' more</div>' : ''));
    };

    // ── panel ───────────────────────────────────────────────────────────

    function chips(cls, values, current, label) {
        return values.map(function (v) {
            return '<button class="fp-chip ' + cls + (v === current ? ' fp-on' : '') + '" data-v="' + v + '">' +
                   esc(label(v)) + '</button>';
        }).join('');
    }

    Footprint.prototype._renderPanel = function () {
        if (!this.panel) return;
        var box = this.panel.querySelector('.fp-content');
        var h = '';
        h += '<div class="fp-row fp-between"><button class="fp-toggle' + (this.on ? ' fp-on' : '') + '">' +
             (this.on ? 'Shown on map' : 'Show on map') + '</button>' +
             (this.pending ? '<span class="fp-dim">loading…</span>' : '') + '</div>';
        if (this.on) {
            var grid = this.grid;
            h += '<div class="fp-row"><span class="fp-label">Grid</span>' +
                 chips('fp-size', [AUTO].concat(SIZES), this.size, function (v) {
                     return v === AUTO ? 'Auto' + (grid ? ' · ' + fmtSize(grid) : '') : fmtSize(v);
                 }) + '</div>';
            h += '<div class="fp-row"><span class="fp-label">Period</span>' +
                 chips('fp-period', PERIODS, this.period, function (d) { return d ? d + ' d' : 'All'; }) + '</div>';
            h += '<div class="fp-row"><span class="fp-label">Style</span>' +
                 '<button class="fp-chip fp-style' + (!this.outline ? ' fp-on' : '') + '" data-v="fill">Filled</button>' +
                 '<button class="fp-chip fp-style' + (this.outline ? ' fp-on' : '') + '" data-v="outline" ' +
                 'title="Hollow cells: turn on Show coverage in Mesh Info and compare with the prediction">Outline</button></div>';
            h += '<label class="fp-row fp-check"><input type="checkbox" class="fp-mesh"' +
                 (this.meshOnly ? ' checked' : '') + '> Show "mesh only" cells</label>';
            h += '<div class="fp-legend">' + LEGEND.map(function (l) {
                return '<span><i style="background:' + l[1] + '"></i>' + esc(l[2]) + '</span>';
            }).join('') + '<span><i style="background:' + MESH_ONLY + '"></i>mesh only</span></div>';
        }
        if (this.error) h += '<div class="fp-error">' + esc(this.error) + '</div>';
        var d = this.data;
        if (this.on && d && d.ok) {
            var info = d.info || {};
            if (!d.cells.length && (d.coarse_direct || d.coarse_relay)) {
                h += '<div class="fp-stats">Nothing precise enough for this grid yet.' + this._coarseNote(d) + '</div>';
            } else if (!d.cells.length) {
                h += '<div class="fp-note">No samples yet. Every position your radio hears fills in a cell: ' +
                     'take a tracker for a walk or a drive and watch the map grow.</div>';
            } else {
                h += '<div class="fp-stats"><b>' + fmtNum(d.direct_cells) + '</b> cells heard directly, from ' +
                     fmtNum(info.direct_nodes) + ' nodes (' + fmtNum(info.direct) + ' samples)';
                if (d.relay_cells || this.meshOnly) {
                    h += '<br><b>' + fmtNum(d.relay_cells) + '</b> mesh-only cells within ' +
                         (d.radius_m / 1000).toFixed(1) + ' km' + (d.auto_radius ? ' (auto)' : '');
                }
                if (!d.own) h += '<br><span class="fp-dim">Your node has no position, so mesh-only cells are hidden.</span>';
                h += this._coarseNote(d);
                h += '</div>';
            }
            var imp = info.import;
            if (imp === 'running') h += '<div class="fp-dim">Importing history from MeshPulse and Trails…</div>';
            else if (imp && imp.samples) h += '<div class="fp-dim">Includes ' + fmtNum(imp.samples) + ' samples rebuilt from history.</div>';
        }
        if (this.on) {
            h += '<div class="fp-note" title="Only packets from them to you are measured. Your own transmitter may reach less far, or farther.">' +
                 'Where <b>you hear them</b>, not how far you are heard.</div>';
        }
        box.innerHTML = h;
    };

    // Many nodes round their position for privacy. Those samples are kept, but
    // only drawn on a grid coarse enough for the blur, so say where they went.
    Footprint.prototype._coarseNote = function (d) {
        var n = (d.coarse_direct || 0) + (d.coarse_relay || 0);
        if (!n) return '';
        var bigger = d.size < 1000 ? (this.size === AUTO ? ' Zoom out to see them.' : ' A bigger grid shows them.') : '';
        return '<br><span class="fp-dim">' + fmtNum(n) + ' more samples come from nodes that blur their position ' +
               'too much for a ' + fmtSize(d.size) + ' grid (' + fmtNum(d.coarse_direct || 0) + ' direct).' + bigger + '</span>';
    };

    Footprint.prototype._wirePanel = function () {
        var self = this;
        this.panel.addEventListener('click', function (e) {
            var b = e.target.closest('button');
            if (!b || !self.panel.contains(b)) return;
            if (b.classList.contains('fp-toggle')) { self.setOn(!self.on); return; }
            var v = b.getAttribute('data-v');
            if (b.classList.contains('fp-size')) {
                self.size = Number(v); self._store('size', String(self.size)); self._fetch();
            } else if (b.classList.contains('fp-period')) {
                self.period = Number(v); self._store('period', String(self.period)); self._fetch();
            } else if (b.classList.contains('fp-style')) {
                self.outline = v === 'outline'; self._store('outline', self.outline ? '1' : '0'); self._draw();
            }
            self._renderPanel();
        });
        this.panel.addEventListener('change', function (e) {
            if (e.target.classList.contains('fp-mesh')) {
                self.meshOnly = e.target.checked;
                self._store('mesh', self.meshOnly ? '1' : '0');
                self._draw();
            }
        });
        // Clicks in the panel must not reach the map underneath.
        if (window.L && L.DomEvent) {
            L.DomEvent.disableClickPropagation(this.panel);
            L.DomEvent.disableScrollPropagation(this.panel);
        }
    };

    Footprint.prototype.setOn = function (on) {
        this.on = !!on;
        this._store('on', this.on ? '1' : '0');
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
        if (!this.on) {
            this._clearMap();
            this.data = null;
            this.error = null;
            this._renderPanel();
            return;
        }
        var self = this;
        this.refreshTimer = setInterval(function () { self._fetch(); }, REFRESH_MS);
        this._fetch();
    };

    // ── lifecycle ───────────────────────────────────────────────────────

    Footprint.prototype.onEnable = function (api) {
        var self = this;
        this.api = api;
        this.map = api.map.getLeafletMap();
        try { this._reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
        if (!this.map.getPane(PANE)) {
            // Above the predicted-coverage image (overlay pane, 400) so Outline
            // can sit on top of it; below Live Pulse (450) and markers (600).
            var pane = this.map.createPane(PANE);
            pane.style.zIndex = 405;
        }
        this._zoomHandler = function () { self._onZoom(); };
        this.map.on('zoomend', this._zoomHandler);

        var s = Number(this._load('size', this.size));
        if (s === AUTO || SIZES.indexOf(s) >= 0) this.size = s;
        var p = Number(this._load('period', this.period));
        if (PERIODS.indexOf(p) >= 0) this.period = p;
        this.outline = this._load('outline', '0') === '1';
        this.meshOnly = this._load('mesh', '1') !== '0';

        var panel = document.createElement('div');
        panel.className = 'leaflet-control fp-panel';
        panel.innerHTML = '<div class="fp-head">📶 Footprint</div><div class="fp-content"></div>';
        this.panel = panel;
        this._wirePanel();
        if (api.panels && api.panels.register) api.panels.register(panel);
        else api.map.addControl('footprint', panel, 'topleft');

        api.ws.subscribe(CHANNEL, function (msg) { self._onMessage(msg); });
        this.setOn(this._load('on', '0') === '1');
    };

    Footprint.prototype.onConfigUpdate = function () {
        if (this.on) this._fetch();
    };

    Footprint.prototype.onDisable = function (api) {
        clearInterval(this.refreshTimer);
        clearTimeout(this.sampleTimer);
        clearTimeout(this.timeout);
        this.flashes.slice().forEach(this._dropFlash, this);
        if (this.map && this._zoomHandler) this.map.off('zoomend', this._zoomHandler);
        this._clearMap();
        if (api.ws && api.ws.unsubscribe) api.ws.unsubscribe(CHANNEL);
        if (this.panel) {
            if (api.panels && api.panels.unregister) api.panels.unregister(this.panel);
            else api.map.removeControl('footprint');
            this.panel = null;
        }
        this.data = null;
        this.api = null;
        this.map = null;
    };

    return Footprint;
})();

window.MeshPlugin = FootprintPlugin;
