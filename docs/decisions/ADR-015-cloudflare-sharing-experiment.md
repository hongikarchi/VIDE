---
id: ADR-015
title: 공유 실험은 Cloudflare 단독으로 구성
status: approved
version: 0.2
updated: 2026-09-24
owner: user
related: [PLAN-02, SPEC-04, FR-19, OQ-04, OQ-09]
---

# 공유 실험은 Cloudflare 단독으로 구성

## 확정 범위

2026-09-21 사용자의 “이번 실험은 cloudflare 단독으로 구현하는걸로 해서 계획안을 확정” 지시에 따라 Static Assets/Workers+D1+비공개 R2, 호환 인증 라이브러리와 Cloudflare Email Service로 공유 실험을 구성한다. [PLAN-02 §5](../plans/PLAN-02-agent-host-versioning.md)가 구현 순서/검증 기준을, [SPEC-04](../specs/SPEC-04-web-review.md)가 공유 동작을 소유한다. 승인은 이번 실험의 공급자 선택이며 제품 전체 승인·구현 착수·유료 배포 예산 승인과 다르다.

## 후속 시험 조건

2026-09-22 후속 사용자 지시에 따라 현재 시험은 무료 범위로 제한한다. 도메인 구매·유료 전환·실제 메일 발송은 진행하지 않고, 메일 없는 가입과 소유자 승인 참여 방식으로 시험한다. 이메일 인증 상태는 미확인으로 유지하며 메일 인증·복구는 후속 조건 충족 뒤 연결한다. 최초 결정의 Email Service는 현재 가동 조건이 아니다. 현재 승인·업로드 제약과 진행 상태는 [PLAN §6.5](../plans/PLAN.md), 기능 동작은 [SPEC-04](../specs/SPEC-04-web-review.md)를 따른다. 무료 시험 조건은 제품의 전체 웹 범위를 축소하지 않는다.

## 선택 근거

공유 서버의 역할은 계정·프로젝트 권한·게시 파일·의견이며 CAD 실행은 로컬이다. OS 관리와 공급자 간 연결을 줄이고 큰 파일의 전송 비용을 예측하기 쉬운 구성을 선택했다. AWS 단독도 가능하지만 이번 실험에는 구현하지 않는다. 실제 성능 우위는 확인하지 않았다.

2026-09-21 비교에서 파일 100/500 GB 저장·월 1,000/5,000 GB 전송의 기본 소계는 Cloudflare $6.35/$12.35, AWS $29.50/$39.50였다. Cloudflare는 Workers $5+R2 max(GB−10,0)×$0.015, AWS는 Lightsail $12+CloudFront Pro $15+서울 S3 GB×$0.025다. AWS는 Pro의 전송/요청 범위 안을 가정하고 저장 크레딧을 차감하지 않았다. 요청·CPU·DB 포함량, 메일·백업·세금 등의 제외 조건은 PLAN-02 §5를 따른다. 예산 상한이나 실측 총 청구액이 아니다.

출처: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), [Lightsail](https://aws.amazon.com/lightsail/pricing/), [CloudFront](https://aws.amazon.com/cloudfront/pricing/), [서울 S3 지역별 단가](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-northeast-2/index.json).

## 재검토 조건

Workers/D1 인증·계정 복구·메일의 실제 지원을 먼저 확인한다. 제품 요구 충족이 불가능하거나 측정 비용/성능·복구가 운영 조건을 만족하지 못하면 근거와 함께 재검토한다. 계정/발신 도메인 미준비와 기술적 불가능을 구분한다. 다른 공급자를 임의로 섞거나 익명 공개 접근으로 바꾸지 않는다. OQ-04·09의 나머지 접근/보존·배포 조건은 이 결정으로 자동 해소되지 않는다.
