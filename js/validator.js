/**
 * IELTS Reading Practice - Validator, Scoring, and Review
 *
 * Scores answers against the answer key, converts the raw score to an IELTS
 * band using the standard Academic and General Training tables, breaks the
 * result down by part, and generates a free "Where you got trapped" note for
 * every wrong answer based on the question type and the specific slip.
 */

const IELTSValidator = {

  // Raw score to band. Each entry is [minimum raw score, band].
  BAND_ACADEMIC: [
    [39, 9], [37, 8.5], [35, 8], [33, 7.5], [30, 7], [27, 6.5],
    [23, 6], [19, 5.5], [15, 5], [13, 4.5], [10, 4], [8, 3.5],
    [6, 3], [4, 2.5], [3, 2], [2, 1.5], [1, 1], [0, 0]
  ],
  BAND_GENERAL: [
    [40, 9], [39, 8.5], [37, 8], [36, 7.5], [34, 7], [32, 6.5],
    [30, 6], [27, 5.5], [23, 5], [19, 4], [15, 3.5], [12, 3],
    [9, 2.5], [6, 2], [3, 1], [0, 0]
  ],

  getBand(raw, testType) {
    const table = testType === 'general' ? this.BAND_GENERAL : this.BAND_ACADEMIC;
    const r = Math.min(40, Math.max(0, raw));
    for (let i = 0; i < table.length; i++) {
      if (r >= table[i][0]) return table[i][1];
    }
    return 0;
  },

  // ----- answer matching -----

  _norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[.,;:]+$/, '')
      .trim();
  },

  _tokens(s) {
    return String(s == null ? '' : s).toUpperCase().split(/[\s,/&]+/).filter(Boolean);
  },

  // "B,C,E" is a set of letters that must all be given; "A/D" means either
  // letter, so a key containing "/" is matched as alternatives instead.
  _isLetterSet(s) {
    if (String(s == null ? '' : s).indexOf('/') >= 0) return false;
    const t = this._tokens(s);
    return t.length >= 2 && t.every(x => /^[A-K]$/.test(x));
  },

  _setKey(s) {
    return [...new Set(this._tokens(s))].sort().join(',');
  },

  // "Choose THREE letters" spread over boxes 13-15 gives each box the whole set
  // "B,C,E" as its key. Consecutive questions of one group sharing such a key
  // form a run; each box then earns a mark for a distinct letter from the set.
  letterRuns(testData) {
    const answers = (testData && testData.answers) || {};
    const qmap = {};
    ((testData && testData.parts) || []).forEach(p =>
      (p.questions || []).forEach(q => { qmap[q.number] = q; }));
    const runs = {};
    let cur = null;
    for (let n = 1; n <= 40; n++) {
      const key = answers[String(n)];
      const ok = key != null && this._isLetterSet(key);
      const sk = ok ? this._setKey(key) : null;
      const gid = (qmap[n] || {}).groupId;
      if (ok && cur && cur.set === sk && cur.gid === gid && cur.nums[cur.nums.length - 1] === n - 1) {
        cur.nums.push(n);
      } else {
        cur = ok ? { set: sk, gid: gid, nums: [n] } : null;
      }
      if (cur) runs[n] = cur;
    }
    return runs;
  },

  _scoreRun(run, userAnswers) {
    const set = run.set.split(',');
    const used = new Set();
    const result = {};
    run.nums.forEach(n => {
      let toks = [...new Set(this._tokens(this.formatAns(userAnswers[String(n)])))];
      // A box holding more letters than the run has boxes is not a valid answer.
      if (toks.length > run.nums.length) toks = [];
      const hit = toks.find(t => set.includes(t) && !used.has(t));
      if (hit) used.add(hit);
      result[n] = !!hit;
    });
    return result;
  },

  // List answers ("iron, steel") accept the same items in any order,
  // separated by commas or "and". Commas inside numbers are kept.
  _listItems(s) {
    return this._norm(s).split(/,(?!\d{3}\b)|\s+and\s+/)
      .map(x => x.trim().replace(/^(the|a|an)\s+/, '')).filter(Boolean).sort();
  },

  // Build the set of acceptable normalized forms for an answer key.
  _acceptableVariants(correct) {
    const out = new Set();
    const add = (v) => { const n = this._norm(v); if (n) out.add(n); };
    const expandParens = (s) => {
      // "(the) government" accepts "the government" and "government"
      const withParens = s.replace(/[()]/g, ' ');
      const withoutParens = s.replace(/\([^)]*\)/g, ' ');
      return [withParens, withoutParens];
    };
    // Each "/" separated alternative, each with and without optional parens
    String(correct).split('/').forEach(chunk => {
      expandParens(chunk).forEach(add);
    });
    expandParens(String(correct)).forEach(add);
    return out;
  },

  checkAnswer(userAnswer, correctAnswer) {
    if (correctAnswer == null || String(correctAnswer).trim() === '') return false;
    let user = userAnswer;
    if (Array.isArray(user)) user = user.join(', ');
    if (user == null || String(user).trim() === '') return false;

    // Multi-letter answers (choose two or three)
    if (this._isLetterSet(correctAnswer)) {
      const a = [...new Set(this._tokens(user))].sort();
      const b = [...new Set(this._tokens(correctAnswer))].sort();
      return a.length === b.length && a.every((v, i) => v === b[i]);
    }

    const un = this._norm(user);
    const variants = this._acceptableVariants(correctAnswer);
    if (variants.has(un)) return true;
    // Try ignoring a leading article on both sides
    const stripArticle = (s) => s.replace(/^(the|a|an)\s+/, '');
    const unStripped = stripArticle(un);
    for (const v of variants) {
      if (stripArticle(v) === unStripped) return true;
    }
    const ui = this._listItems(un);
    if (ui.length >= 2) {
      for (const v of variants) {
        const vi = this._listItems(v);
        if (vi.length === ui.length && vi.every((x, i) => x === ui[i])) return true;
      }
    }
    return false;
  },

  formatAns(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.join(', ');
    return String(v).trim();
  },

  // ----- validation -----

  validate(userAnswers, testData) {
    const answers = (testData && testData.answers) || {};
    const type = (testData && testData.type) || 'academic';
    const qmap = {};
    ((testData && testData.parts) || []).forEach(p =>
      (p.questions || []).forEach(q => { qmap[q.number] = q; }));

    const rows = [];
    let correct = 0;
    let scorable = 0;
    const runs = this.letterRuns(testData);
    let shown = null;
    ((testData && testData.parts) || []).forEach(p => {
      if (!p._shown) return;
      shown = shown || new Set();
      p._shown.forEach(n => shown.add(n));
    });
    const runScores = {};
    for (let n = 1; n <= 40; n++) {
      const key = answers[String(n)];
      const user = userAnswers[String(n)];
      const hasKey = key != null && String(key).trim() !== '';
      if (!hasKey) {
        // Padding numbers the source PDF never printed are not listed at all.
        if (shown && !shown.has(n)) continue;
        rows.push({ n: n, user: this.formatAns(user), correct: '', status: 'unscored', trap: null });
        continue;
      }
      scorable++;
      const run = runs[n];
      let ok;
      if (run && run.nums.length > 1) {
        const first = run.nums[0];
        if (!runScores[first]) runScores[first] = this._scoreRun(run, userAnswers);
        ok = runScores[first][n];
      } else {
        ok = this.checkAnswer(user, key);
      }
      if (ok) correct++;
      const q = qmap[n] || {};
      rows.push({
        n: n,
        user: this.formatAns(user),
        correct: this.formatAns(key),
        status: ok ? 'correct' : 'incorrect',
        trap: ok ? null : this.trapNote(q.type, user, key)
      });
    }

    const parts = ((testData && testData.parts) || []).map(p => {
      const lo = p.questionRange[0], hi = p.questionRange[1];
      let c = 0, t = 0;
      rows.forEach(r => {
        if (r.n >= lo && r.n <= hi && r.status !== 'unscored') { t++; if (r.status === 'correct') c++; }
      });
      return { part: p.partNumber, lo: lo, hi: hi, correct: c, total: t };
    });

    return {
      rows: rows,
      correct: correct,
      scorable: scorable,
      total: 40,
      band: this.getBand(correct, type),
      type: type,
      parts: parts
    };
  },

  // ----- trap notes -----

  trapNote(type, user, correct) {
    const u = this.formatAns(user);
    const c = this.formatAns(correct);
    if (!u) {
      return {
        trap: 'You left this one blank.',
        fix: 'Reading has no penalty for a wrong guess, so never leave a gap. Eliminate what cannot be right, then commit to your best option before time runs out.'
      };
    }
    switch (type) {
      case 'true-false-not-given':
        return this._trapTF(u, c, 'TRUE', 'FALSE');
      case 'yes-no-not-given':
        return this._trapTF(u, c, 'YES', 'NO');
      case 'heading-matching':
        return {
          trap: 'You chose ' + u + ', but the correct heading is ' + c + '. A tempting heading often repeats a word from the paragraph or fits one detail, not the main idea.',
          fix: 'Ask what the whole paragraph is mainly about, then match the heading to that central point. Cross off each heading as you use it.'
        };
      case 'matching-paragraph-information':
      case 'matching-features':
      case 'matching-people':
      case 'matching-sentence-endings':
        return {
          trap: 'You chose ' + u + ', but the answer is ' + c + '. The option you picked probably mentions the keyword without stating the exact information the question asks for.',
          fix: 'Match the specific idea, not just a shared word. Confirm the option actually says what the question claims before you commit.'
        };
      case 'multiple-choice':
      case 'multiple-choice-multi':
        return {
          trap: 'You chose ' + u + ', but the answer is ' + c + '. Distractors reuse words from the passage while changing, overstating, or only half covering the meaning.',
          fix: 'Eliminate options that are only partly true or not mentioned, and keep the one the passage fully supports.'
        };
      default:
        return this._trapCompletion(u, c);
    }
  },

  _trapTF(u, c, posWord, negWord) {
    const uu = u.toUpperCase();
    const cc = c.toUpperCase();
    if (cc === 'NOT GIVEN') {
      return {
        trap: 'You chose ' + uu + ', but it is NOT GIVEN. The passage neither confirms nor contradicts this statement.',
        fix: 'Pick ' + posWord + ' or ' + negWord + ' only when you can point to the exact line that confirms or contradicts it. If the text is silent, it is NOT GIVEN, even when the idea seems reasonable.'
      };
    }
    if (uu === 'NOT GIVEN') {
      return {
        trap: 'You chose NOT GIVEN, but it is ' + cc + '. The information is in the passage, just worded differently.',
        fix: 'Scan for synonyms and paraphrases rather than the exact words. The answer is there if you match the idea.'
      };
    }
    return {
      trap: 'You chose ' + uu + ', but it is ' + cc + '. A small word often flips the meaning.',
      fix: 'Watch for negatives and qualifiers such as not, only, rarely, or unlikely that reverse the sense of a sentence. Re-read the whole sentence, not just the keyword.'
    };
  },

  _trapCompletion(u, c) {
    const close = this._norm(u).replace(/[^a-z0-9]/g, '') &&
      this._norm(c).replace(/[^a-z0-9]/g, '').startsWith(this._norm(u).replace(/[^a-z0-9]/g, '').slice(0, 3));
    if (close) {
      return {
        trap: 'You wrote "' + u + '", and the answer is "' + c + '". This looks like a spelling, word-form, or word-limit slip rather than the wrong idea.',
        fix: 'Copy the exact word or words from the passage, check the spelling, and respect the word limit for the gap.'
      };
    }
    return {
      trap: 'You wrote "' + u + '", but the answer is "' + c + '". A word that fits the meaning is not enough; the gap needs the exact word from the text.',
      fix: 'Find the sentence in the passage that matches the gap and lift the precise word or words, checking that they fit the grammar of the sentence.'
    };
  },

  // ----- results UI -----

  renderResults(results, container, testData) {
    container.innerHTML = '';

    const close = document.createElement('button');
    close.className = 'results__close';
    close.type = 'button';
    close.textContent = 'x';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close results');
    close.onclick = () => App.closeResults();
    container.appendChild(close);

    const header = document.createElement('div');
    header.className = 'results__header';
    const partsLine = results.parts.map(p =>
      'Part ' + p.part + ': ' + p.correct + '/' + p.total).join('   ');
    let scoreLine = results.correct + ' out of 40 correct';
    if (results.scorable < 40) scoreLine = results.correct + ' out of ' + results.scorable + ' scorable correct';
    header.innerHTML =
      '<div class="results__band-label">Estimated band score</div>' +
      '<div class="results__band">' + results.band.toFixed(1) + '</div>' +
      '<div class="results__score">' + scoreLine + '</div>' +
      '<div class="results__parts">' + partsLine + '</div>';
    if (results.scorable < 40) {
      const note = document.createElement('div');
      note.className = 'results__note';
      note.textContent = 'This test has answer keys for ' + results.scorable +
        ' of 40 questions. The rest are shown as not scored. Band is estimated from the available questions.';
      header.appendChild(note);
    }
    container.appendChild(header);

    const actions = document.createElement('div');
    actions.className = 'results__actions';
    const retake = document.createElement('button');
    retake.className = 'btn btn-primary';
    retake.type = 'button';
    retake.textContent = 'Retake test';
    retake.onclick = () => location.reload();
    const back = document.createElement('a');
    back.className = 'btn btn-outline';
    back.href = 'index.html';
    back.textContent = 'All tests';
    actions.appendChild(retake);
    actions.appendChild(back);
    container.appendChild(actions);

    const review = document.createElement('div');
    review.className = 'results__review';
    const h = document.createElement('h3');
    h.className = 'results__review-title';
    h.textContent = 'Answer review and traps';
    review.appendChild(h);

    results.rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'review-row review-row--' + r.status;

      const num = document.createElement('span');
      num.className = 'review-row__num';
      num.textContent = r.n;
      row.appendChild(num);

      const body = document.createElement('div');
      body.className = 'review-row__body';

      const ans = document.createElement('div');
      ans.className = 'review-row__answers';
      if (r.status === 'unscored') {
        ans.innerHTML = '<span class="review-row__your">Your answer: ' +
          this._esc(r.user || '(blank)') + '</span>' +
          '<span class="review-row__tag">no answer key</span>';
      } else {
        ans.innerHTML =
          '<span class="review-row__your ' + (r.status === 'correct' ? 'is-correct' : 'is-wrong') + '">Your answer: ' +
            this._esc(r.user || '(blank)') + '</span>' +
          '<span class="review-row__correct">Correct: ' + this._esc(r.correct) + '</span>';
      }
      body.appendChild(ans);

      if (App.evidence && App.evidence[r.n]) {
        const show = document.createElement('button');
        show.type = 'button';
        show.className = 'review-row__evidence';
        show.textContent = 'Show in passage';
        show.onclick = () => App.showEvidence(r.n);
        body.appendChild(show);
      }

      if (r.trap) {
        const det = document.createElement('details');
        det.className = 'trap';
        const sum = document.createElement('summary');
        sum.textContent = 'Where you got trapped';
        det.appendChild(sum);
        const box = document.createElement('div');
        box.className = 'trap__body';
        box.innerHTML = '<p class="trap__trap"><strong>The trap:</strong> ' + this._esc(r.trap.trap) + '</p>' +
          '<p class="trap__fix"><strong>The fix:</strong> ' + this._esc(r.trap.fix) + '</p>';
        det.appendChild(box);
        body.appendChild(det);
      }

      row.appendChild(body);

      const icon = document.createElement('span');
      icon.className = 'review-row__icon';
      icon.textContent = r.status === 'correct' ? '✓' : (r.status === 'incorrect' ? '✗' : '');
      row.appendChild(icon);

      review.appendChild(row);
    });

    container.appendChild(review);
    container.scrollTop = 0;
  },

  _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
};
