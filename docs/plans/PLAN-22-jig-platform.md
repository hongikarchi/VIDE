---
id: PLAN-22
title: jig 플랫폼 1차 — 작업본·형식·실행·Rhino에 만들기·만들기 대화
status: review
version: 0.3
updated: 2026-10-01
owner: agent:claude
related: [PLAN, PLAN-23, PLAN-24, ADR-022, FR-24, FR-23, FR-18, AC-41, AC-43, AC-44, AC-45, SPEC-07, SPEC-05, SPEC-01, SPEC-06, ARCH-03, ARCH-01, ADR-020, ADR-021, ADR-014, RESEARCH-10]
---

# jig 플랫폼 1차 — 작업본·형식·실행·Rhino에 만들기·만들기 대화

## 목적과 기준

FR-24의 1차 범위를 실제 흐름으로 잇는다. 흐름은 다음과 같다.
1. jig를 형식 v3로 불러 작업본을 만든다.
2. 설정값을 바꾸면 AI 없이 다시 계산한다.
3. 결과를 3D 겹침 층과 선언형 패널로 보인다.
4. Rhino에 만들기로 호스트에 옮긴다. 지금은 연결 Rhino 문서에 바로 만들고 Rhino 되돌리기로 무른다([ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md), T-055 현황). 작업 사본 → 후보 → 반영은 대체 경로다.
5. 1차 끝(M5)에는 VIDE 안의 만들기 대화로 jig 하나를 만든다.

기준 문서:
- 동작: [SPEC-07](../specs/SPEC-07-jig-platform.md). 완료 기준은 .1, 작업본 .4, 입력 조립 .5, 설정값 .6, 다시 계산 .7, 수정 사항 .8, 실행 위치 .9, 선언형 화면 .10, 보고서 .11, Rhino에 만들기 .12, 사람이 고친 것 .13, 점검 .14, 가져오기·고정 .15, 만들기 대화 .16, 실패와 복구 .17이다. 그 밖에 [SPEC-05](../specs/SPEC-05-extensions-install.md) .8(JIG 탭), [SPEC-01](../specs/SPEC-01-project-input-sync.md) .2(부분 취득의 누락 표시)·.11(연결 파일)
- 물리 계약: [ARCH-03](../architecture/ARCH-03-jig-runtime.md)(패키지·작업본·실행기·서버 경로·jig 입력 읽기·Rhino에 만들기·스키마 v5·서명), [ARCH-01](../architecture/ARCH-01-system.md)(표시 페이지 취득의 범위 수·레이어 표)
- 결정: [ADR-020](../decisions/ADR-020-jig-platform.md), [ADR-014](../decisions/ADR-014-sdk-agent-execution.md) 범위 좁힘(결정 A7), 만들기 대화의 세션은 [ADR-021](../decisions/ADR-021-conversation-sessions.md)
- 화면: [Design](../../Design.md) 작업공간 탭, SCR-13(jig 실행)·SCR-14(입력 조립)·SCR-16(만들기)·SCR-17(보고서)·SCR-18(JIG 목록)·SCR-19(자료)와 부품 목록. 화면 문구는 결정 A13의 실무어를 쓴다
- 수용: PRD AC-41·43·44·45
- 설계 근거와 대안: [RESEARCH-10](../research/RESEARCH-10-vide-restructure.md) §3~§7·§12·§13

첫 실물 jig는 [PLAN-23](PLAN-23-s06-frame-jig.md)의 S-06 골조 jig다. 대화 세션·접수 규칙·AI 도구는 [PLAN-24](PLAN-24-ai-conversations.md)가 소유한다.

## 범위 밖(1차)

- 만들기 화면 전체(코드 보기·단계 흐름 그림·초안 보관함·버전 비교), 부품으로 표현할 수 없는 사용자 정의 화면(SPEC-07 범위 밖)
- 플러그인 내장 만들기 틀, CAD에 만들기, 기존 객체를 고치는 jig 조작(결정 B14 보류)
- 다른 PC·다른 사용자가 만든 jig의 설치·보관소·검증·게시(결정 C1~C3 보류). 1차 가져오기는 이 PC에서 서명한 묶음만
- Sync 2차(정확한 곡선·변경 알림·보존 정책)
- 표시용 Sync의 꺼진 레이어 포함 여부와 입력 조립에서 숨김 포함 읽기를 켜는 선택지(결정 B10 보류). 1차에 숨김 포함으로 읽는 것은 SPEC-07.12의 만들기 직전 읽기뿐이다
- 보고서의 PDF 등 추가 형식(OQ-08·결정 B9 보류. 1차는 자체 포함 HTML·CSV), Design §01 문장의 보고서·단계 레일 예외(결정 B15 보류)

2차 이후 묶음은 RESEARCH-10 §15.3·§15.4에 두고 여기서 번호를 주지 않는다.

## 선행 조건과 공통 규칙

- **문서:** SPEC-07·ARCH-03·ADR-020은 review다. 각 티켓은 가이드 §05의 시작 조건을 확인한다.
- **병행 세션과 충돌 줄이기:**
  - 새 코드는 새 파일에 둔다: `src/ui/workspaces.ts`, `src/ui/kit/`, `src/ui/jig-panel/`, `src/jigs/runtime/`, `src/jigs/bake/`, `src/server/jig-routes.ts`
  - `src/ui/app.ts`·`src/server/server.ts`·`src/ui/style.css`에는 초기화·위임 몇 줄만 더한다. `/jigs/*` 경로 분리를 먼저 한다.
  - SCR-12 영역(`src/ui/host-panel.tsx`, `hosts/common/PanelPage.cs`, 사용량 막대)은 건드리지 않는다. 패널 모드(`?panel=`)에서는 작업공간 탭·jig 화면을 그리지 않는다.
  - 스키마 개정은 T-045 하나로 모은다.
- **플러그인 재빌드는 T-043 한 번뿐이다.** Rhino 플러그인 변경(`DisplayScene.cs`, `WorkerScene.cs`, `EditorApplication.cs`)을 이 티켓에 모은다. Rhino에 만들기(T-055)는 기존 `worker.execute` 경로를 써서 재빌드가 없다.
- **설치본:** 티켓의 완료 기준은 개발 빌드(`npm run dev`)와 `.vide/` 아래 합성 문서 검증까지다. 설치본(47821) 반영은 사용자가 요청할 때 묶음 릴리스로 한다. 플러그인은 PLAN-21이 남긴 설치본 배포와 같은 버전이나 그 뒤 버전으로 낸다. 플러그인을 바꾸려면 사용자 Rhino를 닫아야 하며, 에이전트는 자기가 띄운 호스트만 종료한다.
- **원본 보호:** 에이전트는 사용자 원본을 호스트로 열지 않는다. 시험은 `.vide/` 사본이나 합성 문서로 한다(AI.md §8). jig는 원본에 직접 쓰지 않는다.

## 작업 묶음 → 티켓

RESEARCH-10 §15.2의 임시 표지 가운데 이 계획이 맡는 것이다. 전체 순서는 [마스터 PLAN §6.1](PLAN.md)을 따른다.

| RESEARCH-10 묶음 | 티켓 | 마일스톤 | 재빌드 |
|---|---|---|---|
| WP-03 겹침 층·비모달 | T-041 | M0 | — |
| WP-08 Sync 범위·레이어 표·레이어 한정 읽기·import 보강 | T-043 | M0 | **Rhino 플러그인** |
| WP-37 스키마 v5 | T-045 | M1 | — |
| WP-04 형식 v3·작업본·실행기 | T-046 | M1 | — |
| WP-03 작업 영역 → 작업공간 탭(결정 A4) | T-047 | M1 | — |
| WP-05 선언형 패널 v0·부품 | T-048 | M1 | — |
| WP-09 Rhino에 만들기 1차 | T-055 | M3 | — |
| WP-12 보고서 틀 | T-057 | M4 | — |
| WP-38 만들기 최소판 | T-063 | M5 | — |
| M5 수용(SPEC-07.16) | T-064 | M5 | — |
| WP-13 자료 1차·`vide/project-facts` | T-065 | 독립 | — |
| WP-15 공유 스냅샷 결함 S1 | T-066 | 독립 | — |

## 티켓

### T-041 · 겹침 층과 jig 비모달 {#t-041}

- **목적/기준:** jig 결과를 문서 객체 위 겹침 층으로 보인다. 3D를 보거나 판정색을 칠해도 jig 상태를 잃지 않게 한다. M0 진단 표시의 선행이다. FR-24, SPEC-07.10.
- **변경 범위:**
  - `src/ui/viewport.ts`: `overlay(key, items|null)`, `overlayStyle`, `clearTint`, `focus`, 고르기 결과에 `source: document|overlay`
  - `src/ui/jigs.tsx`: `key={++generation}` 재마운트 제거, `show`·`tint`가 jig를 닫던 `hideJigs()` 호출 제거
  - `JigContext`: `overlay`·`clearTint`·`focus` 추가
- **선행:** 없음.
- **검증:**
  - 정상: 겹침 층 추가·제거·투명도, 판정색 끄기, 3D 확인 뒤 jig로 돌아와도 입력·결과 유지, 겹침 항목을 누르면 표의 행으로 이동
  - 실패·회귀: `?panel=rhino`에 변화 없음, 겹침 층은 저장·Sync·후보에 섞이지 않음, `tests/integration/browser-jigs.mjs` 갱신 통과, `browser-host-panel.mjs` 통과
- **완료:** 기존 구조·Sync jig가 비모달로 동작하고, T-044가 겹침 층 API를 쓸 수 있다.

### T-043 · Sync 범위 수·레이어 표·레이어 한정 읽기·import 보강 {#t-043}

- **목적/기준:** 입력 조립(결정 F3)과 M0 진단이 연결 파일의 레이어 목록과 토목 모델 블록을 바르게 읽게 한다. 현행 `displayCoverage`가 꺼진 레이어·블록 정의 내부 객체를 세지 않고 누락 0으로 보고하는 결함도 고친다. 기준은 SPEC-01.2(부분 취득의 누락 유형·건수 표시), SPEC-07.5(jig 입력 읽기), SPEC-07.12의 3(만들기 직전 읽기), ARCH-03 §8, ARCH-01(표시 페이지 취득), AC-41.
- **변경 범위:**
  - `hosts/rhino/worker/DisplayScene.cs`
    - 범위 수: `total`, `displayed`, `omittedHidden`, `omittedBlockInternal`, `hiddenLayers[{path,count}]`
    - 레이어 표: `id, parentId, fullPath, visible, locked, color, order, objectCount`, 빈 레이어 포함
    - 레이어 필터 읽기와 숨긴 객체 포함 인자. 숨긴 객체 포함은 만들기 직전 읽기에만 쓴다
  - `hosts/rhino/worker/WorkerScene.cs`: 블록 정의·변환(`DisplayScene`의 `definitions` 형식), 레이어 표, 누락 수, 레이어 필터
  - `src/server/sdk-execution.ts`: export 인자를 `launchRhinoWorker`로 넘긴다
  - `hosts/rhino/worker/EditorApplication.cs`: `TargetLayer`가 새로 만들 부모 레이어를 재귀로 찾는다. 두 단계 새 레이어가 원본 루트에 생기는 결함을 고친다. 1차 만들기 틀은 한 단계 새 레이어만 쓴다(ARCH-03 §9.5)
  - `src/contracts/native-model.ts`: 범위·레이어 표 타입
  - 화면 범위 배지(예: "꺼진 레이어 1개(96개)·블록 내부 14개는 가져오지 않았습니다"). 표시용 Sync가 무엇을 담는지는 현행 그대로다
- **선행:** 없음. **Rhino 플러그인 재빌드 1회**(이 티켓의 세 C# 파일을 한 번에).
- **검증:**
  - 정상: `.vide/` 합성 3dm(꺼진 레이어·블록 정의 내부 객체 포함)에서 누락 수·레이어 표가 맞음. 지정 레이어만 읽힘. 숨긴 객체 포함 인자로 꺼진 레이어 객체가 읽힘. **회전 블록을 import 경로로 읽어도 −21°가 유지됨**(합성 자료). 두 단계 새 레이어를 원본 반영하면 부모 아래에 생김
  - 실패·회귀: 레이어 한정 읽기가 Live Sync 기준·뷰포트를 바꾸지 않음, ZWCAD 경로 변화 없음, 기존 Sync·Live Sync 브라우저 시험 통과, 플러그인 빌드 경고 0
- **완료:** 개발 빌드와 `.vide/` 합성 문서까지. 설치본 반영은 사용자 요청 시 묶음 릴리스로 한다.

### T-045 · 저장 스키마 v5 {#t-045}

- **목적/기준:** 대화(PLAN-24)·jig(이 계획)·자료 검토(T-065)의 표를 한 번의 개정으로 넣는다. 병행 작업의 마이그레이션 번호 충돌을 막는다. ARCH-03 §10.
- **변경 범위:**
  - `src/core/migrations.ts`의 v5 하나. 표와 열은 ARCH-03 §10.2다
  - `workspace_requests.conversationId`는 `ADD COLUMN`만 한다. 기존 행을 UPDATE하지 않고 색인도 만들지 않는다
  - 배포 안내에 "이 버전 이후에는 이전 설치본으로 되돌릴 수 없음"을 적는다
- **선행:** ARCH-03 review. 다른 작업이 먼저 스키마를 올리면 ARCH-03 §10.1대로 합류 순서에 따라 번호를 다시 매긴다.
- **검증:**
  - 정상: 기존 DB 이관 뒤 요청 행 수·크기 불변, 새 표 쓰기·읽기, 백업 뒤 이관
  - 실패: 이전 버전 코드로 열면 `UNSUPPORTED_SCHEMA`, 이관 중단 시 백업 복구(T-023 경로)
  - 규모: S-06 규모의 DB 사본 또는 같은 크기의 합성 DB(`.vide/` 아래)에서 시작 시간 증가 ≤ 1초
- **완료:** DB 이관 시험 통과와 위 규모 기록.

### T-046 · jig 형식 v3·작업본·실행기·가져오기 {#t-046}

- **목적/기준:** jig 설명서(`jig.json` v3) 한 장으로 입력·설정값·단계·점검·자체 시험을 선언한다. 작업본에서 설정값을 바꾸면 바뀐 단계만 AI 없이 다시 계산하고 되돌릴 수 있다. FR-24, SPEC-07.2~.9·.14·.15·.17, ARCH-03 §2~§8·§11·§12, ADR-020, AC-44.
- **변경 범위:**
  - `src/jigs/runtime/{manifest,params,runner,child-runner,gates,loader,pack}.ts`
    - 설명서 검사(파생값 재계산 포함)
    - 설정값: 단위·범위·근거·`fixedAtPin`, 변경 기록과 되돌리기
    - 단계 실행과 입력 해시 캐시
    - 점검: 시점, 수준(막음·경고·분리)
    - 적재
  - 실행 위치(SPEC-07.9)
    - 공식 jig·라이브러리: 엔진. 수십 ms 이상 걸리는 계산은 작업 스레드
    - 이 PC에서 묶은 jig(`dev-pack`): Node 자식 프로세스. `--permission`, 경로마다 `--allow-fs-read`, `env`는 `PATH`·`SystemRoot`만, 유휴 5분 종료
    - AI가 쓴 코드의 계산 상자: T-063
  - `src/server/jig-routes.ts`(ARCH-03 §7, `server.ts`는 위임 한 줄)
    - 작업본, 설정값 변경·되돌리기, 수정 사항, 구역
    - jig 입력 읽기: `workspace_requests`가 아니라 `jig_reads`와 `<data>/jigs/reads/`에 둔다. ZWCAD는 기존 결과를 서버에서 레이어로 거른다
    - 입력 조립 제안·확인, 실행(`geometry`·`preview`·`confirmed`), 사람 단계 확인
  - 가져오기·고정
    - `POST /api/v1/jigs/import`: 이 PC 설치본 키의 서명 확인, 확인 필요 동작
    - 이 프로젝트의 jig로 고정: 확인 필요 동작
    - 두 경로 모두 원격 세션을 거절한다(원격 차단 정규식에 추가)
  - `npm run jig:pack`·`jig:validate`·`jig:test`: 만들기 대화의 `jig_validate`·`jig_test`와 같은 코드
- **선행:** T-045, T-043(레이어 한정 읽기).
- **검증:**
  - 정상: 합성 jig에서 설정값 변경 시 바뀐 단계만 다시 계산(캐시 적중), 되돌리기, 재시작 뒤 작업본(입력 조립·설정값·수정 사항·결과 기준) 복원, jig 입력 읽기가 Live Sync 기준·뷰포트를 바꾸지 않음, 읽은 문서 판이 바뀌면 `stale-input`
  - 실패: 실행 시간 상한 초과 시 끊고 이유 표시, 순환·빠진 입력은 점검 실패, `fixedAtPin` 값 변경은 `PARAM_FIXED`, 서명 없는·다른 PC의 `.vjig` 거절, 같은 id·버전을 다른 내용으로 가져오면 거절, 금지 파일(`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/`, `.codex/`, `.mcp.json`) 거절, 원격 세션의 가져오기·고정 403
  - 기동 시험: 자식 프로세스에서 허용 밖 경로는 `ERR_ACCESS_DENIED`, `process.env`에 키 없음
  - 시험 파일: `tests/core/jig-runner.test.mjs`
- **완료:** 합성 jig 하나가 작업본에서 계산·재계산·되돌리기·복원되고 위 실패 시험이 모두 통과한다.

### T-047 · 작업공간 탭 1차 — 탭 줄·모델·JIG·jig 문맥 탭 {#t-047}

- **목적/기준:** 결정 A4 (c). 고정 배치 작업공간 탭과 jig를 열면 생기는 문맥 탭을 만든다. 탭을 바꿔도 오른쪽 대화·작성 중 초안·선택과 jig 작업본이 그대로다. 자유 도킹·재귀 분할·노드 배선 편집기는 만들지 않는다. SPEC-05.8, SPEC-07.4, Design 작업공간 탭·SCR-13·SCR-18.
- **변경 범위:**
  - 새 `src/ui/workspaces.ts`
    - `setWorkspace(id, {instanceId?})`와 탭 줄(가운데 열 위)
    - 마지막 탭과 열린 문맥 탭은 보는 사람의 화면 편의로만 기억한다. 저장소는 `localStorage`, 읽기·쓰기를 try/catch로 감싼다
  - 모델 탭(현행)
  - JIG 탭: JIG 목록 모달을 탭으로 옮긴다. 출처 필터와 jig 카드
  - jig 문맥 탭: 여러 개가 함께 있을 수 있고 `×`로 닫는다
    - 왼쪽: 단계 레일·입력 조립·설정값
    - 가운데: 3D·평면·보고서 전환, KPI 띠, 슬라이더 판
    - 아래: 결과 서랍
  - `src/ui/jigs.tsx`: 분기를 등록부 조회로 바꾼다
  - `JigContext` → `JigHost`(`params.get/set`, `run`, `state`, `ask`, `bake`, `export`, `facts.lookup`)
  - `src/ui/app.ts`: 초기화 몇 줄
  - 만들기·보고서·자료 탭은 T-063·T-057·T-065에서 연다
- **선행:** T-041, T-046.
- **검증:**
  - 정상: 구조·Sync jig가 문맥 탭에서 열리고 3D를 보면서 상태 유지, 문맥 탭을 닫아도 작업본은 남고 JIG 탭·대화 칩에서 다시 열림, 문맥 탭 두 개 전환
  - 실패·회귀: 패널 모드에서 탭 줄을 그리지 않음, 900 px 미만에서는 탭 줄이 선택 메뉴로 줄어듦, 저장소 접근이 막혀도 기본 탭으로 뜸, `browser-jigs.mjs`·`browser-host-panel.mjs` 통과
- **완료:** 문맥 탭에서 기존 jig 두 개와 T-048의 선언형 패널이 동작한다.

### T-048 · 선언형 패널 v0와 부품 1차 {#t-048}

- **목적/기준:** jig 화면을 코드가 아니라 `panel.json`(데이터)과 공식 부품으로 만든다. AI가 만드는 화면의 기본이다. SPEC-07.10, ARCH-03 §5.1, Design 부품 목록.
- **변경 범위:**
  - 새 `src/ui/jig-panel/`: 렌더러
  - `src/ui/kit/*`: Design 부품 목록의 1차분
    - 단계 레일, 설정값 묶음·슬라이더·선택 칩, 입력 역할 카드
    - KPI 띠, 판정 범례(`colorBands`를 읽음)
    - 3D 겹침·평면 지도
    - 문제 표·데이터 표·일람표, 결과 서랍
    - 질문 카드·확인 카드·변경 알림, Rhino에 만들기 카드, 근거 칩
    - 원장·보고서 부품
  - **새 토큰 이름만 추가한다.** 기존 값과 `prefers-color-scheme`은 바꾸지 않는다
- **선행:** T-046.
- **검증:**
  - 정상: `panel.json` → 화면, 표 ↔ 3D 왕복, 슬라이더를 끄는 중과 손을 뗀 때 구분, 슬라이더 → 겹침 갱신, 320 px 폭 렌더
  - 실패: 목록 밖 부품·속성·토큰과 16진 색 거절, 화면에 확인 등급·개발 용어 없음
  - 회귀: `browser-host-panel.mjs` 통과
- **완료:** 합성 jig 하나가 코드 없는 패널로 그려지고, S-06 jig(T-051)가 쓸 부품이 갖춰진다.

### T-055 · Rhino에 만들기 1차 — 고정 틀 + 데이터 블록 {#t-055}

- **목적/기준:** jig 결과를 AI 없이 매번 같은 방법으로 Rhino에 만든다. 고정 틀은 VIDE가 소유하고 값은 데이터 블록 하나로만 넘긴다(결정 A7). 교체 대상은 태그가 아니라 만들기 기록의 객체 ID와 만들기 직전 읽기의 지문으로 정한다. 사람이 고친 객체를 지우지 않는다. SPEC-07.12·.13·.17, SPEC-02.3, ARCH-03 §9, ADR-020, AC-43.
- **변경 범위:**
  - `src/jigs/bake/bake.ts`, `src/jigs/bake/templates/{curves,sweep-h,extrude-column,textdot}.cs`
    - 치환 자리는 `{{DATA_BASE64}}` 하나, 데이터 블록 `vide.bake.data/1`
    - 치환 뒤 본문이 틀 해시 + 데이터 블록과 같은지 확인
    - 키·부호 문자 점검 `bake-args-safe`
  - `SdkExecution.runFixed`와 `Execution.run`의 `jig-bake` 분기. 공급자를 부르지 않는다. 흐름은 작업 사본 → 영수증 → 후보 → 사람이 원본 반영(T2)이다
  - 만들기 직전 강제 읽기: T-046 jig 입력 읽기, 출력 레이어와 기록된 객체, 숨긴 객체 포함
    - 교체·사람이 고침·사람이 지움·복사본·태그 없음으로 분류한다
    - 문서 판이 일치하는지 확인한다
    - 지울 대상이 꺼짐·잠김 레이어에 있으면 `hidden-target`으로 막고 안내한다
  - 사람이 고친 부재는 `resolve`(유지·덮기·수정 사항으로 받기)로 처리한다(ARCH-03 §9.4)
  - 원본 반영 직후 표시 경로 읽기로 기준 지문을 만들기 기록에 저장한다. 이 읽기가 실패하면 읽기만 다시 시도하고, 그 사이 기록의 객체는 사람이 고친 것처럼 보존한다
  - Rhino에 만들기 카드(T-048 부품)와 작업 보기를 연결한다
  - 같은 문서의 동시 쓰기: PLAN-24 T-060 전에는 현행 접수 규칙(겹치면 기다렸다 다시 누름), 뒤에는 문서별 대기열
- **선행:** T-046, T-043(레이어 표·숨긴 객체 포함 읽기·`TargetLayer`), ADR-020·ADR-014 개정.
- **검증:**
  - 정상: `.vide/` 합성 3dm에 곡선·부재 만들기 → 후보 → 반영 → 다시 만들기 시 기록된 ID만 교체(다른 객체 지문 불변)
  - 사람 수정:
    - 만든 부재를 고친 직후 다시 만들기 → 보존
    - 복사한 객체 보존
    - 꺼진 레이어로 옮긴 객체 보존
    - 사람이 지운 객체는 다시 만들지 않음
    - 유지·덮기·받기 선택이 각각 기록대로 동작
  - 실패:
    - 지울 대상의 레이어가 꺼짐·잠김이면 막음
    - 키에 `"`·줄바꿈을 넣은 합성 입력도 코드가 되지 않음
    - 작업 사본 이후 원본이 바뀌면 반영 막음
    - 반영 직후 읽기 실패를 모의하면 다음 만들기에서 교체하지 않음
    - `CodePolicy` 통과. 로컬 함수 허용 여부를 확인하고, 안 되면 인라인으로 푼다
  - SPIKE: 곡선 레일 위 웨브 연직 스윕, 묶음 크기(본문 65,536자 한도) → `docs/tdd/SPIKE-YYYY-MM-DD-jig-bake.md`
- **완료:** 합성 문서에서 두 번 만들기가 중복 없이 끝나고 위 보호 시험이 모두 통과한다. 플러그인 재빌드는 없다.

### T-057 · 보고서 틀 v0와 보고서 탭 {#t-057}

- **목적/기준:** jig 결과를 외부 요청 없이 열리는 자체 포함 HTML 보고서와 CSV로 낸다. 보고서의 주장은 현재 결과에서 참일 때만 나온다. SPEC-07.11, SPEC-03, Design SCR-17.
- **변경 범위:**
  - `src/server/report.ts` 확장: 스크립트 없는 CSP 유지, 인쇄용 `@page` CSS
  - 보고서 틀 형식(`reports/*.json`, 주장마다 닫힌 조건)과 AI 다듬기 1회 선택
  - 부품 `ReportPage`·`CompareBars`·`LedgerPage`
  - 점검 `claim-consistent`·`numbers-in-source`·`unchecked-listed`
  - 버튼과 표기: 앱 안 보고서에는 작업본 설정값으로 돌아가는 버튼, 내보낸 파일에는 "VIDE에서 열기" 한 줄
  - 보고서 탭: 보고서 목록·인쇄 판형 미리보기
  - 표현은 Design 현행 기준이다(결정 B15 보류)
- **선행:** T-048, T-047.
- **검증:**
  - 정상: 합성 jig 보고서가 외부 요청 없이 열림, A3·A4 인쇄 미리보기, 첫 쪽의 가정·미검토 항목, 설정값 원장 절
  - 실패: 결과와 어긋난 주장은 점검 실패, 다듬은 문장에 결과에 없는 숫자가 있으면 틀 문장으로 되돌리고 '확인 필요', 내보낸 HTML에 스크립트·설정값 조작 없음, 미확정 미리보기 결과를 확정으로 쓰지 않음, CSV 수식 주입 방지
- **완료:** 합성 jig 보고서와 PLAN-23 T-058의 S-06 보고서가 이 틀로 나온다.

### T-063 · 만들기 최소판 — 대화로 jig 만들기 {#t-063}

- **목적/기준:** FR-24의 만들기 대화. 계획 → 질문 → 만들기 시작 → 작성 → 점검·시험 → 미리보기 → 고정 또는 버리기 순서로 VIDE 안에서 jig를 만든다. AI가 쓴 코드는 입출력이 없는 계산 상자에서만 돈다. SPEC-07.9·.16, ARCH-03 §6.5·§7, ADR-020, ADR-021, Design SCR-16.
- **변경 범위:**
  - 초안 폴더 `<data>/jigs/drafts/<draftId>/`. 개발 모드의 위치는 PLAN-24 T-059의 SPIKE ⑧ 결과를 따르며, 상위에 저장소가 있으면 저장소 밖에 둔다
  - 계산 상자: 엔진 안 wasm JS 실행기(QuickJS 계열, 라이선스 확인), `src/jigs/runtime/compute-box.ts`, 메모리·시간 상한
  - 초안 경로(ARCH-03 §7 `jig-drafts`)와 도구 `jig_validate`·`jig_test`·`jig_preview`·`jig_ask_user`. 도구는 PLAN-24 T-062의 등록부에 넣는다
  - 만들기 대화: 대화 세션 + 초안 폴더만 붙인 파일 도구, 셸 없음
    - 한 턴 600초·도구 100회
    - 20턴을 넘으면 저장·새로 시작을 묻는다
    - 같은 시험이 같은 이유로 3회 실패하면 멈추고 묻는다
    - 권한 밖 도구를 요청하면 바로 멈춘다
  - 만들기 탭(Design SCR-16 최소판): 개요, 가운데 미리보기, 아래 점검·시험 결과, 오른쪽 만들기 대화. [이 프로젝트의 jig로 고정] 버튼(T2)과 [버리기]
  - 시작 본: 공식 일반 예제 두 개(구조 해석 라이브러리 사용 예, 합성 격자 골조 배치 예). S-06 jig는 시작 본으로 싣지 않는다(결정 A12)
- **선행:** T-046~T-048, PLAN-24 T-061(대화 세션)·T-062(도구 등록부).
- **검증:**
  - 정상: 합성 요구로 초안 → 점검·시험 통과 → 미리보기 → 고정 뒤 실행 화면에서 열림, 세션을 잃어도 초안 파일·원장으로 이어 감
  - 실패: 계산 상자에서 `fetch`·`require`·`process` 없음, 1천 요소 조합 단계 ≤ 200 ms(SPIKE), 초안 폴더에 금지 파일이 생기면 점검 실패, 초안 밖 파일 쓰기 거부, 고정 때 점검을 다시 확인, 버리기 시 초안 폴더와 공급자 기록 삭제, 원격 세션의 고정 403
- **완료:** 위 시험 통과. 실물 수용은 T-064다.

### T-064 · M5 수용 — S-06 보조 jig를 만들기 대화로 만들기 {#t-064}

- **목적/기준:** 결정 A11. SPEC-07.16의 수용 시험이다. VIDE 안 만들기 대화로 "신설 E.J. 선마다 양쪽 기둥과 공통 파일캡이 있는지, 쌍기둥 간격은 얼마인지 보는 도구"를 만들어 이 프로젝트의 jig로 고정한다. 그리고 S-06 작업본의 기둥·신설 E.J. 입력으로 돌린다. FR-24, AC-45.
- **변경 범위:** 제품 코드 변경은 없다. 만든 jig는 사용자 데이터(개발 검수는 `.vide/` 데이터)의 초안·프로젝트 jig로만 남고 저장소에 넣지 않는다.
- **선행:** T-063, PLAN-23 T-051(③ 쌍기둥 결과).
- **검증:**
  - 합격: 대화 10턴 안에 점검·시험 통과, 쌍기둥 판정이 S-06 골조 jig ③의 결과와 같음, 사람이 코드를 고치지 않음
  - 실패 기록: 반복 실패·턴 초과에서 멈춤 조건이 동작하는지 적는다
- **완료:** `docs/tdd/VERIFY-YYYY-MM-DD-jig-make.md`에 턴 수·시험 결과·S-06 결과와의 차이를 기록한다.

### T-065 · 자료 1차·자료 탭·`vide/project-facts` {#t-065}

- **목적/기준:** 채택된 C-02(결정 A9)의 첫 제품 작업이다. 프로젝트 자료를 검색·확정·오염 표시하고, jig 설정값의 근거로 읽게 한다. 크롤러 DB는 읽기 전용으로 두고 확정 기록은 VIDE 쪽에 둔다. [PLAN-08](PLAN-08-project-knowledge.md) K0-T3의 검색 재료는 이 티켓이, AI 자료 도구는 PLAN-24 T-062가 맡는다. 기준: PRD C-02, ADR-018, SPEC-07.6(근거)·.14(`fact-valid`), Design SCR-19.
- **변경 범위:**
  - `src/jigs/knowledge.ts` FTS 검색
    - 3글자 이상 낱말은 `excerpt_fts`와 순위·최신·검증 가중
    - 2글자 낱말은 LIKE로 보충
    - 도면 문자는 레이어·좌표 조건으로 찾는다
  - 검토 기록: 확정·기각·오염·대체·작성 주체 고침. 확정은 사람만 한다. 제외 규칙·프로젝트 루트 표를 쓴다(T-045)
  - 오염 의심 묶음 카드: 사용자가 확인할 때만 기록한다
  - 근거 칩의 진술 창
  - 공식 라이브러리 `vide/project-facts`: `facts.read`, `fact-badge`, `ledger`
  - 분야 목록은 자료 DB 값을 그대로 쓴다(별도 계약 파일은 만들지 않음)
  - 자료 탭: 기존 자료 jig를 SCR-19 배치로 옮긴다
- **선행:** 프로젝트 지식 SPEC 초안 review(PLAN-08 착수 조건, 번호는 작성 시 다음 빈 번호), T-045, T-046, T-047.
- **검증:**
  - 정상: 합성 DB에서 한국어 2글자·3글자 검색, 확정 기록이 크롤러 재실행 뒤에도 유지, 근거 칩 → 진술 창
  - 실패: 오염·기각 진술은 검색 기본값·도구·근거 찾기에서 빠지고 '제외된 n건 보기'로만 보임, 오염 근거를 쓴 설정값은 `fact-valid`로 막음, 원본 열기는 사람만 하고 AI 도구로 내놓지 않음, 다른 프로젝트 DB 접근 불가
  - 실제 자료 대조는 `.vide/` 사본의 VERIFY로만 한다
- **완료:** 합성 DB 시험 통과와 S-06 자료 사본의 검색·확정 검수 기록.

### T-066 · 공유 스냅샷 쓰기가 업로드 차단을 우회하는 결함(S1) {#t-066}

- **목적/기준:** 조사 중 발견한 기존 결함이다. PC 장치 경로의 스냅샷 쓰기가 업로드 차단 검사를 거치지 않고, staging에서 스냅샷이 기본으로 켜져 있다. 무료 한정 방침과 ADR-015를 지킨다. PLAN-20 영역의 결함이며, PLAN-20 본문의 정정은 그 계획의 소유자가 한다. 근거는 RESEARCH-10 §13.6.
- **변경 범위:**
  - `src/sharing/worker.ts`: 스냅샷 쓰기에도 같은 차단 검사를 건다
  - staging·운영 설정: `SNAPSHOTS_ENABLED=false`, `SNAPSHOT_TOTAL_MB` 명시(기본 0)
  - `src/sharing/offline.ts`: 기본값 0
  - `tools/checks/deployment.mjs`: 켜짐인데 과금 수용 결정 기록이 없으면 실패
- **선행:** 없음.
- **검증:** 정상 — 차단 해제 상태의 스냅샷 쓰기 성공(로컬). 실패 — 차단 중 스냅샷 쓰기 거절, 설정 누락·켜짐 상태를 배포 점검이 잡음, 기본 용량 0.
- **완료:** 로컬 시험 통과. staging 배포는 사용자가 요청할 때만 한다.

## 순서와 의존

- M0: T-041·T-043은 바로 시작할 수 있다. PLAN-23 T-044(진단)가 둘을 쓴다.
- M1: T-045 → T-046 → T-047·T-048. S-06 jig 0.1(PLAN-23 T-051)이 이 넷을 쓴다.
- M3: T-055는 T-046·T-043 뒤다.
- M4: T-057은 T-047·T-048 뒤다.
- M5: T-063은 PLAN-24 T-061·T-062 뒤, T-064는 T-063 뒤다.
- T-065는 프로젝트 지식 SPEC 초안이 준비되면, T-066은 언제든 한다.

## 검증 원칙

- 저장소 시험은 합성 자료만 쓴다. 실제 프로젝트 확인은 `.vide/` 사본으로 하고, VERIFY에는 수치와 가정만 적는다.
- 점검과 판정을 구분해 시험한다(SPEC-07.14). 판정은 흐름을 막지 않는다.
- 권한은 서버 명령 경계에서 검사하는지 시험한다. 화면에서 숨긴 것만으로 통과 처리하지 않는다.

## 현황(2026-10-01)

티켓마다 현재 상태·증거·남은 일만 둔다. 물결별 경과는 Git 이력(커밋 f8b32f6 → 4f5f43a 1차 → c67bf57 2차 → 6b70f34 3차 → c972e23 4차 → 32bf8be 5차 → c8443db 6차 → d8fb2ba 실호스트 검증)에 있다. 아래 구현은 모두 설치본 v0.2.11(d8fb2ba)부터 들어 있다.

| 티켓 | 상태 | 증거 | 남은 일 |
|---|---|---|---|
| T-041 겹침 층·비모달 | 완료(f8b32f6) | `browser-jig-overlay.mjs`, `browser-jigs.mjs`, `browser-structure-jig.mjs`, `browser-host-panel.mjs`·`browser-rhino-panel.mjs`(`?panel=rhino` 불변) | 겹침은 깊이 검사 없이 항상 모델 위. 수천 개 겹침의 성능 미측정. 850 px 이하 아래 판은 브라우저 시험 없음 |
| T-043 Sync 범위·레이어 표·레이어 한정 읽기 | 완료(4f5f43a, 플러그인 재빌드 포함) | `tests/integration/rhino-layer-reads.mjs`, `tests/server/scene-pages-survey.test.mjs`, `tests/core/native-model-limits.test.mjs`·`s06-sync-input.test.mjs`, [VERIFY-2026-09-29-s06-frame](../tdd/VERIFY-2026-09-29-s06-frame.md) v0.2 | 화면 범위 배지(`#sync-coverage`)의 브라우저 시험 없음. Live Sync 변경 페이지마다 문서 전체를 다시 세므로(`ReadSurvey.Of`) 20만 객체 문서의 비용 미측정. 파일 링크의 jig 입력 읽기는 읽기마다 Rhino 작업자를 띄움 |
| T-045 스키마 v5 | 완료(4f5f43a) | `tests/core/migrations.test.mjs`(v4 → 백업 → v5, 행 불변, 중단 복구, `UNSUPPORTED_SCHEMA`), `tests/core/store.test.mjs` | 규모 기록(S-06 규모 DB 시작 시간 증가 ≤ 1초) 미측정. "이전 설치본으로 되돌릴 수 없음" 안내는 ARCH-03 §10.1에만 있음 |
| T-046 형식 v3·작업본·실행기·가져오기 | 완료(4f5f43a) | `tests/core/jig-manifest.test.mjs`, `tests/core/jig-runner.test.mjs`(캐시·되돌리기·복원·자식 프로세스 거절·서명 가져오기), `npm run jig:validate`·`jig:test`·`jig:pack` | `stale-input`의 현재 판(`currentRevisions`)을 경로가 채우지 않음. 구현되지 않은 점검(`no-overlap`·`schedule-complete` 등)은 선언하면 막음으로 실패. 공식 jig의 엔진 실행 예산은 사후 측정만 |
| T-047 작업공간 탭 1차 | 완료(c67bf57). 이후 레일·위쪽 줄 역할 나눔과 산출물 탭으로 바뀜([PLAN-26](PLAN-26-chat-stage.md) T-079·T-081) | `browser-workspace-tabs.mjs`, `browser-jigs.mjs`, `browser-workspace-controls.mjs`, `browser-host-panel.mjs` | `JigHost`에는 본문의 `ask`·`bake`·`export`·`facts.lookup`을 두지 않았다(질문·만들기·근거는 패널 부품과 대화 도구가 맡음). jig 결과 내보내기는 미구현. 기존 두 jig는 `legacy:` 탭으로 감싼 수준 |
| T-048 선언형 패널 v0·부품 | 완료(c67bf57, 보완 c972e23·32bf8be) | `tests/core/jig-panel.test.mjs`, `browser-jig-panel.mjs` | 역할 카드의 후보 찾기는 레이어 이름 힌트와 규칙 제안만(단발 AI 제안은 [PLAN-23](PLAN-23-s06-frame-jig.md) T-051). `browser-jig-panel.mjs`의 설정값 갱신·만들기 시험은 고친 뒤 돌리지 않음 |
| T-055 Rhino에 만들기 | 완료. 지금 주 경로는 연결 Rhino에 바로 만들고 Rhino 되돌리기로 무르는 `runDirectBake`·`undoBake`(`src/jigs/bake/bake.ts`, ADR-022, [PLAN-24](PLAN-24-ai-conversations.md#t-074) T-074, c8443db). 위 본문의 작업 사본 → 후보 → 반영 흐름은 연결 Rhino가 없을 때의 대체 경로로만 남음 | `tests/core/bake.test.mjs`, `tests/server/bake-route.test.mjs`, 실제 Rhino `tests/integration/rhino-bake.mjs`(틀 4개 객체 27, 재만들기 교체 24·보존 2·복사본 1), [SPIKE-2026-09-30-jig-bake](../tdd/SPIKE-2026-09-30-jig-bake.md), [VERIFY-2026-09-30-s06-frame-m3](../tdd/VERIFY-2026-09-30-s06-frame-m3.md)(S-06 사본 상단선 161개) | 실데이터 `members`·`member-columns` 만들기(엔진에서 S-06 해석이 권한 제한 자식 프로세스 때문에 돌지 않음, PLAN-24 T-074). 재시작 뒤 남은 만들기 요청은 `BAKE_JOB_MISSING` |
| T-057 보고서 틀·보고서 탭 | 완료(6b70f34, 패널 연결 c972e23). 보고서 탭은 산출물 탭 안으로 옮김(PLAN-26 T-081) | `tests/core/report.test.mjs`, `browser-report.mjs` | 보고서 행동을 선언한 `panel.json`은 example-grid 하나 |
| T-063 만들기 최소판 | 구현·단위 검증 완료(c972e23, 잔여 32bf8be·c8443db) | `tests/core/{compute-box,drafts}.test.mjs`, `tests/server/make-routes.test.mjs`, `conversations.test.mjs` | `browser-make.mjs` 미실행, 만들기 탭 화면을 실제 서버와 연결해 보지 않음. 실제 Codex 만들기 턴 미확인 |
| T-064 M5 수용 | 서버 경로로 합격(c972e23) | [VERIFY-2026-09-30-jig-authoring-m5](../tdd/VERIFY-2026-09-30-jig-authoring-m5.md), `tests/server/make-acceptance.test.mjs` | 만들기 탭 화면으로 같은 흐름 확인, 반복 실패·턴 초과 멈춤 조건의 실사용 확인, 답변 턴 시간 한도 |
| T-065 자료 1차·자료 탭 | 구현·단위 검증 완료(c972e23). 동작 정본 [SPEC-08](../specs/SPEC-08-project-facts.md)(draft) | `tests/core/knowledge-facts.test.mjs`, `tests/server/{facts-routes,fact-citations}.test.mjs` | `browser-facts.mjs` 미실행, 실제 자료 DB 사본으로 화면 확인 안 함. 분야 목록은 자료 DB 값을 그대로 쓰며 별도 계약 파일(`src/contracts/knowledge.ts`)은 만들지 않음 |
| T-066 공유 스냅샷 결함 S1 | 완료(4f5f43a) | `tests/sharing/offline.mjs`, `tests/server/deployment.test.mjs`, `npm run deployment:check` | 운영 설정 파일이 없어 staging만 점검. ARCH-01 계정 웹사이트 절의 스냅샷 한도 문장(사이트 기본 8,000 MB)은 그 문서에서 맞춘다. PLAN-20 정정 첨삭은 사용자 해소 대기. staging 배포·원격 D1 `0007` 적용은 사용자 요청 때만 |