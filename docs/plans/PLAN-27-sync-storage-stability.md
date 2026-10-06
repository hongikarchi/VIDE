---
id: PLAN-27
title: Sync 저장 구조와 작동 안정성 — 진단·복구, 객체 단위 저장, 엔진 주관 Sync
status: draft
version: 0.7
updated: 2026-10-06
owner: agent:claude
related: [RESEARCH-13, SPEC-01, ARCH-01, PLAN-16, PLAN-18, PLAN-24, FR-02, FR-03, FR-16]
---

# Sync 저장 구조와 작동 안정성 (T-082~T-087)

근거: [RESEARCH-13](../research/RESEARCH-13-stability-audit.md)의 점검 결과와 2026-10-01 사용자 결정. 결정 내용은 다음과 같다.

1. Sync 저장은 바뀐 것만 반영하는 git 방식으로 바꾼다.
2. Sync를 주관하는 곳은 엔진 한 곳으로 하고, 화면 갱신 방식도 바꾼다.
3. 상한은 작업에 불편이 없을 만큼 넉넉하게 걸고, 문제가 생기면 고친다.

엔진 언어는 TypeScript를 유지한다. 계산이 무거운 부분만 측정한 뒤 네이티브 모듈로 엔진 밖(작업 스레드·자식 프로세스)에서 돌린다(§7).

## 0단계 — 진단·복구 (T-082)

기존 동작을 바꾸지 않는다.

| 변경 | 위치 |
|---|---|
| 엔진이 끝나면 종료 코드(16진)·가동 시간·재시작 횟수를 `logs/engine-exits.jsonl`에 남기고, 안내 문구에도 코드를 보인다 | `src/desktop/shell/Engine.cs`, `ShellContext.cs` |
| 엔진 재시작 횟수를 10분 정상 가동 뒤 초기화한다 | `ShellContext.cs` |
| 업데이트 자동 적용이 실행 중인 VIDE·엔진을 죽이지 않는다. 받은 업데이트는 트레이 메뉴나 종료 때 적용한다 | `Program.cs` |
| WebView2 화면 프로세스가 죽거나 응답이 없으면 다시 불러온다(1분에 3회까지). 브라우저 프로세스가 죽으면 WebView를 새로 만든다 | `ShellForm.cs` |
| 엔진이 1분마다 메모리(rss·heap·external)와 이벤트 루프 지연(최대·p99)을 기록하고, 정상 종료가 아닌 `exit`도 기록한다 | `src/server/main.ts`, `diagnostics.ts` |
| 1초를 넘긴 Sync·Live Sync·요청 목록 처리를 크기와 함께 기록한다 | `src/server/server.ts`, `live-sync.ts` |
| 자식 프로세스(cloudflared, jig 실행기, 로그인)의 `error`·stdin `error`를 처리하고, 처리 안 된 rejection은 기록만 하고 엔진을 끝내지 않는다 | `remote-access.ts`, `src/jigs/runtime/child-runner.ts`, `src/ai/account-login.ts`, `main.ts` |

**검증:**
- 셸 빌드
- 엔진 단위 시험
- 자식 프로세스 실행 실패·죽은 자식에 쓰기 재현 스크립트(RESEARCH-13 §5)로 엔진이 살아 있는지 확인
- 화면 프로세스 강제 종료 뒤 다시 불러오는지 확인
- 종료 코드 기록 확인

Rhino 패널의 같은 복구(플러그인 재빌드·Rhino 재시작 필요)는 6단계에 둔다.

**결과(2026-10-01) — 구현·자동 검증, 설치본 확인 남음:**
- 셸 수정 내용:
  - 엔진이 끝날 때마다 `logs/engine-exits.jsonl`에 `{pid, code, hex, uptimeSec, asked}`를 남기고, 안내 문구에 16진 코드를 보인다.
  - 재시작 횟수는 10분 넘게 돈 엔진이 끝나면 초기화한다.
  - 업데이트는 VIDE가 이미 실행 중일 때 시작 시 자동 적용하지 않는다(`SetAutoApplyOnStartup(!running)`).
  - WebView2 `ProcessFailed` 처리: 화면 프로세스가 끝나거나 응답이 없으면 다시 불러온다(1분 3회). 브라우저 프로세스가 끝나면 WebView를 새로 만들어 마지막 페이지로 간다.
  - `npm run desktop:build` 오류 0개.
- 엔진 수정 내용:
  - `src/server/health.ts`가 1분마다 `health`를 기록한다.
  - `live-sync` 기록에 바뀐·지운 객체 수와 사본 생성 여부를 더했다.
  - `unhandledRejection`은 `engine-unhandled`로 기록하고 엔진을 끝내지 않는다.
  - `exit`도 기록한다.
  - 자식 프로세스 `error` 처리: jig 실행기(단계 실패로 끝남, 로그 500줄 제한), cloudflared, 로그인 stdin, 탐색기.
- 시험:
  - 새로 추가: `tests/core/jig-runner.test.mjs`(실행 프로그램이 없을 때), `tests/server/remote-tunnel-error.test.mjs`. 둘 다 이전 코드에서는 실패하고 수정 뒤 통과한다.
  - 새로 추가: `tests/server/health.test.mjs`.
  - 단위·서버 시험 729건 통과.
- 남음:
  - 셸의 화면 복구는 실제 창에서 확인하지 않았다. 시험용 셸은 설치본과 같은 단일 실행 이름을 써서 사용자 VIDE가 켜져 있으면 실행할 수 없다.
  - 설치본 릴리스: 다른 세션의 미커밋 화면 변경이 작업 트리에 있어 이번 커밋만으로 빌드해야 한다.

**2026-10-02 엔진 종료(0xC0000409) 조사 — 일부 원인 수정, 종료 원인은 미확정:**
- 사실: 설치본 0.2.16에서 00:19·00:22·00:24·00:27(UTC) 네 번 `0xC0000409`로 끝났다(10-01에도 여섯 번). `engine-stderr-*.log`는 생기지 않았다. 뒤의 둘은 요청이 없고 1분 전 힙이 49~76 MB였다.
- 셸의 stderr 기록은 정상이다. `Engine.cs`를 그대로 넣은 시험 셸로 자식 node에 V8 힙 한계를 일으키면 종료 코드 `0x86`과 `FATAL ERROR: Reached heap limit …` 전문이 기록된다. 설치본 런타임으로 잰 값: 힙 한계·`process.abort()`는 134(0x86), 네이티브 스택 넘침은 `0xC00000FD`. 따라서 `0xC0000409`·stderr 없음은 JS 오류나 V8 힙 한계가 아니다(네이티브 fail-fast 또는 외부 종료). 원인은 덤프 없이 확정할 수 없다. node.exe용 WER LocalDumps(관리자 권한 레지스트리)를 켜면 다음 종료에서 덤프를 얻는다(사용자 결정).
- 확인·수정한 별도 문제: 고정 8개 요청이 같은 78 MB Sync를 제출 때 9번(2.3초), 실행 준비 때 1+8번과 스키마 복사로 다시 해석했다(4.6초, 최대 힙 약 2.06 GB). 사용자 DB 사본으로 재현했고, 당시 health 기록(rss 2,198 MB·힙 1,987 MB·루프 2,963 ms)과 맞는다. `Workspace.summary`·`baseline`(형상 뺀 행, `list`와 같은 캐시)으로 제출 검사·고정·연결 대상을 읽고, 실행은 기준 Sync만 한 번 해석하며 형상 배열은 복사하지 않는다(`parsedModel`). 수정 뒤: 제출 20 ms·큰 해석 0번, 실행 준비 282 ms·힙 +295 MB. 시험 `tests/server/large-sync-pins.test.mjs`(이전 코드에서 실패).
- 이미지: 해당 폴더는 JPG 16장, 각 330 KB 이하(합계 1.8 MB)라 원인이 아니다. `file_read`는 이미 1 MB 넘는 이미지를 앞 64 KB만 읽고 안내로 답한다. 턴당 이미지 합계 16 MB 상한을 더했다(ARCH-01 §3, `tests/server/project-files.test.mjs`).
- 힙 한계: 이 PC의 기본값이 4,496 MB라 `--max-old-space-size=4096`은 오히려 낮추므로 넣지 않았다.
- 남음: Live Sync는 여전히 변경마다 기준 Sync를 두 번 해석하고 전체를 다시 쓴다(1단계). 셸(C#)은 바꾸지 않았다.

## 1단계 — 객체 단위 저장 (T-083)

**상태(2026-10-02): 계약 사용자 확인, 구현·자동 검증(미커밋), 사용자 DB 사본 측정·설치본 확인 남음.** 저장 계약은 ARCH-01 §5 「Sync 표시 형상의 객체 단위 저장(T-083)」이 소유한다. 이 절은 작업 순서와 검증만 적는다.

2026-10-02 사용자 결정(모두 제안대로):
- 저장된 표시 형상은 float32 차이(0.001 mm)로 둔다. 측정값과 `geometryHash`는 바뀌지 않는다.
- 기존 행은 엔진이 주소를 연 뒤 백그라운드에서 한 행에 한 트랜잭션으로 옮긴다. 백업은 지금의 마이그레이션 백업 하나, VACUUM은 한가할 때나 다음 시작 때.
- 보존: 문서마다 최근 Sync 목록 20개와 참조된 Sync를 남기고 나머지 목록과 참조 없는 판을 지운다(T-087에서 앞당김, 규칙은 ARCH-01 §5 「정리」).

**진행(2026-10-02, 1차) — 독립 층 구현·단위 시험, 연결 전:** 다른 작업과 겹치는 파일(`workspace.ts`, `server.ts` 등)을 건드리지 않는 순서 1·2·3·8의 모듈만 만들었다.
- 순서 1: `encodeItem`·`decodeItem`·`joinGeometry`(`geometry-transfer.ts`). 이어 붙인 VGT1이 지금의 `encodeGeometry` 결과와 바이트 단위로 같다. 지문 `versionId`는 `src/core/model-store.ts`에 둔다(이 형식 파일은 화면도 써서 Node 해시를 둘 수 없음).
- 순서 2: schema 9(`object_versions`·`sync_manifests`·`sync_manifest_items`·`sync_manifest_removed`, CASCADE). 프로젝트 삭제(`Store.deleteProject`)가 판도 지운다.
- 순서 3: `ModelStore`(`store`·`applyDelta`·`copyManifest`·`load`·`view`·`geometry`·`deltaSince`·`deltaGeometry`·`sweep`·`retain`).
- 순서 8: `model-move.ts`(`moveRow`·`pendingRows`·`moveRows`·`vacuumWhenIdle`). 엔진 시작에 붙이는 것은 남음.
- 합성 1만 개 객체(정점 100만 개) 측정: 처음 저장 약 0.3초, 바뀌지 않은 전체 Sync 저장 약 0.3초(새 판 0개), 10개 바뀐 Live Sync 적용 1~2.5 ms, 전체 다시 만들기 약 0.2초, VGT1 이어 붙이기 약 0.15초(20.9 MB), `deltaSince` 1~13 ms.
- 시험: `tests/core/model-store.test.mjs`·`model-move.test.mjs`(새), `geometry-transfer.test.mjs`·`migrations.test.mjs`(고침).
- 남음: 순서 4~7·9와 순서 8의 엔진 시작 연결(`Workspace`·`LiveSync`·`server.ts`·`main.ts`), 그 시험.

**진행(2026-10-02, 2차) — 연결·자동 검증:**
- `Workspace`: `update`가 `scene` 배열이 있는 결과를 같은 SAVEPOINT 안에서 `ModelStore.store`로 나누고 행에는 `modelStore: 'manifest'`를 둔다(`MODEL_STORE_UNSUPPORTED`는 JSON 유지, `scene`이 없는 결과는 목록을 지움). `parentId`는 같은 `linkId`(없으면 같은 문서)의 직전 성공 Sync, `documentRevision`은 `sourceDocument.revision`. `get`·`list({full})`은 목록으로 다시 만들고, `pruned`는 `scene: []`·`modelPruned: true`. `list`·`summary`는 `rows()`로 `objects`를 붙이고 캐시 키에 목록 `revision`을 더했다. 새 `model`·`brief`(작은 결과만)·`applyDelta`(제자리 또는 복사본). `purge` 뒤 `sweep`.
- `LiveSync.apply`: `brief`로 기준 확인, 옮기지 않은 기준은 그 자리에서 옮긴 뒤 적용. `sdk.liveSync`는 변경 페이지와 `survey`·`sourceDocument`만 돌려준다. `displayCoverage`는 바뀐·지운 키의 저장된 항목만 풀어 이전 값에서 고쳐 센다(정의 표시 여부가 바뀐 때만 전체를 센다). 응답 모양은 같고 `displayRevision`·`timing`을 더했다.
- `server.ts`: 단건 VGT1은 `ModelView.geometry`, `GET …/requests/:r/delta?since=&base=`, 직전 측정은 `previousMeasurements`(SQL·meta), 합치기 재사용 판단은 `summary`. `sync-reads.ts`·`jig-routes.ts`는 `list()`. `agent-tools`의 `links_layers`·`sync_sample`은 `rows`·`sceneMeta`(형상 없음). `zwcad-sdk-execution`의 보호 객체 비교는 양쪽을 `storedItem`으로 바꾼 뒤 비교.
- 실행 기준(`execution.ts` `parsedModel`, `model-context`, `query-page`)은 턴마다 `get` 한 번(목록에서 다시 만들기)으로 두었다. 고정·제출 확인은 형상을 열지 않는다(`large-sync-pins`: 제출 때 `load` 0번, 실행 때 1번).
- 엔진 시작: 주소를 열기 전 `Store.compact()`(남은 빈 공간), 연 뒤 `maintainModels`(전체 `sweep` → `moveRows` → 프로젝트별 `retain` → 한가할 때 VACUUM, 바쁘면 1분 뒤 다시). 옮기기는 행마다 나눠 한다(`moveRowAsync`): 해석 → 200개씩 인코딩 → 판을 먼저 넣고 → 짧은 트랜잭션으로 목록·결과 → 200개씩 대조, 어긋나면 원래 JSON으로 되돌림. 준비 중 행이 바뀌면 다음 시작으로 미룬다.
- 측정(합성 1만 개 객체, 정점 100만 개, 실제 `Workspace`·`LiveSync` 경로, `tests/server/live-sync-storage.test.mjs`):
  - Live Sync(10개 변경·1개 삭제): 전체 4 ms, 엔진 처리 3~4 ms, DB +40 KB, 기준 형상 읽기 0번.
  - 바뀌지 않은 전체 Sync: 저장 약 0.6초, DB +2.9 MB(합성 키). Rhino GUID 키로는 약 4.0 MB(색인을 줄여도 3.1 MB). **목표 약 1 MB에는 못 미친다.** 줄 하나가 `requestId`(36 B)를 본표와 두 색인에 반복하고 `versionId`가 64자 16진이기 때문이다. 1 MB에 가까이 가려면 목록 줄을 정수 목록 번호·32 B 지문으로 바꾸는 schema 변경이 필요하다(사용자 결정).
  - 처음 저장 약 0.65초 가운데 약 0.3초는 목록 줄의 외래 키 확인(`object_versions`가 형상을 품은 WITHOUT ROWID 표라 조회가 느림)이다.
  - 옮기기(파일 DB, 35 MB JSON 행 8개 = 268 MB): 합계 27초(행당 3~4초), 이벤트 루프 최대 멈춤 약 0.7~1.2초(목록 트랜잭션·VACUUM), VACUUM 0.8초, 268 MB → 81 MB.
  - 사용자 DB 사본(2026-10-02, 676 MB, Sync 행 20개 중 큰 행 9개): 옮기기 34초, 실패 0, 큰 행 9개 모두 다시 만든 objects·scene 개수와 ID 목록이 원래와 같음, VACUUM 0.75초, 676 MB → 119 MB. 한 행을 모델째 다시 만드는 `get`은 약 1초(옮기기 전 JSON 해석과 비슷).
- 시험: 새로 `tests/core/model-store-wiring.test.mjs`, `tests/server/live-sync-storage.test.mjs`, `tests/server/request-delta.test.mjs`. 고침 `tests/core/model-move.test.mjs`(나눠 옮기기·되돌리기·보존·VACUUM), `tests/server/live-sync.test.mjs`(새 `liveSync` 반환), `tests/server/large-sync-pins.test.mjs`(`load` 횟수). 나머지 표의 시험(capture·sync-coalesce·zwcad-*·query-page·sdk-execution·workspace-list·migrations)은 고치지 않고 통과.
- 남음: 사용자 DB 사본(`.vide/` 아래)으로 옮기기 시간·크기 측정, 설치본 확인, ARCH-01 §5 문구 정리(아래 다른 점).
- ARCH-01 §5와 다른 점: 판을 목록보다 먼저 넣는 나눠 옮기기(대조는 커밋 뒤, 어긋나면 되돌림), 기준이 옮겨지지 않은 Live Sync는 그 자리에서 옮김, `pruned` 읽기 모양(`scene: []`·`modelPruned`).

요지:
- **객체 판:** 객체 하나의 표시 형상과 속성이다. 내용 지문으로 이름 붙이고 한 번만 저장한다. 형상은 지금의 VGT1 형식(배열마다 float64 원점 + float32 차이)으로 둔다. 같은 모델(객체 1만 개, 정점 100만 개) 실측: JSON 64.8 MB → 18.2 MB, 만들기 254 ms → 13 ms, 읽기 105 ms → 1 ms, 오차 0.001 mm.
- **Sync 목록:** 그 시점의 (객체 ID → 객체 판) 목록과 부모 Sync, 문서 변경 번호를 가진다.
- **전체 Sync**는 바뀌지 않은 객체에 기존 판을 가리킨다. **Live Sync**는 바뀐 판과 목록의 그 줄만 쓴다. 다른 요청이 참조 중인 Sync면 목록만 복사한 새 Sync를 만든다.
- 기존 결과는 백업 1개 뒤 한 행씩 옮기고 VACUUM한다. `Workspace.get`과 요청 API는 지금 모양을 유지한다.

**구현 순서:**
1. 형식(`src/contracts/geometry-transfer.ts`): `encodeGeometry`의 항목 단위 `pack`을 `encodeItem(item) → {meta, geometry}`·`decodeItem(meta, geometry)`로 꺼내고, 객체별 VGT1을 이어 붙여 기존 VGT1 응답을 만드는 `joinGeometry`를 더한다. 지문 함수 `versionId(kind, meta, geometry)`(키 정렬 JSON + SHA-256).
2. 스키마(`src/core/migrations.ts`): schema 9에 `object_versions`·`sync_manifests`·`sync_manifest_items`·`sync_manifest_removed`와 색인. `schemaVersion` 9.
3. 저장소(`src/core/model-store.ts`, 새): `storeModel(projectId, requestId, result, parentId)`, `applyDelta(projectId, requestId, delta, patch)`, `copyManifest(from, to)`, `loadModel(requestId)`(전체), `ModelView`(지연: `keys`·`object`·`scene`·`rows`·`geometry`), `deltaSince(requestId, since, base?)`, `sweepVersions(projectId, candidates?)`.
4. `Workspace`(`src/core/workspace.ts`): `update`(466~484행)가 `scene` 배열이 있는 결과를 `storeModel`로 나눠 쓴다. `decode`(21~31행)·`get`(186~195행)·`list({full})`(104~107행)은 `modelStore: 'manifest'`면 `loadModel`로 채운다. `withoutGeometry`·`#light`·`summary`(36~44, 113~139행)는 형상 없이 `meta`의 `object`만 모으고 캐시 키에 목록 `revision`을 더한다. `purge`(155~178행) 뒤 `sweepVersions`. 새 `model(projectId, id)`.
5. Live Sync(`src/server/live-sync.ts:86-117`, `src/server/sdk-execution.ts:305-340`): `sdk.liveSync`는 기준 모델 대신 기준 `sourceDocument`만 받아 변경분(`delta`)과 작은 필드만 돌려준다(전체 병합 `applyDisplayDelta` 제거). `LiveSync.apply`는 `summary`로 기준을 확인하고, 참조 중이면 `captureInput` 새 행 + `copyManifest`, 아니면 제자리 `applyDelta`. 응답 모양은 그대로.
6. 무거운 읽기를 지연 조회로 바꾼다(아래 표의 '바꿈'). 나머지는 `get`이 같은 모양을 주므로 그대로 두고 시험으로 확인한다.
7. API(`src/server/server.ts`): 단건 VGT1 응답(2159~2163행)을 `joinGeometry`로 만들고, `GET …/requests/:r/delta?since=&base=`를 더한다(2단계 알림용). 목록 응답(2180~2190행)은 그대로.
8. 옮기기(`src/core/model-move.ts`, 새, `src/server/main.ts`에서 주소를 연 뒤 시작): 행마다 트랜잭션·대조·기록, 끝나면 한가할 때 VACUUM(`Store.compact` 강제), 남은 행은 다음 시작에 이어서. 프로젝트 삭제(`src/core/store.ts:242`)는 목록·판도 지운다.
9. ARCH-01 §5·§6 「PC 프로그램」(VGT1 저장 문구)·§7을 구현 결과에 맞춘다.

**`scene`·`objects`를 읽는 곳(2026-10-02 HEAD 기준):**

| 위치 | 하는 일 | 1단계 처리 |
|---|---|---|
| `src/server/server.ts:1254`, `src/core/measurement-cache.ts:14-35` | 직전 Sync의 측정 재사용. 프로젝트 전체를 `list({full: true})`로 해석 | 바꿈: 직전 목록의 `meta`만 SQL로 |
| `src/server/sync-reads.ts:49`, `src/server/jig-routes.ts:898` | 파일 항목의 마지막 불러오기 찾기에 `list({full: true})` | 바꿈: `list()`(형상 없음) 뒤 필요한 한 행만 |
| `src/server/server.ts:1277`, `1291` | 합치기 재사용 판단에 `get`(documentHash만 필요) | 바꿈: `summary` |
| `src/server/live-sync.ts:86-117` | 기준 전체 해석·병합·재기록 | 바꿈(순서 5) |
| `src/server/server.ts:2159-2171` | 단건 조회(VGT1·JSON) | 바꿈: VGT1은 `joinGeometry` |
| `src/server/execution.ts:183-197`(`parsedModel`), `1153`, `1232`, `1316-1320`, `1535-1553`; `src/server/agent-tools.ts:1016`; `src/server/model-context.ts:9`; `src/server/query-page.ts:59-84` | 실행 기준·AI 도구·질의의 객체별 조회 | 바꿈: `model()`의 `object`·`scene`·`rows`(가능한 곳부터), 나머지는 `get` 유지 |
| `src/core/quantities.ts:47-49`, `src/core/reviews.ts:106-135`, `src/core/comparison.ts:45-49`, `src/core/extensions.ts:155`, `src/server/report.ts:94`, `src/core/publication.ts:42-49`, `src/server/offline-snapshot.ts:146` | 수량·검토본·비교·확장·보고서·웹 게시·오프라인 보기 | 그대로(`get`). 시험으로 확인 |
| `src/server/zwcad-sdk-execution.ts:44-45`, `435` | 저장된 `scene` 항목과 새 항목을 JSON 문자열로 비교 | 바꿈: 같은 float32 변환 뒤 비교(또는 지문) |
| `src/server/server.ts:1505-1506`, `1592-1607`; `src/server/jig-routes.ts:744`, `866`; `src/jigs/sync.ts:73`; `src/jigs/structure/input.ts:215`, `249`; `src/jigs/runtime/runtime.ts:148-168`, `568`; `src/jigs/bake/plan.ts:262` | Sync jig·구조 jig·jig 실행 입력 | 그대로(`get`). 1607행은 `sceneOmitted`도 받으므로 유지 |
| `src/server/sdk-execution.ts:564` | 직전 모델 측정 전달 | 그대로 |
| SQL로 `result` 읽기: `src/core/workspace.ts:53`, `src/server/project-removal.ts:73-75`, `src/server/capture-cleanup.ts:83-84`, `src/server/conversations.ts:570`, `src/server/offline-view.ts:93` | 작은 필드만 읽음 | 그대로(옮긴 뒤 더 빨라짐) |
| 화면: `src/ui/app/links-sync.ts`의 `refreshDisplay`(Live Sync 병합)·`visibleLayers`·`showLayers`(레이어 합성), `src/ui/history.tsx:113`, `src/ui/inspector.ts:289`, `src/ui/native-attributes.ts:51` | 받은 결과로 표시 | 1단계는 그대로(응답 모양 같음). 3단계(T-085)에서 바꿈 |

**시험:**
- 새로:
  - `tests/core/model-store.test.mjs`: 판 중복 제거, 지문 안정성, `applyDelta` 추가·변경·삭제, 복사본 revision 승계, 참조 없는 판 정리, 프로젝트 삭제.
  - `tests/core/model-move.test.mjs`: 옛 JSON 행을 옮긴 뒤 `get` 결과가 같은 float32 변환 뒤 원본과 같음, 중간 종료 뒤 이어 옮기기, 대조 실패 시 행 유지.
  - `tests/server/live-sync-storage.test.mjs`: 객체 1만 개 합성 기준에서 Live Sync 한 번이 기준 형상을 해석하지 않고 DB가 바뀐 판만큼만 늘어남, 처리 시간 기록.
  - `tests/server/request-delta.test.mjs`: `delta?since`·`base`·`full`.
- 고침: `tests/core/migrations.test.mjs`(schema 9), `tests/core/workspace-list.test.mjs`(형상 없는 목록·캐시 키), `tests/core/geometry-transfer.test.mjs`(`encodeItem`·`joinGeometry`가 기존 `encodeGeometry`와 같은 결과로 풀림), `tests/server/live-sync.test.mjs`(제자리·복사본 저장 확인을 목록으로), `tests/server/large-sync-pins.test.mjs`(형상 해석 0번 유지), `tests/server/capture.test.mjs`, `tests/server/sync-coalesce.test.mjs`, `tests/server/zwcad-sdk-execution.test.mjs`·`zwcad-edit.test.mjs`(비교 방식), `tests/server/query-page.test.mjs`, `tests/server/sdk-execution.test.mjs`(`liveSync` 인자).
- 그대로 통과 확인: `tests/core/{comparison,quantities,reviews,publication,extensions,measurement-cache,sync-jig,display-delta}.test.mjs`, `tests/sharing/*`, 통합 `browser-live-sync`·`browser-large-native`·`rhino-large-sync`·`rhino-sync-perf`.

**검증:**
- 이전 전후 같은 요청의 객체·형상 동일성(지문)
- 사용자 DB 사본(`.vide/` 아래)으로 옮기는 시간, 옮긴 뒤 DB 크기, VACUUM 시간
- 위 기능들의 기존 시험
- Live Sync 한 번의 엔진 처리 시간(목표: 객체 수와 무관하게 100 ms 안팎), 바뀌지 않은 문서의 전체 Sync 한 번의 DB 증가(목표: 약 1 MB)

## 2단계 — Sync를 엔진이 주관 (T-084)

**상태(2026-10-02): SPEC-01.11의 10(Sync 주관)과 ARCH-01 §7 「엔진 주관 Sync(T-084)」 사용자 확인. 구현·자동 검증(미커밋, 아래 결과).** 확인한 세부: VIDE 창이 없어도 엔진이 Live 파일을 Sync한다. ⟳·지금 Sync·플러그인 Sync는 진행 중인 자동 Sync에 합류하지 않고 새로 읽는다. 편집 중 실패(`SOURCE_CHANGED`, 호스트 바쁨)는 30초까지 다시 하고 그 뒤 다음 변경이나 ⟳를 기다리며, 행에는 '변경 중 · 곧 다시 Sync'를 보인다. 초안 보류는 화면의 5초 임대로 한다. 화면 쪽은 1단계의 `delta` 조회를 쓰므로 1단계 순서 7 뒤에 바꾼다. 엔진 쪽 스케줄러(순서 1~4)는 1단계와 나란히 시작할 수 있다.

- 엔진이 연결된 문서의 변경 번호를 직접 보고, 문서당 한 번 전체 Sync·Live Sync를 한다.
- 같은 문서의 동시 Sync는 하나로 합친다.
- 데스크톱 창·Rhino 패널·브라우저 탭은 결과 알림만 받는다(연결 목록 조회에 상태·표시 revision을 더함).
- 초안·고정·실행 중 작업에 따른 자동 갱신 보류는 엔진이 판단한다(SPEC-01.11 6).
- Sync 중 편집으로 `SOURCE_CHANGED`가 나면 잠시 뒤 다시 한다(30초까지).
- AI가 문서를 고치는 중에는 Sync가 기다린다.

**구현 순서:**
1. `src/server/server.ts:1204-1292`의 전체 Sync를 `runDocumentSync`(`src/server/document-sync.ts`, 새)로 빼고 `POST …/capture`는 이를 부른다(동작 같음).
2. `src/server/sync-scheduler.ts`(새): 1초 주기, 문서별 상태, 첫 Sync·변경·다시 연 Live 파일 판단(옛 화면 `pollLinks`의 규칙, 지금 `src/ui/app/links-sync.ts`), Live Sync·전체 Sync 선택, 재시도(1·2·4·8초, 최대 30초), 보류 판단(요청 기준·`holdWrite`·바로 적용·화면 임대). `src/server/main.ts`·`server.ts`에서 시작·종료.
3. 보류 임대: `GET …/links?page=&hold=`를 받아 페이지별 5초 임대. 연결 행에 `sync`·`display`를 더한다(`server.ts:895-925` 부근).
4. `LiveSync`(`src/server/live-sync.ts`): `latest` 맵을 스케줄러와 함께 쓰고, 같은 키의 실행 중 전체 Sync를 기다린다.
5. 화면(당시 `src/ui/app.ts`, T-113 뒤 `src/ui/app/links-sync.ts`): `pollLinks`의 자동 Sync 시작과 `liveSyncHostDocument`의 `POST …/live-sync` 호출을 지운다. 연결 행의 `display.revision`이 늘면 `delta?since=`로 받아 `applyDisplayDelta`로 합친다. `syncHeld`는 초안 임대 보고로만 남기고, `syncLink`는 ⟳(`manual`)만 남긴다. 행 표시(`linkNotes`)는 `sync.state`에서 만든다.
6. Rhino 패널·ZWCAD 팔레트는 같은 페이지이므로 5로 함께 바뀐다(플러그인 수정 없음).

**시험:**
- 새로: `tests/server/sync-scheduler.test.mjs`(가짜 편집기 목록으로 확인): 변경 한 번에 Sync 한 번, 화면 0·3개에서 같음, 보류 중 Sync 없음과 풀린 뒤 한 번, `SOURCE_CHANGED` 뒤 재시도·30초 뒤 대기, AI 쓰기 중 대기, ⟳는 합류하지 않음.
- 고침: `tests/server/sync-coalesce.test.mjs`, `tests/server/live-sync.test.mjs`, 통합 `tests/integration/browser-live-sync.mjs`(화면이 `/live-sync`를 부르지 않고 알림으로 갱신)·`browser-links`·`browser-rhino-panel`.

**검증:**
- 창과 패널을 함께 연 상태에서 Rhino 변경 한 번에 Sync·Live Sync가 한 번만 일어나는지(엔진 기록 `sync-scheduler`·`live-sync`)
- 기존 `browser-live-sync`·`browser-links`·`browser-rhino-panel`

**결과(2026-10-02) — 구현·자동 검증(미커밋), 실제 Rhino 확인 남음:**
- 순서 1: `runDocumentSync`(`src/server/document-sync.ts`). `POST …/capture`는 이를 부르고 `fresh`를 기본값으로 둔다(이제 이 경로로 오는 Sync는 모두 사용자 것).
- 순서 2: `SyncScheduler`(`src/server/sync-scheduler.ts`). 1초마다 열린 문서(0.7초 안의 읽기는 연결 목록과 함께 씀)를 `matchLinks`로 맞추고, 문서별 상태로 첫 Sync·`generation` 증가·다시 연 Live 파일을 판단한다. Rhino 표시 Sync가 기준이면 Live Sync(`resync`면 전체 Sync), 아니면 전체 Sync. `SOURCE_CHANGED`·`HOST_BUSY`·`PROJECT_BUSY`·`WORKSPACE_CAPACITY`는 실패 행을 지우고 1·2·4·8·…초 뒤(합계 30초 안) 다시, 그 뒤 `waiting`으로 다음 변경을 기다린다. ⟳로 새 Sync가 생기면 대기를 푼다. 호스트가 바쁘면 건너뛴다. VIDE가 연 작업 사본 창은 첫 Sync만 한다. 창이 없어도 돈다(`server.ts`에서 시작·종료).
- 순서 3: `GET …/links?page=&hold=` 5초 임대, 연결 행에 `sync {state, code?, at}`·`display {requestId, revision}`.
- 순서 4: `LiveSync`는 같은 문서의 실행 중 전체 Sync(`documentSyncs.current`)를 기다린 뒤 판단한다. `latest` 맵은 그대로 LiveSync 안에 있고 스케줄러는 연결의 마지막 성공 Sync를 기준으로 넘긴다.
- 순서 5·6: 화면은 자동 `capture`·`/live-sync`를 부르지 않는다. 연결 목록의 `display.revision`이 늘면 `…/delta?since=`로 바뀐 객체만 받아 `applyDisplayDelta`로 합치고(`full`이면 다시 받음), 요청 ID가 바뀌면 그 요청을 받는다. 초안이 쓰는 파일만 `hold`로 보내고(초안이 없으면 질의 문자열 없음), 행 문구는 `sync.state`에서 만든다. Rhino 패널도 같은 페이지라 함께 바뀌었다. 대화별 초안 코드는 그대로다.
- 시험: 새로 `tests/server/sync-scheduler.test.mjs`(변경 한 번에 한 번, 화면 0·3개와 임대, 요청·AI 쓰기 보류, 재시도·30초 대기·⟳, 호스트 바쁨, 작업 사본 첫 Sync). 통합 `browser-live-sync`(엔진 역할을 시험이 하고 화면은 Sync를 시작하지 않음·`delta`만·임대·상태 문구·메시 받는 중 재열기), `browser-links`·`browser-rhino-panel`·`browser-attached-sync`·`browser-pin-tokens`(첫 Sync를 엔진 쪽에서 쓰도록, 연결 목록 경로를 질의 문자열 포함으로) 고침.
- 다른 점: 화면 Sync 실패의 '오류 기록' 확인 대신 행 문구로 원인을 보인다(`browser-attached-sync`). 창이 숨겨진 동안(`document.hidden`)은 목록 조회를 쉬므로 초안 임대가 5초 뒤 풀린다.
- 남음: 실제 Rhino 창·패널을 함께 연 상태의 한 번 확인(엔진 기록 `sync-scheduler`·`live-sync`), 실 호스트가 필요한 `browser-owned-editor`·`browser-zwcad-editor`는 돌리지 않았다.

## 3단계 — 화면 (T-085)

**담당(2026-10-06 사용자 결정):** [PLAN-28](PLAN-28-stock-first.md) T-123과 한 세션에서 함께 한다. 화면 구조는 T-113의 React 셸을 유지한다(조각에서 그리고, 뷰포트는 `#canvas` 안에서 명령형). 물리 계약은 ARCH-01 §1.1 「웹 화면 구조」와 §7 「엔진 주관 Sync」.

| 항목 | 변경 | 위치 |
|---|---|---|
| 바이너리 그대로 | `decodeGeometry(…, {typed: true})`: 좌표는 응답 버퍼 위의 `Float32Array`(배열 원점 `origin`을 붙임), 색인은 `Uint16Array`/`Uint32Array` 그대로. 뷰포트는 이 배열을 그대로 `BufferAttribute`로 올리고 원점을 물체 위치로 둔다. 숫자 배열(`number[]`)도 지금처럼 받는다 | `src/contracts/geometry-transfer.ts`, `src/ui/gateway.ts`, `src/ui/viewport.ts`, `src/core/display-coordinates.ts` |
| 바뀐 객체만 | Live Sync(`update`)는 바뀐·지운 객체가 든 그리기 묶음만 다시 만들고 새 객체만 칠한다(지금은 묶음 전체를 다시 만듦). 레이어 합성은 바뀌지 않은 항목을 다시 만들지 않는다 | `src/ui/viewport.ts`, `src/ui/app/links-sync.ts` |
| 안 보이는 Sync 버리기 | 레이어에 없는 결과의 `scene`·`definitions`(표시 Sync는 `objects`도)를 메시지에서 지우고 `sceneOmitted`로 둔다. 다시 보일 때 받는다 | `src/ui/app/links-sync.ts` |
| Rhino 패널 | 패널 모드는 뷰포트(WebGL)를 만들지 않고 형상을 받지 않는다. 객체 줄이 필요하면 `…/objects`로 받는다 | `src/ui/app/viewport.ts`, `boot.ts`, `links-sync.ts` |
| 선택 색인 | 화면 객체를 ID로 찾는 색인(`objectById`)을 두고, 선택 정리·고정 가능 판단·선택 칠하기의 `find`·`some`·`includes` 제곱 계산을 없앤다 | `src/ui/model.ts`, `src/ui/app/viewport.ts`, `composer.ts` |
| 다시 시도·시간 제한 | 모든 `api` 호출에 시간 제한(일반 30초, 형상 120초, 넘으면 `NETWORK_TIMEOUT`). 작업 상태 확인(`poll`)은 실패해도 1.2초에서 10초까지 늘려 가며 계속하고 알림은 한 번만. 연결 목록·변경분 조회는 다음 주기에 다시 함 | `src/ui/gateway.ts`, `src/ui/app/thread.ts`, `links-sync.ts` |
| 객체 줄을 따로 받기 | 목록에서 빠진 표시 Sync의 `objects`가 필요한 곳(패널 고정·선택, 초안 복원, 복구·연계 후속 초안)은 `…/objects`로 받거나 엔진의 확인에 맡긴다 | `src/ui/app/boot.ts`, `draft-storage.ts`, `model.ts`, `linked-draft.ts` |

**시험:** 통합 `tests/integration/browser-large-sync.mjs`(새, 합성 1만 개·정점 100만 개, `--measure`는 숫자만): Live Sync 엔진 처리, 화면의 가장 긴 주 스레드 작업, 전체 Sync 5회 뒤 힙·GPU 버퍼, 전체 선택 뒤 키 입력, 목록 응답 크기. 고침: `browser-live-sync`·`browser-links`·`browser-rhino-panel`·`browser-viewport-display`·`browser-large-model`, `tests/core/geometry-transfer.test.mjs`.

**검증:** 합성 1만 개 모델로 전체 Sync 5회 뒤 화면 메모리 증가가 없을 것, Live Sync 한 번에 주 스레드 멈춤 50 ms 이하, 전체 선택 키 입력 지연(전후 측정).

**착수 전 측정(2026-10-06, `0c3b184`, 헤드리스 Chrome·SwiftShader, `browser-large-sync.mjs --measure`):** 첫 표시 2.6초(가장 긴 작업 1,084 ms), Live Sync 10개 엔진 10 ms·화면 가장 긴 작업 135 ms, 전체 선택 1.6초·그 뒤 글자 입력 1.39초(가장 긴 작업 784 ms), 전체 Sync 5회 동안 힙 348 → 602 MB(회당 약 64 MB), 요청 목록 9.2 MB(Sync 6개).

**결과(2026-10-06) — 구현·자동 검증, 실제 Rhino 패널 확인 남음.** 같은 시험(`browser-large-sync.mjs`, 이제 `test:browser`에 포함)으로 잰 값:

| 항목 | 착수 전 | 후 |
|---|---|---|
| Live Sync 10개, 엔진 처리 | 10 ms | 12~16 ms |
| Live Sync 10개, 화면 가장 긴 주 스레드 작업 | 135 ms | 50 ms 넘는 작업 없음 |
| 전체 선택 | 1.6초 | 0.15~0.2초 |
| 전체 선택 뒤 글자 입력 | 1.39초(가장 긴 작업 784 ms) | 20~35 ms(50 ms 넘는 작업 없음) |
| 전체 Sync 5회 동안 화면 힙 | 348 → 602 MB | 83 → 94 MB(첫 회 뒤 변화 없음) |
| 전체 Sync 5회 동안 GPU 버퍼 | 40,124(전체 선택 뒤 객체마다 따로 그림) | 164 그대로 |
| 요청 목록(Sync 6개) | 9.2 MB | 5.8 KB |
| 첫 표시(가장 긴 작업) | 2.6초(1,084 ms) | 2.4초(약 750 ms) |

- 바뀐 것: 위 표의 항목 그대로다. 더해서, Live Sync 갱신이 묶음을 다시 만들 때 평행이동만 있는 물체는 행렬 곱 없이 오프셋만 더하고, 레이어 합성은 바뀌지 않은 줄과 항목을 다시 만들지 않는다. 선택된 물체도 선택 색으로 묶음 안에서 그린다(반투명 표시만 따로). 패널은 연결 목록이 알려 주는 Sync를 `?view=summary`로 받고 객체 줄만 `…/objects`로 받으며, Live Sync는 변경분으로 줄만 고친다.
- 검토 반영(2026-10-06): 패널은 변경분을 형상 없이(`…/delta?view=rows`) 받고, 작업 상태 확인은 `?view=summary`로 하며 약 10분 실패하거나 같은 거절이 오면 멈춘다. 쓰기 요청이 10분을 넘기면 `ACTION_TIMEOUT`으로 작업 이력을 보라고 알린다. 안 보이는 Sync를 버릴 때 초안의 기준·핀의 Sync는 남긴다. 나머지는 [PLAN-28](PLAN-28-stock-first.md) T-123 「검토 반영」.
- 남음: 첫 표시의 가장 긴 작업(약 750 ms, 메시 1만 개 만들기·법선 계산·묶음 만들기)은 이번 기준 밖이라 그대로다. 실제 Rhino 창·패널에서의 확인.

## 4단계 — 상한 (T-086)

원칙: 평소 작업에서 상한에 걸려 불편이 생기지 않게 넉넉히 둔다. 넘어도 작업 전체를 실패시키지 않고, 그 부분만 줄여서 알린다. 문제가 생기면 고친다(2026-10-01 사용자 결정).

| 항목 | 지금 | 바꿀 값 | 넘으면 |
|---|---|---|---|
| 요청당 고정 객체 | 100 (`workspace.ts`, `draft-storage.ts`, 화면) | 10,000 | AI에는 상세 200개와 나머지 ID·레이어 요약을 보내고, AI가 필요하면 조회한다 |
| Rhino 고정 목록 | 5,000 | 10,000 | 알림 |
| Rhino 선택 보고 | 2,000 (`AttachedConnection.cs`) | 20,000. ID는 선택이 바뀔 때만 보낸다 | 개수만 보고 |
| 문서당 객체 | 20,000 (`WorkerScene.MaxObjects`, 넘으면 Sync 실패) | 200,000 | 알림 |
| Sync 하나 전체 | 128 MB (`editor-channel.ts`, 넘으면 Sync 실패) | 총량 상한 없앰 | — |
| 객체 하나의 형상 | 없음 | 바이너리 64 MB | 그 객체만 상자로 표시하고 알림 |
| 한 번에 주고받는 묶음 | 페이지 1,000개 | 16 MB 묶음으로 자동 분할 | 나눠 받음 |
| AI 실행 결과 목록 | 2,000 (`DirectExecution.MaxListed`) | 20,000 | 개수만 보고 |
| 스케치 좌표 | ±100 km (`workspace.ts` `coordinate`) | 유한한 값이면 허용 | — |
| jig 입력 객체 | 50,000 (`jig-routes.ts`) | 200,000 | 알림 |
| 그대로 둠 | 본문 2만 자, 첨부·스케치·요청 목록 각 100, 턴당 이미지 3 | — | 평소 작업에서 걸리지 않음 |

상한을 올리기 전에, 그 값을 감당하는 경로(1~3단계)가 먼저 있어야 한다.
- 고정 10,000은 고정마다 기준 Sync 전체를 해석하던 문제(RESEARCH-13 §2)가 1단계로 풀린 뒤에 올린다.
- 객체 200,000은 2·3단계 뒤에 올린다.

## 5단계 — 정리 (T-087)

- 아무 Sync 목록도 가리키지 않는 객체 판을 지운다.
- 옛 Sync 목록은 문서마다 최근 20개와 참조된 것(핀·요청 입력·기준, 검토본·비교·웹 게시·공유 의견, jig 읽기·만들기, 대화 기록)만 남기고, 그 밖의 목록을 지운 뒤 참조 없는 판을 지운다(2026-10-02 사용자 결정, 1단계로 앞당김, 규칙은 ARCH-01 §5 「정리」, `ModelStore.retain`).
- 그 밖의 정리:
  - 이전 백업(`vide.sqlite.backups`)은 최근 2개만 남긴다.
  - `rhino-connections` 사본과 `sdk-models` 작업 폴더도 정리한다.
  - WAL 크기를 제한한다.
- 15초마다의 heartbeat가 결과 표를 훑지 않게 색인을 둔다.

**먼저 한 부분(2026-10-01, 사용자 요청) — 구현·단위 시험, 설치본 확인 남음:**
- `rhino-connections` 사본·`sdk-models` 작업 폴더 정리를 앞당겨 했다.
  - 사본(.3dm)은 작업 사본이 읽은 직후 지운다.
  - 영수증(.capture.json)은 그 사본으로 만든 후보를 더 적용할 수 없을 때 지운다. 후보 없이 끝난 실행이나 적용이 끝난 때(성공·실패)다.
  - 가져오기 폴더는 실행이 끝나면 지운다. 복구 확인 폴더도 같다.
  - 엔진 시작 때 하루 지난 사본·영수증·작업 폴더와 끝난 세션 폴더를 지운다. 끝나지 않은 요청·적용이 가리키는 것, 열린 편집 사본, 링크·정션은 건너뛴다.
  - 파일: `src/server/capture-cleanup.ts`(새), `sdk-execution.ts`, `attached-application.ts`, `server.ts`, `tests/server/capture-cleanup.test.mjs`·`capture-release.test.mjs`(새).
- 문서 Sync 합치기: 같은 문서의 자동 Sync는 실행 중인 것에 합류한다. 끝난 지 2초 안이고 문서 revision이 같으면 그 결과를 다시 쓴다. ↻·지금 Sync는 항상 새로 읽는다(`src/server/sync-coalesce.ts`, `server.ts`, `src/ui/app.ts`).
- 읽기 전용 감지 기록: 연결 문서가 `readOnly`이면 문서·Rhino 세션마다 한 번 `document-read-only`를 엔진 기록에 남긴다. 속성·잠금 파일·Rhino 프로세스·파일 점유 프로세스(Restart Manager)를 함께 남기고 화면에는 보이지 않는다(`src/server/read-only-watch.ts`, `hosts/rhino/editor-sessions.ts`).

## 6단계 — Rhino·ZWCAD 쪽 (T-087에 포함)

- AI 코드 실행에 시간 제한과 취소를 둔다. 끝나지 않으면 Rhino를 멈추지 않고 실패로 돌린다.
- Rhino 패널·ZWCAD 팔레트의 WebView에 0단계와 같은 화면 복구를 넣는다.
- ZWCAD의 시간 초과 뒤 늦게 실행되는 쓰기를 막는다.
- 구조 해석 코어는 작업 스레드에서만 부른다.

## 7. 엔진 언어

TypeScript(Node)를 유지한다.
- Rust·C++는 계산 자체가 무거운 부분(구조 해석은 이미 Rust, 간섭 검사·공간 색인·메시 처리 등)에만 측정 후 붙인다.
- 네이티브 코드는 엔진 프로세스 밖이나 작업 스레드에서 돌린다. 그래야 그쪽 충돌이 엔진을 끝내지 않는다(RESEARCH-13 §1).

## 완료 기준

- **0단계:** 다음 엔진 종료에서 종료 코드가 기록되고, 화면·엔진이 꺼진 채 남지 않는다.
- **1~3단계:** 객체 1만 개 문서에서 아래를 만족한다. 0단계 기록으로 확인한다.
  - Live Sync 한 번에 엔진·화면 멈춤이 각각 100 ms·50 ms 안팎이다.
  - 창과 패널을 함께 열어도 Sync가 한 번이다.
  - 전체 Sync를 반복해도 DB와 화면 메모리가 변경분만큼만 는다.
- **4단계:** 위 표의 상한이 반영된다.
- **5·6단계:** 각 항목이 반영되고, PLAN §6.5와 설치본 릴리스가 갱신된다.
