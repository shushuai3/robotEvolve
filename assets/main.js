/* RobotEvolve — single-scroll front page, three sections:

     1 · Recent technology — model, method, dataset and code releases
         (category "tech") as floating cards, tag and date above the title;
     2 · Recent news — deployments, funding and industry moves
         (category "news") as a dated list, newest first;
     3 · Techniques by category — every tech entry grouped into the four tag
         facets, each technique expandable into the work behind it. News never
         appears here.

   Sections 1 and 2 are independent weekly streams: each starts at its own
   newest seven-day window, backfills older weeks until it holds at least
   MIN_VISIBLE entries, and appends the preceding week per click — so a quiet
   week on one side never blanks it or the other. Fetches the single news
   list file; detail files stay lazy in detail.js. */
(function () {
  "use strict";

  var SOURCE = "data/news.json";
  var MAX_TAG_ENTRIES = 6;      // entries listed when a technique row expands
  var MIN_VISIBLE = 12;         // per section: open with at least this many

  /* ---------- phone nav toggle ---------- */

  var navToggle = document.getElementById("navToggle");
  var siteNav = document.getElementById("siteNav");
  if (navToggle && siteNav) {
    navToggle.addEventListener("click", function () {
      var open = siteNav.classList.toggle("open");
      navToggle.classList.toggle("open", open);
      navToggle.setAttribute("aria-expanded", String(open));
    });
    // Anchor navigation keeps the page; close the menu so it doesn't cover it.
    siteNav.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        siteNav.classList.remove("open");
        navToggle.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- dates ---------- */

  function dateMs(e) {
    var t = new Date((e.date || "") + "T00:00:00").getTime();
    return isNaN(t) ? 0 : t;
  }

  // Newest first; ISO dates compare lexicographically, title breaks ties.
  function byDateDesc(a, b) {
    return (b.date || "").localeCompare(a.date || "") ||
      (a.title || "").localeCompare(b.title || "");
  }

  // Day arithmetic on local midnights (setDate, not ±ms) so a DST shift can
  // never land a window boundary on the wrong day.
  function addDays(ms, days) {
    var d = new Date(ms);
    d.setDate(d.getDate() + days);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /* ---------- weekly stream ----------
     Week 0 is the seven days ending at the anchor, week 1 the seven before
     that, and so on; a stream starts at week 0 and each "load more" click
     reveals one more week of its own history. A thin week reads as a broken
     page, so a stream that opens with fewer than MIN_VISIBLE entries keeps
     pulling older weeks in until it clears that floor or runs out of
     history — whole weeks at a time, each under its own dated divider, so
     the dividers never imply a week held less than it did. */

  function createStream(cfg) {
    var entries = (cfg.entries || []).slice().sort(byDateDesc);
    var container = cfg.container;
    var loadMore = cfg.loadMore;
    if (!container) return;

    if (!entries.length) {
      if (cfg.status) {
        cfg.status.textContent = cfg.emptyText;
        cfg.status.hidden = false;
      }
      if (loadMore) loadMore.hidden = true;
      return;
    }

    // The newest window ends today. If this stream hasn't been refreshed for
    // over a week, anchor on its newest entry instead so it is never empty.
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var todayMs = today.getTime();
    var newestMs = entries.reduce(function (m, e) { return Math.max(m, dateMs(e)); }, 0);
    var anchorMs = newestMs >= addDays(todayMs, -6) ? todayMs : (newestMs || todayMs);

    var oldestMs = entries.reduce(function (m, e) {
      var t = dateMs(e);
      return t && (!m || t < m) ? t : m;
    }, 0);
    var weeksShown = 0;
    var shown = 0;      // entries on screen, against the MIN_VISIBLE floor

    function windowEnd(weeksBack) { return addDays(anchorMs, -7 * weeksBack); }
    function windowStart(weeksBack) { return addDays(anchorMs, -7 * weeksBack - 6); }

    // A whole week, uncapped: the window already bounds the batch, and dropping
    // the tail would strand entries no later click can ever reach.
    function weekEntries(weeksBack) {
      var start = windowStart(weeksBack);
      var end = windowEnd(weeksBack);
      return entries.filter(function (e) {
        var t = dateMs(e);
        return t >= start && t <= end;
      });
    }

    // Anything left before the oldest window on screen?
    function hasOlder() {
      return weeksShown > 0 && oldestMs > 0 && oldestMs < windowStart(weeksShown - 1);
    }

    // Full-width rule naming the week a freshly loaded batch belongs to, e.g.
    // "Jul 19 – Jul 25, 2026", so appended history stays readable as weeks.
    function appendWeekLabel(weeksBack) {
      function day(ms, opts) { return new Date(ms).toLocaleDateString(undefined, opts); }
      var label =
        day(windowStart(weeksBack), { month: "short", day: "numeric" }) + " – " +
        day(windowEnd(weeksBack), { year: "numeric", month: "short", day: "numeric" });

      var el = document.createElement("p");
      el.className = "week-divider";
      el.innerHTML = "<span>" + RE.esc(label) + "</span>";
      container.appendChild(el);
    }

    function updateLoadMore() {
      if (loadMore) loadMore.hidden = !hasOlder();
    }

    // One click = one more week. Weeks with no entries are skipped over, so a
    // click always reveals something rather than appending nothing.
    function showOlderWeek() {
      var batch = [];
      while (!batch.length && hasOlder()) {
        batch = weekEntries(weeksShown);
        weeksShown++;
      }
      if (batch.length) {
        appendWeekLabel(weeksShown - 1);
        cfg.render(container, batch);
        shown += batch.length;
      }
      updateLoadMore();
    }

    if (loadMore) loadMore.addEventListener("click", showOlderWeek);

    var first = weekEntries(0);
    cfg.render(container, first);
    shown = first.length;
    weeksShown = 1;

    // Backfill a thin opening week. Each pass either appends a week or
    // exhausts the history, so this always terminates.
    while (shown < MIN_VISIBLE && hasOlder()) showOlderWeek();

    updateLoadMore();
  }

  /* ---------- 1 · recent technology ---------- */

  // Cards flow left-to-right, wrapping down, so the latest reads first; the
  // browser decides how many fit per row from the display width. The pill
  // carries the entry's leading tag — every card here is already "tech".
  function renderTechCards(container, entries) {
    var frag = document.createDocumentFragment();

    entries.forEach(function (entry) {
      var tag = (entry.tags && entry.tags[0]) || "robotics";

      var el = document.createElement("button");
      el.type = "button";
      el.className = "sky-card";
      // Randomized 6–10s bob, negative delay so cards start desynchronized.
      el.style.setProperty("--bob-dur", (6 + Math.random() * 4).toFixed(2) + "s");
      el.style.setProperty("--bob-delay", (-Math.random() * 6).toFixed(2) + "s");
      el.setAttribute("aria-label",
        "Technology: " + entry.title +
        (entry.organization ? ", " + entry.organization : "") + " — open details");

      el.innerHTML =
        '<span class="sky-meta">' +
        '<span class="tag-pill">' + RE.esc(tag) + "</span>" +
        '<span class="sky-date">' +
        (entry.date ? RE.esc(RE.fmtDate(entry.date)) : "") + "</span>" +
        "</span>" +
        '<span class="sky-label">' + RE.esc(entry.title) + "</span>" +
        '<span class="sky-org">' +
        (entry.organization ? RE.esc(entry.organization) : "") + "</span>";

      el.addEventListener("click", function () { RE.openDetail(entry.id); });
      frag.appendChild(el);
    });

    container.appendChild(frag);
  }

  /* ---------- 2 · recent news ---------- */

  // One row per story: day block, headline over organization, up to three
  // tags. The tags are decorative on narrow screens and hidden by CSS there.
  function renderNewsList(container, entries) {
    var frag = document.createDocumentFragment();

    entries.forEach(function (entry) {
      var d = new Date((entry.date || "") + "T00:00:00");
      var day = isNaN(d) ? "--" : ("0" + d.getDate()).slice(-2);
      var month = isNaN(d)
        ? ""
        : d.toLocaleDateString(undefined, { month: "short" }).toUpperCase();

      var tags = (entry.tags || []).slice(0, 3).map(function (t) {
        return '<span class="chip-mini">' + RE.esc(t) + "</span>";
      }).join("");

      var el = document.createElement("button");
      el.type = "button";
      el.className = "news-row";
      el.setAttribute("aria-label",
        "News: " + entry.title +
        (entry.organization ? ", " + entry.organization : "") +
        (entry.date ? ", " + RE.fmtDate(entry.date) : "") + " — open details");

      el.innerHTML =
        '<span class="news-day" aria-hidden="true"><b>' + day + "</b><i>" + month + "</i></span>" +
        '<span class="news-main">' +
        '<span class="news-title">' + RE.esc(entry.title) + "</span>" +
        '<span class="news-org">' +
        (entry.organization ? RE.esc(entry.organization) : "") + "</span>" +
        "</span>" +
        '<span class="news-tags" aria-hidden="true">' + tags + "</span>" +
        '<span class="news-go" aria-hidden="true">→</span>';

      el.addEventListener("click", function () { RE.openDetail(entry.id); });
      frag.appendChild(el);
    });

    container.appendChild(frag);
  }

  /* ---------- 3 · techniques by category ---------- */

  // The four facets of the tag vocabulary (see README). Order inside a group
  // is by entry count, not by this list; anything outside the vocabulary
  // collects in "Other". Each group carries its own hue for the bars.
  var TAG_GROUPS = [
    {
      name: "Models & methods",
      grp: "#22d3ee", grp2: "#8b5cf6",
      tags: ["vla", "world-model", "foundation-model", "reinforcement-learning",
             "imitation-learning", "diffusion-policy", "planning"]
    },
    {
      name: "Capabilities",
      grp: "#a78bfa", grp2: "#e879f9",
      tags: ["manipulation", "locomotion", "navigation", "perception", "multi-robot"]
    },
    {
      name: "Systems & resources",
      grp: "#34d399", grp2: "#22d3ee",
      tags: ["simulation", "dataset", "benchmark", "efficiency", "hardware"]
    },
    {
      name: "Embodiment & industry",
      grp: "#fbbf24", grp2: "#fb923c",
      tags: ["humanoid", "industry", "funding", "deployment"]
    }
  ];
  var OTHER_GROUP = { name: "Other", grp: "#94a3b8", grp2: "#64748b", tags: [] };

  // tag -> [entry, ...] newest first
  function aggregateTags(entries) {
    var byTag = new Map();
    entries.forEach(function (e) {
      (e.tags || []).forEach(function (t) {
        if (!byTag.has(t)) byTag.set(t, []);
        byTag.get(t).push(e);
      });
    });
    byTag.forEach(function (list) { list.sort(byDateDesc); });
    return byTag;
  }

  // "All 20 technology entries · Apr 7 – Aug 5, 2026" — this board counts the
  // whole history, unlike the two weekly streams above it, and says so.
  function renderCoverage(el, entries) {
    if (!el) return;
    var stamps = entries.map(dateMs).filter(Boolean).sort();
    if (!stamps.length) return;

    function day(ms, opts) { return new Date(ms).toLocaleDateString(undefined, opts); }
    var oldest = stamps[0];
    var newest = stamps[stamps.length - 1];
    var span = oldest === newest
      ? day(newest, { year: "numeric", month: "short", day: "numeric" })
      : day(oldest, { month: "short", day: "numeric" }) + " – " +
        day(newest, { year: "numeric", month: "short", day: "numeric" });

    el.textContent = "All " + entries.length + " technology entries · " + span;
    el.hidden = false;
  }

  function renderCategories(board, entries) {
    var byTag = aggregateTags(entries);
    if (!byTag.size) return;

    renderCoverage(document.getElementById("cat-range"), entries);

    // Bars are normalized against the busiest technique overall, so a bar in
    // one card is directly comparable with a bar in another.
    var max = 1;
    byTag.forEach(function (list) { max = Math.max(max, list.length); });

    var claimed = new Set();
    TAG_GROUPS.forEach(function (group) {
      group.tags.forEach(function (t) { claimed.add(t); });
    });
    var leftovers = Array.from(byTag.keys()).filter(function (t) {
      return !claimed.has(t);
    });

    var groups = TAG_GROUPS.concat(
      leftovers.length ? [{ name: OTHER_GROUP.name, grp: OTHER_GROUP.grp,
                            grp2: OTHER_GROUP.grp2, tags: leftovers }] : []);

    var frag = document.createDocumentFragment();
    var rowId = 0;

    groups.forEach(function (group) {
      var rows = group.tags
        .filter(function (t) { return byTag.has(t); })
        .map(function (t) { return { tag: t, entries: byTag.get(t) }; })
        .sort(function (a, b) {
          return b.entries.length - a.entries.length || a.tag.localeCompare(b.tag);
        });
      if (!rows.length) return;   // a facet with nothing tracked stays off the board

      // An entry tagged twice inside one facet is one entry, not two.
      var members = new Set();
      rows.forEach(function (row) {
        row.entries.forEach(function (e) { members.add(e.id); });
      });

      var card = document.createElement("section");
      card.className = "cat-card";
      card.style.setProperty("--grp", group.grp);
      card.style.setProperty("--grp-2", group.grp2);
      card.innerHTML =
        '<h3 class="cat-title"><span class="cat-name">' + RE.esc(group.name) + "</span>" +
        '<span class="cat-total">' + members.size +
        (members.size === 1 ? " entry" : " entries") + "</span></h3>";

      var list = document.createElement("div");
      list.className = "cat-rows";

      rows.forEach(function (row) {
        var panelId = "tagpanel-" + (rowId++);
        var lead = row.entries[0];

        var item = document.createElement("div");
        item.className = "tag-item";

        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tag-row";
        btn.setAttribute("aria-expanded", "false");
        btn.setAttribute("aria-controls", panelId);
        btn.setAttribute("aria-label",
          row.tag + ": " + row.entries.length +
          (row.entries.length === 1 ? " entry" : " entries") +
          ", latest " + lead.title + " — show the list");
        btn.innerHTML =
          '<span class="tag-line">' +
          '<span class="tag-name">' + RE.esc(row.tag) + "</span>" +
          '<span class="tag-lead">' + RE.esc(lead.title) + "</span>" +
          '<span class="tag-val">' + row.entries.length + "</span>" +
          "</span>" +
          '<span class="tag-track"><span class="tag-fill" style="--w:' +
          ((row.entries.length / max) * 100).toFixed(1) + '%"></span></span>';

        var panel = document.createElement("div");
        panel.className = "tag-panel";
        panel.id = panelId;
        panel.hidden = true;

        row.entries.slice(0, MAX_TAG_ENTRIES).forEach(function (e) {
          var link = document.createElement("button");
          link.type = "button";
          link.className = "tag-entry";
          link.setAttribute("aria-label", e.title + " — open details");
          link.innerHTML =
            "<span>" + RE.esc(e.title) + "</span>" +
            "<b>" + RE.esc(RE.fmtDate(e.date)) + "</b>";
          link.addEventListener("click", function () { RE.openDetail(e.id); });
          panel.appendChild(link);
        });

        var hidden = row.entries.length - MAX_TAG_ENTRIES;
        if (hidden > 0) {
          var more = document.createElement("p");
          more.className = "tag-more";
          more.textContent = "+ " + hidden + " more";
          panel.appendChild(more);
        }

        btn.addEventListener("click", function () {
          var open = btn.getAttribute("aria-expanded") === "true";
          btn.setAttribute("aria-expanded", String(!open));
          panel.hidden = open;
        });

        item.appendChild(btn);
        item.appendChild(panel);
        list.appendChild(item);
      });

      card.appendChild(list);
      frag.appendChild(card);
    });

    board.appendChild(frag);
    // The board was empty when the page-load pass ran, so an observer that
    // saw a zero-height target never fired; re-observe now that it has size.
    observeReveals([board]);
  }

  /* ---------- load ---------- */

  var techStatus = document.getElementById("tech-status");
  var newsStatus = document.getElementById("news-status");

  RE.fetchJSON(SOURCE).then(function (entries) {
    RE.markSourceLoaded(SOURCE);
    RE.registerEntries(entries);

    var all = [];
    var seen = new Set();
    (entries || []).forEach(function (e) {
      if (e && e.id && !seen.has(e.id)) {
        seen.add(e.id);
        all.push(e);
      }
    });

    // RE.category falls back to "tech", so news is the explicit set and
    // technology is everything else — an unlabelled entry is never lost.
    var news = all.filter(function (e) { return RE.category(e) === "news"; });
    var tech = all.filter(function (e) { return RE.category(e) !== "news"; });

    createStream({
      entries: tech,
      container: document.getElementById("tech-sky"),
      status: techStatus,
      loadMore: document.getElementById("techMore"),
      render: renderTechCards,
      emptyText: "No technology entries yet."
    });

    createStream({
      entries: news,
      container: document.getElementById("news-list"),
      status: newsStatus,
      loadMore: document.getElementById("newsMore"),
      render: renderNewsList,
      emptyText: "No news entries yet."
    });

    var board = document.getElementById("cat-board");
    if (board && tech.length) renderCategories(board, tech);
  }).catch(function (err) {
    console.warn("RobotEvolve: could not load " + SOURCE, err);
    [techStatus, newsStatus].forEach(function (el) {
      if (!el) return;
      el.textContent = "This section could not be loaded. Please refresh in a moment.";
      el.hidden = false;
    });
  });

  /* ---------- scroll reveal ---------- */

  var revealObserver = null;
  if ("IntersectionObserver" in window) {
    revealObserver = new IntersectionObserver(function (hits) {
      hits.forEach(function (hit) {
        if (hit.isIntersecting) {
          hit.target.classList.add("visible");
          revealObserver.unobserve(hit.target);
        }
      });
    }, { threshold: 0.12 });
  }

  function observeReveals(nodes) {
    Array.prototype.forEach.call(nodes, function (el) {
      if (!revealObserver) {
        el.classList.add("visible");
        return;
      }
      // observe() is a no-op on an already-watched target, so drop the old
      // observation first: that is what re-arms a target rendered after load.
      revealObserver.unobserve(el);
      revealObserver.observe(el);
    });
  }

  observeReveals(document.querySelectorAll(".reveal"));
})();
