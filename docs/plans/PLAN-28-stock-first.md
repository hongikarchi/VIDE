---
id: PLAN-28
title: 순정 우선 — 상한·자체 도구 정리, 모델 전체 JSON 전송 제거, 프로젝트별 DB
status: draft
version: 0.5
updated: 2026-10-06
owner: agent:claude
related: [ADR-031, ADR-032, RESEARCH-14, PLAN-27, SPEC-02, ARCH-01]
---

# 순정 우선 (T-120~T-125)

근거: [ADR-031](../decisions/ADR-031-stock-first.md)(순정 우선), [ADR-032](../decisions/ADR-032-per-project-database.md)(프로젝트별 DB), 대조 목록 [RESEARCH-14](../research/RESEARCH-14-stock-first-audit.md). 화면·저장 경로가 [PLAN-27](PLAN-27-sync-storage-stability.md)(T-085·T-086)과 겹치므로, 그 작업을 하는 세션과 파일이 겹치는 항목은 그쪽이 끝난 뒤 진행한다(2026-10-02 사용자 선택: "겹치지 않는 것부터").

## T-120 엔진 쪽 즉시 수정 (겹치지 않는 것)

| 변경 | 위치 |
|---|---|
| AI 도구 오류: 대문자 오류 코드는 그대로 전달(`AGENT_TOOL_FAILED`로 가리지 않음), `HOST_RESULT_TOO_LARGE` 힌트 추가. 코드 없는 예외 문구는 계속 감춤 | `src/server/agent-tools.ts` |
| 결과 미확인 알림의 다음 행동: 조회가 실패하면 실행 안에서 상태를 확인하라고 안내하고, 다음 실행은 돈다고 알림 | `src/server/direct-mode.ts` |
| 적용된 실행의 본문 전문을 요청 결과에 남김(`executions[].body`, 대화 장부에는 넣지 않음) | `direct-mode.ts`, `execution.ts` |
| ⟳ 응답(`POST …/capture`)은 형상 없는 요청(`summary`, 객체 줄)만 보냄. 화면은 `sceneOmitted`를 보고 형상을 VGT1로 받음(기존 경로) | `src/server/server.ts` |
| Sync 문서 총량 상한 제거(작업 사본 32MB, 연결 창 128MB). 페이지마다 한 응답(16MB) 검사는 유지 | `hosts/rhino/scene-pages.ts`, `editor-channel.ts` |

**검증:** 타입 검사, 관련 서버 시험(`agent-tools`, `direct-mode`, `scene-pages`, capture 경로), 전체 `npm test`. 실호스트 확인(1만 객체 문서의 Sync·⟳·AI 조회)은 설치본에서 한다.

**완료 기준:** 위 변경이 시험을 통과하고 main에 합쳐짐. 설치본에서 큰 문서의 Sync가 총량 때문에 실패하지 않음.

## T-121 상한 정리 (RESEARCH-14 §2, ADR-031 7)

남기는 상한은 셋이다: 호스트 통신 한 덩어리 16MB(넘는 객체 하나는 상자로 표시하고 알림, Sync는 계속), 모델 문맥(CLI 몫), 동시 AI 턴 수(대기). RESEARCH-14 §2의 나머지는 없애거나 넘으면 잘라서 알린다. 같은 값을 여러 층에서 검사하던 것은 한 곳으로 모은다. 범위는 엔진·계약·호스트(C#) 쪽이다. AI 도구 결과·호출 수·턴 시간·이미지는 AI 경로라 T-122가 맡는다. 화면 파일(`src/ui/**`)의 핀·본문 상한 안내는 화면 작업 세션과 순서를 맞춘다(엔진·계약 쪽 상한은 여기서 푼다).

**검증:** 상한을 넘는 합성 입력(객체 3만 개 문서, 핀 1만 개, 긴 본문, 큰 첨부)이 실패하지 않고 처리되거나 잘려서 알려지는 시험. 전체 `npm test`.

**진행(2026-10-02, 엔진·계약·호스트 쪽 구현, main 합치기 전):**

- 객체 수 20,000(C# `WorkerScene.MaxObjects`·`DisplayScene.Listed`·측정 캐시, TS 계약·`scene-pages`·`editor-channel`·jig 입력)과 레이어 범위 2,000을 없앴다. 3dm 가져오기 500·모델 업로드 64MB·첨부 크기/개수·본문 2만 자·인라인 파일 5만 자·요청 저장 200KB·저장 JSON 1MB·핀 100·스케치/획/점 수·편집 창 핀 5,000/선택 2,000·할 일 1,000·검토 200·표 보기 200·jig 진단 원본 8/객체 5만/레이어 픽 8·구조 편집 목록 수도 없앴다.
- 호스트 프레임은 요청·응답 모두 16MB(`HOST_FRAME_BYTES`) 하나로 모았다. 넘는 요청은 보내기 전에 `HOST_REQUEST_TOO_LARGE`. 호출 시간은 600초(`HOST_CALL_MS`, C# `CallTime`). 응답 한 덩어리보다 큰 객체 하나는 경계 상자(`oversized`)로 오고 표시 미지원 안내에 `(16 MB 초과 · 상자로 표시)`로 세어지며 Sync는 이어진다(표시 Sync는 호스트가, 작업 사본 읽기는 `boxOnly` 재조회로).
- HTTP JSON 본문은 메모리 보호로 64MB(`JSON_BODY_BYTES`). 오프라인 스냅샷은 사이트 요청 한도 아래 95MB. 대량 삭제 확인은 500개, 상수 하나(`DIRECT_MAX_DELETES`, `src/contracts/host-documents.ts`)로 모았다.
- AI에는 핀 앞 200개를 그대로, 나머지는 역할·레이어별 수와 ID 요약 하나로 보낸다(`pinContext`). 핀 확인은 Sync마다 ID 집합을 한 번만 만든다.
- 시험: `tests/server/no-caps.test.mjs`(3만 객체 페이지, 큰 객체 하나의 상자, 16MB 넘는 요청, 핀 1만·긴 본문·많은 첨부, 핀 요약, 3만 객체 Sync 위 핀 1,000 저장). 실호스트 확인은 남았다(플러그인 재설치 필요).
- 화면(2026-10-06): 핀 100(`model.ts`·고정 토큰), 본문 2만 자, 스케치 200획·점 2만, 첨부 개수·크기(`attachments.ts`의 `batchRefusal` 삭제), 속성·외부 의견 첨부 한도, 3dm 가져오기 64MB 거절을 화면에서 없앴다. `INPUT_TOO_LARGE` 문구는 수치 없이(엔진의 64MB JSON 보호 등은 남음), 오프라인 스냅샷 문구는 95 MB. 시험 `tests/core/host-selection.test.mjs`(핀 1,500).
- 남은 것: 공유 웹 뷰어의 64MiB 표시 한도(`WEB_MODEL_LIMIT`, `src/sharing/web`)와 ZWCAD 표시 응답 128MiB는 그대로다.

## T-122 순정 도구 (RESEARCH-14 §3~§6, ADR-031 8)

- Claude·Codex의 기본 읽기(Read·Glob·Grep), 셸, 파일 쓰기를 켠다. 작업 범위는 프로젝트 작업 폴더다. 그 밖의 폴더는 그때마다 사용자 승인 카드를 거친다.
- 허용 밖 도구 호출은 턴을 죽이지 않고 그 호출만 거절한다.
- 턴 시간은 출력이 없는 시간만 센다. 큰 도구 결과는 잘라서 `truncated`·이어 읽을 위치와 함께 준다.
- 도구 호출 수·실행 횟수 상한을 없앤다. 이미지 장수·크기는 줄여서 보낸다.
- 처리기가 없는 `status`·`cancel`을 지운다. `file_list`·`file_read`·`attachment_read`는 기본 도구로 대체한다.
- 막는 검사를 알림으로 바꾼다: 결과 미확인, 문서 변경 감지, `uncertain` 뒤 읽기, 병렬 읽기, 스크립트 정책(파일·프로세스 쪽만 유지). 확인 카드는 대량 삭제(기준 상향)와 파일 저장·내보내기만 남긴다.
- Rhino·ZWCAD 문서 변경은 VIDE `execute`로만 한다(되돌리기·기록).

**검증:** 실제 CLI 실행 인자 시험, 허용 밖 호출 시 턴이 계속되는 시험, 출력 없는 시간 제한 시험, 폴더 밖 접근 승인 흐름 시험. 실제 Claude·Codex로 한 번씩 확인.

**진행(2026-10-02, 작업 브랜치):** 구현·시험 완료, main 합침 전.
- **반영:** Claude는 작업 폴더 도구가 있는 턴에서 `--restricted`/`--safe-mode`를 빼고 `Read,Glob,Grep,Edit,Write,Bash`를 미리 허용 없이 켜며 `--add-dir`·`--permission-prompt-tool stdio`로 작업 폴더 밖 사용을 엔진의 `WorkFolderGate`에 묻는다. Codex는 app-server 경로에서 `workspace-write`·`approvalPolicy: untrusted`·셸·code mode로 열고 승인 요청을 같은 게이트에 묻는다(`codex exec`는 승인 통로가 없어 도구 없음). 허용 밖 호출·시작 목록 불일치는 경고만, 턴 시간은 `IdleClock`(출력 없는 시간, 카드·도구 대기 중 멈춤). 도구 결과는 잘라서 `truncated`·`nextOffset`, `capture_view`는 큰 이미지를 줄여 다시 찍음, 패킷 이미지는 20장·5 MB까지(넘으면 안내만). `AGENT_CALL_LIMIT`·`HOST_COMMAND_LIMIT` 제거, 범위 유효 시간은 호출 사이 시간. `status`·`cancel`·`attachment_read`·`file_list`·`file_read` 삭제(첨부는 보관 경로로 읽음). 결과 미확인·문서 변경은 실행 결과의 `notices`, 답 유실 뒤 읽기 허용(`HOST_RESULT_UNKNOWN`), 읽기 도구 병렬, 스크립트 정책은 파일·프로세스·네트워크·코드 적재·문서 닫기·저장·되돌리기 규칙만(엔진·`CodePolicy.cs`·`DirectScripts.cs`), 대량 삭제 기준 500. 오류 코드에 `next` 힌트, 스키마 오류에 `fields`.
- **실측:** 실제 Claude 2.1.287(haiku)로 작업 폴더 안 읽기는 묻지 않고, 밖 읽기는 게이트를 거쳐 허용, 밖 쓰기는 거절 뒤 턴이 이어짐(단발·대화 프로세스 모두). 실제 Codex 0.157.1 app-server로 셸이 작업 폴더에서 돌고 밖 쓰기는 게이트가 거절해 파일이 생기지 않음. 처음 `on-request`에서는 Codex가 Windows에서 루트 밖에 승인 없이 써서 `untrusted`로 바꿨다.
- **화면(2026-10-06):** 작업 상한 창을 'AI 응답 대기' 하나(출력 없는 시간, 30~600초)로 줄였고 호출·실행 수 입력과 진행 줄의 실행 분모(`실행 n/12회`)를 없앴다. 계약의 두 값은 저장된 요청 호환으로 기존 값을 그대로 보낸다. `AGENT_CALL_LIMIT`·`HOST_COMMAND_LIMIT` 문구는 T-122 전에 저장된 요청에만 남으므로 '이전 판의 상한, 지금은 없음'으로 바꿨다. 권한 카드(`file-access`)는 머리 '권한 확인', 권장 단추 '거절하고 계속', 긴 경로 줄바꿈. 시험 `browser-execution-limits`, `work-stages`.
- **남은 것:** 호스트(`hosts/**`, T-121 쪽): 레이어 삭제(`layer-delete`) 보호 판정 제거 여부, ZWCAD 쪽 대량 삭제 기본값(엔진이 500을 보냄). 셸 판정은 명령 인자의 경로만 본다(프로그램이 스스로 여는 경로는 못 봄).

## T-123 모델 전체 JSON 전송 제거 (RESEARCH-14 §1)

**담당·순서(2026-10-06 사용자 결정 "여기에서 한번에 다 처리"):** 화면 파일이 겹치는 [PLAN-27](PLAN-27-sync-storage-stability.md) 3단계 T-085(화면)와 한 세션에서 함께 한다. T-120에서 ⟳ 응답의 형상만 뺐다. 엔진 쪽(1~4)을 먼저 하고 화면(5, T-085)을 이어서 한다. 물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md) §5 「Sync 표시 형상의 객체 단위 저장」의 API 응답과 §7 「엔진 주관 Sync」·「웹 화면 구조」가 소유한다.

| 순서 | 변경 | 위치 |
|---|---|---|
| 1 | ⟳·지금 Sync·플러그인 Sync(`POST …/capture`)는 그 문서의 마지막 Rhino 표시 Sync가 Live로 이어질 수 있으면 `LiveSync.run`으로 바뀐 객체만 호스트에 묻는다. 처음, 기준 없음, Live 불가(`resync`), ZWCAD·작업 사본, 재시도 대상 실패(`SOURCE_CHANGED` 등)면 지금처럼 전체를 새로 읽는다. 진행 중인 자동 Sync에 합류하지 않는 규칙(SPEC-01.11의 10)은 그대로다. 응답은 형상·객체 줄 없는 요청 | `src/server/document-sync.ts`(`runUserSync`), `server.ts` |
| 2 | `GET …/requests`·`POST …/capture` 응답의 표시 Sync(`displayOnly`) 행에서 `objects[]`를 빼고 `objectsOmitted: true`·`objectCount`를 둔다. 객체 줄이 필요한 화면은 새 `GET …/requests/:r/objects[?ids=]`(형상 없는 JSON)로 받는다. 엔진 안의 `Workspace.list`·`summary`(고정 확인 등)는 그대로 | `server.ts`, `src/core/workspace.ts` |
| 3 | AI 턴의 기준이 표시 Sync면 `brief`(작은 결과)와 지연 조회 `ModelView`만 쓴다. 모델 요약(`modelContext`)은 우선 객체와 앞 100개의 줄만 읽는다. 작업 사본 후보·DWG 불러오기 같은 비표시 기준은 보호 비교·측정 재사용에 모델이 필요해 지금처럼 한 번 읽는다 | `src/server/execution.ts`, `model-context.ts` |
| 4 | Rhino 바로 적용 턴의 `query`는 문서 전체를 다시 읽지 않는다. 그 문서의 마지막 저장 Sync(`ModelView`의 객체 줄·측정 meta)에 그 Sync 이후 바뀐 객체(`editors.changes`)를 덮어 쪽을 만든다. 저장 Sync가 없거나 Live가 불가능하면 지금처럼 전체를 읽는다. 측정 줄에는 좌표 배열을 싣지 않는다 | `src/server/direct-mode.ts`(`displayQuery`), `execution.ts` |
| 5 | 화면은 VGT1을 숫자 배열로 풀지 않고 형식화 배열 그대로 GPU에 올린다(PLAN-27 3단계 T-085의 점검표) | `src/contracts/geometry-transfer.ts`, `src/ui/**` |

**시험:**
- 새로: `tests/server/user-sync-live.test.mjs`(⟳가 기준이 있으면 Live로, 없으면·`resync`면 전체로, 응답에 `objects`·`scene` 없음), `tests/server/request-objects.test.mjs`(목록·capture 응답 크기와 `objectsOmitted`, `…/objects?ids=`), `tests/server/direct-query-store.test.mjs`(합성 1만 개: `query`가 전체 읽기를 부르지 않고 변경만 묻고 덮어 씀, 저장 Sync 없으면 전체 읽기), `tests/core/geometry-transfer.test.mjs`의 형식화 풀기, 통합 `tests/integration/browser-large-sync.mjs`(아래 측정).
- 고침: `model-context`·`large-sync-pins`(턴에서 `load` 0번)·`capture`·`workspace-list` 시험, 통합 `browser-live-sync`·`browser-links`·`browser-rhino-panel`.

**완료 기준:** ⟳·요청 목록·AI 턴·`query` 어디에서도 모델 전체 JSON을 보내거나 조립하지 않음(응답 크기·호출 경로 시험). PLAN-27 1~3단계 완료 기준의 합성 1만 개 측정. 알려진 예외 하나: Live Sync가 블록 정의를 새로 보이게 하거나 비우는 변경이거나 표시 수(`displayCoverage`)를 모르는 기준이면 `LiveSync.apply`가 표시 수를 다시 세려고 저장 모델을 한 번 읽는다(`live-sync.ts`). 정의 단위로 수를 고치는 방법은 작은 변경이 아니라 이번 범위에서 두고, 블록이 많은 실제 문서에서 문제가 보이면 따로 고친다(2026-10-06 검토).

**진행(2026-10-06) — 구현·자동 검증, 실제 Rhino 확인 남음.**
- 1: `runUserSync`(`document-sync.ts`). 기준은 `LiveSync.basisOf`, 없으면 그 문서의 마지막 성공 표시 Sync. 기록 `user-sync {action}`.
- 2: 목록·capture 응답의 `listed()`(`server.ts`), `GET …/requests/:r/objects[?ids=]`, 한 요청의 목록 모양 `GET …/requests/:r?view=summary`. 합성 1만 개 Sync 5개 + 후보 1개의 목록 응답이 50 KB 아래(시험), 화면 측정에서 Sync 6개 9.2 MB → 5.8 KB.
- 3: `Execution.previousOf`·`ModelView.entries`·`count`. 표시 Sync 기준 턴에서 `load` 0번, 큰 JSON 해석 0번(시험).
- 4: `displayQuery`의 읽기를 `storedDisplay` + `sdk.liveSync`(변경만) + `overlayDisplay`로. 합성 1만 개에서 한 쪽 약 70 ms, 전체 읽기 0번(시험). 저장 Sync가 없거나 `RESYNC_REQUIRED`면 `readLayers`.
- 5: PLAN-27 3단계 결과.
- 검토 반영(2026-10-06, 독립 검토의 `12c4992`·`c4f93e0`·`334b042` 지적):
  - ⟳가 성공하면(Live·전체) 엔진이 그 문서의 '변경 중'·실패 표시와 재시도를 지운다(`SyncScheduler.userSynced`). Live Sync는 같은 ID를 고치므로 ID 비교로는 끝난 것을 알 수 없었다.
  - 엔진이 그 문서의 자동 Sync를 보류하고 있으면(초안 임대 등, `SyncScheduler.holds`) ⟳의 Live Sync는 기준의 목록 복사본에 쓴다(`LiveSync.run`의 `keep`). 초안 임대는 DB에 없어 `referenced` 확인으로는 못 보았다. SPEC-01.11의 6 보완.
  - '전체 다시 읽기': 연결 파일 행의 오른쪽 클릭 메뉴와 Shift+⟳가 `full: true`를 보낸다. SPEC-01.11의 3·10, Design §03 보완.
  - jig의 객체 찾기는 Sync마다 VGT1 전체 대신 `…/objects?native=`로 그 객체 줄만 받는다. 외부 의견 첨부는 객체 줄을 먼저 받고(`withObjects`), 속성 창의 참조 링크는 그리지 않은 Sync면 그 Sync를 그린 뒤 객체를 고른다. 안 보이는 Sync를 버릴 때 초안의 기준·핀의 Sync는 남긴다.
  - 쓰기 요청이 10분을 넘기면 `ACTION_TIMEOUT`('작업 이력에서 상태를 확인')으로 알린다. 작업 상태 확인은 `?view=summary`로 하고, 약 10분 실패하거나 다시 물어도 같은 답(`NOT_FOUND`·`PROJECT_NOT_FOUND`·`INVALID_INPUT`·`FORBIDDEN`)이면 멈춘다.
  - 패널은 Live Sync 변경분을 `…/delta?view=rows`로 형상 없이 받는다. `query`의 전체 읽기(`readLayers`)도 저장 경로처럼 좌표 배열·블록 정의 없이 쪽을 만든다. `storedDisplay`는 `sync_manifests`부터 훑는다.
  - 시험: 새 `tests/server/user-sync-scheduler.test.mjs`(실제 `LiveSync`·`SyncScheduler`: Live ⟳ 뒤 대기 해제, 초안 보류 중 복사본, 고치기 전 둘 다 실패), `request-objects`(`?view=summary`·`POST …/capture`의 `objectsOmitted`, `?native=`, `delta?view=rows`), `direct-query-store`(전체 읽기 쪽에 좌표 없음, 고치기 전 실패), 통합 `browser-live-sync`(⟳·Shift+⟳·행 메뉴의 `full`).
  - 프로젝트별 DB 2단계(T-124)에서 바꿀 곳에 `storedDisplay`와 Live Sync의 `referenced` SQL을 더했다(ADR-032).
- 남음: 실제 Rhino 창에서 ⟳가 Live로 끝나는지(엔진 기록 `user-sync`), 바로 적용 턴의 `query`가 변경만 묻는지, 패널 고정·선택. 작업 사본 후보·DWG 불러오기 같은 비표시 기준은 지금처럼 모델을 한 번 읽는다.

## T-124 프로젝트별 DB (ADR-032)

ADR-032를 사용자가 확인한 뒤 ARCH-01 §5에 반영하고 구현한다. 공용 `app.sqlite`와 `projects\<ID>\project.sqlite`, 시작 때 한 번 이행(백업·검사·실패 시 그대로), 지식 DB를 프로젝트 폴더로 옮김. AI 턴에는 자기 프로젝트 폴더만 읽기 전용으로 연다. 선행: PLAN-27의 저장 작업이 끝난 뒤.

**진행(2026-10-06) — 1단계(나누기 모듈) 구현·검증, 2단계(엔진 연결)는 T-123 뒤.** 2026-10-02 사용자가 다른 세션과 겹치지 않는 1단계만 먼저 하도록 승인했다. 표 분류·이행 순서·2단계에서 바꿀 파일은 [ADR-032](../decisions/ADR-032-per-project-database.md) 「표 분류」·「이행」.
- `src/core/project-split.ts`(`splitProjectDatabase`), 수동 실행 `node tools/db/split.mjs --data <폴더> [--dry-run]`. 엔진·`Store`·화면은 바꾸지 않았다.
- 시험 `tests/core/project-split.test.mjs` 6건: 분류 누락 없음, 프로젝트 3개 나누기·행 수·무결성·두 번째 실행 무변경, 복사 중·검사 불일치·옮기는 중 실패 때 원본 그대로·남은 파일 없음, 실행 중 잠금 거절, 체크포인트되지 않은 WAL 포함.
- 설치본 DB 사본(212 MB·프로젝트 1개): 미리 보기·실제 각 약 12초, 표별 행 수 일치, 나눈 DB를 기존 `Store`로 열림. 사본은 지웠다.

**진행(2026-10-06) — 2단계(엔진 연결) 구현·자동 검증, 커밋은 작업 브랜치, 설치본 반영 남음.** 저장 계약은 [ARCH-01](../architecture/ARCH-01-system.md) §5 「프로젝트별 DB」, AI 읽기 규칙은 §3 「프로젝트 폴더와 파일 도구」.
- 시작(`src/core/store-open.ts`): `app.sqlite`가 있으면 나뉜 배치, `vide.sqlite`만 있으면 schema를 올린 뒤 한 번 나눔, 실패하면 이전과 같이 `vide.sqlite` 하나로 계속 쓰고 `db-split-failed {code}` 기록, 새 설치는 바로 나뉜 배치. `main.ts`는 그대로(`filename`의 폴더가 데이터 폴더).
- `Store`: `app`·`db(projectId)`·`databases()`·`tx(db, fn)`, 프로젝트 만들기=폴더·DB, 지우기=DB 닫고 폴더 삭제. 프로젝트 행 클래스는 `Store`를 받아 `projectId`로 DB를 고르고 SQL은 그대로. 요청 ID 색인 `request_index`(app.sqlite, 시작 때 다시 만듦). 한 문서 한 연결·불확실한 쓰기·명령 ID·검토 메모 ID·피드백 identity는 모든 프로젝트 DB를 묻는다. `storedDisplay`·정리(`maintainModels`·`compact`·작업 사본)·복구는 DB마다. 백업(`backupWorkspace`)·지식 DB 경로(`knowledgeFile`, 수집 도구)·프로젝트 삭제의 이전 지식 파일도 바꿨다.
- AI 읽기(ADR-031 6): 턴은 자기 `projects/<ID>` 폴더를 묻지 않고 읽는다(쓰기는 늘 거절, 셸은 여는 DB마다 읽기 전용 표시가 있고 변경 낱말이 없을 때만). 작업 폴더 값 `records`와 턴 규칙·공통 지침 한 줄이 위치(`project.sqlite`의 `workspace_requests`, `executions[].body`)를 알린다.
- 시험: `tests/server/project-database.test.mjs` 7건(새 설치 나뉜 배치, 이전 DB 나누기 뒤 같은 요청, 나누기 실패 시 이전 DB로 계속·기록, 두 프로젝트를 가로지르는 검사, 프로젝트 삭제 시 폴더 삭제, AI 읽기 허용·거절, 읽기 전용 명령 판정). 기존 시험은 `tests/fixtures/store.mjs`의 `soleDb`로 한 프로젝트의 DB를 집도록 고쳤고 `new Store(':memory:')`는 메모리의 나뉜 배치라 전체 시험이 프로젝트별 DB로 돈다. `npm run typecheck`·`npm test` 통과(`rhino-transport` 1건은 부하 중 시간 초과, 단독 재실행 통과), 브라우저 시험 8종(conversations·links·live-sync·attached-sync·direct-mode·dashboard-agenda·project-folders·large-model) 통과.
- 설치본 데이터 사본(257 MB, 프로젝트 1개, 지식 DB 1개): 시작 때 나누기 약 21초 후 같은 요청 86행(목록 85, 하나는 숨김 — 나누지 않은 배치와 같음)·대화 4·연결 파일 2·객체 판 18,357, 지식 DB 열림. 사본은 지웠다.
- 남은 것: 설치본 갱신과 실제 데이터 폴더의 첫 나누기 확인(첫 시작이 그만큼 늦어짐), ADR-032 사용자 확인 뒤 `approved`.

## T-125 엔진 비정상 종료 진단 (T-126과 함께)

- ProcDump 옵션을 `-ma`(전체 덤프)로 바꾼다(`CrashDumps.cs:29`, 지금 `-mp` 덤프에는 스레드·모듈이 비어 있음).
- 엔진 stderr를 파일로 남긴다.
- Node v24.15.0 심볼로 콜스택을 확인한다.
- T-123으로 큰 이동이 사라진 뒤에도 재현되는지 본다.

**진행(2026-10-02):** `-ma`·최근 3개 유지·덤프 경로를 `shell` 로그에 남기는 것까지 구현(셸 빌드 오류 0). 엔진 stderr는 이미 `engine-stderr-*.log`로 남는다. 심볼 확인과 T-123 뒤 재현 확인은 남음(설치본 갱신 필요).

**원인 확인(2026-10-06):** 설치본 0.2.20 엔진이 시작 30~50초 뒤 연달아 끝나 ProcDump `-ma` 덤프 4개를 얻었다. 4개 모두 같은 자리다: `Unhandled: C0000409`, fail-fast 코드 2(스택 쿠키), `node.exe+0x21f2189` = `__report_gsfailure`, 호출 경로 `node::TCPWrap::Connect` → `uv_tcp_connect` → `uv__tcp_connect`(Node v24.15.0 심볼로 확인). 엔진에 들어온 시스템 밖 모듈은 node.exe뿐이다. 알려진 libuv 1.51.0 결함이다(루프백 연결마다 부르는 `uv__is_fast_loopback_fail_supported`가 크기를 넣지 않은 `OSVERSIONINFOW`로 `RtlGetVersion`을 불러 스택 쿠키를 덮음, [libuv#5274](https://github.com/libuv/libuv/issues/5274), 수정 libuv#5107이 Node 24.16.0에 들어감). 그래서 번들 런타임을 Node 24.21.0으로 올렸다(`src/desktop/build.mjs`, `package.json` engines `>=24.16.0`, CI). 10-01부터의 `0xC0000409` 종료와 원인이 같은지는 덤프가 없어 확정할 수 없지만 증상(stderr 없음·WER 없음·불규칙 시점)이 같다. 남음: 24.21.0 설치본에서 종료가 사라졌는지 확인.

## T-126 진단 기록 (ADR-031 9)

- 로그 쓰기를 모아서 쓰는 방식으로 바꾼다(엔진을 기다리게 하지 않음). 모든 줄에 VIDE 버전을 붙인다.
- 실패는 전부 코드와 함께 남긴다: Sync·Live Sync 실패 코드, 사용자에게 보인 오류(`DomainError`), 호스트 거절. 요청·대화·문서·단계·시간·크기를 붙이고, 원문·파일 내용·키는 남기지 않는다.
- AI 턴: 도구 호출마다 이름·시간·크기·결과 코드, CLI 버전·종료 코드·실패 시 stderr 끝부분.
- Rhino·ZWCAD 플러그인이 같은 `logs` 폴더에 자기 로그(호출, 예외 스택, 플러그인 버전)를 남긴다.
- 데스크톱 셸(업데이트·엔진 재시작·WebView 재시작)을 기록한다. 화면 JS 오류 전송은 화면 작업 세션과 순서를 맞춘다.
- ProcDump는 전체 덤프(`-ma`)로 바꾸고 최근 몇 개만 남긴다.
- [진단 묶음 내보내기]: 로그·종료 기록·버전·설정 요약을 하나로 묶는다(사용자 원문 제외). 로그를 요청별로 보는 스크립트(`tools/`).

**검증:** 실패 경로마다 로그 줄이 남는 시험, 쓰기가 요청 처리 시간을 늘리지 않는 시험, 원문·키가 로그에 없는 시험.

**진행(2026-10-02) — 구현·자동 검증, 화면 연결·설치본 확인 남음.** 줄 형식·파일은 [ARCH-01](../architecture/ARCH-01-system.md) §6 「진단 기록」.
- 엔진: 모아 쓰기(1초·64 KB, 종료·충돌 때 동기), 줄마다 `v`·`sid`, 하루 64 MB 상한과 알림 줄. 줄당 약 3 µs(이전 동기 append 약 85 µs).
- 실패 코드: `sync`(실패 `code`·`phase`)·`sync-failed`·`live-sync-failed`, 모든 `DomainError` 응답(`api-error`, 경로는 `:id`), `host-refused`.
- AI 턴: `tool-call`(요청 ID·도구·ms·크기·코드), `cli-start`/`cli-exit`(CLI 버전·모델·effort·종료 코드·실패 시 stderr 끝 2 KB, 키 제거). `src/ai`는 `ClaudeCli` 생성자의 spawn 감싸기 한 곳만 바꿨다.
- Rhino·ZWCAD 플러그인 `rhino-*`/`zwcad-*.jsonl`, 셸 `shell-*.jsonl`(공용 `hosts/common/DiagnosticLog.cs`). 세 C# 빌드 오류 0.
- 화면 오류 수신 `POST /api/v1/diagnostics/client`, 진단 묶음 `POST /api/v1/diagnostics/bundle`·`tools/diagnostics/bundle.mjs`, 보기 `tools/diagnostics/view.mjs`.
- 화면(2026-10-06): `src/ui/client-errors.ts`가 `window` `error`/`unhandledrejection`을 client 엔드포인트로 보낸다(메시지·스택·스크립트·줄·열·경로·빌드 파일 이름, 주소의 query·hash와 입력 글은 보내지 않음, 화면 쪽 1분 10건·같은 오류 1번, 보내는 중의 오류는 버림). 설정 '상태 · 오류' 탭의 [진단 묶음 내보내기]가 `POST /diagnostics/bundle`의 파일 경로를 보이고 [경로 복사]를 둔다. 데스크톱 셸에 폴더 열기 메시지가 없어 [폴더 열기]는 두지 않았다. 시험 `tests/core/client-errors.test.mjs`, `browser-workspace-controls`.
- 남은 것: 설치본 갱신 뒤 실제 로그 확인, 셸에 폴더 열기를 더하면 진단 묶음 옆에 연결.

## T-123 검토 뒤 남은 일 (2026-10-06)

- T-123·T-085(v0.2.20)를 RESEARCH-14 §1과 대조해 검토했다. 그 결과 두 가지를 고쳤다.
  - 오프라인 보기는 Sync 목록의 revision까지 비교한다. Live Sync가 같은 Sync를 제자리에서 고쳐도 다시 올라간다(`offline-view.ts`).
  - Live Sync가 기준을 제자리에서 고칠지 판단할 때 정리(prune)와 같은 참조 확인(`ModelStore.references`)을 쓴다. 검토본·게시·공유 의견·jig 읽기와 만들기·대화 기록이 가리키는 Sync는 복사본으로 바뀐다. 그래서 구조 jig의 '오래됨' 판정도 다시 듣는다.
- **T-127 (구현·자동 검증, 2026-10-06):** 초안이 잡혀 있을 때 ⟳마다 새 Sync와 목록 전체 복사가 생기는 문제를 고친다(복사본 한 번, 그 뒤 제자리 수정, 화면은 `delta?base=`). 일시적 실패(`SOURCE_CHANGED`·`HOST_BUSY`)는 전체 읽기 대신 Live로 다시 시도한다. `GET /requests/:r`의 표시 Sync JSON 응답을 거절한다. 패널의 `/objects`를 쪽으로 나눈다.
  - 보류 중 복사본은 기준마다 한 번 만들고(`LiveSync`가 문서별로 기억), 보류 중의 다음 ⟳는 그 복사본을 제자리에서 고친다. 그 복사본을 참조하는 것(`ModelStore.references`)이나 초안이 쓰는 Sync(화면이 `GET …/links?basis=`로 알림, `SyncScheduler.heldBases`)가 있으면 다시 복사한다. 화면은 새 복사본을 보이던 Sync와 `delta?base=&since=`로 만들고, 제자리 변경은 ⟳ 직후 `delta?since=`로 받는다.
  - `SOURCE_CHANGED`·`HOST_BUSY`는 0.3·0.8·1.5초 뒤 Live로 다시 묻고 그 뒤에야 전체를 읽는다(`user-sync`의 `attempts`).
  - JSON으로 표시 Sync를 달라는 `GET …/requests/:r`는 `406 GEOMETRY_BINARY_REQUIRED`. 화면·패널·원격 중계는 VGT1을 받으므로 영향 없음.
  - `…/objects`는 `ids`·`native`가 없으면 2000줄씩 쪽(`offset`·`limit`·`nextOffset`)으로 주고 패널 `withObjects`가 차례로 받는다.
  - 남은 확인: 실제 Rhino에서 초안 고정 중 ⟳ 여러 번(복사본 하나, 화면 전체 다시 받기 없음), 편집 중 ⟳의 재시도.
- **T-128:** Rhino→엔진 전체 읽기(첫 Sync, 전체 다시 읽기)를 VGT1 바이너리 쪽으로 바꾼다(ADR-031 5의 마지막 경로). ZWCAD도 Live Sync로 한다. 진행은 아래 「T-128」.
- **T-129 (다음):** jig 입력, 검토 비교, 보고서, 게시, 오프라인 스냅샷, 작업 사본 실행이 모델 전체 대신 `ModelView`의 필요한 객체만 읽는다.

## T-129 필요한 객체만 읽기 (ADR-031 5)

**진행(2026-10-06) — 구현·자동 검증, 커밋은 작업 브랜치.** 계약은 [ARCH-01](../architecture/ARCH-01-system.md) §5 「읽기와 하위 호환」의 `Workspace.lazy`.
- 지연 읽기: `ModelView.lazy`(목록을 한 줄씩 읽는 `StoredList`, 좌표는 처음 읽힐 때 그 객체만 푸는 `lazyItem`, 정의는 키별), `Workspace.lazy`(객체 줄은 `summary` 캐시), 검사하는 독자용 `src/core/scene-items.ts`(`sceneItems`·`lazyCandidate`).
- 바꾼 독자: 구조 jig 레이어 목록·진단(Sync마다 고른 레이어를 한 번 읽음), `readForJig`의 저장 Sync 경로, Sync jig, 구조 해석 jig 초안(레이어·객체를 먼저 거름, CAD는 고른 레이어만), jig 런타임 `rowsOfLayers`·`layersOf`, 수량표(한 번 훑기, 이전의 객체마다 `find` 없음)·비교(객체별 표현 해시)·보고서·검토본·웹 게시(고른 객체만 풀고 검사)·공유 의견 기준 해시(같은 정규 문자열을 조각으로 해시)·확장 실행, 오프라인 스냅샷. 요청 사슬 확인과 답 턴의 이전 입력은 `brief`.
- 구조 jig '오래됨': 초안·확정 기록의 `sources[].revision`(그때의 목록 revision)이 지금과 다르면 오래됨. 이전 기록(revision 없음)은 지금처럼 ID·생성 시각만 본다.
- 남김: 작업 사본 실행 결과(`exportModel`)는 새 후보 모델이라 전체를 저장해야 하고, 전송 형식은 호스트 연결(T-128) 쪽이다. 표시 Sync 기준 실행의 `captureEditor`는 파일 없는 기준이라 캡처가 필요하다. 작업 사본·DWG 기준 턴의 `previousOf`는 보호 비교·측정 재사용 때문에 그대로이고, ZWCAD 작업 사본 실행은 보호 핀이 있을 때만 기준 모델을 검사한다.
- 측정(합성 1만 개 Sync: 메시 5천·선 5천, DB 30 MB, 엔진 요청 목록이 데워진 상태, 이전=main 6100ee5의 `get` 경로, 이후=`lazy`). 시간은 측정용 표본 없이, 메모리는 반복 중 1천 개마다 GC 뒤 살아 있는 힙의 최댓값(시작 대비). 출력 해시는 이전·이후 같음.

| 독자 | 시간 이전 → 이후 | 살아 있는 힙 최대 이전 → 이후 |
|---|---|---|
| 수량표(`…/quantities`) | 761 → 531 ms | 35 → 3 MB |
| 오프라인 스냅샷 | 729 → 808 ms | 86 → 54 MB(나머지는 스냅샷 버킷) |
| 구조 jig 레이어 목록 | 521 → 388 ms | 32 → 0 MB |
| 구조 jig 진단(한 레이어) | 445 → 340 ms | 32 → 1 MB |
| 웹 게시(객체 3개) | 524 → 390 ms | 33 → 2 MB |

- 목록 한 번 훑기(객체 1만 개)는 판 표 조인 때문에 약 300 ms라, 같은 Sync를 여러 번 훑지 않게 했다(진단은 Sync마다 한 번, 객체 줄은 `summary` 캐시).
- 시험: 새 `tests/server/lazy-model-readers.test.mjs`(`ModelView.lazy` = `load`, 독자 13종의 출력이 전체 모델에서와 같음, HTTP 경로 7개가 `ModelStore.load` 0번, 제자리 Live Sync 뒤 구조 초안 '오래됨').

## T-128 Rhino 표시 페이지 바이너리, ZWCAD Live Sync

물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md) §5 「호스트 표시 페이지의 바이너리 형상」과 §7 「현재 ZWCAD의 읽기 연결」의 「ZWCAD Live Sync」, 지원 상태는 [Rhino](../specs/hosts/rhino.md) H-RHINO-09·[ZWCAD](../specs/hosts/zwcad.md) H-ZWCAD-11.

**진행(2026-10-06) — 구현·자동 검증, 실제 Rhino·ZWCAD 확인 남음.**
- Rhino: 엔진이 `displayPage`·`displayChanges`에 `geometry: "vgt1"`을 붙이고, 새 플러그인(`DisplayScene.cs`)은 응답 틀 본문을 VGT1 컨테이너로 보낸다(머리 JSON에 페이지, 좌표·색인은 버퍼). 이전 플러그인은 JSON으로 답하고 그대로 읽힌다(연결 절차 없음). 16 MB 틀·12 MiB 페이지 예산·큰 객체 상자 규칙은 그대로이며 예산은 바이너리 크기로 센다. `geometryHash`는 전처럼 JSON 숫자 문자열로 계산한다.
- 엔진: 전송이 VGT1 본문을 알아보고 형식화 배열로 푼다. 표시 Sync는 배열을 숫자로 풀지 않고 `ModelStore`까지 넘기며(`packedDisplayModelSchema`, 배열마다 `toJSON`) 저장이 그 바이트를 그대로 쓴다. 레이어 범위 읽기·`query` 전체 읽기·Live 변경은 숫자 배열로 되돌린다. `decodeGeometry`의 reviver를 객체만 도는 함수로 바꿨다(화면도 같은 함수).
- 측정(합성 1만 개: 상자 메시 6천·원기둥 메시 2천·곡선 2천, `node --expose-gc --test tests/server/binary-pages.test.mjs`, 플러그인 응답을 미리 만든 뒤 엔진 쪽만): 페이지 합계 JSON 26.3 MB → VGT1 16.5 MB, 읽기(전송·검사·모델 조립) 약 490~590 ms → 약 180~310 ms, 객체별 저장 인코딩 약 90 ms → 약 45 ms, 읽은 모델이 차지하는 메모리 약 44 MB → 약 18~22 MB. 같은 VGT1을 숫자 배열로 풀면(레이어 범위 읽기) 읽기는 JSON과 비슷하다(약 545 ms). 객체 줄·ID·해시 같은 JSON 부분이 남아 바이트는 약 37 % 준다.
- C# 작성 논리(정렬·리틀 엔디언·`$bin`·u16/u32 선택·원점 숫자 표기)는 같은 코드의 콘솔 복제본으로 만든 틀이 엔진의 `encodeGeometry`와 바이트 단위로 같음을 확인했다(복제본은 남기지 않음). Rhino 런타임 안의 `DisplayScene` 자체는 실제 Rhino에서 확인해야 한다.
- ZWCAD: 연결 플러그인(`AttachedDocument.cs`·`AttachedDisplay.cs`)이 바뀐 ObjectId·revision을 남기고, 한 세션에서 끝까지 이어 읽은 `displayPage`를 표시 상태로 가진다. `displayChanges`는 바뀐 모형 공간 개체의 줄과 지운 Handle, 마지막 페이지에 도면 전체 표시 수를 준다. 레이어·블록 정의·문자/치수 스타일·XCLIP 변경, 끝난 전체 읽기가 없을 때, 이전 플러그인(`UNSUPPORTED_METHOD`)은 `RESYNC_REQUIRED`로 전체 읽기. `attachedStatus.liveChanges`가 있을 때만 Sync에 revision을 넣는다. 엔진은 `ZwcadSdkExecution.liveSync`·`AttachedZwcadDocuments.changes`, `LiveSync`가 호스트의 표시 수(`displayCoverage`)와 결과 필드(`displayWarnings`)를 받고 복사본 요청의 호스트를 기준대로 둔다. 자동 Sync·⟳의 Rhino 한정 조건을 풀었다(`sync-scheduler.ts`·`document-sync.ts`, ZWCAD Sync도 `LiveSync.record`). ZWCAD 편집 범위는 바뀌지 않았다.
- 시험: 새 `tests/server/binary-pages.test.mjs`(실제 전송으로 VGT1↔JSON 같은 페이지, 형식화 배열의 저장 바이트가 JSON 경로와 같음, 저장·다시 읽기, 이전 플러그인 JSON, 큰 객체 상자, Live 변경 페이지, 1만 개 측정), `tests/server/zwcad-live-sync.test.mjs`(변경 페이지 읽기·표시 수, 이전 플러그인·움직인 도면, `liveChanges`일 때만 revision, 저장 도면 갱신, ⟳의 Live·RESYNC), 공용 `tests/fixtures/host-pages.mjs`. 두 플러그인 빌드 오류 0.
- 남은 것: 플러그인 재설치 뒤 실제 Rhino 8(첫 Sync·전체 다시 읽기·Live 변경, 블록·주석·큰 객체 페이지, 이전 Sync와 같은 `geometryHash`)과 실제 ZWCAD 2023(이벤트로 받은 개체 열기, 속성·정점 변경의 소유 개체, 치수 익명 블록, 큰 도면의 표시 수) 확인.
