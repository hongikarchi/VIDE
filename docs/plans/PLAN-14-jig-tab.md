---
id: PLAN-14
title: JIG 탭과 Sync jig(도면↔모델)
status: review
version: 0.6
updated: 2026-10-14
owner: agent:claude
related: [PLAN, SPEC-05, ARCH-01, FR-13, FR-18, RESEARCH-04, RESEARCH-05]
---

# JIG 탭과 Sync jig(도면↔모델)

2026-09-29 사용자 요청("jig들을 모아 놓은 탭", "원점이 다르고 소수점으로 틀어진 CAD·Rhino를 맞추고, 다른 정보를 알려 주고, 양쪽에 동기화")의 작업이다. 동작은 [SPEC-05.8](../specs/SPEC-05-extensions-install.md), 물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md) "JIG 탭과 Sync jig"가 소유한다. jig 개념과 공식 jig 목록은 [RESEARCH-04](../research/RESEARCH-04-jig-past-experience.md), 형식 선택지(계약 우선·표준 관문)는 [RESEARCH-05](../research/RESEARCH-05-jig-format-options.md)를 따른다.

## 판정의 분담

사용자 질문("판정할 때 AI 개입이 필요하지 않나")에 대한 결정: 정렬과 객체 짝짓기는 수천 개 객체를 매번 같은 결과로 처리해야 하므로 계산이 맡고, 차이의 의미(의도된 표현인지, 어느 쪽을 고칠지)는 AI가 계산 표만 근거로 판정한다. AI는 표의 행 번호만 인용할 수 있고 벗어나면 경고가 붙는다. 반영은 계산된 정확한 좌표를 기존 수정 경로로 보낸다.

## 구현

1. `src/jigs/sync.ts`: 요소 추출, 관계 계산(방향 후보·길이 버킷 투표·중앙값), 모호성과 후보, 기준 쌍·후보 지정, 비교 행·레이어 대응, `inRhino` 역변환.
2. `src/jigs/catalog.ts`와 서버 경로 두 개, 실행기의 `sync-review` 경로(호스트 문맥 없음, `jigCheck`).
3. `src/ui/jigs.tsx`: 레일의 JIG 버튼, 목록(사용 가능/준비 중), Sync jig 화면(입력 선택·허용·반경·레이어, 관계·모호 후보·요약·레이어 대응, 차이 표와 필터, 행 선택과 객체 보기, AI 검토·양방향 반영 버튼). 개발용 확장은 JIG 화면의 링크로 옮겼다가, 2026-09-29 사용자 결정으로 링크와 확장 화면을 뺐다(5af758a에서 화면 파일 삭제, 서버 계약·기존 결과 표시는 유지).
4. 2026-10-08 [PLAN-51](PLAN-51-verify-loop.md) T-269(구현·단위 시험 완료, L1 Rhino+CAD 재측정 전): 채팅의 모델↔도면 맞춤 말이 Sync jig를 열고(SPEC-07.18의 1), 호스트가 하나만 연결되면 Sync jig가 '도면(CAD)이 연결되지 않았습니다 — 연결 파일에서 CAD를 연결하세요'처럼 빠진 쪽을 알린다.
5. 2026-10-14 [PLAN-51](PLAN-51-verify-loop.md) T-283(구현·자동 시험 완료, L1 R1-A 재측정 전): 라운드 2의 'Rhino 0개 · CAD 3,381개'는 저장소 읽기 결함이 아니었다. 경로는 두 Sync 모두 객체 단위 저장(`Workspace.lazy`)에서 읽고, 사본 문서 `persona-small.3dm`의 Rhino Sync 3,045개가 모두 Brep 2,734·Extrusion 210·Light 57·블록 39·점 5라 직선 요소가 없었다. `runSync`가 쪽마다 읽은 객체 수·비교 요소 수·직선이 없는 종류별 개수(`read`)를 돌려주고, 화면은 0개인 쪽에 그 이유(읽지 못함 / 직선 요소 없음과 종류별 개수 / 고른 레이어에 없음)를 보인다(SPEC-05.8).
6. 2026-10-14 T-283 솔리드 단면 비교(사용자 결정, SPEC-05.8 0.18; 구현·자동 시험 완료, L1 R1-A 재측정 전): Rhino 솔리드(Brep·Extrusion·메시)는 기준 높이의 평면 단면 외곽선의 곧은 변 하나하나가 비교 요소다. `geometry-kit` 0.2.5 `sectionOutline`(용접한 렌더 메시를 `sectionArea`와 같은 변 교차 `planeCrossing`으로 잘라 고리로 잇고 일직선 조각을 합침, 1e-4 m)을 `sync.ts`가 쓴다. 높이는 `sectionPlan`: 사람이 정한 높이 → LEVEL/레벨 점마다 + 1.2 m → 솔리드 높이 범위 가운데. 높이에 걸친 솔리드만 자르고(메타 `origin`·`boundsSize`로 거름) 객체 `geometryHash`+높이로 결과를 둔다. 행의 Rhino 쪽은 객체 ID와 `rule: 'section'`·`height`, 응답에 `section`·`read.*.rules`. 화면은 '단면 높이 (m)' 입력, 쪽마다 규칙 안내, 단면 행 표시, 단면 행을 두 반영 목록에서 빼고 알림. 도면 역반영 화면(`src/ui/drawing-backflow.tsx`)은 단면 행을 반영 기준 쌍으로 기록하지 않는다. 경로 `POST …/jigs/sync`에 `sectionHeight`(m). 성능(합성 상자 3,000개, 단위 시험): 단면만 60 ms(다시 읽기 6 ms), 비교 포함 `runSync` 약 1.1–1.2 s.

## 검증

- 단위(`tests/core/sync-jig.test.mjs`): 원점이 125/48/3.2 m 다른 모델·도면의 관계, 0.8 mm 오차와 모델에만 있는 보, 30° 회전, 반복 간격의 모호성과 기준 쌍 지정, 역변환 좌표. T-283 단면: 기둥 400×400×3400을 1.2 m에서 잘라 변 4개(0.4 m, 면을 나눈 이음점 합침), LEVEL 점 → 높이 1.2, 보 300×500(2.9–3.4 m)은 1.2 m에서 없음·3.2 m에서 6/0.3 m 변, 레벨 없으면 높이 범위 가운데 1.7, 기둥 변 3개 도면과 관계(10/20 m, 높이 차 −1.2)·일치 3·Rhino에만 1, 합성 상자 3,000개 10 s 미만.
- 브라우저(`tests/integration/browser-jigs.mjs`): 목록 10개(준비 중 9), 저장된 두 Sync로 실행한 관계·요약·표, AI 검토 요청(호스트 없음·표 첨부·행 목록), CAD 반영 목록(mm 단위 끝점 이동·선 추가), Rhino 반영 목록(모델 좌표), 행에서 객체 보기, 두께 없는 면만 있는 Rhino Sync의 '비교할 요소가 없습니다' 안내, 기둥 솔리드의 규칙 안내('솔리드 단면 변 4(솔리드 1개, 높이 1.2 m — 층 레벨 1개 + 1.2 m)')·행의 '단면 1.2 m'·단면 행만 고르면 반영 요청 없음·단면 높이 5 m에서 0개 이유(T-283).
- 서버(`tests/server/sync-jig-route.test.mjs`): 객체 단위로 저장된 Rhino·CAD Sync로 `POST …/jigs/sync`의 대응 5쌍, 솔리드 기둥 5개(Brep·Extrusion)와 기둥 사각형 3개 도면의 단면 비교(비교 20·일치 12·관계 −125/−48 m, `section`·`rules`), `sectionHeight` 1 m에서 0개, 두께 없는 면의 `read`(T-283).

## 남은 것

- 실제 나진상가 Rhino·CAD Sync로 관계·차이 확인과 양방향 반영의 실사용 검수(사용자 실행 창에서).
- 곡선·블록 내부 요소의 짝짓기(현재 직선 끝점 기준), 속성(단면 형식·이름) 차이 비교.
- 솔리드 단면 비교의 설치본 L1 R1-A 재측정(실제 3,045개 문서의 단면 시간·대응 쌍). CAD 기둥이 닫힌 폴리선 하나로 그려진 경우는 Rhino 단면 변(조각별)과 길이가 달라 짝이 되지 않는다 — 도면 폴리선을 변으로 나눠 비교할지는 다음 판단. 블록 안의 솔리드는 자르지 않는다.
- 준비 중 jig(구조 검토·사이트 모델링·법규 검토 등)의 조사 보강과 이식.
