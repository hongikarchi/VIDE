// 마감 일람표 jig engine (SPEC-11, PLAN-43 T-198): the official library's shape and privacy, search
// and facet counts, thickness adjustments and warnings, room rules, paste import, 실 마감표 and
// 마감 일람표 rows and their CSV. Synthetic room lists only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  baseText,
  codeScheduleCsv,
  codeScheduleRows,
  facetCount,
  layersOf,
  parseRoomPaste,
  parseTable,
  resetThickness,
  roomScheduleCsv,
  roomScheduleRows,
  roomsText,
  searchCodes,
  setThickness,
  splitCodes,
  totalOf,
  validateRooms,
  warningsOf,
  withUsed,
} from '../../src/jigs/finish.ts';
import {
  finishCode,
  finishLibrary,
  library,
  searchFinishCodes,
} from '../../src/jigs/official/finish-codes/index.ts';
import { officialLibraries } from '../../src/jigs/runtime/loader.ts';

const lib = finishLibrary();
const room = (id, name, F = [], W = [], C = [], floor = '1층', no = '') => ({
  id,
  floor,
  no,
  name,
  F,
  W,
  C,
});

test('the library holds the code system only: 477 codes, 145 materials, 8 tables, no projects', () => {
  assert.equal(Object.keys(lib.codes).length, 477);
  assert.equal(Object.keys(lib.mats).length, 145);
  assert.equal(lib.ref.length, 8);
  assert.ok(lib.notes.standard.length > 0);
  for (const [code, entry] of Object.entries(lib.codes)) {
    assert.match(code, /^[FWC]\d{4}$/);
    assert.equal(entry.code, code);
    assert.equal(code[0], entry.el);
    assert.equal(code[1], String(entry.fam));
    assert.equal(code[2], String(entry.fin_d));
  }
  // AI.md §8: the prototype's project lists, people and project notes never ship.
  const raw = JSON.parse(
    readFileSync(new URL('../../src/jigs/official/finish-codes/library.json', import.meta.url)),
  );
  assert.deepEqual(Object.keys(raw).sort(), [
    'codes',
    'generated',
    'mats',
    'notes',
    'ref',
    'system',
    'version',
  ]);
  assert.deepEqual(Object.keys(raw.notes), ['standard']);
});

test('vide/finish-codes is an official library with lookup and search functions', async () => {
  const libraries = await officialLibraries();
  assert.equal(libraries['vide/finish-codes'].version, library.version);
  assert.ok(libraries['vide/finish-codes'].functions.includes('searchFinishCodes'));
  assert.equal(finishCode('f0001').code, 'F0001');
  assert.equal(finishCode('X9999'), null);
  assert.deepEqual(searchFinishCodes({ el: 'C' }), searchCodes(lib, { el: 'C' }));
});

test('filters: element, categories (any), finishes (any), tags (all), words (all), total', () => {
  const walls = searchCodes(lib, { el: 'W' });
  assert.equal(walls.length, 255);
  assert.ok(walls.every((code) => code.startsWith('W')));
  const studs = searchCodes(lib, { el: 'W', fam: ['3'] });
  assert.ok(studs.length > 0 && studs.every((code) => code.startsWith('W3')));
  const two = searchCodes(lib, { el: 'W', fam: ['3', '4'] });
  assert.equal(two.length, studs.length + searchCodes(lib, { el: 'W', fam: ['4'] }).length);
  const tiled = searchCodes(lib, { el: 'F', fin: ['3'] });
  assert.ok(tiled.every((code) => lib.codes[code].fin_d === 3));
  const wet = searchCodes(lib, { tag: ['방수', '습식'] });
  assert.ok(wet.length > 0);
  assert.ok(wet.every((code) => lib.codes[code].tags.includes('방수')));
  assert.ok(wet.every((code) => lib.codes[code].tags.includes('습식')));
  const words = searchCodes(lib, { q: '에폭시 코팅' });
  assert.ok(words.includes('F0101'));
  assert.ok(!words.includes('F0102'), '라이닝 has 에폭시 but not 코팅');
  const thin = searchCodes(lib, { el: 'F', tmax: 0 });
  assert.ok(thin.includes('F0001') && thin.every((code) => totalOf(lib, code) === 0));
  // Shown: adopted / the rest.
  assert.deepEqual(searchCodes(lib, { show: 'adopted' }, { adopted: ['F0002', 'W3101'] }), [
    'F0002',
    'W3101',
  ]);
  assert.equal(
    searchCodes(lib, { show: 'rest' }, { adopted: ['F0002'] }).length,
    Object.keys(lib.codes).length - 1,
  );
  // The count beside a choice is what the filter keeps with it.
  assert.equal(facetCount(lib, { el: 'W' }, 'fam', '3'), studs.length);
  assert.equal(facetCount(lib, { el: 'W', fam: ['3'] }, 'el', 'F'), 160);
});

test('thickness: adjusted per project, fixed layers kept, warnings above the 상한, reset', () => {
  // F0103: 면정리 (fixed) + 에폭시 몰탈 4 (3~10, 상한 10).
  assert.equal(totalOf(lib, 'F0103'), 4);
  let thk = setThickness(lib, {}, 'F0103', 1, 12);
  assert.deepEqual(thk, { F0103: { 1: 12 } });
  assert.equal(totalOf(lib, 'F0103', thk), 12);
  const [warning] = warningsOf(lib, 'F0103', thk);
  assert.equal(warning.nm, '에폭시 몰탈');
  assert.ok(warning.alt.length > 0, 'the library names the alternative');
  assert.equal(setThickness(lib, thk, 'F0103', 0, 5), thk, 'a fixed layer does not change');
  assert.equal(setThickness(lib, thk, 'F0103', 1, -3).F0103[1], 0, 'negative is 0');
  thk = setThickness(lib, thk, 'F0103', 1, 4);
  assert.deepEqual(thk, {}, 'back to the library value: no adjustment');
  thk = resetThickness(setThickness(lib, {}, 'F0103', 1, 6), 'F0103');
  assert.deepEqual(thk, {});
  const layers = layersOf(lib, 'F0103', { F0103: { 1: 6 } });
  assert.deepEqual(
    layers.map((layer) => [layer.t, layer.def, layer.fixed]),
    [
      [0, 0, true],
      [6, 4, false],
    ],
  );
  assert.equal(baseText(lib, 'F0103', { F0103: { 1: 6 } }), '콘크리트 면정리');
});

test('room rules: known code, matching element, no repeats', () => {
  const rooms = [
    room('a', '거실', ['F0002'], ['W3101'], []),
    room('b', '욕실', ['W3101', 'F9999'], ['W3101', 'W3101'], ['F0002']),
  ];
  const issues = validateRooms(lib, rooms).map((i) => [i.roomId, i.element, i.code, i.reason]);
  assert.deepEqual(issues, [
    ['b', 'F', 'W3101', 'element'],
    ['b', 'F', 'F9999', 'unknown'],
    ['b', 'W', 'W3101', 'duplicate'],
    ['b', 'C', 'F0002', 'element'],
  ]);
  assert.deepEqual(validateRooms(lib, [rooms[0]]), []);
  assert.deepEqual(
    validateRooms(lib, [room('a', 'x'), room('a', 'y')]).map((i) => i.reason),
    ['id'],
  );
  assert.deepEqual(withUsed(['C0001'], rooms.slice(0, 1)), ['C0001', 'F0002', 'W3101']);
});

test('paste: Excel tab rows and quoted CSV, header skipped, bad codes left out and listed', () => {
  assert.deepEqual(parseTable('a\t"b\tc"\t"d ""e"""\r\n\r\nf\tg'), [
    ['a', 'b\tc', 'd "e"'],
    ['f', 'g'],
  ]);
  assert.deepEqual(splitCodes('f0001, F0002·f0101;\nF0102 / F0103'), [
    'F0001',
    'F0002',
    'F0101',
    'F0102',
    'F0103',
  ]);
  let n = 0;
  const pasted = parseRoomPaste(
    lib,
    '층별\t실번호\t실명\t바닥\t벽\t천장\n1층\t101\t합성 로비\tF0002 F0101\tW3101\tC0001\n1층\t102\t합성 창고\tW3101 F0001\t\tZ1\n',
    () => `r${++n}`,
  );
  assert.equal(pasted.header, true);
  assert.deepEqual(
    pasted.rooms.map((r) => [r.id, r.floor, r.no, r.name, r.F, r.W, r.C]),
    [
      ['r1', '1층', '101', '합성 로비', ['F0002', 'F0101'], ['W3101'], ['C0001']],
      ['r2', '1층', '102', '합성 창고', ['F0001'], [], []],
    ],
  );
  assert.deepEqual(
    pasted.skipped.map((s) => [s.line, s.element, s.code, s.reason]),
    [
      [3, 'F', 'W3101', 'element'],
      [3, 'C', 'Z1', 'unknown'],
    ],
  );
  // No header: the first row is a room.
  const csv = parseRoomPaste(lib, 'B1,B01,"합성 기계실, 전기실",F0001,,', () => 'x');
  assert.equal(csv.header, false);
  assert.deepEqual(csv.rooms[0].name, '합성 기계실, 전기실');
});

test('실 마감표 rows: one line per code in the busiest cell; 마감 일람표: adopted and used codes', () => {
  const rooms = [
    room('a', '합성 로비', ['F0002', 'F0103'], ['W3101'], [], '1층', '101'),
    room('b', '합성 복도', ['F0002'], [], [], '1층', '102'),
    room('c', '합성 빈 실', [], [], [], '2층', '201'),
  ];
  const thk = { F0103: { 1: 12 } };
  const rows = roomScheduleRows(lib, rooms, thk);
  assert.deepEqual(
    rows.map((r) => [r.roomId, r.line, r.lines, r.cells.F?.code, r.cells.W?.code ?? null]),
    [
      ['a', 0, 2, 'F0002', 'W3101'],
      ['a', 1, 2, 'F0103', null],
      ['b', 0, 1, 'F0002', null],
      ['c', 0, 1, undefined, null],
    ],
  );
  assert.equal(rows[1].cells.F.thk, '12', 'the adjustment shows in the schedule');
  assert.equal(rows[1].cells.F.finish, '에폭시 몰탈');
  assert.equal(rows[0].cells.F.thk, '—', 'no thickness: a dash');

  const sheet = { adopted: ['C0001', 'F0002'], thk };
  const hidden = codeScheduleRows(lib, rooms, sheet);
  assert.deepEqual(
    hidden.map((r) => [r.code, r.rooms, r.unused]),
    [
      ['F0002', ['합성 로비', '합성 복도'], false],
      ['F0103', ['합성 로비'], false],
      ['W3101', ['합성 로비'], false],
    ],
  );
  const ghost = codeScheduleRows(lib, rooms, sheet, 'ghost');
  assert.deepEqual(ghost[0].code, 'C0001');
  assert.equal(ghost[0].unused, true);
  assert.equal(roomsText([], true), '미배정');
  assert.equal(roomsText(['a', 'b', 'c', 'd', 'e', 'f']), 'a, b, c, d 외 2');

  const csv = roomScheduleCsv(lib, rooms, thk);
  assert.ok(csv.startsWith('﻿"층별","실번호","실명","바닥 바탕"'));
  assert.equal(csv.split('\r\n').length, 1 + rows.length + 1);
  assert.match(csv, /"1층","101","합성 로비",.*"F0002"/);
  const codes = codeScheduleCsv(lib, rooms, sheet, 'ghost');
  assert.match(codes, /"C0001","천장",.*"미배정"\r\n/);
});
