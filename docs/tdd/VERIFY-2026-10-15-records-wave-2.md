---
id: VERIFY-2026-10-15-records-wave-2
title: 프로젝트 기록 웨이브 2 오프라인 검수 (T-332)
status: review
version: 0.1
updated: 2026-10-15
owner: agent:claude
related: [C-09, SPEC-17, PLAN-53, SCR-44, SCR-45]
---

# 프로젝트 기록 웨이브 2 오프라인 검수 (T-332)

[PLAN-53](../plans/PLAN-53-project-records.md) T-332 가운데 **오프라인 부분만** 기록한다. 기준은 [SPEC-17](../specs/SPEC-17-project-records.md) 8의 2(웨이브 2)다. 수용 결과는 다음과 같다. 합성 카카오톡·메일을 들여 거르고 부위에 묶은 뒤 부위·유형·장 세 행 모드의 차트와 인쇄 보기가 나와야 한다. 기록 1,000건에서 첫 그리기가 1초 안이어야 한다. 원문은 사이트·진단 묶음에 없어야 한다. 화면 기준은 Design SCR-45 「구현 기준」(차트, 가져오기와 사본 줄)이다. C-09는 후보 기능이어서 PRD §15에 기록 AC가 없다. 그래서 SPEC-17.8 2의 문단을 기준으로 쓴다.

## 환경

- 저장소 HEAD `8415cb1a`, 작업 트리에 웨이브 2 변경 포함(커밋 전), Windows 11, Node v24.15.0, Playwright(Chromium).
- **합성 데이터만** 썼다. 카카오톡 대화·메일·부위 이름은 모두 지어낸 것이다(`tests/fixtures/records-import/index.mjs`). 실명·전화번호·실제 주소는 넣지 않았다. 실제 프로젝트, 사용자 원본, 설치 엔진(47821), Rhino·ZWCAD는 쓰지 않았다.
- 브라우저 시험은 `os.tmpdir()` 아래 임시 데이터 폴더와 임시 작업 폴더에서 `startServer`(임의 포트)로 띄우고, 끝나면 폴더를 지웠다.

## 단계

| 단계 | 기대 | 실제 | 판정 |
|---|---|---|---|
| 합성 카카오톡(PC·모바일 두 형식, 각 300줄 이상) 파싱 | 메시지 수가 fixture와 같고, 이어지는 줄은 앞 메시지에 붙고, 사진·파일·이모티콘은 말로 바뀌고, 시스템 줄·삭제된 메시지는 빠짐 | 같음(`import-kakao.test.mjs` 5건) | 통과 |
| 합성 메일 eml 20통·mbox·euc-kr·인코딩 단어 파싱 | 제목·보낸이·날짜·첫 문단, 인용·서명 제거, 첨부는 이름만 | 같음(`import-mail.test.mjs` 5건) | 통과 |
| 기록 탭 [가져오기] → 카카오톡 `.txt` | 알림 '후보 N건 · 원문은 폴더에 아직 안 씀'(중복 0이면 '중복'은 생략), 목록은 후보·카카오톡으로 걸러지고 도우미 표시가 있는 행이 앞에 옴 | 같음(`browser-records-import.mjs`) | 통과 |
| 같은 파일을 다시 들임 | '이미 들인 파일입니다.' [처음 기록 보기] | 같음(브라우저). 일부만 겹치면 겹친 줄만 건너뜀(`records-import.test.mjs`) — SPEC-17.7 표와 다름, SPEC-17 R-85 | 통과(명세 차이 표시) |
| 원문 복사 | `<ops>/기록/원문/<이름>`에 쓰고 같은 이름·다른 내용이면 ' (2)', `원문/.gitignore` | 같음(`records-import.test.mjs`) | 통과 |
| 원문 제외 | 진단 묶음·AI 파일 도구·작업 폴더 Git에서 `기록/원문` 제외 | `diagnostics-lines`·`project-files`·`workspace-files` 시험 통과 | 통과 |
| 가져온 후보가 폴더 사본에 오르지 않음 | 거르지 않은 kakao·mail 후보는 `<ops>/기록/YYYY-MM.jsonl`에 없고, O로 거른 뒤에만 오름 | 같음(`records-mirror.test.mjs` 'KakaoTalk and mail candidates stay out of the copy until sorted') | 통과(검수 중 고침) |
| 사본 되들이기 | 사람이 고친 필드만 반영하고, 사본이 '폴더에서 바뀜'이 된 뒤 VIDE에서 한 O/X·본문 고침은 유지 | 같음(`records-mirror.test.mjs` 'taking a copy in keeps what VIDE changed…') | 통과(검수 중 고침) |
| 차트 세 행 모드 | 부위 8·유형 5·장 3 행, 라벨 상자 겹침 0 | 같음(`browser-records-chart.mjs`) | 통과 |
| 유형 토글·체인 강조·자세히 칸 | 토글마다 글리프 수가 맞고, 마지막 하나는 잠기고, 체인만 진하게, 누르면 자세히 칸이 열림 | 같음 | 통과 |
| 인쇄 보기 | A3 판에 차트·범례·색인 4단, 다른 화면 영역 0 | `{columns:'4', listed:73, glyphs:73, others:0}`(print 미디어 에뮬레이션) | 통과 |
| 기록 1,000건 첫 그리기 | ≤ 1,000 ms | 180 ms(이번 실행; 구현 때 121~138 ms) | 통과 |
| 거른 기록을 부위에 묶고 차트에서 보기(한 흐름) | 가져오기 → O/X → 부위 → 차트 | 단계별 시험으로만 확인했다. 한 번에 이어 본 흐름은 미시험 | 부분 |

## 시험 명령과 결과

| 명령 | 결과 |
|---|---|
| `npm run typecheck` | 통과(ui·server) |
| `npx prettier --check` (바뀐·새 파일) | 통과 |
| `node --test tests/core/*.test.mjs tests/ai/*.test.mjs tests/server/*.test.mjs` | 1,894건 중 1,894 통과, 실패 0 |
| `npm run build:web` | 통과(기존 청크 크기 경고만) |
| `node tests/integration/browser-records-import.mjs` | `browser records import: ok` |
| `node tests/integration/browser-records-chart.mjs` | `browser records chart: ok`, 1,000건 첫 그리기 180 ms |
| `node tests/integration/browser-records.mjs` | `browser records: ok`(회귀) |
| `node tests/integration/browser-files-tab.mjs` | 통과(회귀) |
| `node tests/integration/browser-workspace-tabs.mjs` | 통과(회귀) |
| `npm run docs:check` | 통과 |

## 미시험

- 실제 카카오톡·메일 내보내기 파일(iOS·Android·PC 버전별 날짜 줄 변형)과 8bit euc-kr 원문 메일. 화면이 `File.text()`(UTF-8)로 읽으므로 base64·QP가 아닌 euc-kr 본문은 깨질 수 있다.
- 실제 작업 폴더에서 사본 줄·'폴더에서 바뀜' 상자·[폴더 내용 들이기]·[VIDE 기록으로 다시 쓰기] 화면 확인.
- 실제 프린터·PDF로 A3 가로 출력.
- 기록 200건·부위 15개를 한 화면에서 읽을 수 있는지(SPEC-17.4 수용 결과) — 사용자 동승(T-338).
- 가져오기 → 거르기 → 부위 → 차트를 한 번에 잇는 흐름.

## 발견

- **P0(검수 중 고침):** (1) [폴더 내용 들이기]가 사람이 손대지 않은 줄까지 DB 값과 비교해, 사본이 '폴더에서 바뀜'이 된 뒤 VIDE에서 한 O/X·본문 고침을 되돌렸다. 이제 이 PC가 마지막으로 쓴 행과 비교해 사람이 바꾼 필드만 반영한다(`src/server/records-mirror.ts` `takeLine`, `WorkspaceOutputs.recordsCopyBase`). (2) 거르지 않은 카카오톡·메일 후보 본문이 `<ops>/기록/YYYY-MM.jsonl`에 쓰여 AI 파일 도구와 작업 폴더 Git으로 나갈 수 있었다. 이제 그 후보는 사본에서 뺀다(`mirrored`). ARCH-01 1.39에 반영했다.
- **P1(고침):** `browser-records-import.mjs`를 `test:browser`에 등록했다. 가져오기 문구('들이는 중…', 중복 0이면 생략, '파일이 너무 큽니다(20 MB까지).', '…만 들일 수 있습니다.')를 Design SCR-45에 맞췄다.
- **P1(사용자 결정):** SPEC-17.7 '같은 원문을 두 번 들임 → 거부'와 일부 중복 건너뜀 구현의 차이(SPEC-17 R-85).
- **P2:** 작성자 거르기 없음(SPEC-17 R-82), 차트 읽기 전용 + 자세히 칸 문구(R-83), 카카오톡 메시지 단위·메일 시각 없음 문구(R-84). 커서 뒤 글리프 35% 흐림이 Design에 없음(사용자 판단). `src/knowledge/collect/mail.ts`와 `src/core/import/mail.ts`의 MIME 읽기 중복(PLAN-53 후속). ARCH-01 R-91(기록 DB의 AI 읽기에서 가져온 후보 빼기) 미결. 고친 P2는 PLAN-53 「현재 상태」 0.7에 적었다.
