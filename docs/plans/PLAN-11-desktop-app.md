---
id: PLAN-11
title: PC 프로그램 — 설치본·자체 창·트레이·업데이트·연결 프로그램
status: review
version: 0.1
updated: 2026-09-28
owner: agent:claude
related: [PLAN, PLAN-10, ARCH-01, T-010, T-020]
---

# PC 프로그램 — 설치본·자체 창·트레이·업데이트·연결 프로그램

2026-09-28 사용자 지시와 결정이다. Figma desktop처럼 설치해서 쓰는 PC 프로그램(작업 엔진과 자체 창)을 만들고, 웹([PLAN-10](PLAN-10-account-workspace.md))은 다른 기기의 창구로 둔다. Rhino·CAD 등과의 연결은 프로그램별 플러그인이 맡는다.

- 본체 설치 파일은 하나이고, 플러그인은 본체 안의 "연결 프로그램"에서 프로그램별로 따로 설치·업데이트한다.
- Windows 시작 시 자동 실행과 창을 닫아도 백그라운드 유지는 설정에서 켜고 끈다.
- 창은 브라우저 탭이 아닌 독립 프로그램 창이다(WebView2).
- 코드 서명 인증서는 확인 항목으로만 둔다. 당분간 미서명 설치본을 "추가 정보 → 실행"으로 설치한다.
- 업데이트 설계를 포함한다(아래 §업데이트).
- 진행 순서: ① 설치본·창·트레이·자동 실행 ② 업데이트 ③ 연결 프로그램(Rhino부터).

## 구성

| 항목 | 위치 | 비고 |
|---|---|---|
| 프로그램 | `%LOCALAPPDATA%\VIDE.App\current\` | Velopack 사용자 범위 설치(관리자 권한 없음). 업데이트 때 통째로 교체 |
| 사용자 데이터 | `%LOCALAPPDATA%\VIDE\` | 기존 위치 그대로. 설치·업데이트·제거가 건드리지 않는다 |
| 창 저장소(WebView2) | `%LOCALAPPDATA%\VIDE\webview\` | 로그인 쿠키가 업데이트 뒤에도 유지 |
| 설치한 플러그인 | `%LOCALAPPDATA%\VIDE\plugins\<host>\<version>\` | 실행 중인 Rhino가 잠가도 프로그램 업데이트와 충돌하지 않게 분리 |

`current\`에는 셸 `VIDE.exe`(.NET Framework 4.8 WinForms + WebView2, Windows 기본 포함), `runtime\node.exe`, `app\`(서버·화면·운영 의존성·호스트 런타임)이 들어간다. 조립은 기존 `src/desktop/build.mjs`를 쓴다.

## ① 셸과 작업 엔진

- 셸은 한 번만 실행된다. 다시 실행하면 기존 창을 앞으로 가져온다.
- 셸이 작업 엔진(`node app/src/server/main.ts --parent-stdin`)을 자식으로 띄운다. 출력의 실행 주소로 창을 연다. 종료 시 표준 입력을 닫아 엔진이 작업 기록을 정리하고 끝나게 한다(10초 뒤 강제 종료).
- 창의 외부 링크(웹사이트 등)는 기본 브라우저로 연다.
- 창 닫기: "백그라운드 유지"가 켜져 있으면 트레이로 숨기고, 꺼져 있으면 종료한다.
- 트레이 메뉴: 열기, 웹사이트에서 모든 프로젝트, 업데이트 상태, 종료.
- 자동 실행: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`의 `VIDE` 값(`"…\current\VIDE.exe" --background`). 창 없이 트레이로 시작한다.
- 설정 화면: 작업 화면의 설정에 "PC 프로그램" 절이 셸 안에서만 보인다(버전, 자동 실행, 백그라운드 유지, 업데이트). 화면과 셸은 WebView2 메시지로 통신하며 설정 파일은 `%LOCALAPPDATA%\VIDE\desktop.json`이다.
- 개발과 실무의 분리: 실무는 설치된 프로그램(기본 데이터, 포트 47821)을 쓰고, 개발 서버는 `npm run dev`(데이터 `.vide/dev-data`, 포트 47831)로 띄운다. 에이전트는 실무 엔진을 재시작하지 않는다.

## ② 업데이트

- **도구**: Velopack. 사용자 범위 설치, 관리자 권한 없음, 차등 패키지, 재시작 시 교체를 쓴다.
- **배포처**: 공개 저장소 `hongikarchi/VIDE`의 GitHub Releases(`releases.win.json`, 전체·차등 `.nupkg`, `VIDE.App-win-Setup.exe`). 2026-09-29 사용자 확인으로 `v0.2.1`을 게시했다. 게시는 `npm run desktop:release -- <버전>` 뒤 `dotnet vpk upload github --outputDir .vide/releases/installer --repoUrl https://github.com/hongikarchi/VIDE --token <gh 토큰> --publish --tag v<버전> --targetCommitish <전체 SHA>`로 한다(짧은 SHA는 거부됨). 시험과 개인 배포에는 폴더 배포처(`desktop.json`의 `updateSource` 또는 `VIDE_UPDATE_SOURCE`)를 쓴다.
- **흐름**: 시작 1분 뒤와 6시간마다 새 버전을 확인하고 백그라운드로 내려받는다. 준비되면 설정과 트레이에 "재시작하여 업데이트"를 표시한다. 누르면 엔진을 정상 종료하고 교체한 뒤 다시 실행한다. 누르지 않으면 다음 종료 때 적용한다. 재시작 때 엔진은 정상 종료 절차로 진행 중 작업을 중단 기록으로 남긴다.
- **무결성**: Velopack이 패키지의 SHA 해시를 확인한다. 서명 인증서가 생기면 `vpk pack`의 서명 옵션으로 실행 파일과 설치본을 서명한다.
- **되돌리기**: 문제가 있는 버전은 더 높은 버전 번호로 이전 코드를 다시 게시한다(Velopack은 설치된 앱의 하위 버전 자동 전환을 하지 않는다). 사용자 데이터는 버전과 무관하게 유지되며 DB 마이그레이션은 앞으로만 진행하므로, 스키마를 바꾸는 버전은 백업 후 적용한다(기존 `backup.mjs`).
- **호환**: PC 프로그램은 heartbeat에 자기 버전을 보낸다. 사이트는 최소 버전(`MIN_APP_VERSION`)보다 낮은 PC를 "업데이트 필요"로 표시하고 열기를 막는다. 사이트는 항상 최신이므로 PC와 주고받는 계약은 하위 호환으로만 바꾼다.
- **플러그인**: 프로그램이 새 플러그인을 포함하면 "연결 프로그램"에 "업데이트 있음"을 표시한다. Rhino가 켜져 있으면 설치하지 않고 종료 후 설치를 안내한다(새 버전은 새 폴더에 두고 등록 경로만 바꾼다).

## ③ 연결 프로그램

- Rhino 8(`HKLM\SOFTWARE\McNeel\Rhinoceros\8.0\Install`)을 찾고, 포함된 `VIDE.Worker.rhp`를 `%LOCALAPPDATA%\VIDE\plugins\rhino\<version>\`에 복사한다. Rhino 플러그인 등록 `HKCU\Software\McNeel\Rhinoceros\8.0\Plug-ins\6bde756c-…\PlugIn\FileName`을 그 경로로 바꾼다. 기존 등록(개발 빌드 경로)을 대체하므로 같은 플러그인이 두 번 로드되지 않는다.
- Rhino 실행 중에는 설치·업데이트를 막는다(종료 시 Rhino가 등록을 다시 쓰기 때문).
- ZWCAD·SketchUp·Revit은 같은 화면에 순서대로 추가한다(각각 NETLOAD 등록, `.rbz`, 버전별 Addins 폴더).

## 검증

- 셸: 설치본 설치 → 창 표시·엔진 시작 → 창 닫기(백그라운드/종료) → 자동 실행 등록·해제 → 재실행 시 기존 창 활성화 → 제거 후 사용자 데이터 보존.
- 업데이트: 폴더 배포처에 새 버전을 두고 확인 → 내려받기 → 재시작 적용 → 버전 변경과 데이터 유지.
- 연결 프로그램: 가짜 레지스트리·폴더로 단위 시험(설치·업데이트·Rhino 실행 중 거부), 실제 Rhino 8 로드 확인.

결과는 [PC 프로그램 검수](../tdd/VERIFY-2026-09-28-desktop-app.md). 이 PC의 새 버전 배포는 `npm run desktop:release -- <버전>`(새 파일은 먼저 git에 추가 — 패키지는 추적 파일만 담는다)이고, 설치된 프로그램이 이 폴더에서 업데이트를 받는다.

## 남은 일

- [ ] 코드 서명 인증서(예: Azure Trusted Signing, 월 약 10달러): 외부 배포 전 결정. 그때까지 미서명 설치본은 "추가 정보 → 실행"으로 설치.
- [x] 업데이트 파일의 첫 공개 게시: GitHub Releases `v0.2.1`(2026-09-29). 다른 PC는 Releases의 `VIDE.App-win-Setup.exe`로 설치하고 이후 자동 업데이트를 받는다.
- ZWCAD·SketchUp·Revit 연결 프로그램, macOS 미지원.
