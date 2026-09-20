---
id: INDEX-SPECS
title: VIDE 기능 명세 · 사용자 작업과 기능 목록
status: review
version: 0.8
updated: 2026-09-20
owner: user
related: []
---

# VIDE 기능 명세

VIDE에서 설계자는 Rhino·ZWCAD의 모델과 도면을 보고, 객체를 가리키고 선을 그려 AI에 작업을 맡긴다. 실제 후보를 보며 수정 지시하고, 검토한 결과를 호스트에서 계속 편집할 수 있는 형태로 반영한다. 표·검토본·웹 의견은 이 설계 작업의 근거와 후속 검토를 연결한다. 제품 범위의 기준은 [PRD](../PRD.md)다.

## 먼저 읽을 사용자 작업

[전체 사용자 여정 — SPEC-00의 ‘VIDE에서 완결할 세 가지 작업’](SPEC-00-common.md)부터 읽는다. 이 부분에서 프로그램의 흐름을 확인한 다음, 아래 기능 문서의 앞부분에서 사용자 입력·프로그램 동작·결과를 읽는다. 상태·권한·저장·실패 규칙은 각 기능 문서 뒷부분에 연결했다. 기존 ID는 다른 문서의 참조를 유지하기 위해 그대로 두었다.

| 사용자가 하려는 일 | 기능 문서의 정상 흐름 | 읽고 판단할 것 |
|---|---|---|
| 모델·도면에서 대상을 찾아 의도 전달 | [SPEC-01](SPEC-01-project-input-sync.md) · SPEC-01.9·10 | 형상을 탐색하고 핀·스케치·치수·자료를 한 요청에 넣을 수 있는가 |
| AI에게 만들기/수정 맡기고 결과 조정 | [SPEC-02](SPEC-02-execution-candidates.md) · SPEC-02.11~13 | 실제 후보를 만들고 추가 지시→반영→호스트 재편집으로 이어지는가 |
| CAD 도면과 Rhino 모델 연결 | [SPEC-02](SPEC-02-execution-candidates.md) · SPEC-02.14 | 한 요청의 실제 데이터가 양쪽 결과에 사용되는가 |
| 변경 이유·수량 확인, 비교·전달 | [SPEC-03](SPEC-03-data-history-export.md) · SPEC-03.8 | 대상/근거/표를 오가고 수정 전후 결과를 남길 수 있는가 |
| 외부 의견으로 실제 설계 수정 | [SPEC-04](SPEC-04-web-review.md) · SPEC-04.7 | 웹 의견이 로컬 작업과 수정 결과까지 연결되는가 |
| 설치·AI 연결·확장 사용·재개 | [SPEC-05](SPEC-05-extensions-install.md) · SPEC-05.7 | 같은 작업환경에서 AI와 추가 기능을 실제로 사용할 수 있는가 |

## 구체적인 첫 지원안과 확인된 사실

경계 생성/수정·이동/복사와 Rhino 돌출 후보를 첫 기능 지원안으로 제안했다. 상세는 [Rhino 지원표](hosts/rhino.md)와 [ZWCAD 지원표](hosts/zwcad.md)다. **구현 목표 제안과 이미 확인한 네이티브 실험을 구분한다.** 특정 예제만 되는 제품이나 폴리라인 도구로 범위를 확정한 것이 아니다. OQ-03·10의 지원안 채택과 실증을 거쳐야 한다.

## PRD 요구와 기능 명세 대응

이 표가 FR → SPEC 대응의 원본이다(AI.md §7). 기능 서술의 정본은 각 SPEC이고 제품 약속은 PRD가 소유한다.

| FR | SPEC | 비고 |
|---|---|---|
| FR-01 | [SPEC-00](SPEC-00-common.md) · [SPEC-01](SPEC-01-project-input-sync.md) | — |
| FR-02 | [SPEC-00](SPEC-00-common.md) · [SPEC-01](SPEC-01-project-input-sync.md) · [SPEC-02](SPEC-02-execution-candidates.md) | — |
| FR-03 | [SPEC-01](SPEC-01-project-input-sync.md) | — |
| FR-04 | [SPEC-02](SPEC-02-execution-candidates.md) | — |
| FR-05 | [SPEC-00](SPEC-00-common.md) · [SPEC-01](SPEC-01-project-input-sync.md) | — |
| FR-06 | [SPEC-01](SPEC-01-project-input-sync.md) · [SPEC-04](SPEC-04-web-review.md) | — |
| FR-07 | [SPEC-01](SPEC-01-project-input-sync.md) · [SPEC-04](SPEC-04-web-review.md) | — |
| FR-08 | [SPEC-02](SPEC-02-execution-candidates.md) · [SPEC-05](SPEC-05-extensions-install.md) | — |
| FR-09 | [SPEC-03](SPEC-03-data-history-export.md) | — |
| FR-10 | [SPEC-02](SPEC-02-execution-candidates.md) | — |
| FR-11 | [SPEC-00](SPEC-00-common.md) · [SPEC-02](SPEC-02-execution-candidates.md) | — |
| FR-12 | [SPEC-02](SPEC-02-execution-candidates.md) · [SPEC-03](SPEC-03-data-history-export.md) | — |
| FR-13 | [SPEC-05](SPEC-05-extensions-install.md) | — |
| FR-14 | [SPEC-03](SPEC-03-data-history-export.md) | — |
| FR-15 | [SPEC-02](SPEC-02-execution-candidates.md) · [SPEC-05](SPEC-05-extensions-install.md) | — |
| FR-16 | [SPEC-00](SPEC-00-common.md) · [SPEC-01](SPEC-01-project-input-sync.md) · [SPEC-02](SPEC-02-execution-candidates.md) · [SPEC-03](SPEC-03-data-history-export.md) · [SPEC-04](SPEC-04-web-review.md) · [SPEC-05](SPEC-05-extensions-install.md) | — |
| FR-17 | [SPEC-05](SPEC-05-extensions-install.md) | — |
| FR-18 | [SPEC-00](SPEC-00-common.md) · [SPEC-02](SPEC-02-execution-candidates.md) · [SPEC-03](SPEC-03-data-history-export.md) · [SPEC-04](SPEC-04-web-review.md) · [SPEC-05](SPEC-05-extensions-install.md) | — |
| FR-19 | [SPEC-04](SPEC-04-web-review.md) | — |
| FR-20 | 후속 확장 | PRD §14의 이번 범위 밖 |
| FR-21 | 후속 확장 | PRD §14의 이번 범위 밖 |
| FR-22 | [SPEC-03](SPEC-03-data-history-export.md) | — |

호스트 계약·실험 범위: [Rhino](hosts/rhino.md) · [ZWCAD](hosts/zwcad.md).

## 기능 검토 다음에 읽을 문서

[PLAN](../plans/PLAN.md) §1·§5.2·§6·§7.2에서 이 경험을 무엇으로 연결하고 어떤 순서로 검증할지 읽는다. 첫 프런트 흐름을 확인한 뒤 실제 호스트 후보를 연결하며, 전체 모의 화면을 먼저 완성하는 것을 제품 완료로 삼지 않는다.

[Design](../../Design.md) 0.9은 디자인 DNA와 화면 표현을 소유하며 §12에서 기능 SPEC을 참조한다. [PLAN](../plans/PLAN.md) §6.3~4에서 첫 구현 묶음과 기존 코드 이행을, §9.2에서 단계별 미결 의존성을 확인한다. [구현 전 문서 검수](../tdd/VERIFY-2026-09-20-preimplementation.md)는 문서 대조 결과와 실제 미시험을 구분한다.

문서 상세화·사용자 검토·실제 구현·지원 검수는 서로 다르다. 미결 의존성은 PLAN §9.1, 첫 과업의 구체 시험은 PLAN §7.2에 있다. 이번 수정은 사용자가 요청한 기능 해석의 보강이며 PRD의 제품 범위나 기존 검토 스레드의 수락을 대신하지 않는다.

개발 재개는 [개발 가이드 §12](../../DEVELOPMENT_GUIDE.md)를 따른다. 기능 동작은 이 명세에서 판단하고, 작업 순서/진행 현황은 PLAN §6.3·6.5를 사용한다. 기존 검토 부록을 별도 실행 지침으로 사용하지 않는다.
