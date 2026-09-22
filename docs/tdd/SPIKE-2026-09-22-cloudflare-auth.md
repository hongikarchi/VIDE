---
id: SPIKE-2026-09-22-cloudflare-auth
title: Cloudflare D1 인증·계정 복구 로컬 실험
status: review
version: 0.2
updated: 2026-09-22
owner: agent:codex
related: [T-009, SPEC-04, AC-30, AC-37]
---

# 질문과 범위

PLAN-02 §5 단계 1: Better Auth 1.7.5가 Workers/D1에서 가입·인증·세션·로그아웃·계정 복구를 실제로 수행하는가? 이메일 링크 재사용과 잘못된 Origin/세션을 거절하는가? 제품에 인증 프로토콜을 직접 만들지 않는다.

코드는 `tools/spikes/2026-09-22-cloudflare-auth/`, 실행 데이터는 `.vide/cloudflare-auth/`다. Wrangler 4.136.1을 고정하며 로컬 workerd/D1에 합성 계정만 만든다. 원격 바인딩·실제 메일·유료 리소스·공개 배포는 실행하지 않는다. 로컬 메일 모의 전달과 실제 운영 계정의 발송 자격은 별도 결과다.

## 방법과 종료 조건

로컬 D1 스키마 생성 → 이메일 확인 전 로그인 거절 → 모의 이메일 확인 링크 → 로그인/세션 → 잘못된 비밀번호·다른 Origin 거절 → 복구 링크·암호 재설정 → 기존 세션 무효화·복구 토큰 재사용 거절을 확인한다. 인스턴스 재시작 후 계정 지속성도 확인한다. 실행 결과와 실패 원인을 아래에 기록하고 T-009 제품 채택 여부를 판단한다.

## 공식 근거

- [Better Auth D1 지원](https://better-auth.com/blog/1-5): 직접 D1 바인딩과 D1 batch 사용.
- [프로그램 방식 마이그레이션](https://better-auth.com/docs/concepts/database): Workers/D1의 getMigrations 지원.
- [이메일·암호 및 복구](https://better-auth.com/docs/authentication/email-password): 검증·재설정·기존 세션 회수 설정.
- [Cloudflare 이메일 로컬 개발](https://developers.cloudflare.com/email-service/local-development/sending/): remote를 쓰지 않는 로컬 이메일 모의 전달.

## 실행 결과

로컬 실행 `.vide/cloudflare-auth/9f3866b8-e52e-4367-955b-2e3c33cf2e46` 통과. 이메일 확인 전 로그인 거절·확인 후 로그인, 잘못된 암호/Origin 거절, 로그아웃, worker 재시작 후 세션 보존, 암호 재설정 후 기존 세션 회수와 복구 토큰 재사용 거절을 확인했다. 인증 스키마는 라이브러리의 compileMigrations로 생성했으며 실행 폴더의 auth-schema.sql로 보존한다. Workers 공식 타입 5.20260922.1로 strict 타입 검사도 통과했다.

기본 로그인 제한은 10초당 3건이며 전역 max 설정과 별도의 기본 규칙이었다. 시험에서 429와 X-Retry-After를 확인하고 기다린 뒤 후속 검증했다. 클라이언트 IP가 없으면 공유 버킷이 되는 경고를 확인해 Cloudflare 제공 cf-connecting-ip를 명시하고, 합성 IP 두 개가 별도 제한을 사용하는지 검증했다. 이는 로컬 프록시 모의 입력이며 실제 Cloudflare 가장자리의 헤더 처리 검수는 별도다.

메일은 send_email remote=false로 모의 전달했다. 실제 수신함, 운영 계정·발신 도메인·유료 요금제의 발송 가용성은 미확인이다. 원격 배포도 없다. 로컬 확인용 outbox/마이그레이션 경로는 loopback과 임시 키로 제한하고 제품 코드로 배포하지 않는다.

## 채택 판단과 재현

Better Auth 1.7.5 + D1 직접 어댑터를 T-009 로컬 제품 구현의 기반으로 채택할 근거가 생겼다. 이후 단계는 명시적 SQL 마이그레이션·사용자별 프로젝트 권한·게시본/의견 구현이다. 원격 발송/배포 확인 전에는 단계 2 완료나 PC 종료 후 외부 지속성을 통과로 표시하지 않는다.

재현: 저장소에서 `npm --prefix tools/spikes/2026-09-22-cloudflare-auth ci` 후 `npm --prefix tools/spikes/2026-09-22-cloudflare-auth run check`. 실험은 별도 `.vide` 실행 폴더와 포트를 사용하고 자신이 시작한 worker만 종료한다.
