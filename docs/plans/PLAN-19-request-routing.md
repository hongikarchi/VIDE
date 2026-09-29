---
id: PLAN-19
title: 요청 경로(VIDE 화면 / 파일)와 함께 보낼 이전 대화
status: review
version: 0.2
updated: 2026-09-29
owner: agent:claude
related: [PLAN, SPEC-02, DESIGN, RESEARCH-02, FR-04, FR-08]
---

# 요청 경로(VIDE 화면 / 파일)와 함께 보낼 이전 대화

2026-09-29 사용자 요청. 동작은 [SPEC-02.17](../specs/SPEC-02-execution-candidates.md), 화면은 [Design §03](../../Design.md).

## 구현

1. `src/ui/request-route.ts`: 규칙 판정(화면 동작 말, 원본·변경 말, 종류·레이어·이름·선택으로 대상 찾기, 짧은 한국어 종류 말의 단독 판정).
2. `src/ui/app.ts`: 경로 칩, 칩으로 경로 전환, 화면만 요청은 뷰포트 숨기기·격리·보이기·선택·확대로 처리하고 보내지 않음.
3. 모델 자동 선택은 작성기 규칙(모델링 → GPT-6-Astra, 프로그램 → Opus 5.5)을 지우고 서버의 "자동 (Jev)"([PLAN-05 §7.2a](PLAN-05-decision-layer-evaluation.md), `src/ai/model-router.ts`) 하나로 통일했다(사용자 결정 2026-09-29).
4. 이전 대화 선별: `src/ai/context-selector.ts`가 이전 대화가 6개를 넘으면 Jev(Noul 질문, 최근 20개)로 관련 대화를 고르고 바로 앞 대화를 늘 넣는다. `src/server/execution.ts`가 이를 써서 `conversation` 항목을 만들고 진단 기록에 `context`(방법·개수·시간)를 남긴다. 키는 모델 선택과 같은 곳(`TYPESAFE_API_KEY` 또는 `<데이터>/typesafe.env`)에서 읽는다.

## 검증

- 단위(`tests/core/request-route.test.mjs`): 종류·레이어·이름·선택 대상, 찾지 못한 대상, 파일 말 우선, "선택"과 "선", "평면"과 "면" 구분.
- 단위(`tests/ai/context-selector.test.mjs`): 6개 이하는 Jev 없이 모두, Jev가 고른 것과 바로 앞 대화를 순서대로, 최대 6개, 키 없음·HTTP 실패·오류는 최근 6개.
- 실제 Jev(합성 대화 8개, 2026-09-29): "아까 X3열 보를 X4열로 옮겨줘" → X3열 보 대화 2개 + 바로 앞, "창호 목록을 표로 정리해줘" → 창호 개수 대화 + 바로 앞. 호출 0.2~0.3초.
- 브라우저(`tests/integration/browser-route.mjs`): "텍스트만 남기고 숨겨줘"가 보내지 않고 문자만 남김, 다시 보이기, 지우기 요청은 파일 작업, 칩으로 경로 전환.

## 다음

- 규칙으로 애매한 요청의 경로 판정도 Jev 후보다. 실제 사용 기록(진단 로그)을 보고 필요하면 더한다.
- 화면에서의 색 바꿔 보기(객체별 표시 색)는 뷰포트 기능이 생기면 화면 동작에 더한다. 지금 색 요청은 파일 작업이다.
- 다른 사용자 PC는 Jev 키가 없으므로 최근 6개로 동작한다. 서버 중계가 생기면 같은 판단을 중계로 받는다.
