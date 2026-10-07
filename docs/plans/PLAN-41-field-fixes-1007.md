---
id: PLAN-41
title: 2026-10-07 실사용 수정 묶음 (코드 검사 오탐·Sync 단어 규칙·Markdown·노트 분류·덤프)
status: review
version: 0.1
updated: 2026-10-07
owner: agent:claude
related: [ADR-031, ADR-036, ADR-037, SPEC-02, SPEC-04, SPEC-10, PLAN-12, PLAN-36]
---

# 2026-10-07 실사용 수정 묶음

[실제 데스크톱 검수](../tdd/VERIFY-2026-10-07-desktop-product-audit.md)와 0.2.24 진단 묶음에서 나온 문제를 고친다. 2026-10-07 사용자 지시: "그렇게 진행해주고, 플러그인들은 그냥 다 정리해줘". 방향은 [ADR-031](../decisions/ADR-031-stock-first.md)(순정 우선: VIDE는 돕는 쪽이고 막지 않는다)이다.

## 완료

- **사이트 D1 읽기 한도 초과.** 24시간 526만 행(무료 500만 행)을 읽었고, 그중 99%가 Better Auth가 요청마다 하는 표 구조 검사였다. `src/sharing/auth.ts`에 `advanced.database.validateSchema: false`를 넣었다. 표 구조는 D1 마이그레이션이 소유한다. Worker 버전 `8f3d645f`로 배포했다(`5f57dd5`).

## 티켓

| 티켓 | 내용 | 기준 | 검증 |
|---|---|---|---|
| T-187 | ZWCAD C# 코드 검사를 Rhino와 같은 '탈출 규칙만' 방식으로 바꾼다. 지금은 네임스페이스 허용 목록이라, `if (circle == null)`처럼 무해한 코드가 `ZwSoft.ZwCAD.Runtime.DisposableWrapper.op_Equality`로 거절됐다(요청 `6feeb15c`). 파일 열기·저장·종료, Transaction 커밋·중단·해제, 외부 프로세스·네트워크·리플렉션·동적 로딩처럼 Rhino `CodePolicy`가 막는 범주만 막는다. | ADR-031 8, SPEC-02 바로 실행 | ZWCAD 빌드 오류·경고 0. 정책 시험: `== null` 비교와 `ZwSoft.ZwCAD.Runtime`의 일반 연산은 통과, 위험 범주는 계속 거절 |
| T-188 | 요청 라우터의 Sync 단어 규칙을 없앤다. `sync|동기화|다시 읽`과 파일 단어가 함께 있으면 AI보다 먼저 'Sync 받을까요?' 카드를 띄워, "Sync 완료된 상태에서 원 개수 알려줘" 같은 조회를 막았다. Sync가 필요한지는 AI가 판단해 Sync 도구를 부른다. | ADR-031, SPEC-02.17 | 라우터 시험: Sync 단어가 들어간 조회는 AI로 간다. 화면의 ⟳·Sync 버튼은 그대로 |
| T-189 | AI 답을 Markdown으로 그린다. 지금은 `**`·표 기호가 글자 그대로 보인다. 제목·굵게·기울임·목록·표·코드·링크를 그리고, 원문 HTML은 그리지 않는다(XSS 방지). 작업 화면 답, 대화 미러, 원격 프로젝트, 검토본 화면에 같은 렌더러를 쓴다. | Design 해당 SCR | 단위 시험: 표·굵게·코드, `<script>`·`javascript:` 링크 무력화. 브라우저 시험 한 개 |
| T-190 | 노트 요약 같은 요청을 호스트 없는 요청으로 구분한다. (1) 보낼 때: 노트·일지·대시보드·자료 화면에서 보낸 요청은 핀·스케치·연결 파일이 없고 글이 파일을 가리키지 않으면 `hostUse: 'none'`으로 보낸다. (2) 끝난 뒤: 사이트에 올릴지(ADR-037 4 조정)는 실제로 호스트를 읽거나 고쳤는지로 정한다. 호스트 연결만 하고 읽지도 고치지도 않은 요청은 올린다. 규칙 정본은 [SPEC-04.12](../specs/SPEC-04-web-review.md)이다. | ADR-037 4, SPEC-04.12, PLAN-36 | 계약 시험: 노트 화면 요약 → hostUse none, 대상 문서 없음, 미러 대상. 호스트를 실제 조회한 요청은 미러 제외 |
| T-191 | 덤프와 사라진 프로젝트. (1) ProcDump를 정상 종료 때 쓰지 않는다(`-t` 제거). 정상 종료 덤프 230MB가 진짜 크래시 덤프를 밀어냈다. (2) 진단 묶음에는 최근 크래시 덤프 1개만 넣고, 넣을지는 묶음을 만들 때 묻는다. (3) 열린 프로젝트가 사라지면(사이트 삭제·정리) 화면이 목록으로 돌아가고, 없는 프로젝트를 계속 조회하지 않는다(10-06 40분간 404 약 1,500건). | ADR-036, SPEC-10 | 단위 시험: ProcDump 인자에 `-t` 없음, 묶음 덤프 1개. 화면 시험: 프로젝트 404 뒤 목록으로 이동, 폴링 중단 |

## 환경 정리 (제품 코드 아님)

Rhino 8의 겹칠 수 있는 플러그인을 정리한다. 대상은 Vino 0.1.0-alpha.7, Wireify 0.3.0, Figcad 개발 빌드, Cordyceps(Libraries와 packages 두 벌), 저장소 `.vide/build/rhino-worker-next`의 VIDE.Worker 개발 등록이다. GPTino는 등록이 없다. rhinomcp는 VIDE 안의 AI와 겹치지 않아(`--strict-mcp-config`, Codex `mcp_servers={}`) 남긴다. Rhino가 꺼진 뒤 등록을 지우고, 파일은 지우지 않고 백업 폴더로 옮긴다.

## 완료 판단

다섯 티켓의 시험과 `npm run verify`를 통과하고 0.2.28로 배포한다. 설치본에서 노트 요약이 Rhino 연결 없이 끝나는지, CAD에서 `== null` 코드가 통과하는지 실제로 확인한다.
