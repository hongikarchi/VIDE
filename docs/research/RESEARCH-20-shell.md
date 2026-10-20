---
id: RESEARCH-20
title: 셸 — 자체 · VS Code 포크 · 확장
status: review
version: 0.1
updated: 2026-10-20
owner: agent:claude
related: [PRD, RESEARCH-18, ARCH-01, ADR-039]
---

# RESEARCH-20 — 셸: 자체 · VS Code 포크 · 확장

조사일 2026-10-20. 근거는 저장소 코드 경로와 아래 URL이다. 선택은 사용자가 한다(브리프 5판 Q3).

## 1. 질문

VIDE를 만들 때 Kiro·Cursor처럼 VS Code(Code OSS)를 포크할지, VS Code의 개념(탐색기·가운데 창·에이전트·터미널 배치)만 가져와 지금의 자체 셸 위에 새 구조를 그릴지. 세 번째 길은 VS Code 확장으로 VIDE를 얹는 것이다.

## 2. 지금 셸의 사실

| 층 | 사실 | 근거 |
|---|---|---|
| PC 창 | .NET Framework 4.8 WinForms `VIDE.exe`, 패키지는 WebView2·Velopack 둘 | `src/desktop/shell/VIDE.Desktop.csproj:2-6, 23-24` |
| 창 내용 | 브라우저 UI(주소창 등) 없는 WebView2 하나(Dock=Fill)가 엔진의 작업 화면 URL로 이동 | `src/desktop/shell/ShellForm.cs:12, 16, 64-66, 172-188` |
| 창↔웹 | `PostWebMessageAsJson`으로 상태 교환, 렌더 프로세스가 죽으면 다시 불러옴 | `src/desktop/shell/ShellForm.cs:120-142, 201, 257` |
| 셸 규모 | C# 10개 파일 약 1,290줄(창·엔진 기동·트레이·갱신·폴더 선택·덤프) | `src/desktop/shell/*.cs` |
| 엔진 | 동봉 `node.exe`로 `src/server/main.ts`를 자식 프로세스로 기동, 포트 47821(설치)·47831(개발) | `src/desktop/shell/Engine.cs:29-31, 46`; `src/server/main.ts:13-16, 72` |
| 웹 UI | `src/ui/index.html` 한 장 → `main.tsx`가 React 셸(`shell/Shell.tsx`)을 그린 뒤 `.ts` DOM 화면 코드(`app.ts`)를 붙인다. 둘이 섞여 있음(`src/ui` 전체 `.tsx` 120 · `.ts` 104, 2026-10-20) | `src/ui/main.tsx:16-22`; `src/ui/remote-panel.ts:178`; `package.json:78-80, 95` |
| 호스트 브리지 | `hosts/rhino`·`hosts/zwcad`(TS 클라이언트 + C# 워커)와 `hosts/common` | `hosts/common/transport.ts`; `hosts/*/worker-client.ts` |
| 설치·갱신 | Velopack 설치본(Node v24 런타임·호스트 워커 동봉), 이 PC `%LOCALAPPDATA%/VIDE.App/current` 약 349 MB(VIDE.App 전체 약 464 MB, 2026-10-20 du), 백그라운드 내려받기 후 재시작·종료 때 적용 | `src/desktop/build.mjs:15-59, 217, 274`; `src/desktop/shell/Updater.cs:10, 34` |
| 사이트 | 사이트(`SITE_ORIGIN`)는 Cloudflare Workers 별도 배포. 앱은 엔진을 통해 로그인(비밀번호 1회)·공유 프로젝트 목록·원격 하트비트·공유 노트 소켓으로 사이트와 직접 주고받고, 가입만 사이트 링크 | `src/ui/first-run.tsx:2-3, 116, 186, 206`; `src/server/remote-access.ts:18`; `src/server/shared-notes.ts`; `src/ui/notes-tab.tsx`; ADR-039 |
| VS Code 관계 | 셸·UI 어디에도 Code OSS·Electron·Monaco 의존 없음 | `package.json` 의존성, csproj |

정리: 지금 VIDE는 VS Code와 무관한 자체 셸이다. 화면 배치는 웹 UI가 전부 정한다.

## 3. 세 길 비교

| 축 | ① 자체 셸 · 개념만 | ② VS Code 포크 | ③ VS Code 확장 |
|---|---|---|---|
| 가운데 아티팩트 창 자유도 | 전부 자유(웹 UI가 배치) | 자유(소스 수정) | 편집기 탭·사이드바 웹뷰 안은 자유, VS Code 바깥 배치(레일·탐색기)는 바꿀 수 없음 [U1][U2] |
| 터미널·편집기 품질 | 직접 구현(지금 없음) | 그대로 얻음 | 그대로 얻음 |
| 호스트 브리지 | 지금 것 그대로 | 엔진 프로세스 동봉 또는 확장 호스트로 이식(측정 필요) | 엔진 프로세스 동봉 또는 확장 호스트로 이식(측정 필요) |
| 설치 크기·갱신 | current 약 349 MB · Velopack | VS Code 본체 <500 MB [U3] + 엔진·워커 동봉 · 자체 갱신 | VS Code 설치 전제 · 마켓 갱신 |
| 빌드·유지 부담 | 셸 약 1,290줄 | 업스트림 병합 상시 [U4][U5] | VS Code API 변화만 |
| 확장 생태계 | 없음(직접) | MS 마켓 불가 → Open VSX [U6][U7] | MS 마켓 그대로 |
| 한국어 UI | 직접 문자열 관리(목업 `data-ko`/`data-en`) | 언어 팩 체계(`ko` 있음) [U14], 포크에서 Open VSX 언어 팩 여부 확인 필요 | VS Code 메뉴는 언어 팩 [U14], 확장 웹뷰 글자는 확장이 직접 번역(`vscode.l10n`) [U15] |
| 라이선스 | 자체 코드 | Code OSS MIT, 상표·키 없음 [U8] | 제품 VS Code MS 약관 [U9] |
| 택한 곳과 이유 | VIDE 지금 | Cursor: 확장으론 UI 제어 불가 [U10]. Kiro·Windsurf: 확인한 문서에 이유 없음 [U12][U13] | Copilot류 보조 기능 |

추가 사실.

- Microsoft C/C++ 확장은 2025-04(v1.24.5)부터 포크에서 작동하지 않는다. Pylance 등은 그 이전부터 막혀 있었다 [U11].
- Cursor는 2025-06-25 확장 목록을 Open VSX로 옮기고 인기 확장을 자체 퍼블리셔로 다시 냈다 [U7].
- Kiro는 Code OSS 기반이고 Open VSX 확장을 쓴다. 2026-07에 1.108.2로 올렸다. 1.0.242부터 에이전트가 IDE 표시 언어로 답한다 [U12].
- Windsurf(현 Devin Desktop)는 Open VSX 미러를 기본 확장 출처로 쓴다(갤러리 `marketplace.windsurf.com/vscode/gallery`) [U13]. 같은 회사의 시작 문서는 "마켓플레이스로 확장을 설치할 수 없다"고 써서 문서 간 서술이 엇갈린다(https://docs.devin.ai/desktop/getting-started).
- VS Code 최근 두 판이 1주 간격이다(1.141 = 10-07, 1.142 = 10-14, 추론) [U5]. [U4](2025-12)는 월간 릴리스라고 쓴다. 어느 쪽이든 포크는 판마다 병합해야 한다.
- Eclipse 쪽은 포크 대신 Theia + Open VSX를 대안으로 든다 [U4].

근거 URL.

- [U1] https://code.visualstudio.com/api/extension-capabilities/overview
- [U2] https://code.visualstudio.com/api/ux-guidelines/webviews
- [U3] https://code.visualstudio.com/docs/supporting/requirements
- [U4] https://blogs.eclipse.org/post/thomas-froment/why-cursor-windsurf-and-co-fork-vs-code-shouldnt
- [U5] https://code.visualstudio.com/updates
- [U6] https://aka.ms/vsmarketplace-ToU (Marketplace and NuGet.org Terms of Use 2025-09판 §1(b) In-Scope Products: Visual Studio·VS Code·Codespaces·Azure DevOps. 링크는 PDF로 리디렉트)
- [U7] https://forum.cursor.com/t/extension-marketplace-changes-transition-to-openvsx/109138
- [U8] https://github.com/microsoft/vscode/wiki/Differences-between-the-repository-and-Visual-Studio-Code
- [U9] https://code.visualstudio.com/license
- [U10] https://forum.cursor.com/t/why-is-cursor-not-an-extension-to-vs-code/2523/3
- [U11] https://www.theregister.com/software/2025/04/24/microsoft-subtracts-c/c-extension-from-vs-code-forks/721912
- [U12] https://kiro.dev/faq/ · https://kiro.dev/changelog/ide/1-0-242/
- [U13] https://docs.devin.ai/desktop/advanced (docs.windsurf.com/windsurf/advanced에서 리디렉트)
- [U14] https://code.visualstudio.com/docs/configure/locales
- [U15] https://code.visualstudio.com/api/references/vscode-api (`l10n`)

## 4. 판단

**추천: ① 자체 셸, VS Code는 개념만.** VIDE의 가운데는 코드 편집기가 아니라 아티팩트·기록·호스트 모델이다. 이 배치(레일 묶음 다섯·탐색기 트리·가운데 아티팩트 창·UI 언어 전환)는 ①에서 가장 자유롭다. 설치·갱신·호스트 브리지도 이미 있다. ②는 편집기와 확장을 얻는 대신 병합 부담·Electron 설치·Open VSX 제약을 떠안는다. ③은 셸 배치를 바꿀 수 없어 VIDE 화면 구조와 맞지 않는다.

**뒤집히는 조건.**

- 코드 편집·디버깅과 확장 생태계가 VIDE의 중심 작업이 되면 ②가 낫다.
- 터미널·편집기를 직접 만드는 비용이 병합 비용보다 커지면 ②를 다시 본다. 이때는 Theia도 함께 본다.
- 건축 작업자가 이미 VS Code를 쓰고 VIDE를 보조 칸으로만 원하면 ③을 본다.

**브리프 Q3 대응(5판 기준).** 5판 Q3 ① = 이 문서의 ①(추천), ② = ②, ③ = ③. 4판 Q3(① 환경 분리 뒤 1주 실험 · ② 전용 앱 · ③ VS Code 확장)과 번호가 다르다: 4판 ② 전용 앱이 5판 ①이 된다. 사용자의 답이 나오면 ADR로 기록하고 이 문서 상태를 갱신한다.
