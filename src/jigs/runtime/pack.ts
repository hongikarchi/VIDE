// Validate, self-test, pack, sign and import (ARCH-03 §5.4·§12, SPEC-07.15). The same code
// answers `npm run jig:validate|test|pack` and the make-conversation's `jig_validate`/`jig_test`.
// A pack is gzip JSON `{ format, id, version, files, digest, sig }` signed with this PC's key
// (`<data>/jig-signing.key`, made on first use, never exported). Import recomputes the digest,
// checks the HMAC against this PC's key — a pack without a signature or from another PC is
// refused — rejects forbidden files, validates the manifest, unpacks read-only under
// `<data>/jigs/installed/<id>@<version>/` and records the package (`source: dev-pack`).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DomainError } from '../../contracts/errors.ts';
import type { JigStore } from '../../core/jig-store.ts';
import { ChildRunner, type ChildRunnerOptions } from './child-runner.ts';
import { sha256 } from './hash.ts';
import {
  JigInvalidError,
  digestEntries,
  installedFolder,
  installedRoot,
  loadJig,
  repositoryJigRoot,
  type LoadedJig,
} from './loader.ts';
import { forbiddenFiles, type JigSource, type ManifestIssue } from './manifest.ts';
import { applyChanges, initialParams, type ParamChange } from './params.ts';
import {
  EngineRunner,
  MemoryCache,
  executeSteps,
  type StepReport,
  type StepRunner,
} from './runner.ts';

export interface ValidationReport {
  ok: boolean;
  id?: string;
  version?: string;
  digest?: string;
  issues: ManifestIssue[];
}
/** Validate a package folder without throwing. */
export async function validateJig(
  dir: string,
  options: { source?: JigSource } = {},
): Promise<ValidationReport> {
  try {
    const jig = await loadJig(dir, options);
    return { ok: true, id: jig.id, version: jig.version, digest: jig.digest, issues: jig.issues };
  } catch (error) {
    if (error instanceof JigInvalidError) return { ok: false, issues: error.issues };
    throw error;
  }
}

export interface Mismatch {
  path: string;
  expected: unknown;
  actual: unknown;
}
export const DEFAULT_TOLERANCE = { length: 1e-3, ratio: 1e-3 };
/** Subset comparison with numeric tolerance (length 1 mm or ratio 1e-3, whichever is looser). */
export function compareExpected(
  expected: unknown,
  actual: unknown,
  tolerance = DEFAULT_TOLERANCE,
  path = '$',
  out: Mismatch[] = [],
): Mismatch[] {
  if (out.length > 30) return out;
  if (typeof expected === 'number') {
    const ok =
      typeof actual === 'number' &&
      (Math.abs(actual - expected) <= tolerance.length ||
        Math.abs(actual - expected) <= tolerance.ratio * Math.abs(expected));
    if (!ok) out.push({ path, expected, actual });
  } else if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      out.push({
        path,
        expected: `길이 ${expected.length}`,
        actual: Array.isArray(actual) ? `길이 ${actual.length}` : actual,
      });
    else
      expected.forEach((item, index) =>
        compareExpected(item, actual[index], tolerance, `${path}[${index}]`, out),
      );
  } else if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') out.push({ path, expected, actual });
    else
      for (const [key, value] of Object.entries(expected as Record<string, unknown>))
        compareExpected(
          value,
          (actual as Record<string, unknown>)[key],
          tolerance,
          `${path}.${key}`,
          out,
        );
  } else if (expected !== actual) out.push({ path, expected, actual });
  return out;
}

export interface SelftestCase {
  name: string;
  ok: boolean;
  steps: StepReport[];
  mismatches: Mismatch[];
  error?: string;
}
export interface SelftestReport {
  ok: boolean;
  id: string;
  version: string;
  cases: SelftestCase[];
}
export interface SelftestOptions {
  /** Which runner: the child process (default for repository and packed jigs) or the engine. */
  runner?: 'engine' | 'child';
  child?: ChildRunnerOptions;
  source?: JigSource;
}
const readJson = (file: string) =>
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : undefined;

/** Run every fixture case with the step runner and no host (`selftest.requiresHost: false`). */
export async function selftestJig(
  target: string | LoadedJig,
  options: SelftestOptions = {},
): Promise<SelftestReport> {
  const jig =
    typeof target === 'string' ? await loadJig(target, { source: options.source }) : target;
  const root = join(jig.dir, jig.manifest.selftest.fixtures);
  const cases: SelftestCase[] = [];
  const kind = options.runner ?? (jig.source === 'builtin' ? 'engine' : 'child');
  const runner: StepRunner =
    kind === 'engine'
      ? new EngineRunner()
      : new ChildRunner(jig.source, { ...devReadPaths(jig), ...options.child });
  try {
    const names = existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
      : [];
    for (const name of names) {
      const folder = join(root, name);
      const inputs = (readJson(join(folder, 'input.json')) ?? {}) as Record<string, unknown>;
      const paramsFile = (readJson(join(folder, 'params.json')) ?? {}) as Record<string, unknown>;
      const expect = (readJson(join(folder, 'expect.json')) ?? {}) as {
        steps?: Record<string, unknown>;
        statuses?: Record<string, string>;
        tolerance?: { length?: number; ratio?: number };
      };
      try {
        const changes: ParamChange[] = Object.entries(paramsFile).map(([key, value]) => ({
          key,
          value: value as ParamChange['value'],
        }));
        const { next: params } = applyChanges(jig.manifest, initialParams(jig.manifest), changes, {
          by: 'user',
          atPin: true,
        });
        const report = await executeSteps({
          jig,
          runner,
          cache: new MemoryCache(),
          mode: 'selftest',
          inputs,
          params,
        });
        const tolerance = { ...DEFAULT_TOLERANCE, ...(expect.tolerance ?? {}) };
        const mismatches: Mismatch[] = [];
        for (const [stepId, expected] of Object.entries(expect.steps ?? {})) {
          const step = report.steps.find((s) => s.id === stepId);
          if (!step || (step.status !== 'done' && step.status !== 'confirmed'))
            mismatches.push({
              path: `steps.${stepId}.status`,
              expected: 'done',
              actual: step?.status ?? 'missing',
            });
          else
            compareExpected(
              expected,
              report.outputs[stepId],
              tolerance,
              `steps.${stepId}`,
              mismatches,
            );
        }
        for (const [stepId, status] of Object.entries(expect.statuses ?? {})) {
          const step = report.steps.find((s) => s.id === stepId);
          if (step?.status !== status)
            mismatches.push({
              path: `statuses.${stepId}`,
              expected: status,
              actual: step?.status ?? 'missing',
            });
        }
        // A step that fails is an error unless the case expects that exact status for it.
        const failed = report.steps.filter(
          (s) =>
            (s.status === 'failed' || s.status === 'gate-failed') &&
            expect.statuses?.[s.id] === undefined,
        );
        const error = failed.length
          ? failed
              .map(
                (s) =>
                  `${s.id}: ${s.error?.code ?? 'gate'} ${
                    s.error?.message ??
                    s.gates
                      .filter((g) => !g.ok)
                      .map((g) => g.message)
                      .join('; ')
                  }`,
              )
              .join('\n')
          : undefined;
        cases.push({
          name,
          ok: !mismatches.length && !error,
          steps: report.steps,
          mismatches,
          ...(error ? { error } : {}),
        });
      } catch (error) {
        cases.push({
          name,
          ok: false,
          steps: [],
          mismatches: [],
          error: String((error as Error)?.message ?? error),
        });
      }
    }
  } finally {
    await runner.close();
  }
  return {
    ok: cases.length > 0 && cases.every((c) => c.ok),
    id: jig.id,
    version: jig.version,
    cases,
  };
}

/**
 * A repository jig that is not bundled imports `src/jigs/official` and `node_modules`; allow them.
 * The official structure library reuses `src/jigs/structure` (sections, loads, core path) and the
 * ARCH-02 contracts (ARCH-03 §2), so those source folders are readable too — reading only. The
 * structure core's folder holds the Node-API addon (`vide_structure.node` in the desktop package,
 * `target/release/vide_structure.dll` in a checkout).
 */
export function devReadPaths(jig: LoadedJig): Pick<ChildRunnerOptions, 'extraReadPaths'> {
  if (jig.bundled || jig.source !== 'dev-source') return {};
  const root = repositoryJigRoot();
  if (!root) return {};
  const repo = resolve(root, '..', '..');
  const paths = [
    join(repo, 'src', 'jigs', 'official'),
    join(repo, 'src', 'jigs', 'structure'),
    join(repo, 'src', 'contracts'),
    join(repo, 'src', 'native', 'structure'),
    join(repo, 'node_modules'),
  ];
  return { extraReadPaths: withRealPaths(paths) };
}

/**
 * Each path and its real path, without duplicates. Imports resolve to real paths: a junctioned
 * `node_modules` (a worktree sharing the main checkout's) is read at its target, so the target
 * must be allowed too. A path that does not exist is kept as is.
 */
export function withRealPaths(paths: readonly string[]): string[] {
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  };
  return [...new Set(paths.flatMap((p) => [p, real(p)]))];
}

// --- signing ---------------------------------------------------------------------------------

export const KEY_FILE = 'jig-signing.key';
/** This PC's 32-byte signing key, made on first use (ARCH-03 §12). */
export function signingKey(dataDir: string): Buffer {
  const file = join(dataDir, KEY_FILE);
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(text)) return Buffer.from(text, 'hex');
  }
  const key = randomBytes(32);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}
export const keyIdOf = (key: Buffer) => sha256(key).slice(0, 16);
export interface PackSignature {
  alg: 'HMAC-SHA256';
  keyId: string;
  mac: string;
}
const macOf = (key: Buffer, id: string, version: string, digest: string) =>
  createHmac('sha256', key).update(`${id}@${version}\n${digest}`).digest('hex');
export function signDigest(
  key: Buffer,
  id: string,
  version: string,
  digest: string,
): PackSignature {
  return { alg: 'HMAC-SHA256', keyId: keyIdOf(key), mac: macOf(key, id, version, digest) };
}
/** True when the signature was made with this key for this content. */
export function signatureValid(
  key: Buffer,
  sig: PackSignature | undefined,
  id: string,
  version: string,
  digest: string,
) {
  if (
    !sig ||
    sig.alg !== 'HMAC-SHA256' ||
    sig.keyId !== keyIdOf(key) ||
    !/^[a-f0-9]{64}$/.test(sig.mac)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(sig.mac, 'hex'),
    Buffer.from(macOf(key, id, version, digest), 'hex'),
  );
}

// --- pack ------------------------------------------------------------------------------------

export const PACK_FORMAT = 'vide.jig.pack/1';
export interface VjigPack {
  format: typeof PACK_FORMAT;
  id: string;
  version: string;
  /** Path → base64 bytes. */
  files: Record<string, string>;
  digest: string;
  sig?: PackSignature;
}
export const encodePack = (pack: VjigPack) => gzipSync(Buffer.from(JSON.stringify(pack), 'utf8'));
export function decodePack(bytes: Uint8Array): VjigPack {
  let pack: VjigPack;
  try {
    pack = JSON.parse(gunzipSync(bytes).toString('utf8')) as VjigPack;
  } catch {
    throw new DomainError('JIG_INVALID');
  }
  if (
    !pack ||
    pack.format !== PACK_FORMAT ||
    typeof pack.id !== 'string' ||
    typeof pack.version !== 'string' ||
    !pack.files ||
    typeof pack.files !== 'object' ||
    typeof pack.digest !== 'string'
  )
    throw new DomainError('JIG_INVALID');
  return pack;
}
export const packEntries = (pack: VjigPack) =>
  Object.entries(pack.files).map(([path, data]) => ({ path, bytes: Buffer.from(data, 'base64') }));
export const packFileName = (id: string, version: string) => `${installedFolder(id, version)}.vjig`;

/** Bundle the code steps with Vite into one `dist/steps.mjs` (source files stay in the pack too). */
export async function bundleSteps(jig: LoadedJig): Promise<Buffer> {
  const entries = [
    ...new Set(jig.manifest.steps.flatMap((s) => (s.kind === 'code' ? [s.entry] : []))),
  ];
  const scratch = mkdtempSync(join(tmpdir(), 'vide-jig-pack-'));
  try {
    const lines = entries.map((entry, index) => {
      const [file, name] = entry.split('#');
      return `import { ${name} as s${index} } from ${JSON.stringify(join(jig.dir, file).replaceAll('\\', '/'))};`;
    });
    lines.push(
      `export const steps = { ${entries.map((entry, index) => `${JSON.stringify(entry)}: s${index}`).join(', ')} };`,
    );
    const entryFile = join(scratch, 'entry.ts');
    writeFileSync(entryFile, lines.join('\n') + '\n');
    const { build } = (await import('vite')) as typeof import('vite');
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        lib: { entry: entryFile, formats: ['es'] },
        write: false,
        minify: false,
        ssr: true,
        rollupOptions: { external: [/^node:/], output: { entryFileNames: 'steps.mjs' } },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    for (const bundle of outputs) {
      if (!bundle || !('output' in bundle)) continue;
      const chunk = bundle.output.find((o) => o.type === 'chunk' && o.isEntry);
      if (chunk && chunk.type === 'chunk') return Buffer.from(chunk.code, 'utf8');
    }
    throw new DomainError('JIG_PACK_FAILED');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface PackOptions {
  dataDir: string;
  outDir?: string;
  /** Bundle the TS steps with Vite (default true); off for self-contained packages in tests. */
  bundle?: boolean;
  /** Skip the self-test (validation still runs). */
  skipTests?: boolean;
  selftest?: SelftestOptions;
  /** How to load the folder (default `dev-source`); an AI draft or an installed copy keeps its own. */
  source?: JigSource;
}
export interface PackResult {
  file?: string;
  bytes: Buffer;
  pack: VjigPack;
  selftest?: SelftestReport;
  jig: LoadedJig;
}
/** Validate, self-test, (bundle,) digest and sign a package folder. */
export async function packJig(dir: string, options: PackOptions): Promise<PackResult> {
  const jig = await loadJig(dir, { source: options.source ?? 'dev-source' });
  let selftest: SelftestReport | undefined;
  if (!options.skipTests) {
    selftest = await selftestJig(jig, options.selftest);
    if (!selftest.ok) throw new DomainError('JIG_SELFTEST_FAILED');
  }
  const entries: { path: string; bytes: Uint8Array }[] = jig.files
    .filter((path) => !path.startsWith('dist/'))
    .map((path) => ({ path, bytes: readFileSync(join(jig.dir, path)) }));
  if (options.bundle ?? true)
    entries.push({ path: 'dist/steps.mjs', bytes: await bundleSteps(jig) });
  const digest = digestEntries(entries);
  const key = signingKey(options.dataDir);
  const pack: VjigPack = {
    format: PACK_FORMAT,
    id: jig.id,
    version: jig.version,
    files: Object.fromEntries(
      entries.map((e) => [e.path, Buffer.from(e.bytes).toString('base64')]),
    ),
    digest,
    sig: signDigest(key, jig.id, jig.version, digest),
  };
  const bytes = encodePack(pack);
  let file: string | undefined;
  if (options.outDir) {
    mkdirSync(options.outDir, { recursive: true });
    file = join(options.outDir, packFileName(jig.id, jig.version));
    writeFileSync(file, bytes);
  }
  return { file, bytes, pack, selftest, jig };
}

// --- import ----------------------------------------------------------------------------------

export interface ImportOptions {
  store: JigStore;
  dataDir: string;
  /** Capabilities the user approved on the confirmation card (default: all declared). */
  approvedCaps?: string[];
  /** Called after a successful install (the registry forgets its cache). */
  onInstalled?: (id: string, version: string) => void;
}
export interface ImportResult {
  id: string;
  version: string;
  digest: string;
  capabilities: { name: string; reason: string }[];
  path: string;
  /** False when this exact package was already installed. */
  installed: boolean;
}
/** Verify and install a `.vjig` (see the module comment). Nothing is installed when it fails. */
export async function importPack(bytes: Uint8Array, options: ImportOptions): Promise<ImportResult> {
  const pack = decodePack(bytes);
  const entries = packEntries(pack);
  for (const entry of entries)
    if (
      !/^(?!\.\.?(\/|$))(?!\/)(?![A-Za-z]:)[^\\]+$/.test(entry.path) ||
      entry.path.split('/').includes('..')
    )
      throw new DomainError('JIG_INVALID');
  const digest = digestEntries(entries);
  if (digest !== pack.digest) throw new DomainError('JIG_SIGNATURE');
  const key = signingKey(options.dataDir);
  if (!signatureValid(key, pack.sig, pack.id, pack.version, digest))
    throw new DomainError('JIG_SIGNATURE');
  const forbidden = forbiddenFiles(entries.map((e) => e.path));
  if (forbidden.length)
    throw new JigInvalidError(
      forbidden.map((file) => ({
        code: 'JIG_FORBIDDEN_FILE',
        path: 'files',
        message: `금지 파일: ${file}`,
        level: 'error',
      })),
    );

  // Already installed: the same content is fine, different content is refused.
  let existing;
  try {
    existing = options.store.package(pack.id, pack.version);
  } catch {
    existing = undefined;
  }
  if (existing) {
    if (existing.digest !== digest) throw new DomainError('JIG_VERSION_EXISTS');
    const jig = await loadJig(existing.path, { source: existing.source, expectDigest: digest });
    return {
      id: jig.id,
      version: jig.version,
      digest,
      capabilities: jig.manifest.capabilities.map((c) => ({ name: c.name, reason: c.reason })),
      path: existing.path,
      installed: false,
    };
  }

  const root = installedRoot(options.dataDir);
  mkdirSync(root, { recursive: true });
  const temp = mkdtempSync(join(root, '.unpack-'));
  try {
    for (const entry of entries) {
      const target = join(temp, ...entry.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.bytes);
    }
    const jig = await loadJig(temp, { source: 'dev-pack', expectDigest: digest });
    if (jig.id !== pack.id || jig.version !== pack.version) throw new DomainError('JIG_INVALID');
    const final = join(root, installedFolder(jig.id, jig.version));
    if (existsSync(final)) rmSync(final, { recursive: true, force: true });
    renameSync(temp, final);
    for (const file of jig.files) {
      try {
        chmodSync(join(final, ...file.split('/')), 0o444);
      } catch {
        /* read-only is a courtesy on some file systems */
      }
    }
    const declared = jig.manifest.capabilities.map((c) => c.name);
    options.store.addPackage({
      id: jig.id,
      version: jig.version,
      stage: 'project',
      source: 'dev-pack',
      digest,
      signer: pack.sig?.keyId ?? null,
      path: final,
      approvedCaps: (options.approvedCaps ?? declared).filter((name) =>
        declared.includes(name as (typeof declared)[number]),
      ),
    });
    options.onInstalled?.(jig.id, jig.version);
    return {
      id: jig.id,
      version: jig.version,
      digest,
      capabilities: jig.manifest.capabilities.map((c) => ({ name: c.name, reason: c.reason })),
      path: final,
      installed: true,
    };
  } finally {
    if (existsSync(temp) && statSync(temp).isDirectory())
      rmSync(temp, { recursive: true, force: true });
  }
}
