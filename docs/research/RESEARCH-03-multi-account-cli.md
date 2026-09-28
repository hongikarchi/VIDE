---
id: RESEARCH-03
title: 구독 CLI 다중 계정 관리 도구 조사
status: review
version: 0.2
updated: 2026-09-24
owner: agent:claude
related: [PLAN, PLAN-02, ARCH-01, SPEC-02, FR-08, FR-18, ADR-013, ADR-014]
---

# 구독 CLI 다중 계정 관리 도구 조사

사용자의 2026-09-24 지시(여러 구독 계정을 동시에 관리하는 multi-agent 방식을 위해 기존 GitHub 도구를 먼저 조사)에 따른 조사 문서다. 2026-09-24에 GitHub 저장소·이슈·공식 문서·언론을 조사했고 실측·실험은 하지 않았다. 출처 신뢰도(공식 문서 / 도구 리버스엔지니어링 / 언론 / 일화 / 미확인)를 본문에 구분해 표시했다. 이식 계획은 이 문서에 쓰지 않으며 사용자가 별도로 세운다.

VIDE의 현재 코드 사실(조사 전 확인): `src/ai/claude-cli.ts:57`은 자식 프로세스 환경에서 `CLAUDE_CONFIG_DIR`·`ANTHROPIC_*`·`CLAUDE_CODE_*`를 삭제하고, `src/ai/codex-cli.ts:9`는 `CODEX_HOME`·`OPENAI_*`·`CODEX_*` 인증 변수를 삭제한다. 즉 자식은 상위 셸의 값을 상속하지 않고 CLI 기본 경로(`~/.claude`, `~/.codex`)로 돌아간다. 아래 "확인이 필요한 미확인 사항"의 해당 항목은 이 사실로 답이 되며, 다중 계정을 지원하려면 "삭제" 대신 "계정 전용 경로로 명시 설정"으로 바꾸는 것이 §"설계 선택지 A"의 전제다.

Claude Code·Codex CLI 다중 계정 도구 생태계는 사실상 **두 가지 원시(primitive)**로 수렴한다 — 계정마다 완전히 별개인 설정 디렉터리(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`)를 주는 **프로세스별 격리 방식**과, 하나의 공유 자격증명 파일을 백업·복원(overwrite)하는 **순차 전환 방식**이다. 진짜 동시 실행은 전자에서만 안전하게 성립하며, 후자는 OAuth refresh token이 1회용(rotation) 토큰이라는 두 회사 공통의 구조 때문에 동시에 두 프로세스가 같은 자격증명 파일을 건드리면 `refresh_token_reused`/`invalid_grant` 류의 경쟁 조건이 재현 가능하게 발생한다는 것이 `openai/codex#10332`([GitHub](https://github.com/openai/codex/issues/10332))를 비롯해 최소 5개의 독립 프로젝트에서 동일하게 보고되었다. 가장 인기 있는 도구인 `realiti4/claude-swap`(2,788★, [GitHub](https://github.com/realiti4/claude-swap))과 `loongphy/codex-auth`(2,740★, [GitHub](https://github.com/loongphy/codex-auth))는 모두 리버스엔지니어링된 파일 포맷·잠금 프로토콜·비공개 사용량 API에 의존하는 반면, `teamclaude`([GitHub](https://github.com/KarpelesLab/teamclaude))·`cc-router`([GitHub](https://github.com/Timo972/cc-router)) 같은 계정 풀 프록시는 실제 HTTP 응답 헤더(`anthropic-ratelimit-unified-*`)를 읽어 임계치 기반 선제 전환(threshold-based proactive rotation)을 구현한다. 정책 측면에서는 Anthropic이 2026-01-09부터 기술적으로, 2026-02-20 공개 성명으로 명시적으로 구독 OAuth 토큰의 **제3자 제품**(공식 CLI 외) 사용을 차단·금지했다는 사실([The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/), [VentureBeat](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses))이 이 조사에서 가장 확실한 규범적 경계선이며, VIDE처럼 공식 `claude`/`codex` 바이너리를 자식 프로세스로만 실행하고 토큰을 직접 추출·재사용하지 않는 구조는 이 금지선의 반대편, 즉 "정상 로그인된 여러 계정을 공식 CLI로 전환"하는 쪽에 해당한다.

## 도구 지형: cswap이 사실상 표준, Codex 쪽은 더 파편화되어 있다

Claude Code 진영에서 "cswap"이라는 이름은 거의 언제나 `realiti4/claude-swap`을 가리킨다. 같은 이름의 다른 저장소(`dpemmons/cswap`, `ibrahimthecosmic/cswap` 등)는 대부분 이 프로젝트의 포크·포트·컴패니언 앱이며, 독립적으로 설계된 대안은 `ming86/cc-account-switcher`(451★, Shell, [GitHub](https://github.com/ming86/cc-account-switcher)), `uwuclxdy/clauth`(212★, [GitHub](https://github.com/uwuclxdy/clauth)), `Dicklesworthstone/coding_agent_account_manager`(201★, Go, [GitHub](https://github.com/Dicklesworthstone/coding_agent_account_manager)) 정도로 규모가 작다. Anthropic은 다중 계정 기능을 공식적으로 낸 적이 없고, `anthropics/claude-code#44687` 이슈는 세 건의 선행 요청(#30031, #24963, #20131)의 중복으로 자동 종료되었다([GitHub Issue #44687](https://github.com/anthropics/claude-code/issues/44687)) — 수년째 반복 요청되지만 미해결이라는 정황 증거다.

Codex 진영은 별 개수 기준으로는 오히려 더 인기 있는 대안들이 "codex-multi-auth"라는 이름을 앞선다. `loongphy/codex-auth`(2,740★, Zig, MIT, [GitHub](https://github.com/loongphy/codex-auth))와 `Lampese/codex-switcher`(840★, Rust, [GitHub](https://github.com/Lampese/codex-switcher))가 `ndycode/codex-multi-auth`(515★, TypeScript, MIT, [GitHub](https://github.com/ndycode/codex-multi-auth))보다 별이 많지만, 내부 모듈 목록(`refresh-lease.ts`, `refresh-queue.ts`, `routing-mutex.ts`, `preemptive-quota-scheduler.ts` 등, [GitHub 디렉터리 목록](https://github.com/ndycode/codex-multi-auth))으로 볼 때 가장 정교하게 엔지니어링된 도구는 `codex-multi-auth`로 보인다. 공식 문서는 `CODEX_HOME`(기본 `~/.codex`)과 `auth.json`을 명시하지만([공식 문서](https://learn.chatgpt.com/docs/auth)) 다중 계정 운용 자체는 전혀 언급하지 않는다.

아래 표는 조사 범위 내에서 소스가 확인된 주요 도구를 정리한 것이다. 별표·최종 커밋일은 2026-09-24 스냅샷([GitHub API](https://github.com/realiti4/claude-swap) 등)이며 계속 바뀔 수 있다.

| 저장소 | 대상 | 언어 | 별 | 최종 푸시 | 라이선스 | 메커니즘 | Windows | 동시성 | 한도 처리 |
|---|---|---|---|---|---|---|---|---|---|
| `realiti4/claude-swap` (cswap) | Claude Code | Python | 2,788 | 2026-09-20 | MIT | 공유 자격증명 백업/덮어쓰기(기본) + `cswap run`의 세션별 `CLAUDE_CONFIG_DIR`(선택) | O (파일 기반, 재시작 불필요) | 세션 모드에서만 진짜 병렬 | 비공개 `/api/oauth/usage` 폴링, 임계치 90%, 히스테리시스+5분 쿨다운 |
| `ming86/cc-account-switcher` | Claude Code | Shell | 451 | 2025-07-01 | MIT | 백업/복원(Keychain+파일) | X (macOS/Linux/WSL만) | 없음(순차) | 없음(수동 전환만) |
| `Nemo-Illusionist/claude-code-account-switcher` | Claude Code | Rust | 25 | 2026-09-21 | MIT | 디렉터리↔계정 바인딩, `cd` 훅 | O | 불명 | 불명 |
| `ndycode/codex-multi-auth` | Codex | TypeScript | 515 | 2026-09-22 | MIT | 별도 풀 파일(`multi-auth/openai-codex-accounts.json`) + 루프백 프록시로 실시간 라우팅 | 부분(WSL 콜백 포트 이슈 문서화, `wsl.ts`) | "핀 고정" 방식(동시에 N개 활성 세션은 불명확) | 반응형 쿨다운(5xx 버스트) + 선제 예측(`preemptive-quota-scheduler.ts`) |
| `loongphy/codex-auth` | Codex | Zig(npm) | 2,740 | 2026-09-15 | MIT | 계정별 `auth.json` 저장/교체, 재시작 필요(포크 "codext"는 무재시작) | 불명 | 없음(수동) | 사용량 표시만, 자동 회전 없음 |
| `codex-profiles`(커뮤니티) | Codex | 불명 | 불명 | 불명 | 불명 | 프로파일별 `CODEX_HOME` + Desktop 사용자 데이터 디렉터리 완전 격리 | O(macOS 확인) | 확인됨(저자가 2개 동시 실행 시연) | 없음 |
| `teamclaude` | Claude+Codex 풀 프록시 | 불명 | 불명 | 불명 | 불명 | 로컬 설정 파일(`~/.config/teamclaude.json`)+상태 파일, 투명 프록시 | 불명 | 다중 계정 풀 뒤 세션 고정(sticky) | `anthropic-ratelimit-unified-*` 헤더로 5h/7d 구분, 98% 임계치 선제 회전, 스톰 컨트롤 |
| `Timo972/cc-router` | Claude+Codex 풀 프록시 | 불명 | 불명 | 불명 | 불명 | 로컬 투명 프록시, 세션별 계정 고정(2–20계정) | 불명 | 세션 고정형 | 계정별/모델별 한도 소진 시 스킵, 원자적 토큰 갱신 |
| `Wei-Shaw/claude-relay-service` | Claude+Codex+Gemini 풀 프록시 | 불명 | 불명 | 불명 | 불명 | Redis 저장, 프록시 발급 API 키 필요(네이티브 OAuth 아님) | 불명 | 다중 계정 풀 | 503/5xx 계층형 쿨다운(TTL 환경변수), 429 로직 미문서화 |
| `router-for-me/CLIProxyAPI` | Claude+Codex+Gemini+Grok 풀 프록시 | Go | 52,787(3rd-party 집계) | 불명 | 불명 | 다중 계정 라운드로빈 | 불명 | 라운드로빈 | 세부 미확인(README 수준) |
| `smtg-ai/claude-squad` | 병렬 오케스트레이터 | 불명 | 8,500 | 불명 | 불명 | git worktree + tmux, 계정 풀링은 없음 | 불명 | 다중 세션(단일 계정 전제) | 없음 |

이 표에서 얻을 수 있는 구조적 통찰은, **오케스트레이션 계층**(작업 디렉터리·터미널을 여러 개로 쪼개는 것)과 **계정 풀링 계층**(하나의 엔드포인트 뒤에 여러 자격증명을 두는 것)이 이 생태계에서 명확히 분리된 관심사라는 점이다([조사 노트](https://github.com/openai/codex/issues/14728) 기반 추론). VIDE의 자식 프로세스 스포너는 전자에 가깝고, 후자의 회전·쿨다운 알고리즘만 참고하면 된다.

## 자격증명 저장 위치와 CLAUDE_CONFIG_DIR/CODEX_HOME 격리는 리버스엔지니어링 영역이다

Claude Code의 온디스크 레이아웃은 **Anthropic이 공식 문서화하지 않은** 영역이다. `claude-swap`의 소스 주석은 자신의 경로 해석 로직이 "claude-code 자체의 해석을 그대로 미러링"한다고 명시하며 그 근거로 Claude Code 번들 내부 파일(`utils/env.ts`의 `getGlobalClaudeFile`, `utils/secureStorage/plainTextStorage.ts`의 `getStoragePath`)을 직접 인용한다(도구 리버스엔지니어링, [paths.py](https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/paths.py)). 확인된 경로 규칙은 다음과 같다: 설정 홈은 `CLAUDE_CONFIG_DIR` 환경변수가 있으면 그 값, 없으면 `~/.claude`; 전역 설정 파일은 레거시 `<config_home>/.config.json`이 있으면 그것, 없으면 `(CLAUDE_CONFIG_DIR || $HOME)/.claude.json`으로 **홈 디렉터리 루트**에 위치(즉 `.claude/` 안이 아님); 자격증명 파일은 `<config_home>/.credentials.json`이다(도구 리버스엔지니어링, [paths.py](https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/paths.py)). 흥미롭게도 `CLAUDE_CONFIG_DIR`는 실제로 Claude Code가 읽는 진짜 변수이지만, 이 조사 시점 Anthropic의 공식 환경변수 문서 페이지(80개 이상의 변수를 문서화)에는 등재되어 있지 않으며([공식 문서](https://code.claude.com/docs/en/env-vars)), Anthropic 자체 이슈 트래커에 이를 문서화해달라는 미해결 이슈(`#33430`)와 동작이 불명확하다는 이슈(`#3833`, `#25762`)가 존재한다([GitHub Issue #33430](https://github.com/anthropics/claude-code/issues/33430)).

macOS에서 Claude Code는 OAuth 자격증명을 macOS Keychain의 generic-password 아이템으로 저장하고("Claude Code-credentials" 서비스명), Windows/Linux/WSL에서는 OS 시크릿 스토어 없이 **평문 `.credentials.json` 파일**을 사용한다(도구 리버스엔지니어링, [claude-swap README](https://raw.githubusercontent.com/realiti4/claude-swap/main/README.md), [gist.github.com/jtbr](https://gist.github.com/jtbr/4f99671d1cee06b44106456958caba8b)). 이 조사 범위에서 검토된 어떤 도구도 Windows Credential Manager/DPAPI를 사용하지 않았다 — Windows에서는 저장 시점 보안이 macOS보다 구조적으로 약하다는 점을 설계 시 의식적으로 반영해야 한다.

Codex 쪽은 상대적으로 더 많이 공식 문서화되어 있다(공식 문서, [Authentication](https://learn.chatgpt.com/docs/auth)). `CODEX_HOME`(기본 `~/.codex`)이 명시적 환경변수이고, 자격증명은 `CODEX_HOME/auth.json` 평문 파일 또는 OS 자격증명 스토어에 저장되며, `cli_auth_credentials_store` 설정 키가 `file`/`keyring`/`auto`/`ephemeral` 중 선택할 수 있게 해준다(공식 문서, [Authentication](https://learn.chatgpt.com/docs/auth)). 다만 공식 문서 어디에도 다중 계정 운용이나 여러 `CODEX_HOME` 사용 언급은 없다 — 이는 명시적으로 확인·부재를 검증한 결과다([Authentication](https://learn.chatgpt.com/docs/auth), [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)). `auth.json`의 정확한 JSON 필드명(예: `refresh_token` 필드가 실재하는지)은 공식 문서에서 서술적으로만("access token", "OAuth token") 다뤄질 뿐 리터럴 스키마로 공개되지 않아 **미확인**으로 남는다.

두 CLI 모두에서 자격증명 위치는 CLI 내부 구현에 결합되어 있다는 공통점이 있다 — Anthropic·OpenAI 어느 쪽도 파일 포맷이나 락 프로토콜을 안정적 계약으로 보장하지 않으므로, 이를 건드리는 모든 서드파티 도구는 CLI 버전 업데이트마다 깨질 수 있는 구조적 취약성을 안고 있다(추론, `claude-swap`의 락 프로토콜 주석이 "2.1.218 번들 기준 검증됨"이라고 버전을 못박아 둔 것이 방증). VIDE 구조가 자식 프로세스 실행 시 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`을 **지워서** 격리한다는 것은, 매 실행마다 새 프로세스가 그 변수를 다시 설정하지 않는 한 기본 `~/.claude`/`~/.codex`로 돌아간다는 뜻이며, 이는 아래 "설계 선택지" 절에서 다시 다룬다.

## 단일 사용 refresh token 경합: 다섯 개의 독립 프로젝트가 같은 버그를 재발견했다

OAuth 리프레시 토큰 로테이션(refresh token rotation, 1회용 토큰)은 Anthropic·OpenAI 둘 다 채택한 방식이며, 이 때문에 **같은 자격증명 파일을 두 프로세스가 동시에 갱신 시도**하면 구조적으로 경쟁 조건이 발생한다. 가장 명확한 사례는 `openai/codex#10332`("Race condition in OAuth token refresh causes 'refresh token was already used' error when multiple app-server instances run concurrently")로, Codex CLI v0.93.0에서 재현되었고 시퀀스는 다음과 같다: (T0) 여러 프로세스가 동시에 토큰 만료를 감지 → (T1) 프로세스 A가 갱신에 성공해 새 토큰을 디스크에 기록 → (T2) 프로세스 B가 이미 회전되어 무효화된 옛 refresh token으로 갱신을 시도 → (T3) B가 "Your access token could not be refreshed because your refresh token was already used" 오류(`refresh_token_reused`)로 실패한다. 이 이슈는 OpenAI에 의해 **"not planned"로 종료**되었고 공식 수정은 배포되지 않았다(공식 이슈 트래커, [openai/codex#10332](https://github.com/openai/codex/issues/10332)).

동일한 실패 시그니처가 완전히 독립된 최소 4개 프로젝트에서 재발견되었다: `openclaw/openclaw#26322`·`#142619`, `Sarrius/pi-multi-account#55`, `NousResearch/hermes-agent#114012`, `vectorize-io/hindsight#1637`([GitHub Issues](https://github.com/openclaw/openclaw/issues/26322)). 특히 `hermes-agent#114012`는 "자체 복구(self-heal) 루틴이 기본 `~/.codex` 경로만 확인하고 프로필별/커스텀 `CODEX_HOME` 위치를 놓친다"는 구체적 함정을 지적한다 — `CODEX_HOME` 오버라이드에 의존하는 관리 도구는 헬스체크·복구 로직까지 실제 활성 `CODEX_HOME`을 존중하는지 감사해야 한다는 교훈이다. Claude Code 쪽에서는 이 조사에서 동등한 GitHub 이슈가 직접 확인되지는 않았지만, `claude-swap`은 정확히 이 위험을 예방하기 위해 Claude Code 자체의 광고성 잠금(advisory lock, `proper-lockfile` 기반 `mkdir` 원자성)을 리버스엔지니어링해 **같은 락을 잡고** 스왑을 수행한다: 주 락 `<config-home>/.oauth_refresh.lock`, 레거시 락 `<config-home>.lock`을 순서대로 획득하며 둘 다 `stale: 60000ms, update: 5000ms`이고, Claude Code 자신은 자격증명 락을 5회까지 1~2초 지터로 재시도한다(도구 리버스엔지니어링, [claude_locks.py](https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/claude_locks.py)).

관찰된 완화 패턴은 크게 세 가지로 분류된다.

| 패턴 | 대표 도구 | 요지 |
|---|---|---|
| 공유 파일을 아예 만들지 않음(격리) | `codex-profiles`, `aisw`, claude-swap의 세션 모드 | 계정마다 별도 `CODEX_HOME`/`CLAUDE_CONFIG_DIR`를 사용해 두 프로세스가 물리적으로 같은 `auth.json`/`.credentials.json`을 건드릴 일이 없게 함 |
| 네이티브 잠금을 재사용(협조적 락) | `claude-swap`(스왑 시) | CLI 자신이 이미 쓰는 락 파일을 같은 프로토콜로 잡아, CLI의 진행 중 갱신을 중단시키거나 스왑이 갱신에 의해 덮어써지는 것을 막음 |
| 자체 단일 소유자·원자적 쓰기(중재자) | `teamclaude`, `cc-router`, `codex-plugin-cc#382`의 심볼릭 링크 패턴 | 갱신은 오직 한 프로세스(프록시/브로커)만 수행하고 결과를 원자적으로 씀; `codex-plugin-cc#382`는 여러 워크스페이스가 각자 `CODEX_HOME`을 갖되 `auth.json`만 실사용자 홈으로 **심볼릭 링크**해 단일 진실원을 유지하는 절충안을 제시([GitHub Issue #382](https://github.com/openai/codex-plugin-cc/issues/382)) |

생태계 전문가들의 결론은 명확하다: "만료된 토큰의 갱신은 언제나 Codex CLI 자체에 위임하고, 서드파티 코드가 직접 공유 refresh token을 소비해서는 안 된다"([antiburn/antiburn#442](https://github.com/antiburn/antiburn/issues/442))는 조언이 여러 프로젝트에서 수렴적으로 나온다. Claude Code 자체의 refresh token 수명(며칠/몇 주)은 이 조사에서 **어느 소스에서도 구체적 숫자를 확인하지 못했다** — `claude-swap`은 access token 만료(`expiresAt`, 5분 조기 갱신 버퍼)와 별개로 `refreshTokenExpiresAt` 필드를 노출하지만 그 전형적 값은 문서화되어 있지 않다(도구 리버스엔지니어링, [oauth.py](https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/oauth.py)). 커뮤니티 도구 `dennislwy/cswap-token-refresher`가 "만료 임박한 refresh token을 주기적으로 운동시켜 갱신"하는 크론잡으로 존재한다는 사실 자체가, 유휴 계정이 순수한 비활동만으로 stale해질 수 있다는 커뮤니티의 암묵적 믿음을 방증하지만, 이 역시 메커니즘·기간이 확정되지 않은 **추론**이다.

## 한도 감지는 반응형(파싱)이 아니라 선제형(폴링·헤더)으로 수렴한다

`claude-swap`의 자동 전환 엔진은 Claude Code CLI의 stdout이나 exit code, stream-json 이벤트를 파싱하지 않는다. 대신 비공개 계정별 사용량 엔드포인트(`GET https://api.anthropic.com/api/oauth/usage`, `anthropic-beta: oauth-2025-04-20` 헤더)를 각 계정의 access token으로 직접 폴링해 5시간/7일 창의 사용률을 계산하고, 활성 계정의 5h 또는 7d 사용률이 설정 가능한 임계치(기본 90%)를 넘으면 한도에 **도달하기 전에** 여유가 가장 많은 계정으로 전환한다. 히스테리시스 마진과 기본 5분 쿨다운으로 임계치 근처에서 계정이 앞뒤로 튀는(flapping) 것을 방지한다(도구 리버스엔지니어링, [autoswitch.py](https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/autoswitch.py), [README](https://raw.githubusercontent.com/realiti4/claude-swap/main/README.md)). 이 방식은 CLI의 정확한 "한도 도달" 문구 변경에 영향받지 않는다는 장점이 있지만, 대신 **Anthropic이 언제든 바꾸거나 없앨 수 있는 비공개 엔드포인트**에 의존한다는 대가를 치른다.

Codex 쪽 신호는 더 불안정한 것으로 보고된다. Codex의 `usage_limit_reached` 조건과 `token_count` 이벤트 내부 `rate_limits`(primary/secondary 서브윈도우, `window_minutes: 10080`=7일) 필드는 **app-server 전송 방식**에서는 노출되지만 `codex exec --json`(JSONL) 전송에서는 역사적으로 `null`이었다는 미해결 기능 요청이 존재한다(`openai/codex#14728`, [GitHub](https://github.com/openai/codex/issues/14728)). 이 신호 불안정성 때문에 최소 4개의 독립 다운스트림 도구(`TheDeepestSpace/the-intern#205`, `SmartTechBrewery/swarm#963`, `aiur-team/aiur#2737`, `coleam00/Archon#3353`)가 "Codex의 한도 도달을 일반 오류로 오분류해 자동 재시도가 되지 않는다"고 보고했다([GitHub Issues](https://github.com/TheDeepestSpace/the-intern/issues/205)). `codex-multi-auth`는 이 불안정성에 대응해 반응형(연속된 5xx 버스트 시 짧은 쿨다운)과 **선제 예측형**(`preemptive-quota-scheduler.ts`, `quota-readiness.ts`, `quota-probe.ts`)을 모두 구현했다(도구 리버스엔지니어링, [GitHub 모듈 목록](https://github.com/ndycode/codex-multi-auth)).

가장 정교하게 문서화된 스케줄링 알고리즘은 `teamclaude`다(도구 리버스엔지니어링, [README](https://github.com/KarpelesLab/teamclaude)): (1) 모델별 주간 한도가 소진된 계정을 스킵(eligibility filtering), (2) 사용자 설정 우선순위(`teamclaude priority <name> 1`, 낮을수록 선호), (3) 5h/7d 버킷이 임계치(**기본 98%**)에 도달하면 주간 리셋이 가장 임박한 계정을 우선해 선제 회전(threshold-based drain), (4) 대량 페일오버가 새 계정을 다시 소진시키지 않도록 요청 페이싱(storm control), (5) 선택적으로 모든 계정이 소진됐을 때 429 대신 리셋까지 요청을 홀드(`holdSeconds`). 결정적으로 `teamclaude`는 Anthropic의 `anthropic-ratelimit-unified-*` 응답 헤더를 읽어 **소진된 할당량 버킷과 일시적 분당 429를 구분**하고 전자에만 회전한다 — 이는 단순 "오류 나면 무조건 회전" 로직보다 명백히 더 성숙한 설계다. `cc-router`는 세션 단위로 계정을 고정(sticky routing, 2–20계정에 분산)해 Anthropic 프롬프트 캐시 적중률을 유지하면서 한도 도달 시에만 다른 계정으로 페일오버한다(도구 리버스엔지니어링, [README](https://github.com/Timo972/cc-router)). 다만 이 조사에서 검토한 어떤 프록시도 공식적으로 문서화된 **능동적 헬스체크 핑**(계정이 여전히 인증되어 있는지 백그라운드로 확인)은 갖고 있지 않았다 — 모든 감지는 실사용 요청의 응답 헤더/오류 코드에 반응하는 방식이었다(추론).

## 동시 실행은 가능하지만 "격리가 깨졌을 때만" 문제가 생긴다

커뮤니티 가이드와 다수의 3rd-party 문서는 서로 다른 `CLAUDE_CONFIG_DIR`를 가진 두 `claude` 프로세스, 서로 다른 `CODEX_HOME`을 가진 두 `codex` 프로세스가 "잠금이나 충돌 없이" 동시에 동작한다고 일관되게 설명한다(3rd-party 가이드, [wmedia.es](https://wmedia.es/en/tips/claude-code-multiple-profiles-config-dir), [DEV Community](https://dev.to/jguillaumesio/multiple-accounts-in-claude-code-the-complete-setup-10ek)) — 다만 이는 **Anthropic 자신의 공식 성명이 아니라 커뮤니티 관찰**이라는 점을 명시해야 한다(미확인). `codex-profiles` 저자는 macOS에서 개인/업무 두 프로필의 Codex Desktop 앱을 실제로 동시 실행하는 스크린샷을 공개했다(반-공식/저자 보고, [OpenAI Community](https://community.openai.com/t/codex-profiles-switch-codex-accounts-without-copying-auth-json/1380415)).

반대로, 실제 보고된 모든 경쟁 조건 버그는 **격리가 의도치 않게 깨진 경우**에서 발생했다. `openai/codex-plugin-cc#382`는 플러그인이 워크스페이스마다 하나의 장기 실행 `codex app-server`를 띄우면서 `CODEX_HOME`을 설정하지 않고 상속된 환경변수를 그대로 넘겨, 서로 다른 저장소의 두 Claude Code 세션이 거의 동시에 리뷰를 트리거하면 하나가 실패하고 `~/.codex`에 orphan 임시 파일이 쌓이는 구체적 사례를 기록했다([GitHub Issue #382](https://github.com/openai/codex-plugin-cc/issues/382)). `openclaw/openclaw#142619`는 `appServer.homeScope="user"`처럼 **의도적으로** 하나의 Codex 홈을 여러 세션이 공유하도록 설정했을 때 경쟁이 재현됨을 보여준다. 즉 결론은: 동시성 자체는 문제가 아니고, 자격증명 파일의 **단일 소유권 원칙**이 깨지는 순간 문제가 발생한다(추론). 반대로 macOS Keychain은 `CLAUDE_CONFIG_DIR` 스왑만으로는 네임스페이스가 분리되지 않을 수 있다는 잠재적 격리 허점도 지적되었다([gist.github.com/jtbr](https://gist.github.com/jtbr/4f99671d1cee06b44106456958caba8b)) — Windows는 파일 기반이라 이 문제 자체가 없다.

알려진 버그 중 이식 설계에 특히 중요한 것들을 정리하면 다음과 같다.

| 버그/이슈 | 도구 | 근본 원인 | 상태 |
|---|---|---|---|
| `refresh_token_reused` 경쟁 | `openai/codex` 등 5개+ 프로젝트 | 1회용 refresh token을 두 프로세스가 동시 소비 | 공식 "not planned"([#10332](https://github.com/openai/codex/issues/10332)) |
| MCP OAuth 토큰 오염 | `claude-swap` | 계정 스왑이 파일 전체를 덮어써 무관한 MCP 서버 토큰까지 정지 스냅샷으로 교체 | 종료(수정됨), 재발 가능한 설계 결함으로 지목됨 |
| self-heal이 커스텀 `CODEX_HOME` 무시 | `hermes-agent` | 복구 로직이 기본 경로만 확인 | 도구별 개별 버그 |
| `cswap add` 경쟁 조건 | `claude-swap` | 계정 추가 작업 자체의 동시성 미보호 | 열림(2026-09-21) |
| 만료된 자격증명의 강제 임포트 실패 | `claude-swap` | `import --force`가 만료된 토큰을 복구하지 못함 | 종료, 엣지 케이스로 남음 |
| Windows 파일 잠금으로 스토리지 정리 실패 | `codex-multi-auth` | Windows 파일 시스템 잠금 특성 | `doctor --fix`로 우회 |

## Anthropic의 2026-01/02 제3자 OAuth 차단이 규범적 경계선을 그었다

Anthropic Consumer Terms 3항은 "봇, 스크립트 또는 기타 자동화/비인간적 방식"의 접근을 API 키 사용 또는 명시적 허가가 없는 한 금지하고, 2항은 계정 로그인 정보·API 키·자격증명을 타인과 공유하거나 계정을 타인이 쓰게 하는 것을 금지한다(공식 약관, [Anthropic Consumer Terms](https://anthropic.com/legal/terms), 한국어판, 2026-09-24 확인). 이와 별개로, 복수의 독립 매체가 **2026-01-09**에 Anthropic이 서버 측 기술 안전장치를 배포해 구독(Free/Pro/Max) OAuth 토큰이 공식 Claude Code CLI 밖에서 동작하지 못하도록 차단했고("This credential is only authorized for use with Claude Code and cannot be used for other API requests" 오류), OpenCode·Roo Code·Cline 등이 하룻밤 사이에 작동을 멈췄다고 보도했다(3rd-party 기술언론, [VentureBeat](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses), [MindStudio](https://www.mindstudio.ai/blog/anthropic-openclaw-ban-oauth-authentication)). 2026-02-20에는 The Register가 Anthropic 엔지니어 Thariq Shihipar의 발언("Third-party harnesses using Claude subscriptions create problems for users and are prohibited by our Terms of Service")과 갱신된 컴플라이언스 페이지 문구("Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service...is not permitted")를 함께 보도하며 이를 "명확화"로 규정했다(3rd-party 기술언론이지만 회사 관계자 직접 인용, [The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/)). 표준 API 키 사용자나 OpenRouter 연동은 이 차단의 영향을 받지 않았다고 보도되었다(3rd-party, [VentureBeat](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses)).

이 정책의 명시적 타깃은 OpenClaw·OpenCode처럼 **구독 토큰을 다른 하네스에 흘려 넣어 종량제 API 비용을 우회**하는 도구들이었다("does not explicitly mention account switchers or credential-sharing tools by name", [alternativeto.net](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use/)). 반면 "정상적으로 로그인된 여러 개인 계정을 보유하는 것" 자체는 위반이 아니라는 설명이 있으나, 이는 Anthropic 직원의 비공식 발언을 2차 블로그가 요약한 것으로 **일화/비공식** 수준이며 약관 원문에 직접적인 문구는 없다(비공식, [MetricNexus 요약](https://metricnexus.ai/blog/anthropic-banning-multiple-claude-accounts)). 결정적 구분선은 다음과 같이 요약된다: **경계 안쪽** — 여러 개의 개별 구매·정상 로그인된 계정을 공식 `claude`/`codex` CLI로 각각 정상 인증해 사용하는 것; **경계 바깥쪽** — OAuth 토큰(또는 refresh token)을 CLI 밖으로 추출해 별도 프로그램·프록시·엔드포인트에 재사용하거나 제3의 프로그램이 그 토큰으로 API를 직접 호출하게 하는 것. 이 조사에서 검토한 도구 중 `claude-relay-service`, `sub2api`류는 후자에 가까운 위험을 스스로 인정하며 "이 프로젝트 사용이 Anthropic 약관을 위반할 수 있다"는 면책 문구를 README에 명시한다(도구 자체 고지, [claude-relay-service README](https://github.com/Wei-Shaw/claude-relay-service/blob/main/README_EN.md)). 반면 `claude-swap`이나 `codex-profiles`처럼 공식 CLI 프로세스를 그대로 실행하되 그 프로세스가 보는 자격증명 위치·내용만 바꾸는 방식은 자격증명이 공식 CLI 바깥으로 나가지 않으므로 원칙적으로 이 금지선에 걸리지 않는 쪽에 더 가깝다(추론).

한도 회피를 노린 "자동화된 라운드로빈"에 대해서는 두 회사 모두 재량적 집행 권한(경고→기능 제한→정지→해지)을 광범위하게 유보하고 있다(공식 약관 프레임, [Anthropic Safeguards](https://support.claude.com/en/articles/8241253-safeguards-warnings-and-appeals), [OpenAI 경고 안내](https://help.openai.com/en/articles/10562178-why-did-i-receive-a-warning-about-my-account)). "다수의 개인 구독 계정을 한도 회피 목적으로 순환 사용했다는 이유만으로" 계정이 정지된, 이름이 확인된 1차 소스 사례는 이 조사에서 발견되지 않았다 — 확인된 공식 집행 사례(OpenAI의 2025-10 위협 인텔리전스 보고서 등)는 모두 국가 연계 악성 사용·피싱망 같은 전혀 다른 범주였다(공식, [OpenAI 위협 보고서 관련 보도]). "IP/VPN 급변", "분당 수십 개 대화 생성", "하루 1만 토큰에서 세션당 200만 토큰으로 급증" 등이 계정 정지를 유발한다는 설명은 다수의 사용자 포럼·블로그에서 반복되지만 전부 **일화** 수준이며 공식 기준으로 확인되지 않는다(일화, [LobeHub](https://lobehub.com/blog/avoid-claude-ai-account-disabled-issue), [autonomee.ai](https://autonomee.ai/blog/claude-code-account-suspended-banned-safe-usage/)). OpenAI는 반대로 자사 부정사용 방지 시스템이 정당한 계정을 오탐으로 과도하게 제한한 사고를 공식 상태 페이지에 게시한 바 있다(공식, [OpenAI Status](https://status.openai.com/incidents/01KW2E6W0503W4NXJNCVAG8V6T)) — 즉 "한도가 이상하게 빨리 닳는다"는 사용자 경험이 항상 약관 위반의 결과인 것도 아니다.

## VIDE 이식 시 참고할 설계 선택지

**선택지 A — 계정별 완전 격리 디렉터리(프로세스 스폰 시 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`을 계정 전용 경로로 설정).** VIDE의 현재 구조(자식 프로세스를 띄우고 두 환경변수를 지워 격리)는 이미 이 계열에 속한다. `codex-profiles`([OpenAI Community](https://community.openai.com/t/codex-profiles-switch-codex-accounts-without-copying-auth-json/1380415))와 `claude-swap`의 세션 모드(`cswap run`, [session.py](https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/session.py))가 이 패턴의 대표 사례다. 장점은 두 프로세스가 물리적으로 같은 `auth.json`/`.credentials.json`을 절대 건드리지 않으므로 refresh token 경쟁 조건이 구조적으로 발생하지 않는다는 것, ToS 경계상 "공식 CLI를 정상 로그인 상태로 여러 개 돌리는" 가장 방어 가능한 형태라는 것이다. 단점은 (1) 계정 수만큼 디스크에 완전한 설정 트리를 유지해야 하고, (2) 유휴 계정의 refresh token이 오래 갱신되지 않으면 일부 커뮤니티 도구(`dennislwy/cswap-token-refresher`)가 우려하는 "장기 미사용으로 인한 stale화" 위험에 노출될 수 있다는 것(미확정, 아래 미확인 사항 참조), (3) 계정마다 첫 로그인 시 브라우저 OAuth 플로우를 각각 완료해야 하므로 온보딩 자동화가 더 필요하다는 것이다. 이 방식을 채택할 경우 VIDE의 "환경변수를 지운다"는 현재 설명은 "지운다"보다는 "매 스폰마다 계정 전용 경로로 명시적으로 설정한다"로 강화하는 편이, `openclaw/openclaw#142619`(홈 공유 설정을 켰을 때만 경쟁이 재현된 사례)가 보여주듯 상속된 환경변수로 인한 우발적 홈 공유를 막는 데 더 안전하다.

**선택지 B — 공유 자격증명의 백업/복원(스왑) 후 순차 사용.** `claude-swap`의 기본 모드, `ming86/cc-account-switcher`가 이 계열이다. 장점은 계정마다 별도 디렉터리를 유지할 필요 없이 디스크 사용량이 적고 구현이 단순하다는 것. 단점은 원천적으로 **순차적**이라 VIDE가 여러 계정을 동시에 쓰고 싶다면 부적합하고, 스왑 도중 CLI 자신의 백그라운드 갱신과 경쟁할 위험이 있어(claude-swap이 CLI의 리버스엔지니어링된 락을 그대로 잡는 정교한 완화 로직을 갖췄음에도 "cswap add race condition"이 최근에도 보고됨) 구현 난도가 겉보기보다 높다. VIDE가 "동시 실행"을 요구한다면 이 선택지는 부적합하다.

**선택지 C — 계정 풀 프록시(로컬 HTTP 프록시가 여러 계정을 들고 요청을 라우팅).** `teamclaude`, `cc-router`가 대표적이며, 세션 고정(sticky routing)으로 프롬프트 캐시 지역성을 지키면서 응답 헤더(`anthropic-ratelimit-unified-*`) 기반으로 소진된 계정만 정밀하게 골라 회전하는 가장 성숙한 스케줄링을 갖췄다. 장점은 동시성과 자동 회전을 모두 자연스럽게 얻고, 토큰 갱신을 한 프로세스(프록시)가 전담해 경쟁 조건을 원천 차단한다는 것. 단점은 **ToS 경계에 가장 가깝게 붙는 선택지**라는 점이다 — `cc-router`처럼 CLI의 네이티브 OAuth를 그대로 사용하고 로컬호스트 프록시만 세우는 방식은 "공식 CLI가 여전히 자기 계정으로 인증한 채 동작"하는 것에 가깝지만, `claude-relay-service`처럼 **프록시가 자체 발급한 API 키를 CLI에 주입**하는 방식은 CLI가 자신의 원래 계정으로 인증하지 않게 되므로 Anthropic의 2026-01/02 차단이 겨냥한 "제3자가 구독 OAuth 토큰을 다른 제품에 재사용"하는 패턴과 형태적으로 유사해질 위험이 있다(추론). VIDE가 이 계열을 참고한다면, 프록시가 토큰을 *다른 프로그램에 주입*하는 방향이 아니라 *공식 CLI 자신이 자기 자격증명으로 인증하도록 유지한 채 트래픽만 관측·분배*하는 `cc-router` 스타일에 더 가깝게 설계하는 편이 ToS 경계에서 더 안전한 쪽이다.

**선택지 D — 반응형 대 선제형 한도 감지.** `claude-swap`(비공개 사용량 API 폴링)과 `teamclaude`(HTTP 응답 헤더 파싱)는 모두 선제형이고, 다수의 다운스트림 Codex 통합 도구가 겪은 "한도 도달이 일반 오류로 오분류됨" 문제(`openai/codex#14728`와 그 하위 이슈들)는 반응형(stdout/exit-code 파싱)의 취약점을 보여준다. `claude -p`의 헤드리스 모드가 인터랙티브 세션과 동일한 stdin 기반 statusline JSON 페이로드(5h+7d rate-limit 창 포함)를 어떤 형태로든 노출하는지는 이 조사에서 확인되지 않았다(미확인, 아래 참조) — 확인된다면 VIDE 컨트롤러가 별도 API 호출 없이 재사용할 수 있는 가장 저비용의 신호가 된다. 확인되지 않는다면 `anthropic-ratelimit-unified-*` HTTP 헤더를 직접 관측하는 경량 프록시(선택지 C의 축소판)가 대안이다.

## 사용자 확정 방향(2026-09-24)에 따른 기능별 정리

사용자는 필요한 기능을 **① 계정별 사용량 파악, ② 계정 간 수동 전환, ③ 가능하면 자동 전환, ⑤ 계정 등록·재로그인** 네 가지로 확정했고, **④ 에이전트별 계정 배정(동시 사용)은 제외**했다(설정·오류 대응 복잡도). 따라서 대상 모델은 "공급자당 활성 계정 하나, 전환은 순차"다. 이 절은 그 범위에서 조사 결과를 기능별로 다시 정리한 것이며 구현 계획이 아니다.

④를 빼면 설계가 단순해지는 지점이 두 곳이다. 첫째, 한 시점에 공급자당 프로세스가 하나뿐이므로 refresh token 경합(§"단일 사용 refresh token 경합")은 "전환 도중 CLI 자신의 백그라운드 갱신과 겹치는 경우"로 좁혀진다. 둘째, 계정 풀 프록시(선택지 C)와 스케줄러(teamclaude류)는 필요 없고, 남는 것은 격리 디렉터리(선택지 A)와 그 위의 얇은 전환·조회 계층이다. 다만 순차 전환이라도 **파일 스왑(선택지 B)보다 격리 디렉터리를 권한다** — claude-swap의 스왑 모드가 CLI 락을 리버스엔지니어링해 잡고도 `cswap add` 경합·MCP 토큰 오염 버그를 냈다는 사실이 스왑의 숨은 난도를 보여준다([claude_locks.py](https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/claude_locks.py), 이슈 표 참조). 격리 디렉터리에서는 "전환"이 곧 "다음 스폰 때 다른 경로를 넘기는 것"이라 파일을 옮길 일 자체가 없다.

### ⑤ 계정 등록·재로그인 — 나머지 셋의 전제

| 항목 | Claude Code | Codex CLI | 출처 신뢰도 |
|---|---|---|---|
| 계정 저장 위치 | `<CLAUDE_CONFIG_DIR>/.credentials.json`(Windows 평문), `.claude.json`은 `CLAUDE_CONFIG_DIR` 또는 `$HOME` 루트 | `<CODEX_HOME>/auth.json`(평문) 또는 OS keyring(`cli_auth_credentials_store`) | Claude: 도구 리버스엔지니어링([paths.py](https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/paths.py)) / Codex: 공식([Authentication](https://learn.chatgpt.com/docs/auth)) |
| 등록 방법 | 계정 전용 디렉터리를 `CLAUDE_CONFIG_DIR`로 지정한 채 `claude` 로그인(브라우저 OAuth) 1회 | 계정 전용 `CODEX_HOME`에서 `codex login`(`--device-auth` 가능) 1회 | 공식 명령 + 커뮤니티 패턴([codex-profiles](https://community.openai.com/t/codex-profiles-switch-codex-accounts-without-copying-auth-json/1380415)) |
| 로그인 상태 확인 | `claude auth status --json`(VIDE가 이미 사용, `authMethod` 확인) | `codex login status` | 공식 |
| 재로그인 필요 감지 | `invalid_grant` = refresh token 계보 사망(영구), `refreshTokenExpiresAt` 필드로 만료 예정 확인 가능. 수명 숫자는 미확인 | `refresh_token_reused`/인증 오류 시 재로그인. 수명 미확인 | 도구 리버스엔지니어링([oauth.py](https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/oauth.py)) |
| 주의 | Windows에는 Credential Manager 연동 도구가 없음 — 평문 파일이 계정 수만큼 늘어남 | 갱신은 항상 CLI에 맡기고 VIDE가 refresh token을 직접 소비하지 않음([antiburn#442](https://github.com/antiburn/antiburn/issues/442)) | — |

VIDE 코드와의 접점: 현재 `claude-cli.ts`·`codex-cli.ts`는 두 변수를 삭제한다. 등록·전환을 지원하려면 "삭제"를 "선택된 계정의 전용 경로를 명시 설정"으로 바꾸는 것이 유일한 코드 변경점이며, 나머지 실행 인수·이벤트 검증은 그대로다. 기존 사용자의 `~/.claude`/`~/.codex`를 "기본 계정"으로 그대로 두고 추가 계정만 전용 디렉터리를 쓰는 절충도 가능하나, 기본 경로는 사용자 셸의 다른 도구와 공유되므로 전환 대상에서 빼는 편이 경합을 피한다(추론).

### ② 수동 전환 — 격리 디렉터리면 "다음 실행부터 적용"으로 끝난다

- 전환의 실체는 저장된 "활성 계정 ID" 하나를 바꾸는 것이다. 진행 중인 CLI 프로세스는 자기 디렉터리로 끝까지 돌고, 다음 스폰부터 새 경로를 받는다. 실행 중 강제 전환은 취소 후 새 실행이며 이는 기존 SPEC-02.4 개입 계약과 같다.
- 사용자에게 보이는 것은 cswap의 `list`/`use <name>`에 해당하는 계정 목록·활성 표시·전환 행동이다. 어느 계정으로 실행됐는지는 요청 기록에 남겨야 사용량 귀속(①)과 오류 진단이 된다.
- 순차 전환이라도 전환 순간에 해당 계정의 CLI가 돌고 있으면 안 된다는 조건은 남는다. VIDE는 실행 중인 자식 프로세스를 이미 추적하므로(`execution.ts`의 active map) 전환 요청 시 "실행 중이면 거절 또는 종료 후 전환"으로 처리할 수 있다(추론).

### ① 사용량 파악 — 되지만 공식 계약이 아니다

| 신호 | Claude Code | Codex CLI | 신뢰도·한계 |
|---|---|---|---|
| 계정별 사용률(5h/7d) 직접 조회 | 비공개 `GET https://api.anthropic.com/api/oauth/usage`(`anthropic-beta: oauth-2025-04-20`), 계정 access token 필요 — cswap 방식 | 확인된 동등 엔드포인트 없음 | Anthropic이 예고 없이 바꿀 수 있음([autoswitch.py](https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/autoswitch.py)) |
| 실행 스트림 안의 한도 정보 | 인터랙티브 statusline JSON에 5h/7d 창 포함. `claude -p` 헤드리스에서의 노출은 **미확인** | `token_count.rate_limits`는 app-server에서만 채워지고 `exec --json`은 null이라는 미해결 이슈 | [openai/codex#14728](https://github.com/openai/codex/issues/14728) |
| 한도 도달 오류 | 응답 헤더 `anthropic-ratelimit-unified-*`(프록시 경유 시), 메시지 문구 파싱은 취약 | `usage_limit_reached` 이벤트/오류 — 하위 도구들이 일반 오류로 오분류한 사례 다수 | 반응형 신호는 문구 변경에 깨짐 |

VIDE 관점의 정리: ①은 "표시용 보조 정보"로 두고, 조회 실패가 실행을 막지 않게 한다. Claude는 cswap과 같은 엔드포인트를 쓰면 되지만 이것이 이 조사 범위에서 **유일하게 토큰을 CLI 밖에서 직접 쓰는 지점**이므로 약관 경계 절과 함께 판단한다(읽기 전용 조회이며 추론 요청이 아니라는 점은 cswap이 2,788★로 공개 운영 중이라는 정황 외에 공식 확인이 없다). Codex는 현재 전송 방식(`exec --json`)에서 신호가 없을 가능성이 높아 실측이 먼저다.

### ③ 자동 전환 — ①에 종속되며, 순차 모델에서는 "다음 실행의 계정 선택"이다

- 동시 실행이 없으므로 자동 전환은 프록시의 실시간 라우팅이 아니라 **다음 스폰 직전에 활성 계정을 고르는 규칙**으로 축소된다: 활성 계정의 5h 또는 7d 사용률이 임계치(cswap 90%, teamclaude 98%)를 넘으면 여유가 가장 큰 계정으로 바꾸고, 히스테리시스·쿨다운(cswap 기본 5분)으로 되풀이 전환을 막는다.
- ① 신호가 없는 공급자(Codex)에서는 반응형만 가능하다: 실행이 한도 오류로 끝나면 해당 계정에 쿨다운을 걸고 다음 실행을 다른 계정으로 보낸다. 이때 한도 오류와 일시적 429·5xx를 구분해야 하며(teamclaude가 헤더로 구분하는 이유), 구분 못 하면 정상 계정을 불필요하게 돌려 쓰게 된다.
- 약관 관점: 자동 전환은 네 기능 중 "한도 회피용 순환"으로 해석될 여지가 가장 큰 기능이다. 조사에서 순환만으로 정지된 확인 사례는 없었지만 두 회사 모두 재량 집행권을 보유한다. 기본값을 끔으로 두고 사용자가 켜는 옵션으로 두는 것이 방어적이다(추론).
- 실행 중간 전환은 하지 않는다. 한도에 걸린 실행은 실패로 기록하고 재실행은 사용자 확인 또는 명시적 자동 재시도 설정에 따른다 — SPEC-02의 "불명확 쓰기 자동 재실행 금지"와 같은 원칙이다.

### 제외한 ④와 그 영향

동시 사용을 빼면 병렬 에이전트 속도 이득은 없고, 얻는 것은 한도 도달 시의 연속성이다. 나중에 ④를 넣더라도 격리 디렉터리 구조는 그대로 확장되며(프로세스마다 다른 경로만 넘기면 됨), 그때 새로 필요한 것은 계정 배정 규칙과 계정별 동시 실행 상한이다. 지금 ②·⑤를 격리 디렉터리로 만들어 두면 ④는 나중 선택지로 남는다.

## 확인이 필요한 미확인 사항

아래는 이 조사에서 소스를 확보하지 못했거나 신뢰도가 낮아 VIDE 설계 확정 전에 직접 검증이 필요한 항목이다.

- **Claude Code refresh token의 실제 수명.** `refreshTokenExpiresAt` 필드는 존재가 확인되었으나(도구 리버스엔지니어링, [oauth.py](https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/oauth.py)) 전형적 유효기간(일/주 단위)이 어디에도 문서화되어 있지 않다. **해결 방법**: 실제 Claude Max/Pro 계정으로 로그인 후 `refreshTokenExpiresAt` 값을 직접 읽어 로그인 시각과의 차이를 계산하거나, 장기간(예: 30/60/90일) 미사용 계정을 만들어 실측한다.
- **`claude -p` 헤드리스 모드가 5h/7d 사용량 신호를 어떤 채널로든 노출하는가.** 인터랙티브 세션의 statusline JSON 페이로드는 확인되었지만 헤드리스 모드에서의 동등한 노출 여부는 확인되지 않았다. **해결 방법**: `claude -p`를 실행하며 stdout/stderr를 전량 캡처하고, 별도로 HTTP 트래픽을 로컬 프록시로 가로채 응답 헤더(`anthropic-ratelimit-unified-*` 존재 여부)를 직접 관찰한다.
- **`codex exec --json`의 현재(2026-09) 시점 `rate_limits` 필드가 여전히 `null`인지.** 이슈 `#14728`은 미해결 상태로 남아 있으나 최신 Codex CLI 버전에서 실제 재현되는지는 직접 확인되지 않았다. **해결 방법**: 현재 설치된 `codex` 버전으로 `codex exec --json`을 실행해 `token_count` 이벤트의 `rate_limits` 값을 직접 관찰한다.
- **Claude Code 자체에 Codex의 `refresh_token_reused`와 동등한 경쟁 조건 이슈가 존재하는지.** 이 조사는 Codex 측 이슈만 다수 확인했고 `anthropics/claude-code` 저장소에서 동등한 이슈를 직접 검색하지 못했다. **해결 방법**: `anthropics/claude-code` 이슈 트래커에서 "refresh token", "concurrent", "invalid_grant" 키워드로 재검색한다.
- **macOS Keychain 서비스명이 `CLAUDE_CONFIG_DIR`별로 네임스페이스 분리되는지.** 스왑 도구들이 계정별 Keychain 백업 아이템을 따로 두긴 하지만, Claude Code 자신이 Keychain 조회 시 `CLAUDE_CONFIG_DIR` 값을 서비스명에 반영하는지는 확인되지 않았다(VIDE는 Windows 대상이라 우선순위는 낮음). **해결 방법**: macOS에서 서로 다른 `CLAUDE_CONFIG_DIR`로 두 계정을 로그인시킨 뒤 Keychain Access.app에서 아이템이 실제로 분리되는지 확인한다.
- **`CODEX_HOME`/`CLAUDE_CONFIG_DIR`을 지우는 것과 명시적으로 재설정하는 것의 차이가 Windows에서 실제로 문제를 일으키는지.** `openclaw/openclaw#142619`는 환경변수를 상속받아 우발적으로 홈을 공유하는 실패 사례를 보였다. VIDE가 "지운다"고 서술한 부분이 실제로는 상위 프로세스(사용자 셸)에 그 변수가 설정되어 있을 때 자식에게 상속되지 않는지, 아니면 명시적으로 빈 값/기본 경로로 되돌리는지 코드 레벨에서 재확인이 필요하다. **해결 방법**: `hosts`/컨트롤러 코드에서 `env` 구성 로직을 직접 추적하고, 상위 프로세스에 두 변수가 설정된 상태에서 자식 프로세스의 실제 `process.env`를 로깅해 검증한다.
- **Anthropic·OpenAI 어느 쪽도 "동일 개인이 소유한 다수의 정상 로그인 계정을 공식 CLI로 순차/병렬 전환하는 행위" 자체를 명시적으로 허용·금지한다고 확인된 1차 문서는 없다.** 확인된 것은 "제3자 제품에 토큰을 흘리는 행위"에 대한 금지뿐이다. **해결 방법**: 실제 서비스 출시 전 Anthropic·OpenAI의 지원 채널(또는 기업 영업 채널)에 VIDE의 정확한 사용 패턴(정상 로그인된 개인 계정을 공식 CLI 자식 프로세스로 전환)을 서면으로 문의해 명시적 확인을 받는다 — 커뮤니티 비공식 발언이나 조사 결과만으로 정책 결정을 내리지 않는다.
- **한국 결제·전화인증·법인 계정 관련 특이사항.** 이 조사는 Korea 특화 제약을 찾지 못했지만 이는 증거 부재이지 부재의 증거가 아니다. **해결 방법**: 실제 유료 플랜(Team/Enterprise) 도입 전 Anthropic·OpenAI 영업/지원팀에 한국 법인 결제·SMS 인증 관련 사항을 직접 문의한다.

## 결론

이 조사가 뒤집는 직관은 "동시 실행이 위험을 키운다"는 통념이다 — 실제로는 **동시성 자체가 아니라 자격증명 파일의 소유권이 흐려지는 순간**이 모든 refresh-token 경쟁 조건의 공통 원인이었고, `openai/codex#10332`부터 `openclaw/openclaw#142619`까지 다섯 개 넘는 독립 프로젝트가 정확히 같은 실패를 재발견했다는 사실은 이것이 개별 도구의 버그가 아니라 두 벤더의 OAuth rotation 설계 자체에서 나오는 구조적 성질임을 보여준다. VIDE가 이미 채택한 "자식 프로세스마다 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`을 격리한다"는 원칙은 이 생태계에서 가장 정교한 도구들(`codex-profiles`, `claude-swap`의 세션 모드)이 동시성을 얻기 위해 최종적으로 수렴한 것과 동일한 패턴이며, 공유 파일 스왑이나 토큰 주입형 프록시보다 ToS 경계에서도, 경쟁 조건 방지 측면에서도 더 방어 가능한 출발점이다. 다만 이 조사가 확실히 답하지 못한 것 — refresh token의 실제 수명, 헤드리스 모드의 사용량 신호 노출 여부, 벤더의 명시적 정책 확인 — 은 모두 설계를 굳히기 전에 직접 실측하거나 벤더에 문의해야 하는 항목이며, 특히 Anthropic이 2026년에 이미 한 차례 서버 측 기술 조치로 생태계 전체(OpenCode·Roo Code·Cline)를 하룻밤에 무력화한 선례가 있다는 점은, 지금 작동하는 어떤 메커니즘도 다음 벤더 업데이트에서 그대로 깨질 수 있다는 전제 위에서 VIDE의 격리 계층을 설계해야 함을 시사한다.
