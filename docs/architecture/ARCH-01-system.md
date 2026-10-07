---
id: ARCH-01
title: VIDE 기술 구조와 구현 계약
status: review
version: 0.94
updated: 2026-10-07
owner: agent:codex
related: [ADR-033, PLAN-29, PLAN-31, ADR-032, SPEC-00, SPEC-02, SPEC-03, SPEC-04, SPEC-09, PLAN, PLAN-20, PLAN-24, ADR-014, ADR-015, ADR-016, ADR-017, ADR-021, ADR-022, ADR-025, ADR-027, ADR-028, ADR-029, ADR-030, PLAN-25, PLAN-26, PLAN-27, PLAN-28, ARCH-03, PLAN-30, ADR-035, PLAN-33, ADR-036, PLAN-34, ADR-034, PLAN-32, SPEC-10, ADR-037, PLAN-35, PLAN-36, ADR-039, PLAN-38, PLAN-39, PLAN-42, ADR-040, ADR-041, PLAN-43]
---

# VIDE 기술 구조와 구현 계약

이 문서는 구성요소 책임·스택·물리 저장/API·호스트 실행·공유 구조의 정본이다. 동작 의미는 SPEC, 작업 순서와 현재 상태는 PLAN, 선택 이유는 ADR, 조사 근거는 RESEARCH, 실측은 SPIKE/VERIFY가 소유한다. 설계된 구조가 모두 구현됐다는 뜻은 아니다.

## 1. 구조와 확정 스택

AI 구독 계정의 추가·로그인·로그아웃·제거·전환·자동 전환은 외부 프로그램 AccountSwitch가 맡는다([ADR-025](../decisions/ADR-025-accounts-in-accountswitch.md)). VIDE는 각 CLI의 기본 로그인만 쓰고 현재 계정과 사용량을 읽기만 한다(§7 「CLI 기본 로그인 실행 경계」). VIDE 안의 계정 관리 API·관리 프로필 주입은 [PLAN-25](../plans/PLAN-25-accounts-to-accountswitch.md) 2단계에서 빼는 중이며(2026-10-01) 이 문서의 계약이 아니다.

요청 실행 상한은 선택적 `executionLimits: { maxToolCalls, maxHostCommands, timeoutSeconds }`로 접수·저장한다. 정수 범위는 각각 1~100, 1~48, 30~600이며 미지정 이전 요청은 PLAN-02의 기존 기본값을 사용한다. 연계 요청의 도구 호출은 공유 라우터 전체 상한, 호스트 명령은 대상별 상한이다. CLI 응답 시간 제한은 공급자 실행에 전달하고 도구 capability 유효 시간은 해당 시간에 60초를 더하되 600초를 넘기지 않는다. 대기/호스트 기동과 이미 시작된 네이티브 연산의 안전한 종료 대기는 AI 응답 시간과 구분한다. 초안·개입·복원은 명시한 값을 보존하고 기존 요청의 상한을 소급 변경하지 않는다.

TypeScript·React·Vite·CSS와 Three.js, TypeScript·Node.js 로컬 제어 서버, C# 호스트 실행기를 사용한다(ADR-016·017). AI는 SDK 코드와 도구를 조합하고 VIDE가 대상·권한·기준·기록을 관리한다(ADR-014). Cloudflare 공유는 로컬 CAD 실행과 분리한다(ADR-015).

아래 공통 설계는 기존 마스터의 책임·계약을 옮긴 것이다. 실행·호스트·저장·공유의 상세 계약은 §2~6이 소유한다. 공통 설계의 제한 JSON·도구 없는 CLI는 호환 경로 설명에만 해당하며 신규 경로의 조건이 아니다. 계획 스키마/API는 이행 목표이며 실제 구현 여부는 PLAN §6.5에서 확인한다.

<a id="master-2"></a>

### 1.1 책임과 경계

- `src/core/`: 프로젝트 저장·버전 검사·명령 상태·대상 격리. 네트워크와 공급자에 독립된 순수 검증 및 저장 계층.
- `src/server/`: 127.0.0.1 제어 서버, 세션 인증, API, 이벤트·파일 제공. 정확한 Host·Origin 검사와 별도 호스트 인증을 적용한다.
- `src/ui/`: Design §12의 SCR을 구성하는 로컬 브라우저 화면. 표시 상태에서 권한을 추론하지 않는다.
- `src/ai/`: CLI 프로세스 관리·자료 허용 목록·구조화 결과 검증. 셸 문자열 대신 실행 파일과 인자 배열을 사용한다.
- `hosts/rhino/`, `hosts/zwcad/`: 네이티브 문서 식별·조회·바로 적용 실행(되돌리기 기록)·되돌리기·결과 확인(§4 「바로 적용 경로」). 호스트 UI/문서 실행 문맥에서만 쓰기.
- `src/sharing/`: 외부 게시본·검토 의견 서비스. 로컬 제어 API와 인증을 공유하지 않는다.
- `extensions/`: 신뢰된 작은 확장의 선언과 등록. `tests/`는 단위·계약·통합·UI·호스트 검수를 구분한다.

호스트가 원본, 로컬 DB가 작업 기록, 외부 서비스가 서버 확인 게시본을 각각 소유한다. AI 세션은 어느 정본도 대체하지 않는다.

<a id="master-2-1"></a>

#### 의존 방향과 폴더 책임

새 에이전트의 도구 호출은 VIDE의 권한·대상 확인을 거쳐 호스트에 도달한다. application/persistence는 책임 경계이며 폴더로 만들지 않았다(2026-10-01 현재 `src/` 아래 폴더는 `ai`·`contracts`·`core`·`desktop`·`jigs`·`native`·`server`·`sharing`·`ui`다). 현재 코드의 이행은 PLAN §6.5를 따른다.

```text
로컬 UI → 로컬 API → application → core / persistence
                           ├→ ai provider → VIDE 도구 → 대상·권한 검사
                           ├→ host transport → 호스트 어댑터 → 네이티브 문서
                           └→ publication client → 외부 review service
웹 UI → 외부 review API → 게시 자산 / 의견 저장
```

AI·웹·UI가 네이티브 명령 큐나 DB에 직접 쓰는 경로는 두지 않는다. application은 조건·권한·선후관계를 조합하며 core는 상태 전이와 식별·버전 규칙을 검사한다. 원본 변경은 호스트 어댑터가 소유하고, 성공 보고만으로 끝내지 않고 결과 확인 자료를 반환한다.

| 경로 | 책임 | 의존 제한 |
|---|---|---|
| `src/contracts/` | 요청/응답·이벤트·런타임 검증·표시 DTO | 프레임워크·SQLite·호스트 SDK 참조 없음 |
| `src/core/` | 순수 정책·상태 전이·의존성 검사, SQLite 저장소·마이그레이션(`store.ts`·`migrations.ts` 등) | HTTP·UI 참조 없음 |
| `src/server/` | 로컬 세션·API·이벤트·허용 자산, 실행 조율(`execution.ts`·`direct-mode.ts`·`sdk-execution.ts`·`zwcad-sdk-execution.ts`)과 경로 모듈(`jig-routes.ts`·`make-routes.ts`·`facts-routes.ts`·`conversations.ts`) | 업무 상태를 core와 중복 결정하지 않음 |
| `src/ui/` | shell, workspace, input, tasks, results, review, settings, 뷰포트(`viewport.ts`) | 공통 데이터 접근 계층(`gateway.ts`)으로만 읽기/행동; 직접 CLI 호출 없음 |
| `src/ai/` | Claude/Codex 실행·진행·취소·도구 호출, VIDE 지시 묶음(`instructions/`) | 제품 도구가 노출하는 범위 제한; 임의 코드의 OS 격리와 구분 |
| `src/jigs/` | jig 목록·Sync jig·구조 jig·자료(`catalog.ts`·`sync.ts`·`structure/`·`knowledge.ts`), jig 런타임(`runtime/`)·공식 라이브러리(`official/`)·Rhino에 만들기(`bake/`) | 물리 계약은 [ARCH-03](ARCH-03-jig-runtime.md) |
| `src/knowledge/` | 자료 정리 수집기(`collect/`: 목록·문서 추출·AI 단계·할 일·일정 후보) | §3 「자료 정리」 |
| `src/native/` | 구조 해석 Rust 코어(`structure/`, Node-API 애드온) | [ADR-019](../decisions/ADR-019-structure-jig-rust-core.md), ARCH-02 |
| `src/desktop/` | PC 프로그램 셸(`shell/`, WinForms·WebView2·Velopack)과 패키징·백업 스크립트 | §6 「PC 프로그램」 |
| `src/sharing/` | 독립 외부 API·게시본/의견 권한과 저장 포트 | 로컬 명령 큐/CLI 모듈을 배포 의존성에 포함하지 않음 |
| `hosts/<host>/` | 호스트 애드인(C#)과 Node 쪽 연결·전송 어댑터(`hosts/common/*.ts`, `hosts/rhino/*.ts`, `hosts/zwcad/*.ts`) | 서버 구현을 import하지 않음(§7) |
| `extensions/` | 허용 확장 선언·검수 샘플, 프로젝트 jig 소스(`extensions/jigs/`) | 공통 컨텍스트/결과 계약 사용 |

이전 계획의 `src/application/`(유스케이스)·`src/persistence/`(저장)·`src/viewer/`(뷰어)·`src/hosts/`(어댑터)는 만들지 않았다. 각 책임은 위 표의 `src/server/`·`src/core/`·`src/ui/`·`hosts/`가 맡는다. 새 폴더는 해당 티켓 착수 시 생성한다. 현재 `src/core/store.ts`를 한꺼번에 재작성하지 않고 유스케이스별로 포트를 추출한다. 화면별 프로젝트·대상·권한 저장소를 따로 만들지 않는다. 로컬/웹은 뷰어·표·핀·의견 표현을 재사용하되 명령 가능한 데이터 접근 계층을 분리한다.

<a id="master-2-2"></a>

#### 프런트 상태 소유

서버가 소유하는 프로젝트·기준·실행·후보·권한 상태와 UI의 선택·패널·카메라·편집 초안을 분리한다. URL/선택 변경이 실행 대상을 수정하지 않는다. 응답은 프로젝트 ID와 revision을 검사하고 이전 프로젝트의 늦은 응답을 현재 화면에 적용하지 않는다. 입력 저장은 응답 전 저장 중으로 표시한다. 원본 적용·게시·의견 접수는 낙관적 성공으로 표시하지 않는다.

화면 검토용 데이터는 같은 DTO와 행동 인터페이스를 구현하는 별도 scenario gateway로 공급한다. HTTP gateway와 앱 시작 시 한 번 선택하고 실패 시 자동으로 fixture로 전환하지 않는다. fixture 모드에서는 실제 호스트·AI·게시 요청이 발생하지 않는다. 개발 화면에 합성 자료 배지를 유지하고 실제 통합 검수와 구분한다.

#### 웹 화면 구조

T-113([PLAN-26](../plans/PLAN-26-chat-stage.md#t-113), 2026-10-02 사용자 승인)부터 작업 화면의 뼈대는 아래 층으로 나눈다. 요소 id·CSS 클래스·접근성 이름·localStorage 키·`body`/`html` 플래그는 화면 계약이라 층을 옮겨도 바꾸지 않는다.

| 경로 | 책임 | 제한 |
|---|---|---|
| `src/ui/main.tsx` | 글꼴 → 셸 루트(`#root`) 하나를 `flushSync`로 그린 뒤 `app/boot.ts`를 불러 실행 | StrictMode 없음(일회성 연결 토큰·WebGL·폴러가 두 번 생김). pagehide에 셸 루트를 언마운트하지 않음(뷰포트 해제가 먼저) |
| `src/ui/index.html` | `<head>`(CSP·스타일·진입 스크립트)와 `<div id="root" class="root">` | `.root{display:contents}`라 레이아웃은 루트가 없을 때와 같음 |
| `src/ui/shell/` | `Shell.tsx`가 지역 컴포넌트(모바일 탭·레일·왼쪽 패널·작업공간 탭·뷰포트 크롬·인스펙터·AI 열·작성기·상태 표시줄·토스트·설정 대화상자)를 DOM 순서대로 조립하고, 각 지역은 `store/` 조각을 `useStore`로 읽어 그림(T-113 지역 A~E) | 단추 동작은 셸이 `app/` 모듈을 불러오지 않도록 조각의 `actions`·`shell/viewport-actions.ts` 표를 거침(`boot.ts`의 `init*()`가 예전과 같은 시점에 채움). 명령형으로 남는 곳: `#canvas`(three.js), `#objects`(객체 목록 어댑터), `#display-settings` 팝오버, `#body`의 값·`disabled`(비제어 textarea, `pin-tokens.ts`가 같은 렌더 안에서 읽음), `#effort-menu` 열림, `#mode-status`·`#usage-bars`·`#status-account`의 자식, 설정 대화상자의 계정·사용량·연결 프로그램·PC 프로그램 절 내용, `#right`의 `hidden`(`togglePanel`), 자체 `createRoot`를 쓰는 `#project-heading`·`#host-document-controls`·패널 모드 머리·카드·작업공간 내용 탭·대화상자. 지역마다 `RegionBoundary`, AI 열의 옛 별도 루트 자리와 데이터로 그리는 부분(`#inspector-content` 내용, `#route-card` 내용, `#context` 칩, `#model` 선택지)마다 `PartBoundary`로 감싸 렌더 오류가 그 컨테이너만 비움(지역의 id는 남아 명령형 코드가 계속 동작). 실패한 지역은 어느 조각이든 다음 `bump()` 때(`subscribeAnySlice`), 부분은 자기 `reset` 값이 바뀔 때 다시 그림. `.workspace` 직계의 패널 너비 손잡이는 포털로 맨 끝에 둠 |
| `src/ui/store/` | `core.ts`(변경 가능한 조각 객체 + `version`·`bump`·`subscribe`, `useStore`는 `useSyncExternalStore`)와 소비 범위별 조각(`session`·`draft`·`work`·`selection`·`sketch`·`viewer`·`links`·`toast`, 지역 단계에서 더한 `layout`(레일·패널 접기·너비·모바일 보기)·`status`(설정 대화상자·상태 줄·연결 배너)) | 하나의 전역 객체로 모으지 않음. 카메라는 보기·투영이 바뀔 때만 넣고 프레임마다 넣지 않음. 조각은 DOM에 접근하지 않음(예외: `layout.ts`의 동작 함수가 CSS용 `body` 플래그(`data-mobile`·`*-hidden`)·너비 CSS 변수·포커스와 `#right`의 `hidden`을 씀) |
| `src/ui/app/` | 화면 명령형 코드의 지역 모듈: `context.ts`(패널 모드·현재 프로젝트), `boot.ts`(초기화 순서·연결·패널 모드·호스트 링크 폴링), `status.ts`(토스트·상태 줄·설정 열기), `left.ts`(레일·왼쪽 패널·패널 접기), `viewport.ts`(뷰포트·스케치·선택), `composer.ts`(작성기·전송·요청 판별), `thread.ts`(작업 보기·대화·제안 카드·요청 폴링), `links-sync.ts`(연결 파일 Sync·레이어 합성), `glue.ts`(jig·대시보드·검토본·skill 연결), `render.ts`(`render()`·`renderMessages()` 호출 순서), `shortcuts.ts`(단축키 등록부) | 모듈은 선언과 `init*()`만 내보내고 최상위 부작용을 두지 않음. `boot.ts`가 `init*()`를 정해진 순서로 부름. 지역 간 호출은 내보낸 함수(파사드) 이름으로 하고 시그니처는 추가만 허용 |

**큰 모델의 화면 경로(T-085·T-123, 2026-10-06).** 형상 응답(`GET …/requests/:r`·`…/delta`, VGT1)은 `decodeGeometry(…, {typed: true})`로 풀어 좌표를 응답 버퍼 위의 `Float32Array`(배열 첫 점 `origin`을 속성으로 붙인 float32 차이)로, 색인을 `Uint16Array`/`Uint32Array`로 둔다. 뷰포트(`src/ui/viewport.ts`)는 이 배열을 복사하지 않고 `BufferAttribute`로 올리며 `origin`을 물체 위치로 쓴다(`number[]`도 계속 받음). Live Sync 갱신은 바뀐·지운 객체가 든 그리기 묶음만 다시 만든다. 레이어에 보이지 않는 결과의 `scene`·`definitions`(표시 Sync는 `objects`도)는 메시지에서 지우고 다시 보일 때 받는다. Rhino·ZWCAD 패널 모드는 뷰포트를 만들지 않고 형상을 받지 않는다. 패널은 연결 목록의 Sync를 `GET …/requests/:r?view=summary`로 받고 객체 줄은 `…/objects`로 받아 객체 목록(선택 비추기·고정)을 만들며, Live Sync 변경분은 형상 없이(`…/delta?view=rows`) 받아 줄만 고친다. 화면 객체는 `objectById` 색인으로 찾는다. `api`는 시간 제한(형상 120초, 그 밖 읽기 30초, 넘으면 `NETWORK_TIMEOUT`, 쓰기 요청 10분, 넘으면 다시 묻지 않고 작업 이력을 보라는 `ACTION_TIMEOUT`)을 둔다. 작업 상태 확인(`?view=summary`)은 실패해도 간격을 늘려(10초까지) 약 10분 동안 계속하고, 그 뒤나 다시 물어도 같은 답(`NOT_FOUND`·`FORBIDDEN` 등)이면 멈춘다.

Node 시험이 직접 불러오는 화면 모듈(`reference-check.ts`·`conversations.tsx`·`connection-recovery.ts`)에는 DOM 부작용이나 JSX를 넣지 않는다. 아이콘은 `icons.ts`의 `paintIcons()`가 자식이 없는 `[data-icon]` 노드만 채운다.

<a id="master-3"></a>

### 1.2 확정 기술 스택

사용자가 2026-09-21에 **TypeScript + React + Vite + CSS, TypeScript + Node.js 로컬 제어 서버, C# 호스트 실행기**를 확정했다. 결정 기록은 [ADR-016](../decisions/ADR-016-typescript-react-vite.md)이다. 이 조합을 다시 후보 비교에 올리지 않는다. Node.js는 실행 환경이고 서버 작성 언어는 TypeScript다. 3D 라이브러리는 범용 엔진 비교와 Speckle·xeokit 코드/로컬 실행 분석 후 ADR-017에 따라 Three.js를 유지한다.

| 영역 | 확정 기준 | 이행 범위 |
|---|---|---|
| 화면 | TypeScript + React | 기존 디자인/CSS·동작을 보존하며 DOM 직접 갱신을 컴포넌트와 명시적 상태로 전환 |
| 개발·웹 빌드 | Vite | 개발 도구로 사용하고 제품에서는 빌드한 정적 자산을 로컬 서버/공유 서비스가 제공 |
| 스타일 | CSS | 기존 디자인 토큰·레이아웃 유지. UI 프레임워크 변경을 디자인 재작성으로 확대하지 않음 |
| 로컬 제어기 | TypeScript + Node.js | src/core·server·ai와 JavaScript 호스트 어댑터를 점진 이행. Node 24.21.0(2026-10-06, 24.0~24.15의 libuv 1.51 루프백 연결 결함으로 엔진이 `0xC0000409`로 끝나 24.16 이상으로 올림, PLAN-28 T-125) |
| 네이티브 실행 | C# + 설치 호스트 공식 SDK | Rhino/ZWCAD의 SDK·런타임 차이는 별도 검증 |
| 로컬 저장 | SQLite | 기존 데이터·스키마·백업 유지. 언어 전환만을 이유로 DB 이행하지 않음 |
| 외부 공유 | Cloudflare 계획 유지 | Workers는 로컬 Node 프로세스 실행 경로와 분리. 공유 계약/화면만 재사용 |
| 3D 표시 | Three.js 0.186.0 유지 (ADR-017) | TypeScript 어댑터·React 수명 통합, 부분 갱신·선택 경계 정리 |

TypeScript/React/Vite의 구체 버전은 전환 시작 때 기존 Node·브라우저·빌드 호환성을 확인해 package-lock으로 고정한다. 특정 최신 버전 채택을 위해 Node를 자동 교체하지 않는다. 런타임 입력 검증은 타입 검사와 함께 유지하며, 외부 JSON을 타입 단언만으로 신뢰하지 않는다.

로컬 UI는 브라우저에서 제공한다. 3D 표시 라이브러리의 선정 근거와 실험 한계는 ADR-017·뷰포트 SPIKE를 따른다. Windows 데스크톱 래퍼는 설치·프로세스 수명 검증 결과에 따라 추가할 수 있다. 자체 CAD 커널을 구현하지 않는다.

호스트 애드인은 C#과 설치된 SDK를 사용한다. Rhino 8.34는 .NET 8 경로를 우선 시험하고 ZWCAD 2023은 해당 설치본의 관리 DLL·런타임과 호환되는 빌드를 별도로 시험한다. SDK DLL을 앱 배포물에 임의 복사하지 않는다. 공통 계층까지 특정 호스트 런타임으로 묶는 대안은 두 호스트의 로딩 조건 차이 때문에 채택하지 않는다.

AI 경계 선택은 [ADR-013](../decisions/ADR-013-local-coordinator-cli.md), 실제 연결 증거는 [CLI 실험](../tdd/SPIKE-2026-09-19-ai-execution-path.md)이다. 사용자에게 API 키를 먼저 요구하지 않는다.

<a id="master-3-1"></a>

#### 기술 선택 근거

현재 선택은 ADR-014·015·016·017을 따른다. 초기 스택 판단은 이행 기록에 보존한다.

<a id="master-3-2"></a>

#### 선행 사례 조사와 선택 근거

사용자 요청에 따라 Aside·Vino·FigCAD·논현동 규모검토·Speckle·food4Rhino AI 도구를 조사했다. 근거·적용/비채택 이유·공급자 공식 인증 경로·비교 시험은 [PLAN-01](../research/RESEARCH-01-reference.md)이 소유한다. 이는 §3의 분리 문서이며 별도 제품 범위나 진행 현황표가 아니다.

현재 방향은 §3의 확정 TypeScript/React/Vite 스택으로 전환하면서 Node/SQLite 실행 제어를 유지하고, 3D 라이브러리만 PLAN-01 §9에서 비교하는 것이다. 공식 CLI 어댑터와 제품 문맥 기록은 분리한다. 공개 자료의 기능 설명과 코드 확인은 실제 지원 검증과 구분한다. 라이브러리 설치·버전 확정·직접 코드 이식은 해당 티켓의 검증 뒤에 한다.

<a id="master-3-3"></a>

#### 전환 기록 참조

전환 절차는 [이행 기록](../tdd/VERIFY-2026-09-20-implementation-history.md)에 보존한다. 현재 완료·미완료는 PLAN §6.5에서 확인한다.

<a id="master-3-4"></a>

#### 이후 모든 개발에 적용할 기술 기준

이 절은 전환 완료 후에도 유효한 구현 기준이다. §3.3은 일회성 이행 순서이며, 스택 결정의 근거는 ADR-016이다. 새 티켓을 시작할 때 이 절과 해당 기능 계약을 함께 확인한다.

| 영역 | 코드 작성·책임 기준 |
|---|---|
| 웹 화면 src/ui | React 함수 컴포넌트는 .tsx, 화면 외 로직은 .ts. CSS는 기존 디자인 토큰과 책임별 스타일을 사용한다. 컴포넌트는 표시·사용자 입력을 담당하고 DB·CLI·호스트 SDK를 직접 호출하지 않는다. |
| UI 상태 | 서버의 작업/저장 상태, UI의 초안/선택 상태, 뷰포트의 카메라/렌더 상태를 구별한다. 공유 상태는 실제 소비 범위에 두고 모든 상태를 하나의 전역 객체에 몰지 않는다. 프레임마다 바뀌는 카메라/포인터 값을 React 전체 화면의 상태 갱신으로 전파하지 않는다. |
| 뷰포트 | 로딩·선택·카메라·입력 표시·해제를 담당하는 어댑터를 둔다. 렌더러 객체는 내부에만 두고 UI/저장/API에는 문서·객체 참조와 수치 DTO를 전달한다. listener·GPU 자원·비동기 로딩의 해제 책임을 명시한다. 엔진 선정은 PLAN-01 §9를 따른다. |
| 공통 계약 src/contracts | UI와 서버가 공유하는 직렬화 가능한 DTO·경계 검증 원본만 둔다. 외부 HTTP·CLI·호스트·저장 데이터는 런타임 검증하며 타입 단언으로 검증을 대체하지 않는다. 브라우저 번들에 Node/DB/비밀 설정 의존성이 들어가지 않게 한다. |
| 로컬 core/server/ai | TypeScript ESM으로 작성하고 Node.js에서 실행한다. HTTP는 인증·검증·서비스 호출, 서비스/코어는 업무 규칙, 저장·AI·호스트 어댑터는 외부 I/O를 담당한다. React에서 업무 규칙을 별도로 재구현하지 않는다. |
| 네이티브 hosts | C#은 해당 호스트 SDK 접근·문서 문맥 실행·결과 취득을 맡는다. 호스트별 런타임과 빌드를 구별한다. Node 어댑터는 TypeScript로 작성한다. |
| Cloudflare 공유 | 새 서비스 코드는 TypeScript로 작성하되 Workers 런타임용 설정을 분리한다. Node의 로컬 프로세스 실행 코드를 공유 서버로 가져오지 않는다. 계정·권한·게시의 물리 계약은 이 문서 §6, 동작 의미는 SPEC-04를 따른다. |

**.mjs 예외:** 제품 런타임의 전환은 끝났다(§3.3 전환 상태). 문서 렌더러·패키징/백업 스크립트·테스트·실험 스크립트는 .mjs를 유지하며 일괄 변환하지 않는다. 제품 모듈은 .ts/.tsx로만 추가한다.

**품질과 일관성:** 새 TS/TSX는 strict 타입 검사를 적용한다. 외부 미확인 값은 unknown에서 검증하여 좁히고 any·ts-ignore로 오류를 일괄 숨기지 않는다. 파일은 책임/변경 이유로 나누며 줄 수만 맞추는 분할이나 거대한 공용 utils를 만들지 않는다. 오류는 안정된 코드로 처리하고 비밀 값은 로그·브라우저 번들에 포함하지 않는다.

**자동 검증으로 연결:** 전환 2단계에서 웹/서버 타입 검사와 웹/서버 빌드를 독립 명령으로 구성하고 브라우저의 Node 전용 import를 차단한다. 각 기능 변경은 해당 계약·실패 경로 테스트를 수행하며 화면 변경은 실제 브라우저에서 확인한다. 패키징 변경은 개발 도구 없는 실행을 확인한다. 타입 검사·빌드·필요 테스트가 통과한 기능 묶음별로 커밋한다. 타입 검사(`npm run typecheck`)·웹/서버 빌드 명령은 구현되어 제품 런타임 전체에 통과하고, 코드가 바뀐 커밋에서는 커밋 훅(`tools/checks/commit.mjs`)이 강제한다(§7). 별도 PC 배포 검증은 T-011에 남아 있다.

새 전역 상태 라이브러리·UI 프레임워크·서버 프레임워크를 기능마다 추가하지 않는다. 기존 기준으로 해결하기 어려운 구체 증거가 있을 때 영향/비용을 기록하고 채택한다. 결정 변경은 ADR과 이 절을 함께 갱신하고 일회성 우회를 영구 기준으로 남기지 않는다.

<a id="master-4"></a>

### 1.3 공통 저장·API 계약

식별자는 무작위 UUID 문자열이다. `projectId`, `connectionId`, `documentId`, `objectId`, `runId`, `commandId`는 구별하며 네이티브 객체 ID는 연결·문서 범위 안에서만 사용한다. 경로는 표시 속성이지 식별자가 아니다. 실행의 `targets`는 복수 연결을 담고 각 명령의 `connectionId`는 단일 대상이다.

SQLite는 외래 키와 WAL, synchronous FULL을 사용한다. 첫 스키마는 프로젝트, 입력 기록(JSON·revision), 연결, 실행(조건 revision·targets), 명령(payload·상태·result)이다. 입력 수정은 프로젝트와 기대 revision을 검사한다. 명령 ID와 직렬화된 내용의 일치로 멱등 요청을 판정한다. 명령 큐의 queued→running 변경은 전달 전에 저장하고, 재시작 시 running은 unknown으로 전환하고 이전 연결은 오프라인, 미전송 명령은 취소로 바꾼다. 연결이 새로 확인되기 전 이전 큐를 보내지 않는다. unknown이 있는 문서는 신규 쓰기를 막는다. 다른 문서의 쓰기는 계속할 수 있다. unknown을 단순 재시도로 해소하는 API는 두지 않는다.

HTTP 계약은 `/api/v1/`에서 시작한다. 요청에는 프로젝트·대상·기대 버전을 명시한다. 오류는 `code`, 공개 가능한 `message`, `requestId`로 반환한다. 인증·입력 오류를 내부 스택이나 자격 증명과 함께 반환하지 않는다. 세션·호스트 토큰은 내보내기 대상에서 제외한다. 웹 검토 서버는 별도 `/review/v1/` 경로와 권한을 사용하며 실행 엔드포인트를 제공하지 않는다.

표 내보내기의 첫 구현 후보는 UTF-8 CSV, 검토 요약은 자체 포함 HTML이다. OQ-08의 채택·호환성 검수를 거쳐 지원 선언한다. CSV 수식·HTML 실행 주입을 방지한다. 형상은 조회 메타데이터와 큰 뷰어 자산을 분리하고 체크포인트에는 자산 해시와 문서별 기준을 기록한다.

T-002의 첫 HTTP 구현은 프로젝트 목록·생성과 입력 목록·생성·기대 버전 수정을 제공한다. 시작할 때 생성한 난수 링크의 fragment를 같은 Origin의 세션 교환 API로 보내고, 이후 HttpOnly·SameSite=Strict 쿠키를 사용한다. fragment는 교환 후 주소에서 지운다. API는 정확한 Host·Origin·메서드·JSON 형식·입력 크기를 검사한다. 브라우저 화면은 실제 저장 입력만 표시하고 호스트 미연결 상태를 명시한다. 사용자 데이터는 실행 시 지정한 DB에 저장한다.

<a id="master-4-1"></a>

#### 추가 저장 모델과 식별

아래는 T-013의 설계 대상이며 표로 다 만들지 않았다(현재 DB는 schema 8, §5·§7). 실제 행·열은 `src/core/migrations.ts`가 정본이다. 모든 하위 레코드는 projectId를 검증한다. revision은 레코드 수정 번호, basisId는 불변 취득 기준, connectionId는 현재 전송 연결, documentSessionId는 열린 문서 세션이다. 저장 파일과 재열기 전 세션의 관계는 확인 기록으로만 연결하며 파일 경로로 쓰기 세션을 복원하지 않는다.

| 저장 대상 | 핵심 필드·제약 |
|---|---|
| work_scopes / tasks | projectId, goal, conditionRevision, targetRefs; task.scopeId, dependencies; 순환 의존 거절 |
| runs | taskId, conditionRevision, basisIds, providerId, limits, previousRunId; 시작 기준 불변 |
| snapshots / object_refs | documentSessionId, basisId, capturedAt, units, completeness; nativeId와 지원 속성/형상 해시 |
| input_versions | inputId, revision, body, refs, sketch, parameters, provenance, role; 실행이 참조한 버전 불변 |
| candidates / candidate_objects | runId, revision, basisIds, nativeRefs, ownershipProof, observedFingerprint, validity. **2026-09-30 ADR-022 이후 AI 편집에는 쓰지 않는다**(jig·가져오기의 내부 작업 사본에만 남음) |
| 실행 기록(executions) | AI 편집의 실행 한 번씩: 요청 결과의 `executions[]`와 대화 원장 항목. executionId, host, target(연결·문서), file(연결 파일 ID·이름, 여러 파일 턴), label, undoId, 상태, changes, guarded. jig 만들기의 되돌리기 기록 번호는 현재 서버 메모리에만 있어 재시작 뒤에는 그 만들기의 [되돌리기]가 꺼진다(Rhino의 Ctrl+Z는 남음). §4 「바로 적용 경로」 |
| relations / query_results | sourceRef, targetRef, relationType, provenance; 계산 정의/입력 기준/값/단위/미상 사유 |
| checkpoints / assets | 불변 manifest와 content hash; 파일 저장 완료 후 manifest 공개 |
| publications / comments | 고정 공개 manifest, 서버 접수 ID/시각; 게시본 기준과 의견 제출 ID 유일성 |
| events / command_receipts | projectId, sequence, aggregateId, revision, type, payload; 명령별 대상·결과 증거 |

핀은 `{documentSessionId, basisId, nativeId, subRef?}` 또는 공간 위치다. 기하 스케치는 `{origin:[x,y,z], axisU:[x,y,z], axisV:[x,y,z], unit, points:[[u,v]], role}`이며 유한 수치·정규직교·알려진 단위를 검증한다. 화면 주석은 별도 kind와 assetId·2D 위치를 사용한다. 문서 간 변환은 source/target basis와 검증한 변환 행렬·단위를 포함한다.

파라미터 전송은 `{targetRef, property, rawText, value, unit, provenance, conditionRevision}` 배열로 한다. 평면은 `{documentSessionId, basisId, kind: XY/XZ/YZ/face, origin, axisU, axisV, unit, confirmed}`이며 미확정은 초안 전용이다. 이전 스케치의 선 역할 값은 SPEC-01.5.3대로 보존만 한다(새 스케치는 역할 없음). 초안 저장 검사와 실행 가능 검사를 분리하고, 누락 값을 기본 치수로 채우지 않는다. 실제 저장/API 구현은 T-013에서 진행한다.

마이그레이션은 schema 버전 확인→백업→트랜잭션 변경→무결성 확인 순서다. 과거 실험 run에 task가 없다면 보존된 기존 실행으로 읽고, 새로운 실행용 관계를 자동 사실로 꾸미지 않는다. 새 실행부터 필수 관계를 적용한다. 자산 쓰기 실패 때 DB가 없는 파일을 완료 자산으로 가리키지 않게 한다.

<a id="master-4-2"></a>

#### API·이벤트 계약

실제 경로는 `src/server/server.ts`와 위임 모듈이 정한다. 아래는 2026-10-01 코드의 프로젝트 범위 경로 묶음이다(`/api/v1/projects/:p/…`). 요청은 `workspace_requests` 한 행으로 접수하고(`requests`), 작업·실행·명령을 따로 나눈 이전 계획 API는 만들지 않았다.

| 묶음 | 경로 | 비고 |
|---|---|---|
| 프로젝트·입력 | `GET·POST /projects`, `PUT·DELETE /projects/:p`, `POST …/thumbnail`, `…/inputs[/:i]`, `…/ai-instructions`, `POST …/attachments?name=`, `POST …/attachments/:a/view`, `GET …/attachments/:a`, `POST …/attachments/path-images`·`…/path-kinds`·`…/from-path`, `GET·POST …/folders`, `POST …/folders/remove`, `GET·POST …/agenda`, `PUT …/agenda/:id`, `POST …/agenda/order`, `POST …/agenda/:id/remove`, `POST …/agenda/remove-done`, `POST …/agenda/undo`, `GET …/agenda/log`, `POST …/agenda/day-end`, `GET·POST …/knowledge/collect`, `POST …/knowledge/collect/stop`, `GET …/agenda-proposals`, `POST …/agenda-proposals/add`·`…/dismiss` | 프로젝트 삭제는 SPEC-01.1. 첨부는 §3 「첨부 보관과 읽기 도구」, 폴더는 §3 「프로젝트 폴더와 파일 읽기 도구」, 할 일은 §3 「대시보드의 할 일」, 자료 정리와 할 일·일정 후보는 §3 「자료 정리」 |
| 요청(AI 턴·Sync·가져오기) | `GET·POST …/requests`, `GET …/requests/:r`, `…/:r/cancel`, `…/:r/interventions`, `…/:r/hide`, `…/:r/questions`, `…/:r/reconcile`, `…/:r/model\|open`, `…/:r/report`, `…/:r/quantities[.csv]`, `…/:r/publication-export` | 상태는 SPEC-00.10 |
| 바로 적용 | `POST …/requests/:r/undo {executionId}` 또는 `{all: true}`(작업 단위, ADR-027), `…/:r/confirm {executionId?}`, `…/:r/continue`, `…/:r/acknowledge`(결과 불명 [확인함], T-102) | §4 「바로 적용 경로」. confirm·continue는 202, acknowledge는 200 |
| 연결 파일·Sync | `GET·POST …/links`, `PUT …/links/:l`, `POST …/links/:l/remove`, `POST …/links/:l/split·merge·dismiss`, `POST …/links/:l/reads`, `…/live-sync`, `…/capture`, `…/import`, `…/imports/:i/reconcile` | §7 「프로젝트 연결 파일(Link)」 |
| 도면 xref 관계 | `GET …/xref`, `POST …/xref/read`, `POST …/xref/apply {root}` | §7 「도면 xref 관계(T-200)」 |
| 사본 적용(jig·가져오기 내부 사본) | `…/applications[/:a[/reconcile]]` | ADR-022로 AI 편집에는 쓰지 않음 |
| 대화 | `…/conversations[/:c[/close\|reopen\|ledger\|handoff\|account\|answer\|renew\|bind\|unbind]]` | ARCH-03 §10. `account`·계정 인계는 PLAN-25 2단계에서 빼는 중 |
| jig·만들기·자료 | `…/jigs…`, `…/jig-instances…`, `…/jig-reports`, `…/jig-drafts…`, `…/skills`, `…/facts…`, `…/jigs/knowledge…`, `…/jigs/structure…`, `…/jigs/sync` | ARCH-03 §7, ARCH-02 |
| 경로 판정·검토·공유 | `…/route`, `…/route/revert`, `…/reviews…`, `…/review-comparison`, `…/comparison`, `…/table-views…`, `…/shared-feedback`, `…/offline-view…`, `…/extensions/:e/run` | §6 |

그 밖의 전역 경로: `/api/v1/session`·`hello`·`shutdown`·`remote`·`host…`(문서·선택·핀)·`models`·`providers`·`settings/ai|routing|conversations`·`connectors…`·`extensions`·`jigs…`·`accounts`·`accounts/usage`·`accounts/usage-settings`(계정은 읽기 전용, §7). 이전 계획의 `scopes`·`connections/:c/sync`·`tasks/:t/runs`·`runs/:r/interventions|stop`·`candidates/:c/apply`·`commands/:c/reconcile`·`queries`·`checkpoints`·로컬 `publications`는 만들지 않았다. 웹 검토 서버의 의견 접수는 §6이 소유한다. 장시간 요청은 접수 응답과 완료 결과를 나누고, 멱등·기대 버전 검사는 각 경로가 한다.

검증 오류는 400, 미인증/권한 부족은 401/403, 다른 프로젝트의 비공개 자료는 404, 오래된 revision/멱등 ID 변조는 409, 지원 밖 기능은 422로 매핑한다. 상태는 `code`로 판정하고 번역된 문구로 분기하지 않는다.

아래 이벤트·SSE 계약은 만들지 않았다(2026-10-01 현재 화면은 요청·연결 상태를 주기 조회한다). 만들 때의 설계로 남긴다. 이벤트는 `{eventId, projectId, sequence, aggregateId, revision, type, occurredAt, payload}`다. DB 갱신과 outbox 저장을 같은 트랜잭션으로 묶고 커밋 뒤 전달한다. SSE `/api/v1/projects/:p/events`로 변경 알림을 보내며 클라이언트는 sequence 중복을 무시한다. 재연결의 누락 범위를 복구할 수 없으면 `resyncRequired`를 보내 정본 DTO를 다시 조회한다. 이벤트 수신은 명령 성공의 대체 증거가 아니다.

<a id="master-4-3"></a>

#### 명령 수명과 상태 매핑

실행 상태는 queued/running/succeeded/failed/unknown/cancelled, 중단은 none/requested/waiting/confirmed/unconfirmed, 지시는 received/reconciling/adopted/partial/needsDecision으로 매핑한다. 후보 validity와 적용·저장·게시 상태는 별도 값으로 유지한다(SPEC-00.10). 현재 코드의 용어와 차이는 T-013에서 명시적 변환으로 이행한다.

원본 쓰기(2026-09-30부터 AI 편집은 §4 「바로 적용 경로」의 `direct-execute`가 이 순서의 '지시 확인' 없이 같은 영속화·직렬 전달·영수증 규칙을 따른다): 요청 검증 → 후보/변경 hash에 묶인 지시 확인 → 명령 영속화 → 문서별 직렬 전달 → 호스트 문서 문맥에서 동일성·지문 재검사 → 지원 연산 → 결과/receipt 기록 → 로컬 결과 확인. 이미 처리된 commandId와 같은 hash는 기존 receipt를 반환하고 다른 hash는 거절한다. 호스트 receipt와 실제 쓰기를 원자적으로 기록하지 못하는 구간은 unknown으로 남기며 ‘정확히 한 번 실행’ 보증을 주장하지 않는다. 재연결·재열기 이후 불명확 작업이 있는 문서의 후속 쓰기는 막지 않고, 그 턴의 문맥에 문서를 먼저 읽으라는 안내(`unresolved-results`)를 넣는다(SPEC-02.13의 7, T-102). 불명확 작업을 자동 재실행하지 않는다.

<a id="master-4-4"></a>

#### 화면 조회 모델과 gateway

UI는 업무 엔티티의 DB 행을 직접 해석하지 않는다. 아래 조회 모델과 gateway 행동 목록은 처음 설계이며 이 이름 그대로 만들지 않았다. 실제 화면 데이터 접근은 `src/ui/gateway.ts`가 위 「API·이벤트 계약」의 경로를 부르는 것이고, `CandidateView`·`applyCandidate`는 ADR-022 이후 AI 편집에 쓰지 않는다. 아래 조회 모델은 각 프로젝트 범위에서 생성하며 의미는 SPEC, 표시 위치는 Design §12를 따른다. 모든 표시 모델은 실제/합성 출처를 유지한다.

| 조회 모델 | 필요한 정보 | 소비 화면 |
|---|---|---|
| WorkspaceView | projectId, 현재 작업, 연결 목록, 문서별 최신 basis 요약, 저장 상태 | SCR-01 |
| BasisView | basisId, documentSessionId, 취득 시각/완전성/단위, 표시 자산, 객체 참조와 선택 대응 | SCR-01·02 |
| InputView | inputId, revision, 본문, 핀/선/자료 버전, 출처/역할, 저장 상태 | SCR-02·07·10 |
| TaskView | taskId, 목표/조건 기준, 대상, 의존 작업, 실행 상태, 지시/중단 상태, 실제 최근 결과 참조 | SCR-03 |
| CandidateView | candidateId/revision, 원본/후보 기준, 실제 객체 참조·표시 자산, 변경/측정·검토 범위, 문서별 적용/저장 | SCR-04·09 |
| TableView / CheckpointView | 질의/포함 범위, 근거, 단위/미상/유효성 또는 고정 manifest와 접근 범위 | SCR-08·09·11 |
| PublicationView / CommentView | 게시 기준·공개 범위·접수 시각·상태, 원 의견 기준·로컬 작업 연결 | SCR-06 |

gateway는 `getWorkspace`, `getBasis`, `saveInput`, `startTask`, `intervene`, `stopRun`, `getCandidate`, `applyCandidate`, `queryTable`, `createCheckpoint`, `publish`, `submitComment`의 비동기 행동으로 구분한다. 첫 입력 묶음에서는 앞의 조회/저장만 실제 구현한다. 미구현 행동은 지원 여부와 이유를 반환하며 가짜 성공을 반환하지 않는다. HTTP/fixture 구현이 같은 DTO를 사용하고, fixture 진입은 명시적 개발 모드에서만 가능하다.

조회 API는 §4.2의 프로젝트 범위 아래 연결·basis·작업·후보·표·검토본을 ID로 읽는 GET으로 제공한다. UI 전환 시 requestId/projectId를 검사하고 오래된 응답을 버린다. 객체 선택·카메라 이동은 UI 상태이며 GET/POST의 실행 대상을 바꾸지 않는다. 실제 타입 검증 코드와 예제 payload는 T-013에서 필요한 첫 계약부터 작성한다.

<a id="master-5"></a>
<a id="master-5-1"></a>
<a id="master-5-2"></a>

### 1.4 연결과 동기화

신규 실행·handshake·권한 계약은 §2~4가 소유한다. 기존 제한 JSON 경로는 이행 중 호환 코드이며 범용 실행의 허용 범위를 제한하지 않는다. 초기 연결 설계는 이행 기록에 보존한다. 실행 방법의 선택 이유는 ADR-014, 작업 순서는 PLAN-02를 따른다.

<a id="master-5-3"></a>

#### 수동 Sync와 실행 결과 표시의 연결

수동 Sync는 사용자가 호스트 현재 상태를 가져오는 경로다. AI 편집과 jig 만들기는 2026-09-30 ADR-022부터 연결 문서 자체를 바꾸므로(§4 「바로 적용 경로」) 바뀐 객체는 실행 기록(`executions[]`의 `changes`)으로 보이고, 화면의 형상은 그 문서의 Live Sync(켜져 있을 때) 또는 수동 Sync가 반영한다. 가져온 파일·검토 jig의 내부 작업 사본 결과는 해당 실행의 결과 표시 경로로 보이며, 사용자가 매 중간 결과마다 다시 Sync해야 볼 수 있는 구조로 만들지 않는다. 자동 카메라 동기화는 추가하지 않는다. Rhino 선택의 문서별 반영과 고정 묶음은 SPEC-01이 정한다.

CAD→Rhino는 native 객체를 통째로 넘기는 대신 선택 경계의 확인된 점열·평면·단위·기준과 사용자 확인 변환을 전달한다. 수정한 경계를 후속 입력으로 쓸 수 있다. 관계 저장은 원본/후보 참조와 변환·실행 기준을 함께 남긴다. 일반 DWG↔3DM 변환기나 상시 양방향 동기화로 구현 범위를 바꾸지 않는다.


<a id="detail-1"></a>

## 2. AI 실행과 SDK


이전 제한 JSON·제3자 RhinoMCP·COM 경로의 출발점은 [이행 기록](../tdd/VERIFY-2026-09-20-implementation-history.md)에 있다. 현재 지원은 PLAN §6.5를 따른다.

아래 HTTP MCP는 새 에이전트 연결이며 ‘중계 제거’는 이전 설계안 대비 단순화다. 현재 실행 중인 MCP 중계를 제거하는 작업이 아니다. 자체 애드인은 컴파일 실행기·UI 스레드 호출·변경 관측·빌드·설치·업데이트·제거를 포함하는 신규 개발이다. 현재 경로는 1단계 검증 동안 유지하고 자체 애드인의 동등 과업·설치 회귀가 통과한 뒤 의존성을 제거한다. 외부 플러그인 설치 불필요라는 제품 지원 선언은 그 이후다.

AI가 공식 SDK의 API와 실행 순서를 선택하고 코드를 작성한다. VIDE는 대상·권한·기준·실행 수명과 실제 결과를 관리한다. geometry.mjs의 제한된 operations 목록을 최종 실행 언어로 확장하지 않는다. 기존 경로는 이행 검증 동안 유지하되 새 경로 실패 시 몰래 대체하지 않는다.

| 구간 | 구현 선택 | 이유·한계 |
|---|---|---|
| 공식 구독 에이전트 → VIDE 제어기 | 기존 Node 서버에 내장한 MCP Streamable HTTP `/mcp` | 이전 설계안의 별도 MCP 중계 프로세스·중계용 pipe를 두지 않음(제품 연결 현황은 PLAN §6.5 참조). 실행별 연결 설정을 제공하며 사용자 개인 설정을 바꾸지 않음 |
| VIDE 제어기 → 호스트 | 첫 검증은 기존 TCP 유지. 자체 애드인은 loopback+실행별 pairing 토큰으로 제어기에 등록·접속하는 구조부터 검증 | Named Pipe는 접근 제어·유지비·성능 비교 뒤 채택할 대안이며 첫 연결의 선행 조건이 아님 |
| 브라우저 → VIDE | 기존 loopback HTTP 유지 | 호스트 IPC를 브라우저에 노출하지 않음 |
| VIDE → 공유 서비스 | HTTPS | 게시본과 의견만 전달; 로컬 실행과 분리 |

MCP는 도구 규약이며 에이전트 구간은 HTTP, 호스트 구간은 기존 TCP와 자체 애드인 연결을 단계적으로 이행한다. 내부 호스트 연결까지 MCP 서버로 만들지 않는다. MCP 사용이 추가 추론 호출을 요구하지 않으며 임의 CAD API 사용 범위를 결정하지도 않는다. [공식 MCP 전송 규약](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [Windows Named Pipe](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes).

MCP endpoint는 loopback에만 바인딩하고 공식 SDK로 처리한다. 브라우저 쿠키와 별도로 작업 범위·수명의 에이전트 토큰을 발급하고 Host/Origin/인증 검사를 적용한다. 기존 서버가 새 경계를 자동 보호한다고 가정하지 않는다. stdio는 설치 공급자의 HTTP 연결/인증이 불가능하다고 확인될 때만 얇은 호환 어댑터로 고려하며 두 방식을 선제적으로 함께 만들지 않는다. Named Pipe를 채택하려면 Node 서버/C# 서버 방향별 사용자 ACL·원격 접근 제한을 실제로 검증한다. 일반 Node net API만으로 필요한 ACL을 설정할 수 있다고 가정하지 않는다. TCP와의 속도 우위도 가정하지 않는다. 통신 이름을 통일하려고 WebSocket을 추가하지 않는다.

공급자별 어댑터는 공식 실행 프로그램의 스트림·도구 설정만 담당한다. 첫 검증에서 설치된 양쪽 CLI의 HTTP MCP 연결·인증과 실행별 설정 주입, 공급자 설정 격리, 같은 세션 내 조회→실행→오류 수정, 취소·재시작을 확인한다. 프로토콜/SDK는 구현 시 공식 안정 버전을 확인해 lockfile에 고정한다. 개인 MCP 설정이나 인증 파일을 복제하지 않는다. 구독 인증 재사용 방식은 기존 공식 도구 경로를 유지한다. 공급자가 필요한 도구 기능을 지원하지 않으면 해당 공급자 연결을 미지원으로 표시하고 기술 결정을 갱신한다. 이 계획만으로 실제 CLI 호환성을 주장하지 않는다.

### 실제 실행 진행 정보

Rhino/ZWCAD SDK 실행은 기존 요청 result 안의 `progress`로 조회 완료 수(`queries`), 실행 시도 수(`attempts`), 호스트 영수증으로 확인한 저장 단계 수(`completed`)를 전달한다. 별도 DB 테이블이나 LLM 보고 수치는 사용하지 않는다. 실행 상한은 기존 12회이며 도구 전체 30회·도구 권한 유효시간 240초와 구별한다. 컴파일/정책 거절은 시도에만 포함하고 완료 수를 늘리지 않는다. 성공·불명확 결과에도 마지막 관측값을 보존한다. 첫 저장 이후의 후속 조회·모델 응답은 재시작 복구용 host phase와 operationId를 유지한다. UI는 이 정보를 짧은 보조 행으로 표시하며 백분율이나 원본 적용 성공으로 바꾸지 않는다.

### 복구 후보와 후속 초안

> 2026-09-30 [ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md) 이전 사본 경로의 계약이다. 연결 문서의 AI 편집은 §4 「바로 적용 경로」를 쓰므로 이 절은 연결 문서가 아닌 대상(가져온 파일의 작업 사본, 검토 jig)의 실행에만 남는다.

연계 하위 candidate 요청에서 source가 검증된 자체 SDK 후보이고 query>0/execute 시도=0이면 export로 현재 사본을 확인하고 기존 파일/해시를 그대로 참조한다. 결과에 `unchanged: true`, `baseRequestId`, 빈 changes와 실제 progress를 남기며 새 저장 영수증/쓰기를 만들지 않는다. 기존 `hostExecuted`는 실제 호스트에서 후보를 확인했다는 표시로 유지하고 완료 횟수는 0이다. 취소/불명확/컴파일 거절을 거친 요청은 이 경로에 들어가지 않는다. 읽기 실패는 성공으로 감추지 않는다.

연계 후속 초안은 부모의 `targetResults.requestId`를 현재 작업 목록에서 다시 조회한다. 각 하위 요청의 `parentRequestId`, 원 `baseRequestId`, host와 성공/hostExecuted를 확인하고 두 `linkedTargets`를 하위 후보 ID로 교체한다. 원 기준 핀은 논리 ID·nativeId 일치를 검증해 basis만 바꾼다. 다른 참조·좌표 확인·권한·실행 상한은 유지하며 저장/API는 기존 초안과 요청 계약을 사용한다. 보류된 개입 요청은 supersedesRequestId의 종료된 원 요청을 조회해 같은 대상/좌표/권한을 검증하고 그 하위 결과만 사용한다. 입력 조건·첨부는 개입 요청에서 가져온다. 새 실행 ID는 전송 때 부여하며 supersedes 관계를 임의 재전송하지 않는다.

SDK 영수증 복구 결과에는 `recovered: true`를 둔다. 기존 succeeded는 사본의 저장·재읽기 확인으로 유지하되 UI는 전체 목표 완료와 구분한다. 후속 초안의 baseRequestId는 복구 요청 ID이며 원 입력의 조건·스케치·자료·권한을 유지한다. 원 기준의 핀은 두 결과의 논리 ID와 native ID가 일치할 때만 새 기준에 연결하고, 다른 기준의 참고 핀은 원 참조를 유지한다. 원 기준 또는 객체 대응이 사라지면 초안 생성 전체를 거절한다. 새 요청은 기존 파일 지문 검사와 문서별 경합 검사를 그대로 통과해야 한다.

### SDK·도우미·스킬

- 호스트 설치 버전에 맞는 공식 SDK를 참조한다. 첫 Rhino 실행 언어는 C#과 Roslyn 컴파일, 참조 어셈블리는 호스트 어댑터에서 제공한다. ZWCAD는 설치된 2023 .NET SDK/런타임 호환성을 먼저 실험하고 전용 애드인에서 실행한다. 현재 COM은 기존 지원 경로이며 다중 인스턴스용 최종 실행기로 간주하지 않는다.
- 코드 본문은 AI가 작성한다. 컴파일 진입점·오류 수집·호스트 UI 스레드 호출을 감싸는 고정 래퍼만 사용하며 편집 알고리즘 템플릿을 강제하지 않는다. GH는 별도 문서 대상으로 스크립트 소스/입출력·재계산을 처리한다. Rhino 문서와 GH 문서를 혼동하지 않는다.
- 작은 도우미 라이브러리는 단위 변환, 객체 조회, 측정 캐시, 결과 포장에 한정해 시작한다. 공식 SDK를 전부 재포장하지 않는다. 문서화한 버전·입출력·오류를 제공한다.
- 작업 지침은 함수 선택·조회 순서·예제·검증 기준을 담는다. 라이브러리와 지침 버전을 실행 기록에 남긴다. 전문 스킬 전체 구현(FR-21)을 첫 출시 필수로 추가하지 않는다.
- 임의 호스트 코드는 같은 프로세스의 다른 문서/API에 접근할 수 있다. 대상 필드·코드 문자열 검사·Undo는 보안 샌드박스가 아니다. 조회 권한에는 고정 조회 도구만 허용하고 임의 코드 도구를 주지 않는다. (2026-09-30 [ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md)로 이 문장의 사본 검증·원본 접근 제한은 AI 편집에 더는 적용하지 않는다. AI 코드는 사용자의 연결 문서에서 되돌리기 기록 안에 실행하며, 컴파일·금지 API 정책과 실행 상한은 유지한다.) 임의 후보 코드는 종료 권한이 있는 VIDE 소유 테스트/작업 실행본의 사본에서 검증한다. 전용 실행본은 재사용하며 매 도구 호출마다 새 호스트를 띄우지 않는다. 사용자 작업 실행본을 강제 종료하지 않는다. 실문서 적용은 이 문서 §4의 변경 집합 전달을 새로 구현해 기존 적용 계약과 연결한다. 이 경계의 검증 전 임의 코드의 원본 접근을 제품 지원으로 열지 않는다.

### 대화 세션의 CLI 실행(잠정)

[ADR-021](../decisions/ADR-021-conversation-sessions.md)의 목적별 대화(SPEC-02.19)를 실행하는 CLI 쪽 계약이다. 대화·공급자 세션·원장의 저장은 [ARCH-03](ARCH-03-jig-runtime.md) §10이 소유한다. 아래 인자와 경로는 PLAN-24의 SPIKE(ADR-021 표의 0·①~⑨) 결과로 확정할 때 고친다.

- **Claude 대화는 프로세스 하나(2026-10-02 [ADR-028](../decisions/ADR-028-ai-cli-parity.md) 1, T-104).** 대화(세션)의 첫 턴에 `--input-format stream-json` 프로세스를 띄우고(`KeptClaudeCli`, `src/ai/claude-process.ts`), 턴마다 사용자 메시지 하나(이번 턴 규칙·자료·이미지)를 표준 입력에 넣는다. 턴은 그 턴의 `result`로 끝나되, 그 턴이 시작한 하위 에이전트(`system/task_started`)가 모두 보고(`task_notification` 또는 끝난 `task_updated`)한 뒤의 마지막 `result`가 답이다. 하위 에이전트가 보고한 턴(보고가 `result`보다 먼저 와도)은 `result` 뒤 5초를 기다려, 그 안에 CLI가 보고를 읽는 자체 턴(`init`)을 시작하면 그 턴의 `result`가 답이고, 아니면 앞의 `result`가 답이다. 턴이 끝난 뒤(아무 턴도 듣지 않을 때) 프로세스가 이벤트를 내면 다음 턴의 답으로 읽히지 않게 그 프로세스를 끝내고, 다음 턴은 `--resume`으로 새로 띄운다. 사용량은 그 턴의 `result`들을 더한다. 시작 이벤트는 턴마다 와서 도구 검사(`initValid`)와 세션 ID 확인을 턴마다 한다. 프로세스의 열쇠는 실행 파일·기본 로그인(e-mail)·세션 플래그를 뺀 전체 인자(모델·effort·묶음·MCP 설정과 도구·내장 도구·계획/자동·질문 도구·`--json-schema`)이고, 다음 턴의 열쇠가 다르면 그 프로세스를 끝내고 `--resume <UUID>`로 새로 띄운다. MCP 토큰: 프로세스는 시작 때 자기 토큰(`VIDE_AGENT_TOKEN`, 무작위 64자)을 받고, 엔진은 턴 동안만 그 토큰을 그 턴의 범위 토큰으로 대응시킨다(`src/ai/agent-relay.ts`, `AgentTools.handle`). 턴 사이에는 401이다. 쉬면 10분 뒤, 엔진을 닫으면(`closeClaudeProcesses`) 끝낸다. 중단은 `control_request {subtype: interrupt}`를 보내고 2초 안에 그 턴의 `result`가 오면 프로세스를 남기며(진행 중 하위 에이전트가 있으면 끝냄), 아니면 `taskkill /T`로 끝내고 종료를 기다린다(못 보면 `STOP_UNCONFIRMED`). 턴 중의 비정상 종료는 아래 단발과 같은 분류(`SESSION_LOST`·`PROVIDER_FAILED` 등)이고 그 프로세스는 다시 쓰지 않는다. 같은 대화의 두 번째 턴이 겹치면 `CONVERSATION_BUSY`. 진단 로그 `request-stages`의 `processReused`가 이어 쓴 턴이고, 그때 `spawnMs`는 턴을 써 넣은 때다. `VIDE_CLAUDE_PERSISTENT=0`이면 아래처럼 턴마다 실행 하나다.
- **턴 하나 = CLI 실행 하나(단발·`VIDE_CLAUDE_PERSISTENT=0`).** Claude는 대화의 첫 턴에 `--session-id <UUID>`, 이후 턴에 `--resume <UUID>`로 실행한다. 매 턴 인자는 현행 격리 인자(도구 없는 턴·도구 있는 턴 각각)에서 `--no-session-persistence`만 뺀 것이고, 시작 이벤트의 도구·MCP 목록이 그 턴의 허용 목록과 다르면 실행하지 않는다. Codex도 세션 방식이다: 첫 턴의 thread를 기록하고 이후 턴은 `exec resume <thread>`로 이어 간다(아래 「AI 실행 인자」, SPIKE ④ [SPIKE-2026-09-30-cli-session-resume](../tdd/SPIKE-2026-09-30-cli-session-resume.md)). 대화의 방식은 열 때 정하며(`SESSION_PROVIDERS`, `src/server/conversations.ts`) Codex의 jig 만들기 대화만 원장 방식(턴마다 단발 실행 + 원장, 초안 파일을 매 턴 자료로 보냄)이다. 세션 이어 실행이 막힌 공급자·항목도 원장 방식으로 돈다.
- **시스템 프롬프트:** 대화마다 중립 시스템 프롬프트 하나를 쓰고, 턴마다 달라지는 범위·대상·권한·상한은 요청 자료의 '이번 턴 규칙'으로 보낸다. 기록된 프롬프트를 쓰지 않게 하는 옵션(`--system-prompt-snapshot off`)은 SPIKE ⑦ 뒤에 쓰고, 통하지 않으면 한 대화 아래 도구 없는 세션과 도구 있는 세션을 따로 둔다. 4차 물결까지는 Claude가 `--system-prompt`로 공급자 기본 프롬프트를 한 줄 중립 지시로 바꾸고, Codex는 `developer_instructions`에 같은 뜻의 중립 지시를 넣는다.
- **VIDE 지시 묶음(적용 중, 2026-09-30 5차 물결):** 공급자 기본 시스템 프롬프트를 바꾸지 않고 그 뒤에 VIDE 지시 묶음을 **덧붙인다**. Claude는 `--append-system-prompt`, Codex는 `developer_instructions`로 같은 본문을 보낸다. 묶음은 모드별(공통·모델링·자료·만들기) 본문과 프로젝트별 추가분으로 나누며 원본은 `src/ai/instructions/`에 둔다. 공급자 skill·plugin은 계속 끄고(격리), 쓸모 있는 skill의 내용은 묶음 안으로 옮긴다. 이번 턴 규칙·격리 인자·시작 이벤트의 도구 검사는 그대로다. 쓰기는 자동 모드의 `execute`(`direct-execute`, §4 「바로 적용 경로」)만 쓰고, 계획 모드 턴에는 쓰기 도구가 없다(ADR-022). 모드별 확정 인자는 아래 「AI 실행 인자」가 소유한다.
- **작업 폴더:** 매 턴 저장소·데이터 폴더 밖의 빈 임시 폴더다. jig 만들기 대화만 초안 폴더를 붙인다(ARCH-03 §2.3).
- **CLI 판 확인:** 실행 전 `--version`(60초 캐시)을 검증한 판 범위(`cli-compat.json`)와 비교해 밖이면 실행을 거절하고 안내한다. `--bare` 기본화 같은 인증 방식 전환의 실패 신호는 `CLI_MODE_CHANGED`로 분류하고 멈춘다. 가능하면 검증한 판의 실행 파일 경로를 고정한다.
- **한 세션을 두 실행이 쓰지 않는다.** 종료를 확인하지 못한 턴 뒤에는 그 세션을 `lost`로 두고, 이전 프로세스의 종료를 확인한 뒤 인계 자료로 새 세션을 연다.
- **공급자 기록 관리:** 대화를 닫고 30일 뒤 `provider_sessions`의 세션 ID로 기본 로그인 폴더의 공급자 기록(Claude는 `<세션>.jsonl`과 하위 에이전트 기록이 든 `<세션>/` 폴더)을 지우고, 버린 jig 초안의 기록은 바로 지운다. 공급자 기록은 백업 대상이 아니다. 기본 로그인의 설정 경로는 바꾸지 않는다(§7 「CLI 기본 로그인 실행 경계」).

#### AI 실행 인자

두 CLI의 한 실행 인자다. 원본은 `cliArguments`·`sessionArguments`(`src/ai/claude-cli.ts`), `codexArguments`·`codexTurnIsolated`(`src/ai/codex-cli.ts`), `configureAgentArguments`(`src/ai/agent-connection.ts`)이고, 이 표와 다르면 코드를 고친다. 묶음(`bundleFor(mode, 추가 지침, {host})`)은 두 CLI에 같은 본문이 가고, 그 뒤에 `## 이번 실행의 규칙` 아래 실행 규칙 한 문단이 붙는다(`withRules`). 세션 턴은 실행 규칙이 중립 문장으로 고정되고, 그 턴의 도구·대상·권한은 요청 자료의 `turn-rules` 항목(`turnRules(연결, 공급자 형식)`)으로 간다.

| 경우 | 묶음 모드 | Claude Code | Codex |
|---|---|---|---|
| 공통 격리(모든 경우) | — | `-p --safe-mode --tools "" --strict-mcp-config --mcp-config {"mcpServers":{}} --setting-sources "" --no-session-persistence --no-chrome --disable-slash-commands --permission-mode dontAsk --output-format stream-json --verbose --append-system-prompt <묶음+규칙>` `[--model m] [--effort e]`. `--system-prompt`은 쓰지 않는다(기본 프롬프트 유지) | `exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --sandbox read-only -c approval_policy="never" -c model_provider="openai" -c forced_login_method="chatgpt" -c web_search="disabled" -c mcp_servers={} -c project_doc_max_bytes=0 -c tools.view_image=false -c developer_instructions=<JSON 문자열: 묶음+규칙>`, `--disable` 16개(shell_tool·unified_exec·apps·plugins·hooks·multi_agent·memories·browser_use·browser_use_external·computer_use·image_generation·view_image·code_mode·code_mode_host·skill_search·shell_snapshot), `--enable skip_host_skill_discovery` `[--model m] [-c model_reasoning_effort="e"]` `[-c cli_auth_credentials_store="file"]` `-` |
| 단발·도구 없음 | 호출자가 준 모드, 없으면 `data` | 규칙 = `noToolsInstruction`. 시작 이벤트의 도구·MCP 목록이 비어야 한다 | 규칙 = `codexSingleInstruction` |
| 세션 턴(도구 없음) | 대화 종류대로 | `--no-session-persistence`를 빼고 첫 턴 `--session-id <UUID>`, 이후 `--resume <UUID>`, 매 턴 `--system-prompt-snapshot off`. 규칙 = `neutralInstruction` | `--ephemeral`을 빼고, 이어 턴은 `exec resume <thread>`와 `--sandbox` 대신 `-c sandbox_mode="read-only"`. 규칙 = `codexSessionInstruction`(첫 턴 값이 세션에 고정). 실행 전 `codexTurnIsolated` 검사 |
| 호스트 도구(`query`·`execute`, 계획 모드는 `execute` 없음) | `modeling`(+대상 호스트 조각. 복수 대상은 두 조각 모두) | `--safe-mode` → `--restricted`, `--mcp-config {"mcpServers":{"vide":{"type":"http","url":<127.0.0.1…/mcp>,"headers":{"Authorization":"Bearer ${VIDE_AGENT_TOKEN}"}}}}`, `--allowedTools mcp__vide__<도구,…>`. 단발 규칙 = `agentInstruction`, 세션이면 중립 문장 유지 | `-c mcp_servers={vide={url=…,bearer_token_env_var="VIDE_AGENT_TOKEN",enabled_tools=[…],default_tools_approval_mode="approve",required=true,tool_timeout_sec=60}}`, `--enable code_mode --enable code_mode_host`(셸은 꺼진 채). 단발 규칙 = `agentInstruction`, 세션이면 중립 문장 유지 |
| 대화 도구(jig·구조·Sync·질문) | `data`(검토 jig는 `review`) | 호스트 도구와 같고 규칙 = `conversationToolInstruction`+대화 범위 | 호스트 도구와 같고 규칙 = `conversationToolInstruction`+대화 범위 |
| jig 만들기 | `make` | 위에 더해 `--tools Read,Edit,Write,Glob,Grep --add-dir <초안 폴더>`, `--allowedTools`에 파일 도구 추가. 규칙 = `makeToolInstruction` | 파일 도구 없음. 규칙 = `codexMakeInstruction`(세션 턴도 `turn-rules`가 이 문장), 출력 스키마에 `files`(최대 50개, 초안 안 경로와 전체 내용, `null`은 삭제) 추가. 턴 뒤 `makeTurnResult`(`src/server/make-routes.ts`)가 초안의 경로 규칙·파일 크기 상한으로 하나씩 쓰고(거절한 파일은 이유와 함께 `makeFiles.refused`), 점검·자체 시험을 돌려 결과를 원장 `code` 항목으로 남긴다. 멈춘 턴의 `files`는 쓰지 않는다 |
| 내장 도구(ADR-028 4·5, 대화·호스트·만들기 턴, VIDE 연결이 있을 때만) | — | `--tools`와 `--allowedTools`에 `Task,TodoWrite,TaskCreate,TaskGet,TaskList,TaskUpdate`를 더하고, 설정 「AI 웹 검색」(`<data>/web-settings.json`, `GET/PUT /api/v1/settings/web`, 기본 켬)이 켜져 있으면 `WebSearch,WebFetch`도 더한다. 시작 목록·호출(하위 에이전트의 것 포함, 호출 이름 `Agent`)에서 이 이름을 허용한다. 규칙 끝에 `builtinRule`(예외 문단: 하위 에이전트는 이 턴의 도구만, 웹 내용은 자료, 출처, 프로젝트 자료를 웹에 보내지 않음) | 웹만: `-c web_search="live"`(app-server는 스레드 설정 `web_search: "live"`), `codexTurnIsolated`·`threadParamsIsolated`가 그 값을 확인하고 `web_search`/`webSearch` 항목을 허용한다. 규칙 끝에 같은 예외 문단(web_search) |
| 구조화 출력(`turn-output` 항목) | — | `--json-schema <스키마>`. 이때만 CLI의 출력 도구 `StructuredOutput`을 시작 목록·호출에서 허용 | 실행 임시 폴더의 `--output-schema <파일>` |
| 작업 폴더 도구(ADR-031 8, T-122: 지시 묶음을 받는 턴 가운데 jig AI 검토·만들기 턴을 뺀 모두, VIDE 연결이 없어도) | — | `--safe-mode`·`--restricted`를 빼고(restricted는 작업 폴더 밖 경로를 묻지 않고 거절하고, safe는 VIDE MCP를 끈다; 설정 파일·슬래시 명령·다른 MCP는 그대로 끔), `--tools`에 `Read,Glob,Grep,Edit,Write,Bash`를 더하되 `--allowedTools`에는 넣지 않으며, 작업 폴더의 다른 폴더마다 `--add-dir`, `--permission-mode default --permission-prompt-tool stdio --input-format stream-json`(`workFolderArguments`). 작업 디렉터리는 첫 프로젝트 폴더(없으면 실행 임시 폴더). CLI가 스스로 허용하지 않는 사용(작업 디렉터리 밖 읽기, 모든 쓰기·셸)은 `can_use_tool`로 엔진의 `WorkFolderGate`(`src/server/project-files.ts`)에 오고, 답은 `allow`/`deny {message}`다. 대화 프로세스의 열쇠에 작업 디렉터리가 든다 | app-server 경로만: 스레드 `cwd` = 첫 프로젝트 폴더, `sandbox: workspace-write`(계획 턴 `read-only`), `config.sandbox_workspace_write = {writable_roots: <다른 폴더>, network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true}`, `approvalPolicy: untrusted`, 턴의 `sandboxPolicy`도 같은 값. `shell_tool`·`view_image`와 code mode를 켠다(설치본은 셸을 code-mode 호스트로 돌린다). 승인 요청 `item/commandExecution/requestApproval`(→ `Bash`, 네트워크 문맥이면 늘 질문)·`item/fileChange/requestApproval`(→ `Write`, 경로는 그 항목의 `changes[].path`)·`item/permissions/requestApproval`(→ `permissions`)을 같은 게이트에 묻고 `accept`/`decline`(권한은 허락한 것만)으로 답한다. Windows에서 Codex 샌드박스가 루트 밖 쓰기를 막지 않아(실측 2026-10-02) 경계는 이 승인 경로다. `codex exec`(작업 중 묻기 끔)는 승인 통로가 없어 작업 폴더 도구를 주지 않는다 |
| 이미지 | — | `--input-format stream-json`(표준 입력이 이미지 포함 사용자 메시지. 이어 쓰는 대화 프로세스는 늘 이 형식) | `--json` 바로 뒤 `--image <임시 파일>` |

- **출력 상한(ADR-028 2):** 한 실행·턴의 표준 출력 전체에는 상한이 없다. 이벤트 한 줄(stream-json 이벤트, app-server의 JSON-RPC 메시지 하나)이 16 MB(`MAX_EVENT_LINE`)를 넘으면 `OUTPUT_TOO_LARGE`로 멈춘다. 줄은 덩어리 안에서 하나씩 잰다.
- **허용 밖 도구 호출(ADR-031 8):** 시작 이벤트의 도구·MCP 목록이 턴의 허용과 다르거나(`initValid`), 허용 밖 도구를 부르는 이벤트(Claude `tool_use`, Codex 항목)가 와도 턴을 멈추지 않는다. 앞은 `provider-warning`(`UNEXPECTED_TOOL_ACCESS`), 뒤는 진행 이벤트에 `reason: TOOL_REFUSED`로 알린다. 실제 거절은 CLI가 한다(`--tools`·권한 모드·VIDE 권한 처리기, Codex 설정·승인 거절). 이 밖의 서버 요청은 오류로 답하고 턴은 계속된다.
- **턴 시간(ADR-031 8):** 출력이 없는 시간만 센다(`IdleClock`, `src/ai/claude-cli.ts`). 이벤트마다 다시 재고, 질문·권한 카드를 기다리는 동안과 답하지 않은 도구 호출(Claude `tool_use` → `tool_result`, Codex 도구 항목 `item/started` → `item/completed`)이 있는 동안은 멈춘다. 한도는 `executionLimits(input).timeoutSeconds`(대화 턴 600초, 단발 180초)다.
- **이미지:** 한 턴에 20장, 한 장 5 MB(`MAX_PACKET_IMAGES`·`MAX_PACKET_IMAGE_BYTES`)까지 보내고, 넘는 것은 거절하지 않고 그 항목에 `omitted` 안내를 남긴다.

- **환경:** 도구가 있으면 `VIDE_AGENT_TOKEN`만 넣는다. `CLAUDE_CONFIG_DIR`·`CODEX_HOME`은 넣지 않고 기본 로그인을 쓴다(ADR-025. 관리 프로필용 주입과 위 표의 Codex `-c cli_auth_credentials_store="file"`은 PLAN-25 2단계에서 빼는 중). `ANTHROPIC_*`·`OPENAI_*` 등 API 키 경로와 상속된 `CLAUDE_CONFIG_DIR`·`CODEX_HOME`은 지운다.
- **Codex app-server(기본, PLAN-24 T-075):** Codex 요청은 기본으로 `codex app-server --listen stdio://`(`src/ai/codex-app-server.ts`)로 간다. 위 표의 격리를 프로세스 인자(`appServerArguments`)와 스레드 설정(`appServerThreadConfig`: 사용자 MCP 서버는 끄고 VIDE 서버만 이 턴의 도구로)에 싣고, 서버가 보고한 스레드·MCP 상태로 다시 확인한다. 대화마다 프로세스 하나를 턴 사이에 두고(쉬면 10분 뒤 종료), 실행 파일·기본 로그인 계정·도구 유무가 바뀌면 다음 턴 전에 새로 띄운다. 모델의 `request_user_input`만 받아 질문 카드로 보이고 승인 요청은 거절한다. 대화 턴에는 Claude와 같은 처리기(`Execution.midRunQuestions`)를 넘겨 답을 같은 턴에 돌려주고, 답을 기다리는 동안 턴 시간을 멈춘다. 프로세스와 표준 입출력 모두에 수명 내내 `error` 수신기를 두어 엔진을 죽이지 않으며, 띄우지 못하면 `CLI_UNAVAILABLE`, 스스로 끝나면 진행 중 턴은 `PROVIDER_EXITED`로 끝나고 다음 턴은 새 프로세스로 스레드를 잇는다. 엔진을 닫으면 모두 끈다. `VIDE_CODEX_APP_SERVER=0`이거나 설정 → AI 「AI가 작업 도중에 묻기」가 꺼져 있으면(`<data>/question-settings.json`, `GET/PUT /api/v1/settings/questions`, 끄면 쉬는 프로세스를 바로 끈다) 위 표의 `exec` 경로다. Claude의 자체 질문(`--permission-prompt-tool stdio`)도 같은 설정과 `VIDE_NATIVE_QUESTIONS=0`으로 끈다. 환경 변수가 끈 것은 설정으로 켜지지 않는다.
- **크기:** 묶음은 추가 지침 포함 20,000자 이하(추가 지침부터 자른다). 추가 지침이 없을 때 `data`·`review` 약 2.0천, `make` 약 2.9천, `modeling` 두 호스트 약 14.3천·Rhino 약 9.7천·ZWCAD 약 7.8천 자다. 가장 긴 명령줄은 약 2.2만 자로 Windows 한도 32,767자 안이다.
- **실측:** Claude 2.1.285에서 자료 모드 세션 2턴(질문 카드 → 답변 턴)이 시작 이벤트 검사를 통과하고 묶음과 추가 지침이 모델에 닿았다([SPIKE-2026-09-30-instruction-bundle](../tdd/SPIKE-2026-09-30-instruction-bundle.md)).

### ZWCAD 범용 실행기의 물리 계약

이 절은 VIDE가 연 작업 사본(가져온 DWG)의 실행기다. 사용자가 연결한 열린 도면은 연결 DLL이 직접 실행한다(§6 「ZWCAD 열린 도면 수정」, §4 「바로 적용 경로」). PLAN-02 §6.1의 3a는 ZWCAD 2023의 .NET Framework 4.8 애드인에서 실행한다. `Microsoft.CodeAnalysis.CSharp` 4.11.0의 .NET Standard 2.0 자산을 고정하고 의존 DLL은 자체 플러그인과 함께 배포한다. 설치 SDK DLL은 참조만 하고 복사하지 않는다. [공식 패키지 호환 정보](https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp/4.11.0)와 설치 런타임 확인이 빌드 선택의 근거이며 실제 로드는 별도로 검증한다.

- 기존 읽기/정점 편집 명령은 유지하고 범용 작업 세션을 별도 명령으로 연다. 인증된 loopback TCP와 PID·시작 시각·세션·문서 ID를 확인하고, 호스트 Idle 문맥에서 요청을 직렬 실행한다. 활성 사용자 문서를 암묵 조회하지 않는다.
- AI 본문에 `Database db`, `Transaction tr`을 제공한다. 제어기가 작업 사본을 열고 트랜잭션·저장·재열기를 소유한다. AI에 문서 열기/저장·트랜잭션 확정·앱 전역 접근을 허용하지 않는다. 컴파일과 정책 검사는 실행 전에 끝낸다.
- 새 세션은 빈 mm 도면 또는 해시 검증한 사본으로 시작한다. `query`는 현재 객체와 revision을 반환하고 `execute`는 operationId·revision·본문을 받는다. 같은 ID/내용은 영수증 반환, ID 재사용 충돌·낡은 기준은 실행 전 거절한다. 실행 시작 후 오류는 로컬 진단과 불명확 영수증을 남기고 추가 쓰기를 막는다.
- 성공은 별도 DWG 저장과 재취득까지 통과했을 때만 반환한다. 초기 표시/검수는 기존 DwgReader의 지원 범위를 사용하며 지원 밖 결과를 일부 누락한 성공으로 반환하지 않는다. 객체 표현의 확장은 해당 호스트 SPEC과 검증을 먼저 추가한다.

### ZWCAD 후보 편집 창 연결

> 2026-09-30 [ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md) 이전 사본·후보 경로의 기록이다. 연결 도면의 AI 편집은 연결 DLL의 `direct-execute`·`direct-undo`(§4 「바로 적용 경로」)를 쓰며, 아래 후보 편집 창·고정 적용은 새 AI 편집 기능에 붙이지 않는다.

PLAN-02 §6.1의 3b는 먼저 후보 파일을 해시 검증하고 별도 편집 사본을 만든 뒤 자체 SDK 명령으로 연다. 후보 산출물 자체를 사용자 편집 파일로 열어 덮어쓰지 않는다. 전용 프로세스의 시작 시각·세션·포트와 실제 열린 Document 참조를 고정하며 사용자 활성 창 검색/COM attach를 사용하지 않는다. 편집 창은 제어기 종료에도 유지하고 자동 종료하지 않는다.

편집 연결은 범용 코드 실행과 분리한다. 고정 조회·재취득만 먼저 제공하고 원본 적용은 검토한 후보와 문서 기준을 비교하는 고정 동작으로 별도 연결한다. Save As·문서 닫힘으로 이름/대상 대응이 달라지면 기존 연결을 거절한다. 화면 열기 성공과 원본 적용 지원을 같은 것으로 표시하지 않는다.

ZWCAD 적용은 취득한 sourceDocument의 문서 해시와 후보 파일 해시를 고정한다. 지원 범위는 DwgReader가 편집 가능으로 검증한 mm·독립 직선 XY 폴리라인이며 양쪽에 그룹/외부 데이터/잠긴 레이어 등 미검증 관계가 있으면 거절한다. 후보에 있는 기존 Handle은 그대로 수정하고 없는 기존 객체는 삭제, 새 Handle은 네이티브 복제 추가 후 새 대응을 기록한다. 적용 직전 기준 재검사, 문서 잠금·트랜잭션, 적용 후 재취득과 영수증을 사용한다. 적용 함수는 C# 본문을 받지 않으며 동일 작업 ID의 불명확 결과를 재실행하지 않는다. 이 범위의 적용이 불가능하면 후보 편집 사본만 열 수 있다고 표시한다.

검사 사본의 SaveAs는 문서 잠금 안에서 Document.PushDbmod/PopDbmod를 짝지어 기존 저장/미저장 플래그를 보존한다. 취득은 파일명·Handle·Undo 표식을 보존하는지 설치본으로 검증한다. SDK에 선언됐더라도 미구현인 UndoRecording getter에는 의존하지 않는다.

### 생성 코드 검사와 진단 계약

Rhino 실행기는 컴파일된 코드를 로드하기 전에 Roslyn 의미 분석으로 금지 API와 메서드 본문 밖의 선언을 검사한다. 정책 거절은 `CODE_POLICY_REJECTED`와 제한된 심볼 진단을 반환하며 컴파일 실패처럼 쓰기 전 오류다. 정상 SDK 기하·객체 변경을 고정 템플릿으로 제한하는 규칙은 아니다. 새 파일 접근이 필요하면 임의 경로 권한을 열지 않고 검증된 작업 자산 API로 제공한다.

실행이 시작된 뒤 예외는 `HOST_RESULT_UNKNOWN`을 유지한다. 실제 예외 원문은 소유 작업 디렉터리의 `<진단 UUID>.diagnostic.txt`에만 저장하고, 응답/작업 기록에는 `diagnosticId`와 `exceptionType`만 전달한다. 진단 저장 실패도 쓰기 재시도를 허용하지 않는다. 동일 operationId는 기존 불명확 영수증을 반환하고 새 쓰기는 차단한다. 원문 진단 파일은 웹 공유·일반 모델 내보내기에 포함하지 않는다. 이것은 SPEC-02.3의 불명확 쓰기/필요 진단 규칙의 물리 구현이며 샌드박스 보증이 아니다.

### SDK 문서 취득과 토큰 사용

배포에는 지원 버전·짧은 진입 지침·검증 예제·도우미 설명을 포함한다. 실제 컴파일은 설치본 SDK/어셈블리를 참조한다. 배포권이 확인된 XML 문서/메타데이터는 로컬 심볼 색인으로 제공한다. AI는 필요할 때 관련 시그니처·오버로드·예제만 조회한다. 자료가 없거나 버전 차이가 있으면 공식 원문을 조회하고 호스트/SDK 버전·출처·조회 시각과 함께 캐시한다. 전체 SDK 문서를 매 호출에 넣거나 매 작업 웹 검색을 의무화하지 않는다.

SDK 업데이트 때 관련 캐시를 무효화하고 과거 작업의 참고 버전은 보존한다. 컴파일·실제 실행 결과를 최종 근거로 사용한다. 별도 벡터 DB/RAG 서버 없이 심볼·키워드 조회부터 구현한다. 공식 참조는 [RhinoCommon API](https://developer.rhino3d.com/api/rhinocommon)와 [가이드](https://developer.rhino3d.com/guides/rhinocommon/)다.


<a id="detail-2"></a>

## 3. 메시지와 도구


공통 application 요청/결과는 JSON으로 검증하며 MCP HTTP는 공식 SDK에 맡긴다. 첫 연결의 Rhino 전송 어댑터는 기존 프레임을 그대로 사용한다. 자체 애드인의 transport adapter만 교체 가능하게 나누고, 후보 전송의 프레이밍·보안은 동일 payload 시험 후 고정한다. AI에게 내부 전송 형식을 노출하지 않는다. 런타임 스키마와 호스트 DTO 계약 시험은 대상·값·오류 의미를 대조한다.

| 메서드 | 내용 |
|---|---|
| hello | protocol major/minor, 실행 세션, 호스트/SDK 버전, 언어·문서·취소 능력 |
| documents.list / objects.query | 대상 목록, 페이지·필드 선택 조회. 전체 모델 자동 전송 금지 |
| execution.start / execution.get / execution.cancel | 실행 접수, 영속 작업 상태, 중단 요청 |
| changes.read | 이벤트 순번 이후 변경 조회. 유실 시 resyncRequired |
| artifacts.describe | 코드/형상/결과 자산 ID·해시·크기·형식 |

### 전송 선택에 영향을 받는 범위

PLAN-02 §6의 비교는 연결 어댑터를 선택하는 과정이다. 대상 문서 고정, 권한, 실행 식별, 실제 결과·오류·불명확 상태라는 의미와 AI의 최소 입력은 전송과 독립적으로 유지한다. MCP의 JSON-RPC 요청 ID와 호스트의 operationId를 같은 식별자로 강제하지 않는다.

전송에 따라 바뀌는 것은 메시지 포장/프레이밍, 연결·인증, 진행 통지, 재접속과 취소 전달 방식이다. stdio 종료는 호스트 작업 취소와 같지 않으며 HTTP 연결 종료도 실행 실패의 증거가 아니다. 공급자가 진행 통지나 세션 개입을 지원하지 않으면 이 문서 §3의 상태 조회·재시작 대안으로 연결하고 능력을 명시한다. 도구 이름/설명은 실제 모델의 오용·추가 호출을 보고 조정하되 전송마다 별도 업무 규칙을 만들지 않는다. 선택한 연결로 필수 동작을 표현할 수 없다면 계약을 몰래 축소하지 않고 해당 후보를 탈락시킨다.

### AI 도구와 내부 계약 분리

AI 도구의 이름은 등록부 하나가 정한다. `src/ai/agent-connection.ts`의 `agentToolNames`가 이름 목록이고 `src/server/agent-tools.ts`의 정의(설명·zod 입력 스키마)가 두 목록이 다르면 로드를 거절한다(PLAN-24 T-062). 턴이 받는 도구는 모드에 따라 다음과 같다(2026-10-01 등록부 기준). 계획 모드 턴은 `PLAN_MODE_TOOLS`(`src/server/agent-tools.ts`)에 든 읽기·화면 도구만 받는다.

| 모드 | 발급 조건 | 도구 |
|---|---|---|
| 모델링(호스트 작업) | 자동 모드: Rhino·ZWCAD 연결 문서를 쓰는 턴(ADR-022). 계획 모드: 같은 대상을 읽기만 하는 턴 | 자동: `query`, `execute`(= `direct-execute`, 호출 하나가 되돌리기 기록 하나). 계획: `query`. `query`·`execute`·`capture_view`·`measure`는 선택 인수 `linkId`(연결 파일 ID)를 받는다: 생략하면 대상 문서, 주면 같은 프로젝트의 열린 연결 문서(ADR-027, 아래 「여러 파일 턴」). 범위가 `linkId`를 받지 않는 턴(ZWCAD 대상·작업 사본·연계 요청)은 `LINK_NOT_LIVE`. 처리기가 없던 `status`·`cancel`은 지웠다(ADR-031 8) |
| 보기(Rhino) | Rhino 대상의 모델링 턴(바로 편집은 연결이 보기 메서드를 가질 때만. 없으면 목표 문장에도 넣지 않는다) | `capture_view`(대상의 모델 화면 PNG, 기본 1200×800·한 변 최대 1600 px, `fitIds`·`namedView`, 이 이미지에만 레이어 켜고 끄기, 문서 변경 없음, 한 번에 하나), `measure`(객체별 bbox·길이·면적·닫힌 솔리드 부피 최대 50개, 객체·점 쌍의 최단 거리 최대 20쌍, 모델 단위) |
| Grasshopper(ADR-033, 2026-10-06) | 연결 Rhino 문서의 바로 편집 턴에서 연결이 `grasshopper` 메서드를 가질 때(`DirectDriver.grasshopper`). 읽기 넷은 계획·자동, 쓰기 다섯은 자동만이고 턴 안에서 한 번에 하나(`writeTools`). 모두 `linkId`로 다른 열린 Rhino 연결 문서의 Grasshopper를 고른다. 처리기는 `src/server/grasshopper-tools.ts`, 호스트 메서드는 `gh-state`·`gh-components`·`gh-apply`·`gh-solve`·`gh-outputs`·`gh-capture`·`gh-open`·`gh-save`(`hosts/rhino/worker/Grasshopper/*`, 호출 시간 600초) | 읽기: `gh_state`(문서 목록·객체·소켓·연결·값·메시지·그룹, `ids`·`area`·`since`·`offset`/`nextOffset`), `gh_components`(설치 컴포넌트 검색, guid·입출력), `gh_outputs`(경로·개수·형식·앞 항목·경계 상자), `gh_capture`(보이는 캔버스 문서의 PNG). 쓰기: `gh_apply`(`ops[]` 차례 적용 → `GH_UndoRecord` 하나, `undoId` `gh:<문서>:<기록>`, 작업별 `results[]`·`$ref`·`revision`·`notices`(`GH_CHANGED_BY_OTHERS`), 기록은 `executions[]`에 `kind: 'grasshopper'`), `gh_solve`, `gh_bake`(본문을 `direct-execute` `language: gh-bake`로: Rhino 기록 하나·실행 대기열), `gh_open`·`gh_save`(프로젝트 작업 폴더 안 경로만, `GH_OUTSIDE_WORK_FOLDER`). 캔버스 쓰기는 문서 잠금·실행 대기열을 쓰지 않고(다른 대화와 동시), 여러 파일 요청의 자동 되돌림에서 빠진다. `direct-undo`의 `gh:` ID는 그 문서 되돌리기 목록의 첫 기록일 때만 되돌리고 아니면 `gh-not-latest` |
| 대화 읽기(jig·구조·Sync) | 목적별 대화의 턴. 대상은 `conversation:<대화 ID>` | `jig_list`, `jig_state`, `jig_output`, `structure_summary`, `structure_checks`, `links_layers`, `sync_sample` |
| 화면 | 대화 원장에 기록하는 턴(목적별 대화). 계산·쓰기 없음이라 계획 모드에도 남는다(`PLAN_MODE_TOOLS`) | `jig_open`(프로젝트 skill 목록의 jig를 사용자 화면에 열고 작업본을 이 대화에 묶음, `reuse: 'last' \| 'new'`, `user-only` jig는 거절), `ui_go`(화면 전환: 모델·jig·보고서·자료·만들기, 3D 투영 `plan`·`3d`). 원장 항목으로 남기고 화면이 따라 한다(RESEARCH-12 §6.3) |
| jig 조작 | 그 대화에 jig 작업본이 열려 있을 때, 열린 작업본에만 | `jig_set`(되돌릴 수 있는 설정값 변경, 원장 기록), `jig_run`(계산 단계만) |
| 할 일 | 대화의 턴: 목적별 대화의 턴과, 대화에 속한 호스트(모델링) 턴(기본 대화, 대상이 여럿인 연계 턴 포함; `Execution.readAgent`가 호스트 도구 옆에 더함). 쓰기 둘은 대화 원장에 기록하는 턴에만(되돌리기에 원장이 필요), 계획 모드는 `agenda_list`만. 호스트 파일이 아니라 프로젝트에 대한 도구라 대상이 여럿인 턴에서도 `targetRef`를 생략할 수 있다(`projectScoped`, `src/server/agent-tools.ts`) | `agenda_list`, `agenda_add`, `agenda_set`(아래 「대시보드의 할 일」) |
| 자료 | 그 프로젝트의 자료 DB가 있을 때, 읽기만 | `project_brief`, `project_search`, `project_issue`, `project_statement`, `project_checks` |
| 첨부 | 요청이나 같은 대화의 앞선 요청에 보관 첨부가 있을 때 | VIDE 도구 없음(ADR-031 8): CLI의 기본 읽기 도구가 보관 경로로 읽는다(아래 「첨부 보관과 읽기 도구」) |
| 파일 | 지시 묶음을 받는 턴(jig AI 검토·만들기 턴 제외) | VIDE 도구 없음(ADR-031 8): CLI의 기본 읽기·검색·쓰기·셸 도구가 프로젝트 작업 폴더에서 돈다(위 「AI 실행 인자」의 작업 폴더 도구, 아래 「프로젝트 폴더와 파일 도구」) |
| 프로젝트 읽기(호스트 턴) | 모든 호스트 모델링 턴(Rhino·ZWCAD 바로 편집, 작업 사본, 연계 요청; 계획·자동). 대화 밖 요청은 프로젝트 기본 대화(`default-<프로젝트>`)의 범위. 호스트 도구와 같은 범위에 더하고(`HOST_TURN_PROJECT_TOOLS`·`hostTurnProjectHandlers`, `src/server/execution.ts`), 대상이 여럿인 연계 턴에서도 `targetRef`를 생략할 수 있다 | `links_layers`, `sync_sample`, 자료 DB가 있으면 `project_*` 다섯. jig 조작·만들기 도구는 주지 않는다. 원장에 쓰는 도구는 대화에 속한 턴의 할 일 쓰기(위 「할 일」 행)뿐이다. 지시(`hostProjectNote`, `modeling.md`)는 열린 연결 파일은 `linkId`로 실시간으로 다루고, 닫힌 파일·`LINK_NOT_LIVE`인 파일은 이 저장 기록으로 읽으라고 알린다 |
| 만들기 | `jig-make` 대화이고 초안이 열려 있을 때. `targetRef`를 생략하면 그 대화의 초안 | `jig_validate`, `jig_test`, `jig_preview`, `jig_delete_file`(초안 파일 하나, `jig.json`·금지 파일 제외), `ask_user` + Claude 파일 도구 `Read`·`Edit`·`Write`·`Glob`·`Grep`(초안 폴더만, ARCH-03 §2.3) |

대화 턴은 위 행 가운데 조건을 만족하는 것을 합쳐 받는다. 모델에 주는 지시는 모드별로 다르다(`instructionFor`: 호스트 도구·대화 도구·만들기). 옛 설계의 `discover`와 자산/SDK 조회 도구는 등록부에 없다. 보기 도구는 5차 물결에서 더했다. 호스트 작업 도구의 기본 실행 인수는 다음과 같다.

```json
{"targetRef":"VIDE가 조회 결과에 발급한 참조", "code":"AI가 작성한 코드"}
```

targetRef는 실행 세션·열린 문서·관측 기준에 연결된 opaque 참조다. 언어와 함수 인수는 필요할 때만 선택적으로 전달한다. 짧은 코드는 직접 받고 자산 등록→ID 조회→실행을 강제하지 않는다. AI에게 ID·권한·버전·정밀 변경 집합을 작성하게 하지 않는다.

VIDE 내부에서 protocolVersion, operationId, taskId, 실제 대상(hostSessionId/documentSessionId/documentId), 관측 기준, 권한, 단위, 보존 대상, 실행 상한을 붙인다. 기준은 원 사용자 입력과 조회 결과에서 얻으며 실행 직전 최신 상태로 몰래 바꾸지 않는다. read/write set은 가능한 경우 자동 수집하고 집합을 알 수 없는 임의 코드는 문서 기준을 보수적으로 검사한다. 무관 변경 거절률을 측정해 정밀 검사를 단계적으로 적용한다. 임의 코드의 영향 범위를 사전 완전 추론할 수 있다고 주장하지 않는다.

결과에는 operationId, 상태, 실제 대상, 변경 전후 기준, 실제 호스트에서 관측한 추가/수정/삭제, 진단과 자산 참조를 담는다. 빠른 작업은 실제 결과를 바로 반환하고 장기 작업만 operation handle과 진행 통지로 전환한다. 상태는 SPEC-00.10을 따르고 코드가 출력한 성공 문장을 실행 성공으로 취급하지 않는다. 컴파일 실패는 쓰기 전 실패이며 실행 예외는 사후 조사 전 미반영으로 단정하지 않는다.

필수 차단은 권한·대상·중복 쓰기·손상 입력에 적용한다(ADR-031 8). 문서가 마지막 조회 뒤 바뀐 것(`DOCUMENT_CHANGED`)과 앞 요청의 결과 미확인(`HOST_RESULT_UNRESOLVED`)은 실행을 막지 않고 실행 결과의 `notices[]`로 알린다. 한 턴에서 실행의 답을 잃으면(`uncertain`) 그 턴의 다음 실행만 `HOST_RESULT_UNKNOWN`으로 답하고 조회·보기·측정은 계속된다. 쓰기 도구(`execute`·`jig_set`·`jig_run`, Grasshopper 쓰기 다섯)만 턴 안에서 한 번에 하나이고(겹치면 `AGENT_BUSY`), 읽기 도구는 함께 돈다(`capture_view`끼리는 차례로 기다린다). 코드 스타일·권장 조회 순서·예제 불일치로 거절하지 않는다. 오류 때 필요한 진단만 반환하고 전체 지침을 반복하지 않는다: 오류 코드에는 다음 행동(`next`, `errorHints`)을 붙이고, 입력 스키마 오류는 `INVALID_INPUT`과 함께 틀린 필드(`fields[{field, problem}]`)를 준다. 프롬프트 대신 일반 코드가 기록·검사를 수행한다.

제어 메시지는 초기 1 MiB 제한, 큰 형상/코드는 자산으로 분리한다. 자산은 opaque ID·해시·크기·형식으로 검증하며 사용자 제공 절대 경로를 그대로 열지 않는다. 파일을 임시 위치에 쓴 뒤 검증·확정하고, AI 응답에는 작은 요약/페이지/참조만 보낸다. 수치 제한은 실모델 시험으로 조정한다.

major 불일치는 연결 거절, minor 추가 필드는 협상된 능력 안에서 허용한다. 요청 ID는 통신 응답 대응, operationId는 재접속 후 작업 식별이다. 같은 operationId+동일 payload는 기존 상태를 반환하고 다른 payload는 거절한다. 호스트에도 실행 전 접수·시작 저널을 기록한다. CAD 변경과 저널을 하나의 원자 트랜잭션으로 만들 수 없으므로 exactly-once를 주장하지 않는다. 변경 후 응답/기록 유실은 unknown으로 조사하며 자동 재실행하지 않는다.

목적별 대화(SPEC-02.19)에서는 도구 범위를 대화 종류 × jig 출처로 턴마다 발급하고 턴이 끝나면 회수한다. 발급은 `AgentTools`의 범위(scope)다. 호출 횟수 상한은 없고(ADR-031 7, `maxCalls`는 받기만 한다), 유효 시간은 호출 사이의 시간이다(기본 1시간, 호출마다 다시 잼; 턴이 끝나면 회수). 도구 결과가 약 96 KB(`RESULT_BYTES`)를 넘으면 실패시키지 않고 잘라서 준다(`bounded`): 쪽 결과는 들어가는 행까지와 `truncated: true`·`nextOffset`·`next`, 그 밖은 앞부분(`partial`)과 `truncated: true`·`next`. `capture_view`의 이미지가 5 MB(`TOOL_IMAGE_BYTES`)를 넘으면 가로세로를 반씩 줄여 최대 세 번 다시 찍는다. 대화 도구는 엔진 저장소(작업본·단계 결과·Sync·자료 DB)만 읽고 호스트 문서를 직접 열지 않는다. 도구별 입력 스키마의 정본은 `src/server/agent-tools.ts`의 정의다.


### 첨부 보관과 읽기 도구

SPEC-01.12(2026-10-01). 작성기의 파일·이미지 첨부는 내용을 요청에 싣지 않고 엔진이 보관한 파일을 가리킨다.

- **보관:** `POST /api/v1/projects/:p/attachments?name=<파일 이름>`(본문 `application/octet-stream`)이 `<데이터 폴더>/attachments/<projectId>/<id>.<ext>`에 쓰고 `<id>.json`에 기록을 둔다. `id`는 내용 SHA-256의 앞 24자(16진)라 같은 내용은 한 번만 보관한다. 먼저 같은 폴더의 임시 파일에 받으며 해시·크기를 센다. 크기 상한은 없다(ADR-031 7). 확장자는 이름에서 영숫자 10자까지만 쓴다. 응답과 요청의 첨부 항목은 `{id, name, size, type, kind, path, copied}`다. `kind`는 내용으로 판별한 `text | image | pdf | rhino-3dm | dwg | binary`, `type`은 판별한 MIME(이미지·PDF) 또는 브라우저가 준 형식, `path`는 보관본의 절대 경로, `copied`는 지금 늘 `true`다. 나중에 프로젝트 폴더의 읽기 전용 접근을 고르면 `copied: false`와 원본 경로를 쓸 수 있게 둔 자리이며, 그때도 엔진은 허용한 폴더 밖 경로를 열지 않는다.
- **요청 필드:** `requestInputSchema.files`의 항목은 이전 본문 첨부 `{name, text, …}` 또는 위 보관 첨부다. 개수·크기 합계 상한은 없다(ADR-031 7, `src/contracts/workspace.ts`). 접수(`POST …/requests`) 때 서버가 각 `id`를 그 프로젝트의 보관 기록과 맞춰 `size`·`type`·`kind`·`path`·`copied`를 기록 값으로 덮고, 없는 `id`는 `INVALID_INPUT`이다. 브라우저가 보낸 경로는 쓰지 않는다.
- **미리보기·보기본:** `GET …/attachments/:id`는 `kind = image`인 보관본만(보기본이 있으면 보기본) 판별한 이미지 MIME과 `X-Content-Type-Options: nosniff`로 돌려준다(작성기 칩의 미리보기, CSP `img-src 'self'`). 그 밖은 404. 1MB를 넘는 이미지는 작성기가 긴 변 1600px JPEG를 만들어 `POST …/attachments/:id/view`(PNG·JPEG, 1MB 이하)로 보내고 `<id>.view`로 둔다. 서버에 이미지 축소 의존성은 두지 않는다.
- **AI가 읽는 법(ADR-031 8):** VIDE 도구는 없다. 그 요청과 같은 `conversationId`의 요청들에 붙은 보관 첨부의 보관 경로(`AttachmentStore.get`의 `path`, 브라우저가 보낸 경로가 아님)가 그 턴의 작업 폴더 `attachments`가 되고, CLI의 기본 읽기 도구(Claude `Read`, Codex 셸·`view_image`)가 패킷의 `file` 항목 `path`로 읽는다. 게이트는 이 경로만 VIDE 데이터 폴더 금지보다 먼저 읽기로 허용한다. 형식별 처리(이미지·PDF 등)는 CLI 도구의 것이다. `AttachmentStore.read`(바이트 구간·보기본)는 남아 있으나 AI 경로는 쓰지 않는다.
- **지시:** 작업 폴더 규칙(`workFolderRule`)이 '첨부는 file 항목의 경로로 읽는다'를 담는다.
- **경로 칩(SPEC-01.12의 6, PLAN-31):** `POST …/attachments/path-kinds {paths}`(최대 64개)는 각 경로를 `{path, kind: 'file'|'folder'|null, name}`으로 돌려준다(`items`). 절대 경로가 아니거나 장치 경로, 없음, 금지 위치·비밀 이름(입력·실제 경로), 드라이브·UNC 공유 맨 위는 `null`. `POST …/attachments/from-path {path}`는 형식과 관계없이 그 파일을 위 보관과 같이 복사한다(폴더는 `INVALID_INPUT`, 금지 위치·비밀 이름 `FILE_FORBIDDEN`, 없음 `FILE_NOT_FOUND`). 둘 다 원격 세션이면 `FORBIDDEN`(`src/server/attachment-paths.ts`). 작성기의 경로 후보 추출은 `src/ui/path-tokens.ts`(`pathSpans`)다.
- **폴더 칩의 요청 필드:** `requestInputSchema.folders?: {name, path}[]`(최대 64). 접수(`POST …/requests`, 새 요청만) 때 서버가 각 `path`를 `checkFolder`로 다시 검사해 실제 경로로 바꾸고(`FOLDER_NOT_FOUND`·`FOLDER_NOT_ALLOWED`), 원격 세션이면 `FORBIDDEN`, 다시 보낸 요청은 처음 기록을 쓴다. 개입(`…/interventions`) 본문의 `folders`는 버린다. `Execution.fileGate`가 이 경로를 `WorkFolderGate`의 `granted`로 넘겨 그 턴의 읽기 판정 ③에서 `read` 폴더처럼 허용한다(작업 폴더 값 `dirs`에는 넣지 않는다 — Codex 쓰기 루트가 되지 않게). 패킷에는 항목 `{type:'folder', data:{name, path}}`로 간다.
- **삭제:** 프로젝트 삭제(`purgeProject`)가 `attachments/<projectId>` 폴더를 함께 지운다.

### 프로젝트 폴더와 파일 도구

SPEC-01.13(2026-10-01, ADR-031 8로 2026-10-02 바뀜). 프로젝트가 가리키는 이 PC의 폴더(작업 폴더)와, AI CLI의 기본 파일·셸 도구가 그 안에서 바로, 밖에서는 사용자 승인으로 일하게 하는 엔진의 판정이다.

- **저장:** schema 6의 `project_folders(projectId, path COLLATE NOCASE, kind 'project'|'read', addedAt, PRIMARY KEY(projectId, path))`(`src/core/project-folders.ts`). `path`는 실제 위치(`realpath.native`로 정션·심볼릭 링크를 푼 절대 경로)다. `project`는 대시보드에서 정한 프로젝트 폴더, `read`는 권한 질문의 [이 폴더는 항상]이 더한 읽기 허용 폴더다. 같은 경로를 `project`로 더하면 `read` 행을 올리고, `read`로 더할 때 이미 `project`면 그대로 둔다. 프로젝트 삭제가 행을 지운다.
- **경로:** `GET …/folders` → `{folders:[{path, kind, addedAt, exists}]}`. `POST …/folders {path, kind?='project'}`와 `POST …/folders/remove {path}`는 바뀐 목록을 돌려준다. 원격 세션은 `GET`만(SPEC-01.13의 1). 더하기 검사(`checkFolder`, `src/server/project-files.ts`): 절대 경로이고 장치 경로(`\\?\`·`\\.\`)가 아님(아니면 `INVALID_INPUT`), 있고 폴더임(아니면 `FOLDER_NOT_FOUND`), 드라이브 맨 위·UNC 공유 맨 위·VIDE 데이터 폴더(현재 엔진의 것과 설치본 `%LOCALAPPDATA%\VIDE`)와 그 안·아래 금지 위치와 그 안이 아님(아니면 `FOLDER_NOT_ALLOWED`).
- **PC 프로그램의 폴더 선택:** 페이지가 WebView2 메시지 `{type:'folder:pick', id}`를 보내면 셸(`ShellContext.Handle` → `ShellForm.PickFolder`)이 Windows 폴더 선택 창을 열고 `{type:'folder:picked', id, path}`(취소면 `path: null`)를 돌려준다. 경로 검사는 위의 엔진 검사가 한다. 브라우저(셸 밖)와 이 메시지를 모르는 이전 셸에서는 경로 입력칸을 쓴다.
- **도구(ADR-031 8):** VIDE의 `file_list`·`file_read`는 지웠다. 턴은 CLI의 기본 도구를 받는다(위 「AI 실행 인자」의 작업 폴더 도구). 작업 폴더 값(`WorkFolders`, `src/ai/agent-connection.ts`): `cwd` = 첫 `project` 폴더(실제 경로, 없으면 없음), `dirs` = 나머지 `project` 폴더와 `read` 폴더, `attachments` = 그 턴의 보관 첨부 경로, 계획 턴은 `readOnly`. `Execution.workFolders`가 만든다.
- **판정**(`WorkFolderGate.decide`, `src/server/project-files.ts`): 요청 하나를 경로·동작으로 푼다 — 읽기(`Read`·`Glob`·`Grep`: `file_path`·`path`, CLI가 준 `blocked_path` 우선, 없으면 작업 폴더) / 쓰기(`Edit`·`Write`·`MultiEdit`·`NotebookEdit`, Codex 파일 변경의 `paths`) / 실행(`Bash`·`PowerShell`: `cwd`와 명령 인자에 적힌 경로, `commandPaths` — 드라이브·UNC·`/c/…`·`~` 경로, 따옴표 안 스크립트도 훑고, 맨 앞 프로그램 경로는 뺀다). 경로마다: ① 읽기이고 그 턴의 첨부 경로면 허용 ② 금지 위치(입력·실제 경로)면 `FILE_FORBIDDEN` 메시지로 거절(묻지 않음) ③ 실제 경로(없는 파일은 가장 가까운 상위의 실제 경로)가 `project` 폴더 안이면 허용, 읽기면 `read` 폴더 안도 허용 ④ 계획 턴의 쓰기는 거절 ⑤ 이번 요청의 허락(읽기 `allowed`, 쓰기·실행 `written`; 쓰기 허락은 읽기도 덮음)·거절(`denied`·`refused`) ⑥ 그 밖은 권한 질문. 정션·링크로 폴더 밖을 가리키는 경로는 실제 경로로 판정하므로 밖으로 묻는다. 경로를 알 수 없는 Codex 파일 변경과 경로 없는 Codex 승인 요청(네트워크 등)은 그 변경·명령 자체를 묻는다. 셸 판정은 인자에 적힌 경로만 보며 프로그램이 스스로 여는 경로는 보지 못한다(스크립트 정책처럼 방어선이지 OS 경계가 아니다).
- **권한 질문:** `Execution.askFilePermission`이 공급자 자체 질문과 같은 대기 경로(요청 결과 `phase: 'question'`·`questions`, 답은 `POST …/requests/:r/questions`)로 카드 하나(`id:'file-access'`)를 띄우고 CLI의 권한 요청 안에서 답을 기다린다(턴 시계는 멈춤). 읽기: `{title:'AI가 프로젝트 작업 폴더 밖의 파일을 읽으려 합니다 · <경로>', blocks:'AI 파일 읽기', options:[once 이번만, always 이 폴더는 항상, deny 거절(권장)]}`. 쓰기·실행: '…밖에 파일을 쓰려 합니다'·'…밖에서 명령을 실행하려 합니다', `blocks` 'AI 파일 쓰기'·'AI 명령 실행', `options:[once 이번만, deny 거절(권장)]`. 한 요청의 질문은 차례로 하나씩이다. 기다리는 시간은 5분(`PERMISSION_WAIT_MS`)이며, 지나거나 턴이 멈추면 카드를 거두고 거절(`FILE_ACCESS_DENIED` 메시지, 그 턴에 다시 시도하지 말라는 안내)이다. `always`는 그 폴더를 `checkFolder`로 검사해 `read` 행으로 더하고(검사에 걸리면 이번만), 원격 세션의 답이면 이번만으로 처리한다. 대화가 아닌 단일 요청(카드를 보일 곳 없음)은 묻지 않고 거절한다. 거절은 그 호출 하나만이고 턴은 계속된다.
- **프로젝트 기록**(ADR-031 6, ADR-032, `ownProjectData`): 나뉜 데이터 폴더에서 그 턴 프로젝트의 `projects/<projectId>` 안은 ②보다 먼저 판정한다. 읽기는 묻지 않고 허용(`프로젝트 기록 읽기 · 경로`), 쓰기는 늘 거절(`FILE_FORBIDDEN`, 묻지 않음), 실행은 명령이 SQLite를 읽기만 할 때 허용한다(`readOnlySqlite`: 여는 DB마다 읽기 전용 표시 — `node:sqlite` `readOnly: true`, `sqlite3 -readonly`, URI `mode=ro` — 가 있고 SQL·셸의 변경 낱말(`INSERT`·`UPDATE`·`DELETE`·`DROP`·`ALTER`·`CREATE`·`VACUUM`·`ATTACH`, `PRAGMA x=`, sqlite3의 `.output`·`.save`·`.backup` 등, `writeFile`·`rm`·`del`·`Remove-Item`·`Set-Content` 등)이 없음). 그 밖의 명령은 묻지 않고 거절하며 읽기 전용으로 열라는 메시지를 준다(묻고 허락하면 쓰기가 될 수 있어서). 실제 경로가 그 폴더 밖(정션)이거나 비밀 이름이면 금지다. `app.sqlite`·다른 프로젝트 폴더·`launch.json` 등 데이터 폴더의 나머지는 ②대로 금지이고, 나뉘기 전(하나의 DB)에는 데이터 폴더 전체가 금지다. 작업 폴더 값의 `records`가 이 폴더를 턴 규칙에 알린다.
- **금지 위치**(`deniedPath`): VIDE 데이터 폴더(현재·설치본; 위 프로젝트 기록은 예외), 사용자 폴더의 `.ssh`·`.aws`·`.gnupg`·`.azure`·`.kube`·`.docker`·`.claude`·`.codex`, 어느 위치든 경로 조각 `.ssh`·`.gnupg`·`.aws`, `%APPDATA%\Microsoft\{Credentials,Protect,SystemCertificates}`, `%LOCALAPPDATA%\Microsoft\Credentials`, `%LOCALAPPDATA%\{Google\Chrome,Microsoft\Edge}\User Data`, `%APPDATA%\Mozilla\Firefox`, 이름 `.env`·`.env.*`, `.git-credentials`, `.netrc`·`_netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `id_rsa`·`id_dsa`·`id_ecdsa`·`id_ed25519`(공개 키 `.pub`는 아님), `credentials`·`credentials.json`·`.credentials.json`, 확장자 `.pem`·`.key`·`.pfx`·`.p12`·`.kdbx`·`.ppk`·`.jks`·`.keystore`. `file_list` 결과에서도 뺀다.
- **기록:** 묻거나 거절한 사용마다 요청의 `activity`에 경로만 한 줄(`파일 읽기 허용 · 경로`, `파일 쓰기 거절 · 경로`, `명령 실행 거절 · 경로`, 금지 위치는 `파일 거절 · 경로`)을 더한다. 작업 폴더 안의 사용은 CLI 진행 이벤트(도구 이름)로만 보인다. 내용은 남기지 않는다.
- **지시:** 턴 규칙 끝에 `workFolderRule`(작업 폴더 경로, 밖은 호출하면 VIDE가 묻는다, 거절되면 다시 시도하지 말 것, 프로젝트 기록 폴더(`records`)는 묻지 않고 읽기 전용, 키·로그인·그 밖의 VIDE 데이터는 읽지 않음, Rhino·CAD 문서는 이 도구나 파일로 열거나 고치지 않고 `execute`로만)이 붙고, 공통 지침(`src/ai/instructions/common.md`)도 같은 내용을 적는다.

### 참고 이미지 확인 보드

SPEC-09(PLAN-26 T-090, 2026-10-01). 이미지 첨부 하나의 영역·해석 판·이미지 작업을 엔진이 프로젝트별로 보관한다(`src/server/reference-boards.ts`, 계약 `src/contracts/reference-board.ts`).

- **저장:** 보드 기록 `<데이터 폴더>/reference-boards/<projectId>/<attachmentId>.json`(영역 벡터 도형·글자·메모, `stage`, `conversationId`, `versions[]`(판), `pending`(답하는 중인 요청), `problem`), 영역을 그린 입력 이미지 `<attachmentId>.masked.png`(긴 변 1600px 이하 PNG), 프로젝트 설정 `settings.json {images}`. 산출물(SPEC-09.9) `<데이터 폴더>/outputs/<projectId>/reference/<attachmentId>/`: 최근 3D 뷰 캡처 `view.png|jpg`, 판별 캡처 `v<N>-view.*`, 생성 이미지 `v<N>.png`. 쓰기는 같은 폴더의 임시 파일 뒤 이름 바꾸기, 보드마다 한 번에 하나(페이지 저장·턴 끝·이미지 작업). 프로젝트 삭제가 두 폴더의 `<projectId>`를 지운다. 첨부 원본은 복사·수정하지 않는다.
- **경로:** `GET·PUT /api/v1/projects/:p/reference-boards/:a`(읽을 때 끝난 요청의 `pending`을 정리), `POST·GET …/masked`·`POST …/view`(`application/octet-stream`, 입력 8MB·캡처 4MB 이하 PNG/JPEG), `GET …/images/:n`(PNG, `nosniff`), `POST …/image {version}`([다시 생성], 원격은 `FORBIDDEN`), `POST …/image/cancel`, `POST …/continue`([새 판으로 고치기]: 확정 판을 고칠 수 있는 다음 판으로 복사), `GET·PUT /api/v1/projects/:p/reference-settings {images}`(PUT은 이 PC만). 이미지 첨부가 아니면 `NOT_FOUND`.
- **해석 턴:** 보드는 일반 접수 경로 `POST …/requests`에 `reference: {attachmentId, action: interpret|region|confirm, letter?, note?, version?, targets?, view?}`를 실어 보낸다. 페이지(`src/ui/reference-bridge.ts`, `src/ui/app/composer.ts`가 구현)는 작성기와 같은 대화·모델·문서 기준을 쓰고, 입력 이미지는 `images[{kind:'reference'}]` 한 장(JPEG 약 140KB 이하), 원본은 `files`의 보관 첨부로 `attachment_read`가 읽는다. 서버는 배치 전 `before`(region·confirm은 그 판의 대화로, 모델 지정 없이 `fix`), 배치 뒤 `prepare`(본문·모드·호스트 사용을 정하고, 같은 보드 갱신 안에서 요청을 저장(`workspace.submit`)해 만들어졌을 때만 `pending`(region은 메모 포함)이나 확정을 기록한다: 저장이 거절되면(크기·기준 등) 보드는 그대로다. 진행 중이면 `REFERENCE_BUSY`, 확정 판 고치기는 `REFERENCE_FROZEN`, 입력 이미지 없음은 `REFERENCE_NOT_READY`)를 한다. 답하는 중에는 영역을 바꾸는 저장(`PUT`)과 입력 이미지 저장도 `REFERENCE_BUSY`다(답은 보낸 영역 기준으로 읽는다). interpret·region은 `mode: plan`, `hostUse: 'none'`이라 구조화 출력 턴이 되고, `ConversationService`의 `reference` 선택이 패킷에 `reference-board` 항목(지시, 영역 `{letter, note, box[x0,y0,x1,y1]}`, region이면 고칠 글자·메모와 현재 판)을 넣으며 출력 스키마는 `turn-output`에 `reference`(필수)를 더한 것이다(`referenceTurnSchema`, Claude `--json-schema`·Codex `--output-schema` 그대로). `reference`는 `{summary, imagePrompt, regions[{letter, element, anchor{x,y}|null, values[{name, value, unit|null, source: user|estimated|unknown}], line, openQuestions[], target}]}`이고 `turnOutputResult`가 엄격히 검사해 결과에 `reference` 또는 `referenceError`(`REFERENCE_OUTPUT_MISSING`·`REFERENCE_OUTPUT_INVALID`)로 남긴다. 그 대화에 확정 전 보드가 묶여 있으면 일반 턴에도 같은 항목(현재 판)이 붙는다. 호스트 없는 턴은 `reference`(null 허용) 출력으로, 구조화 출력이 없는 호스트·jig 턴(작성기의 계획·자동 턴)은 답 끝의 fenced json 블록 `{"reference": …}`로 고친 영역을 돌려준다. 블록은 `Execution.endTurn`이 원장 기록 전에 답에서 빼고 `takeReferenceBlock`으로 검사한다. 고친 판은 그 턴이 본 보드(결과의 `referenceBoard`)에만 생긴다. 원격 터널로 받은 요청은 서버가 `input.remote = true`로 표시하고(브라우저가 보낸 값은 버림) 그 판의 이미지는 `remote`다.
- **판:** 실행이 끝나면(`Execution` `onFinished`) `afterTurn`이 `nextVersion`으로 판을 만든다. interpret은 그린 글자(없으면 A) 전부가 정확히 와야 하고, region은 그 글자만 바꾸고 나머지는 이전 판 그대로, 말로 고친 판은 아는 글자만. 맞지 않으면 판을 만들지 않고 `problem`(`REGION_MISMATCH` 등)을 남긴다. 판 번호는 1부터 하나씩 오르고 판마다 `conversationId`·`requestId`·`kind(all|region|spoken|continue)`·`changed`·`confirmed`·`image`를 둔다.
- **이미지 작업**(`src/server/reference-image.ts`): 새 판마다(설정 꺼짐 `off`, 원격 요청 `remote`, 캡처 없음 `no-model`이 아니면) 보드당 하나만 돌고 새 판이 이전 작업을 취소한다. `codex exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --sandbox read-only`와 VIDE 공통 `-c` 격리값, `model_reasoning_effort="low"`, `codexDisabledFeatures`에서 `image_generation`·`code_mode_host`만 빼고 끔(내장 이미지 도구는 code-mode host로 돈다: codex-cli 0.157.1에서 host를 끄면 모델이 도구가 꺼졌다고 답함), `--enable image_generation`, `--image v<N>-view.* --image <a>.masked.png`, 지시문은 stdin(`imageJobPrompt`: 한 번만 생성·빠른 품질·1024 이하·글자 없음·카메라와 매스 유지 + 요약·영역 문장·`imagePrompt`). 작업 폴더는 임시 폴더, 환경은 `codexEnvironment()`(API 키 변수 제거, ChatGPT 로그인). 시간 제한 60초(시작 포함, `IMAGE_TIME_LIMIT_MS`)·[생성 취소]는 `killOwnedProcess`(taskkill /T /F, 실패하면 `kill`)로 끝내고 프로세스 종료(`close`, 최대 5초)를 기다린 뒤 작업 폴더와 그 thread 폴더를 지우며 결과를 보지 않는다(Codex는 도구 실행 전에 `thread.started`를 내므로 종료 뒤 출력에서 thread를 안다). 프로젝트 설정을 끄면 진행 중 작업을 멈추고 그 판은 `off`, 엔진 종료(`ReferenceBoards.close`, `execution.close()`와 함께)는 새 작업을 막고 진행 중 작업을 끝낸다(`IMAGE_INTERRUPTED`). 성공은 종료 코드 0과 `turn.completed`(`error` 항목은 경고라 실패로 보지 않음), 결과는 `~/.codex/generated_images/<thread>/` 안 시작 뒤 쓰인 PNG 중 최신을 `v<N>.png`로 복사하고 그 thread 폴더는 지운다. 실패 구분 `CODEX_UNAVAILABLE·CODEX_LOGIN_REQUIRED·CODEX_USAGE_LIMIT·IMAGE_REFUSED·IMAGE_NOT_CREATED·IMAGE_FAILED·IMAGE_TIMEOUT·IMAGE_CANCELLED`, 엔진 재시작으로 끊긴 작업은 `IMAGE_INTERRUPTED`. 판의 `image {state, startedAt, elapsedMs, size, code}`에 남는다. 이 PC 실측(합성 장면, 2026-10-01): 33–44초.
- **확정:** `action: confirm`은 `version`이 최신 판이어야 하고(`STALE_REFERENCE`), 대상 `unknown`인 영역이 `targets`로 답해지지 않으면 `REFERENCE_TARGET_UNKNOWN`(페이지가 먼저 `targetQuestions` 질문 카드를 보임). 이미 확정된 판의 두 번째 [맞음]은 `REFERENCE_FROZEN`이다. 통과하면 요청을 `mode: auto`(계획 모드여도)·호스트 쓰기로 바꾸고 본문을 `confirmText`(판·영역·값·출처·대상, 12KB 이하: 넘치는 영역은 '영역 n개 더'로 줄임)로 쓰며, 요청이 저장되면 판에 대상 답을 넣어 `confirmed {at, requestId}`로 고정한다. 패킷의 `reference-board` 항목은 확정 판(모든 영역)·영역 상자(`drawn`)와 추정 값 처리 지시다. 페이지는 영역을 그린 참고 이미지와 마지막 생성 이미지(각 JPEG 85,000자 이하)를 `images`로, 원본을 `files`로 함께 보낸다. [새 판으로 고치기]는 확정 판의 이미지 상태를 그대로 잇는다(준비된 이미지는 복사, 진행 중이면 같은 작업이 두 판을 채움, 꺼짐·실패 등은 그대로). 이후는 바로 적용 경로(§4, ADR-022)다.
### 대시보드의 할 일

SPEC-01.14(2026-10-01, 종류·달력 2026-10-02, 두 구역·글·파일에서 만들기·퇴근하기 2026-10-06 — PLAN-30, 기간·종류 넷·위치·참석자·큰 달력 2026-10-06 — PLAN-39). 프로젝트마다 할 일 목록 하나이며, 날짜 있는 항목이 달력의 일정이다.

- **저장:** schema 7의 `agenda_items(id, projectId FK, text, date 'YYYY-MM-DD' NULL, time 'HH:MM' NULL, doneAt NULL, ord REAL, source 'user'|'ai', revision, createdAt, updatedAt)`와 색인 `(projectId, ord)`, schema 8이 끝에 더한 `kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','meeting','deadline'))`(기존 행은 `task`). schema 11은 표를 다시 만들어(새 표 → 열 이름으로 옮기기 → 옛 표 지우기 → 이름 바꾸기 → 색인) `kind` CHECK에 `receipt`를 더하고 끝에 `endDate 'YYYY-MM-DD' NULL`, `endTime 'HH:MM' NULL`, `location NULL`(200자), `attendees NULL`(300자, 자유 글)을 붙인다(기존 행은 넷 다 NULL; 다른 표가 이 표를 참조하지 않는다)(`src/core/agenda.ts`, 모양은 `src/contracts/agenda.ts`). 종류 id는 `task`(할 일)·`meeting`(화면 이름 '협의', id는 그대로)·`receipt`(접수)·`deadline`(마감)이다. 하루 종일은 따로 열 없이 `time IS NULL`이다. 엔진이 지키는 규칙(`Agenda.add`·`set`, 어기면 `INVALID_INPUT`): `date`가 없으면 `time`·`endDate`·`endTime`도 없음, `time`이 없으면 `endTime` 없음, `endDate`가 `date`와 같으면 NULL로 저장, `endDate > date`, 같은 날이면 `endTime > time`, 빈 위치·참석자는 NULL. `set`에서 `date`만 바뀌면 `endDate`를 같은 날수만큼 옮기고, `time`만 바뀌면 `endTime`을 길이를 지켜 옮기며 그날을 넘으면 NULL로 둔다. 열이 끝에 붙으므로 쓰기는 열 이름을 적는다(위치 INSERT 금지). 날짜·시각은 PC 현지 달력의 글자이며 UTC로 바꾸지 않는다. 완료는 `doneAt`이 있음이다. 새 항목은 순서 끝(`max(ord)+1`)에 붙는다. 개수 상한은 없다(ADR-031 7). 프로젝트 삭제(`Store.deleteProject`)가 행을 지운다.
- **경로:** `GET …/agenda` → `{items}`(사용자 순서, 완료 포함; 항목에 `kind`). `POST …/agenda {text, date?, time?, endDate?, endTime?, kind?, location?, attendees?}` → `{item, items}`(시각만 있으면 오늘 날짜, `kind` 없으면 `task`). `PUT …/agenda/:id {revision, text?, date?, time?, endDate?, endTime?, kind?, location?, attendees?, done?}` → `{item, items}`; 달력의 끌어 놓기는 `{revision, date}`만 보낸다(엔진이 `endDate`를 따라 옮겨 기간 유지, 시각·종류 유지); 읽은 `revision`이 다르면 `REVISION_CONFLICT`(409), `date: null`은 시각도 비운다. `POST …/agenda/order {ids}` → 주어진 항목들이 이미 가진 `ord` 값들을 주어진 순서로 다시 나눠 가진다(다른 항목 자리·`revision`은 그대로). `POST …/agenda/:id/remove {revision?}`, `POST …/agenda/remove-done`. 지우기는 폴더 경로처럼 POST라 DELETE 허용 목록은 그대로다. 원격 세션 금지 목록에 넣지 않는다(iPad도 고침). 날짜·시각·범위·종류 읽기, 달력 격자(`monthDays`, 일요일 시작)와 주 줄의 레인 배치(`weekLanes`: 여러 날 막대 먼저, 칸당 다섯 줄), 할 일 목록의 자리(`agendaWhen`: 기간에 오늘이 들면 `today`, 지난 협의는 `past`), 오늘 진행·퇴근 판단(`todayProgress`, 협의 제외)은 화면(`src/ui/agenda-text.ts`; 할 일·일정 두 구역은 `src/ui/dashboard-agenda.tsx`, 달력은 `src/ui/dashboard-calendar.tsx`, 일정 폼은 `src/ui/dashboard-agenda-form.tsx`)이 하고 엔진은 정해진 형식만 받는다. 할 일 행을 달력의 날로 끄는 것은 같은 페이지 안의 끌어 놓기이며 날짜만 보내는 같은 `PUT`이다.
- **하루 기록(퇴근하기, SPEC-01.14의 10):** schema 10의 `day_log(id, projectId FK, date 'YYYY-MM-DD', kind, text, body JSON, createdAt, updatedAt)`와 `UNIQUE(projectId, date, kind)`. 지금 쓰는 종류는 `day-end` 하나이며, `text`는 한 줄 요약(`2026-10-06 · 완료 3 · 도면 정리, 회의록 검토, …`), `body`는 `{done:[{id, text, kind, date, time, doneAt, source}]}`이다. 나중의 공유 메모·업무 일지는 같은 표에 다른 `kind`(예: `note`)로 쓰고 날짜로 읽는다(`Agenda.dayEnd`·`Agenda.log`, `src/core/agenda.ts`; 모양은 `src/contracts/agenda.ts` `dayLogEntrySchema`). `POST …/agenda/day-end` → `{entry, items}`: 이 PC의 오늘 날짜에 완료한 항목(`doneAt`의 현지 날짜가 오늘)을 한 트랜잭션에서 지우고 그날 `day-end` 행에 더한다(같은 날 다시 하면 `body.done`에 덧붙이고 `text`를 다시 만든다). 오늘 완료한 항목이 없어도 그날 행을 만들거나 그대로 둔다. `GET …/agenda/log?from=&to=` → `{entries}`(날짜 새것부터, 둘 다 선택). 원장에 남기지 않고 되돌리지 않는다. 프로젝트 삭제·프로젝트 DB 나누기에 `day_log`가 함께 간다.
- **글·파일에서 할 일 만들기(SPEC-01.14의 9):** 새 엔진 경로 없이 화면(`src/ui/dashboard-agenda-extract.tsx`)이 첨부 경로(`POST …/attachments`, `uploadAttachments`)와 요청 경로를 쓴다: `POST …/requests {id, conversationId:'default', hostUse:'none', mode:'auto', provider:'claude-cli', model:'auto', body, files, pins:[], sketches:[]}`. 기본 대화가 이미 있으면 그 AI로 돌고(`Conversations.fix`), 없으면 첫 턴 규칙대로 정해진다. 지시 문장(오늘 날짜, `agenda_add`로 바로 넣기, 날짜·시각·종류·담당자, 중복 피하기, 묻지 않기)은 화면이 본문 앞에 붙인다(`extractionBody`, `src/ui/agenda-text.ts`). 호스트 없는 대화 턴이라 `agenda_*`가 대화 도구에 있고, 첨부는 CLI가 보관 경로로 읽는다(ADR-031 8). 진행은 요청 상태(`GET …/requests/:id?view=summary`)와 대화 원장(`GET …/conversations/:c`)에서 그 요청의 `appAction:'agenda'` 항목으로 세며, 새 쓰기가 보이면 목록을 다시 읽는다. 끝의 [되돌리기]는 기존 `POST …/agenda/undo {conversationId, ledgerIds}`다. 화면 아래 안내와 겹치지 않게 대시보드가 보낸 요청 ID는 `dashboardAgendaRequests`(`agenda-text.ts`)에 넣고 `followAppActions`는 그 요청의 쓰기에 안내를 띄우지 않는다(목록 다시 읽기는 그대로).
- **도구:** `agenda_list({done?})` → `{today, total, items:[{id, text, date, time, kind, done, by?}]}`(완료는 `done: true`일 때만, 최대 200). `agenda_add({items:[{text, date?, time?, endDate?, endTime?, kind?, location?, attendees?}] ≤ 20})`, `agenda_set({items:[{id, text?, date?, time?, endDate?, endTime?, kind?, location?, attendees?, done?}] ≤ 20})`은 `source: 'ai'`로 바로 쓰고, 한 호출을 원장 항목 하나 `result-ref {appAction:'agenda', by:'ai', changes}`로 남긴다. `changes`는 `{op:'add', id, text, date, time, kind?, revision(=1)}` 또는 `{op:'set', id, text, revision(쓴 뒤), before:{text, date, time, doneAt, kind?, endDate?, endTime?, location?, attendees?}}`이다(`kind`는 schema 8부터, 끝 날짜·끝 시각·위치·참석자는 schema 11부터 기록; 되돌리기는 기록된 필드만 돌리고 없는 이전 기록은 그 필드를 그대로 둔다). 중간에 실패해도 그때까지 쓴 것은 기록한다. 쓰기 둘은 원장 콜백이 있는 대화 턴에만 주고 `PLAN_MODE_TOOLS`에는 `agenda_list`만 든다. 호스트(모델링) 턴도 대화 안이면 `Execution.readAgent`가 같은 처리기(`agendaHandlers`)를 그 대화 원장과 함께 호스트 범위에 더하고(계획 모드는 `agenda_list`만), 지시문에는 도구가 있을 때 `agendaInstruction` 한 문장이 붙는다.
- **되돌리기:** 화면(`src/ui/app/thread.ts`의 `followAppActions`)이 `appAction: 'agenda'` 원장 항목을 보면 대시보드를 바로 다시 읽고(`vide:agenda-changed`), 항목을 원장의 `requestId`(턴)별로 모았다가(`agenda-text.ts`의 `AgendaTurns`) 그 요청이 끝난 poll에서 턴마다 안내 하나와 [되돌리기] 하나를 띄운다(턴 밖 항목은 바로). 안내는 저절로 숨지 않는다. [되돌리기]는 `POST …/agenda/undo {conversationId, ledgerId | ledgerIds}`: 그 대화가 그 프로젝트의 것이고 항목마다 `appAction: 'agenda'`인지 확인하고, 아직 대체되지 않은 항목들의 `changes`를 만든 순서로 이어 붙여 한 번에 거꾸로 적용한다. 지금 `revision`이 기록과 같은 항목만 `add`는 지우고 `set`은 `before`로 돌린다. 같은 목록에서 이미 되돌린 `set`이 있는 항목은 그 `set` 앞의 판(`revision - 1`)으로 보고 비교한다(한 턴에 더하고 고친 항목도 함께 지워짐). 없거나 그 뒤 고치거나 완료한 항목(더한 항목도)은 그대로 두고 `skipped`로 센다. 결과 `{reverted, skipped, items}`. 그 뒤 원장에 `{appAction:'agenda-undo', ledgerId, by:'user', reverted, skipped}`를 더하고 원래 항목을 그것으로 대체(`supersededBy`)한다. 주어진 항목이 모두 이미 대체됐으면 `AGENDA_UNDONE`(409).

### 자료 정리

SPEC-08.9·SPEC-01.14 11(2026-10-07, PLAN-42 T-194~T-196). 프로젝트 폴더를 이 프로젝트의 자료 DB(`knowledgeFile`: 나뉜 배치는 `<데이터>/projects/<id>/knowledge.sqlite`, 이전 배치는 `<데이터>/knowledge/<id>.sqlite`)로 정리한다. 사람이 누를 때만 돈다(자동·주기 실행 없음).

- **위치:** `src/knowledge/collect/` — `collector.ts`(`KnowledgeCollector`: 프로젝트당 실행 하나, 상태, 중단, 후보 조회·결정), `inventory.ts`(목록·해시·지운 파일), `documents.ts`·`zip.ts`·`cfb.ts`·`hwp.ts`·`pdf.ts`·`mail.ts`(문서 추출), `extract-pool.ts`·`extract-worker.ts`(작업 스레드, 파일당 시간 제한 60초 + MB당 2초, 넘으면 스레드를 끝내고 `timeout`), `dwg.ts`(도면 사본·묶음), `stages.ts`(걸러내기·진술·이슈), `proposals.ts`(후보), `ai.ts`(실행기·모델 계획), `schema.ts`. 도면 읽기는 `hosts/zwcad/knowledge-dwg.ts`가 `launchOwnedHost`로 숨은 ZWCAD 2023을 띄워 작업자 DLL(`VIDE.Zwcad.Worker.dll`)의 `VIDEKNOWLEDGEDWG` 명령(`hosts/zwcad/worker/KnowledgeDwg.cs`; 환경 변수 `VIDE_KNOWLEDGE_MANIFEST`·`VIDE_KNOWLEDGE_OUT`, 줄마다 JSON, 끝나면 `<out>.done`)을 부르고 그 프로세스만 끝낸다. 사본은 `<데이터>/knowledge-work/<id>/<sha256>.dwg`이고 읽은 뒤 지운다. 결과가 5분 동안 늘지 않으면 끝낸다. PDF는 `pdfjs-dist`(legacy 빌드, 그림 그리기 없음; 선택 의존성인 canvas가 없으면 빈 `DOMMatrix`를 두고 읽는다)를 처음 쓸 때 불러오며, 없으면 `no-reader`다.
- **표:** 실험(`tools/spikes/2026-09-29-knowledge-crawl/db.mjs`·`issues.mjs`)과 같은 표·열(`meta`·`run`·`source`·`source_meta`·`episode`·`excerpt`·`excerpt_fts`·`mail`·`attachment`·`dwg_text`·`selection`·`statement`·`statement_done`·`party_alias`·`issue`·`statement_issue`)에 더한 것: `source.status`(`done`·`size`·`encrypted`·`distribution`·`no-text`·`unsupported`·`no-reader`·`no-zwcad`·`timeout`·`error`), `statement.held_prob`, `agenda_proposal(id, key, text, kind, date, time, end_date, end_time, location, attendees, evidence JSON [진술 ID], status 'pending'|'added'|'dismissed', created, decided, agenda_id)`. 후보 표를 엔진 DB가 아니라 자료 DB에 두는 이유: 후보는 정리 결과와 함께 생기고 근거 진술 ID를 가리키며, 엔진 DB 마이그레이션 없이 실험 DB에도 더해진다. `meta`에 `root`(폴더들의 공통 상위; 바뀌면 `rel_path`를 새 기준으로 고쳐 쓴다)·`folders`·`collector='vide'`·`collected_at`. 지운 파일은 `source.skip='removed'`, 그 진술은 `status='removed'`·`support_prob=-1`(이전 값은 `held_prob`)이라 `src/jigs/knowledge.ts`의 기존 조건과 사이트 사본(`KNOWLEDGE_TABLES`)이 고치지 않고 뺀다. 파일이 돌아오면 되돌린다. 바뀐 파일의 발췌는 글이 같은 행을 그대로 두고(선택·진술 유지) 사라진 행만 진술·이슈 연결과 함께 지운다. 이슈는 새 진술만 분류하고(기존 제목 우선), 보이는 구성원 수가 바뀐 이슈만 다시 적으며, 구성원이 없으면 지운다. 바뀐 이슈가 있으면 실험의 `brief` 행을 지운다. 사이트에서 받은 사본(`meta.vide_copy`)에는 쓰지 않는다(`KNOWLEDGE_IS_COPY`).
- **AI 실행:** `CollectRunner.run({role, choice, prompt, signal})` → `{text, inputTokens, outputTokens}`. 제품 실행기 `CliRunner`는 호출마다 빈 임시 폴더에서 CLI 하나를 띄운다. Claude는 `cliArguments('')`(도구 없음, `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, 설정 원천 없음, 세션 저장 없음, `stream-json`)의 덧붙임 지시를 수집기 지시(`--system-prompt`)로 바꾸고 `--model`·`--effort`(Haiku는 노력 없음)를 단다. Codex는 `codexArguments(model)`(`exec --json --ephemeral`, 읽기 전용 샌드박스, `mcp_servers={}`)에 `-c model_reasoning_effort=…`. 모델 계획(`modelPlan`): Claude CLI가 로그인되어 있으면 걸러내기 `claude-haiku-4-5-20251001`, 진술 `claude-sonnet-5`, 이슈·후보 `claude-opus-5-5`(medium); 아니면 Codex 목록(`Execution.models()`)에서 `-sol`로 끝나는 첫 모델로 모두(걸러내기 low, 나머지 medium). 동시 실행: 걸러내기 40개 묶음 4개, 진술 12개 묶음 6개, 이슈 4개, 후보 80개 묶음 2개. 시험은 `startServer({collectOptions: {runner, plan, dwgReader}})`로 바꿔 끼운다.
- **경로:** `GET …/knowledge/collect` → `{state: idle|running|done|failed|stopped, stage, done, total, startedAt, collectedAt, collected, error, counts: {files, read, unread:{상태: 수}, statements, issues, proposals}, left, models}`. `POST …/knowledge/collect`(시작; 진행 중이면 그 상태) · `POST …/knowledge/collect/stop`. 둘 다 원격 세션은 `FORBIDDEN`. 오류: `NO_PROJECT_FOLDER`·`AI_NOT_SIGNED_IN`·`KNOWLEDGE_IS_COPY`(409). `GET …/agenda-proposals` → `{proposals:[{id, text, kind, date, time, endDate, endTime, location, attendees, evidence:[{id, content, path}], createdAt}]}`(오늘 이후, 날짜·시각 순). `POST …/agenda-proposals/add {items:[{id, text?, kind?, date?, time?, endDate?, endTime?, location?, attendees?}] ≤ 100}` → 후보에 고친 칸을 얹어 `Agenda.add(…, 'ai')`로 넣고 `added`로 표시, `{added, items, proposals}`. `POST …/agenda-proposals/dismiss {ids}` → `{proposals}`. 화면: `src/ui/knowledge-collect.tsx`(프로젝트 폴더 구역, 진행 중 1초마다 상태 읽기, 끝나면 `vide:knowledge-collected`), `src/ui/dashboard-proposals.tsx`(할 일 구역).

### 한 요청의 복수 대상 실행

SPEC-02.14·15의 구현 입력은 `linkedTargets` 배열로 명시한다. 각 항목은 같은 프로젝트의 성공한 `baseRequestId`와 해당 `host`이며 제어기가 source artifact/문서 기준을 고정한다. 첫 UI는 기준 후보 두 개를 선택하고 `coordinateBasis: "shared-metre-axes"`를 명시 확인한 경우를 지원한다. 서로 다른 원점/축 변환을 이 값으로 대신하지 않으며 미확인 변환은 실행 전에 거절한다. Rhino 작업 사본은 m로 정규화하고 ZWCAD의 mm 변환은 기존 SDK 계약을 따른다. 참고 핀만 추가해 다른 문서를 쓰기 대상으로 승격하지 않는다.

각 대상은 별도 소유 작업 사본·operationId·보존 검사·영수증·하위 요청을 유지하고, 부모 요청이 한 번 발급한 AI 권한은 그 사본의 targetRef 집합만 허용한다. 도구 인터페이스는 기존 query/execute를 재사용한다. 한 공급자 실행이 명시 targetRef로 두 사본을 조회·수정하고, 선행 후보의 관측 기하를 후속 코드 입력으로 사용한다. 도구 호출은 이 작업 안에서 직렬화하고 활성 창은 대상 선택에 쓰지 않는다.

기존 단일 대상 실행기의 컴파일/불명확/복구를 재사용한다. 내부 scope 호출과 외부 MCP 호출은 동일한 대상·상한·취소·최신 기준 검사를 통과한다. 내부 전달을 위해 추가 HTTP 왕복이나 셸을 만들지 않는다. 제어기 내부 scope token은 AI 문맥/결과에 노출하지 않는다.

하위 요청의 의도는 쓰기 전에 각각 저장한다. 완료한 대상의 후보는 다른 대상 실패에도 유지하며 자동 재실행하지 않는다. 부모 결과의 `targetResults`는 하위 요청 ID·호스트·상태를 가리킨다. 모두 정상일 때만 부모 성공이고 일부 실패/불명확이면 전체 성공으로 표시하지 않는다. 재시작·복구도 하위 영수증별로 수행한다. 원본 적용은 기존 하위 후보별 명시 적용이며 여러 문서의 원자적 일괄 적용을 주장하지 않는다. (2026-09-30 ADR-022 이후 각 대상은 연결 문서이며 대상별 `direct-execute` 되돌리기 기록을 따로 남긴다. 위 문단의 소유 작업 사본·하위 후보 적용은 AI 편집에 쓰지 않는다.)

### 실행 권한·외부 자료·개입

새 에이전트 세션에는 필요한 VIDE 도구만 제공한다. 일반 셸·파일·웹 도구가 공급자 기본 설정에서 추가되지 않도록 검증한다. 공식 SDK 원문은 VIDE의 허용된 공식 출처 조회로 얻고 외부 문자열·객체 속성·웹 의견은 출처가 있는 데이터로 전달한다. 그 문자열이 사용자 지시·권한을 덮어쓰지 못하게 입력과 작업 권한을 분리한다.

임의 C#은 호스트 사용자 권한으로 실행될 수 있다. 작업 사본/별도 프로세스는 문서 보호와 장애 범위를 줄이지만 OS 파일·네트워크 격리가 아니다. 심볼·정적 분석은 실수와 명백한 위험 호출을 찾는 보조 수단이며 완전한 샌드박스로 주장하지 않는다. 광범위한 네임스페이스 금지로 정상 내보내기까지 막지 않으며 필요한 파일 작업은 작업 자산 API로 제공한다. 외부 출처 지시가 실행 권한을 넓히는 시험과 정상 자료 처리의 과잉 거절 시험을 함께 수행한다. 제품의 AI 생성 코드 경로를 공개 비신뢰 플러그인 실행 기능으로 확대하지 않는다.

| 상황 | 기본 처리·검증 |
|---|---|
| 사용자 조건 변경 | 새 조건 revision 저장, 이전 targetRef의 새 쓰기 거절. 이미 실행한 작업과 대기 작업을 구분 |
| 세션 내 메시지 주입 미지원 | 다음 도구 응답에 조건 변경을 알리고, 지속 개입이 불가능하면 CLI 취소 후 제품 기록으로 새 세션 시작 |
| 세션 내 메시지 주입 지원 | 공급자 기능을 검증한 뒤 최적화로 사용. 동일한 조건 revision 검사 유지 |
| 실행 상한 | 호스트 명령 수·경과 시간은 제어기가 집행. 모델 턴은 공급자 이벤트/옵션의 관측 가능한 단위로 매핑. 미제공 수치를 추정해 정확한 한도로 표시하지 않음 |
| 중단 | 미전달 큐/이전 조건 쓰기 무효화, 진행 연산은 협조적 취소 요청. CLI 종료와 호스트 종료를 별도로 확인 |
| 호스트 무응답 | 소유가 확인된 작업 실행본만 종료 가능. 종료 전 부작용 조사 전에는 성공/미반영으로 단정하지 않음 |

사본만 영향받았고 외부 부작용이 없음을 확인한 경우 해당 사본을 폐기한다. 확인되지 않은 작업은 unknown으로 보존하고 자동 재실행하지 않는다. CancellationToken·timeout·프로세스 종료만으로 모든 결과가 원자적으로 취소된다고 주장하지 않는다. 원본 적용 중 중단은 사본 폐기 규칙을 적용하지 않고 객체별 관측 증거로 처리한다.

Roslyn/호스트 런타임 버전 충돌·첫 컴파일 지연·반복 실행 메모리를 시험한다. 현대 .NET의 collectible AssemblyLoadContext는 참조/실행 스레드가 남으면 해제가 완료되지 않는다. .NET Framework는 별도 AppDomain 해제 가능성과 호스트 API 호환성을 확인하되 기본 도메인에 적재한 어셈블리의 개별 해제를 가정하지 않는다. 전용 프로세스 재사용·조건부 재시작으로 누적을 관리하며 임의 작업 중 사용자 호스트 재시작을 사용하지 않는다.


<a id="detail-3"></a>

## 4. 호스트 실행본과 적용


### 바로 적용 경로(ADR-022, 2026-09-30)

[ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md)와 SPEC-02.11·02.13·02.20의 물리 계약이다. AI 편집과 jig의 Rhino에 만들기는 작업 사본·후보·적용 manifest를 거치지 않고 사용자가 연결한 열린 문서에서 실행한다. 이 절 아래의 「VIDE 소유 작업 실행본과 사본 분기」·「사본 결과를 원본에 적용」은 AI 편집에 대해서는 대체되었고, jig 만들기·가져오기가 내부 작업 사본을 쓰는 곳에만 남는다.

**모드 필드.** 요청 입력 스키마(`requestInputSchema`)의 `mode: 'plan' | 'auto'`(기본 `auto`)가 `permission`을 대신한다. 입력과 저장된 이전 요청의 `permission`은 읽을 때 `review → plan`, `candidate | apply → auto`로 바꾼다. 대화의 현재 모드는 대화 기록에 두고(ARCH-03 §10), 요청은 접수 때의 모드를 고정한다. 이전 `applyToSource`는 자동 모드와 같은 뜻이 되어 더 이상 따로 판정하지 않는다.

**호스트 연결 명령.** Rhino 연결(현재 문서에 붙은 인증 loopback TCP)과 ZWCAD 연결 DLL이 같은 뜻의 명령 세 개를 받는다.

| 명령 | 입력 | 출력 |
|---|---|---|
| `direct-execute` | `{requestId, code, language?, label, guard: {confirmed: boolean, maxDeletes: 50}}`. `code`는 Rhino가 C# 메서드 본문(`Run(RhinoDoc doc)`), ZWCAD가 기존 `runCode` 스크립트 형식(`Run(Database db, Transaction tr)`). Rhino만 `language: 'csharp'(기본) \| 'command' \| 'python'`(ADR-029): `command`는 Rhino 명령 매크로, `python`은 Python 3 스크립트 | `{ok, undoId, changes: {added: [{nativeId, hash, layer}], changed: [{nativeId, hash, layer}], removed: [{nativeId, layer}], counts?, layers?: {added, removed}(Rhino), layersRemoved?·purged?(ZWCAD)}, guarded?: {kind: 'bulk-delete' \| 'layer-delete' \| 'purge' \| 'save' \| 'save-as' \| 'export' \| 'publish', detail}, reverted?, log}` |
| `direct-undo` | `{undoId}` | `{ok: true}` 또는 그 기록이 문서의 마지막 되돌리기 기록이 아니면 `{ok: false, reason: 'not-latest'}` |
| `fingerprint` | `{}` | `{documentHash, revision}` |

- **Rhino:** UI 스레드에서 `doc.BeginUndoRecord(label)` → 컴파일된 본문 실행 → `doc.EndUndoRecord(serial)`을 한 번에 한다. 예외가 나도 기록을 닫고, 변경이 있었으면 그 기록을 되돌려 반쯤 된 변경을 남기지 않는다(`EXECUTION_FAILED`, `reverted: true`. 되돌리지 못하면 `HOST_RESULT_UNKNOWN`). `changes`는 실행 중 문서 이벤트(추가·교체·삭제·속성 변경)로 모으고 `hash`는 기존 객체 지문(`WorkerScene.Fingerprint`와 같은 규칙)이다. `undoId`는 서버가 해석하지 않는 불투명 값이다(현재 Rhino는 그 연결이 만든 되돌리기 기록 번호, 연결·문서는 실행 기록의 `target`이 묶는다). 문서를 바꾸지 않은 실행은 `undoId: null`이다. `direct-undo`는 문서의 마지막 되돌리기 기록 번호가 그 기록일 때만 `doc.Undo()`를 부른다. 컴파일·금지 API 정책(`CodePolicy`: 명령·`RhinoApp`·파일·UI·리플렉션 거절)은 그대로다.
- **Rhino 명령·Python(ADR-029, `hosts/rhino/worker/DirectScripts.cs`):** 같은 기록 안에서 `command`는 `RhinoApp.RunScript(document.RuntimeSerialNumber, script, false)`, `python`은 `RhinoCode.Languages.QueryLatest(LanguageSpec.Python3).CreateCode("#! python3\n" + text).Run(RunContext{RecordDocumentUndo: false, Output·Error → 로그})`로 메모리에서 실행한다(임시 파일 없음, 참조 `Rhino.Runtime.Code.dll`). 둘 다 `RhinoDoc.ActiveDoc`가 그 문서가 아니면 `DOCUMENT_NOT_ACTIVE`(실행 전 거절)다. `changes`는 C#과 같은 실행 전후 객체·레이어 비교와 교체·속성 이벤트로 모은다. 명령의 로그는 실행 중 시작된 명령의 영어 이름과 결과(`Command.EndCommand`)다. 실행 중 Rhino가 VIDE 기록 뒤에 기록을 더 남기면(명령이 기록 안으로 합쳐지지 않는 경우) 그 연결은 `undoId`(첫 기록) → 마지막 기록 번호를 묶어 두고, `direct-undo`와 실패·보호의 되돌림은 그 범위를 마지막 것부터 되돌린다(범위 앞 기록이 나오면 다시 실행해 멈춤). 마지막 기록 판정은 그 범위의 끝 뒤를 본다. 묶음의 '되돌림' 상태는 `UndoRedo` 사건마다 범위 안 모든 기록이 되돌려졌는지로 다시 계산한다(일부만 Ctrl+Z면 적용 상태로 남아 `direct-undo`가 남은 기록을 되돌리고, Ctrl+Y는 다시 적용 상태로). 정책 목록은 엔진의 `src/contracts/rhino-script-policy.ts`와 같고(`tests/server/rhino-script-policy.test.mjs`가 비교), 호스트도 실행 전에 같은 목록으로 거절(`CODE_POLICY_REJECTED`, `diagnostics`)·보류(`guarded`)하며, 명령 매크로와 Python 실행 중 `Command.BeginCommand`의 영어 이름이 거절 목록이거나 확인 없는 보호 명령(Python은 확인과 관계없이 모든 보호 명령)이면 그 기록을 되돌리고 `CODE_POLICY_REJECTED`로 답한다. 옵션 이름과 겹치는 낱말은 그 옵션을 가진 명령 바로 뒤에서만 옵션이다(`COMMAND_OPTION_OWNERS`). 보호 명령이 여럿이면 `guarded.kind`는 가장 무거운 종류(`GUARD_SEVERITY`), `detail`은 모든 명령을 적는다.
- **ZWCAD:** 기존 `runCode{write:true}`의 `_VIDEAIRUN` 명령 하나가 Undo 묶음 하나다. `direct-undo`는 그 명령이 마지막 Undo 묶음일 때만 명령 하나를 되돌린다. `changes`는 기존 추가·수정·삭제 핸들 보고를 이 형식으로 싣는다.
- **보호 판정:** 실행 뒤 호스트가 `removed` 수(`maxDeletes` 초과면 `bulk-delete`)와 레이어 표 삭제(`layer-delete`)를 센다. `guard.confirmed`가 false인데 해당하면 Rhino는 그 기록을 바로 되돌리고, ZWCAD는 명령의 트랜잭션을 확정하지 않은 채 `guarded`를 채워 돌려준다(`ok: false`, `reverted: true`). 이때 문서에는 남은 변경이 없고 `undoId`는 없다. `purge`는 Rhino에서 되돌리기로 복원되지 않으므로 컴파일 때 표의 `Purge*`·`Compact` 호출을 찾아(`CodePolicy.Purges`) 실행 전에 `guarded`로 돌려주고, ZWCAD는 실행 뒤 지운 기호 표 정의를 센다. C# 생성 코드의 파일 쓰기(Rhino `Rhino.FileIO`·`RhinoDoc.Write3dmFile`·`Export`·`Save*`, ZWCAD `Database.SaveAs`·`DxfOut` 등)는 금지 API 정책이 컴파일 때 거절한다. Rhino 명령의 `Save`(`save`, 열린 원본 덮어쓰기), `SaveAs`·`IncrementalSave`·`Export*`·`ViewCaptureToFile`(`save-as`·`export`), `Print`(`publish`), `Purge`(`purge`)와 Python의 `Purge*`·`Compact` 호출은 엔진(`checkExecuteScript`)이 실행 전에 보류 행으로 돌려주고 호스트도 확인 없으면 같은 `guarded`를 답한다(ADR-029). Python의 문서 저장(`.Save*(`)과 이름을 문자열로 만드는 반사(`getattr`·`__builtins__` 등)는 엔진과 호스트가 같은 목록으로 거절하고, Rhino 호스트는 실행 중 `RhinoDoc.BeginSaveDocument`가 확인한 명령 실행 밖에서 시작되면 그 실행을 되돌리고 `CODE_POLICY_REJECTED`로 답한다. 그 밖의 `save-as`·`export`·`publish`와 계정은 VIDE 동작으로만 일어나며 SPEC-02.19의 T2 카드로 처리한다. 종류 값은 카드 표시를 위해 계약에 남긴다.
- **실행 상한과 취소:** 호스트 실행 시간 상한과 협조적 취소, `HOST_RESULT_UNKNOWN` 영수증 규칙(「생성 코드 검사와 진단 계약」)은 그대로다. 같은 `requestId`+operation의 재전송은 기존 결과를 돌려주고 다시 실행하지 않는다.

**서버.** `Execution.run`은 자동 모드 턴에 AI 도구 `execute`를 그 요청의 대상 연결의 `direct-execute`로 묶는다. 호출 하나가 실행 원장의 한 행이다. 도구 `execute`는 `code`(C#)·`command`·`python` 중 정확히 하나를 받는다(ADR-029, 둘 이상이거나 없으면 `EXECUTE_FORM_INVALID`). `command`·`python`은 Rhino 바로 편집 턴에서만 `language`로 실어 보내고, 작업 사본·ZWCAD 처리기는 `EXECUTE_FORM_UNSUPPORTED`로 답한다. 보내기 전에 `checkExecuteScript`(`src/contracts/rhino-script-policy.ts`)가 거절이면 호스트를 부르지 않고 `{ok: false, executed: false, code: CODE_POLICY_REJECTED, diagnostics}`, 확인이 필요하면 호스트를 부르지 않고 보류 행을 만든다. `changes`는 종류별 200개와 전체 건수(`boundedChanges`, `src/server/direct-mode.ts`)로 줄여 AI에 돌려주고 호스트 결과는 실행 기록에 둔다. `guarded` 결과는 실행 기록에 `guarded` 상태(Rhino는 다시 실행할 `code`와 그 형식 `language` 포함)로 남기고 AI에 '사용자 확인 대기, 이 턴을 멈추라'로 돌려주며, 턴이 끝나면 요청 상태를 `needs-confirmation`으로 두고 화면에 확인 카드를 띄운다. 카드의 [진행](`POST …/requests/:r/confirm`)은 보관한 `code`가 있으면 `guard.confirmed: true`인 `direct-execute`를 새 행으로 한 번 부르고(원래 행은 `confirmed`), 없으면(ZWCAD) 요청 입력에 `guardConfirmed: true`를 붙여 그 턴을 다시 실행한다. 보관한 `code`가 있는데 그 `target`의 드라이버가 없으면(닫힘·다시 열림) 턴을 다시 실행하지 않고 `needs-confirmation`에 `refused: {code: STALE_CONNECTION, reason, file}`을 남긴다. 계획 모드 턴은 읽기 도구(`query`·`status`·`cancel`, 보기 `capture_view`·`measure`, 대화 읽기·자료)만 받고, 구조화 턴 출력에 `plan: {steps: [{title, objects?, risk?}], questions?}`를 낸다. 같은 문서의 `direct-execute`·`direct-undo`·jig 만들기는 문서별 쓰기 대기열(SPEC-02.9, ARCH-03 §10.3)로 직렬화한다. 실패한 `direct-execute`의 분류(SPEC-02.7, `src/contracts/direct-refusal.ts`): 실행 전 거절 코드(`DOCUMENT_READ_ONLY`·`HOST_BUSY`·`UNDO_UNAVAILABLE`·`TARGET_MISMATCH`·`STALE_CONNECTION`·`DOCUMENT_MISMATCH`·`DOCUMENT_NOT_ACTIVE`·`HOST_UNAVAILABLE`·`HOST_OWNERSHIP_MISMATCH`·`UNAUTHORIZED`·`UNSUPPORTED_METHOD`·`INVALID_*`·`OPERATION_CONFLICT`)는 AI에 `{ok: false, executed: false, code, reason, next}`로 돌려주고 결과에 `refused: {code, reason}`를 남긴다. 읽기 전용·연결 끊김 계열은 그 턴의 다음 `execute`를 호스트에 보내지 않고 같은 답을 준다. 컴파일·정책 거절과 되돌린 실행 실패(`reverted: true`)는 AI가 고쳐 다시 시도하는 결과다. 그 밖의 오류(응답 유실·시간 초과·`reverted: false`·ZWCAD `HOST_READ_FAILED`, 60초 대기 뒤의 ZWCAD `HOST_BUSY`)는 `HOST_RESULT_UNKNOWN`이다. 확인 카드의 [진행]이 실행 전에 거절되면 요청은 `needs-confirmation`에 남고 `refused`를 보인다. jig 만들기는 앞 본문을 되돌리고 `BAKE_FAILED`에 `refused`(이유 문장)를 붙인다.

**실행 기록.** 실행 한 번마다 요청 결과의 `executions[]`에 `{executionId, host, target: {instance, documentId}, label, at, state: applied | undone | guarded | confirmed, undoId, changes, guarded?, code?(guarded 동안만), language?(`command`·`python`일 때, ADR-029), confirms?(보호를 푼 재실행이 가리키는 원래 행), undoneAt?}`를 남기고, 같은 내용을 대화 원장에 한 항목으로 적는다(ARCH-03 §10). 응답을 잃은 실행은 행을 만들지 않고 요청을 `unknown`(`HOST_RESULT_UNKNOWN`)으로 두며, `fingerprint`와 되돌리기 기록 조회로만 해소하고 다시 실행하지 않는다. 실행 전후 문서 지문을 행에 남기는 것은 남은 작업이다(PLAN-24).

**되돌리기 API.** `POST /api/v1/projects/:id/requests/:rid/undo {executionId}`는 그 실행의 대상 연결에 `direct-undo {undoId}`를 부른다. 성공하면 행을 `undone`으로 바꾸고 `200 {ok: true, request}`를 돌려준다. 호스트가 거절하면 `200 {ok: false, reason: 'not-latest' | …, request}`이며 행은 그대로다. 행이나 `undoId`가 없으면 `NOT_FOUND`, 연결이 없으면 `EXECUTOR_NOT_READY`다. 이미 `undone`인 행의 재요청은 `{ok: true, already: true}`다. 되돌린 뒤 `fingerprint`를 다시 받아 기록하는 것과 문서별 쓰기 대기열에 세우는 것은 SPEC-02.13의 3이 요구하며 남은 작업이다(PLAN-24). 원격 세션 제한(ADR-010 §3)을 받는다.

**여러 파일 턴(ADR-027, 2026-10-01).** 동작 정본은 SPEC-01.11의 5·SPEC-02.13의 6·SPEC-02.9의 3이다. 1차 범위는 Rhino 연결 문서가 대상인 바로 편집 턴(`runDirectTurn`, `src/server/direct-mode.ts`)이다.
- **파일 해석:** 도구 인수 `linkId`를 그 프로젝트의 연결 행(`DocumentLinks`)에서 찾고, 링크 목록 경로(`GET …/links`)와 같은 대조·따라가기 단계(`followOpenDocuments`, `src/server/live-links.ts`: 아래 「연결 파일」의 `matchOpenDocuments` 세션 우선 대조와 `DocumentLinks.follow`)로 지금 열린 문서(Rhino `editors.list(true)`, ZWCAD `editors.attached.list()`)에 맞추고, 그 문서가 **연결 편집기**(`connection: 'attached-editor'`)일 때만 열린 파일로 본다. 그래서 목록이 연결로 보이는 행과 턴의 열린 행이 같고, 창 하나는 열린 행 하나이며, 목록의 마지막 조회 뒤 다른 이름으로 저장한 창도 턴이 새 이름으로 본다. 맞는 문서가 없거나 파일 항목(`file:`, 목록에는 닫힌 파일로 나옴)·VIDE가 연 작업 사본이면 `LINK_NOT_LIVE`, 그 프로젝트의 연결이 아니면 `NOT_FOUND`. 자기 창이 닫힌 행을 경로로 이을 때 같은 경로가 두 창에 열려 있으면 턴의 대상 창, 다음은 처음 나온 창을 고른다(`matchLinks`의 `prefer`). 대상 문서와 같은 문서면 대상의 드라이버를 쓴다. 열린 문서 조회는 그 프로젝트에 연결이 있는 호스트에만 동시에 보내고, 호스트 연결이 없는 프로젝트(한 파일 요청)는 호스트를 묻지 않는다(`Execution.liveLinks`). 턴 시작 때 열린·닫힌 연결 파일 목록(ID·이름·호스트)을 목표 문장에 싣는다. 해석한 드라이버는 그 턴 동안 문서마다 하나이며 실행 뒤 그 문서의 조회 캐시만 무효로 한다.
- **도구별:** Rhino 문서는 `query`(그 문서의 마지막 저장 Sync `ModelView`의 객체 줄·측정 meta에 그 Sync 뒤 바뀐 객체(`editors.changes`)를 덮은 쪽, 저장 Sync가 없거나 Live가 불가능하면 `readLayers` 페이지. 측정 줄에 좌표 배열은 싣지 않음, T-123)·`capture_view`·`measure`(`directView`)·`execute`(`direct-execute`). ZWCAD 도면은 `query`(`queryEntities`)·`execute`(`direct-execute`)이고 보기 메서드가 없어 `capture_view`·`measure`는 `NO_VIEW`. ZWCAD 답의 `COMPILE_ERROR`·`CODE_POLICY_REJECTED`·`EXECUTION_FAILED`·`GUARD_CONFIRMATION_REQUIRED` 밖의 실패는 실행 전 거절이 아니면 `HOST_RESULT_UNKNOWN`으로 읽는다(`runAttached`와 같은 규칙). 자동 모드 목표 문장은 대상 밖의 열린 ZWCAD 도면이 있을 때만 ZWCAD 실행 래퍼(`ZWCAD_EXECUTE_WRAPPER`, `src/server/zwcad-sdk-execution.ts`: `Database db`·`Transaction tr`, Commit/Abort 금지, 핸들 ID, 도면 단위)를 덧붙인다. ZWCAD 대상 턴의 목표와 같은 문장이다. `AgentTools.issue`의 `links: true` 범위만 `linkId`를 처리기로 넘기고, 다른 범위에서 `linkId`를 준 문서 도구는 처리기를 부르지 않고 `LINK_NOT_LIVE`다. 오류 답에는 `next`를 붙인다: `links: true` 범위의 닫힌 파일은 저장 기록 도구로 읽고 사용자에게 열어 달라고 하라는 안내, `linkId`를 받지 않는 범위는 '이 턴은 다른 파일을 실시간으로 다루지 못하니 저장 기록으로만 읽고 열어 달라고 하지 말라'는 안내. 공통 지시(`hostProjectNote`)는 실시간 읽기·쓰기를 약속하지 않고, 그 규칙은 그런 턴의 목표 문장만 준다.
- **잠금:** 대상 문서 밖의 문서에 첫 `execute`를 보내기 전에 `Execution`이 그 문서를 검사한다(`documentHolder`, `src/contracts/request-scope.ts`): 다른 대기 중이 아닌 `queued`·`running` 요청의 쓰기 주장(입력의 대상 + 결과의 `documents[]`)에 그 문서가 있으면 `DOCUMENT_LOCKED`. 결과 불명 요청은 잠금 사유가 아니다(T-102). 통과하면 결과의 `documents: [{host, instance, documentId, linkId?, name?}]`에 더한다(같은 동기 구간이라 두 턴이 동시에 통과하지 않는다). `requestAdmission`은 진행 중 요청의 `documents[]`도 쓰기 주장으로 센다. 잠금 거절은 실행 전 거절과 같은 모양(`{ok: false, executed: false, code, reason, next}`)으로 AI에 돌려주고 문서별 '실행하지 않음'으로 기록한다. 대기는 하지 않는다. jig의 바로 만들기(`jig-routes.ts`, 연결 편집기 문서)도 실행 전에 같은 검사를 해 잡혀 있으면 `BAKE_FAILED`(`reason: DOCUMENT_LOCKED`, `refused` 문장)로 거절하고, 도는 동안 `Workspace.holdWrite`로 그 문서의 짧은 쓰기 주장을 둔다. 요청 표에 남지 않는 이 주장은 `Workspace.claimRows`가 접수(`submit`·`admission`·`release`)와 턴 중 잠금·보호 카드 검사에 더하며, 끝나면 `Execution.resume`이 기다리던 요청을 다시 판정한다. **실행만 차례대로(2026-10-02, SPEC-02.9 3):** 열린 Rhino 문서의 바로 편집 턴(연결 편집기 Sync 기준, `linkedTargets`·`applyToSource`·jig 아님)의 쓰기 주장과 그 턴이 잠근 `documents[]`는 `direct`로 표시되고, `direct`끼리는 접수에서 서로 기다리지 않으며 `documentHolder(…, {serialized: true})`(턴 중 잠금·보호 카드)에서도 서로 잡지 않는다. 대신 `direct-mode.ts`의 `ExecuteQueue`(엔진 프로세스 하나, 문서 키별 FIFO)가 턴의 `execute`, 보호 카드 재실행, [되돌리기]·자동 되돌림(`queuedDriver`)을 문서마다 하나씩 보낸다. 기다리는 턴의 진행 결과에는 `executeWait: {kind: 'execute', key, host, position, conversationId, title?}`가 붙는다. 턴은 문서의 `fingerprint().documentHash`를 턴 시작·조회 직전·자기 실행 직후에 기억하고, 차례를 얻은 뒤 값이 다르면 호스트에 보내지 않고 `DOCUMENT_CHANGED`(실행 전 거절 모양, `final: false`)를 돌려준다. 조회 캐시(`displayQuery`)는 토큰이 바뀌면 다시 읽는다.
- **보호 카드의 [진행]:** 여러 파일 요청이거나 보류한 실행이 대상 밖 문서에 있으면 다시 실행하기 전에 `documentHolder`로 그 문서를 검사하고, 잡혀 있으면 실행하지 않고 `needs-confirmation`에 `refused: {code: DOCUMENT_LOCKED, reason, file}`을 남긴다. 다시 실행한 행은 보류 행의 `file`을 이어받는다. 여러 파일 요청의 재실행이 실패하면(`ok: false`, 답 유실, `reverted: false`) `Execution.rollBackConfirmed`가 위 자동 되돌림과 같은 규칙으로 적용된 행을 되돌리고 `rollback: {reason: 'failed', …}`을 남긴다. 답을 잃은 그 문서는 건너뛰고 `documents[]`에 `pending: 'execute'`로 남는다. 한 파일 요청의 [진행]은 그대로다.
- **실행 기록:** 모든 행에 `file: {linkId?, name}`을 싣는다. 실행 전 거절의 `final`(읽기 전용 문서·연결 끊김)은 그 문서에만 적용한다. 응답을 잃은 실행은 지금처럼 그 턴의 다음 실행을 모두 막는다.
- **여러 파일 요청:** 실행을 시도한 문서가 둘 이상인 요청(`multiFile: true`, 호스트의 실행 전 거절·잠금 거절된 시도도 센다). 요청이 오류·중단(중단은 공급자의 코드가 아니라 요청의 중단 신호로 판단해 `CANCELLED`·`STOP_UNCONFIRMED` 모두 `reason: 'cancelled'`, 추가 지시로 끊긴 경우 제외)으로 끝나면 `runDirectTurn`이 적용된 실행(`state: applied`, `undoId` 있음)을 마지막 것부터 문서별 `direct-undo`로 되돌린다. 한 문서에서 거절되면 그 문서의 더 앞 실행은 건너뛰고(마지막 기록이 아니므로) 다른 문서는 계속한다. 응답을 잃은 실행이 있는 문서는 되돌리지 않는다. 턴이 끝날 때 답을 기다리던 `execute`의 문서도 응답을 잃은 것으로 본다(한 파일 턴의 대상은 지금처럼 `documents: []`). 턴이 끝난 뒤 온 도구 답은 요청 결과·상태에 쓰지 않는다. 결과의 `rollback: {at, reason: 'failed' | 'cancelled', files: [{host, target, linkId?, name, state: 'undone' | 'refused' | 'unknown', undone, kept, reason?}]}`에 남기고(파일은 요청이 처음 쓴 순서, 공통 함수 `undoExecutions`) 행을 `undone`으로 바꾼다. 결과 불명이면 결과의 `documents[]`에는 확인이 필요한 문서를 잃은 답의 종류(`pending: 'execute' | 'undo'`)와 함께 남긴다. 여러 파일 요청이 그런 문서를 모두 알면 `heldOnly: true`를 두고, `claimsOf`(`src/contracts/request-scope.ts`)는 그 요청의 입력 대상을 빼고 이 문서들만 쓰기 주장으로 센다. `heldOnly`가 없는 결과 불명(한 파일 요청, 재시작으로 `unknown`이 된 요청)은 지금처럼 대상도 주장한다. 자동 되돌림의 되돌리기 답만 잃었으면 `settles: {state: 'failed' | 'cancelled', code?}`(모두 해소되면 돌아갈 결과)를 둔다. 실행 전 거절은 결과의 `refused: {code, reason, file?}`(대상 밖 파일이면 이름)로 남고 실패·중단한 요청에도 남는다. 거절이 있으면 요청 코드는 원래 코드 그대로(화면이 `rollback`을 보임), 되돌리기 답을 잃으면 요청은 `unknown`(`HOST_RESULT_UNKNOWN`)이다.
- **Undo 화면 응답:** 실행별·작업별 Undo에 `?view=summary`를 지정하면 `request`는 기존 요청 요약과 같은 형상 제외 형식이다. 생략 시 기존 전체 응답을 유지한다. UI는 요약을 요청하고 후속 상태를 조회한다.
- **작업 단위 되돌리기:** `POST …/requests/:rid/undo {all: true}`는 그 요청의 적용된 행을 마지막 것부터 위 규칙으로 되돌리고 `200 {ok, files: [{host, target, name, state, undone, kept, reason?}], request}`(모두 되돌렸을 때만 `ok: true`)를 돌려준다. 결과의 `undo: {at, files}`에 마지막 시도를 남긴다. 되돌리기 답을 잃은 문서가 있으면 요청을 `unknown`(`HOST_RESULT_UNKNOWN`)으로 두고 `documents[]`에 그 문서(`pending: 'undo'`), `heldOnly: true`, 앞 결과의 상태·코드·`documents`를 `settles`에 남긴다. 결과 불명 요청에서 다시 부르면 기존 `documents[]`를 지우지 않고 합치되, 호스트가 이번에 답한 문서(`undone`, `refused`의 `not-latest`)와 적용된 행이 남지 않은 문서의 `pending: 'undo'`는 뺀다. 남은 문서가 없고 `heldOnly`·`settles`가 있으면 `settles`의 상태·코드·`documents`로 돌린다(`afterRequestUndo`, `src/server/direct-mode.ts`). `pending: 'execute'`는 되돌리기로 지우지 않는다. 진행 중 요청은 `REVISION_CONFLICT`, 결과 불명이 아닌데 되돌릴 행이 없으면 `{ok: true, already: true}`, 결과 불명인데 실행 행이 하나도 없으면 `acknowledge`와 같이 닫고 `{ok: true, files: [], request}`(T-102). 한 파일 요청의 실행별 `{executionId}`는 그대로다.

### VIDE 소유 작업 실행본과 사본 분기

VIDE가 직접 기동한 기록(프로세스 ID·시작 시각·실행 세션)과 실제 연결 응답이 일치한 실행본만 소유 작업 실행본으로 인정한다. 자체 애드인은 실행별 pairing까지 확인한다. PID/창 제목만으로 인정하거나 사용자가 연 실행본을 소유 실행본으로 승격하지 않는다. 재시작·연결 교체 때 소유 확인을 다시 하며 증명되지 않은 프로세스를 종료하지 않는다.

두 호스트 각각 현재 설치/라이선스 형태에서 추가 실행·재기동과 사용자 실행본의 계속 편집을 시험한다. 추가 실행이 불가능하거나 사용자 실행본의 라이선스 이용을 방해하면 그 구성의 범용 코드 실행을 미지원으로 표시한다. 사용자 실행본에서 임의 코드를 실행하는 대안으로 자동 전환하지 않는다. 실제 기동 가능성과 이용 조건 검토는 별개이며 법적 허용을 실측만으로 단정하지 않는다.

기동 시간·유휴/작업 메모리·반복 작업 누적을 측정하고 한 작업 실행본을 재사용한다. 활성 작업/미보존 결과가 없는 상태에서만 유휴 종료하며, 메모리 증가나 응답 불능에 따른 재기동 전 결과/저널을 보존한다. 수치 기본값은 해당 SPIKE에서 측정해 정한다. 기본은 숨김 기동이며 UI 스레드 API·메시 추출·모달 대화상자 처리가 가능한지 검증한다. 숨김으로 동작하지 않아 표시가 필요하면 사용자 작업 창과 구분되는 작업용 표식/상태를 제공하고 창 표시 조건을 명시한다.

미저장 변경이 있는 열린 문서는 호스트의 고정 사본 기록 도구로 별도 경로에 분기한다. 기록 전후 원 문서의 경로·이름·수정 상태·Undo와 객체/속성을 대조하고 Rhino/ZWCAD 각각 검증한다. 기록 중 변경이 있으면 기준 불일치로 재취득한다. 무변경 사본 취득을 지원하지 못하면 현재 미저장 상태 기준 실행을 보류한다. 마지막 저장 파일은 별도 기준으로 표시하고 사용자가 그 기준을 선택했을 때만 분기하며 미저장 변경을 조용히 제외하지 않는다. 새 미저장 문서에 저장 기준도 없으면 읽기/입력은 유지하되 해당 실행만 보류한다.


자체 애드인은 VIDE 제어기에 등록하고 hostSessionId를 받는다. 첫 구현 후보는 loopback 접속과 사용자 범위에서 전달한 실행별 pairing 토큰이며, 브라우저·공유 서버의 인증과 분리한다. 단일 고정 포트를 각 호스트가 독점하는 구조를 피한다. Named Pipe는 Node가 서버인 경우와 C#이 서버인 경우를 비교하고 실제 ACL·원격 접근 차단·재접속 시험을 통과할 때만 선택한다. PID/창 제목/파일명은 권한 식별자가 아니다. 같은 사용자 권한의 악성 프로세스까지 이 통신 방식만으로 격리한다고 주장하지 않는다. 사용한 endpoint/토큰의 수명은 실행 세션에 한정한다.

documentSessionId는 열릴 때마다 새 값, documentId는 VIDE 논리 문서 ID다. 경로 변경(Save As), 동일 파일의 동시 열기, 외부 복사로 내부 ID가 중복된 경우를 매핑 기록으로 구분한다. readonly 취득만으로 사용자 파일에 ID를 쓰지 않는다. 식별 불명은 재연결 대상으로 제시하고 활성 문서에 자동 대체하지 않는다.

접수 경합 키는 host와 sourceDocument의 instance/documentId, 또는 baseRequestId 계보의 최초 후보 ID로 만든다. baseRequestId=null은 요청 ID별 새 독립 후보, 필드 생략/계보 식별 실패는 해당 host 전체 키다. 연계 요청은 두 대상 키를 모두 점유하고 자식 작업을 중복 집계하지 않는다. 접수는 SPEC-02.9를 따른다(`requestAdmission`, `src/contracts/request-scope.ts`): 같은 문서를 쓰는 요청은 거절하지 않고 문서별 대기열에 서며(호스트를 쓰지 않거나 읽기만 하는 요청은 기다리지 않음, 문서를 특정하지 못한 쪽은 그 호스트 전체 뒤에 선다), 프로젝트에서 동시에 도는 AI 턴은 `AI_TURN_LIMIT` = 3개까지이고 넘으면 프로젝트 대기열에 선다. 대기하지 않는 종류(Sync·가져오기·확장 실행)가 막히면 `PROJECT_BUSY`다. 불명확 쓰기(`unknown`)는 접수·대기열·대화 줄을 막지 않는다(T-102): `unresolvedFor`가 그 요청의 주장과 겹치는 결과 불명 요청을 찾아 `Execution.run`이 턴 문맥에 `{id: 'unresolved-results', type: 'note', data: {note, requests: [{requestId, request, document?}]}}`(`unresolvedNote`, `src/server/direct-mode.ts`)를 넣는다. `POST …/requests/:r/acknowledge`(`Execution.acknowledge`)는 `unknown` 요청을 `settles`의 상태(없으면 `interrupted`, `code: HOST_RESULT_UNKNOWN`)로 바꾸고 `heldOnly`·`settles`를 지우며 `acknowledgedAt`을 남긴다. 다른 상태면 그대로 돌려준다. 실행 기록이 없는 `unknown`의 `undo {all: true}`도 같은 처리다. 이전 판이 남긴 `HOST_RESULT_UNRESOLVED` 코드는 표시 문구만 남는다. 이전의 '독립 부모 요청 프로젝트당 2개'와 `WORKSPACE_CAPACITY` 거절은 쓰지 않는다. 대기 상태와 필드는 [ARCH-03](ARCH-03-jig-runtime.md) §10.3이 정한다. 동일 JSON 재접수의 기존 직렬화·멱등성 계약은 유지한다. UI와 서버가 같은 순수 경합 판정을 사용하며 서버가 최종 확인한다. `POST /api/v1/projects/:project/requests/:request/interventions`는 추가 입력을 받아 원본 조건과 합친 새 workspace_requests 행을 queued로 저장하고 서버가 supersedesRequestId를 부여한다. 일반 submit에서 이 필드를 받지 않는다. 별도 스키마/테이블을 추가하지 않는다. 기존 요청 하나에 대기 후속은 하나만 허용하고 후속 대기는 독립 슬롯을 추가 점유하지 않는다. 입력/권한/대상과 직렬화 멱등성을 확인한 뒤 이전 실행을 abort하고 completion을 기다린다. 불명확 결과 또는 확인되지 않은 연계 부분 결과는 후속을 interrupted로 남긴다. 종료 후 실행 직전에 다른 작업과의 충돌을 다시 검사한다. 후속 취소는 이전 실행 종료 대기 후 cancelled로 기록하며 종료 확인 전 완료라고 표시하지 않는다.

UI polling은 시작 프로젝트와 작업 공간 인스턴스를 고정하고 프로젝트 전환 후 결과를 다른 화면에 넣지 않는다. (아래 '후보'는 작업 사본 경로의 결과다. 바로 적용한 AI 편집은 연결 문서 자체가 바뀐다.) 자동 후보 전환은 마지막으로 보낸 요청이고 선택 후보·초안·미완성 스케치가 제출 후 바뀌지 않은 경우만 허용한다. 그 외 완료 결과는 이력에 보존하고 명시적으로 열 수 있다.

문서 쓰기는 직렬화하고, UI 스레드 API 실행은 호스트 프로세스 단위 큐에서도 직렬화한다. 서로 다른 프로세스의 독립 작업은 병렬 실행 가능하다. 같은 호스트의 서로 다른 문서라는 이유만으로 SDK 동시 호출이 가능하다고 가정하지 않는다. 실행 직전에 대상 존재·문서 세션·관련 객체 버전을 재검사한다. readSet을 모르는 임의 코드에는 문서 전체 revision을 보수적으로 적용한다.

Rhino A→Rhino B 복사는 source 기준을 고정한 내보내기 → 형상·속성 자산 검증 → target 단위/좌표 변환 → 대상 생성 → 새 객체 ID와 source lineage 기록 순서다. 양쪽 잠금을 잡은 채 서로 기다리지 않는다. 원본은 변경하지 않는다. 블록/그룹/재질/외부 참조는 전달 패키지에 지원 범위를 명시하고 빠진 관계를 조용히 평탄화하지 않는다. 복사본은 새 객체 ID와 원본 버전 참조를 갖는다. 후속 변경이 자동 양방향 동기화를 만들지 않는다.

### Rhino 편집 문서 진단

Rhino inspectEditor는 선택한 문서의 IsReadOnly를 readOnly로 반환해 열기·취득·저장의 상태 진단에 사용한다. 이전 실행본 응답과 호환하려고 필드는 optional이며, 누락을 false로 간주하지 않는다. 취득 전후 읽기 전용 상태도 비교하며, 취득이 이 상태를 변경하면 HOST_RESULT_UNKNOWN으로 보고한다.

### 사본 결과를 원본에 적용

> 2026-09-30 [ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md)로 AI 편집에는 대체되었다(위 「바로 적용 경로」). 아래는 jig 만들기·가져오기가 내부 작업 사본을 쓰는 동안의 기록이며, 새 AI 편집 기능을 이 경로에 붙이지 않는다.

이 범용 실행 경로의 작업 변화는 VIDE의 실제 후보로 표시하고 사용자 Rhino/ZWCAD 원본에는 적용 지시 때 반영한다. 원본 호스트가 AI 작업과 동시에 바뀌는 것처럼 표시하지 않는다. 이는 SPEC-02.13의 후보/적용 구분이며, ADR-003이 허용한 같은 문서 후보를 제품 전체에서 금지하는 변경은 아니다. 기존 고정 실행 경로와 범용 코드 경로의 지원 방식을 구분한다.

기존 `native-application.mjs`의 이동 적용만으로 범용 결과를 처리하지 않는다. 사본 분기 기준과 결과를 비교해 추가·수정·삭제 및 지원 속성/자원을 묶은 적용 manifest를 만든다. 대상 원본 ID, 사본 ID, 새로 생성할 ID 대응과 실제 payload를 고정한다. 적용할 때 AI에게 설계를 다시 생성시키지 않는다.

첫 이식 범위는 독립 형상과 검증된 속성이다. Rhino는 저장된 사본의 객체를 읽어 Add/Replace와 명시된 삭제를 수행하고 레이어·재질 참조를 매핑한다. ZWCAD는 설치 SDK의 객체 복제/수정 API(예: WblockCloneObjects 계열)의 실제 사용 가능성을 시험하고 ID/Handle 대응을 기록한다. API 이름이 같다는 이유로 호환성을 선언하지 않는다. 블록·그룹·외부 참조·문서 설정·플러그인 데이터는 각각 지원을 검증한다. 이식 불가 항목은 사본 열람/계속 편집만 가능하다고 표시하며 무손실 이식을 약속하지 않는다.

**Rhino 변경분 적용(2026-09-29).** 연결 문서 요청은 Sync 기준의 revision 토큰이 아니라 요청 시점의 문서를 새로 캡처해 편집한다(revision은 재질·문서 속성 이벤트와 사용자의 계속된 작업으로 움직여 요청을 막았다). 캡처 영수증(`<연결 폴더>/<op>.3dm.capture.json`)은 객체별 지문 `objects{vide-id: WorkerScene.Fingerprint}`을 담고, 사본 검증은 파일이 열리는지만 본다(전체 readback 동일성·개수 비교는 하지 않는다). 후보의 `sourceDocument.capture`가 그 캡처를 가리킨다. 원본 적용(`previewEditorApplication`·`applyEditorCandidate`·`recoverEditorApplication`)은 `{capture, changes:{added, modified, removed}}`(작업 사본의 `WorkerChanges` 전체 목록)를 받아 **AI가 바꾼 객체만** 쓴다: 추가·수정 객체는 사본에서 읽어 문서 단위로 변환해 Add/`Replace(Guid, GeometryBase, true)`·ModifyAttributes, 삭제는 명시된 것만 지운다. 수정·삭제 대상은 현재 지문이 캡처 때와 같아야 하며(아니면 `SOURCE_CHANGED`) 잠김·참조·블록 정의 형상이면 `UNSUPPORTED_NATIVE_TARGET`이다. 레이어는 id→전체 경로 순으로 찾고 없으면 만든다. 기존 객체의 재질·그룹은 원본 것을 유지하고 새 객체는 레이어 재질·그룹 없음으로 둔다. 블록 인스턴스 쓰기는 지원하지 않는다. 바뀐 객체가 없는 응답(질문·설명)은 적용 없이 성공(`applicationState: none`)이다. 적용 확인은 쓴 객체의 형상과 삭제 결과만 다시 본다.

원본의 관련 객체·보존 대상과 의존 자원 버전을 적용 직전에 검사한다. 변경을 확인 못 하면 관련 적용을 보류한다. 적용 전 전달 자료를 검증하고, 적용 뒤 실제 객체/속성/ID를 재조회해 기록한다. 일부 실패·응답 유실은 확인분과 불명확분을 분리하고 전체 Undo로 다른 편집을 지우지 않는다. 새 형상 생성→사본 추가 수정→원본 적용→호스트 직접 편집·저장·재열기를 검증한다.


<a id="detail-4"></a>

SDK 단일 대상 요청의 초기 모델 문맥은 `working-model`과 `measurements` 합계 64 KiB·최대 100객체로 제한한다. 핀 ID를 먼저 선정하고 객체의 ID·이름·유형·원점·native ID 및 기존 수량/경계/레이어만 전달한다. 메시·정점·임의 속성은 요약에 넣지 않는다. `model-context-summary`에 total/included/omitted와 불완전 요약 경고를 넣는다. 원본 입력과 핀 참조, 실행기 보호 검사는 별도로 유지한다. 기존 JSON 실행 경로에는 전체 기하 계약을 유지하며 SDK 조회 응답의 페이지화와 네이티브 지원 개수 확대는 별도 검증한다. 전체 패킷 256 KiB 검사도 유지한다.

AI `query`는 선택적인 `offset`(기본 0), `limit`(기본 50, 최대 100), `expectedRevision`, `objectIds`(최대 100)를 받는다. offset>0은 expectedRevision을 요구한다. 제어기는 전체 호스트 스냅샷에서 ID 필터 후 64 KiB 이내의 객체/대응 scene 페이지를 반환하고 `page={offset,total,nextOffset}`를 덧붙인다. revision 불일치는 STALE_REFERENCE, 단일 행 초과는 QUERY_RESULT_TOO_LARGE이다. 전체 네이티브 검증·영수증·저장은 자르지 않는다. 이 단계는 AI 응답량만 제한하고 호스트 IPC/조회 계산의 페이지화는 아직 아니다.

공통 호스트 TCP 수신은 4바이트 프레임 길이를 먼저 검증하고 기본 최대 16 MiB 본문을 한 번 할당한다. CAD 읽기 표시 경로만 아래 별도 수신 크기를 사용한다. 분할된 헤더/UTF-8 본문은 바이트 기준으로 채우고 완성 후 한 번 파싱한다. 과대 응답은 `HOST_RESPONSE_TOO_LARGE`, 빈 응답은 `HOST_INVALID_RESPONSE`로 구분하며 쓰기 재전송은 하지 않는다.

Rhino 자체 SDK에는 문서 객체 수·측정 캐시 수·레이어 범위 수의 상한이 없다(ADR-031 7). 읽기는 페이지로 나뉜다. 남는 전송 상한은 호스트 프레임 하나뿐이다: 요청·응답 모두 16 MiB(`HOST_FRAME_BYTES`, `hosts/common/transport.ts`, C# `WorkerCommand.FrameBytes`)이며, 깨진 길이 값으로 메모리를 잡지 않기 위한 것이다. 넘는 요청은 보내기 전에 `HOST_REQUEST_TOO_LARGE`로 끝난다(호스트도 같은 코드로 답한다). 한 번의 호출 시간은 600초(`HOST_CALL_MS`, C# `WorkerCommand.CallTime`)로, 끊긴 호출만 끝낸다. 레거시 JSON 가져오기 경로의 500개 제한은 없앴다. 객체 하나가 응답 한 덩어리보다 크면 실패시키지 않고 그 객체의 경계 상자를 보낸다(§7 「Rhino 표시 페이지 취득」).

AI execute의 성공 응답은 Rhino snapshot 또는 ZWCAD model을 query의 첫 페이지로 제한한다. 단일 행이 64 KiB를 넘으면 목록 대신 생략 원인과 query 안내를 반환한다. 이 작업 사본 경로에서 Rhino 변경 ID는 종류별 최대 50개를 표시하고 전체 건수를 별도로 기록한다(`writeChanges`, `src/server/write-context.ts`). 바로 적용 경로의 AI 응답은 종류별 200개다(§4 「바로 적용 경로」의 `boundedChanges`). 원래 receipt·last·최종 후보와 보호 검증은 전부 보존한다. 사용자 코드의 value 16 KiB 제한은 그대로다.

Rhino 편집 적용은 그룹 표의 ID·이름·인덱스·사용자 문자열을 후보/대상 문서 간 비교하며 문서 지문에도 포함한다. 기존 객체 업데이트는 `GetGroupList()`를 원본과 비교하고 같은 그룹 목록이면 허용한다. 그룹 표 전체의 기존 서명 비교를 유지한다. 그룹 소속 신규 객체·그룹 구성원 삭제·소속 변경은 Prepare에서 거절한다. Replace/ModifyAttributes와 최종 Metadata 검증은 그대로 사용하며 대상 native ID·그룹 소속을 보존한다. 잠김·참조·이력 등 기존 보호는 해제하지 않는다. 독립 객체의 적용 때문에 그룹을 재생성하거나 인덱스를 추정 매핑하지 않는다.

계정 로그아웃·제거(`/api/v1/accounts/logout`·`remove`)와 로그인·이름 변경·선택 경로는 ADR-025로 VIDE에서 빼며(PLAN-25 2단계, 2026-10-01 진행 중) 이 문서의 계약이 아니다. 계정 관리는 AccountSwitch가 한다(§7 「CLI 기본 로그인 실행 경계」).

## 5. 모델·데이터 저장


Git에서 스냅샷·부모 참조·변경되지 않은 자료 재사용을 차용하되 Git CLI나 전체 객체 내용 주소 저장소를 첫 구현의 선행 조건으로 만들지 않는다. 기존 SQLite·작업 기록·파일 보관을 확장한다. 기록·캐시·체크포인트 생성에 LLM을 호출하지 않는다. [Git 스냅샷 원리](https://git-scm.com/book/en/v2/Getting-Started-What-is-Git%3F).

현재 DB는 §7의 schema 11과 순차 마이그레이션(`src/core/migrations.ts`: 2 기본 표, 3 숨긴 요청, 4 연결 파일 `document_links`, 5 대화·jig 표 — ARCH-03 §10, 6 프로젝트 폴더 `project_folders` — §3 「프로젝트 폴더와 파일 읽기 도구」, 7 할 일 `agenda_items`, 8 할 일 종류 `agenda_items.kind` — §3 「대시보드의 할 일」, 9 객체 판·Sync 목록 — 아래 「Sync 표시 형상의 객체 단위 저장(T-083)」, 10 하루 기록 `day_log` — §3 「대시보드의 할 일」, 11 `agenda_items` 다시 만들기(접수 종류, 끝 날짜·끝 시각·위치·참석자) — 같은 절)을 사용하며 캐시/체크포인트 테이블은 미구현이다. schema 9의 표는 만들어지지만 요청 결과의 쓰기·읽기를 그 표로 옮기는 연결은 PLAN-27 1단계의 남은 순서다. schema 3은 대화 목록에서 지운 요청을 `hidden_requests(projectId, requestId, hiddenAt)`로 기록한다. 요청 기록·결과·연결은 지우지 않으며, 요청 목록 조회와 AI 대화 문맥에서만 제외한다. 확장은 단일 제어 잠금→백업→버전별 마이그레이션 트랜잭션→무결성/기존 자료 대조를 따른다. 실패 시 신규 쓰기를 열지 않고 원본/백업과 진단을 보존한다. 새 DB뿐 아니라 기존 프로젝트·파일 참조 승계와 중간 종료를 시험한다.

현재 전체 문서 지문과 호스트별 객체 제한은 이벤트 추적으로 자동 대체되지 않는다. 애드인의 이벤트 구독이 누락되었거나 연속성이 끊기면 캐시를 신뢰하지 않고 문서 재조회·강한 비교를 수행한다. 이벤트와 지문이 충돌하면 오래된 이벤트 기록을 우선하지 않는다. 자체 SDK 객체 상한의 실측 지원 여부는 호스트 지원표와 L5 검수로 확인한다.

### 프로젝트별 DB(T-124, ADR-032)

[ADR-032](../decisions/ADR-032-per-project-database.md)(`status: review`)의 저장 계약이다(2026-10-06 2단계 구현). 데이터 폴더(`%LOCALAPPDATA%\VIDE`, 개발 엔진은 `.vide/dev-data`)에 두 배치 중 하나가 있다.

- **나뉜 배치(정본):** 공용 `app.sqlite`와 프로젝트마다 `projects/<projectId>/project.sqlite`, 지식 DB `projects/<projectId>/knowledge.sqlite`. 모든 DB는 같은 마이그레이션의 전체 schema(같은 `schema_version`)를 갖고 자기 표에만 행이 있다. 표 분류는 ADR-032 「표 분류」(`src/core/project-split.ts`의 `appTables`·`projectTables`)다. 프로젝트 DB의 `projects`에는 외래 키를 위해 그 프로젝트 한 행만 두며 이름의 정본은 `app.sqlite`다.
- **하나의 DB(이전 배치):** `vide.sqlite` 하나에 모든 행. 나누기가 실패한 동안만 쓴다(아래 「시작」).
- **`Store`(`src/core/store.ts`):** `new Store({ directory })`는 나뉜 배치, `new Store(file)`은 하나의 DB, `new Store(':memory:')`는 메모리의 나뉜 배치(프로젝트마다 메모리 DB, 시험용)다. `store.app`은 공용 DB(하나의 DB 배치에서는 그 DB), `store.db(projectId)`는 그 프로젝트의 DB(모르는 프로젝트는 `NOT_FOUND`), `store.databases()`는 프로젝트 DB 전부(하나의 DB 배치에서는 그 하나)다. 프로젝트 DB는 시작 때 모두 열고 계속 연다. 프로젝트를 만들면(`createProject`·`ensureProject`) 폴더와 DB를 만들고, 지우면(`deleteProject`, 진행 중 요청이 있으면 `PROJECT_BUSY`) DB를 닫고 폴더를 지운다. 프로젝트 행을 다루는 클래스(`DocumentLinks`·`JigStore`·`ConversationStore`·`KnowledgeReviewStore`·`ProjectFolders`·`JigDrafts`)는 `Store`를 받아 메서드의 `projectId`로 DB를 고르며 SQL은 그대로다. 인스턴스 ID·대화 ID만으로 찾는 메서드는 그 행이 있는 프로젝트 DB를 찾아 기억한다. `ModelStore`는 DB마다 하나(`Workspace.models(projectId)`)다. `jig_packages`는 `app.sqlite`에서 읽는다. 트랜잭션은 DB 하나 안에서만 연다(`store.tx(db, fn)`).
- **프로젝트를 가로지르는 검사:** 엔진은 한 프로세스이고 SQLite 호출이 동기이므로 확인과 쓰기 사이에 다른 쓰기가 끼지 않는다. 요청 ID는 `app.sqlite`의 `request_index(id, projectId)`로 찾는다(만들 때 기록, 지울 때 삭제, 시작 때 프로젝트 DB에서 다시 만듦; 색인에 없거나 낡으면 프로젝트 DB를 차례로 찾고 고침; 버전 schema 밖의 캐시 표). 같은 ID의 요청이 다른 프로젝트에 있으면 `REVISION_CONFLICT`다. 한 열린 문서는 한 프로젝트에만 연결(`DOCUMENT_ALREADY_CONNECTED`, `connectedDocument`), 불확실한 쓰기(`hasUncertainWrite`)는 같은 호스트 문서의 다른 프로젝트 기록까지, 명령 ID·검토 메모 ID·`shared_feedback.identity`는 모든 프로젝트에서 하나다 — 이 검사들은 `store.databases()`를 차례로 묻는다(`findDb`). 최근 활동, 닫힌 대화 정리, 작업 사본 정리의 사용 중 경로, 시작 때 요청 복구, 저장 정리(`maintainModels`, DB마다 차례로), `compact`(DB마다)도 프로젝트 DB 전부를 본다. `query`의 `storedDisplay`는 DB마다 가장 새 표시 Sync를 찾고 그중 `createdAt`이 가장 늦은 것을 쓴다.
- **시작(`openStore`, `src/core/store-open.ts`):** `app.sqlite`가 있으면 나뉜 배치. `vide.sqlite`만 있으면 한 번 열어 schema를 올린 뒤(이전과 같은 오류로 실패할 수 있음) `splitProjectDatabase`(ADR-032 「이행」: 백업·검사·실패 시 되돌리기)를 돌리고, 성공하면 나뉜 배치로 연다. 나누기가 실패하면 이전과 똑같이 `vide.sqlite` 하나로 열고 진단 기록에 `db-split-failed {code, layout:'single'}`을 남기며, 다음 시작이 다시 시도한다. 성공은 `db-split {ms, bytes, projects, knowledge, layout}`, 두 배치가 함께 있으면 `db-split-conflict`(나뉜 배치를 쓰고 `vide.sqlite`는 건드리지 않음). 둘 다 없으면(새 설치) 나뉜 배치로 만든다. 잠금은 두 배치 모두 `vide.sqlite.controller`다. 이전 설치본은 나뉜 데이터 폴더를 모른다; 되돌릴 때는 `vide.sqlite.migrated`(·`-wal`)를 `vide.sqlite`로 되돌린다.
- **백업:** 마이그레이션 전 백업은 DB 파일마다 `<파일>.backups`에 만든다. `backupWorkspace`(`src/core/backup.ts`)는 나뉜 배치에서 `app.sqlite`와 프로젝트마다 `project.sqlite`·`knowledge.sqlite`를 같은 상대 경로로 복사하고, `verifyBackup`은 `app.sqlite`(또는 `vide.sqlite`)와 각 `project.sqlite`의 schema를 확인한다.
- **AI 읽기:** §3 「프로젝트 폴더와 파일 도구」의 프로젝트 기록 규칙.

### 첫 구현의 세 가지 기록

| 기록 | 저장 방식·필드 |
|---|---|
| 객체 현재 상태·캐시 | 문서/객체 ID, 관측 세대, 형상 revision, 속성 revision, dirty/삭제 여부. 캐시 키는 이 기준+계산 종류·단위·tolerance·계산기 버전 |
| 작업별 변경 요약 | 기존 operationId에 문서별 추가/수정/삭제와 이전·이후 기준, 관측 시각을 연결. 외부 작업은 별도 관측 ID |
| 체크포인트 | id, parentId, 문서별 기준과 네이티브 파일 참조, 속성·관계·표 정의·근거 manifest, 해시·생성 시각·복원 범위 |

애드인은 추가·삭제·교체·속성·Undo/Redo 이벤트로 dirty 집합을 갱신하고 명령 종료/안정 시점에 요약을 묶는다. 매 드래그·조회·도구 호출에 파일을 복사하거나 전체 객체를 직렬화/해시하지 않는다. 관측할 수 없는 외부 편집자의 신원·정확한 수정 시각·순서를 만들어 넣지 않는다.

형상 변경이 확인된 객체만 필요한 면적·체적을 배치 계산한다. 이름 등 무관한 속성 변경은 형상 캐시를 무효화하지 않는다. 이동/회전도 보존되는 수량임을 확인한 경우 재사용하고 비균일 스케일 등은 재계산한다. 재연결 시 기준의 연속성을 보장하지 못하면 해당 캐시를 무효화하고 스냅샷 비교로 현재 상태를 확인한다. 읽을 때마다 전체 형상 해시를 다시 계산하지 않는다.

### 재시작 후 계산 캐시

캐시 무효화와 즉시 전체 재계산은 다르다. 필요한 값부터 계산한다. 저장 파일 해시가 이전 기준과 같고 열린 문서가 그 파일과 일치하며 미수정이고 단위·tolerance·계산기 버전도 같으면 저장된 캐시를 재사용한다. 경로·수정 시각만 같다는 근거는 부족하다.

파일이 변경됐으면 재연결 때 한 번 객체 기준을 대조한다. SDK CRC 등 값싼 지문은 변경 후보를 좁히는 보조 수단이며 단독으로 무충돌 동일성을 보장하지 않는다. 객체 ID/내용 비교와 계산 조건으로 연속성을 확인한 경우만 재사용한다. 같은 파일 재열기에서 재측정 0건, 외부 수정 파일에서 확인된 변경 객체만 재측정, 비교 불가 객체의 명시적 무효화를 시험한다.

### 실행본 내부의 직전 export 수량

Rhino 실행기는 성공한 전체 export마다 객체 ID·기하 해시·수량을 현재 객체 집합으로 교체한다. 동일 실행본의 후속 export는 단위·절대/상대/각도 tolerance가 같고 기하 해시가 일치할 때 이 수량을 우선 재사용한다. 조건이 바뀌면 기존 내부 캐시와 처음 파일 기준의 외부 캐시를 사용하지 않고 재계산한다. 삭제 객체의 항목은 다음 성공 export에서 제외한다. 계산 버전 1에 한정된 프로세스 내부 캐시이며 프로세스 종료 후 남지 않는다. 모델 전체 export 실패 시 새 캐시를 확정하지 않는다. 기하 해시와 메시 생성은 계속 수행하므로 이 최적화의 대상은 수량 계산이다.

### Rhino 측정 캐시의 평행이동 검증

기존 파일 해시·계산 버전으로 확인된 측정 캐시에 한해, 동일 기하 또는 평행이동으로 동일성이 확인된 기하의 면적·체적·길이를 재사용한다. 원본과 현재 경계 상자 중심 차이를 원 기하 사본에 적용한 뒤 GeometryEquals가 참인 경우만 재사용한다. 형상 일치 검증 전에는 경계 상자만으로 동일하다고 판단하지 않는다. 회전·크기 변경·미확인 편집·새 객체·단위/계산 버전 변경은 이 증거로 재사용하지 않는다. geometry 변경 집합과 world bounds는 계속 갱신하며 측정 재사용을 객체 무변경으로 처리하지 않는다. 변환 이벤트는 직접 SDK 경로에서 관측되지 않은 실험 결과 때문에 이 캐시의 근거로 사용하지 않는다.

### 수동 Sync의 객체별 측정 재사용

Rhino scene은 기하 직렬화(렌더/분석 메시 제외)의 SHA-256인 geometryHash를 선택적으로 제공한다. 기존 측정 버전 1은 계산 알고리즘 버전으로 유지하며, geometryHash가 없는 이전 결과는 Sync 캐시에서 제외한다. 제어기는 같은 프로젝트·호스트 실행 인스턴스·문서 ID의 성공한 직전 취득 결과에서만 버전 1의 측정과 기하 해시를 가져온다. 브라우저나 AI가 보낸 측정을 캐시로 받지 않는다.

새로 취득한 사본은 기존대로 해시 확인·미터 정규화·재읽기를 거친다. export의 geometryMeasurementCache는 객체 ID와 정규화 후 전체 기하 해시가 일치할 때만 재사용한다. ID가 같아도 기하가 달라지면 재계산하고, 누락/새 객체는 계산하며 삭제 객체는 출력하지 않는다. 속성만 변경된 객체는 수량을 재사용하면서 최신 속성을 반환한다. 이 캐시는 기존 작업 사본의 measurementCache(확인된 기준 파일과 이동 일치 검증)와 별도 입력이다. 계산 버전·해시가 없거나 달라지면 재계산한다. 자료는 기존 성공 결과 DB에 저장하므로 별도 캐시 DB나 자동 Sync를 추가하지 않는다.

### 체크포인트·과거 사본 열람·보존

AI 과업 완료 또는 명시적 저장/체크포인트 시 .3dm/.dwg와 데이터 manifest를 묶는다. 변경되지 않은 파일은 기존 참조를 재사용한다. 여러 문서의 기준과 취득 시점을 남기며 동시 원자 스냅샷이라고 표시하지 않는다. 취득 중 변경이면 해당 문서를 재취득하거나 불일치를 기록한다. 모든 중간 편집을 복원할 수 있다고 약속하지 않는다.

모델·속성·관계·표 정의·근거를 같은 체크포인트 기준으로 보존하고 과거 모델과 최신 데이터를 섞지 않는다. 단순 manifest와 입력 기준으로 정합성을 확보하며 재생성 가능한 표/메시 캐시와 보존할 게시 산출물을 구분한다. 삭제는 객체 외부 변경 요약에 남기고 복원 가능 여부는 보관한 네이티브 파일 기준으로 표시한다. 최신 key-value는 필요한 추적값의 미러이며 누적 이력의 정본이 아니다. 자기 속성 갱신은 형상 변경 이벤트와 구분한다.

파일을 임시 위치에 기록→해시 확인·확정→SQLite 트랜잭션으로 체크포인트 참조 순서로 저장한다. 중단된 파일을 완성 체크포인트로 노출하지 않는다. 보관한 네이티브 파일을 별도 사본으로 열어 당시 자료와 함께 확인한다. 과거 상태를 현재 원본으로 되돌리는 기능과 삭제 객체의 자동 복원은 PRD §14.2의 후속 범위다. 이 문서 §4의 바로 적용·되돌리기(실행 하나 단위)와 과거 복원 기능을 혼동하지 않는다.

백업은 일관된 DB와 참조 파일·manifest를 함께 검증한다. 확정 이력·모델은 자동 삭제하지 않으며 임시 파일·재생성 캐시는 구분된 TTL/용량 제한을 둔다. 기존 데이터는 마이그레이션 전 백업한다.

### 측정 후 추가할 저장 최적화

Sync 표시 형상의 객체별 불변 blob·내용 지문 중복 제거·참조 없는 판 정리는 측정 결과에 따라 아래 「Sync 표시 형상의 객체 단위 저장」으로 도입한다. 체크포인트·관계 의존 색인은 여전히 필요할 때 도입하며, 도입 시 직렬화 결정성·삭제 참조·게시본/백업 보존을 검증한다. 자동 병합·고급 브랜치 UI는 FR-20의 후속 범위다.

### Sync 표시 형상의 객체 단위 저장(T-083)

[PLAN-27](../plans/PLAN-27-sync-storage-stability.md) 1단계의 물리 계약이다. 뜻(무엇을 Sync로 보이고 언제 갱신하는지)은 SPEC-01.11이 정하고, 이 절은 저장·조회 형식만 정한다. 계약은 2026-10-02 사용자가 확인했다(표시 형상의 float32 차이 저장, 기존 결과 옮기기, 아래 「정리」의 보존 규칙 포함). 저장 모듈은 `src/core/model-store.ts`(`ModelStore`), 옮기기는 `src/core/model-move.ts`다.

**바꾸는 이유(2026-10-02 설치본 실측).**
- 10,117개 객체 문서(Brep 4,649, Mesh 2,594, 블록 1,269, 곡선 1,267, 100 KB 넘는 메시 71개 ≈31 MB)의 Sync 결과 한 행이 88 MB이고 그중 `scene` 배열이 84.6 MB다.
- 그날 오전에만 같은 문서의 전체 사본 8개(각 78~94 MB, 합계 666 MB)가 DB에 쌓였다. 전체 Sync마다, 그리고 기준 Sync를 다른 요청이 참조할 때의 Live Sync마다 JSON 행 전체를 새로 쓰기 때문이다.
- Live Sync는 변경 하나에도 88 MB 행을 다시 해석·병합·직렬화해 통째로 쓴다(`src/server/live-sync.ts:86-117`).
- 이런 무거운 Sync 직후 엔진이 `0xC0000409`로 거듭 끝났다(원인은 미확정, PLAN-27 0단계 기록).

**대상.** 결과에 `scene` 배열이 있는 모든 요청 결과(연결 문서 Sync·Live Sync, 파일 불러오기, 형상을 담은 실행 결과)의 `objects[]`·`scene[]`·`definitions{}`. 그 밖의 결과 필드(`sourceDocument`, `layers`, `displayCoverage`, `measurementVersion`, `text`, `code` 등)는 지금처럼 `workspace_requests.result` JSON에 남는다. `scene`이 없는 결과는 바꾸지 않는다.

**표(schema 9, `src/core/migrations.ts`).**

| 표 | 열·제약 |
|---|---|
| `object_versions` | `projectId`(→projects), `id`(내용 지문), `kind`(`object`\|`definition`), `meta` TEXT, `geometry` BLOB NULL, `size` INTEGER. 기본 키 `(projectId, id)`. 한 번 쓰면 바꾸지 않는다 |
| `sync_manifests` | `requestId` 기본 키(→workspace_requests, ON DELETE CASCADE), `projectId`, `parentId` NULL(이 목록을 복사·이어 온 이전 Sync), `documentRevision` NULL(읽은 호스트 문서의 변경 번호 = `sourceDocument.revision`), `revision` INTEGER(이 목록이 바뀔 때마다 1 증가), `objectCount`(결과에 `objects` 배열이 없었으면 NULL), `definitionCount`(`definitions`가 없었으면 NULL), `updatedAt` |
| `sync_manifest_items` | `requestId`(→sync_manifests, ON DELETE CASCADE), `projectId`, `kind`, `key`(객체는 `nativeId ?? id` — `applyDisplayDelta`와 같은 키, 정의는 GUID), `position`(객체 순서, 정의는 `definitions`의 키 순서), `versionId`, `revision`(이 줄이 마지막으로 바뀐 목록 revision). 기본 키 `(requestId, kind, key)`, `(projectId, versionId)` → `object_versions` 외래 키, 색인 `(projectId, versionId)`·`(requestId, revision)` |
| `sync_manifest_removed` | `requestId`(CASCADE), `kind`, `key`, `revision`. Live Sync가 지운 줄의 기록(화면 증분용, 아래 조회). 목록 revision이 100번 넘게 지난 기록은 지운다 |

**객체 판.**
- 객체 하나 = `objects[]` 행과 같은 키의 `scene[]` 행 한 쌍(한쪽만 있으면 그쪽만). 정의 하나 = `definitions[GUID]` 값. 목록의 위치 하나로 `objects`와 `scene`의 순서를 함께 되살리므로, 키가 겹치거나 두 배열의 순서가 서로 어긋나는 결과는 `MODEL_STORE_UNSUPPORTED`로 JSON에 둔다.
- `meta`: `{object?, scene?}` 또는 `{definition}`. `scene`·`definition`에서는 `vertices`·`line`·`segments`·`indices` 배열을 빼고 그 키 자리에 문자열 `"$bin"`을 둔다(키 순서를 지켜 이어 붙인 VGT1이 지금 응답과 바이트 단위로 같게 하려는 것). 측정값(`area`·`volume`·`length`)·`geometryHash`·속성·블록 `transform`은 `meta`에 숫자 그대로 남는다.
- `geometry`: 빠진 배열만 담은 VGT1 컨테이너 하나(`src/contracts/geometry-transfer.ts`의 형식을 객체 단위로 쓴다). 머리 JSON은 `{vertices?, line?, segments?, indices?}` 자리마다 `$bin` 참조이고, 좌표 배열은 배열마다 첫 점을 float64 원점으로, 정점을 그 원점과의 float32 차이로 둔다. `indices`는 u16/u32. 배열이 없으면 NULL. 같은 모델 실측: JSON 64.8 MB → 18.2 MB, 만들기 254 ms → 13 ms, 읽기 105 ms → 1 ms, 오차 0.001 mm.
- `id` = SHA-256(`kind` ‖ 키 정렬 JSON의 `meta` ‖ `geometry` 바이트) 16진(`versionId`, `src/core/model-store.ts`. `geometry-transfer.ts`는 화면도 쓰므로 Node 해시를 두지 않는다). 지문은 저장 정밀도(float32 차이)로 바꾼 뒤의 바이트로 계산하므로 같은 객체를 다시 읽으면 같은 판이 된다. 키는 `objects[].id`가 아니라 내용이라, 객체가 그대로면 Sync가 몇 번이든 판은 하나다.
- 표시 형상은 저장 단계에서 float32 차이로 바뀐다(화면은 이미 이 값을 받고 있음, 2026-10-02 사용자 수락). 측정·`geometryHash`·호스트 적용은 이 값을 쓰지 않는다. 저장된 `scene` 배열을 원래 JSON과 숫자 그대로 비교하는 코드는 같은 변환 뒤에 비교하거나 지문으로 비교한다.

**쓰기.** 모두 `Workspace`(`src/core/workspace.ts`)가 한 트랜잭션으로 한다.
- 전체 Sync·불러오기·실행 결과(`update(…, result)`에 `scene` 배열): 객체·정의마다 판을 만들어 `INSERT OR IGNORE`, 목록 행·줄을 쓰고, `result` JSON에서는 `objects`·`scene`·`definitions`를 빼고 `modelStore: 'manifest'`를 둔다. 바뀌지 않은 객체는 이미 있는 판을 가리키므로 새로 쓰는 것은 목록 줄(객체당 약 100 B)과 바뀐 판뿐이다. `parentId`는 같은 연결 파일(`input.linkId`, 없으면 같은 문서)의 직전 성공 Sync다.
- Live Sync(`applyDelta`): 기준 Sync의 목록과 `result`의 작은 필드만 읽는다. 바뀐·새 객체와 정의의 판을 넣고, 그 줄만 `versionId`·`revision`을 바꾸거나 새 줄을 뒤에 붙이고(`position` = 최댓값 + 1), 지운 객체의 줄을 빼고 `sync_manifest_removed`에 남긴다. `result`의 `sourceDocument`(revision·documentHash)·`layers`·`displayCoverage`만 고친다(플러그인이 변경 페이지마다 보내는 값을 쓰고, 없을 때만 목록의 `meta`로 다시 센다). 형상 전체를 읽거나 해석하지 않는다.
- 참조된 기준: 다른 요청이 기준 Sync를 참조하면(지금과 같은 판정, `input`에 그 ID) 기준은 고치지 않는다. 새 요청 행(`captureInput`)과 목록을 만들고 `INSERT … SELECT`로 줄만 복사한 뒤(판은 공유) 같은 Live Sync를 새 목록에 적용한다. 복사본은 부모의 `revision`과 줄 `revision`을 이어받고 `parentId`가 부모다. 보류(`keep`) 때문에 만든 복사본은 `LiveSync`가 문서마다 기억해, 보류가 이어지는 동안의 다음 Live Sync는 그 복사본을 제자리에서 고친다(T-127). 그 복사본을 다른 것이 참조하거나(`ModelStore.references`) 초안이 쓰고 있으면(`held`, 아래 「사용자 Sync」) 다시 복사한다.
- 쓰기 뒤 그 쓰기에서 빠진 판(교체·삭제된 줄이 가리키던 것) 가운데 어떤 줄도 가리키지 않는 것을 지운다.

**읽기와 하위 호환.**
- `Workspace.get(projectId, id)`: 지금과 같은 모양(`objects`·`scene`·`definitions`를 채운 결과)을 목록에서 다시 만든다. 기존 호출부는 그대로 동작한다. `modelStore`가 없는 행(옮기기 전)은 지금처럼 JSON을 그대로 읽는다.
- `Workspace.summary`·`list`: `result` JSON에 `meta`의 `object`만 모은 `objects`를 붙이고 `sceneOmitted: true`(지금 응답과 같음). 형상은 열지 않는다. 해석 캐시 키에 목록의 `revision`을 더한다(제자리 Live Sync는 `result` 크기가 같을 수 있음).
- `Workspace.model(projectId, id)`(새, 지연 조회, AI 턴의 표시 Sync 기준·바로 적용 `query`도 이것만 씀, T-123): `result`(형상 없음), `keys()`, `object(key)`·`scene(key)`(그 객체 하나만 해석), `rows(keys?)`(`meta`만), `geometry()`(아래 이진 응답용, 숫자로 풀지 않음). 한 객체·일부 객체·측정값만 필요한 호출부는 `get` 대신 이것을 쓴다(목록은 PLAN-27 1단계).
- 직전 측정 재사용(§5 「수동 Sync의 객체별 측정 재사용」)은 `list({full: true})` 대신 직전 Sync 목록의 `meta`에서 `id`·`geometryHash`·측정값만 SQL로 읽는다.
- `Workspace.lazy(projectId, id)`(T-129, 2026-10-06): `get`과 같은 모양이지만 모델을 조립하지 않는다. `scene`은 `StoredList`(반복할 때마다 목록을 `position` 순으로 한 줄씩 읽음)이고 각 항목은 `lazyItem`(`src/contracts/geometry-transfer.ts`: 좌표·색인 배열이 처음 읽힐 때 그 객체의 버퍼만 풂, `decodeItem`과 같은 값)이다. `objects`는 `summary`의 객체 줄(형상 없음, 저장 변경마다 한 번 해석, 읽기 전용), `definitions`는 키를 처음 읽을 때 그 정의만 푸는 기록이다. JSON·정리된 결과는 `get`과 같다. 검사가 필요한 독자는 `src/core/scene-items.ts`의 `sceneItems`로 항목을 하나씩 같은 항목 schema로 검사하고, `lazyCandidate`는 객체 줄을 배열로 준다.
- `lazy`를 쓰는 독자(모델 전체를 `get`으로 읽지 않음): 구조 jig 레이어 목록·진단(`…/jigs/structure/layers|diagnose`, 레이어 목록은 좌표를 풀지 않고 진단은 Sync마다 고른 레이어를 한 번 읽음), jig 입력 읽기의 저장 Sync 경로(`readForJig`), Sync jig(`…/jigs/sync`), 구조 해석 jig 초안(`…/jigs/structure/draft`, 레이어·객체를 먼저 거르고 좌표를 읽음), 수량표·비교·보고서·검토본·웹 게시·공유 의견 기준 해시·확장 실행, 오프라인 보기 스냅샷. 요청 사슬 확인(`relatedCandidates`)·질문 카드의 답 턴은 `brief`만 읽는다. 구조 jig 초안·확정 기록의 `sources[].revision`은 그때의 목록 `revision`이며, 다르면(제자리 Live Sync) '오래됨'이다.
- 아직 모델 전체를 다루는 곳: 작업 사본 실행의 결과(`worker.exportModel`, 새 후보 모델이라 저장할 전체가 필요하고 전송 형식은 호스트 연결 쪽 작업), 표시 Sync 기준 실행의 새 캡처 불러오기(`captureEditor`, 파일이 없는 기준이라 캡처가 필요), 작업 사본·DWG 기준 턴의 `previousOf`(보호 객체 비교·측정 재사용). ZWCAD 작업 사본 실행은 보호 핀이 있을 때만 기준 모델을 검사한다.

**API 응답.**
- `GET …/requests`: `scene`·`definitions` 없음(`sceneOmitted`). 표시 Sync(`displayOnly: true`) 행은 `objects`도 빼고 `objectsOmitted: true`·`objectCount`를 둔다(T-123, 2026-10-06). `POST …/capture` 응답도 같은 모양이다. 엔진 안의 `Workspace.list`·`summary`는 고정 확인 등을 위해 `objects`를 그대로 가진다(형상 없음, 캐시).
- `GET …/requests/:r?view=summary`(새, T-123): 그 요청 하나를 목록과 같은 모양으로 준다(형상·표시 Sync 객체 줄 없음).
- `GET …/requests/:r/objects[?ids=<id,…>][&native=<Rhino id,…>][&offset=&limit=]`(새, T-123): 그 요청의 `objects[]` 줄만 JSON(`{requestId, objects, nextOffset?}`)으로 준다. 형상은 열지 않는다. `ids`가 있으면 그 객체만, `native`가 있으면 그 Rhino ID(대소문자 무관)의 객체만. 둘 다 없으면 표시 순서로 한 쪽(`limit` 기본·최대 2000, `offset` 기본 0)만 주고 다음 쪽이 있으면 `nextOffset`을 붙인다(T-127, 화면 `withObjects`가 차례로 받음). 목록에서 빠진 객체 줄이 필요한 화면(Rhino 패널의 고정·선택, 후속 초안, 외부 의견 첨부, jig의 객체 찾기)이 쓴다.
- `GET …/requests/:r`에 `Accept: application/vnd.vide.geometry`: 지금과 같은 VGT1 컨테이너를 저장된 객체별 버퍼를 이어 붙이고 각 `$bin` 오프셋만 고쳐 만든다(좌표를 풀거나 다시 인코딩하지 않음). 화면(`src/ui/gateway.ts`)은 바꾸지 않아도 된다. 이 헤더가 없으면 JSON이지만, 표시 Sync(`displayOnly`)는 모델 전체를 JSON으로 보내지 않고 `406 GEOMETRY_BINARY_REQUIRED`로 거절한다(T-127). 상태·객체 줄은 `?view=summary`·`…/objects`로 읽는다.
- `GET …/requests/:r/delta?since=<revision>[&base=<parentId>]`(새, T-084의 알림용): `revision`이 `since`보다 큰 줄의 `objects`·`scene`·`definitions`와 `removed`, 지금 `revision`을 VGT1로 준다. 모양은 지금 Live Sync 응답의 `delta`와 같아 화면의 `applyDisplayDelta`를 그대로 쓴다. `base`가 이 목록의 `parentId`이면 부모 revision에서 이어 준다. `since`가 지운 기록보다 오래됐으면 `full: true`로 알려 전체를 받게 한다. `&view=rows`이면 형상 없이 `objects`·`removed`·`revision`만 JSON으로 준다(`scene: []`, 호스트 패널용).
- `POST …/live-sync` 응답(`delta` JSON과 요약)은 바꾸지 않는다.

**기존 결과 옮기기.**
- schema 9 마이그레이션은 표만 만든다. 기존 `migrateDatabase`가 그 전에 백업 하나를 `vide.sqlite.backups`에 만든다(`VACUUM INTO`, quick_check).
- 엔진이 주소를 연 뒤 백그라운드에서 `scene`이 남은 행(`json_type(result,'$.scene')='array'`, 대기·실행 중이 아닌 행)을 한 행씩 옮긴다(2026-10-02 사용자 확인). 행마다 한 트랜잭션: 해석 → 판·목록 쓰기 → `result` 다시 쓰기 → 다시 만든 모델과 원래 모델(같은 float32 변환 뒤)의 객체 ID·지문 대조. 어긋나면 그 행을 되돌리고 `model-move-failed`를 기록한 채 JSON으로 둔다. 행 사이에 이벤트 루프를 놓아 준다. 진행은 `model-move {request, bytes, versions, ms}`로 기록한다. 중간에 끝나도 남은 행은 다음 시작에 이어 옮기며, 그동안 읽기는 두 형식을 모두 받는다.
- 다 옮기면 대기·실행 중 요청이 없을 때 `VACUUM`을 한 번 한다. 그때 못 하면 다음 시작 때 주소를 열기 전에 한다.

**정리.**
- 어떤 줄도 가리키지 않는 판은 쓰기 직후(그 쓰기의 후보만), `workspace.purge` 뒤, 엔진 시작 때(전체) 지운다. 프로젝트 삭제(`src/core/store.ts`)는 그 프로젝트의 목록·판을 함께 지운다.
- 보존 규칙(2026-10-02 사용자 결정, T-087에서 앞당김, `ModelStore.retain`): 문서(연결 파일 `input.linkId`, 없으면 호스트·인스턴스·문서 번호)마다 최근 Sync 목록 20개와, 무엇이 가리키는 Sync 목록(다른 요청의 입력·기준 `baseRequestId`·핀, 검토본·검토 의견, 비교, 웹 게시·공유 의견, jig 읽기·만들기, 대화 기록)은 남긴다. 그 밖의 Sync 목록(입력 `source: 'document'`인 요청의 것)은 지우고 요청 결과에 `modelStore: 'pruned'`를 남긴 뒤, 어떤 줄도 가리키지 않게 된 판을 지운다. 대기·실행 중 요청의 목록과 Sync가 아닌 결과(불러오기·실행 결과)의 목록은 이 규칙으로 지우지 않는다. 요청 행 자체는 지우지 않는다.

**목표값(객체 1만 개).** Live Sync 한 번의 엔진 처리 100 ms 안팎(객체 수와 무관), 바뀌지 않은 문서의 전체 Sync 한 번에 DB 증가 약 3~4 MB(목록 줄. 약 1 MB로 줄이려면 목록 줄을 정수 목록 번호와 32 B 지문으로 바꾸는 schema 변경이 필요하며, 보존 규칙이 문서당 개수를 묶는다), 고정·요청 확인이 형상을 해석하지 않음.

### 호스트 표시 페이지의 바이너리 형상(T-128)

Rhino 편집 창의 표시 페이지(`displayPage`, 첫 Sync·전체 다시 읽기·RESYNC)와 Live 변경 페이지(`displayChanges`)는 좌표를 숫자 문자열이 아닌 VGT1로 보낸다([ADR-031](../decisions/ADR-031-stock-first.md) 5의 마지막 경로).

- **요청과 호환:** 엔진은 두 메서드의 요청에 `geometry: "vgt1"`을 붙인다. 이 값을 아는 플러그인만 바이너리로 답하고, 이전 플러그인은 모르는 필드를 무시하고 JSON으로 답한다. 이전 엔진은 이 값을 보내지 않으므로 새 플러그인도 JSON으로 답한다. 별도 연결 절차(handshake)는 없다.
- **틀:** 응답 틀(길이 4바이트 BE + 본문, 16 MB 상한)은 그대로이고 본문 하나가 VGT1 컨테이너다: `"VGT1"` | u32 LE 머리 길이 | 머리 JSON `{"status":"success","result":<페이지>}` | 4바이트 정렬 | 버퍼. 페이지의 객체 줄·ID·이름·레이어·`geometryHash`·속성·`texts`·블록 `transform`·`coverage`·`layers`·`page`는 머리 JSON에 그대로 있다. `scene[]`·`definitions{}` 항목의 `vertices`·`line`·`segments`(값 3개 이상)는 `{"$bin":[offset,count,"f",ox,oy,oz]}`(첫 점을 float64 원점으로, 나머지는 그 원점과의 float32 차이), `indices`(값 1개 이상)는 모든 값이 65535 이하이면 `"u16"`, 아니면 `"u32"`. 빈 배열은 JSON `[]`이다. 전송(`hosts/common/transport.ts`)은 본문 앞 4바이트로 VGT1과 JSON을 구별한다.
- **같은 값·같은 바이트:** 플러그인은 좌표를 미터로 1 µm에 반올림한 값에서 이 버퍼를 만든다. 이것은 엔진이 같은 페이지의 JSON을 객체별로 저장할 때(§5 「Sync 표시 형상의 객체 단위 저장」) 만드는 버퍼와 바이트 단위로 같다. `geometryHash`는 전처럼 JSON 숫자 문자열로 계산해 두 형식에서 같다(검토 비교·측정 재사용이 플러그인을 바꾼 뒤에도 같은 객체를 같은 것으로 본다).
- **엔진에서:** 표시 Sync(`SdkExecution.syncEditor`)는 받은 형식화 배열(`PackedPositions`·`Uint16Array`/`Uint32Array`, 받은 틀 위의 보기)을 숫자 배열로 풀지 않고 `ModelStore`까지 넘기며, 저장은 그 바이트를 그대로 쓴다(`packedDisplayModelSchema`로 검사, 배열마다 `toJSON`이 있어 JSON으로 쓰이면 전과 같은 숫자 배열). 레이어 범위 읽기(jig 입력)·`query`의 전체 읽기·Live 변경 페이지는 숫자 배열로 되돌린다(`plainPage`).
- **상한:** 페이지 예산(12 MiB)과 한 객체가 그보다 크면 경계 상자(`oversized`)로 보내는 규칙(ADR-031 7)은 그대로이며, 예산은 바이너리 크기로 센다.
- **실측(합성 1만 개, 상자 메시 6천·원기둥 메시 2천·곡선 2천, `tests/server/binary-pages.test.mjs`):** 페이지 26.3 MB → 16.5 MB, 엔진 읽기 약 490~590 ms → 약 180~310 ms, 객체별 저장 인코딩 약 90 ms → 약 45 ms, 읽은 모델이 차지하는 메모리 약 44 MB → 약 18~22 MB. 객체 줄·ID·해시 같은 JSON 부분이 남아 크기는 약 37 % 준다(좌표만은 약 1/3).


<a id="detail-5"></a>

## 6. 외부 공유


2026-09-21 사용자 지시로 **이번 T-009 실험은 Cloudflare 단독 구성으로 확정**했다. AWS는 선택 근거를 보존하는 비용 참고이며 이번 구현·비교 실험 대상이 아니다. Cloudflare에서 요구 충족이 불가능하다는 구체적 증거가 생길 때만 호스팅 결정을 다시 검토한다. 공급자 선택 근거는 ADR-015, 이 절은 기술 구성의 정본이다. 로컬 AI/CAD 실행은 사용자 PC에 유지하며 클라우드에는 계정·멤버십·게시본·의견만 둔다. 2026-09-22 사용자 후속 결정으로 실험은 두 모드로 나뉜다. **현재 모드**는 무료 범위·메일 없는 가입·소유자 승인 참여이다. 배포 진행과 시험 결과는 PLAN §6.5에서 확인한다. **후속 모드**는 메일 인증·초대 메일이며 발신 도메인·요금제 승인 뒤에 연다. 속도·비용·운영 복구 검증은 완료가 아니다. 이번 확정 범위는 이 문서 §6의 Cloudflare 실험 구성이며 문서 전체의 모든 미결 항목을 일괄 승인한 것으로 확대하지 않는다. 계정·지역·예산/보존 정책은 OQ-04·09와 연결해 실제 구매/게시 전에 정한다. 공유 서비스 미결은 로컬 구현을 막지 않는다.

### 확정 구성

| 구간 | Cloudflare 단독 |
|---|---|
| 화면·API | Static Assets + Workers Paid |
| 계정·권한·의견 DB | D1 |
| 게시 파일 | 비공개 R2 + 권한 확인 후 전달 |
| 로그인 | Workers/D1 호환 인증 라이브러리. 현재 모드: 메일 없는 가입 + 소유자 승인(SPEC-04.8). 후속 모드: 메일 인증 |
| 인증·초대 메일 | 후속 모드에서 Cloudflare Email Service. 현재 모드에서는 바인딩을 배포에서 제거 |
| 백업·운영 | D1 복원/반출 + R2 보관, Workers 배포 롤백 |

인증 라이브러리는 구현 의존성이며 별도 유료 인증 호스팅을 추가하는 뜻이 아니다. 암호·세션 프로토콜을 새로 만들지 않는다. [Better Auth의 D1 지원](https://better-auth.com/blog/1-5)은 후보 근거이며 설치 버전의 Workers/D1 호환성과 계정 복구를 먼저 시험한다. [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)도 운영 계정에서 실제 발송 가능 여부를 확인하며 메일을 무료로 가정하지 않는다. 지원 문제를 숨기려고 다른 공급자를 몰래 추가하지 않는다.

### 서버·DB의 역할

로컬 모델·작업·계산 캐시는 기존 SQLite/로컬 파일에 둔다. 클라우드 DB에는 사용자→멤버십→프로젝트 목록, 현재 역할→게시본 접근, 게시본/객체 기준→의견, 초대→검증 사용자→멤버십을 저장·조회한다. 큰 형상/네이티브 파일은 객체 저장소에 두며 DB에 넣지 않는다. 이러한 관계형 조회 자체가 PostgreSQL을 요구하지 않는다.

[D1 제한](https://developers.cloudflare.com/d1/platform/limits/)은 유료 DB 하나당 10 GB이며 개별 DB는 질의를 직렬 처리한다. 동시 초대 수락·권한 회수·게시 확정의 원자성, 인덱스와 지연을 확인한다. DB 분할/이행을 선행 구현하지 않는다.

비용 비교 기록은 [RESEARCH-01 §10](../research/RESEARCH-01-reference.md), 공급자 선택은 ADR-015, 실제 무료 시험 제약은 PLAN §6.5를 따른다.

공유 실험 순서와 완료 기준은 [PLAN-02 §7](../plans/PLAN-02-agent-host-versioning.md)을 따른다.

### 로그인·프로젝트 공유 계약

동작 정본은 SPEC-04.8, 제품 약속은 PRD §12.5다. 첫 프로젝트 링크는 로그인 후 멤버십을 확인한다. 익명 공개 링크·범위·만료는 OQ-04의 별도 결정이며 자동 허용하지 않는다. 최소 테이블은 projects, project_members(project_id,user_id,role), invitations, publications, comments다. 역할은 owner/viewer/commenter이며 원격 CAD 실행 권한을 만들지 않는다. 메일 인증 모드는 검증된 수신 계정으로 초대를 수락한다. 무료 시험의 메일 없는 모드는 SPEC-04.8의 소유자 승인 절차를 따른다. 토큰은 해시 저장하며 만료·취소·중복 수락을 처리한다.

프로젝트/의견/파일 접근은 현재 멤버십을 API에서 확인한다. 오래된 JWT 역할/표시 이름을 권한 근거로 쓰지 않는다. 비공개 객체 저장소는 권한 검사 또는 짧은 만료 URL로 전달하고 회수 이후 새 발급/접근을 차단한다. 이미 발급한 URL의 만료 전 접근과 내려받은 파일까지 즉시 회수했다고 표시하지 않는다. Cloudflare는 R2 공개 접근을 열지 않고 인증된 전달 경로를 검증한다. 관리자 키는 프런트/게시 파일에 넣지 않는다.

게시 API는 manifest 생성→파일 업로드→해시 검증→게시 확정 순서이며 의견은 publicationId·objectId·기준 버전·공간 입력을 보존하고 cursor로 조회한다. 다른 버전 객체에 의견을 섞지 않는다. 두 사용자·두 프로젝트 교차 접근, 초대 만료/취소·탈퇴·직접 파일 URL·과거 게시본을 검수한다. 공개 웹으로 localhost 쿠키/CLI 자격 증명을 보내지 않는다. 계정 공유는 동시 CAD 편집·타인 PC 실행·오프라인 병합을 뜻하지 않는다. 선택한 제공자용 작은 저장/메일 어댑터만 만들고 범용 멀티클라우드 프레임워크는 만들지 않는다.

### 로컬 공유 구현의 물리 계약

로컬 파일 왕복 단계는 `publication_exports`에 공개 export ID·프로젝트/작업 ID·manifest/원 결과 해시를 저장한다. 웹의 소유자 전용 `GET /api/projects/:project/publications/:publication/comments/:comment/export`는 의견 하나와 공개 기준을 반환한다. 로컬 `POST /api/v1/projects/:project/shared-feedback`는 이 기준을 대조해 `shared_feedback`에 원문을 불변 보관한다. origin·웹 프로젝트·게시본·의견 ID를 중복 키로 사용하고 동일 ID의 변경된 원문을 거절한다. UI의 채택은 사용자 초안에 원본 첨부·선·대상을 복사하며 실행은 기존 명시적 요청을 따른다. 파일의 서버/작성자 표시는 온라인 검증으로 취급하지 않는다. 계정 인증 연결에 의한 자동 전송은 이 단계의 완료 주장에 포함하지 않는다.


2026-09-22 사용자 승인으로 무료 원격 시험은 `AUTH_MODE=manual-approval`을 사용한다. Better Auth의 `requireEmailVerification=false`, `autoSignIn=false`로 가입 후 로그인을 제공하며 `emailVerified`는 false로 남긴다. 메일 바인딩은 배포에서 제거하고 인증 API를 가입/로그인/세션/로그아웃으로 제한한다. `/api/config`가 화면에 현재 모드를 전달한다. 기본 모드는 기존 이메일 인증이며 환경 변수 한 번으로 기존 계정 이행까지 완료했다고 간주하지 않는다.

`0004-join-requests.sql`은 초대/계정당 하나의 참여 신청을 기록한다. `POST /api/invitations/accept`는 메일 없는 모드에서 멤버를 만들지 않고 202 pending을 반환한다. 소유자는 `GET /api/projects/:id/join-requests`와 `POST .../:requestId`의 approve/reject로 처리한다. 승인 D1 batch 안에서 소유권·미처리·만료·취소·대상 계정을 재확인한다. 현재 R2 계정 사용량이 무료 제공량보다 커 `UPLOADS_ENABLED=false`로 원격 게시 쓰기를 중지하고 화면에도 표시한다. 로컬 게시/권한 시험에는 적용하지 않는다. 업로드 재개는 사용자 비용 범위 확인 뒤 한다.

`src/sharing/`는 독립 Workers 패키지다. 인증 스키마는 Better Auth 1.7.5 생성 SQL, 제품 스키마는 `migrations/`의 순서 있는 SQL로 관리한다. 운영 배포 스크립트나 제품 HTTP 관리 경로로 자동 마이그레이션하지 않는다. 현재 시험은 로컬 전용 Wrangler 설정과 Miniflare의 D1/R2 바인딩을 사용한다.

- 프로젝트 API: 현재 D1 멤버십을 확인한다. 초대는 해시 저장·검증 이메일 수락이며 멤버 생성과 수락 상태를 한 batch로 처리한다. 옛 초대 재시도로 회수된 멤버십을 복원하지 않는다.
- 게시 준비: `POST /api/projects/:project/publications`의 requestId와 허용 필드 manifest를 고정한다. 같은 ID의 다른 내용은 충돌이다. 현재 게시 ID도 준비 시 저장한다.
- 파일 업로드: `/:publication/assets/:asset/:part`에 최대 8 MiB 청크를 전송한다. manifest의 크기/SHA-256을 검증하고 키를 덮어쓰지 않는다. 최초 구현 한도는 게시당 512 MiB·16자산·128청크·5,000 객체 ID이며 출시 성능 보증이 아니다. R2 객체는 공개하지 않고 매 다운로드에서 현재 멤버십과 게시본 접근을 확인한다.
- 게시 확정: 모든 청크를 확인한 뒤 D1 batch에서 게시 상태와 프로젝트의 현재 게시본을 함께 변경한다. 준비 이후 다른 게시가 완료됐으면 이전 기준의 확정을 거절한다. 이미 완료된 요청의 재시도는 현재 게시본을 되돌리지 않는다.
- 과거본: 현재 게시본 접근이 과거본 전체를 허용하지 않는다. 소유자가 특정 게시본의 history-access를 별도로 설정한다.
- 의견: 현재 구현은 공개 객체 ID 또는 게시본 전체에 대한 원문 문장이다. submissionId는 사용자/프로젝트 안에서 유일하고 본문·게시본 변경 재사용을 거절한다. 접수 시각과 작성자·게시본을 보존하며 cursor로 조회한다. 공간 핀/스케치, 로컬 수신/채택은 후속 구현이다.

R2 조건부 쓰기/체크섬은 [공식 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)를 따른다. manifest는 경로·임의 속성을 받지 않지만 바이너리 자산의 공개 범위 검증은 별도 로컬 allowlist 내보내기 책임이다. 기존 내부 검토본의 sourceDocument나 입력 자료 전체를 그대로 게시하지 않는다. 해당 내보내기와 화면을 연결하기 전에는 사용자 자료 업로드 완료로 집계하지 않는다. 현재 검증·미시험은 PLAN §6.5와 공유 VERIFY를 따른다.


### 계정 웹사이트와 작업 PC

[PLAN-09](../plans/PLAN-09-remote-host.md)·[PLAN-10](../plans/PLAN-10-account-workspace.md)의 물리 계약이다. 작업(대화·모델·AI 실행)은 언제나 작업 PC의 로컬 제어 서버가 하고, 계정 사이트(공유 Worker)는 계정·프로젝트 목록·PC 존재와 주소만 가진다.

- 계정: 아이디·비밀번호. Better Auth의 이메일 계정에 `<아이디>@users.vide.invalid`를 대응시킨다(`@`가 있는 입력은 기존 이메일 계정). `POST /api/account/sign-up {username,password,code}`는 `SIGNUP_CODE` 비밀값과 일치할 때만 계정을 만들고 `emailVerified=1`로 둔다. `POST /api/account/sign-in`은 Better Auth 로그인(속도 제한·쿠키)으로 전달한다. `/api/auth/sign-up/email` 직접 호출은 403이다. `GET /api/me`는 표시용 아이디를 준다.
- 프로젝트: `0006-accounts.sql`이 `projects`에 `updated_at`·`host_id`·`deleted_at`·`thumbnail`을, `remote_hosts`에 `local_url`을 더하고 페어링 표를 지운다. `GET /api/projects`는 최근 작업 순이다. `POST`(이름, 선택 `hostId`; PC가 하나면 그 PC), `PATCH /:id`(이름), `DELETE /:id`(사이트 목록에서는 `deleted_at`만 두고 공유 검토용 행은 남긴다. PC는 heartbeat의 `deleted:true`를 받아 아래 로컬 삭제를 한다), `GET /:id/thumbnail`. `POST /:id/open`은 프로젝트의 PC(없으면 켜진 PC를 지정)가 켜져 있을 때 `{hostId, local, remote}`를 준다. 각각 `<주소>/?project=<id>#r=<token>`이며 토큰은 `base64url({h,n,e})` + HMAC-SHA256(PC 키), 60초다.
- 작업 PC: `POST /api/hosts/device/login {username,password,name}`이 계정을 확인하고(확인용 세션은 즉시 삭제) PC 키를 한 번 발급한다. 이후 `Bearer hostId.secret`로 `device/heartbeat`(15초; `local`은 `http://127.0.0.1:<port>`만, `url`은 `https://*.trycloudflare.com`만, 프로젝트별 마지막 작업 시각)를 보내고 응답으로 그 PC의 프로젝트 목록을 받는다. `device/projects`(로컬 프로젝트 추가·이름, id 유지), `device/projects/:id/thumbnail`(160 KB 이하 data URL), `DELETE device/self`(로그아웃). 45초 안에 heartbeat가 있으면 켜짐, 터널 주소가 있으면 원격 가능이다.
- 로컬: `src/server/remote-access.ts`가 PC 키를 `<데이터>/remote-host.json`(0600, 비밀번호 미저장)에 두고 시작 시 heartbeat와(원격 접속이 켜져 있으면) `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>`를 재개한다. 터널 주소는 `Registered tunnel connection`과 실제 응답을 확인한 뒤 알린다. heartbeat 응답의 프로젝트는 같은 id로 로컬에 만들거나 이름을 맞춘다. `deleted:true`인 프로젝트는 `<데이터>/removed-projects.json`에 올려 목록에서 빼고, 로컬 행이 있으면 앱의 `DELETE /api/v1/projects/:id`와 같은 삭제(`removeProject`: `Store.deleteProject` + 데이터 폴더 안 파일)를 한다([SPEC-01.1](../specs/SPEC-01-project-input-sync.md)). `PROJECT_BUSY`면 다음 heartbeat에 다시 한다. 엔진 시작 때도 목록에 올라 있는데 행이 남은 프로젝트를 지운다. 삭제 뒤 빈 페이지가 파일의 25% 이상이고 4 MB를 넘으면 `VACUUM`한다. 로컬에서 만든·바꾼 프로젝트는 즉시 올린다. 기본 포트는 47821(사용 중이면 임의 포트)이고 로컬 세션 값은 `<데이터>/local-session.key`에 두어 재시작 뒤에도 열린 화면이 이어진다.
- 원격 접속 도구(2026-10-06 [ADR-039](../decisions/ADR-039-sign-in-first-run.md), [PLAN-38](../plans/PLAN-38-onboarding.md) T-177): `cloudflaredPath`는 `VIDE_CLOUDFLARED` → `<데이터>\bin\cloudflared.exe` → `%ProgramFiles%`·`%ProgramFiles(x86)%\cloudflared\cloudflared.exe` → PATH의 `cloudflared.exe` 순서로 찾는다. 없으면 `src/server/cloudflared.ts`가 공식 GitHub 릴리스의 고정 판(`2026.9.3`, `cloudflared-windows-amd64.exe`)을 `<데이터>\bin\cloudflared.exe.download`로 받아 SHA-256(`f096265e…ea7e2`, 릴리스 본문의 확인값과 이 PC의 2026-09-28 파일로 대조)을 확인한 뒤 이름을 바꾼다. 확인값이 다르면 지우고 `CLOUDFLARED_VERIFY_FAILED`, 받지 못하면 `CLOUDFLARED_DOWNLOAD_FAILED`다. 설치한 엔진(`main.ts`, `--dev` 아님)은 시작 5초 뒤 배경에서 한 번 받아 두고(`RemoteAccess.prefetch`, 이미 있으면 건너뜀, 실패는 기록만), 원격을 켤 때 없으면 `open()`이 받는다(받는 동안 상태 `starting`·`downloading`). 계정 연결(`link`)은 `remote:false`로 저장하고 터널을 열지 않는다. 원격을 끄면(`setRemote(false)`) `CLOUDFLARED_*`·`TUNNEL_*` 오류를 지우고, 화면은 원격이 꺼져 있으면 이 오류들을 보이지 않는다. 시험은 `RemoteAccess`의 `download` 주입으로 실제 내려받기를 대신한다.
- 첫 실행 게이트(2026-10-06 ADR-039, SPEC-05.6 「첫 실행」): `startServer({ signInRequired })`가 켜면 `GET /api/v1/onboarding` → `{ signInRequired, linked }`이고, 화면(`src/ui/first-run.tsx`)은 `signInRequired && !linked`이면 작업 화면 대신 로그인 화면(SCR-26)을 그린다. 로그인은 기존 `POST /api/v1/remote/link`, 프로젝트 만들기는 `POST /api/v1/projects`이며 고르면 `/?project=<id>`로 다시 연다. 게이트를 켜면 `connect()`는 프로젝트가 없을 때 만들지 않고 고르기 화면을 보인다. `main.ts`는 `--dev`가 아닐 때 게이트와 미리 받기를 켠다(`VIDE_SIGN_IN_REQUIRED=0|1`로 둘 다 덮어씀. 설치본을 띄우는 자동 시험은 0). `startServer`의 기본값은 끔이라 `npm run dev`·자동 시험은 이전처럼 연다.
- 같은 PC 판별: 사이트는 켜진 PC의 `local` 주소에 `GET /api/v1/hello`를 보낸다. 서버는 Origin이 연결된 사이트일 때만 CORS로 `{hostId}`를 답한다(사설망 사전 요청 허용). 일치하면 그 브라우저는 로컬 링크로, 아니면 원격 링크로 연다.
- 세션: `POST /api/v1/session {remoteToken}`은 로컬 요청이면 서명·만료(2분 이내)·nonce 재사용을 검사하고 로컬 세션 쿠키를, 터널 Host 요청이면 `vide_remote` 쿠키(HttpOnly·Secure·SameSite=Strict, 12시간, 터널 종료 시 폐기)를 준다. 두 경우 모두 응답 전에 heartbeat로 사이트의 새 프로젝트를 받는다. 원격 세션은 `/api/v1/shutdown`, `/api/v1/remote*` 쓰기, `/mcp`, `accounts`·`settings`·`extensions`의 쓰기를 쓰지 못한다. 교차 사이트 요청은 API가 아닌 GET 화면 이동만 허용한다.
- 연계 요청 좌표(2026-09-29): 입력 `coordinateBasis`는 `shared-metre-axes`(사용자가 같은 원점·축 확인) 또는 `align-by-features`(AI가 대응 요소로 이동·회전·축척·잔차를 먼저 구함)이다. 열린 문서의 표시 Sync(`displayOnly`, `connection = attached-editor`)도 연계 대상이다. Rhino 조회 행은 `layer`와 곡선의 `start`·`end`·`length`·`linear`·`closed`를 싣는다.
- ZWCAD 열린 도면 수정(2026-09-29): 연결 DLL(`hosts/zwcad/connection`)은 `queryEntities{offset,limit≤200,handles,layers,types}`(핸들·유형·레이어·색·범위와 유형별 값, 레이어별 개수)와 `runCode{code,write}`를 받는다. 코드는 작업 사본 worker의 `SdkCompiler`(같은 API 정책)로 컴파일한다. `write=false`는 잠금·트랜잭션 후 항상 Abort, `write=true`는 `SendStringToExecute("_VIDEAIRUN")`로 명령 안에서 실행·Commit하고 Entity의 추가·수정·삭제 핸들을 돌려준다. 서버(`ZwcadSdkExecution.runAttached`)는 표시 Sync 기준(`sourceDocument.connection = attached-editor`)이면 이 경로를 쓰고, 쓰기가 있으면 도면을 다시 읽어 결과로 둔다(`appliedDirectly`). 2026-09-30 ADR-022부터 자동 모드의 쓰기는 같은 명령 형식의 `direct-execute`로 하고 실행마다 되돌리기 기록을 남긴다(§4 「바로 적용 경로」). 연결 프로그램의 ZWCAD 설치는 DLL과 컴파일러 어셈블리를 `<데이터>\plugins\zwcad\<버전>-<해시8>\`에 복사하고 `HKCU\Software\ZWSOFT\ZWCAD\2023\<언어>\Applications\VIDE`(`LOADER`, `LOADCTRLS=2`, `MANAGED=1`)를 쓴다. 시작 시 `VIDE CAD` 패널을 한 번 연다.
- 사이트 중계(2026-09-29): 다른 기기의 열기 링크는 터널 주소가 아니라 `<사이트>/pc/<hostId>/?project=<id>#r=<token>`이다. Worker(`src/sharing/pc-proxy.ts`)는 로그인한 소유자의 PC가 켜져 있고 터널 주소가 있을 때 요청을 그 터널로 흘려보낸다. 사이트 쿠키·Referer는 빼고, 사이트 Origin만 받아 PC의 Origin(터널)으로 바꾸고, PC 세션 쿠키는 `vide_remote_<hostId 16진>`(Path=`/pc/<hostId>/`)으로 저장했다가 PC에는 `vide_remote`로 넘긴다. PC 응답의 보안 정책(CSP)은 그대로 둔다. PC가 꺼졌거나 원격이 꺼졌으면 503(`HOST_OFFLINE`·`HOST_REMOTE_OFF`, 화면 이동이면 안내 페이지), 터널 무응답은 502 `HOST_UNREACHABLE`이다. 작업 화면은 상대 주소(`api/v1/…`, Vite `base: './'`)만 써서 PC 루트와 `/pc/<id>/` 양쪽에서 같다. 터널이 다시 시작돼도 같은 주소로 다시 열린다. 사이트는 PWA 설정(`manifest.webmanifest`, 아이콘, iOS 메타)을 제공해 아이패드 홈 화면에 앱으로 추가할 수 있다. 모든 작업 요청이 Worker를 거치므로 Workers 요청 수(무료 10만/일)를 쓴다.
- 버전: heartbeat 상태에 PC 프로그램 버전을 싣는다. `MIN_APP_VERSION`(선택)보다 낮은 PC는 목록에 "업데이트 필요"로 보이고 열기는 409 `HOST_UPDATE_REQUIRED`다. 비교는 점 구분 숫자이며 사이트↔PC 계약은 하위 호환으로만 바꾼다.
- 저장된 모델·요청 대기(2026-09-29, [PLAN-20](../plans/PLAN-20-offline-view.md)): `0007-offline-view.sql`이 `project_snapshots(project_id, link_id, user_id, name, host, size, object_count, captured_at, updated_at)`와 `queued_requests(id, project_id, user_id, host_id, link_id, body, created_at, delivered_at, canceled_at)`를 만든다. PC는 `PUT device/projects/:id/snapshots/:linkId?name&host&objects&captured`(본문은 gzip된 `vide-snapshot-v1`, `Content-Length` 필수, 95 MB 이하: 사이트의 요청 100 MB 한도 아래)로 R2 `snapshots/<project>/<link>`를 덮어쓰고 `DELETE` 같은 경로로 지운다. 한도는 계정 `SNAPSHOT_QUOTA_MB`(기본 500)·사이트 전체 `SNAPSHOT_TOTAL_MB`(기본 8000, R2 무료 10 GB 안)이며 넘으면 507 `SNAPSHOT_QUOTA`·`SNAPSHOT_SITE_FULL`, `SNAPSHOTS_ENABLED=false`면 503이다. heartbeat 응답의 `queue[]`(미전달·미취소 50개까지)를 받은 PC는 보관한 id를 `POST device/queue/delivered {ids}`로 알린다. 브라우저(소유자만): `GET /api/projects/:id/snapshots`, `GET …/snapshots/:linkId`(바이트, `no-store`), `GET|POST /api/projects/:id/queue`(본문 4000자, 미전달 20개까지, 넘으면 429 `QUEUE_FULL`), `DELETE …/queue/:id`(전달 전만, 이후 409). 형식(`src/contracts/offline-snapshot.ts`): `VSN1` + u32 머리 길이 + JSON 머리 + 4바이트 정렬 버퍼. 레이어×종류(mesh·lines·points) 묶음마다 원점 기준 float32 좌표, 정점별 uint8 RGB, uint32 색인이고 문자는 20,000개(각 200자)까지다. PC(`src/server/offline-view.ts`)는 `<데이터>/offline-view.json`에 프로젝트별 켜짐, 파일별 올린 Sync id·시각·크기·오류, 받은 요청(200개)을 둔다. heartbeat 뒤 켜진 프로젝트의 보이는 연결 파일마다 마지막 성공 Sync가 바뀌었으면 파일당 10분에 한 번까지 올린다. 로컬 API: `GET|PUT /api/v1/projects/:id/offline-view {enabled}`, `POST …/offline-view/inbox/:id/dismiss`. 사이트 화면은 `DecompressionStream('gzip')`으로 풀어 묶음마다 한 번 그린다.
- PC 없이 프로젝트 열기(2026-10-06, [PLAN-33](../plans/PLAN-33-offline-project.md), [ADR-035](../decisions/ADR-035-offline-project-summary.md)): `0009-offline-project.sql`이 `project_agenda(project_id, item_id, text, date, time, kind, done_at, ord, revision, updated_at)`(PC 할 일의 사본; `0013-agenda-fields.sql`이 `end_date`·`end_time`·`location`·`attendees`를 더함, PLAN-39), `project_summaries(project_id, agenda_revision, agenda_at, history_at)`, `agenda_edits(id, project_id, user_id, item_id, op∈add·set·remove, fields JSON, base_revision, edited_at, applied_at, outcome)`(사이트 변경 대기열), `project_history(project_id, request_id, ord, body, answer, state, files JSON, created_at)`를 만든다(노트 표는 PLAN-32의 `0008`). PC: `PUT device/projects/:id/agenda {items}`(500개, 글 500자, 통째 교체)·`PUT …/history {items}`(100개, `id·body(600)·answer(400)·state·createdAt·files(10)`만 저장, 다른 필드는 버림)·`DELETE …/summary`(사본·요약 삭제), heartbeat 응답의 `agendaEdits[]`(미적용 100개, `{id, projectId, itemId, op, fields, baseRevision, editedAt}`)를 적용한 뒤 `POST device/agenda-edits/applied {items:[{id, editedAt, outcome}]}`(`edited_at`이 같을 때만 적용 표시: 그 사이 사이트에서 바뀐 변경은 다시 온다). 할 일 항목은 `endDate·endTime·location·attendees`를 함께 올리고(없으면 null), 사이트는 모르는 `kind`를 거절하지 않고 `task`로 저장한다(종류 하나로 목록 전체가 400이 되지 않게). PC의 heartbeat 해석(`agendaEditSchema`)도 모르는 `kind`는 그 필드만 버리고 변경은 받는다. 브라우저(소유자만, 참여자 403): `GET /api/projects/:id/agenda`(PC 사본 위에 대기 변경을 겹친 `items[{id,text,date,time,endDate,endTime,kind,location,attendees,done,order,revision,pending}]`, `sharedAt`, `pending`; 날짜를 바꾼 대기 변경은 기간을 지켜 `endDate`도 옮겨 보인다), `POST …/agenda {text,date?,time?,kind?}`(항목 id `site-<uuid>`), `PATCH …/agenda/:item {text?,date?,time?,kind?,done?,revision?}`, `DELETE …/agenda/:item`, `GET …/history`. 항목마다 대기 변경은 하나로 합치고(대기 중인 추가를 지우면 대기열에서 빠짐), 미적용 200개를 넘으면 429 `AGENDA_EDITS_FULL`, PC가 올린 적 없으면 쓰기는 409 `AGENDA_NOT_SHARED`. 로컬(`src/server/offline-view.ts`·`offline-summary.ts`): `offline-view.json`에 프로젝트별 `summary`(기본 켜짐), 올린 지문(할 일: 개수·최근 변경·revision 합·순서 합, 이력: 최근 50개 id·상태)·시각·오류, 적용한 사이트 변경(id → 버전·결과·추가가 만든 항목, 500개)을 둔다. heartbeat 뒤 모든 프로젝트를 지문으로 비교해 바뀐 것만 올리고(이력은 1분에 한 번까지, 실패는 1분 뒤 다시) 스냅샷 스위치와 무관하다. 사이트 변경은 같은 revision이면 적용, 아니면 나중 쓰기(사이트 `editedAt` 대 항목 `updatedAt`)가 이기고 항목 글 끝에 `[사이트 수정 충돌 …]`을 붙인다. 적용한 할 일을 먼저 올린 뒤 결과를 알린다. 로컬 API: `PUT /api/v1/projects/:id/offline-view {enabled?, summary?}`. 사이트 중계(`pc-proxy.ts`)의 PC 꺼짐 안내는 `?project=`가 있으면 `/?offline=<id>` 링크를 둔다(페이지 열기 판별에 `Accept: text/html`도 받음, Sec-Fetch-Mode 없는 Safari).

### 공유 노트(ADR-034, SPEC-10, PLAN-32)

노트·협의 사항·일지의 원본은 사이트, 실시간 본문은 노트마다 Durable Object 하나의 Yjs 문서다. 공통 코드: `src/contracts/note-doc.ts`(종류, Yjs XML 조각 `default` → Markdown `noteMarkdown`, 문단 붙이기 `appendParagraphs`, 체크 항목 `actionItems`, 일지 제목), `src/contracts/note-sync.ts`(y-websocket 메시지: `0` 동기화 step1·step2·update, `1` awareness; base64), `src/contracts/note-socket.ts`(브라우저·엔진 공통 클라이언트 `NoteSocket`: 시도마다 새 표 주소, 열면 step1과 자기 awareness, 받은 step2로 `synced`, 0.5→30초 재연결, 닫힘 코드 4403·4404는 재시도 안 함, `idle` = synced·열림·보낼 것 없음).

- **D1** `0008-notes.sql`: `notes(id, project_id → projects ON DELETE CASCADE, title, kind CHECK note|discussion|journal, journal_date, snapshot TEXT(Markdown, 400,000자에서 자름), created_by, created_at, updated_at, updated_by, revision, deleted_at)`, 색인 `(project_id, updated_at)`, 부분 유일 색인 `(project_id, journal_date) WHERE kind='journal' AND deleted_at IS NULL`(하루 하나; 만들기는 `INSERT … ON CONFLICT DO NOTHING` 뒤 다시 읽기).
- **API**(`src/sharing/notes.ts`; 브라우저 `/api/projects/:id/notes…`는 로그인·Origin 확인, PC `/api/hosts/device/projects/:id/notes…`는 PC 키로 그 계정이 사용자): 모든 경로가 먼저 `project_members` 구성원(역할 무관)을 확인하고 아니면 404 `PROJECT_NOT_FOUND`. `GET ?q&kind&since&full=1`(`since`면 지운 행 포함, `full=1`이면 `snapshot`, 아니면 `excerpt` 160자, 1,000개까지) · `POST {title?, kind: note|discussion}` · `POST journal {date}` · `POST journal/append {date, text≤4000}` · `GET|PATCH|DELETE :noteId`(PATCH `{title?, kind?}`, 일지의 종류는 그대로; DELETE는 만든 사람·소유자, 아니면 403 `NOTE_OWNER_REQUIRED`, `deleted_at`만) · `POST :noteId/ticket` → `{ticket, url: '/api/notes/socket?t=…'}` · `POST :noteId/append {text}`. 표는 `base64url({u,p,n,e})` + `HMAC-SHA256(AUTH_SECRET, 'note:'+payload)`, 60초.
- **소켓** `GET /api/notes/socket?t=`(쿠키·Origin 검사 전에 처리): 표 검증(실패 401 `TICKET_INVALID`) → 구성원·노트 다시 확인 → `NOTES.idFromName('<project>:<note>')`의 `/socket`으로 `X-Note-Project`·`X-Note-Id`·`X-Note-User`와 함께 넘긴다. Worker는 101 응답을 복사하지 않고 그대로 돌려준다(CSP `connect-src`에 사이트의 `ws(s)://` 주소 추가).
- **Durable Object** `NoteRoom`(`src/sharing/note-room.ts`, SQLite 저장): 생성 때 `updates(id, data BLOB)`·`meta(project, note)`를 읽어 문서를 만든다. 조각이 비어 있으면(새 노트) 빈 문단 하나를 서버가 만든다(빈 문서에 붙은 편집기마다 제 빈 문단을 만들어 겹치는 것을 막음). 소켓은 `acceptWebSocket`(Hibernation)으로 받고 첨부에 사용자 id를 두며, 붙자마자 서버 step1을 보낸다. 받은 동기화 메시지는 `readMessage`로 적용하고(답이 있으면 그 소켓에), 문서 갱신은 보낸 소켓 밖의 모든 소켓에 update로 보낸 뒤 메모리에 모은다. 알람이 1초 뒤 모은 갱신을 `mergeUpdates` 한 행으로 쓰고(100행이 넘으면 `encodeStateAsUpdate` 한 행으로 압축), D1 `snapshot`·`updated_at`·`updated_by`·`revision+1`을 최대 5초에 한 번, 마지막 소켓이 나갈 때 바로 쓴다. awareness 메시지는 다른 소켓에 그대로 중계하고 저장하지 않는다. 4 MB를 넘는 메시지는 1009로 닫는다. 내부 경로 `/append {text, user}`(문단 붙이고 바로 저장·D1), `/flush`, `/markdown`.
- **배포 설정**: `wrangler*.jsonc`의 `durable_objects.bindings: [{name: NOTES, class_name: NoteRoom}]`, `migrations: [{tag: v1-notes, new_sqlite_classes: [NoteRoom]}]`, Worker는 `export { NoteRoom }`. 바인딩이 없으면 노트 경로는 503 `NOTES_NOT_CONFIGURED`.
- **PC 엔진**(`src/server/shared-notes.ts`, 경로 `src/server/notes-routes.ts`): `RemoteAccess.deviceFetch`(PC 키)로 사이트를 부른다. 로컬 API: `GET|POST /api/v1/projects/:id/notes`(목록에 `online`·`error`·`user`), `POST …/notes/journal {date?}`, `POST …/notes/journal/append {text, date?}` → `{state: sent|queued|unlinked, noteId?}`, `POST …/notes/agenda-from-text {text}`, `PUT …/notes/:noteId`, `POST …/notes/:noteId/remove|to-agenda`, `GET …/notes/:noteId/stream?client=`(SSE: `sync{state, vector}`·`update`·`awareness`·`status{connected, synced, pending}`, 20초마다 주석 줄), `POST …/notes/:noteId/updates {client, update?, awareness?}`(base64). 원격 세션도 쓴다. 연 노트는 복제본(Yjs 문서 + awareness, 엔진 자신의 상태는 없음)과 사이트 `NoteSocket`(전역 WebSocket, `ws(s)://<사이트>` + 표 주소)을 갖고, 화면에서 온 갱신(`screen:<client>`)은 다른 화면과 사이트로, 사이트 갱신은 화면으로 보낸다. 한 화면이 보낸 awareness id는 그 화면에 되돌려 보내지 않고, 화면이 떠나면 그 id를 지운다. 같은 노트의 동시 열기는 복제본 하나를 함께 쓴다(여는 중 약속 공유), 사이트 소켓은 표를 받는 동안 두 번째 연결을 만들지 않는다. 화면이 모두 떠나면 30초 뒤 닫는다.
- **PC 파일**(`<데이터>/projects/<id>/notes/`, 프로젝트 기록 폴더 안): `<noteId>.md`·`journal-YYYY-MM-DD.md`(머리 `# 제목`(빈 제목은 '제목 없음', 일지는 날짜 제목)과 구분('노트'·'일지')·id·날짜·마지막 수정·"원본은 계정 사이트" 주석, 본문 Markdown), `README.md`(제목·구분·파일·마지막 수정 표), `index.json`(오프라인 목록), `.yjs/<noteId>.bin`(복제본 상태, 0.4초 묶음으로 저장), `.yjs/<noteId>.pending`(사이트가 아직 받지 못한 편집; 소켓이 `idle`이 되면 지움), `.yjs/journal-queue.json`(보내지 못한 일지 줄, 200개). 목록 읽기(화면 15초, 엔진 heartbeat 뒤 10분마다 모든 프로젝트)가 사본을 다시 쓰고 지워진 노트의 `.md`와 `.yjs/<noteId>.bin`(`.pending`이 남았거나 지금 열린 복제본은 남김)을 지우며, `.pending` 노트를 열어 보내고 일지 대기를 보낸다. 열린 복제본의 `.md`는 목록이 덮지 않는다. 쓰기는 `.tmp` 뒤 이름 바꾸기.
- **퇴근하기·PC 없이 보기**: `agendaRoutes`의 `dayEnded` 훅(server.ts)이 `day-end` 응답 뒤 `appendJournal`을 기다리지 않고 부른다. 사이트 `offline.tsx`의 `OfflineNotes`가 `GET /api/projects/:id/notes`로 최근 6개와 [노트·일지 열기]를 보인다.
- **AI**: 턴 지시(`workFolderRule`)가 기록 폴더의 `notes/`와 README·일지 파일 이름을 알린다. 읽기는 기록 폴더 규칙 그대로(묻지 않고 읽기, 쓰기 거절).
- **화면**: 공통 `src/ui/notes/notes-workspace.tsx`(목록·열린 노트, `NotesBackend` 주입)·`note-editor.tsx`(TipTap 3: StarterKit(undoRedo 끔)·TaskList·TaskItem(중첩)·Placeholder·Collaboration(`field: default`)·CollaborationCaret(awareness `user {name, color}`, 편집 불가 caret, CSSOM 색); 편집기와 확장은 문서마다 한 번 만들고(`memo`), 첫 동기화 뒤(오프라인이면 2초 뒤) 만든다; StarterKit의 `trailingNode`·`undoRedo`는 끔; CSP가 인라인 style을 막으므로 `injectCSS: false`와 기본 규칙을 `notes.css`에 둠)·`notes.css`. 작업 화면의 단축키는 편집 가능한 글(`isContentEditable`)에서 쓰지 않는다(`src/ui/app/shortcuts.ts` `isTyping`). 사이트 `src/sharing/web/notes.tsx`(`?notes=<project>&note=<id>`, 지연 로드 청크)는 `NoteSocket`, VIDE `src/ui/notes-tab.tsx`(고정 화면 `notes`, 레일 `#rail-notes`)는 엔진 SSE + POST(입력 40ms 묶음, 다시 붙으면 `vector` 기준으로 빠진 갱신을 보냄)를 쓴다.
- **의존성**: 루트 `yjs` 13.6.33, `y-protocols` 1.0.7, `lib0` 0.2.119, `@tiptap/core`·`react`·`pm`·`starter-kit`·`extension-collaboration`·`extension-collaboration-caret`·`extension-list` 3.31.4, `@tiptap/y-tiptap` 3.0.9. Worker 묶음도 루트의 `yjs`를 쓴다(한 벌만 두어 Yjs 이중 적재를 피함).

### 데이터 위치(ADR-037)

[ADR-037](../decisions/ADR-037-team-shared-project-layer.md)의 원칙: 팀이 함께 보는 가벼운 것(글·목록·설정)은 사이트, 무거운 것(모델 형상·첨부·원본 파일)과 PC별 키·설정은 PC다. 이 표가 저장 위치 전체의 정본이며 다른 절은 물리 형식만 적는다. `<데이터>`는 설치본 `%LOCALAPPDATA%\VIDE`, 개발 서버 `.vide/dev-data`다.

| 위치 | 무엇 | 원본·사본 | 정본 절 |
|---|---|---|---|
| PC `<데이터>/app.sqlite` | 프로젝트 목록(이 PC)·연결 파일 기록·AI 설정·확장·계정 사용량 등 프로젝트 밖 기록 | 원본(이 PC의 프로젝트). 사이트 목록과는 id로 맞춤 | §5 「프로젝트별 DB」 |
| PC `<데이터>/projects/<id>/project.sqlite` | 요청·결과·Sync 표시 형상·대화·jig·검토본·할 일·자료 검토(`knowledge_reviews`·`knowledge_source_rules`) | 요청·형상·대화는 원본. 자료 검토·규칙은 로그인한 PC에서 사이트의 사본 | §5, ARCH-03 §10.2 |
| PC `<데이터>/projects/<id>/knowledge.sqlite` | 정리된 자료 DB(진술·발췌·출처 경로·이슈·현황 요약) | 수집한 PC는 원본(크롤러 결과), 다른 PC는 사이트에서 받은 사본(`meta.vide_copy`) | 「팀 공유 프로젝트 층」 |
| PC `<데이터>/projects/<id>/notes/` | 공유 노트의 Markdown·Yjs 복제본·보내지 못한 편집 | 사본(원본은 사이트) | 「공유 노트」 |
| PC `<데이터>/projects/<id>/history/` | 다른 구성원의 공유 대화 기록(대화마다 Markdown, README, `.data/mirror.json`) | 사본(원본은 그 대화를 돌린 PC, 사이트를 거침) | 「대화 기록 공유」 |
| PC `<데이터>/ai-instructions/<id>.json` | 프로젝트 AI 지시 | 사본(원본은 사이트; 로그인 전에는 이 PC가 원본) | 「팀 공유 프로젝트 층」 |
| PC `<데이터>/shared-layer/` | 공유받은 프로젝트 목록 사본(`projects.json`), 프로젝트별 자료 묶음 판·검토 보낼 상자(`<id>.json`) | 사본·대기열 | 「팀 공유 프로젝트 층」 |
| PC `<데이터>/models/`·`cad-models/`·`sdk-models/`·`zwcad-sdk-models/` | 작업 사본·가져오기 사본·호스트 실행본 | 원본(사이트에 올리지 않음) | §4 |
| PC `<데이터>/attachments/`·`reference-boards/`·`outputs/`·`structure/` | 첨부·참고 이미지 보드·산출물·구조 jig 설정 | 원본(올리지 않음) | §3, SPEC-09 |
| PC 사용자 폴더 | 프로젝트 폴더·원본 도면·자료 원본 | 사용자 원본. VIDE는 경로만 기록 | SPEC-01.13, SPEC-08.4 |
| PC 설정·키 | `remote-host.json`(PC 호스트 키), `local-session.key`, `typesafe.env`(Jev 키), `*-settings.json`(질문·웹·경로·사용량), `cli-profiles/`, `desktop.json`, `offline-view.json`, `conversation-mirror.json`(올린 대화 기록 지문), `removed-projects.json`, `launch.json` | PC 전용(올리지 않음) | 「PC 프로그램」 |
| PC 기록 | `logs/`(진단 기록), `crashdumps/`, 오류·성능 보고 보낼 상자 | PC 전용. 보고는 동의한 요약만 사이트로(ADR-036) | 「진단 기록」·「오류·성능 보고」 |
| PC 창·도구 | `webview/`·`webview-zwcad/`(WebView2 저장소), `plugins/`, `bin/`, `tools/` | PC 전용 | 「PC 프로그램」 |
| 사이트 D1 계정 | `user`·`session`·`account`·`verification`·`rateLimit`(0001), 아이디 계정(0006) | 원본 | 「로그인·프로젝트 공유 계약」 |
| 사이트 D1 프로젝트 | `projects`(이름·소유자·돌리는 PC·미리보기 그림)·`project_members`·`invitations`(0002)·`join_requests`(0004) | 원본(목록·멤버, ADR-037 1) | 「팀 공유 프로젝트 층」 |
| 사이트 D1 게시·의견 | `publications`·`comments`(0003) | 원본 | SPEC-04 |
| 사이트 D1 PC | `remote_hosts`(PC 이름·키·주소·상태)·`remote_host_pairings`(0005) | 원본 | 「계정 웹사이트와 작업 PC」 |
| 사이트 D1 PC 없이 보기 | `project_snapshots`(저장본 정보)·`queued_requests`(0007), `project_agenda`·`agenda_edits`·`project_history`(이력 요약)·`project_summaries`(0009) | 할 일·이력 요약은 PC 원본의 사본, 사이트 변경 대기열은 원본 | SPEC-04.9·04.10 |
| 사이트 D1 노트 | `notes`(Markdown 사본, 0008) | 사본(본문 정본은 DO) | 「공유 노트」 |
| 사이트 D1 팀 공유 층 | `project_instructions`·`knowledge_sets`·`knowledge_rows`·`knowledge_reviews`·`knowledge_rules`(0011) | 지시·검토·규칙은 원본, 자료 묶음은 수집 PC가 올린 원본 | 「팀 공유 프로젝트 층」 |
| 사이트 D1 대화 사본 | `shared_conversations`·`shared_requests`·`shared_request_chunks`(0012): 호스트 문서 없는 요청의 요청 글·답 전문·활동 줄·실행 코드·파일 이름과 대화 제목·종류·모델 이름. 모델링 요청은 올리지 않음 | 그 작업을 돌린 PC 원본의 사본(PC는 자기 행만 바꾸고 지움) | 「대화 기록 공유」, SPEC-04.12 |
| 사이트 D1 보고 | `telemetry_reports`·`telemetry_limits`·`telemetry_bundles`(0010) | 원본(동의한 요약) | 「오류·성능 보고」 |
| 사이트 R2 | 게시본 파일, PC 없이 보기 저장본(`snapshots/<project>/<link>`, 상한 5 GB), 진단 묶음(스위치) | 게시본은 원본, 저장본은 PC Sync의 보기 전용 사본 | SPEC-04, PLAN-20, ADR-036 |
| 사이트 Durable Object | `NoteRoom`의 Yjs 갱신(노트 본문) | 원본 | 「공유 노트」 |
| Cloudflare 터널 | 원격 세션의 요청·응답이 지나감(저장 안 함) | — | 「계정 웹사이트와 작업 PC」 |
| 외부 AI(Anthropic·OpenAI, 사용자 구독 CLI) | 요청 글, 첨부·참고 이미지, 프로젝트 AI 지시, 모델 문맥·도구 결과, 자료 도구가 돌려준 진술 | 공급자 정책에 따름(VIDE가 지우지 못함) | §2, FR-18 |
| 외부 Jev(Typesafe) | 경로 판정·이전 대화 선별을 위한 요청 글과 이전 요청 제목 | 공급자 정책에 따름 | 「PC 프로그램」 |

### 팀 공유 프로젝트 층(ADR-037, SPEC-04.11, PLAN-35)

- **D1** `0011-shared-project-layer.sql`: `project_instructions(project_id PK → projects ON DELETE CASCADE, text, revision, edited_at, updated_at, updated_by)` · `knowledge_sets(project_id PK, revision, pending_revision, built_at, counts JSON, host_id, updated_at, updated_by)` · `knowledge_rows(project_id, revision, tbl, row_key, body JSON, PK(project_id, revision, tbl, row_key))` · `knowledge_reviews(project_id, statement_id, verdict(NULL = 지움), correction, superseded_by, reason, by_name, edited_at, updated_at, updated_by, PK(project_id, statement_id))` · `knowledge_rules(project_id, pattern, reason, removed 0|1, edited_at, updated_at, updated_by, PK(project_id, pattern))`, 바뀐 순 색인 `(project_id, updated_at)`.
- **API**(`src/sharing/shared-layer.ts`; 브라우저 `/api/projects/:id/(instructions|knowledge…)`, PC `/api/hosts/device/projects/:id/(instructions|knowledge…)`): 모든 경로가 구성원(역할 무관)을 확인하고 아니면 404 `PROJECT_NOT_FOUND`.
  - `GET instructions` → `{text, revision, updatedAt, updatedByName}`(없으면 `revision 0`). `PUT instructions {text ≤ 8 KB, baseRevision, editedAt?}` → 행이 없거나 `baseRevision = revision`이면 적용, 아니면 `editedAt ≥ edited_at`일 때만 적용(나중 쓰기). 응답 `{applied, text, revision, updatedAt, updatedByName, conflict?: {text, revision, updatedAt, updatedByName}}`. 적용됐으면 `conflict`는 덮인 글, 거절됐으면 응답 본문이 남은 글이다.
  - `GET knowledge` → `{revision, builtAt, counts, updatedAt, changedAt}`(`changedAt` = 검토·규칙의 마지막 `updated_at`). `GET knowledge/rows?table=&after=&limit≤500` → 확정된 `revision`의 행(`row_key` 순)과 `next`. `GET knowledge/reviews?since=` → `{reviews, rules, at}`. `POST knowledge/reviews {reviews:[{statementId, verdict|null, correction, supersededBy, reason, by, editedAt}], rules:[{pattern, reason, removed, editedAt}], since}` → 각 행은 `editedAt`이 더 나중일 때만 덮고, `since` 뒤 바뀐 행을 돌려준다.
  - PC 전용(브라우저는 403 `DEVICE_ONLY`): `POST knowledge/begin {builtAt}` → `{revision}`(`pending_revision = revision + 1`, 남은 미완료 행 지움) · `PUT knowledge/rows {revision, table, rows ≤ 200}`(본문 2 MB) · `POST knowledge/commit {revision, counts}` → `revision` 확정, 이전 판 행 지움. 표·열은 `src/contracts/knowledge-pack.ts`의 `KNOWLEDGE_TABLES`(meta·source·excerpt·statement·party_alias·issue·statement_issue·brief)만 받는다.
  - PC 목록 `GET /api/hosts/device/projects` → `{projects:[{id, name, role, ownerName, hostId, hostName, hostOnline, here, updatedAt, instructionsRevision, knowledgeRevision, knowledgeChangedAt}]}`(구성원인 지우지 않은 프로젝트 500개). 구성원 보기 `GET /api/hosts/device/projects/:id/member/(agenda|history|snapshots)`는 PC 계정을 구성원으로 SPEC-04.10의 같은 응답을 준다.
- **PC 엔진**(`src/server/shared-project.ts` `SharedProjects`, `RemoteAccess.deviceFetch`): heartbeat 뒤 2분마다 목록을 받고(`<데이터>/shared-layer/projects.json`), 이 PC 프로젝트마다 판이 달라진 지시를 받고 보낼 지시를 보내며, 자료 묶음과 검토를 맞춘다. 로컬 API: `GET /api/v1/shared-projects` → `{linked, online, error?, projects}`(이 PC에 있는 프로젝트 제외), `GET /api/v1/shared-projects/:id` → `{project, online, agenda, history, notes, snapshots, knowledge, instructions, site}`, `GET|PUT /api/v1/shared-projects/:id/instructions`. `GET|PUT /api/v1/projects/:id/ai-instructions` 응답에 `{revision, pending, shared: unlinked|synced|pending, updatedByName, conflict}`가 붙고 `POST …/ai-instructions/conflict`가 충돌 안내를 지운다(원격 세션은 쓰기 불가).
- **지시 사본**(`ProjectInstructionStore`): 파일 `{text, updatedAt, revision?, pending?, editedAt?, updatedByName?, conflict?}`. 로컬 저장은 `pending`; 보낼 때 `baseRevision`·`editedAt`; 받은 판이 더 크고 `pending`이 아니면 덮음. 턴은 `text()`로 사본을 그대로 읽는다.
- **자료 묶음**: 수집 PC 판단 = 자료 DB가 있고 `meta.vide_copy`가 없음. 지문 = 파일 크기·수정 시각(`-wal` 포함). 다르면 begin → 표마다 200행씩(발췌는 진술이 가리키는 것만, 글 20,000자; 출처는 그 발췌의 것만) → commit(`counts {files, mails, excerpts}`). 다른 PC는 사이트 `revision`이 사본의 `meta.vide_copy`와 다르면 표를 모두 받아 `knowledge.sqlite.copy`에 같은 열의 표·`excerpt_fts`(trigram)·`run(started = builtAt)`·`meta.vide_counts`를 만들고 이름을 바꿔 덮는다. `knowledgeSummary`는 `meta.vide_counts`가 있으면 그 수를 쓴다. 이 PC에 프로젝트가 있을 때만 받는다.
- **검토·규칙**: `facts-routes.ts`의 기록 뒤 `onReviewChange`가 `<데이터>/shared-layer/<id>.json`의 보낼 상자에 쌓고, 맞출 때 보낸 뒤 받은 행을 `KnowledgeReviewStore`에 적고(보낼 상자에 남은 것은 다시 적용) `since`를 둔다.
- **화면**: `src/ui/project-heading.tsx`의 `<optgroup label="공유받은 프로젝트">`. `?project=<id>`가 공유받은 프로젝트면 `src/ui/gateway.ts` `connect()`가 `remote`를 돌려주고 `src/ui/app/boot.ts`가 작업 화면 대신 `src/ui/remote-project.tsx`를 띄운다. 사이트 `offline.tsx`의 PC 없이 보기 화면에 AI 지시 칸.
### 대화 기록 공유(ADR-037 4, SPEC-04.12, PLAN-36)

요청·답·대화의 원본은 그 작업을 돌린 PC(프로젝트별 DB의 `workspace_requests`·`conversations`, ADR-032)이고 사이트는 글 사본이다. 호스트 문서를 읽거나 고치지 않은 요청만 올린다(2026-10-06 사용자 조정, 2026-10-07 T-190부터 결과로 판정). 공통 코드: `src/contracts/conversation-mirror.ts`(올릴지 판정 `shareableRequest`, 요청 문서 `mirrorDocSchema` = `{body, answer, activity[{at,kind,text,detail?}], executions[{label,state,at,file,language,code}], files[]}`, 나누기 `chunkText`(100,000자, 서로게이트 쌍은 나누지 않음), AI용 Markdown `mirrorMarkdown`). 판정: 입력의 `source`가 document·file이 아니며 `provider`가 extension이 아니고 `jig`·`sourceDocument`·`linkId`·`baseRequestId`·`linkedTargets`·`parentRequestId`가 없고 `applyToSource`가 아니며 `pins`·`sketches`가 비었고, 결과가 호스트를 쓰지 않았을 때(`usedHost`가 거짓: `executions`·`documents`가 비고 `hostExecuted`·`appliedDirectly`·`multiFile`·`rollback`이 없으며 `progress.queries`·`progress.attempts`가 0)만. 결과의 `sourceDocument`·`baseRequestId`(시작 때 붙은 대상)는 판정에 쓰지 않는다. `input.hostUse==='none'`이 아닌 요청은 끝난 상태(succeeded·failed·cancelled·interrupted)에서만 판정한다. 직접 실행(`direct-mode.ts`)은 조회·화면 보기·치수 재기·Grasshopper 사용을 모두 `progress.queries`에 세고, 읽기만 하고 실패한 요청도 `progress`를 남긴다.

- **D1** `0012-shared-conversations.sql`: `shared_conversations(project_id → projects ON DELETE CASCADE, origin_host, id, origin_user, title, kind, provider, model, created_at, updated_at, stored_at; PK(project_id, origin_host, id))`(기본 대화는 id `default`), `shared_requests(project_id → projects, id, origin_host, origin_user, conversation_id, state, created_at, ended_at, files JSON, preview(요청 글 300자), revision, chunks, size, stored_at; PK(project_id, id))`, 색인 `(project_id, origin_host, conversation_id, created_at)`·`(project_id, stored_at)`, `shared_request_chunks(project_id, request_id, seq, text; PK 셋)`. 요청 문서(JSON 글)를 조각으로 나눠 두고 읽을 때 이어 붙인다(D1 행 2 MB 아래, 자르지 않음). `0011`은 PLAN-35(ADR-037 1~3)가 쓴다.
- **PC 경로**(host key, 구성원 확인 `membership`): `PUT /api/hosts/device/projects/:id/conversations {conversations[], requests[{id, conversationId, state, createdAt, endedAt, revision, doc}], removed?[]}`(본문 24 MB·요청 200개까지; `doc`은 문서 스키마의 필드만 남겨 다시 직렬화; 다른 PC의 요청 id와 겹치면 409 `REQUEST_CONFLICT`; 요청이 남지 않은 이전 대화 행은 지움), `DELETE …/conversations`(이 PC의 행만 삭제), `GET …/conversations?since=<ms>`(다른 PC의 대화 목록·요청 메타 전부, `stored_at > since`인 요청만 문서 포함, `at`).
- **브라우저 경로**(구성원 모두, 아니면 404): `GET /api/projects/:id/conversations[?q=]`(대화 목록 `{id,title,kind,provider,model,createdAt,updatedAt,originHost,originName,originPc,requests,lastAt}`; `q`는 조각 글·대화 제목 LIKE, `matches` 200개), `GET …/conversations/:originHost/:conversationId`(요청마다 메타+문서). 조각 경계에 걸친 말은 찾지 못할 수 있다.
- **로컬**(`src/server/conversation-mirror.ts`, `offline-view.ts`가 부름): `conversation-mirror.json`에 프로젝트별 보낸 요청의 지문(상태|입력 길이|결과 길이), 대화 지문(제목|종류|updatedAt), revision, 시각·오류, `removing`. heartbeat 뒤 `summary` 스위치가 켜진 프로젝트마다 1분에 한 번까지 비교해 바뀐 요청만 약 1 MB·8개 묶음으로 올리고(호출 한 번이 D1 무료 요금의 Worker 호출당 쿼리 50개 근처에 머물게) 묶음마다 기록한다(재시작 이어 올리기). 지운 요청(`hidden_requests`)·더는 해당하지 않는 요청은 `removed`. 스위치 끄기·프로젝트 삭제는 `DELETE`(실패하면 `removing`으로 남겨 heartbeat마다 다시). 다른 구성원의 기록은 `GET`으로 받아 데이터 폴더 `projects/<id>/history/`에 `<originHost 앞 8자>-<대화 id>.md`, `README.md`, `.data/mirror.json`(다음 읽기의 `since`와 문서)으로 쓴다. 노트 사본과 같이 10분마다(그리고 작업 이력 화면이 열릴 때) 새로 고친다. AI 턴의 규칙(`workFolderRule`)이 이 폴더를 기록 폴더 안의 읽기 전용 자료로 알린다. 로컬 API: `GET /api/v1/projects/:id/shared-conversations`(`{online, error?, conversations}`; 사이트에 닿지 않으면 사본), `GET …/shared-conversations/:originHost/:conversationId`(사본의 대화 전문).
- **화면**: `src/ui/conversation-mirror/mirror-thread.tsx`(목록·대화 전문, 사이트·VIDE·원격 프로젝트 화면 공용), VIDE 작업 이력의 `src/ui/shared-history.tsx`, 사이트 `src/sharing/web/conversations.tsx`(`/?conversations=<id>&c=<host>:<conversation>&r=<request>`).
- **PC 없이 보기 요약(`0009`)과의 관계**: 요약은 바꾸지 않는다. 모델링 요청까지 포함한 최근 50개 요약은 그대로 `project_history`에 올리고, 전문은 위 표들이 따로 둔다.

### PC 프로그램

[PLAN-11](../plans/PLAN-11-desktop-app.md)의 물리 계약이다. `src/desktop/shell`(.NET Framework 4.8 WinForms, WebView2, Velopack)의 `VIDE.exe`가 `runtime\node.exe app\src\server\main.ts --parent-stdin --no-browser`를 자식으로 띄우고 출력의 실행 주소를 창에 연다. 표준 입력을 닫으면 엔진이 정상 종료한다. 설치 루트는 `%LOCALAPPDATA%\VIDE.App`(`current\`, `packages\`, `Update.exe`, 고정 실행 스텁 `VIDE.exe`), 데이터는 `%LOCALAPPDATA%\VIDE`, 창 저장소는 `<데이터>\webview`, 셸 설정은 `<데이터>\desktop.json`이다. 단일 실행은 `Local\VIDE.Desktop` 뮤텍스와 Show/Quit 이벤트로 한다. 자동 실행은 `HKCU\…\Run\VIDE = "<스텁>" --background`다. 창의 설정 화면과 셸은 WebView2 메시지(`desktop:get|set`, `update:check|apply` ↔ `desktop:state`)로만 통신하고 로컬 주소 외의 이동은 기본 브라우저로 연다. 업데이트는 `UpdateSource`(폴더·URL) 또는 GitHub Releases(`hongikarchi/VIDE`)를 쓴다. 엔진의 `GET /api/v1/connectors`, `POST /api/v1/connectors/rhino8/install`(원격 세션 차단)은 포함된 `VIDE.Worker.rhp`를 `<데이터>\plugins\rhino\<버전>-<해시8>\`에 복사하고 `HKCU\Software\McNeel\Rhinoceros\8.0\Plug-ins\6bde756c-…\PlugIn\FileName`을 바꾼다(Rhino 실행 중 409 `HOST_RUNNING`). 개발 서버 `--dev`는 `.vide/dev-data`와 47831을 쓴다.
- 전송: 원격 응답은 16 KB를 넘으면 gzip(level 4)으로 보낸다. `GET /api/v1/projects/:id/requests` 목록은 결과의 `scene`·`definitions`를 빼고 `sceneOmitted: true`를 붙이며, 화면은 표시할 요청만 단건 조회로 받는다.
- 표시용 이진 전송(2026-09-29, [PLAN-18](../plans/PLAN-18-render-performance.md)): `GET /api/v1/projects/:id/requests/:rid`에 `Accept: application/vnd.vide.geometry`가 있으면 같은 내용을 `VGT1` 컨테이너로 준다(`src/contracts/geometry-transfer.ts`): `VGT1` + u32 머리 길이 + JSON 머리 + 4바이트 정렬 버퍼. `result.scene[]`와 `result.definitions{}` 항목의 `vertices`·`line`·`segments`는 `{"$bin":[offset,length,"f",ox,oy,oz]}`(첫 점 기준 float32, 원점 float64), `indices`는 `"u16"`/`"u32"`로 바뀐다. 오류 응답은 JSON이다. 작업 화면(`src/ui/gateway.ts`)은 단건 조회에 이 헤더를 붙이고 숫자 배열로 되돌린다. 저장은 T-083 전까지 JSON이고, 그 뒤에는 §5 「Sync 표시 형상의 객체 단위 저장(T-083)」의 객체별 VGT1을 이어 붙여 응답한다.
- 이전 대화 선별(2026-09-29, [PLAN-19](../plans/PLAN-19-request-routing.md)): `src/ai/context-selector.ts`가 이전 대화 6개 초과 시 Jev System One(`jev-1.13.0`, 최근 20개 각각 Noul, 5초)으로 고른다. 키는 `readJevKey`(환경 `TYPESAFE_API_KEY` 또는 `<데이터>/typesafe.env`). 진단 기록 `context {request, by: all|jev|fallback, ms, sent, of, reason?}`. Sync 진단 `sync {request, host, state, ms, hostMs, objects}`, `live-sync {ms}`.
- 요청 경로 판정(2026-09-29, PLAN-19): `POST /api/v1/projects/:id/route {body ≤4000, subjects[≤60]{id,label}}` → `{target: view|document, action?, subject?, confidence, ms}` 또는 `{target: null}`(규칙으로). `src/ai/request-router.ts`가 Jev System One에 `target`·`action`(hide·isolate·unhide·select·fit)·`subject`(s0…·none) 세 Choice를 3초 제한으로 묻고, 확신 0.6 미만·오류는 null. 파일·프로그램 말은 호출 없이 document. 화면(`src/ui/request-route.ts`)은 대상 묶음 id를 `selection`·`kind:<종류>`·`layer:<이름>`(객체 수 순 30개)로 만든다. 진단 `route {by: jev|rules, target?, action?, ms?}`. 보내는 이전 대화는 하나당 요청 2,000자·답 6,000자로 자른다.
- 호스트 패널(2026-09-29, [PLAN-21](../plans/PLAN-21-host-panel.md), Design SCR-12): Rhino 패널(Eto `WebView`)과 ZWCAD 팔레트(WebView2 WinForms, 데이터 `<데이터>/webview-zwcad`, 로더는 플러그인 옆 `WebView2Loader.dll`)가 같은 페이지를 연다: `<로컬 주소>/?panel=rhino|zwcad&name=<파일>[&project=<id>&instance=<연결>&document=<번호>]&theme=light|dark#<세션 토큰>`. `instance`가 없으면 연결 전 화면이다. 페이지는 플러그인 동작을 `vide://link|unlink|live|reload|open-vide` 이동으로 요청하고 플러그인이 취소한 뒤 실행한다(공통 `hosts/common/PanelPage.cs`). `launch.json`이 없으면 플러그인이 만든 'VIDE 실행' 화면을 보이고 1초마다 다시 확인한다. 화면의 사용량 막대는 `GET /api/v1/accounts` + `/accounts/usage`(2분 간격)를 쓴다.

### 진단 기록(T-126, [ADR-031](../decisions/ADR-031-stock-first.md) 9)

모든 부분이 `<데이터>\logs`에 날짜별 JSON 줄 파일을 남기고 14일 뒤 지운다. 줄에는 시각(`at`)·버전(`v`)·프로세스 세션(`sid`)·`event`가 있고, ID·코드·시간·크기·예외 스택만 담는다. 요청 문장·파일·문서 내용·키는 남기지 않으며 로그는 AI에게 보내지 않는다.

| 파일 | 쓰는 곳 | 주요 줄 |
|---|---|---|
| `engine-YYYY-MM-DD.jsonl` | 엔진(`src/server/diagnostics.ts`) | `request-start/-stages/-end`, `sync`(실패면 `code`·`phase`), `sync-failed`, `live-sync`/`live-sync-failed {code}`, `api-error {method, path(:id), status, code, requestId, projectId?, request?}`, `server-error`, `tool-call {requestId, tool, ms, bytes, ok, code?}`, `cli-start/-exit {provider, cliVersion, model, effort, kind, resume?, code, signal?, ms, stderrTail?}`, `host-refused {code, final}`, `client-error`, `health`, `step`(브레드크럼) |
| `engine-stderr-YYYY-MM-DD.log`, `engine-exits.jsonl` | PC 프로그램(`Engine.cs`) | 엔진 표준 오류, 종료 코드 |
| `shell-YYYY-MM-DD.jsonl` | PC 프로그램(`ShellLog.cs`) | 시작·종료, 트레이 동작, 업데이트 단계·적용, 엔진 시작·종료·재시작, WebView 실패·다시 불러오기·새로 만들기, 덤프 경로 |
| `rhino-…`, `zwcad-…jsonl` | 호스트 플러그인(`hosts/common/DiagnosticLog.cs`) | `plugin-load {rhino/zwcad 버전}`, `call {method, ms, bytesIn, bytesOut, ok, code?}`(예외면 형식·메시지·스택), 자주 묻는 상태 조회는 1분 합계 `calls-summary` |

- **쓰기:** 엔진은 줄을 메모리에 모아 1초 또는 64 KB마다 한 번 붙여 쓴다(호출 쪽은 디스크를 기다리지 않음, 10,000줄 측정 줄당 약 3 µs, 이전의 줄마다 동기 append는 약 85 µs). 브레드크럼·충돌·`exit` 줄은 즉시 쓰고, 프로세스가 끝날 때 모인 줄을 동기로 쓴다. 하루 파일은 64 MB(플러그인·셸 32 MB)에서 멈추고 `log-cap` 한 줄과 버린 줄 수(`log-cap-dropped`)를 남긴다. 같은 경로·코드의 반복 `api-error`는 10초에 한 줄과 `repeated` 수로 줄인다. 플러그인·셸은 같은 방식으로 1초마다 풀 스레드에서 쓴다.
- **요청 연결:** 요청 실행은 `withTrace`(AsyncLocalStorage, `src/core/breadcrumbs.ts`) 안에서 돌아 그 안의 줄에 `requestId`가 붙는다. AI 도구 범위는 발급 때의 요청을 기억한다. 바깥 텍스트(CLI 오류 출력, 화면 오류)는 `scrub`으로 키·토큰·Windows 사용자 이름을 지우고 2 KB로 자른다.
- **화면 오류:** `POST /api/v1/diagnostics/client {kind, message, stack?, source?, line?, column?, route?, version?}` → `client-error`(분당 20줄, 같은 메시지는 1분에 한 번).
- **진단 묶음:** `POST /api/v1/diagnostics/bundle {days?, dumps?}`(이 PC만) 또는 `node tools/diagnostics/bundle.mjs`가 `<데이터>\diagnostics\vide-diagnostics-<시각>.zip`(최근 3개)을 만든다. 날짜 로그·종료 기록·`about.json`(버전·OS·플러그인 파일 목록·데이터 폴더 파일 이름과 크기)·`settings.json`(설정 파일 요약)만 넣고, `launch.json`·`local-session.key`·`remote-host.json`·`typesafe.env`·`cli-profiles`·DB는 넣지 않는다. 덤프는 `dumps`일 때 최신 하나만. `GET /api/v1/diagnostics/bundle`(이 PC만) → `{dump: {bytes, modified, sendable}|null}`이 설정의 [크래시 덤프 포함 (약 N MB)](기본 켬)에 크기를 준다. 읽기는 `node tools/diagnostics/view.mjs [--day] [--failures] [--request <id>]`.
- **덤프:** ProcDump는 `-accepteula -e -ma <pid>`로 붙어 처리되지 않은 예외(엔진의 `0xC0000409` fail-fast 포함, 디버거에는 2차 예외로 온다)에만 전체 덤프를 쓰고 최근 3개만 남긴다(`CrashDumps.cs`). 종료 감시(`-t`)는 쓰지 않는다(T-191: 정상 종료마다 230~785 MB 덤프가 생겨 크래시 덤프를 밀어냈다). 바깥에서의 강제 종료는 덤프 없이 `engine-exits.jsonl`의 종료 코드로만 남는다.

### 오류·성능 보고(ADR-036, [PLAN-34](../plans/PLAN-34-telemetry.md))

동의한 설치만 진단 기록의 요약을 계정 사이트로 보낸다(동작은 SPEC-05.9).

- **엔진(`src/server/telemetry.ts`):** 선택·설치 번호·커서는 `<데이터>\telemetry.json`(`consent: granted|denied`, `installId` UUID, `decidedAt`, `cursor`, `lastBatchAt`, `lastSentAt`, `lastError`, `crashSeenAt`). 없거나 읽을 수 없으면 답하지 않은 것(전송 없음). 첫 실행 카드는 `VIDE_DESKTOP=1`(PC 프로그램이 띄운 엔진)에서만 `prompt: true`. 보낼 곳은 `VIDE_TELEMETRY_SITE` → 로그인한 계정 사이트(`remote-host.json`의 `workerOrigin`) → 기본 사이트. 동의 중이면 시작 60초 뒤 한 번(지난 묶음 뒤 1시간 이상일 때 새 요약)과 1시간마다(24시간마다 새 요약) 돈다. 요약은 `<데이터>\telemetry-outbox\report-<시각>.json`(최근 14개)에 쓰고 `POST <사이트>/api/telemetry/reports`(JSON, 쿠키·인증 없음, 20초)로 오래된 것부터 보낸다. 2xx면 지우고, 400·413·415·422면 버리고, 그 밖(404·429·5xx·연결 실패)은 남겨 다음 회차에 보낸다. 거부로 바꾸면 보낼 상자를 지운다.
- **요약(`src/server/telemetry-summary.ts`):** 커서 이후·지금까지의 `engine|shell|rhino|zwcad-YYYY-MM-DD.jsonl`과 `engine-exits.jsonl`을 줄 단위로 읽는다. 보고 형식 `{installId, version, kind: 'summary', payload: {os, arch, node, cpus, memoryGB, from, to, versions{part: [v]}, hosts{rhino?, zwcad?}, counts{"part:event": n}, errors[{part, event, count, first, last, fields}], exits[{at, code, hex?, uptimeSec?}], timings{name: {n, p50, p90, max}}, truncated?}}`. `fields`는 `ALLOWED_FIELDS`(이벤트별 필드 → 형식 `code|word|int|bool|version|hex|route|asset|text|stack`)를 통과한 값만이다. `text`는 `reportText`(키 제거 → 주소·이메일 → UNC·드라이브(공백 포함)·POSIX 경로 → 지정 단어(Windows 사용자·PC·프로젝트 이름) → 따옴표 안 → 문서 파일 이름 → ASCII 밖 글자 → UUID·긴 hex·긴 ID, 300자), `stack`은 `reportStack`(프레임 8개, VIDE 소스 꼬리 `src/…`·`hosts/…`만). 시간 표본: `request.*`(`request-stages`), `tool.<도구>.ms`, `sync.ms`·`sync.hostMs`, `live-sync.ms`, `cli.<공급자>.ms`, `health.*`, `<rhino|zwcad>.<메서드>.ms`(지표 80개, 지표당 표본 2,000). 32 KB 초과면 스택 → 실패 → 수치 → 이벤트 수 순으로 줄이고 `truncated{errors, timings, stacks}`. 비정상 종료는 `asked: false`이고 코드가 0·-1·`0xC000013A`가 아닌 것.
- **엔진 API:** `GET /api/v1/telemetry` → `{consent|null, prompt, installId?, decidedAt?, lastSentAt?, lastError?, pending, site, crash?{at, code, hex?}}`(원격 세션은 `prompt: false`, `crash` 없음), `PUT /api/v1/telemetry {consent}`·`GET /api/v1/telemetry/preview`(다음 요약, 보내지 않음)·`POST /api/v1/telemetry/crash {send, dumps?}`는 이 PC만(원격 `FORBIDDEN`). `crash` 답은 그 종료를 본 것으로 기록하고, `send`면 `writeDiagnosticBundle({days: 3, dumps})`(덤프 없이 8 MB, 덤프 포함 95 MB 이하)을 `POST <사이트>/api/telemetry/bundles`(`application/zip`, `X-Vide-Install`·`X-Vide-Version`·`X-Vide-Dumps`)로 보낸다 → `{sent, reason?, file?, bytes?, dumpSkipped?}`. 최신 덤프가 `dumpSendable`(덤프 + 8 MB ≤ 95 MB)이 아니면 덤프를 빼고 로그 묶음만 보낸다(`dumpSkipped`). 엔진 로그에는 `telemetry-consent {consent}`·`telemetry-bundle {sent, reason?, bytes?}`만 남긴다.
- **화면:** `src/ui/shell/telemetry.tsx`(`TelemetryCards`: 세션이 열린 뒤 `GET /telemetry`로 첫 실행 카드 또는 충돌 카드, 호스트 패널 제외; `TelemetrySection`: 설정 ‘상태 · 오류’ 탭이 보일 때 읽음). 문구 원본은 `src/contracts/telemetry-notice.ts`(사이트 `/privacy`와 공유).
- **사이트(`src/sharing/telemetry.ts`, D1 `0010-telemetry.sql`):** `telemetry_reports(id, install_id, version, kind, received_at, day, size, payload)`(색인 day·kind / version·received_at / install_id·received_at / received_at), `telemetry_limits(key, window_start, count)`(하루 고정 창: `report|bundle:install:<id>:<day>`, `…:ip:<SHA-256 앞 32자>:<day>`), `telemetry_bundles(id, install_id, version, received_at, size, object_key, dumps)`. `POST /api/telemetry/reports`는 공개(계정·Origin 검사 없음)이며 `TELEMETRY_REPORTS_ENABLED='false'`면 503, 본문 48 KB(413), 설치 번호 UUID·버전·`kind: summary`·객체 `payload`(400), 경로·`/Users/`·`/home/`·이메일이 남은 본문 422, 설치당 하루 `TELEMETRY_INSTALL_DAILY`(24)·주소당 `TELEMETRY_IP_DAILY`(300) 초과 429, 저장 201 `{id}`. 약 2%의 쓰기에서 이틀 지난 카운터와 `TELEMETRY_KEEP_DAYS`(180)일 지난 보고를 지운다. `POST /api/telemetry/bundles`는 `TELEMETRY_BUNDLES_ENABLED='true'`일 때만(기본 503 `BUNDLES_DISABLED`): zip·`Content-Length` 필수, `TELEMETRY_BUNDLE_MAX_MB`(8)/`TELEMETRY_BUNDLE_DUMP_MAX_MB`(95), 설치당 하루 3건, R2 `ASSETS`의 `telemetry/bundles/<day>/<install>/<id>.zip`.
- **관리자:** `GET /api/admin/telemetry/{summary|reports|reports.csv|bundles|bundles/:id}`는 `Authorization: Bearer <TELEMETRY_ADMIN_TOKEN>`(32자 이상, 다이제스트 비교) 또는 로그인 계정의 아이디·이메일이 `ADMIN_USERS`(쉼표 구분)에 있을 때만(401 `LOGIN_REQUIRED`, 403 `ADMIN_REQUIRED`). 거르기 `day|from|to|version|kind|install`, `reports`는 `limit`(≤500)·`before`(받은 시각) 쪽 넘기기, CSV(UTF-8 BOM, 최대 5,000행)는 `id, received_at, day, install_id, version, kind, size, os, errors, top_error, exits, truncated, payload`이고 `= + - @`로 시작하는 칸은 `'`를 붙인다. `GET /api/me`에 `admin`. 화면은 `/?admin=reports`(`web/reports.tsx`), 공개 안내 `/privacy`(`web/privacy.tsx`). 개발 도구 `node tools/diagnostics/reports.mjs`(환경 `VIDE_TELEMETRY_ADMIN_TOKEN`, `--site`·`--day`·`--days`·`--version`·`--install`·`--json`·`--csv`·`--out`)가 버전별 설치 수·실패 종류(설치 수 순)·종료 코드·주요 시간을 보인다.

### jig 관리자 제출(ADR-041, SPEC-07.19·04.13, PLAN-43 T-201)

PC가 jig 묶음을 계정 사이트의 관리자 제출함으로 보내고, 관리자가 내려받아 저장소에 푸는 경로다. 묶음 형식은 ARCH-03 §12의 `.vjig`(gzip JSON `{format: 'vide.jig.pack/1', id, version, files{경로: base64}, digest, sig}`)를 그대로 쓴다.

- **D1** `0014-jig-submissions.sql`: `jig_submissions(id, user_id, host_id, host_name, jig_id, version, name, note, size, sha256, pack_digest, object_key, status, reason, reviewed_by, created_at, updated_at)`.
  - `status`는 `received|reviewing|applied|rejected`(화면의 받음·검토 중·반영됨·반려)다.
  - `sha256`은 사이트가 받은 파일 바이트로 계산한 값이고, `pack_digest`는 묶음 안의 `digest`(ARCH-03 §12의 내용 지문)다.
  - 색인은 `(user_id, created_at)`, `(status, created_at)`이다.
- **R2** `ASSETS`의 `jig-submissions/<제출 id>.vjig`
- **PC 경로**(host key):
  - `POST /api/hosts/device/jig-submissions?jig=<id>&version=<v>&name=<이름>`
    - 본문은 묶음 원시 바이트이고 `Content-Length`가 필요하다(411 `LENGTH_REQUIRED`).
    - 메모는 `X-Vide-Note`에 `encodeURIComponent`로 싣는다(2,000자).
    - 상한은 `JIG_SUBMISSION_MAX_MB`(기본 8)이며 넘으면 413 `JIG_SUBMISSION_TOO_LARGE`다.
    - 사이트는 본문을 끝까지 읽어 SHA-256을 계산하고, gzip을 풀어(64 MB 상한) 형식·`id`·`version`이 질의와 같은지 본다. 다르면 422 `JIG_PACK_INVALID`다.
    - 계정의 `received` 제출이 20개면 429 `JIG_SUBMISSIONS_FULL`, `UPLOADS_ENABLED='false'`면 503 `UPLOADS_DISABLED`다.
    - 성공은 201 `{submission}`이다.
  - `GET /api/hosts/device/jig-submissions` → `{submissions}`. 그 PC 계정의 제출만, 최근 100개다.
  - 제출 행은 `{id, jigId, version, name, note, size, sha256, status, reason, createdAt, updatedAt, pc}`이다.
- **관리자 경로:** 텔레메트리와 같이 `TELEMETRY_ADMIN_TOKEN` Bearer 또는 `ADMIN_USERS` 계정 세션만 통과한다(401 `LOGIN_REQUIRED`, 403 `ADMIN_REQUIRED`). 세션으로 하는 POST·DELETE는 `Origin`이 사이트 주소여야 한다(403 `ORIGIN_REJECTED`).
  - `GET /api/admin/jigs[?status=]` → `{submissions}`. 제출 행에 `submitter`(아이디)를 더하고 최근 200개다.
  - `GET /api/admin/jigs/:id/pack` → `application/gzip`, 파일 이름 `<id의 이름 부분>@<버전>-<sha256 앞 8자>.vjig`
  - `POST /api/admin/jigs/:id/status {status, reason?}` → `{submission}`. `rejected`는 사유(1~500자)가 필요하다(400 `REASON_REQUIRED`).
  - `DELETE /api/admin/jigs/:id` → R2 파일과 행을 지운다.
- **엔진(`src/server/jig-submit.ts`):**
  - `POST /api/v1/jig-submissions {projectId, draftId} | {jigId, version}, note?, confirm: true`
    - 원격 세션은 `FORBIDDEN`, `confirm`이 없으면 `CONFIRMATION_REQUIRED`다.
    - 초안은 `validateDraftDir`, 설치 jig는 `JigStore.package`의 경로와 출처로 형식 점검을 한다. 실패하면 422 `JIG_INVALID {issues}`다.
    - `packJig(dir, {source, bundle: false, skipTests: true})`로 이 PC의 키로 서명한 묶음을 만든다. 8 MB를 넘으면 413 `JIG_SUBMISSION_TOO_LARGE`다.
    - `RemoteAccess.uploadJigSubmission`이 올린다. 로그인하지 않았으면 409 `ACCOUNT_NOT_LINKED`(사이트가 host key를 모르면 409 `ACCOUNT_UNLINKED`), 사이트에 닿지 않으면 503 `SITE_UNREACHABLE`이다. 사이트의 오류 코드는 그대로 전한다. 다시 보내지 않는다.
  - `GET /api/v1/jig-submissions` → `{linked, online, submissions, error?}`(사이트 `GET`을 그대로 전한다. 로그인하지 않았으면 `linked: false`)
- **화면:** `src/ui/jig-submit.tsx`(확인 카드와 메모, 내 제출 목록)를 만들기 화면(`make-tab.tsx`)과 JIG 목록의 설치 jig 카드(`jigs.tsx`)가 쓴다. 사이트 관리자 화면은 `/?admin=jigs`(`web/admin-jigs.tsx`)다.
- **관리자 도구:** `npm run jig:unpack -- <파일.vjig> --digest <sha256> [--out extensions/jigs] [--force]`(`tools/jig/unpack.mjs` → `src/jigs/runtime/unpack.ts`).
  - 파일 SHA-256이 `--digest`와 같아야 하고, 묶음의 내용 지문을 다시 계산해 `digest`와 같아야 한다. HMAC 서명은 보지 않는다.
  - 절대 경로, `..`, 역슬래시, 드라이브 경로, 금지 파일(ARCH-03 §5.4)이 있으면 거절한다.
  - `<out>/<id의 이름 부분>/`이 있으면 `--force` 없이는 거절하고, `--force`면 폴더를 바꾼다. 임시 폴더에 쓴 뒤 옮긴다.
  - 푼 뒤 `validateJig`로 형식 점검 결과를 보인다.

### 외부 도메인 서비스(ADR-040, 계약만)

cLAWde·ArchiDB·Site Modeling·Structure Analysis는 각자의 저장소와 배포를 가진다. VIDE 저장소에는 연결 계약만 둔다. 2026-10-07 기준으로 코드는 없다.

- **연결 주체.** 서비스 호출은 엔진이 한다. 화면과 jig 계산 상자(compute box)는 서비스에 직접 닿지 않는다.
  - jig는 `service.<name>` 능력을 선언한다. 이것은 ARCH-03의 예약 능력이며, 지금은 검사기가 거절한다.
  - 엔진은 선언한 jig에만 그 서비스의 읽기 결과를 입력으로 넘긴다.
- **인증.** 사용자 VIDE 계정(ADR-039)으로 서비스 토큰을 받는다. 토큰은 엔진 데이터 폴더의 비밀 저장소에 두고, 화면·기록·검수 증거에 남기지 않는다.
- **읽기.** HTTP JSON으로 읽는다. 응답에는 다음이 들어 있어야 한다.
  - 출처: 서비스, 문서 ID, 판, 원문 링크
  - 조회 시각
  - 자료가 공유되어 서비스 DB 정본에 쌓인 것인지, AI 해석인지를 나누는 구분(PRD §6.3)
  - 엔진은 프로젝트 자료 DB에 출처와 함께 캐시한다. 공유 방식(직접 읽기·API·사본 동기화)은 OQ-16에서 정한다.
- **역전송.** VIDE가 쌓은 진술·결정을 서비스로 보내는 요청은 사용자가 확인한 묶음만 보낸다(OQ-17). 무엇을 보냈는지는 작업 기록에 남긴다.
- **형상과 메타데이터.** 대지·법규 결과의 형상은 기존 jig 만들기 경로(호스트 만들기, Link ID ADR-030)로 넣는다. 속성에는 서비스 출처 ID를 둔다.

## 7. 개발 기반과 변경 경계

개발 도구는 Gitleaks 8.30.1과 Prettier 3.8.1을 고정한다. Git 커밋은 staged 비밀정보·입력 일치·포맷·UI/서버/공유 타입·웹 빌드·단위/계약 시험을 검사한다. CI는 공유 통합·브라우저 회귀·전체 이력 검사도 실행한다. 실제 원격 CI/브랜치 보호 상태는 PLAN §6.5가 소유한다.

로컬 DB의 현재 schema는 5다(`schemaVersion`). `src/core/migrations.ts`가 번호 순서와 모든 초기 테이블을 소유하며 서비스 생성자는 스키마를 변경하지 않는다. 단일 제어 잠금 → 읽기 전용 버전/무결성 확인 → 이전 DB의 SQLite 스냅샷 → 단일 트랜잭션 이행/무결성 확인 순서다. 실패는 rollback하고 기존 모델 파일을 변경하지 않는다. `<DB 파일>.backups/schema-<이전 버전>-<UUID>.sqlite`는 이전 DB만 보존하며 전체 프로젝트 백업과 다르다. 성공 후 같은 버전 재시작은 추가 백업을 만들지 않는다. 복구 시 앱을 종료하고 실패 DB/WAL 및 모델 자료를 보존한 뒤 이전 DB와 호환되는 앱으로 사본을 검증한다. 자동 덮어쓰기·이전 앱으로의 자동 다운그레이드는 하지 않는다.

런타임 루트 탐색은 `src/core/package-root.ts`, C# verbatim 문자열은 `hosts/common/csharp.ts`가 소유한다. 호스트는 서버 구현을 import하지 않는다. 패키지 소스는 Git index의 허용된 소스 폴더만 복사하며 금지 파일·심볼릭 링크를 거절한다. 런타임/의존성/UI 빌드 산출물은 별도 명시 경로로 포함한다. 구현/검증 절차는 PLAN-03, 실제 증거는 개발 기반 VERIFY를 따른다.

### 로컬 세션의 다중 실행 격리
같은 loopback 호스트의 쿠키는 포트별로 격리되지 않는다. 로컬 세션 쿠키 이름에 서버 포트를 포함해 다른 VIDE 인스턴스의 로그인이 덮어쓰지 않게 한다. 값·Host/Origin 검사·HttpOnly·SameSite=Strict는 유지하고 고정 이름의 이전 쿠키로 인증을 우회하지 않는다. UI는 인증 오류를 공통 API 경계에서 받아 연결 상실을 표시하며 자동 쓰기 재시도를 하지 않는다.

### CLI 기본 로그인 실행 경계

2026-09-30 [ADR-025](../decisions/ADR-025-accounts-in-accountswitch.md): VIDE는 Claude Code·Codex CLI의 기본 로그인(`~/.claude`·`~/.claude.json`, `~/.codex`)만 쓴다. 계정의 추가·로그인·로그아웃·제거·이름 변경·전환·자동 전환은 외부 프로그램 AccountSwitch가 하며, AccountSwitch는 고른 계정의 로그인을 기본 로그인 폴더로 옮긴다. 한 PC에서 한 공급자는 한 번에 한 계정을 쓰고 동시에 도는 대화도 그 계정을 함께 쓴다. 대화는 공급자·모델만 고정하고 계정은 턴마다 그때의 기본 로그인이다(동작은 SPEC-02.17~19).

- **실행:** CLI 실행에 `CLAUDE_CONFIG_DIR`·`CODEX_HOME`을 주입하지 않고 API 키 변수는 지운다(§2 「AI 실행 인자」의 환경). 사용자가 PC 환경에 둔 `CLAUDE_CONFIG_DIR`·`CODEX_HOME`은 그 CLI의 기본 로그인이므로 실행 환경에 그대로 두고, 현재 계정 읽기도 같은 폴더를 쓴다(2026-10-06 사용자 결정, PLAN-38 T-175. 이전에는 상속 값도 지웠다).
- **실행 파일 탐색(2026-10-06 PLAN-38 T-175, AccountSwitch와 같은 순서):** `src/ai/paths.ts`의 `claudeExecutable`·`codexExecutable`. Claude: 설정 경로 → `VIDE_CLAUDE_PATH` → 네이티브 `~\.local\bin\claude.exe` → npm 전역(`%APPDATA%
pm
ode_modules\@anthropic-ai\claude-code\bin\claude.exe`, 다음 `cli.js`) → PATH(`claude.exe`, 다음 `claude.cmd`). Codex: 설정 경로 → `VIDE_CODEX_PATH` → npm 전역의 `codex-win32-x64` 네이티브 `codex.exe` → `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`(최근 것) → PATH(`codex.exe`, 다음 `codex.cmd`). `.js`는 VIDE의 Node(`process.execPath`)로, npm `.cmd` 심은 그 안의 `%dp0%\…\*.js` 엔트리를 Node로 직접 띄우고, 엔트리를 못 읽으면 `shell:true`로 띄운다(`launchTarget`, `ClaudeCli` 생성자에서 모든 spawn에 적용). 설정 경로 칸은 `claude.exe`·`claude.cmd`·`codex.exe`·`codex.cmd`를 받는다.
- **AccountSwitch 안내:** `src/ai/account-switch.ts`가 `VIDE_ACCOUNTSWITCH_PATH` 또는 `%LOCALAPPDATA%\AccountSwitch.App\AccountSwitch.exe`가 있는지 본다. `GET /api/v1/accounts/usage`와 `GET /api/v1/accounts`는 `accountSwitch: { installed, download }`를 더하고, `POST /api/v1/accountswitch/open`(로컬 세션만)은 그 실행 파일을 분리된 프로세스로 띄우기만 한다. 설치 링크는 `https://github.com/hongikarchi/AccountSwitch/releases/latest`다. 요청·대화의 저장된 `accountProfileId`는 옛 기록 읽기용으로만 남고 새 기록에는 쓰지 않는다(마이그레이션 없음, PLAN-25).
- **현재 계정·사용량(읽기 전용):** `AccountUsageService`(`src/ai/account-usage.ts`)가 기본 로그인 폴더의 `.credentials.json`(`claudeAiOauth.accessToken·expiresAt·subscriptionType`), `.claude.json`(`oauthAccount.emailAddress`), `auth.json`(`tokens.access_token·account_id·id_token`의 email·`chatgpt_plan_type`)을 읽는다. 조회를 켜면 Claude는 `GET https://api.anthropic.com/api/oauth/usage`(`anthropic-beta: oauth-2025-04-20`, `five_hour`·`seven_day`의 `utilization`·`resets_at`), Codex는 `GET https://chatgpt.com/backend-api/wham/usage`(`ChatGPT-Account-Id`, `rate_limit.primary_window/secondary_window`의 `used_percent`·`limit_window_seconds`·`reset_at`, `limit_reached`)를 3분 간격으로 부른다. API: `GET /api/v1/accounts`, `GET /api/v1/accounts/usage[?refresh=1]` → `{settings, accounts[]}`, `POST /api/v1/accounts/usage-settings`(조회 켜기, 원격 세션 불가). 인증 파일은 읽기만 하고 고치거나 복사하지 않는다.
- **한도:** CLI 결과의 한도 문구는 `PROVIDER_LIMIT`이다. 그 턴은 다른 계정으로 자동으로 다시 보내지 않으며 알림 방식은 SPEC-02.19가 정한다.
- **이행(2026-10-01 진행 중):** 관리 프로필(`cli-profiles/profiles.json`, UUID 하위 설정 폴더, Codex file 자격증명 저장소), 계정 선택 `choose`·자동 전환(`autoSwitch`·`threshold`)·`accountSwitchedFrom`·`markLimited`, 계정 로그인·로그아웃·제거·이름 변경·선택 API, 대화의 계정 인계(`…/conversations/:c/account`)는 PLAN-25 2단계에서 코드에서 뺀다. 이전 계약은 [PLAN-06](../plans/PLAN-06-cli-account-profiles.md)·[PLAN-13](../plans/PLAN-13-multi-account.md)과 Git 이력에 있다.

### ZWCAD의 평면 LINE 표현

모델 공간 LINE은 기존 뷰어의 `kind=polyline` 두 점 표현으로 정규화하고 scene의 `nativeType=Line`으로 원래 유형을 보존한다. `area=null`, 길이는 원본 단위를 m로 환산한다. 편집 가능한 mm 문서가 LINE을 포함하면 `dwgEditMode=linear-entities-v1`, 기존 Polyline 전용 문서는 `polyline-vertices-v1`을 유지한다. 혼합 모드는 자체 SDK/고정 적용만 허용하고 레거시 정점 템플릿 계약은 바꾸지 않는다. 고정 적용은 같은 Handle의 Entity 타입이 달라졌으면 쓰기 전 거절한다. LINE은 시작/끝점, Polyline은 기존 정점 복사를 사용하고 공통 표시 속성은 Entity 단위로 보존한다.

## 현재 Rhino 연결 채널

기존 .NET 8 RHP에 VIDEConnect/VIDEDisconnect/VIDESync/VIDELiveSync 명령을 추가한다. Connect는 현재 RhinoDoc에만 인증된 loopback TCP의 고정 EditorExecutor를 붙이며 생성 코드를 실행하는 WorkerExecutor를 노출하지 않는다. 2026-09-30 ADR-022부터 이 연결은 생성 코드를 되돌리기 기록 안에서 실행하는 `direct-execute`·`direct-undo`·`fingerprint`를 더 받는다(§4 「바로 적용 경로」). 프로세스 시작 시각·실행 경로·리스너 PID·문서 serial·새 sessionId를 검증한다. 사용자의 Rhino를 채택하여 종료할 수 있는 핸들은 만들지 않는다.

현재 사용자 LocalAppData/VIDE/rhino-connections 아래에 세션별 연결 기록을 원자적으로 등록한다. 토큰은 로컬 연결 기록에만 있으며 브라우저/AI/공유 응답에 전달하지 않는다. 제어기는 직접 실행 경로/소켓 소유를 검증한 기록만 발견하고 외부 연결은 소유 창 레지스트리에 복제하지 않는다. 외부 instance에는 새 sessionId도 포함하여 재연결 전 후보를 차단한다. 시험은 별도 연결 디렉터리를 환경 변수로 지정한다.

Rhino 패널은 기존 RHP 안의 Eto `ConnectionPanel`을 `PanelType.PerDoc`로 등록하고 `VIDEPanel` 명령으로 연다. 어셈블리 GUID와 플러그인 GUID를 일치시킨다. 문서 런타임 번호로 기존 AttachedConnection을 조작하며 별도 MCP를 추가하지 않는다(2026-09-29 PLAN-21부터 패널 본문은 Eto `WebView`로 VIDE 페이지를 연다, §6 「PC 프로그램」의 호스트 패널). 사용자가 VIDE 열기를 누르면 LocalAppData/VIDE/launch.json의 loopback HTTP 주소를 기본 브라우저로 연다. 인증 주소는 로그/상태 텍스트에 출력하지 않는다. 패널 타이머는 연결·Live·조회 시각 표시만 갱신하고 형상을 조회하거나 저장하지 않는다.

플러그인은 객체·속성·층·정의·재질 변경 이벤트마다 해당 객체의 변경 revision을 기록하고, Live Sync가 켜져 있으면 0.5초 idle 후 세대를 갱신한다. 제어 화면은 가벼운 연결 상태를 1초 주기로 조회한다(T-084부터는 엔진이 조회한다, 아래 「엔진 주관 Sync(T-084)」). 세대가 바뀌면 마지막 표시 Sync의 revision 이후 변경·삭제된 객체만 `displayChanges`로 받아 그 Sync에 병합한다. 다른 요청이 참조한 Sync는 덮어쓰지 않고 병합한 새 기록을 만든다. 연결이 바뀌었거나 revision을 추적할 수 없으면 전체 표시 Sync(`displayPage`)로 돌아간다. 연결 문서의 표시 기준값(`documentHash`)은 연결 session·revision 토큰이며 표시 조회에서 전체 기하 해시를 계산하지 않는다. 후보 캡처는 이 토큰과 내용 지문(`contentHash`)을 함께 남기고, 원본 적용은 내용 지문으로 검증한다. 표시 형상은 객체 GUID·런타임 번호별로 캐시하고, 페이지는 12 MiB 예산으로 끊으며, 메싱·직렬화는 UI 스레드 밖에서 병렬로 한다. 블록은 정의(중첩 전개 포함)의 메시·선분·문자를 표시 모델의 `definitions[정의 GUID]`에 한 번만 싣고, 인스턴스 항목은 `block.definition`과 미터 단위 행 우선 4×4 `block.transform`만 싣는다. 뷰포트는 정의별 GPU 형상을 인스턴스끼리 공유한다. 치수·문자는 `segments`(xyz 끝점 쌍)와 `texts`(CAD와 같은 문자 표시 형식, XY 평면), 해치는 패턴 선·경계를 `segments`로, 단색 채움은 메시로 싣는다. 증분 조회는 바뀐 인스턴스가 참조하는 정의를 함께 보내며, 정의·치수 스타일이 바뀌면 캐시를 비우고 해당 객체를 변경으로 기록한다. 네이티브 블록·주석은 수정하지 않는다. PowerShell 소유 확인은 연결별로 60초 재사용하되 매 호출 PID 생존을 확인하고 통신 실패 시 무효화한다. 적용/명령 중 취득은 보류하고 자동 취득은 단일 실행·초안 보호·실패 후 수동 재개를 따른다.

(2026-09-30 ADR-022로 대체: 연결 Rhino 수정은 자동 모드의 `direct-execute`가 된다. 아래 문단은 이전 경로의 기록이다.) 연결 Rhino 수정은 요청의 `applyToSource: true`와 `permission: candidate`로 기록한다. 명시적 baseRequestId의 attached-editor Rhino 캡처만 허용하고 개입 시 동일 권한을 유지한다. Execution은 검증 후보를 먼저 영속화하고 Applications.prepare/confirm을 호출한다. 적용 식별자와 결과를 남기고 성공 후 captureEditor로 갱신한다. 쓰기 결과 불명확 시 후보를 보존하고 동일 적용 영수증을 조회한다.

### Rhino 네이티브 취득의 블록 보존

취득 지문과 저장 재검증은 일반 문서 객체와 삭제되지 않은 InstanceDefinition의 GetObjects 결과를 GUID로 중복 제거한 집합을 사용한다. 정의 ID·이름·설명·멤버 GUID·사용자 문자열도 비교한다. 화면 목록은 일반 객체 목록을 유지하며 정의 내부 객체를 별도 최상위 선택 대상으로 복제하지 않는다. Live Sync는 InstanceDefinitionTableEvent도 변경 세대에 포함한다. 연결 지문은 각 객체의 기존 기하/속성 해시를 순서대로 증분 SHA-256에 추가해 전체 연결 문자열의 중복 할당을 피한다. 현재 객체 수/표시 응답 상한은 별도이며 이 보존 수정만으로 해제하지 않는다.

### Rhino 표시 페이지 취득

격리 worker의 `exportPage`는 GUID 정렬 객체 목록의 offset·limit(최대 1,000)과 실행 revision을 받는다. 첫 페이지에서 revision·total을 고정하고 후속 페이지에 재전송한다. 응답은 기존 nativeModel 필드와 page `{offset,nextOffset,total,revision}`다. 배열 집합·GUID·다음 offset·revision을 제어기에서 검증한다. 16MiB 소켓 응답 한도는 유지하고 명시적 HOST_RESULT_TOO_LARGE에만 읽기 페이지를 절반으로 줄여 재조회한다. 다음 페이지부터는 다시 두 배씩 늘린다(최대 1,000). 1개 객체에서도 초과하면 같은 페이지를 `boxOnly`로 다시 읽어 그 객체를 경계 상자 메시와 `oversized: true`로 받는다. 편집 창의 표시 페이지(`DisplayScene`)는 이 판단을 호스트에서 한다: 한 객체가 페이지 예산(12 MiB)을 넘으면 경계 상자로 바꿔 보낸다. 표시 범위(`displayCoverage`)는 이런 객체를 `<종류> (16 MB 초과 · 상자로 표시)`로 세어 화면의 표시 미지원 안내에 나온다. 연결 단절/불명확 응답에는 재조회하지 않는다. 합산 크기·객체 수 상한은 없고(ADR-031 7) 완성 전 결과를 영속 성공으로 저장하지 않는다. 측정 캐시 전달이 2MiB를 넘으면 해당 전달만 생략하며 worker 내부 동일 형상 캐시는 유지한다. 브라우저 API는 현재 완성 모델을 한 번에 받는다. 브라우저 스트리밍/LOD는 별도 후속이며 이 단계로 완료 처리하지 않는다.

완성된 표시 응답은 `displayCoverage`에 total·displayed·omitted·omittedTypes를 담는다. 실제 sceneRepresentation으로 표시할 수 없는 객체를 집계하며 삭제로 표시하지 않는다. 블록 상세 메시 미지원은 이 범위에 포함한다. 네이티브 보존 검증과 화면 형상 지원은 분리한다.

연결된 사용자 Rhino의 읽기 Sync는 고정 메서드 `displayPage`를 사용한다. 현재 문서의 보이는 객체를 조회하고 미터 단위 표시 좌표를 반환한다(T-128부터 VGT1, §5 「호스트 표시 페이지의 바이너리 형상」). 네이티브 파일 저장·별도 worker 실행·면적/체적 계산은 하지 않는다. 페이지 사이 변경은 읽기 revision과 전후 문서 지문으로 확인한다. 직접 표시 응답의 합산 예산은 128MiB이며 편집 worker의 기존 예산과 구분한다. 결과는 `displayOnly: true`, `verified: false`, 원본 식별자·지문을 담은 `sourceDocument`로 저장한다. 원래 유효하지 않은 객체는 `valid: false`로 기록하고 렌더링에서 제외한다. 엄격한 `nativeModelSchema`와 표시용 `displayModelSchema`를 분리하며 네이티브 편집 검증을 완화하지 않는다. 이 표시 Sync를 기준으로 한 AI 편집은 §4 「바로 적용 경로」로 열린 문서에서 실행한다(`Execution`이 Rhino 표시 Sync 기준이면 `runDirectTurn`). 바로 적용 드라이버를 쓰지 않는 실행(검토 jig 등)만 같은 원본 지문을 확인하고 기존 `captureEditor`로 검증된 작업 사본을 준비한다.

### 프로젝트 연결 파일(Link)

SPEC-01.11. 스키마 v4의 `document_links(id, projectId, host, name, path, instance, documentId, hidden, linkedAt, updatedAt)`가 프로젝트별 연결 파일을 소유한다. 열린 문서와 연결 행의 대조(`matchOpenDocuments`, `src/core/document-links.ts`)는 세션 우선이다(2026-10-01, T-095): 같은 호스트에서 `instance`+`documentId`가 같은 행이 그 창의 연결이고, 여럿이면 `path`가 지금 경로와 같은 행, 다음은 `updatedAt`이 가장 최근인 행이다. 연결 행의 `updatedAt`은 마지막 대조 시각이다: Link·`follow`만 쓰고 hidden 변경(`setHidden`)은 쓰지 않으며, `follow`는 같은 창의 다른 행보다 늦지 않게 그 시각을 올린다(지금 연결 상태인 행이 다음 다른 이름 저장을 따라간다). 그 창에 맞는 행이 없을 때만 자기 세션이 열려 있지 않은 행을 `path`(대소문자 무시)로 잇는다. 열린 문서 하나에는 행 하나만 연결 상태가 되고 나머지는 닫힘이다. 디렉터리 구분자가 없는 경로(ZWCAD의 저장 전 `Drawing1.dwg`)는 경로가 없는 것으로 본다. `GET /api/v1/projects/:id/links`는 연결 행에 현재 연결 상태(대조한 열린 문서의 live·generation·objectCount)와 마지막 Sync(`linkRequests`의 가장 최근 성공 기록: `input.linkId`가 그 연결, 파일 항목은 같은 이름의 이전 가져오기 포함)를 붙여 돌려준다. 세션으로 이은 호스트 행의 이름·경로가 지금 문서와 다르면(다른 이름으로 저장, 첫 저장) 같은 GET이 그 행에 새 이름·경로를 쓴다(`DocumentLinks.follow`, 파일 항목 제외). 호스트 턴의 연결 파일 목록(`Execution.liveLinks`)도 같은 대조와 쓰기를 한다(`followOpenDocuments`, §3 「여러 파일 턴」). 경로로 이은 행에는 그 창의 `instance`·`documentId`를 써서 다음 GET부터 세션으로 잇는다(VIDE가 연 작업 사본 창의 행은 제외). 다른 행이 이미 그 경로를 가져도 그 행은 그대로 두며 닫힘으로 보인다. `POST .../links`(플러그인 Link)는 같은 순서(세션, 다음 경로)로 기존 행을 찾아 이름·경로·세션을 갱신하고 없을 때만 새 행을 만든다. 화면은 같은 소속 규칙(`src/contracts/link-requests.ts`)으로 요청을 연결 파일에 묶는다. `POST .../links`(플러그인), `PUT .../links/:linkId`(hidden), `POST .../links/:linkId/remove`(연결 파일 제거, SPEC-01.11의 9: `removeLink`, `src/server/link-removal.ts`가 그 연결의 Sync·가져오기 요청(`input.linkId`가 그 연결이거나, 파일 항목이면 같은 이름의 이전 가져오기)을 기하와 함께 지우고(`workspace.purge`, 게시본이 쓰는 것은 숨김), 데이터 폴더 안의 작업 폴더·업로드 사본 가운데 다른 요청이 쓰지 않는 것을 지운 뒤 연결 행을 뺀다. 그 요청이 대기·실행 중이면 `PROJECT_BUSY`. 사용자 파일과 호스트 창은 건드리지 않는다). Sync·Live Sync 요청 본문의 `linkId`가 결과를 연결에 묶는다.

**문서 안의 연결 ID와 모호한 Link(2026-10-02, [ADR-030](../decisions/ADR-030-link-id-in-document.md), T-107·T-108).** 스키마는 바꾸지 않는다(연결 ID = `document_links.id`).

- **저장 위치:** Rhino는 문서 사용자 문자열 `doc.Strings`의 구역 `VIDE`, 항목 `link:<projectId>` = 연결 ID(`hosts/rhino/worker/LinkIdStore.cs`). ZWCAD는 명명 객체 사전의 `VIDE_LINKS` 사전에 키 `<projectId>`, Xrecord 한 개(`DxfCode.Text` = 연결 ID, `hosts/zwcad/connection/LinkIdStore.cs`). 같은 값이면 다시 쓰지 않는다(문서를 수정하지 않음).
- **플러그인 메시지:** `attachedStatus` 답에 `linkIds: string[]`(문서가 가진 모든 연결 ID, 최대 50)를 더한다. 엔진의 열린 문서 목록(Rhino `editors.list`, ZWCAD `attached.list`, `hostDocumentsSchema`)이 이를 `linkIds`로 전한다. 새 메서드 `setLinkId {projectId, linkId}` → `{ok, linkIds}`는 그 프로젝트의 ID를 문서에 쓴다(Rhino는 UI 스레드의 디스패치, ZWCAD는 유휴 큐에서 문서 잠금·트랜잭션). 엔진 쪽은 `EditorSessions.setLinkId(target, projectId, linkId)`(연결 편집기만), `AttachedZwcadDocuments.setLinkId`.
- **대조 순서:** `matchOpenDocuments`는 ① 같은 창(`instance`+`documentId`) ② 문서의 `linkIds`에 든 행(자기 창이 열려 있지 않을 때, 같은 ID가 여러 창에 있으면 행의 경로와 같은 경로의 창, 없으면 먼저 나온 창) ③ 같은 경로 순으로 맞추고, 결과마다 `how: 'session'|'stored'|'path'`를 둔다. `followOpenDocuments`는 이를 `DocumentLinks.follow(projectId, id, document, how)`로 넘긴다.
- **`POST …/links` 본문:** `{host, instance, documentId, storedId?, replace?: <linkId>|'new', ask?: boolean}`. `ask: true`(이 기능을 아는 플러그인)이면 먼저 `DocumentLinks.linkChoice`가 물을지를 정한다: `storedId`의 행이 다른 열린 창(같은 호스트의 열린 문서 목록 기준)의 행이면 `reason: 'copy'`, `default: 'new'`; `storedId` 행이 없고 이 창의 행도 없는데 자기 창이 열려 있지 않은 같은 호스트 행 가운데 같은 경로(`match: 'path'`)·같은 이름(`'name'`)·`updatedAt`이 12시간 안(`'recent'`)인 것이 있으면 `reason: 'closed'`, 그 순서로 최대 5개, `default`는 첫 후보가 경로 일치면 그 행 ID, 아니면 `'new'`. 물어야 하면 409 `{code: 'LINK_CHOICE', reason, default, choices: [{id, name, path, updatedAt, match, syncs}]}`(`syncs`는 `linkRequests` 개수)이고 행은 바꾸지 않는다. 아니면 `DocumentLinks.link`가 `replace`(행 ID: 그 행, 없으면 `NOT_FOUND`; `'new'`: 새 행) → `storedId`의 행 → 같은 창의 행 → 같은 경로의 행 → 새 행 순으로 고른다. 고른 행이 그 창의 것이 아니면 그 창(`instance`+`documentId`)의 다른 행은 `instance`를 `closed:<uuid>`로 바꿔 닫힘으로 둔다(새 행일 때도 같다). `ask`가 있고 `storedId`가 결과 ID와 다르면 행에 저장 알림을 남긴다. 응답 201은 연결 행이며 플러그인은 그 `id`를 문서에 쓴다.
- **알림:** `DocumentLinks`가 메모리에 행별 알림 하나를 둔다(엔진 재시작 시 사라짐). `follow`에서 이전 경로가 있고 새 경로와 다르면 `{kind: 'followed', reason: 'renamed'}`, `how === 'path'`이고 창이 바뀌면 `reason: 'reopened'`; `from`·`previous`(따라가기 전 `name`·`path`·`instance`·`documentId`)는 첫 알림의 것을 유지하고 `to`만 바꾼다. Link의 저장 알림은 `{kind: 'stored'}`. `GET …/links`의 행은 `notice?: {kind, reason?, from?, to?}`와 `cleanup?: {kind: 'merge', into, intoName} | {kind: 'empty'}`를 더한다. `cleanup`은 열려 있지 않은 호스트 행에만: 같은 창(`instance`+`documentId`)의 다른 행이 지금 연결 상태면 `merge`, 아니면 그 행의 요청(`linkRequests`)이 없을 때 `empty`.
- **`POST …/links/:l/split`:** 그 행의 `followed` 알림이 있을 때만(없으면 `LINK_NOTICE_GONE` 409, 화면은 그 행의 알림을 지우고 목록을 다시 읽는다). 지금 이름·경로·창으로 새 행을 만들고, 이전 행은 `previous`의 이름·경로·창으로 되돌린다(이전 창이 지금 창과 같으면 `closed:<uuid>`). 그 창 문서에 `setLinkId`로 새 ID를 쓰고 응답 201은 새 행과 `stored: boolean`(쓰기 성공 여부).
- **`POST …/links/:l/merge {into}`:** 같은 호스트의 다른 호스트 행으로만(파일 항목·자기 자신은 `INVALID_INPUT`). 그 행의 요청이 대기·실행 중이면 `PROJECT_BUSY`. 한 트랜잭션에서 `workspace_requests.input`의 `$.linkId`를 `json_set`으로 바꾸고 `jig_reads`·`jig_bakes`의 `linkId`를 바꾸고, `conversations.targets`(연결 ID 배열)에서 그 행을 대상 행으로 바꿔(중복 제거) 대화의 대상 파일을 잇게 한 뒤 행을 지운다. 옮긴 요청은 `Workspace.forget`으로 `list`의 해석 캐시(상태·저장 크기 키)에서 뺀다(UUID끼리 바꾸면 크기가 같아 캐시가 그대로 남기 때문). 응답 `{link, moved}`.
- **`POST …/links/:l/dismiss`:** 알림을 지운다.

플러그인은 사용자 권한으로 `%LOCALAPPDATA%/VIDE/launch.json`의 실행 주소(127.0.0.1)와 실행 토큰으로 `/api/v1/session`에 세션을 만든 뒤(Origin 헤더 포함) 프로젝트 목록 조회·Link를 호출한다. 호출은 호스트 UI 스레드 밖에서 하며, VIDE는 Link 응답을 바로 돌려주고 첫 Sync는 화면(연결 목록 폴링)이 수행한다(T-084부터는 엔진의 `SyncScheduler`, 아래 「엔진 주관 Sync(T-084)」). VIDE가 연 작업 사본 창(`/requests/:id/open`)도 같은 연결로 등록하며, 그 창은 열림 여부만 확인한다(자동 갱신 없음, ⟳로 Sync). 엔진이 플러그인 문서에 다시 요청하는 동안 플러그인이 UI 스레드에서 기다리지 않는다.

화면은 보이기 연결마다 그 연결의 표시 결과(마지막 Sync 또는 사용자가 연 작업 사본 결과)를 레이어로 두고 하나의 장면으로 합친다. 여러 레이어일 때 장면·객체 ID는 `레이어키::원래ID`로 구분하고 객체의 `sourceId`·`revision`(기준 요청)으로 핀·검사를 원래 기준에 되돌린다. Live Sync 변경분은 해당 레이어에만 합쳐 증분 갱신한다.

#### 도면 xref 관계(T-200)

SPEC-01.11의 11. 원본 DWG는 `copyFile`로 `<데이터 폴더>/xref-work/<8자리 무작위>/`에 복사하고 그 작업이 끝나면 폴더째 지운다. ZWCAD는 약 250자보다 긴 `/b` 스크립트 경로를 찾지 못하므로 작업 폴더와 실행별 하위 폴더(`r<8자리>`) 이름을 짧게 둔다. 사본은 엔진이 띄운 숨은 ZWCAD 2023(`launchOwnedHost`, `/b` 스크립트로 worker DLL `NETLOAD` 뒤 명령 실행)이 사이드 DB(`ReadDwgFile … OpenForReadAndAllShare`)로 읽고, 엔진은 그 프로세스만 끈다(`hosts/zwcad/xref-dwg.ts`의 `zwcadXrefReader`).

- **worker 명령 `VIDEXREFGRAPH`(`hosts/zwcad/worker/XrefGraph.cs`):** 환경 변수 `VIDE_XREF_MANIFEST`(`id<TAB>사본 경로` 줄), `VIDE_XREF_OUT`(JSON Lines, 끝나면 `<out>.done`), `VIDE_XREF_MODE`. `graph`는 도면마다 `{id, ms, error, units, scale, unitsAssumed, xrefs: [{name, path(저장된 그대로), overlay, status(XrefStatus)}], inserts: [{name, handle, space: model|paper|block, layout, block, nested, position, rotation, scale, transform(BlockTransform, 행 우선 16)}]}`. `display`는 연결 Sync와 같은 표시 읽기(`AttachedDisplay.Page`, 연결 DLL의 소스를 worker 프로젝트가 함께 컴파일)로 모형 공간 전체의 `{objects, scene, displayCoverage, displayWarnings}`를 `<out 폴더>/<id>.json`에 쓰고 줄에는 `file`을 둔다. INSUNITS가 없으면 사본의 메모리 DB에서만 mm로 두고 `unitsAssumed: true`. 시험용 `VIDEXREFFIXTURE`는 `VIDE_XREF_FIXTURE` 폴더에 합성 도면만 만든다.
- **그래프(`src/core/xref-graph.ts`):** 노드는 원본 경로(대소문자 무시 키), 간선은 xref 블록 하나. 경로 해석은 원본 상위 도면의 폴더 기준(`resolveXref`: 절대 → 상대 → 같은 폴더의 파일 이름). 순환은 깊이 우선 탐색에서 스택에 있는 도면으로 가는 간선, 중복은 한 상위 도면에서 같은 파일로 가는 두 번째 이후 간선. `placementsOf(root)`는 모형 공간의 첫 삽입만 쓰고, 오버레이는 깊이 0에서만, 각 도면은 한 번. 배치 행렬은 `P_child = P_parent · S(상위 m/단위) · BlockTransform · S(1/하위 m/단위)`(표시 좌표는 m).
- **저장(`src/core/xref-store.ts`):** 프로젝트 DB에 처음 쓸 때 만드는 파생 표 `xref_files(projectId, path, size, mtime, sha256, readAt, inFolders, data)`와 `xref_placements(projectId, linkId, rootPath, matrix)`. 버전 스키마에 넣지 않으며(이전 VIDE는 무시) [다시 읽기]·[모델에 반영]이 다시 만든다. 하나의 DB를 나눌 때(`project-split.ts`)는 복사하지 않는 `derivedTables`다.
- **작업(`src/server/xref.ts` `XrefService`):** 프로젝트마다 작업 하나(`PROJECT_BUSY`), 상태는 메모리. [다시 읽기]는 폴더를 걸어(`.git`·`node_modules`·`.vide`·`$recycle.bin`과 SPEC-01.13 4의 금지 위치 제외, 최대 3,000개) 크기·수정 시각이 바뀐 도면만 읽고, 해석된 폴더 밖 도면을 최대 세 번 더 읽는다. [모델에 반영]은 `DocumentLinks.pathLink(projectId, 'zwcad', path)`(같은 경로의 호스트 행이 있으면 그 행, 아니면 `instance = 'file:' + 소문자 경로`의 파일 행)로 연결을 만들고 배치를 쓴 뒤, 파일 행 가운데 사본 sha256이 마지막 성공 Sync의 `sourceHash`와 다른 것만 `display`로 읽어 요청(`source: 'file'`, `linkId`, 결과 `displayOnly`·`referenceOnly`·`sourceHash`)으로 남긴다.
- **표시:** `GET …/links`의 행에 `placement?: number[16]`을 붙인다. 화면(`showLayers`)은 그 연결의 장면 항목에 `placement`를 실어 보내고, 뷰포트는 메시(블록 인스턴스 포함)의 행렬 앞에 곱한다(`matrixAutoUpdate = false`). 묶음 그리기는 `matrixWorld`를 따르므로 그대로다. 배치는 표시 전용이며 객체 행·측정·호스트 호출의 좌표는 그 파일 자체의 것이다.
- **경로·오류:** `GET …/xref` → `{state: idle|reading|applying|done|failed, done, total, error, readAt, roots(트리), standalone, unread, applied: {root, links, read, failed}}`. `POST …/xref/read`·`…/apply`는 작업을 시작하고 상태를 바로 돌려준다. 프로젝트 폴더가 없으면 `NO_PROJECT_FOLDER`, ZWCAD·worker가 없으면 `NO_ZWCAD`(409), 루트가 그래프에 없으면 `NOT_FOUND`, 원격 세션은 `FORBIDDEN`.

### 엔진 주관 Sync(T-084)

SPEC-01.11의 10을 구현하는 물리 계약이다(PLAN-27 2단계). 저장은 §5 「Sync 표시 형상의 객체 단위 저장(T-083)」을 쓴다. 2026-10-02 사용자 확인: VIDE 창이 하나도 없어도 엔진이 Live 파일을 Sync하고, ⟳·지금 Sync·플러그인 Sync는 진행 중인 자동 Sync에 합류하지 않고 새로 읽으며, 편집 중 실패는 30초까지 다시 하고(행에 '변경 중 · 곧 다시 Sync'), 초안 보류는 화면의 5초 임대로 한다.

- **`SyncScheduler`(`src/server/sync-scheduler.ts`, 새):** 연결된 열린 문서가 하나라도 있으면 1초마다 열린 문서 목록(Rhino `editors.list`, ZWCAD `attached.list`)을 읽고 `matchOpenDocuments`로 연결 행에 맞춘다. 문서 키 `[projectId, host, instance, documentId]`마다 `{seenGeneration, state, retryAt, attempts}`를 메모리에 둔다. 무엇을 할지는 지금 `src/ui/app/links-sync.ts`의 `pollLinks`(첫 Sync, `generation` 증가, 다시 연 Live 파일)와 같은 규칙으로 정하고, 그 연결의 마지막 Sync가 Rhino 표시 Sync면 `LiveSync.run`, 아니면 전체 Sync를 한다. 요청 ID는 엔진이 만든다.
- **전체 Sync 함수:** `server.ts`의 `POST …/capture` 본문(1204~1292행)을 `runDocumentSync(projectId, target, {linkId, fresh})`로 빼서 스케줄러와 `POST …/capture`(⟳·지금 Sync, `fresh: true`)가 같은 `documentSyncs` 합치기 키로 부른다. Live Sync도 같은 키의 실행 중 전체 Sync가 있으면 그것을 기다린 뒤 판단한다.
- **보류:** 스케줄러가 판단한다. ① 그 연결의 요청이 대기·실행 중이고 그 요청의 `baseRequestId`·`linkedTargets[].baseRequestId`·핀 기준이 이 연결의 Sync이거나, ② `Workspace.holdWrite`의 짧은 쓰기·바로 적용 실행이 그 문서에 있으면 보류한다. ③ 화면 초안은 `GET …/links?page=<pageId>&hold=<linkId,…>`로 알린다. 보류 표시는 페이지별 임대이며 5초 동안 같은 `page`의 조회가 없으면 풀린다. 보류가 풀리면 쌓인 변경(AI 편집 결과 포함, SPEC-02.16)을 Sync 한 번으로 반영한다.
- **재시도:** `SOURCE_CHANGED`·`HOST_BUSY`·`PROJECT_BUSY`·`WORKSPACE_CAPACITY`는 실패로 저장하지 않고 1·2·4·8초 뒤(최대 30초) 다시 한다. 그 사이 `generation`이 또 바뀌면 다시 0부터 센다. 30초가 지나면 `state: 'waiting'`으로 두고 다음 변경이나 ⟳를 기다린다.
- **알림:** `GET …/links` 행에 `sync: {state: 'idle'|'syncing'|'held'|'waiting'|'failed', code?, at}`과 `display: {requestId, revision}`(마지막 Sync와 그 목록 revision)를 더한다. 화면은 지금처럼 이 조회를 1.5초마다 하고, `requestId`가 같고 `revision`만 늘면 `GET …/requests/:r/delta?since=`로 변경분만, `requestId`가 바뀌면 `delta?base=<이전 ID>&since=` 또는 전체(VGT1)를 받는다. 화면은 `POST …/live-sync`와 자동 `POST …/capture`를 부르지 않는다(⟳만 `capture`에 `fresh: true`).
- **기록:** `sync-scheduler {document, action: live|full|held|retry|wait, generation, ms}`.
- **사용자 Sync(T-123, 2026-10-06):** ⟳·지금 Sync·플러그인 Sync(`POST …/capture`, `fresh`)는 `runUserSync`(`src/server/document-sync.ts`)를 거친다. 그 문서의 기준(`LiveSync.basisOf`, 없으면 연결의 마지막 성공 Sync)이 Rhino 또는 ZWCAD(T-128) 표시 Sync이고 `sourceDocument.revision`이 있으면 `LiveSync.run`(같은 문서의 실행 중 전체 Sync가 끝난 뒤 그 revision 이후 변경만 호스트에 물음)을 하고, `resync`·재시도 대상 실패·기준 없음·이전 ZWCAD 플러그인·작업 사본이면 `runDocumentSync`로 전체를 새로 읽는다. 요청 본문 `full: true`(목록 행 메뉴의 '전체 다시 읽기', Shift+⟳)는 늘 전체를 읽는다. 엔진이 그 문서의 자동 Sync를 보류하고 있으면(`SyncScheduler.holds`: 화면의 초안 임대, 그 파일 기준 작업, 그 문서 쓰기) `LiveSync.run`에 `keep: true`와 `held`(화면들이 임대와 함께 알린 초안의 기준 Sync ID, `GET …/links?hold=&basis=`, `SyncScheduler.heldBases`)를 주어 변경을 기준 Sync의 목록 복사본에 쓴다(초안이 쓰는 기준은 그대로). 복사는 보류된 기준마다 한 번이고, 보류 중의 다음 ⟳는 그 복사본을 제자리에서 고친다(T-127). 화면은 새 복사본을 지금 보이는 Sync와 `delta?base=<그 ID>&since=`로 만들고, 제자리 변경은 곧바로 `delta?since=`로 받는다. Live Sync가 `retry` 중 `SOURCE_CHANGED`·`HOST_BUSY`로 답하면 0.3·0.8·1.5초 뒤 Live Sync를 다시 묻고(`LIVE_RETRY_MS`), 그래도 안 되면 전체를 읽는다. 성공하면(Live·전체) `SyncScheduler.userSynced`가 그 문서의 대기·실패 표시와 재시도를 지운다(Live Sync는 같은 ID를 고치므로 ID 비교로는 알 수 없다). 응답은 형상·객체 줄 없는 요청이고, Live로 끝나면 기준 Sync(또는 복사본)의 ID다. 기록 `user-sync {request, action: live|full, ms, attempts?}`.

### JIG 탭과 Sync jig

`src/jigs/catalog.ts`가 공식 jig 목록, `src/jigs/sync.ts`가 Sync jig 계산을 소유한다(SPEC-05.8). `GET /api/v1/jigs`는 목록, `POST /api/v1/projects/:id/jigs/sync`는 저장된 두 Sync 결과의 `scene`(Rhino `line`/`points`, CAD `segments`, 미터)로 계산해 관계·행(최대 5,000행과 `totalRows`)·레이어 대응·CAD 단위(`sourceUnits`)를 돌려준다. 관계는 Rhino→CAD `rotation`(라디안)·`translation`·`dz`이며, 방향 후보(주 방향 차)마다 길이 버킷이 같은 선분 쌍의 이동량을 투표하고 대응 쌍의 중앙값으로 다듬는다. 행의 `ends`는 CAD 좌표, `inRhino`는 역변환한 모델 좌표다.

AI 검토 요청은 `jig: { kind: 'sync-review', rows }`와 `sync-jig.json` 첨부로 만든다. 실행기는 이 요청에 호스트·기준 문서·모델 문맥을 붙이지 않고, 답의 `R숫자` 인용을 `rows`와 대조해 `jigCheck`를 결과에 남긴다. 반영 요청은 `jig: { kind: 'sync-apply', side }`와 `sync-edits.json`으로 만들며 그 쪽 Sync(`baseRequestId`)를 기준으로 하는 일반 AI 편집과 같은 경로를 쓴다: 열린 문서의 표시 Sync면 바로 적용(2026-09-30 ADR-022, §4 「바로 적용 경로」), 가져온 파일이면 작업 사본 경로다.

jig 플랫폼(패키지 형식 v3, 작업본, 출처별 실행기, `src/server/jig-routes.ts`의 jig 경로, jig 입력 읽기, 공식 틀과 데이터 블록으로 하는 Rhino에 만들기 `jig: { kind: 'jig-bake' }`, 스키마 v5)의 물리 계약은 [ARCH-03](ARCH-03-jig-runtime.md)이 소유한다. 이 절의 Sync jig·구조 jig 경로와 저장은 그대로 두며, `GET /api/v1/jigs`는 ARCH-03 §7에 따라 공식 목록에 설치된 jig 버전을 더한 등록부로 넓어진다.

### 현재 ZWCAD의 읽기 연결

`hosts/zwcad/connection/`은 설치된 ZWCAD 2023 SDK를 참조하는 .NET Framework 4.8 x64 DLL이다. 작업 사본 worker와 별도 어셈블리이지만, 열린 도면의 AI 코드 실행(아래, §6 「ZWCAD 열린 도면 수정」)을 위해 worker의 `SdkCompiler`와 컴파일러 어셈블리를 함께 설치한다. 외부 MCP 설치는 필요 없다. `VIDECADConnect`·`VIDECADDisconnect`·`VIDECADSync`·`VIDECADLiveSync`·`VIDECADPanel`과 WinForms PaletteSet을 제공한다. 패널은 활성 도면을 보여 주되 이미 연결된 다른 도면의 대상을 바꾸지 않는다. 배포본에는 연결 DLL만 포함하고 ZWCAD SDK DLL은 설치본에서 사용한다.

문서마다 인증된 loopback TCP 리스너를 만들고 `%LOCALAPPDATA%/VIDE/zwcad-connections/<sessionId>.json`에 기록한다. 시험은 `VIDE_ZWCAD_CONNECT_DIR`로 분리한다. public instance는 PID·시작 ticks·session UUID, public documentId는 1이다. native documentId는 session UUID로 고정한다. 제어기는 실행 경로·시작 시각·리스너 소유 PID를 대조한 뒤 메서드를 호출한다: 읽기 `attachedStatus`·`displayPage`·`selection`·`fingerprint`·`queryEntities`, 생성 코드 실행 `runCode{code, write}`(2026-09-29)와 바로 적용의 `direct-execute`·`direct-undo`(2026-09-30 ADR-022, §4 「바로 적용 경로」. `hosts/zwcad/connection/AttachedDocument.cs`, 서버 `ZwcadSdkExecution.runAttached`, `src/server/zwcad-sdk-execution.ts`). 생성 코드는 ZWCAD 명령(`_VIDEAIRUN`) 하나 안에서 실행해 Undo 묶음 하나가 된다. 문서 닫힘/Disconnect에서 이벤트와 리스너·기록을 폐기하며 사용자 프로세스를 종료하는 소유권은 만들지 않는다.

SDK 조회는 Idle의 주 스레드와 문서 잠금에서 수행한다. ObjectAppended/Modified/Erased가 revision을 올리고 Live Sync가 켜졌으면 1초 안정화 후 generation을 올린다. Sync는 generation을 즉시 올린다. 지문은 연결 session·revision·단위이며 전체 기하를 매번 해시하지 않는다. `displayPage`의 offset·next·total·revision과 객체/scene ID 대응, 전후 지문을 검사한다. 원본 Handle에 대응하는 최상위 객체 한 개에 블록 내부 선분을 묶고 미터 좌표의 `scene.segments`(xyz 끝점 쌍)를 `THREE.LineSegments`로 표시한다. 네이티브 블록·곡선은 수정하지 않는다. 이 표현의 웹 공유 게시 지원은 별도이며 아직 허용하지 않는다.

**ZWCAD Live Sync(T-128).** 연결 플러그인은 같은 이벤트(ObjectAppended/Modified/Erased/Unappended/Reappended)에서 바뀐 객체의 ObjectId와 그때의 revision을 남기고(`AttachedDocument.cs`), `attachedStatus`에 `liveChanges: true`를 싣는다. 엔진은 이 값이 있을 때만 전체 Sync 결과의 `sourceDocument`에 `revision`을 넣으므로, 이전 플러그인의 Sync는 Live 기준이 되지 않고 지금처럼 전체를 읽는다. 플러그인은 한 세션 안에서 같은 revision으로 처음부터 끝까지 이어 읽은 `displayPage`를 표시 상태(모형 공간 객체마다 보이는 줄인지, 아니면 생략 종류와 미지원 하위 객체 수)로 갖고, `displayChanges{since, cursor, revision?}`은 `since` 뒤에 바뀐 객체를 Handle 순으로 250개·좌표 200만 개까지 한 페이지에 `displayPage`와 같은 줄로 주고, 사라졌거나 더는 보이지 않는 객체는 `removed`(Handle)로 준다. 속성·폴리선 정점처럼 다른 객체에 속한 변경은 그 모형 공간 객체를 다시 읽는다. 마지막 페이지에는 표시 상태로 센 도면 전체의 `coverage`(total·displayed·omitted·omittedTypes·displayWarnings)를 싣는다. ZWCAD의 생략 객체는 줄이 없어 변경 페이지에서 셀 수 없으므로 엔진은 이 값을 그대로 쓴다(`LiveSync.apply`의 `displayCoverage`, 결과의 `displayWarnings`). 다른 객체의 표시를 바꾸는 변경(레이어, 배치가 아닌 블록 정의와 그 내용, 문자·치수 스타일, XCLIP 경계)이나 이 세션에 끝난 전체 읽기가 없으면 `RESYNC_REQUIRED`이고 엔진은 전체를 읽는다. 배치(도면 공간)·사전·뷰포트 변경과 치수의 익명 블록(`*D…`)은 무시한다. 엔진은 `displayChanges`를 모르는 이전 플러그인의 `UNSUPPORTED_METHOD`도 `RESYNC_REQUIRED`로 받는다. 자동 Sync(`SyncScheduler`)·⟳(`runUserSync`)·`LiveSync`는 Rhino와 같은 경로이며 연결이 ZWCAD 창이면 `ZwcadSdkExecution.liveSync`가 답한다(`server.ts`). ZWCAD는 지금처럼 표시·조회 범위만이며 편집 경로는 바뀌지 않는다.

CAD 표시 응답은 최대 128MiB 수신을 명시한다. 실제 도면의 722MB 단일 블록 응답과 시간 초과를 확인해, 플러그인은 객체 하나의 표시 좌표 수가 2,000,000개를 넘으면 직렬화 전에 `OversizedDisplay`로 제외한다. SDK 객체 읽기 예외도 `UnreadableObject`로 해당 객체만 기록한다. 페이지 누적 좌표가 같은 기준을 넘으면 그 객체까지 반환하고 `next`부터 이어 읽는다. 총 도면 객체 수를 잘라내는 한도는 아니다. 큰 블록의 공유 기하/인스턴싱 지원 전까지의 부분 표시이며 이 제외 수를 화면에 알린다.

이전 플러그인의 실제 SDK 조회 실패는 범위를 이분한다. 프레임 초과는 동일한 큰 블록을 매 이분 단계에서 재직렬화하지 않도록 그 범위를 개별 객체로 조회하고 단일 객체도 실패하면 위 누락 유형으로 기록한다. 인증·revision 변경·불명확 연결 오류는 재시도로 성공을 만들지 않는다. 표시되지 않은 객체는 원본에 남는다. 결과는 `displayOnly: true`, `verified: false`, `referenceOnly: true`다. 연결 도면의 표시 Sync(`sourceDocument.connection = attached-editor`)를 기준으로 한 AI 실행은 `runAttached`가 열린 도면에서 하고, 그 밖의 표시 전용 기준(연결 정보가 없는 이전 결과)만 `ZWCAD_ATTACHED_EDIT_UNAVAILABLE`로 공급자 호출 전에 거절한다. 가져온 DWG의 별도 CAD 편집 사본 경로는 유지한다.
