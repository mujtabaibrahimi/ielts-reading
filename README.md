# IELTS Reading Practice

> Interactive IELTS reading test simulator with exam-faithful UI

## Features

- **Split-screen layout** — Passage on left, questions on right (just like the real computer-delivered IELTS)
- **60-minute countdown timer** — With localStorage persistence (survives page refresh)
- **All question types** — True/False/Not Given, Yes/No/Not Given, Multiple Choice, Fill-in-the-blank, Heading Matching, Matching Features, Diagram Labels, Table Completion
- **Instant scoring** — Band score calculation with per-question answer comparison
- **271 practice tests** — Academic + General Training from official sources
- **Resizable panels** — Drag the divider to adjust passage/question split
- **Question navigator** — Color-coded grid showing answered/unanswered/flagged questions
- **Mobile responsive** — Tab-based toggle on small screens
- **Keyboard shortcuts** — Alt+1/2/3 to switch parts, Alt+P to pause timer

## Quick Start

```bash
# Install dependencies
npm install

# Convert PDFs to JSON (one-time, takes ~5 min)
npm run convert

# Start local server
npm run serve
```

Open http://localhost:3000 in your browser.

## How It Works

1. **PDF → JSON** — A Python script (`scripts/pdf-to-json.py`) uses PyMuPDF to extract passages, questions, and answer keys from IELTS practice test PDFs
2. **Static web app** — Vanilla HTML/CSS/JS loads the JSON data and renders the exam-faithful interface
3. **No server required** — Everything runs client-side, perfect for GitHub Pages

## Project Structure

```
├── index.html          # Test selection hub
├── test.html           # Test-taking interface (split-screen)
├── css/                # Styles (main, test, responsive)
├── js/                 # Modules (app, timer, questions, validator, state)
├── data/               # Generated JSON test data
│   ├── academic/       # Academic reading tests
│   └── general/        # General Training reading tests
├── scripts/            # Build tools
│   └── pdf-to-json.py  # PDF converter
└── reading_3_4_*/      # Source PDF files
```

## Deployment

This is a static site — deploy to any static host:

- **GitHub Pages**: Push to GitHub, enable Pages from `main` branch
- **Netlify**: Drop the folder, done
- **Vercel**: `vercel deploy`

## License

MIT
