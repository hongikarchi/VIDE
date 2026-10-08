---
id: PLAN-50
title: 계정 단추와 계정 창 — 설정에서 계정·원격 접속 분리 (T-263)
status: review
version: 0.2
updated: 2026-10-08
owner: agent:claude
related: [SPEC-05, SPEC-04, DESIGN, FR-16, FR-18, FR-19, ADR-025, ADR-039, PLAN-38]
---

# 계정 단추와 계정 창

2026-10-08 사용자 요청 "왼쪽 아래에 계정(동그라미 안에 알파벳 있는 식으로)이 떠있고, 그거 누르면 vide 계정 관련 설정 할 수 있도록. 기존에 있는 설정에서 계정.원격 접속을 분리하는거지."의 실행 계획이다. 동작은 [SPEC-05.10](../specs/SPEC-05-extensions-install.md), 화면은 [Design](../../Design.md) SCR-34다. 같은 요청의 할 일 작성자(SPEC-01.14의 12)는 별도 작업이며, 이 계획은 그 작업이 쓸 계정 동그라미 부품만 함께 만든다.

## T-263 계정 단추·계정 창

- **기준:** SPEC-05.10 1~5, SCR-34. 로그인·로그아웃·원격 접속의 동작 규칙은 지금 그대로(SPEC-04.8, SPEC-05 §6 「첫 실행」, ADR-039). AI 계정은 보기만(ADR-025).
- **변경 범위:**
  - 계정 동그라미: `src/contracts/account-avatar.ts`(`avatarIndex` = 아이디의 FNV-1a 32비트 mod 8, `avatarInitial`), `src/ui/shell/avatar.tsx`(`Avatar {name, id, size}`, 명령형 `avatarNode`), `src/ui/avatar.css`(`--avatar-1..8`).
  - 단추·창: `src/ui/shell/account-button.tsx`(레일 맨 아래 단추·좁은 화면 줄·빈 창), `src/ui/store/account.ts`, `src/ui/account-popover.ts`(창 채우기·위치·Esc·바깥 누르기·AI 계정 줄). `src/ui/remote-panel.ts`의 `attachAccountPanel`을 창 배치로 다시 그린다(사이트 연결 줄, 원격 접속 묶음, 로그아웃 확인 문구, 로그아웃 뒤 로그인 필수 엔진은 첫 실행 화면으로 다시 열기, 원격 세션 안내).
  - 설정: `SettingsTab`에서 `'account'` 제거, 첫 탭 AI(원격 세션은 상태 · 오류), 탭 목록 아래 안내와 [계정 열기](`statusState.actions.openAccount`). `refreshAccount`·`onAccount`는 그대로 동작한다. 외부 서비스의 로그인 안내 문구를 계정 단추로 바꾼다.
- **선행·외부 조건:** 없음. 사이트 배포·원격 D1 변경 없음.
- **검증:**
  - `tests/core/account-avatar.test.mjs`: 같은 아이디는 같은 색, 8색 분포, 첫 글자.
  - `tests/integration/browser-account-panel.mjs`: 'K' 동그라미·도움말·원격 점, 창의 아이디·PC 이름·웹사이트 연결·AI 계정 보기, 스위치 끄면 점 사라짐, 바깥 누르면 닫힘, 설정에 계정 탭 없음·[계정 열기], 로그아웃 두 번 누르기 뒤 중립 표식과 로그인 양식, 좁은 화면의 아래 판.
  - `tests/integration/browser-workspace-controls.mjs`: 로그인 양식 입력 유지·비밀번호 보기를 계정 창에서, Esc 뒤 초점이 계정 단추로.
  - 기존 `browser-accounts`·`browser-shared-projects`·`browser-first-run`·`browser-host-panel`·`browser-services`·`browser-public-data`·`browser-telemetry` 통과.
- **남은 확인:** 원격 세션(https로 연 화면)의 창은 자동 시험으로 열지 않았다(`remoteSession()`은 주소의 https로 판별). 실제 iPad 확인은 `tests/integration/remote-loop.mjs` 실행 때 함께 본다.
- **완료 판단:** 위 시험 통과와 SPEC-05.10 수용 결과의 PC 쪽 항목 확인.

## T-263 통합 보완 — 할 일 작성자 작업과 합치기 (2026-10-08)

할 일 작성자(SPEC-01.14의 12)와 이 작업이 계정 동그라미를 따로 만들어 합치며 검토 결함을 고쳤다.

- **기준:** SPEC-05.10 1·4·5, SPEC-01.14의 12, SCR-34.
- **변경 범위:**
  - 동그라미 하나: `account-avatar.ts`의 색은 아이디 UTF-8 바이트의 FNV-1a 하나로 정한다(화면·사이트 같음), `avatarInitial('')`은 빈 글자. `authorLine`은 작성자가 없으면 고친 사람이 있어도 '작성자 정보 없음'으로 시작한다. `Avatar`는 `title`·`className`을 받고 `avatarNode`를 둔다(이름 앞뒤 공백 무시).
  - 계정 번호 채우기: `RemoteAccess`가 시작할 때와, 채우지 못한 프로젝트가 남았으면(`onAccountId`가 false) 그 뒤 heartbeat마다 다시 채운다.
  - 계정 단추: 창을 연 적이 없어도 15초마다 상태를 확인해 원격 점과 계정 동그라미(사이트 로그아웃)를 맞춘다. 좁은 화면 줄에 아이디와 `aria-expanded`.
  - 설정을 가리키던 안내(`jig-submit.tsx`, 사이트 `hosts.tsx`·`home.tsx`)를 계정 단추로 바꾼다.
- **검증:** `tests/core/account-avatar.test.mjs`(UTF-8 정의, 옛 안내 문구 없음), `tests/server/agenda-authors.test.mjs`('작성자 정보 없음 · 고침 lee', 시작·heartbeat 다시 채우기), `browser-account-panel.mjs`(창을 열지 않고 켜는 중→켜짐, 사이트 로그아웃→중립, 좁은 화면 아이디·`aria-expanded`), `npm run verify`, `npm run test:browser`.
- **완료 판단:** 위 시험 통과.

## 현재 상태

T-263 구현·자동 검증 완료(2026-10-08), 할 일 작성자 작업과 통합·보완 완료(2026-10-08). 원격 세션 화면은 실기 확인 전.
