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

1. 개발 엔진을 띄운다: `npm run dev` (포트 47831, 자료 `.vide/dev-data`). 설치본(47821)에는 돌리지 않는다(`run.mjs`가 거절).
2. 화면에서 프로젝트를 하나 만들고 `ab-fixture.3dm`을 연결한 뒤 Sync 한다.
3. 실행:

   ```text
   node tools/ab/run.mjs --model <B와 같은 모델> [--effort high] [--only R1,R2] [--project <id>] [--base <Sync 요청 id>]
   ```

   - 엔진 주소·토큰은 `.vide/dev-data/launch.json`에서 읽는다(`--launch <url#token>`로 바꿀 수 있음).
   - 기준 Sync는 문서 이름에 `ab-fixture`가 든 가장 최근 Rhino Sync다(`--match`, `--base`).
   - 요청마다 새 대화(`A/B Rn …`)를 열고 `permission: candidate`로 보낸다. 원본 문서에는 반영하지 않는다.
   - 결과: `.vide/ab/<시각>/results.json`(요청별 상태·판정·시간·토큰·도구 호출·변경 수·답), `Rn.svg`(평면·축측 그림, 주황 = 추가·변경), `rows.md`(SPIKE 표에 붙일 줄).
   - 후보 모델은 mm 문서 기준으로 판정한다. 결과가 표시용(m)이면 1000배로 본다(`--scale`).

## B — 터미널 Claude Code

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
