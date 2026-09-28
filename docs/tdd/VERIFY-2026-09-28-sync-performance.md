---
id: VERIFY-2026-09-28-sync-performance
title: 연결 Rhino Sync 성능과 증분 Live Sync 검증
status: review
version: 0.2
updated: 2026-09-28
owner: agent:claude
related: [SPEC-01, ARCH-01, PLAN-02, AC-39, AC-17, AC-38]
---

# 연결 Rhino Sync 성능과 증분 Live Sync 검증

[PLAN-02 현재 작업](../plans/PLAN-02-agent-host-versioning.md)의 계측·변경·검증 결과다. 기준은 SPEC-01.9(Live Sync는 변경을 모아 마지막 성공 취득 기준을 갱신)와 AC-39(수동 Sync 뒤 표시 갱신, 원본·파일 무변경)이다. 동작 계약은 [ARCH-01](../architecture/ARCH-01-system.md) 연결 채널 절에 반영했다.

## 환경과 방법

- 모델: 사용자 작업 문서의 기존 캡처 사본(`.vide/sync-perf/model.3dm`, 386 MB, 문서 객체 10,713개, 표시 조회 10,086개). 사용자 원본은 열지 않았다. 사본과 결과는 커밋하지 않는다.
- 호스트: 소유 시험 Rhino 8(숨김 창, `/scheme=VIDE-Worker-Test`), 20 논리 코어. 시험 뒤 종료했다.
- 재현: `node tests/integration/rhino-sync-perf.mjs [.vide/sync-perf/model.3dm]`, 측정할 RHP는 `VIDE_TEST_RHINO_PLUGIN`. 원자료는 `.vide/sync-perf/<run>/result.json`(변경 전 `5a1949ec…`, 변경 후 `eafe5b9e…`).

## 결과

| 구간 | 변경 전 | 변경 후 |
|---|---|---|
| 제품 경로 전체 Sync(첫 회, 캐시 없음) | 37.8초 | 4.4초 |
| 제품 경로 전체 Sync(두 번째) | 38.4초 | 1.9초 |
| └ PowerShell 소유 확인 | 13회 · 13.1초 | 0회(연결 목록 조회 때 확인한 결과 재사용) |
| └ 문서 전체 지문 | 2회 · 6.0초 | 0회(연결 revision 토큰, 4 ms) |
| └ 표시 페이지 11개(Rhino 처리·전송) | 19.2초 | 0.5초(캐시 후) |
| 표시 JSON | 112 MB | 76 MB(좌표 1 µm 반올림) |
| 결과 폐기 후 재계산한 페이지 | 0 | 0(12 MiB 예산으로 끊음) |
| 연결 상태 조회 1회 | 1.06초 | 3 ms |

증분 Live Sync(`displayChanges`)는 각 편집 뒤 이전 표시에 변경분을 병합한 결과가 새 전체 Sync와 같은지(객체 GUID·표시 해시·층/표시 색) 확인했다.

| 편집 | 변경/삭제 객체 | 증분 조회 | 전체 Sync와 일치 |
|---|---|---|---|
| 객체 1개 이동 | 1 / 0 | 34 ms | 예 |
| 객체 1개 삭제 | 0 / 1 | 20 ms | 예 |
| 상자 1개 추가 | 1 / 0 | 13 ms | 예 |
| 층 색 변경 | 988 / 0 | 56 ms | 예 |
| `_Undo`(시험 스크립트의 파일 열기까지 되돌려 문서가 비워짐) | 1 / 10,182 | 18 ms | 예 |

서버 병합·저장은 112 MB 표시 Sync 기준 1회 약 1.5초(메모리 DB 계측)였다. 새 76 MB 형식에서는 더 짧을 것으로 예상하나 따로 재지 않았다. 따라서 편집이 화면에 반영되기까지의 시간은 대략 플러그인 안정화 0.5초 + 상태 조회 주기 최대 1초 + 서버 병합 약 1~1.5초 + 브라우저 갱신이다. 실제 브라우저에서 이 전체 시간을 재지는 않았다.

## 회귀

- 단위·서버 전체 257건 통과(`npm test`). 병합·범위 이탈·재시도·참조된 기준 보존은 `tests/core/display-delta.test.mjs`, `tests/server/live-sync.test.mjs`.
- 합성 Rhino 연결 회귀 `tests/integration/rhino-attached.mjs` 통과(기본 경로의 새 RHP). 원본 적용·읽기, Undo, Live 세대 갱신, 재연결 거절, 블록 정의 변경 감지(캡처 토큰 비교로 보완)를 포함한다.
- 브라우저: 새 `tests/integration/browser-live-sync.mjs` 통과. 세대 변경 때 전체 캡처 없이 같은 Sync를 제자리 갱신하고(다음 요청의 기준 revision 2 확인), 삭제를 목록에 반영하며, `resync` 응답이면 전체 Sync로 전환한다. 기존 `browser-attached-sync`(초안 보호·자동 Sync·수정 위임 패킷), `browser-rhino-panel`, `browser-viewport-display`, `browser-cad-display`, `browser-large-model`, `browser-object-list`도 통과했다.

## 블록·주석·해치 표시

같은 사본(블록 정의 52개·사용 40개, 최상위 인스턴스 1,269개(한 정의당 최대 268개)·중첩 2단계, 치수 78개·문자 24개, 선 패턴 해치 11개)에서 표시 미지원이 1,384개에서 2개(기존 비정상 Brep)로 줄었다. 인스턴스별로 전개하면 삼각형이 약 119만 개 늘어 표시 한도를 넘으므로 정의 형상은 한 번만 싣고 인스턴스는 변환만 싣는다([ARCH-01](../architecture/ARCH-01-system.md) 연결 채널).

| 항목 | 블록 표시 전 | 후 |
|---|---|---|
| 표시 / 미지원 | 8,702 / 1,384 | 10,084 / 2 |
| 전체 Sync(첫 회 / 두 번째) | 4.4 / 1.9초 | 5.0 / 2.0초 |
| 표시 JSON | 76 MB | 81.6 MB |
| 블록 인스턴스 1개 이동의 증분 조회 | — | 32 ms, 전체 Sync와 일치 |

격리 저장소에 같은 결과를 넣어 Chromium 1600×1000에서 전체 모델, 블록 인스턴스(난간 패널), 한글 문자 주석, AR-PARQ1 해치를 확대해 표시·선택되는 것을 확인했다(`.vide/sync-perf/adfe7b87…/browser-a6f6d9bf…/*.png`, 페이지 오류 없음). 원자료는 `.vide/sync-perf/adfe7b87…/result.json`. 단위 시험에 정의 참조 검증·표시 집계·정의 병합을 추가했고(259건 통과), 기존 연결·브라우저 회귀를 다시 통과했다.

## 한계

- 첫 전체 Sync는 모든 Brep을 새로 메싱하므로 캐시 후보다 느리다(5.0초). Rhino 재시작이나 재연결 때마다 캐시는 비워진다.
- 문자·치수 문자는 XY 평면에 눕혀 그린다. 입면에 세운 문자는 방향이 다르게 보일 수 있다. 치수 화살촉과 문자 서식(글꼴·굵기)은 표시하지 않는다.
- 블록 정의 안의 개별 객체는 따로 선택할 수 없고 인스턴스 단위로 선택된다. 블록 인스턴스는 웹 공유 게시 대상에 아직 포함되지 않는다.
- 서버는 Live Sync마다 기준 결과 전체를 다시 저장한다. 요청 목록 조회가 모든 저장 결과를 내려받는 문제도 남아 있다.
- 사용자 Rhino에서는 새 RHP를 불러오도록 Rhino를 재시작해야 한다. 사용자 창의 Live Sync 체감 시간은 아직 확인하지 않았다.
