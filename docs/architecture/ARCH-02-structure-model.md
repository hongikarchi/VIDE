---
id: ARCH-02
title: 구조 분석 jig의 해석 모델 계약과 Rust 코어
status: review
version: 0.3
updated: 2026-09-30
owner: agent:claude
related: [FR-23, SPEC-06, ADR-019, ADR-020, RESEARCH-09, RESEARCH-10, ARCH-01, ARCH-03, PLAN-17, PLAN-23]
---

# 구조 분석 jig의 해석 모델 계약과 Rust 코어

SPEC-06이 정한 동작을 구현하는 물리 계약과 구성요소 경계를 정한다. 공통 서버·저장·호스트 경계는 [ARCH-01](ARCH-01-system.md), jig 런타임·실행 위치·성능 목표는 [ARCH-03](ARCH-03-jig-runtime.md)을 따른다. 필드 후보와 선례는 [RESEARCH-09 §3](../research/RESEARCH-09-structure-analysis-methods.md), 1차 TS 보완의 근거는 [RESEARCH-10 §10](../research/RESEARCH-10-vide-restructure.md)에 있다.

## 1. 구성요소와 위치

| 구성요소 | 위치 | 책임 |
|---|---|---|
| 해석 모델 계약 | `src/contracts/structure-model.ts` | 모델·결과·요약 JSON의 zod 스키마와 타입. 서버·UI·시험이 공유 |
| 입력 구성(초안) | `src/jigs/structure/input.ts`, `sections.ts` | Rhino 중심선(scene `line`)·부재 솔리드(메시 주축·외곽 치수 → KS H형강 대조)·CAD Sync(보·기둥 레이어와 레벨) → 모델 초안. 끝점 병합·T자 접합·교차 분할, 역할·접합 규칙·지점, 레이어·이름·UserString의 역할·단면 힌트 |
| 점검·하중 전처리 | `src/jigs/structure/review.ts`, `loads.ts` | 결정적 점검 `checkModelStatic`(SPEC-06.2), 단위 하중 안정성 확인 `stabilityProbe`·`probeIssues`, 둘을 합친 `checkModel`, 실패 원인 분류 `classifyFailures`(06.7), 면하중 한 방향 분배와 하중 장부 |
| 라이브러리 jig `vide/structure-analysis` | `src/jigs/official/structure-analysis/` | 범용 구조 jig와 S-06 골조 jig가 함께 쓰는 1차 TS 층(PLAN-23 T-052·T-054, 0.2.0). `buildFrameModel`(계획 → 모델: 역할·지점·접합·하중·설계 부재를 명시), `segmentCurve`(곡선 레일만 분할), `runAnalysis`·`analyzeSummary`(점검 → 안정성 확인 → 코어 → 원인 분류 → 요약; 작업 스레드), `referenceDeflection`(참고 처짐), `summarize`(요약 결과), `sizeGroups`(KS H 단면 선정, §4.3), `stableMarks`·`schedule`·`toCsv`(부호·일람표·CSV, §4.4), `sectionProps`·`hProps`(물량용 단면 성질), `memberGeometry`(설계 부재의 현·솟음·반지름), 점검 `comboEcho`·`uncheckedListed`·`analysisConfirmed`·`markUnique`·`scheduleComplete` |
| 작업 스레드 | `src/jigs/official/structure-analysis/worker.ts`, `worker-entry.ts` | 코어 호출은 `worker_threads` 하나에서만 돈다(ARCH-03 §6.3). 키가 같은 요청은 대기 중인 것만 남기고 이전 것을 `STRUCTURE_SUPERSEDED`로 거절한다(가장 최근 요청만). 실행 중인 요청은 취소하지 않는다. 엔진 스레드는 JSON 직렬화와 결과 수신만 한다 |
| 진입·저장(범용 jig) | `src/jigs/structure/index.ts` | 초안·수정(작은 수정 목록 `draftEditsSchema`), 프로젝트별 기록 `<데이터>/structure/<프로젝트>.json`(초안 + 확정 결과. 확정 기록은 코어 결과 `result`와 같은 해석의 요약 `summary`·판정 범례 `colorBands`를 함께 둔다; 이전 기록에는 없을 수 있다). 라이브러리의 진입점을 다시 내보낸다. 동기 경로 `analyzeConfirmed`는 시험·대체용으로 남아 있고 서버 라우트는 쓰지 않는다. 오래됨 = 원래 Sync가 없거나 같은 문서(`sourceDocument.documentId`)의 더 새 Sync가 있음 |
| 해석·검정 코어 | `src/native/structure/` (Rust crate `vide-structure`) | 강성 조립·풀이·부재력, KDS 부재 검정·B1·처짐, 판정. 입력 JSON 외 I/O 없음 |
| 코어 연결 | `src/jigs/structure/core.ts` | 빌드된 코어 경로 `corePath()`, 로드 `loadCore()`, 검증 포함 동기 호출 `analyzeStructure(model) → result`, 모델 해시 |
| 서버 경로 | `src/server/server.ts` | `GET /projects/:id/jigs/structure`(초안·확정·오래됨), `POST …/draft`(Sync와 입력 형태), `POST …/edit`(수정 목록), `POST …/analyze`(`confirm: true`; 작업 스레드의 `analyzeSummary(mode: 'confirmed', detail: 'full', key: 'project:<id>')`로 돌고 엔진 스레드는 기다리기만 한다. 점검 오류·불안정이면 422와 문제 목록, 같은 프로젝트의 더 새 요청에 밀리면 409 `PROJECT_BUSY`, 코어가 없으면 503). 요청 본문 1 MB 한도 때문에 모델 전체는 서버에만 둠 |
| 화면 | `src/ui/structure-jig.tsx`, 뷰포트 `tint` | 입력 선택·초안 그룹별 단면 지정·면하중·AI 초안 검토 요청(`jig.kind = structure-draft-review`, 첨부만 보고 판정)·확정·결과 표·행 선택 → 모델 선택·판정색 |
| 검증 자료 | `tests/structure/fixtures.mjs`, `frame-fixtures.mjs`, `frames/`, `tests/structure/*.test.mjs` | 닫힌 해·공개 벤치마크·불변량 fixture, 합성 골조 계획(`bayPlan`=`lb-k`, `gridPlan`, `archPlan`), 단면 선정·부호·일람표 시험(`sizing`·`marks`·`schedule`) |
| 개발용 기준 해석기 | `tools/structure/` | PyNite 교차 검증 스크립트(개발 전용, 배포 제외) |

**코어 구동 방식: Node-API 네이티브 애드온**(napi-rs, [SPIKE](../tdd/SPIKE-2026-09-29-structure-core-binding.md)). `cargo build --release --lib`의 `vide_structure.dll`을 `process.dlopen`으로 로드한다. 라이브러리 경로에서는 작업 스레드가 같은 애드온을 자기 스레드에 따로 로드한다. 같은 crate의 실행 파일(`src/bin/vide-structure.rs`, 반드시 별도 `--target-dir`로 빌드)은 코어 오류를 서버와 격리해야 할 때의 대체 경로다. crate 빌드 산출물(`target/`)은 저장소에 넣지 않으며, 데스크톱 패키지는 빌드된 코어 파일만 명시 경로로 포함한다. 작업 스레드 진입 파일은 `worker-entry.ts`이며 빌드본에서는 같은 자리의 `.js`를 먼저 찾는다.

## 2. 단위·좌표·축 규약

- **단위는 필드 이름에 붙인다.** 좌표·길이 `_m`, 힘 `_kN`, 모멘트 `_kNm`, 선하중 `_kNpm`(kN/m), 면하중 `_kPa`(kN/㎡), 탄성계수·강도 `_MPa`, 단면 치수 `_mm`, 단면 성질 `_mm2`·`_mm4`·`_mm3`. 코어는 내부에서 한 단위계로 환산한다. 호스트 문서 단위(mm 등)는 입력 구성 단계에서 m로 바꾼다.
- 연직축은 전역 +Z.
- **부재 국부축(1·2·3):** 1축은 i → j. 2축은 단면의 웨브 방향이며, 연직이 아닌 부재는 1축을 포함하는 연직면 안에서 +Z 쪽을 향한다. 연직 부재(1축과 Z의 방향 코사인 절댓값 ≥ 0.9999)는 2축이 전역 +X다. 3축 = 1 × 2. `betaDeg`는 1축을 중심으로 2·3축을 오른손 방향으로 돌린다. 강축 휨은 3축에 대한 모멘트 `M3`, 약축 휨은 `M2`다. `buildFrameModel`은 기둥의 `strongAxis`(웨브의 평면 방향)에서 `betaDeg = atan2(y, x)`를 만든다.
- 부재 단부해제와 지점은 같은 6자유도 표기(`dx dy dz rx ry rz`)를 쓰되, 지점은 전역축, 단부해제는 부재 국부축(1·2·3 → `dx dy dz rx ry rz` 순서) 기준이다. 값은 `true`(구속·해제)/`false`로만 쓴다.

## 3. 해석 모델(`vide.structure.model/1`)

```text
StructureModel
  schema: "vide.structure.model/1"
  meta: { name, sources[{ kind: "rhino"|"cad"|"layout", documentId, syncId? }], mergeTolerance_m, createdAt? }
  materials[]: { id, grade, E_MPa, G_MPa, density_kNpm3, Fy_MPa, Fu_MPa, fyByThickness?[{ tMax_mm, Fy_MPa }], provenance? }
  sections[]:  { id, name, shape: "H"|"BH"|"BOX"|"PIPE"|"L"|"C"|"ROD",
                 dims_mm{...}, source: "KS D 3502"|"user"|"ai", props?{ A_mm2, I2_mm4, I3_mm4, J_mm4, Z2_mm3, Z3_mm3, S2_mm3, S3_mm3, Cw_mm6 }, provenance? }
  nodes[]:     { id, xyz_m[3], support?{ dx,dy,dz,rx,ry,rz: bool }, provenance? }
  members[]:   { id, i, j, section, material, role: "column"|"girder"|"beam"|"brace"|"other",
                 kind: "frame"|"truss"|"tensionOnly", betaDeg, releases?{ i{…}, j{…} },
                 source?{ documentId, objectId }, design?{ Lb_m, K2, K3, Cb }, provenance? }
  loadPatterns[]: { id, nature: "D"|"L"|"Lr"|"S"|"W"|"E"|"N", selfWeight: bool }
  loads[]:     { id, pattern, type: "memberUniform"|"memberPoint"|"nodePoint",
                 targets[], direction: "-Z"|"+X"|…|"local-2"…, value_kN / value_kNpm, position?, provenance? }
  areaLoads[]: { id, pattern, polygon_m[[x,y,z]…], value_kPa, spanDirection?, provenance? }
  combinations[]: { id, terms[{ pattern, factor }], limitState: "strength"|"service" }
  analysis:    { kind: "linearStatic", lateralRestraint?{ nodes[] (1개 이상), dofs["dx","dy"] } }
  designMembers[]: { id, role, tag?, segments[], length_m, kind: "span"|"cantilever", supports[] (1~2 절점),
                     Lb_m?, K?, Cb?, provenance? }
  checkSettings: { code: "KDS 14 31 10", deflectionLimits{ role → n (L/n) }, colorBands[0.7, 1.0] }

provenance = { by: "auto"|"ai"|"user", assumed: bool, note? }
```

- `areaLoads`는 코어에 넘기기 전에 `src/jigs/structure/loads.ts`가 한 방향 분배로 부재 선하중으로 바꾸고, "입력 = 전달 + 미전달" 하중 장부를 결과에 붙인다.
- **설계 부재와 해석 조각(SPEC-06.1).** 물리 부재 하나가 여러 해석 조각으로 나뉘면 `designMembers[]`가 조각 순서·지지 절점·역할을 갖는다. 조각은 정확히 한 설계 부재에 속하고(`superRefine`이 검사), `source.objectId`가 있으면 그 객체로 되돌려 찾아간다. 코어는 1차에서 `designMembers`를 읽지 않으며(serde가 무시), 라이브러리의 `memberMapFrom(model)`이 요약·참고 처짐의 대응표로 쓴다. `designMembers`가 비어 있으면 부재 하나가 곧 설계 부재다. 코어가 설계 부재를 직접 판정하는 것은 T-067이다.
- **설계 길이(SPEC-06.6).** 코어는 `design.K2·K3`를 조각 길이에 곱하고 `Lb_m`은 주어진 값을 그대로 쓴다. 그래서 `buildFrameModel`은 조각마다 `K = K_eff × L_기준 / L_조각`, `Lb_m`은 물리 부재에서 잰 값을 넣는다. 보·거더: 정모멘트 구간은 횡지지(`bracedAt`) 간격, 강접 단부의 부모멘트 구간은 지정한 변곡점(`negativeZones`)까지, 모르면 지지점 사이 전 길이; `K3` 기준 길이는 지지점 사이 전 길이, `K2` 기준 길이는 그 조각의 `Lb`. 캔틸레버(`freeEnd`)는 전 길이와 K 2.0. 기둥: 구속 레벨·지점·상단이 나누는 구간 길이가 기준이고, 가장 높은 구속 레벨 위 구간은 `swayK`(기본 2.0), 그 아래는 1.0. `Cb`는 1.0(가정). 값은 소수 9자리로 반올림해 같은 계획이 같은 해시를 갖게 한다. 사용자 덮어쓰기(`Lb_m`·`K`·`Cb`)는 `designMembers[].provenance.by = "user"`다. 조각에 `design`이 없으면 요약이 그 조각을 '미완'(`na`)으로 둔다(코어의 통과를 통과로 세지 않음).
- **수평 구속(SPEC-06.5).** `lateralRestraint.nodes`에 적은 절점만 잡는다. 이전 계약의 `aboveZ_m`(그 높이 위 모든 절점)은 계약에서 뺐다. 코어의 `LateralRestraint.above_z`는 남아 있으나 zod가 거절하므로 TS에서는 닿을 수 없으며, T-067에서 코어 쪽도 지운다. `buildFrameModel`은 `restraintLevels_m`·기둥별 `restraintZ_m` 높이의 기둥 절점을 만들어(없으면 기둥을 그 높이에서 나눔) 여기에 넣는다.
- **자중·명목 수평하중.** `buildFrameModel`은 D 패턴의 `selfWeight`를 늘 켠다(계약 기본값은 `false`). 명목 수평하중은 성격 `N`의 패턴 `NX_D`·`NX_L`·`NY_D`·`NY_L`이며, 절점마다 `nodePoint` 하중으로 `비율 × 그 절점에 모이는 패턴 중력`(선하중 반분배 + 강재 자중 반분배, 단면적은 `section-props.ts`가 코어와 같은 식으로 계산)을 +X·+Y로 가한다. 조합 `{ D: 1.2, L: 1.6, NX: 1 }`은 항 `D×1.2 + L×1.6 + NX_D×1.2 + NX_L×1.6`이 된다. 기본 비율 0.002, 기본 조합 4개(`1.2D+1.6L`, `1.2D+1.6L+NX`, `1.2D+1.6L+NY`, `D+L`).
- **접합.** 모델에는 `releases`만 있다. 초안 경로의 규칙·예외는 `DraftOptions.jointExceptions`, 계획 경로는 `FrameMember.ends`(`rigid`|`pinned`)와 H형강 기둥의 강축 허용각 규칙(`FramePlan.jointRule`, 기본 ±15°, 벗어나면 핀으로 내리고 가정 목록에 적음)이 정한다(SPEC-06.4).
- 모델 해시(정렬되지 않은 JSON 그대로의 SHA-256, `core.ts` `modelHash`)가 확정·결과·유효성(SPEC-06.3)의 기준이다. `designMembers`·`design`도 해시에 든다.

## 4. 결과(`vide.structure.result/1`)

```text
StructureResult
  schema, modelHash, coreVersion, elapsed_ms, status: "ok"|"error", error?
  diagnostics: { mechanisms[{ node, dof }], autoRestrained[{ node, dof }], equilibrium[{ combo, error_rel }], warnings[] }
  combos[]: 해석한 조합 id (입력 순서)
  nodes:   { [id]: { disp{ combo → [6] } (m·rad, 전역축), reaction?{ combo → [6] } (kN·kNm, 구속 자유도가 있는 절점만) } }
  members: { [id]: { length_m, stations[0, .25, .5, .75, 1], forces{ combo → [{ N, V2, V3, T, M2, M3 }…] }, deflection_mm?{ combo → 최대 상대 처짐 } } }
  checks[]: { member, status: "pass"|"fail"|"incomplete"|"error", ratio, governing{ combo, clause },
              parts[{ clause, ratio, combo, values{…} }], cause?: "member"|"input-suspect", notes[] }
  summary: { steel_kN, maxRatio, failCount, incompleteCount }
  notChecked[]: 문자열(횡력·접합부·기초·EJ 등)
```

**부재력 부호:** 부재 위치 x(i 끝 0 → j 끝 1)에서 자른 면에 **j 쪽 부분이 i 쪽 부분에 가하는 힘·모멘트**를 국부축 성분으로 보고한다. 따라서 N은 인장이 양수, 압축이 음수다. 연직 하중을 받는 수평 단순보는 중앙 M3가 양수(처짐 모멘트)이고, 이때 V2 = −dM3/dx다. 절점 변위·반력은 전역축 성분이다. 반력은 지점이 구조물에 가하는 힘이다.

**구속 반력:** 수평 구속 절점도 구속 자유도가 있으므로 `nodes[id].reaction`에 X·Y 반력이 나온다. 이것이 "횡력 시스템(또는 기존 구조물)이 받아야 할 힘"이며(SPEC-06.5), 요약이 기둥별로 묶는다(§4.1). 곡선 거더의 추력은 구속 절점(기둥 절점)에만 나타나고 곡선 중간 절점에는 반력이 없다(`tests/structure/summary.test.mjs`).

**부재 처짐:** 양 끝 변위의 Hermite 보간에 양단 고정보의 하중 특수해를 더한 값에서 두 끝을 잇는 현을 뺀 **조각 기준** 상대 처짐이다. 설계 부재 기준의 처짐은 §4.2 참고 처짐이 따로 낸다. 캔틸레버의 끝 처짐 판정은 코어 범위 밖이며 `notChecked`에 남긴다.

판정 `incomplete`는 입력이 모자라 검정하지 못한 경우, `error`는 계산 실패다. `cause`·`notes`의 원인 분류는 `classifyFailures`가 확정 경로와 라이브러리 경로 모두에서 붙인다.

### 4.1 요약 결과(`vide.structure.summary/1`)

라이브러리가 해석마다 돌려주는 작은 결과이며, 미확정 미리보기(SPEC-06.3)도 같은 형태다. 크기 목표는 1,500조각 ≤ 50 KB(ARCH-03 §13; 합성 13×13 격자 1,550조각·913설계 부재에서 약 43 KB). 행은 튜플이고 조항·조합은 색인으로 가리킨다.

```text
StructureSummary
  schema: "vide.structure.summary/1", mode: "confirmed"|"preview", label: "확정 결과"|"미확정 미리보기"
  status: "ok"|"unstable"|"error"|"invalid" (invalid = 점검 오류로 해석하지 않음), error?
  modelHash, coreVersion, ms (점검부터 요약까지)
  combos[]: { id, limitState, terms{ pattern → factor } }          ← 입력 조합 그대로(점검 combo-echo)
  statusCodes: ["ok","warn","ng","na","err"], colorBands[0.7, 1.0], clauses[]
  members[]: [id, status, ratio, clause, referenceDeflection_mm, limit_mm, segments[[status, ratio]…]]
             (설계 부재 하나에 한 행. 조각 순서는 designMembers[].segments. 조각이 하나면 segments는 [])
  reactions: { sumZ_kN{ combo }, lateral_kN{ combo → [X, Y] } (구속 절점 합), perColumn[[column, z_m, comboIndex, Rx_kN, Ry_kN]…] (구속 절점마다 가장 큰 조합), maxLateral_kN }
  maxRatio, steel_t, counts{ ok, warn, ng, na, err }, margin{ name: "중력 조합 부재 검정 여유", value: 1 − maxRatio }
  issues[]: 점검·안정성 확인·설계 값 누락(DESIGN_INCOMPLETE)
  assumptions[]: buildFrameModel의 가정 목록, unchecked[]: 코어의 notChecked + 라이브러리 항목, disclaimer
```

상태 규칙: 코어 `fail` → `ng`, `incomplete` → `na`, `error` → `err`, `pass`는 `design`이 없으면 `na`, 검정비가 첫 색 경계 이상이면 `warn`, 아니면 `ok`. 설계 부재의 상태는 조각 중 가장 나쁜 것(`ng` > `err` > `na` > `warn` > `ok`), 검정비는 최댓값이다. `counts`는 설계 부재 수다. 미리보기 요약은 라이브러리가 저장하지 않고, 부재 만들기 앞의 `analysis-confirmed`는 `mode = confirmed`·`status = ok`·같은 `modelHash`를 요구한다.

### 4.2 참고 처짐(`referenceDeflection`)

설계 부재마다 사용성 조합별로 양 끝 지지 절점을 잇는 현(캔틸레버는 뿌리 절점)에서 잰 절점 변위의 수직 성분과 코어의 조각 처짐을 합친다. 조각마다 `max(r_a, r_b, (r_a + r_b)/2 + d)`(r = 양 끝 절점의 현 기준 변위, d = 조각 처짐)를 취하므로 어느 조각의 처짐보다도 작지 않다. 한계는 역할별 `L/n`(`checkSettings.deflectionLimits`), 캔틸레버는 `L/180`(가정). 행 `{ id, role, kind, combo, length_m, deflection_mm, segmentMax_mm, limit_mm, ratio, exceeds }`는 요약의 `members[4..5]`로 들어가고 4상태 판정에는 합치지 않는다(ADR-019 후속 결정, RESEARCH-10 A8). 판정에 합치는 것은 T-067이다. 단면 선정(§4.3)은 이 값을 선정 기준으로만 쓴다.

### 4.3 단면 선정(`sizeGroups`, `vide.structure.sizing/1`)

SPEC-06.12의 선정 루프. 입력은 (확정한) 모델과 대응표, 출력은 **제안**이다: `{ status: converged|not-converged|error, iterations, target, groups[], assignments{ 설계 부재 → 단면 }, model(단면을 바꾼 사본), summary?(마지막 해석이 제안과 같을 때만), issues[], assumptions[], note }`. 모든 해석은 `mode: 'preview'`이며 저장하지 않고, 제안은 적용한 뒤 다시 확정해야 쓰인다(`analysis-confirmed`는 새 해시를 요구한다).

- **묶음** = 역할 × 경간 띠(`spanBands_m`, 기본 6·9·12 m 상한) × 구역(`zoneOf`, 곡선 부재는 자동으로 따로). 역할은 기본 기둥·거더·작은보(`roles`).
- **후보** = KS H(`src/jigs/structure/sections.ts`의 `KS_H`) 가운데 역할별 춤 상한(`depthMax_mm`, 기본 거더·작은보 900, 기둥 400) 이하, 무게(단면적) 오름차순. 기둥은 b/h ≥ 0.9인 기둥 계열만.
- **추정** = 관측 검정비 × (현재 단면의 용량 / 후보의 용량). 용량은 지배 조항에 따라 `capacity.ts`가 코어 식을 흉내 내 계산한다: `F2 강축 휨`은 그 부재의 `Lb`·`Cb`로 F2 횡비틀림좌굴 모멘트, `E3 압축`은 조각의 K·L과 r로 E3 임계응력 × A, `세장비`는 1/(KL/r), `G2 전단`은 웨브 면적, `D2 인장`은 A, `F6 약축 휨`은 Z2, `처짐`은 I3, `H1-1 조합`은 축·휨 항의 역할별 가중 조화평균. 참고 처짐은 I3 비율로 따로 추정하고 `deflectionTarget`(기본 1.0)과 비교한다. 이 추정은 판정이 아니며 다음 해석이 바로잡는다.
- **반복**: 해석 → 묶음마다 모든 후보를 추정으로 비교해 목표(`target`, 기본 0.90)를 만족하는 가장 가벼운 후보를 고름 → 바뀐 묶음에 적용 → 다시 해석. 해석한 단면이 목표를 놓치면 그 묶음에서 다시 쓰지 않고(`rejected`), 만족하면 알려진 통과 단면으로 기억한다(`passed`). 고른 단면이 현재 단면과 같아 안정되면, 해석 예산이 2회 이상 남았을 때 한 번만 바로 아래 후보를 추정 오차 15 % 안에서 시험한다(세장한 기둥·LTB에서 추정이 보수적이기 때문). 최대 `maxIterations`(기본 6)회 해석.
- **끝맺음**: 모든 묶음이 안정되면 `converged`. 예산이 끝났는데 바뀔 묶음이 남았으면 그 후보가 이미 통과한 단면이면 그것을(상태 `ok`), 아니면 마지막 해석 단면과 후보 중 무거운 쪽을 택하고 `SIZING_NOT_CONVERGED` 경고를 낸다. 상한 안에 후보가 없으면 `no-candidate`로 두고 단면을 바꾸지 않으며, 전체 표에서 되는 가장 가벼운 단면을 `beyondLimit`으로 알린다(`SIZING_NO_CANDIDATE`). 추정할 값이 없으면 `unchanged`.
- 명목 수평하중은 출발 모델의 자중 기준으로 두고 선정 중 갱신하지 않는다(가정 목록에 적음). 참조하지 않게 된 단면은 제안 모델에서 뺀다.

### 4.4 부호와 일람표(`stableMarks`, `schedule`, `toCsv`)

**부호 원장(`vide.structure.marks/1`)** `{ rule{ projectPrefix, prefixes{ 태그·역할 → 접두 }, assumed }, groups{ 부호 → { prefix, role, tag?, section, curved, radius_m?, rise_m? } }, members{ 설계 부재 → 부호 }, chords{ 설계 부재 → [시작점, 끝점] }, next{ 접두 → 마지막 번호 } }`. jig 기록이 계산 사이에 보관한다.

- 접두 기본값(가정, 표준 파일 확인 전): 기둥 `SC`, 거더 `SG`, 테두리보 `SEG`, 작은보 `SB`, 내민보 `SCB`, 개구부 보 `STB`(가새 `SV`, 기타 `SM`). `map.tags`(계획 역할)가 있으면 그것으로, 없으면 모델 역할로 고른다. 프로젝트 접두는 부호 앞에 붙는다(`P1-SG1`). 문자는 `[A-Za-z0-9_-]`만(`bake-args-safe`와 같은 규칙).
- 묶음 기준 = 접두 × 단면(첫 조각) × 곡선 여부. 곡선은 `memberGeometry`의 현 길이·솟음(현에서 잰 최대 이격, 허용오차 max(10 mm, 2 × 병합 허용오차))·반지름(`c²/(8s) + s/2`)이 같은 묶음의 대표값과 반지름 0.05 m·솟음 0.01 m 안이면 같은 부호다.
- 번호는 접두마다 1부터, 묶음이 처음 나타나는 부재의 위치 순서(현 중점의 z·y·x를 0.05 m로 양자화)로 매긴다. 이전 원장이 있으면 (1) 같은 id의 부재가 같은 묶음이면 부호를 유지하고, (2) 나머지는 같은 묶음의 기존 부호(퇴역한 것도 되살림)를 받거나 접두의 다음 번호를 새로 받는다. 번호는 다시 쓰지 않는다. 부호가 바뀐 부재는 `changed`, 지금 아무도 쓰지 않는 부호는 `retired`.
- 새 id의 부재는 이전 현과 대조해 `correspondence`에 적는다: 이전 현 안에 들어가면 `split`, 이전 현들을 품으면 `merge`, 양 끝이 같으면 `same-line`, 평면에서 같고 높이만 다르면 `moved`(S-18 `stable_ids` 규칙의 이식, RESEARCH-08 §3.6).
- 점검 `mark-unique`: 모든 설계 부재에 부호가 있고, 문자 규칙을 지키며, 쓰이는 두 부호가 같은 직선 묶음(접두·단면)을 가리키지 않는다.

**일람표(`vide.structure.schedule/1`)** `{ mode, label, modelHash, rows[], totals{ count, length_m, weight_t }, unlisted[], assumptions[], disclaimer }`. 행 = `{ mark, role, tag?, section, sectionName, count, totalLength_m, unitWeight_kgpm, weight_t, maxRatio, governing, status, counts{ ok, warn, ng, na, err }, curved, radius_m?, rise_m?, chord_m?, members[] }`. 단위중량은 `sectionProps`(코어 `section.rs`와 같은 식) × 7,850 kg/m³의 물량용 값이고 검정에 쓰지 않는다. 판정 열은 넘겨준 요약의 부재 행에서 오며(가장 나쁜 상태, 최대 검정비와 그 조항), 요약이 없으면 비어 있고 `label`은 '미확정 미리보기'다. `toCsv`는 제목 행(`부재 일람표`, 결과 표지, 안내문) → 머리글 → 부호 행 → 합계(→ 부호 없음)이며 UTF-8 BOM·CRLF·전체 인용, `= + @ -`로 시작하는 문자열 앞에 `'`를 붙인다(S-06 진단 CSV와 같은 형식). 점검 `schedule-complete`: 모든 설계 부재가 정확히 한 행에 있다.

## 5. 코어 내부

- 3D 12자유도 보 요소(전단변형 무시), 단부해제는 정적 응축, 트러스는 축력만, `tensionOnly`는 반복 비활성화(최대 반복 수 초과 시 경고).
- 전체 강성은 희소 대칭 행렬로 조립하고 faer의 희소 분해로 푼다. 지점 누락·기구는 분해 중 0 피벗으로 찾아 해당 절점·자유도를 `mechanisms`로 돌려준다.
- 조합은 선형 중첩으로 계산한다. 2차 해석(P-Δ)은 이번 범위 밖이며, 기둥의 부재 2차 효과는 검정 단계의 B1으로 반영한다.
- 부재 검정: KDS 14 31 10(압축 E3, 휨 F2·F3, 전단 G2, 조합 H1-1, 세장비), B1 = Cm / (1 − Pr/Pe1) ≥ 1, 처짐은 부재 현 기준 상대 처짐. 조항 표기는 KDS 14 31 10이 따르는 AISC 360의 장 기호(E3·F2·F6·G2·H1-1·D2)로 두며, KDS 조항 번호 대응은 원문 확인 뒤 추가한다. H형강의 세장판 압축은 E7 유효 단면적(웨브 c1 0.18·c2 1.31, 플랜지 c1 0.22·c2 1.49)으로 계산한다. 인장 파단·블록 전단, 비조밀 웨브 휨(F4·F5), 각형·원형 강관의 비조밀 휨은 구현하지 않았고 해당하면 `incomplete`와 메모로 표시한다. `design.Lb_m`이 있으면 Cb는 `design.Cb`(없으면 1.0)를 쓰고, 둘 다 없을 때만 모멘트 도형에서 Cb를 구한다.
- 결정성: 같은 입력이면 같은 결과(정렬·반올림 규칙 고정).
- 라이브러리 경로는 코어 결과를 zod로 다시 검증하지 않는다(우리 코어의 출력이고 1,500조각 결과가 수 MB라 검증 비용이 크다). 동기 경로 `analyzeStructure`는 계속 검증한다.

## 6. 검증 자료

`tests/structure/fixtures.mjs`의 fixture는 {출처, 단위, 입력 모델, 기대값과 값별 허용오차, 가정}을 담는다. 교과서·공개 벤치마크의 "정답" fixture와 회귀용 골든 출력은 분리한다. 1차 목록은 RESEARCH-09 §4.1의 BM-03(닫힌 해), BM-06(보 횡비틀림좌굴), BM-10(PyNite 차분), BM-11(불변량), BM-12(KS 단면 성질)와 닫힌 해 보·골조이며, 구체 목록과 허용오차는 PLAN-17이 소유한다.

라이브러리 시험(`tests/structure/frame-model.test.mjs`, `summary.test.mjs`, `worker.test.mjs`)은 합성 계획만 쓴다: `lb-k`(강접 거더 + 작은보 2.5 m의 Lb·K, 구속 레벨 위 기둥의 swayK), 구속 절점·자중·명목 하중·조합 항, 강축 규칙, 곡선 분할과 아치 추력, 참고 처짐 ≥ 조각 처짐, 요약 크기·시간, `combo-echo`·`unchecked-listed`·`analysis-confirmed`, 미완·invalid·unstable, 작업 스레드의 이벤트 루프 지연(< 50 ms)과 최신 요청 우선.

단면 선정·부호·일람표 시험(`sizing.test.mjs`, `marks.test.mjs`, `schedule.test.mjs`)은 동기 `runAnalysis`를 해석 함수로 넘긴다: `hProps`가 KS 표(A·I·S·단위중량 1 %)와 맞음, 한 칸 골조가 6회 안에 수렴하고 각 묶음의 바로 아래 후보를 실제로 해석하면 목표나 처짐 한계를 넘김, 춤 상한 250 mm의 '후보 없음'(단면 유지·필요한 춤 안내), 세 작은보로 나뉜 12 m 거더를 참고 처짐이 올림(참고 처짐 기준을 풀면 더 가벼운 단면), 반복 상한·점검 오류 처리; 부호는 SC/SG/SB, ±1 mm 이동 후 원장 유무와 관계없이 같은 부호, 단면 변경 → 새 번호·퇴역·번호 재사용 없음·되살림, 곡선의 반지름·솟음 묶음, split/same-line/moved 대응, 규칙 문자 검사와 `mark-unique`; 일람표의 KS 단위중량·개수·길이·합계, 요약과 같은 판정 열, 미리보기 표지, 곡선 열, `schedule-complete`, CSV의 BOM·CRLF·수식 문자 처리. `server.test.mjs`는 확정 경로가 작업 스레드를 거쳐 `summary`·`colorBands`를 기록에 남기는지 본다.
