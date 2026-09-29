// Which earlier exchanges go with a request (PLAN-19, user 2026-09-29: "어떤 최근 요청을 보낼건지는
// 맥락 상 비슷한거를 보내는거니까 jev가 처리할 수 있지 않을까"). Each request runs a fresh CLI, so
// the conversation it sees is the list VIDE sends. With six or fewer earlier exchanges all of them
// go. With more, Jev judges each of the recent ones (does it help with the new request?), and the
// chosen ones go in their original order, always with the latest exchange (for "그거", "다시").
// No key, a failure or a timeout: the last six, as before.
import { readJevKey } from './model-router.ts';

export const CONTEXT_LIMIT = 6;
/** Candidates Jev looks at: the most recent ones (one call, bounded prompt). */
const WINDOW = 20;
const TEXT = 300;
const MIN_FIT = 0.5;

export interface ContextCandidate {
  id: string;
  request: string;
  response?: string;
}
export interface ContextChoice {
  ids: string[];
  by: 'all' | 'jev' | 'fallback';
  ms: number;
  reason?: string;
}
export interface ContextOptions {
  dataDirectory?: string;
  key?: () => string;
  fetchImpl?: typeof fetch;
  url?: string;
  model?: string;
  timeoutMs?: number;
}

const clip = (value: string | undefined) => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > TEXT ? text.slice(0, TEXT) + '…' : text;
};

/** Candidates are in time order (oldest first); the result keeps that order. */
export async function selectContext(
  body: string,
  candidates: ContextCandidate[],
  options: ContextOptions = {},
): Promise<ContextChoice> {
  const started = performance.now();
  const done = (by: ContextChoice['by'], ids: string[], reason?: string): ContextChoice => ({
    ids,
    by,
    ms: Math.round(performance.now() - started),
    ...(reason ? { reason } : {}),
  });
  const last = candidates.slice(-CONTEXT_LIMIT).map((item) => item.id);
  if (candidates.length <= CONTEXT_LIMIT) return done('all', last);
  const key = options.key?.() ?? (options.dataDirectory ? readJevKey(options.dataDirectory) : '');
  if (!key) return done('fallback', last, 'NO_KEY');
  const recent = candidates.slice(-WINDOW);
  const questions = Object.fromEntries(
    recent.map((item, i) => [
      `c${i}`,
      {
        type: 'noul',
        instructions: `Would this earlier exchange help the assistant carry out the new request (same objects, topic, file or a follow-up to it)?\nEarlier request: ${clip(item.request)}\nEarlier answer: ${clip(item.response) || '(none)'}`,
        criteria: {
          true: 'Yes, the new request builds on or needs this exchange',
          false: 'No, it is about something else',
        },
      },
    ]),
  );
  try {
    const response = await (options.fetchImpl ?? fetch)(
      options.url ?? 'https://api.typesafe.ai/v1/systemone',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model ?? 'jev-1.13.0',
          state: `A user of VIDE (an AI workspace for Rhino models and CAD drawings) sends a new request. Earlier exchanges of the same project may be passed along as context.\nNew request: ${body.slice(0, 2000)}`,
          questions,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      },
    );
    if (!response.ok) return done('fallback', last, 'HTTP_' + response.status);
    const answers = ((await response.json()) as { answers?: Record<string, { noul?: number }> })
      .answers;
    if (!answers) return done('fallback', last, 'NO_ANSWER');
    const latest = recent.length - 1;
    const scored = recent
      .map((item, i) => ({ i, id: item.id, fit: Number(answers[`c${i}`]?.noul ?? 0) }))
      .filter((item) => item.i !== latest && item.fit >= MIN_FIT)
      .sort((a, b) => b.fit - a.fit || b.i - a.i)
      .slice(0, CONTEXT_LIMIT - 1);
    const chosen = new Set([...scored.map((item) => item.i), latest]);
    return done(
      'jev',
      recent.filter((_, i) => chosen.has(i)).map((item) => item.id),
    );
  } catch (error) {
    return done(
      'fallback',
      last,
      error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'ERROR',
    );
  }
}
