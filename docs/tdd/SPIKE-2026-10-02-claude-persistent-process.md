---
id: SPIKE-2026-10-02-claude-persistent-process
title: Claude 대화를 프로세스 하나에 이어 보내기 — 턴 지연·하위 에이전트·도구 이름
status: review
version: 0.1
updated: 2026-10-02
owner: agent:claude
related: [ADR-028, PLAN-24, ARCH-01, SPEC-02, RESEARCH-11]
---

# Claude 대화를 프로세스 하나에 이어 보내기

## 질문

[ADR-028](../decisions/ADR-028-ai-cli-parity.md)의 결정 1(대화마다 Claude 프로세스 하나, 턴은 입력 스트림)과 4(하위 에이전트·할 일 목록·웹 도구)를 구현하기 전에 실제 CLI에서 확인할 것.

1. `-p --input-format stream-json` 프로세스 하나에 사용자 메시지를 여러 번 넣으면 턴마다 `result`로 끝나고 프로세스가 남는가. 둘째 턴은 얼마나 빨리 시작하는가.
2. 시작 이벤트(`system/init`)는 첫 턴에만 오는가, 턴마다 오는가(턴마다 도구 검사를 다시 할 수 있는가).
3. 하위 에이전트(`Task`)는 `--tools`로 좁힌 도구만 쓰는가. 결과는 어떻게 돌아오는가.
4. `TodoWrite`를 `--tools`에 넣으면 목록에 나오는가.

## 환경

- Claude Code 2.1.287(`C:\Users\user\.local\bin\claude.exe`), 기본 로그인(구독), 모델 `haiku`. `cli-compat.json` 범위(>=2.1.284 <2.2.0) 안.
- Windows 11, Node 24. `CLAUDE_*`·`ANTHROPIC_*` 환경 변수는 지우고 실행. 작업 폴더·스크립트는 세션 scratchpad(저장소 밖). 합성 문장만 보냄, 프로젝트 자료·호스트 없음.
- 인자: `-p --safe-mode --tools Task,TodoWrite,WebSearch,WebFetch --strict-mcp-config --mcp-config {"mcpServers":{}} --setting-sources "" --no-chrome --disable-slash-commands --permission-mode dontAsk --allowedTools <같은 목록> --input-format stream-json --output-format stream-json --verbose --model haiku --session-id <UUID> --system-prompt-snapshot off --append-system-prompt "Smoke test. Be terse."`
- 모델 호출은 프로세스 하나의 두 턴(턴 1 "Reply with the single word ONE.", 턴 2 하위 에이전트 하나에게 자기 도구 이름을 나열하게 함)뿐이다. 도구 이름 확인(4)은 시작 이벤트만 받고 모델 호출 전에 프로세스를 끝낸 세 번의 실행이다.

## 결과(실행한 것)

| 항목 | 관찰 |
|---|---|
| 턴 끝 | 턴마다 `result`(`subtype: success`)가 오고 프로세스는 다음 사용자 메시지를 기다린다. 표준 입력을 닫자 종료 코드 0으로 끝났다(전체 6.7초) |
| 시작 이벤트 | **턴마다 온다.** 첫 턴은 보낸 뒤 706 ms, 둘째 턴은 7 ms. 둘 다 같은 `session_id`·도구 목록 |
| 턴 지연 | 첫 턴: 보냄 → 첫 출력 0.7초, 답 1.9초. 둘째 턴: 보냄 → 시작 이벤트 7 ms(프로세스 기동·로그인·MCP 연결이 다시 없음) |
| 하위 에이전트 이름 | 시작 목록에는 `Task`, 호출 이벤트(`tool_use`)의 이름은 `Agent` |
| 하위 에이전트 실행 | **배경 실행이다.** 호출 결과는 곧바로 'Async agent launched'이고, 이벤트 `system/task_started` → 그 턴의 `result`('기다리는 중' 같은 중간 답) → 하위 에이전트의 `assistant`(`parent_tool_use_id` 있음) → `system/task_updated`·`system/task_notification` → **CLI가 스스로 시작한 턴**(시작 이벤트 + `result`)이 온다. 마지막 `result`가 실제 답이다 |
| 하위 에이전트의 도구 | 하위 에이전트가 나열한 자기 도구: `Agent, WebFetch, WebSearch` — 부모의 `--tools` 목록과 같고 셸·파일 도구가 없다 |
| `TodoWrite` | 2.1.287에서는 목록에 없다. `--tools`에 `TodoWrite,TaskCreate,TaskUpdate,TaskList,TaskGet`을 넣으면 목록은 `Task, TaskCreate, TaskGet, TaskList, TaskUpdate, WebFetch, WebSearch`(할 일 목록은 Task* 도구로 바뀜). `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`·`CLAUDE_CODE_ENABLE_TASKS=1`을 줘도 같다 |
| 모르는 이름 | `--tools`의 모르는 이름(`Agent`, `TodoWrite`)은 오류 없이 빠진다 |

## 구현에 반영한 것

- 턴의 끝 = 그 턴의 `result`이되, 그 턴이 시작한 하위 에이전트(`task_started`의 `task_id`)가 모두 보고(`task_notification`, 또는 끝난 상태의 `task_updated`)할 때까지 기다리고 마지막 `result`를 답으로 쓴다. 마지막 보고 뒤 CLI가 스스로 턴을 시작하지 않으면 5초 뒤 앞의 `result`를 답으로 쓴다(`src/ai/claude-process.ts` `BACKGROUND_SETTLE_MS`). 사용량은 그 턴의 `result`들을 더한다.
- 시작 이벤트가 턴마다 오므로 도구·MCP 검사(`initValid`)를 턴마다 한다. 세션 ID가 다르면 `SESSION_LOST`.
- 작업 도구 이름: `Task,TodoWrite,TaskCreate,TaskGet,TaskList,TaskUpdate`(옛 판·새 판 둘 다 덮음), 호출 이벤트의 `Agent`도 허용(`src/ai/agent-connection.ts` `CLAUDE_WORK_TOOLS`·`CLAUDE_SUBAGENT_CALL`).
- 측정: 진단 로그 `request-stages`에 `processReused`를 더했다. 이어 쓴 프로세스의 `spawnMs`는 턴을 써 넣은 때, `firstOutputMs - spawnMs`가 둘째 턴의 시작 지연이다.

## 확인하지 않은 것(한계)

- **중단(`control_request` `interrupt`):** 실제 CLI가 진행 중 턴을 끝내고 프로세스를 남기는지 보지 않았다. 구현은 중단 요청을 보내고 2초 안에 그 턴의 `result`가 오면 프로세스를 남기고, 아니면 프로세스를 끝낸다(다음 턴은 `--resume`). 가짜 CLI 시험만 있다.
- **VIDE MCP와 함께:** 이번 실행은 MCP 서버 없이 했다. 프로세스가 시작 때 받은 토큰(`VIDE_AGENT_TOKEN`)을 턴마다 그 턴의 범위로 잇는 중계(`src/ai/agent-relay.ts`)와, 둘째 턴부터의 MCP 호출, 하위 에이전트가 `mcp__vide__*` 도구를 쓰는지는 실제 CLI로 보지 않았다. 하위 에이전트가 부모의 도구 목록을 따른다는 것은 내장 도구로만 확인했다.
- **질문 도구·이미지·구조화 출력을 이어 쓴 표준 입력에서:** 가짜 CLI 시험만 있다(형식은 [SPIKE-2026-09-30-native-questions-claude](SPIKE-2026-09-30-native-questions-claude.md)의 단발 실행과 같다).
- **웹 도구의 실제 사용:** `WebSearch`·`WebFetch`가 목록에 나오는 것만 봤고 호출은 하지 않았다. Codex `web_search="live"`는 실행하지 않았다.
- 하위 에이전트를 앞쪽 실행으로 돌리는 방법(`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 등)은 시험하지 않았다.
