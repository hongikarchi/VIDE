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
    id: 'site-modeling',
    code: 'J-01',
    name: '사이트 모델링',
    summary: '주소·지적·지형 자료로 대지와 주변 매스를 모델링합니다.',
    inputs: ['주소', 'Rhino'],
    status: 'planned',
    basis: 'S-02·S-03·S-04',
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
    id: 'law-1',
    code: 'J-03',
    name: '법규 검토 1',
    summary: '용도지역·건폐율·용적률·높이 등 규모 검토.',
    inputs: ['주소', '계획 매스'],
    status: 'planned',
    basis: 'S-01·S-03·S-04',
  },
  {
    id: 'law-2',
    code: 'J-04',
    name: '법규 검토 2',
    summary: '지구단위계획·조례·세부 조항 검토와 근거 인용.',
    inputs: ['주소', '계획안'],
    status: 'planned',
    basis: 'S-01·S-04',
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
    id: 'paneling',
    code: 'J-07',
    name: '패널링',
    summary: '곡면 분할·패널 유형화·수량.',
    inputs: ['Rhino 곡면'],
    status: 'planned',
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
