---
id: SPIKE-2026-09-30-cli-session-resume
title: CLI 판 확인·캐시 토큰·세션 이어 실행 시험
status: review
version: 0.1
updated: 2026-09-30
owner: agent:claude
related: [PLAN-24, T-059, ADR-021, ARCH-01, SPEC-02, RESEARCH-10, FR-25]
---

# CLI 판 확인·캐시 토큰·세션 이어 실행 시험

[PLAN-24](../plans/PLAN-24-ai-conversations.md) T-059의 기록이다. [ADR-021](../decisions/ADR-021-conversation-sessions.md)의 SPIKE 표(0, ①~⑨)를 질문과 합격 기준까지 실행 전에 적고, 설치된 CLI에 합성 짧은 요청만 보내 확인한다. 프로젝트 자료·사용자 원본은 보내지 않는다.

## 질문과 합격 기준(실행 전)

| # | 질문 | 합격 기준 | 방법 |
|---|---|---|---|
| 0 | 실행 전 CLI 판 확인과 인증 방식 전환 신호 | 판 범위 밖이면 실행하지 않는다. `--bare` 실패 신호를 채집해 `CLI_MODE_CHANGED`로 분류한다 | 설치본 `--version`, `claude -p --bare` 실행(OAuth를 읽지 않아 모델 호출 없음), 빈 `CODEX_HOME`의 `codex exec`(인증 없음) |
| ① | 이어 실행 때 격리 인자를 다시 넘기면 매 턴 시작 이벤트의 도구·MCP 목록이 그 턴의 허용 목록과 같은가 | 3턴 연속 일치 | 세션 S1: 도구 없음 → vide MCP → 도구 없음, 턴마다 다른 빈 작업 폴더 |
| ② | 파일 도구를 준 턴에서 작업 폴더와 붙인 폴더 밖으로 나갈 수 없는가 | 밖 읽기 시도가 거부됨 | `--restricted --tools Read --allowedTools Read --add-dir <초안>`, 안·밖 합성 파일 읽기 |
| ③ | 다른 계정 프로필에서 같은 세션을 이어 갈 수 있는가 | 성공이나 실패가 재현됨 | 빈 `CLAUDE_CONFIG_DIR`에서 `--resume` |
| ④ | Codex `exec resume`에서 sandbox·MCP 설정이 적용되는가 | 읽기 전용과 그 턴에 허용한 MCP만 보임 | C1 단발(기록 켬) → C2 resume + vide MCP → C3 resume + MCP 없음, 기록 파일의 턴 문맥 확인 |
| ⑤ | 끊긴 턴 뒤 세션은 어떻게 되는가, 잃은 세션은 `--fork-session`으로 이어 갈 수 있는가 | 끊긴 턴이 결과를 만들지 않음. 포크가 새 ID로 앞 대화를 이어 받고 원 기록을 바꾸지 않음 | S1 4턴째를 시작 이벤트 직후 강제 종료, 5턴째 `--resume --fork-session --session-id <새 ID>` |
| ⑥ | 기록 삭제가 다른 대화에 영향을 주지 않는가 | 지운 대화만 이어 갈 수 없음 | S2 기록 파일 삭제 뒤 S2·S1 이어 실행 |
| ⑦ | 도구 없는 턴과 도구 있는 턴을 섞으면 도구·MCP 목록과 시스템 프롬프트가 턴 인자를 따르는가 | 턴마다 도구·MCP가 그 턴 인자와 같음. 프롬프트 반영 여부를 기록 | S1(`--system-prompt-snapshot off`)과 S2(기본값)에서 턴마다 다른 끝맺음 단어를 요구하는 시스템 프롬프트 |
| ⑧ | 붙인 초안 폴더와 그 상위, 작업 폴더 상위의 `CLAUDE.md`가 읽히는가 | 지시 파일 내용이 문맥에 없음. 읽히면 초안 폴더를 저장소 밖에 둔다 | 세 위치에 서로 다른 표식의 `CLAUDE.md`, 기록 파일에서 표식 검색 |
| ⑨ | 같은 작업을 단발+원장(A)과 이어 실행(B)으로 돌렸을 때 턴별 입력·캐시 토큰 | 5턴 대화의 수치 기록 | 합성 표(약 6천 토큰) 질문 5턴, 두 방식 |

## 방법·환경

- Windows 11, Node 24. Claude Code `~/.local/bin/claude.exe`, Codex는 `installedCodex()`가 고르는 npm 설치본.
- 인자는 제품 함수(`cliArguments()`, `configureAgentArguments()`, `codexArguments()`)의 결과에서 기록 끄기(`--no-session-persistence`, `--ephemeral`)만 뺀 것이다. 모델 호출은 비용을 줄이려고 Claude `haiku`, Codex 기본 모델 `low`로 했다.
- vide MCP는 시험용 최소 HTTP 서버(도구 `query` 하나, bearer 확인)다. 시험 도구는 저장소 밖 임시 위치에 두고 저장소에 넣지 않았다(아래 명령 참고).
- 공급자 기록은 이 시험이 만든 세션 ID의 파일만 읽고 시험 뒤 지웠다.

## 결과 요약

| # | 판정 | 요지 |
|---|---|---|
| 0 | 합격(구현) | 판 범위 밖이면 `--version` 한 번만 실행하고 거절, `--bare` 신호는 `CLI_MODE_CHANGED`. 실행 파일 경로 고정은 가능하나 구현하지 않음 |
| ① | 합격 | 3턴 연속, 시작 이벤트의 도구·MCP 목록이 그 턴의 인자와 같음 |
| ② | 합격 | 붙인 폴더 밖 읽기가 도구 오류로 거부됨 |
| ③ | 실패 재현 → 인계만 | 다른 프로필에서는 `No conversation found`, 모델 호출 없음 |
| ④ | 조건부 합격 | 턴마다 sandbox·MCP 설정이 적용됨. 단 첫 턴의 `developer_instructions`가 고정되므로 중립 지시가 필요하고, `exec resume`에는 `--sandbox`가 없음 |
| ⑤ | 합격 | 끊긴 턴은 결과를 만들지 않음. `--fork-session --session-id <새 ID>`가 앞 문맥을 이어 받고 원 기록을 바꾸지 않음 |
| ⑥ | 합격 | 지운 세션만 이어 갈 수 없음 |
| ⑦ | `off`로 합격 | 도구·MCP는 기본값에서도 턴 인자를 따름. 시스템 프롬프트는 기본값(on)이면 첫 턴 것이 고정, `off`면 턴마다 바뀜 |
| ⑧ | 합격 | 격리 인자로는 작업 폴더 상위·붙인 폴더·그 상위의 `CLAUDE.md`가 모두 읽히지 않음 |
| ⑨ | 한 종류 기록 | 도구 없는 5턴: 이어 실행은 2턴째부터 캐시 읽기, 단발+원장은 매 턴 캐시 생성 |

ADR-021 결정 7에 따른 T-061 적용: Claude 대화는 세션 이어 실행을 켤 수 있다(①②⑤⑥⑦ 합격, 매 턴 `--system-prompt-snapshot off` 또는 중립 프롬프트). 다른 계정으로 넘어가면 인계 자료로 새 세션을 연다(③). Codex는 ④가 조건부이므로, T-061이 중립 `developer_instructions`와 resume 인자 변환을 구현하고 같은 시험을 다시 통과하기 전까지 원장 방식을 유지한다.

## 결과 상세

실행: 2026-09-30, Claude Code 2.1.284, Codex CLI 0.157.1(npm). 실제 모델 호출은 Claude haiku 약 20회, Codex 기본 모델 `low` 약 9회이며 모두 합성 문장이다.

### 0. 판 확인과 로그인 방식 전환 신호

- **`--bare` 신호(모델 호출 없음).** `claude -p --bare --tools "" --output-format stream-json --verbose "ping"`는 exit 1로 끝난다.
  - 결과 이벤트: `is_error: true`, `subtype: "success"`, `terminal_reason: "api_error"`, `result: "Not logged in · Please run /login"`, 사용량 0
  - 어시스턴트 이벤트: `error: "authentication_failed"`, 모델 `<synthetic>`
  - 시작 이벤트의 `apiKeySource`는 bare 실행과 정상 구독 실행이 모두 `"none"`이라 전환 감지에 쓸 수 없다. `auth status`도 전환을 잡지 못하므로 실행 결과로 분류한다.
- **Codex 대응 신호(모델 호출 없음).** 빈 `CODEX_HOME`으로 `codex exec`를 실행하면 `error` 이벤트가 재연결을 반복한 뒤 `turn.failed`로 끝난다. 문구는 `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header`다.
- **분류.** `auth status`가 로그인을 보고한 직후의 실행에서 위 두 문구(`Not logged in`, `Missing bearer or basic authentication`)가 나오면 `CLI_MODE_CHANGED`로 멈춘다. 계정 자동 전환은 하지 않는다(다른 계정도 같은 이유로 실패한다). 토큰 만료 같은 일반 인증 오류는 문구가 달라 `PROVIDER_FAILED`로 남는다.
- **판 범위.** `src/ai/cli-compat.json`에 둔다.
  - Claude `>=2.1.284 <2.2.0`: 자동 갱신이 잦으므로 2.1대 갱신은 허용한다. 대신 위 신호 분류가 뒤를 받친다.
  - Codex `>=0.157.0 <0.158.0`: 검증한 0.157.1 한 줄이다. 판 번호의 prerelease(`0.158.0-alpha.*`)도 밖으로 본다.
  - `--version`은 실행 파일마다 60초 캐시한다. 판을 읽지 못하면(시간 초과·형식 불명) 같은 코드로 거절한다.
- **실제 확인.** 제품 `ClaudeCli`·`CodexCli`로 설치본을 실행해 판 확인(2.1.284, 0.157.1) 뒤 응답을 받았다. 설치돼 있는 옛 실행 파일(Codex 0.154.0-alpha.6.2, `~/.local/share/claude/versions/2.1.283`)로 실행하면 `--version` 한 번 뒤 `CLI_VERSION_UNSUPPORTED`로 거절했다. 로그인 확인과 모델 실행은 일어나지 않았다.
- **경로 고정.** Claude 설치본은 `~/.local/share/claude/versions/<판>`에 판별 실행 파일을 두고, 확장자 없는 이 파일도 실행할 수 있다. 다만 설치 프로그램이 최근 몇 판만 남기므로(확인 시 2.1.281·283·284) 고정하면 정리될 때 끊긴다. 실행 경로는 `src/server/execution.ts`가 정하므로 이 티켓에서 바꾸지 않았다.

### ①⑦ 이어 실행의 도구·MCP·시스템 프롬프트

세션 S1은 `--system-prompt-snapshot off`를 쓰고 턴마다 새 빈 작업 폴더에서 실행했다.

| 턴 | 인자 | 시작 이벤트 도구 / MCP | 끝맺음(요구) | 응답 |
|---|---|---|---|---|
| 1 `--session-id` | 도구 없음(`--safe-mode`) | `[]` / `[]` | ALPHA(ALPHA) | OK |
| 2 `--resume` | vide MCP(`--restricted`) | `mcp__vide__query` / `vide: connected` | BETA(BETA) | 도구 1회 호출, nonce 반환 |
| 3 `--resume` | 도구 없음 | `[]` / `[]` | ALPHA(ALPHA) | 1턴 코드 단어와 2턴 nonce를 모두 기억 |

세션 S2는 기본값(snapshot on)이다. 2턴째에 vide MCP 인자와 BETA 프롬프트를 넘겼더니 도구·MCP 목록은 턴 인자를 따랐지만 응답은 1턴의 ALPHA로 끝났다. 기본값에서는 도구 있는 턴이 도구 없는 턴의 시스템 프롬프트("Do not use tools")로 돈다. 따라서 매 턴 `--system-prompt-snapshot off`를 넘기거나 중립 프롬프트를 써야 한다.

- 모든 턴의 `permissionMode`는 `dontAsk`였다.
- `--safe-mode` 턴에서도 `plugins` 2개(내장)가 보였고, 도구·MCP·슬래시 명령은 0이었다.

### ② 파일 도구의 폴더 경계

- 인자: `--restricted --tools Read --allowedTools Read --add-dir <초안>`, 작업 폴더는 빈 `wk`
- 초안 안의 파일 읽기는 성공했다.
- 밖의 파일은 도구 결과 오류 `…outside.txt is outside …\wk, …\drafts\d1`로 거부됐고, 기록에도 내용이 남지 않았다.

### ③ 다른 계정 프로필

빈 `CLAUDE_CONFIG_DIR`로 `--resume <S1>`을 실행하면 stderr `No conversation found with session ID: …`, exit 1이다. 결과 이벤트는 `error_during_execution`, 사용량 0이다. 세션 기록은 프로필별(`<설정 폴더>/projects/…/<ID>.jsonl`)이므로 다른 계정에서는 이어 갈 수 없다. 인계 자료로 새 세션을 연다. T-061은 이 문구를 '세션 잃음'으로 분류해야 한다(지금은 `PROVIDER_FAILED`).

### ④ Codex `exec resume`

- `codex exec resume`에는 `--sandbox` 옵션이 없다. 같은 값을 `-c sandbox_mode="read-only"`로 넘긴다. 나머지 격리 인자(`--ignore-user-config`, `--ignore-rules`, `-c …`, `--disable …`)는 받는다. 기록을 남기려면 `--ephemeral`을 뺀다.
- 기록 파일(`~/.codex/sessions/…/rollout-…-<ID>.jsonl`)의 턴 문맥에서 세 턴 모두 `sandbox_policy: read-only`, `approval_policy: never`, 그 턴의 작업 폴더가 확인됐다.
- **developer_instructions는 첫 턴 것이 고정된다.** 제품의 도구 없는 지시("Do not invoke tools…")로 시작한 세션은 이렇게 됐다.
  - 2턴째에 vide MCP를 붙이면 MCP 서버에는 연결(HTTP 3회)되지만 모델이 "I can't call tools in this session"이라며 도구를 부르지 않는다.
  - 같은 MCP 인자로 새 단발 실행(대조)을 하면 도구를 1회 불렀다.
- **중립 지시로 시작하면 통한다.** 첫 턴부터 도구 유무를 말하지 않는 `developer_instructions`를 쓰고 '이번 턴 규칙'을 사용자 문장에 넣었다.
  - 2턴째(vide MCP): 도구 1회 호출, 1턴 코드 단어를 기억했다.
  - 3턴째(`mcp_servers={}`): MCP 연결 0회, 모델은 도구 없음(NONE)으로 답했다.
- 한계: Codex 이벤트에는 시작 시 도구 목록이 없어 '허용 MCP만 보임'은 서버 연결 횟수와 모델 응답으로만 확인했다.
- **사용량 주의:** `exec resume`의 `turn.completed.usage`는 그 턴이 아니라 세션 누적값이다(예: 입력 9,281 → 19,510 → 29,194). 턴별 값은 기록 파일의 `last_token_usage`에만 있다.
- 0.157.1은 `-c tools.view_image=false`를 모르는 설정으로 무시한다고 경고한다(`--disable view_image`는 유지). 해가 없어 인자는 그대로 두었다.

### ⑤ 끊긴 턴과 포크

- S1 4턴째를 시작 이벤트 직후 강제 종료했다. 결과 이벤트는 없었고, 세션 기록에는 그 턴의 사용자 문장이 답 없이 추가됐다(37 → 42줄).
- 5턴째에 `--resume <S1> --fork-session --session-id <새 ID>`를 실행했다.
  - 시작 이벤트의 세션 ID가 지정한 새 ID였다.
  - 1턴의 코드 단어를 기억했다.
  - 원 기록의 줄 수는 42 → 42로 바뀌지 않았다.
- 따라서 종료를 확인하지 못한 세션은 다시 쓰지 않고, 새 ID를 VIDE가 정해 포크하거나 인계 자료로 새로 연다.
- 늦게 온 결과를 무시하는 것은 제품 쪽 규칙이며, 기존 단위 시험(취소 뒤 `stopped`, `STOP_UNCONFIRMED`)이 지킨다.

### ⑥ 기록 삭제

S2의 기록 파일을 지운 뒤 `--resume <S2>`는 `No conversation found`(모델 호출 없음)였고, 이어서 S1의 포크는 성공했다.

- 이어 실행한 턴은 작업 폴더가 달라도 **첫 턴 작업 폴더 이름의 프로젝트 폴더에 있는 원 파일**에 이어 적힌다(S1은 턴 세 번·작업 폴더 세 곳에서도 파일 1개).
- 포크는 포크한 턴의 작업 폴더 이름으로 새 폴더를 만든다.
- 매 턴 새 임시 작업 폴더를 쓰면 세션마다 `projects/` 아래 폴더가 하나씩 생긴다. 기록 삭제는 `projects/*/<ID>.jsonl`로 찾아 지우고 빈 폴더도 지워야 한다.

### ⑧ 지시 파일

- 배치: 작업 폴더 상위(`MARK-ROOT`), 초안 폴더의 상위(`MARK-PARENT`), 초안 폴더(`MARK-DRAFT`)에 각각 `CLAUDE.md`를 두었다.
- 격리 인자(`--restricted --setting-sources ""` + `--add-dir <초안>`)로 실행했더니 모델 답과 세션 기록 어디에도 표식이 없었다.
- 대조로 격리 인자 없이 실행하면 작업 폴더 상위의 `MARK-ROOT`만 읽혔다. `--add-dir` 폴더와 그 상위의 `CLAUDE.md`는 기본값에서도 읽히지 않았다.
- 제품 인자에서는 초안 폴더가 저장소 안에 있어도 지시 파일로 읽히지 않는다. 금지 파일 검사는 방어선으로 유지한다.

### ⑨ 턴별 입력·캐시 토큰(도구 없는 5턴, haiku, 합성 표 약 6.6천 토큰)

A는 턴마다 단발 + 원장(표를 매번 싣고 앞 문답을 원장으로), B는 1턴에만 표를 싣고 이어 실행이다. Claude의 `input_tokens`는 캐시 밖 부분만 센다.

| 턴 | A 입력 / 캐시 읽기 / 캐시 생성 | B 입력 / 캐시 읽기 / 캐시 생성 |
|---|---|---|
| 1 | 10 / 0 / 6,638 | 10 / 0 / 6,638 |
| 2 | 10 / 0 / 6,690 | 10 / 6,638 / 251 |
| 3 | 10 / 0 / 6,720 | 10 / 6,889 / 321 |
| 4 | 10 / 0 / 6,753 | 10 / 7,210 / 314 |
| 5 | 10 / 0 / 6,772 | 10 / 7,524 / 301 |
| 합 | 50 / 0 / 33,573 | 50 / 28,261 / 7,825 |

- A가 캐시를 한 번도 읽지 못한 것은 요청 자료가 `{goal, revision, items}` 순서라 매번 바뀌는 문장(원장 + 질문)이 표보다 앞에 오기 때문이다. 원장 방식에서도 변하지 않는 자료를 앞에 두면 캐시를 다시 쓸 수 있다(T-061 참고).
- 누적 이력이 짧은 이 규모에서는 B가 유리하다. 새 세션 기준(12턴·누적 150k)의 조정은 실제 도구 턴을 포함한 두 번째 종류를 T-061의 '5턴 대화 2종' 기록에서 잰 뒤로 미룬다.
- Codex 이어 실행은 위 ④의 누적 사용량 문제 때문에 이 표에 넣지 않았다.

## 제품 반영(T-059)

- `src/ai/cli-compat.json`: 검증한 판 범위
- `src/ai/claude-cli.ts`
  - 실행 전 판 확인 `checkVersion()`(60초 캐시): `CLI_VERSION_UNSUPPORTED`이고 오류에 `version`·`supported`를 붙인다
  - `MODE_CHANGED` 분류 `CLI_MODE_CHANGED`
  - 사용량 `cacheReadTokens`·`cacheCreationTokens`: Claude `cache_read_input_tokens`·`cache_creation_input_tokens`, Codex `cached_input_tokens`·`cache_write_input_tokens`
  - `CodexCli`는 상속으로 같은 처리를 받는다
- 시험: `tests/ai/claude-cli.test.mjs`, `tests/ai/codex-cli.test.mjs`(범위 밖·읽을 수 없는 판 거절, 캐시, bare·401 신호, 캐시 토큰)
- 화면 문구: 두 오류 코드의 한국어 안내는 `src/ui/gateway.ts`의 `errors`에 추가해야 한다(이 티켓의 수정 범위 밖). 추가 전까지 작업 카드에는 코드가 그대로 보인다.

## 남은 일과 관찰

- **T-061**
  - `--system-prompt-snapshot off`(또는 중립 프롬프트)
  - `No conversation found`를 세션 잃음으로 분류
  - 포크 때 새 ID 지정
  - 기록 삭제 때 빈 `projects/` 폴더 정리
  - Codex 누적 사용량 처리와 중립 `developer_instructions`
- **환경 변수.** 에이전트 안에서 띄운 개발 엔진은 `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`를 물려받는다. 지금의 `subscriptionEnvironment()`는 이 셋을 지우지 않는다. 설치본 엔진에는 해당하지 않지만, 개발 모드 격리를 위해 지울지 판단이 필요하다. 이 시험에서는 직접 지우고 실행했다.
- **시험 도구의 위치.** 시험 스크립트는 공유 작업 트리의 소유 범위 때문에 저장소 밖 임시 위치에서 실행했다.
  - 인자는 위 제품 함수에서 만들었다.
  - vide MCP는 JSON-RPC `initialize`·`tools/list`·`tools/call`만 답하는 최소 HTTP 서버다.
  - 재현하려면 `tools/spikes/2026-09-30-cli-session-resume/`에 옮겨 둔다.
- **정리.** 이 시험이 만든 Claude 세션 기록(5개)과 빈 프로젝트 폴더, Codex 기록 파일(2개), 임시 폴더는 시험 뒤 지웠다. Codex가 `CODEX_HOME`의 상태 DB에 남기는 스레드 색인은 지우지 않았다.
