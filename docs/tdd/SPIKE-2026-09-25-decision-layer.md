---
id: SPIKE-2026-09-25-decision-layer
title: 판정 계층 오프라인 평가 도구
status: review
version: 0.1
updated: 2026-09-25
owner: agent:codex
related: [PLAN-05, SPEC-02, T-004, T-018]
---

# 판정 계층 오프라인 평가 도구

질문: 외부 호출 없이 입력 분리·규칙 추천·보류·사용자 선택 우선·측정 결과의 한계를 검증할 수 있는가?

코드: `tools/spikes/2026-09-25-decision-layer/evaluate.mjs`, 입력 `cases.json`, 회귀 `tests/ai/decision-evaluation.test.mjs`. 실행은 `node tools/spikes/2026-09-25-decision-layer/evaluate.mjs`. 네트워크·제품 설정 변경은 없다.

120건은 6분류 × 20건이고 개발/평가 각 60건이다. 가족 단위 분리와 중복 ID·개수 검사를 구현했다. 현재 12개 문장 가족의 수치 변형이며 LLM 작성 임시 라벨이다. 다양성·독립 정답이 부족하므로 J1/J2의 최종 평가셋 완료가 아니다. 사전 기입된 operation/constraints 등은 시험 메타데이터이며 실제 한국어 분류 능력을 측정하지 않는다.

규칙 결과는 개발 60건 중 20건 보류, 평가 60건 중 30건 보류다. 임시 허용 라벨과 모두 일치했지만 정확도 주장이나 제품 채택 근거가 아니다. 결과에 labels=provisional, adoptionEligible=false, productSuccess/endToEndLatency=null을 강제했다. 전체 과업 지연·성공률·토큰·Jev 비교는 미측정이다. 앞으로 독립 과업으로 변형 사례를 교체하고 기대 행동을 검수한 뒤 실제 기준선과 외부 후보를 평가한다.
