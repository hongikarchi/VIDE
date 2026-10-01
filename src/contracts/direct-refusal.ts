// Direct mode failure classes (ADR-022, user decision 2026-10-01): a `direct-execute` the host
// refused BEFORE it touched the document is "실행하지 않음" with its reason — not an unknown result.
// Only these codes count; every other failure without a host answer (lost answer, timeout, closed
// connection, unreadable reply, a run that could not be reverted) stays unknown.

export type DirectHostName = 'rhino' | 'zwcad';
export interface DirectRefusal {
  code: string;
  /** Plain Korean reason with the next step, for the user's result card and the AI. */
  reason: string;
  /** Retrying in the same turn cannot succeed (the document or connection must change first). */
  final: boolean;
}

const hostLabel = (host: DirectHostName) => (host === 'zwcad' ? 'ZWCAD' : 'Rhino');
const reconnect = (host: DirectHostName) =>
  `연결한 문서가 닫혔거나 바뀌어 실행하지 않았습니다. ${hostLabel(host)}에서 문서를 다시 연결한 뒤 요청하세요.`;
const pair = (host: DirectHostName) =>
  `연결 확인에 실패해 실행하지 않았습니다. ${hostLabel(host)}에서 VIDE 연결을 다시 한 뒤 요청하세요.`;

/** Codes that mean "refused before execution", with whether retrying this turn is pointless. */
const refusals: Record<string, { final: boolean; reason: (host: DirectHostName) => string }> = {
  DOCUMENT_READ_ONLY: {
    final: true,
    reason: (host) =>
      host === 'zwcad'
        ? '읽기 전용으로 열린 도면이라 실행하지 않았습니다. ZWCAD에서 다른 이름으로 저장(같은 이름에 덮어쓰기)한 뒤 다시 요청하세요.'
        : '읽기 전용으로 열린 문서라 실행하지 않았습니다. Rhino에서 다른 이름으로 저장(같은 이름에 덮어쓰기)한 뒤 다시 요청하세요.',
  },
  HOST_BUSY: {
    final: false,
    reason: (host) =>
      `${hostLabel(host)}에서 다른 명령이 진행 중이라 실행하지 않았습니다. 명령을 끝낸(Esc) 뒤 다시 요청하세요.`,
  },
  UNDO_UNAVAILABLE: {
    final: false,
    reason: (host) =>
      `${hostLabel(host)}가 되돌리기 기록을 시작하지 못해 실행하지 않았습니다. 진행 중인 명령을 끝낸 뒤 다시 요청하세요.`,
  },
  TARGET_MISMATCH: { final: true, reason: reconnect },
  STALE_CONNECTION: { final: true, reason: reconnect },
  DOCUMENT_MISMATCH: { final: true, reason: reconnect },
  HOST_UNAVAILABLE: {
    final: true,
    reason: (host) =>
      `${hostLabel(host)}에 연결하지 못해 실행하지 않았습니다. ${hostLabel(host)}가 열려 있는지 확인하고 문서를 다시 연결하세요.`,
  },
  HOST_OWNERSHIP_MISMATCH: { final: true, reason: pair },
  UNAUTHORIZED: { final: true, reason: pair },
  EDITOR_REGISTRY_INVALID: { final: true, reason: pair },
  UNSUPPORTED_METHOD: {
    final: true,
    reason: (host) =>
      `${hostLabel(host)} 연결 플러그인이 바로 실행을 지원하지 않아 실행하지 않았습니다. 플러그인을 업데이트하세요.`,
  },
  INVALID_INPUT: {
    final: false,
    reason: () => '실행 요청의 형식이 맞지 않아 실행하지 않았습니다.',
  },
  INVALID_CODE: {
    final: false,
    reason: () => '실행할 코드가 비었거나 너무 길어 실행하지 않았습니다.',
  },
  INVALID_REQUEST: {
    final: false,
    reason: () => '실행 요청의 형식이 맞지 않아 실행하지 않았습니다.',
  },
  OPERATION_CONFLICT: {
    final: false,
    reason: () => '같은 실행 번호로 다른 요청이 있어 실행하지 않았습니다.',
  },
};

/** Why one file of a request-level undo or rollback was not undone, short (ADR-027 6). */
const undoReasons: Record<string, string> = {
  'not-latest': '그 뒤에 문서가 더 바뀜',
  HOST_RESULT_UNKNOWN: '결과 확인 필요',
  EXECUTOR_NOT_READY: '연결 없음',
  STALE_CONNECTION: '문서가 닫히거나 바뀜',
  TARGET_MISMATCH: '문서가 닫히거나 바뀜',
  DOCUMENT_MISMATCH: '문서가 닫히거나 바뀜',
  closed: '문서가 닫힘',
  HOST_UNAVAILABLE: '호스트에 연결하지 못함',
  HOST_BUSY: '호스트 명령 진행 중 · Esc로 끝낸 뒤 다시',
  UNDO_UNAVAILABLE: '호스트 되돌리기 기록을 쓸 수 없음',
  DOCUMENT_READ_ONLY: '읽기 전용 문서',
  HOST_OWNERSHIP_MISMATCH: '연결 확인 실패 · 다시 연결',
  UNAUTHORIZED: '연결 확인 실패 · 다시 연결',
  EDITOR_REGISTRY_INVALID: '연결 확인 실패 · 다시 연결',
  UNSUPPORTED_METHOD: '플러그인 업데이트 필요',
  unknown: '호스트에 그 실행 기록이 없음(재시작 등)',
  'undo-failed': '호스트가 되돌리지 못함',
};
/** The short Korean reason of an undo the host did not do; never the raw host code. */
export function undoReason(reason: string | null | undefined) {
  return undoReasons[reason ?? ''] ?? '호스트가 거절함';
}

/** The user-facing reason of a refusal code (unknown codes: the host's code in brackets). */
export function refusalReason(code: string, host: DirectHostName = 'rhino') {
  return refusals[code]?.reason(host) ?? `호스트가 실행을 거절했습니다 (${code}).`;
}

/**
 * The refusal a failed `direct-execute` stands for, or undefined when the document state is
 * unknown. `failure` is a thrown error or an {ok:false, code} answer. ZWCAD's listener answers
 * HOST_BUSY also after waiting 60 s while the queued write may still run later: only a quick
 * HOST_BUSY (`elapsedMs` below 55 s) is a refusal there.
 */
export function directRefusal(
  host: DirectHostName,
  failure: unknown,
  elapsedMs = 0,
): DirectRefusal | undefined {
  const code =
    failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined;
  if (typeof code !== 'string' || !Object.hasOwn(refusals, code)) return undefined;
  if (code === 'HOST_BUSY' && host === 'zwcad' && elapsedMs >= 55000) return undefined;
  const entry = refusals[code];
  return { code, reason: entry.reason(host), final: entry.final };
}
