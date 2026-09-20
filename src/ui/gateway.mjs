export async function api(path, method='GET', data) {
  let response;
  try{response=await fetch('/api/v1'+path,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});}
  catch{throw apiError('NETWORK_UNAVAILABLE');}
  let result;
  try{result=await response.json();}catch{throw apiError('INVALID_RESPONSE');}
  if(!response.ok)throw apiError(result.code||'REQUEST_FAILED');
  return result;
}
export async function connect() {
  const token=location.hash.slice(1);
  if(token){await api('/session','POST',{token});history.replaceState(null,'',location.pathname+location.search);}
  const projects=await api('/projects');
  const wanted=new URLSearchParams(location.search).get('project');
  const project=projects.find(p=>p.id===wanted)||projects[0]||await api('/projects','POST',{name:'새 프로젝트'});
  return {project,projects:projects.length?projects:[project],requests:await api(`/projects/${project.id}/requests`)};
}
export const labels={queued:'대기 중',running:'AI 작업 중',succeeded:'응답 완료',failed:'실패',cancelled:'중단됨',interrupted:'재시작으로 중단됨',unknown:'호스트 결과 확인 필요'};
export const errors={HOST_RESULT_UNRESOLVED:'이 호스트에 결과를 확인하지 못한 작업이 있어 새 후보 생성을 보류합니다. 검토와 기존 결과 조회는 가능합니다.',PROTECTED_OBJECT_CHANGED:'유지·참고 대상으로 지정한 객체를 바꾸는 제안이어서 실행하지 않았습니다.',SUBSCRIPTION_LOGIN_REQUIRED:'구독 계정으로 CLI에 로그인하세요.',CLI_PATH_REQUIRED:'Codex 실행 경로를 설정하세요.',CLI_UNAVAILABLE:'AI 실행 파일을 찾을 수 없습니다.',TIMEOUT:'응답 시간이 초과됐습니다.',PROVIDER_FAILED:'AI 공급자가 요청을 완료하지 못했습니다.',UNAUTHORIZED:'서버가 표시한 실행 링크로 다시 열어 주세요.'};
Object.assign(errors,{HOST_UNAVAILABLE:'Rhino에서 mcpstart 명령으로 연결을 켜 주세요.',HOST_REJECTED:'Rhino가 형상 생성을 완료하지 못했습니다. 입력을 수정해 다시 요청할 수 있습니다.',INVALID_GEOMETRY:'AI의 형상 제안이 검증을 통과하지 못했습니다.',WRITE_NOT_ALLOWED:'검토 권한으로는 형상을 변경하지 않습니다. 후보 작업 허용으로 전환하세요.',PROJECT_BUSY:'현재 작업이 끝나거나 중단된 뒤 요청해 주세요.',STALE_REFERENCE:'첨부한 객체가 이전 후보 기준입니다. 현재 모델에서 다시 첨부해 주세요.',HOST_RESULT_UNKNOWN:'호스트 응답을 확인하지 못했습니다. 자동 재실행하지 않았습니다.'});

Object.assign(errors,{SOURCE_CHANGED:'기준 Rhino 파일이 외부에서 변경됐습니다. 수정된 파일을 다시 불러와 이어서 작업하세요.',IMPORT_LIMIT:'현재 가져오기는 유효한 객체 500개까지 지원합니다.',IMPORT_FAILED:'파일을 불러오지 못했습니다.'});

Object.assign(errors,{ZWCAD_POLYLINE_ONLY:'현재 ZWCAD 작업은 XY 평면 폴리라인을 지원합니다.',ZWCAD_EXECUTION_FAILED:'ZWCAD가 작업을 완료하지 못했습니다. 설치·실행 상태를 확인하세요.'});

Object.assign(errors,{
 CAPTURE_FAILED:'문서 사본을 가져오지 못했습니다. 문서 연결·단위와 객체 수(500개 이하)를 확인하세요.',
 NETWORK_UNAVAILABLE:'로컬 서버에 연결하지 못했습니다. 서버 실행 상태를 확인하세요. 전송한 작업은 이력에서 상태를 확인한 뒤 다시 요청하세요.',
 INVALID_RESPONSE:'서버 응답을 읽지 못했습니다. 작업 이력을 새로 확인하세요.',
 REQUEST_FAILED:'요청을 처리하지 못했습니다. 작업 이력을 확인하세요.',
 STALE_CONNECTION:'Rhino 문서 연결이 바뀌었습니다. 열린 문서를 다시 조회하고 대상을 선택하세요.',
 SOURCE_CHANGED:'기준 파일 또는 열린 문서가 변경됐습니다. 원본 적용은 영향 검토를 다시 하고, 파일 기반 작업은 수정된 파일을 다시 불러오세요.',
 PREVIEW_EXPIRED:'영향 검토가 만료됐습니다. 영향 검토를 다시 한 뒤 적용하세요.',
 WRITE_UNCERTAIN:'이 문서에 결과를 확인하지 못한 쓰기가 있어 추가 적용을 보류합니다.',
 CONTROLLER_BUSY:'이 문서에 다른 작업을 적용 중입니다. 완료 후 영향 검토를 다시 하세요.',
 DOCUMENT_ALREADY_CONNECTED:'이 Rhino 문서는 다른 프로젝트에 연결돼 있습니다. 해당 프로젝트에서 작업하거나 다른 문서를 선택하세요.',
 UNSUPPORTED_APPLICATION:'현재 원본 적용은 VIDE에서 생성한 박스·폴리라인·돌출 후보를 지원합니다.'
});
function apiError(code){return Object.assign(new Error(errors[code]||`요청 처리 오류 (${code})`),{code});}
