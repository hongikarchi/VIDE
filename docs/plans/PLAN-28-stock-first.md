---
id: PLAN-28
title: 순정 우선 — 상한·자체 도구 정리, 모델 전체 JSON 전송 제거, 프로젝트별 DB
status: draft
version: 0.4
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
- 남은 것: 화면(`src/ui/**`)의 핀 100 안내(`ui/model.ts`)·첨부 안내·`INPUT_TOO_LARGE` 문구("1 MB")는 화면 작업 세션 몫. 공유 웹 뷰어의 64MiB 표시 한도(`WEB_MODEL_LIMIT`, `src/sharing/web`)와 ZWCAD 표시 응답 128MiB는 그대로다.

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
- **남은 것:** 화면(`src/ui/**`): 작업 상한 창의 호출·실행 수 입력(이제 무의미)과 `AGENT_CALL_LIMIT`·`HOST_COMMAND_LIMIT` 문구 정리, 권한 카드는 기존 질문 카드(`file-access`)를 그대로 쓴다. 호스트(`hosts/**`, T-121 쪽): 레이어 삭제(`layer-delete`) 보호 판정 제거 여부, ZWCAD 쪽 대량 삭제 기본값(엔진이 500을 보냄). 셸 판정은 명령 인자의 경로만 본다(프로그램이 스스로 여는 경로는 못 봄).

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
- 남은 것(2단계): 엔진 시작 때 호출, `Store`의 공용·프로젝트별 연결 분리와 프로젝트를 가로지르는 조회 수정, 백업·프로젝트 삭제·지식 DB 경로, AI 턴 읽기 권한. ADR-032의 사용자 확인 뒤 `approved`.

## T-125 엔진 비정상 종료 진단 (T-126과 함께)

- ProcDump 옵션을 `-ma`(전체 덤프)로 바꾼다(`CrashDumps.cs:29`, 지금 `-mp` 덤프에는 스레드·모듈이 비어 있음).
- 엔진 stderr를 파일로 남긴다.
- Node v24.15.0 심볼로 콜스택을 확인한다.
- T-123으로 큰 이동이 사라진 뒤에도 재현되는지 본다.

**진행(2026-10-02):** `-ma`·최근 3개 유지·덤프 경로를 `shell` 로그에 남기는 것까지 구현(셸 빌드 오류 0). 엔진 stderr는 이미 `engine-stderr-*.log`로 남는다. 심볼 확인과 T-123 뒤 재현 확인은 남음(설치본 갱신 필요).

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
- 남은 것: 화면 쪽 연결(`window` `error`/`unhandledrejection` → client 엔드포인트, 설정의 [진단 묶음 내보내기] 단추) — 화면 작업 세션 뒤. 설치본 갱신 뒤 실제 로그 확인.

## T-123 검토 뒤 남은 일 (2026-10-06)

- T-123·T-085(v0.2.20)를 RESEARCH-14 §1과 대조해 검토했다. 그 결과 두 가지를 고쳤다.
  - 오프라인 보기는 Sync 목록의 revision까지 비교한다. Live Sync가 같은 Sync를 제자리에서 고쳐도 다시 올라간다(`offline-view.ts`).
  - Live Sync가 기준을 제자리에서 고칠지 판단할 때 정리(prune)와 같은 참조 확인(`ModelStore.references`)을 쓴다. 검토본·게시·공유 의견·jig 읽기와 만들기·대화 기록이 가리키는 Sync는 복사본으로 바뀐다. 그래서 구조 jig의 '오래됨' 판정도 다시 듣는다.
- **T-127 (다음):** 초안이 잡혀 있을 때 ⟳마다 새 Sync와 목록 전체 복사가 생기는 문제를 고친다(복사본 한 번, 그 뒤 제자리 수정, 화면은 `delta?base=`). 일시적 실패(`SOURCE_CHANGED`·`HOST_BUSY`)는 전체 읽기 대신 Live로 다시 시도한다. `GET /requests/:r`의 표시 Sync JSON 응답을 거절한다. 패널의 `/objects`를 쪽으로 나눈다.
- **T-128 (다음):** Rhino→엔진 전체 읽기(첫 Sync, 전체 다시 읽기)를 VGT1 바이너리 쪽으로 바꾼다(ADR-031 5의 마지막 경로). ZWCAD도 Live Sync로 한다.
- **T-129 (다음):** jig 입력, 검토 비교, 보고서, 게시, 오프라인 스냅샷, 작업 사본 실행이 모델 전체 대신 `ModelView`의 필요한 객체만 읽는다.
