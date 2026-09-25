---
id: VERIFY-2026-09-24-local-product-completion
title: 로컬 제품 완결 · 실제 왕복 및 확장 검수
status: review
version: 0.14
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

## 큰 모델 초기 AI 문맥 — L5 일부

SDK 단일 대상의 초기 객체/수량 요약을 100개·64 KiB로 제한했다. 핀 대상 우선, 전체/포함/생략 수, 실제 정보 재조회 안내를 전달하고 실행기에는 전체 기준 모델과 보호 핀을 유지한다. `tests/server/model-context.test.mjs`의 합성 1만 객체·대형 정점 배열·다국어 byte 상한·빈 모델 및 `execution.test.mjs`의 실제 실행 제어기→SDK 대역 전달을 통과했다(관련 14시험, UI/서버 타입 검사 통과). 원본 자료나 보호 범위를 잘라내지 않으며 기존 JSON 경로는 그대로다. 이 시험은 초기 입력 크기의 검증이고 네이티브 가져오기 500개 상한 확대·조회 페이지화·실제 대형 호스트 지원 완료가 아니다.

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
