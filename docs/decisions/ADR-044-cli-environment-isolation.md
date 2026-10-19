---
id: ADR-044
title: VIDE 턴은 사용자가 고른 외부 MCP 서버와 작업 폴더의 AGENTS.md만 들이고, 개인 CLAUDE.md·플러그인·스킬·전역 MCP는 계속 끈다
status: approved
version: 0.2
updated: 2026-10-19
owner: user
related: [OQ-15, FR-08, FR-18, RESEARCH-18, RESEARCH-10, RESEARCH-11, RESEARCH-14, SPEC-18, SPEC-01, SPEC-02, SPEC-05, ARCH-01, PLAN-55, PLAN-24, ADR-022, ADR-028, ADR-031, ADR-042, ADR-045]
---

# CLI 환경 격리 — 선택형

## 맥락

- 지금 VIDE는 공급자 CLI를 실행할 때 사용자 자신의 환경을 **전부 끈다**. Claude는 MCP·settings(user/project/local)·플러그인·스킬·`CLAUDE.md`를, Codex는 사용자 설정·규칙·MCP·`AGENTS.md`(`project_doc_max_bytes=0`)·플러그인·훅·스킬을 끈다([RESEARCH-18](../research/RESEARCH-18-environment-not-model.md) §3.4). 이 격리에 대한 제품 수준 결정은 없고, ARCH-01 §2 격리 행과 [ADR-028](ADR-028-ai-cli-parity.md) 「대체하는 것」이 인자만 적어 두었다(RESEARCH-18 §4.1).
- 끄는 원래 근거는 **작업 사본 우회 방지**였다([RESEARCH-10](../research/RESEARCH-10-vide-restructure.md) §1.2, [RESEARCH-11](../research/RESEARCH-11-ai-parity.md) §3). AI는 사본에만 쓰고 사람이 반영해야 했으므로, 사용자의 MCP·플러그인이 원본을 직접 고치는 길을 막아야 했다. [ADR-022](ADR-022-direct-apply-plan-auto.md)(2026-09-30 바로 적용)로 AI가 열린 문서를 직접 고치고 요청 단위로 되돌리게 되면서 이 근거는 사라졌으나 재평가하지 않았다.
- 사용자 불만: 자기 PC에서 Claude Code로 쓰던 Rhino MCP·cordyceps 같은 도구를 VIDE 안에서는 쓰지 못한다(RESEARCH-18 §8 D1의 Q2).
- 세 도구(Claude Code·Cursor·Kiro)의 공통 표준은 **프로젝트 범위 MCP + 첫 사용 승인**이다. 개인 지침 파일은 각 도구가 자기 지침 층에서 다루며, 다른 앱이 그 파일을 끌어다 쓰는 일은 없다(RESEARCH-18 §2).
- 반면 개인 `CLAUDE.md`는 VIDE 지침과 충돌할 수 있고, 공급자 플러그인·스킬은 VIDE가 턴마다 발급하는 도구 집합 밖으로 권한을 넓힌다.

## 선택지

| 선택지 | 내용 | 장점 | 단점 |
|---|---|---|---|
| ① 전부 끔(대체, 현행) | 사용자 환경을 모두 끄고 VIDE 지침·도구만 쓴다 | 재현이 쉽고 VIDE 지침과 충돌하지 않는다 | 근거가 사라진 제한이 남는다. 사용자가 쓰던 외부 MCP를 VIDE 안에서 못 쓴다 |
| ② 전부 켬(얹기) | 개인 `CLAUDE.md`·전역 MCP·플러그인·스킬을 모두 그대로 들인다 | 터미널과 가장 같다 | 개인 지침이 VIDE 지침과 충돌하고, 플러그인·스킬이 권한을 넓히며, PC마다 결과가 달라 검증·재현이 어렵다 |
| ③ 선택형 | 사용자가 설정에서 고른 외부 MCP 서버와 작업 폴더의 `AGENTS.md`만 켜고 나머지는 끈다 | 세 도구의 표준(프로젝트 범위·첫 사용 승인)과 같고, 필요한 도구만 들어온다 | 서버 목록·승인·턴 표시를 VIDE가 새로 만들어야 하고, 외부 MCP의 쓰기는 VIDE 되돌리기 밖이다 |

RESEARCH-18 §8 D1의 추천은 ③이었다.

## 결정

2026-10-19 사용자 결정(환경 방향 결정 브리프의 D1 답 ③; 브리프는 반영 뒤 삭제, Git 이력 `65d58b9a`).

1. **선택형 격리.** 사용자가 설정에서 고른 외부 MCP 서버(프로젝트 범위, 첫 사용 승인, 턴마다 켬·끔이 보임)와 작업 폴더의 `AGENTS.md`만 VIDE 턴에 들어간다.
2. **나머지는 계속 끈다.** 개인 `CLAUDE.md`, 공급자 플러그인·스킬, 전역 MCP 설정은 VIDE 턴에 들어가지 않는다.
3. **`AGENTS.md`는 자료다.** VIDE 지침·프로젝트 지시보다 아래에 놓이는 '자료'로 다루며 권한을 바꾸지 못한다(PRD §4.3). `AGENTS.md`가 VIDE 지침과 다르게 말하면 VIDE 지침이 이긴다. 작업 폴더의 `AGENTS.md`는 [ADR-042](ADR-042-workspace-folders.md) 3이 만드는 공용 진입문과 같은 파일이다.
4. **외부 MCP는 VIDE 도구 집합에 더해질 뿐 대신하지 않는다.** 호스트 다리(연결·Sync·`execute`·되돌리기)와 보호 동작 가드는 그대로이며, 외부 서버가 이를 우회하는 경로로 쓰이지 않게 한다. 세부 의미·실패는 SPEC-18.5가 소유한다.

## 결과·후속

- **SPEC:** SPEC-18.5(격리)가 서버 고르기·첫 사용 승인·턴 표시·`AGENTS.md`의 순위·실패 결과의 의미를 소유한다. SPEC-01.13 4·SPEC-02.19 3의 격리 문장은 SPEC-18.5를 가리키게 정렬한다.
- **ARCH:** ARCH-01 §2 격리 행이 공급자별 인자(Claude `--strict-mcp-config`·`--mcp-config`·`--setting-sources`, Codex `mcp_servers`·`project_doc_max_bytes` 등)의 물리 형식을 소유한다. 편집은 PLAN-55의 티켓에서 한다.
- **SPIKE 재확인:** [SPIKE ⑧](../tdd/SPIKE-2026-09-30-cli-session-resume.md)의 "상위 폴더 `CLAUDE.md`가 읽히지 않음"은 임시 cwd 시절 결과다. 작업 폴더가 cwd가 되고 `--safe-mode`·`--restricted`가 빠진 지금 프로젝트 폴더의 `CLAUDE.md`가 읽히는지 다시 확인하고, 읽히면 2항에 맞게 끈다.
- **고지:** 외부 MCP 서버가 한 쓰기는 VIDE 요청 단위 되돌리기 밖이다. 첫 사용 승인과 턴 표시에서 이를 알린다.
- **PLAN:** PLAN-55 T-372(외부 MCP 서버 고르기·승인·턴 표시)·T-373(`AGENTS.md` 수용과 SPIKE ⑧ 재확인).
- **판 갱신:** 격리 인자는 CLI 판에 매여 있으므로 [ADR-045](ADR-045-working-modes-and-project-start.md) 「같은 날 함께 내린 결정」의 판 갱신 절차(D4)에 이 인자의 확인이 들어간다.

### 약속하지 않는 것

- 개인 `CLAUDE.md`를 VIDE 지침에 병합하거나 우선순위를 섞지 않는다.
- 공급자 플러그인·스킬을 VIDE 턴에서 켜지 않는다. 건축 절차 지식을 넣을 자리는 RESEARCH-18 §9 3의 별도 조사 후보다.
- 전역 MCP 설정을 통째로 가져오지 않는다. 서버는 하나씩 고른다.

## 관련 문서

- [RESEARCH-18](../research/RESEARCH-18-environment-not-model.md) §3.4·§4.1·§5.1·§8 D1 — 근거와 선택지
- [ADR-022](ADR-022-direct-apply-plan-auto.md) — 격리의 원래 근거를 없앤 바로 적용
- [ADR-028](ADR-028-ai-cli-parity.md) · [ADR-031](ADR-031-stock-first.md) — CLI 동등성과 순정 우선
- [ADR-042](ADR-042-workspace-folders.md) — 작업 폴더와 `AGENTS.md`
- [ADR-045](ADR-045-working-modes-and-project-start.md) — 같은 날의 진행 방식 결정
- SPEC-18 「AI 작업 환경」 · PLAN-55 — 동작 의미와 작업
- OQ-15 — PRD 정체성 재서술(세 기둥 재구성·이름만 남음)
