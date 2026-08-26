/* Force-directed relationship graph on canvas. No dependencies.
   Nodes = technologies, coloured by domain, sized by influence rating.
   Solid edge = "derives from" (parent), dotted edge = "influenced by". */

(function (global) {
  'use strict';

  function TechGraph(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.nodes = [];
    this.links = [];
    this.byId = new Map();
    this.anchors = new Map();      // category -> {x, y} cluster centre
    this.tx = 0; this.ty = 0; this.scale = 1;
    this.alpha = 0;
    this.hover = null;
    this.selected = null;
    this.dragNode = null;
    this.panning = false;
    this.showInfluences = true;
    this.showLabels = true;
    this.dimmed = new Set();       // ids filtered out — drawn faint, not removed
    this._raf = null;
    this._bind();
  }

  /* ------------------------------------------------------------- data load */
  TechGraph.prototype.setData = function (techs, categories) {
    var self = this;
    this.categories = categories;
    this.nodes = techs.map(function (t) {
      return {
        id: t.id, name: t.name, cat: t.cat, year: t.year,
        impact: t.impact || 3, tagline: t.tagline || '', orgs: t.orgs || [],
        r: 4 + (t.impact || 3) * 2.4,
        x: 0, y: 0, vx: 0, vy: 0, fixed: false
      };
    });
    this.byId = new Map(this.nodes.map(function (n) { return [n.id, n]; }));

    this.links = [];
    techs.forEach(function (t) {
      (t.parents || []).forEach(function (p) {
        if (self.byId.has(p)) self.links.push({ s: p, t: t.id, kind: 'parent' });
      });
      (t.influences || []).forEach(function (p) {
        if (self.byId.has(p)) self.links.push({ s: p, t: t.id, kind: 'influence' });
      });
    });

    // degree drives a mild size bonus so hubs read as hubs
    var deg = {};
    this.links.forEach(function (l) { deg[l.s] = (deg[l.s] || 0) + 1; deg[l.t] = (deg[l.t] || 0) + 1; });
    this.nodes.forEach(function (n) { n.deg = deg[n.id] || 0; n.r += Math.min(4, (n.deg || 0) * 0.35); });

    // adjacency for hover highlighting
    this.adj = new Map();
    this.nodes.forEach(function (n) { self.adj.set(n.id, new Set()); });
    this.links.forEach(function (l) { self.adj.get(l.s).add(l.t); self.adj.get(l.t).add(l.s); });

    this._seedPositions();
    this.settle(340);     // converge synchronously so the graph appears already laid out
    this.run(70);         // then a short animated pass to polish
  };

  /* Seed each node near its domain's anchor on a ring — gives the layout an
     initial structure so clusters do not have to be discovered from noise. */
  TechGraph.prototype._seedPositions = function () {
    var cats = this.categories.map(function (c) { return c.id; });
    var R = 340, self = this;
    cats.forEach(function (c, i) {
      var a = (i / cats.length) * Math.PI * 2 - Math.PI / 2;
      self.anchors.set(c, { x: Math.cos(a) * R, y: Math.sin(a) * R * 0.78 });
    });
    var counts = {};
    this.nodes.forEach(function (n) {
      var a = self.anchors.get(n.cat) || { x: 0, y: 0 };
      var k = (counts[n.cat] = (counts[n.cat] || 0) + 1);
      var ang = k * 2.399963;                 // golden angle spiral
      var rad = 12 * Math.sqrt(k);
      n.x = a.x + Math.cos(ang) * rad;
      n.y = a.y + Math.sin(ang) * rad;
      n.vx = n.vy = 0;
    });
  };

  /* -------------------------------------------------------------- simulate */

  /* Run the simulation to convergence without touching the render loop.
     93 nodes x ~340 ticks is a few milliseconds, and it means the user never
     watches the layout untangle itself. */
  TechGraph.prototype.settle = function (ticks) {
    this.alpha = 1;
    for (var i = 0; i < ticks; i++) {
      this._tick();
      this.alpha = Math.max(0.02, this.alpha * 0.99);
    }
  };

  TechGraph.prototype.run = function (ticks) {
    this.alpha = 1;
    this._ticksLeft = ticks || 300;
    this._loop();
  };

  TechGraph.prototype._loop = function () {
    var self = this;
    if (this._raf) cancelAnimationFrame(this._raf);
    var step = function () {
      if (self._ticksLeft > 0 || self.dragNode) {
        self._tick();
        if (!self.dragNode) self._ticksLeft--;
        self.alpha = Math.max(0.02, self.alpha * 0.985);
      }
      self.draw();
      if (self._ticksLeft > 0 || self.dragNode || self._needsDraw) {
        self._needsDraw = false;
        self._raf = requestAnimationFrame(step);
      } else {
        self._raf = null;
      }
    };
    this._raf = requestAnimationFrame(step);
  };

  TechGraph.prototype.redraw = function () {
    this._needsDraw = true;
    if (!this._raf) this._loop();
  };

  TechGraph.prototype._tick = function () {
    var n = this.nodes, L = this.links, i, j, a, b, dx, dy, d2, d, f;
    var k = this.alpha;

    // repulsion (O(n^2) — fine at this scale, and keeps the code readable)
    for (i = 0; i < n.length; i++) {
      a = n[i];
      for (j = i + 1; j < n.length; j++) {
        b = n[j];
        dx = b.x - a.x; dy = b.y - a.y;
        d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) { dx = (Math.random() - 0.5) * 0.1; dy = (Math.random() - 0.5) * 0.1; d2 = 0.01; }
        if (d2 > 260000) continue;                       // ignore distant pairs
        d = Math.sqrt(d2);
        f = (2600 * k) / d2;
        var ux = dx / d, uy = dy / d;
        a.vx -= ux * f; a.vy -= uy * f;
        b.vx += ux * f; b.vy += uy * f;

        var minD = a.r + b.r + 7;                        // hard collision
        if (d < minD) {
          var push = (minD - d) * 0.4;
          a.vx -= ux * push; a.vy -= uy * push;
          b.vx += ux * push; b.vy += uy * push;
        }
      }
    }

    // springs along edges
    for (i = 0; i < L.length; i++) {
      a = this.byId.get(L[i].s); b = this.byId.get(L[i].t);
      dx = b.x - a.x; dy = b.y - a.y;
      d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      var rest = L[i].kind === 'parent' ? 78 : 130;
      var strength = L[i].kind === 'parent' ? 0.055 : 0.022;
      f = (d - rest) * strength * k;
      var ex = (dx / d) * f, ey = (dy / d) * f;
      a.vx += ex; a.vy += ey;
      b.vx -= ex; b.vy -= ey;
    }

    // cluster gravity toward the domain anchor + global centering
    for (i = 0; i < n.length; i++) {
      a = n[i];
      var anc = this.anchors.get(a.cat);
      if (anc) {
        a.vx += (anc.x - a.x) * 0.0075 * k;
        a.vy += (anc.y - a.y) * 0.0075 * k;
      }
      a.vx += (0 - a.x) * 0.0016 * k;
      a.vy += (0 - a.y) * 0.0016 * k;

      if (a === this.dragNode) { a.vx = a.vy = 0; continue; }
      a.vx *= 0.82; a.vy *= 0.82;
      a.x += Math.max(-18, Math.min(18, a.vx));
      a.y += Math.max(-18, Math.min(18, a.vy));
    }
  };

  /* ------------------------------------------------------------------ draw */
  TechGraph.prototype.resize = function () {
    var dpr = global.devicePixelRatio || 1;
    var r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    this.redraw();
  };

  TechGraph.prototype.fit = function () {
    if (!this.nodes.length || !this.w) return;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    this.nodes.forEach(function (n) {
      minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
    });
    var pad = 70;
    var s = Math.min((this.w - pad * 2) / (maxX - minX), (this.h - pad * 2) / (maxY - minY));
    this.scale = Math.max(0.18, Math.min(2.2, s));
    this.tx = this.w / 2 - ((minX + maxX) / 2) * this.scale;
    this.ty = this.h / 2 - ((minY + maxY) / 2) * this.scale;
    this.redraw();
  };

  TechGraph.prototype.color = function (catId) {
    var c = (this.categories || []).find(function (x) { return x.id === catId; });
    return c ? c.color : '#8aa';
  };

  TechGraph.prototype.draw = function () {
    var ctx = this.ctx, self = this;
    if (!this.w) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    var focus = this.hover || this.selected;
    var near = focus ? this.adj.get(focus) : null;

    function alphaFor(id) {
      if (self.dimmed.has(id)) return 0.07;
      if (!focus) return 1;
      if (id === focus) return 1;
      return near && near.has(id) ? 0.95 : 0.13;
    }

    // ---- edges
    this.links.forEach(function (l) {
      if (l.kind === 'influence' && !self.showInfluences) return;
      var a = self.byId.get(l.s), b = self.byId.get(l.t);
      var on = focus && (l.s === focus || l.t === focus);
      var op = Math.min(alphaFor(l.s), alphaFor(l.t));
      if (focus && !on) op = Math.min(op, 0.06);

      ctx.beginPath();
      ctx.setLineDash(l.kind === 'influence' ? [3, 4] : []);
      ctx.strokeStyle = on ? self.color(b.cat) : 'rgba(140,190,255,0.85)';
      ctx.globalAlpha = on ? 0.85 : op * 0.3;
      ctx.lineWidth = (on ? 1.7 : 0.9) / self.scale;   // constant width on screen

      // gentle curve so parallel edges stay distinguishable
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx - dy / len * len * 0.09, my + dx / len * len * 0.09, b.x, b.y);
      ctx.stroke();

      if (on) {                                            // arrowhead toward child
        var ang = Math.atan2(b.y - my, b.x - mx);
        var hx = b.x - Math.cos(ang) * (b.r + 3), hy = b.y - Math.sin(ang) * (b.r + 3);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - Math.cos(ang - 0.42) * 8, hy - Math.sin(ang - 0.42) * 8);
        ctx.lineTo(hx - Math.cos(ang + 0.42) * 8, hy - Math.sin(ang + 0.42) * 8);
        ctx.closePath();
        ctx.fillStyle = self.color(b.cat);
        ctx.globalAlpha = 0.9;
        ctx.fill();
      }
    });
    ctx.setLineDash([]);

    // ---- nodes
    this.nodes.forEach(function (n) {
      var op = alphaFor(n.id);
      var col = self.color(n.cat);
      ctx.globalAlpha = op;

      if ((n.id === focus || (near && near.has(n.id))) && op > 0.5) {
        ctx.shadowColor = col; ctx.shadowBlur = 18;
      } else if (n.impact >= 5 && !focus) {
        ctx.shadowColor = col; ctx.shadowBlur = 10;
      } else { ctx.shadowBlur = 0; }

      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.globalAlpha = op * (n.id === focus ? 1 : 0.82);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.lineWidth = (n.id === self.selected ? 2.4 : 1.1) / self.scale;
      ctx.strokeStyle = n.id === self.selected ? '#fff' : 'rgba(5,7,13,0.85)';
      ctx.globalAlpha = op;
      ctx.stroke();
    });

    ctx.globalAlpha = 1;
    ctx.restore();

    /* Labels are drawn in screen space, not world space, so they stay the same
       readable size however far you zoom out. At low zoom only the high-influence
       nodes are labelled, otherwise the map turns into a wall of text. */
    if (!this.showLabels) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var minImpact = this.scale > 0.85 ? 0 : this.scale > 0.55 ? 4 : 5;
    this.nodes.forEach(function (n) {
      var op = alphaFor(n.id);
      if (op <= 0.12) return;
      var isNear = n.id === focus || (near && near.has(n.id));
      if (n.impact < minImpact && !isNear) return;

      var sx = n.x * self.scale + self.tx;
      var sy = n.y * self.scale + self.ty + n.r * self.scale + 4;
      if (sx < -80 || sx > self.w + 80 || sy < -20 || sy > self.h + 20) return;

      ctx.globalAlpha = op * (n.id === focus ? 1 : 0.82);
      ctx.font = (n.impact >= 5 ? '600 12px ' : '500 11px ') + 'ui-monospace, monospace';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(5,7,13,0.92)';
      ctx.strokeText(n.name, sx, sy);
      ctx.fillStyle = n.id === focus ? '#fff' : '#c2d3e8';
      ctx.fillText(n.name, sx, sy);
    });
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  /* -------------------------------------------------------- interaction */
  TechGraph.prototype._toWorld = function (px, py) {
    return { x: (px - this.tx) / this.scale, y: (py - this.ty) / this.scale };
  };

  TechGraph.prototype._pick = function (px, py) {
    var p = this._toWorld(px, py), best = null, bestD = Infinity;
    for (var i = 0; i < this.nodes.length; i++) {
      var n = this.nodes[i];
      if (this.dimmed.has(n.id)) continue;
      var dx = n.x - p.x, dy = n.y - p.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < n.r + 6 && d < bestD) { best = n; bestD = d; }
    }
    return best;
  };

  TechGraph.prototype._bind = function () {
    var self = this, c = this.canvas, last = null, moved = false;

    function pos(e) {
      var r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    c.addEventListener('mousedown', function (e) {
      var p = pos(e);
      moved = false;
      var n = self._pick(p.x, p.y);
      if (n) { self.dragNode = n; self.alpha = Math.max(self.alpha, 0.35); self._loop(); }
      else { self.panning = true; c.classList.add('dragging'); }
      last = p;
    });

    global.addEventListener('mousemove', function (e) {
      var p = pos(e);
      if (self.dragNode) {
        moved = true;
        var w = self._toWorld(p.x, p.y);
        self.dragNode.x = w.x; self.dragNode.y = w.y;
        last = p;
        return;
      }
      if (self.panning && last) {
        moved = true;
        self.tx += p.x - last.x; self.ty += p.y - last.y;
        last = p; self.redraw();
        return;
      }
      if (p.x < 0 || p.y < 0 || p.x > self.w || p.y > self.h) return;
      var n = self._pick(p.x, p.y);
      var id = n ? n.id : null;
      if (id !== self.hover) {
        self.hover = id;
        c.style.cursor = n ? 'pointer' : 'grab';
        if (self.opts.onHover) self.opts.onHover(n, p);
        self.redraw();
      } else if (n && self.opts.onHover) {
        self.opts.onHover(n, p);
      }
    });

    global.addEventListener('mouseup', function () {
      if (self.dragNode && !moved && self.opts.onSelect) self.opts.onSelect(self.dragNode.id);
      else if (self.panning && !moved && self.opts.onBlank) self.opts.onBlank();
      self.dragNode = null;
      self.panning = false;
      last = null;
      c.classList.remove('dragging');
    });

    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = pos(e);
      var f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      var ns = Math.max(0.15, Math.min(3.5, self.scale * f));
      var w = self._toWorld(p.x, p.y);
      self.scale = ns;
      self.tx = p.x - w.x * ns;
      self.ty = p.y - w.y * ns;
      self.redraw();
    }, { passive: false });

    c.addEventListener('mouseleave', function () {
      if (self.hover) { self.hover = null; if (self.opts.onHover) self.opts.onHover(null); self.redraw(); }
    });
  };

  TechGraph.prototype.setDimmed = function (visibleIds) {
    var vis = new Set(visibleIds);
    this.dimmed = new Set(this.nodes.filter(function (n) { return !vis.has(n.id); }).map(function (n) { return n.id; }));
    this.redraw();
  };

  TechGraph.prototype.select = function (id) { this.selected = id; this.redraw(); };

  TechGraph.prototype.focusOn = function (id) {
    var n = this.byId.get(id);
    if (!n || !this.w) return;
    this.scale = Math.max(this.scale, 0.95);
    this.tx = this.w / 2 - n.x * this.scale;
    this.ty = this.h / 2 - n.y * this.scale;
    this.select(id);
  };

  global.TechGraph = TechGraph;
})(window);
