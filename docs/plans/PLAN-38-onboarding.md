---
id: PLAN-38
title: 첫 실행·계정·원격 도구 — 로그인 화면, CLI 찾기, cloudflared 준비 (T-175~T-179)
status: draft
version: 0.1
updated: 2026-10-06
owner: agent:claude
related: [SPEC-02, SPEC-04, SPEC-05, ARCH-01, ADR-025, ADR-037, ADR-039, PLAN-09, PLAN-25, FR-08, FR-16, FR-17, FR-19]
---

# 첫 실행·계정·원격 도구 (T-175~T-179)

근거: 2026-10-06 사용자 피드백 네 가지와 결정.

1. "계정이 자동으로 인식이 안되네? account switch를 설치했으면, 그 경로대로 바로 찾아져야 하는거 아닌가?" → T-175.
2. "account switch랑 같이 깔라고 read me에 지침" → T-176.
3. 원격 접속 도구 → "1번(켤 때 자동 다운로드, 로그인해도 원격 기본 끔)으로 하되, 처음에 설치할 때 자동으로 같이 설치되도록 할 수는 없나?" → T-177.
4. "처음에 딱 깔면, 로그인 화면이 나와야 하는거 아닌가? 왜 바로 새 프로젝트가 만들어지고 시작하는거지?" + 선택 "로그인 필수" → T-178. 결정 기록은 [ADR-039](../decisions/ADR-039-sign-in-first-run.md).

동작 정본은 [SPEC-02](../specs/SPEC-02-execution-candidates.md).18의 1(CLI 찾기·AccountSwitch 안내), [SPEC-05](../specs/SPEC-05-extensions-install.md).6 「첫 실행」, [SPEC-04](../specs/SPEC-04-web-review.md).11의 1, 화면은 [Design](../../Design.md) SCR-26과 「AI 설정의 계정 표시」, 물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md) §6 「원격 접속 도구」·「첫 실행 게이트」, §7 「CLI 기본 로그인 실행 경계」.

## T-175 CLI 찾기를 AccountSwitch와 같게

| 변경 | 위치 |
|---|---|
| `claudeExecutable`·`codexExecutable`: 설정값 → `VIDE_*_PATH` → 네이티브 → npm 전역(`@anthropic-ai\claude-code\bin\claude.exe`·`cli.js`, `@openai\codex` 네이티브) → `%LOCALAPPDATA%\OpenAI\Codex\bin`(Codex) → PATH(`*.exe`, 다음 `*.cmd`). `onPath` | `src/ai/paths.ts` |
| `launchTarget`: `.js`는 VIDE의 Node로, npm `.cmd` 심은 안의 `%dp0%\…\*.js`를 Node로 직접, 못 읽으면 `shell:true`. `ClaudeCli` 생성자가 모든 spawn에 적용 | `src/ai/paths.ts`, `src/ai/claude-cli.ts` |
| 실행 경로를 `paths.ts`로 | `src/server/execution.ts` |
| 설정 경로 칸이 `claude.cmd`·`codex.cmd`도 받음 | `src/core/ai-settings.ts`, `src/ui/gateway.ts`(문구) |
| `CLAUDE_CONFIG_DIR`·`CODEX_HOME`: PC 환경에 있으면 실행에 그대로 두고 계정도 그 폴더에서 읽음 | `src/ai/claude-cli.ts`, `src/ai/codex-cli.ts`, `src/ai/account-usage.ts` |
| AccountSwitch 설치 감지·열기: `accountSwitch: {installed, download}`를 `/accounts`·`/accounts/usage`에, `POST /api/v1/accountswitch/open`(로컬만) | `src/ai/account-switch.ts`, `src/server/server.ts` |
| 계정 카드·상태 표시줄의 '로그인 필요' 옆에 [AccountSwitch 열기] 또는 설치 링크, 창 포커스 때 계정 표시 다시 읽기 | `src/ui/account-usage-panel.ts`, `src/ui/account-indicator.ts`, `src/ui/account-switch-link.ts` |
| `CLI_UNAVAILABLE` 문구에 설치·경로 안내 | `src/ui/gateway.ts` |

## T-176 README·START-HERE 설치 안내

README 「설치 (사용자)」를 5단계로: VIDE → Claude Code·Codex CLI(찾는 위치) → AccountSwitch(여러 계정이면 권장, 한 계정이면 CLI 로그인으로 대체) → 플러그인 → Link. 첫 실행의 로그인 화면과 원격 도구 자동 받기 한 줄. 같은 내용을 `src/desktop/build.mjs`의 START-HERE 문구에.

## T-177 원격 접속 도구(cloudflared) 준비

| 변경 | 위치 |
|---|---|
| 고정 판 `2026.9.3`·SHA-256 상수(공식 릴리스 본문의 값, 이 PC의 2026-09-28 파일과 같음), `downloadCloudflared(target, {fetcher})`: `.download`로 받아 해시 확인 뒤 이름 바꾸기, 실패 코드 `CLOUDFLARED_DOWNLOAD_FAILED`·`CLOUDFLARED_VERIFY_FAILED` | `src/server/cloudflared.ts` |
| `cloudflaredPath`에 PATH. `RemoteAccess`: `download` 주입, `prefetch()`(있으면 건너뜀, 실패는 조용히), `open()`에서 없으면 받기(`downloading`), `link()`는 `remote:false`·터널 안 엶, `setRemote(false)`가 터널 오류를 지움 | `src/server/remote-access.ts` |
| `startServer({ prefetchTools })`로 시작 5초 뒤 미리 받기 | `src/server/server.ts`, `src/server/main.ts` |
| 원격이 꺼져 있으면 터널 오류 숨김, 문구에 해결 방법, '원격 접속 도구를 받는 중…' | `src/ui/remote-panel.ts` |
| 수동 staging 시험이 로그인 뒤 원격을 켜도록 | `tests/integration/remote-loop.mjs` |

## T-178 첫 실행 로그인 화면(SCR-26)

| 변경 | 위치 |
|---|---|
| `startServer({ signInRequired })`, `GET /api/v1/onboarding` → `{signInRequired, linked}` | `src/server/server.ts` |
| 설치한 엔진(`--dev` 아님)은 게이트·미리 받기 켬, `VIDE_SIGN_IN_REQUIRED=0\|1`로 덮어씀 | `src/server/main.ts` |
| `connect()`: 게이트가 켜져 있고 로그인 전이면 첫 실행 화면, 로그인했는데 프로젝트가 없으면 고르기 화면. 게이트가 꺼져 있으면 이전처럼 '새 프로젝트' | `src/ui/gateway.ts`, `src/ui/app/boot.ts` |
| 로그인 화면(아이디·비밀번호·PC 이름·가입 안내·AI 연결 한 줄·AccountSwitch), 프로젝트 고르기·만들기(이 PC·공유받은 프로젝트), 고르면 `/?project=<id>` | `src/ui/first-run.tsx`, `src/ui/style.css` |

선행 조건: 없음(사이트 API는 기존 `device/login`·heartbeat). 미결: 이미 자동으로 만들어져 사이트에 올라간 빈 '새 프로젝트'의 정리는 사용자가 사이트나 VIDE에서 지운다(자동 정리 없음).

## T-179 검증

- 단위(`tests/ai/cli-paths.test.mjs`): 탐색 순서(설정 > 환경 변수 > 네이티브 > npm > PATH), PATH의 `.exe` 우선·`.cmd`, `.cmd` 심의 Node 엔트리, `CLAUDE_CONFIG_DIR`·`CODEX_HOME`의 계정 읽기, AccountSwitch 감지.
- 단위(`tests/server/cloudflared.test.mjs`): 다운로드 주입으로 받기·확인값 불일치 거절·이미 있으면 건너뜀·`prefetch` 실패는 조용히·원격 켤 때 받기, `link()` 기본 `remote:false`(터널 안 엶), 원격 끄면 터널 오류 지움.
- 브라우저(`tests/integration/browser-first-run.mjs`, 게이트 켬): 로그인 화면(작업 화면 없음, 자동 프로젝트 없음) → 가짜 사이트 로그인 실패·성공 → 프로젝트 만들기 → 작업 화면.
- 회귀: `browser-accounts`·`browser-workspace-controls`·`browser-shared-projects`, `npm test`, `npm run typecheck`, `npm run build:web`, `npm run format:check`, `npm run docs:check`.

**완료 판단:** 위 자동 검증 통과(2026-10-06, 격리 작업 폴더. `npm test`의 구조 해석 12건은 이 폴더에 구조 코어 빌드가 없어 난 `STRUCTURE_CORE_MISSING`이며 이번 변경과 무관). 남은 조건: 실제 새 PC(npm으로 설치한 Claude, AccountSwitch 미설치/설치)에서 첫 실행·로그인·원격 켜기 확인, 설치본 릴리스(사용자 지시 뒤).
