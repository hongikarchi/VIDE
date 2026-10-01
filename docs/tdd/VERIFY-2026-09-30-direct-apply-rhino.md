---
id: VERIFY-2026-09-30-direct-apply-rhino
title: 바로 적용 실호스트 확인 — Rhino direct-execute·되돌리기·보호·보기 도구
status: review
version: 0.2
updated: 2026-10-01
owner: agent:claude
related: [ADR-022, SPEC-02, T-070, T-072, T-073, PLAN-24]
---

# 바로 적용 실호스트 확인 — Rhino

## 범위

[PLAN-24](../plans/PLAN-24-ai-conversations.md) T-070(Rhino `direct-execute`·`direct-undo`·`fingerprint`), T-072(자동 모드 대화의 `execute`와 [되돌리기]·[진행]), T-073, 5차 물결의 보기 도구(`capture_view`·`measure`)를 실제 Rhino 8에서 확인했다. 기준은 [ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md)와 SPEC-02.13(바로 적용·되돌리기·보호)이다. 해당 AC가 아직 없어서 SPEC-02.13과 ARCH-01 §4 「바로 적용 경로」를 기준으로 삼았다.

사용자가 Rhino와 CAD를 닫은 동안 에이전트가 숨김 Rhino 8을 띄웠다. 쓴 문서는 합성 문서뿐이고 사용자 원본은 열지 않았다. 다른 레인의 Rhino도 동시에 돌았지만 건드리지 않았다.

## 방법

- 시험 스크립트는 `node tests/integration/rhino-direct-apply.mjs`이다. 데이터 폴더는 `VIDE_TEST_DATA_DIR=.vide/h1-data`, 문서 폴더는 `VIDE_TEST_DOC_DIR=.vide/h1`, 포트는 `VIDE_TEST_PORT=47841`, 플러그인은 `VIDE_TEST_RHINO_PLUGIN`으로 지정했다.
- 엔진은 `node src/server/main.ts --dev`가 쓰는 `startServer`와 같은 서버를 스크립트 안에서 띄웠다. 데이터 폴더는 따로 두었다. 공급자는 스크립트로 대신했다. 각 턴이 에이전트 도구(`app.agentTools.call`, `/mcp`와 같은 처리기)로 `execute`·`capture_view`·`measure`를 부른다. 실제 AI 공급자는 쓰지 않았다.
- 합성 문서는 작업 사본 Rhino(`launchRhinoWorker`)로 만들어 `.vide/h1/synthetic.3dm`에 저장했다. 레이어는 다섯 개(상자·선·블록·기타·빈 레이어 '비움')이고 객체는 73개다. 상자 60, 직선 5, 원 5, 블록 정의 하나와 그 인스턴스 2, 다른 레이어의 상자 1이다.
- 이 문서를 숨김 Rhino(`launchOwnedHost`, `VIDE_CONNECT_DIR`은 데이터 폴더 아래)에서 열고 플러그인 연결을 붙였다. 제품 API로 프로젝트를 만들고 Link(`POST /links`)와 Sync(`POST /capture`)를 한 뒤 자동 모드 요청(`POST /requests`, `mode: 'auto'`)을 보냈다. 되돌리기는 `POST …/undo`, 진행은 `POST …/confirm`으로 불렀다.
- Rhino 쪽 객체 수와 레이어 수는 문서 안의 Python 동작 루프로 셌다. 사람의 Ctrl+Z는 같은 루프에서 `RhinoApp.RunScript('_Undo')`로 재현했다.
- 결과 JSON은 `.vide/h1-data/result.json`, 캡처는 `capture.png`·`capture-fit.png`에 있다. 저장소에는 넣지 않았다.

## 결과

아래 결과는 수정 후 마지막 실행 기준이다. 모든 항목이 통과했다(`passed: true`).

| # | 항목 | 결과 |
|---|---|---|
| 1 | 상자 3개를 추가하는 C# 본문 하나를 `execute` | 통과. `changes.counts.added = 3`, `undoId = "2"`. 실행 행은 `applied`이고 문서 객체는 73 → 76개 |
| 2 | 최신 기록 [되돌리기], 한 번 더 | 통과. 첫 번째는 `ok: true`로 행이 `undone`이 되고 객체가 73개로 돌아왔다. 두 번째는 `ok: true, already: true` |
| 3 | 한 턴에서 A 다음 B를 실행하고 A를 되돌리기 | 통과. A는 `ok: false, reason: 'not-latest'`이고 문서는 75개로 그대로였다. B를 되돌린 뒤 A를 되돌리니 둘 다 `ok`였고 객체는 73개 |
| 4a | 상자 60개 삭제(확인 없음) | 통과. `guarded.kind = 'bulk-delete'`("객체 60개를 지웁니다 (기준 50개).")로 요청이 `needs-confirmation`이 됐고 문서는 73개 그대로였다. [진행] 뒤에는 `succeeded`로 60개가 삭제됐고, 그 실행을 [되돌리기]하자 73개로 복구됐다 |
| 4b | 빈 레이어 삭제 | 통과. `guarded.kind = 'layer-delete'`로 멈췄고 레이어 수는 6(Default 포함) 그대로였다 |
| 4c | `doc.Layers.Purge` | 통과. 실행 전 `guarded.kind = 'purge'`("…되돌릴 수 없습니다.")로 거절됐다. 본문은 실행되지 않았고 레이어 수는 6 그대로였다 |
| 5 | 상자를 추가한 뒤 예외를 던지는 본문 | 통과. `code: 'EXECUTION_FAILED'`, `reverted: true`, `message: '의도한 실패'`. 실행 기록은 0건이고 객체 수는 73 그대로였다. `fingerprint` 토큰은 revision 258 → 261로 바뀌었다(아래 한계 참조) |
| 6 | `capture_view` 1600×900 | 통과. PNG 35,705바이트, 1600×900, Perspective, 단위 Meters. 2400×900 요청은 `INVALID_INPUT`으로 거절됐다(한도 1600). `fitIds`로 상자 두 개와 선 하나를 맞춘 1200×800 캡처도 모델을 보여 주었다 |
| 6 | `measure` | 통과. 상자는 bbox (0,0,0)–(1,1,1), 크기 1×1×1, 면적 6, 부피 1.0이었다. 직선 길이는 10.0이고 두 상자 사이 거리는 2.0(`edges`, (1,0,0)→(3,0,0))이었다 |
| 7 | Rhino Ctrl+Z(`_Undo`)로 AI 기록을 되돌린 뒤 VIDE [되돌리기] | 통과. Rhino Undo 뒤 74 → 73개가 됐다. VIDE 응답은 `ok: true, already: true`였고 행은 `undone`이 됐으며 다른 기록은 되돌리지 않았다(73개 유지) |

## 찾은 문제와 수정

1. **되돌리기 뒤 다음 실행이 모두 실패(T-070, 높음).** HEAD(c8443db) 빌드에서는 `direct-undo`나 보호·실패의 자동 복구 뒤 다음 `direct-execute`가 `UNDO_UNAVAILABLE`로 실패했다. 턴은 `HOST_RESULT_UNKNOWN`이 됐다. 원인은 명령 밖에서 부른 `RhinoDoc.Undo()`가 Rhino의 되돌리기 상태를 열어 둔 채 끝나는 것이다. 실측에서 `UndoActive = True`, `UndoRecordingIsActive = True`였고 이어진 `BeginUndoRecord`는 0을 돌려주었다. 같은 시각 다른 레인이 `hosts/rhino/worker/DirectExecution.cs`에서 같은 문제를 고치고 있었다(`CloseOwnRecord`: 열린 기록을 닫고 그 번호를 '위에 쌓인 기록'에서 제외, 되돌린 기록 집합으로 최신 판정). 이 레인은 그 파일을 고치지 않았다. 대신 작업 트리의 그 판을 따로 빌드해(`.vide/h1/plugin/`) 위 표 전체를 통과시켰다. 이 레인이 먼저 따로 확인한 대안(`RhinoApp.RunScript("_Undo")`로 되돌리기)도 같은 시험을 통과했다.
2. **숨김 Rhino에서 `capture_view`가 흰 화면(5차 보기 도구, 중간).** `ViewCapture.CaptureToBitmap(ViewCaptureSettings)`는 창이 숨겨진 Rhino에서 흰 PNG를 돌려주었다(1600×900, 6 KB, 표본 픽셀 모두 흰색). 같은 창에서 `RhinoView.CaptureToBitmap(size, grid, worldAxes, cplaneAxes)`는 모델을 그렸다. `hosts/rhino/worker/ViewTools.cs`의 `Png()`를 후자로 바꿨다. 격자와 축은 끄고 반사 호출은 그대로다. 보이는 Rhino 창에서의 기존 경로 결과는 확인하지 않았다.
3. **Rhino 쪽 되돌리기 뒤 [되돌리기]가 `already`를 잃음(T-072, 낮음).** 호스트는 `{ok: true, already: true}`를 돌려주는데 엔진은 `{ok: true}`만 전했다. 그래서 화면은 VIDE가 방금 되돌린 것처럼 보였다. `src/server/execution.ts`의 `undo()`가 호스트의 `already`를 그대로 전하게 했다.

## 한계

- `fingerprint`의 `documentHash`는 연결의 revision 기반 토큰이다. 되돌린 실패 실행도 revision을 올리므로(258 → 261) 5번의 '문서 변경 없음'은 객체·레이어 수로 판정했다.
- 3번의 'B 뒤 A 되돌리기'는 다른 레인이 수정 중인 `DirectExecution.cs`에 달려 있다. HEAD 빌드에서는 1번 문제 때문에 여기까지 오지 못한다.
- 설치본 플러그인 등록은 복구하지 않았다. 설치본 갱신 때 다시 등록한다. 공유 개발 빌드(`.vide/build/rhino-worker`)는 다시 빌드하지 않았다.
- ZWCAD(T-071)는 이 기록의 범위가 아니다.
