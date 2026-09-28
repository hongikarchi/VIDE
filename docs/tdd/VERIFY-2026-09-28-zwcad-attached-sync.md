---
id: VERIFY-2026-09-28-zwcad-attached-sync
title: 현재 ZWCAD 도면 연결과 패널 검수
status: review
version: 0.2
updated: 2026-09-28
owner: agent:codex
related: [PLAN-07, T-006, H-ZWCAD-07, AC-38, SCR-01]
---

# 현재 ZWCAD 읽기 연결

기준은 HOST-ZWCAD §1.1과 PLAN-07이다. AC-38의 호스트 연결·재취득 부분만 검수하며 현재 사용자 문서의 AI 수정·저장까지 통과했다는 기록이 아니다.

## 확인한 결과

- ZWCAD 2023 설치 SDK로 별도 `VIDE.Zwcad.Connection.dll` 빌드 성공. .NET Framework 4.8 x64, 경고/오류 0건. 설치 SDK DLL은 배포하지 않는다.
- `tests/integration/zwcad-attached.mjs`: 별도 소유 시험 CAD의 선·원·블록·문자 4개 중 선·원·블록 3개 표시, 문자 1개 누락을 기록했다. 좌표 mm→m, 블록 변환, 브라우저 Sync와 새로고침, JavaScript 오류 없음 확인.
- 같은 시험에서 Live Sync 변경 세대 증가, 두 번째 도면 연결 후 첫 도면 대상 고정, 첫 연결 해제와 두 번째 도면 닫힘, 틀린 토큰/문서·알 수 없는 실행 메서드·stale revision 거절 통과. 시험 CAD만 종료했다.
- 실제 사용자가 열어 둔 기본도면에서 새로운 별도 연결 DLL을 로드하고 `VIDE CAD` 패널과 연결을 확인했다. 모델 공간 3,841개, mm, 기존 수정 상태 유지. 사용자 파일 저장·형상 수정·닫기는 수행하지 않았다.
- 기존 실행 DLL과 충돌하지 않도록 읽기 연결 DLL·명령을 분리했다. Rhino 애드인과 기존 VIDE 서버는 재시작하지 않았다.

합성 시험의 로컬 증거: `.vide/zwcad-attached/ef5baf24-8f27-45ea-8801-3ad7dfe515c0/result.json`, `browser-sync.png`. 실행 코드는 저장소의 테스트 파일에 남긴다. 실제 도면 데이터와 인증정보는 Git에 포함하지 않는다.

최신 Rhino 패널 채팅·스케치 UI와 병합 후 타입 검사와 `browser-workspace-controls`·`browser-react-panels`·`browser-attached-sync`·`browser-rhino-chat`를 통과했다. CAD 문서를 Rhino 채팅 브리지로 전달하지 않도록 호스트 구분을 추가했다. 첫 기능 커밋의 자동 검사 249개·포맷·비밀정보 검사는 통과했다.

표시 데이터 폭증 수정 후 원 5,000개를 가진 합성 블록과 그 뒤의 정상 선을 추가했다. 총 6개 중 정상 4개 표시, 문자 1개·대형 블록 1개 제외를 확인했고 큰 블록 뒤의 선도 보존했다. 다중 도면·해제/닫힘까지 통과했다. 최신 로컬 증거는 `.vide/zwcad-attached/72f89853-2d1f-49ee-9731-016a5524610f/result.json`의 `largeCoverage`이다.

## 실제 도면에서 발견한 한계

일부 객체는 SDK 읽기 자체에서 예외가 발생한다. 외부참조 블록 하나의 중첩 표시 데이터를 풀어 쓰면 응답이 721,900,091 bytes로 커졌고 다른 블록도 400MB 전후였다. 이전 플러그인으로 실제 제품 Sync를 실행했으나 2,500번째 객체 이후 조회에서 `HOST_RESULT_UNKNOWN`으로 실패했다. 실제 작업 도면의 화면 표시 완료로 집계하지 않는다.

수정 플러그인은 SDK 예외·큰 객체를 네이티브 조회 중 분리하고 페이지 크기를 조절한다. 이미 열린 사용자 CAD에는 이전 DLL이 로드되어 있으므로, 사용자 저장·종료 후 새 DLL을 배치하고 같은 작업 문서에서 다시 확인해야 한다. Rhino와 기존 VIDE 서버는 이 교체 대상으로 삼지 않는다.

같은 DWG 저장본을 별도 시험 CAD에서 읽기 전용으로 여는 추가 시험은 누락 SHX 글꼴 안내에서 대기해 취득을 완료하지 못했다. 시험 인스턴스는 종료했다. 이 결과를 사용자 작업창 재연결 검증으로 대체하지 않는다. 수정 DLL은 로컬 `.vide/build/zwcad-connection-next/VIDE.Zwcad.Connection.dll`에 준비했다.

현재 표시 경로는 문자·해치 채움·출력 스타일·배치 공간을 재현하지 않는다. 큰 외부참조의 공유 기하/인스턴싱은 후속 과제다. 합성 시험 통과와 실제 대형 도면의 완전한 표시·실용적인 속도는 구분한다. 포터블 패키지에 연결 DLL을 포함하는 빌드 경로는 추가했지만 이번 검수에서 전체 포터블 배포본 재빌드는 하지 않았다.
