---
id: VERIFY-2026-09-28-rhino-attached-sync
title: 현재 Rhino 문서 연결·수정 위임·Live Sync 검증
status: review
version: 0.4
updated: 2026-09-28
owner: agent:codex
related: [SPEC-01, SPEC-02, PLAN-02, H-RHINO-03, H-RHINO-05, AC-17, AC-38]
---

# 현재 Rhino 연결 검증

기준은 SPEC-01.9·SPEC-02.16과 PLAN-02 현재 연결 작업이다. 현재 설치 Rhino 8.34에서 별도 소유 시험 프로세스의 합성 문서를 사용했다. 사용자 작업 문서는 모델 수정 시험에 사용하지 않았다.

| 검증 | 실제 결과 |
|---|---|
| 기존 문서 연결 | mm 문서의 Modified·단위·네이티브 ID 유지, 읽기 연결 시 vide-id 미삽입 |
| 권한·라우팅 | 잘못된 토큰/문서, 생성 코드 실행 메서드 거절 |
| 수정 위임 | 2×3×4 m 박스를 작업 사본 RhinoCommon으로 높이 8 m로 변경, Applications 반영·자동 취득에서 48 m³ 확인 |
| 원본 후속 편집 | 같은 객체 GUID·mm 단위 유지, Rhino Undo로 24 m³ 복귀 |
| Live Sync | 직접 Move 후 세대 증가·취득에서 X=1 m 확인 |
| 충돌·재연결 | 오래된 기준 SOURCE_CHANGED, Disconnect 후 STALE_CONNECTION, 재연결의 새 세션이 옛 대상을 대체하지 않음 |
| 브라우저 | 실제 Chromium 1440×900에서 수동/자동 Sync, 초안 중 자동 취득 보류, 명시적 수정 위임 전송, 연결 해제 시 버튼 비활성 |
| 실패 계약 | 원본 충돌·취소·다른 대상은 적용 0회, 응답 미확인 시 재실행 없음, 반영 성공 후 Sync 실패 구분 |

재현: `node tests/integration/rhino-attached.mjs`, `node tests/integration/browser-attached-sync.mjs`, `node --test tests/server/attached-application.test.mjs`. 실제 원자료는 `.vide/rhino-attached/6d91a06c-2c31-4952-9c1c-7e3d6134c7f2/result.json`, 브라우저 화면은 `.vide/browser-attached/7ee95d83-9770-489d-b571-9d23a3dff8d0/attached-sync.png`에 있다. 임시 원자료·토큰·개인 문서는 커밋하지 않는다. 전체 단위/서버 시험 229건 및 UI/서버 typecheck 통과. 병렬 전체 시험에서 server.test 파일이 한 차례 실패했으나 단독 10건과 재실행 전체 229건은 통과했으며 최초 실패 원인 미확정이다.

## 사용 절차와 남은 검증

Rhino에서 빌드/배포된 VIDE.Worker.rhp를 로드하고 `VIDEConnect`를 실행한다. VIDE에서 열린 호스트 문서 → 문서 조회 → 대상 선택 → Sync. Rhino의 `VIDESync`는 수동 갱신 요청, `VIDELiveSync`는 선택형 자동 갱신 전환, `VIDEDisconnect`는 연결 해제다. 채팅의 `연결 Rhino 수정`은 명시적 Sync 기준 문서만 대상으로 하고, 파일 저장은 Rhino에서 따로 수행한다.

현재 사용자 문서의 읽기/화면 검수는 진행 중이다. 9월 20일 잔류 숨은 Rhino가 MCP 1999를 점유하던 사실을 확인했고 사용자 명시 지시로 그 프로세스만 종료했다. 현재 사용자 Rhino의 형상·파일 저장에는 개입하지 않았다. Rhino 명령칸 자동 입력 도구 실패 후 사용자가 연결 명령을 실행했다. Aside 제품 화면에서 해당 사용자 Rhino 실행본·현재 문서·mm 단위·객체 수 10,713개를 확인했다.

일반 UserData/BIM 관계, 대형 실무 파일 전체 표시, 모든 문서 설정 이벤트, 별도 PC 자동 설치는 미검증이다. 사용자 문서의 실제 채팅 수정은 이번 읽기 검증에 포함하지 않는다. 구독 AI가 이 새 연결 흐름을 끝까지 구동하는 통합 시험은 아직 별도이며, 기존 SDK AI 실행 검증과 이번 Applications 실증을 혼동하지 않는다.


## 중단 후 복구 확인

Fork 후 작업 트리와 서버 상태를 재확인했다. 소유 시험 Rhino는 종료되어 있었고 사용 중인 Rhino 하나와 VIDE 서버만 유지됐다. 잔류 1999 포트는 해제됐다. 타입 검사, 전체 229건, 기존 React 패널 회귀와 새 연결 브라우저 회귀를 다시 통과했다. MD/HTML 재생성 및 변경 파일 포맷을 완료했다. 초안 복원이나 다른 문서로 기준 변경 시 원본 수정 위임을 자동 계승하지 않도록 보완했다.

화면 도구를 초기화한 후에도 `window crop is outside captured monitor` 오류가 재현되어 현재 Rhino의 UI 입력을 자동 수행하지 않았다. 최근 3시간 Windows Application 로그에서 Codex/ChatGPT 충돌·응답 없음 기록은 발견되지 않았다. 이는 Codex 자체 문제가 없다는 증명이 아니며 정확한 중단 원인은 미확정이다. Aside의 접근 허용 폴더 차이 및 재시작 전 브라우저 인증 만료도 이전 도구 실패 원인이었다. 프로젝트·계정 설정 초기화나 사용자 Rhino 종료는 하지 않았다.


## 실제 사용자 문서의 제품 경로

1. 사용자 직접 연결 후 기존 Rhino 실행본이 VIDE 문서 목록에 표시됐다. 최초 Sync는 captureModel 내부의 구형 `pid:startTicks` 검사식 때문에 거절됐다. 공통 hostTargetSchema로 통일하고 세션 UUID를 포함한 대상 유지 시험을 추가했다. 네이티브 직접 호출과 모의 브라우저 API만으로 이 통합 누락을 놓친 것이므로 기존 합성 통과를 제품 전체 통과로 취급하지 않는다.
2. 수정한 서버에서 다시 Sync한 결과 `IMPORT_LIMIT`을 확인했다. 현재 문서는 UI 조회 10,713개·약 386 MB이며 기존 WorkerScene의 10,000개 상한을 넘는다. 연결은 정상, 전체 모델 취득/뷰포트 표시는 미완료다. 파일/형상을 줄이거나 저장·편집하지 않았다.
3. 실제 환경의 다음 작업은 PLAN-02의 대형 문서 Sync 경로다. 이 상한을 이유로 원본을 분할하거나 단순히 숫자를 올려 지원 완료로 선언하지 않는다. 현재 사용자 Rhino 연결은 유지한다.

## 블록 보존 회귀

별도 빌드 `.vide/build/rhino-worker-next/bin/VIDE.Worker.rhp`를 합성 Rhino에만 로드했다. `.vide/rhino-attached/39452021-afd0-42bc-8f20-cb462f40be14/result.json`에서 기존 적용/Undo/재연결 회귀와 블록 포함 네이티브 캡처, 정의만 변경했을 때 지문·Live Sync 세대 변경, 저장본의 정의 형상 삭제 시 재검증 거절을 통과했다. 사용자 Rhino가 이미 로드한 플러그인은 교체하지 않았다. 객체 수/표시 상한은 유지하며 실제 10,713개 문서의 전체 Sync는 여전히 미완료다.
