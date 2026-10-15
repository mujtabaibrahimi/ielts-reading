/**
 * IELTS Reading Practice — State Manager
 * Manages answers, flags, and progress via localStorage
 */

const IELTS_ANSWERS_KEY = 'ielts_answers_';
const IELTS_FLAGS_KEY = 'ielts_flags_';
const IELTS_PROGRESS_KEY = 'ielts_progress';

class TestState {
  constructor(testId) {
    this.testId = testId;
    this.answers = {};
    this.flags = new Set();
    this._restore();
  }

  /** Set answer for a question */
  setAnswer(qNum, value) {
    this.answers[String(qNum)] = value;
    this._saveAnswers();
  }

  /** Get answer for a question */
  getAnswer(qNum) {
    return this.answers[String(qNum)];
  }

  /** Get all answers */
  getAllAnswers() {
    return { ...this.answers };
  }

  /** Clear answer */
  clearAnswer(qNum) {
    delete this.answers[String(qNum)];
    this._saveAnswers();
  }

  /** Toggle flag */
  toggleFlag(qNum) {
    const key = String(qNum);
    if (this.flags.has(key)) {
      this.flags.delete(key);
    } else {
      this.flags.add(key);
    }
    this._saveFlags();
  }

  /** Is flagged? */
  isFlagged(qNum) {
    return this.flags.has(String(qNum));
  }

  /** Count answered questions */
  get answeredCount() {
    return Object.keys(this.answers).filter(k => {
      const v = this.answers[k];
      if (Array.isArray(v)) return v.length > 0;
      return v && String(v).trim() !== '';
    }).length;
  }

  /** Count flagged questions */
  get flaggedCount() {
    return this.flags.size;
  }

  /** Clear all state for this test */
  clear() {
    this.answers = {};
    this.flags = new Set();
    localStorage.removeItem(IELTS_ANSWERS_KEY + this.testId);
    localStorage.removeItem(IELTS_FLAGS_KEY + this.testId);
  }

  // ─── Persistence ───

  _saveAnswers() {
    try {
      localStorage.setItem(
        IELTS_ANSWERS_KEY + this.testId,
        JSON.stringify(this.answers)
      );
    } catch (e) { /* ignore */ }
  }

  _saveFlags() {
    try {
      localStorage.setItem(
        IELTS_FLAGS_KEY + this.testId,
        JSON.stringify([...this.flags])
      );
    } catch (e) { /* ignore */ }
  }

  _restore() {
    try {
      const answers = localStorage.getItem(IELTS_ANSWERS_KEY + this.testId);
      if (answers) this.answers = JSON.parse(answers);

      const flags = localStorage.getItem(IELTS_FLAGS_KEY + this.testId);
      if (flags) this.flags = new Set(JSON.parse(flags));
    } catch (e) { /* corrupt — start fresh */ }
  }

  // ─── Global Progress Tracking ───

  static getProgress() {
    try {
      const data = localStorage.getItem(IELTS_PROGRESS_KEY);
      return data ? JSON.parse(data) : { tests: {}, recent: [] };
    } catch (e) {
      return { tests: {}, recent: [] };
    }
  }

  static saveTestResult(testId, result) {
    const progress = this.getProgress();
    progress.tests[testId] = {
      bandScore: result.bandScore,
      correct: result.correct,
      total: result.total,
      date: new Date().toISOString()
    };
    // Keep recent list (max 20)
    progress.recent = [testId, ...progress.recent.filter(id => id !== testId)].slice(0, 20);
    try {
      localStorage.setItem(IELTS_PROGRESS_KEY, JSON.stringify(progress));
    } catch (e) { /* ignore */ }
  }
}
