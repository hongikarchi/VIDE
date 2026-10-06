---
id: PLAN-34
title: 오류·성능 정보 — 동의한 설치의 요약 보고(T-155~T-159)
status: draft
version: 0.1
updated: 2026-10-06
owner: agent:claude
related: [ADR-036, ADR-031, SPEC-05, ARCH-01, PLAN-28, FR-16, FR-18]
---

# 오류·성능 정보 — 동의한 설치의 요약 보고 (T-155~T-159)

근거: [ADR-036](../decisions/ADR-036-opt-in-telemetry.md)(2026-10-06 사용자 결정 "설치할 때 동의하면 가능하도록"). 동작은 [SPEC-05](../specs/SPEC-05-extensions-install.md).9, 화면은 Design SCR-22, 물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md) §6 「오류·성능 보고」. 요약의 원천은 T-126 진단 기록([PLAN-28](PLAN-28-stock-first.md) §T-126)이다. 마이그레이션 번호 0008·0009는 병렬 작업이 쓰므로 0010을 쓴다.

## T-155 요약과 허용 목록

| 변경 | 위치 |
|---|---|
| 이벤트별 허용 필드·형식(`ALLOWED_FIELDS`), 문장 정리 `reportText`(경로·주소·이메일·따옴표·문서 파일·ASCII 밖·ID·지정 단어), 스택 `reportStack`(VIDE 소스 꼬리만), 경로 패턴 `routePattern` | `src/server/telemetry-summary.ts` |
| 로그 요약 `summarizeLogs`(부분·이벤트 수, 실패 합치기, 종료 기록, 시간 표본 p50·p90·최대), 32 KB 상한 `capSummary` | 같은 파일 |

**검증:** `tests/server/telemetry-summary.test.mjs` — 한글 이름·공백 있는 사용자 폴더·UNC·`\\?\`·POSIX·주소·이메일·따옴표·키가 섞인 문장(고정 시드 3,000건 조합 포함)에서 비밀 단어·비 ASCII·경로가 남지 않음, 스택은 VIDE 소스 위치만, 필드 허용 목록(요청·프로젝트·연결 ID 제외), 실제 모양의 로그 요약, 상한.

## T-156 엔진: 동의·모아 보내기·다시 보내기·충돌 질문

| 변경 | 위치 |
|---|---|
| `Telemetry`: `telemetry.json`(선택·설치 번호·커서), 시작·매시 회차, 보낼 상자(14개), 2xx 삭제·400/413/415/422 버림·그 밖 유지, 거부 시 상자 삭제, 미리 보기, 충돌 감지(`engine-exits.jsonl`)와 묶음 전송 | `src/server/telemetry.ts` |
| `GET/PUT /api/v1/telemetry`, `GET /telemetry/preview`, `POST /telemetry/crash`(이 PC만), 시작·종료 연결, 로그 `telemetry-consent`·`telemetry-bundle` | `src/server/server.ts` |

**검증:** `tests/server/telemetry.test.mjs` — 답하기 전 전송 0건·카드 표시(원격·비설치본 제외), 동의 뒤 줄만 보냄, 거부 뒤 전송 0건·상자 삭제, 연결 실패 3회 뒤 한 번에 오래된 순 전송, 429 유지·422 버림, 충돌 질문 한 번·[보내지 않음]·스위치 꺼진 사이트의 `BUNDLES_DISABLED`·켜진 사이트 전송·정상 종료/강제 종료 제외, HTTP 경로(형식 오류 400, 미리 보기는 보내지 않음).

## T-157 사이트: 받기·한도·묶음 스위치

| 변경 | 위치 |
|---|---|
| D1 `telemetry_reports`·`telemetry_limits`·`telemetry_bundles` | `src/sharing/migrations/0010-telemetry.sql` |
| `POST /api/telemetry/reports`(48 KB, 형식, 경로·이메일 남은 본문 거절, 설치당·주소당 하루 한도, 정리), `POST /api/telemetry/bundles`(`TELEMETRY_BUNDLES_ENABLED`가 켜질 때만, 크기·한도, R2) | `src/sharing/telemetry.ts`, `worker.ts`, `auth.ts`(Env) |

## T-158 관리자 화면·API·CSV·개발 도구

| 변경 | 위치 |
|---|---|
| `GET /api/admin/telemetry/{summary,reports,reports.csv,bundles,bundles/:id}` — `ADMIN_USERS` 계정 또는 `TELEMETRY_ADMIN_TOKEN`, `/api/me`의 `admin` | `src/sharing/telemetry.ts`, `worker.ts` |
| 보고 화면 `/?admin=reports`(날짜·버전·종류 거르기, 요약 표, 보고 펼치기, CSV), 공개 안내 `/privacy` | `src/sharing/web/reports.tsx`, `privacy.tsx`, `main.tsx`, `style.css` |
| 버전별 설치 수·실패 종류·종료 코드·주요 시간, `--json`·`--csv`·`--out` | `tools/diagnostics/reports.mjs` |

**검증(T-157·T-158):** `tests/sharing/telemetry.mjs`(`npm --prefix src/sharing test`에 포함) — 저장, 형식 오류 400·415, 큰 본문 413, 경로·사용자 폴더·UNC·이메일 422(저장 안 됨), 설치당·주소당 429, 묶음 기본 503, 관리자 외 401·403·잘못된 토큰 401, 관리자 계정·토큰 읽기, 요약 표, CSV(머리·행 수·수식 무력화·따옴표), 스위치 켠 묶음 저장·목록·내려받기·비관리자 403.

## T-159 화면·문서

| 변경 | 위치 |
|---|---|
| 첫 실행 카드·충돌 카드(`TelemetryCards`), 설정 ‘상태 · 오류’의 스위치·상태·목록·[보낼 내용 보기](`TelemetrySection`) | `src/ui/shell/telemetry.tsx`, `Shell.tsx`, `settings-dialog.tsx`, `style.css` |
| 동의 문구·보내는 것/보내지 않는 것·묶음 내용·안내 절(초안, 법률 검토 권장) | `src/contracts/telemetry-notice.ts` |
| ADR-036, SPEC-05.9, Design SCR-22, ARCH-01 §6, 이 계획, PLAN §6.5 | `docs/**`, `Design.md` |

**검증:** `tests/integration/browser-telemetry.mjs`(`npm run test:browser`에 포함) — 카드 표시·목록 펼침·안내 링크·Escape로 닫히지 않음·답 전 전송 0건, [동의] 뒤 `telemetry.json`, 설정 스위치 켜짐·미리 보기·끄기, 다시 열 때 카드 없음, 충돌 카드(코드·묶음 내용·덤프 기본 해제)·[보내기]·사이트 꺼짐 안내와 파일 경로·한 번만 묻기.

## 배포 순서(사용자 지시가 있을 때)

1. 사이트: `npx wrangler d1 migrations apply <DB> --remote`(0010), 비밀 `wrangler secret put TELEMETRY_ADMIN_TOKEN`(32자 이상 무작위), 변수 `ADMIN_USERS`(관리자 아이디), `TELEMETRY_BUNDLES_ENABLED`는 두지 않음(꺼짐), 그다음 `wrangler deploy`.
2. 설치본: 사이트 배포 뒤 릴리스. 기존 설치는 갱신 뒤 첫 실행에 카드를 본다.
3. R2 정리가 끝나면 `TELEMETRY_BUNDLES_ENABLED=true`로 묶음 받기를 켠다(크기 변수는 필요할 때).

## 현황

**진행(2026-10-06) — 구현·자동 검증, 배포·설치본 확인 남음.** 위 시험과 `npm run typecheck`·`typecheck:sharing`·`npm test`·`npm --prefix src/sharing test`·`build:sharing`·`docs:check` 통과. C# 셸은 바꾸지 않았다(엔진이 `VIDE_DESKTOP=1`로 설치본임을 알고 카드는 창의 첫 대화상자로 뜬다).

남은 것: 사이트 배포(위 순서, 사용자 지시 뒤), 설치본에서 첫 실행 카드·실제 전송 확인, 안내 문구 법률 검토, R2 정리 뒤 묶음 받기 켜기.
