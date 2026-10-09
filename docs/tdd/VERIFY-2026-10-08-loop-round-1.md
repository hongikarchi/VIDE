---
id: VERIFY-2026-10-08-loop-round-1
title: 검증–수정 루프 라운드 1 — 사용자 문장 시나리오·페르소나·스코어카드
status: review
version: 0.1
updated: 2026-10-08
owner: agent:claude
related: [PLAN-51, T-264, T-265, T-266, T-267, T-268, AC-22, AC-48, SPEC-02, SPEC-06, SPEC-07, SPEC-12, SPEC-15]
---

# 검증–수정 루프 라운드 1

[PLAN-51](../plans/PLAN-51-verify-loop.md) §3의 1회차 시나리오를 설치본 페르소나(L1), 개발 엔진 시나리오 러너(L0 route-only), 에이전트가 띄운 Rhino(L1')로 돌린 기록이다. 판정 등급은 PLAN-51 §1·§2를 따른다. 페르소나의 직관·쉬움 판정은 모두 **대행 판정**이다. 스코어카드 판정(`tools/ab/scorecard.mjs`)과 검토자가 고친 판정이 다르면 두 값을 함께 적는다.

**요약:** 핵심 편집 경로는 개발 엔진에서 통과했다(R1-COLOR 3/3, A/B R1~R5 5/5). 사용자 문장 시나리오는 설치본에서 하나도 통과하지 못했다. 검토 판정은 P0 5건, P1 1건, P2 2건이다. 시험 도구 결함은 4건으로 따로 센다. 졸업한 시나리오는 0/10이다.

## 범위와 방법

| 항목 | 값 |
|---|---|
| 설치본 | VIDE 0.2.31(엔진 `127.0.0.1:47821`). 플러그인 등록 `…\VIDE\plugins\rhino\0.2.31-9d050376\VIDE.Worker.rhp`. 전용 프로젝트 `검증 루프 R1`(`c8df446e-a7a1-454b-83a3-839ab34c57f9`). 엔진 재시작·설정 변경 없음 |
| 개발 엔진 | HEAD `7e4037fc`와 작업 트리의 `tools/ab`·`tools/persona` 변경(미커밋). 런 폴더 `.vide/loop/r1-dev-11`(자료·로그 포함). 프로젝트 `검증 루프 dev`(`b9814d2c-46e9-43a1-adbd-a813b021abba`). 플러그인은 DEV 빌드 `.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp` |
| 사본 | `.vide/loop/r1/small.3dm`(73,659,852 B)·`large.3dm`(563,437,843 B)·`cad.dwg`+`XREF/`. 페르소나는 `persona-small.3dm`, Sync 성능은 `perf-small.3dm`(small 사본을 다시 복사), A/B는 `.vide/ab/ab-fixture.3dm`의 런별 사본 `.vide/loop/r1-dev-11/ab-fixture.3dm`(16객체, `C-PIN` 포함) |
| 도구 | `tools/ab/run.mjs`(`--plan`, 표시용 Sync가 406 `GEOMETRY_BINARY_REQUIRED`일 때 바이너리로 읽도록 이날 수정), `stages.mjs`, `scorecard.mjs`, `host-session.mjs`(새 파일), `tools/persona/run.mjs`. 시나리오 `tools/ab/scenarios-round1.json`, 페르소나 `tools/persona/scenarios.json`·`personas/intern.md` |
| AI | Claude CLI 2.1.292. 페르소나는 `claude-opus-5-5`. 설치본의 제품 AI는 `claude-opus-5-5`(기본 대화는 effort low, jig 대화는 기본값). 개발 엔진의 제품 AI는 모델을 지정하지 않음(CLI 기본값, 로그 `model: null`). 구독 하나를 쓰므로 AI를 쓰는 단계는 하나씩 돌렸다 |
| 시각(KST, 2026-10-08) | 설치본: Rhino Link·첫 Sync 17:40:41–17:40:44, 페르소나 17:43:00–17:51:53, route-only 17:52:19–17:52:24. 개발 엔진: 세션 18:17:40–18:23:40(route-only 18:17:58–18:18:03, R1-COLOR 18:20:02–18:20:35, A/B 18:20:49–18:23:01, R1-RECONNECT 18:23:25–18:23:27). Sync 성능 18:24:47–18:36:28. 스코어카드 18:36:59 |

**하지 않은 것**
- Computer Use를 쓰지 않았다. 페르소나는 브라우저의 웹 UI만 조작했고, 데스크톱 셸과 Rhino 창은 조작하지 않았다.
- rhino MCP 기준선은 재지 않았다(2회차). 속도는 PLAN-51 §2의 1회차 절대 경보선으로만 본다.
- CAD를 연결하지 않았다. ZWCAD를 띄우지 않아 R1-A 페르소나 런은 Rhino 하나만 연결된 상태다.
- 사용자 동승(L2)은 하지 않았다.
- 공개 필지 실호출을 하지 않았다. R1-B 페르소나가 주소를 넣지 않고 멈췄다.
- 페르소나 요청은 설치 엔진 로그(`%LOCALAPPDATA%\VIDE\logs\engine-2026-10-08.jsonl`)에서 `request-stages`·`request-end`로 이었다. 읽기만 했고, 오보 규칙(M1·M2·M4)은 자동 판정하지 않았다.

**방법상 한계**
- 페르소나 다섯 런은 같은 사본 문서와 같은 프로젝트에서 이어서 돌았다. R1-HIDE에서 AI가 숨긴 객체 2,592개는 뒤 런(R1-D·C·B·A)까지 숨겨진 채였다. 법규 체크 화면에도 '숨김 2592'가 보인다. 기본 대화도 이어졌다.
- R1-D의 마지막 AI 요청(17:47:16–17:47:47)이 끝나기 전에 R1-C 런이 시작됐다. 그래서 17:47:41–17:47:47의 약 6초 동안 AI 요청 두 개가 겹쳤다.

## 시나리오별 스코어카드

열 순서는 PLAN §7.3의 6열(사용자 입력 · 실제 동작 · 보이는 결과 · 다음 행동 · 원본 보호 · 미시험)에 판정을 붙인 것이다. 원본 `scorecard.md`는 아래 증거 경로에 있다. '모르는 말' 목록은 다음 절로 옮겼다.

### 설치본 0.2.31 — 페르소나 + route-only (`.vide/ab/r1-scorecard-installed`)

| 시나리오 | 사용자 입력 | 실제 동작 | 보이는 결과 | 다음 행동 | 원본 보호 | 미시험 | 스코어카드 | 검토 판정 |
|---|---|---|---|---|---|---|---|---|
| R1-HIDE | 보만 남기고 다 숨겨줘 | 경로 view·isolate(Jev). 화면이 대상 0개로 알림을 띄움 → 페르소나가 'AI 작업으로 보내기'를 누름 → 파일 작업 1회(실행 1, 16.3 s, succeeded) | "보 452개를 남기고 2,592개를 숨겼다" · '응답 완료'. 페르소나 6단계 done(전문가 2단계, 비율 3.0) | P2 모르는 말 | 전용 프로젝트 · 사본(Rhino를 저장하지 않고 종료) | 되돌리기 | P2 | **P0** — 기대(AI 없이 화면 변경)가 일반 AI 편집으로 흐름 (T-270) |
| R1-D | 구조 검토하고 싶은데 파악해줘 | 경로 jig `project/s06-frame`(rules). AI 턴 3회(21.1 / 54.1 / 31.3 s, 모두 succeeded) | S-06 jig 열림. 1·3·8단계가 '필요한 입력이 없습니다: site.slab, site.existingFootings'로 막힘. 12단계 상한에서 목표 미도달 · 잘못 누름 1 · 입력 3 | P2 모르는 말 | 해당 없음(경로만) | - | P2 | 경로 PASS · **P2** (T-275) |
| R1-A | 모델링이랑 도면 맞춰줘 | route-only 3회 모두 `document`(rules, LOW_CONFIDENCE, 0.2 s). 페르소나: 파일 작업 1회(실행 1, 11.0 s) | "맞춰 볼 도면이 연결된 자료에 없어 아무것도 고치지 않았다" · '응답 완료'. Sync jig·선택 카드 없음. 페르소나 막힘 1 | P0 경로 불일치 ×3 · 막힘 | 해당 없음 | CAD 연결 상태 | P0 | **P0** 알려진 결함(route-only는 EXPECTED-FAIL) (T-269) |
| R1-C | 법규검토하고, 지금 우리 건물 설계에서 법규 위반 사항 없는지 확인해줘 | 경로 jig `vide/compliance-check`(rules). AI 턴 2회(36.3 / 11.5 s, succeeded). `jig_output` NOT_FOUND, `GET …/compliance/roles` 400 INVALID_INPUT | '탐색용 법규 체크 · 인허가 검토 아님' 표시. 결과 칸은 끝까지 모두 '체크 전'. 안내에 나오는 [법규 체크] 버튼을 찾지 못함. '응답 완료'인데 결과 카드는 'AI가 요약하는 중'에 머묾. 페르소나가 5단계에 stuck 표시(7·8·9 연속), run.json `stuck` 0 | P2 모르는 말 | 해당 없음 | - | P2 | **P0** 막힘 + 결과 표 없음 (T-271, T-272) |
| R1-B | 지금 우리 프로젝트 주변 사이트 모델링 해줘 | 경로 jig `vide/site-model`(rules). AI 턴 1회(16.4 s, succeeded) | '대상 필지 확정 · 확인', '공공 자료원 전송 확인' 뒤 대화가 대지 주소를 물음. 페르소나는 프로젝트 주소가 화면에 없다며 막힘 선언 | P0 막힘 | 해당 없음 | 공개 필지 실호출 | P0 | **P0** (T-273). PLAN §3은 '주소를 사람이 쳐야 하면 P2'로 정했으나 이번에는 막힘으로 끝남 |
| R1-NOTE | 오늘 회의 내용 요약해줘 | 경로 `ask`(Jev, 0.2 s) | - | P0 경로 불일치(기대 note) | 해당 없음 | 답 내용 | P0 | **판정 보류** — 기준 불일치 (T-279) |

스코어카드 집계는 P0 3 · P2 3 · 통과 0/6이다.

### 개발 엔진 — route-only (`.vide/ab/r1-scorecard-dev-route`)

| 시나리오 | 사용자 입력 | 실제 동작 | 보이는 결과 | 다음 행동 | 원본 보호 | 미시험 | 스코어카드 | 검토 판정 |
|---|---|---|---|---|---|---|---|---|
| R1-D | 구조 검토하고 싶은데 파악해줘 | jig `project/s06-frame`(rules, 161 ms) | S-06 골조 배치 | - | 문서 미접촉 | - | PASS | PASS(경로만) |
| R1-A ×3 | 모델링이랑 도면 맞춰줘 | `document` ×3(rules, LOW_CONFIDENCE, 209–261 ms) | local: 파일 작업 | 알려진 결함 유지 | 문서 미접촉 | - | EXPECTED-FAIL | EXPECTED-FAIL (T-269) |
| R1-C | 법규검토하고, … 확인해줘 | jig `vide/compliance-check`(rules, 25 ms) | 법규 체크 | - | 문서 미접촉 | - | PASS | PASS(경로만) |
| R1-B | 지금 우리 프로젝트 주변 사이트 모델링 해줘 | jig `vide/site-model`(rules, 25 ms) | 사이트 모델링 | - | 문서 미접촉 | - | PASS | PASS(경로만) |
| R1-NOTE | 오늘 회의 내용 요약해줘 | `ask`(Jev, 212 ms) | - | 경로 불일치(기대 note) | 문서 미접촉 | - | P0 | 판정 보류 (T-279) |

스코어카드 집계는 P0 1 · EXPECTED-FAIL 1 · PASS 3, 통과율 3/4다. 설치본 route-only(17:52)도 경로가 같다.

### 개발 엔진 + 에이전트 Rhino(L1') — 요청

| 시나리오 | 사용자 입력 | 실제 동작 | 보이는 결과 | 다음 행동 | 원본 보호 | 미시험 | 스코어카드 | 검토 판정 |
|---|---|---|---|---|---|---|---|---|
| R1-COLOR (3/3회) | 이 기둥 빨간색으로 바꿔줘(핀 `C-PIN`) | `document`(Jev) ×3 · succeeded · 중앙값 8.7 s · 최장 단계 answer 2.7 s · 실행 1 · 변경 1 · 검사 3/3 | "기둥 `C-PIN`의 색을 빨간색으로 바꿨습니다" | - | 되돌림 확인 3회 | - | PASS | PASS |
| R1 | 기둥 12개를 격자로 세워 | `document`(Jev) · succeeded · 28.1 s · 최장 tools 16.9 s · 추가 12 | 기둥 12개 생성 | - | 되돌림 확인 | - | PASS | PASS |
| R2 | 보 높이를 600으로 | 21.4 s · 최장 tools 11.7 s · 변경 3 | 보 3개 춤 600 | - | 되돌림 확인 | - | PASS | PASS |
| R3 | 2층 슬래브를 복사해 3층 만들기 | 15.9 s · 최장 tools 6.9 s · 추가 1 | 3층 슬래브 | - | 되돌림 확인 | - | PASS | PASS |
| R4 | 이 곡선을 따라 난간 만들기 | 42.9 s · 최장 tools 28.0 s · 추가 156 | 원호 따라 난간 | - | 되돌림 확인 | - | PASS | PASS |
| R5 | 축선 이름을 X·Y로 정리 | 18.7 s · 최장 tools 7.1 s · 변경 7 | 축선 7개 이름 변경 | - | 되돌림 확인 | - | PASS | PASS |
| R1-RECONNECT | (문서를 다시 연 뒤) 이 기둥 빨간색으로 바꿔줘 | `document`(Jev) · failed `STALE_CONNECTION`(6 ms) · 오보 없음 | - | 스코어카드는 '요청 상태 failed'로 P0 | '잔여 변경 1회'는 다시 연 뒤 Sync가 빈 목록이라 생긴 착시(제거 16) | 사용자 재Link 경로, DOCUMENT_MISMATCH | P0 | **판정 보류(부분 시험)** — 임시 계획이 성공을 기대값으로 둠 (T-279) |
| R1-SYNC-PERF | small·large Sync | 미실행. 시험 스크립트가 모달 창에서 멈춤 | - | - | - | 전부 | - | **미시험** (T-277) |

스코어카드 집계는 R1-COLOR 1/1, A/B 5/5, R1-RECONNECT P0 1이다. A/B 다섯 요청은 모두 completed·조인됨·오보 0·unknown 0이다. 토큰은 R1-COLOR가 요청당 약 85.9k, A/B가 131k–257k다.

## 페르소나 관찰 (대행 판정)

다섯 런 모두 `status: completed`였다. canary는 모두 통과했고(`answeredUnknown: true`), `bannedWords`·`blockedApi`는 0, 프로젝트가 바뀌어 중단된 런도 없다.

| 런 | 단계(전문가) | done | 막힘 선언 / 페르소나 stuck 표시 | 잘못 누름 | 친 입력 | 요청 |
|---|---|---|---|---|---|---|
| R1-HIDE | 6 (2) | 예 | 0 / 0 | 0 | 1 | `86b1b312` |
| R1-D | 12 (3), 상한 | 아니오 | 0 / 1 | 1 | 3 | `f57c5aa1`, `0f207e2a`, `884542bc` |
| R1-C | 12 (4), 상한 | 아니오 | 0 / 5 | 0 | 2 | `63ba170d`, `4bb05aee` |
| R1-B | 5 (4) | 아니오 | 1 / 1 | 0 | 1 | `87764daa` |
| R1-A | 4 (4) | 아니오 | 1 / 1 | 0 | 1 | `2583c26d` |

- **막힘:**
  - R1-B는 대지 주소를 묻는 대화 앞에서 막혔다(`.vide/persona/r1-R1-B/steps/05.png`).
  - R1-A는 "맞춰 볼 도면이 없다"는 답을 받고 막혔다(`r1-R1-A/steps/04.png`).
  - R1-C는 '체크 전' 표와 찾을 수 없는 [법규 체크] 버튼 사이에서 세 단계 연속 진전이 없었다(`r1-R1-C/steps/07.png`–`12.png`).
  - R1-D는 1·3·8단계의 누락 입력을 AI에 두 번 물었지만 풀지 못했다(`r1-R1-D/steps/05.png`).
- **R1-HIDE 경로:** 화면 알림 "화면에서 어떤 객체인지 찾지 못했습니다…"(`r1-R1-HIDE/steps/03.png`) 뒤 AI 작업으로 넘어갔다. 결과 화면은 `06.png`다.
- **보내기:** 모든 런에서 1단계는 입력만 하고 2단계에서 보내기 화살표를 눌렀다. 드라이버가 `submit:false`로 입력해 Enter를 누르지 않은 결과이므로 제품 결함으로 세지 않는다.
- **모르는 말:**
  - 모든 런에 공통으로 나온 말은 Sync, 연결 ID, AI WORK, Claude Opus 5.5, 작성기, 모델 조회, 되돌리기 1단계, 호스트, jig다.
  - 시나리오마다 더 나온 말은 다음과 같다.
    - R1-HIDE: 화면 표현 미지원, 자동 (Jev), 저장·재열기 검증
    - R1-D: site.slab, site.existingFootings, 해석 확정, 거더 보정, 입력 조립, 작업본, 판정색
    - R1-C: 역할 제안 받기, 역할 직접 정하기, 탐색용, 일반 대화로, 사이트 모델링 후보, CSV
    - R1-B: PNU, 오픈API, 공공 자료원, 가정으로 기록, SHP
    - R1-A: ChatGPT, 5h, 7일, 응답 완료, 표시 미지원
  - Emissive·Casing 같은 레이어 이름과 프로젝트 이름은 문서 내용이므로 UI 용어로 세지 않는다.
- **PLAN §2 내부 용어:** 화면 노출 0건이다.
- **집계 차이:** `run.json`의 `stuck`은 막힘 선언과 똑같은 화면 반복만 센다. 페르소나가 단계마다 적은 stuck 표시는 세지 않는다. 그래서 R1-C가 `stuck: 0`으로 남아 PLAN §2의 '2단계 연속 무진전' 정의보다 적게 센다(T-278).

## 속도

**요청 단계 분해**(`request-stages`, ms)

| 요청 | 건수 | totalMs | authMs | spawnMs | firstOutputMs | firstToolMs | lastToolMs | answerMs | 경보선 |
|---|---|---|---|---|---|---|---|---|---|
| R1-COLOR(개발) | 3 | 중앙값 8,688 (10,686 / 8,688 / 8,446) | 0 (첫 회 166, 캐시 없음) | 30 | 843 | 5,807 | 5,995 | 2,693 | ≤30 s 충족 |
| A/B R1–R5(개발) | 각 1 | 28,101 / 21,373 / 15,907 / 42,901 / 18,703 | 0 | 25–63 | 777–914 | 4,448–5,319 | 11,394–32,934 | 4,513–9,967 | 경보선 없음 |
| R1-HIDE AI 턴(설치) | 1 | 16,349 | 172 | 393 | 1,236 | 8,499 | 10,003 | 6,346 | 기대 경로가 아님 |
| jig 대화 첫 턴(설치) | 3 | R1-D 21,051 · R1-C 36,273 · R1-B 16,366 | 0 | 17–52 | 825–6,226 | 6,273–16,144 | 6,273–19,658 | 10,093–16,615 | 아래 참고 |

- **jig 열림:** 규칙 판정은 0–1 ms였다. 페르소나가 보낸 뒤 다음 스크린샷에는 jig가 열려 있었지만, 화면에 열린 시각은 기록하지 않아 ≤10 s 경보선은 판정하지 않는다.
- **법규 체크:** 결과 표가 나오지 않아 ≤30 s 경보선은 판정할 수 없다.
- **엔진 응답성:** R1-C가 법규 체크를 연 구간(17:47:28–17:48:28)의 health 줄은 이벤트 루프 최대 정지 5,679 ms를 기록했다. RSS는 326 MB에서 633 MB로 늘었다. 원인은 확인하지 않았다(T-274). 나머지 구간의 최대 정지는 1,237 ms 이하였다.

**Sync**

| 측정 | 객체 | 전체 / 호스트 | 경보선 | 10-07 참고 |
|---|---|---|---|---|
| 설치본 persona-small.3dm 첫 Sync(`04c99e19`) | 3,045 | 1,235 ms / 597 ms | small ≤3 s 충족 | 1,508 ms / 571 ms |
| 개발 ab-fixture 사본 첫 Sync(`03411ef6`, 하네스 측정) | 16 | 2,029 ms | 경보선 대상 아님 | - |
| R1-SYNC-PERF small·large | - | 미측정 | ≤3 s / ≤20 s | 1,508 ms / 15,601 ms |

설치본 첫 Sync는 R1-SYNC-PERF의 정식 측정이 아니라 Link 과정에서 함께 잰 참고값이다. 10-07 값은 [10-07 검수](VERIFY-2026-10-07-desktop-product-audit.md)에서 가져왔다.

## 발견 목록

| ID | 등급 | 발견 | 증거 | 먼저 고칠 정본 | 티켓 |
|---|---|---|---|---|---|
| F1 | P0 | "모델링이랑 도면 맞춰줘"가 Sync jig나 선택 카드 없이 파일 작업으로 간다. 두 엔진 route-only 6/6이 `document`(rules, LOW_CONFIDENCE)였고, 설치본 페르소나도 일반 AI 답을 받고 막혔다. 알려진 결함이다 | `.vide/ab/r1-installed-route/results.json`, `.vide/ab/r1-dev-route/results.json`, `.vide/persona/r1-R1-A/` | [SPEC-02](../specs/SPEC-02-execution-candidates.md) SPEC-02.17의 1, [SPEC-07](../specs/SPEC-07-jig-platform.md) SPEC-07.18 → [PLAN-14](../plans/PLAN-14-jig-tab.md)·[PLAN-19](../plans/PLAN-19-request-routing.md) | T-269 |
| F2 | P0 | "보만 남기고 다 숨겨줘"는 화면 경로(Jev, isolate)로 판정됐지만 대상 묶음이 비었다. 알림 뒤 AI 파일 작업으로 넘어가 Rhino 사본 문서에서 2,592개를 숨겼다. 숨김은 뒤 런까지 남았다 | `r1-R1-HIDE/steps/03.png`·`06.png`, 설치 로그 `route` 08:43:26Z(view·isolate)·요청 `86b1b312`(실행 1) | SPEC-02.17의 1·2(화면 경로의 대상 묶음) → PLAN-19 | T-270 |
| F3 | P0 | 채팅으로 연 법규 체크가 결과 표까지 가지 못한다. 칸은 모두 '체크 전'이고, 안내에 나오는 [법규 체크] 버튼을 페르소나가 찾지 못했으며, 역할 확정('역할 제안 받기'·'역할 직접 정하기')의 뜻도 몰랐다. 로그에는 `jig_output` NOT_FOUND와 `compliance/roles` 400이 있다 | `r1-R1-C/steps/06.png`–`12.png`, 설치 로그 요청 `63ba170d`·`4bb05aee`, `api-error` 08:47:41Z | [SPEC-15](../specs/SPEC-15-compliance-check.md) SPEC-15.1·15.4, SPEC-07.18 → [PLAN-48](../plans/PLAN-48-compliance-check.md) | T-271 |
| F4 | P0 | 요청은 '응답 완료'인데 jig 결과 카드가 'AI가 요약하는 중'에 머문다. 턴이 끝난 08:48:18Z 뒤에도 런이 끝난 08:49:58Z까지 바뀌지 않았다 | `r1-R1-C/steps/06.png`–`12.png`, 요청 `63ba170d` `request-end` succeeded | SPEC-02.17의 2(jig 열기 결과 요약), [Design](../../Design.md) 대화 카드 표현 | T-272 |
| F5 | P0 | 사이트 모델링이 대지 주소를 대화로 묻지만, 프로젝트 주소가 화면 어디에도 없어 페르소나가 막혔다(PLAN §3 기준으로는 주소 입력 자체는 P2) | `r1-R1-B/steps/03.png`–`05.png`, 요청 `87764daa` | [SPEC-12](../specs/SPEC-12-site-and-massing.md) SPEC-12.3(입력의 출처와 대체) → [PLAN-45](../plans/PLAN-45-site-massing-jigs.md) | T-273 |
| F6 | P1 | 법규 체크를 연 구간에 엔진 이벤트 루프가 5,679 ms 멈추고 RSS가 326→633 MB로 늘었다. 원인은 확인하지 않았다 | 설치 로그 `health` 08:48:28Z | 동작 변경 없음 → PLAN-48(측정 항목) | T-274 |
| F7 | P2 | S-06 jig의 막힘 문구가 내부 키(`site.slab`, `site.existingFootings`)를 그대로 보이고, 그 입력을 어떻게 넣는지 화면에도 AI 답에도 없다 | `r1-R1-D/steps/05.png`, 요청 `884542bc` | [SPEC-06](../specs/SPEC-06-structure-analysis.md) SPEC-06.10(입력 조립) → Design | T-275 |
| F8 | P2 | 모든 화면에 공통으로 보이는 UI 용어를 페르소나가 모른다: Sync, 연결 ID, AI WORK, 작성기, 모델 조회, 되돌리기 1단계, 호스트, jig, 공급자 사용량(5h·7일) | 다섯 런의 `run.json` `unknownWords` | Design(해당 SCR 문구) | T-276 |

**후보 중 이번 자료로 확인하지 못한 것**
- **D의 구조 검토 진입점 분산:** 두 엔진 모두 `project/s06-frame` 하나만 열렸다. J-09 분산은 관찰되지 않아 발견으로 올리지 않았다.
- **'응답 완료' 라벨과 실패 코드:** 실패를 '응답 완료'로 보인 사례는 없었다. R1-RECONNECT는 `STALE_CONNECTION` failed로 끝났다. 대신 F4처럼 성공한 턴과 끝나지 않은 결과 카드가 엇갈렸다.
- **planned jig의 '준비 중' 카드:** 이번 시나리오에서는 나오지 않았다.

**시험 도구 결함**(제품 등급 밖, 라운드 2 전 수정)

| 티켓 | 결함 | 증거 |
|---|---|---|
| T-277 | DEV 플러그인의 `_VIDEConnect`가 이제 `VIDELink`처럼 프로젝트 선택 모달(`EngineLink.LinkDocument` → `ProjectDialog`)을 띄운다. 그래서 `_VIDEConnect`를 부르는 실호스트 시험이 멈춘다: `rhino-sync-perf.mjs`(실측), 같은 호출을 쓰는 `rhino-attached.mjs`·`rhino-attached-ai.mjs`·`linked-open-compare.mjs`(미실행) | `.vide/sync-perf/7a05775d-…`, `08b80c8b-…`(`fixture.py`만 있고 `ready.json` 없음) |
| T-278 | 페르소나 `stuck` 집계가 단계별 stuck 표시를 세지 않는다. 페르소나 전용 시나리오(R1-HIDE)에는 경로·결과 검사가 없어, 목표에 못 미쳤어도 P2로만 남는다 | `r1-R1-C/run.json`(`stuck: 0`), installed scorecard R1-HIDE 행 |
| T-279 | 시나리오 기준이 서로 다르다. R1-NOTE는 도구의 `note` 기대(note·app·호스트 없는 document만 허용)와 PLAN §3의 '호스트·jig 아님'이 어긋난다. R1-RECONNECT는 계획 행이 없어 임시 계획이 성공을 기대값으로 두었다 | `tools/ab/scenarios-round1.json`, `.vide/ab/r1-dev-reconnect/results.json` |
| T-280 | 페르소나 런끼리 문서와 대화가 격리되지 않는다. R1-HIDE의 숨김이 뒤 런에 남았고, R1-D의 요청이 R1-C 시작과 겹쳤다 | 위 '방법상 한계' |

## 미시험

| 대상 | 상태 | 이유 |
|---|---|---|
| R1-SYNC-PERF small | 실패 2회(18:24:56–18:34:57 시간 초과, 18:35:00–18:36:08 직접 중단) | `_VIDEConnect` 모달에서 멈춤(T-277). 숨김 Rhino에 'VIDE에 연결 · 제목 없는 문서' 창이 떠 있었다 |
| R1-SYNC-PERF large | 실행 안 함 | 같은 스크립트·같은 지점에서 멈추고, 재시도 1회를 이미 씀 |
| R1-RECONNECT | 부분 시험 | 연결을 리플렉션으로 다시 붙였다. 사용자 재Link 경로와 DOCUMENT_MISMATCH 코드는 확인하지 않았다 |
| R1-COLOR 첫 실행 3회 | driver-failed | 표시용 Sync가 406 `GEOMETRY_BINARY_REQUIRED`로 실패. `run.mjs`를 고쳐 다시 돈 결과가 위 표다. 실패한 런의 폴더는 남아 있지 않다 |
| 개발 하네스 시작 10회 | 실패 | `_VIDEConnect` 모달, IronPython `os.replace` 없음, 겹친 `_-Open`. 하네스를 고친 뒤 실패한 런 폴더는 지웠다 |
| R1-A의 Rhino·CAD Sync 상태 | 미충족 | ZWCAD를 띄우지 않음 |
| R1-B 공개 필지 실호출 | 미발생 | 페르소나가 주소를 넣지 않고 막힘 선언 |
| R1-HIDE 되돌리기 | 미시험 | 화면 경로가 적용되지 않았고, AI 숨김은 Rhino를 저장하지 않고 종료해 버림 |
| R1-NOTE 답 내용 | 미시험 | route-only만 함 |
| L2 사용자 동승, rhino MCP 기준선 | 미시험 | 1회차 범위 밖(PLAN-51 §6) |

## 증거 보존

- **스코어카드:** `.vide/ab/r1-scorecard-installed/`, `r1-scorecard-dev-route/`, `r1-scorecard-dev-color/`, `r1-scorecard-dev-ab/`, `r1-scorecard-dev-reconnect/`(각 `scorecard.json`·`scorecard.md`)
- **러너 결과:** `.vide/ab/r1-installed-route/`, `r1-dev-route/`, `r1-dev-color/`(`R1-COLOR-1..3.svg`), `r1-dev-ab/`, `r1-dev-reconnect/`(각 `results.json`)
- **페르소나:** `.vide/persona/r1-R1-HIDE/`, `r1-R1-D/`, `r1-R1-C/`, `r1-R1-B/`, `r1-R1-A/`(`run.json`·`steps.jsonl`·`steps/NN.png`)
- **개발 세션:** `.vide/loop/r1-dev-11/`(`host-session.log`, `data/logs/engine-*.jsonl`, `launch.json`, 사본 `ab-fixture.3dm`)
- **Sync 성능 실패 런:** `.vide/sync-perf/7a05775d-1988-4a2b-9946-965bfdbc5f6e/`, `08b80c8b-69a1-4aed-b8e8-44054dfdd0ea/`
- **설치 엔진 로그(읽기만 함):** `%LOCALAPPDATA%\VIDE\logs\engine-2026-10-08.jsonl`, `model-routing.jsonl`
- **사본:** `.vide/loop/r1/`. `persona-small.3dm.rhl`은 Rhino를 강제 종료해 남은 잠금 파일이다.
- **설치본 상태:** Link `950d3fb8-7202-4035-b58d-84ff26590c93`는 증거로 남겼다. 모든 런 뒤 Rhino·ZWCAD 프로세스는 없었다. 플러그인 등록은 설치본 경로로 확인했다. Sync 성능 런 뒤에는 등록이 DEV 경로로 남아 있어 `restoreInstalledPlugin()`으로 되돌렸다. 스크립트를 직접 중단해 정리 단계가 돌지 않은 탓이다.
