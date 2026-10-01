---
id: VERIFY-2026-09-29-jig-platform-mockups
title: jig 플랫폼·작업공간·S-06 구조 jig 화면 목업 검수
status: review
version: 0.2
updated: 2026-10-01
owner: agent:claude
related: [RESEARCH-10, FR-23, SCR-03, SCR-12]
---

# jig 플랫폼 화면 목업 검수

## 범위와 기준

[RESEARCH-10](../research/RESEARCH-10-vide-restructure.md) §6(디자인 시스템), §7(화면 구성), §14.7(S-06 대시보드·보고서)의 제안을 결정 전에 눈으로 확인하기 위한 정적 목업이다. 제품 화면 구현이나 Design 반영이 아니다. 해당 SCR 번호는 아직 없다(RESEARCH-10의 화면안 표지는 임시). 관련 AC가 없으므로 AC를 인용하지 않는다. 기존 화면 기준은 SCR-03(작업 보기)과 SCR-12(호스트 패널)이며, 목업은 이 둘의 배치를 바꾸지 않는 것을 전제로 한다.

| 파일 | 화면안 | 보여 주는 것 |
|---|---|---|
| `tools/mockups/jig-platform/workspace-model.html` | c (+ 모델 작업공간) | 작업공간 탭 줄, 3열 기본 배치, 오른쪽 목적별 대화 칩, "구조 검토하고 싶어" → 구조 해석 jig 연결과 건축 용어 질문 카드 |
| `tools/mockups/jig-platform/jig-studio.html` | d (JIG 만들기) | 개발 환경: 왼쪽 jig 개요(단계·매개변수·화면·시험), 가운데 화면 미리보기·흐름·코드 탭, 아래 점검·시험 결과, 오른쪽 제작 대화(계획 체크리스트·질문 카드) |
| `tools/mockups/jig-platform/s06-dashboard.html` | a (JIG 실행) | S-06 골조 배치 jig 실행: 단계 레일, 입력 조립 확인, 배치 대안, KPI 띠, 3D 겹침과 판정색, 설정값 슬라이더, 문제 표(원인 구분), 기초 간섭 평면 지도 |
| `tools/mockups/jig-platform/s06-report.html` | e (보고서) | S-04 분석 자료 형식의 보고서: 문장형 헤드라인, KPI 띠, 번호 절(배치·기초 간섭 / 경간 / 부재 검정 / 일람표 / 남은 조건), 예비값 안내 |

## 방법과 결과

- 각 파일은 인라인 CSS·SVG로 된 단일 HTML이다. 외부 스크립트는 없고 Google Fonts 링크만 쓴다. 글꼴·색·간격은 `src/ui/style.css` 토큰과 RESEARCH-10 §6.1 이름을 따른다.
- Chrome(Playwright, headless)으로 1440×900 화면과 전체 페이지를 캡처해 보면서 넘침·겹침·잘림·한국어 단어 중간 줄바꿈을 고쳤다. 보고서 목업은 1024·390 px 폭에서도 가로 넘침이 없음을 확인했다.
- 모든 수치는 합성 자료다. 발주처·대지·회사 이름은 쓰지 않았다(S-06, 역할 이름만).

## 한계

- 정적 화면이다. 슬라이더·탭·질문 카드는 동작하지 않는다.
- S-06 수치는 합성 자료라 실제 모델 결과가 아니다.
- 보고서 목업에는 `조건 조정` 버튼이 있으나, RESEARCH-10 §6.3은 내보낸 보고서에서 이 버튼을 빼고 "VIDE에서 열기"만 두도록 제안한다. 결정 뒤 맞춘다.
- 사용자 검토 전이다. 결정(RESEARCH-10 §16) 뒤 Design 반영과 함께 다시 본다.
