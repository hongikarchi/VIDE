---
id: SPIKE-2026-09-25-decision-layer
title: 판정 계층 오프라인 평가 도구
status: review
version: 0.2
updated: 2026-09-25
owner: agent:codex
related: [PLAN-05, SPEC-02, T-004, T-018]
---

# 판정 계층 오프라인 평가 도구

질문: 외부 호출 없이 입력 분리·규칙 추천·보류·사용자 선택 우선·측정 결과의 한계를 검증할 수 있는가?

코드: `tools/spikes/2026-09-25-decision-layer/evaluate.mjs`, 입력 `cases.json`, 회귀 `tests/ai/decision-evaluation.test.mjs`. 실행은 `node tools/spikes/2026-09-25-decision-layer/evaluate.mjs`. 네트워크·제품 설정 변경은 없다.

120건은 6분류 × 20건이고 개발/평가 각 60건이다. 가족 단위 분리와 중복 ID·개수 검사를 구현했다. 초기 수치 변형 사례를 서로 다른 요청 문장 120개로 교체했다. 여전히 12개 과제 가족으로 묶은 LLM 작성 임시 라벨이며 실제 긴 대화·독립 정답 검수가 부족하므로 J1/J2의 최종 평가셋 완료가 아니다. 사전 기입된 operation/constraints 등은 시험 메타데이터이며 실제 한국어 분류 능력을 측정하지 않는다.

규칙 결과는 개발 60건 중 20건 보류, 평가 60건 중 30건 보류다. 임시 허용 라벨과 모두 일치했지만 정확도 주장이나 제품 채택 근거가 아니다. 결과에 labels=provisional, adoptionEligible=false, productSuccess/endToEndLatency=null을 강제했다. 전체 과업 지연·성공률·토큰·Jev 비교는 미측정이다. 앞으로 독립 과업으로 변형 사례를 교체하고 기대 행동을 검수한 뒤 실제 기준선과 외부 후보를 평가한다.

`compare.mjs <실측 결과 JSON>`은 같은 caseId의 baseline/candidate가 모두 있는지 검사하고 전체 지연 p95·실패 증가·안전 실패·확인 불가 비용/토큰을 계산한다. 검토된 라벨 60쌍 이상과 계획의 기준을 만족해야 criteriaMet를 반환하지만 adoptionApproved는 자동으로 올리지 않는다. 합성 결과 시험은 집계기 검증이며 실제 성능 비교가 아니다.

## 실제 접근 설정 확인

2026-09-25 Aside에서 [TypeSafe 공식 사이트](https://typesafe.ai/)의 2026-09-24 공지 ‘NEW SIGNUPS PAUSED’를 확인했다. 이메일을 남겨 가입 재개 알림을 받는 경로와 기존 계정 로그인 경로가 표시된다. [콘솔](https://console.typesafe.ai/login)은 Google/이메일 로그인을 제공한다. 기존 계정 보유 여부를 사용자에게 확인 중이며 임의 계정 선택·대기 명단 제출·유료 결제·API 호출은 하지 않았다. 신규 가입 제한이 해제되거나 사용 가능한 기존 계정으로 로그인한 뒤 API 접근·잔액·키 발급·보관 조건을 확인한다. 로그인 화면에 도달한 것은 API 접근 확보가 아니다.
