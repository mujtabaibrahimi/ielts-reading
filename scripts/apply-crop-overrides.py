"""
Apply crop-override transcriptions onto generated test JSON.

The remaining cropped questions (multiple choice, matching banks, note/summary/
table completion) are transcribed by hand from the PDF region and stored as the
durable source of truth in data/crop-overrides/<test-id>.json. This script
patches those transcriptions into data/academic/<id>.json or
data/general/<id>.json, so a future converter rerun can be followed by rerunning
this script to restore the text questions.

An override file maps a groupId to a patch:
  {
    "<groupId>": {
      "clearImages": true,                    # drop the crop, render text instead
      "instruction": "...",                   # optional, replaces group instruction
      "optionBank": {"title","options","labels"},   # shared-bank / letter-list groups
      "body": "...text with [[17]] inline gaps...",  # completion groups
      "questions": {                          # per-question fields, keyed by number
        "8": {"prompt": "...", "options": ["A","B","C","D"],
              "optionLabels": ["...","...","...","..."], "maxSelect": 2}
      },
      "newGroup": {"part": 2, "questionNumbers": [26],   # optional: create a
                   "type": "multiple-choice"},            # group for orphans
      "drop": true,                           # remove a duplicated group
      "questionNumbers": [14, 15, 16]         # narrow a group's question list
    },
    "_answers": {"14": "B,C,E"},          # corrected answer keys, by question number
    "_parts": {"1": [1, 14], "2": [15, 27], "3": [28, 40]},  # re-tile part ranges
    "_orphans": {"40": "why"}             # padding/unusable questions; skipped
  }

Usage:
    python scripts/apply-crop-overrides.py            # all override files
    python scripts/apply-crop-overrides.py <test-id> [<test-id> ...]
"""

import json
import os
import re
import sys
import glob

OVERRIDE_DIR = os.path.join("data", "crop-overrides")
DATA_DIRS = [os.path.join("data", "academic"), os.path.join("data", "general")]


def find_test_path(test_id):
    for d in DATA_DIRS:
        p = os.path.join(d, test_id + ".json")
        if os.path.exists(p):
            return p
    return None


def patch_numbers(patch):
    """Question numbers an override entry refers to (questions, [[n]] gaps, newGroup)."""
    nums = {int(n) for n in (patch.get("questions") or {})}
    nums |= {int(n) for n in re.findall(r"\[\[(\d+)\]\]", patch.get("body") or "")}
    nums |= set((patch.get("newGroup") or {}).get("questionNumbers", []))
    return nums


def stale_ids(part, override):
    # Overrides are keyed by group id, and a converter rerun can give that id to
    # a different group. An entry sharing no question number with the group of
    # that id is skipped instead of overwriting the wrong questions.
    # Numbers a group lists but its part does not hold (a misprinted header)
    # render nothing, so a group with only those is free to take an override.
    stale = set()
    held = {q["number"] for q in part.get("questions", [])}
    for g in part.get("questionGroups", []):
        patch = override.get(g["id"])
        if not isinstance(patch, dict):
            continue
        nums = patch_numbers(patch)
        real = set(g["questionNumbers"]) & held
        if nums and real and not nums & real:
            print(f"  [WARN] {g['id']} covers {g['range']} but its override refers to "
                  f"{sorted(nums)}; skipped, re-key the override")
            stale.add(g["id"])
    return stale


def create_new_groups(part, override, stale=()):
    # Questions the converter never attached to a group are not rendered at all.
    # A patch carrying "newGroup": {"part", "questionNumbers", "type"} creates
    # that group (if missing) in its part, ordered by range, and attaches the
    # questions to it; the rest of the patch then fills it like any other group.
    # On an existing group it adds the numbers to that group and widens its range.
    groups = part.setdefault("questionGroups", [])
    existing = {g["id"] for g in groups}
    for gid, patch in override.items():
        spec = patch.get("newGroup")
        if not spec or spec.get("part") != part.get("partNumber") or gid in stale:
            continue
        nums = sorted(spec["questionNumbers"])
        if gid in existing:
            g = next(g for g in groups if g["id"] == gid)
            held = {q["number"] for q in part.get("questions", [])}
            g["questionNumbers"] = sorted((set(g["questionNumbers"]) & held) | set(nums))
            g["range"] = [g["questionNumbers"][0], g["questionNumbers"][-1]]
        else:
            groups.append({
                "id": gid,
                "type": spec.get("type", "multiple-choice"),
                "instruction": "",
                "body": None,
                "range": [nums[0], nums[-1]],
                "optionBank": None,
                "images": [],
                "questionNumbers": nums,
            })
            existing.add(gid)
        # A question belongs to one group: take it out of any other that lists it,
        # or it renders twice.
        for other in groups:
            if other["id"] != gid and set(nums) & set(other["questionNumbers"]):
                other["questionNumbers"] = [n for n in other["questionNumbers"] if n not in nums]
                if other["questionNumbers"]:
                    other["range"] = [other["questionNumbers"][0], other["questionNumbers"][-1]]
        groups.sort(key=lambda g: g["range"][0])
        for q in part.get("questions", []):
            if q["number"] in nums:
                q["groupId"] = gid


def fix_part_ranges(data, ranges):
    # A garbled answer key can tile the parts wrongly (Q14 counted in Part 2
    # while its group is in Part 1). "_parts": {"1": [1, 14], ...} sets each
    # part's range and moves every question into the part whose range holds it.
    if not ranges:
        return
    parts = {p["partNumber"]: p for p in data.get("parts", [])}
    pool = [q for p in parts.values() for q in p.get("questions", [])]
    for num, (lo, hi) in ranges.items():
        p = parts[int(num)]
        p["questionRange"] = [lo, hi]
        p["questions"] = sorted((q for q in pool if lo <= q["number"] <= hi),
                                key=lambda q: q["number"])


def apply_override(test_path, override):
    with open(test_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    applied = []
    fix_part_ranges(data, override.get("_parts"))
    for part in data.get("parts", []):
        stale = stale_ids(part, override)
        create_new_groups(part, override, stale)
        groups = {g["id"]: g for g in part.get("questionGroups", [])}
        qs = {q["number"]: q for q in part.get("questions", [])}
        for gid, patch in override.items():
            g = groups.get(gid)
            if g is None or gid in stale:
                continue
            if patch.get("drop"):
                # A duplicated group (same questions listed twice) renders every
                # input twice; "drop": true removes the copy. "ifNumbers" guards
                # against a rerun giving this id to a different group.
                guard = patch.get("ifNumbers")
                if guard is not None and sorted(guard) != sorted(g["questionNumbers"]):
                    print(f"  [WARN] {gid} lists {g['questionNumbers']}, not {guard}; drop skipped")
                    continue
                part["questionGroups"] = [x for x in part["questionGroups"] if x["id"] != gid]
                applied.append(gid)
                continue
            if "questionNumbers" in patch:
                # Narrow a group to the questions it really holds. An empty list
                # keeps the group (and its crop) as display-only context.
                g["questionNumbers"] = sorted(patch["questionNumbers"])
                if g["questionNumbers"]:
                    g["range"] = [g["questionNumbers"][0], g["questionNumbers"][-1]]
            if patch.get("clearImages"):
                g["images"] = []
            if "type" in patch:
                g["type"] = patch["type"]
                for q in part.get("questions", []):
                    if q["number"] in g["questionNumbers"]:
                        q["groupId"] = gid
                        q["type"] = patch["type"]
            if "instruction" in patch:
                g["instruction"] = patch["instruction"]
            if "optionBank" in patch:
                g["optionBank"] = patch["optionBank"]
            if "body" in patch:
                g["body"] = patch["body"]
                # A body-completion override renders inline [[n]] gaps; unless it
                # explicitly carries its own word/letter bank, drop any stale
                # optionBank left over from the original (mis)detection so no
                # spurious "OPTIONS" box renders above the text.
                if "optionBank" not in patch:
                    g["optionBank"] = None
            for num_str, qpatch in (patch.get("questions") or {}).items():
                q = qs.get(int(num_str))
                if q is None:
                    continue
                for key in ("prompt", "options", "optionLabels", "maxSelect"):
                    if key in qpatch:
                        q[key] = qpatch[key]
            applied.append(gid)

    # "_answers": {"<n>": "<key>"} corrects answers the converter misread from
    # the PDF's Solution section; both the answers map and the question carry it.
    for num, key in (override.get("_answers") or {}).items():
        data.setdefault("answers", {})[num] = key
        for part in data.get("parts", []):
            for q in part.get("questions", []):
                if q["number"] == int(num):
                    q["answer"] = key
    if override.get("_answers"):
        # Same rule as pdf-to-json.py, so the home page's counts and filter match.
        answered = len([v for v in data["answers"].values() if str(v).strip()])
        data["answeredCount"] = answered
        data["status"] = "complete" if answered == 40 else ("near-complete" if answered >= 38 else "partial")

    with open(test_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    return applied


def main():
    args = sys.argv[1:]
    if args:
        files = [os.path.join(OVERRIDE_DIR, a + ".json") for a in args]
    else:
        files = sorted(glob.glob(os.path.join(OVERRIDE_DIR, "*.json")))

    total_tests = 0
    total_groups = 0
    for of in files:
        if not os.path.exists(of):
            print(f"  [SKIP] no override file: {of}")
            continue
        test_id = os.path.splitext(os.path.basename(of))[0]
        test_path = find_test_path(test_id)
        if test_path is None:
            print(f"  [SKIP] no test JSON for: {test_id}")
            continue
        with open(of, "r", encoding="utf-8") as f:
            override = json.load(f)
        applied = apply_override(test_path, override)
        total_tests += 1
        total_groups += len(applied)
        print(f"  [OK] {test_id}: applied {len(applied)} group(s) -> {applied}")

    print(f"\nApplied overrides to {total_groups} group(s) across {total_tests} test(s).")


if __name__ == "__main__":
    main()
