#!/usr/bin/env python3
"""Print a prioritised crawl checklist from data/labs.json.

    python tools/update_queue.py                 # priority 1 labs (weekly sweep)
    python tools/update_queue.py --priority 2    # priority 1 and 2
    python tools/update_queue.py --all           # everything
    python tools/update_queue.py --stale 30      # only labs not checked in 30 days
    python tools/update_queue.py --markdown > TODO.md
    python tools/update_queue.py --mark google-deepmind   # record a check as done

The `last_checked` field is written back into data/labs.json by --mark, so the
watchlist doubles as the log of what has already been swept.
"""
import argparse
import datetime as dt
import json
import os
import sys

# Windows consoles default to a legacy code page (cp1252) that cannot encode
# characters like the "pi" in "Physical Intelligence"; without this, printing a
# lab or entry name raises UnicodeEncodeError.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LABS_PATH = os.path.join(ROOT, "data", "labs.json")
TECH_PATH = os.path.join(ROOT, "data", "technologies.json")

CADENCE = {1: 7, 2: 30, 3: 90}   # days between checks, by priority


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def days_since(iso):
    if not iso:
        return None
    try:
        return (dt.date.today() - dt.date.fromisoformat(iso)).days
    except ValueError:
        return None


def verify_queue(techs, args):
    """Entries whose claims are due a re-check.

    This is what `updated` is for. Release date (year/month) is immutable and so can
    never tell you whether a description has gone stale; `updated` is the only field
    that can. Lower-confidence entries age fastest, so they surface first.
    """
    cutoff = args.stale if args.stale is not None else 90
    rows = []
    for t in techs:
        age = days_since(t.get("updated"))
        conf = t.get("confidence", "medium")
        # medium-confidence entries were never fully verified, so they are due sooner
        due = cutoff // 2 if conf == "medium" else cutoff
        if age is None or age >= due:
            rows.append((0 if conf == "medium" else 1, -(age or 9999), t, age, conf))

    rows.sort(key=lambda r: (r[0], r[1], r[2]["name"].lower()))

    if args.markdown:
        print("# Verification sweep — %s\n" % dt.date.today().isoformat())
        print("Entries whose description has not been re-checked recently. Confirm against "
              "a primary source, then re-save via `tools/add_tech.py` to advance `updated`.\n")
    else:
        print("\n=== Entries due for verification (threshold %d days, %d days if unverified) ==="
              % (cutoff, cutoff // 2))

    for _, _, t, age, conf in rows:
        age_s = "never" if age is None else "%d days" % age
        flag = "UNVERIFIED" if conf == "medium" else "confirmed"
        if args.markdown:
            print("- [ ] **%s** (%s) — %s, last checked %s" % (t["name"], t["year"], flag, age_s))
            if t.get("paper"):
                print("      - %s" % t["paper"])
        else:
            print("\n  [ ] %-34s %s %s" % (t["name"], t["year"], "  <-- " + flag if conf == "medium" else ""))
            print("      last checked: %s" % age_s)
            if t.get("paper"):
                print("      %s" % t["paper"])

    unver = sum(1 for r in rows if r[4] == "medium")
    print("\n%d entr%s queued (%d never verified)."
          % (len(rows), "y" if len(rows) == 1 else "ies", unver))
    if not args.markdown:
        print("After confirming one, re-save it so `updated` advances:")
        print("  python tools/add_tech.py            (or edit the seed and regenerate)")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--priority", type=int, default=1, help="include labs up to this priority")
    ap.add_argument("--all", action="store_true", help="include every lab")
    ap.add_argument("--stale", type=int, default=None, help="only labs unchecked for N+ days")
    ap.add_argument("--due", action="store_true", help="only labs past their cadence")
    ap.add_argument("--markdown", action="store_true", help="emit a markdown checklist")
    ap.add_argument("--mark", metavar="LAB_ID", help="stamp a lab as checked today")
    ap.add_argument("--verify", action="store_true",
                    help="queue technology entries whose description is stale, "
                         "rather than labs (uses each entry's `updated` date)")
    args = ap.parse_args()

    labs_doc = load(LABS_PATH)
    labs = labs_doc["labs"]

    if args.mark:
        hit = [l for l in labs if l["id"] == args.mark]
        if not hit:
            print("No lab with id %r. Known ids:" % args.mark)
            for l in labs:
                print("  " + l["id"])
            return 1
        hit[0]["last_checked"] = dt.date.today().isoformat()
        with open(LABS_PATH, "w", encoding="utf-8") as fh:
            json.dump(labs_doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        print("Marked %s checked on %s." % (args.mark, hit[0]["last_checked"]))
        return 0

    techs = load(TECH_PATH)["technologies"]

    if args.verify:
        return verify_queue(techs, args)

    latest = {}
    for t in techs:
        for o in t.get("orgs", []):
            key = (t["year"], t.get("month", 0))
            if key > latest.get(o, (0, 0, ""))[:2]:
                latest[o] = (t["year"], t.get("month", 0), t["name"])

    cutoff = args.priority if not args.all else 3
    sel = [l for l in labs if l["priority"] <= cutoff]

    if args.due:
        sel = [l for l in sel
               if days_since(l.get("last_checked")) is None
               or days_since(l["last_checked"]) >= CADENCE[l["priority"]]]
    if args.stale is not None:
        sel = [l for l in sel
               if days_since(l.get("last_checked")) is None
               or days_since(l["last_checked"]) >= args.stale]

    sel.sort(key=lambda l: (l["priority"], -(days_since(l.get("last_checked")) or 9999), l["name"]))

    if args.markdown:
        print("# Update sweep — %s\n" % dt.date.today().isoformat())
        print("For each lab: check the sources, look for anything newer than the "
              "last entry we have, then add it with `python tools/add_tech.py`.\n")

    cur = None
    for l in sel:
        if l["priority"] != cur:
            cur = l["priority"]
            head = "Priority %d — every %d days" % (cur, CADENCE[cur])
            print(("\n## %s\n" % head) if args.markdown else ("\n=== %s ===" % head))

        ds = days_since(l.get("last_checked"))
        age = "never checked" if ds is None else ("%d days ago" % ds)
        last = latest.get(l["id"])
        newest = ("newest here: %s (%d)" % (last[2], last[0])) if last else "nothing recorded yet"

        if args.markdown:
            print("- [ ] **%s** — %s · %s" % (l["name"], age, newest))
            for k, v in sorted((l.get("sources") or {}).items()):
                print("      - %s: <%s>" % (k, v))
        else:
            print("\n  [ ] %s" % l["name"])
            print("      last check: %-16s %s" % (age, newest))
            for k, v in sorted((l.get("sources") or {}).items()):
                print("      %-7s %s" % (k + ":", v))

    print("\n%d lab(s) queued." % len(sel))
    if not args.markdown:
        print("After sweeping one:  python tools/update_queue.py --mark <lab-id>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
