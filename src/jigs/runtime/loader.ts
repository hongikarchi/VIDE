// Loading and the registry (ARCH-03 §1·§2): read a package folder, list its files, compute the
// digest (§12), validate the manifest against the files and the official libraries, and keep one
// list of what this VIDE can run — official libraries (built in), installed packages
// (`jig_packages`, digest checked on load) and, in a repository checkout, the jig sources under
// `extensions/jigs/` (source `dev-source`, never in the installed build).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../../contracts/errors.ts';
import type { JigStore } from '../../core/jig-store.ts';
// Pure (zod and the part registry only): the same check the screen runs before drawing.
import { scopeOf, validatePanel } from '../../ui/jig-panel/spec.ts';
import { sha256 } from './hash.ts';
import {
  validateManifest,
  type DerivedValues,
  type JigManifest,
  type JigSource,
  type ManifestIssue,
} from './manifest.ts';

export interface LoadedJig {
  dir: string;
  id: string;
  version: string;
  manifest: JigManifest;
  derived: DerivedValues;
  /** Relative posix paths, sorted. */
  files: string[];
  digest: string;
  source: JigSource;
  /** Warnings from validation. */
  issues: ManifestIssue[];
  /** `dist/steps.mjs` is present (made by `jig:pack`). */
  bundled: boolean;
}

export class JigInvalidError extends DomainError {
  issues: ManifestIssue[];
  constructor(issues: ManifestIssue[]) {
    super('JIG_INVALID');
    this.issues = issues;
  }
}

/** Folder name of an installed version: `/` in the id becomes `~` (ARCH-03 §2.3). */
export const installedFolder = (id: string, version: string) =>
  `${id.replaceAll('/', '~')}@${version}`;
export const installedRoot = (dataDir: string) => join(dataDir, 'jigs', 'installed');

/** Every file of a package as a sorted list of relative posix paths (`.git`, `node_modules` skipped). */
export function listPackageFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Digest of package files: sha256 of `path\0sha256(bytes)\n` joined in path order. */
export function digestEntries(entries: readonly { path: string; bytes: Uint8Array }[]): string {
  const lines = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => `${entry.path}\0${sha256(entry.bytes)}\n`);
  return sha256(lines.join(''));
}
export function digestDir(dir: string, files: readonly string[] = listPackageFiles(dir)): string {
  return digestEntries(files.map((path) => ({ path, bytes: readFileSync(join(dir, path)) })));
}

export interface LibraryInfo {
  version: string;
  functions: string[];
  module: Record<string, unknown>;
}
const LIBRARY_MODULES: Record<string, () => Promise<Record<string, unknown>>> = {
  'vide/geometry-kit': () =>
    import('../official/geometry-kit/index.ts') as Promise<Record<string, unknown>>,
  'vide/structure-analysis': () =>
    import('../official/structure-analysis/index.ts') as Promise<Record<string, unknown>>,
};
let libraries: Promise<Record<string, LibraryInfo>> | undefined;
/** The official libraries (ARCH-03 §2.3), loaded once. */
export function officialLibraries(): Promise<Record<string, LibraryInfo>> {
  libraries ??= (async () => {
    const out: Record<string, LibraryInfo> = {};
    for (const [id, load] of Object.entries(LIBRARY_MODULES)) {
      const module = await load();
      const meta = module.library as { version?: string } | undefined;
      out[id] = {
        version: meta?.version ?? '0.0.0',
        functions: Object.keys(module).filter((key) => typeof module[key] === 'function'),
        module,
      };
    }
    return out;
  })();
  return libraries;
}
/** The function a `library` step or a role extractor names: `vide/<library>#<function>`. */
export async function libraryFunction(use: string): Promise<(...args: unknown[]) => unknown> {
  const [id, name] = use.split('#');
  const library = (await officialLibraries())[id];
  const fn = library?.module[name];
  if (typeof fn !== 'function') throw new DomainError('JIG_LIBRARY_UNKNOWN');
  return fn as (...args: unknown[]) => unknown;
}

export function readManifestFile(dir: string): unknown {
  const file = join(dir, 'jig.json');
  if (!existsSync(file))
    throw new JigInvalidError([
      {
        code: 'JIG_FILE_MISSING',
        path: 'jig.json',
        message: 'jig.json이 없습니다',
        level: 'error',
      },
    ]);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new JigInvalidError([
      { code: 'JIG_SCHEMA', path: 'jig.json', message: 'JSON이 아닙니다', level: 'error' },
    ]);
  }
}

/** Issues of the package's `panel.json` against the part registry and the manifest's names. */
function checkPanelFile(dir: string, manifest: JigManifest): ManifestIssue[] {
  const file = manifest.panel!;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch {
    return [{ code: 'JIG_PANEL', path: file, message: 'JSON이 아닙니다', level: 'error' }];
  }
  return validatePanel(raw, scopeOf(manifest)).issues.map((issue) => ({
    code: 'JIG_PANEL' as const,
    path: `${file}:${issue.path}`,
    message: issue.message,
    level: 'error' as const,
  }));
}

/** Load and validate a package folder; throws `JigInvalidError` with the issues when it fails. */
export async function loadJig(
  dir: string,
  options: { source?: JigSource; expectDigest?: string } = {},
): Promise<LoadedJig> {
  const absolute = resolve(dir);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory())
    throw new DomainError('NOT_FOUND');
  const raw = readManifestFile(absolute);
  const files = listPackageFiles(absolute);
  const libs = await officialLibraries();
  const source = options.source ?? 'dev-source';
  const { manifest, derived, issues } = validateManifest(raw, {
    files,
    source,
    libraries: Object.fromEntries(
      Object.entries(libs).map(([id, info]) => [
        id,
        { version: info.version, functions: info.functions },
      ]),
    ),
  });
  if (!manifest || !derived) throw new JigInvalidError(issues);
  // The panel is data the screen draws (ARCH-03 §5.1): a part outside the official list, an
  // unknown property, a colour value or a binding the jig does not declare refuses registration
  // here, not only on the screen.
  if (manifest.kind === 'tool' && manifest.panel) {
    const panelIssues = checkPanelFile(absolute, manifest);
    if (panelIssues.length) throw new JigInvalidError([...issues, ...panelIssues]);
  }
  const digest = digestDir(absolute, files);
  if (options.expectDigest && options.expectDigest !== digest)
    throw new DomainError('JIG_DIGEST_MISMATCH');
  return {
    dir: absolute,
    id: manifest.id,
    version: manifest.version,
    manifest,
    derived,
    files,
    digest,
    source,
    issues,
    bundled: files.includes('dist/steps.mjs'),
  };
}

export interface RegistryEntry {
  id: string;
  version: string;
  kind: 'tool' | 'library';
  name: string;
  summary: string;
  source: JigSource;
  stage: 'official' | 'project' | 'dev';
  path?: string;
  digest?: string;
  signer?: string | null;
  capabilities: { name: string; reason: string }[];
  /** An installed package whose files no longer match its recorded digest. */
  corrupt?: boolean;
}

const here = fileURLToPath(new URL('.', import.meta.url));
/** `extensions/jigs` of this checkout, when it exists (never in the installed build). */
export function repositoryJigRoot(): string | undefined {
  const root = resolve(here, '..', '..', '..', 'extensions', 'jigs');
  return existsSync(root) ? root : undefined;
}

/** One list of runnable jigs; resolves a jig by id (and version) to its loaded package. */
export class JigRegistry {
  private readonly store: JigStore | undefined;
  private readonly dataDir: string;
  private readonly devRoots: string[];
  private readonly loaded = new Map<string, Promise<LoadedJig>>();
  constructor(options: { store?: JigStore; dataDir: string; devRoots?: string[] }) {
    this.store = options.store;
    this.dataDir = options.dataDir;
    this.devRoots = options.devRoots ?? [];
  }

  /** Repository jig folders that hold a `jig.json`, with the id and version each declares. */
  private devPackages(): { dir: string; id: string; version: string }[] {
    const out: { dir: string; id: string; version: string }[] = [];
    for (const root of this.devRoots) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name);
        try {
          const raw = JSON.parse(readFileSync(join(dir, 'jig.json'), 'utf8')) as {
            id?: unknown;
            version?: unknown;
          };
          if (typeof raw.id === 'string' && typeof raw.version === 'string')
            out.push({ dir, id: raw.id, version: raw.version });
        } catch {
          /* not a jig folder */
        }
      }
    }
    return out;
  }

  async list(): Promise<RegistryEntry[]> {
    const entries: RegistryEntry[] = [];
    for (const [id, info] of Object.entries(await officialLibraries()))
      entries.push({
        id,
        version: info.version,
        kind: 'library',
        name: id.split('/')[1],
        summary: '공식 라이브러리',
        source: 'builtin',
        stage: 'official',
        capabilities: [],
      });
    for (const row of this.store?.packages() ?? []) {
      try {
        const jig = await this.load(row.path, row.source, row.digest, `${row.id}@${row.version}`);
        entries.push({
          ...summary(jig),
          stage: 'project',
          path: row.path,
          digest: row.digest,
          signer: row.signer,
        });
      } catch {
        entries.push({
          id: row.id,
          version: row.version,
          kind: 'tool',
          name: row.id,
          summary: '',
          source: row.source,
          stage: 'project',
          path: row.path,
          digest: row.digest,
          signer: row.signer,
          capabilities: [],
          corrupt: true,
        });
      }
    }
    for (const dev of this.devPackages()) {
      if (entries.some((e) => e.id === dev.id && e.version === dev.version)) continue;
      try {
        const jig = await this.load(dev.dir, 'dev-source', undefined, `dev:${dev.dir}`);
        entries.push({ ...summary(jig), stage: 'dev', path: dev.dir, digest: jig.digest });
      } catch {
        entries.push({
          id: dev.id,
          version: dev.version,
          kind: 'tool',
          name: dev.id,
          summary: '',
          source: 'dev-source',
          stage: 'dev',
          path: dev.dir,
          capabilities: [],
          corrupt: true,
        });
      }
    }
    return entries;
  }

  private load(dir: string, source: JigSource, expectDigest: string | undefined, key: string) {
    let pending = this.loaded.get(key);
    if (!pending) {
      pending = loadJig(dir, { source, expectDigest });
      this.loaded.set(key, pending);
      pending.catch(() => this.loaded.delete(key));
    }
    return pending;
  }
  /** Forget a loaded package (after an install or a source change). */
  forget(id: string, version: string) {
    for (const key of [...this.loaded.keys()])
      if (key.startsWith(`${id}@${version}`) || key.startsWith('dev:')) this.loaded.delete(key);
  }

  /** Installed first, then repository sources; without a version the newest installed one. */
  async resolve(id: string, version?: string): Promise<LoadedJig> {
    const rows = this.store?.packages(id) ?? [];
    const row = version ? rows.find((r) => r.version === version) : rows.at(-1);
    if (row) return this.load(row.path, row.source, row.digest, `${row.id}@${row.version}`);
    const dev = this.devPackages()
      .filter((d) => d.id === id && (!version || d.version === version))
      .at(-1);
    if (dev) return this.load(dev.dir, 'dev-source', undefined, `dev:${dev.dir}`);
    throw new DomainError('NOT_FOUND');
  }
  get installedDir() {
    return installedRoot(this.dataDir);
  }
}
const summary = (jig: LoadedJig): RegistryEntry => ({
  id: jig.id,
  version: jig.version,
  kind: jig.manifest.kind,
  name: jig.manifest.name,
  summary: jig.manifest.summary,
  source: jig.source,
  stage: 'project',
  capabilities: jig.manifest.capabilities.map((c) => ({ name: c.name, reason: c.reason })),
});
