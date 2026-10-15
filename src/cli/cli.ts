// `vide` CLI (PLAN-52 T-315, SPEC-01.13 10, SPEC-07.18, ARCH-01 「작업 폴더(PLAN-52)」): from a
// terminal opened in a work folder, list and run the project's jigs, show a role folder and save
// the latest jig report into the tree. The project is the manifest at or above the current folder;
// the engine is the installed one (`<데이터>/launch.json`). Writes stay inside the work folder;
// a person's step stops the run (exit 3) and is continued on the VIDE screen. Host documents are
// never opened or changed from here.
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { DomainError } from '../contracts/errors.ts';
import { insideWorkspace, realPathOf } from '../core/workspace-config.ts';
import { pathKey } from '../core/xref-graph.ts';
import { USAGE, UsageError, parseArgs, type CliArgs } from './args.ts';
import { connectEngine, dataDirectoryOf, type EngineClient } from './engine.ts';
import {
  findLocalWorkspace,
  listFolder,
  makeOutputFolder,
  reviewFolder,
  roleEntries,
  rolePath,
  type LocalWorkspace,
} from './workspace.ts';

export interface CliIo {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: typeof fetch;
  now?: () => Date;
}

export const EXIT = { ok: 0, error: 1, usage: 2, humanStep: 3 } as const;

/** What each refusal says to the person at the terminal (plain words; the code goes with it). */
export const MESSAGES: Record<string, string> = {
  NO_WORKSPACE:
    '이 폴더나 상위 폴더에 project.config.json이 없습니다. VIDE 작업 폴더 안에서 실행하세요.',
  ENGINE_UNAVAILABLE: 'VIDE에 연결하지 못했습니다. VIDE를 연 뒤 다시 실행하세요.',
  OUTSIDE_WORKSPACE: '작업 폴더 밖에는 쓰지 않습니다. 아무것도 저장하지 않았습니다.',
  HUMAN_STEP_REQUIRED: '사람이 확인할 단계에서 멈췄습니다. VIDE 화면에서 이어 가세요.',
  WORKSPACE_CONFIG_INVALID: 'project.config.json을 읽을 수 없습니다. 파일 내용을 확인하세요.',
  WORKSPACE_PROJECT_CONFLICT: '이 작업 폴더는 다른 VIDE 프로젝트의 것입니다.',
  PROJECT_NOT_FOUND: '이 작업 폴더에 이어진 VIDE 프로젝트를 이 PC에서 찾지 못했습니다.',
  JIG_NOT_FOUND: '그 jig를 이 프로젝트에서 찾지 못했습니다. vide jig list로 확인하세요.',
  WORKSPACE_ROLE_MISSING: 'project.config.json에 그 역할 폴더가 없습니다.',
  NO_ROLE: '모르는 역할입니다.',
  NO_REPORT: '내보낼 보고서가 없습니다. 먼저 jig를 계산하세요.',
  EXPORT_REFUSED: '이 보고서는 아직 내보낼 수 없습니다. VIDE 화면에서 이유를 확인하세요.',
  EXPORT_FOLDER_TAKEN: '같은 이름의 폴더가 너무 많아 저장하지 못했습니다.',
  REPORT_NOT_FINAL:
    '확정된 결과가 아니라 보고용을 만들지 않았습니다. 먼저 다시 계산하면 만들 수 있습니다.',
  OUTPUT_NOT_WRITTEN:
    '산출물 폴더에 쓰지 못했습니다. 보고용은 VIDE 화면의 산출물 → 보고서에서 내려받을 수 있습니다.',
  JIG_RUN_FAILED: 'jig 계산이 끝나지 못했습니다. 입력과 검사 결과는 VIDE 화면에서 확인하세요.',
  USAGE: '명령을 이해하지 못했습니다.',
};

const STEP_WORDS: Record<string, string> = {
  done: '완료',
  confirmed: '확인됨',
  reconfirm: '다시 확인 필요',
  waiting: '확인 대기',
  blocked: '앞 단계 대기',
  skipped: '건너뜀',
  failed: '실패',
  'gate-failed': '검사 통과 못 함',
};

interface SkillRow {
  id: string;
  name: string;
  scope: 'project' | 'available';
  version?: string;
  description?: string;
}
interface InstanceRow {
  id: string;
  jigId: string;
  version: string;
  title: string;
  status: string;
  updatedAt: string;
}
interface StepReport {
  id: string;
  kind: string;
  status: string;
  error?: { code: string; message: string };
}
interface StepView {
  id: string;
  title: string;
  kind: string;
  status: string;
  hasOutput?: boolean;
}

class CliFailure extends DomainError {
  detail?: Record<string, unknown>;
  constructor(code: string, detail?: Record<string, unknown>) {
    super(code);
    this.detail = detail;
  }
}

/** Runs one command; returns the exit code. Never throws. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let args: CliArgs | undefined;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes('--json'))
      io.stdout(JSON.stringify({ ok: false, code: 'USAGE', message }) + '\n');
    else io.stderr(`${message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  try {
    return await dispatch(args, io);
  } catch (error) {
    const code =
      error instanceof UsageError
        ? 'USAGE'
        : error instanceof DomainError
          ? error.code
          : 'INTERNAL_ERROR';
    const detail = error instanceof CliFailure ? error.detail : undefined;
    const message =
      (typeof detail?.message === 'string' ? detail.message : undefined) ??
      MESSAGES[code] ??
      (error instanceof DomainError
        ? `VIDE가 요청을 거절했습니다.`
        : `예상하지 못한 오류입니다: ${error instanceof Error ? error.message : String(error)}`);
    if (args.json) io.stdout(JSON.stringify({ ok: false, code, message, ...detail }) + '\n');
    else io.stderr(`${message} (${code})\n`);
    return code === 'HUMAN_STEP_REQUIRED'
      ? EXIT.humanStep
      : code === 'USAGE'
        ? EXIT.usage
        : EXIT.error;
  }
}

async function dispatch(args: CliArgs, io: CliIo): Promise<number> {
  const out = (value: unknown, text: string) =>
    io.stdout(args.json ? JSON.stringify({ ok: true, ...(value as object) }) + '\n' : text);
  const { command } = args;
  if (command.kind === 'help') {
    io.stdout(args.json ? JSON.stringify({ ok: true, usage: USAGE }) + '\n' : USAGE);
    return EXIT.ok;
  }
  const ws = await findLocalWorkspace(io.cwd);
  if (command.kind === 'data') {
    await data(ws, command.role, args.json, io);
    return EXIT.ok;
  }
  const engine = await connectEngine(dataDirectoryOf(io.env, args.dataDir), io.fetch);
  const projectId = await projectOf(engine, ws);
  const base = `/projects/${encodeURIComponent(projectId)}`;

  if (command.kind === 'jig-list') {
    const { skills } = await engine.call<{ skills: SkillRow[] }>(`${base}/skills`);
    const jigs = skills.map((s) => ({
      id: s.id,
      name: s.name,
      scope: s.scope,
      ...(s.version ? { version: s.version } : {}),
      ...(s.description ? { description: s.description } : {}),
    }));
    const width = Math.max(0, ...jigs.map((j) => j.id.length));
    const lines = jigs.map(
      (j) =>
        `  ${j.id.padEnd(width)}  ${j.name}${j.scope === 'project' ? '  (이 프로젝트)' : ''}\n`,
    );
    out(
      { projectId, jigs },
      jigs.length ? `jig ${jigs.length}개\n${lines.join('')}` : '쓸 수 있는 jig가 없습니다.\n',
    );
    return EXIT.ok;
  }

  if (command.kind === 'jig-run') {
    const { skills } = await engine.call<{ skills: SkillRow[] }>(`${base}/skills`);
    const jig = pick(
      skills,
      command.jig,
      (s) => s.id,
      (s) => s.name,
    );
    if (!jig) throw new CliFailure('JIG_NOT_FOUND', { jig: command.jig });
    const { instances } = await engine.call<{ instances: InstanceRow[] }>(`${base}/jig-instances`);
    let instance = args.fresh ? undefined : latest(instances.filter((r) => r.jigId === jig.id));
    if (!instance)
      instance = await engine.call<InstanceRow>(`${base}/jig-instances`, 'POST', {
        jig: jig.id,
        title: jig.name,
        // The Rhino output layer is asked on the VIDE screen at Rhino에 만들기 (ADR-026).
        layerRootLater: true,
      });
    const path = `${base}/jig-instances/${encodeURIComponent(instance.id)}`;
    if (command.inputs.length)
      await engine.call(`${path}/params`, 'PUT', {
        values: command.inputs,
        by: 'user',
        reason: '터미널(vide jig run)에서 지정',
      });
    const report = await engine.call<{ steps: StepReport[]; status: string }>(
      `${path}/run`,
      'POST',
      { mode: 'confirmed' },
    );
    const view = await engine.call<{ steps: StepView[] }>(path);
    const titles = new Map(view.steps.map((s) => [s.id, s.title]));
    const steps = report.steps.map((s) => ({
      id: s.id,
      title: titles.get(s.id) ?? s.id,
      kind: s.kind,
      status: s.status,
      ...(s.error ? { error: s.error.code } : {}),
    }));
    const human = steps.find(
      (s) => s.kind === 'human' && (s.status === 'waiting' || s.status === 'reconfirm'),
    );
    const failed = steps.filter((s) => s.status === 'failed' || s.status === 'gate-failed');
    const summary = {
      projectId,
      jig: { id: jig.id, name: jig.name },
      instanceId: instance.id,
      status: report.status,
      steps,
    };
    const text =
      `${jig.name} (${jig.id})\n` +
      steps
        .map(
          (s) =>
            `  ${s.title}: ${
              s.kind === 'host' && s.status === 'waiting'
                ? 'Rhino에 만들기는 VIDE 화면에서'
                : (STEP_WORDS[s.status] ?? s.status)
            }\n`,
        )
        .join('');
    if (human) {
      if (!args.json) io.stdout(text);
      throw new CliFailure('HUMAN_STEP_REQUIRED', {
        ...summary,
        question: { stepId: human.id, title: human.title },
        message: `사람이 확인할 단계에서 멈췄습니다: ${human.title}. VIDE 화면에서 이어 가세요.`,
      });
    }
    if (failed.length) {
      if (!args.json) io.stdout(text);
      throw new CliFailure('JIG_RUN_FAILED', summary);
    }
    out(summary, text);
    return EXIT.ok;
  }

  // export
  const { instances } = await engine.call<{
    instances: { instance: InstanceRow; reports: { id: string; title: string }[] }[];
  }>(`${base}/jig-reports`);
  const known = instances.map((row) => row.instance);
  const jigId = pick(known, command.jig, (r) => r.jigId)?.jigId;
  if (!jigId) throw new CliFailure('NO_REPORT', { jig: command.jig });
  const instance = latest(known.filter((r) => r.jigId === jigId))!;
  const frames = instances.find((row) => row.instance.id === instance.id)!.reports;
  const frame = command.report ? frames.find((f) => f.id === command.report) : frames[0];
  if (!frame) throw new CliFailure('NO_REPORT', { jig: jigId, reports: frames.map((f) => f.id) });
  const path = `${base}/jig-instances/${encodeURIComponent(instance.id)}`;
  const rendered = await engine.call<{
    report: { id: string; title: string };
    instance: { id: string; title: string; jig: { id: string; version: string; name: string } };
    model: { sections?: unknown[]; title?: string };
    html: string;
    copy?: string | null;
  }>(`${path}/reports/${encodeURIComponent(frame.id)}`);
  if (!rendered.html) throw new CliFailure('EXPORT_REFUSED', { jig: jigId, report: frame.id });
  const now = io.now?.() ?? new Date();
  const files: string[] = [];
  let folder: string;
  const engineCopy =
    command.exportKind === 'review' && rendered.copy && insideWorkspace(ws.root, rendered.copy)
      ? rendered.copy
      : null;
  if (engineCopy) {
    // The engine already keeps this run's 검토용 copy in the review role (T-313): the same folder,
    // never a second one under another name.
    folder = win32.dirname(engineCopy);
    files.push(engineCopy);
    const data = win32.join(folder, 'data.json');
    if (existsSync(data)) files.push(data);
  } else if (command.exportKind === 'review') {
    folder = await makeOutputFolder(
      ws.root,
      reviewFolder(rolePath(ws, 'review'), jigId, new Date(instance.updatedAt), instance.id),
    );
    const view = await engine.call<{ steps: StepView[] }>(path);
    const outputs: Record<string, unknown> = {};
    for (const step of view.steps) {
      if (!step.hasOutput) continue;
      const kept = await engine
        .call<{ output: unknown }>(`${path}/steps/${encodeURIComponent(step.id)}/output`)
        .catch(() => null);
      if (kept) outputs[step.id] = kept.output;
    }
    files.push(await put(folder, 'report.html', rendered.html));
    files.push(
      await put(
        folder,
        'data.json',
        JSON.stringify(
          {
            jig: rendered.instance.jig,
            instance: { id: instance.id, title: instance.title, updatedAt: instance.updatedAt },
            status: instance.status,
            outputs,
            exportedAt: now.toISOString(),
          },
          null,
          2,
        ),
      ),
    );
  } else {
    // 보고용 (SPEC-07.11 두 등급): the engine's [보고용 만들기] makes it — the frame's public
    // sections, `<output>/<YYYY-MM-DD>-<제목>/` with index.html, the tables as CSV and report.json —
    // so the terminal and the screen write one shape (PLAN-54 T-342).
    const made = await engine.call<{
      name: string;
      folder: string | null;
      written: boolean;
      files: string[];
      reason?: string;
    }>(`${path}/reports/${encodeURIComponent(frame.id)}/public`, 'POST', {});
    if (!made.written || !made.folder)
      throw new CliFailure('OUTPUT_NOT_WRITTEN', { name: made.name, reason: made.reason });
    folder = made.folder;
    files.push(...made.files.map((name) => win32.join(made.folder!, name)));
  }
  out(
    { projectId, jigId, instanceId: instance.id, kind: command.exportKind, folder, files },
    `저장했습니다: ${folder}\n${files.map((f) => `  ${win32.basename(f)}\n`).join('')}`,
  );
  return EXIT.ok;
}

async function put(folder: string, name: string, text: string) {
  const file = win32.join(folder, name);
  await writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
  return file;
}

/** `vide data [role]`: offline, from the manifest only. */
async function data(ws: LocalWorkspace, role: string | undefined, json: boolean, io: CliIo) {
  if (!role) {
    const roles = roleEntries(ws);
    io.stdout(
      json
        ? JSON.stringify({ ok: true, root: ws.root, schema: ws.cfg.schema, roles }) + '\n'
        : `작업 폴더: ${ws.root}\n` +
            roles
              .map(
                (r) =>
                  `  ${r.role.padEnd(13)} ${r.path ?? (r.outside ? '(작업 폴더 밖이라 쓰지 않음)' : '(없음)')}\n`,
              )
              .join(''),
    );
    return;
  }
  const path = rolePath(ws, role);
  const listing = await listFolder(path);
  io.stdout(
    json
      ? JSON.stringify({ ok: true, root: ws.root, role, path, ...listing }) + '\n'
      : `${path}\n` +
          (listing.exists
            ? listing.entries.length
              ? listing.entries
                  .map((e) => `  ${e.name}${e.kind === 'folder' ? '\\' : ''}\n`)
                  .join('')
              : '  (비어 있음)\n'
            : '  (폴더가 아직 없습니다)\n'),
  );
}

/** The VIDE project of the work folder: the manifest's id, or the project whose folder it is. */
async function projectOf(engine: EngineClient, ws: LocalWorkspace): Promise<string> {
  if (ws.projectId) {
    try {
      await engine.call(`/projects/${encodeURIComponent(ws.projectId)}/skills`);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'NOT_FOUND')
        throw new CliFailure('PROJECT_NOT_FOUND', { projectId: ws.projectId });
      throw error;
    }
    return ws.projectId;
  }
  // A 규모검토 manifest names no VIDE project: find the project that has this folder.
  const keys = new Set([pathKey(ws.root), pathKey(realPathOf(ws.root))]);
  const projects = await engine.call<{ id: string }[]>('/projects');
  for (const project of Array.isArray(projects) ? projects : []) {
    const found = await engine
      .call<{ root: string }>(`/projects/${encodeURIComponent(project.id)}/workspace/paths`)
      .catch(() => null);
    if (found && (keys.has(pathKey(found.root)) || keys.has(pathKey(realPathOf(found.root)))))
      return project.id;
  }
  throw new CliFailure('PROJECT_NOT_FOUND');
}

/** The row named by `wanted`: exact id, then the id's last part, then the name. */
function pick<T>(
  rows: readonly T[],
  wanted: string,
  idOf: (row: T) => string,
  nameOf?: (row: T) => string,
): T | undefined {
  const lower = wanted.toLowerCase();
  return (
    rows.find((r) => idOf(r) === wanted) ??
    rows.find((r) => idOf(r).toLowerCase().split('/').pop() === lower) ??
    (nameOf ? rows.find((r) => nameOf(r) === wanted) : undefined)
  );
}

const latest = <T extends { updatedAt: string }>(rows: readonly T[]) =>
  [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
