---
id: VERIFY-2026-09-24-local-product-completion
title: 로컬 제품 완결 · 실제 왕복 및 확장 검수
status: review
version: 0.1
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

## 남은 검증

진행 중 추가 지시의 저장·채택·후속 실행, 실호스트 병렬/중단·원본 충돌, Rhino 기본 도구/Save As, L3~L6는 완료 처리하지 않는다. 현재까지의 시험 성공을 전체 제품 완결로 해석하지 않는다. 이후 Jev·다중 계정 CLI 연구 검토/후속 계획은 이 묶음 뒤에 수행한다.
