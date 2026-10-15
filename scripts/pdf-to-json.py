"""
IELTS Reading PDF → Structured JSON Converter (v2)

Improved extraction with better answer parsing and question detection.

Usage:
    python pdf-to-json.py batch <input_dir> <output_dir> [--type academic|general]
    python pdf-to-json.py single <pdf_path> <output_dir> [--type academic|general]
"""

import fitz
import json
import re
import os
import sys
import argparse
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Fix Windows console encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')


# ─── Regex patterns ───

RE_PASSAGE_HEADER = re.compile(r"READING\s+PASSAGE\s+(\d)", re.IGNORECASE)
RE_QUESTION_RANGE = re.compile(r"Questions?\s+(\d+)\s*[-–—]\s*(\d+)", re.IGNORECASE)
RE_SPEND_TIME = re.compile(r"You should spend about\s+(\d+)\s+minutes", re.IGNORECASE)
RE_SOLUTION_HEADER = re.compile(r"^Solution", re.IGNORECASE | re.MULTILINE)
RE_PART_HEADER = re.compile(r"Part\s+(\d+)\s*:\s*Question\s+(\d+)\s*[-–—]\s*(\d+)", re.IGNORECASE)
RE_HOW_TO_USE = re.compile(r"HOW TO USE", re.IGNORECASE)
RE_ACCESS_LINK = re.compile(r"Access https://ieltsonlinetests", re.IGNORECASE)


def clean_text(text: str) -> str:
    """Remove page footers/headers."""
    lines = text.split('\n')
    cleaned = []
    for line in lines:
        stripped = line.strip()
        if RE_ACCESS_LINK.match(stripped):
            continue
        if re.match(r'^page\s+\d+$', stripped, re.IGNORECASE):
            continue
        if stripped.lower().startswith('page ') and len(stripped) < 10:
            continue
        cleaned.append(line)
    return '\n'.join(cleaned)


def extract_all_text(pdf_path: str) -> List[Dict]:
    """Extract text from all pages."""
    doc = fitz.open(pdf_path)
    pages = []
    for i in range(doc.page_count):
        page = doc[i]
        text = page.get_text()
        pages.append({"page_num": i + 1, "text": clean_text(text)})
    doc.close()
    return pages


def identify_sections(pages: List[Dict]) -> Dict:
    """Identify structural sections in the PDF."""
    sections = {"cover": [], "passages": [], "answers_start": None}

    for page in pages:
        text = page["text"]
        pn = page["page_num"]

        m = RE_PASSAGE_HEADER.search(text)
        if m:
            passage_num = int(m.group(1))
            time_min = 20
            tm = RE_SPEND_TIME.search(text)
            if tm:
                time_min = int(tm.group(1))
            qr = RE_QUESTION_RANGE.search(text)
            q_start, q_end = None, None
            if qr:
                q_start, q_end = int(qr.group(1)), int(qr.group(2))
            sections["passages"].append({
                "page": pn, "passage_number": passage_num,
                "time_minutes": time_min,
                "question_start": q_start, "question_end": q_end
            })

        if RE_SOLUTION_HEADER.search(text) and sections["answers_start"] is None:
            sections["answers_start"] = pn

        if RE_HOW_TO_USE.search(text):
            sections["cover"].append(pn)

    return sections


def extract_answers(pages: List[Dict], answers_start: int) -> Dict[str, str]:
    """Extract answer key — handles format where number and answer are on separate lines."""
    answers = {}

    for page in pages:
        if page["page_num"] < answers_start:
            continue

        text = page["text"]
        lines = text.strip().split('\n')

        i = 0
        while i < len(lines):
            line = lines[i].strip()

            # Skip headers and empty lines
            if not line or RE_PART_HEADER.search(line) or line.lower().startswith('solution'):
                i += 1
                continue

            # Format 1: "1  NOT GIVEN" (number and answer on same line)
            m_same = re.match(r'^(\d+)\s+([A-Za-z\s]+?)(?:\s*$)', line)
            # Format 2: "1" on one line, "NOT GIVEN" on next
            m_num_only = re.match(r'^(\d+)$', line)

            if m_num_only:
                q_num = m_num_only.group(1)
                # Look at next line for the answer
                if i + 1 < len(lines):
                    next_line = lines[i + 1].strip()
                    if next_line and not next_line.isdigit():
                        # Clean answer
                        answer = next_line.strip()
                        # Validate it looks like an answer
                        if (answer.upper() in ('TRUE', 'FALSE', 'NOT GIVEN', 'YES', 'NO') or
                            re.match(r'^[A-G]$', answer, re.IGNORECASE) or
                            re.match(r'^[ivx]+$', answer.lower()) or
                            re.match(r'^[A-Z]$', answer) or
                            len(answer) <= 30):
                            answers[q_num] = answer
                            i += 2
                            continue
                i += 1
                continue

            if m_same:
                q_num = m_same.group(1)
                answer = m_same.group(2).strip()
                # Validate answer
                if answer and not answer.isdigit():
                    answers[q_num] = answer

            i += 1

    return answers


def classify_answer_type(answer: str) -> str:
    """Classify what type of answer this is."""
    answer = answer.strip().upper()
    if answer in ("TRUE", "FALSE", "NOT GIVEN"):
        return "true-false-not-given"
    if answer in ("YES", "NO"):
        return "yes-no-not-given"
    if re.match(r'^[A-G]$', answer):
        return "letter-matching"
    if re.match(r'^[IVX]+$', answer):
        return "roman-numeral"
    return "text"


def detect_question_type_from_context(instruction: str, answer: str = "") -> str:
    """Detect question type from instructions and answer format."""
    inst = instruction.lower()

    if "true" in inst and "false" in inst and "not given" in inst:
        return "true-false-not-given"
    if "yes" in inst and "no" in inst and "not given" in inst:
        return "yes-no-not-given"
    if "choose the two" in inst or "choose two" in inst:
        return "multiple-choice-multi"
    if "choose the correct" in inst:
        return "multiple-choice"
    if "list of headings" in inst or "correct heading" in inst:
        return "heading-matching"
    if "match the people" in inst:
        return "matching-people"
    if "which section contains" in inst or "which paragraph contains" in inst:
        return "matching-paragraph-information"
    if "match" in inst:
        return "matching-features"
    if "from the list" in inst or "drag and drop" in inst:
        return "fill-in-blank-from-list"
    if "diagram" in inst or "flow-chart" in inst or "flowchart" in inst:
        return "diagram-label"
    if "table" in inst and ("complete" in inst or "fill" in inst):
        return "table-completion"
    if "no more than" in inst and "word" in inst:
        return "sentence-completion"
    if "short answer" in inst:
        return "short-answer"

    # Infer from answer format
    if answer:
        ans_type = classify_answer_type(answer)
        if ans_type == "true-false-not-given":
            return "true-false-not-given"
        if ans_type == "yes-no-not-given":
            return "yes-no-not-given"
        if ans_type == "roman-numeral":
            return "heading-matching"
        if ans_type == "letter-matching":
            return "matching-features"

    return "fill-in-blank"


def split_into_parts(pages: List[Dict], sections: Dict) -> List[Dict]:
    """Split document into logical parts."""
    parts = []
    passage_starts = sorted(sections["passages"], key=lambda x: x["page"])

    for idx, ps in enumerate(passage_starts):
        start_page = ps["page"]
        if idx + 1 < len(passage_starts):
            end_page = passage_starts[idx + 1]["page"] - 1
        elif sections["answers_start"]:
            end_page = sections["answers_start"] - 1
        else:
            end_page = pages[-1]["page_num"]

        part_text = ""
        part_pages = []
        for page in pages:
            if start_page <= page["page_num"] <= end_page:
                part_text += page["text"] + "\n"
                part_pages.append(page)

        parts.append({
            "part_number": ps["passage_number"],
            "start_page": start_page,
            "end_page": end_page,
            "time_minutes": ps["time_minutes"],
            "question_start": ps["question_start"],
            "question_end": ps["question_end"],
            "text": part_text,
            "pages": part_pages
        })

    return parts


def separate_passage_and_questions(part_text: str) -> Tuple[str, str]:
    """Separate passage text from question text."""
    # Strategy: find "Questions N-M" that appears AFTER the passage header
    # The passage text starts after "READING PASSAGE N" and ends at first "Questions N-M"
    # that is NOT part of the "based on Reading Passage" line

    lines = part_text.split('\n')
    passage_lines = []
    question_lines = []
    in_passage = True
    found_passage_header = False

    for line in lines:
        stripped = line.strip()

        if RE_PASSAGE_HEADER.search(stripped):
            found_passage_header = True
            passage_lines.append(line)
            continue

        if found_passage_header and in_passage:
            # Check if this line starts the questions section
            m = RE_QUESTION_RANGE.search(stripped)
            if m and "based on" not in stripped.lower():
                in_passage = False
                question_lines.append(line)
                continue

        if in_passage:
            passage_lines.append(line)
        else:
            question_lines.append(line)

    return '\n'.join(passage_lines).strip(), '\n'.join(question_lines).strip()


def parse_questions_from_text(text: str, q_start: int, q_end: int, answers: Dict[str, str]) -> List[Dict]:
    """
    Parse questions from text block.
    Uses a line-by-line approach that handles IELTS PDF formatting.
    """
    if not text.strip():
        return []

    questions = []
    lines = text.split('\n')

    current_instruction = ""
    current_type = "fill-in-blank"
    i = 0

    while i < len(lines):
        line = lines[i].strip()

        if not line:
            i += 1
            continue

        # Skip "Questions N-M" headers
        if RE_QUESTION_RANGE.match(line):
            i += 1
            continue

        # Detect instruction blocks (multi-line)
        instruction_keywords = [
            "do the following", "in boxes", "write", "choose", "complete",
            "answer", "match", "which section", "which paragraph",
            "use the information", "look at", "below", "from the list",
            "no more than", "drag and drop", "fill"
        ]
        is_instruction = any(kw in line.lower() for kw in instruction_keywords)

        if is_instruction and not re.match(r'^\d+\s', line):
            current_instruction += line + " "
            # Collect multi-line instructions
            while i + 1 < len(lines):
                next_line = lines[i + 1].strip()
                if not next_line:
                    break
                if re.match(r'^\d+\s', next_line):
                    break
                # Check if it's part of instruction (TRUE/FALSE/NOT GIVEN labels etc.)
                if next_line.upper() in ('TRUE', 'FALSE', 'NOT GIVEN', 'YES', 'NO'):
                    current_instruction += next_line + " "
                    i += 1
                    break
                current_instruction += next_line + " "
                i += 1
            current_type = detect_question_type_from_context(current_instruction)
            i += 1
            continue

        # Check for question: "N  prompt text" or "N" alone
        m = re.match(r'^(\d+)\s+(.*)', line)
        if m:
            q_num = int(m.group(1))
            if q_start <= q_num <= q_end:
                q_text = m.group(2).strip()
                answer = answers.get(str(q_num), "")

                q_obj = {
                    "number": q_num,
                    "type": current_type,
                    "prompt": q_text,
                    "instruction": current_instruction.strip(),
                    "answer": answer
                }

                # Refine type from answer
                if answer:
                    ans_type = classify_answer_type(answer)
                    if ans_type == "true-false-not-given" and current_type == "fill-in-blank":
                        q_obj["type"] = "true-false-not-given"
                        q_obj["options"] = ["TRUE", "FALSE", "NOT GIVEN"]
                    elif ans_type == "yes-no-not-given" and current_type == "fill-in-blank":
                        q_obj["type"] = "yes-no-not-given"
                        q_obj["options"] = ["YES", "NO", "NOT GIVEN"]
                    elif ans_type == "roman-numeral" and current_type == "fill-in-blank":
                        q_obj["type"] = "heading-matching"
                    elif ans_type == "letter-matching" and current_type == "fill-in-blank":
                        q_obj["type"] = "matching-features"

                # Add appropriate options based on type
                if q_obj["type"] == "true-false-not-given" and "options" not in q_obj:
                    q_obj["options"] = ["TRUE", "FALSE", "NOT GIVEN"]
                elif q_obj["type"] == "yes-no-not-given" and "options" not in q_obj:
                    q_obj["options"] = ["YES", "NO", "NOT GIVEN"]
                elif q_obj["type"] == "multiple-choice":
                    q_obj["options"] = ["A", "B", "C", "D"]

                questions.append(q_obj)

        # Check for "N" alone (number on its own line, prompt on next)
        elif re.match(r'^(\d+)$', line):
            q_num = int(line)
            if q_start <= q_num <= q_end:
                # Collect prompt from next lines
                prompt_parts = []
                j = i + 1
                while j < len(lines) and j < i + 5:
                    next_line = lines[j].strip()
                    if not next_line or re.match(r'^\d+\s', next_line) or re.match(r'^\d+$', next_line):
                        break
                    prompt_parts.append(next_line)
                    j += 1

                answer = answers.get(str(q_num), "")
                prompt = ' '.join(prompt_parts)

                q_obj = {
                    "number": q_num,
                    "type": current_type,
                    "prompt": prompt,
                    "instruction": current_instruction.strip(),
                    "answer": answer
                }

                # Refine type from answer
                if answer:
                    ans_type = classify_answer_type(answer)
                    if ans_type == "true-false-not-given":
                        q_obj["type"] = "true-false-not-given"
                        q_obj["options"] = ["TRUE", "FALSE", "NOT GIVEN"]
                    elif ans_type == "yes-no-not-given":
                        q_obj["type"] = "yes-no-not-given"
                        q_obj["options"] = ["YES", "NO", "NOT GIVEN"]
                    elif ans_type == "roman-numeral":
                        q_obj["type"] = "heading-matching"
                    elif ans_type == "letter-matching":
                        q_obj["type"] = "matching-features"

                if q_obj["type"] == "true-false-not-given" and "options" not in q_obj:
                    q_obj["options"] = ["TRUE", "FALSE", "NOT GIVEN"]
                elif q_obj["type"] == "yes-no-not-given" and "options" not in q_obj:
                    q_obj["options"] = ["YES", "NO", "NOT GIVEN"]

                questions.append(q_obj)

        i += 1

    return questions


def extract_tables_from_page(pdf_path: str, page_num: int) -> List[Dict]:
    """Extract tables from a PDF page."""
    doc = fitz.open(pdf_path)
    page = doc[page_num - 1]
    tables = []
    try:
        tab = page.find_tables()
        for t in tab.tables:
            table_data = t.extract()
            if table_data and len(table_data) > 1:
                tables.append({
                    "page": page_num,
                    "rows": table_data,
                    "header": table_data[0] if table_data else []
                })
    except Exception:
        pass
    doc.close()
    return tables


def extract_images_from_page(pdf_path: str, page_num: int, output_dir: str, test_id: str) -> List[str]:
    """Extract images from a PDF page."""
    doc = fitz.open(pdf_path)
    page = doc[page_num - 1]
    images = []
    img_dir = os.path.join(output_dir, "assets", "images", test_id)
    os.makedirs(img_dir, exist_ok=True)

    image_list = page.get_images(full=True)
    for img_idx, img in enumerate(image_list):
        xref = img[0]
        try:
            base_image = doc.extract_image(xref)
            image_bytes = base_image["image"]
            image_ext = base_image["ext"]
            img_filename = f"p{page_num}_img{img_idx}.{image_ext}"
            img_path = os.path.join(img_dir, img_filename)

            with open(img_path, "wb") as f:
                f.write(image_bytes)

            images.append(f"assets/images/{test_id}/{img_filename}")
        except Exception:
            continue

    doc.close()
    return images


def convert_pdf_to_json(pdf_path: str, output_dir: str, test_type: str = "academic") -> Optional[Dict]:
    """Main converter: PDF → structured JSON."""
    filename = os.path.basename(pdf_path)
    test_id = Path(filename).stem
    test_id = re.sub(r'[^a-zA-Z0-9_-]', '-', test_id)
    test_id = re.sub(r'-+', '-', test_id).strip('-')

    print(f"  Processing: {filename}")

    pages = extract_all_text(pdf_path)
    if not pages:
        print(f"  [WARN] No pages extracted")
        return None

    sections = identify_sections(pages)

    # Extract answers
    answers = {}
    if sections["answers_start"]:
        answers = extract_answers(pages, sections["answers_start"])

    parts_data = split_into_parts(pages, sections)

    test_json = {
        "id": test_id,
        "type": test_type,
        "source": filename.replace('.pdf', '').replace('_', ' '),
        "filename": filename,
        "total_questions": 0,
        "parts": [],
        "answers": answers
    }

    for part in parts_data:
        passage_text, questions_text = separate_passage_and_questions(part["text"])

        q_start = part["question_start"] or 1
        q_end = part["question_end"] or 40
        questions = parse_questions_from_text(questions_text, q_start, q_end, answers)

        # Extract tables/images
        all_tables = []
        all_images = []
        for p in part["pages"]:
            try:
                tables = extract_tables_from_page(pdf_path, p["page_num"])
                all_tables.extend(tables)
            except Exception:
                pass
            try:
                images = extract_images_from_page(pdf_path, p["page_num"], output_dir, test_id)
                all_images.extend(images)
            except Exception:
                pass

        # Extract passage title
        title = ""
        first_lines = passage_text.strip().split('\n')[:5]
        for fl in first_lines:
            fl = fl.strip()
            if fl and not RE_PASSAGE_HEADER.search(fl) and len(fl) > 3:
                if "you should spend" not in fl.lower():
                    title = fl
                    break

        # Split passage into labeled sections (A, B, C...)
        passage_sections = []
        section_pattern = re.compile(r'^Section\s+([A-G])\.?\s*(.*)', re.IGNORECASE | re.MULTILINE)
        para_pattern = re.compile(r'^([A-G])\.?\s+(.*)', re.MULTILINE)

        for m in para_pattern.finditer(passage_text):
            passage_sections.append({
                "label": m.group(1).upper(),
                "content": m.group(2).strip()
            })

        part_json = {
            "partNumber": part["part_number"],
            "title": title,
            "questionRange": [q_start, q_end],
            "timeSuggestion": part["time_minutes"],
            "passage": {
                "text": passage_text,
                "tables": all_tables,
                "images": all_images,
                "sections": passage_sections
            },
            "questions": questions
        }

        test_json["parts"].append(part_json)
        test_json["total_questions"] += len(questions)

    return test_json


def batch_convert(input_dir: str, output_dir: str, test_type: str = "academic"):
    """Convert all PDFs in a directory."""
    # Auto-detect test type from filenames if not specified
    pdf_files = sorted([f for f in os.listdir(input_dir) if f.lower().endswith('.pdf')])

    print(f"\nFound {len(pdf_files)} PDF files in {input_dir}")
    print(f"Test type: {test_type}\n")

    type_dir = os.path.join(output_dir, "data", test_type)
    os.makedirs(type_dir, exist_ok=True)

    success = 0
    errors = []

    for i, pdf_file in enumerate(pdf_files, 1):
        pdf_path = os.path.join(input_dir, pdf_file)

        # Auto-detect type from filename
        actual_type = test_type
        fname_lower = pdf_file.lower()
        if "general" in fname_lower:
            actual_type = "general"
        elif "academic" in fname_lower or "mock" in fname_lower:
            actual_type = "academic"

        actual_dir = os.path.join(output_dir, "data", actual_type)
        os.makedirs(actual_dir, exist_ok=True)

        try:
            result = convert_pdf_to_json(pdf_path, output_dir, actual_type)
            if result:
                result["type"] = actual_type
                json_path = os.path.join(actual_dir, f"{result['id']}.json")
                with open(json_path, 'w', encoding='utf-8') as f:
                    json.dump(result, f, indent=2, ensure_ascii=False)
                success += 1
                ans_count = len(result.get('answers', {}))
                q_count = result['total_questions']
                print(f"  [OK] [{i}/{len(pdf_files)}] {pdf_file[:60]} -> {q_count}Q, {ans_count}A, type={actual_type}")
            else:
                errors.append(pdf_file)
                print(f"  [FAIL] [{i}/{len(pdf_files)}] {pdf_file} -- failed")
        except Exception as e:
            errors.append(pdf_file)
            print(f"  [ERR] [{i}/{len(pdf_files)}] {pdf_file} -- {str(e)[:80]}")

    print(f"\n{'='*50}")
    print(f"Complete: {success}/{len(pdf_files)} converted")
    if errors:
        print(f"Errors ({len(errors)}):")
        for e in errors[:10]:
            print(f"  - {e}")

    # Generate indexes
    for t in ["academic", "general"]:
        tdir = os.path.join(output_dir, "data", t)
        if os.path.exists(tdir):
            generate_index(tdir, t)


def generate_index(type_dir: str, test_type: str):
    """Generate manifest JSON listing all tests."""
    tests = []
    for f in sorted(os.listdir(type_dir)):
        if f.endswith('.json') and f != 'index.json':
            try:
                with open(os.path.join(type_dir, f), 'r', encoding='utf-8') as fp:
                    data = json.load(fp)
                    tests.append({
                        "id": data["id"],
                        "type": data["type"],
                        "source": data["source"],
                        "totalQuestions": data.get("total_questions", 0),
                        "parts": len(data.get("parts", [])),
                        "answersAvailable": len(data.get("answers", {})),
                        "filename": f
                    })
            except Exception:
                pass

    index_path = os.path.join(type_dir, "index.json")
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(tests, f, indent=2)
    print(f"  Index: {index_path} ({len(tests)} tests)")


def main():
    parser = argparse.ArgumentParser(description="IELTS Reading PDF → JSON Converter")
    parser.add_argument("mode", choices=["batch", "single"])
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--type", choices=["academic", "general"], default="academic")

    args = parser.parse_args()

    if args.mode == "batch":
        batch_convert(args.input, args.output, args.type)
    else:
        result = convert_pdf_to_json(args.input, args.output, args.type)
        if result:
            type_dir = os.path.join(args.output, "data", args.type)
            os.makedirs(type_dir, exist_ok=True)
            json_path = os.path.join(type_dir, f"{result['id']}.json")
            with open(json_path, 'w', encoding='utf-8') as f:
                json.dump(result, f, indent=2, ensure_ascii=False)
            print(f"\nOutput: {json_path}")
            print(f"Parts: {len(result['parts'])}, Questions: {result['total_questions']}, Answers: {len(result.get('answers', {}))}")


if __name__ == "__main__":
    main()
