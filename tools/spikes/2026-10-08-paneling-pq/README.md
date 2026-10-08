# T-259 PQ 평면화와 곡면 펼침 실험 코드

기록: [SPIKE-2026-10-08-paneling-pq](../../../docs/tdd/SPIKE-2026-10-08-paneling-pq.md) · 계획: [PLAN-49](../../../docs/plans/PLAN-49-paneling.md) T-259

| 파일 | 역할 |
|---|---|
| `surfaces.mjs` | 90 × 60 m 합성 면 넷(맞춘 안장면·30° 돌린 안장면·물결면·비틀린 면)을 읽기 틀과 같은 꼴의 `SurfaceSample`(192 × 128)로. 법선·주곡률은 위치 함수의 유한 차분. |
| `pq.ts` | 전체 그물 평면 사각(PQ) 최적화 원형. 꼭짓점 키마다 점 하나, 국소(패널 최적 평면·면 위 최근점·이웃 평균) / 전역(꼭짓점마다 3×3 풀이, 과이완) 반복. `planes`·`points` 두 방식. 제품 코드가 아님. |
| `run-pq.mjs` | 면마다 1단계 격자 배치(1 m) → 제품의 패널별 최적 평면('best-fit', `optimizePanels`)을 기준으로 → `pq.ts`를 가까움 가중치 셋으로. 호스트 없음. |
| `unroll.cs` | 숨은 Rhino 8 워커 본문. 원통·원뿔(단곡)·구·쌍곡 포물면(복곡) 띠를 매개변수 칸(사각, 또는 대각선으로 자른 삼각)으로 나눠 `Unroller.PerformUnroll`하고 면적·모서리 길이·휨을 잰다. 문서에 아무것도 더하지 않음. |
| `run-unroll.mjs` | 에이전트가 띄운 숨은 Rhino 8 워커에서 `unroll.cs`를 조건별로 실행, 끝난 뒤 설치 엔진 커넥터 확인(Rhino가 꺼져 있고 `current`가 아니면 다시 설치). |
| `result-pq.json` · `result-unroll.json` | 2026-10-08 실행 결과. |

## 다시 돌리기

```sh
node tools/spikes/2026-10-08-paneling-pq/run-pq.mjs [--only aligned,wave] [--out result-pq.json]
VIDE_TEST_RHINO_PLUGIN=<빌드한 VIDE.Worker.rhp> node tools/spikes/2026-10-08-paneling-pq/run-unroll.mjs [--out result-unroll.json]
```

`run-unroll.mjs`는 Rhino 8이나 플러그인이 없으면 건너뛴다. 작업 파일은 `.vide/spikes/paneling-pq/<실행 시각>/`(Git 제외)에만 만들고, 사용자 Rhino에는 붙지 않으며, 스스로 띄운 워커만 끈다.
