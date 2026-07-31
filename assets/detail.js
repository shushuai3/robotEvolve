/* RobotEvolve — shared detail panel + entry index.
   Loaded before the page script.
   Exposes window.RE = { registerEntries, markSourceLoaded, openDetail,
                         fetchJSON, fmtDate, category, esc }. */
(function () {
  "use strict";

  // List files that can resolve an id -> entry (title, date, detailPath, ...).
  // Fetched lazily and at most once each, only when an id can't be resolved
  // from what the page already loaded (keeps the initial payload small).
  var LIST_SOURCES = ["data/news.json"];

  var entryIndex = new Map();
  var loadedSources = new Set();
  var lastFocused = null;
  var overlay = null;
  var panelBody = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // e.g. 2026-07-15 -> "Jul 15, 2026".
  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso + "T00:00:00");
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  // "news" | "tech" — anything unrecognised falls back to "tech".
  function category(entry) {
    return String((entry && entry.category) || "tech").toLowerCase() === "news"
      ? "news" : "tech";
  }

  function fetchJSON(path) {
    return fetch(path).then(function (res) {
      if (!res.ok) throw new Error(path + ": HTTP " + res.status);
      return res.json();
    });
  }

  function registerEntries(entries) {
    (entries || []).forEach(function (e) {
      if (e && e.id) entryIndex.set(e.id, e);
    });
  }

  function markSourceLoaded(path) {
    loadedSources.add(path);
  }

  // Resolve an id, lazily pulling in list files we haven't loaded yet.
  function ensureEntry(id) {
    if (entryIndex.has(id)) return Promise.resolve(entryIndex.get(id));
    var pending = LIST_SOURCES.filter(function (s) { return !loadedSources.has(s); });
    var p = Promise.resolve();
    pending.forEach(function (src) {
      p = p.then(function () {
        if (entryIndex.has(id)) return;
        loadedSources.add(src);
        return fetchJSON(src).then(registerEntries).catch(function (err) {
          console.warn("RobotEvolve: could not load " + src, err);
        });
      });
    });
    return p.then(function () { return entryIndex.get(id) || null; });
  }

  /* ---------- overlay ---------- */

  function buildOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "detail-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="detail-panel" role="dialog" aria-modal="true" aria-label="Technology detail">' +
      '<button type="button" class="detail-close" aria-label="Close">×</button>' +
      '<div class="detail-body"></div>' +
      "</div>";
    document.body.appendChild(overlay);
    panelBody = overlay.querySelector(".detail-body");

    overlay.querySelector(".detail-close").addEventListener("click", closeDetail);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeDetail();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !overlay.hidden) closeDetail();
    });
  }

  function closeDetail() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.classList.remove("modal-open");
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
  }

  function showOverlay() {
    buildOverlay();
    if (overlay.hidden) {
      lastFocused = document.activeElement;
      overlay.hidden = false;
      document.body.classList.add("modal-open");
    }
    overlay.scrollTop = 0;
  }

  function openDetail(id) {
    showOverlay();
    panelBody.innerHTML = '<p class="detail-loading">Loading…</p>';
    overlay.querySelector(".detail-close").focus();

    return ensureEntry(id)
      .then(function (entry) {
        if (!entry) throw new Error("Unknown entry id: " + id);
        return fetchJSON(entry.detailPath).then(function (detail) {
          return renderDetail(entry, detail);
        });
      })
      .catch(function (err) {
        console.warn("RobotEvolve: detail load failed", err);
        panelBody.innerHTML =
          '<p class="detail-loading">The detail file could not be loaded. ' +
          "Please try again later.</p>";
      });
  }

  function renderDetail(entry, detail) {
    var tags = detail.tags || entry.tags || [];
    var links = detail.links || {};
    var linkHtml = ["code", "paper", "project", "news"]
      .filter(function (k) { return links[k]; })
      .map(function (k, i) {
        var label = k.charAt(0).toUpperCase() + k.slice(1);
        return '<a class="link-btn' + (i > 0 ? " ghost" : "") + '" href="' + esc(links[k]) +
          '" target="_blank" rel="noopener">' + label + "</a>";
      })
      .join("");

    panelBody.innerHTML =
      '<p class="detail-kicker">' +
      '<span class="cat-pill cat-' + category(entry) + '">' + category(entry) + "</span>" +
      esc(entry.organization) + " · " + esc(fmtDate(entry.date)) +
      "</p>" +
      "<h2>" + esc(detail.title || entry.title) + "</h2>" +
      '<div class="chip-row">' + tags.map(function (t) {
        return '<span class="chip">' + esc(t) + "</span>";
      }).join("") + "</div>" +
      "<h3>Summary</h3><p>" + esc(detail.summary) + "</p>" +
      "<h3>Why it matters</h3><p>" + esc(detail.whyItMatters) + "</p>" +
      (linkHtml ? "<h3>Links</h3>" + '<div class="link-row">' + linkHtml + "</div>" : "");
  }

  window.RE = {
    registerEntries: registerEntries,
    markSourceLoaded: markSourceLoaded,
    openDetail: openDetail,
    fetchJSON: fetchJSON,
    fmtDate: fmtDate,
    category: category,
    esc: esc
  };
})();
