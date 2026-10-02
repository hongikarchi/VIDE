---
id: RESEARCH-11
title: VIDE 안의 AI와 터미널 Claude Code의 차이 — 원인·물결별 조치·A/B 비교 방법·스킬 이식표
status: draft
version: 0.2
updated: 2026-10-02
owner: agent:claude
related: [FR-25, SPEC-02, ARCH-01, ADR-014, ADR-021, PLAN-24, RESEARCH-10, RESEARCH-04, ADR-029]
---

# VIDE 안의 AI와 터미널 Claude Code의 차이

## 0. 요약

사용자가 2026-09-30에 지적했다. 같은 모델인데도 VIDE 안의 AI가 터미널 Claude Code보다 모델링을 못한다. 원인은 모델이 아니라 AI를 둘러싼 조건의 차이다. 다섯 가지를 확인했다: ① 기본 시스템 프롬프트를 한 줄 지시로 **바꿔 끼웠다**, ② AI가 자기가 만든 것을 **보지 못한다**, ③ 도구 예산과 읽기 범위가 좁다, ④ 이전 대화의 글만 넘어갔다, ⑤ 되물을 수 없었다. ④·⑤는 2~4차 물결에서 고쳤다. ①~③은 5차 물결에서 고친다. 방법은 기본 프롬프트를 유지하고 VIDE 지시 묶음을 **덧붙이는 것**, 캡처·측정 도구, 대화 턴 상한 상향이다. 사용자의 이전 Rhino 스킬 9종(RESEARCH-04 출처 S-09)의 노하우는 이 묶음 안으로 옮겼다(§5). 두 환경이 같은 요청에서 얼마나 차이 나는지는 Rhino가 비어 있을 때 §4의 방법으로 잰다. 이 문서는 조사·방법 문서이며, 결정은 ARCH-01 §2와 PLAN-24의 해당 작업이 소유한다.

## 1. 터미널과 VIDE의 차이 [사실]

4차 물결(`c972e23`)까지의 코드와 [RESEARCH-10](RESEARCH-10-vide-restructure.md) §1.1을 기준으로 적는다.

| # | 항목 | 터미널 Claude Code(사용자 환경) | VIDE 안의 AI(4차까지) | 근거 |
|---|---|---|---|---|
| 1 | 시스템 프롬프트 | 기본 시스템 프롬프트, 저장소 `CLAUDE.md`, 사용자 메모리 | `--system-prompt`로 **교체**한다. 도구 없는 턴은 `noToolsInstruction`, 호스트 턴은 `agentInstruction`, 세션은 `neutralInstruction`이며 각각 한 문단이다 | `src/ai/claude-cli.ts` `cliArguments()`·`sessionArguments()`, `src/ai/agent-connection.ts` |
| 2 | skill·plugin·MCP | 전역 설정의 `rhino` MCP, 플러그인, `.claude/skills/*`(S-09 9종) | 모두 끈다: `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`, `--safe-mode` 또는 `--restricted`. 허용 도구는 `mcp__vide__*`뿐이다 | RESEARCH-10 §1.1, §1.2 4행 |
| 3 | 보기 | `capture_viewport`로 화면 이미지를 보고, `measure_objects`·`analyze_objects`로 잰다 | 이미지가 없다. `query`의 쪽 단위 목록과 `execute`의 반환값만 본다 | `src/server/agent-tools.ts` `definitions` |
| 4 | 도구 예산 | 사실상 없다(사용자가 끊을 때까지) | 도구 30회·호스트 명령 12회·180초. 연계 대상이 있으면 60회 | `src/contracts/execution-limits.ts`(4차) |
| 5 | 읽기 범위 | 문서 전체를 자유롭게 조회한다 | `query`는 한 쪽 최대 100개. 다음 쪽은 `nextOffset` + `expectedRevision` | `agent-tools.ts` `page`, `src/server/query-page.ts` |
| 6 | 대화 이어짐 | 한 세션 안의 코드·오류·질문이 모두 남는다 | 이전 요청 6개의 요청문(2,000자)과 최종 답(6,000자)만 다시 보냈다 | RESEARCH-10 §1.1, `src/ai/context-selector.ts` |
| 7 | 되묻기 | `AskUserQuestion` | `--permission-mode dontAsk`라 CLI 질문 도구를 쓸 수 없고, 최종 글로만 물을 수 있었다 | RESEARCH-10 §1.3 |
| 8 | 코드 실행 | MCP로 RhinoScript Python·C#·Rhino 명령(`_SelDup`, `_-Purge`, `_-Export`)을 실행한다 | C# 메서드 본문 하나(`Run(RhinoDoc doc)`)만 실행한다. 명령·`RhinoApp`·파일·UI·리플렉션은 `CodePolicy`가 거절한다. ZWCAD는 `Run(Database db, Transaction tr)`이다 | `hosts/rhino/worker/CodePolicy.cs`, `WorkerExecutor.cs`, `hosts/zwcad/worker/SdkCompiler.cs` |
| 9 | 쓰기 대상 | 사용자가 열어 둔 Rhino 문서에 바로 쓴다 | 작업 사본에 쓰고, 후보를 만든 뒤, 사람이 반영한다(ADR-014). 작업 사본은 미터 단위로 고정하고, `vide-id`가 겹치면 실행 전체가 실패한다 | `WorkerExecutor.cs`, `WorkerScene.Validate` |

8·9행은 의도한 차이다(§3). 1~7행이 품질 차이의 후보다.

## 2. 2~5차 물결에서 바뀐 것

| 물결 | 커밋 | 바뀐 것 | 위 표의 행 |
|---|---|---|---|
| 2차 | `c67bf57` | 대화 세션 서버(T-061): Claude는 `--session-id`/`--resume`으로 이어 실행하고 매 턴 격리 인자를 다시 넘긴다. 이번 턴 규칙은 `turn-rules` 항목으로 보낸다 | 6 |
| 3차 | `6b70f34` | 대화 칩, 구조화 턴 출력과 질문 카드(T-062, 턴당 최대 3개), 대화용 jig 도구 | 6, 7 |
| 4차 | `c972e23` | Codex 세션 이어 실행(SPIKE ④ 재시험 통과), 계정 한도 인계, 대화로 jig 만들기(초안 폴더, 600초·100회), 설치본에서 도구 연결(`origin`) | 6, 7 |
| 5차 | 작업 중(커밋 전) | ① 기본 시스템 프롬프트를 유지하고 VIDE 지시 묶음(`src/ai/instructions/`: 공통·모델링·자료·만들기 + 프로젝트 추가분)을 덧붙인다. Claude는 `--append-system-prompt`, Codex는 `developer_instructions`를 쓴다(ARCH-01 §2). ② S-09 스킬 노하우를 `modeling-rhino.md`·`modeling-cad.md`로 옮긴다(§5). ③ 대화 턴 상한을 도구 100회·호스트 명령 48회·600초로 올린다(`conversationTurnLimits`). 단발 요청은 30회·12회·180초를 유지한다. ④ `query` 쪽 넘김 커서와 이번 턴 값(targetRef·열린 jig·연결 파일)을 규칙에 싣는다. ⑤ 보기 캡처·측정 도구를 추가한다(도구 이름과 입출력은 ARCH-01 §3) | 1, 2, 3, 4, 5 |

5차 행은 이 문서를 쓰는 시점에 진행 중인 작업이다. 완료 여부와 증거는 [PLAN-24](../plans/PLAN-24-ai-conversations.md)의 「지침 묶음·AI 동등성」 작업과 현황에서 확인한다.

## 3. 남겨 두는 차이 [결정 반영]

- **격리는 유지한다.** 공급자 skill·plugin·전역 MCP·개인 설정은 계속 끈다. 켜면 AI가 사용자가 열어 둔 Rhino에 직접 써서 작업 사본·후보·반영을 우회한다(RESEARCH-10 §1.2 4행). 필요한 skill은 내용을 묶음 안으로 옮긴다.
- **쓰기 경로는 작업 사본 → 후보 → 반영이다(ADR-014).** 터미널처럼 열린 문서에 바로 쓰지 않는다. ZWCAD 직접 편집은 기존 규칙(SPEC-02)을 그대로 따른다.
- **Rhino 명령은 쓰지 않는다.** `_-Purge`·`_-Export`·`_SelDup`이 맡던 일은 RhinoCommon으로 대신하거나 보고만 한다. 내보내기 실행은 사용자의 동작이다. (2026-10-02 [ADR-029](../decisions/ADR-029-rhino-commands-python.md)로 대체: 자동 모드의 열린 Rhino 문서에서는 AI가 Rhino 명령과 Python 3도 실행한다.)
- 모델·effort 선택은 Jev가 정한 대로 둔다(RESEARCH-10 §8.3).

## 4. A/B 비교 방법(Rhino가 비어 있을 때 실행)

**목적.** 5차 물결 뒤 VIDE 모델링 대화(B)가 터미널 Claude Code(A)와 같은 요청에서 얼마나 차이 나는지 잰다. 결과는 `docs/tdd/VERIFY-YYYY-MM-DD-ai-parity.md`에 남긴다.

**조건.**
- A: 사용자의 터미널 Claude Code. 사용자 환경의 `rhino` MCP와 S-09 스킬을 켠다.
- B: VIDE 모델링 대화. 5차 지시 묶음, 캡처·측정 도구, 대화 턴 상한을 쓴다. 개발 엔진(`npm run dev`)에서 돌리고 설치본(47821)은 쓰지 않는다.
- 같은 모델·effort, 같은 계정 종류를 쓰고, 매번 새 세션으로 시작한다.
- 문서는 합성 `.3dm` 하나를 `.vide/` 아래에 두고, 실행마다 원본에서 새로 복사한다. 사용자의 원본 파일이나 실제 프로젝트 자료는 쓰지 않는다. A는 열린 문서에 바로 쓰므로 A도 이 사본에서 돌린다.
- 에이전트는 Rhino를 띄우지 않는다. 사용자가 Rhino를 쓰지 않는 시간에 사용자가 실행하거나 실행을 허락한다(AI.md §8).
- 요청마다 A·B를 두 번씩 돌리고 순서를 번갈아 바꾼다(ABBA).

**요청 5개(합성, 정답을 미리 만든다).**

| # | 요청(사용자 말) | 합성 문서에 심는 것 | 정답 판정 |
|---|---|---|---|
| R1 | "겹친 선 정리해 줘" | 같은 경로의 Line·Nurbs 쌍 20개, 부분 겹침 10개, 안에 들어간 조각 10개, 끝만 닿는 선 10개 | 남는 선의 수와 덮인 길이가 정답과 같고 구멍이 없음 |
| R2 | "터진 모서리 붙이고 짧은 선 합쳐 줘" | 끝점 간격 2~15 mm인 모서리 12개(문서 허용 오차 1 mm), 짧은 조각 8개, 떨어진 짧은 선 3개 | 닫힌 모서리 12개, 떨어진 선은 보고만 함 |
| R3 | "이 대지 경계 안에 4층 매스, 층고 3.6 m, 경계에서 2 m 띄워서" | 닫힌 대지 경계선 하나 | 닫힌 솔리드, 높이 14.4 m, 경계와의 거리 ≥ 2 m(허용 1 mm) |
| R4 | "그리드 교차점마다 600각 기둥, 층고 3.6 m" | X 6줄 × Y 4줄 그리드 선(8.4 m 간격) | 기둥 24개, 단면 0.6 × 0.6 m, 높이 3.6 m, 기둥 레이어 |
| R5 | "열린 폴리서피스 찾아서 닫을 수 있는 건 닫아 줘" | 닫힌 솔리드 6개, 터진 솔리드 4개, 일부러 열어 둔 면 3개 | 4개 닫힘, 3개는 보고만 함, 다른 객체는 변경 없음 |

**측정값.**

| 측정 | 정의 | 수집 |
|---|---|---|
| 성공 | 정답 판정 항목을 모두 통과(통과/실패, 항목별 기록) | 합성 문서를 스크립트로 판정. B는 반영 전의 후보를 판정 |
| 수정 요청 수 | 정답에 이르기까지 사용자가 더 보낸 말의 수(최대 3번, 넘으면 실패) | 실행 기록 |
| 소요 시간 | 첫 전송부터 마지막 답(B는 후보 준비)까지의 벽시계 시간 | A는 터미널 기록, B는 요청 시작·끝 시각 |
| 토큰 | 입력·캐시 읽기·캐시 생성·출력 토큰의 합과 내역 | A는 세션 기록의 `usage`, B는 `stream-json` 사용량(T-059 계측) |
| 도구 호출 | 도구 호출 수와 실패 수 | 두 환경의 도구 기록 |

**합격 기준(제안).** B의 성공 수가 A 이상이다. 수정 요청 수의 중앙값이 A + 1 이하이다. 소요 시간의 중앙값이 A의 1.5배 이하이다. 어긋나는 요청이 있으면 표 1의 어느 행이 원인인지 적고 묶음이나 도구를 고친 뒤 그 요청만 다시 잰다.

## 5. 스킬 이식 대응표(S-09 → 지시 묶음)

원본은 사용자 PC의 Rhino 스킬 폴더(`.claude/skills/*/SKILL.md`와 스크립트, RESEARCH-04 S-09)이다. 읽기만 했고, 프로젝트 파일 이름·경로·모델 이름은 옮기지 않았다. 옮긴 것은 RhinoCommon 사용법과 판정 규칙이다. MCP 로더(`exec(open(...))`), `sc.sticky`, `AskUserQuestion`, SaveAs 사본 묻기는 VIDE의 `execute` 두 단계(진단 → 적용), 질문 카드, 작업 사본으로 바꿨다.

| S-09 스킬 | 옮긴 노하우 | 묶음 위치 | 옮기지 않은 것(이유) |
|---|---|---|---|
| clean-similar-curves | 타입이 달라도 찾는 중복 판정(표본점 + `ClosestPoint`), `GetDistancesBetweenCurves` 금지(부분 겹침 → 구멍), 1차원 구간 분할 규칙, 덮개 조건, 곡선 부분 겹침은 보고만, 좌표 표류 진단. `tjunction_report`의 T자 판정 | `modeling-rhino.md` 「Duplicate curves」「T-junctions」 | IronPython 튜플 처리(C#에서는 해당 없음) |
| clean-similar-objects | 싼 지문(위상 수 + bbox 크기·중심), Extrusion은 `ToBrep()`, 블록은 정의 + 변환, 같은 자리와 다른 자리의 구분, 질량 계산은 후보에만 | `modeling-rhino.md` 「Duplicate solids, meshes and blocks」 | 잠김·숨김 레이어 선택 제외(작업 사본에는 선택이 없음) |
| clean-geometry | Simplify(각도는 라디안) → Tidy(잔차·제어점 조건) → Join(짧은 선이 든 묶음만) → Gap(Fillet 반지름 0) 순서, 거의 직교는 보고만, 새 객체는 가장 긴 원래 선의 속성을 이어받음(`vide-id` 제외) | `modeling-rhino.md` 「Curve cleanup」 | 매개변수 기본값 표(묶음 크기 제한, 규칙만 남김) |
| clean-geometry-solids | `IsSolid`, 떨어진 모서리 수·길이, 복제본으로 `JoinNakedEdges` 시험, 직각 프리즘만 Extrusion 변환, 부피·중심 검증, 400면 초과 건너뜀 | `modeling-rhino.md` 「Solids」 | — |
| clean-rhino | 쓰지 않는 블록 정의·빈 그룹·빈 레이어 정리(깊은 레이어 먼저, 현재 레이어·블록 정의 레이어 제외), 정리 뒤 재질, 흰 무광 PBR은 직접 생성(`CreateBasicMaterial` 금지) | `modeling-rhino.md` 「Document housekeeping」 | `_-Purge` 명령(명령 금지 → 보고만), 전체 파일 파이프라인 순서(요청마다 필요한 단계만) |
| export-common | 형식별 제거 분류 순서(`AnnotationBase`를 `Curve`보다 먼저) | `modeling-rhino.md` 「Preparing exports」 | — |
| export-cad | z=0 평탄화(`PlanarProjection`) + `ToArcsAndLines`(null이면 평탄화한 곡선 유지) | `modeling-rhino.md` 「Preparing exports」, `modeling-cad.md` 「Drawing conventions」 | `_-Export` 방식과 `.ini` 설정(내보내기는 사용자 동작) |
| export-sketchup | NURBS·솔리드 없음, 열린 면은 낱장 면, 객체 하나 = 블록 하나 = 컴포넌트 하나 | `modeling-rhino.md` 「Preparing exports」 | SKP 설정 대화상자(명령이 없어 해당 없음) |
| export-d5 | 매핑 없음 판정(`GetTextureChannels`), 예시 객체 매핑 복사 또는 원점 공용 박스 매핑, PBR 기본색 | `modeling-rhino.md` 「Preparing exports」 | D5 Sync 수동 클릭(VIDE 밖) |

ZWCAD 쪽(`modeling-cad.md`)은 스킬에서 온 내용이 아니다. `hosts/zwcad/`의 코드(`SdkCompiler.cs`, `DwgReader.cs`, `DwgEditor.cs`, `EditorApply.cs`, `connection/AttachedEdit.cs`, `edit-contract.ts`)에서 실행 형식, 단위(`INSUNITS`), VIDE가 읽고 쓰는 엔티티, 반영 때 레이어·선 종류 조건을 추렸다.

## 6. 한계와 남은 질문

- §4의 A/B는 아직 돌리지 않았다. Rhino가 사용 중이라 에이전트가 띄울 수 없다.
- 옮긴 규칙은 S-09에서 실제 Rhino로 검증된 것이다. 하지만 VIDE의 `CodePolicy` 아래에서 모두 돌아가는지는 확인하지 않았다(예: `Rhino.Render` 재질·매핑 API는 금지 목록에 없지만 실행 확인 전이다). A/B의 R1·R5와 별도 합성 실행으로 확인한다.
- 묶음 크기: 모델링 모드에는 공통 + `modeling.md` + 두 노하우 파일(약 11 KB) + 프로젝트 추가분(≤ 8 KB)이 붙는다. 크기 상한과 자르는 순서는 `src/ai/instructions/index.ts`가 정한다.
- 캡처·측정 도구는 `capture_view`·`measure`(Rhino 대상 모델링 턴, 입출력은 ARCH-01 AI 도구 표)로 정해졌고 `modeling.md`의 확인 습관이 이 이름을 쓴다. ZWCAD 대상에는 아직 없다.
