---
id: SPIKE-2026-10-07-drawing-backflow
title: ZWCAD 사이드 DB 쓰기·출처 표시·도곽·CTB 읽기
status: review
version: 0.1
updated: 2026-10-08
owner: agent:claude
related: [PLAN-47, T-225, SPEC-14, C-08, H-ZWCAD-12, H-ZWCAD-13]
---

# ZWCAD 사이드 DB 쓰기·출처 표시·도곽·CTB 읽기

[PLAN-47](../plans/PLAN-47-drawing-generator.md) T-225의 실험 기록이다. 기준은 [SPEC-14](../specs/SPEC-14-drawing-generator.md)의 14.4·14.7·14.8·14.9·14.15, [SPIKE-2026-10-07-drawing-export](SPIKE-2026-10-07-drawing-export.md)의 「한계」, [zwcad 지원표](../specs/hosts/zwcad.md) H-ZWCAD-12·13이다. 사용자가 2026-10-07에 0단계(이 실험)를 승인했다.

## 질문

1. 사이드 DB(`ReadDwgFile` 뒤 수정)에서 `SaveAs`할 때 원래 DWG 버전을 유지하는가. 고치지 않은 개체의 Handle·레이어·블록 정의·스타일·레이아웃·xref 부착이 그대로인가. 보통 DWG로 열리는가.
2. xref 자식 도면을 따로 고쳐 저장하면 루트의 상대 경로 해석이 유지되는가.
3. 새 개체에 xdata 출처 표시를 붙여 다시 읽을 수 있는가. 복사·이동·`WBLOCK`에서 어떻게 되는가.
4. 읽을 때 ZWCAD 2023을 죽이는 속성 목록(`Dimension.TextStyleId` 외)
5. 도곽: 속성 블록 삽입의 이름·범위·ATTRIB 값, 레이아웃의 플롯 범위·용지·플롯 스타일을 사이드 DB에서 읽을 수 있는가.
6. `.ctb`를 엔진에서 읽어 ACI별 펜 색·선가중치로 바꿀 수 있는가.

## 방법

코드: `tools/spikes/2026-10-07-drawing-backflow/`(다시 돌리는 법은 같은 폴더 README). 작업 파일은 모두 `.vide/spikes/drawing-backflow/`(Git 제외)에만 만들었다.

- **probe:** `BackflowProbe.cs`(명령 `VIDEBACKFLOW`)가 작업 목록을 숨은 ZWCAD 2023 안에서 실행한다. 도면은 모두 사이드 DB(`ReadDwgFile(OpenForReadAndAllShare)` + `CloseInput`)로 열고, 쓰기는 없는 새 경로에만 `SaveAs(경로, db.OriginalFileVersion)`로 한다.
  - `dump`: 버전, 1..HANDSEED의 살아 있는 객체 Handle→클래스 표, 개체 요약 해시(유형·레이어·색·끝점/삽입점·문자), 레이어·스타일·선종류·RegApp 이름, 블록(xref 경로), 레이아웃 플롯 설정, 속성 블록 삽입과 ATTRIB, 속성 없는 삽입의 A계열 비율 수
  - `edit`: 모형 공간의 잠기지 않은 선/폴리선 하나를 100 이동하고, 선 하나를 새로 만들어 xdata(`VIDE_ORIGIN`: 1000 원천 ID, 1071 판, 1005 자기 Handle)를 붙인 뒤 원래 버전으로 새 파일에 저장
  - `xdataops`: 표시된 선을 deep clone(COPY), `TransformBy`(MOVE·ROTATE), `Wblock`(WBLOCK), `WblockCloneObjects`(다른 도면에 붙여넣기)
  - `sweep`: 형식별 최대 300개(합성 200개) 개체의 공개 속성 전부를 리플렉션으로 읽는다. 현재 단계는 메모리 매핑 파일에 남겨 네이티브 충돌 뒤에도 속성 이름이 남는다. 충돌한 속성은 건너뛸 목록에 더하고 남은 작업을 새 ZWCAD로 다시 돌린다.
  - `resolve`/`open`: 결과 파일을 읽기 전용 문서로 열어(사용자가 여는 경로) 개체 수와 xref 상태를 본다.
- **합성 도면:** probe가 2007(AC1021)·2013(AC1027)·2018(AC1032) 형식마다 루트와 xref 자식을 새로 만들었다. 루트는 레이어, 선 5개, 회전 치수(ZWCAD가 만든 것), MText, 속성 3개(도면명·도면번호·축척)를 가진 A3 도곽 블록을 두 레이아웃에 삽입, 상대 경로(`xref\child-<버전>.dwg`) xref 1개다.
- **실도면:** 사용자 제공 실도면 세트(루트 도면 5장, xref 폴더 도면 19장(그중 보관 폴더 8장), CTB 1개)의 **사본**만 읽고 썼다. 원본 폴더 구조를 그대로 복사해 상대 xref가 사본끼리 풀리게 했다. 실도면의 이름·레이어·블록·문자·속성 값은 `.vide/` 덤프에만 두었고 이 기록에는 개수와 참거짓만 옮겼다.
  - xref 해석 확인은 루트를 경로만 바꾼 임시 사본으로 다시 저장해 연다. 확인 대상 자식 하나만 원래 상대 경로로 두고, 나머지 xref는 빈 도면을 가리키게 했다. 서버 공유 경로를 가리키는 xref가 있어 실제 서버 파일을 열지 않기 위해서다.
- **CTB:** `ctb.mjs`가 Node에서 직접 읽는다. 대상은 ZWCAD 2023 기본 `zwcad.ctb`·`Monochrome.ctb`, ZWCAD 2026 기본 `Grayscale.ctb`, 이 PC의 회사 CTB 1개, 제공 CTB 1개다. 합성 CTB 2개를 만들어 왕복도 시험했다.

## 환경

| 항목 | 값 |
|---|---|
| OS | Windows 11 Pro 10.0.26200 (한국어) |
| ZWCAD | ZWCAD 2023 전문가용 23.20 (빌드 2022.12.03 #4996), .NET 사이드 DB |
| AutoCAD | 이 PC에 없음(Autodesk는 Revit 2026만 있음) |
| 빌드 | .NET Framework 4 `csc.exe` (x64), Node 24.21.0 |

## 결과

### 1. 사이드 DB 쓰기 — 가능

| 항목 | 합성 2007 | 합성 2013 | 합성 2018 | 실도면 6장(루트 5 + xref 자식 1) |
|---|---|---|---|---|
| 저장 버전 = 원래 버전 | 예(AC1021) | 예(AC1027) | 예(AC1032) | 예(6/6 모두 AC1032) |
| 원래 Handle 유지 | 140/142·98/100 | 139/140·97/98 | 140/141·98/99 | 6/6에서 1개 빼고 모두 (15,048~26,799개 중) |
| 바뀐 Handle | `AcDbCellStyleMap`·`AcDbDictionaryVar` | `AcDbCellStyleMap` | `AcDbCellStyleMap` | `AcDbCellStyleMap` 1개 |
| 새 Handle | 선 1·RegApp 1·위 대체 객체 | 같음 | 같음 | 선 1·RegApp 1·CellStyleMap 1 |
| 내용이 바뀐 개체 | 이동한 1개뿐 | 1개뿐 | 1개뿐 | 6/6 이동한 1개뿐 |
| 레이어·문자/치수 스타일·선종류·블록·레이아웃·속성 값·xref 경로 | 같음 | 같음 | 같음 | 6/6 같음 |
| ZWCAD 문서로 열기 | 성공 | 성공 | 성공 | 6/6 성공(개체 수 일치, 남긴 xref 모두 Resolved) |

- 개체와 기호표 레코드의 Handle은 모두 유지된다. `SaveAs`마다 바뀌는 것은 표 스타일의 내부 객체 `AcDbCellStyleMap` 하나(2007 형식은 `AcDbDictionaryVar` 하나 더)다. 개체 짝 찾기(Handle)에는 영향이 없다.
- ZWCAD의 `DwgVersion.ToString()`은 AC1027을 `Newest`로 쓴다(열거 값 별칭). 버전은 이름이 아니라 값으로 비교해야 한다.
- AutoCAD에서 여는 확인은 하지 않았다(설치 없음). 결과 파일은 ZWCAD가 만든 보통 DWG(원래 버전)이며 ZWCAD 문서 열기로만 확인했다.

### 2. xref 자식 쓰기 — 가능(상대 경로 유지)

- 합성: 자식을 고친 새 파일을 원래 자식 자리에 두자(사용자가 바꾸는 단계) 세 버전 모두 루트에서 `Resolved`, 자식 개체 1 → 2, 표시된 개체 0 → 1.
- 실도면: 자식 1장(상대 경로 `.\XREF\…`로 부착, 루트 4장이 참조)을 같은 방식으로 바꾸자 루트 4/4에서 `Resolved`, 자식 개체 3 → 4, 표시된 개체 0 → 1. 자식만 저장하므로 루트 파일은 바뀌지 않는다.
- 실도면 루트 5장의 xref 부착 경로는 상대 35개, 절대 3개(서버 공유 경로)다. 절대 경로 xref는 같은 폴더 새 파일 방식에서 사본이 아니라 서버의 원래 파일을 가리킨다.
- **ZWCAD 결함:** 사이드 DB의 `Database.ResolveXrefs`는 `eNotImplementedYet`이다. 루트에서 xref 내용을 확인하려면 자식 파일을 따로 읽어야 한다(T-200의 `XrefGraph`와 같은 방식).

### 3. xdata 출처 표시 — 가능, 복사는 구분 방법이 필요

| 동작(API) | xdata | 1005(Handle 참조) |
|---|---|---|
| 저장 뒤 다시 읽기 | 남음(합성 6/6, 실도면 6/6) | 그대로 |
| MOVE·ROTATE (`TransformBy`) | 남음 | 그대로 |
| COPY (`DeepCloneObjects`) | **복사됨**(같은 원천 ID) | 새 개체 자기 Handle로 바뀜 |
| WBLOCK (`Wblock`) | 복사됨 | 새 도면의 자기 Handle로 바뀜 |
| 다른 도면에 붙여넣기 (`WblockCloneObjects`) | 복사됨 | 새 Handle로 바뀜 |

- 1005는 복제 때 자기 Handle로 바뀌므로 복사본을 가려내지 못한다. 복사본은 원천 ID가 같은 두 번째 개체로 보인다.
- 따라서 출처 표시는 `1000 원천 ID` + `1000 쓴 때의 Handle(문자열)`로 하고, 읽을 때 문자열 Handle ≠ 실제 Handle이면 '복사본'으로 보고 짝을 잇지 않는 방식을 권한다. 엔진 저장소에도 (원천 ID → 도면·Handle)을 둔다.
- 화면의 `COPY`·`WBLOCK`·`EXPLODE` 명령은 API 대응으로만 시험했다. 블록 안에 든 표시 개체의 분해는 시험하지 않았다.

### 4. 읽으면 ZWCAD 2023이 죽는 속성

ZWCAD는 이 속성들을 읽을 때 종료하지 않는다. 자체 충돌 보고(`CrashReport\CR_*.zip`)를 쓴 뒤 CPU 0으로 멈춘다. 숨은 실행에서는 끝나지 않으므로 같은 단계가 90초 넘게 지속되면 멈춤으로 보고 띄운 PID를 종료했다.

| 속성 | 개체 | 근거 |
|---|---|---|
| `Dimension.TextStyleId` | Rhino가 쓴 치수 | 이전 SPIKE. 이번에는 읽지 않음 |
| `Dimension.Dimblks`·`Dimblk1s`·`Dimblk2s`·`Dimldrblks` | ZWCAD가 만든 회전 치수 | 합성, 매번 재현 |
| `Dimension.CenterMarkType`·`CenterMarkSize` | ZWCAD가 만든 회전 치수 | 합성 |
| `Curve.Spline` | 실도면의 Spline | 실도면 1건 |

- 위 목록을 건너뛰고 실도면 24장에서 49,705개 개체(형식별 파일당 300개 이하)의 558개 속성을 읽었다. 추가 충돌은 없었다.
- 관리 예외로 끝나는 속성(죽지 않음)은 28개였다. 예: `Curve.StartPoint`·`EndPoint`·`StartParam`·`EndParam`·`Area`(일부 곡선), `Hatch.Area`, `Spline.FitData` 등, `MLeader.LeaderCount`·`LeaderLineCount`(구현 안 됨), `Viewport.Thumbnail`, `RasterImage.Path`·`Name`, `BlockReference.UnitFactor`, `Entity.GeometricExtents`(빈 범위). 실도면 삽입 16개는 `BlockReference.DynamicBlockTableRecord`가 `eInvalidObjectId`였다.
- 문자·MText(`Contents`·`ExplodeFragments`)·해치 경계(`GetLoopAt`)·뷰포트·속성 블록(`AttributeCollection`·`AttributeReference`) 일괄 읽기는 죽지 않았다.
- 예외를 잡은 속성 읽기 뒤에도 `SEDP*.dmp`가 `CrashReport`에 쌓였다. 다음 ZWCAD 시작 때 정리됐다.

### 5. 도곽 읽기 — API는 가능, 제공 도면 세트는 속성 도곽이 아님

| 항목 | 합성 | 실도면 루트 5장 | xref 폴더 19장 |
|---|---|---|---|
| 종이 공간 레이아웃 | 2 | 2/장(용지·설정 없는 기본 배치) | 1~2/장 |
| 종이 공간 속성 블록 삽입 | 2(ATTRIB 6개 읽음) | 0 | 0 |
| 모형·블록 안 속성 삽입 | 0 | 4장에 31개(ATTRIB 62개, 2종) | 2장에 141개 |
| 그 속성 삽입 중 A계열 비율 | 2/2 | 0 | 0 |
| 모형 탭 플롯 = 창(Window) 범위 | — | 5/5 | 18/19 |
| 모형 탭 플롯 스타일(CTB) 지정 | — | 5/5 | 18/19 |
| 모형 탭 용지 ISO A계열 | — | 5/5 | 15/19 |
| 속성 없는 A계열 비율 삽입(xref 제외) | — | 5/5 | 14/19 |

- API로 레이아웃의 용지(`CanonicalMediaName`·`PlotPaperSize`), 플롯 형식(`PlotType`), 창 범위(`PlotWindowArea`), 축척, 회전, 플롯 스타일 이름(`CurrentStyleSheet`)과 속성 블록 삽입의 블록 이름·범위·ATTRIB 태그·값을 모두 읽었다(합성으로 값 일치 확인).
- 제공 도면 세트는 종이 공간 도곽을 쓰지 않는다. **모형 공간에 도곽이 있고 모형 탭의 창 범위로 출력**한다. 도곽은 속성 없는 블록(시트용 xref 도면 안에도 있음)이다. 루트의 속성 블록은 도곽이 아니다(A계열 비율 0). 도면마다 저장된 창 범위는 하나뿐이다.
- 루트 도면이 가리키는 CTB 이름 5개 중 제공 CTB 파일 이름과 같은 것은 0개, 이 PC의 ZWCAD 지원 폴더에서 찾은 것도 0개다.

### 6. CTB 읽기 — 가능

- 형식: 48바이트 헤더(`PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec`) + u32 3개(확인 값, 풀린 길이, 압축 길이) + zlib 텍스트. 텍스트는 `key=value`와 `이름{ … }` 묶음이고, 문자열은 `"`로 시작해 닫지 않는다. `plot_style`의 0~254가 ACI 1~255다. `color`는 -1(ZWCAD) 또는 `0xC3FFFFFF`(AutoCAD)가 '개체 색'이고, `0xC2/0xC3 + RGB`는 지정 색이다. `lineweight`는 `custom_lineweight_table`의 번호다.
- 5개 표 모두 읽었다(255색, 선가중치 표 27개, 길이 일치). 헤더의 첫 u32는 텍스트나 압축 데이터의 Adler-32·CRC-32가 아니다. 무결성은 zlib 스트림 자체의 Adler-32로 확인된다. 손상 CTB는 읽기 실패로 끝난다(합성).
- 회사 CTB 2개(이 PC의 것, 제공된 것)는 선가중치 표 자체를 바꿨다(0.006 mm부터). 번호를 표준 표로 풀면 틀린다. 반드시 파일 안의 표로 풀어야 한다.
- 합성 CTB 2개(전체 검정 + 번호별 선가중치, ACI 1만 빨강 0.5 mm + 나머지 개체 색)를 쓰고 다시 읽어 펜 색·선가중치가 같았다.
- **미확인:** '개체 선가중치 사용' 값은 표본에 없었다. ZWCAD 기본 표 3개는 모든 펜이 0번(0 mm)이다. `ctb.mjs`는 255를 '개체 선가중치'로 가정한다. ZWCAD 플롯 스타일 편집기에서 한 번 확인이 필요하다.

## 한계

- AutoCAD에서 열기는 확인하지 않았다(이 PC에 없음).
- 출처 표시의 화면 명령(COPY·WBLOCK·EXPLODE·PURGE·AUDIT)은 API 대응만 시험했다.
- 실도면 쓰기는 이동 1개 + 추가 1개만 했다. 치수 연동 갱신, 블록 삽입 이동, 레이어 잠금·동결 개체, 큰 변경 묶음은 시험하지 않았다.
- 충돌 속성 탐색은 형식별 첫 300개 개체만 읽었다. 건너뛴 속성 뒤의 같은 개체 속성은 그 다음 실행에서 읽었다.
- 실도면 사본 xref 해석은 대상 자식 하나만 실제로 풀고 나머지는 빈 도면으로 바꿨다. 서버 공유 경로를 열지 않기 위해서다.
- **숨은 실행의 멈춤 두 가지(T-226 대상):** (a) 위 4의 속성 충돌은 프로세스를 끝내지 않고 충돌 보고 뒤 멈춘다. (b) 누락 xref가 있는 도면을 문서로 열면 '확인되지 않은 참조 파일' 모달 대화상자에서 멈춘다(숨은 창에서도). 실험은 띄운 PID만 종료했고 '항상 무시'처럼 사용자 설정을 바꾸는 버튼은 누르지 않았다.
- 실험 동안 `CrashReport`에 이 실험의 충돌 보고 zip 9개(합성 8, 실도면 1)가 남았다. 지우지 않았다.

## 결론과 다음 작업 방식

| 질문 | 판정 | T-232·T-233·T-235 방식 |
|---|---|---|
| 1 버전·Handle 유지 | **가능** | 닫힌 도면 반영은 사이드 DB + `SaveAs(새 경로, OriginalFileVersion)`. 형식 보존 확인(SPEC-14.6)은 Handle 표·개체 요약 해시·기호표·레이아웃·xref 경로 대조로 하고, `AcDbCellStyleMap`(2007은 `AcDbDictionaryVar`도)은 비교에서 뺀다. 실패 처리(열린 도면만 반영)는 필요 없다 |
| 2 xref 자식 쓰기 | **가능** | xref 소유 개체는 자식 도면만 같은 폴더 새 파일로 쓴다. 사용자가 교체하면 상대 경로가 그대로 풀린다. 절대 경로(서버) xref는 행에 '절대 경로 xref — 새 파일을 루트가 보지 않음'을 표시한다. 확인은 `ResolveXrefs` 없이 자식을 다시 읽어서 한다 |
| 3 xdata 출처 표시 | **가능(우회 포함)** | RegApp `VIDE_ORIGIN`, `1000 원천 ID` + `1000 쓴 때 Handle 문자열` + `1071 판`. 1005는 쓰지 않는다. Handle 불일치 = 복사본(짝 없음, 원본만 짝). SPEC-14.4 개체를 Sync 일치 행으로 바꾸는 실패 처리는 필요 없다 |
| 4 위험 속성 | 목록 확정(7개) | T-226 worker 회피 목록: 위 표의 7개 + `TextStyleId`. 치수 화살표·중심 표시는 치수 스타일 레코드(`DimStyleTableRecord`)에서 읽는다. 숨은 실행 공통에 '같은 단계 N초 무진행 = 멈춤 → PID 종료' 감시와 문서 열기 금지(사이드 DB만)를 넣는다 |
| 5 도곽 | API 가능, 기본값 조정 필요 | T-235는 속성 블록 목록만으로는 이 세트에서 시트를 0장 찾는다. 시트 찾기 순서에 (a) 모형 탭 창 플롯 범위, (b) 모형 공간의 속성 없는 A계열 블록 삽입(중첩 xref 안 포함)을 더하고, 시트 정보는 ATTRIB가 없으면 도곽 범위 안 문자에서 읽는 후보로 둔다. PLAN-47 결정 질문 3의 추천 기본값을 이 순서로 바꾸는 안을 사용자에게 묻는다 |
| 6 CTB | **가능** | `ctb.mjs`의 파서를 엔진(`src/core/`)으로 옮겨 `PlotStyleTable`로 바꾼다. 선가중치는 파일 안 표로 푼다. 도면이 가리키는 CTB 이름으로 지원 폴더를 찾는 방식은 이 세트에서 0/5라 결정 질문 4의 추천(프로젝트에 CTB 등록)을 유지한다. '개체 선가중치' 값은 T-235 착수 전에 확인한다 |
