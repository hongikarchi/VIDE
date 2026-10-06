---
id: PLAN-30
title: 대시보드 할 일 — 두 구역·글·파일에서 만들기·퇴근하기(T-135~T-138)
status: draft
version: 0.1
updated: 2026-10-06
owner: agent:claude
related: [SPEC-01, ARCH-01, DESIGN, ADR-031, PLAN-26, FR-01]
---

# 대시보드 할 일 — 두 구역·글·파일에서 만들기·퇴근하기 (T-135~T-138)

근거: 2026-10-06 사용자 요청 셋 — '달력이랑 to-do list는 분리될 것', '내용(협의 내용, 회의록, 이메일 등)을 적거나 파일을 한번에 넣으면 to-do list 만들어주는 기능', '오늘의 할 일 느낌으로 다 끝내면 퇴근하기같은 느낌'. 동작은 [SPEC-01](../specs/SPEC-01-project-input-sync.md).14의 2·3·6~10, 표현은 [Design](../../Design.md) §03 「대시보드의 할 일」·「퇴근하기」·「글·파일에서 할 일 만들기」·「대시보드의 일정」과 SCR-20, 저장·경로는 [ARCH-01](../architecture/ARCH-01-system.md) §3 「대시보드의 할 일」이다. 앞선 작업은 [PLAN-26](PLAN-26-chat-stage.md) T-098(목록)·T-110(달력·종류)이다.

**같은 날 작업 지시가 정한 기본값:** 할 일 구역은 지남·오늘·날짜 없음을 보이고 예정·완료는 접는다. 일정 구역은 달력(회의·마감·날짜 있는 할 일)이다. 데이터는 같은 `agenda_items`이고 바꾸지 않는다. 뽑기는 기본 대화의 호스트 없는 자동 턴 하나이며 미리보기 단계가 없다(ADR-031). 그 턴의 쓰기는 이미 있는 턴 단위 [되돌리기](`agenda/undo {ledgerIds}`)로 함께 되돌린다(새 일괄 되돌리기는 필요 없음). 날짜 없는 항목은 퇴근을 막지 않는다. 하루 기록은 새 작은 표 `day_log`(schema 10)이며 나중의 공유 메모·업무 일지가 같은 표를 읽는다.

## T-135 할 일·일정 두 구역

| 변경 | 위치 |
|---|---|
| [목록 \| 달력] 전환과 `vide.agenda.view` 제거. 같은 자료를 읽는 부모(`AgendaBoard`) 아래 '할 일' 구역(오늘 진행 n/m, 입력칸, 지남·오늘·날짜 없음 목록, 접힌 '예정 n'·'완료 n')과 '일정' 구역(자기 입력칸, 달력, 고른 날 목록) | `src/ui/dashboard-agenda.tsx` |
| 달력: 할 일 행을 날로 끌어 날짜 바꾸기(페이지 안의 끌기 형식 `application/x-vide-agenda`), '날짜 없음' 상자를 달 아래로 | `src/ui/dashboard-calendar.tsx` |
| 오늘 진행·퇴근 판단 `todayProgress(items, today)` | `src/ui/agenda-text.ts` |
| 두 구역 배치(컨테이너 860px 이상 나란히), 일정 구역 480px 이하 점만 | `src/ui/dashboard.css` |

**검증:** `agenda-text.test.mjs`(`todayProgress`: 지남·오늘·오늘 완료·어제 완료·날짜 없음). `browser-dashboard-agenda.mjs`: 두 구역이 따로 보이고 전환 단추가 없음, 할 일 목록 행을 달력의 날로 끌면 날짜만 바뀜, 예정이 접혀 있음, 기존 달력·끌기·날짜 없음 시험 유지. 좁은 폭(700px 창)에서 두 구역이 위아래.

## T-136 글·파일에서 할 일 만들기

| 변경 | 위치 |
|---|---|
| 패널: 여러 줄 입력칸, 파일 놓기·붙여 넣기·고르기(`uploadAttachments`, SPEC-01.12), 첨부 칩, [할 일 만들기] | `src/ui/dashboard-agenda-extract.tsx` |
| 지시 본문 `extractionBody(text, today, files)`, 대시보드가 보낸 요청 ID 모음 `dashboardAgendaRequests` | `src/ui/agenda-text.ts` |
| 요청: `POST …/requests {conversationId:'default', hostUse:'none', mode:'auto', provider:'claude-cli', model:'auto', …}`. 진행: 요청 상태와 대화 원장의 그 요청 `appAction:'agenda'` 항목을 1.2초마다 읽어 더한 수를 보이고 목록을 다시 읽음. 끝: 'n개를 더했습니다' + [되돌리기](`agenda/undo {ledgerIds}`) | `dashboard-agenda-extract.tsx` |
| 대시보드 요청의 쓰기에 화면 아래 안내를 띄우지 않음(목록 다시 읽기는 유지) | `src/ui/app/thread.ts` `followAppActions` |

**검증:** `agenda-text.test.mjs`(`extractionBody`에 오늘 날짜·`agenda_add`·담당자·묻지 않기·글). `browser-dashboard-agenda.mjs`: 회의록 글 파일을 패널에 놓기 → 가짜 공급자가 맥락의 첨부 경로로 파일을 읽고 `agenda_add` 두 번 → 항목이 목록에 나오고 '3개를 더했습니다' → [되돌리기]로 모두 사라짐, 화면 아래 안내는 뜨지 않음. 실제 CLI 확인은 T-138.

## T-137 퇴근하기와 하루 기록

| 변경 | 위치 |
|---|---|
| schema 10 `day_log` | `src/core/migrations.ts`, `src/core/project-split.ts`, `src/core/store.ts`(`deleteProject`) |
| `DayLog`·`Agenda.dayEnd`(오늘 완료한 항목 빼기 + 그날 `day-end` 행에 더하기, 한 트랜잭션), `Agenda.log(from, to)` | `src/core/agenda.ts`, `src/contracts/agenda.ts` |
| `POST …/agenda/day-end`, `GET …/agenda/log` | `src/server/agenda-routes.ts` |
| 퇴근 상자: 다 했을 때 [퇴근하기], 뒤에 '퇴근했습니다 · 완료 n'과 내일 항목 셋 | `src/ui/dashboard-agenda.tsx`, `dashboard.css` |

**검증:** `agenda.test.mjs`: 오늘 완료만 빠지고 어제 완료·미완료는 남음, 같은 날 두 번이면 한 행에 더해짐, 한 줄 요약, 기간 읽기, HTTP 경로, 프로젝트 삭제. `migrations.test.mjs`(9 → 10, 표 생김). `project-split.test.mjs`(표 목록). 브라우저: 오늘 항목을 모두 완료 → 진행 2/2와 [퇴근하기] → 누르면 완료가 빠지고 '퇴근했습니다'와 내일 항목, 하루 기록 GET에 그날 한 줄. 날짜 없는 미완료가 있어도 [퇴근하기]가 보임.

## T-138 실제 CLI 확인 (대기)

이 세션은 가짜 공급자로만 시험했다. 설치본 반영 뒤 사용자 창에서 합성 프로젝트로 확인한다.

1. 회의록 글(날짜 '다음 주 화요일 2시 설비 회의', '금요일까지 도면 제출 — 김 대리', 날짜 없는 할 일 하나)을 붙여 넣고 [할 일 만들기] → Claude·Codex 각각에서 묻지 않고 3개가 들어가고, 날짜·시각·종류·'(담당: 김 대리)'가 맞음.
2. PDF·이미지 첨부 하나로 같은 확인(첨부 읽기).
3. 같은 글을 다시 보내면 중복을 넣지 않음.
4. [되돌리기]가 그 턴의 항목을 모두 지움. 기본 대화에 요청과 답이 남음.

**완료 기준:** 1~4 통과를 PLAN.md §6.5에 남긴다. 어긋나면 지시 본문(`extractionBody`)이나 `agenda_add` 설명만 고친다.

## 범위 밖

SPEC-01.14의 8: 미리보기 고르기, 하루 기록 화면, 공유 메모·업무 일지, 퇴근하기 되돌리기, 반복 일정·외부 캘린더.
