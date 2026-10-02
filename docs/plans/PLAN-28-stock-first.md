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

## T-121 상한 정리 (RESEARCH-14 §2)

사용자가 RESEARCH-14에서 고른 항목을 올리거나 없앤다. 넘으면 실패 대신 잘라서 알리는 방식으로 바꾼다(48KiB 도구 결과, 출력 한 줄, 캡처 이미지). 같은 값을 여러 층에서 검사하는 것은 한 곳으로 모은다. 화면 파일(`app.ts`, `src/ui/**`)이 걸린 핀·본문 상한은 PLAN-27 T-086과 함께 한다.

## T-122 자체 도구·검사 정리 (RESEARCH-14 §3~§6)

- 처리기가 없는 `status`·`cancel`을 지운다.
- 프로젝트 폴더 읽기는 CLI 기본 Read·Glob·Grep을 읽기 전용으로 열어서 한다. `file_list`·`file_read`·`attachment_read`는 이것으로 대체한다(ADR-032 2 뒤).
- 허용 밖 도구 호출은 턴을 죽이지 않고 그 호출만 거절한다.
- `uncertain` 뒤에도 읽기 도구는 쓸 수 있게 한다.
- 읽기 도구는 병렬로 부를 수 있게 한다.
- 스크립트 정책은 파일·프로세스 쪽만 남긴다.
- 각 항목은 사용자 결정 뒤 진행한다.

## T-123 모델 전체 JSON 전송 제거 (RESEARCH-14 §1)

- ⟳는 Live Sync로 처리하고, 전체 읽기는 처음 한 번과 Live가 불가능할 때만 한다.
- 요청 목록에서 Sync의 `objects[]`를 빼고, 필요한 화면만 따로 받는다.
- AI 턴은 모델 전체를 조립하지 않는다.
- AI `query`는 문서 전체를 다시 읽지 않고 호스트에 필요한 것만 묻는다.
- 화면은 VGT1을 풀지 않고 그대로 쓴다(PLAN-27 T-085와 같은 작업).

선행: PLAN-27 T-084·T-085를 하는 세션과 순서를 맞춘다.

## T-124 프로젝트별 DB (ADR-032)

ADR-032를 사용자가 확인한 뒤 ARCH-01 §5에 반영하고 구현한다. 공용 `app.sqlite`와 `projects\<ID>\project.sqlite`, 시작 때 한 번 이행(백업·검사·실패 시 그대로), 지식 DB를 프로젝트 폴더로 옮김. AI 턴에는 자기 프로젝트 폴더만 읽기 전용으로 연다. 선행: PLAN-27의 저장 작업이 끝난 뒤.

## T-125 엔진 비정상 종료 진단

- ProcDump 옵션을 `-ma`(전체 덤프)로 바꾼다(`CrashDumps.cs:29`, 지금 `-mp` 덤프에는 스레드·모듈이 비어 있음).
- 엔진 stderr를 파일로 남긴다.
- Node v24.15.0 심볼로 콜스택을 확인한다.
- T-123으로 큰 이동이 사라진 뒤에도 재현되는지 본다.
