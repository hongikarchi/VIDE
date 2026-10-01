# VIDE

건축가가 Rhino·ZWCAD 옆에 띄워 두고, 말로 모델·도면 작업을 시키는 Windows용 AI 작업 환경입니다. 연결한 Rhino 문서와 CAD 도면을 한 화면에서 보고, AI가 열린 문서를 직접 고치며(실행마다 되돌리기 가능), 구조 분석 같은 반복 작업은 jig로 묶어 씁니다. 제품 범위와 요구는 [docs/PRD.md](docs/PRD.md)에 있습니다.

## 설치 (사용자)

1. [Releases](https://github.com/hongikarchi/VIDE/releases/latest)에서 `VIDE.App-win-Setup.exe`를 받아 실행합니다. 관리자 권한이 필요 없고, 이후 업데이트는 자동입니다.
2. VIDE 설정 → **연결 프로그램**에서 Rhino 8·ZWCAD 플러그인을 설치합니다. 설치할 때 해당 프로그램을 닫아 두세요.
3. Rhino나 ZWCAD 패널에서 **Link**를 눌러 문서를 프로젝트에 연결합니다.
4. AI는 이 PC에 로그인된 Claude Code 또는 Codex CLI를 씁니다.

의견과 문제는 VIDE 왼쪽 아래 **피드백** 버튼(구글폼)으로 보내 주세요.

## 개발

- 필요: Windows x64, Node.js 24(`>=24.15 <25`), Rhino 8·ZWCAD(호스트 시험 때), .NET SDK(플러그인·데스크톱 셸 빌드 때), Rust(구조 해석 코어 빌드 때)
- 준비: `npm install`, `npm --prefix tools/docs install`(커밋 훅도 이때 등록됩니다)
- 실행: `npm run dev` — 개발 엔진은 포트 47831과 `.vide/dev-data`를 써서, 실무용 설치본(포트 47821)과 섞이지 않습니다.
- 시험: `npm run typecheck`, `npm test`, `npm run test:browser`
- 설치본 만들기: `npm run desktop:release -- <버전>`
- 문서 HTML 다시 만들기: `npm --prefix tools/docs run build`

엔진과 화면은 TypeScript입니다(Node 24가 `.ts`를 바로 실행). 시험·도구 스크립트는 `.mjs`, Rhino·ZWCAD 플러그인과 데스크톱 셸은 C#, 구조 해석 코어는 Rust입니다.

## 폴더

| 폴더 | 내용 |
|---|---|
| `src/` | 엔진(`server`, `core`, `ai`), 화면(`ui`), jig 실행기(`jigs`), 데스크톱 셸(`desktop`), 계정 사이트(`sharing`) |
| `hosts/` | Rhino·ZWCAD 플러그인 |
| `extensions/` | jig 예제와 프로젝트 jig |
| `tests/` | 단위·서버·브라우저·호스트 시험 |
| `tools/` | 문서 렌더러, 점검·측정 도구, 미리보기·실험 |
| `docs/` | PRD, SPEC, ARCH, PLAN, 결정(ADR), 조사, 검수 기록 |

## 문서

- 에이전트(Claude Code, Codex 등)는 [AI.md](AI.md)부터 읽습니다.
- 사람은 [DEVELOPMENT_GUIDE.md](DEVELOPMENT_GUIDE.md), 지금 진행 상황은 [docs/plans/PLAN.md](docs/plans/PLAN.md) §6.5를 보면 됩니다.
- 화면 설계는 [Design.md](Design.md), 기능별 명세는 [docs/specs/](docs/specs/README.md)에 있습니다.
