/**
 * IELTS Reading Practice — Question Renderers
 * Renders each IELTS question type into the DOM
 */

const QuestionRenderers = {

  /**
   * Main dispatch — render a question object to a container element
   */
  render(question, container, state) {
    const el = document.createElement('div');
    el.className = 'question';
    el.id = `question-${question.number}`;
    el.dataset.qnum = question.number;
    el.dataset.type = question.type;

    // Flag button
    const flag = document.createElement('button');
    flag.className = 'question__flag';
    flag.innerHTML = '🚩';
    flag.title = 'Flag for review';
    flag.onclick = () => {
      el.classList.toggle('flagged');
      flag.classList.toggle('active');
      state.toggleFlag(question.number);
    };
    el.appendChild(flag);

    // Question number badge
    const num = document.createElement('span');
    num.className = 'question__number';
    num.textContent = question.number;
    el.appendChild(num);

    // Prompt
    const prompt = document.createElement('div');
    prompt.className = 'question__prompt';
    prompt.innerHTML = this._renderPrompt(question);
    el.appendChild(prompt);

    // Options/input based on type
    const optionsEl = this._renderByType(question, state);
    if (optionsEl) el.appendChild(optionsEl);

    // Mark as answered if state has answer
    if (state.getAnswer(question.number)) {
      el.classList.add('answered');
    }

    container.appendChild(el);
    return el;
  },

  /**
   * Render prompt text — handles inline blanks like _____
   */
  _renderPrompt(question) {
    let text = question.prompt || '';
    // Escape HTML
    text = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Convert _____ blanks to styled spans
    text = text.replace(/_{3,}/g, '<span class="inline-blank"></span>');
    return text;
  },

  /**
   * Dispatch to type-specific renderer
   */
  _renderByType(question, state) {
    const type = question.type;
    if (type === 'true-false-not-given') return this._renderTFNG(question, state);
    if (type === 'yes-no-not-given') return this._renderYNNG(question, state);
    if (type === 'multiple-choice') return this._renderMCQ(question, state);
    if (type === 'multiple-choice-multi') return this._renderMCQMulti(question, state);
    if (type === 'heading-matching') return this._renderDropdown(question, state);
    if (type === 'matching-people') return this._renderDropdown(question, state);
    if (type === 'matching-features') return this._renderDropdown(question, state);
    if (type === 'matching-paragraph-information') return this._renderDropdown(question, state);
    if (type === 'matching-sentence-endings') return this._renderDropdown(question, state);
    if (type === 'fill-in-blank-from-list') return this._renderDropdown(question, state);
    if (type === 'fill-in-blank') return this._renderFillBlank(question, state);
    if (type === 'sentence-completion') return this._renderFillBlank(question, state);
    if (type === 'short-answer') return this._renderFillBlank(question, state);
    if (type === 'diagram-label') return this._renderFillBlank(question, state);
    if (type === 'table-completion') return this._renderFillBlank(question, state);
    // Fallback
    return this._renderFillBlank(question, state);
  },

  /**
   * TRUE / FALSE / NOT GIVEN — radio buttons
   */
  _renderTFNG(question, state) {
    return this._renderRadioOptions(question, ['TRUE', 'FALSE', 'NOT GIVEN'], state);
  },

  /**
   * YES / NO / NOT GIVEN — radio buttons
   */
  _renderYNNG(question, state) {
    return this._renderRadioOptions(question, ['YES', 'NO', 'NOT GIVEN'], state);
  },

  /**
   * Multiple Choice (single) — radio buttons with A/B/C/D labels
   */
  _renderMCQ(question, state) {
    const wrapper = document.createElement('div');
    wrapper.className = 'question__options--mcq';

    const letters = question.options || ['A', 'B', 'C', 'D'];
    const labels = question.optionLabels || letters;

    letters.forEach((letter, i) => {
      const label = document.createElement('label');
      label.className = 'question__choice';

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `q${question.number}`;
      radio.value = letter;

      const letterSpan = document.createElement('span');
      letterSpan.className = 'question__choice-letter';
      letterSpan.textContent = letter;

      const textSpan = document.createElement('span');
      textSpan.textContent = labels[i] || '';

      label.appendChild(radio);
      label.appendChild(letterSpan);
      label.appendChild(textSpan);

      // Restore state
      if (state.getAnswer(question.number) === letter) {
        radio.checked = true;
        label.classList.add('selected');
      }

      radio.addEventListener('change', () => {
        state.setAnswer(question.number, letter);
        wrapper.querySelectorAll('.question__choice').forEach(c => c.classList.remove('selected'));
        label.classList.add('selected');
        document.getElementById(`question-${question.number}`)?.classList.add('answered');
        this._updateNav(question.number);
      });

      wrapper.appendChild(label);
    });

    return wrapper;
  },

  /**
   * Multiple Choice (multi-select) — checkboxes
   */
  _renderMCQMulti(question, state) {
    const wrapper = document.createElement('div');
    wrapper.className = 'question__options--mcq';

    const letters = question.options || ['A', 'B', 'C', 'D'];
    const maxSelect = question.maxSelect || 2;

    letters.forEach(letter => {
      const label = document.createElement('label');
      label.className = 'question__choice';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = `q${question.number}`;
      cb.value = letter;

      const letterSpan = document.createElement('span');
      letterSpan.className = 'question__choice-letter';
      letterSpan.textContent = letter;

      label.appendChild(cb);
      label.appendChild(letterSpan);

      cb.addEventListener('change', () => {
        const checked = wrapper.querySelectorAll('input:checked');
        if (checked.length > maxSelect) {
          cb.checked = false;
          return;
        }
        const vals = Array.from(checked).map(c => c.value);
        state.setAnswer(question.number, vals);
        wrapper.querySelectorAll('.question__choice').forEach(c => c.classList.remove('selected'));
        wrapper.querySelectorAll('input:checked').forEach(c => c.closest('.question__choice').classList.add('selected'));
        document.getElementById(`question-${question.number}`)?.classList.add('answered');
        this._updateNav(question.number);
      });

      wrapper.appendChild(label);
    });

    return wrapper;
  },

  /**
   * Radio options (TFNG / YNNG)
   */
  _renderRadioOptions(question, options, state) {
    const wrapper = document.createElement('div');
    wrapper.className = 'question__options--radio';

    options.forEach(opt => {
      const label = document.createElement('label');
      label.className = 'question__radio';

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `q${question.number}`;
      radio.value = opt;

      const text = document.createElement('span');
      text.textContent = opt;

      label.appendChild(radio);
      label.appendChild(text);

      // Restore state
      if (state.getAnswer(question.number) === opt) {
        radio.checked = true;
        label.classList.add('selected');
      }

      radio.addEventListener('change', () => {
        state.setAnswer(question.number, opt);
        wrapper.querySelectorAll('.question__radio').forEach(r => r.classList.remove('selected'));
        label.classList.add('selected');
        document.getElementById(`question-${question.number}`)?.classList.add('answered');
        this._updateNav(question.number);
      });

      wrapper.appendChild(label);
    });

    return wrapper;
  },

  /**
   * Fill-in-the-blank — text input
   */
  _renderFillBlank(question, state) {
    const wrapper = document.createElement('div');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'question__input';
    input.name = `q${question.number}`;
    input.placeholder = question.maxWords ? `max ${question.maxWords} word(s)` : 'Your answer';
    if (question.maxWords) input.dataset.maxWords = question.maxWords;

    // Restore
    const saved = state.getAnswer(question.number);
    if (saved) input.value = saved;

    input.addEventListener('input', () => {
      state.setAnswer(question.number, input.value.trim());
      const qEl = document.getElementById(`question-${question.number}`);
      if (input.value.trim()) qEl?.classList.add('answered');
      else qEl?.classList.remove('answered');
      this._updateNav(question.number);
    });

    wrapper.appendChild(input);
    return wrapper;
  },

  /**
   * Dropdown / matching — select element
   */
  _renderDropdown(question, state) {
    const wrapper = document.createElement('div');

    const select = document.createElement('select');
    select.className = 'question__select';
    select.name = `q${question.number}`;

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '— Select —';
    select.appendChild(defaultOpt);

    const options = question.options || [];
    const labels = question.optionLabels || [];

    options.forEach((opt, i) => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = labels[i] ? `${opt} — ${labels[i]}` : opt;
      select.appendChild(option);
    });

    // Restore
    const saved = state.getAnswer(question.number);
    if (saved) select.value = saved;

    select.addEventListener('change', () => {
      state.setAnswer(question.number, select.value);
      const qEl = document.getElementById(`question-${question.number}`);
      if (select.value) qEl?.classList.add('answered');
      else qEl?.classList.remove('answered');
      this._updateNav(question.number);
    });

    wrapper.appendChild(select);
    return wrapper;
  },

  /**
   * Update question navigator indicator
   */
  _updateNav(qNum) {
    const navItem = document.querySelector(`.question-nav__item[data-qnum="${qNum}"]`);
    if (navItem) {
      navItem.classList.add('answered');
    }
  },

  /**
   * Render option bank (list of choices shown above questions)
   */
  renderOptionBank(options, labels, title = 'Options') {
    const bank = document.createElement('div');
    bank.className = 'option-bank';

    const titleEl = document.createElement('div');
    titleEl.className = 'option-bank__title';
    titleEl.textContent = title;
    bank.appendChild(titleEl);

    options.forEach((opt, i) => {
      const item = document.createElement('div');
      item.className = 'option-bank__item';
      item.innerHTML = `<strong>${opt}</strong> ${labels[i] || ''}`;
      bank.appendChild(item);
    });

    return bank;
  }
};
