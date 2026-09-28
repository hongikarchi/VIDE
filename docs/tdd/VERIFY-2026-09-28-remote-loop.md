---
id: VERIFY-2026-09-28-remote-loop
title: 원격 기기에서 작업 PC 열기 검증
status: review
version: 0.1
updated: 2026-09-28
owner: agent:claude
related: [PLAN-09, ARCH-01, T-009, T-010]
---

# 원격 기기에서 작업 PC 열기 검증

[PLAN-09](../plans/PLAN-09-remote-host.md)의 결과다. 적용할 AC가 아직 없는 원격 실행 흐름이어서 PLAN-09의 목표 문단을 기준으로 삼는다.

## 환경

- 공유 Worker: staging(`vide-sharing-staging.archivibe.workers.dev`), D1 마이그레이션 `0005-remote-hosts.sql` 원격 적용, 배포 버전 `d6f55901`. 무료·메일 없는 소유자 승인 모드와 업로드 중지 정책은 그대로다(`npm run deployment:check`).
- 터널: 공식 cloudflared 2026.9.3(Cloudflare, Inc. 서명 확인) `%LOCALAPPDATA%\VIDE\bin\cloudflared.exe`, 계정 없는 임시 터널.
- 원격 기기: Chromium의 iPad Pro 11 가로 에뮬레이션(터치). 실제 iPad·Safari는 아니다.
- PC 쪽은 격리된 시험 서버와 합성 staging 계정(example.com)을 썼고, AI 응답은 모의다. 사용자 작업 공간은 공개하지 않았다.

## 결과 (`tests/integration/remote-loop.mjs`)

| 단계 | 결과 |
|---|---|
| 원격 접속 켜기(터널 등록·응답 확인 후 목록에 켜짐) | 11.3초 |
| 공유 사이트 목록 → 열기 → 작업 공간 준비 | 2.7초 |
| 실제 크기 모델(표시 10,086개) 화면 표시 | 9.2초, 전송 23.5 MB(원본 81 MB, gzip) |
| 터치 스케치 → 입력에 첨부 → 요청 전송 → PC 수신 | 1.8초, 스케치 포함 확인 |
| 원격 접속 끄기 → 목록 꺼짐 | 확인 |

원자료: `.vide/remote-loop/b27d2a9a…/result.json`, 화면 `ipad-hosts.png`·`ipad-model.png`·`ipad-sent.png`. 시행착오로 두 가지를 고쳤다. 첫째, 터널 주소가 연결 등록보다 먼저 출력되어 이름 해석이 실패하는 경우가 있었다. 이제는 등록과 실제 응답을 확인한 뒤에 목록에 켜짐으로 알린다. 둘째, 공유 사이트에서 넘어오는 첫 화면 이동이 교차 사이트 요청 차단에 걸렸다. 원격의 GET 화면 이동만 허용하고 API는 계속 막는다.

## 자동 시험

- `tests/sharing/hosts.mjs`: 페어링 1회성, 임시 터널 주소 외 거절, 다른 계정 거절, Worker 서명 토큰의 PC 측 검증과 재사용·변조 거절, 끄면 꺼짐.
- `tests/server/remote-http.test.mjs`: 로그인 전·만료·재사용 토큰 거절, 로컬 쿠키로 원격 불가, 종료·원격 제어·AI 설정·계정·MCP 403, 원격 gzip, 끄면 세션 종료.

## 한계

- 실제 iPad(Safari, Apple Pencil)와 실제 Rhino 문서의 원격 AI 수정은 확인하지 않았다.
- CAD 연결 도면의 AI 수정은 지원하지 않는다(PLAN-07).
- 임시 터널은 켤 때마다 주소가 바뀌고 가용성 보장이 없다.
