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
        this.previewInfo = null;
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

    // What the graph falls into once a node is taken out of it. Restricted to
    // what that node could reach before, so parts of the mesh that were already
    // out of touch do not get counted as damage it caused.
    Lifelines.prototype._componentsWithout = function (adj, gone, universe) {
        var seen = Object.create(null), parts = [];
        Object.keys(universe).forEach(function (start) {
            if (start === gone || seen[start]) return;
            var part = [], queue = [start];
            seen[start] = true;
            while (queue.length) {
                var v = queue.pop();
                part.push(v);
                (adj[v] || []).forEach(function (w) {
                    if (w === gone || seen[w] || !universe[w]) return;
                    seen[w] = true;
                    queue.push(w);
                });
            }
            parts.push(part);
        });
        return parts.sort(function (a, b) { return b.length - a.length; });
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
        var anchorIsTracker = !!anchor;
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

        // "What if I go silent" — the rest of the graph, with the anchor removed.
        var universe = Object.create(null);
        var qr = [anchor];
        universe[anchor] = true;
        while (qr.length) {
            var uu = qr.pop();
            (g.adj[uu] || []).forEach(function (w) { if (!universe[w]) { universe[w] = true; qr.push(w); } });
        }
        var parts = this._componentsWithout(g.adj, anchor, universe);
        var without = {
            parts: parts,
            sizes: parts.map(function (p) { return p.length; }),
            alone: parts.filter(function (p) { return p.length === 1; }).length
        };

        this.result = {ids: g.ids, edges: g.edges, cuts: cuts, anchor: anchor, anchorIsCut: anchorIsCut,
                       anchorIsTracker: anchorIsTracker, without: without,
                       anchorName: names[anchor] || anchor, reach: whole, adj: g.adj};
        this.lastRun = Date.now();
        return this.result;
    };

    // ── map ─────────────────────────────────────────────────────────────

    Lifelines.prototype._clearMap = function () {
        if (this.layer && this.api.map.hasLayer(LAYER)) this.api.map.removeLayer(LAYER);
        this.layer = null;
    };

    // The mesh as it would look with the anchor gone: whichever part stays
    // biggest keeps talking to itself (green), everything else is adrift (red).
    Lifelines.prototype._previewWithout = function () {
        this._clearMap();
        var r = this.result;
        if (!r || !r.without || !window.L) return;
        var positions = Object.create(null);
        (this.api.nodes.getAll() || []).forEach(function (n) {
            if (n.lat && n.lon) positions[n.id] = [n.lat, n.lon];
        });
        var group = L.layerGroup();
        r.without.parts.forEach(function (part, idx) {
            var main = idx === 0;
            part.forEach(function (id) {
                if (!positions[id]) return;
                L.circleMarker(positions[id], {
                    radius: main ? 9 : 11,
                    color: main ? '#22c55e' : '#ef4444',
                    weight: main ? 2 : 3, opacity: main ? 0.65 : 0.95,
                    fillColor: main ? '#22c55e' : '#ef4444',
                    fillOpacity: main ? 0.08 : 0.18, interactive: false
                }).addTo(group);
            });
        });
        if (positions[r.anchor]) {
            L.circleMarker(positions[r.anchor], {
                radius: 16, color: '#f59e0b', weight: 3, opacity: 1,
                fillColor: '#f59e0b', fillOpacity: 0.2, interactive: false,
                dashArray: '5, 5'
            }).addTo(group);
        }
        this.layer = group;
        this.api.map.addLayer(LAYER, group);
        this.previewInfo = null;
    };

    // Draw the chosen cut point and everything that depends on it.
    Lifelines.prototype._preview = function (cutId) {
        if (cutId === 'self') return this._previewWithout();
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

        // A node in another component was already unreachable and has nothing to
        // do with this cut point. Only what the anchor could reach BEFORE the
        // removal can be cut off by it.
        var wasReachable = Object.create(null);
        var q2 = [anchor];
        wasReachable[anchor] = true;
        while (q2.length) {
            var u = q2.pop();
            (adj[u] || []).forEach(function (w) {
                if (wasReachable[w]) return;
                wasReachable[w] = true;
                q2.push(w);
            });
        }

        var positions = Object.create(null);
        (this.api.nodes.getAll() || []).forEach(function (n) {
            if (n.lat && n.lon) positions[n.id] = [n.lat, n.lon];
        });

        var group = L.layerGroup();
        var orphaned = 0, noPosition = 0;
        Object.keys(adj).forEach(function (id) {
            if (id === cutId || still[id] || !wasReachable[id]) return;
            orphaned++;
            if (!positions[id]) { noPosition++; return; }   // nowhere to draw it
            L.circleMarker(positions[id], {
                radius: 11, color: '#ef4444', weight: 2, opacity: 0.9,
                fillColor: '#ef4444', fillOpacity: 0.15, interactive: false
            }).addTo(group);
        });
        this.previewInfo = {orphaned: orphaned, noPosition: noPosition};
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

    // Rings and the number in the list have to agree, and when they cannot —
    // a node with no position cannot be drawn — the panel says why.
    Lifelines.prototype._previewHint = function () {
        var i = this.previewInfo;
        if (this.selected === null || !i || !i.noPosition) return '';
        return '<div class="ll-hint">' + i.orphaned + ' cut off, ' + (i.orphaned - i.noPosition) +
            ' ringed \u2014 ' + i.noPosition + ' of them report no position.</div>';
    };

    // ── panel ───────────────────────────────────────────────────────────

    Lifelines.prototype._render = function () {
        if (!this.panel) return;
        var body = this.panel.querySelector('.ll-body');
        if (!body) return;

        var badge = this.panel.querySelector('.ll-badge');
        if (badge) {
            var n = (this.active && this.result) ? this.result.cuts.length : null;
            badge.hidden = (n === null);
            badge.textContent = n === null ? '' : n;
            badge.title = n === null ? '' : n + ' single point' + (n === 1 ? '' : 's') + ' of failure';
        }
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
            '<br>measured from <b>' + escHtmlLocal(r.anchorName) + '</b>' +
            (r.anchorIsTracker ? ' \u2014 your node' : ' \u2014 the busiest node here; your own has no reported links') +
            '</div>';

        var note = r.anchorIsCut
            ? '<div class="ll-note">\u26A0 Parts of this graph reach each other only through ' +
              escHtmlLocal(r.anchorName) +
              (r.anchorIsTracker
                  ? ' \u2014 your own node. There is no way around you.'
                  : ', the node everything is measured from. Those parts have no other route to it.') +
              '</div>'
            : '';

        // The "without me" row belongs in both branches: a mesh where nothing else
        // is a single point of failure is exactly where this question is interesting.
        var self = this;
        var w = r.without || {sizes: [], alone: 0};
        var splits = w.sizes.length;
        var selfRow =
            '<button type="button" class="ll-row ll-self' + (this.selected === 'self' ? ' ll-row-on' : '') + '" data-cut="self">' +
                '<span class="ll-name">if ' + escHtmlLocal(r.anchorName) + ' goes silent</span>' +
                '<span class="ll-count' + (splits > 1 ? '' : ' ll-ok') + '">' +
                    (splits > 1 ? splits + ' parts' : 'holds') + '</span>' +
            '</button>';
        var selfHint = this.selected !== 'self' ? '' :
            '<div class="ll-hint">' + (splits > 1
                ? w.sizes[0] + ' keep each other, ' + w.sizes.slice(1).join(' + ') + ' adrift' +
                  (w.alone ? ' \u2014 ' + (w.alone === 1
                      ? '1 of those is a node only your radio reports'
                      : w.alone + ' of those are nodes only your radio reports') : '')
                : 'The rest of the graph stays in one piece without you.') + '</div>';

        function wireRows() {
            body.querySelectorAll('.ll-row').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var id = btn.getAttribute('data-cut');
                    self.selected = (self.selected === id) ? null : id;
                    self._preview(self.selected);
                    self._render();
                });
            });
        }

        if (!r.cuts.length) {
            body.innerHTML = head + note + selfRow + selfHint +
                '<div class="ll-empty ll-good">Every other node on the graph ' +
                'has more than one way home. Nothing here can split the mesh on its own.</div>';
            wireRows();
            return;
        }

        var rows = r.cuts.slice(0, 25).map(function (c) {
            return '<button type="button" class="ll-row' + (self.selected === c.id ? ' ll-row-on' : '') + '" ' +
                'data-cut="' + escAttr(c.id) + '">' +
                '<span class="ll-name">' + escHtmlLocal(c.name) + '</span>' +
                '<span class="ll-count">' + c.orphans + '</span>' +
                '</button>';
        }).join('');

        body.innerHTML = head + note + selfRow + selfHint +
            '<div class="ll-legend">cut off if it goes silent →</div>' +
            '<div class="ll-list">' + rows + '</div>' +
            (r.cuts.length > 25 ? '<div class="ll-more">+ ' + (r.cuts.length - 25) + ' more</div>' : '');

        var hint = this._previewHint();
        if (hint) body.insertAdjacentHTML('beforeend', hint);

        wireRows();
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
            '<div class="ll-head">' +
                '<label class="ll-title"><input type="checkbox" class="ll-toggle"> 🩺 Lifelines</label>' +
                '<span class="ll-badge" hidden></span>' +
                '<button type="button" class="ll-fold" aria-expanded="true" title="Collapse">▾</button>' +
            '</div>' +
            '<div class="ll-body"></div>';
        this.panel = panel;

        // 23 cut points on a real mesh is a lot of rows; the panel folds away and
        // keeps only its count, which is the part you glance at anyway.
        var fold = panel.querySelector('.ll-fold');
        var foldKey = 'plugin:maxg10/lifelines:folded';
        function applyFold(folded) {
            panel.classList.toggle('ll-folded', folded);
            fold.textContent = folded ? '▸' : '▾';
            fold.setAttribute('aria-expanded', folded ? 'false' : 'true');
            fold.title = folded ? 'Expand' : 'Collapse';
            try { localStorage.setItem(foldKey, folded ? '1' : '0'); } catch (e) { /* ignore */ }
        }
        var foldedStart = false;
        try { foldedStart = localStorage.getItem(foldKey) === '1'; } catch (e) { /* ignore */ }
        applyFold(foldedStart);
        fold.addEventListener('click', function () { applyFold(!panel.classList.contains('ll-folded')); });

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
