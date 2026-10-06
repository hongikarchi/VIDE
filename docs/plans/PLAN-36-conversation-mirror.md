---
id: PLAN-36
title: 대화 기록 공유 — 요청·답 전문을 사이트로 (T-165~T-169)
status: review
version: 0.1
updated: 2026-10-06
owner: agent:claude
related: [PLAN, PLAN-33, PLAN-35, SPEC-04, ADR-035, ADR-036, ADR-037, ARCH-01, FR-16, FR-19]
---

# 대화 기록 공유 (T-165~T-169)

2026-10-06 사용자 결정 [ADR-037](../decisions/ADR-037-team-shared-project-layer.md) 4: 요청·AI 답·대화 기록 전문을 서버에 올린다. 그 작업을 돌린 PC가 원본이고 사이트는 글 사본이며, 멤버는 사이트와 자기 VIDE에서 읽는다. 같은 날 사용자 조정 "모델링 대화는 서버에 안 올림": 호스트 문서가 있는 요청은 전문을 올리지 않는다. 동작은 [SPEC-04.12](../specs/SPEC-04-web-review.md), 물리 계약은 [ARCH-01 대화 기록 공유](../architecture/ARCH-01-system.md), 화면은 [Design SCR-25](../../Design.md)다. ADR-037 1~3(프로젝트 목록·지시·자료 DB, D1 `0011`, 원격 프로젝트 화면)은 PLAN-35(T-160~T-164)가 병행으로 맡는다. 이 계획은 자료와 보기 전용 대화 구성 요소(`src/ui/conversation-mirror/`)를 내고, 원격 프로젝트 화면에 넣는 일은 PLAN-35가 한다.

## 티켓

| 티켓 | 내용 | 상태 |
|---|---|---|
| T-165 | 정본: SPEC-04.12(무엇을 올리나·호스트 문서 없는 대화만·끄기)과 §10 7 스위치 이름, ADR-037 4의 사용자 조정, ADR-035 이후 변경, 개인정보 안내(`src/contracts/telemetry-notice.ts`의 '프로젝트 대화 기록'), Design SCR-25, ARCH-01 | 작성(사용자 확인 대기) |
| T-166 | 사이트 저장·경로: `0012-shared-conversations.sql`(대화·요청·문서 조각), `src/sharing/conversations.ts`(PC 올리기·지우기·다른 PC 기록 읽기, 구성원 목록·대화·찾기), `hosts.ts`·`worker.ts` 경로 | 구현·로컬 시험 |
| T-167 | PC 올리기: `src/server/conversation-mirror.ts`(판정 `shareableRequest`, 지문 비교로 바뀐 요청만, 약 1 MB·8개 묶음, 묶음마다 기록·재시작 이어 올리기, 숨긴 요청 지우기, 끄기·프로젝트 삭제의 사이트 삭제와 재시도), `offline-view.ts`의 같은 스위치, 스위치 이름 "할 일·대화 기록을 사이트에 올리기"와 실패 한 줄(`links.tsx`) | 구현·로컬 시험 |
| T-168 | 읽기: 다른 구성원의 기록을 `projects/<id>/history/`(대화마다 Markdown, README, `.data/mirror.json`)로 받기(10분마다·화면을 열 때), AI 규칙(`workFolderRule`)의 안내, VIDE 작업 이력의 '다른 구성원의 대화'와 보기 전용 창(`shared-history.tsx`), 사이트 [대화 기록] 화면(`conversations.tsx`, 찾기·목록·전문), PC 없이 보기의 [대화 기록 전문] | 구현·로컬 시험 |
| T-169 | 배포·실제 확인: 원격 D1 `0011`(PLAN-35) 뒤 `0012` 적용, Worker 배포, 설치본 반영, 두 계정·두 PC로 올리기 → 다른 PC 작업 이력·AI 읽기 → 끄기 삭제 확인 | 사용자 확인 대기 |

## 변경 범위와 경계

- **올리는 요청:** `shareableRequest`가 참인 요청만(호스트 사용 `none`, 연결 파일·기준·원본 문서·대상·jig·확장 없음, 결과에 문서 실행 없음). 섞인 대화는 그 요청만, 대화 행은 제목·종류·제공자·모델 이름·시각만.
- **요청 문서:** 요청 글·답 전문·활동 줄(세부 내용은 생각·메시지·실행 줄만; 조회·결과 세부는 모델 자료가 들어갈 수 있어 뺌)·실행 코드·파일 이름(연결 파일·첨부의 이름). 첨부 내용·형상·핀 좌표는 없다. 길이 상한을 두지 않고 100,000자 조각으로 나눈다(ADR-031). 올리기 한 번의 본문은 24 MB까지(PC는 약 1 MB·8개씩 묶는다. 한 요청이 아주 길면 조각 수만큼 쿼리가 늘어 무료 요금의 호출당 쿼리 한도에 걸릴 수 있다).
- **PC 없이 보기 요약(`0009`)은 바꾸지 않는다.** 모델링 요청까지 포함한 최근 50개 요약은 그대로 올라가고 PC 없이 보기 화면이 보인다. 전문은 별도 화면이며 요약 머리의 [대화 기록 전문]으로 간다. 요약을 새 표에서 만들지 않는 이유: 모델링 요청은 새 표에 없다.
- **자기 행만:** PC는 자기 `origin_host`의 행만 바꾸고 지운다. 다른 PC의 요청 id와 겹치면 409.
- **비용:** D1 행뿐(R2 없음). 비교는 프로젝트마다 1분에 한 번까지(`hostUse='none'` 요청만 읽음), 다른 구성원 기록은 바뀐 문서만 받는다.
- 선행 조건: 없음(사이트가 아직 `0012`가 없으면 PC의 올리기는 '사이트 업데이트 전'으로 실패 표시하고 1분 뒤 다시 시도). 미결: 기본 켜짐(SPEC-04 R-02와 같은 질문), PRD 반영(ADR-037 범위의 FR 문장은 PLAN-35와 함께 첨삭으로 낸다).

## 검증

- PC 단위(`tests/server/conversation-mirror.test.mjs`): 판정(호스트 사용 없음·연결 파일·jig·실행 기록·원본 문서), 조각 나누기(서로게이트 쌍), 첫 묶음 뒤 실패 → 새 인스턴스가 남은 것만 올림, 긴 답 전문, 모델링·연결 파일 요청 제외, 조회 세부·형상 없음, 바뀌지 않으면 보내지 않음, 바뀐 요청만 다시, 숨긴 요청 `removed`, 끄기 삭제 실패 → heartbeat 재시도, 다른 구성원 기록의 Markdown·README·`since` 읽기·사이트 끊김 시 사본·사이트에서 지워지면 사본에서도 지움, 스위치 끄기에서 `DELETE`와 이후 올리지 않음.
- 사이트(`tests/sharing/conversations.mjs`, 로컬 workerd + 실제 `RemoteAccess`·`ConversationMirror` 두 PC): 긴 답이 세 조각 이상 → 대화 전문에서 그대로, 모델링 요청은 D1에 없음, 다른 계정 404·로그인 없음 401, 찾기(마지막 조각의 말·모델링 글은 없음), 다른 PC의 덮어쓰기 409·지우기 무효, 구성원 아닌 PC 404, 구성원 PC의 사본(Markdown에 모델링 글 없음), 자기 PC는 자기 기록을 다른 구성원 것으로 보이지 않음, 끄기에서 행·조각 삭제와 구성원 사본 정리. 브라우저: 사이트 [대화 기록] → 대화 전문·활동 코드·찾기 결과.
- VIDE 화면(`tests/integration/browser-offline.mjs`): 스위치 이름 '할 일·대화 기록을 사이트에 올리기', 엔진 사본의 다른 구성원 대화가 작업 이력에 '사이트 연결 안 됨'과 함께 보이고 창에서 답·파일 이름·활동 코드, 입력칸 없음, Esc로 닫힘.
- 전체: `npm run typecheck`, `npm run typecheck:sharing`, `npm test`, `npm --prefix src/sharing test`, `npm run build:sharing`, `npm run build:web`, `npm run docs:check`, `npm run format:check`, `browser-offline`·`browser-conversations`·`browser-react-panels`.

## 배포 순서(T-169, 사용자 지시 뒤)

1. 원격 D1에 `0011`(PLAN-35) 다음 `0012-shared-conversations.sql` 적용(스테이징 먼저).
2. Worker·사이트 배포(`build:sharing` 결과).
3. 설치본 릴리스. 이전 사이트에서는 PC 올리기가 `NOT_FOUND`로 실패 표시만 하고 다른 기능에 영향이 없다.

## 완료 판단

T-166~T-168은 위 자동 검증으로 로컬 완료다. 제품 완료는 T-169의 실제 사이트·두 PC 확인 뒤다.
