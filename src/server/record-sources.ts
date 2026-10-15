import { DomainError } from '../contracts/errors.ts';
import type { PartRow } from '../contracts/records.ts';
import {
  candidateFromCheckout,
  candidateFromJigRun,
  candidateFromParamChange,
  candidateFromRequest,
  candidateFromSchemaConfirm,
  decisionSentences,
  ledgerDecisionText,
  localDateTime,
  paragraphCandidates,
  type RecordCandidate,
  type RequestRowLike,
} from '../core/record-candidates.ts';
import { AI_AUTHOR, type Records } from '../core/records.ts';

/**
 * 자동 후보의 진입점 (SPEC-17.3 1, PLAN-53 T-322, ARCH-01 §5 「프로젝트 기록」): the engine's
 * existing hooks call these functions; each only queues its work (`setImmediate`) and returns, so
 * a request, a note copy or a jig run never waits on a record. Failures go to the diagnostics log
 * (`record-candidate-failed`) only; a candidate already made from the same source
 * (RECORD_SOURCE_DUPLICATE) is skipped quietly — that refusal is the de-duplication.
 */

export interface LedgerItemLike {
  id: string;
  kind: string;
  body: unknown;
  requestId: string | null;
}
export interface CheckoutRowLike {
  id: string;
  role: string;
  serverPath: string;
  checkedOutAt: string;
  releasedAt: string | null;
}
export interface RecordSourcesOptions {
  records: Pick<Records, 'add' | 'list' | 'parts' | 'bySourceKey'>;
  /** The conversation ledger (decision items of the finished request). */
  conversations?: {
    ledger(conversationId: string, options: { current?: boolean }): LedgerItemLike[];
  };
  /** The project's checkouts (a K candidate for a fresh one). */
  checkouts?: {
    get(projectId: string, id: string): CheckoutRowLike | null;
    list(projectId: string): CheckoutRowLike[];
  };
  /** Role names for a folder role candidate (ROLE_LABELS). */
  roleLabels?: Record<string, string>;
  log: (event: string, fields: Record<string, unknown>) => void;
  now?: () => Date;
  /** Test seam; default `setImmediate`. */
  defer?: (task: () => void) => void;
}
export interface NoteLike {
  id: string;
  kind: string;
  journalDate?: string | null;
  updatedAt?: number;
  deleted?: boolean;
}
export interface JigRunEventLike {
  projectId: string;
  instanceId: string;
  jigId: string;
  title: string;
  mode: string;
  status: string;
  outputs?: Record<string, unknown>;
}
export interface JigParamsEventLike {
  projectId: string;
  instanceId: string;
  jigId: string;
  title: string;
  by: string;
  reason?: string | null;
  requestId?: string | null;
  entries: readonly { seq: number; key: string; old: unknown; new: unknown; at: string }[];
}
export interface RecordSources {
  /** `Execution.onFinished`: the request's candidate and its conversation's decision sentences. */
  requestFinished(row: RequestRowLike & { projectId: string }): void;
  /** `SharedNotes.onCopy`: a note, journal or meeting note copy (paragraphs, `?`). */
  noteCopied(projectId: string, note: NoteLike, markdown: string): void;
  /** `agendaRoutes.dayEnded`: [퇴근하기] text into today's journal. */
  dayEnded(projectId: string, entry: { date: string; text: string }): void;
  /** `RuntimeOptions.onRun`: a confirmed 법규 체크·구조 검토 run (E). */
  jigRun(event: JigRunEventLike): void;
  /** `RuntimeOptions.onParamsChanged`: a jig's settings changed (D per setting). */
  paramsChanged(event: JigParamsEventLike): void;
  /** `CheckoutOptions.onChange`: a fresh checkout (K). */
  checkoutsChanged(projectId: string): void;
  /** `CheckoutOptions.log`: `workspace-publish` is a 서버에 반영 (K). */
  checkoutLog(event: string, fields: Record<string, unknown>): void;
  /** After `confirmWorkspaceSchema`: the folder roles a person confirmed (K). */
  schemaConfirmed(projectId: string, confirmed: { confirmedAt: string; paths: object }): void;
  /** Resolves when the queued work has run (tests, shutdown). */
  idle(): Promise<void>;
  /** Shutdown: queued work that has not started is dropped; nothing is queued after this. */
  stop(): void;
}

/** A checkout taken within this window becomes a candidate (older ones are not back-filled). */
const FRESH_CHECKOUT_MS = 10 * 60_000;
/** A note copy whose last edit is older than this is a refresh, not new writing. */
const FRESH_NOTE_MS = 24 * 60 * 60_000;

export function attachRecordSources(options: RecordSourcesOptions): RecordSources {
  const { records } = options;
  const now = options.now ?? (() => new Date());
  const defer = options.defer ?? ((task: () => void) => void setImmediate(task));
  const pending = new Set<Promise<void>>();
  // After the engine closes its store, a queued hook must not touch the DB or the diagnostics log
  // (a candidate it would have made is lost; the request itself is unaffected).
  let stopped = false;
  const log = (event: string, fields: Record<string, unknown>) => {
    try {
      options.log(event, fields);
    } catch {
      /* the diagnostics log never fails a hook */
    }
  };
  const failed = (where: string, error: unknown) =>
    log('record-candidate-failed', {
      where,
      code:
        error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'ERROR',
    });
  /** Queues one hook's work; the hook itself returns at once and never throws. */
  const later = (where: string, work: () => void) => {
    if (stopped) return;
    try {
      const done = new Promise<void>((resolve) =>
        defer(() => {
          try {
            if (!stopped) work();
          } catch (error) {
            failed(where, error);
          } finally {
            resolve();
          }
        }),
      );
      pending.add(done);
      void done.then(() => pending.delete(done));
    } catch (error) {
      failed(where, error);
    }
  };
  /** Puts one candidate in; false when it was already there. */
  const put = (projectId: string, candidate: RecordCandidate, parts: string[] = []): boolean => {
    try {
      records.add(
        projectId,
        {
          date: candidate.date,
          time: candidate.time,
          type: candidate.type,
          text: candidate.text,
          attachments: candidate.attachments,
          ...(parts.length ? { parts } : {}),
        },
        {
          by: AI_AUTHOR,
          state: 'candidate',
          source: candidate.source,
          sourceKey: candidate.sourceKey,
        },
      );
      return true;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'RECORD_SOURCE_DUPLICATE') return false;
      failed(candidate.source, error);
      return false;
    }
  };
  const partsOf = (projectId: string): PartRow[] => {
    try {
      return records.parts(projectId);
    } catch {
      return [];
    }
  };
  /** Parts mapped to the changed objects (by id, or by their layer in the request's result). */
  const objectParts = (
    projectId: string,
    objects: readonly string[],
    result: Record<string, unknown> | null,
  ): string[] => {
    if (!objects.length) return [];
    const parts = partsOf(projectId);
    if (!parts.length) return [];
    const changed = new Set(objects);
    const layers = new Set<string>();
    if (result && Array.isArray(result.objects))
      for (const object of result.objects as Record<string, unknown>[]) {
        if (!object || typeof object.id !== 'string' || !changed.has(object.id)) continue;
        for (const field of ['layer', 'layerName'])
          if (typeof object[field] === 'string') layers.add(object[field] as string);
      }
    return parts
      .filter((part) =>
        part.mapping.some((mapping) =>
          mapping.kind === 'objects'
            ? mapping.ids.some((id) => changed.has(id))
            : mapping.kind === 'layer'
              ? layers.has(mapping.layer)
              : false,
        ),
      )
      .map((part) => part.id);
  };
  const jigParts = (projectId: string, instanceId: string) =>
    partsOf(projectId)
      .filter((part) =>
        part.mapping.some(
          (mapping) => mapping.kind === 'jig-output' && mapping.instanceId === instanceId,
        ),
      )
      .map((part) => part.id);
  const known = (projectId: string) => (sourceKey: string) => {
    try {
      return records.bySourceKey(projectId, sourceKey) !== null;
    } catch {
      return false;
    }
  };
  const paragraphsOn = (projectId: string, date: string) =>
    records.list(projectId, {
      source: ['note', 'journal', 'meeting'],
      from: date,
      to: date,
      limit: 1,
    }).total;

  return {
    requestFinished(row) {
      later('request', () => {
        if (!row || !row.projectId) return;
        const projectId = row.projectId;
        const candidate = candidateFromRequest(row);
        if (!candidate) return;
        // Sync rows: not wired yet. Document Sync is saved by import-model/workspace.submit and
        // never reaches Execution.onFinished, so this branch only runs from tests until a later
        // PLAN-53 ticket wires it with a flood rule (SPEC-17.3 1 row 5, ARCH-01 §5).
        const sync = candidate.source === 'sync';
        const body = typeof row.input.body === 'string' ? row.input.body : '';
        const conversationId =
          typeof row.input.conversationId === 'string'
            ? row.input.conversationId
            : typeof row.conversationId === 'string'
              ? row.conversationId
              : null;
        const said = sync ? [] : decisionSentences(body, []);
        // The whole request is one decision sentence: the request's own candidate is that D.
        const whole =
          said.length === 1 && said[0] === body.replace(/\s+/g, ' ').trim() ? said[0] : null;
        if (whole) candidate.type = 'D';
        put(
          projectId,
          candidate,
          objectParts(projectId, candidate.attachments.objects ?? [], row.result),
        );
        if (sync) return;
        const chat = conversationId ?? 'default';
        const when = { date: candidate.date, time: candidate.time };
        if (said.length && !whole)
          put(projectId, {
            type: 'D',
            source: 'chat',
            text: said.join(' '),
            ...when,
            sourceKey: `chat:${chat}:${row.id}`,
            attachments: { requestId: row.id },
          });
        if (!conversationId || !options.conversations) return;
        let ledger: LedgerItemLike[] = [];
        try {
          ledger = options.conversations
            .ledger(conversationId, { current: true })
            .filter((item) => item.kind === 'decision' && item.requestId === row.id);
        } catch (error) {
          failed('chat', error);
        }
        for (const item of ledger) {
          const text = ledgerDecisionText(item.body);
          if (!text) continue;
          put(projectId, {
            type: 'D',
            source: 'chat',
            text,
            ...when,
            sourceKey: `chat:${conversationId}:${item.id}`,
            attachments: { requestId: row.id },
          });
        }
      });
    },
    noteCopied(projectId, note, markdown) {
      later('note', () => {
        if (note.deleted) return;
        const at = now();
        if (typeof note.updatedAt === 'number' && at.getTime() - note.updatedAt > FRESH_NOTE_MS)
          return;
        const journal = note.kind === 'journal';
        const date = (journal && note.journalDate) || localDateTime(at)!.date;
        const source = journal ? 'journal' : note.kind === 'discussion' ? 'meeting' : 'note';
        const candidates = paragraphCandidates(markdown, {
          source,
          date,
          noteId: note.id,
          kind: note.kind,
          dailyCount: paragraphsOn(projectId, date),
          known: known(projectId),
        });
        for (const candidate of candidates) put(projectId, candidate);
      });
    },
    dayEnded(projectId, entry) {
      later('journal', () => {
        // The same paragraph the journal copy will carry: one key for both ways in.
        const candidates = paragraphCandidates(`퇴근 기록 · ${entry.text}`, {
          source: 'journal',
          date: entry.date,
          dailyCount: paragraphsOn(projectId, entry.date),
          known: known(projectId),
        });
        for (const candidate of candidates) put(projectId, candidate);
      });
    },
    jigRun(event) {
      later('jig-result', () => {
        const candidate = candidateFromJigRun({ ...event, runAt: now().toISOString() });
        if (candidate) put(event.projectId, candidate, jigParts(event.projectId, event.instanceId));
      });
    },
    paramsChanged(event) {
      later('jig-param', () => {
        // Defaults filled in are not anyone's decision.
        if (event.by === 'default') return;
        const parts = jigParts(event.projectId, event.instanceId);
        for (const entry of event.entries) {
          const candidate = candidateFromParamChange({
            instanceId: event.instanceId,
            seq: entry.seq,
            key: entry.key,
            old: entry.old,
            new: entry.new,
            by: event.by,
            reason: event.reason ?? null,
            at: entry.at,
            jigTitle: event.title,
            requestId: event.requestId ?? null,
          });
          if (candidate) put(event.projectId, candidate, parts);
        }
      });
    },
    checkoutsChanged(projectId) {
      later('checkout', () => {
        if (!options.checkouts) return;
        const since = now().getTime() - FRESH_CHECKOUT_MS;
        for (const row of options.checkouts.list(projectId)) {
          if (Date.parse(row.checkedOutAt) < since) continue;
          const candidate = candidateFromCheckout({
            checkoutId: row.id,
            role: row.role,
            serverPath: row.serverPath,
            at: row.checkedOutAt,
          });
          if (candidate) put(projectId, candidate);
        }
      });
    },
    checkoutLog(event, fields) {
      if (event !== 'workspace-publish') return;
      later('release', () => {
        const projectId = typeof fields.projectId === 'string' ? fields.projectId : '';
        const checkoutId = typeof fields.checkoutId === 'string' ? fields.checkoutId : '';
        if (!projectId || !checkoutId || !options.checkouts) return;
        const row = options.checkouts.get(projectId, checkoutId);
        if (!row) return;
        const candidate = candidateFromCheckout({
          checkoutId,
          role: row.role,
          serverPath: row.serverPath,
          released: true,
          at: row.releasedAt ?? now().toISOString(),
        });
        if (candidate) put(projectId, candidate);
      });
    },
    schemaConfirmed(projectId, confirmed) {
      later('schema', () => {
        const candidate = candidateFromSchemaConfirm({
          confirmedAt: confirmed.confirmedAt,
          paths: confirmed.paths as Record<string, string | null | undefined>,
          ...(options.roleLabels ? { labels: options.roleLabels } : {}),
        });
        if (candidate) put(projectId, candidate);
      });
    },
    async idle() {
      while (pending.size) await Promise.all([...pending]);
    },
    stop() {
      stopped = true;
    },
  };
}
