/* Force-directed relationship graph on canvas. No dependencies.
   Nodes = technologies, coloured by domain, sized by influence rating.
   Solid edge = "derives from" (parent), dotted edge = "influenced by". */

(function (global) {
  'use strict';

  var CURVE = 0.09;          // edge control-point offset, as a fraction of edge length

  /* Position and tangent of a quadratic Bézier at parameter t. */
  function quadAt(ax, ay, cx, cy, bx, by, t) {
    var u = 1 - t;
    return {
      x: u * u * ax + 2 * u * t * cx + t * t * bx,
      y: u * u * ay + 2 * u * t * cy + t * t * by,
      dx: 2 * u * (cx - ax) + 2 * t * (bx - cx),
      dy: 2 * u * (cy - ay) + 2 * t * (by - cy)
    };
  }

  /* The point on the curve that sits `back` units short of its end. Near t=1 the
     curve advances at ~2·|b-c| per unit of t, which gives a first guess; one
     correction pass fixes the over-shoot that estimate has on short edges. */
  function quadBackFromEnd(ax, ay, cx, cy, bx, by, back) {
    var elen = Math.sqrt((bx - cx) * (bx - cx) + (by - cy) * (by - cy)) || 1;
    var s = Math.min(0.45, back / (2 * elen));
    var p = quadAt(ax, ay, cx, cy, bx, by, 1 - s);
    var d = Math.sqrt((p.x - bx) * (p.x - bx) + (p.y - by) * (p.y - by)) || 1e-6;
    return quadAt(ax, ay, cx, cy, bx, by, 1 - Math.min(0.45, s * back / d));
  }

  function TechGraph(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.nodes = [];
    this.links = [];
    this.byId = new Map();
    this.anchors = new Map();      // category -> {x, y} cluster centre
    this.tx = 0; this.ty = 0; this.scale = 1;
    this._gx = this._gy = 0.0016;  // centering pull per axis; _computeAnchors tunes it
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

    // label priority — when two labels collide the more influential one wins,
    // so the map thins out rather than overprinting itself
    this._order = this.nodes.slice().sort(function (x, y) {
      return (y.impact - x.impact) || (y.deg - x.deg) || x.name.localeCompare(y.name);
    });

    this._seedPositions();
    this._shapeToViewport(340);   // converge synchronously — the graph appears already laid out
    this.run(70, 0.25);           // then a short, gentle animated pass to polish
  };

  /* Domain anchors sit on an ellipse shaped like the canvas. That match is what
     keeps the map legible across screens: "fit to view" scales by the tighter of
     the two axes, so a wide layout in a tall phone viewport gets squeezed into a
     crowd with empty bands above and below it. Following the aspect instead
     spends the whole viewport on the graph. */
  TechGraph.prototype._computeAnchors = function () {
    var cats = this.categories.map(function (c) { return c.id; });
    var self = this;
    var aspect = (this.w && this.h) ? this.w / this.h : 1.3;
    aspect = Math.max(0.42, Math.min(2.6, aspect));      // stop extremes degenerating into a line
    var R = 300 * Math.sqrt(Math.max(1, this.nodes.length / 90));
    var rx = R * Math.sqrt(aspect), ry = R / Math.sqrt(aspect);
    cats.forEach(function (c, i) {
      var a = (i / cats.length) * Math.PI * 2 - Math.PI / 2;
      self.anchors.set(c, { x: Math.cos(a) * rx, y: Math.sin(a) * ry });
    });

    /* Anchors alone do not hold the shape: repulsion inflates whichever axis is
       meant to be short, and the cloud drifts back toward round. Pulling harder
       toward the centre along that axis is what actually keeps the proportions. */
    this._gx = 0.0016 / aspect;
    this._gy = 0.0016 * aspect;
    this._layoutAspect = aspect;
  };

  /* Seed each node near its domain's anchor on a ring — gives the layout an
     initial structure so clusters do not have to be discovered from noise. */
  TechGraph.prototype._seedPositions = function () {
    var self = this;
    this._computeAnchors();
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
     A few hundred ticks over this many nodes costs tens of milliseconds, and it
     means the user never watches the layout untangle itself. */
  TechGraph.prototype.settle = function (ticks) {
    this.alpha = 1;
    for (var i = 0; i < ticks; i++) {
      this._tick();
      this.alpha = Math.max(0.02, this.alpha * 0.99);
    }
  };

  /* Settle, then check what actually came out. Anchors only suggest a shape —
     repulsion spills clusters past the ring, and by how much depends on the
     data, so a ring computed from the viewport alone lands wide of the mark.
     Measuring the settled cloud and correcting the ring by the error converges
     in a pass or two, and it is still only a few milliseconds of arithmetic. */
  TechGraph.prototype._shapeToViewport = function (ticks) {
    var target = this._layoutAspect || 1;
    for (var pass = 0; pass < 4; pass++) {
      this.settle(pass ? 80 : ticks);
      var bb = this._bounds();
      if (!bb.w || !bb.h) return;
      var err = target / (bb.w / bb.h);
      if (Math.abs(Math.log(err)) < 0.035) return;          // close enough to the viewport
      // Stretching by exactly the error only closes about half of it — the
      // springs pull some of it back. Over-correcting by half again lands in
      // two passes instead of four, and stays short of oscillating.
      var f = Math.pow(Math.max(0.45, Math.min(2.2, err)), 0.75);
      this.anchors.forEach(function (a) { a.x *= f; a.y /= f; });
      // Carry the nodes with their anchors instead of making the springs drag
      // them there. The next pass then starts near equilibrium and only has to
      // undo the local overlaps the stretch created — 80 ticks, not 340.
      this.nodes.forEach(function (n) { n.x *= f; n.y /= f; n.vx = n.vy = 0; });
      this._gx /= f; this._gy *= f;
    }
  };

  TechGraph.prototype._bounds = function () {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    this.nodes.forEach(function (n) {
      minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
    });
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY, w: maxX - minX, h: maxY - minY };
  };

  /* `alpha` is the starting energy. A polish pass after the layout has already
     been shaped to the viewport wants a low one — at full energy it relaxes the
     cloud back toward round and gives back the fit it just gained. */
  TechGraph.prototype.run = function (ticks, alpha) {
    this.alpha = alpha == null ? 1 : alpha;
    this._ticksLeft = ticks || 300;
    this._loop();
  };

  /* Throw the layout away and build it again — the "re-layout" button. */
  TechGraph.prototype.relayout = function () {
    this._seedPositions();
    this._shapeToViewport(340);
    this.fit();
    this.run(70, 0.25);
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
      a.vx += (0 - a.x) * this._gx * k;
      a.vy += (0 - a.y) * this._gy * k;

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

  /* Re-aim the clusters at anchors for the current canvas shape and let the
     layout relax into them. Cheaper and far less disorienting than re-seeding:
     the map you were reading keeps its arrangement, it just changes proportion. */
  TechGraph.prototype.reflow = function () {
    if (!this.nodes.length || !this.w) return;
    this._computeAnchors();
    this._shapeToViewport(220);
    this.fit();
  };

  /* Only worth reshaping when the viewport genuinely changed proportion — a
     window nudge or a mobile URL bar sliding away should not move the graph. */
  TechGraph.prototype.reflowIfNeeded = function () {
    if (!this.nodes.length || !this.w || !this.h) return;
    var a = Math.max(0.42, Math.min(2.6, this.w / this.h));
    if (this._layoutAspect && Math.abs(Math.log(a / this._layoutAspect)) < 0.18) return;
    this.reflow();
  };

  TechGraph.prototype.fit = function () {
    if (!this.nodes.length || !this.w) return;
    var bb = this._bounds();
    // a phone cannot afford 70px of margin on every side the way a desktop can
    var pad = Math.max(16, Math.min(70, Math.min(this.w, this.h) * 0.08));
    var s = Math.min((this.w - pad * 2) / (bb.w || 1), (this.h - pad * 2) / (bb.h || 1));
    this.scale = Math.max(0.18, Math.min(2.2, s));
    this.tx = this.w / 2 - ((bb.minX + bb.maxX) / 2) * this.scale;
    this.ty = this.h / 2 - ((bb.minY + bb.maxY) / 2) * this.scale;
    this.redraw();
  };

  /* Nodes live in world units but still have to be visible on screen. Zoomed
     far out the smallest ones shrink to dust, so their drawn size stops at a
     screen-space floor — picking and labelling use the same number. */
  TechGraph.prototype._drawR = function (n) {
    return Math.max(n.r, 3.4 / this.scale);
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

      // gentle curve so parallel edges stay distinguishable
      var dx = b.x - a.x, dy = b.y - a.y;
      var cx = (a.x + b.x) / 2 - dy * CURVE;
      var cy = (a.y + b.y) / 2 + dx * CURVE;

      ctx.beginPath();
      ctx.setLineDash(l.kind === 'influence' ? [3, 4] : []);
      ctx.strokeStyle = on ? self.color(b.cat) : 'rgba(140,190,255,0.85)';
      ctx.globalAlpha = on ? 0.85 : op * 0.3;
      ctx.lineWidth = (on ? 1.7 : 0.9) / self.scale;   // constant width on screen
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.stroke();

      if (on) {
        /* Arrowhead toward the child. It has to sit on the curve and point along
           it — a quadratic's tangent at its end runs from the control point, not
           from the midpoint of the chord, which is ~10° off at this curvature. */
        var head = Math.max(6, Math.min(13, 9 / self.scale));
        var p = quadBackFromEnd(a.x, a.y, cx, cy, b.x, b.y, self._drawR(b) + head * 0.35);
        var ang = Math.atan2(p.dy, p.dx);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - Math.cos(ang - 0.38) * head, p.y - Math.sin(ang - 0.38) * head);
        ctx.lineTo(p.x - Math.cos(ang + 0.38) * head, p.y - Math.sin(ang + 0.38) * head);
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
      ctx.arc(n.x, n.y, self._drawR(n), 0, Math.PI * 2);
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
       readable size however far you zoom out. Two things keep them from becoming
       a wall of text: an impact floor at low zoom, and dropping any label that
       would overlap one already placed. Because they are laid down in order of
       influence, what survives on a crowded phone screen is the map's backbone,
       and zooming in reveals the rest — the labels thin out instead of colliding. */
    if (!this.showLabels) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    var placed = [];
    function claim(x, y, w, h) {
      for (var i = 0; i < placed.length; i++) {
        var r = placed[i];
        if (x + w / 2 > r.x0 && x - w / 2 < r.x1 && y + h > r.y0 && y < r.y1) return false;
      }
      placed.push({ x0: x - w / 2, x1: x + w / 2, y0: y, y1: y + h });
      return true;
    }

    var minImpact = this.scale > 0.7 ? 0 : this.scale > 0.45 ? 3 : 5;
    var order = this._order || this.nodes;

    // pass 0 reserves room for the focused node and its neighbours, so a
    // selection is never the thing that loses a collision
    for (var pass = focus ? 0 : 1; pass < 2; pass++) {
      for (var i = 0; i < order.length; i++) {
        var n = order[i];
        var isNear = n.id === focus || (near && near.has(n.id));
        if (pass === 0 ? !isNear : isNear && focus) continue;

        var op = alphaFor(n.id);
        if (op <= 0.12) continue;
        if (n.impact < minImpact && !isNear) continue;

        var sx = n.x * self.scale + self.tx;
        var sy = n.y * self.scale + self.ty + self._drawR(n) * self.scale + 4;
        if (sx < -80 || sx > self.w + 80 || sy < -20 || sy > self.h + 20) continue;

        var big = n.impact >= 5;
        ctx.font = (big ? '600 12px ' : '500 11px ') + 'ui-monospace, monospace';
        var key = big ? '_w6' : '_w5';
        if (n[key] == null) n[key] = ctx.measureText(n.name).width;   // width never changes
        if (!claim(sx, sy, n[key] + 8, 14)) continue;

        ctx.globalAlpha = op * (n.id === focus ? 1 : 0.82);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(5,7,13,0.92)';
        ctx.strokeText(n.name, sx, sy);
        ctx.fillStyle = n.id === focus ? '#fff' : '#c2d3e8';
        ctx.fillText(n.name, sx, sy);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  /* -------------------------------------------------------- interaction */
  TechGraph.prototype._toWorld = function (px, py) {
    return { x: (px - this.tx) / this.scale, y: (py - this.ty) / this.scale };
  };

  /* `slop` is a screen distance, converted here — a fixed world-space margin
     would shrink to nothing when zoomed out, exactly when nodes are hardest hit. */
  TechGraph.prototype._pick = function (px, py, slop) {
    var p = this._toWorld(px, py), best = null, bestD = Infinity;
    var pad = (slop == null ? 6 : slop) / this.scale;
    for (var i = 0; i < this.nodes.length; i++) {
      var n = this.nodes[i];
      if (this.dimmed.has(n.id)) continue;
      var dx = n.x - p.x, dy = n.y - p.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < this._drawR(n) + pad && d < bestD) { best = n; bestD = d; }
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

    /* ---------------------------------------------------------------- touch
       The mouse handlers above never fire for real gestures, so without this a
       phone can only zoom the page — the graph itself stays fixed. One finger
       pans or drags a node, two fingers pinch. The canvas carries
       touch-action:none so the browser hands us the gesture instead of
       scrolling and zooming the page underneath. */
    var touch = null;

    function tp(t) {
      var r = c.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    }
    function span(a, b) {
      var dx = b.x - a.x, dy = b.y - a.y;
      return Math.sqrt(dx * dx + dy * dy) || 1;
    }

    function startOne(t) {
      var p = tp(t);
      var n = self._pick(p.x, p.y, 14);           // fingers are blunter than cursors
      touch = { mode: n ? 'node' : 'pan', last: p, moved: false };
      if (n) { self.dragNode = n; self.alpha = Math.max(self.alpha, 0.35); self._loop(); }
    }

    function startTwo(t1, t2) {
      var p1 = tp(t1), p2 = tp(t2);
      var m = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      self.dragNode = null;
      touch = { mode: 'pinch', d0: span(p1, p2), s0: self.scale, w0: self._toWorld(m.x, m.y), moved: true };
    }

    c.addEventListener('touchstart', function (e) {
      e.preventDefault();          // also suppresses the synthetic mouse events that follow
      if (e.touches.length >= 2) startTwo(e.touches[0], e.touches[1]);
      else startOne(e.touches[0]);
    }, { passive: false });

    c.addEventListener('touchmove', function (e) {
      if (!touch) return;
      e.preventDefault();

      if (touch.mode === 'pinch' && e.touches.length >= 2) {
        var p1 = tp(e.touches[0]), p2 = tp(e.touches[1]);
        var mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
        var ns = Math.max(0.15, Math.min(3.5, touch.s0 * (span(p1, p2) / touch.d0)));
        // pinning the world point under the pinch centre zooms and pans at once
        self.scale = ns;
        self.tx = mx - touch.w0.x * ns;
        self.ty = my - touch.w0.y * ns;
        self.redraw();
        return;
      }

      var p = tp(e.touches[0]);
      var dx = p.x - touch.last.x, dy = p.y - touch.last.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) touch.moved = true;
      if (touch.mode === 'node' && self.dragNode) {
        var w = self._toWorld(p.x, p.y);
        self.dragNode.x = w.x; self.dragNode.y = w.y;
      } else if (touch.mode === 'pan') {
        self.tx += dx; self.ty += dy;
        self.redraw();
      }
      touch.last = p;
    }, { passive: false });

    function endTouch(e) {
      if (!touch) return;
      if (e.touches && e.touches.length) {
        // dropping from two fingers to one continues as a pan, never as a tap
        if (e.touches.length === 1) touch = { mode: 'pan', last: tp(e.touches[0]), moved: true };
        return;
      }
      if (!touch.moved) {
        if (touch.mode === 'node' && self.dragNode && self.opts.onSelect) self.opts.onSelect(self.dragNode.id);
        else if (touch.mode === 'pan' && self.opts.onBlank) self.opts.onBlank();
      }
      self.dragNode = null;
      touch = null;
    }

    c.addEventListener('touchend', endTouch);
    c.addEventListener('touchcancel', endTouch);
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
