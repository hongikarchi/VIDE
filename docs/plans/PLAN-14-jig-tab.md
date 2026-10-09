---
id: PLAN-14
title: JIG 탭과 Sync jig(도면↔모델)
status: review
version: 0.4
updated: 2026-10-08
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

## 검증

- 단위(`tests/core/sync-jig.test.mjs`): 원점이 125/48/3.2 m 다른 모델·도면의 관계, 0.8 mm 오차와 모델에만 있는 보, 30° 회전, 반복 간격의 모호성과 기준 쌍 지정, 역변환 좌표.
- 브라우저(`tests/integration/browser-jigs.mjs`): 목록 10개(준비 중 9), 저장된 두 Sync로 실행한 관계·요약·표, AI 검토 요청(호스트 없음·표 첨부·행 목록), CAD 반영 목록(mm 단위 끝점 이동·선 추가), Rhino 반영 목록(모델 좌표), 행에서 객체 보기.

## 남은 것

- 실제 나진상가 Rhino·CAD Sync로 관계·차이 확인과 양방향 반영의 실사용 검수(사용자 실행 창에서).
- 곡선·블록 내부 요소의 짝짓기(현재 직선 끝점 기준), 속성(단면 형식·이름) 차이 비교.
- 준비 중 jig(구조 검토·사이트 모델링·법규 검토 등)의 조사 보강과 이식.
