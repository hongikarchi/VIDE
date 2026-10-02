---
id: PLAN-16
title: 프로젝트 연결 파일(Link)과 여러 파일의 한 공간
status: review
version: 1.0
updated: 2026-10-02
owner: agent:claude
related: [PLAN, SPEC-01, DESIGN, ARCH-01, ADR-030, FR-01, FR-02, FR-03, FR-16]
---

# 프로젝트 연결 파일(Link)과 여러 파일의 한 공간

2026-09-29 사용자 지적과 결정의 작업이다. 지적: 여러 파일을 한 작업 공간에 넣기 어렵고(화면은 결과 하나, 자동 Sync는 고른 문서 하나), 플러그인 연결→Sync→Live→VIDE에서 문서 선택→새로고침→가져오기의 흐름이 길고, 예전에 연결한 파일이 어디 있는지 보이지 않는다. 결정: 플러그인 Link에서 프로젝트를 고르고 연결+첫 Sync, VIDE는 연결 파일 목록·보이기 토글·강제 Sync, 기존 모델 연결 칸은 목록으로 대체, 모든 연결 파일은 주종 없이 한 공간에 표시. 동작은 [SPEC-01.11](../specs/SPEC-01-project-input-sync.md), 화면은 [Design §03](../../Design.md), 물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md) '프로젝트 연결 파일'.

## 변경

1. 엔진: 스키마 v4 `document_links`, 연결 경로 4개, Sync·Live Sync의 `linkId`, 플러그인 상태의 파일 경로.
2. 화면: 모델 연결 칸 → 연결 파일 목록(보이기·⟳·빼기), 연결 목록 폴링으로 첫 Sync와 Live Sync(파일별 보류), 레이어 합성 표시(ID 구분, 객체별 기준), 대상 파일 칩, 객체 목록의 파일별 묶음.
3. Rhino 플러그인: 패널 Link/Unlink·Live·Sync와 프로젝트 고르기 대화상자, `VIDELink` 명령(`VIDEConnect`는 같은 동작), 패널 VIDE 화면에 연결 프로젝트 전달.
4. ZWCAD 플러그인: 같은 구성(`VIDECADLink`).

## 검증

- 단위: 연결 등록·갱신(같은 경로)·숨김·빼기, 다른 프로젝트 격리, 스키마 v4(`tests/core/migrations.test.mjs`), 레이어 합성·ID 구분(`tests/core/layers.test.mjs`), 플러그인이 쓰는 HTTP 순서(실행 토큰 세션·Origin·프로젝트 목록·Link·숨김·빼기·다른 프로젝트 거절, `tests/server/links-http.test.mjs`). 통과.
- 브라우저(`tests/integration/browser-links.mjs`): 연결 파일 3개(Rhino 1·같은 핸들을 가진 DWG 2)의 목록, 함께 표시와 파일별 객체 트리, 숨기기 저장, 객체를 고르면 대상 파일 전환, 핀은 파일 자신의 ID·기준으로 저장, 다른 파일 객체는 참고 핀, 목록에서 빼도 Sync 기록 유지, 새로 Link된 열린 파일의 첫 Sync 자동. 기존 시험을 연결 파일 기준으로 바꿔 통과: 첫 Sync 실패 표시·초안 보호·원본 적용 요청·닫힘(`browser-attached-sync`), Live Sync 부분 갱신(`browser-live-sync`), 핀 토큰, Rhino 패널(첫 Sync 전 고정 → Sync 후 반영, 패널 Sync). 브라우저 시험 17개 통과.
- 플러그인: Rhino(net8)·ZWCAD(net48) 빌드 성공. 프로젝트 고르기 대화상자와 실제 창의 Link는 사용자 검수가 남았다.
- 실행하지 않은 시험: 실제 호스트가 필요한 `rhino-attached-ai`·`zwcad-attached`·`browser-owned-editor`·`browser-zwcad-editor`·`native-capture`는 연결 파일 기준으로 고쳤으나 이번에 실행하지 않았다. `native-source-edit`(옛 MCP 문서의 호스트 선택 첨부)는 연결 파일로 대체된 경로라 다시 써야 한다.

## 남은 것

- 두 파일에 걸친 변경 핀을 연계 요청으로 자동 전환, 다른 파일 객체를 수정 대상으로 쓰는 흐름.
- 확인 중 발견(2026-09-30, 미수정): 건축 파일(약 400MB, 1만 개)을 '파일에서 열기'로 열면 작업 사본 저장 뒤 다시 읽기 검증이 `Readback geometry mismatch`로 실패한다. 같은 모델의 작업 프로세스 내보내기는 부피가 음수인 Brep 때문에 형식 검사(`volume >= 0`)에서 거절된다. 플러그인 Link 경로는 영향이 없다.

## 2026-09-29 보완 (사용자 지적)

- 빈 목록 안내를 세 단계 카드로 바꿨다(프로젝트 이름 표시, 명령·파일에서 열기 안내).
- '파일에서 열기'로 연 파일을 목록의 '파일' 항목으로 넣었다(`DocumentLinks.fileLink`, 이름 기준, 이전 불러오기는 숨김으로 한 번). 빼면 불러오기 기록을 작업 이력에서 내려 다시 생기지 않는다. 플러그인 파일은 '연결 해제'로 표기했다.
- 빼기 버튼이 가리키기 전에는 투명해 없는 것처럼 보였다 → 늘 흐리게 보인다.
- 검증: `tests/server/file-links.test.mjs`(파일 항목·같은 이름·이전 불러오기 1회 숨김·빼기 유지), `browser-links.mjs`.

## 2026-09-30 빼기 = 지우기·연결 끊기 (사용자 결정)

사용자 지적: 빼기를 눌러도 목록과 화면에서만 사라지고 기록과 연결이 남는다. 결정: VIDE 안의 사본·기록을 지우고 플러그인 연결도 끊는다. 원본 파일과 호스트 창의 객체는 건드리지 않는다. 동작은 [SPEC-01.11](../specs/SPEC-01-project-input-sync.md) 9.

- **엔진:**
  - 빼기 경로가 그 파일의 기록(`input.linkId`가 같은 것, 파일 항목은 이름이 같은 옛 불러오기 포함)을 찾는다. 진행 중인 기록이 있으면 `PROJECT_BUSY`로 거절한다.
  - `Workspace.purge`가 기록을 지운다(`hidden_requests` 행 포함). 웹 게시(`publication_exports`)·공유 의견(`shared_feedback`)이 가리키는 기록은 지우지 않고 숨긴다.
  - 지운 기록의 `workerDirectory`와 불러오기 사본(`<id>.upload.<ext>`)을 지운다. 남은 기록이나 연결 파일이 그 안의 파일을 쓰면 남긴다. 파일 삭제 실패는 빼기를 막지 않는다.
- **패널:** 패널 화면이 연결 목록을 읽을 때, 패널 주소의 프로젝트에 자기 문서(instance·documentId)의 연결이 없으면 플러그인에 `unlink`를 요청한다. 플러그인의 기존 Unlink 동작을 쓰므로 플러그인은 다시 빌드하지 않는다.
- **화면:** 확인 창 문구를 새 동작에 맞춘다.
- **검증:**
  - `tests/server/file-links.test.mjs`: 빼기 뒤 기록이 없어지고, 게시가 가리키는 기록은 남는다. 진행 중이면 거절한다. 사본 파일이 지워진다.
  - `tests/server/links-http.test.mjs`: 플러그인 연결 파일의 Sync 기록이 지워진다.
  - `browser-links.mjs`의 "빼도 Sync 기록 유지"를 "빼면 기록 삭제"로 바꾼다.
  - 패널 자동 해제는 브라우저 시험의 패널 모드에서 `vide://unlink` 요청으로 확인한다.
- **결과(2026-09-30):**
  - 위 서버 시험과 `browser-links`·`browser-rhino-panel`을 통과했다. 전체 단위·서버 시험은 447개 중 446개가 통과했다. 실패한 1개는 부하 중의 속도 시험(`geometry-kit-layout`, 다른 작업)이고 단독 실행에서는 통과했다.
  - 빼기 뒤 작성기 초안에서 지운 기록을 가리키는 핀과 기준도 뺀다.

## 2026-09-30 같은 날 고친 사용자 지적

- **채팅 입력 지연:** 작업 보기의 '측정값' 펼침이 닫혀 있어도 객체마다 줄을 만들고 이름을 선형 탐색했다(1만 개 모델에서 약 5천만 번 비교). 키 입력마다 다시 그려져 한 번에 약 290ms 걸렸다. 펼쳤을 때만 그리고 이름은 Map으로 찾게 바꿨다(`src/ui/history.tsx`). 사용자 데이터 사본에서 키 입력당 약 16ms로 줄었다.
- **확대 한계:** 평면 보기의 최대 확대가 전체 맞춤의 20배로 고정되어 큰 모델에서 세부까지 가지 못했다. 투시 보기의 최소 거리도 모델 반경의 1%였다. 한계를 모델 크기에서 약 5cm 폭·2cm 거리까지로 바꾸고, 투영을 바꿔도 유지한다(`src/ui/viewport.ts`). 사본 화면에서 이전 한계를 넘어 확대되는 것을 확인했다.
- **치수의 긴 회색 선:** Rhino가 돌려주는 치수선 하나의 끝이 원점 근처로 떨어지는 경우가 있다. 건축 파일의 치수 78개 중 46개가 이렇다. 플러그인이 치수선을 치수의 경계 상자(1% 여유) 안으로 잘라 보낸다(`hosts/rhino/worker/DisplayParts.cs`). 저장된 Sync 자료에 같은 규칙을 적용하면 이상 치수는 0개이고 빠지는 선분은 없다. 플러그인은 빌드만 확인했다. 실제 Rhino 창의 확인은 배포 뒤 강제 Sync(⟳)로 한다.
- **왼쪽 강조 막대:** 선택 행·카드 제목의 코랄 막대를 없애고 배경으로만 표시한다(Design §01).
- **Live 파일이 열린 채로 페이지를 열면 멈춘 뒤 Out of Memory(설치본 0.2.12):**
  - 증상: 페이지를 열 때마다 약 37초 뒤 화면 프로세스가 죽었다. 크래시 기록 4건 모두 JS 힙이 가득 찬 경우였다.
  - 원인:
    - Rhino 파일이 Live로 연결돼 있으면, 다시 열린 페이지는 첫 연결 목록 폴링에서 따라잡기 Live Sync를 한다.
    - 목록 응답에는 표시 메시가 빠져 있어서(`sceneOmitted`) 뷰포트가 먼저 그 Sync의 전체 결과를 불러오기 시작한다.
    - `loadFullResult`는 같은 요청을 이미 불러오는 중이면 기다리지 않고 바로 돌아왔다. Live Sync는 메시가 아직 없으니 곧바로 자신을 다시 불렀다.
    - 이 반복은 마이크로태스크만으로 돌아서 불러오던 응답이 처리될 차례가 오지 않았다. 그 사이 Promise 사슬이 힙을 채웠다.
  - 수정(`src/ui/app.ts`):
    - 같은 요청의 전체 결과 불러오기는 하나만 진행하고, 두 번째 호출자는 그 작업을 기다린다.
    - Live Sync는 불러오기를 한 번 기다린 뒤에도 메시가 없으면 일반 Sync로 넘어간다.
  - 검증:
    - `browser-live-sync.mjs`에 "다시 열었을 때 메시를 불러오는 중" 단계를 더했다. 수정 전에는 페이지가 멈춰 실패했고, 수정 뒤 통과한다.
    - 실제 엔진과 실제 Rhino 연결에 수정 빌드를 붙인 진단 페이지는 수정 전 4초 만에 힙이 578MB까지 커졌다. 수정 뒤에는 50초 동안 15~24MB였고 Live Sync 2회가 끝났다.
    - `browser-links`, `browser-large-model`, `browser-composer-ready`, 타입 검사를 통과했다.

## 2026-10-01 고정(핀)이 사라지거나 늦게 뜨는 문제 (사용자 지적)

사용자 지적: 고정이 안 되거나, 입력창에 바로 안 뜨거나, 하나 고정한 뒤 다음 대상을 눌러도 고정이 안 된다. 합성 Rhino 문서를 쓴 브라우저 재현으로 원인을 확인했다. 고친 뒤의 동작 규칙(Rhino 선택 따라 보기·Rhino와 함께 쓰는 고정 묶음·`[고정N]` 토큰 보존)의 정본은 [SPEC-01.11의 4](../specs/SPEC-01-project-input-sync.md)이고, 아래는 원인과 변경·검증 기록이다.

- **입력창 토큰의 고정이 지워짐:** Rhino의 고정 목록이 바뀌거나(패널 첨부, 다른 창) 새 Sync가 들어오면 `applyHostPins`가 그 문서의 고정을 모두 Rhino 목록으로 바꿨다. 그래서 VIDE에서 만든 `[고정N · k개]` 토큰은 글자만 남고 대상이 사라졌다. 이제 Rhino 목록이 관리하던 고정(전과 지금 목록에 든 객체, 라벨 없음)만 바꾸고 VIDE에서 만든 고정은 둔다.
- **두 파일에서 선택이 1초 뒤 풀림:** Rhino 선택 번호와 고정 목록을 문서 구분 없이 하나로 기억해서, 다른 파일의 객체를 누르면 그 파일의 예전 Rhino 선택(빈 선택)이 덮어썼다. 이제 문서별로 기억하고, 따라가는 파일이 바뀌면 그 문서의 지금 선택부터 본다.
- **다른 Rhino 창의 선택이 VIDE에 안 옴:** VIDE 창은 보고 있는 파일 하나만 확인했다. 이제 연결된 모든 Rhino 문서의 선택 번호를 보고, 다른 창에서 고르면 그 파일을 따라가 선택을 보여 준다(SPEC-01.11 4).
- **Sync 전 객체를 고르면 VIDE 선택이 비워짐:** 마지막 Sync에 없는 객체만 고른 경우 VIDE 선택을 그대로 둔다.
- **패널 첨부가 최대 1.2초 늦음:** "Rhino 선택 N개 첨부"는 이제 누를 때 Rhino 선택을 다시 읽어 고정하고, 고정 직후 칩을 비운 뒤 바로 다시 확인한다.
- 남은 것(별도 결정): 입력창에 글을 쓰면 그 파일의 자동 Sync가 보류되어(SPEC-01.11 6), 그 사이 새로 만든 객체는 ⟳ 전까지 고정할 수 없다. 패널에는 입력창 고정 칩과 Rhino 첨부 칩이 함께 보인다.
- 검증: `browser-rhino-panel.mjs`에 "토큰 고정 뒤 Rhino 목록 변경" 단계를 더했다(이전 코드에서 실패, 수정 뒤 통과). `browser-host-panel`, `browser-pin-tokens`, `browser-links`, `browser-live-sync` 통과. 재현 스크립트(두 파일·패널·Sync 뒤)에서 토큰 유지, 다른 파일 클릭 뒤 선택 유지, 다른 Rhino 창 선택 반영을 확인했다.

## 2026-10-01 다른 이름으로 저장·숨긴 뒤 남는 객체 (사용자 지적)

사용자 지적: (1) "다른 이름으로 저장했을 때 VIDE에 바로 반영이 안 되고 꼬인다. link된 파일이 바로 변경이 안 된다." (2) "연결 파일을 다 숨겼는데도 객체가 남는 경우가 있다." 결정(2026-10-01, 추천대로): 연결은 창을 따라가고, 중복 항목은 하나만 연결 상태로 두며 기록은 합치지 않고, 어느 연결에도 속하지 않는 결과는 닫을 수 있는 '작업 결과 · <이름>' 행으로만 그린다. 동작은 [SPEC-01.11](../specs/SPEC-01-project-input-sync.md)의 1·4, 대조 규칙은 [ARCH-01](../architecture/ARCH-01-system.md) '프로젝트 연결 파일'.

<a id="t-095"></a>

### T-095 연결이 창을 따라감

- **원인:** 연결 행의 식별이 경로 우선이었다. 목록 경로가 열린 문서와 행을 경로로 먼저 맞춰서, 다른 이름으로 저장하면 같은 창(같은 `instance`·`documentId`)인데도 닫힘이 되고 자동 Sync·Live Sync가 멈췄다. `DocumentLinks.link()`는 경로로 행을 찾고 경로를 고치지 않아, 다시 Link하면 두 번째 행이 생겼다. 저장 안 된 문서를 처음 저장한 뒤 다시 Link하면 같은 창에 연결된 행이 둘이 되어 두 번 그려졌다. ZWCAD는 저장 전 도면도 경로 자리에 `Drawing1.dwg`를 보내 첫 저장에서도 같은 문제가 났다.
- **변경:**
  - `matchOpenDocuments`(`src/core/document-links.ts`): 같은 창의 행을 먼저(여럿이면 지금 경로와 같은 행, 다음은 최근 행), 창이 닫힌 행만 경로로 잇는다. 열린 문서 하나에 행 하나. 폴더 없는 경로는 경로 없음으로 본다.
  - `GET …/links`: 세션으로 이은 행의 이름·경로가 다르면 `DocumentLinks.follow`로 그 행에 쓴다(파일 항목 제외). 마지막 Sync는 빼기와 같은 `linkRequests`로 찾는다.
  - `DocumentLinks.link()`(플러그인 Link): 같은 순서로 기존 행을 찾고 경로도 갱신한다.
  - 검토 보완(2026-10-01): 경로로 이은 행도 `follow`로 그 창의 세션을 받아, 다시 연 파일(ZWCAD에서 Link 없이 Sync·Live Sync한 창 포함)을 다른 이름으로 저장해도 닫힘이 되지 않는다. 숨기기·보이기는 `updatedAt`을 바꾸지 않고, `follow`는 지금 연결 상태인 행을 같은 창의 다른 행보다 최근으로 유지해서, 중복 행 가운데 닫힘 행을 마지막에 숨기거나 예전에 다시 Link했더라도 다른 이름 저장 때 연결 행이 바뀌지 않는다.
  - Rhino 플러그인: 저장 중이나 저장 직후(2초)의 `DocumentPropertiesChanged`는 객체 전체를 바뀐 것으로 표시하지 않는다(다른 이름으로 저장 뒤 불필요한 전체 Live Sync 방지).
- **검증:** `tests/server/link-follow.test.mjs` — 다른 이름으로 저장 뒤 같은 행이 연결 상태로 새 이름·경로·이전 Sync를 유지, 다시 Link해도 행 하나, 저장 안 된 문서의 첫 저장, 기존 중복 행 중 하나만 연결 상태(다음 저장도 그 행만 따라감), 닫힌 행의 경로 재연결과 다른 창의 행을 빼앗지 않음, 파일 항목 불변, ZWCAD의 첫 저장·다른 이름 저장, 중복 행을 모두 숨긴(닫힘 행을 마지막에) 뒤 또는 닫힘 행이 더 최근일 때의 다른 이름 저장, 이전 세션의 행을 경로로 이은 ZWCAD 창의 다른 이름 저장(두 시험은 수정 전 코드에서 실패). 기존 `file-links`·`links-http`·`live-sync`·`offline-view`·`sync-coalesce` 통과. Rhino 플러그인은 빌드만 확인했다.
- **남은 것:** 실제 Rhino 8에서 다른 이름으로 저장 때 `DocumentPropertiesChanged`가 오는지와 패널 다시 읽기(패널 주소에 문서 이름이 들어 있음)는 설치본 반영 뒤 합성 문서로 확인한다. ZWCAD 실제 창의 다른 이름 저장도 같다.

<a id="t-096"></a>

### T-096 숨긴 뒤 남는 객체와 '작업 결과' 행

- **원인:** 페이지가 시작할 때 연결 목록을 읽기 전에 저장된 초안의 기준(지난번 화면의 Sync)이나 가장 최근 결과를 먼저 열었다. 그때는 연결이 비어 있어 그 Sync가 어느 파일에도 속하지 않는 결과로 잡혔고, 화면은 이 결과를 파일의 숨김과 상관없이 그렸다. 그래서 다시 연 뒤 모든 파일을 숨겨도 그 파일의 지난 Sync가 남았고, 같은 파일의 새 Sync가 오면 이전 Sync가 함께 그려졌다. 초안이 없는 첫 시작도 같았다. 화면의 파일 소속 판단은 `input.linkId`만 봐서, 엔진이 파일 항목의 것으로 보는 이전 불러오기도 따로 그렸다.
- **변경(`src/ui/app.ts`, `src/ui/links.tsx`):**
  - 시작할 때의 선택은 첫 연결 목록을 받은 뒤 적용하고, 첫 목록은 시작 직후 바로 읽는다.
  - 되살린 선택은 숨긴 파일을 다시 보이게 하지 않고(엔진에 보이기를 쓰지 않음), 파일 자신의 Sync면 그 파일의 최신 Sync로 보인다.
  - 따로 그리던 결과가 나중에 어떤 파일에 속하게 되면 그 파일 자리(후보 표시)로 옮기거나 버린다. 숨김은 바꾸지 않는다.
  - 파일 소속은 엔진과 같은 규칙(`belongsToLink`, `src/contracts/link-requests.ts`)으로 판단한다.
  - 어느 파일에도 속하지 않는 결과는 목록의 '작업 결과 · <이름>' 행과 닫기로 보인다(Design §03). 닫으면 다음 시작에도 다시 열리지 않는다.
- **검증:** `browser-links.mjs`에 두 시작 경로(초안 없음, 지난 Sync를 기준으로 가진 초안)를 더했다: 모든 파일 숨김 → 빈 화면, 다시 시작해도 빈 화면·숨김 유지·엔진에 보이기 요청 없음, 새 Sync가 이전 Sync와 겹쳐 그려지지 않음, 연결 전 Sync를 작업 이력에서 열면 '작업 결과' 행이 생기고 닫으면 빈 화면, 다음 시작에도 닫힌 채. 이전 코드에서는 이 단계가 실패한다. 조사 때의 재현 스크립트(초안 기준·새 Sync·연결 전 Sync·이전 불러오기)도 모두 빈 화면이 됐다. `npm run test:browser`의 나머지 시험도 통과했다. `browser-s06-jig`만 입력 조립 단계에서 시간 초과로 실패하는데, 연결 파일을 쓰지 않는 시험이고 수정 전 `main`(`b7b4d0e`)에서도 같은 단계에서 실패한다(이 PC의 구조 코어 DLL은 2026-09-29 빌드).

## 2026-10-02 모호한 Link의 선택·따라감 알림·정리와 문서 안의 연결 ID (사용자 결정)

사용자 결정: "sync 부분은 추천대로 갈게. 그리고 D5처럼 묶을 수 있게 연결 ID를 문서 안에 저장하는 거 좋은 것 같아." 추천 내용은 (1) 모호할 때만 Link에서 대체/새 항목을 묻기, (2) 자동 따라가기를 목록에 한 번 알리고 [새 항목으로 분리], (3) 중복 항목 [합치기]·기록 없는 항목 [빼기]이다. 결정 기록은 [ADR-030](../decisions/ADR-030-link-id-in-document.md), 동작은 [SPEC-01.11](../specs/SPEC-01-project-input-sync.md)의 1과 패널 문단, 물리 계약은 [ARCH-01](../architecture/ARCH-01-system.md) §7 「프로젝트 연결 파일(Link)」의 '문서 안의 연결 ID와 모호한 Link', 화면은 [Design](../../Design.md) §03 연결 파일 목록과 SCR-12 '이을 연결 고르기'. DB 스키마는 바꾸지 않는다.

<a id="t-107"></a>

### T-107 Link 선택·따라감 알림·합치기/빼기

- **변경:**
  - `src/core/document-links.ts`: `linkChoice`(물을지와 후보·기본값), `link`의 `replace`·`storedId` 순서와 같은 창 다른 행의 닫힘 표시(`closed:<uuid>`), 메모리 알림(`notice`·`note`·`dismiss`), `follow`의 `how`와 따라감 알림(첫 `from`·`previous` 유지), `split`, `merge`(요청 `input.linkId`·jig 읽기/만들기 `linkId` 이동).
  - `src/server/server.ts`: `POST …/links`의 `storedId`·`replace`·`ask`와 409 `LINK_CHOICE`(후보마다 Sync 수), `GET …/links`의 `notice`·`cleanup`, `POST …/links/:l/split·merge·dismiss`. `src/server/live-links.ts`는 `how`를 `follow`에 넘긴다.
  - 화면 `src/ui/links.tsx`·`app.ts`·`style.css`: 행 아래 한 줄 알림과 [새 항목으로 분리]·[확인]·[합치기](확인 창)·[빼기].
  - 플러그인(Rhino `EngineLink.cs`, ZWCAD `EngineLink.cs`): Link에 `ask: true`와 저장된 ID를 보내고 409 `LINK_CHOICE`면 선택 창(`LinkChoiceDialog`)을 띄워 답으로 다시 Link한다. 취소하면 이번에 만든 연결을 끊는다.
- **검증:** `tests/server/link-choice.test.mjs` — 닫힌 같은 경로 행이 있을 때만 묻고 기본은 그 행, 답(`replace`)으로 이어지고 기록 유지, 새 항목을 고르면 닫힌 행과 기록 그대로, 모호하지 않은 Link와 이전 플러그인(`ask` 없음)의 경로 재연결, 다른 이름 저장의 따라감 알림(두 번 저장해도 처음 이름)과 [분리](이전 행은 기록과 이전 이름으로 닫힘, 새 행은 창, 문서에 새 ID 쓰기), 다시 연 창의 경로 재연결 알림과 분리, 같은 창 중복 행의 [합치기](요청 이동, 실행 중이면 409)와 기록 없는 행의 '빼기' 제안. `tests/integration/browser-links.mjs`에 목록 알림·[새 항목으로 분리]·[합치기] 단계(엔진 답은 가짜)를 더했다. 기존 `link-follow.test.mjs` 통과.
- **남은 것:** 실제 Rhino·ZWCAD에서 선택 창의 모양과 취소 뒤 연결 상태 확인(설치본 반영 뒤 합성 문서).

<a id="t-108"></a>

### T-108 문서 안의 연결 ID

- **변경:**
  - Rhino `hosts/rhino/worker/LinkIdStore.cs`(문서 사용자 문자열 `VIDE`/`link:<projectId>`), `AttachedConnection.cs`: `attachedStatus`에 `linkIds`, 새 메서드 `setLinkId`. ZWCAD `hosts/zwcad/connection/LinkIdStore.cs`(명명 객체 사전 `VIDE_LINKS`), `AttachedDocument.cs`: 같은 두 가지. Link가 끝나면 플러그인이 ID를 쓰고, 처음 쓰면 명령줄에 "연결 ID를 문서에 저장했습니다. 저장하면 다음에도 이어집니다."를 붙인다.
  - 엔진: `hostDocumentsSchema`·Rhino `editor-channel.ts`·`editor-sessions.ts`·ZWCAD `attached-documents.ts`가 `linkIds`를 전하고 `setLinkId`를 부른다. `matchOpenDocuments`는 같은 창 → 저장된 ID → 경로 순이다. [새 항목으로 분리]는 그 창 문서에 새 ID를 쓴다(못 쓰면 화면이 알림).
- **검증:** `link-choice.test.mjs` — 이동·이름 바꾸기·재시작 뒤 저장된 ID가 같은 경로의 다른 닫힌 행보다 먼저 이어짐, 저장된 ID가 있으면 Link가 묻지 않음, 같은 ID의 사본이 두 창에 열리면 두 번째 창의 Link가 묻고(기본 새 항목) 두 행이 각자 연결됨, 대조 순서(같은 ID가 두 창이면 먼저 나온 창만), Rhino 편집기 채널로 `linkIds`가 오고 [분리]가 `setLinkId`를 부름. Rhino(`VIDE.Worker.csproj`)·ZWCAD(`VIDE.Zwcad.Connection.csproj`) 플러그인은 빌드만 확인했다.
- **남은 것:** 실제 Rhino 8·ZWCAD에서 ID 쓰기가 문서를 '수정됨'으로 만들고 저장·다른 이름 저장·다시 열기 뒤 유지되는지, `attachedStatus`의 `linkIds` 보고와 [분리] 뒤 다시 쓴 ID, 사본 두 창의 질문을 설치본 반영 뒤 합성 문서로 확인한다(에이전트는 사용자 문서와 호스트를 열지 않음).
