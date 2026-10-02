---
id: PLAN-28
title: 순정 우선 — 상한·자체 도구 정리, 모델 전체 JSON 전송 제거, 프로젝트별 DB
status: draft
version: 0.1
updated: 2026-10-02
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

## T-123 모델 전체 JSON 전송 제거 (RESEARCH-14 §1)

- ⟳는 Live Sync로 처리하고, 전체 읽기는 처음 한 번과 Live가 불가능할 때만 한다.
- 요청 목록에서 Sync의 `objects[]`를 빼고, 필요한 화면만 따로 받는다.
- AI 턴은 모델 전체를 조립하지 않는다.
- AI `query`는 문서 전체를 다시 읽지 않고 호스트에 필요한 것만 묻는다.
- 화면은 VGT1을 풀지 않고 그대로 쓴다(PLAN-27 T-085와 같은 작업).

선행: PLAN-27 T-084·T-085를 하는 세션과 순서를 맞춘다.

## T-124 프로젝트별 DB (ADR-032)

ADR-032를 사용자가 확인한 뒤 ARCH-01 §5에 반영하고 구현한다. 공용 `app.sqlite`와 `projects\<ID>\project.sqlite`, 시작 때 한 번 이행(백업·검사·실패 시 그대로), 지식 DB를 프로젝트 폴더로 옮김. AI 턴에는 자기 프로젝트 폴더만 읽기 전용으로 연다. 선행: PLAN-27의 저장 작업이 끝난 뒤.

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
