import { z } from 'zod';

/**
 * Conversation records shared through the account site (ADR-037 4, SPEC-04.12, PLAN-36). The PC
 * that ran a request is its origin; the site keeps a text copy that every project member reads on
 * the site and in their own VIDE. One request is one document: the request text, the full answer,
 * the activity lines, the executed code and the linked file names. Never the model geometry,
 * attachments' contents or pin coordinates.
 *
 * Only requests without a host document are shared (user adjustment 2026-10-06, "모델링 대화는
 * 서버에 안 올림"): see `shareableRequest`. Modeling requests keep the PC-off history summary
 * (ADR-035) only.
 */

/** A D1 row stays far below its 2 MB limit: a document is stored in chunks of this many chars. */
export const MIRROR_CHUNK_CHARS = 100_000;
/** The list preview of a request's text (the full text is in its document). */
export const MIRROR_PREVIEW_CHARS = 300;

const activitySchema = z.object({
  at: z.string().max(40),
  kind: z.string().max(20),
  text: z.string(),
  detail: z.string().optional(),
});
const executionSchema = z.object({
  label: z.string(),
  state: z.string().max(20),
  at: z.string().max(40).nullable(),
  file: z.string().nullable(),
  language: z.string().max(20).nullable(),
  code: z.string().nullable(),
});
/** One shared request's text: exactly these fields (anything else is dropped). */
export const mirrorDocSchema = z.object({
  body: z.string(),
  answer: z.string().nullable(),
  activity: z.array(activitySchema),
  executions: z.array(executionSchema),
  files: z.array(z.string()),
});
export type MirrorDoc = z.infer<typeof mirrorDocSchema>;
export type MirrorActivity = z.infer<typeof activitySchema>;
export type MirrorExecution = z.infer<typeof executionSchema>;

export const mirrorConversationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  title: z.string().max(500),
  kind: z.string().max(40),
  provider: z.string().max(40).nullable(),
  model: z.string().max(120).nullable(),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
});
export type MirrorConversationMeta = z.infer<typeof mirrorConversationSchema>;
export const mirrorRequestMetaSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  conversationId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  state: z.string().regex(/^[a-z-]{1,30}$/),
  createdAt: z.string().max(40),
  endedAt: z.string().max(40).nullable(),
  revision: z.number().int().nonnegative(),
});
/** One request as the PC uploads it: its metadata and its document as JSON text. */
export const mirrorUploadSchema = mirrorRequestMetaSchema.extend({ doc: z.string() });

/** Who ran it: the account and the PC (the reader's view). */
export interface MirrorOrigin {
  originHost: string;
  originName: string;
  originPc: string | null;
}
export type MirroredConversation = MirrorConversationMeta &
  MirrorOrigin & { requests: number; lastAt: string | null };
export type MirroredRequest = z.infer<typeof mirrorRequestMetaSchema> & MirrorDoc;
export interface MirroredThread {
  conversation: MirroredConversation;
  requests: MirroredRequest[];
}

/** The id the default conversation (no `conversationId` on the PC) has on the site. */
export const DEFAULT_CONVERSATION = 'default';

/** Splits `text` into pieces of at most `size` characters (an empty text is one empty piece). */
export function chunkText(text: string, size = MIRROR_CHUNK_CHARS): string[] {
  if (!text) return [''];
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    // Never split a surrogate pair: the piece ends one character earlier.
    let end = Math.min(text.length, at + size);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && end - 1 > at && code >= 0xd800 && code <= 0xdbff) end--;
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts;
}

interface ShareInput {
  host?: unknown;
  hostUse?: unknown;
  source?: unknown;
  sourceDocument?: unknown;
  linkId?: unknown;
  baseRequestId?: unknown;
  linkedTargets?: unknown;
  applyToSource?: unknown;
  jig?: unknown;
  provider?: unknown;
  parentRequestId?: unknown;
}
/**
 * Whether a request's text goes to the site: only a request without a host document (user
 * adjustment 2026-10-06). It declares `hostUse: 'none'` (a hostless turn: a general question,
 * 할 일 from text and files, 자료, notes, a jig-make turn), names no linked file, Sync basis,
 * source document or target, runs no jig or extension, and its result ran no code in a document.
 * Everything else is a modeling request and stays on the PC.
 */
export function shareableRequest(input: ShareInput | null | undefined, result: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  if (input.hostUse !== 'none') return false;
  if (input.source === 'document' || input.source === 'file') return false;
  if (input.provider === 'extension' || input.jig !== undefined) return false;
  if (input.parentRequestId !== undefined && input.parentRequestId !== null) return false;
  if (
    input.sourceDocument !== undefined ||
    (input.linkId !== undefined && input.linkId !== null) ||
    (input.baseRequestId !== undefined && input.baseRequestId !== null) ||
    input.linkedTargets !== undefined ||
    input.applyToSource === true
  )
    return false;
  const value = (result ?? {}) as {
    executions?: unknown;
    sourceDocument?: unknown;
    baseRequestId?: unknown;
    hostExecuted?: unknown;
  };
  if (Array.isArray(value.executions) && value.executions.length) return false;
  if (value.sourceDocument || value.baseRequestId || value.hostExecuted === true) return false;
  return true;
}

const STATE_LABEL: Record<string, string> = {
  succeeded: '완료',
  failed: '실패',
  cancelled: '취소',
  interrupted: '중단',
  running: '진행 중',
  queued: '대기',
  'needs-confirmation': '확인 대기',
  'needs-input': '답 대기',
};
export const mirrorStateLabel = (state: string) => STATE_LABEL[state] ?? state;

const fence = (text: string) => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
};
/**
 * The Markdown copy of one conversation that the AI reads on a member's PC
 * (`projects/<id>/history/*.md`): every request in order with its answer, activity and code.
 */
export function mirrorMarkdown(thread: MirroredThread): string {
  const { conversation, requests } = thread;
  const lines = [
    `# ${conversation.title || '대화'}`,
    '',
    `<!-- VIDE 공유 대화 기록 · ${conversation.originName}${conversation.originPc ? ` · ${conversation.originPc}` : ''} · id ${conversation.id} · 원본은 그 작업을 돌린 PC, 사본은 계정 사이트 -->`,
    '',
  ];
  for (const request of requests) {
    lines.push(
      `## ${request.createdAt.slice(0, 16).replace('T', ' ')} · ${mirrorStateLabel(request.state)}`,
      '',
    );
    if (request.files.length) lines.push(`파일: ${request.files.join(', ')}`, '');
    lines.push('### 요청', '', request.body.trim() || '(글 없는 요청)', '');
    if (request.answer?.trim()) lines.push('### 답', '', request.answer.trim(), '');
    if (request.activity.length) {
      lines.push('### 활동', '');
      for (const entry of request.activity) {
        lines.push(`- ${entry.at.slice(11, 19)} [${entry.kind}] ${entry.text.replace(/\n/g, ' ')}`);
        if (entry.detail) {
          const mark = fence(entry.detail);
          lines.push('', mark, entry.detail, mark, '');
        }
      }
      lines.push('');
    }
    for (const execution of request.executions) {
      lines.push(
        `### 실행 · ${execution.label}${execution.file ? ` · ${execution.file}` : ''} · ${execution.state}`,
        '',
      );
      if (execution.code) {
        const mark = fence(execution.code);
        lines.push(mark + (execution.language ?? ''), execution.code, mark, '');
      }
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}
