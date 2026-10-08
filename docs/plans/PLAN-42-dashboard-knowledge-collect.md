---
id: PLAN-42
title: 대시보드 배치 조정·기본 모델 Jev·프로젝트 폴더 자료 정리와 일정 제안 (T-192~T-196, T-261)
status: review
version: 0.5
updated: 2026-10-08
owner: agent:claude
related: [SPEC-01, SPEC-08, SPEC-02, ARCH-01, DESIGN, PLAN-08, PLAN-39, SPIKE-2026-09-29-knowledge-crawl, RESEARCH-06, FR-01, FR-09, FR-16, C-02]
---

# 대시보드 배치 조정·기본 모델 Jev·자료 정리와 일정 제안

2026-10-07 사용자 요청이다.

**상태(2026-10-08):** T-192~T-196 구현함. T-261(걸러내기 전 규칙·데이터 파일·환경 폴더·정리 전 확인과 빼는 폴더) 구현·시험 완료 — 아래 「T-261」.

- **대시보드:** "캘린더가 왼쪽으로 오고, 할일이 오른쪽으로". "캘린더 폭을 좀 줄이고, 할일이 좀 더 넓게 … 할일 아래에 연결 파일/프로젝트 폴더 설정 가능하도록. 섹션을 좀 나누면 좋을 듯". "일정에 시간 입력할 때 15분 단위로 선택하도록". "할일에 AI 표기 필요없음". "이 페이지에서도 섹션 넓이 조절 가능하도록(AI 채팅창, 달력, 할일 탭 넓이)".
- **AI 채팅:** "기본 모델(default)는 jev로 설정".
- **프로젝트 DB:**
  - "대시보드에서 프로젝트 폴더 설정했으면, 그 폴더에 있는 자료 정리하기 기능 … 초기에 한번 만들고, 업데이트되면 해당 파일들 추가로 반영해서 DB 만드는 식으로".
  - "AI 모델은 기본적으로는 opus 5.5 medium에 여러 에이전트(sonnet, haiku, opus 등 사용)를 울트라코드로 뿌려서 빠르게. 만약 claude가 연결 안되어있으면 gpt sol로 실행하도록".
  - "일정표나 회의록 같은 것들에서 할일이나 일정 추가할거 있으면 사용자 컨펌 받고 대시보드에 자동으로 추가".

앞선 작업과의 관계:

- 대시보드 배치 '안 A'(할 일 | 달력)는 [PLAN-39](PLAN-39-dashboard-calendar.md) T-181이다. 이번에 그 순서와 폭을 바꾼다.
- 자료 DB 구축 과정은 [SPIKE-2026-09-29-knowledge-crawl](../tdd/SPIKE-2026-09-29-knowledge-crawl.md)에서 실험했다(`tools/spikes/2026-09-29-knowledge-crawl/`). 이번에 앱 안 수집기(PLAN-08 K1·K2의 백로그 부분)로 옮긴다.
- 자료를 읽는 쪽(자료 탭, `vide/project-facts`)은 [SPEC-08](../specs/SPEC-08-project-facts.md)과 `src/jigs/knowledge.ts`가 이미 있다.

## 같은 날 정한 기본값

1. **'울트라코드'의 뜻.** 한 Claude 세션이 하위 에이전트를 부리는 방식이 아니라, 엔진이 단계를 나눠 여러 CLI 호출을 병렬로 띄운다.
   - 배정: 걸러내기는 Haiku, 진술 추출은 Sonnet(병렬), 이슈 정리와 일정·할 일 제안은 Opus 5.5 medium.
   - 이유: 진행률·중단·다시 실행을 엔진이 쥐고, 이미 정리한 파일은 다시 보내지 않는다. 비대화 CLI(`claude -p`)에서 하위 에이전트 도구가 늘 있다는 보장도 없다.
2. **Claude가 없을 때.** Claude CLI에 로그인되어 있지 않으면 모든 AI 단계를 Codex의 Sol 계열 최신 모델로 돌린다. 모델은 Codex 모델 목록에서 이름이 `-sol`로 끝나는 첫 모델이다(2026-10-07 기준 `gpt-6.1-sol`). 노력 단계는 걸러내기 low, 나머지 medium이다.
3. **파이썬 없이, 한글·PDF·도면까지(같은 날 범위 변경).** 설치본은 파이썬을 가정하지 않는다. 문서 추출은 Node 안에서 한다([RESEARCH-06](../research/RESEARCH-06-project-knowledge.md) §7.7 대안 C): 글·md·csv, 메일(eml), docx·xlsx·pptx·hwpx(zip 안 XML, xlsx는 열 자리와 첫 행 유지), HWP 5.x(복합 파일의 본문 레코드), PDF 글자층(`pdfjs-dist`, 쪽마다 `p.N`). kordoc은 선택 의존성(onnxruntime 등)이 설치본에 무거워 쓰지 않는다. 글자가 없는 PDF는 '글자 없음(스캔)', 배포용·암호 HWP와 암호 문서는 '배포용'·'암호', 옛 형식(doc·xls·ppt)은 '옛 형식'으로 세고 넘어간다(OCR 없음). DWG 문자는 바뀐 도면의 사본을 VIDE 데이터 폴더에 두고 엔진이 띄운 숨은 ZWCAD 하나가 읽은 뒤 그 프로세스만 끈다(실험의 `dwg.mjs` 방식, 사용자의 ZWCAD는 건드리지 않음). ZWCAD 2023이 없으면 '읽지 못함(ZWCAD 없음)'이다. 파일마다 시간 제한과 결과 상태(완료·건너뜀(크기)·암호·글자 없음·오류)를 자료 행에 남기고, 한 파일의 실패가 정리를 멈추지 않는다.
4. **원본은 읽기만.** 프로젝트 폴더의 파일은 쓰거나 옮기지 않는다. DB는 VIDE 데이터 폴더의 프로젝트 자료 DB 자리(실험과 같은 `knowledgePath`)에 둔다. 실험 DB와 같은 표를 쓰므로 이미 만든 DB는 이어서 갱신된다.
5. **사람이 누를 때만(같은 날 범위 변경, "모델링하는 동안 컴퓨터가 느려질 수 있음").** 자동 갱신은 없다. 첫 정리는 [자료 정리하기], 그 뒤에는 같은 자리의 [자료 업데이트]를 누를 때만 폴더 목록과 크기·수정 시각을 보고 바뀐 파일만 다시 정리한다. 엔진 하나에서 한 프로젝트당 한 번에 하나만 돈다.
6. **일정·할 일 제안.** 새로 정리한 진술 중 날짜가 있는 결정·요청·조건(회의록·일정표·메일)에서 Opus가 할 일·일정 후보를 만든다.
   - 후보는 대시보드에 '자료에서 찾은 할 일·일정 n건'으로 뜬다.
   - 사람이 고른 것만 넣는다(`source: 'ai'`). 버린 후보는 다시 제안하지 않는다.
   - 이 경로는 SPEC-01.14 6의 "요청하지 않은 할 일을 AI가 먼저 넣지 않는다"를 지킨다: 넣기 전에 사람이 확인한다.

## T-192 대시보드 배치 — 달력 | 할 일·연결 파일·프로젝트 폴더, 폭 조절

| 변경 | 위치 |
|---|---|
| 왼쪽 달력, 오른쪽 열: 할 일 → 연결 파일 → 프로젝트 폴더 구역(각각 제목 있는 구역, 접힌 한 줄 없앰). 오른쪽 열 기본 폭은 지금보다 넓게(기본 420px) | `src/ui/dashboard.tsx`, `src/ui/dashboard-agenda.tsx`, `src/ui/dashboard.css` |
| 달력과 오른쪽 열 사이 끌기 손잡이(키보드 ←/→·Home), 폭은 이 브라우저에 기억 | 같은 곳 |
| 오른쪽 AI 열의 폭 손잡이가 대시보드와 다른 탭 화면에서도 보이게(지금은 탭 화면 CSS가 숨김) | `src/ui/dashboard.css`, `src/ui/notes-tab.css`, `src/ui/facts-tab.css`, `src/ui/make.css`, `src/ui/output-tab.css`, `src/ui/reference-tab.css` |
| 일정 폼의 시각 칸을 15분 단위로 고르는 목록으로 | `src/ui/dashboard-agenda-form.tsx` |
| 할 일 행의 'AI' 표기 제거(원본 기록 `source`는 그대로) | `src/ui/dashboard-agenda.tsx` |

**검증:** `tests/integration/browser-dashboard-agenda.mjs` 갱신: 달력이 왼쪽, 할 일이 오른쪽, 할 일 아래에 연결 파일·프로젝트 폴더 구역, 손잡이로 폭이 바뀌고 다시 열어도 유지, AI 열 손잡이가 대시보드에서 보임, 시각 목록 값이 15분 단위, 'AI' 표기 없음. 회귀: `browser-project-folders.mjs`, `browser-workspace-tabs.mjs`, `browser-workspace-controls.mjs`.

**결과(2026-10-07):** 구현·시험 완료. 오른쪽 열은 `AgendaBoard`의 `aside`로 할 일 아래에 연결 파일·프로젝트 폴더 구역을 받고, 손잡이는 `src/ui/dashboard-split.tsx`(기본 420px, 300px~달력 520px을 남기는 폭, `vide:dashboard-side-width`에 기억)다. 접힌 줄(`details.dash-more`)은 없앴다. AI 열 손잡이는 여섯 탭 화면 CSS에서 `.panel-resize-right`를 숨기지 않게 했다. 시각은 '—'와 15분 단위 96개의 선택 칸이며 15분 단위가 아닌 기존 값은 목록에 덧붙여 보존한다. `browser-dashboard-agenda.mjs`(배치·끌기·←/→·다시 열기 유지·Home·AI 열 손잡이·시각 목록·'AI' 없음)와 회귀 `browser-project-folders.mjs`·`browser-workspace-tabs.mjs`·`browser-workspace-controls.mjs`·`browser-react-panels.mjs` 통과.

## T-193 기본 모델 Jev

| 변경 | 위치 |
|---|---|
| 새 초안과 첫 화면의 모델은 '자동 (Jev)'. 저장된 초안의 사용자 선택과 고정된 대화의 모델은 그대로 | `src/ui/model.ts`, `src/ui/app/composer.ts` |
| 초안이 없는 새 대화 탭은 앞 탭의 모델이 아니라 '자동 (Jev)'으로 시작 | `src/ui/app/composer.ts` (`switchDraft`) |

**검증:** 브라우저 시험 하나(새 프로젝트 첫 화면의 모델 메뉴 값이 `auto`, 새 대화 탭도 `auto`, 사용자가 고른 모델은 새로고침 뒤 유지).

**결과(2026-10-07):** 구현·시험 완료. 카탈로그 전의 자리 모델을 '자동 (Jev)'로 바꾸고 `defaultModel()`(목록에 `auto`가 없으면 첫 모델)을 새 초안과 초안 없는 탭(`switchDraft`)에 쓴다. 이미 저장된 초안의 모델(이전 기본값 Claude Opus 5.5 포함)은 사용자 선택으로 보고 그대로 둔다. `tests/integration/browser-default-model.mjs`(첫 화면 `auto`, 고른 모델 새로고침 뒤 유지, 새 대화 탭 `auto`, 앞 탭 선택 유지, `auto` 없는 목록은 첫 모델) 통과, `test:browser`에 더함. 회귀 `browser-conversations.mjs`·`browser-account-catalog.mjs` 통과.

## T-194 자료 정리 엔진 — 첫 정리와 바뀐 파일 반영

| 변경 | 위치 |
|---|---|
| 단계: 목록·해시(크기·수정 시각이 같으면 건너뜀) → 문서 추출(Node, 작업 스레드에서 파일마다 시간 제한) → 도면 추출(숨은 ZWCAD) → 같은 문장 합치기 → 걸러내기(Haiku) → 진술 추출(Sonnet, 병렬) → 이슈 정리(Opus medium) → 일정 제안(T-196). 바뀌거나 새로 생긴 파일의 발췌만 AI로 보내고, 지워진 파일의 진술은 숨긴다 | 새 `src/knowledge/collect/`, 도면 `hosts/zwcad/knowledge-dwg.ts`·`hosts/zwcad/worker/KnowledgeDwg.cs` |
| AI 호출: Claude CLI(`claude -p`, 도구·MCP 없음, 모델·노력 지정) 병렬 실행, 없으면 Codex Sol. 호출 수·토큰·시간을 DB `run` 표에 | 같은 곳, 기존 `src/ai/claude-cli.ts`·`src/ai/codex-cli.ts`의 실행 인자 재사용 |
| 정리 상태(대기·진행 단계·처리 수·마지막 완료·오류) API와 시작·중단. 자동 실행 없음(기본값 5) | `src/server/collect-routes.ts`, `src/server/server.ts` |
| 자료 탭이 새 DB를 바로 읽는다(표는 실험과 같음) | `src/jigs/knowledge.ts`는 바꾸지 않는 것이 목표 |

**검증:** 합성 폴더(글·md·eml·docx·xlsx·pdf 몇 개, 시험 안에서 만듦)로 첫 정리 → 진술·이슈가 생김. 파일 하나를 고치고 다시 → 그 파일만 다시 추출·AI 호출. 파일을 지우면 그 진술이 검색에서 빠짐. AI 호출은 가짜 실행기로 바꿔 끼워 시험한다. 실제 CLI로는 `.vide/` 아래 사본 폴더에서 한 번 돌려 시간·호출 수를 기록한다.

**결과(2026-10-07):** 구현함. 자료 DB 표는 실험과 같고 `source.status`(파일별 결과)·`statement.status`/`held_prob`·`agenda_proposal`만 더했다. 지운 파일의 진술은 `support_prob = -1`로 숨겨 자료 탭·AI 도구·사이트 사본이 고치지 않고 뺀다(`src/jigs/knowledge.ts` 변경 없음). 수집 대상은 `project` 폴더만이다(읽기 허용 폴더는 AI 읽기 권한일 뿐 프로젝트 자료가 아님). 폴더가 여럿이면 공통 상위 폴더를 `meta.root`로 두고, 드라이브가 다른 폴더는 빼고 알린다. 사이트에서 받은 사본 DB(`meta.vide_copy`)에서는 정리하지 않는다(`KNOWLEDGE_IS_COPY`). `pdfjs-dist@5.7.284`를 `package.json`·잠금 파일에 더했다(이 작업 트리에서는 설치하지 못해 실제 설치는 다음 `npm install`; 없으면 PDF는 '읽지 못함(PDF 모듈 없음)'). HWP 5 복합 파일 읽기는 의존성 없이 직접 작성했다. 시험: `tests/core/knowledge-collect.test.mjs` 8개(PDF 시험은 pdfjs가 없으면 건너뜀, 따로 설치한 pdfjs로 통과 확인), `tests/server/knowledge-collect.test.mjs` 1개. 실제 CLI 시험(`.vide/` 합성 폴더 2개 파일, 모든 단계 Haiku): AI 호출 7번, 걸러내기 11.0초·진술 69.0초(1번, 출력 약 1.2만 토큰)·이슈 30.6초(4번)·제안 10.6초(1번), 합계 약 121초, 진술 3·이슈 1·제안 1. 실제 ZWCAD 2023 시험: 숨은 ZWCAD로 합성 도면을 만들고 읽기 명령으로 문자 2개를 읽음(시작 포함 8.9초), 뒤에 남은 ZWCAD 프로세스 없음.

## T-195 자료 정리 화면

| 변경 | 위치 |
|---|---|
| 프로젝트 폴더 구역에 [자료 정리하기](한 번 정리한 뒤에는 [자료 업데이트])·진행 표시(단계·n/m)·마지막 정리 시각·[중단]. 폴더가 없으면 단추를 숨긴다. 원격 세션은 보기만 | `src/ui/project-folders.tsx`, 새 `src/ui/knowledge-collect.tsx`·`knowledge-collect.css` |
| 다 끝나면 자료 탭 수와 이슈가 새로 읽힌다 | `src/ui/facts-tab.tsx` 등 |
| 보완(2026-10-08 사용자 보고 "DB 정리도 지금 vide에서는 안 보이는데"): 폴더가 없을 때와 상태를 읽지 못할 때도 줄을 숨기지 않고 이유·행동([폴더 정하기]·[다시 읽기])을 보인다. 자료 탭(과 자료 jig)에 자료 DB가 없으면 옛 안내('시험판에서는 수집을 앱 밖에서') 대신 같은 자료 정리 줄을 보인다(폴더가 없으면 [대시보드에서 폴더 정하기]) | `src/ui/knowledge-collect.tsx`, `src/ui/project-folders.tsx`, `src/ui/facts-tab.tsx`, `src/ui/knowledge-jig.tsx` |

**검증:** 브라우저 시험(가짜 실행기 엔진): 폴더 추가 → [자료 정리하기] → 진행 → 완료 시각, 자료 탭에 진술이 보임.

**결과(2026-10-07):** 구현함. 정리가 끝나면 `vide:knowledge-collected` 알림으로 자료 탭과 제안 카드가 다시 읽는다. 끝난 뒤 '문서 n/m · 진술 · 이슈 · 읽지 못함: 이유별 수'를 보인다. 시험: `tests/integration/browser-knowledge-collect.mjs`(`test:browser`에 더함) 통과.

## T-196 자료에서 찾은 할 일·일정 제안

| 변경 | 위치 |
|---|---|
| 정리마다 새 진술에서 Opus가 후보(제목·종류·날짜·시각·끝·위치·참석자·근거 진술)를 만들고 제안 표에 둔다. 이미 있는 할 일·같은 후보·버린 후보는 빼고, 지난 날짜는 제안하지 않는다 | `src/knowledge/collect/`, 엔진 DB 또는 자료 DB의 제안 표(ARCH-01에 기록) |
| 대시보드 할 일 구역 위 '자료에서 찾은 할 일·일정 n건': 펼쳐 항목마다 고르기·고치기, [고른 것 추가]·[버리기]. 근거 진술은 진술 창으로 연다 | `src/ui/dashboard-agenda-extract.tsx`의 확인 화면 재사용 |

**검증:** 단위: 후보 중복 제거·버린 후보 재제안 없음·지난 날짜 제외. 브라우저: 후보 두 건 중 하나만 추가 → 할 일·달력에 그 하나만, 다시 정리해도 버린 것은 안 뜸.

**결과(2026-10-07):** 구현함. 제안 표는 자료 DB의 `agenda_proposal`이다(정리 결과와 함께 생기고 지워지며, 엔진 DB 마이그레이션이 필요 없음). 같은 날짜에 한쪽 내용이 다른 쪽을 품으면 같은 항목으로 보고, 근거 진술이 없는 후보와 지난 날짜는 버린다. 카드는 할 일 구역의 [글·파일에서 할 일 만들기] 아래에 있고, 항목마다 고르기·[고치기](내용·종류·날짜·시각)·근거(진술 창)가 있다. 경로: `GET …/agenda-proposals`, `POST …/agenda-proposals/add {items}`(보통의 할 일 더하기, `source: 'ai'`), `POST …/agenda-proposals/dismiss {ids}`. 단위·HTTP·브라우저 시험 통과.

## T-261 걸러내기 전 규칙·데이터 파일·환경 폴더·정리 전 확인

2026-10-08 실제 정리 점검(읽기 전용): '걸러내기 n/N'의 N은 Haiku에 40개씩·4개 동시로 보내는 고유 발췌 수이고 26,680개(호출 약 667번, 1~2시간)였다. 94%가 몇 MB짜리 한 줄 수치 .txt(숫자·기호 94~97%; 마침표·줄바꿈이 없어 `chunk()`가 600자마다 자름)와 큰 수치 .csv에서 나왔고, 약 3,300개는 도구 폴더 아래 파이썬 환경(`.venv`·`site-packages`·`Lib`)의 라이선스·메타데이터 글이었다. Haiku는 약 96%를 'none'으로 판정했다. 실제 문서(PDF·md·DWG·회의록)는 약 450개였다. 기준은 [SPEC-08.9](../specs/SPEC-08-project-facts.md) 2·3·5·6, 화면은 Design SCR-20 「정리 전 확인」이다.

| 변경 | 위치 |
|---|---|
| 규칙 판정: 공백 빼고 8자 미만은 '짧은 글(규칙)', 숫자·기호가 대부분인 발췌는 '숫자·데이터 조각(규칙)'으로 AI 없이 `none`. 이유는 `selection.reason`(새 열) | 새 `src/knowledge/collect/filters.ts`, `stages.ts`(`selectExcerpts`), `schema.ts` |
| 데이터 파일: 4K자(`DATA_FILE_MIN_CHARS`) 이상인 txt·csv의 앞 64K자가 수치 덤프이거나, 32K자 넘는 한 줄이 있고 글자 비율이 낮으면 상태 `data`로 첫 5줄(줄마다 200자)을 발췌 하나(`kind = 'data'`)로 남기고, 파일 전체를 자른 발췌 가운데 데이터 조각이 아닌 것(문장이 든 것)도 남김. `data` 파일의 첫 줄 발췌는 AI에 가지 않고 문장 발췌는 감(`stages.ts` `live`) | `filters.ts`, `documents.ts`, `stages.ts` |
| 다시 읽기: `source.reader`(새 열)에 txt·csv 읽기 판 `TEXT_READER_VERSION`(2)을 남기고, 그보다 낮거나 없으면 바뀌지 않았어도 다음 정리에서 다시 읽음(`extract.ts` `STALE_READER`). 확인도 그 파일을 새로 읽을 파일로 셈 | `filters.ts`, `extract.ts`, `schema.ts`, `survey.ts` |
| 파일당 발췌 상한: 글(txt·md·csv·eml) 200개, 그 밖 문서 1,000개. 넘친 수는 `source.excerpt_overflow`(새 열). 남기는 쪽은 발췌의 첫 날짜 순서로 정함: 오름차순이 내림차순의 2배 이상이면 뒤쪽, 반대면 앞쪽, 날짜 쌍이 3개 미만이거나 섞이면 앞·뒤 절반씩(`dateOrder`) | `filters.ts`, `documents.ts`, `extract.ts` |
| 자르기: 긴 문단은 뒤 절반의 마지막 '. '·줄바꿈, 없으면 뒤 절반의 마지막 공백, 그것도 없으면 1,200자에서 자름(전에는 600자). 문장이 있는 글은 그대로. 시트 첫 행(발췌마다 붙는 머리)은 300자(`CHUNK_HEAD_MAX`)까지만 붙여 머리가 1,200자 이상인 시트에서도 멈추지 않음 | `documents.ts` `chunk` |
| 걷지 않는 폴더: 생성(`.git`·`.svn`·`.hg`·`node_modules`·`bower_components`·`.vide`·`$recycle.bin`·`system volume information`·`__macosx`·`.gradle`·`.next`·`.nuxt`·`.parcel-cache`·`.turbo`), 환경·캐시(`.venv`·`__pycache__`·`site-packages`·`dist-packages`·`.tox`·`.nox`·`.mypy_cache`·`.pytest_cache`·`.ruff_cache`·`.ipynb_checkpoints`·`.conda`·`*.dist-info`·`*.egg-info`), 그리고 안에 `pyvenv.cfg`·`conda-meta`·(`python.exe`와 `Lib`)가 있는 폴더 | `inventory.ts` (`skipDir`·`isEnvironment`·`listFiles`) |
| 정리 전 확인: 읽을 파일(종류별)·그대로인 파일·지난 정리에서 읽고 아직 걸러내지 않은 발췌(`pending`, 규칙으로 정해질 것은 빼고 셈)·건너뛰는 것(이유별)·발췌와 걸러내기 호출·시간의 대략값(`pending` 포함)·발췌가 많은 폴더 8개. 대략값은 크기 기준(글 2KB·PDF 40KB·오피스·한글 10KB당 발췌 하나, 메일 2개, 도면 5개, 상한 적용), 호출 = 발췌/40, 시간 = 호출/4×25초. 정리 중 상태(`survey`)에도 같은 값 | 새 `src/knowledge/collect/survey.ts`, `collector.ts` |
| 빼는 폴더: 프로젝트마다 자료 DB 옆 `<DB 이름>.collect.json`에 절대 경로로 기억, 프로젝트 폴더 안 하위 폴더만. 이미 기억한 경로가 프로젝트 폴더 밖이 되면 확인에 보이지 않고 다음 저장 때 지움(새로 보낸 밖 경로만 400). 경로: `GET …/knowledge/collect/survey`, `POST …/knowledge/collect/exclude {exclude}`(둘 다 이 PC에서만) | `collector.ts`, `src/server/collect-routes.ts` |
| 화면: 단추 → 확인 상자([빼기]·[다시 넣기]·[닫기]·[시작]), 정리 중 요약 줄, 끝난 줄의 데이터 파일·상한 수 | `src/ui/knowledge-collect.tsx`·`.css` |

**규칙 값(이름 있는 상수, `filters.ts`):** 이름표(`isLabel`)는 글자가 든, 숫자가 아닌 토큰(`1층`·`B1`·`RF`·`D10`·`101호`, 한 글자도 됨)이거나 날짜·시각(`10/15`·`2026-03-02`·`14:00`)이다. 문장 줄(`proseLine`)은 표 행(`|`·탭, 공백 없는 쉼표 2개 이상)이 아니고 글자 `DATA_PROSE_MIN_LETTERS` 10자 이상, 글자 비율 `DATA_PROSE_MIN_LETTER_RATIO` 0.5 이상인 줄이다. 문장 줄이 하나라도 있으면 데이터 조각이 아니다. 그 밖에 발췌의 글자(`\p{L}`) 비율 < `DATA_MIN_LETTER_RATIO` 0.12 이고 이름표가 있는 행의 비율 < `DATA_MIN_LABELLED_LINES` 0.5 이면 데이터 조각. 또 토큰 12개 이상(`DATA_REPEAT_MIN_TOKENS`), 서로 다른 이름표 2개 이하(`DATA_REPEAT_MAX_WORDS`), 숫자 토큰 70% 이상(`DATA_REPEAT_MIN_NUMERIC`)이면('POINT 1 2 3' 반복) 데이터 조각. 데이터 파일은 앞 `DATA_FILE_SAMPLE_CHARS` 64K자에 같은 판정을 하거나, `DATA_FILE_LONG_LINE` 32K자 넘는 줄이 있고 표본의 글자 비율이 `DATA_FILE_LONG_LINE_MAX_LETTERS` 0.5 미만일 때다. 행마다 '지하1층 | 기계실 | 987.65 …'처럼 이름표가 붙은 면적표는 숫자가 많아도 통과한다.

**검증:** `tests/core/knowledge-collect-filters.test.mjs`(회의록·한글 이름표 면적표·좌표 덤프·머리만 글인 숫자 csv 판정과 상수, 데이터 파일 첫 줄, 상한, 자르기, 환경·생성·뺀 폴더, 확인 대략값, 정리에서 AI로 가는 글과 `selection.reason`), `tests/server/knowledge-collect.test.mjs`(확인·빼기 경로, 잘못된 경로 400, 빼기 유지·되돌리기), `tests/integration/browser-knowledge-collect.mjs`(확인 상자·[빼기]·[시작]·정리 중 요약·끝난 줄의 데이터 파일). 회귀: `tests/core/knowledge-collect.test.mjs`.

**검토 뒤 보완(2026-10-08):** 커밋 09926d25 검토에서 확인된 결함을 고쳤다. ① 이름표를 글자 2개 이상 낱말로만 봐서 `1층`·`B1`·`RF`·`PH`·`D10`·`101호`와 날짜 행의 면적표·레벨표·견적서·일정 메모가 규칙으로 버려짐 → 이름표 기준 변경. ② 작은 csv·txt 표도 `data`가 되어 첫 5줄 뒤 행이 저장되지 않음 → 4K자 미만은 데이터 파일 아님. ③ 상한이 앞 200개만 남겨 아래로 덧붙인 회의록의 최신 회의가 빠짐 → 날짜 순서로 남길 쪽 결정. ④ 결정 문장과 좌표가 한 발췌에 묶이면 문장도 버려지고, 64K자 넘는 덤프 txt 끝의 결론 문장이 사라짐 → 문장 줄 규칙과 데이터 파일의 문장 발췌 유지. ⑤ 확인이 중단된 정리의 미판정 발췌를 세지 않아 '호출 약 0번'과 빈 폴더 목록을 보임 → `pending`. ⑥ 전에 읽은 수치 덤프가 `done`으로 남음 → `reader` 판. ⑦ 프로젝트 폴더 밖이 된 뺀 폴더가 모든 [빼기]를 400으로 막음 → 무시·삭제. ⑧ 머리가 1,200자 이상인 시트에서 `chunk()`가 멈춤 → 머리 300자. 같은 날 다른 드라이브·공유 폴더도 정리하는 변경(fe2cdba7)과 합치며, 걷기 결과는 기록 경로(`rel`)와 폴더 아래 경로(`local`)를 함께 갖고 확인의 폴더 묶음·[빼기] 경로도 다른 드라이브 폴더에서는 절대 경로를 쓴다. 시험: `tests/core/knowledge-collect-labels.test.mjs`.

**결과(2026-10-08):** 구현·시험 완료. 점검 결과를 닮은 합성 폴더(3 MB 한 줄 좌표 덤프 5개, 4 MB 수치 csv, 도구 `.venv` 패키지 400개의 라이선스·안내 글, 회의록 md 40개, 면적표 csv 6개)에서 바꾸기 전 코드는 AI로 가는 고유 발췌 30,407개(걸러내기 호출 약 761번: 덤프 24,950·csv 3,411·환경 2,000·회의록 40·면적표 6), 바꾼 뒤에는 46개(호출 2번; 데이터 파일 6·환경 폴더 1 건너뜀)다. 확인의 대략값도 발췌 약 46개·호출 약 2번이었다. 사용자의 진행 중 정리·설치본·DB·프로젝트 폴더는 건드리지 않았다. 실제 프로젝트 폴더에서의 효과는 다음 [자료 업데이트] 때 확인한다.

## 문서

- SPEC-01.14: 배치·시각 단위·제안 확인 경로.
- SPEC-08: 새 절 '자료 정리'.
- Design: §03 대시보드 절들과 SCR-20.
- ARCH-01 §3: 자료 정리 상태·제안 표, 수집기 위치.

## 완료 판단

T-192~T-196의 시험과 `npm run verify`를 통과한다. 실제 프로젝트 폴더 사본으로 첫 정리·갱신 시간과 호출 수를 VERIFY에 남긴다. 배포는 사용자 지시 뒤다.
