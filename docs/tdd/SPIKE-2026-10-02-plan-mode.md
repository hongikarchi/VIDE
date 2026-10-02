---
id: SPIKE-2026-10-02-plan-mode
title: Claude·Codex CLI의 계획(plan) 모드를 VIDE 계획 모드에 쓸 수 있는가
status: review
version: 0.1
updated: 2026-10-02
owner: agent:claude
related: [ADR-022, RESEARCH-11]
---

# Claude·Codex CLI의 계획(plan) 모드를 VIDE 계획 모드에 쓸 수 있는가

## 1. 질문

사용자 질문: "`--permission-mode plan`은 써야하는거 아니야?" → "plan 모드는 확인해보자. claude, codex 둘 다".

현재 VIDE의 계획 모드([ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md) 2)는 CLI의 모드를 쓰지 않는다. 서버가 쓰기 도구(`execute`, `jig_set` 등)를 도구 목록에서 빼고(`src/server/agent-tools.ts`의 `PLAN_MODE_TOOLS`) 지시문에 `PLAN_RULES`를 붙인다(`src/server/direct-mode.ts`). Claude는 `--tools ""` + VIDE MCP(`mcp__vide__*`)만 + `--permission-mode dontAsk`(질문 카드 경로는 `default` + `--permission-prompt-tool stdio`), Codex는 `app-server`(또는 `exec`) + 읽기 전용 sandbox + approval `never`로 돈다.

확인할 것:

1. Claude `--permission-mode plan`에서 MCP 도구는 호출되는가, 막히는가, 질문(prompt)으로 가는가. 모델 행동이 바뀌는가(ExitPlanMode가 생기는가). `--allowedTools`·`--permission-prompt-tool`과 어떻게 겹치는가. 곧 켤 Task·TodoWrite·WebSearch·WebFetch는 계획 모드에서 쓸 수 있는가.
2. Codex `exec`/`app-server`에 계획·협업 모드가 있는가. 무엇을 제한하며 MCP 도구에도 적용되는가.

## 2. 방법

- 실제 CLI를 사용자 기본 로그인으로 짧은 프롬프트만 써서 실행했다. 작업 폴더는 매 실행마다 새 임시 폴더(`%TEMP%\vide-plan-spike-*`)다. Rhino·ZWCAD·설치된 VIDE는 건드리지 않았다.
- 보조 코드: [`tools/spikes/2026-10-02-plan-mode/`](../../tools/spikes/2026-10-02-plan-mode/)
  - `dummy-mcp.mjs`: SDK 없는 stdio MCP 서버. `read_note`(readOnlyHint true), `write_note`(readOnlyHint false·destructive), `ping`(설명은 무해, readOnlyHint **false**), `ping_ro`(같은 설명, readOnlyHint **true**), `approve`(권한 질문 도구, 항상 허용). 모든 호출을 `SPIKE_LOG`에 남겨 모델의 주장과 무관하게 실제 호출을 센다.
  - `claude-plan.mjs`: VIDE와 같은 격리 인자(`-p --restricted --tools … --strict-mcp-config --mcp-config … --setting-sources "" --no-session-persistence --permission-mode …`)로 변형별 실행. init 이벤트의 도구 목록·모드, tool_use/결과 오류, `permission_denials`, 서버 호출 기록을 출력한다. 프롬프트는 stdin으로 넣는다(`--allowedTools`가 가변 인자라 뒤의 프롬프트를 삼킨다).
  - `codex-plan.mjs`: `codex app-server --listen stdio://`를 VIDE와 같은 격리(읽기 전용 sandbox, approval never, shell 끔, 사용자 MCP 서버는 thread config로 끔, code mode 켬)로 띄우고 `turn/start`에 `collaborationMode: {mode: "plan"|"default"}`를 넣어 비교한다.
- 모델이 설명을 보고 스스로 쓰기를 피하는 것과 CLI가 막는 것을 구분하려고, 설명이 같고 `readOnlyHint`만 다른 `ping`/`ping_ro`를 썼다.
- Codex 계획 모드의 내장 지시문·제한은 `codex app-server generate-json-schema --experimental`과 설치된 `codex.exe`의 문자열에서 확인했다.

## 3. 환경

| 항목 | 값 |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| Claude Code CLI | 2.1.287 (`C:\Users\user\.local\bin\claude.exe`), 사용자 기본 모델 |
| Codex CLI | codex-cli 0.157.1 (npm 전역), 모델 `gpt-6-astra` |
| Node | 24.15.0 |

## 4. 결과

### 4.1 Claude `--permission-mode plan`

| 변형 | 설정 | 결과 |
|---|---|---|
| `pingDontAsk` | dontAsk, 허용 목록 없음 | `ping`·`ping_ro` 모두 거부("denied because … don't ask mode"). 허용 목록에 없으면 읽기 도구도 막힘 |
| `pingPlan` | plan, 허용 목록 없음 | `ping`(readOnlyHint false) → 오류 `Cannot call mcp__spike__ping while in plan mode.`, `permission_denials`에 기록. `ping_ro`(readOnlyHint true) → **허용 목록 없이** 실행 |
| `pingPlanAllowed` | plan, 둘 다 `--allowedTools` | 결과 같음. **허용 목록이 계획 모드 차단을 풀지 못한다** |
| `pingPlanPromptTool` | plan + `--permission-prompt-tool mcp__spike__approve` | `ping`이 질문 도구로 넘어갔고 허용 답을 받자 **실행됨**(서버 기록: approve → ping → ping_ro) |
| `forcePlan*` | write_note를 "반드시 시도"하라는 프롬프트 | 모든 변형에서 모델이 스스로 `write_note`를 부르지 않음("plan mode blocks changes"). 차단 여부는 모델의 절제로 가려져 위 `ping` 시험으로 판정 |
| `taskPlan` | plan + Task | 서브에이전트(스트림 이름 `Agent`)도 같은 계획 모드: `ping` 거부, `ping_ro` 실행 |
| `planBuiltinsUse` | plan + `--tools TodoWrite,WebSearch,WebFetch,Task` | WebSearch·WebFetch 정상 실행. TodoWrite는 init 도구 목록에 없음 |
| `todoDontAsk` | dontAsk + `--tools TodoWrite` | 역시 TodoWrite 없음. 2.1.287의 `-p`에는 TodoWrite가 노출되지 않는다(모드와 무관) |
| `planDefaultTools` | plan + `--tools default` | 모델이 `Write`로 계획 파일을 **`C:\Users\user\.claude\plans\*.md`**(작업 폴더 밖, 사용자 홈)에 썼다. 계획 모드는 이 계획 파일 쓰기를 허용한다 |
| `planExitTool` | plan + `--tools ExitPlanMode` + 허용 | ExitPlanMode는 init 도구 목록에 나타나지 않았다(`--tools default`에서도 없음). `-p` 실행에서는 계획 종료 도구가 없다 |

정리:

- **차단 기준은 MCP의 `readOnlyHint` 주석이다.** 주석이 true인 도구는 허용 목록 없이도 실행되고, false·없음인 도구는 허용 목록과 무관하게 "Cannot call … while in plan mode."로 거부된다(질문으로 가지 않음).
- **예외는 권한 질문 도구다.** `--permission-prompt-tool`이 있으면 읽기 전용이 아닌 도구가 그 도구로 넘어가고, 허용하면 실행된다. VIDE의 질문 카드 경로는 `--permission-prompt-tool stdio`를 쓰므로 이 경로에서는 계획 모드가 강제 차단이 아니라 VIDE 처리기에 묻는 형태가 된다.
- **dontAsk와 동시에 쓸 수 없다.** 모드는 하나다. 계획 모드로 바꾸면 "허용 목록에 없는 것은 모두 거부"라는 dontAsk 보장이 사라지고, 읽기 전용 주석이 붙은 도구는 허용 목록 밖이어도 실행된다.
- **모델 행동이 바뀐다.** 계획 모드 안내가 시스템 지시에 들어가 모델이 쓰기 요청을 스스로 거절하고 "plan mode를 끄면 하겠다"고 답한다. 쓰기 도구가 있으면 계획 파일을 `~/.claude/plans/`에 쓴다. ExitPlanMode는 `-p`에서 나타나지 않는다.
- WebSearch·WebFetch·Task는 계획 모드에서도 쓸 수 있고, Task의 서브에이전트도 같은 제한을 받는다.

### 4.2 Codex 협업 모드(collaboration mode)

- `codex exec`에는 계획 모드 옵션이 없다(`--help`에 없음, 관련 설정 키 없음). `features list`의 `collaboration_modes`는 `removed true`로, 기능 플래그 없이 항상 켜져 있다.
- `app-server`에는 실험 API로 있다. `collaborationMode/list`가 `plan`, `default` 두 프리셋을 돌려주고, `turn/start`의 `collaborationMode: {mode, settings: {model, developer_instructions, reasoning_effort}}`로 고른다(실험 필드라 `initialize`에 `experimentalApi: true` 필요. VIDE는 이미 켜 둠). `developer_instructions: null`이면 내장 지시문을 쓴다. 계획 결과는 `<proposed_plan>` 블록과 `item/plan/delta`·`PlanThreadItem` 알림으로 나온다.
- 내장 계획 지시문(`# Plan Mode (Conversational)`)은 "비변경 행동만, 파일 편집·쓰기·패치·실행 금지, 질문으로 의도를 좁힌 뒤 결정이 끝난 계획 제시"를 요구한다. 바이너리에서 확인한 실제 강제 제한은 `update_plan` 도구 거부("not allowed in Plan mode") 하나뿐이다.
- 실측(`codex-plan.mjs`):

| 변형 | 결과 |
|---|---|
| `default` | `ping`·`ping_ro`·`write_note` 모두 실행 |
| `plan` | `ping`(readOnlyHint false)·`ping_ro` 실행, `write_note`는 모델이 "Plan Mode prohibits modifying"이라며 부르지 않음 |
| `planForce` | 결과 같음 |

  readOnlyHint false인 `ping`이 계획 모드에서 그대로 실행됐으므로 **Codex 계획 모드는 MCP 도구를 하네스에서 막지 않는다.** 제한은 지시문 수준(모델의 판단)이고, 실제 경계는 기존대로 sandbox·approval·VIDE의 도구 목록이다. approval 요청(server→client request)도 발생하지 않았다.

## 5. 한계

- Claude의 `write_note` 강제 시험은 모델이 끝까지 거절해 직접 관찰하지 못했다. 차단 판정은 설명이 같은 `ping`/`ping_ro` 비교로 대신했다.
- Claude 계획 모드에서 허용 목록에 없는 WebSearch·WebFetch가 실행되는지는 시험하지 않았다(허용 목록에 넣은 경우만 확인).
- `--restricted`를 썼다(VIDE의 MCP 연결 경로와 같다). `--safe-mode`는 `--mcp-config`의 서버도 끄므로 첫 실행은 MCP 없이 돌았다.
- VIDE의 실제 MCP 서버(`mcp__vide__*`)와 실제 Rhino 문서로는 시험하지 않았다. VIDE 도구에는 현재 `readOnlyHint` 주석이 없다(`src/server`에 annotations 없음).
- Codex `exec` 경로에서의 동작은 옵션이 없어 시험하지 않았다. 모델 1회 실행씩이라 확률적 행동의 분포는 모른다.
- CLI 버전이 바뀌면(특히 Claude의 ExitPlanMode·TodoWrite 노출, Codex 실험 API) 결과가 달라질 수 있다.

## 6. VIDE 권고

1. **계획 모드의 보장은 지금처럼 VIDE가 소유한다.** 쓰기 도구를 도구 목록에서 빼는 방식(`PLAN_MODE_TOOLS`)이 두 공급자 모두에서 확정적인 경계다. CLI 계획 모드로 대체하지 않는다.
2. **Claude: `--permission-mode plan`을 지금 켜지 않는다.** 이유: (a) VIDE MCP 도구에 `readOnlyHint`가 없어 켜는 즉시 `query`·`capture_view` 등 읽기 도구까지 거부된다, (b) dontAsk의 "허용 목록 밖 거부" 보장이 사라진다, (c) 질문 카드 경로(`--permission-prompt-tool stdio`)에서는 차단이 질문으로 바뀐다, (d) 쓰기 도구가 노출되면 `~/.claude/plans/`에 계획 파일을 쓴다, (e) ExitPlanMode가 없어 [진행] 전환은 어차피 VIDE가 한다.
   - 이중 방어로 쓰고 싶으면 조건: VIDE MCP 서버가 `PLAN_MODE_TOOLS`에 `readOnlyHint: true`, 나머지에 `false`를 붙이고, 계획 모드 실행에서 파일 쓰기 도구(`Write`·`Edit`)를 계속 빼며, 질문 카드 처리기가 `AskUserQuestion` 외의 권한 질문은 거부하는지 시험으로 고정한다. 이 경우에도 dontAsk 보장이 빠지므로 `--strict-mcp-config` + VIDE 서버만 유지한다.
   - Task·WebSearch·WebFetch는 계획 모드에서도 쓸 수 있다(서브에이전트도 같은 제한). TodoWrite는 2.1.287 `-p`에 없으므로 T-105에서 다른 이름(작업 목록 도구)을 확인한다.
3. **Codex: 계획 대화에 한해 `collaborationMode: plan`을 선택 사항으로 검토할 수 있다.** 하네스 제한이 없어 안전 경계로는 쓸모가 없고, 얻는 것은 내장 계획 지시문(탐색→질문→`<proposed_plan>`)과 계획 알림이다. VIDE는 이미 `PLAN_RULES`의 JSON 계획 블록을 파싱하므로, 쓰려면 `developer_instructions`를 VIDE 계획 규칙으로 덮어 형식 충돌을 피해야 한다. 실험 API이므로 붙일 때 버전 확인과 시험을 함께 둔다. `exec` 경로에는 해당 기능이 없다.
4. **바꿀 것(작게):** 당장 코드 변경은 필요 없다. 후속으로 (a) VIDE MCP 도구 정의에 `readOnlyHint` 주석 추가(공급자 판단 보조, 계획 모드 이중 방어의 전제), (b) RESEARCH-11 공급자 대응표에 "CLI 계획 모드 = Claude는 주석 기반 하네스 차단, Codex는 지시문만" 한 줄 반영을 제안한다.
