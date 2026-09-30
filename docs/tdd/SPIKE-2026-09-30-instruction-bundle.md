---
id: SPIKE-2026-09-30-instruction-bundle
title: 지침 묶음 통합 확인 — 인자 일치와 Claude 실호출 2턴
status: review
version: 0.1
updated: 2026-09-30
owner: agent:claude
related: [PLAN-24, ARCH-01, ADR-014, ADR-021, SPEC-02, RESEARCH-10, RESEARCH-11]
---

# 지침 묶음 통합 확인 — 인자 일치와 Claude 실호출 2턴

[PLAN-24](../plans/PLAN-24-ai-conversations.md)의 「지침 묶음·AI 동등성」 작업을 합친 뒤의 확인 기록이다. 확정 인자 표는 [ARCH-01](../architecture/ARCH-01-system.md) §2 「AI 실행 인자」가 소유하고, 여기에는 질문·방법·결과·한계만 적는다. 프로젝트 자료·사용자 원본·Rhino는 쓰지 않았다.

## 질문과 합격 기준(실행 전)

| # | 질문 | 합격 기준 | 방법 |
|---|---|---|---|
| 1 | `bundleFor('modeling')`에 `modeling-rhino.md`·`modeling-cad.md`가 들어가는가 | 호스트를 안 주면 두 조각, 주면 그 호스트 조각만 | `tests/ai/instructions.test.mjs` |
| 2 | 프로젝트 추가 지침이 설정 경로에서 실행까지 가는가 | PUT으로 저장한 글이 다음 요청 공급자 옵션 `projectInstructions`로 넘어감 | 같은 시험, 가짜 공급자로 요청 1건 |
| 3 | 단발·세션·호스트 도구·대화 도구·만들기에서 두 CLI 인자가 같은 묶음을 싣는가 | 두 CLI의 묶음 본문이 같고, 차이는 `## 이번 실행의 규칙` 뒤 문단뿐. Codex 세션 인자는 `codexTurnIsolated` 통과 | 같은 시험(모드 5종) |
| 4 | 실제 Claude CLI에서 자료 모드 세션 턴이 시작 이벤트 검사를 통과하고, 묶음·추가 지침이 모델에 닿는가 | 2턴 모두 `succeeded`, 질문 카드 생성·답변 턴 이어 실행, 모델이 공통 지침 문장과 추가 지침의 표지어를 인용 | 임시 sqlite의 시험용 엔진, 합성 요청 2턴 |

## 방법·환경

- Windows 11, Node 24.15, Claude Code 2.1.285(`~/.local/bin/claude.exe`, 판 범위 `>=2.1.284 <2.2.0` 안), 기본 로그인 프로필, 모델 `haiku`, effort `low`.
- 시험용 엔진: 저장소의 `startServer({ filename: <%TEMP%\vide-bundle-smoke-*\vide.sqlite>, host: 가짜 상태 })`. 설치 엔진(47821)과 그 DB는 건드리지 않았다. 공급자는 제품의 `createProvider`에 실행 인자·표준 출력을 기록하는 `spawnProcess`만 끼웠다.
- 흐름: 프로젝트 생성 → `PUT /projects/:id/ai-instructions`에 합성 추가 지침("시험 표지어: 청록-일곱. 치수는 mm로 적는다.") → 대화 생성(`claude-cli`, `haiku`, kind `general`) → 요청 1(`hostUse: 'none'`, 대화 ID): 지침 첫 줄 인용·표지어·"표/문장" 질문 카드 요구 → `POST …/conversations/:cid/answer`로 "표" 선택 → 답변 턴 → 대화를 `discard: true`로 닫아 공급자 기록 삭제.
- 시험 스크립트는 세션 scratch 폴더에 두고 저장소에 넣지 않았다.

## 결과

| # | 판정 | 요지 |
|---|---|---|
| 1 | 통과 | 두 호스트 약 14.3천 자, Rhino만 약 9.7천, ZWCAD만 약 7.8천 자 |
| 2 | 통과 | 요청 1건의 공급자 옵션에 저장한 글이 그대로 실림(호스트 편집 요청이라 모드 `modeling`) |
| 3 | 통과(수정 1건 뒤) | 모드 5종에서 두 CLI 묶음 일치. Codex 세션의 jig 만들기 턴이 `turn-rules`로 Claude용 파일 도구 문장을 받던 문제를 고침(아래) |
| 4 | 통과(수정 1건 뒤) | 첫 실행은 `UNEXPECTED_TOOL_ACCESS`로 실패. 고친 뒤 2턴 모두 `succeeded` |

실측 세부(수정 뒤 실행):

- 턴 1 인자: `-p --restricted --tools "" … --append-system-prompt <2,739자> --model haiku --effort low --session-id <UUID> --system-prompt-snapshot off --json-schema <873자> --allowedTools mcp__vide__jig_list,…,mcp__vide__sync_sample`. `--system-prompt` 없음. 덧붙인 글은 `# VIDE 작업 지침 (공통)`으로 시작해 추가 지침 블록을 담고 `neutralInstruction`으로 끝남.
- 턴 2 인자: 같은 모양에 `--resume <같은 UUID>`.
- 두 턴의 시작 이벤트: 도구 `StructuredOutput` + vide MCP 7종(허용 목록과 같음), MCP 서버 `vide` 하나(`connected`), `skills: []`, `slash_commands: []`. 두 턴 모두 모델은 `StructuredOutput` 도구만 호출.
- 턴 1 출력: `status: question`, 질문 `answer-format`("다음 답변을 표와 문장 중 어느 형식으로 드릴까요?", 추천 "표"). 원장: `result-ref`, `question`.
- 턴 2 출력(답변 "표"): 표 형식으로 공통 지침 본문의 첫 문장("너는 VIDE 안에서 일한다. VIDE는 건축가가 …")과 표지어 "청록-일곱"을 인용. 첫 줄인 제목 대신 첫 문장을 골랐지만 두 문자열 모두 묶음에만 있는 글이다. 원장: `result-ref`, `question`, `answer`, `result-ref`. 세션 2턴, 턴 2 캐시 읽기 9,290 토큰.
- 닫기 뒤 `~/.claude/projects` 아래에 이 세션 ID의 기록 파일이 남지 않음.

## 고친 통합 문제

1. **대화 도구 턴의 `StructuredOutput` 거절(`src/ai/claude-cli.ts`).** 파일 도구가 없는 대화 턴도 `--json-schema`를 주면 CLI 2.1.285가 출력 도구 `StructuredOutput`을 시작 목록에 넣는다. 기존 검사는 jig 만들기 턴에서만 이를 허용해 `UNEXPECTED_TOOL_ACCESS`로 멈췄다([VERIFY-2026-09-30-jig-authoring-m5](VERIFY-2026-09-30-jig-authoring-m5.md)는 만들기 턴만 다룸). 이제 그 실행이 스키마를 넘겼을 때만 시작 목록과 도구 호출에서 `StructuredOutput`을 허용한다. 다른 도구의 검사는 그대로다.
2. **Codex 세션 만들기 턴의 턴 규칙(`src/ai/agent-connection.ts`·`claude-cli.ts`).** `turnRules(연결, 형식)`이 공급자 형식을 받아, Codex 세션 턴의 `turn-rules`가 `codexMakeInstruction`(파일 도구 없음, 출력 `files`)이 된다.

## 한계

- Codex 실호출, 모델링 모드(Rhino) 실호출, 이미지 입력은 이번에 하지 않았다. Codex 인자는 단위 시험의 `codexTurnIsolated`로만 확인했다.
- 설치된 Claude는 2.1.285로, `cli-compat.json`의 검증 목록(2.1.284)보다 새 판이다. 범위 안이라 실행했고 위 1번 차이를 여기서 발견했다.
- 모델이 "첫 줄"을 제목 대신 첫 문장으로 읽은 것은 도달 확인에는 충분하지만 지시 이행의 정확도 판단은 아니다. 품질 비교는 [RESEARCH-11](../research/RESEARCH-11-ai-parity.md) §4의 A/B 방법을 따른다.
- 원격 기기는 `/ai-instructions`를 PUT할 수 있다(원격 제한 목록의 `settings` 경로 밖). 글은 자료 블록으로만 들어가지만, 막을지는 SPEC-02 결정 사항이다.
