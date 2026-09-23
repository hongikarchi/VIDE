---
id: VERIFY-2026-09-24-development-foundation
title: 개발 기반 검증
status: review
version: 0.2
updated: 2026-09-24
owner: agent:codex
related: [PLAN-03, T-019, T-020, T-021, T-022, T-023, T-024]
---

# 개발 기반 검증

기준은 PLAN-03이다. 제품 수용 AC나 실호스트 지원을 새로 통과했다고 주장하는 기록이 아니다.

## T-019 · 추적·배포 제외

- 변경 전 추적 파일 446개: 자격증명 확장자·개인 SQLite·CAD 원본·Wrangler 상태 경로가 추적되지 않았음을 확인했다. 비밀값 내용 검사는 T-020에서 구분한다.
- `.gitignore`: 로컬 Workers 상태/변수, DB/WAL, 인증서 개인키, 덤프, 사용자 CAD 파일을 제외한다. 합성 CAD fixture·환경 예제·잠금 파일·문서 HTML은 보존한다.
- `git check-ignore --no-index -v --non-matching <경로>`: .env/.dev.vars/로컬 DB/.wrangler 제외, store.ts/PRD.html/package-lock.json 유지, 합성 fixture와 .env.example 예외를 확인했다.
- Windows 패키지의 소스 복사를 Git index 목록으로 제한했다. 추적 파일에도 금지 경로가 있으면 실패하며 심볼릭 링크를 따라가지 않는다. 빌드된 UI·자체 호스트 런타임·잠금된 생산 의존성은 기존 명시 경로로 포함한다.
- `node --test tests/server/package-source.test.mjs`: 1/1 통과. 정상 소스 복사, 미추적 환경/DB 미포함, 추적된 금지 경로 및 경로 탈출 거절. 전체 Windows 패키지는 이 단계에서 재생성하지 않았다.

## T-020 · 비밀정보·배포 보호

- 공식 Gitleaks 8.30.1, Windows/Linux x64 배포본 SHA-256을 고정한 설치 스크립트. `security:check`는 로컬 Git 전체 참조를 검사하고 훅은 staged diff를 검사한다. 출력은 100% 마스킹하며 추가 예외는 없다. 미설치/버전 불일치는 실패한다.
- 최초 144커밋·약 30.76 MB, 구현 커밋 포함 재검사 149커밋·약 31.76 MB에서 탐지 없음. 원격의 별도 미취득 참조까지 검사했다는 뜻은 아니다.
- `security:selftest`: 메모리에서 생성한 무효한 GitHub 형식 키 1건 탐지·차단. 실제 키는 사용하지 않았다.
- `deployment:check`: staging 계정·D1·R2·메일 없는 모드·업로드 중지 설정 확인. 다른 계정/저장소/업로드/메일 설정은 회귀 시험에서 거절했다. 실시간 사용량·과금 조회나 실제 배포는 아니다.
- GitHub main 보호 조회는 `Branch not protected`를 반환했다. CI 파일은 작성했으나 원격 push/CI 실행/필수 검사 보호 설정은 아직 완료하지 않았다. account_id는 비밀값이 아니며 승인된 대상 확인용으로 유지했다.

## T-021·022 · 자동 검사·포맷

- UI·서버·공유 Workers 타입 검사, 웹/서버/공유 빌드, 자동 시험 **136/136**, 로컬 Workerd/D1/R2 회원/초대/권한/게시/의견 통합, Chrome 헤드리스 React 회귀 통과.
- Prettier 3.8.1을 고정했다. 제품·시험·개발 검사 TS/TSX/JS/MJS/CSS/JSON/JSONC를 포맷하고 재검사 통과. C#·Markdown·생성 HTML·잠금 파일·벤더는 제외한다. JSONC는 기존 소비자의 호환성을 위해 trailing comma를 추가하지 않는다.
- 포맷은 `0120a36`에 동작 변경과 별도로 커밋했다. 기본 `verify`와 코드 커밋 훅에서 check만 실행한다. 공유 통합/브라우저는 전체 검증 경로에 둔다.
- 합성 오류 시험: 타입 TS2322, 실패 테스트 GATE_NEGATIVE, 부분 스테이징, 오래된 AI.html을 각각 실패로 검출했다. 시험용 파일·변경은 제거했다. 첫 타입 오류 시험은 CRLF 포맷 위반으로 먼저 차단되어 LF로 고친 뒤 타입 검출을 별도 확인했다.
- 브라우저 자동 시험의 스크린샷을 임시 시험 디렉터리로 옮겼다. 재실행이 기존 문서 증거 이미지를 덮어쓰지 않는다.
- 공유 esbuild는 제한 환경에서 상위 디렉터리 접근이 막혀 권한 보완 후 재실행해 통과했다. `npm run verify:all` 최종 통합 명령도 exit 0으로 통과했다. 원격 CI 환경은 미실행이다. Vite의 500 kB 청크 경고는 남아 있으며 대형 모델 성능 합격을 뜻하지 않는다.

## T-023 · 로컬 DB 이행

- 흩어진 CREATE TABLE을 schema 2 기준선으로 통합. 기존 schema 1은 제어 잠금 상태에서 `VACUUM INTO` 백업 후 단일 트랜잭션으로 이행한다. 현재 버전 재실행은 백업을 반복하지 않는다. 새 버전·손상 DB는 쓰기 전에 거절한다.
- 새 DB, 기존 요청/게시 관계 보존, committed WAL 백업, 재열기, 중간 SQL 실패의 롤백, 백업 경로 실패 시 무변경, 지원 초과/손상 DB 거절을 합성 사본으로 시험했다. 기존 오프라인 전체 백업 시험도 통과했다.
- 백업 manifest는 실제 schema를 기록하고 검증 시 DB 버전과 대조한다. 자동 이행 백업은 DB 스냅샷이며 모델 파일을 포함하는 전체 백업과 구분한다. 사용자 실사용 DB는 이 시험에서 열거나 이행하지 않았다.

## T-024 · 의존 경계·중복·예외

- package-root 탐색을 중립 core로 옮겨 hosts→server import를 없앴다. C# verbatim literal 7곳을 hosts/common으로 통합했다. 따옴표·경로·개행·유니코드·코드 모양 문자열의 round-trip 시험 통과.
- 빈 catch를 검토했다. 이미 실패/unknown/emailDelivery로 표시하는 경로는 그 의도를 주석으로 남겼다. 레이어 디코딩 실패는 ‘읽기 실패’, 소유 ZWCAD 문서 닫기 실패는 경고로 구분했다. 인증/개인 경로가 포함될 수 있는 예외 원문을 새로 로그에 쓰지 않는다.
- Rhino C# 빌드 통과(경고 0·오류 0), 격리 작업 트리의 ZWCAD SDK 빌드 통과. 호스트 계약 회귀 통과. 실제 Rhino/ZWCAD 작업 문서의 생성·수정은 이번 기반 시험의 범위가 아니다. WorkerExecutor의 원인 보존/실행 방어는 PLAN-02 제품 단계로 남긴다.

## 작업 트리와 남은 조건

동시 Jev 문서 작업을 보존하기 위해 `codex/development-foundation` 브랜치와 `.vide/worktrees/development-foundation` 작업 트리에서 기능별 커밋했다. 원래 작업 트리의 Jev 조사/마스터 변경은 이 브랜치에 포함하지 않는다. 두 작업의 통합은 미완료이며 원격 push는 하지 않았다. Windows 전체 배포 ZIP 재생성, 원격 CI/브랜치 보호, 실사용 DB 사본 업그레이드는 별도 검수 조건이다.
