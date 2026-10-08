// A fake 법규 체크 result for the screen (PLAN-48 T-239), shaped exactly as the contract
// (`src/contracts/compliance.ts` `ComplianceResult`) so the screen is built before the engine
// (T-238). Every limit value below is test data, not a legal number. One row of each state, cases
// and parts, three exceedances (일조 · 건축선 후퇴 · 최대 외피), a 미적용 check, a '가정' limit,
// a link and a 법규 답 번호 on the 근거, and a reason a spreadsheet would read as a formula.

import { checkGroup, COMPLIANCE_CHECKS } from '../../src/contracts/compliance.ts';

export const OBJ = {
  mass: '6f1c2b1e-1111-4a6b-9c1d-000000000001',
  top: '6f1c2b1e-1111-4a6b-9c1d-000000000002',
  floor1: '6f1c2b1e-1111-4a6b-9c1d-000000000003',
  stall: '6f1c2b1e-1111-4a6b-9c1d-000000000004',
};
export const LINK = 'link-rhino-1';

/** A closed box mesh from (x0,y0,z0) to (x1,y1,z1), local metres. */
export function box([x0, y0, z0], [x1, y1, z1]) {
  return {
    v: [
      x0,
      y0,
      z0,
      x1,
      y0,
      z0,
      x1,
      y1,
      z0,
      x0,
      y1,
      z0,
      x0,
      y0,
      z1,
      x1,
      y0,
      z1,
      x1,
      y1,
      z1,
      x0,
      y1,
      z1,
    ],
    f: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3,
      0, 4, 3, 4, 7,
    ],
  };
}

const row = (id, fields) => ({
  id,
  group: checkGroup(id),
  title: id,
  state: '사람 입력 필요',
  reason: '규제 조건 없음 — 건축 가능 영역·매스에서 규제 조건을 넣고 계산하세요',
  planned: null,
  limit: null,
  margin: null,
  basis: [],
  numbers: [],
  cases: [],
  parts: [],
  objectIds: [],
  exceedances: [],
  unconfirmed: [],
  ...fields,
});
const limit = (value, unit, itemId, status = '확정', origin = '사용자가 확정함') => ({
  value,
  unit,
  text: String(value),
  itemId,
  status,
  origin,
});
const piece = (no, rule, from, to, objectIds, segments = []) => ({
  id: `piece-${no}`,
  no,
  rule,
  variant: 'base',
  groundCase: 'ground:value',
  volume: (to[0] - from[0]) * (to[1] - from[1]) * (to[2] - from[2]),
  min: from,
  max: to,
  segments,
  objectIds,
  rooftopOnly: false,
  mesh: box(from, to),
});

export function complianceFixture() {
  const items = [
    row('coverage', {
      title: '건폐율',
      state: '적합',
      reason: '',
      planned: { value: 0.48, unit: '비율', text: '48.00%' },
      limit: limit(0.6, '비율', 'coverage'),
      margin: 0.12,
      basis: [{ clause: '시험용 조항 제1조', link: 'https://law.example/1', answer: 'L3' }],
      numbers: [
        {
          label: '건축면적',
          value: 300,
          unit: '㎡',
          kind: '모델',
          ref: 'model:mass',
          note: '수평투영',
        },
        { label: '대지면적', value: 625, unit: '㎡', kind: '대지', ref: 'site:area' },
        {
          label: '건폐율 상한',
          value: 0.6,
          unit: '비율',
          kind: '규제 조건',
          ref: 'regulation:coverage',
        },
      ],
      objectIds: [OBJ.mass],
    }),
    row('far', {
      title: '용적률',
      state: '판단 필요',
      reason: '완화 조건 미확정',
      planned: { value: 2.1, unit: '비율', text: '210.00%' },
      limit: limit(2, '비율', 'farBase'),
      margin: -0.1,
      cases: [
        { label: '완화 넣음', state: '적합', planned: 2.1, limit: 2.2 },
        { label: '완화 뺌', state: '위반', planned: 2.1, limit: 2 },
      ],
      numbers: [
        {
          label: '기준 용적률',
          value: 2,
          unit: '비율',
          kind: '규제 조건',
          ref: 'regulation:farBase',
        },
        {
          label: '인센티브',
          value: 0.2,
          unit: '비율',
          kind: '규제 조건',
          ref: 'regulation:incentiveFar',
        },
      ],
      objectIds: [OBJ.floor1],
      unconfirmed: ['인센티브 적용 여부 판단 필요'],
    }),
    row('height:heightMax', {
      title: '높이 · 최고 높이',
      state: '위반',
      reason: '계획 높이가 최고 높이를 넘음',
      // Differs from the limit only in the third decimal: the screen must not show them equal.
      planned: { value: 30.004, unit: 'm', text: '30.00 m' },
      limit: limit(30, 'm', 'heightMax'),
      margin: -0.004,
      basis: [{ clause: '시험용 조항 제2조', link: null, answer: null }],
      objectIds: [OBJ.mass, OBJ.top],
    }),
    row('height:altitudeHeight', { title: '높이 · 고도지구' }),
    row('floors', {
      title: '층수',
      state: '적합',
      reason: '',
      planned: { value: 7, unit: '층', text: '7층' },
      limit: limit(10, '층', 'floorsMax', '가정', '서비스 해석'),
      margin: 3,
      unconfirmed: ['가정 값 기준'],
    }),
    row('zone:roadSetback', {
      title: '건축선 후퇴',
      state: '위반',
      reason: '금지 띠 안에 건물 부분',
      planned: { value: 6, unit: '㎥', text: '6.000 ㎥' },
      parts: [
        {
          label: '도로 1',
          target: '도로 1',
          state: '위반',
          planned: 6,
          limit: null,
          reason: '0.5 m 내밂',
        },
        {
          label: '도로 2',
          target: '도로 2',
          state: '사람 입력 필요',
          planned: null,
          limit: null,
          reason: '값 없음',
        },
      ],
      objectIds: [OBJ.floor1],
      exceedances: [piece(2, 'roadSetback', [0, -0.5, 0], [12, 0, 1], [OBJ.floor1], ['도로 1'])],
    }),
    row('zone:chamfer', { title: '가각', state: '검사 불가', reason: '외피 점검 실패' }),
    row('zone:limitLine', { title: '건축한계선' }),
    row('zone:openSpaceRoad', { title: '대지 안의 공지(건축선)' }),
    row('zone:openSpaceAdjacent', { title: '대지 안의 공지(인접 대지)' }),
    row('zone:civilSetback', { title: '민법상 이격' }),
    row('zone:otherSetback', { title: '기타 이격' }),
    row('sun', {
      title: '정북 일조',
      state: '위반',
      reason: '일조 사선 금지 부피 안에 건물 부분',
      planned: { value: 24, unit: '㎥', text: '24.000 ㎥' },
      basis: [{ clause: '시험용 조항 제3조', link: 'javascript:alert(1)', answer: 'L4' }],
      objectIds: [OBJ.top],
      exceedances: [piece(1, 'sun', [0, 18, 21], [6, 20, 23], [OBJ.top], ['인접 3'])],
    }),
    row('envelope', {
      title: '최대 외피',
      state: '위반',
      reason: '최대 외피 밖의 건물 부분',
      planned: { value: 30, unit: '㎥', text: '30.000 ㎥' },
      objectIds: [OBJ.top, OBJ.floor1],
      exceedances: [piece(3, 'envelope', [0, 18, 21], [6, 20.5, 23.5], [OBJ.top])],
    }),
    row('outside-site', {
      title: '대지 밖',
      state: '적합',
      reason: '',
      planned: { value: 0, unit: '㎥', text: '0 ㎥' },
    }),
    row('parking', {
      title: '주차 대수',
      state: '위반',
      reason: '=SUM(1) 계획 대수가 법정 대수보다 적음',
      planned: { value: 8, unit: '대', text: '8대' },
      limit: limit(10, '대', 'parkingRule'),
      margin: -2,
      objectIds: [OBJ.stall],
    }),
    row('landscape', {
      title: '조경 면적',
      state: '판단 필요',
      reason: '옥상 등 조경의 산입',
      planned: { value: 40, unit: '㎡', text: '40.00 ㎡' },
      limit: limit(50, '㎡', 'landscapeRatio'),
      margin: -10,
      cases: [
        { label: '옥상 조경 뺌', state: '위반', planned: 40, limit: 50 },
        { label: '옥상 조경 넣음', state: '적합', planned: 60, limit: 50 },
      ],
      unconfirmed: ['옥상 조경 산입 판단 필요'],
    }),
    row('open-space', { title: '공개공지 면적' }),
  ];
  const states = ['적합', '위반', '판단 필요', '사람 입력 필요', '검사 불가'];
  const counts = Object.fromEntries(
    states.map((s) => [s, items.filter((i) => i.state === s).length]),
  );
  const notApplicable = [
    {
      check: 'height:streetHeight',
      id: 'streetHeight',
      title: '높이 · 가로구역',
      basis: '가로구역 지정 없음(확정)',
    },
  ];
  const listed = [...items.map((i) => i.id), ...notApplicable.map((n) => n.check)];
  if (COMPLIANCE_CHECKS.some((c) => !listed.includes(c))) throw new Error('fixture misses a check');
  return {
    schema: 'vide.compliance.result@1',
    checkedAt: '2026-10-08T09:01:00.000Z',
    inputs: {
      model: {
        linkId: LINK,
        documentKey: 'doc-합성',
        readId: 'read-1',
        revisionKey: 'rhino|doc-합성|7',
        readAt: '2026-10-08T09:00:00.000Z',
        objects: 14,
        unclassified: 3,
        rolesVersion: 3,
      },
      limits: { instanceId: 'mass-1', title: '매스 A', hash: 'h1', at: '2026-10-08T08:00:00.000Z' },
      siteModel: {
        instanceId: 'site-1',
        title: '대지 1',
        hash: 'h2',
        at: '2026-10-08T07:00:00.000Z',
      },
      settingsHash: 's1',
      overridesHash: 'o1',
    },
    items,
    notApplicable,
    classification: {
      byRole: {
        mass: 2,
        floor: 7,
        'building-area': 0,
        rooftop: 0,
        parking: 9,
        landscape: 1,
        'landscape-roof': 1,
        'open-space': 0,
        ignore: 2,
      },
      unusedByReason: {
        '역할 없음': 1,
        '역할과 모양이 맞지 않음': 0,
        '닫히지 않음': 1,
        '평면이 아님': 0,
        숨김: 0,
        '다른 jig의 결과': 1,
        '고르지 않은 대안': 0,
      },
      aiAccepted: 9,
      hiddenWithRole: 0,
      geometryChanged: 1,
    },
    counts,
    unconfirmedCount: items.filter((i) => i.unconfirmed.length).length,
    notice: '탐색용 법규 체크 — 인허가 검토·법규 검토를 대체하지 않음',
    display: { origin: [1000, 2000, 30], envelope: box([0, 0, 0], [20, 20, 21]) },
  };
}
