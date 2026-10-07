---
id: SPIKE-2026-10-07-public-site-data
title: 공공 자료 접근 — 주소·필지·용도지역·건물·SHP (T-203)
status: draft
version: 0.1
updated: 2026-10-07
owner: agent:claude
related: [PLAN-45, T-203, T-205, T-206, SPEC-12, ADR-040, OQ-09, RESEARCH-04, FR-09, FR-18, FR-24]
---

# 공공 자료 접근 — 주소·필지·용도지역·건물·SHP

[PLAN-45](../plans/PLAN-45-site-massing-jigs.md) T-203의 실험 기록이다. 기준은 [SPEC-12](../specs/SPEC-12-site-and-massing.md) §2(SPEC-12.3)·§3(SPEC-12.4), [ADR-040](../decisions/ADR-040-domain-services.md), OQ-09, [RESEARCH-04](../research/RESEARCH-04-jig-past-experience.md) §4 공공 데이터 수집 행이다. 실험은 제품 지원으로 세지 않는다(AI.md §2).

## 진행 상태

| 부분 | 상태 |
|---|---|
| 과거 출처(S-02·S-04·S-19)의 호출·함정 조사, 재사용 지도 | 완료 |
| 공식 문서의 파라미터·한도·이용 조건 | 일부 확인(아래 출처 표). VWorld 일일 한도 수치와 주소 API 키 기간은 공식 문서에서 확인하지 못함 |
| 키 없는 호출(오류 형식, 키 없는 엔드포인트) | 실행함(2026-10-07) |
| 키를 쓰는 실호출(질문 1~4) | **실행 못 함.** 코드는 준비됐고 키가 들어오면 그대로 돈다 |

2026-10-07 사용자는 "논현동 규모검토 때 쓴 키를 쓰면 된다"고 했다. 그 작업공간(S-04)의 키 파일에는 `VWORLD_KEY`·`VWORLD_DOMAIN`·`JUSO_KEY`·`DATA_GO_KR_KEY`(그리고 법령용 `LAW_OC`)가 모두 **있다**(이름과 유무만 확인했고 값은 보지 않았다). 그러나 에이전트가 그 값을 VIDE의 PC 전용 키 파일로 옮기는 동작은 이 세션의 권한 검사에서 막혔다. 그래서 키 실호출은 사용자가 키를 넣은 뒤 다시 돌린다(「다음 행동」).

## 방법

- 코드: `tools/spikes/2026-10-07-public-site-data/` (`probe.mjs`, `keys.mjs`, 다시 돌리는 법은 같은 폴더 README).
- 시험 필지: 비프로젝트 공개 필지 두 곳. ① 서울특별시청(일반 지번 + 도로명), ② 남산서울타워(산 지번 + 도로명). 사용자 프로젝트 주소는 쓰지 않았다.
- 응답은 저장하지 않는다. 출력은 상태·개수·필드 이름·좌표계뿐이고 키는 `key:****abcd`로 가린다.
- 키 읽기 순서: 같은 이름의 환경 변수 → `%LOCALAPPDATA%\VIDE\public-data.env`(PLAN-45 「공공 자료 키」).
- 과거 출처는 읽기만 했다. S-19의 `secrets\`와 모든 키 파일의 값은 열지 않았다.

## 키 없는 호출 결과 (2026-10-07 실행)

| 대상 | HTTP | 응답 형식 |
|---|---|---|
| VWorld 2D 데이터 API, 키 없음 | 200 | `response.status=ERROR`, `response.error={level, code:PARAM_REQUIRED, text}`. HTTP 상태로는 실패를 알 수 없다 |
| VWorld NED 속성 API, 키 없음 | 200 | 최상위 `landUses` 봉투로 온다. 본문 안에서 오류를 판별해야 한다 |
| data.go.kr 게이트웨이(건축HUB), 키 없음 | 401 | `OpenAPI_ServiceResponse.cmmMsgHeader` · `errMsg=SERVICE_KEY_IS_NULL` · `returnReasonCode=20` |
| 주소 검색 API, 키 없음 | 200 | `results.common.errorCode=E0001`("승인되지 않은 KEY") · `totalCount=0` |
| 서울도시공간포털 `pacbnd/getList2.json`(키 불필요, 공공 필지) | 200 | JSON 배열. 서울 전용이라 전국 어댑터로는 쓰지 않는다 |

결론: 세 자료원 모두 **HTTP 200 안에 오류를 담는다**(data.go.kr은 401도 씀). 어댑터는 HTTP 상태가 아니라 봉투의 상태 코드로 '키 없음'·'거절'·'한도 초과'·'빈 결과'를 가른다(SPEC-12.4 '에러 없는 빈 결과', SPEC-12.16 자료원 실패).

## 질문별 결과

근거 표시: **[문서]** 공식 문서, **[S-04]** 과거 작업공간의 2026-08 실호출 기록, **[S-19]** ARCO-full 코드, **[미실행]** 이 실험의 키 실호출에서 확인할 것.

### 1. 주소 → PNU

- **채택: 주소 검색 API(business.juso.go.kr `addrLinkApi.do`, `JUSO_KEY`).** 응답의 `admCd`(법정동 10자리) + `mtYn`(산 여부) + `lnbrMnnm`·`lnbrSlno`(본번·부번)로 PNU 19자리를 조립한다. `countPerPage` 최대 100, `totalCount`로 후보 수를 안다. [S-04][문서]
- **함정 — 낙착:** 건물이 없는 필지를 지번으로 찾으면 이웃 건물 지번으로 낙착해 돌려준다. 입력 지번과 응답 지번이 다르면 응답을 대상 필지로 쓰지 말고 후보 카드로 묻는다(SPEC-12.3의 2). 동코드만 받아 입력 지번으로 조립한 PNU는 연속지적 조회로 실재를 확인한다. [S-04]
- **VWorld 주소 좌표 변환(`req/address getcoord`)은 좌표만 주고 PNU를 주지 않는다.** PARCEL 실패 시 ROAD로 다시 묻는 방식(S-19)은 후보가 하나뿐이라 여러 후보 질문 카드에 맞지 않는다. [S-04][S-19]
- **대체:** VWorld 검색 API(`req/search type=address`)가 여러 후보와 필지 ID를 주는지 [미실행]. 좌표를 얻으면 연속지적 점 조회로 PNU를 얻는 경로는 확인됨. [S-19]
- PNU 구조: 법정동코드 10 + 필지 구분 1(1 일반, 2 산) + 본번 4 + 부번 4. 건축HUB의 `platGbCd`는 0 대지 / 1 산 / 2 블록이라 한 칸씩 어긋난다. [S-04][S-19]

### 2. 필지 경계·지목 — VWorld 연속지적 `LP_PA_CBND_BUBUN`

- **필터:** `attrFilter=pnu:=:<PNU>`(속성), `geomFilter=POINT(..)`·`BOX(..)`(공간). [문서][S-04]
- **개수·페이지:** `size` 기본 10 · 최대 1000, `page`. 응답에 `record.total/current`, `page.total/current/size`. 범위 조회는 `record.total`과 받은 개수를 비교해 모자라면 다음 페이지를 읽는다. [문서][S-04]
- **범위 상한:** `geomFilter`는 **2 km²** 제한. 주변 반경 600 m(SPEC-12.4 상한)에 큰 대지면 넘을 수 있으므로 어댑터는 범위를 타일로 나눠 읽고 PNU로 중복을 지운다. [문서]
- **좌표계:** `crs` 파라미터로 받는다(기본 EPSG:4326). S-04는 4326으로 받아 로컬에서 바꿨고 S-19는 4326 → 5186으로 바꿨다. VIDE는 요청에 `crs`를 명시하고 응답 좌표계를 요청값으로 기록한다. 5186 직접 요청이 되는지 [미실행].
- **속성:** `pnu, jibun("2-1대" — 끝 글자가 지목), bonbun, bubun, addr, gosi_year, gosi_month, jiga`. **면적 필드가 없다.** `jiga`는 한 해 늦다. [문서][S-04]
- 도메인: VWorld 키는 등록 도메인과 묶인다(`domain` 파라미터, 불일치 시 `INCORRECT_KEY`). 로컬 앱은 `http://localhost`로 등록한다. [문서][S-04]

### 3. 용도지역·지구

- **두 출처를 함께 쓴다.** [S-04]
  - VWorld NED `getLandUseAttr`(PNU 필터): 지역·지구·구역 전체 목록(`prposAreaDstrcCode/Nm`, 저촉 여부 `cnflcAt`(1 포함·2 저촉·3 접함), 등록일). 좌표 레이어 순회보다 완전하다(S-04 실측 12건 대 5건). **고시 번호가 없다.**
  - VWorld 2D 레이어(점 필터, PNU 필터 불가): `LT_C_UQ111~114`(용도지역), `UQ121·123·124·125·126·128·129·130`(지구), `UQ141`(지구단위계획구역 등), `UQ162`, `UD801`(개발제한구역), `LT_C_UPISUQ161`(지구단위계획구역 — 구역명·면적·`wtnnc_sn`). `uname`, `dyear`·`dnum`(고시 연도·번호)이 있다.
- **두 지역에 걸친 필지:** 점 필터는 중심점 한 곳만 본다. 걸침 면적·비율은 레이어 폴리곤(`geometry=true`)과 필지 경계의 교집합으로 계산한다(SPEC-12.5 대지 요약).
- **토지이음 화면에만 있는 것:** 지구단위계획 결정도·결정조서·시행지침의 값(건폐·용적·높이·권장용도·건축한계선), 가로구역별 최고높이 지침도의 수치. 그림·스캔이라 SPEC-12.16 '사람 입력 필요'다. 서울은 도시공간포털이 고시번호·고시문 PDF까지 키 없이 주지만 서울 전용이다. [S-04]
- **폐기된 경로:** `apis.data.go.kr/1611000/nsdi/*`(토지이용규제·지구단위계획) 계열은 `NO_OPENAPI_SERVICE_ERROR`. data.go.kr 키로 도시계획을 조회할 수 없고 창구는 VWorld다. S-19 분석 서버가 쓰던 `LP_PA_CBND_LUNUSE`도 무효 ID다. [S-04][S-19]

### 4. 건물

- **윤곽·지상 층수: VWorld 2D `LT_C_SPBD`(도로명주소 건물).** 속성 `bd_mgt_sn`(건물관리번호 = 생성 당시 PNU 19자리 + 연번), `buld_nm`, `buld_nm_dc`(동 이름), `gro_flo_co`(지상 층수), `sido`, `sigungu`, `rd_nm`, `buld_no`, `gu`. **높이·지하 층수 필드는 문서에 없다.** [문서]
- **높이: 건축HUB 건축물대장 표제부 `getBrTitleInfo`**(`DATA_GO_KR_KEY`). 열쇠는 PNU를 나눈 `sigunguCd, bjdongCd, platGbCd, bun, ji`. 필드 `heit`(높이, 0이면 미기록), `grndFlrCnt`, `ugrndFlrCnt`, `mainPurpsCdNm`, `platArea`, `archArea`, `totArea`, `bcRat`, `vlRat`, `useAprDay`, `bldNm`, `dongNm`, `mgmBldrgstPk`. 표제부에 소유자 정보는 없다. [S-04][S-19]
- **대조 열쇠:** 건물 윤곽의 `bd_mgt_sn` 앞 19자리(PNU)로 필지별 대장을 묶고, 한 필지에 여러 동이면 `buld_nm_dc`↔`dongNm`, 맞지 않으면 연면적 최대 동을 대표로 한다(S-04 방식). 생성 당시 PNU라 합필·분필 뒤에는 어긋날 수 있다 → 대장 없음은 '추정 높이'로 남긴다(SPEC-12.5).
- **페이지 누락 함정:** 건축HUB는 `pageNo`를 빼면 `numOfRows`를 무시하고 1건만 준다. 반드시 `pageNo`를 넣고 `totalCount`와 받은 개수를 비교한다. [S-04]
- **GIS건물통합정보:** 공간정보와 대장 속성을 건물 단위로 합친 자료다. 파일(SHP)은 **EPSG:5174(Bessel)**라 SPEC-12.4에 따라 그대로 쓰지 않는다. WFS 경로(`ned/wfs/getGisGeneralBuildingWFS`)와 필드는 [미실행]. 된다면 `LT_C_SPBD` + 대장 두 번 호출을 한 번으로 줄일 후보다. [문서]
- VWorld 3D 데이터 오픈API는 2019년에 닫혔다(건물 3D 모델 직접 취득 불가). [문서]

### 5. 수치지형도·연속지적도 SHP

| 자료 | SHP를 API로 받나 | 결론 |
|---|---|---|
| 연속수치지형도(등고선·표고점·건물·도로) | 아니오. 국토정보플랫폼에서 신청·승인 뒤 사람이 내려받는다. 재수집해도 같은 시점본 보장이 없다 [S-04][S-19] | 지형(등고선·표고점)은 **사람이 넣는 SHP**. 좌표계 EPSG:5179(UTM-K) [S-02] |
| 연속지적도 | 파일은 사람이 내려받는다(시군구 단위). 같은 내용은 2D 데이터 API로 범위 조회된다 | API 우선, SHP는 대체(키 없음·호출 끔). 좌표계 EPSG:5186 [S-02] |
| GIS건물통합정보 | 파일 다운로드(EPSG:5174 Bessel) | 파일은 쓰지 않음. API 후보만 확인 |
| 지구단위계획 구역 | data.go.kr 파일데이터(15047833, 구역 SHP + 규제 CSV) | 법규 쪽(PLAN-46) 몫. 이 계획에서는 레이어 `LT_C_UPISUQ161`만 |

SHP 파일을 내려주는 공개 API는 찾지 못했다. **PLAN-45 결정 질문 2의 권장안(필지·용도지역·건물은 API, 지형은 사람이 넣는 SHP)이 그대로 맞다.** SHP 넣기에는 `.cpg`를 읽고(국토부 SHP가 모두 cp949라는 가정은 틀림), `.prj`를 이름이 아니라 파라미터로 판별한다(S-02·S-04 공통 교훈).

### 6. 키·한도·이용 조건·금지 엔드포인트

| 키(환경 변수 이름) | 발급처 | 쓰는 API | 한도 | 이용 조건 |
|---|---|---|---|---|
| `VWORLD_KEY` + `VWORLD_DOMAIN` | 브이월드 오픈API(vworld.kr) → 인증키 발급. 개발키 → 운영키 전환은 심사 | 2D 데이터(`req/data`), 주소(`req/address`), 검색(`req/search`), NED 속성(`ned/data/*`) | 키마다 일일 한도, 초과 시 `OVER_REQUEST_LIMIT`. 수치는 발급 화면에서 확인 [문서] | 출처 표시·재배포 조건은 OQ-09에서 확인 |
| `JUSO_KEY` | 주소기반산업지원서비스(business.juso.go.kr) → API 신청 | `addrLinkApi.do` | 개발용 기간 제한(S-04 기록 90일) 뒤 운영 전환. 만료 시 `E0014` | OQ-09 |
| `DATA_GO_KR_KEY` | 공공데이터포털(data.go.kr) → 「국토교통부_건축HUB_건축물대장정보 서비스」(15134735) 활용신청, 자동승인 | `apis.data.go.kr/1613000/BldRgstHubService/*` | 개발계정 일 10,000건, 활용사례 등록 시 증가 [문서] | 「이용허락범위 제한 없음」 [문서] |

- **조합:** 세 키 모두 필요하다. VWorld 키만 있으면 필지·용도지역·건물 윤곽·면적은 되지만 주소 → PNU 후보와 건물 높이가 빠진다. 주소 키 없이도 PNU 직접 입력·VWorld 좌표 경로로 대상 필지는 찾을 수 있다.
- **캐시:** SPEC-12.4의 '조회 사본 고정'은 작업본 안 사본이다. 공공 응답을 저장소·계정 사이트에 재배포하는지는 OQ-09가 정한다. 이 실험은 그 판단을 하지 않는다.
- **금지(호출하지 않음):**
  - 서울도시공간포털 `api/map/kras/getKras.json`의 `KRAS000030`(토지이용계획확인원) — **소유자 성명·주민번호 앞자리·주소를 키 없이 돌려준다.** `KRAS000002`(토지대장)도 같은 서비스 군이라 호출하지 않는다. [S-04]
  - 토지 소유 정보 계열 API(VWorld NED 토지소유정보 등).
  - 폐기된 `apis.data.go.kr/1611000/nsdi/*`.

## SPEC-12.4 표와의 대조

다른 점이 없다(키 실호출 전 잠정). 구체화된 것은 기술 세부라 SPEC이 아니라 T-205 어댑터와 ARCH가 받는다.

- 주변 건물 '공공 건물 자료' = `LT_C_SPBD`, '건축물대장 표제부' = 건축HUB.
- 대지면적 '공공 토지·건축물 대장 자료' = VWorld NED 토지특성(`getLandCharacteristics`의 `lndpclAr`), 없으면 대장 `platArea`.
- '구 좌표계(Bessel)면 쓰지 않음' 때문에 GIS건물통합정보 파일은 제외된다.

## T-205 자료원 어댑터 목록

| 어댑터(`vide/site-data` `sources/*`) | 자료 | 키 | 비고 |
|---|---|---|---|
| `juso` | 주소 → PNU 후보 | `JUSO_KEY` | 후보 전부 반환, 낙착 감지 |
| `vworld-cadastral` | 대상·주변 필지 경계·지목·PNU | `VWORLD_KEY` | PNU 필터 / BOX 페이지 순회, 2 km² 타일 |
| `vworld-land-use` | 지역·지구·구역 목록·저촉 + 고시 번호 | `VWORLD_KEY` | `getLandUseAttr` + `LT_C_UQ*`·`UD801`·`UPISUQ161` 점 조회 병합 |
| `vworld-land-characteristics` | 공부 면적·지목 | `VWORLD_KEY` | 올해 없으면 지난해 |
| `vworld-buildings` | 주변 건물 윤곽·지상 층수 | `VWORLD_KEY` | `LT_C_SPBD` BOX |
| `building-register` | 건물 높이·층수·주용도 | `DATA_GO_KR_KEY` | 필지별, `pageNo` 필수 |

후보(키 실호출 뒤 결정): VWorld 검색 API(주소 후보 대체), GIS건물통합정보 WFS(건물 한 번에), `LT_L_MOCTLINK`(도로 중심선 — S-19가 접도 판정에 씀). 서울도시공간포털·공시지가·실거래는 이 계획의 범위 밖이다.

## 재사용 지도

| 구성요소 | 출처 | 방식 | 이유 |
|---|---|---|---|
| 주소 → PNU 조립과 낙착 감지 | S-04 `fetch_site.js` 1단계 | 손봐서(TS) | 실호출로 검증된 규칙. '첫 건 사용'을 후보 카드로 바꿈 |
| 연속지적 PNU 조회·BOX 페이지 순회·미수신 경고 | S-04 `fetch_site.js`·`fetch_parcels.js` | 손봐서 | 페이지 비교 로직 그대로, 2 km² 타일 추가, 프로젝트 저장 규약은 VIDE 작업본 사본으로 대체 |
| 용도지역 두 출처 병합 | S-04 `fetch_site.js` 2·3단계 | 손봐서 | 레이어 목록·필드 그대로. 중심점 한 점만 보는 부분을 걸침 면적 계산으로 보완 |
| 토지특성 면적·연도 대체 | S-04 `fetch_site.js` | 그대로 옮김(TS) | 짧고 검증됨 |
| 건축HUB 표제부·PNU 분해·`pageNo` 함정·미기록 0 처리 | S-04 `fetch_parcels.js`, S-19 `building_register_api.py`(`pnu_to_bld_params`, `_to_pos_float`, 인증 실패와 나대지 구분) | 손봐서 | 두 출처의 장점 결합. S-19의 '인증 실패 ≠ 대장 없음' 구분이 SPEC-12.16에 맞음 |
| VWorld 클라이언트(정지오코딩·점 지적·용도지역) | S-19 `vworld_client.py`·`vworld_api.py` | 참고만 | 단일 후보·첫 feature만 써서 SPEC-12.3과 맞지 않음. 오류 시 빈 값 반환도 '에러 없는 빈 결과' 위험 |
| 도로 중심선·폭 추정 | S-19 `roads.py` | 참고만 | 도로명으로 폭을 추정함 → SPEC-12.5는 폭을 기하로 계산 |
| 수치지형도 ZIP → 지형 삼각분할 | S-19 site 서버 `contour.py`, S-04 `terrain.js`(IDW 격자, 정밀도 한계 기록) | T-206에서 판단 | 이 실험 범위 밖 |
| SHP 읽기·좌표계 판별·`.cpg` | S-02 Site Maker, S-04 `geo.js`(`crsFromPrj`)·`geofiles.js` | T-206에서 판단 | 이 실험 범위 밖. 교훈만 위에 기록 |
| 키 읽기(환경 변수 우선, 파일 대체) | S-04 `src/env.js`, VIDE `readJevKey` | 다시 작성 | VIDE `public-data.env` 규약(PLAN-45)에 맞춤 |

## 다음 행동

1. 사용자가 S-04의 키 네 항목(`VWORLD_KEY`·`VWORLD_DOMAIN`·`JUSO_KEY`·`DATA_GO_KR_KEY`)를 `%LOCALAPPDATA%\VIDE\public-data.env`에 직접 넣거나, 에이전트가 옮기도록 권한을 준다.
2. `node tools/spikes/2026-10-07-public-site-data/probe.mjs keyed`를 돌려 [미실행] 항목(검색 API 후보, 5186 직접 요청, `LT_C_SPBD`·대장 필드와 개수, GIS건물통합정보 WFS, `size` 1001 거절, 산 지번의 `mtYn`)을 이 기록에 채운다.
3. 그 결과로 어댑터 후보를 확정하고 T-205를 시작한다. 키 없이 할 수 있는 T-206(SHP·좌표계)은 지금 시작할 수 있다.

## 출처

- VWorld 2D 데이터 API 연속지적도 레퍼런스: https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=cadastral
- VWorld 2D 데이터 API 도로명주소 건물(`LT_C_SPBD`): https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=spbd
- VWorld 2D 데이터 API 목록: https://www.vworld.kr/dev/v4dv_2ddataguide2_s001.do
- 공공데이터포털 건축HUB 건축물대장정보 서비스: https://www.data.go.kr/data/15134735/openapi.do
- 공공데이터포털 GIS건물통합정보(WMS/WFS): https://www.data.go.kr/data/15123970/openapi.do
- VWorld 3D 데이터 API 종료: https://www.vw-lab.com/53
- 과거 출처: RESEARCH-04 S-02·S-04·S-19(경로는 저장소 밖 대응표)
