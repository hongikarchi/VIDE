---
id: PLAN-24
title: AI 대화 세션·동시 진행·말로 하는 경로 판정 1차
status: review
version: 0.2
updated: 2026-09-30
owner: agent:claude
related: [PLAN, PLAN-22, PLAN-23, PLAN-02, PLAN-05, PLAN-08, PLAN-19, FR-25, FR-24, FR-18, FR-10, FR-11, FR-12, AC-46, AC-47, AC-48, AC-38, SPEC-02, SPEC-07, ARCH-01, ARCH-03, ADR-021, ADR-014, ADR-022, RESEARCH-10, RESEARCH-11]
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
    - 앱 조작과 jig 열기는 제안 카드로 보이고 SPEC-02.19의 7 등급대로 실행한다: Sync 받기·jig 열기는 T1, 로그인 시작·계정 전환은 T2, 코드 입력은 M 안내
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
    - "codex 로그인해줘" → 로그인돼 있으면 알림, 아니면 T2 카드
    - "다른 파일 sync해줘" → T1 카드
    - 입력 조립 역할 제안
  - 실패:
    - 범위 밖 값은 적용하지 않고 범위를 안내함
    - 고지를 끄면 Jev 호출 0
    - `/route` 요청 본문에 파일 이름·경로가 없음
    - 키 없음·확신 낮음·HTTP 실패·지연은 규칙 경로로 감
    - 잘못 판정하면 'AI 작업으로 보내기'로 되돌림
    - 원격 세션에서 계정 전환 카드 실행은 거절됨
  - 회귀: `tests/ai/request-router.test.mjs`, `browser-route.mjs`
  - 실제 Jev: 합성 문장 정확도 기록(PLAN-19 방식)
- **완료:** 위 시험 통과와 정확도 기록.

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
- **상태(2026-09-30):** 구현·검증 완료. 판 범위 밖 거절(`CLI_VERSION_UNSUPPORTED`), `CLI_MODE_CHANGED`, 캐시 토큰 기록이 단위 시험과 설치본 실행을 통과했다. SPIKE 결과([SPIKE-2026-09-30-cli-session-resume](../tdd/SPIKE-2026-09-30-cli-session-resume.md)):
  - 합격: ①②⑤⑥⑦(`--system-prompt-snapshot off`)⑧
  - ③ 실패 재현 → 인계만
  - ④ 조건부: 중립 `developer_instructions`와 `-c sandbox_mode`가 필요해 Codex는 원장 방식 유지
  - ⑨ 한 종류만 기록
  - 두 오류 코드의 화면 문구는 코드 검토(2026-09-30)에서 `src/ui/gateway.ts`에 넣었다. 확인한 판 범위는 `src/ai/cli-compat.json`(Claude ≥ 2.1.284 < 2.2.0, Codex ≥ 0.157.0 < 0.158.0)이며, CLI가 그 위로 자동 갱신되면 SPIKE를 다시 돌려 범위를 넓히기 전까지 AI 실행이 거절된다

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

### T-061 · 대화 스레드와 세션 실행 {#t-061}

- **목적/기준:** 결정 F1·A2. 대화 = 목적별 작업 흐름이다. 턴마다 새 프로세스를 띄워 세션으로 잇고, 토큰·상한·도구 범위는 턴마다 다시 발급한다. VIDE의 원장·jig 작업본·초안 파일이 정본이므로 세션을 잃어도 작업을 잃지 않는다. FR-25, SPEC-02.17의 5·6, SPEC-02.19의 1~5, ADR-021, ARCH-01 §2, ARCH-03 §10, AC-46·47.
- **변경 범위:**
  - 새 `src/server/conversations.ts`
    - 대화 만들기·닫기·목록
    - 원장 기록: 가정·질문·답·결정·코드·설정값 변경·결과·인계
    - AI 없이 처리한 설정값·앱·jig 열기 결과도 지금 대화에 카드로 남기고 원장에 기록한다
    - Sync 받기·jig 입력 읽기·Rhino에 만들기는 대화에 속하지 않고, 대화에서 시작했으면 결과 카드만 남긴다
  - 대화 시작 때 Jev가 종류·공급자·모델·effort를 정하고 계정을 `accountUsage.choose`로 고정한다. effort는 같은 공급자 안에서 턴마다 바꿀 수 있다
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
    - 계정 한도: 끝난 턴은 자동으로 다시 보내지 않는다. 자동 전환이 켜져 있으면 다음 턴부터 같은 공급자의 여유 계정 새 세션 + 인계 자료를 쓰고, 꺼져 있으면 T2 계정 전환 카드를 보인다
    - 공급자·모델 바꾸기: 사용자가 [다른 AI로 이어 가기]를 누르면 T2 카드(바뀌는 공급자·전송 범위)를 보인 뒤 새 세션을 연다
    - 이어 쓰기 실패·종료 미확인·재시작으로 끊긴 턴: 그 세션을 다시 쓰지 않는다. 이전 프로세스 종료를 확인한 뒤 인계 자료로 새 세션을 연다(방식은 ARCH-01 §2)
    - 대화가 길어짐: 정한 턴 수·누적 입력량을 넘으면 원장으로 새 세션을 연다. 시작값은 12턴·누적 150k 토큰이고, SPIKE ⑨ 측정 뒤 설정 기본값을 확정한다
  - 기록 관리: 닫고 30일 뒤 공급자 기록 삭제, 버린 jig 초안의 기록은 바로 삭제, 백업 제외. 기록을 지운 뒤 다시 연 대화는 원장으로 새 세션을 연다
  - 새 `src/ui/conversations.tsx`: 대화 칩, 진행 중·안 읽음 점, 대기 수, 새 대화 제안 카드(`same_conversation`이 낮을 때, 자동으로 나누지 않음)
  - `work-view.tsx`: 대화 필터. 패널 모드는 대상 문서 필터를 유지하고 대화 칩을 그리지 않는다
  - 기존 요청과 패널에서 보낸 요청은 프로젝트 기본 대화다(`conversationId = NULL`)
- **선행:** PLAN-22 T-045, T-060. 대화·원장·원장 방식은 SPIKE를 기다리지 않고, 세션 이어 실행만 T-059의 합격 항목(①②⑤⑥⑦)을 기다린다(ADR-021).
- **검증:**
  - 정상: 3턴 대화에서 AI가 앞 턴의 코드·오류를 참조, **대화 3개 동시(모델 편집 + CAD 편집 + 법규 질문) 접수·완료**, 덧붙인 말 대기·[멈추고 이걸로] 중단, 대화 동안 공급자·모델 불변, 기존 요청이 기본 대화로 보임
  - 실패: 계정 한도 모의 → 자동 다시 보내기 없음·인계 자료로 새 세션 또는 T2 카드, 종료 미확인 뒤 같은 세션을 두 실행이 쓰지 않음, 이력 속 옛 대상은 `TARGET_MISMATCH`, 매 턴 도구·MCP 목록이 그 턴 인자와 다르면 실행하지 않음, Codex 원장 방식
  - 회귀: `browser-host-panel.mjs`
- **완료:** 위 시험 통과와 5턴 대화 2종의 토큰 기록.

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

### 지침 묶음·AI 동등성 {#ai-parity}

- **목적/기준:** VIDE 안의 AI가 같은 요청에서 터미널 Claude Code만큼 모델링하게 한다. 사용자 결정(2026-09-30)에 따라 공급자 기본 시스템 프롬프트를 유지하고 VIDE 지시 묶음을 덧붙인다. 공급자 skill·plugin은 끄고, 쓸모 있는 skill 내용은 묶음으로 옮긴다. 쓰기는 작업 사본 → 후보 → 반영만 쓴다. 차이의 원인과 비교 방법은 [RESEARCH-11](../research/RESEARCH-11-ai-parity.md), 물리 계약은 ARCH-01 §2·§3, 안전 문장은 ADR-014(`common.md`로 옮기되 빠지는 것 없음), 세션은 ADR-021과 SPEC-02.19를 따른다. FR-25.
- **변경 범위:** `src/ai/instructions/`(`common.md`·`modeling.md`·`modeling-rhino.md`·`modeling-cad.md`·`data.md`·`make.md`, `index.ts`의 `bundleFor(mode, projectAddendum?)`: 크기 상한, 추가분은 자료로 다룸), Claude 매 턴 `--append-system-prompt <묶음>`(세션 포함, 이번 턴 규칙은 user 메시지), Codex 세션 첫 턴 `developer_instructions`, 프로젝트 추가분 `GET/PUT /api/v1/projects/:id/ai-instructions`(≤ 8 KB)와 AI 설정 대화상자, 보기 캡처·측정 도구, 대화 턴 상한(`conversationTurnLimits`), 넓힌 읽기(`query` 커서).
- **선행:** T-061, T-062. 캡처 도구는 Rhino 작업자 쪽 구현이 있어야 실제 확인할 수 있다.
- **검증:**
  - 정상: 모드별 묶음에 공통 + 해당 모드 본문이 들어가고, 모델링 모드에는 Rhino·CAD 노하우 두 파일이 들어감. 매 턴(세션 이어 실행 포함) Claude 인자에 `--append-system-prompt`가 있고 `--system-prompt`로 기본 프롬프트를 바꾸지 않음. Codex는 세션 첫 턴에만 `developer_instructions`로 같은 본문을 받음. 격리 인자와 시작 이벤트의 도구 검사는 전과 같음. 프로젝트 추가분이 저장·표시·수정되고 묶음 끝에 자료로 붙음. ADR-014의 안전 문장이 모두 `common.md`에 있음
  - 실패: 8 KB를 넘는 추가분은 거절. 추가분 안의 지시 흉내(권한·도구 요구)는 권한을 넓히지 않음. 묶음 크기가 상한을 넘으면 정해진 순서로 줄이고 공통 본문은 줄이지 않음. 원격 세션의 추가분 수정은 기존 설정 규칙(원격 PUT 차단)을 따름. 묶음에 프로젝트·고객 이름이나 MCP 전용 명령이 없음
  - 비교: RESEARCH-11 §4의 A/B(합성 요청 5개, 성공·수정 요청 수·소요 시간·토큰)를 Rhino가 비어 있을 때 돌려 `docs/tdd/VERIFY-YYYY-MM-DD-ai-parity.md`에 남김
- **완료:** 위 단위·계약 시험 통과, A/B 한 번 기록. A/B 합격 기준(B 성공 수 ≥ A, 수정 요청 수 중앙값 ≤ A + 1, 소요 시간 중앙값 ≤ A의 1.5배)에 못 미치는 요청은 원인 행과 후속 조치를 현황에 적는다.

## 바로 적용·계획/자동 모드 {#direct-apply}

사용자 결정(2026-09-30, [ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md))으로 AI 편집은 연결된 Rhino·ZWCAD 문서에서 실행 하나당 되돌리기 기록 하나로 바로 실행하고, 권한 선택(검토/후보/적용)은 계획·자동 두 모드로 바뀐다. 사본 → 후보 → 적용 경로(ADR-014)는 제품 흐름에서 빠진다. 기준: PRD §11.2·FR-10~12·AC-38, SPEC-02.11·.13·.20, ARCH-01 §4 「바로 적용 경로」. 공통 검증: 정상 실행·보호 동작·되돌리기(최신 기록만)·응답 잃음의 네 경우를 단위 시험으로, 실제 호스트 확인은 플러그인 설치 뒤 한다.

### T-069 · 문서 기준 정리 {#t-069}

- **변경 범위:** ADR-022 새로 씀, PRD·SPEC-02·ARCH-01을 바로 적용과 두 모드 기준으로 고침, ADR-003·011·014에 후속 결정 메모.
- **완료:** `npm run docs:check` 통과, 문서 사이와 코드의 보호 판정이 일치.

### T-070 · Rhino 바로 실행·되돌리기·보호 {#t-070}

- **변경 범위:** `hosts/rhino/worker/DirectExecution.cs`(`direct-execute`·`direct-undo`·`fingerprint`), `AttachedConnection.cs`·`CodePolicy.cs`(생성 코드의 되돌리기 제어 금지, purge 사전 판정), `application-contract.ts`·`editor-channel.ts`·`editor-sessions.ts`.
- **검증:** 계약 시험(`tests/core/host-documents-contract.test.mjs`), 스크래치 폴더 빌드. 실제 Rhino에서 대량 삭제·레이어 삭제 보호, Ctrl+Z 뒤 [되돌리기], 빈 실행.
- **완료:** 위 실제 Rhino 확인까지.

### T-071 · ZWCAD 바로 실행·되돌리기·보호 {#t-071}

- **변경 범위:** `hosts/zwcad/connection/AttachedEdit.cs`(한 UNDO 단계 실행, 변경 추적, `Guard()`), `AttachedDocument.cs`(`fingerprint`·`direct-execute`·`direct-undo`), `hosts/zwcad/attached-documents.ts`.
- **검증:** `tests/core/zwcad-direct.test.mjs`, 스크래치 빌드, 실제 ZWCAD 왕복.
- **완료:** 실제 ZWCAD 확인까지.

### T-072 · 서버 계획/자동 모드와 실행 기록 {#t-072}

- **변경 범위:** `src/contracts/workspace.ts`(`mode`, 이전 권한 값 변환, `needs-confirmation`, 보호 해제 필드 거부), `src/server/direct-mode.ts`(`runDirectTurn`·`takePlan`·실행 기록), `execution.ts`(모드 분기·`undo`·`confirm`·`continue`), `sdk-execution.ts`·`zwcad-sdk-execution.ts`·`server.ts`(경로 3개, 원격 확인 차단)·`agent-tools.ts`, `request-scope.ts`의 `hostUse`가 `requestMode`를 읽음.
- **검증:** `tests/server/direct-mode.test.mjs`·`direct-mode-e2e.test.mjs`, `tests/core/workspace-contract.test.mjs`.
- **완료:** 위 시험과 실제 호스트 한 번 왕복.

### T-073 · 화면: 모드 토글·실행 행·확인 카드·계획 카드 {#t-073}

- **변경 범위:** `src/ui/index.html`·`app.ts`(계획/자동 토글, 기본 자동, Shift+Tab, '계획부터' 제안 카드), `work-view.tsx`(실행별 변경 행과 [되돌리기], 진행 확인 카드, 계획 카드 [진행]), `gateway.ts`(오류 문구).
- **검증:** `tests/integration/browser-direct-mode.mjs`.
- **완료:** 브라우저 시험 통과.

### T-074 · jig 만들기의 바로 적용 {#t-074}

- **변경 범위:** `src/jigs/bake/bake.ts`(`runDirectBake`·`undoBake`, 기록된 객체만 바꿈), `src/server/jig-routes.ts`(연결 Rhino는 바로 적용, 없으면 작업 사본).
- **검증:** `tests/core/bake.test.mjs`, 실제 Rhino에서 두 번 만들기·되돌리기.
- **완료:** 실제 Rhino 확인까지.

### T-075 · 공급자 자체 질문 기능 SPIKE와 어댑터 {#t-075}

- **변경 범위:** Claude `AskUserQuestion`을 stream-json 제어 요청으로 받는 `claude-cli.ts` `nativeQuestions`, Codex `codex app-server` 어댑터 `src/ai/codex-app-server.ts`(`VIDE_CODEX_APP_SERVER=1`). 질문 카드 화면은 그대로 둔다(SPEC-02.19).
- **검증:** [SPIKE-2026-09-30-native-questions-claude](../tdd/SPIKE-2026-09-30-native-questions-claude.md)·[SPIKE-2026-09-30-codex-app-server](../tdd/SPIKE-2026-09-30-codex-app-server.md), `tests/ai/native-questions.test.mjs`·`codex-app-server.test.mjs`.
- **완료:** SPIKE 판정 기록. 기본값으로 켜는 것은 사용자 결정 뒤다.

## 순서와 의존

- T-049는 M1에서 PLAN-22 T-046과 함께 한다.
- T-059와 T-060은 바로 시작할 수 있다. T-060은 세션과 독립이다.
- T-061은 T-060·PLAN-22 T-045 뒤다(세션 이어 실행은 T-059 합격 항목만). T-062는 T-061 뒤다. PLAN-22 T-063(만들기 대화)이 이 둘을 쓴다.
- 마일스톤 표기는 S-06 결과를 먼저 보이는 순서(M5)이지만, 선행이 갖춰진 티켓은 먼저 해도 된다.
- 바로 적용: T-069 → T-070·T-071 → T-072 → T-073·T-074. T-075는 독립이다. 실제 호스트 확인은 플러그인 재빌드·설치 뒤 묶어서 한다.

## 현황(2026-09-30)

- **T-049 · 경로 판정 확장·값 추출·단발 입력 제안·전송 고지 — 서버·판정 코드 완료, 작성기 연결 남음(2026-09-30, 코드 검토 2026-09-30).** `src/ui/request-route.ts`(일곱 경로, `decisiveRoute`: 로그인 → Sync → jig 부름말 → 만들기 → 설정값 핵심어+숫자 → 파일 말; `quantities`·`convert`·`paramChange`: 긴 단위 우선·영문자 경계·표시 단위·상대어는 선언 `words` 방향·두 배·반·범위 밖 거절·`fixedAtPin`; `routeCard` 등급 R/T1/T2/auto; `routeAnswer`), `src/ai/request-router.ts`(`judgeRoute`: 한 호출에 target·action·subject·param·app_action·provider·link·jig·jig_fit(Noul ≥ 0.30)·same_conversation·대화를 열 때만 task·domain, `redact`로 경로·파일 이름 제거, `RouteSettings`(FR-18 스위치 `<data>/route-settings.json`), 입력 조립 단발 단계 `inputRolesRequest`·`checkInputRoles`(`ref-whitelist`)), `src/ai/model-router.ts` `needsModel`, `src/server/server.ts`(`/route` 확장·`/route/revert`·`/settings/routing`(원격 PUT 차단), 진단에 본문 없음), `src/ui/ai-settings.tsx`(전송 고지·끄기), `execution.ts`(`input-roles`는 호스트 없음). 검토에서 고친 것: 객체·파일·화면 동작 말이나 한계 말(넘는·이상인 등)이 있으면 설정값 핵심어+숫자 규칙을 쓰지 않는다("경간 12m 넘는 거더 숨겨"가 설정값 변경으로 실행되던 오판). 증거: `tests/core/request-route.test.mjs` 16건, `tests/ai/request-router.test.mjs` 8건(고정 항목만 전송·스위치·키 없음·지연·실패·역할 제안 게이트), `tests/ai/route-http.test.mjs`, `browser-route.mjs` 통과.
- T-049 남음: 작성기 연결은 아래 3차 물결에서 했다. 입력 조립 단계는 T-051이 부른다.
- **T-059 · CLI 버전 점검·캐시 토큰·세션 SPIKE — 완료(2026-09-30).** 상세는 티켓의 상태 항목. `tests/ai/claude-cli.test.mjs`·`codex-cli.test.mjs`(판 범위 밖 거절, `CLI_MODE_CHANGED`, 캐시 토큰) 통과.
- **T-060 · 동시 접수 규칙 개정 — 구현·검증 완료(2026-09-30, 코드 검토 2026-09-30).** `src/contracts/request-scope.ts`(`hostUse` none/read/write와 추론, `requestAdmission`: 같은 문서 쓰기는 문서별 대기열, 읽기는 같은 문서의 원본 반영(ZWCAD 직접 편집 포함)만 기다림, 문서를 알 수 없는 호스트 요청은 그 호스트의 모든 쓰기 뒤, AI 턴 상한 3(설정 2~4), 불명확 결과는 `HOST_RESULT_UNRESOLVED`, 쓰기 경합을 건너뛰는 선언은 `INVALID_INPUT`), `src/core/workspace.ts`(`phase: 'queue'`·`waitingFor` 저장, `admission`·`wait`·`release`), `src/server/execution.ts`(`pump`: 실행이 끝날 때마다 다음을 꺼냄, 대기 중 취소·개입, 호스트 없는 턴에는 호스트 도구 없음), `src/ui/app.ts`(보내기를 끄지 않고 대기 수·순서 표시, `waitingText`). Sync·가져오기·확장은 기다리지 않고 `PROJECT_BUSY`다. 증거: `tests/core/request-scope.test.mjs` 9건, `tests/server/concurrent-intake.test.mjs` 7건(대화 3개 동시, 같은 문서 두 쓰기 대기→실행, 읽기·검토 비거절, 대기 취소·승격, 4번째 AI 턴 대기, 개입의 자리 유지), `browser-concurrent-work.mjs`·`browser-intervention.mjs`·`browser-host-panel.mjs` 통과.
- T-060 남음: 재시작 때 대기 요청은 `interrupted`로 바뀌고 `waitingFor`만 남는다(자동 실행 없음, 화면 문구는 일반 중단). `STALE_REFERENCE`의 [다시 기준 잡기] 카드는 하지 않았다. `WORKSPACE_CAPACITY`는 더 이상 나오지 않는다(문구만 새 규칙에 맞춤). 개입(`[멈추고 이걸로]`)의 대기 처리는 단위 시험만 했다.
- **T-061 · 대화 스레드와 세션 실행 — 서버·CLI 구현·단위 검증 완료, 화면 남음(2026-09-30, 코드 검토 2026-09-30).** `src/server/conversations.ts`(`ConversationService`: 만들기(Jev가 종류·서비스·모델·effort를 정하고 계정은 `accountUsage.choose`로 고정), 목록, 닫기(`discard`면 기록 즉시 삭제), 다시 열기, 원장 기록, `fix`(접수 때 대화의 서비스·모델·계정으로 고정, effort만 턴마다), `hold`(한 대화에 한 턴, 뒤 메시지는 `waitingFor.kind: 'conversation'`으로 대기·철회 가능, 불명확 결과는 줄 멈춤), `beginTurn`/`endTurn`(Claude는 세션 이어 실행: 첫 턴 `--session-id`, 이후 `--resume`, 12턴·150k 토큰을 넘거나 계정·서비스가 바뀌거나 잃으면 원장 + 인계 자료로 새 세션; Codex는 원장 방식), `purge`/`sweep`(닫고 30일 뒤 기록 삭제, 시작 때와 매일), 재시작 복구(끊긴 턴의 세션은 `lost`), HTTP 경로 `…/conversations`·`:cid/close|reopen|ledger|handoff`(handoff는 원격 403)), `src/ai/claude-cli.ts`(`sessionArguments`: `--no-session-persistence`만 빼고 격리 인자 유지 + 중립 프롬프트 + `--system-prompt-snapshot off`, 이번 턴 규칙은 자료 항목 `turn-rules`, `SESSION_LOST` 분류, `removeClaudeTranscript`), `src/ai/codex-cli.ts`(세션 인자 계약과 `removeCodexTranscript`; SPIKE ④ 전에는 켜지 않음), `src/ai/agent-connection.ts`(`neutralInstruction`·`turnRules`), `src/server/execution.ts`(턴 시작·끝, 세션 턴은 이전 교환을 싣지 않음, `SESSION_LOST`는 새 세션으로 1회 재시도), `src/server/server.ts`(접수 때 `fix`, 경로, 기록 정리 타이머), `src/core/conversation-store.ts`(`closedBefore`·`ledger(since)`·서비스 인계), `src/contracts/workspace.ts`(`conversationId`). 증거: `tests/server/conversations.test.mjs` 14건(3턴 이어 실행과 매 턴 격리 인자, 시작 이벤트의 도구 불일치 중단, 실패한 첫 턴은 새 ID, 기본 대화, 계정 전환 인계, 잃은 세션 1회 재시도, Codex 원장, 대화별 대기와 철회, 턴 상한·닫힌 대화 거절, 기록 삭제·30일, 재시작 복구, 원장 8 KB, HTTP), `tests/ai/claude-cli.test.mjs`·`codex-cli.test.mjs`(세션 인자, 중립 프롬프트, `SESSION_LOST`, 기록 삭제 범위) 통과.
- T-061 남음(서버 쪽, 화면은 아래 3차 물결): 실제 CLI로 5턴 대화 2종의 토큰 기록은 하지 않았다(모의 CLI만). 대화 길이 상한(12턴·150k)은 상수이며 설정이 없다. 대화 만들기·닫기는 원격 세션도 할 수 있다(요청과 같은 범위; handoff만 403). 연계 요청(`linkedTargets`)의 턴은 원장 항목만 싣고 이전 교환 선별은 하지 않는다.
- T-049 작성기 연결(2026-09-30 3차): `src/ui/app.ts`가 서버 `/route` 답을 모든 경로로 읽는다. `param`은 AI 없이 `PUT …/jig-instances/:iid/params`로 적용하고 [되돌리기]·[AI 작업으로 보내기] 알림을 띄운다. `jig`는 제안 카드, `app`은 T1(Sync는 버튼 카드로 확인 뒤 실행)·T2 확인 카드, 나머지는 AI로 보낸다. [AI 작업으로 보내기]는 한 일을 되돌리고 `/route/revert`에 `{target, by}`만 남긴다. 증거: `tests/core/request-route.test.mjs`. 새 `tests/integration/browser-conversations.mjs`는 아직 돌리지 않았다. 남음: 요청창에서 바꾼 설정값이 열린 jig 패널에 자동 반영되지 않는다. 실제 Jev 정확도 기록은 하지 않았다.
- T-061 화면(2026-09-30 3차): `src/ui/conversations.tsx`(대화 칩·● 진행·◌ 안 읽음·대기 수·더보기·새 대화, 머리 줄의 공급자·모델·계정, [다른 AI로 이어 가기] T2 카드·계정 한도 카드·인계 표시)와 `work-view.tsx`의 대화 필터, 새 요청의 `conversationId`를 넣었다. 증거: `tests/core/conversations-ui.test.mjs` 6건. 남음: 브라우저 시험, 실제 CLI 5턴 토큰 기록, 대화 길이 상한 설정.
- **T-062 · 대화 도구와 질문 카드 — 구현·단위 검증(2026-09-30), 설치본 도구 연결 남음.** 구조화 턴 출력(`src/server/turn-output.ts`: strict JSON 스키마, 질문 ≤ 3·선택지 2~5, 권장 선택지를 앞으로, 원장에 있는 질문 제외, 질문 id는 결정 이름; Claude `--json-schema`, Codex `--output-schema`)과 질문 카드(`src/ui/question-card.tsx`: 가장 최근 성공 턴이 질문으로 끝났을 때 작업 보기에 표시, 답은 `…/conversations/:cid/answer`)를 넣었다. 대상은 호스트·jig 검토가 아닌 대화 턴이다. 도구 등록부(`src/server/agent-tools.ts`)에 `jig_list`·`jig_state`·`jig_output`·`jig_set`·`jig_run`·`structure_summary`·`structure_checks`·`links_layers`·`sync_sample`을 더했다(대화 범위, `jig_set`·`jig_run`은 대화에 작업본이 있을 때만, `confirmed` 실행 불가, 호스트 문서에 쓰지 않음). 증거: `tests/server/turn-output.test.mjs` 8건·`agent-tools-jig.test.mjs` 7건. 남음: `server.ts`가 `AgentTools`에 엔진 주소(`origin`)를 넘기지 않아 **설치본에서는 도구가 켜지지 않는다**. AI가 `jig_set`·`jig_run`을 사람 확인 없이 부르는 것이 SPEC-02.17·.19(말로는 설정값 변경만 바로 실행)와 맞는지 사용자 결정이 필요하다. 실제 CLI로 구조화 출력을 확인하지 않았다. 자료 도구(T-065)와 `project_*` 도구는 뒤다.
- T-049 남음 정리(4차): 요청창에서 바꾼 설정값은 이제 열린 jig 패널이 `vide:jig-params-changed`로 다시 읽는다(PLAN-22 T-057 4차).
- **T-061 4차 물결 — Codex 세션 이어 실행 켬, 계정 한도 인계 서버 흐름(2026-09-30).** `codex-cli.ts`: 중립 지시 `codexSessionInstruction`, spawn 직전 격리 단언 `codexTurnIsolated`(어긋나면 `UNEXPECTED_TOOL_ACCESS`), `thread.started`의 thread ID를 `sessionId`로 돌려줌, resume 턴 사용량은 `usageScope: 'session'`, 세션 잃음 분류 확장. SPIKE ④ 재시험 통과로 `SESSION_PROVIDERS['codex-cli']`를 켰다([SPIKE-2026-09-30-cli-session-resume](../tdd/SPIKE-2026-09-30-cli-session-resume.md) ④ 재시험). `conversations.ts`: Codex 세션 행은 보고된 thread ID로 만들고, 한도로 멈춘 턴은 T2 카드 자료를 만들며 확인하면 다른 계정으로 옮겨 다음 턴이 인계 자료로 새 세션을 연다. 증거: `tests/ai/codex-cli.test.mjs`·`tests/server/conversations.test.mjs`. 남음: 한도 카드의 화면 연결, 브라우저 시험, 실제 CLI 5턴 토큰 기록, 대화 길이 상한 설정.
- **T-062 4차 물결(2026-09-30).** `server.ts`가 `AgentTools`에 엔진 `origin`을 넘겨 설치본에서도 대화 턴이 도구를 받는다(`tests/server/agent-tools-origin.test.mjs`). 사용자 결정(2026-09-30)으로 대화 안의 AI는 그 대화에 열린 jig에 한해 `jig_set`(되돌릴 수 있는 T1, 원장 + [되돌리기])·`jig_run`(계산 단계만)을 확인 없이 실행하며 해석 확정·Rhino 만들기·반영·계정 동작은 사람이 누른다(SPEC-02.19 0.34). 자료 도구 `project_*`는 PLAN-22 T-065에 있다. 남음: 대화 읽기 도구(`jig_list`·`jig_state`·`jig_output` 등)가 요구하는 `targetRef`를 모델이 받을 경로가 없다(턴 규칙에 싣는 방안, VERIFY-2026-09-30-jig-authoring-m5). 실제 CLI 구조화 출력 확인, `browser-conversations.mjs` 실행.
- **T-061·T-062 5차 물결(2026-09-30).** 대화 대상(`targetRef`·열린 jig·연결 id와 호스트)을 `scopeRules`로 턴 규칙에 싣고, 대상이 하나뿐이면 대화 도구가 `targetRef` 없이, jig 도구가 `instanceId` 없이 호출돼도 받는다(`query`·`execute`는 여전히 필수). 대화 길이 기준(12턴·150,000 토큰)을 설정값(`GET/PUT /api/v1/settings/conversations`, 원격 PUT 차단)으로 바꾸고, 기준을 넘으면 새 세션을 **제안**하는 카드(`…/renew`)를 둔다. 계정 한도 카드는 서버 상태로 그리고 `…/account`가 남은 계정을 고른다. 증거: 관련 단위 시험 45건, `npm run typecheck`. 남음: SPEC-02.19 표의 '대화가 길어짐' 행은 자동으로 새 세션을 연다고 적혀 있어 제안 방식과 어긋난다(사용자 확인 필요). `browser-conversations.mjs`는 고치기만 하고 돌리지 않았다. 실제 CLI 5턴 토큰 기록.
- **지침 묶음·AI 동등성 — 구현·단위 검증, Claude 실호출 확인, 실호스트·A/B 남음(2026-09-30 5차).** `src/ai/instructions/`(`common`·`modeling`·`modeling-rhino`·`modeling-cad`·`data`·`make`·`index.ts` `bundleFor(mode, addendum?, {host})`, 묶음 20,000자·추가분 8 KB, 추가분은 제어·방향 문자 제거 뒤 `<project-notes>` 자료 블록, Codex 명령줄 비용으로 잘라 Windows 32,767자 상한 안), `project-store.ts`와 `GET/PUT /api/v1/projects/:id/ai-instructions`, AI 설정의 추가 지침 편집. Claude는 매 턴 `--append-system-prompt`(`--system-prompt` 없음), Codex는 `developer_instructions`로 같은 본문을 받고 격리 인자는 전과 같다. 보기 도구 `capture_view`(PNG ≤ 1 MB, 카메라·레이어 복원)·`measure`(`hosts/rhino/worker/ViewTools.cs`, `hosts/rhino/view-tools.ts`, `agent-tools.ts` `visionHandlers`)와 요청 이미지(최대 3개·각 1 MB, data URL만). 대화 턴 상한 `conversationTurnLimits` 100회·48 명령·600초(답 턴·만들기 포함)와 `query` 커서(`"<revision>:<offset>"`). 조사·비교 방법은 [RESEARCH-11](../research/RESEARCH-11-ai-parity.md), A/B 도구 `tools/ab/`(요청 5개·판정·SVG, 시험 7건). 증거: `tests/ai/instructions.test.mjs`(10건, 따옴표 많은 추가분 포함)·`cli-images.test.mjs`, `tests/server/agent-tools-vision.test.mjs`·`query-page.test.mjs`, `tests/core/execution-limits.test.mjs`, 기존 `tests/ai` 통과, [SPIKE-2026-09-30-instruction-bundle](../tdd/SPIKE-2026-09-30-instruction-bundle.md)(Claude 2턴: 묶음 도달·세션 이어 실행·기록 파일 삭제, 고친 통합 문제 2건). 남음: **Rhino 플러그인 재빌드**(실행 중인 Rhino가 `VIDE.Worker.rhp`를 잠가 복사 실패, 컴파일은 오류 0)와 실제 캡처·측정 확인, **A/B 실행**([SPIKE-2026-09-30-ai-parity-ab](../tdd/SPIKE-2026-09-30-ai-parity-ab.md), 사용자가 `tools/ab/fixture.py`로 합성 문서를 만든 뒤), Codex·모델링 모드 실호출, SPEC-02.6이 적은 호스트 모델링 턴의 `links_layers`·`sync_sample`·`project_*` 발급(코드 미반영), 원격 기기의 추가 지침 PUT 허용 여부(SPEC-02 결정).
- **바로 적용·계획/자동 6차 물결(2026-09-30).** 사용자 결정 ADR-022를 문서와 코드에 반영했다. 증거는 단위 시험과 스크래치 폴더 빌드까지이고, 실제 Rhino·ZWCAD·브라우저 시험은 돌리지 않았다.
  - **T-069 — 완료.** ADR-022(approved), PRD 0.13, SPEC-02 0.36(§02.20 계획과 자동 추가), ARCH-01 0.53. 점검에서 보호 목록을 PRD §11.2 한 곳으로 모으고, 판정 방식(Rhino purge는 실행 전 코드 판정, ZWCAD는 실행 뒤 개수, 저장·내보내기는 AI 코드에서 컴파일 때 거절)을 SPEC-02.13 표에 맞췄다.
  - **T-070 — 실제 Rhino 8 확인(2026-09-30 7차).** Rhino `direct-execute`(되돌리기 기록 하나, 변경 목록, 삭제 50개 초과·레이어 삭제는 기록을 되돌리고 `guarded`, purge는 실행 전 거절, 같은 `requestId` 재전송은 이전 결과), `direct-undo`, `fingerprint`. 숨김 Rhino·합성 문서(객체 73)에서 추가 3 → 되돌리기 73·다시 누르면 `already`, A·B 뒤 A는 `not-latest`, 대량 삭제 60·레이어 삭제·purge 보호, 실패 본문 `reverted`, Rhino `_Undo` 뒤 [되돌리기] `already` 모두 통과([VERIFY-2026-09-30-direct-apply-rhino](../tdd/VERIFY-2026-09-30-direct-apply-rhino.md), `tests/integration/rhino-direct-apply.mjs`, 공용 개발 빌드로 재실행 `passed: true`). 고친 것: 명령 밖 `RhinoDoc.Undo()/Redo()`가 연 기록을 닫고(`CloseOwnRecord`) 뒤 기록이 모두 되돌려졌거나 빈 기록이면 최신으로 봄 — 전에는 되돌리기 뒤 다음 실행이 `UNDO_UNAVAILABLE` → `HOST_RESULT_UNKNOWN`. 남음: 설치본 0.2.11에서 확인.
  - **T-071 — 코드 완료, 실호스트 막힘(2026-09-30 7차).** ZWCAD 한 UNDO 단계 실행과 보호(레이어 삭제 → purge → 대량 삭제 순), `direct-undo`는 `_.U` 뒤 `VIDEAIUNDONE`으로 확인. `tests/core/zwcad-direct.test.mjs` 4건. 실제 ZWCAD 시험은 합성 DWG(객체 62) 연결·첫 Sync까지 됐으나, 시작 때 자동 로드되는 설치본 연결 플러그인(0.2.10)이 개발 빌드 `NETLOAD`를 가려 `fingerprint`가 `UNSUPPORTED_METHOD`로 끝났다([VERIFY-2026-09-30-direct-apply-zwcad](../tdd/VERIFY-2026-09-30-direct-apply-zwcad.md)). 남음: 0.2.11 설치 뒤 `.vide/h4/run.mjs`로 재실행. `VIDECADConnect`가 프로젝트 선택 창을 띄워 숨김 ZWCAD 시험(`zwcad-attached.mjs` 포함)이 멈춘다.
  - **T-072 — 구현·단위 검증, Rhino 왕복 확인.** 자동은 연결 문서에 바로 실행하고 `executions[]`(적용·되돌림·보호·확인)를 남기며, 계획은 읽기 도구(`query`·`capture_view`·`measure`)만 받고 계획 카드로 끝난다. 경로 `POST …/requests/:rid/undo|confirm|continue`. 안전 점검에서 고친 것: 되돌리지 못한 실패·보호 실행은 결과 불명(`unknown`)으로 턴을 막음, 실행마다 문서 판 기록, 실행 중 [되돌리기]는 `REVISION_CONFLICT`, 요청에 보호 해제 필드를 넣으면 `INVALID_INPUT`, 원격 세션의 확인은 `FORBIDDEN`, ZWCAD 실행마다 새 id·보호 걸린 실행 하나만 재실행·부분 결과 보존, 삭제된 질문 요청에 답해도 답이 취소되지 않음. 증거: `tests/server/direct-mode.test.mjs`·`direct-mode-e2e.test.mjs`, `tests/core/workspace-contract.test.mjs`, `npm run typecheck`. 실제 Rhino 왕복(자동 모드 실행·[되돌리기]·[진행] 확인·보기 도구 `capture_view` 1600×900 PNG·`measure`)은 T-070 VERIFY에서 통과. 고친 것: Rhino 쪽 되돌리기 뒤 [되돌리기] 응답이 `already`를 전한다(`execution.ts`), 숨김 Rhino에서 `capture_view`가 흰 화면이던 것을 `RhinoView.CaptureToBitmap`으로(`ViewTools.cs`). A/B([SPIKE-2026-09-30-ai-parity-ab](../tdd/SPIKE-2026-09-30-ai-parity-ab.md)) 5/5 성공이나 시간은 터미널의 2~4배. 남음: 바로 적용의 `unknown` 요청을 풀 경로 없음(같은 문서 쓰기가 계속 막힘), `IsValid` 금지로 첫 실행이 한 번씩 헛돎, ZWCAD 왕복.
  - **T-073 — 구현, 브라우저 시험 남음.** 모드 토글(기본 자동, 프로젝트별 기억, Shift+Tab), 실행 행과 [되돌리기](최신 기록이 아니면 Ctrl+Z 안내), 진행 확인 카드, 계획 카드 [진행], '계획부터' 제안 카드. 예전 결과는 기존 후보 화면으로 보인다. 남음: `tests/integration/browser-direct-mode.mjs` 실행.
  - **T-074 — 합성 문서·S-06 상단선 실제 Rhino 확인(2026-09-30 7차).** 연결 Rhino의 jig 만들기는 본문마다 되돌리기 기록 하나로 바로 적용하고, 기록되지 않은 객체를 지우면 되돌리고 `BAKE_GUARDED`, 마지막 만들기의 [되돌리기]를 둔다. `rhino-bake.mjs` 통과(객체 27, 본문 4 = 기록 4, 두 번째 만들기 교체 24·보존 2, [되돌리기]로 기록 4개 모두 복구, 곧은 부재 7개 웨브 수직, 숨긴 레이어 `hidden-target`; 공용 개발 빌드로 재실행 통과). S-06 사본 상단선 161: 첫 만들기 3.1초, 재만들기 교체 161·중복 0, 이동한 선 1개 보존, [되돌리기] 복구([SPIKE-2026-09-30-jig-bake](../tdd/SPIKE-2026-09-30-jig-bake.md)). 고친 것: 본문 여럿인 실행의 [되돌리기]가 두 번째 기록부터 실패하던 것(T-070과 같은 `DirectExecution.cs` 수정). 남음: 엔진의 저장소 jig 자식 프로세스에 작업 스레드 권한이 없어 S-06 해석이 `unavailable`(`ERR_ACCESS_DENIED`) — 실데이터 부재 만들기 미확인(ARCH-03 §6.4·PLAN-23 결정), 연결 둘일 때 `/bake`의 `linkId` 필수, 되돌리기 id는 엔진 메모리에만 있음.
  - **T-075 — SPIKE 합격, 어댑터는 꺼 둠.** Claude는 `--permission-prompt-tool stdio`로 `AskUserQuestion`을 같은 실행 안에서 받는다(실제 CLI 합성 턴, 150초 지연 통과). Codex는 `app-server`의 `requestUserInput`을 턴 중에 받고 프로세스를 대화 사이에 유지한다(격리는 스레드 설정·응답·MCP 상태로 확인). 서버는 Claude `nativeQuestions`를 넘기지 않고, Codex는 `VIDE_CODEX_APP_SERVER=1`일 때만 켠다(엔진을 닫을 때 프로세스 정리). 남음: 기본값으로 켤지 사용자 결정, 실제 대화에서 장시간 사용.
- **5차 남은 것 정리(2026-09-30 6차).** SPEC-02.19 '대화가 길어짐' 행을 제안 방식([새 세션으로 이어가기] 카드, 누르기 전에는 지금 세션)으로 고쳤다. 원격 세션의 추가 지침 변경(`ai-instructions` GET 외)을 막았다. 멈춘 만들기 대화에는 파일 도구를 주지 않는다(`makeStopped`, PLAN-22 T-063). 남음: 호스트 모델링 턴의 `links_layers`·`sync_sample`·`project_*`는 `execution.ts`의 `HOST_TURN_PROJECT_TOOLS`·`hostTurnProjectHandlers`만 있고 호스트 도구 목록에 연결하지 않았다.
