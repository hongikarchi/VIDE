# T-204 가능 영역·일조 사선 외피 기하 실험 코드

기록: [SPIKE-2026-10-07-envelope](../../../docs/tdd/SPIKE-2026-10-07-envelope.md)

| 파일 | 역할 |
|---|---|
| (옮김) `csg.ts`·`mesh.ts` | BSP 불리언·용접·점검·단면은 T-210에서 제품 코드 `src/jigs/official/geometry-kit/solid.ts`로 옮겼다. 이 폴더의 스크립트는 그 파일을 가져다 쓴다 |
| `rules.ts` | SPEC-12.8·12.9 규칙을 닫힌 솔리드로 만들기(후퇴 캡슐 기둥·가각·일조 벽과 사선 절두체·용도지역 마스크), 외피 파이프라인, 참값 높이 함수와 격자 적분 |
| `fixtures.ts` | 합성 대지 다섯 개(지어낸 좌표, 실제 필지 아님)와 손계산 값 |
| `run.ts` | 엔진 쪽 전체 실행: 정확도·점검·시간·측량 좌표 정밀도·음성 점검, `rhino-input.json` 작성 |
| `stress.ts` | 경계 변 수(8~64)에 따른 비용 증가, `rhino-input-stress.json` 작성 |
| `rhino.py` | 숨은 Rhino 8 안에서 엔진 면 목록 → Brep 결합·점검, 같은 피연산자의 Rhino 불리언, 뒤집힌 솔리드, 측량 좌표 배치 |
| `rhino-diag.py` | 규모 대조에서 실패한 외피를 결합 허용 오차·면 병합·메시로 나눠 원인을 찾는다 |
| `rhino.mjs` | 숨은 Rhino 8을 직접 띄우고(`launchOwnedHost`) `rhino.py`를 돌린 뒤 그 PID만 종료 |

## 다시 돌리기

```sh
node tools/spikes/2026-10-07-envelope/run.ts            # --quick: 격자 참값을 거칠게
node tools/spikes/2026-10-07-envelope/stress.ts
node tools/spikes/2026-10-07-envelope/rhino.mjs         # run.ts 뒤
node tools/spikes/2026-10-07-envelope/rhino.mjs stress  # stress.ts 뒤
VIDE_SPIKE_ONLY=star-8,star-16 node tools/spikes/2026-10-07-envelope/rhino.mjs stress diag
```

- Node 24 이상(`.ts` 직접 실행). 결과는 `.vide/spikes/envelope/`(Git 제외): `engine.json`, `rhino-result*.json`, `rhino-diag*.json`, `rhino-envelope*.3dm`. `rhino.mjs stress`의 star-64는 15분 제한에 걸려 PID가 종료된다(기록 참조).
- 사용자 원본은 열지 않는다. 사용자가 띄운 Rhino에는 붙지 않고 종료하지도 않는다.
