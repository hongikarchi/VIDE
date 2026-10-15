# 비밀번호 사이트 템플릿

보고용 산출물(`06_산출물/<이름>/`)을 사용자 본인의 Cloudflare 계정에 비밀번호와 함께 게시하는 Worker 템플릿이다(PLAN-54 T-347, ARCH-01 「게시 템플릿」, SPEC-05.11, Design SCR-43). 기록은 [SPIKE-2026-10-15-cloudflare-api-deploy](../../../../docs/tdd/SPIKE-2026-10-15-cloudflare-api-deploy.md).

| 파일 | 역할 |
|---|---|
| `worker.js` | 비밀번호 확인 + 정적 자산 전달. VIDE가 그대로 main module로 올린다 |
| `wrangler.template.jsonc` | 같은 설정의 wrangler 형식. VIDE는 `compatibility_date`만 읽는다. 손 배포용 |

## 동작

- `REPORT_PASSWORD`·`SESSION_SECRET` 비밀이 없으면 모든 요청에 503.
- `POST /login`(같은 origin만)에서 비밀번호를 NFC로 맞춘 뒤 HMAC 비교(길이·위치가 새지 않음). 맞으면 쿠키 `__Host-review=<만료ms>.<HMAC-SHA256>`(HttpOnly · Secure · SameSite=Lax · 8시간).
- 쿠키가 없거나 만료되면 비밀번호 화면(입력 칸은 `type=password`). `GET /logout`은 쿠키를 지운다.
- 모든 응답에 `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`. `/robots.txt`는 전부 막는다.
- `PUBLIC_PATHS`(쉼표 구분 경로, 기본 비어 있음)에 적은 자산만 로그인 없이 내보낸다.

## VIDE의 배포 순서 (wrangler 없음)

`src/server/cloudflare-deploy.ts`가 Cloudflare API로 올린다.

1. `POST /accounts/{a}/workers/scripts/{n}/assets-upload-session` — 파일 목록(경로 → SHA-256 앞 32자, 크기)
2. 응답 `buckets`의 파일만 `POST /accounts/{a}/workers/assets/upload?base64=true`(세션 JWT) → 완료 JWT
3. `PUT /accounts/{a}/workers/scripts/{n}` — `worker.js` + `metadata{main_module, compatibility_date, assets{jwt, config}, bindings[assets, PUBLIC_PATHS], keep_bindings[secret_text]}`
4. `PUT /accounts/{a}/workers/scripts/{n}/secrets` — `REPORT_PASSWORD`, `SESSION_SECRET`(비밀번호를 바꿀 때만)
5. `GET /accounts/{a}/workers/subdomain` → `POST …/scripts/{n}/subdomain {enabled:true}` → `https://<n>.<계정>.workers.dev`

## 손으로 배포할 때

`wrangler.template.jsonc`를 `wrangler.jsonc`로 복사해 `{{name}}`을 바꾸고, 보고용 폴더를 `./public`에 둔 뒤 `npx wrangler deploy`, 비밀은 `npx wrangler secret put`으로 넣는다. 비밀번호를 파일에 쓰지 않는다.
