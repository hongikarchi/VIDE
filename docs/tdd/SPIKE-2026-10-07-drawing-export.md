---
id: SPIKE-2026-10-07-drawing-export
title: Rhino 8 DWG 내보내기의 도면 형식 보존
status: review
version: 0.1
updated: 2026-10-07
owner: agent:claude
related: [PLAN-43, T-199, C-08, HOST-RHINO, HOST-ZWCAD]
---

# Rhino 8 DWG 내보내기의 도면 형식 보존

[PLAN-43](../plans/PLAN-43-section-finish-xref-submit.md) T-199의 실험 기록이다. 호스트 지원표([rhino](../specs/hosts/rhino.md), [zwcad](../specs/hosts/zwcad.md))에는 내보내기 행이 아직 없어 H-* 행 대신 지원표 문서를 인용한다. 결과는 [C-08](../PRD.md)(모델 → CAD 역반영) 채택 판단의 근거다.

## 질문

Rhino 8에서 DWG로 내보낸 뒤 다음이 남는가? 내보내기 체계(scheme)에 따라 달라지는가?

- 레이아웃(페이지 뷰)과 디테일(축척, 잠금)
- 치수(선형·정렬·각도·반지름·지름): 값, 치수 스타일 이름, 문자 높이, 화살표
- 문자와 문자 스타일(글꼴, 높이)
- 블록과 링크 블록(xref로 바뀌는가)
- 레이어(이름, 색, 선종류, 인쇄 폭 → 선가중치)
- 해치

## 방법

코드: `tools/spikes/2026-10-07-drawing-export/` (다시 돌리는 법은 같은 폴더 README). 작업 파일은 `.vide/spikes/drawing-export/`(Git 제외)에만 만들었다.

1. **합성 모델(숨은 Rhino 8):** `run.mjs`가 VIDE worker와 같은 방식으로 Rhino를 띄웠다(`/nosplash /notemplate /scheme=VIDE-Spike-Export /runscript="_-RunPythonScript (build-model.py)"`). `build-model.py`는 다음을 만들었다.
   - 레이어 8개: 색 7종(트루컬러 128,64,32 포함), 인쇄 폭 0.09~0.70, 사용자 선종류 `VIDE-DASHED`, 한글 이름 `치수-한글`
   - 곡선: 사각형 폴리선, 사선, 원, 호, 그리드 선
   - 치수 스타일: `VIDE-DIM-100`(Arial 2.5, 화살표 2.5, 축척 100), `VIDE-DIM-TICK`(틱 화살표), 문자용 `VIDE-TEXT-35`(맑은 고딕 3.5)
   - 치수 6개: 선형 10000, 회전 선형 6000(틱), 정렬 5000, 각도 53.13°, 반지름 1500, 지름 3000
   - 문자 2개: `ROOM 101`, `거실 LIVING`
   - 블록 `VIDE-COLUMN` 삽입 4개, 두 번째 합성 3dm(`linked-part.3dm`)을 가리키는 링크 블록 1개(`UpdateType=Linked`)
   - 해치 2개: Hatch1(축척 100), Solid
   - 레이아웃 2개: `A3-PLAN`, `A3-상세`. 각각 A3(420×297 mm)이고, 디테일은 1:100·1:50 잠금이다. 종이 공간에는 테두리와 제목 문자가 있다.
2. **내보내기:** 3dm을 저장한 뒤 체계마다 `_-SaveAs "<file>.dwg" _Scheme "<name>" _Enter`를 실행했다. 비교를 위해 `_SelAll _-Export`(Default 체계)도 1회 실행했다. 실행 결과는 명령 기록(`rhino-log.txt`)에 남겼다. Rhino 8 기본 체계는 `export_ACAD.rhp`에 있는 다음 13개다: Default, R12 Natural, 2007·2010·2013·2018 × Lines·Natural·Solids. 이번에는 2018 Lines, 2018 Natural, 2018 Solids, Default를 시험했다.
3. **다시 읽기(숨은 ZWCAD 2023):** `DrawingExportProbe.cs`(명령 `VIDEDRAWINGPROBE`)가 각 DWG를 사이드 DB(`ReadDwgFile`, 읽기 전용)로 열어 덤프를 썼다. 덤프 항목은 버전, 레이어, 선종류, 문자·치수 스타일, 블록(`IsFromExternalReference`·`PathName`·`IsLayout`), 레이아웃과 뷰포트(`CustomScale`·`Locked`·`On`·`ViewTarget`), 공간별 개체 수, 치수·문자·해치·삽입 개체다. 판독기 쪽 한글 문제를 가르려고 ZWCAD가 직접 쓴 대조 도면(`control-zwcad.dwg`)도 함께 읽었다.
4. Rhino 쪽 기준값(치수 `NumericValue`, 디테일 `PageToModelRatio`, 레이어·스타일)은 `rhino-summary.json`에 기록해 대조했다.

## 환경

| 항목 | 값 |
|---|---|
| OS | Windows 11 Pro 10.0.26200 (한국어) |
| Rhino | Rhino 8 8.35.26251.13001, `export_ACAD.rhp`, Python 3 스크립트 |
| ZWCAD | ZWCAD 2023 전문가용 23.20.3.11 (빌드 2022.12.03 #4996), .NET 사이드 DB |
| 빌드 | .NET Framework 4 `csc.exe` (x64), Node 24.21.0 |

## 결과 비교표

판정은 보존·변형·소실이다. 체계 열은 `_-SaveAs` 결과다. `SelAll+Export`는 Default 체계로 `_-Export`한 결과다.

| 항목 | 2018 Lines | 2018 Natural | 2018 Solids | Default | SelAll+Export | 비고 |
|---|---|---|---|---|---|---|
| DWG 버전 | AC1032 (2018) | AC1032 | AC1032 | **AC1021 (2007)** | AC1021 | Default 체계는 2007 형식이다. |
| 레이아웃 | 보존 | 보존 | 보존 | 보존 | **소실** | `A3-PLAN`, `A3-상세`, ISO A3 297×420 mm가 남았다. 빈 레이아웃 `배치1`·`배치2`가 추가된다. `-Export`는 빈 Layout1·2만 남는다. |
| 디테일 축척 | 보존 | 보존 | 보존 | 보존 | 소실 | CustomScale 0.01/0.02(1:100/1:50), ViewHeight 25700/12850이다. ViewTarget은 모델 중심이다. |
| 디테일 잠금 | 보존 | 보존 | 보존 | 보존 | 소실 | `Locked=true` |
| 뷰포트 켜짐 | 확인 필요 | 확인 필요 | 확인 필요 | 확인 필요 | — | 사이드 DB에서 축척 뷰포트의 `On=false`다. 화면 확인을 하지 않았다. |
| 종이 공간 테두리·제목 | 보존(선 4개로 분해) | 보존 | 보존 | 보존 | 소실 | 제목 MText 높이 3.5 |
| 선형 치수 값 | 보존 | 보존 | 보존 | 보존 | 보존 | 10000, 6000(회전)이 RotatedDimension으로 남는다. |
| 정렬 치수 | 변형 | 변형 | 변형 | 변형 | 변형 | 값 5000은 같다. 형식은 정렬 방향으로 회전한 RotatedDimension이 된다. |
| 각도 치수 | 보존 | 보존 | 보존 | 보존 | 보존 | 0.9273 rad(53.13°)이고, 문자 `<>`가 측정값과 연동된다. |
| 반지름·지름 치수 값 | 보존 | 보존 | 보존 | 보존 | 보존 | R1500, Ø3000 |
| 치수 문자 연동 | **변형** | 변형 | 변형 | 변형 | 변형 | 각도 외 모든 치수가 고정 문자 재정의다(`10000`, `R1500`, `Ø3000` 등). CAD에서 치수를 고쳐도 문자가 갱신되지 않는다. |
| 치수 스타일 | 보존 | 보존 | 보존 | 보존 | 보존 | 사용한 스타일만 나간다. 이름·DIMTXT 2.5/2.0·DIMASZ·DIMSCALE 100·DIMDEC 0이 남고, 틱은 `_ArchTick`이 된다. `STANDARD_ACAD`가 추가된다. 문자 전용 스타일은 치수 스타일로 나가지 않는다. |
| 치수 화살표 크기 | 변형 | 변형 | 변형 | 변형 | 변형 | 반지름·지름 치수는 개체 재정의 DIMASZ=1.0이다(스타일은 2.5). 선형·각도는 스타일 값을 따른다. |
| 문자 스타일 | 변형 | 변형 | 변형 | 변형 | 변형 | 이름과 Arial(`arial.ttf`)은 남고 높이는 0(가변)이다. **한글 글꼴 이름 `맑은 고딕`은 깨진다**(`留묒\M+39D80 怨좊뵓`, UTF-8 바이트가 ANSI로 기록됨). 글꼴 대체가 예상된다. |
| 문자 내용·높이 | 보존 | 보존 | 보존 | 보존 | 보존 | TextEntity는 MText가 되고 `거실 LIVING`이 정상이다. 모델 문자 높이는 350(=3.5×100)으로 고정되며 주석 축척은 없다. |
| 블록 정의·삽입 | 보존(내부 곡선 분해) | 보존 | 보존 | 보존 | 보존 | `VIDE-COLUMN` 삽입 4개의 위치가 일치한다. |
| 링크 블록 | **소실(일반 블록)** | 소실 | 소실 | 소실 | 소실 | `linked-part`는 `IsFromExternalReference=false`이고 PathName이 없다. 내용은 포함되지만 링크는 끊긴다. Lines에서는 원이 선 182개가 된다. |
| 레이어 이름 | 보존 | 보존 | 보존 | 보존 | 보존 | 한글 `치수-한글`도 남는다. 개체가 없는 레이어는 내보내지 않는다(1차 실행에서 확인). `0`·`Default`·`Defpoints`가 추가된다. |
| 레이어 색 | 보존 | 보존 | 보존 | 보존 | 보존 | 트루컬러(ByColor)와 근사 ACI로 남는다. 128,64,32는 RGB가 그대로 남는다. |
| 선종류 | 보존 | 보존 | 보존 | 보존 | 보존 | `VIDE-DASHED`(선분 2개, 길이 9) |
| 인쇄 폭 → 선가중치 | 보존 | 보존 | 보존 | 보존 | 보존 | 0.09·0.13·0.18·0.25·0.35·0.50·0.70이 정확히 일치한다. |
| 해치 | 보존 | 보존 | 보존 | 보존 | 보존 | Solid는 `SOLID`(PreDefined)가 된다. Hatch1은 CustomDefined `Hatch1`로 남고 축척 100, 경계 1개다. |
| 곡선 | **변형(선분화)** | 보존 | 보존 | 보존 | 보존 | Lines는 원·호·폴리선을 선분으로 분해한다(모델 선 262개). 나머지는 Arc·Circle·Polyline2d를 유지한다. |
| 단위 | 보존 | 보존 | 보존 | 보존 | 보존 | INSUNITS=4(mm)이고, 모델 탭 용지는 Letter 기본값이다. |

**요약:** 2018 Natural과 2018 Solids는 2D 도면 요소에서 결과가 같다. Lines는 곡선을 선분화하는 것만 다르다. Default는 형식이 2007(AC1021)인 것만 다르다. 체계 차이는 곡선 표현과 파일 버전에 그치고, 아래 손실은 모든 체계에 공통이다.

- 치수 문자가 고정 재정의로 바뀐다.
- 반지름·지름 치수의 화살표 크기가 바뀐다.
- 정렬 치수가 회전 치수로 바뀐다.
- 한글 글꼴 이름이 깨진다.
- 링크 블록이 일반 블록이 된다.
- 레이아웃은 `_-SaveAs`에서만 남는다. `_-Export`는 선택한 모델 개체만 쓴다.

## 한계

- 결과는 ZWCAD 사이드 DB의 속성값으로만 판정했다. 화면 표시(뷰포트 켜짐, 글꼴 대체, 해치 모양, 치수 배치)와 AutoCAD는 확인하지 않았다.
- 합성 모델은 2D 평면 도면 요소만 다룬다. 3D 객체, Make2D, 단면·클리핑, 주석 축척(annotative), 여러 디테일·레이아웃 대량 처리는 시험하지 않았다.
- 링크 블록은 RhinoCommon `ModifySourceArchive(..., Linked)`로 만들었다. UI `Insert`의 링크 모드와 같은지는 확인하지 않았다.
- 한글 글꼴 이름 판정의 근거는 기록된 바이트 패턴이다. ZWCAD 대조 도면의 글꼴 지정은 API에서 반영되지 않았다(typeface 빈 값). 한글 레이어·문자·레이아웃 이름은 대조 도면과 Rhino 내보내기 모두 정상으로 읽혔다.
- **ZWCAD 2023 결함:** Rhino가 쓴 치수의 `Dimension.TextStyleId`를 사이드 DB에서 읽으면 ZWCAD가 ZwDatabase.dll 접근 위반(0xC0000005)으로 종료된다. probe는 이 속성을 빼고 다시 실행했다. 비정상 종료 뒤 `%APPDATA%\ZWSOFT\ZWCAD\2023\ko-KR\CrashReport`에 dmp가 남는다. 그러면 다음 ZWCAD 시작이 "진단 정보를 전송하시겠습니까?" 창에서 멈추고, 숨은 실행에서는 아무도 답할 수 없다. 실험 중 같은 PC의 다른 작업자가 띄운 숨은 ZWCAD도 이 창에서 멈췄다. 실험은 자기가 띄운 PID의 창에서만 [아니오]를 눌러(`dismiss-crash-prompt.ps1`) dmp를 정리했다. 종료 시점에 대기 중인 dmp는 없다. 제품의 숨은 ZWCAD 실행(`hosts/zwcad/knowledge-dwg.ts`, `inspector.ts`)도 같은 상황에서 멈출 수 있다.
- 내보내기 체계 선택은 Rhino 스킴(`VIDE-Spike-Export`) 설정에 남는다. 사용자 스킴(Default)은 바꾸지 않았다.

## 다음 PLAN 후보 방식

| 방식 | 내용 | 장점 | 부담 |
|---|---|---|---|
| A. Rhino 레이아웃 + `_-SaveAs` DWG(2018 Natural) + ZWCAD 후처리 | Rhino 페이지 뷰로 도면 세트를 만들고 DWG로 저장한다. 숨은 ZWCAD가 사본에서 손실을 고친다: 치수 문자 `<>` 복원, 반지름·지름 DIMASZ 재정의 제거, 글꼴 이름 교정, 빈 `배치1·2` 삭제, 뷰포트 켜기, 링크 블록을 xref로 다시 연결. | 레이아웃·축척·레이어·선가중치·해치가 이미 남아 구현량이 가장 작다. | 후처리 규칙을 Rhino 버전마다 확인해야 한다. 3D → 2D는 Make2D 품질에 의존한다. |
| B. ZWCAD API로 DWG 직접 생성 | VIDE가 모델 데이터(2D 투영 결과)를 받아 레이어·블록·연동 치수·xref·레이아웃을 ZWCAD 사이드 DB에 직접 쓴다. | 형식을 완전히 통제한다(연동 치수, xref, 회사 스타일). | 개체 변환과 투영(Make2D 대체)을 새로 만들어야 한다. 이번에 드러난 ZWCAD .NET 결함을 피해야 한다. |
| C. 템플릿·기존 도면 기반 반영 | 회사 DWG 템플릿이나 연결된 기존 CAD 도면의 사본을 기준으로 한다. 레이어·스타일·도곽·xref 구조는 유지하고, 모델에서 나온 기하(A의 2018 Natural 결과)만 블록이나 xref로 넣거나 교체한다. | C-08의 "형식을 지켜 반영"에 가장 가깝다. 기존 도면의 치수·문자 스타일을 그대로 쓴다. | 바꿀 범위(어느 블록·레이어를 교체할지)를 정하는 규칙이 필요하다. T-200 xref 그래프에 의존한다. |

**권고:** C-08에는 C(기존 도면 사본 기준)를 기본으로 하고, 기하 공급은 A의 2018 Natural 내보내기를 쓴다. 새 도면 세트를 Rhino 레이아웃에서 바로 만드는 경우만 A를 단독으로 쓴다. 이때도 치수 문자, 화살표, 한글 글꼴, 링크 블록 후처리는 필수다. Lines 체계(곡선 선분화)와 Default 체계(2007 형식)는 기본값으로 쓰지 않는다. B는 연동 치수나 xref를 처음부터 만들어야 할 때 검토한다. 어느 방식이든 숨은 ZWCAD의 오류 보고 창 처리(위 한계)를 먼저 해결해야 한다.
