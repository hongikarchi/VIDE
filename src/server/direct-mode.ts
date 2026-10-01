// Direct mode (ADR-022, user decision 2026-09-30 '바로 적용'): in Auto the AI's `execute` runs in the
// document the user attached, one host undo record per call; Plan reads, measures, captures and ends
// with a plan card. This module holds the host-neutral turn loop for Rhino (ZWCAD runs its own loop
// in zwcad-sdk-execution.ts), the execution records the request result and ledger keep, and the plan
// card parser. Execution (execution.ts) chooses the path and settles the request state.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { executionLimits } from '../contracts/execution-limits.ts';
import type { RequestInput, RequestMode } from '../contracts/workspace.ts';
import { queryPage, type QueryPageOptions } from './query-page.ts';
import { activityLog } from './activity.ts';
import {
  visionHandlers,
  type AgentTools,
  type ProjectToolHandlers,
  type VisionSource,
} from './agent-tools.ts';
import { directRefusal, type DirectRefusal } from '../contracts/direct-refusal.ts';
import type { LiveLink } from './live-links.ts';
import { ZWCAD_EXECUTE_WRAPPER } from './zwcad-sdk-execution.ts';

/** Auto-mode guard: deleting more objects than this in one execute needs the user's confirmation. */
export const DIRECT_MAX_DELETES = 50;
export const directGuardKinds = [
  'bulk-delete',
  'layer-delete',
  'purge',
  'save-as',
  'export',
  'publish',
] as const;
export type DirectGuardKind = (typeof directGuardKinds)[number];
export interface DirectCommand {
  requestId: string;
  code: string;
  label: string;
  guard: { confirmed: boolean; maxDeletes: number };
}
/** The host's 'direct-execute' answer (loose: each host lane validates its own wire shape). */
export interface DirectOutcome {
  ok: boolean;
  undoId?: string | null;
  changes?: { added: unknown[]; changed: unknown[]; removed: unknown[]; [key: string]: unknown };
  guarded?: { kind: string; detail: string; [key: string]: unknown };
  log?: string | string[];
  value?: unknown;
  code?: string;
  diagnostics?: string[] | null;
  [key: string]: unknown;
}
/** One attached document the turn writes to directly. */
export interface DirectDriver {
  host: 'rhino' | 'zwcad';
  target: { instance: string; documentId: number };
  execute(command: DirectCommand): Promise<DirectOutcome>;
  undo(undoId: string): Promise<{ ok: boolean; reason?: string; [key: string]: unknown }>;
  /** A bounded page of the document as it is now (query tool). */
  query(options: QueryPageOptions): Promise<unknown>;
  /** capture_view and measure; absent when the connection has no view methods. */
  vision?: () => Promise<VisionSource>;
  /** The document's change token right after an applied execute (kept in its record). */
  fingerprint?: () => Promise<{ documentHash: string; revision?: unknown }>;
}
/** One execute of a direct turn, as the request result (`executions[]`) and the ledger keep it. */
export interface ExecutionRecord {
  executionId: string;
  host: 'rhino' | 'zwcad';
  target: { instance: string; documentId: number };
  label: string;
  at: string;
  /** applied: in the document (undoable); undone: [되돌리기] ran; guarded: held, waiting on the card. */
  state: 'applied' | 'undone' | 'guarded' | 'confirmed';
  undoId: string | null;
  changes?: DirectOutcome['changes'];
  guarded?: { kind: string; detail: string };
  /** Kept only while guarded: [진행] re-runs this body with the guard released. */
  code?: string;
  /** The guarded execution a confirmed run released. */
  confirms?: string;
  /** The document's change token right after this execution (absent when it could not be read). */
  document?: { documentHash: string; revision?: unknown };
  /** The linked file it ran in (ADR-027: the result groups executions by file). */
  file?: { linkId?: string; name: string };
  undoneAt?: string;
}
/**
 * The host said an execute changed the document and could not be undone (a failed run or a tripped
 * guard whose revert failed): the document state is unknown, like a lost answer.
 */
export function hostLeftUnknown(outcome: DirectOutcome) {
  return !outcome.ok && (outcome.code === 'HOST_RESULT_UNKNOWN' || outcome.reverted === false);
}
/** The document's token after an applied execute, or undefined (best effort, never fails a run). */
export async function documentAfter(
  driver: DirectDriver,
  outcome: DirectOutcome,
): Promise<ExecutionRecord['document']> {
  if (typeof outcome.documentHash === 'string')
    return { documentHash: outcome.documentHash, revision: outcome.revision };
  if (!driver.fingerprint) return undefined;
  try {
    const now = await driver.fingerprint();
    return { documentHash: now.documentHash, revision: now.revision };
  } catch {
    return undefined;
  }
}
const failure = (code: string) => Object.assign(new Error(code), { code });
const LIST_LIMIT = 200;
/** What the model sees of a change set: counts and at most LIST_LIMIT rows per list. */
export function boundedChanges(changes: DirectOutcome['changes']) {
  if (!changes)
    return { added: [], changed: [], removed: [], counts: { added: 0, changed: 0, removed: 0 } };
  const counts = {
    added: changes.added.length,
    changed: changes.changed.length,
    removed: changes.removed.length,
    ...(changes.counts && typeof changes.counts === 'object' ? changes.counts : {}),
  };
  return {
    ...changes,
    added: changes.added.slice(0, LIST_LIMIT),
    changed: changes.changed.slice(0, LIST_LIMIT),
    removed: changes.removed.slice(0, LIST_LIMIT),
    counts,
  };
}
const countOf = (changes: DirectOutcome['changes'], key: 'added' | 'changed' | 'removed') => {
  const counts = changes?.counts as Record<string, unknown> | undefined;
  return typeof counts?.[key] === 'number' ? (counts[key] as number) : (changes?.[key].length ?? 0);
};
export function directLabel(body: string, attempt: number) {
  const words = body.replace(/\s+/g, ' ').trim().slice(0, 40);
  return `VIDE AI ${attempt}: ${words || '편집'}`.slice(0, 80);
}
/** The executions a request result carries (Rhino direct turns and ZWCAD's own loop). */
export function executionsOf(result: unknown): ExecutionRecord[] {
  const list = (result as { executions?: unknown } | null | undefined)?.executions;
  return Array.isArray(list)
    ? list.filter(
        (entry): entry is ExecutionRecord =>
          !!entry && typeof entry === 'object' && typeof entry.executionId === 'string',
      )
    : [];
}

// --- plan card ------------------------------------------------------------------------------------

const planSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(300),
            objects: z.array(z.string().max(200)).max(200).nullish(),
            risk: z.string().max(300).nullish(),
          })
          .passthrough(),
      )
      .min(1)
      .max(30),
    questions: z
      .array(z.union([z.string().max(300), z.record(z.string(), z.unknown())]))
      .max(3)
      .nullish(),
  })
  .passthrough();
export type PlanCard = z.infer<typeof planSchema>;
const FENCE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
/**
 * The plan of a Plan-mode turn: `structured.plan`, a top-level `plan`, the text as JSON with
 * `plan`, or the last fenced json block {"plan": …} in the text (removed from the text shown).
 * Returns the value without the plan so the strict turn-output check still sees its own fields.
 */
export function takePlan<T extends Record<string, unknown>>(
  value: T,
): { plan?: PlanCard; value: T } {
  let plan: PlanCard | undefined;
  const next: Record<string, unknown> = { ...value };
  const accept = (candidate: unknown) => {
    const parsed = planSchema.safeParse(candidate);
    if (parsed.success) plan = parsed.data;
    return parsed.success;
  };
  if (next.structured && typeof next.structured === 'object' && 'plan' in next.structured) {
    const { plan: raw, ...rest } = next.structured as Record<string, unknown>;
    accept(raw);
    next.structured = rest;
  }
  if ('plan' in next) {
    accept(next.plan);
    delete next.plan;
  }
  if (typeof next.text === 'string') {
    const text = next.text;
    try {
      const whole = JSON.parse(text);
      if (whole && typeof whole === 'object' && 'plan' in whole) {
        const { plan: raw, ...rest } = whole as Record<string, unknown>;
        accept(raw);
        next.text = JSON.stringify(rest);
        return { plan, value: next as T };
      }
    } catch {
      /* Not JSON: look for a fenced block. */
    }
    let found: { start: number; end: number } | undefined;
    for (const match of text.matchAll(FENCE)) {
      try {
        const block = JSON.parse(match[1]);
        if (block && typeof block === 'object' && 'plan' in block && accept(block.plan))
          found = { start: match.index, end: match.index + match[0].length };
      } catch {
        /* Not this block. */
      }
    }
    if (found) next.text = (text.slice(0, found.start) + text.slice(found.end)).trim();
  }
  return { plan, value: next as T };
}
export const PLAN_RULES =
  'Plan mode: read, measure and look; do not change anything and do not claim edits. End the reply with the plan as a fenced json block {"plan":{"steps":[{"title":"…","objects":["id"],"risk":"…"}],"questions":["…"]}} (1-30 steps in practical Korean; objects and risk may be left out; at most 3 questions). The user\'s [진행] carries the plan out in Auto mode in this same conversation.';
/** The request text of the Auto turn that carries a plan out ([진행]). */
export function continueBody(body: string, plan: PlanCard | undefined) {
  const steps = (plan?.steps ?? []).map(
    (step, index) =>
      `${index + 1}. ${step.title}` +
      (step.objects?.length ? ` (대상: ${step.objects.slice(0, 20).join(', ')})` : '') +
      (step.risk ? ` · 위험: ${step.risk}` : ''),
  );
  return [
    '계획대로 진행하세요.',
    '',
    '[요청]',
    body.slice(0, 8000),
    ...(steps.length ? ['', '[계획]', ...steps] : []),
  ]
    .join('\n')
    .slice(0, 20000);
}

// --- the direct turn --------------------------------------------------------------------------------

interface ContextItem {
  id: string;
  type: string;
  data: unknown;
}
interface Provider {
  run(
    context: { goal: string; revision: number; items: ContextItem[]; includedIds: string[] },
    options: {
      signal: AbortSignal;
      onProgress: (event: { state?: string; text?: string; kind?: 'thinking' | 'message' }) => void;
    },
  ): Promise<{ text: string; [key: string]: unknown }>;
}
export interface DirectTurn {
  input: RequestInput;
  mode: RequestMode;
  driver: DirectDriver;
  previous: { id: string; result: Record<string, unknown> };
  items: ContextItem[];
  signal: AbortSignal;
  tools: AgentTools;
  origin: string;
  provider: (connection: {
    url: string;
    token: string;
    tools: string[];
    targetRef: string;
  }) => Provider;
  update: (progress: Record<string, unknown>) => void;
  /** Every applied or guarded execute, as it happens (ledger). */
  onExecution?: (record: ExecutionRecord) => void;
  /** Ids the pins keep (preserve/reference) in this document. */
  protectedIds?: string[];
  /** The project read tools of the turn (SPEC-02.6, T-062), offered in Plan and Auto. */
  projectTools?: ProjectToolHandlers;
  /** The other linked files of the project the turn reads live (ADR-027); absent: target only. */
  linked?: LinkedFiles;
  /** The target document's name (its records and the result group it). */
  targetName?: string;
}
/** A document a turn works on, as its records and the request result name it. */
export interface TurnDocument {
  host: 'rhino' | 'zwcad';
  instance: string;
  documentId: number;
  linkId?: string;
  name: string;
  /**
   * In an unresolved request's `documents` (ADR-027 6): which answer was lost there. `execute`: an
   * execute's (only a fingerprint check settles it); `undo`: an undo's (a later undo that the host
   * answers settles it).
   */
  pending?: 'execute' | 'undo';
}
/** The project's other linked files as a direct turn sees them (ADR-027, SPEC-01.11 5). */
export interface LinkedFiles {
  /** The project's linked files now; a live one names its open (plugin-attached) document. */
  list(): Promise<LiveLink[]>;
  /** The driver of an open linked document; undefined when this engine cannot reach it. */
  driver(
    host: 'rhino' | 'zwcad',
    target: { instance: string; documentId: number },
  ): DirectDriver | undefined;
  /**
   * Before the first execute in a document other than the target: undefined when the request may
   * lock it, else the refusal code (DOCUMENT_LOCKED). Synchronous, so the
   * check and the lock (the next progress update) cannot interleave with another turn.
   */
  claim?(document: TurnDocument): string | undefined;
  /** The turn was cut by an intervention (SPEC-02.8): its changes stay for the next condition. */
  intervened?(): boolean;
}
/** One file's outcome of a request-level undo or an automatic rollback (ADR-027). */
export interface FileUndo {
  host: 'rhino' | 'zwcad';
  target: { instance: string; documentId: number };
  linkId?: string;
  name: string;
  /**
   * undone: every applied execute there is undone; refused: the host refused one (it and the
   * older ones there stay); unknown: an answer was lost (the document state is unknown).
   */
  state: 'undone' | 'refused' | 'unknown';
  undone: number;
  kept: number;
  reason?: string;
}
/** A request-level undo or rollback, as the request result keeps it (`undo` / `rollback`). */
export interface RequestUndo {
  at: string;
  reason?: 'failed' | 'cancelled';
  files: FileUndo[];
}
/** The refusal of a first write to a document another request holds (ADR-027 5). */
export function lockRefusal(code: string, name: string): DirectRefusal {
  return {
    code,
    final: true,
    reason: `다른 작업이 '${name}' 파일을 고치는 중이라 이 파일은 실행하지 않았습니다. 그 작업이 끝난 뒤 다시 요청하세요.`,
  };
}
/**
 * Undoes a request's applied executions, last first, each with its document's driver (ADR-027
 * 2·3). Where the host refuses one (not the latest record, closed), that file's older ones stay
 * too; other files go on. A thrown answer is a refusal when it came before the host touched the
 * document, unknown otherwise. `skip`: documents left alone (their state is unknown).
 */
export async function undoExecutions(
  records: readonly ExecutionRecord[],
  driverOf: (record: ExecutionRecord) => DirectDriver | undefined,
  { skip = new Set<string>() }: { skip?: ReadonlySet<string> } = {},
) {
  const at = new Date().toISOString();
  const files = new Map<string, FileUndo>();
  const undone = new Set<string>();
  // A record without its file (a confirmed re-run stored before it carried one) takes the name
  // another record of the same document has.
  const named = new Map<string, NonNullable<ExecutionRecord['file']>>();
  for (const record of records)
    if (record.file && record.target)
      named.set(documentKey(record.host, record.target), record.file);
  for (const record of [...records].reverse()) {
    if (record.state !== 'applied' || !record.undoId) continue;
    const key = documentKey(record.host, record.target);
    let file = files.get(key);
    if (!file) {
      const source = record.file ?? named.get(key);
      file = {
        host: record.host,
        target: record.target,
        ...(source?.linkId ? { linkId: source.linkId } : {}),
        name: source?.name ?? `${hostLabel(record.host)} 문서`,
        state: skip.has(key) ? 'unknown' : 'undone',
        undone: 0,
        kept: 0,
        ...(skip.has(key) ? { reason: 'HOST_RESULT_UNKNOWN' } : {}),
      };
      files.set(key, file);
    }
    if (file.state !== 'undone') {
      file.kept++;
      continue;
    }
    const driver = driverOf(record);
    if (!driver) {
      Object.assign(file, { state: 'refused', reason: 'EXECUTOR_NOT_READY' });
      file.kept++;
      continue;
    }
    let answer: Awaited<ReturnType<DirectDriver['undo']>>;
    try {
      answer = await driver.undo(record.undoId);
    } catch (error) {
      const refusal = directRefusal(record.host, error);
      Object.assign(
        file,
        refusal
          ? { state: 'refused', reason: refusal.code }
          : { state: 'unknown', reason: 'HOST_RESULT_UNKNOWN' },
      );
      file.kept++;
      continue;
    }
    if (answer.ok) {
      undone.add(record.executionId);
      file.undone++;
    } else {
      Object.assign(file, {
        state: 'refused',
        reason: typeof answer.reason === 'string' ? answer.reason : 'undo-failed',
      });
      file.kept++;
    }
  }
  // Files in the order the request first wrote them.
  const first = records.map((record) => documentKey(record.host, record.target));
  return {
    at,
    undone,
    files: [...files.entries()]
      .sort(([x], [y]) => first.indexOf(x) - first.indexOf(y))
      .map(([, file]) => file),
  };
}

/**
 * A request after its [되돌리기] (ADR-027 2·6): undone rows marked, the attempt kept in `undo`, and
 * what is still unknown. A lost undo answer leaves the request unknown on that document (`pending:
 * 'undo'`) and remembers the state it settles to (`settles`); a later undo the host answers there
 * settles it, and once no document is unknown the request is back in that state. A document whose
 * execute answer was lost (`pending: 'execute'`), and an unknown the request does not fully name
 * (no `heldOnly`), stay unknown: an undo cannot tell what that execute did.
 */
export function afterRequestUndo(
  now: { state: string; result?: Record<string, unknown> | null },
  outcome: { at: string; undone: ReadonlySet<string>; files: FileUndo[] },
  where: (record: ExecutionRecord) => string,
): { state: string; result: Record<string, unknown> } {
  const previous = now.result ?? {};
  const executions = executionsOf(previous).map((entry) =>
    outcome.undone.has(entry.executionId)
      ? { ...entry, state: 'undone' as const, undoneAt: outcome.at }
      : entry,
  );
  const result: Record<string, unknown> = {
    ...previous,
    executions,
    ...(outcome.files.length ? { undo: { at: outcome.at, files: outcome.files } } : {}),
  };
  const lost: TurnDocument[] = outcome.files
    .filter((file) => file.state === 'unknown')
    .map((file) => ({
      host: file.host,
      ...file.target,
      ...(file.linkId ? { linkId: file.linkId } : {}),
      name: file.name,
      pending: 'undo',
    }));
  if (now.state !== 'unknown') {
    if (!lost.length) return { state: now.state, result };
    return {
      state: 'unknown',
      result: {
        ...result,
        code: 'HOST_RESULT_UNKNOWN',
        documents: lost,
        // Every other document is known: only these stay held.
        heldOnly: true,
        settles: {
          state: now.state,
          ...(typeof previous.code === 'string' ? { code: previous.code } : {}),
          ...(Array.isArray(previous.documents) ? { documents: previous.documents } : {}),
        },
      },
    };
  }
  const keyOf = (doc: { host: string; instance: string; documentId: number }) =>
    documentKey(doc.host, doc);
  // The host answered about that document's records now: its state is known again.
  const answered = new Set(
    outcome.files
      .filter(
        (file) =>
          file.state === 'undone' || (file.state === 'refused' && file.reason === 'not-latest'),
      )
      .map((file) => documentKey(file.host, file.target)),
  );
  const applied = new Set(
    executions.filter((entry) => entry.state === 'applied' && entry.undoId).map(where),
  );
  const held = new Map<string, TurnDocument>();
  for (const doc of (Array.isArray(previous.documents)
    ? previous.documents
    : []) as TurnDocument[]) {
    const key = keyOf(doc);
    if (doc.pending === 'undo' && (answered.has(key) || !applied.has(key))) continue;
    held.set(key, doc);
  }
  for (const doc of lost) if (!held.has(keyOf(doc))) held.set(keyOf(doc), doc);
  const settles = previous.settles as
    | { state?: unknown; code?: unknown; documents?: unknown }
    | undefined;
  if (!held.size && previous.heldOnly === true && typeof settles?.state === 'string') {
    const {
      code: _code,
      documents: _documents,
      heldOnly: _heldOnly,
      settles: _settles,
      ...rest
    } = result;
    return {
      state: settles.state,
      result: {
        ...rest,
        ...(typeof settles.code === 'string' ? { code: settles.code } : {}),
        ...(Array.isArray(settles.documents) ? { documents: settles.documents } : {}),
      },
    };
  }
  const still: Record<string, unknown> = {
    ...result,
    code: 'HOST_RESULT_UNKNOWN',
    documents: [...held.values()],
  };
  if (!held.size) delete still.heldOnly;
  return { state: 'unknown', result: still };
}
/**
 * The turn context item about earlier unresolved results on the turn's documents (SPEC-02.13 7,
 * T-102), or undefined when there are none. The turn still runs: it reads the document first and
 * does not repeat that work blindly.
 */
export function unresolvedNote(
  rows: readonly { id: string; input: { body?: unknown }; result?: unknown }[],
): ContextItem | undefined {
  if (!rows.length) return;
  const nameOf = (result: unknown) => {
    const source = (result as { sourceDocument?: { name?: unknown } } | null | undefined)
      ?.sourceDocument;
    return typeof source?.name === 'string' ? source.name : undefined;
  };
  return {
    id: 'unresolved-results',
    type: 'note',
    data: {
      note: 'The host answer of these earlier requests was lost (their result is unconfirmed): the document may or may not hold their changes. Read the document (query) before acting, do not repeat that work blindly, and say in your reply what you found.',
      requests: rows.slice(-5).map((row) => ({
        requestId: row.id,
        request: typeof row.input.body === 'string' ? row.input.body.slice(0, 300) : '',
        ...(nameOf(row.result) ? { document: nameOf(row.result) } : {}),
      })),
    },
  };
}
/** One document of a request (its host, window and document id). */
export const documentKey = (host: string, target: { instance: string; documentId: number }) =>
  JSON.stringify([host, target.instance, target.documentId]);
const hostLabel = (host: 'rhino' | 'zwcad') => (host === 'rhino' ? 'Rhino' : 'ZWCAD');
/**
 * The linked-files lines of a turn goal: which file the turn starts in, which are live, which
 * closed. Every open file is the AI's to read and (Auto) edit; it picks the files (T-103).
 */
function linkedFilesNote(links: LiveLink[], targetKey: string, eyes: boolean, mode: RequestMode) {
  if (!links.length) return '';
  const rows = links.slice(0, 30).map((link) => {
    const state =
      link.open && documentKey(link.host, link.open) === targetKey
        ? 'starting document (the default when linkId is left out)'
        : link.open
          ? link.host === 'rhino' && eyes
            ? 'open: read it live with query, measure and capture_view and its linkId'
            : link.host === 'rhino'
              ? 'open: read it live with query and its linkId'
              : `open: read it live with query and its linkId${eyes ? ' (no capture_view or measure)' : ''}`
          : 'closed: stored Sync only (links_layers, sync_sample)';
    return `- ${link.id} · ${link.name} (${hostLabel(link.host)}) · ${state}`;
  });
  // A drawing open in ZWCAD takes ZWCAD's own wrapper, not RhinoCommon (ADR-027 4).
  const drawing = links
    .slice(0, 30)
    .some(
      (link) =>
        link.host === 'zwcad' && link.open && documentKey(link.host, link.open) !== targetKey,
    );
  return `
Linked files of this project (linkId · name · state):
${rows.join('\n')}
Every open linked file is yours to work on${mode === 'auto' ? ' (read and edit)' : ' (read)'}: decide from the request, its pins and what you read which file or files it is about and pass their linkId. The user does not choose a target file; the starting document is only the default for calls without linkId, not a limit. Each file keeps its own units and coordinates (query returns units); do not assume a shared origin unless the request or the pins establish one. A file answering LINK_NOT_LIVE is not open now: read it from its stored Sync.${
    mode === 'auto'
      ? `
execute with an open file's linkId edits that file directly, one undo record there per execute, with the same guard as the starting document and in that file's own host API. This request is one unit across files: the user's [되돌리기] undoes all of it, and if the request fails or is stopped after it tried to change two or more files, VIDE undoes every change of this request in every file. A file another task is writing answers DOCUMENT_LOCKED: nothing ran there; leave it and tell the user.${
          drawing
            ? `
execute with a ZWCAD file's linkId takes a C# method body for ZWCAD, not RhinoCommon (there is no RhinoDoc doc). ${ZWCAD_EXECUTE_WRAPPER} Identity there is the entity handle (query rows carry it); units are the drawing's own (usually millimetres), so convert from this document's units explicitly.`
            : ''
        }`
      : ''
  }`;
}

function rhinoGoal(turn: DirectTurn, targetRef: string, linkedNote = '') {
  const { input, mode } = turn;
  const limits = executionLimits(input);
  const kept = turn.protectedIds?.length
    ? ` Preserved/reference objects (never change): ${turn.protectedIds.slice(0, 100).join(', ')}.`
    : '';
  return `Target is the document open in the user's Rhino 8 (${targetRef}). It is NOT a copy.
${
  mode === 'auto'
    ? `Auto mode: every execute runs directly in that document as ONE undo record; the user can revert it with Rhino Ctrl+Z or VIDE [되돌리기]. Deleting more than ${DIRECT_MAX_DELETES} objects, deleting layers or purging is held back until the user confirms: such an execute returns ok:false with "guarded" and nothing stays applied. Then stop and say what needs confirmation; never split the work to stay under the limit.`
    : `${PLAN_RULES} There is no execute in this mode.`
}
Units are the document's own model units (query returns "units"); sketches and other hosts' geometry are metres, convert explicitly.
Use query (pages, objectIds) to observe native IDs, layers and bounds${
    // Only a connection with view methods has the eyes (driver.vision).
    turn.driver.vision
      ? '; capture_view to see the model and measure for exact sizes and distances'
      : ''
  }.${
    mode === 'auto'
      ? `
execute takes a C# method body. The wrapper imports System, System.Linq, Rhino, Rhino.Geometry and supplies RhinoDoc doc and StringBuilder output (its lines come back as log). Do not declare a class or method. Never save, open or export documents, run Rhino commands, show UI, or use files, processes, network or reflection. Return a small JSON-serializable value (at most 16 KiB) to observe results; never Rhino objects. Each successful execute returns undoId and the added/changed/removed objects.
Keep existing IDs, layers and attributes unless the request changes them; modify objects in place (ModifyAttributes, Replace) rather than delete and redraw.${kept} Work in few, complete executes and check the result with query${turn.driver.vision ? ' or capture_view' : ''}. Compile diagnostics allow correction; after an uncertain result never execute again.`
      : kept
  }
When a dimension is missing but a standard or conventional value exists, use it and state the assumption; ask only when no reasonable value exists.
${linkedNote}
Limits: ${limits.maxToolCalls} tool calls, ${limits.maxHostCommands} executes, ${limits.timeoutSeconds} seconds. Stop at the limit and report remaining work.
Reply in Korean with what actually changed in the document${mode === 'auto' ? ' (and that Ctrl+Z or [되돌리기] reverts it)' : ''}.
User request: ${input.body || '첨부한 설계 문맥을 검토해 주세요.'}`;
}

/**
 * One AI turn on an attached Rhino document. Auto: `execute` → the host's direct-execute, each call
 * one undo record, recorded as an ExecutionRecord and returned to the model with its changes; a
 * guarded call is recorded with its body (the confirmation re-runs it). Plan: read tools only.
 */
export async function runDirectTurn(turn: DirectTurn) {
  const { input, mode, driver, previous, items, signal } = turn;
  /** Set once the turn has settled: a late tool answer then changes nothing of the request. */
  let ended = false;
  const update = (progress: Record<string, unknown>) => {
    if (!ended) turn.update(progress);
  };
  const limits = executionLimits(input);
  const hostName = driver.host === 'rhino' ? 'Rhino' : 'ZWCAD';
  const targetRef = `${driver.host}-open:${driver.target.instance}`;
  const activity = activityLog();
  const executions: ExecutionRecord[] = [];
  let attempts = 0,
    queries = 0,
    applied = 0,
    uncertain = false;
  let guarded: ExecutionRecord | undefined;
  // The last refusal before execution (the result card shows it); a final one (read-only document,
  // lost connection) answers every later execute of this turn without calling the host.
  let refused: (DirectRefusal & { file?: string }) | undefined;
  /** The document the last refusal was about (a later answer from it clears it). */
  let refusedKey: string | undefined;
  const progress = () => ({ queries, attempts, completed: applied });
  // The documents of the turn (ADR-027): the target and every other linked file it resolved.
  interface TurnDoc {
    key: string;
    driver: DirectDriver;
    file: { linkId?: string; name: string };
    vision?: ReturnType<typeof visionHandlers>;
    /** The last refusal before execution here; a final one answers later executes at once. */
    refused?: DirectRefusal;
    /** Locked for this request (another file, on its first execute). */
    claimed?: boolean;
    /** An execute answer was lost here: the document state is unknown. */
    lost?: boolean;
  }
  let links: LiveLink[] = turn.linked ? await turn.linked.list().catch(() => []) : [];
  const primaryKey = documentKey(driver.host, driver.target);
  const primaryLink = links.find(
    (link) => link.open && documentKey(link.host, link.open) === primaryKey,
  );
  const primary: TurnDoc = {
    key: primaryKey,
    driver,
    file: {
      ...(primaryLink ? { linkId: primaryLink.id } : {}),
      name: turn.targetName ?? primaryLink?.name ?? `${hostName} 문서`,
    },
  };
  const docs = new Map<string, TurnDoc>([[primaryKey, primary]]);
  /** The document a tool call names: the target, or an open linked file (LINK_NOT_LIVE else). */
  const resolve = async (linkId: unknown): Promise<TurnDoc> => {
    if (linkId === undefined || linkId === primary.file.linkId) return primary;
    if (typeof linkId !== 'string' || !turn.linked) throw failure('LINK_NOT_LIVE');
    let link = links.find((entry) => entry.id === linkId);
    // Opened or closed since the turn began: read the links once more.
    if (!link?.open) {
      links = await turn.linked.list().catch(() => links);
      link = links.find((entry) => entry.id === linkId);
    }
    if (!link) throw failure('NOT_FOUND');
    if (!link.open) throw failure('LINK_NOT_LIVE');
    const key = documentKey(link.host, link.open);
    const known = docs.get(key);
    if (known) return known;
    const linked = turn.linked.driver(link.host, link.open);
    if (!linked) throw failure('LINK_NOT_LIVE');
    const doc: TurnDoc = { key, driver: linked, file: { linkId: link.id, name: link.name } };
    docs.set(key, doc);
    return doc;
  };
  /** Activity text naming the file when it is not the target. */
  const named = (doc: TurnDoc, text: string) =>
    doc === primary ? text : `${doc.file.name} · ${text}`;
  /**
   * The documents this turn tried to execute in, refused or not (two or more: a multi-file
   * request, ADR-027 6, SPEC-02.13 6).
   */
  const attempted = new Set<string>();
  /** The document whose execute has not answered yet (at most one: `uncertain` holds the rest). */
  let inflight: TurnDoc | undefined;
  const multiFile = () => attempted.size > 1;
  /** Other documents the turn locked as it first wrote them (the request result keeps them). */
  const documents: TurnDocument[] = [];
  const turnDocument = (doc: TurnDoc): TurnDocument => ({
    host: doc.driver.host,
    instance: doc.driver.target.instance,
    documentId: doc.driver.target.documentId,
    ...(doc.file.linkId ? { linkId: doc.file.linkId } : {}),
    name: doc.file.name,
  });
  let rollback: RequestUndo | undefined;
  const state = (phase: string) => ({
    phase,
    host: driver.host,
    hostExecuted: false,
    appliedDirectly: applied > 0,
    mode,
    progress: progress(),
    activity: activity.entries,
    executions: executions.map(publicRecord),
    ...(documents.length ? { documents } : {}),
    ...(multiFile() ? { multiFile: true } : {}),
    ...(rollback ? { rollback } : {}),
    // The last refusal before execution (a failed or stopped request keeps it too).
    ...(refused
      ? {
          refused: {
            code: refused.code,
            reason: refused.reason,
            ...(refused.file ? { file: refused.file } : {}),
          },
        }
      : {}),
  });
  type Handler = (args: Record<string, unknown>, context?: { signal: AbortSignal }) => unknown;
  const handlers: Record<string, Handler> = {
    // The project's records beside the open document (T-062); the document's own tools follow.
    ...(turn.projectTools as Record<string, Handler>),
    query: async ({ targetRef: _target, linkId, ...args }) => {
      const doc = await resolve(linkId);
      const page = await doc.driver.query(args as QueryPageOptions);
      queries++;
      activity.add('query', named(doc, `문서 조회 ${queries}회차`));
      update(state('query'));
      return page;
    },
  };
  const eyes = (doc: TurnDoc, source: VisionSource) =>
    visionHandlers(source, (tool) =>
      activity.add(
        'query',
        named(doc, tool === 'capture_view' ? '모델 화면 보기' : '모델 치수 재기'),
      ),
    );
  // Only a connection with view methods has the eyes; another file's open on first use.
  if (driver.vision) {
    primary.vision = eyes(primary, await driver.vision());
    for (const tool of ['capture_view', 'measure'] as const)
      handlers[tool] = async (args, context) => {
        const doc = await resolve(args.linkId);
        if (!doc.driver.vision) throw failure('NO_VIEW');
        doc.vision ??= eyes(doc, await doc.driver.vision());
        return (doc.vision[tool] as Handler)(args, context ?? { signal });
      };
  }
  /**
   * A refused execute: recorded once, answered to the AI as not run (with whether to retry). A
   * final refusal holds only for that document (another file of the turn may still be written).
   */
  const notExecuted = (doc: TurnDoc, refusal: DirectRefusal, fresh = false) => {
    if (fresh) {
      doc.refused = refusal;
      refused = { ...refusal, ...(doc === primary ? {} : { file: doc.file.name }) };
      refusedKey = doc.key;
      activity.add('result', named(doc, `실행하지 않음 · ${refusal.reason}`), refusal.code);
      update(state('model'));
    }
    const where = doc === primary ? 'the document' : doc.file.name;
    return {
      ok: false,
      executed: false,
      code: refusal.code,
      reason: refusal.reason,
      next: !refusal.final
        ? `Nothing ran and ${where} is unchanged. Retry once only if the cause has likely passed; otherwise stop and tell the user the reason.`
        : doc === primary
          ? 'Nothing ran and the document is unchanged. No execute can succeed in this turn: stop executing and tell the user the reason and the next step in Korean.'
          : `Nothing ran and ${where} is unchanged. No execute in that file can succeed in this turn: leave it and tell the user the reason and the next step in Korean.`,
    };
  };
  if (mode === 'auto')
    handlers.execute = async ({ code, linkId }) => {
      if (typeof code !== 'string') throw failure('INVALID_INPUT');
      if (signal.aborted) throw failure('CANCELLED');
      if (uncertain) throw failure('HOST_RESULT_UNKNOWN');
      const doc = await resolve(linkId);
      if (doc.refused?.final) return notExecuted(doc, doc.refused);
      if (attempts >= limits.maxHostCommands) throw failure('HOST_COMMAND_LIMIT');
      attempted.add(doc.key);
      // Another file is locked as the turn first writes it; held elsewhere, it is refused at once
      // (never waits, so two turns cannot wait on each other's files).
      if (doc !== primary && !doc.claimed) {
        const held = turn.linked?.claim?.(turnDocument(doc));
        if (held) return notExecuted(doc, lockRefusal(held, doc.file.name), true);
        doc.claimed = true;
        documents.push(turnDocument(doc));
        update(state('host'));
      }
      attempts++;
      const executionId = randomUUID();
      const label = directLabel(input.body, attempts);
      activity.add(
        'execute',
        named(doc, `${hostLabel(doc.driver.host)} 문서에 바로 실행 ${attempts}회차`),
        code,
      );
      update(state('host'));
      // A lost answer leaves the document state unknown: no further execute in this turn.
      uncertain = true;
      inflight = doc;
      let outcome: DirectOutcome | undefined;
      let thrown: unknown;
      try {
        outcome = await doc.driver.execute({
          requestId: executionId,
          code,
          label,
          guard: { confirmed: input.guardConfirmed === true, maxDeletes: DIRECT_MAX_DELETES },
        });
      } catch (error) {
        thrown = error;
      } finally {
        inflight = undefined;
      }
      // The turn ended (stopped, timed out) before this answer: the request already reports the
      // document unknown, and a late answer is neither recorded nor applied to its state.
      if (ended) return { ok: false, executed: false, code: 'AGENT_SCOPE_EXPIRED' };
      if (!outcome) {
        // Refused before it touched the document (read-only, busy, closed): nothing ran.
        const refusal = directRefusal(doc.driver.host, thrown);
        if (!refusal) {
          doc.lost = true;
          throw thrown;
        }
        uncertain = false;
        return notExecuted(doc, refusal, true);
      }
      // A change the host could not revert: as unknown as a lost answer (stays uncertain).
      if (hostLeftUnknown(outcome)) {
        doc.lost = true;
        activity.add(
          'error',
          named(doc, '실행 결과를 되돌리지 못함 · 문서 상태 확인 필요'),
          outcome.code,
        );
        throw failure('HOST_RESULT_UNKNOWN');
      }
      uncertain = false;
      // The host answered this one: an earlier passing refusal (busy) no longer describes it.
      doc.refused = undefined;
      if (refusedKey === doc.key) refused = undefined;
      const record = {
        executionId,
        host: doc.driver.host,
        target: doc.driver.target,
        file: doc.file,
        label,
        at: new Date().toISOString(),
      };
      if (!outcome.ok && outcome.guarded) {
        guarded = {
          ...record,
          state: 'guarded',
          undoId: null,
          guarded: { kind: outcome.guarded.kind, detail: outcome.guarded.detail },
          code,
        };
        executions.push(guarded);
        turn.onExecution?.(guarded);
        activity.add('error', named(doc, `확인 필요 · ${outcome.guarded.detail} · 되돌려 둠`));
        update(state('host'));
        return {
          ok: false,
          guarded: guarded.guarded,
          reverted: true,
          next: 'Nothing stays applied. Stop here and tell the user what needs confirmation; the card re-runs this execute after they confirm.',
        };
      }
      const refusal = !outcome.ok && !outcome.guarded && directRefusal(doc.driver.host, outcome);
      if (refusal) return notExecuted(doc, refusal, true);
      if (!outcome.ok) {
        activity.add(
          'error',
          named(doc, '실행 거절 · AI가 수정해 다시 시도'),
          (outcome.diagnostics ?? []).join('\n') || outcome.code,
        );
        update(state('model'));
        return outcome;
      }
      const changes = boundedChanges(outcome.changes);
      if (outcome.undoId) {
        applied++;
        const document = await documentAfter(doc.driver, outcome);
        const entry: ExecutionRecord = {
          ...record,
          state: 'applied',
          undoId: outcome.undoId,
          changes: outcome.changes,
          ...(document ? { document } : {}),
        };
        executions.push(entry);
        turn.onExecution?.(entry);
        activity.add(
          'result',
          named(
            doc,
            `문서에 반영 · 추가 ${countOf(outcome.changes, 'added')} · 수정 ${countOf(outcome.changes, 'changed')} · 삭제 ${countOf(outcome.changes, 'removed')} · 되돌리기 1단계`,
          ),
        );
      } else activity.add('result', named(doc, '실행 성공 · 바뀐 객체 없음'));
      update(state('host'));
      return {
        ok: true,
        executionId,
        undoId: outcome.undoId ?? null,
        changes,
        log: outcome.log,
        ...(outcome.value !== undefined &&
        Buffer.byteLength(JSON.stringify(outcome.value ?? null)) <= 16384
          ? { value: outcome.value }
          : outcome.value !== undefined
            ? { valueOmitted: true }
            : {}),
      };
    };
  /**
   * All or nothing (ADR-027 3): a multi-file request that ends failed or stopped undoes what it
   * applied, in every file, last first. A document whose execute answer was lost is left alone.
   */
  const rollBack = async (reason: 'failed' | 'cancelled') => {
    const lost = new Set([...docs.values()].filter((doc) => doc.lost).map((doc) => doc.key));
    const outcome = await undoExecutions(
      executions,
      (record) => docs.get(documentKey(record.host, record.target))?.driver,
      { skip: lost },
    );
    for (const entry of executions)
      if (outcome.undone.has(entry.executionId)) {
        entry.state = 'undone';
        entry.undoneAt = outcome.at;
        turn.onExecution?.(entry);
      }
    // A file whose execute answer was lost needs attention even with nothing applied there.
    for (const doc of docs.values())
      if (
        doc.lost &&
        !outcome.files.some((file) => documentKey(file.host, file.target) === doc.key)
      )
        outcome.files.push({
          host: doc.driver.host,
          target: doc.driver.target,
          ...doc.file,
          state: 'unknown',
          undone: 0,
          kept: 0,
          reason: 'HOST_RESULT_UNKNOWN',
        });
    rollback = { at: outcome.at, reason, files: outcome.files };
    const left = outcome.files.filter((file) => file.state !== 'undone');
    activity.add(
      left.length ? 'error' : 'result',
      left.length
        ? `실패해서 자동으로 되돌림 · 되돌리지 못한 파일 ${left.map((file) => file.name).join(', ')}`
        : `실패해서 자동으로 되돌림 · 파일 ${outcome.files.length}개`,
    );
  };
  const scope = turn.tools.issue({
    targetRef,
    handlers: handlers as Parameters<AgentTools['issue']>[0]['handlers'],
    isCurrent: () => !signal.aborted && !uncertain,
    maxCalls: limits.maxToolCalls,
    ttlMs: Math.min(600000, (limits.timeoutSeconds + 60) * 1000),
    links: true,
  });
  try {
    activity.add('host', `열린 ${hostName} 문서에 연결 · ${mode === 'auto' ? '자동' : '계획'}`);
    update(state('model'));
    const response = await turn
      .provider({
        url: new URL('/mcp', turn.origin).href,
        targetRef,
        token: scope.token,
        tools: Object.keys(handlers),
      })
      .run(
        {
          goal: rhinoGoal(
            turn,
            targetRef,
            linkedFilesNote(links, primaryKey, !!driver.vision, mode),
          ),
          revision: 1,
          items,
          includedIds: items.map((i) => i.id),
        },
        {
          signal,
          onProgress: (event) => {
            if (event.text) activity.add(event.kind ?? 'message', event.text);
            if (!uncertain) update(state(applied ? 'host' : 'model'));
          },
        },
      );
    if (uncertain) throw failure('HOST_RESULT_UNKNOWN');
    if (signal.aborted && !applied) throw failure('CANCELLED');
    // A stopped multi-file request is not left half done (an intervention keeps its changes).
    if (signal.aborted && multiFile() && !turn.linked?.intervened?.()) throw failure('CANCELLED');
    ended = true;
    return {
      ...response,
      ...state('done'),
      phase: undefined,
      executionMode: 'direct',
      ...(guarded ? { guarded: { executionId: guarded.executionId, ...guarded.guarded! } } : {}),
      baseRequestId: previous.id,
      sourceDocument: previous.result.sourceDocument,
      // Kept for [진행]: the guarded body (never shown; dropped once confirmed).
      executions: executions.map((entry) =>
        entry.state === 'guarded' ? entry : publicRecord(entry),
      ),
    };
  } catch (error) {
    ended = true;
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    // The provider gave up (stop, timeout) while an execute had not answered: that document's state
    // is unknown, so it is not rolled back around and stays held (ADR-027 6). A one-file turn
    // keeps reporting it as before (the request's own target holds it).
    if (inflight && (inflight !== primary || multiFile())) inflight.lost = true;
    // A stop (the signal, whatever the provider's code: CANCELLED, STOP_UNCONFIRMED) is a
    // cancellation; an intervention keeps the changes for the next condition (SPEC-02.8).
    if (
      multiFile() &&
      executions.some((entry) => entry.state === 'applied' && entry.undoId) &&
      !(signal.aborted && turn.linked?.intervened?.())
    )
      await rollBack(signal.aborted ? 'cancelled' : 'failed');
    // Only a lost execute (or undo) answer leaves a document unknown; applied records are known
    // (and undoable), so a failing provider keeps them with the failure.
    const attention = new Map<string, TurnDocument>();
    for (const doc of docs.values())
      if (doc.lost) attention.set(doc.key, { ...turnDocument(doc), pending: 'execute' });
    for (const file of rollback?.files ?? [])
      if (file.state === 'unknown' && !attention.has(documentKey(file.host, file.target)))
        attention.set(documentKey(file.host, file.target), {
          host: file.host,
          ...file.target,
          ...(file.linkId ? { linkId: file.linkId } : {}),
          name: file.name,
          pending: 'undo',
        });
    // A multi-file request names every document whose state is unknown, so while unresolved it
    // holds only those (`heldOnly`): a fully rolled-back target is free again. Otherwise (one
    // file, or an uncertainty no document explains) its target stays held as well.
    const heldOnly =
      multiFile() &&
      attention.size > 0 &&
      (!uncertain || [...docs.values()].some((doc) => doc.lost));
    if (uncertain || attention.size)
      throw Object.assign(failure('HOST_RESULT_UNKNOWN'), {
        intent: {
          ...state('host'),
          baseRequestId: previous.id,
          documents: [...attention.values()],
          ...(heldOnly ? { heldOnly: true } : {}),
          // What the request settles to once its unknown files are undone ([되돌리기]).
          ...(heldOnly && rollback
            ? {
                settles: {
                  state: rollback.reason === 'cancelled' ? 'cancelled' : 'failed',
                  ...(code ? { code } : {}),
                },
              }
            : {}),
        },
        cause: error,
      });
    if (executions.length && error && typeof error === 'object')
      Object.assign(error, { partial: { ...state('done'), phase: undefined } });
    throw error;
  } finally {
    scope.revoke();
  }
}
export function publicRecord({ code: _code, ...entry }: ExecutionRecord) {
  return entry;
}

/** Rhino query pages from the attached document, read once per document revision of this turn. */
export function displayQuery(read: () => Promise<Record<string, unknown>>) {
  let cached: { model: Record<string, unknown>; revision: number } | undefined;
  let revision = 0;
  return {
    /** After an execute the next query reads the document again. */
    invalidate() {
      revision++;
      cached = undefined;
    },
    async page(options: QueryPageOptions) {
      if (!cached || cached.revision !== revision) cached = { model: await read(), revision };
      const units = typeof cached.model.units === 'string' ? cached.model.units : undefined;
      return queryPage({ revision, units, model: cached.model }, options, revision);
    },
  };
}
