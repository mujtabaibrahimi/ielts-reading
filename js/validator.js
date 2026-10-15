/**
 * IELTS Reading Practice — Validator & Scoring
 * Compares user answers against the answer key
 */

const IELTSValidator = {

  /**
   * IELTS band score mapping (raw → band)
   * Based on the official IELTS Academic Reading conversion
   */
  BAND_SCORES_ACADEMIC: [
    [0, 0], [1, 1], [2, 2], [3, 2.5], [4, 3], [5, 3.5],
    [6, 3.5], [7, 4], [8, 4], [9, 4.5], [10, 4.5],
    [11, 5], [12, 5], [13, 5.5], [14, 5.5], [15, 6],
    [16, 6], [17, 6.5], [18, 6.5], [19, 7], [20, 7],
    [21, 7.5], [22, 7.5], [23, 8], [24, 8], [25, 8.5],
    [26, 8.5], [27, 9], [28, 9], [29, 9], [30, 9],
    [31, 9], [32, 9], [33, 9], [34, 9], [35, 9],
    [36, 9], [37, 9], [38, 9], [39, 9], [40, 9]
  ],

  BAND_SCORES_GENERAL: [
    [0, 0], [1, 1], [2, 2], [3, 2.5], [4, 3], [5, 3.5],
    [6, 3.5], [7, 4], [8, 4], [9, 4.5], [10, 4.5],
    [11, 5], [12, 5], [13, 5.5], [14, 5.5], [15, 6],
    [16, 6], [17, 6.5], [18, 6.5], [19, 6.5], [20, 7],
    [21, 7], [22, 7], [23, 7.5], [24, 7.5], [25, 8],
    [26, 8], [27, 8], [28, 8.5], [29, 8.5], [30, 8.5],
    [31, 9], [32, 9], [33, 9], [34, 9], [35, 9],
    [36, 9], [37, 9], [38, 9], [39, 9], [40, 9]
  ],

  /**
   * Get band score from raw score
   */
  getBandScore(rawScore, testType = 'academic') {
    const table = testType === 'general'
      ? this.BAND_SCORES_GENERAL
      : this.BAND_SCORES_ACADEMIC;

    const clamped = Math.min(40, Math.max(0, rawScore));
    for (let i = table.length - 1; i >= 0; i--) {
      if (clamped >= table[i][0]) return table[i][1];
    }
    return 0;
  },

  /**
   * Compare a single user answer against the correct answer
   */
  checkAnswer(userAnswer, correctAnswer) {
    if (!userAnswer || !correctAnswer) return false;

    const ua = String(userAnswer).trim().toUpperCase();
    const ca = String(correctAnswer).trim().toUpperCase();

    // Exact match
    if (ua === ca) return true;

    // For array answers (multi-select)
    if (Array.isArray(userAnswer) && Array.isArray(correctAnswer)) {
      if (userAnswer.length !== correctAnswer.length) return false;
      const sortedUA = [...userAnswer].map(a => a.toUpperCase()).sort();
      const sortedCA = [...correctAnswer].map(a => a.toUpperCase()).sort();
      return sortedUA.every((v, i) => v === sortedCA[i]);
    }

    // If user answer is array but correct is string (multi-select stored as array)
    if (Array.isArray(userAnswer)) {
      return userAnswer.some(a => a.trim().toUpperCase() === ca);
    }

    // Fuzzy match for text answers (case-insensitive, whitespace-normalized)
    const normalize = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
    return normalize(ua) === normalize(ca);
  },

  /**
   * Validate all answers and produce a full result
   */
  validate(userAnswers, correctAnswers, testType = 'academic') {
    const results = {
      questions: [],
      correct: 0,
      total: 0,
      bandScore: 0,
      byPart: {}
    };

    // Build results per question
    for (const [qNum, correctAnswer] of Object.entries(correctAnswers)) {
      const userAnswer = userAnswers[qNum] || '';
      const isCorrect = this.checkAnswer(userAnswer, correctAnswer);

      results.questions.push({
        number: parseInt(qNum),
        userAnswer: Array.isArray(userAnswer) ? userAnswer.join(', ') : String(userAnswer),
        correctAnswer: String(correctAnswer),
        isCorrect
      });

      if (isCorrect) results.correct++;
      results.total++;
    }

    // Sort by question number
    results.questions.sort((a, b) => a.number - b.number);

    // Calculate band score
    results.bandScore = this.getBandScore(results.correct, testType);

    // Per-part breakdown (assuming 13-13-14 split)
    const partRanges = [[1, 13], [14, 26], [27, 40]];
    results.byPart = partRanges.map(([start, end], idx) => {
      const partQs = results.questions.filter(q => q.number >= start && q.number <= end);
      return {
        part: idx + 1,
        correct: partQs.filter(q => q.isCorrect).length,
        total: partQs.length,
        range: `${start}-${end}`
      };
    });

    return results;
  },

  /**
   * Render results to DOM
   */
  renderResults(results, container) {
    container.innerHTML = '';

    // Header with band score
    const header = document.createElement('div');
    header.className = 'results-card__header';
    header.innerHTML = `
      <h2>Test Complete!</h2>
      <div class="results-card__band">Band Score: ${results.bandScore}</div>
      <div class="results-card__score">${results.correct} / ${results.total} correct</div>
      <div style="margin-top:8px">
        ${results.byPart.map(p => `Part ${p.part}: ${p.correct}/${p.total}`).join(' │ ')}
      </div>
    `;
    container.appendChild(header);

    // Answer comparison table
    const table = document.createElement('table');
    table.className = 'results-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Q#</th>
          <th>Your Answer</th>
          <th>Correct Answer</th>
          <th></th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');
    results.questions.forEach(q => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${q.number}</strong></td>
        <td class="${q.isCorrect ? 'correct' : 'incorrect'}">${q.userAnswer || '—'}</td>
        <td>${q.correctAnswer}</td>
        <td>${q.isCorrect ? '✅' : '❌'}</td>
      `;
      tbody.appendChild(tr);
    });

    container.appendChild(table);

    // Action buttons
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:12px; justify-content:center; margin-top:24px;';
    actions.innerHTML = `
      <button class="btn btn-primary btn-lg" onclick="location.reload()">🔄 Retry Test</button>
      <button class="btn btn-outline btn-lg" onclick="location.href='index.html'">📋 All Tests</button>
    `;
    container.appendChild(actions);
  }
};
