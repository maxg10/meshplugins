// Weather Radar Plugin for MeshPulse
// Copyright (C) 2025-2026 Mariusz "Max" Gieparda
// Licensed under GPL-3.0
//
// Animated precipitation radar from RainViewer. Everything runs in the
// browser: the tiles are fetched straight from RainViewer's tile cache, so
// the MeshPulse host (often a very small Raspberry Pi) carries no extra
// traffic, no extra CPU and no extra dependency.

var WeatherRadarPlugin = (function() {

    // RainViewer colour scheme ids, keyed by the label shown in the config UI.
    var COLOR_SCHEMES = {
        'Black and White': 0,
        'Original': 1,
        'Universal Blue': 2,
        'TITAN': 3,
        'The Weather Channel': 4,
        'Meteored': 5,
        'NEXRAD Level III': 6,
        'Rainbow SELEX-IS': 7,
        'Dark Sky': 8
    };

    var DEFAULT_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
    var PANE = 'weatherRadarPane';
    var INDEX_REFRESH_MS = 5 * 60 * 1000;   // new frame every ~10 min upstream
    var TILE_SIZE = 256;

    function WeatherRadar() {
        this.api = null;
        this.frames = [];          // [{time, path}] oldest -> newest
        this.layers = [];          // lazily created, index-aligned with frames
        this.current = -1;
        this.playing = false;
        this.timer = null;
        this.refreshTimer = null;
        this.active = false;
        this._resumeOnShow = false;
        this._visibilityHandler = null;
        this._control = null;
        this._keys = {};
    }

    // ── config ──────────────────────────────────────────────────────────
    // localStorage wins over the manifest config so the panel's own controls
    // survive a page reload without a round trip to the backend.

    WeatherRadar.prototype._cfg = function() {
        var c = (this.api && this.api.info && this.api.info.config) || {};
        return {
            opacity: Math.min(100, Math.max(10, Number(c.opacity) || 70)) / 100,
            scheme: COLOR_SCHEMES[c.color_scheme] !== undefined ? COLOR_SCHEMES[c.color_scheme] : 2,
            smooth: c.smooth === false ? 0 : 1,
            snow: c.snow === false ? 0 : 1,
            frameMs: Math.min(3000, Math.max(100, Number(c.frame_ms) || 500)),
            maxNativeZoom: Math.min(12, Math.max(3, Number(c.max_native_zoom) || 7)),
            indexUrl: (typeof c.index_url === 'string' && c.index_url.trim()) || DEFAULT_INDEX,
            autoplay: c.autoplay !== false,
            defaultEnabled: c.default_enabled === true
        };
    };

    // ── data ────────────────────────────────────────────────────────────

    WeatherRadar.prototype._loadIndex = function(onDone) {
        var self = this;
        var cfg = this._cfg();

        fetch(cfg.indexUrl, {cache: 'no-store'})
            .then(function(r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function(data) {
                var host = data.host || '';
                var radar = data.radar || {};
                var past = radar.past || [];
                // The free plan returns an empty nowcast array; a commercial
                // feed may fill it. Appending it costs nothing when it is empty.
                var nowcast = radar.nowcast || [];
                var frames = past.concat(nowcast).map(function(f) {
                    return {time: f.time, url: host + f.path, forecast: past.indexOf(f) === -1};
                }).filter(function(f) { return f.time && f.url; });

                if (!frames.length) throw new Error('radar index contained no frames');

                var newest = frames[frames.length - 1].time;
                var unchanged = self.frames.length &&
                                self.frames[self.frames.length - 1].time === newest;
                if (unchanged) { if (onDone) onDone(null); return; }

                self._setFrames(frames);
                if (onDone) onDone(null);
            })
            .catch(function(err) {
                console.error('[weather-radar] could not load radar index:', err);
                self._setStatus('Radar unavailable');
                if (onDone) onDone(err);
            });
    };

    WeatherRadar.prototype._setFrames = function(frames) {
        var prev = this.current;
        var wasAtEnd = prev < 0 || prev === this.frames.length - 1;
        this._dropLayers();
        this.frames = frames;
        this.layers = new Array(frames.length);

        var slider = this._control && this._control.querySelector('.wr-slider');
        if (slider) {
            slider.min = 0;
            slider.max = Math.max(0, frames.length - 1);
        }
        if (this.active) {
            this._show(wasAtEnd ? frames.length - 1 : Math.min(prev, frames.length - 1));
        } else {
            this.current = frames.length - 1;
            this._setStatus(this._stamp(this.current));
            if (slider) slider.value = this.current;
        }
    };

    // ── layers ──────────────────────────────────────────────────────────
    // One Leaflet tile layer per frame, created on first use and kept at
    // opacity 0 when it is not the frame on screen. Swapping opacity is what
    // makes the animation smooth: rewriting a single layer's URL would make
    // every frame re-download and flash.

    WeatherRadar.prototype._layer = function(i) {
        if (this.layers[i]) return this.layers[i];
        var cfg = this._cfg();
        var url = this.frames[i].url + '/' + TILE_SIZE + '/{z}/{x}/{y}/' +
                  cfg.scheme + '/' + cfg.smooth + '_' + cfg.snow + '.png';
        this.layers[i] = L.tileLayer(url, {
            pane: PANE,
            opacity: 0,
            maxNativeZoom: cfg.maxNativeZoom,
            maxZoom: 19,
            tileSize: TILE_SIZE,
            crossOrigin: true,
            attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>'
        });
        return this.layers[i];
    };

    WeatherRadar.prototype._show = function(i) {
        if (!this.frames.length) return;
        if (i < 0) i = 0;
        if (i > this.frames.length - 1) i = this.frames.length - 1;

        var map = this.api.map.getLeafletMap();
        var cfg = this._cfg();
        var next = this._layer(i);
        if (!map.hasLayer(next)) next.addTo(map);
        next.setOpacity(cfg.opacity);

        if (this.current !== i && this.current >= 0 && this.layers[this.current]) {
            this.layers[this.current].setOpacity(0);
        }
        this.current = i;

        var slider = this._control && this._control.querySelector('.wr-slider');
        if (slider) slider.value = i;
        this._setStatus(this._stamp(i));

        // Warm the next frame's tiles so playback does not stutter.
        var ahead = (i + 1) % this.frames.length;
        if (!this.layers[ahead]) this._layer(ahead).addTo(map);
    };

    WeatherRadar.prototype._dropLayers = function() {
        if (!this.api) return;
        var map = this.api.map.getLeafletMap();
        this.layers.forEach(function(l) { if (l && map.hasLayer(l)) map.removeLayer(l); });
        this.layers = [];
        this.current = -1;
    };

    // ── playback ────────────────────────────────────────────────────────

    WeatherRadar.prototype._play = function() {
        if (this.playing || this.frames.length < 2) return;
        var self = this;
        this.playing = true;
        this._syncPlayButton();
        this.timer = setInterval(function() {
            self._show((self.current + 1) % self.frames.length);
        }, this._cfg().frameMs);
    };

    WeatherRadar.prototype._stop = function() {
        this.playing = false;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this._syncPlayButton();
    };

    // A phone with the map open in a background tab, or a locked screen, has no
    // reason to keep pulling a new radar frame twice a second. Pause on hide and
    // pick up where we left off — playback state is remembered, not guessed.
    WeatherRadar.prototype._onVisibility = function() {
        if (document.hidden) {
            this._resumeOnShow = this.playing;
            this._stop();
        } else if (this._resumeOnShow && this.active) {
            this._resumeOnShow = false;
            this._loadIndex();
            this._play();
        }
    };

    WeatherRadar.prototype._syncPlayButton = function() {
        var btn = this._control && this._control.querySelector('.wr-play');
        if (!btn) return;
        btn.textContent = this.playing ? '⏸' : '▶';
        btn.title = this.playing ? 'Pause' : 'Play';
    };

    // ── panel ───────────────────────────────────────────────────────────

    WeatherRadar.prototype._stamp = function(i) {
        var f = this.frames[i];
        if (!f) return '';
        var d = new Date(f.time * 1000);
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        var age = Math.round((Date.now() / 1000 - f.time) / 60);
        var rel = f.forecast ? 'forecast' : (age <= 0 ? 'now' : age + ' min ago');
        return hh + ':' + mm + ' · ' + rel;
    };

    WeatherRadar.prototype._setStatus = function(text) {
        var el = this._control && this._control.querySelector('.wr-status');
        if (el) el.textContent = text;
    };

    WeatherRadar.prototype._setActive = function(on) {
        this.active = on;
        var body = this._control && this._control.querySelector('.wr-body');
        if (body) body.style.display = on ? '' : 'none';

        if (on) {
            var self = this;
            var start = function() {
                self._show(self.current >= 0 ? self.current : self.frames.length - 1);
                if (self._cfg().autoplay) self._play();
            };
            if (this.frames.length) start(); else this._loadIndex(function(err) { if (!err) start(); });
        } else {
            this._stop();
            this._dropLayers();
        }
    };

    WeatherRadar.prototype._buildPanel = function(isActive) {
        var el = document.createElement('div');
        el.className = 'weather-radar-panel';
        el.innerHTML =
            '<label class="wr-toggle">' +
                '<input type="checkbox" class="wr-enable"' + (isActive ? ' checked' : '') + '>' +
                '<span>🌧️ Weather Radar</span>' +
            '</label>' +
            '<div class="wr-body"' + (isActive ? '' : ' style="display:none"') + '>' +
                '<div class="wr-row">' +
                    '<button type="button" class="wr-btn wr-step" data-step="-1" title="Previous frame">◀</button>' +
                    '<button type="button" class="wr-btn wr-play" title="Play">▶</button>' +
                    '<button type="button" class="wr-btn wr-step" data-step="1" title="Next frame">▶▌</button>' +
                    '<span class="wr-status"></span>' +
                '</div>' +
                '<input type="range" class="wr-slider" min="0" max="0" value="0" step="1">' +
            '</div>';
        return el;
    };

    WeatherRadar.prototype._wirePanel = function() {
        var self = this;
        var el = this._control;

        el.querySelector('.wr-enable').addEventListener('change', function(e) {
            try { localStorage.setItem(self._keys.active, e.target.checked); } catch (err) {}
            self._setActive(e.target.checked);
        });

        el.querySelector('.wr-play').addEventListener('click', function() {
            if (self.playing) self._stop(); else self._play();
        });

        Array.prototype.forEach.call(el.querySelectorAll('.wr-step'), function(btn) {
            btn.addEventListener('click', function() {
                self._stop();
                var step = Number(btn.dataset.step);
                var n = self.frames.length;
                if (n) self._show((self.current + step + n) % n);
            });
        });

        var slider = el.querySelector('.wr-slider');
        slider.addEventListener('input', function() {
            self._stop();
            self._show(Number(slider.value));
        });
    };

    // ── lifecycle ───────────────────────────────────────────────────────

    WeatherRadar.prototype.onEnable = function(api) {
        this.api = api;
        this._keys = {active: 'plugin:' + api.info.id + ':active'};

        var map = api.map.getLeafletMap();
        if (!map.getPane(PANE)) {
            // Above the base tiles (200) and the elevation hillshade (300),
            // below the node lines and markers (400 / 600).
            var pane = map.createPane(PANE);
            pane.style.zIndex = 350;
            pane.style.pointerEvents = 'none';
        }

        var saved = null;
        try { saved = localStorage.getItem(this._keys.active); } catch (e) {}
        var isActive = saved !== null ? saved === 'true' : this._cfg().defaultEnabled;

        this._control = this._buildPanel(isActive);
        this._wirePanel();
        if (api.panels && api.panels.register) {
            api.panels.register(this._control);
        } else {
            api.map.addControl('weather-radar', this._control, 'topleft');
        }

        var self = this;
        this._loadIndex(function() { if (isActive) self._setActive(true); });
        if (!isActive) this.active = false;

        this.refreshTimer = setInterval(function() { self._loadIndex(); }, INDEX_REFRESH_MS);

        this._visibilityHandler = function() { self._onVisibility(); };
        document.addEventListener('visibilitychange', this._visibilityHandler);
    };

    WeatherRadar.prototype.onConfigUpdate = function() {
        // Colour scheme, smoothing and zoom are baked into the tile URLs, so
        // the layers have to be rebuilt from scratch.
        var wasActive = this.active;
        var wasPlaying = this.playing;
        this._stop();
        this._dropLayers();
        this.layers = new Array(this.frames.length);
        if (wasActive) {
            this._show(this.frames.length - 1);
            if (wasPlaying) this._play();
        }
    };

    WeatherRadar.prototype.onDisable = function(api) {
        this._stop();
        if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
        if (this._visibilityHandler) {
            document.removeEventListener('visibilitychange', this._visibilityHandler);
            this._visibilityHandler = null;
        }
        this._dropLayers();

        if (this._control) {
            if (api.panels && api.panels.unregister) {
                api.panels.unregister(this._control);
            } else {
                api.map.removeControl('weather-radar');
            }
            this._control = null;
        }
        try { if (this._keys.active) localStorage.removeItem(this._keys.active); } catch (e) {}

        this.frames = [];
        this.active = false;
        this.api = null;
    };

    return WeatherRadar;
})();

window.MeshPlugin = WeatherRadarPlugin;
