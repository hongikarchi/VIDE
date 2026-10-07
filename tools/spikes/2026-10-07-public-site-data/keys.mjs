// T-203 SPIKE — public-data key loading for the probe only.
// Order (PLAN-45 「공공 자료 키」): environment variable first, then the PC-only file
// <VIDE data dir>/public-data.env. Values are never printed; use mask() in any output.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const KEY_NAMES = ['VWORLD_KEY', 'VWORLD_DOMAIN', 'JUSO_KEY', 'DATA_GO_KR_KEY'];

export function dataDirectory(environment = process.env) {
  return environment.VIDE_DATA_DIR || join(environment.LOCALAPPDATA || homedir(), 'VIDE');
}

export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function loadKeys(environment = process.env) {
  const file = join(dataDirectory(environment), 'public-data.env');
  const stored = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const keys = {};
  for (const name of KEY_NAMES) {
    const value = environment[name]?.trim() || stored[name]?.trim() || '';
    if (value) keys[name] = value;
  }
  return { keys, file };
}

export const mask = (value) => (value ? `key:****${String(value).slice(-4)}` : 'key:none');

// Remove every key value from a string (URLs, error messages) before it is logged.
export function redact(text, keys) {
  let out = String(text);
  for (const [name, value] of Object.entries(keys)) {
    if (!value || name === 'VWORLD_DOMAIN') continue;
    out = out.split(value).join(mask(value));
    out = out.split(encodeURIComponent(value)).join(mask(value));
  }
  return out;
}
