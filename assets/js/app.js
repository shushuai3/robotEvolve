/* RobotEvolve — data loading, views, filtering and the detail drawer. */

(function () {
  'use strict';

  var DB = { techs: [], cats: [], catById: {}, labs: [], labById: {},
             methods: [], methodById: {}, facets: [], facetById: {} };
  var detailCache = new Map();
  var state = { view: 'methods', q: '', cats: new Set(), license: '', method: '', year: 0, sort: 'newest' };
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

  /* The colours in technologies.json were picked for a dark neon page. On the green
     paper theme they glare and some vanish, so the page swaps in muted inks by id.
     Ids not listed here keep their colour from the data. */
  var INK = {
    vla: '#2f6f8f', il: '#6a4f9c', rl: '#a2445f', 'world-model': '#8a5d0c',
    wam: '#b04a32', vlm: '#2d6e45', rep: '#a85a1c', data: '#3c5fa8',
    bench: '#8c4a8a', 'human-data': '#5b7419', sim: '#56636c',
    model: '#6f5a99', training: '#8a6a1f', eval: '#a24f6b'
  };
  var FACET_INK = { data: '#2f7a5d' };   // the "data" facet would otherwise share the dataset domain's blue
  function inkCat(c) { if (INK[c.id]) c.color = INK[c.id]; }
  function inkFacet(f) { if (FACET_INK[f.id] || INK[f.id]) f.color = FACET_INK[f.id] || INK[f.id]; }

  /* Domain names are long; the sidebar uses the part before " & " or " / ". */
  function shortName(c) { return c.name.split(/ & | \/ /)[0]; }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    Promise.all([
      fetch('data/technologies.json').then(function (r) { return r.json(); }),
      fetch('data/labs.json').then(function (r) { return r.json(); })
    ]).then(function (res) {
      var t = res[0], l = res[1];
      DB.techs = t.technologies;
      DB.cats = t.categories;
      DB.cats.forEach(function (c) { inkCat(c); DB.catById[c.id] = c; });
      DB.labs = l.labs;
      DB.labs.forEach(function (x) { DB.labById[x.id] = x; });
      DB.methods = t.methods || [];
      DB.methods.forEach(function (m) { DB.methodById[m.id] = m; });
      DB.facets = t.method_facets || [];
      DB.facets.forEach(function (f) { inkFacet(f); DB.facetById[f.id] = f; });

      DB.techs.forEach(function (x) {
        x._search = [
          x.name, x.full_name || '', x.tagline || '',
          (x.tags || []).join(' '),
          (x.methods || []).map(function (m) { return DB.methodById[m] ? DB.methodById[m].name : m; }).join(' '),
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
      renderMethodFilter();
      wire();
      show('methods');
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
      '<span class="stat"><b>' + DB.techs.length + '</b> technologies · <b>' + DB.methods.length + '</b> methods</span>' +
      '<span class="stat"><b>' + DB.labs.length + '</b> labs · <b>' + openCount + '</b> open</span>' +
      '<span class="stat">' + Math.min.apply(null, years) + '–' + Math.max.apply(null, years) + '</span>' +
      // last_changed tracks real content edits; `generated` only says when the file
      // was last written, which changes even on a no-op regeneration.
      '<span class="stat" title="When any entry\'s content last actually changed">' +
        'updated <b>' + esc(meta.last_changed || meta.generated) + '</b></span>';
  }

  function renderCatFilters() {
    var wrap = $('#cat-filters');
    var count = {};
    DB.techs.forEach(function (t) { count[t.cat] = (count[t.cat] || 0) + 1; });
    // The swatch is the
    // domain's colour, which makes this list the legend for the graph too.
    DB.cats.forEach(function (c) {
      var b = el('button', 'chip',
        '<span class="sw"></span><span class="nm">' + esc(shortName(c)) +
        '</span><span class="n">' + (count[c.id] || 0) + '</span>');
      b.style.setProperty('--c', c.color);
      b.dataset.cat = c.id;
      b.title = c.name + ' — ' + c.blurb;
      b.addEventListener('click', function () { toggleCat(c.id); });
      wrap.appendChild(b);
    });
    refreshChips();
  }

  function toggleCat(id) {
    if (state.cats.has(id)) state.cats.delete(id); else state.cats.add(id);
    refreshChips();
    applyFilters();
  }

  /* A domain is "in view" while no domain is picked, or when it is one of the picked ones. */
  function refreshChips() {
    var any = state.cats.size > 0;
    document.querySelectorAll('#cat-filters .chip').forEach(function (b) {
      var picked = state.cats.has(b.dataset.cat);
      var inView = !any || picked;
      b.setAttribute('aria-pressed', picked ? 'true' : 'false');
      b.classList.toggle('inc', inView);
    });
  }

  /* --------------------------------------------------------------- filters */
  function visible() {
    var q = state.q.trim().toLowerCase();
    var out = DB.techs.filter(function (t) {
      if (state.cats.size && !state.cats.has(t.cat)) return false;
      if (state.license && t.license !== state.license) return false;
      if (state.method && (t.methods || []).indexOf(state.method) === -1) return false;
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
    $('#filters-toggle').classList.toggle('active',
      !!(state.license || state.method || state.year || state.sort !== 'newest'));
    renderGrid(list);
    renderTimeline(list);
    renderThreads(list);
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

  /* --------------------------------------------------------------- methods */
  function methodChip(id, asButton) {
    var m = DB.methodById[id];
    if (!m) return '';
    var f = DB.facetById[m.facet];
    var tag = asButton ? 'button' : 'span';
    return '<' + tag + ' class="mchip" style="--c:' + esc(f ? f.color : '') + '"' +
      (asButton ? ' data-method="' + esc(id) + '" title="' + esc(m.blurb) + '"' : '') + '>' +
      esc(m.name) + '</' + tag + '>';
  }

  /* Methods in facet order, the order they are listed in everywhere. */
  function methodColumns() {
    var cols = [];
    DB.facets.forEach(function (f) {
      DB.methods.forEach(function (m) { if (m.facet === f.id) cols.push(m); });
    });
    return cols;
  }

  function renderMethodFilter() {
    var sel = $('#method-filter');
    DB.facets.forEach(function (f) {
      var g = el('optgroup');
      g.label = f.name;
      DB.methods.forEach(function (m) {
        if (m.facet !== f.id) return;
        var o = el('option', null, esc(m.name));
        o.value = m.id;
        g.appendChild(o);
      });
      sel.appendChild(g);
    });
  }

  function setMethod(id) {
    state.method = id || '';
    $('#method-filter').value = state.method;
    applyFilters();
  }

  /* Method threads. Methods (grouped by facet) on the left, domains on the right, and a
     thread wherever technologies in that domain use the method, as thick as how many do.
     Hovering a method or a domain lights its threads and fills the side panel; clicking a
     domain toggles that domain's filter, and the panel can filter the site by a method. */
  var threads = { list: [], focus: null, users: {}, links: [] };   // focus: { kind: 'method' | 'cat', id }

  function renderThreads(list) {
    threads.list = list;
    if (state.view !== 'methods') return;   // a hidden view measures 0 wide; show() draws it
    var wrap = $('#threads');
    if (!list.length) { wrap.innerHTML = '<div class="empty">Nothing matches those filters.</div>'; return; }

    var cols = methodColumns();
    var users = {};
    cols.forEach(function (m) { users[m.id] = []; });
    list.forEach(function (t) { (t.methods || []).forEach(function (m) { if (users[m]) users[m].push(t); }); });
    var newest = function (a, b) { return (b.year * 12 + (b.month || 0)) - (a.year * 12 + (a.month || 0)); };
    cols.forEach(function (m) { users[m.id].sort(newest); });
    var cats = DB.cats.filter(function (c) { return list.some(function (t) { return t.cat === c.id; }); });

    var totalUses = 0;
    cols.forEach(function (m) { totalUses += users[m.id].length; });
    // a filtered list has few threads; scale them up so the picture still fills the space
    var K = Math.max(0.9, Math.min(6, 560 / Math.max(1, totalUses)));

    wrap.innerHTML = '<div class="th-chart"><svg role="img" aria-label="Methods linked to the domains that use them"></svg></div>' +
      '<aside class="th-side" id="th-side"></aside>';
    var box = wrap.querySelector('.th-chart');
    // label columns are fixed by the longest names; the threads take what is left,
    // and below that the chart scrolls sideways rather than squeezing its labels
    var W = Math.max(660, box.clientWidth);
    var x0 = 234, x1 = W - 200;

    // method rows: each as tall as its threads, with a floor so its label fits
    var y = 22, mNode = {}, lastF = null;
    cols.forEach(function (m) {
      if (lastF && lastF !== m.facet) y += 18;
      lastF = m.facet;
      var h = users[m.id].length * K;
      mNode[m.id] = { y: y, h: h, row: Math.max(h, 14), off: 0 };
      y += mNode[m.id].row + 3;
    });
    var H = y + 8;

    // domain blocks: sized by their share of all threads, spread over the same height
    var uses = {};
    cats.forEach(function (c) { uses[c.id] = 0; });
    list.forEach(function (t) { uses[t.cat] += (t.methods || []).filter(function (m) { return users[m]; }).length; });
    var sum = 0;
    cats.forEach(function (c) { sum += uses[c.id] * K; });
    var gap = cats.length > 1 ? Math.max(14, (H - 30 - sum) / (cats.length - 1)) : 0;
    H = Math.max(H, 30 + sum + gap * (cats.length - 1));
    var dy = 22, dNode = {};
    cats.forEach(function (c) { dNode[c.id] = { y: dy, h: Math.max(uses[c.id] * K, 3), off: 0 }; dy += uses[c.id] * K + gap; });

    var links = [];
    cols.forEach(function (m) {
      var by = {};
      users[m.id].forEach(function (t) { by[t.cat] = (by[t.cat] || 0) + 1; });
      cats.forEach(function (c) { if (by[c.id]) links.push({ m: m.id, c: c.id, n: by[c.id], w: by[c.id] * K }); });
    });
    // stack threads in method order at both ends so they never cross inside a block
    links.forEach(function (l) { var n = mNode[l.m]; l.ya = n.y + n.off + l.w / 2; n.off += l.w; });
    links.forEach(function (l) { var n = dNode[l.c]; l.yb = n.y + n.off + l.w / 2; n.off += l.w; });

    var mid = (x0 + x1) / 2;
    var s = '';
    links.forEach(function (l, i) {
      s += '<path class="th-rib" data-i="' + i + '" data-m="' + esc(l.m) + '" stroke="' +
        esc(DB.catById[l.c].color) + '" stroke-width="' + Math.max(l.w, 0.8).toFixed(2) + '" d="M' + x0 + ',' +
        l.ya.toFixed(1) + ' C' + mid + ',' + l.ya.toFixed(1) + ' ' + mid + ',' + l.yb.toFixed(1) + ' ' + x1 + ',' + l.yb.toFixed(1) + '"/>';
    });
    lastF = null;
    cols.forEach(function (m) {
      var n = mNode[m.id], f = DB.facetById[m.facet], cy = n.y + Math.min(n.row, 14) / 2 + 4;
      if (lastF !== m.facet) {
        s += '<text class="th-facet" x="0" y="' + (n.y - 6) + '" fill="' + esc(f.color) + '">' + esc(f.name.toUpperCase()) + '</text>';
        lastF = m.facet;
      }
      var cnt = users[m.id].length;
      s += '<g class="th-m' + (cnt ? '' : ' none') + '" data-m="' + esc(m.id) + '">' +
        '<title>' + esc(m.name + ' — ' + (m.blurb || '')) + '</title>' +
        '<rect class="hit" x="0" y="' + (n.y - 1.5) + '" width="' + x0 + '" height="' + (n.row + 3) + '"/>' +
        '<rect x="' + (x0 - 4) + '" y="' + n.y + '" width="4" height="' + Math.max(n.h, 1) + '" fill="' + esc(f.color) + '"/>' +
        '<text class="lab" x="' + (x0 - 34) + '" y="' + cy + '" text-anchor="end">' + esc(m.name) + '</text>' +
        '<text class="num" x="' + (x0 - 12) + '" y="' + cy + '" text-anchor="end">' + cnt + '</text></g>';
    });
    cats.forEach(function (c) {
      var n = dNode[c.id], cy = n.y + n.h / 2 + 4;
      var cnt = list.filter(function (t) { return t.cat === c.id; }).length;
      s += '<g class="th-c" data-c="' + esc(c.id) + '"><title>' + esc(c.name + ' — ' + (c.blurb || '')) + '</title>' +
        '<rect class="hit" x="' + x1 + '" y="' + (n.y - 3) + '" width="' + (W - x1) + '" height="' + (n.h + 6) + '"/>' +
        '<rect x="' + x1 + '" y="' + n.y + '" width="5" height="' + n.h + '" fill="' + esc(c.color) + '"/>' +
        '<text class="lab" x="' + (x1 + 14) + '" y="' + cy + '" fill="' + esc(c.color) + '">' + esc(shortName(c)) + '</text>' +
        '<text class="num" x="' + (W - 4) + '" y="' + cy + '" text-anchor="end">' + cnt + '</text></g>';
    });
    var svg = box.querySelector('svg');
    H = Math.ceil(H);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.innerHTML = s;

    threads.users = users;
    threads.links = links;
    // keep whatever was being traced, if it is still on screen
    var f = threads.focus;
    if (state.method && users[state.method]) focusThreads({ kind: 'method', id: state.method });
    else if (f && (f.kind === 'method' ? users[f.id] && users[f.id].length : uses[f.id] != null)) focusThreads(f);
    else focusThreads(null);
  }

  function focusThreads(f) {
    threads.focus = f;
    var wrap = $('#threads');
    var on = function (l) { return f.kind === 'method' ? l.m === f.id : l.c === f.id; };
    wrap.querySelectorAll('.th-rib').forEach(function (p) {
      var l = threads.links[+p.dataset.i];
      p.classList.toggle('lit', !!f && on(l));
      p.classList.toggle('dim', !!f && !on(l));
    });
    wrap.querySelectorAll('.th-m').forEach(function (g) { g.classList.toggle('hot', !!f && f.kind === 'method' && g.dataset.m === f.id); });
    wrap.querySelectorAll('.th-c').forEach(function (g) {
      g.classList.toggle('hot', !!f && f.kind === 'cat' && g.dataset.c === f.id);
      g.classList.toggle('on', state.cats.has(g.dataset.c));
    });

    var list = threads.list, users = threads.users;
    var techLi = function (t) {
      var c = DB.catById[t.cat];
      return '<li><button data-goto="' + esc(t.id) + '"><i style="background:' + esc(c ? c.color : '') + '"></i>' +
        '<span class="n">' + esc(t.name) + '</span><span class="y">' + t.year + '</span></button></li>';
    };
    var methodLi = function (m, n) {
      var fc = DB.facetById[m.facet];
      return '<li><button data-focus-m="' + esc(m.id) + '"><i style="background:' + esc(fc ? fc.color : '') + '"></i>' +
        '<span class="n">' + esc(m.name) + '</span><span class="y">' + n + '</span></button></li>';
    };
    var ranked = function (inCat) {
      return methodColumns().map(function (m) {
        return [m, users[m.id].filter(function (t) { return !inCat || t.cat === inCat; }).length];
      }).filter(function (p) { return p[1]; }).sort(function (a, b) { return b[1] - a[1]; });
    };
    var h;
    if (f && f.kind === 'method') {
      var m = DB.methodById[f.id], fc = DB.facetById[m.facet], u = users[f.id];
      h = '<div class="kick" style="color:' + esc(fc.color) + '">' + esc(fc.name) + '</div><h3>' + esc(m.name) + '</h3>' +
        (m.blurb ? '<p>' + esc(m.blurb) + '</p>' : '') +
        '<div class="sub">' + u.length + ' technolog' + (u.length === 1 ? 'y' : 'ies') + ', newest first</div>' +
        '<ul>' + u.map(techLi).join('') + '</ul>' +
        '<button class="btn" data-filter-m="' + esc(m.id) + '">' +
        (state.method === m.id ? 'clear this method filter' : 'show only these technologies') + '</button>';
    } else if (f && f.kind === 'cat') {
      var c = DB.catById[f.id];
      var n = list.filter(function (t) { return t.cat === f.id; }).length;
      h = '<div class="kick" style="color:' + esc(c.color) + '">Domain · ' + n + ' technologies</div><h3>' + esc(c.name) + '</h3>' +
        (c.blurb ? '<p>' + esc(c.blurb) + '</p>' : '') + '<div class="sub">Methods it uses most</div>' +
        '<ul>' + ranked(f.id).map(function (p) { return methodLi(p[0], p[1]); }).join('') + '</ul>' +
        '<button class="btn" data-filter-c="' + esc(c.id) + '">' +
        (state.cats.has(c.id) ? 'remove this domain filter' : 'show only this domain') + '</button>';
    } else {
      var all = ranked(null);
      h = '<div class="kick">How to read this</div><h3>' + list.length + ' technologies, ' + all.length + ' methods</h3>' +
        '<p>Each thread joins a method to a domain. The thicker the thread, the more technologies in that domain use the method. ' +
        'Hover a method or a domain to trace it.</p><div class="sub">Most-used methods</div>' +
        '<ul>' + all.slice(0, 14).map(function (p) { return methodLi(p[0], p[1]); }).join('') + '</ul>';
    }
    $('#th-side').innerHTML = h;
  }

  /* threads of one method lit for a moment, without changing the side panel */
  function previewMethod(id) {
    $('#threads').querySelectorAll('.th-rib').forEach(function (p) {
      p.classList.toggle('peek', !!id && p.dataset.m === id);
    });
  }

  function wireThreads() {
    var wrap = $('#threads');
    wrap.addEventListener('mouseover', function (e) {
      // the side panel is where you go to click a name, so hovering a method listed
      // there only previews its threads instead of replacing the list under the pointer
      var p = e.target.closest('[data-focus-m]');
      if (p) { previewMethod(p.dataset.focusM); return; }
      var g = e.target.closest('.th-m:not(.none), .th-c');
      if (!g) return;
      var f = g.dataset.c ? { kind: 'cat', id: g.dataset.c } : { kind: 'method', id: g.dataset.m };
      var cur = threads.focus;
      if (!cur || cur.kind !== f.kind || cur.id !== f.id) focusThreads(f);
    });
    wrap.addEventListener('mouseout', function (e) {
      if (e.target.closest('[data-focus-m]')) previewMethod(null);
    });
    wrap.addEventListener('click', function (e) {
      var b = e.target.closest('[data-goto]');
      if (b) { openTech(b.dataset.goto); return; }
      b = e.target.closest('[data-filter-m]');
      if (b) { setMethod(state.method === b.dataset.filterM ? '' : b.dataset.filterM); return; }
      b = e.target.closest('[data-filter-c]');
      if (b) { toggleCat(b.dataset.filterC); return; }
      b = e.target.closest('[data-focus-m]');
      if (b) { focusThreads({ kind: 'method', id: b.dataset.focusM }); return; }
      // taps on a phone have no hover, so a tap on the chart traces too
      var g = e.target.closest('.th-m:not(.none)');
      if (g) { focusThreads({ kind: 'method', id: g.dataset.m }); return; }
      g = e.target.closest('.th-c');
      if (g) focusThreads({ kind: 'cat', id: g.dataset.c });
    });
    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { renderThreads(threads.list); }, 120);
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
      // a method chip filters the site to everything else that uses that method
      body.querySelectorAll('[data-method]').forEach(function (b) {
        b.addEventListener('click', function () {
          closeDrawer();
          show('methods');
          setMethod(b.getAttribute('data-method'));
        });
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
      '<dt>Influence</dt><dd class="impact" title="' + t.impact + ' of 5">' +
        '<i class="on"></i>'.repeat(t.impact) + '<i></i>'.repeat(5 - t.impact) + '</dd>' +
      '</dl></div>';

    if ((t.methods || []).length) {
      h += '<div class="sect"><h4>Methods</h4><dl class="mfacets">';
      DB.facets.forEach(function (f) {
        var mine = t.methods.filter(function (m) { return DB.methodById[m] && DB.methodById[m].facet === f.id; });
        if (!mine.length) return;
        h += '<dt>' + esc(f.name) + '</dt><dd>' + mine.map(function (m) { return methodChip(m, true); }).join('') + '</dd>';
      });
      h += '</dl></div>';
    }

    if (d.lineage)
      h += '<div class="sect"><h4>Lineage</h4><p>' + esc(d.lineage) + '</p></div>';

    if (parents || infl || children) {
      h += '<div class="sect"><h4>Related</h4>';
      if (parents) h += '<div class="rel-label">Derives from</div><div class="rel">' + parents + '</div>';
      if (infl) h += '<div class="rel-label">Influenced by</div><div class="rel">' + infl + '</div>';
      if (children) h += '<div class="rel-label">Descendants</div><div class="rel">' + children + '</div>';
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
        ? ' <span style="color:var(--ink-3)">(unchanged since)</span>' : '') + '</dd>' +
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
    if (v === 'methods') renderThreads(threads.list);
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
    $('#method-filter').addEventListener('change', function (e) { setMethod(e.target.value); });
    wireThreads();
    $('#year-filter').addEventListener('change', function (e) { state.year = +e.target.value; applyFilters(); });
    $('#sort-filter').addEventListener('change', function (e) { state.sort = e.target.value; applyFilters(); });
    $('#reset-filters').addEventListener('click', function () {
      state.q = ''; state.cats.clear(); state.license = ''; state.method = ''; state.year = 0; state.sort = 'newest';
      $('#search').value = ''; $('#license-filter').value = ''; $('#method-filter').value = ''; $('#year-filter').value = '0';
      $('#sort-filter').value = 'newest';
      refreshChips();
      applyFilters();
    });
    $('#filters-toggle').addEventListener('click', function () {
      var open = $('#sidebar').classList.toggle('open');
      this.setAttribute('aria-expanded', open);
      this.setAttribute('aria-label', open ? 'Hide filters' : 'Show filters');
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
