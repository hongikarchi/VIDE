/**
 * The page's own errors for the engine log (T-126, ARCH-01 §6 「진단 기록」): window `error` and
 * `unhandledrejection` go to POST /api/v1/diagnostics/client with the message, stack, script,
 * line, column, page path and build. Never request text, drafts, the URL's query or hash (the
 * connect token rides there), or anything the user typed. The engine cuts, cleans and limits
 * them (20 a minute, the same one once a minute); the page keeps its own budget too so a loop of
 * errors does not flood the PC, and an error while reporting is dropped, never reported.
 */
export interface ClientError {
  kind: 'error' | 'rejection';
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
  route: string;
  version?: string;
}

const PER_MINUTE = 10;
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** The build the page came from: its entry script's hashed file name (e.g. "index-Ab12Cd.js"). */
export function pageBuild(doc: Pick<Document, 'querySelector'> = document): string | undefined {
  const src = doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
  const name = src?.split(/[?#]/)[0].split('/').pop();
  return name ? clip(name, 40) : undefined;
}

/** What one `error` / `unhandledrejection` event becomes (undefined: nothing worth sending). */
export function clientError(
  event:
    | {
        type: 'error';
        message?: string;
        error?: unknown;
        filename?: string;
        lineno?: number;
        colno?: number;
      }
    | { type: 'unhandledrejection'; reason?: unknown },
  route: string,
  version?: string,
): ClientError | undefined {
  const cause = event.type === 'error' ? event.error : event.reason;
  const error = cause instanceof Error ? cause : undefined;
  const message =
    error?.message ||
    (event.type === 'error' ? event.message : undefined) ||
    (typeof cause === 'string'
      ? cause
      : cause === undefined
        ? ''
        : Object.prototype.toString.call(cause));
  // A script error from another origin carries no detail ("Script error."): nothing to learn.
  if (!message || (event.type === 'error' && message === 'Script error.' && !event.filename))
    return undefined;
  const source =
    event.type === 'error' && event.filename ? event.filename.split(/[?#]/)[0] : undefined;
  return {
    kind: event.type === 'error' ? 'error' : 'rejection',
    message: clip((error?.name && error.name !== 'Error' ? error.name + ': ' : '') + message, 500),
    ...(error?.stack ? { stack: clip(error.stack, 4000) } : {}),
    ...(source
      ? {
          source: clip(source, 300),
          ...(event.type === 'error' && Number.isInteger(event.lineno)
            ? { line: event.lineno }
            : {}),
          ...(event.type === 'error' && Number.isInteger(event.colno)
            ? { column: event.colno }
            : {}),
        }
      : {}),
    route: clip(route, 200),
    ...(version ? { version } : {}),
  };
}

/** Listen on the window; returns the remover (tests). */
export function reportClientErrors(
  target: Window = window,
  send: (report: ClientError) => Promise<unknown> = post,
  now: () => number = Date.now,
) {
  let sending = false,
    windowStart = 0,
    count = 0;
  const seen = new Map<string, number>();
  const version = pageBuild(target.document);
  const report = (event: Parameters<typeof clientError>[0]) => {
    // An error raised while a report is being made or sent is not reported (no loop).
    if (sending) return;
    sending = true;
    try {
      const value = clientError(event, target.location.pathname, version);
      if (!value) return;
      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        count = 0;
        seen.clear();
      }
      const key = value.kind + '\n' + value.message;
      if (count >= PER_MINUTE || seen.has(key)) return;
      seen.set(key, t);
      count++;
      void send(value).catch(() => {});
    } catch {
      /* Reporting never throws into the page. */
    } finally {
      sending = false;
    }
  };
  const onError = (event: ErrorEvent) =>
    report({
      type: 'error',
      message: event.message,
      error: event.error,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  const onRejection = (event: PromiseRejectionEvent) =>
    report({ type: 'unhandledrejection', reason: event.reason });
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Plain fetch, not `api()`: a failed report must not raise the app's error notice. */
async function post(report: ClientError) {
  await fetch('api/v1/diagnostics/client', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
    keepalive: true,
  });
}
