// 공공 자료 키 (PLAN-45 「공공 자료 키」, SPEC-12.4 키, ARCH-01 「PC 설정·키」): VWorld, 주소 검색 and
// 공공데이터포털 keys live only in this PC's `<data>/public-data.env` (like `typesafe.env`); an
// environment variable of the same name wins. Only the site-data library receives the values
// (`read()`); the screen, logs and API answers see whether a key is there, never its value. The
// diagnostic bundle never takes the file (diagnostic-bundle.ts FORBIDDEN).

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../contracts/errors.ts';
import { KEY_NAMES, type KeyName, type PublicDataKeys } from '../jigs/official/site-data/index.ts';

export const PUBLIC_DATA_FILE = 'public-data.env';

/** What the screen may show of one key. */
export interface KeyPresence {
  name: KeyName;
  present: boolean;
  /** env: an environment variable (cannot be changed here); file: this PC's key file. */
  from: 'env' | 'file' | null;
}

export function parseEnvFile(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return values;
}

export const isKeyName = (name: unknown): name is KeyName =>
  (KEY_NAMES as readonly unknown[]).includes(name);

export class PublicDataKeyStore {
  readonly file: string | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  constructor(directory: string | undefined, environment: NodeJS.ProcessEnv = process.env) {
    this.file = directory ? join(directory, PUBLIC_DATA_FILE) : undefined;
    this.environment = environment;
  }

  private stored() {
    if (!this.file || !existsSync(this.file)) return {};
    try {
      return parseEnvFile(readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  /** The values for the site-data library only. */
  read(): PublicDataKeys {
    const stored = this.stored();
    const keys: PublicDataKeys = {};
    for (const name of KEY_NAMES) {
      const value = this.environment[name]?.trim() || stored[name]?.trim();
      if (value) keys[name] = value;
    }
    return keys;
  }

  view(): { keys: KeyPresence[] } {
    const stored = this.stored();
    return {
      keys: KEY_NAMES.map((name) => {
        const from = this.environment[name]?.trim() ? 'env' : stored[name]?.trim() ? 'file' : null;
        return { name, present: from !== null, from };
      }),
    };
  }

  /** Put (or with an empty value remove) one key in this PC's file; other lines stay. */
  async set(name: KeyName, value: string) {
    if (!this.file) throw new DomainError('FORBIDDEN');
    const clean = value.trim();
    if (clean.length > 512 || /[\r\n\0]/.test(clean)) throw new DomainError('INVALID_INPUT');
    const lines = existsSync(this.file) ? readFileSync(this.file, 'utf8').split(/\r?\n/) : [];
    const kept = lines.filter((line) => line.trim() && !new RegExp(`^\\s*${name}\\s*=`).test(line));
    if (clean) kept.push(`${name}=${clean}`);
    await mkdir(join(this.file, '..'), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
    await rename(temporary, this.file);
    return this.view();
  }
}
