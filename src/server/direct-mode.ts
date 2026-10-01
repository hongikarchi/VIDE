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
}
const documentKey = (host: string, target: { instance: string; documentId: number }) =>
  JSON.stringify([host, target.instance, target.documentId]);
const hostLabel = (host: 'rhino' | 'zwcad') => (host === 'rhino' ? 'Rhino' : 'ZWCAD');
/** The linked-files lines of a turn goal: which file is the target, which are live, which closed. */
function linkedFilesNote(links: LiveLink[], targetKey: string, eyes: boolean) {
  if (!links.length) return '';
  const rows = links.slice(0, 30).map((link) => {
    const state =
      link.open && documentKey(link.host, link.open) === targetKey
        ? 'the target (this document; linkId may be left out)'
        : link.open
          ? link.host === 'rhino' && eyes
            ? 'open: read it live with query, measure and capture_view and its linkId'
            : link.host === 'rhino'
              ? 'open: read it live with query and its linkId'
              : `open: read it live with query and its linkId${eyes ? ' (no capture_view or measure)' : ''}`
          : 'closed: stored Sync only (links_layers, sync_sample)';
    return `- ${link.id} · ${link.name} (${hostLabel(link.host)}) · ${state}`;
  });
  return `
Linked files of this project (linkId · name · state):
${rows.join('\n')}
Each file keeps its own units and coordinates (query returns units); do not assume a shared origin unless the request or the pins establish one. A file answering LINK_NOT_LIVE is not open now: read it from its stored Sync.`;
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
  const { input, mode, driver, previous, items, signal, update } = turn;
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
  let refused: DirectRefusal | undefined;
  const progress = () => ({ queries, attempts, completed: applied });
  // The documents of the turn (ADR-027): the target and every other linked file it resolved.
  interface TurnDoc {
    key: string;
    driver: DirectDriver;
    file: { linkId?: string; name: string };
    vision?: ReturnType<typeof visionHandlers>;
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
  const state = (phase: string) => ({
    phase,
    host: driver.host,
    hostExecuted: false,
    appliedDirectly: applied > 0,
    mode,
    progress: progress(),
    activity: activity.entries,
    executions: executions.map(publicRecord),
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
  /** A refused execute: recorded once, answered to the AI as not run (with whether to retry). */
  const notExecuted = (refusal: DirectRefusal, fresh = false) => {
    if (fresh) {
      refused = refusal;
      activity.add('result', `실행하지 않음 · ${refusal.reason}`, refusal.code);
      update(state('model'));
    }
    return {
      ok: false,
      executed: false,
      code: refusal.code,
      reason: refusal.reason,
      next: refusal.final
        ? 'Nothing ran and the document is unchanged. No execute can succeed in this turn: stop executing and tell the user the reason and the next step in Korean.'
        : 'Nothing ran and the document is unchanged. Retry once only if the cause has likely passed; otherwise stop and tell the user the reason.',
    };
  };
  if (mode === 'auto')
    handlers.execute = async ({ code, linkId }) => {
      if (typeof code !== 'string') throw failure('INVALID_INPUT');
      if (signal.aborted) throw failure('CANCELLED');
      // Editing other linked files follows (T-090); reading them is live already.
      if ((await resolve(linkId)) !== primary) throw failure('LINK_NOT_LIVE');
      if (uncertain) throw failure('HOST_RESULT_UNKNOWN');
      if (refused?.final) return notExecuted(refused);
      if (attempts >= limits.maxHostCommands) throw failure('HOST_COMMAND_LIMIT');
      attempts++;
      const executionId = randomUUID();
      const label = directLabel(input.body, attempts);
      activity.add('execute', `${hostName} 문서에 바로 실행 ${attempts}회차`, code);
      update(state('host'));
      // A lost answer leaves the document state unknown: no further execute in this turn.
      uncertain = true;
      let outcome: DirectOutcome;
      try {
        outcome = await driver.execute({
          requestId: executionId,
          code,
          label,
          guard: { confirmed: input.guardConfirmed === true, maxDeletes: DIRECT_MAX_DELETES },
        });
      } catch (error) {
        // Refused before it touched the document (read-only, busy, closed): nothing ran.
        const refusal = directRefusal(driver.host, error);
        if (!refusal) throw error;
        uncertain = false;
        return notExecuted(refusal, true);
      }
      // A change the host could not revert: as unknown as a lost answer (stays uncertain).
      if (hostLeftUnknown(outcome)) {
        activity.add('error', '실행 결과를 되돌리지 못함 · 문서 상태 확인 필요', outcome.code);
        throw failure('HOST_RESULT_UNKNOWN');
      }
      uncertain = false;
      // The host answered this one: an earlier passing refusal (busy) no longer describes the turn.
      refused = undefined;
      const record = {
        executionId,
        host: driver.host,
        target: driver.target,
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
        activity.add('error', `확인 필요 · ${outcome.guarded.detail} · 되돌려 둠`);
        update(state('host'));
        return {
          ok: false,
          guarded: guarded.guarded,
          reverted: true,
          next: 'Nothing stays applied. Stop here and tell the user what needs confirmation; the card re-runs this execute after they confirm.',
        };
      }
      const refusal = !outcome.ok && !outcome.guarded && directRefusal(driver.host, outcome);
      if (refusal) return notExecuted(refusal, true);
      if (!outcome.ok) {
        activity.add(
          'error',
          '실행 거절 · AI가 수정해 다시 시도',
          (outcome.diagnostics ?? []).join('\n') || outcome.code,
        );
        update(state('model'));
        return outcome;
      }
      const changes = boundedChanges(outcome.changes);
      if (outcome.undoId) {
        applied++;
        const document = await documentAfter(driver, outcome);
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
          `문서에 반영 · 추가 ${countOf(outcome.changes, 'added')} · 수정 ${countOf(outcome.changes, 'changed')} · 삭제 ${countOf(outcome.changes, 'removed')} · 되돌리기 1단계`,
        );
      } else activity.add('result', '실행 성공 · 바뀐 객체 없음');
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
          goal: rhinoGoal(turn, targetRef, linkedFilesNote(links, primaryKey, !!driver.vision)),
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
    return {
      ...response,
      ...state('done'),
      phase: undefined,
      executionMode: 'direct',
      ...(guarded ? { guarded: { executionId: guarded.executionId, ...guarded.guarded! } } : {}),
      ...(refused ? { refused: { code: refused.code, reason: refused.reason } } : {}),
      baseRequestId: previous.id,
      sourceDocument: previous.result.sourceDocument,
      // Kept for [진행]: the guarded body (never shown; dropped once confirmed).
      executions: executions.map((entry) =>
        entry.state === 'guarded' ? entry : publicRecord(entry),
      ),
    };
  } catch (error) {
    // Only a lost execute answer leaves the document unknown; applied records are known (and
    // undoable), so a failing provider keeps them with the failure.
    if (uncertain)
      throw Object.assign(failure('HOST_RESULT_UNKNOWN'), {
        intent: { ...state('host'), baseRequestId: previous.id },
        cause: error,
      });
    if (executions.length && error && typeof error === 'object')
      Object.assign(error, { partial: { ...state('done'), phase: undefined } });
    throw error;
  } finally {
    scope.revoke();
  }
}
/** A record without the guarded body (what progress updates and the ledger carry). */
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
