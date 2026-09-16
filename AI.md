# AI.md — 에이전트 공통 규약 (형식)

버전 0.3 · 2026-09-16 · 소유: user

이 파일은 이 저장소에서 일하는 모든 에이전트(Claude Code, Codex, Gemini CLI 등)와 사람이 공유하는 **형식 규약**이다. 폴더 트리, 파일 이름, 문서 짝(md/html), 상태 헤더, ID 체계, 첨삭 표기, 산출물 위치만 정한다.
제품이 무엇인지·범위·요구는 `docs/PRD.md`가 정하고, 작업 절차는 `DEVELOPMENT_GUIDE.md`가 정한다. 가이드 전체를 매번 읽을 필요는 없지만 현재 단계에 해당하는 절은 따른다. 이 파일은 기술 스택·화면·기능 범위를 결정하지 않는다.

## 1. 읽는 순서와 권위

1. `AI.md` (이 파일)
2. `docs/PRD.md` — 제품 결정의 기준. 범위·요구·수용 기준·미정 항목(OQ)은 여기서만 바뀐다.
3. 현재 단계의 기준 문서 — 어느 단계인지는 `DEVELOPMENT_GUIDE.md` §00·§12를 참고한다.

권위는 주제별로 구분한다. 형식·산출물 위치는 이 파일, 제품 범위·FR·AC·OQ는 PRD, 동작 의미는 SPEC, 시각·상호작용 표현은 Design, 구현 방법은 PLAN, 작업 절차는 가이드가 소유한다. 하위 문서는 제품 요구를 덮어쓰지 않는다. 충돌은 해당 원본 문서에서 해소한다. 문서 안의 `<ins>`/`<del>`/검토 인용 블록은 제안이지 확정이 아니다.

## 2. 폴더 트리

```text
Vino-IDE/
├─ AI.md                          이 파일. 형식 규약의 단일 원본
├─ CLAUDE.md                      "@AI.md" 한 줄 (Claude Code가 인라인)
├─ AGENTS.md                      AI.md를 읽으라는 안내 (Codex 등)
├─ Design.md (+ .html)            시각·상호작용 원칙. 화면별 상세는 SPEC 이후
├─ DEVELOPMENT_GUIDE.md (+ .html) 프로세스 가이드. 현재 단계의 절을 참조
├─ index.html                     생성물. 문서 목록 (tools/docs가 만든다)
├─ .claude/settings.json          Claude Code 프로젝트 훅: .md 편집 후 HTML 재생성 (settings.local.json은 개인 설정)
├─ .githooks/pre-commit           커밋 전 HTML 재생성·포함. `git config core.hooksPath .githooks`
├─ tools/docs/                    md→html 렌더러 (build.mjs, docs.config.json, theme.css, review.css, reader.js, review.js, partials/)
├─ tools/spikes/<date>-<slug>/     필요한 기술 실험 코드만, 첫 실험 때 생성
├─ tools/mockups/<slug>/           필요한 임시 목업 코드만, 첫 목업 때 생성
└─ docs/
   ├─ PRD.md (+ .html)            제품 요구사항. FR / AC / OQ / C ID의 소유자
   ├─ specs/                      기능 동작 명세 묶음 (가이드의 "SPEC.md"에 해당)
   │   ├─ README.md               색인: FR → SPEC 파일 대응표 (첫 SPEC 작성 시 생성)
   │   ├─ SPEC-00-common.md       공통 상태·권한·개입·참조 규칙
   │   ├─ SPEC-NN-<slug>.md       기능 묶음별 명세
   │   └─ hosts/<host>.md         호스트별 지원표 (rhino, revit, autocad, zwcad)
   ├─ plans/                      구현계획 (가이드의 "IMPLEMENTATION_PLAN.md"에 해당)
   │   ├─ PLAN.md                 마스터 구현계획: 구조·스택·계약·마일스톤·task·검증
   │   └─ PLAN-NN-<slug>.md       PLAN.md의 한 장이 커졌을 때만 분리
   ├─ tdd/                        검증 문서만. 테스트 코드는 두지 않음
   │   ├─ TEST_PLAN.md            PLAN.md §7에서 분리될 때만
   │   ├─ SPIKE-YYYY-MM-DD-<slug>.md    기술 실험 기록 (질문·방법·환경·결과·한계)
   │   └─ VERIFY-YYYY-MM-DD-<scope>.md  실호스트·목업·MVP 수용 검수 기록
   ├─ decisions/                  ADR-NNN-<slug>.md — OQ-xx·스택 결정 기록 (첫 ADR 때 생성)
   └─ assets/<scope>/             문서·검수의 이미지 등 증거 자산 (필요할 때 생성)
```

빈 폴더에는 `.gitkeep`만 둔다. 하위 폴더는 첫 파일이 생길 때 만든다.

**후속(제품 구현 시작 조건을 충족하고 `PLAN.md`가 정한 뒤에만 생성):** `src/`(IDE 코어·앱) · `hosts/<host>/`(호스트 애드인) · `extensions/`(확장 SDK·검증용 샘플) · `tests/`(단위·계약·UI·호스트·설치). 구성요소 내부 구조·공통 계약 위치·테스트 병치는 PLAN에서 정한다. 문서 폴더 구조를 제품 코드 구조로 그대로 복제하지 않는다.

문서 렌더러는 제품 PLAN과 독립적으로 개발한다. 기술 실험은 대응하는 `SPIKE-*` 기록에 질문·코드 위치·종료 조건을, 목업은 `VERIFY-*` 기록에 범위·기준 SPEC/Design·코드 위치를 남긴다. 제품 PLAN 이전에도 가능하나 제품 지원 완료로 집계하지 않는다. 제품 코드로 채택할 때는 PLAN의 작업에 연결한다. 실험 기록은 계획과 실제 실행 결과를 구분한다.

## 3. 파일 이름 규칙

- 고정 이름(바꾸지 않음): `AI.md` `CLAUDE.md` `AGENTS.md` `Design.md` `DEVELOPMENT_GUIDE.md` `docs/PRD.md` `docs/plans/PLAN.md` `docs/tdd/TEST_PLAN.md`
- 번호 접두: `SPEC-NN-<slug>.md` `PLAN-NN-<slug>.md` `ADR-NNN-<slug>.md`. NN은 0을 채운다. 한 번 부여한 번호는 재사용·재부여하지 않는다(폐기 시 `status: superseded`).
- 날짜 접두: `SPIKE-YYYY-MM-DD-<slug>.md` `VERIFY-YYYY-MM-DD-<scope>.md`
- `<slug>`와 폴더 이름은 ASCII 소문자 kebab-case. 한국어는 본문에만 쓴다. 공백 금지.
- 호스트 파일: `docs/specs/hosts/<host>.md`, `<host>` ∈ rhino, revit, autocad, zwcad.
- 고유 기준 문서의 복제본을 다른 폴더에 두지 않는다. 폴더별 `README.md`와 도구의 필수 파일명은 허용하며 전체 경로로 구분한다. 외부 도구가 요구하는 이름·기존 루트 이름은 소문자 규칙의 예외다.

## 4. md / html 짝

- `.md`만 원본이다. 같은 폴더·같은 basename의 `.html`과 루트 `index.html`은 `tools/docs/build.mjs`가 만드는 생성물이며 손으로 편집하지 않는다. 생성물 머리에는 `GENERATED FILE` 주석이 있다.
- 재생성: `npm --prefix tools/docs run build` (최초 1회 `npm --prefix tools/docs install`). 사람이 편집할 때는 `run watch`, 확인만 하려면 `run check`(오래됐으면 exit 1).
- 자동 재생성: Claude Code가 `.md`를 Edit/Write 하면 `.claude/settings.json`의 PostToolUse 훅이 재생성한다. `git commit` 때는 `.githooks/pre-commit`이 재생성하고 바뀐 HTML을 커밋에 넣는다.
- 새 문서는 `docs/specs/` `docs/plans/` `docs/tdd/` `docs/decisions/`에 두면 자동 탐색된다. 상단 탭·설명은 `tools/docs/docs.config.json`에서 정한다.
- `DEVELOPMENT_GUIDE.html`의 개인 메모 위젯은 `tools/docs/partials/guide-workspace.html`이 §12 끝에 넣는다(localStorage 키 `drawing-ide-planning-notes` 유지).
- MD를 고친 에이전트는 HTML을 직접 건드리지 않는다. 훅이 실패하면 위 명령으로 재생성한다.

## 5. 검토·첨삭 표기

검토 의견은 문서 안에 직접 표기한다. 별도 리뷰 파일을 만들지 않는다.

- 본문 수정 제안: `<del>기존 문구</del><ins>제안 문구</ins>`. 추가만이면 `<ins>…</ins>`, 삭제만이면 `<del>…</del>`. 표 셀 안에서도 같다.
- 코멘트: 대상 문단(또는 표) 바로 아래 한 줄 띄우고 인용 블록으로 쓴다.
  `> **[검토 · <agent> · R-NN · 높음|중간|낮음]** 문제. 제안: …`
  `R-NN`은 문서별 일련번호다. 한 문단에 여러 지적이 있으면 인용 블록 하나에 줄을 나눠 쓴다.
- 부록: 문서 맨 끝에 `## 부록 · <Agent> 검토 요약 (YYYY-MM-DD)` — 총평, 이슈 표(R-NN | 위치 | 심각도 | 요약), 결정이 필요한 질문, 다음 단계.
- 심각도: 높음 = 다음 문서(SPEC/PLAN)를 막거나 독자를 오도함 · 중간 = 확정 전에 수정 · 낮음 = 다듬기.
- 해소: 수락 = `<del>…</del>`를 지우고 `<ins>` 태그만 벗기고 코멘트 블록을 지운다. 거부 = 반대로 한다. 부록 표의 해당 행도 지우며, 모두 해소되면 오래된 총평·질문을 포함한 검토 부록을 제거한다. 부분 수락은 최종 문구와 판단을 보고한다. 검토 표기가 남아 있는 문서는 `status`를 `approved`로 올리지 않는다. 설명용 코드 예제의 태그는 미해결 검토로 세지 않는다.
- HTML에서는 `tools/docs/review.css`가 `ins`를 초록, `del`을 빨강 취소선, 검토 인용 블록을 파란 상자(R-NN·심각도 배지)로 그리고, 부록 절과 목차의 건수 배지를 표시한다. 상단 '첨삭' 메뉴로 원문만·수락 후 보기로 바꿀 수 있다(표시만 바뀌고 MD는 그대로). 표기 자체는 VS Code 미리보기·GitHub에서도 추가 처리 없이 보인다.

## 6. 문서 상태 헤더

PRD·Design·가이드 및 `docs/` 아래의 작성 문서에는 맨 위에 YAML front matter를 둔다. `AI.md`·에이전트 진입 파일·외부 도구의 필수 문서·생성물은 예외다.

```yaml
---
id: SPEC-02            # 고정 이름 문서는 PRD / DESIGN / GUIDE / PLAN / TEST
title: 공간 입력 (핀·스케치·코멘트)
status: draft          # draft | review | approved | superseded
version: 0.1
updated: 2026-09-16
owner: user            # 사람 이름 또는 agent:claude 등
related: [FR-05, FR-06, AC-01, OQ-03]
---
```

상태는 헤더에만 적는다. 색인(README)은 상태를 복사하지 않고 링크만 둔다.

`draft`는 작성 중, `review`는 검토 가능한 초안, `approved`는 명시된 범위의 합의된 기준, `superseded`는 대체된 문서다. 상태를 단순한 크기 순서로 비교하지 않는다. `approved`는 구현·시험 완료나 모든 OQ 해결을 뜻하지 않는다. 미결 OQ는 영향받는 작업을 제한하며, 사용자 승인 또는 명시적 위임 범위 안에서만 기준을 확정한다. 문서 의미가 바뀌면 `version`·`updated`를 갱신하고, 기존 승인 범위를 바꾸는 미합의 변경은 `review`로 돌린다.

색인은 `INDEX-SPECS`, 호스트 문서는 `HOST-RHINO` 등, 실험·검수 문서는 확장자를 뺀 파일명을 `id`로 쓴다. 제목·관련 ID는 실제 내용에 맞춘다.

## 7. ID 체계와 추적성

| 접두 | 소유 문서 | 뜻 |
|---|---|---|
| FR-NN | docs/PRD.md §13 | 기능 요구 |
| AC-NN | docs/PRD.md §15 | 수용 시나리오. AutoCAD 약어로 쓰지 않는다(AutoCAD는 `ACAD`) |
| OQ-NN | docs/PRD.md §18 | 미결 제품 결정 |
| C-NN | docs/PRD.md §4.4 | 후보 기능 |
| SPEC-NN | docs/specs/ | 명세 파일. 파일 안의 기능 항목은 `SPEC-NN.m` |
| H-<HOST>-NN | docs/specs/hosts/ | 호스트 지원표 행 (H-RHINO-01, H-REVIT-01, H-ACAD-01, H-ZWCAD-01) |
| PLAN-NN | docs/plans/ | 분리된 계획 파일 |
| T-NNN | docs/plans/PLAN.md | 개발 티켓. 분할 계획에서도 같은 ID를 쓰고 마스터는 링크만 유지 |
| SCR-NN | Design.md §12 | 화면·경험 단위. 개별 페이지나 컴포넌트 구현을 강제하지 않음 |
| ADR-NNN | docs/decisions/ | 결정 기록 |
| R-NN | 각 문서 내부 | 검토 코멘트 (문서별 번호) |

규칙: SPEC 기능은 FR을 하나 이상 인용한다 · PLAN의 기능 티켓은 SPEC을 인용한다 · 문서 도구·설치 준비 등 기반 티켓은 관련 PLAN 장과 검증 기준을 인용하며 가짜 FR/SPEC을 만들지 않는다 · VERIFY는 관련 AC, 호스트 검수일 때 H-*, 화면 검수일 때 SCR-*를 인용한다. 해당 ID가 아직 없거나 적용되지 않으면 이유와 기준 문단을 쓴다 · ADR은 OQ 또는 PLAN 장을 인용하고 결정이 채택되면 그 원본에 역링크한다. 기술 결정에 대응하는 OQ를 억지로 만들지 않는다 · `docs/specs/README.md`는 FR → SPEC 대응표를, PRD §15는 AC → FR 대응표를 소유한다. 역방향 표를 수동으로 중복 관리하지 않는다.

T·SCR·SPEC 세부 항목 번호도 한 번 부여하면 재사용하지 않는다. SPEC 공통 참조·실행·개입·적용·저장 상태의 논리적 구분은 SPEC이、구체적인 필드·전송 형식은 PLAN이 소유한다. 제품 안의 Task와 개발 티켓 T-NNN은 별개다.

## 8. 에이전트 규칙

- 산출물은 §2의 폴더에만 쓴다. 다음 병렬 문서는 만들지 않는다: `MVP_SCOPE.md` `TECH_DESIGN.md` `ARCHITECTURE.md` `NOTES.md` `SUMMARY.md`, 루트의 요약·보고 파일, `docs/superpowers/**`.
- PRD의 범위·요구를 바꾸는 미합의 제안은 §5 첨삭 코멘트 또는 ADR 초안으로 낸다. 사용자가 타당한 검토의 반영을 위임했으면 그 범위의 수정은 확정하고 근거·변경 내용을 보고한다. 미정인 호스트·출시 범위 같은 제품 선택까지 임의로 확정하지 않는다.
- 빈 자리표시 문서를 만들지 않는다(`.gitkeep`은 예외).
- 제품 구현은 `PLAN.md`가 `review` 또는 `approved`이고 해당 티켓이 `DEVELOPMENT_GUIDE.md` §05의 시작 조건을 충족할 때 진행한다. 그 전에는 `src/` `hosts/` `extensions/` `tests/`를 만들지 않는다. 문서 도구·한정된 실험·임시 목업은 §2의 별도 위치를 사용한다.
- HTML을 손으로 편집하지 않는다. 렌더러 코드(`tools/docs/`)를 바꿀 때는 이 규약과 어긋나지 않게 한다. AI.md는 사용자 지시 없이 수정하지 않는다(제안은 첨삭으로).
- 본문은 한국어, 파일명·ID·코드 식별자는 ASCII. UI 문자열·시험 데이터·주석은 내용에 필요한 한국어를 사용할 수 있다. 텍스트는 UTF-8, 줄바꿈은 LF로 저장한다. 기존 문서를 번역하지 않는다.
- 기존 작업·동시 변경·추적되지 않은 파일은 덮어쓰지 않는다. 비밀키·인증정보·비공개 프로젝트 원본을 저장소나 검수 증거에 넣지 않는다.
- 커밋·push는 사용자가 요청할 때만 한다.
- 세션 요약·인계는 채팅으로 낸다. 인계 문서가 필요하면 사용자가 위치를 정한다.

## 9. 플러그인·스킬 경로 덮어쓰기

- superpowers `brainstorming`이 쓰는 설계 문서 → 기능 동작이면 `docs/specs/SPEC-NN-<slug>.md`, 기술 구조면 `docs/plans/PLAN-NN-<slug>.md`. `docs/superpowers/`는 만들지 않는다.
- superpowers `writing-plans` → `docs/plans/PLAN-NN-<slug>.md`. 마스터는 `PLAN.md`이고 목차는 `DEVELOPMENT_GUIDE.md` §05를 따른다.
- 스펙 "커밋" 단계는 사용자가 요청할 때만 실행한다.
- 문서 작성·검토·첨삭·재배치 작업은 brainstorming 게이트 대상이 아니다. 제품 코드 작성 시 필요한 절차는 이미 합의된 SPEC·PLAN과 현재 사용 가능한 스킬을 기준으로 적용한다. 미설치 플러그인 실행이나 이미 합의한 설계의 반복 승인을 전제하지 않는다.
- 다른 플러그인이 기본 경로를 가지면 같은 원칙으로 §2에 맞춘다.

## 10. CLAUDE.md · AGENTS.md

- `CLAUDE.md`는 `@AI.md` 한 줄이다(Claude Code가 이 파일을 인라인한다).
- `AGENTS.md`는 "AI.md를 먼저 읽고 따르라"는 안내문이다(Codex 등은 `@` import를 지원하지 않고, Windows에서 심볼릭 링크는 피한다).
- 두 파일에 다른 규칙을 적지 않는다. Gemini CLI가 필요하면 `GEMINI.md`에 `@./AI.md` 한 줄을 둔다.

## 11. AI.md를 고치는 때

폴더·이름 규칙·헤더 필드·ID 접두·문서 종류·첨삭 표기가 바뀔 때만 고친다. 내용 변경(PRD/SPEC/PLAN)은 이 파일을 건드리지 않는다. 고칠 때 맨 위의 버전·날짜를 올린다.
