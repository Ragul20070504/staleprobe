import { afterEach, expect, it, vi } from 'vitest';
import { Budget } from '../src/budget.js';
import { Breaker } from '../src/breaker.js';
afterEach(() => vi.useRealTimers());
it('bounds concurrency, drops newest, refills and resumes', async () => {
  vi.useFakeTimers();
  const drop = vi.fn(), seen: number[] = [];
  const budget = new Budget({ perSecond: 1, maxConcurrent: 1, queueSize: 2 }, drop, Date.now);
  let release!: () => void;
  budget.enqueue(async () => { seen.push(1); await new Promise<void>(r => { release = r; }); });
  budget.enqueue(async () => { seen.push(2); });
  expect(budget.enqueue(async () => { seen.push(3); })).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(seen).toEqual([1]); expect(budget.running).toBe(1);
  release(); await vi.advanceTimersByTimeAsync(999);
  expect(seen).toEqual([1, 2]); expect(drop).toHaveBeenCalledWith('QUEUE_FULL');
  budget.shutdown(); expect(budget.pending).toBe(0);
});
it('cancels queued and active jobs', async () => {
  vi.useFakeTimers(); const drop = vi.fn(); let aborted = false;
  const budget = new Budget({ perSecond: 10, maxConcurrent: 1, queueSize: 2 }, drop);
  budget.enqueue(signal => new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); })));
  budget.enqueue(async () => {});
  await vi.advanceTimersByTimeAsync(1); budget.shutdown();
  expect(aborted).toBe(true); expect(drop).toHaveBeenCalledWith('CANCELLED');
});
const config = { errorRate: .2, p95Ms: 100, cooldownMs: 30, windowMs: 1000, minObservations: 10, maxObservations: 100 };
it('uses minimum samples, rolling windows and one recovery probe', () => {
  let now = 0; const b = new Breaker(config, () => now);
  for (let i = 0; i < 9; i++) b.observe(true, 1);
  expect(b.state).toBe('CLOSED'); b.observe(true, 1); expect(b.state).toBe('OPEN');
  expect(b.acquire()).toBeUndefined(); now = 30;
  expect(b.acquire()).toBe('probe'); expect(b.state).toBe('HALF_OPEN'); expect(b.acquire()).toBeUndefined();
  b.finish('probe', false); expect(b.state).toBe('OPEN'); now = 60;
  b.acquire(); b.finish('probe', true); expect(b.state).toBe('CLOSED');
  b.observe(true, 1); now += 1001;
  for (let i = 0; i < 10; i++) b.observe(false, 1);
  expect(b.state).toBe('CLOSED');
});
it('opens on nearest-rank p95 and bounds observations', () => {
  const b = new Breaker({ ...config, minObservations: 2, maxObservations: 2 });
  b.observe(false, 1); b.observe(false, 101); expect(b.state).toBe('OPEN');
});
it('runs at most configured workers even with a full token bucket', async () => {
  vi.useFakeTimers(); let running = 0, peak = 0;
  const releases: (() => void)[] = [];
  const budget = new Budget({ perSecond: 100, maxConcurrent: 2, queueSize: 10 }, vi.fn());
  for (let i = 0; i < 10; i++) budget.enqueue(async () => {
    running++; peak = Math.max(peak, running);
    await new Promise<void>(r => releases.push(r)); running--;
  });
  await vi.advanceTimersByTimeAsync(1); expect(peak).toBe(2); expect(budget.pending).toBe(8);
  releases.splice(0).forEach(r => r()); await vi.advanceTimersByTimeAsync(1);
  expect(peak).toBe(2); expect(budget.pending).toBe(6);
  budget.shutdown(); releases.splice(0).forEach(r => r());
});
