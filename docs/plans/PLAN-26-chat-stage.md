---
id: PLAN-26
title: 대화가 화면과 작업을 이끄는 구조 — skill 시작, 토큰 정리, 대화 열 + 무대
status: review
version: 0.1
updated: 2026-10-01
owner: agent:claude
related: [ADR-026, ADR-022, ADR-021, ADR-020, SPEC-02, SPEC-07, ARCH-03, ARCH-01, DESIGN, RESEARCH-12, PLAN-22, PLAN-24, FR-18, FR-24, FR-25, AC-48]
---

# 대화가 화면과 작업을 이끄는 구조 (T-076~T-080)

기준: [ADR-026](../decisions/ADR-026-chat-stage-and-skill-jigs.md)(2026-10-01 사용자 결정), 조사는 [RESEARCH-12](../research/RESEARCH-12-ui-chat-driven-structure.md). 진행 상황의 정본은 [PLAN §6.5](PLAN.md)이다.

## 1. 범위와 순서

셸 교체보다 멈춤 해소가 먼저다(ADR-026 결정 7). T-076(skill 시작)과 T-077(토큰·CSS 정리)은 지금 배치 위에서 한다. T-078(목업·검수)이 끝나야 T-079(셸 교체)를 시작한다. T-080(층 평면)은 독립이다.

| 티켓 | 내용 | 선행 | 상태(2026-10-01) |
|---|---|---|---|
| T-076 | 단계 0: skill 시작, skill 카탈로그 로더, AI 도구 `jig_open`·`ui_go`, 공급자 자체 질문 기본 | ADR-026, 이 계획 | 구현·단위·브라우저 시험 완료(2026-10-01). 남음: 실제 Claude CLI에서 자체 질문+jig 대화 확인, 확신 낮을 때 두 갈래 질문(M6), `summary.kpi` |
| T-077 | 토큰층과 CSS 리터럴 정리 | ADR-026, Design §02 | 완료(2026-10-01): UI CSS 색 리터럴 0, 왼쪽 막대 제거, 선택/초과 색 분리. 남음: 기능용 리터럴(`app.ts` 붓 색 등) |
| T-078 | 대화 열 + 무대 정적 목업과 VERIFY | ADR-026 결정 5 | 목업 게시, 사용자 검토 대기 |
| T-079 | 셸 교체: 대화 열 + 무대 | T-078 VERIFY, T-076 | 막힘(목업 검수 전) |
| T-080 | 층 평면 보기: 층 해석 + 뷰포트 단면 자르기 | SPEC-02.17 보완 | 대기 |

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
| `src/jigs/runtime/manifest.ts`, `src/server/jig-routes.ts` | `open`·`autorun`·`from_request`·`summary` 허용(`.strict()` 유지), skill 시작 작업본의 `layerRoot` 존재 검사 면제와 만들기 때 `LAYER_ROOT_MISSING` |
| 질문 어댑터(T-075에서 꺼 둔 것) | 공급자 자체 질문 기능을 기본으로 켜고, 없는 공급자·경로는 VIDE 카드 |
| `extensions/jigs/s06-frame/skill.md`, `jig.json` | `description`·`examples`, `from_request`(예: `spanMax`·`beamSpacing_m`·`layoutSource`), `summary.kpi`. 합성 자료만 |
| 문서 | ARCH-01 §3 도구 목록·계획 모드 도구, SPEC-01.10 단서(다른 세션의 편집이 커밋된 뒤). 구현과 다르면 ARCH-03 §5.3을 고친다 |

**선행·외부 조건:** ADR-026·SPEC·ARCH-03 반영(완료). ARCH-01·SPEC-01은 다른 세션이 편집 중이라 그 뒤에 고친다. 기본 출력 레이어(`VIDE/<jig>/<n>`)를 Rhino에 실제로 만드는 여러 단계 레이어 생성은 Rhino 플러그인 재빌드가 필요해(ARCH-03 §9.5, PLAN-22) 이 티켓의 완료 조건에서 뺀다. 그때까지 그 작업본의 Rhino에 만들기는 이유를 보이고 막는다.

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
## T-078 · 대화 열 + 무대 정적 목업과 검수

**목적·기준:** 셸 교체 전에 구조와 토큰 방향을 사용자가 화면으로 고른다. ADR-026 결정 5·7, RESEARCH-12 §6.1·§6.2·§7.2 「먼저 확인할 목업·실험」, Design SCR-03·13·15·18.

**변경 범위:** `tools/mockups/chat-stage/`의 정적 HTML(`src/ui/tokens.css`의 값, 합성 수치만). 상태: 모델 무대, jig 무대(S-06 합성, 단계 레일·KPI 띠·결과 서랍), 문서 무대, 빈 무대의 프로젝트 보드, 자동 모드의 턴 블록(경로 줄·체크 목록·질문 카드·결과 카드·[일반 대화로]), 계획 모드의 체크리스트·[진행], '대기' 묶음, 호스트 패널 폭의 대화 열. 폭 1440·1280·900과 호스트 패널, 밝은 값과 패널 어두운 값. 대화 열 왼쪽·오른쪽 두 배치를 나란히 둔다(RESEARCH-12 Q3). 기록은 `docs/tdd/VERIFY-2026-10-xx-chat-stage-mockup.md`(SCR-03·13·15·18, AC-48 인용).

**선행:** 없음. 제품 코드가 아니므로 제품 지원 완료로 집계하지 않는다(AI.md §2).

**검증 — 정상:** 각 폭에서 가로 넘침 없음, 무대 전환의 600ms 외곽선과 포커스가 작성기에 남는 것을 목업 조작으로 확인, 포인트 요소가 화면당 셋 이하.

**검증 — 실패:** 좁은 화면(<900)에서 대화·무대 두 장 전환이 되는지, 레일·탭 없이 jig 목록·보고서·자료로 가는 길(⌘K, 무대 머리, 프로젝트 보드)이 보이는지. 안 보이면 VERIFY에 적고 T-079 전에 고친다.

**완료:** 사용자가 배치 하나(대화 열 위치 포함)를 고르고 VERIFY에 결정과 남은 질문을 적는다. 그 결정으로 Design §03·SCR-03·SCR-18·§12.9를 다시 쓴다(T-079의 선행).

<a id="t-079"></a>
## T-079 · 셸 교체: 대화 열 + 무대

**목적·기준:** 상시 면을 대화 열과 무대 둘로 줄여 말과 결과를 한 줄기로 잇는다. ADR-026 결정 5, RESEARCH-12 §6.1·§6.2, 목업 VERIFY(T-078), 다시 쓴 Design §03.

**변경 범위:** `src/ui/index.html`, `src/ui/app.ts`, `src/ui/workspaces.ts`, `src/ui/work-view.tsx`·`src/ui/conversations.tsx`(스레드 렌더러로 합침), 무대 머리의 연결 점·보기 전환·⌘K, 접히는 무대 왼쪽 슬롯(모델: 파일·레이어, jig: 단계·설정값), 선택 줄·결과 서랍, 호스트 패널은 대화 열만, 좁은 화면 두 장 전환. 레일·'AI WORK' 머리·숨긴 선택 상자·이모지·긴 툴팁을 뺀다. `startSkill`의 화면 단계를 무대 열기로 바꾼다.

**선행·외부 조건:** T-078 VERIFY에서 사용자가 배치를 고름, Design §03·SCR-03·SCR-18·§12.9 다시 씀, T-076 완료. **그 전에는 시작하지 않는다.**

**검증 — 정상:** 기존 브라우저 시험을 새 셸에 맞게 고쳐 전체 통과. 새 시험: 방금 보낸 요청에만 무대가 한 턴 한 번 옮겨지고, 외곽선·`aria-live` 알림이 있고, 포커스가 작성기에 남음. 무대별 카메라·선택 보존. 호스트 패널(SCR-12)에서 대화 열만 그려짐.

**검증 — 실패:** 다른 대화의 백그라운드 작업이 무대를 옮기지 않음, [원래대로] 한 번으로 무대 복귀, 연결 끊김이 연결 점에 바로 보임. 발견성 사용자 시험(레일·탭 없이 jig를 찾는지)을 VERIFY에 기록한다.

**완료:** 위 시험 통과, 사용자 시험 기록, 설치본 반영은 릴리스 때.

<a id="t-080"></a>
## T-080 · 층 평면 보기: 층 해석 + 뷰포트 단면 자르기

**목적·기준:** "3층 평면 보여줘"를 AI 없이 VIDE 화면에서 처리한다. FR-25, SPEC-02.17의 1·2(화면 경로), RESEARCH-12 §6.4 ②. 지금 화면 경로에는 평면 동작이 없어 AI로 간다(`request-route.ts`의 `viewActions`).

**변경 범위:** `src/ui/request-route.ts`(화면 동작 '층 평면'과 대상 '층'), 층 해석(레이어 이름 3F·L03·3층 → 호스트 레벨 정보 → 열린 jig의 레벨 설정값), `src/ui/viewport.ts`(위·직교 시점과 층 높이의 단면 자르기, 되돌리기), 결과 한 줄("평면 · 3층(EL +10.2 m) · 위를 잘라 봄 · 되돌리기 · 3D로").

**선행:** SPEC-02.17의 화면 경로에 '층 평면'(층 해석 순서, 후보가 여럿이거나 없을 때의 질문, 호스트 뷰를 바꾸지 않음, 되돌리기)을 먼저 적는다. 층 해석에 쓰는 호스트 레벨 정보가 Sync에 있는지 확인하고, 없으면 레이어 이름과 jig 설정값만 쓴다.

**검증 — 정상:** 단위: 층 이름 해석(3F·L03·3층·지하 1층), 레벨 후보 정렬. 브라우저: 합성 모델에서 "3층 평면 보여줘" → 위 직교 시점과 단면 자르기, 스레드 한 줄, U로 되돌림, Rhino 뷰 그대로.

**검증 — 실패:** 층 후보가 여럿이거나 없음 → 적용하지 않고 후보 2개와 '직접 입력' 질문 카드, 없는 레벨을 예시 값으로 채우지 않음. 원본을 바꾸는 말이 섞이면 화면 경로로 처리하지 않음(SPEC-02.17의 1).

**완료:** 위 시험 통과, 큰 모델에서 자르기의 프레임 시간을 PLAN-18의 기준으로 확인해 VERIFY에 적는다.
