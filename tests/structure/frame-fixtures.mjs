// Synthetic frame plans for the structure-analysis library tests (PLAN-23 검증 원칙: fixtures are
// synthetic only). Sizes follow the kinds of members a car-park deck has, not any project's data.

import { H400, SM355 } from './fixtures.mjs';

export const H300 = {
  id: 'H300',
  name: 'H-300x300x10x15',
  shape: 'H',
  dims_mm: { h: 300, b: 300, tw: 10, tf: 15, r: 18 },
  source: 'KS D 3502',
};
export const H500 = {
  id: 'H500',
  name: 'H-500x200x10x16',
  shape: 'H',
  dims_mm: { h: 500, b: 200, tw: 10, tf: 16, r: 20 },
  source: 'KS D 3502',
};
export const STEEL = { ...SM355, density_kNpm3: 77 };

/**
 * One 9 m × 5 m bay: four columns (6 m, restraint at 4 m), two girders along X with rigid ends,
 * three secondary beams across at 2.5 m framing into the girders (the `lb-k` fixture).
 */
export function bayPlan(overrides = {}) {
  const columns = [
    [0, 0],
    [9, 0],
    [0, 5],
    [9, 5],
  ].map(([x, y]) => ({
    key: `C-${x}-${y}`,
    base: [x, y, 0],
    top: [x, y, 6],
    section: 'H300',
    strongAxis: [1, 0, 0],
  }));
  const girders = [0, 5].map((y) => ({
    key: `G-${y}`,
    role: 'girder',
    rail: [
      [0, y, 6],
      [9, y, 6],
    ],
    section: 'H500',
    ends: ['rigid', 'rigid'],
    bracedAt: [2.5 / 9, 5 / 9, 7.5 / 9],
  }));
  const beams = [2.5, 5, 7.5].map((x) => ({
    key: `B-${x}`,
    role: 'beam',
    rail: [
      [x, 0, 6],
      [x, 5, 6],
    ],
    section: 'H400',
    ends: ['pinned', 'pinned'],
  }));
  return {
    name: 'bay',
    sections: [H300, H400, H500],
    materials: [STEEL],
    columns,
    members: [...girders, ...beams],
    lineLoads: [
      ...beams.map((b) => ({ memberKey: b.key, case: 'D', value_kNpm: 6, source: 'area' })),
      ...beams.map((b) => ({ memberKey: b.key, case: 'L', value_kNpm: 8, source: 'area' })),
      ...girders.map((g) => ({ memberKey: g.key, case: 'D', value_kNpm: 2, source: 'edge' })),
    ],
    restraintLevels_m: [4],
    ...overrides,
  };
}

/** Column grid with X girders split by `beamsPerBay` secondary beams: about nx·ny·(2+4+3) segments. */
export function gridPlan({
  nx = 13,
  ny = 13,
  bay = 8,
  depth = 6,
  height = 6,
  beamsPerBay = 3,
} = {}) {
  const columns = [];
  const members = [];
  const lineLoads = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      columns.push({
        key: `C-${i}-${j}`,
        base: [i * bay, j * depth, 0],
        top: [i * bay, j * depth, height],
        section: 'H300',
        strongAxis: [1, 0, 0],
      });
  const fractions = Array.from({ length: beamsPerBay }, (_, k) => (k + 1) / (beamsPerBay + 1));
  for (let j = 0; j < ny; j++)
    for (let i = 0; i + 1 < nx; i++) {
      members.push({
        key: `GX-${i}-${j}`,
        role: 'girder',
        rail: [
          [i * bay, j * depth, height],
          [(i + 1) * bay, j * depth, height],
        ],
        section: 'H500',
        ends: ['rigid', 'rigid'],
        bracedAt: fractions,
      });
      lineLoads.push({ memberKey: `GX-${i}-${j}`, case: 'D', value_kNpm: 1.5, source: 'edge' });
    }
  for (let i = 0; i < nx; i++)
    for (let j = 0; j + 1 < ny; j++)
      members.push({
        key: `GY-${i}-${j}`,
        role: 'girder',
        rail: [
          [i * bay, j * depth, height],
          [i * bay, (j + 1) * depth, height],
        ],
        section: 'H500',
        ends: ['pinned', 'pinned'],
      });
  for (let i = 0; i + 1 < nx; i++)
    for (let j = 0; j + 1 < ny; j++)
      fractions.forEach((f, k) => {
        const key = `B-${i}-${j}-${k}`;
        members.push({
          key,
          role: 'beam',
          rail: [
            [i * bay + f * bay, j * depth, height],
            [i * bay + f * bay, (j + 1) * depth, height],
          ],
          section: 'H400',
          ends: ['pinned', 'pinned'],
        });
        lineLoads.push({ memberKey: key, case: 'D', value_kNpm: 5, source: 'area' });
        lineLoads.push({ memberKey: key, case: 'L', value_kNpm: 6, source: 'area' });
      });
  return {
    name: `grid ${nx}x${ny}`,
    sections: [H300, H400, H500],
    materials: [STEEL],
    columns,
    members,
    lineLoads,
    restraintLevels_m: [height / 2],
  };
}

/** Two columns with an arch girder (rise 1 m over 12 m) between their tops; restraint at the tops. */
export function archPlan() {
  const span = 12,
    rise = 1,
    z = 6;
  const R = (span * span) / (8 * rise) + rise / 2;
  const rail = [];
  for (let k = 0; k <= 24; k++) {
    const x = (span * k) / 24;
    const dx = x - span / 2;
    rail.push([x, 0, z + Math.sqrt(R * R - dx * dx) - (R - rise)]);
  }
  return {
    name: 'arch',
    sections: [H300, H500],
    materials: [STEEL],
    columns: [
      { key: 'C-0', base: [0, 0, 0], top: [0, 0, z], section: 'H300' },
      { key: 'C-1', base: [span, 0, 0], top: [span, 0, z], section: 'H300' },
    ],
    members: [{ key: 'A-1', role: 'girder', rail, section: 'H500', ends: ['rigid', 'rigid'] }],
    lineLoads: [
      { memberKey: 'A-1', case: 'D', value_kNpm: 10, source: 'area' },
      { memberKey: 'A-1', case: 'L', value_kNpm: 12, source: 'area' },
    ],
    restraintLevels_m: [z],
    combos: [
      { id: '1.2D+1.6L', factors: { D: 1.2, L: 1.6 }, use: 'strength' },
      { id: 'D+L', factors: { D: 1, L: 1 }, use: 'service' },
    ],
    notional: false,
  };
}
