---
id: RESEARCH-18
title: 환경으로서의 VIDE — 같은 모델, 건축에 맞춘 작업 환경 (Claude Code·Cursor·Kiro 대조와 현행 인벤토리)
status: draft
version: 0.1
updated: 2026-10-19
owner: user
related: [OQ-15, FR-08, FR-13, FR-18, FR-24, FR-25, ADR-011, ADR-021, ADR-022, ADR-028, ADR-031, ADR-037, SPEC-01, SPEC-02, SPEC-05, SPEC-07, SPEC-08, ARCH-01, ARCH-03, RESEARCH-10, RESEARCH-11, RESEARCH-14, PLAN-24, PLAN-28, PLAN-51]
---

# RESEARCH-18 — 환경으로서의 VIDE

2026-10-19 사용자 관찰에서 출발한다. "Claude Code·Cursor·Kiro는 같은 모델을 쓰는데 그 모델이 일하는 환경(지침, 작업 방식, UI, 사용자 워크플로에 대한 개입)이 다르다. VIDE도 Claude·GPT 모델은 그대로 쓰고, 그 모델이 활동하는 환경을 건축에 최적화하는 것에 가깝다(스케치로 명령 그리기, Rhino/CAD에서 직접 객체를 골라 문맥 명령 내리기, 프로젝트 폴더와 DB 관리, 건축 전용 extension). 이 관점으로 보니 정리가 안 된 것과 부족한 지점이 보인다. 방향을 정리하고 PRD·SPEC을 고치자."

이 문서는 그 관점으로 세 도구가 모델 위에 무엇을 더하는지 조사하고(§2), 지금 VIDE 코드가 같은 축에서 무엇을 가졌는지 세고(§3), 어느 문서가 각 요소를 소유하는지 지도를 그린 다음(§4), 빈 곳과 결함(§5·§6)과 결정이 필요한 항목(§8)을 낸다. 제품 결정의 원본은 [PRD](../PRD.md)와 ADR이고, 이 문서는 조사와 분석이다. 조사 사실은 [사실], 해석은 [분석], 제안은 [제안]으로 표시한다.

## 0. 요약

- **이 관점은 문서에 이미 절반 들어와 있다.** [ADR-031](../decisions/ADR-031-stock-first.md) 순정 우선("AI 경로는 순정 그대로, VIDE는 터미널에 없는 것만 더한다"), [RESEARCH-11](RESEARCH-11-ai-parity.md) §0("원인은 모델이 아니라 AI를 둘러싼 조건의 차이"), [ADR-028](../decisions/ADR-028-ai-cli-parity.md)이 같은 말을 한다. 빠진 것은 PRD의 정체성 문장이다. PRD에는 '순정'·'Claude Code'·'Codex'라는 말이 없고 §0·§1.1은 "여러 프로그램과 자료를 엮어 AI로 제어하는 통합 관리 환경"까지만 말한다(§7).
- **세 도구가 모델 위에 더하는 것은 여덟 축으로 같다.** 지침·문맥·도구/권한·모드·개입·화면·확장·모델 교체(§2.2). VIDE는 여덟 축 모두에 무언가를 가지고 있으나(§3), 소유 문서가 없는 요소가 일곱 가지(§4.2)이고 문서끼리 충돌하는 곳이 다섯 군데(§4.3)다.
- **VIDE만의 축이 하나 더 있다.** 세 도구의 '파일'은 모델이 원래 읽는 텍스트인데, VIDE의 파일은 Rhino·CAD 문서라 모델이 직접 읽지 못한다. 호스트 다리(플러그인·Sync·`execute`·핀·스케치)는 순정으로 걷어낼 수 없는 VIDE 고유 층이다. 이것을 PRD에 적어 두지 않으면 "CLI 포장지면 된다"로 과교정될 수 있다(§5.2).
- **지금 환경에서 가장 먼저 고칠 결함은 지침 묶음 자체다.** 매 턴 붙는 `common.md`에 깨진 줄 하나와, 바로 적용([ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md)) 뒤에도 "AI 편집은 사본에서 하고 원본은 반영할 때만 바뀐다"고 말하는 낡은 문장이 남아 있다(§6.1). 사용자는 이 묶음을 볼 수 없다.
- **결정이 필요한 항목은 다섯이다**(§8). D1 사용자 자신의 CLI 설정에 대한 격리 정책, D2 진행 방식 모드(Kiro의 Vibe/Spec에 해당), D3 지침의 가시성·편집, D4 모델·판이 바뀔 때의 재검증 정책, D5 PRD 정체성 문장과 OQ-15. 앞서 열어 둔 Q1(전문 문장 라우팅)·Q2(외부 MCP)는 D2·D1에 흡수된다.

## 1. 출발점 — 관찰과 질문 [사실]

사용자가 든 예는 Kiro의 첫 화면이다. "Let's build — Vibe: Chat first, then build. / Spec: Plan first, then build. Create requirements and design before coding starts." 같은 모델 앞에 진행 방식을 먼저 고르게 하는 화면이다. 질문은 셋으로 나뉜다.

1. 세 도구는 모델 위에 정확히 무엇을 더하는가.
2. VIDE는 그 축에서 지금 무엇을 가지고 있고, 무엇이 정리되지 않았는가.
3. 이 관점을 PRD·SPEC에 어떻게 반영하고, 어떤 결정이 필요한가.

## 2. 세 도구가 모델 위에 더하는 것 [사실]

공식 문서만 근거로 했다(2026-10-19 접속, 출처는 §2.3). 요약을 거쳐 읽은 문장이 대부분이고, 확인하지 못한 항목은 [미확인]으로 남겼다.

### 2.1 여덟 축 비교

| 축 | Claude Code | Cursor | Kiro |
|---|---|---|---|
| 지침·규칙 | `CLAUDE.md` 네 범위(조직 managed · 사용자 `~/.claude` · 프로젝트 `./CLAUDE.md` · 개인 `CLAUDE.local.md`). 덮어쓰지 않고 이어 붙임. `@path` import 4단계. `.claude/rules/*.md`는 `paths:`로 범위 한정. `CLAUDE.md`가 없을 때만 `AGENTS.md`. 문서는 "강제되는 설정이 아니라 문맥"이라고 명시 [1] | Project Rules(`.cursor/rules`, `.mdc`) · User Rules · Team Rules(대시보드, Enforce 가능) · `AGENTS.md`(중첩). 적용 방식 Always / Apply Intelligently(description) / Specific Files(globs) / Manual(@). 우선순위 Team → Project → User. Agent에만 적용되고 Tab에는 아님 [13] | Steering `.kiro/steering/`(작업공간) · `~/.kiro/steering/`(전역). 기본 파일 `product.md`·`tech.md`·`structure.md`. inclusion은 always / fileMatch / manual(`#이름`) / auto. `#[[file:경로]]`로 실제 파일 참조. `AGENTS.md`는 항상 포함 [30] |
| 문맥 구성 | 시작 때 `CLAUDE.md`·auto memory(MEMORY.md 앞 200줄 또는 25 KB)·git 상태. 코드는 Read/Grep으로 그때그때. 하위 폴더 `CLAUDE.md`는 그 폴더를 다룰 때. 차면 오래된 도구 출력부터 지우고 요약. `/compact`·`/context`. MCP 도구 정의는 필요할 때만 로드 [10] | 임베딩 색인 없음(Instant Grep, "임베딩을 저장하지 않는다") [14]. @Files/Folders · @Terminals · @Chats · @Commit/@Branch · @Browser. 차면 앞부분 요약 [15] | `#codebase #file #folder #git diff #terminal #problems #url #steering #docs #spec #mcp`. 열린 파일 자동 분석. 차면 요약 [34]. Memory: 명령·관례·교정·배제한 접근을 세션 넘어 재사용 [43] |
| 도구·권한 | 내장 파일·검색·실행·웹·코드 인텔리전스 [10]. 권한 모드 `default`·`acceptEdits`·`plan`·`auto`(분류기)·`dontAsk`·`bypassPermissions`. 규칙은 deny → ask → allow, 모델이 아니라 Claude Code가 강제 [2][3]. MCP 범위 local / project(`.mcp.json`, 첫 사용 승인) / user [8]. PreToolUse 훅이 호출 차단 [4] | 내장 검색·읽기·편집·셸·웹·Browser·이미지 생성 [16]. Run Mode Auto-review(분류기+샌드박스) / Allowlist(`permissions.json`) / Run Everything. 브라우저·파일 삭제·작업공간 밖 쓰기는 항상 승인 [18]. MCP `.cursor/mcp.json`·`~/.cursor/mcp.json`, 사용 전 승인 [19] | capability(`fs_read`·`fs_write`·`shell`·`web_fetch`·`mcp`)마다 deny > ask > allow, `~/.kiro/settings/permissions.yaml`. 복제한 저장소가 권한을 주입할 수 없음. 신뢰하지 않은 작업공간에서는 steering·skills를 로드하지 않음 [37]. MCP `autoApprove`·`disabledTools` [39]. OS 샌드박스 기본 꺼짐 [38] |
| 작업 모드 | plan 모드: 탐색·계획만, 편집 없음. 승인 때 "auto로 진행 / 편집마다 수동 승인 / 계속 계획" [3]. `opusplan`(계획 Opus, 실행 Sonnet) [11] | Agent · Ask(읽기 전용) · Plan(질문 → 조사 → 편집 가능한 계획 → Build, 계획은 저장·공유 가능) · Debug(가설 → 로그·런타임으로 확인) [17]. Cloud Agent [23] | 세션 = Vibe(자유 대화) / Spec(Spec · Quick Spec · Bug Fix · Plan) [34]. Spec은 `requirements.md`(EARS "WHEN… THE SYSTEM SHALL…") → `design.md` → `tasks.md`, 단계마다 승인, 작업은 하나씩 또는 전체·wave 병렬 [31][32]. Plan 모드는 읽기 전용, 결과가 대화 안에 [33] |
| 개입 | 프롬프트마다 체크포인트, `/rewind`·Esc 두 번으로 코드·대화 되돌리기(Bash 변경은 추적 안 함) [9]. Esc 중단, 작업 중 입력은 큐 [10]. 승인 프롬프트에 코멘트 [2]. 훅 30여 종 [4] | 체크포인트는 Agent가 바꾼 파일만 [21]. 큐잉·"Send now" 조향(다음 도구 호출 시점) [16]. diff 파일·hunk 단위 수락/거부, `/agent-review` [22]. hooks.json(preToolUse, beforeShellExecution, afterFileEdit…, exit 2 차단) [20] | Supervised: hunk 단위 수락/거부. Autopilot: 전체 diff 보고 되돌림 [35]. Checkpoint(코드+문맥) vs Revert(마지막 턴 파일만); bash·MCP 변경은 추적 안 함 [40]. 훅: Prompt Submit, Pre/Post Tool Use(차단), File Create/Save/Delete, Pre/Post Task; 동작은 셸 또는 에이전트 프롬프트 [36]. CLI Steer/Queue 모드 [44] |
| 화면 | 터미널 기본. 데스크톱·IDE 확장·웹·Slack·CI, 루프는 동일 [10]. VS Code 확장은 나란히 diff·변경 단위 Accept/Reject·계획 검토 [12]. 상태줄에 모드 [3] | 편집기 내장. Tab(여러 줄·다음 편집 위치·파일 간) [24a], Cmd+K 인라인 편집, Cmd+L Agent 패널 [24b]. CLI·웹·iOS·Slack [23] | Code OSS 기반 IDE [34]. IDE·CLI·Web. 작업 상태는 `tasks.md`에 실시간 [31] |
| 확장 | Skills(`SKILL.md`): 평소 description만, 호출 때 본문 로드, `/name` 또는 자동, `context: fork` [5]. 서브에이전트 `.claude/agents`(별도 문맥, tools·model·permissionMode) [6]. 플러그인 = skills·agents·hooks·MCP 묶음, marketplace [7]. 문서 표: `CLAUDE.md`는 "정적 지식", Skill은 "재사용 절차" [5] | Skills `.cursor/skills`·`.agents/skills`(+ `.claude/skills`·`.codex/skills` 호환) [25]. rules는 "고정 조건", skills는 "점진 로딩" [25]. 서브에이전트 `.cursor/agents`·`.claude/agents`, 내장 Explore·Browser [26]. 플러그인(수동 검토 Marketplace) [27] | Skills(`SKILL.md`, Agent Skills 표준, `.kiro/skills`, 점진 공개) [42]. Powers = plugin.json + skills + mcp.json, 키워드에 맞을 때만 활성 [41]. Steering = Kiro 전용 지침, Skill = 이식 가능한 절차, Power = 도구+지식 묶음 [41][42] |
| 모델 교체 | `/model`로 Claude 모델 사이 전환, Bedrock·Vertex·Foundry·LLM gateway. "다른 회사의 모델은 동작하지 않는다" [11]. PreModelSwitch 훅 [4] | Anthropic·OpenAI·Google·Grok·Composer·GLM·Kimi 등, Auto 라우터 [28] | Claude·GPT·DeepSeek·Qwen·GLM·MiniMax·Kimi, Auto [45] |

**이식성.** Claude Code는 `CLAUDE.md`가 없을 때만 `AGENTS.md`를 읽고 [1], Cursor는 `.claude/skills`·`.claude/agents`를 읽으며 [25][26], Kiro의 skills·powers는 공개 표준을 따른다 [41][42]. 반대로 지침 파일 이름·inclusion 문법·훅 형식·권한 파일은 제품마다 다르다.

### 2.2 모델 위에 더하는 것의 공통 분류 [사실에서 도출]

| 축 | 정의 |
|---|---|
| 지침 | 매 요청에 붙는, 사람이 쓴 지속 지침 파일. 범위(조직·사용자·프로젝트·경로)와 적용 조건(항상·경로 일치·관련성·수동)으로 나뉜다 |
| 문맥 | 이번 요청에 무엇을 보일지 정하는 층. 자동 포함(열린 파일·git·메모리), 사용자 지정(@/#), 도구 검색, 차면 요약 |
| 도구/권한 | 모델이 부를 수 있는 행동(파일·셸·웹·MCP)과, 이를 모델 밖에서 강제하는 allow/ask/deny·모드·샌드박스 |
| 모드 | 같은 모델에 읽기 전용·계획·실행·디버그 같은 행동 범위와 순서를 지정하는 상태. 계획을 승인하면 실행으로 |
| 개입 | 사람이 결과를 고르거나 되돌리는 장치(hunk 승인·체크포인트·중단·조향·큐)와 이벤트 훅 |
| 화면 | 터미널·IDE 패널·인라인 편집·클라우드 같은 표면과 diff·진행 표시 |
| 확장 | 필요할 때만 불러오는 절차 지식(skills), 별도 문맥의 하위 에이전트, 이를 묶어 배포하는 플러그인/powers |
| 모델 교체 | 모델·공급자 선택과 자동 라우팅, 그에 대한 관리자 제한 |

세 제품 모두 **지침(항상 붙는 정적 지식)과 스킬(필요할 때 불러오는 절차)과 도구(행동)를 서로 다른 것으로 구분**한다 [5][25][41][42]. 또 셋 다 **권한을 모델 밖에서 강제**하고(deny > ask > allow) [2][18][37], **계획 모드는 "읽기 전용 + 승인 뒤 실행"**이라는 같은 꼴이다 [3][17][33].

### 2.3 출처

1 https://code.claude.com/docs/en/memory · 2 /permissions · 3 /permission-modes · 4 /hooks · 5 /skills · 6 /sub-agents · 7 /plugins · 8 /mcp · 9 /checkpointing · 10 /how-claude-code-works · 11 /model-config · 12 /vs-code (모두 `https://code.claude.com/docs/en/` 아래)
13 https://cursor.com/docs/rules · 14 /docs/agent/tools/search · 15 /docs/context/mentions · 16 /docs/agent/overview · 17 /docs/agent/modes · 18 /docs/agent/security/run-modes · 19 /docs/mcp · 20 /docs/hooks · 21 /docs/agent/chat/checkpoints · 22 /docs/agent/agent-review · 23 /docs/cloud-agent · 24a /help/ai-features/tab · 24b /help/ai-features/inline-edit · 25 /docs/skills · 26 /docs/subagents · 27 /docs/plugins · 28 /docs/models-and-pricing (모두 `https://cursor.com` 아래)
30 https://kiro.dev/docs/steering/ · 31 /docs/specs/ · 32 /docs/specs/feature-specs/requirements-first · 33 /docs/specs/plan · 34 /docs/ide/chat/ · 35 /docs/ide/chat/autopilot · 36 /docs/hooks/ · 37 /docs/permissions · 38 /docs/sandbox · 39 /docs/mcp/configuration · 40 /docs/checkpoints · 41 /docs/powers · 42 /docs/skills · 43 /docs/memory · 44 /docs/cli/chat/queue-steering · 45 /docs/models (모두 `https://kiro.dev` 아래)

[미확인]: Cursor Manual/Edit 모드·@Docs·Memories·BYOK 세부, Kiro trusted commands·BYOK·훅 동작 유형 전체·메모리 저장 위치, Claude Code `.claude/commands`의 현재 지위. "모델이나 CLI를 바꾸면 무엇이 깨지는가"를 직접 다룬 공식 문서는 셋 다 없다.

## 3. VIDE의 환경 — 코드 인벤토리 [사실, `main` c3368b22]

같은 여덟 축으로 지금 코드가 하는 일을 센다. '보이나/고치나'는 사용자가 화면에서 볼 수 있는지, 고칠 수 있는지다.

### 3.1 지침

| 항목 | 무엇을 하나 | 위치 | 보이나/고치나 |
|---|---|---|---|
| 묶음 파일 | `common`(2,047자) `modeling`(3,477) `modeling-rhino`(7,726) `modeling-cad`(4,546) `grasshopper`(1,422) `data`(625) `data-skill`(1,169) `make`(2,160). 한 번 읽어 캐시 | `src/ai/instructions/*.md`, `index.ts:42-54` | 볼 화면 없음 |
| 모드별 구성 | 모드 modeling·data·make·review(review는 data 규칙). `common` + 모드 파일 + `<모드>-*` 조각. 호스트 조각은 rhino·cad만 걸러져서 `data-skill`은 data/review에 늘 들어가고, Rhino 모델링 턴(호스트 미지정 포함)에는 `grasshopper`도 붙음. Rhino 모델링 ≈14.7k자, ZWCAD ≈10.1k, 호스트 미지정 ≈19.2k, data ≈3.8k, make ≈4.2k | `index.ts:11-39, 99-120` | 아니오 |
| 모드 선택 | 호스트 턴 modeling, jig-make 대화 make, jig 리뷰 review, 나머지 data | `src/server/execution.ts:1718-1725`, `agent-connection.ts:386-392` | 아니오 |
| 상한 | 묶음 20,000자(Windows 명령줄). 넘으면 프로젝트 지침부터 자름. 프로젝트 지침 8 KB, 제어·bidi 문자 제거, `<project-notes>` 표식 무력화, "자료" 블록으로 삽입 | `index.ts:16-21, 78-127` | — |
| 전달 | Claude `--append-system-prompt`, Codex `developer_instructions`. 기본 프롬프트는 유지하고 덧붙임. 뒤에 `## 이번 실행의 규칙`. 세션 턴은 중립 문구 + 패킷 `turn-rules` | `index.ts:151-153`, `claude-cli.ts:392-432`, `agent-connection.ts:410-438`, `codex-cli.ts:45-60` | 아니오 |
| 도구 규칙 문장 | 연결된 도구에 따라 `agentInstruction`·`conversationToolInstruction`·make·할 일·법규·폴더 역할 문장 선택 | `agent-connection.ts:307-365` | 아니오 |
| 프로젝트 AI 지침 | `<data>/ai-instructions/<id>.json`. 원본은 사이트, PC는 사본([ADR-037](../decisions/ADR-037-team-shared-project-layer.md) 2). PC에서 고치면 `pending`, 나중 수정이 이기고 진 쪽은 conflict 보관 | `project-store.ts:55-145`, `src/server/shared-project.ts:24-35, 277-351` | 설정 → AI textarea(`ai-settings.tsx:235-376`). 원격 세션은 쓰기 거부 |
| jig `skill.md` | front matter(name·description·examples·invocation·intent_en·words·not_for)만 카탈로그·라우팅에 사용. 64 KB 초과는 읽지 않음 | `src/server/skill-catalog.ts:30-132` | 만들기 탭 읽기 전용 |

### 3.2 문맥

| 항목 | 무엇을 하나 | 위치 | 보이나/고치나 |
|---|---|---|---|
| 패킷 | `{goal, revision, items[]}` JSON을 stdin으로. goal 20,000자 초과 `INVALID_CONTEXT`, 패킷 256 KB 초과 `CONTEXT_TOO_LARGE`로 실패(잘라 보내지 않음) | `claude-cli.ts:284-345, 867-886` | 아니오 |
| goal(호스트 턴) | 대상, Auto/Plan 규칙, execute 3형식, 보호 id(≤100), 연결 파일(≤30), 요청 본문을 합침 | `direct-mode.ts:721-808` | 본문만 |
| 핀·스케치 | 핀 200개까지 `object-reference` 각각, 나머지 summary(32 KB). Rhino 재시작 시 핀 이전, 못 찾으면 `PINS_NOT_FOUND`. 스케치 `sketch-i`, 개수 상한 없음 | `model-context.ts:108-148`, `pin-carry.ts`, `execution.ts:1403-1406` | 화면에서 고정·그리기 |
| 작업 모델/Sync | `working-model` 객체 ≤100·64 KB + `model-context-summary`("나머지는 query로"). 연결 파일은 MCP `links_layers`·`sync_sample`(50행) | `model-context.ts:20-105`, `agent-tools.ts:508-526` | 아니오 |
| 첨부·이미지 | 첨부는 메타·경로만, 내용은 CLI Read. 이미지 스키마 3장·1 MB, 패킷 20장·5 MB, 초과는 `omitted` | `attachments.ts`, `claude-cli.ts:313-361`, `reference-boards.ts:560-575` | 첨부·참고 카드 |
| cwd·폴더 | 첫 프로젝트 폴더 = cwd, 나머지 `--add-dir`. 없으면 임시 `vide-cli-*`. 폴더 칩 `folder-i`(≤64) | `execution.ts:506-551`, `claude-cli.ts:1155, 1196` | 대시보드 › 폴더 |
| 기록·노트·이력 | `<data>/projects/<id>`(project.sqlite·knowledge.sqlite) 읽기 전용 허용. 노트 `notes/*.md`, 구성원 이력 `history/*.md` 사본 | `project-files.ts:108-130`, `agent-connection.ts:146-151`, `shared-notes.ts`, `conversation-mirror.ts` | 노트·이력 화면 |
| 지식 도구 | `project_brief/search/issue/statement/checks`(MCP). 도구 결과 96 KB 자름 | `agent-tools.ts:695-731, 1447-1470` | 자료 탭 |
| 대화 이력 | 세션 없으면 교환 ≤6 전부, 많으면 Jev가 최근 20 중 ≤6 선택. 요청 2,000자·답 6,000자 자름. 세션 있으면 resume. 100턴·80만 토큰 넘으면 새 세션 제안 | `context-selector.ts`, `conversations.ts:66-93, 1150-1215` | 대화 길이 설정·인계 카드 |
| 원장·인계 | `ledger` 8 KB, 6턴마다 전체. `handoff`, `changes-elsewhere`(20), `unresolved-results`(5) | `conversation-store.ts`, `conversations.ts:448-468, 1640-1695` | '원장 n개' |
| 구조화 출력 | `turn-output` 스키마(질문 3·선택지 5). Claude `--json-schema`, Codex `--output-schema`, 16 KB | `turn-output.ts`, `claude-cli.ts:440-447` | 카드 |

### 3.3 도구·권한

| 항목 | 무엇을 하나 | 위치 | 보이나/고치나 |
|---|---|---|---|
| VIDE MCP | `http://127.0.0.1:<port>/mcp`, 턴마다 베어러 토큰, 도구 범위 턴마다 발급, 1시간 무호출이면 종료 | `agent-connection.ts:476-532`, `agent-tools.ts:980, 1024-1075` | 아니오 |
| 도구 48개 | 호스트 query·execute·capture_view·measure / GH 읽기 4·쓰기 5 / jig 8 / 화면 ui_go / 만들기 4 / ask_user / 프로젝트 읽기 links_layers·sync_sample·project_* 5 / 할 일·기록 4 / 폴더 역할 3 / 법규 4 | `agent-connection.ts:253-305`, `agent-tools.ts:186-760` | 아니오 |
| 공급자 기본 도구 | 하위 에이전트·할 일·웹은 대화 안 modeling·make·data 턴만. 파일 도구 Read/Glob/Grep/Edit/Write/Bash(Codex shell·apply_patch·view_image) | `execution.ts:456-485`, `agent-connection.ts:94, 166-216` | 「AI 웹 검색」 스위치 |
| `--tools ''` 대체 | 기본 `--tools ''`. 연결이 있으면 `--mcp-config`에 vide만, `--allowedTools`에 `mcp__vide__*` + 초안 파일 도구 + 기본 도구 | `agent-connection.ts:537-595` | 아니오 |
| 모드별 도구 | Plan은 `PLAN_MODE_TOOLS`(읽기·질문·화면·법규). `execute`·GH 쓰기는 Auto만 | `agent-tools.ts:985-1021`, `direct-mode.ts:1268-1315` | 입력창 토글 |
| 폴더 범위 | 작업 폴더·첨부·허용 폴더 안은 허용. 밖은 카드(읽기: 이번만/항상/거절, 쓰기·실행: 매번, 300 s). 열쇠·로그인·VIDE 데이터·브라우저 프로필·`.env`·`*.pem`·카톡/메일 원문은 항상 거절 | `execution.ts:620-660, 770-800`, `project-files.ts:50-106, 314-540` | 카드 |
| 확인 필요 동작 | bulk-delete(>500)·layer-delete·purge·save·save-as·export·publish은 호스트가 되돌려 두고 `needs-confirmation`, [진행]이면 재실행. Rhino 명령 거부 목록 | `direct-mode.ts:30-38`, `execution.ts:2342-2373`, `rhino-script-policy.ts` | 가드 카드 |
| 알림만 | 허용 밖 도구 호출은 `TOOL_REFUSED` 이벤트, 턴 계속. init 목록 불일치는 `UNEXPECTED_TOOL_ACCESS` 경고 | `claude-cli.ts:1024-1099` | 활동 로그 |

### 3.4 격리(사용자 자신의 CLI 환경 대비)

| 항목 | 무엇을 하나 | 위치 |
|---|---|---|
| Claude 단일 실행 | `-p --safe-mode --tools '' --strict-mcp-config --mcp-config {"mcpServers":{}} --setting-sources '' --no-session-persistence --no-chrome --disable-slash-commands --permission-mode dontAsk --output-format stream-json --append-system-prompt`. 사용자의 MCP·settings(user/project/local)·플러그인·스킬·`CLAUDE.md`를 모두 끈다 | `claude-cli.ts:392-414` |
| 세션 턴 | `--no-session-persistence` 제거, `--session-id`/`--resume`, `--system-prompt-snapshot off` | `claude-cli.ts:421-432` |
| 연결·작업 폴더 | 연결 있으면 `--restricted`. 작업 폴더 있으면 `--restricted`/`--safe-mode` 제거, `--permission-mode default --permission-prompt-tool stdio --add-dir` | `agent-connection.ts:449-474`, `claude-cli.ts:589-602` |
| 환경 변수 | `ANTHROPIC_*`·`CLAUDE_CODE_*`·`CLAUDE_AGENT_SDK_*`·`TYPESAFE_*` 제거(`CLAUDE_CONFIG_DIR` 유지). 로그인은 `auth status`의 claude.ai만 | `claude-cli.ts:373-385, 969-1019` |
| Codex exec | `--ignore-user-config --ignore-rules --skip-git-repo-check --sandbox read-only`, `-c` approval never·chatgpt 로그인·web 끔·`mcp_servers={}`·`project_doc_max_bytes=0`(AGENTS.md 끔), `--disable` 16개(shell_tool·plugins·hooks·multi_agent·memories·browser/computer_use·code_mode·skill_search…), `--enable skip_host_skill_discovery`. 실행 전 `codexTurnIsolated` 검사 | `codex-cli.ts:27-38, 66-151, 160-200` |
| Codex app-server | 같은 `-c` 격리, 사용자 MCP 서버를 스레드마다 `enabled=false`. 작업 폴더 있으면 `workspace-write`(네트워크 없음), approval `untrusted` | `codex-app-server.ts:68-100, 113-160, 174-245` |
| 판 검사 | `cli-compat.json` claude ≥2.1.284 <2.2.0, codex ≥0.157.0 <0.158.0(T-361에서 확대 중). 범위 밖이면 `CLI_VERSION_UNSUPPORTED` | `claude-cli.ts:203-245, 893-907` |

### 3.5 작업 방식(모드·경로 판정)

| 항목 | 무엇을 하나 | 위치 | 보이나/고치나 |
|---|---|---|---|
| Plan/Auto | 기본 auto, 프로젝트별 저장. 계획 카드 [진행]이면 같은 대화에서 Auto로. Jev `complex`면 '계획부터' 카드 | `contracts/workspace.ts:17-26`, `composer.ts:119-148`, `direct-mode.ts:312-361` | 토글·카드 |
| 경로 규칙 | 대상 8종(view·param·app·jig·ask·document·make·legal). `decisiveRoute` → 화면 낱말 → document | `ui/request-route.ts:1-53, 662-700, 937-990` | 경로 카드, 규칙은 못 고침 |
| `declinesJig` | 'jig 열지 말고'면 규칙·Jev 모두 jig 제외. 모델링 문장 속 jig 낱말로는 열지 않음(T-360) | `request-route.ts:176-185, 623-624` | 문장으로만 |
| Jev | `api.typesafe.ai`, 3 s 안 답 없으면 규칙. 경로·파일명 가림. skill은 `invocation: auto`의 `intent_en`만 | `ai/request-router.ts:132-150, 274-328` | 설정 스위치 |
| jig 자동 열기 | `startSkill`: 탭 열기·대화 연결·원장 `skill_start`·사람 확인 전까지 계산(Plan이면 열기만). 'AI 작업으로 보내기'로 되돌림 | `ui/skill-start.ts`, `composer.ts:351-365, 472` | 보임 |
| 질문 카드 | 구조화 출력 question + 네이티브(AskUserQuestion / request_user_input) | `turn-output.ts`, `claude-cli.ts:589-665`, `codex-app-server.ts:538-551` | 「도중에 묻기」 스위치 |
| 모델 고정·effort | 첫 턴 고정, 이후 effort만. 다른 모델은 새 대화+인계. '자동'은 Jev task×domain 표 | `conversations.ts:860-1010`, `model-router.ts` | 입력창 메뉴 |

### 3.6 개입

| 항목 | 무엇을 하나 | 위치 |
|---|---|---|
| 되돌리기 | 실행 하나 = 호스트 undo 하나, 요청 전체 `{all:true}`, 여러 파일 실패 시 자동 되돌림(GH 캔버스 제외) | `execution.ts:2202-2300`, `direct-mode.ts:1316-1360` |
| 취소·중단 | abort/cancelled, 유지 프로세스 interrupt 2 s 뒤 kill, `IdleClock`은 무출력 시간만 | `execution.ts:2627-2641`, `claude-process.ts:50-55` |
| 끼어들기·쌓기 | `POST …/interventions`, Shift+Enter `instructions[]`, busy면 새로 보내지 않음 | `execution.ts:1183-1215`, `composer.ts:1180-1232` |
| 쓰기 직렬화 | 같은 문서 쓰기 대기, 프로젝트당 동시 턴 3, execute·undo 문서별 큐, `DOCUMENT_LOCKED` | `contracts/request-scope.ts:220-321`, `direct-mode.ts:151-232` |
| Live Sync | 바뀐 객체만 반영, 1초 확인 | `live-sync.ts`, `sync-scheduler.ts` |

### 3.7 확장

| 항목 | 무엇을 하나 | 위치 |
|---|---|---|
| jig 패키지 | `jig.json` v3·`panel.json`·`skill.md`·`README.md`·`steps/*.ts`·`fixtures/`. 저장소에는 example-grid·s06-frame | `extensions/jigs/README.md` |
| 단계·카탈로그 | official/project/dev. project jig는 고정된 프로젝트에서만. `jig_open`은 `user-only`면 열기만 | `jigs/runtime/loader.ts:239, 326-393`, `skill-catalog.ts:42-123` |
| 만들기 | Claude는 초안 폴더에서만 Read/Edit/Write/Glob/Grep(셸·웹 없음). Codex는 `draft-files`→`files`. validate/test/preview. 20턴 멈춤 카드. 400파일·20 MB | `agent-connection.ts:218-251, 393-409`, `make-routes.ts`, `drafts.ts:88` |
| Grasshopper | 얇은 도구 9, 읽기 양쪽 모드·쓰기 Auto만, gh_apply 1회 = GH undo 1 | `grasshopper-tools.ts` |
| 별도 절차 개념 | jig·지침 밖의 '스킬/절차' 개념 없음. 비슷한 것은 지침 조각 `data-skill.md`뿐 | `data-skill.md`, `index.ts:107-115` |

### 3.8 모델 교체

| 항목 | 무엇을 하나 | 위치 |
|---|---|---|
| 공급자 | `claude-cli`·`codex-cli`. 자동 전환 없음. Claude 모델 4개 고정, Codex는 `~/.codex/models_cache.json` | `providers.ts`, `model-capabilities.ts`, `execution.ts:954-1010` |
| 두 공급자 차이 | 하위 에이전트·할 일은 Claude만. MCP 허용 방식(`--allowedTools` vs `enabled_tools`+code_mode), 질문 도구, 만들기 파일 경로, 작업 폴더(Codex exec에는 없음), 토큰 집계, 참고 이미지 생성(Codex만) | `agent-connection.ts:166-206, 353-359, 550-590`, `codex-cli.ts:79-111` |
| CLI 판에 매인 것 | 할 일 도구 이름(TodoWrite → Task*), `--system-prompt-snapshot`, `--safe-mode`/`--restricted`, `--setting-sources`, Codex code_mode MCP·`skip_host_skill_discovery`·`default_mode_request_user_input`·`models_cache.json` 형식, `SESSION_LOST`·`MODE_CHANGED` 문구 | `cli-compat.json`, `agent-connection.ts:161-172`, `claude-cli.ts:141-145, 197-201`, `codex-app-server.ts:77-81` |

코드에서 확인하지 못한 것: 작업 폴더가 cwd이고 `--safe-mode`·`--restricted`가 빠진 지금 프로젝트 폴더의 `CLAUDE.md`가 읽히는지([SPIKE ⑧](../tdd/SPIKE-2026-09-30-cli-session-resume.md)의 합격은 임시 cwd 시절 결과); `skill.md` 본문이 AI 문맥에 들어가는 경로(못 찾음); 보낸 패킷을 사용자가 볼 수 있는지; 패킷 256 KB·goal 20,000자 throw와 ADR-031 7("넘으면 잘라서 알린다")의 관계; 하위 에이전트가 VIDE MCP를 실제로 쓰는지.

## 4. 문서 소유 지도 [사실]

### 4.1 축별 소유 문서

| 축 | 소유·관련 문서 | 비고 |
|---|---|---|
| 지침 | [ARCH-01](../architecture/ARCH-01-system.md) §2 「대화 세션의 CLI 실행(잠정)」·「AI 실행 인자」(묶음 구성·20,000자) · [ADR-021](../decisions/ADR-021-conversation-sessions.md) 4(중립 프롬프트) · [PLAN-24](../plans/PLAN-24-ai-conversations.md) 「지침 묶음·AI 동등성」 · [SPEC-04](../specs/SPEC-04-web-review.md).11 4·ADR-037 2(프로젝트 지침 공유) · Design SCR-24 · PRD §4.3 | 동작 SPEC이 없어 ARCH가 정본. ARCH-01 §2에 "4차 물결까지 `--system-prompt`로 교체" 낡은 문장, PLAN-24에 "쓰기는 작업 사본 → 후보 → 반영만" 낡은 문장 |
| 문맥 | PRD §6.5·§10.1~10.3 · [SPEC-02](../specs/SPEC-02-execution-candidates.md).6·.17 6·.19 5 · ARCH-01 §2 · [ARCH-03](../architecture/ARCH-03-jig-runtime.md) §10 · ADR-031 5·7 · [ADR-027](../decisions/ADR-027-multi-file-coordination.md) · Design §04 | 다섯 문서에 분산. 크기 한도가 문서마다 다름 |
| 도구·권한 | ARCH-01 §2·§3 「AI 도구와 내부 계약 분리」 · ADR-031 8·[PLAN-28](../plans/PLAN-28-stock-first.md) T-122 · ADR-028 4·5 · [SPEC-01](../specs/SPEC-01-project-input-sync.md).13 2~6 · SPEC-02.19 3·7·.13 4 · SPEC-00.9 · ADR-011 §3.1·§8 · [SPEC-05](../specs/SPEC-05-extensions-install.md).2.1 | 충돌 5건(§4.3) |
| 격리 | ARCH-01 §2 격리 행·§7 · SPEC-02.19 3 · ADR-028 「대체하는 것」 · SPIKE ①⑧ · SPEC-01.13 4 · RESEARCH-10 §1.2·RESEARCH-11 §3(근거) · [RESEARCH-14](RESEARCH-14-stock-first-audit.md) §4(제안) · PLAN-24 「범위 밖」 | 제품 수준 결정 없음. 원래 근거(작업 사본 우회 방지)는 ADR-022로 사라졌으나 재평가 없음 |
| 작업 방식 | SPEC-02.20·ADR-022 2(두 모드) · [ADR-011](../decisions/ADR-011-delegation-working-mode.md) §3·§6 · SPEC-02.17 1~5(경로 일곱·Jev) · SPEC-05.2.1 · PRD §8.5·§9.5·§11.4·FR-25 · [ADR-026](../decisions/ADR-026-chat-stage-and-skill-jigs.md) 4 · Design §04 · ARCH-01 §4 | PRD §5 용어표에 'Jev' 없음 |
| 개입 | PRD §8.4·§9.2~9.3·§11.2 · SPEC-02.2·.4·.8·.13 3·.19 4 · ADR-027 2·3·6 · ADR-029 2·ADR-033 3 · ARCH-01 §2·§3 | ARCH-01 §3 '세션 내 메시지 주입 지원' ↔ ADR-021 6 |
| 화면 | Design §03·§04·§06·SCR-15 · ADR-026 5 · ADR-031 2 · ARCH-01 §3 '화면' · PRD §9.1 | — |
| 확장 | PRD §12.3·FR-13·24·§5 · [ADR-020](../decisions/ADR-020-jig-platform.md) · [SPEC-07](../specs/SPEC-07-jig-platform.md).9·.18 · ADR-026 'skill 계약' · ARCH-03 §2.2·§5.3 · ARCH-01 §2 · SPEC-05.1·.4 · ADR-040 2 · SPEC-01.13 10 | 확장 단위 = jig. "공급자 CLI의 skill 기능으로 싣지 않는 VIDE 내부 계약" |
| 모델 교체 | ADR-021 2 · SPEC-02.17 5·.19 2·5 · SPEC-05.2·.5·.7 · ARCH-01 §2 'CLI 판 확인'·§7 · PRD §10.2 | 재검증 정책 없음 |

### 4.2 소유 문서가 없는 요소

1. **전역 지시 묶음을 사용자가 보거나 고치는 기능.** 묶음 본문은 ARCH-01 §2·PLAN-24에만 있고, 어느 SPEC·Design도 화면에서 보는 방법을 정하지 않는다. 고칠 수 있는 것은 프로젝트 추가분뿐이다. 묶음이 담는 규칙의 동작 SPEC도 없다(SPEC-02.13 4가 "(지시 묶음의 규칙)"에 기댄다). FR도 없다.
2. **한 턴 문맥을 조립하는 단일 계약.** PRD §10, SPEC-02.6·.17 6·.19 5, ARCH-01 §2, ARCH-03 §10에 흩어져 있고 한도도 제각각이다(묶음 20,000자, 패킷 256 KB, 이미지 20장, 요청 2,000자·답 6,000자, 도구 결과 96 KB).
3. **사용자 자신의 CLI 설정에 대한 격리 정책.** ARCH-01의 인자 표와 ADR-028 「대체하는 것」이 사실상 정본이고 PRD·SPEC 결정이 없다.
4. **Vibe/Spec 같은 명시적 진행 방식 모드.** 계획/자동은 쓰기 권한 축 하나다. ADR-011 §6은 "별도 모드 요구가 반복되면 재검토"라고만 적었다.
5. **작업 폴더의 `AGENTS.md`·`CLAUDE.md`와 VIDE 턴의 관계.** SPEC-01.13 7·10은 터미널용 진입문으로만 다룬다. Codex는 `project_doc_max_bytes=0`으로 끄지만 Claude 쪽은 cwd가 바뀐 뒤 확인이 없다.
6. **모델·판이 바뀔 때 환경을 다시 검증하는 정책.** CLI 판 범위 확인과 RESEARCH-11 §4의 A/B 방법만 있다. 오늘 Codex 0.163(T-361)이 그 사례다.
7. **PRD의 정체성.** ADR-028·ADR-031이 PRD에 반영되지 않았고, 재구성은 OQ-15로 보류돼 있다.

### 4.3 문서 간 충돌(도구·권한)

| # | 한쪽 | 다른 쪽 |
|---|---|---|
| a | SPEC-02.19 7 끝 "파일 쓰기 도구는 주지 않는다" | SPEC-01.13 2·ADR-031 8: Edit·Write·Bash 제공 |
| b | SPEC-02.19 3 "도구 목록이 다르면 실행하지 않고 멈춘다" | ARCH-01 §2 「허용 밖 도구 호출」 "턴을 멈추지 않는다"(코드도 경고만, §3.3) |
| c | ARCH-01 §3 "일반 셸·파일·웹 도구가 추가되지 않도록 검증" | ADR-031 8·ADR-028 5: 켠다 |
| d | SPEC-02.13 4 일괄 삭제 기준 500(코드도 500, §3.3) | ADR-022 3 "기본 50", ADR-027 7 "50개", ARCH-01 §4 `maxDeletes: 50` |
| e | PRD §10.5·SPEC-02.19 3 "호출 상한" | SPEC-02.6·ADR-031 7 "상한 없음" |

## 5. 대조 — 축별로 VIDE는 어디에 있는가 [분석]

### 5.1 축별 판정

| 축 | 세 도구의 공통 꼴 | VIDE 현재 | 판정 |
|---|---|---|---|
| 지침 | 범위(조직·사용자·프로젝트·경로)별 파일, 사용자가 보고 고침, 적용 조건 선언 | 전역 묶음은 코드 안에 숨어 있고(§3.1) 프로젝트 추가분만 사용자가 고침. 적용 조건은 모드·호스트 하드코딩 | **부분.** 건축 지침의 내용은 많으나 사용자에게 보이지 않고, 묶음 자체에 결함(§6.1) |
| 문맥 | 자동 포함 + 사용자 지정 + 도구 검색 + 요약 | 핀·스케치·작업 모델·폴더·DB·노트·원장이 모두 들어가고 상한이 세밀함(§3.2). 사용자 지정은 핀·첨부·폴더 칩 | **있음, 그러나 계약이 분산.** 무엇이 들어갔는지 사용자가 한눈에 못 봄(패킷 미공개) |
| 도구·권한 | 모델 밖 강제, deny > ask > allow, 작업공간 밖은 승인 | 턴마다 발급, 폴더 카드, 보호 동작 가드(§3.3) | **있음.** 문서가 서로 어긋남(§4.3) |
| 모드 | 읽기 전용/계획 → 승인 → 실행 | Plan/Auto 두 모드 + 경로 판정 8종 + jig 자동 열기(§3.5) | **있으나 축이 다름.** 세 도구의 모드는 사람이 고르고, VIDE는 판정기가 고른다. T-360(모델링 문장을 jig로 강제)은 이 차이의 결과 |
| 개입 | hunk 승인·체크포인트·중단·조향·큐·훅 | 요청 단위 되돌리기·취소·끼어들기·쌓기·직렬화(§3.6). 훅 없음 | **있음.** 호스트 undo와 묶인 되돌리기는 세 도구보다 강함 |
| 화면 | 편집기 안 diff·인라인·진행 | 대화 열 + 무대, 핀·스케치, 3D 표시 | **있음.** VIDE 고유 |
| 확장 | 지침(정적) ≠ 스킬(절차, 필요 때 로드) ≠ 도구(행동) ≠ 플러그인(묶음) | jig 하나로 묶임. 절차 개념 없음(`data-skill.md` 조각뿐). `skill.md` 본문이 AI에 가는 경로 없음(§3.7) | **없음에 가까움.** 세 도구가 모두 나누는 "절차 지식" 층이 비어 있다. 건축 절차(규모검토 순서, 도면 체크 순서, 사무소 관례)를 넣을 자리가 jig 코드 또는 전역 지침뿐 |
| 모델 교체 | 모델 선택·라우팅, 바뀔 때의 정책은 없음 | 두 공급자, 대화 고정, 판 범위 문(§3.8) | **있음.** 재검증 정책만 없음 |

### 5.2 VIDE만의 축 — 호스트 다리

세 도구의 환경은 "모델이 원래 읽는 텍스트 파일 + 셸" 위에 서 있다. VIDE의 대상은 Rhino·ZWCAD 문서이고 모델은 이를 직접 읽지도 쓰지도 못한다. 그래서 다음은 순정으로 대체할 수 없는 VIDE 고유 층이다.

- 플러그인과 연결(SPEC-01), Sync와 작업 모델 요약(§3.2), `query`·`execute`·`measure`·`capture_view`(§3.3).
- 핀(객체를 문장 속에 넣기)과 스케치(좌표에 연결된 의도). 세 도구의 `@file`에 해당하는 것이 VIDE에서는 핀·스케치·연결 파일이다.
- 호스트 undo와 묶인 요청 단위 되돌리기, 같은 문서 쓰기 직렬화.
- 모델·도면·자료 DB(프로젝트 자료·기록)와 작업 폴더.

ADR-031 2가 말한 "터미널에 없는 것 = 화면·핀·되돌리기·이력"이 바로 이 층이다. 이 관점에서 **VIDE = 순정 CLI + 건축 환경(지침·문맥·절차·확장) + 호스트 다리**로 적을 수 있다.

### 5.3 Kiro의 Vibe/Spec과 VIDE

Kiro는 세션을 열 때 사람이 Vibe(대화하며 만들기)와 Spec(요구 → 설계 → 작업 목록을 승인하며 만들기)을 고른다. VIDE에서 같은 자리에 있는 것은 셋이다. 계획 모드(SPEC-02.20, 쓰기 전 계획), jig(SPEC-07, 입력 조립 → 설정값 → 단계 → 결과의 고정 절차), 그리고 경로 판정(SPEC-02.17, 어느 길로 갈지 판정기가 고름). PLAN-51 라운드 1~7의 P0 다수(T-360 포함)는 세 번째가 사람의 뜻과 어긋난 경우였다. 세 도구는 모두 모드를 사람이 고르고 판정기는 그 안에서만 움직인다. 이 차이가 D2다.

## 6. 발견한 결함 [사실]

### 6.1 지침 묶음(`src/ai/instructions/common.md`) — 매 턴 붙는 파일

- **9행이 깨져 있다.** 한 줄에 두 문장이 섞여 "… 하위 에이전트·할 일·웹 도구는 `- 프로젝트 파일은 공급자 기본 도구(…)로 프로젝트 작업 폴더 안에서 다룬다(`turn …`" 식으로 끊긴다. 괄호가 닫히지 않고 다음 문장의 앞부분이 들어가 있다.
- **14행이 낡았다.** "AI 편집은 작업 실행본(사본)에서 한다. 결과는 후보가 되고, 사용자의 원본 파일은 사용자가 후보를 반영(apply)할 때만 바뀐다. 원본을 고쳤다·저장했다·내보냈다고 말하지 않는다." ADR-022(2026-09-30 바로 적용) 뒤의 실제 동작은 열린 문서를 직접 고치고 요청 단위로 되돌리는 것이다. 모델은 매 턴 사실과 다른 규칙을 받고 있고, 결과 보고 문구("원본을 고쳤다고 말하지 않는다")가 사용자에게 혼란을 줄 수 있다.
- 두 결함 모두 사용자가 볼 수 없는 파일에 있다(§3.1). 지침 가시성(D3)과 별개로 즉시 고칠 수 있는 P1 결함이다.

### 6.2 문서 결함

- ARCH-01 §2 "4차 물결까지 `--system-prompt`로 교체"와 PLAN-24 "쓰기는 작업 사본 → 후보 → 반영만"은 ADR-022 이전 문장이다.
- §4.3의 충돌 다섯 건. 코드는 (a) 제공, (b) 멈추지 않음, (d) 500 쪽이다.
- SPIKE ⑧(상위 폴더 `CLAUDE.md`가 읽히지 않음)은 임시 cwd 시절 결과다. 작업 폴더가 cwd가 된 뒤 재확인이 없다(D1과 관련).
- ADR-031 7 "넘으면 잘라서 알린다"와 코드의 패킷 256 KB·goal 20,000자 throw(§3.2)의 관계가 문서에 없다.

## 7. PRD 정체성 문장 대조와 재서술 후보 [제안]

PRD가 지금 VIDE를 정의하는 문장은 셋이다. 머리 "여러 설계 프로그램과 데이터를 하나의 프로젝트로 연결하고, 건축가가 가리키고 그리며 AI에 작업을 맡기고, 실제 중간 상태를 보면서 개입하는 확장형 IDE", §0 "여러 프로그램과 설계 자료를 함께 다루는 공통 IDE 플랫폼", §1.1 "설계 도구와 프로젝트의 데이터·문서를 한데 엮고 AI로 제어하는 통합 관리 환경". 셋 다 '무엇을 엮는가'를 말하고 '모델은 무엇이고 VIDE는 무엇인가'를 말하지 않는다.

첨삭 초안(PRD에는 `<ins>`로 넣고 사용자가 수락한다):

- §1.1 첫 문단 뒤에 한 문단. "VIDE는 AI 모델을 만들지 않는다. 사용자가 구독한 공식 AI 도구(Claude Code·Codex CLI)를 그대로 실행하고, 그 모델이 건축 설계 작업을 잘하도록 **둘러싼 환경**을 만든다. 환경은 건축 지침, 모델·도면·자료에서 뽑은 문맥, 호스트를 읽고 쓰는 도구와 권한, 진행 방식, 사람의 개입, 화면, 건축 전용 확장으로 이루어진다. 세 도구가 코드 저장소 위에서 하는 일을 VIDE는 Rhino·CAD 문서와 프로젝트 자료 위에서 한다. 모델이 직접 읽고 쓰지 못하는 호스트 문서를 잇는 다리(연결·Sync·핀·스케치·되돌리기)는 VIDE가 소유한다."
- §4에 「4.x 작업 환경의 구성 요소」 절을 두고 여덟 축을 한 표로 적으며, 각 축의 정본 SPEC/ARCH를 가리킨다. FR은 새로 만들지 않고 기존 FR-08·13·18·24·25를 축에 배치한다. 지침 가시성(D3)만 결정 뒤 FR 후보가 된다.
- §18 OQ-15를 이 재서술로 좁힌다(세 기둥 재구성은 그대로 보류, 정체성 문장과 §4.x만 결정).

## 8. 결정이 필요한 항목 [제안]

| ID | 질문 | 선택지 | 추천과 이유 | 영향 문서 |
|---|---|---|---|---|
| D1 | 사용자 자신의 CLI 환경(개인 `CLAUDE.md`·전역 MCP·스킬·플러그인)을 VIDE 턴에서 어떻게 다루나 | ① 지금처럼 전부 끔(대체) ② 전부 켬(얹기) ③ 선택형: 사용자가 설정에서 고른 MCP 서버와 작업 폴더의 `AGENTS.md`만 켜고, 개인 `CLAUDE.md`·플러그인·스킬은 계속 끔 | **③.** 끄는 원래 근거(작업 사본 우회 방지)는 ADR-022로 사라졌고, 사용자의 Rhino MCP·cordyceps를 못 쓰는 것이 Q2의 불만이다. 반면 개인 `CLAUDE.md`는 VIDE 지침과 충돌하고 스킬·플러그인은 권한을 넓힌다. MCP는 세 도구 모두 "프로젝트 범위, 첫 사용 승인"이 표준이다 | ADR 신설, SPEC-05(AI 연결), ARCH-01 §2, SPEC-01.13(`AGENTS.md`), SPIKE ⑧재확인 |
| D2 | 진행 방식을 사람이 고르게 하나(Kiro Vibe/Spec), 판정기에 맡기나 | ① 지금처럼 판정기(규칙·Jev)가 jig·계획을 고름 ② 사람이 대화/작업(jig)/계획 중 고르고 판정기는 그 안에서만 ③ 기본은 대화(AI)이고 jig는 제안 카드, '계획부터'는 토글 유지 | **③.** Q1의 추천과 같다. 세 도구가 모두 "모드는 사람, 판정은 모드 안"이다. 라운드 1~7의 P0 대부분이 강제 진입이었다. ②의 첫 화면 선택은 비개발자에게 한 단계 더 묻는 것이라 ③이 가볍다 | PRD §11.4·FR-25, SPEC-02.17, ADR-026 4 보완, ADR-011 §6 |
| D3 | 전역 지침 묶음을 사용자에게 보이고 고치게 하나 | ① 숨김 유지(지금) ② 읽기 전용 공개(설정 → AI에서 모드별 묶음 열람, 판 표시) ③ 공개 + PC/프로젝트 덮어쓰기 ④ 팀 규칙(사이트 원본, Cursor Team Rules 꼴) | **② 지금, ③은 적용 조건 선언(경로·호스트·jig) 설계 뒤.** 보이지 않아서 §6.1 결함이 7주 넘게 남았다. 덮어쓰기는 충돌·권한 상승 문제가 있어 PRD §4.3과 함께 설계해야 한다 | FR 후보, SPEC-05 또는 새 SPEC-18, Design SCR-24 |
| D4 | 모델·CLI 판이 바뀔 때 무엇을 다시 검증하나 | ① 판 범위 문만(지금) ② 판 범위 + 환경 회귀 묶음(SPIKE 0·④·⑧ + PLAN-51 L0 route-only·요청 3건)을 '판 갱신 절차'로 문서화 ③ 범위 문 제거, 신호 분류만 | **②.** 오늘 T-361처럼 자동 갱신 한 번에 한 공급자가 통째로 막힌다. 절차가 있으면 반나절 안에 넓힐 수 있다 | PLAN-24 T-059 절차 보강, PLAN-51 L0 |
| D5 | PRD 정체성 문장과 §4.x 신설을 지금 하나 | ① §7 초안대로 첨삭 ② OQ-15 전체(세 기둥 재구성)와 함께 나중에 | **①.** 문장 두 개와 표 하나이고 FR·범위를 바꾸지 않는다. 세 기둥 재구성은 그대로 OQ-15 | PRD §1.1·§4·§18 |

## 9. 다음 단계 [제안]

1. **즉시(결정 불필요):** §6.1 `common.md` 9·14행 수정과 ARCH-01 §2·PLAN-24 낡은 문장 정정, §4.3 충돌 (a)(b)(d)를 코드와 맞추는 SPEC/ADR 한 줄 정정. PLAN-51 수정 웨이브 6에 티켓으로 올린다.
2. **D1~D5 결정 뒤:** PRD 첨삭(§7) → SPEC-18 「AI 작업 환경」(지침 층·문맥 조립 계약·도구/권한 집합·격리 정책·모드·재검증 절차를 한 문서가 소유하고, SPEC-02·05·07·08의 기존 절은 가리키기만) → ADR 두 건(D1 격리, D2 진행 방식) → PLAN 티켓.
3. **별도 조사 후보:** 절차 지식 층(§5.1 '확장' 행). 건축 절차를 jig 코드도 전역 지침도 아닌 "필요할 때 불러오는 절차 문서"로 둘지는 SPEC-07.18의 "공급자 skill 기능으로 싣지 않는다" 결정과 함께 다시 봐야 한다.

## 10. 한계

- 외부 조사는 공식 문서를 요약 모델을 거쳐 읽은 것이고 접속일은 2026-10-19 하루다. 세 제품 모두 빠르게 바뀐다.
- 코드 인벤토리의 행 번호는 `main` c3368b22 기준이며 일부는 보조 조사자가 읽은 값을 재확인하지 않았다. §6.1의 두 결함은 직접 확인했다.
- 이 문서는 사용자 체감(라운드 1~7의 P0)과 코드·문서 대조로 빈 곳을 찾았을 뿐, 어느 축이 결과 품질에 얼마나 기여하는지는 측정하지 않았다. RESEARCH-11 §4의 A/B 방법이 그 측정에 쓸 수 있다.
