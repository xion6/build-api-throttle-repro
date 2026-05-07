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
      this.waiting.push(() => {
        this.active++;
        if (this.active > this.peak) this.peak = this.active;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }

  get stats() {
    return { active: this.active, peak: this.peak, waiting: this.waiting.length };
  }
}
