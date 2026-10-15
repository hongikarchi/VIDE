---
id: SPIKE-2026-10-15-cloudflare-api-deploy
title: wrangler 없이 Cloudflare API만으로 비밀번호 사이트 배포
status: review
version: 0.1
updated: 2026-10-15
owner: agent:claude
related: [PLAN-54, T-347, T-343, T-344, SPEC-05, ADR-043, ARCH-01, SCR-43]
---

# wrangler 없이 Cloudflare API만으로 비밀번호 사이트 배포

[PLAN-54](../plans/PLAN-54-outputs-accounts-proposals.md) T-347의 선행 실험이다. 결정은 [ADR-043](../decisions/ADR-043-user-accounts-deploy.md)(API 배포, 이 SPIKE 조건), 의미는 SPEC-05.11 Cloudflare 행, 물리 형식은 ARCH-01 「게시 템플릿」, 화면은 Design SCR-43이 소유한다.

## 질문

VIDE가 wrangler를 동봉하지 않고 Cloudflare REST API만으로 사용자 계정에 **정적 자산 + 비밀(secret) + workers.dev 주소**를 가진 Worker를 올리고, 같은 이름으로 다시 올려 덮고, 내릴 수 있는가?

## 방법

- Cloudflare 공식 문서를 읽어 요청 모양을 정했다: Workers Static Assets 「Direct Upload」, Workers API 참조(Scripts update · Secrets update · Subdomain), Workers 「Limits」(2026-10-15 열람).
- 그 모양대로 클라이언트 `src/server/cloudflare-deploy.ts`를 만들고, 같은 끝점을 흉내 내는 가짜 API `tests/fixtures/fake-cloudflare/server.mjs`(두 단계 자산 올리기, 올린 것을 기억)에 대해 `tests/server/cloudflare-deploy.test.mjs`로 확인했다.
- 템플릿 `src/sharing/deploy-templates/password-site/worker.js`는 Node에서 가짜 `ASSETS` 바인딩으로 직접 실행해 로그인·쿠키·허용 목록·503을 확인했다.
- 사용자 폴더의 원본 배포(논현동 164 `cloudflare-deploy`)는 읽지 않았다. 패턴은 PLAN-54 조사 메모(폼 로그인, `__Host-review` HMAC 쿠키, 8시간, 비밀 없으면 503, noindex, private no-store)를 따랐다.

## 구현한 요청 모양

모든 경로는 `https://api.cloudflare.com/client/v4` 아래, `Authorization: Bearer <API 토큰>`(자산 올리기만 세션 JWT).

| 순서 | 요청 | 본문 | 응답에서 쓰는 것 |
|---|---|---|---|
| 1 | `POST /accounts/{a}/workers/scripts/{n}/assets-upload-session` | `{manifest: {"/index.html": {hash, size}, …}}` — hash는 SHA-256(파일 base64 + 확장자(점 없이))의 앞 32 hex | `result.jwt`(세션), `result.buckets: string[][]`(아직 없는 hash 묶음) |
| 2 | `POST /accounts/{a}/workers/assets/upload?base64=true` (Bearer = 세션 JWT), 묶음마다 | multipart: 필드 이름 = hash, 값 = base64 텍스트의 File(파일명 = hash, type = 내용 형식) | 모든 파일이 올라가면 201 + `result.jwt`(완료). 묶음이 없으면 세션 JWT가 곧 완료 JWT |
| 3 | `PUT /accounts/{a}/workers/scripts/{n}` | multipart: `metadata`(JSON) + `worker.js`(`application/javascript+module`). metadata = `{main_module:'worker.js', compatibility_date(템플릿에서), assets:{jwt, config:{run_worker_first:true, html_handling:'auto-trailing-slash', not_found_handling:'none'}}, bindings:[{type:'assets',name:'ASSETS'},{type:'plain_text',name:'PUBLIC_PATHS',text}], keep_bindings:['secret_text']}` | `result.etag`(판 표시) |
| 4 | `PUT /accounts/{a}/workers/scripts/{n}/secrets` ×2 | `{name: 'REPORT_PASSWORD' 또는 'SESSION_SECRET', text, type:'secret_text'}` — 비밀번호를 정할 때만 | — |
| 5 | `GET /accounts/{a}/workers/subdomain` → `POST …/scripts/{n}/subdomain` | `{enabled:true, previews_enabled:false}` | 주소 `https://{n}.{result.subdomain}.workers.dev/` |
| 내리기 | `DELETE /accounts/{a}/workers/scripts/{n}?force=true` | — | 404는 '이미 없음'으로 본다 |

- **비밀은 metadata에 넣지 않는다.** 스크립트는 비밀이 없는 채로 먼저 만들어지고(그 사이 요청은 503), 4단계에서 비밀이 붙는다. 비밀 끝점은 스크립트가 있어야 받으므로 순서가 3 → 4다.
- **다시 게시:** `keep_bindings:['secret_text']`로 이전 비밀번호가 남는다(Design SCR-43 '비밀번호는 그대로입니다'). 바뀐 파일만 올라간다(같은 hash는 세션이 묶음에서 뺀다).
- **실패 대응:** 401 → `ACCOUNT_NOT_CONNECTED`, 403 → `ACCOUNT_SCOPE`('Workers 편집 권한이 필요합니다'), 그 밖의 실패 → `PUBLISH_FAILED` + 응답 `errors[0].message (code)` 한 줄, 연결 불가·시간 초과·본문 없는 5xx → `SERVICE_UNREACHABLE`.

## 한계 (문서 기준)

- 자산 한 파일 **25 MiB**, 한 판의 파일 수 무료 **20,000** · 유료 100,000. 클라이언트는 무료 기준으로 미리 막는다(`PUBLISH_TOO_LARGE`). 조사 메모의 원본 보고서 `index.html`은 약 24.5 MB로 한도에 가깝다 — 큰 장면은 별도 파일로 나눠야 한다.
- 스크립트 64 MiB(압축 무관), 변수·비밀 무료 64개 · 5 KB/개 — 템플릿은 3개만 쓴다.
- 토큰 범위: 계정 `Workers Scripts:Edit`가 필요하다(하위 도메인 읽기 포함). 범위 확인은 T-344의 `GET /user/tokens/verify`가 맡는다.

## 결과

| 확인 | 결과 |
|---|---|
| 가짜 API에 대해 처음 배포(자산 3개·묶음 2개·비밀 2개·workers.dev) | 통과 — 올린 main module이 템플릿 파일과 같음, metadata·script 요청에 비밀번호 없음 |
| 같은 이름으로 다시 배포 | 통과 — 덮어씀, 바뀐 파일만 올림, 비밀 PUT 없이 비밀번호 유지 |
| 이름 규칙(소문자 kebab ≤ 63), 경로·크기 검사 | 통과 — 요청을 보내기 전에 거절 |
| API 실패·도달 불가 | 통과 — 위 오류 코드와 첫 오류 메시지 |
| Worker 단독 실행(Node, 가짜 ASSETS) | 통과 — 503, `type=password` 폼, NFC 비교, 쿠키 위조·만료·다른 키 거절, 허용 목록만 공개, noindex·no-store |
| **실제 계정 배포** | **실행하지 않음** — 사용자의 Cloudflare 토큰이 필요하다. 남은 조건: 시험 계정에 1회 배포 → 폰에서 열기 → 다시 배포 → 내리기(PLAN-54 T-347 검증 2·3단계) |

결론: 문서상 API만으로 가능하며 요청 모양과 순서는 위와 같다. 실제 Cloudflare가 가짜와 다르게 답하는 부분(특히 업로드 응답의 `result.jwt` 위치, 403/401 구분)은 실계정 1회 배포에서 확인한다.
