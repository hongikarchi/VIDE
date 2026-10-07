---
id: SPIKE-2026-10-07-clawde-sources
title: cLAWde 새 저장소 착수 전 세 출처(S-01·S-04·S-19) 종합 조사
status: review
version: 0.3
updated: 2026-10-08
owner: agent:claude
related: [PLAN-46, T-215, T-216, SPEC-13, ARCH-01, ADR-040, RESEARCH-04, RESEARCH-16, C-06, C-04]
---

# cLAWde 세 출처 종합 조사

[PLAN-46](../plans/PLAN-46-legal-qa.md) T-215의 기록이다. 2026-10-07 사용자 결정("새 저장소로 시작하는데, 옛 비공개 CLAWDE랑 규모검토 때 했던 법규 검토, ARCO-FULL에서 만들었던것 까지 3개를 모두 종합")에 따라 세 출처를 읽기만 하고 새 cLAWde 저장소의 설계 메모와 재사용 지도를 낸다. 기능 동작은 [SPEC-13](../specs/SPEC-13-legal-qa.md), VIDE 쪽 물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md) 「cLAWde 연결 계약」이 소유한다. 출처 코드(S-NN)와 경로의 대응은 [RESEARCH-04](../research/RESEARCH-04-jig-past-experience.md) §1·§1.1과 저장소 밖 대응표에 있다.

이 문서는 VIDE 저장소의 기획 산출물이다. 새 cLAWde 저장소가 생기면 「새 cLAWde 저장소 설계 메모」 절을 그 저장소의 첫 설계 문서로 옮긴다. 새 저장소와 GitHub 자원은 이 티켓에서 만들지 않았다. 2026-10-08 사용자 결정(ADR-040 결정 1)으로 새 저장소는 비공개 `hongikarchi/cLAWde`(로컬 작업본 `C:\Users\user\Desktop\cLAWde-service`)가 되었고, 옛 `CLAWDE`(S-01)는 `hongikarchi/CLAWDE-legacy`로 이름을 바꿨다.

## 질문

1. 세 출처는 법규 검토의 같은 일을 각각 어떻게 했고, 어느 쪽이 나은가(PLAN-46 T-215의 견줄 항목 여섯).
2. 그 결과로 cLAWde가 ARCH-01 계약(`/v1/meta`·`ask`·`checklist`·`articles`·`search`·`contributions`)을 채울 수 있는가(계약 질문 다섯).
3. 새 cLAWde 저장소의 구성, 데이터 3계층, 수집 작업, 누락 방지 게이트, 답 생성과 인용 검증, 배포, 첫 단계는 무엇인가.

## 방법·환경

- 2026-10-07, 이 PC의 세 작업본을 읽기 전용으로 훑었다. README·설계 문서·스크립트·스키마를 읽었고, DB는 스키마와 행 수만 봤다(`node:sqlite`·Python `sqlite3`).
- 열지 않은 것: 비밀키 폴더, `.env`·키·토큰 파일, 대지 자료·SHP·발급 문서·프로젝트 원본. S-19의 MCP 설정 파일은 키 이름만 보고 값이 자리표시(`${...}`)인지 확인했다. S-19 `ontology.db`를 읽기 전용으로 연 탓에 WAL 보조 파일(`-shm`)의 시각이 바뀌었고 내용은 바뀌지 않았다.
- 이 저장소에는 출처의 코드·데이터·키·주소·지번·발주처를 옮기지 않았다. 프로젝트는 일반 표현으로만 적는다.

## 결과 — 출처별 목록

### S-01 옛 비공개 CLAWDE (2세대)

- Node(CommonJS, 내장 `node:sqlite`)와 Python 보조 약 12k줄, 89커밋(2026-08-18~09-08), 비공개 원격, 라이선스 파일 없음. 시험 틀은 없고 실패 시 exit 1인 CLI 게이트로 품질을 지킨다.
- 파이프라인: `scripts/scope.js`(SCOPE) → `fetch_law.js`(RAW) → `normalize.js`·`index_law.js`(NORM) → `data/rules.json` 34건(RULES) → `src/calc.js`·`src/zoning.js`(VERDICT). 뒤이어 주소 → 보고서 사슬(`project:init` → 용도지역 분할 → 밀도 → 외피 → 보고서 → `report:verify`).
- 법령 DB: 법령 41종 21,367 레코드(조 2,806·항 6,533·호 6,674·목 1,135·별표 217·부칙 4,002), 변경 사건 4,136건. 원본 `raw` 약 11 MB·정규 `norm` 약 19 MB를 커밋했고 검색 캐시(`cache.sqlite`, FTS5)는 Git 밖.
- 누락 방지 3중 게이트: `kbr_gate.js`(한국건축규정 별표1 필수 140조문), `deleg_scan.js`(재위임 스캐너, 경고만), `verify_report.js`(조항 실존·어조·근거 없는 산식·사무소 표준 35항목·A4 맞춤).
- 판정 레코드 원형: 지구단위계획 규칙 스키마 `data/dup/_schema.json`(`출처{문서,조문,페이지}`·`분류`·`성격: 규제|권장`·`적용조건{자연어,식}`·`요구사항{자연어,정량{대상,지표,연산,값,단위}}`·`예외`·`검증도서[]`). `rules.json`과의 통합("rules v2")은 설계만 하고 하지 않았다.

### S-04 규모검토 작업공간의 검토엔진 (3세대)

- S-01 코드를 이어받아 한 프로젝트용으로 키운 작업본이다(`00_도구/검토엔진/`, 이전 이력은 아카이브 Git으로 보존). 법규 코드는 외부 의존 없이 `node:sqlite`를 쓰고, 형상·발표 스크립트가 약 130개 섞여 있다.
- 법령 DB: 등록 104건, 검색 단위 45,614행(FTS5 + 한글 2-gram 열), 부칙 1,263건 전부 정규화, 위임 3단 비교(`thdCmp`) 그래프, 미수집 위임 대상 36건(`missing.json`).
- 산출 셋: A 검토서(원문), B 방법론, C 기계해석서와 `constraints.auto.json`. 항목 정의는 사람이 쓴 13개 절 110항목(`30_분석/법규검토/_정의/NN-*.json`, `_SCHEMA.md`).
- 게이트: `coverage.js`(`law:coverage`, 실패 10종과 할 일 1,110건), `deleg_scan.js`, `law_sweep.js`(핵심 법 13종을 제1조부터 훑어 인용 안 된 조문 수집), `verify_report.js`. 조사 시점에 `law:coverage`는 필수조문 미대응 21건으로 exit 1이다.
- 운영 지침: `.claude/skills/law-review/`의 SKILL·TRAPS·CHECKLIST(일부 수치가 실제와 다름).
- 법규 질의 기록은 손으로 쓴 정적 HTML이다(질의와 결론 → 원문 → 해석이 갈리는 지점 → 예외 → 계획 영향 → 확인 필요 → 출처).

### S-19 ARCO-full의 법규 MCP 서버와 매스 서버 법규 모듈

- `dev/mcp/arch-law-mcp`: TypeScript ESM, `@modelcontextprotocol/sdk`·`better-sqlite3`·`zod`·`express`, stdio/SSE/HTTP. 도구 17개(조회 10·검사 7)이며 모두 Markdown을 돌려준다. 개발 Git은 2커밋(2026-10-01 정리)뿐이라 이력이 없고, 시험 파일이 없으며, 라이선스 표기가 없다(소유·라이선스는 2026-10-07 사용자 확인).
- 온톨로지 DB(`src/data/ontology.db`, 약 231 MB, Git 밖):

| 표 | 행 | 비고 |
|---|---|---|
| `legal_documents` | 1,240 | 국가 법령·기준 128, 조례 1,112. `law_revision_date`는 모두 비어 있음 |
| `document_versions` | 1,240 | 문서당 현재 판 하나. 공포일 열 없음, `raw_xml` 비어 있음 |
| `structural_units` | 185,545 | 조·항·호만. 목·별표·부칙 없음 |
| `structural_units_fts` | 185,545 | FTS5 `unicode61`, 트리거 없음 |
| `document_relationships` | 48,561 | 위임 2,023(시행령·시행규칙·조례), 교차 참조(적용·타법·별표·준용·예외) 4,402, 유형 없는 `references` 42,094. 30,617행은 조문 단위로 풀리지 않음 |
| `regulatory_domains`·`regulatory_rules`·`rule_values`·`rule_conditions` | 10·1,619·1,619·42 | 정규식 추출 규칙. 조건은 용도지역 하나뿐 |
| `geographic_entities`·`land_use_zones`·`building_use_categories` | 171·21·29 | 시도·시군구, 용도지역, 별표1 용도 |

- 수집: `lawSearch`/`lawService`의 `law`·`ordin`·`eflaw`·`prec`·`expc`·`admrul`, 조문 코드 `JO=`. 별표·부칙은 수집하지 않는다. 갱신(`sync-from-api.ts --check|--sync`)은 시행일 메타만 고치고 본문을 다시 넣지 않으며, 주 1회 확인 작업이 오케스트레이터에 있다.
- 결정적 엔진(`src/lib/engine/`): `rule-evaluator.ts`(규칙 없으면 '모름', 통과로 치지 않음), `formula-engine.ts`(토큰화 + RPN, `eval` 없음, 변수 화이트리스트), `citation-resolver.ts`(삭제 조문 경고), `graph-traverser.ts`. 적용 판단 `condition-matcher.ts`와 설계 전 체크리스트 항목 약 283개(`compliance-items/`, 항목마다 `legal_basis`·`conditions`·`priority`), 값 상식 검사 `checklist-validation.ts`, DB 건강 검사 `db-healthcheck.ts`.
- 매스 서버 법규 모듈(`arch-mass-mcp/core/legal`)은 온톨로지 DB를 읽지 않고 고정 표를 쓴다. 건폐율·용적률 조문 인용이 뒤바뀐 결함과 2015년에 삭제된 도로사선을 아직 적용하는 문제가 있다.

## 결과 — 견줄 항목 여섯

판정: **가능** = 출처의 방식을 그대로 다시 써서 충족, **보완 필요** = 출처에 바탕이 있으나 더할 것이 있음, **불가** = 출처에 바탕이 없어 새로 설계.

| # | 항목 | S-01 | S-04 | S-19 | 고를 것 | 판정 |
|---|---|---|---|---|---|---|
| 1 | 파이프라인 단계 경계와 산출 형식 | 5단계, 단계마다 앞 단계만 읽음. RULES는 `rules.json` | 같은 5단계, RULES가 사람이 쓴 절 정의로 바뀜 | 수집 → 적재 → 규칙 추출 → 엔진. 원본 보관 없음 | S-01/S-04의 단계 경계와 RAW/NORM 형식. RULES는 새 '판정 레코드'로 통합 | 보완 필요 |
| 2 | 법제처 수집·온톨로지 | `eflaw` 미래판, `law:check`, 부칙·별표 정규화, 위임 3단 비교 | 위와 같고 시행일 역행 방지(`--allow-regress`), 부칙 전량, 고시 원본 가져오기 | 조례 1,112건 수집, 관계 표, 규칙·지역·용도 표, 주 1회 확인. 별표·부칙·판 이력 없음 | 수집기와 판 고정은 S-04, 문서 범위(조례)와 관계·지역 표 모양은 S-19 | 보완 필요 |
| 3 | 누락 방지 게이트 | 필수 140조문·재위임·사무소 35항목·`report:verify` | `law:coverage`(실패 10종)·`law_sweep`·재위임 | DB 건강 검사, 등록 범위 검사, 적용 조건 검사 | 프로젝트 게이트는 S-04 `coverage` 규칙, DB 게이트는 S-19 건강 검사 | 보완 필요 |
| 4 | 모델로 넘기는 제한값 | `envelope.auto.json`의 `limits`·`checklist[{item,std,plan,verdict,ref[]}]` | `constraints.auto.json` `constraints[]{kind,value,unit,basis[],thresholds[],settle[]}`, 값 없으면 `unbound` | 검사 도구 5종의 Markdown 출력, 매스 모듈의 `LegalEnvelope` | S-04의 `constraints[]` 모양을 `constraints?[{key,value,unit,refs[]}]`로 줄임. S-19 산식 엔진으로 계산 | 보완 필요 |
| 5 | 검색과 생성의 분리, 인용 검증 | `ask.js` 결정적 검색 → `ask --pack` 근거 팩(약 6k 토큰) → LLM. 조항 실존 검사와 `verified{by,date}`. 수치가 인용문에 있는지 검사는 설계만 | 사람이 조항 ID만 쓰고 원문은 빌더가 끌어옴. `quote_hint`는 원문의 부분 문자열이어야 함 | MCP 안은 결정적, 생성은 바깥. 인용 확인은 조문 재조회 정도 | S-01 근거 팩 + S-04 부분 문자열 규칙 + 미구현이던 수치 대조를 새로 구현 | 보완 필요 |
| 6 | 제품 규칙(원문/해석 분리, 산식 발명 금지, 계획 의존 결론 금지) | 문서·게이트로 명시. 근거 없는 산식 검사 | SKILL '다섯 절대 규칙'과 `_SCHEMA.md` §7, 상태 `설계단계`·계획 의존 `klass` | 규칙 없으면 '모름', 체크리스트 항목의 '확정/추정' 구분 | 세 출처 모두 일치. S-04 규칙을 서비스 응답 검사로 옮김 | 가능 |

세부:

1. **단계 경계.** RAW는 API 응답을 시행일별 파일로 고치지 않고 쌓고, NORM은 LLM 없이 단위 레코드(`ref`·`unit`·`text`·`art_effective`·`hash`)를 만든다. 이 둘은 S-01과 S-04가 같고 검증됐다. RULES는 출처마다 다르다. S-01 `rules.json`은 계산 연결이, S-01/S-04 지구단위계획 스키마는 적용조건·요구사항·예외·검증도서·성격이, S-04 절 정의는 상태·단계·되묻기(`issue`)·근거 사슬이, S-19는 지역·용도지역별 수치가 강하다. 새 저장소는 이 넷을 하나의 판정 레코드로 합친다(아래 「데이터 3계층」).
2. **수집.** 지켜야 할 함정: `lawService(ID)`가 옛 공포본에 머문다. 미래 시행본은 `target=eflaw&efYd=`로만 받는다. 평범한 재수집이 현재판을 과거로 되돌린 일이 두 번 있었다. 법제처 요청에는 Referer와 재시도가 필요하다. 자치법규는 같은 이름이 여러 지자체에 있어 기관명으로 다시 거른다. 자치법규 별표 본문은 비어 와 첨부(HWP/PDF)를 kordoc으로 바꿔야 한다. S-19 DB는 조례 범위가 넓지만 문서당 판이 하나뿐이고 공포일·별표·부칙이 없어 정본으로 쓸 수 없다. 범위 목록(`law-registry.json`, 지자체 목록)과 관계·지역 표 모양만 가져온다.
3. **게이트.** 세 층으로 나눈다. ① 법령 DB 게이트: 판이 낡음(`law:check`), 시행일 역행, 고아·중복 단위, FTS 동기화, 삭제 조문을 가리키는 규칙(S-19 건강 검사). ② 범위 게이트: 필수 140조문과 판정 레코드의 대응, 위임 하위 조문 미수집, 재위임 문구. ③ 답 게이트: 아래 「답 생성과 인용 검증」.
4. **제한값.** S-04 `constraints.auto.json`은 계약으로 문서화됐지만 이를 읽는 매스 코드가 없었다. 새 cLAWde는 이 값을 `Answer.constraints`로만 내고, VIDE의 가능 매스 jig(PLAN-45)가 소비자가 된다. S-19 매스 모듈의 고정 표·잘못된 조문 인용·도로사선은 쓰지 않는다.
5. **분리와 검증.** 근거 팩은 S-01에서 질문 하나에 약 10k 토큰(전체 정규 자료는 약 116만 토큰)으로 쓸 만했다. 수치가 인용문에 실제로 있는지 대조하는 검사는 S-01과 S-04 모두 설계만 하고 구현하지 않았으므로 새로 만든다.

## 결과 — 계약 질문 다섯

| # | 질문 | 판정 | 근거와 보완 |
|---|---|---|---|
| ① | 근거 팩 → 답이 `POST /v1/ask`의 `Answer`를 채우는가 | 보완 필요 | `verdict`는 판정 레코드 평가(S-19 `rule-evaluator`, 규칙 없으면 `unknown`)에서, `citations`는 근거 팩의 단위 원문에서, `conclusion`·`reasons`·`interpretation`은 LLM이 근거 팩 안에서만 쓴다. `needs`는 판정 레코드의 필요 입력(S-04 `inputs[]`·`facts_missing`)에서 나온다. 출처에 없는 것: `needs[].options`·`recommended`, `interpretation[].basis`의 사람 확인 흐름, `figures` 생성기 |
| ② | 조항 ID와 실존 확인이 `citations[].ref`의 계약이 되는가 | 가능(경로 표기만 보완) | S-01/S-04 형식 `law:<공백 없는 법령명>/제N조[의M][/①][/1[의2]][/가]`, `/별표N`, `/부칙<공포번호>`가 ARCH-01 예(`law:건축법/제61조/①`)와 같다. 실존 확인은 NORM 단위 표의 `ref` 기본 키 조회. S-19의 `law:건축법_시행령:36:항2` 형식은 쓰지 않는다. 자치법규는 `ordin:` 접두를 둔다(아래 보완 1). `ref`에 `/`가 들어가므로 `GET /v1/articles/{ref}`의 표기를 정했다(ARCH-01 반영) |
| ③ | 판정 레코드로 단계별 체크리스트(`stage`)를 만드는가 | 보완 필요 | 출처의 단계 정보는 S-04 `phase`(설계·심의·실시·사용승인, 인허가 절차 기준)와 S-01 게이트의 `design` 칸뿐이고, SPEC-13.4의 설계 단계(규모검토·계획설계·기본설계·실시설계)와 어휘가 다르다. 판정 레코드에 `stages[]`(주제가 처음 걸리는 설계 단계와 이유)를 새로 넣고 사람이 채워야 한다. 적용 여부는 S-19 `condition-matcher`(별표1 용도·층수·면적 조건)로 계산한다 |
| ④ | 사람 확정 값과 자동 값의 분리가 `profile.source`와 맞는가 | 가능 | S-01/S-04의 '사람 확정 `site.json` / 자동 `*.auto.json`, 자동은 확정을 덮지 않음'이 `source:'user'` / `'service'`·`'model'`과 맞는다. `'assumed'`는 출처에 없으므로 cLAWde는 가정 값으로 낸 결론을 '확정'으로 쓰지 않고 `checks`에 남긴다. S-04 `klass`(대지 고유/계획 의존)는 `checklist`·`ask`가 계획 의존 항목을 `conditional`로 내는 근거로 쓴다 |
| ⑤ | 부칙·별표·시행일과 `lawDbDate`의 뜻 | 보완 필요 | 부칙은 S-04 방식(단위 `addenda`, 기본 검색 제외)으로 충분하다. 별표는 법령 별표의 상자 문자 표 파싱은 되지만 자치법규 별표는 첨부 변환이 11건뿐이다. `lawDbDate`의 뜻이 계약에 없어 정했다: 마지막으로 낡음 검사(`law:check`)와 DB 게이트를 모두 통과해 게시한 정본의 날짜(가장 늦은 시행일이 아님). 공포 후 시행 전 조문은 `Article.status`로 구분한다(ARCH-01 반영) |

## 새 cLAWde 저장소 설계 메모

### 모듈

| 모듈 | 하는 일 | 실행 위치 |
|---|---|---|
| `collect/` | 법제처 DRF 클라이언트(법령·자치법규·행정규칙·`eflaw`·위임 3단 비교), 판 고정, 역행 방지, 첨부 별표 변환 | 사용자 PC 또는 예약 작업(Node) |
| `normalize/` | RAW → NORM 단위 레코드, 별표 표 파싱, 부칙, 조항 ID·별칭 정규화 | 같은 곳(결정적, LLM 없음) |
| `ontology/` | 문서·판·단위·관계·주제·판정 레코드 스키마, 마이그레이션, D1 적재 묶음 생성 | 같은 곳 → D1 |
| `gates/` | DB 게이트·범위 게이트·답 게이트, 게시 전 필수 | CI와 수집 작업 끝 |
| `engine/` | 적용 조건 판정, 안전 산식 계산, 위임 그래프 순회, 인용 해석(공용 TS, Workers와 Node 양쪽) | Workers |
| `answer/` | 질문 → 주제 → 근거 팩 → 판정 → 레시피 → `Answer`, `/v1/verify`의 문장 검사, 골든 묶음 | Workers |
| `api/` | `/v1` 아홉 끝점(여섯 + `recipes`·`verify`·`golden`), Bearer 검증, 스키마 검사 | Workers |
| `rules/` | 사람이 쓰는 판정 레코드 원본(JSON/YAML, Git), 검토 도구 | Git → D1 |

### 데이터 3계층

1. **원문 아카이브(L1):** API 응답을 문서·시행일별 파일로 고치지 않고 보관(`<kind>/<docKey>/<시행일>.json`)한다. 지우거나 덮지 않는다. 현재판 지시자(`index.json`)는 시행일·공포일·공포번호·해시를 가진다. 저장은 R2(또는 별도 Git 저장소)이며 D1에는 넣지 않는다.
2. **검색 정본(L2, D1):**
   - `documents(id, kind: law|decree|rule|ordin|admrul|notice, name, region?, mst, current_version)`
   - `versions(id, document_id, effective_date, promulgated_date, promulgation_no, status: in-force|not-yet|repealed, archive_key, hash)`
   - `units(ref PK, version_id, kind: article|para|item|sub|table|addenda, parent_ref, order, title, text, art_effective, deleted, hash)`, `units_fts(title, text, bi)` — `bi`는 한글 2-gram 열(S-01). D1의 FTS5 지원과 크기는 첫 단계에서 확인한다.
   - `relations(from_ref, to_ref?, to_document?, type: delegates|references|applies|mutatis|exception|hierarchy, phrase)` — 위임 3단 비교로 만든 위임은 조문까지 풀고, 풀리지 않은 참조는 문서 단위로 남긴다.
   - `regions`, `zones`, `use_categories`(S-19 표 모양), `changes(ref, from_hash, to_hash, at)`.
3. **판정 레코드(L3, Git 원본 → D1):** 주제(`topic`)마다 하나 이상.
   - `id, topic, title, nature: 규제|권장, refs[](L2의 ref), applies_when{text, expr}`(S-19 조건식 어휘: 용도지역·별표1 용도·층수·면적·지역)
   - `requirement{text, quantity{target, metric, op, value|formula, unit}}`(S-01 지구단위계획 스키마 + S-19 산식 DSL), `exceptions[]`, `verify_docs[]`
   - `inputs[{key, klass: site|plan}]`(필요 정보 → `needs`), `stages[{stage, why}]`(→ `checklist`), `constraint?{key, unit}`(→ `constraints`)
   - `state`, `verified{by, date}|null`(사람 확인 → `interpretation.basis:'verified'`), `quote_hint`(원문 부분 문자열)

### 수집·갱신 작업

- `law:check`(매일): 등록 목록마다 최신 시행일을 묻고 낡은 것을 보고한다.
- `law:fetch`(낡은 것만): 받기 → 역행 검사(새 시행일 < 이전이면 멈춤) → RAW 보관 → NORM → 변경 사건.
- `law:future`(주 1회): 공포 후 시행 전 판을 `eflaw`로 받아 `not-yet`으로 둔다. 시행일이 지나면 현재판으로 올린다.
- `law:tiers`, `law:tables`(첨부 별표 변환)는 등록 목록이 바뀔 때.
- 게시: 게이트 전체 통과 → D1 적재 묶음 → `lawDbDate` 갱신. 실패하면 이전 게시본을 유지한다.
- 실행 위치는 사용자 PC 또는 예약 작업(PLAN-46 결정 2). 법제처 인증값은 실행 위치의 비밀 저장소에만 둔다.

### 누락 방지 게이트

| 층 | 검사 | 실패 |
|---|---|---|
| DB | 낡은 판, 시행일 역행, 고아·중복 단위, 빈 본문, FTS 행 수 불일치, 삭제 조문을 가리키는 판정 레코드·관계 | 게시 중단 |
| 범위 | 한국건축규정 별표1 필수 조문마다 판정 레코드 또는 '해당 없음' 이유, 위임 하위 조문 미수집 목록, 재위임 문구(고시·조례) 목록, 판정 레코드의 `refs` 실존과 `quote_hint` 부분 문자열 | 필수 조문 미대응·죽은 `ref`는 게시 중단, 나머지는 할 일 |
| 답 | 아래 인용 검증 | 그 답의 결론을 낮추거나 문장을 뺌 |

### 답 생성과 인용 검증(`POST /v1/ask`)

1. 프로필 정리: `meta`가 알린 어휘로 키를 맞추고 `source:'assumed'`를 표시한다.
2. 주제 고르기: 동의어·트리거 표(S-01/S-04 `law-map.json`·`synonyms.json`)와 FTS로 주제 후보를 고른다(결정적).
3. 근거 팩: 주제의 판정 레코드, `refs` 원문, 위임 사슬(법 → 영 → 규칙 → 조례·고시)을 모은다.
4. 판정: 적용 조건을 프로필로 평가한다. 필요한 입력이 없으면 `needs`, 계획 의존이면 `conditional`과 `checks[].dependsOn`, 규칙이 없으면 `unknown`. 수치는 안전 산식 엔진만 계산한다.
5. 레시피: cLAWde는 LLM을 부르지 않는다(2026-10-07 결정, 아래 「결정」 4). `conclusion`·`reasons`·`interpretation`은 판정 레코드의 결정적 문장으로 채우고, 근거 팩(`evidence`)·계산값(`computed`)·레시피(문장 틀 판, 출력 구조, 허용 `refs`, 나올 수 있는 수치, 최소 모델 등급·effort)를 함께 낸다. 문장은 VIDE가 사용자의 CLI로 쓴다(SPEC-13.13).
6. 인용 검증: 모든 `refs`가 근거 팩의 ref 화이트리스트 안인가, 문장의 수치·단위가 인용 원문 또는 엔진 계산값에 있는가, `conditional`을 단정으로 바꾸지 않았는가. VIDE가 먼저 검사하고 cLAWde `POST /v1/verify`가 같은 규칙과 레시피 판·모델 자격을 다시 본다. 실패한 문장은 답으로 보이지 않는다.
7. `interpretation.basis`는 판정 레코드가 `verified`일 때만 `'verified'`다. VIDE에서 쓴 문장은 'AI 문장(검증됨)'으로 따로 표시한다.
8. 골든 질문 묶음(기대 판정·필수 조항)을 저장소에서 관리하고 `/v1/golden`으로 내 VIDE가 모델별 인증에 쓴다.

cLAWde에는 답 문장용 LLM 키를 두지 않는다.

### 배포와 시험

- Cloudflare Workers + D1 + R2(원문 아카이브·그림), 계정 사이트와 같은 계정·도메인 아래(PLAN-46 결정 2). Bearer는 계정 사이트가 발급한 짧은 수명 토큰을 검증한다(PLAN-46 결정 4). 개발은 정적 토큰.
- 시험: 정규화 함정 회귀(S-04 TRAPS: 조문 `text`가 제목뿐인 문제, 자치법규 호·목 없음, 별표 하위 없음, `-다.`에서 끊기는 정규식 등), 산식 엔진, 적용 조건, 게이트, 골든 질문, 그리고 VIDE 가짜 서버 표본(T-216)과 같은 응답 스키마 검사(계약 시험).

## 재사용 지도

처리: 그대로 / 손봐서 / 다시 작성 / 안 씀. 모두 새 cLAWde 저장소에서 원본을 참고해 다시 쓰며 통째로 옮기지 않는다(2026-10-07 사용자 지시). 같은 일을 하는 구성요소가 여럿이면 하나만 고른다.

| 구성요소 | 출처 | 처리 | 이유 |
|---|---|---|---|
| 법제처 DRF 클라이언트(Referer·재시도·`eflaw`·`thdCmp`) | S-04 `fetch_law.js`·`fetch_tiers.js` (S-01 같은 이름의 앞선 판) | 다시 작성(TS) | 역행 방지가 들어간 최신판. S-19 `api-client.ts`는 판례·해석례(`prec`·`expc`)만 참고 |
| 낡음 검사·미래판·역행 방지 | S-04 `law:check`·`law:future`·`--allow-regress` | 다시 작성 | 시행일 고정의 유일한 검증본. S-19 `sync-from-api.ts`는 메타만 고침 |
| RAW 시행일별 보관 형식·`index.json` | S-01/S-04 | 그대로(형식) | 검증된 고치지 않는 보관 |
| 정규화(조·항·호·목·별표 표·부칙) | S-04 `normalize.js` | 다시 작성 | 부칙 전량·표 셀. S-19 `xml-to-units.ts`는 별표·부칙이 없음 |
| 첨부 별표 변환 | S-04 `fetch_tables.js`(kordoc) | 손봐서 | 자치법규 별표가 비어 오는 문제의 유일한 해법 |
| 조항 ID·별칭·가운뎃점 정규화 | S-04 `src/text.js`, `law-aliases.json` | 다시 작성 | ARCH-01 예와 같은 형식 |
| 한글 2-gram FTS | S-01/S-04 `index_law.js` | 다시 작성 | `unicode61`만 쓰는 S-19는 조사 붙은 말을 놓침 |
| 문서 범위(조례 목록·지자체 표) | S-19 `law-registry.json`·`architecture-laws.json`·`geographic_entities` | 손봐서 | 조례 범위가 가장 넓음. 본문은 새 수집기로 다시 받음 |
| 관계 추출(「법령명」 제N조, 위임 문구) | S-19 `cross-reference-extractor.ts`·`enhance-relationships-v2.ts` | 다시 작성 | 조문 번호 정규화 결함 수정판을 바탕으로. 위임은 S-04 `thdCmp` 그래프를 우선 |
| 온톨로지 DB 파일 | S-19 `ontology.db` | 안 씀 | 판 이력·공포일·별표·부칙 없음, 관계 63% 미해결 |
| 정규식 규칙 추출 | S-19 `extract-rules(-v2).ts` | 안 씀(후보 생성만 참고) | 정답 집합·정밀도 없음. 판정 레코드는 사람이 확인 |
| 판정 레코드 스키마 | S-01 `data/dup/_schema.json` + S-04 `_SCHEMA.md` 항목 + S-01 `rules.json` | 다시 작성(통합) | 미완이던 "rules v2"를 여기서 끝냄 |
| 판정 레코드 내용 | S-04 절 정의 110항목, S-19 `compliance-items/` 약 283항목 | 손봐서 | 프로젝트 값·대지 사실을 빼고 일반 규칙만. 주제·단계 배치는 새로 |
| 적용 조건 판정 | S-19 `condition-matcher.ts`·`use-category-normalizer.ts` | 다시 작성 | 없는 필드를 통과로 치는 규칙은 `needs`로 바꿈 |
| 안전 산식 엔진 | S-19 `formula-engine.ts` | 손봐서 | `eval` 없음·변수 화이트리스트. 변수 어휘를 프로필 키로 |
| 규칙 평가(규칙 없으면 모름) | S-19 `rule-evaluator.ts` | 손봐서 | `unknown` 판정의 바탕 |
| 인용 해석·삭제 조문 경고 | S-19 `citation-resolver.ts` | 손봐서 | 새 ref 형식으로 |
| 위임 그래프 순회 | S-19 `graph-traverser.ts`, S-04 `tiers.js` | 다시 작성 | 근거 팩의 위임 사슬 |
| 근거 팩·답 규칙 | S-01 `ask.js --pack` | 다시 작성 | 결정적 검색 → 근거 팩의 원형 |
| 수치 인용 대조 | S-01 `docs/04` §4-2(c) 설계 | 다시 작성(첫 구현) | 출처에서 미구현 |
| 범위 게이트 | S-04 `coverage.js`·`deleg_scan.js`·`law_sweep.js`, S-01 `kbr_gate.js`·`kbr.js` | 다시 작성 | 프로젝트 보고서용 실패 규칙을 판정 레코드 대상으로 바꿈 |
| DB 건강 검사 | S-19 `db-healthcheck.ts`, `diagnose-empty-content.ts` | 손봐서 | 게시 전 DB 게이트 |
| 신선도 기준 | S-19 `staleness.ts` | 손봐서 | `law:check` 주기 |
| 값 상식 검사 | S-19 `checklist-validation.ts` | 손봐서 | 프로필 값 검사(건폐율 100% 초과 등) |
| 밀도 우선순위(지구단위계획 → 분할 가중 → 조례) | S-01 `src/zoning.js`, `zoning-standards.json` | 손봐서 | 서울만 있는 표를 지역 표로 일반화 |
| 일조 사선 등 형상 계산 | S-01 `src/massing.js`, S-04 `envelope.js` | 안 씀(cLAWde) | 형상은 VIDE의 PLAN-45 몫. cLAWde는 근거 붙은 수치만 |
| `constraints.auto.json` 모양 | S-04 | 손봐서 | `Answer.constraints`로 축소 |
| 운영 지침(다섯 절대 규칙·함정 목록) | S-04 `.claude/skills/law-review/` | 다시 작성(문서) | 새 저장소 AI 규약의 첫 내용 |
| 보고서 빌더·A4 검사·3D 뷰어·인쇄 | S-01 `build_report.js`, S-04 A/B/C 생성기, `vendor/three.min.js` | 안 씀 | 보고서 생성은 범위 밖(SPEC-13 §12) |
| MCP 서버 틀·도구 17개 | S-19 `tool-registry.ts` 등 | 안 씀 | 서비스는 HTTP `/v1`. MCP 도구는 VIDE가 제공(T-223) |
| 시각화(nebula)·일회성 수정 스크립트 | S-19 | 안 씀 | 일회성 |

제3자 코드·자료: 세 출처는 korean-law-mcp(MIT)와 legalize-kr의 방식을 옮겼고 코드는 옮기지 않았다고 적는다. 새 저장소도 방식만 쓰고, 쓸 경우 해당 라이선스를 적는다. 법령 자료는 법제처 Open API 이용 조건과 공공누리 표시를 따른다(출처에 표시가 없음). S-19 번들 런타임·`space-bg.jpg`·three.js는 쓰지 않는다.

## VIDE 계약과의 대응

| ARCH-01 / SPEC-13 | cLAWde 쪽 바탕 | 차이 |
|---|---|---|
| `GET /v1/meta` `{apiVersion, lawDbDate, stages[]}` | 게시 기록 | 프로필 키 어휘를 `meta`로 알리는 필드가 계약 표에 없다(「제공할 것」 3에만 있음) → 보완 2 |
| `POST /v1/ask` → `Answer` | 답 생성 7단계 | `needs.options`·`figures`는 출처에 바탕이 없다(새로 만듦) |
| `POST /v1/checklist` `stage` | 판정 레코드 `stages[]` | 설계 단계 어휘 → 보완 3(결정됨) |
| `GET /v1/articles/{ref}` | L2 `units` | `ref` 경로 표기·`status`·`promulgatedDate` → ARCH-01에 반영 |
| `GET /v1/search` | `units_fts` + `bi` | 차이 없음 |
| `POST /v1/contributions` | 없음 | 출처 셋 모두 없다. 받은 값은 L3 판정 레코드가 아니라 별도 '프로젝트 사실' 표에 쌓고 사람이 검토한다(cLAWde 설계) |
| `profile.source` | 확정/자동 분리 | 맞음(질문 ④) |
| SPEC-13.5 원문 발췌 그대로 | NORM `text` | `Article.excerpt`는 조 단위 전문인지 항 단위인지 cLAWde가 `ref` 단위로 준다 |

**ARCH-01에 반영한 것(하위 호환):** `GET /v1/articles/{ref}`의 `{ref}` 표기(`encodeURIComponent` 한 덩어리), `Article`의 선택 필드 `status`·`promulgatedDate`, `lawDbDate`의 뜻, 자치법규 `ordin:` 접두. SPEC-13의 동작은 바뀌지 않는다(모르는 필드는 무시하는 기존 규칙).

**남은 보완(사용자 검토 뒤 결정):**

1. 자치법규 조항 ID는 `ordin:<지자체>/<조례명>/제N조[/①]`(항까지만)로 제안한다. ARCH-01에는 접두만 적었다.
2. `/v1/meta`에 `profileKeys[{key, unit?, label}]`를 계약 표로 올린다(지금은 「제공할 것」 3에만 있음).
3. 설계 단계 어휘(결정됨, 2026-10-07 "설계 단계 + 인허가 단계 (추천)"): 네 설계 단계가 `stages[].id`(`scale-review`·`schematic`·`design-development`·`construction-docs`)이고, 인허가 시점은 항목의 `permitPhases[]`(`review`·`permit`·`construction-start`·`occupancy`)로 붙는다. 판정 레코드의 `stages[{stage, why}]`에 `permitPhases[]`를 더한다(S-04 `phase`가 바탕). ARCH-01·SPEC-13.6 반영.
4. `Answer`에 판정 레코드 ID(`ruleIds[]`)를 선택 필드로 두면 역전송·다시 묻기 추적에 쓸 수 있다. VIDE는 지금 쓰지 않으므로 필수로 하지 않는다.

## 첫 단계(cLAWde M1) 제안

**목표: 법령 정본과 조항 조회까지.** 판정·LLM 없이 VIDE가 조항을 확인할 수 있는 상태.

1. 새 저장소 뼈대(TS, Node 24 + Workers), AI 규약에 S-04 '다섯 절대 규칙'과 함정 목록.
2. 수집기 다시 작성: 등록 목록은 S-04의 핵심 법(약 40종) + 전국 조례 약 1,100건(S-19 범위, 2026-10-07 결정). `law:check`·`law:fetch`(역행 방지)·`law:future`·`law:tiers`. 조례 전량은 기관명 거르기·별표 첨부 변환·위임 대조를 모두 거쳐야 하므로 검증 시간과 범위 게이트의 할 일이 크게 늘어난다. 처음 전량 수집은 사용자 PC에서 한다(PLAN-46 「결정이 필요한 질문」 9).
3. 정규화·조항 ID·한글 2-gram 색인, L1(R2)·L2(D1) 적재. D1의 FTS5·용량 확인을 이 단계의 SPIKE로 한다.
4. DB 게이트와 게시(`lawDbDate`).
5. `/v1/meta`·`/v1/articles/{ref}`·`/v1/search`와 정적 Bearer.
6. 계약 시험: VIDE T-216의 응답 스키마로 세 끝점이 통과.

**완료 기준:** 등록 법령·조례 전부가 낡음 검사와 DB 게이트를 통과하고, 정해 둔 조항 ID 30개(부칙·별표·자치법규 포함)가 원문·시행일·법제처 링크와 함께 나오며, 계약 시험이 통과한다.

**다음 단계:** M2 판정 레코드 v2와 `/v1/ask`(주제 5개: 일조 사선·주차·건폐율·용적률·높이 — 답 게이트 포함), M3 `/v1/checklist`(단계 배치)·범위 게이트, M4 `/v1/contributions`와 토큰 발급 연동.

## 한계

- 조사는 문서·스크립트·스키마를 읽은 것이며 출처의 명령을 실행해 결과를 재현하지 않았다. 레코드 수는 각 출처의 색인·DB 행 수다.
- S-04의 세대 구분(1~3세대)은 여러 문서에서 재구성했다.
- D1의 FTS5 동작과 크기 한도는 확인하지 않았다(M1의 SPIKE).

## 결정

2026-10-07 사용자 검토 결과다. 남은 것은 PLAN-46 「결정이 필요한 질문」 9·10이 소유한다.

1. **원문 아카이브 위치와 수집 실행 위치:** 사용자 결정 대기. 사용자 질문("cloudflare 예약 작업으로 할 경우, 제한이나 비용이 큰 문제가 될까?")에 대한 한도·비용 분석과 권장안(처음 전량은 PC, 이후 변경분만 cron + Queues·Workflows, 기존 Workers Paid 안)은 PLAN-46 질문 9의 2.
2. **자치법규 범위(결정됨):** "전국 약 1,100개". 처음부터 조례 전체를 게이트와 함께 모은다(「첫 단계」 2).
3. **설계 단계 어휘(결정됨):** "설계 단계 + 인허가 단계 (추천)"(남은 보완 3).
4. **답 문장(결정됨):** 사용자는 cLAWde에 LLM을 두지 않고 VIDE에서 사용자의 CLI가 쓰는 안을 골랐고, "품질은 각자라는 말이 좀 걸리네. 분석하는 방법이나 모델을 계획해서 주면 퀄리티 컨트롤이 가능하지 않을까?"라고 했다. cLAWde가 판정·근거 팩·레시피·검증 끝점·골든 묶음을 주고 VIDE가 그 방법·모델로 쓰고 검증한다(「답 생성과 인용 검증」, SPEC-13.13, PLAN-46 T-236).
5. **판정 레코드 확인자:** 미정. 기본값: 사용자(관리자)가 VIDE 관리자 화면 또는 cLAWde 저장소 PR로 `verified`를 표시한다(PLAN-46 질문 10).
