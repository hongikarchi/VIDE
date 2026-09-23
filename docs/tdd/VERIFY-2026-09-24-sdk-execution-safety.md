---
id: VERIFY-2026-09-24-sdk-execution-safety
title: SDK 실행 정책과 불명확 오류 검증
status: review
version: 0.1
updated: 2026-09-24
owner: agent:codex
related: [PLAN-02, SPEC-02, T-003, T-004, T-018, AC-17, AC-24]
---

# SDK 실행 정책과 불명확 오류 검증

기준: PLAN-02 §6.1의 2단계, SPEC-02.1·3·4, ARCH-01의 생성 코드 검사/진단 계약. 전체 실무 수용이나 두 호스트 기능 완료의 증거가 아니다.

- Rhino 8 설치본과 자체 작업 플러그인으로 `tests/integration/worker-policy.mjs` 실행. 합성 전용 실행본을 직접 기동하고 시험 후 종료했다. 기존 사용자 실행본은 사용하지 않았다.
- 파일 쓰기/읽기, 프로세스, 네트워크, 환경 변수, GetType/typeof, dynamic, Rhino 명령 실행, ActiveDoc, 직접 저장, 본문 밖 선언 등 **12개 코드 거절**. 매 거절 뒤 객체 수 0과 미생성 파일을 확인했다.
- 잘못된 C#은 COMPILE_ERROR. 일반 SDK 생성과 작은 반환값은 성공했고 실제 2×3×4 m Box의 체적 24 m³를 재취득했다. 위험 API 이름이 들어 있는 일반 문자열은 허용했다.
- 객체를 만든 뒤 의도적 예외를 발생시켜 실제 원문 진단 파일을 확인했다. 결과는 HOST_RESULT_UNKNOWN으로 유지하고 동일 operationId 재전송은 동일 영수증을 반환했다. 새 쓰기는 거절하고 객체 수가 늘지 않았다.
- 제어기 자동 시험 7/7: 정책 거절은 수정 가능, 실행 후 오류는 진단 ID를 최종 intent까지 보존하고 재실행하지 않음. 기존 SDK 불명확·보존·캐시 시험도 통과했다.
- 최초 제한 환경의 실행은 WORKER_START_TIMEOUT으로 끝났다. 정상 실행 환경에서는 Rhino의 CommonComponentTable.Count가 FileIO 내부 타입에 속해 과잉 거절되는 문제가 드러났다. 해당 표의 읽기 멤버만 구분하여 수정한 뒤 전체 실제 시험이 통과했다.
- 통과 산출물 위치: `.vide/worker-policy/6593cd30-1081-42e7-8129-5fabef501595`. 개인 진단 원문과 네이티브 파일은 저장소에 포함하지 않는다.

한계: 이 심볼 검사는 OS 샌드박스가 아니며 모든 SDK의 간접 부작용을 차단한다는 보증이 아니다. 기존 Rhino 작업의 전체 회귀, ZWCAD의 별도 런타임 정책, 실제 구독 경로의 후속 검증은 다음 작업이다. 논현동 대표 과업은 사용자 지시대로 추후 결정한다.
