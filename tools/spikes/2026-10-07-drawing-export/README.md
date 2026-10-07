# T-199 도면 내보내기 실험 코드

기록: [SPIKE-2026-10-07-drawing-export](../../../docs/tdd/SPIKE-2026-10-07-drawing-export.md)

| 파일 | 역할 |
|---|---|
| `build-model.py` | 숨은 Rhino 8 안에서 합성 모델(레이어·치수·문자·블록·링크 블록·해치·레이아웃 2개)을 만들고 3dm 저장 뒤 체계별로 `_-SaveAs`(DWG)와 `_SelAll _-Export`를 실행한다. |
| `DrawingExportProbe.cs` | ZWCAD 명령 `VIDEDRAWINGPROBE`. DWG를 사이드 DB로 읽어 레이어·선종류·문자/치수 스타일·블록(xref)·레이아웃/뷰포트·개체를 JSON 한 줄씩 쓴다. 대조용 `control-zwcad.dwg`도 ZWCAD로 직접 만든다. |
| `build-probe.ps1` | probe를 `.vide/build/drawing-export/`에 빌드한다(ZWCAD 2023 참조). |
| `dismiss-crash-prompt.ps1` | 이전 비정상 종료 뒤 ZWCAD가 띄우는 "진단 정보 전송?" 창에서 [아니오]를 누른다. 실험이 띄운 PID에만 쓴다. |
| `run.mjs` | 숨은 Rhino → 숨은 ZWCAD 순서로 실행하고, 띄운 프로세스만 PID로 종료한다. |

## 다시 돌리기

```sh
powershell -ExecutionPolicy Bypass -File tools/spikes/2026-10-07-drawing-export/build-probe.ps1
node tools/spikes/2026-10-07-drawing-export/run.mjs all     # rhino | zwcad | all
```

- Node 24 이상(`.ts` import). 결과는 `.vide/spikes/drawing-export/`(Git 제외): `rhino-summary.json`, `rhino-log.txt`(명령 기록), `export-*.dwg`, `probe.jsonl`, `probe.jsonl.trace`.
- 체계는 `VIDE_SPIKE_SCHEMES="2018 Lines|2018 Natural|2018 Solids|Default"`로 바꾼다. Rhino 8 기본 체계: Default, R12 Natural, 2007/2010/2013/2018 × Lines/Natural/Solids.
- 사용자 원본은 열지 않는다. 사용자가 띄운 Rhino·ZWCAD에는 붙지 않고 종료하지도 않는다.
- ZWCAD 2023에서 Rhino가 쓴 치수의 `Dimension.TextStyleId`를 읽으면 ZwDatabase.dll 접근 위반으로 ZWCAD가 죽는다. probe는 이 속성을 읽지 않는다.
