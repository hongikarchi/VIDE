---
id: VERIFY-2026-09-24-zwcad-sdk-product
title: ZWCAD 범용 SDK 제품 연결 검증
status: review
version: 0.2
updated: 2026-09-24
owner: agent:codex
related: [PLAN-02, T-006, T-018, H-ZWCAD-01, H-ZWCAD-03, H-ZWCAD-04, AC-24]
---

# ZWCAD 범용 SDK 제품 연결 검증

기준은 PLAN-02 §6.1 3a, SPEC-02의 범용 실행·후보 보호, ARCH-01의 ZWCAD 실행 계약이다. 설치된 ZWCAD 2023 별도 시험 실행본과 합성 도면만 사용했다.

## 검증한 경로

- `tests/integration/zwcad-worker.mjs`: 자체 플러그인 로드, 빈 mm 문서 조회, 파일 쓰기·트랜잭션 직접 확정·리플렉션 거절, 컴파일 오류 수정 가능 확인. SDK로 20×10 m 경계를 생성하고 기존 정점을 24×10 m로 수정했다. 저장/재열기 후 면적 200→240 m², Handle 보존을 확인했다. 중복 작업은 동일 영수증, 낡은 기준은 실행 전 거절, 실행 후 예외는 로컬 진단·불명확 상태 유지 및 후속 쓰기 거절이다.
- `tests/integration/browser-zwcad-sdk.mjs`: 실제 브라우저의 ZWCAD 선택·요청 입력 → 구독 CLI → 제품 MCP 도구 → 자체 SDK 실행 → 후보 표시·객체 선택. ChatGPT와 Claude를 각 한 과업씩 실행했다. 각 과업은 생성 후 같은 객체 수정의 두 성공 실행이며 최종 면적 240 m²·길이 68 m를 확인했다. 후속 화면 검수는 저장된 결과를 재사용하여 AI를 다시 호출하지 않았다.
- 제어기 자동 시험: 조회 권한의 쓰기 도구 부재, 컴파일 오류와 실행 후 불명확의 재시도 구분, 보존 객체 변경 후보 거절. 불명확 복구에도 보존 기준을 다시 적용한다.

## 증거와 실제 수정

- 실제 SDK: `.vide/zwcad-worker/1b3f3088-c1f0-4512-a8e3-9f0fc88e98d2`.
- ChatGPT: `.vide/browser-zwcad-sdk/3e205343-462e-443b-8aad-ccbdd784419e`.
- Claude: `.vide/browser-zwcad-sdk/1f017a2a-5082-4520-b847-433a9576991d`.
- 최초 실호스트 로드에서 .NET Framework의 Unsafe 의존 DLL 버전 연결 오류를 확인했다. 설치 호스트 설정을 바꾸지 않고 자체 동봉 DLL의 이름·공개키 토큰을 확인하는 플러그인 내부 resolver로 수정했다. 정상 변수의 전역 네임스페이스 과잉 거절도 실제 생성 시험에서 발견·수정했다.
- 브라우저 최초 자동 조작의 effort 선택 실패는 AI 호출 전 시험 설정 오류였다. 제공되는 default 값을 사용해 다시 실행했다. 첫 화면 캡처가 UI 갱신 전이어서 저장된 후보를 명시 선택한 뒤 최종 화면을 재검수했다.

## 남은 범위

독립 직선 XY LWPolyline의 기존 표시/검수 범위다. 모든 CAD 객체·관계 보존이나 완전한 OS 코드 격리의 증거가 아니다. 자체 SDK 편집 창·고정 적용은 아래 범위까지 검증했다. 일반 문서 간 복사, 실제 설치 배포, 공유 의견 후 수정·재게시 왕복은 남아 있다. 논현동 실무 과업 수용을 대신하지 않는다. 구독 사용량은 공급자가 보고하지 않은 경우 미확인이며 시험 결과로 요금/속도 우열을 주장하지 않는다.

## 자체 편집 창과 고정 적용

- 자체 SDK로 별도 편집 사본을 열고 COM attach 없이 해당 프로세스/문서를 조회·재취득한다. 창의 실행 정보는 로컬 registry에만 저장하고 재연결 때 PID/시작 시각/실행 파일/포트 소유를 재검사한다. 사용자가 연 창은 제어기 종료 시 자동 종료하지 않는다.
- `tests/integration/zwcad-editors.mjs`: 같은 `editing.dwg` 이름인 두 실행본을 구분, 문서 ID 오지정 거절, 제어기 객체 재생성 후 재취득, 편집 세션의 임의 코드 거절, 후보의 기존 폴리라인 수정 및 새 폴리라인 추가, 적용 후 형상/속성 재조회, 중복 적용 동일 영수증, 다른 실행본 비변경, 낡은 기준 거절을 통과했다. 증거: `.vide/zwcad-editors/6bf26505-b731-41aa-b767-49475aedc6d8`.
- `tests/integration/browser-zwcad-editor.mjs`: 브라우저에서 ZWCAD 후보 열기→문서 조회/선택→작업 사본 취득→지원 범위의 후보 영향 검토→명시 적용을 통과했다. 연결 기록의 host도 zwcad로 확인했다. 이 시험의 후속 후보는 결정적 SDK 코드이며 AI 호출을 추가하지 않았다. 증거: `.vide/browser-zwcad-editor/833d153c-15ac-46a5-9292-d2d97429a974`.
- 실호스트에서 Wblock 사본은 Handle을 바꿔 재취득 기준으로 부적합했다. 파일 이름을 바꾸지 않는 SaveAs overload를 설치 SDK에서 빌드·실행해 Handle/파일명 유지로 확인했다. 다른 DB 객체의 CopyFrom은 eWrongDatabase, 모든 기존 정점 삭제는 eDegenerateGeometry로 거절되어 지원 폴리라인의 정점·레이어·선종류·색/선가중치 등을 고정 이식하고 전체 재취득으로 검증한다. 실패는 unknown을 유지했고 같은 작업을 자동 재실행하지 않았다.
- 이식은 관계 없는 mm XY 직선 폴리라인의 검증 범위다. 추가 객체는 새 Handle 대응을 영수증에 기록한다. 사용자 문서 간 일반 복사, 한 요청의 CAD→Rhino 연계/부분 실패는 아직 추가 검수 대상이다. 적용 성공을 파일 저장 완료로 표시하지 않는다.

## 로컬 공유 회귀

`node tests/sharing/membership.mjs --browser`는 로컬 workerd/D1/R2에서 세 계정·두 프로젝트 권한, 게시·응답 유실 재확인, 객체 선택·월드 핀·스케치 의견, 파일 전달·로컬 초안 채택·중복 수신·재시작 유지까지 통과했다. 증거: `.vide/sharing-membership/6858dfbf-05ad-4722-a101-a23f6dd8beaf`. 이는 기존 파일 왕복 경로의 증거이며 온라인 자동 연동·의견 후 실제 호스트 수정/재게시·원격 배포 완료는 아니다.

## 호스트 직접 편집과 회귀

- `tests/integration/zwcad-native-edit.mjs`: 소유한 합성 편집 창에서 기본 MOVE·QSAVE 명령을 실행하고 실제 저장 DWG를 별도 SDK 실행본으로 재열어 이동 좌표·240 m²·Handle을 확인했다. SAVEAS 뒤 이름이 달라진 문서와 CLOSE로 닫힌 문서는 재취득을 거절했다. 증거: `.vide/zwcad-native-edit/5c72d2e2-7d4e-45f4-a206-c98ddfc728cc`. 시험용 명령 어셈블리는 tests에만 있고 제품 배포에 포함하지 않는다.
- 검사 사본 SaveAs 뒤 DBMOD가 켜지는 현상이 있어 변경 플래그만으로 저장 여부를 단정하지 않는다. 직접 저장 성공은 저장 파일 재열기로 확인했다. 저장 상태 표시의 정밀화는 남은 조건이다.
- Rhino의 같은 문서 UI 회귀: `.vide/browser-owned-editor/ed70b4d0-a3b8-4960-9886-b380fa1083d2`, 실제 열기·재취득·적용·재연결과 같은 객체의 체적 24→48 m³ 통과.
