// Adaptive placement + progression (MVP)
// Rules (placement):
// - Maintain rolling window of last 5 answers
// - If 4/5 correct => level++
// - If 3 wrong in window => level--
// Clamp 1..30

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

class AdaptiveLevel {
  constructor(startLevel=1) {
    this.level = clamp(startLevel, 1, 30);
    this.window = []; // booleans
  }

  record(isCorrect) {
    this.window.push(!!isCorrect);
    if (this.window.length > 5) this.window.shift();

    const correct = this.window.filter(Boolean).length;
    const wrong = this.window.length - correct;

    if (this.window.length === 5) {
      if (correct >= 4) this.level = clamp(this.level + 1, 1, 30);
      else if (wrong >= 3) this.level = clamp(this.level - 1, 1, 30);
    }
    return this.level;
  }
}
