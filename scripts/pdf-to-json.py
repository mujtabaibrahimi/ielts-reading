"""
IELTS Reading PDF to structured JSON converter (v3)

Hybrid extraction: clean text stems where the layout allows, cropped images for
visual blocks (heading lists, tables, diagrams, flow-charts, maps). Answer
controls are always derived from the answer key, so every test is a complete,
scorable 40-question exam.

Emits the schema approved in AUDIT.md section 6:
  - exactly 3 parts
  - questions numbered 1 to 40
  - answers map covering 1 to 40
  - per-group optional crop images under assets/crops/<test-id>/

No em-dashes are written to code or data output.

Usage:
    python pdf-to-json.py batch <input_dir> <output_dir> [--type academic|general] [--dpi 150]
    python pdf-to-json.py single <pdf_path> <output_dir> [--type academic|general] [--dpi 150]
"""

import fitz
import json
import re
import os
import sys
import argparse
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple

if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if sys.stderr.encoding and sys.stderr.encoding.lower() != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')


# Regex patterns

RE_PASSAGE_HEADER = re.compile(r"READING\s+PASSAGE\s+(\d)", re.IGNORECASE)
RE_PASSAGE_INTRO = re.compile(
    r"^\s*READING\s+PASSAGE\s+(?:\d|ONE|TWO|THREE)\s*\n\s*"
    r"(?:You should spend|Read,?\s+the\s+(?:text|passage)|Look at)",
    re.IGNORECASE | re.MULTILINE)
RE_GROUP_HEADER = re.compile(r"^Questions?\s+(\d+)\s*[-to]+\s*(\d+)\s*$", re.IGNORECASE)
RE_QRANGE_ANY = re.compile(r"Questions?\s+(\d+)\s*[-to]+\s*(\d+)", re.IGNORECASE)
RE_SPEND = re.compile(r"spend about\s+(\d+)\s+minutes", re.IGNORECASE)
RE_SOLUTION = re.compile(r"^\s*Solution", re.IGNORECASE)
RE_PART_SOL = re.compile(r"Part\s+(\d+)\s*:\s*Question\s+(\d+)\s*[-to]+\s*(\d+)", re.IGNORECASE)
RE_ACCESS = re.compile(r"Access https?://ieltsonlinetests", re.IGNORECASE)
RE_PAGEFOOT = re.compile(r"^page\s+\d+", re.IGNORECASE)
RE_MAXWORDS = re.compile(r"NO MORE THAN\s+(ONE|TWO|THREE|FOUR|\d+)\s+WORD", re.IGNORECASE)
RE_ONEWORD = re.compile(r"ONE WORD ONLY", re.IGNORECASE)
RE_SECTION_LABEL = re.compile(r"^SECTION\s+[A-Z]+\.?$", re.IGNORECASE)
RE_PARA_LABEL = re.compile(r"^([A-Z])$")

WORDNUM = {"ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4}


def normalize(text: str) -> str:
    """Normalize unicode oddities and remove long dashes from extracted data."""
    if not text:
        return ""
    # Soft hyphens (U+00AD): remove inside a word (line-break hyphenation),
    # keep elsewhere so a number range like "1 - 3" stays readable.
    text = re.sub("(?<=\\w)\u00ad(?=\\w)", "", text)
    dashes = {0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0x00ad}
    singles = {0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0xfffd}
    doubles = {0x201c, 0x201d, 0x201e, 0x2033}
    out = []
    for ch in text:
        o = ord(ch)
        if o in dashes: out.append("-")
        elif o in singles: out.append("'")
        elif o in doubles: out.append(chr(34))
        elif o == 0x2026: out.append("...")
        elif o == 0x00a0: out.append(" ")
        elif o == 0x200b: pass
        elif o in (0x2022, 0xf0b7): out.append("-")
        else: out.append(ch)
    result = "".join(out)
    # A quote sitting between two single tokens with spaces is a mis-decoded range
    # dash ("boxes 1 ' 3" -> "boxes 1-3", "paragraphs A ' I" -> "A-I"). The spaces
    # and single-character sides keep real apostrophes ("writer's", "1990's") safe.
    result = re.sub(r"(?<![A-Za-z0-9])([A-Za-z0-9])\s+'\s+([A-Za-z0-9])(?![A-Za-z0-9])",
                    r"\1-\2", result)
    return result


def is_footer(text: str) -> bool:
    t = text.strip()
    if RE_ACCESS.search(t):
        return True
    if RE_PAGEFOOT.match(t) and len(t) < 60:
        return True
    return False


def get_page_blocks(page) -> List[Dict]:
    """Return non-footer text blocks sorted in reading order with coordinates."""
    raw = page.get_text("blocks")
    blocks = []
    for b in raw:
        x0, y0, x1, y1, txt = b[0], b[1], b[2], b[3], b[4]
        txt = normalize(txt).strip()
        if not txt or is_footer(txt):
            continue
        blocks.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "text": txt})
    blocks.sort(key=lambda b: (round(b["y0"]), b["x0"]))
    return blocks


def extract_pages(doc) -> List[Dict]:
    pages = []
    for i in range(doc.page_count):
        page = doc[i]
        blocks = get_page_blocks(page)
        for b in blocks:
            b["_pn"] = i
        pages.append({
            "num": i,
            "page": page,
            "width": page.rect.width,
            "height": page.rect.height,
            "blocks": blocks,
            "raw": normalize(page.get_text()),
        })
    return pages


def find_structure(pages: List[Dict]) -> Dict:
    """Locate the first page of each passage and the solution start page."""
    passage_first = {}
    solution_page = None
    for p in pages:
        m = RE_PASSAGE_HEADER.search(p["raw"])
        if m:
            n = int(m.group(1))
            if n in (1, 2, 3) and n not in passage_first:
                passage_first[n] = p["num"]
        if solution_page is None and RE_SOLUTION.search(p["raw"]):
            solution_page = p["num"]
    # Some PDFs misnumber their headers ("PASSAGE 2" three times), spell the
    # number out, or mention "Reading Passage 3" inside a question. A real
    # header is followed by its intro line, so when exactly three of those
    # exist they are taken in page order instead of by their printed number.
    intro = [p["num"] for p in pages
             if (solution_page is None or p["num"] < solution_page)
             and RE_PASSAGE_INTRO.search(p["raw"])]
    if len(intro) == 3:
        passage_first = {i + 1: n for i, n in enumerate(intro)}
    return {"passage_first": passage_first, "solution_page": solution_page}


def solution_tokens(pages: List[Dict], solution_page: int) -> List[str]:
    """Flatten the solution section into per-line tokens.

    Part headers are kept so the answer parser can use them as authoritative
    boundaries for the forward jump between parts.
    """
    tokens = []
    for p in pages:
        if p["num"] < solution_page:
            continue
        for b in p["blocks"]:
            for line in b["text"].split("\n"):
                line = line.strip()
                if not line or line.lower().startswith("solution"):
                    continue
                tokens.append(line)
    return tokens


def parse_part_ranges(pages: List[Dict], solution_page: int) -> Dict[int, Tuple[int, int]]:
    """Read authoritative part ranges from 'Part N: Question A-B' headers."""
    ranges = {}
    if solution_page is None:
        return ranges
    for p in pages:
        if p["num"] < solution_page:
            continue
        for m in RE_PART_SOL.finditer(p["raw"]):
            pn, a, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if pn in (1, 2, 3) and pn not in ranges:
                ranges[pn] = (a, b)
    return ranges


def tiled_part_ranges(part_ranges: Dict[int, Tuple[int, int]], test_type: str) -> List[Tuple[int, int]]:
    """Return three contiguous part ranges tiling 1 to 40."""
    default = (14, 27) if test_type == "general" else (13, 26)
    end1 = part_ranges.get(1, (1, default[0]))[1]
    end2 = part_ranges.get(2, (end1 + 1, default[1]))[1]
    if not (1 <= end1 < end2 < 40):
        end1, end2 = default
    return [(1, end1), (end1 + 1, end2), (end2 + 1, 40)]


RE_RANGE_ANS = re.compile(r"^(\d+)\s*-\s*(\d+)[\s:.]+(\S.*)$")


def parse_answers(tokens: List[str], expected: List[int]) -> Dict[str, str]:
    """Map the solution number-then-answer stream onto question numbers.

    Within a part the numbers run strictly plus one, so only a bare integer
    equal to the current number plus one is taken as the next question number.
    This keeps numeric answers (a matching answer of 12, a date like 1949) from
    being mistaken for question numbers. A "Part N: Question A-B" header, or the
    very start, permits one forward jump to a higher number so the parser can
    cross a part boundary or a genuine gap. Range answers ("1-4 A,C,D,E") and
    answers shared by consecutive numbers ("14" then "15" then "B,E") are kept.
    """
    exp_set = set(expected)
    answers = {}
    cur = 0            # last accepted question number (0 before bootstrap)
    pending = []       # consecutive numbers waiting for a shared answer
    buf = []
    allow_jump = True  # a part header or the start permits one forward jump
    cur_done = False   # cur already had its answer committed (part boundary)

    def commit():
        val = normalize(" ".join(buf)).strip()
        if val:
            for n in pending + ([cur] if cur else []):
                answers[str(n)] = val

    for t in tokens:
        if RE_PART_SOL.search(t):
            commit()
            pending = []
            buf = []
            cur_done = True
            allow_jump = True
            continue
        mr = RE_RANGE_ANS.match(t)
        if mr:
            a, b = int(mr.group(1)), int(mr.group(2))
            if a in exp_set and b in exp_set and a <= b and b > cur and (allow_jump or a <= cur + 1):
                commit()
                pending = []
                buf = []
                val = normalize(mr.group(3)).strip()
                for n in range(a, b + 1):
                    if val:
                        answers[str(n)] = val
                cur = b
                allow_jump = False
                cur_done = True
                continue
        if re.fullmatch(r"\d+", t):
            v = int(t)
            # A number beyond cur+1 is the next question only when cur already has
            # answer content buffered; otherwise it is cur's own numeric answer.
            if v in exp_set and v > cur and (v == cur + 1 or allow_jump or buf):
                if buf:
                    commit()
                    pending = []
                elif cur and v == cur + 1 and not cur_done:
                    pending.append(cur)
                else:
                    pending = []
                cur = v
                buf = []
                allow_jump = False
                cur_done = False
                continue
        if cur:
            buf.append(t)
    commit()
    return {q: a for q, a in answers.items() if a}


def infer_type(instruction: str, answer: str) -> str:
    inst = (instruction or "").lower()
    if "true" in inst and "false" in inst and "not given" in inst:
        return "true-false-not-given"
    if "yes" in inst and "no" in inst and "not given" in inst:
        return "yes-no-not-given"
    if "list of headings" in inst or "correct heading" in inst:
        return "heading-matching"
    if "flow-chart" in inst or "flowchart" in inst or "flow chart" in inst:
        return "diagram-label"
    if "diagram" in inst or "label the" in inst or ("plan" in inst and "label" in inst) or "map" in inst:
        return "diagram-label"
    if "complete the table" in inst or ("table" in inst and "complete" in inst):
        return "table-completion"
    if "choose two" in inst or "choose the two" in inst or "two letters" in inst:
        return "multiple-choice-multi"
    if ("choose the correct letter" in inst or "choose the correct" in inst
            or "choose the appropriate letter" in inst or "only one of the choices" in inst
            or "only one of these choices" in inst):
        return "multiple-choice"
    if "which paragraph" in inst or "which section" in inst:
        return "matching-paragraph-information"
    if "match each" in inst or "match the" in inst:
        return "matching-features"
    if "from the list" in inst or "drag and drop" in inst:
        return "fill-in-blank-from-list"
    if "short answer" in inst:
        return "short-answer"
    if "complete the notes" in inst or "complete the summary" in inst or "complete the sentences" in inst:
        return "sentence-completion"
    # Fall back to the answer value
    a = (answer or "").strip().upper()
    if a in ("TRUE", "FALSE"):
        return "true-false-not-given"
    if a in ("YES", "NO"):
        return "yes-no-not-given"
    if re.match(r"^[IVX]+$", a):
        return "heading-matching"
    if re.match(r"^[A-K]$", a):
        return "matching-features"
    if "complete" in inst or "write" in inst:
        return "sentence-completion"
    return "fill-in-blank"


def max_words_from(instruction: str) -> Optional[int]:
    if RE_ONEWORD.search(instruction or ""):
        return 1
    m = RE_MAXWORDS.search(instruction or "")
    if m:
        v = m.group(1).upper()
        return WORDNUM.get(v, int(v) if v.isdigit() else None)
    return None


def split_passage_and_groups(region_blocks: List[Dict]) -> Tuple[List[Dict], List[Tuple[Dict, List[Dict]]]]:
    """Split a part region into passage blocks and question-group chunks.

    A group starts at a standalone "Questions N-M" header block. Everything
    before the first such header is passage text.
    """
    first_group_idx = None
    for idx, b in enumerate(region_blocks):
        head_line = b["text"].split("\n")[0].strip()
        if RE_GROUP_HEADER.match(head_line):
            first_group_idx = idx
            break
    if first_group_idx is None:
        return region_blocks, []
    passage_blocks = region_blocks[:first_group_idx]
    rest = region_blocks[first_group_idx:]
    groups = []
    current_head = None
    current_body = []
    for b in rest:
        head_line = b["text"].split("\n")[0].strip()
        if RE_GROUP_HEADER.match(head_line):
            if current_head is not None:
                groups.append((current_head, current_body))
            current_head = b
            current_body = []
        else:
            current_body.append(b)
    if current_head is not None:
        groups.append((current_head, current_body))
    return passage_blocks, groups


def build_passage(passage_blocks: List[Dict]) -> Dict:
    """Build passage object with heading, paragraphs, and plain-text fallback."""
    heading = ""
    paragraphs = []
    pending_label = None
    for b in passage_blocks:
        line0 = b["text"].split("\n")[0].strip()
        if RE_PASSAGE_HEADER.search(line0) and len(b["text"]) < 40:
            continue
        if RE_SPEND.search(b["text"]):
            continue
        if RE_SECTION_LABEL.match(line0) and len(b["text"]) < 20:
            pending_label = line0.upper()
            continue
        if RE_PARA_LABEL.match(b["text"].strip()):
            pending_label = b["text"].strip().upper()
            continue
        if not heading and b["text"].isupper() and 3 < len(b["text"]) < 90 and "\n" not in b["text"]:
            heading = b["text"].strip()
            continue
        paragraphs.append({"label": pending_label, "text": b["text"].strip()})
        pending_label = None
    text = "\n\n".join(p["text"] for p in paragraphs)
    return {"heading": heading, "paragraphs": paragraphs, "text": text, "images": [], "tables": []}


def parse_stems(body_blocks: List[Dict], lo: int, hi: int) -> Tuple[str, Dict[int, str], List[Dict]]:
    """Extract instruction text and numbered stems from a group body.

    Returns (instruction, {number: stem}, option_bank_lines).
    """
    instruction_parts = []
    stems = {}
    option_lines = []
    for b in body_blocks:
        txt = b["text"]
        # Block may hold "N\n stem" or plain instruction text
        mnum = re.match(r"^(\d+)\b", txt)
        if mnum and lo <= int(mnum.group(1)) <= hi:
            parts = txt.split("\n", 1)
            qn = int(re.match(r"^(\d+)", parts[0]).group(1))
            stem = ""
            if len(parts) > 1:
                stem = parts[1].strip()
            else:
                stem = re.sub(r"^\d+\s*", "", parts[0]).strip()
            if lo <= qn <= hi:
                stems[qn] = normalize(stem)
            continue
        # Option bank lines like "i Some advice" or "A The author"
        if re.match(r"^(?:[ivx]+|[A-K])\b[\s\.)]", txt.split("\n")[0].strip(), re.IGNORECASE) and len(txt) < 200:
            option_lines.append(txt.strip())
            continue
        instruction_parts.append(txt.strip())
    instruction = " ".join(instruction_parts).strip()
    instruction = re.sub(r"\s+", " ", instruction)
    return instruction, stems, option_lines


# Layout-preserving extraction via pdftotext -layout. This recovers the List of
# Headings tables, the lettered option banks, and the per-question multiple
# choice options that the block reader cannot segment, plus clean instructions.

RE_L_HEADER = re.compile(r"^[ \t]*Questions?\s+(\d+)[^\d\n]{1,6}(\d+)[ \t]*$", re.IGNORECASE | re.MULTILINE)
RE_L_ROMAN = re.compile(r"^\s*([ivxl]+)\s{2,}(\S.*)$", re.IGNORECASE)
RE_L_LETTER = re.compile(r"^\s*([A-K])\s{2,}(\S.*)$")
RE_L_STEM = re.compile(r"^\s*(\d+)[\s.)]+(\S.*)$")


def layout_full_text(pdf_path: str) -> str:
    """Return the whole document as layout-preserving text via pdftotext -layout."""
    try:
        result = subprocess.run(
            ["pdftotext", "-layout", pdf_path, "-"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
        )
        if result.returncode == 0:
            text = normalize(result.stdout).replace("\f", "\n")
            # Strip right-aligned page footers that pdftotext places on the same
            # line as a header or content, so "Questions 21-23      page 7"
            # becomes a clean header the chunker and body-splitter can detect.
            text = re.sub(r"[ \t]{2,}page\s+\d+\s*$", "", text, flags=re.MULTILINE | re.IGNORECASE)
            text = re.sub(r"[ \t]{2,}Access https?://\S.*$", "", text, flags=re.MULTILINE | re.IGNORECASE)
            return text
    except Exception:
        pass
    return ""


def layout_group_chunks(full_text: str) -> Dict[Tuple[int, int], str]:
    """Slice layout text into chunks keyed by (lo, hi) at each standalone group header."""
    heads = [(m.start(), int(m.group(1)), int(m.group(2)))
             for m in RE_L_HEADER.finditer(full_text)]
    chunks = {}
    for i, (pos, a, b) in enumerate(heads):
        end = heads[i + 1][0] if i + 1 < len(heads) else len(full_text)
        chunks[(a, b)] = full_text[pos:end]
    return chunks


def _is_footer_line(s: str) -> bool:
    return bool(re.search(r"Access https?://|^\s*page\s+\d+\s*$", s, re.IGNORECASE))


def parse_mcq_lines(lines: List[str], lo: int, hi: int) -> Dict[int, Dict]:
    """Parse per-question multiple choice stems and options from layout lines."""
    qopts = {}
    cur = None
    curletter = None
    for ln in lines:
        ms = RE_L_STEM.match(ln)
        ml = RE_L_LETTER.match(ln)
        if ms and not ml and lo <= int(ms.group(1)) <= hi:
            cur = int(ms.group(1))
            qopts[cur] = {"stem": normalize(ms.group(2)).strip(), "options": [], "labels": []}
            curletter = None
        elif ml and cur is not None:
            curletter = ml.group(1)
            qopts[cur]["options"].append(curletter)
            qopts[cur]["labels"].append(normalize(ml.group(2)).strip())
        elif cur is not None and curletter is not None and ln.strip() and not _is_footer_line(ln):
            qopts[cur]["labels"][-1] += " " + normalize(ln.strip())
        elif cur is not None and curletter is None and ln.strip() and not _is_footer_line(ln):
            qopts[cur]["stem"] += " " + normalize(ln.strip())
    return {k: v for k, v in qopts.items() if len(v["options"]) >= 2}


def parse_layout_group(chunk: str, lo: int, hi: int, gtype: str):
    """Return (clean instruction, option bank, per-question mcq options) from a group chunk."""
    lines = chunk.split("\n")
    start = 0
    for i, ln in enumerate(lines):
        if RE_L_HEADER.match(ln):
            start = i + 1
            break
    # Clean instruction: lines after the header up to the first content marker.
    instr = []
    for ln in lines[start:]:
        s = ln.strip()
        if not s:
            continue
        if _is_footer_line(s) or "list of headings" in s.lower():
            break
        if RE_L_ROMAN.match(ln) and gtype == "heading-matching":
            break
        mstem = RE_L_STEM.match(ln)
        if mstem and lo <= int(mstem.group(1)) <= hi:
            break
        if RE_L_LETTER.match(ln):
            break
        instr.append(s)
    instruction = re.sub(r"\s+", " ", normalize(" ".join(instr))).strip()

    option_bank = None
    qopts = None

    if gtype == "heading-matching":
        opts, labels = [], []
        started = False
        for ln in lines:
            if "list of headings" in ln.lower():
                started = True
                continue
            if not started:
                continue
            m = RE_L_ROMAN.match(ln)
            if m:
                opts.append(m.group(1).lower())
                labels.append(normalize(m.group(2)).strip())
            elif opts and RE_L_STEM.match(ln):
                break
        if opts:
            option_bank = {"title": "List of Headings", "options": opts, "labels": labels}

    elif gtype in ("matching-features", "matching-people", "matching-sentence-endings", "fill-in-blank-from-list", "multiple-choice-multi"):
        # Take only the first contiguous A, B, C ... block. If a letter repeats
        # or drops back, that is a second block (per-question choices), so stop.
        opts, labels = [], []
        last_ord = 0
        for ln in lines[start:]:
            m = RE_L_LETTER.match(ln)
            if m:
                o = ord(m.group(1).upper())
                if opts and o <= last_ord:
                    break
                opts.append(m.group(1))
                labels.append(normalize(m.group(2)).strip())
                last_ord = o
            elif opts and RE_L_STEM.match(ln) and lo <= int(RE_L_STEM.match(ln).group(1)) <= hi:
                break
        if opts:
            option_bank = {"title": "Options", "options": opts, "labels": labels}

    elif gtype == "matching-paragraph-information":
        m = (re.search(r"paragraphs?,?\s+([A-K])\s*(?:to|-|and|through)\s*([A-K])", instruction, re.IGNORECASE)
             or re.search(r"\b([A-K])\s*-\s*([A-K])\b", instruction))
        if m:
            a, b = m.group(1).upper(), m.group(2).upper()
            if ord(a) <= ord(b) <= ord(a) + 12:
                option_bank = {"title": "Paragraphs",
                               "options": [chr(c) for c in range(ord(a), ord(b) + 1)], "labels": []}

    elif gtype in ("multiple-choice", "multiple-choice-multi"):
        qopts = parse_mcq_lines(lines[start:], lo, hi)

    return instruction, option_bank, qopts


# Completion groups print the directive and then the gapped sentences or notes.
# Split those so the frontend can render an inline input at each numbered gap.

COMPLETION_BODY_TYPES = {"sentence-completion", "short-answer", "fill-in-blank"}
RE_DIRECTIVE = re.compile(
    r"(complete the|choose|write your answer|in boxes|on your answer sheet|"
    r"no more than|one word|using no more than|label the|from the list|"
    r"which paragraph|do the following|answer the questions)", re.IGNORECASE)
ROMAN_SEQ = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"]
# The completion body ends where the next part or group begins.
RE_BODY_STOP = re.compile(
    r"(READING\s+PASSAGE|You should spend|^\s*Solution|^\s*Questions?\s+\d+\s*[-to]+\s*\d+)",
    re.IGNORECASE)


def _has_inline_gap(line: str, lo: int, hi: int) -> bool:
    for n in range(lo, hi + 1):
        if re.search(r"(?<![-\d/])\b" + str(n) + r"\b(?![-\d/])", line):
            return True
    return False


def split_completion(chunk: str, lo: int, hi: int) -> Tuple[str, str]:
    """Return (directive instruction, body text with each gap marked as [[N]])."""
    lines = chunk.split("\n")
    start = 0
    for i, ln in enumerate(lines):
        if RE_L_HEADER.match(ln):
            start = i + 1
            break
    directive, body = [], []
    body_started = False
    for ln in lines[start:]:
        s = ln.strip()
        if not s or _is_footer_line(s):
            continue
        if not body_started:
            # Everything before the first real gap is the directive; the body
            # starts at the first line that holds an inline gap.
            if _has_inline_gap(s, lo, hi):
                body_started = True
            else:
                directive.append(s)
                continue
        # Stop the body at the next group header, the next passage, or the solution.
        if RE_L_HEADER.match(ln) or RE_BODY_STOP.search(s):
            break
        body.append(s)
    instruction = re.sub(r"\s+", " ", normalize(" ".join(directive))).strip()
    body_text = re.sub(r"\s+", " ", normalize(" ".join(body))).strip()
    for n in range(lo, hi + 1):
        body_text = re.sub(r"(?<![-\d/])\b" + str(n) + r"\b(?![-\d/])",
                           "[[%d]]" % n, body_text, count=1)
    return instruction, body_text


def derive_roman_bank(answers: Dict[str, str], lo: int, hi: int) -> Dict:
    """Build a List of Headings numeral dropdown when the printed list was not parsed."""
    maxidx = 0
    for n in range(lo, hi + 1):
        v = normalize(answers.get(str(n), "")).strip().lower()
        if v in ROMAN_SEQ:
            maxidx = max(maxidx, ROMAN_SEQ.index(v))
    count = min(max(maxidx + 1, hi - lo + 1, 8), 12)
    return {"title": "List of Headings", "options": ROMAN_SEQ[:count], "labels": []}


def derive_letter_bank(answers: Dict[str, str], lo: int, hi: int, title: str) -> Dict:
    """Build a letter dropdown (for example paragraphs A to I) from the answer letters."""
    maxc = ord("G")
    for n in range(lo, hi + 1):
        v = normalize(answers.get(str(n), "")).strip().upper()
        if len(v) == 1 and "A" <= v <= "K":
            maxc = max(maxc, ord(v))
    return {"title": title, "options": [chr(c) for c in range(ord("A"), maxc + 1)], "labels": []}


# OpenDataLoader text recovery. When the layout pass cannot segment an option
# bank or heading list, the higher-accuracy OpenDataLoader JSON (pre-generated
# into --odl-dir) often holds the same block as a clean run of labelled list
# items. We read that run as a text option bank instead of cropping an image.
# OpenDataLoader is only an optional text source: with no --odl-dir, or no file
# for a test, extraction falls back to the existing crop behaviour.

ODL_ROMAN_SEQ = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",
                 "xi", "xii", "xiii", "xiv", "xv"]
RE_ODL_ROMAN = re.compile(
    r"^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv)[\.\):]?\s+(\S.*)$",
    re.IGNORECASE)
RE_ODL_LETTER = re.compile(r"^([A-K])[\.\):]?\s+(\S.*)$")


def _odl_flatten(node, out: List[Tuple]):
    """Collect (page, type, content) string leaves from an OpenDataLoader tree."""
    if isinstance(node, dict):
        t = node.get("type")
        c = node.get("content")
        if t and isinstance(c, str):
            out.append((node.get("page number"), t, c))
        for k, v in node.items():
            if k != "content":
                _odl_flatten(v, out)
    elif isinstance(node, list):
        for v in node:
            _odl_flatten(v, out)


def _odl_lead(text: str):
    """Return (kind, label, body) if a line begins with a roman or letter label."""
    s = text.strip()
    m = RE_ODL_ROMAN.match(s)
    if m:
        return ("R", m.group(1).lower(), m.group(2).strip())
    m = RE_ODL_LETTER.match(s)
    if m and len(s) < 160:
        return ("L", m.group(1).upper(), m.group(2).strip())
    return None


def _odl_label_ord(kind: str, label: str) -> Optional[int]:
    if kind == "L":
        u = label.upper()
        return ord(u) - ord("A") if len(u) == 1 and "A" <= u <= "K" else None
    try:
        return ODL_ROMAN_SEQ.index(label.lower())
    except ValueError:
        return None


def load_odl_runs(odl_path: str) -> List[Dict]:
    """Parse OpenDataLoader JSON into labelled option-bank runs.

    A run is the maximal stretch of consecutive, strictly incrementing labelled
    lines of one kind (roman or letter), with at least three items. Pages stay
    1-indexed as OpenDataLoader emits them.
    """
    try:
        with open(odl_path, "r", encoding="utf-8") as f:
            tree = json.load(f)
    except Exception:
        return []
    leaves: List[Tuple] = []
    _odl_flatten(tree, leaves)
    runs = []
    i, n = 0, len(leaves)
    while i < n:
        lead = _odl_lead(leaves[i][2])
        if not lead:
            i += 1
            continue
        kind = lead[0]
        page = leaves[i][0]
        labels, texts = [lead[1]], [normalize(lead[2])]
        j = i + 1
        while j < n:
            nxt = _odl_lead(leaves[j][2])
            if not nxt or nxt[0] != kind:
                break
            prev_ord = _odl_label_ord(kind, labels[-1])
            this_ord = _odl_label_ord(kind, nxt[1])
            if prev_ord is None or this_ord is None or this_ord != prev_ord + 1:
                break
            labels.append(nxt[1])
            texts.append(normalize(nxt[2]))
            j += 1
        if len(labels) >= 3:
            runs.append({"kind": kind, "page": page, "labels": labels, "texts": texts})
        i = j if j > i + 1 else i + 1
    return runs


def _odl_group_pages(head_block: Dict, body_blocks: List[Dict]) -> set:
    """1-indexed page numbers a group spans (OpenDataLoader uses 1-indexed pages)."""
    pages = {head_block["_pn"] + 1}
    for b in body_blocks:
        pages.add(b["_pn"] + 1)
    return pages


def odl_bank_for_group(runs: List[Dict], kind: str, group_pages: set,
                       min_count: int, title: str) -> Optional[Dict]:
    """Pick the best labelled run for a group and return an option bank.

    The run must start at the first label (i or A), sit on one of the group's
    pages or the page just after (a bank can spill over), and carry at least
    min_count options. The longest qualifying run wins.
    """
    span = set(group_pages) | {max(group_pages) + 1}
    best = None
    for r in runs:
        if r["kind"] != kind or r["page"] not in span:
            continue
        if len(r["labels"]) < min_count:
            continue
        first = r["labels"][0].lower() if kind == "R" else r["labels"][0].upper()
        if (kind == "R" and first != "i") or (kind == "L" and first != "A"):
            continue
        if best is None or len(r["labels"]) > len(best["labels"]):
            best = r
    if not best:
        return None
    return {"title": title, "options": list(best["labels"]), "labels": list(best["texts"])}


def region_crop(pages: List[Dict], head_block: Dict, body_blocks: List[Dict],
                out_dir: str, test_id: str, group_id: str, dpi: int) -> List[Dict]:
    """Crop a group region to one PNG per page it spans (header plus body)."""
    img_dir = os.path.join(out_dir, "assets", "crops", test_id)
    os.makedirs(img_dir, exist_ok=True)
    # Group all blocks by their page number
    by_page = {}
    for b in [head_block] + body_blocks:
        by_page.setdefault(b["_pn"], []).append(b)
    images = []
    for slot, pn in enumerate(sorted(by_page)):
        page = pages[pn]["page"]
        pw = pages[pn]["width"]
        ph = pages[pn]["height"]
        page_bottom = ph - 42
        blocks = by_page[pn]
        top = max(0, min(b["y0"] for b in blocks) - 8)
        bottom = min(page_bottom, max(b["y1"] for b in blocks) + 6)
        if bottom <= top:
            continue
        clip = fitz.Rect(26, top, pw - 26, bottom)
        suffix = "" if len(by_page) == 1 else f"-{slot + 1}"
        fn = f"{group_id}{suffix}.png"
        pix = page.get_pixmap(clip=clip, dpi=dpi)
        pix.save(os.path.join(img_dir, fn))
        images.append({"src": f"assets/crops/{test_id}/{fn}", "w": pix.width, "h": pix.height})
    return images


# Crops are kept only for genuinely visual blocks. Everything else is now
# structured text (option banks, per-question options, clean instructions)
# recovered from the layout pass.
CROP_ONLY_TYPES = {"table-completion", "diagram-label"}
NEED_BANK_TYPES = {"heading-matching", "matching-features", "matching-people",
                   "matching-sentence-endings", "fill-in-blank-from-list", "multiple-choice-multi"}
# When a crop is shown, fragmented per-question text stems are cleared to avoid
# confusing partial text.
CROP_CLEARS_STEM = {"table-completion", "diagram-label", "sentence-completion",
                    "short-answer", "fill-in-blank", "fill-in-blank-from-list"}


def convert_pdf_to_json(pdf_path: str, output_dir: str, test_type: str, dpi: int,
                        odl_dir: str = "") -> Optional[Dict]:
    filename = os.path.basename(pdf_path)
    test_id = Path(filename).stem
    test_id = re.sub(r"[^a-zA-Z0-9_-]", "-", test_id)
    test_id = re.sub(r"-+", "-", test_id).strip("-")

    # Optional OpenDataLoader text runs for this test, keyed by the PDF stem.
    odl_runs: List[Dict] = []
    if odl_dir:
        odl_runs = load_odl_runs(os.path.join(odl_dir, Path(filename).stem + ".json"))

    doc = fitz.open(pdf_path)
    pages = extract_pages(doc)
    struct = find_structure(pages)
    pf = struct["passage_first"]
    sol = struct["solution_page"]
    layout_chunks = layout_group_chunks(layout_full_text(pdf_path))

    # Authoritative part ranges and answer sequence come from the solution section
    part_ranges = parse_part_ranges(pages, sol)
    overall_ranges = tiled_part_ranges(part_ranges, test_type)
    expected_nums = [n for (lo, hi) in overall_ranges for n in range(lo, hi + 1)]
    tokens = solution_tokens(pages, sol) if sol is not None else []
    answers = parse_answers(tokens, expected_nums)

    meta = parse_meta(filename, test_type)

    # Determine the three passage page regions for text and crops
    starts = [pf.get(1), pf.get(2), pf.get(3)]
    end_of_content = sol if sol is not None else doc.page_count
    bounds = []
    for i in range(3):
        s = starts[i]
        if s is None:
            bounds.append(None)
            continue
        e = starts[i + 1] if i + 1 < 3 and starts[i + 1] is not None else end_of_content
        bounds.append((s, e))

    parts = []
    for i, bnd in enumerate(bounds):
        part_no = i + 1
        overall = list(overall_ranges[i])
        if bnd is None:
            # No passage region detected, still emit a full set of answerable
            # questions for this part so the test stays complete and scorable.
            parts.append(assemble_part(part_no, empty_passage(), overall, 20, [], answers))
            continue
        s, e = bnd
        region_page_nums = list(range(s, e))
        region_blocks = []
        for pn in region_page_nums:
            region_blocks.extend(pages[pn]["blocks"])
        spend = RE_SPEND.search(pages[s]["raw"])
        time_sugg = int(spend.group(1)) if spend else 20

        passage_blocks, group_chunks = split_passage_and_groups(region_blocks)
        passage = build_passage(passage_blocks)

        question_groups = []
        for gi, (head, body) in enumerate(group_chunks):
            head_line = head["text"].split("\n")[0].strip()
            gm = RE_GROUP_HEADER.match(head_line)
            lo, hi = int(gm.group(1)), int(gm.group(2))
            # extra instruction text sometimes trails the header inside its block
            extra = head["text"].split("\n", 1)
            head_extra = extra[1].strip() if len(extra) > 1 else ""
            instruction, stems, option_lines = parse_stems(body, lo, hi)
            if head_extra:
                instruction = (head_extra + " " + instruction).strip()
            gtype = infer_type(instruction, answers.get(str(lo), ""))
            group_id = f"p{part_no}g{gi + 1}"
            expected = hi - lo + 1

            # Layout pass: clean instruction, structured option bank, mcq options
            l_instr, l_bank, l_qopts = "", None, None
            lchunk = layout_chunks.get((lo, hi))
            if lchunk:
                l_instr, l_bank, l_qopts = parse_layout_group(lchunk, lo, hi, gtype)
                if l_instr and len(l_instr) >= 12:
                    instruction = l_instr
                    # Re-infer the type from the clean instruction, then re-extract
                    # the structured data when the classification changed.
                    new_type = infer_type(instruction, answers.get(str(lo), ""))
                    if new_type != gtype:
                        gtype = new_type
                        _, l_bank, l_qopts = parse_layout_group(lchunk, lo, hi, gtype)
            option_bank = l_bank or (build_option_bank(option_lines) if option_lines else None)
            if gtype == "multiple-choice":
                option_bank = None

            # Heading-matching and information-matching must always have a dropdown.
            if gtype == "heading-matching" and not option_bank:
                option_bank = derive_roman_bank(answers, lo, hi)
            if gtype == "matching-paragraph-information" and not option_bank:
                option_bank = derive_letter_bank(answers, lo, hi, "Paragraphs")

            # Completion groups: split the directive from the gapped body so the
            # frontend can place an inline input at each numbered gap.
            body_text = None
            if gtype in COMPLETION_BODY_TYPES and lchunk:
                c_instr, c_body = split_completion(lchunk, lo, hi)
                if c_body and "[[" in c_body:
                    if c_instr:
                        instruction = c_instr
                    body_text = c_body

            # OpenDataLoader recovery: when the layout pass could not segment the
            # bank, pull the option text and labels from the high-accuracy JSON so
            # the group renders as selectable text instead of a cropped image. Used
            # only when it yields a clean, correctly-shaped run; otherwise the crop
            # fallback below still applies.
            if odl_runs:
                gpages = _odl_group_pages(head, body)
                if gtype == "heading-matching" and not (option_bank and any(option_bank.get("labels") or [])):
                    od = odl_bank_for_group(odl_runs, "R", gpages, expected, "List of Headings")
                    if od:
                        option_bank = od
                elif gtype in ("matching-features", "matching-people",
                               "matching-sentence-endings", "fill-in-blank-from-list",
                               "multiple-choice-multi") and option_bank is None:
                    od = odl_bank_for_group(odl_runs, "L", gpages, 3, "Options")
                    if od:
                        option_bank = od

            # Crop only for genuinely visual blocks, or as a fallback when the
            # structured extraction for an option-bank or mcq group did not work.
            if gtype in CROP_ONLY_TYPES:
                need_crop = True
            elif gtype == "multiple-choice":
                need_crop = not l_qopts
            elif gtype in ("heading-matching", "matching-paragraph-information"):
                need_crop = False
            elif gtype in NEED_BANK_TYPES:
                need_crop = option_bank is None
            else:
                need_crop = False

            images = []
            if need_crop:
                try:
                    images = region_crop(pages, head, body, output_dir, test_id, group_id, dpi)
                except Exception:
                    images = []
            qg = {
                "id": group_id,
                "type": gtype,
                "instruction": instruction,
                "body": body_text,
                "range": [lo, hi],
                "optionBank": option_bank,
                "images": images,
                "questionNumbers": list(range(lo, hi + 1)),
                "_stems": stems,
                "_qopts": l_qopts,
            }
            question_groups.append(qg)

        parts.append(assemble_part(part_no, passage, overall, time_sugg, question_groups, answers))

    doc.close()

    answers_clean = {str(k): clean_answer(v) for k, v in answers.items()
                     if 1 <= int(k) <= 40 and str(v).strip()}
    answered = len(answers_clean)
    status = "complete" if answered == 40 else ("near-complete" if answered >= 38 else "partial")

    # Build the final 40-question guarantee from the answer key
    test_json = {
        "id": test_id,
        "type": test_type,
        "title": meta["title"],
        "collection": meta["collection"],
        "testNumber": meta["testNumber"],
        "year": meta["year"],
        "month": meta["month"],
        "volume": meta["volume"],
        "source": "ieltsonlinetests.com",
        "filename": filename,
        "totalQuestions": 40,
        "answeredCount": answered,
        "status": status,
        "durationSeconds": 3600,
        "parts": parts,
        "answers": answers_clean,
    }
    return test_json


def clean_answer(v):
    if isinstance(v, list):
        return [normalize(str(x)).strip() for x in v]
    return normalize(str(v)).strip()


def build_option_bank(option_lines: List[str]) -> Dict:
    options, labels = [], []
    for ln in option_lines:
        m = re.match(r"^([ivxabcdefghijkABCDEFGHIJK]+)[\s\.)]+(.*)$", ln)
        if m:
            options.append(m.group(1))
            labels.append(m.group(2).strip())
    if not options:
        return None
    return {"title": "Options", "options": options, "labels": labels}


def assemble_part(part_no, passage, overall, time_sugg, groups, answers) -> Dict:
    lo, hi = overall
    questions = []
    # map number -> (type, stem, group) from groups
    num_to_group = {}
    for g in groups:
        for n in g["questionNumbers"]:
            num_to_group[n] = g
    for n in range(lo, hi + 1):
        g = num_to_group.get(n)
        ans = answers.get(str(n), "")
        opts = None
        labels = None
        if g is not None:
            qtype = g["type"]
            stem = g["_stems"].get(n, "")
            if g.get("images") and qtype in CROP_CLEARS_STEM:
                stem = ""
            group_id = g["id"]
            maxw = max_words_from(g["instruction"])
            qo = g.get("_qopts") or {}
            if n in qo:
                # Per-question multiple choice: prefer the layout stem and options
                if qo[n].get("stem"):
                    stem = qo[n]["stem"]
                opts = qo[n]["options"]
                labels = qo[n]["labels"]
            else:
                opts = options_for(qtype, g)
        else:
            qtype = infer_type("", ans)
            stem = ""
            group_id = None
            maxw = None
        q = {
            "number": n,
            "type": qtype,
            "groupId": group_id,
            "prompt": stem,
            "instruction": "",
            "options": opts,
            "optionLabels": labels,
            "maxWords": maxw,
            "maxSelect": 2 if qtype == "multiple-choice-multi" else None,
            "answer": clean_answer(ans) if ans else "",
            "trap": None,
        }
        questions.append(q)
    # strip internal helper keys
    clean_groups = []
    for g in groups:
        gg = dict(g)
        gg.pop("_stems", None)
        gg.pop("_qopts", None)
        clean_groups.append(gg)
    return {
        "partNumber": part_no,
        "title": f"Reading Passage {part_no}",
        "questionRange": overall,
        "timeSuggestion": time_sugg,
        "passage": passage,
        "questionGroups": clean_groups,
        "questions": questions,
    }


def options_for(qtype, group):
    if qtype == "true-false-not-given":
        return ["TRUE", "FALSE", "NOT GIVEN"]
    if qtype == "yes-no-not-given":
        return ["YES", "NO", "NOT GIVEN"]
    if group and group.get("optionBank"):
        return group["optionBank"]["options"]
    return None


def empty_passage() -> Dict:
    return {"heading": "", "paragraphs": [], "text": "", "images": [], "tables": []}


MONTHS = ["january", "february", "march", "april", "may", "june", "july",
          "august", "september", "october", "november", "december"]


def parse_meta(filename: str, test_type: str) -> Dict:
    stem = Path(filename).stem.lower()
    # Drop the trailing version and id (for example -v9-2093) so the id digits
    # are not misread as a year or test number.
    core = re.sub(r"-v\d+-\d+$", "", stem)

    tnum = 1
    tm = re.search(r"practi[cs]e-test-(\d+)", core)
    if tm:
        tnum = int(tm.group(1))

    month = 0
    month_name = ""
    for mi, mn in enumerate(MONTHS, 1):
        if mn in core:
            month = mi
            month_name = mn.capitalize()
            break

    year = 0
    ym = re.search(r"mock-test-(20[0-2]\d)", core)
    if ym and 2000 <= int(ym.group(1)) <= 2026:
        year = int(ym.group(1))

    vol = 0
    vm = re.search(r"volume-(\d+)", core)
    if vm:
        vol = int(vm.group(1))

    track = "General" if test_type == "general" else "Academic"
    if "recent-mock-tests-volume" in core:
        collection = f"IELTS Recent Mock Tests Volume {vol}"
    elif "master-ielts-general-training-volume" in core:
        collection = f"Master IELTS General Training Volume {vol}"
    elif "prepare-for-ielts-general-training-volume" in core:
        collection = f"Prepare for IELTS General Training Volume {vol}"
    elif "general-training-volume" in core:
        collection = f"IELTS General Training Volume {vol}"
    elif "practice-tests-plus-volume" in core:
        collection = f"IELTS Practice Tests Plus Volume {vol}"
    elif "practice-test-volume" in core:
        collection = f"IELTS Practice Test Volume {vol}"
    elif year:
        collection = f"IELTS Academic Mock Tests {year}"
    else:
        collection = f"IELTS {track} Reading Tests"

    if year and month_name:
        title = f"IELTS {track} {year} {month_name} - Reading Test {tnum}"
    else:
        title = f"{collection} - Reading Test {tnum}"

    return {
        "title": title, "collection": collection,
        "testNumber": tnum, "year": year, "month": month, "volume": vol,
    }


# Validation

def validate_test(data: Dict) -> List[str]:
    errs = []
    if len(data.get("parts", [])) != 3:
        errs.append(f"parts={len(data.get('parts', []))} (need 3)")
    nums = []
    for p in data.get("parts", []):
        nums.extend([q["number"] for q in p.get("questions", [])])
    nums_set = set(nums)
    missing = [n for n in range(1, 41) if n not in nums_set]
    if missing:
        errs.append(f"missing question numbers: {missing[:8]}{'...' if len(missing) > 8 else ''}")
    if len(nums) != len(nums_set):
        errs.append("duplicate question numbers")
    ans = data.get("answers", {})
    missing_ans = [n for n in range(1, 41) if str(n) not in ans or not str(ans.get(str(n), "")).strip()]
    if missing_ans:
        errs.append(f"missing answers: {len(missing_ans)} ({missing_ans[:6]}{'...' if len(missing_ans) > 6 else ''})")
    return errs


def batch_convert(input_dir: str, output_dir: str, default_type: str, dpi: int,
                  odl_dir: str = ""):
    pdfs = sorted(f for f in os.listdir(input_dir) if f.lower().endswith(".pdf"))
    print(f"Found {len(pdfs)} PDFs in {input_dir}\n")
    report = {"pass": [], "fail": [], "error": []}
    for i, fn in enumerate(pdfs, 1):
        path = os.path.join(input_dir, fn)
        ttype = "general" if "general" in fn.lower() else "academic"
        out_type_dir = os.path.join(output_dir, "data", ttype)
        os.makedirs(out_type_dir, exist_ok=True)
        try:
            data = convert_pdf_to_json(path, output_dir, ttype, dpi, odl_dir)
            errs = validate_test(data)
            json_path = os.path.join(out_type_dir, f"{data['id']}.json")
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            if errs:
                report["fail"].append((fn, errs))
                print(f"  [FAIL] [{i}/{len(pdfs)}] {fn[:54]} :: {'; '.join(errs)}")
            else:
                report["pass"].append(fn)
                print(f"  [OK]   [{i}/{len(pdfs)}] {fn[:54]}")
        except Exception as ex:
            report["error"].append((fn, str(ex)))
            print(f"  [ERR]  [{i}/{len(pdfs)}] {fn[:54]} :: {str(ex)[:70]}")

    for t in ("academic", "general"):
        tdir = os.path.join(output_dir, "data", t)
        if os.path.isdir(tdir):
            generate_index(tdir, t)

    print("\n" + "=" * 60)
    print(f"PASS:  {len(report['pass'])}/{len(pdfs)}")
    print(f"FAIL:  {len(report['fail'])}")
    print(f"ERROR: {len(report['error'])}")
    with open(os.path.join(output_dir, "data", "validation-report.json"), "w", encoding="utf-8") as f:
        json.dump({
            "pass": len(report["pass"]),
            "fail": [{"file": f, "errors": e} for f, e in report["fail"]],
            "error": [{"file": f, "error": e} for f, e in report["error"]],
        }, f, indent=2)


def generate_index(type_dir: str, test_type: str):
    tests = []
    for f in sorted(os.listdir(type_dir)):
        if f.endswith(".json") and f != "index.json":
            try:
                with open(os.path.join(type_dir, f), "r", encoding="utf-8") as fp:
                    d = json.load(fp)
                answered = len([k for k, v in d.get("answers", {}).items() if str(v).strip()])
                tests.append({
                    "id": d["id"],
                    "type": d["type"],
                    "title": d.get("title", d["id"]),
                    "collection": d.get("collection", ""),
                    "testNumber": d.get("testNumber", 0),
                    "year": d.get("year", 0),
                    "month": d.get("month", 0),
                    "volume": d.get("volume", 0),
                    "totalQuestions": d.get("totalQuestions", 40),
                    "parts": len(d.get("parts", [])),
                    "answersAvailable": answered,
                    "status": d.get("status", "complete" if answered == 40 else ("near-complete" if answered >= 38 else "partial")),
                    "filename": f,
                })
            except Exception:
                pass
    tests.sort(key=lambda t: (-t.get("year", 0), t.get("volume", 0), t.get("month", 0), t.get("testNumber", 0)))
    with open(os.path.join(type_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(tests, f, indent=2, ensure_ascii=False)
    print(f"  Index: {test_test_dir(type_dir)} ({len(tests)} tests)")


def test_test_dir(p):
    return os.path.basename(os.path.normpath(p))


def main():
    ap = argparse.ArgumentParser(description="IELTS Reading PDF to JSON converter v3")
    ap.add_argument("mode", choices=["batch", "single"])
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--type", choices=["academic", "general"], default="academic")
    ap.add_argument("--dpi", type=int, default=130)
    ap.add_argument("--odl-dir", default="",
                    help="Directory of pre-generated OpenDataLoader JSON (one <pdf-stem>.json per test)")
    args = ap.parse_args()

    if args.mode == "batch":
        batch_convert(args.input, args.output, args.type, args.dpi, args.odl_dir)
    else:
        ttype = "general" if "general" in os.path.basename(args.input).lower() else args.type
        data = convert_pdf_to_json(args.input, args.output, ttype, args.dpi, args.odl_dir)
        errs = validate_test(data)
        type_dir = os.path.join(args.output, "data", ttype)
        os.makedirs(type_dir, exist_ok=True)
        jp = os.path.join(type_dir, f"{data['id']}.json")
        with open(jp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"Output: {jp}")
        print(f"Parts: {len(data['parts'])}  Answers: {len(data['answers'])}  Valid: {'yes' if not errs else 'NO -> ' + '; '.join(errs)}")


if __name__ == "__main__":
    main()
