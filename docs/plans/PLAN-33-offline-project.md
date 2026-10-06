---
id: PLAN-33
title: PC가 꺼져도 프로젝트 열기 — 할 일·노트·작업 이력 요약 (T-150~T-154)
status: review
version: 0.1
updated: 2026-10-06
owner: agent:claude
related: [PLAN, PLAN-20, SPEC-04, ADR-035, ARCH-01, FR-16, FR-18, FR-19]
---

# PC가 꺼져도 프로젝트 열기 (T-150~T-154)

2026-10-06 사용자 결정: "지금은 메인 컴퓨터가 꺼져있으면 해당 프로젝트가 아예 열리지 않는데, 모델은 안 보여도 그냥 접속이 가능하면 좋겠음." 고른 범위: PC가 꺼져도 프로젝트는 사이트에서 늘 열리고, 할 일·노트는 읽고 쓰며(PC가 켜질 때 반영), 작업 이력은 요약만 읽기 전용. 모델 저장본은 기존 스위치 그대로(R2 정리 뒤 사용자가 켠다). 동작은 [SPEC-04.10](../specs/SPEC-04-web-review.md), 결정 근거는 [ADR-035](../decisions/ADR-035-offline-project-summary.md), 물리 계약은 [ARCH-01 계정 웹사이트와 작업 PC](../architecture/ARCH-01-system.md), 화면은 [Design SCR-21](../../Design.md)이다. 저장된 모델·요청 대기는 [PLAN-20](PLAN-20-offline-view.md)이 그대로 소유한다. 노트(실시간 공유 노트, D1 `0008`·Durable Objects)는 PLAN-32의 병행 작업이며 이 계획은 화면의 자리만 둔다. PC 대시보드 할 일 화면은 PLAN-30이 바꾸므로 `src/ui/dashboard*.tsx`는 건드리지 않는다.

## 티켓

| 티켓 | 내용 | 상태 |
|---|---|---|
| T-150 | 정본: SPEC-04.10과 §9 "작업 이력은 올리지 않는다"의 첨삭(R-01·R-02), ADR-035, PRD FR-19 첨삭(R-76), Design SCR-21, ARCH-01 | 작성(사용자 수락 대기) |
| T-151 | 사이트 저장·경로: `0009-offline-project.sql`(할 일 사본·사이트 변경 대기열·이력 요약), `src/sharing/summary.ts`(구성원 조회·쓰기, PC 올리기·지우기·적용 확인), heartbeat 응답의 `agendaEdits` | 구현·로컬 시험 |
| T-152 | 사이트 화면·여는 흐름: 꺼짐·로그아웃·PC 없음·업데이트 필요에서 PC 없이 보기 화면으로(`home.tsx`), 안내 띠·할 일(추가·완료·글·날짜·삭제)·작업 이력 요약·노트 자리·저장된 모델 자리(`offline.tsx`·`offline-summary.tsx`), iPad 중계 503 안내의 링크(`pc-proxy.ts`) | 구현·로컬 시험 |
| T-153 | PC: 프로젝트마다 할 일·이력 요약을 지문 비교로 바뀐 때만 올리기(스냅샷 스위치와 무관, 이력 1분 간격), 사이트 변경 적용(같은 revision이면 적용, 아니면 나중 쓰기 + 항목 글의 충돌 메모, 한 번만), 적용 뒤 목록 먼저 올리고 결과 확인, 프로젝트별 끄기(`offline-view.ts`·`offline-summary.ts`·`remote-access.ts`·`server.ts`·`links.tsx`) | 구현·로컬 시험 |
| T-154 | 배포·실제 확인: 원격 D1 `0008`(PLAN-32) 뒤 `0009` 적용, Worker 배포, 설치본 반영, iPad에서 PC 끈 채 열기·할 일 고치기 → PC 켜서 반영 확인 | 사용자 확인 대기 |

## 변경 범위와 경계

- 사이트에 두는 것은 D1 행뿐이다(R2 없음). 할 일 500개·글 500자, 이력 100개(PC는 50개 보냄)·요청 글 600자·답 400자·파일 이름 10개, 미적용 사이트 변경 200개.
- 보는 사람은 구성원 모두(SPEC-04.10 6, 2026-10-06 사용자 결정 "PC없이 보기는 모든 사용자가 볼 수 있도록"). 참여자 200(읽기·쓰기), 다른 계정 404. 참여자가 프로젝트를 누르면 이 화면이 열린다(`home.tsx`).
- 사이트 변경은 PC의 할 일만 바꾼다. AI 실행·호스트 명령은 더하지 않는다.
- 선행 조건: 없음(PC가 올린 적 없으면 사이트는 읽기만 안내하고 쓰기를 받지 않는다). 미결: SPEC-04 R-02(기본 켜짐)의 사용자 확인.

## 검증

- 사이트(`tests/sharing/offline.mjs`, 로컬 workerd): 올린 적 없을 때 빈 목록·쓰기 409, PC 올리기·다른 PC 거절·잘못된 항목 거절, PC 꺼짐에서 `open` 409 `HOST_OFFLINE`와 중계 503 안내의 `/?offline=` 링크, 이력 요약에 모델·첨부·AI 모델 이름이 저장되지 않음, 참여자 403·다른 계정 404(읽기·쓰기), 추가·고치기·합치기·잘못된 날짜 400·없는 항목 404·대기 중 추가의 삭제, 겹친 화면, heartbeat로 한 번만 전달, PC가 다시 올린 뒤 대기 0, 끄기에서 삭제. `--browser`: PC 꺼진 프로젝트 열기 → 안내 띠·할 일 추가·완료 → 'PC 반영 대기'·이력 안내.
- PC(`tests/server/offline-view.test.mjs`): 스냅샷이 꺼져도 할 일·이력이 올라감, 이력 요약의 필드가 여섯 개뿐이고 첨부·경로·모델·형상·핀·공급자가 없음, Sync 제외, 바뀌지 않으면 다시 보내지 않음, 사이트 추가·완료 적용과 두 번 오면 한 번만, 확인 전 바뀐 추가는 만든 항목에 반영, 충돌 두 방향(사이트가 나중·PC가 나중)과 항목 글의 메모, 지운 항목은 `missing`, 끄면 사이트 삭제·더 올리지 않음.
- VIDE 화면(`tests/integration/browser-offline.mjs`): '할 일·작업 이력 요약을 사이트에 올리기' 기본 켜짐, 끄기가 `PUT {summary:false}`.
- 전체: `npm run typecheck`, `npm run typecheck:sharing`, `npm test`, `npm --prefix src/sharing test`, `npm run build:sharing`, `npm run docs:check`.

## 완료 판단

T-151~T-153은 위 자동 검증으로 로컬 완료다. 제품 완료는 T-154의 실제 사이트·PC 확인 뒤이며, 그 전까지 배포된 사이트는 `0009`가 없어 PC의 올리기를 404로 거절하고 VIDE에는 '올리기 실패: 사이트 업데이트 전'이 보인다.
