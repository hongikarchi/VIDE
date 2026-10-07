// The words the user reads before agreeing to send error/performance reports (ADR-036, SPEC-05.9):
// the first-run card, Settings › 상태 · 오류 and the site's 개인정보 처리 안내 page show the same lists.
// Draft text — a legal check is recommended before a wide release (docs/decisions/ADR-036).

export const TELEMETRY_QUESTION = '오류·성능 정보를 자동으로 보내 VIDE 개선에 도움 주기';

export const TELEMETRY_INTRO =
  'VIDE가 멈추거나 실패한 이유를 찾을 수 있도록, 이름 없는 요약을 시작할 때와 하루 한 번 VIDE 계정 사이트로 보냅니다. 동의하기 전에는 아무것도 보내지 않으며, 설정 › 상태 · 오류에서 언제든 끌 수 있습니다.';

/** What a report holds. */
export const TELEMETRY_SENT = [
  'VIDE·Rhino/ZWCAD 플러그인·Windows 버전, CPU 수와 메모리 크기',
  '이 설치의 무작위 번호(계정·이름과 연결되지 않음)',
  '기능별 사용·실패 횟수, 오류 코드와 오류 문장(경로·이름·따옴표 안 글자·한글 글자는 지운 것)',
  '작업 엔진이 비정상 종료된 코드와 시각',
  '요청 처리·Sync·AI 응답 등에 걸린 시간과 메모리 사용량(숫자)',
];

/** What a report never holds. */
export const TELEMETRY_NOT_SENT = [
  '요청 글, AI의 답과 대화 내용',
  '파일·프로젝트·레이어·객체의 이름과 내용, 모델·도면',
  '파일 경로, Windows 사용자 이름, PC 이름, 계정 아이디·이메일',
  '로그인 정보·키, 작업 DB, 첨부 파일, 충돌 덤프',
];

/** The diagnostic bundle offered after a crash: never sent without this question. */
export const BUNDLE_CONTENTS = [
  '최근 3일의 진단 기록(작업 엔진·PC 프로그램·Rhino/ZWCAD 플러그인)',
  '작업 엔진 종료 기록, VIDE·Windows 버전, 설치된 플러그인 파일 목록',
  '설정 요약(경로는 지운 것)과 데이터 폴더의 파일 이름·크기',
];
export const BUNDLE_EXCLUDED =
  '요청 글·파일 내용·모델·로그인 정보·작업 DB는 넣지 않습니다. 크래시 덤프는 아래에서 고를 때만 최신 하나를 넣습니다.';
export const DUMP_NOTE =
  '작업 엔진의 메모리 내용(열려 있던 요청 글·모델 일부)이 들어 있을 수 있습니다.';

/**
 * Project conversation records (ADR-037 4, SPEC-04.12): not part of the reports above, but the
 * same notice page says what of a project's conversations goes to the account site.
 */
export const CONVERSATION_SHARING = [
  '오류·성능 보고와 별개로, 계정에 로그인한 PC는 프로젝트마다 "할 일·대화 기록을 사이트에 올리기"가 켜져 있으면(기본 켜짐) 호스트 문서 없이 한 대화의 요청 글·AI 답 전문·활동 줄·실행 코드·파일 이름을 VIDE 계정 사이트에 올립니다. 그 프로젝트 구성원이 사이트와 자기 VIDE에서 읽습니다.',
  'Rhino·ZWCAD 문서를 쓰거나 읽은 모델링 대화의 전문, 모델·도면, 첨부 파일 내용, 핀·스케치 좌표는 올리지 않습니다. 모델링 요청은 요청 글·답의 첫 줄·상태·시각·파일 이름의 요약만 PC 없이 보기 화면에 올라갑니다.',
  '스위치를 끄거나 PC에서 프로젝트를 지우면 그 PC가 올린 그 프로젝트의 대화 기록을 사이트에서 지우고 더 올리지 않습니다.',
  'Cloudflare(미국 등 해외 데이터센터 포함)에 보관됩니다.',
];
/** The site's notice page sections (draft). */
export const PRIVACY_SECTIONS: { title: string; body: string[] }[] = [
  {
    title: '무엇을 받나요',
    body: TELEMETRY_SENT,
  },
  {
    title: '받지 않는 것',
    body: TELEMETRY_NOT_SENT,
  },
  {
    title: '언제 보내나요',
    body: [
      'PC 프로그램을 설치하거나 처음 실행할 때 묻고, [동의]를 누른 경우에만 보냅니다. 답하기 전에는 보내지 않습니다.',
      '동의한 뒤의 기록만 요약해 시작할 때와 하루 한 번 보냅니다. 연결이 없으면 PC에 잠시 두었다가 다음에 보냅니다.',
      '진단 묶음과 충돌 덤프는 자동으로 보내지 않습니다. 작업 엔진이 비정상 종료된 뒤 따로 묻고, [보내기]를 누를 때만 보냅니다.',
    ],
  },
  {
    title: '어떻게 쓰고 얼마나 두나요',
    body: [
      'VIDE의 오류 원인을 찾고 성능을 개선하는 데만 씁니다. 광고·판매·다른 목적의 분석에 쓰지 않습니다.',
      '받은 요약은 180일 뒤 지웁니다. VIDE 개발자(사이트 관리자)만 볼 수 있습니다.',
      'Cloudflare(미국 등 해외 데이터센터 포함)에 보관됩니다.',
    ],
  },
  {
    title: '끄기와 삭제 요청',
    body: [
      'PC 프로그램의 설정 › 상태 · 오류에서 [오류·성능 정보 보내기]를 끄면 그때부터 보내지 않고, 보내지 못한 요약도 지웁니다.',
      '이미 보낸 요약의 삭제를 원하면 설정에 보이는 설치 번호와 함께 VIDE 관리자에게 알려 주세요.',
    ],
  },
  { title: '프로젝트 대화 기록', body: CONVERSATION_SHARING },
];
export const PRIVACY_DRAFT_NOTE =
  '초안입니다. 많은 사용자에게 배포하기 전에 법률 검토를 받을 예정입니다.';
