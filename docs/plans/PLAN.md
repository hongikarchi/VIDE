---
id: PLAN
title: VIDE 실행 로드맵
status: review
version: 0.237
updated: 2026-10-02
owner: agent:codex
related: [ARCH-01, PLAN-02, PLAN-03, PLAN-22, PLAN-23, PLAN-24, PLAN-25, PLAN-26, PLAN-27, ADR-022, ADR-025, ADR-026, ADR-027, SPEC-00, SPEC-01, SPEC-02, SPEC-03, SPEC-04, SPEC-05, SPEC-06, SPEC-07]
---

# VIDE 실행 로드맵

이 문서는 실행 순서·작업 연결·현재 상태·전체 완료 기준의 정본이다. 새 작업은 기존 표와 상태를 갱신한다. 기술 설계·조사 원문·완료 일지는 덧붙이지 않는다. 문서 번호는 식별자이며 순서나 우선순위가 아니다.

## 1. 문서 지도와 읽는 순서

| 필요한 판단 | 정본 |
|---|---|
| 제품 목표·범위 | [PRD](../PRD.md) |
| 기능 동작·상태·권한 | [SPEC 색인](../specs/README.md) |
| 화면 표현 | [Design](../../Design.md) |
| 구조·스택·저장/API·호스트·공유 계약 | [ARCH-01](../architecture/ARCH-01-system.md) |
| jig 실행·구조 모델 계약 | [ARCH-03](../architecture/ARCH-03-jig-runtime.md), [ARCH-02](../architecture/ARCH-02-structure-model.md) |
| 참고 사례와 대안 조사 | [RESEARCH-01](../research/RESEARCH-01-reference.md) 등 docs/research |
| 채택 이유·실제 검증 | [ADR 목록](../../index.html), docs/tdd의 SPIKE·VERIFY |

작업 계획(번호는 식별자이며 순서가 아니다):

| 계획 | 다루는 일 |
|---|---|
| [PLAN-02](PLAN-02-agent-host-versioning.md) | AI·호스트·모델 기록·공유 실행 (T-001~018 상세) |
| [PLAN-03](PLAN-03-development-foundation.md) | 개발 기반·진단 로그 (T-019~024, T-032, T-040) |
| [PLAN-04](PLAN-04-workspace-ui.md) | 선택된 UI 수정 |
| [PLAN-05](PLAN-05-decision-layer-evaluation.md) | 판정 계층(Jev) 평가 |
| [PLAN-06](PLAN-06-cli-account-profiles.md) | CLI 계정 프로필 — [ADR-025](../decisions/ADR-025-accounts-in-accountswitch.md)로 대체 |
| [PLAN-07](PLAN-07-zwcad-attached-sync.md) | 현재 ZWCAD 도면 연결과 패널 |
| [PLAN-08](PLAN-08-project-knowledge.md) | 프로젝트 지식 DB 단계 계획(draft, T-025~031 예약) |
| [PLAN-09](PLAN-09-remote-host.md) | 원격 기기에서 작업 PC 열기 |
| [PLAN-10](PLAN-10-account-workspace.md) | 계정 웹사이트 |
| [PLAN-11](PLAN-11-desktop-app.md) | PC 프로그램(설치본·창·트레이·업데이트·연결 프로그램) |
| [PLAN-12](PLAN-12-field-fixes.md) | 실사용 오류·외부 접속·스케치·설정 정리 |
| [PLAN-13](PLAN-13-multi-account.md) | 다중 AI 계정 — [ADR-025](../decisions/ADR-025-accounts-in-accountswitch.md)로 대체 |
| [PLAN-14](PLAN-14-jig-tab.md) | JIG 탭과 Sync jig |
| [PLAN-15](PLAN-15-work-view.md) | 작업 이력과 작업 보기 |
| [PLAN-16](PLAN-16-document-links.md) | 연결 파일(Link)·여러 파일 한 공간·선택 반영과 고정 |
| [PLAN-17](PLAN-17-structure-jig.md) | 구조 분석 jig 1단계 (T-033~039) |
| [PLAN-18](PLAN-18-render-performance.md) | 큰 모델 표시·Sync 성능 |
| [PLAN-19](PLAN-19-request-routing.md) | 요청 경로와 함께 보낼 이전 대화 |
| [PLAN-20](PLAN-20-offline-view.md) | PC가 꺼져 있을 때의 모델 보기·요청 대기 |
| [PLAN-21](PLAN-21-host-panel.md) | 호스트 패널 화면과 사용량 막대 |
| [PLAN-22](PLAN-22-jig-platform.md) | jig 플랫폼 1차 |
| [PLAN-23](PLAN-23-s06-frame-jig.md) | S-06 골조 jig와 구조 라이브러리 1차 |
| [PLAN-24](PLAN-24-ai-conversations.md) | AI 대화·경로 판정, 바로 적용·계획/자동 모드 |
| [PLAN-25](PLAN-25-accounts-to-accountswitch.md) | 계정 관리를 AccountSwitch로 (T-068) |
| [PLAN-26](PLAN-26-chat-stage.md) | 대화 중심 구조·셸 정리·산출물 탭 (T-076~081) |
| [PLAN-27](PLAN-27-sync-storage-stability.md) | Sync 저장 구조와 작동 안정성 (T-082~087) |

새 세션은 §6.5 → 해당 작업 PLAN → 관련 SPEC·ARCH·Design 순서로 읽는다. 동작 의미는 SPEC, 기술 계약은 ARCH, 순서는 PLAN이 소유하므로 충돌은 해당 정본에서 고친다. 과거 PLAN-01은 조사 문서로 이전됐으며 실행 지시가 아니다.

## 2. 기술 구조 참조

책임·의존 방향·프런트 상태 소유는 [ARCH-01 공통 설계 2](../architecture/ARCH-01-system.md#master-2)를 따른다.

## 3. 기술 기준과 전환 참조

확정 스택과 상시 개발 기준은 [ARCH-01 공통 설계 3.4](../architecture/ARCH-01-system.md#master-3-4), 전환 이력은 [기록](../tdd/VERIFY-2026-09-20-implementation-history.md)에 있다. 기존 PLAN §3.3·3.4 참조는 이 위치로 이어진다. 완료된 전환을 새 작업으로 재개하지 않는다.

## 4. 저장·API 계약 참조

기존 §4.1~4.4의 공통 설계는 [ARCH-01](../architecture/ARCH-01-system.md#master-4), 모델 기록의 상세는 [ARCH-01 §5](../architecture/ARCH-01-system.md#detail-4)에 있다.

## 5. AI·호스트 연결 참조

기존 §5.1~5.3의 공통 연결 설계는 [ARCH-01](../architecture/ARCH-01-system.md#master-5), 범용 실행의 상세 계약은 같은 문서 §2~4를 따른다. 실행 작업은 PLAN-02에 있다.

## 6. 단계와 티켓

### 6.1 실행 순서

| 단계 | 작업 | 다음 단계로 넘어갈 조건 |
|---|---|---|
| 준비 | PLAN-03 개발 기반 T-019~024 | Git 보호·자동 검사·포맷·DB 이행·의존 경계 검증. 필요한 환경의 미시험은 명시 |
| 제품 안정성 | T-003·004·018 오류 진단·실행 방어 | 실패 원인 보존·불명확 쓰기 재전송 방지·정상 SDK 회귀 |
| 호스트 기능 | T-005·006·018 | ZWCAD 범용 채팅/생성/열기, 기존 문서 적용·편집·저장 왕복 |
| 복수 문서·데이터 | T-001·003·006·007·013 | 문서 대상·관계·부분 실패·버전/캐시 검증 |
| 공유 | T-009·017 | 무료 시험 조건 내 실제 게시·의견·로컬 채택 왕복 |
| 제품 수용 | T-010·011·012 및 §6.6 | 대표 실무 과업·기준선·실기기·별도 PC 검수 |

**VIDE 재구성 1차(2026-09-29 등록).** jig 플랫폼([PLAN-22](PLAN-22-jig-platform.md)), S-06 골조 jig와 구조 라이브러리([PLAN-23](PLAN-23-s06-frame-jig.md)), AI 대화·경로([PLAN-24](PLAN-24-ai-conversations.md))를 마일스톤 순서로 진행한다. 마일스톤은 S-06 결과를 먼저 보이는 순서이며, 선행이 갖춰진 티켓(특히 PLAN-24)은 먼저 해도 된다.

| 마일스톤 | 티켓 | 다음 단계로 넘어갈 조건 |
|---|---|---|
| M0 진단 | T-041·042·043 → T-044 | S-06 사본에서 기존 간이 검사 기준선 재현 + 기둥 위에서 끊은 경간 표(VERIFY) |
| M1 입력 조립·축선·기둥·간섭 | T-045 → T-046 → T-047·048, T-049, T-050 → T-051 | 형식 v3 작업본에서 ⓪~④ 계산, `jig:validate`·`jig:test` 통과, 실데이터 M1 기록 |
| M2 거더·작은보·해석 | T-052 → T-053 | 참고 처짐·Lb·K 시험, 미확정 미리보기와 [해석 확정] 구분, M2 기록 |
| M3 단면·일람표·Rhino에 만들기 | T-054, T-055 → T-056 | 두 번 만들기 중복 없음·사람 수정 보존·[되돌리기], 일람표 CSV |
| M4 보고서 | T-057 → T-058 | 보고서 게이트 통과, 미검토 항목 인쇄 |
| M5 대화·채팅으로 jig 만들기 | T-059·060 → T-061 → T-062 → T-063 → T-064 | 대화 3개 동시 진행, S-06 보조 jig를 대화로 만들어 ③ 결과와 일치 |
| 독립 | T-065(자료 1차), T-066(공유 스냅샷 결함) | 각 계획의 완료 기준 |
| 2차 | T-067(구조 코어 확장) | 2차 착수 지시 뒤 |
| 독립 | T-068(계정 관리를 AccountSwitch로, [PLAN-25](PLAN-25-accounts-to-accountswitch.md)) | 정본 반영·코드 제거 뒤 계정 API 404·읽기 전용 카드 확인 |
| 안정성 | T-082~T-087(Sync 저장 구조와 작동 안정성, [PLAN-27](PLAN-27-sync-storage-stability.md), 근거 [RESEARCH-13](../research/RESEARCH-13-stability-audit.md)) | 0단계(진단·복구) 바로 착수. 1단계는 ARCH-01 저장 계약 확인 뒤 |
| 바로 적용 | T-069 → T-070·071 → T-072 → T-073·074, T-075([PLAN-24](PLAN-24-ai-conversations.md#direct-apply), [ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md)) | 실제 Rhino·ZWCAD에서 보호·되돌리기 확인, 브라우저 시험 |
| 여러 파일 조율 | T-092 → T-093 → T-094([PLAN-24](PLAN-24-ai-conversations.md#multi-file), [ADR-027](../decisions/ADR-027-multi-file-coordination.md)) | 모의 연결 두 개의 서버·브라우저 시험, 실제 Rhino 두 창 확인 |
| 대화 중심 구조 | T-076·077 → T-078 → T-079, T-080, T-081, T-098(대시보드 할 일), T-099 → T-100 → T-101([PLAN-26](PLAN-26-chat-stage.md), [ADR-026](../decisions/ADR-026-chat-stage-and-skill-jigs.md)) | 각 티켓의 시험 통과. 화면 변경은 지금 배치 위에 하나씩 |

호스트 플러그인을 바꾸는 티켓의 완료 기준은 개발 빌드와 `.vide/` 합성 문서·사본까지이며, 설치본 반영은 사용자 요청이나 웨이브 경계의 판단으로 묶음 릴리스한다.

대표 과업은 기능 개발 초기에 선정하고 각 단계에서 반복 검증한다. 공유의 외부 제약으로 독립 로컬 작업을 중단하지 않는다. 후속 Jev 조사는 §9.4 조건을 따른다.

### 6.2 티켓 소유와 상세 계획

T-001~018의 번호·지원 증거는 유지한다. 각 티켓의 현재 결과와 남은 조건은 §6.5, 상세 구현·시험 절차는 PLAN-02와 §7을 따른다. T-019~024·T-032·T-040(진단 로그)의 구체 작업은 PLAN-03, T-033~039는 PLAN-17이 소유한다. T-041~067은 PLAN-22·23·24가 소유하며, RESEARCH-10 작업 묶음(WP)과의 대응표는 각 계획에 있다. T-068은 PLAN-25, 바로 적용·계획/자동 모드의 T-069~075와 여러 파일 조율의 T-092~094, 새 대화 바로 열기의 T-097은 PLAN-24, 대화 중심 구조·산출물 탭의 T-076~081과 첨부·참고 이미지 의도 확인·프로젝트 폴더의 T-089~091, 대시보드 할 일의 T-098, JIG 한 화면·아이콘·[수정하기]의 T-099~101과 대상 파일 칩 폐지의 T-103은 PLAN-26, Sync 저장 구조와 작동 안정성의 T-082~087은 PLAN-27, 연결 파일 보완 T-095·096은 PLAN-16이 소유한다. T-025~031은 PLAN-08의 예약 번호이며 아직 등록하지 않았다. 하위 계획에 별도 현황표를 복제하지 않는다.

### 6.3 착수 조건

가이드 §05의 해당 티켓 계약·출력·증거·환경 조건을 확인한다. 2026-09-24 사용자 지시로 개발 기반 구현에 착수했다. 예전 첫 목업 승인 순서를 새 관문으로 적용하지 않는다.

### 6.4 기존 구현 이행

현재 소스와 §6.5의 증거에서 이어간다. 과거 구현 일지는 [이행 기록](../tdd/VERIFY-2026-09-20-implementation-history.md)으로 옮겼다. 과거의 제한 JSON·MCP·ESM 설명을 현재 설계로 사용하지 않는다.

### 6.5 현재 티켓 현황과 이어갈 위치

이 절은 티켓마다 현재 상태·남은 조건·증거만 둔다. 지난 진행 기록은 각 작업 PLAN의 현황, VERIFY·SPIKE, Git 이력에 있다. 최신 설치본 릴리스는 v0.2.12(`792e31d`)이고 그 뒤 커밋은 설치 전이다. 설치본 반영(플러그인 재빌드 포함)은 사용자 요청이나 웨이브 경계의 판단으로 묶어 한다.

**지금 진행 중**

- T-068([PLAN-25](PLAN-25-accounts-to-accountswitch.md)): VIDE 안의 계정 관리·전환을 빼고 기본 로그인만 쓴다. 정본 반영(1단계)과 코드 제거(2단계)가 진행 중이다.
- T-083~087([PLAN-27](PLAN-27-sync-storage-stability.md)): T-082(0단계) 뒤 1단계 객체 단위 저장. ARCH-01 저장 계약을 먼저 쓰고 사용자 확인을 받는다. 5단계의 사본·작업 폴더 정리와 2단계의 문서별 Sync 합치기, 읽기 전용 감지 기록은 앞당겨 구현했다(`fda1e5d`, 설치본 확인 남음).
- T-071: ZWCAD 바로 실행의 실호스트 재실행(0.2.11 이상 연결 플러그인).

**작업 계획별 현황(T 번호가 없는 계획)**

| 계획 | 현재 | 남은 것·다음 | 증거 |
|---|---|---|---|
| [PLAN-02](PLAN-02-agent-host-versioning.md) AI·호스트·모델 기록·공유 | §6.1의 1·2·3a·3b·4a를 합성 지원 범위로 검증. 기존 Rhino 창 연결·읽기 Sync·선택형 Live Sync | 4b 원격 모델 검수(R2 무료 조건 대기), 대표 실무 과업 검수(사용자 결정 뒤) | [로컬 완결](../tdd/VERIFY-2026-09-24-local-product-completion.md), [Rhino 연결](../tdd/VERIFY-2026-09-28-rhino-attached-sync.md), [Sync 성능](../tdd/VERIFY-2026-09-28-sync-performance.md) |
| [PLAN-04](PLAN-04-workspace-ui.md) 작업 공간 UI | 선택 항목 반영·검수 통과 | — | [VERIFY](../tdd/VERIFY-2026-09-28-workspace-polish.md) |
| [PLAN-05](PLAN-05-decision-layer-evaluation.md) 판정 계층 평가 | 평가 계획. Jev는 모델 자동 선택·요청 경로·이전 대화 고르기에 쓰고 있다([PLAN-19](PLAN-19-request-routing.md)) | 평가 실행 | [로컬 판정 실험](../tdd/SPIKE-2026-09-25-decision-layer.md) |
| [PLAN-06](PLAN-06-cli-account-profiles.md) CLI 계정 프로필 | [ADR-025](../decisions/ADR-025-accounts-in-accountswitch.md)로 대체 | T-068이 이어 받음 | — |
| [PLAN-07](PLAN-07-zwcad-attached-sync.md) ZWCAD 연결 | 연결 플러그인·패널·읽기 Sync·Live Sync. 실제 기본도면은 부분 표시(3,841개 중 3,369개) | 대형 외부참조·문자/해치 표시 보완. AI 편집은 T-071 | [VERIFY](../tdd/VERIFY-2026-09-28-zwcad-attached-sync.md) |
| [PLAN-08](PLAN-08-project-knowledge.md) 프로젝트 지식 | 초안(draft). 1차 제품 작업은 T-065·T-062로 진행 | 예약 번호 T-025~031은 등록하지 않았다. 남은 단계와 저장 구조([ADR-018](../decisions/ADR-018-project-knowledge-store.md) 초안)는 사용자 결정 대기 | PLAN-08 |
| [PLAN-09](PLAN-09-remote-host.md) 원격 기기 | 임시 터널로 작업 PC 열기, 에뮬레이션 iPad·staging 확인 | 실제 iPad·실제 Rhino 원격 AI 수정 왕복, 상시 터널·도메인 결정 | [VERIFY](../tdd/VERIFY-2026-09-28-remote-loop.md) |
| [PLAN-10](PLAN-10-account-workspace.md) 계정 웹사이트 | ID 로그인·프로젝트 목록·작업 PC 열기. 사이트에서 지운 프로젝트는 PC에서도 지운다([SPEC-01.1](../specs/SPEC-01-project-input-sync.md)) | 비밀번호 변경·복구, 계정 삭제 | PLAN-10, `tests/server/project-delete.test.mjs` |
| [PLAN-11](PLAN-11-desktop-app.md) PC 프로그램 | 설치본(Velopack)·자체 창·트레이·자동 업데이트·연결 프로그램, GitHub Releases 게시 | 코드 서명(외부 배포 전 결정) | [VERIFY](../tdd/VERIFY-2026-09-28-desktop-app.md) |
| [PLAN-12](PLAN-12-field-fixes.md) 실사용 오류 | 요청 실패 수정, iPad 고정 주소, 스케치·설정 정리 | 실제 ZWCAD 창의 되돌리기 확인(T-071과 함께) | PLAN-12 |
| [PLAN-13](PLAN-13-multi-account.md) 다중 AI 계정 | [ADR-025](../decisions/ADR-025-accounts-in-accountswitch.md)로 대체. 현재 계정 사용량 읽기만 남는다 | T-068 | — |
| [PLAN-14](PLAN-14-jig-tab.md) JIG 탭·Sync jig | 공식 jig 목록, Sync jig(도면↔모델) | 실제 Rhino·CAD Sync로 실사용 검수, 곡선·블록 짝짓기 | PLAN-14 |
| [PLAN-15](PLAN-15-work-view.md) 작업 보기 | 작업 이력과 선택한 작업의 진행 화면 | 설치본에서 Rhino 요청 진행 화면 확인 | PLAN-15 |
| [PLAN-16](PLAN-16-document-links.md) 연결 파일 | Link·연결 파일 목록·여러 파일 한 공간, 빼기 = 기록 삭제([SPEC-01.11](../specs/SPEC-01-project-input-sync.md)), 문서별 Rhino 선택 반영과 Rhino와 함께 쓰는 고정 목록(`c55cc53`) | 두 파일에 걸친 연계 요청, 큰 건축 파일 '파일에서 열기' 재읽기 실패(미수정), 입력 중 Sync 보류 동안 새 객체 고정(별도 결정) | PLAN-16 |
| [PLAN-18](PLAN-18-render-performance.md) 큰 모델 표시 | 18,000객체 여는 시간 4.5 → 1.84초, 전송 68.5 → 34.9 MB, 호스트 Sync 구간 기록 | 인스턴싱·LOD. 저장·화면 구조는 PLAN-27 | [SPIKE](../tdd/SPIKE-2026-09-29-render-perf.md) |
| [PLAN-19](PLAN-19-request-routing.md) 요청 경로 | 화면만 바꾸는 요청은 VIDE가 처리, 모델 선택 '자동 (Jev)', 이전 대화 고르기 | 잘못 판정한 경우의 기록, 다른 PC의 Jev 중계 | PLAN-19 |
| [PLAN-20](PLAN-20-offline-view.md) PC가 꺼져 있을 때 | 구현·로컬 시험. 스냅샷은 과금 결정 전까지 꺼짐(T-066) | 원격 D1 `0007`·Worker 배포(사용자 확인 뒤), 실제 PC 확인 | PLAN-20 |
| [PLAN-21](PLAN-21-host-panel.md) 호스트 패널 | Rhino 패널·ZWCAD 팔레트를 같은 웹 화면으로, 사용량 막대 | 설치본에서 두 호스트의 연결→Link→Sync→요청 확인 | PLAN-21 |

**제품 티켓 T-001~018**

| 티켓 | 현재 결과 | 남은 완료 조건·다음 행동 | 증거 |
|---|---|---|---|
| T-001 | 로컬 SQLite 저장·대상 큐·중복/불명확 쓰기 보호, TS 전환 | 복수 문서 관계/버전 확대. 저장 구조 개편은 PLAN-27 | TS/자체 호스트 VERIFY, PLAN-02 §3·4 |
| T-002 | 채팅·핀·스케치·파일·초안 복원, 실제 구독 스케치 돌출 | 대표 실무 과업·복잡한 입력·평면 확대 | 네이티브 VERIFY, TS/자체 호스트 VERIFY |
| T-003 | 자체 Rhino worker·소유 실행본 확인·인증 TCP·SDK 실행/재열기, 사용자가 연 Rhino 문서 연결(VIDEConnect) | 복수 문서·일반 호스트 유형 확대 | 에이전트 도구 SPIKE, [Rhino 연결 VERIFY](../tdd/VERIFY-2026-09-28-rhino-attached-sync.md) |
| T-004 | Claude/Codex 실제 구독 도구 호출·SDK 코드·취소·설정 연결 | 모델별 능력/한도·장기 과업·복잡한 개입 | TS/자체 호스트 VERIFY |
| T-005 | 연결된 Rhino 문서에 바로 실행·되돌리기·보호(T-070). 자체 편집 사본의 형상/속성 적용과 GUID 보존은 '검토'·jig 내부 사본 경로로 남음 | 그룹/재질/문서 자원·관계 확대, 대표 과업 | [바로 적용 VERIFY](../tdd/VERIFY-2026-09-30-direct-apply-rhino.md), TS/자체 호스트 VERIFY |
| T-006 | ZWCAD DWG 사본·자체 SDK 생성/수정·저장 재열기, CAD→Rhino 돌출, 연결 도면 바로 실행 코드(T-071) | T-071 실호스트 확인, 일반 객체/단위·자산/관계 복사 | [SDK 제품 VERIFY](../tdd/VERIFY-2026-09-24-zwcad-sdk-product.md), [바로 적용 VERIFY](../tdd/VERIFY-2026-09-30-direct-apply-zwcad.md) |
| T-007 | 수량 필터/그룹·CSV·고정 검토본·A/B 비교·객체 수량표, SDK 미변경 기하의 수량 재사용 | 실무 전문 표·외부 변경 이벤트 캐시 | 네이티브 VERIFY, TS/자체 호스트 VERIFY |
| T-008 | 속성 요약 확장 등록/실행/실패/비활성화·객체 연결 | 추가 확장·장기 작업·배포 수용 | 네이티브 VERIFY |
| T-009 | 무료·메일 없는 소유자 승인 모드로 원격 배포: 가입·로그인·프로젝트·참여 신청/승인·회수 staging 검증. 로컬 런타임의 게시·의견·채택 왕복 | 모델 게시·의견의 원격 완결(R2 업로드 차단 해제 조건 포함), 운영 백업/복구·비용 계측, 메일 인증 모드(발신 도메인·요금제 승인 뒤) | 공유 VERIFY |
| T-010 | shell/Inspector, PLAN-04 선택 UI, 레일·작업공간·산출물 화면(T-079·T-081), 브라우저 회귀 | 사용자 최종 디자인·iPad/펜 실기기 사용성 | [UI VERIFY](../tdd/VERIFY-2026-09-24-workspace-controls.md), `npm run test:browser` |
| T-011 | 설치본(Velopack)·자동 업데이트·연결 프로그램 설치, 제거 후 자료 보존 | 별도 비개발 PC 검수·코드 서명·복구 UI | [PC 프로그램 VERIFY](../tdd/VERIFY-2026-09-28-desktop-app.md) |
| T-012 | 미착수 | 동일 과업의 수작업 및 에이전트+MCP 기준선 비교 | §6.6·§7 |
| T-013 | 작업 요청/상태/결과 저장·HTTP 경계 검사·불명확 실행 회수, TS strict | 실제 관계/버전·호스트 확대 | TS/자체 호스트 VERIFY, PLAN-02 §4 |
| T-014 | 참고 사례 조사, React/TS/Vite 기반 | 현재 스택 유지, 제품 통합 검수 | ADR-016·017, TS/자체 호스트 VERIFY |
| T-015 | 실제 메시/선/점·객체 대응·정투영, 큰 모델 표시 개선(PLAN-18) | 대형 실무 모델·추가 유형·기기 성능 | 뷰포트 SPIKE, 네이티브 VERIFY |
| T-016 | 요청 목록·실행·결과·작업 이력의 실제 API 통합, 대화 세션(T-061) | 전체 출시 수용·실무 사용성 | 네이티브 VERIFY, TS/자체 호스트 VERIFY |
| T-017 | 표/검토본/확장·Inspector 수량표·외부 의견 초안 채택 | 실무 과업·복수 객체 선택·자동 공유 연결 | 네이티브 VERIFY, 공유 VERIFY |
| T-018 | 실제 구독 AI → 조회/SDK 코드 → 연결 Rhino 바로 실행·되돌리기(자동 모드), 계획 모드의 계획 카드 | 복잡한 목표·여러 문서 개입·일반 호스트 과업 | [바로 적용 VERIFY](../tdd/VERIFY-2026-09-30-direct-apply-rhino.md), [A/B SPIKE](../tdd/SPIKE-2026-09-30-ai-parity-ab.md) |

**개발 기반**

| 티켓 | 현재 상태 | 상세 |
|---|---|---|
| T-019 · Git 추적·ignore | 제외·패키징 소스 정책 검증 | [PLAN-03](PLAN-03-development-foundation.md#t-019) |
| T-020 · 비밀정보·배포 보호 | 로컬 스캔·배포 대상 검사 완료; 원격 CI/보호 미검수 | [PLAN-03](PLAN-03-development-foundation.md#t-020) |
| T-021 · 자동 검증 | 통합 명령·커밋 가드·실패 차단 검증 | [PLAN-03](PLAN-03-development-foundation.md#t-021) |
| T-022 · 포맷 | 포맷 별도 커밋·재검사 통과 | [PLAN-03](PLAN-03-development-foundation.md#t-022) |
| T-023 · DB 마이그레이션 | 이행·백업·실패 복구 검증. 현재 스키마 v5(T-045) | [PLAN-03](PLAN-03-development-foundation.md#t-023) |
| T-024 · 호스트 의존 경계 | 중립 경로·공통 literal·예외 점검 완료 | [PLAN-03](PLAN-03-development-foundation.md#t-024) |
| T-032 · Jev 수정 위치 찾기(개발 도구) | `npm run locate` 사용 가능. 정답 파일 5위 안 영어·한국어 100%([SPIKE](../tdd/SPIKE-2026-09-29-jev-locate.md)). 표본 확대·에이전트 비교 남음. 제품 이식은 [PLAN-05 §7](PLAN-05-decision-layer-evaluation.md) 계획만 | [PLAN-03](PLAN-03-development-foundation.md) |
| T-040 · 진단 로그 | 엔진 쪽 완료(`0ba4f1a`): `logs/engine-*.jsonl`(14일), 내부 오류 스택, 작업 시작·끝, 셸의 엔진 오류 출력. 엔진 종료 코드·메모리 기록은 T-082. 남음: Rhino·ZWCAD 플러그인 쪽 오류 로그 | [PLAN-03](PLAN-03-development-foundation.md), `tests/server/diagnostics.test.mjs` |

**구조 분석 jig 1단계([PLAN-17](PLAN-17-structure-jig.md))**

| 티켓 | 현재 | 남은 것·다음 | 증거 |
|---|---|---|---|
| T-033~038 | 1차 완료: 애드온, Rust 코어(선형 해석·기구 탐지·KDS/AISC 검정), 입력(곡선·솔리드·CAD → 초안·점검·확정), JIG 탭 화면 | AISC E·G·H 예제, KDS 조항 대응, 한국 고유 fixture 검토 | `npm run test:structure`, `browser-structure-jig.mjs` |
| T-039 | 설치본에 코어·라이선스 포함 | 실제 Rhino·CAD 입력 검수 | PLAN-17 |

**jig 플랫폼·S-06·AI 대화·대화 중심 구조·안정성(T-041~087)**

| 티켓 | 현재 | 남은 것·다음 | 증거 |
|---|---|---|---|
| T-041 겹침 층·jig 비모달 | 완료 | 겹침의 깊이 검사, 850 px 이하 아래 판 시험 | [PLAN-22](PLAN-22-jig-platform.md#t-041), `browser-jig-overlay.mjs` |
| T-042 geometry-kit 진단 함수 | 완료 | — | [PLAN-23](PLAN-23-s06-frame-jig.md), `tests/core/geometry-kit.test.mjs` |
| T-043 Sync 범위 수·레이어 표·레이어 한정 읽기 | 완료(개발 빌드·실자료 재확인) | 화면 배지 브라우저 회귀, 큰 문서의 조사 비용 측정 | [PLAN-22](PLAN-22-jig-platform.md#t-043), [VERIFY](../tdd/VERIFY-2026-09-29-s06-frame.md) |
| T-044 S-06 M0 진단 | 완료(기준선 9/33/6/19 재현) | 토목 모델을 제품 Sync로 재대조, 임시 진단 경로 제거(T-051) | [VERIFY](../tdd/VERIFY-2026-09-29-s06-frame.md) |
| T-045 저장 스키마 v5 | 완료 | 규모 DB의 시작 시간 측정 | `tests/core/migrations.test.mjs` |
| T-046 jig 형식 v3·작업본·실행기·가져오기 | 완료 | `stale-input`의 현재 판 채우기 | [PLAN-22](PLAN-22-jig-platform.md#t-046), `tests/core/jig-runner.test.mjs` |
| T-047 작업공간 탭 | 완료. 2026-10-01부터 레일이 고정 화면을 맡고 위쪽 줄은 열린 작업본만 보인다(T-079) | — | `browser-workspace-tabs.mjs` |
| T-048 선언형 패널·부품 | 완료 | 수천 개 겹침의 성능 측정, 역할 카드의 AI 제안(T-051) | `tests/core/jig-panel.test.mjs`, `browser-jig-panel.mjs` |
| T-049 경로 판정·값 추출·전송 고지 | 완료(작성기 연결 포함) | — | [PLAN-24](PLAN-24-ai-conversations.md), `tests/core/request-route.test.mjs` |
| T-050 geometry-kit 배치 함수 | 완료 | — | [PLAN-23](PLAN-23-s06-frame-jig.md) |
| T-051 S-06 ⓪~④ | 합성 검증 완료 | 실데이터 ②~④ 검수, AI 역할 제안 연결, 임시 진단 경로 제거 | [VERIFY m1](../tdd/VERIFY-2026-09-30-s06-frame-m1.md) |
| T-052 structure-analysis 1차 | 완료(범용 구조 jig 범례·CSV·인용 검사 포함) | `browser-structure-jig.mjs` 실행 기록 | `tests/server/execution-gates.test.mjs` |
| T-053 ⑤~⑧ 거더·작은보·해석 | 실데이터 해석 `ok`, 개구 둘레 보 | 기둥 13개 세장비 한도 밖(구속 레벨 가정)과 '후보 없음' 묶음은 사용자 판단 | [VERIFY m2](../tdd/VERIFY-2026-09-30-s06-frame-m2.md), [VERIFY m3](../tdd/VERIFY-2026-09-30-s06-frame-m3.md) |
| T-054 단면 선정·부호·일람표 | 완료 | 부호 접두 표는 S-18 표준 확인 전 가정 | [PLAN-23](PLAN-23-s06-frame-jig.md) |
| T-055 Rhino에 만들기 | 완료: 합성·S-06 사본의 실제 Rhino 만들기·재만들기·보존·숨긴 레이어 차단. 연결 Rhino는 바로 적용(T-074) | 설치본 플러그인으로 재확인 | [SPIKE](../tdd/SPIKE-2026-09-30-jig-bake.md) |
| T-056 ⑨~⑫ 단면·일람표·높이·만들기 | 연결·선정 단면 적용·부호 원장 완료. 실제 Rhino에서 상단선 161·부재 127 만들기와 [되돌리기] | 기둥 부재(`member-columns`) 만들기, 부재 재만들기의 사람 수정 보존, `browser-s06-jig.mjs` | [VERIFY m3](../tdd/VERIFY-2026-09-30-s06-frame-m3.md) |
| T-057 보고서 틀·보고서 화면 | 완료. 보고서는 산출물 탭 안에 있다(T-081) | `JigHost.export` | `tests/core/report.test.mjs`, `browser-report.mjs` |
| T-058 S-06 보고서 | 01~05·부록 합성 검증 | 실데이터 보고서 | `tests/core/s06-report.test.mjs` |
| T-059 CLI 판 점검·세션 SPIKE | 완료 | — | [SPIKE](../tdd/SPIKE-2026-09-30-cli-session-resume.md) |
| T-060 동시 접수 규칙 | 완료(AI 턴 상한 3) | 재시작 때 대기 요청 자동 재개, [다시 기준 잡기] 카드 | [PLAN-24](PLAN-24-ai-conversations.md) |
| T-061 대화 스레드·세션 | 서버·화면 완료, Claude·Codex 세션 이어 실행, 길이 기준 설정과 새 세션 제안 | 실제 CLI 5턴 토큰 기록. 계정 한도 인계는 T-068에서 뺀다 | `browser-conversations.mjs`(`792e31d`에서 통과) |
| T-062 대화 도구·질문 카드 | 완료(설치본 도구 연결, 대상이 하나면 `targetRef` 생략). 호스트 모델링 턴(바로 편집·작업 사본·연계, 계획·자동)도 `links_layers`·`sync_sample`·`project_*`를 받는다 | 실제 CLI로 호스트 턴의 도구 호출 확인 | `tests/server/agent-tools-origin.test.mjs`, `tests/server/host-turn-tools.test.mjs` |
| T-063 만들기 최소판 | 서버·화면·Codex 만들기 턴 구현, 단위 검증 | `browser-make.mjs` 실행 기록, 실제 Codex 만들기 턴 | `tests/server/make-routes.test.mjs` |
| T-064 M5 수용 | 서버 경로로 합격 | 만들기 탭 화면으로 같은 흐름 확인 | [VERIFY](../tdd/VERIFY-2026-09-30-jig-authoring-m5.md) |
| T-065 자료 1차·자료 탭 | 구현·단위 검증 | 실제 자료 DB로 화면 확인, `browser-facts.mjs` 실행 기록 | [SPEC-08](../specs/SPEC-08-project-facts.md), `tests/server/facts-routes.test.mjs` |
| T-066 공유 스냅샷 결함 | 완료 | 운영 설정 점검, staging 배포·D1 `0007`(사용자 요청 때) | `tests/sharing/offline.mjs`, `npm run deployment:check` |
| T-067 구조 코어 확장 | 2차 | 2차 착수 지시 뒤 | [PLAN-23](PLAN-23-s06-frame-jig.md) |
| T-068 계정 관리를 AccountSwitch로 | 0단계(AccountSwitch 0.1.2 설치)·1단계 정본 반영·2단계 코드 제거 완료(2026-10-01) | 계정 전환 뒤 세션 이어 쓰기 SPIKE, 3단계 실제 확인, 설치본 릴리스 | [PLAN-25](PLAN-25-accounts-to-accountswitch.md) |
| T-069 바로 적용 문서 기준 | 완료 | — | [ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md) |
| T-070 Rhino 바로 실행·되돌리기·보호 | 완료(실제 Rhino 8, 합성 문서) | 설치본 플러그인으로 재확인 | [VERIFY](../tdd/VERIFY-2026-09-30-direct-apply-rhino.md) |
| T-071 ZWCAD 바로 실행·되돌리기·보호 | 코드 완료, 실호스트 막힘(자동 로드된 0.2.10 연결 플러그인이 개발 빌드를 가림) | 0.2.11 이상 플러그인으로 `.vide/h4/run.mjs` 재실행 | [VERIFY](../tdd/VERIFY-2026-09-30-direct-apply-zwcad.md) |
| T-072 서버 계획/자동 모드·실행 기록 | 완료(단위 시험, 실제 Rhino 왕복) | — | `tests/server/direct-mode.test.mjs`, [VERIFY](../tdd/VERIFY-2026-09-30-direct-apply-rhino.md) |
| T-073 화면: 모드 토글·실행 행·확인·계획 카드 | 완료 | — | `browser-direct-mode.mjs`(`792e31d`에서 통과) |
| T-074 jig 만들기의 바로 적용 | 완료(합성 문서, S-06 사본 상단선·부재) | 기둥 부재 만들기(T-056) | [SPIKE](../tdd/SPIKE-2026-09-30-jig-bake.md), [VERIFY m3](../tdd/VERIFY-2026-09-30-s06-frame-m3.md) |
| T-075 공급자 자체 질문 | SPIKE 합격. Claude·Codex 모두 기본으로 켬(Codex는 2026-10-01 사용자 결정). 설정 → AI 「AI가 작업 도중에 묻기」로 함께 끄고(두 공급자 모두 대화 턴에서 멈췄다 같은 실행으로 이어 감, 2026-10-02), `VIDE_NATIVE_QUESTIONS=0`·`VIDE_CODEX_APP_SERVER=0`은 공급자별로 끈다. app-server가 띄우기 실패·종료해도 엔진은 살아 있고 다음 턴은 새 프로세스 | 실제 대화의 장시간 사용 | [Claude SPIKE](../tdd/SPIKE-2026-09-30-native-questions-claude.md), [Codex SPIKE](../tdd/SPIKE-2026-09-30-codex-app-server.md), `tests/ai/question-settings.test.mjs` |
| AI 동등성 A/B(PLAN-24 지침 묶음) | 재실행 기준 VIDE 5/5 성공, 시간은 터미널의 2~4배. 관찰 1(되돌리기 뒤 열린 기록)·3(`IsValid`)·4(빈 캡처)는 `d8fb2ba`에서 고침 | 같은 절차로 다시 재기, 공정한 B(사람이 실행) | [SPIKE](../tdd/SPIKE-2026-09-30-ai-parity-ab.md), [지침 묶음 SPIKE](../tdd/SPIKE-2026-09-30-instruction-bundle.md) |
| T-076 skill 시작·카탈로그·`jig_open`·`ui_go` | 구현·단위·브라우저 시험 완료. 여러 단계 새 출력 레이어 생성(틀·`EditorApplication.TargetLayer`) 2026-10-02 구현, 플러그인 Release 빌드 통과(설치 전) | Rhino 사본에서 3단계 새 레이어 만들기 + 되돌리기 한 번(Rhino를 닫은 뒤), 플러그인 재설치, 실제 Claude CLI의 자체 질문 + jig 대화, 확신 낮을 때 두 갈래 질문, `summary.kpi` | [PLAN-26](PLAN-26-chat-stage.md) |
| T-077 토큰층·CSS 정리 | 완료 | 기능용 색 리터럴(`app.ts` 붓 색 등) | [PLAN-26](PLAN-26-chat-stage.md) |
| T-078 정적 목업 | 종료. 검토 결과를 T-079에 넘기고 목업은 폐기(`3a9617f`). 화면 검토는 `tools/mockups/ui-preview/` | — | [PLAN-26](PLAN-26-chat-stage.md) |
| T-079 셸 정리(좁힌 범위) | 완료(설치 전): 레일의 고정 화면·대시보드·프로젝트 자료·피드백·다크/라이트, 위쪽 줄은 열린 작업본만, 연결 파일·레이어 목록 | 피드백 폼 주소(사용자). 대시보드 내용은 T-098로 정함 | `16eb911`, `633f694`, `browser-workspace-tabs.mjs` |
| T-080 층 평면 보기 | 대기 | SPEC-02.17 보완 먼저 | [PLAN-26](PLAN-26-chat-stage.md) |
| T-081 산출물 탭 | 페이지 구현·브라우저 시험 완료(설치 전) | 도면 시트·생성형 렌더링 기능(각 SPEC 먼저) | `3a9617f` |
| T-092 다른 열린 연결 파일의 실시간 읽기 | 구현·단위 검증(설치 전). Rhino 대상 턴이 열린 Rhino 문서(조회·측정·보기)와 ZWCAD 도면(조회)을 `linkId`로 읽음 | 실제 Rhino 두 창 확인 | [PLAN-24](PLAN-24-ai-conversations.md#t-092) |
| T-093 여러 파일 쓰기·잠금·작업 단위 되돌리기·자동 되돌림 | 구현·단위 검증(설치 전). 잠금은 기다리지 않고 `DOCUMENT_LOCKED`(jig 바로 만들기 포함), 실패·중단한 여러 파일 요청은 자동으로 되돌림, `undo {all: true}`, 결과 불명은 확인 필요 문서만 잡고 되돌리기 답 유실은 다시 [되돌리기]로 해소(2026-10-01 검토 반영) | 실제 Rhino 두 창·ZWCAD 확인, ZWCAD 대상 턴의 여러 파일, 실행 답 유실의 해소 동작 | [PLAN-24](PLAN-24-ai-conversations.md#t-093) |
| T-094 파일별 결과·요청 [되돌리기] 화면 | 완료(설치 전) | 설치본 화면 확인 | [PLAN-24](PLAN-24-ai-conversations.md#t-094) |
| T-102 결과 확인 필요가 다음 요청을 막지 않음(다음 턴에 '먼저 읽기' 안내), [확인함]·기록 없는 불명의 [되돌리기]로 닫기 | 구현·단위 시험 완료(2026-10-02, 설치 전) | 설치본에서 막혀 있던 요청을 [확인함]으로 닫고 다음 Rhino 요청 확인. 추가 지시의 불명 규칙(SPEC-02.8)은 범위 밖 | [PLAN-24](PLAN-24-ai-conversations.md#t-102) |
| T-088 대화별 모델 고정·모델 바꾸기 = 새 탭 | 구현·단위·브라우저 시험 완료(`0fb9506`) | 실제 CLI로 모델 바꾸기 인계 확인(설치본 릴리스 때) | [PLAN-24](PLAN-24-ai-conversations.md#t-088) |
| T-097 [+] 새 대화를 묻지 않고 바로 열기(첫 요청이 이름) | 구현·단위·브라우저 시험 완료(2026-10-01). 통합 검토 반영: [+]의 빈 탭이 jig 시작에 묶인 뒤 [일반 대화로]를 누르면 그 묶기를 풀어(`…/unbind`) 같은 글이 jig 도구 없는 일반 턴으로 간다 | 설치본 확인(묶음 릴리스 때) | [PLAN-24](PLAN-24-ai-conversations.md#t-097), SPEC-02.19 |
| T-089 첨부 버튼 정리·경로 기반 첨부(모든 형식, `attachment_read`) | 구현·단위·브라우저 시험 완료(2026-10-01, 커밋 전) | 실제 Claude·Codex로 첨부 이미지·텍스트 읽기 확인(설치본 릴리스 때). 후속: PDF 본문 추출, 3DM 요약, 말(@언급)로 연계 대상 고르기. 원본 위치의 파일은 T-091의 프로젝트 폴더 읽기로 대신 | [PLAN-26](PLAN-26-chat-stage.md#t-089), SPEC-01.12 |
| T-090 참고 이미지 의도 확인 (a)~(d) 영역 표시·해석 말풍선·Codex 이미지·확정 → 모델링 | (a)~(d) 구현·단위·브라우저 시험(가짜 공급자·가짜 이미지 작업) 완료(2026-10-01, 커밋 전). 실제 Codex 이미지 작업 실측 33–44초(합성 장면) | 실제 CLI 해석 턴은 Claude·Codex 통과(2026-10-01). 말로 고치기의 실제 CLI 확인, 실제 Rhino 사본으로 SPEC-09 완료 기준·VERIFY, Design §03·§14 표현, PRD 범위 문장 | [PLAN-26](PLAN-26-chat-stage.md), SPEC-09 |
| T-091 프로젝트 폴더·AI 파일 읽기(`file_read`·`file_list`, 폴더 밖은 권한 질문) | 구현·단위·브라우저 시험 완료(2026-10-01, 커밋 전) | 실제 Claude·Codex로 권한 질문 답하기 확인(설치본 릴리스 때), 셸 폴더 선택 창은 다음 설치본부터 | [PLAN-26](PLAN-26-chat-stage.md#t-091), SPEC-01.13, `project-files.test.mjs`, `browser-project-folders.mjs` |
| T-095 다른 이름으로 저장 뒤 연결이 창을 따라감(Rhino·ZWCAD, 중복 행은 하나만 연결) | 구현·서버 시험 완료(2026-10-01, 설치 전). 통합 검토 반영: 여러 파일 호스트 턴(ADR-027)의 열린 연결도 목록과 같은 대조·따라가기(`followOpenDocuments`)를 써서 창 하나가 열린 행 둘이 되거나 목록 조회 전 다른 이름 저장을 놓치지 않는다 | 실제 Rhino·ZWCAD 창에서 다른 이름 저장 확인(설치본 반영 뒤 합성 문서) | [PLAN-16](PLAN-16-document-links.md#t-095), `link-follow.test.mjs` |
| T-096 연결 파일을 모두 숨겨도 남던 객체(시작 때 선택 순서), 어느 파일에도 속하지 않는 결과는 '작업 결과' 행 | 구현·브라우저 시험 완료(2026-10-01, 설치 전) | 설치본에서 사용자 프로젝트로 확인 | [PLAN-16](PLAN-16-document-links.md#t-096), `browser-links.mjs` |
| T-098 대시보드 할 일·일정(맨 위 '오늘', `agenda_*` 도구와 [되돌리기], schema 7) | 구현·단위·브라우저 시험 완료(2026-10-01, 설치 전). 검토 지적 6건 반영(되돌리기 판 검사, 편집 판 고정, 입력칸 초점, 기본 대화 호스트 턴 도구, 턴마다 안내 하나). 통합 검토 반영: 대상이 여럿인 연계 턴에서도 `agenda_*`는 `targetRef` 없이 쓴다 | 실제 Claude·Codex로 '회의록에서 할 일 뽑아줘' 확인(설치본 릴리스 때). 후속: 반복 일정·캘린더 연동·자료에서 찾기 | [PLAN-26](PLAN-26-chat-stage.md#t-098), SPEC-01.14, `agenda.test.mjs`, `browser-dashboard-agenda.mjs` |
| T-099 JIG 한 화면(레일의 만들기를 JIG에, 끝의 [새로 만들기] 카드, 작성 중 초안 카드, jig 하나에 카드 하나) | 구현·단위·브라우저 시험 완료(2026-10-01, 설치 전) | 설치본 반영(릴리스 때) | [PLAN-26](PLAN-26-chat-stage.md#t-099), `jig-list.test.mjs`, `browser-make.mjs` |
| T-100 jig 아이콘(정해 둔 목록의 `icon`) | 구현·단위·브라우저 시험 완료(2026-10-01, 설치 전) | S-06 v0.3.1은 아이콘 없음(기본 그림) — S-06은 사본을 만들 수 없어(T-101) 저장소 소스의 다음 버전에서 넣는다 | [PLAN-26](PLAN-26-chat-stage.md#t-100), `jig-manifest.test.mjs`, `make-routes.test.mjs`, `browser-jigs.mjs` |
| T-101 [수정하기](사본 초안 → 다시 고정 → 작업본 [올리기]) | 구현·단위·브라우저 시험 완료(2026-10-01, 설치 전) | 단계가 jig 밖을 가져오는 저장소 jig(S-06)는 사본을 만들지 않음(`JIG_NOT_FORKABLE`, 카드에 흐린 [수정하기]와 이유). S-06 사본은 상자 라이브러리만 쓰도록 다시 쓰는 후속 작업 뒤 가능. 설치본 반영 | [PLAN-26](PLAN-26-chat-stage.md#t-101), `drafts.test.mjs`, `make-routes.test.mjs`, `browser-jigs.mjs` |
| T-103 대상 파일 칩·연계 대상 창 폐지(고칠 연결 파일은 AI가 정함) | 구현·단위·브라우저 시험 완료(2026-10-02, 설치 전) | ZWCAD 도면에서 시작하는 요청은 여전히 다른 파일을 저장된 Sync로만 읽음(후속). `linkedTargets`는 이전 연계 요청용으로 엔진에 남김. 설치본 반영 | [PLAN-26](PLAN-26-chat-stage.md#t-103), SPEC-01.11의 5, ADR-027 후속 결정, `multi-file.test.mjs`, `browser-links.mjs`, `browser-workspace-controls.mjs` |
| T-082 안정성 0단계 진단·복구 | 구현·자동 검증(`9aac8cd`) | 실제 창의 화면 복구 확인, 설치본 릴리스 | [PLAN-27](PLAN-27-sync-storage-stability.md) |
| T-083 객체 단위 저장 | 계획 | ARCH-01 저장 계약 작성과 사용자 확인 뒤 착수 | [PLAN-27](PLAN-27-sync-storage-stability.md), [RESEARCH-13](../research/RESEARCH-13-stability-audit.md) |
| T-084 엔진 주관 Sync | 계획. 문서별 Sync 합치기는 먼저 구현(`fda1e5d`) | SPEC-01.11의 Sync 주체 보완 뒤 착수 | [PLAN-27](PLAN-27-sync-storage-stability.md) |
| T-085 화면 | 계획 | T-083 뒤 | [PLAN-27](PLAN-27-sync-storage-stability.md) |
| T-086 상한 | 계획 | T-083~085 뒤 | [PLAN-27](PLAN-27-sync-storage-stability.md) |
| T-087 정리·Rhino/ZWCAD 쪽 | 계획. 사본·작업 폴더 정리와 읽기 전용 감지 기록은 먼저 구현(`fda1e5d`) | 설치본 확인, 나머지 정리·호스트 쪽 항목 | [PLAN-27](PLAN-27-sync-storage-stability.md) |

현재 지원의 중요한 경계는 다음과 같다.

- 연결된 Rhino·ZWCAD 문서의 AI 편집은 자동 모드에서 실행 하나당 되돌리기 기록 하나로 바로 실행한다. 되돌리기로 쉽게 고칠 수 없는 동작(보호 목록)은 확인 카드를 거친다([ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md), SPEC-02.13). 작업 사본·후보 경로는 '검토'와 jig 내부 사본·가져오기에만 남는다. 사본 경로의 적용 지원 범위(Brep/Extrusion/Curve/Mesh/Point, 기존 층, 그룹 소속 유지)는 그대로다.
- 문서당 Sync 객체 상한은 20,000개다(`WorkerScene.MaxObjects`, PLAN-27 T-086에서 올린다).
- `sdk-models.editors.json`의 pairing은 재시작 때 PID·시작 시각·실행 파일·포트 소유를 재확인하며 모델 백업/공유에는 포함하지 않는다. 복원 핸들은 새 Rhino 실행·임의 코드 실행·쓰기 재전송을 하지 않는다.
- 객체·속성·레이어 이벤트 기반 선택형 Live Sync는 구현·검증했다. 모든 유형의 관계 보존은 완료가 아니다. 작은 SDK JSON 반환은 16 KiB 상한과 생략 여부를 명시한다.
- ZWCAD 자체 SDK는 능력 표시가 있는 mm·독립 직선 XY LWPolyline과 평면 LINE의 수정/추가/삭제를 지원한다. 그룹·확장 사전·XData·잠긴 레이어 등을 확인하지 못하면 참고 전용이다.
- Rhino 속성 입력은 ObjectAttributes user text의 한정 읽기·사용자 선택 첨부다. 세부 한도와 누락 표시는 네이티브 VERIFY를 따른다.
- 공유 게시/의견 왕복은 명시적 파일 전달이다. 500 MiB 바이너리 전송 통과와 별개로 웹 표시 JSON은 64 MiB 한도다.
- Rhino 수동 SaveAs 뒤 읽기 전용 안내는 VIDE 없이 Rhino를 써도 생긴다(2026-09-28 사용자 확인). 원인은 미해소이며, 연결 문서가 읽기 전용이면 엔진 기록에 남긴다(`fda1e5d`).

운영 조건: 개발 위임·중단 기준은 [가이드 §12](../../DEVELOPMENT_GUIDE.md#development-delegation)를 따른다. Cloudflare 시험은 무료·메일 없는 가입/소유자 승인 모드다. 유료 전환·도메인 구매·메일 발송은 승인되지 않았다. R2 기존 사용량 때문에 원격 모델 업로드는 차단돼 있으며 무료 시험 조건을 확인하기 전 해제하지 않는다([조건/재개 기준](../tdd/VERIFY-2026-09-24-sharing-host-roundtrip.md)). 기존 사용자 자료·열린 호스트는 시험용으로 변경하지 않는다. 대표 실무 과업 선정은 사용자 지시대로 후순위다.

증거: [TS/자체 호스트 VERIFY](../tdd/VERIFY-2026-09-22-typescript-foundation.md), [네이티브 VERIFY](../tdd/VERIFY-2026-09-20-native-workspace.md), [공유 VERIFY](../tdd/VERIFY-2026-09-22-cloudflare-sharing.md), [에이전트 도구 SPIKE](../tdd/SPIKE-2026-09-21-agent-tools.md), [뷰포트 SPIKE](../tdd/SPIKE-2026-09-21-viewport-engine.md), [ZWCAD SDK SPIKE](../tdd/SPIKE-2026-09-22-zwcad-sdk.md). 전체 완료는 §6.6의 관문으로 판단한다.

### 6.6 전체 완료 관문

완료 판정은 PRD §14.3·§15·§16을 따른다. 구현 증거는 아래 묶음으로 모으고 각 VERIFY에 적용 AC의 결과를 남긴다. AI 편집의 기준은 [ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md)의 바로 적용과 계획/자동 모드다. 후보·원본 적용 단계는 관문에 요구하지 않으며, '검토'와 jig 내부 사본에 남은 사본 경로는 해당 기능의 VERIFY로 따로 확인한다.

| 관문 | 필요한 실제 증거 | 담당 티켓 |
|---|---|---|
| 각 호스트 완결 | 읽기·공간 입력·계획 모드의 계획 카드·자동 모드의 바로 실행(바뀐 객체 목록)·[되돌리기]와 호스트 Undo·보호 동작 확인 카드·개입·기본 도구 편집·사용자 저장/재열기 | T-003·005·006·018 |
| 연계·병렬·보호 | 복수 문서 대상 고정, CAD→Rhino 실제 자료, 같은 문서 쓰기 대기열, 사람의 직접 수정·늦은 결과·부분 실패(호스트별 되돌리기)·불명확 결과의 지문 확인 | T-001·005·006 |
| 기록·수량·전달 | AI 단절 입력 보존, 근거/단위/미상 집계, 검토본 불변·비교, 표/요약 실제 열람 | T-002·007 |
| 외부 웹 | 실제 게시·의견·로컬 채택·수정, PC 종료 지속성, 권한 거절, 선언 브라우저/펜 입력 | T-009·010 |
| 확장·설치 | 실제 확장 실행·실패·비활성화, 별도 PC 설치·재개·제거 후 자료 보존 | T-008·011 |
| 사용자 가치 | 역할별 이해/사용성, 동일 과업의 수작업 및 에이전트+MCP 비교·실패 포함 비용 | T-010·012 |

자동 시험 통과는 이 관문 전체를 대신하지 않는다. AC 미시험을 ‘해당 없음’으로 바꿔 완료율을 높이지 않는다. 후속 범위 FR-20·21은 첫 출시 완료 조건에 혼입하지 않는다.

## 7. 테스트·수용 검수

결정적 권한·버전·큐 전이는 `node:test`로 TDD한다. 실제 저장 파일을 닫고 다시 여는 시험과 프로세스 중단 복구를 포함한다. UI·CLI·실호스트는 모의 테스트와 별도 결과로 기록한다. 호스트별 전체 흐름은 읽기→계획(계획 모드)→바로 실행(자동 모드)→개입→[되돌리기]·호스트 Undo→기본 도구 재편집→사용자 저장·재열기다([ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md)). 같은 호스트 복수 인스턴스, 두 호스트 부분 실패, 사람의 직접 수정, 늦은 결과, 응답 유실을 포함한다.

외부 웹은 로컬 PC를 종료한 채 마지막 게시본을 열고 의견을 제출한다. 서버의 원격 실행 거절도 확인한다. 확장은 실제 등록·실행·진행·개입·실패·비활성화를 검수한다. 집계는 지원 범위의 기준·단위·미상 값을 확인하고 CSV·HTML을 별도 프로그램에서 연다.

PRD §16.4 세 대표 과업과 ADR-006·012를 유지한다. OQ-06·14의 목표·자료·인원·허용 오차 결정 전에는 측정값만 기록하고 성능·제품 수용 통과를 선언하지 않는다.

### 7.1 상세 계약 검증 묶음

| 시험 묶음 | 결정적 검사 | 실제 환경으로 남길 것 |
|---|---|---|
| 입력·공통 | 프로젝트 격리, 버전 충돌, 핀/평면 불변, 단위 검증, 상태 역순 | 호스트 객체 대응, 펜/터치 취소 |
| 실행·후보 | 의존 DAG, 상한, 늦은 결과, 부분 결과, 동일 명령 변조 | 네이티브 직접 수정·소유권·응답 유실·기본 도구 재편집 |
| 데이터·검토본 | mm/m와 면적 환산, 미상 제외, 후보 중복 제외, 불변 manifest | 호스트 수량·파일 열람 호환성 |
| 공유·확장 | 공개 필드 허용 목록, 중복 의견, 권한 거절, 비활성 실행 거절 | PC 종료 뒤 외부 서버 지속성, 실제 확장 실행 |
| 화면 | Design §12.5 상태 시나리오·포커스·프로젝트 전환·늦은 응답 | 외부 검토자의 이해, 선언 기기의 실제 입력 |

합성 시험 자료는 문서 A/B, 동일 nativeId를 가진 다른 문서, mm/m 문서, 원본/후보 객체, 끊긴 참조, 미상 값, 불완전 취득, 역순 이벤트로 구성한다. fixtures는 tests 아래 해당 계층에 두며 실제 CAD 파일과 증거는 호스트 시험 시 생성한다. 숫자 비교 허용 오차와 모델 규모는 OQ-03·06·14 결정 전에는 제품 합격 수치로 사용하지 않는다.

### 7.2 대표 과업의 구체 시험 자료와 판정

다음 수치는 기능이 의도대로 이어지는지 확인할 **합성 시험 입력**이며 실제 프로젝트 규모·성능 목표가 아니다. 좌표 단위는 m로 설명하고 호스트 mm 시험에는 명시적으로 환산한다. 기하 비교 허용 오차는 실제 호스트 문서 tolerance·연산 특성과 OQ-03·14에서 선언한 값을 기록한다. 임의의 법정 면적으로 해석하지 않는다. ADR-022 이후 아래의 '후보'는 자동 모드의 실행 결과(바뀐 객체 목록과 되돌리기 기록)로, '적용'은 그 결과를 유지하는 것으로 읽는다. 사본 후보는 '검토'를 고른 경우에만 생긴다.

**과업 A — 각 호스트에서 경계 수정과 후속 지시**

- 입력: 닫힌 경계 A의 점은 (0,0), (12,0), (12,8), (0,8). 유지 객체 B는 별도 위치에 둔다. 객체 이름·레이어·지원 속성을 준비한다. 원래 면적은 96 m²다.
- 요청: A를 핀하고 y=10의 목표 선을 그려 “이쪽을 선까지 늘리고 반대편과 폭, B는 유지”라고 맡긴다. 실제 수정 후보는 12×10, 기하 면적 120 m²여야 한다. 원본 A와 B는 적용 전 보존되어야 한다.
- 개입: y=9로 선을 고쳐 후속 지시한다. 새 후보는 108 m²이며 이전 후보가 새 조건의 결과로 표시되지 않는다. 후보의 근거에서 두 원본 선과 지시를 구분한다.
- 반영: 선택한 108 m² 후보를 적용한 뒤 호스트 기본 도구로 재편집·저장·재열기한다. 실제 유형·지원 속성·형상을 확인한다. Rhino와 ZWCAD 각각 실행한다.
- 일반화 검사: 다른 객체·폭·방향으로 바꾸어 재실행하고, 목표/유지 대상을 교체한다. 위 좌표와 문장을 하드코딩한 결과는 실패다.

**과업 B — CAD 경계에서 Rhino 입체와 공동 변경**

- 입력: ZWCAD의 위 경계, Rhino 결과 문서, 확인한 단위/원점/축 변환과 높이 6 m. 먼저 H-RHINO-05의 실제 네이티브 유형과 편집 능력을 검증한다.
- 요청/결과: CAD 경계로 Rhino 돌출 후보를 만들고, 바닥 경계와 높이가 실제 입력에 맞는지 조회한다. 단순한 뷰어 메시만으로 통과하지 않는다.
- 공동 변경: CAD 경계 수정 후보를 Rhino 후속 입력으로 사용하여 양쪽 후보를 확인한다. 사용자 적용 후 문서별 결과·파일 저장을 검사한다. 높이만 4.5 m로 바꾸는 후속 요청에서 CAD 경계가 불필요하게 바뀌지 않아야 한다.
- 독립/실패: 별도 문서 작업을 함께 진행하고, 한쪽 연결을 끊는다. 의존 작업 보류·독립 진행·부분 적용을 확인한다. 성공분 재실행과 대상 전환이 없어야 한다.

**과업 C — 외부 의견에서 변경·전달까지**

- 입력: 실제 과업 A/B 결과와 표를 검토본으로 남겨 외부 서버에 게시한다. 검토자는 허용 웹 환경에서 같은 대상을 찾아 핀·선·의견을 제출한다.
- 로컬 설계자는 실제 수신한 의견의 원 기준을 열고 변경 작업으로 채택한다. 과업 A/B의 기존 실행 경로로 수정하고 표를 갱신한 뒤 전후 검토본을 비교한다.
- 같은 프로젝트 링크의 새 게시 상태, 과거 의견 기준, 내보낸 표 값·요약의 변경 내용을 확인한다. PC 종료 후에도 마지막 게시본과 서버 접수 의견을 열람한다.
- 네트워크 응답 유실·제출 재접속·공개 범위 제외를 함께 검사한다. 샘플 카드가 아니라 실제 저장·접수·변경 증거를 남긴다.

### 7.3 기능 충실도와 검수 보고

각 기능은 ‘사용자 입력 / 실제 수행한 동작 / 눈에 보이는 결과 / 다음 행동 / 원본 보호 / 미시험’을 한 묶음으로 보고한다. 구조적 계약 시험 통과와 사용자의 설계 과업 완료를 별도로 판단한다. 개발자가 로그를 설명해야만 결과를 알 수 있다면 AC-22 사용성 검수에서 문제로 기록한다.

문서 검토에서는 사용자가 세 과업의 흐름과 지원안을 보고 의도에 맞는지 판단한다. 구현 검수에서는 저장된 객체·계산 값·적용/저장 증거로 결과를 확인한다. 가치 검수는 PRD §16의 수작업/에이전트+MCP 기준선으로 준비·대기·수정·실패까지 측정한다. 이해도 판정자·기기·반복·오차는 OQ-14에 연결하며 에이전트 자체 시연만으로 사용자 이해를 통과 처리하지 않는다.

### 7.4 검수 기록 규칙 (구 PRD §15에서 이관)

실행 시에는 적용 AC의 통과·실패·미시험·해당 없음과 증거를 기록한다. 시험 결과는 장비·호스트·작업 유형·모델 규모·데이터 상태와 함께 기록한다. 모의 결과·정적 UI 시연·실제 호스트 시험을 구분한다.

AC별 시험 조작·증거 인정 규칙(구 PRD §15 AC 셀에서 이관):

- AC-29: 호스트에서 단위를 바꾸는 조작은 지원 범위 확인 뒤 사용한다.
- AC-30: 목업에서 버튼이 보이지 않는 것만으로 권한 검사를 통과 처리하지 않는다.

기록 양식은 `docs/tdd/VERIFY-YYYY-MM-DD-<scope>.md`(AI.md §2)를 따르고, 관련 AC와 호스트 검수일 때 H-*를 인용한다.

### 7.5 프런트 검증 방법 (Design에서 이관)

Design은 시각 기준만 소유하며 시험 방법은 이 절에서 관리한다. 1440/1024/768/390 CSS px 및 브라우저 확대에서 모델·입력·행동의 접근, 패널 전환 후 초안·선·선택 보존, 키보드 포커스/복귀·좌표 입력·핀 삽입을 확인한다. 원본/후보·지시 접수/반영·적용/저장·서버 접수를 사람이 구분하는지 과업으로 검수한다. 화면 캡처만으로 기능 통과를 선언하지 않는다.

기존 디자인 목표의 대비 검사는 일반 텍스트 4.5:1, 큰 텍스트 및 필수 조작/상태 요소 3:1을 기준으로 한다. 포인터 목표 최소 24×24 CSS px와 터치 주요 행동 44px 목표를 구분한다. 실제 표준 적합성을 주장할 때는 현행 공식 기준과 예외·입력 환경을 다시 확인한다. 본 수치는 이전 Design에서 이관한 검수 기준이지 이번에 새 인증을 수행했다는 뜻이 아니다.

웹은 선언한 iPad/펜과 데스크톱 브라우저에서 선택·탐색/스케치 전환·취소·의견 제출/재접속을 실제 시험한다. 자료/계정/판정자 확보가 안 된 항목은 미시험으로 기록하고 해당 티켓의 다음 행동을 남긴다.

## 8. 설치·업데이트 검증

T-011의 설치·업데이트·제거·복구 검증은 SPEC-05와 §6.6을 따른다. 개발 기반의 로컬 DB 업그레이드 검증은 PLAN-03 T-023, 기술 계약은 ARCH-01의 저장 절이 소유한다. 개발 PC 성공을 별도 PC 검수로 집계하지 않는다.

## 9. 위험·미결·후속 조사

지원 객체·원본 적용·배포 이용 조건·기기·성능의 미결은 PRD OQ와 해당 SPEC 지원표를 따른다. 각 미결이 막는 티켓만 제한하고 시험 미완료를 범위 축소나 성공으로 바꾸지 않는다. 신규 연구나 기술 선택은 RESEARCH/ADR, 실험은 SPIKE로 연결하며 이 문서에 조사 원문을 쌓지 않는다.

### 9.3 새 세션의 환경 확인 명령

Windows PowerShell에서 루트 기준으로 실행한다. 비밀 설정이나 인증 파일 내용을 출력하지 않는다.

```powershell
git status --short
node --version
npm.cmd --version
dotnet --list-sdks
npm.cmd test
npm.cmd --prefix tools/docs run build
npm.cmd --prefix tools/docs run check
git diff --check
git config --get core.hooksPath
```

문서 의존성이 없으면 `npm.cmd --prefix tools/docs ci`로 잠금 파일 기준 설치한다. 네트워크/승인이 필요한 환경에서는 해당 실패를 설명하고 임의로 다른 버전을 설치하지 않는다. 문서 훅 경로가 없으면 `git config core.hooksPath .githooks`로 설정한다. 설정 명령은 커밋을 만들지 않는다.

이전 합성 목업은 `tools/mockups/workspace/`에 보존되며(`node tools/mockups/workspace/serve.mjs`, `http://127.0.0.1:4317`) 정적 파일만 제공한다. 현재 화면 검수는 아래 제품 실행(`npm.cmd start`)과 `npm run test:browser`로 한다.

제품 로컬 실행은 `npm.cmd start`이며 데이터는 `%LOCALAPPDATA%\VIDE` 기본 위치 또는 명시한 테스트 위치를 사용한다. 최초 브라우저 세션 링크는 개인 실행 정보로 취급한다. 브라우저를 띄운 구현 검수는 실제 화면에서 확인한다. 호스트/CLI 실험은 기존 SPIKE의 방법·종료 조건을 읽고 본인이 새로 만든 합성 자료·프로세스만 사용한다.

### 9.4 후속 연구의 실행 계획

[Jev 판정 계층 평가 PLAN-05](PLAN-05-decision-layer-evaluation.md)에 선행 조건·변경 범위·검증·선택 기준을 정리했다. 연구 사실은 RESEARCH-02·03에 보존한다. Jev는 모델 자동 선택·요청 경로·이전 대화 고르기([PLAN-19](PLAN-19-request-routing.md))와 개발 도구(T-032)에 쓰고 있으며, 판정 계층 전체의 도입은 PLAN-05의 평가 뒤 정한다. 계정 관리는 [ADR-025](../decisions/ADR-025-accounts-in-accountswitch.md)에 따라 외부 AccountSwitch가 맡고, VIDE는 각 CLI의 기본 로그인만 쓴다([PLAN-25](PLAN-25-accounts-to-accountswitch.md)). PLAN-06의 계정 프로필 계획은 대체됐다. 연구 계획 작성은 로컬 제품 완결이나 해당 기능 구현 완료가 아니다.
