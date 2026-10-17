export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export interface BreakerOptions {
  errorRate: number; p95Ms: number; cooldownMs: number;
  windowMs: number; minObservations: number; maxObservations: number;
}
export type Permit = 'normal' | 'probe';
export class Breaker {
  private observations: { at: number; failed: boolean; ms: number }[] = [];
  private openedAt = 0;
  private current: BreakerState = 'CLOSED';
  constructor(private readonly options: BreakerOptions, private readonly now = () => performance.now()) {}
  get state(): BreakerState { return this.current; }
  canSchedule(): boolean { return this.current === 'CLOSED' || (this.current === 'OPEN' && this.now() - this.openedAt >= this.options.cooldownMs); }
  acquire(): Permit | undefined {
    if (this.current === 'CLOSED') return 'normal';
    if (this.canSchedule()) { this.current = 'HALF_OPEN'; return 'probe'; }
    return undefined;
  }
  observe(failed: boolean, ms: number): void {
    const now = this.now();
    this.observations = this.observations.filter(o => now - o.at < this.options.windowMs);
    this.observations.push({ at: now, failed, ms });
    if (this.observations.length > this.options.maxObservations) this.observations.shift();
    if (this.current !== 'CLOSED' || this.observations.length < this.options.minObservations) return;
    const n = this.observations.length;
    const errors = this.observations.filter(o => o.failed).length / n;
    const durations = this.observations.map(o => o.ms).sort((a, b) => a - b);
    if (errors > this.options.errorRate || durations[Math.ceil(n * .95) - 1]! > this.options.p95Ms) this.open();
  }
  finish(permit: Permit, healthy: boolean): void {
    if (permit !== 'probe') return;
    if (!healthy) { this.open(); return; }
    this.current = 'CLOSED'; this.observations = [];
  }
  private open(): void { this.current = 'OPEN'; this.openedAt = this.now(); }
}
