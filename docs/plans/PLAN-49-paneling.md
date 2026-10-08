---
id: PLAN-49
title: 패널링 — 미리보기 · 부재 · 최적화·타입화 (T-250~T-260)
status: draft
version: 0.8
updated: 2026-10-08
owner: agent:claude
related: [SPEC-16, SPEC-07, SPEC-15, ARCH-03, DESIGN, C-07, FR-14, FR-22, FR-24, AC-14, AC-20, AC-34, ADR-022, ADR-026, ADR-029, ADR-033, RESEARCH-04, RESEARCH-16, PLAN-29, PLAN-48, HOST-RHINO]
---

# 패널링

2026-10-08 사용자 지시 "패널링부터 계획 세워서 진행해줘"의 실행 계획이다. 동작은 [SPEC-16](../specs/SPEC-16-paneling.md), 공유 형식은 `src/contracts/paneling.ts`, 화면은 [Design](../../Design.md) SCR-33이다. 과거 경험은 [RESEARCH-04](../research/RESEARCH-04-jig-past-experience.md) §J-07, 사용자 메모는 [RESEARCH-16](../research/RESEARCH-16-domain-services-roadmap.md) §4다.

## 착수 조건과 범위

- **제품 결정:** 2026-10-08 사용자 지시로 C-07을 채택했다(PRD §4.4 C-07, §14.2 '패널링' 행). 단계는 사용자 메모의 세 단계 그대로다.
- **범위:** 연결 Rhino 문서의 서피스 면 하나(또는 한 폴리서피스의 여러 면)를 읽어 1단계 미리보기 → 2단계 부재 → 3단계 평면화·타입·결합부·일람표·평면 패널 재단 윤곽까지 계산하고, 단계마다 사람이 눌러 Rhino에 만든다. 하부 구조, 육각·보로노이·비주기·사용자 타일, PQ 최적화, 곡면 펼침, 메쉬 기준 면은 제외(SPEC-16 「범위 밖」, T-259·T-260 후속).
- **원칙:** 계산은 결정적 jig(엔진의 순수 TS + 공식 틀)이고 GH 캔버스 자동 배선은 jig 경로로 쓰지 않는다(RESEARCH-04 §J-07: 2026-07-23 비교에서 사용자가 결정적 경로를 택함). 과거 프로젝트 코드와 자료(S-06·S-12·Wireify 원장)는 읽기 참고만 하고 복사하지 않으며, 알고리즘은 새로 쓴다. 사용자가 띄운 Rhino에 붙거나 끄지 않는다. 실호스트 시험은 에이전트가 띄운 숨은 Rhino 8과 `.vide/` 아래의 합성 문서로만 하고, 자기 PID만 끄며, 끝나면 설치된 엔진의 `GET /api/v1/connectors`에서 rhino8 플러그인이 `current`인지 확인하고 아니면 Rhino가 꺼져 있을 때 `POST /api/v1/connectors/rhino8/install`을 부른다(`tests/integration/rhino-site-bake.mjs`의 `restoreInstalledPlugin`).
- **병렬 작업:** 각 묶음은 `src/contracts/paneling.ts`의 형식(`SurfaceSample`·`PanelLayout`·`MemberSet`·`PanelTyping`·단계별 설정값)만 맞추면 서로 기다리지 않는다. 계약과 스키마 시험(`tests/contract/paneling-contract.test.mjs`)은 2026-10-08 이 계획과 함께 만들었다. 계약을 바꾸는 티켓은 계약·스키마 시험을 같은 커밋에서 고치고 이 문서의 「현재 상태」에 적는다.

## 재사용할 기존 코드

| 위치 | 쓰는 것 | 티켓 |
|---|---|---|
| `src/jigs/official/geometry-kit/`(`polygon.ts`·`triangulate.ts`·`faces.ts`·`solid.ts`) | 2D 다각형 자르기·안쪽 줄이기·삼각 분할, 닫힌 솔리드 점검·부피 | T-252·T-254 |
| `src/jigs/official/jigs/site-model`·`buildable-mass`(공식 jig 배치·`jig.json`·`panel.json`·fixtures) | 공식 jig 꼴, 자체 시험 | T-252·T-253 |
| `src/jigs/bake/templates/*.cs`·`bake.ts`·`data-block.ts`(`splitMesh`·속성 규칙) | `vide.bake.mesh@1`(1단계 메쉬), `curves@1`(줄눈·재단 윤곽), `textdot@1`(번호), 덩어리 나누기 | T-255·T-257 |
| `hosts/rhino/worker/DirectExecution.cs`·`CodePolicy.cs` | 연결 Rhino에서 공식 틀 실행(읽기 틀의 되돌리기 기록 처리 보완 필요) | T-250·T-251 |
| `src/server/sdk-execution.ts` `runFixed`·`hosts/rhino/worker/WorkerExecutor.cs` | 숨은 Rhino 워커 경로(대안) | T-250 |
| `src/ui/viewport.ts` `OverlayItem`·`src/ui/kit/registry.ts` | jig 겹침 층(메쉬 종류를 더함, SPEC-15 T-239와 공유) | T-253 |
| `tests/integration/rhino-site-bake.mjs` | 숨은 Rhino 8 시험 꼴, `restoreInstalledPlugin` | T-250·T-258 |

## 순서와 묶음(wave)

```text
계약 src/contracts/paneling.ts (완료, 2026-10-08)
W1  T-250 SPIKE 면 계산 경로 ─────────────────────────────────────────────┐
W2  T-251 기준 면 읽기 ─┐  T-252 1단계 배치(kit) ─┐  T-253 화면·메쉬 겹침 ─┤
W3  T-254 2단계 부재(kit) ─┐  T-255 만들기 틀(1·2단계) ─┐  T-256 3단계(kit) ┤
W4  T-257 3단계 만들기·내보내기 ─┐  T-258 통합 VERIFY(숨은 Rhino 8) ────────┘
후속 T-259 PQ 평면화·곡면 펼침 SPIKE   T-260 추가 패턴·사용자 타일
```

- W1은 T-250 하나다. 면 읽기 경로와 만들기 경로의 크기·시간을 재고 나머지 묶음의 경로를 고정한다.
- W2의 세 티켓은 계약만 맞추면 동시에 한다. T-252·T-253은 계약을 통과하는 합성 `SurfaceSample` 고정 자료로 시작한다.
- W3: T-254·T-256은 순수 TS라 고정 자료로 동시에 한다(T-256은 T-254의 `MemberSet` 고정 자료를 씀). T-255는 T-251의 실제 표본과 T-252 결과가 필요하다.
- W4: T-257은 T-255·T-256 뒤, T-258은 모든 티켓 뒤다.

## T-250 SPIKE — 면 계산 경로와 크기·시간

- **기준:** SPEC-16.3·16.5 5·16.9 2, ARCH-03 §9·§13·§14('정확한 곡선 전송'), ADR-033(GH 얇은 도구), ADR-029.
- **질문:** ① 기준 면 표본을 어느 경로로 읽는가 — (a) 연결 Rhino에서 공식 읽기 틀(`vide.read.surface-grid@1`, `BrepFace.PointAt`·`NormalAt`·`CurvatureAt`·`IsPointOnFace`, `{{DATA_BASE64}}` 하나), (b) 숨은 Rhino 워커가 작업 사본을 열어 같은 계산, (c) GH lite(`gh_apply`·`gh_outputs`·`gh_bake`)로 패널링 정의. ② 표본 격자 크기별(64², 128², 256²) 읽기 시간과 응답 크기(16 MB 상한, 본문 65,536자). ③ 연결 문서 직접 실행이 읽기에도 되돌리기 기록을 여는지(`DirectExecution.cs`)와 읽기 전용으로 돌릴 방법. ④ 약 5천 패널을 매개변수 좌표로 넘겨 Rhino가 원래 면에서 만드는 만들기의 본문 수·시간(1천·5천), 메쉬(`mesh@1`)와 트림 면·두께 오프셋(`CreateOffsetBrep`)의 시간. ⑤ 엔진 TS의 표본 보간으로 계산한 꼭짓점과 실제 면 값의 차이(mm)와, 그 차이가 평면도 허용 오차(3 mm) 안에 드는 표본 크기. ⑥ 형상 지문을 읽기 틀과 만들기 틀이 같은 호스트 함수로 계산하는 방법(SPEC-16.3 2)과 그 안정성(같은 면을 두 번 읽어 같은 값, 면을 1 mm 옮기면 다른 값). ⑦ 이음매(닫힌 원통)와 극점(구 띠)이 있는 면에서 `closedU`·`singular` 판정과, 주기를 넘는 UV를 만들기 틀이 원래 면에서 만드는 방법. ⑧ 5천 패널 만들기가 본문 몇 묶음(= Rhino 되돌리기 기록 수)이 되는지.
- **방법:** `tools/spikes/2026-10-08-paneling/`에 합성 면 생성 스크립트와 측정 틀. 합성 면은 `.vide/spikes/paneling/` 아래 3DM — 이중 곡면(쌍곡 포물면 30 × 20 m, 트림 구멍 하나), 원통 띠(R 8 m, 120°), 닫힌 원통(R 4 m, 이음매), 구 띠(극점 하나 포함), 평면(대조군). 에이전트가 띄운 숨은 Rhino 8에서만 재고, 사용자 Rhino에는 붙지 않는다. GH 경로(c)는 T-133(실제 Rhino 8 GH 확인) 전이므로 가능한 만큼만 재고 결과에 그 사실을 적는다.
- **변경 범위:** `docs/tdd/SPIKE-2026-10-08-paneling.md`(질문·환경·결과·한계·채택 경로), `tools/spikes/2026-10-08-paneling/`, 결과에 따라 ARCH-03 §9.1에 읽기 틀과 패널 만들기 틀의 이름·데이터 꼴을 적는다.
- **선행:** 없음.
- **정상 검증:** 세 합성 면에서 (a)·(b)의 읽기 시간·크기 표, 5천 패널 만들기 시간 표, 보간 오차 표가 나옴.
- **실패 검증:** 면 아님·단위 없음·트림 밖 표본만 있는 면의 읽기 오류가 이유와 함께 나옴, 시간 초과를 일부러 낸 경우 문서에 아무것도 남지 않음(되돌리기 기록 수 확인).
- **완료:** SPIKE 문서에 채택 경로(추천: (a) 연결 Rhino 공식 읽기 틀 + 표본 TS 보간 미리보기 + 매개변수 좌표로 다시 계산하는 만들기 틀, (b)는 파일 연결만 있을 때의 대안)와 표본 기본 크기·패널 상한, 끝난 뒤 커넥터 `current` 확인 기록. 이 문서의 T-251·T-255 변경 범위를 결과로 고친다.

## T-251 기준 면 읽기와 '기준 면 고르기' 단계

- **기준:** SPEC-16.3·16.12, SPEC-01.11, SPEC-07.5, T-250 결과.
- **변경 범위:** 읽기 틀 `src/jigs/bake/templates/read-surface-grid.cs`(`vide.read.surface-grid@1`, ARCH-03 §9.1, 원형 `tools/spikes/2026-10-08-paneling/`)와 지문 글 `face-hash.cs`(`//@include`를 `templates.ts`가 펼침), 실행 경로는 새 호스트 방법 `direct-read`(`hosts/rhino/worker/DirectExecution.cs`·`editor-channel.ts`·`sdk-execution.ts` — 되돌리기 기록 없음, 결과 보관 없음, 문서가 바뀌면 되돌리고 `READ_CHANGED_DOCUMENT`; 플러그인 다시 빌드)이고 파일 연결만 있으면 숨은 워커 `execute`(SPIKE-2026-10-08-paneling 채택 경로 1). 응답의 base64 float64 묶음을 `SurfaceSample` 수 배열로 풀고, 기본 표본 128², `src/server/paneling-routes.ts`(고른 면 읽기·다시 읽기, 원격 세션 403), jig 입력 종류(사람 단계 '기준 면 고르기' — 지금 Rhino 선택을 받아 Link·객체 ID·면 번호를 고정, ARCH-03 §3 입력 종류 표에 더함), 읽은 표본을 작업본 입력 사본으로 저장하고 Live Sync 지문 변화 → '기준 면이 바뀜'.
- **선행:** T-250, 계약.
- **정상 검증:** `tests/server/paneling-read.test.mjs`(가짜 호스트 응답으로 표본 → `surfaceSampleSchema` 통과·저장·지문 변화 표시), 숨은 Rhino 8에서 합성 면 하나를 읽은 표본이 스키마를 통과.
- **실패 검증:** 메쉬·SubD를 고름 → '메쉬 기준 면은 아직 받지 않습니다', 연결 없음·단위 없음·면 없음·응답 한도 초과 → 이유와 함께 실패하고 앞 표본 유지, 읽기가 Rhino 되돌리기 목록에 기록을 남기지 않음.
- **완료:** 위 시험, `npm run typecheck`, 실호스트 확인을 T-258에 다시 포함.

## T-252 1단계 배치 — `vide/paneling-kit`과 공식 jig 골격

- **기준:** SPEC-16.2·16.4·16.5, SPEC-07.6·07.7.
- **변경 범위:** 새 라이브러리 `src/jigs/official/paneling-kit/`(`LIBRARY_MODULES`에 등록) — `sample.ts`(표본 격자의 3차 Catmull-Rom 보간 — 닫힌 방향은 감고 열린 가장자리는 이차 유령 점 `3P₀ − 3P₁ + P₂`, 쌍선형은 쓰지 않음(SPIKE-2026-10-08-paneling §6: 128²에서 3차 ≤ 0.01 mm, 쌍선형 ≤ 1.7 mm이고 `κ·h²/8`로 큰 면에서 3 mm 초과), 면 위 길이 누적표), `domain.ts`(재는 법 세 가지로 2D 영역 만들기), `patterns.ts`(사각·엇갈림·마름모·삼각 셀), `layout.ts`(셀 배치·트림 자르기 — 표본의 `inside` 깃발이 아니라 `trimLoops`로 자름(SPIKE §7: 깃발로 고른 칸의 꼭짓점이 실제로는 트림 밖이었음)·경계 처리 자르기/합치기/빼기·번호 `P-행-열`·크기 범위·목표 대비 편차) → `PanelLayout`. 공식 jig `src/jigs/official/jigs/paneling/`(`vide/paneling` 0.1.0): `jig.json`(입력 기준 면, 단계 `preview`·`members`·`optimize`, 설정값과 '물어볼 것' 기본, 추천값 표 SPEC-16.4 1), `skill.md`(질문 카드로 묻는 항목), fixtures. `src/jigs/catalog.ts`의 J-07은 T-258이 끝날 때 `planned`에서 바꾼다.
- **선행:** 계약. T-251과 무관(합성 표본 고정 자료).
- **정상 검증:** `tests/core/paneling-layout.test.mjs` — 평면 2.4 × 1.2 m에 1.2 × 0.6 → 4장(`P-1-1`…`P-2-2`, 꼭짓점 반시계·첫 꼭짓점이 시작 모서리 쪽), 원통 띠에서 면 위 길이 기준 크기가 기준 이소커브 위 목표 ±1 mm(가로·세로는 SPEC-16.2 공통 규칙 4로 잼), 매개변수 같은 간격은 `n = round(L / 크기)`이고 편차가 보고됨, 남는 부분은 시작 모서리 반대쪽 끝의 잘린 패널, 시작 모서리·축·[뒤집기]를 바꾸면 번호·꼭짓점 순서가 SPEC-16.5 2대로 바뀜, 엇갈림 짝수 행이 w/2 밀림, 삼각 `a`·`b`, 닫힌 원통 둘레 → 이음매에 잘린 패널 없음·`module`이 둘레에 맞춰짐, 구 띠 극점 셀 → 삼각 패널·`pole` 수, 투영 격자에서 접힌 면 → `folded-projection`, 트림 구멍 둘레 패널이 '경계'이고 이웃끼리 꼭짓점 키를 공유, 합치기 비율 미만 패널이 가장 긴 모서리 이웃에 합쳐지고 번호 `+행-열`·`mergedFrom`, 빼기 → `dropped` 수, 같은 입력 두 번 → 같은 번호·같은 지문. 5천 패널 배치 시간 기록(ARCH-03 §13 `live` 100 ms 목표).
- **실패 검증:** 패널 0개 → 단계 실패와 이유, 상한 2만 초과 → 계산 안 함, 빈 설정값 → 추천값으로 채우고 출처 `assumed`.
- **완료:** 위 시험, `jig:validate`, `npm run typecheck`.

## T-253 화면(SCR-33)과 메쉬 겹침

- **기준:** SPEC-16.1·16.4·16.8·16.11, Design SCR-33, SPEC-07.10, ADR-026 §4.
- **변경 범위:** `src/ui/viewport.ts` `OverlayItem`에 `mesh` 종류(꼭짓점·삼각, 면 색·윤곽, 항목별 색), `src/ui/kit/registry.ts` 층 `shape: 'mesh'` — SPEC-15(T-239)의 초과 부분 덩어리도 같은 종류를 쓰므로, 먼저 시작한 쪽이 만들고 다른 쪽은 쓴다. `src/jigs/official/jigs/paneling/panel.json`(단계 레일 셋, 기준 면 카드, 단계별 설정 묶음과 '물어볼 것'·'가정' 표지, 머리 수치, 색 기준 고르기, 일람표 서랍), 대화 경로 판정에 '패널링'·'패널 나눠'·'패널 분할' 등록(SPEC-07.18), 질문 카드 항목(SPEC-16.4).
- **선행:** 계약. T-252 전에는 계약을 통과하는 고정 결과로 만든다.
- **정상 검증:** `tests/integration/browser-paneling.mjs`(`test:browser`에 추가) — 고정 결과로 면 겹침이 그려지고, 설정값을 바꾸면 다시 계산 표시, '가정' 표지가 있으면 [부재 만들기]가 꺼지고 이유가 보임, 일람표 행 → 뷰포트 선택, 좁은 열(420px).
- **실패 검증:** 기준 면 없음 → 빈 상태 안내, 실패 패널이 색과 수로 보임, 원격 화면에서 만들기 단추 없음.
- **완료:** 브라우저 시험·`npm run typecheck`, SCR-33 대조 스크린숏(T-258 VERIFY에 첨부).

## T-254 2단계 부재

- **기준:** SPEC-16.6, SPEC-16.10.
- **변경 범위:** `paneling-kit/members.ts` — 2D 영역에서 줄눈만큼 줄이기(가운데·안쪽), 면으로 옮기기, 두께 방향으로 띄운 닫힌 메쉬(미리보기·점검용), 곡률 안전 한계(두께 ≥ 0.7 ÷ 최대 곡률 → 실패), 펼친 크기(평면이면 정확, 곡면이면 근사 표시), 판재 한도 초과, 줄눈 가운데 선 → `MemberSet`. jig 단계 `members`.
- **선행:** 계약(T-252의 `PanelLayout` 고정 자료로 시작).
- **정상 검증:** `tests/core/paneling-members.test.mjs` — 평면 2 × 2 격자 1.2 × 0.6, 줄눈 10 mm → 안쪽 모서리끼리 틈 10 mm이고 판 크기는 경계에 맞춤이면 1.195 × 0.595, 반 줄눈이면 1.19 × 0.59, 원통 띠(R 8 m)에서 면 위 틈이 10 mm ± `max(1 mm, 10%)`이고 `jointGap` 범위가 나옴(2D에서 같은 거리를 줄인 것과 다름을 확인), 두께 50 mm 부피, 원통 띠 볼록 쪽(바깥) 50 mm는 통과·오목 쪽으로 두께 × k ≥ 0.7이면 실패이고 반대쪽은 통과, 판재 1.2 × 1.5 한도는 90° 돌려 들어가면 초과 아님, 부재가 닫히고 바깥을 향함.
- **실패 검증:** 줄눈이 패널보다 큼 → 그 패널 `degenerate`, 닫히지 않음 → `not-closed`(고쳐 메우지 않음), 고르지 않은 틈 → `jointUneven`(실패 아님).
- **완료:** 위 시험, `npm run typecheck`.

## T-255 만들기 틀 — 1·2단계

- **기준:** SPEC-16.9, SPEC-07.12·07.13, ARCH-03 §9, T-250 결과.
- **변경 범위:** 공식 틀 `vide.bake.panels-uv@1`(기준 면 ID·면 번호·읽은 형상 지문·패널 UV 윤곽 → 지문을 다시 계산해 다르면 아무것도 만들지 않고 거절, 같으면 원래 면에서 잘라낸 열린 면, 주기를 넘는 UV는 `Brep.ChangeSeam`을 패널 맞은편에 놓고 3D 최근점으로 꼭짓점을 옮겨 만듦, 실제 꼭짓점 `corners[]`를 돌려주어 엔진이 표본과의 차이 mm를 계산, 틀 안 시간 한도 `budgetMs`), `vide.bake.panel-solids@1`(같은 입력 + 두께·방향 → `CreateOffsetBrep` 닫힌 부재, 한 조각·`IsSolid`·`IsValid`가 아니면 `failed[]`). 데이터 꼴은 ARCH-03 §9.1(T-250에서 적음), 원형은 `tools/spikes/2026-10-08-paneling/make-panels-uv.cs`. 1단계 [미리보기 만들기]도 메쉬가 아니라 `panels-uv@1` 열린 면(SPIKE §7: 5천 개 2.6~3.3 s, 패널마다 메쉬와 비슷하고 실제 면 위에 정확), 줄눈은 `curves@1`. 본문 하나에 패널 약 500개(5천 = 본문 10개 = Ctrl+Z 10번); 꼭짓점 표 공유로 줄이는 것은 선택. jig `make` 선언 셋(SPEC-16.9 1), 레이어 `패널링::…`, 속성 `PANEL_ATTRS`, 객체 키 `makeKey`(SPEC-16.9 6), 실패 패널 → `패널링::실패` 윤곽과 번호, 확정 점검 `paneling-confirmed`(계약의 `makeAllowed`, 가정 값이 남으면 [부재 만들기] 막음), 결과 카드의 'Rhino Ctrl+Z n번'. ARCH-03 §9.1에 두 틀을 적는다.
- **선행:** T-250(경로), T-251(실제 표본), T-252(배치), T-254(부재 UV).
- **정상 검증:** `tests/core/paneling-bake.test.mjs`(데이터 블록·덩어리 나누기·확정 점검), 숨은 Rhino 8에서 합성 이중 곡면 1천·5천 패널의 미리보기·부재 만들기와 [되돌리기] 한 번으로 모두 사라짐, 다시 만들기에서 사람이 고친 패널 보존, 1단계 크기를 바꾼 다시 만들기 → 고치지 않은 이전 패널은 지워지고 고친 것은 '이전 배치에서 보존'으로 셈.
- **실패 검증:** 일부러 깨뜨린 패널(UV가 트림 밖) → 실패 레이어와 결과 카드 이유, 가정 값 남음 → 만들기 거절, 면이 바뀐 뒤(지문 다름) → 쓰지 않고 다시 읽기 안내.
- **완료:** 위 시험, 시간 기록, 커넥터 `current` 확인.

## T-256 3단계 최적화·타입화

- **기준:** SPEC-16.7.
- **변경 범위:** `paneling-kit/flatness.ts`(최적 평면·평면도·패널별 평면화·벌어진 틈), `paneling-kit/classify.ts`(곡률 등급), `paneling-kit/typing.ts`(자세 무관 지문, 허용 오차 군집, 최대 타입 수에 맞춘 묶기, 거울상 구분, 넘는 패널 표시), `paneling-kit/connections.ts`(모서리 연결로 위상, 노드 만나는 수·각, 줄눈 꺾인 각·길이 → 노드·줄눈 타입), `paneling-kit/unroll.ts`(평면 패널의 재단 윤곽), `paneling-kit/schedule.ts`(패널·타입·결합부 표) → `PanelTyping`. jig 단계 `optimize`.
- **선행:** 계약(T-254의 `MemberSet` 고정 자료로 시작).
- **정상 검증:** `tests/core/paneling-typing.test.mjs` — 평면 격자 → 타입 1·등급 평면·노드 N-01(4가, 각 90°×4)·줄눈 J-01(꺾인 각 0°), 원통 띠 → 단곡 한 타입(경계 패널은 별도 타입), 쌍곡 포물면 → 복곡·타입 수가 허용 오차에 따라 줄어듦, 평면도는 SPEC-16.7 1의 검사점(꼭짓점·모서리 가운데·가운데)으로 재어 손으로 계산한 값과 같음, 최대 타입 수 3을 넣으면 3 이하이고 넘는 패널이 `overTypeTol`, 꼭짓점 수가 달라 못 지키면 `maxTypesUnmet`, 돌린 패널은 같은 타입·거울상은 다른 타입이고 `mirrorOf`, 같은 입력을 패널 순서만 섞어 넣어도 같은 타입 번호(결정적 묶기), 평면 위 삼각 패턴 평면도 0, 평면화 틈·면에서 벗어남이 이웃 꼭짓점 키로 계산됨, 재단 윤곽 둘레 = 판 둘레이고 첫 꼭짓점 원점·패턴 축 +X.
- **실패 검증:** 퇴화 패널(넓이 0) → 그 패널만 실패, 타입 수 0 요청은 설정값 검사에서 거절.
- **완료:** 위 시험, 5천 패널 타입화 시간 기록(`release` 2 s 목표), `npm run typecheck`.

## T-257 3단계 만들기와 내보내기

- **기준:** SPEC-16.9·16.11, SPEC-07.11.
- **변경 범위:** 공식 틀 `vide.bake.block-instances@1`(타입마다 블록 정의 하나와 패널마다 놓기, 블록 이름 `vide-panel-<타입>-<타입화 지문 앞 6자>`, 이전 정의는 놓기가 남지 않을 때만 지움), 결합부 표식(`textdot@1`, `nodeAt`·`jointAt`), 재단 윤곽(`curves@1` + 번호), 보고서 `reports/paneling.json`과 CSV 넷(`SCHEDULE_COLUMNS`, UTF-8 BOM), 내보내기 머리의 '가정 값 n개 포함'·'다시 계산 필요'(보고서는 머리 문장, CSV는 첫 줄이 열 머리라 파일 이름 끝). 놓기 계산은 `paneling-kit/place.ts`(`typePlacements`·`cutSheet`), 어댑터는 `src/jigs/bake/panels.ts`, 만들기 선언 `types`·`connections`·`cuts`·`cut-numbers`(화면 [타입 만들기]가 넷을 함께). ARCH-03 §9.1에 틀을 적는다.
- **선행:** T-255, T-256.
- **정상 검증:** 숨은 Rhino 8에서 타입 만들기 → 블록 정의 수 = 타입 수, 놓기 수 = 패널 수, [되돌리기] 한 번으로 정의까지 사라짐. CSV 머리가 `SCHEDULE_COLUMNS`와 같고 Excel(한국어)에서 깨지지 않음, 타입 번호가 다시 매겨진 다시 만들기에서 이전 정의와 섞이지 않음.
- **실패 검증:** 타입이 바뀐 다시 만들기 → 교체, 사람이 고친 놓기 → 보존, 블록 이름 충돌(사람이 만든 같은 이름) → 건드리지 않고 이유.
- **완료:** 위 시험, `npm run typecheck`, 커넥터 `current` 확인.

## T-258 통합 VERIFY

- **기준:** SPEC-16.1 완료 기준, AC-14·20·34, H-RHINO(읽기·Link ID·만들기).
- **변경 범위:** `docs/tdd/VERIFY-YYYY-MM-DD-paneling.md`, `tests/integration/rhino-paneling.mjs`(숨은 Rhino 8), `src/jigs/catalog.ts` J-07 상태를 구현됨으로.
- **시나리오:** ① `.vide/` 합성 쌍곡 포물면(트림 구멍 하나, 약 5천 패널) → 기준 면 고르기 → 1단계 네 패턴 → 2단계 → 3단계 → 단계별 만들기·되돌리기. ② 대화로 열기 → 질문 카드로 빠진 값 묻기 → 가정 값으로 미리보기 → 확인 뒤 부재 만들기. ③ 실패 주입: 메쉬 기준 면, 단위 없음, 두께 곡률 초과, 판재 초과, 최대 타입 수 초과, 면 수정 뒤 '기준 면이 바뀜'. ④ 브라우저: 실제 결과로 화면·일람표·내보내기. ⑤ 시간: 읽기·단계별 계산·만들기.
- **선행:** T-251~T-257.
- **완료:** VERIFY 문서에 시나리오별 결과·시간·발견, 이 문서의 「현재 상태」 갱신, 끝난 뒤 설치 엔진 커넥터 `current` 확인. 발견한 결함은 고치거나 F-n으로 남긴다.

## T-259 후속 SPIKE — PQ 평면화와 곡면 펼침

- **기준:** SPEC-16.7 2·6 「범위 밖」.
- **질문:** 전체 그물의 평면 사각 최적화(평면도 + 기준 면 근접 + 매끈함 에너지의 반복 투영)가 5천 패널에서 몇 초에 수렴하는가, 단곡 패널 펼침을 Rhino `Unroller`로 할 때 정확도·시간. 결과가 쓸 만하면 SPEC-16.7 2의 'pq'와 6의 곡면 펼침을 SPEC에서 범위로 옮기는 제안을 낸다.
- **선행:** T-256.

## T-260 후속 — 추가 패턴과 사용자 타일

- **기준:** SPEC-16 「범위 밖」, RESEARCH-04 §J-07(사용자 타일을 면에 강체 배치, 비주기 타일).
- **범위:** 육각·보로노이 셀(2D 씨앗 → 트림 영역 자르기 → 면으로), Rhino에서 그린 타일 묶음을 평면 영역에 받아 면 위 접평면 틀로 놓기, 어트랙터 개구율(상한 0.95). SPEC 보완 뒤 착수.
- **선행:** T-252.

## 현재 상태

| 티켓 | 상태 | 증거 |
|---|---|---|
| 계약 | 완료(2026-10-08), 같은 날 0.2 검토 보완: 이음매·극점·문서 허용 오차·표본 상한, 투영 평면, 꼭짓점 키(위상), 줄눈을 면 위 거리로 정의(`jointPlacement` → `boundaryJoint`), 줄눈 틈 범위, 평면화 틈·면에서 벗어남, 타입 `mirrorOf`·꼭짓점 수, 노드·줄눈 위치, `makeAllowed`·`makeKey`·`geomTol`·`SCHEDULE_COLUMNS` | `tests/contract/paneling-contract.test.mjs` 4개 통과 |
| T-250 | 완료(2026-10-08). 채택: (a) 연결 Rhino 읽기 틀 + 새 `direct-read`, base64 float64, 기본 128², 엔진 3차 보간, 매개변수 좌표 만들기 틀(약 500 패널/본문). (b) 숨은 워커는 파일 연결 대안, (c) GH lite는 쓰지 않음. T-251·T-252·T-255 변경 범위를 결과로 고침. 설치 엔진 rhino8 커넥터가 실험 뒤 `other`로 남음 — 사용자 Rhino가 꺼진 뒤 다시 설치·`current` 확인 필요 | [SPIKE-2026-10-08-paneling](../tdd/SPIKE-2026-10-08-paneling.md), `tools/spikes/2026-10-08-paneling/result.json` |
| T-251 | 완료(2026-10-08). 읽기 틀 `src/jigs/bake/templates/read-surface-grid.cs` + `face-hash.cs`(`templates.ts`가 `//@include` 펼침), 호스트 방법 `direct-read`(`DirectExecution.cs` `Read` — 되돌리기 기록·결과 보관 없음, 문서가 바뀌면 더한 것을 지우고 `READ_CHANGED_DOCUMENT`; 플러그인 다시 빌드 필요), jig 입력 종류 `host-surface`(작업본 `hostSurfaces`, 같은 내용 다시 읽기는 단계를 흐리지 않음), `src/server/paneling-routes.ts`(`GET …/paneling/surface` 상태·'기준 면이 바뀜'(Live Sync 행 지문), `POST …/paneling/surface/read` 고르기·다시 읽기, 원격 403), 기본 128²·면이 많으면 줄임. 남은 것: 파일 연결만 있을 때의 숨은 워커 읽기는 `ATTACHED_ONLY`로 거절(후속), '면이 너무 작음'(패널 크기 필요)은 T-252 배치가 판단, 화면 연결은 T-253. 실행 뒤 설치 엔진 rhino8 커넥터는 `other`(다른 Rhino 실행 중이라 다시 설치 못 함, 아래 T-250과 같은 남은 일) | `tests/server/paneling-read.test.mjs` 7개, `tests/integration/rhino-paneling-read.mjs`(숨은 Rhino 8.35: 트림 구멍 쌍곡면 128² 1.8 s·되돌리기 기록 없음·문서 그대로, 6면 상자 104², 이음매·극점, 1 mm 이동 → 지문 다름, 메쉬 거절, 쓰는 본문 거절·되돌림) |
| T-252 | 완료(2026-10-08). `src/jigs/official/paneling-kit/`(`vide/paneling-kit` 0.1.0, `LIBRARY_MODULES` 등록): 3차 Catmull-Rom 표본 보간·면 위 길이 표(`sample.ts`), 재는 법 세 가지(`domain.ts`, 닫힌 방향 셀 수 반올림·짝수, 기준 이소커브 가운데 대체, 투영은 표본 사각형 역보간 + 3차 면 뉴턴 보정·여러 장 = 접힘), 네 패턴(`patterns.ts`, 엇갈림은 위아래 T자 점을 꼭짓점으로 가진 6각 윤곽), 면 사각형·트림 고리 자르기와 꼭짓점 키(`clip.ts`, 격자선 위 고리 점은 µm 단위로 영역 밖으로 밀고 퇴화하면 nm 단위로 흔들어 다시), 경계 처리·번호·윤곽 방향·극점·크기(`layout.ts`), 추천값 표(`settings.ts`, 세 단계), 단계 함수 `previewStep`. 공식 jig `vide/paneling` 0.1.0(`jig.json` 세 단계 설정값 전부 '물어볼 것'과 추천값, 단계는 `preview`만 — `members`·`optimize`는 T-254·T-256이 더함, `skill.md`, 자체 시험 2건, 자리 `panel.json`은 T-253이 바꿈). 기준 면 입력은 T-251의 `host-surface`(통합 때 임시 `host-document`에서 바꿈). 카탈로그 J-07의 id를 `vide/paneling`으로 바꿔 목록이 계획 카드 대신 도구 카드를 보이고 상태는 T-258까지 `planned`. 알려진 한계: 한 셀이 트림으로 두 조각이 되면 큰 조각만 패널로 두고 `degenerate`로 보고, 머리 안내문(기준 이소커브 이동·크기 맞춤)은 `LayoutOutcome.notes`에만 있고 `PanelLayout`에는 없음. 시간: 쌍곡 포물면 128² 표본·0.34 m 격자 5,562 패널 배치 중앙값 약 72 ms(`live` 100 ms 안) | `tests/core/paneling-layout.test.mjs` 15개, `npm run jig:test -- src/jigs/official/jigs/paneling`, `tests/integration/browser-jigs.mjs`(계획 카드 수 5 → 4) |
| T-253 | 완료(2026-10-08), 고정 결과로. `OverlayItem` `mesh`는 T-239가 먼저 만들어 그대로 쓰고, 층 `shape: 'mesh'`(윤곽 부채꼴·`{v,f}`)와 범주 색 `--ov-cat-1…12`를 더함. 공식 jig 폴더에는 `panel.json`만(부품 6개, 연결 없음 — 단계 id 고정·설정값은 키로 단계 구분, ARCH-03 §5.1). 만들기 단추는 만들기 id `preview`·`members`·`types`를 기다림(T-255·T-257), 기준 면 카드는 통합 때 T-251 경로에 맞춤: `GET /projects/:id/paneling/surface?instanceId=`의 `picked`·`summary`(넓이 `extent`·`documentName` 더함)·`changed`, `POST …/paneling/surface/read` `{instanceId, mode}`의 `ok:false`는 이유 한 줄로 보이고 이전 표본을 둠. 대화 경로 단어는 `OFFICIAL_TOOL_ROUTING['vide/paneling']`(skill.md 단어와 합침). 보고서(HTML) 단추는 T-257 | `tests/core/paneling-screen.test.mjs`(8), `tests/integration/browser-paneling.mjs`(`test:browser`) |
| T-254 | 완료(2026-10-08). `paneling-kit/members.ts` `buildMembers` → `MemberSet`: 이웃과 꼭짓점 키 둘을 함께 쓰는 모서리는 줄눈/2, 경계·트림 모서리는 `flush` 0·`half` 줄눈/2를 **면 위 거리**로 옮김 — 모서리 양 끝·가운데에서 표본 야코비안(J·ν의 J·e 직각 성분)으로 UV 거리로 바꾸고 세 값에 맞춘 직선으로 옮긴 뒤 이웃 모서리끼리 만나는 점이 새 꼭짓점(같은 직선 위 T점은 두 끝의 평균), 감김이 뒤집히거나 모서리 방향이 바뀌거나 꼬이면 `degenerate`('줄눈이 패널보다 커서 판이 남지 않음'). 줄눈 틈은 공유 모서리마다 양 끝·가운데에서 두 판 모서리 사이 3D 거리로 재어 `jointGap`, `max(1 mm, 10%)` 넘으면 `jointUneven`(실패 아님), 줄눈 선은 두 판 모서리의 가운데 5점. 두께 쪽 곡률 = 판 안 원표본(닫힌 방향은 주기만큼 옮겨 셈)과 검사점 보간값의 `k·(두께 방향)·(뒤집기)` 최댓값, `두께 × k ≥ 0.7` → `thickness-curvature`('두께 불가 · 곡률 반지름 r mm'). 닫힌 메쉬는 평면 판이면 윤곽+가운데 부채꼴, 곡면 판이면 모서리 2분할+안쪽 고리 하나(별 모양이 아니면 귀 자르기), 면 법선으로 두께만큼 띄우고 옆면을 이음 — 모든 모서리가 양방향 한 번씩이고 부피가 양수가 아니면 `not-closed`(고치지 않음). 펼친 크기는 판 검사점의 최적 평면에서 패턴 축 정렬 외접(평면도 ≤ `tol`이면 실제, 아니면 `flatSizeApprox`), 면적·부피는 메쉬로. 판재 한도는 90° 돌려 들어가면 초과 아님, 초과는 `overStock`에만(실패 아님). 1단계 실패·`dropped` 패널도 같은 순서로 실패를 달고 남김(뺀 패널의 모서리는 이웃에게 경계). `layoutHash` = 면 지문·1단계 설정 지문의 지문(`layoutFingerprint`), 설정은 `memberSettingsFromParams`(판재 0 × 0 = 한도 없음). jig 단계 `members`(`vide/paneling-kit#membersStep`, `step.preview`·1단계·2단계 설정 읽음, `release`), 2단계 설정값 `affects: ["members"]`. 시간: 쌍곡 포물면 5,562 패널 약 0.5~0.8 s. 알려진 한계: 미리보기 메쉬를 모두 넣으면 5천 패널 결과 JSON이 약 12 MB(`buildMembers(…, { solids: false })`로 뺄 수 있음, 작업본 저장 방식은 T-255에서 정함), 틈은 면 위 측지 거리가 아니라 3D 직선 거리(줄눈 폭에서 차이 무시) | `tests/core/paneling-members.test.mjs` 11개, `npm run jig:test -- src/jigs/official/jigs/paneling`(fixtures에 `members` 기대값) |
| T-255 | 완료(2026-10-08). 공식 틀 `vide.bake.panels-uv@1`·`vide.bake.panel-solids@1`(같은 본문 `panel-make.cs`, `face-hash.cs` 끼움) — 면 머리(객체·면 지문·키 앞머리·두께 offset·시간 한도·실패 레이어·공통 속성)와 본문 안 꼭짓점 표, 지문이 다르면 아무것도 만들지 않고 `rejected` → `BAKE_SURFACE_CHANGED`(409, '기준 면이 바뀜 · 다시 읽기'), 실패 패널은 `layerRoot::실패`에 윤곽 + 번호(`<key>:no`), 틀이 `vide-panel-id`·`vide-panel-size`·`vide-status`·`vide-deviation-mm`(같은 매개변수의 실제 면 − 표본)를 씀. 어댑터 `src/jigs/bake/panels.ts`(선언 `rows: 'paneling'`, 키 `makeKey`, 배치 지문 = `PanelLayout` 정규 JSON SHA-256, 줄눈 `curves@1`), 만들기 선언 `preview`·`members`·`joints`(화면 [부재 만들기]가 둘을 함께), 점검 `paneling-confirmed`(`src/jigs/runtime/paneling-confirmed.ts`), 결과 카드 '실패 레이어'·'최대 차이 · 표본이 거칩니다'·'Ctrl+Z n번'·'이전 배치에서 보존 n'. 실제 Rhino에서 드러나 고친 것: 트림 고리가 64점이라 구멍 가장자리 꼭짓점이 실제 트림 밖 몇 mm → 10 mm 안이면 트림 위 가장 가까운 점으로 옮김(아니면 `UV_OUTSIDE_TRIM`); 수천 개 교체의 지울 목록이 첫 본문에 다 들어가지 않음 → `renderChunks`가 지울 목록을 여러 본문에 나눔; 기준 면만 있는 작업본의 연결을 `hostSurfaces`에서 찾음. 시간(숨은 Rhino 8.35, 쌍곡면 30 × 20 m 구멍 하나): 미리보기 1,133개 2.0~2.2 s·본문 3개, 5,421개 6.0~6.9 s·본문 15개, [되돌리기] 0.34~0.45 s에 모두 사라짐, 같은 배치 다시 만들기에서 사람이 옮긴 패널 보존·나머지 1,132 교체(지울 목록 때문에 본문 5개), 크기를 바꾼 다시 만들기에서 고친 패널 '이전 배치에서 보존 1'·나머지 지움, 부재(50 mm, 1 % 줄인 윤곽) 1,133개 모두 닫힌 바깥 향 솔리드 3.4~3.5 s·본문 6개, 표본 차이 최대 0.0013 mm. 남은 것: 이음매를 넘는 패널은 실제 Rhino에서 다시 보지 않음(T-258), 시험 플러그인은 작업 폴더에서 다시 빌드(주 작업 폴더 빌드는 T-251 전이라 `direct-read` 없음). 설치 엔진 rhino8 커넥터는 시작 전부터 `other`이고 사용자 Rhino가 실행 중이라 다시 설치하지 않음(T-250과 같은 남은 일) | `tests/core/paneling-bake.test.mjs` 8개, `tests/core/bake.test.mjs`, `tests/integration/rhino-paneling-bake.mjs`(숨은 Rhino 8) |
| T-256 | 완료(2026-10-08). 계산 시험은 대신 쓰는 2단계 고정 자료(줄눈 0, `tests/fixtures/paneling-members-stub.mjs`)와 실제 2단계 결과로. `paneling-kit/optimize.ts` `optimizePanels`(`SurfaceSample`+`PanelLayout`+`MemberSet`+1단계 방향+`OptimizeSettings` → `PanelTyping`)와 단계 함수 `optimizeStep`(`inputs.steps.preview`·`members`), `flatness.ts`(검사점 — 모서리 가운데는 면 위 길이의 절반, 가운데는 평균에 가장 가까운 면 위 점으로 매개변수 매김과 무관(SPEC-16.7 1에 적음) — 최적 평면·평면도·'best-fit' 평면화·면에서 벗어남(그 꼭짓점 면 법선 방향)·평면화 틈 = 같은 꼭짓점 키의 이웃과의 이동량 차의 크기(줄눈 0이면 SPEC의 판 꼭짓점 거리와 같음)), `classify.ts`, `typing.ts`(Horn 사원수 강체 정렬 + 앞면 표지 점으로 뒤집기·거울 막음, 정렬 무관 열쇠(정렬한 모서리·중심 거리)와 둘레 칸으로 후보 줄임, 번호 순 묶기, 최대 타입 수는 가장 가까운 대표끼리 합치기, 거울상 짝), `connections.ts`(꼭짓점 키로 노드·줄눈, 접평면 각, 꺾인 각 부호), `unroll.ts`(재단 윤곽·판 가로세로), `schedule.ts`(표 넷 `scheduleRows`·`scheduleCsv` BOM — 내보내기 단추는 T-257). 1·2단계 실패·판 넓이 0 패널은 자리표 타입 `T-00`(SPEC-16.7 4에 적음), 'pq'는 'best-fit'으로 계산하고 '준비 중' 안내, jig 값 `maxTypes` 0 = 제한 없음·계산 함수에 0을 주면 거절. W3 통합 때 `jig.json`에 `optimize` 단계(`vide/paneling-kit#optimizeStep`, `step.preview`·`step.members`·방향·3단계 설정 여섯 읽음, `release`)를 더하고 3단계 설정값에 `affects: ["optimize"]`, 실제 T-254 `MemberSet`(줄눈 10 mm)으로 이어 계산하는 시험을 더함. 만들기 키의 배치 지문은 미리보기·부재·줄눈이 같은 `layoutFingerprint`를 씀. 시간: 쌍곡 포물면 128²·0.34 m 격자 5,562 패널 타입화 중앙값 약 170 ms(`release` 2 s 안, 타입 98) | `tests/core/paneling-typing.test.mjs` 15개, `npm run jig:test -- src/jigs/official/jigs/paneling`(`optimize` 단계) |
| T-257 | 완료(2026-10-08). 공식 틀 `vide.bake.block-instances@1`(`block-instances.cs`, 블록 머리 + 본문마다 쓰는 정의만, 놓기는 회전 9 + 원점), `paneling-kit/place.ts` — `typePlacements`(패널마다 자기 2단계 판의 최적 평면 판·틀을 다시 구하고 타입 대표 윤곽을 순환 번호 맞춤 2D 강체 맞춤으로 놓음, '허용 오차 넘음'·`T-00`·1·2단계 실패는 놓지 않고 실패 윤곽으로)·`cutSheet`(평면 판 재단 윤곽을 기준 면 오른쪽 XY에 타입·번호 순 격자), 어댑터 `panels.ts` `typingRows`(키 `type:`·`node:`·`joint:`·`cut:`, 블록 이름의 타입화 지문 `typingHashOf`, 두께 쪽 부호), 만들기 선언 `types`·`connections`·`cuts`·`cut-numbers`(모두 `paneling-confirmed`, 화면 [타입 만들기]의 `also`, 결과 카드 이름), 보고서 틀 `reports/paneling.json`(머리 문장에 '가정 값 n개 포함'·'다시 계산 필요' — 보고서 입력에 `inputs.counts.notFinal` 더함), 화면 일람표 서랍의 [보고서](HTML 내려받기)와 CSV 파일 이름 끝의 표지(`exportName` 셋째 인자), SPEC-16.9 5·16.11 보완. 정의 만들기에서 숨은 Rhino로 드러나 고친 것: 트림 가장자리 패널의 대표 윤곽에 문서 허용 오차보다 가까운 꼭짓점이 있어 `CapPlanarHoles`가 실패(`BLOCK_GEOMETRY`) → 허용 오차 안 꼭짓점을 합치고, 안 되면 뚜껑·옆면을 `JoinBreps`. 시간(숨은 Rhino 8.35, 쌍곡면 30 × 20 m 구멍 하나, 줄눈 10 mm·두께 50 mm): 1,133 패널·185 타입 — 세 단계 계산 0.45 s, [타입 만들기](블록·결합부 3,455·재단 1,131·번호) 본문 25개 12.8 s, [되돌리기] 한 번 3.1 s에 정의까지 사라짐; 사람이 옮긴 놓기 보존·나머지 1,130 교체; 타입 허용 오차 5 mm(185 → 84 타입)로 다시 만들기 → 새 지문 정의 84개, 이전 정의는 보존된 놓기가 쓰는 1개만 남음; 사람이 만든 같은 이름 정의는 그대로이고 그 타입 패널 73개가 `BLOCK_NAME_TAKEN`으로 실패 레이어에; 5,421 패널·147 타입 — 본문 112개 41 s(대부분 결합부 표식 약 1.6만 개), [되돌리기] 3.6 s. 남은 것: 5천 패널의 본문 수(Ctrl+Z 112번)를 줄이려면 결합부 표식·재단 윤곽의 꼴을 압축하는 전용 틀이 필요(후속), 일람표 '표본 차이' 열은 아직 비어 있음(만들기 결과의 패널별 차이를 작업본에 남기지 않음), Excel 실제 열기는 확인 못 함(BOM·UTF-8·머리만 시험). 시험 플러그인은 작업 폴더에서 다시 빌드(주 작업 폴더 빌드는 T-251 전). 설치 엔진 rhino8 커넥터는 시작 전부터 `other`이고 사용자 Rhino가 실행 중이라 다시 설치하지 않음(T-250과 같은 남은 일) | `tests/core/paneling-types-make.test.mjs` 9개, `tests/core/paneling-bake.test.mjs`, `tests/core/s06-report.test.mjs`, `tests/integration/rhino-paneling-types.mjs`(숨은 Rhino 8) |
| T-258 | 완료(2026-10-08), 3단계 [타입 만들기]·보고서는 T-257 통합 뒤 같은 시험으로 다시 확인. 숨은 Rhino 8.35에서 대화로 열기(규칙 경로 → 질문 카드 `by: decision` → 가정 값 미리보기·`vide-assumed` → `paneling-confirmed`가 막던 부재 만들기 통과), 쌍곡면 5,421장 네 패턴(1단계 0.09~0.16 s) → 2단계(0.25 s) → 3단계(타입 147, 0.22 s), 미리보기 만들기 5.3 s·본문 14·되돌리기 한 번, 부재·줄눈 만들기 33.8 s·본문 61·되돌리기 한 번, 실패 주입 여섯(메쉬·단위 없음·두께 곡률·판재·최대 타입 수·면 이동 → '기준 면이 바뀜'과 만들기 거절), 실제 경로 위 SCR-33 화면·CSV 넷·화면의 미리보기 만들기. 고친 결함 F-1: JIG 목록에서 연 화면이 `geometry` 실행으로 library 단계를 모두 건너뛰어 계산하지 않음 → `COMPUTING_PARTS`를 쓰는 패널은 `confirmed`로 실행. 남긴 것 F-2(요청의 'A x B' 크기·패턴 이름 읽기). 카탈로그 J-07 `available`. 설치 엔진 rhino8 커넥터는 `other`이고 사용자 Rhino 실행 중이라 되돌림 보류(Rhino를 닫은 뒤 커넥터 설치) | [VERIFY-2026-10-08-paneling](../tdd/VERIFY-2026-10-08-paneling.md), `tests/integration/rhino-paneling.mjs`, `tests/integration/browser-paneling.mjs` |
| T-259·T-260 | 후속 | — |

## 결정이 필요한 질문

| # | 질문 | 추천 기본값 | 대안 |
|---|---|---|---|
| 1 | 면 계산 경로 | T-250에서 확인해 채택: 연결 Rhino의 공식 읽기 틀(`direct-read`) + 표본 TS 3차 보간 + 매개변수 좌표로 다시 계산하는 만들기 | 숨은 Rhino 워커(파일 연결만 있을 때) / GH lite(쓰지 않음) |
| 2 | 1단계 빈 입력 | 추천값으로 바로 미리보기하고 '가정' 표지, 부재·타입 만들기만 확인 요구 | 모든 입력을 묻고 나서야 계산 |
| 3 | 크기를 재는 기본 | 면 위 길이 | 매개변수 같은 간격 / 평면·입면 투영 |
| 4 | 경계 패널 기본 | 자르기 | 이웃에 합치기 / 빼기 |
| 5 | 평면화 1차 | 패널별 최적 평면 + 벌어진 틈 보고 | PQ 전체 최적화(T-259) |
| 6 | 타입화 기본 | 타입 허용 오차 2 mm, 최대 타입 수 제한 없음, 돌림 같음·거울상 다름 | 거울상도 같은 타입 |
| — | 결정됨(2026-10-08) | C-07 채택, 세 단계, 되묻기로 구성 | — |
