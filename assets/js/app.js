/* RobotEvolve — data loading, views, filtering and the detail drawer. */

(function () {
  'use strict';

  var DB = { techs: [], cats: [], catById: {}, labs: [], labById: {} };
  var detailCache = new Map();
  var state = { view: 'graph', q: '', cats: new Set(), license: '', year: 0, sort: 'newest' };
  var graph = null;

  var $ = function (s) { return document.querySelector(s); };
  var el = function (tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  var LICENSE_LABEL = {
    open: 'open source', weights: 'open weights',
    code: 'code / data', closed: 'closed'
  };

  /* ------------------------------------------------------------------ boot */
  function boot() {
    Promise.all([
      fetch('data/technologies.json').then(function (r) { return r.json(); }),
      fetch('data/labs.json').then(function (r) { return r.json(); })
    ]).then(function (res) {
      var t = res[0], l = res[1];
      DB.techs = t.technologies;
      DB.cats = t.categories;
      DB.cats.forEach(function (c) { DB.catById[c.id] = c; });
      DB.labs = l.labs;
      DB.labs.forEach(function (x) { DB.labById[x.id] = x; });

      DB.techs.forEach(function (x) {
        x._search = [
          x.name, x.full_name || '', x.tagline || '',
          (x.tags || []).join(' '),
          (x.orgs || []).map(function (o) { return DB.labById[o] ? DB.labById[o].name : o; }).join(' '),
          DB.catById[x.cat] ? DB.catById[x.cat].name : x.cat
        ].join(' ').toLowerCase();
        x._children = [];
      });
      var byId = {};
      DB.techs.forEach(function (x) { byId[x.id] = x; });
      DB.techs.forEach(function (x) {
        (x.parents || []).forEach(function (p) { if (byId[p]) byId[p]._children.push(x.id); });
      });
      DB.byId = byId;

      renderStats(t);
      renderCatFilters();
      renderLabs();
      initGraph();
      wire();
      show('graph');
      applyFilters();
      openFromHash();
    }).catch(function (err) {
      $('#grid').innerHTML =
        '<div class="empty">Could not load data/*.json.<br><br>' +
        'This page reads JSON with fetch(), which browsers block on file:// URLs.<br>' +
        'Start a local server first:<br><br><code>python serve.py</code><br><br>' +
        '<span style="opacity:.6">' + esc(err.message) + '</span></div>';
      show('list');
    });
  }

  function renderStats(meta) {
    var years = DB.techs.map(function (t) { return t.year; });
    var openCount = DB.techs.filter(function (t) { return t.license === 'open' || t.license === 'weights'; }).length;
    $('#stats').innerHTML =
      '<span class="stat"><b>' + DB.techs.length + '</b> technologies</span>' +
      '<span class="stat"><b>' + DB.labs.length + '</b> labs</span>' +
      '<span class="stat"><b>' + openCount + '</b> open</span>' +
      '<span class="stat">' + Math.min.apply(null, years) + '–' + Math.max.apply(null, years) + '</span>' +
      // last_changed tracks real content edits; `generated` only says when the file
      // was last written, which changes even on a no-op regeneration.
      '<span class="stat" title="When any entry\'s content last actually changed">' +
        'updated <b>' + esc(meta.last_changed || meta.generated) + '</b></span>';
  }

  function renderCatFilters() {
    var wrap = $('#cat-filters');
    DB.cats.forEach(function (c) {
      var b = el('button', 'chip', '<span class="dot"></span>' + esc(c.short));
      b.style.setProperty('--c', c.color);
      b.setAttribute('aria-pressed', 'false');
      b.title = c.name + ' — ' + c.blurb;
      b.addEventListener('click', function () {
        if (state.cats.has(c.id)) state.cats.delete(c.id); else state.cats.add(c.id);
        b.setAttribute('aria-pressed', state.cats.has(c.id) ? 'true' : 'false');
        applyFilters();
      });
      wrap.appendChild(b);
    });
  }

  /* --------------------------------------------------------------- filters */
  function visible() {
    var q = state.q.trim().toLowerCase();
    var out = DB.techs.filter(function (t) {
      if (state.cats.size && !state.cats.has(t.cat)) return false;
      if (state.license && t.license !== state.license) return false;
      if (state.year && t.year < state.year) return false;
      if (q && t._search.indexOf(q) === -1) return false;
      return true;
    });
    var s = state.sort;
    out.sort(function (a, b) {
      if (s === 'name') return a.name.localeCompare(b.name);
      if (s === 'impact') return (b.impact - a.impact) || (b.year - a.year);
      // "added"/"edited" order by when this site last touched the record, which is
      // a different question from when the research came out.
      if (s === 'added') return (b.added || '').localeCompare(a.added || '') || (b.year - a.year);
      if (s === 'edited') return (b.updated || '').localeCompare(a.updated || '') || (b.year - a.year);
      var av = a.year * 12 + (a.month || 0), bv = b.year * 12 + (b.month || 0);
      return s === 'oldest' ? av - bv : bv - av;
    });
    return out;
  }

  function applyFilters() {
    var list = visible();
    $('#result-count').textContent = list.length + ' / ' + DB.techs.length + ' shown';
    renderGrid(list);
    renderTimeline(list);
    if (graph) graph.setDimmed(list.map(function (t) { return t.id; }));
  }

  /* ------------------------------------------------------------ list view */
  function badge(t) {
    var c = DB.catById[t.cat];
    var out = '<span class="badge cat">' + esc(c ? c.short : t.cat) + '</span>' +
      '<span class="badge ' + t.license + '">' + esc(LICENSE_LABEL[t.license] || t.license) + '</span>';
    if (t.confidence === 'medium') out += '<span class="badge verify" title="Lower-confidence entry: verify details before citing">verify</span>';
    return out;
  }

  function orgNames(t) {
    return (t.orgs || []).map(function (o) {
      return DB.labById[o] ? DB.labById[o].name : o;
    });
  }

  function renderGrid(list) {
    var g = $('#grid');
    g.innerHTML = '';
    if (!list.length) { g.appendChild(el('div', 'empty', 'Nothing matches those filters.')); return; }
    var frag = document.createDocumentFragment();
    list.forEach(function (t) {
      var c = DB.catById[t.cat];
      var card = el('div', 'card');
      card.style.setProperty('--c', c ? c.color : '#888');
      card.innerHTML =
        '<div class="card-top">' + badge(t) +
        '<span class="yr">' + t.year + (t.month ? '.' + String(t.month).padStart(2, '0') : '') + '</span></div>' +
        '<h3>' + esc(t.name) + '</h3>' +
        '<p class="tagline">' + esc(t.tagline || '') + '</p>' +
        '<div class="meta">' +
        orgNames(t).slice(0, 3).map(function (n) { return '<span class="orgpill">' + esc(n) + '</span>'; }).join('') +
        (t.tags || []).slice(0, 3).map(function (n) { return '<span class="tagpill">' + esc(n) + '</span>'; }).join('') +
        '</div>';
      card.addEventListener('click', function () { openTech(t.id); });
      frag.appendChild(card);
    });
    g.appendChild(frag);
  }

  /* -------------------------------------------------------- timeline view */
  function renderTimeline(list) {
    var wrap = $('#timeline');
    wrap.innerHTML = '';
    if (!list.length) { wrap.appendChild(el('div', 'empty', 'Nothing matches those filters.')); return; }
    var byYear = {};
    list.forEach(function (t) { (byYear[t.year] = byYear[t.year] || []).push(t); });
    var years = Object.keys(byYear).map(Number).sort(function (a, b) {
      return state.sort === 'oldest' ? a - b : b - a;
    });
    var frag = document.createDocumentFragment();
    years.forEach(function (y) {
      var row = el('div', 'tl-year');
      row.appendChild(el('div', 'tl-year-label', String(y)));
      var track = el('div', 'tl-track');
      var items = el('div', 'tl-items');
      byYear[y].sort(function (a, b) { return (b.month || 0) - (a.month || 0); }).forEach(function (t) {
        var c = DB.catById[t.cat];
        var it = el('div', 'tl-item',
          '<span class="n">' + esc(t.name) + '</span>' +
          '<span class="o">' + esc((orgNames(t)[0] || '').split(' — ')[0].split(' (')[0]) + '</span>');
        it.style.setProperty('--c', c ? c.color : '#888');
        it.addEventListener('click', function () { openTech(t.id); });
        items.appendChild(it);
      });
      track.appendChild(items);
      row.appendChild(track);
      frag.appendChild(row);
    });
    wrap.appendChild(frag);
  }

  /* ------------------------------------------------------------ labs view */
  function renderLabs() {
    var g = $('#labs-grid');
    var frag = document.createDocumentFragment();
    DB.labs.forEach(function (l) {
      var count = DB.techs.filter(function (t) { return (t.orgs || []).indexOf(l.id) !== -1; }).length;
      var card = el('div', 'lab-card');
      var links = Object.keys(l.sources || {}).map(function (k) {
        return '<a href="' + esc(l.sources[k]) + '" target="_blank" rel="noopener">' + esc(k) + '</a>';
      }).join('');
      card.innerHTML =
        '<div class="card-top">' +
        '<span class="prio p' + l.priority + '">P' + l.priority + '</span>' +
        '<span class="badge cat" style="--c:var(--accent)">' + esc(l.type) + '</span>' +
        '<span class="yr">' + count + ' entr' + (count === 1 ? 'y' : 'ies') + '</span></div>' +
        '<h3>' + esc(l.name) + '</h3>' +
        '<div class="loc">' + esc(l.country) + ' · focus: ' +
        (l.focus || []).map(function (f) { return esc(DB.catById[f] ? DB.catById[f].short : f); }).join(', ') + '</div>' +
        '<p>' + esc(l.notes || '') + '</p>' +
        '<div class="lab-links">' + links + '</div>';
      frag.appendChild(card);
    });
    g.appendChild(frag);
  }

  /* ---------------------------------------------------------------- graph */
  function initGraph() {
    var canvas = $('#graph-canvas');
    var tip = $('#graph-tip');
    graph = new TechGraph(canvas, {
      onSelect: function (id) { openTech(id); },
      onBlank: function () { graph.select(null); },
      onHover: function (n, p) {
        if (!n) { tip.style.opacity = 0; return; }
        var t = DB.byId[n.id];
        var c = DB.catById[t.cat];
        tip.innerHTML = '<strong>' + esc(t.name) + '</strong>' +
          '<em>' + esc(c ? c.name : t.cat) + ' · ' + t.year + ' · ' +
          esc(LICENSE_LABEL[t.license] || t.license) + '</em><br>' + esc(t.tagline || '');
        tip.style.left = p.x + 'px';
        tip.style.top = (p.y - 14) + 'px';
        tip.style.opacity = 1;
      }
    });
    // measure first: the layout shapes itself to the canvas, so it needs to know
    // the canvas before the nodes are placed
    graph.resize();
    graph.setData(DB.techs, DB.cats);
    graph.fit();
    requestAnimationFrame(function () { graph.resize(); graph.fit(); });

    var rt = null;
    window.addEventListener('resize', function () {
      graph.resize();
      graph.fit();
      // reshaping the cluster ring is only worth doing once the drag has settled
      clearTimeout(rt);
      rt = setTimeout(function () { graph.reflowIfNeeded(); }, 200);
    });

    $('#g-fit').addEventListener('click', function () { graph.fit(); });
    $('#g-relayout').addEventListener('click', function () { graph.relayout(); });
    $('#g-edges').addEventListener('click', function () {
      graph.showInfluences = !graph.showInfluences;
      this.setAttribute('aria-pressed', String(graph.showInfluences));
      this.textContent = 'influences: ' + (graph.showInfluences ? 'on' : 'off');
      graph.redraw();
    });
    $('#g-labels').addEventListener('click', function () {
      graph.showLabels = !graph.showLabels;
      this.setAttribute('aria-pressed', String(graph.showLabels));
      this.textContent = 'labels: ' + (graph.showLabels ? 'on' : 'off');
      graph.redraw();
    });
  }

  /* --------------------------------------------------------------- drawer */
  function openTech(id) {
    var t = DB.byId[id];
    if (!t) return;
    var c = DB.catById[t.cat];
    var head = $('#drawer-head'), body = $('#drawer-body');
    head.style.setProperty('--c', c ? c.color : '#888');
    $('#drawer').style.setProperty('--c', c ? c.color : '#888');
    head.innerHTML =
      '<div class="kicker">' + esc(c ? c.name : t.cat) + '</div>' +
      '<h2>' + esc(t.name) + '</h2>' +
      (t.full_name ? '<div class="fullname">' + esc(t.full_name) + '</div>' : '') +
      '<div class="card-top" style="margin-top:10px">' + badge(t) +
      '<span class="yr">' + t.year + (t.month ? '.' + String(t.month).padStart(2, '0') : '') + '</span></div>';
    body.innerHTML = '<div class="loading">loading ' + esc(t.detailPath) + ' …</div>';

    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#scrim').classList.add('open');
    if (graph) graph.select(id);
    if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);

    loadDetail(t).then(function (d) {
      body.innerHTML = renderDetail(t, d);
      body.querySelectorAll('[data-goto]').forEach(function (b) {
        b.addEventListener('click', function () { openTech(b.getAttribute('data-goto')); });
      });
      body.scrollTop = 0;
    }).catch(function (e) {
      body.innerHTML = '<div class="notice">Detail file <code>' + esc(t.detailPath) +
        '</code> could not be loaded: ' + esc(e.message) + '</div>';
    });
  }

  function loadDetail(t) {
    if (detailCache.has(t.id)) return Promise.resolve(detailCache.get(t.id));
    return fetch(t.detailPath).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) { detailCache.set(t.id, d); return d; });
  }

  function ul(items, cls) {
    return '<ul class="' + (cls || '') + '">' + (items || []).map(function (i) {
      return '<li>' + esc(i) + '</li>';
    }).join('') + '</ul>';
  }

  function relBtn(id, arrow) {
    var t = DB.byId[id];
    if (!t) return '';
    return '<button data-goto="' + esc(id) + '"><span class="arrow">' + arrow + '</span>' + esc(t.name) + '</button>';
  }

  function renderDetail(t, d) {
    var parents = (t.parents || []).map(function (p) { return relBtn(p, '↖'); }).join('');
    var children = (t._children || []).map(function (p) { return relBtn(p, '↳'); }).join('');
    var infl = (t.influences || []).map(function (p) { return relBtn(p, '⇠'); }).join('');

    var h = '';
    if (t.confidence === 'medium') {
      h += '<div class="sect"><div class="notice">Lower-confidence entry. Organisation, date or link ' +
        'may need checking against a primary source before you cite it.</div></div>';
    }
    h += '<div class="sect"><h4>Summary</h4><p>' + esc(d.summary || '') + '</p></div>';
    if (d.innovation && d.innovation.length)
      h += '<div class="sect"><h4>Key innovation</h4>' + ul(d.innovation) + '</div>';
    if (d.matters && d.matters.length)
      h += '<div class="sect"><h4>Why it matters</h4>' + ul(d.matters) + '</div>';
    if (d.limits && d.limits.length)
      h += '<div class="sect limits"><h4>Limitations</h4>' + ul(d.limits) + '</div>';

    h += '<div class="sect"><h4>Facts</h4><dl class="kv">' +
      '<dt>Year</dt><dd>' + t.year + (t.month ? ', month ' + t.month : '') + '</dd>' +
      '<dt>Domain</dt><dd>' + esc(DB.catById[t.cat] ? DB.catById[t.cat].name : t.cat) + '</dd>' +
      '<dt>Origin</dt><dd>' + orgNames(t).map(esc).join('<br>') + '</dd>' +
      '<dt>Access</dt><dd>' + esc(LICENSE_LABEL[t.license] || t.license) + '</dd>' +
      (t.tags && t.tags.length ? '<dt>Tags</dt><dd>' + t.tags.map(esc).join(' · ') + '</dd>' : '') +
      '<dt>Influence</dt><dd>' + '●'.repeat(t.impact) + '<span style="opacity:.25">' + '●'.repeat(5 - t.impact) + '</span></dd>' +
      '</dl></div>';

    if (d.lineage)
      h += '<div class="sect"><h4>Lineage</h4><p>' + esc(d.lineage) + '</p></div>';

    if (parents || infl || children) {
      h += '<div class="sect"><h4>Related</h4>';
      if (parents) h += '<div style="margin-bottom:8px"><div style="font-size:11px;color:var(--txt-faint);margin-bottom:5px">Derives from</div><div class="rel">' + parents + '</div></div>';
      if (infl) h += '<div style="margin-bottom:8px"><div style="font-size:11px;color:var(--txt-faint);margin-bottom:5px">Influenced by</div><div class="rel">' + infl + '</div></div>';
      if (children) h += '<div><div style="font-size:11px;color:var(--txt-faint);margin-bottom:5px">Descendants</div><div class="rel">' + children + '</div></div>';
      h += '</div>';
    }

    if (d.links && d.links.length)
      h += '<div class="sect"><h4>Sources</h4><div class="links">' + d.links.map(function (l) {
        return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + ' ↗</a>';
      }).join('') + '</div></div>';

    h += '<div class="sect"><h4>Record</h4><dl class="kv">' +
      '<dt>Detail file</dt><dd style="font-family:var(--mono);font-size:11.5px">' + esc(t.detailPath) + '</dd>' +
      '<dt>Added</dt><dd>' + esc(d.added || 'unknown') + '</dd>' +
      '<dt title="When this entry\'s content last changed — not when the site was rebuilt">Updated</dt>' +
      '<dd>' + esc(d.updated || 'unknown') +
      (d.added && d.updated === d.added
        ? ' <span style="color:var(--txt-faint)">(unchanged since)</span>' : '') + '</dd>' +
      '</dl></div>';
    return h;
  }

  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#scrim').classList.remove('open');
    if (graph) graph.select(null);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }

  function openFromHash() {
    var id = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (id && DB.byId[id]) {
      openTech(id);
      if (graph) graph.focusOn(id);
    }
  }

  /* ----------------------------------------------------------------- wire */
  function show(v) {
    state.view = v;
    document.querySelectorAll('.tab').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.dataset.view === v));
    });
    document.querySelectorAll('.view').forEach(function (s) {
      s.classList.toggle('active', s.id === 'view-' + v);
    });
    $('#sort-group').style.display = (v === 'graph' || v === 'labs') ? 'none' : '';
    // a hidden canvas measures 0, so the graph only learns about a resize that
    // happened on another tab when it comes back into view
    if (v === 'graph' && graph) { graph.resize(); graph.reflowIfNeeded(); }
  }

  function wire() {
    document.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.view); });
    });
    var t = null;
    $('#search').addEventListener('input', function (e) {
      clearTimeout(t);
      var v = e.target.value;
      t = setTimeout(function () { state.q = v; applyFilters(); }, 130);
    });
    $('#license-filter').addEventListener('change', function (e) { state.license = e.target.value; applyFilters(); });
    $('#year-filter').addEventListener('change', function (e) { state.year = +e.target.value; applyFilters(); });
    $('#sort-filter').addEventListener('change', function (e) { state.sort = e.target.value; applyFilters(); });
    $('#reset-filters').addEventListener('click', function () {
      state.q = ''; state.cats.clear(); state.license = ''; state.year = 0; state.sort = 'newest';
      $('#search').value = ''; $('#license-filter').value = ''; $('#year-filter').value = '0';
      $('#sort-filter').value = 'newest';
      document.querySelectorAll('#cat-filters .chip').forEach(function (c) { c.setAttribute('aria-pressed', 'false'); });
      applyFilters();
    });
    $('#drawer-close').addEventListener('click', closeDrawer);
    $('#scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
      if (e.key === '/' && document.activeElement !== $('#search')) { e.preventDefault(); $('#search').focus(); }
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
