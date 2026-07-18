// Elevation Map Plugin for Meshtastic Network Mapper
// Copyright (C) 2025-2026 Mariusz "Max" Gieparda
// Licensed under GPL-3.0 — see LICENSE file

var ElevationMapPlugin = (function() {

    function ElevationMap() {
        this.api = null;
        this.tileLayer = null;
        this.hillshadeLayer = null;
        this._originalBase = null;
        this._currentProvider = null;
        this._onStorage = null;
    }

    var providers = {
        opentopomap: {
            url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
            attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)',
            maxZoom: 17
        },
        esri_topo: {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
            attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, TomTom, USGS, and the GIS User Community',
            maxZoom: 19
        },
        shaded_relief: {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}',
            attribution: 'Tiles &copy; Esri &mdash; Source: Esri',
            maxZoom: 13
        }
    };

    var hillshade = {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
        attribution: 'Hillshade &copy; Esri',
        maxZoom: 19,
        maxNativeZoom: 16,
        opacity: 0.35
    };

    ElevationMap.prototype.onEnable = function(api) {
        this.api = api;

        var activeKey = 'plugin:' + api.info.id + ':active';

        // Read provider from localStorage (live changes) or config (defaults)
        var storageKey = 'plugin:' + api.info.id + ':tile_provider';
        var providerKey = localStorage.getItem(storageKey) || api.info.config.tile_provider || 'opentopomap';
        var provider = providers[providerKey] || providers.opentopomap;

        this.tileLayer = L.tileLayer(provider.url, {
            maxZoom: provider.maxZoom,
            attribution: provider.attribution
        });
        this._currentProvider = providerKey;

        // Resolve initial active state: localStorage overrides config.default_enabled
        var savedActive = localStorage.getItem(activeKey);
        var isActive = savedActive !== null ? (savedActive === 'true') : (api.info.config.default_enabled || false);

        // Hillshade overlay: semi-transparent, drawn on top of whatever base is
        // active, in its own pane between the base tiles (tilePane, z-index 200)
        // and the line/marker panes (400/600).
        var hillshadeKey = 'plugin:' + api.info.id + ':hillshade';
        var savedHillshade = localStorage.getItem(hillshadeKey);
        var hillshadeOn = savedHillshade !== null ? (savedHillshade === 'true') : (api.info.config.hillshade_default || false);

        var rawMap = api.map.getLeafletMap();
        if (!rawMap.getPane('elevationHillshade')) {
            rawMap.createPane('elevationHillshade').style.zIndex = 300;
        }
        this.hillshadeLayer = L.tileLayer(hillshade.url, {
            pane: 'elevationHillshade',
            maxZoom: hillshade.maxZoom,
            maxNativeZoom: hillshade.maxNativeZoom,
            opacity: hillshade.opacity,
            attribution: hillshade.attribution
        });

        // Build checkbox control
        var control = document.createElement('div');
        control.style.cssText = 'background:rgba(31,41,55,0.9);padding:6px 10px;border-radius:6px;color:#e5e7eb;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
        control.innerHTML =
            '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap">' +
                '<input type="checkbox" id="plugin-elev-toggle"' +
                (isActive ? ' checked' : '') + '>' +
                '<span>\u26f0\ufe0f Elevation Map</span>' +
            '</label>' +
            '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;margin-top:6px;padding-top:6px;border-top:1px solid rgba(229,231,235,0.25)">' +
                '<input type="checkbox" id="plugin-elev-hillshade"' +
                (hillshadeOn ? ' checked' : '') + '>' +
                '<span>\ud83c\udfd4\ufe0f Hillshade</span>' +
            '</label>';

        // Swap base layer on toggle (never touch the hillshade overlay)
        var self = this;
        control.querySelector('#plugin-elev-toggle').addEventListener('change', function(e) {
            localStorage.setItem(activeKey, e.target.checked);
            var rawMap = api.map.getLeafletMap();
            if (e.target.checked) {
                rawMap.eachLayer(function(layer) {
                    if (layer instanceof L.TileLayer && layer !== self.tileLayer && layer !== self.hillshadeLayer) {
                        self._originalBase = layer;
                        rawMap.removeLayer(layer);
                    }
                });
                self.tileLayer.addTo(rawMap);
            } else {
                rawMap.removeLayer(self.tileLayer);
                if (self._originalBase) {
                    self._originalBase.addTo(rawMap);
                }
            }
        });

        // Hillshade toggle: add/remove only the overlay, independent of the base
        control.querySelector('#plugin-elev-hillshade').addEventListener('change', function(e) {
            localStorage.setItem(hillshadeKey, e.target.checked);
            var rawMap = api.map.getLeafletMap();
            if (e.target.checked) {
                self.hillshadeLayer.addTo(rawMap);
            } else {
                rawMap.removeLayer(self.hillshadeLayer);
            }
        });

        api.map.addControl('elevation-toggle', control, 'topleft');

        // Auto-enable based on resolved state
        if (isActive) {
            rawMap.eachLayer(function(layer) {
                if (layer instanceof L.TileLayer && layer !== self.hillshadeLayer) {
                    self._originalBase = layer;
                    rawMap.removeLayer(layer);
                }
            });
            self.tileLayer.addTo(rawMap);
        }
        if (hillshadeOn) {
            self.hillshadeLayer.addTo(rawMap);
        }

        this._activeKey = activeKey;
        this._hillshadeKey = hillshadeKey;

        // Listen for config changes via storage events
        this._onStorage = function(e) {
            if (e.key === storageKey && e.newValue && e.newValue !== self._currentProvider) {
                self._switchProvider(e.newValue);
            }
        };
        window.addEventListener('storage', this._onStorage);
    };

    ElevationMap.prototype._switchProvider = function(newKey) {
        var provider = providers[newKey] || providers.opentopomap;
        var rawMap = this.api.map.getLeafletMap();
        var wasActive = rawMap.hasLayer(this.tileLayer);

        if (wasActive) {
            rawMap.removeLayer(this.tileLayer);
        }

        this.tileLayer = L.tileLayer(provider.url, {
            maxZoom: provider.maxZoom,
            attribution: provider.attribution
        });
        this._currentProvider = newKey;

        if (wasActive) {
            this.tileLayer.addTo(rawMap);
        }
    };

    ElevationMap.prototype.onConfigUpdate = function(newConfig) {
        // Check if tile provider changed
        var newProvider = newConfig.tile_provider || 'opentopomap';
        if (newProvider !== this._currentProvider) {
            this._switchProvider(newProvider);
        }

        // Update opacity if changed
        var newOpacity = (newConfig.opacity || 70) / 100;
        if (this.tileLayer) {
            this.tileLayer.setOpacity(newOpacity);
        }
    };

    ElevationMap.prototype.onDisable = function(api) {
        // Restore original base if elevation is active
        var rawMap = api.map.getLeafletMap();
        if (rawMap.hasLayer(this.tileLayer)) {
            rawMap.removeLayer(this.tileLayer);
            if (this._originalBase) {
                this._originalBase.addTo(rawMap);
            }
        }
        if (this.hillshadeLayer && rawMap.hasLayer(this.hillshadeLayer)) {
            rawMap.removeLayer(this.hillshadeLayer);
        }
        api.map.removeControl('elevation-toggle');

        if (this._activeKey) {
            localStorage.removeItem(this._activeKey);
            this._activeKey = null;
        }
        if (this._hillshadeKey) {
            localStorage.removeItem(this._hillshadeKey);
            this._hillshadeKey = null;
        }

        if (this._onStorage) {
            window.removeEventListener('storage', this._onStorage);
        }

        this.tileLayer = null;
        this.hillshadeLayer = null;
        this._originalBase = null;
        this.api = null;
    };

    return ElevationMap;
})();

window.MeshPlugin = ElevationMapPlugin;
