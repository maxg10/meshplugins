/*
 * Weather Overlay Plugin for MeshPulse
 * Copyright (C) 2025-2026 Mariusz "Max" Gieparda
 * GPL-3.0
 *
 * Shows environment sensor data as map labels + heatmap.
 * Metric choice persists across page refreshes via api.storage.
 * Readings no weather sensor can produce (a broken or misdetected sensor) are
 * hidden by default; the panel can show them, marked.
 */

var WeatherOverlayPlugin = (function () {

    var METRICS = [
        { key: 'temperature',        label: 'Temperature',  unit: '°C',   envKey: null },
        { key: 'relativeHumidity',   label: 'Humidity',     unit: '%',    envKey: 'relativeHumidity' },
        { key: 'barometricPressure', label: 'Pressure',     unit: ' hPa', envKey: 'barometricPressure' },
    ];

    // What a weather sensor can physically report. Outside this a reading is a
    // broken or misdetected sensor (180 °C at night happens), not weather, and
    // with "Hide impossible readings" on it stays off the labels and the heatmap.
    var PLAUSIBLE = {
        temperature:      [-50, 70],     // °C
        relativeHumidity: [0, 100]       // %
    };
    // Pressure is what the sensor measures where it is, not reduced to sea
    // level: about 840 hPa on a 1600 m summit is right. So the record sea-level
    // range (870 to 1085 hPa) is moved to the node's altitude, with 3 % to spare
    // for GPS altitude error. Without an altitude (or 0, which usually means
    // none) only what no ground station or balloon in the lower air can show is
    // refused.
    var P_RECORD = [870, 1085], P_SPARE = 0.03, P_NO_ALT = [300, 1118];

    function pressureRatio(h) {
        // Standard atmosphere: troposphere, then the lower stratosphere.
        if (h <= 11000) return Math.pow(1 - 2.25577e-5 * h, 5.25588);
        return 0.22336 * Math.exp(-(h - 11000) / 6341.6);
    }

    function pressureRange(node) {
        var h = node ? parseFloat(node.alt) : NaN;
        if (!isFinite(h) || h === 0 || h < -500 || h > 30000) return P_NO_ALT;
        var f = pressureRatio(h);
        return [P_RECORD[0] * f * (1 - P_SPARE), P_RECORD[1] * f * (1 + P_SPARE)];
    }

    var HEAT_GRADIENT = {
        0.0: '#2563eb', 0.3: '#06b6d4', 0.55: '#22c55e',
        0.75: '#facc15', 1.0: '#ef4444'
    };

    function Plugin() {
        this.api       = null;
        this._lmap     = null;
        this._labels   = [];
        this._heat     = null;
        this._onUpdate = null;
        this._metric   = 'temperature';
        this._showOnly = false;
        this._showHeat = true;
        this._filterBad = true;
        this._mapMoveHandler = null;
        this._zoomHandler = null;
    }

    Plugin.prototype._currentMetric = function () {
        for (var i = 0; i < METRICS.length; i++) {
            if (METRICS[i].key === this._metric) return METRICS[i];
        }
        return METRICS[0];
    };

    Plugin.prototype._getMetricValue = function (node) {
        var m = this._currentMetric();
        if (m.key === 'temperature') {
            if (node.temperature != null) return node.temperature;
            if (node.env && node.env.temperature != null) return node.env.temperature;
            return null;
        }
        return (node.env && node.env[m.envKey] != null) ? node.env[m.envKey] : null;
    };

    Plugin.prototype._formatValue = function (val) {
        var m = this._currentMetric();
        return parseFloat(val).toFixed(1) + m.unit;
    };

    Plugin.prototype._plausible = function (val, node) {
        var v = parseFloat(val);
        if (!isFinite(v)) return false;
        var r = this._metric === 'barometricPressure' ? pressureRange(node) : PLAUSIBLE[this._metric];
        return !r || (v >= r[0] && v <= r[1]);
    };

    // {shown, hidden}: nodes with a value for the current metric. With the filter
    // on, impossible readings are counted in `hidden` and drawn nowhere.
    Plugin.prototype._nodesWithData = function (all) {
        var self = this, shown = [], hidden = 0;
        all.forEach(function (n) {
            var v = self._getMetricValue(n);
            if (v == null) return;
            if (self._filterBad && !self._plausible(v, n)) { hidden++; return; }
            shown.push(n);
        });
        return {shown: shown, hidden: hidden};
    };

    Plugin.prototype._clearLabels = function () {
        this._labels.forEach(function (el) {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        });
        this._labels = [];
    };

    Plugin.prototype._clearHeat = function () {
        if (this._heat) {
            this._lmap.removeLayer(this._heat);
            this._heat = null;
        }
    };

    // Core (v2.5.2+) draws direct/neighbor/trace lines in dedicated panes at
    // z-index 410-430, above the default overlayPane (400). Labels get their
    // own pane at 450: above the line bundle, below markers (600) and popups (700).
    Plugin.prototype._ensureLabelPane = function () {
        var lmap = this._lmap;
        var pane = lmap.getPane('weatherLabels');
        if (!pane) {
            pane = lmap.createPane('weatherLabels');
            pane.style.zIndex = 450;
            pane.style.pointerEvents = 'none';
        }
        return pane;
    };

    Plugin.prototype._buildLabels = function (nodes) {
        var self = this;
        self._clearLabels();
        var lmap = self._lmap;
        var pane = self._ensureLabelPane();
        if (!pane) return;

        nodes.forEach(function (n) {
            if (n.lat == null || n.lon == null) return;
            var val = self._getMetricValue(n);
            if (val == null) return;

            var el = document.createElement('div');
            el.className = 'weather-label-icon';
            el.textContent = self._formatValue(val);
            if (!self._plausible(val, n)) {
                // Only reached with the filter off: say plainly it is not weather.
                el.className += ' wo-bad';
                el.textContent = '⚠ ' + el.textContent;
            }
            el.style.position = 'absolute';
            el.style.pointerEvents = 'none';
            pane.appendChild(el);

            // Position immediately
            var pt = lmap.latLngToLayerPoint([n.lat, n.lon]);
            el.style.transform = 'translate(' + (pt.x - el.offsetWidth / 2) + 'px,' + (pt.y - 28) + 'px)';

            // Store latlng for repositioning on zoom/pan
            el._latlng = [n.lat, n.lon];
            self._labels.push(el);
        });

        // Reposition on map move/zoom
        if (!self._mapMoveHandler) {
            self._mapMoveHandler = function () {
                self._labels.forEach(function (el) {
                    if (!el._latlng) return;
                    var pt = lmap.latLngToLayerPoint(el._latlng);
                    el.style.transform = 'translate(' + (pt.x - el.offsetWidth / 2) + 'px,' + (pt.y - 28) + 'px)';
                });
            };
            lmap.on('move zoom', self._mapMoveHandler);
        }
    };

    Plugin.prototype._buildHeat = function (nodes) {
        var self = this;
        self._clearHeat();
        if (!self._showHeat) return;
        if (!window.L || !L.heatLayer) return;

        // Absolute temperature scale for meaningful colours
        // Only applies to temperature metric; other metrics use relative scale
        var useAbsolute = (self._metric === 'temperature');
        var TEMP_MIN = 0;   // °C → blue
        var TEMP_MAX = 40;  // °C → red

        var points = [];
        var vals = [];
        nodes.forEach(function (n) {
            if (n.lat == null || n.lon == null) return;
            var v = parseFloat(self._getMetricValue(n));
            if (!isFinite(v)) return;
            vals.push(v);
            points.push([n.lat, n.lon, v]);
        });
        if (!points.length) return;

        var normalized;
        if (useAbsolute) {
            normalized = points.map(function (p) {
                var norm = (p[2] - TEMP_MIN) / (TEMP_MAX - TEMP_MIN);
                return [p[0], p[1], Math.max(0, Math.min(1, norm))];
            });
        } else {
            // Relative scale for other metrics
            var min = Math.min.apply(null, vals);
            var max = Math.max.apply(null, vals);
            var range = max - min || 1;
            normalized = points.map(function (p) {
                return [p[0], p[1], (p[2] - min) / range];
            });
        }

        self._heat = L.heatLayer(normalized, {
            radius: 35, blur: 25, maxZoom: 12,
            gradient: HEAT_GRADIENT, minOpacity: 0.35
        }).addTo(self._lmap);
    };

    Plugin.prototype._updateCount = function (weatherCount, total, hidden) {
        var el = this._panel && this._panel.querySelector('.wo-count');
        if (!el) return;
        el.textContent = weatherCount + ' / ' + total + ' nodes with data' +
            (hidden ? ' · ' + hidden + ' impossible hidden' : '');
    };

    Plugin.prototype._render = function () {
        // Draw only what the map is drawing — getAll() ignores the core's filters, so
        // labels would survive unchecking Meshtastic/Meshcore. getVisible() is 2.7.0+.
        var api = this.api;
        var all = api.nodes.getVisible ? api.nodes.getVisible() : api.nodes.getAll();
        var data = this._nodesWithData(all);
        var weatherNodes = data.shown;
        var zoom = this._lmap.getZoom();
        if (zoom >= 10) {
            this._buildLabels(weatherNodes);
        } else {
            this._clearLabels();
        }
        this._buildHeat(weatherNodes);
        this._updateCount(weatherNodes.length, all.length, data.hidden);
    };

    Plugin.prototype._buildPanel = function () {
        var self = this;
        var panel = document.createElement('div');
        panel.className = 'weather-overlay-panel';
        panel.innerHTML = [
            '<div style="font-weight:700;margin-bottom:6px;font-size:13px">🌡️ Weather Overlay</div>',
            '<label><input type="checkbox" id="wo-heat"' + (self._showHeat ? ' checked' : '') + '>',
            ' Heatmap</label>',
            '<select id="wo-metric">',
            METRICS.map(function (m) {
                return '<option value="' + m.key + '"' +
                       (m.key === self._metric ? ' selected' : '') + '>' +
                       m.label + ' (' + m.unit.trim() + ')</option>';
            }).join(''),
            '</select>',
            '<label class="wo-filter" title="Temperature outside -50 to 70 °C, humidity outside 0 to 100 %, pressure outside what is possible at the node\'s altitude: a broken or misdetected sensor, not weather">',
            '<input type="checkbox" id="wo-filter"' + (self._filterBad ? ' checked' : '') + '>',
            ' Hide impossible readings</label>',
            '<div class="wo-count" id="wo-count">Loading…</div>'
        ].join('');

        panel.querySelector('#wo-filter').addEventListener('change', function (e) {
            self._filterBad = e.target.checked;
            self.api.storage.set('filterBad', self._filterBad ? '1' : '0');
            self._render();
        });

        panel.querySelector('#wo-heat').addEventListener('change', function (e) {
            self._showHeat = e.target.checked;
            self.api.storage.set('showHeat', self._showHeat ? '1' : '0');
            self._render();
        });
        panel.querySelector('#wo-metric').addEventListener('change', function (e) {
            self._metric = e.target.value;
            self.api.storage.set('metric', self._metric);
            self._render();
        });
        return panel;
    };

    Plugin.prototype.onEnable = function (api) {
        this.api   = api;
        this._lmap = api.map.getLeafletMap();

        // Load Leaflet.heat if not already loaded
        if (!window.L || !L.heatLayer) {
            var script = document.createElement('script');
            script.src = 'https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js';
            // Pinned and hashed: a changed file on the CDN is refused, not run.
            script.integrity = 'sha384-mFKkGiGvT5vo1fEyGCD3hshDdKmW3wzXW/x+fWriYJArD0R3gawT6lMvLboM22c0';
            script.crossOrigin = 'anonymous';
            script.onload = function() {
                console.log('[WeatherOverlay] Leaflet.heat loaded');
                self._render();
            };
            document.head.appendChild(script);
        }

        // Restore persisted state
        this._metric   = api.storage.get('metric')   || 'temperature';
        this._showHeat = api.storage.get('showHeat') !== '0';
        this._filterBad = api.storage.get('filterBad') !== '0';

        this._panel = this._buildPanel();
        if (api.panels && api.panels.register) {
            api.panels.register(this._panel);
        } else {
            // Core < 2.6.1 has no panels API
            api.map.addControl('weather-panel', this._panel, 'topleft');
        }
        this._render();

        var self = this;
        this._zoomHandler = function() { self._render(); };
        this._lmap.on('zoomend', this._zoomHandler);

        this._onUpdate = function () { self._render(); };
        api.nodes.onUpdate(this._onUpdate);

        // Re-render when the user toggles a map filter (core 2.7.0+)
        if (api.nodes.onFilterChange) {
            this._onFilterChange = function () { self._render(); };
            api.nodes.onFilterChange(this._onFilterChange);
        }

        console.log('[WeatherOverlay] enabled, metric:', this._metric);
    };

    Plugin.prototype.onDisable = function (api) {
        this._clearLabels();
        if (this._zoomHandler) {
            this._lmap.off('zoomend', this._zoomHandler);
            this._zoomHandler = null;
        }
        if (this._mapMoveHandler) {
            this._lmap.off('move zoom', this._mapMoveHandler);
            this._mapMoveHandler = null;
        }
        this._clearHeat();
        if (api.panels && api.panels.unregister) {
            api.panels.unregister(this._panel);
        } else {
            api.map.removeControl('weather-panel');
        }
        this._panel = null;
        console.log('[WeatherOverlay] disabled');
    };

    return Plugin;
})();

window.MeshPlugin = WeatherOverlayPlugin;
