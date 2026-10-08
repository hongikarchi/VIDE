# T-250 패널링 면 계산 경로 실험 코드

기록: [SPIKE-2026-10-08-paneling](../../../docs/tdd/SPIKE-2026-10-08-paneling.md) · 계획: [PLAN-49](../../../docs/plans/PLAN-49-paneling.md) T-250

| 파일 | 역할 |
|---|---|
| `surfaces.cs` | 숨은 Rhino 8 워커가 만드는 합성 면 일곱 개(쌍곡 포물면 트림 구멍, 원통 띠, 닫힌 원통, 구 띠, 평면, 작은 트림 면, 메쉬). 단위 m. |
| `read-surface-grid.cs` | 읽기 틀 원형 `vide.read.surface-grid@1`. 격자 표본(점·법선·주곡률·트림 안·트림 고리·이음매·극점·지문), 탐침 점(보간 오차), 지문만. 결과는 JSON 수 배열 또는 base64 float64. |
| `make-panels-uv.cs` | 만들기 틀 원형 `vide.bake.panels-uv@1`. 패널 UV 다각형 → 원래 면에서 잘라낸 열린 면 또는 `CreateOffsetBrep` 닫힌 부재. 지문 확인, 이음매 넘는 UV(`Brep.ChangeSeam`), 트림 밖 실패, 시간 한도. |
| `face-hash.cs` | 두 틀이 똑같이 끼워 넣는 지문 함수(`//@include face-hash.cs` 자리). |
| `run.mjs` | 전체 측정: 문서 만들기 → 숨은 연결 Rhino에서 (a) 읽기·보간 오차·되돌리기·지문·실패·만들기·이음매·`mesh@1` → (c) GH lite → (b) 숨은 워커 읽기 → 설치 엔진 커넥터 확인. |
| `connectors.mjs` | 설치 엔진의 `GET /api/v1/connectors`(launch.json 세션, 토큰은 출력하지 않음), `--install`이면 Rhino가 꺼져 있을 때 다시 설치. |
| `result.json` | 2026-10-08 실행 결과(경로는 상대·`<checkout>`으로 바꿈). |

## 다시 돌리기

```sh
VIDE_TEST_RHINO_PLUGIN=<빌드한 VIDE.Worker.rhp> node tools/spikes/2026-10-08-paneling/run.mjs
SPIKE_SKIP=reads,interp,undo,fingerprint,failures,make,solids5000,mesh,gh,worker   # 일부 건너뛰기
node tools/spikes/2026-10-08-paneling/connectors.mjs [--install]
```

Rhino 8이나 플러그인이 없으면 건너뛴다. 작업 파일은 `.vide/spikes/paneling/<실행 시각>/`(Git 제외)에만 만들고, 사용자 Rhino에는 붙지 않으며, 스스로 띄운 Rhino만 끈다.
