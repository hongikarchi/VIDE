---
id: RESEARCH-09
title: 구조해석 프로그램 방식과 해석 코어 구현 언어 조사
status: review
version: 0.1
updated: 2026-09-29
owner: agent:claude
related: [RESEARCH-08, RESEARCH-05, RESEARCH-04, FR-21, OQ-07]
---

# 구조해석 프로그램 방식과 해석 코어 구현 언어 조사

## 1. 목적과 결론 요약

J-09 구조 분석 jig의 PLAN을 쓰기 전에 세 가지를 정리한다. 첫째, 상용·공개 구조해석 프로그램이 해석 모델·강구조 설계 검토·교환 형식·검증을 어떻게 다루는지 보고, VIDE가 둘 **해석 모델 계약**(해석기에 넘기는 모델 데이터의 약속된 형식)을 정한다. 둘째, midas 라이선스 없이 해석기·KDS 강구조 부재 검정·하중조합을 검증할 **구체 시험 케이스**를 고른다. 셋째, 해석 코어(3D 골조 유한요소 해석, 희소 행렬 해법, P-Δ, 이후 모드 해석)를 어떤 언어로 만들지 권고한다. RESEARCH-08의 자산(S-18 해석기·검정식·검증 체계)과 사용자 결정(도메인 지식 반입, midas 없음, 성능 우선, 언어 난이도는 고려하지 않음)을 전제로 한다.

**결론은 세 줄이다.** (1) midas·SAP2000/ETABS·RFEM·Karamba3D·PyNite·OpenSees·BHoM·IFC는 모두 같은 골격으로 수렴한다. 절점(지점)과 부재(재료·단면·방향각·단부해제·강체 오프셋)가 있고, 하중은 **하중 패턴 → 해석 경우 → 하중조합**의 세 층으로 나뉜다. 그 위에 비지지 길이·K·Cb를 "자동값 + 사용자 덮어쓰기"로 갖는 **설계 부재 층**이 얹힌다. VIDE는 이 골격을 평면 배열 JSON 계약으로 두고, 방향각 규약·오프셋 좌표계·단위·"P-Δ 결과는 합산 불가"를 명시해야 한다. (2) midas 없이도 해석기는 AISC 해설 C장 2차해석 벤치마크, CSI 공개 검증 예제, OpenSees 포털 골조 주기, PyNite 차분 시험으로 검증할 수 있다. 부재 검정은 AISC 설계 예제(STAAD 공개 대조 페이지가 중간값까지 제공)로 검증할 수 있다. 한국 고유 부분(KS 단면, 강재 등급별 항복강도, KDS 41 하중조합)은 공개 정답집이 없다. 이 부분은 손계산, 구조기술사 검토, 일회성 midas 체험판 또는 대학·사무소 협력으로 채운다. (3) 성능 우선이면 **Rust(faer 선형대수 라이브러리) 코어를 napi-rs 네이티브 애드온으로 Node 서버에 붙이는 안**을 권고한다. C# Native AOT 자식 프로세스(기존 MstCore2 재사용)는 차선, 순수 TypeScript(RESEARCH-08 A안)는 배포는 가장 쉽지만 해석 코어로는 권하지 않는다. 확정 전에 같은 S-18 모델로 후보를 재는 SPIKE를 한 번 한다(§5.5).

| 질문 | 답 | 근거 절 |
|---|---|---|
| 해석 모델을 어떻게 둘까 | 해석(이상화) 수준의 언어 중립 JSON 계약. 물리 부재와 해석 요소를 분리하고, 설계 부재 층은 해석 모델 위에 얹는다 | §2.1, §3 |
| midas 없이 무엇으로 검증하나 | 닫힌 해 → 공개 벤치마크 → PyNite 차분 → 불변량 → 한국 고유 손계산 → (선택) 상용 교차 | §4 |
| 어떤 언어로 만드나 | Rust + faer, napi-rs 애드온. SPIKE로 확정 | §5 |

## 2. 상용·공개 프로그램 비교

### 2.1 해석 모델은 여덟 개 도구 모두 같은 골격이다

아래 표는 해석 모델의 핵심 개념이 각 도구에서 어떻게 표현되는지 비교한다. 용어부터 풀면 다음과 같다. **단부해제**는 부재 끝의 특정 자유도(회전 등)를 풀어 핀처럼 만드는 것이다. **강체 오프셋**은 절점과 부재 끝 사이의 강한 구간이다. **방향각(beta angle)**은 부재 축을 중심으로 단면이 돌아간 각도다.

| 개념 | midas Gen (MGT) | SAP2000/ETABS | RFEM 6 | Karamba3D | 공개 모델(PyNite·OpenSees·BHoM·IFC) |
|---|---|---|---|---|---|
| 절점·지점 | `*NODE`, `*CONSTRAINT` 6자리 1/0 코드 ([MGT Quick Reference](http://manual.midasuser.com/EN_Common/Gen/891/Start/14_Appendix/MGT_File_Quick_Reference.htm)) | joint + restraint ([CSiRefer](https://docs.csiamerica.com/manuals/sap2000/CSiRefer.pdf)) | 절점 → 선 → 부재 ([Nodes](https://www.dlubal.com/en/downloads-and-information/documents/online-manuals/rfem-6/000037)) | 조립 시 5 mm 안의 점을 한 절점으로 병합 ([Assemble Model](https://manual.karamba3d.com/3-in-depth-component-reference/3.1-model/3.1.1-assemble-model.md)) | BHoM `Constraint6DOF`는 자유도마다 Free/Fixed/Spring+강성 ([Constraint6DOF.cs](https://github.com/BHoM/BHoM/blob/main/Structure_oM/Constraints/Constraint6DOF.cs)), IFC는 Boolean 또는 강성값 ([IfcBoundaryNodeCondition](https://github.com/buildingSMART/IFC4.3.x-development/blob/master/docs/schemas/resource/IfcStructuralLoadResource/Entities/IfcBoundaryNodeCondition.md)) |
| 부재 방향 | `*ELEMENT`의 `ANGLE`(beta) | FRAME LOCAL AXES 표 ([Strand7의 SAP2000 표 목록](https://www.strand7.com/strand7r3help/Content/Topics/FileFormats/FileFormatsSAP2000FileDefinitionTables.htm?TocPath=File+Formats%7CSAP2000+File%7C_____2)) | 시작→끝 절점 방향 ([Members](https://www.dlubal.com/en/downloads-and-information/documents/online-manuals/rfem-6/000039)) | 국부 Y를 전역 XY에 평행하게 두고, 연직 판정 임계값을 문서화 ([Orientate Element](https://manual.karamba3d.com/3-in-depth-component-reference/3.1-model/3.1.14-orientate-element)) | OpenSees `vecxz` 벡터 ([LinearTransf](https://openseespydoc.readthedocs.io/en/latest/src/LinearTransf.html)), PyNite `rotation`(도) ([FEModel3D.py](https://github.com/JWock82/Pynite/blob/main/Pynite/FEModel3D.py)), BHoM `OrientationAngle` ([Bar.cs](https://github.com/BHoM/BHoM/blob/main/Structure_oM/Elements/Bar.cs)) — 규약이 서로 다름 |
| 단부해제 | `*FRAME-RLS` 양단 6자유도, 부분 고정값 허용 | releases | 부재 힌지. 트러스 = 양단 모멘트 힌지 보 ([Main \| Members](https://www.dlubal.com/en/downloads-and-information/documents/online-manuals/rfem-6/006106), 스니펫) | 굽힘 강성 끄기로 트러스 ([LineToBeam](https://manual.karamba3d.com/3-in-depth-component-reference/3.1-model/3.1.6-create-linear-element/3.1.6-line-to-beam.md)) | PyNite 12개 플래그 `def_releases`, BHoM `BarRelease` = 양단 `Constraint6DOF` ([BarRelease.cs](https://github.com/BHoM/BHoM/blob/main/Structure_oM/Constraints/BarRelease.cs)) |
| 강체 오프셋 | `*OFFSET` GLOBAL/ELEMENT 선택 | insertion point / end offset | — | 편심 표시 | OpenSees `-jntOffset`는 **전역**, BHoM `Offset`은 **국부** 좌표 |
| 물리 부재 vs 해석 요소 | Member Assignment | 비지지 길이를 골조에서 자동 계산 | 부재 = 선 위의 물리 객체, member set = 설계 단위 ([Member Sets](https://www.dlubal.com/en/downloads-and-information/documents/online-manuals/rfem-6/000044)) | 식별 문자열·정규식으로 부재 선택 | PyNite `PhysMember`가 내부 절점에서 자동 분할 ([PhysMember.py](https://github.com/JWock82/Pynite/blob/main/Pynite/PhysMember.py)), Speckle v2 `parent` 연결 ([Element1D.cs](https://github.com/specklesystems/speckle-sharp/blob/main/Objects/Objects/Structural/Geometry/Element1D.cs)) |
| 하중 분류 | `*STLDCASE` 유형 코드(D, L, W, E…)가 조합 자동 생성의 입력 | load pattern → load case → combination ([CSI KB Load case](https://web.wiki.csiamerica.com/wiki/spaces/kb/pages/2005362)) | load case → action → design situation → 조합 ([Combination Wizards](https://www.dlubal.com/en/downloads-and-information/documents/online-manuals/rfem-6/000256)) | 하중 경우 + 조합 컴포넌트 | IFC LOAD_GROUP → LOAD_CASE → LOAD_COMBINATION, 경우-조합 쌍마다 계수 ([IfcStructuralLoadGroup](https://github.com/buildingSMART/IFC4.3.x-development/blob/master/docs/schemas/domain/IfcStructuralAnalysisDomain/Entities/IfcStructuralLoadGroup.md)) |
| 조합 | `*LOADCOMB` KIND(GEN/STEEL/CONC…), 선형합·SRSS ([Combinations](https://manual.midasuser.com/EN_Common/Gen/865/Start/07_Results/Combinations.htm)) | 합·포락 ([Load combination](https://web.wiki.csiamerica.com/wiki/spaces/kb/pages/2003069)) | 하중조합(비선형용) / 결과조합(중첩) 구분 | 3.1부터 포락 조합 ([New in 3.1](https://manual.karamba3d.com/new-in-karamba3d-3.1)) | BHoM `(계수, 경우)` 목록, 조합이 다른 조합을 참조 가능 ([LoadCombination.cs](https://github.com/BHoM/BHoM/blob/main/Structure_oM/Loads/LoadCombination.cs)) |
| P-Δ | 해석 제어 `PDEL-CTRL` ([MGT Command List](http://manual.midasuser.com/EN_Common/Gen/891/Start/14_Appendix/MGT_Command_List.htm)) | 질량 기반 비반복 / 하중 조합 기반 반복, 선형 경우 전체에 적용 ([Preset P-Delta Options](https://docs.csiamerica.com/help-files/etabs/Menus/Define/Preset_P_Delta_Options.htm)) | 조합 마법사가 불완전성 경우 생성 | `AnalyzeThII`: 모든 경우의 최대 압축력 하나로 강성 1회(보수적) 또는 경우별 ([AnalyzeThII](https://manual.karamba3d.com/3-in-depth-component-reference/3.5-algorithms/3.5.2-analyzethii)) | PyNite는 **조합마다** 반복 ([FEModel3D.py](https://github.com/JWock82/Pynite/blob/main/Pynite/FEModel3D.py)), OpenSees는 요소별 좌표변환 선택 ([geomTransf](https://openseespydoc.readthedocs.io/en/latest/src/geomTransf.html)) |
| 질량 | `*LOADTOMASS`(하중 경우 → 질량) | mass source | — | 질량·무게중심 출력 | PyNite `mass_combo_name` |
| 단위 | 파일 머리 `*UNIT` 한 번 | PROGRAM CONTROL 표 | — | 형상 단위와 입출력 단위가 따로 ([Physical Units](https://manual.karamba3d.com/2-getting-started/2-getting-started-1/2.3-physical-units.md)) | PyNite는 단위 체계가 없고 중력 기본값 1.0 |
| 결과 | 표·그림 | 표 | 결과 트리 | 모델에 결과를 붙여 다음 단계로 전달 ([Analyze](https://manual.karamba3d.com/3-in-depth-component-reference/3.5-algorithms/3.5.1-analyze)) | IFC 결과 묶음에 이론 차수와 `IsLinear`(중첩 가능 여부) ([IfcStructuralResultGroup](https://github.com/buildingSMART/IFC4.3.x-development/blob/master/docs/schemas/domain/IfcStructuralAnalysisDomain/Entities/IfcStructuralResultGroup.md)), BHoM `BarForce`는 (부재, 경우, 모드, 위치)로 키 ([BarForce.cs](https://github.com/BHoM/BHoM/blob/main/Structure_oM/Results/Bar%20Results/BarForce.cs)) |

**가장 중요한 교훈은 CSI의 세 층 분리다.** 하중 패턴은 공간 분포, 해석 경우는 패턴을 가해 실제로 푸는 해석, 조합은 경우 결과의 합이나 포락이다 ([CSI KB Load combination FAQ](https://web.wiki.csiamerica.com/wiki/spaces/kb/pages/2011279/Load+combination+FAQ)). 결과 합산은 선형 해석에서만 성립한다. P-Δ처럼 비선형인 해석은 조합마다 따로 풀어야 한다. PyNite도 P-Δ를 조합 단위로 반복하고 ([FEModel3D.py](https://github.com/JWock82/Pynite/blob/main/Pynite/FEModel3D.py)), IFC는 결과 묶음에 `IsLinear`를 붙여 이 구분을 데이터로 남긴다. S-18의 LRFD 조합은 23개이므로, 계약이 이 구분을 담지 않으면 P-Δ 결과를 잘못 합산하는 오류가 구조적으로 생길 수 있다(추론).

**둘째 교훈은 해석 모델의 수준이다.** Awatif는 데이터를 의미(파라메트릭 구성요소) → 이상화(곡선·면) → 이산(유한요소 메시)의 세 층으로 나누고, 이 절차가 대부분의 FEM 프로그램에 공통이라고 설명한다 ([Awatif 블로그](https://awatif.co/blog/awatif-new-data-structure-for-structural-engineering/)). VIDE 계약은 가운데 층(해석선·절점)에 두고, 요소 분할은 해석 어댑터가 맡는 것이 맞다(추론).

### 2.2 설계 검토 흐름은 자동값과 사용자 덮어쓰기를 함께 저장한다

| 프로그램 | 설계 단위 | 비지지 길이·K·Cb | 결과 표시 | 한국 기준 |
|---|---|---|---|---|
| midas Gen | Member Assignment로 여러 해석 요소를 한 부재로 묶음 | Ly·Lz를 입력하지 않으면 요소 길이 사용 ([Unbraced Length](https://support.midasuser.com/hc/en-us/articles/24505746832025-Unbraced-Length), 스니펫). K는 입력 또는 자동 계산 ([midas KB](https://gtc.midasuser.com/helpdesk/KB/View/10333732--design-how-is-effective-length-factor-calculated-)) | OK / OK*(강도 만족, 세장비 초과) / NG / NG*. 최대 검정비와 지배 조합, 전단비, 표에 Ly·Lz·Lb·Ky·Kz·Cmy·Cmz·Cb ([Steel Code Check](http://manual.midasuser.com/EN_Common/Gen/885/Start/08_Design/Steel_Code_Check.htm)) | 구판 매뉴얼은 KSSC-LSD09 등. NX는 "KDS 41 30:2022" 설계표가 있음(제목만 확인, [MIDAS Support](https://support.midasuser.com/hc/en-us/articles/57474427261465-DESIGN-STEEL-KDS-41-30-2022-TABLE-Steel-Member-Design-Forces)) |
| SAP2000/ETABS | 프레임 객체 | 비지지 길이 비(기본은 프로그램 계산 = 1), K, Cb 덮어쓰기(overwrite) ([Effective length factor](https://wiki.csiamerica.com/display/kb/Effective+length+factor)) | 코드별 설계 매뉴얼 공개 ([SFD-AISC-360-05](https://docs.csiamerica.com/manuals/sap2000/Design/SFD-AISC-360-05.pdf)) | ETABS KBC 2016 강골조(v18+). KDS 강구조 항목은 요약 문구가 뒤섞여 있어 미확인 ([ETABS enhancements](https://www.csiamerica.com/products/etabs/enhancements)) |
| RFEM 6 | member set | 설계 add-on에서 지정 | "Design Check Details" 트리: 입력 → 중간값 → 조항 결과 ([Design Check Details](https://www.dlubal.com/en/downloads-and-information/documents/online-manuals/rfem-6-steel-design/000286)) | KDS 지원 미확인 |
| Karamba3D | 요소·그룹 | 끝에서 세 개 이상 부재가 모이는 절점까지 걸어 좌굴 길이를 추정. 매뉴얼 스스로 트러스 현재 등에서 **"unsafe"**라고 경고 ([Optimize Cross Section](https://manual.karamba3d.com/3-in-depth-component-reference/3.5-algorithms/3.5.8-optimize-cross-section)) | Util 합계와 N·V·M별 분해, 지배 하중 경우, 부재당 기본 3점 표본. EC3만 지원 ([Utilization](https://manual.karamba3d.com/3-in-depth-component-reference/3.6-results/3.7.1-general-results/3.6.6-utilization-of-elements)) | 없음 |

공통 원칙은 **설계 변수를 해석 모델 위의 덮어쓰기 층으로 두는 것**이다. 기하에서 자동값을 만들고, 사용자가 값별로 덮어쓰며, 보고서는 둘을 구분해 보인다. Karamba의 "unsafe" 경고는 건축가용 도구의 가장 큰 위험이 **자동 추정한 K·Lb**라는 점을 보여 준다. 따라서 이 값은 항상 보이고, 편집할 수 있고, "가정"으로 표시돼야 한다. 단면 최적화에서 Karamba는 "순서 목록에서 처음 만족하는 단면"을 기본 5회 반복한다. S-18에서는 무게순 첫 만족 단면이 최경량이 아니었던 결함이 있었다(RESEARCH-08 §4). 따라서 VIDE는 전수 비교를 기본으로 해야 한다.

### 2.3 교환 형식

| 형식 | 형태 | 공개·안정성 | VIDE 용도 |
|---|---|---|---|
| midas MGT/MCT | `*KEYWORD` 블록 + `;` 주석 필드 순서 + 쉼표 행. 공식 Command List·Quick Reference가 있으나 판 번호가 붙은 스키마는 없음 ([MGT Command List](http://manual.midasuser.com/EN_Common/Gen/891/Start/14_Appendix/MGT_Command_List.htm)). 가져올 때 하중·지점은 **누적**되고 기하는 **교체**됨 ([MGT Command Shell](http://manual.midasuser.com/EN_Common/Gen/925/Start/11_Tools/MGT_Command_Shell.htm)) | 내보낸 파일에 흔한 `*USE-STLD`는 공식 페이지에서 미확인 | **쓰기 전용 부분집합** 우선: UNIT, NODE, ELEMENT, MATERIAL, SECTION, CONSTRAINT, FRAME-RLS, OFFSET, STLDCASE, SELFWEIGHT, CONLOAD, BEAMLOAD, LOADCOMB, LOADTOMASS, STORY. 가져오기는 판 차이 위험으로 후순위 |
| MIDAS API (NX) | JSON REST. 중계 서버 → WebSocket → 실행 중인 GEN/CIVIL NX. 사용자별 MAPI-Key ([How to work MIDAS CIVIL NX Open API?](https://support.midasuser.com/hc/en-us/articles/30212837484441-How-to-work-MIDAS-CIVIL-NX-Open-API), 스니펫). `/db/NODE`, `/db/ELEM`, `/db/STLD`, `/db/LCOM` 등 ([MIDAS Python docs](https://midas-rnd.github.io/midasapi-python/)) | NX 설치·라이선스가 필요. 약관 미확인 | 지금은 쓸 수 없음. 4글자 키는 계약의 이름 선례 |
| CSI .s2k/.e2k | 이름 붙은 표의 집합(JOINT COORDINATES, CONNECTIVITY - FRAME, LOAD PATTERN DEFINITIONS …) ([Strand7 목록](https://www.strand7.com/strand7r3help/Content/Topics/FileFormats/FileFormatsSAP2000FileDefinitionTables.htm?TocPath=File+Formats%7CSAP2000+File%7C_____2)) | 행 문법은 이번 조사에서 미확인 | 후순위 |
| RFEM 6 API | SOAP 웹서비스(구) / gRPC Dlubal API(신, 초기 시험 약 15배 빠르다는 업체 주장) ([Dlubal API](https://www.dlubal.com/en/support-and-learning/support/product-features/002956)) | 업체 자체 보고 | 해당 없음 |
| IFC 구조해석 뷰(SAV) | 해석 모델·곡선 부재·점 연결·편심·하중 묶음·결과 묶음 | 채택이 약함. Archicad에서는 "실험 기능" ([Graphisoft](https://community.graphisoft.com/t5/Collaboration-with-other/Structural-Analytical-Model-Exchange/ta-p/304054)), CAD는 보통 물리 형상 뷰만 내보냄 ([Dlubal KB 001472](https://www.dlubal.com/en/support-and-learning/support/knowledge-base/001472)) | 의미 정의만 참고 |
| Speckle | v2 `Objects.Structural`은 저장소 보관(archived) ([speckle-sharp](https://github.com/specklesystems/speckle-sharp)). v3 SDK에는 Structural 네임스페이스가 없고 `EtabsObject` 같은 호스트별 객체로 바뀜 ([speckle-sharp-sdk](https://github.com/specklesystems/speckle-sharp-sdk), [ETABS schema](https://docs.speckle.systems/developers/data-schema/connectors/etabs-schema)) | 공통 구조 스키마를 사실상 포기 | 전송·뷰어 선택지일 뿐 계약으로 쓰지 않음 |
| BHoM 어댑터 | ETABS·SAP2000·Robot·GSA·RFEM6·**MidasCivil** 어댑터, 모두 LGPL-3 ([MidasCivil_Toolkit](https://github.com/BHoM/MidasCivil_Toolkit)) | 유지 중(같은 날 일괄 갱신, 기능 범위는 미확인) | MCT 쓰기 구현 참고 |
| OpenSees `print -JSON` | 모델 덤프 ([printModel](https://openseespydoc.readthedocs.io/en/latest/src/printModel.html)) | 출력 형식일 뿐 판이 붙은 입력 스키마가 아님 | 쓰지 않음 |

Karamba 3.1은 ETABS E2K·SAP2000 S2K·SAF·IFC 내보내기를 둔다 ([New in 3.1](https://manual.karamba3d.com/new-in-karamba3d-3.1)). 초기 설계 도구가 최종 검토는 상용 프로그램에 넘기는 것이 업계 관행이다. 한국에서 그 대상은 흔히 midas다. 다만 사용자 확인(2026-09-29)으로는 구조사무소와 보통 **CAD·Rhino 파일**로 주고받으며, MGT로 넘겨 midas에서 바로 검토한 것은 S-18의 고유 방식이다. 따라서 VIDE의 기본 교환은 CAD·Rhino 파일이고, MGT 쓰기는 프로젝트별 선택 내보내기로 둔다.

### 2.4 검증 공개 수준은 도구마다 크게 다르다

CSI는 예제별 검증 PDF를 공개한다. 각 PDF에는 입력, 독립 해(교과서 값), 차이 %가 모두 있다 ([CSI Verification examples](https://web.wiki.csiamerica.com/wiki/spaces/doc/pages/1245534/Verification+examples)). Bentley STAAD.Pro는 AISC 설계 예제를 다시 풀어 중간값까지 공개한다. Dlubal도 검증 예제 목록을 공개하지만 스크립트로는 페이지가 렌더링되지 않았다 ([Dlubal Verification Examples](https://www.dlubal.com/en/downloads-and-information/examples-and-tutorials/verification-examples)). midas의 "Benchmarks & Verification Manuals" 항목은 조사 시점에 404였다 ([midas KB](https://globalsupport.midasuser.com/helpdesk/KB/View/5944326-benchmarks--verification-manuals)). Karamba는 공식 검증 문서 없이 2018년 석사논문(EC3 검정의 RFEM 비교)을 안내할 뿐이다 ([McNeel 포럼](https://discourse.mcneel.com/t/validation-reports/73781)). PyNite는 교과서 문제를 CI에서 매번 돌린다 ([PyNite](https://github.com/JWock82/Pynite)). 파라메트릭 도구 생태계에서 검증 자료의 부족은 알려진 신뢰도 약점이다. VIDE는 첫 단계부터 자체 검증 목록을 함께 배포하는 것으로 이를 차별점으로 삼을 수 있다(추론).

## 3. 해석 모델 계약 제안

계약의 물리 필드는 ARCH가 소유한다(AI.md §1). 여기서는 필드 후보와 각 필드가 따른 선례만 제안한다. 형태는 **문자열 ID를 가진 평면 배열**이다. 하중은 부재 밑에 넣지 않고 대상 집합을 참조한다(BHoM 방식). 이렇게 하면 약 2,000부재에서도 JSON이 작고 차분(diff)하기 쉽다(추론).

| 묶음 | 핵심 필드 | 따른 선례 | 계약에서 정할 것 |
|---|---|---|---|
| `meta` | `schemaVersion`, `units`{length, force, angle, temperature}, `gravity` 벡터, `modelType`, `source`(Rhino 문서·객체 GUID) | Speckle ModelUnits ([Analysis](https://github.com/specklesystems/speckle-sharp/tree/main/Objects/Objects/Structural/Analysis)), IFC `SelfWeightCoefficients` ([IfcStructuralLoadCase](https://github.com/buildingSMART/IFC4.3.x-development/blob/master/docs/schemas/domain/IfcStructuralAnalysisDomain/Entities/IfcStructuralLoadCase.md)), midas `*UNIT` | 내부 단위 하나와 표시 단위를 분리. 연직축을 명시 |
| `nodes[]` | `id`, `xyz`, `support`{dx…rz: `true`/`false`/강성값}, `supportAxes?`(경사 지점), `mass?` | BHoM Constraint6DOF, IFC BoundaryNodeCondition·ConditionCoordinateSystem ([IfcStructuralPointConnection](https://github.com/buildingSMART/IFC4.3.x-development/blob/master/docs/schemas/domain/IfcStructuralAnalysisDomain/Entities/IfcStructuralPointConnection.md)) | -1 같은 특수값 금지 |
| `materials[]` | `id`, `grade`(SS275·SM355 등), `E`, `G` 또는 `nu`, `density`, `Fy`, `Fu` | PyNite `add_material`, midas `*MATERIAL` | 두께별 Fy 저감은 검정 층에서 |
| `sections[]` | `id`, `source`(KS 표/사용자), `shape`(H·BH·박스·강관·L·C) + 치수, 계산 성질 A·Iy·Iz·J·Zy·Zz·Avy·Avz·Cw | PyNite `add_steel_section`, midas `*SECTION DBUSER`, BHoM SectionProperties ([폴더](https://github.com/BHoM/BHoM/tree/main/Structure_oM/SectionProperties)) | 성질은 치수에서 엔진이 계산하고 KS 표와 대조 |
| `members[]`(해석 요소) | `id`, `i`, `j`, `material`, `section`, `orientation`{`angle` 또는 `vector`}, `releases`{i[6], j[6]}, `offsets`{i, j, `frame`: global/local}, `kind`(flexural/truss/tensionOnly/compressionOnly), `parent` | midas `*ELEMENT`·`*FRAME-RLS`·`*OFFSET`, OpenSees `vecxz`·`-jntOffset`, BHoM Bar, Speckle v2 Element1D | 방향 규약 하나, 연직 부재 예외, 오프셋 좌표계 |
| `physicalMembers[]` | `id`(Rhino GUID 기반 안정 ID), 절점열, `role`(보·기둥·가새), `autoSplit` | PyNite PhysMember, RFEM 선 위 부재, GSA "Members" ([GsaGH](https://github.com/arup-group/GSA-Grasshopper)) | 재분할 뒤에도 결과를 Rhino 객체로 되돌림 |
| `stories[]`, `rigidLinks[]`, `diaphragms[]` | 층 이름·높이, 주·종 절점과 자유도, 강막 여부 | midas `*STORY bFLDIAP`·`*RIGIDLINK` | 강막은 지진·모드 단계에서 |
| `loadPatterns[]` | `id`, `nature`(D, L, Lr, S, W, E…), `actionType`(영구/변동/우발), `selfWeight` 벡터 | CSI load pattern, midas `LCTYPE`, IFC `IfcActionTypeEnum` ([md](https://github.com/buildingSMART/IFC4.3.x-development/blob/master/docs/schemas/domain/IfcStructuralAnalysisDomain/Types/IfcActionTypeEnum.md)), BHoM Loadcase.Nature | `nature`가 KDS 41 10 15 조합 생성의 입력 |
| `loads[]` | `pattern`, `type`(절점·부재 집중·부재 분포·면·강제 변위), `targets[]`, `axis`(global/local), `projected`, 값과 위치(상대/절대) | BHoM BarVaryingDistributedLoad ([file](https://github.com/BHoM/BHoM/blob/main/Structure_oM/Loads/BarVaryingDistributedLoad.cs)), midas `*BEAMLOAD`, PyNite `FX`(전역)/`Fx`(국부) | 좌표축 표기를 대소문자에 맡기지 않음 |
| `analysisCases[]` | `id`, `kind`(linearStatic, pDelta, modal, 이후 responseSpectrum), `patterns[{id, factor}]` 또는 대상 조합, P-Δ{방법, 허용치, 최대 반복} | CSI load case, midas `PDEL-CTRL`, Karamba AnalyzeThII | P-Δ는 조합마다 풀어야 함 |
| `massSource` | 자중 포함, 패턴·계수, 방향 | midas `*LOADTOMASS`, PyNite `analyze_modal` | 모드 단계에서 사용 |
| `combinations[]` | `id`, `kind`(add, envelope, abs, srss), `terms[{ref, factor}]`, `limitState`(강도/사용성), `generatedBy`(KDS 규칙 ID 또는 user), `tags` | BHoM (계수, 경우) 쌍, IFC 쌍별 계수, midas `KIND`, PyNite `combo_tags` | Speckle v2의 병렬 배열(경우 목록 + 계수 목록)은 어긋나기 쉬워 피함 |
| `designMembers[]` | `elements[]`, `Ly`·`Lz`·`Lb`·`Ky`·`Kz`·`Cb`·`Cm`, 값마다 {auto, user, 근거} | midas Member Assignment, CSI overwrite, RFEM member set | 자동값은 "가정" 표시 |
| `results` | 결과 묶음{대상, `theory`(1차/2차), `isLinear`}, 절점 변위·반력, 부재력(부재, 경우, 모드, 위치), 모드 주기·참여율 | IFC StructuralResultGroup, BHoM BarForce | 2차 결과에는 합산 금지 표시 |
| `checks` | 부재별 검정비, 지배 조합, 조항, 중간값 트리, 상태(pass/fail/incomplete/error), 세장비 초과 별도 표시 | RFEM Design Check Details, midas OK*·NG*, Karamba Util 분해, S-18 `assessment` 4상태(RESEARCH-08 §3.7) | 검토하지 않은 항목을 명시 |

계약에서 피해야 할 함정은 모두 출처에 증거가 있다.

| 함정 | 증거 | 계약 규칙 |
|---|---|---|
| 방향각 규약 불일치 | BHoM은 "국부 z = 전역 Z"에서 회전하고 연직 부재는 별도 규약 ([Bar.cs](https://github.com/BHoM/BHoM/blob/main/Structure_oM/Elements/Bar.cs)). IFC는 `Axis` 방향 ([IfcStructuralCurveMember](https://github.com/buildingSMART/IFC4.3.x-development/blob/master/docs/schemas/domain/IfcStructuralAnalysisDomain/Entities/IfcStructuralCurveMember.md)). OpenSees는 `vecxz`, PyNite는 자체 기준의 `rotation` | 규약 하나와 연직 예외를 정하고, 엔진 간 회전 시험을 둠(PyNite `test_member_rotation` 선례) |
| 오프셋 좌표계 | OpenSees는 전역, BHoM은 국부. IFC는 편심 모델이 둘이고 "지역 합의"에 맡김 ([IfcRelConnectsWithEccentricity](https://github.com/buildingSMART/IFC4.3.x-development/blob/master/docs/schemas/domain/IfcStructuralAnalysisDomain/Entities/IfcRelConnectsWithEccentricity.md)) | `frame` 필드 필수 |
| 지점과 단부해제 혼동 | BHoM이 "Releases와 혼동하지 말 것"이라고 명시. IFC 단부해제는 부재 국부축 기준 ([IfcRelConnectsStructuralMember](https://github.com/buildingSMART/IFC4.3.x-development/blob/master/docs/schemas/domain/IfcStructuralAnalysisDomain/Entities/IfcRelConnectsStructuralMember.md)) | 같은 6자유도 타입을 쓰되 소속을 분리 |
| 단위 | PyNite는 단위 체계가 없고 중력 기본값이 1.0 ([FEModel3D.py](https://github.com/JWock82/Pynite/blob/main/Pynite/FEModel3D.py)). Karamba는 단위 체계가 둘 | 모델 수준에서 한 번 선언. Rhino 문서(보통 mm)와 분리 |
| P-Δ 결과 합산 | PyNite는 조합별 반복, IFC `IsLinear` | 2차 결과는 조합으로 풀고 합산하지 않음 |
| 병합 허용오차 | Karamba 기본 5 mm 병합과 중복선 제거 정보 출력 ([LineToBeam](https://manual.karamba3d.com/3-in-depth-component-reference/3.1-model/3.1.6-create-linear-element/3.1.6-line-to-beam.md)), PyNite `merge_duplicate_nodes(tolerance=0.001)` | 허용오차를 사용자에게 보이고, 병합·제거 목록을 결과에 남김 |
| 기구(불안정) 모델 | Karamba 문제 해결 목록: 지점 누락, 회전 지점 옆 힌지, 축 회전 부재, 트러스 절점 회전 ([Troubleshooting](https://manual.karamba3d.com/troubleshooting/4.3.-miscellaneous-problems/4.1.5-definitions-and-components)) | 해석 전 모델 점검에서 해당 자유도를 뷰포트에 표시(S-18 기구 탐지 이식) |

## 4. midas 없는 검증 계획

검증은 여섯 층으로 쌓는다. 순서는 ① 닫힌 해, ② 공개 벤치마크(AISC·CSI·OpenSees), ③ PyNite 차분 시험, ④ 불변량, ⑤ 한국 고유 손계산과 전문가 검토, ⑥ 선택적 상용 교차다. S-18은 이미 ①③과 MGT 왕복을 갖췄다(닫힌 해 43건, PyNite 대비 변위 차 ≤ 3e-10 mm, RESEARCH-08 §3.1). 이 절은 거기에 ②④⑤를 더한다. 아래 BM 번호는 이 문서 안의 표기이며 제품 ID가 아니다.

### 4.1 시험 케이스

| 번호 | 이름 | 출처 | 입력 | 기대값 | 허용오차 | 단계 |
|---|---|---|---|---|---|---|
| BM-01 | AISC 2차해석 벤치마크 Case 1(횡지지 보-기둥) | [MASTAN2 LM7](https://www.mastan2.com/stabilityfun/7_SecondOrderEffects.pdf), [PyNite 시험](https://raw.githubusercontent.com/JWock82/PyNite/main/Testing/test_AISC_PDelta_benchmarks.py), [CSI ETABS KB](https://web.wiki.csiamerica.com/wiki/spaces/etabs/pages/1474593/AISC+stability+benchmark+problems+P-+and+P-+effect) | W14x48 강축, 핀-핀 L = 28 ft(336 in), E = 29,000 ksi, I = 484 in⁴, 등분포 0.2 kip/ft, P = 0·150·300·450 kip, 중간 절점 1개 이상, 전단변형 제외 | 중앙 M = 235·269·313·375 kip-in, 중앙 Δ = 0.197·0.224·0.261·0.311 in | AISC 기준 모멘트 3%·처짐 5%. 닫힌 식 대비 1%(추론) | 1(P-Δ) |
| BM-02 | 같은 벤치마크 Case 2(캔틸레버) | 위와 같음 | 같은 단면, L = 28 ft 캔틸레버, 끝 수평 1.0 kip, P = 0·100·150·200 kip, 중간 절점 2개 | 기부 M = 336·469·598·848 kip-in, 끝 Δ = 0.901·1.33·1.75·2.56 in | 같음 | 1 |
| BM-03 | 닫힌 해 캔틸레버 P-Δ | [PyNite 시험](https://raw.githubusercontent.com/JWock82/PyNite/main/Testing/test_AISC_PDelta_benchmarks.py) | L = 20 ft, H = 5 kip, P = 100 kip, I = 100 in⁴ | M = HL·tanα/α, y = (HL³/3EI)·3(tanα−α)/α³, α = √(PL²/EI) | 1% | 1 |
| BM-04 | CSI 1-019 강접 골조 좌굴 | [CSI Problem 1-019](https://docs.csiamerica.com/manuals/sap2000/Verification/Analysis/Frames/Problem%201-019.pdf) | 1층 1경간 144×144 in, W8X31(A = 9.12 in², I = 110 in⁴), E = 29,900 ksi, 휨변형만(면적 배율 100,000, 전단면적 0), 면내 좌굴 | 임계하중 280.19 kip(고전 안정 교과서 1961). 부재당 요소 1·2·4개에서 CSI 결과 280.98·280.24·280.19 | 요소 4개 기준 0.1%, 요소 수에 따라 단조 수렴(추론) | 좌굴(2) |
| BM-05 | OpenSees 2D 포털 골조 주기 | [OpenSeesPy Portal Frame 2d](https://openseespydoc.readthedocs.io/en/latest/src/PortalFrame2d.html), [PortalFrame2d.tcl](https://github.com/OpenSees/OpenSees/blob/master/EXAMPLES/verification/PortalFrame2d.tcl) | 2경간 7층, E = 29,500, W24 보, 층고 162/156 in, 집중 질량 | 주기 1.27321, 0.43128, 0.24204, 0.16018, 0.11899, 0.09506, 0.07951 s(SAP2000과 동일) | 1%(추론) | 모드(2) |
| BM-06 | AISC 설계 예제 F.1-2B(3등분점 횡지지 보 LTB) | [STAAD 검증 페이지](https://docs.bentley.com/LiveContent/web/STAAD.Pro%20Help-v2024/en/topics/Verification/Design%20Steel%20AISC%20360/v-stpst_AISC_360-16_W_LTB_Test_F.1-2B.html) | W18×50, 단순 경간 35 ft, A992 Fy = 50 ksi, 양단·3등분점 횡지지(Lb = 11.7 ft) | Cb = 1.01(중앙 구간, 지배)·1.45(끝 구간), Mp = 5,050 kip-in, Lp = 5.8339 ft, Lr = 16.964 ft, rts = 0.16521 ft, φbMn = 304.7 kip-ft(STAAD 305.5), 지배 조항 F2.2 | 중간값 0.5~1%(설계 예제의 반올림 고려, 추론), 지배 조항 일치 | 1(검정) |
| BM-07 | 같은 계열 LTB·Cb 풀이(AISC 360-22) | [Dlubal KB 001884](https://www.dlubal.com/en/support-and-learning/support/knowledge-base/001884), [KB 001679](https://www.dlubal.com/en/support-and-learning/support/knowledge-base/001679) | W18X50, 등분포, 양단·3등분점 횡지지, A992 | 수치 미추출 — 수동 확인 필요 | BM-06과 같음 | 1 |
| BM-08 | AISC 설계 예제 E.1·F.1-1·F.1-3·F.2·G.1·H.1 | [AISC Manual Companion](https://www.aisc.org/aisc/publications/steel-construction-manual/manual-companion-for-16th-edition/) (aisc.org는 스크립트 접근 403, 브라우저로 수동 내려받기) | 압축 E3, 휨 F2·F3, 채널, 전단 G2, 조합 H1-1 | 예제 번호는 장 체계로 추정한 것이며 미확인. 내려받은 뒤 채움 | 중간값 0.5~1%, 판정 완전 일치 | 1 |
| BM-09 | B1 증폭계수 연구 | [MASTAN2 LM7](https://www.mastan2.com/stabilityfun/7_SecondOrderEffects.pdf) | M1/M2 = +0.75·0·−0.75, P/Pe = 0~0.9 | 엄밀 2차해석 결과 대 부록 8 식 A-8-3의 B1(동봉 스프레드시트) | 3%(추론) | 2 |
| BM-10 | PyNite 차분 시험 | [PyNite](https://github.com/JWock82/Pynite)(MIT, [LICENSE](https://raw.githubusercontent.com/JWock82/PyNite/main/LICENSE)) | 무작위 소형 3D 골조: 단부해제, 회전한 국부축, 혼합 하중, 선형·P-Δ | PyNite 결과 | 선형 1e-6 상대(추론. S-18 선례는 3e-10 mm) | 1 |
| BM-11 | 불변량 | 표준 유한요소 관행(개별 출처 없음). PyNite 시험 폴더의 평형·침하·단부해제·회전·불안정 시험을 본뜸 ([Testing](https://github.com/JWock82/PyNite/tree/main/Testing)) | 모든 fixture 모델 | Σ반력 + Σ하중 = 0, 전체 강체 회전 불변, 대칭 모델 → 대칭 결과, 선형 중첩 = 조합 결과, 단위계 불변, 절점 순서 불변, 기구 탐지 | 평형 1e-8 상대(추론) | 1 |
| BM-12 | KS 단면 성질 | KS D 3502 무료 원문 보기 ([e나라표준인증](https://standard.go.kr/KSCI/standardIntro/getStandardSearchView.do?menuId=919&topMenuId=502&upperMenuId=503&ksNo=KSD3502&tmprKsNo=KSD3502&reformNo=15)) | 치수(h, b, t1, t2, r) | 엔진이 계산한 A·I·Z·J·Cw를 KS 표 값과 대조(S-18 H 34종, S-10 H 53종) | 0.5%(필렛 근사 차이, 추론) | 1 |
| BM-13 | KDS 하중조합 생성 | KDS 원문([KCSC 목록](https://www.kcsc.re.kr/standardCode/list), 웹 뷰어) + S-18 LRFD 조합 23개 | 하중 패턴 `nature` 집합 | 조합 목록과 계수 | 완전 일치, 구조기술사 검토 | 1 |
| BM-14 | MGT 왕복·반입 | S-18 `mgt_roundtrip.py`(RESEARCH-08 §3.8) | 내보낸 MGT | 다시 읽은 모델 = 원 모델. midas에서 실제로 불러 해석 결과를 대조(§4.3) | 필드 완전 일치 | 3 |

CSI·AISC 문서는 저작권 문서다. 따라서 저장소에는 PDF를 복사하지 않고 입력과 독립 해 값만 식으로 다시 유도해 넣는다. 예제 ID와 URL은 인용으로 남긴다(추론). BM-01·02의 PyNite 값은 AISC 해설 그림의 "전단변형 제외" 값이다. 조사 노트에서 닫힌 식으로 같은 값을 재현했으므로(Case 2 기부 M 336.0·469.1·598.7·849.0), fixture는 AISC 그림을 베끼지 않고 기대값을 스스로 계산할 수 있다. 부재 검정 fixture는 최종 검정비만이 아니라 λ, λp, λr, Fcr, Lp, Lr, Cb, Mn, Vn, H1-1 비까지 **중간값 단위로** 단언해야 실패 위치를 좁힐 수 있다(추론).

### 4.2 한국 고유 부분은 공개 정답집이 없다

KDS 본문은 국가건설기준센터 웹 뷰어와 법령 포털에서 무료로 읽을 수 있다 ([KCSC 뷰어 예](https://www.kcsc.re.kr/standardCode/viewer/KDS%2014%2031%2005:2024-05-03), [law.go.kr 건축구조기준](https://www.law.go.kr/%ED%96%89%EC%A0%95%EA%B7%9C%EC%B9%99/%EA%B1%B4%EC%B6%95%EA%B5%AC%EC%A1%B0%EA%B8%B0%EC%A4%80)). 뷰어가 JS 앱이라 자동 수집은 어렵다. 그래서 본문 대신 **조항 번호를 저장**하는 방식이 맞다. 2017년 KDS 14 31 10 등의 신구조문 대비표 ([CODIL](https://www.codil.or.kr/filebank/moct2014//201902/MOCT1998_2.PDF?nserialno=1998))와 구 LRFD 강구조설계기준 전문(2009, [CODIL PDF](https://www.codil.or.kr/filebank/construction/DC/CIGCDCD90150/CIGCDCD90150.pdf))은 공개돼 있다. 그러나 AISC 설계 예제에 해당하는 **무료 한국 풀이집은 찾지 못했다**. 학회 해설서는 상용 도서다 ([국회도서관](https://dl.nanet.go.kr/SearchDetailView.do?cn=MONO1201867856)). 따라서 검증은 이렇게 나눈다. 식의 구조는 AISC fixture로 검증한다. 한국 고유 값(SS275·SM355의 두께별 항복강도, KS H형강, KDS 하중계수)은 소수의 손계산 fixture로 만들고, 한국 구조기술사가 검토한다. KDS 14 31 10이 AISC 360 식 체계를 따르므로 이 분할이 성립한다(추론). RESEARCH-08 §3.2가 남긴 "E = 205,000/210,000 조문 확인"도 이 검토에 포함한다.

### 4.3 상용 프로그램 교차는 무료 경로가 있지만 내부 기록으로만 쓴다

| 경로 | 내용 | 제약 |
|---|---|---|
| midas 체험판 | Gen·Civil 무료 체험, "1인 1회" 발급 ([midas Gen trial](https://landing.midasuser.com/en/gate/building/trials/gen/step1), [Civil free trial](https://resource.midasuser.com/en/free-trial)) | 기간·벤치마크 공개 조항 미확인 |
| midas 학교 라이선스 | 기증 계약 학교는 무료 ([EduCenter](https://educenter.midasuser.com/download)) | 교육용 |
| Dlubal 학생 라이선스 | RFEM 6/RSTAB 9 전체 기능 1년, 재학 증명으로 갱신 ([Dlubal FAQ 005613](https://www.dlubal.com/en/support-and-learning/support/faq/005613)) | 재학 중인 팀원 필요 |
| CSI | 2024년 1월부터 무료 학생 데모 중단, 교육용도 연구 라이선스 가격 ([Drexel 안내](https://tech.coe.drexel.edu/software/csi/)), 체험판은 있음 ([SAP2000 trial](https://www.csiamerica.com/products/sap2000/trial)) | 교육 라이선스는 영리 사용 제외 |

현실적인 조합은 다음과 같다. midas 체험판 1회로 BM-14와 fixture 모델 10~20개를 실행해 결과를 기록한다. 부족하면 기증 라이선스가 있는 대학 연구실이나 구조사무소에 같은 모델 실행을 의뢰한다. 체험·교육 라이선스는 비상업·교육 용도로 제한되고, 상용 약관은 흔히 벤치마크 공개를 제한한다. 따라서 이 결과는 **내부 교차 기록**으로만 두고, 저장소에 배포하는 기대값은 공개 교과서·AISC·CSI 값으로 한정한다(추론).

### 4.4 fixture 형식

사례마다 JSON 하나를 둔다. 필드는 {출처(문서, 예제 ID, 쪽), 단위, 입력 모델(§3 계약 형식), 기대값과 값별 허용오차, 가정(전단변형 제외 등)}이다. 회귀용 골든 출력은 "정답" fixture와 분리한다. 그래야 다시 생성한 골든 파일이 교과서 값을 조용히 덮어쓰지 않는다(추론). 허용오차는 두 단계로 둔다. 정확 해가 있는 선형 사례는 엄격하게, 2차·근사 사례는 벤치마크가 정한 값(AISC 3%/5%, PyNite 닫힌 식 1%)을 쓴다. 두 단계 기준은 PyNite와 CSI 관행을 따른다 ([PyNite 시험](https://raw.githubusercontent.com/JWock82/PyNite/main/Testing/test_AISC_PDelta_benchmarks.py), [CSI 1-019](https://docs.csiamerica.com/manuals/sap2000/Verification/Analysis/Frames/Problem%201-019.pdf)). PyNite는 Python 3.11 이상이 필요하다 ([PyNite](https://github.com/JWock82/Pynite)). VIDE 배포본에는 Python이 없으므로 PyNite는 **개발·CI 전용 기준 해석기**로만 쓴다.

## 5. 구현 언어 비교와 권고

### 5.1 문제 크기가 요구하는 성능

목표는 약 2,000부재, 약 12,000자유도(DOF: 절점이 움직일 수 있는 방향 수), LRFD 조합 23개와 반복 단면 조정이다. 선형 해석은 강성 행렬을 **한 번 분해(LDLᵀ: 대칭 행렬을 삼각 행렬로 나누는 직접 해법)** 하고 23개 우변을 푸는 것으로 끝난다. P-Δ는 조합마다 기하강성을 더해 **다시 분해하며 반복**한다. 단면 조정 반복이 이를 곱하고, 이후 모드 해석은 희소 일반화 고유값 문제(K x = λ M x)를 푼다. 이 크기에서 분해 결과는 수십 MB 이하다. 따라서 wasm32의 4 GB 메모리 한도는 문제되지 않는다(추론). S-18 기록에서 C# 포팅(MstCore2, 스카이라인 LDLᵀ, 중력만)은 0.3초, 순수 Python은 26초, numpy/scipy는 검정 포함 약 4.3초였다(내부 기록, 이번 재현 아님). 즉 네이티브 언어라면 한 번의 해석은 1초 이하다. 언어 간 성능 차이가 드러나는 곳은 **P-Δ × 조합 × 단면 조정 반복**의 곱과 대화형 재검토 응답, 모드 해석, 이후 더 큰 모델이다(추론).

### 5.2 언어 비교

| 안 | 성능 | 희소 해법·고유값 | 구조 코드 재사용 | Node 통합 | Windows 배포 | 라이선스 | AI 에이전트 작성 품질 |
|---|---|---|---|---|---|---|---|
| **Rust + faer** | 네이티브. Rust 희소 커널이 Eigen·PSBLAS와 비슷하다는 2026 학술 연구가 있음(크레이트 이름은 초록에 없음, [arXiv 2606.19213](https://arxiv.org/abs/2606.19213)) | faer 0.24.4: 희소 Cholesky·LDLT(Bunch-Kaufman)·LU·QR, 밀집 대칭 고유값 ([docs.rs faer](https://docs.rs/faer/latest/faer/)). 희소 일반화 고유값은 작은 크레이트의 shift-invert Lanczos 정도 ([tpt-fem-eigen](https://docs.rs/tpt-fem-eigen/latest/tpt_fem_eigen/), 스니펫). nalgebra-sparse는 "초기 단계" ([docs.rs](https://docs.rs/nalgebra-sparse/latest/nalgebra_sparse/)) | 성숙한 Rust 골조 FE 없음(교육용 크레이트뿐, [lib.rs](https://lib.rs/crates/finite_element_method)). S-18 Python·C#을 명세로 재작성 | napi-rs 애드온(인프로세스, 네이티브 스레드) 또는 wasm 또는 별도 exe | win-x64용 `.node` 하나 | faer MIT | SWE-bench Multilingual 최고 58.14% ([swebench](https://www.swebench.com/multilingual.html)) |
| Rust → wasm | 네이티브보다 평균 45~55% 느림, 최대 2.5배(2019, 구 V8, [USENIX ATC'19](https://www.usenix.org/conference/atc19/presentation/jangda)) | 같음. faer의 wasm 컴파일·SIMD 성능은 미확인 | 같음 | 인프로세스. 스레드는 Worker + SharedArrayBuffer 필요 ([wasm-bindgen-rayon](https://github.com/piotr-roslaniec/wasm-bindgen-rayon)). threads와 memory64 동시 사용 불가 ([wasm-bindgen #5330](https://github.com/wasm-bindgen/wasm-bindgen/issues/5330)) | `.wasm` 하나, 플랫폼별 빌드 없음 | 같음 | 같음 |
| C# .NET 8 Native AOT + CSparse.NET | 네이티브급. MstCore2가 0.3초(S-18) | CSparse.NET 4.3.0: 희소 LU·Cholesky·QR·LDL', 의존성 없음. Interop로 MKL·SuiteSparse·ARPACK 연결 ([CSparse.NET](https://github.com/wo80/CSparse.NET)). Math.NET 직접 분해는 밀집 전용 ([Math.NET](https://numerics.mathdotnet.com/Matrix)) | **MstCore2 재사용**. BFE.NET은 선형 정적만(LGPL-3, [GitHub](https://github.com/BriefFiniteElementNet/BriefFiniteElement.Net)). Rhino 8(.NET 8) 플러그인과 코드 공유 가능 | 자식 프로세스(stdin/stdout JSON·명명 파이프) | 런타임 설치 없는 단일 exe. 빌드에 VS "C++ 데스크톱 개발" 필요 ([Native AOT](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)). hello world 약 1.2~2 MB, 시작 5 ms 미만(2차 블로그 스니펫) | CSparse.NET 라이선스는 이번 조사에서 **미확인**(확인 필요) | 에이전트형 다언어 벤치에 C# 없음. 함수 단위 MultiPL-E에서 TS·JS와 비슷(구 모델, [arXiv 2208.08227](https://arxiv.org/pdf/2208.08227)) |
| C++ (Eigen + Spectra) | 네이티브. 라이브러리 성숙도 최고. CHOLMOD 초절점 해법이 Eigen 기본 해법보다 크게 빠르다는 보고 ([Open3D #405](https://github.com/IntelVCL/Open3D/issues/405), 스니펫) | Spectra: 일반화 대칭 고유값 `SymGEigsSolver`, shift-invert, MPL-2.0 ([Spectra](https://spectralib.org/)) | OpenSees는 상업 배포에 UC 허가 필요 ([COPYRIGHT](https://github.com/OpenSees/OpenSees/blob/master/COPYRIGHT)). Frame3DD는 GPL-3 ([Frame3DD](https://frame3dd.sourceforge.net/)) | N-API 애드온 또는 emscripten wasm ([Emscripten](https://emscripten.org/docs/compiling/WebAssembly.html)). Awatif가 C++/wasm 선형 해법을 씀 ([Awatif](https://github.com/madil4/awatif)) | node-gyp + MSVC. SuiteSparse는 BLAS/LAPACK 의존(추론) | Eigen·Spectra는 허용적. 구조 코드는 제약 | C/C++ 28.57%로 최저 ([swebench](https://www.swebench.com/multilingual.html)) |
| 순수 TypeScript | 가장 느림. 수치 배열 코드 벤치마크는 없음 | npm에는 "[WIP]" `cholesky-solve` 정도 ([scijs](https://github.com/scijs/cholesky-solve)). 희소 고유값 없음 | 없음(Awatif도 해법은 C++/wasm) | 서버와 같은 프로세스, 추가 비용 없음 | 추가 비용 없음 | — | JS/TS 34.88% ([swebench](https://www.swebench.com/multilingual.html)). Multi-SWE-bench에서도 TS·JS가 최저권 ([arXiv 2504.02605](https://arxiv.org/html/2504.02605v1), 스니펫) |
| Julia (juliac) | 빠름 | SparseArrays/CHOLMOD·Arpack(생태계 양호) | InstantFrame.jl(3D 골조, 2차·모드, 스니펫, 라이선스 미확인, [GitHub](https://github.com/runtosolve/InstantFrame.jl)) | 자식 프로세스 | trim은 Julia 1.12부터 새 기능. 라이브러리 포함 번들 약 93 MB 사례 ([LWN](https://lwn.net/Articles/1044280/), 스니펫) | — | 벤치마크 없음 |
| Go | 네이티브 | gonum 직접 분해는 밀집 전용. 희소 Cholesky는 소형 패키지뿐 ([james-bowman/sparse](https://github.com/james-bowman/sparse)) | 없음 | 자식 프로세스 | 단일 정적 exe | — | 30.95% |

에이전트 작성 품질 근거는 이슈 해결형 벤치마크이며, 수치 코드 전용 벤치마크는 찾지 못했다. 따라서 이 근거로 말할 수 있는 것은 "Rust와 C#은 에이전트에게 불리하지 않고 C++는 불리하다"까지다. 정밀한 순위를 매기는 근거는 아니다. Rust는 컴파일러가 엄격해 에이전트가 빠르고 정확한 피드백을 받는다. 이는 Rust가 높은 해결률을 보이는 것과 부합한다(추론).

### 5.3 Node 통합 방식

| 방식 | 속도 | 격리 | 배포 | 비고 |
|---|---|---|---|---|
| wasm 인프로세스 | 네이티브의 약 0.5~0.7배(2019 연구). 2021 비공식 측정에서도 네이티브 애드온이 약 45% 빠름 ([kudmitry.com](https://kudmitry.com/articles/native-rust-wasm/), 실험실 수준 아님) | 샌드박스. 메모리 오류가 서버를 깨지 않음(추론) | 가장 단순 | 가상 메모리가 제한된 환경에서 실패하는 Node 이슈가 있음 ([nodejs #56596](https://github.com/nodejs/node/issues/56596)). 브라우저 미리보기 해석에도 재사용 가능 |
| 네이티브 애드온(Node-API) | 네이티브, 스레드 사용 가능, 결과 직렬화 비용 없음(추론) | 코어가 비정상 종료하면 서버 프로세스도 함께 종료(추론) | win-x64 `.node` 하나. Node-API는 Node 판이 바뀌어도 ABI 안정 ([napi.rs](https://napi.rs/), 스니펫) | napi-rs는 WASI 대체 빌드를 함께 낼 수 있음 |
| 자식 프로세스 | 네이티브 + JSON/파이프 직렬화. 12k DOF 결과면 작음(추론) | 가장 강함 | exe 하나 | C#·Julia·Go의 유일한 경로. Rust도 같은 코드로 exe를 낼 수 있음(추론) |

### 5.4 권고

**장기 권고는 Rust + faer다.** 사용자가 성능을 우선하고 언어 난이도를 따지지 않는다는 전제에서 Rust가 가장 많은 조건을 함께 만족한다. 우선 네이티브 속도가 C++급이고, 희소 직접 해법(Cholesky·LDLT)이 MIT 라이선스 한 라이브러리에 모여 있다. 또 한 코드베이스에서 애드온·wasm·exe 세 방식이 모두 가능하다. 에이전트형 벤치마크에서 해결률이 가장 높고, 메모리 안전성으로 C++의 가장 큰 위험도 피한다. 위험은 두 가지다. 첫째, 재사용할 Rust 구조 FE가 없어 S-18의 Python(`Frame`·P-Δ 약 250줄, 검정부)과 C#(MstCore2)을 명세로 삼아 재작성해야 한다. 규모는 작고 §4의 fixture가 이식 정확도를 수치로 검증한다. 둘째, 모드 해석용 희소 일반화 고유값 해법은 검증된 순수 Rust 구현이 없다. 이것은 faer의 희소 LDLT 위에 shift-invert Lanczos를 직접 쓰는 일이 되며, 모드 단계에서 BM-05와 개발 전용 기준 해석기로 검증한다. 통합은 **napi-rs 애드온을 기본**으로 둔다. 서버 안정성이 문제로 드러나면 같은 코드를 exe로 빌드해 자식 프로세스로 돌린다.

**차선은 C# Native AOT 자식 프로세스다.** 기존 MstCore2를 바로 쓰므로 출시가 가장 빠르다. Rhino 8 플러그인과 코드를 공유할 수 있는 유일한 안이기도 하다. 다만 CSparse.NET은 SuiteSparse 계열 CSparse의 C# 포팅이라 초절점 해법이 아니다. 이 규모에서는 충분하지만, 큰 모델·모드 해석에서는 ARPACK 같은 네이티브 의존을 다시 들여야 한다(추론). 라이선스도 확인해야 한다. **순수 TypeScript(RESEARCH-08 §7.2 A안)**는 배포 비용이 0이다. 그러나 순서화·피벗 LDLT·Lanczos를 참고 라이브러리 없이 손으로 짜야 하고 가장 느리다. 성능 우선 기준에서는 해석 코어로 권하지 않는다. 대신 조합 생성·파라미터 확정 화면·보고처럼 반복이 적은 층은 TS 서버에 두는 것이 자연스럽다(추론). **C++**는 라이브러리가 가장 성숙하지만 에이전트 작성 품질이 가장 낮고, Windows 빌드가 가장 무거우며, 재사용할 구조 코드는 라이선스로 묶여 있다. **Julia·Go**는 배포(Julia) 또는 수치 생태계(Go)에서 탈락한다.

**부재 검정식은 코어에 둔다(추론).** 단면 조정 반복은 해석 → 검정 → 단면 교체의 반복이다. 검정이 TS 쪽에 있으면 반복마다 경계를 건너야 한다. 하중조합 생성 규칙(KDS 41 10 15)과 `PARAMS` 형태의 파라미터·근거·상태 관리, 보고서·계산서는 TS에 둔다. 코어는 계약(§3) 입력을 받아 결과·검정을 돌려주는 순수 계산기로 유지한다. 계약이 언어 중립이므로 나중에 코어를 바꿔도 계약과 fixture는 그대로 남는다.

**단기 권고:** C#을 거쳐 Rust로 가는 이중 작업은 피한다. SPIKE 한 번으로 Rust의 실측 성능과 Windows 빌드·설치 경로를 확인한 뒤 바로 Rust로 간다. SPIKE에서 Rust 빌드나 설치가 막히면 C# 자식 프로세스로 전환한다.

### 5.5 결정 전 SPIKE 제안

| 항목 | 내용 |
|---|---|
| 기록·코드 위치 | `docs/tdd/SPIKE-YYYY-MM-DD-frame-core-language.md`, `tools/spikes/<date>-frame-core-language/` |
| 질문 | 같은 모델에서 후보별 실행 시간·메모리·설치 크기·통합 난점은 얼마인가 |
| 모델 | S-18 규모 골조(약 12k DOF, 조합 23개)의 합성 사본. 원본 프로젝트 파일은 열지 않는다 |
| 후보 | ① Rust + faer napi-rs 애드온 ② 같은 코드의 wasm ③ C# MstCore2(스카이라인) 및 CSparse.NET Native AOT exe ④ TS Float64Array 스카이라인 LDLᵀ(MstCore2 이식) |
| 정확도 관문 | 시간 측정 전에 BM-01~03, BM-11, PyNite 차분(BM-10)을 통과해야 함 |
| 측정 | 조립 + 분해 + 23개 우변 풀이, 조합별 P-Δ 수렴까지(③은 중력 선형만 있으므로 선형 시간만 비교), 단면 조정 5회 반복, 첫 호출 지연, 최대 메모리, 설치 산출물 크기, Windows 설치본에서의 로드 성공 여부 |
| 종료 조건 | ①이 정확도 관문을 통과하고 설치본에서 로드되면 Rust 확정. 막히면 ③으로 결정. ②와 ①의 차이로 브라우저 미리보기용 wasm 병행 여부를 판단 |

## 6. 사용자 결정이 필요한 항목

| 번호 | 결정 | 선택지 | 권고 |
|---|---|---|---|
| 1 | 해석 코어 언어·구동 방식(RESEARCH-05 결정 11, RESEARCH-08 §8-1) | Rust 애드온 / Rust exe / C# AOT exe / 순수 TS | **결정(2026-09-29 사용자): Rust.** 구동 방식(애드온·exe·wasm)은 §5.5 SPIKE로 확정 |
| 2 | 부재 검정식 위치 | 코어 / TS 서버 | 코어. 조합 생성·파라미터·보고는 TS |
| 3 | P-Δ 방식 | 조합별 반복(정확, PyNite·CSI 반복식) / 모든 조합의 최대 압축력으로 1회(Karamba 방식, 보수적·빠름) | 조합별 기본, 포락 1회는 빠른 미리보기 선택지 |
| 4 | 부재 방향각 규약 | midas beta 규약 / BHoM식 / 방향 벡터 | MGT 내보내기와 같은 규약을 정본으로 하고 벡터 입력을 허용. 엔진 간 회전 시험 |
| 5 | 물리 부재 자동 분할 | 포함 / 해석 요소만 | 포함. Rhino 선 모델 입력과 결과 역연결에 필요 |
| 6 | MGT 범위 | 쓰기 부분집합 / 읽기까지 | **결정(2026-09-29 사용자): 일반 요구가 아님.** 기본 교환은 CAD·Rhino 파일, MGT 쓰기는 프로젝트별 선택 |
| 7 | 상용 교차 경로 | midas 체험판 1회 / 대학 기증 라이선스 협력 / 구조사무소 의뢰 / 하지 않음 | 체험판 1회 + 필요 시 협력. 결과는 내부 기록만 |
| 8 | 한국 고유 fixture 검토자 | 구조기술사 검토 / 내부 검토만 | 구조기술사 검토. "탐색용 예비값" 표시는 어느 경우든 유지 |
| 9 | 적용 기준 판과 재료 상수 | KDS 14 31 10 판, E = 205,000 또는 210,000 MPa | 조문 확인 후 fixture에 판·조항을 기록 |

## 7. 확인 한계

midas 지원 포털(Zendesk)의 여러 문서는 자동 접근에서 403/404가 났다. 따라서 MIDAS API 구조, 비지지 길이 기본값, NX의 KDS 코드 목록은 검색 스니펫과 제목 수준이다. MGT 필드 순서는 소형 모델의 페이지 요약이라 파서 명세로 쓰기 전에 원문과 실제 내보낸 파일로 다시 확인해야 한다. CSI `.s2k` 행 문법, OAPI 약관, CSparse.NET·InstantFrame.jl·MIDAS API·Dlubal API의 라이선스는 확인하지 못했다. aisc.org는 스크립트 접근을 막아 설계 예제 번호(BM-08)와 해설 그림의 "전단변형 포함" 값은 얻지 못했다. Dlubal·CSI 색인 페이지는 JS 렌더링이라 목록 전체를 세지 못했다. 공개 midas 검증 매뉴얼과 무료 한국 강구조 풀이집은 찾지 못했다. 성능 근거는 2019년 wasm 연구와 2021년 비공식 측정, 2026년 희소 커널 연구 초록에 기대고 있다. faer 희소 분해와 CHOLMOD·CSparse.NET의 직접 비교, 12k DOF 골조의 실측은 없다. 이 공백은 §5.5 SPIKE가 메운다. 에이전트 작성 품질 벤치마크에는 C#·Julia가 없고 수치 코드 전용 벤치마크도 없다. S-18 성능 수치(0.3초, 26초, 약 4.3초)는 내부 기록이며 이번에 재현하지 않았다. 허용오차 가운데 "(추론)"으로 표시한 값은 공개 기준이 아닌 공학적 판단이다.
