---
id: VERIFY-2026-10-16-loop-round-7
title: 검증–수정 루프 라운드 7(부분) — 설치본 0.2.40 route-only·실호스트 Sync·자료 정리 실측
status: review
version: 0.1
updated: 2026-10-16
owner: agent:claude
related: [PLAN-51, PLAN-07, PLAN-42, PLAN-53, PLAN-24, T-285, T-301, T-302, T-360, T-361, T-362, T-363, T-364, T-365, T-366, AC-22, AC-48, SPEC-01, SPEC-02, SPEC-05, SPEC-08, SPEC-17, HOST-ZWCAD, HOST-RHINO]
---

# 검증–수정 루프 라운드 7(부분)

[PLAN-51](../plans/PLAN-51-verify-loop.md) 핫픽스 T-301·T-302(라운드 6 뒤)와 핫픽스 T-360(2026-10-16 동승 중)을 담은 설치본 0.2.40에서 **호스트가 필요한 확인과 route-only만** 잰 기록이다. 사용자가 Rhino·ZWCAD를 닫고 "테스트 좀 돌려봐. 자율적으로 DB 생성도 되는지 … 나진상가 프로젝트로"라고 해서, 같은 밤에 (1) 0.2.40 설치, (2) T-360 설치본 재확인, (3) ZWCAD·Rhino 사본 첫 Sync, (4) 나진상가 프로젝트의 자료 정리(지식 DB) 실측을 했다. 페르소나 다섯 런과 L1' 자동 시험은 돌리지 않았으므로 **라운드 7 전체가 아니라 부분**이다. 판정 등급은 PLAN-51 §1·§2를 따른다.

**요약:**
- **T-360 확인:** 설치본 0.2.40 `/route`에 동승 때의 원문을 다시 보내면 `document`(Jev, 200 ms)로 간다. 마지막 문장("jig 열지 말고 …")을 빼도 모델링 말만으로 `document`다. '구조 검토해줘'·'구조 검토하고 싶은데 파악해줘'는 그대로 `project/s06-frame`, '모델링이랑 도면 맞춰줘'는 `sync`다(5/5).
- **T-301 해소 확인:** ZWCAD `cad.dwg` 사본 첫 Sync가 **74,010 ms(호스트 72,265 ms, 3,719개)로 성공**했다. 라운드 6은 두 번 모두 `HOST_BUSY` 실패, 라운드 5는 106,473 ms였다. `HOST_BUSY`·`server-error` 0. 닫힌 연결 창('새 연결 파일로 추가')은 28.6 s에 처리됐다(라운드 6은 197 s·시간 초과). 경보선 20 s는 아직 3.7배 넘는다(T-285 열림).
- **Rhino 사본 연결:** 열기 10.9 s · 프로젝트 창 16.7 s · 연결 21.1 s · 첫 Sync 1,414 ms(호스트 591 ms, 3,045개). 플러그인 0.2.40-64eea32d가 사용자 창 없이 로드됐다(`plugin-load` 23:20:02).
- **route-only(R1-D·A×3·C·NOTE):** 6/6 PASS.
- **자료 정리(지식 DB) 실측 — 나진상가:** 사용자가 15:26에 시작한 첫 정리가 **17:09에 사람 개입 없이 끝나 있었다**(103분). 23:08 증분 업데이트도 6분 20초에 끝났다. 'DB가 혼자 만들어지는가'의 답은 **그렇다**이지만, 예측이 크게 틀리고(192분 예고 → 103분, '1분·AI 4번' 예고 → 6분 20초·AI 65번) issues 단계가 문장당 AI 호출 약 3회로 비용의 절반을 차지한다(F33). 읽을 수 없는 폴더는 빈 폴더로 보고 문장을 숨긴다(F34).
- **동승·로그에서 새로 드러난 결함:** **P0 F31** — 이 PC의 Codex CLI가 08:44에 0.163.0으로 올라가 `cli-compat.json` 범위(0.157.x) 밖이 됐고, 사용자의 15:40·15:41 Codex 요청 두 건이 `CLI_VERSION_UNSUPPORTED`로 1·32 ms 만에 실패했다(화면 문구는 판 번호를 보이지 않음). 그 밖에 F32(읽기 전용 문서 알림 없음)·F36(취소한 요청의 CLI가 606 s 생존)·F35(삭제 문구).
- **새 티켓:** P0 T-361(Codex 판 범위·문구), P1 T-362(읽기 전용 알림), P1 T-363(자료 정리 예측·issues 비용), P1 T-364(닿지 않는 폴더), P1 T-366(취소 뒤 CLI 생존), P2 T-365(삭제 문구).

## 범위와 방법

| 항목 | 값 |
|---|---|
| 설치본 | VIDE 0.2.40(태그 `v0.2.40` = 커밋 `7eb41c3e`, 16:01 게시). 0.2.39 엔진은 22:59:15 `engine-exit` code 0(`asked: true`, `--quit`), Setup `--silent` 뒤 23:01:42 새 엔진(`sid fd4d7f26`). 그 뒤 검수자가 엔진을 재시작하거나 설정을 바꾸지 않았다 |
| 플러그인 | Rhino `…\VIDE\plugins\rhino\0.2.40-64eea32d\VIDE.Worker.rhp`(`plugin-load` 빌드 `1.0.0.0+202610161359`), ZWCAD `…\VIDE\plugins\zwcad\0.2.40-55732425\`. 연결 프로그램 둘 다 `current`. 호스트 시험 뒤 등록 재확인(아래 '가드') |
| 프로젝트 | 호스트·route-only는 전용 프로젝트 `검증 루프 R1`(`c8df446e…`)만. 자료 정리·`/route` 재전송은 사용자 요청으로 **나진상가**(`3d3f86a5…`)를 썼다(`/route`는 기록 없음, 자료 정리는 제품이 하는 읽기) |
| 사본 | `.vide/loop/r7/r7-small.3dm`(73,659,852 B, r1 `small.3dm`에서), `.vide/loop/r7/cad/cad.dwg`(1,298,103 B) + `XREF/`. CAD 사본의 다른 프로젝트 `66a46127` 연결 ID는 `-StripLinkId`로 지웠다. 두 사본 모두 저장되지 않았다(수정 시각 그대로) |
| 호스트 연결 | **ZWCAD** 23:16:11–23:18:05 `host-link.ps1` exit 0(열기 21.0 s, 프로젝트 창 23.3 s, 닫힌 연결 창 28.6 s, 연결 35.0 s, 첫 Sync 끝 111.1 s). **Rhino** 1차 23:19:41 실패(exit 1, 240 s — `-OutDir` 상대 경로 때문에 Rhino 안의 확인 스크립트가 다른 작업 폴더에 쓰려다 멈춤, 도구 결함 F38, 스크립트 수정) · 2차 23:24:46–23:25:08 exit 0. 둘 다 순서대로, 같은 시간에 하나만 열었다 |
| 자료 정리 | 설치 엔진 API `POST …/knowledge/collect`(증분). 수치는 `knowledge.sqlite`의 `run`·`source`·`statement` 표를 읽기 전용으로 센 것(문서 내용은 읽지 않음) |
| 도구 | `tools/persona/host-link.ps1`(이번에 `-OutDir` 절대 경로화), `tools/ab/run.mjs --plan tools/ab/scenarios-round1.json --engine installed --only R1-D,R1-A,R1-C,R1-NOTE`, 설치 엔진 로컬 세션 호출 스크립트(임시) |
| 시각(KST, 2026-10-16) | 설치 22:59–23:02 · 연결 프로그램 설치 23:02 · `/route` 재확인 23:05 · 자료 정리 증분 23:08:04–23:14:24 · ZWCAD 23:16–23:18 · route-only 23:20 · Rhino 1차 23:19–23:23 · Rhino 2차 23:24–23:25 · 호스트 종료·등록 확인 23:26 |

**하지 않은 것:** 페르소나 R1-HIDE·D·C·B·A(L1), L1'(R1-COLOR·L0-R1..R5·R1-SYNC-PERF·R1-RECONNECT), MCP 기준선, T-302의 Sync jig 칸 확인, ZWCAD 쪽 분해(`call-stages`), 사용자 동승(L2). 나진상가 원본을 호스트로 열지 않았다(읽기 전용 저장 실패 F32의 재현은 사용자 쪽 절차라 보류).

## 결과

| 항목 | 결과 | 판정 |
|---|---|---|
| T-360 설치본 재전송(`/route`, 나진상가) | 원문 → `document`(Jev, 200 ms) · 마지막 문장 뺀 원문 → `document`(170 ms) · '구조 검토해줘' → `project/s06-frame`(규칙) · '구조 검토하고 싶은데 파악해줘' → `project/s06-frame` · '모델링이랑 도면 맞춰줘' → `sync` | PASS 5/5 |
| route-only(검증 루프 R1) | R1-D s06-frame · R1-A sync ×3 · R1-C `vide/compliance-check` · R1-NOTE `ask`(Jev 0.2 s) | PASS 6/6 |
| ZWCAD 첫 Sync(T-301·T-285) | `9a2b52a6` 74,010 ms(호스트 72,265 ms), 3,719개, `succeeded`, `HOST_BUSY` 0, `IOException`·`host/selection` `server-error` 0 | T-301 해소 · T-285 P1(경보선 3.7배) |
| Rhino 첫 Sync(사본) | `0003858d` 1,414 ms(호스트 591 ms), 3,045개 | PASS(small ≤3 s) |
| 자료 정리 증분(나진상가) | 11파일·발췌 130 → 문장 11·이슈 재라벨 21, 6분 20초, AI 65회, 실패 0 | 동작 PASS · 예측 P1(F33) |

### 자료 정리(지식 DB) 실측 — 나진상가

`knowledge.sqlite`(121.9 MB, 23:14 기준): source 32,462(살아 있는 21,706 · removed 11,156 · generated 552) · excerpt 17,440 · statement 3,837(status removed 509 포함) · issue 1,388 → 1,240(살아 있는 문장 기준) · agenda_proposal 13 · mail 300 · dwg_text 444,082 · episode 83 · party_alias 0.

| 실행 | 단계별 시간·AI 호출 | 합 |
|---|---|---|
| 첫 정리(사용자 시작 15:26:12 → 17:09:12) | inventory 710 s(22,286파일, 바뀜 886) · extract 434 s(751파일, 발췌 6,434) · dwg 117 s(271파일, 읽음 194) · select 1,292 s / 107회(글 5,106) · statements 1,464 s / 217회(발췌 2,603) · issues 2,735 s / 1,384회(문장 3,282) · proposals 69 s / 20회(제안 13) | **103분, AI 1,728회**, 입력 토큰 약 7.0M·출력 약 2.4M. 예고는 '약 192분 · AI 1,840번 · 발췌 73,574' |
| 증분(23:08:04 → 23:14:24) | inventory 43 s(22,258파일, 바뀜 11, removed 980) · extract 3 s(6파일, 발췌 130) · dwg 19 s(5) · select 87 s / 1회 · statements 50 s / 1회 · issues 174 s / 62회(문장 21) · proposals 4 s / 1회 | **6분 20초, AI 65회**. 예고는 '읽을 파일 11 · 발췌 약 136 · AI 약 4번 · 약 1분' |

관찰: 예측기(`survey.ts`)는 발췌를 바이트/종류 비율로 세어 실제의 11배를 내고(73,574 vs 6,434), 걸러내기(select) 호출만 센다. 실제 비용의 절반은 issues 단계(문장당 약 3회 호출)에 있다. 첫 정리에서 inventory 710 s는 회사 서버 공유 폴더 나열 시간이다. 증분 실행의 'removed 980'은 대부분 `04_렌더링/…/BackUp` 등 읽지 않는 파일이지만, 서버 쪽 **읽어 둔 문서 5개가 함께 removed로 바뀌어 문장 509개가 status removed로 숨었다**(`inventory.ts`: readdir이 실패한 폴더는 빈 폴더로 처리 → 파일은 removed, 돌아오면 복구). 실제 삭제인지 순간 끊김인지는 확인하지 않았다(파일 이름이 개인 정보라 자동 확인을 멈춤).

기록 DB(`records`, PLAN-53)는 나진상가에서 **0건**이다. 자동 후보는 설치 뒤 **성공한 요청**에서만 생기는데(`candidateFromRequest`), 0.2.39 설치(13:34) 뒤 성공한 요청은 15:36 jig 실행 1건뿐이고 15:40·15:41의 AI 요청은 F31로 실패했다. 과거 요청 14건은 되채우지 않는다. 결함이 아니라 범위이며, '지난 요청에서 후보 만들기'는 PLAN-53 결정 항목으로 남긴다.

## 가드 결과

- **다른 프로젝트 Link:** `otherProjectLinksChanged: []`(ZWCAD·Rhino 둘 다). `links-before.json`(6,552 B) 대비 `links-after.json`에 검증 루프 R1의 새 행 `f2805b8d`(ZWCAD)·`f6bb52a5`(Rhino)만 더해졌다.
- **플러그인 등록:** 호스트 종료 뒤 Rhino `FileName`이 `0.2.40-64eea32d`, ZWCAD `LOADER`가 `0.2.40-55732425` 그대로. 연결 프로그램 둘 다 `current`.
- **엔진:** `engine-exits.jsonl`의 마지막 줄은 22:59:15의 `--quit`(asked true). 시험 중 엔진 시작·정지 없음.
- **사본 저장:** `r7-small.3dm`·`cad.dwg` 수정 시각 변화 없음(8월 3일·10월 7일 그대로). Rhino를 `-Close`로 닫은 뒤 잠금 파일 `r7-small.3dm.rhl`도 없어졌다(라운드 3~6에는 남았었다).
- **호스트:** 23:26 Rhino·ZWCAD 프로세스 0.

## 발견 목록

### 라운드 6 티켓의 상태

| 티켓 | 라운드 7 상태 | 근거 |
|---|---|---|
| T-301 | **해소** | ZWCAD 첫 Sync 성공 74,010 ms, `HOST_BUSY` 0 |
| T-285 | 열림(P1) | 74,010 ms, 경보선 3.7배. 라운드 5 대비 0.70배 |
| T-302 | 미확인 | 페르소나 R1-A 생략 |
| T-360 | **확인** | `/route` 5/5 |
| T-303·T-304·T-305 | 미확인 | 페르소나·ZWCAD 연결 중 health 구간을 보지 않음 |

### 새 발견

| ID | 등급 | 발견 | 증거 | 먼저 고칠 정본 | 티켓 |
|---|---|---|---|---|---|
| F31 | **P0** | 이 PC의 Codex CLI가 08:44에 0.163.0으로 올라가(`npm` 전역) `src/ai/cli-compat.json`의 범위(≥0.157.0 <0.158.0) 밖이 됐다. 사용자의 15:40:20·15:41:16 요청(`codex-cli`·`gpt-6-astra`)이 32 ms·1 ms 만에 `CLI_VERSION_UNSUPPORTED`로 실패했다. 화면 문구는 "판이 범위 밖"이라고만 하고 발견한 판·허용 범위를 보이지 않는다(오류 객체에는 `version`·`supported`가 있음). 동승 때 '입력이 없다'(jig)와 겹쳐 AI 길이 모두 막혔다 | `engine-2026-10-16.jsonl` `request-end` `0469b55d`·`610acda2`, `cli-compat.json`, `codex --version` | [PLAN-24](../plans/PLAN-24-ai-conversations.md) T-059 절차(SPIKE-2026-09-30 0·④ 재실행) → `cli-compat.json`, SPEC-02(실패 문구) | T-361 |
| F32 | P1 | Rhino가 사용자 문서를 읽기 전용으로 열어 저장이 "temporary file could not be renamed"로 실패했는데, VIDE는 `document-read-only`(15:36:44, 속성·잠금 파일·보유 프로세스 없음)를 로그에만 남기고 화면에 알리지 않았다. 직접 적용은 그대로 진행된다 | `engine-2026-10-16.jsonl` `document-read-only`, 사용자 스크린샷(동승) | [SPEC-01](../specs/SPEC-01-project-input-sync.md) 연결 상태(읽기 전용 행), Design 연결 행 | T-362 |
| F33 | P1 | 자료 정리 예측이 크게 틀린다(위 표). 발췌 11배 과대, select 호출만 계산, issues 단계(문장당 약 3회)는 예측에 없음. 사용자는 '192분'을 보고 중단했다가 결과적으로 혼자 끝난 것을 보지 못했다 | `knowledge.sqlite` `run` 8~21행, 동승 스크린샷 | [SPEC-08](../specs/SPEC-08-project-facts.md) SPEC-08.9의 1·5(예측 의미) → [PLAN-42](../plans/PLAN-42-dashboard-knowledge-collect.md) | T-363 |
| F34 | P1 | `inventory.ts`가 읽을 수 없는 폴더(공유 폴더 순간 끊김 포함)를 빈 폴더로 보고 그 아래 파일을 removed, 문장을 status removed로 숨긴다. 23:08 증분에서 서버 쪽 읽어 둔 문서 5개·문장 509개가 그렇게 됐고 화면에는 '정리 완료'만 보인다 | `knowledge.sqlite` `source.skip='removed'`·`seen_run`, `inventory.ts:209-212` | SPEC-08.9 실패 규칙('닿지 않음' 상태) → PLAN-42 | T-364 |
| F35 | P2 | 홈의 '목록에서 삭제'는 사이트 목록 숨김 + **이 PC 데이터 삭제**(SPEC-01 2026-10-01 결정)인데 문구가 PC 삭제를 드러내지 않는다 | `src/sharing/web/home.tsx`, `src/server/server.ts purgeProject` | SPEC-01 삭제 절 문구, Design 홈 | T-365 |
| F36 | P1 | 사용자가 15:40:47 요청 `ba4616b6`을 6.2 s에 취소했는데 claude CLI 프로세스(pid 29540)는 15:50:54까지 606 s 살아 있다가 code 1로 끝났다(`cli-exit`). 구독 사용과 다음 요청 지연 가능 | `engine-2026-10-16.jsonl` `request-end`·`cli-exit` `ba4616b6` | [PLAN-24](../plans/PLAN-24-ai-conversations.md) 취소 규칙(SPEC-02.13) | T-366 |
| F37 | 관찰 | 기록 DB가 나진상가에서 0건(위 '자료 정리' 절). 결함 아님, 되채우기는 결정 항목 | `project.sqlite` `records` 0·`workspace_requests` 14 | PLAN-53 결정 목록 | - |
| F38 | 도구 | `host-link.ps1 -OutDir`에 상대 경로를 주면 Rhino 확인 스크립트가 Rhino의 작업 폴더 기준으로 써서 240 s 시간 초과가 난다 | `.vide/loop/r7/host-link-rhino.json`(1차) | `tools/persona/host-link.ps1`(이번에 절대 경로화) | 수정됨 |
| F39 | 도구 | `tools/ab/run.mjs --engine installed`가 route-only만 돌릴 때 "logs: no engine line … during the run" 경고를 낸다(route 이벤트는 있음, 요청 단계만 없음) | `.vide/loop/r7/route-only.log` | `tools/ab/run.mjs`(route-only에서는 조인 생략) | T-266에 메모 |

## 졸업 현황

부분 라운드이므로 페르소나 시나리오의 연속 수는 바꾸지 않는다. route-only(R1-D·A·C·NOTE)는 7라운드 연속 PASS다. R1-COLOR·L0-R1..R5·R1-SYNC-PERF·R1-RECONNECT는 미시험 그대로. 사용자 동승은 2026-10-16 오후에 한 번 있었으나 15분 절차(기록 탭·차트·띠)는 F31·F32·T-360으로 끝까지 가지 못해 **동승 1회로 세지 않는다**.

## 미시험

| 대상 | 상태 | 이유 |
|---|---|---|
| 페르소나 R1-HIDE·D·C·B·A, T-302 | 미시험 | 이번 밤 범위 밖(호스트 Sync·DB 실측 우선) |
| L1' R1-COLOR·L0-R1..R5·R1-SYNC-PERF·R1-RECONNECT | 미시험 | 개발 엔진·개발 빌드 플러그인 등록 뒤집기가 필요해 생략 |
| ZWCAD 쪽 분해·`omittedTypes`·메모리(PLAN-07 0.5) | 미측정 | `call-stages`를 읽지 않음 |
| F32 재현(읽기 전용 열림) | 미재현 | 사용자 원본과 사용자 Rhino 절차가 필요 |
| F34의 5개 문서 실제 존재 | 미확인 | 파일 이름 개인 정보로 자동 확인 중단 |
| Codex 0.163 동작(SPIKE 0·④) | 미시험 | T-361에서 |
| MCP 기준선, L2 동승 | 미시험 | 라운드 5 값 유지 · 동승 아직 0회 |

## 증거 보존

- `.vide/loop/r7/`: `host-link-zwcad.json`·`.err.log`, `host-link-rhino.json`(1차 실패)·`host-link-rhino2.json`·`.err.log`, `rhino/state.json`, `links-before.json`·`links-after.json`, `route-only.log`, `state.json`, 사본 `r7-small.3dm`·`cad/`.
- `.vide/ab/2026-10-16T14-20-03-866Z/results.json`(route-only).
- 엔진 로그 `%LOCALAPPDATA%\VIDE\logs\engine-2026-10-16.jsonl`(`sync` `9a2b52a6`·`0003858d`, `request-end` `0469b55d`·`610acda2`·`ba4616b6`, `document-read-only`), `rhino-2026-10-16.jsonl`(`plugin-load` pid 65732·8924), `engine-exits.jsonl`.
- 자료 정리 수치는 `%LOCALAPPDATA%\VIDE\projects\3d3f86a5…\knowledge.sqlite`의 `run`·`source`·`statement`·`meta` 표(읽기 전용). 문서 내용·카톡·메일 본문·파일 이름은 이 기록에 넣지 않았다.
