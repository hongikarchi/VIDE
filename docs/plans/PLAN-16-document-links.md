---
id: PLAN-16
title: 프로젝트 연결 파일(Link)과 여러 파일의 한 공간
status: review
version: 0.1
updated: 2026-09-29
owner: agent:claude
related: [PLAN, SPEC-01, DESIGN, ARCH-01, FR-01, FR-02, FR-03, FR-16]
---

# 프로젝트 연결 파일(Link)과 여러 파일의 한 공간

2026-09-29 사용자 지적과 결정의 작업이다. 지적: 여러 파일을 한 작업 공간에 넣기 어렵고(화면은 결과 하나, 자동 Sync는 고른 문서 하나), 플러그인 연결→Sync→Live→VIDE에서 문서 선택→새로고침→가져오기의 흐름이 길고, 예전에 연결한 파일이 어디 있는지 보이지 않는다. 결정: 플러그인 Link에서 프로젝트를 고르고 연결+첫 Sync, VIDE는 연결 파일 목록·보이기 토글·강제 Sync, 기존 모델 연결 칸은 목록으로 대체, 모든 연결 파일은 주종 없이 한 공간에 표시. 동작은 [SPEC-01.9](../specs/SPEC-01-project-input-sync.md), 화면은 [Design §03](../../Design.md), 물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md) '프로젝트 연결 파일'.

## 변경

1. 엔진: 스키마 v4 `document_links`, 연결 경로 4개, Sync·Live Sync의 `linkId`, 플러그인 상태의 파일 경로.
2. 화면: 모델 연결 칸 → 연결 파일 목록(보이기·⟳·빼기), 연결 목록 폴링으로 첫 Sync와 Live Sync(파일별 보류), 레이어 합성 표시(ID 구분, 객체별 기준), 대상 파일 칩, 객체 목록의 파일별 묶음.
3. Rhino 플러그인: 패널 Link/Unlink·Live·Sync와 프로젝트 고르기 대화상자, `VIDELink` 명령(`VIDEConnect`는 같은 동작), 패널 VIDE 화면에 연결 프로젝트 전달.
4. ZWCAD 플러그인: 같은 구성(`VIDECADLink`).

## 검증

- 단위: 연결 등록·갱신(같은 경로)·숨김·빼기, 다른 프로젝트 격리, 스키마 v4(`tests/core/migrations.test.mjs`), 레이어 합성·ID 구분(`tests/core/layers.test.mjs`), 플러그인이 쓰는 HTTP 순서(실행 토큰 세션·Origin·프로젝트 목록·Link·숨김·빼기·다른 프로젝트 거절, `tests/server/links-http.test.mjs`). 통과.
- 브라우저(`tests/integration/browser-links.mjs`): 연결 파일 3개(Rhino 1·같은 핸들을 가진 DWG 2)의 목록, 함께 표시와 파일별 객체 트리, 숨기기 저장, 객체를 고르면 대상 파일 전환, 핀은 파일 자신의 ID·기준으로 저장, 다른 파일 객체는 참고 핀, 목록에서 빼도 Sync 기록 유지, 새로 Link된 열린 파일의 첫 Sync 자동. 기존 시험을 연결 파일 기준으로 바꿔 통과: 첫 Sync 실패 표시·초안 보호·원본 적용 요청·닫힘(`browser-attached-sync`), Live Sync 부분 갱신(`browser-live-sync`), 핀 토큰, Rhino 패널(첫 Sync 전 고정 → Sync 후 반영, 패널 Sync). 브라우저 시험 17개 통과.
- 플러그인: Rhino(net8)·ZWCAD(net48) 빌드 성공. 프로젝트 고르기 대화상자와 실제 창의 Link는 사용자 검수가 남았다.
- 실행하지 않은 시험: 실제 호스트가 필요한 `rhino-attached-ai`·`zwcad-attached`·`browser-owned-editor`·`browser-zwcad-editor`·`native-capture`는 연결 파일 기준으로 고쳤으나 이번에 실행하지 않았다. `native-source-edit`(옛 MCP 문서의 호스트 선택 첨부)는 연결 파일로 대체된 경로라 다시 써야 한다.

## 남은 것

- 두 파일에 걸친 변경 핀을 연계 요청으로 자동 전환, 다른 파일 객체를 수정 대상으로 쓰는 흐름.
