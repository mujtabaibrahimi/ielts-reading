/**
 * IELTS Reading Practice - Exam Controller
 *
 * Single-screen exam: passage on the left, that part's questions on the right,
 * both visible at once. Part tabs, a 60-minute timer with localStorage
 * persistence, a question navigator, a resizable divider, and a mobile toggle.
 */

const App = {
  testData: null,
  state: null,
  timer: null,
  currentPart: 0,
  mode: 'exam',
  evidence: null,   // {qNum: {para, quote}}, loaded on submit; null until then

  async init() {
    const params = new URLSearchParams(window.location.search);
    const testId = params.get('test');
    const testType = params.get('type') || 'academic';
    this.mode = params.get('mode') === 'practice' ? 'practice' : 'exam';

    if (!testId) { window.location.href = 'index.html'; return; }

    document.getElementById('passage-content').innerHTML =
      '<div style="display:flex;justify-content:center;padding:40px"><div class="spinner"></div></div>';

    try {
      const resp = await fetch('data/' + testType + '/' + encodeURIComponent(testId) + '.json');
      if (!resp.ok) throw new Error('not found');
      this.testData = await resp.json();
      this._dropPadding();
    } catch (e) {
      document.getElementById('passage-content').innerHTML =
        '<p style="color:var(--clr-danger);padding:20px">Could not load this test. <a href="index.html">Back to all tests</a></p>';
      return;
    }

    this.state = new TestState(testId);

    this._renderHeader();
    this._renderPart(0);
    this._renderNavigator();
    this._setupDivider();
    this._setupKeyboard();
    this._setupHighlighter();

    if (window.matchMedia('(max-width: 768px)').matches) togglePanel('passage');

    const timerEl = document.getElementById('timer-display');
    if (this.mode === 'practice') {
      document.getElementById('timer-container').classList.add('timer--practice');
      timerEl.textContent = 'Practice';
      const icon = document.querySelector('.timer__icon');
      if (icon) icon.textContent = '';
    } else {
      const minutes = Math.round((this.testData.durationSeconds || 3600) / 60);
      this.timer = new IELTSTimer(testId, minutes, () => this.submitTest(true));
      this.timer.attach(timerEl);
      this.timer.start();
    }
  },

  // Some source PDFs print fewer than 40 questions; the converter pads the gap
  // with numbers that belong to no group and have no key. Those are never
  // rendered, so leave them out of the navigator, and drop a part that ends up
  // with neither questions nor a passage.
  _dropPadding() {
    const answers = this.testData.answers || {};
    this.testData.parts = (this.testData.parts || []).filter(part => {
      const grouped = new Set();
      (part.questionGroups || []).forEach(g => (g.questionNumbers || []).forEach(n => grouped.add(n)));
      const noGroups = !(part.questionGroups || []).length;
      const hasKey = q => String(answers[String(q.number)] || '').trim() !== '';
      part._shown = new Set((part.questions || [])
        .filter(q => grouped.has(q.number) || hasKey(q) || (noGroups && (q.prompt || '').trim()))
        .map(q => q.number));
      const paras = (part.passage && part.passage.paragraphs) || [];
      return part._shown.size > 0 || paras.length > 0;
    });
  },

  _renderHeader() {
    const titleEl = document.getElementById('test-title');
    if (titleEl) {
      const suffix = this.mode === 'practice' ? ' (Practice)' : '';
      titleEl.textContent = (this.testData.title || this.testData.id) + suffix;
    }
    const tabsEl = document.getElementById('part-tabs');
    if (tabsEl) {
      tabsEl.innerHTML = '';
      this.testData.parts.forEach((part, i) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'part-tab' + (i === 0 ? ' active' : '');
        tab.textContent = 'Part ' + part.partNumber;
        tab.title = 'Questions ' + part.questionRange[0] + ' to ' + part.questionRange[1];
        tab.onclick = () => this.switchPart(i);
        tabsEl.appendChild(tab);
      });
    }
  },

  switchPart(partIndex) {
    this.currentPart = partIndex;
    document.querySelectorAll('.part-tab').forEach((tab, i) =>
      tab.classList.toggle('active', i === partIndex));
    this._renderPart(partIndex);
    document.getElementById('passage-content').scrollTop = 0;
    document.getElementById('questions-content').scrollTop = 0;
  },

  _renderPart(partIndex) {
    const part = this.testData.parts[partIndex];
    if (!part) return;
    this._renderPassage(part);
    this._renderQuestions(part);
    this._hlRender('passage');
    this._hlRender('questions');
  },

  _renderPassage(part) {
    const host = document.getElementById('passage-content');
    host.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'passage-panel__header';
    header.innerHTML =
      '<div class="passage-panel__kicker">Reading Passage ' + part.partNumber + '</div>' +
      '<div class="passage-panel__subtitle">Questions ' + part.questionRange[0] + ' to ' +
        part.questionRange[1] + '. You should spend about ' + (part.timeSuggestion || 20) + ' minutes on this part.</div>';
    host.appendChild(header);

    const passage = part.passage || {};
    if (passage.heading) {
      const h = document.createElement('h2');
      h.className = 'passage-heading';
      h.textContent = passage.heading;
      host.appendChild(h);
    }

    const textDiv = document.createElement('div');
    textDiv.className = 'passage-text';
    const paragraphs = (passage.paragraphs && passage.paragraphs.length)
      ? passage.paragraphs
      : (passage.text || '').split(/\n\n+/).filter(t => t.trim()).map(t => ({ label: null, text: t }));

    if (!paragraphs.length) {
      const note = document.createElement('p');
      note.className = 'passage-empty';
      note.textContent = 'The passage text for this part is not available, but the questions and answer key still work.';
      textDiv.appendChild(note);
    }

    paragraphs.forEach(p => {
      const pEl = document.createElement('p');
      if (p.label) {
        const lab = document.createElement('span');
        lab.className = 'para-label';
        lab.textContent = p.label;
        pEl.appendChild(lab);
        pEl.appendChild(document.createTextNode(' '));
      }
      pEl.appendChild(document.createTextNode(p.text || ''));
      textDiv.appendChild(pEl);
    });
    host.appendChild(textDiv);
    if (this.evidence) this._markEvidence(part, textDiv);
  },

  // After submission, wrap each question's supporting text in a <mark>. The
  // question numbers come from CSS (data-label), not DOM text, so the passage
  // text and the student's saved highlight offsets stay unchanged.
  _markEvidence(part, textDiv) {
    const spans = {};
    part.questions.forEach(q => {
      const e = this.evidence[q.number];
      if (!e) return;
      const key = e.para + '|' + e.quote;
      (spans[key] = spans[key] || { para: e.para, quote: e.quote, nums: [] }).nums.push(q.number);
    });
    Object.values(spans).forEach(s => {
      const pEl = textDiv.children[s.para];
      if (!pEl) return;
      const pattern = s.quote.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const re = new RegExp(pattern);
      // Earlier marks split the paragraph into several text nodes; quotes never overlap.
      const node = Array.from(pEl.childNodes).find(n => n.nodeType === 3 && re.test(n.nodeValue));
      if (!node) return;
      const m = re.exec(node.nodeValue);
      const r = document.createRange();
      r.setStart(node, m.index);
      r.setEnd(node, m.index + m[0].length);
      const mark = document.createElement('mark');
      mark.className = 'evidence';
      mark.dataset.q = s.nums.join(' ');
      mark.dataset.label = 'Q' + s.nums.join(' Q');
      r.surroundContents(mark);
    });
  },

  showEvidence(qNum) {
    this.closeResults();
    const partIdx = this.testData.parts.findIndex(p => p.questions.some(q => q.number === qNum));
    if (partIdx !== -1 && partIdx !== this.currentPart) this.switchPart(partIdx);
    if (window.matchMedia('(max-width: 768px)').matches) togglePanel('passage');
    const mark = document.querySelector('#passage-content mark.evidence[data-q~="' + qNum + '"]');
    if (!mark) return;
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    mark.classList.remove('evidence--active');
    void mark.offsetWidth;   // restart the pulse animation
    mark.classList.add('evidence--active');
  },

  _renderQuestions(part) {
    const host = document.getElementById('questions-content');
    host.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'questions-panel__header';
    header.innerHTML = '<div class="passage-panel__kicker">Questions ' +
      part.questionRange[0] + ' to ' + part.questionRange[1] + '</div>';
    host.appendChild(header);

    const groups = part.questionGroups || [];
    const byNumber = {};
    (part.questions || []).forEach(q => { byNumber[q.number] = q; });

    // A single box whose key is a letter set ("A,C") needs several letters, so
    // it gets checkboxes instead of a one-answer control.
    if (!this._runs) this._runs = IELTSValidator.letterRuns(this.testData);
    (part.questions || []).forEach(q => {
      const run = this._runs[q.number];
      const lone = run && run.nums.length === 1;
      q._choose = lone ? run.set.split(',').length : 0;
      q._chooseTop = lone ? run.set.slice(-1) : '';
    });

    if (!groups.length) {
      // Fallback: render questions without group structure
      (part.questions || []).forEach(q => QuestionRenderers.render(q, host, this.state, null));
      return;
    }

    groups.forEach(group => {
      const section = document.createElement('section');
      section.className = 'question-group';
      const hasCrop = group.images && group.images.length;

      const inst = document.createElement('div');
      inst.className = 'question-group__instruction';
      const range = document.createElement('div');
      range.className = 'question-group__range';
      range.textContent = 'Questions ' + group.range[0] + ' to ' + group.range[1];
      inst.appendChild(range);
      // When a crop is shown, it already contains the instruction and the layout,
      // so only the plain-text groups get the written instruction block.
      if (!hasCrop && group.instruction) {
        const txt = document.createElement('div');
        txt.innerHTML = this._formatInstruction(group.instruction);
        inst.appendChild(txt);
      }
      section.appendChild(inst);

      if (hasCrop) {
        group.images.forEach(img => {
          const fig = document.createElement('figure');
          fig.className = 'group-crop';
          const el = document.createElement('img');
          el.src = img.src;
          el.alt = 'Questions ' + group.range[0] + ' to ' + group.range[1] + ' content';
          el.loading = 'lazy';
          fig.appendChild(el);
          section.appendChild(fig);
        });
        const lbl = document.createElement('div');
        lbl.className = 'question-group__answers-label';
        lbl.textContent = 'Your answers';
        section.appendChild(lbl);
      } else if (group.optionBank && group.optionBank.labels && group.optionBank.labels.some(l => l)) {
        // Only show the reference list when it carries descriptive text (headings
        // or feature labels). A bare letter list is redundant with the dropdowns.
        section.appendChild(this._renderOptionBank(group.optionBank));
      }

      // Completion groups: render the gapped body with an inline input at each
      // [[N]], and skip the separate rows for the numbers placed inline.
      const bodyGaps = new Set();
      if (!hasCrop && group.body && group.body.indexOf('[[') >= 0) {
        section.appendChild(this._renderCompletionBody(group, byNumber, bodyGaps));
      }

      group.questionNumbers.forEach(n => {
        if (bodyGaps.has(n)) return;
        const q = byNumber[n];
        if (q) QuestionRenderers.render(q, section, this.state, group);
      });

      host.appendChild(section);
    });
  },

  _renderCompletionBody(group, byNumber, bodyGaps) {
    const wrap = document.createElement('div');
    wrap.className = 'completion-body';
    const parts = group.body.split(/(\[\[\d+\]\])/);
    parts.forEach(part => {
      const m = part.match(/^\[\[(\d+)\]\]$/);
      if (m) {
        const n = parseInt(m[1], 10);
        bodyGaps.add(n);
        const q = byNumber[n] || {};
        const gap = document.createElement('span');
        gap.className = 'completion-gap';
        gap.id = 'question-' + n;
        const badge = document.createElement('span');
        badge.className = 'completion-gap__num';
        badge.textContent = n;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'question__input completion-gap__input';
        input.autocomplete = 'off';
        input.setAttribute('aria-label', 'Answer for question ' + n);
        if (q.maxWords) input.title = 'Max ' + q.maxWords + ' word' + (q.maxWords > 1 ? 's' : '');
        const saved = this.state.getAnswer(n);
        if (saved) input.value = Array.isArray(saved) ? saved.join(' ') : saved;
        input.addEventListener('input', () => {
          this.state.setAnswer(n, input.value.trim());
          gap.classList.toggle('answered', input.value.trim() !== '');
          QuestionRenderers._updateNav(n, this.state);
        });
        if (saved) gap.classList.add('answered');
        gap.appendChild(badge);
        gap.appendChild(input);
        wrap.appendChild(gap);
      } else if (part) {
        wrap.appendChild(document.createTextNode(part));
      }
    });
    return wrap;
  },

  _formatInstruction(text) {
    let s = String(text).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // Bold emphasis phrases the way the reference does
    s = s.replace(/\b[A-Z]{2,}(?:[ /]+(?:[A-Z]{2,}|A|AN|OR|AND|\d+))+\b/g, m => '<strong>' + m + '</strong>');
    s = s.replace(/\b[ivx]{1,4}\s*(?:-|to)\s*[ivx]{1,4}\b/g, m => '<strong>' + m + '</strong>');
    s = s.replace(/\b[A-K]\s*(?:-|to)\s*[A-K]\b/g, m => '<strong>' + m + '</strong>');
    s = s.replace(/\b[A-K](?:,\s*[A-K]){1,}(?:\s+(?:or|and)\s+[A-K])?\b/g, m => '<strong>' + m + '</strong>');
    return s;
  },

  _renderOptionBank(bank) {
    const el = document.createElement('div');
    el.className = 'option-bank';
    const title = document.createElement('div');
    title.className = 'option-bank__title';
    title.textContent = bank.title || 'Options';
    el.appendChild(title);
    bank.options.forEach((opt, i) => {
      const item = document.createElement('div');
      item.className = 'option-bank__item';
      const strong = document.createElement('strong');
      strong.textContent = opt;
      item.appendChild(strong);
      item.appendChild(document.createTextNode(' ' + ((bank.labels && bank.labels[i]) || '')));
      el.appendChild(item);
    });
    return el;
  },

  _renderNavigator() {
    const nav = document.getElementById('question-nav');
    if (!nav) return;
    nav.innerHTML = '';

    const label = document.createElement('span');
    label.className = 'question-nav__label';
    label.textContent = 'Questions';
    nav.appendChild(label);

    this.testData.parts.forEach((part, partIdx) => {
      const group = document.createElement('div');
      group.className = 'question-nav__group';
      for (let q = part.questionRange[0]; q <= part.questionRange[1]; q++) {
        if (part._shown && !part._shown.has(q)) continue;
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'question-nav__item';
        item.textContent = q;
        item.dataset.qnum = q;
        item.onclick = () => this._scrollToQuestion(q);
        if (QuestionRenderers._hasAnswer(this.state, q)) item.classList.add('answered');
        if (this.state.isFlagged(q)) item.classList.add('flagged');
        group.appendChild(item);
      }
      nav.appendChild(group);
      if (partIdx < this.testData.parts.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'question-nav__sep';
        nav.appendChild(sep);
      }
    });

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn btn-primary question-nav__submit';
    submit.textContent = this.mode === 'practice' ? 'Check answers' : 'Submit test';
    submit.onclick = () => {
      // An exam is final once submitted: the button only reopens the results.
      if (this.evidence && this.mode !== 'practice') { this.openResults(); return; }
      const msg = this.mode === 'practice'
        ? 'Check your answers now?'
        : 'Submit your test? You cannot change answers after submitting.';
      if (window.confirm(msg)) this.submitTest(false);
    };
    nav.appendChild(submit);
  },

  _scrollToQuestion(qNum) {
    const partIdx = this.testData.parts.findIndex(p =>
      qNum >= p.questionRange[0] && qNum <= p.questionRange[1]);
    if (partIdx !== -1 && partIdx !== this.currentPart) this.switchPart(partIdx);
    setTimeout(() => {
      const qEl = document.getElementById('question-' + qNum);
      if (qEl) {
        qEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        qEl.classList.add('highlight');
        setTimeout(() => qEl.classList.remove('highlight'), 1600);
      }
    }, 80);
  },

  _setupDivider() {
    const divider = document.getElementById('split-divider');
    const body = document.querySelector('.test-body');
    if (!divider || !body) return;
    let dragging = false;
    divider.addEventListener('mousedown', (e) => {
      dragging = true;
      divider.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = body.getBoundingClientRect();
      const leftPct = Math.max(28, Math.min(72, ((e.clientX - rect.left) / rect.width) * 100));
      body.style.gridTemplateColumns = leftPct + 'fr 6px ' + (100 - leftPct) + 'fr';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  },

  _setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key >= '1' && e.key <= '3') {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < this.testData.parts.length) this.switchPart(idx);
        e.preventDefault();
      }
      if (e.altKey && e.key.toLowerCase() === 'p' && this.timer) {
        this.timer.togglePause();
        e.preventDefault();
      }
    });
  },

  // ----- Highlighter -----

  _hlRoot(panel) {
    return document.getElementById(panel === 'passage' ? 'passage-content' : 'questions-content');
  },

  _hlTextNodes(root) {
    const nodes = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = w.nextNode())) nodes.push(n);
    return nodes;
  },

  _hlOffsetOf(root, node, offset) {
    const nodes = this._hlTextNodes(root);
    let pos = 0;
    for (const tn of nodes) {
      if (tn === node) return pos + offset;
      pos += tn.nodeValue.length;
    }
    return -1;
  },

  _hlSelectionRange(root) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (r.startContainer.nodeType !== 3 || r.endContainer.nodeType !== 3) return null;
    const start = this._hlOffsetOf(root, r.startContainer, r.startOffset);
    const end = this._hlOffsetOf(root, r.endContainer, r.endOffset);
    if (start < 0 || end < 0 || start >= end) return null;
    return { start: start, end: end };
  },

  _hlClear(root) {
    root.querySelectorAll('.hl').forEach(span => {
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    });
    root.normalize();
  },

  _hlApplyRange(root, start, end) {
    const nodes = this._hlTextNodes(root);
    let pos = 0;
    nodes.forEach(node => {
      const ns = pos, ne = pos + node.nodeValue.length;
      pos = ne;
      const s = Math.max(start, ns), e = Math.min(end, ne);
      if (s >= e) return;
      if (node.parentNode && node.parentNode.classList && node.parentNode.classList.contains('hl')) return;
      const r = document.createRange();
      r.setStart(node, s - ns);
      r.setEnd(node, e - ns);
      const span = document.createElement('span');
      span.className = 'hl';
      try { r.surroundContents(span); } catch (err) { /* skip tricky boundary */ }
    });
  },

  _hlMerge(ranges) {
    const sorted = ranges.slice().sort((a, b) => a.start - b.start);
    const out = [];
    sorted.forEach(r => {
      const last = out[out.length - 1];
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else out.push({ start: r.start, end: r.end });
    });
    return out;
  },

  _hlRender(panel) {
    const root = this._hlRoot(panel);
    if (!root) return;
    this._hlClear(root);
    const key = this.currentPart + '-' + panel;
    this.state.getHighlights(key).forEach(r => this._hlApplyRange(root, r.start, r.end));
  },

  _hlAdd(panel, start, end) {
    const key = this.currentPart + '-' + panel;
    const ranges = this.state.getHighlights(key);
    ranges.push({ start: start, end: end });
    this.state.setHighlights(key, this._hlMerge(ranges));
    this._hlRender(panel);
  },

  _hlRemoveAt(panel, span) {
    const root = this._hlRoot(panel);
    const off = this._hlOffsetOf(root, span.firstChild, 0);
    const key = this.currentPart + '-' + panel;
    const ranges = this.state.getHighlights(key).filter(r => !(off >= r.start && off < r.end));
    this.state.setHighlights(key, ranges);
    this._hlRender(panel);
  },

  _setupHighlighter() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hl-btn';
    btn.textContent = 'Highlight';
    btn.hidden = true;
    document.body.appendChild(btn);
    this._hlPending = null;

    const hide = () => { btn.hidden = true; this._hlPending = null; };

    document.addEventListener('mouseup', (e) => {
      if (e.target === btn) return;
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) { hide(); return; }
        const pRoot = this._hlRoot('passage'), qRoot = this._hlRoot('questions');
        let panel = null, root = null;
        if (pRoot && pRoot.contains(sel.anchorNode) && pRoot.contains(sel.focusNode)) { panel = 'passage'; root = pRoot; }
        else if (qRoot && qRoot.contains(sel.anchorNode) && qRoot.contains(sel.focusNode)) { panel = 'questions'; root = qRoot; }
        if (!root) { hide(); return; }
        const rng = this._hlSelectionRange(root);
        if (!rng) { hide(); return; }
        this._hlPending = { panel: panel, start: rng.start, end: rng.end };
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        btn.style.top = (window.scrollY + rect.top - 36) + 'px';
        btn.style.left = (window.scrollX + rect.left + rect.width / 2 - 32) + 'px';
        btn.hidden = false;
      }, 1);
    });

    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (this._hlPending) this._hlAdd(this._hlPending.panel, this._hlPending.start, this._hlPending.end);
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      hide();
    });

    ['passage', 'questions'].forEach(panel => {
      const el = this._hlRoot(panel);
      if (!el) return;
      el.addEventListener('click', (e) => {
        const hl = e.target.closest ? e.target.closest('.hl') : null;
        if (hl) this._hlRemoveAt(panel, hl);
      });
    });

    document.addEventListener('mousedown', (e) => { if (e.target !== btn) hide(); });
  },

  async submitTest(auto) {
    if (this.timer) this.timer.stop();
    const results = IELTSValidator.validate(this.state.getAllAnswers(), this.testData);
    results.autoSubmitted = !!auto;
    TestState.saveTestResult(this.testData.id, results);

    if (!this.evidence) {
      try {
        const resp = await fetch('data/evidence/' + encodeURIComponent(this.testData.id) + '.json');
        this.evidence = resp.ok ? await resp.json() : {};
      } catch (e) { this.evidence = {}; }   // no evidence file: review works without marks
      this._renderPart(this.currentPart);
      if (this.mode !== 'practice') {
        const btn = document.querySelector('.question-nav__submit');
        if (btn) btn.textContent = 'Show results';
      }
    }

    const card = document.getElementById('results-card');
    if (card) IELTSValidator.renderResults(results, card, this.testData);
    this.openResults();
  },

  openResults() {
    const overlay = document.getElementById('results-overlay');
    if (overlay) overlay.hidden = false;
  },

  closeResults() {
    const overlay = document.getElementById('results-overlay');
    if (overlay) overlay.hidden = true;
  }
};

function togglePanel(panel) {
  const passage = document.querySelector('.passage-panel');
  const questions = document.querySelector('.questions-panel');
  if (panel === 'passage') { passage.classList.remove('hidden'); questions.classList.add('hidden'); }
  else { passage.classList.add('hidden'); questions.classList.remove('hidden'); }
  document.querySelectorAll('.mobile-toggle__btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.panel === panel));
}

document.addEventListener('DOMContentLoaded', () => App.init());
