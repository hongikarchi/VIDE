---
id: ADR-025
title: AI 구독 계정 관리는 AccountSwitch가 맡는다
status: approved
version: 0.2
updated: 2026-10-01
owner: user
related: [FR-08, FR-18, AC-47, SPEC-02, ARCH-01, PLAN-06, PLAN-13, PLAN-24, PLAN-25, ADR-021]
---

# AI 구독 계정 관리는 AccountSwitch가 맡는다

## 맥락

VIDE에는 Claude Code·Codex CLI의 구독 계정을 여러 개 등록해 쓰는 기능이 있다([PLAN-06](../plans/PLAN-06-cli-account-profiles.md)·[PLAN-13](../plans/PLAN-13-multi-account.md), [SPEC-02.18](../specs/SPEC-02-execution-candidates.md)). 계정마다 CLI 설정 폴더를 따로 두고(`CLAUDE_CONFIG_DIR`·`CODEX_HOME`), 로그인·사용량·자동 전환을 VIDE 화면에서 하며, 대화는 시작 때 고른 계정으로 고정하고 한도에 걸리면 다른 계정의 새 세션으로 인계한다([ADR-021](ADR-021-conversation-sessions.md), [PLAN-24](../plans/PLAN-24-ai-conversations.md) T-061).

2026-09-29 이 기능을 다른 사람과 나누려고 독립 프로그램 [AccountSwitch](https://github.com/hongikarchi/AccountSwitch)로 분리했고, 이후 계정 코드의 원본은 AccountSwitch다. AccountSwitch는 고른 계정의 로그인을 `~/.claude`·`~/.codex`(기본 로그인)로 옮겨 터미널·VS Code·VIDE가 모두 그 계정을 쓰게 하고, 자체 자동 전환을 가진다. 두 프로그램을 함께 쓰면 계정 전환·자동 전환이 두 곳에 생겨 어느 계정이 쓰이는지 알기 어렵고, 같은 코드를 두 곳에서 고쳐야 한다.

## 결정 (2026-09-30 사용자)

1. 계정 추가·로그인·로그아웃·제거·이름 변경·전환·자동 전환은 AccountSwitch에서만 한다. VIDE에서는 이 기능을 뺀다.
2. VIDE는 각 CLI의 기본 로그인만 쓴다. 어떤 계정이 쓰이는지는 AccountSwitch(또는 사용자가 터미널에서 한 로그인)가 정한다.
3. 두 계정을 동시에 쓰는 것(대화마다 다른 계정)은 지원하지 않는다. 한 PC에서 한 공급자는 한 번에 한 계정을 쓰고, 동시에 진행하는 대화도 그 계정을 함께 쓴다.
4. 빼는 작업은 이 기능과 얽힌 문서·코드를 고치고 있는 다른 세션의 작업(PLAN-24 대화 세션 등)이 끝난 뒤 한다. 그때까지 VIDE는 기본 로그인을 쓰고 VIDE 자동 전환은 끈 채로 둔다.

VIDE가 계정 한도·현재 계정을 어떻게 알리는지 같은 세부는 [PLAN-25](../plans/PLAN-25-accounts-to-accountswitch.md)와 그 작업에서 고칠 SPEC이 정한다.

## 선택지

| | A. 둘 다 유지 | B. VIDE는 계정별 폴더만 유지 | **C. AccountSwitch로 모음(채택)** |
|---|---|---|---|
| 계정 전환 | 두 곳 | AccountSwitch, VIDE는 폴더 선택만 | AccountSwitch 한 곳 |
| 동시 사용 | 가능 | 가능 | 불가 |
| 코드 중복 | 전부 | 로그인·폴더 관리 | 없음 |
| 헷갈림 | 큼(자동 전환 둘) | 중간(대화마다 계정) | 없음(모든 도구가 같은 계정) |

동시 사용은 지금 필요하지 않아(사용자, 2026-09-30) C를 골랐다. 나중에 필요하면 AccountSwitch의 계정 폴더가 곧 CLI 설정 폴더이므로 VIDE가 그 폴더를 가리키는 방식(B)으로 되돌릴 수 있다.

## 영향

- AccountSwitch가 없는 사용자는 CLI에 로그인한 한 계정으로 그대로 쓴다.
- 대화의 공급자·모델 고정은 그대로다. 계정은 대화에 고정하지 않고 턴마다 그때의 기본 로그인을 쓴다.
- 계정 한도로 끝난 턴은 지금처럼 자동으로 다시 보내지 않는다. 다른 계정으로 바꾸는 일은 AccountSwitch가 한다.
- 고칠 정본: SPEC-02.17(대화의 계정 고정)·SPEC-02.18(구독 계정 프로필)·SPEC-02.19(계정 전환 카드), ARCH-01 「CLI 기본 로그인 실행 경계」, Design의 설정 → AI 화면, PRD의 계정 관련 문장 확인. PLAN-06·PLAN-13의 계정 관리 부분은 이 ADR로 대체된다.
