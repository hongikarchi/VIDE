---
id: SPIKE-2026-09-22-zwcad-sdk
title: 설치된 ZWCAD 2023 SDK 빌드·작업 사본 실험
status: review
version: 0.4
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
