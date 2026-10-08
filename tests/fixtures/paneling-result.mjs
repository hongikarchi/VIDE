// A small fixed 패널링 result (PLAN-49 T-253) shaped by `src/contracts/paneling.ts`: a flat face at
// z = 10 m split into a 1.2 × 0.6 m grid of `cols` columns and 2 rows plus a cut boundary column
// 0.3 m wide. P-1-3 is narrower than the module ('목표와 다름'), P-2-4 failed (넓이 0), P-1-1 is
// over the stock sheet, P-1-2 has an uneven joint and P-2-3 is over the type tolerance. The screen
// test and the pure-model test both draw it; nothing here is computed from a real surface.

const Z = 10;
const H = 0.6;
const W = 1.2;

function panelsOf(cols) {
  const out = [];
  for (let row = 1; row <= 2; row++) {
    let x = 0;
    for (let col = 1; col <= cols + 1; col++) {
      const boundary = col === cols + 1;
      const width = boundary ? 0.3 : col === 3 ? 0.9 : W;
      const y = (row - 1) * H;
      const corners = [
        [x, y, Z],
        [x + width, y, Z],
        [x + width, y + H, Z],
        [x, y + H, Z],
      ];
      const id = `P-${row}-${col}`;
      const failed = boundary && row === 2;
      out.push({
        id,
        faceIndex: 0,
        row,
        col,
        uv: corners.map(([u, v]) => [u, v]),
        corners,
        vertexKeys: [
          `0:${col - 1}:${row - 1}`,
          `0:${col}:${row - 1}`,
          `0:${col}:${row}`,
          `0:${col - 1}:${row}`,
        ],
        boundary,
        pole: false,
        mergedFrom: [],
        width,
        height: H,
        area: width * H,
        failure: failed ? { code: 'degenerate', message: '넓이 0 · 패널이 너무 작습니다' } : null,
      });
      x += width;
    }
  }
  return out;
}

/**
 * The three step outputs (`preview` · `members` · `optimize`) for `cols` full columns (≥ 3);
 * `module` is the size the layout says it used (the target unless a closed face rounded it).
 */
export function panelingFixture({ cols = 3, module = [W, H] } = {}) {
  const panels = panelsOf(cols);
  const ok = panels.filter((p) => !p.failure);
  const layout = {
    schema: 'vide.paneling.layout@1',
    surfaceHash: 'a1b2c3d4e5f60718',
    settingsHash: cols === 3 ? 'c0ffee0001' : 'c0ffee0002',
    panels,
    counts: {
      total: panels.length,
      boundary: panels.filter((p) => p.boundary).length,
      pole: 0,
      failed: panels.length - ok.length,
      dropped: 0,
      offTarget: panels.filter((p) => !p.boundary && p.width !== W).length,
    },
    sizeRange: {
      minW: Math.min(...ok.map((p) => p.width)),
      maxW: Math.max(...ok.map((p) => p.width)),
      minH: H,
      maxH: H,
      area: ok.reduce((sum, p) => sum + p.area, 0),
    },
    module,
    coarseSample: false,
  };
  const box = (p) => {
    const [a, , c] = [p.corners[0], p.corners[1], p.corners[2]];
    const x0 = a[0] + 0.005,
      x1 = c[0] - 0.005,
      y0 = a[1] + 0.005,
      y1 = c[1] - 0.005;
    const v = [];
    for (const z of [Z, Z + 0.05]) v.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z);
    const f = [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3,
      0, 4, 3, 4, 7,
    ];
    return { v, f };
  };
  const members = {
    schema: 'vide.paneling.members@1',
    layoutHash: 'b0b0b0b0b0b0',
    settingsHash: 'd00d00d00d',
    members: panels.map((p) => ({
      panelId: p.id,
      uv: p.uv,
      solid: p.failure ? null : box(p),
      flatSize: [Math.max(0, p.width - 0.01), H - 0.01],
      flatSizeApprox: false,
      thickness: 0.05,
      area: p.area,
      volume: p.area * 0.05,
      jointGap: p.id === 'P-1-2' ? [0.008, 0.013] : [0.01, 0.01],
      jointUneven: p.id === 'P-1-2',
      failure: p.failure,
    })),
    joints: [
      {
        keys: ['0:1:0', '0:1:1'],
        line: [
          [W, 0, Z],
          [W, H, Z],
        ],
      },
    ],
    overStock: ['P-1-1'],
  };
  const typeOf = (p) => (p.boundary ? 'T-03' : p.width === W ? 'T-01' : 'T-02');
  const flat = (p) => [
    [0, 0],
    [p.width - 0.01, 0],
    [p.width - 0.01, H - 0.01],
    [0, H - 0.01],
  ];
  const typing = {
    schema: 'vide.paneling.typing@1',
    membersHash: 'e1e1e1e1e1',
    settingsHash: 'f2f2f2f2f2',
    panels: panels.map((p) => ({
      panelId: p.id,
      type: typeOf(p),
      class: 'flat',
      flatness: p.id === 'P-2-2' ? 0.0042 : 0.0004,
      planarGap: 0,
      offSurface: 0,
      deviation: p.id === 'P-2-3' ? 0.0031 : 0,
      flat: p.failure ? null : flat(p),
      failure: p.failure,
    })),
    types: [
      {
        type: 'T-01',
        class: 'flat',
        count: panels.filter((p) => typeOf(p) === 'T-01').length,
        vertexCount: 4,
        representative: 'P-1-1',
        size: [1.19, 0.59],
        maxDeviation: 0,
        mirrorOf: null,
      },
      {
        type: 'T-02',
        class: 'flat',
        count: 2,
        vertexCount: 4,
        representative: 'P-1-3',
        size: [0.89, 0.59],
        maxDeviation: 0.0031,
        mirrorOf: null,
      },
      {
        type: 'T-03',
        class: 'flat',
        count: 2,
        vertexCount: 4,
        representative: `P-1-${cols + 1}`,
        size: [0.29, 0.59],
        maxDeviation: 0,
        mirrorOf: null,
      },
    ],
    nodes: [
      { type: 'N-01', valence: 4, angles: [90, 90, 90, 90], count: cols },
      { type: 'N-02', valence: 2, angles: [90, 270], count: 4 },
    ],
    joints: [{ type: 'J-01', dihedral: [-0.5, 0.5], count: 10, length: 0.6, totalLength: 6 }],
    nodeAt: [{ key: '0:1:1', type: 'N-01', at: [W, H, Z] }],
    jointAt: [
      {
        keys: ['0:1:0', '0:1:1'],
        panels: ['P-1-1', 'P-1-2'],
        type: 'J-01',
        dihedral: 0,
        length: 0.6,
      },
    ],
    overTypeTol: ['P-2-3'],
    maxTypesUnmet: null,
  };
  return { preview: layout, members, optimize: typing };
}

const AT = '2026-10-08T08:00:00.000Z';
const choices = (list) => list.map(([value, label]) => ({ value, label }));
/**
 * The settings of an instance of `vide/paneling` as the engine shows them (runtime `ParamView`),
 * with the keys the screen reads by stage (src/ui/paneling/model.ts `STAGE_KEYS`). `by` per key
 * overrides the default ('default' = 추천값, a 가정 once computed).
 */
export function panelingParams(by = {}, values = {}) {
  const p = (key, title, group, type, value, extra = {}) => ({
    key,
    title,
    group,
    type,
    unit: type === 'length' ? 'm' : type === 'count' ? 'EA' : type === 'angle' ? 'deg' : '',
    displayUnit:
      type === 'length'
        ? 'mm'
        : type === 'ratio'
          ? '%'
          : type === 'count'
            ? 'EA'
            : type === 'angle'
              ? 'deg'
              : '',
    value: key in values ? values[key] : value,
    displayValue: key in values ? values[key] : value,
    by: by[key] ?? 'default',
    at: AT,
    basis: { status: 'to-ask', ...(extra.question ? { question: extra.question } : {}) },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'question')),
  });
  const one = '1 미리보기',
    two = '2 부재',
    three = '3 최적화·타입화';
  return [
    p('pattern', '패턴', one, 'choice', 'grid', {
      choices: choices([
        ['grid', '사각 격자'],
        ['staggered', '엇갈림'],
        ['diamond', '마름모'],
        ['triangle', '삼각'],
      ]),
      question: '패턴은 무엇으로 할까요?',
    }),
    p('width', '패널 가로', one, 'length', 1.2),
    p('height', '패널 세로', one, 'length', 0.6),
    p('measure', '크기를 재는 법', one, 'choice', 'arc-length', {
      choices: choices([
        ['arc-length', '면 위 길이'],
        ['parameter', '매개변수 같은 간격'],
        ['projected', '투영 격자'],
      ]),
    }),
    p('projection', '투영 평면', one, 'choice', 'plan-xy', {
      choices: choices([
        ['plan-xy', '평면 XY'],
        ['best-vertical', '수직 입면'],
      ]),
    }),
    p('axis', '패턴 축', one, 'choice', 'u', {
      choices: choices([
        ['u', 'U'],
        ['v', 'V'],
      ]),
    }),
    p('startCorner', '시작 모서리', one, 'choice', 'min-min', {
      choices: choices([
        ['min-min', 'U 최소 · V 최소'],
        ['max-min', 'U 최대 · V 최소'],
        ['min-max', 'U 최소 · V 최대'],
        ['max-max', 'U 최대 · V 최대'],
      ]),
    }),
    p('flip', '뒤집기', one, 'toggle', false),
    p('boundary', '경계 처리', one, 'choice', 'trim', {
      choices: choices([
        ['trim', '자르기'],
        ['merge', '이웃에 합치기'],
        ['drop', '빼기'],
      ]),
    }),
    p('mergeBelow', '합치기 기준', one, 'ratio', 0.3, { range: { min: 0, max: 1, step: 0.05 } }),
    p('thickness', '두께', two, 'length', 0.05, { range: { min: 0.001, max: 1, step: 0.001 } }),
    p('thicknessSide', '두께 방향', two, 'choice', 'outside', {
      choices: choices([
        ['outside', '바깥'],
        ['inside', '안'],
      ]),
    }),
    p('joint', '줄눈', two, 'length', 0.01, { range: { min: 0, max: 0.2, step: 0.001 } }),
    p('boundaryJoint', '경계 줄눈', two, 'choice', 'flush', {
      choices: choices([
        ['flush', '경계에 맞춤'],
        ['half', '반 줄눈'],
      ]),
    }),
    p('flatnessTol', '평면도 허용 오차', three, 'length', 0.003),
    p('planarize', '평면화', three, 'choice', 'best-fit', {
      choices: choices([
        ['none', '없음'],
        ['best-fit', '패널별 최적 평면'],
      ]),
    }),
    p('typeTol', '타입 허용 오차', three, 'length', 0.002),
    p('maxTypes', '최대 타입 수', three, 'count', 0),
    p('flatRadius', '평면으로 볼 곡률 반지름', three, 'length', 100),
    p('nodeAngleStep', '결합부 각 간격', three, 'angle', 1),
  ];
}
