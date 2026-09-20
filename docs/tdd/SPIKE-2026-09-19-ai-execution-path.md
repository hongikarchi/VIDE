---
id: SPIKE-2026-09-19-ai-execution-path
title: 구독형 CLI 연결과 실행 통제 실험
status: review
version: 0.3
updated: 2026-09-19
owner: agent:codex
related: [FR-08, FR-11, FR-15, FR-18, PLAN, ADR-005]
---

# 구독형 CLI 연결과 실행 통제 실험

## 질문·환경

사용자는 제품의 AI 실행 경로를 구독형 CLI/에이전트부터 검토하도록 지시했다. 설치된 Claude Code 2.1.276의 구독 로그인으로 호출하면서 호스트 쓰기 권한, 전송 자료, 중단을 VIDE가 통제할 수 있는지 확인한다. Node 24.15.0, Windows, 합성 입력만 사용한다.

## 방법·종료 조건

코드: `tools/spikes/2026-09-19-ai-execution-path/probe.mjs`. `node tools/spikes/2026-09-19-ai-execution-path/probe.mjs --auth-only`로 로그인 방식만 확인하고, 같은 명령에서 마지막 옵션을 빼면 최대 45초의 합성 응답을 요청한다. 인증 출력은 로그인 여부·방식·구독 종류만 허용 목록으로 출력한다. 키·이메일·원시 로그는 기록하지 않는다.

CLI를 별도의 임시 작업 폴더에서 셸 없이 실행한다. `--safe-mode`, 빈 도구 목록, 빈 strict MCP 설정, 세션 저장 끄기를 사용한다. API 자격 증명 및 공급자 전환 환경 변수를 자식 프로세스에서 제외한다. 성공 조건은 `VIDE_OK`, 도구 호출 0건, 정상 종료다. 성공하더라도 실호스트 쓰기·재개·전송 제외 검증을 대체하지 않는다.

## 확인한 근거

- 설치 CLI의 `--help`에서 `--safe-mode`는 사용자 정의 설정을 비활성화하면서 인증을 유지하고, `--tools ""`는 내장 도구를 제거함을 확인했다.
- `--bare`는 구독 OAuth를 읽지 않으므로 이번 후보에서 제외한다. [공식 프로그램 호출 문서](https://code.claude.com/docs/en/headless).
- 개인 구독은 claude.ai 로그인 경로를 사용한다. [공식 인증 문서](https://code.claude.com/docs/en/authentication).

## 결과·한계

구독 인증 방식 `claude.ai`와 로그인 유효 상태를 확인했다. 제한된 실행 환경에서는 응답 없이 45초 후 시간 초과됐고 프로세스 트리 종료 명령도 실패했다. 같은 합성 시험을 허용된 확장 권한으로 실행했을 때 2,991ms에 정상 종료했고 `VIDE_OK`를 받았다. 초기화 정보의 도구는 빈 목록, MCP 서버는 0개, 실제 도구 호출은 0건이었다. 해당 응답의 입력 토큰 503·출력 토큰 9는 구독 잔량이나 전체 과금량의 추정치가 아니다.

따라서 구독 로그인으로 제한된 자료를 전달해 응답을 받는 경로는 실증했다. 호스트 권한 거절, 전송 제외, 실제 중단·재개, 장시간 호출, 한도 초과는 아직 통과 처리하지 않는다. 제한 환경의 종료 실패는 제품에서 종료 요청과 종료 확인을 구분해야 하는 근거다. 해당 시험 PID만 대상으로 정리를 시도했고, 최종 확인에서는 이미 종료되어 존재하지 않았다.

CLI 통합 가능성과 제한 배포 시 이용 조건은 별개이며, 구독 자격 증명을 VIDE가 추출하거나 다른 사용자에게 재사용하는 방식은 설계하지 않는다. 모델 이름은 계정 기본 선택을 따랐고 특정 별칭의 지속 사용을 보장하지 않는다.

## ChatGPT 구독·Codex 실험

사용자의 추가 지시에 따라 설치 Codex CLI 0.154.0-alpha.6.2를 확인했다. 제한된 셸에서는 미로그인으로 나왔으나 사용자 인증 저장소에 접근 가능한 실행 환경의 공식 `codex login status`에서는 ChatGPT 로그인으로 확인됐다. 인증 파일이나 토큰을 직접 읽지 않았다.

코드는 `src/ai/codex-cli.mjs`, 재현 명령은 `VIDE_CODEX_PATH`에 설치 실행 파일을 지정한 뒤 `node tools/spikes/2026-09-19-ai-execution-path/codex-probe.mjs`다. 합성 JSON만 stdin으로 보냈고 약 4초의 시험 프로세스 실행에서 정상 최종 응답 `VIDE_OK`를 확인했다. 보고된 입력 토큰은 8,248, 출력 토큰은 7이며 구독 잔량을 의미하지 않는다. 모델의 도구 호출 이벤트는 관측되지 않았다.

초기 시도에서 새 CLI의 `item.completed` / `error` 항목을 알 수 없는 도구로 분류해 중단했다. 이벤트 종류만 추적해 비치명적 오류 항목과 도구 호출을 구분하도록 고쳤다. 정상 응답 시험에서도 경고 2건이 있었고 원문은 공개 로그에 출력하지 않았다. 경고의 상세 원인과 배포 환경 호환성은 추가 확인 대상이다.

`--cancel` 시험은 starting→running→stopping→stopped→CANCELLED로 종료했다. 실제 제품 어댑터와 동일한 경로를 사용했다. 합성 입력이므로 호스트 쓰기·장시간 실행·관리자 설정 조합·전체 도구 격리·실제 한도 초과의 검증을 대신하지 않는다. 현재 설치본은 alpha 버전이므로 배포 지원 버전 선정은 별도다.

공식 근거: [ChatGPT 구독 인증](https://learn.chatgpt.com/docs/auth), [비대화형 실행·JSON 이벤트](https://learn.chatgpt.com/docs/non-interactive-mode), [셸 도구·앱·개인 문서 설정](https://learn.chatgpt.com/docs/config-file/config-reference).
