---
id: SPIKE-2026-09-21-agent-tools
title: 작업별 MCP 연결과 호스트 실행본 소유 확인
status: review
version: 0.3
updated: 2026-09-22
owner: agent:codex
related: [PLAN, PLAN-02, SPEC-02, T-004, T-018]
---

# 작업별 MCP 연결과 호스트 실행본 소유 확인

## 질문과 범위

PLAN-02 §6의 1단계 착수다. 기존 Node 서버에 별도 서버 프로세스 없이 MCP 도구 연결을 내장하고, 작업별 권한과 대상이 브라우저 세션과 분리되는지 확인한다. 새 Rhino 경로에서는 VIDE가 직접 기동한 프로세스만 소유 증거를 가질 수 있도록 한다. 사용자 문서나 실제 CAD 프로세스에 AI 코드를 보내는 시험은 아직 수행하지 않았다.

## 환경과 구현

- Windows, Node.js 24.15.0. 공식 `@modelcontextprotocol/sdk` 1.30.0, `zod` 4.6.5를 package-lock에 고정했다. [공식 SDK 서버 가이드](https://ts.sdk.modelcontextprotocol.io/server)의 stateless Streamable HTTP 패턴을 사용한다.
- `src/server/agent-tools.mjs`: 기존 loopback HTTP 서버의 `/mcp`. 내부 제어기가 발급한 무작위 토큰의 해시만 보관한다. 작업 대상·기준 검사·호출 수·만료·회수를 묶고, 허용한 query/execute/status/cancel만 노출한다. 브라우저나 에이전트가 범위를 생성하는 API는 없다.
- 호스트 실행기는 기본 등록하지 않는다. 제품 요청은 계속 기존 제한 JSON 경로로 처리된다. 새 도구의 실제 실행 연결은 영속 명령 기록·불명확 복구·컴파일 전 대상 검사를 갖춘 뒤 수행한다. 이 모듈의 메모리 상태는 영속 실행 저널이나 중복 쓰기 방지를 대체하지 않는다.
- `hosts/rhino/owned-process.mjs`: 직접 spawn한 프로세스의 PID·시작 ticks·실행 파일을 고정한다. OS 리스너 대조는 문자열 ticks를 사용해 정밀도 손실을 피한다. 기존 프로세스를 소유 실행본으로 등록하는 함수는 없다.
- `hosts/rhino/transport.mjs`: 새 경로용 전송 직전 검사를 선택적으로 지원한다. 재접속에도 매번 검사하며 검사 실패나 대기 중 타임아웃 이후에는 바이트를 보내지 않는다. 기존 제한 JSON 호출은 그대로 유지한다.
- `src/desktop/build.mjs`: 잠금 파일의 제품 의존성과 라이선스를 패키지에 포함한다. 이전 Three.js 파일만 복사하는 방식은 MCP SDK의 전이 의존성을 누락하므로 교체했다.

## 수행 결과

`npm test`의 기존 회귀와 신규 시험 합계 96개가 통과했다. 신규 시험은 실제 loopback TCP 및 HTTP 연결을 사용하고 호스트 동작은 모의 처리한다.

| 확인 | 결과 |
|---|---|
| 공식 MCP 클라이언트 초기화·허용 도구 조회·호출 | 통과 |
| 다른 대상·미허용 도구·브라우저 API 권한 사용 | 거절 |
| 자격 증명 누락·만료·회수·외부 Origin·잘못된 입력 | 거절 |
| 낡은 기준·호출 상한·동시 실행·기준 확인 중 회수 | 실행기 호출 전 거절 |
| 내부 예외의 경로/자격 증명 유출 | 일반 오류 코드로 차단 |
| 모의 프로세스 교체·PID 재사용·프로세스 종료 | 소유 불일치 또는 만료로 거절 |
| TCP 재접속 뒤 외부 프로세스가 포트 점유 | 두 번째 명령 바이트 0 |
| 소유 검사 타임아웃 뒤 늦게 검사 완료 | 명령 바이트 0 |

Windows OS 조회 함수는 시험 Node 프로세스의 PID·문자열 시작 ticks·실행 파일 반환을 확인했다. 실제 Rhino 시작/리스너의 소유 일치와 합성 문서 세션 검사는 미시험이다.

Windows 개발 패키지 `0.1.0-agent-tools-1`을 생성했다. 포함된 Node 런타임으로 패키지 내부 서버를 시작해 첫 페이지 HTTP 200, 무인증 MCP HTTP 401, 정상 종료를 확인했다. 이는 이번 의존성의 패키지 시작 검사이며 새 PC 설치·브라우저 시각 검수·실호스트 검수를 대체하지 않는다. 산출물은 `.vide/releases/`에 있고 Git에는 넣지 않는다.

## 한계와 다음 검증

실제 구독 CLI 연결을 `tools/spikes/2026-09-21-agent-tools/cli-probe.mjs`로 수행했다. Claude는 합성 조회 1회/5.567초로 통과했다. Codex는 도구 런타임 비활성 문제 2회와 도구 승인 설정 문제 1회를 진단한 뒤 수정본에서 조회 1회/25.174초로 통과했다. 각 호출은 최대 60초·도구 상한 5회이며 실패 이유를 확인한 수정/진단 외에 자동 반복하지 않았다. API 유료 인증으로 전환하지 않았다.

성공 호출의 공급자 보고 사용량: Claude input 4/output 74, Codex input 27,836/output 262. 이는 보고된 필드이며 캐시 입력을 합산한 총량이나 구독 차감량을 뜻하지 않는다. 실패/진단 호출도 구독을 사용했다. 이 소규모 연결 시험으로 속도나 비용 우위를 판정하지 않는다.

설치 Codex 0.154.0-alpha.6.2는 내장 code-mode host를 통해 MCP를 제공하므로 새 연결에서만 해당 런타임을 활성화했다. 셸/파일/웹 도구는 비활성 상태를 유지한다. 허용된 VIDE 서버 도구에만 승인 설정을 부여한다. Claude의 safe-mode는 명시한 MCP도 비활성화하므로 새 경로에서 restricted 모드·빈 내장 도구·명시적 MCP/도구 허용 목록을 사용한다. 기존 도구 없는 경로의 거절 시험은 유지했다.

공식 설정 근거: [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude MCP](https://code.claude.com/docs/en/mcp), [Claude CLI](https://code.claude.com/docs/en/cli-reference).

OS 소유 대조만으로 AI 코드의 컴파일/초기화 안전을 주장하지 않는다. 다음 호스트 시험은 고정 조회로 소유 실행본과 합성 문서 기준을 확인하고, 컴파일 전 신뢰된 진입점이 확인을 다시 수행하는지 검증해야 한다. 확인 전에는 범용 AI 코드를 기존 Rhino 수신부로 전달하지 않는다. 소유 프로세스 수명 관리·원본 사본 생성·실제 CAD 편집·공유 서비스는 이 시험의 완료 범위가 아니다.

## 자체 Rhino worker 실증 — 2026-09-22

`hosts/rhino/worker`에 .NET 8 C# 플러그인과 신뢰된 시작 로더를 구현했다. `dotnet build hosts/rhino/worker/VIDE.Worker.csproj --no-restore`로 설치된 RhinoCommon/Roslyn을 참조한다. 컴파일 결과는 `.vide/build/rhino-worker`에 두고 Git에 포함하지 않는다. `tools/spikes/2026-09-21-agent-tools/host-probe.mjs`가 새 Rhino 실행본·headless 문서만 만들며 시험 종료 시 소유 PID/시작 ticks/실행 파일이 일치하는 실행본만 종료한다. `--visible`은 진단용 창 표시다.

이전 90초 준비 실패의 두 원인을 실제 Rhino 창과 명령 이력에서 확인했다. Node의 기본 Windows 인자 인용으로 /runscript가 실행되지 않았고, 이를 고치자 -PlugInManager가 설정 대화상자를 열고 정지했다. [공식 시작 인자](https://docs.mcneel.com/rhino/8/help/en-us/information/startingrhino.htm)에 맞춘 verbatim /runscript와 RunPythonScript 로더로 바꿨다. 로더는 설치본 RhinoCommon.xml의 `PlugIn.LoadPlugIn(string, out Guid)`를 호출한 다음 고정 VIDEWorkHost 명령만 실행한다. 이 API는 플러그인 등록 정보를 Rhino에 남기므로 향후 배포/제거 처리에 포함해야 한다. 현재는 개발 실험이며 사용자 기본 플러그인 설정을 정리하거나 삭제하지 않았다.

수신부는 loopback 임의 포트를 열고 작업별 토큰·세션·PID·시작 ticks를 확인한 후 UI 스레드의 고정 실행기로 보낸다. 실행기는 headless 문서 ID·revision·operation ID/코드 해시를 검사한 뒤에만 코드를 컴파일/로드한다. 사용자 원본 문서를 전달하지 않는다. 실행 의도와 결과를 flush한 임시 파일→교체로 기록하며, 실행 후 오류는 unknown으로 잠근다. 같은 작업 ID/동일 코드는 기존 결과를 반환하고 다른 코드는 거절한다.

최종 기본 숨김 실행 시험은 16.218초였다. 10×8×6 m 박스 1개를 생성해 20,895-byte 3dm에 저장하고 재열었다. 재열기 검증은 단위·객체 개수/ID/종류·유효 기하·경계이며 모든 속성/위상 동등성 검증이라는 뜻은 아니다. 파일 SHA-256도 Node에서 대조했다. 잘못된 문서/세션/낡은 revision/컴파일 오류/같은 operation ID의 다른 코드가 거절됐고 동일 제출 재전송으로 객체가 늘지 않았다. 실행본 종료를 확인했다. 증거 디렉터리는 `.vide/worker-probe/5cc3764c-86e8-4ba5-9a38-742c00bc754b`이며 토큰은 로그나 저장소에 넣지 않는다. 앞선 표시 실행 시험에서도 생성/저장/중복 억제가 13.424초에 통과했다.

자동 회귀는 102/102 통과했다. 추가 시험은 PID 재사용 시 stop이 프로세스를 종료하지 않고 소유 실행본만 한 번 종료하는지 확인한다.

이제 시작 실패는 재현 원인을 수정한 상태다. 남은 단계는 실제 구독 에이전트의 query→SDK 코드→execute 루프, 제품 후보/뷰포트 DTO 이식, 사용자 사본 취득과 결과 저널 복구, 복수 실행본·ZWCAD, 패키지 배포다. 이 worker는 같은 사용자 권한의 C# 코드 실행기이며 악성 코드 샌드박스가 아니다. 제품의 일반 요청 경로는 아직 기존 구현을 사용한다.
