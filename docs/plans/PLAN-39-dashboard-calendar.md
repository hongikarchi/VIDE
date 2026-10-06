---
id: PLAN-39
title: 대시보드 일정 — 기간·종류 넷·위치·참석자·큰 달력 (T-180~T-183)
status: draft
version: 0.1
updated: 2026-10-06
owner: agent:claude
related: [SPEC-01, SPEC-04, ARCH-01, DESIGN, PLAN-30, PLAN-33, FR-01, FR-16]
---

# 대시보드 일정 — 기간·종류 넷·위치·참석자·큰 달력 (T-180~T-183)

근거: 2026-10-06 사용자 요청과 선택 — 5 "일정에 시간을 범위로 넣을 수 있어야 할 듯(캘린더처럼. 혹은 하루 종일 체크. 여러 날짜에 겹쳐서 일정을 넣을 수도 있도록)", 6 "일정 종류에 할일/협의/접수/마감 이렇게 있어야 할 듯", 7 "위치/참석자 이렇게도 정보 기입 가능하도록", 8·11 대시보드 오른쪽 AI 채팅의 역할이 애매함, 9 "대시보드에서는 Jig, 최근 작업 필요없을 듯", 10 "달력이 좀 더 크게 … 위쪽 일정 아래 날짜 표기칸 필요 없어보임 … 아래쪽 날짜 없음도 무슨 기능인지 모르겠음", 12 화면 분할 재구성의 선택 "안 A: 할 일 | 큰 달력, AI 접기". 동작은 [SPEC-01](../specs/SPEC-01-project-input-sync.md).14의 1~4·6·8~10과 [SPEC-04](../specs/SPEC-04-web-review.md).10의 2, 표현은 [Design](../../Design.md) §03 「작업공간 탭」 머리·「대시보드의 할 일」·「대시보드의 일정」·「대시보드의 아래 줄」·「대시보드의 AI 열」과 SCR-20, 저장·경로는 [ARCH-01](../architecture/ARCH-01-system.md) §3 「대시보드의 할 일」과 「PC 없이 프로젝트 열기」다. 앞선 작업은 [PLAN-30](PLAN-30-dashboard-agenda.md)(두 구역·퇴근하기)과 [PLAN-33](PLAN-33-offline-project.md)(사이트 사본·편집 대기열)이다.

**같은 날 작업 지시가 정한 기본값:** 시작 `date`/`time`은 그대로 두고 `endDate`·`endTime`을 더한다(시각 없으면 하루 종일). `meeting`의 id는 두고 이름만 '협의', `receipt`('접수')를 더한다. 협의는 완료 체크 없는 일정, 접수는 체크 항목('제출'·'접수' 낱말). 여러 날 일정은 기간에 오늘이 들면 오늘에 보인다. 참석자는 자유 글. 끌어 옮기기는 기간을 유지한다. AI 열은 대시보드에서 기본으로 접고 화면별로 기억한다. 사이트를 먼저 배포한 뒤 PC를 릴리스한다(모르는 종류는 양쪽이 관대하게 받는다).

## T-180 데이터 — 기간·종류 넷·위치·참석자

| 변경 | 위치 |
|---|---|
| schema 11: `agenda_items` 다시 만들기(열 이름으로 옮김, `kind` CHECK에 `receipt`, 끝에 `endDate·endTime·location·attendees`) | `src/core/migrations.ts` |
| 계약: 항목·만들기·고치기·원장 기록(`before`의 새 필드는 선택)·하루 기록의 종류 | `src/contracts/agenda.ts` |
| 규칙: 날짜 없으면 나머지 비움, 시작 시각 없으면 끝 시각 비움, 같은 날 `endDate`는 NULL, 끝이 시작보다 앞서면 `INVALID_INPUT`, `date`만 바꾸면 `endDate` 따라 옮김, `time`만 바꾸면 `endTime` 길이 유지(넘치면 비움), 빈 위치·참석자는 NULL; 되돌리기는 기록된 필드만 | `src/core/agenda.ts` |
| 문장 읽기: 시각·날짜 범위(`~`·`-`·'부터 … 까지'), '하루 종일', 종류 순서(마감 낱말 → 접수·제출 → 날짜 뒤 '까지' → 협의·회의·미팅), 범위를 닫는 '까지'는 마감 아님; `agendaWhen`(기간·`past`), `todayProgress`(협의 제외), 라벨 '협의'·'접수', `extractionBody`(참석자·위치·끝 시각) | `src/ui/agenda-text.ts` |
| AI 도구 인자·설명(`endDate·endTime·location·attendees`, 종류 넷)과 원장 `before` | `src/server/agent-tools.ts`, `src/ai/agent-connection.ts` |
| 사이트 올리기·충돌 메모의 종류 이름 | `src/server/offline-summary.ts` (`agendaShare`, `KIND_NAMES`) |
| 사이트 편집 해석: 새 필드, 모르는 `kind`는 그 필드만 버림 | `src/server/remote-access.ts` `agendaEditSchema`(이 스키마만) |
| 사이트 D1 `project_agenda`에 `end_date·end_time·location·attendees` | `src/sharing/migrations/0013-agenda-fields.sql` |
| 사이트 검사·보기: `KINDS`에 `receipt`, 올린 목록의 모르는 종류는 `task`로 저장, 새 필드 검사(200·300자), 대기 변경의 날짜 이동은 기간 유지 | `src/sharing/summary.ts` |
| 사이트 화면: 종류 이름, 범위·위치·참석자 표시, 협의는 확인란 없음, 모르는 종류는 할 일 | `src/sharing/web/offline-summary.tsx` |

**검증:** `tests/core/migrations.test.mjs`(schema 10 → 11: 기존 행·순서·종류·완료 보존, 새 열 NULL, `receipt` 받고 모르는 종류 거절, 백업). `tests/server/agenda.test.mjs`(새 필드 더하기·고치기, 규칙 위반 거절, 날짜·시각 이동이 기간 유지, 되돌리기). `tests/core/agenda-text.test.mjs`(범위 읽기, '부터…까지', 접수·협의 낱말, 마감과의 순서, `agendaWhen`의 기간·협의, `todayProgress`의 협의 제외). `tests/server/agenda-tools.test.mjs`(도구의 새 인자). `tests/sharing/offline.mjs`(새 필드 올리기·보기, 모르는 종류가 400이 아님, 날짜 대기 변경의 기간 유지). `tests/server/offline-view.test.mjs` 회귀.

## T-181 배치 안 A — 할 일 열 | 큰 달력, AI 접기

| 변경 | 위치 |
|---|---|
| 할 일 열 320px 고정 + 나머지 달력(컨테이너 960px 이상), 페이지 최대 폭 없음 | `src/ui/dashboard.css` |
| jig·최근 작업 구역과 머리 줄의 최근 작업 시각 제거, 연결 파일·프로젝트 폴더는 접힌 한 줄 요약(펼치면 지금 타일, 펼침은 localStorage) | `src/ui/dashboard.tsx` |
| `recent`·`openRequest`를 대시보드 자료에서 제거 | `src/ui/app/glue.ts` |
| 오른쪽 AI 열 접힘을 대시보드와 나머지 화면으로 나눠 기억(대시보드 기본 접힘, localStorage `vide:right-folded`), 화면 바뀔 때 적용(`applyScreenFold`) | `src/ui/store/layout.ts`, `src/ui/workspaces.ts` |
| 대시보드에서 펼친 AI 열 맨 위의 '할 일 도우미'(오늘 브리핑·이번 주 마감·접수 정리·노트에서 할 일 뽑기): 기본 대화로 바꾸고 호스트 없이 자동 모드로 보냄(`vide:agenda-ask` 이벤트 → 작성기) | `src/ui/shell/agenda-helper.tsx`, `src/ui/shell/right-column.tsx`, `src/ui/app/glue.ts` |

## T-182 큰 달력과 일정 폼

| 변경 | 위치 |
|---|---|
| 주 줄 레인 배치 `weekLanes`(여러 날 막대 먼저, 칸당 다섯 줄, 넘치면 '+n') | `src/ui/agenda-text.ts` |
| 달력: 칸 최소 120px, 주를 가로지르는 막대, 칸의 [+], 날·[+]·[+ 일정]은 새 일정 폼, 항목은 고치기 폼; 놓을 날은 칸 또는 막대 위 x 위치로 정함; 일정 입력칸·'날짜 없음' 상자·그날 목록 제거 | `src/ui/dashboard-calendar.tsx`, `src/ui/dashboard.css` |
| 일정 폼(제목·종류·하루 종일·시작~끝 날짜·시각·위치·참석자; [추가] 또는 [저장]·[삭제]·[날짜 빼기]): 달력 팝오버와 할 일 행의 그 자리 고치기가 같은 칸을 쓴다 | `src/ui/dashboard-agenda-form.tsx`, `src/ui/dashboard-agenda.tsx` |
| 할 일 행: 협의는 확인란 없음, 시각 범위·기간·위치 표시 | `src/ui/dashboard-agenda.tsx` |

## T-183 검증

단위는 T-180의 목록. 브라우저: `browser-dashboard-agenda.mjs` 갱신 — 배치 안 A(할 일 열 왼쪽 고정 폭, 달력이 나머지), AI 열이 대시보드에서 접혀 있고 펼치면 할 일 도우미가 보이며 모델 화면은 펼친 채, 도우미 단추가 기본 대화에 호스트 없는 요청을 보냄, 날을 눌러 폼으로 협의(시각 범위·위치·참석자) 추가, 협의 행에 확인란 없음, '10/7~10/9'형 여러 날 일정이 막대로 이어짐, 끌어 옮기면 기간 유지, 항목 눌러 고치기·날짜 빼기·삭제, 일정 입력칸·날짜 없음 상자 없음. `browser-workspace-tabs.mjs`: 대시보드에 jig·최근 작업 구역이 없음. 회귀: `browser-offline.mjs`, `browser-shared-projects.mjs`, `npm --prefix src/sharing test`.

**결과(2026-10-06, 작업 폴더):** 구현·자동 검증 통과 — 단위 `agenda-text`·`migrations`(schema 10 → 11 보존)·`agenda`·`agenda-tools`·`offline-view`, 사이트 `npm --prefix src/sharing test`와 `tests/sharing/offline.mjs --browser`(협의 확인란 없음), 브라우저 `browser-dashboard-agenda`·`browser-workspace-tabs`·`browser-project-folders`(접힌 줄 펼치기 추가)·`browser-offline`·`browser-shared-projects`·`browser-workspace-controls`·`browser-react-panels`. 할 일 도우미의 '노트에서 할 일 뽑기'는 AI에게 공유 노트(SPEC-10) 읽기 도구가 없어 프로젝트 자료 검색과 프로젝트 폴더 파일을 읽으라고 요청한다.

**완료 판단:** 위 단위·브라우저 시험 통과, `typecheck`·`typecheck:sharing`·`format:check`·`docs:check` 통과. 설치본 반영, 사이트 배포(사이트 먼저), 실제 CLI로 도우미 단추 확인은 사용자 지시 뒤다.
