---
id: PLAN-01
title: 선행 프로젝트 조사와 구현 선택 근거
status: review
version: 0.4
updated: 2026-09-20
owner: agent:codex
related: [PLAN, DESIGN, SPEC-01, SPEC-02, SPEC-03, SPEC-04, SPEC-05, ADR-013]
---

# 선행 프로젝트 조사와 구현 선택 근거

## 1. 목적과 조사 수준

사용자는 Aside의 접을 수 있는 좌우 패널·구독 계정 연결·여러 모델을 이어 쓰는 경험과 Vino·FigCAD·논현동 규모검토·Speckle·food4Rhino AI 플러그인을 참고하도록 요청했다. 이 문서는 마스터 PLAN §3의 조사·대안 비교를 분리한 것이다. 제품 범위는 PRD, 동작은 SPEC, 화면 표현은 Design이 소유한다.

조사일은 2026-09-20이다. 아래에서 **문서 확인**, **코드 확인**, **VIDE 적용 판단**, **미검증**을 구분한다. 공개 소개·다운로드 수·기존 코드의 존재를 성공률이나 호환성 실증으로 취급하지 않는다. 이번에는 참고 프로젝트를 실행·변경하거나 코드를 복사하지 않았고 제품 의존성을 설치하지 않았다. 실제 채택은 §5의 작은 비교 시험과 해당 티켓에서 확정한다.

## 2. 사례별 확인과 적용 범위

### 2.1 Aside — 작업 공간과 계정 연결 경험

**문서 확인:** 공식 도움말은 사이드바 토글, 분할 탭, 현재 페이지를 첨부한 사이드 패널과 페이지별 초안 보존을 설명한다. 모델 설정은 자체 제공·구독·API 연결을 구분하고, 지원 구독의 OAuth 로그인과 사용량 표시를 안내한다. [브라우저 조작](https://docs.aside.com/help/browser-basics), [사이드 패널](https://docs.aside.com/help/side-panel), [AI 공급자 설정](https://docs.aside.com/help/ai).

**VIDE 적용 판단:** 중앙 모델을 유지하면서 좌측 탐색·우측 작업 패널을 독립적으로 접고 복귀시키는 경험을 채택한다. 현재 대상과 입력 문맥을 가까이 보여 주고 계정 연결과 모델 선택을 분리한다. 구체 표현은 Design §03에 둔다. Aside의 사이드바 단축키 Ctrl+S는 CAD 저장과 충돌하므로 그대로 복사하지 않는다.

**미검증:** 공개 도움말에서 내부 UI 프레임워크·토큰 저장 구현·공급자 간 문맥 이전 알고리즘은 확인되지 않았다. 사용자 관찰인 ‘부드러운 모델 전환’을 특정 내부 기술의 증거로 바꾸지 않는다. Aside의 인증 방식이 VIDE에도 그대로 허용된다고 가정하지 않고 §3의 공급자 공식 경로를 사용한다.

### 2.2 Vino — 공급자 어댑터와 검증된 변경

로컬 `C:/Users/user/Desktop/Vino`의 README·docs/architecture.md·ui/panel/package.json과 아래 코드를 읽었다. 공개 저장소는 [hongikarchi/Vino](https://github.com/hongikarchi/Vino)다. 로컬 작업본과 원격 HEAD가 같다고 검증한 것은 아니다.

**코드 확인:** `IAgentSessionClient`가 공급자 이벤트·시작·재개·중단을 추상화한다. Codex 클라이언트는 app-server의 thread/turn 요청을, Claude 클라이언트는 stream-json과 세션 재개를 사용한다. 패널 의존성은 React·TypeScript·Vite다. 아키텍처 문서는 broker의 대상/지문 검사·단일 쓰기·사후 확인을 설명한다. 이번에는 broker 전체 경로를 실행 검증하지 않았다.

**VIDE 적용 판단:** 공급자 이벤트를 제품 공통 이벤트로 정규화하고, 모델 응답과 원본 변경 성공을 분리하는 패턴을 참고한다. 다만 Vino의 Rhino 중심 세션/문서 수명, C# 호스트 프로세스 구조, 공급자별 고정 세션을 VIDE의 복수 호스트·문서 구조에 그대로 이식하지 않는다. 현재 Node 제어 계층을 대체할 근거는 없다.

추적 가능한 로컬 파일 SHA-256 앞 16자리:

| 파일 | 지문 |
|---|---|
| src/Vino.AgentHost/Codex/IAgentSessionClient.cs | 5e8a0b6247f5f3b9 |
| src/Vino.AgentHost/Codex/CodexAppServerClient.cs | 334cb47a2984ac18 |
| src/Vino.AgentHost/Claude/ClaudeCliSessionClient.cs | 100019989182f9cd |

### 2.3 FigCAD — 뷰어와 입력 장치의 분리

대상은 사용자 GitHub의 [LFTH_Figcad](https://github.com/hongikarchi/LFTH_Figcad)이며, 조사 기준 커밋은 `73a0d0457f8aa8f21fc910f4081c89280472fe41`다.

**코드 확인:** [InputManager.ts](https://github.com/hongikarchi/LFTH_Figcad/blob/73a0d0457f8aa8f21fc910f4081c89280472fe41/apps/web/src/input/InputManager.ts)는 포인터 입력을 도구/카메라로 분리하고 pointercancel을 취소로 처리한다. [gestures.ts](https://github.com/hongikarchi/LFTH_Figcad/blob/73a0d0457f8aa8f21fc910f4081c89280472fe41/apps/web/src/input/gestures.ts)는 터치 상태와 펜 전환 시 초기화를 관리한다. [SceneManager.ts](https://github.com/hongikarchi/LFTH_Figcad/blob/73a0d0457f8aa8f21fc910f4081c89280472fe41/apps/web/src/engine/SceneManager.ts)는 객체 ID별 표시 항목과 파생 형상 캐시를 사용한다. [package.json](https://github.com/hongikarchi/LFTH_Figcad/blob/73a0d0457f8aa8f21fc910f4081c89280472fe41/apps/web/package.json)에는 React·TypeScript·Three.js·Yjs 등이 있다.

**VIDE 적용 판단:** 입력 제어기·카메라·도구·렌더링 수명 분리, 객체 참조와 표시 형상의 대응, 취소 시 미완료 선을 확정하지 않는 패턴을 참고한다. 읽은 코드에는 문서 전체에 등록하는 이벤트도 있으므로 직접 재사용 전 해제·중복 등록·재마운트 동작을 점검한다. 기존 프로젝트의 완성도나 iPad 실기기 통과는 이번 조사로 보증하지 않는다.

**현재 채택하지 않는 것:** FigCAD의 Yjs 기반 모델 공동편집과 파라미터 정본을 그대로 도입하지 않는다. VIDE는 원본 CAD 문서와 게시본의 권한이 다르고 첫 웹은 검토 경로다. 건축 객체의 전체 자체 편집 커널도 이번 참고를 이유로 추가하지 않는다.

### 2.4 논현동 규모검토 — 객체·수량·근거·발표의 연결

로컬 `C:/Users/user/Desktop/논현동 164 규모검토`의 Architecture.md, 검토엔진 package.json, `src/templates/presentation.js`, `analysis-evidence.js`, `scripts/bridge_verify.js` 및 모델 템플릿의 관련 부분을 확인했다. 프로젝트 원자료·모델·계산값은 VIDE 저장소에 복사하지 않는다.

**확인:** Architecture.md는 Rhino 마스터·분석 정의·웹 전달본을 구분하고 명시적 파일 동기화와 미완료 역방향 연결을 설명한다. bridge_verify에는 BuildingId와 웹/Rhino 속성을 대조하는 코드가 있다. 검토엔진은 Node·rhino3dm·earcut·polygon-clipping을 사용한다. 모델 템플릿은 현재 2,284행이어서 통째 재사용하면 화면·프로젝트 규칙이 함께 들어올 위험이 있다.

**VIDE 적용 판단:** 객체 선택↔분석값↔출처↔장면의 연결을 SPEC-03 구현에 참고한다. 호스트 추출에 빠진 범위를 오래된 표시 캐시로 가리지 않는 검증을 적용한다. 프로젝트 전용 법규·경제성 계산·대안 생성은 범용 기능으로 간주하지 않는다. 실제 수치 대신 합성 시험으로 조인·단위·누락을 먼저 검사한다.

### 2.5 Speckle — AEC 뷰어와 교환 계층

**문서 확인:** Viewer는 loader/converter를 통해 입력을 WorldTree와 표시 형상으로 변환하고, 확장과 객체 속성 조회·수명 관리 API를 제공한다. [Loaders](https://docs.speckle.systems/developers/viewer/loaders), [Viewer API](https://docs.speckle.systems/developers/viewer/viewer-api).

**VIDE 적용 판단:** Three.js 직접 구성과 Speckle Viewer를 T-015의 두 후보로 비교한다. 전자는 공간 입력·제한된 호스트 형상에 맞춘 단순 경계, 후자는 객체 탐색·AEC 표시 기능 활용을 기대한다. Speckle을 쓰더라도 로컬 경로에 외부 서버·계정을 필수로 만드는 구성을 전제하지 않는다. 실제 로컬 자산 loader와 후보 갱신·선택 대응이 시험 대상이다.

전체 Speckle 서버·권한·버전 체계를 그대로 복제하지 않는다. [저장소 LICENSE](https://github.com/specklesystems/speckle-server/blob/main/LICENSE)는 일부 서버 디렉터리의 별도 조건을 구분한다. 코드/패키지 채택 때 대상 버전과 해당 경로의 라이선스·고지·종속성을 확인한다. 이번에는 패키지 설치나 자체 호스팅 가능성 검수를 하지 않았다.

### 2.6 food4Rhino와 Rhino AI 생태계

| 대상·출처 | 확인된 공개 설명 | VIDE에 참고할 것 / 이번 조사 한계 |
|---|---|---|
| [RhinoMCP 등록 페이지](https://www.food4rhino.com/en/app/rhinomcp), [제작자 저장소](https://github.com/jingcheng-chen/rhinomcp) | Python MCP 서버→TCP→C# 플러그인, 메인 스레드 실행, JSON Schema. README는 인증 없는 loopback과 임의 명령/코드 실행도 명시 | 도구 분류·프로토콜·실행 문맥을 참고. 인증·대상 고정·후보 적용을 보장하는 VIDE 경계의 대체물로 바로 연결하지 않음 |
| [Raven 제작자 문서](https://www.raven.build/en/help/context-profiles) | 지침·설명·재사용 GH 정의를 context profile로 묶음 | 신뢰 확장의 설명/입출력과 재사용 가능한 작업 지식. .ghx 전체 기능·클라우드 서비스를 MVP 필수로 늘리지 않음 |
| [Ant의 McNeel 소개](https://blog.fr.rhino3d.com/2026/02/ant-votre-nouvel-assistant-dia-pour.html) | 선택한 컴포넌트·배선을 구조화해 AI에 전달하고 GH 작업을 수행한다고 설명 | 현재 작업을 구조화해 전달하는 문맥 구성. 소개 문서 확인이며 내부 구현·성공률은 미검증 |
| [McNeel RhinoAI](https://github.com/mcneel/RhinoAI), [공식 프로젝트 문서](https://mcneel.github.io/RhinoAI/) | Rhino에서 AI가 생성·편집하는 MCP 프로젝트 | 제작사 측 도구 구조도 비교. 조사 당시 기본 브랜치는 rhino-9.x이므로 설치 Rhino 8.34 지원을 추정하지 않음 |

Raven의 food4Rhino 상세 페이지는 도구에서 405로 열리지 않아 제작자 문서와 McNeel 소개로 보완했다. 전체 플러그인 시장의 전수 조사나 설치 검증은 아니며, 실제 네이티브 편집·구조화 문맥·재사용 패턴과 가까운 대상을 선별했다.

## 3. 구독 연결과 모델 연속성의 구현 방향

### 3.1 계정은 공식 실행 도구가 소유

**OpenAI 문서 확인:** Codex App Server는 ChatGPT managed 로그인, 계정 조회·로그인 완료 알림·사용 한도 조회를 제공한다. [공식 App Server 문서](https://learn.chatgpt.com/docs/app-server).

**채택 후보:** 현재 `codex exec` 기반 어댑터는 보존하고 T-004에서 app-server를 비교한다. app-server는 후속 비교 후보로만 남긴다. 첫 통합은 ADR-013의 단발 호출이며, 전환에는 설치 버전의 스키마·도구 차단·복구 검증과 ADR 변경이 필요하다. VIDE가 OAuth 토큰을 추출해 별도 API에 넣는 방식을 사용하지 않는다.

**Anthropic 문서 확인:** 공식 지침은 제품에서 수정하지 않은 Claude Code를 실행하는 조건과, 사용자가 그 도구에서 자기 계정으로 로그인하는 경로를 설명한다. 자체 앱이 Claude.ai 자격 증명을 수집하거나 대신 요청을 중계하는 방식과 구분한다. [공식 이용·인증 지침](https://code.claude.com/docs/en/legal-and-compliance). 프로그램 실행은 [공식 headless 문서](https://code.claude.com/docs/en/headless)를 확인했다.

**적용 판단:** Claude는 공식 바이너리의 로그인·단발 호출·스트림을 사용하고 지원 인증 방식을 임의 제거하지 않는다. VIDE의 기본 연결은 사용자 지시대로 구독 경로를 우선하되 한도와 과금은 해당 계정 조건에 따른다. 기술 응답 성공과 배포 조건 충족을 구분하고 OQ-09/배포 티켓에서 다시 확인한다. Aside의 로그인 화면을 보고 비공개 인증 구현을 추정하지 않는다.

### 3.2 공급자와 독립된 작업 기록

다음은 Aside 내부 구현 설명이 아니라, 기존 SPEC·ADR-013을 구현하기 위한 **VIDE 설계 방향**이다.

- 제품 Task/Run·입력 revision·대상·확인된 결과는 로컬 기록에 보존한다. 공급자 세션 ID는 그 기록에 연결된 실행 정보다.
- 현재는 같은 공급자의 재개도 저장된 제품 문맥에서 새 호출로 시작한다. 세션 재사용은 후속 후보이며 다른 공급자로의 인계와 구분한다. 모델/공급자 전환은 명시적 선택을 유지하며 자동 대체·자동 API 과금 전환은 하지 않는다.
- 공급자가 바뀌면 허용된 원문/핀/선·현재 조건·완료 결과·남은 작업·도구 능력의 문맥 묶음을 구성한다. 과거 전체 대화를 무조건 복제하거나 비공개 추론을 옮기는 경로를 전제하지 않는다.
- 이미지·도구·구조화 출력·취소·한도 관측의 지원 차이는 어댑터 능력으로 처리한다. 빠진 입력이나 요약 손실을 숨겨 연속성을 가장하지 않는다.
- 진행 중 호출·쓰기 결과가 미확정이면 기존 SPEC의 중단/불명확 계약을 먼저 따른다. 모델을 바꿨다는 이유로 같은 호스트 쓰기를 다시 보내지 않는다.

세부 스키마는 마스터 PLAN §4, 사용자 동작의 추가/변경이 필요하면 SPEC-02·05가 소유한다. 공급자 간 인계 품질을 ‘무손실’로 약속하지 않고 §5의 동일 과업으로 검증한다.

## 4. 기술 선택 비교와 현재 결론

| 책임 | 우선 검토 방향 | 비교/유지할 대안 | 결정 시점 |
|---|---|---|---|
| 프런트 shell·패널 | 기존 ESM/CSS 유지. 책임별 모듈과 상태/gateway 분리 | 현재 ESM/CSS 모듈 유지. 기존 코어·API 재작성 없음 | 2026-09-20 유지 결정; 프런트 승인 후 재선정하지 않음 |
| 뷰어·공간 입력 | Three.js 직접 구성 + 별도 입력 제어기 | Speckle Viewer + 로컬 loader/확장 | T-015의 좌표·선택·후보·수명 검증 |
| 로컬 기록·실행 제어 | 기존 Node/SQLite와 application/core 경계 유지 | Vino C# 전체 이식은 현재 근거 부족 | T-013에서 기존 데이터 보존·계약 검증 |
| AI 연결 | 공급자 어댑터 + 제품 문맥 기록; Codex app-server 비교, Claude 공식 CLI | 기존 codex exec 경로 유지 가능 | T-004·018 |
| 호스트 | 설치본별 C# 어댑터, 대상 고정·결과 재조회 | MCP 프로젝트의 부분 패턴만 검토 | T-003·005·006 |
| 데이터/웹 검토 | 객체 참조·출처·불변 게시본과 의견 경계 유지 | Speckle 전체 플랫폼·FigCAD CRDT는 현재 선행 의존성으로 채택하지 않음 | T-007·009·017 |

라이브러리 버전은 참고 프로젝트의 숫자를 복사하지 않고 채택 시 호환성 확인 후 잠금 파일에 고정한다. 연구 결과는 현재 코드를 모두 폐기할 근거가 아니며, 기존 구현이 있다는 이유로 이후 UI 스택을 무조건 고정할 근거도 아니다.

## 5. 채택 전에 수행할 작은 비교와 종료 조건

새 개발 티켓을 중복 발급하지 않고 마스터의 기존 티켓에 아래 조사 결과를 연결한다. 이번 문서 조사에서 아래 실험을 실행한 것은 아니다.

| 티켓 | 비교 시험 | 통과/선택 근거 |
|---|---|---|
| T-014·016 | 선택한 ESM에서 좌/우 패널·초안·작업 카드 검증 | 초안·포커스·뷰어 유지, 이벤트 해제, 기능별 변경 범위, 빌드/배포 추가 비용. 현재 CSP(script/style/connect self), Host/Origin, 정적 MIME·경로 검증. inline script/style·eval·CDN·별도 HMR origin을 요구하지 않음 |
| T-015 | 동일한 호스트 추출 자료를 Three.js/Speckle로 표시 | 문서/객체 참조, 단위·축·작업평면, 선/메시 선택, 후보 교체, 여러 번 로드/해제, 펜 취소. 입력 규모·버전·시간·메모리 관측 기록; 성능 합격선은 기존 OQ를 따름 |
| T-004·018 | 동일 작업을 Codex/Claude에서 시작·중단·재개하고 명시적으로 공급자 변경 | 계정 상태, 전송 범위, 지원 입력 차이, 기존 지시 보존, 한도 오류, 중복 쓰기 없음. 실제 네이티브 결과와 비용/지연을 구분 기록 |
| T-007·017 | 합성 객체↔표↔출처↔게시본 연결 | 같은 nativeId의 다른 문서, 누락 추출, 단위 변경, 오래된 결과가 현재 값으로 보이지 않음 |
| T-003·005·006 | 참고 어댑터 패턴을 설치 호스트의 작은 동작에 적용 | 문서 대상 고정, 요구 실행 문맥, 후보 격리·직접 수정 보존·저장/재열기. 참조 프로젝트 실행 성공을 VIDE 통과로 대체하지 않음 |

각 비교는 동일 과업과 판단표를 먼저 정하고, 필요한 조건을 충족하면 선택 근거·버린 대안·미시험을 PLAN/중요 ADR에 남겨 종료한다. 증거가 부족하면 막힌 조건과 대체 경로를 적고 독립 작업을 계속한다. 참고 프로젝트 전체를 복제하거나 기술 이름을 늘리는 일을 연구 완료 기준으로 삼지 않는다.

직접 코드 채택 시 원본 경로·커밋·라이선스/고지·적용 범위·회귀 검증을 기록한다. FigCAD는 이번 조회에서 라이선스 선언을 확인하지 못했으므로 사용자 소유 코드와 포함된 외부 코드의 권리를 구분해 확인한다. 비공개 로컬 자료·자격 증명은 공개 저장소에 옮기지 않는다.


## 6. 이번 구현 기준

ESM 유지 결정은 기존 코드와 같은 보안·배포 경로, 신규 의존성 없이 검수 가능하다는 판단이다. React와 성능/유지보수 비교를 실행한 결과로 포장하지 않는다. 복잡도 증거로 변경이 필요하면 ADR과 영향 화면의 재검수를 거친다.

AI 첫 통합은 ADR-013의 도구 없는 단발 CLI 호출을 VIDE가 반복하는 기준으로 고정한다. app-server·세션 재개는 후속 비교 후보이며 현재 채택이 아니다. UI 승인 이후의 연결 방식 변경도 사용자 경험과 보안 계약을 유지해야 한다.


## 7. 입력·3D 구현 참고의 추가 확인

사용자가 제공한 Aside 화면의 우측 하단 작성기/문맥 칩/간결한 제어 배치를 참고했다. 내부 구현을 추정하지 않았다. 로컬 Vino의 `ui/panel/src/components/ChatPane.tsx`에서 composer-rail, 선택 핀·첨부와 초안 보존, 모델 목록에 따른 effort, permission 선택을 확인했다. `ui/panel/src/api/mock.ts`의 모델은 예시 목록이므로 실제 사용 가능 모델의 근거로 쓰지 않는다.

FigCAD의 조사 기준 커밋에서 [SceneManager](https://github.com/hongikarchi/LFTH_Figcad/blob/73a0d0457f8aa8f21fc910f4081c89280472fe41/apps/web/src/engine/SceneManager.ts)의 객체별 mesh/edge와 dispose, [InputManager](https://github.com/hongikarchi/LFTH_Figcad/blob/73a0d0457f8aa8f21fc910f4081c89280472fe41/apps/web/src/input/InputManager.ts)의 카메라/도구 입력 분리·pointercancel 처리를 다시 읽었다. 직접 복제/이식 없이 같은 책임 분리를 적용했다. 기본 3D 렌더링은 [Three.js](https://threejs.org/docs/)의 PerspectiveCamera/WebGLRenderer/Raycaster와 OrbitControls로 구현한다. FigCAD 전체 기능의 재현이나 호환성 검증을 뜻하지 않는다.


## 8. 논현동 model.html 뷰포트 추가 참고

사용자가 지정한 로컬 `C:/Users/user/Desktop/논현동 164 규모검토/50_보고서작업/산출물/model.html`의 카메라/프레이밍/레이아웃 코드를 읽었다. 2236~2237행의 원근/정투영 카메라 분리, 3686행 fitTo의 화면 축별 범위 맞춤, 3736행 setOrtho, 4193행 setCam의 종횡비별 정투영 행렬 갱신, 캔버스 CSS 크기와 버퍼 크기 분리를 참고했다. 내장 모델 JSON·프로젝트 수치·보고서 내용을 복사하거나 실행하지 않았다. 여기서는 카메라 전환·전체 보기·리사이즈 원리만 새 구현에 반영했다. 보고서용 저장 뷰·분석·발표 오버레이는 이번 범위에 추가하지 않았다.
