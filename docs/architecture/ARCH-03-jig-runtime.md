---
id: ARCH-03
title: jig 런타임과 저장 스키마 v5의 물리 계약
status: review
version: 1.09
updated: 2026-10-08
owner: agent:claude
related: [FR-23, FR-24, FR-25, SPEC-02, SPEC-05, SPEC-06, SPEC-07, ADR-014, ADR-019, ADR-020, ADR-021, ADR-022, ADR-026, ARCH-01, ARCH-02, PLAN-22, PLAN-23, PLAN-24, PLAN-26, PLAN-45, SPEC-12, RESEARCH-10, RESEARCH-12, SPEC-13, PLAN-46, SPEC-15, PLAN-48, SPEC-16, PLAN-49]
---

# jig 런타임과 저장 스키마 v5의 물리 계약

[ADR-020](../decisions/ADR-020-jig-platform.md)의 jig 플랫폼과 스키마 v5를 구현하는 물리 계약(폴더, `jig.json` v3 타입, `panel.json`, 실행기 규약, 서버 경로, DB 표, 만들기 데이터 블록, 점검 이름, 성능 목표)을 정한다. 동작 의미는 [SPEC-07](../specs/SPEC-07-jig-platform.md)(jig 플랫폼)·[SPEC-02](../specs/SPEC-02-execution-candidates.md)(대화·접수)·[SPEC-06](../specs/SPEC-06-structure-analysis.md)(구조), 대화 세션의 결정은 [ADR-021](../decisions/ADR-021-conversation-sessions.md), 작업 순서와 검증은 [PLAN-22](../plans/PLAN-22-jig-platform.md)(플랫폼)·[PLAN-23](../plans/PLAN-23-s06-frame-jig.md)(S-06 골조 jig)·[PLAN-24](../plans/PLAN-24-ai-conversations.md)(AI 대화)가 소유한다. 공통 서버·저장·호스트 경계는 [ARCH-01](ARCH-01-system.md), 구조 해석 모델 계약은 [ARCH-02](ARCH-02-structure-model.md)를 따른다. 설계 근거와 선례는 [RESEARCH-10](../research/RESEARCH-10-vide-restructure.md) §1.9·§4·§5·§10.1·§12에 있다.

**잠정**이라고 적은 값·이름은 SPIKE·VERIFY 결과로 PLAN-22~24가 확정할 때 이 문서를 고친다. 이 문서는 설계이며 구현 여부는 PLAN §6.5가 정본이다.

**용어(SPEC-07.2와 같음).** 작업본(instance, 화면 '이 프로젝트의 jig') = 한 프로젝트에서 jig 한 버전을 쓰는 기록. 설정값(param), 수정 사항(override), Rhino에 만들기(bake), 만들기 기록(bake record), jig 입력 읽기(read). 화면 문구는 Design이 소유한다.

## 1. 구성요소와 위치

| 구성요소 | 위치 | 책임 |
|---|---|---|
| 설명서·설정값 | `src/jigs/runtime/manifest.ts`, `params.ts` | `jig.json` v3 zod 스키마, 파생 값 재계산, 단위 변환(저장 SI, 표시 건축 관행) |
| 등록부·적재 | `src/jigs/runtime/loader.ts` | 공식(빌드 포함: 라이브러리와 `src/jigs/official/jigs/<name>/` 작업 jig) + 설치(`jig_packages`) + 초안을 한 목록으로, 적재 때 digest 확인 |
| 단계 실행 | `src/jigs/runtime/graph.ts`, `runner.ts`, `child-runner.ts`, `compute-box.ts` | 단계 DAG·캐시, 실행기 규약, 출처별 실행기(§6) |
| 점검 | `src/jigs/runtime/gates.ts` | 점검 구현 전부. jig는 이름으로 고른다(§11) |
| 묶기·점검 명령 | `src/jigs/runtime/pack.ts`, `npm run jig:pack`·`jig:validate`·`jig:test` | 제작 대화 도구 `jig_validate`·`jig_test`와 같은 코드 |
| 공식 라이브러리 | `src/jigs/official/geometry-kit/`, `structure-analysis/`, `project-facts/`, `site-data/`, `massing-kit/` | 빌드에 포함. 구조 해석은 기존 `src/jigs/structure/core.ts`의 코어 연결과 ARCH-02 계약을 재사용. `site-data/shp/`는 SHP 넣기와 좌표계(§8.1). `geometry-kit/solid.ts`와 `massing-kit/`은 규모검토의 가능 영역·외피(§8.2) |
| 공식 작업 jig 소스 | `src/jigs/official/jigs/<name>/`(1차 `buildable-mass`) | `library` 단계로 공식 라이브러리를 부르는 공식 jig 패키지. 등록부에 빌드 포함으로 적재하는 경로는 PLAN-45 T-207이 더한다. 그 전에는 `loadJig`·`jig:test`로 점검·자체 시험만 한다 |
| Rhino에 만들기 | `src/jigs/bake/bake.ts`, `data-block.ts`, `plan.ts`, `templates/*.cs` | 공식 틀·데이터 블록·만들기 기록·바로 적용과 되돌리기(§9) |
| 서버 경로 | `src/server/jig-routes.ts` | jig 경로 전부(§7). `server.ts`는 위임 한 줄 |
| 화면 | `src/ui/jig-panel/`, `src/ui/kit/`(등록부 `registry.ts`) | 선언형 패널 렌더러와 공식 부품. 부품 목록·표현의 정본은 Design |
| 프로젝트 jig 소스 | `extensions/jigs/<name>/`(1차 `s06-frame`) | 검증용 샘플 규칙(§2.2). 설치본 빌드 제외 |
| 기존 jig | `src/jigs/catalog.ts`, `sync.ts`, `structure/`, `knowledge.ts` | 그대로 둔다(ARCH-01 §JIG 탭과 Sync jig, ARCH-02). 구조 저장 `<data>/structure/<projectId>.json`을 작업본으로 옮기는 일은 2차 |

새 코드는 새 파일에 둔다. `src/ui/app/`의 지역 모듈(초기화 순서는 `boot.ts`, ARCH-01 「웹 화면 구조」)·`src/server/server.ts`·`src/ui/style.css`에는 초기화·위임 몇 줄만 더한다.

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
| 공식 라이브러리 | `src/jigs/official/<name>/` | 빌드에 포함, 설치본과 함께 갱신 |
| 공식 작업 jig | `src/jigs/official/jigs/<name>/`(`site-model` T-207, `buildable-mass` T-209) | 빌드에 포함. 등록부가 `jig.json`의 `vide/*` id만 `source: builtin`·`stage: official`로 적재하고(`officialJigRoot`), `vide/*` id는 설치본·저장소 소스보다 먼저 찾는다. 계산 단계는 엔진에서 돈다(§6.1). 화면은 `panel.json`을 페이지 빌드에 함께 묶는다(`declared-jig.tsx`). `npm run jig:validate·jig:test`는 이 폴더를 `builtin`으로 본다 |
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
  icon?: JigIcon;                    // 목록·탭·대화 칩의 그림. `src/contracts/jig-icons.ts`의 목록 이름만(T-100), 없으면 'jig'
  hosts?: { rhino?: 'required' | 'optional'; zwcad?: 'required' | 'optional' };
  uses?: { id: string; range: string }[];            // 공식 라이브러리만 대상
  inputs: InputDecl[];
  params: ParamDecl[];
  steps: StepDecl[];
  outputs?: { key: string; from: string; schema: string }[];   // 다른 jig가 받을 수 있는 출력. from = 'step.<id>'(없는 단계는 JIG_REF_MISSING), schema = 패키지의 JSON Schema(§8.5)
  panel?: string;                    // 'panel.json' (library는 생략 가능)
  reports?: { id: string; file: string; title: string }[];
  bake?: BakeDecl[];
  capabilities: { name: Capability; scope?: string; reason: string }[];
  selftest: { fixtures: string; requiresHost: false };
  skill: string;                     // 'skill.md'
  // skill 시작(§5.3, SPEC-07.18). 모두 선택이며 없으면 기본값
  open?: { reuse?: 'last' | 'new';   // 기본 'last'(이 프로젝트의 마지막 작업본)
           layerRoot?: string };     // 새 작업본의 출력 레이어 틀. 기본 'VIDE/{jig}/{n}'
  autorun?: { until?: string | 'first-hard' };   // 단계 id 또는 기본 'first-hard'(막는 사람 단계 바로 앞)
  from_request?: string[];           // 요청 글에서 읽어 적용할 params[].key
  summary?: { kpi: string[] };       // 결과 요약에 올릴 수치(단계 출력 경로 'step.<id>.<field>')
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
// 서비스(공식 내장 jig 전용, ARCH-01 「jig 능력」): 'service.clawde' — vide/* 이면서 source가 'builtin'일 때만
// 받고 dev-source·dev-pack·ai-draft·프로젝트 jig는 거절(JIG_CAPABILITY). 역전송은 능력으로 두지 않는다.

export type InputDecl =
  | { key: string; title: string; kind: 'sync-layers'; host: 'rhino' | 'zwcad';
      match: string[];               // 레이어 경로 글롭
      geometry: 'curves' | 'points' | 'breps' | 'blocks' | 'text' | 'any';
      includeHidden?: boolean; pin?: 'live' | 'snapshot'; required: boolean }
  | { key: string; title: string; kind: 'assembly'; roles: RoleDecl[] }
  | { key: string; title: string; kind: 'facts'; query?: { discipline?: string[]; kinds?: string[] } }
  | { key: string; title: string; kind: 'zone'; shape: 'polygon' | 'line'; meaning: string; required: boolean }
  | { key: string; title: string; kind: 'table-file'; accept: string[] }
  | { key: string; title: string; kind: 'jig-output'; from: { jig: string; output: string } }   // jig.read 필요
  | { key: string; title: string; kind: 'site-data'; required: boolean }   // 공식 jig만, net.fetch 필요(§8.2)
  | { key: string; title: string; kind: 'host-document'; host: 'rhino'; required?: boolean }   // sync.read 필요(§8.6)
  | { key: string; title: string; kind: 'host-surface'; host: 'rhino'; required?: boolean };  // sync.read 필요(§9.1 패널링 읽기)
// host-surface의 값: 사람 단계 '기준 면 고르기'로 고른 Rhino 객체의 면을 `vide.read.surface-grid@1`로 읽은
// `SurfaceSample`(`src/contracts/paneling.ts`), 읽기 전에는 null. 작업본 `hostSurfaces[key]`가 사본 위치·
// 면 번호·면 지문·Live Sync 행 지문을 갖는다(SPEC-16.12). 설정값이 바뀌어도 다시 읽지 않는다.
// jig-output의 값: 실행할 때 `RuntimeOptions.jigOutput(projectId, from)`이 주는 값, 그것이 없으면 같은
// 프로젝트의 앞 작업본이 선언한 출력(§8.5, 건축개요가 받는 매스·대지 요약), 둘 다 없으면 null이다. 엔진은
// `provideJigOutput(workspace, from, 제공자)`로 `<jig>#<output>`마다 제공자를 등록한다. 첫 제공자는
// 법규 jig의 `vide/legal#constraints`(`vide.legal.constraints@1`, ARCH-01 「법규와 모델」, PLAN-46 T-220)이며
// `vide/buildable-mass`의 입력 `legal`이 받는다. 값은 내용으로 지문을 만들어, 법규 답이 바뀌면 읽는 단계가 다시 돈다.

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
  manual?: true;                     // 이름으로 부를 때만 계산(아래)
  gates?: GateUse[];
  budget?: { wallClockMs?: number };
} & (
  | { kind: 'code'; entry: string }                                   // 'steps/girders.ts#girders'
  | { kind: 'library'; use: string; args?: Record<string, string> }   // 'vide/structure-analysis#analyzeSummary'
  | { kind: 'host'; bake: string[] }                                  // bake 선언 id
  | { kind: 'ai'; prompt: string; tools?: string[]; authority: 'draft-only' }
  | { kind: 'human'; slot: string; blocks: string[] }                 // 'confirm-inputs' | 'confirm-analysis' | 'draw-zone' | 'confirm-target'
);

export interface GateUse { use: GateName; level?: 'block' | 'warn' | 'isolate'; args?: Record<string, unknown> }

// jig.json 맨 위의 선택 필드 `remote?: 'view'`: 원격 화면(SPEC-04)은 그 작업본을 보기만 한다.

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
  template: 'vide.bake.curves@1' | 'vide.bake.sweep-h@1' | 'vide.bake.extrude-column@1' | 'vide.bake.textdot@1'
    | 'vide.bake.extrude-polygon@1' | 'vide.bake.brep-faces@1' | 'vide.bake.mesh@1'
    | 'vide.bake.panels-uv@1' | 'vide.bake.panel-solids@1';
  host: 'rhino';
  items: string;                     // 단계 출력 경로(항목 배열)
  rows?: 'paneling';                 // 패널링 결과(PanelLayout·MemberSet)를 VIDE 어댑터가 항목으로 바꿈(§9.1)
  layer: string;                     // layerRoot 아래 한 단계 이름
  key: string;                       // 항목의 안정 키 필드
  map?: Record<string, string>;      // 틀 인자 ← 항목 필드
  attrs?: Record<string, string>;    // 'vide-mark' 등 UserString ← 항목 필드
  mode: 'replace-own';
  requires?: GateName[];             // 예: ['analysis-confirmed'], ['paneling-confirmed']
}
```

## 4. 작업본

```ts
export interface JigInstance {
  id: string; projectId: string;
  jig: string; version: string;                    // 버전 고정
  title: string;
  layerRoot: string;                               // fixedAtPin. 'A::B' 경로, 연결 문서에 없어도 됨(§9.5). skill 시작 작업본은 빈 값으로 열림
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
// 실행에서 막힌(blocked: 앞 사람 단계가 다시 기다리거나 앞 단계 실패) 계산 단계는 지난 결과를 stale로 남긴다(T-214)

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

- `part`는 `src/ui/kit/registry.ts`에 등록된 이름이어야 하고, 부품마다 등록부의 zod 스키마로 속성을 검사한다. 목록 밖 부품·속성은 등록을 거절한다. 1차 부품 목록은 Design이 정한다. 검사는 `src/ui/jig-panel/spec.ts`의 `validatePanel`(zod와 등록부만 쓰는 순수 함수) 하나이며, 화면이 그리기 전과 로더(`loadJig`: `jig:validate`·가져오기·등록부 목록)가 같은 검사를 돌린다. 로더는 위반을 `JIG_PANEL` 항목(`panel.json:<경로>`)으로 거절한다. 연결은 설명서가 선언한 단계 id·설정값 키·입력 키(`scopeOf`)에 대해서만 검사한다. 목록에 있으나 아직 만들지 않은 부품은 `NOT_READY`에 두고 `PANEL_PART_NOT_READY`로 거절한다. T-057(4차 물결)로 `compare-bars`·`report`·`ledger`를 만들어 지금은 비어 있다.
- 부품과 놓는 자리(`PART_NAMES`·`PLACES`, 2026-09-30 기준). 자리 밖에 놓은 부품은 거절한다.

  | 자리 | 부품 |
  |---|---|
  | `left` | `step-rail`, `param-group`, `slider`, `choice`, `stepper`, `toggle`, `fact-badge`, `role-card`, `verdict-legend`, `bake-card`, `conflict-banner`, `site-picker`, `jig-source` |
  | `center.views` | `viewport-overlay`, `plan-map`, `report` |
  | `center.board` | `slider-board` |
  | `center.kpis` | `kpi-strip` |
  | `drawer` | `result-tabs`, `issue-table`, `table`, `schedule`, `ledger` |
  | `result-tabs`의 탭 | `issue-table`, `table`, `schedule`, `bake-card`, `compare-bars`, `ledger` |

- 4차 물결에 더한 부품의 속성: `bake-card`는 `{title?, from?, bake?}`이며 `bake`는 내놓을 만들기 id(jig 자체 또는 VIDE 기본 `lines`·`members`) 최대 10개, 생략하면 전부다. 누르면 §7 `POST …/bake`로 간다. `compare-bars`는 `{title?, from, label, value, shade?, unit?, decimals?, limit?, limitLabel?}`이고 `shade`는 행 필드로 `base`·`alt`·`strong`·`actual`·`na` 중 하나를 준다. `report`는 `{report}`로 보고서 틀 이름(§5.2)을 가리키고 §7 `…/reports/:name`의 해석된 보고서를 부품으로 그린다. `ledger`는 `{title?, from, group?, columns?}`이며 `from`은 보통 `ledger.<name>`이다.
- `jig-source`(T-213)는 `{input, title?}`이며 `input`은 `jig-output` 입력(`inputs.<key>`)이다. 그 입력이 읽는 앞 작업본(이름 · jig 버전 · 계산 시각), 읽을 수 없는 이유, '다시 계산 필요'와 [다시 계산], 앞 작업본 고르기(「최근 계산된 작업본(자동)」 또는 이 프로젝트의 그 jig 작업본)를 §7의 `jig-outputs` 경로로 한다. 고르면 그 입력을 읽는 단계가 다시 계산 필요가 되고 화면이 다시 계산한다.
- `site-picker`(T-207)는 `{input, title?}`이며 `input`은 `site-data` 입력(`inputs.<key>`)이다. 프로젝트의 전송 고지 확인·끄기(`…/site-data/notice`), 주소 찾기, 후보 질문 카드(SCR-15의 카드 모양과 후보 위치 SVG), 대상 필지 고르기·더하기, [대상 필지 확정](그 사람 단계의 확인 경로), [가져오기]·바뀐 항목의 받기·유지, SHP 넣기를 §7의 `site-data` 경로로 한다.
- 패널링 부품(T-253, Design SCR-33): `paneling-stages`·`paneling-surface`·`paneling-settings`·`paneling-make`(왼쪽), `paneling-summary`(`kpis`), `paneling-result`(`drawer`). 속성은 `{title?}`(요약·서랍은 없음)뿐이고 연결을 갖지 않는다 — 단계 id `preview`·`members`·`optimize`(PLAN-49 고정)의 출력을 `src/contracts/paneling.ts`의 `PanelLayout`·`MemberSet`·`PanelTyping`으로 다시 검사해 맞지 않으면 그리지 않는다. 설정값은 키로 단계에 나눈다(`src/ui/paneling/model.ts` `STAGE_KEYS`: 1단계 `pattern`·`width`·`height`·`measure`·`projection`·`axis`·`startCorner`·`flip`·`boundary`·`mergeBelow`, 2단계 `thickness`·`thicknessSide`·`joint`·`boundaryJoint`·`stockWidth`·`stockHeight`, 3단계 `flatnessTol`·`planarize`·`typeTol`·`maxTypes`·`flatRadius`·`nodeAngleStep`; 다른 키는 `group`이 `1`·`2`·`3`으로 시작하거나 '미리보기'·'부재'·'최적화'를 담으면 그 단계). 값의 출처는 `by`에서 온다(`default` → 가정, `decision` → 질문 카드, `fact` → 프로젝트 자료, `ai` → AI 제안 받음, 그 밖 → 사람 입력). 만들기 단추는 단계별 만들기 id `preview`·`members`·`types`(T-255·T-257의 `jig.json` `bake[]`)를 `bake-card`와 같은 `POST …/bake`로 보내며, 계약의 `makeAllowed`가 거짓이거나 결과가 없거나 '다시 계산 필요'이면 막고 이유를 보인다. [이 값으로 확인]은 같은 값을 `PUT …/params {by:'user'}`, 질문 카드 답은 `{by:'decision'}`으로 쓴다. 기준 면 카드는 T-251 경로를 쓴다: `GET /api/v1/projects/:id/paneling/surface?instanceId=` → `{key, picked|null, documentName?, summary{toMeters, extent[m,m,m], …}, changed}`를 읽어 면 수·범위·문서 단위(`toMeters`에서)와 '기준 면이 바뀜'을 보이고, [고른 면 쓰기]·[다시 읽기]는 `POST …/paneling/surface/read {instanceId, mode:'pick'|'reread'}`를 부른다. 거절은 `{ok:false, code, message}`(§9.1 읽기 틀의 코드와 `PICK_NONE`·`PICK_MANY`·`HOST_NOT_CONNECTED`·`ATTACHED_ONLY`)로 와서 이유 한 줄로 보이고 이전 표본은 그대로이며, 원격 화면은 `FORBIDDEN`(403). 패널은 jig 겹침 층 `paneling-panels`의 `mesh` 항목(2단계는 부재의 닫힌 메쉬, 그 밖은 꼭짓점 부채꼴)으로 그리고 색은 겹침 토큰과 범주 색 `--ov-cat-1`…`12`(`OverlayTone`)다. `viewport-overlay`·`plan-map` 층의 `shape`에 `mesh`(행 필드가 3D 윤곽이면 부채꼴, `{v, f}`면 그대로; 평면 지도는 그리지 않음)를 더했다.
- 근거 칩: 설정값을 그리는 부품(`slider`·`choice`·`stepper`·`toggle`·`param-group`·`slider-board`)과 `fact-badge`는 값마다 칩 하나를 붙인다. 칩은 값의 출처(`by`: `default` 기본값·`user` 사용자·`decision` 사용자 결정·`fact` 프로젝트 자료·`ai` AI 제안·`rhino` 모델·`sketch` 스케치)와 그 상태(기본값이면 선언된 근거의 `status`: 가정·선택·물어볼 것, 자료면 진술의 검토 상태: 미확정·근거 무효·대체됨, 확정이면 상태 글자 없음)를 보인다(SPEC-07.6). 진술에 기댄 칩은 `data-fact-statement`를 달아 누르면 진술 창을 연다(`src/ui/kit/settings.tsx` `FactBadge`).
- 연결은 단계 출력 경로(`step.<id>.<field>…`), 설정값(`$<key>`), `params`, `inputs.<key>…`, `ledger.<name>`뿐이다. 식·코드는 넣지 않는다.
- 색은 Design §02의 토큰 이름만 쓴다. `#`·`rgb(`·`hsl(`로 시작하는 값은 거절한다.
- `custom-view`는 1차에 거절한다(B13).
- `tier`는 서버 확인 등급이며 화면에 보이지 않는다.

### 5.2 보고서 틀 `reports/<name>.json`

- `template: 'study'` 하나(1차). 머리·KPI·절·출처 줄·원장 절을 선언한다.
- 헤드라인·절 주장은 틀 문장 목록 `cases[{ when, template }]`이다. `when`은 닫힌 형식만 허용한다: `<경로> <연산자> <경로|숫자>`를 `&&`로 잇고, 연산자는 `== != < <= > >=`다. 틀의 `{경로}`는 결과 값으로 채운다. AI 1회 다듬기(`polish: 'ai-once'`)는 선택이다.
- 보고서 점검은 `claim-consistent`(쓰인 틀의 `when`이 참), `numbers-in-source`, `unchecked-listed`, `combo-echo`다(§11).
- 렌더러는 `src/server/report.ts`를 넓힌다. 스크립트 없는 CSP와 외부 요청 없는 HTML을 유지한다.
- **내보내기 조건(선택, T-213):** `export: {when, refused}`. `when`은 헤드라인과 같은 닫힌 조건이다. 틀에 `export`가 있으면 `when`이 거짓이거나 보고서 점검(`claim-consistent`·`numbers-in-source`·`unchecked-listed`) 하나라도 실패하거나 확정되지 않은(다시 계산 필요·미리보기) 단계 결과가 있을 때 해석된 보고서에 `exportRefused: string[]`(이유)를 싣고, §7 보고서 경로는 `html`을 빈 문자열로 준다. 보고서 탭은 [인쇄]·[HTML 저장]을 끄고 이유를 보이며, 패널의 보고서 부품도 '내보내지 않음'을 보인다. `export`가 없는 틀은 지금처럼 점검 실패를 '확인 필요'로만 보인다. 건축개요(SPEC-12.13 4)가 `step.check.mismatchCount == 0 && step.check.floorsCount > 0`으로 쓴다.

### 5.3 `skill.md`와 skill 시작

`skill.md`는 jig = skill 계약(SPEC-07.18, [ADR-026](../decisions/ADR-026-chat-stage-and-skill-jigs.md))의 '언제 쓰는가'를 담는다. 공급자 CLI의 skill로는 로드하지 않는다. 목록 표시는 1,536자 이하.

| 앞머리 필드 | 형식 | 쓰임 |
|---|---|---|
| `name` | 문자열(100자) | 목록·경로 줄의 이름 |
| `description` | 한국어 문자열(500자) | 무엇을 하고 언제 쓰는지. 판정 후보 목록에 싣는다 |
| `examples` | 문자열 배열 | 이 jig로 가야 할 요청 예문 |
| `invocation` | `auto` \| `user-only` | 판정·AI가 스스로 열 수 있는지. 없거나 다른 값이면 `auto`. 고정 전 초안은 선언과 관계없이 후보에 넣지 않는다 |
| `words` | 문자열 배열 | 규칙 판정 낱말(Jev 없음·실패·지연 때) |
| `not_for` | 문자열 배열 | 쓰지 않는 경우. 판정에서 빼는 근거 |
| `intent_en` | 문자열(600자) | Jev 판정용 영어 한 줄. 있으면 Jev는 이것을, 없으면 `description`을 읽는다 |
| `tools`, `limits` | 배열 | 기존 그대로 |

배열은 한 줄 목록(`[a, b]`)과 블록 목록(`- a`)을, 긴 글은 블록 문자열(`|`·`>`)을 받는다. 형식이 맞지 않는 필드는 빼고 읽는다.

**카탈로그 로더.** 순수 부분(앞머리 파서, 정렬, 판정 후보 만들기)은 `src/ui/skill-catalog.ts`이고 화면과 엔진이 같이 쓴다. 파일은 엔진(`src/server/skill-catalog.ts`)이 공식·설치·프로젝트 jig 패키지의 `skill.md`와 `jig.json`에서 읽는다. 항목은 `{id, name, kind: 'instance' | 'legacy', scope: 'project' | 'available' | 'official', description, examples, intent, words, notFor, invocation, open, fromRequest, autorun}`이며, `scope`는 이 프로젝트에 고정된 jig → 이 PC에 있는 다른 jig → 하드코딩 공식 목록 순으로 정렬한다. 경로 판정(`request-route.ts`·`request-router.ts`)은 `invocation: 'auto'`인 항목만 후보로 받는다. 하드코딩 `OFFICIAL_JIG_ROUTING`·`officialJigs`는 카탈로그를 읽지 못할 때와 레거시 jig(`kind: 'legacy'`, 작업본 없음)의 대체다. Jev에는 SPEC-02.17의 4의 항목만 보낸다.

**skill 시작 `startSkill(jigId, request, mode)`.** 판정 경로, AI 도구 `jig_open`, 사람의 [열기]가 같은 클라이언트 함수를 부른다(1차는 서버 오케스트레이터 없이 기존 경로와 폴링을 쓴다).

1. 작업본: `open.reuse`가 `last`이면 `GET …/jig-instances`에서 그 jig의 마지막 작업본, 없거나 `new`이면 `POST …/jig-instances`로 만든다. 새 작업본의 `layerRoot`는 `open.layerRoot` 틀을 채운 값이다(`{jig}` = id의 마지막 부분, `{jigId}` = id 전체, `{n}` = 이미 쓴 값과 겹치지 않는 다음 번호). 계획 모드는 재사용만 한다.
2. 화면: 그 작업본의 jig 화면(지금은 문맥 탭)을 연다.
3. 대화: 대화 기록의 `jigInstanceId`를 채운다(SPEC-02.19의 1의 묶기 규칙). 이 값이 있어야 그 대화 턴에 `jig_set`·`jig_run`이 발급된다.
4. 기록: 판정 기록(`/route` 기록)과 대화 원장에 판정 근거·작업본·새로 만들었는지를 남긴다.
5. 요청의 값: `from_request`에 있는 설정값만 요청 글에서 코드가 읽어 `PUT …/:iid/params`(`by: 'user'`, 한 번의 요청)로 적용한다.
6. 자동 계산: `POST …/:iid/run {mode: 'preview', until}`. `until`은 `autorun.until`이 단계 id이면 그 단계, `first-hard`이면 `kind: 'human'`이고 `blocks`가 비어 있지 않은 첫 단계다. 그런 단계가 없으면 사람을 기다리지 않는 단계를 모두 돈다.
7. 결과: `summary.kpi`의 값과 멈춘 단계·이유를 결과 카드로 남긴다.

[일반 대화로]는 1에서 새로 만든 작업본 삭제, 5의 `params/undo`, 3에서 새로 만든 대화 닫기 또는 이번 시작이 묶은 기존 대화(어느 jig에도 묶이지 않았던 [+]의 빈 탭 등)의 묶기 풀기(`POST …/:cid/unbind {jigInstanceId}`, 그 작업본에 묶여 있을 때만), 이전 화면 복귀, 같은 글의 AI 턴 전송, `/route/revert` 기록을 한 번에 한다(SPEC-02.17의 3). 묶기를 푼 대화의 턴에는 `jig_set`·`jig_run`이 없다.

**AI 도구.** 턴마다 주는 도구 목록의 정본은 ARCH-01 §3이며, 아래 두 도구를 더한다(ARCH-01 반영은 PLAN-26 T-076).

| 도구 | 인자 | 동작 | 계획 모드 |
|---|---|---|---|
| `jig_open` | `{jigId, reuse?: 'last' \| 'new'}` | `startSkill`의 1~4(계획 모드) 또는 1~7(자동 모드). `invocation: 'user-only'`·초안은 거절하고 제안 카드를 돌려준다 | 준다(재사용만) |
| `ui_go` | `{stage, view?, focus?}` | VIDE 화면만 옮긴다. 호스트·작업본·설정값을 바꾸지 않는다. 한 턴에 한 번 | 준다 |

두 도구는 화면이 실행하는 프런트 동작이다. 엔진이 호출을 화면에 넘기고 결과(열린 작업본 id, 옮긴 화면)를 도구 결과로 돌려받는 물리 경로는 T-076 구현에서 정하고 이 절에 적는다. 원격 세션 제한(ADR-010 §3)은 원래 경로의 검사를 그대로 받는다.

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
- **이전 출력.** 앞 단계 출력은 이번 계산의 결과를 단계 id로 받는다. 단계가 자기 자신(`step.<자기 id>`)을 읽는다고 선언하면 `inputs.steps[자기 id]`로 그 작업본에서 **마지막으로 보관한 자기 출력**(없으면 `null`)을 받는다. 그래프 순서에는 영향이 없고(자기 참조는 선행 관계가 아님) 지문에도 들어가지 않는다. 보관 출력은 `jig_runs`와 캐시 파일에 있으므로 다시 계산·엔진 재시작 뒤에도 이어지고, 결과 없이 실패한 실행은 마지막 보관 출력과 그 지문을 지우지 않는다. 미리보기 계산은 보관하지 않는다. S-06 부호 원장(`schedule.ledger`)이 이 방식으로 이어져 같은 부재는 같은 부호를 유지하고 번호는 다시 쓰지 않는다(SPEC-06.12).
- **적용 요청.** 단계 출력의 `apply.overrides`(각각 고정 `id`를 가진 §4 수정 사항)는 엔진이 작업본 수정 사항에 id 기준으로 덮어쓴다. 실제 계산(미리보기·자체 시험이 아니고 캐시 재사용이 아닌 실행)에서만 받으며, id 없는 항목은 버린다. 쓰면 모든 단계가 오래된 결과가 되고 엔진은 한 번 더 계산해 그 결과를 돌려준다. 적용 단계 앞에는 사람 단계를 두어, 적용 뒤에는 바뀐 지문 때문에 다시 확인을 기다리게 한다(S-06 [선정 단면 적용], SPEC-06.12).

### 6.3 엔진 단계 실행기

- `graph.ts`가 `needs`·`reads`로 DAG를 만들고 바뀐 입력을 읽는 단계와 그 뒤만 다시 돌린다. 캐시 키 = sha256(패키지 digest, 단계 id, 읽은 입력의 해시, 읽은 설정값, 수정 사항). 결과는 §2.3 캐시 파일과 `jig_runs`에 둔다.
- `library` 단계는 실행기가 아니라 엔진이 돌린다. 공식 라이브러리의 순수 TS 부분(`geometry-kit`)은 실행기 묶음에 복사해 쓸 수 있다.
- 무거운 공식 계산(구조 해석·단면 선정)은 `worker_threads`에서 돌리고 같은 작업본의 가장 최근 요청만 남긴다. 엔진 스레드에서 동기 napi를 부르지 않는다.
- 입력 개수에 따라 단계 수가 늘어나는 구조는 없다. 목록은 단계 안에서 처리한다.

### 6.4 Node 자식 프로세스(`dev-pack`)

- 띄우기: `node --permission --allow-worker --allow-addons --allow-fs-read=<패키지 폴더> --allow-fs-read=<실행기 진입 파일 폴더> [--allow-fs-read=<추가 읽기 경로>…] <child-entry.ts|.js>`(`ChildRunner.spawnArgs`, `src/jigs/runtime/child-runner.ts`. 진입 파일은 저장소에서 `child-entry.ts`, 빌드한 서버에서 `child-entry.js`). 경로마다 `--allow-fs-read`를 따로 준다(쉼표로 이으면 한 경로로 해석된다). 구조 라이브러리가 Node-API 코어를 worker 스레드에서 불러오므로 `--allow-worker`·`--allow-addons`를 주고 코어 폴더 `src/native/structure`(저장소의 `target/release/vide_structure.dll`, 설치본의 `app/src/native/structure/vide_structure.node`)를 읽기로 허용하며, 쓰기·자식 프로세스 허용 플래그는 주지 않는다. 런타임은 설치본의 Node 24.15다.
- `env`에는 `PATH`, `SystemRoot`만 넘긴다(부모 환경의 키가 보이지 않게). Windows에서는 libuv가 자식 환경에 고정 필수 변수(`HOMEDRIVE`·`HOMEPATH`·`LOGONSERVER`·`SYSTEMDRIVE`·`TEMP`·`USERDOMAIN`·`USERNAME`·`USERPROFILE`·`WINDIR`)를 더하며 그 밖의 변수는 없다(기동 시험이 확인). 묶기 전 저장소 소스(`dev-source`)는 상대 import를 위해 `src/jigs/official`과 `node_modules` 읽기를 추가로 허용한다(`devReadPaths`, `src/jigs/runtime/pack.ts`). 공식 구조 라이브러리가 재사용하는 `src/jigs/structure`와 ARCH-02 계약 `src/contracts`도 읽기만 허용한다(쓰기는 그대로 금지).
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

jig·보고서 경로는 `src/server/jig-routes.ts`, 초안 경로(`jig-drafts`)는 `src/server/make-routes.ts`, 자료 경로(`facts`)는 `src/server/facts-routes.ts`가 처리하고, 모두 ARCH-01 §1.3의 인증·Host·Origin·크기 검사를 그대로 따른다. `:iid`는 작업본 ID, `:jigId`는 URL 인코딩한 jig id(`project%2Fs06-frame`)다.

| 메서드·경로 | 본문 | 응답·비고 |
|---|---|---|
| `GET /api/v1/jigs` | — | 등록부: 공식 + 설치 버전(기존 경로를 넓힘) |
| `POST /api/v1/jigs/import` | `.vjig` 바이트 | `{id, version, digest, capabilities}`. 확인 필요 동작, 서명 확인(§12), 원격 세션 403 |
| `GET /api/v1/projects/:id/jigs` | — | 이 프로젝트에 고정된 jig·버전 |
| `POST /api/v1/projects/:id/jigs/:jigId/pin` | `{version, approvedCaps}` | `project_jigs` 행. 확인 필요 동작, 원격 세션 403 |
| `DELETE /api/v1/projects/:id/jigs/:jigId/pin` | — | JIG 목록의 [삭제]: 이 프로젝트의 jig 목록에서 뺀다(`project_jigs` 행만 지움). 설치본과 그 jig로 만든 인스턴스는 남는다 |
| `GET·POST /api/v1/projects/:id/jig-instances` | POST `{jig, version?, title, layerRoot}` | 작업본. `layerRoot`가 연결 문서에 없으면 422 |
| `GET …/jig-instances/:iid` | — | 작업본 + 단계 상태 요약 |
| `POST …/:iid/upgrade` | — | [올리기](SPEC-07.4, T-101): 작업본을 이 프로젝트의 고정 버전으로 옮긴다. 계산한 단계는 `stale`, 사람 단계는 입력 지문으로 다시 비교, 새 버전이 받는 설정값만 유지(아니면 기본값), 작업본 상태 `stale`. 이미 고정 버전이면 그대로, 고정이 없으면 404, 고정 버전이 작업본 버전보다 높지 않으면(예전 묶음을 다시 고정) `JIG_VERSION_NOT_NEWER`(409). 버전 순서는 `src/contracts/jig-version.ts`(사본의 다음 패치와 목록의 '이전 버전' 판단이 같이 씀) |
| `PUT …/:iid/params` | `{values:[{key, value}], by, reason?, requestId?}` | 다시 계산 요약 + `jig_param_log.seq`. `fixedAtPin` 값은 422 `PARAM_FIXED` |
| `POST …/:iid/params/undo` | `{seq}` | 그 변경을 되돌림 |
| `POST …/:iid/overrides` | `{add?: Override[], remove?: string[]}` | 갱신된 수정 사항 |
| `PUT …/:iid/zones` | `{zones}` | — |
| `POST …/:iid/reads` | `{linkId, layers, includeHidden, purpose}` | §8 |
| `POST …/:iid/assembly/propose` | `{roles?}` | 역할별 후보(규칙 + 단발 AI 단계) |
| `PUT …/:iid/assembly/:role` | `{sources, transform?, confirm}` | 확정된 역할 |
| `POST …/:iid/run` | `{until?, mode: 'geometry' \| 'preview' \| 'confirmed'}` | 단계 상태·KPI·겹침 층·표. `preview` 결과는 저장하지 않고 '미확정 미리보기'로 표시(SPEC-06) |
| `POST …/:iid/steps/:stepId/confirm` | `{inputHash}` | 사람 단계(입력 확인·해석 확정) 기록 |
| `POST …/:iid/bake` | `{bake: string[], linkId?, resolve?: Record<string, 'keep' \| 'overwrite' \| 'absorb'>}` | 바로 적용(연결 Rhino, §9.3의 4): 200 `{status: 'applied', runId, readId, revisionKey, linkId, gates, plans[], chunks, …만들기 결과}`, 보호·실패로 되돌렸으면 409 `BAKE_GUARDED`·422 `BAKE_FAILED`(`guarded?`·`reason?`·`undoFailed?`). 작업 사본(§9.3의 5): `{status: 'submitted', requestId, runId, readId, revisionKey, linkId, gates, plans[], chunks, waiting?}`(작업 보기로 추적). 막은 점검·인자 문제는 422 `GATE_BLOCKED`(`blocked`·`problems`·`hints`), `absorb`가 수정 사항을 더했으면 200 `status: 'absorbed'`(다시 계산 뒤 다시 누름). `linkId`는 조립 역할이 연결 하나만 읽었을 때 생략할 수 있다 |
| `GET …/:iid/bakes?linkId=` | — | 만들기 기록(새 것 먼저, `pendingBaseline`) |
| `POST …/:iid/bakes/:recordId/baseline` | — | 반영한 문서를 다시 읽어 기준 지문을 기록(§9.3 6). 그 실행의 객체가 하나도 없으면 409 `NOT_APPLIED` |
| `POST …/:iid/bakes/:recordId/undo` | — | 바로 적용한 만들기 실행의 [되돌리기](§9.3의 7). 바로 적용 드라이버나 실행 기록이 없으면 409 `BAKE_UNDO_UNAVAILABLE`, 문서의 마지막 기록이 아니면 409 `BAKE_UNDO_NOT_LATEST`, 호스트 실패는 409 `BAKE_UNDO_FAILED` |
| `POST …/:iid/site-data/:key/lookup` | `{query}` | 주소·PNU 조회(T-207, §8.3). 고지 미확인이면 `{needsConfirm, state}`(아무것도 보내지 않고 주소만 둠), 끈 프로젝트면 `{off: true, state}`. 결과 사본을 두고 하나로 맞는 후보는 `targets {by: 'proposal'}`로 둔다(사람이 고른 필지는 유지) |
| `PUT …/:iid/site-data/:key/targets` | `{pnus}`(최대 20) | 사람이 고른 대상 필지(합필). 바뀌면 그 부분을 읽는 단계가 다시 계산 필요, 사람 단계는 지문으로 다시 확인 |
| `POST …/:iid/site-data/:key/collect` | — | 대상 필지와 주변(설정값 `radius`)을 수집. 대상 필지 없음 422 `SITE_TARGETS_MISSING`, 끈 프로젝트 409 `SITE_DATA_OFF`. 같은 대상의 사본이 있으면 새 사본은 `pending`(바뀐 항목 목록)으로 기다리고, 바뀐 것이 없거나 대상이 달라졌으면 바로 쓰고 이전 사본을 `previous`(최대 5)에 둔다 |
| `POST …/:iid/site-data/:key/pending` | `{take}` | 기다리는 사본을 받거나 버림. 어느 쪽도 덮어쓰지 않음 |
| `POST …/:iid/site-data/:key/shp` | `{files: [{name, data(base64)}]}` 또는 `{clear: true}` | SHP 넣기(§8.1). 앞서 넣은 파일과 함께 EPSG:5186으로 다시 넣고, 이 작업본의 사본으로만 둔다. 응답은 레이어·거절·쓰지 않음 목록 |
| `GET /api/v1/projects/:id/jig-reports` | — | 보고서 탭 목록: 보고서 틀이 있는 작업본마다 `{instance, reports[]}` |
| `GET …/:iid/reports` | — | 그 작업본 jig의 보고서 틀 목록(설명서 `reports`, 없으면 패키지의 `reports/*.json`) |
| `GET …/:iid/jig-outputs/:key` | — | `jig-output` 입력의 상태(§8.5): `{input, chosen, current, ready, reason, candidates[{instanceId, title, version, at, ready, reason?}], used, stale}`. `current`는 고른 작업본 또는 가장 최근에 계산된 작업본(`{instanceId, title, jig, version, step, status, at, hash, reason?}`), `stale`은 마지막 계산 때 읽은 결과(`used.hash`)와 지금이 다름. 제공자가 주는 입력(법규)은 `service: true`, `chosen: null`, `candidates: []`, `current = {instanceId: '', title: '서비스 결과', jig, step: <output>, status: 'done', at: null, hash}`, `ready: true`이고 `stale`은 같은 비교(T-214 F-8) |
| `PUT …/:iid/jig-outputs/:key` | `{instanceId: string \| null}` | 앞 작업본 고르기(`null` = 최근 계산된 작업본). 같은 프로젝트의 `from.jig` 작업본만(자기 자신·다른 jig는 422 `INVALID_INPUT`). 그 입력을 읽는 단계가 `stale` |
| `GET …/:iid/reports/:name` | — | 해석된 보고서(§5.2). 보관된 단계 결과·설정값 원장·남은 조건·해석 보기를 읽고, `previewOnly` 결과는 확정으로 쓰지 않는다. 화면이 부품으로 그린다(CSP가 인라인 스타일을 막으므로 HTML을 내려보내지 않음). 일람표 CSV는 표 부품의 `csv`로 화면이 만든다 |
| `GET·POST /api/v1/projects/:id/jig-drafts` | POST `{name, from?}` 또는 `{from: {jig, version?}}` | 초안 목록·만들기(`from`은 시작 본). 201. `from`이 jig이면 [수정하기](T-101): 등록부에서 그 버전(없으면 이 프로젝트의 고정 버전)을 찾아 `project/` 도구 jig만 사본으로 만든다 — 패키지 파일을 초안 경로 규칙으로 하나씩 복사(`dist/` 묶음과 `derived` 선언은 빼고), id 유지, 버전은 그 id의 설치본·열린 초안·원본 중 가장 높은 것의 패치 +1. 출처 `{jigId, version, name, at}`는 `.results/<did>.json`의 `origin`에 두고 초안 보기에 실린다. 사본은 계산 상자에서 돌므로, 단계 소스(타입을 걷어 낸 본문)의 import가 패키지 파일·공식 라이브러리 밖(저장소 상대 경로·`node:`·꾸러미 이름)으로 가면 `JIG_NOT_FORKABLE`(422)로 거절한다(`drafts.ts` `forkable`, 판단은 상자의 모듈 규칙 `compute-box.ts` `boxImportTarget`과 같음). 등록부 목록(`GET /api/v1/jigs/packages`)의 도구 항목은 같은 판단을 `forkable`로 싣는다. 없는 jig 404, 그 밖 `INVALID_INPUT` |
| `GET·DELETE …/jig-drafts/:did` | — | 초안 하나. `DELETE`는 버리기: 상태 `discarded`, 초안 폴더와 그 초안에 붙은 만들기 대화의 공급자 기록을 지우고 열린 대화를 닫는다. 엔진이 DELETE를 받는 경로는 이것과 jig 고정 해제(위), 프로젝트 삭제(ARCH-01)뿐이다 |
| `POST …/jig-drafts/:did/validate·test·preview` | preview `{fixture?}` | 형식 점검·자체 시험·미리보기(계산 상자, §6.5). 마지막 결과는 초안 폴더 밖 `.results/<did>.json`에 둔다 |
| `PUT …/jig-drafts/:did/icon` | `{icon}` | 열린 초안의 `jig.json` `icon`만 바꾼다(목록 밖 이름 `INVALID_INPUT`, 고정·버린 초안 `DRAFT_NOT_OPEN`). 등록부 항목(`GET /api/v1/jigs/packages`)·작업본 보기(`jig.icon`)·skill 카탈로그가 `icon`을 싣는다. 내장 화면 jig(Sync·구조·자료)의 아이콘은 같은 파일의 `LEGACY_JIG_ICONS` |
| `POST …/jig-drafts/:did/pin` | `{jigId?, version?, approvedCaps?, confirm}` | 점검·자체 시험을 다시 확인한 뒤 읽기 전용 설치본(`source: ai-draft`)으로 설치하고 이 프로젝트에 고정. 확인 필요 동작, 원격 세션 403 |
| `GET /api/v1/projects/:id/facts` | — | 자료 요약(결정·막힘·바뀜, 분야별 이슈, 건수·검토 건수) |
| `GET …/facts/search` | `?q, kind?, discipline?, status?, excluded?, offset?, limit?` | 진술 검색. 응답 `{items, total, offset, nextOffset, excluded, capped, plan}`(형식은 `src/contracts/facts.ts`, 서버·화면 공용). `status=excluded`는 제외된 진술만, `excluded=1`은 제외된 진술도 함께, 둘 다 없으면 제외된 진술을 뺀다 |
| `GET …/facts/issues/:n`, `GET …/facts/statements/:n` | — | 이슈·진술 하나 |
| `POST·PUT …/facts/statements/:n/review` | `{verdict \| null, reason?, correction?, supersededBy?}` | 사람의 검토 기록(`knowledge_reviews`). `null`이면 지움. AI 도구는 쓰지 않는다 |
| `GET·POST …/facts/rules` | POST `{sourceId \| pattern, reason?, remove?}` | 출처 제외 규칙(`knowledge_source_rules`) |
| `POST …/facts/refs` | `{statementId? , factRefs?}` | 근거 참조의 유효성(확정·오염 등) |
| `POST …/facts/sources/:n/open` | — | 원본 파일을 이 PC의 기본 프로그램으로 연다(작업 PC 화면의 [원본 열기]). 원격 세션 403, AI 도구로 내놓지 않는다 |
| `GET …/facts/sources/:n/file` | — | 원격 화면의 [원본 열기](SPEC-08.4): 원본 바이트를 그 브라우저로 스트리밍한다. 자료 DB 루트 아래 경로만(`..`·링크·junction으로 벗어나면 거절), 200 MB 넘으면 `SOURCE_TOO_LARGE`. PDF·이미지·텍스트는 `inline`, 그 밖(HTML·SVG 등 실행될 수 있는 형식 포함)은 `attachment`로 내려받게 하고 `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. 이 PC에서 프로그램을 실행하지 않는다. 실패는 한국어 한 문장(text/plain)으로 답한다 |

- 기존 `POST /api/v1/projects/:id/jigs/sync`와 구조 jig 경로(ARCH-02 §1)는 그대로다.
- 오류 코드(잠정): `JIG_INVALID`(형식·금지 파일·부품, 응답에 `issues[]`), `JIG_SIGNATURE`(서명), `JIG_VERSION_EXISTS`(같은 id·버전, 다른 내용, 409), `JIG_NOT_FORKABLE`(422, 단계가 jig 밖을 가져와 사본을 만들 수 없음), `JIG_VERSION_NOT_NEWER`(409, 고정 버전이 작업본보다 높지 않아 올릴 수 없음), `PARAM_FIXED`, `OUT_OF_RANGE`, `GATE_BLOCKED`(막은 점검 이름 목록 포함), `STALE_INPUT`(읽은 문서 버전이 현재와 다름), `LAYER_ROOT_MISSING`(422, 출력 레이어를 아직 정하지 않은 작업본의 만들기 — 화면이 묻는다), `LAYER_PATH_INVALID`(422, §9.5의 경로 규칙 위반), `CONFIRMATION_REQUIRED`(확인 없는 가져오기·고정), `JIG_PANEL`(`panel.json`이 §5.1 검사에 걸림, `JIG_INVALID`의 `issues[]`로). 만들기: `BAKE_NOT_COMPUTED`(422, 항목을 내는 단계가 계산되지 않음), `BAKE_JOB_MISSING`(409, 그린 본문이 엔진에 없음 — 재시작 뒤 남은 만들기 요청), `NOT_APPLIED`(409), 바로 적용의 `BAKE_GUARDED`(409)·`BAKE_READ_FAILED`(409)·`BAKE_UNDO_UNAVAILABLE`·`BAKE_UNDO_NOT_LATEST`·`BAKE_UNDO_FAILED`(409); 요청 결과 코드 `BAKE_TEMPLATE_REJECTED`(워커의 컴파일·`CodePolicy` 거절)·`BAKE_FAILED`·`BAKE_RECEIPT_MISMATCH`(영수증의 키가 계획과 다름). 초안: `DRAFT_NOT_OPEN`(409, 고정·버린 초안에 쓰거나 그 만들기 대화에 턴을 보냄), `DRAFT_OUTSIDE`·`DRAFT_FORBIDDEN_FILE`·`DRAFT_PATH_INVALID`(422, 초안 밖 경로·금지 파일·잘못된 경로), `DRAFT_TEMPLATE_MISSING`(500). 상태 번호는 ARCH-01 §1.3 매핑(400·403·404·409·422)을 따르며 `src/server/jig-routes.ts`의 `jigStatuses`와 `src/server/make-routes.ts`의 `makeStatuses`가 정본이다.
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

### 8.1 SHP 넣기와 좌표계 (`vide/site-data` · `shp/`)

사이트 모델링(SPEC-12.4·12.5)이 사람이 넣은 수치지형도·연속지적도 SHP를 읽는 물리 계약이다. 코드는 `src/jigs/official/site-data/shp/`(순수 TS, node: 가져오기 없음)이고 PLAN-45 T-206이 만들었다. 출처는 S-02 Site Maker의 importer와 S-04 검토엔진 `geo.js`를 TS로 다시 쓴 것이다.

- **입력:** `{name, bytes}` 목록. `.zip`은 한 단계 풀고(stored·deflate, `DecompressionStream`), 확장자를 뺀 경로가 같은 파일을 한 레이어로 묶는다. `.shp`·`.dbf`·`.prj` 가운데 하나라도 없으면 `MISSING_PAIR`와 빠진 확장자로 그 레이어만 거절한다. `.shx`는 읽지 않는다. 형상 수와 속성 수가 다르면 `SHP_DBF_MISMATCH`.
- **형상:** 점·다중점·선·면과 각 Z·M 형(1·3·5·8·11·13·15·18·21·23·25·28)을 읽고 M은 버린다. 다중패치(31) 등은 `SHP_UNSUPPORTED_TYPE`.
- **좌표계 판별:** `.prj`(ESRI·OGC WKT1, WKT2)를 구문 분석해 투영(횡단 메르카토르만)·타원체·중앙 자오선·축척계수·원점 위도·가산값으로 판별한다. 이름은 보지 않는다. 알려진 값과 같으면 EPSG를 붙인다: 5179(UTM-K), 5185~5188(서부·중부·동부·동해 원점, FN 600000), 5180~5184(같은 원점의 FN 500000·제주 550000), 32651·32652(UTM 51N·52N), 4326·4737(경위도). 매개변수가 다 있는 GRS80·WGS84 TM은 EPSG 없이 쓴다. GRS80과 WGS84는 같은 것으로 본다(데이텀 변환 없음).
- **거절:** Bessel 타원체(이름·장반경 6377397.155·Tokyo/Korean Datum 1985 데이텀) `CRS_BESSEL`, 그 밖의 타원체·그리니치 아닌 본초 자오선 `CRS_UNSUPPORTED_DATUM`, TM 아닌 투영 `CRS_UNSUPPORTED_PROJECTION`, m 아닌 단위 `CRS_UNSUPPORTED_UNIT`, `.prj` 없음·빈 파일 `CRS_MISSING`, 읽을 수 없음 `CRS_UNREADABLE`. 거절은 그 레이어만이며 나머지는 계속 넣는다.
- **투영식:** Krüger 급수 6차(Karney 2011). 정·역변환과 격자 수렴각 γ를 같은 급수로 낸다. γ는 진북에서 도북까지 시계 방향 각(중앙 자오선 동쪽이 양수)이고 진방위 = 도방위 + γ다.
- **인코딩:** `.cpg`가 밝힌 것(UTF-8·EUC-KR/CP949 계열·Latin-1 이름들), 없으면 DBF 언어 드라이버 바이트 0x79(949)를 EUC-KR로 읽는다. 둘 다 없으면 엄격한 UTF-8로만 읽고 경고를 단다. UTF-8이 아니면 `ENCODING_UNDECLARED`로 거절하고, 모르는 선언은 `ENCODING_UNSUPPORTED`다.
- **한 좌표계·한 기준점:** 대상 좌표계는 호출자가 고르거나(평면 좌표계만) 첫 연속지적도 레이어 → 첫 평면 레이어 → 경위도뿐이면 경도에 맞는 5185~5188 순으로 정한다. 기준점은 호출자가 주거나, 거절되지 않은 모든 레이어(쓰지 않는 레이어 포함)의 범위 네 모서리를 옮긴 범위의 중심을 m 단위로 내린 값이다. 레이어 순서·선택과 무관하다.
- **출력:** `{frame, layers[], ignored[], rejected[]}`. `frame = {crs, origin(f64 3), convergenceDeg, trueNorth(로컬 단위 벡터), originLatLon}`. 좌표는 기준점에서의 f64 로컬 m이고, Rhino로 넘길 때만 `packOffsets`로 f32 차이가 된다(§9.2, SPIKE-2026-10-07-envelope). 레이어는 역할(`building`·`road-boundary`·`contour`·`spot-height`·`parcel`)·원 좌표계·옮김 여부·원 격자와의 회전각·인코딩·필드 한글 이름·개수(`records`·`deleted`·`nullShapes`·`features`·`reversedRings`·`skippedParts`)·로컬 범위·경고를 갖는다. 면은 포함 깊이로 바깥 고리·구멍을 나누고 바깥 반시계·구멍 시계로 맞추며 닫는 점을 뺀다. 형상마다 원 레코드 번호·원 속성·코드값 한글 뜻을 남기고, 건물은 층수·종류·용도·이름·무벽건물(BDK005) 표시를, 등고선은 `CONT`, 표고점은 `NUME`(없으면 `ALTI`, 그다음 Z)을 높이로 둔다.
- **코드 사전:** `site-data/assets/ngii-codes.json`(연속수치지형도 데이터 설명서 Ver 5.1.1에서 뽑은 레이어 107·속성 66·코드값 503·통합코드 423), 출처·해시는 `site-data/assets/NOTICE.json`. 쓰는 레이어는 파일 이름의 지형지물 코드로 정한다: B0010000 건물, A0010000 도로경계, F0010000 등고선, F0020000 표고점. 연속지적도는 `PNU`와 `JIBUN`(또는 `BCHK`) 필드로 알아본다. 나머지는 `ignored`로만 보인다.
- **보관:** 이 모듈은 아무것도 저장하지 않는다. 넣은 파일과 결과는 호출하는 jig(T-207)가 작업본 사본으로만 둔다. 라이브러리 등록(`LIBRARY_MODULES`의 `vide/site-data`)은 T-205가 했다. 등록된 모듈 `site-data/library.ts`는 이 SHP 읽기와 PNU 도움 함수만 내놓고, 키가 필요한 공공 자료 수집(`lookupParcel`·`collectSite`)은 엔진만 부른다(ARCH-01 「공공 자료 수집」).

### 8.2 가능 영역과 외피 (`vide/geometry-kit` `solid.ts` · `vide/massing-kit`)

건축 가능 영역·매스 jig(SPEC-12.7~12.9)의 계산 위치와 형식이다. PLAN-45 T-209·T-210이 만들었고, 계산 위치(엔진)와 허용 오차는 [SPIKE-2026-10-07-envelope](../tdd/SPIKE-2026-10-07-envelope.md) 결론을 따른다.

- **`geometry-kit/solid.ts`(일반 기하, 법규 없음):** 평면 다각형 솔리드의 BSP 불리언(합·차·교, csg.js 계열 알고리즘을 TS로 다시 씀, 평면 허용 오차 1e-7 m), 용접(1e-7 m, 평면 허용 오차보다 굵게 하지 않음)과 T자 이음 보정, 닫힘 점검 `checkSolid`(열린 변·비다양체 변·껍질 1·오일러 지표 2·부피 양수·퇴화 다각형, 경고로 1e-4 m보다 짧은 면 사이 변), 수평 단면 면적, 덮개 귀 자르기(`earClip`; `triangulate`는 가는 삼각형을 버리는 망 규칙이 있어 덮개에 쓰지 않음), 돌출(`prismSolid`)과 대응 변이 평행한 두 고리 사이 솔리드(`loftSolid`), 같은 평면 다각형 병합 `mergeCoplanar`. 병합은 같은 평면(법선·거리 1e-5 반올림)이고 변으로 이어진 다각형을 바깥 고리(밖에서 볼 때 반시계) + 구멍으로 잇되 꼭짓점을 하나도 지우지 않는다(이웃 면의 변이 1:1로 맞게). 구멍 있는 평면 영역의 프리즘 `regionPrismSolid`(T-214 F-6): 고리를 정리하고(`cleanRing`: 1e-6 m 안의 겹친 점, 1e-10 rad 아래의 일직선 점·폭 0인 뾰족점 제거) 덮개는 볼록이면 한 면, 구멍이 없으면 귀 자르기, 구멍이 있거나 귀 자르기가 멈추거나 요청하면 고리 꼭짓점만으로 한 제약 들로네 삼각분할(`triangulate.ts` `regionTriangles`: 고리 변의 왼쪽 삼각형에서 시작해 고리 변을 넘지 않고 퍼지는 안쪽 판정, 점 포함 판정 없음)이며, 고리 변마다 벽 사각형 하나라 모든 변이 정확히 두 면에 걸린다(불리언·용접 보정 없음). 구멍이 관통하면 오일러 지표 0이라 외피 점검은 거절한다. 좌표는 로컬 m(대지 근처 기준점)이어야 한다. 라이브러리 판은 0.2.3(덧붙임만, `^0.2.0` 호환).
- **`massing-kit/`(규칙):** `rules.ts`(규제 조건 항목의 닫힌 목록 `REGULATION_ITEMS`, 항목 형식 `{id, group, title, value, unit, applies, status, origin, basis, source, target?}`, 닫힌 규칙 목록 `RULES`, 설정값 → 항목 `regulationsFromParams`, 사람 값 우선 병합 `mergeRegulations`), `legal-adapter.ts`(SPEC-13 결과 → 항목 `regulationsFromLegal`, PLAN-46 T-220: 입력 `legal`이 없으면 '법규 결과 없음', 있으면 `vide.legal.constraints@1`의 제한마다 닫힌 표 `LEGAL_KEYS`(서비스 키 → 항목 ID와 받는 단위, 예: `sunlight.baseHeight`→`sunBaseHeight` m, `sunlight.setbackUpTo10m`→`sunNearDistance` m, `sunlight.setbackRatioAbove10m`→`sunRatio` ratio, `density.coverageRatio`→`coverage`, `height.max`→`heightMax`, `buildingLine.roadSetback`→`roadSetback`, `setback.civil`→`civilSetback`)로 값을 그대로 옮긴다. 항목은 `applies`(적용·미적용·판단 필요), `status`(판단 필요 → '판단 필요', 서비스 확정 → '확정', 서비스 해석 → '가정'), `origin`('서비스 확정'·'서비스 해석'), `basis{clause: 조항들, link: 첫 원문 링크, note: 'L<n> · 키'}`, `source: legal.L<n>:<키>`를 가진다. 일조 값을 준 답은 같은 무리의 적용 여부 항목 `sun`에 그 답의 적용 여부와 조항을 준다(값 없음). 표에 없는 키·다른 단위·쓸 수 없는 값은 `unmapped`로 보이고 아무 항목도 채우지 않는다. 사람 값 우선은 `mergeRegulations` 그대로다), `boundary-segments.ts`(대지 변을 도로·인접 필지 변과 겹치는 구간으로 나눔, 둘 다·아무것도 아니면 `unknown`·'확인 필요', 닫힌 도로 영역에서 구간 바깥 법선으로 잰 도로 너비), `setback.ts`(제한선 자료 `Cutter`: 선분 캡슐(둥근 끝은 외접 64각형, 같은 규칙의 다음 구간이 볼록·일직선 모퉁이에서 같거나 큰 거리로 덮으면 평평한 끝) · 다각형(가각 삼각형, 건축한계선의 도로 쪽), 일조 `SunRule`(기준선 선분·기준 높이·이하 거리·비율·거리 정의·정북 단위 벡터·적용 구역), 1 m 판으로 잰 2D 가능 영역과 규칙별 감소. 판 자르기 `cutSlab`은 결과에 열린 변·비다양체 변·퇴화 다각형이 있거나 윗면이 영역으로 닫히지 않으면 같은 자르기를 다른 순서(합의 역순, 하나씩 빼기)로 다시 하고, 모두 실패하면 첫 결과를 예전처럼 쓴다. 솔리드용 절삭 `solidCutters`(T-214 F-6): 같은 규칙·같은 반경의 이어진 캡슐 가운데 끝점이 모두 한 현에서 `MERGE_DEVIATION` = 1 mm 안(이음 틈 5 cm 안)인 구간을 그 현의 캡슐 하나로 합치고 반경을 그 편차만큼 키운다(선분까지 거리는 볼록이라 원래 캡슐을 모두 덮음 — 안전 쪽, 키운 캡슐의 끝은 둥글게). 일조 기준선도 최단 거리일 때 같게 합치고(`sunPieces`), 정북 거리일 때는 합치지 않는다. 단계 출력의 `cutters`는 구간별 그대로이고 솔리드만 합친 조각으로 만든다), `envelope.ts`(돌출·일조 사선·최대 외피. 돌출 외피 = 2D 가능 영역(같은 절삭을 1 m 판에서 `cutSlab`)의 영역별 `regionPrismSolid`이고, 점검을 통과하지 못하면 삼각분할 덮개, 다음으로 예전 구성(대지 기둥 − 높이 전체 절삭)을 차례로 해 본다. 일조 사선 외피 = 대지 기둥 − 일조 절삭(합, 역순 합, 조각 `sunCutPieces` 하나씩 빼기 순), 최대 = 돌출 − 일조 절삭, 돌출 ∩ 일조 사선 외피, 역순, 하나씩, 예전 돌출 − 일조 순으로 처음 점검을 통과한 것. 모두 실패하면 첫 실패 이유로 '점검 실패'), `solid-check.ts`(점검과 만들기 면 목록), `steps.ts`(jig 단계 함수; 정북 `northOf`: 정북 기준 `site`(사이트 모델링 따름, 기본)이고 입력 `siteModel`의 대지 요약이 있으면 그 `northBasis`·`convergenceDeg`(사이트 모델링 문서의 +Y = 도북, 진북 = +Y를 수렴각만큼 반시계로 돌린 방향이라 `northDeg = −convergenceDeg`), 사람이 `true`·`grid`를 고르면 설정값 `gridNorthDeg`·`convergenceDeg`, 출처는 `site.northSource`. 일조 기준선 가운데 바깥 법선이 정북과 80°보다 크게 벌어진 구간은 그대로 기준선으로 계산하고 '판단 필요 — 정북과 거의 수직인 구간…'을 미반영·판단 필요 목록과 미확정 1개로 남긴다(VERIFY-2026-10-08 F-7, 넘겨줄 결과에서 상태 '판단 필요')).
- **일조 거리:** `euclidean`이면 기준선 선분까지의 최단 거리(벽 = 캡슐 기둥, 사선 = 반경 `비율 × z`인 캡슐 사이 솔리드), `north`이면 정북으로 잰 거리(벽·사선 = 선분을 남쪽으로 `r`만큼 민 평행사변형, 사선은 `r = 비율 × z`). 정해지지 않았으면(`ask`) 최단 거리로 계산하고 미확정 1개를 더한다(최단 거리 ≤ 정북 거리라 더 많이 깎는다).
- **jig 단계 출력(`vide/buildable-mass`):** `site`(로컬 고리·구간·모퉁이·도로 영역·정북 벡터), `regulations`(항목·법규 결과 `legal{available, reason, unmapped[], left[]}`·차이·사람 입력 필요·미확정), `plan`, `limits`(`cutters`·`sun`·미반영 조건·구간별 규칙 표·`sides`), `buildable`(면적·영역 고리·변형별 면적·규칙별 감소와 근거 항목·건폐율 비교·빈 영역 메시지·만들기용 곡선 `lines`), `envelope`(변형 `base`/`without`별 높이 상한과 출처·외피 부피·점검·층 중간 높이 단면·일조가 줄인 부피, 만들기 항목 `items`). 외피 항목은 `{key: env:<변형>:<종류>, kind, faces, volume, volumeText, rules, unconfirmed}`이고 만들기 선언 `envelopes`가 `vide.bake.brep-faces@1`로 보낸다. 엔진은 보내기 전에 병합한 면의 감긴 부피가 점검 부피와 상대 1e-9 안인지 확인한다. 변형마다 점검한 최대 외피의 용접 메쉬 `maxMesh {v, f}`를 함께 넘긴다(층 나누기·사람 수정 점검용).

### 8.3 공공 자료 입력 `site-data` (T-207)

사이트 모델링(SPEC-12.3·12.4)의 입력이다. 수집은 엔진이 `vide/site-data`(키는 엔진만 가짐)로 하고, 단계는 엔진이 둔 읽기 사본만 읽는다(계산 단계에 네트워크·키가 없음, SPEC-07.9).

- **보관:** 작업본 본문 `siteData[<key>] = {query?, lookup?, targets?: {pnus, by: 'proposal' | 'user', at}, collection?, pending?: {…, changes[]}, previous?: […], shp?: {…, files, raw}}`. 사본 참조는 `{ref, hash, at}`(수집 사본은 `fetchedAt`·`pnus`·`radius`를 더함)이고 내용은 `<data>/jigs/site/<instanceId>/<key>-<이름>-<hash16>.json.gz`다. `shp.raw`는 넣은 파일(base64) 사본이라 더 넣을 때 함께 다시 넣고, `shp`는 지오메트리·역할·건물/필지/높이 값만 남긴 가져오기 결과다(원 속성은 버림).
- **단계에 주는 값:** `input.<key>`는 `{query, lookup, targets: {pnus, by}, collection: {…수집 결과, radius}, shp}`이고 부분을 `input.<key>.<part>`(`query`·`lookup`·`targets`·`collection`·`shp`, 설명서 검사 `SITE_DATA_PARTS`)로 따로 읽는다. 지문은 부분마다 사본 해시로 낸다. `targets`의 지문은 PNU 목록만이라 누가 제안했는지는 대상 필지 확정(`confirm-target` 사람 단계)을 다시 묻지 않는다.
- **바뀜:** 경로가 바꾼 부분을 읽는 단계만 `stale`이 되고 사람 단계는 지문 비교로 다시 확인한다.
- **만들기:** 사이트 jig의 만들기 선언은 `requires: ['target-confirmed']`로 확정 전 만들기를 막는다(§11).

### 8.4 층·대안·용도·주차 (`vide/massing-kit` 0.2.0~, PLAN-45 T-211·T-212)

건축 가능 영역·매스 jig(SPEC-12.10~12.12)의 외피 뒤 단계다. 계산은 모두 엔진(TS)이고 `geometry-kit/solid.ts`의 불리언으로 평면 영역(`PlanRegion {outer, holes}`)을 다룬다. 법정 값은 코드에 없다.

- **파일:** `floors.ts`(층 높이 목록 `floorLevels`, 층 윤곽 = 최대 외피 ∩ 층 판의 윗면(`floorRegions`; 외피가 수직 프리즘(꼭짓점 높이가 둘)이면 불리언 없이 그 윗면, T-214 F-6), 윤곽 프리즘이 외피 안인지 `floorFits`, 지하 윤곽 = 대지 − 모든 변의 캡슐(지하 이격), 영역 합·차·교와 면적, 위층 축소 `trimRegions`: 정북에 수직인 선의 위치를 면적으로 이분 탐색하고 영역은 불리언으로 자름), `alternatives.ts`(닫힌 대안 목록 `max`·`base`·`incentive`·`open-space`·`human-k`, 상한 8, `trimToCap`, 표 줄 `alternativeRow`), `open-space.ts`(필요 면적, 그린·모서리 후보, 고를 후보), `use-mix.ts`(용도 표, 허용 용도 대조, AI 초안 받기 `acceptUseDraft`), `parking.ts`(법정 대수, 진입 가능 구간, 방식 대안), `landscape.ts`(법정·계획 조경 면적), `mass-steps.ts`(단계 함수).
- **수정 사항(SPEC-07.8)의 종류:** 라이브러리 단계는 셋째 인자로 작업본의 수정 사항을 받는다. `{kind: 'regulation', identity: {id, target?}}` `set` `{value, applies, basis?}`(목록·대상별 규제 조건; 같은 항목의 설정값보다 앞섬), `{kind: 'floor-exclusion', identity: {floor}}` `set` `{area, basis}`, `{kind: 'mass-floor', identity: {alternative: 'human-k', floor}}` `set` `{outline, holes?}` 또는 `remove`, `{kind: 'use-floor', identity: {floor, alternative?}}` `set` `{use}` 또는 `{uses: [{use, ratio}]}`. `by: 'ai'`인 수정 사항은 어느 단계도 쓰지 않고 `problems`에 이유를 남긴다.
- **새 규제 조건 항목:** `incentiveFar`·`incentiveHeight`·`openSpaceIncentiveFar`, `parkingRounding`(`half-up`·`ceil`·`floor`)·`parkingRoundScope`(`sum`·`each`)·`parkingAreaBasis`(`gross`·`far`)·`parkingEntryCornerDistance`, `parkingRule`(단위 ㎡/대, 대상 = 용도). 항목 값 형식에 문자열 목록(`string[]`)을 더했다.
- **단계와 출력:** `floors`(기준 변형, 지상 `floors[]`·지하 `basement[]` `{floor, index, z0, z1, regions, area}`, `basementRegions`, 표 `rows`), `openSpace`(`requirement`·`candidates`(영역 포함)·표 `rows`·`picked`·곡선 `lines`), `alternatives`(`alternatives[]` 층 영역까지, 표 `rows`, 막대 `bars`, `skipped`, `problems`), 사람 단계 `confirmChoice`(slot `confirm-inputs`, 읽기 = 대안 출력 + `param.chosenAlternative`, 막는 단계 `chosen`), `chosen`(`{id, title, row, alternative}`, 넘겨줄 결과 `handoff`의 입력 — §8.5), AI 단계 `useDraft`(`draft-only`, AI 뒤 점검 `numbers-in-source`·`no-plan-dependent-conclusion`; 런타임이 AI 단계를 아직 돌리지 않아 늘 `AI_UNAVAILABLE`, 꺼진 상태로 시작) → 사람 단계 `acceptUseDraft` → `useDraftApplied`(출력 `apply.overrides`, §6.3 적용 요청, id `use-floor:<층>`·`by: 'user'`·note 'AI 초안을 사람이 받음'), `useMix`(대안별 층 용도·용도별 합계·판정, 만들기 항목 `items`), `parking`(대안별 법정·계획 대수, 고른 대안의 용도별 줄·방식 대안·지상 여유·진입 구간·조경·공개공지, 곡선 `lines`, 추정 지하층 `masses`).
- **만들기 선언:** `alternativeMasses`(`vide.bake.extrude-polygon@1`, 항목 `{key: alt:<대안>:<층>:<영역>, rings, bottom, height, option, floor, areaText, use, unconfirmed}`, 속성 `vide-option`·`vide-floor`·`vide-area-m2`·`vide-use`·`vide-unconfirmed`), `groundZones`(`vide.bake.curves@1`, 속성 `vide-ground`·`vide-area-m2`), `parkingMasses`(`vide.bake.extrude-polygon@1`, `park:under:B<k>:<영역>`). 호스트 단계 `makeMass`가 셋을 만든다(외피의 `make`와 따로).

### 8.5 앞 jig의 결과 `jig-output`과 건축개요 (PLAN-45 T-213)

작업 jig끼리는 코드를 부르지 않고 설명서가 선언한 출력만 입력으로 받는다(SPEC-07.2, SPEC-12.2).

- **선언:** 내주는 jig는 `outputs[{key, from: 'step.<id>', schema}]`, 받는 jig는 입력 `{kind: 'jig-output', from: {jig, output}}`과 능력 `jig.read`다. 공식 선언: `vide/buildable-mass` 0.4.0 `chosen` ← 단계 `handoff`(`schemas/outputs/chosen.json`), `vide/site-model` 0.2.1 `summary` ← 단계 `summary`(`schemas/outputs/summary.json`, 0.2.1에 `northBasis` 더함). `vide/buildable-mass` 0.4.0은 입력 `legal`(← `vide/legal#constraints`, 제공자)과 `siteModel`(← `vide/site-model#summary`, 단계 `site`가 읽음)을 받는다.
- **고르기·보관:** 작업본 본문 `jigOutputs[<key>] = {instanceId, at}`(사람이 고른 앞 작업본, 없으면 자동)과 `jigOutputsUsed[<key>] = {instanceId, hash, at}`(마지막으로 보관한 계산이 읽은 결과). 자동은 이 프로젝트의 `from.jig` 작업본 가운데 그 출력 단계가 `done`인 것 중 계산 시각이 가장 늦은 것이고, 없으면 가장 최근 작업본을 이유와 함께 보인다. 엔진에 그 `<jig>#<output>` 제공자가 있고 값을 주면(법규 jig의 `legal.constraints`, §3) 그 값을 그대로 쓰고 앞 작업본을 찾지 않으며, 제공자 값도 그 jig의 작업본도 없으면 null이다. 제공자 값의 지문은 `service:<jig>#<output>:<내용 해시>`이고, 보관한 계산이 끝날 때 `jigOutputsUsed[<key>] = {instanceId: 'service:<jig>', hash, at}`로 남긴다(T-214 F-8). 그래서 법규 답이 바뀌어 `legal.constraints`의 내용이 달라지면 상태 경로가 `stale: true`를 준다.
- **읽을 수 있음:** 앞 작업본의 jig 버전이 그 출력을 선언하고, 출력 단계의 실행 행이 `done`이고, 보관 파일이 있고, 출력이 선언한 스키마(§6.2의 부분집합 검사)를 통과할 때다. 이유: 단계 `stale` → '앞 작업본이 다시 계산 필요 상태입니다', `failed`·미계산·버전에 출력 없음·파일 없음·형식 다름. 앞 작업본의 출력은 바꾸지 않는다.
- **단계에 주는 값:** `input.<key>` = `{source: {instanceId, title, jig, version, updatedAt, step, status, at, hash}, value, snapshot: {hash}}`, 읽을 수 없으면 `{source | null, value: null, reason, snapshot}`. 지문 `hash` = `<앞 작업본>:<단계>:<그 실행의 입력 지문>`이라 앞 결과가 바뀌면 이 입력을 읽는 단계부터 다시 계산된다. 미리보기 계산은 `jigOutputsUsed`를 바꾸지 않는다.
- **`handoff`(`vide/massing-kit` 0.3.0 `handoffStep`, 단계 `chosen`·`parking` 뒤):** `{kind: 'vide/buildable-mass#chosen', alternative {id, title, flags, farTarget, farTargetSource, notes, openSpace}, row(대안 표 줄), floors[]·basement[] {floor, index, z0, z1, height, area, exclusion, exclusionBasis, farArea, change, outside, uses[{use, ratio, area}], useOrigin, useVerdict}, site {area_m2, northBasis, northDeg}, plan, regulations {items, legal, needsInput}, uses(용도별 합계), parking {legal, raw, status, planned, rows, types | null}, landscape, publicOpenSpace {required, state, planned}, unconfirmed[{title, status}], chosenBy: '사용자가 확정함'}`. 층 영역(기하)은 넘기지 않는다. 새 계산은 없고 앞 단계 값만 옮긴다.
- **`vide/building-summary` 0.1.0(`src/jigs/official/jigs/building-summary/`):** 입력 `mass`(← `vide/buildable-mass#chosen`)·`site`(← `vide/site-model#summary`, 없어도 됨). 코드 단계 `sources`(앞 결과 표, 고른 대안이 없으면 이유와 함께 실패) → `summary`(개요 줄 `{key, item, sub, value, unit, text, py, origin, status, basis, source}`, 층별 줄 `{key, floor, use, area, exclusion, farArea, py, note, kind: 'floor' | 'total'}`, `floorSum`, 미확정 조건·사람 입력 필요 목록) → `check`(일관성 점검: 숫자 칸의 `value`가 두 입력의 숫자에 있음, `text`·`py`가 값에서 쓴 것과 같음, 층별 합 = 지상·지하·합계 줄 = 개요 연면적·용적률 산정 연면적, 층 수 = 규모. 결과 `{ok, mismatchCount, mismatches[], overview, floors, floorsCount, checked}`이며 맞지 않으면 `overview`·`floors`가 비어 CSV 표와 보고서 표가 없다). 설정값은 `constructionType`·`structure`·`parkingMethod`(닫힌 선택), 건물명·비고는 수정 사항 `{kind: 'summary-text', identity: {field: 'buildingName' | 'remarks'}}` `set` `{text}`(200자, `by: 'ai'`는 받지 않음). 출처 글자는 `계산`·`공부`·`사람 입력`·`법규 결과`·`사람 입력 필요`·`미적용`이고, 규제 조건 항목은 `source`가 `param.`·`override.`이면 사람 입력, 그 밖이면 법규 결과다. 평 = ㎡ × 121/400. 보고서 틀 `reports/summary.json`은 `export` 조건을 쓴다(§5.2). 패널은 `jig-source` 둘, 보고서 보기, 표 탭(건축개요·층별 면적표 CSV, 일관성 점검, 미확정 조건, 앞 결과)이다.

### 8.6 법규 체크 `vide/compliance-check`와 내부 계약 (PLAN-48 T-237~T-239)

[SPEC-15](../specs/SPEC-15-compliance-check.md)의 물리 계약이다. 세 갈래(읽기·계산·화면)가 나란히 만들 수 있도록 형식을 먼저 고정했다(2026-10-08). 형식의 정본은 `src/contracts/compliance.ts`의 zod 스키마이며 `tests/contract/compliance-contract.test.mjs`가 합성 사슬 하나와 거절 경우를 시험한다. 형식을 바꾸는 티켓은 이 절·스키마·시험을 같은 커밋에서 고친다.

- **흐름:** 엔진(읽기, T-237) `ClassifiedModel` → jig 단계(계산, T-238) `runCheck(model, limits, ground: GroundDatum, settings: ComplianceSettings, overrides: ComplianceOverride[])` → `ComplianceResult` → 화면·보고서(T-239). 계산은 순수 함수이며 네트워크·AI·호스트를 부르지 않는다. 같은 입력이면 `checkedAt` 말고는 같은 결과다. 계산은 규제 조건 항목을 SPEC-15.5 6의 표대로 먼저 거른 뒤(`AI가 추정함`은 한계에서 뺌, `ask` 선택은 빈 값) massing-kit 함수(`legalParking`·`landscapeAreas`·`openSpaceRequirement`·`farTargets`)에 넘긴다. 코드의 숫자 상수는 기하 허용 오차(1 mm·1 cm·0.001 ㎥)와 비교의 수치 허용 오차(`verdict.ts` `COMPARE_TOL` — 계획과 한계의 차가 한계의 1e-9배(최소 1) 안이면 같음, 법정 값 아님, SPEC-15.9 8)뿐이다. 닫힌 솔리드 판정은 `vide/geometry-kit` 0.2.4 `closedVolumeCheck`(열린·비다양체 변 없음, 퇴화 다각형 없음, 부피 0 아님 — 껍질 여럿·중정(genus > 0) 허용)이고, massing-kit 외피는 그대로 `checkSolid`(껍질 하나·오일러 2)를 쓴다.
- **좌표와 지반:** 모든 좌표는 매스 작업본의 로컬 m = 문서 좌표 × `toMeters` − `frame.origin`. `ComplianceLimits`의 높이 상한·`sunCut`·`envelope`은 로컬 z = `frame.groundZ`(지금 massing-kit은 0) 위에 선 것이고, 계산은 기준 지반 경우(`GroundDatum.value` 하나, 또는 `candidate.min`·`max` 둘 — 문서 z m)마다 `ground − origin[2] − groundZ`만큼 z로 옮겨 쓴다. 평면 금지 띠(`zones`)는 z와 무관하다. `toMeters`가 `null`이면 길이·면적·부피 행은 모두 `검사 불가`다(SPEC-15.3 1). 읽기는 이 때문에 실패하지 않는다.
- **`ClassifiedModel` `vide.compliance.model@1`:** `source {linkId, documentKey, readId, revisionKey, readAt, toMeters | null}`, `objects[]`, `unclassified[]`, `rolesVersion`. 객체는 `{objectId(nativeId, uuid), layer, role, roleSource, floor('1F'…, 'B1'… | null — 이름 없는 층 윤곽은 null이고 층은 계산이 지반 경우마다 붙임), use | null, count(기본 1), hidden, geometryHash | null, geometryChanged(기본 false), shape}`이고 `hidden: true`는 '숨긴 객체 포함'이 꺼졌어도 역할이 정해진 숨긴 객체를 계산에서 빼되 적합을 막도록 넘긴 것이다(SPEC-15.9 7). 쓰지 못한 객체는 `unclassified[{objectId, layer, nativeType, reason, role | null(시도한 역할), shape('closed-solid'·'open-solid'·'region'·'curve'·'point'·'other')}]`이다. jig 태그 규칙: `vide-jig = vide/buildable-mass`이고 `vide-key`가 `alt:`로 시작하는 객체는 `vide-option`이 `limits.plan.chosenOption`과 같을 때만 `floor`(`jig-tag`), 고른 대안이 없고 모델에 대안이 하나뿐이면 그 대안, 아니면 `고르지 않은 대안`. `park:`로 시작하는 주차 추정 매스와 그 밖의 `vide-jig` 객체는 `다른 jig의 결과`(SPEC-15.3 3). `shape`는 `{kind:'solid', mesh{v,f}, closed, volume}` · `{kind:'region', region{outer, holes}, z}` · `{kind:'point', at}` 가운데 하나다. 좌표는 문서 좌표 × `toMeters` − `ComplianceLimits.frame.origin`(매스 작업본의 로컬 m)이다. `role`은 `mass`·`floor`·`building-area`·`rooftop`·`parking`·`landscape`·`landscape-roof`·`open-space`·`ignore`, `roleSource`는 강한 순서로 `attribute`·`person-object`·`person-layer`·`ai-accepted`·`jig-tag`·`layer-rule`이다. `unclassified[].reason`은 `역할 없음`·`역할과 모양이 맞지 않음`·`닫히지 않음`·`평면이 아님`·`숨김`·`다른 jig의 결과`·`고르지 않은 대안`.
- **객체 속성(Rhino 사용자 문자열):** `vide-check-role`(값 = 위 역할 키), `vide-floor`(이미 층 매스가 쓰는 이름), `vide-use`, `vide-count`(1 이상 정수). 이름·값 규칙은 §9.1과 같다. `vide-role`은 구조 jig의 부재 역할로 쓰이므로 검사 역할에 쓰지 않는다. VIDE는 이 속성을 쓰지 않고 읽기만 한다.
- **`ComplianceLimits` `vide.compliance.limits@1`** — `vide/buildable-mass` 0.5.0의 출력 `limits`(← 단계 `limitsHandoff`, `schemas/outputs/limits.json`, massing-kit 0.4.0 `limits-handoff.ts`): `frame {linkId | null, documentKey | null, origin, groundZ}`, `site {ring, area_m2, areaSource, otherArea_m2, northDeg, northSource}`, `regulations[]`(massing-kit `RegulationItem` 그대로: `{id, group, title, value, unit, applies, status, origin, basis, source, target?}`), `unapplied[{id, title, reason, segments?}]`(`id` = massing-kit `RuleId`, `segments` = 그 규칙을 빼고 계산한 구간·모서리·그린 선 — 없으면 규칙 전체; 계산에 넣고 미확정으로 둔 해석(일조 거리의 정의, 정북과 거의 수직인 구간)은 여기가 아니라 변형의 `unconfirmed`), `zones[{rule, items[], regions[], segments[], regionSegments?}]`(`rule` ∈ `roadSetback`·`chamfer`·`limitLine`·`openSpaceRoad`·`openSpaceAdjacent`·`civilSetback`·`otherSetback`; 금지 띠는 `setback.ts`의 `Cutter`를 평면 다각형(`cutterRing`)으로 옮긴 것; `regionSegments[i]`는 `regions[i]`가 잰 구간(`Cutter.target`) — 있으면 계산이 구간(`target`)마다 자기 띠만 겹쳐 구간별 상태·부피·구간 이름을 내고, 없으면 구간을 나누지 않고 행 전체로만 판정한다), `variants[{id:'base'|'without', heightCap {value, items[]} | null, sunCut mesh | null, envelope mesh, envelopeVolume, unconfirmed[]}]`, `plan {mainUse, floorHeightGround, floorHeightTypical, chosenOption | null}`(`chosenOption` = 설정 `chosenAlternative`가 가리키는 대안의 `title`, 즉 `alternativeMasses`가 붙인 `vide-option` 값). 새 계산은 없고 앞 단계 값만 옮긴다(`handoff`와 같은 원칙, §8.5) — 모양만 바꾼다: 일조 금지 부피는 `sunCutPieces`의 합(`solidUnionAll`), 메쉬는 용접된 고리를 고리 중심점에서 부채꼴로 나눈 삼각형(T-junction 꼭짓점에서 넓이 0 삼각형이 생기지 않게). `frame.linkId`·`documentKey`는 조립 입력 `site.boundary`를 읽은 Link(실행 입력의 역할 값에 `sources[{linkId, revisionKey}]`가 함께 오며 지문에는 들지 않음)이고 `origin = [0,0,0]`·`groundZ = 0`이다. `site.otherArea_m2`는 사이트 모델링 대지 요약의 공부 면적이 그린 경계 면적과 다를 때 그 값이다. 고른 대안이 없어도 `envelope`·`alternatives` 단계가 `done`이면 나온다.
- **대지 지반 후보:** `vide/site-model` 0.3.0 `summary.ground = {min, max, mean, source} | null`(대상 대지 경계 위 지형 높이, 사이트 모델링이 만든 문서의 z, m). 계약의 `groundDatumSchema`가 설정값(`value`·`basis`, 문서 z m)과 이 후보를 함께 담는다. 아직 사이트 모델링(0.2.1)에 `ground`가 없어 후보는 `null`이고(`checkStep`은 `summary.ground`가 생기면 그대로 읽음), 기준 지반은 설정값 `groundState: 'set'`·`groundLevel`로 넣는다.
- **설정값·수정 사항:** `ComplianceSettings {groundLevel | null, groundBasis | null, exclusionsComplete, noneParking, noneLandscape, noneOpenSpace, includeHidden}`(jig `params`), `ComplianceOverride` = `{kind:'floor-exclusion', id, floor, area_m2, basis(필수), by:'person', at}` · `{kind:'use-floor', id, floor, use, by:'person', at}`. `by:'ai'`는 계약에서 거절한다. 지문은 `settingsHash`·`overridesHash`.
- **`ComplianceResult` `vide.compliance.result@1`:** `checkedAt`, `inputs {model {linkId, documentKey, readId, revisionKey, readAt, objects, unclassified, rolesVersion} | null, limits {instanceId, title, hash, at} | null, siteModel | null, settingsHash, overridesHash}`, `items[]`, `notApplicable[{check, id, title, basis}]`, `classification {byRole, unusedByReason, aiAccepted, hiddenWithRole, geometryChanged}`, `counts`(다섯 상태 모두, 행 수와 같음), `unconfirmedCount`(미확정 사항이 있는 행 수), `notice`(고정 문구 '탐색용 법규 체크 — 인허가 검토·법규 검토를 대체하지 않음'), 선택 필드 `display {origin, envelope | null}`(T-239 화면용: 매스 프레임 원점 — 로컬 + `origin` = 문서 m = 뷰포트 좌표 — 과 기준 변형의 최대 외피 메쉬(로컬 m). 없으면 화면은 초과 부분을 로컬 좌표 그대로 그리고 외피 윤곽을 켜지 않는다). 행은 `{id, group, title, state, reason, planned {value, unit, text} | null, limit {value, unit, text, itemId, status, origin} | null, margin, basis[{clause, link, answer}], numbers[{label, value, unit, kind, ref, note?}], cases[{label, state:'적합'|'위반', planned, limit}](경우, 32개까지), parts[{label, target, state, planned, limit, reason}](구간, 64개까지), objectIds[], exceedances[{id, no, rule, variant, groundCase, volume, min, max, segments[], objectIds[], rooftopOnly, mesh}], unconfirmed[]}`이고 `id`는 닫힌 목록 `COMPLIANCE_CHECKS`(`coverage`·`far`·`height:<항목>`·`floors`·`zone:<규칙>`·`sun`·`envelope`·`outside-site`·`parking`·`landscape`·`open-space`)다. `state`는 `적합`·`위반`·`판단 필요`·`사람 입력 필요`·`검사 불가`. `numbers[].ref`는 `model:<역할>`·`regulation:<항목>[@<target>]`·`site:area`·`site:otherArea`·`ground:<경우>`·`setting:<키>`·`override:<id>` 꼴이다. 비율은 분수(`unit:'비율'`)로 두고 `text`만 %로 쓴다. 형상 행(`zone:*`·`sun`·`envelope`·`outside-site`)의 `planned`는 초과 부피(㎥)이고 `limit`은 `null`이다. 스키마가 막는 것: 검사 하나가 `items`·`notApplicable`에 꼭 한 번 나오지 않음, `group`이 검사와 맞지 않음, `counts`·`unconfirmedCount`가 행과 다름, 적합이 아닌 행의 빈 `reason`, (형상 행 밖) `planned`·`limit` 없는 적합, `사람 입력 필요` 한계로 낸 적합, 위반 경우·적합 아닌 구간을 가진 적합, 겹친 초과 번호.
- **jig 설명서 `vide/compliance-check` 0.1.0**(`src/jigs/official/jigs/compliance-check/` — `jig.json`·`panel.json`·`skill.md`·자체 시험 `fixtures/chain`·`no-limits`·`undecided`): 입력 `model {kind:'host-document', host:'rhino', required}`(T-237이 §3 `InputSpec`과 검사기에 더함 — 능력 `sync.read` 필요 — 문서 하나 전체를 §8의 읽기로 `purpose:'check'`로 읽고 엔진이 분류 기록을 더해 `input.model = ClassifiedModel`을 준다. 지문은 `revisionKey` + `rolesVersion`), `limits {kind:'jig-output', from {jig:'vide/buildable-mass', output:'limits'}}`, `siteModel {kind:'jig-output', from {jig:'vide/site-model', output:'summary'}}`. 설정값 `groundState`('unset' 사이트 모델링 후보 · 'set' 사람이 넣은 값)·`groundLevel`(`level`, m, 문서 z)·`groundBasis`(근거 선택: 근거 없음·측량·현황 자료·설계 기준 레벨·인허가 협의 값 — jig 설정값에 자유 글이 없어 선택)·`exclusionsComplete`·`noneParking`·`noneLandscape`·`noneOpenSpace`·`includeHidden`. 수정 사항은 `target.kind` `floor-exclusion {floor, area_m2, basis}`·`use-floor {floor, use}`이고 `by:'user'`만 `ComplianceOverride`(`by:'person'`)가 된다. 단계는 라이브러리 단계 `check` 하나(`use: 'vide/compliance-kit#checkStep'`, `speed: 'button'`, **`manual: true`**, 출력 = `ComplianceResult`). `manual` 단계는 `mode:'confirmed'`이고 `until`이 그 단계인 실행(과 자체 시험)에서만 계산하고, 다른 모든 실행(열기의 `geometry`, 설정 바꾼 뒤의 실행, 요청으로 시작한 jig의 `confirmed` 전체 실행)에서는 `skipped`로 두며 마지막 결과(`StepCache.previous`)를 출력으로 돌려준다 — 실행 행(`jig_runs`)과 그 '다시 계산 필요'는 바꾸지 않는다. jig.json의 `remote: 'view'`로 원격 화면은 설정값(`PUT …/params`·`params/undo`)·수정 사항(`POST …/overrides`)·`geometry`가 아닌 실행을 403으로 거절당하고, 작업본 보기(`GET …/:iid`의 `jig.remote`)로 화면이 설정 부품을 잠근다. 만들기 선언(`bake`)과 `hosts`는 없다. 패널 [법규 체크]는 화면이 `POST …/compliance/read`로 문서를 다시 읽은 뒤 `POST …/:iid/run {mode:'confirmed', until:'check'}`를 보낸다(읽기가 실패하면 실행하지 않고 이유를 보임). 설정값·수정 사항·분류·앞 결과가 바뀌거나 매스 작업본이 '다시 계산 필요'가 되면(그 작업본의 출력 지문은 그대로여도) 화면은 이유와 함께 '다시 체크 필요'만 보이고 다시 읽거나 계산하지 않는다(SPEC-15.13). 모델 판은 `GET …/compliance/revision`(아래)로 비교한다.
- **저장:** 프로젝트 DB 스키마 16(T-237)의 표 `compliance_roles(projectId FK, documentKey, scope 'layer'|'object', key, role, floor, use, by 'person'|'ai-accepted', at, geometry_hash, PRIMARY KEY(projectId, documentKey, scope, key))`와 `compliance_proposals(projectId FK, id, documentKey, scope 'layer'|'group', layer, object_ids_json, hashes_json, role, floor, use, reason, state 'proposed'|'accepted'|'rejected', created_at, seq)`, 판 번호 표 `compliance_roles_version(projectId, version)`(기록이 바뀔 때마다 1 증가). `documentKey`는 Link ID다. 객체 키는 소문자 GUID로 둔다. 제안의 `hashes_json`은 제안 때의 객체별 형상 지문(받으면 객체 기록의 `geometry_hash`가 됨), `seq`는 AI 답의 순서다. 새 [역할 제안 받기]는 그 문서의 받지 않은 제안을 지우고 새로 둔다. 레이어 기록은 그 아래 레이어에도 걸리고 가장 가까운 것이 이긴다. 제안을 받으면(레이어 전체 제안이어도) 제안이 가리킨 객체(뺀 객체 제외)마다 객체 기록이 되고, 레이어 기록은 사람이 `PUT …/roles`로 직접 정할 때만 생긴다. 사람이 역할을 바꿔 받으면 `by:'person'`이다. 예전에 받은 `ai-accepted` 레이어 기록은 jig 태그와 그 레이어보다 깊은 레이어 이름 규칙 뒤에서만 쓰인다(`conventions.ts` `roleOf`). 결과 자체는 jig 단계 결과로 보관된다(§4).
- **엔진 경로(T-237, `src/server/compliance-routes.ts`):** `GET /api/v1/projects/:id/compliance/roles?documentKey=` → `{records[], version, proposals[]}`, `PUT …/compliance/roles {documentKey, set[{scope, key, role, floor?, use?}], remove[{scope, key}], instanceId?}` → 같은 꼴(`instanceId`가 있으면 그 작업본의 마지막 체크 읽기에서 객체 기록의 형상 지문을 붙임), `POST …/compliance/read {instanceId, linkId?, key?, includeHidden?}`(체크용 문서 읽기, 아래) → `{readId, linkId, documentKey, revisionKey, readAt, toMeters, rolesVersion, objects, unclassified, byRole, unusedByReason, aiAccepted, hiddenWithRole, geometryChanged, missingRecords[], notes[], rows[{objectId, layer, role, roleSource, floor, use, hidden, geometryChanged, reason}]}`, `POST …/compliance/proposals {instanceId, key?}`(마지막 체크 읽기의 역할 없음 객체 묶음 요약을 단발 AI로 보냄, `vide/compliance-kit` `complianceRolesRequest`를 `src/ai/request-router.ts`가 다시 내보냄) → `{proposals[], rejected[{why, target?, text}]}`, `POST …/compliance/proposals/:pid {action:'accept'|'reject', role?, floor?, use?, exclude?: objectId[]}` → `{proposal, records, version, proposals}`, `GET …/compliance/revision?linkId=` → `{linkId, revisionKey | null, reason?}`(문서를 읽지 않고 그 Link의 지금 판 키 — 붙은 Rhino는 연결의 `fingerprint().revision`, 파일 연결은 마지막 가져오기의 파일 지문으로 `readForJig`과 같은 꼴 `<instance>|<documentId>|<판>`; 연결이 없거나 닫혔으면 `null`과 이유 → 화면 '모델 판 확인 불가'). [역할 제안 받기]가 보내는 레이어 표는 역할 없는 묶음이 있는 레이어로만 줄인다. 원격 세션은 `GET`만 되고 나머지는 403(`FORBIDDEN`). 오류: 연결 Rhino 없음·연결 경로 없음 `HOST_NOT_CONNECTED`, 아직 읽지 않음 `COMPLIANCE_NOT_READ`, 제안 요청 때 단위 모름 `COMPLIANCE_UNITS_UNKNOWN`(크기 구간을 낼 수 없음 — 체크용 읽기는 이 오류를 내지 않고 `toMeters: null`로 넘긴다), 이 PC에 로그인된 CLI 없음 `COMPLIANCE_AI_UNAVAILABLE`, 이미 정한 제안 `REVISION_CONFLICT`. AI 실행이 실패하면 오류 대신 `rejected[{why:'AI_FAILED'}]`로 돌려 사람이 직접 정하게 한다(SPEC-15.14). `AI_SEND_OFF`(프로젝트의 AI 전송 끔)는 그 설정이 생길 때 쓴다(지금 프로젝트 설정에 없음). 단발 AI는 엔진이 사용자의 CLI로 한 번 돌리며(`CliRunner`, `modelPlan`의 `extract` 모델), 대화 요청을 만들지 않는다.
- **체크용 문서 읽기(T-237):** 문서 하나 전체를 §8의 읽기로 두 번 읽는다 — 숨긴 객체 포함 한 번(`purpose:'check'`로 `jig_reads`에 남김)과 숨긴 객체 없이 한 번(어느 객체가 숨었는지 앎; 레이어 표의 꺼진 레이어와 그 아래도 숨김). 연결은 요청의 `linkId` → 한계의 `frame.linkId` → 이전 읽기 → 프로젝트의 Rhino 연결이 하나뿐이면 그것. 표시 행은 이미 m(호스트가 환산)이므로 좌표는 표시 좌표 − `frame.origin`이고 `toMeters`는 `sourceDocument.units`의 환산 비율(모르면 `null`)이다. 모양 판정: 메쉬는 두께가 1 mm를 넘으면 `weldSolid`·`checkSolid`로 닫힌 솔리드인지 보고, 1 mm 안이면(평면 서피스·해치 채움) 경계 고리로 `region`을 만든다. 곡선은 끝점이 1 mm 안이거나(폴리라인) 128점 나눔의 닫힘 틈이 가장 긴 마디 이하이면 닫힘이고, 높이 차가 1 mm 안이어야 수평이다. 블록은 삽입점(변환의 이동 성분), 점은 위치다. `ignore` 역할 객체는 모양과 관계없이 `objects`에 남는다(모양이 맞지 않으면 범위 최소점의 `point`). 분류한 `ClassifiedModel`은 작업본 몸체 `hostDocuments[<입력 키>] {ref, hash, readId, linkId, revisionKey, rolesVersion, at}`와 `<data>/jigs/models/<instance>/…json.gz`에 남고, 그 입력을 읽는 단계가 '다시 계산 필요'가 된다(지문 = `revisionKey` + `rolesVersion` + 모델 내용). 아직 읽지 않았으면 단계는 `input.model = null`을 받는다.
- **화면 이벤트(T-239):** 결과 행 → `vide:select-native {label, objects[{linkId, nativeIds[]}]}`(`src/ui/legal-target.ts` `selectNative`). 법규 답 대상 칩도 이 이벤트를 낸다(이전 `vide:legal-target`, ARCH-01 「법규와 모델」). 초과 부분 메쉬는 jig 겹침 층의 새 항목 종류 `mesh {v, f, fill?}`(`src/ui/viewport.ts` `OverlayItem`, 반투명 몸체 + 모서리선; 평면 지도는 그리지 않음)로 그리고 Rhino에 보내지 않는다. 화면 부품(`src/ui/kit/registry.ts`): `compliance-roles`(왼쪽, 분류 카드·역할 제안), `compliance-run`(왼쪽, [법규 체크]와 마지막 체크), `compliance-summary`(가운데 KPI 자리, 상태별 수·미확정·다시 체크 필요 띠), `compliance-result`(서랍, 결과·미적용·분류·입력 탭, 3D 겹침, CSV·보고서 내보내기). 결과는 `step.check`의 `ComplianceResult`이고 화면이 `complianceResultSchema`로 다시 검사해 맞지 않으면 그리지 않는다.

## 9. Rhino에 만들기

### 9.1 틀

- 공식 틀은 VIDE가 소유한 C# 메서드 본문 파일 `src/jigs/bake/templates/<name>.cs`이고 치환 자리는 `{{DATA_BASE64}}` 하나뿐이다. 1차 틀: `vide.bake.curves@1`(폴리라인·3점 원호), `vide.bake.sweep-h@1`(H·BH 단면을 상단 기준 레일 아래로, 웨브 연직), `vide.bake.extrude-column@1`(H 기둥, 강축 방향 지정), `vide.bake.textdot@1`(부호).
- 규모검토 틀(PLAN-45 T-208, [SPIKE-2026-10-07-envelope](../tdd/SPIKE-2026-10-07-envelope.md)):
  - `vide.bake.extrude-polygon@1`(사이트 건물·층 매스): 바깥 고리와 구멍 고리를 고리 높이(바닥)에서 위로 `height`만큼 돌출한 닫힌 폴리서피스. 고리 방향을 바로잡고(바깥 반시계·구멍 시계, 위에서 볼 때) 평면 면 하나를 만든 뒤 덮개 있는 돌출을 한다. 돌출 자체의 방향만 뒤집어 맞추고, '한 조각·`IsSolid`·`IsValid`·`Outward`·바닥에서 바닥+높이까지·부피 = 고리 면적 × 높이(상대 1e-6)'가 아니면 그 키는 `failed[]`다.
  - `vide.bake.brep-faces@1`(외피): 엔진이 만든 평면 면 목록 → 닫힌 폴리서피스. 면마다 `CreatePlanarBreps`, 전체를 `JoinBreps`로 잇고 둘 다 문서 허용 오차가 아니라 **1e-5 m**(문서 단위로 환산)로 한다. `MergeCoplanarFaces`는 부르지 않는다(실험에서 부피를 4.7~9.9% 바꿈). 실제 Rhino 8.35에서 면을 모두 뒤집은 상자도 결합 결과가 `Outward`였으므로(T-208) `SolidOrientation`만으로는 뒤집힌 자료를 거르지 못한다. 그래서 먼저 '감긴 방향 그대로의 면 목록 부피'(고리마다 부채꼴 사면체 합)가 엔진 부피와 상대 1e-6 안에 있는지 본다. 그 뒤 '한 조각·`IsSolid`·`IsValid`·`SolidOrientation == Outward`·Rhino 부피가 엔진 부피와 상대 1e-6 이내'가 아니면 `failed[]`이고, 뒤집어 고치지 않는다(SPEC-12.9의 4). 면 고리는 바깥이 밖에서 볼 때 반시계, 구멍은 그 반대로 감는다.
  - `vide.bake.mesh@1`(지형): 꼭짓점과 삼각·사각 면 → 메쉬(꼭짓점 배정밀도). 번호가 범위를 벗어나거나 면이 빠지거나 `IsValid`가 아니면 `failed[]`. 본문 하나를 넘는 지형은 jig가 `splitMesh`(`data-block.ts`, 기본 1,500면)로 나눠 키 `<key>:<n>` 항목 여럿으로 보낸다.
- 패널링 틀(PLAN-49 T-251·T-255, [SPIKE-2026-10-08-paneling](../tdd/SPIKE-2026-10-08-paneling.md)). 세 틀은 같은 지문 함수 글 `face-hash.cs`(바탕 면의 NURBS 차수·매듭·조정점·가중치, 면 방향, 트림 곡선의 NURBS 꼴과 고리 종류, 문서 단위 환산을 정확한 배정밀도 바이트로 SHA-256)를 끼워 넣는다. 틀 파일의 `//@include face-hash.cs` 한 줄을 `templates.ts`가 읽을 때 그 글로 바꾸고, 치환 자리 증명(`{{DATA_BASE64}}` 하나)은 바꾼 뒤의 글에 한다. 시험이 세 틀에 같은 글이 들어갔는지 확인한다.
  - `vide.read.surface-grid@1`(기준 면 읽기, `read-surface-grid.cs`): 쓰기가 없는 읽기 틀이다. 연결 Rhino에서는 호스트 방법 `direct-read`로 실행한다 — direct-execute와 같은 컴파일·`CodePolicy`이고, 되돌리기 기록을 열지 않으며, 결과를 요청 ID별로 보관하지 않고, 실행 앞뒤 객체·레이어 스냅숏이 다르면 그 변경을 되돌리고 `READ_CHANGED_DOCUMENT`로 거절한다(기록이 없으므로 되돌리는 것은 더한 객체·레이어를 지우는 것이고, 기존 객체를 바꾸거나 지운 경우는 되돌릴 수 없어 `reverted: false`로 알린다; 공식 읽기 틀은 쓰지 않으므로 이 거절은 잘못된 틀을 막는 안전장치다). 엔진 경로(T-251, `src/server/paneling-routes.ts`·`paneling-read.ts`): `GET /api/v1/projects/:id/paneling/surface?instanceId=&key=` → `{key, picked | null, summary, watching, changed}`(원격 허용, Rhino를 부르지 않음 — `changed`는 그 링크의 최신 Sync(Live Sync가 갱신) 모델에서 객체 행의 `geometryHash`가 읽을 때와 다르면 `{reason:'geometry'}`, 행이 없어지면 `{reason:'missing'}`, 읽을 때 행이 없었으면 `watching:false`), `POST …/paneling/surface/read {instanceId, key?, mode:'pick'|'reread', linkId?, objectId?, faces?, grid?}`(원격 403) — `pick`은 지금 Rhino 선택 객체 하나(여럿이면 `PICK_MANY`, 없으면 `PICK_NONE`), 면을 정하지 않으면 지문만 읽기(mode 2)로 면 수를 세고, 격자는 기본 128이되 모든 면 합이 65,536점을 넘지 않게 줄인다(6면이면 104²). 읽기 실패는 HTTP 200 `{ok:false, code, message}`이고 앞 표본을 지우지 않는다. 같은 내용을 다시 읽으면(읽은 시각·문서 revision만 다름) 입력 사본을 바꾸지 않아 단계가 '다시 계산 필요'가 되지 않는다. 파일 연결만 있으면 지금은 `ATTACHED_ONLY`로 거절한다(숨은 워커 대안은 후속). 파일 연결만 있으면 숨은 워커의 `execute`로 같은 본문을 실행한다(`SurfaceSample.source.path`가 `attached-template`·`hidden-worker`). 데이터 블록(리틀 엔디언, base64 한 덩어리): `str "vide.read.surface-grid@1"`, `i32 mode`(0 격자, 1 탐침 점, 2 지문만), `str objectId`, `i32 faceIndex`(−1 = 모든 면), `i32 nu`, `i32 nv`(2~512), `i32 encoding`(1 = base64 float64, 0 = JSON 수 배열은 시험용), `i32 nProbe`, `f64 × 2·nProbe`(u, v). 결과: `{ schema, units, toMeters, absTol(m), nonFinite, faces[] }`, 면마다 `faceIndex · domainU · domainV · nu · nv · closedU · closedV · singular{uMin,uMax,vMin,vMax} · points · normals · curvatures · inside · trimLoops · geometryHash`. `points`·`normals`·`curvatures`는 base64 float64 묶음이고 엔진이 `SurfaceSample`의 수 배열로 푼다. 표본 순서는 `k = j·nu + i`, 점은 m, 법선은 면 방향(`OrientationIsReversed`)을 적용한 단위 벡터, 곡률은 그 법선에 대해 부호 있는 1/m(Rhino `Kappa` 부호 = 계약 부호), 극점·퇴화 변의 표본은 매개변수를 영역 안쪽으로 영역 길이의 1e-6만큼 옮겨 법선·곡률을 구한다. 트림 없는 면은 `trimLoops: []`, 트림 고리는 바깥 고리 먼저 고리마다 64점. 실패는 예외 메시지 앞머리 코드로 낸다: `UNKNOWN_UNITS` · `FACE_NOT_FOUND` · `MESH_NOT_ACCEPTED` · `NOT_A_SURFACE` · `NO_SAMPLE_INSIDE` · `SAMPLE_LIMIT`(모든 면 합 65,536점 초과) · `READ_GRID`. 크기: 128² 한 면 1.43 MB, 256² 한 면 5.72 MB(프레임 16 MB 안).
  - `vide.bake.panels-uv@1`(1단계 미리보기 면, 레이어 `layerRoot::미리보기`) · `vide.bake.panel-solids@1`(2단계 부재, `layerRoot::부재`), PLAN-49 T-255. 두 틀 파일은 `data`·`expectedTemplate`·`solid`만 정하고 `//@include face-hash.cs`와 같은 본문 `//@include panel-make.cs`를 끼워 넣는다. 데이터 블록은 §9.2 공통 머리(지울 목록까지) 뒤에 **면 머리** `str objectId · i32 nFaces · (i32 faceIndex · str geometryHash) × nFaces · str keyPrefix · f64 offset(m, 면 방향 법선 쪽 +, 부재만; 열린 면은 0) · f64 budgetMs · str failLayerPath · i32 nAttr · (str 이름 · str 값) × nAttr`(모든 객체에 붙는 공통 속성 `vide-assumed`, 부재는 `vide-thickness`·`vide-joint`), **꼭짓점 표** `i32 nV · (f64 u · f64 v · f32 × 3 표본 점(기준점 차이, m)) × nV`(한 본문 안에서 같은 면·같은 UV의 꼭짓점은 한 번만), 항목마다 `str id · i32 faceIndex · i32 status(0 ok, 1 boundary, 2 pole) · f32 width · f32 height(m) · str fail('' = 만듦, 아니면 엔진이 이미 아는 실패 코드) · i32 n · i32 × n(꼭짓점 표 번호)`다. 키는 `keyPrefix + id`(`makeKey`, 예 `preview:<배치 지문 앞 8>:P-3-7`)이고 틀이 `vide-key`·`vide-panel-id`(= id, 객체 이름도)·`vide-panel-size`(mm `가로×세로`)·`vide-status`·`vide-deviation-mm`를 스스로 쓰므로 항목 속성은 비어 있다. UV는 면 자체 매개변수이고 닫힌 방향은 영역 끝을 한 주기까지 넘을 수 있다. 엔진 어댑터 `src/jigs/bake/panels.ts`(만들기 선언 `rows: 'paneling'`)가 1단계 `PanelLayout`(경계 처리 '빼기'로 뺀 패널은 보내지 않음)·2단계 `MemberSet`(`uv`, 판 크기 `flatSize`, 표본 점은 표본 3차 보간)·작업본의 기준 면 표본(객체 ID·면 지문)·설정값(두께 쪽 × [뒤집기]로 `offset` 부호)으로 항목을 만든다. 배치 지문은 `PanelLayout`의 정규 JSON SHA-256(`paneling-kit` `fingerprint`), 부재는 `MemberSet.layoutHash`다.
    - 틀은 먼저 머리의 모든 면 지문을 다시 계산해 객체가 없으면 `{ rejected: "SURFACE_MISSING" }`, 다르면 `{ rejected: "SURFACE_CHANGED" }`를 돌려준다 — 레이어·삭제·객체보다 먼저이므로 문서는 그대로다(direct-execute가 연 빈 기록뿐이라 `undoId`가 없고 되돌릴 것이 없다). 엔진(`runDirectBake`)은 앞선 본문을 되돌리고 `BAKE_SURFACE_CHANGED`(409, 카드 '기준 면이 바뀜 · 다시 읽기')로 거절한다.
    - 패널마다: 꼭짓점이 `IsPointOnFace(u, v, 허용 오차)`로 트림 밖이면 `UV_OUTSIDE_TRIM`; 바탕 면을 UV 상자로 `Trim`하고 UV 직선 변(`Pushup`)으로 바깥 고리를 지은 열린 면(면 방향이 뒤집힌 면이면 `Flip`), 넓이 0이거나 `Repair` 뒤에도 `IsValid`가 아니면 `FACE_INVALID`; 부재는 `Brep.CreateOffsetBrep(면, offset, solid: true, extend: false, 허용 오차)`가 한 조각·`IsSolid`·`IsValid`가 아니면 `NOT_CLOSED`(메우거나 고치지 않음), 안쪽을 향하면 뒤집는다. 영역 끝을 넘는 UV는 `Brep.ChangeSeam`으로 이음매를 **패널 가운데의 맞은편**(반 주기)에 옮긴 면에서 만들고, 꼭짓점은 원래 면의 3D 점을 옮긴 면에 `ClosestPoint`해 얻는다(ChangeSeam은 매개변수를 다시 매기므로 주기 산술로 옮기지 않음; `SEAM`).
    - `vide-deviation-mm`는 틀이 만든 면의 실제 꼭짓점(원래 면 위)과 꼭짓점 표의 표본 점 사이 거리의 최댓값이다(소수 한 자리).
    - 실패한 패널(엔진이 보낸 `fail` 또는 위 이유)은 만들지 않고 `failLayerPath`(`layerRoot::실패`, 처음 실패 때 만듦)에 원래 면 위 윤곽 폴리라인(변마다 8등분, 키 = 그 패널 키)과 번호 텍스트 점(키 `<key>:no`)으로 남기며 둘 다 `vide-status: failed:<이유>`다. 두 객체 모두 만들기 기록에 들어가 다음 만들기가 같은 규칙(§9.4)으로 교체·제거한다.
    - 틀 안 시간이 `budgetMs`(엔진 60,000)를 넘으면 `BAKE_TIMEOUT`을 던져 그 본문이 통째로 되돌려진다.
    - 반환: `{ removed, keys[], ids[], failed[](실패한 패널 키), reasons[](failed와 같은 순서의 이유), dev[](keys와 같은 순서의 표본 차이 m, 실패 객체는 −1), ms }`. 엔진은 `failed`·`reasons`를 결과의 `failures[{key, reason, code}]`(계약 실패 코드: `UV_OUTSIDE_TRIM` → `outside-trim`, `NOT_CLOSED` → `not-closed`, 그 밖 `make-failed`)로, `dev`의 최댓값을 `deviationMax`로, 3단계 평면도 허용 오차(없으면 3 mm)를 `deviationLimit`로 카드에 준다. 카드는 '실제 면과 표본의 최대 차이 n mm'와 넘으면 '표본이 거칩니다 · 촘촘하게 다시 읽기', 본문이 여럿이면 'Rhino에서 되돌리려면 Ctrl+Z n번'(`undos`), 지금 결과에 없는 키의 사람 수정 보존을 '이전 배치에서 보존 n'(`preservedEarlier`)으로 보인다.
    - 2단계 줄눈 선은 같은 어댑터가 `MemberSet.joints`를 `vide.bake.curves@1` 항목(키 `joint:<배치 지문 앞 8>:<두 꼭짓점 키를 정렬해 이은 글의 SHA-256 앞 12>` — 꼭짓점 키에 `|`가 있어 키 규칙에 맞추려 줄임, 속성 `vide-joint`)으로 바꿔 `layerRoot::부재`에 만든다. 공식 jig `vide/paneling`의 만들기 선언은 `preview`(panels-uv) · `members`(panel-solids) · `joints`(curves)이고, 화면의 [부재 만들기]는 `members`와 `joints`를 함께 보낸다. `members`·`joints`는 점검 `paneling-confirmed`(§11)를 요구한다.
    - 크기(2026-10-08 실측, `tests/core/paneling-bake.test.mjs`): 틀 글이 약 17,700자라 본문 하나에 1단계 사각 패널 약 400개(꼭짓점 공유), 부재 약 210개(줄인 윤곽이라 공유 없음) — 5,562 패널이 본문 14개 / 26개다. 실제 Rhino 시간은 [PLAN-49](../plans/PLAN-49-paneling.md) T-255 「현재 상태」.
- `bake.ts`는 치환 뒤 본문이 "틀 원문에서 치환 자리만 데이터 블록으로 바뀐 것"과 정확히 같은지 확인한다. 키·부호·단면 이름·`vide-role` 값은 점검 `bake-args-safe`(`^[A-Za-z0-9가-힣:_>.\-]{1,64}$`)를 통과해야 한다.
- **객체 속성(사용자 문자열, `data-block.ts`):** 이름은 `vide-` 뒤 소문자 영숫자 단어를 `-`로 이은 것(`^vide-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, 40자 이하)이고, 틀이 스스로 붙이는 `vide-jig`·`vide-instance`·`vide-run`·`vide-bake`·`vide-key`는 쓸 수 없다. 한 객체에 32개까지, 같은 이름 두 번은 거절한다. 값은 `vide-mark`·`vide-section`·`vide-role`만 위의 키 규칙을 따르고, 나머지는 자유 글(주소·한글 공백·숫자·짧은 JSON)로서 1~2,000자, 제어 문자(C0·DEL·C1)·줄/문단 구분자·양방향 재정의·격리 문자·짝 없는 대리 문자를 금지한다. 값은 base64 데이터 블록 안으로만 가고 C# 글이 되지 않는다. 규모검토 jig의 이름 목록(`SITE_ATTRS`, SPEC-12.6·12.9의 6·12.10의 8):

  | 객체 | 속성 이름 |
  |---|---|
  | 필지 | `vide-pnu` · `vide-jibun` · `vide-jimok` · `vide-area-m2`(공부 면적) · `vide-source` · `vide-fetched-at` |
  | 도로 | `vide-width-min` · `vide-width-avg` · `vide-width-source` |
  | 건물 | `vide-floors` · `vide-height` · `vide-height-source`(대장·추정) · `vide-use` · `vide-source` · `vide-fetched-at` |
  | 용도지역 경계 | `vide-zone-name` · `vide-zone-code` · `vide-notice`(고시 번호) |
  | 대지 정보 | `vide-site-summary` · `vide-crs` · `vide-origin-survey`(기준점 측량 좌표) · `vide-true-north` |
  | 외피 | `vide-envelope`(종류) · `vide-rules` · `vide-volume-m3` · `vide-unconfirmed`(미확정 조건 수) |
  | 층 매스 | `vide-option` · `vide-floor` · `vide-area-m2` · `vide-use` · `vide-unconfirmed` |
  | 주차·공지 곡선 | `vide-ground`(종류) · `vide-area-m2` |

  길이는 m, 면적은 ㎡, 부피는 ㎥이고 이름에 단위가 있으면 그 단위다. 값은 글자로 남으며 Sync 표시 읽기(`DisplayScene`)의 사용자 문자열로 대화 AI가 읽는다.
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
    extrude-polygon@1 f32 height(m), rings(고리[0] 바깥, 나머지 구멍; 점의 z = 바닥 높이)
    brep-faces@1      f64 volume(엔진 부피 ㎥), i32 nFaces, rings × nFaces(면마다 바깥 + 구멍)
    mesh@1            i32 nV, vec3 × nV, i32 nF, (i32 a, b, c, d) × nF(d < 0이면 삼각형)
rings = i32 nRings, (i32 n, vec3 × n) × nRings   (닫는 점은 되풀이하지 않음)
```

- 좌표는 VIDE 계약과 같은 m이고 틀이 `RhinoMath.UnitScale(UnitSystem.Meters, doc.ModelUnitSystem)`로 문서 단위로 바꾼다. 절대 좌표를 f32로 넣으면 측량 좌표계처럼 큰 값에서 cm 단위 오차가 나므로 f64 기준점 + f32 차이로 쓴다(1 km 범위 안에서 오차 0.1 mm 미만).
- 틀은 모든 객체에 `vide-jig`, `vide-instance`, `vide-run`, `vide-bake`, `vide-key`를 붙이고 `Item`의 속성을 더 붙인다.
- 워커 본문 한도는 65,536자다. 한도를 넘는 만들기는 항목을 나누어 같은 작업 안에서 여러 번 실행한다(`renderChunks`: 본문 한도에서 틀 길이를 뺀 base64 크기만큼 담는다. 지울 목록이 먼저 들어가고 짧으면 첫 묶음에 모두, 수천 개(패널 교체)면 앞 묶음부터 들어가는 만큼 나누며 각 묶음의 바로 적용 보호 `maxDeletes`는 그 묶음의 목록 수다 — T-255). 한 항목이 혼자 한도를 넘으면 `BAKE_ITEM_TOO_LARGE`로 거절한다. 실제 Rhino 측정(T-208, `tests/integration/rhino-site-bake.mjs`): 건물 300동(속성 5개씩)은 본문 2개(65,342·55,546자, 데이터 43.7·36.3 KB), 지형 1,200면 조각 6개는 조각마다 본문 1개(41,500자), 외피 5개는 본문 1개 — 모두 9개 본문을 바로 적용으로 3.6~3.8초에 만들었다. 데이터 블록은 base64라 본문 글자 수의 약 3/4 바이트다.
- 원점·정밀도: 기준점은 항목 전체 점의 평균을 정수 m로 반올림한 값이고, 차이는 f32다(1 km 범위에서 0.1 mm 미만). 외피처럼 기울어진 평면 면은 기준점에서 수백 m 안에 두어 f32 반올림이 1e-5 m 결합 허용 오차보다 작게 한다(실험의 대지 규모에서 꼭짓점 오차 ≤ 1.8e-6 m). 엔진 부피(`brep-faces@1`의 `volume`)는 f64로 보낸다.
- 반환값: `{ removed, keys[], ids[], failed[] }` — 만든 키와 그 GUID(같은 순서), 만들지 못한 키(퇴화한 곡선·닫히지 않은 솔리드, §9.1의 점검을 통과하지 못한 돌출·외피·메쉬). 틀은 VIDE가 넘긴 GUID 가운데 `vide-instance`·`vide-bake`가 일치하는 객체만 지우고, 지문을 다시 계산하지 않는다. 계획한 키가 두 목록 어디에도 없으면 `BAKE_RECEIPT_MISMATCH`다.

### 9.3 실행 경로

1. `POST …/:iid/bake` → 만들기 계획(항목·키·레이어·태그) → 점검 `before-bake`.
2. 서버가 그 연결의 jig 입력 읽기를 강제로 실행한다(`purpose: 'pre-bake'`, 숨긴 객체 포함, **문서 전체** — 사람이 jig 객체를 다른 레이어로 옮겼는지는 출력 레이어만 읽어서는 알 수 없다). 읽기의 `documentHash`가 실행 직전 기준이 된다: 바로 적용(4)은 호스트 `fingerprint`의 `documentHash`, 작업 사본(5)은 작업 실행본의 문서 판(`expectedDocumentHash`)이 그것과 다르면 `STALE_INPUT`으로 거절한다(다시 읽지 않고 사람이 다시 누른다). 파일 링크는 가져온 사본이 기준이다.
3. §9.4로 지울 GUID와 건너뛸 키를 정해 데이터 블록을 만든다.
4. **바로 적용(주 경로, 2026-09-30 사용자 결정·[ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md)).** 연결이 Rhino 열린 문서(파일 링크가 아님)이고 엔진에 바로 적용 드라이버(ARCH-01 §4 「바로 적용 경로」의 `direct-execute`·`direct-undo`·`fingerprint`)가 있으면 `src/server/jig-routes.ts`가 `workspace_requests` 행 없이 `runDirectBake`(`src/jigs/bake/bake.ts`)를 부른다. 본문(§9.2의 묶음)마다 `direct-execute {requestId: '<실행>:<순번>', code, label: 'VIDE jig: <jig 이름>', guard: {confirmed: false, maxDeletes: 그 묶음의 지울 GUID 수}}`를 불러 본문 하나가 Rhino 되돌리기 기록 하나가 되고, 지운 객체는 모두 그 묶음의 지울 목록 안에 있어야 한다(밖이면 `BAKE_GUARDED`, `kind: 'bulk-delete'`). 보호에 걸리거나(`BAKE_GUARDED`, 그 본문은 호스트가 이미 되돌림) 본문이 실패하면(`BAKE_FAILED`) 앞선 본문의 기록을 최근 것부터 `direct-undo`로 되돌리고 오류를 돌려준다(되돌리기마저 실패하면 `undoFailed`). 끝나면 바로 문서를 다시 읽어 만들기 기록(`jig_bakes`)에 지문·`baselineReadId`·`appliedAt`을 채운다(6을 그 자리에서 수행). 그 읽기가 실패하면 영수증으로 키→객체 대응을 알 때만 지문 없이 기록을 남기고(카드의 [반영 결과 읽기]가 6으로 다시 시도), 대응을 모르면 실행을 되돌리고 `BAKE_READ_FAILED`다. 응답은 `status: 'applied'`이고 후보·적용 단계가 없다. 실행의 되돌리기 기록 번호(`undoIds`)는 엔진 프로세스 메모리에만 있다(7).
5. **작업 사본(대체 경로).** 바로 적용 드라이버가 없거나 파일 링크면 이전 경로를 쓴다(원본 파일은 바꾸지 않는다). `workspace_requests`에 요청을 만든다: `jig: { kind: 'jig-bake', instanceId, bakeIds, linkId, readId, runId }`, `hostUse: 'write'`, `permission: 'candidate'`(`provider`는 이름뿐이며 부르지 않고, AI 턴 상한에 세지 않는다). 그린 본문은 엔진 프로세스의 작업 목록(`registerBakeJob`, 요청 ID별, 최대 64개)에 두므로 재시작 뒤 남은 만들기 요청은 `BAKE_JOB_MISSING`으로 실패한다. `Execution.run`은 이 종류를 보면 공급자를 부르지 않고 `SdkExecution.runFixed(codes[])`로 작업 실행본에서 틀을 차례로 실행한다 → 저장·재열기 확인 → 영수증 → `finishBake`가 만들기 기록(`jig_bakes`, 지문은 비움)과 결과의 `bake`(추가·교체·보존·복사본·지운 것·만들지 못함; 스키마는 `src/ui/bake-card.tsx`)를 쓴다 → 후보. 작업 보기(SCR-03)에 일반 요청처럼 보인다. 사용자가 원본에 반영하면 기존 `applyAttached` 경로를 쓰고, 작업 실행본 이후의 원본 수정은 기존 `Unchanged` 검사가 `SOURCE_CHANGED`로 막는다.
6. 반영 뒤(5의 경로, 또는 4에서 읽기가 실패한 기록) `POST …/bakes/:recordId/baseline`이 문서를 다시 읽어(2와 같은 강제 읽기) 태그 `vide-run`이 이번 `runId`인 객체를 `vide-key`로 기록 항목에 대응시키고 GUID를 바로잡은 뒤 지문(`geometryHash`)·`baselineReadId`·`appliedAt`을 기록한다. 작업 사본 경로에서는 카드의 [반영 결과 읽기]가 부르며 반영 경로가 자동으로 부르지는 않는다(바로 적용은 4가 그 자리에서 읽는다). 읽기 전이거나 실패한 기록의 객체는 다음 만들기에서 `pending-baseline`으로 보존한다. 이전 실행의 복사본은 `vide-run`이 달라 섞이지 않는다. 원본 반영 뒤 GUID가 작업 실행본과 같은지는 실제 Rhino 검증(`tests/integration/rhino-bake.mjs`)이 확인한다.
7. **되돌리기(바로 적용만).** `POST …/:iid/bakes/:recordId/undo` → `undoBake`가 그 실행의 되돌리기 기록을 최근 것부터 `direct-undo`한다. 첫 기록이 문서의 마지막 되돌리기 기록이 아니면 `BAKE_UNDO_NOT_LATEST`, 엔진이 그 실행을 모르면(재시작 뒤 — 4의 `undoIds`는 메모리에만 있다) `BAKE_UNDO_UNAVAILABLE`이며 이때도 Rhino의 Ctrl+Z는 쓸 수 있다. 되돌린 실행의 기록은 `appliedAt`을 비워 다음 만들기가 그 이전 만들기를 기준으로 계획한다.

### 9.4 만들기 기록과 교체 판정

`jig_bakes.items`는 키마다 `{ nativeId, hash, layer, runId, state }`를 담는다. `state`: `jig`(jig가 관리) · `kept`(사람이 고친 것을 유지하기로 함, 이후 건너뜀) · `deleted`(사람이 지운 것, 다시 만들지 않음). 원본 반영 직후 읽기가 실패해 `hash`가 비어 있는 항목은 읽기를 다시 시도할 뿐, 기준 지문을 남기기 전에는 교체하지 않고 사람이 고친 것처럼 보존한다(SPEC-07.17).

| 만들기 기록 | 직전 읽기 | 분류 | 데이터 블록 |
|---|---|---|---|
| `jig` | 같은 GUID, 같은 지문, 레이어 켜짐·풀림 | 교체 대상 | 지울 목록에 넣고 새로 만든다 |
| `jig` | 같은 GUID, 다른 지문 | 사람이 고침 | 지우지 않고 그 키를 건너뛴다. `resolve`가 `overwrite`면 교체, `absorb`면 받을 때 지문을 수정 사항으로 남기고 지우지도 다시 만들지도 않는다 |
| `jig` | GUID 없음 | 사람이 지움 | 다시 만들지 않는다. 사람이 받으면 `state: deleted` |
| `jig` | 같은 GUID가 꺼진·잠긴 레이어 | 지워야 하면 막음 | 점검 `hidden-target` block |
| `kept`·`deleted` | — | 사람 결정 유지 | 건너뛴다 |
| 없음 | `vide-instance` 태그 있음 | 사람이 만든 복사본 | 건드리지 않는다 |
| — | 태그 없음 | 사람 객체 | 건드리지 않는다 |

1차 구현(`src/jigs/bake/plan.ts`)의 보존 이유는 `edited`(같은 레이어, 다른 지문) · `moved`(다른 레이어) · `pending-baseline`(기준 지문 없음) 셋이고, '위치만 바뀜·높이만 바뀜·모양 바뀜' 세부 판정(정점 배열을 경계 상자 중심 차이만큼 옮겨 같으면 위치, 곡선 끝점의 z만 다르면 높이, 그 밖은 모양)은 SPEC-07.13이 표시 방식을 정한 뒤 더한다. `resolve`의 `keep`은 기록을 `kept`로 바꾸고, `overwrite`는 사람이 지운 것도 다시 만들며, `absorb`는 수정 사항(`target.kind: 'bake-item'`, `origin: 'host-edit'`, `fields: { nativeId, hash, layer }`)을 더한 뒤 만들지 않고 `status: 'absorbed'`로 돌려준다. 이후 만들기는 `absorbedOf`로 그 키의 기준 지문을 받을 때 지문으로 옮겨, 객체가 그 지문을 유지하는 동안 jig 결과를 대신하는 것으로 보고 지우지도 다시 만들지도 않는다(SPEC-07.13의 '수정 사항으로 받기'). 받은 뒤 다시 고치면 다시 사람이 고친 것이 되고, `overwrite`면 교체하며, 수정 사항을 지우면 기록된 지문 기준의 보통 교체로 돌아간다. 단계가 수정 사항의 값(예: 단면)을 읽어 결과에 반영하는 것은 단계의 몫이고 아직 어느 단계도 구현하지 않았다(PLAN-23 T-056). 반영하지 않아도 받은 객체는 교체되지 않는다. 사람에게 보이는 방식과 기본 선택은 SPEC-07이 정한다.

### 9.5 레이어

- `layerRoot`는 작업본을 만들 때(또는 skill 시작 작업본은 처음 만들기 때 `PUT …/layer-root`로) 한 번 정하고(`fixedAtPin`) 바꾸지 않는다. `::`로 나눈 경로이며 **연결 문서에 없어도 된다**(2026-10-02). 엔진은 존재를 검사하지 않고 글자만 검사한다(`src/contracts/layer-path.ts`): 빈 단계, 단계 이름 앞뒤 빈칸, 이름 안의 `:`(`a:::b`처럼 단계를 밀어내는 경우 포함)·제어 문자, 단계 이름 100자 초과, 만들기 레이어까지 합쳐 8단계 초과(루트는 7단계까지)를 `LAYER_PATH_INVALID`로 거절한다. 이 검사 전 저장된 작업본의 경로는 만들기 준비(`prepareBake`)가 같은 규칙으로 막는다.
- 틀(`templates/*.cs`의 같은 블록)은 `layerRoot::layer`를 위 단계부터 한 단계씩 찾는다: 각 단계는 **바로 위 단계의 id를 부모로 가진 같은 이름 레이어**(대소문자 무시)이고, 없으면 그 부모 아래 켜짐·풀림으로 새로 만든다. 전체 경로 문자열 검색(`FindByFullPath`)이나 이름만으로 찾지 않으므로 다른 곳의 같은 이름 레이어를 쓰거나 새 하위 레이어가 문서 루트에 생기지 않는다. 이미 있는 레이어의 속성은 바꾸지 않는다. 바로 적용에서는 틀 본문이 `direct-execute`의 실행 기록 하나 안에서 돌므로 새로 만든 레이어도 그 만들기와 함께 한 번에 되돌려진다. 틀은 플러그인 코드를 부를 수 없어(`CodePolicy`가 `Vide` 이름공간을 막음) 같은 걸음을 C# 글로 가진다.
- 원본 반영 코드(`EditorApplication.TargetLayer`)도 같은 규칙이다(`hosts/rhino/worker/LayerPaths.cs`): 후보 3dm 레이어의 부모 사슬을 후보 표의 부모 id로 따라가고(문서 밖 레이어의 `FullPath`는 부모 이름을 모를 수 있어 쓰지 않는다), 각 단계를 같은 id → 위 단계 아래 같은 이름 → 새로 만들기 순으로 정한다. 한 단계가 새것이면 그 아래는 모두 새것이며 부모 다음 순서로 만든다. 부모 id를 표에서 찾지 못하거나 순환이면 루트로 두지 않고 `UNSUPPORTED_APPLICATION`으로 거절한다. 새 레이어는 반영의 실행 기록 하나 안에서 만든다.
- 원본 반영은 레이어 속성(켜짐·잠금)을 옮기지 않는다. 출력 레이어가 꺼져 있으면 VIDE가 켜지 않고 점검으로 막는다.

## 10. 저장: 스키마 v5

### 10.1 규칙

- 대화·원장·공급자 세션 표, jig 표, 자료 검토 표를 **마이그레이션 v5 하나**로 만든다. 번호는 엄격히 연속이어야 하므로(`Non-sequential migration`) 병행 작업이 각자 v5를 만들지 않는다. 한 번에 합칠 수 없으면 들어가는 순서대로 v5·v6·v7을 배정하고 이 절을 고친다.
- `workspace_requests`에는 `conversationId`를 `ADD COLUMN`만 하고 기존 행을 `UPDATE`하지 않는다. `NULL`은 프로젝트 기본 대화다. 큰 Sync 행 때문에 이 열에 색인을 만들지 않는다(행마다 넘침 페이지를 읽게 되어 시작이 느려진다). 필요하면 측정 뒤 더한다.
- 이 열은 요청 입력 JSON의 `conversationId`(§10.3)에서 계산하는 가상 생성 열이다. 저장하는 일반 열이면 기존 코드·시험의 위치 기반 `INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)`가 모두 깨지고, 행 끝(`result` 뒤)에 저장되어 큰 Sync 행에서 넘침 페이지를 읽게 된다. 가상 열은 `input`만 읽는다. 요청의 대화는 제출 때 입력에 넣고 나중에 바꾸지 않는다.
- 데이터 접근은 `src/core/conversation-store.ts`(대화·공급자 세션·원장), `src/core/jig-store.ts`(jig 표), `src/core/knowledge-review-store.ts`(자료 검토 표)가 맡는다. 동작 규칙은 이 모듈을 쓰는 쪽(PLAN-22·24)이 정한다.
- Sync 캡처·jig 입력 읽기·만들기 행은 대화에 속하지 않는다.
- 이관 절차는 ARCH-01 §1.3(버전 확인 → 백업 → 트랜잭션 변경 → 무결성 확인)을 따른다. v5 이후에는 이전 설치본으로 되돌릴 수 없으며(`UNSUPPORTED_SCHEMA`), 배포 안내에 적는다.
- v6은 프로젝트 폴더 표 `project_folders` 하나다(2026-10-01, PLAN-26 T-091). 정의는 ARCH-01 §3 「프로젝트 폴더와 파일 읽기 도구」가 소유한다.
- v7은 할 일 표 `agenda_items` 하나다(2026-10-01, PLAN-26 T-098). 정의는 ARCH-01 §3 「대시보드의 할 일」이 소유한다.

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

위 표는 `src/core/migrations.ts`의 v5와 같다(2026-09-30 4차 물결에서 대조). 표를 쓰는 쪽의 구현 상태:

- `conversations`·`provider_sessions`·`ledger_items`: `src/core/conversation-store.ts`. `kind`·원장 `kind`의 값 목록은 그 모듈의 `conversationKinds`·`ledgerKinds`가 정본이다. `jig-make` 대화는 `draftId`를 가진다. Claude·Codex 모두 `mode: 'session'`으로 이어 실행한다(Codex는 SPIKE ④ 재시험 통과 뒤, PLAN-24 T-061). 예외로 Codex의 `jig-make` 대화는 `mode: 'ledger'`이다: 초안 파일이 매 턴 `draft-files` 항목으로 가고, VIDE가 쓴 `files`의 결과는 원장 `code` 항목으로 남는다(ARCH-01 §2).
- `jig_drafts`(PLAN-22 T-063): `src/core/jig-store.ts`·`src/jigs/runtime/drafts.ts`. 행 하나가 초안 폴더 `<data>/jigs/drafts/<id>/`(§2.3) 하나다. `state`는 `open`(만들기 대화가 쓸 수 있음) → `pinned`(고정: 설치본 `jig_packages`·`project_jigs` 행을 만듦) 또는 `discarded`(버림: 폴더 삭제)로만 간다. `archived`는 자리만 있고 1차에는 쓰지 않으며 `openedAt`은 만들 때 한 번 적는다. `conversationId` 열은 1차에 채우지 않고, 초안을 쓰는 대화는 `conversations.draftId`(열린 것 가운데 최신)로 찾는다. 버려도 행은 `discarded`로 남는다. 마지막 점검·시험·미리보기 결과는 표가 아니라 초안 루트의 `.results/<id>.json`에 둔다(AI가 쓰는 폴더 밖, 버릴 때 함께 지움).
- `jig_packages`: 초안 고정은 `source: 'ai-draft'`, `signer`는 비운다(§12). `jig_bakes`·`jig_reads`는 §9, 자료 검토 표는 `src/core/knowledge-review-store.ts`(사람만 씀, SPEC-08.5).

### 10.3 요청 JSON에 더하는 필드(열 추가 없음, 잠정)

- `input.conversationId`: 요청이 속한 대화 ID. 없으면 프로젝트 기본 대화이고, `workspace_requests.conversationId` 가상 열이 이 값을 읽는다(§10.1). Sync 캡처·만들기 요청에는 넣지 않는다. 작성기는 기본 대화의 턴을 `default`로 보내고, 서버는 첫 턴에 `conversations` 행 `default-<projectId>`를 만들어(그 턴의 명시 모델, 아니면 Jev 한 번) 그 ID로 바꿔 저장한다. 그 전의 `NULL` 요청은 목록에서 기본 대화(`id: null`)로 함께 센다(2026-10-01, PLAN-24 T-088).
- `input.hostUse`: `'none' | 'read' | 'write'`. `none`이면 호스트 경합 대상 목록이 비고, `read`는 문서 키만 가진다(SPEC-02.9).
- 차례를 기다리는 요청은 거절하지 않고 `state: 'queued'`로 두고, 결과 JSON에 `waitingFor: { kind: 'document' | 'conversation' | 'project', key, position }`을 적는다. `document`는 같은 문서 쓰기의 대기열, `conversation`은 한 대화에서 진행 중인 턴 뒤에 덧붙인 말, `project`는 프로젝트 AI 턴 상한(기본 3)이다. 앞 작업이 끝나면 실행기가 다음을 꺼낸다. 재시작 뒤 `queued` 요청은 보존하되 자동으로 실행하지 않는다(SPEC-02.9).
- 요청 자료의 원장 항목은 `ledger` 항목(`{ scope: 'all' | 'since-last-turn', items[], summarized, omitted }`) 하나이며 `supersededBy`가 없는 최신 항목만 넣고 8 KB를 넘으면 오래된 것부터 요약하고, 그래도 넘으면 뺀다. 세션 턴은 6턴마다 전체를, 그 사이에는 지난 턴 이후 항목만 보낸다. 새 세션의 첫 턴에는 `handoff` 항목(이유·최근 3턴·파일 이름), 다른 대화가 그 사이 반영한 것은 `changes-elsewhere` 항목으로 더한다.
- 대화 경로(`src/server/conversations.ts`): `GET·POST /api/v1/projects/:id/conversations`(POST `{kind?, title?, body?, provider?, model?, effort?, host?, permission?, jigInstanceId?, draftId?, targets?}` — 서비스·모델을 안 주고 `body`가 있으면 Jev가 한 번 고르고 계정은 `accountUsage.choose`로 고정), `GET …/conversations/:cid`(`default`는 기본 대화; 원장·세션 포함), `POST …/:cid/close`(`{discard?}`: 기록 즉시 삭제)·`reopen`·`ledger`(`{kind, body, requestId?}`)·`bind`·`unbind`(`{jigInstanceId}`: 묶기와 그 되돌림, 다른 작업본에 묶인 대화는 `CONVERSATION_BOUND`)·`handoff`(`{provider, model?, effort?}`, 확인 필요 동작, 원격 세션 403). 오류 `CONVERSATION_CLOSED`·`CONVERSATION_PROVIDER`(409). 요청 접수 때 `conversationId`가 있으면 `place`가 첫 턴이면 서비스·모델을 정하고(`routing`은 이 턴에만 남는다), 그 뒤에는 그 대화의 서비스·모델·계정으로 고정하며(`fix`, effort만 요청 값), 요청의 명시 모델이 다르면 새 대화를 만들어 `conversationId`를 바꾼다(양쪽 원장에 `handoff` `{reason: 'moved'|'model'}`, 새 대화 첫 세션의 `handoff` 항목에 `from.ledger`). 한 대화에 한 턴만 실행한다(`waitingFor.kind: 'conversation'`에 `after`·`position`). AI를 고르지 않고 연 대화(`body` 없이 자동, 화면의 [+]는 `{kind:'general'}`만 보낸다)는 Jev를 부르지 않고 원장에 `decision {aiChoice: 'first-turn'}` 표시를 두어 첫 턴에 지우며(목록의 `pending`), 그 첫 턴에 이름이 아직 그 종류의 기본 이름이면 요청 글의 앞 60자로 바꾼다(T-097). `handoff` 경로는 새 대화를 만들어 돌려준다.

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
| before-bake | `solid-closed`, `tag-scope`, `count-match`, `layer-scope`, `hidden-target`, `bake-args-safe`, `inputs-confirmed`, `analysis-confirmed`, `target-confirmed`, `paneling-confirmed` | block |

`analysis-confirmed`는 부재 만들기에 같은 입력 지문의 확정 해석이 있어야 통과한다(SPEC-06). `target-confirmed`는 `confirm-target` 사람 단계가 확정 상태여야 통과한다(SPEC-12.3의 3). `paneling-confirmed`는 만들기 선언의 단계(`items`가 가리키는 단계 id `preview`·`members`·`optimize`)와 그 앞 단계의 설정값 가운데 출처가 '가정'(`by: 'default'`)인 것이 없어야 통과한다 — 단계는 설정값 `group`('1단계 미리보기'·'2단계 부재'·'3단계 최적화·타입화')으로 나누고, 다른 값과 함께만 읽는 값(합치기 기준·투영 평면)은 그 값을 골랐을 때만 센다. 미리보기는 늘 통과한다(계약 `makeAllowed`, SPEC-16.4 3, `src/jigs/runtime/paneling-confirmed.ts`). `non-empty`는 `args.message`로 jig의 문장을 줄 수 있다(예: 대상 필지 경계 없음). 점검 실패 이유는 단계 레일에 건축 문장으로 보인다(문구는 Design). 목록에 있으나 아직 구현되지 않은 점검은 선언한 수준으로 실패한다(fail closed)—설명서 검사가 `JIG_GATE_PENDING` 경고로 알린다. 항목 점검의 인자는 `items`(출력 안 배열 경로)·`key`(안정 키 필드)·`field`(다각형·점 필드)·`boundary`(입력 경로 또는 `output.` 접두 출력 경로)다.

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
