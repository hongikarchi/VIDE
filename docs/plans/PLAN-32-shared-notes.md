---
id: PLAN-32
title: 공유 노트·협의 사항·일지 — 실시간 공동 편집(T-145~T-149)
status: draft
version: 0.1
updated: 2026-10-06
owner: agent:claude
related: [ADR-034, SPEC-10, SPEC-01, SPEC-04, ARCH-01, PLAN-30, FR-07, FR-16, FR-18, FR-19]
---

# 공유 노트·협의 사항·일지 (T-145~T-149)

근거: 2026-10-06 사용자 요청·결정 — "Notion처럼 여러 사람이 텍스트로 정리할 수 있으면 좋겠음. 해당 노트들은 자동으로 서버에 연결되도록. 이 부분은 협의 사항 이쪽이랑 연동되면 좋을 듯. 일기장처럼 매일매일 작업 상황 기록할 수 있도록." + 원본은 사이트(PC는 AI가 읽을 사본), 구성원 모두 편집, "실시간으로 바로 갑시다". 결정과 선택지는 [ADR-034](../decisions/ADR-034-shared-notes-realtime.md), 동작은 [SPEC-10](../specs/SPEC-10-shared-notes.md), 화면은 Design SCR-23, 물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md) §6 「공유 노트」. 제품 범위 반영은 PRD 첨삭(FR-26·AC-49, R-77)으로 제안 중이며, 구현은 사용자 결정 1~3에 근거한다.

## Cloudflare 무료 요금제의 Durable Object 한도(2026-10-06 문서 확인)

[한도](https://developers.cloudflare.com/durable-objects/platform/limits/)·[요금](https://developers.cloudflare.com/durable-objects/platform/pricing/) 기준이다.

| 항목 | 무료 | 이 설계의 사용 |
|---|---|---|
| DO 저장 방식 | SQLite 저장만(키-값 저장은 유료) | `new_sqlite_classes: [NoteRoom]` |
| 요청 | 하루 100,000건. 받는 WebSocket 메시지는 20개 = 1건 | 노트 열기 1건 + 타이핑 메시지 20개당 1건 |
| 실행 시간 | 하루 13,000 GB-s. 잠들 수 있는 조용한 객체는 요금 없음 | Hibernation API(`acceptWebSocket`) |
| SQLite 행 | 읽기 하루 500만, 쓰기 하루 10만 | 갱신 1초 묶음 한 행, 100행 넘으면 압축 |
| 저장 | 계정 5 GB, 객체당 10 GB, 객체 수 무제한 | 노트마다 객체 하나 |
| 클래스 | 계정당 100 | 1 |
| 메시지·CPU | 받는 메시지 32 MiB, 요청당 CPU 30초, 객체 하나 초당 약 1,000요청(연성) | 4 MB 넘는 메시지는 닫음 |

Worker 자체의 무료 요청 하루 100,000건은 PC 중계·heartbeat와 함께 쓴다(ARCH-01 §6). Worker 묶음은 Yjs를 더해 약 2.9 MB(gzip 약 0.5 MB, 무료 압축 3 MB 안)다.

## T-145 사이트: 노트 저장·Durable Object·실시간 소켓

| 변경 | 위치 |
|---|---|
| D1 `notes`(하루 하나의 일지 부분 유일 색인) | `src/sharing/migrations/0008-notes.sql` |
| 노트 API(구성원 확인, 목록·찾기·만들기·일지·이름·종류·지우기·표·붙이기), 1분 표(HMAC) | `src/sharing/notes.ts` |
| `NoteRoom`(SQLite DO, Hibernation 소켓, 1초 묶음 저장·압축, D1 사본 5초·마지막 퇴장, awareness 중계, `/append`) | `src/sharing/note-room.ts` |
| 경로·소켓·101 응답 통과·CSP `ws(s)`, PC 키 경로, `NOTES` 바인딩 타입 | `src/sharing/worker.ts`, `hosts.ts`, `auth.ts` |
| DO 바인딩과 이행 태그 `v1-notes` | `src/sharing/wrangler.jsonc`, `wrangler.staging.jsonc` |
| Markdown 변환·문단 붙이기·체크 항목, 동기화 메시지, 클라이언트 소켓 | `src/contracts/note-doc.ts`, `note-sync.ts`, `note-socket.ts` |

**검증:** `tests/sharing/notes.mjs`(Miniflare D1 + DO): 비구성원 404·비로그인 401·위조 표 401, 두 클라이언트가 같은 노트를 고쳐 같은 Markdown으로 수렴, 마지막 퇴장 뒤 D1 사본과 찾기, 다시 연 클라이언트가 저장된 상태를 받음, 동시에 누른 [오늘 일지]가 하나, 잘못된 날짜 400, 일지 종류 고정, 지우기 권한. `npx wrangler deploy --dry-run`으로 설정 확인(바인딩 `env.NOTES (NoteRoom)`; 배포 아님).

## T-146 사이트 화면과 공통 편집기

| 변경 | 위치 |
|---|---|
| 공통 화면: 목록(오늘 일지·새 노트·새 협의 사항·찾기·종류)·열린 노트(제목·종류·연결 상태·함께 보는 사람·지우기·할 일로 보내기)·블록 편집기·CSS | `src/ui/notes/notes-workspace.tsx`, `note-editor.tsx`, `notes.css` |
| 사이트: 프로젝트 메뉴 [노트·일지], `?notes=<id>&note=<id>`, 지연 로드 | `src/sharing/web/notes.tsx`, `main.tsx`, `home.tsx`, `style.css` |

**검증:** `tests/sharing/notes-browser.mjs`(Chrome 두 창, 테스트 다리가 소켓을 Miniflare로 넘김): 메뉴로 열고 새 노트·제목, 두 사람의 타이핑이 서로 보임, `[ ] ` 체크 항목, '함께 보는 중', [오늘 일지]. `npm run build:sharing`.

## T-147 PC 엔진: 구성원 연결·사본·오프라인

| 변경 | 위치 |
|---|---|
| PC 키로 사이트 부르기 `deviceFetch` | `src/server/remote-access.ts` |
| `SharedNotes`: 목록·만들기·일지·이름·지우기, 복제본(Yjs + `.yjs` 저장 + `.pending`) + 사이트 소켓, 화면 스트림 중계, Markdown 사본·README·index, 10분 새로 읽기, 일지 붙이기와 대기, 글 → 할 일 | `src/server/shared-notes.ts` |
| 로컬 API(SSE 포함), 서버 연결·종료 | `src/server/notes-routes.ts`, `server.ts` |
| AI 턴 지시에 `notes/` 폴더 | `src/ai/agent-connection.ts` |

**검증:** `tests/server/shared-notes.test.mjs`(사이트 없이): 사본·README·지시 문구, 협의 사항 → 할 일(한 번만), 오프라인 목록, 화면 스트림(자기 편집은 돌려보내지 않음)·`.pending`, Markdown 변환 표. `tests/sharing/notes.mjs`의 PC 부분: PC 키로 일지 붙이기 → D1, 사본 파일, 사이트가 끊긴 동안 쓴 문단과 일지 줄이 다시 연결된 뒤 사이트에 합쳐짐.

## T-148 VIDE 화면

| 변경 | 위치 |
|---|---|
| 고정 화면 `notes`, 레일 단추(공책 아이콘), 화면 CSS | `src/ui/workspaces.ts`, `shell/rail.tsx`, `icons.ts`, `notes-tab.tsx`, `notes-tab.css` |
| 레일·좁은 화면 메뉴 기대값 | `tests/integration/browser-workspace-tabs.mjs` |

**검증:** `tests/sharing/notes-pc-browser.mjs`(실제 엔진 + 실제 WebSocket → 다리 → Miniflare): VIDE 레일에서 노트를 열어 쓴 줄이 사이트 창에 보이고 사이트에서 쓴 줄이 VIDE에 보임, [할 일로 보내기]가 PC 할 일을 만듦, 엔진의 `.md` 사본이 두 줄을 따라감.

## T-149 협의 사항 → 할 일, 퇴근하기 → 일지 연결과 배포 (일부 대기)

- 완료: 엔진 함수 `SharedNotes.toAgenda`·`agendaFromText`(로컬 `POST …/notes/:id/to-agenda`, `…/notes/agenda-from-text {text}`)와 `appendJournal`(로컬 `POST …/notes/journal/append {text, date?}`). 할 일 쓰기는 기존 `Agenda.add`(SPEC-01.14)를 쓴다.
- 완료(main 합친 뒤): `POST …/agenda/day-end`(PLAN-30 T-137) 응답 뒤 `dayEnded` 훅이 `appendJournal(projectId, '퇴근 기록 · ' + 하루 줄, 그날)`을 기다리지 않고 부른다(실패·미연결은 무시, 사이트 불통은 PC 대기열). 검증 `shared-notes.test.mjs`(훅 호출·훅 실패에도 200). 사이트 'PC 없이 보기'(PLAN-33 SCR-21)의 노트 자리에 최근 노트 6개와 [노트·일지 열기](`offline.tsx` `OfflineNotes`), 검증 `notes-browser.mjs`. [할 일로 보내기]는 규칙 기반 `agendaFromText` 그대로(PLAN-30의 AI 뽑기와 별개).
- 대기(사용자): 아래 「배포」와 실제 두 기기 확인.

### 배포(사용자·리드가 실행, 이 작업은 배포하지 않음)

1. 루트에서 `npm install`(Worker 묶음이 루트의 `yjs`를 쓴다), `npm run build:sharing`.
2. D1 이행: `cd src/sharing && npx wrangler d1 migrations apply vide-sharing-staging --remote -c wrangler.staging.jsonc`(`0008-notes.sql`).
3. Worker + DO 배포: `npx wrangler deploy -c wrangler.staging.jsonc`. 처음 배포가 DO 이행 `v1-notes`(`new_sqlite_classes: NoteRoom`)를 적용한다. 태그를 바꾸거나 지우지 않는다(이후 DO 변경은 새 태그를 덧붙임).
4. 확인: 사이트 프로젝트 메뉴 → 노트·일지, 두 기기에서 같은 노트, PC VIDE의 레일 노트·일지(설치본 갱신 뒤).

## 실제 확인(대기)

1. 두 사람(다른 계정·다른 기기)이 같은 협의 사항을 동시에 쓰고, 한 사람이 휴대 기기 네트워크를 잠시 끊었다 붙여도 글이 합쳐진다.
2. VIDE를 켠 PC의 네트워크를 끊고 노트를 쓴 뒤 VIDE를 다시 시작하고 네트워크를 붙이면 그 글이 사이트에 나타난다.
3. 하루 사용량(Cloudflare 대시보드의 DO 요청·행 쓰기)이 무료 한도의 몇 %인지 기록한다.
