---
id: VERIFY-2026-09-28-desktop-app
title: PC 프로그램 설치·창·트레이·업데이트·연결 프로그램 검증
status: review
version: 0.1
updated: 2026-09-28
owner: agent:claude
related: [PLAN-11, ARCH-01, T-010, T-020]
---

# PC 프로그램 설치·창·트레이·업데이트·연결 프로그램 검증

[PLAN-11](../plans/PLAN-11-desktop-app.md)의 결과다. 적용할 AC가 없는 설치·운영 흐름이어서 PLAN-11의 결정 문단을 기준으로 삼는다.

## 환경

- Windows 11 Pro(26200), .NET Framework 4.8, WebView2 런타임(Windows 기본), Node.js v24.15.0 번들, Velopack 1.2.158(`vpk` 저장소 로컬 도구).
- 설치본: `npm run desktop:release -- 0.2.0` → `VIDE.App-win-Setup.exe` 63 MB, 전체 패키지 56 MB, 설치 크기 약 267 MB. 미서명(사용자 결정: "추가 정보 → 실행").
- 이 PC의 실제 설치(`%LOCALAPPDATA%\VIDE.App`)와 실제 사용자 데이터(`%LOCALAPPDATA%\VIDE`)를 사용했다. 업데이트 배포처는 저장소의 `.vide/releases/installer` 폴더다.

## 결과

| 항목 | 방법 | 결과 |
|---|---|---|
| 창·엔진·설정·자동 실행·트레이·단일 실행·종료 | `tests/integration/desktop-shell.mjs` — 셸 빌드와 패키지 둘 다(별도 데이터 폴더), WebView2 디버그 포트로 실제 창 조작 | 통과. 창 표시 0.9~1.0초, 자동 실행 등록·해제, 창 닫기 후 트레이 유지, 두 번째 실행은 기존 창 사용, `--quit` 시 엔진까지 종료 |
| 설치 | Setup `--silent` | 통과. 바탕화면·시작 메뉴 바로가기, 관리자 권한 없음, 사용자 데이터 그대로 |
| 자동 업데이트 | `tests/integration/desktop-update.mjs` — 설치된 0.2.0의 설정 → 업데이트 확인 → 재시작하여 업데이트 | 통과. 차등 패키지로 0.2.1 적용, 재시작 5.1초, 프로젝트 수 유지, 설정에 `VIDE 0.2.1` |
| 연결 프로그램(Rhino 8) | 단위 시험(`tests/server/connectors.test.mjs`) + 설치된 0.2.1의 설정 화면에서 설치 | 통과. 등록 경로가 개발 빌드(`.vide/build/…`)에서 `%LOCALAPPDATA%\VIDE\plugins\rhino\0.2.1-83d5c6b8\`로 바뀌었고, 문서 없이 띄운 Rhino 8이 그 경로의 `VIDE.Worker.rhp`를 로드한 뒤 종료했다. Rhino 실행 중 설치 거부는 단위 시험으로 확인 |
| 버전 호환 | `tests/sharing/hosts.mjs` | 통과. 사이트에 PC 버전 표시, 최소 버전(숫자 비교, 0.9 < 0.10)보다 낮으면 "업데이트 필요"와 열기 거부 |

화면: `.vide/desktop-shell/…/window-settings.png`, `.vide/desktop-update-ready.png`, `.vide/desktop-update-after.png`, `.vide/plugin-installed.png`.

## 한계

- 새 PC(개발 도구 없음)에서의 설치와 SmartScreen 경고 화면은 확인하지 않았다. 미서명이라 경고가 뜨는 것이 정상이다.
- Rhino 플러그인 등록이 없던 PC의 신규 등록은 Rhino가 끌어 놓기로 만드는 값과 같게 쓰지만 실제 새 PC에서는 확인하지 않았다.
- GitHub Releases `v0.2.1`(2026-09-29 게시)의 `releases/latest/download/releases.win.json`과 설치본 내려받기는 확인했다. 그 배포처로 설치된 프로그램의 실제 업데이트는 다음 게시 때 확인한다(이 PC는 폴더 배포처를 쓴다).
- Windows 시작 시 실제 자동 실행(재부팅)은 레지스트리 값까지만 확인했다.
