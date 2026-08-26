#!/usr/bin/env python3
"""Check the JSON database for broken references and missing fields.

    python tools/validate.py

Exits non-zero if anything is wrong, so it can be wired into a pre-commit hook.
"""
import datetime as dt
import hashlib
import json
import os
import sys

# Windows consoles default to a legacy code page (cp1252) that cannot encode
# characters like the "pi" in "Physical Intelligence"; without this, printing a
# lab or entry name raises UnicodeEncodeError.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
TODAY = dt.date.today()

# Kept identical to tools/generate.py — if one changes, change both.
HASH_EXCLUDED = ("added", "updated", "content_hash", "detailPath")


def content_hash(index_rec, detail_rec):
    payload = {
        "index": {k: v for k, v in index_rec.items() if k not in HASH_EXCLUDED},
        "detail": {k: v for k, v in detail_rec.items() if k not in HASH_EXCLUDED},
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]

REQUIRED = ("id", "name", "cat", "year", "orgs", "license", "tagline", "detailPath")
DETAIL_REQUIRED = ("summary", "innovation")
LICENSES = {"open", "weights", "code", "closed"}
CONFIDENCE = {"high", "medium"}


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main():
    problems = []
    warnings = []

    index = load(os.path.join(DATA, "technologies.json"))
    labs = load(os.path.join(DATA, "labs.json"))

    techs = index["technologies"]
    cat_ids = {c["id"] for c in index["categories"]}
    lab_ids = {l["id"] for l in labs["labs"]}
    tech_ids = set()

    for t in techs:
        tid = t.get("id", "<missing id>")
        if tid in tech_ids:
            problems.append("duplicate id: %s" % tid)
        tech_ids.add(tid)
        for f in REQUIRED:
            if f not in t or t[f] in (None, ""):
                problems.append("%s: missing required field %r" % (tid, f))
        if t.get("cat") not in cat_ids:
            problems.append("%s: unknown category %r" % (tid, t.get("cat")))
        if t.get("license") not in LICENSES:
            problems.append("%s: license %r not in %s" % (tid, t.get("license"), sorted(LICENSES)))
        if t.get("confidence", "medium") not in CONFIDENCE:
            problems.append("%s: confidence %r not in %s" % (tid, t.get("confidence"), sorted(CONFIDENCE)))
        for o in t.get("orgs", []):
            if o not in lab_ids:
                problems.append("%s: org %r is not in labs.json" % (tid, o))
        if not t.get("orgs"):
            warnings.append("%s: no orgs listed" % tid)

    for t in techs:
        tid = t["id"]
        for p in t.get("parents", []):
            if p not in tech_ids:
                problems.append("%s: parent %r does not exist" % (tid, p))
            if p == tid:
                problems.append("%s: is its own parent" % tid)
        for p in t.get("influences", []):
            if p not in tech_ids:
                problems.append("%s: influence %r does not exist" % (tid, p))

    # cycle detection over parent edges
    parents = {t["id"]: [p for p in t.get("parents", []) if p in tech_ids] for t in techs}
    WHITE, GREY, BLACK = 0, 1, 2
    color = {k: WHITE for k in parents}

    def walk(node, stack):
        color[node] = GREY
        for p in parents.get(node, []):
            if color.get(p) == GREY:
                problems.append("parent cycle: %s" % " -> ".join(stack + [node, p]))
            elif color.get(p) == WHITE:
                walk(p, stack + [node])
        color[node] = BLACK

    sys.setrecursionlimit(10000)
    for k in list(parents):
        if color[k] == WHITE:
            walk(k, [])

    # detail files
    on_disk = set()
    tech_dir = os.path.join(DATA, "tech")
    if os.path.isdir(tech_dir):
        on_disk = {f[:-5] for f in os.listdir(tech_dir) if f.endswith(".json")}

    for t in techs:
        tid = t["id"]
        # detailPath is relative to the site root, so it resolves the same way here as
        # it does in the browser — no base directory to remember or get wrong.
        rel = t.get("detailPath", "")
        expected = "data/tech/%s.json" % tid
        if rel and rel != expected:
            problems.append("%s: detailPath is %r, expected %r" % (tid, rel, expected))
        path = os.path.join(ROOT, rel.replace("/", os.sep))
        if not os.path.isfile(path):
            problems.append("%s: detail file missing: %s" % (tid, rel))
            continue
        try:
            d = load(path)
        except Exception as e:                                   # noqa: BLE001
            problems.append("%s: detail file is not valid JSON (%s)" % (tid, e))
            continue
        if d.get("id") != tid:
            problems.append("%s: detail file id is %r" % (tid, d.get("id")))
        for f in DETAIL_REQUIRED:
            if not d.get(f):
                problems.append("%s: detail file missing %r" % (tid, f))
        if len(d.get("summary", "")) < 80:
            warnings.append("%s: summary is very short" % tid)

        # Timestamp sanity. `updated` means "content last changed", so a future date
        # or added-after-updated means something wrote it wrong.
        added, updated = d.get("added"), d.get("updated")
        for label, val in (("added", added), ("updated", updated)):
            if not val:
                warnings.append("%s: detail file has no %r date" % (tid, label))
                continue
            try:
                when = dt.date.fromisoformat(val)
            except ValueError:
                problems.append("%s: %s is not an ISO date: %r" % (tid, label, val))
                continue
            if when > TODAY:
                problems.append("%s: %s is in the future (%s)" % (tid, label, val))
        if added and updated and added > updated:
            problems.append("%s: added (%s) is after updated (%s)" % (tid, added, updated))

        # A stale hash means the file was hand-edited without bumping `updated`.
        idx_rec = {k: v for k, v in t.items() if k not in HASH_EXCLUDED}
        det_rec = {k: v for k, v in d.items() if k not in HASH_EXCLUDED}
        if "content_hash" not in d:
            warnings.append("%s: no content_hash — run tools/generate.py to add one" % tid)
        elif content_hash(idx_rec, det_rec) != d["content_hash"]:
            warnings.append(
                "%s: content_hash is stale — the entry was edited without bumping "
                "`updated` (regenerate, or use tools/add_tech.py)" % tid)

    for orphan in sorted(on_disk - tech_ids):
        warnings.append("data/tech/%s.json has no entry in technologies.json" % orphan)

    for l in labs["labs"]:
        if l.get("priority") not in (1, 2, 3):
            problems.append("lab %s: priority must be 1, 2 or 3" % l.get("id"))
        for f in l.get("focus", []):
            if f not in cat_ids:
                problems.append("lab %s: focus %r is not a category" % (l["id"], f))

    unreferenced = sorted(lab_ids - {o for t in techs for o in t.get("orgs", [])})
    if unreferenced:
        warnings.append("labs with no technologies attributed: " + ", ".join(unreferenced))

    print("%d technologies, %d labs, %d categories" % (len(techs), len(labs["labs"]), len(cat_ids)))
    for w in warnings:
        print("  warn  %s" % w)
    if problems:
        print("\n%d PROBLEM(S):" % len(problems))
        for p in problems:
            print("  FAIL  %s" % p)
        return 1
    print("\nOK — database is consistent.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
