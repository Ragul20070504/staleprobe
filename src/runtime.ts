export class OperationError extends Error {
  constructor(public readonly reason: 'TIMEOUT' | 'CANCELLED' | 'SATURATED' | 'FAILED') { super(reason); }
}

const invalidSyncFunctions = new WeakSet<object>();
/** Reject async implementations of synchronous extension points without leaking rejections. */
export function callSync<Args extends unknown[]>(fn: (...args: Args) => unknown, receiver: unknown, ...args: Args): unknown {
  if (invalidSyncFunctions.has(fn)) throw new OperationError('FAILED');
  const result = fn.apply(receiver, args);
  if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as PromiseLike<unknown>).then === 'function') {
    invalidSyncFunctions.add(fn);
    void Promise.resolve(result).catch(() => {});
    throw new OperationError('FAILED');
  }
  return result;
}

/** Bounds unresolved underlying promises, including operations ignoring cancellation. */
export class OperationGate {
  private active = 0;
  constructor(private readonly limit: number) {}
  get size(): number { return this.active; }
  async run<T>(operation: (signal: AbortSignal) => Promise<T> | T, timeoutMs: number, parent?: AbortSignal): Promise<T> {
    if (parent?.aborted) throw new OperationError('CANCELLED');
    if (this.active >= this.limit) throw new OperationError('SATURATED');
    this.active++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: () => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => { controller.abort(); reject(new OperationError('CANCELLED')); };
      parent?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new OperationError('TIMEOUT')); }, timeoutMs);
      timer.unref();
    });
    const underlying = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new OperationError('CANCELLED');
      return operation(controller.signal);
    }).finally(() => { this.active--; });
    try { return await Promise.race([underlying, stopped]); }
    finally { clearTimeout(timer); parent?.removeEventListener('abort', cancel); }
  }
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new OperationError('CANCELLED')); return; }
    const cancel = () => { clearTimeout(timer); reject(new OperationError('CANCELLED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    timer.unref();
    signal.addEventListener('abort', cancel, { once: true });
  });
}
