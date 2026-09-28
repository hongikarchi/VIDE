---
id: VERIFY-2026-09-28-workspace-polish
title: 작성기·카메라·상태줄 조작 검증
status: review
version: 0.1
updated: 2026-09-28
owner: agent:codex
related: [PLAN-04, T-010, T-004, SPEC-01, SPEC-05, SCR-10]
---

# 작성기·카메라·상태줄 조작 검증

기준: [PLAN-04](../plans/PLAN-04-workspace-ui.md)의 2026-09-28 작업 범위와 Design 작성기·카메라·상태 조작 보완. 사용자 Rhino 파일에는 명령·형상 편집·저장을 하지 않았다. 격리 HTTP 서버와 합성 프로젝트를 Chromium에서 검사했다.

| 항목 | 실제 확인 |
|---|---|
| Effort | 현재 단계 캡슐과 팝업 슬라이더. End 키로 high 선택, 다른 모델의 미지원 단계는 기본값으로 전환·슬라이더 비활성. Escape 닫기. 1440×900 렌더 확인 |
| 입력 높이 | 상단 경계 80px 드래그가 textarea 높이에 반영. Home은 96px 기본 높이. 저장된 로컬 선호를 사용하고 창 높이에 제한 |
| Rhino 마우스 | 우클릭 회전 후 axon 강조 해제 및 렌더 변경. Shift 우클릭은 방향 유지·화면 평행 이동. 앞 직교에서도 Shift 우클릭 이동·방향 유지 |
| 하단 상태 | 공급자·호스트 준비·계정·오류 기록을 상태줄에 배치. 인증 실패는 입력/요청 비활성 상태와 오류 기록에 반영. IMPORT_LIMIT 실패 기록에서 해당 작업 카드로 이동 |
| 설정 | rail 하단 설정→AI 계정·연결 설정 진입/닫기. 원 입력 유지. 기존 계정 추가/선택/로그인 안내 브라우저 회귀 통과. 잔여 구독량은 추정하지 않음 |
| 기존 동작 | 초안 교체 취소/수락, 문서 탭, 패널 크기, 첨부 검증, React 패널 회귀, 연결 Rhino 수동/자동 Sync 목업 및 초안 보호 회귀 통과 |

실행 명령: `npm run typecheck`, `npm run build:web`, `node tests/integration/browser-workspace-controls.mjs`, `node tests/integration/browser-react-panels.mjs`, `node tests/integration/browser-accounts.mjs`, `node tests/integration/browser-attached-sync.mjs`.

렌더 증거는 로컬 `.vide/ui-audit/controls-1440.png`, `effort-1440.png`, `settings-1440.png`, `controls-800.png`이다. 테스트 스크립트가 재생성한다. 800px에서는 기존 모바일 탭과 가로 스크롤 가능한 상태줄을 유지한다. 공급자·호스트 응답은 mock이며 실제 사용자 모델 Sync나 실제 AI 실행 성공의 증거가 아니다. 빌드의 기존 500kB 청크 경고는 남아 있다.
