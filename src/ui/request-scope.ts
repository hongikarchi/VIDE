import type { WaitingFor } from '../contracts/request-scope.ts';

/** What a waiting request waits for and its place in line (SPEC-02.9 3·4). */
export function waitingText(waiting: WaitingFor): string {
  // One turn at a time in a conversation (SPEC-02.19 1): the server holds the next message.
  if ((waiting.kind as string) === 'conversation')
    return `이 대화의 앞 메시지가 끝나기를 기다리는 중 · 대기 ${waiting.position}번째`;
  if (waiting.kind === 'project')
    return `AI 작업 ${waiting.limit ?? 3}개 진행 중 · 대기 ${waiting.position}번째`;
  const cad = waiting.host === 'zwcad';
  return waiting.key.startsWith('host:')
    ? `대상 문서를 알 수 없어 ${cad ? 'ZWCAD' : 'Rhino'}의 다른 쓰기 작업을 기다리는 중 · 대기 ${waiting.position}`
    : `다른 작업이 이 ${cad ? '도면' : '모델'}을 쓰는 중 · 대기 ${waiting.position}`;
}
