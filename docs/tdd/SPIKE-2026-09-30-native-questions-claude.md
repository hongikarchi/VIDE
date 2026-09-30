---
id: SPIKE-2026-09-30-native-questions-claude
title: Claude Code의 AskUserQuestion을 VIDE 질문 카드로 받기
status: draft
version: 0.1
updated: 2026-09-30
owner: agent:claude
related: [SPEC-02, PLAN-24, ADR-021, RESEARCH-10, RESEARCH-11]
---

# Claude Code의 AskUserQuestion을 VIDE 질문 카드로 받기

## 질문

사용자 결정(2026-09-30 ④): 질문 카드 화면은 유지하고, 공급자 자체 질문 기능으로 출처를 바꿀 수 있는지 확인한다. VIDE는 Claude Code를 `-p` 한 번 실행으로 돌리고, 지금은 `--json-schema` 구조화 출력(`status: question` + `questions`)으로 질문 카드를 만든다(`src/server/turn-output.ts`). 확인할 것은 두 가지다.

1. Claude Code가 `-p`에서 자기 질문 도구 `AskUserQuestion`을 호출할 때, 그 질문이 VIDE에 도달하는가.
2. VIDE가 사용자의 답을 **같은 실행 안에서** 돌려주고 모델이 그 답으로 계속하는가.

시도 순서: (a) `--permission-prompt-tool mcp__vide__ask`(VIDE MCP 도구), (b) stream-json 제어 프로토콜(`control_request` / `can_use_tool`), (c) 실패 시 현 구조화 출력 카드 유지.

## 환경

- Claude Code 2.1.285(`C:\Users\user\.local\bin\claude.exe`), 구독 로그인, 모델 `haiku`. `cli-compat.json` 범위(>=2.1.284 <2.2.0) 안.
- Windows 11, Node 24. 에이전트 셸의 `CLAUDE*`/`ANTHROPIC*` 환경변수는 지우고 실행.
- 작업 폴더·스크립트는 세션 scratchpad(`…/scratchpad/nq/`). 저장소에는 두지 않음.
- 프롬프트는 합성 문장만: "Use the AskUserQuestion tool once to ask which color I prefer, with options Red and Blue. Then reply with only the chosen color." 프로젝트 자료 없음.
- 공통 인자(아래 `$COMMON`): `-p --strict-mcp-config --mcp-config <cfg> --setting-sources '' --no-session-persistence --no-chrome --disable-slash-commands --output-format stream-json --verbose --model haiku`.

## 조사: CLI가 무엇을 지원하는가

- `claude --help`에 `--permission-prompts <host|none>`이 있고 "host (the SDK host or --permission-prompt-tool)"로 설명된다. `--permission-prompt-tool <tool>`은 help 목록에 없지만 인자 해석기에는 있다("MCP tool to use for permission prompts (only works with --print)").
- 실행 파일 안 문자열: `control_request`/`control_response`, `can_use_tool`(요청 필드 `tool_name`, `input`, `tool_use_id`, `requires_user_interaction`), `AskUserQuestion`의 "parked … host_answer" 처리, 그리고 답은 `updatedInput.answers`로 받는다. 즉 AskUserQuestion은 **권한 요청 경로**로 호스트에 간다.

## 결과

| # | 방법 | 명령(요지) | 관찰 | 판정 |
|---|---|---|---|---|
| a1 | MCP 권한 도구 | `$COMMON --tools AskUserQuestion --permission-prompt-tool mcp__vide__ask "<prompt>"` (stdio MCP 서버의 `ask`) | 모델이 `AskUserQuestion` tool_use → CLI가 `ask({tool_name:"AskUserQuestion", input:{questions:[…]}, tool_use_id})` 호출 → `{"behavior":"allow","updatedInput":{…,"answers":{"Which color do you prefer?":"Blue"}}}` 반환 → tool_result `Your questions have been answered: "…"="Blue"` → 최종 답 `Blue` | **통과** |
| a2 | a1 + `--permission-mode dontAsk` | 같음 | `ask`가 불리지 않음. tool_result "Permission to use AskUserQuestion has been denied because Claude Code is running in don't ask mode" | 실패(모드 때문) |
| a3 | a1 + `--allowedTools mcp__vide__ping` | 모델에게 ping 후 질문 요청 | `ping`은 권한 도구를 거치지 않고 바로 실행, `AskUserQuestion`만 `ask`로 옴 | 통과 |
| a4 | a1 + 답을 150초 늦춤 | `ASK_DELAY=150000` | 150초 뒤 답 반영, 실행 정상 종료(`result success`) | 통과 |
| b1 | stream-json, 권한 경로 없음 | `$COMMON --tools AskUserQuestion --input-format stream-json` (stdin에 user 메시지) | init의 `tools: []` — 도구가 목록에서 빠짐. 모델이 텍스트로 가짜 `<function_calls>`를 씀 | 실패 |
| b2 | b1 + `initialize` 제어 요청 먼저 | `{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize"}}` | `control_response success`(commands·agents 목록)이지만 여전히 `tools: []` | 실패 |
| b3 | b2 + `--permission-prompt-tool stdio` | 같음 | init `tools:["AskUserQuestion"]` → tool_use → stdout에 `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{…},"tool_use_id":"…","requires_user_interaction":true}}` → stdin에 `{"type":"control_response","response":{"subtype":"success","request_id":"<uuid>","response":{"behavior":"allow","updatedInput":{…,"answers":{…:"Blue"}}}}}` → tool_result 반영 → `Blue` | **통과** |
| b4 | b3에서 `initialize` 생략 | 같음 | b3와 같게 동작 — `initialize`는 필요 없음 | 통과 |
| b5 | b4 + `--permission-mode dontAsk` | 같음 | `system/permission_denied`(decision_reason_type `mode`), 제어 요청 없음 | 실패(모드 때문) |
| b6 | b4, 답 대신 거절 | `response:{"behavior":"deny","message":"The user closed the question without answering."}` | tool_result `is_error:true` + 그 문구, 모델이 텍스트로 다시 묻고 종료 | 통과(닫기 경로) |
| b7 | b4, 답을 150초 늦춤 | 같음 | 150초 뒤 반영, 정상 종료 | 통과 |
| s1 | 어댑터 실사용 | `new ClaudeCli({ nativeQuestions })` + VIDE 기본 인자(`--safe-mode`, `--tools ''`→`AskUserQuestion`, `dontAsk`→`default`, `--permission-prompt-tool stdio`, stream-json 입력) | 카드 `[{id:"q1",title:"Should the test box be 1 m or 2 m wide?",options:[{id:"o1",label:"1 m"},{id:"o2",label:"2 m"}],allowFree:true}]` → 답 `o2` → 결과 `2 m`, 진행 단계 `model > question > model` | 통과 |

(a)·(b) 모두 AskUserQuestion을 받고 답할 수 있다. 공통 조건:

- `--permission-mode dontAsk`에서는 도구가 모드 단계에서 거절되어 호스트에 오지 않는다. `default` 모드 + VIDE 도구는 `--allowedTools`로 미리 허용해야 한다. 허용 목록에 없는 도구가 권한을 물으면 VIDE가 거절한다(아래 어댑터).
- `AskUserQuestion`을 `--allowedTools`에 넣으면 안 된다. 권한 경로를 건너뛰어 답을 넣을 기회가 없다.
- 권한 경로를 주지 않으면(b1·b2) CLI가 도구를 목록에서 빼 버린다.
- 사용자가 답하는 동안 CLI 쪽 제한 시간은 보이지 않았다(150초까지 확인).

## 판단

**(b) stream-json 제어 프로토콜 `--permission-prompt-tool stdio`를 권장한다.**

- VIDE가 이미 CLI 프로세스의 stdin/stdout을 쥐고 있으므로 추가 연결이 없다. (a)는 MCP HTTP 요청 하나를 사용자가 답할 때까지 열어 두어야 하고, 대화 도구가 없는 실행(`--mcp-config {}`)에서는 쓸 수 없으며, 도구 호출 수·만료(`AgentTools` 120초 TTL, 호출 20회)와 얽힌다.
- 답은 같은 실행 안에서 이어지므로 "질문 → 새 턴 재개"가 필요 없다. 현 구조화 출력 카드(c)는 턴을 끝내고 다음 턴에 답을 넣는다.
- 질문 카드 화면은 그대로 쓴다. AskUserQuestion 입력(질문 1~4개, 선택지 2~4개, 설명, multiSelect)을 카드 모양(`id/title/options{id,label,hint}/allowFree`)으로 바꾼다. 카드 한도(3개) 밖이면 CLI에 거절 사유를 돌려준다.
- (c) 구조화 출력 카드는 Codex와 플래그가 꺼진 Claude 실행의 기본 경로로 남긴다.

## 구현(플래그 뒤, 최소)

- `src/ai/claude-cli.ts`: `CliOptions.nativeQuestions?: (cards, signal) => Promise<answers | null>`. 주어졌고 Claude 형식일 때만 켜진다.
  - 인자 `nativeQuestionArguments`: `--tools`에 `AskUserQuestion` 추가, `dontAsk`→`default`, `--permission-prompt-tool stdio`, `--input-format stream-json`.
  - 입력은 stream-json user 메시지 한 줄, stdin은 `result` 이벤트까지 연다.
  - `control_request can_use_tool`: `AskUserQuestion`이면 카드로 바꿔 핸들러 호출, 답을 `updatedInput.answers[질문 문장] = 선택 라벨(+ 자유 답)`로 돌려준다. 핸들러가 `null`이면 deny(닫음). 다른 도구는 deny. 다른 subtype은 `error: unsupported`.
  - 질문 동안 실행 제한 타이머를 멈추고 답 뒤 다시 건다. 실행이 멈추면 핸들러의 `signal`이 abort된다. 진행 이벤트 `phase: 'question'`.
  - 플래그가 없으면 인자·입력이 그대로이고 제어 요청은 `INVALID_PROVIDER_OUTPUT`으로 멈춘다.
- `src/server/agent-tools.ts`: 바꾸지 않음. (b)에는 MCP `ask` 도구가 필요 없다.
- 시험: `tests/ai/native-questions.test.mjs`(모의 이벤트 6건).

## 남은 일·한계

- 서버 연결 미구현: 대화 턴(`src/server/conversations.ts` 등)에서 `nativeQuestions` 핸들러를 넘기고, 카드를 기존 질문 카드 UI로 보여 주고, 답을 핸들러로 돌려주는 경로. 카드는 턴 중간에 뜨므로 "턴 끝 카드"와 다르게 대기 상태를 보여야 한다.
- 대화 도구가 있는 실행(`--restricted` + VIDE MCP + `--allowedTools`)과 세션 실행(`--session-id`/`--resume` + stream-json 입력)은 실제 CLI로 확인하지 않았다(모의 시험만).
- multiSelect 질문은 카드가 한 개 선택이라 라벨 하나만 돌려준다.
- 모드 `default`는 허용 목록 밖 도구의 권한 질문을 VIDE로 보낸다. 지금 어댑터는 모두 거절한다. 계획/자동 모드 가드(사용자 결정 ②)의 확인 카드와 합칠지는 별도 결정.
- `--permission-prompt-tool`은 help에 없는 인자다. CLI 범위를 넓힐 때 이 기록의 b3·s1을 다시 확인한다.
