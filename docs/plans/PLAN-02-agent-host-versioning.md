---
id: PLAN-02
title: 범용 AI 실행·다중 호스트 통신·모델 데이터 버전 관리
status: review
version: 0.1
updated: 2026-09-21
owner: agent:codex
related: [PLAN, SPEC-02, SPEC-03, SPEC-04, SPEC-05, ADR-013]
---

# 범용 실행과 모델 데이터 기록 구현계획

PLAN §4·5의 상세화다. 사용자의 2026-09-21 지시(공식 API를 AI가 조합, 공통 규약, 복수 실행본, Git 원리 차용)에 따라 작성했다. 구현·성능 검증 완료를 뜻하지 않는다. 동작 정본은 SPEC-02.15·SPEC-03.9, 현재 티켓 현황은 PLAN §6.5다. PRD의 출시 범위와 원본 적용 권한은 유지한다.

## 1. 선택한 실행 구조

AI가 공식 SDK의 API와 실행 순서를 선택하고 코드를 작성한다. VIDE는 대상·권한·기준·실행 수명과 실제 결과를 관리한다. geometry.mjs의 제한된 operations 목록을 최종 실행 언어로 확장하지 않는다. 기존 경로는 이행 검증 동안 유지하되 새 경로 실패 시 몰래 대체하지 않는다.

| 구간 | 구현 선택 | 이유·한계 |
|---|---|---|
| 공식 구독 에이전트 → VIDE 도구 | 제품에 동봉한 MCP 서버, stdio | 공급자 공통 도구 설명·호출. 사용자가 외부 MCP를 설치하거나 개인 설정을 수정할 필요 없게 실행별 설정 제공 |
| MCP 도구 프로세스 → VIDE 제어기 | 사용자 범위 Named Pipe | 기존 제어기·SQLite 단일 소유 유지. 도구 프로세스마다 별도 DB/호스트 제어기를 만들지 않음 |
| VIDE 제어기 → 호스트 애드인 | Windows Named Pipe, 지속 연결 | 실행본별 연결·권한·변경 통지. 고정 TCP 1999 의존 제거 |
| 브라우저 → VIDE | 기존 loopback HTTP 유지 | 호스트 IPC를 브라우저에 노출하지 않음 |
| VIDE → 공유 서비스 | HTTPS | 게시본과 의견만 전달; 로컬 실행과 분리 |

MCP는 도구 규약, stdio/Named Pipe는 프로세스 통신 수단이다. 내부 호스트 연결까지 MCP 서버로 만들지 않는다. MCP 사용이 추가 추론 호출을 요구하지 않으며 임의 CAD API 사용 범위를 결정하지도 않는다. [공식 MCP 전송 규약](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [Windows Named Pipe](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes).

공급자별 어댑터는 공식 실행 프로그램의 스트림·도구 설정만 담당한다. 첫 검증에서 설치된 양쪽 CLI의 MCP 주입, 공급자 설정 격리, 같은 세션 내 조회→실행→오류 수정, 취소·재시작을 확인한다. 프로토콜/SDK는 구현 시 공식 안정 버전을 확인해 lockfile에 고정한다. 개인 MCP 설정이나 인증 파일을 복제하지 않는다. 구독 인증 재사용 방식은 기존 공식 도구 경로를 유지한다. 공급자가 필요한 도구 기능을 지원하지 않으면 해당 공급자 연결을 미지원으로 표시하고 기술 결정을 갱신한다. 이 계획만으로 실제 CLI 호환성을 주장하지 않는다.

### SDK·도우미·스킬

- 호스트 설치 버전에 맞는 공식 SDK를 참조한다. 첫 Rhino 실행 언어는 C#과 Roslyn 컴파일, 참조 어셈블리는 호스트 어댑터에서 제공한다. ZWCAD는 설치된 2023 .NET SDK/런타임 호환성을 먼저 실험하고 전용 애드인에서 실행한다. 현재 COM은 기존 지원 경로이며 다중 인스턴스용 최종 실행기로 간주하지 않는다.
- 코드 본문은 AI가 작성한다. 컴파일 진입점·오류 수집·호스트 UI 스레드 호출을 감싸는 고정 래퍼만 사용하며 편집 알고리즘 템플릿을 강제하지 않는다. GH는 별도 문서 대상으로 스크립트 소스/입출력·재계산을 처리한다. Rhino 문서와 GH 문서를 혼동하지 않는다.
- 작은 도우미 라이브러리는 단위 변환, 객체 조회, 측정 캐시, 결과 포장에 한정해 시작한다. 공식 SDK를 전부 재포장하지 않는다. 문서화한 버전·입출력·오류를 제공한다.
- 작업 지침은 함수 선택·조회 순서·예제·검증 기준을 담는다. 라이브러리와 지침 버전을 실행 기록에 남긴다. 전문 스킬 전체 구현(FR-21)을 첫 출시 필수로 추가하지 않는다.
- 임의 호스트 코드는 같은 프로세스의 다른 문서/API에 접근할 수 있다. 대상 필드·코드 문자열 검사·Undo는 보안 샌드박스가 아니다. 조회 권한에는 고정 조회 도구만 허용하고 임의 코드 도구를 주지 않는다. 후보 코드는 우선 VIDE 소유 작업 사본/전용 실행본에서 검증한다. 실문서 적용은 검증된 변경 집합을 기존 적용 계약으로 수행한다. 이 경계의 검증 전 임의 코드의 원본 접근을 제품 지원으로 열지 않는다.

## 2. 공통 메시지와 도구

내부 IPC는 JSON-RPC 2.0, UTF-8 JSON, 4바이트 unsigned little-endian 길이 + 본문으로 고정한다. MCP stdio의 프레이밍은 공식 SDK에 맡기며 내부 프레임을 stdio에 쓰지 않는다. 전송별 어댑터가 동일한 application 함수를 호출한다. 런타임 JSON Schema 검증과 C# DTO 계약 시험으로 양쪽 필드를 대조한다.

| 메서드 | 내용 |
|---|---|
| hello | protocol major/minor, 실행 세션, 호스트/SDK 버전, 언어·문서·취소 능력 |
| documents.list / objects.query | 대상 목록, 페이지·필드 선택 조회. 전체 모델 자동 전송 금지 |
| execution.start / execution.get / execution.cancel | 실행 접수, 영속 작업 상태, 중단 요청 |
| changes.read | 이벤트 순번 이후 변경 조회. 유실 시 resyncRequired |
| artifacts.describe | 코드/형상/결과 자산 ID·해시·크기·형식 |

AI 도구는 discover, query, execute, status, cancel, artifact 조회로 시작한다. 호스트별 SDK 설명은 조회 가능한 자료로 제공한다. 연결 토큰과 권한 grant는 모델이 만들지 않고 VIDE가 서버 측에서 붙인다. 도구 호출은 작은 결과와 참조만 반환한다.

```json
{
  "jsonrpc": "2.0",
  "id": "transport-request-uuid",
  "method": "execution.start",
  "params": {
    "protocolVersion": "1.0",
    "operationId": "durable-operation-uuid",
    "taskId": "task-uuid",
    "target": {"hostSessionId": "session-uuid", "documentSessionId": "open-document-uuid", "documentId": "logical-document-uuid"},
    "basis": {"documentRevision": 42, "readSet": [], "writeSet": [], "preserveSet": []},
    "language": "csharp",
    "codeArtifactId": "artifact-uuid",
    "arguments": {},
    "deadlineMs": 120000
  }
}
```

각 readSet/writeSet/preserveSet 요소는 objectId, geometryRevision, attributesRevision을 갖는다.

접수 응답은 operationId와 queued만 반환한다. 결과는 operationId, 상태, 실제 대상, 변경 전후 revision, added/modified/deleted ID, 진단, 자산 참조, 실행·조회 시간으로 구성한다. 상태 매핑은 SPEC-00.10을 따른다. 제안 코드의 성공 메시지를 실행 성공으로 저장하지 않는다. 컴파일 실패는 호스트 변경 전 실패, 실행 예외는 사후 조사 전 미반영으로 단정하지 않는다.

제어 메시지는 초기 1 MiB 제한, 큰 형상·코드는 자산으로 분리한다. 자산은 opaque ID로 조회하고 사용자 제공 절대 경로를 그대로 열지 않는다. 해시·길이 검증 후 임시 파일에서 원자적으로 확정한다. MCP 결과는 요약/페이지/자산 참조로 제한하여 거대 모델이 토큰 문맥에 자동 유입되지 않게 한다. 수치 제한은 시험 기본값이며 실모델로 조정한다.

major 불일치는 연결 거절, minor 추가 필드는 협상된 능력 안에서 허용한다. 요청 ID는 통신 응답 대응, operationId는 재접속 후 작업 식별이다. 같은 operationId+동일 payload는 기존 상태를 반환하고 다른 payload는 거절한다. 호스트에도 실행 전 접수·시작 저널을 기록한다. CAD 변경과 저널을 하나의 원자 트랜잭션으로 만들 수 없으므로 exactly-once를 주장하지 않는다. 변경 후 응답/기록 유실은 unknown으로 조사하며 자동 재실행하지 않는다.

## 3. 실행본·문서·병렬 실행

제어기는 사용자 전용 discovery pipe를 연다. 설치된 애드인이 등록하면 실행마다 새 hostSessionId와 전용 pipe를 발급한다. Windows 사용자 ACL, 원격 pipe 접근 차단, 시작 시 pairing nonce로 연결을 한정한다. 세션 종료 시 비밀과 등록을 폐기한다. PID는 진단 정보이며 재사용 가능한 PID/창 제목/파일명을 권한 식별자로 사용하지 않는다.

documentSessionId는 열릴 때마다 새 값, documentId는 VIDE 논리 문서 ID다. 경로 변경(Save As), 동일 파일의 동시 열기, 외부 복사로 내부 ID가 중복된 경우를 매핑 기록으로 구분한다. readonly 취득만으로 사용자 파일에 ID를 쓰지 않는다. 식별 불명은 재연결 대상으로 제시하고 활성 문서에 자동 대체하지 않는다.

문서 쓰기는 직렬화하고, UI 스레드 API 실행은 호스트 프로세스 단위 큐에서도 직렬화한다. 서로 다른 프로세스의 독립 작업은 병렬 실행 가능하다. 같은 호스트의 서로 다른 문서라는 이유만으로 SDK 동시 호출이 가능하다고 가정하지 않는다. 실행 직전에 대상 존재·문서 세션·관련 객체 버전을 재검사한다. readSet을 모르는 임의 코드에는 문서 전체 revision을 보수적으로 적용한다.

Rhino A→Rhino B 복사는 source 기준을 고정한 내보내기 → 형상·속성 자산 검증 → target 단위/좌표 변환 → 대상 생성 → 새 객체 ID와 source lineage 기록 순서다. 양쪽 잠금을 잡은 채 서로 기다리지 않는다. 원본은 변경하지 않는다. 블록/그룹/재질/외부 참조는 전달 패키지에 지원 범위를 명시하고 빠진 관계를 조용히 평탄화하지 않는다. 복사본은 새 객체 ID와 원본 버전 참조를 갖는다. 후속 변경이 자동 양방향 동기화를 만들지 않는다.

## 4. 모델·데이터 버전 저장

Git CLI나 .git에 사용자 모델을 넣지 않는다. 기존 SQLite에 메타데이터·이벤트·체크포인트를 저장하고, 사용자 데이터 폴더의 내용 주소 저장소에 형상·파일을 둔다. Git에서 불변 스냅샷·부모 참조·내용 재사용을 차용한다. 자동 병합·고급 브랜치 UI는 FR-20의 후속 범위다. [Git 스냅샷 원리](https://git-scm.com/book/en/v2/Getting-Started-What-is-Git%3F).

| 테이블/자산 | 주요 키·내용 |
|---|---|
| document_sessions | sessionId, documentId, hostSessionId, 관측 기준·이벤트 cursor |
| object_versions | (documentId, objectId, revision), geometryHash, attributesHash, relationSetHash, 삭제 표식, provenance |
| change_events | (documentSessionId, sequence) unique, operationId nullable, before/after revision, 종류, observedAt, actorConfidence |
| artifacts | sha256 primary key, bytes, format, serializerVersion, 상대 경로 |
| checkpoints | id, parentId nullable, manifestHash, 작업·생성 시각, 복원 지원 범위 |
| checkpoint_documents | (checkpointId, documentId), documentRevision, nativeArtifactHash, 상태 |
| metric_cache | (geometryHash, metric, unit, tolerance, algorithmVersion), 값·오차/유효성 |
| dependencies | 결과 버전→입력 객체/관계/표 정의 버전, 의존 종류 |

관계·속성·표 정의·근거도 버전화한다. 형상만 되돌리고 표·속성을 최신 상태와 섞지 않는다. 표와 보고서는 입력 버전·계산 정의 해시를 참조하고, 재생성 가능한 캐시와 보존해야 할 게시 산출물을 구분한다. 최신 객체 key-value에는 필요한 ID/버전/측정값만 미러링하며 이력의 정본으로 쓰지 않는다. 자기 속성 기록 이벤트가 형상 변경으로 재귀 처리되지 않게 분리한다.

### 변경부터 체크포인트까지

1. 애드인은 추가·삭제·교체·속성·Undo/Redo 이벤트를 수집한다. 이벤트 순번과 dirty 집합만 즉시 기록하고, 명령 종료/안정 시점에 병합한다. 외부 편집자의 신원·정확한 수정 시각을 추정하지 않는다.
2. 변경 후보만 실제 비교한다. SDK 직렬화가 비결정적이면 해시가 같은 의미의 형상을 항상 같게 식별한다고 주장하지 않는다. 직렬화 버전별 정규화 검증 전에는 보수적으로 재계산한다. 저장/재열기 ID 변동은 매핑으로 보존한다.
3. 형상 바이트·속성·관계를 별도 해시로 저장한다. 위치/회전만 바뀐 경우의 수량 재사용은 변환이 확인될 때만 한다. 비균일 스케일 등은 재계산한다. 면적·체적은 필요한 dirty 객체를 배치 계산하며, 표 조회는 캐시를 읽는다. 단위·tolerance·계산기 버전 변경도 무효화한다.
4. 자산을 임시 파일에 쓰고 flush/해시 확인/rename 후 SQLite 트랜잭션으로 버전·이벤트를 연결한다. DB에서 미완성 자산을 참조하지 않는다. 중간 실패의 orphan은 유예된 정리 대상으로 남긴다.
5. 작업 완료·명시적 체크포인트에서 객체/속성/관계/표/근거 버전을 묶은 manifest를 저장한다. 각 문서 revision 벡터를 기록한다. 여러 문서의 동시 원자 스냅샷이 아니며 취득 중 변경이면 재취득하거나 불일치 상태를 남긴다.
6. 네이티브 복원의 첫 기준은 .3dm/.dwg 파일 체크포인트다. 지원 확인된 객체는 증분 blob으로 확장한다. 메시는 표시용이며 네이티브 복원 자료가 아니다. 삭제 복원용 데이터도 확보해야 한다.

체크포인트 사이 변경도 change_events에서 조회한다. 오프라인 구간은 재연결 시 스냅샷 비교로 변화만 기록하며 누락된 편집 순서를 꾸며내지 않는다. 이벤트만 재생해 CAD 전체를 복원하는 순수 event sourcing은 채택하지 않는다.

### 비교·복원·보존

비교는 ID 집합의 추가/삭제, 형상·속성·관계 해시 차이를 계산하고 실제 변화가 있는 항목만 상세 비교한다. 복원은 우선 별도 사본으로 열어 검증한다. 원본에 반영할 때는 SPEC-02 적용 계약을 사용하며 새 작업/체크포인트로 남긴다. 여러 문서 복원은 부분 성공을 보존한다. 호스트 Undo 스택을 영속 이력으로 취급하지 않는다.

유지 중 체크포인트·게시본·진행 작업·백업을 GC root로 삼고 참조를 따라 mark/sweep한다. 첫 구현은 dry-run 목록과 회수 용량만 제공하고, 사용자 모델/확정 이력을 자동 제거하지 않는다. 임시 실행 자산과 재생성 가능한 캐시는 별도 TTL/용량 제한을 갖는다. 백업은 DB 일관 스냅샷과 참조된 blob·manifest 해시를 함께 검증한다. 기존 데이터는 마이그레이션 전 백업하고 새 테이블에 점진적으로 연결한다.

## 5. 외부 공유 호스팅 비교 — 2026-09-21 조사

공유는 SPEC-04 범위의 검토본·의견 서비스다. 로컬 AI/호스트 코드 실행, 전체 프로젝트 DB 공개, 클라우드 CAD 실행을 포함하지 않는다. 아래 추천은 운영 적합성 판단이며 실배포 벤치마크가 아니다. 계정·지역·예산/보존 정책은 OQ-04·09에 연결하고 실제 구매·게시 전에 정한다.

| 대안 | 구체 구성 | 장점 | 비용/운영·이식 제한 |
|---|---|---|---|
| Cloudflare | Static Assets + Workers + D1 + R2 | 정적 검토본/큰 파일 전달과 작은 의견 API, 서버 OS 운영 불필요 | Workers 제약·D1 어댑터 필요, 사용자 인증은 별도 설계. R2 송신료 없음이 전체 무료를 뜻하지 않음 |
| Render | Node 웹 서비스 + 유료 영속 디스크/SQLite, 규모 확대 시 Postgres·객체 저장소 | 기존 Node 코드와 가까우며 서버 OS 관리 부담 작음 | 디스크는 단일 인스턴스, 무중단 배포 제한. 기본 파일시스템은 휘발성. DB 별도 백업 필요 |
| Supabase + 정적 호스팅 | Postgres + Auth + Storage + API/Functions, 화면은 별도 정적 호스팅 | 사용자 계정·권한·관계형 조회가 중심일 때 유리 | 정적 화면 호스팅까지 단일 제품으로 해결하지 않음. 전송량·사용자·저장 비용, Postgres 이행 비용 |
| AWS Lightsail | Linux 인스턴스 + Caddy + Node + SQLite/디스크 또는 관리 DB·객체 저장소 | 기존 서버 구조 이식과 런타임 자유도 | 패치·배포·백업·장애 복구 운영을 담당해야 함. 묶음 전송량 초과 비용 포함 |

공식 근거: [Cloudflare 웹 앱 구성](https://developers.cloudflare.com/use-cases/web-apps/), [Workers 제한](https://developers.cloudflare.com/workers/platform/limits/), [Workers 요금](https://developers.cloudflare.com/workers/platform/pricing/), [R2 요금](https://developers.cloudflare.com/r2/pricing/), [Render 디스크 제한](https://render.com/docs/disks), [Supabase 데이터베이스](https://supabase.com/docs/guides/database/overview), [Auth](https://supabase.com/docs/guides/auth), [Storage](https://supabase.com/docs/guides/storage), [Lightsail 구성](https://docs.aws.amazon.com/lightsail/latest/userguide/what-is-amazon-lightsail.html), [요금](https://aws.amazon.com/lightsail/pricing/).

현재 추천은 검토본 중심이면 Cloudflare, Node 코드 이식·일반 서버 확장이 우선이면 Render다. 팀 계정/복잡한 권한을 곧 제공해야 하면 Supabase 조합을 우선한다. 지금 요구만으로 AWS 운영 부담을 추가할 근거는 약하다. Cloudflare가 보편적으로 최선이라는 결론은 내리지 않는다.

배포 전에 실제 검토본으로 저장 GB·월 게시량·캐시 miss 전송 GB·의견/API 호출·동시 열람·인증 사용자 수를 측정한다. 같은 입력에 기본료+저장+요청/CPU+전송+백업+인증 비용을 적용한다. 첫 부하 시험은 10/100/500 MiB 검토 자산과 1/10/50 동시 열람의 합성 행렬로 수행하며 실제 사용자 규모로 주장하지 않는다. 비공개 링크/철회·업로드 중단 재개·중복 의견·PC 종료·서비스 재시작 복구도 검증한다. 외부 서비스 계정이 없어도 API 계약과 로컬 시험을 진행할 수 있다.

공유 API는 publication manifest 생성→자산 업로드→해시 검증→게시 확정, comments 생성/이후 cursor 조회로 구성한다. 의견은 publicationId·objectId·기준 버전·공간 입력을 보존한다. 웹에는 허용 자산만 제공하고 localhost 제어 쿠키/CLI 자격 증명을 보내지 않는다. R2/D1 또는 다른 저장소는 작은 저장 어댑터로 분리하되 실제 두 번째 필요가 생기기 전 범용 클라우드 프레임워크를 만들지 않는다.

## 6. 구현 순서와 통과 조건

| 기존 티켓 | 구현 묶음 | 필수 검증 |
|---|---|---|
| T-003·004·018 | MCP stdio + 공통 계약 + discovery/Named Pipe + Rhino 코드 실행 수직 연결 | 양쪽 구독 에이전트의 조회→코드→오류 수정, 사용자 MCP 설정 없음, 기존 제한 JSON 없는 SDK 과업 |
| T-003·005·006 | 복수 실행본/문서, ZWCAD SDK 실행, 사본·적용 경계 | Rhino 2개·동명/미저장 문서·Save As·창 전환·재시작·A→B 복사, 대상 불일치 쓰기 0건 |
| T-013·017 | 이벤트·객체 버전·캐시 | 1객체 변경 시 무관 객체 측정 호출 0건, 단위 변경/Undo/삭제/오프라인 재대조 |
| T-005·007·013 | 체크포인트·차이·별도 사본 복원 | 모델+속성+관계+표의 기준 일치, DB/blob 중간 종료, 삭제 복원, 부분 성공·GC dry-run |
| T-009 | 공유 API·후보 호스팅 시험 | 로컬 PC 종료 후 게시본·의견 유지, 권한 철회·중복 제출·비용 산정 |

성능은 모델 추론, 도구 호출, IPC, 컴파일, 호스트 실행, 메시/측정, UI 반영으로 나눠 p50/p95·payload bytes·도구 호출/토큰·재시도를 기록한다. 현재 TCP 경로와 새 Named Pipe 경로에는 같은 코드를 사용해 순수 전송을 비교하고, 제한 JSON과 범용 AI 방식은 같은 사용자 과업의 성공률·총시간으로 별도 비교한다. 각 경로 반복 30회는 초기 측정 설정이며 성능 보증이 아니다.

기존 검증 경로는 새 수직 연결과 회귀가 통과한 뒤 관련 호출·문서 참조를 확인하고 제거한다. 기능별 구현·검증을 커밋하고 실제 지원표는 실호스트 증거가 생겼을 때만 올린다. 이번 변경은 계획 문서이며 제품 코드는 변경하지 않았다.
