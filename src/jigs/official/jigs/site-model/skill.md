---
name: 사이트 모델링
description: 주소·지번·PNU로 대상 필지를 찾아 사람이 확정하고, 공공 자료(지적·용도지역·건물·건축물대장)와 넣은 수치지형도 SHP로 대지·도로·주변 건물 매스·지형을 모아 대지 요약을 만들고 Rhino에 메타데이터와 함께 만듭니다.
examples:
  - ○○동 123-4 대지 모델링해 줘
  - 이 주소 사이트 모델 만들어 줘
  - 대지 주변 건물 매스 올려 줘
intent_en: build a site model from a Korean address or parcel number — parcels, roads, surrounding building masses, terrain and a site summary
words: [사이트 모델링, 대지 모델링, 대지 모델, 주변 건물, 지적도, 필지, 연속지적도, 수치지형도]
not_for: [법규 판단, 건축 가능 영역 계산, 건축개요 작성, 기존 객체 수정]
invocation: auto
tools: []
limits: [용도지역 경계 형상은 만들지 않음(점 조회), 도로 폭은 계산 값, 지형은 넣은 SHP가 있을 때만]
---

# 사이트 모델링

공식 jig `vide/site-model`(SPEC-12.3~12.6). 주소에서 후보 필지를 찾고(여럿이면 질문 카드),
사람이 대상 필지를 확정한 뒤, 공공 자료를 가져와 대지 요약과 Rhino 형상을 만든다.

- 언제: 규모검토를 시작할 때 대지와 주변을 모델로 세우고 싶을 때.
- 언제 아님: 법규의 판단, 가능 영역·외피 계산(건축 가능 영역·매스 jig), 개요 작성.
- 공공 자료로 보내는 것은 주소·PNU·좌표 범위뿐이며, 프로젝트에서 처음 보낼 때 한 번 확인을 받는다.
- AI는 후보를 고르지 않고, 수집 값·좌표를 고치지 않으며, Rhino에 만들지 않는다.
