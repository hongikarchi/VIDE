---
id: VERIFY-2026-09-22-typescript-foundation
title: TypeScript·React·Vite 전환 기반 검증
status: review
version: 0.8
updated: 2026-09-22
owner: agent:codex
related: [PLAN, ADR-016, ADR-017, T-010, T-011, T-015]
---

# 전환 기반 검증

## 구현 범위

React 19.3.0, TypeScript 7.0.2, Vite 8.3.0, React Vite plugin 6.1.1을 lockfile에 고정했다. Node 24.15.0과 Three.js 0.186.0은 유지한다. `npm run build`는 UI/서버 타입 검사, Vite UI 빌드와 서버 tsc 출력을 수행한다. start/workspace/test/package:windows 전에 UI를 빌드한다.

React는 모바일 탭 DOM을 단독 소유한다. 기존 화면 전환은 같은 상태 변경 함수를 호출하며 구독을 해제할 수 있다. 나머지 패널은 기존 mjs가 소유한다. 기존 mjs는 allowJs/checkJs:false로 공존하며 새 TS/TSX만 strict 검사한다. 전체 타입 안정성을 달성했다는 뜻은 아니다.

로컬 서버는 기존 Host/Origin/CSP 검사를 유지하며 dist/ui의 HTML과 허용된 해시 JS/CSS만 제공한다. 소스 TS/JS, 소스맵, 빌드 manifest는 공개하지 않는다. 개발 소스·컴파일된 서버·배포 app 모두 해당 패키지의 dist/ui를 찾는다. Windows 패키지에는 UI 빌드 결과가 포함되며 현재 서버의 TS는 번들 Node의 기본 타입 제거로 실행한다.

## 확인 결과

- `npm run build`: 통과. 기존 app/Three 청크 약 630 kB로 Vite의 500 kB 경고가 남는다. 성능 개선 완료로 보지 않는다.
- `npm test`: 97/97 통과. 실제 HTTP로 HTML의 JS/CSS URL을 읽고 비공개 소스·manifest·누락 자산이 404인지 추가 확인했다.
- 컴파일 결과 dist/server/src/server/web-assets.js에서 HTML 8,634 bytes 읽기 성공. 컴파일 서버 전체의 호스트 실행 검증은 아니다.
- 격리 데이터 디렉터리의 Chromium 데스크톱 화면: 기존 3D canvas/좌측 문서/우측 AI 패널 표시, 브라우저 오류 없음.
- 390×844 화면: React 모델/대화 탭의 aria-pressed와 표시 상태 일치, 탭 왕복 후 입력 보존, canvas 1개, 가로 overflow 없음. 실제 스크린샷도 확인했다.
- `npm run package:windows -- 0.1.0-ts-migration-20260922`: ZIP 생성 성공. 패키지 runtime/node.exe로 app/src/server/main.mjs를 격리 데이터에 실행하고 브라우저에서 빌드 JS 로딩·canvas 1개·React 탭 2개·오류 없음을 확인했다. 새 PC 설치/서명/전체 호스트 과업 시험은 아니다. 이 작업 트리의 미완료 Rhino worker도 들어간 개발 검증용 묶음이므로 공개 배포하지 않는다.

## 다음 검증

공유 계약 타입, 일반 패널 React 전환, 서버 모듈 TypeScript 전환을 각각 기능 단위로 진행한다. 기존 호스트 실행·저장 보호 시험을 유지한다. 실제 Rhino worker 준비 타임아웃은 별도 미완료 항목이며 이번 웹 빌드 성공으로 해소되지 않는다.

## 요청 계약·일반 패널 후속 전환

src/contracts/workspace.ts에 기존 요청 입력 검증과 상태 enum을 옮겼다. Zod 원본에서 TypeScript 타입을 유도한다. 서버는 동일 스키마로 입력을 검사하되 기존 멱등 비교를 위해 원래 JSON 직렬화를 보존한다. 프로젝트 내 핀 기준·대상·바이트 한도·unknown 보호는 Workspace에서 계속 검사한다. 전체 요청 결과/호스트 DTO의 타입 전환이 완료된 것은 아니다.

프로젝트 선택/생성, 요청 목록과 진행 작업을 React로 전환했다. 기존 requests.mjs는 삭제했으며 mount별로 React가 DOM을 단독 소유한다. bfcache 진입 시 root를 해제하지 않도록 pagehide 처리를 보완했다. 실제 bfcache 복원 전 과정 시험은 별도이다.

타입 검사·빌드와 99/99 자동 시험이 통과했다. 비정상 좌표·크기 초과·확장 권한·잘못된 모델/호스트/기준을 거절하는 계약 시험을 추가했다. Chromium에서 요청 2개 추가→두 번째 편집→첫 번째 삭제 후 남은 값·카운트·localStorage 일치를 확인했다. 입력 포커스도 유지됐다. 다른 테스트 프로젝트로 전환하면 빈 초안, 원 프로젝트로 돌아오면 수정한 요청이 복원됐다. 브라우저 오류 없음과 실제 데스크톱 스크린샷을 확인했다. AI/호스트 실행은 이 화면 전환 시험에서 호출하지 않았다.

패키징의 소스 복사 대상에 contracts를 추가했다. 0.1.0-react-panels-20260922 개발 묶음은 별도 검증용이며 일반 배포가 아니다.

## AI 연결 설정 후속 전환

AI 설정 코어는 strict TypeScript로 옮겼고 src/contracts/ai-settings.ts의 스키마로 요청·저장 값·응답 타입을 유도한다. 손상된 저장 JSON은 실행 설정으로 사용하지 않는다. 누락된 공급자 키가 Zod의 unknown 값 때문에 통과하는 차이를 테스트에서 찾아 원래 INVALID_INPUT 분류를 복구했다. 기존 경로 정규화·파일 검사·revision 충돌·자동 탐색 설정을 유지한다.

설정 창은 React가 단독 소유하며 닫힌 창의 늦은 연결 확인 응답을 무시한다. 저장 중 닫기/편집은 막고 저장 후 반환된 revision을 사용한다. 설정 모듈은 창을 열 때 지연 로딩한다. 빌드 결과 설정 청크는 약 91.55 kB이며 초기 app 청크는 약 621.92 kB다. 이 수치는 성능 벤치마크가 아니다.

빌드와 100/100 자동 테스트를 통과했다. Chromium의 별도 테스트 데이터에서 잘못된 명령 경로를 거절하며 revision 0을 유지했고 빈 경로 저장 뒤 revision 1과 성공 안내를 확인했다. 연결 확인 응답을 지연시킨 상태에서 취소·재열기 후 입력이 유지됐다. 모달의 실제 렌더와 지연 로딩 후 열림·입력 2개·브라우저 오류 없음을 확인했다. 사용자 기본 설정은 변경하지 않았다. Claude 구독 상태는 확인됐지만 테스트 환경의 Codex는 로그인 필요로 표시됐다. 이 검증은 AI 과업 실행 성공을 뜻하지 않는다.

## 열린 문서 패널·브라우저 회귀 복구

열린 Rhino 문서 조회·선택·취득 패널을 React로 옮겼다. 조회·취득·선택 요청 중 문서 전환과 중복 요청을 막고 선택 응답의 instance/documentId가 요청 대상과 같은지 확인한다. host-documents 공통 스키마는 Rhino 어댑터와 UI 양쪽에서 사용한다. 실제 호스트 수신부 교체나 Rhino worker 준비 실패 해결은 아니다.

`npm run build`, `npm test` 101/101, `npm run test:browser`가 통과했다. 새 브라우저 회귀는 임시 DB를 만들고 종료 시 정리하며 CLI·호스트 응답은 합성 route로 대체한다. 요청 편집/삭제·포커스·프로젝트 초안 격리·문서 응답 경합·390px 화면을 검증한다. 실호스트 성공으로 집계하지 않는다.

기존 통합 테스트의 `/gateway.mjs` 등 소스 직접 import는 Vite 배포에서 404가 된다. 공개 HTTP API를 호출하는 테스트 보조 함수로 바꾸고 viewport/inspector/quantities 직접 시험은 Vite로 메모리 빌드한 fixture를 Playwright route에서만 제공한다. 제품 서버에 테스트 endpoint나 원본 소스 공개를 추가하지 않는다. Playwright 1.63.0은 개발 의존성으로 고정했다. React의 비동기 mount를 기다리도록 기존 준비 조건도 수정했다.

재실행한 기존 테스트는 browser-point-selection, browser-large-coordinate-detail, browser-ai-settings다. 실제 선택·핀·빗나간 클릭·대좌표 2 mm 형상·설정 저장/복원/잘못된 경로 보존이 통과했다. Codex 구독 상태가 미연결인 환경에서도 실제 공급자 상태와 UI가 일치하는지 검사한다. 변경한 다른 실호스트/저장 후보 의존 통합 스크립트는 이번에 전부 실행한 것은 아니다.

재현: 제품 서버를 별도 VIDE_DATA_DIR에 띄우고 `node tests/integration/browser-point-selection.mjs node_modules/playwright/index.mjs <launch.json>` 형식으로 실행한다. 대좌표·AI 설정 검증도 같은 인수를 쓴다. 서버가 필요 없는 합성 패널 회귀는 `npm run test:browser`다. 설치된 Chrome을 사용하며 별도 PC/저성능 장비 성능 보증은 아니다.

공유 런타임 검증을 사용하는 문서 패널을 추가하면서 Zod 관련 공유 청크는 초기 로딩에 포함된다. AI 설정 화면 자체는 계속 지연 로딩한다. 앞 절의 설정 단독 전환 당시 청크 수치는 역사 기록이다.

## 객체 검사기 본문 전환

속성·기하·관계·이력 본문을 inspector-content.tsx로 옮겼다. 기존 inspector.mjs는 선택/탭 표시 모델과 접기·크기 조절을 유지한다. 같은 본문 DOM을 두 구현이 동시에 변경하지 않는다. 탭이나 객체가 바뀌면 이전 본문의 스크롤을 초기화해 첫 행이 가려지지 않게 했다. 해제 함수와 pagehide 처리를 제공하며 bfcache 진입에서는 root를 유지한다.

`npm run build`, 기존 자동 테스트 101개, 확장한 browser-react-panels 검증이 통과했다. 임시 DB의 합성 후보로 실제 앱에서 네 탭을 전환하고 면적 12.5 m²/체적 24 m³, 사용자 속성의 문자 표시, 명시적 첨부, 초안 보존을 확인했다. 저장 초안의 빈 기준을 자동으로 새 후보로 바꾸지 않는 기존 동작을 유지하며 테스트도 후보 버튼을 명시적으로 누른다. [검사기 렌더](../assets/native-workspace/react-inspector.png)를 확인했다. 이 합성 후보는 실호스트 취득 증거가 아니다.

## 수량표 전환

quantity-view.tsx는 검색·객체/유형/레이어 필터·그룹·합계·저장 구성·CSV 링크를 소유한다. quantities.mjs의 비교/모달 진입부는 아직 레거시다. 닫기·재열기에서 이전 React root를 해제한다. 공통 quantityQuerySchema로 서버 쿼리를 검증하고 UI는 수량표·표 구성 응답을 검증한 뒤 사용한다.

101개 기존 자동 시험과 타입 검사, 확장한 브라우저 회귀가 통과했다. 실제 임시 DB/API를 통해 선택 객체 범위와 그룹 조건 저장→빈 검색 결과→강제 조회 실패→마지막 표 및 CSV 필터 보존→저장 구성 재선택→삭제를 검증했다. 삭제 성공 뒤 앞선 조회 완료가 안내를 지우던 경합을 발견해 조회 세대와 안내 세대를 구분했다. [수량표 렌더](../assets/native-workspace/react-quantities.png)를 확인했다. 수량값은 합성 후보이며 새 호스트 계산 검증은 아니다.

## 스케치 좌표 편집 전환

sketch.tsx는 점 좌표의 편집 문자열과 확정 수치를 구분한다. 입력 중에는 값을 유지하고 blur/Enter에서 유효한 수치를 반영한다. 범위 초과·빈 수치는 원래 값으로 되돌리며 오류를 표시한다. 기존 mjs는 삭제했다.

빌드·타입 검사와 브라우저 회귀가 통과했다. 두 점 생성 후 두 번째 U를 4.5로 편집하고 첫 번째 U의 100001 입력을 거절한 뒤, 첨부 결과가 [[0,0],[4.5,3]], XY, reference로 저장됨을 확인했다. 모바일 탭에서 같은 초안을 유지했다. 3D 스냅 알고리즘 추가나 호스트 실행 검증은 아니다.

## 수량 계산·표 구성 저장 코어 전환

quantities.ts와 table-views.ts를 strict TypeScript로 옮기고 비교·검토본·보고서·서버·테스트 참조를 갱신했다. 기존 mjs 파일은 삭제했다. 수량표의 출력 타입은 공통 스키마에서 유도한다. 표 구성의 저장 행은 JSON 해석 후 공통 스키마로 검증한다. 면적/체적을 호스트에 새로 계산시키는 변경은 아니다.

타입 검사·서버 tsc 빌드·101개 자동 시험·실제 임시 HTTP/DB를 사용하는 브라우저 회귀가 통과했다. 기존 CSV 수식 방어, 미상 값 합계, 필터 범위, 프로젝트 격리, 수정 revision 충돌 검사를 유지한다. 전체 저장소·AI 실행 코어 전환 완료를 뜻하지 않는다.
