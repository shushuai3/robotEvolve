#!/usr/bin/env python3
"""Add or update one technology in the JSON database.

Interactive:
    python tools/add_tech.py

Non-interactive (handy for scripting or for an agent doing the update sweep):
    python tools/add_tech.py --json entry.json

The JSON payload accepts the same keys used in the seed modules:
    id, name, full_name, cat, year, month, orgs[], parents[], influences[],
    license, paper, code, site, tags[], impact, confidence, tagline,
    summary, innovation[], matters[], limits[], lineage

Index fields land in data/technologies.json; the prose fields become
data/tech/<id>.json. Run tools/validate.py afterwards.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys

# Windows consoles default to a legacy code page (cp1252) that cannot encode
# characters like the "pi" in "Physical Intelligence"; without this, printing a
# lab or entry name raises UnicodeEncodeError.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
TECH_PATH = os.path.join(DATA, "technologies.json")
LABS_PATH = os.path.join(DATA, "labs.json")

INDEX_FIELDS = ("id", "name", "full_name", "cat", "year", "month", "orgs", "parents",
                "influences", "license", "tags", "impact", "confidence", "tagline",
                "paper", "code", "site")
DETAIL_FIELDS = ("summary", "innovation", "matters", "limits", "lineage")
LICENSES = ("open", "weights", "code", "closed")

# Kept identical to tools/generate.py and tools/validate.py.
HASH_EXCLUDED = ("added", "updated", "content_hash", "detailPath")


def content_hash(index_rec, detail_rec):
    payload = {
        "index": {k: v for k, v in index_rec.items() if k not in HASH_EXCLUDED},
        "detail": {k: v for k, v in detail_rec.items() if k not in HASH_EXCLUDED},
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def load(p):
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def save(p, obj):
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def ask(prompt, default=None, required=False, choices=None):
    while True:
        suffix = " [%s]" % default if default else ""
        v = input("%s%s: " % (prompt, suffix)).strip()
        if not v and default is not None:
            v = default
        if choices and v not in choices:
            print("  must be one of: %s" % ", ".join(choices))
            continue
        if required and not v:
            print("  required.")
            continue
        return v


def ask_list(prompt, valid=None):
    print("%s (comma separated, blank to skip)" % prompt)
    raw = input("  > ").strip()
    if not raw:
        return []
    items = [x.strip() for x in raw.split(",") if x.strip()]
    if valid:
        bad = [i for i in items if i not in valid]
        if bad:
            print("  unknown: %s" % ", ".join(bad))
            print("  valid: %s" % ", ".join(sorted(valid)))
            return ask_list(prompt, valid)
    return items


def ask_bullets(prompt):
    print("%s (one per line, blank line to finish)" % prompt)
    out = []
    while True:
        v = input("  - ").strip()
        if not v:
            return out
        out.append(v)


def interactive(index, labs):
    cats = [c["id"] for c in index["categories"]]
    lab_ids = {l["id"] for l in labs["labs"]}
    tech_ids = {t["id"] for t in index["technologies"]}

    print("\nCategories: %s" % ", ".join(cats))
    print("Labs: %s\n" % ", ".join(sorted(lab_ids)))

    e = {}
    e["name"] = ask("Name", required=True)
    e["id"] = ask("id", default=slug(e["name"]))
    fn = ask("Full name / paper title", default="")
    if fn:
        e["full_name"] = fn
    e["cat"] = ask("Category", choices=cats, required=True)
    e["year"] = int(ask("Year", default=str(dt.date.today().year)))
    m = ask("Month (1-12, blank ok)", default="")
    if m:
        e["month"] = int(m)
    e["orgs"] = ask_list("Org ids", lab_ids)
    e["parents"] = ask_list("Parent tech ids (what it derives from)", tech_ids)
    e["influences"] = ask_list("Influenced-by tech ids", tech_ids)
    e["license"] = ask("Access", choices=LICENSES, default="closed")
    for k, label in (("paper", "Paper URL"), ("code", "Code URL"), ("site", "Project page URL")):
        v = ask(label, default="")
        if v:
            e[k] = v
    e["tags"] = ask_list("Tags")
    e["impact"] = int(ask("Influence rating 1-5", default="3"))
    e["confidence"] = ask("Confidence", choices=("high", "medium"), default="medium")
    e["tagline"] = ask("One-line hook", required=True)
    print()
    e["summary"] = ask("Summary paragraph", required=True)
    e["innovation"] = ask_bullets("Key innovation")
    e["matters"] = ask_bullets("Why it matters")
    e["limits"] = ask_bullets("Limitations")
    e["lineage"] = ask("Lineage sentence", default="")
    return e


def upsert(entry, index, labs):
    cats = {c["id"] for c in index["categories"]}
    lab_ids = {l["id"] for l in labs["labs"]}
    tech_ids = {t["id"] for t in index["technologies"]}

    errs = []
    if not entry.get("id"):
        errs.append("id is required")
    if entry.get("cat") not in cats:
        errs.append("cat %r must be one of %s" % (entry.get("cat"), sorted(cats)))
    if entry.get("license") not in LICENSES:
        errs.append("license %r must be one of %s" % (entry.get("license"), list(LICENSES)))
    for o in entry.get("orgs", []):
        if o not in lab_ids:
            errs.append("org %r not in labs.json — add the lab first" % o)
    for p in entry.get("parents", []) + entry.get("influences", []):
        if p not in tech_ids and p != entry.get("id"):
            errs.append("edge target %r does not exist" % p)
    if errs:
        for e in errs:
            print("  FAIL  %s" % e)
        return 1

    tid = entry["id"]
    rec = {k: entry[k] for k in INDEX_FIELDS if entry.get(k) not in (None, "", [])}
    rec.setdefault("parents", [])
    rec.setdefault("influences", [])
    rec.setdefault("tags", [])
    rec.setdefault("orgs", [])
    rec.setdefault("impact", 3)
    rec.setdefault("confidence", "medium")
    rec["detailPath"] = "data/tech/%s.json" % tid

    detail = {"id": tid, "name": entry["name"]}
    for f in DETAIL_FIELDS:
        if entry.get(f):
            detail[f] = entry[f]
    links = []
    if entry.get("paper"):
        links.append({"label": "Paper", "url": entry["paper"], "kind": "paper"})
    if entry.get("code"):
        links.append({"label": "Code / weights", "url": entry["code"], "kind": "code"})
    if entry.get("site"):
        links.append({"label": "Project page", "url": entry["site"], "kind": "site"})
    q = (entry.get("full_name") or entry["name"]) + " robot manipulation"
    links.append({"label": "Search Google Scholar",
                  "url": "https://scholar.google.com/scholar?q=" + q.replace(" ", "+"),
                  "kind": "search"})
    detail["links"] = links

    # `updated` tracks content, not clock. Only advance it when the entry actually
    # differs from what is already on disk, so a no-op re-add stays a no-op.
    today = dt.date.today().isoformat()
    detail_path = os.path.join(DATA, "tech", "%s.json" % tid)
    h = content_hash(rec, detail)
    added, updated, verb = today, today, "Added"
    if os.path.isfile(detail_path):
        try:
            old = load(detail_path)
        except ValueError:
            old = {}
        added = old.get("added") or old.get("updated") or today
        if old.get("content_hash") == h:
            updated, verb = old.get("updated", today), "Unchanged"
        else:
            verb = "Updated"
    rec["added"], rec["updated"] = added, updated
    detail["added"], detail["updated"], detail["content_hash"] = added, updated, h

    techs = [t for t in index["technologies"] if t["id"] != tid]
    techs.append(rec)
    techs.sort(key=lambda t: (-t["year"], -t.get("month", 0), t["name"].lower()))
    index["technologies"] = techs
    index["generated"] = today
    index["last_changed"] = max(t.get("updated", today) for t in techs)
    index["counts"]["technologies"] = len(techs)
    save(TECH_PATH, index)
    save(detail_path, detail)

    print("\n%s  %s" % (verb, tid))
    print("  data/technologies.json  (%d entries)" % len(techs))
    print("  data/tech/%s.json  (updated %s, added %s)" % (tid, updated, added))
    print("\nNow run:  python tools/validate.py")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", help="path to a JSON file holding one entry, or - for stdin")
    args = ap.parse_args()

    index = load(TECH_PATH)
    labs = load(LABS_PATH)

    if args.json:
        raw = sys.stdin.read() if args.json == "-" else open(args.json, encoding="utf-8").read()
        entry = json.loads(raw)
        entries = entry if isinstance(entry, list) else [entry]
        for e in entries:
            if upsert(e, index, labs):
                return 1
            index = load(TECH_PATH)
        return 0

    return upsert(interactive(index, labs), index, labs)


if __name__ == "__main__":
    sys.exit(main())
