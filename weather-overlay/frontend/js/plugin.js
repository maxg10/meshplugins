/*
 * Weather Overlay Plugin for MeshPulse
 * Copyright (C) 2025-2026 Mariusz "Max" Gieparda
 * GPL-3.0
 *
 * Shows environment sensor data as map labels + heatmap.
 * Metric choice persists across page refreshes via api.storage.
 */

var WeatherOverlayPlugin = (function () {

    var METRICS = [
        { key: 'temperature',        label: 'Temperature',  unit: '°C',   envKey: null },
        { key: 'relativeHumidity',   label: 'Humidity',     unit: '%',    envKey: 'relativeHumidity' },
        { key: 'barometricPressure', label: 'Pressure',     unit: ' hPa', envKey: 'barometricPressure' },
    ];

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

    Plugin.prototype._nodesWithData = function (all) {
        var self = this;
        return all.filter(function (n) {
            return self._getMetricValue(n) != null;
        });
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
            var v = self._getMetricValue(n);
            if (v == null) return;
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

    Plugin.prototype._updateCount = function (weatherCount, total) {
        var el = document.getElementById('wo-count');
        if (el) el.textContent = weatherCount + ' / ' + total + ' nodes with data';
    };

    Plugin.prototype._render = function () {
        // Draw only what the map is drawing — getAll() ignores the core's filters, so
        // labels would survive unchecking Meshtastic/Meshcore. getVisible() is 2.7.0+.
        var api = this.api;
        var all = api.nodes.getVisible ? api.nodes.getVisible() : api.nodes.getAll();
        var weatherNodes = this._nodesWithData(all);
        var zoom = this._lmap.getZoom();
        if (zoom >= 10) {
            this._buildLabels(weatherNodes);
        } else {
            this._clearLabels();
        }
        this._buildHeat(weatherNodes);
        this._updateCount(weatherNodes.length, all.length);
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
            '<div class="wo-count" id="wo-count">Loading…</div>'
        ].join('');

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
            script.onload = function() {
                console.log('[WeatherOverlay] Leaflet.heat loaded');
                self._render();
            };
            document.head.appendChild(script);
        }

        // Restore persisted state
        this._metric   = api.storage.get('metric')   || 'temperature';
        this._showHeat = api.storage.get('showHeat') !== '0';

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
