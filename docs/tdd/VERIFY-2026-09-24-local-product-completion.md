---
id: VERIFY-2026-09-24-local-product-completion
title: 로컬 제품 완결 · 실제 왕복 및 확장 검수
status: review
version: 0.4
updated: 2026-09-24
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

코드 대조 결과 프로젝트 전체의 단일 실행 잠금이 남아 있어 서로 다른 문서의 독립 요청도 막힌다. SPEC-02.14 및 PRD AC-25에 맞춰 대상 기준의 경합 검사로 변경하고, 명시하지 않은 기본 대상의 모호성은 별도로 거절해야 한다. 구현 전 SPEC/ARCH에서 정확한 처리 규칙을 보완한다.

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
- 앞선 이벤트 기반 실험은 직접 ObjectTable.Transform의 재사용 예상에서 실패했다(실측 계산 3개/재사용 1개). 이벤트를 근거로 한 구현은 제거했고, 정확한 기하 일치로 확인한 평행이동만 채택했다. 회전 재사용·사용자 Sync 전체 캐시 연결은 남아 있다.
- Computer Use로 소유 시험 창에서 Rhino 기본 Move를 월드 X +1 m, Save As를 수행했다. 독립 실행본 재열기에서 기존 native ID/속성·체적 48 보존 통과. 증거: `.vide/native-editor-followup/eb88649f-2ade-4bb7-931d-9c76126014e0/result.json`. Save As 뒤 읽기 전용 안내도 재현됐으므로 저장 성공과 안내 문제를 분리한다. 이 안내의 원인은 아직 해결하지 않았다.

## 남은 검증

실호스트 병렬/중단·원본 충돌 및 개입 후 부분 완료분의 세밀한 재사용, Rhino 기본 도구/Save As, L3~L6는 완료 처리하지 않는다. 현재까지의 시험 성공을 전체 제품 완결로 해석하지 않는다. 이후 Jev·다중 계정 CLI 연구 검토/후속 계획은 이 묶음 뒤에 수행한다.
