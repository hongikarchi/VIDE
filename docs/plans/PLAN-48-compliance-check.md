---
id: PLAN-48
title: 법규 체크 — 설계 모델과 규제 조건 비교 (T-237~T-241)
status: draft
version: 0.3
updated: 2026-10-08
owner: agent:claude
related: [SPEC-15, SPEC-12, SPEC-13, SPEC-07, ARCH-03, ARCH-01, DESIGN, PLAN-45, PLAN-46, C-05, C-06, FR-09, FR-14, FR-18, FR-22, FR-24, FR-25, AC-14, AC-20, AC-34, AC-44, HOST-RHINO]
---

# 법규 체크

2026-10-08 사용자 요청 "지금 우리 건물 설계에서 법규 위반 사항이 없는지 체크하는 기능도 구현해줘. 이거는 cLAWde쪽에서 구축하는게 아니라, VIDE쪽에서 구현해야하는 것 같은데. geometry와 data를 비교하는 작업이라."의 실행 계획이다. 동작은 [SPEC-15](../specs/SPEC-15-compliance-check.md), 물리 계약은 [ARCH-03](../architecture/ARCH-03-jig-runtime.md) §8.6과 `src/contracts/compliance.ts`, 화면은 [Design](../../Design.md) SCR-32다. 선행 구현은 [PLAN-45](PLAN-45-site-massing-jigs.md)(규모검토 세 jig, T-214 VERIFY)와 [PLAN-46](PLAN-46-legal-qa.md)(법규 Q&A, `legal.constraints`)이다.

## 착수 조건과 범위

- **제품 결정:** 2026-10-08 사용자가 말로 정했다 — 모델은 레이어 규칙 + AI 분류(사람 확인), 첫 판 검사는 규모 항목·형상 제한·주차·조경·공개공지, 실행은 [법규 체크]를 누를 때만. PRD §14.2 '법규 체크' 행(0.20)에 반영했다.
- **범위:** 연결 Rhino 문서 하나를 읽어 SPEC-15.2의 닫힌 항목을 계산하고 결과 표·VIDE 뷰포트 강조·보고서(HTML·CSV)를 낸다. Rhino에 쓰지 않는다. ZWCAD 도면 체크, 피난·BF 등은 제외(SPEC-15 「범위 밖」).
- **원칙:** 법정 값은 코드에 없다. 모든 한계 값은 규제 조건 항목(사람 입력 또는 T-220의 `legal.constraints`)에서 오고, 정할 수 없는 것은 '판단 필요'·'사람 입력 필요'로 남는다(조용한 적합·위반 없음). AI는 역할을 제안할 뿐 판정하지 않는다. 사용자가 띄운 Rhino·ZWCAD에 붙거나 끄지 않는다. 실호스트 시험은 VIDE가 띄운 숨은 Rhino 8과 `.vide/` 아래의 합성 문서로만 하고, 자기가 띄운 PID만 끄며, 끝나면 설치된 엔진의 커넥터 등록을 되돌린다(T-241). 프로젝트 원본 자료는 저장소에 넣지 않는다.
- **병렬 작업:** 세 갈래(읽기 T-237, 계산 T-238, 화면 T-239)는 `src/contracts/compliance.ts`의 세 형식(`ClassifiedModel`·`ComplianceLimits`·`ComplianceResult`)만 맞추면 서로 기다리지 않는다. 계약 파일과 스키마 시험(`tests/contract/compliance-contract.test.mjs`)은 2026-10-08 이 계획과 함께 만들었다. 계약을 바꾸는 갈래는 계약·ARCH-03 §8.6·스키마 시험을 같은 커밋에서 고치고 다른 갈래에 알린다.

## 재사용할 기존 코드

| 위치 | 쓰는 것 | 티켓 |
|---|---|---|
| `src/jigs/official/geometry-kit/solid.ts` | 솔리드 불리언(합·차·교), `weldSolid`·`checkSolid`(닫힘), `sectionArea`, `regionPrismSolid`·`prismSolid`, `solidVolume` | T-237(닫힘 판정)·T-238(초과 부분) |
| `src/jigs/official/massing-kit/` | `rules.ts`(규제 조건 항목·`CHOICE_LABELS`), `setback.ts`(제한선·`solidCutters`·`sunPieces`), `envelope.ts`(최대 외피), `parking.ts`(법정 대수), `landscape.ts`·`open-space.ts`(법정 면적), `handoff.ts`(넘겨줄 결과 꼴) | T-238 |
| `src/jigs/runtime/runtime.ts` `ReadModel`·`rowsOfLayers`·`layersOf`, jig 입력 읽기(ARCH-03 §8) | 표시 형식의 문서 읽기(레이어·속성·메쉬·`geometryHash`) | T-237 |
| `src/ai/request-router.ts` `inputRolesRequest`(입력 역할 AI 제안) | 단발 AI 제안 요청·답 검사 꼴 | T-237 |
| `src/jigs/official/jigs/building-summary/`(보고서 틀·CSV·내보내기 조건) | 보고서 `reports/*.json`, 내보내기 조건 | T-239 |
| `src/ui/legal-target.ts`·`src/ui/app/viewport.ts`(대상 칩 → 뷰포트 선택) | 결과 행 → VIDE 뷰포트의 객체 선택·화면 맞춤 | T-239 |
| `tests/integration/rhino-site-bake.mjs` `restoreInstalledPlugin` | 실호스트 시험 뒤 설치 엔진의 Rhino 커넥터 되돌리기 | T-241 |

## 순서와 의존성

```text
계약 src/contracts/compliance.ts (완료, 2026-10-08)
 ├─ T-237 모델 읽기·분류(규칙·AI 제안·확인 기록) ───────┐
 ├─ T-238 계산 핵심 + 매스 '한계' 출력 + 대지 지반 후보 ──┼─ T-241 통합 VERIFY(합성 사슬 + 숨은 Rhino 8)
 └─ T-239 화면(SCR-32)·뷰포트 강조·보고서 ──────────────┘
T-240 cLAWde 후속(501·endpoints·조항 ID 캐시) — 독립
```

T-237·T-238·T-239는 계약 고정 뒤 동시에 시작한다. T-239는 계약을 통과하는 결과 고정 자료(fixture)로 화면을 만들고, T-238이 끝나면 실제 결과로 바꾼다. T-241은 세 갈래가 끝나야 한다. T-240은 법규 Q&A 쪽 후속이라 다른 티켓과 무관하다.

## T-237 모델 읽기와 역할 분류

- **기준:** SPEC-15.3·15.4·15.10 1·4, SPEC-15.16, SPEC-07.5, ADR-030, AC-14.
- **변경 범위:**
  - `src/jigs/official/compliance-kit/conventions.ts`(새 라이브러리 `vide/compliance-kit` 0.1.0, `LIBRARY_MODULES`에 등록): 역할 목록(계약의 `COMPLIANCE_ROLES`), 레이어 단계 이름 표(SPEC-15.3 3의 4), 속성 이름 `vide-check-role`·`vide-floor`·`vide-use`·`vide-count`, jig 태그 규칙(`vide-jig`가 `vide/buildable-mass`이고 `vide-key`가 `alt:`로 시작하며 `vide-option`이 `limits.plan.chosenOption`과 같으면 `floor`; 고른 대안이 없고 대안이 하나뿐이면 그 대안; 나머지 대안은 `고르지 않은 대안`; `park:` 주차 추정과 그 밖의 jig 태그는 `다른 jig의 결과`), `roleOf(row, records, chosenOption)`(우선순위 SPEC-15.3 3).
  - `src/jigs/official/compliance-kit/read-model.ts`(순수): 표시 행(`layer64`·`attributes64` base64 풀기, `vertices`·`indices`, `geometryHash`, `nativeId`) + 분류 기록 + 단위 비율 + 프레임 원점 → `ClassifiedModel`. 솔리드는 `weldSolid`·`checkSolid`로 닫힘 판정, 평면 곡선은 수평(높이 차 1 mm 안)·닫힘 판정 뒤 `region`, 블록·점은 `point`. 층 이름은 `vide-floor`·기록에서만 붙이고 이름 없는 층 윤곽은 `floor: null`(높이로 붙이는 일은 지반 경우를 아는 T-238). 단위를 모르면 `toMeters: null`로 넘기고 실패하지 않는다. '숨긴 객체 포함'이 꺼져 있어도 역할이 정해지는 숨긴 객체는 `hidden: true`로 `objects`에 넣고, 역할 없는 숨긴 객체만 `unclassified`(`숨김`). 쓰지 못한 객체에는 시도한 `role`과 모양 종류 `shape`를 붙인다. 객체 기록의 지문이 지금과 다르면 `geometryChanged: true`. 결과를 `classifiedModelSchema`로 검사한다.
  - `src/jigs/official/compliance-kit/proposals.ts`(순수): 역할 없음 객체의 묶음 요약(레이어·종류·닫힘·수평·크기 구간·높이 구간·수·속성 이름, 좌표 없음), AI 답 → `RoleProposal[]`과 버린 이유. `src/ai/request-router.ts`에 `complianceRolesRequest`(입력 역할 요청과 같은 꼴, 첨부 하나, `permission:'review'`).
  - 저장: 프로젝트 DB 표 `compliance_roles`(다음 스키마 판, `src/core/migrations.ts`)와 `compliance_proposals`, 서비스 `src/services/compliance-roles.ts`(판 번호 `rolesVersion`은 기록이 바뀔 때마다 1 증가).
  - 경로 `src/server/compliance-routes.ts`(ARCH-03 §8.6의 표): 분류 기록 읽기·쓰기, 제안 받기·버리기, [역할 제안 받기], 법규 체크용 문서 읽기(jig 입력 읽기 `purpose:'check'`, 문서 전체, 숨긴 객체는 설정대로). 원격 세션의 쓰기는 403.
  - jig 입력 종류 `host-document`(ARCH-03 §3·§8.6): 설명서 검사기(`src/jigs/runtime/manifest.ts`)와 입력 조립(`runtime.ts`)에 더하고, 단계에 `input.model = ClassifiedModel`을 준다. 읽기는 처음 열 때와 [법규 체크] 때만 한다.
- **선행:** 계약(완료). 스키마 판 번호는 다른 세션과 겹치지 않게 그때 최대값 + 1.
- **정상 검증:** `tests/core/compliance-read.test.mjs` — 합성 표시 행으로 ① 속성 > 사람 기록 > jig 태그 > 레이어 규칙 순서 ② mm 문서 → m ③ 열린 메쉬 '닫히지 않음' ④ 기울어진 곡선 '평면이 아님' ⑤ 사이트 모델링 건물(`vide-jig`)이 맥락으로 빠짐 ⑥ 매스 jig가 만든 대안 A·B·C 층 매스 가운데 고른 대안만 `floor`, 나머지 `고르지 않은 대안`, `park:` 주차 추정 매스는 `다른 jig의 결과` ⑦ 같은 깊이의 두 규칙 → 역할 없음 ⑧ 단위 모름 → `toMeters: null` ⑨ 역할이 있는 숨긴 객체 → `hidden: true`로 `objects`에. `tests/server/compliance-roles.test.mjs` — 기록 저장·판 증가·형상 지문이 바뀐 객체 표시·원격 403·제안 받기 → 기록(`ai-accepted`)·버리기.
- **실패 검증:** AI 답이 JSON 아님·목록 밖 역할·없는 레이어·없는 객체 → 그 제안만 버리고 이유. 연결 없음 → `HOST_NOT_CONNECTED`, 제안 요청 때 단위 모름 → `COMPLIANCE_UNITS_UNKNOWN`(ARCH-03 §8.6). 받지 않은 제안은 `ClassifiedModel`에 들어가지 않음. 여러 묶음을 한 번에 받는 경로는 없음.
- **완료:** 계약 시험 + 위 시험 통과, `npm run typecheck`, 실제 Rhino 문서 하나를 읽은 `ClassifiedModel`이 스키마를 통과(T-241에서 숨은 Rhino로 확인).

## T-238 계산 핵심(순수)과 입력 출력 보완

- **기준:** SPEC-15.2·15.5~15.9·15.10 2·3·5, SPEC-12.7~12.12, ARCH-03 §8.2·§8.4·§8.6.
- **변경 범위:**
  - **매스 '한계' 출력:** `src/jigs/official/massing-kit/limits-handoff.ts`(massing-kit 0.4.0) — 단계 `site`·`regulations`·`limits`·`envelope`의 값만 옮겨 `ComplianceLimits`를 만든다(새 계산 없음): 대지(고리·대지면적과 출처·다른 면적·정북), 규제 조건 항목, 미반영 조건, 규칙별 금지 띠(`Cutter`의 평면 다각형 — 캡슐·가각·건축한계선 바깥), 변형별 높이 상한·일조 금지 부피(`sunCutPieces`의 합)·최대 외피 메쉬(`maxMesh`)·미확정, 주용도·층고·고른 대안 이름(`chosenOption`, `chosen` 단계가 없으면 `null`), 프레임(대지를 읽은 Link와 원점, 외피가 선 `groundZ` — 지금은 0). `vide/buildable-mass` 0.5.0에 단계 `limitsHandoff`와 출력 `limits`(`schemas/outputs/limits.json`)를 더한다(고른 대안 없이도 외피까지 계산되면 나옴).
  - **대지 지반 후보:** `vide/site-model` 0.3.0 `summary`에 `ground {min, max, mean, source}`(대상 대지 경계 위 지형 높이, 도구로 계산함)를 더하고 `schemas/outputs/summary.json`을 고친다. 지형이 없으면 `null`.
  - **계산:** `src/jigs/official/compliance-kit/` — `limits-read.ts`(규제 조건 항목을 SPEC-15.5 6의 표로 거름: 값 없음·`ask`·`AI가 추정함` → 한계 없음, `미적용` → 미적용 목록, 적용 '판단 필요' → 경우 둘, 확정 상태 '판단 필요' → 판단 필요, '가정' → 표지; 단위가 항목 정의와 다르면 사람 입력 필요), `ground.ts`(지반 경우: 설정값 하나 또는 후보 최저·최고, 금지 부피를 `ground − origin[2] − groundZ`만큼 옮김, 이름 없는 층 윤곽에 경우마다 층 이름), `scale.ts`(대지면적 두 값·건축면적(윤곽 또는 지반에서 자른 수평투영)·높이(지반 경우·옥탑·`incentiveHeight` 띠)·층수(가장 큰 지상 번호와 층 수)·연면적(같은 층의 다른 높이 바닥은 더함)과 제외 면적 검사·용적률 사다리(SPEC-15.6 5, `farTargets`와 같은 뜻)), `shape.ts`(규칙별 금지 띠 기둥 ∩ 건물, 일조 금지 부피 ∩ 건물, 건물 − 최대 외피, 대지 밖, 조각 허용 오차 0.001 ㎥·1 mm, 초과 부분의 범위·가까운 구간·겹친 객체, 매스가 없을 때 층 윤곽 프리즘), `amenity.ts`(주차·조경·공개공지 — `massing-kit` `parking.ts`·`landscape.ts`·`open-space.ts` 함수를 그대로 부름), `verdict.ts`(경우(어느 하나)와 구간(모두) 나누기와 상태 규칙 SPEC-15.9 1·2, 경우 32개 상한, '가정' 표지, 쓰지 못한 객체·숨긴 역할 객체·역할 없는 닫힌 객체가 적합을 막음 SPEC-15.9 7, 반올림 없는 비교 SPEC-15.9 8, 미적용 목록), `check.ts`(`runCheck(model, limits, ground, settings, overrides) → ComplianceResult`, 입력을 `complianceSettingsSchema`·`complianceOverrideSchema`로 먼저 검사(`by:'ai'` 거절), 마지막에 `complianceResultSchema`로 검사 — 검사 목록의 모든 검사가 꼭 한 번 나옴).
  - **jig:** `src/jigs/official/jigs/compliance-check/`(`vide/compliance-check` 0.1.0) — `jig.json`(입력 `model` `host-document`, `limits` ← `vide/buildable-mass#limits`, `siteModel` ← `vide/site-model#summary`; 설정값 `groundLevel`·`groundBasis`·`exclusionsComplete`·`noneParking`·`noneLandscape`·`noneOpenSpace`·`includeHidden`; 수정 사항 `floor-exclusion`·`use-floor`; 코드 단계 `check`; 만들기 선언 없음), `skill.md`, 자체 시험 fixtures(`fixtures/chain`·`fixtures/no-limits`·`fixtures/undecided`).
- **선행:** 계약(완료). 화면과 무관.
- **정상 검증:** `tests/core/compliance-check.test.mjs` — 합성 대지(사각형, 도로 한 변)·규제 조건 값(시험 자료로 넣은 값, 코드 상수 아님)으로: 외피 안 상자 → 모든 형상 행 적합 / 위층을 북쪽으로 늘린 상자 → 일조 위반과 부피·높이 범위·객체 ID / 도로 쪽으로 나간 상자 → 건축선 후퇴 위반과 구간 '도로 1' / 건폐율 경계 바로 위·아래 / 용적률이 기준과 허용 사이 + 인센티브 '판단 필요' → '판단 필요' / 기준 지반 후보 범위에서 높이가 갈림 → '판단 필요'와 경우 둘 / 주차 10대 계획 vs 법정 / 옥상 조경으로만 채워짐 → '판단 필요' / 용적률 사다리 다섯 구간(기준 이하 적합, 확정 완화 안 적합, 미확정 완화 안 판단 필요, 완화 근거 없이 상한 안 판단 필요, 상한 초과 위반)과 `farBase` 없음 / 기준 지반이 외피의 `groundZ`와 2 m 다름 → 일조 초과가 그만큼 옮겨짐 / 대안 A·B가 겹친 모델에서 고른 대안만 연면적에 들어감 / 역할 없는 닫힌 솔리드 하나 → 적합이었을 행 '판단 필요' / 역할 있는 숨긴 매스 → 매스를 쓰는 행 '검사 불가' / 높이가 상한과 상한 + 높이 완화 사이 → '판단 필요' / 구간 하나 '사람 입력 필요' + 다른 구간 위반 → 위반 / 'AI가 추정함' 한계 → '사람 입력 필요' / 주차 용도 이름이 산정 기준 용도와 한 글자 다름 → '사람 입력 필요' / 단위 모름 → 길이·면적 행 '검사 불가', 층수·주차는 계산. `tests/core/massing-limits-handoff.test.mjs` — `limits` 출력이 스키마를 통과하고 값이 앞 단계 값과 같음.
- **실패 검증:** 한계 없음 → 규제 조건 행 '사람 입력 필요'·형상 행 '검사 불가' / 외피 점검 실패 → 형상 행 '검사 불가' / 다른 문서 → 형상 행 '검사 불가 · 대지와 모델이 다른 문서' / 불리언이 닫힌 결과를 못 냄 → 그 행만 '검사 불가' / 규제 조건 '사람 입력 필요' → 행 '사람 입력 필요'(적합 아님) / 매스 없음 + 층 윤곽 있음 → 프리즘으로 계산하고 '층 윤곽으로 만든 형상'.
- **완료:** 위 시험, jig 자체 시험(`jig:validate`), `npm run typecheck`, 같은 입력 두 번 → `checkedAt` 말고 같은 결과(지문 포함). 법정 값 상수가 코드에 없음을 리뷰에서 확인(숫자 상수는 허용 오차 1 mm·1 cm·0.001 ㎥뿐).

## T-239 화면·뷰포트 강조·보고서

- **기준:** SPEC-15.1·15.9·15.11·15.12·15.13·15.16, Design SCR-32, SPEC-07.10·07.11.
- **변경 범위:**
  - `src/jigs/official/jigs/compliance-check/panel.json`: 왼쪽 `jig-source` 둘(매스·대지), 새 부품 `compliance-roles`(역할별 수·역할 없음·[역할 제안 받기]·제안 목록 받기/바꾸기/버리기·형상이 바뀐 객체), 설정 묶음(기준 지반·산정 제외 입력 끝남·없음 확정·숨긴 객체), 주 행동 [법규 체크]; 가운데 `kpi-strip`(상태별 수·미확정), `viewport-overlay`(초과 부분·최대 외피 윤곽); 서랍 `result-tabs`(결과 표 `issue-table`, 미적용 항목, 분류, 입력). 화면 jig 부품 등록 `src/ui/kit/registry.ts`, 새 부품 `src/ui/kit/compliance-roles.tsx`.
  - 결과 표 행 → 뷰포트 선택: `src/ui/legal-target.ts`의 이벤트를 일반화해 `vide:select-native {label, objects[{linkId, nativeIds}]}`로 내고 `src/ui/app/viewport.ts`가 받는다(법규 답 대상 칩도 같은 이벤트로 옮김). 화면의 Sync에 없으면 안내.
  - '다시 체크 필요' 띠: 상태 경로가 주는 이유 목록(SPEC-15.13 — 매스 작업본이 '다시 계산 필요'가 된 것 포함)을 그리고 이전 결과를 흐리게.
  - 행 안 펼침: 경우(`cases`)와 구간(`parts`)을 따로, 숫자 출처의 사다리 값 전부. 머리 요약은 적합 아닌 행이나 미확정이 있으면 "위반 없음"을 쓰지 않음(SPEC-15.9 6). 초과 부분 표식 번호는 `exceedances[].no`. 분류 탭과 보고서의 분류 요약은 `classification`.
  - 보고서 `reports/compliance.json`(내보내기 조건: 체크됨 · 다시 체크 필요 아님)과 CSV 열(SPEC-15.12).
  - 요청 경로 판정에 '법규 체크'·'법규 위반'·'규정 위반 확인' 등록(SPEC-07.18).
- **선행:** 계약(완료). T-238 전에는 `fixtures/chain/expect.json`과 같은 꼴의 고정 결과로 만든다.
- **정상 검증:** `tests/integration/browser-compliance.mjs`(`test:browser`에 추가) — 고정 결과로 표·상태 색·기호·이유·근거 링크, 행 누르기 → 선택 이벤트, '다시 체크 필요' 띠와 내보내기 꺼짐, 원격 화면에서 [법규 체크]·분류 버튼 없음, 좁은 열(420px). 보고서 HTML이 고지·표·초과 목록을 담음.
- **실패 검증:** 결과 없음(아직 체크 안 함) → 빈 상태 안내와 내보내기 꺼짐 / 객체가 화면 Sync에 없음 → 안내 / 제안 실패 → 경고 한 줄.
- **완료:** 브라우저 시험·`npm run typecheck`, Design SCR-32와 화면 대조 스크린숏(VERIFY T-241에 첨부).

## T-240 cLAWde 후속 (VIDE 쪽)

- **기준:** SPEC-13.12(이번에 '서비스에 아직 없는 기능' 행 추가), SPEC-13.11, ARCH-01 「cLAWde 연결 계약」. cLAWde 저장소(`C:\Users\user\Desktop\cLAWde-service`) README 「끝점」·`docs/DESIGN.md`·`src/shared/aliases.ts`: `GET /v1/meta`가 계약 밖 `endpoints`(지금 답하는 끝점)·`plannedEndpoints`(501)를 주고, M2 전의 `ask`·`checklist`·`verify`·`contributions`·`recipes`·`golden`은 501 `NOT_IMPLEMENTED`이며, 응답의 조항 `ref`는 늘 저장 형식(공백 없는 정식 법령명, 가운뎃점 `ㆍ`, 약칭 `국토계획법` 등은 정식 이름으로 풀림)이라 요청한 ref와 다를 수 있다.
- **변경 범위:**
  - `src/contracts/clawde.ts`: `clawdeMetaSchema`에 선택 필드 `endpoints?: string[]`·`plannedEndpoints?: string[]`(예: `'POST /v1/ask'`).
  - `src/services/clawde.ts`: 501(본문 `error.code = NOT_IMPLEMENTED`)은 새 오류 `SERVICE_NOT_IMPLEMENTED`이고 연결 상태를 `unreachable`로 바꾸지 않는다(`connected` 유지). 503 `NO_PUBLICATION`·`PUBLISHING`은 `SERVICE_NOT_READY`('서비스 준비 중')로 나누고 상태는 그대로 둔다. 그 밖의 5xx는 지금처럼 `SERVICE_UNAVAILABLE`.
  - `src/services/legal.ts`·`src/server/service-routes.ts`: 마지막 `meta`로 기능 표 `features {ask, checklist, contribute, verify, golden, recipes}`를 만들어 설정 보기·프로필·답 목록 응답에 싣는다. `endpoints`가 없으면 모두 켬(이전 서비스와 하위 호환). 꺼진 기능의 경로는 서비스에 보내지 않고 409 `SERVICE_NOT_IMPLEMENTED`.
  - `src/ui/legal-jig.tsx`·`src/ui/shell/services-settings.tsx`·`src/server/legal-tools.ts`: 꺼진 기능은 [묻기]·단계별 법령·[cLAWde로 보내기]·[모델 인증]을 흐리게 하고 '서비스가 아직 이 기능을 제공하지 않습니다'를 보인다. 대화 도구는 꺼진 기능을 목록에서 뺀다. 조항 보기·검색은 그대로 된다.
  - `src/services/legal-answers.ts`: 조항 캐시를 요청한 ref와 응답 ref 둘 다로 둔다(`saveArticle(projectId, article, requestedRef?)`가 둘이 다르면 두 행, `article()`은 어느 쪽으로도 찾음). 답의 `citations[].ref`도 응답 형식 그대로 저장한다.
  - 문서: ARCH-01 「cLAWde 연결 계약」에 `meta.endpoints`·`plannedEndpoints`, 501·503 처리, 조항 ID의 저장 형식과 약칭 흡수, 두 ref 캐시를 적는다(SPEC-13.12 행은 이번에 더함).
  - 가짜 서버 `tests/fixtures/fake-clawde/server.mjs`: `meta.endpoints` 모드, 501 끝점, 약칭 ref 요청 → 저장 형식 ref 응답.
- **선행:** 없음(독립).
- **정상 검증:** `tests/contract/clawde-contract.test.mjs`(meta 선택 필드), `tests/core/legal-*.test.mjs` — `endpoints`에 `ask`가 없으면 묻기 409·상태 `connected`, 조항을 약칭 ref로 받고 저장 형식 ref로도 캐시 적중, `endpoints` 없는 이전 meta → 모두 켬. `tests/integration/browser-legal.mjs`에 꺼진 기능 표시 한 경우.
- **실패 검증:** 501을 받은 뒤에도 조항 보기·검색이 됨, 상태 알약이 '닿지 않음'으로 바뀌지 않음, 503 준비 중이 '닿지 않음'과 다른 문구.
- **완료:** 위 시험, `npm run typecheck`, 실제 cLAWde(로컬 또는 배포) `meta` 한 번으로 기능 표가 맞게 나옴(가능하면).

## T-241 통합 VERIFY

- **기준:** SPEC-15.1 완료 기준, AC-14·20·34·44, H-RHINO(읽기·Link ID), [VERIFY-2026-10-08-site-massing](../tdd/VERIFY-2026-10-08-site-massing.md)의 합성 사슬.
- **변경 범위:** `docs/tdd/VERIFY-YYYY-MM-DD-compliance-check.md`, `tests/integration/rhino-compliance.mjs`(숨은 Rhino 8 실호스트), 필요하면 `.vide/` 아래 합성 3DM 생성 스크립트.
- **시나리오:**
  1. 합성 사슬(엔진 단위): 합성 대지 → 사이트 모델링 → 규제 조건 입력(사람 값 + 가짜 cLAWde `legal.constraints` 하나) → 가능 외피 → 고른 대안 → 그 층 매스를 Rhino에 만든 것과 같은 표시 행 → 손으로 고친 모델(꼭대기 층을 정북 쪽으로 2 m 늘림, 1층을 도로 쪽으로 0.5 m 내밂, 주차 블록 8개 + `vide-count` 2 하나, 조경 곡선, 옥상 조경, 역할 없는 레이어 하나) → AI 제안(가짜 응답) 받기 → 체크 → 행마다 기대 상태.
  2. 숨은 Rhino 8: 엔진이 띄운 숨은 Rhino 8로 `.vide/` 아래 합성 3DM(위 1의 모델)을 열어 jig 입력 읽기 → 분류 → [법규 체크] 경로 → 결과가 1과 같은지. 사용자가 띄운 Rhino·ZWCAD에는 붙지 않고, 자기가 띄운 PID만 끈다. 끝나면 `GET /api/v1/connectors`에서 rhino8의 플러그인이 `current`인지 확인하고 아니면 설치 경로(`POST /api/v1/connectors/rhino8/install`)를 부른다(`restoreInstalledPlugin`과 같은 도움 함수). 개발 빌드 등록을 남기지 않는다.
  3. 실패 주입: 매스 작업본 '다시 계산 필요', 단위 모름(합성 행), 닫히지 않은 매스, 다른 문서, 규제 조건 비움, 체크 뒤 모델 수정 → '다시 체크 필요'(저절로 다시 돌지 않음), 규제 조건 변경 → '다시 체크 필요'.
  4. 브라우저(`browser-compliance.mjs`): 실제 결과로 표·강조·보고서·CSV.
  5. 시간: 매스 50개·삼각형 합계 2만 개 모델의 읽기·체크 시간을 기록한다(상한은 관찰 뒤 정함).
- **완료:** VERIFY 문서에 시나리오별 결과·시간·발견, PLAN-48 「현재 상태」 갱신. 발견한 결함은 고치거나 F-n으로 남긴다.

## 현재 상태

| 티켓 | 상태 | 증거 |
|---|---|---|
| 계약 | 완료(2026-10-08), 같은 날 적대적 검토로 보강(0.2): 좌표·지반 기준(`frame.groundZ`), 고른 대안(`plan.chosenOption`), 단위 모름 `toMeters: null`, 숨긴 역할 객체·쓰지 못한 객체의 역할과 모양, 설정값·수정 사항 형식(`by:'person'`만), 경우/구간 분리, 초과 번호, 분류 요약, 검사 목록 완전성·상태 수·적합 조건 검사 | `tests/contract/compliance-contract.test.mjs` 5개 통과 |
| T-237 | 구현·단위 검증 완료(2026-10-08). 실제 Rhino 문서 읽기는 T-241(숨은 Rhino 8)에서 확인. `vide/compliance-kit` 0.1.0(`conventions.ts`·`read-model.ts`·`proposals.ts`), 스키마 16(`compliance_roles`·`compliance_proposals`·`compliance_roles_version`), `src/services/compliance-roles.ts`, `src/server/compliance-routes.ts`(분류 기록·체크용 문서 읽기·제안 받기/정하기), jig 입력 종류 `host-document`(작업본 `hostDocuments`, 읽기 목적 `check`). 계약 변경 없음. 분류 확인 화면 부품은 T-239(`compliance-roles`)가 이 경로로 만든다. `AI_SEND_OFF`는 프로젝트 AI 전송 끔 설정이 아직 없어 쓰지 않음 | `tests/core/compliance-read.test.mjs` 8개(①~⑨·지문 변경·없는 기록·블록 대수·해치·제안 요약과 답 검사), `tests/server/compliance-roles.test.mjs` 4개(전체 읽기·숨김 판별·단계 입력·기록 판·형상 변경·제안 받기/빼기/바꾸기/버리기·AI 실패·단위 모름·원격 403·연결 없음) 통과 |
| T-238 | 계산 핵심 완료(2026-10-08): `src/jigs/official/compliance-kit/`의 `limits-read.ts`(SPEC-15.5 6 표)·`ground.ts`(지반 경우·층 이름)·`scale.ts`(건폐율·용적률 사다리·높이·층수)·`shape.ts`(금지 띠·일조·최대 외피·대지 밖, 초과 부분 부피·범위·객체)·`amenity.ts`(massing-kit `legalParking`·`landscapeAreas`·`openSpaceRequirement` 그대로)·`verdict.ts`(경우/구간·SPEC-15.9 7·반올림 없는 비교)·`check.ts`(`runCheck`, 입력·결과 스키마 검사)·`report-rows.ts`(CSV 열). 계약은 바꾸지 않았다 — `runCheck`의 `limits`는 `null`(앞 작업본 없음)을 받고, 선택 인자 `refs {limits, siteModel, limitsStale, checkedAt}`로 `inputs`의 앞 작업본 참조를 채운다. 최소 기준 행(주차·조경·공개공지)의 `margin`은 계획 − 법정(음수 = 모자람). 남음: 매스 '한계' 출력(`limits-handoff.ts`, buildable-mass 0.5.0), 사이트 모델링 `summary.ground`, jig `vide/compliance-check`(설명서·fixtures·`jig:validate`); `LIBRARY_MODULES` 등록은 T-237과 함께 | `tests/core/compliance-check.test.mjs` 24개 통과(손계산 합성 대지 — 다섯 상태 모두, 사다리 다섯 구간, 지반 경우, 변형 불일치, 실패 주입), `npm test` 1418개·`npm run typecheck`·`format:check` 통과 |
| T-239 | 화면 구현(2026-10-08, 가짜 엔진 자료로 확인): `panel.json`과 부품 `compliance-roles`(`src/ui/kit/compliance-roles.tsx`)·`compliance-run`·`compliance-summary`·`compliance-result`(`src/ui/compliance/`), 결과 표(상태 칩·이유·근거 링크·법규 답 번호·펼친 숫자 출처·경우·구간·초과 부분), 다시 체크 필요 띠(흐림·내보내기 꺼짐), 뷰포트 겹침 새 항목 `mesh`(초과 부분·최대 외피 윤곽), `vide:select-native`(법규 답 대상 칩도 옮김), CSV·보고서 HTML. 계약에 선택 필드 `display {origin, envelope}` 추가(T-238이 채우면 뷰포트 좌표가 맞음). 남은 것: T-238의 `jig.json`·`skill.md`(대화 경로 낱말 '법규 체크'·'법규 위반'·'규정 위반 확인'), 열 때 `check`가 저절로 돌지 않게 하는 실행 설정, 층별 제외 면적 탭(수정 사항 저장 경로 필요), `reports/compliance.json`(jig.json의 `reports`가 필요), 실제 엔진 결과로 다시 확인(T-241) | `tests/core/compliance-screen.test.mjs` 12개, `tests/contract/compliance-contract.test.mjs`(+`display`), `tests/integration/browser-compliance.mjs`(`test:browser`에 추가) 통과 |
| T-240 | 계획 | — |
| T-241 | 계획 | — |

## 결정이 필요한 질문

| # | 질문 | 추천 기본값 | 대안 |
|---|---|---|---|
| 1 | 분류를 Rhino 객체 속성으로도 남길지 | 남기지 않는다(문서를 바꾸지 않음, 프로젝트 기록만). 사람이 원하면 Rhino에서 `vide-check-role`을 직접 단다 | 받은 분류를 [속성으로 쓰기]로 Rhino에 남김(되돌리기 기록 하나) |
| 2 | 기준 지반을 사람이 넣지 않았을 때 | 사이트 모델링의 대지 경계 위 지형 최저·최고 두 경우로 계산하고 갈리면 '판단 필요'(SPEC-15.6 3) | '사람 입력 필요'로 멈춤 |
| 3 | 결과를 Rhino에 만들기(초과 부분 솔리드) | 하지 않는다(VIDE 뷰포트 겹침만) | 초과 부분을 별도 레이어에 만들기 선언 |
| — | 결정됨(2026-10-08) | 레이어 규칙 + AI 분류, 첫 판 세 묶음, [법규 체크] 누를 때만, VIDE 쪽 구현 | — |
