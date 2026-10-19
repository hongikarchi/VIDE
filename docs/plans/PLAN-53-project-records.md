---
id: PLAN-53
title: 프로젝트 기록 — 결정·근거·영향 모델과 타임라인 (T-320~T-339, T-367~T-369, T-379)
status: draft
version: 0.9
updated: 2026-10-19
owner: user
related: [C-09, SPEC-03, SPEC-07, SPEC-08, SPEC-10, SPEC-17, ARCH-01, DESIGN, ADR-027, ADR-037, RESEARCH-17, FR-07, FR-09, FR-10, FR-12, FR-16, FR-18, PLAN-52]
---

# 프로젝트 기록 — 결정·근거·영향 모델과 타임라인

2026-10-15 사용자 결정: 프로젝트의 결정·근거·영향을 추적하는 기록 모델("진정한 의미의 BIM")을 만들고, **1차 범위는 3D 타임라인까지 한 번에** 잡는다. 구현은 세 묶음(웨이브)으로 나눠 묶음마다 설치본에 내보내되, 세 묶음이 모두 끝나야 C-09를 완료로 본다. 후보 기능 번호는 PRD §4.4의 기록 항목C-09이며 PRD 갱신에서 확정한다. 던진 생각의 원문·세 참고 화면의 분석·현재 상태 대조는 [RESEARCH-17](../research/RESEARCH-17-workspace-and-records.md)이 소유한다.

지금 VIDE에는 **앞으로 가는 추적**만 있다. 요청 → 바뀐 객체(SPEC-02.13·ADR-027), 검토본과 비교(SPEC-03.6), 사실·추정·결정 문장(SPEC-08), 매개변수 이력(SPEC-07.6), 대시보드의 할 일·일정·일지(SPEC-01.14·SPEC-10.5)가 각자 따로 쌓인다. **뒤로 가는 추적**("이 객체는 왜 이 모양인가", SPEC-03.8·3.9)은 약속만 있고 구현이 없으며, 결정 → 요청 → 객체를 시간 위에 놓는 보기는 어디에도 없다. 이 계획은 흩어진 기록을 **하나의 기록 모델**로 모으고, 그 위에 세 가지 보기를 얹는다.

## 착수 조건

- **범위:** 사용자가 2026-10-15 채팅에서 1차 범위를 정했다. PRD §4.4 후보 등록과 §14.2 범위 태그는 PRD 갱신(RESEARCH-17과 같은 묶음)에서 한다. T-320 이후 제품 티켓은 **SPEC-17이 `review` 이상**이고 Design.md에 해당 SCR이 있을 때 시작한다(AI.md §8 「구현 착수의 판단 기준」).
- **정본 선행:** 신설 `docs/specs/SPEC-17-project-records.md`가 기록의 의미·유형·부위·권한·실패를 소유한다. SPEC-03.8·3.9(객체→근거, 객체 변경 기록)와 SPEC-08(사실·추정·결정)은 SPEC-17을 가리키도록 보완하고 같은 뜻을 다시 쓰지 않는다. 저장 스키마·API는 ARCH-01 §5·§1.3에 더한다.
- **작업 폴더:** 기록의 사람용 사본은 [PLAN-52](PLAN-52-workspace-folders.md)가 정하는 작업 폴더의 운영 기록 경로(역할 `ops`의 `기록/` 하위, 기본 템플릿 `01_운영/기록/`; PLAN-52의 역할 목록에 `records`를 더하지 않는다 — 2026-10-15 결정)에 쓴다. PLAN-52의 T-310대(역할 경로·매니페스트)가 먼저 끝나야 T-323 사본 쓰기를 시작할 수 있다. 그 전까지 기록은 `project.sqlite`에만 있다.
- **개인정보·공유 경계:** 카카오톡·메일 **원문과 거르기 전 후보**는 이 PC 밖(사이트 D1·작업 폴더 GitHub 사본·외부 서비스)으로 나가지 않는다. 이 PC 안의 CLI는 읽어 정리할 수 있고, 사람이 거른 기록은 출처와 상관없이 구성원과 공유한다(2026-10-19 사용자 결정 Q4, SPEC-17.6, ADR-037 2 — 이전의 '가져온 기록은 kept여도 올리지 않음'을 대신한다). 시험 자료는 모두 합성이며 실제 대화·메일 원문은 저장소·fixture·검수 증거에 넣지 않는다.
- **참고 화면:** 세 참고 화면(기록 거르기·부위×시간 차트·모델 위 타임라인)은 사용자의 claude.ai 아티팩트이며 RESEARCH-17 §3이 구조를 옮겨 적었다. 코드는 가져오지 않고 데이터 모양(`parts`·`events`·`links`·`milestones`·`seen`·`density`)과 상호작용만 참고한다.

## 기록 모델

SPEC-17이 의미를 소유한다. 아래는 이 계획이 구현할 범위의 요약이다.

| 항목 | 내용 |
|---|---|
| 기록(record) | `{id, date, source, type, parts[], text, follows[], attachments, state}` 한 건 = 한 문장. `date`는 기록이 생긴 날(시각 선택). |
| source | `request`(요청 실행) · `chat`(대화) · `note`(노트) · `journal`(일지) · `meeting`(회의록) · `kakao` · `mail` · `site-report`(현장 보고) · `manual`(사람이 직접 적음) |
| type | **R** 요구(법·행정·건축주·이웃·브리프) · **I** 의도(설계자가 원한 것) · **K** 앎(그 부위를 얼마나 알았나: 도면 없음·열어 봄) · **E** 근거(실측·개구·구조 검토·계산) · **D** 결정(부위의 역할·사양이 바뀜) |
| parts[] | 부위 사전의 항목 id. 부위 사전은 프로젝트마다 사람이 만들고 레이어·객체군·jig 결과 단위에 매핑한다. 그룹(신설/기존 등)은 부위 사전의 속성이다. |
| follows[] | 이 기록이 **불러온** 뒤 기록의 id(앞→뒤 한 방향). 체인은 뿌리(들어오는 선이 없는 기록)부터의 도달 집합으로 계산한다. |
| attachments | 요청 id(바뀐 객체 목록은 요청에서 읽음), 검토본 id, 노트·일지 위치, 가져온 원문의 파일·줄 번호 |
| state | `candidate`(자동 후보, 아직 사람이 안 봄) · `kept`(O, 기록으로 둠) · `dropped`(X, 집계 제외) · 미표시 |
| 장(chapter) | Bypassing·Reinforcing·Replacing·Contrasting 같은 **프로젝트별 선택 분류**. 부위나 기록에 붙이며 비워도 된다. 기본 장 목록은 두지 않는다. |
| 마일스톤 | `{label, date}` 프로젝트당 목록(당선·도서 납품·착공·사용승인 등). 사람이 적는다. |
| 저장 | `project.sqlite`의 `records`·`record_links`·`parts`·`milestones` 표(ARCH-01 §5 보완). 작업 폴더 `<ops>/기록/` 아래에 월별 `YYYY-MM.jsonl`과 사람이 읽는 `README.md`(부위 사전·마일스톤·장) 사본. 사본은 DB에서 다시 만들 수 있고, 사본을 고치면 다음 열기 때 '사본이 달라졌어요' 카드로 가져올지 묻는다(PLAN-52 규칙). |

기록은 **요청·객체·검토본을 대신하지 않는다.** 요청 실행 행(SPEC-02.13)과 되돌리기는 그대로 두고, 기록은 그것을 가리킨다. 기록을 지워도 요청·객체는 지워지지 않는다.

## 웨이브 1 — 자동 기록·거르기·객체에서 기록으로 (T-320~T-326)

### T-320 SPEC-17·Design SCR·ARCH 보완

- **기준:** PRD C-09, SPEC-03.8·3.9, SPEC-08.1·08.5, SPEC-07.6, SPEC-10.5, RESEARCH-17 §3.
- **변경:** `docs/specs/SPEC-17-project-records.md` 신설 — 기록의 의미(위 표), 자동 후보가 생기는 조건과 사람 확정 규칙, 부위 사전과 매핑의 의미, 권한(기록은 프로젝트 구성원 모두 보고 적음, 가져온 원문은 올린 PC에서만 열림), 실패(원문 파일 없음·부위 매핑 끊김·같은 원문 두 번 가져옴)와 복구, 사이트 업로드 경계. SPEC-03.8·3.9는 '객체에서 기록으로'와 '객체 변경 기록'을 SPEC-17 참조로 바꾼다. SPEC-08.5 검토 기록의 '결정' 상태는 D 기록을 만든다고 적는다. Design.md §12에 SCR 세 개(기록 거르기, 부위×시간 차트, 모델 위 타임라인)를 추가하고 §07 용어에 '기록·부위·체인'을 넣는다. ARCH-01 §5에 표 네 개와 §1.3에 `…/records`·`…/parts`·`…/milestones` GET/POST를 더한다.
- **검증:** `npm run docs:check`. 사용자가 SPEC-17을 읽고 `review`로 올림.
- **완료:** SPEC-17 `review`, Design SCR 번호 부여, ARCH-01 표·API 추가. 이 뒤 T-321부터 시작.

### T-321 저장과 API

- **기준:** SPEC-17, ARCH-01 §5(T-320 보완분).
- **변경:** `src/core/records.ts`(모델·체인 계산·검증), `src/server/records-routes.ts`(목록·검색·만들기·고치기·상태 바꾸기·연결 추가/삭제·부위 사전·마일스톤), `project.sqlite` 마이그레이션. 기록 본문 검색은 `knowledge.sqlite`와 섞지 않고 `records` 표에서 한다(기록은 자료가 아니라 판단). 1차는 `text LIKE`이며 FTS 색인은 T-337의 측정 뒤에만 더한다(ARCH-01 §5 「프로젝트 기록」).
- **검증:** `tests/core/records.test.mjs` — 체인 계산(뿌리·도달·순환 거부), 상태 전이. 부위 매핑 끊김 표시는 T-325와 함께 `tests/server/object-records.test.mjs`. `tests/server/records-routes.test.mjs` — 프로젝트 격리, 권한(원격 세션 쓰기 `FORBIDDEN`; 열람자 역할은 이 PC에 아직 없어 공유 프로젝트 역할이 생길 때 후속 — SPEC-17 R-48, T-379 ③), 같은 원문 중복 거부.
- **완료:** API로 기록 50건을 넣고 읽고 체인을 받는다.
- **구현(2026-10-15):** `src/contracts/records.ts`·`src/core/records.ts`·`src/server/records-routes.ts`, 마이그레이션 19, `project-split`·`deleteProject` 표 목록, `server.ts` 등록과 PATCH·DELETE 메서드 허용. 물리 세부는 ARCH-01 1.35.

### T-322 VIDE 안 활동에서 자동 후보 만들기

- **기준:** SPEC-17 자동 후보 조건, SPEC-02.13(실행 행), SPEC-07.6(매개변수 이력), SPEC-08.5(검토 기록), SPEC-10.5(일지).
- **변경:** 아래 네 출처에서 `candidate` 기록을 만든다. 모두 **후보**이며 사람이 거르기 전에는 차트·타임라인 기본 보기에 나오지 않는다.
  1. 요청 실행이 끝나면 **D**(바뀐 객체가 있을 때) 또는 **E**(읽기·검토만 했을 때) 후보. 본문은 요청 문장, attachments에 요청 id. 부위는 바뀐 객체의 레이어가 부위 사전에 매핑돼 있으면 자동, 아니면 비움.
  2. 대화에서 결정 문장 — AI가 '결정했어요/…로 하기로' 유형의 응답을 내거나 사용자가 "결정", "확정", "…로 가자"로 답한 턴 → **D** 후보. 규칙 기반 1차(`src/core/record-candidates.ts`), 판정 모델 보강은 뒤로.
  3. 노트·일지·회의록(SPEC-10)에서 문단 단위 → 유형 미정 후보. 거르기 화면에서 R/I/K/E/D를 사람이 고른다.
  4. jig 매개변수 변경(SPEC-07.6의 누가·왜) → **D** 후보, 부위는 jig 결과 단위 매핑.
- **검증:** `tests/core/record-candidates.test.mjs` — 실행 행 → D/E, 대화 결정 문장 → D(긍정·부정 예 각 10건), 노트 문단 → 미정, 매개변수 → D. 후보 생성이 요청 처리 시간을 늘리지 않음(비동기, `request-stages`에 단계 없음).
- **완료:** 하루치 실사용(합성 프로젝트)에서 후보가 쌓이고, 중복 후보(같은 요청 두 번)가 없다.
- **구현(2026-10-15):** `src/core/record-candidates.ts`(규칙)·`src/server/record-sources.ts`(훅 아홉, 비동기)와 AI 도구 `record_add`. 네 출처 밖에 jig 확정 결과(E)·체크아웃·반영·폴더 역할 확정(K)도 연결했다. 문서 Sync K 후보는 규칙만 있고 연결하지 않았다(Sync 저장이 요청 완료 경로를 지나지 않음 — SPEC-17 R-47, 연결은 T-379 ②).

### T-323 거르기 화면(기록 탭)

- **기준:** Design SCR(기록 거르기), 참고 화면 ①(RESEARCH-17 §3.1), SPEC-17.
- **변경:** `src/ui/records-tab.tsx`. 왼쪽 레일에 장(또는 출처)별 건수와 O/X 비율 막대, 본문은 날짜·시각·출처·본문 한 줄 목록. 키 `J`/`K` 이동, `O` 남김, `X` 뺌, `⌫` 표시 지움. 성격(유형 R/I/K/E/D) 칩과 표시(미표시·O·X) 칩으로 거른다. 보이는 것 전부 O/X/지움. 행을 펼치면 부위 고르기(부위 사전 검색)·앞뒤 기록 연결(`follows`)·attachments 열기. **내보내기/불러오기:** 한 글자 한 건의 `o/x/.` 문자열(참고 화면 ①과 같은 형식)과 JSONL 전체. 작업 폴더 사본은 PLAN-52의 역할 경로가 있을 때만 쓴다.
- **검증:** `tests/integration/browser-records.mjs` — 후보 120건 fixture에서 키 조작·칩 거르기·내보내기→불러오기 왕복이 같음. Design §07 금지어 0.
- **완료:** 후보를 10분 안에 100건 거를 수 있다(사용자 동승에서 측정).
- **구현(2026-10-15):** `src/ui/records-tab.tsx`·`records-api.ts`·`records-tab.css`, 레일 '기록'(파일 다음)·`ui_go` stage. 차트 칩은 자리만(T-328), 폴더 사본 줄은 T-331 뒤. 100건/10분 측정은 미시험(사용자 동승).

### T-324 객체에서 기록으로(역방향 추적)

- **기준:** SPEC-03.8 "대상에서 근거로", SPEC-03.9, SPEC-17.
- **변경:** 뷰포트·호스트에서 객체를 고르면 인스펙터(`src/ui/inspector-content.tsx`)에 '이 객체의 기록' 절 — 그 객체를 바꾼 요청의 기록(attachments의 요청 id → 바뀐 객체 목록 역색인), 그 객체의 레이어가 매핑된 부위의 기록을 시간순으로. 항목을 누르면 요청 카드·검토본·노트로 간다. 역색인은 `src/core/object-record-index.ts`(요청 결과의 added/modified/removed → 객체 id → 요청 id).
- **검증:** `tests/core/object-record-index.test.mjs` — 되돌린 요청은 '되돌림'으로 남고 지워지지 않음, 여러 파일(ADR-027)의 객체 id 충돌 없음. 브라우저 시험에서 객체 선택 → 기록 3건 표시.
- **완료:** "왜 이 선까지 늘렸는가"를 객체 선택 → 기록 → 요청 문장으로 두 번 눌러 본다(SPEC-03.8의 예).
- **구현(2026-10-15):** 서버 `src/core/object-record-index.ts`·`src/server/object-records.ts`(15초 보관), 화면 `src/ui/object-records.tsx`(인스펙터 네 탭 아래 접힘 절). 브라우저 시험 `browser-object-records.mjs`(기록 3건 → 요청 카드).

### T-325 부위 사전

- **기준:** SPEC-17 부위·매핑, SPEC-07.5(입력 출처), 참고 화면 ②③의 `parts`.
- **변경:** 기록 탭의 '부위' 부속 화면 — 부위 추가(이름·그룹·역할 시작→끝 문장·장), 레이어·객체군·jig 결과 단위 매핑(열린 연결의 레이어 목록에서 고름), 매핑 끊김 표시. 부위 사전은 `<ops>/기록/README.md` 사본에 표로 나간다.
- **검증:** 레이어 이름이 바뀐 뒤 '끊김' 표시와 다시 잇기. 부위 20개·레이어 60개 fixture.
- **완료:** 실제 프로젝트의 레이어를 15개 안팎 부위로 묶을 수 있다.
- **구현(2026-10-15):** `src/server/parts-status.ts`(`GET …/parts/status`, 사유 `layer-missing|link-missing|instance-missing`, Sync 없는 연결은 '확인 못 함')와 기록 탭 '부위 사전' 부속 화면(다시 잇기 왕복은 `browser-records.mjs`). 사본 README 표는 T-331.

### T-326 웨이브 1 검수

- **기준:** 위 티켓 전체, PRD C-09.
- **방법:** 합성 프로젝트에서 요청 10건·노트 5건·매개변수 변경 3건을 만들고 후보 → 거르기 → 부위 매핑 → 객체 선택 → 기록까지 한 번에. 사용자 동승은 웨이브 3 뒤 한 번으로 모으되, 웨이브 1 뒤 설치본에서 거르기 화면만 15분 써 보는 짧은 확인을 요청한다.
- **완료:** [VERIFY-YYYY-MM-DD-records-wave-1](../tdd/) 기록. P0 0건.
- **구현(2026-10-15):** 오프라인 부분만 — [VERIFY-2026-10-15-records-wave-1](../tdd/VERIFY-2026-10-15-records-wave-1.md)(합성 데이터, 임시 데이터 폴더의 개발 서버). 설치본 15분 확인은 미시험.

## 웨이브 2 — 부위×시간 차트와 가져오기 (T-327~T-332)

### T-327 차트 데이터와 배치 계산

- **기준:** 참고 화면 ③(RESEARCH-17 §3.3), SPEC-17.
- **변경:** `src/core/records-chart.ts` — 행 모드(부위 / 유형 다섯 / 장), 기록의 x(날짜)·y(행), 라벨 차선 배치(행 위아래 차선, 겹침 회피), 체인(뿌리별 도달 집합, 같은 스타일/체인별 점선/체인별 작은 차트), 알려짐 선(기존 부위의 `seen` 날짜 전 점선·후 실선), 밀도 띠(장별 하루 기록 수), 마일스톤·월 격자. 순수 함수이며 DOM을 모른다.
- **검증:** `tests/core/records-chart.test.mjs` — 80건 fixture(참고 화면 ③의 DATA 모양을 합성 값으로)에서 체인 수·뿌리·라벨 겹침 0, 세 행 모드의 y 배치.
- **완료:** 같은 입력에서 같은 배치(결정적).
- **구현 계약:** [ARCH-01 §5 「프로젝트 기록」](../architecture/ARCH-01-system.md)의 '차트' 항목(새 라우트 없음, 상태 칩이 기본값이면 `kept`만, 체인은 목록 행의 `follows`로 클라이언트에서 계산)과 Design SCR-45 「구현 기준」(라벨 차선 위→아래 순, 폭은 한글 11px·그 밖 6.5px, 번호는 날짜·시각 순 1부터). 모듈은 `src/core/records-chart.ts`(순수). 참고 화면 ③의 정의는 RESEARCH-17 §2 표 행 ③이다(위 '§3.3'은 잘못된 참조).
- **구현(2026-10-15):** `src/core/records-chart.ts` — `buildRecordsChart`(행 셋·항목·`follows` 선·체인·알려짐 선·장별 하루 건수·월 격자·번호 색인)와 `layoutRecordsChart`(위1→아래1→위2→아래2 차선, 자리가 없으면 번호), `recordChains`·`chainMembers`·`labelsOverlap`. `tests/core/records-chart.test.mjs` 6건 통과(80건 합성 fixture: 체인 6·뿌리, 세 행 모드 y, 라벨 겹침 0, 결정성). '작은 차트'는 계약대로 뺐다.

### T-328 차트 화면(기록 탭 '차트' 보기)

- **기준:** Design SCR(부위×시간 차트), T-327.
- **변경:** `src/ui/records-chart.tsx` — SVG. 레일 스위치: 행(부위/유형/장), 기록 유형 다섯 토글(건수 표시), 관계(연결선·알려짐 선), 체인(동일/스타일별/작은 차트), 주석(본문·번호+색인·주요 에피소드만·신설/기존 묶기·부위 역할·장 표시·마일스톤). 기록 글리프: R 사각·I 삼각·K 겹원·E 마름모·D 채운 원. 기록 위에 올리면 설명 풍선, 누르면 그 체인만 진하게. 인쇄 보기(`#print`)는 넓은 판·굵은 라벨·색인 4단. 라벨 모드에서 번호+아래 색인 표(번호·날짜·부위·유형·본문).
- **검증:** `tests/integration/browser-records-chart.mjs` — 80건 fixture 렌더, 토글마다 DOM 글리프 수 일치, 체인 강조, 인쇄 보기 스냅샷 크기. 색은 Design.md 토큰만(강조색 하나).
- **완료:** 실제 프로젝트 기록 200건이 한 화면에 읽힌다(사용자 판단, 웨이브 3 동승).
- **구현 계약:** Design SCR-45 「구현 기준」(레일 스위치 유형·선·주석 세 묶음, 글리프 치수·빈 모양, 자세히 칸 재사용, 인쇄 판 A3 가로·색인 4단). 쓰기는 기존 `POST /records/:r/state`·`PATCH /records/:r {parts}`·`POST|DELETE /records/:r/links`만 쓴다. '작은 차트' 체인 보기는 이번 웨이브에서 뺀다. 위 '#print'는 화면 경로가 아니라 인쇄용 판 복제(`finish-jig.tsx`의 인쇄 방식)다.
- **구현(2026-10-15):** `src/ui/records-chart.tsx`·`records-chart.css`, `src/ui/records-tab.tsx`의 [차트] 자리에 마운트하고 자세히 칸을 차트에서도 연다. `tests/integration/browser-records-chart.mjs` 통과 — 80건(남김 73) 렌더, 유형 토글마다 글리프 수 일치, 체인 강조(5개·선 4개), 후보 빈 모양, 세 행 모드, 화면 라벨 겹침 0, 인쇄 판(색인 4단·73행), 내부 낱말 없음, 1,000건 첫 그리기 약 120~140 ms(≤1,000 ms 단언). 미구현은 Design SCR-45 '구현(2026-10-15)' 줄. 완료 조건(실제 200건 판단)은 웨이브 3 동승.

### T-329 가져오기 — 카카오톡

- **기준:** SPEC-17 가져오기·개인정보 경계, 참고 화면 ①의 행 모양.
- **변경:** `src/core/import/kakao.ts` — 카카오톡 PC/모바일 내보내기 `.txt`(두 가지 날짜 줄 형식) 파싱 → `{date, time, who, text}` → 후보 기록(source `kakao`, 유형 미정). 파일은 작업 폴더 `<ops>/기록/원문/`에 복사하고 attachments에 파일·줄 번호. 같은 파일·같은 줄은 두 번 넣지 않는다. 1차 거르기 도우미: 질문문·결정 어휘·부위 사전 단어가 있는 줄을 앞에 보인다(자동 O/X는 하지 않음).
- **검증:** `tests/core/import-kakao.test.mjs` — 합성 대화 300줄(두 형식, 멀티라인 메시지, 사진/파일 줄, 날짜 구분 줄) 파싱 수와 중복 거부. 저장소에 실제 대화 없음(검사 `tools/checks`에 단어 목록 추가하지 않음 — 리뷰로 확인).
- **완료:** 합성 파일 가져오기 → 거르기 화면에 후보 표시.
- **구현 계약:** [ARCH-01 §5 「프로젝트 기록」](../architecture/ARCH-01-system.md)의 '가져오기' 항목 — `POST /records/import-file {kind, name, text}`(20 MB·20,000건을 넘으면 `INPUT_TOO_LARGE`, 전부 중복이면 `RECORD_SOURCE_DUPLICATE` 409 `{existingId}`), 응답 `{added, skipped, total, recordIds[], copied, path?}`, `sourceKey` `kakao:<h16>:<line>`, `by`=세션 계정·`state=candidate`·`type=?`, `Records.addMany`, 원문 `<ops>/기록/원문/`(`writeRawCopy`, 같은 이름이면 `(2)`). 1차 거르기 도우미는 저장하지 않고 `src/core/record-triage.ts`로 화면이 정렬한다. 화면은 Design SCR-45 「가져오기와 사본 줄」.
- **구현(2026-10-15):** 파서 `src/core/import/kakao.ts`(PC 날짜 줄 + `[이름] [오후 3:12]`, 모바일 `2026년 10월 15일 …, 이름 : 내용`·`2026. 10. 15. …`, 이어지는 줄·`(사진)`·`(파일) 이름`·`(이모티콘)`, 시스템 줄 건너뜀), 후보 `src/core/import/candidates.ts`, 라우트 본체 `src/server/records-import.ts`(`recordsImportOf`, `records-routes.ts`의 `importFile` 의존성, `server.ts` 한 곳 등록), `Records.addMany`·`Records.heldSourceKeys`(전부 중복 판정을 원문 복사 전에 한 번의 질의로), `WorkspaceOutputs.writeRawCopy`(`원문/.gitignore` 포함), 거르기 도우미 `src/core/record-triage.ts`(`record-candidates.ts`의 결정·질문 어휘를 옮김), 화면 `src/ui/records-import.tsx`(.css)·`records-api.ts` `importRecordFile`·`records-tab.tsx`의 [가져오기]·'이미 들인 파일입니다.' [처음 기록 보기]·도우미 정렬과 '질문'·'결정'·'부위: …'. 검증: `tests/core/import-kakao.test.mjs`(PC 300줄 이상·모바일 두 형식), `tests/server/records-import.test.mjs`(추가·전부 중복 409·일부 중복 skipped·원문 복사와 ' (2)'·작업 폴더 없음·원격·상한·HTTP), `tests/integration/browser-records-import.mjs`(합성 카카오톡·mbox 가져오기 → 후보 표시, 다시 들이기). 합성 fixture `tests/fixtures/records-import/index.mjs`. 실제 대화 파일 확인은 남음.

### T-330 가져오기 — 메일

- **기준:** T-329와 같음.
- **변경:** `src/core/import/mail.ts` — `.eml`·`.mbox` 파싱(제목·보낸이·날짜·본문, HTML은 글만, 인용문 접기, 첨부 이름만). 메일 한 통 = 후보 하나(본문 첫 문단), 펼치면 전체. 스레드는 `follows`로 잇지 않고 attachments에 `In-Reply-To`만 둔다(연결은 사람이).
- **검증:** `tests/core/import-mail.test.mjs` — 합성 eml 20통(멀티파트·한글 인코딩·인용 포함) 파싱, mbox 분리.
- **완료:** 합성 mbox 가져오기 → 후보.
- **구현 계약:** T-329와 같은 라우트(`kind=mail`). `sourceKey`는 `mail:<Message-ID>`, Message-ID가 없으면 `mail:<h16>:<n>`. `attachments.mail {from, subject, inReplyTo?}`를 contracts의 strict 스키마에 더한다. 본문은 제목 + 첫 문단(2,000자). 위 '펼치면 전체'는 원문 파일(`attachments.file`의 줄)로 대신한다.
- **구현(2026-10-15):** `src/core/import/mail.ts` `parseMail(text, name, now?)` — 머리 접기 해제·인코딩 단어, base64·quoted-printable, charset은 `TextDecoder`(cp949·ks_c_5601-1987은 euc-kr로), 모르는 charset은 '(글자 깨짐)', multipart는 text/plain 우선·없으면 html 글만, 인용(`>`·'On … wrote:'·'-----Original Message-----'·'보낸 사람:'·'…님이 작성:')과 `-- ` 서명 제거, 첨부는 이름만(`attachmentsNames`, 저장하지 않음), mbox는 `From ` 줄로 나눔. `Date` 머리가 없거나 읽지 못하면 가져온 날·시각 없음(`time: null`). 검증: `tests/core/import-mail.test.mjs`(합성 eml 20통·mbox·euc-kr·인코딩 단어). 실제 메일 내보내기 파일 확인은 남음.

### T-331 기록 사본과 작업 폴더

- **기준:** PLAN-52 역할 경로 `ops`의 `기록/` 하위, SPEC-17 저장.
- **변경:** `<ops>/기록/YYYY-MM.jsonl`·`README.md` 쓰기(기록 상태 변경 뒤 5초 안), 폴더 사본이 바뀐 것을 발견하면 가져오기 카드. 원문(`<ops>/기록/원문/`)은 사이트 업로드·진단 묶음·AI 문맥에서 제외.
- **검증:** `tests/server/records-mirror.test.mjs` — 쓰기·다시 읽기 왕복, 원문 폴더가 진단 묶음에 없음.
- **완료:** 폴더만 복제해 다른 PC에서 열면 기록이 그대로 보인다.
- **구현 계약:** [ARCH-01 §5 「프로젝트 기록」](../architecture/ARCH-01-system.md)의 '사본 쓰기와 되들이기' 항목 — `onRecordsChanged` → `src/server/records-mirror.ts`의 5,000 ms 디바운스, 원장 키 `records:YYYY-MM`·`records:readme`(`folder-copies.json` 공유), JSONL 첫 줄은 `vide-copy:records:YYYY-MM` 표식 객체, README는 파일 전체가 VIDE 소유, `GET /records/mirror`·`POST /records/mirror/import`(줄 단위 반영)·`POST /records/mirror/rewrite`, 원문 제외 지점(진단 묶음·`deniedPath`·`workFolderRule`·`defaultGitignore`). 들이기는 SPEC-17.6의 '사본이 달라졌어요'를 따른다(노트 사본을 들이지 않는 SPEC-10.10 3과 다름). 기록 DB의 AI 읽기로 가져온 후보가 보이는 문제는 ARCH-01 R-91.
- **구현(2026-10-15):** `src/core/records.ts` `onRecordsChanged`(모든 쓰기 뒤 알림) → `src/server/records-mirror.ts` `RecordsMirror`·`recordsMirrorFor`(5,000 ms 디바운스, 바뀐 달만, `status`·`importFolder`·`rewrite`), `src/server/workspace-outputs.ts` `writeCopyIn`(확장자 일반화·`adopt`)·`writeRecordsCopy`·`writeRecordsReadme`·`copyKeys`·`copyPath`·`force`·`unforce`·`recordsCopyMarker`, `src/server/records-routes.ts` `records/mirror[/import|rewrite]`·`NO_WORKSPACE` 404, `server.ts`(시작 때 예약·[버리기]의 `records:` 분기·종료 때 `stop`/`idle`), 원문 제외 `diagnostic-bundle.ts` `forbiddenEntry`·`project-files.ts` `deniedPath`·`agent-connection.ts` `workFolderRule`(원문 폴더와 kakao·mail 기록 행 — R-91 (a))·`workspace-git.ts` `defaultGitignore`, 화면 `src/ui/records-mirror-line.tsx`(.css; 머리 끝 회색 줄 '폴더에 씀 · …/'·'폴더에 아직 안 씀', 작업 폴더 없으면 없음, 바뀌면 상자와 [폴더 내용 들이기]·[VIDE 기록으로 다시 쓰기])와 `records-api.ts` `mirrorState`·`importMirror`·`rewriteMirror`. 시험 `tests/server/records-mirror.test.mjs`(9건: 알림, 왕복, 디바운스 1회, 바뀜 보존·줄 단위 들이기·skipped, 다시 쓰기, 다른 PC 폴더, 작업 폴더 없음, 원격 GET만, AI 지시문)와 `project-files`·`diagnostics-lines`·`workspace-files` 시험 확장. 계약과 달라진 점은 ARCH-01 '구현에서 정한 것'. 대시보드의 사본 카드는 없어 연결하지 않았다. 남은 것: 실제 작업 폴더에서 화면 확인(T-332).

### T-332 웨이브 2 검수

- **방법:** 합성 카카오톡·메일을 가져와 거르고 부위에 묶은 뒤 차트 세 행 모드·인쇄 보기를 확인. 성능: 기록 1,000건에서 차트 첫 그리기 ≤1 s.
- **완료:** VERIFY 기록. P0 0건.
- **검수(2026-10-15, 오프라인):** [VERIFY-2026-10-15-records-wave-2](../tdd/VERIFY-2026-10-15-records-wave-2.md) — 단계 13개 중 12 통과·1 부분(가져오기 → 거르기 → 부위 → 차트를 한 번에 잇는 흐름은 단계별 시험만), 1,000건 첫 그리기 180 ms. 검수 중 찾은 P0 2건(사본 되들이기가 VIDE의 나중 변경을 되돌림, 거르지 않은 kakao·mail 후보가 폴더 사본에 쓰임)은 고쳤다. 남은 것: 실제 파일·실제 작업 폴더·실제 인쇄(사용자 동승).

## 웨이브 3 — 모델 위 타임라인과 검토본 연결 (T-333~T-339)

### T-333 부위별 모델 묶음

- **기준:** 참고 화면 ②(RESEARCH-17 §3.2), SPEC-17 부위 매핑, ARCH-01 §5 모델 저장(`lazy` 독자 규칙).
- **변경:** `src/core/records-scene.ts` — 열린 연결의 최신 Sync(SPEC-07.5의 7 규칙)에서 부위 사전의 매핑으로 객체를 부위별로 묶는다. 매핑 안 된 객체는 '그 밖' 묶음으로 흐리게. 신설/기존 그룹 분리 오프셋. 좌표는 풀지 않고 표시 형상 id 목록만 다룬다(뷰포트가 그림).
- **구현 계약:** ARCH-01 1.40 §5 「부위별 모델 묶음」 — 새 라우트 없이 클라이언트 순수 모듈 `src/core/records-scene.ts`가 뷰포트가 이미 그린 `objects[]`(`id`·`sourceId`·`documentKey`·`layerName`)만으로 `layerIndexOf`·`bundleParts`·`partLevels`·`objectLevels`·`separationVectors`를 계산한다. 레이어는 정확히 일치, 한 객체가 여러 부위면 모든 묶음(가장 밝은 단계), `jig-output`은 `unresolved`, 묶이지 않은 객체는 `unmapped`(그 밖). 단계 계수 on 1 · dim 0.25 · 그 밖 0.12. 분리는 `grp`별 x축 오프셋(모델 폭 × 1.2, 표시 전용). 시험에 객체 20,000·부위 30 측정(≤200 ms, T-337 4)을 더한다.
- **검증:** `tests/core/records-scene.test.mjs` — 부위 15개·객체 500개 fixture에서 묶음 수·미매핑 수.
- **완료:** 묶음 계산이 Sync 목록을 통째로 읽지 않는다(`lazy`).
- **구현(2026-10-15):** `src/core/records-scene.ts` — `layerIndexOf`·`bundleParts`(정확한 레이어 경로·같은 연결의 `sourceId`, `jig-output`·표시 안 된 연결은 `unresolved`, 여러 부위면 모든 묶음, 그 밖 `unmapped`, `partsOf`)·`partLevels`·`objectLevels`(가장 밝은 단계)·`sceneGroups`·`separationVectors`·`sceneEpisodes`(장 → 이어진 기록). 입력은 뷰포트 `objects[]`의 `{id, sourceId, documentKey, layerName}`뿐이고 서버 라우트는 없다. 시험 `tests/core/records-scene.test.mjs` 6개 통과 — 부위 15·객체 500(연결 둘, 같은 레이어 이름·같은 id 충돌 없음) 묶음 177·그 밖 323, 결정성, 단계, 분리, 에피소드, 객체 20,000·부위 30 묶음 중앙값 약 10 ms(기준 200 ms).

### T-334 타임라인 보기(뷰포트 위)

- **기준:** Design SCR(모델 위 타임라인), T-333, 참고 화면 ②.
- **변경:** `src/ui/records-timeline.tsx` — 뷰포트 아래 가로 타임라인(행 = 부위, 기록 글리프, 연결선). 커서를 끌거나 재생하면 그 날짜까지의 기록이 있는 부위가 켜지고(불투명), 없는 부위는 흐리며, 커서 전후 60일 안의 기록은 라벨을 띄운다. 에피소드 칩(기록의 `ep`)을 누르면 그 체인의 부위만 켜지고 선이 이어진다. '신설/기존 분리' 토글, '전부 보기'. 인쇄 모드는 뷰포트만 전체 화면. 뷰포트 조작은 기존 three.js 카메라·선택 규칙을 그대로 쓰고 선택 → T-324의 '이 객체의 기록'으로 이어진다.
- **구현 계약:** ARCH-01 1.40 §5 「뷰포트 표시 API」·「타임라인 띠」, Design 1.28 SCR-46 「구현 기준」. `viewport.ts`에 `fade`·`highlight`·`offset`·`fadeInfo`만 더하고, `src/ui/records-timeline.tsx`·`.css`는 `.workspace`에 덧붙인다(`Shell.tsx`·`style.css` 안 바꿈). 에피소드는 기록에 `ep` 필드가 없으므로 `chapter`(장)와 `recordChains`(이어진 기록)로 만든다 — 위 '기록의 `ep`'는 이 뜻으로 읽는다. [기록 탭에서 보기]는 `showRecords(projectId, {open})`. 시험의 모델은 합성 Sync(`browser-live-sync-layers.mjs` 방식)이며 커서 응답 ≤100 ms(`fadeInfo` 변화까지).
- **검증:** `tests/integration/browser-records-timeline.mjs` — fixture 모델(합성 `.3dm` 스냅샷)에서 커서 이동마다 켜진 부위 수, 에피소드 선택, 분리 토글. 60 fps 요구는 두지 않되 커서 이동 응답 ≤100 ms.
- **완료:** 사용자가 커서를 끌며 "이때 이 부위가 왜 이렇게 됐는지"를 기록에서 읽는다.
- **구현(2026-10-15):** `src/ui/records-timeline.tsx`·`.css`(`app/boot.ts`가 모델 탭에 한 번 붙임, `Shell.tsx`·`style.css` 안 바꿈), `src/ui/viewport.ts` `fade`·`highlight`·`offset`·`fadeInfo`, `records-tab.tsx` `showRecords(projectId, {open})`, `app/viewport.ts` `openRecordRequest` export. T-335와는 수정 단계에서 `records-moment.ts`를 직접 불러 이었다: 놓은 커서·한 걸음·재생 멈춤·눈금 → `pickMoment(날짜)`, 접기·모델 탭 떠남·언마운트 → `pickMoment(null)`, 펼침 → 마지막 커서 날짜, [현재로] → 커서를 오늘로, 눈금은 `momentTicks()` 하나(띠의 자체 눈금 계산·기준 글자는 지움). `showLayers()`가 끝에 `linksState.bump()`를 불러 띠가 Live Sync 뒤에도 묶음을 다시 센다. [재생] 중에는 커서 날짜를 기억에 쓰지 않는다. 시험 `tests/integration/browser-records-timeline.mjs`(test:browser에 추가) 통과 — 합성 Sync 객체 64·부위 6·기록 40·마일스톤 2·검토본 2: 커서 날짜마다 켜진 부위 수와 흐린 객체 수, 커서 → `fade` 반영 중앙값 약 1 ms(객체 64; 20,000개 측정은 T-337), 에피소드(부위 3 켜짐·◀ ▶·Esc), [전부 보기], [분리](기존 16개 이동·복귀), 글리프 → 강조 8·카드 → 기록 탭 자세히, 객체 선택 → 부위 행, [접기]/[펼치기], 검토본 눈금 누름, 새로 읽어도 커서 날짜 유지, 금지어 0. 실제 프린터 출력과 사용자 동승은 아직.

### T-335 검토본과 시점 연결

- **기준:** SPEC-03.6 검토본·비교, SPEC-17.
- **변경:** 타임라인의 날짜에 검토본이 있으면 표식을 두고, 누르면 그 시점의 검토본을 뷰포트에 겹친다(기존 비교 화면 재사용). 검토본을 만들 때 선택적으로 기록(D 또는 E)을 함께 만든다.
- **구현 계약:** ARCH-01 1.40 §5 「시점 형상」·「검토본과 함께 기록」. 눈금은 기존 `GET /reviews`와 앱이 읽은 요청 목록의 문서 Sync, 형상은 '과거 Sync 보기'(`showRequest(id, {keepCamera: true})` + `layerOverride`)로 그 연결 자리에 대신 그린다(3D 겹침 없음 — SPEC-17 R-86). 커서를 놓거나 재생을 멈출 때만 바꾼다. `POST /reviews {record?: {type: D|E, text?}}` → `Records.add(..., {state: kept, source: manual, sourceKey: review:<reviewId>})`, 실패해도 검토본은 남고 응답 `record: {id}|{error}`. 출처 값은 SPEC-17 R-87 결정 전까지 `manual`.
- **검증:** 검토본 3개 fixture에서 표식·전환·되돌아오기 — `tests/core/records-moments.test.mjs`(시점 계산), `tests/server/review-record.test.mjs`(검토본과 함께 기록·원격 `FORBIDDEN`), `tests/integration/browser-records-moment.mjs`(눈금 6·전환·[현재로]·띠로 구동·접기/펼치기·요청 기준 유지·저장 대화상자), `tests/integration/browser-records-timeline.mjs`(띠의 검토본 눈금 → 기준 글자).
- **구현(2026-10-15):** 시점 계산은 순수 `src/core/records-moments.ts`(`buildMoments`·`momentTicks`·`pickMoments`·`basisText`; 정리된 Sync 제외, 연결 Sync가 아닌 검토본은 눈금만), 화면 연결은 `src/ui/records-moment.ts`(`momentTicks()`·`pickMoment(date|null)`·`clearMoment()`·`momentState()`·`setMomentToday()`·`onMomentsChange()`; 뷰포트 왼쪽 위 기준 글자와 [현재로], `records-moment.css`)이며 앱 시작 때 불러온다(`app/boot.ts`). `links-sync.ts`에 `showRequest(id, {keepCamera})`와 `clearLayerOverrides(linkIds)`를 더했다(이 모듈이 건 대체만 되돌리고 숨긴 연결은 건드리지 않음). 수정 단계: `showRequest`는 활성 레이어와 요청 기준(`displayedResult`)을 과거 Sync로 바꿔 커서를 놓기만 해도 AI 요청이 옛 형상을 기준으로 갔으므로, 보기 전용 대체(`setViewOnlyOverride`·`viewOnlyOverrides`, `applyActiveLayer`가 그 연결의 최신 Sync를 기준으로 둠)로 바꿨다(ARCH-01 R-92) — `showRequest`의 `keepCamera` 인자는 쓰는 곳이 없어 지웠다. 검토본과 함께 기록은 `src/server/review-record.ts`(`reviewRecordInput`·`addReviewRecord`)와 `server.ts` `POST …/reviews`, 저장 대화상자 체크·라디오·한 줄(`reviews.tsx`, 원격 숨김). 띠와의 연결은 수정 단계에서 했다(T-334 줄). 시험: `tests/core/records-moments.test.mjs`, `tests/server/review-record.test.mjs`, `tests/integration/browser-records-moment.mjs`(검토본 3개·동기화 3개 합성, `test:browser`에 추가) 통과.
- **완료:** 시점 선택 → 그 시점 모델과 기록이 같이 보인다.

### T-336 공유 경계와 사이트

- **기준:** ADR-037, SPEC-17 권한.
- **변경:** 사이트(D1)에는 **거른 기록(kept)의 본문·유형·부위·날짜만** 올릴지 프로젝트 설정으로 정한다(기본 끔). 가져온 원문·후보·X 기록은 올리지 않는다. 올릴 때는 노트와 같은 경로(PLAN-36 패턴)를 쓴다. 이 티켓은 설정과 경계 검사까지이며 사이트 쪽 보기는 뒤로 미룬다.
- **구현 계약:** ARCH-01 1.40 §5 「사이트 사본」. 위 '노트와 같은 경로(PLAN-36 패턴)' 대신 PLAN-33/35의 할 일 사본 방식으로 한다(SPEC-17 R-88). 설정 `offline-view.json` `projects[id].records`(기본 false), `PUT /api/v1/projects/:id/offline-view {records?}`(원격은 FORBIDDEN). 경계 지점 `src/server/records-share.ts` — kept·정정되지 않음·카카오톡·메일 출처와 그 원문 attachments 제외, 항목 `{id, date, type, text, parts(이름), chapter, updatedAt}`만. 전송 `PUT /api/hosts/device/projects/:id/records {items, first}`(500건·900 KB 묶음), 끄기·프로젝트 삭제는 `DELETE …/records`. D1 `0018-project-records.sql`(`project_records`, `project_summaries.records_at`). 사이트 보기는 뒤로. 사이트 시험은 새 `tests/sharing/records.mjs`를 `src/sharing/package.json` test 줄에 더한다.
- **검증:** `tests/server/records-share.test.mjs` — 기본 끔, 켜도 원문·후보 미포함.
- **완료:** 경계 검사 통과.
- **구현(2026-10-15):** 계약대로 했다. PC 쪽은 `src/server/records-share.ts`(`shareable`·`recordsShare`·`recordBatches`), `src/server/offline-view.ts`(`setRecords`, `shareRecords`, 설정 키 `projects[id].records`, `summaries[id].records·recordsAt·recordsError`), `src/server/remote-access.ts`(`uploadRecords`·`deleteRecords`)이다. `src/server/server.ts`는 `OfflineView`에 `records`를 주입하고, `PUT …/offline-view {records}`를 원격 세션이 보내면 `FORBIDDEN`으로 막는다. 사이트 쪽은 `src/sharing/migrations/0018-project-records.sql`, `src/sharing/summary.ts`(`recordsDeviceRoute`, 문장 셋 이하의 `json_each` batch)이다. 화면은 연결 파일 칸의 '할 일·대화 기록' 스위치 아래에 '거른 기록을 사이트에 올리기'를 두고 Design SCR-46 「사이트 스위치」의 설명 한 줄과 실패 줄을 붙였다(`src/ui/links.tsx` `RecordsSwitch`, `src/ui/app/left.ts` `onRecords`). 계약에서 더 정한 것은 ARCH-01 「사이트 사본」에 적었다. ① 끄기·삭제 때 사이트가 확인하지 않은 DELETE는 `recordsRemovals`에 남겨 heartbeat마다 다시 보낸다(404는 지워진 것으로 본다). ② 켜는 순간의 `tick(true)`이 진행 중인 실행에 합쳐지면, 그 실행이 끝난 뒤 한 번 더 돈다. ③ 할 일 사본을 꺼도(`DELETE …/summary`) 기록과 `records_at`은 남는다. ④ 수정 단계: 강제 실행이 아니면 지문은 프로젝트마다 1분에 한 번만 계산한다(heartbeat 15초마다 남김 기록 전체를 읽지 않게). ⑤ 사이트 배포(D1 0018·Worker) 전에는 켠 프로젝트의 업로드가 실패해 연결 칸에 경고 한 줄 '사이트에 올리지 못했습니다 · 1분 뒤 다시'가 서고 1분마다 다시 보낸다(조용히 넘기지 않는다). 스위치 문구는 Design SCR-46 「사이트 스위치」대로 고쳤다. 원문 폴더 이름은 `src/contracts/records.ts` `RECORD_ORIGINALS` 하나를 쓰는 곳(쓰기·AI 파일 도구·git 제외·사이트 경계)이 공유한다. 시험: `tests/server/records-share.test.mjs` 6개 통과(경계·묶음 나누기·기본 끔·바뀔 때만 다시 보냄·뺀 기록 빠짐·`SITE_UNREACHABLE` 1분 대기·끄기와 삭제·HTTP 끝까지·원격 403), `tests/sharing/records.mjs` 통과(소유 PC만·묶음 바꿔치기·일곱 필드만·잘못된 항목 400·할 일과 분리·DELETE·cascade). `npm --prefix src/sharing test` 전체가 통과했다. 사이트에서 보는 화면은 만들지 않았다.

### T-337 성능·용량

- **기준:** 기록 5,000건·부위 30개·객체 20,000개.
- **변경:** 측정 뒤 필요한 것만(차트 가상 스크롤, 역색인 캐시). 추측 최적화는 하지 않는다(AI.md §8 「실행 우선」).
- **구현 계약:** ARCH-01 1.40 §5 「성능 측정」 표 9항목(목록 API ≤500 ms, 차트·기록 탭·띠 첫 그리기 ≤2 s, 묶음 ≤200 ms, 커서 ≤100 ms, parts/status ≤500 ms, 객체의 기록 ≤500/100 ms, 사이트 지문 ≤50 ms). 중앙값(예열 1회 뒤 5회)을 VERIFY 웨이브 3에 적고, 기준을 넘은 항목만 고친다.
- **완료:** 차트·타임라인 첫 그리기 ≤2 s, 커서 응답 ≤100 ms.
- **측정(2026-10-15):** 합성 자료(기록 5,000건 중 요청을 가리키는 1,000건, 부위 30, 장 6, 문서 Sync 객체 20,000, 변경 목록이 있는 요청 2,000)로 쟀다. 값은 중앙값이다.
  - 목록 API 무거르기 53 ms·`state=kept` 53 ms(≤500)
  - 화면에서 부른 목록 API 63 ms
  - 기록 탭 첫 목록 5,000행 195 ms(≤2 s)
  - 차트 첫 그리기 492 ms(≤2 s)
  - `parts/status` 1.3 ms(≤500)
  - '이 객체의 기록' 처음 60 ms / 다시 43 ms(≤500/100)
  - 사이트 지문 28 ms(≤50)
  - 묶음 계산 객체 20,000 9.6 ms(≤200, T-333 시험)

  - 띠 첫 그리기 5,000건(모델 탭 복귀) 158 ms(≤2 s), 커서 → `fade` 객체 20,000 57 ms(최대 84, ≤100), [전부 보기] → `fade` 84 ms(≤100) — 수정 단계에서 `browser-records-perf.mjs`에 합성 문서 Sync 객체 20,000을 더해 잼(같은 실행의 목록 API 340 ms·기록 탭 544 ms·차트 478 ms, 모델과 띠를 함께 그리는 상태)

  모두 기준 안이라 **고친 코드는 없다.** `rowsOf` 전체 스캔, 기록 탭의 목록 2회 읽기·전체 그리기, 차트 가상 스크롤, `fade`의 청크 다시 짓기는 그대로 둔다. 시험: `tests/core/records-perf.test.mjs`(1·7·8), `tests/integration/browser-records-perf.mjs`(1·2·3·5·6, 새 브라우저 3회, `test:browser`에 등록), `tests/server/records-share.test.mjs`(9). 기록은 [VERIFY-2026-10-15-records-wave-3](../tdd/VERIFY-2026-10-15-records-wave-3.md)에 있다.

### T-338 사용자 동승 검수(실제 프로젝트)

- **기준:** PRD C-09, 이 계획 전체.
- **방법:** 사용자가 고른 실제 프로젝트(예: 나진상가·연무장길 11)의 기록을 **사용자가 직접** 가져오고(카카오톡·메일 내보내기, 회의록) 거르고 부위에 묶어 차트·타임라인을 본다. 15~30분, 에이전트는 화면을 조작하지 않으며 원문을 읽지 않는다. 판정은 사용자: "이 그림이 내가 아는 그 프로젝트의 결정 흐름과 같은가". 동승 중 관찰은 VERIFY에 남기고 원문·스크린샷의 대화 내용은 남기지 않는다.
- **구현 계약:** 새 코드 없음. 사용자 동승 관찰을 VERIFY에 남기며 원문·대화 내용·스크린샷의 본문은 남기지 않는다.
- **완료:** 사용자 판정 통과 또는 결함 목록.

### T-339 C-09 완료 판정

- **방법:** 세 웨이브 VERIFY와 T-338 판정을 모아 PLAN.md §6.5와 PRD §4.4 C-09 상태를 갱신. 남은 결함은 새 티켓으로.
- **구현 계약:** 새 코드 없음. 판정과 남은 결함을 PLAN.md §6.5와 PRD C-09에 반영한다.
- **완료:** PRD C-09 "구현·검수 완료", 설치본에 포함.

## 2026-10-19 결정 반영 — 지난 요청 후보·서버 파일·AI 정리 (T-367~T-369)

2026-10-19 사용자 결정(B1 ①, Q5 ③, Q4 ①)을 SPEC-17 §3 1·5·6과 §6에 반영했고(같은 날 문서 반영), 이 세 티켓이 코드를 맡는다. 셋 다 웨이브 3과 독립이며 T-338 동승 전에 끝내면 동승에서 함께 본다.

### T-367 지난 요청에서 자동 후보 한 번 만들기(B1)

- **기준:** SPEC-17.3 1(기록이 하나도 없는 프로젝트는 처음 열 때 한 번, 지난 성공 요청의 본문·바뀐 객체에서 '자동 후보', 두 번째 열기부터 안 함, 버튼 없음, 거르기는 사람), SPEC-17.3 4(중복), SPEC-00 출처 구분.
- **변경:** 프로젝트를 열 때(기록 탭을 열지 않아도) 그 프로젝트의 기록이 0건이고 '지난 요청 후보를 만든 적 없음'이면, 프로젝트 DB의 지난 요청 행을 읽어 `src/core/record-candidates.ts` `candidateFromRequest`를 그대로 재사용해 `Records.addMany`로 한 번에 넣는다(`by='ai'`, `state='candidate'` — SPEC-17의 '자동 후보'). 실패·취소·진행 중·본문 없는 요청과 문서 Sync 행은 `candidateFromRequest`·현행 훅과 같이 뺀다. `sourceKey`(`request:<id>`)가 현행 훅과 같으므로 나중 요청과 중복되지 않는다. 처리 뒤(0건이어도) 1회 표식을 프로젝트 DB에 남겨 두 번째 열기부터 하지 않는다 — 표식의 물리 위치는 ARCH-01 §5 「프로젝트 기록」 「자동 후보의 진입점」에 한 줄 더한 뒤 구현한다. 비동기이며 프로젝트 열기 시간을 늘리지 않는다. 다시 만드는 단추는 두지 않는다. 원격 세션에서는 만들지 않는다(쓰기 금지).
- **표시:** 표시는 Design SCR-44의 AI 후보 '제안' 칩을 그대로 쓴다(SPEC-17의 '자동 후보' 상태의 화면 표현).
- **검증:** 단위 — 성공 요청 N건(바뀐 객체 있음·없음 섞음)·실패 1·취소 1·본문 없음 1 → 후보 N건(D/E 맞음, `by='ai'`), 같은 프로젝트에서 두 번째 실행 → 0건, 기록이 1건이라도 있는 프로젝트 → 0건, 그 뒤 새 요청 훅 → 같은 `sourceKey` 중복 0. 설치본 — 나진상가처럼 요청이 있고 기록 탭이 빈 프로젝트를 열면 탭에 '자동 후보'가 채워지고, 엔진을 다시 띄워 열어도 늘지 않는다(사용자 데이터는 읽기만, 에이전트는 사본 프로젝트로 확인).
- **완료:** 위 단위 시험 통과, 설치본에서 빈 프로젝트 한 곳이 채워지고 재실행 0건, 그 후보에 '제안' 표시가 화면에 보임.

### T-368 서버 파일 들이기 — 문서 내용 + 변경 사건(Q5)

- **기준:** SPEC-17.3 6(문서 내용은 기록 카드 후보, 변경 사건은 얇은 표식, 한 파일이 카드로 두 번 보이지 않음), SPEC-17.5(모델 위 타임라인), Design SCR-45·46. 서버 파일의 목록·매핑·변경 사건은 PLAN-52가 이미 가진다 — `server.paths` 매핑(T-307·T-309), 체크아웃·반영(T-310·T-311), 파일 지도의 사건 색인(T-318: Sync·체크아웃·반영·jig 실행·요청 변경·서버 판 갱신)과 시간축(T-319). 문장 추출은 SPEC-08 자료 정리(`knowledge.sqlite` 진술)가 이미 한다.
- **변경:** ① **내용 → 카드:** 매핑된 서버 폴더의 문서에서 자료 정리가 뽑은 결정·요구 문장을 기록 후보로 만든다(지금 `RECORD_SOURCES`에 없는 새 출처 값 하나, `attachments.file`에 파일 경로·문단, `sourceKey`는 파일+문장 해시). 같은 파일의 문장은 그 파일 하나의 출처로 묶어 카드가 파일마다 두 번 생기지 않게 한다. 자료 검색과 기록 검색은 섞지 않는다(SPEC-17.6). ② **변경 사건 → 표식:** 서버 판 갱신·반영(누가·언제 올렸나)은 기록 행을 만들지 않고 파일 지도 사건 색인을 그대로 읽어 기록 차트·모델 위 타임라인 띠의 시간축에 마일스톤 줄과 같은 얇은 표식으로 그린다(`src/ui/chart/*` 부품 공유, 실행 순서 6). 표식을 누르면 그 파일의 카드(있으면)나 파일 지도로 간다. 새 후보 출처 값·표식 읽기 API는 ARCH-01 §5에 먼저 적는다.
- **선행:** PLAN-52 T-318(사건 색인)·T-309(서버 매핑), Design SCR-45·46에 변경 사건 표식 한 줄(Design 편집). T-319 화면이 없어도 표식은 기록 쪽 시간축에 그린다.
- **검증:** 단위 — 합성 서버 폴더(가짜 문서 3·문장 10, 서버 판 갱신 사건 4) → 후보 10건·표식 4개, 같은 파일을 다시 들여도 후보 0건 추가, 한 파일에 카드 하나로 묶임. 브라우저 — 차트·타임라인에 표식이 카드와 겹치지 않는 얇은 줄로 보이고 표식 수가 기록 수에 더해지지 않음. 실제 서버 파일은 쓰지 않는다(PLAN-52 시험 규칙).
- **완료:** 시험 통과, 같은 파일이 카드로 두 번 보이지 않음, 표식이 기본 보기(남긴 기록만)에서도 보임.

### T-369 AI가 카톡·메일 후보를 PC 안에서 읽어 정리(Q4)

- **기준:** SPEC-17.6 「가져온 원문은 이 PC 밖으로 나가지 않는다」·「팀 공유」, SPEC-17.3 2·5, ARCH-01 §5 「AI 읽기와 공유 경계」. **선행이던 ARCH-01 R-91은 2026-10-19 Q4 결정으로 해소됐다**(같은 날 ARCH-01 반영).
- **변경:** ① `src/ai/agent-connection.ts` `workFolderRule`에서 "source가 kakao·mail인 기록은 읽지 않는다" 구절을 빼고, 원문 폴더(`<ops>/기록/원문`, `RECORD_ORIGINALS`) 금지는 그대로 둔다 — 이 PC의 CLI는 읽기 전용 기록 DB 읽기로 후보 본문을 읽는다. ② AI가 정리한 결과(유형·부위·묶음 제안)는 `record_add`로 `by='ai'`, `state='candidate'`의 '자동 후보'로만 들어가고 AI는 `kept`로 바꾸지 못한다(현행 SPEC-17.3 2·SPEC-17.7 가드 유지). ③ 원문 비전송 가드 유지: 작업 폴더 사본의 kakao·mail 후보 제외(`records-mirror.ts`), 진단 묶음 `forbiddenEntry`, `project-files.ts` `deniedPath`, `workspace-git.ts` `.gitignore`. ④ 사이트 사본: SPEC-17.6은 사람이 거른 기록을 출처와 상관없이 같은 규칙으로 공유하므로, `src/server/records-share.ts` `shareable`의 `source ∈ {kakao, mail}`·`attachments.mail` 제외를 걷어 `kept` 기록의 일곱 필드만 올리고 원문·attachments·후보·`dropped`는 계속 뺀다. ARCH-01 「사이트 사본」 「경계」의 포함 조건(`state='kept'` ∧ `supersededBy` 없음)은 SPEC-17.6에 맞춰 반영됨.
- **검증:** 단위 — `workFolderRule`에 원문 폴더 금지가 남고 kakao·mail 기록 금지 구절이 없음, AI 도구로 넣은 정리 결과가 `candidate`·`by='ai'`이고 `kept` 변경은 거절, kakao 후보가 폴더 사본·진단 묶음·`.gitignore` 대상 밖으로 새지 않음(기존 `records-mirror`·`diagnostics-lines`·`project-files` 시험 유지), `recordsShare`가 kept kakao·mail 기록은 일곱 필드로 포함하고 kakao 후보·dropped는 0건이며 직렬화 항목에 attachments 없음. 통합 — 합성 카카오톡 가져오기 → CLI 턴이 후보를 읽어 정리 → 기록 탭에 '자동 후보'로 보임(가짜 공급자). 실제 대화 원문은 쓰지 않는다.
- **완료:** 위 시험 통과, 원문·거르기 전 후보가 사이트·작업 폴더 사본·진단 묶음 어디에도 없고, 거른 kakao·mail 기록은 켠 프로젝트의 사이트 사본에 오름.

### T-379 SPEC-17 M1 후속(칩 문구·동기화 K 후보·열람자 역할)

2026-10-19 M1 ①로 닫힌 SPEC-17 R-46·R-47·R-48의 코드 후속이다. 웨이브 3과 독립.

- **기준:** SPEC-17.2 `source` 행(`checkout` = 작업 폴더 활동, 화면 이름 '작업 폴더'), SPEC-17.3 표의 동기화·체크아웃 행(K, 동기화는 연결 파일마다 하루 1건 — 그날 첫 Sync), SPEC-17.7 「누가」(열람자 역할은 보기만, 공유 프로젝트 역할이 PC 쪽에 생길 때 함께).
- **변경:** ① 출처 칩 문구: `src/ui/records-api.ts`의 `checkout: '체크아웃'`을 '작업 폴더'로(기록 탭 거르기 칩·행·자세히 칸이 같은 표를 씀). ② 동기화 K 후보: 문서 Sync 저장 경로(요청 완료 경로를 지나지 않음)에 `src/server/record-sources.ts` 훅을 하나 더해 `src/core/record-candidates.ts`의 기존 Sync 규칙(`source='sync'`)을 부르고, 연결 파일마다 엔진 로컬 날짜의 첫 성공 Sync만 후보로 만든다(`sourceKey`로 같은 날 두 번째를 넘김 — 키 모양은 ARCH-01 §5 「`sourceKey` 형식」에 먼저 한 줄). ③ 열람자 역할: 공유 프로젝트 역할(ADR-037)이 PC 쪽에 생기기 전에는 코드 없음 — 생길 때 기록 라우트의 쓰기 권한 검사에 열람자 거절을 더하고 `tests/server/records-routes.test.mjs`에 한 경우를 더한다(이 티켓은 그 때까지 ③만 '대기').
- **검증:** 단위 — 칩 표가 `checkout → '작업 폴더'`, 같은 연결 파일의 같은 날 Sync 3회 → K 후보 1건, 다음 날 Sync → 1건 더, 다른 연결 파일 → 따로 1건, 실패한 Sync → 0건. 브라우저 — `browser-records*.mjs`의 출처 칩에 '작업 폴더'가 보이고 '체크아웃' 문구가 없음.
- **완료:** ①② 시험 통과, ③은 공유 프로젝트 역할 구현과 함께 닫음.

## 실행 순서

1. **웨이브 1(정본 → 자동 후보 → 거르기 → 역추적):** T-320 → T-321 → T-322·T-325(병렬) → T-323 → T-324 → T-326. T-323의 폴더 사본은 PLAN-52 T-31x 뒤 T-331에서 한다.
2. **웨이브 2(차트 → 가져오기 → 사본):** T-327 → T-328 → T-329·T-330(병렬) → T-331 → T-332.
3. **웨이브 3(모델 위):** T-333 → T-334 → T-335 → T-336·T-337 → T-338 → T-339.
4. 웨이브마다 설치본 릴리스에 묶어 내보내고(PLAN-51 루프의 묶음 릴리스 리듬), 다음 웨이브는 앞 웨이브 VERIFY의 P0가 0일 때 시작한다.
5. 규모검토 UX 항목(PLAN-45 보완)은 사용자의 7-3 작업이 끝난 뒤 재검토하므로 이 계획과 순서를 다투지 않는다. PLAN-52(작업 폴더)·PLAN-54(산출물·외부 계정)와는 T-331만 의존한다.
6. 차트 배치·글리프·연결선·시간축 부품(`src/ui/chart/*`)은 PLAN-52 파일 지도(T-318/T-319)와 공유한다 — 먼저 착수하는 쪽이 만들고 다른 쪽이 재사용한다. 뒤에 기록은 파일 지도의 같은 파일 노드에 붙는다.

## 검증 요약

| 층 | 무엇 | 어디 |
|---|---|---|
| 단위 | 체인·상태·역색인·후보 규칙·차트 배치·파서(카카오톡·메일) | `tests/core/records*.test.mjs`, `tests/core/import-*.test.mjs` |
| 서버 | 격리·권한·중복·사본 왕복·공유 경계 | `tests/server/records-*.test.mjs` |
| 화면 | 거르기 키 조작·차트 토글·타임라인 커서·검토본 전환 | `tests/integration/browser-records*.mjs`(합성 fixture 80~120건, 합성 모델) |
| 실사용 | 사용자가 실제 프로젝트 기록으로 동승 1회 | T-338, VERIFY |

fixture의 날짜·부위·문장은 모두 지어낸 값이다. 참고 화면의 실제 프로젝트 문장은 fixture에 쓰지 않는다.

## 위험

- **태깅 부담:** 자동 후보가 많고 질이 낮으면 거르기가 일이 된다. T-322는 후보 생성 조건을 좁게 시작하고(요청 실행·명시적 결정 어휘), 노트는 문단 단위 상한(하루 30건)을 둔다. 후보 질은 T-326에서 '남김 비율'로 잰다.
- **부위 매핑 유지:** 레이어 이름·구조가 바뀌면 매핑이 끊긴다. 끊김을 숨기지 않고 표시하며(T-325), 매핑 없는 기록도 차트의 '부위 없음' 행에 나오게 한다.
- **개인정보:** 카카오톡·메일 원문과 거르기 전 후보는 PC 밖으로 나가지 않는다. 사이트 업로드는 거른 기록 본문만, 기본 끔(T-336). 진단 묶음·저장소 제외를 시험으로 고정(T-331). 이 PC의 AI는 후보를 읽어 정리하되 결과는 자동 후보로만 들어간다(T-369, 2026-10-19 Q4).
- **범위 팽창:** "진짜 BIM"은 끝이 없다. 이 계획은 기록 → 부위 → 영향의 세 보기까지이며, 기록에서 모델을 **바꾸는** 기능(기록을 고치면 형상이 따라오는 것)은 넣지 않는다. 그것은 C-03(편집 가능한 작업 이력)의 영역이다.
- **성능:** 타임라인이 Sync 목록 전체를 읽으면 큰 모델에서 멈춘다. T-333은 `lazy` 독자 규칙을 지키고 T-337에서 측정한다.

## 현재 상태

- 2026-10-19 0.9(사용자 결정, 코드 변경 없음): B1 ①·Q5 ③·Q4 ①과 M1 ①을 받아 SPEC-17(R-46~R-48·R-82~R-85·R-87·R-88 해소, §3 1·5·6, §6)·ARCH-01(R-91·R-92 해소, 「AI 읽기와 공유 경계」)·Design(R-91 등)에 반영했고, 새 티켓 **T-367**(지난 요청에서 자동 후보 한 번)·**T-368**(서버 파일 = 내용 카드 + 변경 사건 표식)·**T-369**(PC 안 AI의 카톡·메일 후보 정리, 거른 기록은 출처와 상관없이 공유)를 더했다. T-369 ④가 따를 ARCH-01 「사이트 사본」 포함 조건 정정은 반영됨. 같은 날 SPEC-17 R-86·R-89도 M1 ①로 적용해(시점 형상은 현재 형상 대신 보임) SPEC-17의 검토 표기가 모두 사라졌고, M1로 닫힌 R-46~R-48의 코드 후속은 **T-379**가 맡는다.
- 2026-10-15 밤 0.8(웨이브 3 구현·오프라인 검수): **T-333~T-336 구현, T-337 측정 완료(모두 기준 안, 고친 코드 없음)** — 부위별 묶음(`src/core/records-scene.ts`), 모델 위 타임라인 띠(`src/ui/records-timeline.tsx`, 뷰포트 `fade`·`highlight`·`offset`), 시점 형상(`src/core/records-moments.ts`·`src/ui/records-moment.ts`, 보기 전용 대체)과 검토본과 함께 기록(`src/server/review-record.ts`), 사이트 사본(`src/server/records-share.ts`·`offline-view.ts`·D1 0018·`src/sharing/summary.ts`). 수정 단계에서 띠와 시점 형상을 잇고, 시점 형상이 요청 기준을 과거 Sync로 바꾸던 문제를 고치고, 측정 5·6(객체 20,000)을 더했다. 검수: [VERIFY-2026-10-15-records-wave-3](../tdd/VERIFY-2026-10-15-records-wave-3.md). 남음: 사이트 배포(D1 0018·Worker, 사용자 T-357과 묶음 — 그 전에는 켠 프로젝트에 경고 한 줄), T-338 사용자 동승, T-339 판정, [분리] 중 공간 입력 좌표(P2), 사용자 결정 SPEC-17 R-86~R-89·ARCH-01 R-91·R-92·Design R-91·SPEC-03 R-23.
- 2026-10-15 밤 0.8: 웨이브 3 착수(워크플로) — 구현 계약을 ARCH-01 1.40 §5 「프로젝트 기록」(부위별 묶음·뷰포트 표시 API·타임라인 띠·시점 형상·검토본과 함께 기록·사이트 사본·성능 측정 표)과 Design 1.28 SCR-46 「구현 기준」에 먼저 적고, T-333~T-339에 '구현 계약' 줄을 더했다. 정한 것: 묶음은 클라이언트 계산(새 라우트 없음), 에피소드는 장·이어진 기록, 시점 형상은 대체 표시, 사이트 사본은 할 일 사본 방식·D1 0018·카카오톡·메일 제외. 미결: SPEC-17 R-86(겹침 문구)·R-87(검토본 기록의 출처 값)·R-88(공유 경로 문구), ARCH-01 R-91.
- 2026-10-15 밤 0.7: **T-327~T-331 구현, T-332 오프라인 검수** — 차트(`src/core/records-chart.ts`·`src/ui/records-chart.tsx`), 카카오톡·메일 가져오기(`src/core/import/`·`src/server/records-import.ts`·`src/ui/records-import.tsx`), 폴더 사본(`src/server/records-mirror.ts`·`src/ui/records-mirror-line.tsx`). 검수: [VERIFY-2026-10-15-records-wave-2](../tdd/VERIFY-2026-10-15-records-wave-2.md). 리뷰에서 나온 P0 2건을 고쳤다. 하나는 되들이기가 이 PC가 마지막으로 쓴 행과 비교해 사람이 바꾼 필드만 반영하게 한 것이고, 다른 하나는 거르지 않은 kakao·mail 후보를 사본에서 뺀 것이다(ARCH-01 1.39). 함께 고친 것: 가져오기 문구를 Design SCR-45에 맞춤, PC 카카오톡의 '삭제된 메시지입니다.' 제외, `browser-records-import.mjs`를 `test:browser`에 등록, `GET /records/mirror`는 기다리는 쓰기가 있을 때만 씀, `addMany` 직접 시험. 티켓 상태: T-327·T-328·T-329·T-330·T-331 구현 완료(오프라인), T-332 오프라인 부분 완료. 남은 결정: SPEC-17 R-82(작성자 거르기)·R-83(차트 읽기 전용 문구)·R-84(메시지 단위 문구)·R-85(일부 중복 건너뜀), ARCH-01 R-91(기록 DB의 AI 읽기에서 가져온 후보 빼기), 커서 뒤 35% 흐림을 Design에 둘지. 후속: `src/knowledge/collect/mail.ts`(SPEC-08.9 자료 수집)와 `src/core/import/mail.ts`의 MIME 읽기를 하나로 합치기(`readMail(buffer)`를 `parseMail(text)` 위 어댑터로; 합칠 때 ARCH-01의 'node 의존 없음'을 고침). 실제 대화·메일 파일, 실제 작업 폴더 화면, A3 실제 인쇄는 사용자 동승.
- 2026-10-15 밤 0.6: 웨이브 2 착수(워크플로) — 구현 계약을 ARCH-01 1.38 §5 「프로젝트 기록」(가져오기·사본·차트)과 Design 1.27 SCR-45 「구현 기준」에 먼저 적고, T-327~T-331에 '구현 계약' 줄을 더했다. 미결: ARCH-01 R-91(가져온 후보의 AI 읽기 제외).
- 2026-10-15 밤 0.5: **T-321~T-325 구현, T-326 오프라인 검수** — 저장·API·자동 후보·기록 탭·'이 객체의 기록'·부위 사전(각 티켓의 '구현' 줄). ARCH-01 1.35에 구현이 정한 물리 세부를 반영했다. 검수: [VERIFY-2026-10-15-records-wave-1](../tdd/VERIFY-2026-10-15-records-wave-1.md)(합성 요청 10·노트 5·설정값 3 → 후보 19건 중복 0, O/X·부위·객체→기록 통과). 남은 것: 설치본에서 기록 탭 15분 확인(사용자), 100건/10분 측정, SPEC-17 R-46~R-48 결정(폴더 역할 확정 출처 값, 동기화 K 후보 연결 조건, 열람자 역할), SPEC-17.3 표 행 7·8(갱신 제안 카드·자료 [기록으로 남기기])의 티켓 배정, 웨이브 2(T-327~).
- 2026-10-15: 계획만. 사용자 결정(1차 범위 = 3D 타임라인까지, 세 웨이브로 출하) 반영. SPEC-17·Design SCR·PRD C-09 번호는 미작성. 코드 변경 없음.
- 2026-10-15 저녁 0.4: **T-320 완료** — SPEC-17 0.2(자료 확정의 [기록으로 남기기] E 후보 행 추가), Design 1.23(SCR-44·45·46, §07 용어 행 '기록·후보·남김·뺌·부위·이어진 기록·마일스톤'), ARCH-01 1.34 §5 「프로젝트 기록(PLAN-53, SPEC-17)」(표 다섯·sourceKey·attachments·라우트·코드·후보 진입점·사본·D1 0018)과 §1.3 API 행, SPEC-03 0.7(3.8·3.9 역참조), SPEC-08 0.8(8.5 경계 항목). 남은 결정은 아래 「결정이 필요한 질문」과 SPEC-17의 사용자 검토(`review`). 다음: T-321 → T-322·T-325 → T-323 → T-324 → T-326(웨이브 1 워크플로).
- 2026-10-15 오후 0.3: [SPEC-17](../specs/SPEC-17-project-records.md) 0.1(review) 신설 — 유형 R 요구·I 의도·K 앎·E 근거·D 결정, 후보→O/X 확정, 정정은 덧붙임(append-only), 차트·타임라인 기본은 남긴 기록만, 팀 공유 기본 끔. 기록 사본은 PLAN-52 역할 목록을 늘리지 않고 `ops` 역할의 `기록/` 하위에 둔다. 남은 선행: Design SCR(기록 탭·차트·타임라인), ARCH-01 표·API, SPEC-03.8/3.9·SPEC-08.5 역참조(T-320). 코드 변경 없음.

## 결정이 필요한 질문

1. **기록 탭의 위치:** 왼쪽 레일의 새 탭인지, 자료(SPEC-08) 탭 안의 보기인지. 기본안은 새 탭 '기록'(자료는 '찾은 사실', 기록은 '판단'으로 구분).
2. **D 후보의 자동 생성 범위:** 바뀐 객체가 있는 모든 요청을 D 후보로 만들지("기둥 색 바꿔"도 D가 됨), 아니면 되돌리지 않고 다음 날까지 남은 요청만 후보로 할지. 기본안은 전부 후보로 만들고 거르기에서 X.
3. **사이트 공유 기본값:** T-336의 '거른 기록만 올리기'를 기본 끔으로 둘지, 프로젝트 구성원이 있으면 기본 켬으로 할지. 기본안은 끔.
