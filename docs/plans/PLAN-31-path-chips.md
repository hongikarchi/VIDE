---
id: PLAN-31
title: 붙여넣은 경로를 칩으로 (T-140~T-142)
status: draft
version: 0.1
updated: 2026-10-06
owner: agent:claude
related: [SPEC-01, SPEC-09, ARCH-01, ADR-031, PLAN-26]
---

# 붙여넣은 경로를 칩으로 (T-140~T-142)

근거: 2026-10-06 사용자 요청 "파일 경로 복붙하면 pin처럼 처리되면 좋을 듯. 채팅창에서 자동으로 인식해서 기존의 pin처럼 block으로 처리". 동작은 [SPEC-01](../specs/SPEC-01-project-input-sync.md).12의 6과 .13의 5, [SPEC-09](../specs/SPEC-09-reference-intent.md).11의 4, 화면은 [Design](../../Design.md) §04, 계약은 [ARCH-01](../architecture/ARCH-01-system.md) §3 「첨부 보관과 읽기 도구」. [ADR-031](../decisions/ADR-031-stock-first.md) 8대로 AI는 순정 도구로 읽고 VIDE는 경로를 첨부·읽기 허락으로 건넨다.

## T-140 작성기의 경로 칩

| 변경 | 위치 |
|---|---|
| 경로 후보 추출(드라이브·UNC·따옴표·공백·여러 줄·조사·문장부호), 토큰 정규식·이름 | `src/ui/path-tokens.ts` |
| 붙여넣기·끝난 입력(닫는 따옴표·줄바꿈) → `path-kinds` 확인 → 토큰 치환, 초안 `paths`, 원격 세션 안내, 보낼 때 파일 칩 첨부 | `src/ui/app/path-chips.ts`, `src/ui/app/composer.ts` |
| 경로 토큰도 칩으로 그리고 통째로 지우기, 마우스 올리면 전체 경로 | `src/ui/pin-tokens.ts`, `src/ui/style.css` |
| 초안 저장에 `paths`, 요청 패킷에 본문에 남은 폴더 칩의 `folders` | `src/ui/model.ts`, `src/ui/draft-storage.ts` |

## T-141 엔진

| 변경 | 위치 |
|---|---|
| `POST …/attachments/path-kinds`, `…/from-path` 형식 제한 해제 | `src/server/attachment-paths.ts`, `src/ui/reference-check.ts` |
| 요청 `folders` 필드, 접수 때 `checkFolder`·원격 거절, 개입 본문에서 제거 | `src/contracts/workspace.ts`, `src/server/server.ts` |
| 턴의 게이트 `granted`(읽기만), 패킷 `folder` 항목 | `src/server/project-files.ts`, `src/server/execution.ts` |

## T-142 검증

- 단위(`tests/server/path-chips.test.mjs`): 드라이브·UNC·따옴표·공백·여러 줄·한국어 이름의 후보, 아무 형식 파일 복사, `path-kinds`의 파일·폴더·없음·금지, 게이트 `granted` 읽기 허용·쓰기는 묻기·금지 위치 거절.
- 브라우저(`tests/integration/browser-path-chips.mjs`): 임시 파일·폴더 경로 붙여넣기 → 두 칩, Backspace 한 번에 칩 삭제, 다시 붙여 보내기 → 요청의 `files`에 복사 첨부, `folders`에 폴더 경로, 원격 거절.
- 회귀: `npm run typecheck`, `npm test`, `npm run build:web`, browser-pin-tokens·reference-image·workspace-controls·react-panels·conversations.

**완료 판단:** 위 자동 검증 통과. 남은 조건: 설치본 반영 뒤 사용자 창에서 탐색기 '경로로 복사' 붙여넣기 확인.
