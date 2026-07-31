/* RobotEvolve — single-scroll front page.
   Weekly news = cards for entries dated in the last 7 days (news/tech
   category left and date right on one line above the title, organization
   under it) flowing left-to-right, then down;
   Trend = hottest-topics bar chart (entries per topic). Fetches the
   single news list file; detail files stay lazy in detail.js. */
(function () {
  "use strict";

  var sky = document.getElementById("sky");
  var skyStatus = document.getElementById("sky-status");
  var topicChart = document.getElementById("topic-chart");
  var MAX_NEWS = 12;
  var MAX_TOPICS = 10;

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

  var SOURCE = "data/news.json";
  var DAY_MS = 24 * 60 * 60 * 1000;

  function dateMs(e) {
    var t = new Date((e.date || "") + "T00:00:00").getTime();
    return isNaN(t) ? 0 : t;
  }

  // Newest first; ISO dates compare lexicographically, title breaks ties.
  function byDateDesc(a, b) {
    return (b.date || "").localeCompare(a.date || "") ||
      (a.title || "").localeCompare(b.title || "");
  }

  // Entries dated within the trailing 7-day window ending today. If the
  // data hasn't been refreshed for over a week, fall back to the window
  // ending at the newest entry so the sky is never empty.
  function lastSevenDays(entries) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    function windowEnding(endMs) {
      return entries.filter(function (e) {
        var t = dateMs(e);
        return t >= endMs - 6 * DAY_MS && t <= endMs;
      });
    }
    var week = windowEnding(today.getTime());
    if (week.length) return week;
    var newest = entries.reduce(function (m, e) { return Math.max(m, dateMs(e)); }, 0);
    return newest ? windowEnding(newest) : [];
  }

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

    var week = lastSevenDays(all);

    if (week.length) {
      renderSky(
        week
          .slice()
          .sort(byDateDesc)
          .slice(0, MAX_NEWS)
      );
    } else {
      skyStatus.textContent =
        "This week's data could not be loaded. Please refresh in a moment.";
      skyStatus.hidden = false;
    }

    if (all.length) renderTopics(all);
  }).catch(function (err) {
    console.warn("RobotEvolve: could not load " + SOURCE, err);
    skyStatus.textContent =
      "This week's data could not be loaded. Please refresh in a moment.";
    skyStatus.hidden = false;
  });

  function renderSky(entries) {
    // Entries arrive newest-first and flow left-to-right, wrapping down,
    // so the latest news reads first; the browser decides how many fit
    // per row from the display width.
    var frag = document.createDocumentFragment();

    entries.forEach(function (entry) {
      // news/tech + date on one line above the title, organization below it.
      var cat = RE.category(entry);

      var el = document.createElement("button");
      el.type = "button";
      el.className = "sky-card cat-" + cat;
      // Randomized 6–10s bob, negative delay so cards start desynchronized.
      el.style.setProperty("--bob-dur", (6 + Math.random() * 4).toFixed(2) + "s");
      el.style.setProperty("--bob-delay", (-Math.random() * 6).toFixed(2) + "s");
      el.setAttribute("aria-label",
        cat + ": " + entry.title +
        (entry.organization ? ", " + entry.organization : "") + " — open details");

      el.innerHTML =
        '<span class="sky-meta">' +
        '<span class="cat-pill cat-' + cat + '">' + cat + "</span>" +
        '<span class="sky-date">' +
        (entry.date ? RE.esc(RE.fmtDate(entry.date)) : "") + "</span>" +
        "</span>" +
        '<span class="sky-label">' + RE.esc(entry.title) + "</span>" +
        '<span class="sky-org">' +
        (entry.organization ? RE.esc(entry.organization) : "") + "</span>";

      el.addEventListener("click", function () { RE.openDetail(entry.id); });
      frag.appendChild(el);
    });

    sky.appendChild(frag);
  }

  /* ---------- shared tag aggregation ---------- */

  // tag -> { entries: [entry, ...] (newest first) }
  function aggregateTags(entries) {
    var byTag = new Map();
    entries.forEach(function (e) {
      (e.tags || []).forEach(function (t) {
        if (!byTag.has(t)) byTag.set(t, { entries: [] });
        byTag.get(t).entries.push(e);
      });
    });
    byTag.forEach(function (agg) { agg.entries.sort(byDateDesc); });
    return byTag;
  }

  /* ---------- trend: hottest topics bar chart ---------- */

  // Topics ranked by how many tracked entries carry the tag.
  function renderTopics(entries) {
    var byTag = aggregateTags(entries);
    var topics = Array.from(byTag.keys())
      .map(function (t) { return { tag: t, entries: byTag.get(t).entries }; })
      .sort(function (a, b) {
        return b.entries.length - a.entries.length || a.tag.localeCompare(b.tag);
      })
      .slice(0, MAX_TOPICS);
    if (!topics.length) return;

    var max = topics[0].entries.length || 1;
    var tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;

    var frag = document.createDocumentFragment();
    topics.forEach(function (topic) {
      var lead = topic.entries[0];
      var row = document.createElement("button");
      row.type = "button";
      row.className = "topic-row";
      row.setAttribute("aria-label",
        topic.tag + ": " + topic.entries.length +
        (topic.entries.length === 1 ? " entry" : " entries") +
        ", led by " + lead.title + " — open details");

      row.innerHTML =
        '<span class="topic-head">' +
        '<span class="topic-name">' + RE.esc(topic.tag) + "</span>" +
        '<span class="topic-rep">' + RE.esc(lead.title) + "</span>" +
        '<span class="topic-val">' + topic.entries.length + "</span>" +
        "</span>" +
        '<span class="topic-track"><span class="topic-fill" style="--w:' +
        ((topic.entries.length / max) * 100).toFixed(1) + '%"></span></span>';

      row.addEventListener("click", function () { RE.openDetail(lead.id); });
      row.addEventListener("mouseenter", function () { showTip(row, topic); });
      row.addEventListener("focus", function () { showTip(row, topic); });
      row.addEventListener("mouseleave", hideTip);
      row.addEventListener("blur", hideTip);
      frag.appendChild(row);
    });

    topicChart.appendChild(frag);
    topicChart.appendChild(tip);

    function showTip(row, topic) {
      var items = topic.entries.slice(0, 3).map(function (e) {
        return '<span class="tip-item">' + RE.esc(e.title) +
          '<b>' + RE.esc(RE.fmtDate(e.date)) + "</b></span>";
      }).join("");
      var more = topic.entries.length - 3;
      tip.innerHTML =
        '<span class="tip-title">' + RE.esc(topic.tag) + " · " +
        topic.entries.length + (topic.entries.length === 1 ? " entry" : " entries") + "</span>" +
        items +
        (more > 0 ? '<span class="tip-more">+ ' + more + " more</span>" : "");
      tip.hidden = false;
      var top = row.offsetTop - tip.offsetHeight - 6;
      tip.style.top = Math.max(0, top) + "px";
      tip.style.left = Math.min(row.offsetLeft + 20, topicChart.clientWidth - tip.offsetWidth - 4) + "px";
    }

    function hideTip() { tip.hidden = true; }
  }

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
    nodes.forEach(function (el) {
      if (revealObserver) revealObserver.observe(el);
      else el.classList.add("visible");
    });
  }

  observeReveals(document.querySelectorAll(".reveal"));
})();
