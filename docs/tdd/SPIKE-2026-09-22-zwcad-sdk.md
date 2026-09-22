---
id: SPIKE-2026-09-22-zwcad-sdk
title: 설치된 ZWCAD 2023 SDK 빌드·작업 사본 실험
status: review
version: 0.6
updated: 2026-09-22
owner: agent:codex
related: [T-003, T-006, T-011, H-ZWCAD-04, H-ZWCAD-05]
---

# 질문과 종료 조건

설치된 ZWCAD 2023의 공식 .NET DLL로 자체 애드인을 빌드하고 활성 사용자 문서 대신 별도 Database에서 합성 DWG를 생성·저장·재열기할 수 있는지 확인한다. 이후에만 일반 AI 코드 실행 래퍼와 소유 실행본 연결을 이식한다. 종료 조건은 빌드, 명시적으로 소유한 시험 실행본의 로드, 20×10 m 경계의 면적 200 m²·길이 60 m·Handle/색/단위 보존이다. 컴파일 성공만으로 런타임 호환·제품 지원을 선언하지 않는다.

코드는 `tools/spikes/2026-09-22-zwcad-sdk/`, 출력은 `.vide/build/zwcad-sdk-probe/`다. [ZWSOFT 공식 개발 지원](https://www.zwsoft.com/support/zwcad-devdoc)은 COM과 ZRX.NET을 별도 경로로 설명한다. 설치된 `ZwManaged.dll`·`ZwDatabaseMgd.dll`을 직접 참조하며 제3자 NuGet 패키지를 도입하거나 SDK DLL을 재배포하지 않는다.

## 수행 범위

`build.ps1`은 Windows .NET Framework C# 컴파일러로 명시적 참조를 확인한다. `SdkProbe.cs`의 명령은 전용 시험 실행본에 주입한 `VIDE_ZWCAD_PROBE_DIR`가 있을 때만 동작하며 파일을 덮어쓰지 않는다. 별도 Database/Transaction을 사용하고 ActiveDocument를 읽거나 수정하지 않는다. 시작 스크립트로 소유 시험 실행본에만 NETLOAD를 수행한다.

## 결과

빌드가 통과했다. 설치 어셈블리는 ZwManaged/ZwDatabaseMgd 23.20.23.20, CLR 이미지 버전은 v4.0.30319다. `.vide/build/zwcad-sdk-probe/build-result.json`에 참조 버전과 출력을 기록했다. 실행은 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File tools/spikes/2026-09-22-zwcad-sdk/build.ps1`이며 시스템 실행 정책을 바꾸지 않는다.

`node tools/spikes/2026-09-22-zwcad-sdk/run.mjs`가 `.vide/zwcad-sdk/657dac6c-1313-4b47-aa56-e3dd3bbb17ab`에서 실제 ZWCAD 2023 로드→별도 Database 생성→DWG 저장→다시 읽기까지 통과했다. 면적 200 m²·길이 60 m·mm 단위·색 3·4개 정점·닫힘과 Handle 44가 보존됐다. `/b` 시작 스크립트에서 .NET 명령을 실행했으며 `ActiveDocument`를 사용하지 않았다. 기존 소유 프로세스 검사 도구로 PID/시작 시각/실행 경로를 확인한 별도 실행본만 생성·종료했다. 시스템 마우스와 기존 사용자 문서를 조작하지 않았다.

이 결과는 로컬 공식 SDK의 빌드·로드·Database/Transaction·저장/재열기 호환성 증거다. 기본 도구 재편집, 여러 ZWCAD 실행본의 문서 대상 식별·인증 채널, 실제 AI 연결과 제품 어댑터 연결은 미검증이다. 이 실험은 기존 COM 제품 경로를 바꾸지 않는다.

## 코드 실행과 실패 격리

`CodeProbe.cs`는 설치 SDK를 참조해 전달받은 C# 본문을 메모리에서 컴파일하고 별도 Database의 Transaction 안에서 실행한다. 편집 명령 템플릿 대신 `db`·`tr` 진입점을 제공한다. 이 실험의 코드는 시험 스크립트가 작성했으며 실제 AI 생성 결과로 집계하지 않는다. 같은 프로세스의 임의 C#을 실행하므로 보안 샌드박스가 아니고, 원본 파일 해시 보존도 악성 코드 격리의 증거가 아니다.

| 실행 | 실제 결과 | 로컬 증거 디렉터리 (`.vide/zwcad-sdk/` 아래) |
|---|---|---|
| `run.mjs --code` | 20×10 m 사본을 24×10 m로 수정하고 저장/재열기: 240 m²·68 m, Handle·색·mm·원본 해시 보존 | `638386da-7a37-4301-90bb-8ae3cf2ead32` |
| `run.mjs --compile-error` | 컴파일 오류 전달, 원본 해시 보존, 후보 파일 없음 | `632244d5-9597-4336-8907-2ff58a2c2c53` |
| `run.mjs --runtime-error` | 사본 메모리의 정점 수정 후 예외 전달, 원본 해시 보존, 후보 파일 없음 | `7ece5b2c-3830-495a-81a0-60528b8ae747` |

음성 시험의 `result.json`에서 `passed:false`는 요청된 편집의 실패이고, `verification.json`의 `verificationPassed:true`는 예상한 거절·보존 결과를 확인했다는 뜻이다. 각 시험은 소유한 프로세스만 종료했다. 다음 검증은 실행본·문서·기준을 확인하는 인증 연결이며 기존 COM 제품 경로는 아직 유지한다.

## 2 실행본의 인증 채널과 호스트 스레드

`ChannelProbe.cs`·`channel.mjs`는 같은 4바이트 길이 + JSON TCP 프레임을 재사용한 읽기 전용 실험이다. loopback 임의 포트, 실행별 임시 토큰, PID/시작 시각/세션과 논리 문서 ID·revision을 대조한다. 토큰은 환경으로 전달하고 결과 파일에 저장하지 않는다. CAD API는 네트워크 스레드에서 호출하지 않고 `Application.Idle` 큐에서 실행하며 시작 명령과 같은 스레드 ID인지 확인한다. 요청마다 별도 합성 Database를 만들고 읽은 뒤 폐기하며 활성 사용자 문서는 접근하지 않는다. 이 논리 ID는 지속 문서/저장 DWG 식별의 완성본이 아니다.

`node tools/spikes/2026-09-22-zwcad-sdk/channel.mjs`가 `.vide/zwcad-channel/cbdd413b-101f-4499-b66f-f1170b88c6c2/result.json`에서 통과했다. 실제 ZWCAD 2023 두 프로세스의 각 조회는 면적 200 m²와 서로 다른 PID/문서 ID를 반환했다. 잘못된 토큰, 상대 세션/PID/문서 ID, 틀린 시작 시각, 오래된 revision 및 미지원 실행 메서드를 거절한 후 정상 조회도 유지됐다. 첫 프로세스만 종료한 뒤 두 번째 조회가 계속 성공했고 마지막에 나머지 소유 실행본도 종료했다.

이는 2개의 자체 시험 채널·호스트 스레드 전달 검증이다. 지속 문서 쓰기/취소/영수증·중복 요청·응답 유실·재연결, 실제 사용자 여러 문서, AI 호출과 UI 제품 연결은 아직 미완료다. 실험의 직렬 네트워크 처리와 제한된 큐는 제품 서버의 완성형으로 채택하지 않는다.

## 지속 사본·실행 영수증 검증

`SessionProbe.cs`와 `session.mjs`는 인증 채널의 별도 실행 모드에서 고정 합성 원본→작업별 DWG 사본→저장/재열기→결과 영수증을 연결한다. revision·operation ID와 코드 해시를 대조하며 같은 요청은 저장된 결과를 반환한다. 결과 확인 중 오류가 나면 세션을 불명확 상태로 잠근다. 컴파일/트랜잭션 내부 오류는 현재 기준 파일을 유지한다. 요청 코드가 운영체제나 다른 문서에 접근하는 것을 격리하는 샌드박스는 아니다.

실제 결과는 `.vide/zwcad-session/8a8b8875-8967-43d1-bb4b-78d565c0abb0/verification.json`이다. 200→240 m² 수정, 동일 요청 재전송, 같은 ID의 다른 코드 거절, 오래된 revision 거절, 컴파일/실행 오류 시 기준 유지, 같은 revision의 병렬 요청 중 정확히 1건 성공을 확인했다. 응답 소켓을 끊은 실행은 디스크 영수증으로 성공을 확인하고 같은 요청을 재전송해 중복 수정 없이 revision 3·360 m²를 유지했다. 다른 실행본은 revision 0·200 m²로 남았고 원본 해시가 유지됐다. 생성된 DWG는 초기본과 성공한 3건뿐이다.

읽기 전용 채널 회귀도 `.vide/zwcad-channel/258aea73-6f78-4ce6-9cf6-ed04e86be399`에서 통과했다. 시험 실행본은 모두 종료했다. 현재 영수증 조회는 실행 중 세션에 한정되고 프로세스 재시작 후 복원, 보호 객체/관계 보존, 일반 기하 표시 자료, 제품 AI/브라우저 연결은 후속 구현이다. 고정 합성 시작본과 이 실험의 수량 확인만으로 일반 DWG 편집 지원을 선언하지 않는다.

## 실제 구독 AI → ZWCAD SDK

`agent.mjs <claude-cli|codex-cli>`는 기존 로컬 제어 서버의 실행별 MCP 도구(query/execute)를 발급하고, 위 인증 TCP 채널로 합성 작업 사본에만 코드를 보낸다. API 키·원격 배포 없이 설치된 공식 구독 CLI 경로를 사용했다. 20×10 m 경계를 26×10 m로 바꾸는 작은 과업이며 SDK 진입점과 좌표를 제공한다. AI의 일반 실무 API 탐색 능력·제품 채팅 연결을 검증한 것은 아니다.

| 공급자 | 결과·호출 | 시작부터 검증까지 | 공급자 보고 usage | `.vide/zwcad-agent/` 아래 증거 |
|---|---|---|---|---|
| Codex | 조회 2·실행 1, 260 m²·72 m·Handle 44·색 3, 원본 해시 보존 | 36.564초 | input 51,418 / output 547 | `d96f9ba9-c716-4748-82ae-558821cd8280` |
| Claude 재검증 | 조회 2·실행 1, 같은 치수·속성·원본 보존 | 23.207초 | input 8 / output 697 | `9fe595a5-5fed-472d-8096-0dfce2db070c` |

Claude 첫 시도 `55334283-0269-4229-873f-b333738df88a`는 조회 2·실행 1·저장 성공이었으나 면적 200 m²·길이 60 m로 남아 시험 실패였다(34.451초). 당시 코드 본문/응답을 보존하지 않아 무변경의 정확한 원인을 확정할 수 없다. 진단 보존을 추가하고 별도 합성 사본에서 한 번 재검증한 위 결과가 통과했다. 고쳐진 생성 코드의 내용은 기록했지만 최초 실패를 해결한 제품 수정이라고 주장하지 않는다. 실행 성공과 사용자 목표 달성을 별도로 확인해야 한다는 증거다.

각 실행은 최대 150초·도구 7회·코드 교정 2회로 제한했고 불명확 쓰기는 재시도하지 않았다. 생성 코드와 마지막 실제 조회·영수증, AI 응답을 해당 시험 디렉터리에 저장한다. 시험 실행본과 로컬 시험 서버는 종료했다. usage는 캐시/구독 크레딧 차감량을 뜻하지 않으며 공급자 비용 비교에 사용하지 않는다. `subscriptionRemaining`은 둘 다 null이었다. 제품 경로는 여전히 COM이며 브라우저 입력→SDK 결과 표시·이전 사본 연결·원본 적용은 미완료다.
