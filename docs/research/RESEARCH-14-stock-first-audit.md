---
id: RESEARCH-14
title: 순정 대조 감사 — 상한·자체 도구·검사·큰 데이터 경로
status: review
version: 0.1
updated: 2026-10-02
owner: agent:claude
related: [ADR-031, ADR-032, PLAN-27, PLAN-28, RESEARCH-13]
---

# 순정 대조 감사

[ADR-031](../decisions/ADR-031-stock-first.md) 4의 목록이다. 2026-10-02 `main`(a5a5fc0) 코드를 읽어 만들었다. 기준인 **순정**은 터미널에서 Claude Code 또는 Codex CLI를 Rhino MCP와 함께 쓰는 구성이다. 순정에서 실제로 막히는 곳은 모델 문맥뿐이다. MCP 도구 출력은 약 25k 토큰에서, Bash 출력은 약 30k자에서 **잘릴 뿐 실패하지 않는다.** 객체 수, 핀, 모델 크기, 턴 시간에는 상한이 없다.

각 행의 **제안**은 조사자의 의견이다. 무엇을 걷어낼지는 사용자가 정한다(ADR-031 4). 결정된 항목은 [PLAN-28](../plans/PLAN-28-stock-first.md)의 작업이 된다. 이미 고친 항목은 '반영(T-120)'으로 표시했다.

## 1. 큰 데이터 경로 — 설계와 실제

설계는 "바이너리로, 첫 Sync 뒤에는 바뀐 것만"이다(PLAN-27, ARCH-01 §5·§7).

| 구간 | 실제 | 크기(1만 객체) | 제안 |
|---|---|---|---|
| Rhino→엔진, 전체 Sync | ⟳·지금 Sync·플러그인 Sync는 매번 **문서 전체를 JSON으로** 보낸다(`DisplayScene.cs:437,505`, 페이지 1000개·12MB). 플러그인 메시 캐시(`DisplayScene.cs:255`)는 계산만 줄이고 전송량은 줄이지 않는다 | 약 90MB 이상 | ⟳는 Live Sync로 처리하고, 전체 읽기는 처음 한 번과 Live가 불가능할 때만 |
| 엔진→DB | **설계대로.** 객체 지문(SHA-256)·VGT1 float32·`INSERT OR IGNORE`(`model-store.ts:75,123,291`). 전체 Sync마다 목록 줄만 다시 씀(`model-store.ts:426-447`) | 1~4MB | 유지 |
| ⟳ 응답 | DB에서 모델 전체를 다시 조립해 JSON으로 보냄(`import-model.ts:207` → `workspace.ts:578,214-226` → `server.ts:1330`) | 94MB(3,186객체에서 실측) | **반영(T-120):** 형상 없는 요청만 보냄 |
| 요청 목록 `GET …/requests` | 형상은 빠지지만 Sync마다 `objects[]` 전체가 붙음(`workspace.ts:228-245`). 화면이 주기적으로 조회 | 26.8MB | 객체 줄을 빼고 필요한 화면만 따로 받음(화면 수정 필요) |
| 화면 표시 | 바이너리(VGT1)로 받지만 화면이 숫자 배열로 다시 풂(`gateway.ts:29`, T-085 미착수). 새 Sync id마다 전체 다시 받음(`links-sync.ts:424-445`) | 18~30MB | T-085 |
| AI 턴 준비 | 턴마다 기준 Sync의 모델 전체를 DB에서 조립(`workspace.ts:293-299` → `execution.ts:1232,1310`) | 메모리 수백 MB | 필요한 객체만 |
| AI `query` | 직접 모드 조회가 **문서 전체를 Rhino에서 다시 읽음**(`execution.ts:1687-1690`, 캐시는 자기 실행 전까지 `direct-mode.ts:1383-1399`) | 약 90MB | 순정처럼 필요한 것만 호스트에 묻기 |
| Live Sync | **설계대로** 바뀐 것만(`AttachedConnection.cs:153-163`, `live-sync.ts:208-214`). 예외 2가지: 블록 정의가 보이거나 숨겨질 때 전체 재구성(`live-sync.ts:156-166`), 기준 Sync를 다른 요청이 참조하면 새 id로 복사돼 화면이 전체를 다시 받음 | 작음 | 예외 2가지 정리 |
| 옛 행 이전 `model-move` | 옛 요청 줄(88~94MB)을 객체 단위로 옮기는 한 번짜리 작업 | 행마다 약 90MB | 한 번이면 끝남 |

엔진 비정상 종료(`0xC0000409`, `node.exe` 안 같은 주소, 하위 코드 2)는 위 큰 이동과 시간이 겹친다. 원인은 확정하지 못했다. ProcDump `-mp` 덤프에 스레드·모듈 목록이 비어 있어서 콜스택을 볼 수 없다(`CrashDumps.cs:29`).

## 2. 상한

### Sync·호스트 전송

| 항목 | 값 | 위치 | 넘으면 | 순정 | 제안 |
|---|---|---|---|---|---|
| Sync 총량 | 32MB(작업 사본) / 128MB(연결 창) | `scene-pages.ts:51,87`, `editor-channel.ts:135` | `HOST_RESULT_TOO_LARGE`로 Sync 전체 실패 | 없음 | **반영(T-120):** 없앰 |
| 문서 객체 수 | 20,000 | `WorkerScene.cs:12,24`, `DisplayScene.cs:146`, `native-model.ts:112-115`, `scene-pages.ts:15,21`, `editor-channel.ts:56,61`, `server.ts:1659`, `jig-gates.ts:23` | `IMPORT_LIMIT`로 Sync 실패 | 없음 | 없앰(페이지로 읽으므로 근거 없음) |
| 호스트 응답 한 덩어리 | 16MB | `WorkerPlugin.cs:139`, `hosts/common/transport.ts:17,68` | 페이지를 반씩 줄여 재시도. 객체 하나가 넘을 때만 실패 | — | 유지(물리적). 객체 하나 초과는 상자로 표시하고 알림 |
| 워커 요청 한 덩어리 | 4MB | `WorkerPlugin.cs:95` | 연결 종료 → `HOST_RESULT_UNKNOWN` | 없음 | 16MB로, 명확한 코드 |
| 워커 처리 시간 | 180초 | `WorkerPlugin.cs:87` | 취소 → 결과 불명 | MCP 호출 시간 제한만 | 600초 |
| 실행 시간 | 60초 | `worker-client.ts:228` | `HOST_RESULT_UNKNOWN` | 소켓 시간 제한 | 180~600초 |
| 레이어 범위 지정 | 2,000 | `DisplayScene.cs:20,27` | `INVALID_INPUT` | 없음 | 20,000 |
| 3dm 가져오기 | 500 | `hosts/rhino/workspace.ts:104` | `IMPORT_LIMIT` | 없음 | 없앰(옛 경로인지 확인) |
| 모델 업로드 | 64MB | `import-model.ts:55`, `server.ts:1360` | `INPUT_TOO_LARGE` | 없음 | 1GB |
| 오프라인 스냅샷 | 50MB | `sharing/offline.ts:14` | `SNAPSHOT_TOO_LARGE` | — | 올림 |

### AI 조회·실행

| 항목 | 값 | 위치 | 넘으면 | 순정 | 제안 |
|---|---|---|---|---|---|
| 도구 결과 크기(22곳) | 48KiB | `agent-tools.ts:947-951` | `QUERY_RESULT_TOO_LARGE`로 **실패** | 약 25k 토큰에서 잘림 | 잘라서 `truncated`·`nextOffset` |
| query 한 쪽 | 64KiB | `query-page.ts:69-70` | 다음 쪽으로(첫 행 하나가 넘을 때만 실패) | 잘림 | 유지. 한 행 초과는 그 행을 잘라서 |
| query limit / objectIds | 100 / 100 | `query-page.ts:5,7`, `agent-tools.ts:79` | 거절 | 없음 | 1,000 / 2,000 |
| 도구 호출 수 | 30 / 60 / 100(대화) | `execution-limits.ts:5,13,22`, `agent-tools.ts:804` | `AGENT_CALL_LIMIT` | 없음 | 없앰 또는 500 |
| 실행 횟수 | 12 / 48 | `execution-limits.ts:6,14,23` | `HOST_COMMAND_LIMIT` | 없음 | 없앰 또는 200 |
| 턴 시간 | 180 / 600초(경과 기준) | `execution-limits.ts:7,15,24`, `claude-cli.ts:1087`, `claude-process.ts:429`, `codex-app-server.ts:839` | `TIMEOUT`. 일하는 중에도 끊김 | 없음 | 출력이 없을 때만(예: 5분) |
| 실행 본문 길이 | 65,536 / 명령 4,096자 | `agent-tools.ts:94-96`, `application-contract.ts:28` | 거절 | 없음 | 1MB |
| 대량 삭제 확인 | 50개 | `direct-mode.ts:26`, `zwcad-sdk-execution.ts:56`, `application-contract.ts:38` | 되돌리고 확인 카드 | 없음(Ctrl+Z) | 500 |
| 화면 캡처 | 1600px / 1MB | `ViewTools.cs:15-16,84`, `agent-tools.ts:1615` | 실패 | API 이미지 한도만 | JPEG로 줄여서 |
| measure 대상 | 50 / 20 / 50 | `ViewTools.cs:17-18`, `agent-tools.ts:111,124,134` | 거절 | 없음 | 500 |

### 요청·핀·첨부

| 항목 | 값 | 위치 | 넘으면 | 순정 | 제안 |
|---|---|---|---|---|---|
| 핀 | 100 | `workspace.ts:166`, `ui/model.ts:318`, `draft-storage.ts:13`, `app.ts:2157`(안내 없이 버튼 숨김) | 거절 | 없음 | 없앰. AI에는 상세 일부 + 나머지 ID·레이어 요약(PLAN-27 T-086) |
| 편집기 핀 / 선택 ID | 5,000 / 2,000 | `host-documents.ts:25-26`, `editor-channel.ts:207-208` | 거절 | 없음 | 20,000 |
| 본문 | 20,000자 | `workspace.ts:142`, `conversations.ts:255` | 거절 | 문맥까지 | 200,000 |
| 요청 저장 크기 | 200KB | `core/workspace.ts:387` | `INPUT_TOO_LARGE`. HTTP 1MB보다 먼저 걸려 안내 문구("1 MB", `gateway.ts:285`)가 틀림 | 없음 | 본문과 함께 올림 |
| HTTP 본문 / 저장 JSON | 1MB / 1MB | `server.ts:156`, `store.ts:35,461,502` | `INPUT_TOO_LARGE` | 없음 | 16MB |
| 턴 이미지 | 3장 × 1MB | `workspace.ts:86-87`, `claude-cli.ts:294,322-331` | `CONTEXT_TOO_LARGE` | 장당 약 5MB, 여러 장 | 20장, 큰 것은 줄여서 |
| 문맥 묶음 | 256KiB | `claude-cli.ts:297` | `CONTEXT_TOO_LARGE` | 문맥 창 | 잘라서 요약 |

### 대화·세션

| 항목 | 값 | 위치 | 넘으면 | 순정 | 제안 |
|---|---|---|---|---|---|
| 세션 인계 | 100턴 / 80만 토큰 | `conversations.ts:60-65,533` | 새 세션(실패 아님) | 자동 compact | 턴 수는 없애고 토큰만 |
| 출력 한 줄 | 16MB | `claude-cli.ts:614,1203`, `claude-process.ts:117`, `codex-app-server.ts:358` | `OUTPUT_TOO_LARGE`로 턴 실패 | 없음 | 그 줄만 버리고 계속 |
| 만들기 대화 확인 | 20턴마다 | `make-routes.ts:190,226` | 멈추고 질문 | 없음 | 50 |

**여러 층에서 같은 것을 검사하는 상한:** 핀 100(3곳), 객체 20,000(9곳), 응답 16MB(C#·TS 두 곳), AI 결과 크기(48KiB는 실패, 64KiB 두 곳은 잘림으로 정책이 서로 다름), 이미지 1MB·3장(6곳), 삭제 50(3곳), 실행 횟수 검사(4곳), 실행 본문 65,536(5곳), 요청 크기(1MB → 200KB → 2만 자).

## 3. 자체 도구 (`agent-tools.ts` definitions, 33개)

| 도구 | 순정에 같은 것 | VIDE만의 가치 | 제안 |
|---|---|---|---|
| `query` :82 | `get_objects`, `get_object_info`, `get_document_summary` | 다른 대화와 충돌 감지 토큰, 연결된 다른 파일 읽기 | 유지. 문서 전체 재읽기 대신 필요한 것만(1절) |
| `execute` :87 | `execute_rhinocommon_csharp_code`, `execute_rhinoscript_python_code`, `run_command` | 실행 한 번 = 되돌리기 한 단계, 바뀐 객체 보고, 이력, 여러 파일 롤백 | 유지(VIDE의 핵심) |
| `capture_view` :101, `measure` :117 | `capture_viewport`, `measure_objects` | 문서를 바꾸지 않음, 활동 기록 | 유지(얇은 래퍼) |
| `status` :139, `cancel` :176 | — | 처리기(handler)가 없음 | 삭제 |
| `attachment_read` :141 | Read | 대화 첨부만 | Read로 합침 |
| `file_list` :153, `file_read` :165 | Glob, Grep, Read | 키·로그인 파일 차단, 승인 카드 | 순정 Read·Glob·Grep + 프로젝트 폴더 읽기 권한(ADR-032) |
| `ask_user` :331 | AskUserQuestion | 만들기 대화에서만 있음 | 네이티브 질문으로 통일 |
| jig·구조·Sync 기록·할 일·프로젝트 자료 도구 | 없음 | VIDE 고유 데이터 | 유지 |

순정 Rhino MCP에 있는데 VIDE에 없는 것: undo/redo 도구, 레이어 도구, Grasshopper(`grasshopper` 명령은 거절, `rhino-script-policy.ts:38`).

## 4. 막아 둔 CLI 내장 도구

- **Claude:**
  - `--tools ''`, `--strict-mcp-config`, `--setting-sources ''`, `--disable-slash-commands`, `--permission-mode dontAsk`, `--safe-mode`를 씀(`claude-cli.ts:355-376`).
  - 허용 목록은 `mcp__vide__*`와 Task·Todo·Web뿐(`agent-connection.ts:422-453`).
  - Read·Edit·Write·Glob·Grep은 만들기 턴에서 초안 폴더 안으로만 있음. **Bash는 어디에도 없음.**
- **Codex:**
  - `--sandbox read-only`, `--ignore-user-config`, `mcp_servers={}`(vide만 다시 넣음), `project_doc_max_bytes=0`.
  - `--disable shell_tool, unified_exec, multi_agent, view_image …`(`codex-cli.ts:59-124`).
- **허용 목록 밖 호출이 나오면 턴 전체가 실패함**(`UNEXPECTED_TOOL_CALL`, `claude-cli.ts:1138,1175,1185`, `claude-process.ts:501-529`, `codex-app-server.ts:856,904,915`).
- **순정 대비 못 하는 것:**
  - 셸이 없어 스크립트·테스트를 돌릴 수 없음.
  - 프로젝트 파일을 Grep하지 못함.
  - 사용자의 Rhino MCP·스킬·CLAUDE.md를 쓰지 못함.

**제안:** 읽기 도구(Read·Glob·Grep)를 프로젝트 폴더 읽기 전용으로 열고, 허용 밖 호출은 턴을 죽이지 말고 거절만 한다. 셸은 별도 결정.

## 5. 실행을 막는 검사

| 검사 | 위치 | 막는 때 | 순정 | 제안 |
|---|---|---|---|---|
| 결과 미확인 알림(`HOST_RESULT_UNRESOLVED`) | `direct-mode.ts:916-920,1019-1027` | 미확인 결과가 있는 파일의 첫 실행을 한 번 거절 | 없음 | **반영(T-120):** 안내를 "조회가 안 되면 실행 안에서 확인, 다음 실행은 돈다"로. 이후 경고만으로 |
| 답을 잃은 뒤(`uncertain`) | `direct-mode.ts:996,1059,1113,1260` | 그 턴의 실행 전부. 조회·캡처도 `STALE_REFERENCE`로 막혀 확인 수단까지 막힘 | 없음 | 실행만 막고 읽기는 허용, 코드 이름 바로잡기 |
| C#·Python·명령 정책 | `rhino-script-policy.ts:19-102`, `CodePolicy.cs:11-53`, `DirectScripts.cs:16-41` | `getattr`·`__dict__`·`RhinoApp`·`System.IO`·`Reflection`·`Threading` 등 | 없음 | 파일·프로세스 쪽만 남기고 나머지는 경고만 |
| 확인 카드(삭제 51개 이상, 레이어 삭제, Purge, 저장·내보내기) | `direct-mode.ts:26-35,1089-1111`, `DirectExecution.cs:172-182` | 되돌리고 턴이 멈춤 | 없음 | 유지, 삭제 기준은 500 |
| 병렬 호출 직렬화(`AGENT_BUSY`) | `agent-tools.ts:574-580,803` | `query`·`capture_view`를 병렬로 부르면 실패 | 병렬 가능 | 읽기 도구는 빼기 |
| 문서 변경 감지(stale) | `direct-mode.ts:1062-1068` | 마지막 조회 뒤 사람이 손으로 고쳐도 거절 | 없음 | 경고만 |
| 보호 핀 | `geometry.ts:168-175`, `execution.ts:1520-1525` | 옛 JSON·작업 사본 경로만. 직접 모드에서는 지시문뿐(`direct-mode.ts:736-737`) | 없음 | 호스트에서 강제하거나 문서에서 빼기(결정 필요) |
| 대화 간 잠금(`DOCUMENT_LOCKED`), 실행 순서 | `request-scope.ts:296-321`, `direct-mode.ts:137-203` | 다른 요청이 쓰는 파일 | 없음 | 유지(여러 대화 동시 작업에 필요) |

## 6. AI에게 원인을 가리는 오류 변환

- `agent-tools.ts:821-826`는 `knownErrors`(:489-527)에 없는 코드를 모두 `AGENT_TOOL_FAILED`로 바꿨다.
- 이 때문에 가려진 코드:
  - `HOST_RESULT_TOO_LARGE`(큰 문서 조회)
  - `REVISION_CONFLICT`(할 일)
  - `FOLDER_NOT_FOUND`·`FOLDER_NOT_ALLOWED`
  - `INPUT_TOO_LARGE`(첨부)
  - jig 초안 오류들
- **반영(T-120):** 대문자 오류 코드는 그대로 넘긴다. 코드 없는 예외(경로·자격이 담길 수 있음)는 계속 감춘다.
- **남은 것:**
  - 다음 행동을 알려 주는 힌트(`errorHints`)가 4개 코드에만 있다.
  - 스키마 오류가 어느 필드인지 알리지 않는다(`INVALID_INPUT`만, `agent-tools.ts:762-766`).
