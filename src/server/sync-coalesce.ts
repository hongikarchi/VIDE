// One document Sync at a time per open document (PLAN-27 T-087, 2026-10-01). Every open page
// (the VIDE window, the Rhino panel, a browser tab) polls the links and starts its own automatic
// Sync when a file opens or changes; opening one 400 MB file started three full reads within 3 s.
// While a Sync of the same document runs, another automatic one joins it; one that arrives right
// after it finished reuses its result when the document has not changed since. A Sync the user
// asks for (the ↻ button, 지금 Sync) always runs fresh, and later automatic ones join that.

export type Shared = 'joined' | 'reused';

export class SyncCoalescer<T> {
  private running = new Map<string, Promise<T>>();
  private recent = new Map<string, { at: number; result: T }>();
  private readonly reuseMs: number;
  private readonly now: () => number;
  constructor(options: { reuseMs?: number; now?: () => number } = {}) {
    this.reuseMs = options.reuseMs ?? 2000;
    this.now = options.now ?? Date.now;
  }
  /**
   * Runs `task` for `key`, or shares the running or just finished one. `reusable` decides whether
   * a finished result still stands (same document revision); a failed check runs fresh.
   */
  async run(
    key: string,
    task: () => Promise<T>,
    options: {
      fresh?: boolean;
      reusable?: (result: T) => boolean | Promise<boolean>;
    } = {},
  ): Promise<{ result: T; shared?: Shared }> {
    if (!options.fresh) {
      const running = this.running.get(key);
      if (running) return { result: await running, shared: 'joined' };
      const recent = this.recent.get(key);
      if (recent && this.now() - recent.at <= this.reuseMs && options.reusable) {
        let reuse = false;
        try {
          reuse = await options.reusable(recent.result);
        } catch {
          reuse = false;
        }
        if (reuse) return { result: recent.result, shared: 'reused' };
      }
      // A Sync that started while the check above ran is joined rather than doubled.
      const started = this.running.get(key);
      if (started) return { result: await started, shared: 'joined' };
    }
    const promise = task();
    this.running.set(key, promise);
    try {
      const result = await promise;
      const at = this.now();
      for (const [other, entry] of this.recent)
        if (at - entry.at > this.reuseMs) this.recent.delete(other);
      this.recent.set(key, { at, result });
      return { result };
    } catch (error) {
      this.recent.delete(key);
      throw error;
    } finally {
      if (this.running.get(key) === promise) this.running.delete(key);
    }
  }
}
