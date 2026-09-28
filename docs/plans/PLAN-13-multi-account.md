---
id: PLAN-13
title: 다중 AI 계정 — 사용량·초기화 시각·자동 전환
status: review
version: 0.1
updated: 2026-09-29
owner: agent:claude
related: [PLAN, SPEC-02, ARCH-01, FR-08, FR-18]
---

# 다중 AI 계정 — 사용량·초기화 시각·자동 전환

2026-09-29 사용자 요청("cswap·multi-auth급 다중 계정")의 작업이다. 동작은 [SPEC-02.14](../specs/SPEC-02-execution-candidates.md), 물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md) §7 "CLI 프로필 실행 경계"가 소유한다.

## 조사 요약

- cswap(claude-swap): 계정 추가·목록·전환, 5시간·7일 사용률과 초기화 시각, 기준(90%) 자동 전환(쿨다운), 계정별 병렬 실행, 폴더별 기본 계정. 사용량은 계정 토큰으로 `api.anthropic.com/api/oauth/usage`를 조회한다.
- codex-multi-auth: ChatGPT 로그인 묶음, 한도 도달 시 다른 계정으로 넘김, `chatgpt.com/backend-api/wham/usage`와 응답 헤더로 사용률을 읽는다.
- Anthropic 약관은 제3자 프로그램이 로그인 토큰을 다루는 것을 막는다. 사용자는 위험을 알고 조회 방식(2번)을 골랐다(2026-09-29). 제품에서는 기본 꺼짐의 선택 기능으로 둔다.

## 구현

1. `src/ai/account-usage.ts`: 계정별 로그인 정보(이메일·요금제)는 로컬 파일에서 읽고, 조회를 켜면 사용량 주소를 부른다(3분 캐시·중복 방지). 만료 토큰은 갱신하지 않고 마지막 값을 보인다. 설정은 `<데이터>/cli-profiles/usage-settings.json`.
2. 요청 접수 때 자동 전환(`choose`). 한도 실패는 `PROVIDER_LIMIT`로 구분(Claude·Codex CLI 출력)하고 그 계정을 건너뛴다.
3. 설정 → AI: 계정별 이메일·요금제·사용 중 표시·5시간/7일 막대·초기화 시각·"이 계정 사용", 조회·자동 전환 스위치와 기준. 상태 표시줄에 현재 계정의 이메일과 사용률.

## 검증

- 단위: 로그인 정보는 네트워크 없이, 조회는 간격당 한 번, 기준 초과·한도 실패 시 여유 계정 선택, 두 CLI의 한도 문구 인식, Codex `error` 이벤트의 문자열 메시지.
- 실제: 이 PC의 Claude(max)·ChatGPT(pro)·ChatGPT 2(prolite) 세 계정의 사용률·초기화 시각 조회, 한도 표시 뒤 ChatGPT 2로 전환.

## 남은 것

- 프로젝트별 기본 계정(cswap의 폴더별 계정), 사용량 이력 그래프.
- 요청 도중 계정 넘김(codex-multi-auth의 프록시 방식)은 하지 않는다. 쓰기가 섞인 작업을 다른 계정으로 다시 실행하면 중복 반영 위험이 있다.
