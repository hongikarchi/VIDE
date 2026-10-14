# tools/persona — 비개발자 페르소나 드라이버 (PLAN-51 T-266, L1)

인턴 페르소나 AI가 엔진의 웹 UI를 **스크린샷만 보고** 한 단계씩 조작한다. 직관(①)·쉬움(②)을 대행 판정하는 도구이며, 결과의 실제 성공(⑤)은 판정하지 않는다(`reachedGoal`은 `null`로 두고 스코어카드·검수자가 화면 증거로 판단한다). 기준: [PLAN-51](../../docs/plans/PLAN-51-verify-loop.md) §1·§2.

## 파일

| 파일 | 역할 |
|---|---|
| `run.mjs` | Playwright로 UI를 열고 스크린샷 → 페르소나 → 행동 반복, `run.json`·`steps.jsonl`·`steps/NN.png` 기록 |
| `persona-step.mjs` | `personaStep()`(한 단계), `canaryStep()`(사전 점검), `parseStep()`·`canaryUnknown()` |
| `personas/intern.md` | 페르소나 시스템 프롬프트(건축사사무소 인턴) |
| `scenarios.json` | 시나리오 문장(사용자 원문)·연결할 호스트(`hosts`)·열릴 jig(`jigs`)·운영자 정보(`operator`)·전문가 최소 단계·목표 증거 |
| `persona-step.test.mjs` | 가짜 `claude`로 오프라인 왕복 시험: `node --test tools/persona/persona-step.test.mjs` |
| `isolation.mjs` · `isolation.test.mjs` | jig 작업본·대화 격리(T-280)와 요청별 CLI `resume` 읽기, 가짜 엔진 API 시험: `node --test tools/persona/isolation.test.mjs` |
| `host-link.ps1` · `host-link.lib.ps1` | 사본을 Rhino 8·ZWCAD 2023에 열고 VIDE 프로젝트에 무인 Link(T-286, 아래 '호스트 구성') |
| `host-link.test.ps1` · `host-link.test.mjs` | `host-link`의 순수 함수·구문 시험(호스트 없음): `node --test tools/persona/host-link.test.mjs` |
| `strip-link-id.md` | 연결 ID(ADR-030)가 없는 사본을 만들고 확인·제거하는 방법 |

## 사용

```sh
# 개발 엔진(npm run dev의 launch.json)
node tools/persona/run.mjs --scenario R1-HIDE --project <id> --launch-file .vide/dev-data/launch.json

# 설치 엔진(47821): 이름이 '검증 루프'로 시작하는 전용 프로젝트에서만 실행된다
node tools/persona/run.mjs --scenario R1-HIDE --project <검증 루프 R1의 id> --launch "<url#token>"
```

옵션: `--persona intern` · `--max-steps 12` · `--out .vide/persona/<stamp>-<scenario>` · `--claude <경로>`(기본 `claude`: `~/.local/bin/claude(.exe)`가 있으면 그것, 없으면 PATH) · `--headless` · `--no-fresh-conversation`(기본은 새 대화) · `--no-fresh-jigs`(기본은 jig 작업본·대화 격리, 아래) · `--logs <엔진 logs 폴더>`(요청별 CLI 시작 읽기; 기본은 launch 파일 옆 `logs`, `--launch`면 알아본 엔진의 자료 폴더 `logs`) · `--idle-timeout 600`(초) · `--answers '<JSON>'` 또는 `--answers <파일.json>`(운영자 정보, 시나리오의 `operator` 위에 덮음) · `--no-host-check`(호스트 확인 생략, 개발용).

## 호스트 구성과 운영자 정보 (T-286)

**라운드 2 오염.** 라운드 2는 페르소나 런 전에 Rhino 사본과 CAD 사본을 함께 연결했다. 그래서 Rhino 대상 시나리오(R1-HIDE·D·C·B)의 AI 요청 5건이 모두 `host: zwcad`로 갔고, 레이어 칩·S-06·법규 체크·사이트 모델링도 ZWCAD 도면을 기준으로 삼았다. 또 CAD 사본에 남은 다른 프로젝트의 연결 ID 때문에 `실사용 검증 20261007`의 Link 경로가 바뀌었다([VERIFY 라운드 2](../../docs/tdd/VERIFY-2026-10-09-loop-round-2.md) '방법상 한계'). R1-B는 페르소나가 대지 주소를 몰라 막혔다.

**`hosts`.** 시나리오마다 연결할 호스트를 적는다: R1-HIDE·R1-D·R1-C·R1-B는 `["rhino"]`, R1-A는 `["rhino","zwcad"]`. 드라이버는 canary 전에 `GET /api/v1/projects/<id>/links`를 읽어, 연결이 열린 행(`connection`이 있는 호스트 행, 파일 행 제외)이 정확히 그 호스트들인지 본다. 목록 밖의 호스트가 열려 있거나 목록의 호스트가 열려 있지 않으면 런은 `untested`이고 `reason`이 `hosts: …`로 시작한다. 결과는 `run.json`의 `hosts`·`hostCheck{ok, reason?, open[]}`에 남는다. 그래서 운영자는 시나리오 묶음마다 연결을 맞춘다: Rhino만 쓰는 네 런을 먼저 돌리고, R1-A 전에 CAD를 연결한다(닫힌 연결 행은 상관없다).

**운영자 답(`ask_operator`).** 인턴은 실무 사실(대지 주소, 프로젝트 이름처럼 선배에게 물을 만한 것)을 모르면 행동 `{"type":"ask_operator","field":"address","question":"…"}`을 고른다. `field`는 영어 소문자 키다(`^[a-z][a-z0-9_]{0,39}$`). 화면을 어떻게 쓰는지는 묻지 않는다(`personas/intern.md` 규칙 11). 드라이버는 화면을 건드리지 않고 시나리오의 `operator`(R1-B: `address` = `서울특별시 중구 태평로1가 31`)에 `--answers`를 덮은 값에서 답한다. 없는 키는 `answer: null`(`reason: 'unknown'`), 한 런에 5번을 넘으면 `reason: 'limit'`이다. 답은 그 단계의 `steps.jsonl` `operatorAnswers[]`와 `run.json`의 `operatorAnswers[]`(`step, field, question?, answer, reason?`)에 남고, 다음 단계부터 프롬프트의 '선배에게 물어서 들은 것'에 계속 실린다(지난 3단계 요약 밖으로 밀려나도). 답을 받은 단계는 무진전 쌍으로 세지 않는다. 운영자 답이 있으면 '주소를 사람이 쳤다'는 뜻이므로 R1-B는 PLAN-51 §3 기준 P2 후보로 본다.

**`host-link.ps1` — 사본 열기와 무인 Link.** Windows PowerShell 5.1, UI Automation(`System.Windows.Automation`).

```powershell
# 설치 엔진 주소·토큰은 설치본의 launch 링크, 개발 엔진은 (Get-Content <자료>\launch.json | ConvertFrom-Json).url
powershell -NoProfile -ExecutionPolicy Bypass -File tools\persona\host-link.ps1 -Host rhino -Document .vide\loop\r3\a\small.3dm -Project '검증 루프 R1' -Launch '<url#token>'
powershell -NoProfile -ExecutionPolicy Bypass -File tools\persona\host-link.ps1 -Host zwcad -Document .vide\loop\r3\a\cad\cad.dwg -Project '검증 루프 R1' -Launch '<url#token>'
powershell -NoProfile -ExecutionPolicy Bypass -File tools\persona\host-link.ps1 -Close -Host rhino     # 띄운 호스트를 저장 없이 닫음
```

- **Rhino:** `Rhino.exe /nosplash /runscript="_-RunPythonScript (check.py) _VIDELink" <사본>`. `check.py`가 문서의 연결 ID 항목을 `stored-links.json`에 적고(다른 문서에서 돌았으면 거절), `_VIDELink`의 프로젝트 선택 창('VIDE에 연결 · <문서>')에서 이름이 같은 프로젝트를 골라 [Link]를 누른다. 두 번째 창('VIDE 연결 · <문서>', '닫힌 연결 파일이 있습니다' 또는 사본 경우)이 뜨면 '새 연결 파일로 추가' → [연결].
- **ZWCAD:** `ZWCAD.exe <사본>`. XREF·SHX 누락 창은 '무시하고 계속'. COM(`ZWCAD.Application.2023`)으로 도면이 열린 것과 `VIDE_LINKS`를 확인하고, ZWCAD를 앞으로 가져온 뒤 다른 PowerShell 프로세스에서 `SendCommand('VIDECADLink ')`를 보낸다(모달 창이 떠 있는 동안 `SendCommand`가 막히므로). 대화창 처리는 Rhino와 같다.
- 그 뒤 `GET …/links`를 2초마다 읽어 이 사본의 행(같은 호스트, 연결 열림, 같은 경로 또는 파일 이름)이 Link 뒤 첫 Sync를 마칠 때까지 기다린다(`-SyncTimeoutSec 600`; ZWCAD `cad.dwg` 첫 Sync는 라운드 2에 151 s). 행에 `lastError`가 생기면 실패다.
- 출력(표준 출력, JSON 한 줄): `ok, host, document, project{id,name}, pid, storedLinkEntries[], strippedLinkEntries[], choice{reason: closed|copy, picked: new}|null, linkId, firstSync{requestId, at, ms}, timings{openMs, projectDialogMs, choiceDialogMs?, linkedMs, firstSyncMs, totalMs}(실행부터 ms), otherProjectLinksChanged[], state, reason`. 진행 기록은 표준 오류. 런 폴더 `.vide/persona/host-link/<시각>-<host>/`에 `state.json`(pid·시작 시각)·`check.py`·`stored-links.json`.
- **거절(exit 2):** 사본이 `<저장소>\.vide\` 밖(AI.md §8), 같은 호스트가 이미 실행 중(사용자가 작업 중일 수 있음), 프로젝트 이름이 `검증 루프`로 시작하지 않음(개발 엔진에서는 `-AnyProject`), 같은 이름의 프로젝트가 둘 이상, **문서에 다른 프로젝트의 연결 ID가 있음**(이때는 아무것도 연결하지 않고 호스트를 저장 없이 닫는다; `-StripLinkId`는 열린 문서에서만 그 항목을 지우고 진행). **exit 3:** 연결은 됐으나 그 사이 다른 프로젝트의 Link 행이 바뀜(`otherProjectLinksChanged`, `-SkipOtherProjects`로 생략). 되돌리기는 사용자 결정이다. **exit 1:** 시간 초과·VIDE 오류 창·첫 Sync 실패 등. 호스트는 살펴볼 수 있게 열어 두므로 `-Close`로 닫는다.
- 첫 Sync가 끝나면 `-Visible`이 없을 때 호스트 창을 최소화한다. 대화창 조작에는 창이 보여야 하므로 숨긴 채 띄우지는 않는다. 진행 중에는 호스트를 앞으로 가져오며(ALT 한 번 + `SetForegroundWindow`), 그동안 키보드·마우스를 쓰지 않는다.
- `-Close`는 이 스크립트가 띄운 프로세스(pid와 시작 시각이 `state.json`과 같을 때만)를 `Stop-Process`로 닫는다. 사본이므로 저장하지 않는다. 닫은 뒤 `Get-Process Rhino,ZWCAD`로 확인한다.
- **한계(2026-10-14):** 실호스트 시험은 하지 않았다(pending). 순수 함수·구문은 `host-link.test.mjs`로 확인했다. 개발 엔진(`tools/ab/host-session.mjs --no-host`)으로는 시험할 수 없다: 사용자가 띄운 Rhino의 설치 플러그인은 설치 엔진에만 붙는다. Eto(WPF) 목록 항목의 UI Automation 이름은 실물에서 확인하지 않아, 항목 이름과 안쪽 글자를 모두 비교한다. ZWCAD의 COM `Dictionaries`·`VIDE_LINKS` 열거도 실물 미확인이다(읽은 개수가 사전 개수보다 적으면 거절). 라운드 3 첫 Link에서 함께 확인한다.
- **사본은 연결 ID가 없는 원본에서 만든다:** [strip-link-id.md](strip-link-id.md).

**런 사이 격리(T-280).** 기본값으로 런마다 (1) 프로젝트의 `queued`·`running` 요청이 끝날 때까지 `GET /api/v1/projects/<id>/requests`를 2초마다 확인하고(`--idle-timeout`을 넘기면 런은 `untested`, 이유 `isolation: …`), (2) `POST /api/v1/projects/<id>/conversations {kind:'general'}`(화면의 [+] 탭과 같은 호출)로 새 대화를 만들어 `run.json`의 `conversation`에 적고, (3) 새 브라우저 컨텍스트의 `localStorage` `vide:conversation:<project>`에 그 id를 미리 넣어 UI가 그 탭을 연다(`src/ui/draft-storage.ts` lastConversation). 이 두 쓰기는 드라이버가 Node에서 하며 페이지 가드(`apiAllowed`)와는 별개다. (4) **jig 격리(`--fresh-jigs`, 기본 켬, 2026-10-14):** 라운드 3에서 jig로 간 요청 3건(R1-D·C·B)이 모두 `resume: true`였다. 제품 규칙대로(SPEC-07.18 3의 1 '마지막 작업본 재사용', SPEC-02.19 1의 묶기) 앞 라운드의 작업본과 거기에 묶인 열린 대화를 다시 썼기 때문이다(R1-D: '새 세션 제안 4턴 · 누적 98.6만 토큰'). 제품 규칙은 바꾸지 않고, 드라이버가 런 전에 시나리오의 `jigs`(예: R1-D `["project/s06-frame"]`)마다 전용 프로젝트 안에서만 (a) `GET …/skills`로 그 jig를 찾고, (b) 그 jig 작업본(`GET …/jig-instances`)에 묶인 열린 대화를 `POST …/conversations/<id>/close`로 닫고(기록은 남음; 닫을 수 없는 기본 대화는 `…/unbind`로 묶음만 푼다), (c) skill 시작과 같은 호출 `POST …/jig-instances {jig, version, title:'작업본 <n>', layerRootLater:true}`로 새 작업본을 만들어 마지막 작업본이 되게 한다. 그래서 런의 jig 시작은 새 작업본을 열고 새 대화에 묶인다. 결과는 `run.json`의 `isolation{status: full|partial|none|off, jigs[{jig, kind, reuse, previousWorkbooks[], freshWorkbook, latestIsFresh, closedConversations[], unboundConversations[], errors[]}], limits[]}`에 남는다. 레거시 jig(`sync`)는 작업본·묶인 대화가 없어 할 일이 없다. jig가 목록에 없거나 쓰기가 실패하면 `partial`이고 런은 계속한다. **한계:** 작업본을 보관·삭제하는 API가 없어 앞 런의 작업본은 프로젝트에 그대로 남는다(목록에 보이고, 거기서 확정한 대지 주소는 SPEC-12.3의 6대로 프로젝트 주소로 계속 쓰인다). (5) 런이 끝나면 `requestIds`마다 엔진 로그의 `cli-start`(`src/ai/cli-log.ts`)를 읽어 `run.json`의 `cliSessions[{requestId, cliStarts, resume, provider, model}]`에 적는다. CLI 세션 id는 로그에 남지 않으므로(인자를 쓰지 않음) 적지 않는다. 유지되는 CLI 프로세스를 다시 쓴 턴은 `cli-start`가 없어 `resume: null`일 수 있다. **문서 격리는 운영자의 일이다:** 런마다 원본 사본(`.vide/loop/…`)을 새로 복사해 Link하고, 앞 런의 숨김·편집이 남은 문서를 다시 쓰지 않는다.

**설치 엔진 안전 수칙.** 설치 엔진은 재시작하지 않는다. 사용자 프로젝트는 쓰지 않고 `검증 루프 R1` 같은 전용 프로젝트만 쓴다. 설치 엔진과 사용자의 `npm run dev` 엔진은 포트가 아니라 포트·그 `launch.json`의 주소·자료 폴더로 판별하고(`tools/ab/stages.mjs` identifyEngine; 엔진은 임의 포트로 뜰 수 있다), 그 엔진에서는 이름이 `검증 루프`로 시작하지 않는 프로젝트를 거절한다. 모든 엔진에서 페이지의 API 호출은 GET과 `/api/v1/projects/<전용 프로젝트>/` 아래 쓰기, 화면 오류 보고(`POST /api/v1/diagnostics/client`)만 통과한다. 프로젝트 삭제·생성, 설정·계정·AccountSwitch·확장·연결기 변경, 다른 프로젝트로의 요청, `/shutdown`, `/host/*` 쓰기는 막고 `run.json`의 `blockedApi`에 남긴다. 단계마다 화면의 프로젝트(`#project-picker` 값, 없으면 `?project=`)를 읽어 바뀌면 `aborted`와 이유로 멈춘다. 호스트가 필요한 시나리오는 에이전트가 띄운 Rhino를 `.vide/` 사본으로 Link하고 끝나면 종료한다(AI.md §8). 페르소나는 UI가 할 수 있는 일을 모두 할 수 있으므로, 전용 프로젝트라도 실제 문서 변경이 일어날 수 있다는 전제로 사본만 연결한다.

## 동작

1. 엔진 세션: `POST /api/v1/session {token}`(Origin 헤더) → 쿠키를 **새 브라우저 컨텍스트**(저장소 없음, 1440x900)에 넣고 `/?project=<id>`로 연다.
2. canary: 페르소나에게 `VIDE·jig·Sync·Link가 무엇인지 아세요? 모르면 모른다고만 답하세요.`를 묻는다. 모른다고 답하지 않거나 뜻을 설명하면 런은 `untested`(미시험)로 끝난다.
3. 단계마다 스크린샷 → `personaStep()` → 행동 적용(click: 좌표 클릭 / type: 좌표가 있으면 먼저 클릭하고 입력, `submit:true`일 때만 Enter / wait: 5초) → 새로 나타난 `data-request-id` 수집 → `steps.jsonl` 한 줄. 화면 텍스트(`document.body.innerText`)에서 내부 용어를 센다.
4. `done`·`declare_stuck`·`--max-steps`에서 멈춘다. 다른 출처로 가는 페이지 이동은 막고 새 창은 닫는다.

## 출력 (PLAN-51 계약 5)

- `run.json`: `scenario, status(completed|driver-failed|aborted|untested), canary{asked, answeredUnknown}, steps, stuck, wrongClicks, unknownWords[], bannedWords[], requestIds[], typedInputs, reachedGoal(null), startedAt, endedAt, model` + 참고 필드(`stuckDeclared, stuckFlagged, noProgressPairs, goalReached(null), conversation, personaDone, reason, goal, expertSteps, goalEvidence, engine, project, engineKind(installed|dev|loop), blockedApi[], jigs, isolation, logsDir, cliSessions[]`).
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
- 브라우저의 웹 UI만 조작한다. 데스크톱 셸(WebView2 창)·Rhino 창은 조작하지 않는다. 호스트 연결은 런 전에 운영자가 `host-link.ps1`로 한다.
- 운영자 답은 시나리오에 적은 사실만 준다. 페르소나가 다른 키로 물으면 답이 없고(`unknown`), 키 이름을 잘못 고르면(예: `site_address`) 같은 사실이라도 답하지 못한다. 그런 런은 `operatorAnswers`를 보고 `--answers`로 키를 더해 다시 돌린다.
- 스케치 드래그·키보드 단축키·스크롤은 행동에 없다(1회차 범위, PLAN-51 §6).
- 무진전 감지는 화면 텍스트만 비교한다. 글자는 같고 그림(뷰포트·색)만 바뀐 단계도 무진전으로 셀 수 있고, 시계처럼 저절로 바뀌는 글자가 있으면 세지 못한다.
- `wrongTurn`·`unknownWords`는 페르소나의 자기 보고이며 '대행 판정'이다. canary가 통과해도 모델이 용어를 짐작할 수 있다.
