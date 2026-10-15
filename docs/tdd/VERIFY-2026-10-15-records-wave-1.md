---
id: VERIFY-2026-10-15-records-wave-1
title: 프로젝트 기록 웨이브 1 오프라인 검수 (T-326)
status: review
version: 0.1
updated: 2026-10-15
owner: agent:claude
related: [C-09, SPEC-17, PLAN-53, SCR-44]
---

# 프로젝트 기록 웨이브 1 오프라인 검수 (T-326)

[PLAN-53](../plans/PLAN-53-project-records.md) T-326 중 **오프라인 부분만** 기록한다. 기준은 [SPEC-17](../specs/SPEC-17-project-records.md) 3의 수용 결과(요청 10·노트 5·설정값 변경 3 → 후보 18건 안팎, 중복 0)와 SPEC-17.8 1(웨이브 1), 화면은 Design SCR-44다. 관련 AC는 아직 없다(C-09는 후보 기능이며 PRD §15에 기록 AC가 없다). 그래서 SPEC-17.3·17.8의 수용 결과 문단을 기준으로 쓴다.

## 환경

- 저장소 HEAD `32409d4f`, 작업 트리에 웨이브 1 변경 포함(커밋 전), Windows 11, Node v24.15.0.
- **합성 데이터만** 썼다. 모든 요청 문장·노트 문단·부위 이름은 지어낸 것이다. 실제 프로젝트, 사용자 원본, 설치 엔진(47821), Rhino·ZWCAD는 쓰지 않았다.
- 개발 서버는 `%TEMP%` 아래 임시 데이터 폴더에서 `startServer`(임의 포트)로 띄웠고 끝난 뒤 폴더를 지웠다.
- 후보는 `server.ts`가 감싸는 것과 같은 훅(`attachRecordSources`의 `requestFinished`·`noteCopied`·`paramsChanged`)을 같은 데이터 폴더의 `Store`에서 불러 만들었다. 실제 AI 턴·호스트 실행·노트 사이트 동기화를 거치지는 않았다. 요청 행은 `workspace_requests`에 직접 넣었고, 각 요청은 연결 파일 하나(`mass.3dm`)의 `beam-1` 또는 `wall-1`을 바꾼 실행 기록을 가진다. 그중 하나는 되돌림(`undone`)이다.
- 검수 스크립트는 저장소 밖 scratchpad에 두었다(일회성).

## 시나리오

| 단계 | 기대 | 실제 | 판정 |
|---|---|---|---|
| 요청 10·노트 5(노트 3·협의 1·일지 1)·설정값 변경 3을 **두 번씩** 훅에 넣음 | 후보 18건 안팎, 모두 `candidate`·`by=ai`, `sourceKey` 중복 0, 진단 실패 기록 0 | 19건(요청 10·대화 결정 1·노트 3·회의록 1·일지 1·jig 3), 모두 후보, 중복 0, 실패 기록 0 | 통과 |
| `GET records?state=candidate` | 19건 | 19건 | 통과 |
| `POST records/state`로 O 6건·X 3건 | changed 6·3, counts 남김 6·뺌 3 | changed 6·3, counts 후보 10·남김 6·뺌 3 | 통과 |
| `GET records/export?format=marks` | 19자, o 6·x 3, ids 19 | 19자, o 6·x 3, ids 19 | 통과 |
| 부위 2개(구조 보 → `S-BEAM`, 외벽 → 없는 레이어) → `GET parts/status` | 구조 보 끊김 없음, 외벽 `layer-missing` | 구조 보 `broken []`, 외벽 `broken [0]`·`layer-missing` | 통과 |
| 외벽을 `A-WALL`로 다시 잇기(`PUT parts/:id`) | 끊김 0 | 200, `broken []` | 통과 |
| `GET objects/beam-1/records?linkId=` | 보를 바꾼 요청의 기록과 구조 보 부위의 기록, 되돌린 요청 표시, 뺌 제외 | 5건(요청 경유 4·부위 경유 1·되돌림 1), 뺌 0 | 통과 |

참고: 후보 19건 중 '대화 1'은 '보 간격을 3m로 바꿔줘. 계단은 철골로 하기로 했어'의 결정 문장이다. '외벽은 석재로 가자'처럼 요청 전체가 결정 문장 하나인 요청은 별도 후보가 되지 않고 요청 후보의 유형이 D가 된다(ARCH-01 §5 「프로젝트 기록」 자동 후보 진입점).

## 시험 명령과 결과

| 명령 | 결과 |
|---|---|
| `npm run typecheck` | 통과(ui·server) |
| `npx prettier --check` (변경·새 ts/tsx/mjs/css/json) | 통과 |
| `npm test` | 1,847건 중 1,847 통과, 실패 0 |
| `npm run build:web` | 통과 |
| `node tests/integration/browser-records.mjs` | `browser records: ok`(후보 120건 키 거르기·내보내기↔불러오기·부위 사전 끊김 → 다시 잇기 왕복·원격 읽기만·금지어 0) |
| `node tests/integration/browser-object-records.mjs` | 통과(`objectRecords: 3`, 요청 카드 열림, 실제 엔진 라우트) |
| `node tests/integration/browser-workspace-tabs.mjs` | 통과 |
| `node tests/integration/browser-react-panels.mjs` | 통과(16항목) |
| `node tests/integration/browser-files-tab.mjs` | 통과(회귀) |
| 합성 검수 스크립트(위 시나리오) | 7단계 모두 통과 |

## 미시험

- 실제 프로젝트 데이터, 사용자 동승, 설치본에서 기록 탭 15분 확인(T-326의 짧은 확인).
- 100건을 10분 안에 거르는 시간 측정(SPEC-17.3 수용 결과).
- Rhino·ZWCAD에서 객체를 골라 '이 객체의 기록'으로 가는 흐름(브라우저 시험의 표시 형상 선택만 확인함).
- 실제 AI 턴의 `record_add`, 실제 노트 사이트 동기화의 `onCopy`, 실제 `JigRuntime.setParams` 경로의 후보 생성(훅 함수는 직접 불렀다).
- 문서 Sync의 K 후보(연결되지 않음 — 아래 P1).
- 웨이브 2(차트·가져오기·사본)와 웨이브 3(타임라인).

## 발견

- **P0:** 없음.
- **P1:** 문서 Sync K 후보가 실제로는 생기지 않는다. Sync 저장이 요청 완료 경로를 지나지 않기 때문이다(SPEC-17 R-47, 넘침 조건 결정 필요). 폴더 역할 확정 후보의 출처 값이 '체크아웃'으로 보인다(SPEC-17 R-46).
- **P2:** 열람자 역할 미구현(SPEC-17 R-48). 기록 탭 키 규칙이 설계와 다름(Design R-81). 기록 읽기마다 요청 결과의 되돌림 판정과 연결·부위 표 전체 읽기가 반복된다(T-337 측정 때 보완). SPEC-17.3 표 행 7·8에 티켓이 없음.
