---
name: 격자 골조 배치 예제
intent_en: place columns on a rotated grid inside a slab outline and connect neighbours with beams
words: [격자, 기둥 배치, 보 연결, 경간, 예제]
not_for: [실제 프로젝트 설계, 구조 해석, 기존 객체 수정]
tools: []
limits: [직사각형에 가까운 슬래브에서 잘 맞음, 보이드는 기둥만 피함, 캔틸레버·비정형 격자 없음]
---

# 격자 골조 배치 예제

jig 형식 v3의 본보기다. 슬래브 외곽선(역할 `outline`)과 보이드(`voids`)를 연결 파일에서 읽고,
격자 간격·각도로 기둥을 놓은 뒤 이웃 기둥을 보로 잇는다. 사람이 입력을 확인해야 보 단계가 돈다.

- 언제: 초기 스터디에서 격자 기둥 개수·경간을 빠르게 보고 싶을 때.
- 언제 아님: 실제 부재 설계나 해석. 결과는 탐색용이다.
- 예문: "격자를 9 m로 넓혀", "각도 15도로 돌려", "C3-2 기둥은 빼".
