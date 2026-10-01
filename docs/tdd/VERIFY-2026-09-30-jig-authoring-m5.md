---
id: VERIFY-2026-09-30-jig-authoring-m5
title: M5 수용 — 만들기 대화로 S-06 보조 jig 만들기(실제 Claude CLI)
status: review
version: 0.2
updated: 2026-10-01
owner: agent:claude
related: [FR-24, AC-45, SPEC-07, ARCH-03, PLAN-22, T-063, T-064]
---

# M5 수용 — 만들기 대화로 S-06 보조 jig 만들기

## 범위

[PLAN-22](../plans/PLAN-22-jig-platform.md) T-064(SPEC-07.16)의 수용 시험이다. 만들기 서버 API와 만들기 도구(`jig_validate`·`jig_test`·`jig_preview`·`ask_user`)를 **실제 Claude CLI**로 돌렸다. 흐름은 다음과 같다.

1. `example-grid`에서 초안을 만든다.
2. 만들기 대화에 "신설 E.J.마다 양쪽 기둥과 공통 파일캡이 있는지 보는 도구"를 요청한다.
3. AI가 초안 폴더에 단계를 쓰고 점검·시험·미리보기를 돌린다.
4. 질문 카드에 한 번 답한다.
5. 이 프로젝트의 jig로 고정한다.
6. 고정한 jig를 S-06 합성 fixture에서 돌린다.

만들기 탭 화면(T-063 2부)과 Codex 만들기 턴은 이 기록의 범위가 아니다. Rhino는 띄우지 않았다.

## 자료와 환경

- 2026-09-30, Windows 11, Node 24.15, Claude Code 2.1.285, 모델 `sonnet`(기본 계정 프로필).
- 엔진은 scratch 폴더의 임시 DB로 프로세스 안에서 띄웠다(`startServer`). 초안·설치본도 그 폴더(`<scratch>/data/jigs/…`)에만 있다.
- 사용자 원본과 설치본 DB(`%LOCALAPPDATA%/VIDE`)는 쓰지 않았다. 저장소에 넣은 실데이터는 없다.
- 입력은 모두 합성이다.
  - 만들기 요청에는 역할 세 개(`newEJ` 선, `columns` 수직선, `newFootings` 블록)의 행 모양만 적었다.
  - AI가 fixture를 스스로 만들었다: `basic`, `missing-column`, `split-cap`, `on-line`.
  - S-06 대조에는 `extensions/jigs/s06-frame/fixtures`의 `grid-rot21`을 썼다.
- 공급자 기록(세션 transcript)은 시험 뒤 초안 삭제(`DELETE …/jig-drafts/:did`)로 지웠다. 삭제 뒤 해당 세션 ID의 기록 파일이 남지 않은 것을 확인했다.

## 대화 요약

턴 번호는 대화 요청 순서다. 비용은 CLI가 보고한 값이다.

| 턴 | 내용 | 결과 | 시간 |
|---|---|---|---|
| 1 | 만들기 요청(입력 역할·판정·fixture 조건) | 도구 없이 답함. 요청이 호스트 경로로 가서 만들기 도구가 붙지 않았다(결함 ①) | 12.1 s |
| 2 | "이번 턴부터 도구를 쓸 수 있어" | `UNEXPECTED_TOOL_ACCESS`로 CLI 시작 직후 멈춤(결함 ②). 모델 호출 전 | 3.0 s |
| 3 | 같은 요청 재시도 | 같은 실패 | 3.0 s |
| 4 | 같은 요청(①② 수정 뒤) | 파일 20개 작성. 만들기 도구 호출은 모두 `TARGET_MISMATCH`(결함 ③). 질문 카드 1장(`ej-side-tie-rule`: E.J. 선 위 기둥 처리)을 턴 결과로 냄 | 183.6 s, CLI 내부 38회, $0.60 |
| 5 | 질문 카드 답(`flag-on-line`, 답변 경로 `…/conversations/:cid/answer`) | ③ 수정 뒤. 선 위 기둥 처리를 반영하고 `blockFootprints` 반환 모양 오해를 스스로 고침. `on-line` fixture 추가. `jig_validate` 3회, `jig_test` 4회, `jig_preview` 3회 뒤 모두 통과 | 78.3 s, CLI 내부 41회, $0.36 |

- 사람이 코드를 고치지 않았다. 점검·시험 통과까지 5턴이 들었고, 결함 때문에 헛돈 턴(1~3)을 빼면 2턴이다.
- AI가 만든 jig는 `project/ej-twin-check@0.1.0`이다.
  - 단계: `twins`(쌍기둥·파일캡 판정), `summary`
  - 설정값 5개(모두 '가정' 근거): 가까운 기둥 범위 2 m, 선 방향 어긋남 1 m, 간격 하한 0.5 m, 간격 상한 2.5 m, 캡 경계 허용 0.05 m
  - 화면: 3D·평면 겹침 층, KPI, 쌍기둥·문제 표
- 단계 코드의 import는 `vide/geometry-kit`의 `blockFootprints`와 자기 파일뿐이었다.

## 점검·시험·고정

API로 한 번 더 돌린 값이다.

| 동작 | 결과 | 시간 |
|---|---|---|
| 초안 만들기(`example-grid`) | 201 | 15 ms |
| `validate` | 통과, 문제 0 | 21 ms |
| `test` | 4건 모두 통과 | 57 ms |
| `preview`(`basic`) | 두 단계 완료, 쌍 2개 정상 | 16 ms |
| 고정(`pin`, `confirm: true`) | 200, `source: ai-draft`, 설치·프로젝트 고정 | 104 ms |

**금지 파일.** 초안 폴더에 파일을 직접 넣고 점검과 고정을 해 보았다. 다음 6개 모두 점검이 `JIG_FORBIDDEN_FILE`로 실패했고 고정은 422 `JIG_INVALID`였다.

- `CLAUDE.md`
- `AGENTS.md`
- `.mcp.json`
- `package.json`
- `.claude/settings.json`
- `node_modules/x/index.js`

## 계산 상자

별도 합성 초안(`blank`)의 단계를 바꿔 가며 `test`·`preview`를 돌렸다.

| 시도 | 결과 |
|---|---|
| 전역 확인 | `fetch`·`require`·`process`·`setTimeout`·`WebAssembly`·`XMLHttpRequest`가 모두 `undefined`. `eval('fetch(…)')`는 `'fetch' is not defined` |
| `import … from 'node:fs'` | `THROW MODULE_NOT_ALLOWED`, 단계 실패 |
| 패키지 밖 상대 경로 import | `THROW MODULE_NOT_ALLOWED` |
| 무한 반복 | `BUDGET` "10001 ms > 10000 ms" |

`eval('import("node:fs")')`는 동기 단계에서 약속(promise)만 돌려주었다. 그 약속이 거절되는지는 이번에 확인하지 않았다.

## S-06 합성 fixture에서 실행

고정한 jig를 레지스트리에서 불렀다. 출처는 `ai-draft`이고 실행기는 `ComputeBoxRunner`였다. `grid-rot21`에서 두 가지로 돌렸다.

| 입력 | 이 jig의 판정 | S-06 골조 jig ③ | 같음 |
|---|---|---|---|
| B. ③이 만든 기둥 + ④ 공통 파일캡(블록 정의) | 쌍 2개, 둘 다 정상(공통 캡), 간격 1.1 m, 문제 0 | 쌍 2개(`pair:EJ1-NA`·`NB`), 간격 0.5 + 0.6 = 1.1 m, 각 쌍 공통 캡 | 예 |
| A. 그려진 기둥·신설 기초 원본 행 | E.J. 1개, 쌍 0, 문제 1("가까운 기둥 없음") | (③은 제안 배치에서만 쌍을 만든다) | 비교 대상 아님 |

실행 시간은 A 33 ms, B 10 ms였다.

## 결함과 수정

작업 중 흐름이 막힌 곳 네 군데를 최소 범위로 고쳤다.

1. **만들기 턴이 호스트 경로로 감.**
   - 증상: 화면 입력창은 `hostUse`를 보내지 않는다. 그래서 `permission: review` 턴이 Rhino 경로로 가고, 만들기 도구가 붙지 않았다.
   - 수정: `ConversationService.fix()`가 `jig-make` 대화의 턴에 `hostUse: 'none'`을 넣는다. 같은 자리에서 초안이 열려 있지 않으면(고정·버림) `DRAFT_NOT_OPEN`(409)으로 거절한다.
   - 파일: `src/server/conversations.ts`
2. **`StructuredOutput` 때문에 시작 거절.**
   - 증상: `--tools`가 비어 있지 않으면 CLI가 `--json-schema`용 출력 도구 `StructuredOutput`을 도구 목록에 넣는다. 시작 이벤트 검사가 이를 허용 밖으로 보고 `UNEXPECTED_TOOL_ACCESS`를 냈다.
   - 수정: 초안 폴더가 붙은 연결에서만 이 이름을 허용한다.
   - 파일: `src/ai/agent-connection.ts` `allowedAgentEvent`
3. **만들기 도구의 `targetRef`.**
   - 증상: 도구 스키마가 `targetRef`를 요구했지만 턴 자료 어디에도 그 값(`conversation:<id>`)이 없었다. AI는 초안 ID·jig ID를 넣어 보다가 모두 `TARGET_MISMATCH`를 받았다.
   - 수정: 네 만들기 도구(`jig_validate`·`jig_test`·`jig_preview`·`ask_user`)는 `targetRef`를 빼도 되게 했다(주면 기존대로 검사). 만들기 지시문에 "leave targetRef out"을 더했다.
   - 파일: `src/server/agent-tools.ts`, `src/ai/agent-connection.ts`
4. **초안 삭제(DELETE)가 405.**
   - 증상: 엔진이 GET·POST·PUT만 받아서 `DELETE …/jig-drafts/:did`가 경로에 닿지 않았다.
   - 수정: 이 한 경로의 DELETE만 허용한다. Origin 검사는 그대로다.
   - 파일: `src/server/server.ts`

## 마찰(고치지 않음)

- **대화 도구의 `targetRef` 문제가 남아 있다.** 만들기 턴에도 딸려 붙는 대화 읽기 도구(`jig_list`·`jig_state`·`jig_output` 등, T-062)는 여전히 `targetRef`를 요구하는데, 모델이 그 값을 받을 경로가 없다. 턴 규칙(`turnRules`)에 대상 값을 싣는 편이 근본 해결이다. PLAN-24 T-062 쪽에서 볼 일이다.
- **삭제 도구가 없다.** 파일 도구에 삭제가 없어 AI가 `steps/grid.ts`·`beams.ts`·`schemas/steps/grid.json`·`beams.json`을 빈 껍데기로 남겼다. 점검은 통과하고, 고정한 묶음에도 들어간다.
- **답변 턴의 한도.** 질문 카드 답변 경로는 기본 한도(도구 30회, 180 s)로 턴을 연다. 작성 턴(4)은 184 s가 걸렸으므로, 답변 뒤 큰 수정이 이어지면 시간 초과가 날 수 있다. 이번 답변 턴은 78 s였다.
- **질문 카드 모양.** 턴 4의 결과는 `status: progress`에 질문 1장이었다(`question`이 아님). 답변 경로는 원장에서 그 질문을 찾아 정상 처리했다.
- **멈춤 조건은 시험하지 않았다.** 반복 실패·턴 초과에서의 멈춤 조건은 이번에 일어나지 않아 실물로 보지 못했다(PLAN-22 T-064 실패 기록 항목).

## 재현 시험

`tests/server/make-acceptance.test.mjs`가 위 흐름을 가짜 CLI 프로세스로 재현한다.

- 가짜 CLI는 실제 CLI가 한 일을 그대로 한다.
  - 시작 이벤트: `StructuredOutput`과 파일 도구 포함
  - `--add-dir` 폴더에 파일 쓰기
  - 턴 토큰으로 vide MCP 도구 호출(`targetRef` 없이)
  - 질문 카드 → 답변 턴 → 금지 파일 쓰기 시도(`UNEXPECTED_TOOL_CALL`, 파일 안 생김)
- 이어서 금지 파일 고정 거절, 고정, 고정본을 `grid-rot21`의 ③ 배치에서 실행(쌍 2개·간격 1.1 m·공통 캡이 ③과 같음)을 확인한다.
- 마지막으로 고정 뒤 턴의 `DRAFT_NOT_OPEN`, DELETE 경로를 확인한다.

## 판정

PLAN-22 T-064의 합격 기준을 충족한다.

- 대화 10턴 안에 점검·시험 통과
- 쌍기둥 판정이 S-06 ③과 같음
- 사람의 코드 수정 없음

다만 결함 ①~④는 이 시험 중에 고친 것이다. 만들기 탭 화면에서 같은 흐름을 돌린 확인과 멈춤 조건 확인은 남았다.
