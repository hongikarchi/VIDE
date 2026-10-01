---
id: SPIKE-2026-09-30-codex-app-server
title: Codex app-server 경로 시험 (격리·모델 질문·시작 시간)
status: review
version: 0.1
updated: 2026-09-30
owner: agent:claude
related: [ADR-021, ARCH-01, SPEC-02, PLAN-24, RESEARCH-10, SPIKE-2026-09-30-cli-session-resume, SPIKE-2026-09-30-native-questions-claude]
---

# Codex app-server 경로 시험 (격리·모델 질문·시작 시간)

2026-09-30 사용자 결정 (4) "질문 카드는 지금 UI를 유지하고, 공급자 자체 질문 기능을 SPIKE해 가능한 곳은 출처를 바꾼다"의 Codex 쪽 기록이다. 지금 Codex 경로는 턴마다 `codex exec`(또는 `exec resume`)를 한 번 실행한다([SPIKE-2026-09-30-cli-session-resume](SPIKE-2026-09-30-cli-session-resume.md) ④). 여기서는 `codex app-server`(stdio JSON-RPC)를 대안으로 시험한다. 설치된 CLI에 합성 짧은 요청만 보냈고 프로젝트 자료·사용자 원본은 보내지 않았다.

## 질문과 합격 기준(실행 전)

| # | 질문 | 합격 기준 |
|---|---|---|
| A | `exec`의 격리를 app-server에서도 같게 걸 수 있는가: 읽기 전용 sandbox, 승인 없음, MCP는 VIDE 서버만, 셸·웹 없음, developer instructions = 지침 묶음 | 서버가 보고하는 값(스레드 응답·MCP 상태)으로 확인되고, 셸 요청이 실행되지 않음 |
| B | 모델 자체 질문(`item/tool/requestUserInput`)이 오고 턴 중에 답할 수 있는가 | 질문이 서버 요청으로 오고, 답을 보내면 같은 턴이 그 답으로 끝남 |
| C | 질문에서 턴을 멈추고 다음 턴에 답을 보내도 이어지는가(지금 카드 흐름) | 멈춘 턴이 `interrupted`, 다음 턴 답이 반영됨 |
| D | 시작 시간: 프로세스 기동·첫 턴·유지한 프로세스의 다음 턴을 `exec`와 비교 | 수치 기록 |
| E | 턴마다 바뀌는 VIDE MCP 연결(토큰·도구)을 한 프로세스에서 바꿀 수 있는가 | 같은 스레드가 새 연결로 다시 열림 |

## 방법·환경

- Windows 11, Node 24, Codex CLI 0.157.1(`installedCodex()`의 npm 설치본, ChatGPT 구독 로그인). 프로토콜은 `codex app-server generate-ts`로 뽑은 타입(v2)을 기준으로 했다. `requestUserInput`·`collaborationMode`는 EXPERIMENTAL 표시다.
- 시험 스크립트는 저장소 밖 임시 폴더에 두었다. 프로세스 인자는 `exec`와 같은 `-c`·`--disable` 묶음(`codexIsolationConfig`, `codexDisabledFeatures`)에 `--enable default_mode_request_user_input`을 더했다.
- VIDE MCP 자리에는 시험용 최소 HTTP MCP 서버(도구 `status` 하나, bearer 확인)를 띄웠다. 실제 VIDE MCP(설치된 VIDE 47821)는 건드리지 않았다.
- 시험이 만든 Codex 스레드 기록(`~/.codex/sessions/…/rollout-*.jsonl`)과 임시 폴더는 시험 뒤 지웠다.

## 결과 요약

| # | 판정 | 요지 |
|---|---|---|
| A | 조건부 통과 | `app-server`에는 `--ignore-user-config`가 없어 사용자 `config.toml`이 읽힌다. `-c mcp_servers={}`는 사용자 서버를 끄지 못한다(표 병합). 스레드 설정에서 서버별 `mcp_servers.<이름>.enabled=false`로 끄면 `mcpServerStatus/list`가 모두 `disabled`로 보고한다. sandbox `readOnly`·`networkAccess:false`·승인 `never`·`instructionSources: []`는 `thread/start` 응답으로 확인된다. 셸 실행 요청은 "셸 명령을 실행할 수 없다"로 끝났다 |
| B | 통과 | 질문이 `item/tool/requestUserInput`(질문 id·header·question·isOther·options)으로 오고, `{answers:{<id>:{answers:[라벨]}}}` 응답 뒤 같은 턴이 고른 답으로 끝났다(질문까지 약 5초, 답 뒤 약 2초) |
| C | 통과 | 질문 중 `turn/interrupt`를 보내면 대기 요청이 자동으로 풀리고(`serverRequest/resolved`) 턴이 `interrupted`로 끝난다. 다음 턴에 `질문 카드 답변:` 텍스트를 보내면 그 답으로 이어진다 |
| D | 기록 | 아래 표. 첫 턴은 `exec`와 비슷하고, 유지한 프로세스의 다음 턴이 조금 빠르다 |
| E | 통과 | `thread/unsubscribe` 뒤 새 설정으로 `thread/resume`하면 VIDE 서버가 새 주소로 다시 연결된다. 토큰은 명령줄이 아니라 JSON-RPC로 준 `http_headers`에 두었고, 스레드 기록 파일에 남지 않았다 |

### 시간 측정 (합성 한 단어 응답, 초)

| 경로 | 기동(초기화·스레드 시작) | 첫 턴 | 다음 턴 |
|---|---|---|---|
| `codex exec`(두 번) | — | 4.1 / 4.5 (프로세스 전체) | `exec resume`도 새 프로세스 |
| `app-server`(여러 번) | 0.1~1.3 | 3.6~5.1 | 1.3~4.1 (같은 프로세스) |
| 어댑터 실측(질문 포함 대화) | — | 6.1~9.7 (질문·답 포함) | 1.9~3.8 |

처음 실행 한 번은 사용자 MCP 서버를 아직 끄지 않아 첫 턴이 15.8초였다(MCP 시작 대기). 계정 한도는 `account/rateLimits/read`로 바로 읽힌다(사용률·재설정 시각·크레딧).

## 확인한 사항

- **도구는 code mode를 거친다.** `code_mode`·`code_mode_host`를 끄면 모델이 VIDE MCP를 부르지 못한다("도구 실행 환경이 비활성화"). 둘을 켜면 `mcpToolCall`(server `vide`, tool `status`)이 실행되고 결과가 답에 쓰였다. `exec`의 `configureAgentArguments`와 같은 조건이다. 기능 켜기는 프로세스 단위라, 연결이 있는 턴과 없는 턴이 번갈아 오면 프로세스를 바꾸고 스레드를 디스크에서 이어 연다.
- **질문 도구는 규칙이 허용해야 쓴다.** 세션 턴의 `turn-rules`("도구 없음")와 단발 지침("도구를 쓰지 말 것")이 있으면 모델은 질문 도구 대신 글로 물었다. 규칙 뒤에 질문 도구만 예외로 허용하는 문장을 붙이자 `requestUserInput`을 썼다.
- **이어 열기.** 새 프로세스에서 `thread/resume`로 앞 대화를 이어 받는다. 없는 스레드는 `no rollout found for thread id …` 오류로 오며 기존 `SESSION_LOST` 분류와 같다.
- **첫 시험의 사용자 MCP.** 서버별로 끄기 전 첫 실행 한 번에서 사용자 설정의 MCP 서버들(rhino 포함)이 시작 단계까지 갔다. 도구 호출은 없었다. 이후 실행과 어댑터는 스레드 시작 전에 모두 끄고, 끈 상태를 서버 보고로 확인한다.
- **남는 차이.** `app-server`는 사용자 `config.toml`의 모델 기본값·기능 설정을 읽는다(`exec`는 `--ignore-user-config`). 격리에 관계된 값은 프로세스 인자·스레드 설정으로 덮고 서버 보고로 확인하지만, 사용자 설정 전체를 무시하는 것과 같지는 않다. 질문 기능은 개발 중(under development) 기능 플래그다.

## 결정·구현

- 대안 경로로 쓸 수 있다. `src/ai/codex-app-server.ts`의 `CodexAppServer`(CodexCli 확장)를 플래그 뒤에 두었다: `VIDE_CODEX_APP_SERVER=1`일 때만 `execution.ts`가 Codex 요청에 이 공급자를 쓴다(기본 공급자 팩토리일 때만). 기본은 계속 `exec`다.
- 대화마다 프로세스 하나를 유지한다(스레드 id 기준, 10분 유휴 뒤 종료). 같은 대화의 두 번째 동시 턴은 `CONVERSATION_BUSY`로 거절한다. 턴의 토큰·도구·지침이 바뀌면 같은 프로세스에서 unsubscribe → resume, code mode 필요 여부가 바뀌면 새 프로세스에서 resume.
- 격리 확인(모두 실패 시 `UNEXPECTED_TOOL_ACCESS`, 턴 중 위반은 `UNEXPECTED_TOOL_CALL` + interrupt): 프로세스 인자(`appServerIsolated`), 보내기 전 스레드 인자(`threadParamsIsolated`), 서버의 스레드 응답(`threadResponseIsolated`), MCP 상태(`mcpStatusIsolated`), 턴 항목 허용 목록(셸·파일 변경·웹·다른 MCP·다른 도구면 중단), 승인 요청은 거절 후 중단.
- 질문: `requestUserInput`을 질문 카드(`turn-output` 모양, 권장 선택지 먼저, 비밀 질문은 보이지 않음)로 바꾼다. 처리기(`onQuestion` 또는 공급자 옵션 `nativeQuestions`, Claude 쪽과 같은 형식)가 있으면 턴 중에 답하고, 없으면 턴을 멈추고 카드를 `question` 턴 출력으로 돌려준다(지금 카드 흐름 그대로, 답은 같은 스레드의 다음 턴).
- 시험: `tests/ai/codex-app-server.test.mjs`(모의 JSON-RPC 17건). 실제 CLI로 질문→카드→턴 중 답→다음 턴(유지 프로세스)을 한 번 확인했다.

## 한계·다음

- 실제 VIDE MCP(설치본)와의 도구 호출은 이 시험에서 하지 않았다(최소 MCP 서버로 대신). 켜기 전에 개발 서버에서 도구 턴 하나를 확인한다.
- (2026-10-02 해소) `execution.ts`가 대화 턴에 턴 중 질문 처리기를 넘긴다. 답 대기 시간은 턴 제한 시간에 넣지 않는다(Claude와 같음). 실제 CLI에서 70초 대기 뒤 답해도 같은 턴이 이어졌다(`requestUserInput`에 60초 제한 없음).
- CLI 판 범위(`cli-compat.json`)는 그대로다. 판이 바뀌면 이 시험의 B·E와 격리 확인을 다시 한다.
