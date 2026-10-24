/**
 * IELTS Reading Practice - Question Renderers
 *
 * Renders each IELTS question type inline next to the passage. Works with the
 * group-based schema: each question belongs to a questionGroup that carries the
 * shared instruction, an optional option bank, and optional crop images for
 * blocks that cannot be shown as plain text (heading lists, tables, diagrams).
 * Every input is bound to its question number so scoring stays exact.
 */

const QuestionRenderers = {

  render(question, container, state, group) {
    const el = document.createElement('div');
    el.className = 'question';
    el.id = 'question-' + question.number;
    el.dataset.qnum = question.number;
    el.dataset.type = question.type;

    const flag = document.createElement('button');
    flag.className = 'question__flag';
    flag.type = 'button';
    flag.textContent = 'Flag';
    flag.title = 'Flag for review';
    flag.setAttribute('aria-label', 'Flag question ' + question.number + ' for review');
    if (state.isFlagged(question.number)) flag.classList.add('active');
    flag.onclick = () => {
      el.classList.toggle('flagged');
      flag.classList.toggle('active');
      state.toggleFlag(question.number);
      this._updateNav(question.number, state);
    };

    const head = document.createElement('div');
    head.className = 'question__head';

    const num = document.createElement('span');
    num.className = 'question__number';
    num.textContent = question.number;
    head.appendChild(num);

    const blockTypes = ['true-false-not-given', 'yes-no-not-given', 'multiple-choice', 'multiple-choice-multi'];
    const leadTypes = ['heading-matching', 'matching-paragraph-information', 'matching-features',
      'matching-people', 'matching-sentence-endings', 'fill-in-blank-from-list'];
    const input = this._renderInput(question, state, group);

    // A matching or heading dropdown leads, placed before the statement (as in the PDF).
    const isLead = input && input.tagName === 'SELECT' && leadTypes.includes(question.type);
    if (isLead) {
      input.classList.add('question__lead-input');
      head.appendChild(input);
    }

    const prompt = document.createElement('div');
    prompt.className = 'question__prompt';
    prompt.innerHTML = this._renderPrompt(question);
    head.appendChild(prompt);

    if (input && !isLead && !blockTypes.includes(question.type)) {
      input.classList.add('question__inline-input');
      head.appendChild(input);
    }
    head.appendChild(flag);
    el.appendChild(head);
    if (input && blockTypes.includes(question.type)) el.appendChild(input);

    if (this._hasAnswer(state, question.number)) el.classList.add('answered');

    container.appendChild(el);
    return el;
  },

  _hasAnswer(state, n) {
    const v = state.getAnswer(n);
    if (Array.isArray(v)) return v.length > 0;
    return v != null && String(v).trim() !== '';
  },

  _renderPrompt(question) {
    let text = question.prompt || '';
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    text = text.replace(/_{2,}/g, '<span class="inline-blank"></span>');
    return text;
  },

  _renderInput(question, state, group) {
    const type = question.type;
    if (question._choose > 1) return this._mcqMulti(question, state, group, question._choose);
    if (type === 'true-false-not-given') return this._radios(question, ['TRUE', 'FALSE', 'NOT GIVEN'], state);
    if (type === 'yes-no-not-given') return this._radios(question, ['YES', 'NO', 'NOT GIVEN'], state);
    if (type === 'multiple-choice') return this._mcq(question, state, group);
    if (type === 'multiple-choice-multi') return this._mcqMulti(question, state, group);
    if (type === 'heading-matching' || type === 'matching-paragraph-information' ||
        type === 'matching-features' || type === 'matching-people' ||
        type === 'matching-sentence-endings' || type === 'fill-in-blank-from-list') {
      return this._matchInput(question, state, group);
    }
    // sentence-completion, short-answer, fill-in-blank, table-completion, diagram-label
    return this._textInput(question, state);
  },

  _bind(input, question, state) {
    const commit = (value) => {
      state.setAnswer(question.number, value);
      const qEl = document.getElementById('question-' + question.number);
      const has = Array.isArray(value) ? value.length > 0 : (value != null && String(value).trim() !== '');
      if (qEl) qEl.classList.toggle('answered', has);
      this._updateNav(question.number, state);
    };
    return commit;
  },

  _radios(question, options, state) {
    const wrap = document.createElement('div');
    wrap.className = 'question__options--radio';
    const commit = this._bind(null, question, state);
    const saved = state.getAnswer(question.number);
    options.forEach(opt => {
      const label = document.createElement('label');
      label.className = 'question__radio';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'q' + question.number;
      radio.value = opt;
      if (saved === opt) { radio.checked = true; label.classList.add('selected'); }
      const text = document.createElement('span');
      text.textContent = opt;
      label.appendChild(radio);
      label.appendChild(text);
      radio.addEventListener('change', () => {
        wrap.querySelectorAll('.question__radio').forEach(r => r.classList.remove('selected'));
        label.classList.add('selected');
        commit(opt);
      });
      wrap.appendChild(label);
    });
    return wrap;
  },

  _mcq(question, state, group) {
    const letters = this._letterOptions(question, group, ['A', 'B', 'C', 'D']);
    const labels = (group && group.optionBank && group.optionBank.labels) || question.optionLabels || [];
    const wrap = document.createElement('div');
    wrap.className = 'question__options--mcq';
    const commit = this._bind(null, question, state);
    const saved = state.getAnswer(question.number);
    letters.forEach((letter, i) => {
      const label = document.createElement('label');
      label.className = 'question__choice';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'q' + question.number;
      radio.value = letter;
      if (saved === letter) { radio.checked = true; label.classList.add('selected'); }
      const ls = document.createElement('span');
      ls.className = 'question__choice-letter';
      ls.textContent = letter;
      const ts = document.createElement('span');
      ts.textContent = labels[i] || '';
      label.appendChild(radio);
      label.appendChild(ls);
      label.appendChild(ts);
      radio.addEventListener('change', () => {
        wrap.querySelectorAll('.question__choice').forEach(c => c.classList.remove('selected'));
        label.classList.add('selected');
        commit(letter);
      });
      wrap.appendChild(label);
    });
    return wrap;
  },

  _mcqMulti(question, state, group, choose) {
    // Without an extracted option list, offer A-E, or up to the highest letter
    // the key could use ("D,E,F" needs F).
    const top = Math.max(4, 'ABCDEFGHIJK'.indexOf(question._chooseTop || 'A'));
    const letters = this._letterOptions(question, group, 'ABCDEFGHIJK'.slice(0, top + 1).split(''));
    const labels = (group && group.optionBank && group.optionBank.labels) || question.optionLabels || [];
    const maxSelect = choose || question.maxSelect || 2;
    const wrap = document.createElement('div');
    wrap.className = 'question__options--mcq';
    const commit = this._bind(null, question, state);
    const saved = Array.isArray(state.getAnswer(question.number)) ? state.getAnswer(question.number) : [];
    letters.forEach((letter, i) => {
      const label = document.createElement('label');
      label.className = 'question__choice';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = letter;
      if (saved.includes(letter)) { cb.checked = true; label.classList.add('selected'); }
      const ls = document.createElement('span');
      ls.className = 'question__choice-letter';
      ls.textContent = letter;
      const ts = document.createElement('span');
      ts.textContent = labels[i] || '';
      label.appendChild(cb);
      label.appendChild(ls);
      label.appendChild(ts);
      cb.addEventListener('change', () => {
        const checked = Array.from(wrap.querySelectorAll('input:checked'));
        if (checked.length > maxSelect) { cb.checked = false; return; }
        wrap.querySelectorAll('.question__choice').forEach(c => c.classList.remove('selected'));
        checked.forEach(c => c.closest('.question__choice').classList.add('selected'));
        commit(checked.map(c => c.value));
      });
      wrap.appendChild(label);
    });
    const hint = document.createElement('div');
    hint.className = 'question__hint';
    hint.textContent = 'Choose ' + maxSelect + '.';
    wrap.appendChild(hint);
    return wrap;
  },

  _matchInput(question, state, group) {
    const bank = group && group.optionBank;
    if (bank && bank.options && bank.options.length) {
      const select = document.createElement('select');
      select.className = 'question__select';
      select.setAttribute('aria-label', 'Answer for question ' + question.number);
      const def = document.createElement('option');
      def.value = '';
      def.textContent = 'Select';
      select.appendChild(def);
      bank.options.forEach((opt, i) => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = bank.labels && bank.labels[i] ? opt + '. ' + bank.labels[i] : opt;
        select.appendChild(o);
      });
      const saved = state.getAnswer(question.number);
      if (saved) select.value = saved;
      const commit = this._bind(null, question, state);
      select.addEventListener('change', () => commit(select.value));
      return select;
    }
    // No option bank extracted: the crop above shows the choices, so accept a short typed answer.
    return this._textInput(question, state, 'Answer');
  },

  _textInput(question, state, placeholder) {
    const wrap = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'question__input';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Answer for question ' + question.number);
    input.placeholder = placeholder || (question.maxWords ? 'Max ' + question.maxWords + ' word' + (question.maxWords > 1 ? 's' : '') : 'Your answer');
    const saved = state.getAnswer(question.number);
    if (saved) input.value = Array.isArray(saved) ? saved.join(' ') : saved;
    const commit = this._bind(null, question, state);
    input.addEventListener('input', () => commit(input.value.trim()));
    wrap.appendChild(input);
    return wrap;
  },

  _letterOptions(question, group, fallback) {
    if (group && group.optionBank && group.optionBank.options && group.optionBank.options.length) {
      return group.optionBank.options;
    }
    if (Array.isArray(question.options) && question.options.length) return question.options;
    return fallback;
  },

  _updateNav(qNum, state) {
    const item = document.querySelector('.question-nav__item[data-qnum="' + qNum + '"]');
    if (!item) return;
    const answered = this._hasAnswer(state, qNum);
    item.classList.toggle('answered', answered);
    item.classList.toggle('flagged', state.isFlagged(qNum));
  }
};
