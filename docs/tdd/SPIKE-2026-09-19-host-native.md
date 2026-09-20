---
id: SPIKE-2026-09-19-host-native
title: 설치 호스트의 네이티브 객체·저장 경계 실험
status: review
version: 0.2
updated: 2026-09-19
owner: agent:codex
related: [PLAN, T-003, FR-03, FR-04, AC-24, AC-38, OQ-03, OQ-10]
---

# 설치 호스트의 네이티브 객체·저장 경계 실험

## 질문·환경

사용자가 지정한 현재 설치본 Rhino 8.34.26223.11001·ZWCAD 2023(23.20.3.11)에서 합성 폴리라인의 조회·생성·후보 분리·수정·저장·재열기가 가능한지 확인한다. 기존 사용자 문서를 변경하지 않는다. 실제 지원 선언 전 실험이므로 H-*는 아직 부여하지 않는다.

## 방법·종료 조건

코드는 `tools/spikes/2026-09-19-host-native/`에 둔다. Rhino는 별도 프로세스의 스크립트 실행으로 새 headless 문서를 만들고 합성 객체만 시험한다. 결과·시험 파일은 `.vide/host-spike/` 아래에 둔다. 네이티브 API의 객체·속성·저장 지속성이 확인되면 성공, 기동·라이선스·API·저장 오류는 그대로 기록한다. headless API 시험은 사용자의 기본 편집 도구·화면 검수와 구분한다.

실험의 명령행 경로는 [McNeel 공식 안내](https://developer.rhino3d.com/guides/cpp/running-rhino-from-command-line/), API는 설치 RhinoCommon.xml의 CreateHeadless·OpenHeadless·Write3dmFile 설명을 기준으로 한다. .NET 런타임 차이는 [공식 런타임 안내](https://www.rhino3d.com/docs/guides/netcore/)를 따른다.

## 결과·한계

Rhino는 별도 프로세스에서 스크립트를 실행해 9개 확인 항목 모두 true를 기록하고 종료했다. [Rhino 원시 결과](../assets/host-native/rhino-result.json).

ZWCAD는 사전 실행 프로세스가 없음을 확인한 뒤 공식 COM 경로로 새 인스턴스·문서를 만들어 9개 확인 항목 모두 true를 기록했다. 생성·복사·후보 삭제·이동·색상 보존·저장·재열기·좌표·mm 단위가 확인됐다. [ZWCAD 원시 결과](../assets/host-native/zwcad-result.json). 코드 `zwcad-probe.ps1`은 COM으로 실행하므로 제품용 .NET 빌드 검증과 다르다. 설치 `zwcad.exe.config`는 v4.0 CLR을 선언한다.

ZWCAD 시험 문서는 스크립트에서 닫았으나 앱에 기본 문서가 남아 앱 전체 종료는 수행하지 않았다. 후속 활성 앱 종료 시도는 자동 승인 검토가 사용자 세션 종료 가능성을 이유로 거절해 실행되지 않았다. 이후 해당 동작을 우회 실행하지 않았다.

두 시험 모두 SDK/COM 네이티브 작업이다. 제품 UI 연결, 기존 사용자 문서의 관계 보호, 사용자 기본 도구 재편집, 여러 인스턴스, 실시간 충돌·응답 유실·설치는 미시험이다. 지원표의 H-RHINO-01~03·H-ZWCAD-01~03에 이 한계를 구분했다.
