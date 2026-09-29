---
id: ARCH-02
title: 구조 분석 jig의 해석 모델 계약과 Rust 코어
status: review
version: 0.1
updated: 2026-09-29
owner: agent:claude
related: [FR-23, SPEC-06, ADR-019, RESEARCH-09, ARCH-01, PLAN-17]
---

# 구조 분석 jig의 해석 모델 계약과 Rust 코어

SPEC-06이 정한 동작을 구현하는 물리 계약과 구성요소 경계를 정한다. 공통 서버·저장·호스트 경계는 [ARCH-01](ARCH-01-system.md)을 따른다. 필드 후보와 선례는 [RESEARCH-09 §3](../research/RESEARCH-09-structure-analysis-methods.md)에 있다.

## 1. 구성요소와 위치

| 구성요소 | 위치 | 책임 |
|---|---|---|
| 해석 모델 계약 | `src/contracts/structure-model.ts` | 모델·결과 JSON의 zod 스키마와 타입. 서버·UI·시험이 공유 |
| 입력 구성 | `src/jigs/structure/input.ts`, `sections.ts` | Rhino 중심선(scene `line`)·부재 솔리드(메시 주축·외곽 치수 → KS H형강 대조)·CAD Sync(보·기둥 레이어와 레벨) → 모델 초안. 끝점 병합·T자 접합·교차 분할, 역할·접합 규칙·지점, 레이어·이름·UserString의 역할·단면 힌트 |
| 점검·하중 전처리 | `src/jigs/structure/review.ts`, `loads.ts` | 모델 점검(SPEC-06.2, 단위 하중으로 코어를 돌려 기구 확인), 실패 원인 분류(06.7), 면하중 한 방향 분배와 하중 장부 |
| 진입·저장 | `src/jigs/structure/index.ts` | 초안·수정(작은 수정 목록 `draftEditsSchema`)·확정 해석, 프로젝트별 기록 `<데이터>/structure/<프로젝트>.json`(초안 + 확정 결과). 오래됨 = 원래 Sync가 없거나 같은 문서(`sourceDocument.documentId`)의 더 새 Sync가 있음 |
| 해석·검정 코어 | `src/native/structure/` (Rust crate `vide-structure`) | 강성 조립·풀이·부재력, KDS 부재 검정·B1·처짐, 판정. 입력 JSON 외 I/O 없음 |
| 코어 연결 | `src/jigs/structure/core.ts` | 빌드된 코어를 불러 `analyze(model) → result` 제공 |
| 서버 경로 | `src/server/server.ts` | `GET /projects/:id/jigs/structure`(초안·확정·오래됨), `POST …/draft`(Sync와 입력 형태), `POST …/edit`(수정 목록), `POST …/analyze`(`confirm: true`, 차단 오류면 422). 요청 본문 1 MB 한도 때문에 모델 전체는 서버에만 둠 |
| 화면 | `src/ui/structure-jig.tsx`, 뷰포트 `tint` | 입력 선택·초안 그룹별 단면 지정·면하중·AI 초안 검토 요청(`jig.kind = structure-draft-review`, 첨부만 보고 판정)·확정·결과 표·행 선택 → 모델 선택·판정색 |
| 검증 자료 | `tests/structure/fixtures/`, `tests/structure/*.test.mjs` | 닫힌 해·공개 벤치마크·불변량 fixture |
| 개발용 기준 해석기 | `tools/structure/` | PyNite 교차 검증 스크립트(개발 전용, 배포 제외) |

**코어 구동 방식: Node-API 네이티브 애드온**(napi-rs, [SPIKE](../tdd/SPIKE-2026-09-29-structure-core-binding.md)). `cargo build --release --lib`의 `vide_structure.dll`을 `process.dlopen`으로 로드한다. 같은 crate의 실행 파일(`src/bin/vide-structure.rs`, 반드시 별도 `--target-dir`로 빌드)은 코어 오류를 서버와 격리해야 할 때의 대체 경로다. crate 빌드 산출물(`target/`)은 저장소에 넣지 않으며, 데스크톱 패키지는 빌드된 코어 파일만 명시 경로로 포함한다.

## 2. 단위·좌표·축 규약

- **단위는 필드 이름에 붙인다.** 좌표·길이 `_m`, 힘 `_kN`, 모멘트 `_kNm`, 선하중 `_kNpm`(kN/m), 면하중 `_kPa`(kN/㎡), 탄성계수·강도 `_MPa`, 단면 치수 `_mm`, 단면 성질 `_mm2`·`_mm4`·`_mm3`. 코어는 내부에서 한 단위계로 환산한다. 호스트 문서 단위(mm 등)는 입력 구성 단계에서 m로 바꾼다.
- 연직축은 전역 +Z.
- **부재 국부축(1·2·3):** 1축은 i → j. 2축은 단면의 웨브 방향이며, 연직이 아닌 부재는 1축을 포함하는 연직면 안에서 +Z 쪽을 향한다. 연직 부재(1축과 Z의 방향 코사인 절댓값 ≥ 0.9999)는 2축이 전역 +X다. 3축 = 1 × 2. `betaDeg`는 1축을 중심으로 2·3축을 오른손 방향으로 돌린다. 강축 휨은 3축에 대한 모멘트 `M3`, 약축 휨은 `M2`다.
- 부재 단부해제와 지점은 같은 6자유도 표기(`dx dy dz rx ry rz`)를 쓰되, 지점은 전역축, 단부해제는 부재 국부축(1·2·3 → `dx dy dz rx ry rz` 순서) 기준이다. 값은 `true`(구속·해제)/`false`로만 쓴다.

## 3. 해석 모델(`vide.structure.model/1`)

```text
StructureModel
  schema: "vide.structure.model/1"
  meta: { name, sources[{ kind: "rhino"|"cad"|"layout", documentId, syncId }], mergeTolerance_m, createdAt }
  materials[]: { id, grade, E_MPa, G_MPa, density_kNpm3, Fy_MPa, Fu_MPa, fyByThickness?[{ tMax_mm, Fy_MPa }] }
  sections[]:  { id, name, shape: "H"|"BH"|"BOX"|"PIPE"|"L"|"C"|"ROD",
                 dims_mm{...}, source: "KS D 3502"|"user"|"ai", props?{ A_mm2, I2_mm4, I3_mm4, J_mm4, Z2_mm3, Z3_mm3, S2_mm3, S3_mm3, Cw_mm6 } }
  nodes[]:     { id, xyz_m[3], support?{ dx,dy,dz,rx,ry,rz: bool }, provenance }
  members[]:   { id, i, j, section, material, role: "column"|"girder"|"beam"|"brace"|"other",
                 kind: "frame"|"truss"|"tensionOnly", betaDeg, releases?{ i{…}, j{…} },
                 source?{ documentId, objectId }, design?{ Lb_m, K2, K3, Cb } (값마다 auto/user), provenance }
  loadPatterns[]: { id, nature: "D"|"L"|"Lr"|"S"|"W"|"E", selfWeight: bool }
  loads[]:     { id, pattern, type: "memberUniform"|"memberPoint"|"nodePoint",
                 targets[], direction: "-Z"|"+X"|…|"local-2"…, value_kN / value_kNpm, position?, provenance }
  areaLoads[]: { id, pattern, polygon_m[[x,y,z]…], value_kPa, spanDirection?, provenance }
  combinations[]: { id, terms[{ pattern, factor }], limitState: "strength"|"service" }
  analysis:    { kind: "linearStatic", lateralRestraint?{ nodes[] | aboveZ_m, dofs["dx","dy"] } }
  checkSettings: { code: "KDS 14 31 10", deflectionLimits{ role → n (L/n) }, colorBands[0.7, 1.0] }
  jointRules:  { default: "column-rigid,beam-on-girder-pin,brace-pin,column-base-pin", exceptions[{ member, end, value, by, note }] }

provenance = { by: "auto"|"ai"|"user", assumed: bool, note? }
```

- `areaLoads`는 코어에 넘기기 전에 `src/jigs/structure/`가 한 방향 분배로 부재 선하중으로 바꾸고, "입력 = 전달 + 미전달" 하중 장부를 결과에 붙인다.
- 물리 부재(Rhino 곡선 하나)가 여러 해석 부재로 나뉘면 `source.objectId`를 공유하고, 결과는 그 객체로 되돌려 찾아간다.
- 모델 해시(정렬된 JSON의 SHA-256)가 확정·결과·유효성(SPEC-06.3)의 기준이다.

## 4. 결과(`vide.structure.result/1`)

```text
StructureResult
  schema, modelHash, coreVersion, elapsed_ms
  diagnostics: { mergedNodes[], mechanisms[{ node, dof }], equilibrium[{ combo, error_rel }], warnings[] }
  nodes:   { [id]: { disp_m_rad{ combo → [6] }, reaction_kN_kNm?{ combo → [6] } } }
  members: { [id]: { stations[0, .25, .5, .75, 1], forces{ combo → [{ N, V2, V3, T, M2, M3 }…] } } }
  checks[]: { member, status: "pass"|"fail"|"incomplete"|"error", ratio, governing{ combo, clause },
              parts[{ clause, ratio, values{…} }], B1?, slender?, deflection?{ value_mm, limit_mm, ratio },
              cause?: "member"|"input-suspect", causeNotes[] }
  summary: { steel_kN, steel_t, maxRatio, failCount, incompleteCount, loadLedger? }
  notChecked[]: 문자열(횡력·접합부·기초·EJ 등)
```

**부재력 부호:** 부재 위치 x(i 끝 0 → j 끝 1)에서 자른 면에 **j 쪽 부분이 i 쪽 부분에 가하는 힘·모멘트**를 국부축 성분으로 보고한다. 따라서 N은 인장이 양수, 압축이 음수다. 연직 하중을 받는 수평 단순보는 중앙 M3가 양수(처짐 모멘트)이고, 이때 V2 = −dM3/dx다. 절점 변위·반력은 전역축 성분이다. 반력은 지점이 구조물에 가하는 힘이다.

**부재 처짐:** 양 끝 변위의 Hermite 보간에 양단 고정보의 하중 특수해를 더한 값에서 두 끝을 잇는 현을 뺀 상대 처짐이다. 캔틸레버의 끝 처짐 판정은 이번 범위 밖이며 `notChecked`에 남긴다.

판정 `incomplete`는 입력이 모자라 검정하지 못한 경우, `error`는 계산 실패다.

## 5. 코어 내부

- 3D 12자유도 보 요소(전단변형 무시), 단부해제는 정적 응축, 트러스는 축력만, `tensionOnly`는 반복 비활성화(최대 반복 수 초과 시 경고).
- 전체 강성은 희소 대칭 행렬로 조립하고 faer의 희소 분해로 푼다. 지점 누락·기구는 분해 중 0 피벗으로 찾아 해당 절점·자유도를 `mechanisms`로 돌려준다.
- 조합은 선형 중첩으로 계산한다. 2차 해석(P-Δ)은 이번 범위 밖이며, 기둥의 부재 2차 효과는 검정 단계의 B1으로 반영한다.
- 부재 검정: KDS 14 31 10(압축 E3, 휨 F2·F3, 전단 G2, 조합 H1-1, 세장비), B1 = Cm / (1 − Pr/Pe1) ≥ 1, 처짐은 부재 현 기준 상대 처짐. 조항 표기는 KDS 14 31 10이 따르는 AISC 360의 장 기호(E3·F2·F6·G2·H1-1·D2)로 두며, KDS 조항 번호 대응은 원문 확인 뒤 추가한다. H형강의 세장판 압축은 E7 유효 단면적(웨브 c1 0.18·c2 1.31, 플랜지 c1 0.22·c2 1.49)으로 계산한다. 인장 파단·블록 전단, 비조밀 웨브 휨(F4·F5), 각형·원형 강관의 비조밀 휨은 구현하지 않았고 해당하면 `incomplete`와 메모로 표시한다.
- 결정성: 같은 입력이면 같은 결과(정렬·반올림 규칙 고정).

## 6. 검증 자료

`tests/structure/fixtures/`의 fixture는 {출처, 단위, 입력 모델, 기대값과 값별 허용오차, 가정}을 담는다. 교과서·공개 벤치마크의 "정답" fixture와 회귀용 골든 출력은 분리한다. 1차 목록은 RESEARCH-09 §4.1의 BM-03(닫힌 해), BM-06(보 횡비틀림좌굴), BM-10(PyNite 차분), BM-11(불변량), BM-12(KS 단면 성질)와 닫힌 해 보·골조이며, 구체 목록과 허용오차는 PLAN-17이 소유한다.
