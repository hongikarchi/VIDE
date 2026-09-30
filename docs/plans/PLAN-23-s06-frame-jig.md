---
id: PLAN-23
title: S-06 골조 jig와 구조 라이브러리 1차 — 진단·배치·해석·단면·일람표·Rhino에 만들기
status: review
version: 0.1
updated: 2026-09-29
owner: agent:claude
related: [PLAN, PLAN-17, PLAN-22, PLAN-24, FR-23, FR-24, AC-40, AC-41, AC-42, AC-43, SPEC-06, SPEC-07, ARCH-02, ARCH-03, ADR-019, ADR-020, RESEARCH-10, RESEARCH-08, RESEARCH-09]
---

# S-06 골조 jig와 구조 라이브러리 1차

## 목적과 기준

S-06 구조 jig를 만들면서 jig 플랫폼을 실물로 시험한다(사용자 지시 "구조 jig도 만들어야 하고… S-06 전용 구조 해석 jig도 구현해야 해", 결정 A1·A11). 결과는 설계사무소(우리)의 배치 탐색·사전 점검이며, 모든 수치는 탐색용 예비값이고 구조 검토를 대신하지 않는다.

- 제품 범위: FR-23(구조 jig + 프로젝트 구조 jig: 입력 조립·배치 생성·기초 간섭·단면 선정·일람표·Rhino에 만들기), FR-24(jig 플랫폼)
- 동작: [SPEC-06](../specs/SPEC-06-structure-analysis.md) .3(확정과 미확정 미리보기)·.10(입력 조립)·.11(배치 생성·간섭·판정)·.12(단면 선정·부호·일람표)·.13(Rhino에 만들기)·.14(진단), [SPEC-07](../specs/SPEC-07-jig-platform.md)(작업본·설정값·점검·Rhino에 만들기)
- 수용: PRD AC-40(구조 분석 jig), AC-41(입력 조립), AC-42(설정값·배치·단면·일람표), AC-43(Rhino에 만들기)
- 계약: [ARCH-02](../architecture/ARCH-02-structure-model.md)(해석 모델), [ARCH-03](../architecture/ARCH-03-jig-runtime.md)(jig 패키지·작업본)
- 결정: [ADR-019](../decisions/ADR-019-structure-jig-rust-core.md)(결정 2 유지 = 설계 부재 처짐은 참고 처짐(A8), 결정 3 개정 = 확정 전 미리보기 해석 허용(A6)), [ADR-020](../decisions/ADR-020-jig-platform.md)
- 근거·대안: [RESEARCH-10](../research/RESEARCH-10-vide-restructure.md) §10(구조 라이브러리)·§14(S-06 jig), [RESEARCH-08](../research/RESEARCH-08-structure-analysis-jig.md)(S-18 자산)
- 이어받는 계획: [PLAN-17](PLAN-17-structure-jig.md)(J-09 1단계). 플랫폼은 [PLAN-22](PLAN-22-jig-platform.md), 대화·경로는 [PLAN-24](PLAN-24-ai-conversations.md)

**위치와 자료 규칙(결정 A12).**
- 공식 라이브러리: `src/jigs/official/geometry-kit/`(일반 기하), `src/jigs/official/structure-analysis/`(J-09 라이브러리화). S-06 고유 규칙을 넣지 않는다.
- S-06 jig 소스: 저장소 `extensions/jigs/s06-frame/`. 단계 코드·패널·보고서 틀·합성 시험 자료만 둔다.
- 실제 S-06 설정값·근거·입력 조립·구역은 사용자 데이터 폴더의 작업본에만 둔다. 개발 검수는 `.vide/` 사본의 데이터로 한다.
- 설치는 이 PC에서 서명한 `.vjig` 가져오기(PLAN-22 T-046)다. 만들기 대화의 시작 본으로 싣지 않는다.
- S-06 본체는 에이전트가 저장소에서 작성하고, 만들기 대화와 같은 점검(`npm run jig:validate`, `npm run jig:test`)을 통과해야 들어간다(결정 A11). 채팅 제작은 M5에서 S-06 보조 jig로 시험한다(PLAN-22 T-064).

## 작업 묶음 → 티켓

| RESEARCH-10 묶음 | 티켓 | 마일스톤 |
|---|---|---|
| WP-06 geometry-kit(진단 함수) | T-042 | M0 |
| WP-10a S-06 진단 | T-044 | M0 |
| WP-06 geometry-kit(배치 함수) | T-050 | M1 |
| WP-10 S-06 ⓪~④ | T-051 | M1 |
| WP-07 structure-analysis(모델 조립·요약·미리보기·참고 처짐·인용 검사) | T-052 | M2 |
| WP-10 ⑤~⑦ + WP-11 ⑧ | T-053 | M2 |
| WP-07 structure-analysis(단면 선정·단면 성질·부호·일람표) | T-054 | M3 |
| WP-11 ⑨~⑫ | T-056 | M3 |
| WP-12 S-06 보고서 | T-058 | M4 |
| WP-22 일부(Rust 코어 확장) | T-067 | 2차 |

M5 수용(S-06 보조 jig를 만들기 대화로 만들기)은 SPEC-07.16에 따라 PLAN-22 T-064가 맡는다.

플러그인 재빌드가 필요한 티켓은 없다. Rhino 쪽 변경은 PLAN-22 T-043의 재빌드 한 번에 모았다. 설치본 반영은 사용자가 요청할 때 묶음 릴리스로 한다.

## M0 진단 — 먼저 여는 읽기 전용 결과

플랫폼을 기다리지 않는다. 지금 그려진 배치를 읽기만 해서 계산하고, 진단 함수는 v3 `code` 단계와 같은 서명으로 써서 M1에서 그대로 옮긴다.

### T-042 · geometry-kit 진단 함수 {#t-042}

- **목적/기준:** M0 진단이 쓰는 순수 기하 함수를 공식 라이브러리 `vide/geometry-kit`에 둔다. SPEC-06.11의 2(실제 발자국끼리의 겹침·최소 거리)·.14, SPEC-07.9(공식 라이브러리는 엔진에서 실행).
- **변경 범위:** `src/jigs/official/geometry-kit/`:
  - `blockFootprints`: 블록 정의 외곽 × 인스턴스 변환 → 회전 사각형·다각형
  - 분리축 부호 거리: 겹치면 음수, 한 방향만 떨어져도 통과
  - `bandFromMesh`: 표시 메시(Brep 렌더 메시)의 평면 투영 띠. RESEARCH-10의 `bandFromBreps`와 같은 함수이며, Sync가 Brep이 아니라 메시를 주므로 이름을 입력에 맞췄다
  - 지지점 끊기: 곡선을 허용오차 안의 지지점에서 끊어 경간과 양 끝 내민 구간으로 나눔
  - 평면 길이
- **선행:** 없음.
- **검증:** 정상 — −21° 회전 발자국, 겹침 음수 거리, 한 방향 분리 통과, 허용오차 0.3 m 안·밖의 끊기, 1천 부재 규모 ≤ 50 ms. 실패 — 빈 정의·퇴화 다각형·NaN 입력은 `polygon-valid`·`no-nan`으로 거절.
- **완료:** `tests/core/geometry-kit.test.mjs` 통과.

### T-044 · S-06 M0 진단 — 지금 그려진 기둥·거더 읽기 전용 점검 {#t-044}

- **목적/기준:** 지금 그려진 기둥·거더를 읽기만 해서 파일캡·오픈컷·유수지 보 간섭과 거더 경간을 표와 3D 겹침으로 보인다. 원본에 쓰지 않는다. FR-23, SPEC-06.14.
- **변경 범위:**
  - `extensions/jigs/s06-frame/steps/diagnose.ts`: 순수 함수 `(inputs, params) → output`
  - 입력(레이어 규칙 후보만, AI 없음): 연결된 구조 모델의 기둥·거더 곡선·기초 블록 인스턴스(Sync), 토목 모델의 기존 기초 블록과 유수지 보 Brep. 토목 모델은 T-043 뒤 'VIDE에서 연 파일' 경로로 읽고, 그 전에는 사용자가 두 번째 Rhino에 직접 연결한 경로로 읽는다
  - 계산:
    - 기둥 방향 정규화
    - Sync 블록 인스턴스에서 파일캡·오픈컷 발자국
    - 기존 기초 발자국·유수지 보 띠까지의 분리축 거리
    - 거더 곡선을 기둥 상단점에서 끊은 경간과 끝 내민 구간
    - **모든 거더(대각 포함)의 경간 12 m 초과**
    - 기준선 재현용 곡선 평면 길이
  - 결과:
    - 간섭 표: 기둥별 세 거리와 판정(파일캡↔기존 기초 = 불가, 오픈컷↔기존 기초 = 협의, 기둥↔유수지 보 = 경고)
    - 경간 표: 물리 경간·내민 길이·초과
    - 곡선 길이 표(별도 열. '경간 초과'로 세지 않음)
    - 표 행 → 3D 찾아가기, 표의 CSV
    - 3D 겹침 층(PLAN-22 T-041): 기존 기초, 파일캡, 오픈컷, 간섭 채움, 경간 초과 거더 강조
  - 실행: 공식 엔진의 임시 실행 경로와 기존 구조 jig 화면의 '진단' 표. 임시 경로는 M1(T-051)에서 v3 단계로 옮기며 지운다
- **선행:** PLAN-22 T-041, T-042. 토목 모델을 import 경로로 읽으면 PLAN-22 T-043.
- **검증:**
  - 합성: `grid-rot21`(−21° 격자, 4.0·5.559 m 칸 섞임), `grid-4m-bay`(한 방향 분리로 풀리는 기둥), 기둥 위 곡선 끊기 사례
  - 실패: 필요한 역할이 없거나 블록 회전을 읽지 못한 입력이면 그 판정만 '미완'으로 두고 이유를 보임(회전 없는 경계 상자로 계산하지 않음). 진단 동안 호스트 쓰기·후보 생성이 없음
  - **수용 — 기준선 재현:** `.vide/` 사본에서 기존 간이 검사와 같은 가정(기초는 회전 좌표계의 축 정렬 정사각형, 회전은 각 모델 값, 기둥은 0.5 m 정사각)으로 계산한다. 재현할 값:
    - 신설 기둥 34개 중 파일캡↔기존 2.7 m 기초 **9**
    - 오픈컷 3.6 m **33**
    - 기둥↔유수지 보 **6**
    - 거더 곡선 62개 중 평면 길이 > 12 m **19**(> 13 m 12개, 최대 18.9 m)
  - 이어서 기둥 위에서 끊은 **경간 표**를 따로 낸다. 곡선 길이는 경간이 아니므로 경간 초과 수를 별도로 적는다
- **완료:** 수치·가정·기준선과의 차이를 `docs/tdd/VERIFY-YYYY-MM-DD-s06-frame.md`에 기록한다. 기준선 스크립트는 임시 파일이므로 수치와 가정만 옮긴다.

## 작업본 설정값 — S-06 결정의 반영

아래는 S-06 작업본을 만들 때 넣을 시작값과 그 출처다(SPEC-06.11이 기본값·범위를 PLAN-23·ARCH-03에 맡긴 부분). 설정값의 의미는 SPEC-06.11·SPEC-07.6, 저장 형식은 ARCH-03이 소유한다.

- 저장소 jig 설명서에는 키·단위·범위와 일반 기본값만 둔다. 아래 값과 근거는 S-06 작업본에만 넣는다(결정 A12). 합성 시험 자료는 합성 값을 쓴다.
- 사용자 결정은 출처 `by:'decision'`으로 고정하고 질문 카드로 다시 묻지 않는다. 값은 '자세히'에서만 바꾼다.
- 출처의 '결정'은 사용자가 말로 내린 결정(F2·F3·D2·D5·D9), '기본값'은 에이전트 권고에 사용자가 이의를 두지 않은 것(D1·D3·D4·D6·D7·D8)이다. 구조사무소 확인 항목은 보고서 06 원장(T-058)에 올린다.

| 설정값·입력 | 시작값 | 출처 |
|---|---|---|
| 입력 조립 | 연결된 CAD·Rhino 전부에서 AI가 역할별로 제안, 코드가 형상 추출, 사람이 확인 | 결정 F3 |
| `mergeQuads`, `beamSpacing` | 삼각망 거더(사각 합치기 끔), 작은보 2.5 m(2.0~3.0) | 결정 F2.1 |
| 기준선 | 상단선만 만들고 전달, 해석도 상단선(편심 무시를 가정 목록에) | 결정 F2.2 |
| `girderBandRule` | 유수지 보는 가능한 한 피함(배치 목적 3순위), 간섭은 경고 목록 | 결정 F2.3 |
| `spanMax` | 12.0 m, 넘으면 '초과'(협의 구간 없음) | 결정 F2.4 |
| `spanRule`, `layoutPattern` | 모든 거더(대각 포함)에 적용, 직교·엇갈림 두 후보 | 결정 D5 |
| `layoutObjective` | 경간 > 파일캡↔기존 기초 > 유수지 보 > 오픈컷 > 기둥 수(마지막은 가정) | 사용자 우선순위, 기본값 D6 |
| 오픈컷↔기존 기초 | 벌점(목적 4순위) + '협의' 목록 | 기본값 D6 |
| `existingFooting`, `capSize` | 모델 블록 값(토목·구조 모델) | 결정 F2.5 |
| `heightStep` | 기둥 길이 1.0 m 단위로 내림, 경사 데크 오차 허용(차이는 받침 높이 표) | 결정 F2.6 |
| `heightBasis`, `girderTopRule` | 정수 = 기둥 길이, 거더 상단 = 슬래브 하면 | 기본값 D4 |
| `markRule` | SC·SG·SB·SEG·SCB·STB, 1부터. S-18 표준 파일 확인 전은 '가정' | 결정 F2.7 |
| `clearHeightMin` | 형하 2.4 m(보 아래 마감 0.15 m는 가정) | 결정 F2.8 |
| `fireRoute` | 소방 동선 안 기둥 금지(block), 상부 5.0 m 미달은 판정 '불가' | 결정 F2.9 |
| `restraintLevel` | 기존 슬래브 레벨의 기둥 절점에 수평 구속, 완전 구속(가정) | 결정 F2.10 |
| `ejDetail`, `ejWidth` | 신설 E.J.만 분절, 쌍기둥 + 공통 파일캡, 폭 0.6 m(가정) | 결정 F2.11, 기본값 D8 |
| `rampZone` | 일반 구역과 같게 배치 + 구역 표시(램프 형식은 보류) | 결정 F2.12에 따른 가정 |
| 저류 용량 | 점검하지 않음(설정값 없음) | 결정 F2.13 |
| 줄돔 구역 | 사용자가 Rhino에서 평면 곡선을 그려 입력 역할로 지정 | 기본값 D1 |
| `edgeSupport` | 테두리보는 내민 보로 받침(기둥 추가 없음), 캔틸레버 한도 초과는 목록 | 결정 D2 |
| `steelGrade` | SS275(가정), 확정 표기만 막음 | 기본값 D3 |
| `notionalRatio`, `combos` | 1.2D+1.6L(강도), 1.0D+1.0L(사용성), 명목 수평 0.002 X·Y | 기본값 D7 |
| `columnFamily`, `jointRule` | H형강, 기둥 주축 ±15° 안 거더만 강접, 나머지와 작은보는 핀 | 결정 D9(구조사무소 확인) |

그 밖의 시작값(파일캡 추가 여유 0.2 m, 캔틸레버 한도 3.5 m, 보 춤 상한 900 mm, 목표 검정비 0.90, 활하중 5.0 kPa 등)은 RESEARCH-10 §14.5에서 가져온다. 출처는 '가정' 또는 진술 ID로 표시한다.

## M1 — 입력 조립·축선·기둥·간섭

### T-050 · geometry-kit 배치 함수 {#t-050}

- **목적/기준:** 배치 생성·거더망·작은보·줄돔이 쓰는 일반 기하. SPEC-06.11의 3~6, SPEC-07.9.
- **변경 범위:** `src/jigs/official/geometry-kit/`:
  - 제약 들로네 삼각망과 직교 칸의 결정적 대각선: 짧은 것, 차 ≤ 0.05 m면 전역 u+v 방향, 이전 결과가 0.2 m 안이면 유지
  - 다각형 연산(합·차·안쪽 들임), `outlineFromMesh`(메시 윗면 외곽)
  - 칸 채우기(가장 긴 변과 평행, 간격, 최소 길이), 테두리 들임선·내민 보
  - 원호 3점 맞춤과 곡선 분할
  - 의존성 `delaunator` + `@kninnug/constrainautor` 또는 `cdt2d`. 라이선스 확인 뒤 PLAN-03의 추적·검사 규칙대로 넣는다
- **선행:** T-042.
- **검증:** 정상 — 제약 모서리 보존, `rect-grid-degenerate`(기둥을 ±1 mm씩 20회 옮겨도 거더 집합·안정 키가 같음), 메시 윗면 외곽, 원호 3점·분할, 1천 부재 ≤ 50 ms. 실패 — 자기교차 다각형·퇴화 칸 거절.
- **완료:** 단위 시험 통과.

### T-051 · S-06 골조 jig 0.1 — ⓪ 입력 조립 ~ ④ 기초 간섭 {#t-051}

- **목적/기준:** S-06 jig를 형식 v3의 이 프로젝트의 jig로 만들며 형식·로더·자식 프로세스 실행기·선언형 패널·입력 조립·작업본을 실물로 거친다. FR-23, FR-24, SPEC-06.10·.11(1·2·7·8), SPEC-07.5·.15, AC-41·42.
- **변경 범위:** `extensions/jigs/s06-frame/{jig.json, steps/*, panel.json, fixtures/*, skill.md}`
  - ⓪ 입력 조립
    - 레이어 이름 규칙이 1차 후보를 내고, 단발 AI 단계(PLAN-24 T-049)가 나머지 역할을 제안한다
    - 코드가 형상을 추출하고, 사람이 역할 카드에서 확인한다. 확인하지 않은 역할이 있으면 '입력 미확인'으로 표시하고 Rhino에 만들기를 막는다
    - CAD는 기존 그리드 직선 쌍으로 정렬하고 변환·잔차를 작업본에 저장한다
    - 기존 기초 수가 다른 자료와 맞지 않으면 '모델 누락 가능' 경고 층을 보인다
  - ① 진단: T-044를 v3 `code` 단계로 옮기고 임시 경로를 지운다
  - ② 축선·배치
    - 직교·엇갈림 두 후보를 사전식 목적(설정값 표)으로 비교한다
    - 모두 만족할 수 없으면 뒤에서부터 완화하고 위반을 목록으로 보인다. 경간은 끝까지 지킨다
    - 대안 2~3개를 내고, 새 축선에 기존 축 이름 대응을 붙인다
  - ③ 기둥
    - 슬래브 안에서 외곽 최소 거리를 지키고 소방 동선 밖에 둔다
    - 신설 E.J.마다 쌍기둥을 두고, 구조사무소 요청 영역을 판정한다
    - 하단 = 기존 기초 상단. 길이는 1 m 단위로 내리고 받침 높이 표를 낸다
  - ④ 기초 간섭
    - 파일캡·오픈컷·유수지 보 띠·쌍기둥 공통 캡의 간섭을 계산한다
    - 비켜 두기 후보는 자동 적용하지 않는다
    - 기존 E.J. 걸침은 경고로 보인다
- **선행:** T-044, T-050, PLAN-22 T-046~T-048, PLAN-24 T-049(단발 AI 제안), SPEC-06 개정 review.
- **검증:**
  - 합성: `grid-rot21`, `grid-4m-bay`, `stagger-diagonal`, `basin-band`, `priority-conflict`, `requested-zone`, `height-floor`
  - 점검: `jig:validate`·`jig:test` 통과
  - 실패: 입력 미확인 상태의 Rhino에 만들기 차단, 소방 동선 안 기둥 후보 없음, 경간과 파일캡을 함께 만족할 수 없을 때 경간 유지 + 위반 목록, 강제 오류 입력에서 `ids-stable`·`polygon-valid` 실패
  - 실데이터(`.vide/` 사본): 파일캡↔기존 기초 불가 0 또는 완화 순서·이유가 붙은 목록, 유수지 보 간섭 목록, 경간 초과 0 또는 위치 목록, 요청 영역 판정
- **완료:** VERIFY에 M1 결과 기록.

## M2 — 거더·작은보·해석

**2026-09-30 사용자 지시로 순서를 바꾼다.** 이 프로젝트에는 손으로 그린 기둥·거더가 이미 있으므로, ⑤의 1차 경로는 **그려 둔 거더 곡선을 읽어 보정**하는 것이다(끝을 허용오차 안의 기둥 상단에 붙이고, 기둥 위에서 끊고, 붙일 기둥이 없는 끝은 목록으로 보임). 기둥도 그려 둔 것을 입력으로 쓴다. 삼각망·축선·기둥 자동 생성은 '제안' 기능으로 두고 시간이 남을 때만 한다("너무 오래 걸리면 거더 curve는 사람이 직접 그리는거로 구현해도 됨… 기둥과 안 만난다던가 하는 부분만 보정"). 목적은 빨리 화면에 올려 실무 모델과 함께 써 보면서 고치는 것이다.

### T-052 · structure-analysis 1차 — 모델 조립·요약·미리보기·참고 처짐 {#t-052}

- **목적/기준:** J-09를 라이브러리 jig로 만들고, 조사에서 확인한 결함을 Rust 코어를 바꾸지 않고 TS에서 고친다. FR-23, SPEC-06.3·.6·.7·.11의 10, ARCH-02, ADR-019, AC-40. 고칠 결함:
  - 처짐·비지지 길이·유효 길이가 분할된 해석 부재 기준이라 비보수적이다.
  - `aboveZ_m` 수평 구속이 그 높이 위 모든 절점을 잡는다.
  - 곡선 병합 조각이 가새로 바뀐다.
  - 해석이 엔진 스레드를 막는다.
  - 강재 자중이 기본으로 꺼져 있다.
  - `structure-draft-review`에 인용 검사가 없다.
- **변경 범위:** `src/jigs/official/structure-analysis/`
  - `buildFrameModel`
    - 역할·지점·접합·하중을 명시해서 만든다. `buildDraft` 역추정을 거치지 않는다
    - 곧은 부재는 접합점에서만 나누고, `segmentCurve`(최대 1.0 m·처짐 5 mm)는 곡선 레일에만 쓴다
    - **분할 부재마다 `design.Lb_m`·`K2`·`K3`를 물리 부재 기준으로 채운다.** 강접 단부 부모멘트 구간은 변곡점까지, 모르면 전 길이로 둔다. 기둥은 구속 사이 길이, 구속 레벨 위 구간은 `swayK`를 쓴다. 채우지 못한 부재는 '미완'이다
    - **수평 구속은 지정 레벨의 기둥 절점만**(`lateralRestraint.nodes`)으로 두고 기둥별 구속 반력을 낸다
    - D 패턴의 강재 자중을 켜고, 조합은 이름 있는 계수 표로 넘긴다(게이트 `combo-echo`)
  - `analyzeSummary(model, map, {mode})`
    - 부재별 상태·검정비·지배 조항과 물리 부재 요약을 낸다
    - 안정성 확인은 기하가 바뀔 때만 한다
    - **작업 스레드에서 돌리고 가장 최근 요청만 남긴다**
    - `mode: 'preview'`(결정 A6)는 '미확정 미리보기'로 표시하고 저장하지 않으며 보고서에 확정으로 쓰지 않는다. 부재 Rhino에 만들기 앞 게이트는 `analysis-confirmed`다
  - `referenceDeflection`(결정 A8): 양 끝 지지를 잇는 현 기준선 + 코어의 부재 처짐. '참고 처짐'으로 따로 보이고 판정에 합치지 않는다
  - 검토하지 않은 항목 목록(게이트 `unchecked-listed`)
  - `src/server/execution.ts`: jig 인용 검사를 `structure-draft-review`에도 적용(`ref-whitelist`)
  - 범용 구조 jig 화면: 판정 경계 하드코딩을 판정 범례 부품으로 바꾸고, 초안을 3D 겹침으로 보인다(PLAN-22 T-041·T-048)
  - ARCH-02를 코드 필드에 맞춰 정리한다
- **선행:** T-050, PLAN-22 T-041·T-048, SPEC-06 .3 개정·ADR-019 개정 review.
- **검증:**
  - 정상: `lb-k`(강접 단부 거더 + 작은보 2.5 m에서 Lb·K가 물리 부재 기준으로 채워짐), 합성 모델에서 참고 처짐 ≥ 분할 부재 처짐, 곡선 거더의 추력이 기둥 절점 구속 반력에만 나타남
  - 규모: 요약은 [ARCH-03](../architecture/ARCH-03-jig-runtime.md) §13 목표(1,785부재·2조합 ≤ 60 ms, 응답 ≤ 50 KB), **해석 중 `/links` 응답 지연 ≤ 50 ms**
  - 실패: Lb·K를 못 채운 부재는 '미완'(통과로 세지 않음), 점검 오류가 있는 모델은 미리보기 해석 대신 오류를 보임, 미리보기 결과는 저장·보고서 확정 표기 없음, 입력 조합 ≠ 결과 조합이면 `combo-echo` 실패, `structure-draft-review`에서 없는 부재 인용 거절
  - 회귀: 기존 `npm run test:structure` 통과
- **완료:** 위 시험 통과. 범용 구조 jig와 S-06 jig가 같은 라이브러리를 쓴다.

### T-053 · S-06 ⑤ 거더망 ~ ⑧ 해석 {#t-053}

- **목적/기준:** 기둥 사이 삼각망 거더·테두리보·줄돔 곡선·작은보를 만들고 해석한다. FR-23, SPEC-06.11의 3~7·10, SPEC-06.3, AC-42.
- **변경 범위:** `extensions/jigs/s06-frame/steps/`
  - ⑤ 거더망·테두리보
    - 삼각망을 만들고 경계·보이드·신설 E.J.를 넘는 모서리를 지운다
    - 경간은 `spanRule`로 판정한다
    - `cantilever-max`를 판정한다. 내민 보 위 테두리보는 지지로 세지 않는다
    - 내민 보·테두리보·보이드 둘레 보를 만들고 가장자리 선하중을 싣는다. 테두리보는 6 m 이하로 나눈다
  - ⑥ 줄돔 곡선: 사용자가 그린 구역 안의 거더를 연직면 단일 곡률 원호로 바꾼다. 솟음은 슬래브(패널) 하면에 맞춘다
  - ⑦ 작은보: 닫힌 칸마다 가장 긴 변과 평행하게 `beamSpacing` 이하 간격으로 둔다. 1.0 m 미만은 빼고, 구역별 데크 위치를 적용한다
  - ⑧ 해석(T-052)
    - 기둥 하단, 수평 구속, `swayK`, `jointRule`, 구역 하중표·자중·가장자리·천장 하중, 조합 4개를 넣는다
    - 손을 떼면 미확정 미리보기를 보인다. 1천 부재·4조합 이하에서 ≤ 150 ms가 목표다
    - [해석 확정]은 사람이 누른다
- **선행:** T-051, T-052.
- **검증:**
  - 합성: `slab-void-ej`, `arch-zone`, `cantilever-edge`, `triangle-infill`, `scale-2000`·`scale-4000`(해석 부재 수 ≤ 1,000·≤ 2,000, 시간 기록)
  - 실패: 경계 밖 거더는 `inside-boundary`로 Rhino에 만들기 차단, 한 연직면을 벗어난 곡선은 `planar-curve` 차단, 신설 E.J.를 넘는 거더 0, 기존 E.J.는 분절에 쓰지 않음
- **완료:** VERIFY에 M2 결과 기록.

## M3 — 단면·일람표·Rhino에 만들기

### T-054 · structure-analysis 1차 — 단면 선정·단면 성질·부호·일람표 {#t-054}

- **목적/기준:** 단면 자동 선정, 재계산해도 유지되는 부호, 일람표와 CSV(SPEC-06.7). S-18 자산을 이식한다(결정 F2.7, RESEARCH-08). FR-23, SPEC-06.12, AC-42.
- **변경 범위:** `src/jigs/official/structure-analysis/`
  - `sizeGroups`
    - 그룹 = 역할 × 경간 띠 × 구역. 후보는 KS H, 춤 ≤ 상한, 무게순이다. 확정 모델에서 출발한다
    - 최대 6회 반복한다. 올리고 내리기는 후보 전수 중 가장 가벼운 것으로 한다. 참고 처짐은 단면을 고르는 기준으로만 쓰고 판정에는 넣지 않는다(A8)
    - 후보가 없으면 '후보 없음'으로 두고 가장 무거운 단면을 조용히 고르지 않는다. 수렴하지 않으면 경고한다
    - 결과 단면은 다시 확정해야 쓰인다
  - `hProps`: 물량용이며 검정에 쓰지 않는다
  - `stableMarks`: S-18 부재 대조 규칙을 이식해 같은 부재는 같은 부호를 유지한다. 부호 규칙은 표준 파일 확인 전 '가정'이다
  - `schedule`: 부호·역할·단면·개수·총길이·단위중량·중량·최대 검정비·지배 조항, 곡선이면 반지름·솟음·현 길이
  - `toCsv`: 수식 주입을 막는다
  - 게이트 `mark-unique`·`schedule-complete`
- **선행:** T-052.
- **검증:** 정상 — 6회 안 수렴, 다시 계산 뒤(`rect-grid-degenerate` ±1 mm) 같은 부재 같은 부호, 모든 부재가 일람표에 있음, 단면 선정 ≤ 1초. 실패 — '후보 없음' 상태가 보고서·원장으로 이어짐, CSV 수식 문자 앞 `'` 처리, 반지름·솟음이 다른 곡선 부재는 같은 부호로 묶지 않음.
- **완료:** 단위 시험 통과. 범용 구조 jig에서도 CSV를 낸다.

### T-056 · S-06 ⑨ 단면 선정 ~ ⑫ Rhino에 만들기 {#t-056}

- **목적/기준:** 예비 단면·높이 점검·부호 일람표를 내고 상단선과 부재를 Rhino에 만든다. FR-23, SPEC-06.11의 8·9, SPEC-06.12·.13, SPEC-07.12·.13, AC-42·43.
- **변경 범위:** `extensions/jigs/s06-frame/steps/{sizing,heights,schedule,bakeplan}.ts`
  - ⑨ 단면 선정: T-054를 쓴다. 거더·작은보는 KS H 춤 ≤ 900, 목표 0.90
  - ⑩ 형하·높이
    - 형하 = 최저 부재 하단 − 마감 − 점검 구역 바닥 EL ≥ 2.4 m
    - 소방 동선 위 5.0 m 미달은 판정 '불가'
    - 보 춤 + 마감 ≤ 1,200 mm를 점검한다
    - 기둥–거더 레벨 차 표를 낸다
  - ⑪ 부호·일람표: T-054를 쓰고, 연결 도면·자료에서 같은 부호가 발견되면 경고한다
  - ⑫ Rhino에 만들기 계획(PLAN-22 T-055)
    - **상단선만** 만든다: 축선·기둥선·거더 상단선(원호 포함)·작은보 상단선 → `{layerRoot}::jig 상단선`
    - 부재 H Brep은 상단선 아래에 웨브를 연직으로 둔다 → `{layerRoot}::jig 부재`. 기둥 H는 강축 방향을 따른다
    - 부호 TextDot은 선택이다. 중심선은 만들지 않는다
    - [선만 먼저 만들기]를 둔다. 부재 만들기에는 `analysis-confirmed`가 필요하다
- **선행:** T-053, T-054, PLAN-22 T-055.
- **검증:**
  - 합성: `height-floor`(기둥 길이 1 m 단위 내림, 강재가 슬래브를 뚫지 않음)
  - 실데이터(`.vide/` 사본 문서): 두 번 만들기 → 중복 없음, 다른 객체 지문 불변, 사람이 옮긴 기둥 선 보존, 복사한 객체 보존
  - 인쇄: 일람표 CSV와 조합·미검토 목록
  - 실패: 확정 해석 없이 부재 만들기 차단, 출력 레이어가 꺼져 있으면 차단 안내
- **완료:** VERIFY에 M3 결과 기록.

## M4 — 보고서

### T-058 · S-06 골조 사전 점검 보고서 {#t-058}

- **목적/기준:** 결과를 외부에 설명할 보고서와 미결 원장. FR-23, SPEC-06.7(결과·미검토 항목·탐색용 예비값), SPEC-07.11.
- **변경 범위:** `extensions/jigs/s06-frame/reports/frame-study.json`(PLAN-22 T-057 틀)
  - 01 경간: 막대, 12 m 한도, 배치 대안 비교
  - 02 기초: 간섭, 토목사무소 협의 목록
  - 03 골조: 삼각망·테두리보·줄돔·신설 E.J. 분절
  - 04 해석: 첫 줄에 조합 계수·가정·**검토하지 않은 항목**. 검정비 분포, 참고 처짐, 기둥별 수평 반력
  - 05 일람표: 부호 일람표, 강재 합계
  - 06 미결 원장: 질문·근거·누가 답하나·막는 단계. 구조사무소 확인(강재·대각 경간·E.J. 상세·기둥 계열과 접합·파일캡 크기), 토목사무소 확인(기존 기초·기존 E.J. 걸침·구속 강성), 협력 건축사무소 확인(부호 체계)
  - 부록: 설정값 원장
  - M0 진단 보고서: 01·02절만, 경간 표를 따로 둔다
  - KPI 이름은 '중력 조합 부재 검정 여유'다
- **선행:** T-056, PLAN-22 T-057.
- **검증:** 정상 — `claim-consistent`·`numbers-in-source`·`unchecked-listed` 통과. 실패 — 미확정 미리보기 값이 '확정'으로 쓰이지 않음, 확정 전이면 해석 칸을 비운 이유를 보임.
- **완료:** VERIFY에 M4 보고서 한 부와 인쇄 확인을 기록.

## 2차

### T-067 · 구조 코어 확장 — 설계 부재 판정·한 번 분해 {#t-067}

- **목적/기준:** 1차 TS 보완을 Rust 코어로 옮겨 판정과 성능을 코어에서 맡는다. 해석·검정 코어는 Rust라는 ADR-019 결정 2를 따른다. ARCH-02 개정.
- **변경 범위:** `src/native/structure/`, `src/contracts/structure-model.ts`, ARCH-02
  - `designMembers[]`: 분할 부재 목록 + Lb·K·처짐 한계. 설계 부재 처짐을 판정으로 옮긴다
  - 결과 요약 모드(`detail:'summary'`)
  - **인장 전용 부재가 없으면 여러 하중 조합을 한 번 분해 + 여러 우변으로 푼다**
  - napi `size()`·`sectionProps`
  - `springs`(슬래브 레벨 수평 스프링, 토목사무소 확인 뒤), `offsets`(상단 기준 편심)
  - KS 단면 표 확장(RESEARCH-08 병합 계획)
- **선행:** 2차 착수 지시, ARCH-02 개정 review, T-052·T-054.
- **검증:** 정상 — 기존 `npm run test:structure` 전부, 같은 모델에서 1차 TS 경로와 검정비 일치, 설계 부재 처짐과 참고 처짐 대조. 성능 — 4,361부재·23조합 코어 ≤ 400 ms, 코어 안 단면 선정 ≤ 0.3초. 실패 — 인장 전용 부재가 있으면 조합별 분해로 돌아감.
- **완료:** 성능 기록 후 1차 TS 보완 경로를 코어 경로로 교체.

## 순서와 의존

- M0: T-042 → T-044(PLAN-22 T-041, 토목 모델 import 경로면 T-043).
- M1: T-050 → T-051(PLAN-22 T-045~T-048, PLAN-24 T-049).
- M2: T-052 → T-053.
- M3: T-054 → T-056(PLAN-22 T-055).
- M4: T-058(PLAN-22 T-057).
- M5: PLAN-22 T-064가 T-051의 ③ 결과와 대조한다.
- 2차: T-067.

## 검증 원칙

- 저장소 fixture는 합성 자료만 쓴다(`extensions/jigs/s06-frame/fixtures/`, 기대값 허용오차 길이 1 mm·비율 1e-3). 실제 S-06은 `.vide/` 사본으로만 열고, VERIFY에는 결과 수치와 가정만 적는다. 사용자 원본은 에이전트가 호스트로 열지 않는다.
- 수치 통과는 fixture로 판정하고, 기준선 재현·실데이터 결과는 VERIFY에 따로 적는다. 구조 결과는 탐색용 예비값으로 표시한다.
- 사용자가 결정한 규칙(F2·D)과 자료 DB 진술이 다르면 기본값을 바꾸지 않고 06 원장의 확인 사항으로 올린다.

## 현황(2026-09-30)

- **T-042 · geometry-kit 진단 함수 — 완료(2026-09-29, 코드 검토 2026-09-30).** `src/jigs/official/geometry-kit/`(`plan`·`separation`·`footprint`·`split`·`index`, `library = vide/geometry-kit 0.1.0`, `node:` import 없음). `blockFootprints`(행 우선 4×4 변환, `solid`·`base`·`outline`), `separation`·`signedDistance`(분리축, 겹치면 밀어낼 깊이의 음수, 떨어지면 꼭짓점–변 실제 최소 거리), `clipConvex`·`overlapArea`, `bandFromMesh`(볼록 껍질), `splitAtSupports`, `planLength`, `minAreaRect`. 검토에서 고친 것: 한 발자국이 다른 발자국 안에 들어간 경우의 깊이를 공유 폭이 아니라 빠져나갈 거리로 계산하고(2.0 m 캡이 2.7 m 기초 안에 있으면 −2.35), 맞닿기만 한 두 도형의 `clipConvex`는 `[]`을 돌려준다. 증거: `tests/core/geometry-kit.test.mjs` 7개 통과(1천 부재 규모 반복 실행 약 13 ms). 남음: `bandFromMesh`·간섭 함수는 볼록 입력만 받으므로 곡선 유수지 보의 오목 외곽선(`outlineFromMesh`)과 오목 간섭은 T-050이다.
- **T-044 · S-06 M0 진단 — 구현·합성 검증·기준선 재현 완료(2026-09-29, 코드 검토 2026-09-30).** `extensions/jigs/s06-frame/steps/{diagnose,diagnose-csv,labels,sync-input}.ts`와 합성 자료 `fixtures/synthetic.ts`, 임시 경로 `src/server/jig-routes.ts`(`GET …/jigs/structure/layers`, `POST …/jigs/structure/diagnose`, 읽기 전용, Sync 8개·역할당 레이어 8개·객체 5만 개 상한), 화면 `src/ui/s06-diagnose.tsx`(구조 jig의 [배치 진단] 보기: KPI 띠·간섭/경간/곡선 표·CSV·3D 겹침·행↔3D 왕복). 기준선 재현은 [VERIFY-2026-09-29-s06-frame](../tdd/VERIFY-2026-09-29-s06-frame.md): 파일캡 불가 9 / 오픈컷 협의 33 / 유수지 보 경고 6 / 곡선 > 12 m 19(최대 18.9 m), 경간 표 62개 중 초과 19·최대 18.94 m. 맞닿음 허용오차 10 µm(Sync의 1 µm 반올림 흡수)를 검증 항목에 더했다. 검토에서 고친 것: 설정값은 아는 키만 받아 되돌린다, 파일캡 이격(`capClearance`) 안에 들어왔지만 닿지 않은 기초는 채움 대신 외곽선과 번호표로 표시한다, 레이어 이름 복호를 값마다 한 번만 해서 20만 행 Sync의 역할 읽기가 1.35초 → 0.11초가 됐다, 화면 설정값 검사가 경로와 같은 범위를 쓴다. 증거: `tests/core/s06-diagnose.test.mjs` 7개, `browser-s06-diagnose.mjs`(역할 추정·KPI·표·CSV·겹침 켜고 끄기·행↔3D·읽기 전용·경로 거절) 통과.
- T-044 남음: 실제 토목 모델은 제품 Sync가 아니라 사본 변환으로 읽었다(사용자가 토목 모델을 연결·Sync한 뒤 화면 경로로 재대조). 레이어 이름 규칙은 토목 모델의 기초 블록(기둥 레이어)을 기존 기초로 추정하지 못해 사용자가 지정해야 한다. 화면은 역할마다 레이어 하나만 고른다(경로는 여러 개). 경간은 평면에서만 끊으므로 높이가 다른 층의 기둥도 거더를 끊을 수 있다. 유수지 보 띠는 볼록 껍질이다. 진단 뒤 역할·Sync를 바꿔도 이전 결과가 그대로 보인다(다시 진단해야 갱신). 임시 경로와 `sync-input.ts`는 T-051에서 v3 단계로 옮기며 지운다.
- **T-050 · geometry-kit 배치 함수 — 구현·단위 검증 완료(2026-09-30, 코드 검토 2026-09-30).** `src/jigs/official/geometry-kit/` 0.2.0: `triangulate`(`delaunator` + `@kninnug/constrainautor`, 호출자 제약 모서리 보존, 슬래브 밖·보이드·장벽 교차 제거, 공원 네 점 칸의 결정적 대각선: 짧은 것·차 ≤ 0.05 m면 u+v·이전 결과가 0.2 m 안이면 유지, 슬리버 제외, `mergeQuads`)·`triangulateRegion`, `polygon.ts`(민코프스키 합·들임·교차·경계 거리), `outlineFromMesh`(윗면 외곽, 오목·보이드), `window.ts`(회전 격자의 허용 창), `infill.ts`(칸 채우기·테두리 들임선·내민 보), `arc.ts`(3점 원호·연직 아치·분할), `split.ts`의 `zTolerance`(다른 층 기둥은 거더를 끊지 않음). 의존성 `delaunator` 5.1.0(ISC)·`@kninnug/constrainautor` 4.1.0(ISC)·`robust-predicates` 3.0.3(Unlicense). 증거: `tests/core/geometry-kit-layout.test.mjs` 11건(제약 보존·`rect-grid-degenerate` ±1 mm·공원 대각선·`grid-4m-bay`·`grid-rot21` 창·오목 외곽·채우기·내민 보·원호·z 허용·1천 기둥 ≤ 50 ms).
- 남음: 자기교차 다각형 거절은 `requirePolygon`의 검사 범위대로이며 배치 함수 시험 목록에는 따로 없다. T-044의 볼록 껍질 띠(`bandFromMesh`)를 `outlineFromMesh`로 바꾸는 것은 T-051이다.
- **T-052 · structure-analysis 1차 — 라이브러리 구현·단위 검증 완료, 범용 jig 연결 남음(2026-09-30, 코드 검토 2026-09-30).** `src/jigs/official/structure-analysis/`: `buildFrameModel`(역할·지점·접합·하중 명시, 곧은 부재는 접합점에서만 분할, 곡선 레일만 `segmentCurve` 현 ≤ 1.0 m·처짐 ≤ 5 mm, 조각마다 `design.Lb_m`·`K2`·`K3`를 물리 부재 기준으로 채움 — `designForBeam`: 정모멘트 구간 = 횡지지 간격, 강접 부모멘트 구간은 변곡점까지·모르면 전 길이, 캔틸레버 전 길이·K 2.0; `designForColumn`: 구속 사이 길이, 최상 구속 위 구간 `swayK` — `lateralRestraint.nodes`는 지정 레벨의 기둥 절점만, D 자중 켬, 명목 수평하중 `N{X,Y}_{D,L}` = 비율 × 절점 중력에 조합 계수 그대로, H형강 강축 ±15° 접합 규칙), `analyzeSummary`(작업 스레드, 키별 최신 요청만), `runAnalysis`(정적 점검 → 기하가 바뀔 때만 안정성 확인 → 코어 → 원인 분류 → 요약), `referenceDeflection`(현 기준 + 조각 처짐, 늘 조각 처짐 이상), `summarize`(`vide.structure.summary/1`, 설계 값 없는 조각은 `na`), 점검 `comboEcho`·`uncheckedListed`·`analysisConfirmed`. 계약 `src/contracts/structure-model.ts`: `designMembers[]`(조각은 한 설계 부재에만), `nature: 'N'`, `lateralRestraint.nodes` 필수(`aboveZ_m` 제거), 요약 스키마. `review.ts`를 `checkModelStatic`·`stabilityProbe`·`probeIssues`로 나눴고 ARCH-02를 v0.2로 정리했다. 증거: `tests/structure/{frame-model,summary,worker}.test.mjs` 19건(`lb-k`, 구속 절점·자중·명목·조합 항, 강축 규칙, 곡선 분할·아치 추력이 구속 기둥 절점에만, 참고 처짐 ≥ 조각 처짐, 1,500조각 요약 ≤ 50 KB, 작업 스레드의 이벤트 루프 지연 < 50 ms·최신 요청 우선, 미완·invalid·unstable)와 기존 `tests/structure` 28건 통과.
- 남음: 범용 구조 jig의 `POST …/jigs/structure/analyze`는 T-054에서 작업 스레드 `analyzeSummary` 경로로 바뀌었다(확정 기록에 `summary`·`colorBands`, 불안정도 422). 화면의 3D 겹침 초안은 아직 하지 않았다(판정 범례·인용 검사는 아래 'T-052 남은 것'). 완료 기준 "범용 구조 jig와 S-06 jig가 같은 라이브러리를 쓴다"는 이 연결 뒤에 닫는다. 캔틸레버 참고 처짐은 뿌리 절점의 이동만 빼고 회전은 빼지 않는다(참고 표시). 코어의 `above_z`는 T-067에서 지운다.
- **T-051 · S-06 골조 jig 0.1 ⓪~④ — 구현·합성 검증 완료, 실데이터 검수 남음(2026-09-30, 코드 검토 2026-09-30).** `extensions/jigs/s06-frame/`(`jig.json` v3 `project/s06-frame@0.1.0`: 입력 조립 역할 10개·구역 2개·설정값 23개(일반 기본값만, `basis.status`에 `confirmed` 없음), 단계 ⓪ `assemble` → `confirmInputs`(사람, 계산을 막지 않음) → ① `diagnose`(T-044 판정 코드 그대로) → ② `axes` → ③ `columns` → `footprints` → ④ `interference`; `panel.json`(3D 층 12개·평면·슬라이더 판·KPI 6·서랍 7탭); `skill.md`; `steps/{roles,assemble,layout,axes,columns,footprints,interference,diagnose-step}.ts`; `fixtures/cases.ts` → `grid-rot21`·`grid-4m-bay`·`priority-conflict`). 결정 반영: 경간 12 m는 대각 포함 모든 거더에 끝까지 지키고(`spanRule: all`, 탐색의 경계 조건), 목적은 경간 > 슬래브 끝 미지지 > 파일캡 > 유수지 보 > 오픈컷 > 기둥 수의 사전식, 소방 동선은 배치 후보에서 빼고 수정 사항으로 넣은 기둥도 뺀다, 신설 E.J.마다 쌍기둥 + 공통 캡, 기둥 길이는 `heightStep` 단위 내림과 받침 높이 표, 비켜 두기는 제안만. 증거: [VERIFY-2026-09-30-s06-frame-m1](../tdd/VERIFY-2026-09-30-s06-frame-m1.md)(`jig:validate`, `jig:test` 3건, `tests/core/s06-jig.test.mjs` 10건: 조립, M0 수치 재현, −21° 격자 경간 초과 0, 한 방향 이격, 우선순위 충돌의 경간 유지 + 파일캡 목록, 쌍기둥·요청 영역·소방·높이, 간섭·확인 목록, 엔진 실행기, 잘못된 입력, 규모 70 기초 < 1초), `browser-s06-jig.mjs` 통과.
- 남음: 실데이터(`.vide/` 사본) ②~④ 검수, 단발 AI 역할 제안(T-049 `input-roles`)을 `assembly/propose`에 연결, CAD 정렬 변환·잔차의 단계 적용, 유수지 보 띠의 볼록 껍질, 임시 진단 경로·`sync-input.ts` 제거. 계획한 합성 사례 중 `stagger-diagonal`·`basin-band`·`requested-zone`·`height-floor`는 별도 fixture가 없다(요청 영역·높이는 `grid-rot21`에 포함). 브라우저 시험은 구역을 경로로 넣어 사람이 그리는 경로는 보지 않는다. 삼각망·테두리보·작은보는 M2이며, 위 M2 머리말의 사용자 지시대로 ⑤의 1차 경로는 그려 둔 거더 보정이다.
- **T-054 · structure-analysis 1차 단면 선정·부호·일람표 — 구현·단위 검증 완료(2026-09-30, 코드 검토 2026-09-30).** `src/jigs/official/structure-analysis/` 0.2.0: `sizing.ts` `sizeGroups`(역할 × 경간 띠 × 구역, KS H 춤 상한 이하 무게순 후보, 지배 조항별 용량 추정 `capacity.ts`, 최대 6회, 놓친 단면은 다시 안 씀·통과 단면 기억·안정 뒤 바로 아래 후보 1회 시험, 후보 없음은 단면 유지 + 필요한 춤 안내, 미수렴은 무거운 쪽 + 경고, 모두 `preview`), `marks.ts` `stableMarks`(접두 SC/SG/SEG/SB/SCB/STB는 가정, 접두 × 단면 × 곡선(반지름·솟음 허용) 묶음, 위치 순 번호, 이전 원장으로 같은 부재 같은 부호·번호 재사용 없음, split/merge/same-line/moved 대응), `schedule.ts` `schedule`·`toCsv`(부호별 개수·길이·물량용 단위중량·최대 검정비·지배 조항·최악 판정, 곡선 열, 미리보기 표지), `csv.ts`(BOM·CRLF·전체 인용·수식 문자 `'`), `curvature.ts`, 점검 `mark-unique`·`schedule-complete`, 계약 `markLedgerSchema`·`structureScheduleSchema`(`src/contracts/structure-model.ts`), 범용 jig의 `POST …/jigs/structure/analyze`를 작업 스레드 `analyzeSummary`로 바꾸고 기록에 `summary`·`colorBands`를 남김, ARCH-02 v0.3 §4.3·§4.4. 증거: `tests/structure/{sizing,marks,schedule}.test.mjs` 17건, `server.test.mjs`(확정 경로가 작업 스레드를 거쳐 요약을 기록), 기존 `tests/structure` 포함 64건 통과.
- 남음: 범용 구조 jig 화면의 CSV 내보내기(`GET …/schedule.csv`)와 S-06 ⑨~⑪ 연결(T-056)은 하지 않았다("범용 구조 jig에서도 CSV를 낸다"는 그때 닫는다). 단면 선정 ≤ 1초는 합성 한 칸 골조에서만 보았다. 부호 접두 표는 S-18 표준 파일 확인 전 '가정'이다.
- **T-053 · ⑤ 거더망 ~ ⑧ 해석(그려진 배치 우선) — 구현·합성 검증·실데이터 읽기 전용 확인(2026-09-30), 실데이터 해석 불안정 남음.** `project/s06-frame@0.2.0`에 단계 `girders`(그려 둔 거더 보정: 끝 붙임·분할·중복 합침·원호 맞춤·기둥 없는 끝·경계 교차·경간, 기둥 높이 허용치 `zTol_m`, `C01…`·`G01…` 평면 순 번호), `cells`(geometry-kit `planarFaces`·`interiorPoint`로 거더망 면을 슬래브로 자르고 보이드를 뺀 칸 `K01…`), `beams`(작은보 간격 2.0~3.0 m·방향·오목 칸에서 거더와 겹치는 선 제거·가장자리 내민 보), `model`(해석 모델·하중·구속·모델 해시, 거더 단계의 기둥 대응 우선), `analysis`(미리보기)와 사람 단계 `confirmAnalysis`를 더했다. 설정값 `layoutSource`가 '그려진 배치'면 ②~④는 빈 결과와 안내만 낸다. 해석은 작업 스레드·네이티브 코어가 필요해 엔진 안에서 돌고, 자식 프로세스에서는 `unavailable`을 돌려준다. 검토에서 자식 실행기 읽기 허용에 `src/jigs/structure`·`src/contracts`를 더하고(ARCH-03 §6.4), `jig:test`가 다른 단계 실패를 숨기던 판정과 내민 보 하중 이중 계산을 고쳤다. 증거: `tests/core/s06-{girders,beams,analysis,m2}.test.mjs`·`geometry-kit-faces.test.mjs`, `browser-s06-jig.mjs` 통과, [VERIFY-2026-09-30-s06-frame-m2](../tdd/VERIFY-2026-09-30-s06-frame-m2.md)(실데이터: 거더 62·칸 20·작은보 46, 미리보기 18~145 ms).
- 남음: **실데이터 해석이 `unstable`이다.** 기둥 절점에 뿌리를 둔 가장자리 내민 보의 뿌리가 라이브러리 강축 규칙으로 핀이 되어 기구가 된다(`frame-model.ts` 규칙 조정 필요, VERIFY 남은 문제 1). 구속 레벨·하중·단면은 가정값이고 보이드 역할 확정 뒤 다시 본다. 새 배치 제안 쪽 ⑤~⑦(삼각망·테두리보·곡선 생성)은 뒤로 미뤘다.
- **T-052 남은 것 — 구현 완료(2026-09-30).** 범용 구조 jig 화면에 판정 범례(`VerdictLegend`: 구간별 개수·판정 거르기·판정색 켜기/끄기, 경계값은 확정 기록의 `colorBands`), '확정 결과'/'미확정 미리보기' 표시, 전체 검정 행의 CSV 내보내기(`checksCsv`, BOM)를 넣었다. `structure-draft-review` 답의 부재·절점 인용 검사(`src/server/jig-gates.ts` `jigCheck`: 허용 목록은 `jig.refs` 또는 첨부 초안, 없는 ID는 경고 문구만 덧붙임)를 넣었다. 증거: `tests/server/execution-gates.test.mjs`. `browser-structure-jig.mjs`는 수정만 하고 돌리지 않았다.
- T-052·T-044 화면 4차 물결(2026-09-30): 진단 보기에서 역할마다 레이어 여러 개를 고르고, Sync·역할 레이어가 바뀌면 이전 결과와 겹침을 지우며, [이 jig로 열기]가 기존 경로만으로 S-06 작업본을 만들고 역할을 확정해 문맥 탭을 연다(진단 설정값은 넘기지 않음). 범용 구조 jig는 결과 표지를 요약 줄 앞에 둔다. `browser-s06-diagnose.mjs`·`browser-structure-jig.mjs`는 고치기만 하고 돌리지 않았다. 임시 진단 경로는 아직 쓰므로 남겨 두었다.
- T-053 4차 물결(2026-09-30): 내민 부재는 양 끝을 강접으로 두고, 모든 단부가 핀인 절점은 두 부재를 이어 두며(가정 목록에 남김), 해석 전 기구 사전 점검 `mechanism.ts`(`findMechanisms`·`mechanismIssues`: 뿌리 핀 내민 끝·트러스 하나만 닿은 자유 절점은 `MECHANISM` 오류, 풀린 자유단은 `RELEASED_TIP` 경고, `ALL_PINNED`·`TORSION_ROOT` 경고)를 넣었다. 증거: `tests/structure/mechanism.test.mjs`. 기둥 뿌리 내민 보 3개는 풀렸으나 **실데이터 전체 모델은 여전히 `unstable`**이다 — 거더 중간에서 나온 내민 보 13개의 뿌리를 거더 비틀림만 잡는다(`TORSION_ROOT` 13건). 배치(받침 보 추가)나 구속 가정의 사용자 판단이 필요하다.
- **T-056 · ⑨~⑫ — 단계 연결·합성 검증 완료, 실제 Rhino와 단면 적용 경로 남음(2026-09-30 4차).** `project/s06-frame@0.3.0`에 ⑨ `sizing`(미리보기 기준, '후보 없음' 묶음은 시작 단면으로 되돌림) → ⑪ `schedule` → ⑩ `heights` → ⑫ `bakePlan`·`bakeMembers`(확정 해석과 단면이 같을 때만 미리보기가 아님)를 잇고, 만들기 선언 `lines`·`members`·`member-columns`, 설정값 `targetRatio`, 서랍 탭(단면·일람표·높이·만들기)과 KPI '강재'를 더했다. 증거: [VERIFY-2026-09-30-s06-frame-m3](../tdd/VERIFY-2026-09-30-s06-frame-m3.md), `tests/core/{s06-m3,s06-m3-steps,s06-bakeplan}.test.mjs`, `jig:test` 4건. 실데이터(읽기 전용): 일람표 부재 152·강재 133.2 t(기본 단면), 기둥 34개 1 m 단위 내림, 계획 선·부재 152, 해석이 `unstable`이라 단면 선정·부재 만들기는 막힘. 남음: 선정 단면을 모델에 적용해 다시 확정하는 경로(SPEC-06.12 결정 필요), 엔진 실행기가 단계에 이전 출력을 넘기지 않아 부호 원장이 이어지지 않음(ARCH-03 계약 필요), 서랍 탭 상한 8로 배치 제안 탭 4개를 뺌, 축선 미포함, 실제 Rhino 만들기, 브라우저 시험.
- **T-058 · S-06 보고서 — 01~05·부록 구현·합성 검증(2026-09-30 4차).** `frame-study.json`을 M3 단계 이름에 맞춰 채웠다(기둥 길이 표, 경간 막대, 하중 조합·가정·미검토·검정비 분포·지배 부재 10·반력, 일람표·물량·후보 없음, 남은 조건 표, 부록 설정값 원장, KPI '남은 조건'). `report.ts` `jigReportInputs`를 엔진 보고서 경로에 연결했고, 미리보기 계획이면 '부재 준비' 문장을 쓰지 않는다. 증거: `tests/core/s06-report.test.mjs`, `browser-report.mjs` 통과. 남음: 실데이터 보고서는 해석 안정 뒤다.
- **T-053 5차 물결 — 실데이터 해석 안정(2026-09-30).** `steps/beams.ts`: 가장자리 내민 보는 반 간격·45° 안의 안쪽 작은보 줄을 잇고(`continues`, 거더 쪽 끝 강접 `rigidAt`), 없으면 거더에 직각으로 내밀고 뒤쪽 보(`backspanOf`)를 더한다. 끝이 잘린 작은보는 건너편 작은보 끝으로 뿌리를 옮기되(자기 줄에서 15° 안) 못 옮기면 뒤쪽 보를 둔다. 한 가장자리의 내민 보 사이가 간격보다 넓으면 직각 내민 보를 더 두고, 내민 보마다 하중 폭 `width_m`를 준다. 선이 다른 거더를 5 cm 안에서 따라가면 그 거더로 본다(검정비 254의 원인이던 25.1 m 내민 보 제거). `steps/model.ts`: `rigidAt` 강접, `beamId` 끝은 받는 작은보 위 절점, 뒤쪽 보는 칸 면하중 없음, 내민 보 하중은 `width_m`, 거더끼리 만나는 곳에서 같은 줄로 이어지는 내민 보는 그 거더 끝을 강접. 실데이터(읽기 전용, 부재를 빼지 않음): 해석 `ok`, `TORSION_ROOT` 13 → 0, `MECHANISM` 0, 부재 159·강재 132.8 t, 판정 통과 43 / 주의 31 / 초과 85(기본 단면 미리보기). 합성 `beams-grid`의 `edgeCantilevers` 6 → 7. 증거: `tests/core/s06-{beams,analysis,m2,m3-steps,bakeplan,m3,jig}.test.mjs`, `jig:test` 4건, [VERIFY-2026-09-30-s06-frame-m2](../tdd/VERIFY-2026-09-30-s06-frame-m2.md) 새 절. 남음: 최대 검정비는 개구에 잘린 10.4 m 작은보(16.2)로, 보이드 역할과 개구 둘레 보를 정한 뒤 다시 본다. 기둥 13개는 세장비 한도 밖이다(구속 레벨 가정). 화면 시험은 돌리지 않았다.
- **T-056 5차 물결 — 선정 단면 적용·부호 원장(2026-09-30).** `project/s06-frame@0.3.1`: 사람 단계 `applySections`와 코드 단계 `sectionsApplied`(`steps/apply-sections.ts`, '선정' 묶음 중 모델과 다른 부재마다 수정 사항 `s06-section:<부재>` 하나, '후보 없음'·'미검토'는 유지)를 두고 패널 행동 [선정 단면 적용](T2)을 해석 확정 옆에 넣었다. 실행기는 단계가 자기 출력(`step.<자기 id>`)을 읽으면 마지막 보관 출력을 넘기고(ARCH-03 §6.2), 새 계산의 적용 요청(`applies`)을 수정 사항으로 넣은 뒤 한 번 더 계산한다. 그래서 적용 → 수정 사항 기록 → 다시 확정 → 부재 만들기 순서가 되고, 선정 단면이 모델과 다르면 `bakeMembers`가 거부한다. `schedule`이 이전 부호 원장을 받아 같은 부재는 같은 부호를 유지한다. 배치 제안 탭 4개를 되살려 서랍 탭이 12개다(`result-tabs` 상한 12). 증거: `tests/core/s06-{jig,m3}.test.mjs`, `jig:test`. 남음: 적용 버튼이 탭 안이 아니라 패널 행동 줄에 있다(탭 안 버튼은 `panel.tsx` 변경 필요). `browser-s06-jig.mjs`·서랍 탭 12개 화면은 UI 빌드 뒤 확인, 축선 미포함, 실제 Rhino 만들기.
- T-067은 2차다.
