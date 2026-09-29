---
id: VERIFY-2026-09-28-rhino-attached-sync
title: 현재 Rhino 문서 연결·수정 위임·Live Sync 검증
status: review
version: 0.9
updated: 2026-09-28
owner: agent:codex
related: [SPEC-01, SPEC-02, PLAN-02, H-RHINO-03, H-RHINO-05, AC-17, AC-38]
---

# 현재 Rhino 연결 검증

## 실제 구독 AI와 패널 왕복

`tests/integration/rhino-attached-ai.mjs`에서 보이는 별도 Rhino 시험 문서와 제품 브라우저, 실제 ChatGPT 구독 CLI를 연결했다. 읽기 Sync 결과에서 명시적 연결 Rhino 수정 요청을 시작하고, AI가 RhinoCommon 작업 사본의 박스 높이를 4m→5m로 바꾼 뒤 같은 시험 Rhino 문서에 적용했다. 후속 취득에서 2×3×5m·30m³, 동일 네이티브 ID, 원본 mm 단위를 확인했고 브라우저 재열기에서도 모델을 복원했다. `.vide/rhino-attached-ai/6c222a05-76a3-480e-8741-8efe6a9feb2a/result.json`과 `ai-roundtrip-reloaded.png`가 증거다. 사용자 건축 파일은 이 수정 시험에 사용하지 않았다.

첫 패널 로드는 어셈블리 GUID 누락으로 실패했다. 플러그인 클래스와 같은 어셈블리 GUID를 지정한 후 패널 로드와 위 왕복 시험을 통과했다. 시험 프로세스는 종료했다. UI/서버 타입 검사와 자동 시험 241개도 통과했다. 직접 표시 기준에서 AI 실행 직전에 작업 사본을 준비하며 원본 변경 시 AI 호출 전 중단하는 회귀를 포함한다. AI 답변이 원본 반영 전에 작성됐다는 점을 최종 적용 상태와 함께 표시한다.

사용자가 저장·Rhino 종료를 확인한 뒤 기본 빌드 경로에 새 RHP를 배치했다. 새 사용자 Rhino에서 실제 작업 파일을 열고 VIDE 패널 표시와 문서 연결을 확인했다. 최초 실행 인자의 파일 열기가 적용되지 않아 파일 열기 대화상자로 다시 열었으며, 연결 스크립트는 이미 로드된 어셈블리를 재사용하도록 수정했다. 같은 제품 프로젝트의 후속 Sync는 HTTP 200·succeeded, 43.606초, 표시 조회 10,086개·표시 형상 8,702개·미지원 1,384개였다. 증거는 `.vide/current-sync-result.json`의 요청 `8ec2fc49-8b10-4c2b-8f13-cf3e919a7173`이다. 형상 변경·파일 저장 명령은 보내지 않았다. 패널의 인증 복구 버튼은 구현했으나 사용자 Aside의 인증 복구까지 완료했다고 집계하지 않는다. 복잡한 실제 건축 문서의 전체 AI 편집과 CAD 확대는 아직 별도다.

기준은 SPEC-01.11·SPEC-02.16과 PLAN-02 현재 연결 작업이다. 현재 설치 Rhino 8.34에서 별도 소유 시험 프로세스의 합성 문서를 사용했다. 사용자 작업 문서는 모델 수정 시험에 사용하지 않았다.

| 검증 | 실제 결과 |
|---|---|
| 기존 문서 연결 | mm 문서의 Modified·단위·네이티브 ID 유지, 읽기 연결 시 vide-id 미삽입 |
| 권한·라우팅 | 잘못된 토큰/문서, 생성 코드 실행 메서드 거절 |
| 수정 위임 | 2×3×4 m 박스를 작업 사본 RhinoCommon으로 높이 8 m로 변경, Applications 반영·자동 취득에서 48 m³ 확인 |
| 원본 후속 편집 | 같은 객체 GUID·mm 단위 유지, Rhino Undo로 24 m³ 복귀 |
| Live Sync | 직접 Move 후 세대 증가·취득에서 X=1 m 확인 |
| 충돌·재연결 | 오래된 기준 SOURCE_CHANGED, Disconnect 후 STALE_CONNECTION, 재연결의 새 세션이 옛 대상을 대체하지 않음 |
| 브라우저 | 실제 Chromium 1440×900에서 수동/자동 Sync, 초안 중 자동 취득 보류, 명시적 수정 위임 전송, 연결 해제 시 버튼 비활성 |
| 실패 계약 | 원본 충돌·취소·다른 대상은 적용 0회, 응답 미확인 시 재실행 없음, 반영 성공 후 Sync 실패 구분 |

재현: `node tests/integration/rhino-attached.mjs`, `node tests/integration/browser-attached-sync.mjs`, `node --test tests/server/attached-application.test.mjs`. 실제 원자료는 `.vide/rhino-attached/6d91a06c-2c31-4952-9c1c-7e3d6134c7f2/result.json`, 브라우저 화면은 `.vide/browser-attached/7ee95d83-9770-489d-b571-9d23a3dff8d0/attached-sync.png`에 있다. 임시 원자료·토큰·개인 문서는 커밋하지 않는다. 전체 단위/서버 시험 229건 및 UI/서버 typecheck 통과. 병렬 전체 시험에서 server.test 파일이 한 차례 실패했으나 단독 10건과 재실행 전체 229건은 통과했으며 최초 실패 원인 미확정이다.

## 사용 절차와 남은 검증

Rhino에서 빌드/배포된 VIDE.Worker.rhp를 로드하고 `VIDEConnect`를 실행한다. VIDE에서 열린 호스트 문서 → 문서 조회 → 대상 선택 → Sync. Rhino의 `VIDESync`는 수동 갱신 요청, `VIDELiveSync`는 선택형 자동 갱신 전환, `VIDEDisconnect`는 연결 해제다. 채팅의 `연결 Rhino 수정`은 명시적 Sync 기준 문서만 대상으로 하고, 파일 저장은 Rhino에서 따로 수행한다.

현재 사용자 문서의 읽기/화면 검수는 진행 중이다. 9월 20일 잔류 숨은 Rhino가 MCP 1999를 점유하던 사실을 확인했고 사용자 명시 지시로 그 프로세스만 종료했다. 현재 사용자 Rhino의 형상·파일 저장에는 개입하지 않았다. Rhino 명령칸 자동 입력 도구 실패 후 사용자가 연결 명령을 실행했다. Aside 제품 화면에서 해당 사용자 Rhino 실행본·현재 문서·mm 단위·객체 수 10,713개를 확인했다.

일반 UserData/BIM 관계, 대형 실무 파일 전체 표시, 모든 문서 설정 이벤트, 별도 PC 자동 설치는 미검증이다. 사용자 문서의 실제 채팅 수정은 이번 읽기 검증에 포함하지 않는다. 구독 AI가 이 새 연결 흐름을 끝까지 구동하는 통합 시험은 아직 별도이며, 기존 SDK AI 실행 검증과 이번 Applications 실증을 혼동하지 않는다.


## 중단 후 복구 확인

Fork 후 작업 트리와 서버 상태를 재확인했다. 소유 시험 Rhino는 종료되어 있었고 사용 중인 Rhino 하나와 VIDE 서버만 유지됐다. 잔류 1999 포트는 해제됐다. 타입 검사, 전체 229건, 기존 React 패널 회귀와 새 연결 브라우저 회귀를 다시 통과했다. MD/HTML 재생성 및 변경 파일 포맷을 완료했다. 초안 복원이나 다른 문서로 기준 변경 시 원본 수정 위임을 자동 계승하지 않도록 보완했다.

화면 도구를 초기화한 후에도 `window crop is outside captured monitor` 오류가 재현되어 현재 Rhino의 UI 입력을 자동 수행하지 않았다. 최근 3시간 Windows Application 로그에서 Codex/ChatGPT 충돌·응답 없음 기록은 발견되지 않았다. 이는 Codex 자체 문제가 없다는 증명이 아니며 정확한 중단 원인은 미확정이다. Aside의 접근 허용 폴더 차이 및 재시작 전 브라우저 인증 만료도 이전 도구 실패 원인이었다. 프로젝트·계정 설정 초기화나 사용자 Rhino 종료는 하지 않았다.


## 실제 사용자 문서의 제품 경로

1. 사용자 직접 연결 후 기존 Rhino 실행본이 VIDE 문서 목록에 표시됐다. 최초 Sync는 captureModel 내부의 구형 `pid:startTicks` 검사식 때문에 거절됐다. 공통 hostTargetSchema로 통일하고 세션 UUID를 포함한 대상 유지 시험을 추가했다. 네이티브 직접 호출과 모의 브라우저 API만으로 이 통합 누락을 놓친 것이므로 기존 합성 통과를 제품 전체 통과로 취급하지 않는다.
2. 수정한 서버에서 다시 Sync한 결과 `IMPORT_LIMIT`을 확인했다. 현재 문서는 UI 조회 10,713개·약 386 MB이며 기존 WorkerScene의 10,000개 상한을 넘는다. 연결은 정상, 전체 모델 취득/뷰포트 표시는 미완료다. 파일/형상을 줄이거나 저장·편집하지 않았다.
3. 실제 환경의 다음 작업은 PLAN-02의 대형 문서 Sync 경로다. 이 상한을 이유로 원본을 분할하거나 단순히 숫자를 올려 지원 완료로 선언하지 않는다. 현재 사용자 Rhino 연결은 유지한다.

## 블록 보존 회귀

별도 빌드 `.vide/build/rhino-worker-next/bin/VIDE.Worker.rhp`를 합성 Rhino에만 로드했다. `.vide/rhino-attached/39452021-afd0-42bc-8f20-cb462f40be14/result.json`에서 기존 적용/Undo/재연결 회귀와 블록 포함 네이티브 캡처, 정의만 변경했을 때 지문·Live Sync 세대 변경, 저장본의 정의 형상 삭제 시 재검증 거절을 통과했다. 사용자 Rhino가 이미 로드한 플러그인은 교체하지 않았다. 객체 수/표시 상한은 유지하며 실제 10,713개 문서의 전체 Sync는 여전히 미완료다.

## 큰 모델 표시 페이지

새 빌드에서 10,713개(점·Brep·곡선·메시·블록) 네이티브 보존·저장 재열기 및 11개 표시 페이지 합산을 검증했다. 결과 `.vide/rhino-large-import/5eff997f-4cc4-4beb-b6e6-4ba8be42f7c0/result.json`: 28.661초, 표시 JSON 6,918,453바이트, 표시 10,700개/미지원 블록 13개. 실제 사용자 386MB 파일의 성능으로 일반화하지 않는다.

새 페이지의 단일 응답 축소 재조회·전체 예산·중복/누락·revision/total 변경·불명확 응답 비재시도 8개 자동 회귀를 통과했다. 초기 구현의 첫 페이지 초과 재조회가 빈 결과를 반환하던 루프 조건은 이 회귀에서 발견해 수정했다. 네이티브 계약 상한 시험도 20,000개로 갱신했다.

새 exportPage를 포함한 기존 연결/적용/Undo/블록 회귀는 `.vide/rhino-attached/a0a3f6c7-fbf0-4ebc-9769-a0a646116dab/result.json`에서 통과했다. 직전 실행은 시험 제어 파일 교체가 IronPython 읽기와 경합해 EPERM으로 중단됐으며, 같은 action ID의 파일 교체에 한해 짧은 재시도를 넣고 재실행했다. 제품 네이티브 쓰기를 재시도한 것이 아니다.

사용자는 작업을 저장하고 Rhino를 종료했다. 새 개발 RHP와 제어기를 준비하고 같은 파일을 다시 열었으나 시작 인자의 연결 명령은 실행되지 않았다. 네이티브 입력 도구도 coordinate input geometry is unavailable을 반환하여 연결 스크립트 1회 수동 실행을 요청했다. 실제 문서 Sync는 재연결 뒤 검증 전까지 미완료다.

## 직접 표시 Sync

재연결 후 기존 사본 검증은 숨긴 객체를 제외해 count mismatch를 반환했다. 실제 파일은 블록 정의 포함 10,713개이고 기본 표시 열거는 8,000개였다. 보존/지문 열거에 HiddenObjects를 포함했다. 파일과 열린 문서의 Brep 표현·치수 캐시 차이도 발견했지만, 표시를 위해 편집 검증을 재설계하는 시도는 채택하지 않았다. 읽기 Sync를 현재 Rhino의 고정 `displayPage`로 분리했다.

합성 실호스트 `.vide/rhino-attached/34a9d327-8e3d-456a-89c5-82d687b40edd/result.json`에서 직접 표시의 mm→m 크기, 수량 미계산, 새 3dm 저장 없음과 기존 적용·Undo·Live Sync 회귀를 통과했다. 실제 작업 문서의 기존 복사본을 별도 시험 Rhino에서 조회한 `.vide/display-preflight/fcd5b4f6-95b9-4a0d-a367-a9b3e74ee6a7/result.json`은 37.529초, 8,000개, 107,245,643바이트다. 표시 형상 7,431개와 누락 569개(블록 454·주석 102·Hatch 11·기존 비정상 Brep 2)를 확인했다. 이는 복사본 조회 결과이며 현재 사용자 창의 화면 표시 성공을 뜻하지 않는다. 시험 Rhino는 종료했다.

타입 검사·웹 빌드·239개 자동 시험을 통과했다. 표시 모드에서 기존 비정상 객체 기록을 유지하면서 렌더링에서 제외하고, 편집용 모델 검증은 거절하는 회귀를 포함한다. 빈 뷰포트의 진행/실패 안내·재열기·수동/자동 Sync 브라우저 회귀도 통과했다(`.vide/browser-attached/13d35fff-6e57-45fb-9474-777747f401b8`). 현재 사용자 창에 새 플러그인을 로드한 뒤 실제 Aside 화면을 확인하는 단계가 남아 있다.

복사본 조회 결과를 격리된 제품 저장소에 넣고 실제 Chromium 1440×900에서 건물·주변 형상 표시를 확인했다. 증거는 `.vide/display-preflight/95373982-3070-462e-8778-40223364bc7b/actual-copy-viewport.png`와 `browser-result.json`이다. 첫 시험 데이터에는 UI 필수 취득 시각이 빠져 초기화가 실패했으며, 시각을 채운 뒤 브라우저 오류 없이 표시됐다. 제품 `syncEditor` 응답에는 해당 시각이 이미 포함되어 있다. 이 화면 확인에서 발견한 직접 조회 결과의 잘못된 저장·재열기 완료 문구와 네이티브 파일 버튼을 수정했다. 사용자 실제 세션에서 Sync가 끝났다는 증거로는 집계하지 않는다.

사용자가 새 플러그인으로 재연결한 실제 작업 문서를 제품 서버 `127.0.0.1:63702`의 capture API로 Sync했다. HTTP 200·succeeded, 45.486초, 표시 조회 10,086개, 표시 형상 8,702개, 미지원 1,384개(블록 1,269·주석 102·Hatch 11·기존 비정상 Brep 2)를 현재 프로젝트에 저장했다. 증거는 `.vide/current-sync-result.json`이다. 사용자 Rhino에 생성 코드·형상 변경·파일 저장 명령은 보내지 않았다. 사용자 스크린샷의 빈 화면에는 로컬 인증 만료 안내가 있었으며, 실제 Aside 탭의 인증 재연결과 최종 화면 확인은 별도로 남아 있다. 인증 주소의 Aside 전달은 자동 승인 검토가 명시적 사용자 승인을 요구해 대기 중이다.
