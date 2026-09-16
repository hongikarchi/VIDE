# tools/docs — md → html 렌더러

MD가 원본이고 HTML은 생성물이다(AI.md §4). 이 폴더의 코드만 HTML을 만든다.

```
npm --prefix tools/docs install        # 최초 1회. git pre-commit 훅(.githooks)도 함께 활성화한다
npm --prefix tools/docs run build      # 모든 문서 + index.html 재생성
npm --prefix tools/docs run check      # 생성물이 오래됐으면 exit 1
npm --prefix tools/docs run watch      # MD 저장 때마다 재생성
```

자동 재생성 경로 세 가지:
- Claude Code가 `.md`를 Edit/Write 하면 `.claude/settings.json`의 PostToolUse 훅이 `hook-postedit.mjs`를 실행한다.
- `git commit` 때 `.githooks/pre-commit`이 재생성하고 바뀐 HTML을 커밋에 넣는다.
- 사람이 편집할 때는 `run watch`를 켜 둔다.

파일: `docs.config.json`(문서 목록·탭·설명·자동 탐색 폴더) · `theme.css`(기존 스타일 그대로) · `review.css`(첨삭 색상, AI.md §5) · `reader.js`(목차·검색·복사·원문 다운로드·가이드 메모 위젯) · `review.js`(첨삭 보기 전환, 목차 건수) · `partials/guide-workspace.html`(DEVELOPMENT_GUIDE §12의 개인 메모 위젯, localStorage 키 `drawing-ide-planning-notes` 유지).

새 문서는 `docs/specs/`, `docs/plans/`, `docs/tdd/`, `docs/decisions/`에 두면 자동으로 탐색되어 같은 폴더에 `.html`이 생긴다. 탭에 올리려면 `docs.config.json`의 `docs`에 추가한다.
