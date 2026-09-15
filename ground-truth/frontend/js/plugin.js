// Ground Truth Plugin for MeshPulse
// Copyright (C) 2025-2026 Mariusz "Max" Gieparda
// Licensed under GPL-3.0
//
// The panel side of the check. All of the work happens in the backend, which
// reads the mapper's own SNR history; this asks for a verdict and draws it.

var GroundTruthPlugin = (function () {

    var CHANNEL = 'groundtruth';
    var LAYER = 'ground-truth';

    function GroundTruth() {
        this.api = null;
        this.panel = null;
        this.layer = null;
        this.result = null;
        this.selected = null;
        this.pending = false;
        this.req = 0;
        this.timeout = null;
    }

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ── asking ──────────────────────────────────────────────────────────

    GroundTruth.prototype.check = function () {
        if (this.pending) return;
        var self = this;
        this.pending = true;
        this.req++;
        this._render();
        this.api.ws.send(CHANNEL, {action: 'analyse', req: this.req});
        // The backend walks weeks of rows; if it never answers, say so rather
        // than leaving a spinner running for the rest of the session.
        clearTimeout(this.timeout);
        this.timeout = setTimeout(function () {
            if (!self.pending) return;
            self.pending = false;
            self.result = {ok: false, error: 'timeout'};
            self._render();
        }, 30000);
    };

    GroundTruth.prototype._onReply = function (data) {
        if (!data || (data.req && data.req !== this.req)) return;
        clearTimeout(this.timeout);
        this.pending = false;
        this.result = data;
        this._render();
    };

    // ── drawing ─────────────────────────────────────────────────────────

    GroundTruth.prototype._clearMap = function () {
        if (this.layer && this.api.map.hasLayer(LAYER)) this.api.map.removeLayer(LAYER);
        this.layer = null;
    };

    GroundTruth.prototype._show = function (f) {
        this._clearMap();
        if (!f || !window.L) return;
        var pos = {};
        (this.api.nodes.getAll() || []).forEach(function (n) {
            if (n.lat && n.lon) pos[n.id] = [n.lat, n.lon];
        });
        var tracker = this.api.nodes.getTracker && this.api.nodes.getTracker();
        var a = pos[f.from];
        var b = f.kind === 'link' ? pos[f.to] : (tracker && pos[tracker.id]);
        var group = L.layerGroup();
        var label = '<div class="node-popup"><b>' + esc(f.from_name) +
            (f.kind === 'link' ? ' ↔ ' + esc(f.to_name) : ' ↔ your radio') + '</b><br>' +
            'was <b>' + f.baseline_snr + ' dB</b>, now <b>' + f.recent_snr + ' dB</b><br>' +
            'lost <b>' + f.drop_db + ' dB</b> · ' + f.samples_baseline + '/' + f.samples_recent + ' samples' +
            (f.spread_db === null ? '' : '<br>link noise ±' + f.spread_db + ' dB') + '</div>';

        if (a && b) {
            L.polyline([a, b], {color: '#ef4444', weight: 4, opacity: 0.9, dashArray: '8, 6'})
                .bindPopup(label).addTo(group);
        }
        if (a) {
            L.circleMarker(a, {radius: 13, color: '#ef4444', weight: 3, fillColor: '#ef4444', fillOpacity: 0.15})
                .bindPopup(label).addTo(group);
        }
        this.layer = group;
        this.api.map.addLayer(LAYER, group);
        if (a) this.api.map.panTo(a[0], a[1]);
    };

    // ── panel ───────────────────────────────────────────────────────────

    GroundTruth.prototype._render = function () {
        if (!this.panel) return;
        var body = this.panel.querySelector('.gt-body');
        var btn = this.panel.querySelector('.gt-check');
        if (!body) return;
        btn.disabled = this.pending;
        btn.textContent = this.pending ? 'Checking…' : 'Check now';

        var r = this.result;
        if (this.pending && !r) { body.innerHTML = '<div class="gt-note">Walking the history…</div>'; return; }
        if (!r) { body.innerHTML = '<div class="gt-note">Compares every link with its own past few weeks.</div>'; return; }

        if (!r.ok) {
            var why = r.error === 'no-db'
                ? 'No history database at <code>' + esc(r.db_path || '') + '</code>. If your web root is elsewhere, ' +
                  'set <b>stats_db_path</b> in this plugin’s settings.'
                : (r.error === 'timeout' ? 'The backend did not answer in 30 s.' : esc(r.error || 'unknown error'));
            body.innerHTML = '<div class="gt-note gt-bad">' + why + '</div>';
            return;
        }

        var w = r.window || {};
        var head = '<div class="gt-note">Last <b>' + w.recent_days + ' days</b> against the <b>' +
            w.baseline_days + '</b> before them · threshold <b>' + w.drop_db + ' dB</b></div>';

        if (!r.findings || !r.findings.length) {
            body.innerHTML = head + '<div class="gt-note gt-good">Nothing has faded. Every link with enough ' +
                'measurements is as good as it was.</div>';
            return;
        }

        var self = this;
        body.innerHTML = head + r.findings.map(function (f, i) {
            var who = esc(f.from_name) + (f.kind === 'link' ? ' ↔ ' + esc(f.to_name) : '');
            return '<button type="button" class="gt-row' + (self.selected === i ? ' gt-row-on' : '') + '" data-i="' + i + '">' +
                '<span class="gt-who">' + who + '</span>' +
                '<span class="gt-drop">−' + f.drop_db + ' dB</span></button>';
        }).join('');

        body.querySelectorAll('.gt-row').forEach(function (b) {
            b.addEventListener('click', function () {
                var i = Number(b.getAttribute('data-i'));
                self.selected = (self.selected === i) ? null : i;
                self._show(self.selected === null ? null : r.findings[i]);
                self._render();
            });
        });
    };

    // ── lifecycle ───────────────────────────────────────────────────────

    GroundTruth.prototype.onEnable = function (api) {
        var self = this;
        this.api = api;

        var panel = document.createElement('div');
        panel.className = 'leaflet-control gt-panel';
        panel.innerHTML =
            '<div class="gt-head">📉 Ground Truth</div>' +
            '<button type="button" class="gt-check">Check now</button>' +
            '<div class="gt-body"></div>';
        this.panel = panel;
        panel.querySelector('.gt-check').addEventListener('click', function () { self.check(); });

        if (api.panels && api.panels.register) api.panels.register(panel);
        else api.map.addControl('ground-truth', panel, 'topleft');   // fallback < 2.6.1

        api.ws.subscribe(CHANNEL, function (data) { self._onReply(data); });

        var cfg = (api.info && api.info.config) || {};
        if (cfg.default_enabled === true) this.check();
        else this._render();
    };

    GroundTruth.prototype.onConfigUpdate = function () {
        this.result = null;
        this.selected = null;
        this._clearMap();
        this._render();
    };

    GroundTruth.prototype.onDisable = function (api) {
        clearTimeout(this.timeout);
        this._clearMap();
        if (api.ws && api.ws.unsubscribe) api.ws.unsubscribe(CHANNEL);
        if (this.panel) {
            if (api.panels && api.panels.unregister) api.panels.unregister(this.panel);
            else api.map.removeControl('ground-truth');
            this.panel = null;
        }
        this.result = null;
        this.api = null;
    };

    return GroundTruth;
})();

window.MeshPlugin = GroundTruthPlugin;
