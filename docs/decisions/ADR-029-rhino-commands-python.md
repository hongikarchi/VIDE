---
id: ADR-029
title: AI가 Rhino 명령과 Python도 실행한다 — 실행 하나는 되돌리기 한 단계, 위험 명령은 거절하거나 확인한다
status: review
version: 0.2
updated: 2026-10-02
owner: user
related: [FR-04, FR-10, FR-12, AC-38, SPEC-02, HOST-RHINO, ARCH-01, ADR-022, ADR-027, RESEARCH-11, PLAN-24]
---

# AI가 Rhino 명령과 Python도 실행한다

## 결정

2026-10-02 사용자 결정: "Rhino 명령, Python은 열어줘야지". 결정 1은 사용자가 정했다. 결정 2~5는 그것을 [ADR-022](ADR-022-direct-apply-plan-auto.md)의 바로 적용과 보호 규칙 안에서 구현하기 위한 구체화이며 사용자 확인을 기다린다(`status: review`). 동작 정본은 [SPEC-02](../specs/SPEC-02-execution-candidates.md).11의 4·.13의 4, 물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md) §4 「바로 적용 경로」, 지원표는 [HOST-RHINO](../specs/hosts/rhino.md) H-RHINO-08, 작업은 [PLAN-24](../plans/PLAN-24-ai-conversations.md#t-106) T-106이다.

1. **세 형식.** 자동 모드에서 열린 Rhino 문서에 바로 실행하는 AI의 `execute`는 지금의 C# 메서드 본문(`code`) 말고도 **Rhino 명령 매크로**(`command`, 예: `_-SelDup _Enter`)와 **Python 스크립트**(`python`)를 받는다. 호출 하나에 형식 하나다. [RESEARCH-11](../research/RESEARCH-11-ai-parity.md) §3의 'Rhino 명령은 쓰지 않는다'를 대체한다.
2. **실행 하나는 되돌리기 한 단계.** 명령과 Python도 C#과 같이 VIDE가 연 되돌리기 기록 안에서 돌고, 바뀐 객체 목록(추가·수정·삭제·레이어)을 실행 전후 비교로 보고하며, 실패하면 그 기록을 되돌린다. Rhino가 명령의 기록을 VIDE의 기록 안으로 합치지 않고 따로 남기면, VIDE는 그 실행이 만든 기록 전부를 한 실행으로 묶어 [되돌리기] 한 번에 함께 되돌린다(Rhino의 Ctrl+Z는 기록마다 한 번씩). 묶음은 그 기록이 **모두** 되돌려졌을 때만 '되돌림'이다: Ctrl+Z로 일부만 되돌렸으면 [되돌리기]가 남은 기록을 되돌리고, Ctrl+Y로 하나라도 다시 실행하면 다시 '적용됨'이다.
3. **명령은 목록으로 거르고, 파일을 쓰는 명령은 확인한다.**
   - **거절:** 문서를 열기·가져오기·닫기·새로 만들기·종료(`Open`·`Import*`·`Insert`·`New`·`Close`·`Exit`), 디스크의 스크립트나 파일 실행(`RunScript`·`RunPythonScript`·`LoadScript`·`ReadCommandFile`·`ScriptEditor`·`GrasshopperPlayer` 등), 앱 설정·플러그인·단위(`Options`·`DocumentProperties`·`Units`·`PlugInManager`·`LoadPlugIn`·`PackageManager`), 되돌리기 제어(`Undo`·`Redo`·`ClearUndo` 등), 사용자 입력 대기(`Pause`). 거절한 명령은 호스트에 보내지 않고 AI가 다른 방법으로 고친다(`CODE_POLICY_REJECTED`).
   - **확인:** 파일을 쓰는 명령(열린 원본을 덮어쓰는 `Save` → `save` '원본 파일 덮어쓰기', `SaveAs`·`IncrementalSave`·`Export*`·`ViewCaptureToFile` → `save-as`·`export`, `Print` → `publish`)과 `Purge`(되돌릴 수 없음 → `purge`)는 실행하기 **전에** 보호 확인 카드를 띄우고, [진행]이 같은 명령을 보호를 푼 채 다시 실행한다. 이 경우 파일 쓰기가 사용자 확인 뒤 AI 실행으로 일어난다(ADR-022 결정 3의 '경로를 지정한 다른 이름 저장·내보내기'는 확인을 거친다는 규칙 그대로).
   - 한 매크로에 보호 명령이 여럿이면 카드 하나가 **모든** 명령을 내용에 적고, 종류는 가장 무거운 것(`save` > `save-as` > `purge` > `export` > `publish`)을 보인다. [진행]은 카드에 적힌 명령 전부를 허락한다.
   - 일괄 삭제·레이어 삭제는 지금처럼 실행 뒤 호스트가 세어 보류한다.
   - 이름은 매크로의 낱말로 판정한다(앞의 `_`·`-`·`!`·`'`와 `=` 뒤 값은 떼고, 따옴표 안의 값은 명령이 아님). 다른 명령의 옵션 이름과 겹치는 `New`·`Close`·`Undo`·`Redo`·`Insert`·`Save`는 **그 옵션을 가진 명령 바로 뒤**(그 명령이 명령 자리 — 매크로 처음, 줄 처음, `_Enter`·`_Escape`·`_Cancel`·`_Close` 뒤, `!` 접두 — 에 있고 그 사이에 명령 자리가 없을 때)에서만 옵션으로 보고, 그 밖의 자리에서는 명령으로 판정한다. 묻지 않는 명령(`_SelAll` 등) 뒤의 낱말은 다음 명령이기 때문이다. 옵션 주인: `New` ← `Layer`, `Close` ← `Polyline`·`Curve`·`InterpCrv`·`InterpCrvOnSrf`, `Undo` ← 그 넷과 `Lines`·`Points`, `Save` ← `NamedView`·`NamedCPlane`·`NamedPosition`·`Snapshots`; `Redo`·`Insert`는 어디서나 거절. 호스트는 명령 매크로와 Python 실행 중 시작된 명령의 영어 이름도 같은 목록으로 확인해(`Command.BeginCommand`), 별칭이나 Python으로 숨은 거절·미확인 보호 명령이 돌면 그 실행을 되돌리고 거절로 답한다.
4. **Python은 Rhino 8의 Python 3, 파일 없이 메모리에서 돈다.** 플러그인은 Rhino 8의 스크립트 실행기(`Rhino.Runtime.Code`, `RhinoCode.Languages.QueryLatest(LanguageSpec.Python3)` → `CreateCode(text)` → `Run`)로 스크립트 문자열을 바로 실행한다. 임시 파일을 쓰지 않는다. `scriptcontext.doc`이 그 문서이고 `print`가 결과 로그다. 실행기의 자체 되돌리기 기록(`RecordDocumentUndo`)은 끄고 VIDE의 기록 하나를 쓴다. IronPython 2는 쓰지 않는다.
5. **Python의 차단은 최선 노력의 정적 검사이고, Python 전체를 확인 카드에 걸지 않는다.** Python에서 파일·네트워크·프로세스를 완전히 막는 것은 실용적이지 않다(동적 import 등). 그래도 사용자 결정 1의 뜻이 'AI가 쓸 수 있게 연다'이므로 모든 Python 실행에 확인을 받지 않는다. 대신 실행 전에 금지 패턴을 거절한다: `os`·`sys`·`subprocess`·`socket`·`shutil`·`ctypes`·`urllib`·`http`·`pathlib`·`io`·`clr`·`importlib` 등의 import, `open`·`exec`·`eval`·`compile`·`__import__`·`input`, .NET `System.IO`·`Net`·`Diagnostics`·`Reflection`·`Threading`, `Rhino.FileIO`·`PlugIns`·`UI`·`Runtime`·`Commands`, `RhinoApp`, 명령 실행(`rs.Command` 등 `.Command` 참조, 이름만 쓴 `Command(`, `rhinoscriptsyntax`의 `*`·`Command` import)과 되돌리기 제어. `Purge*`·`Compact` 호출은 C#처럼 실행 전 `purge` 확인이다. 이것은 C#의 `CodePolicy`와 같은 심층 방어이며 OS 보안 경계가 아니다(ARCH-01 「생성 코드 검사」와 같은 한계).

## 맥락

- ADR-022 뒤 AI는 열린 Rhino 문서를 바로 고치지만 RhinoCommon C# 본문만 쓸 수 있었다. `CodePolicy`가 `Rhino.Commands`·`RhinoApp`을 막아 `_SelDup`·`_MergeAllFaces`·`_Purge` 같은 내장 명령이 한 줄이면 끝날 일을 C#으로 다시 짜야 했고, 터미널 Claude Code와 비교(RESEARCH-11)에서 차이의 한 원인이었다. RESEARCH-11 §3의 '명령을 쓰지 않는다'는 작업 사본 → 후보 경로(ADR-014) 시절의 판단이었고, 바로 적용과 되돌리기로 그 전제가 바뀌었다.
- 명령과 Python은 Rhino의 활성 문서에서만 돈다(`RhinoApp.RunScript`, `scriptcontext.doc`). Windows Rhino는 창 하나에 문서 하나라 연결 문서가 곧 활성 문서지만, 아니면 실행하지 않고 '실행하지 않음 · 그 창을 앞으로'(`DOCUMENT_NOT_ACTIVE`)로 답한다.
- 명령 매크로는 입력이 모자라면 Rhino가 사용자 입력을 기다린다. AI 지시는 대시 형식·모든 질문에 답·`_Enter`로 끝내기를 요구하고, 그래도 기다리면 호스트 실행 시간 상한(180초)에 걸려 결과 불명이 될 수 있다.

## 선택지

| 질문 | 안 | 판단 |
|---|---|---|
| 명령 실행 방법 | `RhinoApp.RunScript` / C#에서 `Command` 호출 허용 | `RunScript`를 별도 형식으로. C# 정책(`CodePolicy`)은 그대로 두어 C# 본문이 명령을 섞지 않게 한다 |
| 명령 기록 묶기 | VIDE 기록 안에서 실행 / 명령 기록을 따로 두고 묶음 | 둘 다: VIDE 기록 안에서 실행하고, Rhino가 따로 남기면 그 범위를 한 실행으로 묶는다(실제 Rhino 동작 확인 전이라 양쪽을 지원) |
| Python 엔진 | Python 3(`Rhino.Runtime.Code`) / IronPython 2(`PythonScript.Create`) / 임시 파일 + `_-RunPythonScript` | Python 3 메모리 실행. Rhino 8의 기본 Python이고 임시 파일이 필요 없다 |
| Python 안전 | 정적 거절 / 모든 Python에 확인 카드 / 막지 않음 | 정적 거절. 확인 카드는 사용자 결정의 '열어 줘야지'와 어긋나고, 막지 않으면 C# 정책과 균형이 깨진다 |
| 판정 위치 | 엔진만 / 호스트만 / 둘 다 | 둘 다. 엔진이 먼저 걸러 호스트를 부르지 않고(시험 가능), 플러그인이 같은 목록으로 다시 확인한다. 두 목록이 같은지는 시험이 확인한다 |

## 결과

- AI는 일에 맞는 형식을 고른다: 내장 명령으로 끝나는 일은 `command`, 반복·조건은 `python`, 정밀한 형상 편집·제자리 교체·검증 값 반환은 C#. 어느 형식이든 실행 한 번이 [되돌리기] 한 번이다.
- 작업 사본(가져온 파일·검토 jig)과 ZWCAD는 지금처럼 C#만 받는다(`EXECUTE_FORM_UNSUPPORTED`).
- 남은 위험: (1) 실제 Rhino에서 `RunScript`가 VIDE 기록 안으로 합쳐지는지, Python 3 실행기가 플러그인에서 처음 초기화될 때 걸리는 시간은 확인 전이다. (2) 별칭이나 Python으로 숨은 저장 명령은 실행 중에야 알 수 있고 RhinoCommon은 시작된 명령을 막지 못해, 그 실행의 기록은 되돌려도 이미 쓴 파일은 되돌릴 수 없다. (3) Python 정적 검사는 우회할 수 있다.

## 고치는 결정

| 원본 | 지금 문구(요지) | 이 결정으로 |
|---|---|---|
| RESEARCH-11 §3 | Rhino 명령은 쓰지 않는다 | 자동 모드의 열린 Rhino 문서에서는 `command`·`python`으로 쓴다(이 ADR) |
| ADR-022 결정 3 | 경로 지정 저장·내보내기는 확인 카드 | 그대로. AI의 `command`도 이 확인을 거쳐 실행할 수 있다 |
| ARCH-01 §4 「바로 적용 경로」 | `direct-execute`의 `code`는 C# 본문, 저장·내보내기는 금지 API로 컴파일 때 거절 | `language: csharp \| command \| python` 추가, 명령의 저장·내보내기는 실행 전 `guarded` |
