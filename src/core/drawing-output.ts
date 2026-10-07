// Output tokens for drawing files the engine writes (PLAN-47 T-226, SPEC-14.7·14.14 1). Only a
// worker command that carries a token the engine issued may save a DWG, and only:
//  - to one of the token's files: plain `*.dwg` names in one folder, which is either inside the
//    engine's own work root (`work`) or a folder the user confirmed on the save card (`confirmed`);
//  - when that file does not exist yet (never overwrite: the original, the base drawing, a file
//    of the same name) and was not written already with this token;
//  - in the token's DWG version, which is the source drawing's version (`dwgVersionOf`).
// The engine checks before it starts the hidden ZWCAD; the worker checks again with the grant file
// (`hosts/zwcad/worker/OutputGrant.cs`) right before it saves. AI code has no such path: its
// Save/SaveAs/AttachXref stay denied (SdkCompiler.cs, CodePolicy.cs).
import { existsSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** DWG header magic → release. Older or unknown versions are not written. */
export const DWG_VERSIONS = Object.freeze({
  AC1015: '2000',
  AC1018: '2004',
  AC1021: '2007',
  AC1024: '2010',
  AC1027: '2013',
  AC1032: '2018',
} as const);
export type DwgVersion = keyof typeof DWG_VERSIONS;
export const isDwgVersion = (value: unknown): value is DwgVersion =>
  typeof value === 'string' && Object.hasOwn(DWG_VERSIONS, value);

export type OutputCode =
  | 'OUTPUT_TOKEN_INVALID'
  | 'OUTPUT_PATH_DENIED'
  | 'OUTPUT_NAME_INVALID'
  | 'OUTPUT_EXISTS'
  | 'OUTPUT_PATH_USED'
  | 'OUTPUT_VERSION_INVALID';
const failure = (code: OutputCode) => Object.assign(new Error(code), { code });

/** The six header bytes of a DWG (`AC1032` …); `OUTPUT_VERSION_INVALID` for anything else. */
export async function dwgVersionOf(path: string): Promise<DwgVersion> {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(6);
    await file.read(bytes, 0, 6, 0);
    const magic = bytes.toString('latin1');
    if (!isDwgVersion(magic)) throw failure('OUTPUT_VERSION_INVALID');
    return magic;
  } finally {
    await file.close();
  }
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** A plain file name ending in `.dwg`: no folder part, no Windows-reserved name or character. */
export function validOutputName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 4 &&
    name.length <= 200 &&
    /\.dwg$/i.test(name) &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(name) &&
    !/[. ]$/.test(name.slice(0, -4)) &&
    !name.startsWith('~vide-') &&
    !RESERVED.test(name)
  );
}

const key = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep));
};
/** The real folder (junctions and links followed), or the resolved path if it is not there. */
const real = (path: string) => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

export interface OutputToken {
  readonly id: string;
  readonly kind: 'work' | 'confirmed';
  readonly folder: string;
  readonly files: readonly string[];
  readonly version: DwgVersion;
  readonly expiresAt: number;
}
/** What the worker reads (`VIDE_OUTPUT_GRANT`); the token id goes separately in the environment. */
export interface OutputGrant {
  token: string;
  folder: string;
  files: string[];
  version: DwgVersion;
  expiresAt: number;
}

export class OutputTokens {
  private readonly tokens = new Map<string, OutputToken & { used: Set<string> }>();
  private readonly workRoot: string;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor({
    workRoot,
    now = Date.now,
    ttlMs = 30 * 60_000,
  }: {
    /** The engine's own output folder (the drawing work folder of the data folder). */
    workRoot: string;
    now?: () => number;
    ttlMs?: number;
  }) {
    if (!isAbsolute(workRoot)) throw failure('OUTPUT_PATH_DENIED');
    this.workRoot = resolve(workRoot);
    this.now = now;
    this.ttlMs = ttlMs;
  }

  /**
   * A token for `names` in `folder`. `confirmed` is only for the folder the user accepted on the
   * save card (SPEC-14.7 4); everything else must be inside the work root.
   */
  issue({
    folder,
    names,
    version,
    confirmed = false,
  }: {
    folder: string;
    names: readonly string[];
    version: string;
    confirmed?: boolean;
  }): OutputToken {
    if (!isDwgVersion(version)) throw failure('OUTPUT_VERSION_INVALID');
    if (typeof folder !== 'string' || !isAbsolute(folder)) throw failure('OUTPUT_PATH_DENIED');
    const at = resolve(folder);
    if (!confirmed && !(inside(this.workRoot, at) && inside(real(this.workRoot), real(at))))
      throw failure('OUTPUT_PATH_DENIED');
    if (!names.length || names.length > 64) throw failure('OUTPUT_NAME_INVALID');
    const seen = new Set<string>();
    const files = names.map((name) => {
      if (!validOutputName(name) || seen.has(key(name))) throw failure('OUTPUT_NAME_INVALID');
      seen.add(key(name));
      const file = join(at, name);
      if (existsSync(file)) throw failure('OUTPUT_EXISTS');
      return file;
    });
    const token = {
      id: randomBytes(24).toString('hex'),
      kind: confirmed ? ('confirmed' as const) : ('work' as const),
      folder: at,
      files: Object.freeze(files),
      version,
      expiresAt: this.now() + this.ttlMs,
      used: new Set<string>(),
    };
    this.tokens.set(token.id, token);
    const { used: _used, ...visible } = token;
    return Object.freeze(visible);
  }

  private live(id: string) {
    const token = typeof id === 'string' ? this.tokens.get(id) : undefined;
    if (!token) throw failure('OUTPUT_TOKEN_INVALID');
    if (this.now() > token.expiresAt) {
      this.tokens.delete(id);
      throw failure('OUTPUT_TOKEN_INVALID');
    }
    return token;
  }

  /** The path to write, or the refusal. Does not mark it written (`written` does). */
  authorize(id: string, path: string): { path: string; version: DwgVersion } {
    const token = this.live(id);
    if (typeof path !== 'string' || !isAbsolute(path)) throw failure('OUTPUT_PATH_DENIED');
    const file = resolve(path);
    const match = token.files.find((candidate) => key(candidate) === key(file));
    if (!match) throw failure('OUTPUT_PATH_DENIED');
    // The folder must still be the one the token named (no junction swapped in since).
    if (key(real(dirname(match))) !== key(real(token.folder))) throw failure('OUTPUT_PATH_DENIED');
    if (token.used.has(key(match))) throw failure('OUTPUT_PATH_USED');
    if (existsSync(match)) throw failure('OUTPUT_EXISTS');
    return { path: match, version: token.version };
  }

  /** After the worker reported the file written: the same path cannot be granted again. */
  written(id: string, path: string) {
    const token = this.live(id);
    const match = token.files.find((candidate) => key(candidate) === key(resolve(path)));
    if (match) token.used.add(key(match));
  }

  /** The grant file content for the worker: only the files not written yet. */
  grant(id: string): OutputGrant {
    const token = this.live(id);
    return {
      token: token.id,
      folder: token.folder,
      files: token.files.filter((file) => !token.used.has(key(file))),
      version: token.version,
      expiresAt: token.expiresAt,
    };
  }

  revoke(id: string) {
    this.tokens.delete(id);
  }
}

/** `<name>-VIDE반영-<YYYYMMDD-HHmm>.dwg`, `-2`… when taken (SPEC-14.7 2). */
export function backflowName(
  original: string,
  at: Date,
  taken: (name: string) => boolean = () => false,
) {
  const stem = basename(original).replace(/\.dwg$/i, '');
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  for (let n = 1; n < 1000; n++) {
    const name = `${stem}-VIDE반영-${stamp}${n === 1 ? '' : '-' + n}.dwg`;
    if (!taken(name)) return name;
  }
  throw failure('OUTPUT_EXISTS');
}
