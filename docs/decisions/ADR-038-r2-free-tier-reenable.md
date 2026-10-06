---
id: ADR-038
title: R2 정리 뒤 무료 한도 안에서 업로드·스냅샷·진단 묶음을 다시 켠다 (C3 과금 없음)
status: approved
version: 0.1
updated: 2026-10-06
owner: user
related: [ADR-015, ADR-035, ADR-036, ADR-037, PLAN-20, PLAN-33, PLAN-34, RESEARCH-10]
---

# R2 정리 뒤 업로드·스냅샷을 다시 켠다

## 결정

2026-10-06 사용자 결정. 사용자가 Cloudflare 계정의 R2를 정리했다(계정 전체 약 12MB, VIDE 버킷 0B, 무료 한도 10GB). 에이전트는 "꺼 두었던 업로드·스냅샷·진단 묶음을 상한을 걸어 다시 켠다"를 추천했고, 사용자는 "추천대로 진행"이라고 답했다. 이 결정이 RESEARCH-10 §13.6의 **C3(R2 과금) 결정**을 대신한다. **과금은 수용하지 않고**, 무료 한도 안에서 상한으로 막는다.

1. 게시본 업로드(`UPLOADS_ENABLED`)를 다시 켠다.
2. PC 없이 보기의 모델 스냅샷(`SNAPSHOTS_ENABLED`)을 켜고, 전체 상한은 5GB로 둔다(`SNAPSHOT_TOTAL_MB=5000`).
3. 진단 묶음(`TELEMETRY_BUNDLES_ENABLED`)은 사용자가 [보내기]를 누를 때만 올라가게 켠다(ADR-036).
4. 나머지 약 4GB는 게시본과 여유분이다. 사용량이 8GB에 가까워지면 상한을 낮추거나 다시 결정한다.

## 맥락

R2 사용량이 무료 한도를 넘어(약 11.2GB) 업로드와 스냅샷을 꺼 두었고(PLAN-20), 배포 검사(`tools/checks/deployment.mjs`)는 C3 결정이 없으면 두 스위치를 켜지 못하게 막아 왔다. 정리 과정에서 VIDE 버킷의 예전 게시본 파일도 함께 지워졌다. 사이트에 남은 옛 게시본 링크는 파일이 없다고 나오며, 필요한 게시본은 다시 게시한다.

## 결과

- `wrangler.staging.jsonc`의 `SNAPSHOT_BILLING_DECISION`은 이 ADR을 가리킨다. 배포 검사는 승인된 C3 결정이 기록된 경우에만 업로드·스냅샷을 켠 설정을 받는다.
- 2026-10-06 배포(Worker 버전 98d2c7e4)가 이 설정으로 나갔다. 배포 검사 갱신은 그 뒤에 따라 했다.
