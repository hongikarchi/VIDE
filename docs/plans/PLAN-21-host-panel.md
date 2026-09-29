---
id: PLAN-21
title: 호스트 패널(Rhino·ZWCAD) 화면과 계정 사용량 막대
status: review
version: 0.1
updated: 2026-09-29
owner: agent:claude
related: [PLAN, DESIGN, SPEC-01, ARCH-01, PLAN-16, FR-02, FR-03]
---

# 호스트 패널(Rhino·ZWCAD) 화면과 계정 사용량 막대

2026-09-29 사용자 지적과 결정: "rhino panel 디자인도 좀 필요할 듯. UI가 vino때보다 왤케 구려진거지 … cad도 마찬가지". 결정: CAD 패널도 웹 화면으로, Link는 뜨는 창 그대로, 계정 사용량 막대를 패널과 VIDE 앱 상태줄에 둔다. 화면 기준은 [Design SCR-12](../../Design.md), 동작은 [SPEC-01.11](../specs/SPEC-01-project-input-sync.md), 물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md).

## 원인

- Rhino 패널은 위에 Rhino 기본 버튼 줄(Unlink·Live·Sync·⟳와 상태 글자)을 두고 아래에 VIDE 작업 열을 넣었다. 좁은 폭에서 큰 버튼이 파일 이름을 쪼갰고, 같은 상태와 Sync 버튼이 웹 화면에 한 번 더 있었다. 연결 전·VIDE 꺼짐 안내는 글자 한 줄이었다.
- ZWCAD 팔레트는 기본 Windows 버튼 4개를 세로로 쌓은 화면이었고 AI 작업 화면이 없었다.

## 변경

1. 웹(`src/ui/host-panel.tsx`, `src/ui/app.ts`): 패널 머리(호스트 표식·파일·상태·프로젝트·Sync·Live 스위치·⋯ 메뉴), 연결 전 카드, 작성기의 '선택 N개 첨부' 칩(Rhino는 고정 핀, CAD는 `/host/selection`), 패널의 요청 대상을 패널 파일로 고정. `?panel=zwcad` 지원.
2. 사용량 막대(`src/ui/usage-bars.ts`): 패널 바닥과 앱 상태줄. 세션이 열린 뒤 시작한다(열기 전 호출은 401로 연결 끊김 처리됐다).
3. Rhino 플러그인(`hosts/rhino/worker/ConnectionPanel.cs`): 기본 버튼 줄 제거, 웹 화면만. `vide://` 동작 처리.
4. ZWCAD 플러그인(`hosts/zwcad/connection/ConnectionPanel.cs`): WebView2 웹 화면(팔레트 380×760). 설치본에 WebView2 DLL과 로더를 넣는다(`src/desktop/build.mjs`).
5. 공통(`hosts/common/PanelPage.cs`): 패널 주소, VIDE 꺼짐 화면, VIDE 실행, 동작 판별.

## 검증

- `tests/integration/browser-host-panel.mjs`: Rhino 연결됨(머리 하나·Sync 하나·Live 켜짐·선택 칩·사용량 막대·90% 경고색), 메뉴와 스위치의 플러그인 동작, 연결 전 카드와 작성기 숨김, ZWCAD(어두운 테마·CAD 표식·CAD 선택 칩), 앱 상태줄의 한도 표시. `browser-rhino-panel.mjs`를 새 머리·선택 칩으로 고쳤다. 브라우저 시험 전체 통과.
- 두 플러그인 빌드(경고 0).

## 남은 일

- 실제 Rhino·ZWCAD 안에서의 확인: 웹 화면과 플러그인이 같은 설치본(0.2.10)으로 함께 바뀌어야 한다(새 플러그인은 기본 버튼 줄이 없어 옛 웹 화면과 맞지 않는다). 설치 뒤 두 호스트에서 연결 전→Link→Sync→Live→선택 첨부→요청을 확인한다.
- 설치 때 Rhino는 닫혀 있어야 하고, ZWCAD는 다시 켜야 새 팔레트가 올라온다.
