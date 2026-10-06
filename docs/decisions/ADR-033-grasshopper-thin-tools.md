---
id: ADR-033
title: Grasshopper — 얇은 캔버스 도구, 검증 계층 없음, 호출 하나가 Grasshopper 되돌리기 한 단계
status: review
version: 0.1
updated: 2026-10-06
owner: agent:claude
related: [ADR-022, ADR-027, ADR-028, ADR-029, ADR-031, HOST-RHINO, SPEC-02, ARCH-01, PLAN-29]
---

# Grasshopper — 얇은 캔버스 도구

## 결정

2026-10-06 사용자 결정(결정 1·2): "무거운 검증 계층은 필요없고, canvas 인식, component 인식, script 자동으로 쓰기, component 배치, 동시에 canvas 조작하기 등 기능만 정상적으로 작동하면 될 것 같아. vide는 가능한 llm native 기능을 방해하는게 아니라, 도움을 주는 쪽으로." 같은 날 추가 요구(결정 4): 여러 대화와 사용자가 **같은 캔버스를 동시에** 고칠 수 있어야 하고, 한 호출에 작업 여럿을 담는다. 결정 3·5·6은 이를 [ADR-022](ADR-022-direct-apply-plan-auto.md)(바로 적용)·[ADR-031](ADR-031-stock-first.md)(순정 우선) 안에서 구현하기 위한 구체화이며 사용자 확인을 기다린다(`status: review`). 작업은 [PLAN-29](../plans/PLAN-29-grasshopper.md), 지원표는 [HOST-RHINO](../specs/hosts/rhino.md) H-RHINO-10~12, 동작은 [SPEC-02](../specs/SPEC-02-execution-candidates.md).13의 8, 도구 목록은 [ARCH-01](../architecture/ARCH-01-system.md) §3이다.

1. **Grasshopper는 Rhino 턴의 도구다.** 별도 호스트·연결·Sync를 만들지 않는다. 사용자가 VIDE에 연결한 Rhino 문서의 그 Rhino 프로세스에 있는 Grasshopper를, 같은 플러그인(`hosts/rhino/worker`)의 고정 메서드로 읽고 고친다. `linkId`로 다른 열린 연결 문서를 고르면 그 Rhino의 Grasshopper다. Grasshopper가 실행 중이 아니어도 플러그인은 그대로 돈다(Grasshopper 형식을 쓰는 코드는 Grasshopper가 로드된 뒤에만 불린다).
2. **얇은 도구, 검증 계층 없음.** 중개자(broker), 지문 비교(CAS)·사전 조건 거절, 수용 판정식, git 이력 층을 두지 않는다(Vino에 있던 것). 도구는 아홉: `gh_state`(캔버스 읽기), `gh_components`(설치된 컴포넌트 찾기), `gh_apply`(편집 묶음), `gh_solve`, `gh_outputs`(출력 데이터 요약), `gh_bake`, `gh_capture`(캔버스 이미지), `gh_open`·`gh_save`. AI는 읽고, 고치고, 계산 결과의 메시지와 데이터를 읽어 스스로 고친다. 상한은 물리적 한계(호스트 응답 16 MB, 도구 결과 약 96 KB는 잘라서 `nextOffset`)뿐이다(ADR-031 3·7).
3. **호출 하나 = Grasshopper 되돌리기 한 단계.** `gh_apply`의 작업들(추가·삭제·이동·연결·연결 끊기·값·스크립트·그룹·선택)은 Rhino UI 스레드에서 차례로 적용되고, 바꾼 것 전부가 `GH_UndoRecord` 하나("VIDE: <대화 제목 또는 요청> · <n> ops")로 그 Grasshopper 문서의 되돌리기 목록에 들어간다. 사용자는 Grasshopper의 Ctrl+Z로, VIDE에서는 그 실행 행의 [되돌리기]로 되돌린다. [되돌리기]는 그 기록이 **그 문서의 가장 새 Grasshopper 기록일 때만** 하고, 아니면 `gh-not-latest`(그 뒤에 Grasshopper에서 다른 편집이 있음 · Grasshopper의 Ctrl+Z로 되돌리거나 나중 편집부터 되돌리기)로 답한다(SPEC-02.13 3의 마지막 기록 규칙 그대로). 기록은 요청 결과의 `executions[]`에 `kind: 'grasshopper'`로 남는다(`undoId` `gh:<문서>:<기록>`).
4. **같은 캔버스를 동시에.** 캔버스 작업에는 문서 잠금(`DOCUMENT_LOCKED`·요청의 쓰기 차지)도 실행 대기열도 쓰지 않는다. 다른 대화의 읽기와 `gh_apply`는 함께 돌고, 호출 하나는 UI 스레드 작업 하나로 원자적으로 적용되며, 호출끼리는 UI 스레드에서만 차례가 생긴다. 작업은 객체를 인스턴스 ID로 가리키고, 대상이 사라졌거나(`GH_OBJECT_NOT_FOUND`) 맞지 않는(`GH_TYPE_MISMATCH` 등) 작업은 그 작업만 실패하고 나머지는 적용된다. 같은 객체를 동시에 고치면 나중 쓰기가 이긴다. 플러그인은 Grasshopper 문서마다 변경 번호(revision)를 세어(객체 추가·삭제·연결·값·배치·만료·계산 끝) `gh_state since`가 바뀐 객체와 지워진 ID만 돌려주게 하고, `gh_apply since`는 이 호출이 고친 객체를 그 뒤 다른 사람이 고쳤으면 알림(`GH_CHANGED_BY_OTHERS`, 거절 아님)을 붙인다. 여러 파일 요청의 자동 되돌림(ADR-027 3)은 캔버스 기록을 되돌리지 않는다(공유 캔버스이므로 사용자의 [되돌리기]·Ctrl+Z에 맡긴다).
5. **굽기(bake)는 Rhino 실행 경로로.** `gh_bake`는 고른 출력의 데이터를 그 Rhino 문서의 객체로 만든다. 요청 본문을 `direct-execute`의 `language: gh-bake`로 보내므로 Rhino 되돌리기 기록 하나, 같은 문서 실행 대기열, 바뀐 객체 목록, 보호 확인, [되돌리기], Live Sync가 `execute`와 같다. 구운 객체에는 사용자 문자열 `vide-gh-source`(`<문서>:<객체>:<출력>`)를 붙인다.
6. **파일은 프로젝트 작업 폴더 안에서만.** `gh_open`·`gh_save`의 경로는 프로젝트 작업 폴더(ADR-031 8, SPEC-01.13) 안이어야 하고(실제 경로로 비교), 밖이면 `GH_OUTSIDE_WORK_FOLDER`로 거절한다. 사용자의 원본 정의는 사용자가 Grasshopper에서 연다. 경로 없는 `gh_open`은 Grasshopper를 띄우고 문서가 없으면 새 캔버스를 만든다.
7. **AI가 하지 않는 것.** 요청하지 않은 자동 정렬(auto-tidy)로 캔버스를 다시 배치하지 않는다(새 객체에 좌표가 없으면 기존 객체 오른쪽에 둔다). Button 값은 쓰지 않는다(대화상자를 띄울 수 있음, `GH_BUTTON_UNSUPPORTED`). 사용자가 끈 계산기(Disable Solver)를 켜지 않고 알린다. 고정 시간 상한(Vino의 45초)을 두지 않는다(호스트 호출 상한 600초만).

## 맥락

- PRD는 Grasshopper를 지원·검수 원칙에 따라 확장할 수 있는 추가 호스트로 둔다(§4.4). 사용자는 Rhino를 쓰면서 Grasshopper로 형상을 만들고, 터미널의 Claude Code·Codex는 Rhino MCP의 Grasshopper 도구로 캔버스를 읽고 고친다. VIDE에는 그 길이 없었다.
- Vino(`C:\Users\user\Desktop\Vino`, Apache-2.0)는 Wireify(Apache-2.0)·Cordyceps(MIT)를 참고해 Grasshopper 캔버스·스크립트 어댑터를 만들었지만, 문서 지문 CAS·사전 조건 거절·수용 판정·git 이력이 겹겹이 있어 작업이 자주 거절되고 느렸다(`docs/log-review-2026-08-26`: Button 값 쓰기의 모달, 요청하지 않은 자동 정리, 45초 고정 시간 상한). 이 결정은 그 동작 지식(스크립트 컴포넌트의 소스·소켓·형식 힌트, 슬라이더 범위 순서, 되돌리기 기록)만 가져오고 검증 층은 가져오지 않는다.
- Rhino 8의 Grasshopper는 `%ProgramFiles%\Rhino 8\Plug-ins\Grasshopper\Grasshopper.dll`로 함께 설치된다. 플러그인은 RhinoCommon과 같이 설치본 경로를 참조하고 복사하지 않는다(`Private=false`).

## 선택지

| 질문 | 안 | 판단 |
|---|---|---|
| 검증 | 지문 CAS·수용 판정(Vino) / 없음 | 없음(사용자 결정). 실패는 작업마다 코드로 돌려주고 AI가 고친다 |
| 되돌리기 단위 | 작업마다 기록 / 호출마다 기록 하나 | 호출마다 하나(실행 하나가 되돌리기 한 단계인 ADR-022·029와 같다) |
| 동시 편집 | 문서 잠금·대기열 / 잠금 없음 + 변경 번호 알림 | 잠금 없음(사용자 요구). 사람이 같은 캔버스를 만지는 것과 같은 규칙: 나중 쓰기가 이기고, 알림으로 다시 읽게 한다 |
| 굽기 | 캔버스 도구 안에서 / Rhino 실행 경로 | Rhino 실행 경로. Rhino 문서 쓰기는 이미 되돌리기·대기열·Live Sync가 있다 |
| Python의 `import Grasshopper` | 정책 완화 / 그대로 | 그대로. 캔버스 작업은 `gh_*` 도구로 한다(Python `execute`의 정책은 ADR-029 그대로) |
| 참조 방식 | NuGet `Grasshopper` 8.x / 설치본 경로 | 설치본 경로(기존 RhinoCommon 참조 방식과 같음) |

## 결과

- AI는 Rhino 턴에서 캔버스를 읽고(`gh_state`), 컴포넌트를 찾아(`gh_components`) 배치·연결·값·스크립트를 한 호출로 적용하고(`gh_apply`), 메시지·데이터를 읽어(`gh_outputs`·`gh_capture`) 고치고, 결과를 Rhino에 굽는다(`gh_bake`). 계획 모드는 읽기 넷만 받는다.
- 남은 위험: (1) 실제 Rhino 8에서 시험하지 않았다(PLAN-29의 실호스트 확인 목록). 특히 RhinoCode 스크립트 컴포넌트의 리플렉션 표면(`SetSource`·`ReBuild`·`IScriptParameter`)은 Rhino 서비스 릴리스에서 바뀔 수 있다. (2) 스크립트 소켓 변경의 되돌리기는 컴포넌트 전체 상태(`GH_GenericObjectAction`)로 하므로, 지운 소켓에 연결돼 있던 다른 객체의 연결은 되돌리지 않는다(그래서 연결된 소켓은 지우지 않는다: `GH_SOCKET_WIRED`). (3) 같은 객체의 동시 수정은 나중 쓰기가 이기며 알림은 호출 뒤에 온다. (4) `gh_open`의 정의 열기에서 Grasshopper가 누락 컴포넌트 대화상자를 띄울 수 있다.

## 고치는 결정

| 원본 | 지금 문구(요지) | 이 결정으로 |
|---|---|---|
| ADR-027 3(전부 또는 전무) | 여러 파일 요청이 실패하면 적용한 실행을 모두 되돌린다 | Grasshopper 캔버스 기록은 자동으로 되돌리지 않는다(공유 캔버스). 사용자의 [되돌리기]에는 든다 |
| ADR-027 5(다른 파일의 잠금) | 다른 파일은 처음 쓸 때 잠근다 | 캔버스 작업은 잠그지 않는다. 굽기는 Rhino 실행이라 기존 규칙 그대로 |
