import type { WaitingFor } from '../contracts/request-scope.ts';

/** What a waiting request (or a running turn's execute) waits for and its place in line (SPEC-02.9 3·4). */
export function waitingText(waiting: WaitingFor): string {
  // One turn at a time in a conversation (SPEC-02.19 1): the server holds the next message.
  if ((waiting.kind as string) === 'conversation')
    return `이 대화의 앞 메시지가 끝나기를 기다리는 중 · 대기 ${waiting.position}번째`;
  // A running turn's execute behind another conversation's on the same file (SPEC-02.9 3).
  if (waiting.kind === 'execute')
    return `${waiting.title ? `«${waiting.title}» 대화가` : '다른 대화가'} 이 파일을 고치는 중 · 대기`;
  if (waiting.kind === 'project')
    return `AI 작업 ${waiting.limit ?? 3}개 진행 중 · 대기 ${waiting.position}번째`;
  const cad = waiting.host === 'zwcad';
  return waiting.key.startsWith('host:')
    ? `대상 문서를 알 수 없어 ${cad ? 'ZWCAD' : 'Rhino'}의 다른 쓰기 작업을 기다리는 중 · 대기 ${waiting.position}`
    : `다른 작업이 이 ${cad ? '도면' : '모델'}을 쓰는 중 · 대기 ${waiting.position}`;
}

/** A running turn's execute waiting behind another conversation's (`result.executeWait`). */
export function executeWaitOf(result: unknown): WaitingFor | undefined {
  const value = (result as { executeWait?: unknown } | null | undefined)?.executeWait;
  return value &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'execute' &&
    'key' in value &&
    typeof value.key === 'string'
    ? (value as WaitingFor)
    : undefined;
}
/**
 * A held (guarded) execution row offers [진행] only while its request waits on that confirmation
 * (SPEC-02.13 4). A request that ended without it (failed, interrupted, stopped, restarted) shows
 * the row as not run instead.
 */
export const guardOpen = (executionState: string, requestState: string | undefined) =>
  executionState === 'guarded' && requestState === 'needs-confirmation';
export function heldRowLabel(executionState: string, requestState: string | undefined) {
  if (executionState !== 'guarded') return undefined;
  return requestState === 'needs-confirmation' ||
    requestState === 'queued' ||
    requestState === 'running'
    ? undefined
    : '진행하지 않음 (요청 종료)';
}
