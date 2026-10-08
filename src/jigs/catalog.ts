// The JIG tab: official jigs (RESEARCH-04 J-NN) and whether each can be used yet. A jig is a
// working tool for one kind of architectural task; its steps are computed, AI (with checks) or
// human. Planned jigs are listed so the collection is visible while they are ported.
export interface JigEntry {
  id: string;
  code: string;
  name: string;
  summary: string;
  inputs: string[];
  status: 'available' | 'planned';
  /** Where the planned port comes from (past work, RESEARCH-04 source codes). */
  basis?: string;
}
export const JIGS: JigEntry[] = [
  {
    id: 'sync',
    code: 'J-SYNC',
    name: 'Sync · 도면↔모델',
    summary:
      'Rhino 모델과 CAD 도면의 위치 관계(이동·회전·오차)를 계산하고, 서로 안 맞는 객체를 표로 보여 줍니다. AI 검토로 차이의 의미를 판정하고 한쪽 기준으로 맞춥니다.',
    inputs: ['Rhino Sync', 'ZWCAD Sync'],
    status: 'available',
  },
  {
    id: 'knowledge',
    code: 'J-DATA',
    name: '프로젝트 자료 · 시험판',
    summary:
      '회사 서버의 프로젝트 폴더(메일·회의록·문서·도면)를 정리한 DB에서 지금 정해진 것·막힌 것·최근 바뀐 것을 현황 보고서로 읽습니다. 항목에서 분야별 이슈 노트와 원문 근거·원본 파일로 들어갑니다.',
    inputs: ['프로젝트 지식 DB'],
    status: 'available',
    basis: 'PLAN-08 K0·K0-T2',
  },
  {
    id: 'structure',
    code: 'J-09',
    name: '구조 분석',
    summary:
      'CAD 도면이나 Rhino 모델(중심선·부재 솔리드)로 해석 모델을 만들고, 확정한 모델을 해석해 KDS 강구조 부재 검정비와 근거를 표와 모델 색으로 보여 줍니다. 탐색용 예비값입니다.',
    inputs: ['Rhino Sync', 'ZWCAD Sync'],
    status: 'available',
    basis: 'S-18·S-10·S-05 · SPEC-06',
  },
  {
    id: 'finish',
    code: 'J-10',
    name: '마감 일람표',
    summary:
      '마감코드 체계(코드 477개)에서 프로젝트 마감을 고르고 층별 두께를 맞춘 뒤, 실마다 바닥·벽·천장 코드를 배정해 실 마감표와 마감 일람표를 인쇄·CSV로 냅니다.',
    inputs: ['실 목록(직접 입력·엑셀 붙여넣기)'],
    status: 'available',
    basis: 'SPEC-11 · PLAN-43 T-198',
  },
  {
    id: 'drawing',
    code: 'J-DWG',
    name: '도면 반영',
    summary:
      '모델 변경을 기존 CAD 도면에 형식 그대로 반영합니다(레이어·블록·Handle·DWG 버전 유지). 열린 도면은 바로 고치고 되돌릴 수 있으며, 닫힌 도면은 같은 폴더에 새 파일로 씁니다. 도면의 도곽을 찾아 프로젝트 CTB로 미리 봅니다.',
    inputs: ['Rhino Sync', 'ZWCAD 연결 도면', '레이어 대응'],
    status: 'available',
    basis: 'SPEC-14 · PLAN-47 T-232~T-235',
  },
  {
    // The official tool jig `vide/site-model` (PLAN-45 T-207); the JIG list shows its card.
    id: 'vide/site-model',
    code: 'J-01',
    name: '사이트 모델링',
    summary:
      '주소·PNU로 대상 필지를 확정하고 지적·도로·주변 건물·지형·용도지역을 모아 대지 요약과 함께 Rhino에 만듭니다.',
    inputs: ['주소·PNU', '수치지형도·연속지적도 SHP(선택)', 'Rhino'],
    status: 'available',
    basis: 'S-02·S-03·S-04·S-19 · SPEC-12.3~12.6',
  },
  {
    id: 'site-analysis',
    code: 'J-02',
    name: '사이트 분석',
    summary: '일조·조망·접근·주변 용도 등 대지 조건을 분석합니다.',
    inputs: ['사이트 모델'],
    status: 'planned',
    basis: 'S-01·S-11·S-13',
  },
  {
    id: 'legal',
    code: 'J-03',
    name: '법규 검토',
    summary:
      '대충 물어도 이 프로젝트의 대지·용도·규모·설계 단계를 붙여 cLAWde 법령 DB에 묻고, 결론·근거 조항(원문 링크·발췌·시행일)·해석·확인 필요 사항을 답 카드로 보여 줍니다. 설계 단계별로 봐야 할 법령 목록과 인허가 시점도 봅니다.',
    inputs: ['질문', '법규 프로필', 'cLAWde 연결'],
    status: 'available',
    basis: 'SPEC-13 · PLAN-46 T-221·T-222',
  },
  {
    // RESEARCH-04 J-04 (법규 검토 2: 일조사선·건축선으로 가능 매스) is the official tool jig
    // `vide/buildable-mass` (PLAN-45 T-209~T-212); the JIG list shows its card.
    id: 'vide/buildable-mass',
    code: 'J-04',
    name: '건축 가능 영역·매스',
    summary:
      '대지와 규제 조건으로 2D 건축 가능 영역과 3D 가능 외피를 계산하고, 층을 나눠 대안을 비교해 하나를 고르며 용도·주차·조경을 봅니다.',
    inputs: ['대지 경계·도로·인접 대지(Rhino)', '규제 조건(법규 결과·사람 입력)'],
    status: 'available',
    basis: 'S-01·S-03·S-04·S-19 · SPEC-12.7~12.12',
  },
  {
    // The official tool jig `vide/building-summary` (PLAN-45 T-213).
    id: 'vide/building-summary',
    code: 'J-11',
    name: '건축개요',
    summary:
      '고른 대안과 대지 요약으로 건축개요와 층별 면적표를 만들고 값마다 출처를 붙여, 숫자가 맞을 때만 보고서(HTML)와 표(CSV)로 냅니다.',
    inputs: ['고른 대안(매스 검토)', '대지 요약(선택)'],
    status: 'available',
    basis: 'S-03·S-04 · SPEC-12.13',
  },
  {
    // The official tool jig `vide/compliance-check` (PLAN-48 T-237~T-239).
    id: 'vide/compliance-check',
    code: 'J-12',
    name: '법규 체크',
    summary:
      '연결 Rhino 모델을 읽어 규제 조건과 숫자·형상으로 비교하고, 항목마다 적합·위반·판단 필요를 근거와 함께 보입니다. [법규 체크]를 누를 때만 계산합니다.',
    inputs: ['설계 모델(Rhino)', '규제 조건·외피(매스 검토)', '대지 요약(선택)'],
    status: 'available',
    basis: 'SPEC-15 · PLAN-48',
  },
  {
    id: 'schedule',
    code: 'J-05',
    name: '일정표',
    summary: '설계 단계·제출 일정 정리.',
    inputs: ['프로젝트 자료'],
    status: 'planned',
    basis: 'S-04·S-07',
  },
  {
    id: 'render',
    code: 'J-06',
    name: '렌더 이미지',
    summary: '뷰 설정과 렌더 이미지 생성·정리.',
    inputs: ['Rhino'],
    status: 'planned',
    basis: 'S-06·S-07·S-09',
  },
  {
    // The official tool jig `vide/paneling` (PLAN-49); the JIG list shows its tool card. Available
    // since T-258's VERIFY (VERIFY-2026-10-08-paneling, hidden Rhino 8).
    id: 'vide/paneling',
    code: 'J-07',
    name: '패널링',
    summary: '곡면 분할·패널 유형화·수량.',
    inputs: ['Rhino 곡면'],
    status: 'available',
    basis: 'S-06·S-12',
  },
  {
    id: 'minutes',
    code: 'J-08',
    name: '회의록',
    summary: '회의 기록 정리와 결정·후속 작업 추출.',
    inputs: ['회의 자료'],
    status: 'planned',
    basis: 'S-07',
  },
];
