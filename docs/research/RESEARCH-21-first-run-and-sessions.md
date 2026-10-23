---
id: RESEARCH-21
title: 첫 실행 설정 · 데스크톱 가입 · 세션 모형
status: review
version: 0.2
updated: 2026-10-23
owner: agent:claude
related: [PRD, SPEC-02, SPEC-05, RESEARCH-18, ADR-021, ADR-025, ADR-039, PLAN-38]
---

# RESEARCH-21 — 첫 실행 설정 · 데스크톱 가입 · 세션 모형

조사일 2026-10-23. 근거는 표의 [C*](저장소 경로:줄)와 [U*](URL)이며 목록은 §8에 있다. 선택은 사용자가 한다(VIDE Next 브리프 7판).

## 1. 질문

1. 로그인 뒤·시작 전에 설정 튜토리얼(AI 계정·CLI·AccountSwitch·디자인 프로그램·확장)을 둘 수 있나. 순서는 §6.
2. 로그인 화면의 AccountSwitch는 빼도 되나. 가입을 웹이 아니라 데스크톱에서 할 수 있나.
3. "첫 요청 때 모델 고정"을 "제공자 고정, 모델·effort 가변"으로 바꿀 수 있나. 여러 세션은 어떤 UI로 관리하나.
4. 새 세션 첫 화면을 단순한 입력칸으로 두고 제공자를 고르거나 자동 라우팅하게 할 수 있나.
5. 사용자 성향(AI 처음 / AI 좀 씀 / 개발자)에 맞춰 흐름·UI 기본값을 다르게 할 수 있나.

## 2. 현행 사실

| 항목 | 사실 | 근거 |
|---|---|---|
| 첫 실행 | sign-in → project 두 단계 | [C1] |
| 로그인 칸 | 아이디·비밀번호·PC 이름(비우면 'VIDE PC') | [C2][C3] |
| 로그인 경로 | 엔진→device/login, forwardAuth가 Origin을 붙임 | [C3][C4][C20] |
| 가입 | 웹사이트 링크로 넘김 | [C5] |
| AI 줄 | 설치 안 됨·로그인 필요·이메일, sign-in·project 두 단계 모두 | [C6][C8][C9][C29] |
| CLI 감지 | 설정→ENV, Claude: 네이티브→npm, Codex: npm→네이티브, 끝에 PATH | [C7] |
| CLI 설치 기능 | 없음(빌드 안내문 1줄) | [C10] |
| AccountSwitch | exe 유무 감지·detached 실행 | [C11][C13] |
| AccountSwitch 받기 | releases/latest 링크만 | [C12][C14] |
| 플러그인 등록 | 설치 훅은 등록 안 함, 설정 → 연결 프로그램에서 엔진 API→HKCU. restoreInstalledPlugin은 시험 도우미 | [C15][C16][C17] |
| Rhino 등록 | 꺼져 있을 때만, 켜짐이면 HOST_RUNNING 409 | [C16][C30] |
| 호스트 감지 | Rhino 8·ZWCAD 2023만 | [C18] |
| 가입 관문 | SIGNUP_CODE·ID 계정·메일 없음 | [C19] |
| 가입 Origin | AUTH_ORIGIN 아니면 403(브라우저 CSRF 방어) | [C20] |
| 사이트 가입 UI | 아이디·비밀번호·가입 코드 | [C21] |
| 대화 탭 줄 | SCR-15 칩, [+] 새 대화, 상태 ●·◌·'대기 n', 닫기 | [C24] |
| 대화 고정 | 첫 턴 provider·model 고정, effort만 턴마다, 다른 model도 새 대화로 인계 | [C22] |
| provider 다름 | CONVERSATION_PROVIDER 409, UI는 새 대화로 인계 | [C23][C24] |
| 턴 실행 | 턴마다 CLI 1회. Claude --resume/--session-id·--disable-slash-commands, Codex exec resume | [C31][C32] |
| 모델 라우터 | '자동' 항목, Jev task 4×domain 2 | [C25] |
| 라우터 선택 | geometry 편집→GPT, 조회·data→Claude. 키 없음·HTTP 실패·신뢰도 0.5 미만 → fallback | [C25] |
| 호스트 빌드 | ZWCAD net48(WebView2·Roslyn 포함) · Rhino net8 | [C26][C27] |
| 지원표 | rhino.md·zwcad.md 둘 | [C28] |

## 3. 가능성

판정 값: 됨 = 지금 코드로 가능 · 부분 = 일부만 됨 · 코드 필요 = 근거 있는 길이 있고 구현이 없음 · 외부 조건 = VIDE 밖 조건에 달림 · 측정 필요 = 근거 없음 · 비권장 = 가능하나 정책상 권하지 않음.

| 단계 | 판정 | 사실 | 근거 |
|---|---|---|---|
| 계정(구독) 유무 | 부분 | CLI 설치·로그인만 감지, 구독 유무는 ①에서 사용자에게 묻기 | [C8][C9] |
| Claude Code 설치 | 코드 필요 | 네이티브(irm 1줄·winget, Node 불필요) 우선. npm은 Node 22+ 권장(낮으면 EBADENGINE 경고) | [U1] |
| Claude Code 요금제 | 외부 조건 | Pro·Max·Team·Enterprise·Console, 관리자 불필요 | [U1] |
| Claude Code 로그인 확인 | 됨 | auth status 종료 코드 0/1 | [U2][C9] |
| Codex 설치 | 코드 필요 | npm -g 또는 install.ps1(공식 명령이 -ExecutionPolicy ByPass) | [U4] |
| Codex 요금제·API 키 | 외부 조건 | 문서 확인 필요 | [U4] |
| VIDE가 설치 실행 | 코드 필요 | PowerShell, per-user | [C10][C15] |
| 실행 정책·백신 | 외부 조건 | 정책은 공식 명령이 우회, 백신 차단은 측정 필요 | [U4] |
| AccountSwitch 설치 | 코드 필요 | 다운로드 링크만, 설치기 종류 측정 필요 | [C12] |
| AccountSwitch 필수 | 부분 | 계정 1개면 claude auth login·codex login으로 충분 | [U2][C10] |
| 로그인 화면 AccountSwitch 제거 | 됨 | AiLine 한 곳. 다른 진입(계정 표시·팝오버)은 남음 | [C29] |
| Rhino 8 감지 | 됨 | HKLM 8.0\Install | [C18][U10] |
| ZWCAD 감지 | 부분 | 2023 키만, 2025+ 측정 필요 | [C18][U13] |
| AutoCAD 감지 | 측정 필요 | HKLM\SOFTWARE\Autodesk\AutoCAD 키 + .bundle | [U12] |
| Revit 감지 | 코드 필요 | .addin 위치 문서 있음, 키 측정 필요 | [U14] |
| SketchUp 감지 | 측정 필요 | .rbz, 경로 | [U15] |
| Blender 감지 | 측정 필요 | 기본 폴더 | [U16] |
| ZWCAD↔AutoCAD 소스 | 측정 필요 | 대부분 재사용 예상, VIDE 코드 컴파일 시험 필요. 근거는 비공식 사례뿐 | [U9][C26] |
| CAD 빌드 분기 | 코드 필요 | AutoCAD 2025+ .NET 8 / 2024 이하 net48 / ZWCAD net48 → 빌드 셋 | [U20][C26] |
| CAD 공식 대응표 | 측정 필요 | 문서 없음 | [U8] |
| 데스크톱 가입(웹 경로 그대로) | 비권장 | Origin 검사는 CSRF 장치, 엔진이 헤더를 넣으면 통과 | [C20] |
| 데스크톱 가입(새 경로) | 코드 필요 | device/sign-up, device/login처럼 forwardAuth가 Origin을 붙임 | [C4][C19][C20] |
| 가입 코드 UI | 코드 필요 | 사이트 UI 있음 | [C21] |
| Claude --resume + --effort(턴마다) | 됨 | 현행 코드가 턴마다 --effort | [C22][C31] |
| Claude --resume + --model(턴마다) | 측정 필요 | --model은 '현재 세션 모델'로만 문서화, 조합 미기재 → SPIKE | [U2][C31] |
| Codex exec resume + -m | 측정 필요 | 문서 있음: --model 'Override the configured model for this run' | [U5][C32] |
| Codex effort | 됨 | -c model_reasoning_effort 턴마다(코드), 공식 문서 확인 필요 | [C32] |
| 자동 라우팅 | 외부 조건 | Jev 키·api.typesafe.ai 필요. 없거나 실패면 complex·geometry → 로그인돼 있으면 GPT-6-Astra medium 우선 | [C25] |

## 4. 세션 모형

- **근거:** provider CLI 세션(transcript)은 다른 CLI가 이어 받지 못하고, VIDE는 다른 provider 턴을 409로 거절한다 [C23]. 모델·effort는 같은 CLI 안에서 턴마다 넘긴다(§3 'Claude --resume' 두 행·'Codex' 두 행). Claude 앱도 모델·effort를 바꾸면 다음 응답부터 적용한다 [U7].
- **VIDE 제안:** 세션 = 제공자 고정(Claude 또는 Codex). 모델·effort는 세션 안에서 그 제공자 것만 바꾼다. 다른 제공자는 새 세션과 인계(continueIn 유지) [C22]. 홈의 '자동' 칩은 라우터가 고른다 [C25]. 홈 꼴: 큰 입력칸 + 제안은 ChatGPT 홈 [U17], 입력 + 최근 목록은 Aside [U18].
- **바뀌는 점:** 2026-10-01 결정(ADR-021, "모델 바꾸면 새 탭")의 이유는 모델·제공자를 바꾸면 provider 세션과 프롬프트 캐시를 잃는다는 것이다. 새 안은 제공자만 고정하므로 같은 제공자 안 모델 변경 뒤 한 턴은 대화 전체를 캐시 없이 다시 읽는다. effort 변경은 Opus 5.5·Sonnet 5.5·Haiku 5.5·Fable 5.1(API 키·구독)에서 캐시를 유지한다 [U19]. 현재 코드는 같은 제공자의 다른 모델도 새 대화로 옮긴다(sameAi) [C22].
- **수정 대상:** ADR-021 날짜 개정 + SPEC-02.19(고정 대상을 provider로, 모델·effort를 턴마다 바꾸는 규칙과 인계 조건). 사용자 답 뒤에 고친다.
- **새 세션의 제공자(브리프 Q2):**

| 안 | 고르는 사람 | 그냥 적는 사람 | 조건 |
|---|---|---|---|
| ① 홈 칩, 기본 자동 | 좋음(칩) | 좋음(자동) | 둘 다 있을 때만 칩 |
| ② 항상 고르기 | 좋음 | 나쁨(첫 요청 전 한 번 더) | 계정 1개면 의미 없음 |
| ③ 항상 자동 | 나쁨 | 좋음 | Jev 키 없으면 fallback 쏠림 |

Q2의 답은 '좀 씀·개발자'의 기본값이다. 'AI 처음'은 Q3 방식이 ③ 꼴(칩 숨김)로 덮어쓴다.

## 5. 세션 관리 UI 비교

| 축 | ① 탭 줄 + 홈 | ② 제목 드롭다운 | ③ 탐색기 묶음 | ④ VS Code식 매니저 |
|---|---|---|---|---|
| 전환 1클릭 | 좋음 | 나쁨(2클릭) | 보통(탐색기 열림 때) | 나쁨(2클릭) |
| 병렬 세션 가시성 | 좋음(3~4개 상시) | 나쁨(현재 1개) | 좋음(목록 전체) | 나쁨(열 때만) |
| 380px 적합 | 보통(제목 말줄임) | 좋음 | 해당 없음(패널 밖) | 나쁨(계정·필터 줄) |
| 비개발자 직관 | 보통(추정) | 나쁨(사용자 메모 3) | 보통(추정) | 나쁨(추정) |
| 구현 부담(제품 기준) | 좋음(SCR-15 탭 줄 있음, 홈 추가만) | 나쁨(제품 변경 필요) | 보통(탐색기 수정) | 나쁨(새 화면) |

**판단: ①.** 제품의 SCR-15 대화 탭 줄을 유지·확장하고 홈을 더한다 [C24]. 넘침 `…n`과 홈 `전체 ›`가 목록 장으로 간다. 근거: 사용자 메모 3.

**뒤집히는 조건.** 동시에 여는 세션이 늘 5개를 넘으면 ③, 계정·사용량·원격 세션을 한 곳에서 다뤄야 하면 ④를 다시 본다. 브리프 Q1은 ①~③만 묻는다(④는 380px·직관에서 탈락).

## 6. 방식 3종 기본값

| 기본값 | AI 처음 | AI 좀 씀 | 개발자 |
|---|---|---|---|
| 제공자·모델 선택 | 칩 숨김(자동) | 홈 칩 | 홈 칩 + 세션 안 모델·effort |
| 적용 전 확인 | 켬 | 켬 | 끔 |
| 터미널 탭 | 숨김 | 있음 | 있음(기본 열림) |
| 세션 탭 줄 | 탭 1개(넘침 없음) | 있음 | 있음 |
| 제안 카드 | 있음 | 있음 | 없음 |
| 말 | 쉬운 말 | 기본 | 내부 용어 허용 |

- **저장(제안):** 사용자 설정의 값 하나(방식)와, 그 방식이 정한 기본값 위에 사용자가 바꾼 항목만 따로 둔다. 저장 위치는 ARCH가 정한다. **바꾸는 길(제안):** 설정 화면에서 방식을 다시 고르면 기본값만 바뀌고, 사용자가 바꾼 항목은 남는다.
- **첫 실행 순서(정본):** 로그인/가입 → ① AI 계정(계정 유무 → CLI 감지·설치 → AccountSwitch 로그인) → ② 프로그램(감지 → 고르기 → 확장 설치) → ③ 방식 → 시작. 현재 첫 실행은 [C1] 두 단계다.
- **방식 단계(브리프 Q3):** ① 넣는다 = 첫 실행이 한 단계 길어지나 기본값 차이를 처음에 보여 준다. ② 뺀다 = 첫 실행이 짧으나 모두 '좀 씀' 기본값으로 시작해 'AI 처음' 사용자에게 칩·터미널이 보인다. 어느 쪽이든 설정에서 바꾼다.

## 7. PRD/SPEC으로 갈 것

- OQ 후보 · 가입 코드 배포 방식: 소유자가 코드를 어떻게 나눠 줄지(데스크톱 가입 화면이 받는 값) [C19].
- OQ 후보 · 설치 대행 권한: VIDE가 CLI·AccountSwitch 설치 명령을 사용자 대신 실행해도 되는지 [U1][U4]. AccountSwitch 필수 여부(계정 1개면 CLI 로그인으로 충분) 포함.
- OQ 후보 · 방식 3종의 이름: 'AI 처음 / AI 좀 씀 / 개발자'를 화면 낱말로 쓸지.
- OQ 후보 · Jev 키 없는 PC의 '자동': fallback이 Codex 우선이므로 기본 제공자(예: Claude)를 따로 둘지 [C25].
- 세션 모형은 ADR-021 날짜 개정·SPEC-02.19, 첫 실행 설정은 SPEC-05·PLAN-38, 데스크톱 가입은 ADR-039 갱신으로 간다.

## 8. 근거

- [C1] `src/ui/first-run.tsx:12, 287, 301` · [C2] `src/ui/first-run.tsx:104, 143-144, 154, 174` · [C3] `src/ui/first-run.tsx:2-3, 113-118`; `src/server/remote-access.ts:284-299` · [C4] `src/sharing/hosts.ts:124-158` · [C5] `src/ui/first-run.tsx:185-189`; `src/ui/remote-panel.ts:9` · [C6] `src/ui/first-run.tsx:37-74`
- [C7] `src/ai/paths.ts:5-7, 33-88` · [C8] `src/server/server.ts:2673-2692` · [C9] `src/server/server.ts:2695-2702, 3094-3100`; `src/ui/first-run.tsx:14-23` · [C10] `src/desktop/build.mjs:220-226` · [C11] `src/ai/account-switch.ts:14-27` · [C12] `src/ai/account-switch.ts:9-10`; `src/ui/account-switch-link.ts:7-8, 21-27`
- [C13] `src/ai/account-switch.ts:6-8, 34-41`; `src/server/server.ts:2705-2708` · [C14] `src/ui/first-run.tsx:76-96` · [C15] `src/desktop/shell/Program.cs:19-25`; `src/desktop/build.mjs:220, 226, 267` · [C16] `src/server/connectors.ts:14-20, 171-188, 240-265`; `src/server/server.ts:1446-1455` · [C17] `tests/integration/installed-connector.mjs:48-71` · [C18] `src/server/connectors.ts:15, 18, 41, 53-60, 123-129, 208`
- [C19] `src/sharing/accounts.ts:72-81, 96-98` · [C20] `src/sharing/accounts.ts:20-32, 63-64`; `src/sharing/auth.ts:54` · [C21] `src/sharing/web/account.tsx:5, 21, 75` · [C22] `src/server/conversations.ts:1-11, 440-442, 853-869, 920-955, 968` · [C23] `src/server/conversations.ts:121, 1143` · [C24] `src/ui/conversations.tsx:7-13, 111, 349-352, 557-569`
- [C25] `src/ai/model-router.ts:1-43, 63-93, 146-215, 249-276` · [C26] `hosts/zwcad/connection/VIDE.Zwcad.Connection.csproj:3, 6, 16-26`; `hosts/zwcad/worker/VIDE.Zwcad.Worker.csproj:3, 6, 14-15` · [C27] `hosts/rhino/worker/VIDE.Worker.csproj:3, 16-24` · [C28] `docs/specs/hosts/rhino.md`, `docs/specs/hosts/zwcad.md` · [C29] `src/ui/first-run.tsx:321`; `src/ui/account-indicator.ts:62`; `src/ui/account-popover.ts:26` · [C30] `src/server/server.ts:367`; `src/server/connectors.ts:245`
- [C31] `src/ai/claude-cli.ts:405, 428, 855-856` · [C32] `src/ai/codex-cli.ts:118-127, 149, 425-426`
- [U1] https://code.claude.com/docs/en/setup · [U2] https://code.claude.com/docs/en/cli-reference · [U4] https://github.com/openai/codex · [U5] https://learn.chatgpt.com/docs/developer-commands · [U7] https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings
- [U8] https://www.zwsoft.com/support/zwcad-devdoc · [U9] (비공식 사례, ZWSOFT 게재 리뷰) https://www.zwsoft.com/zwcad/expert-review/zwcad-great-compatibility-easy-online-workflow-and-impressive-net-api · [U10] https://developer.rhino3d.com/guides/cpp/finding-rhino-installation-folder/ · [U12] https://help.autodesk.com/cloudhelp/2027/ENU/AutoCAD-Customization/files/GUID-40F5E92C-37D8-4D54-9497-CD9F0659F9BB.htm
- [U13] https://www.zwsoft.com/user-guide/guide-to-uninstall-zwcad · [U14] https://help.autodesk.com/cloudhelp/2024/PTB/Revit-API/files/Revit_API_Developers_Guide/Introduction/Add_In_Integration/Revit_API_Revit_API_Developers_Guide_Introduction_Add_In_Integration_Add_in_Registration_html.html · [U15] https://help.sketchup.com/en/extension-warehouse/installing-trial-extension · [U16] https://docs.blender.org/manual/en/latest/advanced/blender_directory_layout.html
- [U17] https://help.openai.com/en/articles/9125172-the-chatgpt-home-page · [U18] https://aside.com/ · [U19] https://code.claude.com/docs/en/prompt-caching · [U20] https://blog.autodesk.io/multi-targeting-autocad-net-plugin-for-net-48-and-net-80/
