// Closed-form verification fixtures for the structure core (PLAN-17 T-034).
// Every expected value is derived here from a textbook formula; the source is noted per fixture.
// Units follow ARCH-02: m, kN, kN·m; E in MPa inside the model, kN/m² in the formulas.

export const E_MPA = 205000;
export const G_MPA = 79000;
const E = E_MPA * 1e3; // kN/m²

// Explicit section properties so the formulas do not depend on the section calculator.
export const H400 = {
  id: 'H400',
  name: 'H-400x200x8x13',
  shape: 'H',
  dims_mm: { h: 400, b: 200, tw: 8, tf: 13, r: 16 },
  source: 'KS D 3502',
  props: { A_mm2: 8412, I2_mm4: 1.74e7, I3_mm4: 2.37e8, J_mm4: 3.56e5 },
};
const I3 = 2.37e8 * 1e-12;
const I2 = 1.74e7 * 1e-12;

export const SM355 = {
  id: 'SM355',
  grade: 'SM355',
  E_MPa: E_MPA,
  G_MPa: G_MPA,
  density_kNpm3: 0,
  Fy_MPa: 355,
  Fu_MPa: 490,
};

const pin = { dx: true, dy: true, dz: true, rx: true };
const roller = { dy: true, dz: true };
const fixed = { dx: true, dy: true, dz: true, rx: true, ry: true, rz: true };

export function baseModel(parts) {
  return {
    schema: 'vide.structure.model/1',
    meta: { name: parts.name ?? 'fixture' },
    materials: [SM355],
    sections: [H400],
    loadPatterns: [{ id: 'D', nature: 'D' }],
    combinations: [{ id: 'C1', terms: [{ pattern: 'D', factor: 1 }], limitState: 'service' }],
    analysis: { kind: 'linearStatic' },
    ...parts,
  };
}

const member = (id, i, j, extra = {}) => ({
  id,
  i,
  j,
  section: 'H400',
  material: 'SM355',
  role: 'beam',
  kind: 'frame',
  ...extra,
});

export const fixtures = [];

{
  const L = 8,
    w = 10;
  fixtures.push({
    id: 'simple-beam-uniform',
    source: 'Simply supported beam, uniform load: M = wL²/8, V = wL/2, δ = 5wL⁴/(384EI)',
    model: baseModel({
      nodes: [
        { id: 'N1', xyz_m: [0, 0, 0], support: pin },
        { id: 'N2', xyz_m: [L, 0, 0], support: roller },
      ],
      members: [member('B1', 'N1', 'N2')],
      loads: [
        {
          id: 'q',
          pattern: 'D',
          type: 'memberUniform',
          targets: ['B1'],
          direction: '-Z',
          value_kNpm: w,
        },
      ],
    }),
    expect: [
      {
        kind: 'force',
        member: 'B1',
        combo: 'C1',
        station: 2,
        component: 'M3',
        value: (w * L * L) / 8,
      },
      {
        kind: 'force',
        member: 'B1',
        combo: 'C1',
        station: 0,
        component: 'V2',
        value: (-w * L) / 2,
      },
      {
        kind: 'force',
        member: 'B1',
        combo: 'C1',
        station: 0,
        component: 'M3',
        value: 0,
        abs: 1e-6,
      },
      { kind: 'reaction', node: 'N1', combo: 'C1', dof: 2, value: (w * L) / 2 },
      {
        kind: 'deflection',
        member: 'B1',
        combo: 'C1',
        value: ((5 * w * L ** 4) / (384 * E * I3)) * 1e3,
      },
    ],
  });
}

{
  const L = 4,
    P = 10;
  fixtures.push({
    id: 'cantilever-point',
    source: 'Cantilever, end point load: δ = PL³/(3EI), M(0) = −PL (hogging)',
    model: baseModel({
      nodes: [
        { id: 'N1', xyz_m: [0, 0, 0], support: fixed },
        { id: 'N2', xyz_m: [L, 0, 0] },
      ],
      members: [member('B1', 'N1', 'N2')],
      loads: [
        { id: 'p', pattern: 'D', type: 'nodePoint', targets: ['N2'], direction: '-Z', value_kN: P },
      ],
    }),
    expect: [
      { kind: 'disp', node: 'N2', combo: 'C1', dof: 2, value: (-P * L ** 3) / (3 * E * I3) },
      { kind: 'force', member: 'B1', combo: 'C1', station: 0, component: 'M3', value: -P * L },
      { kind: 'reaction', node: 'N1', combo: 'C1', dof: 2, value: P },
      { kind: 'reaction', node: 'N1', combo: 'C1', dof: 4, value: -P * L },
    ],
  });
}

{
  const L = 6,
    w = 12;
  const ends = { id: 'N1', xyz_m: [0, 0, 0], support: fixed };
  const endj = { id: 'N2', xyz_m: [L, 0, 0], support: fixed };
  const q = [
    {
      id: 'q',
      pattern: 'D',
      type: 'memberUniform',
      targets: ['B1'],
      direction: '-Z',
      value_kNpm: w,
    },
  ];
  fixtures.push({
    id: 'fixed-beam-uniform',
    source: 'Fixed–fixed beam, uniform load: M end = −wL²/12, M mid = wL²/24, δ = wL⁴/(384EI)',
    model: baseModel({ nodes: [ends, endj], members: [member('B1', 'N1', 'N2')], loads: q }),
    expect: [
      {
        kind: 'force',
        member: 'B1',
        combo: 'C1',
        station: 0,
        component: 'M3',
        value: (-w * L * L) / 12,
      },
      {
        kind: 'force',
        member: 'B1',
        combo: 'C1',
        station: 2,
        component: 'M3',
        value: (w * L * L) / 24,
      },
      {
        kind: 'deflection',
        member: 'B1',
        combo: 'C1',
        value: ((w * L ** 4) / (384 * E * I3)) * 1e3,
      },
    ],
  });
  const release = { ry: true, rz: true };
  fixtures.push({
    id: 'released-ends',
    source:
      'Moment releases at both ends of a fixed–fixed span behave as a simple span: M mid = wL²/8, δ = 5wL⁴/(384EI)',
    model: baseModel({
      nodes: [ends, endj],
      members: [member('B1', 'N1', 'N2', { releases: { i: release, j: release } })],
      loads: q,
    }),
    expect: [
      {
        kind: 'force',
        member: 'B1',
        combo: 'C1',
        station: 0,
        component: 'M3',
        value: 0,
        abs: 1e-6,
      },
      {
        kind: 'force',
        member: 'B1',
        combo: 'C1',
        station: 2,
        component: 'M3',
        value: (w * L * L) / 8,
      },
      {
        kind: 'deflection',
        member: 'B1',
        combo: 'C1',
        value: ((5 * w * L ** 4) / (384 * E * I3)) * 1e3,
      },
    ],
  });
}

{
  const L = 3,
    P = 5;
  const nodes = [
    { id: 'N1', xyz_m: [0, 0, 0], support: fixed },
    { id: 'N2', xyz_m: [L, 0, 0] },
  ];
  const load = [
    { id: 'p', pattern: 'D', type: 'nodePoint', targets: ['N2'], direction: '-Z', value_kN: P },
  ];
  fixtures.push({
    id: 'beta-rotates-axes',
    source: 'Cantilever with betaDeg = 90: vertical load bends the weak axis, δ = PL³/(3EI2)',
    model: baseModel({ nodes, members: [member('B1', 'N1', 'N2', { betaDeg: 90 })], loads: load }),
    expect: [
      { kind: 'disp', node: 'N2', combo: 'C1', dof: 2, value: (-P * L ** 3) / (3 * E * I2) },
    ],
  });
}

{
  const P = 20;
  const truss = (id, i, j) => member(id, i, j, { kind: 'truss', role: 'brace' });
  fixtures.push({
    id: 'triangle-truss',
    source: 'Symmetric triangle truss, apex load P: diagonals −P/(2 sin45°), tie +P/(2 tan45°)',
    model: baseModel({
      nodes: [
        { id: 'A', xyz_m: [0, 0, 0], support: { dx: true, dy: true, dz: true } },
        { id: 'B', xyz_m: [4, 0, 0], support: { dy: true, dz: true } },
        { id: 'C', xyz_m: [2, 0, 2], support: { dy: true } },
      ],
      members: [truss('AC', 'A', 'C'), truss('BC', 'B', 'C'), truss('AB', 'A', 'B')],
      loads: [
        { id: 'p', pattern: 'D', type: 'nodePoint', targets: ['C'], direction: '-Z', value_kN: P },
      ],
    }),
    expect: [
      {
        kind: 'force',
        member: 'AC',
        combo: 'C1',
        station: 2,
        component: 'N',
        value: -P / 2 / Math.SQRT1_2,
      },
      { kind: 'force', member: 'AB', combo: 'C1', station: 2, component: 'N', value: P / 2 },
      { kind: 'autoRestrained', min: 1 },
    ],
  });
}

{
  // Pin-jointed frame with tension-only X braces, lateral load H at the top: T = H / cosθ.
  const H = 10,
    b = 4,
    h = 3;
  const rel = { ry: true, rz: true };
  const base = { dx: true, dy: true, dz: true, rx: true, rz: true };
  fixtures.push({
    id: 'tension-only-brace',
    source:
      'Braced pin frame, lateral load H: tension diagonal H·(5/4), compression diagonal inactive',
    model: baseModel({
      nodes: [
        { id: 'BL', xyz_m: [0, 0, 0], support: base },
        { id: 'BR', xyz_m: [b, 0, 0], support: base },
        { id: 'TL', xyz_m: [0, 0, h], support: { dy: true } },
        { id: 'TR', xyz_m: [b, 0, h], support: { dy: true } },
      ],
      members: [
        member('CL', 'BL', 'TL', { role: 'column', releases: { i: rel } }),
        member('CR', 'BR', 'TR', { role: 'column', releases: { i: rel } }),
        member('BM', 'TL', 'TR', { releases: { i: rel, j: rel } }),
        member('D1', 'BL', 'TR', { kind: 'tensionOnly', role: 'brace' }),
        member('D2', 'TL', 'BR', { kind: 'tensionOnly', role: 'brace' }),
      ],
      loads: [
        { id: 'h', pattern: 'D', type: 'nodePoint', targets: ['TL'], direction: '+X', value_kN: H },
      ],
    }),
    expect: [
      { kind: 'force', member: 'D1', combo: 'C1', station: 2, component: 'N', value: (H * 5) / 4 },
      { kind: 'force', member: 'D2', combo: 'C1', station: 2, component: 'N', value: 0, abs: 1e-9 },
    ],
  });
}

{
  // Portal with pinned bases and a beam released at both ends sways freely in X.
  const rel = { ry: true, rz: true };
  const base = { dx: true, dy: true, dz: true, rx: true };
  fixtures.push({
    id: 'mechanism',
    source:
      'Pinned portal with a pin-ended beam has a sway mechanism; the core must refuse to analyse it',
    model: baseModel({
      nodes: [
        { id: 'BL', xyz_m: [0, 0, 0], support: base },
        { id: 'BR', xyz_m: [4, 0, 0], support: base },
        { id: 'TL', xyz_m: [0, 0, 3], support: { dy: true } },
        { id: 'TR', xyz_m: [4, 0, 3], support: { dy: true } },
      ],
      members: [
        member('CL', 'BL', 'TL', { role: 'column' }),
        member('CR', 'BR', 'TR', { role: 'column' }),
        member('BM', 'TL', 'TR', { releases: { i: rel, j: rel } }),
      ],
      loads: [
        { id: 'h', pattern: 'D', type: 'nodePoint', targets: ['TL'], direction: '+X', value_kN: 1 },
      ],
    }),
    expect: [{ kind: 'status', value: 'error' }, { kind: 'mechanism' }],
  });
}
