---
id: PLAN-25
title: 계정 관리를 AccountSwitch로 넘기기
status: draft
version: 0.1
updated: 2026-09-30
owner: agent:claude
related: [ADR-025, SPEC-02, ARCH-01, PLAN-06, PLAN-13, PLAN-24, FR-08, AC-47]
---

# 계정 관리를 AccountSwitch로 넘기기 (T-068)

기준: [ADR-025](../decisions/ADR-025-accounts-in-accountswitch.md)(2026-09-30 사용자 결정). VIDE에서 구독 계정 관리(추가·로그인·로그아웃·제거·이름 변경·전환·자동 전환)를 빼고, 각 CLI의 기본 로그인만 쓴다. 두 계정 동시 사용은 지원하지 않는다.

## 0단계 — AccountSwitch 설치 (지금)

- [AccountSwitch Releases](https://github.com/hongikarchi/AccountSwitch/releases/latest)의 설치 파일로 이 PC에 설치한다.
- VIDE 설정은 그대로 둔다: 두 공급자 모두 "기존 CLI 로그인" 선택, VIDE 자동 전환 꺼짐. 이 상태면 VIDE는 AccountSwitch가 고른 계정을 따른다.
- 확인: AccountSwitch 창이 뜨고 두 서비스의 "기존 CLI 로그인"이 로그인 상태로 보인다. VIDE의 계정 데이터(`%LOCALAPPDATA%\VIDE\cli-profiles`)는 건드리지 않는다.
- 결과(2026-09-30): 0.1.2를 `%LOCALAPPDATA%\AccountSwitch.App`에 설치했다(시작 메뉴·바탕화면 바로가기 생성, 설치 프로그램 종료 코드 0). 설치 프로그램이 에이전트 셸에서 띄운 앱은 기본 로그인을 바꿀 권한을 그 셸에서 물려받으므로 종료했고, 첫 실행과 계정 등록은 사용자가 바로가기로 한다. VIDE는 두 공급자 모두 기존 CLI 로그인을 쓰고 있었고, 켜져 있던 VIDE 자동 전환은 껐다(`usage-settings.json`의 `autoSwitch`만 바꿈, 사용량 조회·기준 90%는 그대로).

## 착수 조건 (1단계부터)

다른 세션이 아래 파일의 작업을 커밋해 `git status`에 그 세션의 변경이 남지 않을 때 시작한다. 이 파일들이 계정 선택·대화 계정 고정·한도 인계를 담고 있다.

- 문서: `docs/PRD.md`, `docs/specs/SPEC-02-execution-candidates.md`, `docs/architecture/ARCH-01-system.md`, `docs/research/RESEARCH-10-vide-restructure.md`, `docs/plans/PLAN-24-ai-conversations.md`
- 코드: `src/server/server.ts`, `src/server/conversations.ts`, `src/server/execution.ts`, `src/ai/claude-cli.ts`, `src/ai/codex-cli.ts`, `src/ai/codex-app-server.ts`, `src/contracts/workspace.ts`, `src/ui/app.ts`, `src/ui/conversations.tsx`, `src/ui/style.css`

## 1단계 — 정본 고치기

1. **SPEC-02.18 구독 계정 프로필:** VIDE는 기본 로그인만 쓴다. 현재 계정(이메일·요금제)과 사용량은 읽기만 한다. 계정 관리·전환은 AccountSwitch를 안내한다. 로그인 안 됨이면 "터미널이나 AccountSwitch에서 로그인" 안내를 보인다.
2. **SPEC-02.17 대화:** 공급자·모델은 대화에 고정하고, 계정은 턴마다 그때의 기본 로그인을 쓴다. 계정이 바뀐 뒤 첫 턴의 처리는 5의 SPIKE 결과로 정한다.
3. **SPEC-02.19:** 계정 전환 T2 카드와 "두 번째 계정으로 바꿔" 경로를 뺀다. 그 말에는 "계정 전환은 AccountSwitch에서" 안내로 답한다. 계정 한도 행은 "자동으로 다시 보내지 않음 + 한도 알림(초기화 시각, AccountSwitch에서 바꾸면 이어 보낼 수 있음)"으로 바꾼다. 로그인 시작 카드도 같은 안내로 바꾼다.
4. **ARCH-01 「CLI 프로필 실행 경계」:** 관리 프로필(`CLAUDE_CONFIG_DIR`·`CODEX_HOME` 주입)을 뺀다. 공급자 기록 삭제는 기본 로그인 폴더만 대상으로 한다.
5. **SPIKE(짧게):** AccountSwitch로 계정을 바꾼 뒤 같은 Claude 세션을 `--resume`으로 이어 갈 수 있는지 확인한다. 설정 폴더가 같으므로 될 것으로 보지만 확인한다. Codex 세션도 같은 방식으로 확인한다. 실패하면 지금의 인계 자료로 새 세션을 연다. 기록: `docs/tdd/SPIKE-YYYY-MM-DD-account-switch-resume.md`.
6. **Design:** 설정 → AI의 계정 영역을 읽기 전용 카드(현재 계정·사용량·"계정 관리는 AccountSwitch에서")로 바꾼다. 상태 표시줄의 계정 표시는 유지한다.
7. **PRD:** §10.5(목적별 대화)·AC-47의 "계정 한도 시 새 세션" 문장이 결정과 맞는지 확인하고, 필요하면 사용자 확인을 받아 고친다.
8. PLAN-06·PLAN-13의 계정 관리 절에 "ADR-025로 대체"를 표시한다. PLAN-24 T-061의 계정 한도 인계 항목은 이 계획으로 옮긴다.

## 2단계 — 코드 빼기

| 대상 | 변경 |
|---|---|
| `src/ai/account-profiles.ts`, `src/ai/account-login.ts` | 삭제 |
| `src/ai/account-usage.ts` | 기본 로그인의 계정 정보·사용량 읽기만 남기고 `choose`·자동 전환·계정별 폴더를 뺀다 |
| `src/server/server.ts` | `/api/v1/accounts/{login,login-command,login/cancel,login/code,logout,remove,rename,select}` 삭제. `/accounts`·`/accounts/usage`·`/accounts/usage-settings`는 읽기 전용 형태로 남긴다. 원격 차단 경로 정리 |
| `src/server/execution.ts`, `src/server/conversations.ts` | `accountProfileId`로 설정 폴더를 고르던 부분을 기본 로그인으로 고정. 대화의 계정 고정·`…/account` 인계 경로 삭제. 한도 카드는 알림으로 |
| `src/ai/claude-cli.ts`, `src/ai/codex-cli.ts`, `src/ai/codex-app-server.ts` | `configDirectory` 주입 제거. 오래 떠 있는 Codex 프로세스는 기본 로그인의 계정이 바뀐 것을 보면 다음 턴 전에 다시 띄운다(바뀌기 전 토큰으로 계속 쓰지 않게) |
| `src/contracts/workspace.ts`, `src/core/conversation-store.ts`, `src/core/migrations.ts` | 저장된 `accountProfileId` 열은 옛 기록 읽기용으로 두고 새 기록에는 쓰지 않는다(마이그레이션 없음) |
| `src/ui/account-settings.tsx`, `src/ui/ai-settings.tsx`, `src/ui/usage-bars.ts`, `src/ui/workspace-status.ts`, `src/ui/conversations.tsx`, `src/ui/app.ts` | 계정 관리 화면을 읽기 전용 카드로. 대화 머리의 계정 표시는 현재 기본 로그인으로 |
| 경로 판정 규칙(`app/login/*`, 계정 전환) | 안내 답으로 |
| 시험 | `tests/ai/account-profiles.test.mjs` 삭제, `account-usage`·`conversations`·`remote-http`·`server` 등 계정 관련 기대값 조정, `browser-accounts.mjs`는 읽기 전용 카드 시험으로 |

VIDE 계정 사이트(프로젝트 공유, PLAN-10)의 계정은 이 작업과 무관하다. `browser-account-catalog`·`browser-authenticated-accounts`, `tests/sharing/*`은 사이트 계정 시험이면 건드리지 않는다(착수 때 확인).

**기존 계정 데이터:** 2026-09-30 사용자 요청으로 VIDE에 등록해 둔 계정 3개(Claude 2, Codex 1)의 로그인 폴더를 `%LOCALAPPDATA%\VIDE\cli-profiles\<id>\`에서 `%LOCALAPPDATA%\AccountSwitch\profiles\<id>\`로 옮기고(복사하지 않음: 토큰이 갱신되면 한쪽이 끊김), AccountSwitch 목록에 같은 ID·이름과 기존 로그인 이름을 등록했다. VIDE의 `profiles.json`에는 세 행이 남아 있고, VIDE는 폴더가 없으면 빈 폴더를 만들어 로그아웃으로 보인다. 2단계에서 이 행과 빈 폴더를 지운다.

## 3단계 — 검증

- 정상: 단위·서버 시험 전체 통과. 브라우저 시험 `browser-accounts`(읽기 전용 카드), `browser-conversations`.
- 실제(이 PC, 사용자 허락 뒤): AccountSwitch에서 계정을 바꾸면 VIDE 상태 표시줄이 새 계정을 보인다. 같은 대화의 다음 턴이 새 계정으로 나간다(Claude·Codex 각 1회).
- 실패: 기본 로그인이 없으면 로그인 안내. 한도에 걸린 턴은 다시 보내지 않고 알림을 보인다. 없앤 계정 API는 404. 원격 기기에서 계정 관련 쓰기 경로가 없다.

## 완료 기준

- VIDE 어디에도 계정 추가·로그인·전환·자동 전환 기능이 없고, 코드에 `CLAUDE_CONFIG_DIR`·`CODEX_HOME` 주입이 없다.
- 위 검증 통과, 정본(SPEC-02·ARCH-01·Design) 반영, PLAN §6.5 갱신, 설치본 릴리스.
