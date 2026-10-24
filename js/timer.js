/**
 * IELTS Reading Practice - Timer Module
 * 60-minute countdown with localStorage persistence
 */

const IELTS_TIMER_KEY = 'ielts_timer_';

class IELTSTimer {
  constructor(testId, durationMinutes = 60, onExpire = null) {
    this.testId = testId;
    this.durationSeconds = durationMinutes * 60;
    this.remainingSeconds = this.durationSeconds;
    this.onExpire = onExpire;
    this.intervalId = null;
    this.paused = false;
    this.element = null;

    this._restore();
  }

  /** Attach timer to a DOM element */
  attach(element) {
    this.element = element;
    this._render();
  }

  /** Start the countdown */
  start() {
    if (this.intervalId) return;
    this.paused = false;
    this.intervalId = setInterval(() => {
      if (!this.paused) {
        this.remainingSeconds--;
        this._save();
        this._render();
        if (this.remainingSeconds <= 0) {
          this.stop();
          if (this.onExpire) this.onExpire();
        }
      }
    }, 1000);
  }

  /** Pause/resume */
  togglePause() {
    this.paused = !this.paused;
    this._render();
    return this.paused;
  }

  /** Stop the timer */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Reset to full duration */
  reset() {
    this.stop();
    this.remainingSeconds = this.durationSeconds;
    this._save();
    this._render();
  }

  /** Format as MM:SS */
  get formatted() {
    const m = Math.floor(Math.max(0, this.remainingSeconds) / 60);
    const s = Math.max(0, this.remainingSeconds) % 60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  /** Is timer running low? */
  get isWarning() { return this.remainingSeconds <= 300 && this.remainingSeconds > 60; }
  get isCritical() { return this.remainingSeconds <= 60; }
  get isExpired() { return this.remainingSeconds <= 0; }
  get elapsed() { return this.durationSeconds - this.remainingSeconds; }

  // ─── Private ───

  _render() {
    if (!this.element) return;

    this.element.textContent = this.formatted;
    this.element.classList.remove('warning', 'critical');

    if (this.isCritical) {
      this.element.classList.add('critical');
    } else if (this.isWarning) {
      this.element.classList.add('warning');
    }
  }

  _save() {
    try {
      localStorage.setItem(
        IELTS_TIMER_KEY + this.testId,
        JSON.stringify({
          remaining: this.remainingSeconds,
          timestamp: Date.now()
        })
      );
    } catch (e) { /* quota exceeded - ignore */ }
  }

  _restore() {
    try {
      const saved = localStorage.getItem(IELTS_TIMER_KEY + this.testId);
      if (saved) {
        const data = JSON.parse(saved);
        const elapsed = Math.floor((Date.now() - data.timestamp) / 1000);
        this.remainingSeconds = Math.max(0, data.remaining - elapsed);
      }
    } catch (e) { /* corrupt data - start fresh */ }
  }

  _clear() {
    localStorage.removeItem(IELTS_TIMER_KEY + this.testId);
  }
}
