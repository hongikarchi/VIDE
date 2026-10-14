# AI 동등성 A/B (VIDE 안 AI ↔ 터미널 Claude Code)

같은 모델링 요청 5개를 VIDE 엔진의 대화 경로(A)와 터미널 Claude Code + rhino MCP(B)로 각각 돌려 성공·시간·토큰·도구 호출·화면을 같은 기준으로 기록한다. 결과는 [SPIKE-2026-09-30-ai-parity-ab](../../docs/tdd/SPIKE-2026-09-30-ai-parity-ab.md) 표에 적는다.

Rhino가 비어 있을 때 사람이 실행한다. 에이전트는 Rhino를 띄우지 않는다(AI.md §8).

| 파일 | 하는 일 |
|---|---|
| `requests.json` | 고정 요청 5개와 요청별 판정 기준(mm) |
| `fixture.py` | 합성 시험 모델을 새 문서에 만들고 `.vide/ab/ab-fixture.3dm`로 저장 (Rhino에서 사람이 실행) |
| `run.mjs` | A: 실행 중인 개발 엔진에 5개 요청을 대화로 보내고 결과를 판정·기록 |
| `dump_scene.py` | B: 열린 문서의 객체(이름·레이어·경계, mm)를 JSON으로 저장 (Rhino에서 사람이 실행, 문서를 바꾸지 않음) |
| `terminal.mjs` | B: 덤프 두 개와 Claude Code 기록으로 A와 같은 판정·수치를 냄 |
| `checks.mjs` · `checks.test.mjs` | 공통 판정과 그림(SVG), 단위 시험 (`node --test tools/ab/checks.test.mjs`) |

## 요청과 판정

| ID | 요청 | 성공 기준 (요약) |
|---|---|---|
| R1 | 기둥 12개를 격자로 세워 | 새 객체 정확히 12개, 모두 세로로 긴 형태, 축선 교점마다 하나 |
| R2 | 보 높이를 600으로 | `S-BEAM` 3개 모두 춤 600(±1), 다른 레이어는 변화 없음 |
| R3 | 2층 슬래브를 복사해 3층 만들기 | `S-SLAB` 2개, 그중 하나의 밑면이 z = 7000(윗면 3F FL+7200) |
| R4 | 이 곡선을 따라 난간 만들기 | 새 객체가 `A-RAIL-GUIDE` 곡선의 평면 범위를 300 이내로 따르고 곡선 위로 800 이상 |
| R5 | 축선 이름을 X·Y로 정리 | `S-GRID` 7개가 방향별로 X1…·Y1…(순서대로), 지운 객체 없음 |

각 요청은 손대지 않은 시험 모델에서 시작한다(`run.mjs --chain`을 주면 앞 결과에서 이어 감; 그때는 B도 되돌리지 않는다). "이 곡선"(R4)은 A에서는 곡선을 핀(참조)으로, B에서는 Rhino에서 곡선을 선택한 상태로 보낸다.

## 준비 (한 번)

1. 사용자가 Rhino 8을 직접 띄워 **새 문서**(템플릿 없음)를 연다.
2. `RunPythonScript` → `tools/ab/fixture.py`. 문서가 `.vide/ab/ab-fixture.3dm`로 저장되고 열린 문서가 된다.
3. 같은 문서에서 `RunPythonScript` → `tools/ab/dump_scene.py`, 이름 `fixture` → `.vide/ab/terminal/fixture.json`.

## A — VIDE 엔진

1. 런 전용 자료 폴더로 개발 엔진을 띄운다(예: `VIDE_DATA_DIR=.vide/loop/<run>` + `--dev`). 설치 엔진과 사용자의 `npm run dev` 엔진(자료 `.vide/dev-data`)은 `run.mjs`가 거절한다(포트, 그 `launch.json`의 주소, 자료 폴더로 판별 — 엔진은 포트 충돌 시 임의 포트로 뜰 수 있다). `npm run dev` 엔진을 일부러 쓰려면 `--allow-dev-port`.
2. 화면에서 프로젝트를 하나 만들고 `ab-fixture.3dm`을 연결한 뒤 Sync 한다.
3. 실행:

   ```text
   node tools/ab/run.mjs --launch-file .vide/loop/<run>/launch.json --model <B와 같은 모델> [--effort high] [--only R1,R2] [--project <id>] [--base <Sync 요청 id>]
   ```

   - 엔진 주소·토큰은 `--launch-file`에서, 로그는 그 옆 `logs/`에서 읽는다. `--launch <url#token>`을 쓰면 `--logs <그 엔진 자료>/logs`가 필수다(다른 폴더면 `request-stages`가 붙지 않아 요청이 모두 미시험이 된다). 런 동안 그 폴더에 엔진 줄이 없으면 `results.json`의 `logLines: 0`과 경고로 알린다.
   - 기준 Sync는 문서 이름에 `ab-fixture`가 든 가장 최근 Rhino Sync다(`--match`, `--base`).
   - 요청마다 새 대화(`A/B Rn …`)를 열고 `permission: candidate`로 보낸다. 원본 문서에는 반영하지 않는다.
   - 결과: `.vide/ab/<시각>/results.json`(요청별 상태·판정·시간·토큰·도구 호출·변경 수·답), `Rn.svg`(평면·축측 그림, 주황 = 추가·변경), `rows.md`(SPIKE 표에 붙일 줄).
   - 후보 모델은 mm 문서 기준으로 판정한다. 결과가 표시용(m)이면 1000배로 본다(`--scale`).

## B — 터미널 Claude Code

### B 준비 (이 PC, 2026-10-14 확인)

B는 제3자 [rhinomcp](https://github.com/jingcheng-chen/rhinomcp)(Rhino 플러그인 + Python MCP 서버, 루프백 TCP 1999)를 쓴다. 플러그인과 서버 판을 0.4.1.1로 맞춘다.

1. Rhino 플러그인(Rhino가 꺼져 있어도 됨, 다음 Rhino 시작 때 읽힘):

   ```text
   "C:\Program Files\Rhino 8\System\Yak.exe" install rhinomcp
   "C:\Program Files\Rhino 8\System\Yak.exe" list        # rhinomcp (0.4.1.1)
   ```

   설치 위치는 `%APPDATA%\McNeel\Rhinoceros\packages\8.0\rhinomcp\0.4.1.1\net8.0\rhinomcp.rhp`. Rhino 안의 Package Manager에서 `rhinomcp`를 설치해도 같다.
2. MCP 서버를 사용자 범위로 등록(모든 폴더의 `claude`가 봄, `uvx`는 `C:\Users\user\.local\bin`):

   ```text
   claude mcp add --scope user rhino -e RHINO_MCP_HOST=127.0.0.1 -- uvx rhinomcp@0.4.1.1
   claude mcp get rhino      # Scope: User config, Status: Connected
   claude mcp list           # rhino: uvx rhinomcp@0.4.1.1 - Connected
   ```

   `Connected`는 stdio 서버가 떴다는 뜻일 뿐이다(도구 70개 노출). Rhino에서 `mcpstart`가 켜져 있지 않으면 도구 호출은 `Could not connect to Rhino at 127.0.0.1:1999`로 실패한다. 포트를 바꾸려면 `-e RHINO_MCP_PORT=<포트>`.
3. 런마다: 사용자가 Rhino 8을 직접 띄우고 명령줄에 `mcpstart`(끝낼 때 `mcpstop`). 그 뒤 `claude` 세션을 새로 시작해야 rhino 도구가 붙는다. 대화형에서는 `/mcp`로 `rhino` 연결을 확인한다. 제품 A 쪽은 `--strict-mcp-config`로 실행해 이 등록의 영향을 받지 않는다.
4. 해제: `claude mcp remove rhino -s user`, 플러그인은 `Yak.exe uninstall rhinomcp`(Rhino가 꺼진 상태에서).

### 요청마다

요청마다 다음을 반복한다.

1. Rhino에서 `ab-fixture.3dm`을 다시 연다(저장하지 않고). 시작 상태가 매번 같아야 한다. R4는 `RAIL GUIDE` 곡선을 선택해 둔다.
2. 평소 쓰는 폴더에서 같은 모델로 요청을 보낸다. 수치를 자동으로 얻으려면 비대화 실행을 쓴다.

   ```text
   claude -p "기둥 12개를 격자로 세워" --model <모델> --output-format stream-json --verbose --allowedTools "mcp__rhino" > .vide/ab/terminal/R1.jsonl
   ```

   대화형으로 할 때는 시작~끝 시간을 재고, 끝난 뒤 `/cost`의 토큰과 화면에 보인 도구 호출 수를 적어 둔다.
3. 끝나면 화면을 남긴다: Rhino에서 `ViewCaptureToFile`로 `.vide/ab/terminal/R1.png` (또는 rhino MCP `capture_viewport`).
4. `RunPythonScript` → `tools/ab/dump_scene.py`, 이름 `R1` → `.vide/ab/terminal/R1.json`.
5. 판정:

   ```text
   node tools/ab/terminal.mjs --request R1 --log .vide/ab/terminal/R1.jsonl
   node tools/ab/terminal.mjs --request R1 --seconds 95 --tokens 41000 --tools 14   # 대화형으로 잰 값
   ```

   표 한 줄이 출력되고 `.vide/ab/terminal/results.json`에 쌓인다.

## 수치 정의 (A·B 공통)

- **성공:** `requests.json`의 판정이 모두 통과. 사람 눈 판정은 SPIKE 표의 비고에 따로 적는다.
- **시간(초):** A는 요청 제출~끝 상태, B는 CLI 결과의 `duration_ms`(대화형은 보낸 때~답 끝).
- **토큰:** 입력 + 출력 + 캐시 읽기 + 캐시 쓰기의 합. 공급자 보고값 그대로(A `result.usage`, B 결과 줄 `usage`).
- **도구 호출:** A는 호스트 조회 + 실행 횟수(`progress.queries`·`attempts`)와 활동 기록 종류별 수, B는 `tool_use` 블록 수(괄호 안은 rhino MCP만).
- **화면:** A는 후보 모델에서 그린 SVG(호스트 화면 캡처가 엔진에 생기면 그것으로 바꾼다), B는 Rhino 캡처 PNG와 덤프에서 그린 SVG.

## 검증 루프 시나리오 (PLAN-51)

`run.mjs --plan tools/ab/scenarios-round1.json`은 시나리오 종류별로 돈다(route-only: `/route`만, request: 대화 요청 + 재Sync + 되돌리기, sync: 미시험). `scorecard.mjs --run <dir>`가 `scorecard.json`·`scorecard.md`를 낸다. 계약과 다르게 정한 점:

- **요청 권한:** 요청 계약에 `auto` 권한이 없어 `expect.change: true`는 `mode: auto` + `permission: candidate`, `false`는 `mode: plan` + `permission: review`로 보낸다(`src/contracts/workspace.ts` withMode와 같음).
- **경로 대체:** `/route`가 `target: null`이면 화면 규칙(`src/ui/request-route.ts`)으로 정하고 `by: 'rules'`로 적는다. 객체·선택 없이 돈다. `route.reason`은 결정에 이유가 없으므로 `jigName`·`task`(대체 경로는 로그의 `route` 줄 이유)를 담는다.
- **'note' 기대:** `note`·`app`·`ask`, 호스트 없는 `document`만 통과(PLAN-51 §3 '호스트·jig 아님', T-279). 결정 없음·`view`·`param`·`legal`·`make`·jig는 불일치(`checks.mjs` routeCheck).
- **`reconnectHonest` 검사(R1-RECONNECT):** 문서를 다시 연 뒤의 요청이 `STALE_CONNECTION`·`DOCUMENT_MISMATCH`로 failed이거나 다시 연결된 문서에서 succeeded이면 통과. succeeded인데 마지막 활동이 오류면 실패(`checks.mjs` recordCheck).
- **R1-COLOR 핀:** 기준 Sync에 `S-COLUMN` 객체가 없으면 요청을 보내지 않고 `pinMissing`·`runStatus: untested`. `fixture.py`가 `C-PIN` 기둥을 만든다(기존 `ab-fixture.3dm`은 다시 만들어야 한다).
- **변경 판정:** `diff()`는 경계·이름·레이어에 더해 `geometryHash`·`displayColor`·`materialColor`·`attributes64`를 비교한다(색만 바뀐 객체도 modified). 두 행 모두 필드가 없으면 같다고 본다.
- **멈춤·엔진 소실:** 시간 초과는 `runStatus: completed` + `state: timeout`(P0). 요청 수락 뒤 호출이 실패하고 상태 확인(`GET /projects`)도 실패하면 `state: engine-lost`, `crashes` +1(P0). 상태 확인이 되면 `aborted`(미시험). 개발 엔진에는 `engine-exits.jsonl`을 쓰는 데스크톱 셸이 없으므로 종료는 이 방법으로만 잡힌다. 두 상태는 `request-stages` 없이도 판정한다.
- **드라이버 오류:** 시도 하나의 예외는 그 시도만 `driver-failed`로 적고 다음 시도로 간다. `results.json`의 `scenarios`(계획 전체)로 스코어카드가 기록 없는 시나리오를 미시험으로 올린다.
- **스코어카드 접기:** 반복 시나리오는 한 시도라도 P0면 P0, P1은 판정된 시도의 중앙값, 계획한 시도가 모두 판정돼야 PASS(아니면 미시험 '부분 측정'). 결과 검사 실패(예: modifiedMin)도 P0. EXPECTED-FAIL은 기대(경로·상태·결과 검사) 실패에만 적용되고 오보·엔진 종료는 그대로 P0이며, 미시험과 함께 통과율 분모에서 뺀다.
- **answerDominates:** `totalMs > 0`일 때만 계산한다(0인 기록을 모두 참으로 만들지 않도록).
- **페르소나(T-278):** `run.json`의 `stuck`(막힘 선언 + 2단계 연속 무진전) > 0 또는 `stuckFlagged`(페르소나가 막힘으로 적은 단계) ≥ 2면 P0. 운영자가 `goalReached: false`를 적으면 P0. 러너 기록이 없는 페르소나 전용 시나리오는 완료된 모든 런이 `goalReached: true`이고 막힘·내부 용어가 없을 때만 PASS이고, `goalReached`가 `null`이면 미시험이다(페르소나 done은 결과 증거가 아님).

### 개발 엔진 하네스 (`host-session.mjs`)

런 전용 자료 폴더(`<dir>/data`, `.vide/dev-data`의 `typesafe.env`·`public-data.env` 복사)로 개발 엔진을 띄우고 전용 프로젝트를 만든 뒤 `launch.json`을 쓴다. `<dir>/stop` 파일이 생기면(또는 SIGINT) 엔진·Rhino를 닫고 설치본 플러그인 등록을 확인·복원한다. 출력: `LAUNCH`·`LOGS`·`PROJECT`(호스트가 있으면 `SYNC`).

**플러그인 등록 규칙(T-297):** 이 하네스와 개발 빌드를 `LoadPlugIn`하는 모든 실호스트 시험은 `tests/integration/plugin-guard.mjs`의 `withInstalledPluginRestored`로 감싸 끝날 때 설치본 등록을 되돌린다. 세션 끝에 `npm run plugin:check`(verify 마지막 단계)로 등록이 `.vide/build`가 아님을 확인한다.

```text
node tools/ab/host-session.mjs --document .vide/loop/<run>/<사본>.3dm [--dir .vide/loop/<run>] [--visible]
node tools/ab/host-session.mjs --no-host [--dir .vide/loop/<run>]     # route-only L0: Rhino·Link·Sync 없음
```

- 호스트가 있으면 에이전트가 띄운 Rhino에서 사본을 열고 DEV 플러그인을 붙인 뒤 엔진이 `POST /links`로 Link하고 첫 Sync를 기다린다. Rhino·ZWCAD가 이미 떠 있으면 시작하지 않는다(`--no-host`는 확인하지 않음).
- **대화창 없는 연결(T-277):** `_VIDEConnect`는 이제 프로젝트 선택 모달을 띄워 무인 Rhino를 멈춘다. `rhino-connect.mjs`의 `connectScriptLines()`가 `Vide.Worker.AttachedConnection.Connect(doc)`를 리플렉션으로 부르는 IronPython 줄을 만든다. `host-session.mjs`와 `tests/integration/rhino-sync-perf.mjs`가 쓴다. `rhino-attached.mjs`·`rhino-attached-ai.mjs`·`linked-open-compare.mjs`는 아직 `_VIDEConnect`를 부른다.
- **설치 엔진의 페르소나 런(L1)에서 사본을 Link할 때**는 이 하네스 대신 `tools/persona/host-link.ps1`을 쓴다(T-286: 프로젝트 선택·'닫힌 연결 파일이 있습니다' 창 무인 처리, 연결 ID 확인, ZWCAD 포함). 사용법·한계는 [tools/persona/README.md](../persona/README.md) '호스트 구성과 운영자 정보'.
