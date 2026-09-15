// Lifelines Plugin for MeshPulse
// Copyright (C) 2025-2026 Mariusz "Max" Gieparda
// Licensed under GPL-3.0
//
// A mesh is a graph, and every graph has vertices whose removal breaks it into
// pieces. Those are this plugin's subject: the nodes that other nodes depend on
// to reach the rest of the network. Everything runs in the browser on data the
// map already holds — no backend, no extra packets, nothing asked of the radio.

var LifelinesPlugin = (function () {

    var LAYER = 'lifelines';
    var DEFAULT_RECOMPUTE_MS = 15000;

    function Lifelines() {
        this.api = null;
        this.active = false;
        this.panel = null;
        this.layer = null;
        this.result = null;      // {nodes, links, components, cuts:[{id,name,orphans,kind}]}
        this.selected = null;    // id of the cut point being previewed
        this.timer = null;
        this.lastRun = 0;
        this.key = null;
    }

    // ── graph ───────────────────────────────────────────────────────────

    Lifelines.prototype._cfg = function () {
        var c = (this.api && this.api.info && this.api.info.config) || {};
        return {
            minOrphans: Math.max(1, Number(c.min_orphans) || 1),
            includeOwn: c.include_own_radio !== false,
            recomputeMs: Math.min(120000, Math.max(2000, Number(c.recompute_ms) || DEFAULT_RECOMPUTE_MS)),
            defaultEnabled: c.default_enabled === true
        };
    };

    // Adjacency built from what the core reports: neighbour reports between any
    // two nodes, plus (optionally) the zero-hop nodes our own radio hears.
    Lifelines.prototype._buildGraph = function () {
        var cfg = this._cfg();
        var links = (this.api.links && this.api.links.getAll) ? this.api.links.getAll() : [];
        var adj = Object.create(null);
        var edges = 0;

        links.forEach(function (l) {
            if (!cfg.includeOwn && l.kind === 'direct') return;
            if (!adj[l.from]) adj[l.from] = [];
            if (!adj[l.to]) adj[l.to] = [];
            adj[l.from].push(l.to);
            adj[l.to].push(l.from);
            edges++;
        });
        return {adj: adj, edges: edges, ids: Object.keys(adj)};
    };

    // Iterative Tarjan. Recursion is fine at a few hundred nodes and a liability
    // at a few thousand; a mesh that big is exactly the one worth analysing.
    Lifelines.prototype._articulationPoints = function (adj, ids) {
        var disc = Object.create(null), low = Object.create(null), parent = Object.create(null);
        var isCut = Object.create(null), timer = 0;

        ids.forEach(function (root) {
            if (disc[root] !== undefined) return;
            var rootChildren = 0;
            var stack = [[root, 0]];
            disc[root] = low[root] = ++timer;
            parent[root] = null;

            while (stack.length) {
                var frame = stack[stack.length - 1];
                var v = frame[0];
                var neighbours = adj[v] || [];

                if (frame[1] < neighbours.length) {
                    var w = neighbours[frame[1]++];
                    if (disc[w] === undefined) {
                        parent[w] = v;
                        if (v === root) rootChildren++;
                        disc[w] = low[w] = ++timer;
                        stack.push([w, 0]);
                    } else if (w !== parent[v]) {
                        if (disc[w] < low[v]) low[v] = disc[w];
                    }
                } else {
                    stack.pop();
                    var p = parent[v];
                    if (p !== null && p !== undefined) {
                        if (low[v] < low[p]) low[p] = low[v];
                        // A non-root vertex is a cut point when a child's subtree
                        // cannot reach above it without passing through it.
                        if (p !== root && low[v] >= disc[p]) isCut[p] = true;
                    }
                }
            }
            // The root only matters if the search had to start over for a second child.
            if (rootChildren > 1) isCut[root] = true;
        });
        return Object.keys(isCut);
    };

    // How many nodes lose their path to the anchor if this one goes away.
    // Tarjan says *that* a vertex cuts the graph; this says how much it costs.
    Lifelines.prototype._reachable = function (adj, from, without) {
        var seen = Object.create(null), queue = [from], count = 0;
        seen[from] = true;
        while (queue.length) {
            var v = queue.pop();
            count++;
            var n = adj[v] || [];
            for (var i = 0; i < n.length; i++) {
                if (n[i] === without || seen[n[i]]) continue;
                seen[n[i]] = true;
                queue.push(n[i]);
            }
        }
        return count;
    };

    Lifelines.prototype.analyse = function () {
        var cfg = this._cfg();
        var g = this._buildGraph();
        var self = this;

        if (!g.ids.length) {
            this.result = {ids: [], edges: 0, cuts: [], anchor: null};
            return this.result;
        }

        // Anchor: our own node if it is on the graph, otherwise the node with the
        // most links — "cut off" only means anything relative to somewhere.
        var tracker = this.api.nodes.getTracker && this.api.nodes.getTracker();
        var anchor = (tracker && g.adj[tracker.id]) ? tracker.id : null;
        if (!anchor) {
            anchor = g.ids.reduce(function (best, id) {
                return (!best || (g.adj[id] || []).length > (g.adj[best] || []).length) ? id : best;
            }, null);
        }

        var whole = this._reachable(g.adj, anchor, null);
        var names = Object.create(null);
        (this.api.nodes.getAll() || []).forEach(function (n) { names[n.id] = n.name || n.id; });
        (this.api.nodes.getNoPosition ? this.api.nodes.getNoPosition() : []).forEach(function (n) {
            if (!names[n.id]) names[n.id] = n.name || n.id;
        });

        var points = this._articulationPoints(g.adj, g.ids);
        // "Cut off" is measured as "can no longer reach the anchor", so the anchor
        // itself would always top the list by construction. That is a tautology,
        // not a finding: report it as a note instead of as a row.
        var anchorIsCut = points.indexOf(anchor) !== -1;

        var cuts = points.filter(function (id) { return id !== anchor; }).map(function (id) {
            var left = self._reachable(g.adj, anchor, id);
            // whole counts the anchor and the removed node; left counts the anchor.
            return {
                id: id,
                name: names[id] || id,
                orphans: Math.max(0, whole - left - 1),
                degree: (g.adj[id] || []).length
            };
        }).filter(function (c) {
            return c.orphans >= cfg.minOrphans;
        }).sort(function (a, b) {
            return b.orphans - a.orphans || b.degree - a.degree;
        });

        this.result = {ids: g.ids, edges: g.edges, cuts: cuts, anchor: anchor, anchorIsCut: anchorIsCut,
                       anchorName: names[anchor] || anchor, reach: whole, adj: g.adj};
        this.lastRun = Date.now();
        return this.result;
    };

    // ── map ─────────────────────────────────────────────────────────────

    Lifelines.prototype._clearMap = function () {
        if (this.layer && this.api.map.hasLayer(LAYER)) this.api.map.removeLayer(LAYER);
        this.layer = null;
    };

    // Draw the chosen cut point and everything that depends on it.
    Lifelines.prototype._preview = function (cutId) {
        this._clearMap();
        if (!cutId || !this.result || !window.L) return;

        var adj = this.result.adj, anchor = this.result.anchor;
        // Removing the anchor leaves nothing connected *to the anchor*, by definition.
        var still = Object.create(null);
        var queue = (cutId === anchor) ? [] : [anchor];
        if (cutId !== anchor) still[anchor] = true;
        while (queue.length) {
            var v = queue.pop();
            (adj[v] || []).forEach(function (w) {
                if (w === cutId || still[w]) return;
                still[w] = true;
                queue.push(w);
            });
        }

        var positions = Object.create(null);
        (this.api.nodes.getAll() || []).forEach(function (n) {
            if (n.lat && n.lon) positions[n.id] = [n.lat, n.lon];
        });

        var group = L.layerGroup();
        var orphaned = 0;
        Object.keys(adj).forEach(function (id) {
            if (id === cutId || still[id] || !positions[id]) return;
            orphaned++;
            L.circleMarker(positions[id], {
                radius: 11, color: '#ef4444', weight: 2, opacity: 0.9,
                fillColor: '#ef4444', fillOpacity: 0.15, interactive: false
            }).addTo(group);
        });
        if (positions[cutId]) {
            L.circleMarker(positions[cutId], {
                radius: 16, color: '#f59e0b', weight: 3, opacity: 1,
                fillColor: '#f59e0b', fillOpacity: 0.2, interactive: false
            }).addTo(group);
        }
        this.layer = group;
        this.api.map.addLayer(LAYER, group);
        return orphaned;
    };

    // ── panel ───────────────────────────────────────────────────────────

    Lifelines.prototype._render = function () {
        if (!this.panel) return;
        var body = this.panel.querySelector('.ll-body');
        if (!body) return;

        if (!this.active) { body.innerHTML = ''; return; }

        var r = this.result;
        if (!r || !r.ids.length) {
            body.innerHTML =
                '<div class="ll-empty">No links to work with yet.<br>' +
                'Lifelines reads neighbour reports, so at least one node has to be ' +
                'sending <b>NEIGHBORINFO</b> — it is off by default in the firmware. ' +
                'Nodes your own radio hears directly count too, once positions arrive.</div>';
            return;
        }

        var head = '<div class="ll-stats">' +
            '<b>' + r.ids.length + '</b> nodes on the graph · ' +
            '<b>' + r.edges + '</b> links · ' +
            '<b>' + r.cuts.length + '</b> single point' + (r.cuts.length === 1 ? '' : 's') + ' of failure' +
            '</div>';

        var note = r.anchorIsCut
            ? '<div class="ll-note">\u26A0 Parts of this graph reach each other only through ' +
              escHtmlLocal(r.anchorName) + ' \u2014 your own node. There is no way around you.</div>'
            : '';

        if (!r.cuts.length) {
            body.innerHTML = head + note + '<div class="ll-empty ll-good">Every other node on the graph ' +
                'has more than one way home. Nothing here can split the mesh on its own.</div>';
            return;
        }

        var self = this;
        var rows = r.cuts.slice(0, 25).map(function (c) {
            return '<button type="button" class="ll-row' + (self.selected === c.id ? ' ll-row-on' : '') + '" ' +
                'data-cut="' + escAttr(c.id) + '">' +
                '<span class="ll-name">' + escHtmlLocal(c.name) + '</span>' +
                '<span class="ll-count">' + c.orphans + '</span>' +
                '</button>';
        }).join('');

        body.innerHTML = head + note +
            '<div class="ll-legend">cut off if it goes silent →</div>' + rows +
            (r.cuts.length > 25 ? '<div class="ll-more">+ ' + (r.cuts.length - 25) + ' more</div>' : '');

        body.querySelectorAll('.ll-row').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-cut');
                self.selected = (self.selected === id) ? null : id;
                self._preview(self.selected);
                self._render();
            });
        });
    };

    function escHtmlLocal(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function escAttr(s) { return escHtmlLocal(s); }

    Lifelines.prototype._schedule = function () {
        var self = this;
        var cfg = this._cfg();
        if (this.timer) return;                       // one pending run is enough
        var wait = Math.max(0, cfg.recomputeMs - (Date.now() - this.lastRun));
        this.timer = setTimeout(function () {
            self.timer = null;
            if (!self.active) return;
            self.analyse();
            if (self.selected) self._preview(self.selected);
            self._render();
        }, wait);
    };

    Lifelines.prototype._setActive = function (on) {
        this.active = on;
        try { if (this.key) localStorage.setItem(this.key, on ? '1' : '0'); } catch (e) { /* ignore */ }
        if (on) {
            this.analyse();
        } else {
            this.selected = null;
            this._clearMap();
        }
        this._render();
    };

    // ── lifecycle ───────────────────────────────────────────────────────

    Lifelines.prototype.onEnable = function (api) {
        var self = this;
        this.api = api;
        this.key = 'plugin:maxg10/lifelines:active';

        var panel = document.createElement('div');
        panel.className = 'leaflet-control ll-panel';
        panel.innerHTML =
            '<label class="ll-head"><input type="checkbox" class="ll-toggle"> 🩺 Lifelines</label>' +
            '<div class="ll-body"></div>';
        this.panel = panel;

        var toggle = panel.querySelector('.ll-toggle');
        var stored = null;
        try { stored = localStorage.getItem(this.key); } catch (e) { /* ignore */ }
        toggle.checked = stored === null ? this._cfg().defaultEnabled : stored === '1';
        toggle.addEventListener('change', function () { self._setActive(toggle.checked); });

        if (api.panels && api.panels.register) api.panels.register(panel);
        else api.map.addControl('lifelines', panel, 'topleft');   // fallback < 2.6.1

        // Neighbour reports trickle in one node at a time; recompute on a timer
        // rather than per report, or a busy mesh would rebuild the graph all day.
        if (api.links && api.links.onUpdate) api.links.onUpdate(function () { if (self.active) self._schedule(); });
        if (api.nodes && api.nodes.onUpdate) api.nodes.onUpdate(function () { if (self.active) self._schedule(); });

        if (toggle.checked) this._setActive(true);
        else this._render();
    };

    Lifelines.prototype.onConfigUpdate = function () {
        if (this.active) { this.analyse(); this._render(); }
    };

    Lifelines.prototype.onDisable = function (api) {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this._clearMap();
        if (this.panel) {
            if (api.panels && api.panels.unregister) api.panels.unregister(this.panel);
            else api.map.removeControl('lifelines');
            this.panel = null;
        }
        this.result = null;
        this.selected = null;
        this.active = false;
        this.api = null;
    };

    return Lifelines;
})();

window.MeshPlugin = LifelinesPlugin;
