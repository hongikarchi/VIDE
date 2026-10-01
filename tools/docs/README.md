# tools/docs — md → html 렌더러

MD가 유일한 원본이고 HTML은 생성물이다(AI.md §4). 이 폴더의 코드만 HTML을 만든다. 생성물은 저장소 루트의 `human/` 한 폴더에 원본과 같은 상대 경로로 쌓이며(예: `docs/plans/PLAN.md` → `human/docs/plans/PLAN.html`, 문서 목록은 `human/index.html`) Git에는 넣지 않는다(`.gitignore`).

```
npm --prefix tools/docs install        # 최초 1회. git pre-commit 훅(.githooks)도 함께 활성화한다
npm --prefix tools/docs run build      # 모든 문서 + human/index.html 생성. 그 뒤 human/index.html을 브라우저로 연다
npm --prefix tools/docs run check      # 아무것도 쓰지 않고 렌더만 해 본다. 깨진 링크·front matter 오류가 있으면 exit 1
npm --prefix tools/docs run watch      # MD 저장 때마다 재생성
```

- 링크: MD 사이 링크는 `.html`로 바뀌어 `human/` 안에서 그대로 이어진다. `docs/assets/**`의 이미지·증거 파일은 `human/`에 함께 복사해 폴더 하나로 열람할 수 있다. 그 밖의 저장소 파일(예: `tools/spikes/**`)은 `human/`의 HTML 위치에서 저장소 원본을 가리키는 상대 경로로 바뀐다.
- 정리: 빌드는 더 이상 만들지 않는 `human/` 아래 파일(이름이 바뀌거나 지운 문서)을 지운다. `human/`에는 손으로 파일을 두지 않는다.
- 문서 목록의 'MD 수정일'은 front matter의 `updated:`, 없으면 그 파일의 마지막 커밋 날짜다(파일 mtime을 쓰지 않아 PC마다 같다).
- 검사(`--check`)가 보는 것: 경로처럼 보이는 상대 링크·이미지의 대상이 있는지, AI.md를 뺀 문서에 front matter(`id`·`title`·`status`, 허용된 status 값)가 있는지. 루트 `npm run docs:check`와 CI(`verify`)가 이 검사를 돈다.

자동 생성·검사 경로:
- Claude Code가 `.md`를 Edit/Write 하면 `.claude/settings.json`의 PostToolUse 훅이 `hook-postedit.mjs`로 `human/`을 다시 만든다.
- `git commit` 때 `.githooks/pre-commit`이 `--check`를 돌린다. HTML을 커밋에 넣지 않는다.
- 사람이 편집할 때는 `run watch`를 켜 둔다.

파일: `build.mjs`(렌더러) · `docs.config.json`(문서 목록·탭·설명·자동 탐색 폴더, 선택 `outDir` 기본 `human`) · `theme.css`(기존 스타일 그대로) · `review.css`(첨삭 색상, AI.md §5) · `reader.js`(목차·검색·복사·원문 다운로드) · `review.js`(첨삭 보기 전환·검토자 필터·목차 건수) · `hook-postedit.mjs`(Claude Code 훅).

새 문서는 `docs/specs/`, `docs/plans/`, `docs/tdd/`, `docs/decisions/` 등 `docs.config.json`의 탐색 폴더에 두면 자동으로 `human/`의 같은 경로에 `.html`이 생긴다. 탭에 올리려면 `docs.config.json`의 `docs`에 추가한다.

검토 화면은 MD의 작성자 라벨을 기준으로 건수·부록 링크를 구분한다. Claude는 파란 상자, Codex는 보라 상자이며 검토자 필터로 코멘트·부록을 골라 볼 수 있다. R-NN은 문서 안에서 고유하게 부여하고 다른 의견은 `#review-R-NN`으로 참조한다. 원문만/인라인 제안 미리보기는 표시 모드일 뿐 MD 수락·수정·승인을 하지 않는다. 인라인 미리보기는 기존 `ins`/`del`만 적용한 모습이며 코멘트에 적힌 대안을 자동 병합하지 않는다.
