---
id: PLAN-51
title: 검증–수정 반복 루프 — 사용자 문장 시나리오·페르소나·스코어카드 (T-264~T-268)
status: review
version: 1.6
updated: 2026-10-19
owner: agent:claude
related: [PRD, SPEC-00, SPEC-01, SPEC-02, SPEC-05, SPEC-06, SPEC-07, SPEC-12, SPEC-13, SPEC-15, PLAN-12, PLAN-14, PLAN-19, PLAN-45, PLAN-46, PLAN-47, PLAN-48, PLAN-16, PLAN-23, PLAN-24, PLAN-07, AC-22, AC-48, FR-25, T-012]
---

# 검증–수정 반복 루프

2026-10-07 사용자 요청: 다섯 목표(① 비개발자도 직관적인 UI ② 채팅·스케치·클릭으로 쉽게 ③ 작동 오류 없음 ④ 속도 ⑤ 실무 요청이 바로 결과로)를 기준으로 **검증과 수정을 반복**하는 방법. 사용자 결정(10-07·10-08): 직관 판정은 비개발자 페르소나 AI가 대행하고 사용자 동승은 드물게 · 1회차는 있는 기능부터 · 속도 합격선은 Claude Code + rhino MCP 대비이되 1회차는 기준선 없이 측정만 · 법규 문장은 법규 체크 jig로 열리고 정직한 범위 표시가 합격 · 검증은 설치본(0.2.31)에서 · 구조 검토 진입점이 둘로 갈린 것은 결함. 근거 관찰은 [10-06 검수](../tdd/VERIFY-2026-10-06-critical-product-audit.md)·[10-07 검수](../tdd/VERIFY-2026-10-07-desktop-product-audit.md)(자동 시험 통과와 실사용 성공이 갈림).

이 계획은 루프의 규약·시나리오·채점·도구를 소유한다. 측정으로 드러난 결함의 수정은 해당 기능의 SPEC·PLAN을 먼저 보완하고 이 문서의 라운드 로그에서 티켓으로 연결한다. 제품 동작을 새로 정하지 않는다.

## 1. 루프 규약

**라운드** = 세 층을 한 번 돌고 → P0부터 고치고 → 같은 시나리오로 재검증.

| 층 | 무엇 | 어디서 | 언제 |
|---|---|---|---|
| L0 자동 | `npm run verify` + 시나리오 러너(`tools/ab/run.mjs --plan`: route-only·요청·Sync 성능) → 스코어카드 | 개발 엔진(임의 포트·런별 데이터 폴더; 47821·47831 거부) | 수정마다 실패 시나리오만(`--only`), 릴리스 후보 때 전체 |
| L1 페르소나 | 인턴 페르소나 AI(`tools/persona`)가 설치 엔진의 웹 UI를 **스크린샷만 보고** 조작. 전용 프로젝트에서만. 호스트가 필요하면 에이전트가 띄운 Rhino를 `.vide/` 사본으로 Link하고 끝나면 종료 | 설치본 | 라운드당 1회 |
| L1' 실호스트 자동 | `tests/integration/rhino-attached-ai.mjs`·`tools/ab` R1~R5·`rhino-sync-perf.mjs` | 개발 엔진 + 에이전트 Rhino(끝나면 플러그인 등록 복원) | 라운드당 1회 |
| L2 사용자 | 설치본에서 시나리오 1~2개 직접(15분) | 설치본 | 시나리오 졸업 전 1회 |

- **등급:** P0 = 오류·오보(실패인데 '응답 완료')·경로 오판(일반 AI 편집으로 흐름)·페르소나 막힘 / P1 = 속도(1회차 절대 경보선, 2회차부터 MCP 기준선) / P2 = 직관(문구·내부 용어·발견성·불필요한 사람 입력).
- **졸업:** 연속 3라운드 P0 0건 · 속도 기준 충족 · 막힘 0, 그중 사용자 동승 1회. 졸업 뒤 L0만, 영역 변경·재발 시 L1 복귀.
- **릴리스 리듬:** 라운드 N(설치본) → dev에서 수정 + L0 → P0 모두 닫히면 묶음 릴리스(사용자 지정 시각) → 라운드 N+1. 설치 엔진은 재시작하지 않는다.
- **조용한 통과 방지:** 런 상태 `completed | driver-failed | aborted | untested`. 드라이버 실패·`request-stages` 미조인·스크린샷 0장·canary 실패면 판정은 **미시험**만 가능하고 통과율 분모에서 뺀다.
- **원본 보호:** 사용자 프로젝트·원본 문서·사용자가 띄운 호스트는 건드리지 않는다(AI.md §8). 사본은 런별 `.vide/loop/<run>/`.

## 2. 채점표

| 목표 | 수치 | 출처 | 합격 |
|---|---|---|---|
| ① 직관 | 페르소나 막힘 선언 수(2단계 연속 무진전 포함), '모르는 말' 목록, 내부 용어(SPEC-/PLAN-/JIG/hostUse/LINK_NOT_LIVE/세션/토큰/bake/overlay/handoff/stale)의 화면 노출 수 | `steps.jsonl`, 단계별 가시 텍스트 | 막힘 0·내부 용어 0. 막힘 ≥1 P0, 나머지 P2. '대행 판정'으로 표기 |
| ② 쉬움 | 단계 수 ÷ 전문가 최소 단계, 잘못 누름 수, 사람이 쳐야 했던 입력 수 | `steps.jsonl`, `data-request-id` | 비율 ≤2.0, 잘못 누름 ≤1 |
| ③ 무오류 | 요청 state failed/unknown/interrupted, 새 엔진 종료, 오보 M1(succeeded인데 마지막 activity가 error)·M2(변경 기대인데 applied 0)·M4(executions unknown/failed), 라우팅 불일치(expectedFail 분리) | 로그 조인(`tools/ab/stages.mjs`), `checks.mjs misreport()` | 전부 0. 1건이면 P0·졸업 리셋. M3(답문 어휘)는 의심 표시만 |
| ④ 속도 | `request-stages` totalMs 중앙값(3회)·단계 분해, jig 열림 시간, Sync ms/hostMs. 페르소나 생각 시간 제외 | 로그, `/route` 클라이언트 ms | 1회차 절대 경보선: 색 변경 ≤30 s, jig 열림 ≤10 s, 법규 체크 ≤30 s, Sync small ≤3 s·large ≤20 s. 2회차부터 MCP 기준선 ≤1.0배(T-012) |
| ⑤ 실무 결과 | 기대 경로·결과 증거 일치. 페르소나 done 선언만으로는 불인정 | `record.route`, 화면 증거, 실호스트 재조회 | 100% 일치. 경로 오판 P0 |

## 3. 1회차 시나리오 (문장은 사용자 원문)

| ID | 입력 | 시작 상태·층 | 기대 |
|---|---|---|---|
| R1-COLOR | "이 기둥 빨간색으로 바꿔줘"(핀 1개) | L1' 합성 문서, 3회 | 오류 0, 실제 색 변경·되돌리기, totalMs 분해 |
| L0-R1..R5 | A/B 5문장(`tools/ab/requests.json`) | L1' `.vide/ab/ab-fixture.3dm`, 1회 | mm 판정 통과, 오보·unknown 0 |
| R1-HIDE | "보만 남기고 다 숨겨줘" | L1 설치 엔진 전용 프로젝트, small.3dm 사본 Sync | AI 없이 화면 변경·되돌리기 |
| R1-D | "구조 검토하고 싶은데 파악해줘" | L1 + route-only | jig 하나가 열림. S-06·J-09 분산은 P1 |
| R1-A | "모델링이랑 도면 맞춰줘" | route-only 3회 + L1 1런, Rhino·CAD Sync | Sync jig 또는 선택 카드. 일반 AI 편집이면 P0 |
| R1-B | "지금 우리 프로젝트 주변 사이트 모델링 해줘" | L1, 공개 필지 1곳 실호출, 만들기 전까지 | `vide/site-model` 열림. 주소를 사람이 쳐야 하면 P2 |
| R1-C | "법규검토하고, 지금 우리 건물 설계에서 법규 위반 사항 없는지 확인해줘" | route-only + L1, small.3dm 사본 Link | `vide/compliance-check` 열림, 결과 표가 판정 가능/판단 필요/사람 입력 필요를 구분. 즉흥 AI 답이면 P0 |
| R1-NOTE | "오늘 회의 내용 요약해줘" | route-only | 호스트·jig 아님 |
| R1-SYNC-PERF | small·large.3dm Sync | L1' 런별 사본 | ≤3 s / ≤20 s |
| R1-RECONNECT | 재열기 뒤 색 변경 | L1' 또는 L1 1회 | DOCUMENT_MISMATCH가 '응답 완료'로 끝나지 않음 |

## 4. 티켓

| 티켓 | 변경 | 검증 | 완료 |
|---|---|---|---|
| T-264 시나리오 러너·오보 규칙 | `tools/ab/run.mjs`(`--plan`, kind, `record.route`, `expectedFail`, `--engine`, 런 상태), `tools/ab/stages.mjs`(로그 조인), `tools/ab/checks.mjs` `misreport()`, `tools/ab/scenarios-round1.json` | `tools/ab/checks.test.mjs`, `tools/ab/stages.test.mjs`; 47821·47831 거절 | route-only 플랜이 실제 개발 엔진에서 results.json을 내고 stages가 조인됨 |
| T-265 스코어카드 | `tools/ab/scorecard.mjs`(verdict PASS/P0/P1/P2/EXPECTED-FAIL/미시험, slowestStage, PLAN §7.3 6열, 런 유효성) | `tools/ab/scorecard.test.mjs` | completed/driver-failed/미조인 런이 각각 PASS/미시험으로 분류 |
| T-266 페르소나 드라이버 | `tools/persona/run.mjs`·`persona-step.mjs`·`personas/intern.md`·`scenarios.json`·`README.md` | 가짜 `claude`로 오프라인 왕복, 실제 canary 1회 | 설치 엔진 전용 프로젝트에서 R1-HIDE 1런이 steps.jsonl·스크린샷을 남김 |
| T-267 라운드 1 환경·측정 | 키 복사(완료 10-08), fixture 생성, 전용 프로젝트, §3 측정 | — | 모든 시나리오에 런 상태가 있음 |
| T-268 라운드 1 기록 | `docs/tdd/VERIFY-2026-10-08-loop-round-1.md`, 아래 §5, PLAN.md §6.5 | `npm run docs:check` | P0/P1/P2 목록과 수정 티켓 연결 |
| T-269 P0 모델↔도면 문장의 Sync jig 진입 | SPEC-02.17의 1·SPEC-07.18에 '모델/도면 맞춰' 부름말과 호스트가 하나뿐일 때의 선택 카드를 먼저 정하고 PLAN-14·PLAN-19로 구현 | L0 `--only R1-A` 3회, L1 R1-A(Rhino+CAD 연결) | route-only 3/3 Sync jig, `expectedFail` 해제 · **R2: 부분** — 진입 해소(route 3/3·L1 jig 열림), 비교 Rhino 0개로 막힘(T-283) · **R3: 부분** — 원문 문장 L1로 Sync jig 열림, 비교 쌍 0(T-283)·같은 문장 재전송 무반응(T-291) · **R4: 부분** — route 3/3·L1 Sync jig 열림(페르소나가 바꿔 쓴 문장), 막힘은 T-291 재현 · **R5: 해소** — route 3/3, L1에서 원문 문장 그대로 Sync jig 열림. R1-A의 남은 막힘은 T-299 · **R6: 해소 유지** — route 3/3, L1 원문으로 Sync jig 열림. R1-A의 남은 P0는 T-301·T-302 |
| T-270 P0 화면 경로 대상 묶음 해석 | SPEC-02.17의 1·2에 종류·레이어 이름으로 대상('보' 등)을 찾는 기준을 보완한 뒤 화면 경로 구현 | small 사본에서 "보만 남기고 다 숨겨줘", L1 R1-HIDE | AI 요청 0, 화면 격리와 U 되돌리기 확인 · **R2: 부분** — 레이어 고르기 카드로 바뀜(문서 변경 0), '보' 못 찾음·AI 요청 1건, CAD 대상 오염으로 재측정 필요 · **R3: 부분(재발)** — AI 요청 0 충족, '보' 못 찾아 SB10만 남김(보 레이어 1/3), U 미시험 · **웨이브 3: 완료(라운드 4 확인 전)** — 두 글자 이상 약호(SB10·SG7)로 보 레이어 모두, 한 글자 약호는 층·그리드·창호·단면 아래 제외 · **R4: 부분(대상 해소)** — AI 요청 0, 보 레이어 22/22만 남김, 스코어카드 P0 → P2. U 되돌리기 미시험 · **R5: 해소** — AI 요청 0, 보 22/22, U로 숨김 23,822 → 0 복원(`undoRestored`). 화면 맞춤 없음은 P2 관찰, 2,265개는 T-298 · **R6: 해소 유지** — AI 요청 0, 보 22개, U로 30,074 → 0 |
| T-271 P0 채팅으로 연 법규 체크가 결과 표까지 가는 길 | SPEC-15.1·15.4·SPEC-07.18에 첫 사람 단계(역할 확정)의 화면 안내와 [법규 체크] 위치를 맞추고, `compliance/roles` 400·`jig_output` NOT_FOUND 원인을 PLAN-48에서 고침 | L1 R1-C | 페르소나 막힘 0, 결과 표가 판정 가능/판단 필요/사람 입력 필요를 구분 · **R2: 부분** — 버튼 찾음, 읽기 `HOST_UNAVAILABLE`로 결과 표 없음·막힘(T-282) · **R3: 부분** — 결과 표 없음, 죽은 연결 선택으로 거짓 거절(T-287) · **R4: 부분** — 결과 표 도달(사람 입력 필요 9 · 검사 불가 10, 규제 조건 없음), 막힘 1(T-296) · **R5: 부분** — 결과 표 유지(판정 가능 0, 규제 조건 없음), 막힘 1은 AI 턴 중 '요청 이해 · 진행 중' 표시 · **R6: 부분** — 결과 표 유지(판정 가능 0), 막힘 2(AI 턴 중 대기, '앞 작업본' 칸에 목록 없음) |
| T-272 P0 턴 종료 뒤 'AI가 요약하는 중' 잔존 | SPEC-02.17의 2(jig 열기 결과 요약)에 턴이 끝났는데 요약이 없을 때의 표시를 정하고 Design 카드 문구를 맞춤 | R1-C 재현, UI 단위 시험 | '응답 완료' 뒤 진행 중 표시 0 · **R2: 해소** — L1 R1-D·R1-C 결과 카드 요약 완료, 잔존 0 · **R3: 해소 유지**(R1-D) · **R4: 해소 유지** · **R5: 해소 유지**('응답 완료' 뒤 0) · **R6: 해소 유지** |
| T-273 P0 사이트 모델링 대지 주소의 출처 | SPEC-12.3에 프로젝트 주소 대체와 주소가 없을 때 넣는 위치를 정하고 PLAN-45로 구현 | L1 R1-B(공개 필지 1곳 실호출) | 페르소나 막힘 0, 만들기 전 단계 도달 · **R2: 부분** — 주소 안내·입력칸 확인, 페르소나가 주소를 몰라 막힘(드라이버 한계 T-286), 실호출 미시험 · **R3: 부분** — 운영자 답 주소로 실호출(lookup 6·collect 필지 479·건물 173)·필지 확정, 4~7단계 계산 전(T-288) · **R4: 부분** — 운영자 답 주소로 실호출·만들기 앞 도달, 무진전 3(T-295) · **R5: 부분(주소 해소)** — 열 때 프로젝트 주소로 lookup, 만들기 앞 도달, 무진전 3은 T-295 · **R6: 재발(원인 미확인)** — 열 때 '프로젝트에 저장된 주소가 없습니다', 운영자 답 주소로 만들기 앞 도달 |
| T-274 P1 법규 체크 열 때 엔진 이벤트 루프 정지 | 동작 변경 없음. PLAN-48에 측정 항목을 더하고 5.7 s 정지·RSS +300 MB의 원인을 찾아 줄임 | small 사본에서 법규 체크 열기 중 `health` | 원인 확인과 정지 감소 수치 기록 · **R3: 미측정**(읽기 거절) · **R4: 부분(측정)** — 읽기 6.4–6.8 s 중 classify 5.25–5.39 s, loopMax 5.66–5.83 s, RSS +약 350 MB. 원인 코드·감소 수치 남음 · **웨이브 4: 완료(라운드 5 확인 전)** — 분류를 약 50 ms 조각으로 나눠 양보(결과 동일), 원본·보관 모델 쓰기 비동기. 합성 3,000개: 한 덩어리 3,357 ms → 최장 연속 110 ms·타이머 최장 간격 110 ms · **R5: 부분(미충족)** — 조각 양보 81–84회지만 최장 조각 약 266 ms, 읽기 구간 loopMax 4,303 ms, RSS +348 MB. 읽기 밖 정지는 T-300 · **웨이브 5: 완료(라운드 6 확인 전)** — 읽기 구간에 남은 동기 해시·보관 문서 읽기를 비동기로(`hashValueAsync`·`hostDocumentAsync`, 출력 동일). 남음: 설치본 사본에서 loopMax·RSS 재측정 · **R6: 해소** — 법규 읽기 구간 loopMax 275·288 ms(최장 조각 274·287 ms), RSS +331 MB는 관찰로 남김 |
| T-275 P2 S-06 누락 입력 안내 | SPEC-06.10에 누락 입력(`site.slab` 등)을 사람이 읽는 이름과 넣는 방법으로 보이는 규칙을 더하고 Design 문구를 맞춤 | L1 R1-D | 화면에 내부 키 0, 누락 입력마다 다음 행동 표시 · **R3: 부분** — 문구는 보이나 [입력 조립]에 고르는 칸이 없어 막힘(T-289) · **R4: 부분** — S-06 패널은 사람 말·[레이어 고르기], 채팅 질문 카드 답에 키 노출(T-294) · **R5: 해소** — [레이어 고르기] → 선택 → 재계산, 키 노출 0 · **R6: 해소 유지** |
| T-276 P2 공통 화면 용어 | Design 해당 SCR 문구(Sync, 연결 ID, AI WORK, 작성기, 모델 조회, 되돌리기 1단계, 호스트, jig, 사용량 5h·7일) | 라운드 2 페르소나 `unknownWords` | 위 용어가 공통 모르는 말에서 빠짐 · **R3: 미착수**(공통 모르는 말 그대로) · **R4: 미착수** · **웨이브 4: 완료(라운드 5 확인 전)** — Design §07 표(1.16·1.17): 동기화·작업·요청 입력·모델 읽기·되돌리기(마지막 변경)·프로그램 이름·자동·5시간/7일 한도·저장 확인·이 파일을 프로젝트와 이어 둠 등 · **R5: 부분** — 연결 ID·AI WORK·작성기·모델 조회·호스트·Jev·자동 (Jev)·5h 0건. 남은 말 `jig`(4런)·`Sync`(Sync jig 칸 이름)·`site-model`·`check → failed`·모델 이름·`low`, 바꾼 말 '동기화'·'자동'도 5런 모두 모르는 말 · **R6: 부분** — `jig`(4런)·`Sync` 칸 이름·`site-model`·모델 이름이 남음, '동기화'·'자동'·'계획'도 모르는 말 |
| T-277 도구: 대화창 없는 실호스트 시험 연결 | `rhino-sync-perf.mjs`·`rhino-attached.mjs`·`rhino-attached-ai.mjs`·`linked-open-compare.mjs`를 `host-session.mjs`처럼 `AttachedConnection.Connect` 직접 호출로 바꿈 | R1-SYNC-PERF small·large | `result.json` 두 개, 설치본 플러그인 등록 복원 확인 · **R3: 미시험**(L1' 생략) · **R4: 미시험** · **R5: 미시험** · **R6: 미시험** |
| T-278 도구: 페르소나 막힘 집계·페르소나 전용 판정 | `tools/persona/run.mjs` `stuck`에 연속 두 단계 stuck 표시를 포함(§2 정의), `scorecard.mjs`에 목표 미도달·R1-HIDE 결과 검사(AI 요청 0) 추가 | 라운드 1 `run.json` 재채점 시험 | R1-C 막힘 ≥1, R1-HIDE 경로 불일치가 P0로 나옴 |
| T-279 도구: 시나리오 기준 정렬 | `scenarios-round1.json`에서 R1-NOTE 기대를 §3('호스트·jig 아님')과 맞추고 R1-RECONNECT 행(실패 코드로 끝나고 '응답 완료' 아님)을 추가 | `checks.test.mjs`·`scorecard.test.mjs` | R1-NOTE·R1-RECONNECT가 §3 기준으로 판정됨 |
| T-280 도구: 페르소나 런 격리 | 런마다 사본을 새로 복사·Link하고 새 대화에서 시작하며, 앞 런의 요청이 끝난 뒤 다음 런을 시작 | 라운드 2 L1 | 런 사이 문서·대화 상태 공유 0 · **R3: 부분** — 새 대화·요청 대기 확인, 사본 공유(R1-D 실행 1건)·jig 대화 `resume` 이어짐 · **웨이브 3: 완료(도구, 라운드 4 확인 전)** — jig 작업본·묶인 대화 격리(`--fresh-jigs`) · **R4: 부분(jig 격리 해소)** — `full` ×4, 새 CLI 3건 `resume` 없음. 사본은 런마다 새로 Link하지 않음(실행 0), 다른 jig의 앞 작업본이 남아 법규 체크가 읽음 · **R5: 부분(유지)** — jig 격리 `full` ×4, 사본은 런마다 새로 Link 안 함, 닫힌 연결 데이터가 입력에 섞임(T-298) · **R6: 부분(유지)** — jig 격리 `full` ×4, 사본은 런마다 새로 Link 안 함, R1-A Sync jig에 앞 라운드 CAD 데이터가 섞임(T-302) |
| T-281 P1 후보 Sync 성능 시험의 undo 뒤 delta 불일치 | 동작 변경 없음(원인 조사). `rhino-sync-perf.mjs` small의 undo 단계에서 'delta differs from full Sync'가 두 번 모두 재현됐다. 원인이 제품(변경분 Sync)인지 시험인지 SPEC-01.11(Link·Sync) 기준으로 가린다 | R1-SYNC-PERF small 재실행, `.vide/sync-perf/b5c5f89c-…`·`69757bc6-…` | 원인 확인, 제품 결함이면 해당 SPEC·PLAN에 수정 티켓 · **R3: 미시험** · **R4: 미시험** · **R5: 미시험** · **R6: 미시험** |
| T-282 P0 법규 체크 모델 읽기 실패와 그 표시 | SPEC-15.1에 읽기 실패(호스트 없음·닫힌 연결·Rhino 연결이 여럿)의 표시와 대상 연결 선택을 먼저 정하고 PLAN-48로 구현. `compliance/read`의 `HOST_UNAVAILABLE`이 `server-error`·'VIDE 내부 오류'로 보이는 것을 분류된 실패로 바꾸고, 닫힌 Link가 골라졌는지(`src/server/compliance-routes.ts:276`, 원인 미확인) 확인 | 닫힌 Rhino Link와 새 Link가 함께 있는 프로젝트에서 [법규 체크], L1 R1-C(Rhino만 연결) | 결과 표가 판정 가능/판단 필요/사람 입력 필요를 구분하거나, 읽지 못하면 이유와 다음 행동이 보임('내부 오류' 0) · **R3 전: 코드 수정·오프라인 시험 통과, 설치본 L1 미측정** · **R3(설치본 0.2.33): 부분** — 분류된 거절 문구 확인('내부 오류' 0), 대상 선택이 죽은 행 `950d3fb8`을 고름(T-287). `GET /host/selection` `HOST_UNAVAILABLE` 1건은 `server-error`로 남음 · **R4: 해소** — 열린 Link를 읽어 결과 표, `server-error` 0 · **R5: 해소 유지** · **R6: 해소 유지** — 열린 `bd2da829`를 읽음 |
| T-283 P0 후보 Sync jig 비교의 Rhino 0개 | 원인 조사 먼저. Rhino Sync는 3,045개인데 [정렬·비교 실행]이 Rhino 0개 · CAD 3,381개 · 대응 0쌍이고 Rhino 레이어 목록이 빈 까닭을 SPEC-05.8(Sync jig 입력) 기준으로 가린다. 제품 결함이면 SPEC-05.8·PLAN-14에 수정 항목 | `r2-R1-A` 재현(small 사본 + cad 사본), L1 R1-A | 원인 확인. 비교할 요소가 없으면 그 이유를 화면에 보이고, 결함이면 대응 쌍이 나옴 · **R3 전: 코드 수정·오프라인 시험 통과, 설치본 L1 미측정** · **R3: 부분** — 이유와 종류별 개수 표시 확인(`r3-R1-A/steps/05.png`), 솔리드 문서 비교 대상은 제품 결정 · **웨이브 3: 부분** — 솔리드 단면 비교(사용자 결정, SPEC-05.8 0.18) 구현, 설치본 R1-A 재측정 남음 · **R4: 부분** — 솔리드 단면 변 2,044·대응 1쌍(높이 9.225 m와 이유 표시), 1쌍 정렬이라 실무 맞춤 아님. 대응이 적은 원인 미조사 · **R5: 부분(변화 없음)** — 단면 변 2,044·대응 1쌍 · **R6: 부분(재측정 무효)** — 같은 값(대응 1쌍)이나 CAD 쪽이 라운드 5의 닫힌 데이터 |
| T-284 P0 후보 다른 프로젝트 연결 ID가 남은 문서의 Link | 동작 판단 먼저. 연결 ID(ADR-030)를 지닌 CAD 사본을 전용 프로젝트에 Link하자 원래 프로젝트 Link `ab63a9e0`의 경로도 바뀌고 그쪽 동시 Sync가 129 s 뒤 `HOST_RESULT_UNKNOWN`. SPEC-01.11에 한 창이 두 프로젝트 연결에 함께 이어질 때의 규칙이 있는지 확인하고 없으면 보완 | 연결 ID가 있는 사본으로 두 전용 프로젝트 Link 재현 | 규칙 확정, 동시 Sync 실패 0. `실사용 검증 20261007` Link 경로를 되돌릴지는 사용자 결정 · **R3 전: 코드 수정·오프라인 시험 통과, 설치본 L1 미측정** · **R3: 재현 없음** — 다른 프로젝트 행 변경 0(`links-before/after`), 외부 ID는 `-StripLinkId`로 먼저 지워 제품 규칙은 미실측 · **R4: 재현 없음(제품 규칙 미실측)** — 다른 프로젝트 행 변경 0 · **R5: 재현 없음(제품 규칙 미실측)** · **R6: 재현 없음(제품 규칙 미실측)** |
| T-285 P1 ZWCAD 첫 Sync 151 s | 동작 변경 없음(측정). `cad.dwg`(3,719개) 첫 Sync 151,244 ms(호스트 149,182 ms). 다른 Link의 동시 Sync를 뺀 단독 값을 재고 호스트 단계를 나눈다 | 연결 ID 없는 cad 사본, 전용 프로젝트 하나 | 단독 Sync 수치와 느린 단계 기록, 경보선 ≤20 s 대비 · **R3 전: 미착수**(수정 웨이브 2에서 맡은 그룹 없음) · **R3: 부분** — 단독 100,400 ms(호스트 98,946 ms), 경보선 5.0배, 호스트 단계 분해 남음 · **R4: 부분** — 단독 100,318 ms(호스트 98,885 ms), 변화 없음, 분해 남음 · **웨이브 4: 분석·계측(동작 변경 없음)** — 플러그인 `displayPage` 68.6 s(무거운 쪽 4개 63.3 s), 쪽 사이 30.1 s(상태 조회 끼어듦 14.2 s), 엔진 쪽 처리 약 15.8 s 미분해. `call-stages` 계측 추가([PLAN-07](PLAN-07-zwcad-attached-sync.md)) · **R5: 부분(분해 완료, 감소 없음)** — 106,473 ms(호스트 105,034 ms, 경보선 5.3배). displayPage 39쪽 67.2 s 중 무거운 4쪽 62.0 s(92%), 가장 느린 개체 모두 BlockReference(좌표 0개 2건 포함), 쪽 사이 35.6 s · **웨이브 5: 수정(빌드만, 측정은 라운드 6)** — 블록 정의 캐시, 연결마다 따로 받는 수신(동시 16개), Sync 중 같은 도면의 목록 상태 고정(HOST-ZWCAD §1.1 0.33, [PLAN-07](PLAN-07-zwcad-attached-sync.md) 0.5). 예상 약 45–60 s, 경보선 20 s는 아직 넘음 · **R6: 퇴행(실패)** — 첫 Sync `HOST_BUSY` 2회(148.8·140.7 s), 26쪽 `displayPage` 60 s 상한, 같은 쪽이 2.2~3.3배 느려짐(`482D76` 21.9 s, R5 6.6 s). 실패는 T-301 · **핫픽스 T-301: 되돌림(빌드만, 라운드 7 확인 전)** — 블록 정의 캐시를 빼고 표시 경로를 0.2.35로 되돌림, 쪽 읽기 15 s 예산·시작한 읽기는 끝까지 기다림([PLAN-07](PLAN-07-zwcad-attached-sync.md) 0.6, HOST-ZWCAD §1.1 0.34). 첫 Sync 기대 약 100–110 s로 경보선 20 s는 그대로 넘음. 캐시 재도입 조건은 PLAN-07 T-301 절 · **R7: 부분(측정만)** — 0.2.40 설치본, `cad.dwg` 사본 첫 Sync 74,010 ms(호스트 72,265 ms, 3,719개). 라운드 5의 0.70배, 경보선 3.7배. 쪽 분해는 안 함 |
| T-286 도구: 페르소나 런의 호스트 구성·운영자 정보 | 시나리오에 연결할 호스트를 적고(R1-HIDE·D·C·B는 Rhino만, R1-A는 Rhino+CAD), 사본은 문서 안의 연결 ID가 없는 원본에서 만들며, 드라이버에 운영자 정보(대지 주소 등)를 줄 경로를 둔다. `_VIDEConnect`의 '닫힌 연결 파일이 있습니다' 두 번째 창도 무인 처리 대상에 넣는다 | 라운드 3 L1 | 시나리오별 요청의 `host`가 계획과 일치, 다른 프로젝트 Link 변경 0, R1-B가 주소를 받아 만들기 전 단계까지 감 · **R3 전: 코드 수정·오프라인 시험 통과, 설치본 L1 미측정** · **R3: 해소(도구 범위)** — 요청 host rhino 4/4, 다른 프로젝트 변경 0, 운영자 답 작동, 두 번째 창 무인 처리. `host-link.ps1` 실물 결함 2건 수정(커밋 전). R1-B 만들기 전 단계는 T-288 · **R4: 해소 유지(도구)** — Rhino·ZWCAD 첫 시도 exit 0, 두 번째 창 `closed` 무인 처리, host rhino 5/5 · **R5: 해소 유지(도구)** · **R6: 부분** — Rhino exit 0, ZWCAD는 두 번째 창 처리 197 s·240 s 시간 초과로 exit 1(Link 행은 생김) |
| T-287 P0 죽은 연결 행이 '연결됨'·열린 연결로 취급됨 | SPEC-01.11 7(끊긴 연결은 닫힘)을 지키지 못함. 그 Rhino가 없는 행 `950d3fb8`이 `connection`(`live:false`)을 가져 화면 '연결됨', `compliance/links` `open:true`·`chosen`. 원인(0.2.33의 T-282·T-284 변경, 엔진 재시작 뒤 남은 상태)을 PLAN-16에서 먼저 가리고, 법규 체크 대상 선택은 PLAN-48 | 죽은 행과 열린 행이 함께 있는 프로젝트에서 links·`compliance/links`·레이어 패널 머리, L1 R1-C·R1-HIDE | 죽은 행은 닫힘으로 보이고 법규 체크가 열린 문서를 읽어 결과 표가 나옴 · **웨이브 3: 완료(라운드 4 확인 전)** — 작업 사본은 PID가 살아 있을 때만 열림, 붙은 창은 호스트 목록에 있을 때만 · **R4: 해소** — 죽은 행 `connection: null`·`open:false`, 법규 체크가 열린 `06d19183`을 읽음 · **R5: 해소 유지** — 닫힌 행 데이터의 입력 사용은 T-298 · **R6: 해소 유지** |
| T-288 P0 후보 사이트 모델링 수집 뒤 4~7단계 미진행 | 원인 조사 먼저. 필지 확정·수집(필지 479·건물 173) 뒤 4. 좌표 통일 ~ 7. 건물 매스가 '계산 전'에 머물고, 결과 카드에 '사람 확인 대기: 대상 필지 확정'이 남음. 이어서 계산돼야 하는지 SPEC-12.3 이후 단계 기준으로 가리고 PLAN-45 | `r3-R1-B` 재현, L1 R1-B | 만들기 전 단계 도달 또는 다음 행동이 화면에 보임, 페르소나 막힘 0 · **웨이브 3: 완료(라운드 4 확인 전)** — 확정하면 다음 사람 단계 앞까지(사이트 모델링은 Rhino에 만들기 앞까지) 이어 계산 · **R4: 부분(핵심 해소)** — 1~8단계 계산, 만들기 앞에서 멈춤. 무진전 3(T-295) · **R5: 부분(핵심 해소 유지)** — 1~8 계산·만들기 앞, 무진전 3(T-295) · **R6: 부분(핵심 해소 유지)** — 1~8 계산·만들기 앞, 무진전 4는 T-304 |
| T-289 P0 후보 S-06 누락 입력을 넣을 곳 | SPEC-06.10의 안내('역할 카드에서 레이어를 고르거나 [입력 조립]을 여세요')가 가리키는 곳에 고르는 칸이 보이게 하거나 안내를 실제 위치에 맞춤(Design 해당 SCR → PLAN-23) | L1 R1-D | 페르소나가 슬래브 경계·기존 기초 입력을 넣고 다음 단계로 감 · **웨이브 3: 완료(라운드 4 확인 전)** — 역할 카드 [레이어 고르기]·막힌 단계 [입력 고르기] · **R4: 부분** — 역할 카드 맨 위·[레이어 고르기] → 선택칸 열림, 선택은 드라이버 한계(T-292), [입력 고르기] 미확인 · **R5: 부분(슬래브 경계만)** — 페르소나가 '3D::S-Slab' 선택 → 입력 조립 0/10 → 1/10·재계산, 기존 기초는 런 상한으로 미입력 · **R6: 해소** — 페르소나가 질문 카드로 슬래브 경계·기존 기초를 넣어 입력 조립 10·재계산 |
| T-290 P2 '새 세션 제안'의 내부 용어 | SPEC-02.19의 5 상자 문구에서 세션·토큰·원장·턴을 사람 말로 바꿈(Design, PLAN-24). jig 대화가 라운드를 넘어 이어지는 것은 T-280에서 다룸 | L1 R1-D `bannedWords` | 내부 용어 노출 0 · **R4: 재현 없음**(문구 미수정, jig 대화 새로 시작) · **R5: 재현 없음** · **R6: 재현 없음** |
| T-291 P2 jig가 열린 뒤 같은 문장 재전송의 무반응 | SPEC-02.17의 2에 이미 열린 jig로 다시 판정된 요청의 표시를 정하고 PLAN-19 | L1 R1-A 7–8단계 재현 | 재전송 때 안내가 보이고 입력칸이 비워짐 · **R4: 미착수·재현** — R1-A 재전송 2회 무반응으로 막힘 선언 · **웨이브 4: 완료(라운드 5 확인 전)** — 같은 글은 '이미 열려 있습니다 — <단계> 전'·입력칸 비움, 다른 글은 그 jig 대화의 AI 턴 · **R5: 해소(검수자 스크립트)** — 2·3번째 전송 '이미 열려 있습니다'·입력칸 비움(`.vide/loop/r5/t291`). 페르소나 재전송 없음 · **R6: 해소 유지(L1 처음)** — 페르소나 재전송에 '이미 열려 있습니다'·[일반 대화로]·입력칸 비움. 다음 행동을 몰라 막힘 표시 1(P2 관찰) |
| T-292 도구: 네이티브 선택칸·첫 Sync 값 | `tools/persona` 드라이버가 네이티브 `<select>`의 선택지를 읽고 고르게 하고(펼친 목록은 스크린샷에 안 그려짐), `host-link.ps1`의 `firstSync.ms`를 엔진 `sync` 값과 맞춤(R4: 20 vs 1,408 ms) | `tools/persona` 시험, L1 R1-D | R1-D 페르소나가 역할 카드에서 레이어를 고름, host-link 첫 Sync 값이 엔진 로그와 같음 · **웨이브 4: 완료(도구, 라운드 5 확인 전)** — 네이티브 `<select>` 선택지를 글로 읽고 고름, `firstSync.ms`는 엔진 `sync` 줄, R1-HIDE `afterGoal` U 되돌리기 · **R5: 해소(도구)** — 선택지 71개 글로 받아 선택, `firstSync.ms` = 엔진 값, U 되돌리기 · **R6: 해소 유지(도구)** |
| T-293 P0 후보 S-06 질문 카드 답이 역할 입력에 반영되지 않음 | AI가 질문 카드로 슬래브 경계·기존 기초 레이어를 묻고 답을 받았지만 역할 카드는 그대로였고, 다음 턴은 "역할을 정하는 일은 제가 할 수 없습니다". SPEC-07.14(역할 카드)·SPEC-06.10에 AI가 역할 입력을 제안·적용하는 길을 먼저 정하거나, 정할 수 없으면 묻지 않고 역할 카드로 안내하도록 SPEC-02.19의 6과 맞춘 뒤 PLAN-23 | L1 R1-D(`r4-R1-D/steps/07`–`10.png`) | 질문 카드 답이 역할 카드에 반영돼 다음 단계가 계산되거나, AI가 적용할 수 없는 선택을 묻지 않음 · **웨이브 4: 완료(라운드 5 확인 전)** — SPEC-07.18의 9(0.16): `jig_set_input`·`jig_ask_input`, 카드 답은 VIDE가 바로 적용. 검토 반영: 사람이 말하지 않은 레이어 거절(`NOT_NAMED`), 기록과 다른 카드·[권장값으로 진행]·계획 모드 카드의 답은 '제안된 입력' · **R5: 부분(미확인)** — `jig_set_input` 2회 `ok:true`인데 작업본은 17:28:11 이후 변화 없음, 카드 답 적용 화면 미확인(오보 후보로 다음 라운드에서 가림) · **웨이브 5: 완료(라운드 6 확인 전)** — 역할 카드 [레이어 고르기]가 남긴 `sync:<syncId>` 출처를 그 Sync의 연결 파일로 풀어 비교해, R5와 같은 `jig_set_input`(linkId·같은 레이어)이 `UNCHANGED`(SPEC-07.18 9.6, 0.18). 시험 `tests/server/jig-input.test.mjs` · **R6: 해소** — 페르소나 카드 답 바로 적용(입력 조립 10, 09:32:28), 검수자 확인 `UNCHANGED`를 AI가 그대로 말함, 작업본은 F1만 변경 |
| T-294 P2 질문 카드 답 메시지의 선택지 키 노출 | SPEC-02.19의 6·Design 문구: 답 메시지에서 `[target-file=…]`·`[slab-layer=…]`·`[footing-layers=…]` 같은 키를 빼고 사람이 고른 말만 보임(PLAN-24) | L1 R1-D `unknownWords` | 화면에 선택지 키 0 · **웨이브 4: 완료(라운드 5 확인 전)** — 답 메시지는 질문과 고른 말만, 키는 원장의 답 항목 · **R5: 해소** — 선택지 키 노출 0 · **R6: 해소 유지** |
| T-295 P2 사이트 모델링 확정 뒤 수집·결과 카드 상태 | 원인 조사 먼저. 확정 직후 '3. 수집'이 '막힘 · 대상 필지를 고르고 가져오세요'로 보여 [가져오기]가 필요했고, 1~8단계 계산 뒤에도 결과 카드에 '사람 확인 대기: 대상 필지 확정 · 멈춘 단계: 수집'이 남음. 수집(공공 자료 전송)을 확정 뒤 이어 할지 SPEC-12.3에서, 결과 카드 상태 갱신은 SPEC-07.18 3.6에서 가린 뒤 PLAN-45 | L1 R1-B(`r4-R1-B/steps/06`–`12.png`) | 확정 뒤 다음 행동이 하나로 보이고 결과 카드가 현재 단계와 맞음, 페르소나 무진전 0 · **웨이브 4: 완료(라운드 5 확인 전)** — 결과 줄이 다시 계산마다 마지막 계산을 따름(SPEC-02.17의 2), 확정 뒤 수집 표시(SPEC-12.3) · **R5: 부분** — 자동 수집·결과 카드 갱신 해소, 자동 수집 중 '수집 막힘 · 가져오세요'·흐린 [가져오기]가 보여 중복 수집(7,140 ms)·'바뀐 항목 2건' 상자 · **웨이브 5: 완료(라운드 6 확인 전)** — 첫 가져오기 동안 '수집 중…'·[가져오기] 비활성·추가 누름 무시(SPEC-12.3 0.16, `browser-site-model`) · **R6: 해소** — '수집 중…'·[가져오는 중...] 흐림, collect 1회 |
| T-296 P2 법규 체크 결과 직후 '다시 체크 필요' 띠·시각 0 | 결과가 나온 직후 '다시 체크 필요 · 대지가 바뀜' 띠, 입력 탭 '사이트 모델링 작업본 1 · 계산 1970-01-01 09:00'(앞 라운드의 계산 안 된 작업본). SPEC-15.1의 입력 출처·다시 체크 필요 조건을 확인하고 PLAN-48 | L1 R1-C(`r4-R1-C/steps/09`–`11.png`) | 방금 체크한 결과에 '다시 체크 필요'가 뜨지 않고, 계산 안 된 입력은 시각 대신 '계산 전'으로 보임 · **웨이브 4: 완료(라운드 5 확인 전)** — 계산 전이던 앞 작업본이 그대로면 '다시 체크 필요' 아님, 시각 대신 '계산 전'(SPEC-15) · **R5: 해소** — 띠·1970·내부 오류 0 · **R6: 해소 유지** |
| T-297 가드: 개발 시험의 플러그인 로드가 설치본 Rhino 등록을 바꿈 | 원인 확인 먼저. 2026-10-14 14:47:02에 개발 빌드(`…0413`)를 `LoadPlugIn`한 worker Rhino가 떴고(정황상 `tests/integration/browser-owned-editor.mjs` → `hosts/rhino/worker-client.ts` `launchRhinoWorker`), 14:56·15:11의 `worker:false` Rhino 셋도 같은 개발 빌드를 불러왔다. 0.2.35 설치(17:22)까지 등록이 개발 빌드였던 것으로 보인다. 개발 시험이 끝날 때 설치본 등록을 되돌리거나 시험 전후로 대조한다(`host-session.mjs`는 기준선 작업에서 레지스트리의 설치본 경로로 되돌리게 고침, 커밋 전) | `browser-owned-editor` 실행 전후 `FileName`·키 기록 시각 | 개발 시험 뒤 등록이 설치본 경로 그대로, 원인 확정 · **R5: 등록(원인 추정)** — 14:47 키 값은 덮어써져 직접 확인 못 함, 라운드 5 측정 구간(17:24–17:44)은 0.2.35 그대로 · **웨이브 5: 완료(구현·단위 시험, 실호스트 확인 전)** — `tests/integration/plugin-guard.mjs` `withInstalledPluginRestored`, `npm run verify`의 `plugin:check`([PLAN-03](PLAN-03-development-foundation.md) 0.5) · **R6: 부분(라운드 구간 충족)** — 9회 모두 0.2.36 설치 경로, 키 기록 09:23:54 그대로, `plugin:check` exit 0. 개발 시험 전후 대조는 이번에 없음 |
| T-298 P0 후보 닫힌 연결의 데이터가 jig 입력·화면에 쓰임 | 동작 판단 먼저. S-06 `site.slab` 출처의 instance가 열린 `abdee7ee`가 아니라 라운드 1 닫힌 Link `950d3fb8`(`persona-small.3dm`)였고, AI는 'Rhino 링크 5개'를 보았으며, R1-HIDE 토스트 2,265개 = 보 453 × Rhino 행 5. SPEC-01.11(닫힌 연결의 마지막 데이터를 화면·jig 입력에 쓰는지)과 SPEC-07.14(입력 출처)를 확인하고 PLAN-16·PLAN-23 | 닫힌 행과 열린 행이 함께 있는 프로젝트에서 S-06 역할 입력·화면 격리 개수, L1 R1-D·R1-HIDE | jig 입력과 화면 개수가 열린 연결(또는 사람이 고른 연결)만 따름 · **R5: 등록** — `.vide/loop/r5/jig-s06-r5.json` · **웨이브 5: 완료(라운드 6 확인 전)** — SPEC-07.5 7(0.18)·SPEC-01.11 4(0.51): 열린 연결 파일의 마지막 Sync 먼저, 닫힌 파일은 열린 쪽에 없을 때만 '닫힌 연결 기준'. 화면(역할 카드·화면 동작 개수)과 AI 경로(`jig_set_input`·`jig_ask_input`·`links_layers`, 엔진이 호스트에 열린 연결을 물음) 모두. VIDE에서 연 파일·[모델에 반영] 파일 항목은 열린 파일로 다룸 · **R6: 부분** — S-06 입력 출처 `bd2da829`·R1-HIDE 토스트 453개·'(닫힘)' 해소. Sync jig는 닫힌 CAD 데이터를 표시 없이 씀(T-302), 뷰포트·숨김 수는 닫힌 파일까지 그림(관찰) |
| T-299 P0 후보 Sync jig [AI 검토]의 진행 표시·중복 요청 | [AI 검토 (차이의 의미 판정)]가 대화 없이(`conversation null`) plan 요청을 시작하는데 현재 탭·패널에 진행 표시가 없어 두 번 눌렸고 Opus high 2건(46.8·51.2 s)이 중복으로 돌았다. SPEC-05.8·SPEC-07.18에 jig 안 AI 요청의 진행·결과 위치와 중복 누름을 정하고 PLAN-14 | L1 R1-A 9–12단계 | 누른 뒤 jig 안의 버튼이 '검토 중…'으로 바뀌고 진행·결과는 고른 대화에 보이며(SPEC-05.8 2), 중복 요청 0, 페르소나 막힘 0 · **R5: 등록** — `r5-R1-A/steps/09`–`12.png`, 요청 `1d39d5ec`·`8ae72842` · **웨이브 5: 완료(라운드 6 확인 전)** — [AI 검토]는 고른 대화의 요청(진행 행·결과는 그 대화), 대기·진행 중 버튼 '검토 중…'과 중복 요청 0. 보내는 내용은 계산 표뿐이고 대화 원장·세션·이전 교환은 붙이지 않음(SPEC-05.8 2, 0.20; `tests/server/conversations.test.mjs`) · **R6: 해소(검수자 확인)** — 요청 1건(`5df855a8`)·'검토 중…'·두 번째 누름은 안내만. 끝난 뒤 '진행 중' 안내 문구 남음(P2), 첫 출력 19.5 s |
| T-300 P1 법규 읽기 밖 이벤트 루프 정지 | 동작 변경 없음(원인 측정). R1-D 구간 loopMax 4,341·4,404 ms, 같은 구간에 `links_layers` 4,157·4,288 ms·`jig_ask_input` 4.1–4.4 s. T-274의 읽기 구간 4,303 ms(최장 조각 266 ms)도 같은 원인일 수 있다 | 설치본 사본에서 `links_layers`·`jig_ask_input`·법규 읽기 중 `health`와 단계 시간 | 원인 확인과 정지 감소 수치 · **R5: 등록** · **웨이브 5: 완료(라운드 6 확인 전)** — `links_layers`·`jig_ask_input`·`jig_set_input`의 레이어 목록을 행 해독 없이 매니페스트 개수로(합성 3,000개 3링크 < 300 ms, `tests/server/agent-tools-jig.test.mjs`). 남음: 설치본 재측정 · **R6: 미충족** — R1-D 첫 턴 구간 loopMax 2,240 ms(`links_layers` 2,236 ms), R1-A 구간 `links_layers` 4,040 ms |
| T-301 P0 ZWCAD 첫 Sync 실패(0.2.36 퇴행) | 원인 확인 먼저. 0.2.36에서 `cad.dwg` 첫 Sync가 두 번 모두 `HOST_BUSY`로 실패했다(`521f38e4` 148,802 ms·`ae875647` 140,734 ms, 26쪽 `displayPage` 60 s 상한). 같은 쪽이 라운드 5보다 2.2~3.3배 느렸고(`482D76` 21.9 s, R5 `482D7A` 6.6 s), 수신 `IOException` 77건·`host/selection` `server-error`(`HOST_INVALID_RESPONSE` 8건)가 함께 있었다. 두 번째 실패 뒤 스케줄러는 `wait`로 멈춰 열린 Link에 Sync가 없다. 웨이브 5 변경(블록 정의 캐시·연결별 수신·목록 상태 고정)을 라운드 5 쪽 시간과 대조해 가리고 [PLAN-07](PLAN-07-zwcad-attached-sync.md)·HOST-ZWCAD §1.1에서 고친다. 실패 뒤 다시 시도하지 않는 것은 SPEC-01.11에서 확인 | 연결 ID 없는 cad 사본, 설치본 첫 Sync `call-stages`, L1 R1-A | 첫 Sync 성공, 같은 쪽 시간이 라운드 5 이하, `host/selection` `server-error` 0 · **R6: 등록** — [VERIFY 라운드 6](../tdd/VERIFY-2026-10-15-loop-round-6.md) '속도' · **핫픽스: 완료(빌드·오프라인 시험, 라운드 7 확인 전)** — 원인은 블록 정의 캐시(기록 뒤 버리는 정의가 삽입마다 두 번 일함·메모리)와 연결별 수신의 10 s 대기. 표시 경로 되돌림, 60 s `HOST_BUSY`는 ZWCAD 차례를 못 얻은 호출만, 수신 대기 75 s, 느린 `HOST_BUSY`는 30·60·120 s 뒤 세 번 재시도(SPEC-01.11 10, 0.52). 아래 §5 '핫픽스 T-301' · **R7: 해소 확인** — 0.2.40 설치본에서 같은 `cad.dwg` 사본 첫 Sync 성공 74,010 ms, `HOST_BUSY` 0, 닫힌 연결 창('새 연결 파일') 28.6 s에 처리([VERIFY 라운드 7](../tdd/VERIFY-2026-10-16-loop-round-7.md)) |
| T-302 P0 후보 Sync jig가 닫힌 CAD 연결 데이터를 표시 없이 씀 | 열린 ZWCAD Link `7a2ab232`에 Sync가 없자 Sync jig의 'ZWCAD Sync' 칸이 라운드 5의 닫힌 `0300e5da` 데이터('cad.dwg · 10. 14. 오후 05:36')를 '(닫힘)' 없이 골라 비교했다. T-298(SPEC-07.5의 7)의 열린 연결 기준이 Sync jig 입력에도 적용되는지 SPEC-05.8에서 정하고 [PLAN-14](PLAN-14-jig-tab.md) | 열린 CAD Link에 Sync가 없고 닫힌 CAD 행에 데이터가 있는 프로젝트, L1 R1-A | Sync jig가 열린 연결의 Sync만 쓰거나, 닫힌 데이터면 '닫힌 연결 기준'을 보이고 사람이 고름 · **R6: 등록** — `r6-R1-A/steps/04`–`06.png` · **핫픽스와 함께: 완료(오프라인 시험, 라운드 7 확인 전)** — SPEC-05.8 '입력 Sync 고르기'(0.21): 기본값은 열린 연결의 최신 Sync, 닫힌 Sync는 구분선 뒤 '(닫힘)'으로 사람이 고를 때만, 열린 연결에 Sync가 없으면 고르지 않고 안내. 시험 `tests/core/closed-link-sources.test.mjs`(`syncPick`)·`browser-jigs` · **R7: 미확인**(페르소나 R1-A 생략) |
| T-303 P1 ZWCAD 연결 중 엔진 이벤트 루프 정지 | 동작 변경 없음(원인 측정). ZWCAD가 연결된 동안 1분 구간 loopMax가 2.9~22.0 s였다(R1-A 21,978 ms, T-299 11,727 ms·p99 4,496 ms, Sync 중 8,024 ms·p99 4,605 ms), RSS 최대 822 MB. R1-A 첫 시도의 스크린샷 20 s 시간 초과와 겹친다. T-301과 함께 측정 | 설치본 사본 ZWCAD 연결·Sync 중 `health`와 엔진 단계 시간 | 원인 확인과 정지 감소 수치 · **R6: 등록** |
| T-304 도구: 페르소나 드라이버 스크롤 | `tools/persona/run.mjs`에 스크롤(휠) 동작이 없어, R1-B 7–12단계가 화면 밖 '9. Rhino에 만들기' 내용을 찾느라 같은 화면에서 무진전 4가 됐다. 스크롤 동작을 더하고, 제품 패널이 스크롤되는지 함께 가린다 | `tools/persona` 시험, L1 R1-B | 화면 밖 단계를 페르소나가 스크롤로 찾음, 제품 원인 여부 기록 · **R6: 등록** — `r6-R1-B/steps.jsonl` 7–12단계 |
| T-305 P0 후보 S-06 '축선·배치' 실패·결과 0 | 원인 조사 먼저. 입력 조립 10 뒤에도 작업본의 '축선·배치'(`axes`)가 `failed`(395 ms)이고 이유가 기록되지 않았다. 기둥·평면·간섭은 `stale`, 거더·작은보 등은 0, `structure_summary` `STRUCTURE_NOT_COMPUTED`(라운드 5도 결과 0). 실패 이유 표시는 SPEC-07.12, 축선 입력은 SPEC-06에서 확인한 뒤 [PLAN-23](PLAN-23-s06-frame-jig.md) | `.vide/loop/r6/jig-s06-r6-after-t293.json`, L1 R1-D | 축선·배치가 계산되거나 실패 이유와 다음 행동이 화면에 보임 · **R6: 등록** |
| T-360 P0 모델링 요청이 문장 속 부름말로 jig에 강제 진입 | SPEC-02.17의 1(0.68)에 모델링 말·jig 사양 말 규칙을 더하고 `src/ui/request-route.ts` `jigFor`·`declinesJig`, `/route`의 Jev jig 목록 비움(`src/server/server.ts`) | `tests/core/request-route.test.mjs` T-360 블록, 설치본에서 원문 재전송(라운드 7) | 원문이 jig 없이 파일 작업으로 가고 '구조 검토해줘'는 여전히 jig · **핫픽스(§5 R6 아래)** · **R7: 확인** — 0.2.40 설치본 `/route`에 원문 재전송 → `document`(Jev, 200 ms; 마지막 문장을 뺀 모델링 말만으로도 `document`), '구조 검토해줘'·'구조 검토하고 싶은데 파악해줘' → `project/s06-frame`, '모델링이랑 도면 맞춰줘' → `sync` |
| T-361 P0 Codex CLI 판 범위 밖(0.163.0)으로 모든 Codex 요청 즉시 실패 | 이 PC의 Codex CLI가 2026-10-16 08:44 0.163.0으로 올라가 `src/ai/cli-compat.json`(≥0.157.0 <0.158.0) 밖이 됐다. [PLAN-24](PLAN-24-ai-conversations.md) T-059 절차대로 [SPIKE-2026-09-30](../tdd/SPIKE-2026-09-30-cli-session-resume.md) 0·④ 항목을 0.163에 다시 돌려 범위를 넓힌다. `CLI_VERSION_UNSUPPORTED` 문구에 발견한 판·허용 범위를 넣고(`src/ui/gateway.ts`, 오류의 `version`·`supported`) 설정 → AI 연결 행에도 같은 값을 보인다(SPEC-02 실패 문구) | 설치본에서 Codex 대화 1건(합성 요청), 범위 밖 판을 흉내 낸 단위 시험 | Codex 요청이 실행되고, 범위 밖일 때 문구에 판 번호·허용 범위가 보임 · **R7: 등록**([VERIFY 라운드 7](../tdd/VERIFY-2026-10-16-loop-round-7.md) F31) · **2026-10-19: 재검증 합격(0·④·app-server, [SPIKE](../tdd/SPIKE-2026-09-30-cli-session-resume.md)) → 범위 ≥0.157.0 <0.164.0으로 확대(0.163.0 확인), 실패 문구·설정 행에 공급자·판·범위 표시(SPEC-02.18의 6), 단위 시험 통과. 설치본 확인은 다음 릴리스** |
| T-362 P1 Rhino 읽기 전용 열림을 화면에 알리지 않음 | SPEC-01 연결 상태에 '읽기 전용으로 열림 · 저장 불가'를 더하고(`read-only-watch.ts`의 `document-read-only` 결과를 상태로), 연결 행 표시와 직접 적용 전 경고(Design 연결 행) | 합성 문서를 읽기 전용 속성으로 열어 행 표시·경고 확인 | 행에 표시, 적용 전 경고, 로그와 일치 · **R7: 등록**(F32) |
| T-363 P1 자료 정리 예측 오차·issues 단계 비용 | 예측을 단계별(select·statements·issues·proposals)로 마지막 실행의 비율로 계산하고 issues 단계의 문장당 호출(약 3회)을 묶음 처리(`src/knowledge/collect/survey.ts`·`stages.ts`), SPEC-08.9 예측 문구 보완 | 나진상가 증분 실행 예측 vs 실측(예고 1분·4회 → 실측 6분 20초·65회; 첫 정리 예고 192분·1,840회 → 실측 103분·1,728회) | 예측 오차 ±50% 안, issues 호출 수 절반 이하 · **R7: 등록**(F33) |
| T-364 P1 읽을 수 없는 폴더를 빈 폴더로 보고 문장 숨김 | `inventory.ts`의 readdir 실패 폴더는 '닿지 않음'으로 두고 그 아래 source를 removed로 바꾸지 않는다. 정리 결과에 '서버 폴더에 닿지 못함 n개' 표시(SPEC-08.9 실패 규칙) | 존재하지 않는 루트 하나를 섞은 합성 폴더로 숨김 0·안내 표시 확인 | 끊김 때 문장 수 변화 없음, 안내 표시 · **R7: 등록**(F34) |
| T-365 P2 홈 '목록에서 삭제' 문구 | '이 PC에서 삭제(사이트 목록은 숨김)'로 바꾸고 확인 창에 지우는 것(PC 데이터)·남는 것(작업 폴더·원본) 명시(SPEC-01 삭제 절, Design 홈) | browser 시험 | 문구·확인 창 반영 · **R7: 등록**(F35) |
| T-366 P1 취소한 요청의 CLI 프로세스가 606 s 생존 | 취소 때 `killOwnedProcess`가 바로 불리는지 확인하고(`src/ai/claude-cli.ts`), `cli-exit`까지의 시간을 `request-end`에 기록(SPEC-02.13 취소) | 합성 요청 취소 뒤 `cli-exit` ≤5 s | 취소 5 s 안에 프로세스 종료 · **R7: 등록**(F36) |

수정 티켓은 측정 뒤 T-269부터 등록하며 동작 변경은 해당 SPEC을 먼저 보완한다. 예상 후보: A의 Sync jig 채팅 진입(jig 열기와 질문의 구분, PLAN-14·PLAN-19), B의 프로젝트 주소 fallback(SPEC-12), D의 구조 검토 단일 진입점(SPEC-06·07), '응답 완료' 라벨과 실패 코드 분리, planned jig 영역 요청의 '준비 중' 카드(SPEC-02.17·07).

## 5. 라운드 로그

### R1 (2026-10-08)

측정·기록 완료([VERIFY](../tdd/VERIFY-2026-10-08-loop-round-1.md)). 개발 엔진의 핵심 편집 경로는 통과했다(R1-COLOR 3/3, 중앙값 8.7 s · A/B R1~R5 5/5, 오보 0). 반면 설치본 0.2.31의 사용자 문장 시나리오는 하나도 통과하지 못했다. 경로 판정은 R1-D·C·B만 맞았고, 그 셋도 R1-C·R1-B는 열린 jig에서 페르소나가 막혔다. R1-NOTE와 R1-RECONNECT는 기준이 어긋나 판정을 보류했다. R1-SYNC-PERF는 시험 스크립트가 연결 모달에서 멈춰 미시험이다. 검토 판정은 P0 5 · P1 1 · P2 2이고, 시험 도구 결함이 4건 있다. 졸업한 시나리오는 0/10이다.

| 발견 | 등급 | 수정 티켓 |
|---|---|---|
| R1-A 모델↔도면 문장이 파일 작업으로 감(알려진 결함) | P0 | T-269 |
| R1-HIDE 화면 경로 대상이 비어 AI 파일 편집으로 흐름 | P0 | T-270 |
| R1-C 법규 체크가 결과 표에 이르지 못하고 페르소나 막힘 | P0 | T-271 |
| R1-C '응답 완료' 뒤 결과 카드가 'AI가 요약하는 중'에 머묾 | P0 | T-272 |
| R1-B 대지 주소 출처 없음, 페르소나 막힘 | P0 | T-273 |
| 법규 체크를 열 때 이벤트 루프 5.7 s 정지, RSS +300 MB | P1 | T-274 |
| S-06 막힘 문구에 내부 키, 입력 방법 없음 | P2 | T-275 |
| 공통 UI 용어를 모름(Sync·연결 ID·AI WORK 등) | P2 | T-276 |
| 실호스트 시험이 `_VIDEConnect` 모달에서 멈춤 | 도구 | T-277 |
| 페르소나 막힘 과소 집계, 페르소나 전용 판정 없음 | 도구 | T-278 |
| R1-NOTE·R1-RECONNECT 기준 불일치 | 도구 | T-279 |
| 페르소나 런 사이 문서·대화 공유 | 도구 | T-280 |

#### 수정 웨이브 (2026-10-08, 커밋 `d62d813a` → v0.2.32)

수정은 개발 작업 트리에서 했고 2026-10-09 커밋 `d62d813a`로 v0.2.32를 GitHub에 게시·이 PC에 설치했다(엔진, Rhino 플러그인 `0.2.32-d62d5c87`, ZWCAD 플러그인 `0.2.32-69914a24`). 설치본 재확인은 라운드 2에서 한다. '완료'는 구현과 이번 웨이브에서 돌린 검증까지를 뜻하며 L1(설치본 페르소나)·L1'(실호스트) 재측정은 포함하지 않는다.

- **T-269 Sync jig 진입** — 부분. 구현: `reconcilesModelDrawing`(SPEC-02.17의 1, 편집 동사·확대 말이 함께 오면 Sync 아님 — 검토 반영), Sync jig의 빠진 호스트 안내(SPEC-07.18의 1). 검증: `tests/core/request-route.test.mjs`('model and drawing reconcile words …', 'reconcile words with edit verbs or zoom words …'), `browser-route`. L0 route-only R1-A 3/3 `jig sync`(`.vide/ab/r1b-dev-route`, `.vide/ab/r1b-scorecard-dev-route`, `expectedFail` 해제). 수정 전 기준은 HEAD 규칙 비교로 대신했다(`.vide/ab/r1b-pre-head-rules/`: HEAD `document` → 작업 트리 `jig sync`). `.vide/ab/r1b-dev-route-pre`는 수정 중인 작업 트리에서 잰 값이라 기준선으로 쓰지 않는다. 남음: L1 R1-A(Rhino+CAD 연결), SPEC-07.18의 안내 문구와 이 계획 T-269의 '선택 카드' 표현 정리(P2).
- **T-270 화면 경로 대상** — 부분. 구현: 부재 말 → 레이어(`memberLayers`), 빈 대상의 레이어 고르기 카드. 검토 반영: '보'는 조사·띄어쓰기가 뒤따를 때만, 한국어 레이어는 마디 전체·정해 둔 합성어만('보이게'·'보는'·'보도'·'도면정보'·'옹벽' 오매칭 제거, SPEC-02.17의 1). 검증: `request-route.test.mjs`('building words find layers …', 'member words skip 보이게/보는/보도 …'), `browser-route`. 남음: small 사본 R1-HIDE 화면 격리·U 되돌리기, L1 R1-HIDE.
- **T-271 법규 체크 결과 표까지** — 부분. 구현: SPEC-15.1의 1·2, PLAN-48(역할 안내·[법규 체크] 위치·`compliance/roles` 400). 검증: `tests/core/compliance-screen.test.mjs`, `browser-compliance`(`browser-compliance-chat`은 이번 웨이브에서 돌리지 않음). 남음: L1 R1-C(페르소나 막힘 0·결과 표 구분), SPEC-15.1 '늘 보인다'와 원격 화면·다시 체크 필요 띠의 정합(P2).
- **T-272 'AI가 요약하는 중' 잔존** — 부분. 구현: `skillTurnStatus`(SPEC-02.17의 2). 검토 반영: `leftSteps`는 사람이 누를 단계(`manual`로 남은 단계·때가 된 호스트 단계)만 보이고 확정된 사람 단계·막힌 뒷단계는 뺀다. 검증: `tests/core/skill-start.test.mjs`('skillTurnStatus …', 'leftSteps …'). 남음: R1-C 재현(설치본).
- **T-273 대지 주소 출처** — 부분. 구현: SPEC-12.3의 6 ①요청 글 ②프로젝트에서 확정한 주소 ③대상 필지 칸 안내(PLAN-45). 검증: `skill-start.test.mjs`(SPEC-12.3의 6), `browser-site-model`. 남음: SPEC-08 프로젝트 자료의 주소 진술 경로(SPEC에만 있음), L1 R1-B 공개 필지 실호출.
- **T-274 법규 체크 열 때 이벤트 루프 정지** — 부분. 구현: `compliance-read` 시간 줄(PLAN-48). 남음: 사본에서 원인 측정과 정지 감소 수치.
- **T-275 S-06 누락 입력 안내** — 완료(라운드 2 확인 전). 구현: `missingInputsMessage`가 선언된 제목과 넣는 곳만 보이고 키는 점검 결과의 실패 목록에만 남김(검토 반영, SPEC-07.14 `inputs-present` 문장 추가). 검증: `tests/core/s06-jig.test.mjs`('T-275 …'), `browser-s06-jig`. 남음: L1 R1-D.
- **T-276 공통 화면 용어** — 남음. Design 문구를 바꾸지 않았다.
- **T-277 대화창 없는 실호스트 연결** — 부분. 구현: `rhino-sync-perf.mjs`·`rhino-attached.mjs`·`rhino-attached-ai.mjs`·`linked-open-compare.mjs`가 모두 `connectScriptLines()`(`tools/ab/rhino-connect.mjs`)로 붙는다. 검증: 세 스크립트는 구문 검사만(`node --check`), 실행은 안 함. R1-SYNC-PERF small은 연결을 지나 undo 단계에서 'delta differs from full Sync'가 2회 재현(T-281로 분리), large는 미측정. 남음: `result.json` 두 개, 세 스크립트 실행.
- **T-278 페르소나 막힘·전용 판정** — 완료. 구현: `stuck`에 연속 무진전·`stuckFlagged`, 스코어카드의 `goalReached`와 `expect.aiRequests`(R1-HIDE 0, `tools/persona/scenarios.json`, 예전 run.json은 시나리오 파일에서 채움). 검증: `tools/ab/scorecard.test.mjs`('persona expect.aiRequests …', 'readPersona fills expect …'), 라운드 1 재채점 `.vide/ab/r1b-rescore-installed`(R1-HIDE P0 'AI 요청 1건(기대 0건)', R1-C P0 '막힘 표시 5단계').
- **T-279 시나리오 기준 정렬** — 완료. R1-NOTE 기대를 '호스트·jig 아님'으로, R1-RECONNECT 행 추가(`reconnectHonest`). 검증: `checks.test.mjs`·`scorecard.test.mjs`, L0 R1-NOTE PASS(`ask`, Jev).
- **T-280 페르소나 런 격리** — 부분. 새 대화·새 브라우저 문맥은 `tools/persona/run.mjs`가 하고, 문서 사본은 검수자가 런마다 새로 Link한다. 남음: 라운드 2 L1에서 런 사이 공유 0 확인.
- **T-281 undo 뒤 delta 불일치** — 남음(원인 미조사, 제품 결함 후보).

**L0 route-only 재검증**(개발 엔진·호스트 없음, `.vide/loop/r1b-dev`, 2026-10-08 19:12 KST; 하네스 종료 뒤 엔진 프로세스 없음 확인)

| 시나리오 | 경로 | 판정 | 라운드 1 |
|---|---|---|---|
| R1-D | jig `project/s06-frame`(rules) | PASS | PASS |
| R1-A ×3 | jig `sync`(rules) ×3 | PASS | EXPECTED-FAIL(`document` ×3) |
| R1-C | jig `vide/compliance-check`(rules) | PASS | PASS |
| R1-B | jig `vide/site-model`(rules) | PASS | PASS |
| R1-NOTE | `ask`(Jev, 0.3 s) | PASS | 판정 보류 |

통과율 5/5. 러너가 끝에 '엔진 로그 줄 없음'을 알렸지만 로그 파일에는 `route` 줄 7개가 있다(읽는 시점 문제로 보이며 route-only 판정에는 영향 없음).

**미시험(이번 웨이브)**
- L1 페르소나 R1-A·R1-HIDE·R1-C·R1-B와 L1' 실호스트 런: 다음 라운드(설치본 0.2.32)에서 한다.
- R1-SYNC-PERF small·large `result.json`: small은 undo 불일치(T-281), large는 실행 안 함.
- `rhino-attached.mjs`·`rhino-attached-ai.mjs`·`linked-open-compare.mjs` 실행: Rhino를 띄우지 않았다.
- 수정 전 L0 기준선의 엔진 측정: HEAD 깨끗한 작업 트리에서 엔진을 띄워 재지 않고 규칙 비교로 대신했다.

### R2 (2026-10-09)

설치본 0.2.32(커밋 `d62d813a`)에서 L1 페르소나 다섯 런과 route-only를 다시 쟀다([VERIFY](../tdd/VERIFY-2026-10-09-loop-round-2.md)). route-only는 7/7 PASS로, R1-A가 `document`에서 Sync jig로 바뀌었다. 스코어카드는 P0 5 · PASS 1(R1-NOTE)로 통과율 1/6이다. 페르소나 런 중 `goalReached: true`는 R1-A 하나이며 그것도 Sync jig가 열린 데까지다(비교 결과 Rhino 0개). 이번 L1은 CAD를 먼저 연결해 AI 요청 5건이 모두 ZWCAD로 갔다. 그래서 R1-HIDE·D·C·B는 Rhino만 연결해 다시 재야 판정이 유효하다. 라운드 1 P0 티켓 중 해소는 T-272뿐이고 T-269·T-270·T-271·T-273은 부분이다. 새 티켓은 P0 후보 3(T-282~T-284), P1 1(T-285), 도구 1(T-286)이다. 사본에 남은 연결 ID 때문에 다른 프로젝트 `실사용 검증 20261007`의 Link 경로가 바뀌었고, 되돌릴지는 사용자가 정한다. 오보 M1·엔진 종료는 0건이다. MCP 기준선·L1'·사용자 동승은 하지 않았다. 졸업은 0/10이다.

| 시나리오 | R1 판정 | R2 판정 | 티켓 상태 |
|---|---|---|---|
| R1-HIDE | P0 | P0(CAD 대상 오염, 재측정 필요) | T-270 부분 · T-286 |
| R1-D | P2(경로 PASS) | P0(무진전 2·목표 미도달, ZWCAD 기준 오염) | T-275 문구 해소 · T-272 해소 · T-286 |
| R1-A | P0(route `document` ×3) | P0(route `sync` 3/3, L1 막힘 5) | T-269 부분 · T-283 |
| R1-C | P0 | P0(읽기 `HOST_UNAVAILABLE`, 'VIDE 내부 오류') | T-271 부분 · T-272 해소 · T-282 |
| R1-B | P0 | P0(주소를 몰라 막힘, 제품 쪽은 P2 후보) | T-273 부분 · T-286 |
| R1-NOTE | 판정 보류 | PASS(route-only) | T-279 완료 |
| R1-COLOR · L0-R1..R5 · R1-SYNC-PERF · R1-RECONNECT | PASS · PASS · 미시험 · 판정 보류 | 미시험(L1' 생략) | T-277·T-281 남음 |

#### 수정 웨이브 2 (2026-10-14)

라운드 2 티켓을 개발 작업 트리에서 고쳤다(커밋 전). '완료'는 구현과 오프라인 시험(개발 엔진·가짜 호스트·브라우저 시험)까지이고, 설치본 L1·실호스트 확인은 0.2.33 릴리스 뒤 라운드 3에서 한다.

- **T-282 법규 체크 읽기 실패와 대상 연결** — 완료(라운드 3 확인 전). SPEC-15.1 2 '읽을 연결 고르기'(0.5): 열린 Rhino 연결만 읽고, 기억한 연결이 없이 여럿이면 고르기, 기억한 연결로 읽었어도 여럿이면 고르기 칸과 읽은 문서 이름을 함께 보이며, VIDE에서 연 Rhino 파일도 열린 연결로 센다. 읽기 실패는 409 `HOST_UNAVAILABLE`·`LINK_CHOICE_REQUIRED`(이유·다음 행동, '내부 오류' 아님). 검토 반영으로 다른 jig 읽기(`readForJig`)도 호스트의 `HOST_UNAVAILABLE`·`STALE_CONNECTION`·`HOST_BUSY`를 분류된 실패로 넘긴다(`HOST_UNAVAILABLE` 409). 검증: `tests/server/compliance-roles.test.mjs`(T-282 5건), `tests/server/bake-route.test.mjs`('a jig read of a closed Link …'), `tests/core/compliance-screen.test.mjs`, `browser-compliance`(닫힘·여럿·기억한 연결과 다른 열린 연결), `browser-compliance-chat`. 남음: 실제 `editors.list(true)` 응답으로 확인(L1 R1-C), 설치본 R1-C.
- **T-283 Sync jig 비교 Rhino 0개** — 부분. 원인: 사본 문서가 솔리드뿐이라 직선 요소가 없었다(저장소 읽기 결함 아님, PLAN-14). 화면이 0개인 쪽의 이유(읽지 못함 / 직선 요소 없음과 종류별 개수 / 고른 레이어에 없음)를 보인다(SPEC-05.8 0.17). 검증: `tests/server/sync-jig-route.test.mjs`, `tests/core/sync-jig.test.mjs`, `browser-jigs`. 남음: 솔리드 문서를 무엇으로 비교할지 제품 결정, L1 R1-A.
- **T-284 다른 프로젝트 연결 ID가 남은 문서** — 완료(라운드 3 확인 전). SPEC-01.11 1(0.48): 연결 ID는 고른 프로젝트 안에서만 잇고, 열린 창 하나는 한 프로젝트에서만 연결 상태이며, Link하면 다른 프로젝트의 행은 닫힘(따라갔으면 이전 파일로)으로 돌아간다. 검토 반영(P0): 여러 프로젝트의 ID를 지닌 문서를 Link 없이 다시 열면 가장 최근에 이어진 연결의 프로젝트 하나만 연결 상태·Sync가 된다(`matchProjects`, 스케줄러와 연결 목록 공통). 검증: `tests/server/link-choice.test.mjs`(T-284 4건), `tests/server/sync-scheduler.test.mjs`(T-284 2건), `browser-links`. 남음: 설치본에서 두 프로젝트 Link 재현, `실사용 검증 20261007` Link 경로를 되돌릴지 사용자 결정.
- **T-285 ZWCAD 첫 Sync 151 s** — 미착수(측정 티켓, 이번 웨이브에서 맡지 않음).
- **T-286 페르소나 런 호스트 구성·운영자 정보** — 완료(라운드 3 확인 전). `scenarios.json`의 `hosts`(R1-HIDE·D·C·B Rhino, R1-A Rhino+ZWCAD)와 R1-B `operator.address`, 드라이버의 운영자 답, 연결 ID를 뺀 사본(`tools/persona/host-link.ps1`·`strip-link-id.md`). 검증: `tools/persona/persona-step.test.mjs`, `tools/persona/host-link.test.mjs`. 남음: 실제 Rhino·ZWCAD에서 `host-link.ps1` 실행, '닫힌 연결 파일이 있습니다' 두 번째 창 무인 처리 확인.

수정 웨이브 2는 커밋 `cbf3f35b`(태그 `v0.2.33`)로 2026-10-14에 GitHub에 게시하고 이 PC에 설치했다(엔진 0.2.33, Rhino 플러그인 `0.2.33-92bb91a0`, ZWCAD 플러그인 `0.2.33-1933f094`).

### R3 (2026-10-14)

설치본 0.2.33에서 L1 페르소나 다섯 런과 route-only를 다시 쟀다([VERIFY](../tdd/VERIFY-2026-10-14-loop-round-3.md)).

- **결과:** route-only는 7/7 PASS다. 스코어카드는 P0 5 · PASS 1(R1-NOTE)로 통과율 1/6이다.
- **호스트 구성:** 이번에는 계획대로였다(T-286). R1-HIDE·D·C·B는 Rhino만, R1-A는 Rhino+ZWCAD였다. 페르소나 AI 요청 4건이 모두 `host: rhino`였고, R1-A는 원문 문장 그대로 Sync jig를 열었다.
- **페르소나 런:** 다섯 런 모두 P0다. R1-C를 막은 것은 새 결함 T-287이다. 라운드 1 행 `950d3fb8`은 그 Rhino가 없는데도 '연결됨'·열린 연결로 취급됐다. 법규 체크가 이 행을 골라 분류된 문구지만 사실과 다른 거절("열려 있지 않습니다")을 보였다.
- **티켓:** 라운드 2 티켓 가운데 T-286은 도구 범위에서 해소됐다. T-284는 다른 프로젝트 Link 변경 0건이지만, 외부 ID를 먼저 지워서 제품 규칙은 실측하지 못했다. T-282·T-283은 부분, T-285는 단독 100.4 s(경보선 5.0배)다.
- **새 티켓:** P0 T-287, P0 후보 T-288(사이트 모델링 4~7단계 미진행)·T-289(S-06 입력 넣을 곳), P2 T-290(새 세션 제안 내부 용어)·T-291(열린 jig 재전송 무반응)이다.
- **0건:** 오보 M1·엔진 종료·요청 실패.
- **하지 않은 것:** MCP 기준선·L1'·사용자 동승. `tools/persona/host-link.ps1`의 실물 결함 2건(PowerShell 5.1 배열, ZWCAD WinForms 대화창)은 고쳤고 커밋하지 않았다.
- **졸업:** 0/10.

| 시나리오 | R1 | R2 | R3 | 티켓 상태 |
|---|---|---|---|---|
| R1-HIDE | P0 | P0(CAD 오염) | P0(AI 요청 0 충족, '보' 못 찾아 SB10만 남김) | T-270 부분(재발) · T-287 |
| R1-D | P2(경로 PASS) | P0(오염) | P0(jig·Rhino 기준 맞음, 입력 넣을 곳 못 찾아 막힘 2, 내부 용어 세션·토큰) | T-272 해소 유지 · T-275 부분 · T-289 · T-290 |
| R1-A | P0(route `document` ×3) | P0(Sync jig, 비교 Rhino 0개) | P0(원문으로 jig 열림·이유 문구, 대응 0쌍, 막힘 3) | T-269 부분 · T-283 부분(제품 결정) · T-291 |
| R1-C | P0 | P0('VIDE 내부 오류') | P0(분류된 문구, 죽은 연결 선택으로 거짓 거절) | T-271 부분 · T-282 부분 · T-287 |
| R1-B | P0 | P0(주소 모름) | P0(운영자 답 주소·실호출·필지 확정, 4~7단계 계산 전) | T-273 부분 · T-286 해소(도구) · T-288 |
| R1-NOTE | 판정 보류 | PASS(route-only) | PASS(route-only) | T-279 완료 |
| R1-COLOR · L0-R1..R5 · R1-SYNC-PERF · R1-RECONNECT | PASS · PASS · 미시험 · 판정 보류 | 미시험 | 미시험(L1' 생략) | T-277·T-281 남음 · T-285 부분(ZWCAD 단독 100.4 s) |

#### 수정 웨이브 3 (2026-10-14)

라운드 3 티켓을 개발 작업 트리에서 고쳤다(커밋 전). '완료'는 구현과 오프라인 시험(개발 엔진·가짜 호스트·브라우저 시험)까지이고, 설치본 L1·실호스트 확인은 0.2.34 릴리스 뒤 라운드 4에서 한다. 공통 검증: `npm run typecheck`, `node --test tests/core tests/ai tests/server tests/contract`(1,667 통과), `tools/ab`·`tools/persona` 시험(54 통과), `browser-route`·`browser-s06-jig`·`browser-site-model`·`browser-jigs`·`browser-compliance`·`browser-links` 통과, `npm run docs:check`.

- **T-287 죽은 연결 행** — 완료(라운드 4 확인 전). SPEC-01.11 7(0.49): 작업 사본(`pid:startTicks`)은 그 프로세스가 살아 있을 때만, 플러그인으로 붙은 창은 호스트 목록에 있을 때만 열림이다(`ownedWindowOpen`, links 목록·법규 체크·AI `liveLinks`·자동 Sync 공통, [PLAN-16](PLAN-16-document-links.md#t-287)). 검증: `tests/server/link-choice.test.mjs`·`compliance-roles.test.mjs`(T-287)·`sync-scheduler.test.mjs`. 남음: 라운드 4 R1-C·R1-HIDE에서 links·`compliance/links`·레이어 패널 머리 확인. PID 재사용 시 시작 시각 대조는 하지 않는다(P2).
- **T-288 사이트 모델링 4~7단계** — 완료(라운드 4 확인 전). 원인: 시작 때의 '첫 사람 단계까지'가 패널의 모든 실행에 남았다. SPEC-07.18 3.6·SPEC-12.3 3: 확정하면 다음 사람 단계 앞까지(사이트 모델링은 Rhino에 만들기 앞까지) 이어 계산하고, 사람 단계·만들기는 넘지 않는다([PLAN-45](PLAN-45-site-massing-jigs.md)). 검증: `tests/core/site-model-jig.test.mjs`·`skill-start.test.mjs`, `browser-site-model`. 남음: 라운드 4 L1 R1-B.
- **T-270 화면 경로 '보' 대상** — 완료(라운드 4 확인 전). SPEC-02.17 1(0.63): 구조 약호(SB·SG·SC·SL·FT 등 + 번호)도 그 부재이고 맞는 레이어가 여럿이면 모두(Jev가 하나만 짚어도 모두), 레이어 고르기 카드의 '모두 (N개 레이어)'. 검토 반영(P1): 한 글자 약호(B·G·C·S·W·F)는 번호만 붙고 꼬리가 없을 때, 구조 상위 마디 아래이거나 같은 파일에 두 글자 약호가 있을 때만 쓰고, B+번호는 구조 상위 마디 아래에서만 보로 본다. 그리드·창호·단면·층·지하 아래와 RC 단독은 부재가 아니다. 검증: `tests/core/request-route.test.mjs`('one-letter codes skip basements, grids, openings, sections and RC alone' 등), `browser-route`. 남음: 라운드 4 R1-HIDE(보 레이어 3/3 남김, U 되돌리기).
- **T-289 S-06 입력 넣을 곳** — 완료(라운드 4 확인 전). SPEC-07.14·SPEC-07.12 막힘 문구: 역할 카드의 [레이어 고르기], 막힌 단계의 [입력 고르기]를 누르면 그 역할 카드가 맨 위로 오고 레이어 목록이 펼쳐진다(Design SCR-14 1.15). 검증: `tests/core/s06-jig.test.mjs`·`jig-panel.test.mjs`, `browser-s06-jig`. 남음: 라운드 4 L1 R1-D.
- **T-280 페르소나 런 격리** — 완료(도구, 라운드 4 확인 전). `tools/persona/run.mjs`·`isolation.mjs`: 런 전에 시나리오 `jigs`의 작업본에 묶인 열린 대화를 닫고 새 작업본을 만든다(`--fresh-jigs` 기본, 전용 프로젝트 안에서만). 검증: `tools/persona/isolation.test.mjs`. 남음: 라운드 4에서 jig 요청 `resume: false`와 런마다 사본 새로 Link 확인.
- **T-283 Sync jig 비교 Rhino 0개** — 부분. 사용자 결정으로 Rhino 솔리드는 기준 높이(사람 > 층 레벨+1.2 m > 높이 범위 가운데)의 단면 외곽선 변으로 비교한다(SPEC-05.8 0.18, `geometry-kit` 0.2.5 `sectionOutline`, [PLAN-14](PLAN-14-jig-tab.md)). 검증: `tests/core/sync-jig.test.mjs`, `tests/server/sync-jig-route.test.mjs`, `browser-jigs`. 남음: 설치본 R1-A 재측정(3,045개 단면 시간·대응 쌍), '층 레벨 = LEVEL/레벨 점' 정의의 사용자 확인, 도면 닫힌 폴리선을 변으로 나눌지.

수정 웨이브 3은 커밋 `c0943c5c`(태그 `v0.2.34`)로 2026-10-14에 GitHub에 게시하고 이 PC에 설치했다(엔진 0.2.34, Rhino 플러그인 `0.2.34-dd2d5185`, ZWCAD 플러그인 `0.2.34-c0f8ce19`). 라운드 3에서 고친 `tools/persona/host-link.ps1`도 이 커밋에 들어갔다.

### R4 (2026-10-14)

설치본 0.2.34에서 L1 페르소나 다섯 런과 route-only를 다시 쟀다([VERIFY](../tdd/VERIFY-2026-10-14-loop-round-4.md)).

- **결과:** route-only는 7/7 PASS다. 스코어카드는 P0 4 · P2 1(R1-HIDE) · PASS 1(R1-NOTE)로 통과율 1/6이다. R1-HIDE가 처음으로 P0를 벗어났다.
- **웨이브 3 확인:**
  - **T-287 해소:** 죽은 행은 `connection: null`·`open:false`였고, 법규 체크가 이번 Link `06d19183`을 읽어 결과 표까지 갔다. T-282도 해소다.
  - **T-270:** AI 요청 없이 보 레이어 22/22만 남겼다. U 되돌리기는 미시험이다.
  - **T-288:** 1~8단계를 계산하고 Rhino에 만들기 앞에서 멈췄다.
  - **T-283:** 솔리드 단면 변 2,044개로 대응 1쌍이 나왔다.
  - **T-280:** jig 격리 `full` ×4, 새 CLI 시작 3건 모두 `resume` 없음.
- **남은 막힘:** R1-D·A·C·B는 페르소나 막힘으로 P0다.
  - **R1-D:** 네이티브 `<select>`를 드라이버가 고르지 못했다(T-292). AI가 질문 카드로 레이어를 묻고도 역할에 반영하지 못했다(T-293).
  - **R1-A:** T-291이 재현됐다.
  - **R1-C:** 결과 행이 모두 '규제 조건 없음'이었고 결과 직후 '다시 체크 필요' 띠가 떴다(T-296).
  - **R1-B:** 확정 뒤 수집 '막힘' 표시와 남은 결과 카드 상태 때문이다(T-295).
- **속도:** Rhino small 첫 Sync 1,408 ms(충족). ZWCAD 단독 100,318 ms(경보선 5.0배, 라운드 3과 같음). T-274는 처음으로 실측했다. 법규 체크 읽기 6.4–6.8 s 중 classify가 5.25–5.39 s였고, loopMax는 5.66–5.83 s, RSS는 약 +350 MB였다.
- **0건:** 오보 M1·엔진 종료·요청 실패·`server-error`·다른 프로젝트 Link 변경. 이번에는 내부 용어(`세션`·`토큰`) 노출도 0건이다.
- **새 티켓:** 도구 T-292, P0 후보 T-293, P2 T-294~T-296.
- **하지 않은 것:** MCP 기준선·L1'·사용자 동승. R1-A 원문 L1(페르소나가 바꿔 씀). 런마다 사본 새로 Link.
- **졸업:** 0/10. R1-NOTE는 route-only PASS 3라운드 연속이지만 사용자 동승 0회·답 내용 미시험이다.

| 시나리오 | R1 | R2 | R3 | R4 | 티켓 상태 |
|---|---|---|---|---|---|
| R1-HIDE | P0 | P0(CAD 오염) | P0(SB10만 남김) | P2(보 22/22, AI 요청 0, 모르는 말) | T-270 부분(U 미시험) · T-287 해소 · T-276 |
| R1-D | P2(경로 PASS) | P0(오염) | P0(입력 넣을 곳 못 찾음) | P0(선택칸 열림, 드라이버가 못 고름, 질문 카드 답 미반영) | T-289 부분 · T-275 부분 · T-290 재현 없음 · T-292 · T-293 · T-294 |
| R1-A | P0(route `document` ×3) | P0(비교 Rhino 0개) | P0(대응 0쌍) | P0(단면 2,044·대응 1쌍, 재전송 무반응으로 막힘) | T-269 부분 · T-283 부분 · T-291 재현 |
| R1-C | P0 | P0('VIDE 내부 오류') | P0(죽은 연결로 거짓 거절) | P0(결과 표 도달, 규제 조건 없음·'다시 체크 필요' 띠로 막힘 1) | T-287·T-282 해소 · T-271 부분 · T-274 측정 · T-296 |
| R1-B | P0 | P0(주소 모름) | P0(4~7단계 계산 전) | P0(1~8 계산·만들기 앞 도달, 무진전 3) | T-288 부분(핵심 해소) · T-273 부분 · T-295 |
| R1-NOTE | 판정 보류 | PASS(route-only) | PASS(route-only) | PASS(route-only) | T-279 완료 |
| R1-COLOR · L0-R1..R5 · R1-SYNC-PERF · R1-RECONNECT | PASS · PASS · 미시험 · 판정 보류 | 미시험 | 미시험 | 미시험(L1' 생략) | T-277·T-281 남음 · T-285 부분(ZWCAD 단독 100.3 s) |

#### 수정 웨이브 4 (2026-10-14)

라운드 4 티켓을 개발 작업 트리에서 고쳤다(커밋 전). '완료'는 구현과 오프라인 시험(개발 엔진·가짜 호스트·브라우저 시험)까지이고, 설치본 L1·실호스트 확인은 0.2.35 릴리스 뒤 라운드 5에서 한다. 공통 검증: `npm run typecheck`, `node --test tests/core tests/ai tests/server tests/contract`(1,674 통과), `tools/ab`·`tools/persona` 시험(60 통과), 전체 `npm run test:browser`(64개 파일 통과. `browser-s06-jig`는 계획 모드 카드 답을 넣지 않게 바뀐 규칙에 맞춰 시험 턴을 자동 모드로 고친 뒤 통과), `npm run docs:check`.

- **T-293 질문 카드 답 → 역할 입력** — 완료(라운드 5 확인 전). SPEC-07.18의 9(0.15→0.16)·SPEC-07.5의 3·SPEC-06.10: AI는 `jig_set_input`으로 사람이 말한 레이어를 역할에 넣고, `jig_ask_input` 카드의 답은 VIDE가 바로 넣고 다음 사람 단계 앞까지 다시 계산한다(`src/server/jig-input.ts`). 검토 반영: ① 레이어의 전체 경로나 끝 이름이 이번 턴의 사람 글이나 원장의 사람 답(`by:user`)에 없으면 `NOT_NAMED`로 거절, ② 원장에 선택지 이름을 남기고 사람이 본 카드(턴 출력)가 기록과 다르면 넣지 않음, ③ [권장값으로 진행] 답은 가정(SPEC-02.19의 6)이라 넣지 않음, ④ 계획 모드 턴의 카드 답은 '제안된 입력'으로 남기고 [진행] 뒤 넣음(SPEC-02.20의 2, 0.66). 검증: `tests/server/jig-input.test.mjs`(3건). 남음: 라운드 5 L1 R1-D.
- **T-294 답 메시지의 키** — 완료(라운드 5 확인 전). 답 메시지는 질문과 고른 말만 담고 키는 원장 답 항목에 남는다(`formatAnswers`). 검증: `tests/server/turn-output.test.mjs`, `tests/server/make-acceptance.test.mjs`(M5 replay를 '→ 문제로 표시'와 원장 `ej-on-line`/`flag`로 고침).
- **T-291 열린 jig 재전송** — 완료(라운드 5 확인 전). SPEC-02.17의 2: 같은 글은 화면을 앞으로 가져와 '이미 열려 있습니다 — <남은 사람 단계> 전'과 입력칸 비움, 다른 글은 그 jig 대화의 AI 턴. 이때 주소(SPEC-12.3의 6)·요청의 값(SPEC-07.18의 3의 5)은 코드가 다시 읽지 않고 AI가 설정값·입력 역할 경로로 처리한다(0.66). 남음: 라운드 5 R1-A 7–8단계.
- **T-295 사이트 모델링 확정 뒤 표시** — 완료(라운드 5 확인 전). 결과 줄의 사람 확인 대기·멈춘 단계는 다시 계산마다 마지막 계산을 따른다(SPEC-02.17의 2), 확정 뒤 수집 표시는 SPEC-12.3(0.15). 남음: 라운드 5 R1-B.
- **T-296 법규 체크 '다시 체크 필요'·시각 0** — 완료(라운드 5 확인 전). SPEC-15(0.6): 체크 때 계산 전이던 앞 작업본이 그대로면 바뀐 것이 아니고, 그런 입력은 '계산 전'으로 보인다. 남음: 라운드 5 R1-C.
- **T-274 법규 체크 이벤트 루프 정지** — 완료(라운드 5 확인 전). 원인: 분류의 행 분석(대부분 닫힌 입체 판정)이 한 덩어리로 돌고 원본·보관 모델 압축·쓰기가 동기였다. 조치: `readClassifiedModelSliced`(약 50 ms 조각, 결과 동일)와 비동기 저장([PLAN-48](PLAN-48-compliance-check.md)). 측정(합성 3,000개, 같은 PC): 전 한 덩어리 3,357 ms(현장 문서 classify 5.25–5.39 s·loopMax 5.66–5.83 s) → 후 총 3,354 ms·최장 연속 110 ms·타이머 최장 간격 110 ms(63회 양보). 원본 35 MB 저장 동기 525 ms → 직렬화 약 0.2 s. 시험(`tests/core/compliance-read.test.mjs`)은 병렬 실행 부하에서 벽시계 200 ms 상한이 깨져(271 ms) 1,000개·5 ms 조각으로 줄이고 결과 동일·양보 > 0·루프 정지 < 1 s만 판정한다(약 2 s). 남음: 설치본 사본에서 loopMax·RSS 재측정.
- **T-285 ZWCAD 첫 Sync 100 s** — 분석·계측(동작 변경 없음, [PLAN-07](PLAN-07-zwcad-attached-sync.md) 0.4). 라운드 4 `ace931d3` 100,318 ms = 플러그인 `displayPage` 39회 68,648 ms(무거운 쪽 4개 63,285 ms, 2.7·0.5 MB/s로 기하 계산 추정) + 쪽 사이 30,075 ms(같은 수신 루프의 상태 조회 21회 14,230 ms, 엔진 쪽 처리 등 15,845 ms 미분해) + 끝 1,595 ms. 플러그인 `call-stages` 줄(대기·처리·읽기·직렬화·쓰기·가장 느린 개체)을 더했다(ARCH-01 진단 기록, 입력 경로·좌표 상한 그대로). 남음: 라운드 5에서 이 플러그인으로 원인 개체를 가린 뒤 수정 후보(블록 정의 캐시·XCLIP 사전 거름·Explode 캐시·Sync 중 상태 조회 멈춤·`pageSchema` 검사 축소).
- **T-276 공통 화면 용어** — 완료(라운드 5 확인 전). Design §07 표(1.16): 동기화·동기화 중·마지막 동기화(← Sync), 작업(← AI WORK), 요청 입력(← 작성기), 모델 읽기·읽기 n회(← 모델 조회), 되돌리기(마지막 변경)·되돌리기 n번(← 되돌리기 1단계·n단계), 프로그램 이름·CAD 프로그램(← 호스트), 자동(← 자동 (Jev)), 5시간 한도·7일 한도·한도 도달(← 5h·7일), 저장 확인(← 저장·재열기 검증), 화면에 그릴 수 없는 객체 n개(← 화면 표현 미지원), 이 파일을 프로젝트와 이어 둠(← 연결 ID), JIG 목록 머리 'JIG · 도구'. 검토 반영(1.17): SCR-12의 '작성기'·'자동 (Jev)'·'Sync 받기'와 SPEC-02.17의 1·5·SPEC-02.19의 2 인용, 서버 활동 문장(`sdk-execution.ts`)·보고서(`report.ts`)의 '저장·재열기 검증'을 '저장 확인'으로. 남음: 라운드 5 `unknownWords`.
- **T-292 도구: 네이티브 선택칸·첫 Sync 값** — 완료(도구, 라운드 5 확인 전). `tools/persona`: 켜진 `<select>`는 누르지 않고 선택지를 글로 보여 고르게 함, `host-link.ps1` `firstSync.ms`는 엔진 로그 `sync` 줄(벽시계는 `linkToSyncWallMs`), R1-HIDE `afterGoal` U 되돌리기. 검증: `tools/persona` 시험. 남음: 실제 엔진 화면(R1-D 역할 카드)의 선택은 라운드 5.

수정 웨이브 4는 커밋 `17cfc6c2`(태그 `v0.2.35`, 커밋 15:24 KST)로 2026-10-14에 GitHub에 게시하고 이 PC에 설치했다(엔진 0.2.35, 엔진 시작 17:21:38, Rhino 플러그인 `0.2.35-cfa0ac11`, ZWCAD 플러그인 `0.2.35-172b07e5`).

### R5 (2026-10-14)

설치본 0.2.35에서 L1 페르소나 다섯 런과 route-only를 다시 쟀고, 처음으로 rhino MCP 기준선(T-012)을 같은 날 재 비교했다([VERIFY](../tdd/VERIFY-2026-10-14-loop-round-5.md)).

- **결과:** route-only는 7/7 PASS다. 스코어카드는 P0 4 · P2 1(R1-HIDE) · PASS 1(R1-NOTE)로 통과율 1/6이며, 라운드 4와 같다. 페르소나 다섯 런 모두 `goalReached` true(대행 판정)지만, R1-D·A·C·B는 막힘·무진전 1~3건으로 P0다.
- **웨이브 4 확인:**
  - **T-270 해소:** 보 22/22, AI 요청 0, U로 23,822 → 0 복원.
  - **T-289·T-292:** 네이티브 선택칸에서 '3D::S-Slab'을 골라 입력 조립 1/10·재계산됐다.
  - **T-296 해소:** 띠·1970 없음.
  - **T-295 부분:** 자동 수집·결과 카드 갱신은 됐다. 다만 수집 중 '막힘' 표시가 남았다.
  - **T-291 해소:** 검수자 스크립트로 확인했다.
  - **T-294·T-275 해소.**
  - **T-269 해소:** 원문 문장으로 L1 Sync jig가 열렸다.
- **미충족·미확인:**
  - **T-274:** 최장 조각 약 266 ms, 읽기 구간 loopMax 4,303 ms다.
  - **T-293:** `jig_set_input` `ok:true`인데 작업본 변화가 없어, 카드 답 적용을 확인하지 못했다.
  - **T-276 부분:** `jig`·`Sync` 칸 이름·`site-model`·`check → failed`·모델 이름이 남았고, '동기화'·'자동'도 모른다고 했다.
  - **T-285:** 106.5 s(5.3배)다. 무거운 4쪽의 BlockReference가 62.0 s를 차지한다.
- **MCP 기준선(T-012):** VIDE(A, 엔진 totalMs) ÷ 터미널 Claude Code + rhino MCP(B, wall)는 R1 1.01 · R2 0.70 · R3 0.74 · R4 1.00 · R5 0.69(B 원래 실행 실패, 기본 도구 끈 변형 대비) · R1-COLOR 0.80이다. §2 ④ ≤1.0배는 5/6이고, R1이 +218 ms로 미충족이다. clientMs로는 R1 1.06·R4 1.02다. A 토큰은 B의 0.49~0.93배다. A·B 모두 대부분 1회라 판정력이 약하다. 사람 선택·생각 시간과 수작업 기준선은 재지 않았다(`tools/ab/baseline.json`).
- **가드:** 다른 프로젝트 Link 변경 0건이다. 플러그인 등록은 라운드 측정 구간(17:24–17:44, 9회) 내내 0.2.35였다. 기준선 A가 개발 빌드로 바꾼 것(17:57:54)은 18:02:17에 되돌렸고, 18:02:35에 install 200을 확인했다. 이번 라운드 전 14:47:02의 개발 빌드 로드는 T-297로 등록했다(원인 추정: `browser-owned-editor` 시험).
- **0건:** 요청 실패·엔진 종료·`server-error`·다른 프로젝트 Link 변경. 오보 M1은 요약 조회에 활동 기록이 없어 미판정이다(도구 실패는 턴 중간 `jig_output` NOT_FOUND 2회뿐).
- **새 티켓:** 가드 T-297, P0 후보 T-298(닫힌 연결 데이터가 jig 입력·화면에 쓰임)·T-299(Sync jig [AI 검토] 진행 표시·중복 요청), P1 T-300(법규 읽기 밖 정지).
- **하지 않은 것:** L1' Sync 성능·재연결, 사용자 동승, 런마다 사본 새로 Link, 사람이 직접 하는 B, 기준선 반복.
- **졸업:** 0/10. R1-NOTE는 route-only PASS 4라운드 연속이지만 사용자 동승 0회·답 내용 미시험이다. 한 라운드가 남은 것은 R1-COLOR·L0-R1..R5(미시험 라운드를 건너 센 값)와 R1-HIDE('P0 0·막힘 0' 기준)다. 모두 사용자 동승 1회가 필요하다.

| 시나리오 | R1 | R2 | R3 | R4 | R5 | 티켓 상태 |
|---|---|---|---|---|---|---|
| R1-HIDE | P0 | P0(CAD 오염) | P0(SB10만 남김) | P2(보 22/22, U 미시험) | P2(보 22/22, U 복원, 모르는 말) | T-270 해소 · T-276 부분 · T-298 |
| R1-D | P2(경로 PASS) | P0(오염) | P0(입력 넣을 곳 못 찾음) | P0(선택칸 못 고름, 카드 답 미반영) | P0(레이어 선택·재계산, AI 턴 대기 무진전 2) | T-289 부분 · T-292·T-294·T-275 해소 · T-293 미확인 · T-298 |
| R1-A | P0(route `document` ×3) | P0(비교 Rhino 0개) | P0(대응 0쌍) | P0(대응 1쌍, 재전송 무반응) | P0(원문으로 열림, [AI 검토] 진행 표시 없음) | T-269·T-291 해소 · T-283 부분 · T-299 |
| R1-C | P0 | P0('VIDE 내부 오류') | P0(죽은 연결로 거짓 거절) | P0(결과 표, '다시 체크 필요' 띠) | P0(결과 표, 띠 없음, AI 턴 중 막힘 1) | T-296 해소 · T-271 부분 · T-274 미충족 · T-300 |
| R1-B | P0 | P0(주소 모름) | P0(4~7단계 계산 전) | P0(만들기 앞, 무진전 3) | P0(자동 수집, 수집 중 '막힘' 표시로 무진전 3) | T-273 부분(주소 해소) · T-288 부분 · T-295 부분 |
| R1-NOTE | 판정 보류 | PASS(route-only) | PASS | PASS | PASS | T-279 완료 |
| R1-COLOR · L0-R1..R5 | PASS · PASS | 미시험 | 미시험 | 미시험 | PASS 3/3 · PASS 5/5(기준선 A, MCP 대비 0.69~1.01배) | T-012 측정 |
| R1-SYNC-PERF · R1-RECONNECT | 미시험 · 판정 보류 | 미시험 | 미시험 | 미시험 | 미시험 | T-277·T-281 남음 · T-285 부분(106.5 s) |

**T-012 기준선 결과(2026-10-14):** 에이전트 + rhino MCP 기준선을 처음 쟀다. 같은 모델의 6개 요청에서 VIDE는 0.69~1.01배였고, ≤1.0배는 5/6이다(R1 미충족). 수작업 기준선, 사람 선택 시간, 반복 3회는 남았다. 정본 값은 `tools/ab/baseline.json`과 [VERIFY 라운드 5](../tdd/VERIFY-2026-10-14-loop-round-5.md) '속도'다.

#### 수정 웨이브 5 (2026-10-15)

라운드 5 티켓을 개발 작업 트리에서 고쳤다(커밋 전). '완료'는 구현과 오프라인 시험(개발 엔진·가짜 호스트·호스트 없는 브라우저 시험)까지이고, 설치본 L1·실호스트 확인은 0.2.36 릴리스 뒤 라운드 6에서 한다. 사용자가 Rhino·ZWCAD를 쓰고 있어 실호스트 시험을 하지 않음(Rhino·ZWCAD를 띄우는 시험과 설치 엔진(47821)은 건드리지 않았다). 공통 검증: `npm run typecheck`, `node --test tests/core tests/ai tests/server tests/contract`(1,698개 중 1,697 통과, `request-objects` 1건은 병렬 부하의 `ECONNRESET`으로 단독 재실행 통과), `tools/ab`·`tools/persona` 시험(60 통과), 호스트 없는 `test:browser` 목록 64개 파일 통과(`browser-account-panel`은 실행 중 잘못 끊어 단독 재실행 통과), ZWCAD 플러그인(연결·worker) Release 빌드 오류 0, `npm run docs:check`.

- **T-298 닫힌 연결의 데이터** — 완료(라운드 6 확인 전). SPEC-07.5의 7(0.18)·SPEC-01.11의 4(0.51). 화면: 역할 카드의 출처와 화면 동작 알림의 개수는 열린 연결 파일 기준이며, 파일 항목(`kind: 'file'`)은 닫힌 연결이 아니다(`linkClosed`, `src/ui/jig-panel/role-sources.ts`). AI 경로: 엔진이 대화 턴마다 호스트에 열린 연결을 묻고(`Execution.openLinkIds`), `jig_set_input`·`jig_ask_input`은 열린 파일의 마지막 Sync를 먼저, 닫힌 파일은 열린 쪽에 그 레이어가 없을 때만 읽어 결과에 '닫힌 연결 기준'을 붙인다. `links_layers`는 열린 파일을 먼저 보이고 닫힌 파일에 `closed: true`. 물을 수 없으면 모든 연결을 열린 것으로 본다. 시험: `tests/core/closed-link-sources.test.mjs`(열린 Rhino Link + 파일 항목), `tests/server/jig-input.test.mjs`. 남음: 라운드 6 L1 R1-D·R1-HIDE.
- **T-293 역할 카드에서 먼저 고른 역할** — 완료(라운드 6 확인 전). R5에서 쓰인 경로: 역할 카드의 읽기는 `sync:<syncId>`로 남고 `jig_set_input`은 실제 linkId로 비교해 `NOT_NAMED`로 끝났다. 이제 그 Sync의 연결 파일로 풀어 비교해 `UNCHANGED`(SPEC-07.18 9.6, 0.18). 시험: `/reads`처럼 syncId만으로 확정한 역할(마지막 Sync·더 오래된 Sync) → R5와 같은 호출 → `UNCHANGED`. 남음: 라운드 6 R1-D 카드 답 적용 화면.
- **T-299 Sync jig [AI 검토]** — 완료(라운드 6 확인 전). 고른 대화의 요청으로 보내 진행 행·결과는 그 대화에, jig 안 버튼은 대기·진행 중 '검토 중…'이고 다시 눌러도 새 요청을 만들지 않는다. 검토 반영: 대화로 보내도 엔진은 `sync-review` 턴에 대화 원장·세션 이어 가기·이전 교환을 붙이지 않고 계산 표만 보낸다(`isTableOnlyReview`, SPEC-05.8의 2, 0.20). PLAN의 완료 기준도 '진행·결과는 고른 대화'로 맞췄다. 시험: `tests/server/conversations.test.mjs`(원장·대화·인계 항목 없음, `--resume` 없음).
- **T-295 수집 중 표시** — 완료(라운드 6 확인 전). SPEC-12.3의 3(0.16): 첫 가져오기 동안 '수집 중…', [가져오기] 비활성, 추가 누름 무시. 끝난 뒤 사람의 [다시 가져오기]는 막지 않는다. 시험: `browser-site-model`(`fetchingNotBlocked`).
- **T-274·T-300 이벤트 루프 정지** — 완료(라운드 6 확인 전, 동작 변경 없음). 읽기 구간의 동기 해시·보관 문서 읽기를 비동기로(`hashValueAsync`는 기존 출력과 같음, undefined·NaN 시험), `links_layers`·jig 입력 문서 목록은 매니페스트의 레이어 개수로(행 해독 없음). 남음: 설치본 사본에서 loopMax·RSS 재측정.
- **T-285 ZWCAD 첫 Sync** — 수정(빌드만, 측정은 라운드 6, [PLAN-07](PLAN-07-zwcad-attached-sync.md) 0.5). 블록 정의 캐시, 연결마다 따로 받는 수신(동시 16개), Sync 중 같은 도면의 목록 상태 고정(HOST-ZWCAD §1.1 0.33: 두 단계 이상 중첩 블록은 마지막 자리 차이만, 기록 예산·동시 연결 상한은 PLAN-07). 예상 약 45–60 s.
- **T-297 플러그인 등록 보호** — 완료(구현·단위 시험, 실호스트 확인 전, [PLAN-03](PLAN-03-development-foundation.md) 0.5). 개발 빌드를 `LoadPlugIn`하는 시험은 `withInstalledPluginRestored`로 감싸고, `npm run verify`의 `plugin:check`가 등록이 `.vide/build` 아래면 실패한다.

수정 웨이브 5는 커밋 `cb9446a2`(태그 `v0.2.36`, 커밋 08:54 KST)로 2026-10-15에 GitHub에 게시하고 이 PC에 설치했다(엔진 0.2.36, 엔진 시작 09:23:27, Rhino 플러그인 `0.2.36-8d8471c1`, ZWCAD 플러그인 `0.2.36-3d139670`, 두 플러그인 빌드 `1.0.0.0+202610150021`).

### R6 (2026-10-15)

설치본 0.2.36에서 라운드 5와 같은 절차로 L1 페르소나 다섯 런과 route-only를 다시 쟀다([VERIFY](../tdd/VERIFY-2026-10-15-loop-round-6.md)). MCP 기준선은 다시 재지 않고 라운드 5 값을 유지한다.

- **결과:** route-only는 7/7 PASS다. 스코어카드는 P0 3(R1-D·C·B) · P2 2(R1-HIDE·R1-A) · PASS 1(R1-NOTE)로 통과율 1/6이다. 검토 판정은 R1-A를 P0로 올린다(ZWCAD 첫 Sync 실패, 닫힌 CAD 데이터로 비교). 페르소나 다섯 런 모두 `goalReached` true(대행 판정)다.
- **웨이브 5 확인:**
  - **T-298 부분:** S-06 입력 출처가 열린 `bd2da829`, R1-HIDE 토스트 453개·파일별 개수·'(닫힘)'. Sync jig는 미해소(T-302).
  - **T-293 해소:** 페르소나 카드 답이 바로 적용됐다(입력 조립 10). 검수자 확인에서 `UNCHANGED`를 AI가 그대로 말했다.
  - **T-299 해소(검수자):** 요청 1건·'검토 중…'. 끝난 뒤 안내 문구가 남는다(P2).
  - **T-295 해소:** '수집 중…'·collect 1회.
  - **T-274 해소:** 법규 읽기 구간 loopMax 275·288 ms.
  - **T-297:** 등록 9회 모두 0.2.36 설치 경로.
- **미충족·퇴행:**
  - **T-285 퇴행:** ZWCAD 첫 Sync가 `HOST_BUSY`로 두 번 실패했고 같은 쪽이 2.2~3.3배 느려졌다(T-301).
  - **T-300:** R1-D 첫 턴 구간 loopMax 2,240 ms.
  - **T-273 재발:** 사이트 모델링이 '프로젝트에 저장된 주소가 없습니다'로 열렸다.
- **남은 막힘:** R1-D는 AI 턴 대기, R1-C는 AI 턴 대기와 '앞 작업본' 칸, R1-B는 화면 밖 9단계(드라이버 스크롤 없음, T-304), R1-A는 재전송 뒤 '이미 열려 있습니다'에서 다음 행동을 몰랐다.
- **가드:** 다른 프로젝트 Link 변경 0(13행 그대로), 플러그인 등록 변경 0. 사본은 저장되지 않았다.
- **0건:** 요청 실패·엔진 시작·요청에 걸린 `server-error`. `host/selection` `server-error` 9건(T-301)은 있다. 오보 M1은 미판정이다.
- **새 티켓:** P0 T-301, P0 후보 T-302·T-305, P1 T-303, 도구 T-304.
- **하지 않은 것:** MCP 기준선 재측정, L1', 사용자 동승(아직 0회), 런마다 사본 새로 Link.
- **졸업:** 0/10. R1-HIDE는 'P0 0·막힘 0' 3라운드 연속(R4~R6), R1-NOTE는 route-only PASS 5라운드 연속이다. 둘은 사용자 동승 1회(R1-NOTE는 답 내용 확인 포함) 뒤 졸업 판정 대상이다. R1-COLOR·L0-R1..R5는 측정 라운드 하나와 동승이 남았다.

| 시나리오 | R1 | R2 | R3 | R4 | R5 | R6 | 티켓 상태 |
|---|---|---|---|---|---|---|---|
| R1-HIDE | P0 | P0(CAD 오염) | P0(SB10만 남김) | P2(보 22/22, U 미시험) | P2(U 복원, 모르는 말) | P2(453개·'(닫힘)', U 복원) | T-270 해소 · T-298 부분 · T-276 부분 |
| R1-D | P2(경로 PASS) | P0(오염) | P0(입력 넣을 곳 못 찾음) | P0(선택칸 못 고름) | P0(레이어 선택·재계산, AI 턴 대기) | P0(카드 답 적용, AI 턴 대기 무진전 2, 결과 0) | T-289·T-293 해소 · T-300 미충족 · T-305 |
| R1-A | P0(route `document` ×3) | P0(비교 Rhino 0개) | P0(대응 0쌍) | P0(재전송 무반응) | P0([AI 검토] 진행 표시 없음) | P0(검토: ZWCAD 첫 Sync 실패, 닫힌 CAD 데이터로 비교; 스코어카드 P2) | T-269·T-291 해소 유지 · T-299 해소 · T-301 · T-302 · T-283 부분 |
| R1-C | P0 | P0('VIDE 내부 오류') | P0(죽은 연결로 거짓 거절) | P0('다시 체크 필요' 띠) | P0(AI 턴 중 막힘 1) | P0(AI 턴 대기, '앞 작업본' 칸 막힘) | T-274 해소 · T-271 부분 |
| R1-B | P0 | P0(주소 모름) | P0(4~7단계 계산 전) | P0(무진전 3) | P0(수집 중 '막힘' 표시) | P0(9단계 화면 밖 무진전 4, 주소 없음) | T-295 해소 · T-273 재발 · T-304 |
| R1-NOTE | 판정 보류 | PASS(route-only) | PASS | PASS | PASS | PASS | T-279 완료 |
| R1-COLOR · L0-R1..R5 | PASS · PASS | 미시험 | 미시험 | 미시험 | PASS 3/3 · PASS 5/5(기준선 A) | 미시험 | T-012 라운드 5 값 유지 |
| R1-SYNC-PERF · R1-RECONNECT | 미시험 · 판정 보류 | 미시험 | 미시험 | 미시험 | 미시험 | 미시험 | T-277·T-281 남음 · T-285 퇴행(T-301) |

#### 핫픽스 T-301 (2026-10-15)

라운드 6의 P0 T-301을 개발 작업 트리에서 고쳤다(커밋 전). 근거는 [VERIFY 라운드 6](../tdd/VERIFY-2026-10-15-loop-round-6.md)과 플러그인 로그(`zwcad-2026-10-15.jsonl`의 `521f38e4`·`ae875647` `call-stages`, 라운드 5 `zwcad-2026-10-14.jsonl`의 `7c3be22a`, 읽기만 함)다. 세부 대조표·행 번호는 [PLAN-07](PLAN-07-zwcad-attached-sync.md) 0.6의 T-301 절이 소유한다. 사용자가 Rhino·ZWCAD를 쓰고 있어 실호스트 시험을 하지 않음(Rhino·ZWCAD를 띄우는 시험과 설치 엔진(47821)은 건드리지 않았다).

- **원인:** 웨이브 5의 블록 정의 캐시. 정의를 다 기록한 뒤에 담을지 정해서, 캐시 예산(12,000,000값)·표시 상한·XCLIP 중첩에 걸린 정의는 삽입마다 기록과 다시 그리기를 두 번 했다. 기록이 점마다 객체를 만들어 ZWCAD 관리 힙이 커졌고, 캐시와 무관한 직렬화도 같은 바이트에 2~6배 느려졌다. 그래서 무거운 쪽이 2.2~3.2배 느려지고 26쪽이 60 s 상한에 걸렸다. 함께 넣은 연결별 수신은 받은 즉시 10 s 대기를 시작해, 엔진 정지(T-303) 동안 `IOException` 77건과 `host/selection`의 `HOST_INVALID_RESPONSE` 8건을 냈다.
- **변경(되돌림 + 상한 정리, 빌드만):** `AttachedDisplay.cs`의 표시 경로를 0.2.35(`17cfc6c2`)로 되돌리고 쪽 읽기 15 s 예산(넘으면 짧은 쪽, 엔진이 `next`부터 이어 읽음)을 더했다. `AttachedDocument.cs`는 60 s `HOST_BUSY`를 ZWCAD 차례를 얻지 못한 호출에만 쓰고, 시작한 `displayPage`·`displayChanges`는 끝까지 기다린다(최대 300 s). 요청 머리 대기는 75 s, 머리를 받지 못한 연결에는 답하지 않는다. `attached-documents.ts`는 쪽 호출 대기 330 s, 한 도면의 전체 읽기 10분(`SYNC_TIMEOUT`). 연결별 수신(동시 16개)과 Sync 중 목록 상태 고정은 유지했다(HOST-ZWCAD §1.1 0.34).
- **재시도 정책:** 10 s 이상 걸린 시도가 `HOST_BUSY`로 끝나면 30·60·120 s 뒤 최대 세 번 다시 하고 행에 '다시 시도 중 (n/3)'을, 다 쓰면 '응답이 느려 자동 동기화 멈춤 · ⟳로 다시 시도'를 보인다. 짧은 `HOST_BUSY`·`SOURCE_CHANGED`는 예전처럼 1·2·4… s로 30 s까지. 사용자 Sync 성공·문서 변경은 재시도 수를 지운다(SPEC-01.11의 10, 0.52; `src/server/sync-scheduler.ts`).
- **T-302:** 함께 고쳤다(SPEC-05.8 '입력 Sync 고르기', 0.21). Sync jig의 Rhino·ZWCAD Sync 칸은 열린 연결의 최신 Sync를 기본으로 고르고, 닫힌 Sync는 구분선 뒤 '(닫힘)'으로 사람이 고를 때만 쓴다. 열린 연결에 Sync가 없으면 고르지 않고 안내하며, Sync가 생기면 사람이 고르지 않은 칸은 그것을 고른다.
- **검증:** ZWCAD 플러그인(연결·worker) Release 빌드 오류·경고 0(임시 출력, 설치·로드 안 함), `npm run typecheck`, `node --test tests/core tests/ai tests/server tests/contract` 1,700개 중 1,699 통과(`legal-model-link` 1건은 병렬 부하에서 실패, 단독 재실행 5/5 통과, 이번 변경과 무관), `build:web`·`browser-jigs` 통과, 바꾼 파일 Prettier 통과, `npm run docs:check`. 새 시험: `tests/server/sync-scheduler.test.mjs`(느린 `HOST_BUSY` 재시도·멈춤), `tests/server/zwcad-capture-status.test.mjs`(짧은 쪽 이어 읽기·10분 상한), `tests/core/closed-link-sources.test.mjs`(`syncPick`), `browser-jigs`.
- **남음(라운드 7):** 0.2.37 설치 뒤 같은 `cad.dwg` 첫 Sync 성공, 쪽 read·serialize가 라운드 5 수준, 수신 `IOException`·`host/selection` `server-error` 0, R1-A Sync jig 칸의 열린 연결 기준. 첫 Sync는 약 100–110 s로 경보선 20 s를 넘으므로 T-285는 계속 열려 있다(캐시 재도입은 PLAN-07의 조건을 실호스트·SPIKE로 잰 뒤). T-303 정지 원인은 별도.

#### 핫픽스 T-360 (2026-10-16, 사용자 동승 중 발견)

설치본 0.2.39에서 사용자가 브릿지 모델링 요청(패널은 단일 surface, 내부 구조는 지름을 바꿀 수 있는 pipe, "구조 검토에 따라 변경될 수 있음")을 보냈는데 엔진 로그 `route by rules target jig project/s06-frame`가 네 번 연속 찍혔다. 문장 안의 '구조 검토'가 S-06 골조 jig의 부름말(구절, 점수 2)과 맞아 jig가 강제로 열렸고, jig는 입력이 없다며 멈췄다. 사용자는 "jig 열지 말고 그냥 모델링하는 작업으로"라고 썼지만 그 말은 규칙에 없었다. PLAN-51 등급으로 **P0 경로 오판**이다.

- **변경(SPEC-02.17의 1 보완, 0.68):** `src/ui/request-route.ts` `jigFor` — 요청이 모델링·구현 작업을 말하면(모델링을·모델링해·구현해 등) 부름말이 있어도 규칙으로 jig를 열지 않는다. 'jig 열지 말고'·'jig 없이'·'그냥 모델링'처럼 jig를 사양하는 말(`declinesJig`)이 있으면 규칙은 jig를 고르지 않고 `/route`는 Jev에 jig 목록을 비워 보낸다(`src/server/server.ts`). 부름말 자체인 요청('구조 검토해줘', '구조 검토하고 싶은데 파악해줘')과 Sync 맞춤 말('모델링이랑 도면 맞춰줘')은 그대로 jig다.
- **검증:** `tests/core/request-route.test.mjs` T-360 블록(원문 요지 → `document`, 부름말 → jig 유지, 사양 말 세 가지), 설치본에서 같은 글 재전송(라운드 7).
- **동승 관찰:** Rhino가 사용자 문서를 읽기 전용으로 열어 저장이 "temporary file could not be renamed"로 실패(VIDE는 `document-read-only`를 로그에만 남기고 화면에 알리지 않음 → T-362), 자료 정리가 연결 폴더 1,003파일·AI 호출 1,840번·약 192분으로 잡힘(실측은 103분, 예측 결함 → T-363), 홈의 '목록에서 삭제' 문구가 PC 데이터 삭제를 드러내지 않음(→ T-365).

### R7 (2026-10-16 밤, 부분)

사용자가 Rhino·ZWCAD를 닫고 "테스트 좀 돌려봐. 자율적으로 DB 생성도 되는지 … 나진상가 프로젝트로"라고 해서, 0.2.40을 설치(23:01, 플러그인 0.2.40-64eea32d·0.2.40-55732425)하고 호스트가 필요한 확인·route-only·자료 정리 실측만 했다([VERIFY](../tdd/VERIFY-2026-10-16-loop-round-7.md)). 페르소나·L1'은 돌리지 않았으므로 부분 라운드다.

- **결과:** T-360 설치본 재전송 5/5 · route-only 6/6 · **T-301 해소**(ZWCAD `cad.dwg` 사본 첫 Sync 74,010 ms 성공, `HOST_BUSY` 0, 닫힌 연결 창 28.6 s) · Rhino 사본 연결 22 s(첫 Sync 1,414 ms, 3,045개) · T-285는 경보선 3.7배로 열림.
- **자료 정리(지식 DB):** 나진상가 첫 정리는 사용자가 시작한 뒤 혼자 끝났다(15:26 → 17:09, 103분, AI 1,728회, 문장 3,837·이슈 1,388·일정 제안 13). 증분 업데이트 6분 20초·AI 65회. 예측(192분·1분)과 실측이 크게 어긋나고 issues 단계가 비용의 절반이다(T-363). 닿지 않는 폴더를 빈 폴더로 보고 문장 509개를 숨겼다(T-364). 기록 DB는 0건(설치 뒤 성공한 AI 요청이 없음, 되채우기 없음 — PLAN-53 결정 항목).
- **동승·로그 결함:** **P0 T-361** — Codex CLI 0.163.0이 `cli-compat.json` 범위 밖이라 사용자의 15:40·15:41 요청이 즉시 실패했고 문구에 판 번호가 없다. P1 T-362(읽기 전용 알림)·T-366(취소 뒤 CLI 606 s 생존), P2 T-365(삭제 문구).
- **도구:** `host-link.ps1 -OutDir` 상대 경로로 Rhino 1차 연결이 240 s 시간 초과(F38, 절대 경로화로 수정). `run.mjs --engine installed` route-only의 "no engine line" 경고는 T-266 메모(F39).
- **가드:** 다른 프로젝트 Link 변경 0, 플러그인 등록 변경 0(0.2.40 그대로), 엔진 시작·정지 0, 사본 저장 0, 호스트 종료 확인.
- **다음:** T-361은 2026-10-19 재검증 합격·범위 확대·문구 수정 완료(설치본 확인은 다음 릴리스), T-362~T-366은 결정 항목(Q1~Q5·R-NN)과 함께 수정 웨이브 6으로. 라운드 7 나머지(페르소나·L1')는 수정 웨이브 6 뒤 0.2.41 설치본에서.

## 6. 하지 않는 것(1회차)

MCP 기준선(2회차, rhino MCP 등록 뒤) · 가중 루브릭 · 화면 해시 멈춤 감지 · 페르소나 2명 · 스케치 드래그 · R1~R5 반복 · 별도 러너 · zwcad-sync-perf · 사용 중 피드백 단축키 · Computer Use.
