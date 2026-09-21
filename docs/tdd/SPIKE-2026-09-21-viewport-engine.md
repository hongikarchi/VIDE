---
id: SPIKE-2026-09-21-viewport-engine
title: 3D 엔진 비교 · Three.js와 Babylon.js
status: review
version: 0.2
updated: 2026-09-22
owner: agent:codex
related: [PLAN, PLAN-01, SPEC-01, T-015, ADR-017]
---

# 3D 엔진 비교

## 질문·실험 코드

PLAN-01 §9의 선택 질문: 기존 Three.js를 교체해야 할 기능/성능 이점이 있는가? 실험은 `tools/spikes/2026-09-21-viewport-engine/`의 prepare.py, server.mjs, benchmark.mjs, capabilities.mjs로 재현한다. [수치 원본](../../tools/spikes/2026-09-21-viewport-engine/results.json)은 모델 형상·주소·속성을 포함하지 않는다. 실험 dependencies는 제품과 분리했다.

`npm --prefix tools/spikes/2026-09-21-viewport-engine ci --ignore-scripts` → `python tools/spikes/2026-09-21-viewport-engine/prepare.py <로컬 model.html>` → `node tools/spikes/2026-09-21-viewport-engine/server.mjs` → 브라우저에서 `http://127.0.0.1:4317/?engine=three`와 `?engine=babylon`을 순서대로 연다. 완료 후 window.__result를 수집한다. 정확성 시험은 같은 페이지에서 capabilities.mjs의 check('three'), check('babylon')을 순서대로 호출한다.

## 환경·범위

Windows, Chromium 153 headless, 실제 NVIDIA RTX 5070 Ti / ANGLE D3D11, WebGL, 1000×650·DPR 1. Three.js 0.186.0, Babylon.js 9.27.1. GPU 종류는 브라우저에서 확인했다. Aside 자체 측정이나 저사양 PC 검증은 아니다.

사용자가 제공한 논현동 model.html에서 groundDisplay의 지면 메시 240개·62,837 삼각형만 원래 뷰어 좌표(m, Y-up)로 복원했다. 건물·BIM 속성·보고서 전체를 재현한 시험이 아니다. 원문 스크립트를 실행하거나 비공개 모델을 업로드하지 않았다. 추출 형상은 git 제외 경로 .vide/viewport-spike/reference.json에만 둔다. 원문 해시는 수치 원본에 있다.

합성 1,000/10,000개 상자는 각각 별도 geometry/mesh로 만들었다. 양쪽 모두 같은 입력·카메라·단색 무조명 양면 재질·AA를 사용하며 배칭/인스턴싱/BVH/LOD/외곽선은 적용하지 않았다. 사용자 앱의 완성 성능보다 객체별 기본 비용을 비교하는 시험이다.

각 장면 3회 로드, 셰이더 준비를 기다린 첫 표시, 10프레임 워밍업 후 60프레임 카메라 이동, 30회 수직 ray 조회, 10개 객체 위치 갱신, 해제를 측정했다. 첫 표시는 다운로드 시간을 제외한다. renderFinish는 gl.finish를 포함한 CPU/GPU 동기 완료 시간이며 순수 GPU 시간이나 실사용 비동기 렌더 시간으로 해석하지 않는다. 프레임 시간은 60Hz 제한 영향을 받는다. 아래는 각 회차 지표의 중앙값(ms)이다.

## 실측

| 장면 | 엔진 | 첫 표시 | 프레임 p95 | renderFinish p50 | ray 조회 p95 | 10개 갱신+그리기 |
|---|---|---|---|---|---|---|
| 논현동 지면 240개 / 62,837 삼각형 | three | 5.7 | 16.8 | 0.4 | 1.5 | 0.3 |
| 논현동 지면 240개 / 62,837 삼각형 | babylon | 14.1 | 16.9 | 0.6 | 1.2 | 0.5 |
| 합성 1,000개 / 12,000 삼각형 | three | 11.4 | 16.8 | 1.2 | 0.1 | 0.7 |
| 합성 1,000개 / 12,000 삼각형 | babylon | 21.3 | 16.8 | 1.7 | 0.1 | 1.2 |
| 합성 10,000개 / 120,000 삼각형 | three | 207.9 | 18.8 | 16.8 | 0.7 | 18.3 |
| 합성 10,000개 / 120,000 삼각형 | babylon | 279.7 | 17.7 | 16.3 | 2.1 | 15 |

두 엔진 모두 각 반복 뒤 추적 geometry 수가 0으로 돌아왔다. 이는 엔진 geometry 해제 확인이며 전체 JS heap/GPU 메모리 누수 부재 증명은 아니다. 총 메모리 사용량은 측정하지 않았다.

## 정확성·시험 보정

두 엔진 모두 합성 상자의 원근/직교 객체 ID 선택, 삭제 후 선택 없음, 이동 후 ID 유지, 지정 평면 교차, 스케치 선 선택을 통과했다. 256×256 무AA 검정 배경에서 흰 상자 픽셀 16,384개가 x=0 clipping 후 8,192개로 줄어드는 것도 확인했다. 단면 캡·CAD 절단 연산 검증은 아니다.

큰 좌표 시험은 1,000,000m 원점을 분리한 뒤 1mm 차이를 float32로 올리고 복원하는 수치 검사이며 오차 0이었다. 실제 큰 좌표 장면 전체의 렌더/스냅 정확성을 증명하지 않는다. 끝점/교차점 스냅과 가려진 부분 선택의 제품 규칙, WebGL context loss/복구, React 재마운트, 대형 건물 전체는 후속 제품 회귀 대상으로 남긴다.

Babylon 첫 단면 시험은 셰이더 준비 전 픽셀을 읽어 0/0이 나왔다. 비동기 컴파일을 기다리도록 시험을 수정하자 정상 통과했다. 성능의 첫 표시도 두 엔진 모두 컴파일 완료를 기다리도록 보정했다. 엔진 결함으로 분류하지 않는다. 브라우저 세션 자동 종료 때 null로 수집된 결과는 제외하고 완료 결과를 다시 수집했다. 모듈 전체를 번들 없이 로딩한 import 시간은 배포 성능 비교에서 제외한다.

## 판단과 남은 검증

양쪽의 기본 기능은 가능하며 1만 객체 성능은 항목별로 엇갈린다. 이 실험은 Babylon의 교체 비용을 상쇄할 우위를 보여 주지 않았다. Three.js를 유지하고 책임 분리·부분 갱신·필요한 선택 가속을 구현한다(ADR-017). 최적화 없는 이 표로 어느 엔진의 최대 성능이 더 좋다고 주장하지 않는다. 제품 적용 뒤 실제 모델·입력·기존 보안 설정·React 수명·저사양 환경 회귀가 필요하다. 기술 선정 완료와 T-015 전체 완료는 다르다.

## AEC 뷰어 추가 코드 분석·로컬 실행 (2026-09-22)

사용자 지적에 따라 Speckle·xeokit을 문서 비교만으로 제외한 판단을 보완했다. 실험 package-lock에 @speckle/viewer 2.31.14, @xeokit/xeokit-sdk 2.6.114, Vite 8.3.0을 고정했다. 제품 dependencies는 바꾸지 않았다. Vite 설정과 aec.mjs·aec.html·aec.css가 추가 실험 코드다. `node tools/spikes/2026-09-21-viewport-engine/node_modules/vite/bin/vite.js build --config tools/spikes/2026-09-21-viewport-engine/vite.config.mjs` 후 같은 시험 서버의 `/dist/aec.html?engine=speckle` / `?engine=xeokit`에서 실행한다.

**Speckle 코드 확인:** 패키지에 Viewer.loadObject/unloadObject, SpeckleOfflineLoader, SelectionExtension, SectionTool/SectionOutlines, MeasurementsExtension, BatchObject와 AccelerationStructure가 있다. Three ^0.140.0, three-mesh-bvh 0.5.17을 사용한다. BatchObject에는 위치·회전·스케일 변환이 있고 BVH는 지역 원점을 분리한다. 호스트 원본 좌표·객체 정본을 대신하는 기능은 아니다.

**실제 로컬 실행:** 기본 SpeckleOfflineLoader의 배포 JS는 전달 데이터 대신 createFromObjects([])를 호출했고 getRootObject 오류가 재현됐다. initObjectLoader만 확장하여 실제 배열을 전달하자 계정·외부 서버 없이 240개 메시를 로드했다. 라이브러리가 입력 배열을 소비하므로 복사본을 넘겨야 재로딩 후 형상까지 유지됐다. ID 존재만 확인한 초기 결과를 시각 표시 성공으로 간주하지 않았고, 마지막에는 유한 scene bounds와 실제 화면을 확인했다. 원 자료의 Y-up을 Speckle의 Z-up으로 변환했다.

**CSP:** 제품과 같은 script/style/connect self를 적용했다. 기본 data URL 환경맵의 fetch는 connect-src 위반이었다. 환경맵을 비활성화하고 재질을 명시한 최종 실행에서는 위반 0건, 외부 HTTP origin 0개였다. 제품 보안 정책을 완화하지 않았다. 계정 없이 사용할 수 없다는 제외 이유는 잘못이다.

**Speckle 확인 범위:** 로컬 객체 ID·카메라/단면/측정 확장 생성·리소스 해제·수정 리소스 재로딩 후 ID·원 입력 보존 통과. 확장 생성은 실제 모든 측정/스냅 조작의 검증이 아니다. 정점 제자리 갱신은 이번 시험에서 구현하지 않았고 리소스를 다시 로드했다. 렌더러 info의 마지막 pass 수치가 0이어서 draw call 비교에 사용하지 않는다. 실제 표시 확인과 카운터 샘플링을 구분한다.

**xeokit 코드·실행:** SceneModel.createMesh/createEntity/finalize로 자체 형상을 직접 전달하므로 XKT/IFC 변환기·외부 서버가 필수는 아니다. 240개 메시 로딩·ID·선택 상태·SectionPlanes 생성·Entity.offset 이동·해제·같은 ID 재생성을 통과했다. SceneModelEntity/SceneModelMesh의 조사 범위에서 임의 정점 배열 setter는 확인되지 않아 위상 변경은 재생성 경로로 시험했다. SDK의 다른 ReadableGeometry 경로까지 불가능하다고 단정하지 않는다.

xeokit 기본 UI 코드의 inline style은 현 CSP에서 1건 차단됐다. 모델 표시는 확인했지만 해당 UI의 스타일 외부화 등 추가 호환 작업이 필요하다. Vite 빌드에서 fs/path 브라우저 외부화·CommonJS module 경고가 있었으며 이번 직접 메시 경로는 실행됐다. 사용하지 않은 파일 loader 전부의 호환을 보증하지 않는다.

두 AEC 뷰어 모두 동일 원자료를 표시했으나 기본 조명·후처리·배칭·카메라가 다르므로 loadMs를 Three/Babylon 성능표와 순위 비교하지 않는다. 최종 참고값은 Speckle 약 168ms, xeokit 약 83ms이며 단회 로더 시간이다. 수용 SLA나 엔진 최대 성능이 아니다. AEC 코드/호환 판단과 범용 엔진 통제 실험을 구분한다.

**판단:** 두 AEC 뷰어는 실제 대안이다. 즉시 사용할 조회·측정 도구의 이점이 있지만, VIDE의 원본 불변 입력·잦은 형상 변경·별도 도구 UX를 연결하는 추가 계층이 필요하다. 현재는 Three 유지+필요한 가속/도구 경계 구현을 선택한다. 근거는 PLAN-01 §9.2와 ADR-017이다. 개인정보를 담은 원본·형상·스크린샷은 커밋하지 않는다.
