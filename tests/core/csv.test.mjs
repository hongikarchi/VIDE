// The shared CSV writer (PLAN-54 T-341, SPEC-07.11 표는 CSV): quotes, commas and line breaks are
// quoted, formula-like text is kept as words, numbers stay numbers, BOM + CRLF by default; the
// screens that moved onto it write what they wrote before. Synthetic values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { csvCell, csvFile, csvText } from '../../src/core/csv.ts';
import { toCsv } from '../../src/ui/jig-panel/bindings.ts';
import { quantitiesCsv } from '../../src/core/quantities.ts';

test('cells: quoting, formula guard, numbers and empties', () => {
  assert.equal(csvCell('보 A'), '보 A');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('그는 "예"'), '"그는 ""예"""');
  assert.equal(csvCell('두 줄\n둘째'), '"두 줄\n둘째"');
  assert.equal(csvCell('a\r\nb'), '"a\r\nb"');
  assert.equal(csvCell('=SUM(1)'), "'=SUM(1)");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('@x,y'), `"'@x,y"`);
  assert.equal(csvCell(-1.5), '-1.5', 'numbers are not guarded');
  assert.equal(csvCell(Number.NaN), '');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(true), 'true');
  assert.equal(csvCell('=x', { guard: false }), '=x');
  assert.equal(csvCell('-3~4', { guard: (t) => !/^-?\d/.test(t) && /^[-=]/.test(t) }), '-3~4');
  assert.equal(csvCell('a', { quote: 'always' }), '"a"');
  assert.equal(csvCell(null, { quote: 'always' }), '""');
});

test('text: BOM, CRLF and a trailing CRLF; BOM can be left out', () => {
  assert.equal(
    csvText([
      ['a', 1],
      ['b,c', null],
    ]),
    '﻿a,1\r\n"b,c",\r\n',
  );
  assert.equal(csvText([['a']], { bom: false }), 'a\r\n');
  assert.equal(csvFile(['이름', '값'], [['x', 2]]), '﻿이름,값\r\nx,2\r\n');
});

test('screens on the shared writer keep their output', () => {
  const rows = [
    { name: '=A1', span: 7.25, note: 'a,b' },
    { name: 'B', span: null, note: '—' },
  ];
  assert.equal(
    toCsv(rows, [
      { field: 'name', label: '이름' },
      { field: 'span', label: '경간', unit: 'm', decimals: 1 },
      { field: 'note', label: '메모' },
    ]),
    '﻿이름,경간 (m),메모\r\n\'=A1,7.3,"a,b"\r\nB,,\r\n',
  );
  // 수량표: every cell quoted, a null measure '미상', formula-like numbers guarded too.
  const table = {
    basis: 'r1',
    host: 'rhino',
    source: '확정',
    query: { groupBy: 'none' },
    rows: [{ id: 'o1', name: '=보', type: 'curve', layer: 'L', length: -2, area: null, volume: 1 }],
    groups: [],
  };
  const lines = quantitiesCsv(table).split('\r\n');
  assert.ok(lines[0].startsWith('﻿"기준 후보","호스트"'));
  assert.ok(lines[1].startsWith(`"r1","rhino","o1","'=보","curve","L","'-2","미상","1"`));
});
