---
id: SPIKE-2026-09-22-zwcad-sdk
title: 설치된 ZWCAD 2023 SDK 빌드·작업 사본 실험
status: review
version: 0.2
updated: 2026-09-22
owner: agent:codex
related: [T-003, T-006, T-011, H-ZWCAD-04, H-ZWCAD-05]
---

# 질문과 종료 조건

설치된 ZWCAD 2023의 공식 .NET DLL로 자체 애드인을 빌드하고 활성 사용자 문서 대신 별도 Database에서 합성 DWG를 생성·저장·재열기할 수 있는지 확인한다. 이후에만 일반 AI 코드 실행 래퍼와 소유 실행본 연결을 이식한다. 종료 조건은 빌드, 명시적으로 소유한 시험 실행본의 로드, 20×10 m 경계의 면적 200 m²·길이 60 m·Handle/색/단위 보존이다. 컴파일 성공만으로 런타임 호환·제품 지원을 선언하지 않는다.

코드는 `tools/spikes/2026-09-22-zwcad-sdk/`, 출력은 `.vide/build/zwcad-sdk-probe/`다. [ZWSOFT 공식 개발 지원](https://www.zwsoft.com/support/zwcad-devdoc)은 COM과 ZRX.NET을 별도 경로로 설명한다. 설치된 `ZwManaged.dll`·`ZwDatabaseMgd.dll`을 직접 참조하며 제3자 NuGet 패키지를 도입하거나 SDK DLL을 재배포하지 않는다.

## 수행 범위

`build.ps1`은 Windows .NET Framework C# 컴파일러로 명시적 참조를 확인한다. `SdkProbe.cs`의 명령은 전용 시험 실행본에 주입한 `VIDE_ZWCAD_PROBE_DIR`가 있을 때만 동작하며 파일을 덮어쓰지 않는다. 별도 Database/Transaction을 사용하고 ActiveDocument를 읽거나 수정하지 않는다. 런타임 시험 전까지 CAD 창을 열거나 NETLOAD를 실행하지 않는다.

## 결과

빌드가 통과했다. 설치 어셈블리는 ZwManaged/ZwDatabaseMgd 23.20.23.20, CLR 이미지 버전은 v4.0.30319다. `.vide/build/zwcad-sdk-probe/build-result.json`에 참조 버전과 출력을 기록했다. 실행은 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File tools/spikes/2026-09-22-zwcad-sdk/build.ps1`이며 시스템 실행 정책을 바꾸지 않는다.

`node tools/spikes/2026-09-22-zwcad-sdk/run.mjs`가 `.vide/zwcad-sdk/657dac6c-1313-4b47-aa56-e3dd3bbb17ab`에서 실제 ZWCAD 2023 로드→별도 Database 생성→DWG 저장→다시 읽기까지 통과했다. 면적 200 m²·길이 60 m·mm 단위·색 3·4개 정점·닫힘과 Handle 44가 보존됐다. `/b` 시작 스크립트에서 .NET 명령을 실행했으며 `ActiveDocument`를 사용하지 않았다. 기존 소유 프로세스 검사 도구로 PID/시작 시각/실행 경로를 확인한 별도 실행본만 생성·종료했다. 시스템 마우스와 기존 사용자 문서를 조작하지 않았다.

이 결과는 로컬 공식 SDK의 빌드·로드·Database/Transaction·저장/재열기 호환성 증거다. 기본 도구 재편집, 여러 ZWCAD 실행본의 문서 대상 식별·인증 채널, AI 범용 코드 컴파일/실행과 제품 어댑터 연결은 미검증이다. 이 실험은 기존 COM 제품 경로를 바꾸지 않는다.
