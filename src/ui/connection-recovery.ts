/**
 * Coming back after the work engine went away (restart, crash, sleep). The desktop window keeps
 * the page open across an engine restart and the local session survives it, so the page asks the
 * engine again until it answers instead of staying locked until someone reloads it.
 */
export type ProbeResult = 'ok' | 'unauthorized' | 'unreachable';
export type RecoveryState = 'checking' | 'unauthorized' | 'unreachable' | 'ok';

/** One authenticated read without the page-wide error events that api() raises. */
export async function probeEngine(fetcher: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const response = await fetcher('api/v1/projects', { cache: 'no-store' });
    if (response.ok) return 'ok';
    return response.status === 401 ? 'unauthorized' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

interface Options {
  probe: () => Promise<ProbeResult>;
  onState: (state: RecoveryState) => void;
  onRecovered: () => Promise<void> | void;
  /** Waits between automatic tries while the engine does not answer (last one repeats). */
  delays?: number[];
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export function connectionRecovery({
  probe,
  onState,
  onRecovered,
  delays = [1000, 2000, 4000, 8000],
  schedule = (run, ms) => setTimeout(run, ms),
  cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: Options) {
  let active = false,
    checking = false,
    attempt = 0,
    timer: unknown;
  const wait = () => {
    timer = schedule(() => void check(), delays[Math.min(attempt++, delays.length - 1)]);
  };
  async function check() {
    if (checking || !active) return;
    checking = true;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    onState('checking');
    const result = await probe();
    checking = false;
    if (!active) return;
    if (result === 'ok') {
      active = false;
      attempt = 0;
      onState('ok');
      await onRecovered();
      return;
    }
    onState(result);
    // A refused session does not heal by waiting; the user retries after reopening the link.
    if (result === 'unreachable') wait();
  }
  return {
    /** The page lost the engine: lock until a check succeeds (repeated reports are one loss). */
    lost() {
      if (active) return;
      active = true;
      attempt = 0;
      wait();
    },
    /** [다시 연결], window focus: check now. */
    retry() {
      if (active) void check();
    },
    get active() {
      return active;
    },
  };
}
