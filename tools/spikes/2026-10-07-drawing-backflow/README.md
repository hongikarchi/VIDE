# T-225 도면 역반영·도곽 실험 코드

기록: [SPIKE-2026-10-07-drawing-backflow](../../../docs/tdd/SPIKE-2026-10-07-drawing-backflow.md) · 계획: [PLAN-47](../../../docs/plans/PLAN-47-drawing-generator.md) T-225

| 파일 | 역할 |
|---|---|
| `BackflowProbe.cs` | ZWCAD 명령 `VIDEBACKFLOW`. 작업 목록(`fixture`·`dump`·`sweep`·`edit`·`xdataops`·`resolve`·`open`)을 사이드 DB로 실행하고 작업마다 JSON 한 줄을 쓴다. 쓰기는 언제나 없는 새 경로에만 한다. 현재 단계는 메모리 매핑 파일에 남겨 네이티브 충돌·멈춤 뒤에도 단계 이름이 남는다. |
| `build-probe.ps1` | probe를 `.vide/build/drawing-backflow/`에 빌드한다(ZWCAD 2023 참조, .NET Framework 4 `csc.exe`). |
| `run.mjs` | 숨은 ZWCAD를 `launchHiddenZwcad`로 띄워 작업을 돌린다. 충돌·멈춤(같은 단계 90초)이면 그 PID만 종료하고, 속성 읽기에서 난 것은 건너뛸 목록에 더해 남은 작업을 다시 돌린다. 결과 요약은 개수·참거짓만 담는다. |
| `ctb.mjs` | `.ctb` 읽기(헤더 + zlib 텍스트 표 → `PlotStyleTable` 모양)와 합성 CTB 2개 왕복 시험. |

## 다시 돌리기

```sh
powershell -ExecutionPolicy Bypass -File tools/spikes/2026-10-07-drawing-backflow/build-probe.ps1
node tools/spikes/2026-10-07-drawing-backflow/run.mjs synthetic                 # 합성 도면(2007·2013·2018)
node tools/spikes/2026-10-07-drawing-backflow/run.mjs real <사본 폴더> [read|write] # 실도면 사본
node tools/spikes/2026-10-07-drawing-backflow/ctb.mjs <file.ctb> ...             # CTB 요약
node tools/spikes/2026-10-07-drawing-backflow/ctb.mjs --synthetic <out-dir>       # 합성 CTB 왕복
```

- Node 24 이상(`.ts` import). 작업 파일은 모두 `.vide/spikes/drawing-backflow/`(Git 제외)에 생긴다.
- `real`은 **사본 폴더**만 받는다. 실도면 원본을 직접 넘기지 않는다. 루트 도면과 `XREF\` 폴더의 상대 구조를 그대로 복사해 둔다. 원본 폴더를 `VIDE_BF_ORIGINAL_FOLDER`로 주면 xref 해석에서 그 절대 경로를 사본으로 바꾼다(메모리 안에서만, 루트는 저장하지 않음). 다른 곳을 가리키는 절대 경로가 실제로 있으면 같은 이름의 사본으로 바꾼다.
- 실도면의 이름·레이어·블록·문자·속성 값은 `.vide/` 아래 덤프에만 남는다. 기록·커밋에는 개수와 참거짓만 옮긴다.
- 사용자가 띄운 ZWCAD·Rhino에는 붙지 않고 종료하지도 않는다.
- 읽지 않는 속성: `Dimension.TextStyleId`(SPIKE-2026-10-07-drawing-export에서 접근 위반). 이번 실험에서 찾은 위험 속성은 기록의 「ZWCAD 결함」 표에 있다.
