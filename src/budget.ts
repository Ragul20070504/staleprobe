export type DropReason = 'QUEUE_FULL' | 'BREAKER_OPEN' | 'CANCELLED' | 'AUDIT_ERROR' | 'LOADER_SATURATED' | 'ADAPTER_ERROR' | 'CALLBACK_ERROR' | 'EXPORTER_ERROR' | 'COOLDOWN' | 'NORMALIZER_ERROR';
export interface BudgetOptions { perSecond: number; maxConcurrent: number; queueSize: number }
type Job = (signal: AbortSignal) => Promise<void>;

export class Budget {
  private readonly queue: Job[] = [];
  private readonly active = new Set<AbortController>();
  private tokens: number;
  private updated: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private immediate: ReturnType<typeof setImmediate> | undefined;
  private stopped = false;
  constructor(private readonly options: BudgetOptions, private readonly drop: (reason: DropReason) => void, private readonly now = () => performance.now()) {
    this.tokens = Math.max(1, options.perSecond); this.updated = now();
  }
  enqueue(job: Job): boolean {
    if (this.stopped) { this.drop('CANCELLED'); return false; }
    if (this.queue.length >= this.options.queueSize) { this.drop('QUEUE_FULL'); return false; }
    this.queue.push(job);
    this.schedule();
    return true;
  }
  private schedule(): void {
    if (this.immediate || this.timer || this.stopped) return;
    this.immediate = setImmediate(() => { this.immediate = undefined; this.pump(); });
    this.immediate.unref();
  }
  private pump(): void {
    if (this.stopped) return;
    const now = this.now();
    this.tokens = Math.min(Math.max(1, this.options.perSecond), this.tokens + Math.max(0, now - this.updated) * this.options.perSecond / 1000);
    this.updated = now;
    while (this.queue.length && this.active.size < this.options.maxConcurrent && this.tokens >= 1) {
      this.tokens--;
      const job = this.queue.shift()!;
      const controller = new AbortController();
      this.active.add(controller);
      void Promise.resolve().then(() => {
        if (controller.signal.aborted) { this.drop('CANCELLED'); return; }
        return job(controller.signal);
      }).catch(() => this.drop('AUDIT_ERROR')).finally(() => {
        this.active.delete(controller); this.schedule();
      });
    }
    if (this.queue.length && this.active.size < this.options.maxConcurrent && this.tokens < 1) {
      this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.max(1, Math.ceil((1 - this.tokens) * 1000 / this.options.perSecond)));
      this.timer.unref();
    }
  }
  shutdown(): void {
    this.stopped = true;
    clearTimeout(this.timer); clearImmediate(this.immediate);
    for (const _job of this.queue) this.drop('CANCELLED');
    this.queue.length = 0;
    for (const controller of this.active) controller.abort();
  }
  get pending(): number { return this.queue.length; }
  get running(): number { return this.active.size; }
}
