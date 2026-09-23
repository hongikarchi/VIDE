---
id: VERIFY-2026-09-24-sdk-package
title: 자체 SDK Windows 패키지 검수
status: review
version: 0.2
updated: 2026-09-24
owner: agent:codex
related: [PLAN-02, T-017, T-018, SPEC-05]
---

# 자체 SDK Windows 패키지 검수

`0.1.0-dev.20260924.1` 검수 ZIP을 새 폴더에 만들었다. `.vide/releases/VIDE-0.1.0-dev.20260924.1-windows-x64.zip`은 로컬 산출물이며 외부 배포하지 않았다. 추적된 제품 소스와 내장 Node, 명시한 런타임 DLL만 사용하며 설치 호스트 SDK를 동봉하지 않는다.

- ZWCAD Roslyn/System 의존성의 복원된 고정 버전과 라이선스/고지를 함께 복사한다. Roslyn 고지는 NuGet 메타데이터의 소스 커밋 `5e3a11e2e7f952da93f9d35bd63a2fa181c0608b`를 사용한다. 패키지별 DLL·SHA512 목록을 licenses/zwcad-runtime/packages.json에 기록하며 누락된 고지는 빌드를 실패시킨다.
- `tests/integration/packaged-sdk.mjs`: 공백 경로 압축 해제, 내장 Node, 동봉 애드인만으로 실제 Rhino 24 m³ 상자와 ZWCAD 200 m² 폴리라인 생성을 통과했다. 증거: `.vide/packaged-sdk/a8139f15-f7b6-45d4-a623-4e51663093d8/result.json`.
- `tests/integration/portable-package.mjs`: 5,155개 파일 해시, 런처 중복 실행, 실제 브라우저, 외부 의견 UI, DWG SDK 가져오기·240 m² 정점 수정, 종료/재시작, 데이터 유지·오프라인 백업 검증을 통과했다. 증거: `.vide/package-check/0e7c28b3-7d70-4ec2-b1b1-4ab65bdcec49`.
- 시험용 압축 해제 설치본은 경로 확인 후 정리하며 결과와 격리 데이터는 증거로 남겼다. 사용자의 기본 VIDE 데이터나 열린 호스트는 변경하지 않았다.

개발 PC의 설치된 Rhino/ZWCAD를 사용한 검수다. 개발 도구가 없는 별도 PC, 코드 서명, 일반 설치 프로그램, 외부 배포·원격 CI를 완료로 표시하지 않는다. 첫 `.1` 패키지는 후속 복수 대상 구현을 포함하지 않았다. 최신 결과는 아래와 같다.

## 연계 기능 포함 패키지 `.2`

`.vide/releases/VIDE-0.1.0-dev.20260924.2-windows-x64.zip`은 커밋 `bab2d17`의 제품 소스와 동봉 애드인·내장 Node를 포함한다(5,157개 파일). 이전 ZIP을 덮어쓰지 않았다. `VIDE_TEST_PACKAGE_APP`으로 패키지 app 경로를 지정한 `browser-linked-hosts.mjs`에서 실제 브라우저 두 대상 첨부→ZWCAD 260 m²→Rhino 1,560 m³와 원본 보존을 통과했다. 증거: `.vide/browser-linked-hosts/f72ccb51-db0d-4585-91db-b44dd77ea4ea`. 시험용 Playwright/MCP client는 개발 환경 도구이며 제품 서버/호스트 코드와 Node는 패키지 것을 사용했다. 별도 PC 검수의 대체 증거는 아니다.

같은 ZIP의 `portable-package.mjs`도 `.vide/package-check/401cef26-ce0b-4a50-9345-bd352a627fb0`에서 통과했다. 전 파일 해시, 공백 설치 경로, 중복 런처, 브라우저·공유 의견 UI, 실제 DWG 읽기/SDK 수정, 종료/재시작, 설치 제거 후 데이터 유지·오프라인 백업을 확인했다.
