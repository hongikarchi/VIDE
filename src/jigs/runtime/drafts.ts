// Jig drafts of the make-conversation (PLAN-22 T-063, SPEC-07.9, ARCH-03 §2.3·§6.5·§7·§12). A
// draft is a folder `<data>/jigs/drafts/<draftId>/` (jig.json, panel.json, steps/*.ts, fixtures/,
// skill.md) that the conversation's file tools write; a development engine whose data folder is
// inside a repository keeps its drafts outside it (ARCH-03 §2.3, provisional). Every check here
// first scans the folder for forbidden files (agent instruction and settings files, package
// manifests, module folders, symbolic links, paths outside the folder) — `draftPathRefusal` is the
// same rule the CLI turn applies to each file tool call. Tests and previews run the AI-written
// steps only in the compute box. Pinning re-checks validation and the self-test, installs a
// read-only copy under `<data>/jigs/installed/<id>@<version>/` with the engine's digest
// (`source: ai-draft`, no signature: ARCH-03 §12) and pins it to the project. The last validate,
// test and preview results are kept beside the drafts (`.results/<draftId>.json`), never inside
// the folder the AI writes.

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Store } from '../../core/store.ts';
import { DomainError } from '../../contracts/errors.ts';
import { JigStore, type JigDraft } from '../../core/jig-store.ts';
import { draftPathRefusal } from '../../ai/agent-connection.ts';
import {
  ComputeBoxRunner,
  boxSource,
  outsideBoxImports,
  type ComputeBoxOptions,
} from './compute-box.ts';
import { sha256 } from './hash.ts';
import {
  JigInvalidError,
  digestEntries,
  installedFolder,
  installedRoot,
  listPackageFiles,
  loadJig,
  readManifestFile,
  type LoadedJig,
} from './loader.ts';
import { JIG_ID, SEMVER, type ManifestIssue } from './manifest.ts';
import { isJigIcon } from '../../contracts/jig-icons.ts';
import { isNewerVersion, versionParts } from '../../contracts/jig-version.ts';
import {
  DEFAULT_TOLERANCE,
  compareExpected,
  validateJig,
  type Mismatch,
  type SelftestReport,
  type ValidationReport,
} from './pack.ts';
import { applyChanges, initialParams, type ParamChange } from './params.ts';
import { MemoryCache, executeSteps, type StepReport } from './runner.ts';

export const DRAFT_TEMPLATES = ['example-grid', 'blank'] as const;
export type DraftTemplate = (typeof DRAFT_TEMPLATES)[number];
/** A draft folder stays small: files, bytes and one file's bytes. */
export const DRAFT_LIMITS = { files: 400, bytes: 20 * 1024 * 1024, fileBytes: 4 * 1024 * 1024 };
/** Fixture cases the self-test runs at most. */
const MAX_CASES = 20;
/** Step outputs a preview returns at most (bytes of JSON); larger ones come as an outline. */
const PREVIEW_OUTPUT_BYTES = 512 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const exampleGrid = () => resolve(here, '..', '..', '..', 'extensions', 'jigs', 'example-grid');

/**
 * Where drafts live: `<data>/jigs/drafts`, or outside the repository when the engine's data
 * folder is inside this checkout (a development engine's `.vide/dev-data`).
 */
export function draftsRoot(dataDir: string): string {
  const data = resolve(dataDir);
  const repository = resolve(here, '..', '..', '..');
  if (existsSync(join(repository, '.git')) && data.startsWith(repository + sep))
    return join(tmpdir(), 'vide-jig-drafts', sha256(data).slice(0, 16));
  return join(data, 'jigs', 'drafts');
}

const issue = (path: string, message: string): ManifestIssue => ({
  code: 'JIG_FORBIDDEN_FILE',
  path,
  message,
  level: 'error',
});
/**
 * The forbidden-file scan of a draft folder: every entry, including module and dot folders that
 * package listings skip. A symbolic link or junction is refused (it could point anywhere).
 */
export function scanDraft(dir: string): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const root = resolve(dir);
  let files = 0,
    bytes = 0;
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        issues.push(issue(rel, `심볼릭 링크는 둘 수 없습니다: ${rel}`));
        continue;
      }
      const refusal = draftPathRefusal(root, full);
      if (refusal) {
        issues.push(issue(rel, `금지 파일: ${rel}`));
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) {
        files++;
        bytes += stat.size;
        if (stat.size > DRAFT_LIMITS.fileBytes)
          issues.push(issue(rel, `파일이 너무 큽니다: ${rel}`));
      } else issues.push(issue(rel, `일반 파일이 아닙니다: ${rel}`));
    }
  };
  walk(root);
  if (files > DRAFT_LIMITS.files) issues.push(issue('.', `파일이 너무 많습니다(${files}개)`));
  if (bytes > DRAFT_LIMITS.bytes) issues.push(issue('.', '초안 폴더가 너무 큽니다'));
  return issues;
}

/** A blank starting draft: one code step, one setting, one fixture. */
function blankFiles(name: string, id: string): Record<string, string> {
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  return {
    'jig.json': json({
      contractVersion: 3,
      id,
      version: '0.1.0',
      kind: 'tool',
      name,
      summary: '만들기 대화에서 시작한 빈 jig 초안',
      inputs: [],
      params: [
        {
          key: 'count',
          title: '개수',
          group: '기본',
          type: 'count',
          unit: 'EA',
          default: 3,
          range: { min: 1, max: 100, step: 1 },
          affects: ['main'],
        },
      ],
      steps: [
        {
          id: 'main',
          title: '계산',
          kind: 'code',
          entry: 'steps/main.ts#main',
          reads: ['param.count'],
          writes: 'main',
          speed: 'live',
          gates: [{ use: 'no-nan' }],
        },
      ],
      capabilities: [],
      panel: 'panel.json',
      selftest: { fixtures: 'fixtures', requiresHost: false },
      skill: 'skill.md',
    }),
    'panel.json': json({
      layout: 'jig-run',
      left: [{ part: 'step-rail' }, { part: 'param-group' }],
      center: {
        views: [],
        kpis: { part: 'kpi-strip', items: [{ label: '합계', from: 'step.main.total' }] },
      },
      drawer: {
        part: 'result-tabs',
        tabs: [
          {
            title: '항목',
            part: 'table',
            from: 'step.main.items',
            columns: [
              { field: 'key', label: '키' },
              { field: 'value', label: '값' },
            ],
          },
        ],
      },
    }),
    'steps/main.ts': `// 계산 단계: (inputs, params, overrides) => output. 파일·네트워크 없이 계산 상자에서 돈다.
export interface MainParams {
  count: number;
}
export function main(_inputs: unknown, params: MainParams) {
  const items = Array.from({ length: params.count }, (_, i) => ({ key: \`item:\${i + 1}\`, value: i + 1 }));
  return { items, total: items.reduce((sum, item) => sum + item.value, 0) };
}
`,
    'fixtures/basic/input.json': '{}\n',
    'fixtures/basic/params.json': json({ count: 3 }),
    'fixtures/basic/expect.json': json({ steps: { main: { total: 6 } } }),
    'skill.md': `---\nname: ${name}\nwords: []\nnot_for: []\ntools: []\nlimits: []\n---\n\n# ${name}\n\n만들기 대화에서 채운다.\n`,
  };
}

export interface DraftResults {
  /** The installed jig a [수정하기] draft copies (PLAN-26 T-101); kept outside the draft folder. */
  origin?: DraftOrigin;
  validate?: ValidationReport & { at: string };
  test?: SelftestReport & { at: string };
  preview?: DraftPreview & { at: string };
}
export interface DraftOrigin {
  jigId: string;
  version: string;
  name: string;
  at: string;
}
export interface DraftPreview {
  ok: boolean;
  fixture: string | null;
  panel: unknown;
  steps: Pick<StepReport, 'id' | 'kind' | 'status' | 'ms' | 'error'>[];
  outputs: Record<string, unknown>;
}
/** A draft as the make tab reads it: the row, `jig.json` as written, files and last results. */
export interface DraftView extends JigDraft, DraftResults {
  name: string;
  version: string | null;
  /** `jig.json` as written (it may not validate yet); null when it is missing or not JSON. */
  manifest: Record<string, unknown> | null;
  files: { path: string; size: number; updatedAt: string }[];
  /** `skill.md` of the draft (the AI 설명서), when present. */
  skill: string | null;
}
export interface PinResult {
  id: string;
  version: string;
  digest: string;
  path: string;
  /** False when this exact package was already installed. */
  installed: boolean;
  pinned: { jigId: string; version: string; pinnedAt: string };
  capabilities: { name: string; reason: string }[];
}
export interface DraftOptions {
  /** One DB, or a Store (drafts live in their project's DB). */
  db: DatabaseSync | Store;
  dataDir: string;
  /** Test seam: the drafts folder (default: `draftsRoot(dataDir)`). */
  root?: string;
  box?: ComputeBoxOptions;
  /** Called after a pinned package is installed (the registry forgets its cache). */
  onInstalled?: (id: string, version: string) => void;
}

/** The patch after the highest of the versions given (`0.3.1`, `0.3.2` → `0.3.3`). */
export function nextPatch(versions: readonly string[]): string {
  const top = versions
    .filter((v) => SEMVER.test(v))
    .reduce((a, b) => (isNewerVersion(b, a) ? b : a), '0.0.0');
  const [major, minor, patch] = versionParts(top);
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Whether [수정하기] can copy the package in `dir` (SPEC-07.3, PLAN-26 T-101): the copy runs in the
 * compute box, so every import of its step sources must reach a file of the package or an official
 * library. A jig written in this checkout against the repository's modules (S-06) is not copied.
 */
export function forkable(dir: string): boolean {
  return outsideBoxImports(dir, listPackageFiles(dir)).length === 0;
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export class JigDrafts {
  readonly store: JigStore;
  readonly root: string;
  private readonly source: DatabaseSync | Store;
  private readonly dataDir: string;
  private readonly options: DraftOptions;
  constructor(options: DraftOptions) {
    this.options = options;
    this.source = options.db;
    this.store = new JigStore(options.db);
    this.dataDir = options.dataDir;
    this.root = resolve(options.root ?? draftsRoot(options.dataDir));
  }
  private of(projectId: string) {
    return this.source instanceof DatabaseSync ? this.source : this.source.db(projectId);
  }

  private resultsFile(draftId: string) {
    return join(this.root, '.results', `${draftId}.json`);
  }
  private results(draftId: string): DraftResults {
    try {
      return JSON.parse(readFileSync(this.resultsFile(draftId), 'utf8')) as DraftResults;
    } catch {
      return {};
    }
  }
  private keep<K extends keyof DraftResults>(draftId: string, key: K, value: DraftResults[K]) {
    const file = this.resultsFile(draftId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...this.results(draftId), [key]: value }));
  }

  list(projectId: string): DraftView[] {
    return this.store
      .drafts(projectId)
      .filter((draft) => draft.state !== 'discarded')
      .map((draft) => this.view(draft));
  }
  get(projectId: string, draftId: string): DraftView {
    return this.view(this.store.draft(projectId, draftId));
  }
  private view(draft: JigDraft): DraftView {
    let manifest: DraftView['manifest'] = null,
      skill: string | null = null;
    const files: DraftView['files'] = [];
    if (draft.state !== 'discarded' && existsSync(draft.path)) {
      try {
        const raw = readManifestFile(draft.path);
        manifest = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
      } catch {
        manifest = null;
      }
      for (const path of listPackageFiles(draft.path)) {
        const stat = lstatSync(join(draft.path, path));
        files.push({ path, size: stat.size, updatedAt: stat.mtime.toISOString() });
        if (path === 'skill.md' && stat.size <= 64 * 1024)
          skill = readFileSync(join(draft.path, path), 'utf8');
      }
    }
    // The open make-conversation of the draft, if any (the row's own column is not kept).
    const conversation = this.of(draft.projectId)
      .prepare(
        "SELECT id FROM conversations WHERE projectId=? AND draftId=? AND state='open' ORDER BY createdAt DESC LIMIT 1",
      )
      .get(draft.projectId, draft.id) as { id: string } | undefined;
    return {
      ...draft,
      conversationId: draft.conversationId ?? conversation?.id ?? null,
      name: typeof manifest?.name === 'string' ? manifest.name : '',
      version: typeof manifest?.version === 'string' ? manifest.version : null,
      manifest,
      files,
      skill,
      ...this.results(draft.id),
    };
  }
  /** The folder of an open (or pinned) draft; a discarded one is gone. */
  dir(projectId: string, draftId: string): string {
    const draft = this.store.draft(projectId, draftId);
    if (draft.state === 'discarded' || !existsSync(draft.path)) throw new DomainError('NOT_FOUND');
    return draft.path;
  }
  private open(projectId: string, draftId: string) {
    const draft = this.store.draft(projectId, draftId);
    if (draft.state !== 'open') throw new DomainError('DRAFT_NOT_OPEN');
    if (!existsSync(draft.path)) throw new DomainError('NOT_FOUND');
    return draft;
  }

  /** A new draft from a starting example (the general grid example or a blank one). */
  create(
    projectId: string,
    { name, from = 'example-grid' }: { name: string; from?: DraftTemplate },
  ): DraftView {
    const title = name.trim();
    if (!title || title.length > 100 || !DRAFT_TEMPLATES.includes(from))
      throw new DomainError('INVALID_INPUT');
    const draftId = randomUUID();
    const dir = join(this.root, draftId);
    const id = `project/${slug(title) || 'draft-' + draftId.slice(0, 8)}`;
    mkdirSync(this.root, { recursive: true });
    try {
      if (from === 'example-grid') {
        const source = exampleGrid();
        if (!existsSync(join(source, 'jig.json'))) throw new DomainError('DRAFT_TEMPLATE_MISSING');
        cpSync(source, dir, { recursive: true, dereference: false, errorOnExist: true });
        const raw = readManifestFile(dir) as Record<string, unknown>;
        writeFileSync(
          join(dir, 'jig.json'),
          JSON.stringify({ ...raw, id, version: '0.1.0', name: title }, null, 2) + '\n',
        );
      } else {
        mkdirSync(dir, { recursive: true });
        for (const [path, text] of Object.entries(blankFiles(title, id)))
          this.writeIn(dir, path, text);
      }
      const at = new Date().toISOString();
      this.of(projectId)
        .prepare("INSERT INTO jig_drafts VALUES(?,?,?,?,'open',?,?)")
        .run(draftId, projectId, null, dir, at, at);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return this.get(projectId, draftId);
  }

  /**
   * [수정하기] (SPEC-07.3, PLAN-26 T-101): a new draft that copies an installed or checkout jig. An
   * installed version never changes; the copy keeps the jig's id and gets the next free patch
   * version — after every installed version of that id, every open draft of it and the source —
   * so pinning it later re-pins the same jig at a new version. The files are copied one by one
   * under the draft path rule (writable, unlike the read-only install); the `dist/` bundle is left
   * out because the steps are edited as sources. Where the copy came from is kept beside the
   * drafts, never in the folder the AI writes. A package whose steps import outside it (a checkout
   * jig such as S-06) is refused with JIG_NOT_FORKABLE: its copy could never pass the self-test.
   */
  fork(
    projectId: string,
    source: { dir: string; id: string; version: string; name: string },
  ): DraftView {
    if (!JIG_ID.test(source.id) || !source.id.startsWith('project/'))
      throw new DomainError('INVALID_INPUT');
    if (!forkable(source.dir)) throw new DomainError('JIG_NOT_FORKABLE');
    const others = this.store
      .drafts(projectId, 'open')
      .map((draft) => this.view(draft).manifest)
      .filter((manifest) => manifest?.id === source.id)
      .map((manifest) => String(manifest?.version ?? ''));
    const version = nextPatch([
      source.version,
      ...this.store.packages(source.id).map((row) => row.version),
      ...others,
    ]);
    const draftId = randomUUID();
    const dir = join(this.root, draftId);
    mkdirSync(this.root, { recursive: true });
    try {
      mkdirSync(dir, { recursive: true });
      for (const path of listPackageFiles(source.dir)) {
        if (path.startsWith('dist/')) continue;
        this.writeIn(dir, path, readFileSync(join(source.dir, ...path.split('/'))));
      }
      // Derived values depend on where a jig runs; the copy runs as an AI draft and the core
      // recomputes them, so a declaration made for the source is dropped.
      const { derived: _derived, ...raw } = readManifestFile(dir) as Record<string, unknown>;
      writeFileSync(
        join(dir, 'jig.json'),
        JSON.stringify({ ...raw, id: source.id, version }, null, 2) + '\n',
      );
      const at = new Date().toISOString();
      this.of(projectId)
        .prepare("INSERT INTO jig_drafts VALUES(?,?,?,?,'open',?,?)")
        .run(draftId, projectId, null, dir, at, at);
      this.keep(draftId, 'origin', {
        jigId: source.id,
        version: source.version,
        name: source.name,
        at,
      });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return this.get(projectId, draftId);
  }

  /** The checked target of a draft path: allowed by the path rule and reached through no link. */
  private target(dir: string, path: string) {
    const refusal = draftPathRefusal(dir, path);
    if (refusal) throw new DomainError(refusal);
    const target = resolve(dir, path);
    // No write through a link: every existing folder on the way is a plain folder of the draft.
    for (let folder = dirname(target); folder.startsWith(resolve(dir)); folder = dirname(folder)) {
      if (existsSync(folder) && lstatSync(folder).isSymbolicLink())
        throw new DomainError('DRAFT_FORBIDDEN_FILE');
      if (folder === resolve(dir)) break;
    }
    if (existsSync(target) && lstatSync(target).isSymbolicLink())
      throw new DomainError('DRAFT_FORBIDDEN_FILE');
    return target;
  }
  private writeIn(dir: string, path: string, content: string | Uint8Array) {
    const target = this.target(dir, path);
    const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
    if (bytes > DRAFT_LIMITS.fileBytes) throw new DomainError('INPUT_TOO_LARGE');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  /**
   * Sets the icon of an open draft (`jig.json` `icon`, one of the fixed list; PLAN-26 T-100). The
   * rest of `jig.json` stays as written; the pin carries the icon into the installed version.
   */
  setIcon(projectId: string, draftId: string, icon: string): DraftView {
    if (!isJigIcon(icon)) throw new DomainError('INVALID_INPUT');
    const dir = this.open(projectId, draftId).path;
    let raw: unknown;
    try {
      raw = readManifestFile(dir);
    } catch {
      raw = undefined;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new DomainError('DRAFT_PATH_INVALID');
    const { icon: _old, ...rest } = raw as Record<string, unknown>;
    // The icon sits after the summary, where the template and the docs put it.
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      next[key] = value;
      if (key === 'summary') next.icon = icon;
    }
    if (!('icon' in next)) next.icon = icon;
    this.writeIn(dir, 'jig.json', JSON.stringify(next, null, 2) + '\n');
    return this.get(projectId, draftId);
  }
  /** Writes one file of an open draft; a forbidden or outside path is refused. */
  writeFile(projectId: string, draftId: string, path: string, content: string | Uint8Array) {
    this.writeIn(this.open(projectId, draftId).path, path, content);
  }
  /**
   * Deletes one file of an open draft (the make tool `jig_delete_file`): the same path rule as a
   * write, only a plain file, never `jig.json`; folders left empty on the way up are removed.
   */
  deleteFile(projectId: string, draftId: string, path: string): { path: string; deleted: true } {
    const dir = resolve(this.open(projectId, draftId).path);
    const target = this.target(dir, path);
    const rel = relative(dir, target).split(sep).join('/');
    if (rel.toLowerCase() === 'jig.json') throw new DomainError('DRAFT_PATH_INVALID');
    if (!existsSync(target)) throw new DomainError('NOT_FOUND');
    if (!lstatSync(target).isFile()) throw new DomainError('DRAFT_PATH_INVALID');
    rmSync(target);
    for (let folder = dirname(target); folder.startsWith(dir + sep); folder = dirname(folder)) {
      if (readdirSync(folder).length) break;
      rmdirSync(folder);
    }
    return { path: rel, deleted: true };
  }

  /** Forbidden files, then the manifest, files and panel as an `ai-draft` package. */
  async validate(projectId: string, draftId: string): Promise<ValidationReport> {
    const dir = this.dir(projectId, draftId);
    const report = await validateDraftDir(dir);
    this.keep(draftId, 'validate', { ...report, at: new Date().toISOString() });
    return report;
  }
  /** The fixture cases, every code step in the compute box. */
  async test(
    projectId: string,
    draftId: string,
  ): Promise<SelftestReport & { issues?: ManifestIssue[] }> {
    const dir = this.dir(projectId, draftId);
    const validation = await validateDraftDir(dir);
    const report = validation.ok
      ? await selftestInBox(await loadJig(dir, { source: 'ai-draft' }), this.options.box)
      : {
          ok: false,
          id: validation.id ?? '',
          version: validation.version ?? '',
          cases: [],
          issues: validation.issues,
        };
    this.keep(draftId, 'test', { ...report, at: new Date().toISOString() });
    return report;
  }
  /** The panel and the step outputs of one fixture case, computed in the compute box. */
  async preview(
    projectId: string,
    draftId: string,
    { fixture }: { fixture?: string } = {},
  ): Promise<DraftPreview & { issues?: ManifestIssue[] }> {
    const dir = this.dir(projectId, draftId);
    const validation = await validateDraftDir(dir);
    if (!validation.ok) {
      const failed = {
        ok: false,
        fixture: null,
        panel: null,
        steps: [],
        outputs: {},
        issues: validation.issues,
      };
      this.keep(draftId, 'preview', { ...failed, at: new Date().toISOString() });
      return failed;
    }
    const jig = await loadJig(dir, { source: 'ai-draft' });
    const cases = fixtureNames(jig);
    const name = fixture ?? cases[0] ?? null;
    if (fixture !== undefined && !cases.includes(fixture)) throw new DomainError('NOT_FOUND');
    const { inputs, params } = name ? readCase(jig, name) : { inputs: {}, params: {} };
    const runner = new ComputeBoxRunner(this.options.box);
    try {
      const report = await executeSteps({
        jig,
        runner,
        cache: new MemoryCache(),
        mode: 'preview',
        inputs,
        params: caseParams(jig, params),
      });
      let panel: unknown = null;
      if (jig.manifest.panel)
        try {
          panel = JSON.parse(readFileSync(join(dir, jig.manifest.panel), 'utf8'));
        } catch {
          panel = null;
        }
      const outputs: Record<string, unknown> = {};
      for (const [step, output] of Object.entries(report.outputs)) {
        const bytes = Buffer.byteLength(JSON.stringify(output) ?? '');
        outputs[step] = bytes > PREVIEW_OUTPUT_BYTES ? { truncated: true, bytes } : output;
      }
      const preview: DraftPreview = {
        ok: !report.steps.some((s) => s.status === 'failed' || s.status === 'gate-failed'),
        fixture: name,
        panel,
        steps: report.steps.map(({ id, kind, status, ms, error }) => ({
          id,
          kind,
          status,
          ms,
          ...(error ? { error } : {}),
        })),
        outputs,
      };
      this.keep(draftId, 'preview', { ...preview, at: new Date().toISOString() });
      return preview;
    } finally {
      await runner.close();
    }
  }

  /**
   * Makes the draft a project jig (a confirmed action; the route checks the confirmation and
   * remote sessions): validation and the self-test again, then a read-only install with the
   * engine's digest and the pin.
   */
  async pin(
    projectId: string,
    draftId: string,
    input: { jigId?: string; version?: string; approvedCaps?: string[] } = {},
  ): Promise<PinResult> {
    const draft = this.open(projectId, draftId);
    const dir = draft.path;
    const validation = await validateDraftDir(dir);
    if (!validation.ok) throw new JigInvalidError(validation.issues);
    const test = await selftestInBox(await loadJig(dir, { source: 'ai-draft' }), this.options.box);
    this.keep(draftId, 'test', { ...test, at: new Date().toISOString() });
    if (!test.ok) throw new DomainError('JIG_SELFTEST_FAILED');
    const raw = readManifestFile(dir) as Record<string, unknown>;
    const id = input.jigId ?? String(raw.id);
    const version = input.version ?? String(raw.version);
    if (!JIG_ID.test(id) || !id.startsWith('project/') || !SEMVER.test(version))
      throw new DomainError('INVALID_INPUT');
    // A step file the conversation emptied (a file tool cannot delete) and no step names is dropped.
    const named = new Set(
      (Array.isArray(raw.steps) ? (raw.steps as { entry?: unknown }[]) : [])
        .map((step) => (typeof step?.entry === 'string' ? step.entry.split('#')[0] : ''))
        .filter(Boolean),
    );
    const emptyStep = (path: string) =>
      /^steps\//.test(path) && !named.has(path) && !readFileSync(join(dir, path), 'utf8').trim();
    const entries = listPackageFiles(dir)
      .filter((path) => !emptyStep(path))
      .map((path) => ({
        path,
        bytes:
          path === 'jig.json' && (id !== raw.id || version !== raw.version)
            ? Buffer.from(JSON.stringify({ ...raw, id, version }, null, 2) + '\n', 'utf8')
            : readFileSync(join(dir, path)),
      }));
    const digest = digestEntries(entries);
    let existing;
    try {
      existing = this.store.package(id, version);
    } catch {
      existing = undefined;
    }
    let path: string, jig: LoadedJig, installed: boolean;
    if (existing) {
      if (existing.digest !== digest) throw new DomainError('JIG_VERSION_EXISTS');
      jig = await loadJig(existing.path, { source: existing.source, expectDigest: digest });
      path = existing.path;
      installed = false;
    } else {
      const root = installedRoot(this.dataDir);
      mkdirSync(root, { recursive: true });
      const temp = mkdtempSync(join(root, '.draft-'));
      try {
        for (const entry of entries) {
          const target = join(temp, ...entry.path.split('/'));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, entry.bytes);
        }
        const loaded = await loadJig(temp, { source: 'ai-draft', expectDigest: digest });
        path = join(root, installedFolder(id, version));
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
        renameSync(temp, path);
        for (const file of loaded.files)
          try {
            chmodSync(join(path, ...file.split('/')), 0o444);
          } catch {
            /* read-only is a courtesy on some file systems */
          }
        const declared = loaded.manifest.capabilities.map((c) => c.name);
        this.store.addPackage({
          id,
          version,
          stage: 'project',
          source: 'ai-draft',
          digest,
          signer: null,
          path,
          approvedCaps: (input.approvedCaps ?? declared).filter((name) =>
            (declared as string[]).includes(name),
          ),
        });
        jig = await loadJig(path, { source: 'ai-draft', expectDigest: digest });
        installed = true;
        this.options.onInstalled?.(id, version);
      } finally {
        if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
      }
    }
    const pinned = this.store.pin(projectId, id, version);
    this.store.updateDraft(projectId, draftId, { state: 'pinned' });
    return {
      id,
      version,
      digest,
      path,
      installed,
      pinned,
      capabilities: jig.manifest.capabilities.map((c) => ({ name: c.name, reason: c.reason })),
    };
  }

  /** Removes the draft folder and its kept results; the row stays as `discarded`. */
  discard(projectId: string, draftId: string): JigDraft {
    const draft = this.store.draft(projectId, draftId);
    const dir = resolve(draft.path);
    // Only a folder under the drafts root is ever removed.
    if (dir.startsWith(this.root + sep) && existsSync(dir))
      rmSync(dir, { recursive: true, force: true });
    rmSync(this.resultsFile(draftId), { force: true });
    return this.store.updateDraft(projectId, draftId, { state: 'discarded' });
  }
}

/** Validation of a draft folder: the forbidden-file scan, step sources, then the package check. */
export async function validateDraftDir(dir: string): Promise<ValidationReport> {
  const forbidden = scanDraft(dir);
  if (forbidden.length) return { ok: false, issues: forbidden };
  const report = await validateJig(dir, { source: 'ai-draft' });
  if (!report.ok) return report;
  const sources: ManifestIssue[] = [];
  for (const file of listPackageFiles(dir))
    if (/^steps\/.*\.m?ts$/.test(file))
      try {
        boxSource(file, readFileSync(join(dir, file), 'utf8'));
      } catch (error) {
        sources.push({
          code: 'JIG_SCHEMA',
          path: file,
          message: `타입 제거 실패(enum·namespace는 쓸 수 없음): ${String((error as Error).message).slice(0, 300)}`,
          level: 'error',
        });
      }
  return sources.length ? { ...report, ok: false, issues: [...report.issues, ...sources] } : report;
}

/**
 * Why a validate or test report failed, as a stable text (undefined when it passed): the issues'
 * codes and paths, or each failing case with its first error line and mismatch paths. Two failures
 * with the same text failed for the same reason (the make-conversation's stop rule, SPEC-07.9).
 */
export function failureReason(
  report: Pick<ValidationReport, 'ok'> & {
    issues?: ManifestIssue[];
    cases?: SelftestReport['cases'];
  },
): string | undefined {
  if (report.ok) return undefined;
  const issues = (report.issues ?? [])
    .filter((entry) => entry.level !== 'warn')
    .map((entry) => `${entry.code} ${entry.path}`)
    .sort();
  if (issues.length) return issues.join('; ').slice(0, 1000);
  const cases = (report.cases ?? [])
    .filter((entry) => !entry.ok)
    .map((entry) =>
      [
        entry.name,
        entry.error?.split('\n')[0]?.slice(0, 200),
        ...entry.mismatches.map((m) => m.path),
      ]
        .filter(Boolean)
        .join(' '),
    );
  return (cases.length ? cases.join('; ') : '시험 사례 없음').slice(0, 1000);
}

function fixtureNames(jig: LoadedJig): string[] {
  const prefix = `${jig.manifest.selftest.fixtures}/`;
  const names = new Set<string>();
  for (const file of jig.files)
    if (file.startsWith(prefix)) {
      const name = file.slice(prefix.length).split('/')[0];
      if (file.slice(prefix.length).includes('/')) names.add(name);
    }
  return [...names].sort().slice(0, MAX_CASES);
}
function readCase(jig: LoadedJig, name: string) {
  const read = (file: string) => {
    const path = join(jig.dir, jig.manifest.selftest.fixtures, name, file);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined;
  };
  return {
    inputs: (read('input.json') ?? {}) as Record<string, unknown>,
    params: (read('params.json') ?? {}) as Record<string, unknown>,
    expect: (read('expect.json') ?? {}) as {
      steps?: Record<string, unknown>;
      statuses?: Record<string, string>;
      tolerance?: { length?: number; ratio?: number };
    },
  };
}
function caseParams(jig: LoadedJig, values: Record<string, unknown>) {
  const changes: ParamChange[] = Object.entries(values).map(([key, value]) => ({
    key,
    value: value as ParamChange['value'],
  }));
  return applyChanges(jig.manifest, initialParams(jig.manifest), changes, {
    by: 'user',
    atPin: true,
  }).next;
}

/**
 * The self-test of `npm run jig:test` (`selftestJig`) with the compute box as the runner: every
 * fixture case, compared with its `expect.json` within the tolerance.
 */
export async function selftestInBox(
  jig: LoadedJig,
  options?: ComputeBoxOptions,
): Promise<SelftestReport> {
  const runner = new ComputeBoxRunner(options);
  const cases: SelftestReport['cases'] = [];
  try {
    for (const name of fixtureNames(jig)) {
      try {
        const { inputs, params, expect } = readCase(jig, name);
        const report = await executeSteps({
          jig,
          runner,
          cache: new MemoryCache(),
          mode: 'selftest',
          inputs,
          params: caseParams(jig, params),
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
