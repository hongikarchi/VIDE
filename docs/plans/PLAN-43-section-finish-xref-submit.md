---
id: PLAN-43
title: 단면 보기·마감 일람표 jig·도면 내보내기 실험·xref 관계·jig 관리자 제출·외부 서비스 연동 계약 (T-197~T-202)
status: review
version: 0.5
updated: 2026-10-07
owner: agent:claude
related: [SPEC-01, SPEC-07, SPEC-08, SPEC-11, ARCH-01, DESIGN, ADR-037, ADR-040, ADR-041, RESEARCH-16, FR-01, FR-03, FR-04, FR-09, FR-14, FR-21, FR-24, C-04, C-05, C-06, C-07, C-08]
---

# 단면·마감 일람표·도면 내보내기 실험·xref·jig 제출

2026-10-07 사용자 메모와 선택이다. 메모 원문은 [RESEARCH-16](../research/RESEARCH-16-domain-services-roadmap.md) §1에 정리했다. 사용자는 이번에 다섯 가지를 구현하기로 골랐다.

- **단면:** "clipping plane 기능 추가되면 좋을 듯"
- **마감:** "마감 일람표 / 내부 실 마감표 같은 기능 있으면 좋겠음". 사용자가 대략 만들어 둔 HTML 앱(`마감코드 체계.zip`)을 바탕으로 한다.
- **도면 생성기:** "export to cad. sheet. annotation. dimension. xref 등의 설정이 그대로 잘 넘어가는지". 먼저 실험으로 확인한다.
- **xref:** "각 cad 파일의 xref 관계를 알아서 파악해서 모델링으로 반영"
- **jig 제출:** "관리자한테 내가 이런거 만들었는데 전체 내용으로 업데이트해줄래? 하고 보내주면 적용해서 업데이트 사항으로 공식 배포". 선택지에서 '제출 기능까지 구현'을 골랐다.

외부 서비스 구조(cLAWde, ArchiDB, Site Modeling, Structure Analysis)는 'ADR과 연동 계약만'으로 정했다. 규모검토, 법규검토, 패널링, 모델→CAD 역반영은 PRD 후보(C-04~C-08)와 RESEARCH-16에만 기록한다.

## 같은 날 정한 기본값

1. **단면은 보기 전용이다.** VIDE 뷰포트의 표시만 자른다. 호스트 문서, Rhino 클리핑 평면 객체, 캡처 원본 데이터는 바꾸지 않는다. 단면 채움(cap)과 3D 기즈모는 넣지 않는다. 실제로 필요해지면 추가한다.
2. **마감 jig는 내장 코드 jig다.** 화면 탭 4개가 공식 부품으로 표현되지 않는다. 그래서 지식 jig·구조 jig와 같은 방식(SPEC-07 §9의 예외인 내장 jig)으로 만든다.
   - 코드 체계 라이브러리(코드 477개, 재료 145종, 기준표 8개)는 공식 라이브러리 `vide/finish-codes`로 VIDE에 넣는다.
   - zip의 `projects`(실제 프로젝트의 실 목록과 작성자 이름)와 `notes.project`는 저장소에 넣지 않는다(AI.md §8).
3. **도면 내보내기는 실험만 한다.** VIDE가 띄운 숨은 Rhino 8과 ZWCAD를 쓰고, `.vide/` 아래의 합성 모델로만 시험한다. 결과는 SPIKE 기록으로 남기고, 제품 기능은 다음 PLAN에서 정한다.
4. **xref는 읽기 전용이다.** 프로젝트 폴더의 DWG 사본을 숨은 ZWCAD가 읽어 관계 그래프를 만든다. [모델에 반영]은 루트 도면과 그 xref들을 삽입 변환대로 VIDE 뷰포트에 함께 표시한다.
   - Rhino 문서에 넣기와 CAD로 역반영하기는 C-08이다.
   - 자동 갱신은 없다. [다시 읽기]를 누를 때만 갱신한다(PLAN-42 기본값 5와 같음).
5. **jig 제출은 관리자 제출함까지다**([ADR-041](../decisions/ADR-041-jig-submission.md)).
   - 흐름: 사용자 PC → 계정 사이트 제출함 → 관리자가 저장소로 풀어 검토 → 다음 공식 배포에 포함.
   - 다른 사용자 PC에 직접 설치하는 경로는 없다. 그래서 PC 서명 규칙(SPEC-07.15)은 그대로다.

## T-197 단면 평면·단면 상자

- **기준:**
  - [SPEC-01.15](../specs/SPEC-01-project-input-sync.md) 단면 보기
  - Design의 뷰포트 도구
- **변경:**
  - `src/ui/viewport.ts`
    - `renderer.localClippingEnabled`를 켠다.
    - 공용 `clipPlanes` 하나를 모든 재질에 연결한다. 대상은 `surfaceMaterial()`, `plotMaterials`·`lineMaterials`, batch 재질, Points·LineBasic 재질이다.
    - api `setSection`을 추가한다.
  - 상태는 `src/ui/store/viewer.ts`에 둔다.
  - 도구는 `src/ui/shell/viewport-actions.ts`와 `viewport-area.tsx`에 둔다.
  - 연결은 `src/ui/app/viewport.ts`에서 한다.
- **동작:**
  - 평면(X·Y·Z, 위치, 뒤집기)과 상자(모델 경계에서 시작, 6면 조절) 두 모드가 있다.
  - 걷기 모드와 화면 캡처에도 같은 단면이 적용된다.
  - 끄면 원래대로 돌아간다.
- **검증:** `tests/integration/browser-section.mjs`
  - 합성 장면에서 자른 쪽 픽셀이 비는지, 끄면 원래대로 돌아오는지, 상자 슬라이더가 동작하는지 본다.
- **완료:** 시험과 `npm run verify`가 통과한다.

## T-198 마감 일람표 jig

- **기준:**
  - [SPEC-11](../specs/SPEC-11-finish-schedule.md). 이 작업에서 새로 썼다.
  - SPEC-07 §9의 내장 jig
  - Design SCR-28
- **변경:**
  - 데이터: `src/jigs/official/finish-codes/`(`library.json`과 `index.ts`)
  - 엔진: `src/jigs/finish.ts`
    - 코드 검색·필터를 한다.
    - 실 배정을 검증한다. 코드가 있는지, 요소 종류가 맞는지(바닥 칸에 바닥 코드) 본다.
    - 실 마감표와 마감 일람표 행을 만든다.
  - 프로젝트 DB 표 `finish_rooms`, 경로 `/api/v1/projects/:id/finish/*`
  - 화면: `src/ui/finish-jig.tsx`와 `.css`. 탭 4개를 둔다.
    1. 라이브러리·마감 선정: 층 구성과 단면 SVG를 보여 준다. `section.js`를 TS로 옮긴다.
    2. 실별 배정: 표 편집과 붙여넣기 가져오기
    3. 납품 출력: 실 마감표와 마감 일람표. 인쇄용 화면과 CSV/XLSX로 내보낸다. 표제 정보는 사용자가 입력한다.
    4. 체계·기준
  - 등록은 `src/jigs/catalog.ts`와 `src/ui/jigs.tsx`에서 한다.
- **검증:**
  - `tests/core/finish.test.mjs`
  - `tests/integration/browser-finish.mjs`
  - 합성 실 목록을 쓴다.
- **완료:** 탭 4개의 흐름이 동작하고 시험이 통과한다.

## T-199 도면 내보내기 실험

- **기준:** C-08, H-RHINO와 H-ZWCAD 지원표(내보내기 행 없음)
- **위치:**
  - 코드: `tools/spikes/2026-10-07-drawing-export/`
  - 기록: [SPIKE-2026-10-07-drawing-export](../tdd/SPIKE-2026-10-07-drawing-export.md)
- **질문:** Rhino 8의 다음 요소가 DWG로 내보낸 뒤 그대로 남는가?
  - 레이아웃과 디테일
  - 치수와 치수 스타일
  - 문자 스타일
  - 블록과 링크 블록
  - 레이어와 선가중치
- **방법:**
  1. 숨은 Rhino 8로 합성 3dm을 만든다.
  2. `_-Export`로 DWG를 만든다. 내보내기 체계 2~3종을 시험한다.
  3. 숨은 ZWCAD 사이드 DB로 다시 읽는다.
  4. 항목별 보존 여부를 표로 남긴다.
- **완료:**
  - 비교표와 다음 PLAN의 후보 방식을 기록한다.
  - 띄운 호스트를 종료했는지 확인한다.

## T-200 xref 관계 파악과 모델 표시

- **기준:** [SPEC-01.11](../specs/SPEC-01-project-input-sync.md)(연결 파일), SPEC-08.9(프로젝트 폴더 수집)
- **변경:**
  - ZWCAD worker 명령 `VIDEXREFGRAPH`(`hosts/zwcad/worker/`)
    - 각 DWG 사본에서 xref 블록(이름, 경로, attach/overlay, 해석 상태)을 읽는다.
    - 각 INSERT의 위치·회전·축척과 공간(모델·종이)을 읽는다.
    - 사본은 `src/knowledge/collect/dwg.ts`의 방식으로 만든다.
  - 그래프: `src/core/xref-graph.ts`
    - 경로는 절대 경로, 상대 경로, 같은 폴더 순으로 해석한다.
    - 누락, 고리, 같은 파일의 중복 참조도 표시한다.
    - 프로젝트 DB에 저장한다.
  - 경로 기반 파일 링크: `src/server/import-model.ts`
  - 화면: 프로젝트 폴더 섹션의 '도면 관계' 트리, [다시 읽기], [모델에 반영]
- **검증:**
  - 합성 DWG로 그래프 단위 시험을 한다. ZWCAD가 없으면 건너뛰었다고 표시한다.
  - 브라우저 시험은 트리와 반영 후 링크 수를 본다.
- **완료:** 합성 폴더에서 트리와 함께 표시가 동작한다.
- **후속: 숨은 ZWCAD 충돌 안내(2026-10-07):** ZWCAD가 비정상 종료한 뒤에는 다음 시작이 "진단 정보를 전송하시겠습니까?" 창에서 멈춘다([SPIKE-2026-10-07-drawing-export](../tdd/SPIKE-2026-10-07-drawing-export.md)). 엔진이 띄운 숨은 ZWCAD(자료 정리 DWG 문자, xref 읽기·반영, 검사기, worker 세션)는 `hosts/zwcad/crash-prompt.ts`의 `launchHiddenZwcad`로 띄운다. 그 PID의 대화상자에서만 [아니오]를 누르고(H-ZWCAD-13), 진단 로그에 한 번 남긴다. 검사기·편집 worker의 실행 폴더 이름도 xref처럼 짧게 했다(`/b` 스크립트 경로 약 250자 제한). 증거: `tests/core/zwcad-crash-prompt.test.mjs`(PID 거름·[아니오]·기한·정지, Windows에서 실제 예/아니요 메시지 상자 응답). 실제 ZWCAD 안내 창의 응답은 SPIKE에서 확인했다. 지금 대기 중인 덤프가 없어 제품 경로로는 다시 재현하지 않았다.

## T-201 jig 관리자 제출

- **기준:**
  - [ADR-041](../decisions/ADR-041-jig-submission.md)
  - SPEC-07.3 개정('관리자 제출' 단계)
  - SPEC-04 사이트 장치 API
- **변경:**
  - VIDE 엔진과 화면
    - `src/server/jig-submit.ts`
      - 기존 `pack.ts`로 pack을 만들고 host key로 업로드한다.
      - T2 확인을 받는다. 원격 터널에서는 거절한다.
    - 만들기 탭과 설치 jig 행에 [관리자에게 제출]을 둔다. 메모 입력도 함께 받는다.
    - 내 제출 목록과 상태를 보여 준다. 상태는 받음, 검토 중, 반영됨, 반려(사유)다.
  - 사이트(`src/sharing/`)
    - migration `0014_jig_submissions`
    - pack 원본은 R2에 원시 업로드한다. 크기 상한을 둔다.
    - 장치 API `/api/hosts/device/jig-submissions`
    - 관리자 API `/api/admin/jigs`. `isAdminName`으로 막는다.
    - 관리자 제출함 페이지
  - 관리자 도구 `npm run jig:unpack -- <pack>`
    - 사이트에 기록된 digest로 무결성을 확인한다.
    - `extensions/jigs/<id>/`에 푼다.
- **검증:**
  - 사이트 시험: 비관리자 403, 크기 상한, digest
  - 엔진 시험: 요청 형식, 원격 거절
- **배포:** 사이트 배포(D1 migration, wrangler deploy)는 사용자가 확인한 뒤에 한다.
- **완료:** 시험이 통과하고 로컬에서 제출부터 관리자 목록, 풀기까지 확인한다.

## T-202 외부 서비스 연동 계약

- [ADR-040](../decisions/ADR-040-domain-services.md)과 ARCH-01 §「외부 도메인 서비스」를 쓴다. 코드는 없다.
- 완료: 문서 검사(`npm run docs:check`)가 통과한다.

## 실행 순서

1. 문서를 먼저 쓴다: 이 계획, PRD 후보·OQ, RESEARCH-16, ADR-040·041, ARCH-01.
2. T-197, T-198, T-200, T-201은 worktree 작업자가 병렬로 맡는다. 각 작업자는 자기 티켓의 SPEC·Design 보완부터 하고 구현한다.
3. T-199는 호스트를 실행해야 하므로 메인 체크아웃에서 순서대로 한다.
4. 릴리스, push, 사이트 배포는 사용자가 요청할 때만 한다.

## 현재 상태

| 티켓 | 상태 | 증거 |
|---|---|---|
| T-197 | 구현·시험 완료(실호스트 확인 전) | `tests/integration/browser-section.mjs`, SPEC-01.15, Design 단면 |
| T-198 | 구현·시험 완료 | SPEC-11, Design SCR-28, 공식 라이브러리 `vide/finish-codes`, 프로젝트 DB schema 12(`finish_rooms`·`finish_sheets`). `tests/core/finish.test.mjs`(검색·두께·배정 규칙·붙여넣기·표 행·CSV·자료 경계), `tests/server/finish-routes.test.mjs`(저장·거절·프로젝트별), `tests/integration/browser-finish.mjs`(탭 4개·배정·출력·인쇄·CSV) 통과. XLSX는 새 의존성이 필요해 범위 밖(SPEC-11.5 7) |
| T-199 | 완료 | [SPIKE-2026-10-07-drawing-export](../tdd/SPIKE-2026-10-07-drawing-export.md) |
| T-200 | 구현·시험 완료(실제 ZWCAD 2023 합성 도면 확인) | SPEC-01.11의 11, ARCH-01 「도면 xref 관계(T-200)」, H-ZWCAD-12, Design 「도면 관계」. worker `VIDEXREFGRAPH`(`hosts/zwcad/worker/XrefGraph.cs`, 표시는 `AttachedDisplay` 공유), `src/core/xref-graph.ts`·`xref-store.ts`(프로젝트 DB 파생 표, 버전 스키마 밖), `src/server/xref.ts`, 경로 연결 `DocumentLinks.pathLink`, 연결 행 `placement`와 뷰포트 배치. `tests/core/xref-graph.test.mjs`(경로 해석·누락·중복·순환·루트·배치 합성), `tests/server/xref.test.mjs`(거절·다시 읽기·바뀐 것만·반영·같은 파일 재반영 없음), `tests/integration/browser-xref.mjs`(트리·표시·반영 뒤 연결 5개·배치 4개·뷰포트에서 배치된 선 고르기) 통과. 실호스트 `tests/integration/zwcad-xref.mjs`(없으면 건너뜀) 통과: 합성 7.7초, 읽기 7.1초, 반영 7.2초 |
| T-201 | 구현·로컬 시험 완료, 사이트 배포 대기 | SPEC-07.19·04.13, ARCH-01 §6 「jig 관리자 제출」, Design SCR-27. `tests/server/jig-submit.test.mjs`(요청 형식·확인·원격 거절·풀기), `tests/sharing/jig-submissions.mjs`(비관리자 403·크기 상한·digest·자기 목록·엔진 묶음→관리자 목록→풀기) 통과. D1 `0014` 원격 적용과 Worker 배포는 사용자 확인 뒤 |
| T-202 | 완료(문서) | [ADR-040](../decisions/ADR-040-domain-services.md), ARCH-01 §「외부 도메인 서비스」 |
