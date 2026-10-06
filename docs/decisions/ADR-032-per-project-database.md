---
id: ADR-032
title: 프로젝트마다 DB를 나눈다
status: review
version: 0.2
updated: 2026-10-06
owner: user
related: [ADR-031, ARCH-01, PLAN-08, PLAN-27, PLAN-28]
---

# 프로젝트마다 DB를 나눈다

## 결정

2026-10-02 사용자 결정: "DB는 나누는게 맞는 것 같아." **승인 범위:** 프로젝트마다 DB를 나눈다는 방향이다. 아래 구조·이행 방식은 구체화 제안이며, 정본 반영(ARCH-01 §5)과 구현 전에 사용자가 확인한다(그래서 `status: review`).

1. **나누는 단위.** 사용자 데이터 폴더(`%LOCALAPPDATA%\VIDE`)에 공용 DB 하나와 프로젝트 폴더를 둔다.
   - `app.sqlite`: 프로젝트 목록, AI·계정 설정, 확장 등록처럼 프로젝트에 속하지 않는 것.
   - `projects\<프로젝트 ID>\project.sqlite`: 요청·대화·연결 파일·Sync 목록·객체 판·jig 작업본·검토본·할 일 등 그 프로젝트의 모든 기록.
   - 이미 따로 있는 지식 DB(`knowledge\<프로젝트 ID>.sqlite`, PLAN-08)는 같은 프로젝트 폴더로 옮긴다.
2. **AI 읽기 권한.** AI 턴은 자기 프로젝트 폴더만 읽기 전용으로 받는다(ADR-031 6). 다른 프로젝트와 공용 DB는 열지 않는다.
3. **이행.** 엔진 시작 때 한 번, 기존 `vide.sqlite`를 백업한 뒤 프로젝트별로 옮기고 검사(`quick_check`, 행 수 대조)를 통과하면 원본을 `vide.sqlite.migrated`로 남긴다. 실패하면 옮기기 전 상태로 계속 쓴다.

## 표 분류 (schema 9, 1단계 조사 2026-10-06)

`src/core/project-split.ts`의 `appTables`·`projectTables`가 정본이며, 시험이 현재 schema의 모든 표가 둘 중 하나에 들어 있는지 확인한다(새 표를 추가하면 분류하지 않은 채로는 나누기가 `SPLIT_UNCLASSIFIED_TABLE`로 멈춘다).

| 위치 | 표 | 프로젝트를 정하는 열 |
|---|---|---|
| `app.sqlite` | `projects`(정본), `ai_settings`, `extension_registrations`, `jig_packages` | 없음(PC 전체) |
| `project.sqlite` | `workspace_requests`, `hidden_requests`, `document_links`, `conversations`, `review_snapshots`, `review_notes`, `shared_feedback`, `publication_exports`, `table_views`, `project_jigs`, `jig_drafts`, `jig_instances`, `knowledge_reviews`, `knowledge_source_rules`, `project_roots`, `project_folders`, `agenda_items`, `object_versions`, `sync_manifests`, `sync_manifest_items` | 자기 `projectId` |
| `project.sqlite` | `provider_sessions`, `ledger_items` | 부모 `conversations.projectId` |
| `project.sqlite` | `jig_param_log`, `jig_runs`, `jig_reads`, `jig_bakes` | 부모 `jig_instances.projectId` |
| `project.sqlite` | `sync_manifest_removed` | 부모 `sync_manifests.projectId` |
| `project.sqlite` | `connections`, `inputs`, `runs`, `commands`, `approvals`(초기 호스트 명령 기록) | 자기 `projectId` |

- 두 파일 모두 같은 마이그레이션으로 만든 전체 schema(같은 `schema_version`)를 갖고, 자기 표에만 행이 있다. 프로젝트 DB의 `projects`에는 그 프로젝트 한 행만 둔다. 거의 모든 표의 외래 키가 `projects(id)`를 가리키므로 이 행이 있어야 외래 키 검사와 기존 `Store` 코드가 그대로 돈다(이름의 정본은 `app.sqlite`).
- 초기 호스트 명령 표는 아직 쓰인다. 사본 결과를 원본에 적용하는 경로가 `connections`·`runs`·`commands`·`approvals`를 만든다(`src/server/application.ts:163-178`, `src/server/server.ts:605`). `inputs`는 `GET/POST …/inputs`(`src/server/server.ts:2520-2524`)가 쓴다. 모두 `projectId`가 있어 프로젝트 DB로 간다. 2026-10-06 설치본 DB에는 다섯 표 모두 0행이었다.
- `project_jigs(jigId, version)`은 `jig_packages`를 외래 키 없이 가리킨다(`src/core/jig-store.ts:271`). 나눈 뒤에도 행은 그대로이며, 설치본 조회는 `app.sqlite`에서 한다.

**프로젝트를 가로지르는 조회(2단계에서 바꿀 곳).** 나누면 아래는 한 프로젝트 DB 안에서만 보게 된다.
- 같은 문서가 두 프로젝트에 동시에 연결되는 것을 막는 검사(`src/core/store.ts:306`, `src/server/application.ts:163-171`)와 불확실한 쓰기 검사(`store.ts:413` `hasUncertainWrite`, 같은 호스트 문서의 다른 프로젝트 기록까지 봄), 명령 ID 중복 검사(`store.ts:436`)와 `lease(connectionId)`(`store.ts:472`).
- 요청을 ID만으로 찾는 곳(`src/core/workspace.ts:389` 등)과 시작 때 전체 복구(`workspace.ts:62`), 닫힌 대화 정리(`src/core/conversation-store.ts:179`), 옮기기·정리(`src/core/model-move.ts:219`, `src/core/model-store.ts:805`), 작업 사본 정리(`src/server/capture-cleanup.ts:80`), 프로젝트 삭제의 사용 중 파일 확인(`src/server/project-removal.ts:111`), 최근 활동(`store.ts:194`).
- `shared_feedback.identity`의 UNIQUE는 프로젝트 안에서만 보장된다.
- 한 문서의 마지막 저장 표시 Sync를 모든 프로젝트에서 찾는 `query`의 `storedDisplay`(`src/server/execution.ts`, T-123)와 Live Sync가 기준을 다른 요청이 가리키는지 보는 SQL(`src/server/live-sync.ts`의 `referenced`, 한 DB의 `workspace_requests`를 가정)(2026-10-06 T-123 검토).

## 이행 (1단계 구현 2026-10-06, 엔진에는 아직 연결하지 않음)

`splitProjectDatabase(dataDirectory, { dryRun })`(`src/core/project-split.ts`), 손으로 돌리는 `node tools/db/split.mjs --data <폴더> [--dry-run]`.

1. `app.sqlite`가 이미 있으면 아무것도 하지 않는다(`vide.sqlite`도 남아 있으면 `conflict`로 알리고 손대지 않음). `vide.sqlite`가 없으면 `no-source`.
2. 엔진과 같은 `vide.sqlite.controller` 잠금을 잡는다(실행 중이면 `CONTROLLER_BUSY`). schema가 현재 판이 아니면 멈춘다(엔진이 먼저 한 번 열어 올린다).
3. 원본을 읽기 전용으로 열어 `VACUUM INTO`로 `vide.sqlite.backups/split-*.sqlite`를 만들고 `quick_check`한다. 체크포인트되지 않은 WAL 내용도 들어간다. 이후 모든 읽기는 이 백업에서 한다.
4. 임시 폴더(`<data>/.project-split-*`)에 `app.sqlite`와 프로젝트마다 `projects/<id>/project.sqlite`를 마이그레이션으로 만들고, 백업을 ATTACH해 위 분류대로 행을 복사한다(rowid 순서 유지, 생성 열 제외). 지식 DB가 있으면 `VACUUM INTO`로 `knowledge.sqlite`를 만든다.
5. 검사: 결과마다 `quick_check`·`foreign_key_check`, 표마다 결과 행 수(공용 표는 `app.sqlite`, 나머지는 프로젝트 합)가 원본과 같은지, 지식 DB의 표별 행 수가 같은지. 어느 프로젝트에도 속하지 않는 행이 있으면 합이 달라 `SPLIT_ROWS_MISMATCH`로 멈춘다.
6. 자리 옮기기: 프로젝트 폴더 → `app.sqlite` → `vide.sqlite`(·`-wal`·`-shm`)를 `vide.sqlite.migrated`로 → `knowledge/<id>.sqlite`를 `.migrated`로. 프로젝트가 없는 지식 파일과 `knowledge` 폴더의 다른 파일은 그대로 둔다.
7. 1~6 중 어디서 실패해도 이미 옮긴 것을 되돌리고 임시 폴더와 이번 백업을 지운다. 원본은 바뀌지 않는다. 지우는 것은 이번 실행이 만든 파일뿐이다.

**검증.** `tests/core/project-split.test.mjs`: 프로젝트 3개·모든 표의 합성 DB를 나눈 뒤 표별 행 수·`integrity_check`·외래 키, 두 번째 실행은 `already-split`; 복사 중 오류·행 수 불일치·옮기는 중 오류에서 원본 바이트가 같고 남은 파일이 없음; 실행 중 잠금 거절; 체크포인트되지 않은 WAL 행 포함. 2026-10-06 설치본 DB 사본(212 MB, 프로젝트 1개)에서 미리 보기·실제 실행 각 약 12초, `project.sqlite` 213 MB(요청 70, 객체 판 16,324, Sync 목록 줄 137,962), `app.sqlite` 0.3 MB, 지식 DB 50 MB. 나눈 `project.sqlite`를 기존 `Store`로 열 수 있음을 확인했다.

**2단계(T-123 뒤).** 엔진 시작 때 이 함수를 부르고 `Store`를 공용·프로젝트별 연결로 나눈다. 바꿀 곳: `src/server/main.ts`(파일 경로·시작 순서), `src/core/store.ts`·`src/core/workspace.ts`·`src/core/model-store.ts`·`src/server/live-sync.ts`·`src/server/server.ts`(프로젝트별 연결 선택, 위 가로지르는 조회), `src/core/backup.ts`(여러 파일 백업), `src/server/project-removal.ts`(폴더 삭제), `src/jigs/knowledge.ts`의 `knowledgeFile`과 지식 수집 도구(`tools/spikes/2026-09-29-knowledge-crawl/db.mjs`), AI 턴의 읽기 권한(위 2).

## 맥락

`vide.sqlite` 하나를 쓴 데 설계상의 이유는 없었다. '한 PC, 한 사용자' 프로토타입의 기본값이 굳은 것이다. 반면 나중에 만든 지식 DB는 이미 프로젝트별 파일이라 방식이 섞여 있었다. 하나로 두면 한 프로젝트가 커지거나 깨질 때 다른 프로젝트까지 영향을 받는다(2026-10-02 DB 222MB·WAL 120MB). 또 AI에게 기록을 읽게 하려면 다른 프로젝트까지 노출된다.

## 결과

- 한 프로젝트의 DB 문제(크기, 손상, 잠금)가 다른 프로젝트로 번지지 않는다. 프로젝트 삭제는 폴더 삭제가 된다.
- 프로젝트를 가로지르는 조회(대시보드의 여러 프로젝트, 계정 사용량)는 공용 DB나 각 프로젝트 DB를 차례로 연다.
- `Store`·마이그레이션·백업·정리 코드가 DB 하나를 전제로 하므로 구현 범위가 넓다. PLAN-27의 저장 작업(T-083~087)과 겹치는 파일이 많아 그 작업이 끝난 뒤 진행한다.
