// The admins' side of a jig submission (ADR-041, SPEC-07.19 8, ARCH-01 §6 「jig 관리자 제출」):
// unpack a `.vjig` that a user sent through the account site into the repository's
// `extensions/jigs/<name>/` for review. Integrity is the SHA-256 the site recorded for the file and
// the pack's own content digest, recomputed; the HMAC is another PC's and is not checked here.
// Paths outside the package and forbidden files are refused; an existing folder is replaced only
// when asked. Files go to a temporary folder first and are moved into place at the end.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DomainError } from '../../contracts/errors.ts';
import { digestEntries } from './loader.ts';
import { forbiddenFiles } from './manifest.ts';
import { decodePack, packEntries, validateJig, type ValidationReport } from './pack.ts';

export interface UnpackOptions {
  /** The SHA-256 of the pack file as the site recorded it (hex). */
  digest: string;
  /** The folder of repository jigs (default `extensions/jigs` of the current folder). */
  outRoot: string;
  /** Replace an existing folder of the same name. */
  force?: boolean;
}
export interface UnpackResult {
  id: string;
  version: string;
  dir: string;
  files: string[];
  replaced: boolean;
  validation: ValidationReport;
}

/** A path inside the package: relative, forward slashes, no `..`, no drive or leading slash. */
export const safePackPath = (path: string) =>
  /^(?!\.\.?(\/|$))(?!\/)(?![A-Za-z]:)[^\\:]+$/.test(path) &&
  !path.split('/').some((part) => part === '..' || part === '.' || part === '');

/** The folder name of a jig id in the repository (`project/beam-check` → `beam-check`). */
export const repositoryFolder = (id: string) => id.split('/')[1] ?? id;

export async function unpackSubmission(
  bytes: Uint8Array,
  options: UnpackOptions,
): Promise<UnpackResult> {
  const expected = options.digest.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new DomainError('DIGEST_REQUIRED');
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new DomainError('DIGEST_MISMATCH');
  const pack = decodePack(bytes);
  if (!/^(vide|project)\/[a-z0-9]+(-[a-z0-9]+)*$/.test(pack.id))
    throw new DomainError('JIG_INVALID');
  const entries = packEntries(pack);
  const unsafe = entries.filter((entry) => !safePackPath(entry.path)).map((entry) => entry.path);
  if (unsafe.length)
    throw Object.assign(new DomainError('PATH_OUTSIDE'), { paths: unsafe.slice(0, 10) });
  if (digestEntries(entries) !== pack.digest) throw new DomainError('PACK_DIGEST_MISMATCH');
  const forbidden = forbiddenFiles(entries.map((entry) => entry.path));
  if (forbidden.length)
    throw Object.assign(new DomainError('JIG_FORBIDDEN_FILE'), { paths: forbidden.slice(0, 10) });

  const root = resolve(options.outRoot);
  const dir = join(root, repositoryFolder(pack.id));
  const replaced = existsSync(dir);
  if (replaced && !options.force) throw new DomainError('FOLDER_EXISTS');
  mkdirSync(root, { recursive: true });
  const temp = mkdtempSync(join(root, '.unpack-'));
  try {
    // The bundled steps are made again by `jig:pack`; the sources are what the repository keeps.
    const kept = entries.filter((entry) => !entry.path.startsWith('dist/'));
    for (const entry of kept) {
      const target = resolve(temp, ...entry.path.split('/'));
      if (!target.startsWith(resolve(temp) + (process.platform === 'win32' ? '\\' : '/')))
        throw new DomainError('PATH_OUTSIDE');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.bytes);
    }
    if (replaced) rmSync(dir, { recursive: true, force: true });
    renameSync(temp, dir);
    const validation = await validateJig(dir, { source: 'dev-source' });
    return {
      id: pack.id,
      version: pack.version,
      dir,
      files: kept.map((entry) => entry.path).sort(),
      replaced,
      validation,
    };
  } finally {
    if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
  }
}
