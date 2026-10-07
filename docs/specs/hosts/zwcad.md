---
id: HOST-ZWCAD
title: ZWCAD 호스트 계약과 검증 범위
status: review
version: 0.29
updated: 2026-10-08
owner: agent:codex
related: [SPEC-01, SPEC-02, SPEC-14, PLAN-43, PLAN-47, FR-03, FR-04, AC-24, AC-38, OQ-03, OQ-10, ADR-022, ADR-027]
---

# ZWCAD 호스트 계약과 검증 범위

사용자 지정 시험 버전은 현재 설치본 ZWCAD 2023, 실행 파일 버전 23.20.3.11이다. 이 문서는 §1의 현재 지원표가 정본이며, §2 이후는 날짜순 검증 이력이다. 이력의 "아직 미지원"은 그 날짜 기준이고 현재 상태는 §1로 읽는다.

SDK의 AI query는 기본 50개·최대 100개/64 KiB 페이지와 ID 필터를 지원한다. 다음 페이지는 같은 revision을 요구한다. 소유 합성 문서 120개 실제 조회와 전체 후보 보존을 확인했다([검수](../../tdd/VERIFY-2026-09-24-local-product-completion.md)). 네이티브 가져오기 규모의 확대 검증과 구분한다.

## 1. 현재 지원 상태 — 2026-10-01 기준

2026-09-30 [ADR-022](../../decisions/ADR-022-direct-apply-plan-auto.md) 이후 AI 편집의 제품 경로는 연결한 열린 도면에서 바로 실행하는 `direct-execute`이다(H-ZWCAD-09, §1.2). 아래의 사본 편집 경로는 내부 사본과 이전 결과 호환용이다. 기존 편집 경로는 VIDE가 소유한 별도 ZWCAD 2023 실행본의 자체 .NET 애드인(`hosts/zwcad/worker/`)이다. 범용 AI 생성·후속 수정은 자체 SDK 세션으로 연결했다. SDK 후보 열기·재취득·고정 적용은 자체 편집 세션으로 연결했다. 기존 제한 JSON 생성/열기의 COM 경로는 이전 결과 호환용으로 남아 있다. 현재 열린 문서의 명시적 읽기 연결은 별도 연결 플러그인으로 지원한다(§1.1). 기존 편집 검증 범위를 확대해서 집계하지 않는다.

| ID | 계약 | 현재 상태 | 경로 | 남은 조건 |
|---|---|---|---|---|
| H-ZWCAD-01 | 합성 닫힌 LWPolyline 생성·복사 후보·이동·후보 삭제 | 생성·정점 후속 수정은 제품 SDK/양쪽 구독 경로 실증(§2.6). 두 문서 경계 전달과 SDK 삭제·고정 적용·저장 재열기 실증 | 자체 SDK + 기존 COM | 블록·외부참조·프록시·일반 3D 객체 |
| H-ZWCAD-02 | 시험 객체 색상 보존 | 실증 | COM·SDK 모두 | 레이어·확장 데이터·구속조건·그룹 관계 |
| H-ZWCAD-03 | mm 단위·이동 기하·Handle 저장 지속성 | 실증 | COM·SDK 모두 | 다른 단위 환산 |
| H-ZWCAD-04 | 직선 세그먼트 평면 LWPolyline 읽기·정점 변경·이동 | 읽기·정점 변경·이동은 자체 SDK로 실증(§2.4·2.5). 범용 생성·후속 정점 수정, 소유 편집 문서의 기존 수정/새 객체 추가 적용·직접 이동/저장·재열기를 실증(§2.6·2.7). 현재 UI의 Codex 생성과 기본 이동/저장·미저장·Save As·닫힘 5종 재검증 통과([검수](../../tdd/VERIFY-2026-09-24-local-product-completion.md)) | 자체 SDK(읽기·생성·수정), 기존 COM(복사) | 일반 문서 복사, 다른 단위·블록·관계. 두 DWG의 직선 경계 정점 전달/새 객체 생성은 연계 검증 통과 |
| H-ZWCAD-05 | CAD 경계를 연계 입력으로 읽고 같은 작업의 경계 수정 후보 생성 | CAD 경계→Rhino 돌출 실증(§2.1). 한 요청의 CAD 수정→실제 수정 경계 기반 Rhino 후보·부분 불명확 보존 실증([연계 검증](../../tdd/VERIFY-2026-09-24-linked-hosts.md)) | 자체 SDK 읽기 + Rhino 후보 | 다른 좌표 변환·일반 객체/관계의 연계 |
| H-ZWCAD-06 | 평면 LINE과 LWPolyline 혼합 문서 | LINE 끝점/색 수정·추가·삭제, 고정 적용·Handle/유형 보존, 브라우저 가져오기/선택과 기본 Move·저장 재열기 실증 | 자체 SDK | 서로 다른 Z의 LINE·호·블록·관계, mm 외 편집 |
| H-ZWCAD-08 | 현재 열린 도면의 AI 조회·직접 수정(2026-09-29) | 합성 도면에서 실제 구독 AI가 새 레이어와 문자 2개를 기존 선을 건드리지 않고 추가했다(`tests/integration/zwcad-open-ai.mjs`). 조회·읽기 전용 코드·정책 거절 확인. 연결 프로그램 설치(사용자 Applications 등록)로 시작 시 자동 로드 확인 | 연결 DLL + 작업 사본과 같은 컴파일러·API 정책 | 자동 모드의 쓰기는 H-ZWCAD-09의 `direct-execute`로 옮겼다. 계획 모드의 조회·읽기 전용 코드는 `runCode`(쓰기 없음)를 쓴다. 대형 도면 조회 성능 |
| H-ZWCAD-09 | 열린 도면의 바로 실행·실행별 되돌리기·보호 확인(2026-09-30) | 구현: `direct-execute`는 AI 코드를 `VIDEAIRUN` 명령의 트랜잭션 하나로 확정해 UNDO 한 단계가 되고, `direct-undo`는 `U`와 `VIDEAIUNDONE`으로 마지막 기록만 되돌리며(아니면 `not-latest`), 기준(500개, 2026-10-02 ADR-031 7)을 넘는 삭제·레이어 삭제·다른 기호표 정의 정리는 트랜잭션을 확정하지 않고 `guarded`로 돌려준다. `fingerprint` 제공(`hosts/zwcad/connection/AttachedDocument.cs`·`AttachedEdit.cs`, 엔진 `src/server/zwcad-sdk-execution.ts`의 `runAttached`). 실호스트 검수는 설치본 플러그인 자동 로드로 개발 빌드를 올리지 못해 막혔다([검수](../../tdd/VERIFY-2026-09-30-direct-apply-zwcad.md)) | 실제 ZWCAD에서 추가·되돌리기·`not-latest`·삭제/레이어 보호·`fingerprint` 변화·Live Sync 갱신 확인, 보류된 실행이 `revision`을 올리는지 |
| H-ZWCAD-10 | Rhino 대상 요청에서 열린 연결 도면의 실시간 조회·바로 실행(2026-10-01, [ADR-027](../../decisions/ADR-027-multi-file-coordination.md)) | 구현: `queryEntities`·`direct-execute`·`direct-undo`를 Rhino 턴의 `linkId`로 부른다. 보기 메서드가 없어 `capture_view`·`measure`는 `NO_VIEW`. ZWCAD 도면이 대상인 턴은 다른 파일을 저장된 Sync로만 읽는다(이번 범위 밖). Rhino 턴의 자동 모드 목표 문장이 ZWCAD 실행 래퍼(`Database db`·`Transaction tr`, Commit/Abort 금지)를 알린다. 쓰기는 모의 편집기 단위 검증만 했다 | 실제 ZWCAD 왕복(H-ZWCAD-09 확인 뒤), ZWCAD 대상 턴의 여러 파일 |
| H-ZWCAD-11 | 열린 도면의 Live Sync: 바뀐 개체만 읽기(2026-10-06, T-128, [ARCH-01](../../architecture/ARCH-01-system.md) §7 「ZWCAD Live Sync」) | 구현: 연결 플러그인이 바뀐 ObjectId·revision을 남기고 `displayChanges`가 바뀐 모형 공간 개체의 줄·지운 Handle·도면 전체 표시 수를 준다. 레이어·블록 정의·문자/치수 스타일·XCLIP 변경과 이전 플러그인은 전체 읽기. 자동 Sync·⟳·`LiveSync`가 Rhino와 같은 경로. 가짜 플러그인·호스트로 단위·서버 시험(`zwcad-live-sync`), 플러그인 빌드 통과 | 별도 자체 .NET 연결 DLL | 실제 ZWCAD 2023에서: 이벤트로 받은 개체 열기(지운 개체·실행 취소한 추가), 속성·폴리선 정점 변경이 소유 개체로 가는지, 치수 편집의 익명 블록 판정, 큰 도면의 표시 수가 전체 읽기와 같은지 |
| H-ZWCAD-12 | 프로젝트 폴더 DWG의 xref 관계 읽기와 [모델에 반영] 표시(2026-10-07, SPEC-01.11의 11, PLAN-43 T-200) | 구현: 엔진이 띄운 숨은 ZWCAD 2023이 원본의 사본만 사이드 DB로 읽는다(`VIDEXREFGRAPH`: xref 이름·저장 경로·부착/오버레이·XrefStatus, 삽입의 공간·위치·회전·축척·BlockTransform; `display`: 연결 Sync와 같은 모형 공간 표시). 실제 ZWCAD 2023에서 합성 도면(`VIDEXREFFIXTURE`: 절대·상대(`sub\grand.dwg`)·누락·순환·오버레이, 90° 회전·2배 삽입)으로 읽기 7.1초·반영 7.2초, 상대 경로 해석·누락·순환·배치 행렬 확인(`tests/integration/zwcad-xref.mjs`). 원본은 바뀌지 않았고 띄운 ZWCAD만 종료 | 자체 worker DLL(숨은 ZWCAD) | 실제 프로젝트 도면(서버 공유 경로, 큰 도면의 표시 시간), INSUNITS가 다른 도면 사이의 단위 환산(지금은 BlockTransform 그대로), 블록 안 xref 삽입의 배치, 바인드된 xref |
| H-ZWCAD-13 | 엔진이 띄운 숨은 ZWCAD의 "이전 실행 충돌 — 진단 정보 전송" 안내 응답(2026-10-07, PLAN-43 T-200 후속) | 구현: ZWCAD 2023은 비정상 종료 뒤 `%APPDATA%\ZWSOFT\ZWCAD\2023\ko-KR\CrashReport`에 덤프를 남기고, 다음 시작에서 플러그인보다 먼저 모달 대화상자(#32770, [아니오])를 띄운다. 숨은 `/b` 실행은 여기서 멈춘다. 엔진은 자기가 띄운 숨은 ZWCAD(자료 정리 DWG 문자, xref 읽기·반영, 검사기, worker 세션)를 `launchHiddenZwcad`로 띄우고, 준비 파일·첫 결과가 보이거나 90초가 지날 때까지 500 ms마다 그 PID의 대화상자만 찾아 [아니오]를 누른다. 누르면 진단 로그에 `zwcad-crash-prompt`("ZWCAD 이전 충돌 안내를 닫음")를 한 번 쓴다. 다른 프로세스(사용자가 연 ZWCAD 포함)의 창은 건드리지 않고 덤프 파일도 지우거나 옮기지 않는다. 사용자가 보는 편집 세션(visible)에는 적용하지 않는다. 안내 창이 ZWCAD 프로세스 자체의 창임은 SPIKE-2026-10-07-drawing-export에서 확인했다. 단위 시험과 Windows 메시지 상자 응답 시험 통과(`tests/core/zwcad-crash-prompt.test.mjs`) | `hosts/zwcad/crash-prompt.ts`(PowerShell 1회 실행 도우미, 디스크에 스크립트 없음) | 대기 중인 덤프가 있는 상태에서 제품 경로로 다시 확인, 다른 언어판(버튼 문구) |
| H-ZWCAD-14 | 도면 역반영의 숨은 실행 공통과 출력 토큰 쓰기(2026-10-07, PLAN-47 T-226, SPEC-14.7·14.13 실패 1·14.14 1) | 구현: 엔진이 띄우는 숨은 ZWCAD 작업(xref 읽기·표시, 자료 정리 DWG 문자, 도면 쓰기)은 `runHiddenZwcad` 하나로 시간 상한·중단·스스로 끝남·정체를 보고, 끝나면 그 실행이 띄운 PID만 끈다. 실패 때 종료 코드·worker 마지막 단계·새 충돌 덤프 수를 진단 로그(`zwcad-hidden-run`)에 남긴다. 도면 파일 쓰기는 엔진이 발급한 출력 토큰(작업 폴더 또는 사용자가 확인한 폴더의 `.dwg` 이름 집합, 원본 DWG 버전)이 있는 `VIDEDRAWINGCOPY`만 하며, 엔진과 worker(`OutputGrant.cs`)가 각각 토큰 밖 경로·기존 파일·두 번째 쓰기·버전 불일치를 거절한다. 위험 속성 `Dimension.TextStyleId`는 읽지 않는다(`SafeRead.cs`). AI 코드의 `Save`·`SaveAs`·`AttachXref`·내보내기 금지는 그대로이며 시험으로 고정했다. 실호스트(ZWCAD 2023, 합성 도면): 2013(AC1027)·2018(AC1032) 사본을 토큰 경로에 같은 버전으로 쓰고 다시 읽어 Handle·레이어가 같음, 같은 경로 재쓰기·2018→2013 토큰은 엔진이 거절, 토큰 밖 경로·쓰기 직전에 생긴 파일은 worker가 거절(그 파일 내용 그대로), 1.5초 시간 상한으로 숨은 호스트를 끈 쓰기는 실패·대상 파일 없음·원본 해시 불변, 임시 파일·남은 ZWCAD 없음(`tests/integration/zwcad-drawing-output.mjs`, 사본 쓰기 약 6.7초). xref 읽기·[모델에 반영] 실호스트 시험도 공통 실행으로 통과. 단위 시험 `tests/core/drawing-output.test.mjs`·`zwcad-hidden-run.test.mjs` | `hosts/zwcad/hidden-run.ts`, `src/core/drawing-output.ts`, `hosts/zwcad/drawing-output.ts`, worker `OutputGrant.cs`·`DrawingOutput.cs`·`SafeRead.cs` | 쓰는 도중(저장·이동 사이) 강제 종료, 사용자 확인 폴더(`confirmed`) 경로의 제품 화면 연결(T-233·T-234), 편집을 더한 쓰기(T-230·T-233), 덤프가 쌓인 상태의 종료 코드 기록 확인. 위험 속성 목록 확장(T-225 질문 4)·무진행 감시·문서 열기 금지는 H-ZWCAD-15로 끝남 |
| H-ZWCAD-15 | 도면 읽기와 레이어 대응(2026-10-08, PLAN-47 T-227, SPEC-14.3), 숨은 실행의 무진행 감시와 사이드 DB 전용(T-225 후속) | 구현: 프로젝트 폴더의 도면 사본을 숨은 ZWCAD의 `VIDEDRAWINGINSPECT`가 사이드 DB로 읽어 DWG 버전·단위·레이어·선종류·문자/치수 스타일·블록·xref를 돌려주고, 엔진이 프로젝트 DB(schema 15)에 읽기 결과와 도면별 레이어 대응 표를 둔다. 치수 화살표는 치수 스타일 레코드에서 읽는다. `SafeRead.Avoided`에 T-225의 7개(`Dimension.Dimblks`·`Dimblk1s`·`Dimblk2s`·`Dimldrblks`·`CenterMarkType`·`CenterMarkSize`, `Curve.Spline`)를 더했다. `runHiddenZwcad`는 새 결과도 새 worker 단계도 없는 시간(기본 120초, 도면 읽기 90초)이 지나면 그 PID를 끄고(충돌 뒤 멈춘 ZWCAD), 사이드 DB 명령 목록 밖은 띄우지 않는다. 실호스트(ZWCAD 2023, 합성 도면 4장: 2013·2018 mm(ZWCAD 회전 치수 포함), 인치, xref 루트): 4장 모두 답함, 버전 AC1027/AC1032, 인치는 `UNITS_NOT_MM`, 선종류·문자 스타일 글꼴·치수 스타일 화살표(`VIDE틱`)·DIMSCALE·속성 블록 삽입 수·xref 3개(overlay·저장 경로)가 만든 값과 같음, 같은 이름 레이어 자동 대응과 표 복사, 원본 해시 불변, 새 충돌 보고 0, 읽기 약 6.7초(`tests/integration/zwcad-drawing-inspect.mjs`). 사용자 제공 실도면 세트의 사본 24장: 24장 모두 답함·24장 대상 가능(단위 없음 4장은 mm 가정), 치수 스타일 화살표 603개 모두 읽음, 새 충돌 보고 0, 원본 해시 불변, 약 9.1초. T-226 실호스트 시험(`zwcad-drawing-output.mjs`·`zwcad-xref.mjs`)도 다시 통과. 단위·HTTP 시험 `tests/core/drawing-layers.test.mjs`·`tests/server/drawing-layers.test.mjs`·`zwcad-hidden-run.test.mjs`·`drawing-output.test.mjs` | `hosts/zwcad/drawing-inspect.ts`, worker `DrawingInspect.cs`·`SafeRead.cs`, `hosts/zwcad/hidden-run.ts`, `src/core/drawing-layers.ts`, `src/server/drawing-layers.ts`·`drawing-layer-routes.ts` | 화면(T-234), 원천 레이어 목록을 Rhino 연결에서 채우기(T-232), 무진행 감시로 실제 충돌한 ZWCAD를 끄는 실측(이번 시험에서 충돌 없음), 문자·해치·치수 개체 단위 읽기(T-232·T-235) |
| H-ZWCAD-07 | 현재 열린 도면의 명시적 연결·패널·읽기 Sync | 합성 CAD의 브라우저 표시·재열기·다중 도면·Live Sync 통과, 실제 작업 도면 연결/패널·부분 Sync·재열기 확인(3,369개 표시, 472개 제외)([검수](../../tdd/VERIFY-2026-09-28-zwcad-attached-sync.md)) | 별도 자체 .NET 연결 DLL | 실제 대형 외부참조 표시·문자/해치·원본 AI 편집 |

편집용 사본 읽기 지원 범위: 모델 공간의 mm(또는 정확히 환산되는 m) 독립 직선 XY LWPolyline과 같은 Z의 두 끝점을 가진 LINE. 그룹·확장 사전·XData·잠긴 레이어·선폭/두께를 확인하지 못하면 참고 전용이며, 단위 미상·bulge 호·지원 밖 객체가 있으면 일부만 성공으로 취득하지 않고 거절한다. 별도 읽기 표시는 §1.1을 따르며 새 지원을 과거 취득 자료에 소급하지 않는다.

독립 Rhino·ZWCAD 요청의 실제 동시 실행과 분리 결과 저장을 합성 문서로 확인했다([검수](../../tdd/VERIFY-2026-09-24-local-product-completion.md)). 같은 문서의 동시 쓰기 허용을 뜻하지 않는다.

공통 규칙: 실사용 연결에서 활성 문서를 실행 대상으로 암묵 선택하지 않는다. 문서 간 원점/축/단위 변환은 사용자가 확인한 값으로 적용한다. 바로 실행은 바뀐 핸들과 되돌리기 기록을 남기고 결과를 재조회한다. 사본 경로의 후보는 생성 시 원본 대응과 소유 정보를 기록하고 기존 객체 수정을 사본에서 먼저 검사한다. 보존을 확인할 수 없는 경우 임의 삭제/재생성으로 성공을 위장하지 않는다. 위 표는 첫 완결 과업의 실증 범위이며 전체 MVP 지원 상한의 확정이 아니다. 문서별 명령 직렬화·다중 연결·기본 편집 도구 재편집·설치 지원 통과는 T-003·006에서 판정한다.

### LINE 확대 계약

독립 LINE은 두 끝점이 같은 Z인 평면 직선으로 한정한다. 기존 mm 직선 XY LWPolyline과 섞여 있어도 전체 문서를 읽고, SDK 사본에서 LINE 끝점/색/기존 레이어를 수정하거나 새 선을 추가·삭제할 수 있다. 고정 적용은 기존 Handle과 네이티브 유형을 유지하며 LINE을 Polyline으로 바꾸지 않는다. 읽기 표현은 두 점의 선분과 실제 길이·원래 유형이며 닫힌 경계 면적을 지어내지 않는다. 잠긴 레이어·그룹·확장 사전/XData·두께와 단위 미상 등 기존 보호는 유지한다. 지원하지 않는 객체를 누락한 부분 성공으로 취득하지 않는다. 적용과 저장은 구분한다. LINE+Polyline 혼합 문서의 SDK 생성/수정/추가/삭제·고정 적용·저장 재열기, 브라우저 가져오기/선택과 기본 Move·저장 후 재열기를 실증했다([검수](../../tdd/VERIFY-2026-09-24-local-product-completion.md)). 일반 3D LINE·호·블록까지의 지원은 아니다.

### 1.2 현재 열린 도면의 AI 수정 (H-ZWCAD-08·09)

2026-09-29 사용자 요청(실무의 CAD 반영)으로 연결한 열린 도면은 작업 사본을 거치지 않고 직접 수정하며, 2026-09-30 [ADR-022](../../decisions/ADR-022-direct-apply-plan-auto.md)로 모드는 계획·자동 두 가지다(SPEC-02.20). **계획** 모드는 조회와 읽기 전용 코드만 실행한다(`runCode`, 트랜잭션을 항상 버린다). **자동** 모드는 코드 실행마다 `direct-execute`로 `VIDEAIRUN` 명령 안에서 한 트랜잭션을 확정한다. CAD 명령과 같은 단위라 UNDO 한 번(ZWCAD의 `U`)에 되돌아가며, VIDE의 [되돌리기]는 그 기록이 도면의 마지막 기록일 때만 `U`를 보낸다. 보호 동작(SPEC-02.13의 4)은 실행 뒤 세어 확인 전에는 확정하지 않는다. 실제 창에서의 UNDO 동등성·보호 판정은 아직 실호스트 미확인이다(H-ZWCAD-09). 파일 저장·다른 도면·앱 제어는 하지 않는다. 요청 결과는 바뀐 핸들(추가·수정·삭제)과 수정 뒤 다시 읽은 도면이다. 다른 호스트(Rhino)와 원점·축이 다를 수 있으므로 연계 요청은 공통 좌표를 가정하지 않고 대응 요소로 관계를 먼저 밝힌다.

### 1.1 현재 열린 도면의 읽기 연결

사용자가 ZWCAD 플러그인의 Connect 또는 패널로 현재 문서를 연결한다. 연결 대상은 도면 전환으로 바뀌지 않으며 복수 도면을 별개 식별자로 구분한다. Disconnect·문서 닫힘은 해당 연결을 폐기한다. Sync는 모델 공간의 표시 데이터·Handle·레이어·단위를 직접 읽어 VIDE에 반영한다. 원본 저장·수정·기존 선택 변경은 하지 않는다. 곡선과 블록의 화면 표현은 근사 표시이며 원본 CAD 형상은 그대로 유지한다. 표시 미지원 유형과 수를 결과에 포함하고 누락 객체를 삭제로 해석하지 않는다. 단위 미상은 추측하지 않고 오류로 알린다.

Live Sync는 기본 꺼짐이며 사용자가 켠 문서의 변경만 모아 갱신 요청을 알린다. 수동 Sync 역시 현재 VIDE에서 선택된 같은 도면을 갱신한다. 실패 시 이전 성공 화면과 입력을 보존한다. 패널은 연결·마지막 조회·오류와 VIDE 열기를 제공한다. 읽기 연결과 Sync는 생성 코드를 실행하지 않으며 그 자체로 쓰기 권한이 아니다. 열린 도면에서의 AI 코드 실행은 요청의 모드에 따른 §1.2의 경로(계획은 읽기 전용, 자동은 `direct-execute`)로만 한다.

현재 화면 표현은 모델 공간의 선·곡선·폴리라인·중첩 블록과 치수의 선 그래픽이다. 문자·해치 채움·배치 공간·클리핑·출력 스타일 재현은 지원 완료가 아니다. 읽을 수 없는 객체와 단일 객체의 표시 응답이 너무 큰 경우 해당 객체를 누락 수에 포함하고 나머지를 표시한다. 인증·문서 변경·불명확한 연결 오류는 부분 성공으로 숨기지 않고 전체 Sync를 실패시킨다. 마지막 조회 시각은 호스트 데이터 조회 시각이며 브라우저 렌더 완료 시각이 아니다.

## 2. 검증 이력

### 2.0 COM 실험 — 2026-09-19

ProgID `ZWCAD.Application.2023`을 레지스트리에서 확인하고 새 시험 인스턴스의 COM API로 H-ZWCAD-01~03을 확인했다. 새 문서 ModelSpace에서 객체 수·길이·좌표를 비교했고, 후보 폐기·원본 이동·DWG 재열기 후 Color 유지, INSUNITS=4와 저장 후 HandleToObject 조회를 확인했다. 근거는 [호스트 실험](../../tdd/SPIKE-2026-09-19-host-native.md)이다. 이는 제품용 .NET 어댑터의 빌드·로드·UI 문맥 검증이 아니었다.

### 2.1 실제 제품 연결 — 2026-09-20

[작업 공간 검증](../../tdd/VERIFY-2026-09-20-native-workspace.md)에 브라우저 → 구독 CLI → ZWCAD의 닫힌 LWPolyline 생성·저장·재열기 및 CAD 경계를 Rhino Extrusion의 입력으로 쓴 실증이 있다. 실제 면적 200 m²·돌출 체적 1,200 m³와 DWG 다운로드를 확인했다. 시험 문서는 기존 사용자 문서와 분리했다.

### 2.2 DWG 참고 입력 확인 — 2026-09-21

H-ZWCAD-04 중 직선 XY LWPolyline 읽기를 확인했다. 업로드한 바이트의 고유 복사본을 읽기 전용으로 열고 mm 단위 경계 20×10 m의 정점·닫힘·Elevation·Normal·Handle·레이어·색·길이/면적을 읽었다. 원 파일 해시는 유지됐다. 길이 60 m·면적 200 m²를 참고 핀으로 Rhino 높이 3 m 후보(체적 600 m³)에 연결했다. 당시에는 참고 DWG 자체의 후보 편집을 지원하지 않았다(2.3에서 추가). [실증 기록](../../tdd/VERIFY-2026-09-20-native-workspace.md).

### 2.3 DWG 작업 사본 경계 수정 — 2026-09-21

새로 취득한 독립 직선 XY LWPolyline의 이동·정점 수정 후보를 실제 ZWCAD 2023에서 검증했다(당시 COM 경로). 이름·객체 집합·Handle·레이어·색상을 유지하고 새 DWG 사본에서 수정했다. 20×10 m를 24×10 m로 수정해 240 m²·68 m를 재열기 확인했고 후속 이동도 통과했다. [실제 검증](../../tdd/VERIFY-2026-09-20-native-workspace.md).

### 2.4 설치 SDK 실험과 자체 SDK DWG 가져오기 — 2026-09-22

[ZWCAD SDK 실험](../../tdd/SPIKE-2026-09-22-zwcad-sdk.md)에서 설치된 공식 .NET DLL의 빌드·소유 시험 실행본 로드, 별도 Database/Transaction의 합성 경계 생성·저장·재열기를 확인했다. 이어 제품의 DWG 읽기를 소유한 별도 실행본의 자체 .NET 애드인으로 전환했다. 브라우저에서 20×10 m DWG의 표시·객체 선택, 200 m²·60 m·Handle·원본 해시 보존을 확인했다. 단위 미상/곡선 bulge는 거절하고 잠긴 레이어 및 m 단위 직선 경계는 정확한 단위 환산으로 표시하되 정점 편집 능력을 부여하지 않는다. 근거는 [SDK 제품 이식 검증](../../tdd/VERIFY-2026-09-22-typescript-foundation.md)이다.

### 2.5 자체 SDK 작업 사본 수정 — 2026-09-22

독립 mm 직선 XY LWPolyline의 기존 정점 수정을 별도 소유 ZWCAD SDK 실행본으로 전환했다. 원본을 별도 Database로 읽어 새 후보 DWG만 저장한다. 모델 공간·대상 Handle·객체 집합·단위·관계/레이어 잠금·지원 범위를 확인하고 트랜잭션으로 편집한다. 200→240 m² 경계 변경과 후속 이동, 저장/재열기, Handle·레이어·색·원본 해시 보존을 실증했다. 잘못된 Handle 요청은 후보 파일 없이 실패했다. 기존 COM `edit.ps1`은 제거했다. 검증은 [TS/자체 호스트 기록](../../tdd/VERIFY-2026-09-22-typescript-foundation.md)을 따른다.

### 2.6 범용 SDK의 제품 AI 연결 — 2026-09-24

자체 .NET Framework 4.8 애드인·고정 Roslyn 의존성으로 AI의 SDK 메서드 본문을 실행한다. 브라우저에서 ChatGPT/Claude 구독 CLI를 각각 사용해 합성 경계 생성→같은 Handle의 후속 수정→240 m² 재취득→후보 표시를 통과했다. 읽기 권한·컴파일/정책 거절·불명확 오류·중복 실행·보존 대상 방어를 검사했다. 설치 SDK는 배포물에 복사하지 않는다. [제품 연결 검증](../../tdd/VERIFY-2026-09-24-zwcad-sdk-product.md). 열린 편집 문서 적용·복수 문서 왕복은 아직 이 결과에 포함하지 않는다.

### 2.7 자체 편집 세션과 고정 적용 — 2026-09-24

합성 SDK 후보의 편집 사본 열기·조회·재취득, 두 실행본의 같은 파일명 구분, 제어기 재연결, 기존 폴리라인 수정/새 객체 추가의 고정 적용과 적용 후 재조회, 중복 요청/낡은 기준 방어를 실증했다. 브라우저의 문서 조회·취득·영향 검토·적용도 통과했다. 임의 AI 코드는 편집 세션에서 실행하지 않는다. 기본 MOVE·QSAVE와 저장 파일 재열기, SAVEAS/닫힘 이후 기존 대상 거절도 통과했다. 일반 문서 복사·한 요청의 두 호스트 연계는 미검수다. 검사 사본 취득 전후 저장/미저장 플래그를 보존했고 Undo 표식까지의 이전 형상 복구도 검증했다. [제품 연결 검증](../../tdd/VERIFY-2026-09-24-zwcad-sdk-product.md)의 최신 범위를 따른다.
