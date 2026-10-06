---
id: PLAN-29
title: Grasshopper — 얇은 캔버스 도구(T-130~T-134)
status: draft
version: 0.1
updated: 2026-10-06
owner: agent:claude
related: [ADR-033, ADR-031, ADR-029, ADR-027, HOST-RHINO, SPEC-02, ARCH-01]
---

# Grasshopper — 얇은 캔버스 도구 (T-130~T-134)

근거: [ADR-033](../decisions/ADR-033-grasshopper-thin-tools.md)(2026-10-06 사용자 결정: 무거운 검증 계층 없이 캔버스·컴포넌트 인식, 스크립트 자동 작성, 배치, 동시 캔버스 조작). 동작은 [SPEC-02](../specs/SPEC-02-execution-candidates.md).13의 8, 지원표는 [HOST-RHINO](../specs/hosts/rhino.md) H-RHINO-10~12, 도구 목록은 [ARCH-01](../architecture/ARCH-01-system.md) §3. 이식 출처는 Vino(`C:\Users\user\Desktop\Vino`, Apache-2.0; 읽기 전용) — 스크립트 컴포넌트 표면과 슬라이더 값 순서를 줄여 옮겼고 출처는 `THIRD_PARTY_NOTICES`와 파일 머리에 적었다.

## T-130 Rhino 플러그인의 Grasshopper 메서드

| 변경 | 위치 |
|---|---|
| Grasshopper 참조(설치본 `Plug-ins\Grasshopper\Grasshopper.dll`·`GH_IO.dll`, `Private=false`), 캔버스 형식용 WinForms 참조(암묵 using 제외) | `hosts/rhino/worker/VIDE.Worker.csproj` |
| 진입: Grasshopper 형식을 쓰지 않는 문(`GhGate`) — 플러그인이 Grasshopper 없이도 로드되고, 로드 전 `gh-state`는 `loaded:false`, 그 밖은 `GH_NOT_LOADED`. `gh-open`은 플러그인을 로드하고 편집기를 띄움 | `Grasshopper/GhGate.cs`, `AttachedConnection.cs`(`gh-*`), `DirectExecution.cs`(`gh-bake`, `gh:` 되돌리기) |
| `gh-state`(문서 목록, 객체·소켓·연결·값·메시지·그룹·스케치, `ids`·`area`·`since`, `offset`/`nextOffset`), `gh-components`(설치 컴포넌트 검색, 입출력), `gh-solve`, `gh-outputs`(경로·개수·형식·앞 항목·경계 상자), `gh-capture`(보이는 캔버스의 문서를 틀에 맞춘 PNG), `gh-open`·`gh-save`, `direct-undo`의 `gh:` 기록 | `Grasshopper/GhTools.cs` |
| `gh-apply`: 작업 묶음 → `GH_UndoRecord` 하나(`GH_AddObjectAction`·`GH_RemoveObjectAction`·`GH_LayoutAction`·`GH_WireAction`·`GH_GenericObjectAction`), 작업별 결과·코드, `$ref`, 계산 한 번, 바꾼 객체의 메시지, `since` 알림 | `Grasshopper/GhApply.cs` |
| 문서별 변경 번호(객체 추가·삭제·변경·만료·계산 끝) | `Grasshopper/GhWatch.cs` |
| 스크립트 컴포넌트(Python 3·C#; IronPython 2는 소스만): 소스 읽기·쓰기, 소켓 이름·순서·형식 힌트·접근, 연결된 소켓 삭제 거절 | `Grasshopper/GhScript.cs`(Vino 이식, SPDX 머리) |
| 굽기: 출력 데이터 → 레이어(없으면 만듦)의 Rhino 객체, `vide-gh-source` 사용자 문자열 | `Grasshopper/GhBake.cs` |

**검증:** `dotnet build hosts/rhino/worker/VIDE.Worker.csproj -c Release` 오류·경고 0. Grasshopper API 표면(생성자·`UndoGuids` 순서·`GH_UndoRecord.Undo`의 역순 실행)은 설치본 어셈블리를 리플렉션·IL로 확인했다(실행은 아님).

## T-131 엔진 도구

| 변경 | 위치 |
|---|---|
| 도구 정의 아홉(zod 스키마·설명), 이름 등록부, 계획 모드는 읽기 넷, 쓰기 다섯은 턴 안에서 한 번에 하나(`AGENT_BUSY`), 모두 `linkId`, 오류 다음 행동 | `src/server/agent-tools.ts`, `src/ai/agent-connection.ts` |
| 처리기: 활동 줄, 결과 자르기(`bounded`), 캔버스 이미지(`ToolImage`, 크면 반으로 다시), `gh_apply` 기록(`kind: 'grasshopper'`, 이름 "VIDE: <대화 제목 또는 요청> · n ops"), `gh_bake` → 실행 경로(`language: gh-bake`), `gh_open`·`gh_save`의 작업 폴더 검사 | `src/server/grasshopper-tools.ts`, `src/server/direct-mode.ts`(`executeIn`, 목표 문장, 자동 되돌림 제외) |
| 호스트 호출 `grasshopper(method, params)`, `gh:` 되돌리기 ID, `gh-not-latest` 이유, 호출 시간 600초 | `hosts/rhino/editor-channel.ts`, `editor-sessions.ts`, `application-contract.ts`, `src/server/sdk-execution.ts`, `execution.ts`, `src/contracts/direct-refusal.ts`, `rhino-script-policy.ts` |

**검증:** `tests/server/grasshopper-tools.test.mjs`(가짜 호스트): 등록부·계획 모드, 묶음 하나 = 기록 하나와 [되돌리기], 지워진 객체 작업만 실패, `since` 읽기와 다른 사람 편집 알림, 나중 기록 뒤 `gh-not-latest`, 두 대화의 동시 `gh_apply`(서로 기다리는 가짜 호스트로 잠금이 없음을 확인), 굽기가 실행 경로로 감, 큰 캔버스의 `nextOffset`, 작업 폴더 밖 열기·저장 거절. `npm run typecheck`, `npm test`.

## T-132 지시

`src/ai/instructions/grasshopper.md`: 먼저 읽기, `since`, 카탈로그 guid, 한 호출에 묶기(`$ref`), 스크립트 컴포넌트 쓰기, 결과 읽기, 굽기, 작업 폴더. Rhino 모델링 묶음에만 붙는다(`HOST_EXTRA`, `src/ai/instructions/index.ts`). Python `execute`의 정책(ADR-029)은 바꾸지 않는다: 캔버스 작업은 `gh_*` 도구로 한다.

**검증:** `tests/ai/instructions.test.mjs`(Rhino 묶음 크기 여유 유지), `grasshopper-tools.test.mjs`(Rhino에만 붙음).

## T-133 실제 Rhino 확인 (대기)

이 세션은 사용자의 Rhino(작업 중)에 붙거나 플러그인을 설치하지 않았다. 아래는 설치본 반영 뒤 **합성 문서와 새 Grasshopper 정의**로, 에이전트가 띄운 Rhino가 아니라 사용자가 연 시험 창에서 확인한다(AI.md §8).

1. Grasshopper를 열지 않은 채 Rhino 턴: `gh_state`가 `loaded:false`를 답하고 플러그인·Live Sync가 그대로 돈다. 자동 모드 `gh_open`(경로 없음)이 편집기와 새 캔버스를 띄운다.
2. `gh_components "addition"` → guid로 `gh_apply` add(슬라이더 둘 + Addition + Panel) + connect + set(슬라이더 범위·값) 한 호출 → 캔버스에 보이고, Grasshopper Edit 메뉴의 되돌리기 이름이 "VIDE: … · n ops" 하나, Ctrl+Z 한 번에 모두 사라지고 Ctrl+Y로 돌아옴.
3. 같은 호출을 VIDE [되돌리기]로 되돌림 → 사라짐. 그 뒤 사용자가 캔버스를 한 번 고치고 이전 실행의 [되돌리기] → `gh-not-latest` 문구.
4. Python 3 스크립트 컴포넌트: `add {script:'python'}` + `script {inputs:[{name:'x', typeHint:'float'},{name:'pts', typeHint:'point3d', access:'list'}], outputs:['a'], source}` → 소켓 이름·형식 힌트·접근이 보이고, 계산 뒤 `states`·`gh_outputs`에 값. 문법 오류 소스 → 런타임 메시지가 결과에 옴. C# 스크립트(스크립트 모드) 같은 확인. 연결된 소켓을 빼는 요청 → `GH_SOCKET_WIRED`.
5. 두 대화가 같은 캔버스에 동시에 `gh_apply`, 그 사이 사용자가 슬라이더를 끔 → 둘 다 적용, 사용자가 지운 객체를 가리킨 작업만 `GH_OBJECT_NOT_FOUND`, `since`를 준 호출에 `GH_CHANGED_BY_OTHERS`.
6. `gh_state since` → 바뀐 객체·지운 ID만. 객체 300개 이상 정의에서 `nextOffset` 페이지.
7. `gh_capture`(전체·`ids`·`area`)가 사용자 캔버스 시점을 바꾸지 않고 이미지를 돌려줌. 보이지 않는 문서를 고르면 `GH_DOCUMENT_NOT_ACTIVE`.
8. `gh_bake` → Rhino에 객체(레이어·`vide-gh-source`), 실행 행 하나, [되돌리기]로 사라지고 Live Sync 보기에 반영.
9. `gh_open`(작업 폴더의 .gh) 열림, 작업 폴더 밖 경로는 `GH_OUTSIDE_WORK_FOLDER`. `gh_save`가 작업 폴더에 저장.
10. Value List 항목·선택, Boolean Toggle, Panel 글, 컴포넌트 입력 값(`param`+`data`) 쓰기. Button 값 요청은 `GH_BUTTON_UNSUPPORTED`이고 대화상자가 뜨지 않음. 요청하지 않은 객체는 움직이지 않음.
11. Disable Solver 상태에서 `gh_apply` → 계산하지 않고 `solver-disabled` 알림, 계산기를 켜지 않음.

**완료 기준:** 1~11이 합성 정의에서 통과하고 VERIFY 기록(`docs/tdd/VERIFY-<날짜>-grasshopper.md`)이 남는다. 실패 항목은 이 절에 남기고 고친다.

## T-134 다음 (필요할 때)

실사용에서 관찰된 문제만 고친다(ADR-031 3, AI.md §8 「실행 우선」): 큰 정의의 `gh_state` 비용, 클러스터 내부 읽기, 스크립트 컴포넌트 표면이 바뀐 Rhino 서비스 릴리스 대응, 화면의 Grasshopper 실행 행 표시 다듬기.

## 범위 밖

중개자·지문 CAS·수용 판정·git 이력(ADR-033 2), 자동 정렬, Button 값, 사용자 원본 정의의 열기·저장, 여러 파일 요청의 캔버스 자동 되돌림, Grasshopper 전용 Sync·연결 행.
