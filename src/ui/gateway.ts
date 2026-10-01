import { z } from 'zod';
import { workspaceRequestSchema } from '../contracts/workspace-result.ts';
import { GEOMETRY_TYPE, decodeGeometry } from '../contracts/geometry-transfer.ts';
export const projectSchema = z.object({ id: z.string(), name: z.string() }).passthrough();
export async function api(path: string, method = 'GET', data?: unknown): Promise<unknown> {
  let response;
  // One request in full carries its display geometry as binary (PLAN-18); errors stay JSON.
  const geometry = method === 'GET' && /^\/projects\/[^/]+\/requests\/[^/?]+$/.test(path);
  try {
    response = await fetch('api/v1' + path, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json' } : {}),
        ...(geometry ? { Accept: `${GEOMETRY_TYPE}, application/json` } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
  } catch {
    throw apiError('NETWORK_UNAVAILABLE');
  }
  let result;
  try {
    result = response.headers?.get('Content-Type')?.startsWith(GEOMETRY_TYPE)
      ? decodeGeometry(await response.arrayBuffer())
      : await response.json();
  } catch {
    throw apiError('INVALID_RESPONSE');
  }
  if (!response.ok) {
    // The PC answers {code}; the account site relaying it answers {error} (PC off, unreachable).
    const code = z
      .union([z.object({ code: z.string() }), z.object({ error: z.string() })])
      .safeParse(result).data;
    throw apiError(code ? ('code' in code ? code.code : code.error) : 'REQUEST_FAILED');
  }
  return result;
}
export async function connect() {
  const token = location.hash.slice(1);
  if (token) {
    // "#r=…" is a one-minute token from the sharing site's host list (remote devices).
    await api(
      '/session',
      'POST',
      token.startsWith('r=') ? { remoteToken: token.slice(2) } : { token },
    );
    history.replaceState(null, '', location.pathname + location.search);
  }
  const projects = z.array(projectSchema).parse(await api('/projects'));
  const wanted = new URLSearchParams(location.search).get('project');
  const project =
    projects.find((p) => p.id === wanted) ||
    projects[0] ||
    projectSchema.parse(await api('/projects', 'POST', { name: '새 프로젝트' }));
  return {
    project,
    projects: projects.length ? projects : [project],
    requests: z.array(workspaceRequestSchema).parse(await api(`/projects/${project.id}/requests`)),
  };
}
export const labels: Record<string, string> = {
  queued: '대기 중',
  running: 'AI 작업 중',
  succeeded: '응답 완료',
  failed: '실패',
  cancelled: '중단됨',
  interrupted: '재시작으로 중단됨',
  unknown: '호스트 결과 확인 필요',
  'needs-confirmation': '진행 확인 필요',
};
export const errors: Record<string, string> = {
  ZWCAD_ATTACHED_EDIT_UNAVAILABLE:
    '현재 ZWCAD 연결은 화면 동기화용입니다. 이 도면의 AI 수정 연결은 아직 지원하지 않습니다.',
  APPLIED_SYNC_FAILED:
    'Rhino 반영은 완료됐습니다. Sync를 다시 실행하세요. 모델링을 다시 요청하지 않아도 됩니다.',
  APPLICATION_FAILED: '원본 반영에 실패했습니다. 후보와 적용 결과를 확인하세요.',
  HOST_BUSY: '호스트 명령이 끝난 뒤 다시 Sync하세요.',

  UNSUPPORTED_DWG_EDIT:
    '이 DWG에서는 기존 독립 직선 경계의 이동·정점 수정만 가능합니다. 객체 추가·삭제 또는 관계가 있는 객체는 지원하지 않습니다.',
  HOST_RESULT_UNRESOLVED:
    '이 호스트에 결과를 확인하지 못한 작업이 있어 새 후보 생성을 보류합니다. 검토와 기존 결과 조회는 가능합니다.',
  PROTECTED_OBJECT_CHANGED:
    '유지·참고 대상으로 지정한 객체를 바꾸는 제안이어서 실행하지 않았습니다.',
  SUBSCRIPTION_LOGIN_REQUIRED:
    '이 PC의 CLI에 구독 계정으로 로그인돼 있지 않습니다. 터미널이나 AccountSwitch에서 로그인하세요.',
  CLI_PATH_REQUIRED: 'Codex 실행 경로를 설정하세요.',
  CLI_UNAVAILABLE: 'AI 실행 파일을 찾을 수 없습니다.',
  CLI_VERSION_UNSUPPORTED:
    'AI CLI의 판이 VIDE가 확인한 범위 밖이라 실행하지 않았습니다. 확인된 판을 설치하거나 VIDE 업데이트를 기다리세요.',
  CLI_MODE_CHANGED:
    'AI CLI의 로그인 방식이 바뀌어 요청이 인증 없이 나갔습니다. 실행을 멈췄고 다른 계정으로 넘기지 않았습니다. CLI 판을 확인하세요.',
  TIMEOUT: '응답 시간이 초과됐습니다.',
  PROVIDER_FAILED: 'AI 공급자가 요청을 완료하지 못했습니다.',
  PROVIDER_EXITED: 'AI 공급자 프로세스가 작업 중에 끝났습니다. 다음 요청은 새로 시작합니다.',
  PROVIDER_LIMIT:
    '이 계정의 구독 사용 한도에 걸렸습니다. 자동으로 다시 보내지 않습니다. AccountSwitch에서 계정을 바꾼 뒤 다시 보내세요.',
  UNAUTHORIZED: '서버가 표시한 실행 링크로 다시 열어 주세요.',
  LOGIN_REQUIRED: '웹사이트 로그인이 끝났습니다. 다시 로그인한 뒤 여세요.',
  HOST_OFFLINE: '작업 PC가 꺼졌습니다. PC에서 VIDE를 켠 뒤 다시 여세요.',
  HOST_REMOTE_OFF: '작업 PC의 원격 접속이 꺼졌습니다.',
  HOST_UNREACHABLE: '작업 PC가 응답하지 않습니다. 잠시 후 다시 여세요.',
};
Object.assign(errors, {
  HOST_UNAVAILABLE: 'Rhino 설치와 호스트 연결 상태를 확인하세요.',
  HOST_REJECTED: 'Rhino가 형상 생성을 완료하지 못했습니다. 입력을 수정해 다시 요청할 수 있습니다.',
  HOST_COMMAND_LIMIT:
    '설정한 호스트 실행 횟수에 도달했습니다. 마지막 후보를 확인하고 후속 요청의 상한을 조정하세요.',
  AGENT_CALL_LIMIT: '설정한 도구 호출 횟수에 도달했습니다.',
  INVALID_GEOMETRY: 'AI의 형상 제안이 검증을 통과하지 못했습니다.',
  PROJECT_BUSY: '같은 대상의 작업이 진행 중입니다. 다른 문서를 선택하거나 완료를 기다리세요.',
  INTERVENTION_REVIEW_REQUIRED:
    '이전 작업의 부분 결과 또는 불명확 상태를 확인해야 합니다. 추가 지시는 보존했습니다.',
  PREDECESSOR_UNAVAILABLE: '이전 실행 연결을 확인할 수 없어 추가 지시를 보류했습니다.',
  WORKSPACE_CAPACITY:
    '프로젝트의 AI 작업 상한(기본 3개)에 도달했습니다. 요청은 대기열에 서서 앞 작업이 끝나면 시작합니다.',
  STALE_REFERENCE: '첨부한 객체가 이전 후보 기준입니다. 현재 모델에서 다시 첨부해 주세요.',
  HOST_RESULT_UNKNOWN: '호스트 응답을 확인하지 못했습니다. 자동 재실행하지 않았습니다.',
});

Object.assign(errors, {
  IMPORT_LIMIT: '현재 연결 경로의 객체 수 한도를 넘어 가져오지 못했습니다. 기존 표시를 유지합니다.',
  IMPORT_FAILED: '파일을 불러오지 못했습니다.',
});

Object.assign(errors, {
  ZWCAD_POLYLINE_ONLY: '현재 ZWCAD 작업은 XY 평면 폴리라인을 지원합니다.',
  ZWCAD_EXECUTION_FAILED: 'ZWCAD가 작업을 완료하지 못했습니다. 설치·실행 상태를 확인하세요.',
});

Object.assign(errors, {
  APPLICATION_EVIDENCE_MISSING:
    '변경 전후의 확인 증거가 없어 자동 해소할 수 없습니다. 추가 적용은 보류합니다.',
  APPLICATION_DIVERGED: '현재 문서가 변경 전·후 증거와 일치하지 않습니다. 추가 적용은 보류합니다.',
  SOURCE_RESTORED: '현재 문서가 적용 전 상태와 일치합니다. 새로 취득해 작업을 이어갈 수 있습니다.',
  TABLE_VIEW_LIMIT:
    '프로젝트에 저장할 수 있는 표 구성은 200개까지입니다. 쓰지 않는 구성을 정리하세요.',
  REVISION_CONFLICT: '다른 화면에서 내용이 변경됐습니다. 다시 열어 최신 내용을 확인하세요.',
  INVALID_INPUT: '입력한 이름이나 조건을 확인하세요.',
  REVIEW_LIMIT: '프로젝트의 검토본 저장 한도에 도달했습니다.',
  NO_CHANGES: '원본에 반영할 이동 변경이 없습니다.',
  TARGET_MISMATCH: '후보를 가져온 원래 Rhino 문서를 선택하세요.',
  UNSUPPORTED_NATIVE_TARGET:
    '잠김·참조·그룹·이력 관계 또는 미지원 형상 때문에 원본 이동을 적용할 수 없습니다.',
  CAPTURE_FAILED:
    '문서 사본을 가져오지 못했습니다. 문서 연결·단위와 해당 연결 경로의 객체 수 한도를 확인하세요.',
  NETWORK_UNAVAILABLE:
    '로컬 서버에 연결하지 못했습니다. 서버 실행 상태를 확인하세요. 전송한 작업은 이력에서 상태를 확인한 뒤 다시 요청하세요.',
  INVALID_RESPONSE: '서버 응답을 읽지 못했습니다. 작업 이력을 새로 확인하세요.',
  REQUEST_FAILED: '요청을 처리하지 못했습니다. 작업 이력을 확인하세요.',
  STALE_CONNECTION: 'Rhino 문서 연결이 바뀌었습니다. 열린 문서를 다시 조회하고 대상을 선택하세요.',
  SOURCE_CHANGED:
    '기준 파일 또는 열린 문서가 변경됐습니다. 원본 적용은 영향 검토를 다시 하고, 파일 기반 작업은 수정된 파일을 다시 불러오세요.',
  PREVIEW_EXPIRED: '영향 검토가 만료됐습니다. 영향 검토를 다시 한 뒤 적용하세요.',
  WRITE_UNCERTAIN: '이 문서에 결과를 확인하지 못한 쓰기가 있어 추가 적용을 보류합니다.',
  CONTROLLER_BUSY: '이 문서에 다른 작업을 적용 중입니다. 완료 후 영향 검토를 다시 하세요.',
  DOCUMENT_ALREADY_CONNECTED:
    '이 Rhino 문서는 다른 프로젝트에 연결돼 있습니다. 해당 프로젝트에서 작업하거나 다른 문서를 선택하세요.',
  UNSUPPORTED_APPLICATION:
    '이 후보는 현재 원본 적용을 지원하지 않습니다. 후보 파일을 내려받거나 별도 Rhino 문서로 열어 작업을 이어가세요.',
});
function apiError(code: string) {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent('vide:api-error', { detail: errors[code] || code }));
  if (
    typeof window !== 'undefined' &&
    [
      'UNAUTHORIZED',
      'NETWORK_UNAVAILABLE',
      'LOGIN_REQUIRED',
      'HOST_OFFLINE',
      'HOST_REMOTE_OFF',
      'HOST_UNREACHABLE',
    ].includes(code)
  )
    window.dispatchEvent(new CustomEvent('vide:connection-lost', { detail: code }));
  return Object.assign(new Error(errors[code] || `요청 처리 오류 (${code})`), { code });
}

Object.assign(errors, {
  UNKNOWN_UNITS: '모델 단위가 없거나 미지원 단위입니다. 원본에서 단위를 지정한 뒤 다시 가져오세요.',
  UNSUPPORTED_DWG_CONTENT:
    '현재 DWG 모델 공간 읽기는 직선 XY 폴리라인을 지원합니다. 호·블록·다른 유형이 포함돼 일부만 가져오지 않았습니다.',
  EMPTY_DWG: 'DWG 모델 공간에서 읽을 경계를 찾지 못했습니다.',
  ZWCAD_REFERENCE_ONLY:
    '이 DWG는 참고용입니다. 경계를 핀으로 첨부하고 Rhino를 선택해 후보를 만들 수 있습니다. 원 도면 편집은 아직 지원하지 않습니다.',
});

Object.assign(errors, {
  INVALID_CLI_PATH: '설치된 claude.exe 또는 codex.exe의 로컬 전체 경로를 입력하세요.',
  CLI_FILE_MISSING: '해당 경로에 실행 파일이 없습니다.',
  AUTH_TIMEOUT: '로그인 상태 확인 시간이 초과됐습니다.',
  AUTH_INVALID: '공식 CLI의 구독 로그인 상태를 확인할 수 없습니다.',
});

Object.assign(errors, {
  EXTENSION_DISABLED: '확장이 비활성화되어 새 실행을 시작할 수 없습니다.',
  EXTENSION_FAILED: '확장 실행이 실패했습니다. 입력과 이전 후보는 유지됩니다.',
});

Object.assign(errors, { APP_STOPPING: 'VIDE가 종료 중이라 새 작업을 시작할 수 없습니다.' });

Object.assign(errors, {
  IMPORT_EVIDENCE_MISSING: '업로드 당시의 확인 근거가 없어 자동 복구할 수 없습니다.',
  IMPORT_RECOVERY_FAILED: 'DWG 복사본을 다시 읽지 못했습니다. 연결과 파일 상태를 확인하세요.',
});

Object.assign(errors, {
  WEB_MODEL_LIMIT: '현재 공유 뷰어의 64 MiB 표시 한도를 넘었습니다. 공개할 객체를 줄여 주세요.',
  RESULT_NOT_VERIFIED: '검증이 끝난 결과만 공유할 수 있습니다.',
  UNSUPPORTED_GEOMETRY: '선택한 객체 중 공유 뷰어가 표시하지 못하는 형상이 있습니다.',
  // Settings of an open jig changed from the request box (SPEC-02.17 2, SPEC-07.6).
  PARAM_FIXED: '이 설정값은 검토본을 고정한 뒤라 바꿀 수 없습니다. 새 작업본에서 바꾸세요.',
  OUT_OF_RANGE: '설정값이 허용 범위를 벗어납니다.',
  UNIT_MISMATCH: '이 설정값에 맞지 않는 단위입니다.',
  // Conversations (SPEC-02.19 1).
  CONVERSATION_CLOSED: '닫힌 대화입니다. 다시 열거나 새 대화에서 보내세요.',
  CONVERSATION_PROVIDER: '이 대화는 다른 AI 서비스로 열렸습니다. 새 대화에서 보내세요.',
});

// Direct mode (user decision 2026-09-30): edits run in the open document, one undo record each.
Object.assign(errors, {
  WRITE_NOT_ALLOWED:
    '계획 모드에서는 문서를 바꾸지 않습니다. 계획 카드의 [진행]을 누르거나 Shift+Tab으로 자동으로 바꾸세요.',
  UNDO_NOT_LATEST:
    '이 실행 뒤에 문서가 더 바뀌어 여기서 되돌릴 수 없습니다. Rhino에서 Ctrl+Z로 순서대로 되돌리세요.',
  UNDO_UNAVAILABLE: '되돌리기 기록을 찾지 못했습니다. 호스트에서 Ctrl+Z로 확인하세요.',
  DIRECT_ACTION_FAILED: '요청을 처리하지 못했습니다. 작업 상태를 다시 확인하세요.',
  GUARD_CONFIRMATION_REQUIRED:
    '되돌리기로 복구하기 어려운 변경이라 실행을 되돌리고 확인을 기다립니다. [진행]을 누르면 다시 실행합니다.',
  // Several linked files in one request (ADR-027).
  LINK_NOT_LIVE:
    '그 연결 파일은 지금 열려 연결되어 있지 않아 실시간으로 읽거나 고칠 수 없습니다. AI는 마지막 Sync 기록으로만 읽습니다. 호스트에서 파일을 열고 연결한 뒤 다시 요청하세요.',
  DOCUMENT_LOCKED:
    '다른 작업이 그 파일을 고치는 중이라 이 요청에서는 그 파일을 바꾸지 않았습니다. 그 작업이 끝난 뒤 다시 요청하세요.',
  UNDO_PARTIAL:
    '일부 파일은 되돌리지 못했습니다. 결과에 남은 파일을 호스트에서 Ctrl+Z(ZWCAD는 U)로 순서대로 되돌리세요.',
});

// Codes the engine and hosts send that used to show raw: what happened and what to do.
Object.assign(errors, {
  NOT_FOUND: '대상을 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 고르세요.',
  FORBIDDEN: '이 화면에서는 할 수 없는 작업입니다. 작업 PC의 VIDE에서 하세요.',
  METHOD_NOT_ALLOWED: '이 판의 VIDE가 지원하지 않는 요청입니다. 앱을 다시 열거나 업데이트하세요.',
  INTERNAL_ERROR: 'VIDE 내부 오류가 났습니다. 다시 시도하고, 반복되면 피드백으로 알려 주세요.',
  JSON_REQUIRED: '요청 형식이 맞지 않습니다. 앱을 새로고침한 뒤 다시 시도하세요.',
  INPUT_TOO_LARGE: '보낸 내용이 너무 큽니다(1 MB 한도). 첨부나 글을 줄여 다시 보내세요.',
  // Project folders (SPEC-01.13).
  FOLDER_NOT_FOUND: '이 PC에 그 폴더가 없습니다. 경로를 확인하세요.',
  FOLDER_NOT_ALLOWED:
    '이 폴더는 프로젝트 폴더로 정할 수 없습니다(드라이브 맨 위, VIDE 데이터 폴더, 키·로그인 폴더).',
  RESYNC_REQUIRED: '문서가 많이 바뀌어 이어서 맞출 수 없습니다. Sync를 다시 실행하세요.',
  EXECUTOR_NOT_READY:
    '실행 준비가 아직 끝나지 않았습니다. 호스트 연결을 확인한 뒤 다시 시도하세요.',
  CANCELLED: '작업을 중단했습니다.',
  JIG_VERSION_EXISTS:
    '같은 판 번호의 jig가 이미 설치돼 있고 내용이 다릅니다. 판 번호를 올린 뒤 다시 등록하세요.',
  JIG_SELFTEST_FAILED:
    'jig의 자체 시험이 통과하지 못했습니다. 시험 결과를 확인해 고친 뒤 다시 등록하세요.',
  JIG_DIGEST_MISMATCH: '설치된 jig 파일이 바뀌었습니다. jig를 다시 가져오세요.',
  JIG_PACK_FAILED: 'jig 묶음을 만들지 못했습니다. 작업본의 파일과 오류를 확인하세요.',
  JIG_LIBRARY_UNKNOWN: 'jig가 이 VIDE에 없는 기능을 씁니다. VIDE를 업데이트하거나 jig를 고치세요.',
  DRAFT_NOT_OPEN: '이 jig 작업본은 이미 닫혔습니다. 새 작업본에서 이어 하세요.',
  DRAFT_OUTSIDE: '작업본 폴더 밖의 파일은 바꿀 수 없습니다.',
  DRAFT_FORBIDDEN_FILE: '작업본에서 바꿀 수 없는 파일입니다.',
  DRAFT_PATH_INVALID: '파일 경로가 올바르지 않습니다.',
  DRAFT_TEMPLATE_MISSING:
    '작업본을 시작할 jig 틀을 찾지 못했습니다. VIDE를 다시 설치하거나 업데이트하세요.',
  MAKE_STOPPED: 'jig 만들기를 멈췄습니다.',
  MAKE_FILES_INVALID:
    '가져온 파일로 jig 작업본을 만들 수 없습니다. jig.json이 있는 폴더인지 확인하세요.',
  STRUCTURE_CORE_MISSING: '구조 계산 모듈이 없습니다. VIDE를 다시 설치하거나 업데이트하세요.',
  STRUCTURE_MODEL_INVALID:
    '구조 모델에 고칠 곳이 있어 계산하지 않았습니다. 표시된 문제를 고친 뒤 다시 계산하세요.',
  SOURCE_UNAVAILABLE: '원본 파일을 찾을 수 없습니다. 서버 연결과 파일 위치를 확인하세요.',
  PUBLICATION_LIMIT: '공유할 모델이 너무 큽니다(512 MB 한도). 공개할 객체를 줄이세요.',
  PUBLICATION_BASIS_NOT_FOUND:
    '의견이 가리키는 공유본을 찾을 수 없습니다. 공유 목록을 새로고침하세요.',
  AMBIGUOUS_OBJECT: '같은 이름의 객체가 여럿이라 하나로 정할 수 없습니다. 객체를 직접 고르세요.',
  DUPLICATE_OBJECT: '같은 객체가 두 번 골라졌습니다. 목록을 확인하세요.',
  OBJECT_NOT_FOUND: '고른 객체가 지금 모델에 없습니다. Sync한 뒤 다시 고르세요.',
  HOST_VERIFICATION_FAILED: '호스트가 불러온 결과를 확인하지 못했습니다. 파일을 다시 열어 보세요.',
  LINKED_TARGET_UNAVAILABLE:
    '연계 대상 문서를 열 수 없습니다. 두 호스트가 연결돼 있는지 확인하세요.',
  DOCUMENT_READ_ONLY:
    'Rhino 문서가 읽기 전용으로 열려 있어 바꾸지 않았습니다. 쓰기 가능하게 연 뒤 다시 보내세요.',
  OPERATION_CONFLICT:
    '같은 작업이 다른 내용으로 이미 실행됐습니다. 작업 상태를 확인한 뒤 다시 보내세요.',
  HOST_INVALID_RESPONSE: '호스트 응답을 읽지 못했습니다. 호스트를 다시 연결한 뒤 시도하세요.',
  HOST_RESPONSE_TOO_LARGE: '호스트 응답이 너무 큽니다. 범위를 좁혀 다시 시도하세요.',
  HOST_RESULT_TOO_LARGE: '한 번에 읽을 결과가 너무 큽니다. 레이어나 범위를 좁혀 다시 시도하세요.',
  TURN_OUTPUT_INVALID: 'AI 답을 읽지 못했습니다. 같은 요청을 다시 보내세요.',
  QUERY_RESULT_TOO_LARGE: '조회 결과가 너무 큽니다. 범위를 좁혀 다시 요청하세요.',
  NO_ACTIVE_SESSION: '이어 갈 대화가 없습니다. 새 대화에서 보내세요.',
  BAKE_UNDO_FAILED: 'Rhino에 만든 결과를 모두 되돌리지 못했습니다. Rhino에서 Ctrl+Z로 확인하세요.',
});
