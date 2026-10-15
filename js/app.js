/**
 * IELTS Reading Practice — Main App Controller
 * Orchestrates the test-taking experience
 */

const App = {
  testData: null,
  state: null,
  timer: null,
  currentPart: 0,

  /**
   * Initialize the test application
   */
  async init() {
    const params = new URLSearchParams(window.location.search);
    const testId = params.get('test');
    const testType = params.get('type') || 'academic';

    if (!testId) {
      window.location.href = 'index.html';
      return;
    }

    // Show loading
    document.getElementById('passage-content').innerHTML = '<div style="display:flex;justify-content:center;padding:40px"><div class="spinner"></div></div>';

    // Load test data
    try {
      const resp = await fetch(`data/${testType}/${testId}.json`);
      this.testData = await resp.json();
    } catch (e) {
      document.getElementById('passage-content').innerHTML = '<p style="color:red;padding:20px">Failed to load test data. <a href="index.html">Go back</a></p>';
      return;
    }

    // Initialize state & timer
    this.state = new TestState(testId);
    this.timer = new IELTSTimer(testId, 60, () => this.submitTest());

    // Setup UI
    this._renderHeader();
    this._renderPart(0);
    this._renderNavigator();
    this._setupDivider();

    // Start timer
    this.timer.attach(document.getElementById('timer-display'));
    this.timer.start();

    // Setup keyboard shortcuts
    this._setupKeyboard();
  },

  /**
   * Render the test header with title, part tabs, timer
   */
  _renderHeader() {
    // Title
    const titleEl = document.getElementById('test-title');
    if (titleEl) {
      titleEl.textContent = this.testData.source || this.testData.id;
    }

    // Part tabs
    const tabsEl = document.getElementById('part-tabs');
    if (tabsEl) {
      tabsEl.innerHTML = '';
      this.testData.parts.forEach((part, i) => {
        const tab = document.createElement('button');
        tab.className = `part-tab ${i === 0 ? 'active' : ''}`;
        tab.textContent = `Part ${part.partNumber}`;
        tab.title = `Questions ${part.questionRange[0]}-${part.questionRange[1]}`;
        tab.onclick = () => this.switchPart(i);
        tabsEl.appendChild(tab);
      });
    }
  },

  /**
   * Switch to a different part
   */
  switchPart(partIndex) {
    this.currentPart = partIndex;

    // Update tabs
    document.querySelectorAll('.part-tab').forEach((tab, i) => {
      tab.classList.toggle('active', i === partIndex);
    });

    this._renderPart(partIndex);
  },

  /**
   * Render a part (passage + questions)
   */
  _renderPart(partIndex) {
    const part = this.testData.parts[partIndex];
    if (!part) return;

    // ─── Passage Panel ───
    const passageEl = document.getElementById('passage-content');
    passageEl.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'passage-panel__header';
    header.innerHTML = `
      <div class="passage-panel__title">READING PASSAGE ${part.partNumber}</div>
      <div class="passage-panel__subtitle">
        Questions ${part.questionRange[0]}–${part.questionRange[1]} · ~${part.timeSuggestion} minutes
      </div>
    `;
    passageEl.appendChild(header);

    // Title
    if (part.title) {
      const title = document.createElement('h3');
      title.style.cssText = 'font-family:var(--ff-sans);color:var(--clr-primary);margin-bottom:16px;';
      title.textContent = part.title;
      passageEl.appendChild(title);
    }

    // Passage text
    const textDiv = document.createElement('div');
    textDiv.className = 'passage-text';

    // If we have labeled sections, render them
    if (part.passage.sections && part.passage.sections.length > 0) {
      part.passage.sections.forEach(sec => {
        const secDiv = document.createElement('div');
        secDiv.className = 'passage-section';

        const label = document.createElement('span');
        label.className = 'passage-section__label';
        label.textContent = sec.label;

        const content = document.createElement('span');
        content.className = 'passage-section__content';
        content.textContent = sec.content;

        secDiv.appendChild(label);
        secDiv.appendChild(content);
        textDiv.appendChild(secDiv);
      });
    } else {
      // Plain text — split into paragraphs
      const paragraphs = part.passage.text.split(/\n\n+/).filter(p => p.trim());
      paragraphs.forEach(p => {
        const pEl = document.createElement('p');
        pEl.textContent = p.trim();
        textDiv.appendChild(pEl);
      });
    }

    passageEl.appendChild(textDiv);

    // Tables
    if (part.passage.tables) {
      part.passage.tables.forEach(tableData => {
        passageEl.appendChild(this._renderTable(tableData));
      });
    }

    // Images
    if (part.passage.images) {
      part.passage.images.forEach(imgSrc => {
        const figure = document.createElement('figure');
        figure.className = 'passage-image';
        figure.innerHTML = `<img src="${imgSrc}" alt="Passage illustration" loading="lazy">`;
        passageEl.appendChild(figure);
      });
    }

    // ─── Questions Panel ───
    const questionsEl = document.getElementById('questions-content');
    questionsEl.innerHTML = '';

    // Questions header
    const qHeader = document.createElement('div');
    qHeader.className = 'questions-panel__header';
    qHeader.innerHTML = `<div class="passage-panel__title">Questions ${part.questionRange[0]}–${part.questionRange[1]}</div>`;
    questionsEl.appendChild(qHeader);

    // Group questions by type/instruction for instruction blocks
    let currentInstruction = '';
    const questions = part.questions || [];

    if (questions.length === 0) {
      questionsEl.innerHTML += '<p style="color:var(--clr-text-muted);padding:20px">Questions for this part could not be parsed from the PDF. The passage and answer key are still available.</p>';
    }

    questions.forEach(q => {
      // Show instruction if it changed
      if (q.instruction && q.instruction !== currentInstruction) {
        currentInstruction = q.instruction;
        const instDiv = document.createElement('div');
        instDiv.className = 'question-group__instruction';
        instDiv.innerHTML = q.instruction;
        questionsEl.appendChild(instDiv);
      }

      // Render question
      QuestionRenderers.render(q, questionsEl, this.state);
    });
  },

  /**
   * Render a table from extracted data
   */
  _renderTable(tableData) {
    const table = document.createElement('table');
    table.className = 'passage-table';

    if (tableData.header) {
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      tableData.header.forEach(cell => {
        const th = document.createElement('th');
        th.textContent = cell || '';
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    if (tableData.rows) {
      const tbody = document.createElement('tbody');
      tableData.rows.slice(tableData.header ? 1 : 0).forEach(row => {
        const tr = document.createElement('tr');
        row.forEach(cell => {
          const td = document.createElement('td');
          td.textContent = cell || '';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
    }

    return table;
  },

  /**
   * Render the question navigator bar
   */
  _renderNavigator() {
    const navEl = document.getElementById('question-nav');
    if (!navEl) return;

    navEl.innerHTML = '';

    this.testData.parts.forEach((part, partIdx) => {
      const group = document.createElement('div');
      group.className = 'question-nav__group';

      for (let q = part.questionRange[0]; q <= part.questionRange[1]; q++) {
        const item = document.createElement('button');
        item.className = 'question-nav__item';
        item.textContent = q;
        item.dataset.qnum = q;
        item.onclick = () => this._scrollToQuestion(q);

        // Mark answered/flagged
        if (this.state.getAnswer(q)) item.classList.add('answered');
        if (this.state.isFlagged(q)) item.classList.add('flagged');

        group.appendChild(item);
      }

      navEl.appendChild(group);

      // Separator
      if (partIdx < this.testData.parts.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = '│';
        sep.style.cssText = 'color:var(--clr-text-light);font-size:12px;';
        navEl.appendChild(sep);
      }
    });

    // Submit button
    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn btn-accent btn-sm question-nav__submit';
    submitBtn.textContent = 'Submit Test';
    submitBtn.onclick = () => {
      if (confirm('Are you sure you want to submit? You cannot change answers after submitting.')) {
        this.submitTest();
      }
    };
    navEl.appendChild(submitBtn);
  },

  /**
   * Scroll to a question in the questions panel
   */
  _scrollToQuestion(qNum) {
    // First, find which part this question belongs to
    const partIdx = this.testData.parts.findIndex(p =>
      qNum >= p.questionRange[0] && qNum <= p.questionRange[1]
    );
    if (partIdx !== -1 && partIdx !== this.currentPart) {
      this.switchPart(partIdx);
    }

    // Scroll to the question element
    setTimeout(() => {
      const qEl = document.getElementById(`question-${qNum}`);
      if (qEl) {
        qEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        qEl.classList.add('highlight');
        setTimeout(() => qEl.classList.remove('highlight'), 2000);
      }
    }, 100);
  },

  /**
   * Setup resizable split divider
   */
  _setupDivider() {
    const divider = document.getElementById('split-divider');
    const body = document.querySelector('.test-body');
    if (!divider || !body) return;

    let isDragging = false;

    divider.addEventListener('mousedown', (e) => {
      isDragging = true;
      divider.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const rect = body.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const totalWidth = rect.width;
      const leftPct = Math.max(25, Math.min(75, (x / totalWidth) * 100));
      const rightPct = 100 - leftPct;
      body.style.gridTemplateColumns = `${leftPct}fr 6px ${rightPct}fr`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        divider.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  },

  /**
   * Setup keyboard shortcuts
   */
  _setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Alt+1/2/3 → switch parts
      if (e.altKey && e.key >= '1' && e.key <= '3') {
        const idx = parseInt(e.key) - 1;
        if (idx < this.testData.parts.length) this.switchPart(idx);
        e.preventDefault();
      }
      // Alt+P → pause timer
      if (e.altKey && e.key.toLowerCase() === 'p') {
        this.timer.togglePause();
        e.preventDefault();
      }
    });
  },

  /**
   * Submit the test — validate and show results
   */
  submitTest() {
    this.timer.stop();

    const results = IELTSValidator.validate(
      this.state.getAllAnswers(),
      this.testData.answers,
      this.testData.type
    );

    // Save progress
    TestState.saveTestResult(this.testData.id, results);

    // Show results overlay
    const overlay = document.getElementById('results-overlay');
    const card = document.getElementById('results-card');
    if (overlay && card) {
      IELTSValidator.renderResults(results, card);
      overlay.hidden = false;
    }
  },

  /**
   * Close results overlay
   */
  closeResults() {
    const overlay = document.getElementById('results-overlay');
    if (overlay) overlay.hidden = true;
  }
};

// ─── Mobile Panel Toggle ───
function togglePanel(panel) {
  const passage = document.querySelector('.passage-panel');
  const questions = document.querySelector('.questions-panel');

  if (panel === 'passage') {
    passage.classList.remove('hidden');
    questions.classList.add('hidden');
  } else {
    passage.classList.add('hidden');
    questions.classList.remove('hidden');
  }

  document.querySelectorAll('.mobile-toggle__btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.panel === panel);
  });
}
