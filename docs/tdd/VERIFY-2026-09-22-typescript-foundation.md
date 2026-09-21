---
id: VERIFY-2026-09-22-typescript-foundation
title: TypeScript·React·Vite 전환 기반 검증
status: review
version: 0.1
updated: 2026-09-22
owner: agent:codex
related: [PLAN, ADR-016, ADR-017, T-010, T-011, T-015]
---

# 전환 기반 검증

## 구현 범위

React 19.3.0, TypeScript 7.0.2, Vite 8.3.0, React Vite plugin 6.1.1을 lockfile에 고정했다. Node 24.15.0과 Three.js 0.186.0은 유지한다. `npm run build`는 UI/서버 타입 검사, Vite UI 빌드와 서버 tsc 출력을 수행한다. start/workspace/test/package:windows 전에 UI를 빌드한다.

React는 모바일 탭 DOM을 단독 소유한다. 기존 화면 전환은 같은 상태 변경 함수를 호출하며 구독을 해제할 수 있다. 나머지 패널은 기존 mjs가 소유한다. 기존 mjs는 allowJs/checkJs:false로 공존하며 새 TS/TSX만 strict 검사한다. 전체 타입 안정성을 달성했다는 뜻은 아니다.

로컬 서버는 기존 Host/Origin/CSP 검사를 유지하며 dist/ui의 HTML과 허용된 해시 JS/CSS만 제공한다. 소스 TS/JS, 소스맵, 빌드 manifest는 공개하지 않는다. 개발 소스·컴파일된 서버·배포 app 모두 해당 패키지의 dist/ui를 찾는다. Windows 패키지에는 UI 빌드 결과가 포함되며 현재 서버의 TS는 번들 Node의 기본 타입 제거로 실행한다.

## 확인 결과

- `npm run build`: 통과. 기존 app/Three 청크 약 630 kB로 Vite의 500 kB 경고가 남는다. 성능 개선 완료로 보지 않는다.
- `npm test`: 97/97 통과. 실제 HTTP로 HTML의 JS/CSS URL을 읽고 비공개 소스·manifest·누락 자산이 404인지 추가 확인했다.
- 컴파일 결과 dist/server/src/server/web-assets.js에서 HTML 8,634 bytes 읽기 성공. 컴파일 서버 전체의 호스트 실행 검증은 아니다.
- 격리 데이터 디렉터리의 Chromium 데스크톱 화면: 기존 3D canvas/좌측 문서/우측 AI 패널 표시, 브라우저 오류 없음.
- 390×844 화면: React 모델/대화 탭의 aria-pressed와 표시 상태 일치, 탭 왕복 후 입력 보존, canvas 1개, 가로 overflow 없음. 실제 스크린샷도 확인했다.
- `npm run package:windows -- 0.1.0-ts-migration-20260922`: ZIP 생성 성공. 패키지 runtime/node.exe로 app/src/server/main.mjs를 격리 데이터에 실행하고 브라우저에서 빌드 JS 로딩·canvas 1개·React 탭 2개·오류 없음을 확인했다. 새 PC 설치/서명/전체 호스트 과업 시험은 아니다. 이 작업 트리의 미완료 Rhino worker도 들어간 개발 검증용 묶음이므로 공개 배포하지 않는다.

## 다음 검증

공유 계약 타입, 일반 패널 React 전환, 서버 모듈 TypeScript 전환을 각각 기능 단위로 진행한다. 기존 호스트 실행·저장 보호 시험을 유지한다. 실제 Rhino worker 준비 타임아웃은 별도 미완료 항목이며 이번 웹 빌드 성공으로 해소되지 않는다.
