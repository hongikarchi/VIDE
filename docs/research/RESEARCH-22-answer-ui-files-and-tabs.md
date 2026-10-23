---
id: RESEARCH-22
title: 답변 UI · 글꼴 · 파일 보기 · 가운데 탭과 분할
status: draft
version: 0.1
updated: 2026-10-23
owner: agent:claude
related: [RESEARCH-18, RESEARCH-20, RESEARCH-21, SCR-15]
---

# RESEARCH-22 — 답변 UI · 글꼴 · 파일 보기 · 가운데 탭과 분할

VIDE Next 목업 9판(2026-10-23)의 조사 사실이다. 사용자 9차 메모의 질문(답변 UI 가독성, Pretendard, 자료 파일 보기, 가운데 탭 분할)에 답할 근거를 모은다. 방향은 [RESEARCH-18](RESEARCH-18-environment-not-model.md), 셸은 [RESEARCH-20](RESEARCH-20-shell.md), 세션 모형은 [RESEARCH-21](RESEARCH-21-first-run-and-sessions.md)이 소유하며 여기서는 다시 쓰지 않는다. 목업은 [브리프 9판](../briefs/2026-10-19-storyboard-vide-next.html)에 있다. 실측은 Playwright(msedge) `getComputedStyle`·로컬 설치 파일 CSS·fontTools이고, 1차 출처가 없으면 "추정", 사실이 없으면 "문서 없음"으로 적는다.

## 1. 답변 UI 레퍼런스

로그인 화면(Claude.ai·ChatGPT·Cursor·Notion·Linear·Raycast)은 공식 문서로 대신했다. ChatGPT 공개 페이지는 Cloudflare 확인 화면에서 막혔다.

| 도구 | 본문·단계 표시 | 행동·결과 | 근거 |
|---|---|---|---|
| Claude.ai | 문서 없음(로그인) | 검색 중 표시 + 인용·출처 링크 | 도움말 |
| ChatGPT | 문서 없음 · 열 약 48rem(추정) | 문서 없음 | Cloudflare 차단 |
| Perplexity | 16px/1.625 · 열 720px | 답 아래 공유·복사·다시 한 줄 | 실측 [discover](https://www.perplexity.ai/discover) |
| Perplexity Pro Search | 단계 계획, 기본 접힘·클릭 펼침 | 출처 카드 4열·인용 칩 | 공식 블로그 |
| Claude Code VS Code | 13px · 타임라인 점 7px·세로선 1px | 답 아래 20×20 아이콘, hover 배경 | 실측 index.css 2.1.307 |
| Claude Code 도구 행 | 이름 굵게 + 인자 mono .85em | 펼침 상자 .5px r5 | 실측 .toolSummary |
| Cursor | `Explored N tools` 묶음 접힘 | 이전 요청 hover → 체크포인트 복원 | 공식 문서 |
| Linear Agents | thought·action·response·error | action = action·parameter·result | 개발 문서 |
| Notion AI | 문서 없음 | Replace·Insert below·Try again | 도움말 |
| Raycast AI | 문서 없음 | hover 편집·⌘R 재생성 | 매뉴얼 |
| VIDE 8판 | 13px/1.55 · body gap 8 | .acts 11.5px, 시각 오른쪽 | `app.css` @93427262 :466-479 |

변형 3개는 같은 대화(10-threads `구조 협의 미답`)를 다른 축으로 그렸다. 공통 제약은 토큰 색만, 그림자·왼쪽 색 막대·둥근 말풍선 없음, Pretendard다.

| 변형 | 가져온 축 | 파일 |
|---|---|---|
| A | 넓은 행간 14px/1.7·글줄 33em(값은 추정, Claude.ai 수치는 문서 없음)·단계 한 줄 칩 접힘 | [A](../briefs/assets/vide-next/variants/A.html) |
| B | Perplexity식 단계 타임라인 + 번호 결과 카드 | [B](../briefs/assets/vide-next/variants/B.html) |
| C | Cursor/Claude Code식 촘촘한 도구 행 + 파일 칩 | [C](../briefs/assets/vide-next/variants/C.html) |

심사 3명이 4축(가독성·직관·예쁨·토큰 일관성) 1–5점을 매겼다.

| 변형 | 심사 1 | 심사 2 | 심사 3 | 합계 | 요지 |
|---|---|---|---|---|---|
| B | 4/5/5/4 | 4/5/4/4 | 4/4/5/5 | 53 | 한 일·결과가 한눈에, 검정 단추 튐 |
| A | 5/3/4/5 | 5/2/4/5 | 5/3/4/4 | 49 | 가장 잘 읽힘, 단계가 칩에 숨음 |
| C | 3/4/3/4 | 3/4/3/3 | 3/5/3/3 | 41 | 인자 정확, 칩 많아 시선 흩어짐 |

1등은 B다. 공통 지적: A는 기본 상태에서 AI가 한 일이 숨고, C는 회색 칩이 본문 흐름을 끊는다.

출처: https://www.perplexity.ai/discover (실측) · https://www.perplexity.ai/hub/blog/pro-search-upgraded-for-more-advanced-problem-solving · https://www.langchain.com/breakoutagents/perplexity · https://cursor.com/docs/agent/chat/checkpoints · https://cursor.com/changelog/3-4 · https://linear.app/developers/agent-interaction · https://manual.raycast.com/ai/ai-chat · https://www.notion.com/help/guides/notion-ai-for-docs · https://support.claude.com/en/articles/10684626-enable-and-use-web-search · https://collectui.com/designs/ai-ui-design-inspiration

## 2. 글꼴 — Pretendard

판정: HTML에서 된다. Google Fonts에는 없고 jsDelivr·cdnjs CDN `<link>` 한 줄로 쓴다. 제품에는 woff2를 동봉한다.

| 항목 | Pretendard | IBM Plex Sans + KR |
|---|---|---|
| 버전 | 1.3.9 (2023-11-05) | Sans KR 1.003 |
| 라이선스 | SIL OFL 1.1, 단독 판매만 금지 | SIL OFL 1.1 |
| 구성 | 한글+라틴 한 파일 | 두 패밀리 이어 붙임 |
| 굵기 | 9단계 + 가변 wght(글꼴 fvar 45–930 실측 · 배포 CSS 선언 `45 920`) | KR 7단계, 가변 없음 |
| x높이/em | 0.530 | 0.516 |
| 한글 '가' 폭/em | 0.864 | 0.892 |
| 숫자 기본 | 가변폭 → tabular-nums 필요 | 고정폭 |
| 가변 전체 woff2 | 2,057,688 B | — |
| 정적 Regular woff2 | 765,892 B | KR Regular 438,540 B |
| 가변 서브셋 | CSS 53,513 B · 조각 92개 33–38 KB | — |

목업 경로: `https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css`, 글꼴 이름 `"Pretendard Variable"`.

권장 크기: Pretendard 공식 권장 크기·행간·자간은 문서 없음. 제작자 블로그는 한글을 원본보다 2% 가늘게 조정했다고 적는다. KRDS(GOV 판)는 본문 17px·행간 150%다. 목업의 UI 13px · 대화 본문 14px · 행간 1.6은 관행이며 추정이다.

제품 동봉: `PretendardVariable.woff2` 한 파일과 OFL 전문을 앱 리소스에 넣고 `@font-face`(`font-weight:45 920`, 배포 CSS와 같은 값 — 축 끝 930은 쓰지 않음)로 직접 선언한다. WebView2 가상 호스트 매핑이나 로컬 엔진 서버로 받으므로 네트워크가 필요 없다. 이름을 바꾸지 않고 그대로 동봉하면 OFL 조건은 전문 동봉뿐이다.

인상 비교(추정): Pretendard는 한글 획이 고르고 밝으며, Plex KR은 한글이 넓고 각져 13px에서 성기게 보인다.

출처: https://github.com/orioncactus/pretendard/blob/main/packages/pretendard/README.md · https://github.com/orioncactus/pretendard/releases/latest · https://cactus.tistory.com/306 · https://www.krds.go.kr/html/site/style/style_03.html · https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/LICENSE.txt · https://scripts.sil.org/OFL · https://learn.microsoft.com/microsoft-edge/webview2/concepts/working-with-local-content

## 3. 파일 보기

셸이 WebView2(Edge 엔진)이면 이미지·HTML·PDF는 라이브러리 없이 보인다(셸 선택은 [RESEARCH-20](RESEARCH-20-shell.md)).

| 형식 | 첫 후보 | 라이선스 | 충실도 | 크기 | 대안 | 지금 코드 |
|---|---|---|---|---|---|---|
| png·jpg·webp·svg | WebView2 `<img>` | 셸 런타임 | 원본 그대로 | 0 | — | 읽지 않음 |
| HTML | WebView2 iframe(sandbox) | 셸 런타임 | 원본 그대로 | 0 | 외부 브라우저 | 읽지 않음 |
| PDF | WebView2 내장 뷰어 | 셸 런타임 | 쪽·표·그림 그대로 | 0 | pdf.js canvas(Apache-2.0, 34.9 MB) | 텍스트 층만 |
| DOCX | docx-preview | Apache-2.0 | 표·그림 있음, 쪽 나눔 수동만 | 1.0 MB | mammoth(BSD-2, 서식 버림) · LibreOffice→PDF | 본문·주석 텍스트 |
| XLSX | SheetJS CE 값 표 | Apache-2.0 | 값·병합, 셀 서식 없음(Pro만) | 7.5 MB | exceljs(MIT, 21.8 MB) + 자체 격자 | 셀 값만 |
| HWP 5.x | @rhwp/core WASM | MIT | 표·그림·수식·다단 있음 | 12.5 MB | 한컴 뷰어(외부) | 본문 문단 텍스트 |
| HWPX | @rhwp/core WASM | MIT | 위와 같음 | 12.5 MB | XML 직접 → HTML(셀 텍스트 수준, 추정) | section 텍스트 |
| DWG | 외부 CAD | — | 원본 그대로 | 설치형 | PDF/SVG 변환 뒤 보기 | ZWCAD 숨김 실행 텍스트 |
| 3DM | rhino3dm + three | MIT · MIT | Brep·Mesh·SubD·곡선·점 | 6.7 MB + three | Rhino(외부) | 렌더 없음 |

크기 = npm `dist.unpackedSize`(풀린 패키지, 번들 크기 아님). 오피스·HWP의 첫 후보는 파일을 다른 형식으로 바꾸는 변환이 아니라 라이브러리 렌더다. LibreOffice 변환은 DOCX·XLSX의 대안일 뿐 HWP 5.x에는 쓸 수 없다.

피할 것: hwp.js(2020 이후 판 없음) · handsontable(상용) · libredwg-web(GPL-3.0) · LibreOffice로 HWP 5.x(97 필터만, 불가).

지금 코드의 텍스트 추출(RAG용, 렌더 없음):

| 파일 | 사실 |
|---|---|
| `package.json` | `pdfjs-dist 5.7.284`, `three 0.186.0` |
| `src/knowledge/collect/pdf.ts` | `getTextContent()`만, 렌더·글꼴 없음 |
| `src/knowledge/collect/documents.ts` | DOCX·XLSX·HWPX zip 발췌, 이미지·HTML 없음 |
| `src/knowledge/collect/documents.ts` | 스캔 PDF = `no-text`(OCR 없음) |
| `src/knowledge/collect/hwp.ts` | PARA_TEXT만, 암호·배포용 제외 |
| `src/knowledge/collect/dwg.ts` | ZWCAD 숨김 실행으로 텍스트만 |

추출은 그대로 두고 보기는 별도 층으로 얹는다(추정: 같은 파일 경로를 공유).

VS Code 기준: 이미지·오디오·비디오·Markdown은 기본 미리보기, HTML은 코드로만, PDF·오피스·HWP는 확장(vscode-pdf·Office Viewer·rhwp)으로 본다.

출처: https://github.com/mozilla/pdf.js · https://github.com/VolodymyrBaydalka/docxjs · https://docs.sheetjs.com/docs/api/utilities/html · https://github.com/edwardkim/rhwp · https://github.com/hahnlee/hwp.js · https://help.libreoffice.org/latest/en-US/text/shared/guide/convertfilters.html · https://github.com/mcneel/rhino3dm · https://github.com/mlightcad/libredwg-web · https://github.com/microsoft/vscode/commit/e7d9908a81db2f0b8f967c28eb2e236d71156aac · https://marketplace.visualstudio.com/items?itemName=tomoki1207.pdf · https://marketplace.visualstudio.com/items?itemName=cweijan.vscode-office

## 4. 가운데 탭과 분할

| 항목 | VS Code | JetBrains | Chrome |
|---|---|---|---|
| 미리보기 탭 | 이탤릭, 한 번 클릭 재사용 | 이탤릭, 다음 선택이 덮어씀 | — |
| 고정 전환 | 더블클릭·편집 | 편집·고정 | — |
| 분할 | 4방향, 그룹 수 제한 없음 | Split Right/Down | 정확히 2개 |
| 끌어 놓기 | 가장자리 = 새 그룹, 가운데 = 합침 | 탭 끌기 | 가장자리 끌기 |
| 단축키 | `Ctrl+\` 분할 | 문서 없음 | Shift+Alt+N |
| 탭 상한 | 기본 꺼짐, 값 10, 오래 안 쓴 탭 닫음 | 기본 10 | — |
| 상한 제외 | 미저장 | 고정 | — |

VS Code 탭 우클릭 묶음: 닫기 · 다른 탭 닫기 · 오른쪽 탭 닫기 · 저장된 탭 닫기 · 모두 닫기 / 열어 두기 · 고정 / 오른쪽 분할 · 아래 분할. Cursor·Kiro는 Code OSS 기반이라 같은 규칙을 상속한다(추정). Figma 데스크톱의 분할은 문서 없음.

| 라이브러리 | 라이선스 | 최신 | 프레임워크 |
|---|---|---|---|
| dockview | MIT(Enterprise 별도) | 8.6.1 · 2026-10-19 | 순수 JS + React·Vue·Angular |
| rc-dock | Apache-2.0 | 4.1.0 · 2026-09-30 | React ≥18 |
| golden-layout | MIT | 2.6.0 · 2022-09-26 | 순수 JS |
| flexlayout-react | MIT | 0.11.1 · 2026-09-26 | React 18·19 |

제품은 React 19.3.0을 쓰고 위 네 라이브러리는 설치되어 있지 않다. 목업 8판의 `Ctrl+\`는 두 열 접기(`app.js`)라 분할 단축키와 겹친다. 9판은 `Ctrl+\`를 오른쪽 분할로 옮긴다.

출처: https://code.visualstudio.com/docs/getstarted/userinterface · https://code.visualstudio.com/docs/configure/custom-layout · https://code.visualstudio.com/updates/v1_42 · https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editor.contribution.ts · https://www.jetbrains.com/help/idea/managing-editor-tabs.html · https://support.google.com/chrome/answer/16971124?hl=en&co=GENIE.Platform%3DDesktop · https://github.com/dockview/dockview · https://github.com/ticlo/rc-dock · https://github.com/golden-layout/golden-layout · https://github.com/caplin/FlexLayout

## 5. 결정 후보

선택지는 [브리프 9판](../briefs/2026-10-19-storyboard-vide-next.html)의 Q1~Q3와 같다. 결정은 사용자가 한다.

| 질문 | ① (추천) | ② | ③ |
|---|---|---|---|
| Q1 답변 UI | 변형 B(심사 1등) | 변형 A | 변형 C |
| Q2 파일 보기 범위 | 이미지·HTML·PDF 먼저, 오피스·HWP는 다음 단계(라이브러리 렌더) | 전 형식 한 번에 | 외부 프로그램으로 열기만 |
| Q3 가운데 탭 규칙 | 미리보기 탭 + 2분할 + 고정 8 상한 | VS Code 전체(자유 분할·무제한) | 탭 없이 하나 |

추천 근거: Q1은 §1 심사 합계, Q2는 §3의 WebView2 내장 3형식이 라이브러리·라이선스 부담 0이라는 사실, Q3는 §4의 Chrome 2분할·VS Code 상한 10 사례다. 8판 Q1~Q3(세션 보기·대화 본문·방식 설정)는 [RESEARCH-21](RESEARCH-21-first-run-and-sessions.md)에서 답을 기다린다.
