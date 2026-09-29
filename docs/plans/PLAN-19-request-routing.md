---
id: PLAN-19
title: 요청 경로(VIDE 화면 / 파일)와 모델 자동 선택
status: review
version: 0.1
updated: 2026-09-29
owner: agent:claude
related: [PLAN, SPEC-02, DESIGN, RESEARCH-02, FR-04, FR-08]
---

# 요청 경로(VIDE 화면 / 파일)와 모델 자동 선택

2026-09-29 사용자 요청. 동작은 [SPEC-02.15](../specs/SPEC-02-execution-candidates.md), 화면은 [Design §03](../../Design.md).

## 구현

1. `src/ui/request-route.ts`: 규칙 판정(화면 동작 말, 원본·변경 말, 종류·레이어·이름·선택으로 대상 찾기, 짧은 한국어 종류 말의 단독 판정, 모델링/프로그램 작업과 모델).
2. `src/ui/app.ts`: 경로·모델 칩, 칩으로 경로 전환, 입력할 때 모델 자동 선택(직접 고르면 멈춤), 화면만 요청은 뷰포트 숨기기·격리·보이기·선택·확대로 처리하고 보내지 않음.

## 검증

- 단위(`tests/core/request-route.test.mjs`): 종류·레이어·이름·선택 대상, 찾지 못한 대상, 파일 말 우선, "선택"과 "선", "평면"과 "면" 구분, 모델 선택과 없는 모델.
- 브라우저(`tests/integration/browser-route.mjs`): "텍스트만 남기고 숨겨줘"가 보내지 않고 문자만 남김, 다시 보이기, 지우기 요청은 파일 작업, 모델링 → GPT-6-Astra·프로그램 → Opus 5.5, 직접 고르면 자동 멈춤, 칩으로 경로 전환.

## 다음

- Jev(RESEARCH-02): 규칙으로 애매한 요청의 경로 판정과 대화 문맥 선별(지금은 최근 6개). 중계 서버가 생기면 제안 전용(섀도)으로 붙여 정확도를 잰다.
- 화면에서의 색 바꿔 보기(객체별 표시 색)는 뷰포트 기능이 생기면 화면 동작에 더한다. 지금 색 요청은 파일 작업이다.
