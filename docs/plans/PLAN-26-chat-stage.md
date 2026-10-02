---
id: PLAN-26
title: 대화가 화면과 작업을 이끄는 구조 — skill 시작, 토큰 정리, 셸 정리, 산출물 탭
status: review
version: 0.12
updated: 2026-10-02
owner: agent:claude
related: [ADR-026, ADR-016, ADR-022, ADR-021, ADR-020, SPEC-01, SPEC-02, SPEC-07, ARCH-03, ARCH-01, DESIGN, RESEARCH-12, PLAN-22, PLAN-24, FR-18, FR-24, FR-25, AC-48]
---

# 대화가 화면과 작업을 이끄는 구조 (T-076~T-081, T-089~T-091, T-098~T-101, T-103, T-109, T-110, T-113)

기준: [ADR-026](../decisions/ADR-026-chat-stage-and-skill-jigs.md)(2026-10-01 사용자 결정), 조사는 [RESEARCH-12](../research/RESEARCH-12-ui-chat-driven-structure.md). 진행 상황의 정본은 [PLAN §6.5](PLAN.md)이다.

## 1. 범위와 순서

셸 교체보다 멈춤 해소가 먼저다(ADR-026 결정 7). T-076(skill 시작)과 T-077(토큰·CSS 정리)은 지금 배치 위에서 한다. 대화 열 + 무대로의 셸 전면 교체는 하지 않기로 했다(2026-10-01 사용자): T-078 목업은 검토 결과만 남기고 폐기했고, T-079는 사용자가 명시한 항목만 지금 배치 위에 반영하는 셸 정리로 좁혔다. T-080(층 평면)과 T-081(산출물 탭)은 독립이다. T-099(JIG 한 화면) → T-100(jig 아이콘) → T-101([수정하기])은 같은 날 사용자 요청으로 JIG 화면을 다듬으며, T-099가 T-079의 레일 결정 중 '만들기' 단추를 거둔다.

| 티켓 | 내용 | 선행 | 상태(2026-10-01) |
|---|---|---|---|
| T-076 | 단계 0: skill 시작, skill 카탈로그 로더, AI 도구 `jig_open`·`ui_go`, 공급자 자체 질문 기본 | ADR-026, 이 계획 | 구현·단위·브라우저 시험 완료(2026-10-01). 여러 단계 새 출력 레이어 생성 구현·단위·브라우저 시험·플러그인 Release 빌드 완료(2026-10-02, 설치 전). 남음: Rhino 사본 확인(아래 「실제 Rhino 확인」), 실제 Claude CLI에서 자체 질문+jig 대화 확인, 확신 낮을 때 두 갈래 질문(M6), `summary.kpi` |
| T-077 | 토큰층과 CSS 리터럴 정리 | ADR-026, Design §02 | 완료(2026-10-01): UI CSS 색 리터럴 0, 왼쪽 막대 제거, 선택/초과 색 분리. 남음: 기능용 리터럴(`app.ts` 붓 색 등) |
| T-078 | 대화 열 + 무대 정적 목업과 VERIFY | ADR-026 결정 5 | 종료(2026-10-01): 목업 6판까지 검토 결과(색·글꼴 좋음, 대화 열 오른쪽, 작성기·상태줄 유지, 레일 유지, 홈과 대시보드 분리)를 T-079에 반영하고 목업은 폐기. 이후 화면 검토는 실제 빌드 미리보기 `tools/mockups/ui-preview/snapshot.mjs` |
| T-079 | 셸 정리: 사용자가 목업에서 명시한 항목만 지금 배치 위에 반영 | T-078 검토 | 구현·시험 완료(2026-10-01, 설치 전): 레일 대시보드·프로젝트 자료·피드백(구글폼)·다크/라이트, 대시보드 탭(초안), 연결 파일 행 정리(Live 초록 불·파일에서 열기 유지), lucide 아이콘·Inter/Noto Sans KR/JetBrains Mono 글꼴. 남음: 구글폼 주소(사용자). 대시보드 내용은 2026-10-01 사용자 결정으로 '오늘(할 일·일정)'을 맨 위에 두기로 했다(T-098). 작업공간 탭 줄·왼쪽 패널 제거는 하지 않음. 레일·위쪽 줄 역할 나눔(2026-10-01 사용자 결정): 레일이 고정 화면(대시보드·모델·작업 이력·자료·JIG·산출물)을 맡고 위쪽 줄은 열린 작업본만, 열린 것이 없으면 숨김 — 구현·시험 완료(browser-workspace-tabs). 레일의 '만들기'는 같은 날 사용자 요청으로 JIG에 합쳤다(T-099) |
| T-080 | 층 평면 보기: 층 해석 + 뷰포트 단면 자르기 | SPEC-02.17 보완 | 대기 |
| T-098 | 대시보드의 할 일과 일정(맨 위 '오늘', AI 도구 `agenda_*`와 [되돌리기]) | SPEC-01.14, T-079의 대시보드 내용 결정 | 구현·단위·브라우저 시험 완료(2026-10-01, 설치 전). 남음: 실제 Claude·Codex로 '회의록에서 할 일 뽑아줘' 확인(설치본 릴리스 때) |
| T-081 | 산출물 탭: 도면·보고서·렌더링을 한 탭에 (지금은 페이지만) | 사용자 요청 2026-10-01 | 페이지 구현·브라우저 시험 완료(2026-10-01, 설치 전). 남음: 도면 시트·생성형 렌더링 기능(각각 SPEC 먼저) |
| T-099 | JIG 한 화면: 레일의 만들기를 JIG에 합침, 목록 끝의 [새로 만들기] 카드, 작성 중 초안 카드, jig 하나에 카드 하나 | 사용자 요청 2026-10-01 | 구현·단위·브라우저 시험 완료(2026-10-01, 설치 전) |
| T-100 | jig 아이콘: 정해 둔 목록에서 고르는 `jig.json`의 `icon`, 카드·문맥 탭·대화 칩·대시보드에 표시 | T-099 | 구현·단위·브라우저 시험 완료(2026-10-01, 설치 전) |
| T-101 | [수정하기]: 고정한 jig의 사본 초안(같은 id·버전 +0.0.1) → 다시 고정 → 작업본 [올리기] | T-099 | 구현·단위·브라우저 시험 완료(2026-10-01, 설치 전). 단계가 jig 밖을 가져오는 저장소 jig(S-06)는 사본을 만들지 않는다(검토 지적 반영) |
| T-110 | 대시보드 달력: '오늘'의 [목록 \| 달력], 이 프로젝트의 한 달 보기, 할 일 종류(할 일·회의·마감, schema 8) | T-098, 사용자 결정 2026-10-02 | 구현·단위·브라우저 시험 완료(2026-10-02, 설치 전). 주 보기·구글 캘린더·여러 프로젝트 달력은 하지 않음 |
| T-103 | 작성기의 대상 파일 칩·연계 대상 창 폐지: 고칠 연결 파일은 AI가 정하고, 다른 파일의 핀도 변경 핀 | ADR-027, 사용자 질문 2026-10-02 | 구현·단위·브라우저 시험 완료(2026-10-02, 설치 전) |
| T-109 | 작업 이력 정리: 요청 목록만 남기고, 검토본은 산출물의 보기로, 외부 의견은 산출물 머리의 배지 단추로, 참고 자료 목록은 없애고 첨부는 작업 보기에서 | 사용자 결정 2026-10-02 | 구현·브라우저 시험 완료(2026-10-02, 설치 전) |

`src/ui/app.ts`·`src/ui/style.css`는 여러 세션이 함께 고친다. 티켓마다 깨끗한 worktree에서 작업하고 자기 파일만 스테이징한다. 커밋·설치본 릴리스는 사용자 요청이나 웨이브 경계의 판단에 따른다.

<a id="t-076"></a>
## T-076 · 단계 0 — skill 시작, 카탈로그, AI 도구, 자체 질문

**목적·기준:** 요청이 jig로 판정되면 카드에서 멈추지 않고 작업본을 열고 계산까지 한다. FR-24·25·18, AC-48, ADR-026 결정 4·6, SPEC-02.17의 1~4, SPEC-02.19의 1·3·6·7, SPEC-02.20의 2, SPEC-07.4·07.18, ARCH-03 §5.3·§9.5, RESEARCH-12 §6.2~§6.3·§7.2 단계 0·2·3.

**변경 범위**

| 대상 | 변경 |
|---|---|
| `src/ui/skill-catalog.ts`(있음), `src/server/skill-catalog.ts`(신설) | 앞머리 파서·정렬·후보(순수 부분)와 패키지의 `skill.md`·`jig.json` 읽기. 프로젝트 → 이 PC → 공식 순, `invocation: 'auto'`만 후보 |
| `src/ui/request-route.ts`, `src/ai/request-router.ts` | 카탈로그를 판정 후보로. 하드코딩 `OFFICIAL_JIG_ROUTING`·`officialJigs`는 대체로. 같은 말이면 프로젝트 jig 우선. `from_request` 값 읽기와 `paramFor`의 여러 값 |
| `src/ui/app.ts`(jig 분기 `runAppRoute`), `src/ui/jigs.tsx` | `startSkill(jigId, request, mode)` 한 경로: 작업본 재사용·기본 `layerRoot`로 생성 → 문맥 탭 → 대화 묶기 → 원장·판정 기록 → `from_request` 적용 → `preview` 자동 계산 → 결과 요약. 요청 글을 지우지 않는다. [일반 대화로](SPEC-02.17의 3). 계획 모드는 재사용·묶기까지와 체크리스트·[진행] |
| `src/server/conversations.ts` | 대화의 `jigInstanceId` 묶기(SPEC-02.19의 1의 규칙), 서로 가리키는 줄 |
| `src/server/agent-tools.ts`, `src/ai/agent-connection.ts` | `jig_open`·`ui_go` 발급, 계획 모드 도구 집합(`PLAN_MODE_TOOLS`)에 두 도구 추가, `jig_set`·`jig_run`은 계획 모드 제외 유지 |
| `src/jigs/runtime/manifest.ts`, `src/server/jig-routes.ts` | `open`·`autorun`·`from_request`·`summary` 허용(`.strict()` 유지), skill 시작 작업본은 출력 레이어 없이 열고 만들기 때 `LAYER_ROOT_MISSING`으로 묻기 |
| `src/contracts/layer-path.ts`, `src/jigs/runtime/runtime.ts`, `src/jigs/bake/templates/*.cs`, `hosts/rhino/worker/LayerPaths.cs`·`EditorApplication.cs` (2026-10-02) | 출력 레이어 존재 검사 제거(`LAYER_PATH_INVALID` 글자 검사만), 틀과 원본 반영이 여러 단계 새 레이어를 단계마다 제 부모 아래 만든다(ARCH-03 §9.5) |
| 질문 어댑터(T-075에서 꺼 둔 것) | 공급자 자체 질문 기능을 기본으로 켜고, 없는 공급자·경로는 VIDE 카드 |
| `extensions/jigs/s06-frame/skill.md`, `jig.json` | `description`·`examples`, `from_request`(예: `spanMax`·`beamSpacing_m`·`layoutSource`), `summary.kpi`. 합성 자료만 |
| 문서 | ARCH-01 §3 도구 목록·계획 모드 도구, SPEC-01.10 단서(다른 세션의 편집이 커밋된 뒤). 구현과 다르면 ARCH-03 §5.3을 고친다 |

**선행·외부 조건:** ADR-026·SPEC·ARCH-03 반영(완료). ARCH-01·SPEC-01은 다른 세션이 편집 중이라 그 뒤에 고친다. 연결 문서에 없는 출력 레이어의 여러 단계 생성은 2026-10-02 구현했다(ARCH-03 §9.5). 바로 적용의 만들기 틀은 엔진 쪽 글이라 엔진 갱신만으로 바뀌고, 원본 반영(`EditorApplication`)은 플러그인 재설치가 필요하다(Rhino를 닫은 뒤).

**검증 — 정상**

- 단위: 새 `tests/core/skill-catalog.test.mjs`(앞머리 파서의 한 줄·블록 목록·블록 문자열, 정렬, `autorunUntil`의 `first-hard`, `layerRootFor`의 번호 비키기), `tests/core/request-route.test.mjs`(S-06 합성 프로젝트에서 "구조 분석"이 `project/s06-frame`, `user-only` 제외, 카탈로그 없을 때 하드코딩 대체), `tests/core/jig-manifest.test.mjs`(새 필드 허용, 모르는 필드 거절), `tests/server/agent-tools-jig.test.mjs`(계획 모드 턴에 `jig_open`·`ui_go`는 있고 `jig_set`·`jig_run`은 없음), `tests/server/conversations.test.mjs`(일반 대화는 묶고 다른 목적 대화는 새 jig 대화 + 상호 링크).
- 브라우저: `browser-route.mjs`에 "구조 분석 해줘"(S-06 합성) → 카드 없이 작업본·문맥 탭이 열리고 `confirmAnalysis` 앞까지 미리보기, 결과 요약과 [일반 대화로]. "구조 분석 해줘, 경간 11로" → `spanMax` 11 m 적용과 [되돌리기]. 계획 모드 → 열리고 계산 없음, 체크리스트 [진행] 뒤 계산.
- 실험: `docs/tdd/SPIKE-2026-10-xx-skill-start.md` — `.vide/` 아래 S-06 사본에서 클릭 수(목표 0), 해석 미리보기까지 걸린 시간, 오판정 되돌리기 1클릭. 판정 정확도는 `SPIKE-…-skill-routing`(사례 20개, 규칙 확정 대비 오판정이 늘지 않음).

**검증 — 실패**

- Jev 키 없음·실패·지연 → `words` 규칙으로도 프로젝트 jig가 열린다. 판정 전송을 끄면 규칙만 쓴다(FR-18).
- 두 jig가 비슷하게 맞음 → 열지 않고 질문 카드. `user-only` jig·초안 → 열지 않고 카드.
- `skill.md` 형식 오류 → 그 jig만 후보에서 빠지고 형식 점검 오류로 보인다.
- 작업본을 만들 수 없음 → 화면을 옮기지 않고 이유와 [JIG 목록에서 열기].
- 자동 계산 중 단계 실패 → 그때까지의 결과와 이유를 요약에 보이고 뒤 단계는 멈춘다.
- [일반 대화로] → 새로 만든 작업본 삭제, 설정값 되돌림, 이전 화면, 같은 글의 AI 턴, 되돌림 기록. 사람이 손댄 작업본은 지우지 않는다.
- 해석 확정·Rhino에 만들기를 AI·자동 계산이 누르지 않는다(도구 목록에 없음, 서버 경계에서 거절).
- 자체 질문 기능이 없는 공급자 → 같은 모양의 VIDE 카드. 원격 세션 → 원래 경로의 제한 그대로.

**실제 Rhino 확인(할 일, Rhino를 닫은 뒤):** `.vide/` 아래 Rhino 사본에서 3단계 새 레이어(예: `VIDE::골조 시험::3층`) 아래로 Rhino에 만들기 → 레이어가 문서 루트가 아니라 제자리에 켜짐·풀림으로 생기고 기존 같은 이름 레이어를 쓰지 않음 → [되돌리기] 한 번에 객체와 새 레이어가 함께 사라짐. 결과는 VERIFY로 남긴다. 원본 반영 경로(후보 적용)의 여러 단계 새 레이어는 새 플러그인 설치 뒤 함께 본다.

**완료:** S-06(합성·사본)에서 "구조 분석 해줘"가 누르지 않고 미리보기 결과까지 가고, [일반 대화로] 한 번으로 복구되며, 위 단위·브라우저 시험이 통과한다. ARCH-03 §5.3·ARCH-01 §3이 코드와 맞는다. PLAN §6.5를 갱신한다.

<a id="t-077"></a>
## T-077 · 토큰층과 CSS 리터럴 정리

**목적·기준:** 무채 웜 그레이 + 고정 코랄 하나로 화면을 정리하고, 이후 셸 교체가 토큰 위에서 일어나게 한다. ADR-026 결정 1~3, [Design §01·§02](../../Design.md), RESEARCH-12 §2.2·§3·§7.2 단계 1·5. 기반 작업이므로 새 FR은 없다(화면 표현 FR-19·22의 Design 기준).

**변경 범위**

| 대상 | 변경 |
|---|---|
| `src/ui/tokens.css`(있음) | Design §02의 토큰과 이전 이름 별칭. 어두운 값은 호스트 패널 테마(`data-theme='dark'`)에만 |
| `src/ui/style.css`, `kit/kit.css`, `report-tab.css`, `conversations.css`, `facts-tab.css`, `make.css`, `question-card.css` | 16진 색·모서리·그림자 리터럴을 토큰으로, 요소별 어두운 규칙을 토큰 재정의로, 10px 이하 글자 제거, 선은 `--hairline`, 탭 구현 여러 벌을 하나로(가능한 범위) |
| 왼쪽 색 막대 7곳(`report-tab.css:70`, `kit/kit.css`) | 옅은 바탕 + 굵기로 |
| `src/ui/structure-jig.tsx`, `src/ui/viewport.ts` | 판정색을 `--ok`·`--warn`·`--ng`로 통일, 뷰포트 선택색·바탕을 `--accent`·`--bg-recessed`에 맞춤 |

**선행·외부 조건:** 없음(Design §02 반영 완료). `style.css`를 고치는 다른 세션과 겹치지 않게 파동을 나눈다.

**검증 — 정상:** `npm run verify`와 기존 브라우저 시험 전체 통과. 1440·900px와 호스트 패널 폭(약 300px), 밝은 값·호스트 패널 어두운 값의 화면 캡처를 VERIFY에 남긴다. 토큰 밖 16진 색·모서리·그림자 개수를 세어 기록한다(목표: 뷰포트 색 상수 같은 이유 있는 예외만).

**검증 — 실패:** `--accent`를 작은 글자에 쓴 곳이 없는지(대비 부족), 선택과 초과가 모양으로도 구분되는지(어두운 값에서 `--ng`와 `--accent`가 가까움), 왼쪽 색 막대가 남지 않았는지(`border-left`에 색이 있는 규칙 검색), 한 화면의 포인트 요소가 허용 위치 밖에 없는지.

**완료:** 위 검사 결과와 캡처를 `docs/tdd/VERIFY-2026-10-xx-tokens.md`에 남기고 PLAN §6.5를 갱신한다.

<a id="t-078"></a>
## T-078 · 대화 열 + 무대 정적 목업과 검수 — 종료

**목적·기준:** 셸 교체 전에 구조와 토큰 방향을 사용자가 화면으로 고른다. ADR-026 결정 5·7, RESEARCH-12 §6.1·§6.2.

**결과(2026-10-01):** 정적 목업을 6판까지 사용자가 검토했다. 고른 것: 색·글꼴은 좋음, 대화 열은 지금처럼 오른쪽, 작성기(첨부·요청 목록·보내기·계획/자동·모델·추론 강도)와 상태줄은 지금 형식 유지, 레일 유지, 홈(모든 프로젝트)과 대시보드 분리. 버튼·입력·간격 같은 세부 요소는 지금 VIDE 것을 쓴다. 목업이 실제 코드와 달라 무엇이 구현됐는지 헷갈린다는 사용자 판단으로 목업 코드는 폐기했고(Git 이력에 남음), 별도 목업 VERIFY는 만들지 않았다. 검토 결과는 T-079에 반영했다. 이후 화면 검토는 `npm run build:web` 뒤 `node tools/mockups/ui-preview/snapshot.mjs`가 만드는 실제 빌드 미리보기(예시 데이터, 화면별 DOM·CSS, 3D는 그림)로 한다(3a9617f).

<a id="t-079"></a>
## T-079 · 셸 정리: 사용자가 명시한 항목만 지금 배치 위에

**목적·기준:** ADR-026 결정 5의 2026-10-01 조정 — "지금까지 내가 확실히 수정해달라고 한 것들 제외하고는 지금 코드베이스를 바탕으로". 한 번에 크게 바꾸면 무엇이 바뀌었는지 알기 어려우므로, T-078 검토와 이후 요청에서 사용자가 명시한 항목만 지금 배치 위에 넣는다. Design §03·SCR-03·SCR-18의 갱신은 이 범위를 따른다.

**반영한 항목(구현·브라우저 시험 완료, 설치 전):**

- 레일: 홈(모든 프로젝트) 아래 대시보드(내용은 초안), 프로젝트 자료(프로젝트 DB 화면), 피드백(구글폼), 다크/라이트 전환(`src/ui/theme.ts`, `tokens.css`의 `[data-theme='dark']`), lucide 아이콘, Inter·Noto Sans KR·JetBrains Mono 글꼴. 연결 파일 행 정리(Live 초록 불, 파일에서 열기 유지) — 16eb911.
- 레일·위쪽 줄 역할 나눔(2026-10-01 사용자 결정): 레일이 고정 화면을 고르고 위쪽 줄은 열린 작업본만 보이며 열린 것이 없으면 숨긴다. 왼쪽 패널은 연결 파일과 레이어를 보인다 — 633f694. 이때 레일에 있던 '만들기' 단추는 같은 날 뒤의 사용자 요청("jig 목록이랑 새 jig 만들기는 왼쪽 탭에서 구분할 이유가 없을 듯")으로 T-099가 거두어 JIG 목록의 마지막 카드가 되었다. 이 부분은 T-079의 결정을 고친 것이다.
- 검증: `tests/integration/browser-workspace-tabs.mjs`, `browser-workspace-controls.mjs`, 633f694에서 고친 기존 브라우저 시험들, `tests/server/server.test.mjs`.

**남음:** 구글폼 주소(사용자), 설치본 반영(릴리스 때). 대시보드 내용 결정은 2026-10-01 사용자 결정으로 닫고 T-098로 구현했다.

**하지 않음(사용자가 따로 요청하면 하나씩):** 작업공간 탭 줄·좌측 고정 패널 제거, 대화 스레드 렌더러 통합, 무대 머리 연결 점·⌘K, 선택 줄·결과 서랍, 방금 보낸 요청에만 무대를 옮기는 전환 규칙, 호스트 패널의 대화 열 전용 화면, 좁은 화면 두 장 전환, 모든 jig의 같은 무대 틀.
<a id="t-080"></a>
## T-080 · 층 평면 보기: 층 해석 + 뷰포트 단면 자르기

**목적·기준:** "3층 평면 보여줘"를 AI 없이 VIDE 화면에서 처리한다. FR-25, SPEC-02.17의 1·2(화면 경로), RESEARCH-12 §6.4 ②. 지금 화면 경로에는 평면 동작이 없어 AI로 간다(`request-route.ts`의 `viewActions`).

**변경 범위:** `src/ui/request-route.ts`(화면 동작 '층 평면'과 대상 '층'), 층 해석(레이어 이름 3F·L03·3층 → 호스트 레벨 정보 → 열린 jig의 레벨 설정값), `src/ui/viewport.ts`(위·직교 시점과 층 높이의 단면 자르기, 되돌리기), 결과 한 줄("평면 · 3층(EL +10.2 m) · 위를 잘라 봄 · 되돌리기 · 3D로").

**선행:** SPEC-02.17의 화면 경로에 '층 평면'(층 해석 순서, 후보가 여럿이거나 없을 때의 질문, 호스트 뷰를 바꾸지 않음, 되돌리기)을 먼저 적는다. 층 해석에 쓰는 호스트 레벨 정보가 Sync에 있는지 확인하고, 없으면 레이어 이름과 jig 설정값만 쓴다.

**검증 — 정상:** 단위: 층 이름 해석(3F·L03·3층·지하 1층), 레벨 후보 정렬. 브라우저: 합성 모델에서 "3층 평면 보여줘" → 위 직교 시점과 단면 자르기, 스레드 한 줄, U로 되돌림, Rhino 뷰 그대로.

**검증 — 실패:** 층 후보가 여럿이거나 없음 → 적용하지 않고 후보 2개와 '직접 입력' 질문 카드, 없는 레벨을 예시 값으로 채우지 않음. 원본을 바꾸는 말이 섞이면 화면 경로로 처리하지 않음(SPEC-02.17의 1).

**완료:** 위 시험 통과, 큰 모델에서 자르기의 프레임 시간을 PLAN-18의 기준으로 확인해 VERIFY에 적는다.

<a id="t-081"></a>
## T-081 · 산출물 탭: 도면 · 보고서 · 렌더링

**목적·기준:** 사용자 요청(2026-10-01) — "Output를 만드는 탭은 따로 있는게 좋을 듯. 거기에서 도면(revit sheet처럼)/HTML 보고서/3D 렌더링(생성형 이미지. comfy UI 같은 방식이 좋을라나?) 등을 처리하는거지. 구체적인 기능은 나중에 구현하고, 일단 페이지만 구현해놓자." 보고서의 동작 기준은 그대로 SPEC-07.11·SCR-17(PLAN-22 T-057)이다.

**변경 범위(지금):** 작업공간 탭 '보고서' 자리에 고정 탭 '산출물'(`src/ui/workspaces.ts`). 탭 위쪽의 도면·보고서·렌더링 전환과 프로젝트별 마지막 보기 기억(`src/ui/output-tab.tsx`·`output-tab.css`). 보고서 보기는 기존 보고서 화면(`src/ui/report-tab.tsx`)을 그대로 얹는다. 도면은 시트 목록·빈 A1 가로 시트(표제란 띠)·[새 시트](준비 중), 렌더링은 입력(뷰 캡처 자리·프롬프트·스타일)·정적 노드 흐름(뷰 캡처 → 깊이·선화 → 이미지 생성 → 결과)·결과 갤러리·[생성](준비 중)의 자리만 둔다. 서버 경로는 추가하지 않는다. 보고서로 가던 길(jig 패널의 보고서 동작, AI `ui_go` 'report', 저장된 마지막 탭 'report')은 산출물 → 보고서로 연다.

**나중(별도 SPEC 먼저):** 모델 뷰를 시트에 배치하고 표제란·축척·도면 번호를 붙여 PDF/DWG로 내보내기. 뷰 캡처와 프롬프트로 이미지 생성 모델을 노드 흐름으로 돌리는 렌더링.

**검증:** `browser-workspace-tabs.mjs`(탭 줄·전환·준비 중 버튼·새로고침 뒤 보기 기억), `browser-report.mjs`(산출물 → 보고서에서 기존 보고서 시험 전체, 저장된 'report' 탭 id가 보고서 보기로 열림, 390 px 가로 스크롤 없음).

**완료(페이지 단계):** 위 시험 통과. 기능 단계의 완료 기준은 해당 SPEC과 함께 정한다.

<a id="t-089"></a>
## T-089 · 첨부 버튼 정리와 경로 기반 첨부(모든 형식·AI 읽기 도구)

**목적·기준:** 사용자 요청(2026-10-01) — 첨부는 파일 위치를 알려 주고 AI가 읽으러 가는 방식이므로 형식을 제한하지 않는다. 첨부(클립) 버튼은 메뉴 없이 파일 선택을 바로 열고, 객체 고정·연계 대상·스케치 그리기는 각자의 자리(선택 막대·대상 파일 칩·뷰포트 연필)에 둔다(사용자 추가 지시 2026-10-01). 동작 정본은 [SPEC-01.12](../specs/SPEC-01-project-input-sync.md), 보관 위치·요청 필드·도구는 ARCH-01 §3 「첨부 보관과 읽기 도구」.

| 대상 | 변경 |
|---|---|
| `src/contracts/workspace.ts` | `files` 항목: 이전 본문 첨부(`text` ≤ 50,000) 또는 보관 첨부(`id`·`name`·`size`·`type`·`kind`·`path`·`copied`; 지금은 늘 `copied: true`). 한 요청 보관 첨부 20개·합계 500MB, 파일당 200MB |
| `src/server/attachments.ts`(신설) | 프로젝트별 보관(`<데이터>/attachments/<projectId>/<id>.<ext>` + `<id>.json`), 내용 판별, 바이트 구간 텍스트·이미지·안내 읽기, 경로 포함 검사 |
| `src/server/server.ts` | `POST …/attachments?name=`(octet-stream 저장), `GET …/attachments/:a`(이미지 미리보기만), 접수 때 첨부 항목을 보관 기록으로 맞춤, 프로젝트 삭제 때 폴더 삭제 |
| `src/server/agent-tools.ts`, `src/ai/agent-connection.ts`, `src/server/execution.ts` | 도구 `attachment_read`(읽기 전용, 계획 모드 포함). `Execution.provider`가 턴의 범위에 이 요청·같은 대화 첨부만 더하고, 도구가 없던 턴은 이 도구만 발급. 지시문에 첨부 읽는 법 |
| `src/ui/app.ts`, `index.html`, `style.css` | 클립 버튼 = 파일 선택(메뉴 없음), 형식 제한 없는 선택·붙여넣기·끌어 놓기 업로드, 이미지 칩 미리보기, 연계 대상은 대상 파일 칩에서, 선택 막대의 [요청에 고정]은 고정 동작을 직접 부름 |

**선행·외부 조건:** 없음. PDF 본문 추출·3DM 요약은 새 의존성이나 호스트 경로가 필요해 이 티켓에서 빼고 후속으로 둔다. 1MB 넘는 이미지는 서버 의존성 없이 작성기가 축소 보기본을 만들어 보낸다. 말(@언급)로 두 연계 대상을 고르는 경로도 지금은 없어 후속이다.

**검증 — 정상:** 단위 `tests/server/attachments.test.mjs`(보관·같은 내용 한 번·상한·경로 포함·형식 판별·텍스트 구간·이미지 항목·다른 대화 첨부 거절·도구 목록에 `attachment_read`). 브라우저 `browser-workspace-controls.mjs`(클립 버튼이 메뉴 없이 파일 선택, 형식 제한 없는 파일 첨부, 붙여넣은 이미지 → 미리보기 칩, 연계 대상은 대상 칩에서). 전체 `npm run test:browser`·`npm test`·`npm run typecheck`·prettier.

**검증 — 실패:** 200MB 초과·21개째·합계 초과 → 묶음 전체 거절과 이유. 모르는 첨부 ID로 접수 → `INVALID_INPUT`. 이 대화에 없는 첨부 읽기 → `ATTACHMENT_NOT_FOUND`. 이미지 아닌 첨부의 미리보기 요청 → 404.

**완료:** 위 시험 통과와 PLAN §6.5 갱신. 실제 Claude·Codex로 이미지 첨부를 읽는 확인은 설치본 릴리스 때.

<a id="t-090"></a>
## T-090 · 참고 이미지로 의도 확인: 영역 표시 → 이해 확인 → 모델링 반영

**번호:** T-089는 같은 날 진행 중인 첨부 작업(경로 기반 첨부·이미지 읽기 도구 `attachment_read`, SPEC-01.12)이 쓰므로 이 티켓은 T-090이다.

**목적·기준:** 사용자 결정(2026-10-01) — 참고 이미지에서 원하는 부분을 영역으로 짚고, AI가 이해한 것을 말과 말풍선으로 보이고 우리 건물에 입힌 이미지를 빠르게 만들어 확인한 뒤, [맞음]으로 모델링에 반영한다. jig가 아닌 기본 기능. 동작 정본은 [SPEC-09](../specs/SPEC-09-reference-intent.md)(`draft`). 바로 적용은 SPEC-02.11·13·20, ADR-022. 화면 제안은 실제 빌드 미리보기(`tools/mockups/ui-preview/snapshot.mjs`의 '제안 · 마스킹 편집기'·'제안 · 이해 확인').

**선행·외부 조건:** T-089의 경로 기반 첨부와 AI 이미지 읽기 도구(`attachment_read`, 이미지 3.75MB 이하·축소 없음 — 큰 참고 이미지의 축소가 필요하면 이 티켓 (a)에서 함께 정한다). PRD §13·§14에 이 기능의 범위 문장(사용자 결정). Design §03·§14에 참고 이미지 탭·보드·말풍선 표현, ARCH-01에 해석 도구·이미지 작업 인자·저장 경로를 이 티켓의 각 단계 앞에서 적는다. 이미지 작업은 이 PC의 Codex CLI 로그인(이미지 생성 확인됨, API 키 없음)을 쓴다.

| 단계 | 내용 | 검증 — 정상 | 검증 — 실패 |
|---|---|---|---|
| (a) 편집기·보드 틀 | 첨부 이미지의 [영역 표시] → 위쪽 줄 '참고 이미지 · <파일>' 탭(`workspaces.ts`의 문맥 탭 종류 추가), 붓·올가미·사각형·지우개, 영역 A·B·C…(개수 제한 없음)와 메모, Ctrl+Z, 이미지 좌표 저장. 보드 두 칸 틀과 SPEC-09.5 상태 표시(예시 자료) | 단위: 영역 좌표 변환·되돌리기 스택. 브라우저: 탭 열기·닫기·다시 열기 뒤 영역 유지, 1440·900 px | 이미지가 아닌 첨부에 [영역 표시] 없음, 큰 이미지(8000 px) 축소 표시, 영역 없음 = 전체 |
| (b) 해석·말풍선 | AI 해석 도구(정해진 모양, SPEC-09.4)와 말 답변, VIDE가 그리는 말풍선 겹침, 말풍선 눌러 고치기 → 그 영역만 다시(판 번호) | 단위: 해석 모양 검사, 다른 영역 고정. 브라우저(가짜 공급자): 말풍선 두 개, B만 고쳐 B만 바뀜. Claude·Codex 각 한 번 실제 확인 | 모양 틀림·영역 id 불일치 → 말 답변만과 [다시 확인], 이미지 못 읽는 모델 → [이해 확인] 끔 |
| (c) Codex 이미지 작업 | 한 장에 한 번 `codex exec`(세션 없음), 입력 = 뷰 캡처 + 영역 겹침 참고 이미지 + 지시문, 결과를 산출물로 복사, 시간 제한 1분·취소·실패 구분, 첫 생성 알림, 프로젝트 설정 끄기 | SPIKE: 시간·크기·성공률(합성 파사드 5장). 브라우저(가짜 작업): 말풍선 먼저 → '생성 중' → 이미지 | Codex 없음·로그인 안 됨·한도·거절·결과 없음·시간 초과·취소 각각 이유와 [다시 생성], 원격 세션에서 실행 안 함 |
| (d) 확정 → 모델링 | [맞음 → 모델링 반영]이 확정 해석을 자동 모드 다음 턴으로 보냄, 대상 '모름'이면 질문 카드, 판 고정과 원장 기록, [새 판으로 고치기] | 브라우저(가짜 공급자): 자동 모드 턴의 입력에 판·영역·값·출처. `.vide/` 사본의 Rhino에서 루버 생성 → [되돌리기] 한 번 | 대상 모름 → 실행 전 질문, 보호 동작은 SPEC-02.13의 4 그대로 |
| (e) 보내기 전 확인(SPEC-09.11) | 이미지 첨부 + 참고 의도 말이면 보내기 대신 한 줄 카드 [영역 표시] [그냥 보내기]. 본문의 이미지·이미지 폴더 경로는 이름 목록(앞 24개)에서 골라 첨부로 복사 → 참고 이미지 탭. 보낸 요청의 작업 보기 이미지 첨부에 [영역 표시](SPEC-09.2의 2). 엔진: `POST …/attachments/path-images`·`…/attachments/from-path`(`src/server/attachment-paths.ts`, 금지 위치·비밀 파일 제외, 원격 거절) | 브라우저: 이미지 + '이런 느낌으로' → 카드, [그냥 보내기]로 전송, 경로 → 목록 → 고르기 → 첨부 칩과 참고 이미지 탭. 단위: 의도 말·경로 후보 추출, 폴더 목록·복사 | 이미지 아닌 첨부만 → 카드 없음, 이미지 없는 경로 → 그대로 전송, `.ssh` 아래·원격 세션 → 거절 |

**상태(2026-10-01):** (a)~(d) 구현·단위·브라우저 시험 완료(커밋·설치 전).
- (a) 이미지 칩의 [영역 표시] → 위쪽 줄 '참고 이미지 · <파일>' 탭(문맥 탭 `reference`), 붓·올가미·사각형·지우개, 영역 A…Z·AA…와 메모, Ctrl+Z/Ctrl+Shift+Z, 영역은 이미지 비율 좌표 벡터로 엔진에 저장, [이해 확인]이 영역을 그린 입력 이미지를 저장.
- (b) [이해 확인]은 작성기의 모델(대화의 고정 AI)이 이미지를 읽을 때만 켜진다(`/models`의 `images`: Claude 전부, Codex는 `models_cache.json`의 `input_modalities`). 같은 대화에 `reference` 요청(호스트 없음·계획, 입력 이미지 한 장 + 원본은 `attachment_read`)을 보내고, 구조화 출력의 `reference`(SPEC-09.4)를 엄격히 검사해 판을 만든다. 보드는 VIDE가 그리는 말풍선(겹치지 않게 놓는 `reference-bubbles.ts`, 인출선), 읽은 값 표(출처 추정·사용자·모름), 상태 줄. 말풍선을 누르면 한 줄 고침 → 그 영역만 다음 판(다른 영역은 서버가 이전 판 그대로 둠). 묶인 대화의 일반 턴이 영역을 짚어 고치면 그 턴이 본 보드에 그 영역만 새 판(호스트 없는 턴은 구조화 출력, 작성기의 계획·자동 턴은 답 끝의 json 블록을 엔진이 빼서 검사). 모양이 틀리면 판 없이 '말풍선을 만들지 못했습니다 · [다시 확인]'.
- (c) 새 판마다 `codex exec` 한 번(세션 없음, `src/server/reference-image.ts`): 3D 뷰 캡처 + 입력 이미지 + 해석, 시간 제한 60초·[생성 취소]는 프로세스 트리 종료, 실패 구분과 [다시 생성], 결과를 `<data>/outputs/<p>/reference/<a>/v<N>.png`로 복사, 걸린 시간 표시, 프로젝트 설정 끄기, 원격 요청은 실행 안 함, 첫 생성 안내. 실측(이 PC, 합성 뷰·참고 이미지, `model_reasoning_effort=low`): 43.6·33.3·38.1초, 모두 1분 안. `code_mode_host`를 끄면 이미지 도구가 꺼진다는 것을 확인해 이 작업만 켬(ARCH-01 §3).
- (d) [맞음 → 모델링 반영]은 대상 '모름' 영역을 VIDE 질문 카드로 먼저 묻고, 확정 판(판·영역·값·출처·대상, 마지막 생성 이미지)을 같은 대화의 다음 턴으로 자동 모드에 보낸다(계획 모드여도). 판은 고정, [새 판으로 고치기]가 다음 판으로 잇는다.
- 시험: `tests/server/reference-interpret.test.mjs`(해석 모양·스키마, 판 번호와 다른 영역 고정, 가짜 codex로 성공·로그인·한도·결과 없음·시간 초과·취소, HTTP로 판 1→판 2→문제→대상 모름 409→자동 확정→고정·이어 가기→말로 고친 판), `tests/core/reference-bubbles.test.mjs`(겹침 없음), `tests/integration/browser-reference-image.mjs`(가짜 공급자로 보드 채움, 생성 중 → 이미지, 말풍선 B 고침 → 판 2, 질문 카드 → 자동 턴, 1440·900 px, 다크).
- 검토 반영(2026-10-01): 요청이 저장된 뒤에만 보드에 답하는 중·확정을 기록(거절되면 보드 그대로), 확정 판의 두 번째 [맞음]은 `REFERENCE_FROZEN`, 답하는 중에는 영역·입력 이미지 저장 거절과 [영역 고치기]·[다시] 비활성, 원격 요청 표시(`input.remote`)로 말로 고친 판도 이미지 작업 없음, 시간 초과·취소는 프로세스 종료를 기다린 뒤 작업·thread 폴더 정리, 엔진 종료 때 이미지 작업 종료, [맞음] 턴에 영역 그린 참고 이미지·원본·영역 상자 포함(본문 12KB 상한), 설정을 끄면 진행 중 작업도 '꺼짐'이고 다시 켜면 [다시 생성], [새 판으로 고치기]는 이미지 상태를 그대로 이음, 영역 고치기 실패는 [A만 다시]·중단은 '중단함', 설정 → AI 연결에 '참고 이미지 확인' 안내·스위치. 시험 추가: `reference-interpret.test.mjs`(블록 추출, 본문 상한, 거절·중복 확정, 답하는 중 저장 거절, 턴이 본 보드, 원격 판, 설정 끄기·이어 가기·엔진 종료, 거절 코드·정리), 브라우저(연결된 모델 없음 판, [A만 다시], 설정 스위치).
- 실제 CLI(2026-10-01, 이 PC 기본 로그인): 해석 턴 한 번씩 Claude 20.3초·Codex 23.8초 통과, `reference` 필수 스키마 그대로 받아들임(수정 없음).
- (e) 2026-10-02 사용자 결정(요청만으로 탭을 열지 않고 보내기 전에 묻기): SPEC-09.11 작성·구현(커밋·설치 전). 작성기 위 카드(`src/ui/reference-check.ts`·`.css`, `#route-card` 자리), 경로 이미지 목록·복사(`src/server/attachment-paths.ts`, 데이터 폴더·키 폴더·비밀 파일 제외, 원격 거절, 큰 이미지는 작성기가 보기본을 만듦), 작업 보기 이미지 첨부의 [영역 표시](`work-view.tsx`). 시험: `tests/server/attachment-paths.test.mjs`(의도 말, 경로 후보, 폴더 목록·정렬, 복사·거절), `browser-conversations.mjs`(이미지 + '이런 느낌으로' → 카드, [그냥 보내기] 전송, 보낸 요청에서 탭 다시 열기, 텍스트 첨부는 카드 없음, 폴더 경로 → 목록 → 고르기 → 첨부와 탭, `.ssh` 거절) 통과. 남음: 실제 설치본에서 사용자 폴더로 한 번 확인.
- 남음: 말로 고치기의 실제 CLI 확인(호스트 없는 턴의 `reference` null 허용 스키마, 작성기 턴의 답 끝 블록), 실제 Rhino 사본으로 SPEC-09 「완료 기준」과 VERIFY, 대화 카드에서 보드 다시 열기(작업 보기 첨부의 [영역 표시]는 (e)), 8000 px 실제 이미지, Design §03·§14 표현, PRD 범위 문장, 여러 이미지 비교(뒤로 미룸).

**완료:** SPEC-09 「완료 기준」을 실제 Rhino 사본으로 한 번 통과하고 VERIFY에 남긴다. PLAN §6.5에 상태를 적는다.

<a id="t-091"></a>
## T-091 · 프로젝트 폴더와 AI의 파일 읽기(폴더 밖은 권한 질문)

**목적·기준:** 사용자 결정(2026-10-01) — 대시보드에서 프로젝트에 해당하는 폴더를 정하고, AI는 그 안의 파일을 엔진 경유 읽기 전용 도구로 읽으며, 밖의 파일은 읽으려 할 때 권한 질문([이번만] [이 폴더는 항상] [거절])을 보낸다. 동작 정본은 [SPEC-01.13](../specs/SPEC-01-project-input-sync.md)과 SPEC-02.19의 7, 저장·경로·도구·금지 목록은 ARCH-01 §3 「프로젝트 폴더와 파일 읽기 도구」, 화면은 Design §03 「대시보드의 프로젝트 폴더」. 경로 없이 붙여넣은 내용은 T-089의 복사 첨부 그대로다.

| 대상 | 변경 |
|---|---|
| `src/core/migrations.ts`, `src/core/project-folders.ts`(신설), `src/core/store.ts` | schema 6 `project_folders`, 목록·추가·빼기, 프로젝트 삭제 때 행 삭제 |
| `src/server/project-files.ts`(신설) | `checkFolder`, `deniedPath`, `FileAccess`(경로 판정·정션 탈출·이번 요청 허락/거절·목록·읽기), 폴더 경로 처리 |
| `src/server/attachments.ts` | 텍스트 구간·이미지·안내 읽기를 공용 `readFileContent`로 분리 |
| `src/server/agent-tools.ts`, `src/ai/agent-connection.ts`, `src/ai/instructions/common.md` | 도구 `file_read`·`file_list`(계획 모드 포함), 오류 코드, 지시문 |
| `src/server/execution.ts`, `src/server/server.ts` | 턴마다 파일 도구를 범위에 더함, 권한 질문(자체 질문과 같은 대기 경로·답 경로, 원격의 '항상'은 이번만), 진행 기록에 경로, `GET·POST …/folders`·`POST …/folders/remove`, 원격은 GET만 |
| `src/ui/dashboard.tsx`, `dashboard.css`, `src/desktop/shell/ShellContext.cs`·`ShellForm.cs` | 대시보드 '프로젝트 폴더' 구역(목록·[폴더 추가]·[빼기]·읽기 허용 폴더), PC 프로그램의 Windows 폴더 선택 창(`folder:pick` 메시지), 브라우저는 경로 입력 |

**선행·외부 조건:** 없음. 실제 Claude·Codex가 권한 질문을 기다리는 동안의 도구 대기 한도(Codex 60초)는 설치본 릴리스 때 확인한다. 셸의 폴더 선택 창은 다음 설치본부터 보이고, 그 전 셸과 브라우저는 경로 입력을 쓴다.

**검증 — 정상:** 단위 `tests/server/project-files.test.mjs`(폴더 더하기·빼기·검사, 안의 파일은 묻지 않고 읽음, 목록 나눠 읽기·패턴, 텍스트 구간·이미지 항목, 밖의 파일 → 질문 → 이번만/항상/거절 각각, 같은 턴의 거절 폴더는 다시 묻지 않음, 원격의 '항상'은 이번만, 진행 기록에 경로). 브라우저 `browser-project-folders.mjs`(대시보드에서 경로로 더하기·빼기, 거절 이유 표시). 전체 `npm test`·`npm run test:browser`·`npm run typecheck`·prettier. 셸은 `npm run desktop:build`로 빌드만 확인.

**검증 — 실패:** 정션으로 폴더 밖을 가리킴 → `FILE_FORBIDDEN`(질문 없음). `.ssh`·`.env`·VIDE 데이터 폴더 → `FILE_FORBIDDEN`(허용 폴더 안이어도). 드라이브 맨 위·데이터 폴더·없는 경로를 프로젝트 폴더로 → `FOLDER_NOT_ALLOWED`·`FOLDER_NOT_FOUND`. 답 없음·턴 중단 → `FILE_ACCESS_DENIED`와 카드 거둠.

**완료:** 위 시험 통과와 PLAN §6.5 갱신. 실제 CLI로 폴더 밖 파일 권한 질문을 한 번 답해 보는 확인은 설치본 릴리스 때.

<a id="t-098"></a>
## T-098 · 대시보드의 할 일과 일정

**목적·기준:** 사용자 요청(2026-10-01) 'Dashboard에 오늘의 할일 / 일정 이런거 적혀있으면 좋을 듯. 편집도 가능하도록.'과 같은 날 추천안 수락 — T-079에 남아 있던 '대시보드 내용 결정'을 닫는다. 동작 정본은 [SPEC-01.14](../specs/SPEC-01-project-input-sync.md), AI 쓰기의 등급은 SPEC-02.19의 7(T1), 저장·경로·도구는 ARCH-01 §3 「대시보드의 할 일」, 화면은 Design §03 「대시보드의 오늘」·SCR-20. 프로젝트별 목록 하나, 일정은 시각이 있는 할 일, 반복·캘린더 연동·장소·참석자·자료에서 찾기 버튼은 이번 범위 밖.

| 대상 | 변경 |
|---|---|
| `src/core/migrations.ts`, `src/core/agenda.ts`(신설), `src/core/store.ts`, `src/contracts/agenda.ts`(신설) | schema 7 `agenda_items`, 더하기·고치기(revision 검사)·순서·빼기·완료 비우기·되돌리기, 프로젝트 삭제 때 행 삭제, 공용 zod 모양 |
| `src/server/agenda-routes.ts`(신설), `src/server/server.ts` | `GET·POST …/agenda`, `PUT …/agenda/:id`, `POST …/agenda/order`·`…/:id/remove`·`…/remove-done`·`…/undo`, 오류 상태(`AGENDA_LIMIT`·`AGENDA_UNDONE` 409). 원격 금지 목록·DELETE 허용 목록은 그대로 |
| `src/server/agent-tools.ts`, `src/ai/agent-connection.ts`, `src/server/execution.ts` | 대화 턴 도구 `agenda_list`(계획 모드 포함)·`agenda_add`·`agenda_set`(원장이 있는 턴만, 원장 `appAction: 'agenda'`), 도구가 있을 때 지시문 한 문장(`agendaInstruction`). 기본 대화는 호스트(모델링) 턴으로 돌므로 `Execution.readAgent`가 대화 안의 호스트 턴에도 같은 처리기를 더한다(검토 지적, 2026-10-01) |
| `src/ui/agenda-text.ts`(신설), `src/ui/dashboard-agenda.tsx`(신설), `src/ui/dashboard.tsx`, `src/ui/dashboard.css`, `src/ui/app.ts` | 날짜·시각 읽기, '오늘' 구역(입력·미리보기·확인란·그 자리 편집·↑↓·끌기·[빼기]·예정·완료 접기), AI 쓰기 안내와 [되돌리기](턴마다 하나, 닫을 때까지 남음) |
| 검토 지적 반영(2026-10-01) | 더한 항목의 되돌리기도 `revision` 검사, 그 자리 편집은 연 때의 판으로 저장(다른 화면의 변경을 덮어쓰지 않음), 입력칸은 저장 중에도 막지 않음(초점 유지), 기본 대화 호스트 턴의 할 일 도구, 한 턴의 쓰기를 안내 하나·[되돌리기] 하나(`ledgerIds`)로 |

**선행·외부 조건:** 없음. schema 7은 이 티켓이 쓴다(같은 웨이브의 다른 티켓은 스키마를 올리지 않는다).

**검증 — 정상:** 단위 `tests/core/agenda-text.test.mjs`(내일 3시·오전 9시 반·금요일까지·다음 주 월요일·10/7 14:00·지난 달은 다음 해·읽지 못하면 그대로), `tests/server/agenda.test.mjs`(더하기·고치기·완료·순서·빼기·완료 비우기, 다른 프로젝트 거절, 프로젝트 삭제와 함께 삭제, HTTP 경로, 원장에 남은 AI 쓰기의 `…/undo`와 두 번째 되돌리기 거절), `tests/server/agenda-tools.test.mjs`(도구 `agenda_add`·`agenda_set` → 원장 → 되돌리기, 사람이 다시 고친 항목은 남김 — AI가 더한 뒤 사람이 고치거나 완료한 항목도, 한 턴에 더하고 고친 항목은 함께 지움, 계획 모드는 `agenda_list`만, 실제 대화 턴과 hostUse 없는 기본 대화 호스트 턴의 `agenda_add` → `…/undo`), `tests/server/remote-http.test.mjs`(원격 세션이 더하고 완료하고 뺌), `tests/core/migrations.test.mjs`(schema 7 표). 브라우저 `tests/integration/browser-dashboard-agenda.mjs`('내일 3시 구조 회의' Enter → 예정 15:00, 느린 저장 중에도 입력칸 초점 유지, 확인란 → '완료 1', 그 자리 편집, 편집 중 다른 화면의 변경은 거절·최신 날짜 위에 다시 저장, ↑와 끌기, 새로고침 뒤 유지, [완료 비우기], [빼기], 기본 대화 한 턴의 두 쓰기 → 안내 하나가 9초 뒤에도 남고 [되돌리기]로 둘 다 되돌림). 전체 `npm test`·`npm run typecheck`·prettier.

**검증 — 실패:** 오래된 `revision`으로 고침·빼기 → `REVISION_CONFLICT`(화면은 최신 목록을 다시 읽음). 없는 항목 → `NOT_FOUND`. 빈 내용·없는 날짜(2/30)·24:00 → `INVALID_INPUT`. 같은 쓰기의 두 번째 [되돌리기] → `AGENDA_UNDONE`. 새로고침 뒤에는 지난 턴의 [되돌리기]를 다시 띄우지 않는다(대화 기록에 남기는 것은 후속). 계획 모드 턴에는 `agenda_add`가 없다.

**완료:** 위 시험 통과와 PLAN §6.5 갱신. 실제 CLI로 '회의록에서 할 일 뽑아줘'를 한 번 해 보는 확인은 설치본 릴리스 때.

<a id="t-110"></a>
## T-110 · 대시보드 달력과 할 일 종류

**목적·기준:** 사용자 결정(2026-10-02) '대시보드 켈린더 좋아요~ 구글 캘린더 연동은 아직. 여러 프로젝트 합친 달력도 아직.'과 같은 날 추천안 수락. 동작 정본은 [SPEC-01.14](../specs/SPEC-01-project-input-sync.md)의 1(종류)·2(종류 읽기)·3(달력)·8(범위 밖), 저장·경로·도구는 ARCH-01 §3 「대시보드의 할 일」, 화면은 Design §03 「대시보드의 오늘」·「대시보드의 달력」·SCR-20. 이 프로젝트의 항목만, 월 보기만. 주 보기·구글 캘린더 연동·여러 프로젝트 달력은 이번 범위 밖.

| 대상 | 변경 |
|---|---|
| `src/core/migrations.ts`, `src/contracts/agenda.ts`, `src/core/agenda.ts` | schema 8: `agenda_items.kind`(`task`·`meeting`·`deadline`, 기본 `task`, CHECK). 열이 끝에 붙어 INSERT는 열 이름을 적는다. 더하기·고치기의 `kind`, 되돌리기 기록의 `kind`(이전 기록은 종류 유지) |
| `src/server/agent-tools.ts` | `agenda_list` 행의 `kind`, `agenda_add`·`agenda_set`의 `kind` 인자와 설명('까지'는 마감, 회의는 회의), 원장 `changes`의 `kind`·`before.kind` |
| `src/ui/agenda-text.ts` | 종류 읽기(날짜·시각 뒤 '까지'·따로 선 '마감' → 마감, '마감재'·'마감 상세' 등 제외, '회의'·'미팅' → 회의, '회의록'·'회의실' 제외), 달력 입력칸의 고른 날짜보다 적은 날짜를 먼저 읽는 `parseAgendaDraft`, `KIND_LABELS`, 달력 도우미 `monthDays`·`shiftMonth`·`monthOf`·`monthLabel`·`dayLabel` |
| `src/ui/dashboard-calendar.tsx`(신설), `src/ui/dashboard-agenda.tsx`, `src/ui/dashboard.css` | [목록 \| 달력] 전환(브라우저 저장소 `vide.agenda.view`), 월 격자(종류 점·짧은 내용·'+n'), 날 누르기 → 그날 목록 + 입력칸 날짜 채움·초점, 다른 날로 끌기 → `PUT {revision, date}`, '날짜 없음' 상자(끌어 놓으면 날짜 비움), 목록 행·미리보기의 종류 표시, 편집의 종류 고르기 |

**선행·외부 조건:** 없음. schema 8은 이 티켓이 쓴다(같은 묶음의 T-107·T-108은 스키마를 바꾸지 않거나 9를 쓴다).

**검증 — 정상:** 단위 `tests/core/agenda-text.test.mjs`(종류: '금요일까지 보고서' 마감·내용 '보고서', '오후 5시까지' 마감, '수요일 설비 미팅' 회의, '회의록 정리' 할 일, '내일부터' 할 일, '외벽 마감재 회의' 회의, '마감재 샘플 받기'·'내부 마감 상세 검토' 할 일, '입찰 마감일은 금요일' 마감; 달력 입력칸 '2026-10-07 금요일까지 보고서' → 금요일 마감, '2026-10-07 설비 미팅' → 고른 날; 달 격자 35·42·28일, 달 넘김·라벨), `tests/server/agenda.test.mjs`(기본 `task`, 회의 더하기, 없는 종류 거절, 날짜만 보낸 고치기는 시각·종류 유지, 종류 고치기, 되돌리기가 기록된 종류를 돌리고 이전 기록은 종류 유지), `tests/server/agenda-tools.test.mjs`(`agenda_add`의 `kind`와 원장 기록, `agenda_set`의 `before.kind`, 되돌리기), `tests/core/migrations.test.mjs`(schema 7 → 8 백업 뒤 기존 행 `task`, 없는 종류 CHECK 거절). 브라우저 `tests/integration/browser-dashboard-agenda.mjs`('내일 3시 구조 회의' 행의 '회의' 표시, [달력] → 날짜 없음 상자, 내일 칸의 회의 점, 오늘 칸 누름 → 입력칸 날짜·초점, '설비 미팅' Enter → 그날 회의, 미리보기의 '마감', 다른 날로 끌기 → 날짜만 바뀜(시각·종류 유지), 날짜 없음 ↔ 날 끌기, 다음 달·[이번 달], 새로고침 뒤 달력 보기 기억). 전체 `npm test`·`npm run typecheck`·prettier.

**검증 — 실패:** 없는 종류 → `INVALID_INPUT`(DB CHECK도 거절). 다른 화면이 먼저 고친 항목을 끌어 놓음 → `REVISION_CONFLICT`와 최신 목록 다시 읽기(SPEC-01.14의 5, 기존 쓰기 경로). 날짜만 채워진 입력칸의 Enter는 아무것도 더하지 않는다.

**완료:** 위 시험 통과와 PLAN §6.5 갱신. 실제 Claude·Codex가 '금요일까지 보고서 넣어줘'에 `kind: 'deadline'`을 주는지는 설치본 릴리스 때.

<a id="t-099"></a>
## T-099 · JIG 한 화면: 목록 끝의 [새로 만들기], 작성 중 초안 카드, jig 하나에 카드 하나

**목적·기준:** 사용자 요청(2026-10-01) — "jig 목록이랑 새 jig 만들기는 왼쪽 탭에서 구분할 이유가 없을 듯 / jig 목록들이 카드처럼 되어있는데 그 끝 칸에 새로 만들기 카드 추가". 같은 날의 T-079 레일 결정에서 '만들기' 단추만 거둔다(T-079 참고). 동작 기준은 SPEC-07.3(출처·수명)·SPEC-07.16의 0(시작), 화면은 Design §03(레일·작업공간 표)·SCR-16·SCR-18. 새 제품 동작은 없고 진입 위치와 목록 표현만 바뀐다.

| 대상 | 변경 |
|---|---|
| `src/ui/index.html`, `src/ui/workspaces.ts` | 레일의 '만들기' 단추를 뺀다. 내부 화면 id `make`는 그대로 둔다(AI `ui_go`·경로 판정의 대상 `make`·`openDraft`가 쓴다). 좁은 화면 메뉴에서도 빼고, `workspaceDestination`이 `make`를 `jig`로 돌려 만드는 동안 레일의 JIG가 눌린 채다 |
| `src/ui/jig-list.ts`(신설, 순수) | `listedTools`: jig id마다 카드 하나 — 이 프로젝트에 고정한 jig는 고정 버전, 여기 고정하지 않은 설치본은 숨김, 고정 안 된 저장소 소스는 그대로, 고정 버전이 등록부에 없으면 그 id의 가장 새 설치본. `openDrafts`: 열린 초안만 |
| `src/ui/jigs.tsx` | 카드 순서: 이 프로젝트의 jig → 공식 → 작성 중 초안 → 맨 끝 [새로 만들기](공식 필터에서는 숨김). '내 초안' 건수(지금은 늘 0), 작업본 행에 버전과 '이전 버전' |
| `src/ui/make-tab.tsx`, `make-api.ts`, `make.css` | [새로 만들기] 카드: 한 문장('무엇을 하는 도구인가요?') + [만들기 시작](시작 본 격자 예제), 보조 링크 [빈 초안에서]. 문장이 초안의 첫 이름이고 이름은 만들기 대화가 고친다. 문장은 만들기 대화의 입력 칸에도 넣어 두며(저절로 보내지 않음, SPEC-07.16의 0), 카드 설명이 그렇게 말한다 — 검토 지적: 예전 설명은 AI가 바로 계획을 보인다고 했지만 대화는 빈 채로 열렸다. `DraftCard`('작성 중', [이어서 만들기]). 만들기 화면 왼쪽 위 [JIG 목록] 링크. 초안 요약에 `state`·`manifest` |

**선행·외부 조건:** 없음.

**검증 — 정상:** 단위 `tests/core/jig-list.test.mjs`(고정 버전 하나, 다른 프로젝트 설치본 숨김, 저장소 소스, 사라진 고정 버전의 대체, 열린 초안만). 브라우저 `browser-make.mjs`(레일에 만들기 없음, 마지막 카드가 [새로 만들기]와 그 설명, 만든 뒤 문장이 만들기 대화 입력 칸에 있고 보낸 요청은 없음, 만들기 중 JIG 눌림, [JIG 목록] → 초안 카드·'내 초안' 1 → [이어서 만들기]), `browser-workspace-tabs.mjs`(레일·좁은 화면 메뉴 목록), `browser-jigs.mjs`(기존 목록·삭제·열기).

**검증 — 실패:** 문장이 비면 [만들기 시작]·[빈 초안에서]가 꺼짐, 초안 만들기 실패는 카드 안 한 줄. 고정·버린 초안은 카드로 보이지 않는다.

**완료:** 위 시험과 `npm test`·`npm run typecheck`·prettier 통과, PLAN §6.5 갱신.

<a id="t-100"></a>
## T-100 · jig 아이콘: 정해 둔 목록에서 고른 `icon`을 카드·탭·칩·대시보드에

**목적·기준:** 사용자 요청(2026-10-01) — "왼쪽 탭 아이콘 스타일로 각 jig마다 아이콘". 사용자 결정(2026-10-01 "추천대로"): 레일과 같은 그림체(lucide, 24 × 24, 선 굵기 2)의 정해 둔 목록(약 30개)에서 고른다. 아이콘은 jig 패키지의 한 값이므로 바꾸려면 초안 → 다시 고정을 거친다(프로젝트별 덮어쓰기 없음). 동작은 SPEC-07.2(구성의 '아이콘'), 물리 계약은 ARCH-03 §3, 화면은 Design SCR-15·SCR-16·SCR-18.

| 대상 | 변경 |
|---|---|
| `src/contracts/jig-icons.ts`(신설) | 아이콘 이름 목록(엔진·화면 공용). 기본 `jig` |
| `src/jigs/runtime/manifest.ts`, `loader.ts`, `runtime.ts` | `icon` 선택 필드(목록 밖이면 형식 점검 오류, `.strict()` 유지), 등록부 항목·작업본 보기의 `jig.icon` |
| `src/server/skill-catalog.ts`, `src/ui/skill-catalog.ts` | 카탈로그 항목의 `icon`(내장 화면 jig는 고정 아이콘) |
| `src/ui/jig-icons.ts`(신설), `src/ui/inspector.ts` | 목록의 lucide 그림과 `jigIconSvg`, 작업본·초안 → 아이콘 기억(대화 칩이 읽음). inspector의 아이콘 표에 합친다 |
| `src/ui/jigs.tsx`, `workspaces.ts`, `conversations.tsx`, `dashboard.tsx`, `make-tab.tsx` | jig 카드 머리, 문맥 탭, 대화 칩(jig 작업·만들기 대화), 대시보드 jig 칸, 만들기 개요의 아이콘과 [아이콘 바꾸기] 목록 |
| `src/server/make-routes.ts` | `PUT …/jig-drafts/:did/icon {icon}` — 열린 초안의 `jig.json` `icon`만 바꾼다 |
| `src/ai/instructions/make.md`, `extensions/jigs/example-grid/jig.json` | 만들기 대화가 목록에서 아이콘을 고른다. 격자 예제는 `grid` |

**선행·외부 조건:** T-099. 내장 화면 jig(Sync·구조 분석·프로젝트 자료)는 `jig.json`이 없어 화면 코드의 고정 아이콘을 쓴다. S-06 v0.3.1은 아이콘이 없어 기본 아이콘이다. S-06은 단계가 저장소 모듈을 가져와 [수정하기] 사본을 만들 수 없으므로(T-101) 아이콘은 S-06 저장소 소스의 다음 버전에서 `jig.json`에 넣는다(PLAN-23 쪽 작업, 이 티켓 밖).

**검증 — 정상:** 단위 `tests/core/jig-manifest.test.mjs`(목록 안 허용, 목록 밖 거절, 없으면 통과), 등록부·카탈로그의 `icon`, `tests/server/make-routes.test.mjs`(아이콘 바꾸기), `tests/core/conversations-ui.test.mjs`(칩 아이콘). 브라우저 `browser-jigs.mjs`(카드·문맥 탭 아이콘), `browser-make.mjs`(아이콘 바꾸기).

**검증 — 실패:** 목록 밖 이름 → `JIG_INVALID`(형식 점검)·경로는 `INVALID_INPUT`, 고정·버린 초안 → `DRAFT_NOT_OPEN`. 화면은 모르는 이름을 기본 아이콘으로 그린다.

**완료:** 위 시험 통과, ARCH-03 §3·§7과 코드 일치, PLAN §6.5 갱신.

<a id="t-101"></a>
## T-101 · [수정하기]: 사본 초안 → 같은 id·올린 버전으로 다시 고정 → 작업본 [올리기]

**목적·기준:** 사용자 요청(2026-10-01) — "카드에 Jig 수정하기: 어떤 input을 받아서 어떤 방식으로 처리해서 어떤 결과물을 내는지 보여주고 사용자가 수정해서 디벨롭". 사용자 결정(2026-10-01 "추천대로"): 설치·공식 jig는 제자리에서 고치지 않고 [수정하기]가 이 프로젝트의 초안으로 사본을 만든다(SPEC-07.3 '버전은 바꾸지 않는다'). 사본은 같은 jig id에 더 높은 버전(예: S-06 v0.3.1 → v0.3.2)이고, 다시 고정하면 이 프로젝트 목록에서 앞 버전을 대신한다. 열린 작업본은 [올리기]로만 새 버전으로 옮긴다(SPEC-07.4). 입력 → 단계 → 결과는 만들기 화면의 개요가 jig.json에서 읽어 보인다(따로 보는 화면을 두지 않음). 동작은 SPEC-07.3·07.4·07.16의 0, 경로는 ARCH-03 §7, 화면은 Design SCR-16·SCR-18.

| 대상 | 변경 |
|---|---|
| `src/jigs/runtime/drafts.ts` | `fork()`: 고른 패키지의 파일을 새 초안 폴더로 복사(쓰기 가능, 경로 규칙·금지 파일 검사 그대로), id 유지, 버전 = 그 id의 설치본·열린 초안·원본 가운데 가장 높은 버전 + 0.0.1(사람·AI가 초안에서 더 올릴 수 있음), 출처(`origin`)는 초안 폴더 밖 `.results/<did>.json` |
| `src/server/make-routes.ts` | `POST …/jig-drafts`의 `from`이 `{jig, version?}`이면 등록부에서 그 버전(없으면 이 프로젝트의 고정 버전)을 찾아 사본을 만든다. `project/` jig만 |
| `src/jigs/runtime/compute-box.ts`, `drafts.ts`, `src/server/jig-routes.ts` | 사본은 계산 상자에서 돌므로 단계 소스의 import가 패키지 파일·공식 라이브러리 밖이면(S-06의 저장소 상대 경로·`node:crypto`) `fork()`가 `JIG_NOT_FORKABLE`로 거절한다. 판단(`outsideBoxImports`)은 상자의 모듈 규칙(`boxImportTarget`)을 같이 쓰고, 등록부 목록은 도구마다 `forkable`을 싣는다 |
| `src/jigs/runtime/runtime.ts`, `src/server/jig-routes.ts` | `upgrade()`와 `POST …/jig-instances/:iid/upgrade`: 작업본을 이 프로젝트의 고정 버전으로 옮기고, 새 버전에 남은 설정값은 유지(맞지 않으면 기본값), 계산한 단계는 모두 '다시 계산 필요', 사람 단계 확인은 입력 지문으로 다시 비교 |
| `src/ui/jigs.tsx`, `make-tab.tsx`, `make-api.ts` | 카드의 [수정하기](그 jig의 작성 중 사본이 있으면 그것을 연다), 내장 화면 jig는 흐린 [수정하기]와 '기본 화면 jig는 아직 수정할 수 없습니다', `forkable: false`인 저장소 jig는 흐린 [수정하기]와 '저장소에서 만든 jig는 아직 사본으로 고칠 수 없습니다', 작업본 행의 [올리기], 만들기 개요의 '수정 · <원래 jig> v0.3.1의 사본' 표지와 입력 → 단계 → 결과 묶음, 흐름 탭의 입력·결과 |
| `src/ai/instructions/make.md` | 사본 초안은 id를 바꾸지 않고, 동작이 바뀌면 버전을 더 올릴 수 있다 |

**선행·외부 조건:** T-099. 사본은 `ai-draft`로 다시 고정되어 계산 상자에서 돈다(SPEC-07.9). 저장소에서 쓴 jig(S-06처럼 자식 프로세스에서 도는 `dev-source`·`dev-pack`)는 단계가 저장소의 다른 모듈과 `node:` 모듈을 가져오므로 사본이 계산 상자의 import 규칙에서 자체 시험을 통과할 수 없다(검토에서 S-06 사본이 `MODULE_NOT_ALLOWED`로 실패함을 확인). 그래서 그런 jig는 사본을 만들지 않고 카드에서 이유를 보인다. 사용자 예시(S-06 v0.3.1 → v0.3.2)는 S-06을 상자 라이브러리만 쓰도록 다시 쓰거나 사본이 공식 라이브러리 이름으로 import를 바꾸는 후속 작업이 있어야 가능하다. import는 통과해도 메모리·시간 상한은 형식 점검·자체 시험이 고정 전에 막는다. 같은 id의 더 높은 버전이 나중에 저장소 묶음으로 들어오면 `JIG_VERSION_EXISTS`가 날 수 있다(SPEC-07.15 그대로).

**검증 — 정상:** 단위 `tests/core/drafts.test.mjs`(사본의 파일·쓰기 가능·id 유지·버전 +0.0.1, 열린 사본·설치본을 넘는 다음 버전, 출처 기록, 다시 고정 → `project_jigs` 한 줄이 새 버전, 같은 버전 다른 내용은 `JIG_VERSION_EXISTS`), `tests/core/jig-runner.test.mjs` 또는 런타임 시험(올리기: 버전·설정값·'다시 계산 필요'), `tests/server/make-routes.test.mjs`(경로). 브라우저 `browser-jigs.mjs`([수정하기] → 만들기 화면의 사본 표지·입력/단계/결과(역할 10개인 입력도 이름은 한 줄, 종류·역할은 그 아래로 줄바꿈), 내장 jig의 흐린 버튼과 이유, 이전 버전 작업본의 [올리기]).

**검증 — 실패:** `vide/` jig·없는 jig → `INVALID_INPUT`·`NOT_FOUND`, 단계가 jig 밖을 가져오는 jig(S-06) → `JIG_NOT_FORKABLE`과 카드의 흐린 [수정하기](`drafts.test.mjs`·`make-routes.test.mjs`·`browser-jigs.mjs`), 고정 안 된 jig의 작업본 올리기 → `NOT_FOUND`, 이미 고정 버전이면 바꾸지 않음, 고정 버전이 작업본보다 낮으면(예전 묶음을 가져와 다시 고정) `JIG_VERSION_NOT_NEWER`이고 그 행에 '이전 버전'·[올리기]가 없음(`make-routes.test.mjs`·`jig-list.test.mjs`·`browser-jigs.mjs`), 원격 세션의 고정은 그대로 403.

**완료:** 위 시험 통과, SPEC-07·ARCH-03 §7과 코드 일치, PLAN §6.5 갱신. S-06의 사본 고정은 이 티켓에서 하지 않는다(위 선행·외부 조건).

<a id="t-103"></a>
## T-103 · 대상 파일 칩·연계 대상 창 폐지 — 고칠 파일은 AI가 정한다

**목적·기준:** 사용자 질문(2026-10-02) "대상 파일이라는게 존재해야하나? 어떤 파일을 수정할지는 우리가 정하는게 아니라, AI가 판단해서 link된 연결 파일 중에 어떤거를 수정할지 결정하는거 아닌가?" — [ADR-027](../decisions/ADR-027-multi-file-coordination.md)(후속 결정 2026-10-02)로 한 요청이 열린 연결 파일을 모두 `linkId`로 읽고 고칠 수 있으므로, 사용자가 고르거나 보는 대상 파일을 없앤다. 동작 정본은 [SPEC-01](../specs/SPEC-01-project-input-sync.md).11의 5·12의 5, SPEC-02.14 머리의 폐지 문단, 화면은 Design §03 작성기.

| 대상 | 변경 |
|---|---|
| `src/ui/app.ts`, `src/ui/style.css` | 작성기의 '대상 파일 · 이름'/'연계 대상' 칩과 그 창 열기 삭제. 다른 파일의 핀도 역할 `target`. 입력 기준 보기 단추는 기준이 화면 밖일 때만 |
| `src/ui/linked-targets.tsx`(삭제), `src/ui/model.ts` | 연계 대상 창 삭제. jig 원본 목록이 쓰는 `linkedCandidates`는 `model.ts`로 옮김 |
| `src/ui/gateway.ts`, `src/ui/model.ts`, `src/ui/draft-storage.ts` | '연계 대상' 문구를 이전 연계 요청·연결 파일 문구로 |
| `src/server/direct-mode.ts`, `src/server/agent-tools.ts`, `src/ai/instructions/modeling.md` | 턴 목표의 연결 파일 목록에 '시작 문서'와 "열린 연결 파일은 모두 AI가 읽고 고칠 파일, 사용자가 대상을 고르지 않음, 시작 문서는 기본값일 뿐" 문장. 도구 설명(`query`·`execute`·`capture_view`·`measure`)을 같은 뜻으로. 다른 파일이라는 이유만으로 읽기 전용이 아님 |

**남기는 것:** 요청 입력 `linkedTargets`와 엔진의 연계 실행(SPEC-02.14 아래 부분)은 이전 연계 요청의 복원·개입과 이전 클라이언트를 위해 남긴다. 새 작성기는 이것을 만들지 않는다. 내부 시작 문서(초안을 시작할 때 보던 파일)는 `linkId` 없는 호출의 기본값과 접수 대기열의 열쇠로 남는다.

**선행·외부 조건:** ADR-027의 여러 파일 조율(T-092~094). ZWCAD 도면에서 시작하는 요청이 다른 파일을 실시간으로 다루는 것은 실행 경로(ZWCAD SDK 턴)가 달라 이 티켓 밖의 후속이다.

**검증 — 정상:** 단위 `tests/server/multi-file.test.mjs`(목표 문장의 '시작 문서'와 AI가 파일을 고른다는 문장), 전체 `npm test`. 브라우저 `browser-workspace-controls.mjs`(대상 칩·연계 대상 단추 없음), `browser-links.mjs`(다른 파일 객체를 고정해도 역할 `target`, 대상 칩 없음), `browser-pin-tokens.mjs`, `browser-linked-followup.mjs`(이전 연계 요청의 후속은 그대로). `browser-linked-hosts.mjs`는 실호스트가 필요해 이번에 돌리지 않았고, 창 대신 이전 형식의 초안을 넣도록 바꿨다.

**검증 — 실패:** 이전 연계 초안의 기준 후보가 없으면 '이전 연계 요청의 기준 후보를 확인할 수 없습니다.'로 복원하지 않음(`draft-storage.ts`). 열리지 않은 파일의 `linkId` → `LINK_NOT_LIVE`(기존 `multi-file.test.mjs`).

**완료:** 위 시험 통과, `npm run typecheck`·`format:check`, PLAN §6.5 갱신. 설치본 반영은 릴리스 때.

<a id="t-109"></a>
## T-109 · 작업 이력 정리 — 요청 목록만, 검토본은 산출물로

**목적·기준:** 사용자 결정(2026-10-02) "작업 이력도 추천대로 갈게"로 받아들인 추천안: (1) 작업 이력은 요청 목록만(레일 설명 '요청 기록'), (2) 검토본과 [검토본 비교]는 산출물 화면의 한 보기로 옮기고 저장은 작업 보기의 [검토본 저장] 그대로, 요청 행·작업 보기에 '이 작업으로 만든 검토본' 링크, (3) 외부 의견(SPEC-04.7)은 검토본 구역에서 빼서 산출물 쪽에 건수 배지와 함께, (4) 참고 자료 목록과 그 [파일 첨부]는 없애고 첨부는 요청마다 작업 보기에서 보고 연다. 화면 정본은 Design §03(왼쪽 탐색·SCR-03의 조건과 결과)·§09(검토본·외부 의견), 동작은 SPEC-01.12의 4.

**외부 의견의 자리:** 산출물에는 웹 공유 구역이 따로 없어 보기 전환 줄 오른쪽에 [외부 의견 n]을 두었다. 공유한 산출물(게시본)에 대한 의견이라 산출물에 속하고, 검토본 보기 안이 아니라 머리에 두어 어느 보기에서도 보인다. 대시보드 '오늘'은 사람이 챙길 할 일 목록(SPEC-01.14)이라 수신함을 섞지 않았다.

| 대상 | 변경 |
|---|---|
| `src/ui/index.html`, `src/ui/workspace-panels.ts` | 왼쪽의 검토본·참고 자료 구역 삭제. 레일 설명 '작업 이력 · 요청 기록', 산출물 설명에 검토본 |
| `src/ui/app.ts`, `src/ui/style.css` | 참고 자료 목록·[파일 첨부] 삭제(작성기의 클립 버튼은 그대로). 요청 행 아래 '이 작업으로 만든 검토본'(가장 최근 것을 엶). 검토본 목록이 바뀌면 행과 작업 보기를 다시 그림. 외부 의견·검토 의견의 [기준 후보 열기]는 모델 화면으로 돌아감 |
| `src/ui/reviews.tsx`, `src/ui/shared-feedback.tsx` | 검토본 목록을 모듈 상태로(`reviewRows`·`reviewsOf`·`onReviewsChange`), 산출물용 `ReviewSection`, `openReview`·`openSharedFeedback`·`sharedFeedbackCount`. 외부 의견 창이 받은 수를 알려 줌(`onCount`) |
| `src/ui/output-tab.tsx`, `src/ui/output-tab.css`, `src/ui/workspaces.ts` | 산출물 보기 '검토본'(도면·보고서·검토본·렌더링), 머리 오른쪽 [외부 의견 n] |
| `src/ui/work-view.tsx`, `src/ui/history.tsx` | 조건의 첨부: 보관 이미지는 기존 첨부 이미지 경로(`/attachments/{id}`)를 새 탭으로, 그 밖은 이름·크기. 결과 영역의 '이 작업으로 만든 검토본' |

**선행·외부 조건:** 없음. 이미지 외 첨부(PDF 등)를 화면에서 열려면 엔진이 그 파일을 내보내야 하므로 SPEC-01.12를 먼저 고친다(이 티켓 밖).

**검증 — 정상:** `browser-react-panels.mjs`(작업 보기의 첨부 링크·이름·크기, 참고 자료 목록 없음, 검토본 저장 뒤 작업 보기·이력 행의 링크로 열기, 같은 요청의 검토본이 둘이면 행 링크에 개수가 붙고 가장 최근 것을 엶, ×가 행 첫 줄 오른쪽에 남고 링크는 그 아래, 산출물 › 검토본의 목록·[검토본 비교]), `browser-workspace-tabs.mjs`(산출물 보기 네 개, 검토본 빈 목록, [외부 의견]의 건수 배지: 받은 수 표시·파일 가져오기 뒤 갱신·읽기 실패 때 숫자만 숨김, 엔드포인트는 가로챔), `browser-workspace-controls.mjs`(이력에 검토본·참고 자료 구역 없음, 레일 설명), `browser-report.mjs`. 실호스트 흐름이 필요한 `browser-reviews`·`browser-review-notes`·`browser-review-comparison`과 공유 서버·설치 패키지가 필요한 `tests/sharing/desktop-publish.mjs`·`portable-package.mjs`는 새 위치로 고쳤지만 이번에 돌리지 않았다.

**검증 — 실패:** 외부 의견 수를 읽지 못하면 배지만 숨긴다. 검토본 목록을 읽지 못하면 검토본 보기에 이유를 보인다.

**완료:** 위 시험 통과, `npm run typecheck`·`format:check`·`npm test`, PLAN §6.5 갱신. 설치본 반영은 릴리스 때.

## T-113 · 화면 뼈대 React 전환: index.html·app.ts 직접 DOM → 셸 컴포넌트와 명시 상태 {#t-113}

**목적·기준:** ARCH-01 §1.2 표(웹 화면 행 "DOM 직접 갱신을 컴포넌트와 명시적 상태로 전환", UI 상태 행)와 [ADR-016](../decisions/ADR-016-typescript-react-vite.md)을 화면 뼈대 전체에 한 번에 적용한다(사용자 승인 2026-10-02). 동작 보존 리팩터링이라 새 FR·SPEC은 없다. 화면 모습·CSS 클래스·요소 id·접근성 이름·localStorage 키·`body`/`html` 플래그는 바꾸지 않는다. 구조의 정본은 ARCH-01 「웹 화면 구조」다.

**범위와 순서:**

1. **기반 단계 F**(에이전트 1명, 먼저 병합): 동작을 하나도 바꾸지 않고 구조만 나눈다.
   - `src/ui/store/`: `core.ts`(변경 가능한 조각 객체 + `bump`·`subscribe`·`useStore`, `useSyncExternalStore`)와 조각 `session`·`draft`·`work`·`selection`·`sketch`·`viewer`·`links`·`toast`. `app.ts`의 모듈 최상위 `let`은 모두 이 조각의 같은 이름 필드가 된다(`project` → `session.project`). TS 좁히기를 지키려고 `get()` 대신 속성 접근을 쓴다.
   - `src/ui/app/`: `app.ts`를 지역 모듈로 기계적으로 나눈다. 각 모듈은 선언과 `init*()`만 내보내고 `boot.ts`가 원래 최상위 실행 순서대로 부른다(가져오기 순서·순환 참조로 실행 순서가 바뀌지 않게). `render()`·`renderMessages()`는 `render.ts`가 원래 호출 순서 그대로 지역의 그리기 함수를 부른다. 줄→모듈 대응은 스크립트로 빠짐·겹침 0을 확인한다. `app.ts`는 `boot.ts`를 부르는 얇은 진입으로 남긴다.
   - `src/ui/shell/`: 지금 `index.html`의 마크업을 스크립트로 옮긴 정적 컴포넌트(상태·props 없음, 다시 렌더하지 않음). `Shell.tsx`가 `#mobile-navigation`(따로 있던 루트를 합침)부터 `#message`, `SettingsDialog` 자리까지 지금 DOM 순서로 한 번 마운트한다(`flushSync`, StrictMode 없음, pagehide에 언마운트하지 않음). `#left`의 상태 줄 `<p>` 셋은 E 소유 `status-lines.tsx`로 뗀다. 지역마다 `region-boundary.tsx`의 오류 경계로 감싸 한 지역의 렌더 오류가 루트 전체를 내리지 않게 한다(모바일 탭 단추는 따로 감싸 예전 별도 루트와 같은 범위만 비움). `index.html`은 `<head>`와 루트 하나만 남긴다.
   - 그 밖: 아이콘 채우기를 `icons.ts`의 `paintIcons()`로(자식이 있는 노드는 건너뜀), 작성기 높이 조절을 `workspace-panels.ts`에서 `composer-height.ts`로, 단축키를 `app/shortcuts.ts` 등록부(순서 고정, 처리기가 멈춤/계속을 돌려줌)로 뗀다. 지역 간 파사드(`revealPanel`·`setBody`·`message`·`messageWithActions`·`showRouteCard`·`hideRouteCard`·`focusWork`·`openSettings`·`setConnectionStatus`·`setHostStatus`·`render`·`renderMessages`·`poll`·`submitRequest`·`sendComposer`·`captureViewport`·`annotatedCapture`·`applySelection`·`mobileView`·`focusDraft`·`switchDraft`)는 F가 지금 코드를 그대로 옮겨 만들고, 이후 시그니처는 추가만 허용한다.
2. **지역 단계 A~E**(F 병합 뒤 병렬, 지역마다 자기 `app/<지역>.ts`·`shell/*`·조각만 고침): A 레일·왼쪽 패널·작업공간 탭·레이아웃, B 뷰포트·인스펙터, C AI 열 상단·작업 보기·요청 폴링, D 작성기, E 상태 표시줄·토스트·설정 대화상자·부팅·패널 모드 껍데기. 정적 셸 JSX를 상태 기반 컴포넌트로 바꾸고 자기 영역의 DOM 직접 쓰기를 조각 갱신으로 바꾼다. 외부 삽입을 없앨 때는 상태화와 같은 커밋에서 한다.
3. **통합:** 병합 F → E → A → B → D → C. 병합마다 아래 검증 전체.

**지킬 계약:** `.workspace`·`.viewport-area`는 React 형제와 외부 직계 자식(jigs·dashboard·facts·make·output·reference 탭, 패널 너비 손잡이)을 함께 두는 컨테이너다(`style.css`의 `.workspace > …` 직계 규칙). 정적 자식이 있는 마운트 컨테이너(`#conversation`·`#request-count`·`#inspector-content`·`#task-list` 등)는 소유 지역이 바꾸기 전까지 React가 다시 그리지 않는다. 값 속성은 `defaultValue`, 의미 있는 공백 텍스트는 그대로 둔다. `#body`·`#projection`의 네이티브 `input`·`change` 리스너를 유지한다. Node 시험이 불러오는 UI 모듈(`reference-check.ts`·`conversations.tsx`·`connection-recovery.ts`)에는 DOM·JSX를 넣지 않는다. 카메라 값은 프레임마다 조각에 넣지 않는다. `createRoot` 정리 기준은 셸 컨테이너 안에 한정한다(탭·대화상자의 정당한 루트는 그대로).

**선행·외부 조건:** 착수 시 `git status` 깨끗, 브라우저 사슬 기준선 초록(2026-10-02 HEAD `a5a5fc0`: `npm test` 969, `npm run test:browser` 통과). CI(`verify:all`)가 브라우저 시험을 돌린다.

**검증 — 정상:** `npm run typecheck`·`npm run format:check`·`npm test`·`npm run docs:check`, `npm run test:browser` 전체. F는 부팅 직후 셸 DOM을 기준선(HEAD 빌드)과 정규화해 비교한다(루트 감싸개 외 차이 0). 지역·통합 단계는 지역별 시험 묶음, `?panel=rhino|zwcad` 380px, 주요 화면 다크·라이트 전후 스크린숏 비교를 더한다.

**검증 — 실패:** 연결 끊김 배너·재연결, 프로젝트 없는 첫 렌더, 초안 복원 실패, 토스트 액션이 기준선과 같게 동작한다(기존 브라우저 시험).

**완료:** F는 위 검사가 기준선과 같고 DOM 비교 차이가 의도한 감싸개뿐일 때. 전체는 `index.html`이 루트 하나, 셸 요소를 React가 그리고 남은 명령형 영역이 `#canvas`·`#objects` 어댑터·`#display-popover`·외부 직계 자식 컨테이너뿐, 셸 컨테이너 안 외부 삽입 0, 위 검증 통과, 결과는 VERIFY 기록. 설치본 릴리스는 통합 뒤 한 번.

**결과 · D 작성기(2026-10-02, 브랜치 `t113-d`):** `shell/composer.tsx`가 문맥 칩·모드 전환·모델 메뉴·effort·첨부/대기/보내기 단추·`#saved`·높이 손잡이(`composer-height.ts`의 `useComposerHeight`)를 `draftState.view`에서 그린다. `app/composer.ts`의 그리기 함수는 화면 값만 계산해 조각에 넣고 `paintComposer()`(마이크로태스크 한 번의 `bump`)를 부른다. `#body`는 비제어 textarea로 네이티브 `input`·`keydown`·`paste` 리스너를 유지하고, `.body-field`는 JSX가 그리며 `pin-tokens.ts`는 감싸지 않고 붙는다. `#model`은 네이티브 `change` 리스너를 유지한다. 기준선 빌드와 작성기 DOM을 7개 상태에서 비교해 차이 0. 브라우저 사슬 38개 중 36개 통과, `s06-jig`·`structure-jig`는 기준선 `003a896`에서도 같은 곳에서 실패(`npm test`의 s06 실패 12건과 같은 원인으로 보임).
