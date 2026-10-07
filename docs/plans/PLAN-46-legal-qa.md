---
id: PLAN-46
title: 법규 Q&A — cLAWde 연결·법규 jig·단계별 법령·역전송·답 문장 품질 (T-215~T-224, T-236)
status: review
version: 0.9
updated: 2026-10-08
owner: agent:claude
related: [SPEC-13, SPEC-07, SPEC-08, SPEC-02, SPEC-12, ARCH-01, ARCH-03, ADR-026, ADR-030, ADR-037, ADR-039, ADR-040, RESEARCH-04, RESEARCH-16, PLAN-45, C-04, C-06, OQ-16, OQ-17, FR-09, FR-18, FR-24, FR-25]
---

# 법규 Q&A (cLAWde 연동)

2026-10-07 사용자 결정: JIG 기능을 자세히 계획한다. 이 계획은 법규 Q&A다. 구조는 [ADR-040](../decisions/ADR-040-domain-services.md)대로 cLAWde가 별도 저장소의 서비스로 법령 DB·온톨로지를 계속 쌓고, VIDE는 연결 계약으로 가져다 jig로 쓰며, 확인한 프로젝트 정보를 되돌려 보낸다. 사용자 메모는 [RESEARCH-16](../research/RESEARCH-16-domain-services-roadmap.md) §3에 있다.

- 동작: [SPEC-13](../specs/SPEC-13-legal-qa.md)
- 물리 계약: [ARCH-01](../architecture/ARCH-01-system.md) §「외부 도메인 서비스」의 「cLAWde 연결 계약」
- 대지 모델·가능 매스: SPEC-12 / PLAN-45(이 계획의 출력을 받는다)

## 착수 조건과 범위

- **착수 조건:** 2026-10-07 사용자가 C-06(법규 질의응답)과 C-04(외부 서비스 연동)를 채택했다(PRD §4.4·§14.2). 제품 티켓은 PRD 채택을 더 기다리지 않는다. 사용자가 계획을 먼저 검토하기로 했으므로(PLAN-44) T-215·T-216부터 검토 뒤 시작한다.
- **cLAWde 없이 시작한다:** 서비스가 생기기 전에는 T-216의 가짜 cLAWde 서버로 모든 VIDE 쪽 동작을 만들고 시험한다. 실제 서비스 검수는 「cLAWde 저장소가 제공할 것」이 갖춰진 뒤 VERIFY로 따로 한다.
- **제외:** cLAWde 서비스 코드, 법령 수집·온톨로지, 법규검토 보고서(A/B/C) 생성, 고시 PDF 판독, 가능 매스 계산(PLAN-45), 계정 사이트의 토큰 발급 구현은 계정 사이트 저장소 작업과 함께 한다(T-217의 외부 조건).
- **기존 자산 재사용:** 사용자 지시("기존에 만들어놓은 코드와 repo들을 잘 활용할 것")에 따라 cLAWde는 세 출처(S-01·S-04·S-19)를 종합해 새 저장소에서 만든다(T-215). 재사용은 새 cLAWde 저장소에서 하며, 이 저장소에는 세 출처의 코드·데이터·키·대지 정보를 복사하지 않고 출처 코드만 적는다. S-19(ARCO-full)의 소유·라이선스는 2026-10-07 사용자가 확인했다("Acro-full 코드의 경우 소유권과 라이선스 문제는 없어. 바탕화면에 있는 원본 소스코드를 참고해서 우리꺼에 맞춰서 작성하면 돼"). 새 cLAWde 저장소에서도 바탕화면의 원본을 참고해 다시 작성하며 통째로 옮기지 않는다. 가짜 서버의 법령 발췌는 공개 법령 원문 몇 조만 쓴다.

## T-215 SPIKE — cLAWde 새 저장소 착수 전 세 출처 종합 조사

- **기준:** 2026-10-07 사용자 결정("새 저장소로 시작하는데, 옛 비공개 CLAWDE랑 규모검토 때 했던 법규 검토(논현동 규모검토 때), ARCO-FULL에서 만들었던것 까지 3개를 모두 종합해서 하는게 좋을 듯"), RESEARCH-04 §1.1·J-03·J-04, SPEC-13.5·13.6, ARCH-01 「cLAWde 연결 계약」.
- **출처(읽기만):** 사용자 PC의 작업본이며 경로는 저장소 밖 대응표에 있다.
  - S-01 옛 비공개 CLAWDE: 2세대 법규 검토 파이프라인.
  - S-04 논현동 규모검토 작업공간: S-01을 이어받은 3세대 검토엔진과 법규 검토서·방법론·기계해석서, 법규 질의 기록.
  - S-19 ARCO-full: 법규 MCP 서버(법령·조례 온톨로지 DB, 수집·규칙 추출 스크립트, 검사 도구)와 매스 서버의 법규 모듈.
  - 열지 않는 것: 비밀키 폴더, `.env`·키·토큰 파일, 대지 자료·프로젝트 원본·발급 문서.
- **변경:** `docs/tdd/SPIKE-2026-10-07-clawde-sources.md`만 쓴다. 세 출처의 코드·데이터는 이 저장소에 복사하지 않는다.
  - 출처별로 견줄 항목:
    1. 파이프라인 단계(SCOPE → RAW → NORM → RULES → VERDICT)의 경계와 단계별 산출 형식(S-01·S-04).
    2. 법제처 Open API 수집(본문·별표·부칙·자치법규, 공포본 고정·시행일 역행 문제)과 S-19의 조례 수집·규칙 추출·관계 보강 스크립트, 온톨로지 DB 구조.
    3. 누락 방지 게이트(필수 조문 대조, 재위임 스캐너, 사무소 표준 항목, `law:coverage`)와 S-19의 적용 범위 검사.
    4. 모델로 넘기는 제한값: S-04 기계해석서의 `constraints.auto.json`, S-19 검사 도구(용적률·높이·이격·주차·조경)의 출력 → ARCH-01의 `constraints`·`checks[].dependsOn`.
    5. 검색과 생성의 분리(결정적 검색 → 근거 팩 → LLM 답)와 인용 검증(조항 ID 화이트리스트, 수치가 인용문에 실제로 있는지, `verified` 게이트).
    6. 제품 규칙으로 이을 것: 원문과 해석의 분리, 산식 발명 금지, 계획에 달린 항목의 결론 금지.
  - 계약 질문: ① 근거 팩 → 답의 흐름이 `POST /v1/ask`의 `Answer` 필드를 채울 수 있는가. ② 조항 ID(`law:<법령>/제N조/①`)와 실존 확인 경로가 `citations[].ref`의 계약이 되는가. ③ 판정 레코드(적용조건·요구사항·예외·검증도서·성격)에서 단계별 체크리스트(`stage`)를 만들 수 있는가, 없으면 무엇을 더해야 하는가. ④ 사람 확정 값(`site.json`류)과 자동 값(`*.auto.json`)의 분리가 `profile.source`와 맞는가. ⑤ 부칙·별표·시행일 처리와 `lawDbDate`의 뜻.
  - 결과물 두 가지:
    - **새 cLAWde 저장소 설계 메모:** 모듈 구성, 데이터 3계층(원문 아카이브·검색 정본·판정 레코드), 수집·갱신 작업과 그 실행 위치(사용자 PC 또는 예약 작업), `/v1` 끝점 구현, 배포(Cloudflare Workers + D1), 시험. 새 저장소가 생기면 이 메모를 그 저장소의 첫 설계 문서로 옮긴다.
    - **재사용 지도:** 구성요소마다 출처(S-NN)·처리(그대로 / 손봐서 / 다시 작성 / 안 씀)·이유. S-19는 소유·라이선스 확인이 끝났으므로(2026-10-07 사용자) 출처 안에 든 제3자 코드·자료만 그 라이선스를 적는다. 같은 일을 하는 구성요소가 출처마다 있으면 하나를 고르고 이유를 적는다.
  - 계약 보완: 결과를 「cLAWde 저장소가 제공할 것」과 ARCH-01 계약의 보완 목록으로 낸다. 계약을 바꿔야 하면 ARCH-01과 SPEC-13을 함께 고친다.
- **선행:** 없음. 사용자의 계획 검토(PLAN-44) 뒤 시작한다.
- **검증:** 정상 — 견줄 항목 여섯과 계약 질문 다섯에 '가능/보완 필요/불가'와 근거(출처 코드와 파일 이름 수준)가 있고, 재사용 지도가 세 출처를 모두 덮는다. 실패 — 저장소에 세 출처의 코드·데이터·키·주소·지번이 들어가지 않았는지 `git diff`와 gitleaks로 확인한다.
- **완료:** SPIKE 기록이 `docs:check`를 통과하고, 계약 보완이 필요 없거나 반영됐으며, 사용자가 설계 메모와 재사용 지도를 검토할 수 있다. 새 저장소를 만들고 코드를 옮기는 일은 cLAWde 저장소의 작업이며 이 티켓이 아니다.
- **의존:** T-216의 응답 표본과 새 cLAWde 저장소의 착수가 이 결과를 따른다.
- **상태(2026-10-07):** 조사 완료, 사용자 검토 대기. 기록: [SPIKE-2026-10-07-clawde-sources](../tdd/SPIKE-2026-10-07-clawde-sources.md).
  - 견줄 항목 여섯은 가능 1·보완 필요 5, 계약 질문 다섯은 가능 2·보완 필요 3·불가 0이다.
  - 새 저장소 설계 메모(모듈·데이터 3계층·수집·게이트·답 생성 7단계·배포), 세 출처를 덮는 재사용 지도, 첫 단계 M1(법령 정본과 `meta`·`articles`·`search`)을 냈다.
  - 하위 호환 계약 보완(조항 ID 경로 표기, `Article.status`·`promulgatedDate`, `lawDbDate`의 뜻, `ordin:` 접두)은 ARCH-01에 반영했다. SPEC-13 동작은 바뀌지 않는다. 남은 보완 넷(자치법규 ID 세부, `meta.profileKeys`, 설계 단계 어휘, `ruleIds`)과 결정 질문 다섯은 SPIKE에 있다.
  - 저장소에 출처의 코드·데이터·키·주소·지번이 없음을 `git diff`와 gitleaks(커밋 훅)로 확인했다.
  - 2026-10-07 사용자 검토로 결정 질문 다섯 중 셋이 정해졌다(조례 전국 약 1,100개, 설계 단계 + 인허가 시점, 답 문장은 VIDE의 사용자 CLI + 품질 관리). 수집 위치는 「결정이 필요한 질문」 9, 판정 레코드 확인자는 10에 남았다. 결정은 SPIKE·SPEC-13·ARCH-01에 반영했다.

## T-216 가짜 cLAWde 서버와 계약 시험

- **기준:** ARCH-01 「cLAWde 연결 계약」 전 끝점.
- **변경:**
  - `tests/fixtures/fake-clawde/server.mjs`: Node `http` 서버. `/v1/meta`·`ask`·`checklist`·`articles`·`search`·`contributions`. Bearer 토큰 검사.
  - `tests/fixtures/fake-clawde/cases/*.json`: 공개 법령 몇 조(예: 건축법 제61조 일조 사선, 주차장법 시행령 별표1 한 행)로 만든 답 표본. 결론별(적용·적용 안 됨·조건부·판단 불가) 하나씩, `needs`가 있는 답(주용도 되묻기), `constraints`가 있는 답, 근거 없는 결론, 계약 위반(필수 필드 없음), 그림 있는 답.
  - 시험 조종: 응답 지연, 503, 401, 일부 거절(`contributions`).
  - `tests/contract/clawde-contract.test.mjs`: 가짜 서버의 응답이 계약 스키마(`src/contracts/clawde.ts`, T-218에서 쓰는 같은 검사기. 다른 계약 스키마와 같이 `src/contracts/`에 두어 서버 타입 검사에 든다)를 통과하는지. `npm test`가 `tests/contract/*.test.mjs`를 돈다.
- **선행:** 없음(T-215와 병렬). T-215 결과로 표본을 고친다.
- **검증:** 정상 — 모든 표본이 스키마를 통과하고 위반 표본은 정확히 실패한다. 실패 — 토큰이 없거나 틀리면 401.
- **완료:** 계약 시험이 `npm run verify`에 들어가 통과한다.
- **상태(2026-10-07): 완료.** 사용자가 0단계(T-215·T-216) 착수를 승인했다. 가짜 서버 `tests/fixtures/fake-clawde/server.mjs`(`startFakeClawde()`, 단독 실행 `--port`·`--token`, 같은 토큰의 `POST /__control`), 표본 `cases/01~08`(적용·적용 안 됨·조건부·판단 불가, `needs` 되묻기 → 답한 뒤 조건부, `constraints`·그림 있는 답, 근거 없는 결론, `citations`에 없는 ref·원문 없는 조항, 필수 필드 없는 계약 위반), `articles.json`·`checklist.json`(조항 번호만 공개 법령이고 발췌는 '[시험 문구]'로 표시한 지어낸 요약), 시험 조종(지연·401·500·503·`lawDbDate` 갱신·`contributions` 일부 거절, `idempotencyKey` 중복은 첫 접수 그대로). `tests/contract/clawde-contract.test.mjs` 16건 통과. 계약 보완은 ARCH-01 「cLAWde 연결 계약」의 '보완' 줄과 `meta` 행(`stages[{id,label}]`·`profileKeys`)에 적었다. T-215 결과로 표본을 고칠 수 있다.
- **의존:** T-218 이후 모든 티켓의 시험이 이 서버를 쓴다.

## T-217 연결 설정과 토큰 보관

- **기준:** SPEC-13.11, ARCH-01 「설정·비밀」「토큰 받기」.
- **변경:**
  - `src/services/settings.ts`: `<data>/service-settings.json`, `GET/PUT /api/v1/settings/services`(원격 세션 쓰기 403).
  - `src/services/secrets.ts`: DPAPI 암호화 저장·읽기(`<data>/secrets/services.bin`). 토큰은 API 응답·로그·작업 기록에 나가지 않는다.
  - 토큰 받기: 계정 사이트 `POST /api/hosts/device/services/clawde/token`(이 PC의 호스트 키, ARCH-01 「토큰 받기」) 호출과 만료 전 갱신. 개발용 정적 토큰 입력.
  - 화면: 설정 → '외부 서비스' 절(주소·상태·법령 DB 기준일·[연결]·[끊기]), 프로젝트 설정의 '이 프로젝트는 법규 서비스에 보내지 않음'.
- **선행:** 계정 사이트의 토큰 발급 끝점(외부 조건). 없으면 정적 토큰 경로만으로 완료하고 계정 연결은 남은 조건으로 둔다.
- **검증:** `tests/core/service-settings.test.mjs` — 저장 후 토큰이 응답·로그 파일에 없음, 원격 세션 쓰기 403, 로그인하지 않은 계정의 [연결] 거절. 가짜 서버 `/v1/meta`로 상태가 '연결됨', 401이면 '로그인 필요', 닿지 않으면 '닿지 않음'.
- **완료:** 시험과 `npm run verify` 통과.
- **의존:** T-216.
- **상태(2026-10-08): 완료(정적 토큰 경로).** 사용자가 1단계(T-217~T-219) 착수를 승인했다. `src/services/secrets.ts`(DPAPI는 PowerShell `ProtectedData`에 표준 입력으로 넘김, 시험은 대체 봉인기), `src/services/settings.ts`(보기·저장·[연결]·[끊기]·만료 1분 전 갱신·상태 기록), `src/services/clawde.ts`의 `meta` 호출, `src/server/service-routes.ts`(`GET/PUT /api/v1/settings/services`, `POST …/clawde/connect|disconnect|check`), 화면은 설정의 '외부 서비스' 탭(`src/ui/shell/services-settings.tsx`, Design 「외부 서비스 설정」)이며 프로젝트별 '보내지 않음'도 그 탭에 둔다. 시험: `tests/core/service-settings.test.mjs` 6건(응답·로그·설정 파일에 토큰 없음, 원격 쓰기 403, 로그인 안 한 PC의 [연결] 409, 연결됨·로그인 필요·닿지 않음, 계정 토큰 갱신, 실제 DPAPI 왕복), `tests/integration/browser-services.mjs`. **남은 조건:** 계정 사이트의 토큰 발급 끝점은 만들지 않았다. 엔진은 `POST /api/hosts/device/services/clawde/token`(이 PC의 호스트 키)을 부르고 없으면 `SERVICE_TOKEN_UNAVAILABLE`로 알린다(ARCH-01 「토큰 받기」). 발급과 cLAWde의 검증 방식은 계정 사이트·cLAWde 저장소 작업과 함께 한다.

## T-218 엔진 커넥터·응답 검사·캐시·`service.clawde` 능력

- **기준:** SPEC-13.5의 근거 규칙, SPEC-13.9, SPEC-13.12, ARCH-01 「엔진 검사」「저장」「jig 능력」.
- **변경:**
  - `src/services/clawde.ts`: 끝점 호출(시간 상한, 401 → 상태 '로그인 필요', 재시도 없음), `src/contracts/clawde.ts`로 응답 검사, 엔진 검사(근거 없는 결론 낮추기, `unverifiedRef`, 그림 정리).
  - 프로젝트 DB 이행: `legal_profile`·`legal_answers`·`legal_articles`·`legal_contributions`(`src/core/migrations.ts`에 다음 번호).
  - 캐시: 열쇠 `(질문 정규화, stage, sent_hash)`, '다시 확인 필요'(프로필 변경·`lawDbDate` 갱신), 오프라인 표시.
  - jig 검사기: ARCH-03 `Capability`에 `service.clawde` 추가, 공식 jig만 허용, 그 밖의 출처는 등록 거절. ARCH-03 문서를 같이 고친다.
  - 계약 보완 반영(2026-10-07 사용자 결정, ARCH-01 0.99): `src/contracts/clawde.ts`와 `tests/fixtures/fake-clawde/`(`server.mjs`·`cases/*`·`checklist.json`)에 ① `stages[].id` 네 값(`scale-review`·`schematic`·`design-development`·`construction-docs`)과 `meta.permitPhases`, 체크리스트 항목의 `permitPhases?[]` ② `meta.answerModels`·`recipes`, `Answer`의 `evidence?`·`computed?`·`recipe?` ③ 가짜 서버 끝점 `GET /v1/recipes/{id}`·`POST /v1/verify`·`GET /v1/golden`과 표본(레시피 있는 답, 검증 통과·실패 사례, 골든 묶음 3문항)을 더한다. 기존 표본은 새 필드 없이도 통과해야 한다(하위 호환). 계약 시험 `clawde-contract.test.mjs`에 새 끝점·필드를 넣는다.
- **선행:** T-216, T-217.
- **검증:** `tests/core/clawde-connector.test.mjs` — 정상 답 저장과 번호 부여, 같은 질문 캐시 적중(서버 호출 0), 근거 없는 '적용' → '판단 불가', 계약 위반 응답은 저장 안 함, 503·지연 → 캐시에 오프라인 표시·새 질문 거절, 프로필 값 변경 → 해당 답만 '다시 확인 필요'. `tests/core/jig-manifest.test.mjs`에 `service.clawde` 선언이 프로젝트 jig에서 거절되는 경우 추가.
- **완료:** 시험과 `npm run verify` 통과.
- **의존:** T-219~T-224가 이 커넥터를 쓴다.
- **상태(2026-10-08): 완료.** 커넥터 `src/services/clawde.ts`(모든 끝점, 시간 상한·재시도 없음·오류 대응, 레시피 `(id, version)` 캐시, 그림을 정리한 data URL로), 엔진 검사 `src/services/clawde-check.ts`, 답 기록·캐시 `src/services/legal-answers.ts`(번호 `L<n>`, 캐시 열쇠, '다시 확인 필요'), 묻기 흐름 `src/services/legal.ts`(프로젝트 끔·미연결이면 보내지 않음, 쌓아 두지 않음), schema 13의 네 표(프로젝트 삭제·DB 나누기 포함), `service.clawde` 능력(공식 내장 jig만, ARCH-03), 계약 보완(단계 id 네 값·인허가 시점·`answerModels`·`recipes`·`evidence`·`computed`·`recipe`, 가짜 서버 `recipes`·`verify`·`golden`과 표본 `09-recipe-coverage`·`recipes.json`·`golden.json`). 시험: `tests/core/clawde-connector.test.mjs` 9건, `tests/contract/clawde-contract.test.mjs` 20건(기존 표본은 새 필드 없이 통과), `tests/core/jig-manifest.test.mjs`에 `service.clawde` 거절, `project-split` 시험에 새 표. 엔진 API는 T-219와 함께 낸다.

## T-219 법규 프로필과 보낼 정보 확인

- **기준:** SPEC-13.3·13.4.
- **변경:**
  - `src/services/legal-profile.ts`: 항목·값·출처·판, 사용자 고침은 사용자 확정, 다른 출처 값은 알림만. AI 추정 값은 보낼 목록에서 뺀다.
  - 보낼 정보 계산과 `sent_hash`. 지난 확인과 다르면 `POST …/legal/ask`가 `needsConfirm`을 돌려주고, 화면이 카드로 보인 뒤 `confirmSendHash`로 다시 보낸다. 항목 빼기는 프로젝트에 남는다.
  - 엔진 API `GET/PUT …/legal/profile`.
- **선행:** T-218.
- **검증:** `tests/core/legal-profile.test.mjs` — 첫 질문은 확인 전 서버 호출 0, 확인 뒤 보낸 본문이 확인한 항목과 같음(가짜 서버가 받은 본문 대조), 뺀 항목은 이후에도 안 나감, 값이 바뀌면 다시 확인, AI 추정 값은 고를 수 없음, 보낸 본문에 진술·이름·경로가 없음.
- **완료:** 시험과 `npm run verify` 통과.
- **의존:** T-220·T-221·T-223.
- **상태(2026-10-08): 완료(엔진).** `src/services/legal-profile.ts`(값·출처·판·뺌·근거 진술·다른 출처 알림, 단계와 마지막 확인 해시는 `vide:` 행), `src/services/legal.ts`의 `askProject`(캐시 → 끔·미연결 거절 → 보낼 정보 확인 카드 → 묻기), `src/contracts/legal.ts`, 엔진 API `GET/PUT …/legal/profile`·`POST …/legal/ask`·`GET …/legal/answers`(ARCH-01 「엔진 API」). 시험: `tests/core/legal-profile.test.mjs` 6건(첫 질문은 카드만·서버 호출 0, 확인한 항목과 보낸 본문이 같음, 뺀 항목은 이후에도 안 나감, 값이 바뀌면 다시 카드, AI 추정은 고를 수 없음, 진술·이름·경로·프로젝트 정보가 본문에 없음, 사용자 값은 알림만, 바뀐 값의 답만 '다시 확인 필요', 원격 세션의 프로필 쓰기 403, HTTP 왕복). 카드 화면은 T-221(법규 패널)에서 그린다. 모델에서 읽은 값을 채우는 길(`offer`의 `model` 출처)은 T-220이 잇는다.

## T-220 모델과 잇기(대지 모델 → 프로필, 답 → 객체, 제한 → 가능 매스)

- **기준:** SPEC-13.8, ADR-030, SPEC-12·PLAN-45의 대지 결과와 가능 매스 jig 입력.
- **변경:**
  - 대지 jig(PLAN-45) 출력에서 모델 요약(정북 방향, 대지 면적, 인접 대지 방위·종류, 도로 폭, 주변 건물 높이 요약, SHP 속성)을 읽어 프로필에 '모델에서 읽음'으로 채운다. 다시 계산되면 바뀐 값 알림.
  - 답 카드의 대상 칩: 답의 대상 키(대지·인접 대지·도로)를 대지 jig 결과의 Link ID로 풀어 뷰포트 강조. 없으면 '모델에 없음'.
  - 법규 jig 출력 `legal.constraints`: 근거 조항이 확인된 `constraints`만. PLAN-45의 가능 매스 jig가 입력으로 받는다(입력 형식은 두 계획이 같은 ARCH-03 출력 스키마로 맞춘다).
- **선행:** T-219, PLAN-45의 대지 결과 출력 형식. 없으면 합성 대지 결과 고정 자료로 시험하고 실제 연결은 남은 조건으로 둔다.
- **검증:** `tests/core/legal-model-link.test.mjs` — 합성 대지 결과에서 모델 요약 채움, 근거 없는 `constraint`는 출력에서 빠짐, 대상 칩이 Link ID로 풀림/없으면 '모델에 없음'.
- **완료:** 시험과 `npm run verify` 통과, PLAN-45와 출력 스키마 이름을 서로 가리킨다.
- **의존:** PLAN-45의 가능 매스 계산이 이 출력을 받는다.

## T-221 법규 jig 패널·답 카드·되묻기

- **기준:** SPEC-13.2·13.5·13.7, SPEC-07 §9(내장 jig), SPEC-02.19의 6, Design에 새 SCR(이 티켓에서 Design 보완).
- **변경:**
  - Design: 법규 jig 화면 SCR 추가(질문 칸·답 카드·프로필·단계 칸, 출처 표시 다섯 가지의 표현, 왼쪽 강조 막대 없이 배경으로 선택 표시).
  - `src/jigs/catalog.ts`에 J-03 '법규 검토' 공식 내장 jig 등록, `src/ui/legal-jig.tsx`·`.css`.
  - 답 카드 컴포넌트(대화와 같이 씀): 결론 → 이유 → 근거 조항(링크·발췌·시행일) → 그림 → 해석(출처 표시) → 확인 필요 사항 → 쓴 정보. [다시 묻기]. 문장은 T-236 결과를 쓰고 'AI 문장(검증됨)'·레시피 판·작성 모델을 보인다. T-236 전에는 결정적 필드만 보인다. '문장 생성 검증 실패'·'자격 모델 없음' 표시와 [다시 쓰기].
  - 되묻기: `needs` → VIDE 질문 카드(최대 3개, 권장값, [권장값으로 진행] = 가정), 답을 프로필에 쓰고 다시 묻기.
  - 보낼 정보 카드(T-219의 `needsConfirm`).
- **선행:** T-219, T-220(대상 칩).
- **검증:** `tests/integration/browser-legal.mjs`(가짜 서버) — 질문 → 확인 카드 → 답 카드 순서와 항목, 근거 없는 결론이 '판단 불가', `unverifiedRef` 표시, 되묻기 답 뒤 다시 묻지 않음, 가정 표시, 서버 정지 시 오프라인 표시와 [다시 시도], 그림이 `<img>`로만 그려짐.
- **완료:** 시험과 `npm run verify` 통과, 설치본에서 가짜 서버로 화면 캡처 확인.
- **의존:** T-222·T-223·T-224가 이 패널·카드를 쓴다.
- **상태(2026-10-08): 완료(대상 칩 제외).** 사용자가 2026-10-08 다음 단계 진행을 승인했다. Design SCR-29, 공식 내장 jig J-03 '법규 검토'(`src/jigs/catalog.ts` 사용 가능, 저울 아이콘), 패널 `src/ui/legal-jig.tsx`·`.css`, 답 카드 `src/ui/legal-answer-card.tsx`(SPEC-13.5 순서, 출처 표시 다섯 가지, 근거 없는 결론 '판단 불가(근거 없음)', '근거 미확인'·'원문 없음', 그림은 `<img>`만, `prose`·`proseStatus`가 있으면 'AI 문장(검증됨)'·'문장 생성 검증 실패'·'자격 모델 없음'과 [다시 쓰기]), 보낼 정보 카드와 '보내지 않음' 행, 되묻기(질문 카드 최대 3장, [권장값으로 진행] = 가정, 엔진 `PUT …/legal/profile`의 `assumed`·`answered`), 오프라인 표시와 [다시 시도]. 시험: `tests/integration/browser-legal.mjs`(가짜 서버를 별도 프로세스로 띄우고 멈춤), `tests/core/legal-checklist.test.mjs`의 되묻기 확인. **남은 조건:** 대상 칩은 T-220(대지 결과 Link ID)이 끝나면 답 카드 머리에 붙인다. 설치본 화면 캡처 확인은 묶음 배포 때 한다.

## T-222 단계별 법령 보기

- **기준:** SPEC-13.6.
- **변경:** 패널의 '단계별 법령' 칸(지금 단계 항목, '다른 단계 n개' 접기, 항목 → 답 카드), 항목의 인허가 시점 표시(심의·허가·착공·사용승인)와 그 거르기(화면 상태), 단계 선택을 프로필에 저장, `GET …/legal/checklist?stage=`와 캐시.
- **선행:** T-221.
- **검증:** `browser-legal.mjs`에 추가 — 규모검토 단계에서 BF 인증 표본 항목이 '다른 단계'에 있음, 인허가 시점 표시와 거르기(서버 호출 없음), 단계를 바꾸면 목록이 바뀌고 저장됨, 항목을 누르면 캐시 답 또는 새 질문, 오프라인이면 캐시 목록에 오프라인 표시.
- **완료:** 시험과 `npm run verify` 통과.
- **의존:** 없음.
- **상태(2026-10-08): 완료.** 패널의 '단계별 법령' 탭(설계 단계 분할 단추, 인허가 시점 거르기 칩은 화면 상태, 지금 단계 항목과 '다른 단계 n개' 접기, 항목 → 캐시 답 또는 새 질문, 단계는 프로필에 저장), 엔진 `GET …/legal/checklist?stage=&refresh=1`(보낼 정보 확인 카드, 단계·보낼 정보별 보관 `vide:checklist:<stage>`, 닿지 않으면 보관 목록에 오프라인)과 `POST …/legal/confirm`(ARCH-01 「엔진 API」 보완). 시험: `tests/core/legal-checklist.test.mjs` 4건(카드 먼저·보관·단계별 다시 받기, 오프라인·끔·바뀐 프로필, 되묻기 확인, HTTP), `browser-legal.mjs`의 단계 목록 부분.

## T-223 대화 경로 — 법규 도구와 인용 게이트

- **기준:** SPEC-13.2·13.5(인용 규칙)·13.9(도구), SPEC-02.17·19, SPEC-08.7.
- **변경:**
  - VIDE MCP 도구 `legal_ask`·`legal_checklist`·`legal_article`·`legal_answers`(서비스 연결·프로젝트 켜짐일 때만 턴 도구에 넣음). `legal_ask`는 확인이 필요하면 카드를 띄워 답을 기다린다. `legal_ask`는 결정적 답과 T-236의 검증된 문장(`prose`/`proseStatus`)을 함께 돌려주며, 대화 AI가 답 카드 문장을 대신 쓰지 않는다. 대화 AI의 덧붙인 풀이는 'AI 해석'이다.
  - 인용 게이트: 답 글의 `[L<번호>]`와 조문 번호를 이 턴의 도구 결과와 대조해 '확인되지 않은 인용' 표시. 법규 도구 없이 낸 법규 답에 'AI 추정 · 서비스 근거 없음'.
  - Jev 경로: 법규 질문 판정 → 이 프로젝트의 법규 대화(없으면 새로).
  - 대화의 답에 답 카드를 붙이고 패널 목록과 공유.
- **선행:** T-221.
- **검증:** `tests/core/legal-tools.test.mjs`(도구 결과·오류 코드·도구 목록 포함 조건), `tests/core/legal-citation-gate.test.mjs`(도구가 준 번호만 통과), 실제 Claude·Codex 한 턴씩 가짜 서버로 확인(VERIFY 메모).
- **완료:** 시험과 `npm run verify` 통과. 실제 CLI 확인은 남은 조건으로 따로 표시할 수 있다.
- **의존:** 없음.

## T-224 되돌려 보내기

- **기준:** SPEC-13.10, OQ-17(기본: 항목별 확인).
- **변경:** 패널 [cLAWde로 보내기] → 보낼 수 있는 항목 체크 목록(기본 모두 꺼짐, 보낼 수 없는 항목 흐림), `POST …/legal/contribute {keys[]}` → 서비스 `POST /v1/contributions`(`idempotencyKey`), `legal_contributions` 기록과 작업 기록, 일부 거절 표시. 원격 세션 403. AI는 제안 카드만.
- **선행:** T-221.
- **검증:** `tests/core/legal-contribute.test.mjs` — 고른 항목만 서버가 받음, 가정·AI 추정·미확정 진술은 거절, 같은 `idempotencyKey` 재전송은 한 번만 접수, 일부 거절 처리, 503이면 '보냄' 없음·자동 재전송 없음, 원격 세션 403.
- **완료:** 시험과 `npm run verify` 통과.
- **의존:** 없음.

## T-236 답 문장 생성과 품질 관리(레시피·검증·모델 인증)

- **기준:** SPEC-13.13·13.5(출처 표시 'AI 문장(검증됨)')·13.9·13.12, ARCH-01 「cLAWde 연결 계약」의 `Recipe`·`POST /v1/verify`·`GET /v1/golden`·「답 문장」·「모델 인증」, 2026-10-07 사용자 결정(답 문장은 VIDE의 사용자 CLI, cLAWde가 방법·모델을 정해 품질 관리).
- **변경:**
  - `src/services/legal-writer.ts`: 레시피 받기·캐시(`(id, version)`), 자격 모델 고르기(레시피 `models` 순서 중 이 PC에 있고 인증 실패가 아닌 첫 항목), CLI 단발 실행(지시 묶음·MCP·작업 폴더 도구 없음, 근거 팩만), 출력 검사 ①~⑤, `POST /v1/verify` 호출, 결과를 `legal_answers`의 문장 열에 저장. 실패는 자동 재시도 없음.
  - 프로젝트 DB 이행: `legal_answers`에 문장 감사 열 일곱(ARCH-01 「저장」). T-218 이행과 같은 번호에 넣을 수 있으면 합친다.
  - 모델 인증: `POST /api/v1/legal/model-cert {provider, model, effort}` → 골든 묶음 실행, `<data>/legal-model-cert.json`. 설정의 cLAWde 칸에 [모델 인증]과 마지막 결과. 원격 세션 403.
  - 엔진 API `POST …/legal/answers/:number/rewrite`([다시 쓰기]).
- **선행:** T-218(계약 필드·가짜 서버 끝점), T-219. T-221·T-223이 결과를 보인다(그 전에는 결정적 필드만).
- **검증:** `tests/core/legal-writer.test.mjs` — 가짜 CLI 출력으로: 정상 통과·저장, 근거 팩 밖 `ref` → `REF_OUTSIDE`, 원문·계산값에 없는 수치 → `NUMBER_UNSUPPORTED`, `conditional` → `applies` → `VERDICT_CHANGED`, 구조 위반 → `SCHEMA`, 가짜 서버 `/v1/verify` 실패 → 실패 저장·답 카드 숨김, 서버 닿지 않음 → `local-only`, 자격 모델 없음 → CLI 실행 0회, 인증 실패 모델 제외, 레시피 없는 답 → 문장 생성 안 함. 실제 Claude·Codex 한 번씩 가짜 서버로 문장 생성·검증(VERIFY 메모).
- **완료:** 시험과 `npm run verify` 통과. 실제 CLI 확인은 남은 조건으로 따로 표시할 수 있다.
- **의존:** T-221·T-223의 답 카드 문장.
- **상태(2026-10-08): 완료(엔진).** `src/services/legal-writer.ts`(자격 모델 고르기·모델 인증 기록 `ModelCerts`·단발 실행·검사 ①~⑤·`/v1/verify`·낡은 레시피 한 번 교체), `legal-answers.ts`의 감사 열 저장과 답 보기의 `prose`·`proseStatus`·`proseFailures`, `legal.ts`의 새 답 문장 쓰기·`rewrite`·`certView`·`certify`, 엔진 API `POST …/legal/answers/:number/rewrite`·`GET/POST /api/v1/legal/model-cert`, 설정 cLAWde 칸의 [모델 인증]. 단발 실행은 자료 정리의 `CliRunner`를 VIDE 문장 없이 쓴다. 감사 열은 T-218의 schema 13에 이미 있어 이행을 더하지 않았다(세부는 ARCH-01 「답 문장」의 구현). 시험: `tests/core/legal-writer.test.mjs` 18건(가짜 CLI·가짜 서버) — 정상 통과·저장·캐시 답은 다시 안 씀, `REF_OUTSIDE`·`NUMBER_UNSUPPORTED`(값·단위)·`VERDICT_CHANGED`·`SCHEMA`(구조·JSON 아님·길이)는 저장되고 숨겨지며 `/v1/verify` 호출 0·재실행 0, `conditional`/`unknown`을 올리면 실패, 서버 실패(`MODEL_NOT_QUALIFIED` 포함) 숨김, 서버 닿지 않음 → `local-only`, 자격 모델 없음 → CLI 0회, 레시피 없는 답 → 안 씀, 낡은 판 1.0.0 → 1.1.0으로 한 번 다시 씀, 인증 실패 모델 제외·다시 통과하면 복귀, HTTP [다시 쓰기]. 답 카드의 표시는 T-221, `legal_ask`의 `prose`는 T-223이 잇는다. **남은 조건:** 실제 Claude·Codex 한 번씩 가짜 서버로 문장 생성·검증(VERIFY 메모).

## 순서

1. T-215와 T-216을 병렬로 한다.
2. T-217 → T-218 → T-219.
3. T-220과 T-221을 이어서 하고(T-221은 T-220의 대상 칩만 기다림), 그 뒤 T-222·T-223·T-224는 병렬로 할 수 있다. T-236은 T-219 뒤 T-220·T-221과 병렬로 할 수 있다.
4. 실제 cLAWde가 아래 목록을 갖추면 VERIFY(실서비스 검수)를 한다.

## cLAWde 저장소가 제공할 것(외부 의존, 이 저장소의 티켓이 아님)

1. ARCH-01 「cLAWde 연결 계약」의 아홉 끝점(여섯 + `recipes`·`verify`·`golden`)과 `/v1` 판 규칙. 필드 추가는 하위 호환.
2. Bearer 토큰 검증. 계정 사이트가 발급한 토큰을 받는 방법(서명 공유 또는 검증 끝점).
3. `profile` 키 어휘를 `/v1/meta`로 알림. 되묻기 `needs[].key`가 같은 어휘를 쓴다.
4. 모든 결론에 실존하는 조항 ID(`citations[].ref`)와 원문 발췌·법제처 원문 링크·시행일. 조항이 없으면 `unknown`.
5. 단계별 체크리스트: 주제마다 설계 단계 배치(`stages[].id` 네 값)와 인허가 시점(`permitPhases[]`), 이 프로젝트의 적용 여부·이유(예: BF 인증의 단계 배치).
6. 계획에 달린 항목은 `conditional`과 `checks[].dependsOn`로 돌려주고 결론 내지 않음.
7. 수치 제한은 근거 조항과 함께 `constraints`로. 근거 없는 산식은 내지 않음.
8. `lawDbDate`(법령 DB 기준일)와 개정 반영 시 값 갱신. 공포 후 시행 전 법령의 구분.
9. `contributions` 접수: `idempotencyKey` 중복 방지, 항목별 수락·거절 이유, 접수 번호.
10. 개인정보(소유자 정보 등)를 응답에 싣지 않음. 서비스 로그의 보존 기간 공지.
11. 가용성: 응답 시간 목표와 점검 시간 안내(VIDE는 오프라인을 처리하므로 필수는 아님).
12. 답 문장 품질 관리(SPEC-13.13): 답 문장용 LLM 키를 두지 않고, 판정은 규칙으로만. `Answer`에 근거 팩(`evidence`)·계산값(`computed`)·레시피를 싣고, 판이 붙은 레시피(`/v1/recipes`)와 자격 모델 목록(`meta.answerModels`), 같은 검사를 하는 `/v1/verify`, 골든 질문 묶음(`/v1/golden`, 기대 판정·필수 조항)을 관리한다.
13. 자치법규 범위: 처음부터 전국 조례 약 1,100개(「결정이 필요한 질문」 9의 1)와 그 게이트.

## 결정이 필요한 질문

1. **PRD 채택(결정됨, 2026-10-07):** 사용자가 C-06·C-04를 채택했다. 제공 범위는 PRD §14.2의 '법규 Q&A' 행(SPEC-13: 묻기·답·단계 목록·되묻기·모델 연결·역전송)이고 보고서 생성은 후속이다.
2. **cLAWde가 사는 곳(결정됨, 2026-10-07):** 새 저장소로 시작하고, 옛 비공개 CLAWDE(S-01)·논현동 규모검토의 법규 검토(S-04)·ARCO-full(S-19) 세 출처를 종합한다(T-215). 실행 기반은 권장값 그대로다: Cloudflare Workers + D1(법령 DB·검색), 무거운 수집은 사용자 PC나 예약 작업, 계정 사이트와 같은 계정·도메인 아래(ADR-037·038의 기반 재사용). 실행 기반은 T-215의 설계 메모를 검토할 때 바꿀 수 있다.
3. **cLAWde 전에 VIDE를 먼저 만드는가:** 권장: 예. 가짜 cLAWde 서버(T-216)로 VIDE 쪽을 끝까지 만들고, 실서비스는 「cLAWde 저장소가 제공할 것」이 갖춰지면 붙인다. 엔진 안에 법령 DB를 넣는 '로컬 최소 서비스'는 만들지 않는다(ADR-040 결정 2, 서비스 세부를 VIDE에 복제하지 않음).
4. **인증 방식:** 권장: VIDE 계정(ADR-039)으로 계정 사이트가 짧은 수명의 서비스 토큰을 발급하고 cLAWde가 검증. 개발·시험은 정적 토큰. 서비스별 별도 계정은 두지 않는다.
5. **역전송 확인 단위(OQ-17):** 권장: 항목별 체크, 기본 모두 꺼짐(SPEC-13.10).
6. **서비스 DB 공유 방식(OQ-16):** 권장: API만. VIDE는 받은 답·조항만 프로젝트에 캐시하고 서비스 DB를 직접 읽거나 통째로 동기화하지 않는다.
7. **답이 누구 말인가(결정됨, 2026-10-07):** 사용자는 답 문장을 cLAWde의 LLM이 아니라 VIDE에서 사용자의 CLI가 쓰는 안(선택지 2)을 골랐고, "품질은 각자라는 말이 좀 걸리네. 분석하는 방법이나 모델을 계획해서 주면 퀄리티 컨트롤이 가능하지 않을까?"라고 했다. 그래서 cLAWde는 판정·근거 팩·레시피(문장 틀 판, 출력 구조, 허용 조항·수치, 최소 모델 등급·effort)를 주고, VIDE가 그 모델로 쓴 뒤 로컬 검사와 `/v1/verify`를 통과한 문장만 'AI 문장(검증됨)'으로 보인다. 패널과 대화가 같은 문장을 쓰며 대화 AI의 덧붙임은 'AI 해석'이다(SPEC-13.13, T-236).
8. **팀 공유:** 한 사람이 받은 답 기록을 팀 구성원이 볼 수 있게 계정 사이트로 올리는가? 권장: 1차는 PC 안만. 필요해지면 ADR-037의 공유 층으로 후속.
9. **cLAWde 수집 범위와 실행 위치(T-215 SPIKE 질문 1·2):**
   1. 자치법규 범위(결정됨, 2026-10-07): "전국 약 1,100개". 처음부터 S-19 범위의 조례 전체를 모으고 DB·범위 게이트를 그대로 건다. 조례는 같은 이름이 지자체마다 있어 기관명 거르기·별표 첨부 변환(kordoc)·위임 대조를 1,100건 모두에 해야 하므로 수집·검증 시간과 게이트의 할 일 목록이 법령만일 때보다 크게 늘어난다(SPIKE 「첫 단계」).
   2. 수집 실행 위치 — **사용자 결정 대기(권장안).** 사용자 질문: "cloudflare 예약 작업으로 할 경우, 제한이나 비용이 큰 문제가 될까?" Cloudflare 문서 확인(2026-10-07): Workers Paid의 예약(cron) 실행은 1시간 미만 주기면 CPU 30초, 1시간 이상 주기면 CPU 15분, 벽시계 15분까지다. 실행 한 번의 하위 요청은 10,000개, 메모리 128 MB. D1 Paid는 월 읽기 250억 행·쓰기 5,000만 행·저장 5 GB가 포함되고, 넘으면 읽기 100만 행당 $0.001, 쓰기 100만 행당 $1, 저장 GB-월 $0.75이며 DB 하나는 최대 10 GB다. 판단: 처음 전량 수집(법령 약 40종 + 조례 약 1,100건, 원문·색인 약 230 MB 이상, 조례별 목록·본문·별표 요청)은 예약 실행 한 번의 벽시계·하위 요청·메모리를 넘으므로 사용자 PC에서 돌려 적재한다. DB 크기는 한도 안이다. 그 뒤 갱신은 매일 또는 매주 cron이 법제처 변경 목록을 확인해 바뀐 문서만 다시 받고, 일을 Queues·Workflows 묶음으로 나눠 실행 한도 안에 둔다. 비용은 기존 Workers Paid(월 약 $5) 안이며, 월 쓰기가 5,000만 행을 넘을 때만 추가된다(전량 재적재를 자주 하지 않는 한 넘지 않는다).
10. **판정 레코드 확인자(T-215 SPIKE 질문 5):** 미정. 기본값: 사용자(관리자)가 VIDE 관리자 화면 또는 cLAWde 저장소 PR로 `verified`를 표시한다.

## 현재 상태

2026-10-07 계획을 쓰고 같은 날 범위 채택과 cLAWde의 자리(새 저장소, 세 출처 종합)가 정해졌으며, 사용자가 0단계(T-215·T-216)를 승인했다. T-216(가짜 서버·계약 시험)은 완료했다. T-215 조사도 끝났고, 같은 날 사용자 검토로 조례 범위·단계 어휘·답 문장 방식이 정해졌다(답 문장 품질 관리는 T-236으로 추가). 수집 위치(질문 9의 2)와 판정 레코드 확인자(질문 10)가 남았다. 2026-10-08 사용자가 1단계를 승인했고 T-217(정적 토큰 경로, 계정 사이트 토큰 발급은 남은 조건)·T-218·T-219(엔진)를 마쳤다. T-236(엔진)과 T-221(대상 칩 제외)·T-222도 마쳤다. 다음은 T-220·T-223·T-224다. 진행 현황은 [PLAN](PLAN.md) §6.5가 소유한다.
