import { createHash } from 'node:crypto';

export function validateRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('Sample rate must be between 0 and 1');
}

export function shouldSample(key: string, now: number, windowMs: number, rate: number): boolean {
  validateRate(rate);
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('Invalid sample window');
  if (rate === 0) return false;
  if (rate === 1) return true;
  const hash = createHash('sha256').update(`${key.length}:${key}:${Math.floor(now / windowMs)}`).digest();
  return hash.readUInt32BE(0) % 10_000 < rate * 10_000;
}

export class Cooldown {
  private readonly entries = new Map<string, number>();
  constructor(private readonly durationMs: number, private readonly capacity: number) {}
  accept(key: string, now: number): boolean {
    if (this.durationMs === 0) return true;
    const id = createHash('sha256').update(key).digest('hex');
    const previous = this.entries.get(id);
    if (previous !== undefined && now - previous < this.durationMs) return false;
    this.entries.delete(id);
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(id, now);
    return true;
  }
  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}
