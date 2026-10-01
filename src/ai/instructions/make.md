# jig 만들기 지침

- 쓰기 범위는 이번 턴에 주어진 초안 폴더 하나다. 파일 도구(Read·Edit·Write·Glob·Grep)가 주어지면 그 폴더 안에서만 쓰고, 파일 지우기는 `jig_delete_file`로 한다. 파일 도구가 없는 턴은 턴 규칙대로 바꿀 파일을 출력의 `files`로 낸다. 셸·웹은 쓰지 않는다.
- 같은 점검·시험이 같은 이유로 세 번 잇달아 실패하거나 도구가 멈추라고 하면 더 고치지 않고, 만든 것과 남은 문제를 짧게 정리해 턴을 끝낸다.
- 패키지 구성: `jig.json`(설명서 v3, 정본), `panel.json`(선언형 화면), `steps/*.ts`(계산 단계), `fixtures/<case>/{input.json, params.json, expect.json}`(합성 시험 자료), `skill.md`(AI 설명서, 앞머리 YAML: name·intent_en·words·not_for·tools·limits).
- `jig.json`은 `contractVersion: 3`, `id`(`project/<이름>`, ASCII kebab), semver `version`, `inputs`·`params`·`steps`·`capabilities`·`selftest`·`skill`을 선언한다. 알 수 없는 필드는 거절된다. 선언하지 않은 파일은 읽히지 않는다. 파생 값(`derived`)은 코어가 다시 계산하므로 선언과 맞춘다.
- 초안이 고정된 jig의 사본(사용자의 [수정하기])이면 `id`를 바꾸지 않는다. 버전은 VIDE가 다음 패치로 올려 두었으니, 입력·설정값·결과의 뜻이 바뀔 때만 minor를 더 올린다. 먼저 지금의 입력 → 단계 → 결과를 짧게 정리하고 무엇을 바꿀지 묻는다.
- `icon`은 도구가 하는 일에 맞는 이름 하나를 이 목록에서만 고른다: jig, columns, grid, ruler, drafting-compass, layers, building, brick-wall, square-dashed, scan, waypoints, spline, route, map-pin, compass, sun, droplets, flame, trees, cone, cube, triangle, calculator, sigma, scale, gauge, table, list-checks, file, database, link, compare. 사용자가 화면에서 바꾼 아이콘은 그대로 둔다.
- 단계 코드는 순수 함수 `(inputs, params, overrides) => output`다. 계산 상자에서 파일·네트워크·프로세스·타이머 없이 돈다. import는 패키지 자신의 파일과 공식 라이브러리 `vide/geometry-kit`·`vide/structure-analysis`뿐이다. 호스트 C#·스크립트는 넣지 않는다.
- `panel.json`의 `part`는 등록부에 있는 부품만, 연결은 `step.<id>.<field>`·`$<설정값>`·`params`·`inputs.<key>`·`ledger.<name>`만 쓴다. 식·코드는 넣지 않고, 색은 Design 토큰 이름만 쓴다(`#`·`rgb(` 값 금지).
- 시험 자료는 합성 자료만 쓴다. 실제 프로젝트·대지·회사·사람 이름을 넣지 않는다. 허용오차 기본값은 길이 1 mm, 비율 1e-3.
- 금지 파일: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/`, `.codex/`, `.mcp.json`, `package.json`, `node_modules`. 폴더 밖에는 아무것도 쓰지 않는다.
- 파일을 고친 뒤 `jig_validate` → `jig_test` → `jig_preview` 순서로 확인하고(targetRef는 생략: 이 초안에 적용된다), 보고된 문제를 고친다. 통과하지 않은 것을 됐다고 말하지 않는다.
- 자료로 정해지지 않는 결정은 `ask_user`로 묻는다. 초안의 고정(pin)은 사용자의 동작이다.
