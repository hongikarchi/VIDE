---
id: RESEARCH-07
title: 요청 처리 방식 — 의도 카드·검증·실제 수행 설명·명령 이력
status: draft
version: 0.3
updated: 2026-09-29
owner: agent:claude
related: [PRD, FR-04, FR-08, FR-10, FR-12, FR-15, FR-20, FR-21, SPEC-02, ARCH-01, ADR-014, RESEARCH-06]
---

# RESEARCH-07 — 요청 처리 방식

## 0. 질문과 초점

2026-09-29 사용자와 한 논의를 정리한다. 시작은 “AI가 스크립트로 모델을 고친다면 Grasshopper 같은 비파괴 모델링이 필요한가, 이 시대에 맞는 모델링 방식은 무엇인가”였다(부록 A). 사용자가 짚은 초점은 실험이 아니라 **사용자의 요청을 처리하는 방식 자체**다. 사용자는 패널링·구조 최적화를 이미 여러 번 해 봤고, 조사에서 다음 세 지점에 주목했다.

1. AI가 쓴 코드를 **체계적인 말로 다시 번역**해 보여주면 비개발자의 이해가 늘었다(Liu 외, CHI 2023).
2. AI가 만든 결과를 **이미지로 보고 스스로 검증·수정**하는 과정을 두면 성공률이 올랐다(CADCodeVerify, ICLR 2025).
3. AI가 형상만 만들지 않고 **편집 가능한 명령 이력**까지 생성한다(Autodesk neural CAD, 2025 발표·2026 상용 예정).

이 문서는 세 지점을 VIDE의 요청 처리에 어떻게 넣을지 설계 방향을 정리한다. 제품 범위는 PRD, 동작 계약은 SPEC-02, 구현 순서는 PLAN이 소유한다.

## 1. 현재 요청 처리와 빈 곳

현재 흐름은 다음과 같다(ARCH-01 §2, ADR-014).

```text
요청 → AI가 모델 조회 → C# 코드 작성 → 작업 사본 실행 → 저장·재열기 확인 → AI가 쓴 요약 → 반영
```

| 빈 곳 | 현재 | 문제 |
|---|---|---|
| 이해 | AI가 요청을 어떻게 해석했는지 실행 전에 드러나지 않음 | 잘못 이해해도 결과를 보고서야 앎 |
| 검증 | 저장·재열기와 보호 대상 비교는 “파일·원본이 온전한가”를 확인 | “창이 정말 3개인가” 같은 **의도 충족**은 확인하지 않음 |
| 설명 | 마지막 설명은 AI가 쓴 자기 보고 | 실제 실행과 어긋나도 알 수 없음. **자기 보고는 검증이 아니다** |
| 재편집 | 값이 코드에 박힌 일회용 코드, 결과가 원본을 대체 | 값 하나를 바꾸려 해도 AI를 다시 부르고, 앞선 규칙이 사라질 수 있음 |

SPEC-02.11은 이미 다음을 약속한다.
- 중요한 것만 묻고 작은 수정에 불필요한 계획 승인을 추가하지 않는다(1).
- 결과를 다시 읽어 유효성·치수·보존 조건을 검사하고 보정한다(4).
- 후보와 차이, 측정값, 사용한 가정, 미검토 범위를 보여준다(5).

아래 설계의 대부분은 **이 약속을 실제로 채우는 방법**이다.

## 2. 세 근거의 핵심

| 근거 | 핵심 | VIDE에 가져올 것 |
|---|---|---|
| Liu 외(CHI 2023), grounded abstraction matching | 사용자의 자연어는 대부분 코드 생성에 효과적인 범위를 벗어난다. 생성된 코드를 **체계적이고 예측 가능한 자연어로 역번역**해 보여주면 모델의 능력 범위와 필요한 말하기 방식을 이해하게 된다 | 요청을 정해진 어휘로 다시 쓰는 **의도 카드**, 실행 결과를 같은 어휘로 옮기는 **실제 수행 설명** |
| CADCodeVerify(ICLR 2025) | 생성한 CAD 결과를 시각-언어 모델이 보고 **검증 질문을 만들어 답하며** 스스로 고친다. 벤치마크 CADPrompt 제시 | 의도 카드에서 나온 **검증 질문**, 수치 검사 + 이미지 확인, 제한된 자체 수정 |
| Autodesk neural CAD | 텍스트·공간 조건에서 형상과 함께 **Fusion 명령 이력**을 생성해, 사람이 직접 모델링한 것처럼 이어서 편집 | AI의 결과물을 코드 덩어리가 아닌 **정해진 어휘의 단계 목록(명령 이력)**으로 |

같은 방향의 근거:
- Zoo의 KCL: 모델 = 코드이고 마우스 조작이 코드를 생성한다.
- Text2BIM: 검토 에이전트를 둔다.
- Sarkar(PPIG 2022): 자연어 명세는 모호·불완전해 여러 번 다듬게 된다.

## 3. 설계 — 요청 처리 한 바퀴

| 단계 | 하는 일 | 사용자에게 보이는 것 |
|---|---|---|
| 1. 이해 | 요청과 첨부(핀·스케치)를 정해진 어휘의 **의도 카드**로 번역. 결정에 중요한 모호함만 질문 | “이렇게 이해했습니다” 카드 |
| 2. 계획 | 의도를 **단계 목록(명령 이력)**으로 구성 | 단계 목록 |
| 3. 실행 | 작업 사본에서 단계 실행 | 진행 로그 |
| 4. 검증 | 의도 카드의 항목을 **검증 질문**으로. 수치는 계산, 형태는 이미지로. 불합격이면 제한 횟수 안에서 자체 수정 | ✓ 통과 / ! 확인 필요 |
| 5. 설명 | 실행된 단계를 같은 어휘로 옮긴 **실제 수행 설명**과 의도 카드 비교, 전후 이미지 | “요청 vs 실제” |
| 6. 반영 | 모드에 따라 반영하고 이력을 보존. 이후 단계 값만 바꿔 재생성 | 편집 가능한 이력 |

세 아이디어는 서로 받친다.
- **명령 이력이 있으면 번역이 결정적이 된다.** 단계 어휘가 정해져 있으면 “매지 20→25 mm”는 AI가 지어낸 요약이 아니라 **실제 실행된 단계에서 나온 문장**이다.
- **의도 카드가 검증 질문의 목록이 된다.** 무엇을 확인해야 하는지가 실행 전에 정해진다.
- **검증 결과가 설명의 근거가 된다.** 설명은 실행 결과와 측정값에서 나온다.

## 4. 구성 요소

### 4.1 의도 카드

요청을 다음 항목으로 다시 쓴다. 어휘와 항목은 고정해 예측 가능하게 한다.

| 항목 | 예 |
|---|---|
| 대상 | 패널 312개(레이어 `FACADE-PANEL`), 핀 고정 객체 |
| 동작 | 매지 간격 변경 |
| 값 | 20 mm → 25 mm (**“좀 더”를 +25%로 해석** — 해석한 값은 표시) |
| 유지 | 분할 간격, 타입 규칙, 패널 외곽 |
| 성공 조건 | 모든 매지 25 mm, 패널 수 유지, 최소 패널 폭 ≥ 300 mm |
| 가정·미확인 | 최소 폭 300 mm는 기존 프로젝트 조건에서 가져옴 |

- **질문은 결정에 중요한 모호함만:** 해석 가능한 값(“좀 더”)은 해석을 드러내고 진행하며, 대상이 불분명하거나 조건이 충돌할 때만 묻는다. SPEC-02.11의 “작은 수정에 계획 승인 단계를 추가하지 않는다”와 맞춘다.
- **지식 DB와 연결:** 성공 조건에 프로젝트의 확정된 요구·결정(RESEARCH-06 §3.4의 구조화된 조건)을 자동으로 불러온다.

### 4.2 명령 이력(단계 목록)

- **단계:** 동작 이름(정해진 어휘), 입력 참조(객체·이전 단계 출력), 이름 붙은 매개변수(값·단위·범위), 출력.
- **어휘:** 자주 쓰는 연산부터(이동·회전·스케일·배열·분할·오프셋·돌출·개구·속성 변경) 시작한다. 어휘에 없는 작업은 **사용자 정의 단계**로 코드를 쓰되, 입력·출력·매개변수를 선언하게 한다. 자주 나오는 사용자 정의 단계를 어휘로 승격한다.
- **재생:** 기준 입력과 단계만으로 결과를 다시 만든다. 매개변수 변경은 AI 없이 재생한다. 재생에도 코드 정책 검사와 작업 사본 실행(ADR-014)을 적용한다.
- **단위:** 객체별 단계 목록에서 시작해, 여러 객체를 만드는 논리(패널링 등)는 프로그램 단위로 묶는다(부록 A).

### 4.3 검증

| 검증 | 방법 | 예 |
|---|---|---|
| 수치 | 성공 조건을 계산으로 확인. AI가 판정하지 않음 | 매지 실측 최소/최대, 패널 수, 최소 폭, 면적 |
| 보존 | 유지 조건의 객체·값이 바뀌지 않았는지 비교(기존 보호 비교 확장) | 분할 간격·타입 규칙 불변 |
| 형태 | 작업 사본 화면을 캡처해 AI가 검증 질문에 답함 | “가장자리에 이상한 조각이 생겼는가”, “패턴이 균일한가” |
| 자체 수정 | 불합격이면 원인을 설명하고 제한 횟수 안에서 수정. 초과하면 멈추고 보고 | 작업 상한(SPEC-02.6) 안에서 1~2회 |

수치로 확인할 수 있는 것은 계산으로 하고, 이미지 확인은 형태 판단이 필요한 요청에만 쓴다(비용·시간).

### 4.4 실제 수행 설명

- 실행된 단계와 측정값을 **의도 카드와 같은 어휘**로 옮긴다. AI의 자기 보고를 설명으로 쓰지 않는다.
- 의도와 실제를 나란히 보여준다: “요청: 매지 25 mm / 실제: 24.9~25.1 mm ✓ / 가장자리 12개가 최소 폭 미달 !”.
- 사용자 정의 단계의 설명은 AI가 쓰되 “AI 설명(미검증)”으로 구분한다.
- 전후 이미지와 변경 객체 목록을 함께 둔다.

## 5. 모드와의 연결

| 모드 | 진행 범위 | 반영 조건 |
|---|---|---|
| Plan mode | 1 이해 → 2 계획 | 반영 없음. “이렇게 이해했고 이렇게 할 것”을 보여줌 |
| Accept edits | 1 → 5 | 사용자가 확인 후 반영 |
| Auto mode | 1 → 6 | **검증 통과 시에만** 자동 반영. 불합격·확인 필요 항목이 있으면 후보로 멈춤 |

## 6. 예시 — “매지 간격을 좀 더 늘려줘”

1. **의도 카드:** 패널 312개, 매지 20 → 25 mm(“좀 더” = +25%로 해석), 분할·타입 유지, 성공 조건(매지 25 mm·패널 수 유지·최소 폭 ≥ 300 mm).
2. **계획:** 기존 이력의 `매지` 단계 값만 변경. 새 코드가 필요 없다.
3. **실행:** 재생.
4. **검증:** 매지 실측 24.9~25.1 mm ✓, 패널 수 312 ✓, 가장자리 12개 최소 폭 미달 !, 이미지 확인에서 가장자리 조각 확인.
5. **설명:** “매지 20 → 25 mm. 패널 수 유지. 가장자리 12개가 최소 폭 300 mm보다 좁아졌습니다. 분할을 조정할까요, 가장자리 패널을 합칠까요?”
6. **반영:** Accept edits면 사용자가 선택, Auto mode면 확인 필요 항목 때문에 후보로 멈춘다.

## 7. 제품 문서와의 관계

| 구성 요소 | 성격 | 반영할 문서 |
|---|---|---|
| 의도 카드, 검증(수치·보존·형태), 실제 수행 설명, 모드별 반영 조건 | SPEC-02.11의 “중요한 것만 질문·결과 검사·가정과 미검토 표시” 약속을 **구체화** | SPEC-02(동작), Design(카드·비교 표시), ARCH-01(검증 질문·캡처 계약). PRD 범위 변경 아님 |
| 명령 이력과 재생(비파괴 재편집) | FR-12(후보·원본)를 넘는 **새 편집 방식**. FR-20(고급 대안 트리)과 인접 | PRD 후보 기능 **C-03** 제안(첨삭 R-75) |
| 지식 DB의 요구·결정을 성공 조건으로 사용 | RESEARCH-06·C-02와 연결 | C-02 채택 시 SPEC-06 |

## 8. 설계 쟁점

- **어휘의 폭:** 너무 좁으면 사용자 정의 단계가 대부분이 되어 번역·재생의 이점이 줄고, 너무 넓으면 AI가 어휘를 잘못 고른다. 사용 기록에서 자주 나오는 사용자 정의 단계를 승격하는 방식이 현실적이다.
- **질문 과잉:** 의도 카드가 매번 승인 대기가 되면 작업이 느려진다. 기본은 “해석을 드러내고 진행”, 질문은 대상 불명확·조건 충돌·위험한 변경에만 한다.
- **이미지 검증 비용:** 캡처와 이미지 판단은 시간과 사용량이 든다. 수치 검사를 먼저 하고, 형태 요청에만 쓴다.
- **재생의 난제:** 위상 이름 문제(앞 단계 변경 시 면·모서리 참조가 바뀜), Rhino 수작업 편집과의 충돌, 객체 간 의존. 객체·개념 단위 연산, 조건 선택자, 변경 감지 후 “수작업 단계” 기록으로 완화한다(부록 A.3).
- **AI 경로의 한계:** 구독 CLI는 이미지 입력을 지원하는 모델·경로가 공급자마다 다르다. 형태 검증의 이미지 전달 방식은 ARCH에서 확인해야 한다.

## 9. 결정이 필요한 질문

1. 의도 카드·검증·실제 수행 설명을 SPEC-02 구체화로 진행할지(현재 개발 우선순위 안에서).
2. C-03(명령 이력과 재생)을 후보 기능으로 채택할지, 시점.
3. 첫 단계 어휘의 범위(기본 변형만 / 분할·배열·개구까지).
4. Auto mode에서 “확인 필요” 항목이 있을 때 기본 동작(후보로 멈춤 / 경고와 함께 반영).
5. 형태(이미지) 검증을 기본으로 켤지, 요청 유형에 따라 켤지.

## 부록 A. 배경 조사 — AI 시대의 모델링 방식과 Grasshopper

### A.1 요약

- **비주얼 스크립팅의 존재 이유 중 “논리를 만드는 장벽을 낮춘다”는 LLM이 대체했다.**
  - Leitão 외(2012)는 LLM 이전부터 대규모·복잡한 생성 설계에서 현대 텍스트 언어가 비주얼 언어보다 생산적일 수 있다고 보고했고, 비주얼 언어가 우세했던 이유로 학습 곡선을 들었다.
  - Zoo는 “AI 언어 모델이 그래픽 모델보다 훨씬 앞서 있다”를 코드 기반 CAD의 근거로 든다.
- **그러나 비파괴·파라메트릭은 업계가 더 붙잡고 있다.**
  - Autodesk neural CAD는 편집 가능한 명령 이력을 생성한다.
  - McNeel 공식 Rhino MCP 플랫폼은 AI에게 스크립트 작성과 Grasshopper 정의 생성을 모두 열었다(“지루한 부분은 보조, 선택·취향·판단은 사람”).
  - Dynamo 창시자가 세운 Hypar는 코드 규칙 함수 + 자연어로 값 채우기를 택했다.
  - 공통 결론은 **편집 가능한 논리를 정본으로 두되 AI가 쓴다**이다.
- **일회용 스크립트는 답이 아니다.** Davis(2013)는 파라메트릭 모델이 수용하려던 변화 때문에 깨지고, 이해 가능성은 크기보다 구조가 좌우한다고 했다(조사 모델의 81%가 기본 구조화 없음).
- **Grasshopper는 논리 작성 도구가 아니라 실행 엔진·플러그인 생태계·협업 형식으로 남는다.** 코드 API가 없는 플러그인, Grasshopper로 일하는 협력자, 뷰포트 실시간 조작이 이유다.

### A.2 전문 계산

구조 해석 에이전트 연구(OpenSeesPy 코드 생성, 3D 골조 에이전트, StructureClaw, MCP 기반 해석)의 공통점은 **AI가 해석을 직접 계산하지 않고 검증된 해석 엔진을 호출하는 코드를 쓰며 검증 단계를 둔다**는 것이다. Karamba3D는 공식 스크립팅 가이드에서 C#·Python 사용과 Grasshopper 없는 핵심 라이브러리 사용을 안내한다. Rhino 8은 ScriptEditor에서 CPython 3와 pip 패키지(COMPAS 등)를 쓴다.

### A.3 비파괴 방식의 난제

| 난제 | 완화 |
|---|---|
| 위상 이름 문제(FreeCAD 등 피처 트리 CAD의 오래된 문제) | 객체·개념 단위 연산, 조건 선택자, 못 찾으면 멈추고 알림 |
| 수작업 편집과 충돌 | 변경 감지 뒤 “수작업 단계”로 기록하거나 이력 종료·확정 선택 |
| 객체 간 의존(스택이 그래프가 됨) | 프로그램 안 함수 호출로 표현, 그래프 보기는 자동 생성 |
| AI가 쌓는 스파게티 코드 | 구조 틀 강제, 주기적 정리, 버전 비교 |

### A.4 비교

| 항목 | Grasshopper | 일회용 AI 스크립트(현재) | 명령 이력·설계 프로그램 |
|---|---|---|---|
| 논리 작성 | 사람이 노드로 | AI | AI |
| 비파괴·재생성 | 예 | 아니오 | 예 |
| 값 바꿔 재생성 | 즉시 | AI 재요청 | 즉시(AI 불필요) |
| 규칙 유지 | 정의에 남음 | 사라질 수 있음 | 이력에 남음 |
| 이해(비코더) | 노드를 읽어야 함 | 어려움 | 체계적 번역 |
| 해석·최적화 생태계 | 강함 | 라이브러리 호출 | 라이브러리 + GH 호출 |
| 버전·차이 비교 | 어려움 | 요청 이력 수준 | 쉬움 |

## 출처

**요청 처리의 세 근거**
- Liu 외, “What It Wants Me To Say: Bridging the Abstraction Gap Between End-User Programmers and Code-Generating LLMs”, CHI 2023 — [arXiv](https://arxiv.org/abs/2304.06597)
- Alrashedy 외, “Generating CAD Code with Vision-Language Models for 3D Designs”(CADCodeVerify), ICLR 2025 — [arXiv](https://arxiv.org/abs/2410.05340) · [ICLR](https://proceedings.iclr.cc/paper_files/paper/2025/file/81a934cd364e18ea6fdeaf57a93c17d4-Paper-Conference.pdf) · [코드](https://github.com/Kamel773/CAD_Code_Generation)
- Autodesk neural CAD — [Autodesk](https://www.autodesk.com/design-make/articles/neural-cad) · [발표](https://adsknews.autodesk.com/en/news/upcoming-3d-generative-ai-foundation-models/) · [AEC Magazine](https://aecmag.com/ai/neural-cad-ai-foundational-models/) · [DEVELOP3D](https://develop3d.com/cad/autodesk-shows-its-ai-hand/)

**관련 연구**
- Sarkar 외, “What is it like to program with artificial intelligence?”, PPIG 2022 — [arXiv](https://arxiv.org/abs/2208.06213)
- Text2BIM — [arXiv](https://arxiv.org/abs/2408.08054) · Text-to-CadQuery — [arXiv](https://arxiv.org/abs/2505.06507v1) · CAD-Coder — [GitHub](https://github.com/gudo7208/CAD-Coder) · EvoCAD — [arXiv](https://arxiv.org/pdf/2510.11631)
- MCP-Driven Parametric Modeling, NeurIPS 2025 Creative AI — [PDF](https://proceedings.neurips.cc/paper_files/paper/2025/file/245a7772c1c6725c1e439d7f789b48c2-Paper-Creative_AI_Track.pdf)
- Sketch-n-Sketch(코드와 직접 조작의 양방향 편집) — [arXiv](https://arxiv.org/abs/1809.04209)
- Davis, *Modelled on Software Engineering*, 2013 — [논문](https://www.danieldavis.com/thesis/) · [8장](https://www.danieldavis.com/thesis-ch8/)
- Leitão 외, “Programming Languages for Generative Design: A Comparative Study”, 2012 — [PDF](https://web.ist.utl.pt/antonio.menezes.leitao/ADA/documents/publications_docs/2012_ProgrammingLanguagesForGenerativeDesign_AComparativeStudy.pdf)
- 구조 해석 에이전트 — [OpenSeesPy 에이전트](https://arxiv.org/abs/2507.02938) · [3D 골조](https://arxiv.org/pdf/2606.06525) · [StructureClaw](https://arxiv.org/pdf/2607.14896) · [MCP 구조 해석](https://www.mdpi.com/2075-5309/15/17/3190)

**제작사·공식 문서**
- McNeel Rhino MCP 플랫폼 — [문서](https://mcneel.github.io/RhinoAI/) · [저장소](https://github.com/mcneel/rhinoai) · Rhino 9 Constraints — [도움말](https://docs.mcneel.com/rhino/9/help/en-us/commands/constraints.htm) · Rhino History — [도움말](https://docs.mcneel.com/rhino/8/help/en-us/commands/history.htm)
- Zoo KCL — [연구 글](https://zoo.dev/research/introducing-kcl) · [문서](https://zoo.dev/docs/kcl)
- Hypar — [AEC Magazine](https://aecmag.com/ai/hypar-text-to-bim-and-beyond/) · [Hypar 2.0](https://aecmag.com/features/hypar-2-0/)
- Karamba3D 스크립팅 가이드 — [기본](https://scripting.karamba3d.com/1.-introduction/1.2-what-s-new-in-karamba3d-1.3.3-regarding-scripting) · COMPAS — [Rhino 8](https://compas.dev/compas/2.5.0/userguide/cad.rhino8.html)
- FreeCAD 위상 이름 문제 — [문서](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Topological_naming_problem.md)
