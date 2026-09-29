---
id: PLAN-20
title: 작업 PC가 꺼져 있을 때 — 저장된 모델 보기와 요청 대기
status: review
version: 0.1
updated: 2026-09-29
owner: agent:claude
related: [PLAN, PLAN-10, SPEC-04, ARCH-01, FR-18, FR-19]
---

# 작업 PC가 꺼져 있을 때 — 저장된 모델 보기와 요청 대기

2026-09-29 사용자 지시: "이미 링크가 걸린 cad나 라이노 파일에 대해서 그냥 보는 것도 안되는건가? … 작업 요청을 대기열에 걸어놓는거는 할 수 있지 않을까", "cloudflare 용량 문제만 없다면 구현해줘". 동작은 [SPEC-04.9](../specs/SPEC-04-web-review.md), 물리 계약은 [ARCH-01 계정 웹사이트와 작업 PC](../architecture/ARCH-01-system.md)가 소유한다.

## 용량 판단

<del>Cloudflare 무료 한도(R2 10 GB·쓰기 100만 회/월, Worker 요청 본문 100 MB, D1 5 GB) 안에 들도록 정했다.</del><ins>한도는 Cloudflare 무료 제공량(R2 10 GB·쓰기 100만 회/월, Worker 요청 본문 100 MB, D1 5 GB)을 기준으로 잡았다. 그러나 계정 R2는 이미 약 11.2 GB로 무료 제공량을 넘었으므로, 스냅샷을 켜면 올리는 바이트가 모두 과금되고 ADR-015의 무료 범위 조건과 부딪힌다([RESEARCH-10 §13.6](../research/RESEARCH-10-vide-restructure.md)). 그래서 과금 수용 결정(RESEARCH-10 §16 C3)이 승인 ADR로 기록되기 전까지 스냅샷은 꺼 둔다(2026-09-30, [T-066](PLAN-22-jig-platform.md#t-066)). 사이트 전체 한도 `SNAPSHOT_TOTAL_MB`의 기본값은 0(꺼짐)이고 아래 8,000 MB는 켤 때 환경값으로 정하는 예시다. staging은 `SNAPSHOTS_ENABLED=false`·`SNAPSHOT_TOTAL_MB=0`이며, 업로드 차단(`UPLOADS_ENABLED=false`)이 PC 스냅샷 쓰기에도 걸리고, 배포 점검은 결정 기록 없이 켠 설정을 막는다.</ins>

- 파일마다 저장본은 하나(교체)이고 이력을 쌓지 않는다. 파일당 10분에 한 번까지만 올려 R2 쓰기는 파일당 시간당 6회 이하다.
- 저장본은 원본이 아니라 병합한 형상이다. 18,000객체 합성 모델(Sync JSON 68.5 MB, [SPIKE render-perf](../tdd/SPIKE-2026-09-29-render-perf.md))도 float32·gzip으로 수 MB 수준이다. 한 파일 50 MB, 계정 500 MB, 사이트 전체 8,000 MB에서 막는다(환경값으로 조정).
- 요청 대기는 D1 행 하나(4000자)이고 프로젝트당 미전달 20개까지다.

## 변경

1. 사이트(`src/sharing`): `0007-offline-view.sql`, `offline.ts`(PC 저장·삭제·전달 확인, 소유자 조회·요청·취소), heartbeat 응답에 대기 요청, `/api/config`에 `snapshotsEnabled`.
2. 형식: `src/contracts/offline-snapshot.ts`(`vide-snapshot-v1` 부호화·복호화), `src/server/offline-snapshot.ts`(Sync 결과 → 레이어별 병합, 블록 배치, 해치 외곽, 문자, 화면 색).
3. PC: `src/server/offline-view.ts`(프로젝트별 켜기, 바뀐 Sync만 올리기, 끄면 사이트 저장본 삭제, 받은 요청함), `remote-access.ts`(저장본 올리기·지우기, heartbeat의 대기 요청 수신·전달 확인), `server.ts`(로컬 API와 연결).
4. VIDE 화면: 연결 파일 목록 아래 "PC가 꺼져도 사이트에서 보기"와 저장 상태, 목록 위 "사이트에서 남긴 요청"(작성기로·지우기).
5. 사이트 화면: PC가 꺼진 프로젝트를 누르면 저장된 모델(평면·3D, 레이어, 문자)과 요청 남기기·취소 화면. 카드 메뉴 "저장된 모델·요청 남기기".

## 검증

- 사이트(`tests/sharing/offline.mjs`, 로컬 workerd): 저장·교체, 소유자만 조회(다른 계정 404), 다른 PC 프로젝트 거절, 계정 한도 507, 요청 남기기·취소·다른 계정 거절, PC 한 번만 전달·전달 뒤 취소 409, 저장본 삭제. `--browser`: PC가 꺼진 프로젝트 열기 → 저장된 모델 표시, 요청 남기기·취소, 레이어 끄기.
- PC(`tests/server/offline-view.test.mjs`): 꺼져 있으면 올리지 않음, 켜면 올림, 같은 Sync 재전송 없음, 새 Sync는 10분 간격, 요청 한 번만 보관·지우기, 끄면 사이트 저장본 삭제, 재시작 뒤 설정 유지.
- VIDE 화면(`tests/integration/browser-offline.mjs`): 요청함 표시, 스위치 켜기와 저장 상태, "작성기로"가 작성기에 넣고 요청함에서 빠짐.

## 남은 일

- 배포: 원격 D1에 `0007` 적용과 Worker 배포는 사용자 확인 후 한다. 배포 전까지 PC의 저장은 사이트가 404로 거절해 저장 실패로 표시된다.
- 실제 PC 확인: 사용자 PC에서 켜기 → Sync → 다른 기기에서 PC 끈 채 보기·요청 → PC 켜서 받기.
- 저장본 형식은 [PLAN-18](PLAN-18-render-performance.md) 2단계(이진 전송)와 같은 방향이다. 그때 VIDE 화면도 같은 병합 형식을 읽게 할 수 있다.
