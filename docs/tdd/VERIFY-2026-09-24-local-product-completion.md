---
id: VERIFY-2026-09-24-local-product-completion
title: 로컬 제품 완결 · 실제 왕복 및 확장 검수
status: review
version: 0.28
updated: 2026-09-25
owner: agent:codex
related: [PLAN-02, AC-07, AC-08, AC-09, AC-10, AC-24, AC-25, AC-32, AC-33, AC-34]
---

# 로컬 제품 완결 검수

기준은 PLAN-02 §6.2 L1~L6. 완료된 시험과 미검증 항목을 아래에서 구분한다. 사용자 자료가 아닌 VIDE 소유 합성 문서만 사용한다.

## 실험 범위와 사용량 상한

- L1: 기존 실제 브라우저 Rhino SDK 작업(Claude Opus 4.6 low, 생성/후속 수정 2회), ZWCAD SDK 작업(Codex 계정 기본, 1회)으로 현재 UI와 실행 경로를 연결한다. 공급자 요청당 기존 180초·도구 상한 유지. 실패 요청은 원인 수정 뒤 1회까지만 재시험한다.
- 결정적 실호스트: 후보 고정 적용·기본 도구 편집·저장/재열기와 복수 문서 격리/부분 실패. 모델 추론 없이 합성 코드를 사용한 결과를 실제 AI 결과와 구분한다.
- L2~L6: 각 구현의 계약/실패 테스트를 먼저 추가하고 해당 호스트 또는 브라우저에서 확인한다. 성능 합성 규모는 PLAN-02 §6.2를 따르며 아직 실측하지 않은 숫자를 성능 보증으로 쓰지 않는다.
- 원시 자료는 .vide의 시험별 UUID 폴더에 저장하고 사용자 원본·자격 증명을 문서에 복사하지 않는다. 최신 패키지 배포와 원격 공유는 이번 우선 작업에서 제외한다.

## 현재 관찰

착수 때 확인한 프로젝트 전체 잠금은 대상별 경합 검사로 교체했다. SPEC-02.14 및 ARCH의 현재 계약을 따르며, 아래의 계약·브라우저·실호스트 증거를 구분한다.

## 확인된 결과

- 실제 브라우저 → Claude Opus 4.6 → Rhino SDK 생성 및 핀 후속 수정: 통과. 10×8×6 모델의 체적 480에서 높이 4.5 수정 후 360으로 변경됐고 원본 불변·브라우저 실행 기록 복구도 확인했다. 입력 토큰 3,840/5,077, 출력 353/492; 구독 잔량은 공급자가 제공하지 않았다. 재현: `node tests/integration/browser-sdk-workflow.mjs`. 원시 결과: `.vide/sdk-workflow/1d2d823c-3b8c-4f3c-90b2-89db07d0a336/result.json`. 이 통과는 전체 L1~L6 완료를 뜻하지 않는다.

- 실제 브라우저 → Codex → ZWCAD SDK: 통과(면적 240, 길이 68). 재현: `node tests/integration/browser-zwcad-sdk.mjs codex-cli`. 원시 결과: `.vide/browser-zwcad-sdk/96c0a591-6837-4bac-b492-59321bd8b437/result.json`.
- 위 ZWCAD 시험 후보를 기본 CAD 명령으로 편집: 미저장 대조군·이동/저장·미저장 이동·Save As·문서 닫힘의 5개 시나리오 통과. 원본 후보 파일 해시 불변을 함께 확인했다. 재현: `tests/integration/zwcad-native-edit.mjs`에 위 result.json 경로 전달. 증거: `.vide/zwcad-native-edit/f0e6f9e2-d2f2-4c31-aa20-b73bdbd0919f/passed.json`.
- L2 일부 구현: 프로젝트 전체 잠금을 대상별 경합 검사로 교체했다. 같은 원본의 다른 취득본·후보 계보·연계 대상 경합, 불명확 문서의 추가 쓰기, 독립 2개 상한/동일 요청 재접수 및 다른 호스트 독립을 계약 시험으로 확인했다. 전체 단위/계약 시험 152개 통과.
- 실제 Chromium 결정적 지연 응답 시험: 독립 요청 2개 접수·3개째 대기와 늦은 완료 후 새 초안/기준 보존 통과. 코드: `tests/integration/browser-concurrent-work.mjs`. 이 시험은 UI/스케줄링 회귀이며 두 실제 호스트의 병렬 실행 실증은 아니다.

- Rhino 소유 편집 창 고정 적용 회귀 통과: 추가/수정/삭제 각각 1개, 체적 48, 기존 native ID·속성 보존, 중복 재적용 없음, 낡은 기준 거절, 불명확 영수증 복구. `tests/integration/owned-editor-apply.mjs`, 증거 `.vide/editor-apply/c9094c8f-d453-4ac4-a08c-fc4c4a96d297`.
- 기존 `browser-workspace-controls.mjs` 및 `browser-react-panels.mjs` 실제 Chromium 회귀 통과. 타입 검사·웹 빌드 통과.

- L2 추가 지시: 기존 조건/스케치/자료를 보존해 먼저 저장하고 이전 실행 실제 종료 뒤 새 조건을 실행하는 경로를 연결했다. 종료 전 호출 0회, 중복 요청/변경 요청 구분, 불명확 결과의 재실행 0회, 후속 취소, 다른 대상/권한 거절, 재시작 보존을 결정적 공급자로 검증했다. 전체 단위/계약 159개 통과.
- `browser-intervention.mjs`는 실제 Chromium/로컬 API에서 “추가 지시”→접수/종료 대기 표시→초안 비우기→이전 요청 cancelled/후속 succeeded→새 조건 전달을 확인했다. 실제 장시간 네이티브 연산 중단의 증거는 아니며 중단 불가/결과 불명확은 보류한다. 후속은 원 기준 재실행이며 이전 후보의 부분 완료분을 자동 이어 붙이는 기능은 아니다.

## 연계 후보 후속 초안 — L2

`linkedRequestDraft`는 부모 이력의 오래된 상태 대신 하위 요청의 현재 상태·부모/기준/호스트 관계를 확인한다. 두 저장 후보만 새 기준으로 연결하고 원 핀의 논리/native ID 대응을 검사한다. 조건·권한·실행 상한·첨부를 유지하며 불명확/실패/실행 중 대상이나 대응 불일치는 거절한다. `tests/core/linked-draft.test.mjs`와 단일 복구 회귀 4시험 통과. `browser-linked-followup.mjs`는 실제 Chromium에서 실패한 부모의 두 확인 후보→초안 생성→새로고침 복원→명시 전송을 확인했고 초안 생성 시 실행은 없었다. `browser-recovered-followup.mjs` 회귀도 통과했다. UI 시험은 합성 API 응답이며 새 실제 AI/호스트 실행 증거가 아니다. 후보 없는 실패 대상의 자동 재실행은 여전히 하지 않는다.

보류된 연계 개입도 이전 요청의 종료/동일 대상·좌표·권한을 검증한 뒤 확인된 두 후보와 추가 지시를 유지한다. `browser-linked-followup.mjs --intervention`은 Height 4.5 m 조건·초안 재열기·수동 전송을 통과했다. `linked-execution.test.mjs`는 실제 실행 라우터/저장소와 결정적 도구 대역으로 조회→정책 거절→코드 수정→확인 쓰기→재조회→호출 상한 종료→저장소 재개→후속 초안을 검증했다. 정책 거절 및 상한 이후 쓰기 0회, 성공 쓰기 총1회와 두 후보 유지, 초안 생성 시 재실행 없음. 기존 부분 불명확 시험을 포함한 6시험 통과. 이 경로는 자동 재개가 아니라 사용자의 명시적 후속 실행이며 네이티브 부분 실패의 일반 원상복구를 약속하지 않는다.

## 큰 모델 초기 AI 문맥 — L5 일부

SDK 단일 대상의 초기 객체/수량 요약을 100개·64 KiB로 제한했다. 핀 대상 우선, 전체/포함/생략 수, 실제 정보 재조회 안내를 전달하고 실행기에는 전체 기준 모델과 보호 핀을 유지한다. `tests/server/model-context.test.mjs`의 합성 1만 객체·대형 정점 배열·다국어 byte 상한·빈 모델 및 `execution.test.mjs`의 실제 실행 제어기→SDK 대역 전달을 통과했다(관련 14시험, UI/서버 타입 검사 통과). 원본 자료나 보호 범위를 잘라내지 않으며 기존 JSON 경로는 그대로다. 이 시험은 초기 입력 크기의 검증이고 네이티브 가져오기 500개 상한 확대·조회 페이지화·실제 대형 호스트 지원 완료가 아니다.

## 네이티브 큰 모델 확대 — L5

Rhino 자체 SDK/편집 창 및 TS native 모델의 상한을 1만 객체로 맞추고 측정 캐시 요청을 4 MiB까지 받도록 했다. 레거시 경로의 500개·응답 16 MiB 제한은 유지한다. C# 빌드 경고/오류 0, 타입 검사, 1만 허용/초과·불완전 ID 거절 계약 검증 통과.

- `tests/integration/rhino-large-native.mjs`: 1천 박스(각 체적24), 1만 점의 생성·저장/재열기·전체 ID·export·마지막 페이지 통과. 재열기 후 측정 계산0/재사용 각각1000·10000. 1천 박스 execute2.11초/export2.75초/캐시export1.41초, 1만 점 execute3.06초/export1.29초/캐시export1.43초. JSON 크기는 각각961,143/6,080,225 bytes. 점처럼 계산이 싼 경우 캐시 경로가 더 빠르다는 보장은 없다. 증거 `.vide/rhino-large-native/f4cc23cb-8c6f-4f51-bf87-4a2585196e03/result.json`.
- `tests/integration/browser-large-native.mjs`: 위 실제 3dm을 Chromium UI에서 가져오기→전체 객체 목록→마지막 객체 선택 통과. 각각12.04초/12.44초(호스트 기동 포함). 화면 확인과 pageerror0. 증거 `.vide/browser-large-native/4d780763-4a37-440e-9c67-1b2aabafcfde/result.json` 및 같은 폴더 PNG.
- `tests/integration/rhino-large-apply.mjs`: 1만 점 문서에서 한 객체만5m 이동하는 후보 preview/apply3.61초, 재취득/재열기 후 전체 ID와 좌표 일치. 증거 `.vide/rhino-large-apply/868c3878-33dd-4ac1-a9fa-e80c26fa9b9b/result.json`.

단일 실행 측정이고 모든 하드웨어·복잡 메시의 성능 보증은 아니다. CPU/GPU/호스트 메모리 peak의 체계적 측정과 조밀 네이티브 메시의 전송 한도 대응은 남았다. 초기 시험 디렉터리 부모 누락은 호스트 실행 전 실패했고 하네스 수정 뒤 재실행했다. 원격 공유의 객체/용량 한도를 자동 확장하지 않았다.

## 변경 없는 그룹 보존 — L3 일부

그룹 표(ID/이름/인덱스/사용자 문자열)를 비교하고 문서 지문에도 포함했다. 그룹 객체가 변하지 않으면 독립 객체 수정의 후보 적용을 허용한다. 실제 Rhino 합성 그룹2점+독립1점에서 독립 점5m 이동 적용·재취득/재열기, 그룹 이름/두 멤버의 위치 보존을 확인했다. 그룹 멤버 이동·그룹 이름 변경·그룹 해제 후보는 preview/apply에서 거절했고 매 거절 뒤 대상 지문이 최초 취득과 일치했다. C# 빌드 경고/오류0. `tests/integration/rhino-group-preservation.mjs`, 증거 `.vide/rhino-group-preservation/cb5f91c8-68ad-4d7a-8843-6f11db8f07d2/result.json`.

그룹 생성/구성원 편집·일반 재질/층 편집을 지원 완료로 올리지 않는다. 미리보기 뒤 사람이 그룹을 바꾸는 UI 동시성 조작은 별도 미시험이다. 구현 근거는 설치 RhinoCommon8 XML과 [File3dmGroupTable](https://developer.rhino3d.com/api/rhinocommon/rhino.fileio.file3dmgrouptable?version=8.x), [RhinoDoc.Groups](https://developer.rhino3d.com/api/rhinocommon/rhino.rhinodoc/groups)이다.

## 큰 실행 응답 요약 — L5

Rhino/ZWCAD의 AI용 execute 응답을 첫 페이지로 제한하고 Rhino 변경 ID를 종류별50개/전체 건수로 요약했다. 영수증·후보·보호 비교는 전체 자료를 유지한다. 1만 객체/변경의 제한 응답과 최종 전체 보존, ZWCAD 단일 과대 객체의 저장 성공/생략 안내를 실행기 계약 시험으로 확인했다. 관련24시험·서버 타입 검사 통과. 실제 양쪽 호스트120개 생성에서 execute50개 요약→3페이지 조회→최종120개 후보 보존도 통과했다. 코드 `tests/integration/native-query-pages.mjs`, 최신 증거 `.vide/native-query-pages/4080e59b-dc09-402a-8c75-2701e68c5745/result.json`.

## 큰 TCP 결과 수신 — L5 일부

공통 수신부의 청크별 전체 버퍼 재복사를 제거하고 길이 검증 뒤 본문 버퍼 1회 할당/조각별 복사로 바꿨다. `tests/core/host-frames.test.mjs`와 `owned-host.test.mjs` 11시험 통과: 분할 헤더·다국어 수 MB 본문·빈/16 MiB 초과 길이·미완성 종료·잘못된 JSON·호스트 거절·소유권 검사/timeout 뒤 전송 0회. 서버 타입 검사 통과. 실제 전송 시간 개선 수치는 측정하지 않았다.

## 객체 페이지 조회 — L5 일부

`query`의 offset/limit·objectIds·expectedRevision을 공통 도구와 양쪽 SDK·연계 라우터에 연결했다. 합성 1만 객체의 중복/누락 없는 페이지 순회, UTF-8 byte 제한, 과대 행 명시 실패, 낡은 revision 거절, 단위/대응 scene 보존 및 공식 MCP 클라이언트 인수 전달을 계약 검증했다. 실제 설치 Rhino와 ZWCAD에 각각 120개 합성 객체를 생성한 뒤 50/50/20개 3페이지와 마지막 ID 필터를 조회하고, 잘못된 revision 거절·최종 네이티브 후보 120개 보존을 확인했다. 재현: `tests/integration/native-query-pages.mjs`. 증거: `.vide/native-query-pages/1281b26a-6254-494c-8141-7beea48346c8/result.json`. 모델 추론 없는 결정적 SDK 시험이다. 페이지 제한은 AI query 응답에만 적용되며 native IPC, execute 반환/영수증, 호스트 가져오기 500개 제한은 이번에 확대하지 않았다.

## 큰 모델 뷰포트 측정 — L5 일부

실제 Chromium headless(`--enable-unsafe-swiftshader`)의 단일 실행 수치다. 시작/반복 편차나 실제 GPU 전체의 성능 보증이 아니며 호스트 가져오기 시험과 구분한다. 시험 코드는 `tests/integration/browser-large-model.mjs`이며 기존 `browser-support.mjs`의 테스트 전용 fixture를 사용한다.

| 합성 자료 | 변경 전 표시+첫 프레임 | 변경 후 표시+첫 프레임 | 변경 후 선택 왕복 |
|---|---|---|---|
| 독립 점 1,000개 | 45.6 ms | 40.4 ms | 48.9 ms |
| 독립 점 10,000개 | 197.9 ms | 185.6 ms | 25.8 ms |
| 메시 1개 · 131,072 삼각형 | 297.2 ms | 298.3 ms | 중앙 객체 선택 통과 |

- 변화 없는 300 ms 동안 두 뷰포트의 WebGL clear 호출 합계 38→0. 주된 개선은 유휴 GPU 작업 제거이며 로딩 속도 개선으로 단정하지 않는다.
- 카메라·크기·형상·선택·스케치 변경 시만 렌더링한다. 선택 표시는 이전/현재 객체만 갱신하고, 동일 스케치 입력은 GPU 버퍼를 재생성하지 않는다. 새 표시 입력은 재렌더되고 동일 입력은 재렌더되지 않는 회귀 통과.
- 모델 교체 후 추적한 WebGL buffer 8→4(두 뷰포트의 그리드 등 유지 자산), 기존 모델 버퍼 해제 확인. 대형 좌표 90,000에서 2 mm 세부 및 직교/원근 선택·핀 회귀 통과(`viewport-check.mjs`).
- 원시 자료: `.vide/viewport-spike/large-model-before-57b970c0-66f3-4bdd-900a-3ec0b5fcf650.json`, `.vide/viewport-spike/large-model-after-e52f615e-0ccc-40fb-b84a-bc08faad9afc.json`.
- 미완료: Rhino 수신/캡처의 기존 500객체 제한, 많은 개별 Brep의 메시 생성 비용, 전체 목록 UI의 가상화·장시간 메모리 검수. 점 1만 개 통과를 네이티브 BIM 1만 객체 지원 완료로 보고하지 않는다.

## Rhino 측정 및 기본 편집 재검증 — L1/L4 일부

- `worker-measurements.mjs`가 실제 Rhino에서 통과했다. 무변경 4객체 계산 0개, 형상 1개 수정 시 계산 1개/재사용 3개, 속성 이름만 바꾼 객체는 재사용. 평행이동은 전체 기하 일치가 확인돼 측정을 재사용하면서 변경 집합에는 geometry 변경으로 기록했다. 회전은 재계산, 2배 스케일은 체적 24→192 재계산, 삭제 객체는 export/집계에서 제외됐다. 증거: `.vide/worker-measurements/14452f9a-6975-406e-86ae-9637084d8b21/result.json`.
- 앞선 이벤트 기반 실험은 직접 ObjectTable.Transform의 재사용 예상에서 실패했다(실측 계산 3개/재사용 1개). 이벤트를 근거로 한 구현은 제거했고, 정확한 기하 일치로 확인한 평행이동만 채택했다. 회전 재사용은 하지 않으며 사용자 Sync 캐시 연결은 아래의 후속 검증을 따른다.
- Computer Use로 소유 시험 창에서 Rhino 기본 Move를 월드 X +1 m, Save As를 수행했다. 독립 실행본 재열기에서 기존 native ID/속성·체적 48 보존 통과. 증거: `.vide/native-editor-followup/eb88649f-2ade-4bb7-931d-9c76126014e0/result.json`. Save As 뒤 읽기 전용 안내도 재현됐으므로 저장 성공과 안내 문제를 분리한다. 이 안내의 원인은 아직 해결하지 않았다.

## 실호스트 병렬 및 저장 상태 진단

- `native-concurrent-work.mjs`: 같은 프로젝트의 Rhino·ZWCAD가 모두 실제 query를 완료하고 동시에 running인 것을 확인한 뒤 각각 생성했다. Rhino 체적 24, ZWCAD 면적 6, 서로 다른 대상·파일과 두 succeeded 결과 통과. 증거: `.vide/native-concurrent-work/26ff7771-24f5-4a89-86c0-96ec24c8f995/result.json`. 공급자는 결정적 대역이며 구독 모델의 동시 추론 성능을 측정한 것은 아니다.
- `native-concurrent-work.mjs --cancel-rhino`: 두 실제 호스트의 query 완료 후 Rhino 요청만 취소했다. Rhino cancelled·ZWCAD succeeded(면적 6) 통과. 증거: `.vide/native-concurrent-work/f978666c-45fb-486d-bc94-e106eafaed5f/result.json`. 쓰기 이전 취소이며 진행 중인 네이티브 연산 강제 중단 검증은 아니다. 첫 대역은 일반 Error를 던져 failed로 판정됐고, 실제 공급자 계약인 CANCELLED 코드로 맞춘 뒤 재검증했다.
- `native-editor-followup.mjs --inspect-save`: 열기 readOnly=false → 기본 Save As 직후 true → capture 후 true. ID·속성·체적 48·월드 X 1 m 이동·독립 재열기는 통과했다. 증거: `.vide/native-editor-followup/3109942e-7bbe-47b8-9551-dcb853cd0176/result.json`. 따라서 경고는 capture 이전부터 발생한다.
- VIDE 플러그인을 로드하지 않는 새 Rhino 창의 대조 시험도 기본 Save As 뒤 readOnly=true와 동일 경고를 재현했다. `rhino-saveas-control.mjs --command`, 증거 `.vide/rhino-saveas-control/71a3c045-dcba-46f6-ae8d-c1edbb773f47/result.json`. 현재 Rhino 프로필/설치 플러그인을 포함한 환경에서의 결과이며 Rhino 자체 결함으로 단정하지 않는다. SDK SaveAs만 호출한 대조군은 readOnly=false지만 Path=null·Modified=true여서 사용자 기본 저장과 동등하지 않다(`97bf2fc8-5cef-416b-897c-8bb8adb923d9`). 경고 숨김·사용자 설정 변경은 하지 않았다.
- 독립 대조 시험 초기 3회는 Windows 시작 인자 인용이 달라 스크립트가 시작되지 않아 시간 초과했다. 기존 worker와 동일하게 windowsVerbatimArguments를 적용한 후에만 위 결과를 얻었다. 시간 초과를 저장 실패 증거로 쓰지 않는다.
- 진단 응답에 optional readOnly를 추가하고, capture 전후 이 값도 보존 검사한다. 새 빌드의 `owned-editor.mjs`에서 열기/취득 readOnly=false와 원본 해시·체적 24 보존 통과(`.vide/owned-editor/282a7543-6153-46e9-ab7a-e0820badc8dc/result.json`). 지원되지 않는 구 실행본의 누락 값을 false로 해석하지 않는다.

## 수동 Sync 측정 캐시 — L4 후속

- 같은 프로젝트·Rhino 인스턴스·문서의 마지막 성공 취득 결과에서만 측정값을 읽는다. 계산 버전 1과 객체 ID·기하 SHA256이 일치할 때만 재사용한다. 버전/해시 누락·다른 문서·잘못된 값의 재사용 거절을 계약 시험으로 확인했다.
- 실제 Rhino 파일 가져오기: 이전 4객체 캐시와 비교해 형상이 변경된 2객체만 계산하고 무변경 1객체를 재사용했다. 삭제 객체는 결과에서 제외됐다. 그 결과를 다시 가져오면 계산 0개/재사용 3개다. `worker-measurements.mjs`, 증거 `.vide/worker-measurements/beb84cb2-bdad-456d-a24b-3ea4f9a3d141/result.json`.
- 실제 Chromium → 소유 Rhino 편집 창 → 후보 적용 → Sync: 체적 24→48, 변경 객체 계산 1개/재사용 0개. 제어기 재시작 뒤 같은 문서를 다시 Sync하면 계산 0개/재사용 1개이고 체적은 유지됐다. `browser-owned-editor.mjs`, 증거 `.vide/browser-owned-editor/a3d2c1a5-db51-4dc2-b1e4-dea6b3f87882/result.json`. 해당 실행의 JSON에는 캐시 전용 플래그가 없지만 시험의 measurementStats assertion까지 통과했다. 이후 재현용 출력에는 전용 플래그를 추가했다. 공급자는 결정적 대역이며 구독 모델 추론 시험은 아니다.
- 초기 네이티브 빌드는 변수 이름 충돌로 실패했고 이전 DLL로 시작한 시험도 실패했다. 변수 이름 수정·새 DLL 빌드 성공 후 위 두 시험을 재실행해 통과했다. 이전 실행은 검증 증거로 집계하지 않는다.
- 한계: 기하 해시 생성·메시 생성 비용 자체는 남는다. Sync의 Undo 복귀 조합 및 대형 모델 시간은 추가 검증 대상이다. 단위 환산은 아래의 추가 검증을 따른다. 원본의 이동/회전은 해시가 달라지면 재계산한다. 자동 Live Sync 지원으로 확대 해석하지 않는다.

## 유형별 고정 적용 및 새 객체 측정

- 실제 Rhino Curve·Extrusion·Mesh·Point의 후보 이동(월드 10/20/30 m)·사용자 문자열 수정→소유 편집 창 적용→재취득→독립 재열기 통과. 객체 유형·native ID·속성·수량·이동 좌표를 대조했다. `owned-editor-types.mjs`, 증거 `.vide/editor-types/d0c2e6ac-cd53-4dc0-8d46-3ddd0c1049b4/result.json`. 기본 호스트의 수동 편집/저장 UI, 그룹·재질·관계 보존의 일반화는 이 시험에 포함하지 않는다.
- Sync 추가 회귀: 새 박스 1개(체적 6)만 계산하고 기존 3객체는 재사용했다. 기존 객체의 Level 문자열 변경도 취득 결과에 반영됐으며 기하가 같아 측정을 재사용했다. 앞선 캐시 시나리오 전체와 함께 통과했다. 증거 `.vide/worker-measurements/4462c559-5449-4b0f-abc9-6191f607e70c/result.json`.

## 단위 환산 측정 — L4 후속

`rhino-measurement-units.mjs`가 실제 Rhino에서 통과했다. 동일한 물리 크기의 m 및 mm 파일을 작업 단위 m로 정규화했을 때 체적 24·면적 52가 일치했다. 같은 수치 좌표를 mm로 해석해 실제 크기가 달라진 파일은 기존 측정을 재사용하지 않고 1객체를 계산했으며 체적 0.000000024·면적 0.000052가 일치했다. 객체 ID가 같다는 이유로 이전 수량을 쓰지 않았다. 증거 `.vide/measurement-units/b7dd1b6d-25c4-41f9-a2ff-79291928219e/result.json`. 합성 파일·단순 박스의 결과이며 임의 사용자 단위/복잡한 형상의 수치 정밀도 전체 검증은 아니다.

## 실제 SDK 진행 표시 — L6 일부

- 양쪽 SDK에서 조회 완료 2회·실행 시도 3회·저장 검증 2단계를 구분했다. 첫 컴파일 실패는 완료로 세지 않고, 이후 두 성공과 공급자 오류 뒤 불명확 결과의 마지막 진행값을 유지한다. `tests/server/sdk-execution.test.mjs`, `zwcad-sdk-execution.test.mjs`의 성공/실패 4개 회귀 통과.
- 첫 저장 이후의 조회·응답 진행은 host phase를 유지해 재시작 시 결과 확인 경로를 잃지 않도록 했다. 이 값은 작업 사본의 저장 검증이지 원본 적용 완료가 아니다.
- 실제 Chromium에서 `조회 2회 · 실행 3/12 · 사본 저장 검증 2단계` 표시와 기존 독립 요청/지연 응답/새 초안 보존이 함께 통과했다(`browser-concurrent-work.mjs`). 화면 시험은 결정적 HTTP 응답 대역이며 구독 모델 작업 완료율 시험은 아니다. 타입 검사와 웹 빌드 통과.
- 남음: 호출·시간 상한의 사용자 조절, 중단 원인별 재개, 부분 완료 후보 탐색의 전체 UI 연결. 고정 12회 표시는 현재 호스트 실행 상한이며 전체 작업 단계 수가 아니다.

## 복구 후보에서 후속 작업 — 2026-09-25

SDK 영수증으로 복구한 사본에 recovered 표시를 추가하고 목표 전체 완료와 구분했다. 원 조건·스케치·자료·권한을 유지해 복구 후보를 기준으로 후속 초안을 만든다. 원 기준 핀의 논리 ID/native ID가 일치하지 않으면 자동 재연결을 거절한다. 불명확 요청·다중 대상 일괄 복원도 거절한다. `request-draft.test.mjs`의 조건·핀·복사본 독립성·거절 시험 통과. `browser-recovered-followup.mjs`는 실제 Chromium에서 목표 미확인 표시→후속 초안→자동 실행 0회→명시 전송의 기준/보존 핀/자료 연결을 확인했다. 화면 시험은 HTTP 대역이며 실제 모델 추론·복수 대상 재개 완료의 증거는 아니다. 타입 검사와 웹 빌드 통과.

## 객체 목록 갱신 — L5 일부

`browser-object-list.mjs`의 실제 Chromium 합성 10,000행 시험: 최초 DOM 구성 16.1 ms, 100회 선택 갱신 합계 5.4 ms, 자식 노드 변경 0건. 포커스·행 동일성·단일 선택·클릭 대상·이름 변경·순서 변경·삭제·빈 목록을 확인했다. 시간은 한 번의 실행에서 측정한 JavaScript DOM 갱신 시간이며 paint·호스트 취득·전체 사용자 지연이나 성능 보장을 뜻하지 않는다. 타입 검사·웹 빌드 통과. 같은 목록도 비교는 O(n)이며 가상화는 아직 적용하지 않았다. 네이티브 500객체 한도는 별개다.

## 실제 Undo/Redo 및 실행 중 취소 — 2026-09-25

- `rhino-measurement-undo.mjs`: 소유 Rhino 합성 문서에서 기본 `_Undo`/`_Redo` 명령으로 크기·속성 변경과 삭제를 되돌렸다. 체적 24→48→24→48, Level L01→L02→L01→L02, native ID 보존을 재열기로 확인했다. 변경/Undo/Redo마다 변경 객체 1개만 계산, 무변경 객체 1개 재사용. 삭제 시 계산 0개·재사용 1개, 삭제 취소 시 복원 객체 1개 계산. 증거: `.vide/measurement-undo/51e72daa-2bb5-47fc-ba1e-92524f6685a2/result.json`. 초기 직접 RhinoDoc.Undo 호출 시험은 Redo에서 실패해 실제 사용자 명령 경로로 검증했다. 일반 복잡한 Undo 이력 전체의 보증은 아니다.
- `native-sdk-interruption.mjs`: 실제 Rhino의 4초 제한 연산에서 실행 직전 영수증을 확인하고 취소했다. 공급자 대역은 즉시 취소됐지만 네이티브 호출이 끝날 때까지 SDK 수명이 유지됐다. 결과는 성공/중단 확인으로 위장하지 않고 HOST_RESULT_UNKNOWN, 명시적 영수증 복구 뒤에만 체적 24 후보를 확인했다. 실행 1회·재전송 0회. 증거: `.vide/native-sdk-interruption/5fb6cfac-d575-4055-81cf-ebd14d086ab7/result.json`. 호스트 강제 중단이 아니라 종료 대기·늦은 결과 격리의 검증이다.
- SDK 복구 결과에 마지막 관측 진행값을 보존하고 ZWCAD의 누락된 sourceDocument를 복원했다. ZWCAD 영수증 회귀에서 대상 문서·기준·진행 정보 보존 및 execute 0회 통과. 양쪽 SDK 계약 시험 15개 통과.

## 요청별 실행 상한 — L6

초안 메뉴의 작업 상한 모달에서 도구 호출 수·대상별 SDK 명령 수·AI 응답 시간을 설정하고 접수 입력에 고정한다. 이전 요청의 기본값은 유지하며 명시 설정은 초안 저장/재열기·실패 복원·개입에서 보존한다. 단일/연계 도구 라우터와 양쪽 SDK·공급자 timeout에 연결했다. `execution-limits.test.mjs`와 양쪽 SDK 시험에서 잘못된 경계 거절, 명령 상한 초과 시 추가 호스트 호출 0회, 이전 성공분 복구 가능 상태, 설정된 timeout 전달을 확인했다. `browser-execution-limits.mjs`는 Chromium 1440×900에서 모달 폭·설정·취소·초안 재열기·실제 접수 API/공급자 인수 연결을 통과했다. 공급자 응답은 대역이다. 상한 확대를 복잡한 과업 성공이나 네이티브 강제 중단 보증으로 해석하지 않는다.

## 남은 검증

독립 실호스트 병렬은 위 합성 범위에서 통과했다. 네이티브 연산 중 중단·원본 충돌 및 개입 후 부분 완료분의 세밀한 재사용, Rhino Save As의 환경 원인 해소, L3~L6 전체는 완료 처리하지 않는다. 현재까지의 시험 성공을 전체 제품 완결로 해석하지 않는다. 후속 연구의 계획은 PLAN-05·06으로 분리하며, 그 작성으로 이 묶음의 미완료 검증을 완료 처리하지 않는다.

## 조밀 네이티브 메시 — L5

`rhino-dense-mesh.mjs`에서 256×256 격자 메시(66,049 정점·131,072 삼각형)를 실제 Rhino에 만들었다. 저장/재열기 후 ID·정점·인덱스·면적 65,536 m²가 일치했고 수량 캐시는 measured 0/reused 1이었다. 생성 3.12초·export 2.44초·재열기 6.60초·캐시 export 2.39초, JSON 약 2.90 MB다. 계측에서 메모리 조회 시간을 제외한 재시험 원시 자료는 `.vide/rhino-dense-mesh/c4f1c6f4-f41b-4b62-afca-d0ad2d72c79c/result.json`이다. 캐시는 수량 재계산을 줄였지만 전체 export 속도 향상은 입증하지 못했다.

동일 기하의 최초 시험 파일을 `browser-large-native.mjs`로 가져와 실제 Chromium 표시·선택·객체 누락 없음·pageerror 0을 확인했다. 기동 포함 가져오기/표시 12.98초, JS heap 약 5.97→47.09 MB, 측정 시 Node RSS 약 181.14 MB. `.vide/browser-large-native/535e0fca-c509-488e-8717-994ff085b479/result.json`과 `dense-mesh.png`를 확인했다. `rhino-large-apply.mjs ... dense-mesh`는 메시 Z+5 후보 미리보기/적용 5.74초, 저장 사본 재열기 후 같은 native ID·변경 위치를 확인했다(`.vide/rhino-large-apply/e11a3930-4f4c-4f5d-976c-96cb97fe8588/result.json`). 사용자 문서·실제 AI 추론은 사용하지 않았다.

각 Node RSS와 Rhino working/private/peak working set은 원시 결과에 남겼다. Rhino peak는 프로세스 전체 수명 값이며 브라우저 CDP JS heap은 GPU/전체 브라우저 메모리가 아니다. 단일 평면 격자 실증을 모든 복잡 BIM 모델·프레임 상한 초과·운영 메모리 보증으로 확대하지 않는다.

## 그룹 객체 편집 확대 — L3

그룹 표·객체별 소속을 유지한 기존 그룹 객체의 이동(Z+5)과 사용자 문자열(Level=L02) 수정 후보를 소유 편집 창에 적용하고 저장/재열기 후 동일 native ID·그룹 이름/2개 구성원·무관 객체 불변을 확인했다. 독립 객체 수정 회귀도 통과했다. 그룹 이름 변경·해제·구성원 삭제·신규 구성원 추가는 미리보기/적용 전에 거절하고 원본 지문 불변을 확인했다. `tests/integration/rhino-group-preservation.mjs`, `.vide/rhino-group-preservation/fe5b21f4-8cbe-4ca9-a55a-8bf6e955ab03/result.json`. C# 빌드 경고/오류 0. SDK `ObjectAttributes.GetGroupList()`는 설치 RhinoCommon.xml에서 null/그룹 인덱스 반환을 확인했다. 기존 검수의 그룹 이동 거절은 이전 구현 기준이며 현재 지원은 이 절과 호스트 지원표를 따른다.

## SaveAs 경로 대조 추가 — L1 미해결

`rhino-saveas-control.mjs --command --save-in-temp`로 저장소 밖 임시 경로와 기존 경로를 비교하려 했으나 현재 두 경로 모두 RunScript가 명령 이력 없이 Cancel/false로 끝났다. Idle 실행으로 옮겨도 동일했다(임시 경로 `6be9f3a4-1f81-4219-b153-f9c466a37644`, 기존 경로 `3ab36219-ec41-4b71-94ba-3d21da043d99`; `.vide/rhino-saveas-control/` 아래). 저장되지 않았으므로 경로별 읽기 전용 비교의 유효 표본이 아니다. 앞선 SaveAs 성공/읽기 전용 재현 기록을 대체하지 않는다.

`--inspect`의 소유 합성 창을 Computer Use로 확인했을 때 차단 모달은 없었다. UI에서 SaveAs의 파일명 프롬프트는 열렸지만 텍스트 붙여넣기가 Rhino Paste 명령으로 해석돼 파일 저장 확인까지 가지 못했고, 120초 수명 종료로 시험 창이 닫혔다. 사용자 문서/설정은 변경하지 않았다. Rhino 공식 [SaveAs 문서](https://developer.rhino3d.com/api/rhinocommon/rhino.rhinodoc/saveas)는 API 기능 근거이며 이번 취소/읽기 전용 원인을 설명하는 증거는 아니다. 해결했다고 표시하지 않는다.

### SaveAs 시작 명령 대조 결과

Python/Idle 안의 RunScript 취소와 분리하기 위해 `rhino-saveas-control.mjs --macro --save-in-temp`로 Rhino 시작 명령에서 직접 SaveAs를 실행했다. 명령 파일명은 Windows 역슬래시 경로를 사용한다. 괄호로 감싼 경로 및 슬래시 경로는 실제 명령 화면에서 디렉터리 오류가 확인되어 시험 코드를 수정했다. 저장소 경로에서는 파일 생성과 읽기 전용 경고까지 관찰했으나 안내 확인 전 90초 종료로 상태 JSON은 얻지 못했다(`83968298-b45d-41d6-9161-7cd9def7400b`).

임시 경로의 유효 결과는 `.vide/rhino-saveas-control/e2752874-60ea-4412-a411-9d00e75182c3/result.json`이다. Computer Use로 정보 안내만 확인했고 경고 비표시 설정은 변경하지 않았다. `saved=true`, `commandResult=Success`, `modified=false`, `Path` 일치, 파일 쓰기 가능을 확인했지만 문서는 `IsReadOnly=false→true`였다. VIDE 플러그인 없이 저장소 밖에서도 재현하므로 저장소 경로만의 문제나 VIDE 취득 코드만의 문제로 단정할 수 없다. 이 진단의 종료 성공은 정상 반복 저장 완료 판정이 아니다. 소유 시험 창은 종료했으며 사용자 문서와 설정은 변경하지 않았다.

Rhino [파일 설정 설명](https://docs.mcneel.com/rhino/8/help/en-us/options/files.htm)은 잠금 파일과 읽기 전용 열기의 관계를 설명한다. 과거 [McNeel 재현 기록](https://discourse.mcneel.com/t/rhino-opening-every-file-as-read-only/104308)의 다른 버전 문제를 현재 원인으로 단정하지 않는다. 남은 진단은 설치 환경·파일 잠금 상태의 읽기 전용 확인이며, 사용자 설정이나 플러그인 비활성화를 자동 우회책으로 적용하지 않는다.

추가로 저장 없는 설정 조회(`rhino-saveas-control.mjs --settings`)에서 `FileLockingEnabled=true`, `FileLockingOpenWarning=true`를 확인했다(`.vide/rhino-saveas-control/d8ac3faa-c7a0-43f8-ba47-16df43e14c19/result.json`). 파일 잠금이 꺼져 있기 때문이라고 결론 내릴 수 없다. 최초 설정 조회 스크립트의 괄호 오류를 수정한 뒤 얻은 결과이며 제품 저장 시험은 아니다.

## 실제 응답 상한 초과와 재실행 방지 — L5

`rhino-oversize-recovery.mjs`에서 640×640 격자(819,200 삼각형)를 자체 Rhino SDK로 한 번 생성/저장했다. 이어지는 export는 16 MiB 응답 제한으로 거절됐고, SDK 실행은 전체 결과가 확인되지 않은 `HOST_RESULT_UNKNOWN`으로 남았다. 내부 원인의 `HOST_RESULT_TOO_LARGE`가 모델 스키마 오류로 사라지지 않도록 읽기 응답 처리를 보완했다. 크기 제한을 늘리거나 부분 모델로 성공을 표시하지 않았다.

복구는 저장 후보를 새 소유 Rhino에서 다시 읽기만 했고 같은 export 제한을 반환했다. 쓰기 호출은 전후 합계 1회, 양쪽 소유 프로세스 종료 2회, 저장 영수증 바이트와 3dm SHA-256 불변을 확인했다. 증거: `.vide/rhino-oversize-recovery/cc11958d-f193-4873-a81f-4315e877fa97/result.json`. 이는 초과 모델의 정상 표시 지원이나 자동 축소 복구의 완료를 뜻하지 않는다.

## 빈 층의 조용한 누락 방지 — L3

`rhino-layer-preservation.mjs`에서 객체가 없는 층의 추가·삭제·이름 변경·사용자 문자열 변경을 각각 후보에 만들고 적용 미리보기와 실제 적용이 모두 쓰기 전에 거절되는지 확인했다. 매 거절 뒤 대상 문서 지문은 같았다. 같은 층 표에서 객체 하나만 이동한 경우 적용·취득·독립 재열기를 통과했고 객체 native ID와 빈 층 이름/사용자 문자열이 유지됐다. 증거: `.vide/rhino-layer-preservation/f438a020-6347-4697-bcb6-bfefa9b61fb3/result.json`.

`EditorApplication`의 검사를 참조된 층 일부에서 전체 활성 층 목록으로 옮겼다. ID·부모·이름·표시 색/가시성/잠김·출력 속성·선종류/렌더 재질 참조·사용자 문자열을 비교하며 후보 층 인덱스를 대상 인덱스로 대응한다. 신규 층 편집이나 모든 플러그인 UserData 보존의 지원 선언은 아니다.

## 평면 CAD LINE 지원 확대 — L3 · H-ZWCAD-06

`zwcad-linear-entities.mjs`의 LINE 2개+닫힌 Polyline 1개에서 기존 5m LINE을 10m로 끝점 수정·색 변경하고 다른 LINE을 삭제·새 1m LINE을 추가했다. 미리보기의 추가/수정/삭제 각 1개, 고정 적용, 영수증 재조회, 독립 재열기에서 기존 Handle·LINE 유형·색과 무변경 Polyline의 scene 전체를 확인했다. 낡은 기준 적용은 거절됐고 비평면 LINE 후보는 성공으로 반환하지 않았다. 입력 원본 해시는 유지됐다. 증거: `.vide/zwcad-linear-entities/ce5210be-7d42-4257-b5cd-c6543646030d/result.json`.

`browser-dwg-sdk-import.mjs --linear`에서 실제 Chromium으로 혼합 DWG를 가져와 세 객체·LINE 길이 1/10m·Polyline 면적 6m²를 검증하고 선택 강조 화면을 확인했다. 원본 해시 유지·pageerror 없음. 증거: `.vide/browser-dwg-sdk/0a52caaf-5952-479d-b3cc-3897de9f6c1f/result.json`, 같은 폴더의 `import.png`. 최초 검사 실행본은 시작 timeout이었고, 보이는 소유 실행본으로 재현해 ZWCAD의 충돌 진단 전송 대기 창을 확인했다. 외부 전송/설정 변경 없이 아니오를 선택한 뒤 ready가 생성됐고 재검증이 통과했다. 시작 충돌의 근본 원인이 해결됐다고 단정하지 않는다.

`zwcad-native-edit.mjs --move-only`는 같은 혼합 문서에서 ZWCAD 기본 Move·QSAVE와 저장 파일 재열기를 확인했다. 모든 Handle·nativeType·길이/면적이 유지됐고 선택 기준 좌표는 1m 이동했다. `.vide/zwcad-native-edit/3e772e78-c0ee-40f1-aec2-023ef094d328/passed.json`. 생성 코드는 결정적 SDK 시험이며 이번 LINE 과업의 실제 구독 AI 작성 시험을 뜻하지 않는다.

제품 연결은 혼합 모드를 자체 SDK에 전달하고 구 SDK 미설정 시 이전 템플릿으로 우회하지 않는다. 혼합 기준의 연계 입력 허용/미지원 모드 거절, 기존 정점 템플릿의 혼합 모드 거절을 계약 시험했다. UI는 작업 사본으로 표시하고 전송 안내에 LINE을 포함한다. 확장 데이터·잠김·그룹·다른 단위 편집 제한은 유지한다.


## 두 호스트 실행 중 실제 개입·복구 — L2·L6

`browser-linked-hosts.mjs --intervene`에서 ZWCAD 경계를 260m²로 수정한 뒤 Rhino가 6m 돌출(1560m³)과 10초 제한 연산을 수행하는 동안 브라우저의 추가 지시로 “높이 4.5m, CAD 경계 유지”를 접수했다. 100ms 뒤에도 부모 실행은 종료 대기였고 새 공급자 호출은 없었다. 종료 뒤 두 쓰기는 불명확, 추가 지시는 보류 상태였다. 명시 reconcile로 각각 저장된 후보만 다시 읽어 면적·체적·native ID를 확인했다. 각 호스트 execute 시도 1회, 공급자 대역 호출 합계 1회, 원본 두 파일 해시 불변이다.

서버를 실제 종료/재시작한 뒤 보류된 요청의 “확인된 후보에서 이어가기”를 눌러 새 조건과 두 확인 후보를 초안으로 복원했다. 자동 실행 0회, `held-intervention.png`에서 원 조건/추가 지시/보류 이유/연계 첨부를 확인했다. 증거: `.vide/browser-linked-hosts/d0009fb6-bee7-40c3-94c9-c3206e9e0dd4/passed.json`. 이는 저장된 6m 후보의 복구이며 새 4.5m 목표를 수행한 결과가 아니다. 실제 구독 추론·원본 적용은 이 시험에 포함하지 않는다.

첫 검수에서 연계 전송 후 입력창의 대상 첨부 초기화 때문에 추가 지시가 비활성화되는 결함을 찾았다. 별도 대상을 지정하지 않았고 기존 단일 기준이 같은 입력은 클릭한 상위 요청의 두 기준/좌표계를 이어받도록 수정했다. 다른 명시 대상·호스트·권한 거절과 서버의 원 조건/핀 보호는 유지한다. 하위 작업의 중복 추가 지시 버튼도 제거했다. 잘못된 시험 한글 선택자를 수정한 뒤 위 실검증이 통과했다. 관련 계약 시험 18개와 기존 단일 요청 브라우저 개입 회귀도 통과했다.
