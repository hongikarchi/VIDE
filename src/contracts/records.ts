import { z } from 'zod';

/**
 * 프로젝트 기록 (SPEC-17, ARCH-01 §5 「프로젝트 기록(PLAN-53, SPEC-17)」, schema 19): one dated
 * sentence with a source, a type (R 요구 · I 의도 · K 앎 · E 근거 · D 결정 · ? 미정), the parts of the
 * building it is about, what it points at, and the later records it led to (`follows`). Shared by
 * the UI and the server; the schemas below check the server's inputs.
 */
export const RECORD_TYPES = ['R', 'I', 'K', 'E', 'D', '?'] as const;
export const recordTypeSchema = z.enum(RECORD_TYPES);
export type RecordType = z.infer<typeof recordTypeSchema>;

export const RECORD_STATES = ['candidate', 'kept', 'dropped'] as const;
export const recordStateSchema = z.enum(RECORD_STATES);
export type RecordState = z.infer<typeof recordStateSchema>;

/** SPEC-17.2 `source`, as listed there. */
export const RECORD_SOURCES = [
  'request',
  'chat',
  'note',
  'journal',
  'meeting',
  'sync',
  'jig',
  'checkout',
  'kakao',
  'mail',
  'site-report',
  'manual',
] as const;
export const recordSourceSchema = z.enum(RECORD_SOURCES);
export type RecordSource = z.infer<typeof recordSourceSchema>;

/** 'YYYY-MM-DD' of a real calendar day. */
export const recordDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  });
/** 'HH:MM', 00:00–23:59. */
export const recordTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const RECORD_TEXT_MAX = 20_000;
export const recordTextSchema = z
  .string()
  .max(RECORD_TEXT_MAX)
  .refine((value) => Boolean(value.trim()));
const chapterSchema = z.string().trim().min(1).max(100).nullable();
const idList = z.array(z.string().min(1).max(200)).max(500);

/** What a record points at (ARCH-01 `attachments`). `undone` is never stored. */
export const recordAttachmentsSchema = z
  .object({
    requestId: z.string().min(1).max(200).optional(),
    reviewId: z.string().min(1).max(200).optional(),
    note: z
      .object({
        id: z.string().min(1).max(200),
        kind: z.string().min(1).max(40),
        paragraph: z.number().int().nonnegative().optional(),
      })
      .optional(),
    jig: z
      .object({
        instanceId: z.string().min(1).max(200),
        seq: z.number().int().nonnegative().optional(),
        runAt: z.string().max(40).optional(),
      })
      .optional(),
    checkoutId: z.string().min(1).max(200).optional(),
    file: z
      .object({
        /** Relative to the work folder. */
        path: z.string().min(1).max(1000),
        line: z.number().int().positive().optional(),
      })
      .optional(),
    objects: z.array(z.string().min(1).max(200)).max(5000).optional(),
    /** 갱신 제안 (SPEC-05.12 7, ARCH-01 '동기화 쌍과 갱신 제안'): the pair, the card, its rows. */
    pairId: z.string().min(1).max(200).optional(),
    proposalId: z.string().min(1).max(200).optional(),
    rows: z.array(z.string().min(1).max(40)).max(5000).optional(),
    applyId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type RecordAttachments = z.infer<typeof recordAttachmentsSchema>;

/** One record as the API answers it (ARCH-01 「기록 행」). */
export interface RecordRow {
  id: string;
  date: string;
  time: string | null;
  source: RecordSource;
  type: RecordType;
  text: string;
  state: RecordState;
  /** 'ai' or the account's display name ('user' when none is known). */
  by: string;
  chapter: string | null;
  /** Part ids (부위 사전). */
  parts: string[];
  /** Later records this one led to (record_links fromId = this). */
  follows: string[];
  /** Earlier records that led to this one (record_links toId = this). */
  followedBy: string[];
  attachments: RecordAttachments;
  sourceKey?: string;
  /** The correction that replaced this record ('정정됨'). */
  supersededBy?: string;
  /** The pointed request's executions are all undone (read time, never stored). */
  undone: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

/** A part's mapping onto the model (ARCH-01 `parts.mapping`). */
export const partMappingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('layer'),
    linkId: z.string().min(1).max(200),
    layer: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('objects'),
    linkId: z.string().min(1).max(200),
    ids: z.array(z.string().min(1).max(200)).max(20_000),
  }),
  z.object({
    kind: z.literal('jig-output'),
    instanceId: z.string().min(1).max(200),
    outputId: z.string().min(1).max(200),
  }),
]);
export type PartMapping = z.infer<typeof partMappingSchema>;

/** 부위 사전 항목. `grp` 신설·기존 등; `roleFrom → roleTo` the role sentence. */
export interface PartRow {
  id: string;
  name: string;
  grp: string | null;
  roleFrom: string | null;
  roleTo: string | null;
  chapter: string | null;
  mapping: PartMapping[];
  /** The day an existing part was first opened (first K record), editable by a person. */
  seenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MilestoneRow {
  id: string;
  label: string;
  date: string;
}

/** Why a part's mapping no longer reaches anything (`GET …/parts/status`). */
export type PartBreak = 'layer-missing' | 'link-missing' | 'instance-missing';

/** A part's mapping status (`GET …/parts/status` → `{parts: PartStatus[]}`, T-325). */
export interface PartStatus {
  partId: string;
  /** Mapping indexes that no longer reach anything. */
  broken: number[];
  /** Why, parallel to `broken`. */
  reasons: PartBreak[];
  /** The first reason, when any mapping is broken. */
  reason?: PartBreak;
  /** Some mapping could not be checked: its file has no Sync (never counted as broken). */
  unknown?: true;
  /** Mapping indexes that could not be checked. */
  unknownIndexes?: number[];
}

/** Counts over the project's whole list (before filtering). `chapter['']` = no chapter. */
export interface RecordCounts {
  state: Record<string, number>;
  type: Record<string, number>;
  source: Record<string, number>;
  chapter: Record<string, number>;
}
export interface RecordListResponse {
  records: RecordRow[];
  /** Matching records before limit/offset. */
  total: number;
  counts: RecordCounts;
}
/** A root (no incoming link) and every record reached from it, in list order (root first). */
export interface RecordChain {
  root: string;
  ids: string[];
}

/** List filters (`GET …/records?…`); state, type and source take a comma list. */
export interface RecordFilters {
  state?: RecordState[];
  type?: RecordType[];
  source?: RecordSource[];
  /** A part id; '-' = records with no part. */
  part?: string;
  /** A chapter; '-' = records with no chapter. */
  chapter?: string;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

// ---- Inputs (server-side checks) ----

/** `POST …/records` (a person's record) and `Records.add`. */
export const recordInputSchema = z
  .object({
    date: recordDateSchema.optional(),
    time: recordTimeSchema.nullable().optional(),
    type: recordTypeSchema.optional(),
    text: recordTextSchema,
    parts: idList.optional(),
    follows: idList.optional(),
    chapter: chapterSchema.optional(),
    attachments: recordAttachmentsSchema.optional(),
  })
  .strict();
export type RecordInput = z.infer<typeof recordInputSchema>;

/** `PATCH …/records/:r`. */
export const recordPatchSchema = z
  .object({
    text: recordTextSchema.optional(),
    type: recordTypeSchema.optional(),
    parts: idList.optional(),
    chapter: chapterSchema.optional(),
    date: recordDateSchema.optional(),
    time: recordTimeSchema.nullable().optional(),
  })
  .strict();
export type RecordPatch = z.infer<typeof recordPatchSchema>;

/** `POST …/records/:r/correct`. */
export const recordCorrectSchema = z
  .object({ text: recordTextSchema, type: recordTypeSchema.optional() })
  .strict();
export type RecordCorrection = z.infer<typeof recordCorrectSchema>;

export const recordStateInputSchema = z.object({ state: recordStateSchema }).strict();
export const recordStatesInputSchema = z
  .object({ ids: z.array(z.string().min(1).max(200)).max(20_000), state: recordStateSchema })
  .strict();
export const recordLinkInputSchema = z.object({ to: z.string().min(1).max(200) }).strict();
export const recordImportSchema = z
  .object({
    marks: z.string().max(20_000),
    ids: z.array(z.string().min(1).max(200)).max(20_000),
  })
  .strict();

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
export const partInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    grp: optionalText(100),
    roleFrom: optionalText(500),
    roleTo: optionalText(500),
    chapter: optionalText(100),
    mapping: z.array(partMappingSchema).max(500).optional(),
    seenAt: recordDateSchema.nullable().optional(),
  })
  .strict();
export type PartInput = z.infer<typeof partInputSchema>;
export const partPatchSchema = partInputSchema.partial().strict();
export type PartPatch = z.infer<typeof partPatchSchema>;

export const milestoneInputSchema = z
  .object({ label: z.string().trim().min(1).max(200), date: recordDateSchema })
  .strict();
export type MilestoneInput = z.infer<typeof milestoneInputSchema>;
