# 연결 ID가 없는 사본 만들기 (PLAN-51 T-286)

페르소나·L1 런에 쓰는 Rhino·CAD 사본에는 **다른 프로젝트의 연결 ID가 없어야 한다.** 라운드 2에서 `cad.dwg` 사본에 2026-10-06에 적힌 연결 ID가 남아 있었고, 그 사본을 `검증 루프 R1`에 연결하자 다른 프로젝트 `실사용 검증 20261007`의 Link `ab63a9e0`이 그 창을 따라가 경로가 r2 사본으로 바뀌었다. 그쪽 Sync는 129 s 뒤 `HOST_RESULT_UNKNOWN`으로 실패했다([VERIFY 라운드 2](../../docs/tdd/VERIFY-2026-10-09-loop-round-2.md) '방법상 한계', T-284).

## 연결 ID가 어디에 있나 (ADR-030)

| 호스트 | 위치 | 항목 |
|---|---|---|
| Rhino | 문서 사용자 문자열 `doc.Strings`, 구역 `VIDE` | `link:<프로젝트 ID>` = 연결 행 ID |
| ZWCAD | 명명 객체 사전의 `VIDE_LINKS` 사전 | 키 `<프로젝트 ID>`의 Xrecord(문자열 하나) = 연결 행 ID |

플러그인은 Link할 때 그 프로젝트의 항목 하나만 적는다. 문서가 연결되면(Link 대화창에서 프로젝트를 고른 뒤) 플러그인은 저장된 ID **전부**를 엔진에 보고하고(`linkIds`), 엔진은 어느 프로젝트의 연결 목록을 읽든 그 ID의 행을 이 창에 잇는다. 그래서 남은 ID 하나가 다른 프로젝트의 Link를 움직인다. 이 값은 파일 안에 있으므로 사본에도 그대로 따라간다.

## 확인하는 방법

- **`host-link.ps1`이 자동으로 확인한다.** 사본을 연 뒤, Link 대화창에서 프로젝트를 고르기 전에 Rhino는 `check.py`(문서 사용자 문자열), ZWCAD는 COM(`Dictionaries.Item('VIDE_LINKS')`)으로 항목을 읽는다. 대상 프로젝트가 아닌 항목이 있으면 아무것도 연결하지 않고 호스트를 저장 없이 닫고 거절한다(exit 2, `storedLinkEntries`). 이 단계에서는 문서가 아직 엔진에 연결되지 않았으므로 다른 프로젝트의 Link가 움직이지 않는다.
- **엔진 API로는 미리 확인할 수 없다.** `GET /api/v1/host/attached-documents`의 `linkIds`는 문서가 연결된 **뒤에만** 보이고, 그때는 이미 다른 프로젝트의 행이 따라갈 수 있다. 엔진에는 문서의 ID를 지우는 API도 없다(`setLinkId`는 [새 항목으로 분리] 때 새 ID를 적기만 한다).
- **파일 바이트 검색은 쓰지 않는다.** DWG는 압축 저장이라 `VIDE_LINKS`가 보이지 않을 수 있고, 3dm도 저장 형식을 이 도구가 보장하지 않는다.

## 연결 ID가 없는 원본에서 사본 만들기

1. 사본의 원본은 **VIDE로 연결한 뒤 저장한 적이 없는 파일**이어야 한다. 연결 뒤 저장한 파일, 그 파일의 사본, 런에 쓴 사본(`.vide/loop/r2/…`)은 원본으로 쓰지 않는다.
2. 런마다 새 폴더에 복사한다(예: `.vide/loop/r3/<런>/small.3dm`, CAD는 `XREF/` 폴더째). 이전 런의 `.rhl` 잠금 파일은 함께 복사하지 않는다.
3. `host-link.ps1`로 연결한다. `storedLinkEntries`가 비어 있으면 깨끗한 사본이다.

## 이미 ID가 든 사본에서 지우기

**무인(권장):** `host-link.ps1 … -StripLinkId`. 다른 프로젝트의 항목을 **열린 문서에서만** 지우고(Rhino `doc.Strings.Delete('VIDE', 'link:<id>')`, ZWCAD `VIDE_LINKS` 사전의 `Remove(<id>)`) 연결한다. 파일은 저장하지 않으므로 사본 파일에는 ID가 남는다. 다음 런에도 같은 사본을 쓰면 다시 `-StripLinkId`가 필요하다. 런마다 새 사본을 쓰는 것이 원칙이다.

**파일 자체를 깨끗하게(사람이 한 번):** 다른 VIDE 창이 없는 상태에서, VIDE에 연결하지 않고 사본을 연다.

- Rhino: `_-RunPythonScript`로 아래를 실행하고 저장한다.

  ```python
  import scriptcontext as sc
  for name in list(sc.doc.Strings.GetEntryNames('VIDE') or []):
      if name.startswith('link:'):
          sc.doc.Strings.Delete('VIDE', name)
  print(list(sc.doc.Strings.GetEntryNames('VIDE') or []))  # [] 이면 끝
  ```

- ZWCAD: 명령줄에 `(dictremove (namedobjdict) "VIDE_LINKS")`를 입력하고(결과가 `nil`이면 원래 없음) `QSAVE`.

지운 뒤 그 파일을 '연결 ID가 없는 원본'으로 두고, 런에는 그 원본의 사본만 쓴다. 사용자 원본 파일에는 이 절차를 하지 않는다(AI.md §8). 에이전트가 띄운 호스트에서 저장하면 샌드박스 때문에 실패할 수 있으므로, 파일 자체를 깨끗하게 하는 일은 사용자가 직접 띄운 호스트에서 한다.

## 이미 움직인 Link

라운드 2에서 바뀐 `실사용 검증 20261007`의 Link `ab63a9e0` 경로를 되돌릴지는 사용자가 정한다(T-284). 이 도구는 다른 프로젝트의 Link를 고치지 않는다. `host-link.ps1`은 연결 전후의 다른 프로젝트 Link 행을 비교해 바뀐 행을 `otherProjectLinksChanged`에 적고 exit 3으로 알릴 뿐이다.
