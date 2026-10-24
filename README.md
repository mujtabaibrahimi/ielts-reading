# IELTS Reading Practice

> IELTS reading practice in an exam-faithful, single-screen interface, built purely for practice on some of the hardest, heavily paraphrased passages.

A static web app that lets you read the passage and answer its questions side by side, just like the computer-delivered IELTS test, with a 60-minute timer, instant band scoring, and an explanation of the trap behind every wrong answer.

## Features

- **Single-screen exam flow.** Passage on the left, that part's questions on the right, both visible at once. No switching pages and no reading from a PDF, so you spend your hour practising, not navigating.
- **Exam-faithful interface.** Part 1 to 3 tabs, a 60-minute countdown with autosave, a resizable split, a 1 to 40 question navigator, and a mobile passage/questions toggle.
- **All question types inline.** True/False/Not Given, Yes/No/Not Given, multiple choice (single and multiple), matching headings, matching information, matching features, sentence and note and summary and table completion, short answer, and diagram labels.
- **Faithful visuals.** Heading lists, tables, flow-charts, and diagrams are shown as exact crops from the source so nothing is lost in text extraction.
- **Instant scoring.** Correct IELTS Academic and General Training band conversion, a per-part breakdown, and a full answer review with your answer next to the correct answer.
- **Where you got trapped.** Every wrong answer comes with a note explaining the trap and how to avoid it, tuned to the question type and your specific slip. Built to sharpen strategy and time management.
- **271 practice tests** across Academic and General Training, grouped by collection and ordered newest first.
- **Runs anywhere.** Pure HTML, CSS, and JavaScript. No backend, no build step, no tracking. Progress is saved in your browser.

## Quick start

```bash
# Serve the static site (Python 3)
python -m http.server 8080

# or with the npm script
npm run serve
```

Open http://localhost:8080 and pick a test.

## How it works

1. **PDF to JSON.** `scripts/pdf-to-json.py` (PyMuPDF) converts IELTS reading PDFs into structured JSON: three passages, 40 questions, an answer key, and cropped images for the visual question blocks. Clean text is extracted where the layout allows; anything that cannot be represented as text is cropped from the page.
2. **Static web app.** Vanilla HTML/CSS/JS loads the JSON and renders the exam-faithful interface, scores answers against the key, and generates the trap notes at runtime.

### Regenerating the data (optional)

```bash
pip install pymupdf
python scripts/pdf-to-json.py batch <pdf_dir> . --dpi 130
```

The converter writes `data/academic`, `data/general`, both `index.json` manifests, a `data/validation-report.json`, and crop images under `assets/crops/`. It validates every test (exactly 3 parts, questions 1 to 40, a matching answer key) and prints a pass and fail summary.

## Data status

Each test is badged by how complete its answer key is:

- **Complete** (40 of 40): 190 tests
- **Near-complete** (38 or 39 of 40): shown with the exact count
- **Partial** (fewer than 38): the missing answers come from gaps in the source PDFs and are marked as not scored

All 271 tests have the correct 3-passage, 40-question structure. See `AUDIT.md` for the full analysis.

## Project structure

```
index.html            Test hub: collections, filters, search
test.html             Exam interface: split-screen runner
css/                  main, test, responsive styles
js/                   app, questions, validator, timer, state
data/                 Generated JSON
  academic/           Academic reading tests + index.json
  general/            General Training tests + index.json
assets/crops/         Cropped question images per test
scripts/              pdf-to-json.py converter
AUDIT.md              Data audit and schema
```

## Deployment

This is a static site. Deploy to any static host:

- **GitHub Pages:** push and enable Pages on the branch.
- **Netlify:** drop the folder.
- **Vercel:** `vercel deploy`.

`serve.json` disables clean-URL rewrites so `test.html` loads with its query string intact.

## Source and feedback

The source material is taken from the [IELTS Reading Test Super PDF Pack](https://ieltsonlinetests.com/product/ielts-reading-test-super-pdf-pack) and rebuilt into a real test-style interface so you can read smoothly instead of turning and swapping PDF pages.

To help improve it, share your feedback. If you spot any error, kindly highlight it and mention it in an email to [mujtaba@mujtabaibrahimi.com](mailto:mujtaba@mujtabaibrahimi.com).

## License

MIT
