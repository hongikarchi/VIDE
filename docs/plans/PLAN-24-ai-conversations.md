---
id: PLAN-24
title: AI 대화 세션·동시 진행·말로 하는 경로 판정 1차
status: review
version: 0.4
updated: 2026-10-01
owner: agent:claude
related: [PLAN, PLAN-22, PLAN-23, PLAN-25, PLAN-26, PLAN-02, PLAN-05, PLAN-08, PLAN-19, FR-25, FR-24, FR-18, FR-10, FR-11, FR-12, AC-46, AC-47, AC-48, AC-38, SPEC-02, SPEC-07, ARCH-01, ARCH-03, ADR-021, ADR-014, ADR-022, ADR-025, ADR-026, RESEARCH-10, RESEARCH-11]
---

# AI 대화 세션·동시 진행·말로 하는 경로 판정 1차

## 목적과 기준

사용자 결정 F1을 실행한다. 모든 대화는 목적별 세션이고, 대화를 시작할 때 Jev가 공급자·모델을 정해 그 대화 끝까지 고정한다. 모델 편집·CAD 편집·법규 질문 같은 여러 대화가 동시에 진행된다. 화면·설정값처럼 AI가 필요 없는 말은 AI를 부르지 않는다.

- 제품 범위: FR-25(대화 세션·동시 진행·말로 하는 경로 판정), FR-18(전송 고지·끄기). 수용은 PRD AC-46·47·48
- 동작: [SPEC-02](../specs/SPEC-02-execution-candidates.md) .9(동시 접수, 결정 A3)·.17(경로와 대화의 문맥)·.19(목적별 대화와 세션: 고정, 한 턴의 안전장치, 대기열과 개입, 인계, 질문 카드, 확인 등급)
- 물리 계약: [ARCH-01](../architecture/ARCH-01-system.md) §2(CLI 인자·공급자 기록 관리)·§3(턴마다 주는 도구 목록), [ARCH-03](../architecture/ARCH-03-jig-runtime.md) §10(대화·공급자 세션·원장 표)
- 결정: [ADR-021](../decisions/ADR-021-conversation-sessions.md)(결정 A2, 구현 전 SPIKE 0·①~⑨). 결정 A3(동시 접수), A5(CLI 버전 점검), A10(제품 Jev를 판정 실행으로 확대)은 SPEC-02.9·.17과 ADR-021이 반영했다. ADR-014의 AI 편집 경로는 그대로다
- 이전 계획과의 관계:
  - [PLAN-02](PLAN-02-agent-host-versioning.md) §2의 '새 에이전트 세션'은 ADR-021에 따라 턴 단위로 읽는다.
  - [PLAN-19](PLAN-19-request-routing.md)의 경로 판정을 넓힌다.
  - [PLAN-05](PLAN-05-decision-layer-evaluation.md) §7의 제품 Jev 범위는 결정 A10으로 넓어진다.
- 근거·대안: [RESEARCH-10](../research/RESEARCH-10-vide-restructure.md) §1·§8

## 범위 밖(1차)

- SPEC-02.17·.19에 적힌 것 밖의 앱 조작, AI가 jig를 부르는 방식의 확대(결정 B7 보류)
- 원격 세션에서 허용하는 확인 등급의 범위 변경(결정 B4 보류). 제안 카드도 현행 원격 차단을 그대로 받는다
- 호스트 패널의 대화 선택(2차, SCR-12 담당과 조율), 턴 중간 지시(ADR-021 결정 6), Jev 중계(결정 C4 보류)
- 공급자 CLI의 개인 설정·전역 MCP·플러그인은 계속 끈다

## 작업 묶음 → 티켓

| RESEARCH-10 묶음 | 티켓 | 마일스톤 |
|---|---|---|
| WP-14a 경로·값 추출·단발 입력 제안·전송 고지 | T-049 | M1 |
| WP-01 CLI 점검·캐시 토큰·세션 SPIKE | T-059 | M5(바로 시작 가능) |
| WP-02 접수 규칙 | T-060 | M5(바로 시작 가능) |
| WP-02 대화 스레드·세션 실행 | T-061 | M5 |
| WP-14b 대화 도구·질문 카드 | T-062 | M5 |

플러그인 재빌드가 필요한 티켓은 없다. 설치본 반영은 사용자가 요청할 때 묶음 릴리스로 한다. 이 계획의 표는 PLAN-22 T-045(스키마 v5)가 함께 넣는다.

## 티켓

### T-049 · 경로 판정 확장·값 추출·단발 입력 제안·전송 고지 {#t-049}

- **목적/기준:** "경간 11로", "작은보 조금 더 촘촘히"를 AI 없이 설정값 변경으로 처리한다. "구조 검토하고 싶어"는 가장 비싼 AI 실행 대신 jig 카드로 보낸다. FR-25, FR-18, SPEC-02.17의 1~4, SPEC-02.19의 7(확인 등급), 결정 A10, AC-48.
- **변경 범위:**
  - `src/ai/request-router.ts`: `/route` 한 번의 호출에 다음 질문을 넣는다
    - `target`: `view/param/app/jig/ask/document/make`
    - 화면 동작·대상(현행)
    - `param`: 열린 jig 설정값의 제목·도움말
    - `jig`: 등록된 jig의 `intent_en`, Noul ≥ 0.30일 때만 채택
    - `same_conversation`: T-061이 쓴다
    - 작업·영역: 새 대화를 열 때만 묻는다
  - 규칙 경로: 판정 없이 정하는 말(로그인·Sync 말, jig `words`, "도구로 만들", 설정값 핵심어 + 숫자, 파일 말)과, Jev 키 없음·실패·3초 지연·확신 낮음일 때의 나머지 규칙(SPEC-02.17의 1)
  - 값 추출은 코드가 한다
    - 긴 단위부터 맞추고 뒤에 영문자가 오지 않게 경계를 둔다
    - 상대값은 설정값 선언의 `words` 방향으로 한 단계·두 배·반을 적용한다
    - 범위 밖이면 적용하지 않고 범위를 알린다
  - `target`이 `view/param/app/jig`이면 모델 선택을 부르지 않는다
  - **화면을 빼면 Jev 판정만으로 자동 실행하는 것은 되돌리기가 있는 설정값 변경뿐이다.**
    - 앱 조작과 jig 열기는 제안 카드로 보이고 SPEC-02.19의 7 등급대로 실행한다: Sync 받기·jig 열기는 T1. 로그인·로그아웃·계정 전환은 VIDE가 하지 않고 AccountSwitch·터미널 안내(R)만 보인다(ADR-025)
    - 카드의 실행은 사람이 누를 때와 같은 경로·검사(원격 세션 차단 포함)를 거친다
    - 로그인 주소·일회용 코드는 대화·기록에 넣지 않는다
    - 알림과 카드에 'AI 작업으로 보내기'를 둔다
  - 입력 조립 단발 AI 단계: 도구 없음. 레이어 표·형상 요약·(자료 1차 뒤) 자료 검색 결과를 받아 역할 후보 JSON을 내고 게이트를 거친다(PLAN-23 T-051이 씀)
  - **FR-18 전송 고지와 끄기.** 끄면 규칙 경로만 쓴다
  - **`/route` 전송 항목 고정**
    - 보내는 것: 요청 문장(2,000자 이하), 열린 jig 설정값 제목·도움말, jig `intent_en`, 연결 파일의 역할 라벨, 앱 동작 이름
    - 보내지 않는 것: 파일 이름·경로·폴더명, 자료 진술 본문, 형상, 계정 주소, 로그인 코드
  - 진단 기록 `route {by, target, action, param?, jig?, ms}`와 되돌림 횟수. 본문은 남기지 않는다
- **선행:** PLAN-05 §7의 제품 Jev 범위 갱신(결정 A10), PLAN-22 T-046(설정값·jig 목록). SPEC-02.17은 review다.
- **검증:**
  - 정상:
    - "경간 11로"가 AI 없이 반영되고 되돌릴 수 있음
    - 단위 시험: `900mm` → 0.9 m, `0.9 m`, `12m`, `12 미터`, `2.5미터`, `90센티`
    - "구조 검토하고 싶어" → jig 카드(모델 선택 없음)
    - "codex 로그인해줘" → 로그인돼 있으면 알림, 아니면 AccountSwitch·터미널 안내
    - "다른 파일 sync해줘" → T1 카드
    - 입력 조립 역할 제안
  - 실패:
    - 범위 밖 값은 적용하지 않고 범위를 안내함
    - 고지를 끄면 Jev 호출 0
    - `/route` 요청 본문에 파일 이름·경로가 없음
    - 키 없음·확신 낮음·HTTP 실패·지연은 규칙 경로로 감
    - 잘못 판정하면 'AI 작업으로 보내기'로 되돌림
  - 회귀: `tests/ai/request-router.test.mjs`, `browser-route.mjs`
  - 실제 Jev: 합성 문장 정확도 기록(PLAN-19 방식)
- **완료:** 위 시험 통과와 정확도 기록.
- **상태(2026-10-01):** 구현·검증 완료(작성기 연결 포함). 실제 Jev 정확도 기록만 남음.
  - 판정·값 추출: `src/ui/request-route.ts`(일곱 경로, `decisiveRoute` 규칙 순서 로그인 → Sync → jig 부름말 → 만들기 → 설정값 핵심어+숫자 → 파일 말, `quantities`·`convert`·`paramChange`, 카드 등급 `routeCard`), `src/ai/request-router.ts`(`judgeRoute` 한 호출, `redact`로 경로·파일 이름 제거, FR-18 스위치 `<data>/route-settings.json`, 입력 조립 단발 단계 `inputRolesRequest`·`checkInputRoles`), `model-router.ts` `needsModel`, `server.ts` `/route`·`/route/revert`·`/settings/routing`(원격 PUT 차단, 진단에 본문 없음), `ai-settings.tsx` 전송 고지·끄기
  - 작성기: `param`은 AI 없이 `PUT …/jig-instances/:iid/params`로 적용하고 [되돌리기]·[AI 작업으로 보내기]를 띄운다. 열린 jig 패널은 `vide:jig-params-changed`로 다시 읽는다. [AI 작업으로 보내기]는 한 일을 되돌리고 `/route/revert`에 `{target, by}`만 남긴다
  - 검토에서 정한 규칙: 객체·파일·화면 동작 말이나 한계 말(넘는·이상인 등)이 있으면 설정값 핵심어+숫자 규칙을 쓰지 않는다("경간 12m 넘는 거더 숨겨" 오판 수정)
  - 바뀐 기준: jig로 판정된 요청은 카드에서 멈추지 않고 jig를 열어 계산한다(ADR-026, [PLAN-26](PLAN-26-chat-stage.md) T-076). 로그인·계정 말은 안내만 한다(ADR-025, `5ec4458`)
  - 증거: `4f5f43a`(판정·서버), `6b70f34`(작성기 연결), `c972e23`(패널 갱신). `tests/core/request-route.test.mjs`, `tests/ai/request-router.test.mjs`, `tests/ai/route-http.test.mjs`, `browser-route.mjs`(2026-10-01 main에서 통과)
  - 남음: 실제 Jev 합성 문장 정확도 기록(PLAN-19 방식). 입력 조립 역할 제안을 부르는 일은 PLAN-23 T-051이 한다

### T-059 · CLI 버전 점검·캐시 토큰·세션 SPIKE {#t-059}

- **목적/기준:** 세션 방식의 전제를 확인하고, CLI 자동 갱신으로 로그인 방식이 바뀌어도 구독 경로가 조용히 멈추지 않게 한다. 결정 A5·A2, ADR-021.
- **변경 범위:**
  - `src/ai/claude-cli.ts`·`src/ai/codex-cli.ts`, 새 `cli-compat.json`(검증한 버전 범위)
  - 실행 전 `--version` 확인(60초 캐시): 범위 밖이면 실행을 거부하고 안내한다
  - `--bare` 실패 신호를 채집해 `CLI_MODE_CHANGED`로 분류하고 멈춘다
  - 가능하면 검증한 버전의 바이너리 경로를 고정한다
  - 캐시 토큰(`cache_read_input_tokens`·`cache_creation_input_tokens`)을 기록한다
  - SPIKE `docs/tdd/SPIKE-YYYY-MM-DD-cli-session-resume.md`: ADR-021의 SPIKE 표(0, ①~⑨)를 질문과 합격 기준까지 먼저 적고 실행한다. 요지는 다음과 같다
    - 0: CLI 버전 확인. 위 변경이 그 구현이다
    - ①: 이어 실행 때 매 턴 도구·MCP 목록
    - ②: 파일 도구의 폴더 경계
    - ③: 다른 계정 프로필에서 이어 가기
    - ④: Codex 이어 실행의 sandbox·MCP
    - ⑤: 취소·늦은 결과·종료 미확인 뒤 재개
    - ⑥: 기록 삭제의 격리
    - ⑦: 도구 유무 턴 섞기(`--system-prompt-snapshot off` 포함)
    - ⑧: 초안 폴더와 상위 `CLAUDE.md` 로드 여부
    - ⑨: 단발 대 세션의 턴별 입력·캐시 토큰
- **선행:** 없음. 바로 시작할 수 있다.
- **검증:** 정상 — 범위 안 버전 실행, 캐시 토큰 기록. 실패 — 범위 밖 버전 거부·안내, `--bare` 신호 모의 → `CLI_MODE_CHANGED`로 멈춤. SPIKE는 합성 짧은 요청으로 한다.
- **완료:** 시험 통과와 SPIKE 합격 여부 기록. 떨어진 항목은 ADR-021 결정 7대로 T-061에서 그 항목만 원장 방식이나 형제 세션으로 되돌린다.
- **상태(2026-10-01):** 완료. 판 범위 밖 거절(`CLI_VERSION_UNSUPPORTED`), `CLI_MODE_CHANGED`, 캐시 토큰 기록이 단위 시험과 설치본 실행을 통과했다. 두 오류 코드의 화면 문구는 `src/ui/gateway.ts`에 있다.
  - SPIKE 결과([SPIKE-2026-09-30-cli-session-resume](../tdd/SPIKE-2026-09-30-cli-session-resume.md)): ①②⑤⑥⑦(`--system-prompt-snapshot off`)⑧ 합격. ③ 실패 재현 → 인계만. ④는 처음에 조건부였고(중립 `developer_instructions`와 `-c sandbox_mode` 필요) 재시험 합격으로 Codex 세션 이어 실행을 켰다(T-061). ⑨는 도구 없는 5턴 한 종류만 기록
  - 확인한 판 범위는 `src/ai/cli-compat.json`(Claude ≥ 2.1.284 < 2.2.0, Codex ≥ 0.157.0 < 0.158.0)이다. CLI가 그 위로 자동 갱신되면 SPIKE를 다시 돌려 범위를 넓히기 전까지 AI 실행이 거절된다
  - 증거: `4f5f43a`(점검·SPIKE), `c972e23`(④ 재시험). `tests/ai/claude-cli.test.mjs`·`codex-cli.test.mjs`

### T-060 · 동시 접수 규칙 개정 {#t-060}

- **목적/기준:** 지금 규칙은 겹치는 요청을 대기열에 넣지 않고 거절하고, 프로젝트 활성 요청을 2개로 제한해 여러 대화 동시 진행을 막는다. 결정 A3대로 바꾼다. FR-25, SPEC-02.9(동시 접수 1~5), AC-46.
- **변경 범위:**
  - `src/contracts/request-scope.ts`
    - 요청 입력에 `hostUse: none|read|write`를 둔다. 호스트를 쓰지 않는 턴은 호스트 경합에서 뺀다
    - 읽기(Sync 캡처·jig 입력 읽기)는 `sourceDocument`로 문서 키를 가진다. 같은 문서의 원본 반영과만 겹치고, 용량 계산에서 뺀다
    - 같은 문서 쓰기(AI 편집·Rhino에 만들기·원본 반영)는 거절하지 않고 문서별 대기열에 넣는다. 대상 문서를 확인할 수 없는 호스트 요청은 같은 호스트의 모든 문서 쓰기 뒤에 선다
    - 프로젝트 상한은 "문서당 쓰기 1 + 프로젝트 AI 턴 N(기본 3, 설정 2~4)"이다. 넘으면 프로젝트 대기열에 넣는다. AI를 부르지 않는 처리는 상한에 세지 않는다
    - 불명확 결과가 나오면 그 문서의 대기열을 멈추고 이유를 보인다
  - `src/core/workspace.ts`: 접수 때 거절 대신 대기 상태와 대기 위치를 저장한다
  - `src/server/execution.ts`: 앞 작업이 끝나면 다음을 꺼내고, 개입 뒤 경합을 처리한다
  - `src/ui/app.ts`: 보내기를 끄지 않고 대기 순서를 표시한다
  - 기준이 낡은 후보(`STALE_REFERENCE`)는 적용하지 않고 [다시 기준 잡기] 카드를 띄운다
- **선행:** 없음(SPEC-02.9는 review). 세션(T-061)과는 독립이며, 대화 칩이 없어도 기존 요청으로 시험한다.
- **검증:**
  - 정상: Rhino 편집 중 호스트 없는 질문 접수·완료, 편집 중 다른 파일 Sync·jig 입력 읽기가 거절되지 않음, 같은 문서 두 쓰기 → 뒤의 것이 한 줄 대기 후 실행, AI 턴 4번째 → "대기 1번째"
  - 실패: 대기 중 취소, 재시작 때 대기 요청은 보존하되 자동 실행하지 않음, 불명확 결과 뒤 그 문서 대기열 정지, 기준이 낡은 후보는 적용하지 않음, 호스트 쓰기 보호(SPEC-02.4·02.7) 유지
  - 회귀: `browser-concurrent-work.mjs`, `browser-intervention.mjs`, `browser-host-panel.mjs`
- **완료:** 위 시험 통과.
- **상태(2026-10-01):** 완료(AI 턴 상한 3, 설정 2~4). [다시 기준 잡기] 카드는 남음.
  - `src/contracts/request-scope.ts`(`hostUse` none/read/write와 추론, `requestAdmission`: 같은 문서 쓰기는 문서별 대기열, 읽기는 같은 문서의 원본 반영(ZWCAD 직접 편집 포함)만 기다림, 문서를 알 수 없는 호스트 요청은 그 호스트의 모든 쓰기 뒤, 불명확 결과는 `HOST_RESULT_UNRESOLVED`, 쓰기 경합을 건너뛰는 선언은 `INVALID_INPUT`), `src/core/workspace.ts`(`phase: 'queue'`·`waitingFor`), `src/server/execution.ts`(`pump`, 대기 중 취소·개입, 호스트 없는 턴에는 호스트 도구 없음), `src/ui/app.ts`(보내기를 끄지 않고 대기 수·순서 표시)
  - Sync·가져오기·확장은 기다리지 않고 `PROJECT_BUSY`다. `WORKSPACE_CAPACITY`는 더 이상 나오지 않는다
  - 증거: `4f5f43a`. `tests/core/request-scope.test.mjs`, `tests/server/concurrent-intake.test.mjs`(대화 3개 동시, 같은 문서 두 쓰기 대기→실행, 읽기·검토 비거절, 대기 취소·승격, 4번째 AI 턴 대기, 개입의 자리 유지), `browser-concurrent-work.mjs`·`browser-intervention.mjs`·`browser-host-panel.mjs`
  - 남음: `STALE_REFERENCE`의 [다시 기준 잡기] 카드(지금은 오류 문구만). 재시작 뒤 대기 요청은 `interrupted`로 보존되고 자동 실행하지 않지만(기준대로) 화면은 일반 중단 문구라 대기였음을 알리지 않는다. 개입([멈추고 이걸로])의 대기 처리는 단위 시험만 있다

### T-061 · 대화 스레드와 세션 실행 {#t-061}

- **목적/기준:** 결정 F1·A2. 대화 = 목적별 작업 흐름이다. 턴마다 새 프로세스를 띄워 세션으로 잇고, 토큰·상한·도구 범위는 턴마다 다시 발급한다. VIDE의 원장·jig 작업본·초안 파일이 정본이므로 세션을 잃어도 작업을 잃지 않는다. FR-25, SPEC-02.17의 5·6, SPEC-02.19의 1~5, ADR-021, ARCH-01 §2, ARCH-03 §10, AC-46·47.
- **변경 범위:**
  - 새 `src/server/conversations.ts`
    - 대화 만들기·닫기·목록
    - 원장 기록: 가정·질문·답·결정·코드·설정값 변경·결과·인계
    - AI 없이 처리한 설정값·앱·jig 열기 결과도 지금 대화에 카드로 남기고 원장에 기록한다
    - Sync 받기·jig 입력 읽기·Rhino에 만들기는 대화에 속하지 않고, 대화에서 시작했으면 결과 카드만 남긴다
  - 대화의 첫 턴에 공급자·모델을 고정한다(작성기의 명시 모델, 아니면 Jev 한 번, T-088). effort는 같은 공급자 안에서 턴마다 바꿀 수 있다. 계정은 고정하지 않고 매 턴 CLI 기본 로그인을 쓴다(ADR-025)
  - `src/ai/claude-cli.ts`
    - 첫 턴 `--session-id`, 이후 `--resume`
    - 매 턴 인자는 현행 인자에서 `--no-session-persistence`만 뺀 것이다. init 도구·MCP 단언을 유지한다
    - 작업 폴더는 매 턴 저장소 밖 빈 임시 폴더다. 계정 프로필 환경은 현행 그대로다
  - 중립 시스템 프롬프트 하나 + 요청 자료의 '이번 턴 규칙'. SPIKE ⑦ 결과에 따라 `--system-prompt-snapshot off`를 쓰거나 형제 세션으로 한다
  - `src/server/execution.ts`
    - 원장 싣기(8 KB 넘으면 요약)와 다른 대화에서 바뀐 것 요약
    - 대화별 FIFO 대기열: 덧붙인 말은 대기하고 보내기 전에 지울 수 있다. [멈추고 이걸로]만 개입 중단이다
    - 말로 한 '잠깐 멈춰'도 대기열에 넣고, 개입으로 보이면 [멈추고 이걸로]를 눈에 띄게 한다
    - 앞 턴이 불명확 결과로 끝나면 그 대화의 대기열을 멈춘다
  - 공급자 세션 이어 실행은 T-059 SPIKE에 합격한 항목에만 켠다. 그 전과 떨어진 공급자는 원장 방식(턴마다 단발 + 원장)이다. Codex는 SPIKE ④ 합격 전까지 원장 방식이다
  - 인계와 복구(SPEC-02.19의 5)
    - 계정 한도: 끝난 턴은 다시 보내지 않고 AccountSwitch에서 계정을 바꾸라고 안내한다. 계정 전환·인계는 VIDE가 하지 않는다(ADR-025, [PLAN-25](PLAN-25-accounts-to-accountswitch.md) 2단계)
    - 공급자·모델 바꾸기: 다른 공급자·모델로 보내거나 [다른 AI로 이어 가기]를 누르면 새 대화 탭이 인계 자료를 받아 새 세션을 연다(T-088)
    - 이어 쓰기 실패·종료 미확인·재시작으로 끊긴 턴: 그 세션을 다시 쓰지 않는다. 이전 프로세스 종료를 확인한 뒤 인계 자료로 새 세션을 연다(방식은 ARCH-01 §2)
    - 대화가 길어짐: 정한 턴 수·누적 입력량을 넘으면 원장으로 새 세션을 연다. 시작값은 12턴·누적 150k 토큰이고, SPIKE ⑨ 측정 뒤 설정 기본값을 확정한다
  - 기록 관리: 닫고 30일 뒤 공급자 기록 삭제, 버린 jig 초안의 기록은 바로 삭제, 백업 제외. 기록을 지운 뒤 다시 연 대화는 원장으로 새 세션을 연다
  - 새 `src/ui/conversations.tsx`: 대화 칩, 진행 중·안 읽음 점, 대기 수, 새 대화 제안 카드(`same_conversation`이 낮을 때, 자동으로 나누지 않음)
  - `work-view.tsx`: 대화 필터. 패널 모드는 대상 문서 필터를 유지하고 대화 칩을 그리지 않는다
  - 기존 요청과 패널에서 보낸 요청은 프로젝트 기본 대화다(`conversationId = NULL`)
- **선행:** PLAN-22 T-045, T-060. 대화·원장·원장 방식은 SPIKE를 기다리지 않고, 세션 이어 실행만 T-059의 합격 항목(①②⑤⑥⑦)을 기다린다(ADR-021).
- **검증:**
  - 정상: 3턴 대화에서 AI가 앞 턴의 코드·오류를 참조, **대화 3개 동시(모델 편집 + CAD 편집 + 법규 질문) 접수·완료**, 덧붙인 말 대기·[멈추고 이걸로] 중단, 대화 동안 공급자·모델 불변, 기존 요청이 기본 대화로 보임
  - 실패: 계정 한도 모의 → 다시 보내기 없음·AccountSwitch 안내, 종료 미확인 뒤 같은 세션을 두 실행이 쓰지 않음, 이력 속 옛 대상은 `TARGET_MISMATCH`, 매 턴 도구·MCP 목록이 그 턴 인자와 다르면 실행하지 않음, Codex 원장 방식
  - 회귀: `browser-host-panel.mjs`
- **완료:** 위 시험 통과와 5턴 대화 2종의 토큰 기록.
- **상태(2026-10-01):** 서버·화면 구현과 자동 검증 완료, Claude·Codex 세션 이어 실행. 실제 CLI 5턴 토큰 기록이 남음.
  - 서버: `src/server/conversations.ts`(`ConversationService`: 만들기·목록·닫기(`discard`면 기록 즉시 삭제)·다시 열기·원장, 한 대화에 한 턴(뒤 메시지는 `waitingFor.kind: 'conversation'`으로 대기·철회), 불명확 결과는 줄 멈춤, `beginTurn`/`endTurn`, `purge`/`sweep`(닫고 30일 뒤 기록 삭제, 시작 때와 매일), 재시작 때 끊긴 턴의 세션은 `lost`, HTTP `…/conversations`·`:cid/close|reopen|ledger|handoff|answer|renew|bind`(handoff는 원격 403; 만들기·닫기는 원격도 요청과 같은 범위)), `src/core/conversation-store.ts`, `src/contracts/workspace.ts`(`conversationId`)
  - CLI: Claude는 첫 턴 `--session-id`, 이후 `--resume`, `--no-session-persistence`만 빼고 격리 인자 유지 + 중립 프롬프트 + `--system-prompt-snapshot off`, 이번 턴 규칙은 자료 항목 `turn-rules`, `SESSION_LOST`는 새 세션으로 1회 재시도. Codex는 SPIKE ④ 재시험 합격으로 세션 이어 실행을 켰다(`codexSessionInstruction`, spawn 직전 `codexTurnIsolated`, `thread.started`의 thread ID, resume 턴 사용량 `usageScope: 'session'`)
  - 대상 전달: 대화 대상(`targetRef`·열린 jig·연결 id와 호스트)을 `scopeRules`로 턴 규칙에 싣는다
  - 길이 기준: 12턴·150,000 토큰을 설정값(`GET/PUT /api/v1/settings/conversations`, 원격 PUT 차단)으로 두고, 넘으면 [새 세션으로 이어가기] 카드(`…/renew`)로 **제안**한다. 누르기 전에는 지금 세션이다(SPEC-02.19 표를 이에 맞춤)
  - 화면: `src/ui/conversations.tsx`(대화 탭·진행·안 읽음·대기 수·새 대화, 정해진 AI 표시, [다른 AI로 이어 가기]·인계 표시), `work-view.tsx` 대화 필터, 새 요청의 `conversationId`
  - 계정: 계정 고정과 한도 인계(자동 전환·T2 계정 전환 카드·`…/account`)는 2026-10-01 ADR-025로 VIDE에서 빠졌고 [PLAN-25](PLAN-25-accounts-to-accountswitch.md) 2단계(`5ec4458`)가 처리했다. 이 티켓에 남은 일이 아니다
  - 증거: `c67bf57`(세션), `6b70f34`(화면), `c972e23`(Codex 세션), `32bf8be`(대상·길이 기준). `tests/server/conversations.test.mjs`, `tests/core/conversations-ui.test.mjs`, `tests/ai/claude-cli.test.mjs`·`codex-cli.test.mjs`, `browser-conversations.mjs`(2026-10-01 main에서 통과)
  - 남음: 실제 CLI로 5턴 대화 2종의 토큰 기록(지금은 모의 CLI와 SPIKE ⑨의 도구 없는 5턴 한 종류뿐). 연계 요청(`linkedTargets`)의 턴은 원장 항목만 싣고 이전 교환을 선별하지 않는다

### T-062 · 대화 도구와 질문 카드 {#t-062}

- **목적/기준:** jig 안 대화와 자료 질문에서 AI는 계산하지 않고 도구 결과의 숫자만 인용한다. 결과가 크게 갈리는데 근거가 없을 때만 묻는다. 채택된 C-02의 AI 묻기는 [PLAN-08](PLAN-08-project-knowledge.md) K0-T3의 2안(채팅 도구)으로 여기서 마무리한다. FR-25, FR-24, SPEC-02.19의 3(jig 대화의 AI 제안)·6(질문 카드)·7(확인 등급), SPEC-02.17의 2(AI도 앱 동작은 카드로 제안), SPEC-06.3(미리보기 인용), SPEC-07.14(AI 뒤 점검).
- **변경 범위:**
  - 도구 등록부 하나(`src/server/agent-tools.ts`·`src/ai/agent-connection.ts`): 한 곳의 정의에서 이름 목록과 분기를 만들고, 대화 종류 × jig 출처로 범위를 발급한다. 도구 목록과 입출력은 ARCH-01 §3을 따른다. 아래 이름은 RESEARCH-10 §8.4 초안이다
  - AI 턴의 제안 카드: 설정값 변경·수정 사항·입력 역할·앱 동작·Rhino에 만들기. 실행은 사람이 누를 때와 같은 경로·검사를 거친다. AI는 해석 확정을 하지 않는다(M)
  - jig 도구: `jig_catalog`, `jig_state`, `jig_set_params`(T1, `fixedAtPin` 거절), `jig_propose_edit`, `jig_propose_inputs`, `jig_run`, `jig_bake`(제안만, 원본 반영은 사람), `links_layers`, `sync_sample`
  - 구조 도구: `structure_result`, `structure_preview`('미확정 미리보기' 표기), `structure_size`, `structure_schedule`, `structure_clearance`
  - 자료 도구: `project_brief`, `project_search`, `project_issue`, `project_statement`, `project_checks`. `project_checks`는 코드가 대조해 일치·충돌·근거 없음을 낸다
  - 구조화 턴 출력: 완료·진행·질문. 질문은 턴당 최대 3개이고, 사용자가 결정한 것은 다시 묻지 않는다
  - 인용 게이트(`ref-whitelist`·`numbers-in-source`)를 jig·자료 설명에 적용한다
  - AI 지시문 용어 규칙: 실무어(결정 A13)
- **선행:** T-061, PLAN-22 T-046, PLAN-23 T-052(구조 도구), PLAN-22 T-065(자료 도구. 없으면 자료 도구만 뒤로).
- **검증:**
  - 정상: "왜 C12가 빨개?"가 결과 인용과 함께 답, 질문 카드 최대 3개(원장에 있는 질문·사용자 결정은 다시 묻지 않음), 자료 질문에 근거 칩, 미리보기 수치 인용에 '미확정 미리보기' 표기
  - 실패: `fixedAtPin` 값 변경 요청 거절, 결과에 없는 숫자·부재 인용은 점검 실패, 자료에 없는 질문은 "자료에 없음", 다른 프로젝트 DB 접근 불가, 도구 결과에 비밀값·로그인 코드 없음, AI가 앱 동작·Rhino에 만들기를 직접 실행하지 못함, 기존 AI 작업 권한이 넓어지지 않음
- **완료:** 위 시험 통과.
- **상태(2026-10-01):** 구현·단위 검증 완료, 설치본에서도 도구가 켜진다. 호스트 모델링 턴의 자료·레이어 도구 연결이 남음.
  - 구조화 턴 출력 `src/server/turn-output.ts`(strict JSON 스키마, 질문 ≤ 3·선택지 2~5, 권장 선택지를 앞으로, 원장에 있는 질문 제외, 질문 id는 결정 이름; Claude `--json-schema`, Codex `--output-schema`)와 질문 카드 `src/ui/question-card.tsx`(가장 최근 성공 턴이 질문으로 끝났을 때, 답은 `…/conversations/:cid/answer`). 대상은 호스트·jig 검토가 아닌 대화 턴이다. Claude 대화 턴은 이제 공급자 자체 질문을 기본으로 쓴다(T-075)
  - 도구 등록부 `src/server/agent-tools.ts`: `jig_list`·`jig_state`·`jig_output`·`jig_set`·`jig_run`·`structure_summary`·`structure_checks`·`links_layers`·`sync_sample`(대화 범위, `confirmed` 실행 불가, 호스트 문서에 쓰지 않음). `server.ts`가 엔진 `origin`을 넘겨 설치본에서도 켜진다. 대상이 하나뿐이면 `targetRef`·`instanceId` 없이 받는다(T-061의 `scopeRules`)
  - 결정(사용자 2026-09-30, SPEC-02.19 0.34): 대화 안의 AI는 그 대화에 열린 jig에 한해 `jig_set`(되돌릴 수 있는 T1, 원장 + [되돌리기])·`jig_run`(계산 단계만)을 확인 없이 실행한다. 해석 확정·Rhino 만들기·반영·계정 동작은 사람이 누른다
  - 증거: `6b70f34`(출력·카드·도구), `c972e23`(`origin`), `32bf8be`(대상 생략). `tests/server/turn-output.test.mjs`, `agent-tools-jig.test.mjs`, `agent-tools-origin.test.mjs`. Claude 실호출에서 `--json-schema` 대화 턴이 돌았다([SPIKE-2026-09-30-instruction-bundle](../tdd/SPIKE-2026-09-30-instruction-bundle.md))
  - 남음: 호스트 모델링 턴의 `links_layers`·`sync_sample`·`project_*` 발급(SPEC-02.6). `execution.ts`에 `HOST_TURN_PROJECT_TOOLS`·`hostTurnProjectHandlers`만 있고 부르는 곳이 없다. 자료 도구 `project_*`는 PLAN-22 T-065. Codex `--output-schema` 실호출은 확인하지 않았다

### 지침 묶음·AI 동등성 {#ai-parity}

- **목적/기준:** VIDE 안의 AI가 같은 요청에서 터미널 Claude Code만큼 모델링하게 한다. 사용자 결정(2026-09-30)에 따라 공급자 기본 시스템 프롬프트를 유지하고 VIDE 지시 묶음을 덧붙인다. 공급자 skill·plugin은 끄고, 쓸모 있는 skill 내용은 묶음으로 옮긴다. 쓰기는 작업 사본 → 후보 → 반영만 쓴다. 차이의 원인과 비교 방법은 [RESEARCH-11](../research/RESEARCH-11-ai-parity.md), 물리 계약은 ARCH-01 §2·§3, 안전 문장은 ADR-014(`common.md`로 옮기되 빠지는 것 없음), 세션은 ADR-021과 SPEC-02.19를 따른다. FR-25.
- **변경 범위:** `src/ai/instructions/`(`common.md`·`modeling.md`·`modeling-rhino.md`·`modeling-cad.md`·`data.md`·`make.md`, `index.ts`의 `bundleFor(mode, projectAddendum?)`: 크기 상한, 추가분은 자료로 다룸), Claude 매 턴 `--append-system-prompt <묶음>`(세션 포함, 이번 턴 규칙은 user 메시지), Codex 세션 첫 턴 `developer_instructions`, 프로젝트 추가분 `GET/PUT /api/v1/projects/:id/ai-instructions`(≤ 8 KB)와 AI 설정 대화상자, 보기 캡처·측정 도구, 대화 턴 상한(`conversationTurnLimits`), 넓힌 읽기(`query` 커서).
- **선행:** T-061, T-062. 캡처 도구는 Rhino 작업자 쪽 구현이 있어야 실제 확인할 수 있다.
- **검증:**
  - 정상: 모드별 묶음에 공통 + 해당 모드 본문이 들어가고, 모델링 모드에는 Rhino·CAD 노하우 두 파일이 들어감. 매 턴(세션 이어 실행 포함) Claude 인자에 `--append-system-prompt`가 있고 `--system-prompt`로 기본 프롬프트를 바꾸지 않음. Codex는 세션 첫 턴에만 `developer_instructions`로 같은 본문을 받음. 격리 인자와 시작 이벤트의 도구 검사는 전과 같음. 프로젝트 추가분이 저장·표시·수정되고 묶음 끝에 자료로 붙음. ADR-014의 안전 문장이 모두 `common.md`에 있음
  - 실패: 8 KB를 넘는 추가분은 거절. 추가분 안의 지시 흉내(권한·도구 요구)는 권한을 넓히지 않음. 묶음 크기가 상한을 넘으면 정해진 순서로 줄이고 공통 본문은 줄이지 않음. 원격 세션의 추가분 수정은 기존 설정 규칙(원격 PUT 차단)을 따름. 묶음에 프로젝트·고객 이름이나 MCP 전용 명령이 없음
  - 비교: RESEARCH-11 §4의 A/B(합성 요청 5개, 성공·수정 요청 수·소요 시간·토큰)를 Rhino가 비어 있을 때 돌려 `docs/tdd/VERIFY-YYYY-MM-DD-ai-parity.md`에 남김
- **완료:** 위 단위·계약 시험 통과, A/B 한 번 기록. A/B 합격 기준(B 성공 수 ≥ A, 수정 요청 수 중앙값 ≤ A + 1, 소요 시간 중앙값 ≤ A의 1.5배)에 못 미치는 요청은 원인 행과 후속 조치를 현황에 적는다.
- **상태(2026-10-01):** 구현·단위 검증, Claude 실호출, 실제 Rhino 캡처·측정, A/B 1회 기록. A/B 재측정과 Codex·모델링 모드 실호출이 남음.
  - `src/ai/instructions/`(`common`·`modeling`·`modeling-rhino`·`modeling-cad`·`data`·`make`, `index.ts` `bundleFor(mode, addendum?, {host})`: 묶음 20,000자·추가분 8 KB, 추가분은 제어·방향 문자 제거 뒤 `<project-notes>` 자료 블록, Codex는 Windows 명령줄 32,767자 안으로 자름), `project-store.ts`와 `GET/PUT /api/v1/projects/:id/ai-instructions`, AI 설정의 추가 지침 편집. Claude는 매 턴 `--append-system-prompt`(`--system-prompt` 없음), Codex는 `developer_instructions`로 같은 본문
  - 보기 도구 `capture_view`(PNG ≤ 1 MB, 카메라·레이어 복원)·`measure`(`hosts/rhino/worker/ViewTools.cs`, `hosts/rhino/view-tools.ts`, `agent-tools.ts` `visionHandlers`), 요청 이미지(최대 3개·각 1 MB, data URL만), 대화 턴 상한 `conversationTurnLimits` 100회·48 명령·600초(답 턴·만들기 포함), `query` 커서(`"<revision>:<offset>"`)
  - 결정: 원격 세션은 추가 지침을 읽기만 한다(`ai-instructions` PUT 차단). 멈춘 만들기 대화에는 파일 도구를 주지 않는다(`makeStopped`, PLAN-22 T-063)
  - 증거: `32bf8be`, `d8fb2ba`. `tests/ai/instructions.test.mjs`·`cli-images.test.mjs`, `tests/server/agent-tools-vision.test.mjs`·`query-page.test.mjs`, `tests/core/execution-limits.test.mjs`. [SPIKE-2026-09-30-instruction-bundle](../tdd/SPIKE-2026-09-30-instruction-bundle.md)(Claude 2턴: 묶음 도달·세션 이어 실행·기록 파일 삭제). 실제 Rhino 8의 `capture_view` 1600×900·`measure`는 [VERIFY-2026-09-30-direct-apply-rhino](../tdd/VERIFY-2026-09-30-direct-apply-rhino.md)
  - A/B([SPIKE-2026-09-30-ai-parity-ab](../tdd/SPIKE-2026-09-30-ai-parity-ab.md), 도구 `tools/ab/`): 성공 5/5로 동률(재실행 기준)이나 시간은 5개 모두 터미널의 2~4배로 2배 기준을 넘었다. 원인은 CLI 턴 시작, 지시 묶음·조회, `IsValid` 재시도, 빈 캡처 재시도, 첫 연속 실행의 되돌리기 결함이다. 되돌리기 뒤 열린 기록·`IsValid`·빈 캡처는 `d8fb2ba`에서, 거절된 실행의 `unknown`은 `0fb9506`에서 고쳤다(T-070·T-072). B는 맹검이 아니다
  - 남음: 고친 뒤 같은 절차로 A/B 재측정(공정한 B는 사람이 `tools/ab` README대로 잼), Codex·모델링 모드 실호출

## 바로 적용·계획/자동 모드 {#direct-apply}

사용자 결정(2026-09-30, [ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md))으로 AI 편집은 연결된 Rhino·ZWCAD 문서에서 실행 하나당 되돌리기 기록 하나로 바로 실행하고, 권한 선택(검토/후보/적용)은 계획·자동 두 모드로 바뀐다. 사본 → 후보 → 적용 경로(ADR-014)는 제품 흐름에서 빠진다. 기준: PRD §11.2·FR-10~12·AC-38, SPEC-02.11·.13·.20, ARCH-01 §4 「바로 적용 경로」. 공통 검증: 정상 실행·보호 동작·되돌리기(최신 기록만)·응답 잃음의 네 경우를 단위 시험으로, 실제 호스트 확인은 플러그인 설치 뒤 한다.

### T-069 · 문서 기준 정리 {#t-069}

- **변경 범위:** ADR-022 새로 씀, PRD·SPEC-02·ARCH-01을 바로 적용과 두 모드 기준으로 고침, ADR-003·011·014에 후속 결정 메모.
- **완료:** `npm run docs:check` 통과, 문서 사이와 코드의 보호 판정이 일치.
- **상태(2026-10-01):** 완료(`c8443db`). ADR-022(approved), PRD 0.13, SPEC-02 0.36(§02.20 계획과 자동), ARCH-01 0.53. 보호 목록은 PRD §11.2 한 곳에 두고, 판정 방식(Rhino purge는 실행 전 코드 판정, ZWCAD는 실행 뒤 개수, 저장·내보내기는 AI 코드에서 컴파일 때 거절)을 SPEC-02.13 표에 맞췄다. 뒤의 문서 정리(`e310dac`·`f29ba12`·`a8c3d08`)가 나머지 정본을 따라 고쳤다.

### T-070 · Rhino 바로 실행·되돌리기·보호 {#t-070}

- **변경 범위:** `hosts/rhino/worker/DirectExecution.cs`(`direct-execute`·`direct-undo`·`fingerprint`), `AttachedConnection.cs`·`CodePolicy.cs`(생성 코드의 되돌리기 제어 금지, purge 사전 판정), `application-contract.ts`·`editor-channel.ts`·`editor-sessions.ts`.
- **검증:** 계약 시험(`tests/core/host-documents-contract.test.mjs`), 스크래치 폴더 빌드. 실제 Rhino에서 대량 삭제·레이어 삭제 보호, Ctrl+Z 뒤 [되돌리기], 빈 실행.
- **완료:** 위 실제 Rhino 확인까지.
- **상태(2026-10-01):** 완료(실제 Rhino 8, 합성 문서). 설치본 플러그인으로 재확인이 남음.
  - `direct-execute`(되돌리기 기록 하나, 변경 목록, 삭제 50개 초과·레이어 삭제는 기록을 되돌리고 `guarded`, purge는 실행 전 거절, 같은 `requestId` 재전송은 이전 결과), `direct-undo`(최신 기록만, 아니면 `not-latest`), `fingerprint`
  - 숨김 Rhino·합성 문서(객체 73)에서 추가 3 → 되돌리기 73·다시 누르면 `already`, A·B 뒤 A는 `not-latest`, 대량 삭제 60·레이어 삭제·purge 보호, 실패 본문 `reverted`, Rhino `_Undo` 뒤 [되돌리기] `already` 모두 통과. 공용 개발 빌드로 재실행 `passed: true`
  - 시험에서 고친 것: 명령 밖 `RhinoDoc.Undo()/Redo()`가 연 기록을 닫고(`CloseOwnRecord`), 뒤 기록이 모두 되돌려졌거나 빈 기록이면 최신으로 본다(전에는 되돌리기 뒤 다음 실행이 `HOST_RESULT_UNKNOWN`). 코드 정책은 `CommonObject`의 읽기 전용 검사(`IsValid`·`IsValidWithLog`·`IsDocumentControlled`)를 허용한다
  - 증거: `c8443db`(구현), `d8fb2ba`(실호스트·수정). [VERIFY-2026-09-30-direct-apply-rhino](../tdd/VERIFY-2026-09-30-direct-apply-rhino.md), `tests/integration/rhino-direct-apply.mjs`, `tests/core/host-documents-contract.test.mjs`
  - 남음: 설치본 플러그인 등록으로 재확인(시험 뒤 설치본 등록을 복구하지 않았다)

### T-071 · ZWCAD 바로 실행·되돌리기·보호 {#t-071}

- **변경 범위:** `hosts/zwcad/connection/AttachedEdit.cs`(한 UNDO 단계 실행, 변경 추적, `Guard()`), `AttachedDocument.cs`(`fingerprint`·`direct-execute`·`direct-undo`), `hosts/zwcad/attached-documents.ts`.
- **검증:** `tests/core/zwcad-direct.test.mjs`, 스크래치 빌드, 실제 ZWCAD 왕복.
- **완료:** 실제 ZWCAD 확인까지.
- **상태(2026-10-01):** 코드 완료, 실호스트 막힘.
  - 한 UNDO 단계 실행과 보호(레이어 삭제 → purge → 대량 삭제 순), `direct-undo`는 `_.U` 뒤 `VIDEAIUNDONE`으로 확인. 호스트가 문서에 손대기 전에 거절한 실행은 '실행하지 않음'으로 끝난다(`0fb9506`, T-072와 같은 규칙)
  - 증거: `c8443db`, `0fb9506`. `tests/core/zwcad-direct.test.mjs`, 스크래치 빌드. 실제 ZWCAD는 합성 DWG(객체 62) 연결·첫 Sync까지 됐으나, 시작 때 자동 로드되는 설치본 연결 플러그인(0.2.10)이 개발 빌드 `NETLOAD`를 가려 `fingerprint`가 `UNSUPPORTED_METHOD`로 끝났다([VERIFY-2026-09-30-direct-apply-zwcad](../tdd/VERIFY-2026-09-30-direct-apply-zwcad.md))
  - 남음: 0.2.11 이상 연결 플러그인으로 `.vide/h4/run.mjs` 재실행(추가·되돌리기·`not-latest`·대량 삭제·레이어 삭제 보호·Live Sync 갱신). `VIDECADConnect`가 프로젝트 선택 창을 띄워 숨김 ZWCAD 시험(`zwcad-attached.mjs` 포함)이 멈추므로 시험은 `VIDECADLiveSync`로 연결한다. 대량 삭제 보류 때 `revision`이 오르는지 확인

### T-072 · 서버 계획/자동 모드와 실행 기록 {#t-072}

- **변경 범위:** `src/contracts/workspace.ts`(`mode`, 이전 권한 값 변환, `needs-confirmation`, 보호 해제 필드 거부), `src/server/direct-mode.ts`(`runDirectTurn`·`takePlan`·실행 기록), `execution.ts`(모드 분기·`undo`·`confirm`·`continue`), `sdk-execution.ts`·`zwcad-sdk-execution.ts`·`server.ts`(경로 3개, 원격 확인 차단)·`agent-tools.ts`, `request-scope.ts`의 `hostUse`가 `requestMode`를 읽음.
- **검증:** `tests/server/direct-mode.test.mjs`·`direct-mode-e2e.test.mjs`, `tests/core/workspace-contract.test.mjs`.
- **완료:** 위 시험과 실제 호스트 한 번 왕복.
- **상태(2026-10-01):** 완료(단위 시험, 실제 Rhino 왕복). 결과 불명 요청을 풀 경로가 남음.
  - 자동은 연결 문서에 바로 실행하고 `executions[]`(적용·되돌림·보호·확인)를 남기며, 계획은 읽기 도구(`query`·`capture_view`·`measure`)만 받고 계획 카드로 끝난다. 경로 `POST …/requests/:rid/undo|confirm|continue`
  - 안전 규칙: 되돌리지 못한 실패·보호 실행은 결과 불명(`unknown`)으로 턴을 막음, 실행마다 문서 판 기록, 실행 중 [되돌리기]는 `REVISION_CONFLICT`, 요청의 보호 해제 필드는 `INVALID_INPUT`, 원격 세션의 확인은 `FORBIDDEN`, ZWCAD 실행마다 새 id·보호 걸린 실행 하나만 재실행·부분 결과 보존, 삭제된 질문 요청에 답해도 답이 취소되지 않음
  - 거절 규칙(`0fb9506`, `src/contracts/direct-refusal.ts`): 호스트가 문서에 손대기 전에 거절한 실행(읽기 전용 문서, 대상 어긋남·낡음, 호스트 없음, 미지원)은 `unknown`이 아니라 '실행하지 않음'과 이유·다음 행동으로 끝나고, 같은 턴의 다음 실행은 호스트를 부르지 않고 같은 거절을 받는다. 바쁨·일시 거절은 다시 시도할 수 있다. 응답 잃음·시간 초과·되돌리기 실패만 `HOST_RESULT_UNKNOWN`으로 남는다
  - 증거: `c8443db`, `d8fb2ba`(Rhino 쪽 되돌리기 뒤 [되돌리기]가 `already`를 전함, 숨김 Rhino `capture_view`를 `RhinoView.CaptureToBitmap`으로), `0fb9506`. `tests/server/direct-mode.test.mjs`·`direct-mode-e2e.test.mjs`, `tests/core/workspace-contract.test.mjs`. 실제 Rhino 왕복(자동 실행·[되돌리기]·[진행]·`capture_view`·`measure`)은 [VERIFY-2026-09-30-direct-apply-rhino](../tdd/VERIFY-2026-09-30-direct-apply-rhino.md)
  - 남음: 남은 `HOST_RESULT_UNKNOWN`(응답 잃음·시간 초과·되돌리기 실패)을 사람이 풀 경로가 없어 같은 문서 쓰기가 계속 막힌다(`HOST_RESULT_UNRESOLVED`). ZWCAD 왕복은 T-071

### T-073 · 화면: 모드 토글·실행 행·확인 카드·계획 카드 {#t-073}

- **변경 범위:** `src/ui/index.html`·`app.ts`(계획/자동 토글, 기본 자동, Shift+Tab, '계획부터' 제안 카드), `work-view.tsx`(실행별 변경 행과 [되돌리기], 진행 확인 카드, 계획 카드 [진행]), `gateway.ts`(오류 문구).
- **검증:** `tests/integration/browser-direct-mode.mjs`.
- **완료:** 브라우저 시험 통과.
- **상태(2026-10-01):** 완료. 모드 토글(기본 자동, 프로젝트별 기억, Shift+Tab), 실행 행과 [되돌리기](최신 기록이 아니면 Ctrl+Z 안내), 진행 확인 카드, 계획 카드 [진행], '계획부터' 제안 카드, 실행 전 거절의 '실행하지 않음' 행. 예전 결과는 기존 후보 화면으로 보인다.
  - 증거: `c8443db`(구현), `fc5fc40`('계획부터' 카드가 `RouteDecision.task === 'complex'`를 읽도록 고침), `0fb9506`(거절 행). `tests/integration/browser-direct-mode.mjs`는 `792e31d`에서 통과했고 2026-10-01 main(`a8c3d08`)에서 다시 통과했다

### T-074 · jig 만들기의 바로 적용 {#t-074}

- **변경 범위:** `src/jigs/bake/bake.ts`(`runDirectBake`·`undoBake`, 기록된 객체만 바꿈), `src/server/jig-routes.ts`(연결 Rhino는 바로 적용, 없으면 작업 사본).
- **검증:** `tests/core/bake.test.mjs`, 실제 Rhino에서 두 번 만들기·되돌리기.
- **완료:** 실제 Rhino 확인까지.
- **상태(2026-10-01):** 완료(합성 문서, S-06 사본 상단선·부재). 기둥 부재 만들기와 설치본 재확인이 남음.
  - 연결 Rhino의 jig 만들기는 본문마다 되돌리기 기록 하나로 바로 적용하고, 기록되지 않은 객체를 지우면 되돌리고 `BAKE_GUARDED`, 마지막 만들기의 [되돌리기]를 둔다. 연결이 없으면 작업 사본. 호스트가 거절한 만들기는 앞 본문을 되돌린다(`0fb9506`)
  - 합성 문서: `rhino-bake.mjs` 통과(객체 27, 본문 4 = 기록 4, 두 번째 만들기 교체 24·보존 2, [되돌리기]로 기록 4개 모두 복구, 곧은 부재 7개 웨브 수직, 숨긴 레이어 `hidden-target`)
  - S-06 사본: 상단선 161 첫 만들기 3.1초, 재만들기 교체 161·중복 0, 이동한 선 1개 보존, [되돌리기] 복구. 자식 실행기에 worker·addon 권한을 준 뒤(`d8fb2ba`, ARCH-03 §6.4) 엔진 해석이 `ok`가 되어 부재 127 만들기와 [되돌리기]까지 확인했다
  - 시험에서 고친 것: 본문 여럿인 실행의 [되돌리기]가 두 번째 기록부터 실패하던 것(T-070과 같은 `DirectExecution.cs` 수정)
  - 증거: `c8443db`, `d8fb2ba`. `tests/core/bake.test.mjs`, `tests/server/bake-route.test.mjs`, [SPIKE-2026-09-30-jig-bake](../tdd/SPIKE-2026-09-30-jig-bake.md), [VERIFY-2026-09-30-s06-frame-m3](../tdd/VERIFY-2026-09-30-s06-frame-m3.md) 「실제 Rhino 재확인」
  - 남음: 기둥 부재(`member-columns` 34) 만들기(PLAN-23 T-056). 연결 둘을 읽는 인스턴스는 `/bake`에 `linkId`가 필요한데 만들기 카드가 보내는지 화면 시험으로 확인. 되돌리기 추적은 연결 프로세스 메모리에 있어 Rhino를 다시 열면 VIDE의 [되돌리기]가 안 된다(`BAKE_UNDO_UNAVAILABLE`). 설치본 플러그인으로 재확인

### T-075 · 공급자 자체 질문 기능 SPIKE와 어댑터 {#t-075}

- **변경 범위:** Claude `AskUserQuestion`을 stream-json 제어 요청으로 받는 `claude-cli.ts` `nativeQuestions`, Codex `codex app-server` 어댑터 `src/ai/codex-app-server.ts`(`VIDE_CODEX_APP_SERVER=1`). 질문 카드 화면은 그대로 둔다(SPEC-02.19).
- **검증:** [SPIKE-2026-09-30-native-questions-claude](../tdd/SPIKE-2026-09-30-native-questions-claude.md)·[SPIKE-2026-09-30-codex-app-server](../tdd/SPIKE-2026-09-30-codex-app-server.md), `tests/ai/native-questions.test.mjs`·`codex-app-server.test.mjs`.
- **완료:** SPIKE 판정 기록. 기본값으로 켜는 것은 사용자 결정 뒤다.
- **상태(2026-10-01):** SPIKE 합격. Claude는 기본으로 켬, Codex 어댑터는 꺼 둠.
  - Claude는 `--permission-prompt-tool stdio`로 `AskUserQuestion`을 같은 실행 안에서 받는다(실제 CLI 합성 턴, 150초 지연 통과). 사용자 결정 ADR-026 결정 4에 따라 대화 턴에서 기본으로 켠다(`d733f52`, [PLAN-26](PLAN-26-chat-stage.md) T-076). `VIDE_NATIVE_QUESTIONS=0`이면 끄고 구조화 출력 카드만 쓴다
  - Codex는 `app-server`의 `requestUserInput`을 턴 중에 받고 프로세스를 대화 사이에 유지한다(격리는 스레드 설정·응답·MCP 상태로 확인). `VIDE_CODEX_APP_SERVER=1`일 때만 켜고, 엔진을 닫을 때 프로세스를 정리한다. 기본 로그인 계정이 바뀌면 다음 턴 전에 프로세스를 바꾼다(`5ec4458`)
  - 증거: `c8443db`, `d733f52`. [SPIKE-2026-09-30-native-questions-claude](../tdd/SPIKE-2026-09-30-native-questions-claude.md), [SPIKE-2026-09-30-codex-app-server](../tdd/SPIKE-2026-09-30-codex-app-server.md), `tests/ai/native-questions.test.mjs`·`codex-app-server.test.mjs`
  - 남음: Codex `app-server`를 기본으로 켤지 사용자 결정, 실제 대화에서 장시간 사용

### T-088 · 대화별 모델 고정과 모델 바꾸기 = 새 탭 {#t-088}

- **목적/기준:** 2026-10-01 사용자 결정([ADR-021](../decisions/ADR-021-conversation-sessions.md) 보완). 요청마다 Jev가 모델을 바꾸면 세션·캐시를 버리므로 모든 대화(기본 대화 포함)가 첫 턴에 공급자·모델을 고정한다. SPEC-02.17의 5, SPEC-02.19의 1·2·5.
- **변경 범위:** `src/server/conversations.ts` `place`(첫 턴 고정: 작성기의 명시 모델, 아니면 Jev 한 번; 기본 대화는 첫 턴에 실제 대화 행 `default-<projectId>`가 되어 세션을 연다; 다른 공급자·모델이면 새 대화 + 인계 원장 + 양쪽 한 줄), `handoffTo`도 새 대화로, 첫 세션의 인계 자료(이전 대화 또는 기본 대화의 이전 요청). `src/server/server.ts` 요청 접수에서 `place` 호출, Jev 기록(`routed`)은 첫 턴만. `src/ui/conversations.tsx` 탭(정해진 AI 표시·'첫 요청 때 정함', 고른 대화의 모델을 작성기에 맞춤), `src/ui/app.ts` 기본 대화 턴은 `conversationId: 'default'`, 새 대화로 옮겨지면 그 탭을 고른다.
- **검증:** `tests/server/conversations.test.mjs`(첫 턴 고정, 다음 턴은 Jev 무시, effort 바꿔도 같은 세션, 다른 모델 → 새 대화·인계·요청이 거기서 실행), `tests/core/conversations-ui.test.mjs`, `tests/integration/browser-conversations.mjs`·`browser-route.mjs`·`browser-ai-settings-smoke.mjs`.
- **완료:** 위 시험 통과. 실제 CLI로 모델 바꾸기 인계 확인은 설치본 묶음 릴리스 때.
- **상태(2026-10-01):** 구현·검증 완료(`0fb9506`). 실제 CLI 확인이 남음.
  - 기본 대화 턴은 이제 대화 턴이므로 한 번에 한 턴씩 돌고(SPEC-02.19의 4) 대화 턴 상한(호스트 명령 48)을 쓴다. 새 대화 탭은 원장·마지막 세 턴·파일을 인계받고 양쪽 대화에 바꾼 사실이 한 줄 남는다. 대화는 공급자·모델만 고정하고 계정은 고정하지 않는다(ADR-025, `5ec4458`)
  - 증거: `npm test`(커밋 때 749)·`browser-conversations`·`browser-route`·`browser-ai-settings-smoke`·`browser-concurrent-work` 통과. `browser-conversations`·`browser-route`는 2026-10-01 main(`a8c3d08`)에서 다시 통과
  - 남음: 실제 CLI로 모델 바꾸기 인계 확인(설치본 묶음 릴리스 때)

## 순서와 의존

- T-049는 M1에서 PLAN-22 T-046과 함께 한다.
- T-059와 T-060은 바로 시작할 수 있다. T-060은 세션과 독립이다.
- T-061은 T-060·PLAN-22 T-045 뒤다(세션 이어 실행은 T-059 합격 항목만). T-062는 T-061 뒤다. PLAN-22 T-063(만들기 대화)이 이 둘을 쓴다.
- 마일스톤 표기는 S-06 결과를 먼저 보이는 순서(M5)이지만, 선행이 갖춰진 티켓은 먼저 해도 된다.
- 바로 적용: T-069 → T-070·T-071 → T-072 → T-073·T-074. T-075는 독립이다. 실제 호스트 확인은 플러그인 재빌드·설치 뒤 묶어서 한다.

## 현황 {#status}

각 티켓의 **상태** 항목이 현재 상태다(2026-10-01). 티켓 사이의 요약은 [PLAN §6.5](PLAN.md)가 가지고, 물결(1~8차)별 경과는 Git 이력(`4f5f43a`·`c67bf57`·`6b70f34`·`c972e23`·`32bf8be`·`c8443db`·`d8fb2ba`·`792e31d`·`0fb9506`)에 있다.

이 계획에 함께 적혀 있던 티켓 밖 항목:

- **설치본 0.2.11 핫픽스(`792e31d`) — 구현·자동 검증, 설치본 확인 남음.** 엔진 재시작 뒤 입력창이 잠긴 채 남던 문제(`src/ui/connection-recovery.ts`, `#connection-banner` [다시 연결], 1→2→4→8초 자동 재시도, 401은 수동), 엔진 쪽 프로젝트 삭제(`DELETE /api/v1/projects/:id`, 원격 차단, `Store.deleteProject`·`src/server/project-removal.ts`, 선택기 삭제 확인), 바로 적용의 진행 단계 이름(준비 → 요청 이해 → 모델 조회 → 실행 → 답변 정리)과 로그인 확인 캐시·`request-stages` 로그. 증거: `browser-composer-ready.mjs`(`test:browser`에 포함), `tests/core/connection-recovery.test.mjs`, `tests/server/request-stages.test.mjs`. 남음: 설치본에서 재시작·삭제·Rhino 플러그인 Link 목록 확인. 엔진 비정상 종료의 원인은 그때 로그에 남지 않았고, 종료 코드 기록은 [PLAN-27](PLAN-27-sync-storage-stability.md) T-082(`9aac8cd`)가 맡는다.
- **사이트에서 지운 프로젝트는 PC에서도 지움(`5274ac3`, 2026-10-01 사용자 결정).** 정본은 [SPEC-01.1](../specs/SPEC-01-project-input-sync.md)과 [PLAN-10](PLAN-10-account-workspace.md)(PLAN §6.5 PLAN-10 행)이다. heartbeat의 `deleted:true`와 엔진 시작 때 `removed-projects.json`으로 앱 삭제와 같은 `purgeProject`를 부른다. 증거: `tests/server/project-delete.test.mjs`, 실제 DB 사본에서 594 MB → 9.9 MB. 옛 나진상가(4ba343ff)의 지식 DB·구조 조건 메모는 사용자 요청으로 새 나진상가(404d0e4b)로 옮겼다. 남음: 설치본 확인.
