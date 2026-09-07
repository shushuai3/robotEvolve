# Keeping RobotEvolve current

The field moves fast enough that a static list rots in weeks. `data/labs.json` exists to
make refreshing it mechanical: it is a watchlist of the ~55 groups that actually produce
this work, each with a priority and the exact URLs to check.

## Priorities

| Priority | Cadence | Who |
| --- | --- | --- |
| **1** | weekly | Google DeepMind, Physical Intelligence, NVIDIA GEAR, Berkeley RAIL, Stanford IRIS/SVL/REALab, Figure, TRI, Hugging Face, CMU RI, MIT CSAIL, UT Austin RPL |
| **2** | monthly | Meta FAIR, OpenAI, World Labs, ByteDance Seed, Skild, Spirit AI, Robbyant, OpenDriveLab, 1X, Dyna, Generalist, Boston Dynamics, RAI, Amazon FAR, AI2, AgiBot, Shanghai AI Lab, Columbia, UCSD, NYU, Berkeley AUTOLab, UW, Tsinghua, Tesla |
| **3** | quarterly | Microsoft Research, Unitree, Galbot, X Square, Apptronik, HKU MMLab, USTC, AIRoA, Axis Robotics, KAIST, Soochow, PKU, Imperial, Freiburg, ETH RSL, TU Darmstadt |

Priority is about *rate of output that changes the map*, not importance. Move a lab up when
it starts shipping, down when it goes quiet — it is just a number in the JSON.

## The sweep

```bash
# what is due, based on priority cadence and last_checked
python tools/update_queue.py --due

# a full priority-1 pass
python tools/update_queue.py

# hand it to a human or an agent as a checklist
python tools/update_queue.py --priority 2 --markdown > TODO.md
```

The queue prints, for each lab, the source URLs *and* the newest thing already recorded for
that lab — so the question at each stop is concrete: **is there anything newer than this?**

```
  [ ] Physical Intelligence (π)
      last check: 2026-08-31       newest here: pi-0.7 (2026)
      blog:    https://www.pi.website/blog
      github:  https://github.com/Physical-Intelligence/openpi
      site:    https://www.pi.website/
```

After sweeping a lab:

```bash
python tools/update_queue.py --mark physical-intelligence
```

which stamps `last_checked` into `labs.json`, so `--due` stops showing it until the cadence
elapses.

## The other sweep: re-verifying what is already here

The lab sweep finds work that is *missing*. The verification sweep finds entries already
here whose description has gone stale:

```bash
python tools/update_queue.py --verify              # default: 90 days, 45 for unverified
python tools/update_queue.py --verify --stale 30   # tighter threshold
python tools/update_queue.py --verify --markdown   # checklist form
```

This is the one thing an entry's release date cannot tell you. `year`/`month` is a fact
about the world and never changes; `updated` is a fact about how current *our claims* are.
A 2021 paper written up yesterday and a 2025 paper untouched for a year look identical by
release date and are completely different maintenance problems.

Entries marked `"confidence": "medium"` were never fully verified, so they come due at half
the threshold and are listed first with an `UNVERIFIED` flag. Working through that list is
how the map gets more trustworthy over time — each confirmation flips an entry to
`"confidence": "high"` and advances its `updated` date, and both changes are visible in the
UI (the dashed **verify** chip disappears).

After confirming an entry against a primary source, re-save it so the date advances:

```bash
python tools/add_tech.py --json confirmed-entry.json
```

Note that simply re-running `generate.py` will **not** advance `updated` — it only moves
when content actually changes. If you verified an entry and found it correct as written,
change `confidence` from `medium` to `high`; that is itself a content change and the date
follows.

## Adding what you find

```bash
python tools/add_tech.py
```

Interactive, and it validates as you go: category must exist, org ids must exist in
`labs.json`, parent and influence ids must resolve to real technologies. Or write the entry
as JSON and pipe it in:

```bash
python tools/add_tech.py --json new-entry.json
cat entries.json | python tools/add_tech.py --json -     # a list also works
```

Writing an entry means answering these, in this order:

1. **Which domain?** If it does not fit the 10 categories, that is a signal — either it
   belongs in one of them after all, or the taxonomy needs a new category (add it to
   `categories` in `data/technologies.json` with a name, short label, colour and blurb).
2. **What is it a variant of?** `parents` is the strong claim — X is a descendant of Y,
   it took Y's core mechanism. `influences` is the weak one — X borrowed an idea from Y.
   Getting this right is what makes the graph worth looking at. An entry with no edges at
   all is almost always under-researched; `validate.py` will not fail it, but the graph
   will show it floating.
3. **What is the one thing it did that nobody had done?** That is the `tagline`, and the
   `innovation` bullets expand it. If you cannot name a specific mechanism, the entry is
   probably an incremental result and does not belong here.
4. **Open or closed?** `open` (code + weights), `weights`, `code` (code/data only, no
   policy weights), `closed`.
5. **How confident are you?** Mark `medium` for anything announced only by blog or press
   release, or where you did not confirm the arXiv id. The UI shows those with a dashed
   **verify** chip and a notice in the panel, which is much better than quietly presenting
   a guess as fact.

Then always:

```bash
python tools/validate.py
```

It catches broken parent references, parent cycles, orgs missing from `labs.json`, detail
files that do not exist, and detail files orphaned by a deleted entry.

## Adding a lab

Append to `data/labs.json`:

```jsonc
{
  "id": "some-lab",
  "name": "Some Lab",
  "type": "industry",            // industry | academic | nonprofit
  "country": "US",
  "priority": 2,
  "focus": ["vla", "rl"],        // category ids
  "notes": "Why this lab matters, in one or two sentences.",
  "sources": {
    "blog":   "https://…",       // the page that actually announces work
    "site":   "https://…",
    "github": "https://…"
  }
}
```

`sources` keys are free-form — whatever you add renders as a link on the Labs tab. Prefer
the page where results are *announced* (a blog or news index) over a homepage, since that
is what the sweep reads.

## Other things worth watching

The lab list is the primary signal, but a few sources cut across labs and catch work from
groups not yet on the watchlist:

- **arXiv** `cs.RO` new submissions, and `cs.LG` filtered for manipulation.
- **Conference proceedings** — CoRL (the field's centre of gravity), RSS, ICRA, ICLR, NeurIPS.
- **Hugging Face** trending robotics models, which surfaces open releases fast.
- **GitHub** — new repos under the org accounts already in `labs.json`.

When something appears from a group that is not in `labs.json`, add the lab first. The
watchlist growing is the point.

The recurring trap is the **spin-out**: a professor is on the list as an academic lab while
the work that moves the map ships from their company. Fei-Fei Li was on it as Stanford SVL
for months while World Labs shipped Marble, a real-to-sim engine and Atlas — none of which a
search anchored on the lab's academic keywords will surface. When a name on the watchlist
also runs a company, both belong on it, cross-referenced in `notes`.

## Pruning

RobotEvolve is a map of *groundbreaking* work, not a bibliography. Entries earn their place by
introducing a mechanism others adopted. If an entry turns out to be a minor variant, delete
it — remove it from `data/technologies.json`, delete `data/tech/<id>.json`, and run
`validate.py`, which will flag any remaining edges that pointed at it.
