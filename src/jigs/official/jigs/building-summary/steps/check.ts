// ③ 일관성 점검 (SPEC-12.13 4): before anything is exported, every number of the 건축개요 must be a
// number of its sources — the handed-over 고른 대안 (areas, ratios, counts, 규제 조건 values) or the
// 대지 요약 (`numbers-in-source`, the cells' own numbers, not their text) — each cell's text and 평
// must be written from that number, and the 층별 면적표 must add up: the floor rows to the 지상·지하·합계
// rows and those to the overview's 연면적 and 용적률 산정 연면적, and the floor count to the 규모.
// When anything differs the tables to export stay empty and the differing cells are listed; the
// report frame refuses to export (its `export` condition) until the numbers agree again.

import {
  cellText,
  numbersOf,
  pyOf,
  type FloorRow,
  type MassInput,
  type OverviewRow,
  type SiteInput,
} from './common.ts';
import type { SummaryOutput } from './summary.ts';

export interface Mismatch {
  cell: string;
  shown: string;
  expected: string;
  reason: string;
}
export interface CheckOutput {
  ok: boolean;
  mismatchCount: number;
  mismatches: Mismatch[];
  /** The tables to export (CSV · report) — empty while a number does not match. */
  overview: OverviewRow[];
  floors: FloorRow[];
  floorsCount: number;
  checked: number;
}

const TOL = 1e-6;
const same = (a: number, b: number) => Math.abs(a - b) <= TOL * Math.max(1, Math.abs(b));
const text = (n: number) => String(Math.round(n * 1e6) / 1e6);

export function check(inputs: {
  mass?: MassInput;
  site?: SiteInput;
  steps?: { summary?: SummaryOutput };
}): CheckOutput {
  const s = inputs.steps?.summary;
  if (!s) throw new Error('건축개요 단계의 결과가 없습니다');
  const source = [
    ...numbersOf(inputs.mass?.value ?? null),
    ...numbersOf(inputs.site?.value ?? null),
  ];
  const inSource = (n: number) => source.some((v) => same(n, v));
  const out: Mismatch[] = [];
  let checked = 0;
  const cellName = (r: OverviewRow) => `${r.item}${r.sub ? `(${r.sub})` : ''}`;

  for (const r of s.overview) {
    if (r.value === null) continue;
    checked++;
    if (!inSource(r.value))
      out.push({
        cell: cellName(r),
        shown: r.text,
        expected: '고른 대안·규제 조건·대지 요약에 있는 값',
        reason: `${text(r.value)}이(가) 출처에 없습니다`,
      });
    const written = cellText(r.value, r.unit);
    if (r.text !== written)
      out.push({
        cell: cellName(r),
        shown: r.text,
        expected: written,
        reason: '글자가 값과 다릅니다',
      });
    if (r.py !== null && (r.unit !== '㎡' || !same(r.py, pyOf(r.value))))
      out.push({
        cell: `${cellName(r)} 평`,
        shown: String(r.py),
        expected: String(pyOf(r.value)),
        reason: '평 환산이 값과 다릅니다',
      });
  }

  const floors = s.floors.filter((f) => f.kind === 'floor');
  for (const f of floors)
    for (const field of ['area', 'exclusion', 'farArea'] as const) {
      checked++;
      if (!inSource(f[field]))
        out.push({
          cell: `층별 ${f.floor} ${FIELD[field]}`,
          shown: text(f[field]),
          expected: '고른 대안의 층 값',
          reason: '출처에 없습니다',
        });
    }
  const sumOf = (list: FloorRow[], field: 'area' | 'farArea') =>
    list.reduce((acc, f) => acc + f[field], 0);
  const above = floors.filter((f) => !f.floor.startsWith('B'));
  const below = floors.filter((f) => f.floor.startsWith('B'));
  const total = (key: string) => s.floors.find((f) => f.key === key);
  const cell = (key: string) => s.overview.find((r) => r.key === key);
  const agree = (name: string, sum: number, shown: number | undefined | null, what: string) => {
    checked++;
    if (shown === undefined || shown === null || !same(sum, shown))
      out.push({
        cell: name,
        shown: shown === undefined || shown === null ? '없음' : text(shown),
        expected: text(sum),
        reason: what,
      });
  };
  agree(
    '층별 지상 합계',
    sumOf(above, 'area'),
    total('total:above')?.area,
    '지상 층 면적의 합과 다릅니다',
  );
  agree(
    '층별 지하 합계',
    sumOf(below, 'area'),
    total('total:below')?.area,
    '지하 층 면적의 합과 다릅니다',
  );
  agree('층별 합계', sumOf(floors, 'area'), total('total:all')?.area, '층 면적의 합과 다릅니다');
  agree(
    '연면적(지상)',
    sumOf(above, 'area'),
    cell('gfa-above')?.value,
    '층별 지상 합계와 다릅니다',
  );
  agree(
    '연면적(지하)',
    sumOf(below, 'area'),
    cell('gfa-below')?.value,
    '층별 지하 합계와 다릅니다',
  );
  agree('연면적(합계)', sumOf(floors, 'area'), cell('gfa-total')?.value, '층별 합계와 다릅니다');
  agree(
    '용적률 산정 연면적',
    sumOf(floors, 'farArea'),
    cell('far-area')?.value,
    '층별 용적률 산정 포함 면적의 합과 다릅니다',
  );
  agree(
    '규모(지상)',
    above.length,
    cell('floors-above')?.value,
    '층별 면적표의 지상 층 수와 다릅니다',
  );
  agree(
    '규모(지하)',
    below.length,
    cell('floors-below')?.value,
    '층별 면적표의 지하 층 수와 다릅니다',
  );
  for (const f of s.floors)
    if (!same(f.py, pyOf(f.area)))
      out.push({
        cell: `층별 ${f.floor} 평`,
        shown: String(f.py),
        expected: String(pyOf(f.area)),
        reason: '평 환산이 값과 다릅니다',
      });

  const ok = out.length === 0;
  return {
    ok,
    mismatchCount: out.length,
    mismatches: out,
    overview: ok ? s.overview : [],
    floors: ok ? s.floors : [],
    floorsCount: ok ? s.floors.length : 0,
    checked,
  };
}

const FIELD = { area: '바닥면적', exclusion: '산정 제외 면적', farArea: '용적률 산정 포함 면적' };
