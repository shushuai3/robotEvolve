# -*- coding: utf-8 -*-
"""Seed the JSON database from the Python seed modules.

Run once to bootstrap:   python tools/generate.py

After bootstrapping, data/ is the source of truth. Edit the JSON directly (or via
tools/add_tech.py) and run tools/validate.py. Re-running this script will
overwrite data/technologies.json, data/labs.json and every data/tech/<id>.json,
so pass --force once you have started editing JSON by hand.
"""
import argparse
import datetime as _dt
import hashlib
import json
import os
import sys

# Windows consoles default to a legacy code page (cp1252) that cannot encode
# characters like the "pi" in "Physical Intelligence"; without this, printing a
# lab or entry name raises UnicodeEncodeError.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
TECH_DIR = os.path.join(DATA, "tech")

sys.path.insert(0, HERE)

from seed_labs import CATEGORIES, LABS            # noqa: E402
from seed_vla_1 import VLA_1                      # noqa: E402
from seed_vla_2 import VLA_2                      # noqa: E402
from seed_il import IL                            # noqa: E402
from seed_rep import REP                          # noqa: E402
from seed_rl import RL                            # noqa: E402
from seed_wm import WM                            # noqa: E402
from seed_vlm import VLM                          # noqa: E402
from seed_human import HUMAN                      # noqa: E402
# aliased: DATA is already the data/ directory constant below
from seed_data import DATA as DATASETS            # noqa: E402
from seed_benchmarks import BENCH                 # noqa: E402
from seed_sim import SIM                          # noqa: E402

ALL_TECHS = VLA_1 + VLA_2 + IL + REP + RL + WM + VLM + HUMAN + DATASETS + BENCH + SIM

# Fields that live in the lightweight index (loaded up front, drives list + graph).
INDEX_FIELDS = (
    "id", "name", "full_name", "cat", "year", "month", "orgs", "parents",
    "influences", "license", "tags", "impact", "confidence", "tagline",
    "paper", "code", "site",
)
# Fields that live in the per-tech detail file (fetched on click).
DETAIL_FIELDS = ("summary", "innovation", "matters", "limits", "lineage")

TODAY = _dt.date.today().isoformat()


def build_index_record(t):
    rec = {}
    for f in INDEX_FIELDS:
        if f in t and t[f] not in (None, [], ""):
            rec[f] = t[f]
    rec.setdefault("parents", [])
    rec.setdefault("influences", [])
    rec.setdefault("tags", [])
    rec.setdefault("orgs", [])
    rec.setdefault("impact", 3)
    rec.setdefault("confidence", "medium")
    rec["detailPath"] = "data/tech/%s.json" % t["id"]
    return rec


def build_detail_record(t):
    rec = {"id": t["id"], "name": t["name"]}
    for f in DETAIL_FIELDS:
        if f in t:
            rec[f] = t[f]
    links = []
    if t.get("paper"):
        links.append({"label": "Paper", "url": t["paper"], "kind": "paper"})
    if t.get("code"):
        links.append({"label": "Code / weights", "url": t["code"], "kind": "code"})
    if t.get("site"):
        links.append({"label": "Project page", "url": t["site"], "kind": "site"})
    q = (t.get("full_name") or t["name"]) + " robot manipulation"
    links.append({
        "label": "Search Google Scholar",
        "url": "https://scholar.google.com/scholar?q=" + q.replace(" ", "+"),
        "kind": "search",
    })
    rec["links"] = links
    return rec


# ---------------------------------------------------------------- timestamps

# `updated` must mean "this entry's content last changed", not "the generator last
# ran". So we hash the content, store the hash, and only advance the date when the
# hash actually moves. Without this, regenerating rewrites all 108 files with
# today's date and the field carries no information at all.
# `detailPath` is excluded too: it is a pure function of the id, so hashing it would
# make a change to the storage layout look like a change to the entry's content.
HASH_EXCLUDED = ("added", "updated", "content_hash", "detailPath")


def content_hash(index_rec, detail_rec):
    payload = {
        "index": {k: v for k, v in index_rec.items() if k not in HASH_EXCLUDED},
        "detail": {k: v for k, v in detail_rec.items() if k not in HASH_EXCLUDED},
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def resolve_dates(detail_path, new_hash):
    """Return (added, updated) for an entry, carrying dates forward when unchanged."""
    if not os.path.isfile(detail_path):
        return TODAY, TODAY                       # brand new entry
    try:
        with open(detail_path, encoding="utf-8") as fh:
            old = json.load(fh)
    except (OSError, ValueError):
        return TODAY, TODAY

    added = old.get("added") or old.get("updated") or TODAY
    if old.get("content_hash") == new_hash:
        return added, old.get("updated", TODAY)   # unchanged: keep the old date
    if "content_hash" not in old:
        # Migrating a file written before hashing existed. We cannot tell whether the
        # content moved, so preserve the recorded date rather than inventing a change.
        return added, old.get("updated", TODAY)
    return added, TODAY                           # content genuinely changed


def check(techs):
    """Fail loudly on broken references before writing anything."""
    ids = set()
    errors = []
    for t in techs:
        if t["id"] in ids:
            errors.append("duplicate id: %s" % t["id"])
        ids.add(t["id"])
    lab_ids = {l["id"] for l in LABS}
    cat_ids = {c["id"] for c in CATEGORIES}
    for t in techs:
        if t["cat"] not in cat_ids:
            errors.append("%s: unknown category %r" % (t["id"], t["cat"]))
        for o in t.get("orgs", []):
            if o not in lab_ids:
                errors.append("%s: unknown org %r (add it to seed_labs.LABS)" % (t["id"], o))
        for p in t.get("parents", []) + t.get("influences", []):
            if p not in ids:
                errors.append("%s: edge points at unknown tech %r" % (t["id"], p))
    return errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="overwrite an existing data/ directory")
    args = ap.parse_args()

    if os.path.exists(os.path.join(DATA, "technologies.json")) and not args.force:
        print("data/technologies.json already exists. Re-run with --force to overwrite.")
        return 1

    errors = check(ALL_TECHS)
    if errors:
        print("Refusing to write, %d problem(s) found:" % len(errors))
        for e in errors:
            print("  -", e)
        return 1

    os.makedirs(TECH_DIR, exist_ok=True)

    techs = sorted(ALL_TECHS, key=lambda t: (-t["year"], -t.get("month", 0), t["name"].lower()))

    index_records, detail_records, changed, new = [], [], [], []
    for t in techs:
        idx_rec = build_index_record(t)
        det_rec = build_detail_record(t)
        path = os.path.join(TECH_DIR, "%s.json" % t["id"])
        existed = os.path.isfile(path)

        h = content_hash(idx_rec, det_rec)
        added, updated = resolve_dates(path, h)
        idx_rec["added"], idx_rec["updated"] = added, updated
        det_rec["added"], det_rec["updated"], det_rec["content_hash"] = added, updated, h

        if not existed:
            new.append(t["id"])
        elif updated == TODAY and added != TODAY:
            changed.append(t["id"])

        index_records.append(idx_rec)
        detail_records.append((path, det_rec))

    last_changed = max(r["updated"] for r in index_records) if index_records else TODAY
    write_json(os.path.join(DATA, "technologies.json"), {
        "schema_version": 2,
        "generated": TODAY,           # when this file was written
        "last_changed": last_changed,  # when any entry's content last actually moved
        "counts": {
            "technologies": len(techs),
            "labs": len(LABS),
            "categories": len(CATEGORIES),
        },
        "categories": CATEGORIES,
        "technologies": index_records,
    })

    write_json(os.path.join(DATA, "labs.json"), {
        "schema_version": 2,
        "generated": TODAY,
        "note": "priority 1 = check weekly, 2 = monthly, 3 = quarterly. "
                "Used by tools/update_queue.py to order the update crawl.",
        "labs": sorted(LABS, key=lambda l: (l["priority"], l["name"].lower())),
    })

    for path, det_rec in detail_records:
        write_json(path, det_rec)

    if new:
        print("  new:     %d (%s)" % (len(new), ", ".join(sorted(new)[:6]) + ("…" if len(new) > 6 else "")))
    if changed:
        print("  changed: %d (%s)" % (len(changed), ", ".join(sorted(changed)[:6]) + ("…" if len(changed) > 6 else "")))
    if not new and not changed:
        print("  no content changes — every `updated` date left untouched.")

    print("Wrote %d technologies, %d labs, %d category definitions."
          % (len(techs), len(LABS), len(CATEGORIES)))
    print("  data/technologies.json")
    print("  data/labs.json")
    print("  data/tech/*.json  (%d files)" % len(techs))
    return 0


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


if __name__ == "__main__":
    sys.exit(main())
