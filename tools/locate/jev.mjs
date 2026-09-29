// Minimal Jev (TypeSafe System One) client for development tools. Never logs the API key.
import { existsSync } from 'node:fs';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

/** Load the git-ignored .env once; real keys never live in tracked files. */
export function loadLocalEnv(file = '.env') {
  if (existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
  return {
    key: process.env.TYPESAFE_API_KEY?.trim() || '',
    model: process.env.TYPESAFE_DEFAULT_MODEL?.trim() || 'jev-1.13.0',
    url: process.env.TYPESAFE_BASE_URL?.trim()
      ? process.env.TYPESAFE_BASE_URL.trim().replace(/\/$/, '') + '/systemone'
      : JEV_URL,
  };
}

/** One System One request with bounded retries for 429/529. Returns answers, usage and timing. */
export async function systemOne(config, state, questions, { timeoutMs = 20000, retries = 2 } = {}) {
  if (!config.key)
    throw Object.assign(new Error('TYPESAFE_API_KEY is not set in .env'), { code: 'NO_KEY' });
  const body = JSON.stringify({ model: config.model, state, questions });
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = performance.now() - started;
    if ((response.status === 429 || response.status === 529) && attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      // Error bodies come from the API; they do not contain our key.
      throw Object.assign(new Error(`Jev HTTP ${response.status}: ${text.slice(0, 300)}`), {
        code: 'HTTP_' + response.status,
      });
    }
    const value = JSON.parse(text);
    return { answers: value.answers ?? {}, usage: value.usage ?? {}, model: value.model, ms };
  }
}

export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
export const noul = (instructions, whenTrue, whenFalse) => ({
  type: 'noul',
  instructions,
  criteria: { true: whenTrue, false: whenFalse },
});
