import { z } from 'zod';
import { workspaceRequestSchema } from '../contracts/workspace-result.ts';
export const projectSchema = z.object({ id: z.string(), name: z.string() }).passthrough();
export async function api(path: string, method = 'GET', data?: unknown): Promise<unknown> {
  let response;
  try {
    response = await fetch('/api/v1' + path, {
      method,
      headers: data ? { 'Content-Type': 'application/json' } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
  } catch {
    throw apiError('NETWORK_UNAVAILABLE');
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw apiError('INVALID_RESPONSE');
  }
  if (!response.ok)
    throw apiError(
      result && typeof result === 'object' && 'code' in result && typeof result.code === 'string'
        ? result.code
        : 'REQUEST_FAILED',
    );
  return result;
}
export async function connect() {
  const token = location.hash.slice(1);
  if (token) {
    await api('/session', 'POST', { token });
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
};
export const errors: Record<string, string> = {
  UNSUPPORTED_DWG_EDIT:
    '이 DWG에서는 기존 독립 직선 경계의 이동·정점 수정만 가능합니다. 객체 추가·삭제 또는 관계가 있는 객체는 지원하지 않습니다.',
  HOST_RESULT_UNRESOLVED:
    '이 호스트에 결과를 확인하지 못한 작업이 있어 새 후보 생성을 보류합니다. 검토와 기존 결과 조회는 가능합니다.',
  PROTECTED_OBJECT_CHANGED:
    '유지·참고 대상으로 지정한 객체를 바꾸는 제안이어서 실행하지 않았습니다.',
  SUBSCRIPTION_LOGIN_REQUIRED: '구독 계정으로 CLI에 로그인하세요.',
  CLI_PATH_REQUIRED: 'Codex 실행 경로를 설정하세요.',
  CLI_UNAVAILABLE: 'AI 실행 파일을 찾을 수 없습니다.',
  TIMEOUT: '응답 시간이 초과됐습니다.',
  PROVIDER_FAILED: 'AI 공급자가 요청을 완료하지 못했습니다.',
  UNAUTHORIZED: '서버가 표시한 실행 링크로 다시 열어 주세요.',
};
Object.assign(errors, {
  HOST_UNAVAILABLE: 'Rhino 설치와 호스트 연결 상태를 확인하세요.',
  HOST_REJECTED: 'Rhino가 형상 생성을 완료하지 못했습니다. 입력을 수정해 다시 요청할 수 있습니다.',
  INVALID_GEOMETRY: 'AI의 형상 제안이 검증을 통과하지 못했습니다.',
  WRITE_NOT_ALLOWED: '검토 권한으로는 형상을 변경하지 않습니다. 후보 작업 허용으로 전환하세요.',
  PROJECT_BUSY: '같은 대상의 작업이 진행 중입니다. 다른 문서를 선택하거나 완료를 기다리세요.',
  INTERVENTION_REVIEW_REQUIRED:
    '이전 작업의 부분 결과 또는 불명확 상태를 확인해야 합니다. 추가 지시는 보존했습니다.',
  PREDECESSOR_UNAVAILABLE: '이전 실행 연결을 확인할 수 없어 추가 지시를 보류했습니다.',
  WORKSPACE_CAPACITY: '독립 작업 두 개가 진행 중입니다. 하나가 끝난 뒤 보내세요.',
  STALE_REFERENCE: '첨부한 객체가 이전 후보 기준입니다. 현재 모델에서 다시 첨부해 주세요.',
  HOST_RESULT_UNKNOWN: '호스트 응답을 확인하지 못했습니다. 자동 재실행하지 않았습니다.',
});

Object.assign(errors, {
  SOURCE_CHANGED:
    '기준 Rhino 파일이 외부에서 변경됐습니다. 수정된 파일을 다시 불러와 이어서 작업하세요.',
  IMPORT_LIMIT: '현재 가져오기는 유효한 객체 500개까지 지원합니다.',
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
    '문서 사본을 가져오지 못했습니다. 문서 연결·단위와 객체 수(500개 이하)를 확인하세요.',
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
  if (typeof window !== 'undefined' && ['UNAUTHORIZED', 'NETWORK_UNAVAILABLE'].includes(code))
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
});
