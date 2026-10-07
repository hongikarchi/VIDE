---
id: PLAN-45
title: 규모검토 jig 세 개 — 사이트 모델링·건축 가능 영역과 매스·건축개요 (T-203~T-214)
status: draft
version: 0.13
updated: 2026-10-08
owner: agent:claude
related: [SPEC-12, SPEC-07, SPEC-02, SPEC-08, SPEC-13, ARCH-01, ARCH-03, DESIGN, ADR-026, ADR-030, ADR-040, RESEARCH-04, RESEARCH-16, FR-09, FR-12, FR-14, FR-18, FR-21, FR-24, FR-25, C-05, OQ-08, OQ-09, OQ-16]
---

# 규모검토 jig 세 개

2026-10-07 사용자 결정: 규모검토를 "site modeling / 법규 검토 사항을 바탕으로 모델링(건축 가능 영역) + 매스 검토 / 건축 개요 작성(문서작업)"으로 쪼개 개발하고, 계획은 "모두 상세"로 쓴다. 동작 정본은 [SPEC-12](../specs/SPEC-12-site-and-massing.md), jig 공통은 [SPEC-07](../specs/SPEC-07-jig-platform.md), 과거 수행 내역과 함정은 [RESEARCH-04](../research/RESEARCH-04-jig-past-experience.md) J-01·J-04, 흐름 메모는 [RESEARCH-16](../research/RESEARCH-16-domain-services-roadmap.md) §2다. 법규 판단과 규제 조건의 생성은 PLAN-46/SPEC-13, 도면 생성은 PLAN-47/SPEC-14가 맡는다. 전체 순서는 마스터 PLAN과 PLAN-44(로드맵)가 정한다.

## 착수 조건

- **범위:** 2026-10-07 사용자가 C-05를 채택했고 PRD §4.4·§14.2에 반영했다. 제품 티켓(T-205~T-214)은 PRD 채택을 더 기다리지 않는다. 사용자가 계획을 먼저 검토하기로 했으므로(PLAN-44) SPIKE 두 개(T-203·T-204)부터 검토 뒤 시작한다. SPIKE는 제품 지원으로 세지 않는다(AI.md §2).
- **과거 자산의 반입:** RESEARCH-04의 S-01·S-02·S-03·S-04·S-19 코드는 사용자의 비공개 자산이다. 계산 방식과 함정 목록은 참고하되, 실제 대지 자료·프로젝트 파일·`site.json`류 확정 값·키가 적힌 메모는 저장소에 들이지 않는다. 옮겨 쓰는 코드는 TS로 다시 쓰고 출처 코드(S-NN)만 커밋 메시지·티켓 증거에 적는다. S-19(ARCO-full)는 2026-10-07 사용자가 "Acro-full 코드의 경우 소유권과 라이선스 문제는 없어. 바탕화면에 있는 원본 소스코드를 참고해서 우리꺼에 맞춰서 작성하면 돼"라고 확인했으므로 소유·라이선스 확인 없이 바탕화면의 원본을 참고해 다시 작성한다. 국토지리정보원 설명서에서 뽑은 코드 사전처럼 공개 자료에서 만든 것은 출처를 `assets/NOTICE.json`에 적어 들인다(ARCH-03 §2.2).
- **시험 자료:** 모든 fixture는 합성 대지다. 좌표·지번·주소는 지어낸 값이거나 비프로젝트 공개 필지(공공기관 청사 등)이며, 사용자 프로젝트 대지는 쓰지 않는다. 실제 API 응답은 저장소에 넣지 않고 형식만 같은 합성 응답을 쓴다.
- **호스트:** Rhino 시험은 `.vide/` 아래 합성 문서로 하고, 에이전트가 띄운 Rhino는 시험 뒤 종료한다(AI.md §8).

## 재사용할 기존 코드·저장소

2026-10-07 사용자 지시 "기존에 만들어놓은 코드와 repo들을 잘 활용할 것"에 따라 아래 출처를 먼저 읽고, 같은 일을 하는 코드가 있으면 새로 짜지 않고 옮겨 쓴다. 출처 설명은 [RESEARCH-04](../research/RESEARCH-04-jig-past-experience.md) §1·§1.1, 실제 경로는 저장소 밖 대응표에 있다. 옮기는 방식은 위 「과거 자산의 반입」을 따른다.

| 출처 | 쓸 것 | 받는 티켓 |
|---|---|---|
| S-02 Site Maker | GH Python 컴포넌트 3종(SHP 넣기·필지 찾기·층수 매스 올리기), 좌표계 판별·재투영, `.cpg` 인코딩 처리, 국토지리정보원 코드 사전. 이 PC의 `site-maker` 스킬이 같은 세트다 | T-206·T-207·T-208 |
| S-04 논현동 규모검토 작업공간(검토엔진, S-01·S-03 계보) | 대지 자료 수집 스크립트(필지·높이·대장), 용도지역 걸침 분할, 규제 기하·일조 사선 외피·정북 판정·대안 조합·면적 계산, `.3dm` 내보내기, 검사 명령들(폐합·외피·대지). 대지 고유 가정이 섞여 있어 공통 부분만 골라 옮긴다 | T-204·T-205·T-209~T-212 |
| S-03 규모검토 1세대 작업본 | 지구단위계획 판독 절차서와 함정 목록, 건축개요 표의 항목 구성 | T-209(사람 입력 항목)·T-213 |
| S-19 ARCO-full | 대지 서버의 수치지형도 → `.3dm` 변환·지형 삼각분할, 지역 분석 서버의 자료원 어댑터(VWorld·건축물대장·공시지가), 매스 서버의 외피·법규 모듈 | T-203·T-205·T-206(지형)·T-210(비교) |

- T-203·T-204는 SPIKE 기록에 출처별 재사용 지도(구성요소 · 출처 · 그대로/손봐서/다시 작성 · 이유)를 남기고, T-205 이후 티켓은 그 지도를 따른다.
- 법규 판단 코드(검토엔진의 법규 부분, S-19 법규 서버)는 cLAWde가 종합한다(PLAN-46 T-215). 이 계획은 그 결과의 규제 조건만 읽는다.

## 공공 자료 키

- 종류: VWorld 키, 주소 검색 키, 공공데이터포털 키(건축물대장 등). 실제 필요한 조합은 T-203이 정한다.
- 보관: 이 PC의 VIDE 데이터 폴더 `public-data.env`(PC 전용, `typesafe.env`와 같은 취급). 설정 → AI → 외부 자료에서 넣고 지운다. 화면에는 있음/없음(과 환경 변수인지)만 보인다. 개발 중에는 같은 이름의 환경 변수가 우선한다.
- 지키는 것: 저장소·fixture·검수 증거·진단 묶음·계정 사이트 업로드·AI 문맥에 넣지 않는다. 로그·API 응답에는 키 이름과 있음/없음만 남긴다. 저장소 커밋 검사(Gitleaks)는 기존 설정 그대로 돈다.
- 공식 수집 라이브러리만 키를 읽는다. jig 단계·계산 상자·화면은 키를 받지 않는다(SPEC-07.9).

## T-203 SPIKE · 공공 자료 접근

- **기준:** SPEC-12.3·12.4, ADR-040, OQ-09. RESEARCH-04 §4 공공 데이터 수집 행.
- **위치:** 코드 `tools/spikes/2026-10-07-public-site-data/`, 기록 [SPIKE-2026-10-07-public-site-data](../tdd/SPIKE-2026-10-07-public-site-data.md).
- **질문:**
  1. 주소 → PNU: 주소 검색 API와 VWorld 검색 중 어느 것이 산 지번·도로명 주소·여러 후보를 안정적으로 주는가.
  2. 필지 경계·지목: VWorld 연속지적 레이어를 PNU 필터·범위 필터로 받을 때의 좌표계·개수 상한·페이지 나눔.
  3. 용도지역·지구: VWorld 용도지역 레이어(점 필터)와 토지이용계획 속성 API(PNU 필터) 중 저촉 여부·고시 번호까지 주는 쪽. 토지이음 화면에만 있는 정보가 무엇인가.
  4. 건물: 공공 건물 레이어의 윤곽·층수·높이 제공 여부, 건축물대장 표제부의 높이·층수와 대조하는 열쇠, 페이지 나눔 누락 여부.
  5. 수치지형도·연속지적도 SHP를 API로 받을 수 있는가, 아니면 사람이 내려받아야 하는가.
  6. 키 종류·일일 한도·이용 조건(재배포·캐시 허용, OQ-09)과 개인정보를 돌려주는 엔드포인트.
- **방법:** 비프로젝트 공개 필지 두 곳(일반 지번 1, 산 지번 또는 여러 필지에 걸친 도로명 주소 1)으로 호출한다. 응답은 저장소에 넣지 않고 필드 목록·개수·좌표계만 기록한다.
- **완료:** 자료별 채택 출처·대체 출처·필드 대응표, 키 조합, 한도, 금지 엔드포인트가 SPIKE 기록에 있고, T-205의 자료원 어댑터 목록이 정해진다. 결과가 SPEC-12.4 표와 다르면 SPEC-12를 먼저 고친다.

## T-204 SPIKE · 가능 영역·일조 사선 외피의 기하

- **기준:** SPEC-12.8·12.9, RESEARCH-04 J-04(뒤집힌 솔리드가 폐합 검사를 통과한 사례, 캡슐 보정, 지적 기반 일조 기준선).
- **위치:** 코드 `tools/spikes/2026-10-07-envelope/`, 기록 [SPIKE-2026-10-07-envelope](../tdd/SPIKE-2026-10-07-envelope.md).
- **질문:**
  1. 2D 후퇴·교집합: `vide/geometry-kit`의 다각형 연산으로 오목한 대지·가각·구간별 거리 후퇴가 되는가, 새 의존성이 필요한가.
  2. 일조 사선 외피를 엔진(TS)에서 평면 면 목록으로 만들고 닫힌 다면체로 검사할 수 있는가. 기준선이 여러 구간일 때 합치기와 꺾인 경계의 처리.
  3. 최대 외피(돌출 ∩ 사선 ∩ 높이)를 엔진에서 만들지, Rhino 틀 안에서 불리언으로 만들지. 엔진 쪽이면 결과가 결정적이고 시험이 쉽고, Rhino 쪽이면 기하가 견고하다.
  4. 닫힘·면 방향·부피 점검을 엔진 쪽에서 어떻게 보장하는가(뒤집힌 솔리드 거르기).
  5. 측량 좌표 규모(수십만 m)에서 f64 기준점 + f32 차이(ARCH-03 §9.2)로 외피를 넘길 때 정밀도.
- **방법:** 합성 대지 다섯 개(직사각형, 오목 L형, 정북에 도로, 경계가 꺾인 북측, 두 용도지역 걸침)로 TS 원형을 만들고, Rhino 사본 문서에 데이터 블록으로 만들어 `IsSolid`·부피 부호·`IsValid`를 비교한다.
- **완료:** 엔진/호스트 계산 위치, 필요한 공식 틀(T-208), 허용 오차, 점검 방식이 기록에 있다.

## T-205 공공 자료 수집 라이브러리와 키

- **기준:** SPEC-12.3~12.4·12.14·12.16, ARCH-01 §「외부 도메인 서비스」(읽기 응답의 출처·조회 시각·출처 구분 형식을 그대로 씀), SPEC-07.9. T-203 결과.
- **선행:** T-203.
- **변경:**
  - 공식 라이브러리 `vide/site-data`: `src/jigs/official/site-data/`
    - `sources/*.ts`: T-203이 정한 자료원 어댑터. 각 어댑터는 요청 만들기 · 응답 형식 검증(zod) · 정규화만 한다. 페이지 나눔을 끝까지 읽고 개수를 확인한다.
    - `lookup.ts`: 주소·PNU → 후보 필지.
    - `collect.ts`: 대상·주변 필지, 용도지역, 건물, 도로 필지를 범위로 모아 `{items, source, fetchedAt, provenance}` 사본을 만든다. 개수 0·대상 필지 누락·면적 차이를 '확인 필요'로 표시한다.
    - 금지 목록: 개인정보를 돌려주는 엔드포인트는 어댑터에 두지 않는다. 허용 끝점 목록 밖은 부르지 않는다(`http.ts`).
    - `library.ts`: `LIBRARY_MODULES`에 등록하는 jig용 면(SHP 읽기·PNU 도움 함수). 키가 필요한 수집 함수는 넣지 않는다.
  - 능력 `net.fetch`(공식 전용, `src/jigs/runtime/manifest.ts`에 이미 있음)를 이 라이브러리만 쓴다. 수집은 엔진이 키를 넣어 부른다.
  - 키: `src/server/public-data-keys.ts`(읽기·쓰기·있음/없음), 설정 → AI 탭 「외부 자료」(`src/ui/shell/public-data-section.tsx`), 진단 묶음 제외 목록(`src/server/diagnostic-bundle.ts`)에 `public-data.env` 추가. ARCH-01 「PC 설정·키」 표와 「공공 자료 수집」.
  - 전송 고지(FR-18): `src/contracts/site-data.ts`의 고지 내용(보내는 항목·받는 곳·보내지 않는 것, 판 해시)과 엔진 API(`src/server/site-data-routes.ts`). 고지를 확인하기 전에는 아무것도 보내지 않고 `needsConfirm`을, 끈 프로젝트는 `SITE_DATA_OFF`를 준다. 고지 카드와 프로젝트 설정의 끄기 화면은 수집을 시작하는 사이트 모델링 jig 패널과 함께 T-207이 붙인다.
- **검증:**
  - `tests/core/site-data.test.mjs`: 합성 응답으로 정규화·페이지 나눔·빈 결과 감지·면적 차이 경고·형식 다른 응답 거절·키 없는 자료만 '키 없음'.
  - `tests/server/public-data-keys.test.mjs`: 키 저장·있음/없음만 보임·환경 변수 우선·진단 묶음 제외·원격 세션 거절, 고지 전 미전송·확인 뒤 조회·수집·끄기, 진단 기록에 키·주소·PNU 없음.
  - 실호출(선택): 키 환경 변수가 있을 때만 도는 `tests/integration/site-data-live.mjs`(비프로젝트 공개 필지 1곳, 결과는 개수·좌표계만 출력하고 저장하지 않음).
- **완료:** 시험 통과, 키가 저장소·로그·진단 묶음 어디에도 없음을 Gitleaks와 묶음 목록으로 확인.

## T-206 SHP 넣기와 좌표계

- **기준:** SPEC-12.4(좌표계를 가정하지 않음, SHP 넣기), RESEARCH-04 J-01 함정(원점 따로 잡기, 시계방향 외곽링, 인코딩, 도로경계면 오인, 무벽건물).
- **선행:** 없음(키와 무관). T-205와 병렬.
- **변경:** `src/jigs/official/site-data/shp/`
  - SHP·DBF·PRJ·CPG 읽기, 좌표계 판별(UTM-K, 중부·서부·동부·동해 원점계 등), TM 정·역변환과 재투영, 진북·도북 차(격자 수렴각) 계산.
  - 외곽링 방향 정규화(반시계), 구 좌표계(Bessel) 감지 시 그 파일 거절.
  - 국토지리정보원 연속수치지형도 코드 사전(공개 설명서 출처, `assets/NOTICE.json`)으로 레이어·코드값을 한글 이름으로 해석. 건물·도로경계·등고선·표고점 레이어만 쓴다.
  - 넣은 파일은 작업본 사본으로만 둔다.
- **검증:** `tests/core/site-shp.test.mjs`
  - 합성 SHP(작은 사각 필지·건물·등고선을 코드로 만든 파일)로 파싱, 두 좌표계 파일을 한 좌표계로 옮겼을 때의 어긋남 < 1 cm, 시계방향 링 보정, 인코딩 두 가지, 짝 파일 누락 거절, Bessel 거절.
  - 좌표 변환은 공개된 기준점 쌍(측지 문헌 값)으로 대조한다.
- **완료:** 시험 통과.

## T-207 사이트 모델링 jig

- **기준:** SPEC-12.2~12.6·12.15·12.16, SPEC-07.4~07.7·07.10·07.18, ADR-026(질문 카드).
- **선행:** T-205(또는 T-206만으로 SHP 경로), T-208(만들기 틀).
- **변경:**
  - 공식 작업 jig 패키지 `src/jigs/official/jigs/site-model/`: `jig.json`(id `vide/site-model`, 단계: 필지 후보 · 대상 필지 확정(사람) · 수집 · 좌표 통일 · 도로와 접도 · 건물 매스 · 지형 · 대지 요약 · 만들기), `steps/*.ts`, `panel.json`, `reports/site-summary.json`, `skill.md`(예문 "○○동 123-4 대지 모델링해 줘"), `fixtures/`(합성 대지 셋).
  - 공식 작업 jig를 빌드에 포함해 적재하는 경로가 `src/jigs/runtime/loader.ts`에 없으면 이 티켓에서 더한다(공식 라이브러리와 같은 방식, ARCH-03 §1·§2.3 갱신).
  - 필지 후보가 여럿이면 jig 단계의 VIDE 질문 카드(SPEC-02.19의 6)로 묻는다. 카드의 위치 그림은 후보 경계를 그린 작은 SVG다.
  - 지형: 등고선·표고점으로 삼각망 메쉬. 기본 끔.
  - 화면은 공식 부품만 쓴다. 필요한 부품이 없으면(후보 위치 그림 등) Design §12의 부품 목록에 먼저 더한다.
  - `src/jigs/catalog.ts`의 J-01 항목을 이 jig로 바꾼다. 2026-10-08 진행 지시("쭉 진행")로 T-207 완료와 함께 `available`로 둔다(T-214 검수는 세 jig 묶음으로 그대로 한다).
- **검증:**
  - `tests/core/site-model-jig.test.mjs`: fixture 셋(단일 필지, 합필 두 필지, 떨어진 필지, 후보 여럿)에서 단계 결과·대지 요약·출처 구분·'대상 필지 미확정' 상태와 만들기 막힘.
  - jig 자체 시험(`npm run jig:test`).
  - 브라우저 `tests/integration/browser-site-model.mjs`(합성 공공 자료: 고지 → 질문 카드 → 미확정 → 가져오기 → 확정 → 끄기).
  - 실제 Rhino `tests/integration/rhino-site-model.mjs`(합성 공공 자료 + 합성 SHP 지형, 확정 전 만들기 거절, 레이어·속성·부피, 측량 좌표 그대로의 위치 1 mm 이내, 되돌리기). 키 실호출(선택) `tests/integration/site-model-live.mjs`(서울시청, 키 이름·개수만 출력).
  - 실패: 키 없음 → 그 자료만 '키 없음', 대상 필지 경계 없음 → 뒤 단계 막힘, 다시 가져오기의 바뀐 항목 목록과 이전 사본 보존.
- **완료:** 시험 통과, 말로 열기(skill 시작)에서 첫 사람 단계 앞까지 계산.

## T-208 Rhino 만들기 틀과 메타데이터

- **기준:** SPEC-12.6·12.9의 6·12.10의 8, SPEC-07.12, ARCH-03 §9. T-204 결과.
- **선행:** T-204.
- **변경:**
  - 공식 틀 추가(`src/jigs/bake/templates/`, `templates.ts`): 닫힌 다각형 돌출(`vide.bake.extrude-polygon@1`, 바닥 높이·높이 → 닫힌 폴리서피스), 평면 면 목록 → 닫힌 폴리서피스(`vide.bake.brep-faces@1`, 외피용), 메쉬(`vide.bake.mesh@1`, 지형). T-204가 Rhino 쪽 불리언을 택하면 그 틀도 여기서 더한다.
  - 데이터 블록에 객체 속성 이름 목록을 넓힌다(SPEC-12.6의 표). 속성 값은 길이 상한과 제어 문자 금지 점검을 따로 둔다(주소·한글 공백 허용). ARCH-03 §9.1·§9.2 갱신.
  - 만들지 못한 항목을 영수증의 `failed[]`로 돌려받아 결과 카드에 보인다(기존 계약).
  - 큰 만들기(건물 수백 동, 지형 메쉬)는 기존 묶음 나누기(`renderChunks`)를 쓰고 실제 묶음 크기를 측정한다.
- **검증:**
  - `tests/core/bake.test.mjs` 확장: 새 틀의 치환 일치, 속성 값 점검, 묶음 나누기.
  - 실제 Rhino: `tests/integration/rhino-site-bake.mjs`(합성 대지, 건물 300동 + 지형 메쉬): 닫힌 솔리드·부피 양수, 속성이 Sync(`DisplayScene`의 사용자 문자열)로 읽힘, 되돌리기 한 번에 모두 사라짐, 다시 만들기에서 사람이 고친 건물 보존.
- **완료:** 시험 통과, 띄운 Rhino 종료 확인.

## T-209 규제 조건 입력과 2D 건축 가능 영역

- **기준:** SPEC-12.7·12.8, SPEC-07.5·07.6, SPEC-08.6.
- **선행:** T-204. 규제 조건을 SPEC-13 결과에서 받는 연결은 SPEC-13의 형식이 정해진 뒤(PLAN-46). 그 전에는 사람 입력만으로 완료할 수 있다.
- **변경:**
  - 공식 라이브러리 `vide/massing-kit`: `src/jigs/official/massing-kit/`(`rules.ts` 닫힌 규칙 목록과 각 규칙의 매개변수·근거 항목, `setback.ts`, `boundary-segments.ts` 인접 필지로 경계 나누기).
  - 규제 조건 항목 스키마(SPEC-12.7의 2 표): 값·단위·적용 여부·근거·출처·확정 상태. SPEC-13 결과를 이 스키마로 옮기는 어댑터 자리를 둔다.
  - 공식 작업 jig `src/jigs/official/jigs/buildable-mass/`의 앞 단계: 대지 입력(사이트 모델링 출력 또는 입력 조립 역할) · 규제 조건 · 계획 조건 · 제한선 · 가능 영역.
  - 주용도가 없으면 질문 카드. '사람 입력 필요' 칸(기계로 읽을 수 없는 고시).
- **검증:** `tests/core/massing-setback.test.mjs`
  - 합성 대지 다섯 개(T-204와 같음)에서 제한선별 면적 감소 · 가능 영역 면적의 손계산 대조(허용 오차 0.01 ㎡).
  - '판단 필요' 항목이 미적용으로 계산되지 않고 '미반영 조건'에 오름, 목록 밖 제한은 그린 선으로만 반영, 자기 교차 대지 거절, 빈 영역 메시지.
- **완료:** 시험 통과.

## T-210 3D 가능 외피

- **기준:** SPEC-12.9.
- **선행:** T-208, T-209.
- **변경:** `vide/massing-kit`의 `envelope.ts`(돌출 · 일조 사선 · 높이 제한 · 최대 외피)와 `solid-check.ts`(닫힘·면 방향·부피), buildable-mass jig의 외피 단계와 만들기 선언.
- **검증:** `tests/core/massing-envelope.test.mjs`
  - 합성 대지에서 외피 부피의 손계산 대조(직사각형 대지의 일조 사선은 해석식으로 계산).
  - 정북 기준(진북·도북) 전환 시 다시 계산, 뒤집힌 솔리드 거름, '판단 필요' 일조 항목은 적용·미적용 두 외피를 모두 냄.
  - 실제 Rhino: `tests/integration/rhino-massing-envelope.mjs`(숨은 Rhino 8 워커에서 T-208 틀로 엔진 외피를 만들고 닫힌 폴리서피스, `IsSolid`, `Outward`, 부피 대조 0.1%, 뒤집힌 사본은 `failed[]`).
- **완료:** 시험 통과.

## T-211 층·대안·인센티브·공개공지

- **기준:** SPEC-12.10.
- **선행:** T-210.
- **변경:** `vide/massing-kit`의 `floors.ts`(층 나누기), `alternatives.ts`(최대 · 기준 용적률 · 인센티브 반영, 덜어 내는 방식 두 가지, 대안 8개 상한), `open-space.ts`. buildable-mass jig의 대안 표·고른 대안(사람 단계)·층별 매스 만들기. 대안 비교는 기존 부품 `compare-bars`·`table`을 쓴다.
- **검증:** `tests/core/massing-alternatives.test.mjs`
  - 대안별 건축면적·연면적·용적률·층수가 손계산과 같음, 상한 초과는 '초과' 판정이고 흐름을 막지 않음, '조건 미확정' 인센티브 표시, 제외 면적 반영, 고른 대안이 바뀌면 다시 확인 필요.
- **완료:** 시험 통과.

## T-212 용도 배분·주차·공지

- **기준:** SPEC-12.11·12.12.
- **선행:** T-211.
- **변경:** `vide/massing-kit`의 `use-mix.ts`, `parking.ts`(법정 대수·끝수 처리·방식별 필요 면적·지하 층수 추정), `landscape.ts`. buildable-mass jig의 용도 표(설정값)·AI 초안 단계(꺼진 상태로 시작, SPEC-07.7)·주차 진입 가능 구역 2D·공지 영역.
- **검증:** `tests/core/massing-use-parking.test.mjs`
  - 합성 용도 배분에서 용도별 면적·법정 대수·조경 면적 손계산 대조, 허용 용도 밖 '초과', 기준 '판단 필요' 용도는 대수 비움.
  - AI 초안은 사람이 받기 전 표에 들어가지 않음(가짜 AI 응답으로 시험).
- **완료:** 시험 통과.

## T-213 건축개요 jig

- **기준:** SPEC-12.13·12.14, SPEC-07.11.
- **선행:** T-211(T-212가 있으면 주차·조경 칸을 채움).
- **변경:** 공식 작업 jig `src/jigs/official/jigs/building-summary/`(입력: buildable-mass의 고른 대안과 대지 요약, 사람 입력 칸), 보고서 틀 `reports/summary.json`, CSV 두 개(개요·층별 면적표). 일관성 점검(`numbers-in-source`, 층별 합계 = 연면적). `src/jigs/catalog.ts`에 건축개요 항목 추가(코드는 그때 catalog의 다음 빈 번호).
- **검증:** `tests/core/building-summary.test.mjs`
  - 합성 고른 대안에서 개요 항목·출처 표시·미확정 조건 목록, 숫자 하나를 어긋나게 만들면 내보내기 거절, CSV 형식(SPEC-07.11).
  - 내보낸 HTML이 외부 요청·스크립트 없이 열림.
- **완료:** 시험 통과.

## T-214 통합 검수

- **기준:** SPEC-12.1 완료 기준, SPEC-07.18, AC-43·44·48(해당 범위), FR-18 전송 고지.
- **선행:** T-207~T-213.
- **방법:**
  1. 합성 대지(SHP 경로)로 세 jig를 처음부터 끝까지: 말로 열기 → 후보 질문 카드 → 대상 필지 확정 → 미리보기 → Rhino에 만들기(사본 문서) → 규제 조건 사람 입력 → 영역·외피 → 대안 셋 → 고른 대안 → 건축개요 HTML·CSV.
  2. 키가 있는 PC에서 비프로젝트 공개 필지 하나로 공공 자료 경로를 한 번(결과는 저장소에 넣지 않음).
  3. 실패 경로: 키 없음, 모호한 필지, 좌표계 판별 실패, 폐합 실패, 앞 작업본 변경 → 뒤 jig '다시 계산 필요'.
  4. 브라우저 시험 `tests/integration/browser-site-massing.mjs`(합성 자료, 패널·대안 표·개요 내보내기).
- **기록:** `docs/tdd/VERIFY-<날짜>-site-massing-jigs.md`(AC·SPEC 항목별 통과·실패·미시험).
- **완료:** VERIFY에 실패가 없고 미시험 항목은 이유가 있다. 그 뒤 `catalog.ts`의 세 항목을 `available`로 바꾸고 마스터 PLAN §6.5를 갱신한다.

## 실행 순서

```text
T-203 SPIKE 자료 ─┐
                 ├─ T-205 수집·키 ─┐
T-206 SHP·좌표 ──┘                 ├─ T-207 사이트 모델링 jig ─┐
T-204 SPIKE 기하 ─ T-208 만들기 틀 ┘                            │
        └─ T-209 규제 조건·2D ─ T-210 외피 ─ T-211 대안 ─ T-212 용도·주차
                                                  └─ T-213 건축개요 ─┴─ T-214 검수
```

- T-203·T-204·T-206은 서로 독립이라 병렬로 한다. T-206은 키가 없어도 된다.
- T-209는 사이트 모델링 없이 입력 조립(Rhino 대지 경계 레이어)으로 먼저 시험할 수 있어 T-207과 병렬이다.
- SPEC-13 규제 조건 형식과의 연결은 PLAN-46 T-220이 붙였다(2026-10-08): 법규 jig 출력 `legal.constraints`(`vide.legal.constraints@1`, ARCH-01 「법규와 모델」)를 `vide/buildable-mass`의 `jig-output` 입력 `legal`로 받고, `massing-kit/legal-adapter.ts`가 닫힌 키 표로 규제 조건 항목에 옮긴다(ARCH-03 §8.2). 법규 결과가 없으면 사람 입력만으로 T-209~T-214를 완료할 수 있는 것은 그대로다.
- 실제 Rhino가 필요한 시험(T-208·T-210·T-214)은 메인 체크아웃에서 순서대로 한다.

## 현재 상태

| 티켓 | 상태 | 증거 |
|---|---|---|
| T-203 | 완료(2026-10-08) — 키 실호출 43단계 응답(공개 지점 2곳). 어댑터 6개 동작 확인, 건물 높이용 `LT_C_BLDGINFO` 추가 | [SPIKE-2026-10-07-public-site-data](../tdd/SPIKE-2026-10-07-public-site-data.md), `tools/spikes/2026-10-07-public-site-data/` |
| T-204 | 완료(SPIKE) — 엔진(TS) 계산 + Rhino는 평면 면 목록 만들기만(`vide.bake.brep-faces@1`), Rhino 불리언 틀 불필요. Rhino 결합은 1e-5 m, `MergeCoplanarFaces` 쓰지 않음. 점검은 닫힘 + `SolidOrientation` Outward·부피 양수·엔진 부피 대조 | [SPIKE-2026-10-07-envelope](../tdd/SPIKE-2026-10-07-envelope.md), `tools/spikes/2026-10-07-envelope/` |
| T-205 | 완료(2026-10-08) — 어댑터 8개(`juso`, `vworld-search`, `vworld-cadastral`(PNU·상자 1000건 쪽 넘김·2 km² 타일), `vworld-land-use`(속성 + `LT_C_UQ*`·`UD801` 고시 번호 + `UPISUQ161` 지구단위계획, 필지 안쪽 점), `vworld-land-characteristics`(올해 → 지난해), `vworld-buildings`(`LT_C_SPBD`), `vworld-building-info`(`LT_C_BLDGINFO`, 높이 1순위), `building-register`(늘 `pageNo`)), 200 안의 오류·NOT_FOUND 판정, 허용 끝점만 호출, 출처 붙은 사본·빈 결과·면적 차이 '확인 필요', PC 전용 키·설정 「외부 자료」(있음/없음만)·진단 묶음 제외, 전송 고지 API(카드 화면은 T-207), `LIBRARY_MODULES` 등록(SHP·PNU만). 서울시청 실호출: 후보 6·제안 1, 7개 사본 모두 `ok`(필지 91·건물 27·건물 정보 34·대장 11·용도 17항목 중 고시 번호 3·지구단위계획 1), 키 이름·있음만 출력 | `src/jigs/official/site-data/`, `src/server/public-data-keys.ts`·`site-data-routes.ts`, `tests/core/site-data.test.mjs`(11건), `tests/server/public-data-keys.test.mjs`(3건), `tests/integration/site-data-live.mjs`, `tests/integration/browser-public-data.mjs`, SPEC-12.5, ARCH-01 「공공 자료 수집」, ARCH-03 §8.1 |
| T-206 | 완료(2026-10-08) — SHP·DBF·PRJ·CPG·ZIP 읽기(새 의존성 없음), `.prj` 매개변수 판별(5179·5180~5188·32651·32652·4326·4737, 매개변수가 다 있는 GRS80 TM), Bessel·다른 타원체·TM 아닌 투영·m 아닌 단위 거절, Krüger 6차 TM과 격자 수렴각, 한 좌표계·한 정수 m 기준점의 로컬 f64 좌표 + `packOffsets` f32 전달, 포함 깊이로 고리 정리(바깥 반시계·구멍 시계), `.cpg`/DBF 0x79 인코딩(선언 없으면 엄격 UTF-8), 국토지리정보원 코드 사전(건물·도로경계·등고선·표고점, 연속지적도 필지). 공개 기준점(OS GB Annex C ±1 mm, EPSG GN7-2 ±1 cm) 대조, 5179→5186 합성 대지 어긋남 < 1 cm. 라이브러리 등록은 T-205·T-207 | `src/jigs/official/site-data/shp/`, `site-data/assets/`(사전·NOTICE), `tests/core/site-shp.test.mjs`(12건), SPEC-12.4·12.5, ARCH-03 §8.1 |
| T-209 | 완료(2026-10-08) — 공식 라이브러리 `vide/massing-kit`(`LIBRARY_MODULES` 등록): 규제 조건 항목의 닫힌 목록과 형식(값·단위·적용 여부·확정 상태·출처 구분·근거·출처·대상 구간), 설정값 → 항목(빈 값·0은 '사람 입력 필요', 코드에 법정 값 없음), 사람 값 우선 병합과 차이 목록, SPEC-13 어댑터(`regulationsFromLegal`, PLAN-46 T-220이 `legal.constraints`를 연결: 입력 `legal`, 닫힌 키 표, 출처 '서비스 확정'·'서비스 해석'과 근거 조항, 고정 자료 `legal-feed`). 경계 구간(도로·인접 대지·확인 필요), 선분 캡슐 후퇴(외접 64각형, 같은 규칙이 덮는 볼록 모퉁이 끝은 평평), 가각, 건축한계선(도로 쪽 제거)·기타 이격(그린 선), 일조 지면 벽(기준선 = 정북 쪽 인접 대지 구간, 정북 도로는 '기준선 위치' 항목대로 도로 너비만큼 이동), '판단 필요'는 미반영 목록 또는 일조 두 변형, 건폐율 비교, 빈 영역 메시지, 자기 교차·열린 경계의 위치. 공식 작업 jig 패키지 `vide/buildable-mass`(대지 입력·규제 조건·계획 조건·제한선·가능 영역, 주용도 질문은 `basis-required`) — 등록부 적재는 T-207. 합성 대지 다섯 곳 면적·규칙별 감소가 손계산과 1e-6 ㎡ 안(L형 참 원 대비 −0.0025 ㎡, 꺾인 북측은 격자 참값과 0.011 ㎡) | `src/jigs/official/massing-kit/`, `src/jigs/official/jigs/buildable-mass/`, `tests/core/massing-setback.test.mjs`(11건), `tests/fixtures/massing-sites.mjs`, SPEC-12.7·12.8, ARCH-03 §8.2 |
| T-210 | 완료(2026-10-08) — `geometry-kit/solid.ts`(스파이크 `csg.ts`·`mesh.ts`를 옮김: BSP 불리언·용접·점검·단면 + 같은 평면 면 병합(구멍 포함, 꼭짓점 보존)·짧은 변 경고, 판 0.2.1), `massing-kit` `envelope.ts`(돌출·일조 사선·최대, 높이 상한 = 적용된 높이 중 최저 → 층수 × 층고 → 검토 높이(미반영 표시)), `solid-check.ts`(점검 실패면 단계를 멈추고 뒤집지 않음, 병합 면 부피 대조), 일조 거리 정의 항목(최단 거리 · 정북 방향, 기본 '사람 입력 필요' → 최단 거리로 계산하고 미확정 1), 정북 기준 전환, '판단 필요' 일조·높이의 두 변형, 만들기 선언(`vide.bake.curves@1` 제한선, `vide.bake.brep-faces@1` 외피). 외피 부피: 직사각형 세 곳·정북 경사 대지 해석값과 1e-6 m³, L형 −1.3e-4·꺾인 북측 −7.7e-5(격자 참값 대비). 숨은 Rhino 8 워커(이 시험이 띄우고 그 PID만 종료): 7개 대지 21개 외피 모두 한 조각·`IsSolid`·`IsValid`·`Outward`, Brep 면 수 = 병합 면 수, 부피 상대 차 최대 1.1e-8, 뒤집은 사본 7개는 모두 `failed[]` | `src/jigs/official/geometry-kit/solid.ts`, `src/jigs/official/massing-kit/`, `tests/core/massing-envelope.test.mjs`(8건), `tests/integration/rhino-massing-envelope.mjs`, SPEC-12.9, ARCH-03 §8.2 |
| T-207 | 완료(2026-10-08) — 공식 작업 jig `vide/site-model`(`src/jigs/official/jigs/site-model/`) 단계 9개(필지 후보 · 대상 필지 확정(사람) · 수집 · 좌표 통일 · 도로와 접도 · 지형 · 건물 매스 · 대지 요약 · Rhino에 만들기), 공식 작업 jig 적재(`officialJigRoot`, `builtin`·`official`, T-209의 `vide/buildable-mass`도 JIG 목록·skill 목록에 오름), 입력 종류 `site-data`와 작업본 사본·경로 5개(찾기·대상 필지·가져오기·새 사본 받기·SHP), 사람 단계 `confirm-target`과 만들기 점검 `target-confirmed`, 화면 부품 `site-picker`(전송 고지 카드·끄기, 후보 질문 카드와 위치 그림, 합필, 다시 가져오기의 바뀐 항목), 말로 열기의 주소 읽기, 만들기 8종(대상·대지 경계·주변 필지·도로·건물·지형·등고선·대지 정보), J-01 → `available`. 자체 시험 5건(단일·합필·떨어진 필지·후보 여럿·SHP와 지형), 서울시청 키 실호출: 9단계 모두 계산(필지 191·건물 매스 53, 추정 29·만들지 않음 10, 공부 12709.4 / 계산 12738.9 m² 0.23%). 실제 Rhino 8.35: 12개 만들기 실패 0, 건물 부피 오차 1.9e-8, 측량 좌표 그대로 위치 오차 0 m, 확정 전 `GATE_BLOCKED`, 되돌리기 | `src/jigs/official/jigs/site-model/`, `src/server/site-model-routes.ts`, `src/ui/jig-panel/site-parts.tsx`, `tests/core/site-model-jig.test.mjs`(7건), `tests/integration/browser-site-model.mjs`, `tests/integration/rhino-site-model.mjs`, `tests/integration/site-model-live.mjs`, SPEC-12.3·12.5·12.6, ARCH-03 §2.3·§3·§5.1·§7·§8.3·§11, Design §14 |
| T-211 | 완료(2026-10-08) — `massing-kit` 0.2.0 `floors.ts`(층 윤곽 = 최대 외피의 층 윗면 단면, 지하 = 대지 − 지하 이격 캡슐, 위층 축소는 정북 쪽에서 면적으로 이분 탐색한 선으로 불리언 자름), `alternatives.ts`(최대 · 기준 용적률 · 인센티브(상한 용적률까지, 판단 필요 = '조건 미확정', 높이 완화는 안내만) · 공개공지 반영 · 사람 수정 `human-k`(윤곽·구멍·층 빼기, '외피 밖' 표시), 8개 상한과 만들지 못한 대안의 이유, 덜어 내기 두 방식, 제외 면적(근거), 건폐율·용적률 '초과' 판정과 여유), `open-space.ts`(필요 면적 = 비율 × 대지면적, 그린 영역·모서리 평행사변형 후보 표, 관련 완화량은 값 그대로). buildable-mass 0.2.0: 단계 층 나누기·공개공지·대안·사람 단계 [고른 대안 확정]·고른 대안, 대안 비교 막대·대안 표·공개공지 탭, 만들기 `alternativeMasses`(`vide.bake.extrude-polygon@1`). 규제 조건 표 입력(수정 사항 `regulation`, AI 표시 거절). 직사각형 대지 손계산: 8개 층 면적, 기준 4.0 → 2400(6층, 6F 112.4), 인센티브 4.5 → 2700, 층수 줄이기 2287.6, 제외 50 → 산정 2400·연면적 2450, 공개공지 60 ㎡ → 2520. Rhino에서 고친 매스 받기(SPEC-07.13)는 아직 없음(수정 사항으로만) | `src/jigs/official/massing-kit/`(`floors.ts`·`alternatives.ts`·`open-space.ts`·`mass-steps.ts`), `src/jigs/official/jigs/buildable-mass/`, `tests/core/massing-alternatives.test.mjs`(7건), `npm run jig:test`(rect: 층·대안·고른 대안 손계산), SPEC-12.10, ARCH-03 §8.4 |
| T-212 | 완료(2026-10-08) — `use-mix.ts`(층·대안별 용도 표, 비율 나눔, 허용 용도·층별 용도 제한 대조: 없음 '초과', 판단 필요·미입력 '미검토'), AI 초안 단계 `useDraft`(꺼진 상태로 시작, 런타임은 `AI_UNAVAILABLE`) → 사람 단계 [AI 초안 받기] → `useDraftApplied`가 사람의 수정 사항으로 기록(AI 표시 수정 사항은 표가 거절), `parking.ts`(법정 대수: '면적 n ㎡당 1대' 기준·산정 면적·끝수 처리와 단위가 모두 규제 조건 항목, 비면 '사람 입력 필요', 판단 필요 용도 '미검토'; 진입 가능 구간: 도로 구간 − 그린 제외 선 − 모퉁이 제외 거리; 방식 대안 지상·지하·기계식, 지하 층수 추정과 추정 지하층 매스), `landscape.ts`(법정 = 비율 × 대지면적, 계획 = 그린 영역). 만들기 `groundZones`·`parkingMasses`, 호스트 단계 `makeMass`. 손계산: 최대안 근생 522.5/200 + 업무 2725.55/150 = 20.78 → 0.5 이상 올림 21·버림 20·용도마다 21, 산정 면적 'far' 20, 조경 90/120, 진입 구간 L형 60 → 50 → 46 m, 지상 여유 43 ㎡, 지하 630/600 → 2개 층. 숨은 Rhino 8 워커(이 시험이 띄우고 그 PID만 종료, 메인 체크아웃 빌드 플러그인): 직사각형·L형 대안 9개의 층 매스 64개 + 추정 지하층 5개가 모두 `IsSolid`·`IsValid`·`Outward`, 부피 상대 차 최대 3.4e-7, 바닥·윗면 높이 1e-5 m 안, 곡선 7개 | `src/jigs/official/massing-kit/`(`use-mix.ts`·`parking.ts`·`landscape.ts`), `tests/core/massing-use-parking.test.mjs`(7건), `tests/integration/rhino-massing-alternatives.mjs`, SPEC-12.11·12.12, ARCH-03 §8.4 |
| T-213·T-214 | 계획(2026-10-08 사용자 1단계 착수 승인) | — |

## 결정이 필요한 질문

1. **수집을 어디서 하나(ADR-040, OQ-16).** 권장: 1차는 VIDE 엔진의 공식 라이브러리 `vide/site-data`가 직접 가져오고, 결과 형식을 ARCH-01 외부 서비스 읽기 응답과 같게 해 두었다가 Site Modeling 서비스가 생기면 수집기만 바꾼다.
2. **SHP 자동 취득 범위(RESEARCH-04 §6의 8).** 권장: 필지·용도지역·건물은 API로 자동, 등고선·표고점(지형)은 사람이 내려받은 수치지형도 SHP를 넣는 방식. T-203에서 SHP API가 확인되면 그때 자동으로 넓힌다.
3. **건물 높이(§6의 9).** 권장: 건축물대장 표제부 높이가 있으면 그 값, 없으면 층수 × 추정 층고(기본 3.3 m)이고 '추정'으로 표시.
4. **지형 포함(§6의 9).** 권장: 기본 끔(평지), 사용자가 켜면 SHP 등고선으로 메쉬.
5. **원점(SPEC-12.6).** 권장: 대지 근처 정수 m 기준점을 문서 원점에 두고 측량 좌표·좌표계는 대지 정보 객체에 기록.
6. **정북 기준.** 권장: 진북 기본, 도북 전환은 설정값. 어느 쪽이 법상 정북인지는 SPEC-13 결과나 사람이 확정한다.
7. **지원 지역(§6의 17).** 권장: 공공 자료는 전국, 조례·지구단위계획 값은 SPEC-13 결과 또는 사람 입력. 서울 한정을 두지 않는다.
8. **계산 위치(§6의 19).** 권장: 엔진(TS) 계산 + Rhino는 만들기만. T-204 결과가 Rhino 불리언을 요구하면 그때 바꾼다.
9. **과거 규칙의 승계(§6의 20).** 권장: "산식 발명 금지"와 "계획의존 항목 결론 금지"를 제품 규칙으로 그대로 둔다(SPEC-12.7의 5·6에 반영). 결정도 색상 판독 등 사람 슬롯은 자동화하지 않는다.
10. **건축개요 파일 형식(OQ-08).** 권장: 1차는 HTML·CSV. XLSX·HWPX는 사무소 서식이 정해지면 따로 정한다.
