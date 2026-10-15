import { createHash } from 'node:crypto';
import {
  RECORD_TEXT_MAX,
  type RecordAttachments,
  type RecordSource,
} from '../contracts/records.ts';

/**
 * 자동 후보의 규칙 (SPEC-17.3 1, PLAN-53 T-322, ARCH-01 §5 「프로젝트 기록」): what VIDE activity
 * becomes a `candidate` record. Pure — no database, no server; `src/server/record-sources.ts`
 * takes the hooks and puts the results in asynchronously. The same input always gives the same
 * `sourceKey`, so a second call is refused as RECORD_SOURCE_DUPLICATE (no double candidate).
 */

export type CandidateType = 'R' | 'I' | 'K' | 'E' | 'D' | '?';
export interface RecordCandidate {
  type: CandidateType;
  source: RecordSource;
  text: string;
  date: string;
  time: string | null;
  sourceKey: string;
  attachments: RecordAttachments;
}

/** The candidates' daily cap of note·journal paragraphs (SPEC-17.3 1). */
export const PARAGRAPHS_PER_DAY = 30;
/** Paragraphs shorter than this (after markup) are not candidates. */
export const PARAGRAPH_MIN = 8;

const pad = (value: number) => String(value).padStart(2, '0');
/** The PC's local date and time of an ISO instant (records are dated in local time). */
export function localDateTime(iso: string | Date): { date: string; time: string } | null {
  const at = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
}
const clip = (text: string) => text.slice(0, RECORD_TEXT_MAX);
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
/** The first 8 hex of the paragraph's SHA-256 (whitespace folded), its key in `note:`/`journal:`. */
export function paragraphHash(text: string) {
  return createHash('sha256').update(oneLine(text), 'utf8').digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------------------------
// Request finished (SPEC-02.13)

export interface RequestRowLike {
  id: string;
  input: { body?: unknown; source?: unknown; conversationId?: unknown; [key: string]: unknown };
  state?: string;
  result: Record<string, unknown> | null;
  createdAt: string;
  conversationId?: string | null;
}

const idOf = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
      ? (value as { id: string }).id
      : null;
/** The ids a `ModelChanges`-like value names (added, modified, removed). */
function changedIds(changes: unknown): string[] {
  if (!changes || typeof changes !== 'object') return [];
  const ids: string[] = [];
  for (const field of ['added', 'modified', 'removed'] as const) {
    const list = (changes as Record<string, unknown>)[field];
    if (Array.isArray(list))
      for (const item of list) {
        const id = idOf(item);
        if (id) ids.push(id);
      }
  }
  return ids;
}
/** Objects a request changed: `result.changes` and each execution's `changes` (not undone ones'). */
export function requestChangedObjects(result: Record<string, unknown> | null): string[] {
  if (!result) return [];
  const ids = changedIds(result.changes);
  const executions = result.executions;
  if (Array.isArray(executions))
    for (const execution of executions)
      if (execution && typeof execution === 'object')
        ids.push(...changedIds((execution as { changes?: unknown }).changes));
  return [...new Set(ids)];
}

/**
 * A finished request → D (it changed objects) or E (it only read or reviewed); a document Sync row
 * (`input.source === 'document'`) → K from source 'sync'. Failed, cancelled or still running
 * requests and requests without text give none.
 */
export function candidateFromRequest(row: RequestRowLike): RecordCandidate | null {
  if (row.state !== undefined && row.state !== 'succeeded') return null;
  const result = row.result;
  if (result && typeof result.applicationState === 'string') {
    if (['failed', 'cancelled', 'interrupted'].includes(result.applicationState)) return null;
  }
  const text = typeof row.input.body === 'string' ? oneLine(row.input.body) : '';
  if (!text) return null;
  const when = localDateTime(row.createdAt);
  if (!when) return null;
  const sync = row.input.source === 'document';
  const objects = requestChangedObjects(result);
  return {
    type: sync ? 'K' : objects.length ? 'D' : 'E',
    source: sync ? 'sync' : 'request',
    text: clip(text),
    date: when.date,
    time: when.time,
    sourceKey: `${sync ? 'sync' : 'request'}:${row.id}`,
    attachments: {
      requestId: row.id,
      ...(objects.length && !sync ? { objects: objects.slice(0, 500) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Decision sentences in a conversation

/** Words that say a matter was settled (the user's own sentence). */
const DECIDED =
  /결정|확정|(?:으?로|걸로|것으로)\s*(?:가자|갑시다|가요|간다|하자|합시다|하기로|해요|한다|정(?:하|했|함|합|해|한|할))/;
/** Words that say it was not (yet): open, pending, conditional or asked. */
const UNDECIDED = [
  /[?？]/,
  /(?:갈|할|될|정할|둘)까/,
  /결정\s*(?:을|이|은)?\s*(?:못|안\s|안$|하지|되지|해야|할지|하면|하기\s*전|전에|전|보류|미뤄|미루)/,
  /확정\s*(?:을|이|은)?\s*(?:못|안\s|안$|아직|하지|되지|해야|할지|하면|전에|전|보류|미뤄|미루|안\s*됐|안됐)/,
  /아직[^.!]*(?:결정|확정)|(?:결정|확정)[^.!]*아직/,
  /미정|보류|미결/,
  /(?:결정|확정)(?:은|이)?\s*(?:나중|다음)/,
];
const sentencesOf = (text: string) =>
  text
    .split(/\n+|(?<=[.!?。？！])\s+/)
    .map((sentence) => oneLine(sentence))
    .filter(Boolean);
/** Whether one sentence of the user's states a decision (rule based, SPEC-17.3 1). */
export function isDecisionSentence(sentence: string) {
  const line = oneLine(sentence);
  if (!DECIDED.test(line)) return false;
  return !UNDECIDED.some((rule) => rule.test(line));
}
/** The text of a ledger `decision` item: a string, or a text-like field of an object. */
export function ledgerDecisionText(body: unknown): string | null {
  if (typeof body === 'string') return oneLine(body) || null;
  if (body && typeof body === 'object' && !Array.isArray(body))
    for (const field of ['text', 'decision', 'summary', 'title', 'body']) {
      const value = (body as Record<string, unknown>)[field];
      if (typeof value === 'string' && oneLine(value)) return oneLine(value);
    }
  return null;
}
/**
 * D candidate sentences of a turn: the user's sentences with decision words ("결정", "확정",
 * "…로 가자/하자/하기로", "…으로 정하") that are not open or asked ("결정 못 했어", "확정은 아직",
 * "…로 갈까?"), then the ledger's `decision` items (already decisions; their text only).
 */
export function decisionSentences(userText: string, ledgerDecisions: readonly unknown[] = []) {
  const found: string[] = [];
  for (const sentence of sentencesOf(userText ?? ''))
    if (isDecisionSentence(sentence)) found.push(clip(sentence));
  for (const body of ledgerDecisions) {
    const text = ledgerDecisionText(body);
    if (text) found.push(clip(text));
  }
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------------------------
// Notes, journals, meeting notes (SPEC-10)

export interface ParagraphOptions {
  source: 'note' | 'journal' | 'meeting';
  date: string;
  /** The note's id (`note:<noteId>:<hash>`); a journal is keyed by its date. */
  noteId?: string;
  /** The note's kind for attachments (default: journal for a journal, else note). */
  kind?: string;
  /** Paragraph candidates already made that day (the cap counts them). */
  dailyCount: number;
  /** Keys already stored: skipped before the cap so they do not use it up. */
  known?: (sourceKey: string) => boolean;
  /** Default PARAGRAPHS_PER_DAY. */
  perDay?: number;
}
const LIST_MARK = /^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/;
const plain = (line: string) =>
  oneLine(
    line
      .replace(LIST_MARK, '')
      .replace(/[*_`~]{1,3}/g, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'),
  );
/** The paragraph units of a note: plain paragraphs, and each list item or table row on its own. */
export function noteParagraphs(markdown: string): string[] {
  const units: string[] = [];
  let open: string[] = [];
  const close = () => {
    if (open.length) units.push(oneLine(open.join(' ')));
    open = [];
  };
  let fenced = false;
  const body = (markdown ?? '').replace(/<!--[\s\S]*?-->/g, '\n');
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      close();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!line) {
      close();
      continue;
    }
    if (/^#{1,6}\s/.test(line) || /^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      close();
      continue;
    }
    if (line.startsWith('|')) {
      close();
      // The separator row of a table is markup only.
      if (/^\|?[\s:|-]+\|?$/.test(line)) continue;
      const cells = line
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => plain(cell))
        .filter(Boolean);
      if (cells.length) units.push(cells.join(' · '));
      continue;
    }
    if (LIST_MARK.test(line)) {
      close();
      units.push(plain(line));
      continue;
    }
    open.push(plain(line));
  }
  close();
  return units.filter(Boolean);
}
/**
 * Note·journal·meeting paragraphs → type '?' candidates (the person picks R/I/K/E/D while sorting).
 * Headings, blank lines, table separators and paragraphs under PARAGRAPH_MIN characters are left
 * out; at most `perDay - dailyCount` new ones come back.
 */
export function paragraphCandidates(
  markdown: string,
  options: ParagraphOptions,
): RecordCandidate[] {
  const left = Math.max(
    0,
    (options.perDay ?? PARAGRAPHS_PER_DAY) - Math.max(0, options.dailyCount),
  );
  if (!left) return [];
  const journal = options.source === 'journal';
  if (!journal && !options.noteId) return [];
  const kind = options.kind ?? (journal ? 'journal' : 'note');
  const out: RecordCandidate[] = [];
  const seen = new Set<string>();
  const units = noteParagraphs(markdown);
  for (let index = 0; index < units.length && out.length < left; index++) {
    const text = units[index];
    if ([...text].length < PARAGRAPH_MIN) continue;
    const hash = paragraphHash(text);
    const sourceKey = journal
      ? `journal:${options.date}:${hash}`
      : `note:${options.noteId}:${hash}`;
    if (seen.has(sourceKey) || options.known?.(sourceKey)) continue;
    seen.add(sourceKey);
    out.push({
      type: '?',
      source: options.source,
      text: clip(text),
      date: options.date,
      time: null,
      sourceKey,
      attachments: {
        note: { id: options.noteId ?? `journal-${options.date}`, kind, paragraph: index },
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Jigs (SPEC-07.6 설정값 이력, SPEC-15·SPEC-06 확정 결과)

const valueText = (value: unknown): string => {
  if (value === null || value === undefined) return '없음';
  if (typeof value === 'object' && !Array.isArray(value) && 'value' in value)
    return valueText((value as { value: unknown }).value);
  if (typeof value === 'string') return value || '없음';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
export interface ParamChangeLike {
  instanceId: string;
  seq: number;
  key: string;
  old: unknown;
  new: unknown;
  by?: string | null;
  reason?: string | null;
  at: string;
  jigTitle: string;
  requestId?: string | null;
}
/** One setting change of a jig → D `<jigTitle> <key>: <old> → <new>(<reason>)`. */
export function candidateFromParamChange(change: ParamChangeLike): RecordCandidate | null {
  const when = localDateTime(change.at);
  if (!when) return null;
  const reason = change.reason ? oneLine(change.reason) : '';
  const text = `${oneLine(change.jigTitle)} ${change.key}: ${valueText(change.old)} → ${valueText(change.new)}${reason ? `(${reason})` : ''}`;
  return {
    type: 'D',
    source: 'jig',
    text: clip(text),
    date: when.date,
    time: when.time,
    sourceKey: `jig-param:${change.instanceId}:${change.seq}`,
    attachments: {
      jig: { instanceId: change.instanceId, seq: change.seq },
      ...(change.requestId ? { requestId: change.requestId } : {}),
    },
  };
}

/** The 법규 체크·구조 검토 jigs whose confirmed results are evidence (E). */
export function isReviewJig(jigId: string) {
  return /^vide\/(?:compliance-check|structure(?:-[a-z0-9-]+)?)$/.test(jigId);
}
export interface JigRunLike {
  instanceId: string;
  jigId: string;
  title: string;
  mode: string;
  status: string;
  outputs?: Record<string, unknown>;
  runAt: string;
}
/** A one-line summary an output offers (`summary` of an output object, or a string output). */
function outputSummary(outputs: Record<string, unknown> | undefined): string | null {
  if (!outputs) return null;
  for (const value of Object.values(outputs)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const summary = (value as { summary?: unknown }).summary;
      if (typeof summary === 'string' && oneLine(summary)) return oneLine(summary).slice(0, 300);
    }
  }
  return null;
}
/** A confirmed run of a 법규 체크·구조 검토 jig → E (other jigs and modes give none). */
export function candidateFromJigRun(event: JigRunLike): RecordCandidate | null {
  if (event.mode !== 'confirmed' || !isReviewJig(event.jigId)) return null;
  if (event.status !== 'computed') return null;
  const when = localDateTime(event.runAt);
  if (!when) return null;
  const summary = outputSummary(event.outputs);
  return {
    type: 'E',
    source: 'jig',
    text: clip(`${oneLine(event.title)} 확정 결과${summary ? `: ${summary}` : ''}`),
    date: when.date,
    time: when.time,
    sourceKey: `jig-result:${event.instanceId}:${event.runAt}`,
    attachments: { jig: { instanceId: event.instanceId, runAt: event.runAt } },
  };
}

// ---------------------------------------------------------------------------------------------
// Work folder: checkout, 서버에 반영, folder roles (SPEC-01.13 8~9)

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
export interface CheckoutLike {
  checkoutId: string;
  role?: string;
  serverPath: string;
  /** A 서버에 반영 (the `release:` key) rather than the checkout itself. */
  released?: boolean;
  at: string;
}
/** A checkout or a 서버에 반영 → K (which file was taken, which version went up). */
export function candidateFromCheckout(event: CheckoutLike): RecordCandidate | null {
  const when = localDateTime(event.at);
  if (!when) return null;
  const name = baseName(event.serverPath);
  return {
    type: 'K',
    source: 'checkout',
    text: clip(event.released ? `서버에 반영: ${name}` : `체크아웃: ${name}`),
    date: when.date,
    time: when.time,
    sourceKey: `${event.released ? 'release' : 'checkout'}:${event.checkoutId}`,
    attachments: { checkoutId: event.checkoutId },
  };
}
export interface SchemaConfirmLike {
  confirmedAt: string;
  paths: Record<string, string | null | undefined>;
  /** Role names shown (ROLE_LABELS); the role id when absent. */
  labels?: Record<string, string>;
}
/** The folder roles a person confirmed → K. */
export function candidateFromSchemaConfirm(event: SchemaConfirmLike): RecordCandidate | null {
  const when = localDateTime(event.confirmedAt);
  if (!when) return null;
  const parts = Object.entries(event.paths)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1])
    .map(([role, path]) => `${event.labels?.[role] ?? role}=${path}`);
  return {
    type: 'K',
    source: 'checkout',
    text: clip(`폴더 역할 확정${parts.length ? `: ${parts.join(', ')}` : ''}`),
    date: when.date,
    time: when.time,
    sourceKey: `schema:${event.confirmedAt}`,
    attachments: {},
  };
}
