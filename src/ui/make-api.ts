// Typed client of the jig authoring routes (만들기, PLAN-22 T-063, ARCH-03 §7, SPEC-07.16).
// Drafts live in the engine's data folder (`<data>/jigs/drafts/<draftId>/`); the screen only reads
// what the engine reports about them: the manifest, the file list, and the last 점검 (validate),
// 시험 (test) and 미리보기 (preview) results. Pinning installs a draft as an unsigned `ai-draft` project
// jig that runs only in the compute box (ARCH-03 §12) and asks for confirmation; deleting a draft also deletes the provider
// transcripts of its authoring conversation. The schemas are tolerant (`passthrough`, defaults)
// so a newer engine that reports more still parses.
import { z } from 'zod';
import { api, errors } from './gateway.ts';

const at = z.string().optional();

export const draftSummarySchema = z
  .object({
    id: z.string(),
    name: z.string().default('새 도구'),
    version: z.string().optional(),
    createdAt: at,
    updatedAt: at,
    conversationId: z.string().nullable().optional(),
    from: z.string().optional(),
  })
  .passthrough();
export type DraftSummary = z.infer<typeof draftSummarySchema>;

const issueSchema = z
  .object({
    code: z.string().default(''),
    path: z.string().default(''),
    message: z.string().default(''),
    level: z.enum(['error', 'warn']).default('error'),
  })
  .passthrough();
export type DraftIssue = z.infer<typeof issueSchema>;
export const validateResultSchema = z
  .object({
    ok: z.boolean(),
    issues: z.array(issueSchema).default([]),
    at,
    ms: z.number().optional(),
  })
  .passthrough();
export type ValidateResult = z.infer<typeof validateResultSchema>;

const mismatchSchema = z
  .object({ path: z.string(), expected: z.unknown(), actual: z.unknown() })
  .passthrough();
const stepReportSchema = z
  .object({
    id: z.string(),
    kind: z.string().optional(),
    status: z.string(),
    ms: z.number().nullable().optional(),
    gates: z
      .array(
        z
          .object({
            name: z.string(),
            level: z.string().optional(),
            ok: z.boolean(),
            message: z.string().default(''),
            verdict: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
    error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
  })
  .passthrough();
export type DraftStepReport = z.infer<typeof stepReportSchema>;
const caseSchema = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    steps: z.array(stepReportSchema).default([]),
    mismatches: z.array(mismatchSchema).default([]),
    error: z.string().optional(),
    ms: z.number().optional(),
    /** How many times this case failed the same way in a row (the authoring loop stops at 3). */
    attempts: z.number().optional(),
  })
  .passthrough();
export type TestCase = z.infer<typeof caseSchema>;
export const testResultSchema = z
  .object({
    ok: z.boolean(),
    cases: z.array(caseSchema).default([]),
    /** A test run refuses to start when the draft does not validate. */
    issues: z.array(issueSchema).optional(),
    at,
    ms: z.number().optional(),
  })
  .passthrough();
export type TestResult = z.infer<typeof testResultSchema>;

export const previewResultSchema = z
  .object({
    ok: z.boolean().optional(),
    /** The draft's `panel.json` as read; the screen checks it before drawing. */
    panel: z.unknown(),
    /** Latest output of each step, by step id, run in the compute box on a fixture. */
    outputs: z.record(z.string(), z.unknown()).default({}),
    steps: z.array(stepReportSchema).default([]),
    /** Setting values the run used, by key (storage unit). */
    params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
    fixture: z.string().optional(),
    fixtures: z.array(z.string()).optional(),
    issues: z.array(issueSchema).optional(),
    at,
    ms: z.number().optional(),
  })
  .passthrough();
export type PreviewResult = z.infer<typeof previewResultSchema>;

const fileSchema = z.union([
  z.string().transform((path) => ({ path })),
  z
    .object({
      path: z.string(),
      size: z.number().optional(),
      updatedAt: at,
      /** Changed since the last validate/test run. */
      changed: z.boolean().optional(),
      content: z.string().optional(),
    })
    .passthrough(),
]);
export type DraftFile = { path: string; size?: number; updatedAt?: string; changed?: boolean };

const planItemSchema = z
  .object({
    title: z.string(),
    group: z.string().optional(),
    done: z.boolean().default(false),
    current: z.boolean().optional(),
  })
  .passthrough();
export type PlanItem = z.infer<typeof planItemSchema>;

export const draftDetailSchema = z
  .object({
    draft: draftSummarySchema.optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    /** `jig.json` as written (it may not validate yet). */
    manifest: z.unknown().optional(),
    files: z.array(fileSchema).default([]),
    /** `skill.md` (the AI 설명서), read-only on this screen. */
    skill: z.string().nullable().optional(),
    validate: validateResultSchema.nullable().optional(),
    test: testResultSchema.nullable().optional(),
    preview: previewResultSchema.nullable().optional(),
    conversationId: z.string().nullable().optional(),
    plan: z
      .object({ items: z.array(planItemSchema).default([]) })
      .passthrough()
      .optional(),
    turns: z.number().optional(),
    savedAt: at,
  })
  .passthrough();
export interface DraftDetail {
  draft: DraftSummary;
  manifest: DraftManifest;
  files: DraftFile[];
  skill?: string;
  validate?: ValidateResult;
  test?: TestResult;
  preview?: PreviewResult;
  conversationId?: string;
  plan?: PlanItem[];
  turns?: number;
  savedAt?: string;
}

/** The parts of `jig.json` the outline reads; everything is optional while the draft is written. */
export const manifestSchema = z
  .object({
    id: z.string().optional(),
    version: z.string().optional(),
    name: z.string().optional(),
    summary: z.string().optional(),
    inputs: z
      .array(
        z
          .object({ key: z.string(), title: z.string().default(''), kind: z.string() })
          .passthrough(),
      )
      .catch([])
      .default([]),
    params: z
      .array(
        z
          .object({
            key: z.string(),
            title: z.string().default(''),
            group: z.string().default(''),
            type: z.string().default('number'),
            unit: z.string().optional(),
            display: z.object({ unit: z.string(), decimals: z.number() }).optional(),
            default: z.union([z.number(), z.string(), z.boolean()]).optional(),
            range: z.object({ min: z.number(), max: z.number(), step: z.number() }).optional(),
            choices: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
            basis: z
              .object({
                status: z.enum(['confirmed', 'assumed', 'chosen', 'to-ask']),
                note: z.string().optional(),
                question: z.string().optional(),
              })
              .passthrough()
              .optional(),
            board: z.boolean().optional(),
            fixedAtPin: z.boolean().optional(),
            help: z.string().optional(),
          })
          .passthrough(),
      )
      .catch([])
      .default([]),
    steps: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string().default(''),
            kind: z.string().default('code'),
            needs: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .catch([])
      .default([]),
  })
  .passthrough();
export type DraftManifest = z.infer<typeof manifestSchema>;

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/jig-drafts`;
const one = (projectId: string, draftId: string) =>
  `${base(projectId)}/${encodeURIComponent(draftId)}`;

/** Read a draft detail answer into the screen's shape (pure, for tests). */
export function readDetail(value: unknown): DraftDetail {
  const raw = draftDetailSchema.parse(value);
  const draft =
    raw.draft ?? draftSummarySchema.parse({ id: raw.id ?? '', name: raw.name ?? '새 도구' });
  const files = raw.files.map((file) => ({
    path: file.path,
    ...('size' in file && file.size !== undefined ? { size: file.size } : {}),
    ...('updatedAt' in file && file.updatedAt ? { updatedAt: file.updatedAt } : {}),
    ...('changed' in file && file.changed ? { changed: true } : {}),
  }));
  const skillFile = raw.files.find(
    (file): file is { path: string; content: string } =>
      file.path === 'skill.md' && 'content' in file && typeof file.content === 'string',
  );
  const manifest = manifestSchema.safeParse(raw.manifest ?? {});
  const conversationId = raw.conversationId ?? draft.conversationId ?? undefined;
  return {
    draft,
    manifest: manifest.success ? manifest.data : manifestSchema.parse({}),
    files,
    ...(raw.skill ? { skill: raw.skill } : skillFile ? { skill: skillFile.content } : {}),
    ...(raw.validate ? { validate: raw.validate } : {}),
    ...(raw.test ? { test: raw.test } : {}),
    ...(raw.preview ? { preview: raw.preview } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(raw.plan ? { plan: raw.plan.items } : {}),
    ...(raw.turns !== undefined ? { turns: raw.turns } : {}),
    ...(raw.savedAt ? { savedAt: raw.savedAt } : {}),
  };
}

export async function listDrafts(projectId: string): Promise<DraftSummary[]> {
  const value = await api(base(projectId));
  const list = Array.isArray(value)
    ? value
    : z
        .object({ drafts: z.array(z.unknown()) })
        .passthrough()
        .parse(value).drafts;
  return z.array(draftSummarySchema).parse(list);
}
export type DraftStart = 'example-grid' | 'blank';
export async function createDraft(
  projectId: string,
  input: { name: string; from?: DraftStart },
): Promise<DraftSummary> {
  const value = await api(base(projectId), 'POST', input);
  const record = value && typeof value === 'object' && 'draft' in value ? value.draft : value;
  return draftSummarySchema.parse(record);
}
export async function getDraft(projectId: string, draftId: string): Promise<DraftDetail> {
  return readDetail(await api(one(projectId, draftId)));
}
export async function validateDraft(projectId: string, draftId: string) {
  return validateResultSchema.parse(await api(`${one(projectId, draftId)}/validate`, 'POST', {}));
}
export async function testDraft(projectId: string, draftId: string) {
  return testResultSchema.parse(await api(`${one(projectId, draftId)}/test`, 'POST', {}));
}
export async function previewDraft(
  projectId: string,
  draftId: string,
  input: { fixture?: string; params?: Record<string, number | string | boolean> } = {},
) {
  return previewResultSchema.parse(await api(`${one(projectId, draftId)}/preview`, 'POST', input));
}
export const pinResultSchema = z
  .object({
    jigId: z.string().optional(),
    id: z.string().optional(),
    version: z.string().optional(),
    instanceId: z.string().optional(),
  })
  .passthrough();
/** Pin the draft as this project's jig (T2: the person confirmed on screen). */
export async function pinDraft(projectId: string, draftId: string) {
  return pinResultSchema.parse(
    await api(`${one(projectId, draftId)}/pin`, 'POST', { confirm: true }),
  );
}
/** Discard the draft: its folder and its authoring conversation's provider transcripts. */
export async function deleteDraft(projectId: string, draftId: string) {
  await api(one(projectId, draftId), 'DELETE');
}

/** The authoring conversation of a draft (created when the draft has none yet). */
export async function makeConversation(
  projectId: string,
  draft: Pick<DraftSummary, 'id' | 'name'>,
): Promise<string> {
  const path = `/projects/${encodeURIComponent(projectId)}/conversations`;
  const listed = z
    .array(
      z
        .object({ id: z.string().nullable(), draftId: z.string().nullable().optional() })
        .passthrough(),
    )
    .catch([])
    .parse(await api(path).catch(() => []));
  const found = listed.find(
    (entry) => entry.id && entry.draftId === draft.id && entry.state !== 'closed',
  );
  if (found?.id) return found.id;
  const created = z
    .object({ id: z.string() })
    .passthrough()
    .parse(
      await api(path, 'POST', { mode: 'make', draftId: draft.id, title: `${draft.name} · 만들기` }),
    );
  return created.id;
}

export const importResultSchema = z
  .object({
    id: z.string().optional(),
    jigId: z.string().optional(),
    version: z.string().optional(),
  })
  .passthrough();
/**
 * Import a `.vjig` into this project (확인 필요 동작: the caller asked first). The package goes as
 * raw bytes; a package signed on another PC, without a signature or with a forbidden file is
 * refused by the engine and nothing is installed. The engine installs on `/api/v1/jigs/import`
 * (ARCH-03 §7); the same confirmed card then pins it to this project.
 */
export async function importJig(projectId: string, file: Blob) {
  let response: Response;
  try {
    response = await fetch('api/v1/jigs/import?confirm=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new Error(errors.NETWORK_UNAVAILABLE ?? '네트워크에 연결하지 못했습니다.');
  }
  const body = (await response.json().catch(() => null)) as {
    code?: string;
    error?: string;
    issues?: { message?: string }[];
  } | null;
  if (!response.ok) {
    const code = body?.code ?? body?.error ?? 'REQUEST_FAILED';
    const detail = (body?.issues ?? [])
      .map((issue) => issue.message)
      .filter(Boolean)
      .slice(0, 3)
      .join(' · ');
    throw Object.assign(
      new Error(
        (IMPORT_ERRORS[code] ?? errors[code] ?? `가져오지 못했습니다 (${code})`) +
          (detail ? ` — ${detail}` : ''),
      ),
      { code },
    );
  }
  const imported = importResultSchema.parse(body ?? {});
  const jigId = imported.id ?? imported.jigId;
  if (jigId && imported.version)
    await api(
      `/projects/${encodeURIComponent(projectId)}/jigs/${encodeURIComponent(jigId)}/pin`,
      'POST',
      { version: imported.version, confirm: true },
    );
  return imported;
}
const IMPORT_ERRORS: Record<string, string> = {
  JIG_INVALID: '이 파일은 jig 형식 점검을 통과하지 못해 가져오지 않았습니다.',
  FORBIDDEN: '원격 화면에서는 jig를 가져올 수 없습니다. 이 PC에서 가져오세요.',
  JIG_SIGNATURE: '이 PC에서 묶은 jig만 가져올 수 있습니다.',
};
