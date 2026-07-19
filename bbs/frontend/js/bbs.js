// Meshtastic BBS Plugin — maxg10/bbs — GPL-3.0

(function () {
  'use strict';

  var API = window.BBS_API_BASE ||
    (location.pathname.replace(/\/frontend\/.*$/, '') + '/api') ||
    '/api/plugin/maxg10/bbs';

  var WS_URL = window.BBS_WS_URL || (
    (location.protocol === 'https:' ? 'wss:' : 'ws:') +
    '//' + location.host +
    '/ws/plugin/maxg10/bbs/bbs_updates'
  );

  // ── state ──────────────────────────────────────────────────────────────────

  var state = {
    currentView:  'boards',
    currentArea:  'GENERAL',
    currentPage:  0,
    totalPages:   1,
    ws:           null,
    wsRetries:    0,
    stats:        null,
    previousView: 'boards',
  };

  // ── DOM shortcuts ──────────────────────────────────────────────────────────

  function $$(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls)  e.className   = cls;
    if (text) e.textContent = text;
    return e;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(ts) {
    var d = new Date(ts * 1000);
    var pad = function(n) { return String(n).padStart(2, '0'); };
    return (d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ── toast ──────────────────────────────────────────────────────────────────

  var toastEl = null;
  var toastTimer = null;

  function toast(msg, isErr) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'toast';
      document.body.appendChild(toastEl);
    }
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.style.color = isErr ? 'var(--red)' : 'var(--green)';
    toastEl.classList.add('show');
    toastTimer = setTimeout(function() { toastEl.classList.remove('show'); }, 2400);
  }

  // ── view switcher ──────────────────────────────────────────────────────────

  function showView(name) {
    var views = ['boards', 'compose', 'mail', 'mail-compose', 'nodes', 'info'];
    views.forEach(function(v) {
      var el = $$(v + '-view');
      if (el) {
        el.classList.toggle('active',  v === name);
        el.classList.toggle('hidden', v !== name);
      }
    });
    state.currentView = name;
  }

  function activateTab(name) {
    document.querySelectorAll('.tab').forEach(function(t) {
      t.classList.toggle('active', t.dataset.view === name);
    });
  }

  // ── API helpers ────────────────────────────────────────────────────────────

  function apiFetch(path, opts) {
    return fetch(API + path, opts || {}).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function apiPost(path, body) {
    return apiFetch(path, {
      method:  'POST',
      headers: {'Content-Type': 'application/json'},
      body:    JSON.stringify(body),
    });
  }

  // ── stats ──────────────────────────────────────────────────────────────────

  function loadStats() {
    return apiFetch('/stats').then(function(data) {
      state.stats = data;
      $$('sb-name').textContent  = data.bbs_name + ' v' + data.version;
      $$('sb-stats').textContent = 'Msgs:' + data.messages + '  Mail:' + data.mail + '  Nodes:' + data.nodes;
      $$('qs-msgs').textContent  = data.messages;
      $$('qs-mail').textContent  = data.mail;
      $$('qs-nodes').textContent = data.nodes;

      // update area counts in sidebar
      var areas = ['GENERAL', 'TECH', 'LOCAL', 'MESH'];
      areas.forEach(function(a) {
        var counts = document.querySelectorAll('.area-item[data-area="' + a + '"] .area-count');
        var n = data['area_' + a.toLowerCase()] || 0;
        counts.forEach(function(c) { c.textContent = n; });
      });
    }).catch(function() {});
  }

  // ── boards ─────────────────────────────────────────────────────────────────

  function selectArea(area) {
    state.currentArea = area;
    state.currentPage = 0;
    document.querySelectorAll('.area-item').forEach(function(li) {
      li.classList.toggle('active', li.dataset.area === area);
    });
    $$('boards-title').textContent = area;
    loadMessages();
  }

  function loadMessages() {
    var area = state.currentArea;
    var page = state.currentPage;
    apiFetch('/boards/' + area + '/messages?page=' + page + '&limit=20')
      .then(function(data) {
        renderMessages(data);
        loadStats();
      }).catch(function() {
        $$('msg-list').innerHTML = '<div class="empty-state">Error loading messages.</div>';
      });
  }

  function renderMessages(data) {
    var list = $$('msg-list');
    list.innerHTML = '';

    if (!data.messages || data.messages.length === 0) {
      list.innerHTML = '<div class="empty-state">No messages in ' + esc(data.area) + '.</div>';
      $$('page-info').textContent = 'Page 1 of 1';
      $$('btn-prev').disabled = true;
      $$('btn-next').disabled = true;
      return;
    }

    data.messages.forEach(function(msg) {
      var wrap = el('div', 'message');
      var hdr  = el('div', 'msg-header');
      hdr.innerHTML =
        '<span class="msg-id">#' + msg.id + '</span>' +
        '<span class="msg-from">' + esc(msg.from_node || msg.from) + '</span>' +
        '<span class="msg-date">' + fmtDate(msg.ts) + '</span>';
      var body = el('div', 'msg-body');
      body.textContent = msg.body;
      wrap.appendChild(hdr);
      wrap.appendChild(body);
      list.appendChild(wrap);
    });

    var total = data.total || 0;
    var limit = data.limit || 20;
    var totalPages = Math.max(1, Math.ceil(total / limit));
    state.totalPages = totalPages;
    $$('page-info').textContent = 'Page ' + (data.page + 1) + ' of ' + totalPages;
    $$('btn-prev').disabled = data.page <= 0;
    $$('btn-next').disabled = (data.page + 1) >= totalPages;
  }

  // ── compose ────────────────────────────────────────────────────────────────

  function openCompose() {
    state.previousView = 'boards';
    $$('compose-area-name').textContent = state.currentArea;
    $$('compose-body').value = '';
    $$('compose-from').value = '';
    $$('char-counter').textContent = '0 / 200';
    $$('char-counter').className = 'char-counter';
    $$('compose-status').textContent = '';
    $$('compose-status').className = 'form-status';
    showView('compose');
  }

  function sendCompose() {
    var from = $$('compose-from').value.trim();
    var body = $$('compose-body').value.trim();
    if (!body) {
      setStatus('compose-status', 'Message body is required.', true);
      return;
    }
    apiPost('/boards/' + state.currentArea + '/messages', {from: from || 'WEB', body: body})
      .then(function() {
        setStatus('compose-status', 'Posted!', false);
        setTimeout(function() {
          showView('boards');
          loadMessages();
        }, 800);
      }).catch(function() {
        setStatus('compose-status', 'Error — could not post.', true);
      });
  }

  // ── mail ───────────────────────────────────────────────────────────────────

  function loadMail(toNode) {
    var url = '/mail' + (toNode ? '?to=' + encodeURIComponent(toNode) : '');
    apiFetch(url).then(renderMail).catch(function() {
      $$('mail-list').innerHTML = '<div class="empty-state">Error loading mail.</div>';
    });
  }

  function renderMail(data) {
    var list = $$('mail-list');
    list.innerHTML = '';
    if (!data.mail || data.mail.length === 0) {
      list.innerHTML = '<div class="empty-state">No mail.</div>';
      return;
    }
    data.mail.forEach(function(m) {
      var wrap = el('div', 'mail-item' + (m.read ? '' : ' unread'));
      var hdr  = el('div', 'mail-header');
      hdr.innerHTML =
        '<span class="mail-id">#' + m.id + '</span>' +
        (!m.read ? '<span class="mail-new-badge">NEW</span>' : '') +
        '<span class="mail-from">From: ' + esc(m.from_node || m.from) + '</span>' +
        '<span class="mail-to">To: ' + esc(m.to_node || m.to) + '</span>' +
        '<span class="mail-date">' + fmtDate(m.ts) + '</span>';
      var body = el('div', 'mail-body');
      body.textContent = m.body;
      wrap.appendChild(hdr);
      wrap.appendChild(body);
      list.appendChild(wrap);
    });
  }

  function openMailCompose() {
    $$('mail-from').value = '';
    $$('mail-to').value   = '';
    $$('mail-body').value = '';
    $$('mail-char-counter').textContent = '0 / 200';
    $$('mail-char-counter').className   = 'char-counter';
    $$('mail-compose-status').textContent = '';
    $$('mail-compose-status').className   = 'form-status';
    showView('mail-compose');
  }

  function sendMail() {
    var from = $$('mail-from').value.trim();
    var to   = $$('mail-to').value.trim();
    var body = $$('mail-body').value.trim();
    if (!to || !body) {
      setStatus('mail-compose-status', 'To and message body are required.', true);
      return;
    }
    apiPost('/mail', {from: from || 'WEB', to: to, body: body})
      .then(function() {
        setStatus('mail-compose-status', 'Mail queued!', false);
        setTimeout(function() {
          showView('mail');
          loadMail();
          loadStats();
        }, 800);
      }).catch(function() {
        setStatus('mail-compose-status', 'Error — could not send.', true);
      });
  }

  // ── nodes ──────────────────────────────────────────────────────────────────

  function loadNodes() {
    apiFetch('/nodes').then(renderNodes).catch(function() {
      $$('nodes-list').innerHTML = '<div class="empty-state">Error loading nodes.</div>';
    });
  }

  function renderNodes(data) {
    var list = $$('nodes-list');
    list.innerHTML = '';
    if (!data.nodes || data.nodes.length === 0) {
      list.innerHTML = '<div class="empty-state">No nodes seen yet.</div>';
      return;
    }
    var table = el('table', 'nodes-table');
    var thead = el('thead');
    thead.innerHTML =
      '<tr>' +
      '<th>SHORT</th>' +
      '<th>LONG NAME</th>' +
      '<th>NODE ID</th>' +
      '<th>FIRST SEEN</th>' +
      '<th>LAST SEEN</th>' +
      '<th>MSGS</th>' +
      '</tr>';
    var tbody = el('tbody');
    data.nodes.forEach(function(n) {
      var tr = el('tr');
      tr.innerHTML =
        '<td class="node-short">'  + esc(n.short_name || '—') + '</td>' +
        '<td class="node-long">'   + esc(n.long_name  || '—') + '</td>' +
        '<td class="node-id-col">' + esc(n.node_id)          + '</td>' +
        '<td class="node-date">'   + fmtDate(n.first_seen)   + '</td>' +
        '<td class="node-date">'   + fmtDate(n.last_seen)    + '</td>' +
        '<td class="node-msgs">'   + (n.msg_count || 0)      + '</td>';
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    list.appendChild(table);
  }

  // ── info ───────────────────────────────────────────────────────────────────

  function renderInfo() {
    var s    = state.stats || {};
    var body = $$('info-body');

    var html = '';

    html += '<div class="info-section">';
    html += '<div class="info-section-title">SYSTEM</div>';
    html += infoRow('BBS Name',    s.bbs_name  || '—');
    html += infoRow('Version',     s.version   || '—');
    html += infoRow('Total Msgs',  s.messages  || 0);
    html += infoRow('Total Mail',  s.mail      || 0);
    html += infoRow('Known Nodes', s.nodes     || 0);
    html += '</div>';

    html += '<div class="info-section">';
    html += '<div class="info-section-title">BULLETIN AREAS</div>';
    ['GENERAL', 'TECH', 'LOCAL', 'MESH'].forEach(function(a) {
      html += infoRow(a, s['area_' + a.toLowerCase()] || 0);
    });
    html += '</div>';

    html += '<div class="info-section">';
    html += '<div class="info-section-title">MESH COMMANDS</div>';
    html += '<table class="info-cmd-table">';
    var cmds = [
      ['BBS HELP',                    'Show command list'],
      ['BBS LIST',                    'List bulletin areas with message counts'],
      ['BBS READ &lt;area&gt; [#]',   'Read messages from area (optional offset)'],
      ['BBS POST &lt;area&gt; &lt;msg&gt;', 'Post message to area'],
      ['BBS MAIL &lt;node&gt; &lt;msg&gt;', 'Send private netmail to a node'],
      ['BBS INBOX',                   'Check your private inbox'],
      ['BBS NODES',                   'Show recently seen nodes'],
      ['BBS INFO',                    'Show BBS statistics'],
    ];
    cmds.forEach(function(c) {
      html += '<tr><td>' + c[0] + '</td><td>' + c[1] + '</td></tr>';
    });
    html += '</table>';
    html += '</div>';

    html += '<div class="info-section">';
    html += '<div class="info-section-title">ABOUT</div>';
    html += infoRow('Plugin',   'maxg10/bbs');
    html += infoRow('License',  'GPL-3.0');
    html += infoRow('GitHub',   'github.com/maxg10/meshplugin-bbs');
    html += '</div>';

    body.innerHTML = html;
  }

  function infoRow(key, val) {
    return '<div class="info-row"><span class="info-key">' + esc(key) + ':</span>' +
           '<span class="info-val">' + esc(String(val)) + '</span></div>';
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  function connectWS() {
    if (state.ws) return;
    try {
      var ws = new WebSocket(WS_URL);
      state.ws = ws;

      ws.onopen = function() {
        state.wsRetries = 0;
        setWsStatus(true);
      };

      ws.onclose = function() {
        state.ws = null;
        setWsStatus(false);
        // exponential back-off, cap at 30 s
        var delay = Math.min(1000 * Math.pow(1.6, state.wsRetries), 30000);
        state.wsRetries++;
        setTimeout(connectWS, delay);
      };

      ws.onerror = function() {};

      ws.onmessage = function(evt) {
        try {
          var msg = JSON.parse(evt.data);
          if (msg.event === 'command') {
            toast('Mesh cmd from ' + (msg.from || '?'));
            if (state.currentView === 'boards') loadMessages();
            loadStats();
          }
        } catch (e) {}
      };
    } catch (e) {
      setWsStatus(false);
    }
  }

  function setWsStatus(online) {
    var el = $$('ws-indicator');
    if (online) {
      el.textContent = '● ONLINE';
      el.className = 'ws-online';
    } else {
      el.textContent = '● OFFLINE';
      el.className = 'ws-offline';
    }
  }

  // ── form helpers ───────────────────────────────────────────────────────────

  function setStatus(id, msg, isErr) {
    var s = $$(id);
    s.textContent = msg;
    s.className   = 'form-status ' + (isErr ? 'err' : 'ok');
  }

  function bindCharCounter(textareaId, counterId) {
    var ta = $$(textareaId);
    var ct = $$(counterId);
    ta.addEventListener('input', function() {
      var n = ta.value.length;
      ct.textContent = n + ' / 200';
      ct.className = 'char-counter' +
        (n > 190 ? ' over' : n > 160 ? ' warn' : '');
    });
  }

  // ── event binding ──────────────────────────────────────────────────────────

  function bindEvents() {
    // nav tabs
    document.querySelectorAll('.tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var view = btn.dataset.view;
        activateTab(view);
        if (view === 'boards') {
          showView('boards');
          loadMessages();
        } else if (view === 'mail') {
          showView('mail');
          loadMail();
        } else if (view === 'nodes') {
          showView('nodes');
          loadNodes();
        } else if (view === 'info') {
          showView('info');
          renderInfo();
        }
      });
    });

    // area sidebar
    document.querySelectorAll('.area-item').forEach(function(li) {
      li.addEventListener('click', function() {
        activateTab('boards');
        showView('boards');
        selectArea(li.dataset.area);
      });
    });

    // boards toolbar
    $$('btn-refresh').addEventListener('click', loadMessages);
    $$('btn-post').addEventListener('click', openCompose);
    $$('btn-prev').addEventListener('click', function() {
      if (state.currentPage > 0) { state.currentPage--; loadMessages(); }
    });
    $$('btn-next').addEventListener('click', function() {
      if (state.currentPage + 1 < state.totalPages) { state.currentPage++; loadMessages(); }
    });

    // compose
    $$('btn-compose-cancel').addEventListener('click', function() {
      showView('boards');
    });
    $$('btn-compose-send').addEventListener('click', sendCompose);
    bindCharCounter('compose-body', 'char-counter');

    // mail
    $$('btn-new-mail').addEventListener('click', openMailCompose);
    $$('btn-mail-filter').addEventListener('click', function() {
      loadMail($$('mail-filter-node').value.trim());
    });
    $$('mail-filter-node').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') loadMail($$('mail-filter-node').value.trim());
    });

    // mail compose
    $$('btn-mail-cancel').addEventListener('click', function() {
      showView('mail');
    });
    $$('btn-mail-send').addEventListener('click', sendMail);
    bindCharCounter('mail-body', 'mail-char-counter');

    // nodes
    $$('btn-nodes-refresh').addEventListener('click', loadNodes);
  }

  // ── init ───────────────────────────────────────────────────────────────────

  function init() {
    bindEvents();
    loadStats().then(function() {
      loadMessages();
      connectWS();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
