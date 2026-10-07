import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The external services' secrets (SPEC-13.11, ARCH-01 「cLAWde 연결 계약」 설정·비밀, PLAN-46
 * T-217): one file `<data>/secrets/services.bin`, the JSON of every service secret encrypted with
 * Windows DPAPI for the current user. Values never leave this module except to the connector that
 * puts them in an `Authorization` header: not in API answers, logs or work records.
 */

/** Encrypts and decrypts bytes for this user. DPAPI by default; tests pass their own. */
export interface SecretProtector {
  protect(plain: Buffer): Promise<Buffer>;
  unprotect(sealed: Buffer): Promise<Buffer>;
}

const DPAPI_SCRIPT = (mode: 'Protect' | 'Unprotect') => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$text = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($text)
$out = [System.Security.Cryptography.ProtectedData]::${mode}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))
`;

/** Runs PowerShell's ProtectedData with the bytes on stdin (never on the command line). */
function dpapi(mode: 'Protect' | 'Unprotect', input: Buffer): Promise<Buffer> {
  if (process.platform !== 'win32')
    return Promise.reject(
      Object.assign(Error('SECRETS_UNAVAILABLE'), { code: 'SECRETS_UNAVAILABLE' }),
    );
  const powershell = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(DPAPI_SCRIPT(mode), 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.resume();
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8').trim();
      if (code !== 0 || !text)
        reject(Object.assign(Error('SECRETS_UNAVAILABLE'), { code: 'SECRETS_UNAVAILABLE' }));
      else resolve(Buffer.from(text, 'base64'));
    });
    child.stdin.end(input.toString('base64'));
  });
}

export const dpapiProtector: SecretProtector = {
  protect: (plain) => dpapi('Protect', plain),
  unprotect: (sealed) => dpapi('Unprotect', sealed),
};

const secretsSchema = z.record(z.string(), z.string());

/**
 * Named secrets in one sealed file. `directory` undefined (an in-memory engine) keeps them in
 * memory only. Reads are cached after the first decrypt; every write re-seals the whole file.
 */
export class SecretStore {
  private readonly file: string | undefined;
  private readonly protector: SecretProtector;
  private values: Promise<Record<string, string>> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string | undefined, protector: SecretProtector = dpapiProtector) {
    this.file = directory === undefined ? undefined : join(directory, 'secrets', 'services.bin');
    this.protector = protector;
  }
  private load() {
    return (this.values ??= (async () => {
      if (!this.file) return {};
      let sealed: Buffer;
      try {
        sealed = await readFile(this.file);
      } catch {
        return {};
      }
      try {
        return secretsSchema.parse(
          JSON.parse((await this.protector.unprotect(sealed)).toString('utf8')),
        );
      } catch {
        // Sealed by another Windows user or damaged: unreadable, treated as no secrets.
        return {};
      }
    })());
  }
  async get(name: string): Promise<string | undefined> {
    return (await this.load())[name];
  }
  /** Sets (or with `undefined` removes) one secret; writes are serialized. */
  set(name: string, value: string | undefined): Promise<void> {
    const run = this.queue.then(async () => {
      const values = { ...(await this.load()) };
      if (value === undefined) delete values[name];
      else values[name] = value;
      if (this.file) {
        if (!Object.keys(values).length) await rm(this.file, { force: true });
        else {
          const sealed = await this.protector.protect(Buffer.from(JSON.stringify(values), 'utf8'));
          await mkdir(join(this.file, '..'), { recursive: true });
          await writeFile(this.file + '.tmp', sealed, { mode: 0o600 });
          await rename(this.file + '.tmp', this.file);
        }
      }
      this.values = Promise.resolve(values);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
