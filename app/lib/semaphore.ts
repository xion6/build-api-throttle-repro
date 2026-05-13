export class Semaphore {
  private active = 0;
  private peak = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      if (this.active > this.peak) this.peak = this.active;
      return;
    }
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.active === 0) {
      throw new Error('Semaphore: release() called without matching acquire()');
    }
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }

  get stats() {
    return { active: this.active, peak: this.peak, waiting: this.waiting.length };
  }
}
