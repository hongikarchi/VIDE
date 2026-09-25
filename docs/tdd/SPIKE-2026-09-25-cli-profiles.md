---
id: SPIKE-2026-09-25-cli-profiles
title: CLI 계정 경로 격리 시험
status: review
version: 0.1
updated: 2026-09-25
owner: agent:codex
related: [PLAN-06, SPEC-02, ARCH-01]
---

# CLI 계정 경로 격리 시험

질문: 설치된 공식 CLI의 인증 확인이 명시한 빈 프로필을 따르는가? 기존 사용자 로그인 상태가 다른 프로필로 새어 들어오는가?

방법: `tools/spikes/2026-09-25-cli-profiles/probe.mjs`가 OS 임시 위치에 공급자별 빈 디렉터리 두 개를 만들고 공식 상태 조회만 실행한 후 자체 임시 위치를 정리한다. 로그인·로그아웃·모델 호출·인증 파일 복사는 하지 않는다. 각 상태 조회 10초 상한, 공급자당 2회다. 원시 인증 출력은 보존하지 않는다.

환경: Windows, Codex CLI 0.154.0-alpha.6.2, Claude Code 2.1.281. 공식 help에서 Codex login/status·device-auth, Claude auth login --claudeai를 확인했다. 양쪽 CLI 모두 빈 프로필 A/B에서 SUBSCRIPTION_LOGIN_REQUIRED를 반환했다. 기존 기본 로그인으로 폴백하지 않았다. 빈 프로필 시험은 실제 두 계정의 토큰 갱신·동시 사용·재로그인 격리 증명이 아니다.

제품 연결: 프로필 추가·선택·로그인 명령 UI, 요청 접수의 계정 고정, 두 unknown 작업이 모두 해소될 때까지 전환 대기, 임의 프로필 주입 거절을 구현했다. 실제 Chromium의 계정 추가/선택/명령 표시 시험은 통과했으며 인증 응답은 대역이다. 사용량은 미확인으로 표시하며 자동 전환은 구현하지 않았다.

실제 두 번째 ChatGPT 계정 검증은 사용자가 계정 준비를 확인해 공식 CLI 로그인 절차를 시작했다. 로그인 성공·계정 왕복 결과는 아직 확인 전이다. 기존 계정의 인증 파일은 읽거나 교체하지 않는다.
