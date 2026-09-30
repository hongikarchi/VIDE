---
id: ARCH-03
title: jig 런타임과 저장 스키마 v5의 물리 계약
status: review
version: 0.2
updated: 2026-09-30
owner: agent:claude
related: [FR-23, FR-24, FR-25, SPEC-02, SPEC-05, SPEC-06, SPEC-07, ADR-014, ADR-019, ADR-020, ADR-021, ARCH-01, ARCH-02, PLAN-22, PLAN-23, PLAN-24, RESEARCH-10]
---

# jig 런타임과 저장 스키마 v5의 물리 계약

[ADR-020](../decisions/ADR-020-jig-platform.md)의 jig 플랫폼과 스키마 v5를 구현하는 물리 계약(폴더, `jig.json` v3 타입, `panel.json`, 실행기 규약, 서버 경로, DB 표, 만들기 데이터 블록, 점검 이름, 성능 목표)을 정한다. 동작 의미는 [SPEC-07](../specs/SPEC-07-jig-platform.md)(jig 플랫폼)·[SPEC-02](../specs/SPEC-02-execution-candidates.md)(대화·접수)·[SPEC-06](../specs/SPEC-06-structure-analysis.md)(구조), 대화 세션의 결정은 [ADR-021](../decisions/ADR-021-conversation-sessions.md), 작업 순서와 검증은 [PLAN-22](../plans/PLAN-22-jig-platform.md)(플랫폼)·[PLAN-23](../plans/PLAN-23-s06-frame-jig.md)(S-06 골조 jig)·[PLAN-24](../plans/PLAN-24-ai-conversations.md)(AI 대화)가 소유한다. 공통 서버·저장·호스트 경계는 [ARCH-01](ARCH-01-system.md), 구조 해석 모델 계약은 [ARCH-02](ARCH-02-structure-model.md)를 따른다. 설계 근거와 선례는 [RESEARCH-10](../research/RESEARCH-10-vide-restructure.md) §1.9·§4·§5·§10.1·§12에 있다.

**잠정**이라고 적은 값·이름은 SPIKE·VERIFY 결과로 PLAN-22~24가 확정할 때 이 문서를 고친다. 이 문서는 설계이며 구현 여부는 PLAN §6.5가 정본이다.

**용어(SPEC-07.2와 같음).** 작업본(instance, 화면 '이 프로젝트의 jig') = 한 프로젝트에서 jig 한 버전을 쓰는 기록. 설정값(param), 수정 사항(override), Rhino에 만들기(bake), 만들기 기록(bake record), jig 입력 읽기(read). 화면 문구는 Design이 소유한다.

## 1. 구성요소와 위치

| 구성요소 | 위치 | 책임 |
|---|---|---|
| 설명서·설정값 | `src/jigs/runtime/manifest.ts`, `params.ts` | `jig.json` v3 zod 스키마, 파생 값 재계산, 단위 변환(저장 SI, 표시 건축 관행) |
| 등록부·적재 | `src/jigs/runtime/loader.ts` | 공식(빌드 포함) + 설치(`jig_packages`) + 초안을 한 목록으로, 적재 때 digest 확인 |
| 단계 실행 | `src/jigs/runtime/graph.ts`, `runner.ts`, `child-runner.ts`, `compute-box.ts` | 단계 DAG·캐시, 실행기 규약, 출처별 실행기(§6) |
| 점검 | `src/jigs/runtime/gates.ts` | 점검 구현 전부. jig는 이름으로 고른다(§11) |
| 묶기·점검 명령 | `src/jigs/runtime/pack.ts`, `npm run jig:pack`·`jig:validate`·`jig:test` | 제작 대화 도구 `jig_validate`·`jig_test`와 같은 코드 |
| 공식 라이브러리 | `src/jigs/official/geometry-kit/`, `structure-analysis/`, `project-facts/` | 빌드에 포함. 구조 해석은 기존 `src/jigs/structure/core.ts`의 코어 연결과 ARCH-02 계약을 재사용 |
| Rhino에 만들기 | `src/jigs/bake/bake.ts`, `datablock.ts`, `templates/*.cs` | 공식 틀·데이터 블록·만들기 기록(§9) |
| 서버 경로 | `src/server/jig-routes.ts` | jig 경로 전부(§7). `server.ts`는 위임 한 줄 |
| 화면 | `src/ui/jig-panel/`, `src/ui/kit/`(등록부 `registry.ts`) | 선언형 패널 렌더러와 공식 부품. 부품 목록·표현의 정본은 Design |
| 프로젝트 jig 소스 | `extensions/jigs/<name>/`(1차 `s06-frame`) | 검증용 샘플 규칙(§2.2). 설치본 빌드 제외 |
| 기존 jig | `src/jigs/catalog.ts`, `sync.ts`, `structure/`, `knowledge.ts` | 그대로 둔다(ARCH-01 §JIG 탭과 Sync jig, ARCH-02). 구조 저장 `<data>/structure/<projectId>.json`을 작업본으로 옮기는 일은 2차 |

새 코드는 새 파일에 둔다. `src/ui/app.ts`·`src/server/server.ts`·`src/ui/style.css`에는 초기화·위임 몇 줄만 더한다.

## 2. 패키지

### 2.1 폴더

```text
<jig>/
├─ jig.json              정본. 이 파일만 권위가 있다
├─ steps/                계산 단계 코드(TS 순수 함수). 묶은 결과는 dist/steps.mjs
├─ prompts/              AI 단계 지시문(.md)
├─ panel.json            선언형 화면
├─ reports/<name>.json   보고서·원장 틀
├─ schemas/              입력·출력·단계 출력 JSON Schema(draft 2020-12). 짧은 것은 jig.json에 인라인
├─ fixtures/<case>/      자체 시험: input.json, params.json, expect.json (합성 자료만)
├─ assets/               정적 자료(단면표·부호 규칙 등). 출처·해시 기록
└─ skill.md              AI 설명서
```

`views/`(격리 커스텀 뷰)는 RESEARCH-10 §16 B13 결정 전에는 두지 않는다.

### 2.2 파일 규칙

- 설명서에 선언된 파일만 읽는다. 패키지 밖 절대경로와 `..`는 거절한다. 선언은 JSON만 쓴다. 설치·실행 훅은 없다.
- 제3자 코드는 패키지 안에 넣고(vendor) 출처·해시를 `assets/NOTICE.json`에 적는다.
- **금지 파일:** `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/`, `.mcp.json`, `.codex/`. 있으면 점검·가져오기가 실패한다(AI CLI의 지시문으로 읽힐 수 있다).
- 공식(`vide/*`)이 아니면 호스트 C#·스크립트를 담지 않는다. 호스트 쓰기는 §9의 공식 틀을 이름으로 부른다. Python 단계는 없다.
- **검증용 샘플 규칙(`extensions/jigs/*`):** 단계 코드·패널·보고서 틀·합성 시험 자료만 넣는다. 실제 프로젝트의 설정값 근거(진술 ID·결정), 입력 조립 결과, 구역, 좌표 변환, 수정 사항은 사용자 데이터 폴더의 작업본에만 둔다.

### 2.3 저장 위치

| 대상 | 위치 | 성격 |
|---|---|---|
| 공식 jig·라이브러리 | `src/jigs/official/<name>/` | 빌드에 포함, 설치본과 함께 갱신 |
| 프로젝트 jig 소스(개발) | `extensions/jigs/<name>/` | 저장소. 설치본 빌드 제외 |
| 설치된 버전 | `<data>/jigs/installed/<id>@<version>/` | 읽기 전용, 바꾸지 않음. `id`의 `/`는 `~`로 바꾼 폴더 이름(잠정) |
| 초안 | `<data>/jigs/drafts/<draftId>/` | 제작 대화의 쓰기 범위. 개발 모드(`.vide/dev-data`는 저장소 안)의 초안 폴더는 저장소 밖에 둔다(잠정, ADR-021 SPIKE) |
| 단계 결과 캐시 | `<data>/jigs/runs/<instanceId>/<stepId>-<hash>.json.gz` | 지워도 다시 계산 |
| 입력 역할 사본 | `<data>/jigs/inputs/<instanceId>/<role>-<hash>.json.gz` | 사람이 확인한 역할 형상(발자국·곡선·다각형) |
| jig 입력 읽기 | `<data>/jigs/reads/<readId>.json.gz` | §8 |

`<data>`는 실행 중인 VIDE의 데이터 폴더다(설치본 `%LOCALAPPDATA%\VIDE`, 개발 `.vide/dev-data`). 캐시·읽기 파일의 보존 정책은 Sync 보존 정책과 함께 2차에 정하고, 그 전에는 작업본을 지울 때 함께 지운다.

### 2.4 식별

- `id` = `<이름공간>/<이름>`, ASCII kebab. `vide/*` = 공식, `project/*` = 프로젝트 jig. 초안은 `draftId`(UUID)로만 식별하고 고정할 때 `project/<이름>`과 버전을 받는다.
- `version`은 semver. 설치된 `id@version`은 바꾸지 않는다. 작업본은 버전을 고정하며 올리기는 명시적이다.
- 출처 `source`: `builtin`(공식) · `dev-pack`(저장소에서 작성해 이 PC에서 서명) · `ai-draft`(제작 대화의 초안에서 고정) · `foreign`(다른 PC). 1차는 `foreign`을 거절한다. 저장소 체크아웃의 `extensions/jigs/*`는 묶기 전에도 개발 엔진이 `dev-source`로 적재한다(등록부 `stage: dev`, 실행 위치는 `dev-pack`과 같은 자식 프로세스, 설치본에는 없음).

## 3. `jig.json` v3 타입

`src/jigs/runtime/manifest.ts`가 zod로 검증한다. 알 수 없는 필드는 거절한다(`.strict()`).

```ts
export interface JigManifest {
  contractVersion: 3;
  id: string;                        // 'vide/structure-analysis' | 'project/s06-frame'
  version: string;                   // semver
  kind: 'tool' | 'library';
  name: string;                      // 화면 이름(건축 용어)
  summary: string;                   // 한 문장
  hosts?: { rhino?: 'required' | 'optional'; zwcad?: 'required' | 'optional' };
  uses?: { id: string; range: string }[];            // 공식 라이브러리만 대상
  inputs: InputDecl[];
  params: ParamDecl[];
  steps: StepDecl[];
  outputs?: { key: string; from: string; schema: string }[];   // 다른 jig가 받을 수 있는 출력
  panel?: string;                    // 'panel.json' (library는 생략 가능)
  reports?: { id: string; file: string; title: string }[];
  bake?: BakeDecl[];
  capabilities: { name: Capability; scope?: string; reason: string }[];
  selftest: { fixtures: string; requiresHost: false };
  skill: string;                     // 'skill.md'
  // 파생 값은 코어가 다시 계산하고, 선언과 다르면 등록을 거절한다(JIG_DERIVED_MISMATCH)
  derived?: { ai?: { required: boolean; steps: string[] };
              runtimes?: Record<string, 'engine' | 'child' | 'box' | 'bake' | 'cli' | 'screen'> };
}
// RoleDecl.extract는 'rows'(읽은 레이어 행 그대로) 또는 'vide/<라이브러리>#<함수>'다.
// 자체 시험 자료: fixtures/<case>/input.json은 입력 키별 값(assembly는 { <role>: { rows, definitions } }),
// params.json은 저장 단위의 { key: value }, expect.json은 { steps: { <id>: 부분 일치 }, statuses?, tolerance? }.

export type Capability =
  | 'links.list' | 'sync.read' | 'facts.read' | 'jig.read' | 'library.call'
  | 'host.bake' | 'ai.once' | 'ai.tools' | 'export.file';
// 예약(1차 거절): 'host.ops'(B14), 'publish.site'(C2). 공식 전용: 'process.exec', 'host.script', 'net.fetch'

export type InputDecl =
  | { key: string; title: string; kind: 'sync-layers'; host: 'rhino' | 'zwcad';
      match: string[];               // 레이어 경로 글롭
      geometry: 'curves' | 'points' | 'breps' | 'blocks' | 'text' | 'any';
      includeHidden?: boolean; pin?: 'live' | 'snapshot'; required: boolean }
  | { key: string; title: string; kind: 'assembly'; roles: RoleDecl[] }
  | { key: string; title: string; kind: 'facts'; query?: { discipline?: string[]; kinds?: string[] } }
  | { key: string; title: string; kind: 'zone'; shape: 'polygon' | 'line'; meaning: string; required: boolean }
  | { key: string; title: string; kind: 'table-file'; accept: string[] }
  | { key: string; title: string; kind: 'jig-output'; from: { jig: string; output: string } };

export interface RoleDecl {
  role: string; title: string;
  shape: 'polygon' | 'polyline' | 'footprint' | 'band' | 'line' | 'point' | 'level' | 'label';
  many: boolean; required: boolean;
  hints: { layers?: string[]; words?: string[]; blockSize_m?: [number, number] };
  extract: string;                   // 코드 추출기: 'vide/geometry-kit#blockFootprints'
}

export type StepDecl = {
  id: string; title: string;
  kind: 'code' | 'library' | 'host' | 'ai' | 'human';
  needs?: string[];                  // 선행 단계. 순환 금지
  reads: string[];                   // 'input.<key>.<role>' | 'param.<key>' | 'step.<id>' → 의존 간선
  writes: string;                    // 출력 이름(schemas/steps/<id>.json)
  speed: 'live' | 'release' | 'button' | 'confirm';
  gates?: GateUse[];
  budget?: { wallClockMs?: number };
} & (
  | { kind: 'code'; entry: string }                                   // 'steps/girders.ts#girders'
  | { kind: 'library'; use: string; args?: Record<string, string> }   // 'vide/structure-analysis#analyzeSummary'
  | { kind: 'host'; bake: string[] }                                  // bake 선언 id
  | { kind: 'ai'; prompt: string; tools?: string[]; authority: 'draft-only' }
  | { kind: 'human'; slot: string; blocks: string[] }                 // 'confirm-inputs' | 'confirm-analysis' | 'draw-zone'
);

export interface GateUse { use: GateName; level?: 'block' | 'warn' | 'isolate'; args?: Record<string, unknown> }

export type ParamDecl = {
  key: string; title: string; help?: string;
  group: string;
  type: 'length' | 'area' | 'force' | 'lineLoad' | 'areaLoad' | 'angle' | 'ratio'
      | 'count' | 'level' | 'choice' | 'toggle';
  unit?: 'm' | 'mm' | 'kN' | 'kN/m' | 'kN/m2' | 'deg' | '%' | 'EA' | 'EL';   // 저장은 SI
  display?: { unit: string; decimals: number };
  default: number | string | boolean;
  range?: { min: number; max: number; step: number };
  bands?: { from: number; to: number; tone: 'ok' | 'warn' | 'no'; label: string }[];
  choices?: { value: string; label: string; consequence?: string }[];
  words?: { more: string[]; less: string[]; sign: 1 | -1 };   // 상대 표현의 방향. 없으면 말로 바꾸지 않고 질문
  basis?: { factRefs?: string[]; note?: string;
            status: 'confirmed' | 'assumed' | 'chosen' | 'to-ask'; question?: string };
  affects: string[];                 // 이 값이 바뀌면 다시 돌 단계
  board?: boolean;                   // 뷰포트 위 설정값 판(최대 6)
  fixedAtPin?: boolean;              // 작업본을 만들 때만 정함(출력 레이어 등). 경로·AI 도구·말로 바꿀 수 없음
};

export interface BakeDecl {
  id: string;
  template: 'vide.bake.curves@1' | 'vide.bake.sweep-h@1' | 'vide.bake.extrude-column@1' | 'vide.bake.textdot@1';
  host: 'rhino';
  items: string;                     // 단계 출력 경로(항목 배열)
  layer: string;                     // layerRoot 아래 한 단계 이름
  key: string;                       // 항목의 안정 키 필드
  map?: Record<string, string>;      // 틀 인자 ← 항목 필드
  attrs?: Record<string, string>;    // 'vide-mark' 등 UserString ← 항목 필드
  mode: 'replace-own';
  requires?: GateName[];             // 예: ['analysis-confirmed']
}
```

## 4. 작업본

```ts
export interface JigInstance {
  id: string; projectId: string;
  jig: string; version: string;                    // 버전 고정
  title: string;
  layerRoot: string;                               // fixedAtPin. 연결 문서에 이미 있는 레이어
  assembly: Record<string, AssembledRole>;
  params: Record<string, ParamValue>;
  zones: Record<string, { id: string; shape: [number, number][]; source: ParamValue }[]>;
  overrides: Override[];
  conversationId?: string;
  status: 'new' | 'computed' | 'gate-failed' | 'stale';   // 계산 전 / 계산됨 / 점검 실패 / 다시 계산 필요
  bakeStale?: boolean;                             // 만든 뒤 계산 결과가 바뀜('만든 결과가 오래됨')
  createdAt: string; updatedAt: string;
}
// 단계 상태(jig_runs.status): pending | running | done | failed | stale
// 사람 단계는 추가로 waiting | confirmed | reconfirm(확정 뒤 입력 지문이 바뀜). 의미는 SPEC-07.4·07.7

export interface AssembledRole {
  role: string;
  sources: { linkId: string; readId: string; layers: string[]; objectIds?: string[];
             revisionKey: string }[];              // '<instance>|<documentId>|<revision>'
  transform?: { matrix: number[]; method: 'sync-align'; pairs: number; residual_m: number };
  proposedBy: 'rule' | 'ai'; reason?: string;
  confirmed?: { by: string; at: string };
  snapshot: { ref: string; hash: string };         // §2.3 입력 역할 사본
}

export interface ParamValue {
  value: number | string | boolean;
  by: 'default' | 'user' | 'decision' | 'fact' | 'ai' | 'rhino' | 'sketch';
  ref?: string;                                    // 'kdb:S1782' | 'decision:<date>/<id>' | 'rhino:<guid>' | 'sketch:<id>'
  status?: 'ai' | 'confirmed' | 'contaminated' | 'superseded';   // by='fact'일 때 진술 상태
  at: string; note?: string;
}

export interface Override {
  id: string;
  target: { kind: string; identity: Record<string, string | number> };  // { col: 'N3-NB' } | { from, to, role }
  op: 'move' | 'add' | 'remove' | 'set' | 'pin';
  fields: Record<string, unknown>;
  origin: 'pen' | 'chat' | 'table' | 'host-edit';
  by: 'user' | 'ai';                               // AI 제안은 사용자가 받아야 user
  at: string; note?: string;
}
```

- 작업본 본문(`assembly`·`params`·`zones`·`overrides`·`layerRoot`)은 `jig_instances.body` JSON 한 칸에 둔다(§10).
- 안정 키: 단계 출력의 항목은 결정적 키를 가진다(예: 기둥 `col:<축>-<축>`, 보 `G:<시작 기둥>><끝 기둥>`). 수정 사항과 만들기 기록은 이 키로 대상을 다시 찾는다. 키 규칙은 jig가 정하고, 같은 입력이면 같은 키인지는 점검 `ids-stable`이 본다.

## 5. `panel.json`·보고서·AI 설명서·자체 시험

### 5.1 `panel.json`

```ts
export interface PanelSpec {
  layout: 'jig-run';
  left?: PartUse[];
  center: { views: PartUse[]; board?: PartUse; kpis?: PartUse };
  drawer?: PartUse;                                // 보통 'result-tabs'
  actions?: { id: string; label: string; step?: string; report?: string; tier: 'T1' | 'T2' }[];
}
export type PartUse = { part: string } & Record<string, Binding | string | number | boolean | PartUse[] | object>;
export type Binding = `step.${string}` | `$${string}` | 'params' | `inputs.${string}` | `ledger.${string}`;
```

- `part`는 `src/ui/kit/registry.ts`에 등록된 이름이어야 하고, 부품마다 등록부의 zod 스키마로 속성을 검사한다. 목록 밖 부품·속성은 등록을 거절한다. 1차 부품 목록은 Design이 정한다. 검사는 `src/ui/jig-panel/spec.ts`의 `validatePanel`(zod와 등록부만 쓰는 순수 함수) 하나이며, 화면이 그리기 전과 로더(`loadJig`: `jig:validate`·가져오기·등록부 목록)가 같은 검사를 돌린다. 로더는 위반을 `JIG_PANEL` 항목(`panel.json:<경로>`)으로 거절한다. 연결은 설명서가 선언한 단계 id·설정값 키·입력 키(`scopeOf`)에 대해서만 검사한다. 목록에 있으나 아직 만들지 않은 부품(`compare-bars`·`report`·`ledger`, PLAN-22 T-057)은 그때까지 `PANEL_PART_NOT_READY`로 거절한다.
- 연결은 단계 출력 경로(`step.<id>.<field>…`), 설정값(`$<key>`), `params`, `inputs.<key>…`, `ledger.<name>`뿐이다. 식·코드는 넣지 않는다.
- 색은 Design §02의 토큰 이름만 쓴다. `#`·`rgb(`·`hsl(`로 시작하는 값은 거절한다.
- `custom-view`는 1차에 거절한다(B13).
- `tier`는 서버 확인 등급이며 화면에 보이지 않는다.

### 5.2 보고서 틀 `reports/<name>.json`

- `template: 'study'` 하나(1차). 머리·KPI·절·출처 줄·원장 절을 선언한다.
- 헤드라인·절 주장은 틀 문장 목록 `cases[{ when, template }]`이다. `when`은 닫힌 형식만 허용한다: `<경로> <연산자> <경로|숫자>`를 `&&`로 잇고, 연산자는 `== != < <= > >=`다. 틀의 `{경로}`는 결과 값으로 채운다. AI 1회 다듬기(`polish: 'ai-once'`)는 선택이다.
- 보고서 점검은 `claim-consistent`(쓰인 틀의 `when`이 참), `numbers-in-source`, `unchecked-listed`, `combo-echo`다(§11).
- 렌더러는 `src/server/report.ts`를 넓힌다. 스크립트 없는 CSP와 외부 요청 없는 HTML을 유지한다.

### 5.3 `skill.md`

앞머리 YAML: `name`, `intent_en`(Jev 판정용 영어 한 줄), `words`(규칙 판정용 한국어 낱말), `not_for`, `tools`, `limits`. 목록 표시는 1,536자 이하. 공급자 CLI의 skill로는 로드하지 않는다.

### 5.4 자체 시험

`fixtures/<case>/{input.json, params.json, expect.json}`. 허용오차 기본값은 길이 1 mm, 비율 1e-3. 합성 자료만 넣는다. `jig:test`는 호스트 없이 단계 실행기로 돌린다(`selftest.requiresHost: false`).

## 6. 실행기

### 6.1 출처별 실행 위치

| 단계 | `builtin` | `dev-pack` | `ai-draft`·초안 | `foreign`(C1 뒤) |
|---|---|---|---|---|
| `code` | 엔진(무거우면 작업 스레드) | Node 자식 프로세스 | 계산 상자 | 정하지 않음 |
| `library` | 엔진. 수십 ms 넘는 호출(구조 해석 napi 등)은 작업 스레드 | 같음 | 같음 | 정하지 않음 |
| `host` | §9 만들기 경로 | 같음 | 초안은 미리보기 선만 | 정하지 않음 |
| `ai` | 단발 AI CLI(도구 없음 또는 조회 도구), 뒤에 점검 필수 | 같음 | 같음 | 정하지 않음 |
| `human` | 화면 | 같음 | 같음 | 정하지 않음 |

수명 단계별 허용 동작은 SPEC-07이 정한다. 이 표는 허용된 단계가 어디서 도는지만 정한다.

### 6.2 실행기 규약

엔진과 실행기는 JSON 줄 단위로 주고받는다. 자식 프로세스와 계산 상자가 같은 규약을 쓴다.

```ts
export type RunnerIn =
  | { t: 'load'; jig: string; version: string; dir: string; digest: string; bundled: boolean }
  | { t: 'run'; runId: string; step: string; entry: string; input: unknown; params: Record<string, unknown>;
      overrides: Override[]; budgetMs: number }
  | { t: 'cancel'; runId: string };
export type RunnerOut =
  | { t: 'done'; runId: string; output: unknown; ms: number }
  | { t: 'fail'; runId: string; code: 'BUDGET' | 'THROW' | 'SCHEMA'; message: string }
  | { t: 'log'; runId: string; text: string };
```

- 단계 함수의 서명은 `(inputs, params, overrides) → output`이다.
- 입력 바이트는 엔진이 권한을 검사한 뒤 넘긴다. 넘기는 것은 조립된 역할 형상과 앞 단계 출력이지 원본 Sync 행이 아니다.
- 출력은 엔진이 단계 출력 스키마로 검사한 뒤에만 다음 단계·화면으로 간다. `budgetMs`를 넘으면 끊고 `BUDGET`으로 기록한다.
- TS 단계는 묶을 때(`jig:pack`) Vite의 `build` API(이미 devDependency, esbuild는 별도 의존성이 아니다)로 만든 `dist/steps.mjs`(모든 `code` 단계 함수를 `steps[<entry>]`로 내보내는 한 파일)를 쓴다. `dist/steps.mjs`가 없으면(저장소 소스, 묶지 않은 시험 묶음) Node의 타입 제거로 `.ts` 진입 파일을 직접 적재한다.
- 단계 함수의 `inputs`는 선언한 `reads`만 담는다: `input.<key>` → `inputs[key]`, `input.<key>.<role>` → `inputs[key][role]`, `step.<id>` → `inputs.steps[id]`. `params`는 읽는다고 선언한 설정값의 저장 단위 값이다. 사람 단계의 지문에는 수정 사항이 들어가지 않는다.

### 6.3 엔진 단계 실행기

- `graph.ts`가 `needs`·`reads`로 DAG를 만들고 바뀐 입력을 읽는 단계와 그 뒤만 다시 돌린다. 캐시 키 = sha256(패키지 digest, 단계 id, 읽은 입력의 해시, 읽은 설정값, 수정 사항). 결과는 §2.3 캐시 파일과 `jig_runs`에 둔다.
- `library` 단계는 실행기가 아니라 엔진이 돌린다. 공식 라이브러리의 순수 TS 부분(`geometry-kit`)은 실행기 묶음에 복사해 쓸 수 있다.
- 무거운 공식 계산(구조 해석·단면 선정)은 `worker_threads`에서 돌리고 같은 작업본의 가장 최근 요청만 남긴다. 엔진 스레드에서 동기 napi를 부르지 않는다.
- 입력 개수에 따라 단계 수가 늘어나는 구조는 없다. 목록은 단계 안에서 처리한다.

### 6.4 Node 자식 프로세스(`dev-pack`)

- 띄우기: `node --permission --allow-fs-read=<패키지 폴더> --allow-fs-read=<geometry-kit 묶음 폴더> --allow-fs-read=<runner.mjs 폴더> runner.mjs`. 경로마다 `--allow-fs-read`를 따로 준다(쉼표로 이으면 한 경로로 해석된다). 쓰기·자식 프로세스·addon·worker 허용 플래그는 주지 않는다. 런타임은 설치본의 Node 24.15다.
- `env`에는 `PATH`, `SystemRoot`만 넘긴다(부모 환경의 키가 보이지 않게). Windows에서는 libuv가 자식 환경에 고정 필수 변수(`HOMEDRIVE`·`HOMEPATH`·`LOGONSERVER`·`SYSTEMDRIVE`·`TEMP`·`USERDOMAIN`·`USERNAME`·`USERPROFILE`·`WINDIR`)를 더하며 그 밖의 변수는 없다(기동 시험이 확인). 묶기 전 저장소 소스(`dev-source`)는 상대 import를 위해 `src/jigs/official`과 `node_modules` 읽기를 추가로 허용한다. 공식 구조 라이브러리가 재사용하는 `src/jigs/structure`와 ARCH-02 계약 `src/contracts`도 읽기만 허용한다(쓰기·addon은 그대로 금지).
- 설치된 Node의 권한 모델에는 네트워크 제한이 없다. 이 실행기는 저장소에서 사람이 검토하고 이 PC에서 서명한 코드만 올린다.
- 작업본마다 하나를 띄워 두고 유휴 5분 뒤 끝낸다.

### 6.5 계산 상자(`ai-draft`·초안)

- 엔진 안에서 wasm으로 컴파일한 JS 실행기(QuickJS 계열, MIT). 파일·네트워크·프로세스·환경 변수 API가 실행기 안에 없다.
- 메모리 상한과 실행 시간 상한(`budgetMs`)을 실행기에서 건다(값 잠정).
- V8보다 느리므로 무거운 기하는 공식 라이브러리 단계로 넘기고, 계산 상자 단계는 그 결과를 조합하는 가벼운 코드로 쓴다.

### 6.6 기동 시험

- 자식 프로세스: 허용 경로 읽기 성공, 그 밖의 경로는 `ERR_ACCESS_DENIED`, `process.env`에 `PATH`·`SystemRoot` 외 키 없음.
- 계산 상자: `fetch`·`require`·`process`가 정의되지 않음, 예산 초과 시 끊김.

## 7. 서버 경로

모든 경로는 `src/server/jig-routes.ts`가 처리하고 ARCH-01 §1.3의 인증·Host·Origin·크기 검사를 그대로 따른다. `:iid`는 작업본 ID, `:jigId`는 URL 인코딩한 jig id(`project%2Fs06-frame`)다.

| 메서드·경로 | 본문 | 응답·비고 |
|---|---|---|
| `GET /api/v1/jigs` | — | 등록부: 공식 + 설치 버전(기존 경로를 넓힘) |
| `POST /api/v1/jigs/import` | `.vjig` 바이트 | `{id, version, digest, capabilities}`. 확인 필요 동작, 서명 확인(§12), 원격 세션 403 |
| `GET /api/v1/projects/:id/jigs` | — | 이 프로젝트에 고정된 jig·버전 |
| `POST /api/v1/projects/:id/jigs/:jigId/pin` | `{version, approvedCaps}` | `project_jigs` 행. 확인 필요 동작, 원격 세션 403 |
| `GET·POST /api/v1/projects/:id/jig-instances` | POST `{jig, version?, title, layerRoot}` | 작업본. `layerRoot`가 연결 문서에 없으면 422 |
| `GET …/jig-instances/:iid` | — | 작업본 + 단계 상태 요약 |
| `PUT …/:iid/params` | `{values:[{key, value}], by, reason?, requestId?}` | 다시 계산 요약 + `jig_param_log.seq`. `fixedAtPin` 값은 422 `PARAM_FIXED` |
| `POST …/:iid/params/undo` | `{seq}` | 그 변경을 되돌림 |
| `POST …/:iid/overrides` | `{add?: Override[], remove?: string[]}` | 갱신된 수정 사항 |
| `PUT …/:iid/zones` | `{zones}` | — |
| `POST …/:iid/reads` | `{linkId, layers, includeHidden, purpose}` | §8 |
| `POST …/:iid/assembly/propose` | `{roles?}` | 역할별 후보(규칙 + 단발 AI 단계) |
| `PUT …/:iid/assembly/:role` | `{sources, transform?, confirm}` | 확정된 역할 |
| `POST …/:iid/run` | `{until?, mode: 'geometry' \| 'preview' \| 'confirmed'}` | 단계 상태·KPI·겹침 층·표. `preview` 결과는 저장하지 않고 '미확정 미리보기'로 표시(SPEC-06) |
| `POST …/:iid/steps/:stepId/confirm` | `{inputHash}` | 사람 단계(입력 확인·해석 확정) 기록 |
| `POST …/:iid/bake` | `{bake: string[], linkId?, resolve?: Record<string, 'keep' \| 'overwrite' \| 'absorb'>}` | `{status: 'submitted', requestId, runId, readId, revisionKey, linkId, gates, plans[], chunks, waiting?}`(작업 보기로 추적, §9.3). 막은 점검·인자 문제는 422 `GATE_BLOCKED`(`blocked`·`problems`·`hints`), `absorb`가 수정 사항을 더했으면 200 `status: 'absorbed'`(다시 계산 뒤 다시 누름). `linkId`는 조립 역할이 연결 하나만 읽었을 때 생략할 수 있다 |
| `GET …/:iid/bakes?linkId=` | — | 만들기 기록(새 것 먼저, `pendingBaseline`) |
| `POST …/:iid/bakes/:recordId/baseline` | — | 반영한 문서를 다시 읽어 기준 지문을 기록(§9.3 6). 그 실행의 객체가 하나도 없으면 409 `NOT_APPLIED` |
| `GET …/:iid/report.html`, `GET …/:iid/schedule.csv` | — | 보고서·일람표 |
| `POST /api/v1/projects/:id/jig-drafts`, `POST …/jig-drafts/:did/validate·test·preview`, `POST …/jig-drafts/:did/pin`, `DELETE …/jig-drafts/:did` | — | 제작 최소판(잠정). `pin`은 확인 필요 동작, 원격 세션 403 |

- 기존 `POST /api/v1/projects/:id/jigs/sync`와 구조 jig 경로(ARCH-02 §1)는 그대로다.
- 오류 코드(잠정): `JIG_INVALID`(형식·금지 파일·부품, 응답에 `issues[]`), `JIG_SIGNATURE`(서명), `JIG_VERSION_EXISTS`(같은 id·버전, 다른 내용, 409), `PARAM_FIXED`, `OUT_OF_RANGE`, `GATE_BLOCKED`(막은 점검 이름 목록 포함), `STALE_INPUT`(읽은 문서 버전이 현재와 다름), `LAYER_ROOT_MISSING`(저장된 Sync 레이어 표가 있는데 출력 레이어가 없음), `CONFIRMATION_REQUIRED`(확인 없는 가져오기·고정), `JIG_PANEL`(`panel.json`이 §5.1 검사에 걸림, `JIG_INVALID`의 `issues[]`로). 만들기: `BAKE_NOT_COMPUTED`(422, 항목을 내는 단계가 계산되지 않음), `BAKE_JOB_MISSING`(409, 그린 본문이 엔진에 없음 — 재시작 뒤 남은 만들기 요청), `NOT_APPLIED`(409); 요청 결과 코드 `BAKE_TEMPLATE_REJECTED`(워커의 컴파일·`CodePolicy` 거절)·`BAKE_FAILED`·`BAKE_RECEIPT_MISMATCH`(영수증의 키가 계획과 다름). 상태 번호는 ARCH-01 §1.3 매핑(400·403·404·409·422)을 따르며 `src/server/jig-routes.ts`의 `jigStatuses`가 정본이다.
- 1차 구현(T-046)의 세부: 가져오기 확인은 `?confirm=true`, 고정 확인은 본문 `confirm: true`다. 등록부는 `GET /api/v1/jigs/packages`(공식 라이브러리 + 설치 + 저장소 소스)이며 기존 `GET /api/v1/jigs`의 확장은 T-047이 한다. `POST …/reads`는 `linkId` 대신 `syncId`를 받아 저장된 Sync를 서버에서 레이어로 거를 수 있다(ZWCAD·호스트 없는 시험). `GET …/params/log`(변경 이력)·`GET …/steps/:stepId/output`(보관된 결과)이 있다. `stale-input`의 현재 판 비교값(`currentRevisions`)은 아직 경로가 채우지 않는다(연결 판 조회는 후속).
- 능력 검사는 화면이 아니라 이 경로들, 만들기 경로, AI 도구 발급에서 한다. 원격 세션 차단 정규식에 `jigs/import`, `jigs/[^/]+/pin`, `jig-drafts/[^/]+/pin`을 더한다(원격 세션의 앱·확장 제어 금지와 같은 범위).

## 8. jig 입력 읽기

jig 입력은 표시용 Sync가 아니라 jig 입력 읽기로 받는다.

- `POST …/:iid/reads {linkId, layers: string[], includeHidden: boolean, purpose: 'assembly' | 'pre-bake'}` → `{readId, revisionKey, layers: [{fullPath, visible, locked, objectCount}], objectCount, ref}`.
- 연결 Rhino는 기존 고정 메서드 `displayPage`에 레이어 필터와 숨긴 객체 포함 인자를 더해 그 레이어만 열거한다(잠정). 'VIDE에서 연 파일'은 `WorkerScene.Export`에 블록 정의·변환, 레이어 표, 레이어 필터를 더한 경로로 읽는다. 두 변경은 플러그인 재빌드 한 번에 묶는다(PLAN-22). ZWCAD는 1차에 기존 `displayPage` 결과를 서버에서 레이어로 거르고 숨긴 객체는 읽지 않는다.
- 결과는 `jig_reads` 행과 `<data>/jigs/reads/<readId>.json.gz`에 둔다. `workspace_requests`에 넣지 않으므로 Live Sync 기준·뷰포트·연결 목록의 '마지막 Sync'를 바꾸지 않고, 대화에 속하지 않는다.
- `revisionKey` = `<instance>|<documentId>|<revision>`. 점검 `stale-input`은 이 값을 현재 연결의 버전과 비교한다.
- 읽기는 `workspace_requests`에 들어가지 않지만 문서 키를 가지며, 같은 문서의 원본 반영이 진행 중이면 끝난 뒤 읽는다. AI 턴 상한에는 들지 않는다(SPEC-02.9).
- 지문은 늘 표시 경로(`DisplayScene`)의 `geometryHash`(테셀레이션 결과의 SHA-256)다. 작업 실행본 경로(`WorkerScene`)의 `geometry.ToJSON` 해시와 섞지 않는다.

표시용 Sync의 범위 수(꺼진 레이어·블록 내부 제외 수)와 레이어 표 확장은 ARCH-01 §Rhino 표시 페이지 취득의 계약이다.

## 9. Rhino에 만들기

### 9.1 틀

- 공식 틀은 VIDE가 소유한 C# 메서드 본문 파일 `src/jigs/bake/templates/<name>.cs`이고 치환 자리는 `{{DATA_BASE64}}` 하나뿐이다. 1차 틀: `vide.bake.curves@1`(폴리라인·3점 원호), `vide.bake.sweep-h@1`(H·BH 단면을 상단 기준 레일 아래로, 웨브 연직), `vide.bake.extrude-column@1`(H 기둥, 강축 방향 지정), `vide.bake.textdot@1`(부호).
- `bake.ts`는 치환 뒤 본문이 "틀 원문에서 치환 자리만 데이터 블록으로 바뀐 것"과 정확히 같은지 확인한다. 키·부호·단면 이름은 점검 `bake-args-safe`(`^[A-Za-z0-9가-힣:_>.\-]{1,64}$`)를 통과해야 한다.
- 틀은 기존 워커의 감싸기(`TaskCode.Run(RhinoDoc doc)`)와 `CodePolicy`(메서드 하나)를 통과해야 한다. 로컬 함수가 통과하는지는 PLAN-22에서 확인하고, 막히면 인라인 루프로 쓴다. 제네릭 컬렉션은 감싸기의 `using`에 없으므로 전체 이름으로 쓴다.

### 9.2 데이터 블록 `vide.bake.data/1`

리틀 엔디언 이진 묶음을 base64 한 덩어리로 치환 자리에 넣는다. C#은 `Convert.FromBase64String`·`BitConverter`·`Encoding.UTF8`로 푼다.

```text
str   = i32 바이트 길이 + UTF-8 바이트
vec3  = f32 × 3 (기준점에서의 차이, m)
curve = i32 kind(0 폴리라인, 1 3점 원호) + i32 n + vec3 × n

DataBlock
  str  format        "vide.bake.data/1"
  str  template      "vide.bake.sweep-h@1"
  str  jigId
  str  instanceId
  str  bakeId        설명서 bake[].id
  str  runId         이번 만들기 실행 ID
  str  layerPath     layerRoot + "::" + layer
  f64 × 3 origin     좌표 기준점(m)
  i32  nDelete, str × nDelete     지울 객체 GUID(§9.4가 정한 목록)
  i32  nItems,  Item × nItems
Item
  str  key                               → vide-key
  i32  nAttr, (str 이름, str 값) × nAttr  → vide-mark·vide-section·vide-role
  틀별 본문:
    curves@1          curve
    sweep-h@1         str section, f32 H_mm, B_mm, tw_mm, tf_mm, curve rail(상단선)
    extrude-column@1  str section, f32 H_mm, B_mm, tw_mm, tf_mm, vec3 base, vec3 top, f32 × 3 strongAxis(방향 단위 벡터)
    textdot@1         str text, vec3 point
```

- 좌표는 VIDE 계약과 같은 m이고 틀이 `RhinoMath.UnitScale(UnitSystem.Meters, doc.ModelUnitSystem)`로 문서 단위로 바꾼다. 절대 좌표를 f32로 넣으면 측량 좌표계처럼 큰 값에서 cm 단위 오차가 나므로 f64 기준점 + f32 차이로 쓴다(1 km 범위 안에서 오차 0.1 mm 미만).
- 틀은 모든 객체에 `vide-jig`, `vide-instance`, `vide-run`, `vide-bake`, `vide-key`를 붙이고 `Item`의 속성을 더 붙인다.
- 워커 본문 한도는 65,536자다. 한도를 넘는 만들기는 항목을 나누어 같은 작업 안에서 여러 번 실행한다(`renderChunks`: 본문 한도에서 틀 길이를 뺀 base64 크기만큼 담고, 삭제 목록은 첫 묶음만). 한 항목이 혼자 한도를 넘으면 `BAKE_ITEM_TOO_LARGE`로 거절한다. 실제 Rhino에서의 묶음 크기 측정(SPIKE)은 남아 있다.
- 반환값: `{ removed, keys[], ids[], failed[] }` — 만든 키와 그 GUID(같은 순서), 만들지 못한 키(퇴화한 곡선·닫히지 않은 솔리드). 틀은 VIDE가 넘긴 GUID 가운데 `vide-instance`·`vide-bake`가 일치하는 객체만 지우고, 지문을 다시 계산하지 않는다. 계획한 키가 두 목록 어디에도 없으면 `BAKE_RECEIPT_MISMATCH`다.

### 9.3 실행 경로

1. `POST …/:iid/bake` → 만들기 계획(항목·키·레이어·태그) → 점검 `before-bake`.
2. 서버가 그 연결의 jig 입력 읽기를 강제로 실행한다(`purpose: 'pre-bake'`, 숨긴 객체 포함, **문서 전체** — 사람이 jig 객체를 다른 레이어로 옮겼는지는 출력 레이어만 읽어서는 알 수 없다). 읽기의 `documentHash`가 요청의 `expectedDocumentHash`가 되고, 실행 직전 작업 실행본의 문서 판이 그것과 다르면 `STALE_INPUT`으로 거절한다(다시 읽지 않고 사람이 다시 누른다). 파일 링크는 가져온 사본이 기준이다.
3. §9.4로 지울 GUID와 건너뛸 키를 정해 데이터 블록을 만든다.
4. `workspace_requests`에 요청을 만든다: `jig: { kind: 'jig-bake', instanceId, bakeIds, linkId, readId, runId }`, `hostUse: 'write'`, `permission: 'candidate'`(`provider`는 이름뿐이며 부르지 않고, AI 턴 상한에 세지 않는다). 그린 본문은 엔진 프로세스의 작업 목록(`registerBakeJob`, 요청 ID별, 최대 64개)에 두므로 재시작 뒤 남은 만들기 요청은 `BAKE_JOB_MISSING`으로 실패한다. `Execution.run`은 이 종류를 보면 공급자를 부르지 않고 `SdkExecution.runFixed(codes[])`로 작업 실행본에서 틀을 차례로 실행한다 → 저장·재열기 확인 → 영수증 → `finishBake`가 만들기 기록(`jig_bakes`, 지문은 비움)과 결과의 `bake`(추가·교체·보존·복사본·지운 것·만들지 못함; 스키마는 `src/ui/bake-card.tsx`)를 쓴다 → 후보. 작업 보기(SCR-03)에 일반 요청처럼 보인다.
5. 사용자가 원본에 반영하면 기존 `applyAttached` 경로를 쓴다. 작업 실행본 이후의 원본 수정은 기존 `Unchanged` 검사가 `SOURCE_CHANGED`로 막는다.
6. 반영 뒤 `POST …/bakes/:recordId/baseline`이 문서를 다시 읽어(2와 같은 강제 읽기) 태그 `vide-run`이 이번 `runId`인 객체를 `vide-key`로 기록 항목에 대응시키고 GUID를 바로잡은 뒤 지문(`geometryHash`)·`baselineReadId`·`appliedAt`을 기록한다. 1차에서는 카드의 [반영 결과 읽기]가 부르며 반영 경로가 자동으로 부르지는 않는다(연결은 PLAN-23 T-056). 읽기 전이거나 실패한 기록의 객체는 다음 만들기에서 `pending-baseline`으로 보존한다. 이전 실행의 복사본은 `vide-run`이 달라 섞이지 않는다. 원본 반영 뒤 GUID가 작업 실행본과 같은지는 실제 Rhino 검증(`tests/integration/rhino-bake.mjs`)이 확인한다.

### 9.4 만들기 기록과 교체 판정

`jig_bakes.items`는 키마다 `{ nativeId, hash, layer, runId, state }`를 담는다. `state`: `jig`(jig가 관리) · `kept`(사람이 고친 것을 유지하기로 함, 이후 건너뜀) · `deleted`(사람이 지운 것, 다시 만들지 않음). 원본 반영 직후 읽기가 실패해 `hash`가 비어 있는 항목은 읽기를 다시 시도할 뿐, 기준 지문을 남기기 전에는 교체하지 않고 사람이 고친 것처럼 보존한다(SPEC-07.17).

| 만들기 기록 | 직전 읽기 | 분류 | 데이터 블록 |
|---|---|---|---|
| `jig` | 같은 GUID, 같은 지문, 레이어 켜짐·풀림 | 교체 대상 | 지울 목록에 넣고 새로 만든다 |
| `jig` | 같은 GUID, 다른 지문 | 사람이 고침 | 지우지 않고 그 키를 건너뛴다. `resolve`가 `overwrite`면 교체, `absorb`면 수정 사항으로 옮긴 뒤 교체 |
| `jig` | GUID 없음 | 사람이 지움 | 다시 만들지 않는다. 사람이 받으면 `state: deleted` |
| `jig` | 같은 GUID가 꺼진·잠긴 레이어 | 지워야 하면 막음 | 점검 `hidden-target` block |
| `kept`·`deleted` | — | 사람 결정 유지 | 건너뛴다 |
| 없음 | `vide-instance` 태그 있음 | 사람이 만든 복사본 | 건드리지 않는다 |
| — | 태그 없음 | 사람 객체 | 건드리지 않는다 |

1차 구현(`src/jigs/bake/plan.ts`)의 보존 이유는 `edited`(같은 레이어, 다른 지문) · `moved`(다른 레이어) · `pending-baseline`(기준 지문 없음) 셋이고, '위치만 바뀜·높이만 바뀜·모양 바뀜' 세부 판정(정점 배열을 경계 상자 중심 차이만큼 옮겨 같으면 위치, 곡선 끝점의 z만 다르면 높이, 그 밖은 모양)은 SPEC-07.13이 표시 방식을 정한 뒤 더한다. `resolve`의 `keep`은 기록을 `kept`로 바꾸고, `overwrite`는 사람이 지운 것도 다시 만들며, `absorb`는 수정 사항(`target.kind: 'bake-item'`, `origin: 'host-edit'`, `fields: { nativeId, hash, layer }`)을 더한 뒤 만들지 않고 `status: 'absorbed'`로 돌려준다 — 단계가 이 수정 사항을 읽어 결과에 반영해야 다음 만들기에서 뜻이 생기며, 그 규칙은 아직 어느 단계도 구현하지 않았다(PLAN-23 T-056). 사람에게 보이는 방식과 기본 선택은 SPEC-07이 정한다.

### 9.5 레이어

- `layerRoot`는 작업본을 만들 때 정하고(`fixedAtPin`) 연결 문서에 이미 있는 레이어여야 한다. 틀은 그 아래 한 단계 레이어만 켜짐·풀림으로 만든다.
- 두 단계 이상 새 레이어는 원본 반영 코드(`EditorApplication.TargetLayer`)가 새 부모를 찾지 못해 원본 루트에 생길 수 있으므로 허용하지 않는다. 부모 재귀 탐색 수정은 플러그인 재빌드와 함께 PLAN-22가 다룬다.
- 원본 반영은 레이어 속성(켜짐·잠금)을 옮기지 않는다. 출력 레이어가 꺼져 있으면 VIDE가 켜지 않고 점검으로 막는다.

## 10. 저장: 스키마 v5

### 10.1 규칙

- 대화·원장·공급자 세션 표, jig 표, 자료 검토 표를 **마이그레이션 v5 하나**로 만든다. 번호는 엄격히 연속이어야 하므로(`Non-sequential migration`) 병행 작업이 각자 v5를 만들지 않는다. 한 번에 합칠 수 없으면 들어가는 순서대로 v5·v6·v7을 배정하고 이 절을 고친다.
- `workspace_requests`에는 `conversationId`를 `ADD COLUMN`만 하고 기존 행을 `UPDATE`하지 않는다. `NULL`은 프로젝트 기본 대화다. 큰 Sync 행 때문에 이 열에 색인을 만들지 않는다(행마다 넘침 페이지를 읽게 되어 시작이 느려진다). 필요하면 측정 뒤 더한다.
- 이 열은 요청 입력 JSON의 `conversationId`(§10.3)에서 계산하는 가상 생성 열이다. 저장하는 일반 열이면 기존 코드·시험의 위치 기반 `INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)`가 모두 깨지고, 행 끝(`result` 뒤)에 저장되어 큰 Sync 행에서 넘침 페이지를 읽게 된다. 가상 열은 `input`만 읽는다. 요청의 대화는 제출 때 입력에 넣고 나중에 바꾸지 않는다.
- 데이터 접근은 `src/core/conversation-store.ts`(대화·공급자 세션·원장), `src/core/jig-store.ts`(jig 표), `src/core/knowledge-review-store.ts`(자료 검토 표)가 맡는다. 동작 규칙은 이 모듈을 쓰는 쪽(PLAN-22·24)이 정한다.
- Sync 캡처·jig 입력 읽기·만들기 행은 대화에 속하지 않는다.
- 이관 절차는 ARCH-01 §1.3(버전 확인 → 백업 → 트랜잭션 변경 → 무결성 확인)을 따른다. v5 이후에는 이전 설치본으로 되돌릴 수 없으며(`UNSUPPORTED_SCHEMA`), 배포 안내에 적는다.

### 10.2 표

```sql
-- 대화(SPEC-02, ADR-021): 목적별 작업 흐름. 공급자·모델·계정은 시작 때 고정
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,              -- general|model-edit|cad-edit|ask|jig-run|jig-make|app
  title TEXT NOT NULL,
  provider TEXT NOT NULL,          -- claude-cli|codex-cli
  model TEXT, effort TEXT, accountProfileId TEXT,
  mode TEXT NOT NULL DEFAULT 'session',   -- session|ledger
  jigInstanceId TEXT, draftId TEXT,
  targets TEXT,                    -- JSON linkId 목록(화면 필터·새 대화 제안용. 접수 판정은 요청 단위)
  state TEXT NOT NULL,             -- open|closed
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, closedAt TEXT);
CREATE INDEX IF NOT EXISTS conversations_project ON conversations(projectId, state);
ALTER TABLE workspace_requests ADD COLUMN conversationId TEXT
  GENERATED ALWAYS AS (json_extract(input, '$.conversationId')) VIRTUAL;   -- §10.1, 색인 없음

CREATE TABLE IF NOT EXISTS provider_sessions(conversationId TEXT NOT NULL REFERENCES conversations(id),
  provider TEXT NOT NULL, accountProfileId TEXT NOT NULL, sessionId TEXT NOT NULL,
  promptMode TEXT NOT NULL,        -- neutral|tools|no-tools
  cliVersion TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0, inputTokens INTEGER NOT NULL DEFAULT 0, lastTurnAt TEXT,
  state TEXT NOT NULL,             -- active|handed-off|closed|lost
  PRIMARY KEY(conversationId, provider, accountProfileId, sessionId));

CREATE TABLE IF NOT EXISTS ledger_items(id TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL REFERENCES conversations(id),
  kind TEXT NOT NULL,              -- assumption|question|answer|decision|code|param-change|result-ref|handoff
  body TEXT NOT NULL,              -- JSON
  requestId TEXT, createdAt TEXT NOT NULL, supersededBy TEXT);
CREATE INDEX IF NOT EXISTS ledger_items_conversation ON ledger_items(conversationId, createdAt);

-- jig(SPEC-07, ADR-020)
CREATE TABLE IF NOT EXISTS jig_packages(id TEXT NOT NULL, version TEXT NOT NULL,
  stage TEXT NOT NULL,             -- project (1차). shared|verified는 C1 뒤
  source TEXT NOT NULL,            -- dev-pack|ai-draft (builtin은 빌드 등록부, foreign은 1차 거절)
  digest TEXT NOT NULL, signer TEXT, path TEXT NOT NULL,
  approvedCaps TEXT NOT NULL,      -- JSON: 사용자가 승인한 능력
  installedAt TEXT NOT NULL, PRIMARY KEY(id, version));
CREATE TABLE IF NOT EXISTS project_jigs(projectId TEXT NOT NULL REFERENCES projects(id),
  jigId TEXT NOT NULL, version TEXT NOT NULL, pinnedAt TEXT NOT NULL, PRIMARY KEY(projectId, jigId));
CREATE TABLE IF NOT EXISTS jig_drafts(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
  conversationId TEXT, path TEXT NOT NULL,
  state TEXT NOT NULL,             -- open|archived|pinned|discarded
  createdAt TEXT NOT NULL, openedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jig_instances(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
  jigId TEXT NOT NULL, version TEXT NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL,              -- JSON: layerRoot·assembly·params·zones·overrides
  status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jig_instances_project ON jig_instances(projectId);
CREATE TABLE IF NOT EXISTS jig_param_log(instanceId TEXT NOT NULL REFERENCES jig_instances(id),
  seq INTEGER NOT NULL, key TEXT NOT NULL, old TEXT, new TEXT NOT NULL, by TEXT NOT NULL, reason TEXT,
  requestId TEXT, at TEXT NOT NULL, PRIMARY KEY(instanceId, seq));
CREATE TABLE IF NOT EXISTS jig_runs(instanceId TEXT NOT NULL REFERENCES jig_instances(id),
  stepId TEXT NOT NULL, inputHash TEXT NOT NULL, outputRef TEXT, ms INTEGER, status TEXT NOT NULL,
  gates TEXT,                      -- JSON: 점검 이름·수준·결과
  at TEXT NOT NULL, PRIMARY KEY(instanceId, stepId));
CREATE TABLE IF NOT EXISTS jig_reads(id TEXT PRIMARY KEY, instanceId TEXT NOT NULL REFERENCES jig_instances(id),
  linkId TEXT NOT NULL, revisionKey TEXT NOT NULL, layers TEXT NOT NULL, includeHidden INTEGER NOT NULL,
  purpose TEXT NOT NULL,           -- assembly|pre-bake
  ref TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jig_bakes(id TEXT PRIMARY KEY, instanceId TEXT NOT NULL REFERENCES jig_instances(id),
  bakeId TEXT NOT NULL, linkId TEXT NOT NULL, requestId TEXT NOT NULL, runId TEXT NOT NULL,
  items TEXT NOT NULL,             -- JSON: key → {nativeId, hash, layer, runId, state}
  baselineReadId TEXT, appliedAt TEXT);
CREATE INDEX IF NOT EXISTS jig_bakes_instance ON jig_bakes(instanceId, bakeId, linkId);

-- 프로젝트 자료 검토층(C-02, PLAN-08). 크롤러 DB는 읽기 전용이므로 확정·오염 판단은 VIDE DB에 둔다
CREATE TABLE IF NOT EXISTS knowledge_reviews(projectId TEXT NOT NULL REFERENCES projects(id),
  statementId INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('confirmed','rejected','contaminated','superseded','corrected')),
  correction TEXT, supersededBy INTEGER, reason TEXT, by TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY(projectId, statementId));
CREATE TABLE IF NOT EXISTS knowledge_source_rules(projectId TEXT NOT NULL REFERENCES projects(id),
  pattern TEXT NOT NULL, reason TEXT, PRIMARY KEY(projectId, pattern));
CREATE TABLE IF NOT EXISTS project_roots(projectId TEXT PRIMARY KEY REFERENCES projects(id),
  kdbRoot TEXT, localRoot TEXT);
```

### 10.3 요청 JSON에 더하는 필드(열 추가 없음, 잠정)

- `input.conversationId`: 요청이 속한 대화 ID. 없으면 프로젝트 기본 대화이고, `workspace_requests.conversationId` 가상 열이 이 값을 읽는다(§10.1). Sync 캡처·만들기 요청에는 넣지 않는다.
- `input.hostUse`: `'none' | 'read' | 'write'`. `none`이면 호스트 경합 대상 목록이 비고, `read`는 문서 키만 가진다(SPEC-02.9).
- 차례를 기다리는 요청은 거절하지 않고 `state: 'queued'`로 두고, 결과 JSON에 `waitingFor: { kind: 'document' | 'conversation' | 'project', key, position }`을 적는다. `document`는 같은 문서 쓰기의 대기열, `conversation`은 한 대화에서 진행 중인 턴 뒤에 덧붙인 말, `project`는 프로젝트 AI 턴 상한(기본 3)이다. 앞 작업이 끝나면 실행기가 다음을 꺼낸다. 재시작 뒤 `queued` 요청은 보존하되 자동으로 실행하지 않는다(SPEC-02.9).
- 요청 자료의 원장 항목은 `ledger` 항목(`{ scope: 'all' | 'since-last-turn', items[], summarized, omitted }`) 하나이며 `supersededBy`가 없는 최신 항목만 넣고 8 KB를 넘으면 오래된 것부터 요약하고, 그래도 넘으면 뺀다. 세션 턴은 6턴마다 전체를, 그 사이에는 지난 턴 이후 항목만 보낸다. 새 세션의 첫 턴에는 `handoff` 항목(이유·최근 3턴·파일 이름), 다른 대화가 그 사이 반영한 것은 `changes-elsewhere` 항목으로 더한다.
- 대화 경로(`src/server/conversations.ts`): `GET·POST /api/v1/projects/:id/conversations`(POST `{kind?, title?, body?, provider?, model?, effort?, host?, permission?, jigInstanceId?, draftId?, targets?}` — 서비스·모델을 안 주면 Jev가 한 번 고르고 계정은 `accountUsage.choose`로 고정), `GET …/conversations/:cid`(`default`는 기본 대화; 원장·세션 포함), `POST …/:cid/close`(`{discard?}`: 기록 즉시 삭제)·`reopen`·`ledger`(`{kind, body, requestId?}`)·`handoff`(`{provider, model?, effort?}`, 확인 필요 동작, 원격 세션 403). 오류 `CONVERSATION_CLOSED`·`CONVERSATION_PROVIDER`(409). 요청 접수 때 `conversationId`가 있으면 그 대화의 서비스·모델·계정으로 고정하고(`fix`) 한 대화에 한 턴만 실행한다(`waitingFor.kind: 'conversation'`에 `after`·`position`).

세션 인자·공급자 기록 보존 같은 CLI 쪽 물리 계약은 ADR-021에 따라 ARCH-01 §2에 둔다.

## 11. 점검 목록

구현은 `gates.ts` 한 곳이고 jig는 이름으로 고른다. 수준: `block`(다음 단계로 가지 않음) · `warn`(목록에만) · `isolate`(통과분만 넘기고 실패분을 이름 붙여 보고). 각 점검의 판정 의미는 SPEC-07(구조 판정은 SPEC-06)이 정한다.

| 시점 | 점검 | 기본 수준 |
|---|---|---|
| before-run | `inputs-present`, `units-si`, `stale-input`, `fact-valid` | block(`fact-valid`는 미확정 근거면 warn) |
| before-run | `inputs-confirmed` | warn(만들기 전에는 block) |
| before-run | `basis-required` | warn(근거가 '물어볼 것'인 설정값이 기본값 그대로임) |
| after-run | `non-empty`, `no-nan`, `ids-stable`, `ring-orientation`, `polygon-valid` | block |
| after-run | `inside-boundary`, `no-overlap`, `planar-curve` | block 또는 isolate(jig가 고름) |
| after-run | `span-max`, `cantilever-max` | 판정(결과 표에 '초과'로 올림) |
| after-run | `mark-unique`, `schedule-complete`, `combo-echo`, `unchecked-listed` | block |
| after-ai | `ref-whitelist`, `numbers-in-source`, `quote-exists`, `no-formula-invented`, `no-plan-dependent-conclusion` | block. AI 단계는 하나 이상 필수 |
| before-render | `claim-consistent` | block(틀 문장으로 되돌림) |
| before-bake | `solid-closed`, `tag-scope`, `count-match`, `layer-scope`, `hidden-target`, `bake-args-safe`, `inputs-confirmed`, `analysis-confirmed` | block |

`analysis-confirmed`는 부재 만들기에 같은 입력 지문의 확정 해석이 있어야 통과한다(SPEC-06). 점검 실패 이유는 단계 레일에 건축 문장으로 보인다(문구는 Design). 목록에 있으나 아직 구현되지 않은 점검은 선언한 수준으로 실패한다(fail closed)—설명서 검사가 `JIG_GATE_PENDING` 경고로 알린다. 항목 점검의 인자는 `items`(출력 안 배열 경로)·`key`(안정 키 필드)·`field`(다각형·점 필드)·`boundary`(입력 경로 또는 `output.` 접두 출력 경로)다.

## 12. 가져오기와 서명(1차)

- **설치 키:** 설치본이 처음 켜질 때 32바이트 난수 키를 설치본 데이터 폴더(`%LOCALAPPDATA%\VIDE\jig-signing.key`, 이름 잠정)에 만든다. 백업·내보내기·공유 대상이 아니다.
- **묶기:** `npm run jig:pack -- <소스 폴더> --data-dir <설치본 데이터 폴더>`. 개발 서버의 `.vide/dev-data`와 다른 폴더이므로 키 위치를 명시한다. 묶기 전에 `jig:validate`·`jig:test`를 통과해야 한다.
- **digest:** 패키지 파일을 경로순으로 정렬해 `경로\0sha256(파일)\n`을 이은 문자열의 SHA-256.
- **`.vjig` 형식(잠정):** gzip JSON `{ format: 'vide.jig.pack/1', id, version, files: { <경로>: <base64> }, digest, sig: { alg: 'HMAC-SHA256', keyId, mac } }`. `keyId`는 키 SHA-256의 앞 16자, `mac`은 `HMAC-SHA256(key, "<id>@<version>\n<digest>")`, 파일 이름은 `<id의 /를 ~로>@<version>.vjig`(기본 출력 `.vide/jig-packs/`). 키 파일은 32바이트를 hex로 적는다. 같은 digest를 다시 가져오면 아무것도 바꾸지 않고 `installed: false`로 답한다.
- **가져오기:** digest를 다시 계산하고 HMAC를 확인한 뒤 형식·금지 파일·부품·능력 어휘를 점검하고, `<data>/jigs/installed/<id>@<version>/`에 읽기 전용으로 풀고 `jig_packages`(`source: dev-pack`)에 적는다. 서명이 없거나 맞지 않으면 422 `JIG_SIGNATURE`로 거절한다. 이미 설치된 `id@version`과 digest가 다르면 409로 거절한다(같은 버전을 다른 내용으로 덮지 않는다).
- **초안 고정:** 엔진이 만든 초안을 고정할 때는 서명 대신 엔진이 digest를 기록하고 `source: ai-draft`로 적는다.
- 보관소 API·원격 설치·다른 PC 묶음은 C1 결정 뒤 이 문서에 더한다.

## 13. 성능 목표

| 동작 | 목표 | 비고 |
|---|---|---|
| 설정값을 끄는 동안 기하 단계 다시 계산(`live`) | < 100 ms | 해석 단계 제외 |
| 손을 뗄 때(`release`) | < 2 s | |
| 자식 프로세스 단계 왕복(기동 뒤) | 수 ms | 유휴 5분 뒤 종료 |
| 계산 상자 1천 요소 조합 단계 | ≤ 200 ms | SPIKE |
| `geometry-kit` 1천 부재 규모 | ≤ 50 ms | |
| 해석 요약(1,785부재·2조합) | ≤ 60 ms, 응답 ≤ 50 KB | 현재 경로 73 ms·4.42 MB |
| 단면 선정 반복(TS, 1차) | ≤ 1 s | |
| 해석 중 엔진의 `/links` 응답 지연 | ≤ 50 ms | 작업 스레드 |
| 미리보기 재해석 | 5~10 Hz | 해석 부재 1천 개·4조합 이하에서만 |
| 스키마 v5 이관에 따른 시작 시간 증가 | ≤ 1 s | S-06 규모 DB 사본 |
| 만들기 한 번의 C# 본문 | ≤ 65,536자 | 워커 한도 |

측정 결과는 VERIFY에 적고, 목표를 바꿀 때는 이 표를 고친다.

## 14. 이 문서가 아직 정하지 않는 것

- 보관소·게시·검증·남이 만든 jig의 실행 환경(C1·C2 뒤).
- 공식 호스트 조작 틀 `host.ops`(B14), 격리 커스텀 뷰(B13), 플러그인 내장 만들기 틀, CAD에 그리기(2차).
- 정확한 곡선 전송, 변경 알림(SSE `jig.stale`), 캐시·읽기 파일 보존 정책(2차).
- 설계 부재 목록·요약 모드·한 번 분해 같은 구조 계약 확장(ARCH-02 개정, 2차).
