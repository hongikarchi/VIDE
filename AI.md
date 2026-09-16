# AI.md — 에이전트 공통 규약 (형식)

버전 0.1 · 2026-09-16 · 소유: user

이 파일은 이 저장소에서 일하는 모든 에이전트(Claude Code, Codex, Gemini CLI 등)와 사람이 공유하는 **형식 규약**이다. 폴더 트리, 파일 이름, 문서 짝(md/html), 상태 헤더, ID 체계, 첨삭 표기, 산출물 위치만 정한다.
제품이 무엇인지·범위·요구는 `docs/PRD.md`가 정하고, 작업 절차는 `DEVELOPMENT_GUIDE.md`(사람용 참고)가 정한다. 이 파일은 기술 스택·화면·기능 범위를 결정하지 않는다.

## 1. 읽는 순서와 권위

1. `AI.md` (이 파일)
2. `docs/PRD.md` — 제품 결정의 기준. 범위·요구·수용 기준·미정 항목(OQ)은 여기서만 바뀐다.
3. 현재 단계의 기준 문서 — 어느 단계인지는 `DEVELOPMENT_GUIDE.md` §00·§12를 참고한다.

같은 내용이 두 문서에 있으면 위 순서의 앞 문서가 우선한다. 문서 안의 `<ins>`/`<del>`/검토 인용 블록은 제안이지 확정이 아니다.

## 2. 폴더 트리

```text
Vino-IDE/
├─ AI.md                          이 파일. 형식 규약의 단일 원본
├─ CLAUDE.md                      "@AI.md" 한 줄 (Claude Code가 인라인)
├─ AGENTS.md                      AI.md를 읽으라는 안내 (Codex 등)
├─ Design.md (+ .html)            시각·상호작용 원칙. 화면별 상세는 SPEC 이후
├─ DEVELOPMENT_GUIDE.md (+ .html) 사람용 프로세스 가이드. 에이전트 필독 아님
├─ .claude/                       Claude Code 로컬 설정
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
   └─ decisions/                  ADR-NNN-<slug>.md — OQ-xx·스택 결정 기록 (첫 ADR 때 생성)
```

빈 폴더에는 `.gitkeep`만 둔다. 하위 폴더는 첫 파일이 생길 때 만든다.

**후속(코드 시작 후, `PLAN.md`가 정한 뒤에만 생성):** `src/`(IDE 코어·앱) · `hosts/<host>/`(호스트 애드인) · `extensions/`(확장 SDK·검증용 샘플) · `tests/`(단위·계약·UI·호스트·설치) · `tools/docs/`(md→html 렌더러).

## 3. 파일 이름 규칙

- 고정 이름(바꾸지 않음): `AI.md` `CLAUDE.md` `AGENTS.md` `Design.md` `DEVELOPMENT_GUIDE.md` `docs/PRD.md` `docs/plans/PLAN.md` `docs/tdd/TEST_PLAN.md`
- 번호 접두: `SPEC-NN-<slug>.md` `PLAN-NN-<slug>.md` `ADR-NNN-<slug>.md`. NN은 0을 채운다. 한 번 부여한 번호는 재사용·재부여하지 않는다(폐기 시 `status: superseded`).
- 날짜 접두: `SPIKE-YYYY-MM-DD-<slug>.md` `VERIFY-YYYY-MM-DD-<scope>.md`
- `<slug>`와 폴더 이름은 ASCII 소문자 kebab-case. 한국어는 본문에만 쓴다. 공백 금지.
- 호스트 파일: `docs/specs/hosts/<host>.md`, `<host>` ∈ rhino, revit, autocad, zwcad.
- 같은 이름의 문서를 다른 폴더에 두지 않는다.

## 4. md / html 짝

- `.md`만 원본이다. 같은 폴더·같은 basename의 `.html`은 생성물이며 손으로 편집하지 않는다.
- 렌더러(`tools/docs/`, 후속)가 생기기 전까지 현재의 `docs/PRD.html` `Design.html` `DEVELOPMENT_GUIDE.html`은 2026-09-16 스냅샷이다. 참고용이고 권위가 없으며, 서로의 링크가 깨져 있어도 고치지 않는다.
- 예외: `DEVELOPMENT_GUIDE.html`의 체크리스트·메모(localStorage)는 렌더러 도입 시 JSON으로 내보낸 뒤 전환한다.
- MD를 고친 에이전트는 HTML을 건드리지 않는다.

## 5. 검토·첨삭 표기

검토 의견은 문서 안에 직접 표기한다. 별도 리뷰 파일을 만들지 않는다.

- 본문 수정 제안: `<del>기존 문구</del><ins>제안 문구</ins>`. 추가만이면 `<ins>…</ins>`, 삭제만이면 `<del>…</del>`. 표 셀 안에서도 같다.
- 코멘트: 대상 문단(또는 표) 바로 아래 한 줄 띄우고 인용 블록으로 쓴다.
  `> **[검토 · <agent> · R-NN · 높음|중간|낮음]** 문제. 제안: …`
  `R-NN`은 문서별 일련번호다. 한 문단에 여러 지적이 있으면 인용 블록 하나에 줄을 나눠 쓴다.
- 부록: 문서 맨 끝에 `## 부록 · <Agent> 검토 요약 (YYYY-MM-DD)` — 총평, 이슈 표(R-NN | 위치 | 심각도 | 요약), 결정이 필요한 질문, 다음 단계.
- 심각도: 높음 = 다음 문서(SPEC/PLAN)를 막거나 독자를 오도함 · 중간 = 확정 전에 수정 · 낮음 = 다듬기.
- 해소: 수락 = `<del>…</del>`를 지우고 `<ins>` 태그만 벗기고 코멘트 블록을 지운다. 거부 = 반대로 한다. 부록 표의 해당 행도 지운다. 검토 표기가 남아 있는 문서는 `status`를 `approved`로 올리지 않는다.
- 렌더러는 `ins` / `del` / 검토 인용 블록에 스타일을 입힌다. 표기 자체는 VS Code 미리보기·GitHub에서 추가 처리 없이 보인다.

## 6. 문서 상태 헤더

`docs/` 아래와 루트의 새 문서는 맨 위에 YAML front matter를 둔다. 기존 문서 3종(PRD, Design, DEVELOPMENT_GUIDE)은 다음 개정 때 붙인다.

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

## 7. ID 체계와 추적성

| 접두 | 소유 문서 | 뜻 |
|---|---|---|
| FR-NN | docs/PRD.md §13 | 기능 요구 |
| AC-NN | docs/PRD.md §15 | 수용 시나리오. AutoCAD 약어로 쓰지 않는다(AutoCAD는 `ACAD`) |
| OQ-NN | docs/PRD.md §18 | 미결 제품 결정 |
| C-NN | docs/PRD.md §4.4 | 후보 기능 |
| SPEC-NN | docs/specs/ | 명세 파일. 파일 안의 기능 항목은 `SPEC-NN.m` |
| H-<HOST>-NN | docs/specs/hosts/ | 호스트 지원표 행 (H-RHINO-01, H-REVIT-01, H-ACAD-01, H-ZWCAD-01) |
| PLAN-NN | docs/plans/ | 분리된 계획 파일. task는 `PLAN.md` 표의 행 ID |
| ADR-NNN | docs/decisions/ | 결정 기록 |
| R-NN | 각 문서 내부 | 검토 코멘트 (문서별 번호) |

규칙: SPEC 기능은 FR을 하나 이상 인용한다 · PLAN task는 SPEC을 인용한다 · VERIFY 기록은 AC와 H-*를 인용한다 · ADR은 OQ 또는 PLAN 장을 인용하고 PRD §18 해당 행에 `결정: ADR-NNN`을 역링크한다 · `docs/specs/README.md`가 FR → SPEC 대응표를 가진다.

## 8. 에이전트 규칙

- 산출물은 §2의 폴더에만 쓴다. 다음 병렬 문서는 만들지 않는다: `MVP_SCOPE.md` `TECH_DESIGN.md` `ARCHITECTURE.md` `NOTES.md` `SUMMARY.md`, 루트의 요약·보고 파일, `docs/superpowers/**`.
- PRD의 범위·요구를 바꾸는 제안은 §5 첨삭 코멘트 또는 ADR 초안으로만 낸다. 조용히 본문을 고치지 않는다.
- 빈 자리표시 문서를 만들지 않는다(`.gitkeep`은 예외).
- `PLAN.md`가 `status: review` 이상이 되기 전에는 `src/` `hosts/` `tests/`를 만들지 않는다.
- HTML을 손으로 편집하지 않는다. AI.md는 사용자 지시 없이 수정하지 않는다(제안은 첨삭으로).
- 본문은 한국어, 파일명·ID·코드는 ASCII. 기존 문서를 번역하지 않는다.
- 커밋·push는 사용자가 요청할 때만 한다.
- 세션 요약·인계는 채팅으로 낸다. 인계 문서가 필요하면 사용자가 위치를 정한다.

## 9. 플러그인·스킬 경로 덮어쓰기

- superpowers `brainstorming`이 쓰는 설계 문서 → 기능 동작이면 `docs/specs/SPEC-NN-<slug>.md`, 기술 구조면 `docs/plans/PLAN-NN-<slug>.md`. `docs/superpowers/`는 만들지 않는다.
- superpowers `writing-plans` → `docs/plans/PLAN-NN-<slug>.md`. 마스터는 `PLAN.md`이고 목차는 `DEVELOPMENT_GUIDE.md` §05를 따른다.
- 스펙 "커밋" 단계는 사용자가 요청할 때만 실행한다.
- 문서 작성·검토·첨삭·재배치 작업은 brainstorming 게이트 대상이 아니다. 코드를 만들기 시작할 때만 적용한다.
- 다른 플러그인이 기본 경로를 가지면 같은 원칙으로 §2에 맞춘다.

## 10. CLAUDE.md · AGENTS.md

- `CLAUDE.md`는 `@AI.md` 한 줄이다(Claude Code가 이 파일을 인라인한다).
- `AGENTS.md`는 "AI.md를 먼저 읽고 따르라"는 안내문이다(Codex 등은 `@` import를 지원하지 않고, Windows에서 심볼릭 링크는 피한다).
- 두 파일에 다른 규칙을 적지 않는다. Gemini CLI가 필요하면 `GEMINI.md`에 `@./AI.md` 한 줄을 둔다.

## 11. AI.md를 고치는 때

폴더·이름 규칙·헤더 필드·ID 접두·문서 종류·첨삭 표기가 바뀔 때만 고친다. 내용 변경(PRD/SPEC/PLAN)은 이 파일을 건드리지 않는다. 고칠 때 맨 위의 버전·날짜를 올린다.
