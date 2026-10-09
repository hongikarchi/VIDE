# tools/persona — 비개발자 페르소나 드라이버 (PLAN-51 T-266, L1)

인턴 페르소나 AI가 엔진의 웹 UI를 **스크린샷만 보고** 한 단계씩 조작한다. 직관(①)·쉬움(②)을 대행 판정하는 도구이며, 결과의 실제 성공(⑤)은 판정하지 않는다(`reachedGoal`은 `null`로 두고 스코어카드·검수자가 화면 증거로 판단한다). 기준: [PLAN-51](../../docs/plans/PLAN-51-verify-loop.md) §1·§2.

## 파일

| 파일 | 역할 |
|---|---|
| `run.mjs` | Playwright로 UI를 열고 스크린샷 → 페르소나 → 행동 반복, `run.json`·`steps.jsonl`·`steps/NN.png` 기록 |
| `persona-step.mjs` | `personaStep()`(한 단계), `canaryStep()`(사전 점검), `parseStep()`·`canaryUnknown()` |
| `personas/intern.md` | 페르소나 시스템 프롬프트(건축사사무소 인턴) |
| `scenarios.json` | 시나리오 문장(사용자 원문)·전문가 최소 단계·목표 증거 |
| `persona-step.test.mjs` | 가짜 `claude`로 오프라인 왕복 시험: `node --test tools/persona/persona-step.test.mjs` |

## 사용

```sh
# 개발 엔진(npm run dev의 launch.json)
node tools/persona/run.mjs --scenario R1-HIDE --project <id> --launch-file .vide/dev-data/launch.json

# 설치 엔진(47821): 이름이 '검증 루프'로 시작하는 전용 프로젝트에서만 실행된다
node tools/persona/run.mjs --scenario R1-HIDE --project <검증 루프 R1의 id> --launch "<url#token>"
```

옵션: `--persona intern` · `--max-steps 12` · `--out .vide/persona/<stamp>-<scenario>` · `--claude <경로>`(기본 `claude`: `~/.local/bin/claude(.exe)`가 있으면 그것, 없으면 PATH) · `--headless` · `--no-fresh-conversation`(기본은 새 대화) · `--idle-timeout 600`(초).

**런 사이 격리(T-280).** 기본값으로 런마다 (1) 프로젝트의 `queued`·`running` 요청이 끝날 때까지 `GET /api/v1/projects/<id>/requests`를 2초마다 확인하고(`--idle-timeout`을 넘기면 런은 `untested`, 이유 `isolation: …`), (2) `POST /api/v1/projects/<id>/conversations {kind:'general'}`(화면의 [+] 탭과 같은 호출)로 새 대화를 만들어 `run.json`의 `conversation`에 적고, (3) 새 브라우저 컨텍스트의 `localStorage` `vide:conversation:<project>`에 그 id를 미리 넣어 UI가 그 탭을 연다(`src/ui/draft-storage.ts` lastConversation). 이 두 쓰기는 드라이버가 Node에서 하며 페이지 가드(`apiAllowed`)와는 별개다. **문서 격리는 운영자의 일이다:** 런마다 원본 사본(`.vide/loop/…`)을 새로 복사해 Link하고, 앞 런의 숨김·편집이 남은 문서를 다시 쓰지 않는다.

**설치 엔진 안전 수칙.** 설치 엔진은 재시작하지 않는다. 사용자 프로젝트는 쓰지 않고 `검증 루프 R1` 같은 전용 프로젝트만 쓴다. 설치 엔진과 사용자의 `npm run dev` 엔진은 포트가 아니라 포트·그 `launch.json`의 주소·자료 폴더로 판별하고(`tools/ab/stages.mjs` identifyEngine; 엔진은 임의 포트로 뜰 수 있다), 그 엔진에서는 이름이 `검증 루프`로 시작하지 않는 프로젝트를 거절한다. 모든 엔진에서 페이지의 API 호출은 GET과 `/api/v1/projects/<전용 프로젝트>/` 아래 쓰기, 화면 오류 보고(`POST /api/v1/diagnostics/client`)만 통과한다. 프로젝트 삭제·생성, 설정·계정·AccountSwitch·확장·연결기 변경, 다른 프로젝트로의 요청, `/shutdown`, `/host/*` 쓰기는 막고 `run.json`의 `blockedApi`에 남긴다. 단계마다 화면의 프로젝트(`#project-picker` 값, 없으면 `?project=`)를 읽어 바뀌면 `aborted`와 이유로 멈춘다. 호스트가 필요한 시나리오는 에이전트가 띄운 Rhino를 `.vide/` 사본으로 Link하고 끝나면 종료한다(AI.md §8). 페르소나는 UI가 할 수 있는 일을 모두 할 수 있으므로, 전용 프로젝트라도 실제 문서 변경이 일어날 수 있다는 전제로 사본만 연결한다.

## 동작

1. 엔진 세션: `POST /api/v1/session {token}`(Origin 헤더) → 쿠키를 **새 브라우저 컨텍스트**(저장소 없음, 1440x900)에 넣고 `/?project=<id>`로 연다.
2. canary: 페르소나에게 `VIDE·jig·Sync·Link가 무엇인지 아세요? 모르면 모른다고만 답하세요.`를 묻는다. 모른다고 답하지 않거나 뜻을 설명하면 런은 `untested`(미시험)로 끝난다.
3. 단계마다 스크린샷 → `personaStep()` → 행동 적용(click: 좌표 클릭 / type: 좌표가 있으면 먼저 클릭하고 입력, `submit:true`일 때만 Enter / wait: 5초) → 새로 나타난 `data-request-id` 수집 → `steps.jsonl` 한 줄. 화면 텍스트(`document.body.innerText`)에서 내부 용어를 센다.
4. `done`·`declare_stuck`·`--max-steps`에서 멈춘다. 다른 출처로 가는 페이지 이동은 막고 새 창은 닫는다.

## 출력 (PLAN-51 계약 5)

- `run.json`: `scenario, status(completed|driver-failed|aborted|untested), canary{asked, answeredUnknown}, steps, stuck, wrongClicks, unknownWords[], bannedWords[], requestIds[], typedInputs, reachedGoal(null), startedAt, endedAt, model` + 참고 필드(`stuckDeclared, stuckFlagged, noProgressPairs, goalReached(null), conversation, personaDone, reason, goal, expertSteps, goalEvidence, engine, project, engineKind(installed|dev|loop), blockedApi[]`).
  - `stuck` = `stuckDeclared`(`declare_stuck` 수) + `noProgressPairs`(PLAN-51 §2 '2단계 연속 무진전': 이웃한 두 단계가 모두 새 `data-request-id`를 만들지 않았고, 화면 텍스트(`innerText`의 sha256)가 같고, 행동 종류가 같은 쌍의 수).
  - `stuckFlagged` = 페르소나가 `stuck:true`로 적은 단계 수. `stuck`에 더하지 않고 따로 둔다. 스코어카드는 `stuck > 0` 또는 `stuckFlagged ≥ 2`를 P0로 본다. 이 필드가 없는 예전 런은 스코어카드가 `steps.jsonl`에서 센다.
  - `goalReached` = 운영자가 스크린샷을 읽고 손으로 적는 목표 도달 판정(`true`/`false`, 기본 `null`). 드라이버는 쓰지 않는다. 러너 기록 없이 페르소나만 돈 시나리오는 완료된 모든 런이 `goalReached: true`이고 막힘·내부 용어가 없을 때만 PASS가 되고, `null`이면 미시험, `false`면 P0다(`tools/ab/scorecard.mjs`).
  - `wrongClicks` = 페르소나가 `wrongTurn:true`로 적은 단계 수. `unknownWords`는 합집합.
  - `bannedWords` = `/SPEC-|PLAN-|JIG|hostUse|LINK_NOT_LIVE|세션|토큰|bake|overlay|handoff|stale/`의 서로 다른 일치(모든 단계 합집합).
- `steps.jsonl`: `{ step, at, screenshot, persona{sees, reads[], unknownWords[], action{type,x,y,text,submit?}, confidence, stuck, wrongTurn, done, evidence?}, visibleTextLength, textHash(앞 16자), requestIds[], ms }`.
- `steps/NN.png`: 단계별 스크린샷(행동 전 화면).

## Claude CLI에 이미지를 주는 방법 (조사 결과, Claude Code 2.1.292)

- 단계마다 **새 프로세스**를 빈 임시 cwd(`vide-persona-*`, 끝나면 삭제)에서 띄우고, `src/ai/claude-cli.ts` `cliArguments()`의 격리 인자(`-p --safe-mode --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources '' --no-session-persistence --no-chrome --disable-slash-commands --permission-mode dontAsk`)와 `--append-system-prompt <페르소나 파일>`을 준다. 환경 변수는 `subscriptionEnvironment()`처럼 `ANTHROPIC_`·`CLAUDE_CODE_`·`CLAUDE_AGENT_SDK_`·`CLAUDE_ENV_FILE`·`TYPESAFE_`를 뺀다.
- 도구가 없으므로(`--tools ''`) 파일 경로로는 그림을 못 읽는다. 이미지는 VIDE가 쓰는 방식(`ClaudeCli.inputOf`)대로 **stream-json 사용자 메시지의 `image` content block(base64 PNG)**으로 보낸다.
- `--input-format stream-json`은 `--output-format json`과 함께 쓸 수 없다(CLI 오류: `--input-format=stream-json requires output-format=stream-json`). 그래서 계약의 `--output-format json` 대신 `--output-format stream-json --verbose`를 쓰고 마지막 `{"type":"result"}` 이벤트의 `result` 문자열을 읽는다. 나머지 격리 인자는 그대로다.
- Windows에서 셸(`shell:true`)로 띄우면 빈 인자(`--tools ''`)가 사라져 인자가 밀리므로 셸 없이 실행 파일을 직접 띄운다.
- 답은 JSON 하나로 검증하고(코드 블록 표시는 벗김), 형식이 틀리면 이유를 붙여 한 번 다시 묻는다. 두 번 틀리면 그 런은 `driver-failed`.
- 2026-10-08 실측: canary 1회(`모릅니다. … 뜻을 모릅니다.` → `answeredUnknown:true`), 합성 레이어 화면 1단계(유효 JSON·좌표, 약 5 s, `claude-opus-5-5`).

## 한계

- 페르소나의 생각 시간(단계당 수 초)은 제품 속도에서 제외한다. 속도(④)는 `tools/ab`의 `request-stages`로 잰다.
- 브라우저의 웹 UI만 조작한다. 데스크톱 셸(WebView2 창)·Rhino 창은 조작하지 않는다.
- 스케치 드래그·키보드 단축키·스크롤은 행동에 없다(1회차 범위, PLAN-51 §6).
- 무진전 감지는 화면 텍스트만 비교한다. 글자는 같고 그림(뷰포트·색)만 바뀐 단계도 무진전으로 셀 수 있고, 시계처럼 저절로 바뀌는 글자가 있으면 세지 못한다.
- `wrongTurn`·`unknownWords`는 페르소나의 자기 보고이며 '대행 판정'이다. canary가 통과해도 모델이 용어를 짐작할 수 있다.
