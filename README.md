# RobotEvolve

**[www.robotevolve.com](https://www.robotevolve.com)**

A self-contained webpage that collects, summarises and graphs the technologies behind
robot manipulation intelligence — VLA models, world action models, imitation learning,
reinforcement learning, world models and dreaming, VLM grounding, representations,
human/egocentric data, robot datasets, benchmarks and simulators.

**123 technologies · 48 labs and companies · 11 domains · 1989 → 2026**

---

## Run it

```bash
python serve.py            # opens http://localhost:8000
```

A local server is required. The page loads its database with `fetch()`, and browsers block
that on `file://` URLs. Any static server works (`python -m http.server`, `npx serve`, nginx);
`serve.py` just adds no-cache headers so edits show up on refresh.

---

## What the page does

| View | What it shows |
| --- | --- |
| **Graph** | Force-directed map of every technology. Colour = domain, node size = influence rating, solid edge = *derives from*, dotted edge = *influenced by*. Hover isolates a node's neighbourhood, drag to rearrange, scroll to zoom, click to open the detail panel. |
| **Index** | Filterable card grid — the "latest tech list". Sorts by publication date, influence, name, or when the entry was added/edited here. |
| **Timeline** | The same set laid out by year, so you can see when each branch appeared. |
| **Labs** | The priority watchlist that drives updates, with the source links for each lab. |

Filters (domain, access, year, free-text search) apply to all views at once. Search also
matches lab names and tags. Press `/` to jump to the search box, `Esc` to close the panel.
Opening a technology puts its id in the URL hash, so `index.html#diffusion-policy` is a
shareable deep link.

---

## Data model

`data/` is the source of truth. Nothing is hardcoded in the HTML or JS.

```
data/
  technologies.json     index: one lightweight record per technology (loaded up front)
  labs.json             the lab/company watchlist with update priorities
  tech/
    <id>.json           one file per technology: summary, key innovation, limits, links
                        — fetched only when you click that technology
```

This split is deliberate: the index stays small enough to drive the graph and the filters
instantly, and the prose (which is the bulk of the bytes) loads on demand and is cached
per session.

Each index record points at its detail file with `detailPath`, written from the **site root**
(`data/tech/openvla.json`, not `tech/openvla.json`). The browser `fetch()`es the value
as-is, so the string in the JSON is the same one you would type to open the file — no base
directory to remember, and nothing to rewrite if the loader ever moves. It stays a relative
path rather than `/data/…`, so serving the repo from a subdirectory still works.

Because the path is a pure function of the id it is excluded from `content_hash`, so a
change to the storage layout can never look like a change to an entry's content.
`validate.py` checks each `detailPath` against the canonical `data/tech/<id>.json`.

### A technology record

```jsonc
{
  "id": "openvla",
  "name": "OpenVLA",
  "full_name": "…",              // paper title, optional
  "cat": "vla",                  // one of the 11 category ids
  "year": 2024, "month": 6,
  "orgs": ["stanford-iris", …],  // ids that must exist in labs.json
  "parents":    ["rt-2", …],     // "derives from"  → solid graph edge
  "influences": ["octo"],        // "influenced by" → dotted graph edge
  "license": "open",             // open | weights | code | closed
  "paper": "https://…",
  "code":  "https://…",
  "tags":  ["7B", "LoRA"],
  "impact": 5,                   // 1–5, drives node size
  "confidence": "high",          // high | medium — "medium" renders a "verify" chip
  "tagline": "one line…",
  "detailPath": "data/tech/openvla.json",   // relative to the site root
  "added":   "2026-08-25",       // mirrored from the detail file for sorting
  "updated": "2026-08-25"
}
```

### A detail file

```jsonc
{
  "id": "openvla",
  "summary": "paragraph…",
  "innovation": ["…", "…"],      // key innovation bullets
  "matters":    ["…"],           // why it matters
  "limits":     ["…"],           // limitations
  "lineage":    "one sentence on where it came from",
  "links":      [{ "label": "Paper", "url": "…", "kind": "paper" }],
  "added":        "2026-08-25",  // first appeared on the site
  "updated":      "2026-08-25",  // content last actually changed
  "content_hash": "a1b2c3d4…"    // how "actually" is decided
}
```

### What `updated` means

`updated` is the date this entry's **content** last changed — not the date the site was
last rebuilt. Those are different, and conflating them makes the field worthless: a naive
generator stamps today's date on all 123 files on every run, so `updated` ends up meaning
"when did I last run the script".

So the tooling hashes each entry's content (index fields plus detail fields, excluding the
dates themselves) into `content_hash`. On regeneration, if the hash is unchanged the old
`updated` is carried forward untouched; if it moved, `updated` advances. Regeneration is
therefore idempotent — run `generate.py --force` ten times and no dates move:

```
$ python tools/generate.py --force
  no content changes — every `updated` date left untouched.
```

`add_tech.py` follows the same rule and will report `Unchanged` rather than `Updated` when
you re-add an identical entry. `validate.py` recomputes every hash and warns when one is
stale, which catches a detail file edited by hand without its date being bumped, and fails
on dates in the future or `added` later than `updated`.

At the index level, `generated` is when `technologies.json` was written and `last_changed`
is the most recent real content change across all entries. The header stat shows
`last_changed`, and the Index view can sort by **recently added here** / **recently edited
here** — both distinct from sorting by publication date.

### Why not just use the release date?

`year`/`month` is a fact about the world: when the work came out. It is immutable, and an
immutable field cannot carry a maintenance signal. `updated` is a fact about *this site* —
how current our description is. The two are independent. Ego4D is from 2021 but its entry
here is new; Cosmos is from 2025 and its entry may already be behind.

That distinction is load-bearing because a large share of entries are marked
`"confidence": "medium"`, meaning not fully verified. The question you actually want to ask
of those is *"checked as of when?"*, and only `updated` answers it — which is what
`update_queue.py --verify` consumes to build a re-verification queue.

`added` is the weaker of the two, admittedly. It earns its place by powering "what is new
here since I last looked", which release-date sorting cannot express: adding a 1989 entry
today buries it at the bottom of a chronological list. It costs one field and no extra
machinery, since the hash was already needed for `updated`.

### Categories

`vla` · `il` · `rl` · `world-model` · `wam` · `vlm` · `rep` · `data` · `bench` ·
`human-data` · `sim` — defined with their display names, colours and blurbs in
`data/technologies.json` under `categories`.

**`wam`** is the newest and the one that needed an argument. World models have been in the
map since PlaNet, but they were always *auxiliary*: you learned dynamics, then planned or
dreamed against them with a separate policy. DreamZero collapsed that — video and action
tokens denoised together in one backbone, so the generative model of the future *is* the
controller. That is a different object from a VLA with a world model attached, and NVIDIA
re-founding GR00T on it, LeRobot shipping a world-model policy class, and VLA-JEPA showing
the same gain from latent rather than pixel prediction made it a branch rather than a
paper. `world-model` keeps the auxiliary lineage (Dreamer, Genie, V-JEPA, Cosmos); `wam`
holds the ones where prediction and control are one model.

Three further categories carve up what a coarser taxonomy would lump together as "data",
and the distinctions are load-bearing:

- **`data`** — real robot trajectories and the means of getting them. Answers *what do we
  train on*: Open X-Embodiment, DROID, BridgeData, RoboTurk, LeRobot, MimicGen.
- **`bench`** — task suites and evaluation methodology. Answers *how do we know it worked*:
  LIBERO, CALVIN, RLBench, Meta-World, BEHAVIOR-1K, SIMPLER, robomimic. Kept separate
  because evaluation is the weaker half of the field — robomimic and the LBM study both
  exist to show that reported gains often do not survive a controlled protocol.
- **`human-data`** — the one that is easiest to miss. Teleoperated robot data tops out
  around 10⁴ hours worldwide; egocentric human video is 10⁹ hours and growing. What human
  video lacks is action labels, and closing that gap — latent action models, hand
  retargeting, human/robot co-training — is its own technical domain. Entries elsewhere in
  the site depend on it: R3M and GR-1 pretrain on Ego4D, and GR00T N1's data pyramid rests
  on latent actions inferred from action-free human video.

---

## Tools

```bash
python tools/validate.py           # check refs, cycles, missing fields, orphan files
python tools/add_tech.py           # interactive prompt to add or update one entry
python tools/add_tech.py --json e.json   # or feed it JSON (also accepts a list, or -)
python tools/update_queue.py       # prioritised crawl checklist from labs.json
python tools/update_queue.py --verify    # entries whose description has gone stale
```

See **[UPDATING.md](UPDATING.md)** for the update workflow.

### Re-seeding

`tools/seed_*.py` hold the original corpus as Python, and `tools/generate.py` writes the
JSON from them. That path exists so the initial corpus could be authored in one place.
**Once you start editing `data/` by hand, stop using it** — `generate.py --force` rewrites
every record from the Python seed, silently discarding hand edits. (It will preserve your
`added`/`updated` dates, since those are content-derived, but that is no consolation if the
content itself is gone.) Use `add_tech.py` instead.

---

## Accuracy

Entries marked `"confidence": "medium"` render a dashed **verify** chip in the UI and a
notice in the detail panel. These are entries where the organisation, exact date, or link
is worth checking against a primary source before you rely on it — typically recent
blog-announced industry work with no paper, or arXiv identifiers that should be confirmed.
Everything else is marked `high`, but the whole database was written from a model's
knowledge and should be treated as a well-organised starting point, not a citation source.
Every detail panel includes a Google Scholar search link for exactly this reason.

---

## Layout

```
robotEvolve/
  index.html
  serve.py
  CNAME              www.robotevolve.com
  .nojekyll          publish the tree verbatim, no Jekyll pass
  assets/
    css/style.css
    js/graph.js        force simulation + canvas renderer, no dependencies
    js/app.js          data loading, views, filters, detail drawer
    favicon.svg        brand mark
    og-image.svg       social preview card
  data/                the database (see above)
  tools/
    generate.py        seed JSON from the Python corpus (one-time)
    validate.py        consistency checks
    add_tech.py        add / update an entry
    update_queue.py    prioritised update crawl list
    seed_*.py          the original corpus
  README.md
  UPDATING.md
  LICENSE            MIT — the code
  LICENSE-DATA       CC BY 4.0 — the database and the prose
```

No build step, no package manager, no CDN calls. The graph, the layout engine and the
rendering are hand-written in ~450 lines of plain JS.

---

## Hosting

Live on GitHub Pages at **[www.robotevolve.com](https://www.robotevolve.com)**, served from
the repository root of the default branch — **Settings → Pages → Deploy from a branch**,
`/ (root)`. Pushing to that branch is the deploy; there is no build step to wait on.

The site is entirely static and every path in it is document-relative, so it also runs
unchanged from a subdirectory or any other static host. `serve.py` and `tools/` are
published along with everything else — Pages copies the tree verbatim — but nothing on the
page loads them, and Pages executes no server-side code, so they are inert. They are
development conveniences, not runtime dependencies.

`.nojekyll` is present so Pages skips the Jekyll pass and publishes the tree as-is. The
custom domain is set: `CNAME` holds `www.robotevolve.com`, matched by **Settings → Pages →
Custom domain** and a DNS `CNAME` record for `www` pointing at `<user>.github.io`. Keep
**Enforce HTTPS** on.

Two things that pass locally and fail on Pages, both worth remembering when editing `data/`:

- **Paths are case-sensitive there and not on Windows or macOS.** A `detailPath` of
  `data/tech/RT-1.json` against a file named `rt-1.json` loads fine locally and 404s in
  production. `validate.py` compares each `detailPath` against the canonical
  `data/tech/<id>.json`, so run it before pushing.
- **Deep links are hash-based** (`#diffusion-policy`), which needs no 404 fallback or
  rewrite rules — the server only ever sees a request for `/`.

---

## License

Code (`index.html`, `assets/`, `serve.py`, the tooling) — **MIT**, see [LICENSE](LICENSE).

Database and written content (`data/`, the seed corpus, this documentation) —
**CC BY 4.0**, see [LICENSE-DATA](LICENSE-DATA).

The entries describe third-party papers, models and datasets that remain under their own
authors' terms; the linked sources are the authority on them.
