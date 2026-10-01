---
id: VERIFY-2026-09-30-direct-apply-zwcad
title: ZWCAD 바로 실행·되돌리기·보호 실호스트 검수
status: review
version: 0.2
updated: 2026-10-01
owner: agent:claude
related: [ADR-022, T-071]
---

# ZWCAD 바로 실행 실호스트 검수

기준은 [ADR-022](../decisions/ADR-022-direct-apply-plan-auto.md)와 [PLAN-24 T-071](../plans/PLAN-24-ai-conversations.md#t-071)이다. 확인할 항목은 연결 도면에서의 `direct-execute`(추가 객체가 `changes.added`로 옴), 최신 실행 `direct-undo`, 최신이 아닌 실행의 되돌리기 거절(`not-latest`), 50개 초과 삭제 보호(보류 뒤 확인), 레이어 삭제 보호, 실행 뒤 `fingerprint` 변화, 그리고 바로 실행 뒤에도 Live Sync가 엔진을 갱신하는지다. 해당하는 SCR·AC가 없는 호스트 계약 검수라서 ADR과 티켓만 인용한다.

## 판정: 막힘 — 개발 플러그인을 로드하지 못함

실제 ZWCAD에서 T-071의 바로 실행 항목은 **확인하지 못했다**. 원인은 제품 코드가 아니라 시험 환경이다. 설치본 연결 플러그인(0.2.10)이 ZWCAD 시작 때 자동 로드(`HKCU\Software\ZWSOFT\ZWCAD\2023\ko-KR\Applications\VIDE`, `LOADCTRLS` 2)되고, 같은 어셈블리 이름의 개발 빌드(`.vide/build/zwcad-connection/VIDE.Zwcad.Connection.dll`, 2026-09-30 14:45 빌드, `direct-execute`·`fingerprint`·`VIDEAIUNDONE` 포함 확인)를 `NETLOAD`해도 이미 로드된 설치본이 쓰인다. 그래서 `fingerprint` 호출이 `UNSUPPORTED_METHOD`로 끝났다. 자동 로드를 끄는 레지스트리 변경은 이번 에이전트 세션의 권한으로 허용되지 않아 하지 않았다.

다시 돌리려면 ZWCAD가 개발 빌드를 먼저 로드하도록 설치본 자동 로드를 끄거나(0.2.11 설치 전 또는 설치 뒤 개발 빌드로 등록), 0.2.11 설치본(T-071 코드 포함)으로 같은 시험을 돌린다. 시험 코드는 이 판정을 바로 알리도록 `fingerprint` 사전 확인을 넣어 두었다.

## 확인한 것

| 항목 | 결과 | 수치 |
|---|---|---|
| 합성 DWG 만들기 | 통과 | 숨긴 ZWCAD 2023에서 `.vide/h4/h4-direct.dwg` 저장(mm, 모델 공간 62개: `H4-KEEP` 선·원 2, `H4-BULK` 선 60, 빈 레이어 `H4-EMPTY`) |
| 파일 인자로 DWG 열기 + 연결 | 통과 | `DWGNAME` h4-direct.dwg, 객체 62, Live 켜짐(설치본 0.2.10 플러그인의 연결) |
| 개발 엔진 연결·첫 Sync | 통과 | 포트 47844, 데이터 `.vide/h4-data`, Sync `succeeded`, 표시 62/62, generation 1, 브라우저 오류 없음 |
| 개발 플러그인 로드(`fingerprint`) | 실패 | `UNSUPPORTED_METHOD` — 설치본 자동 로드 |
| `direct-execute` 추가·`fingerprint` 변화·Live Sync 갱신 | 미실행 | 위 이유 |
| 최신 되돌리기·`not-latest` 거절 | 미실행 | 위 이유 |
| 대량 삭제 보호(60개, 보류 → 확인 → 되돌리기) | 미실행 | 위 이유 |
| 레이어 삭제 보호(보류 → 확인 → 되돌리기) | 미실행 | 위 이유 |

## 함께 발견한 것

- `VIDECADConnect`는 이제 Link와 같아서(`ConnectionPanel.cs`) 프로젝트 선택 창을 띄우고 `%LOCALAPPDATA%/VIDE/launch.json`의 엔진(설치본)에 로그인·프로젝트 목록을 읽는다. 숨긴 ZWCAD의 시작 스크립트에서 부르면 창에서 멈춘다. 첫 두 번의 시도가 이 창에서 멈췄고, 선택하지 않은 채 프로세스를 끝내 링크는 만들지 않았다. 시험에서는 `VIDECADLiveSync`만으로 연결한다. 기존 `tests/integration/zwcad-attached.mjs`도 `VIDECADConnect`를 부르므로 같은 창에서 멈출 수 있다.
- 강제 종료한 ZWCAD가 남긴 `.dwl` 잠금 파일이 있으면 다음 실행이 '사용 중인 파일' 창에서 멈춘다. 시험은 시작 전에 `.dwl`을 지운다.
- 대량 삭제 보호의 보류 실행은 트랜잭션을 취소하지만, 연결의 `revision`은 삭제 이벤트로 이미 올라간다. 그러면 도면이 바뀌지 않았어도 `fingerprint`와 Live Sync 세대가 바뀔 수 있다(코드 읽기로 본 예상, 실호스트 미확인). 시험은 보류 전후의 `revision`을 기록하도록 두었다.

## 증거와 정리

- 시험 코드(로컬, Git 제외): `.vide/h4/make-dwg.mjs`(합성 DWG), `.vide/h4/run.mjs`(엔진·ZWCAD·브라우저·바로 실행 단계 전부). 결과는 `.vide/h4/result.json`.
- 이 시험이 띄운 ZWCAD와 개발 엔진(47844)은 모두 종료했다. 설치본 엔진(47821)은 멈추지 않았고 위 Link 창의 로그인·목록 읽기(실행 중이었다면) 외에는 요청하지 않았다. `%LOCALAPPDATA%/VIDE`에는 쓰지 않았고, 레지스트리는 바꾸지 않았다. 사용자 도면은 열지 않았다.
