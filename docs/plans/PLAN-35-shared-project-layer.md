---
id: PLAN-35
title: 팀 공유 프로젝트 층 — 목록·AI 지시·정리된 자료 (T-160~T-164)
status: review
version: 0.1
updated: 2026-10-06
owner: agent:claude
related: [PLAN, ADR-037, ADR-018, ADR-032, ADR-034, ADR-035, SPEC-01, SPEC-04, SPEC-08, ARCH-01, FR-09, FR-19]
---

# 팀 공유 프로젝트 층 (T-160~T-164)

2026-10-06 사용자 결정 "서버로 올리는거는 추천대로"([ADR-037](../decisions/ADR-037-team-shared-project-layer.md))의 1~3을 구현한다. 1 프로젝트 목록·멤버는 서버가 원본이고 VIDE 앱 목록은 이 PC의 프로젝트와 공유받은 프로젝트를 합친다. 2 프로젝트 AI 지시는 서버가 원본이고 각 PC가 사본을 턴에 넣는다. 3 정리된 자료(진술·이슈·검토·출처 제외 규칙)는 서버가 원본이고 원본 문서와 수집은 PC에 둔다. 4(요청·답·대화 전문의 서버 사본)는 병행 계획 PLAN-36(T-165~T-169, D1 `0012`)이 소유한다. 동작은 [SPEC-04.11](../specs/SPEC-04-web-review.md)·[SPEC-08.5](../specs/SPEC-08-project-facts.md)·[SPEC-01.1](../specs/SPEC-01-project-input-sync.md), 물리 계약과 데이터 위치 표는 [ARCH-01 「데이터 위치」·「팀 공유 프로젝트 층」](../architecture/ARCH-01-system.md), 화면은 [Design SCR-24](../../Design.md)다.

## 티켓

| 티켓 | 내용 | 상태 |
|---|---|---|
| T-160 | 정본: SPEC-04.11, SPEC-08.5·.8, SPEC-01.1 목록 문장, PRD FR-09·FR-19 첨삭(R-78), Design SCR-24, ARCH-01 「데이터 위치」·「팀 공유 프로젝트 층」, 이 계획 | 작성(사용자 수락 대기) |
| T-161 | 사이트: D1 `0011-shared-project-layer.sql`(`project_instructions`·`knowledge_sets`·`knowledge_rows`·`knowledge_reviews`·`knowledge_rules`), `src/sharing/shared-layer.ts`(구성원 확인, 지시 revision·나중 쓰기·충돌, 자료 묶음 begin·rows·commit·rows 읽기, 검토·규칙 나중 쓰기 교환), PC의 공유 목록 `GET /api/hosts/device/projects`와 구성원 보기 `…/member/(agenda|history|snapshots)`, 사이트 PC 없이 보기 화면의 AI 지시 칸 | 구현·로컬 시험 |
| T-162 | PC 목록·원격 프로젝트 모드: `src/server/shared-project.ts` `SharedProjects`(목록 사본 `<데이터>/shared-layer/projects.json`, 원격 보기), `GET /api/v1/shared-projects[/:id]`, 프로젝트 고르기의 '공유받은 프로젝트' 묶음, 원격 프로젝트 화면(`src/ui/remote-project.tsx`) | 구현·자동 검증 |
| T-163 | AI 지시 서버 원본: `ProjectInstructionStore` 사본(revision·보낼 것·충돌), 첫 연결 때 이 PC의 지시 올리기, 저장 즉시 보내기·실패 시 대기, heartbeat 뒤 바뀐 지시 받기, 설정 화면의 공유 상태·충돌 안내, 원격 프로젝트의 지시 고치기 | 구현·자동 검증 |
| T-164 | 정리된 자료 서버 원본: 수집 PC의 자료 DB를 바뀐 때만 묶음으로 올리기, 다른 PC는 같은 형식의 사본(`meta.vide_copy`)으로 받기, 검토·제외 규칙의 보낼 상자와 나중 쓰기 교환, 자료 화면·AI 도구는 로컬 사본을 그대로 읽음 | 구현·자동 검증 |

배포(원격 D1 `0011`·Worker 배포·설치본 반영·두 PC 확인)는 이 계획의 티켓이 아니라 사용자 지시 뒤의 작업이다. 순서: PLAN-32 `0008`·PLAN-33 `0009`·PLAN-34 `0010` 뒤 `0011`, 그다음 PLAN-36의 `0012`.

## 변경 범위와 경계

- 사이트에 두는 것은 D1 행뿐이다(R2 없음). 지시 8 KB, 자료 묶음은 진술에 쓰인 발췌·출처 경로만(발췌 글 20,000자에서 자름, 원본 파일 없음), 한 요청 200행·2 MB.
- 쓰기 권한: 지시·검토·규칙은 구성원 누구나(역할 무관), 자료 묶음 올리기는 구성원의 PC 키로만(브라우저 불가). 구성원이 아니면 404.
- 원격 프로젝트 모드는 읽기 위주다: 할 일·작업 이력 요약·노트 목록·저장된 모델 목록·자료 수를 보이고, 고칠 수 있는 것은 AI 지시뿐이다(할 일·노트는 사이트·노트 화면에서). 모델·Sync·AI 턴·호스트 동작은 없다.
- 원격 세션(터널)은 지시를 고칠 수 없다(기존 규칙 유지). 다른 기기는 사이트 화면에서 고친다.
- 선행 조건: 없음. 사이트에 `0011`이 없으면 PC는 404를 받아 지시는 '사이트 반영 대기', 자료는 '사이트 업데이트 전'으로 남기고 로컬 동작은 그대로다.
- 미결: PRD R-78(범위 첨삭) 수락, 자료 묶음 올리기를 소유자 PC로 좁힐지(현재 구성원 PC 누구나).

## 검증

- 사이트(`tests/sharing/shared-layer.mjs`, 로컬 workerd): 다른 계정 404·참여자 쓰기 허용, 지시 revision 증가, 오래된 base의 나중 쓰기 적용과 충돌 반환, 더 이른 편집의 거절, 8 KB 초과 400, 자료 묶음 begin·rows·commit 전에는 이전 판만 보임, 잘못된 표·열 거절, 브라우저의 묶음 올리기 거절, 검토·규칙 나중 쓰기, PC의 공유 목록(역할·호스트·`here`), 구성원 보기 경로.
- PC(`tests/server/shared-project.test.mjs`): 합친 목록에서 이 PC 프로젝트 제외·사이트 불가 시 사본, 원격 보기 묶음, 지시 첫 연결 올리기·받기·대기·충돌 기록과 턴의 `projectInstructions` 사본, 자료 묶음 올리기(지문 같으면 다시 안 보냄)·다른 PC의 사본 받기와 `factSearch`·`knowledgeSummary`가 사본을 읽음, 검토 보낼 상자와 받은 검토 적용.
- 화면(`tests/integration/browser-shared-projects.mjs`): 프로젝트 고르기의 '공유받은 프로젝트' 묶음, 고르면 원격 프로젝트 화면과 안내 문구·AI 지시 저장.
- 전체: `npm run typecheck`, `npm run typecheck:sharing`, `npm test`, `npm --prefix src/sharing test`, `npm run build:sharing`, `npm run docs:check`, `npm run format:check`, `npm run build:web`, 브라우저 시험 browser-react-panels·workspace-tabs·project-folders·facts·offline·ai-instructions·shared-projects.

## 완료 판단

T-161~T-164는 위 자동 검증으로 로컬 완료다. 제품 완료는 원격 D1 `0011`과 Worker 배포, 두 계정·두 PC에서 공유받은 프로젝트 열기·지시 고치기·자료 받기 확인 뒤다.
