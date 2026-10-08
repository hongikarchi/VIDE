// 자료 정리 rules after the T-261 review (SPEC-08.9 2·3·6, PLAN-42 T-261): tables labelled with
// one-letter or code labels (1층·B1·RF·PH·D10·101호) and dates go to the AI, small csv/txt files are
// never data files, a sentence in a number excerpt keeps it for the AI, the excerpt cap keeps the
// newest part, the survey counts excerpts left unfiltered by a stopped run, older .txt/.csv reads
// are read again, stale left-out folders do not block [빼기], and a very wide sheet header does not
// hang chunking. Synthetic fixtures only; no user files, no real CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { docx, fakeRunner, pdf, xlsx } from '../fixtures/documents.mjs';
import {
  DATA_FILE_MIN_CHARS,
  RULE_DATA,
  TEXT_EXCERPT_CAP,
  dataFile,
  dateOrder,
  isDataFragment,
  ruleOf,
} from '../../src/knowledge/collect/filters.ts';
import { CHUNK_HEAD_MAX, chunk, extractBytes } from '../../src/knowledge/collect/documents.ts';
import { KnowledgeCollector } from '../../src/knowledge/collect/collector.ts';
import { modelPlan } from '../../src/knowledge/collect/ai.ts';

const PROJECT = '11111111-2222-4333-8444-555555555555';
const FLOORS = ['B2', 'B1', ...Array.from({ length: 8 }, (_, i) => `${i + 1}층`), 'PH'];
const areaRows = () =>
  FLOORS.map((floor, i) => [floor, 812.3 - i, 98.12, 910.42 - i, 8.5]).concat([
    ['합계', 9105.3, 1079.32, 10184.62, 100],
  ]);
const AREA_HEAD = ['층', '전용면적(㎡)', '공용면적(㎡)', '계(㎡)', '비율(%)'];
const asCsv = (rows) => rows.map((r) => r.join(',')).join('\n');
/** Rules of every excerpt of a file. */
const rules = (read) => read.excerpts.map((e) => ruleOf(e.text));

test('labelled tables: one-letter and code labels, dates and times go to the AI', async () => {
  // (1) an xlsx area schedule whose floors are B2·B1·1층…8층·PH.
  const sheet = await extractBytes(xlsx('면적', [AREA_HEAD, ...areaRows()]), 'xlsx');
  assert.equal(sheet.status, 'done');
  assert.deepEqual(rules(sheet), [null]);
  // (2) the same table under a title in a docx.
  const word = await extractBytes(
    docx(['층별 면적표 (2026-10-05 기준)'], [AREA_HEAD, ...areaRows().map((r) => r.map(String))]),
    'docx',
  );
  assert.ok(word.excerpts.length >= 1);
  assert.ok(rules(word).every((r) => r === null));
  // (3) a PDF page of '1F 812.30 …' rows.
  const page = ['1F', '2F', '3F', 'RF', 'TOTAL']
    .map((f, i) => `${f} ${(812.3 - i).toFixed(2)} 98.12 910.42`)
    .join(' ');
  const read = await extractBytes(pdf(page), 'pdf');
  assert.equal(read.status, 'done');
  assert.deepEqual(rules(read), [null]);
  // (4) an estimate whose rows carry a size code (D10 …).
  const estimate = [['No', '규격', '수량', '단가', '금액']].concat(
    Array.from({ length: 15 }, (_, i) => [i + 1, `D${10 + (i % 4) * 3}`, 12.5, 850000, 10625000]),
  );
  assert.deepEqual(rules(await extractBytes(xlsx('견적', estimate), 'xlsx')), [null]);
  // (5) a schedule memo, dates with weekdays and times.
  assert.equal(
    ruleOf(Array.from({ length: 5 }, (_, i) => `10/${15 + i}(목) 14:00`).join('\n')),
    null,
  );
  // Floors and units with a one-letter Korean label.
  const floors =
    '층 | 바닥면적 | 용적률산정면적\n' +
    Array.from(
      { length: 12 },
      (_, i) => `${i + 1}층 | ${1234.56 - i * 10} | ${1100.2 - i * 9}`,
    ).join('\n');
  assert.equal(ruleOf(floors), null);
  assert.equal(
    ruleOf(Array.from({ length: 20 }, (_, i) => `${101 + i}호 84.97㎡`).join('\n')),
    null,
  );
  // Dumps stay data: bare numbers, and numbers with one repeated label.
  const dump = Array.from({ length: 40 }, (_, i) => `${i}  4521${i}.000  1934${i}.000`).join('\n');
  assert.equal(ruleOf(dump), RULE_DATA);
  assert.equal(
    ruleOf(Array.from({ length: 10 }, (_, i) => `POINT ${i} ${i * 2} ${i * 3}`).join('\n')),
    RULE_DATA,
  );
});

test('small csv/txt tables are read whole, never as data files', async () => {
  const cases = {
    '면적표.csv': asCsv([AREA_HEAD, ...areaRows()]),
    '면적 검토.txt':
      '면적 검토\n\n' + [AREA_HEAD, ...areaRows()].map((r) => r.join('\t')).join('\n'),
    '레벨표.csv': asCsv([
      ['구분', 'FL', 'SL', '층고'],
      ['B2', -8.4, -8.55, 4.2],
      ['B1', -4.2, -4.35, 4.2],
      ['1F', 0, -0.15, 4.5],
      ['2F', 4.5, 4.35, 3.6],
      ['3F', 8.1, 7.95, 3.6],
      ['4F', 11.7, 11.55, 3.6],
      ['5F', 15.3, 15.15, 3.6],
      ['RF', 18.9, 18.75, 0],
    ]),
    '주간공정률.csv': asCsv(
      [['주차', '시작일', '종료일', '누계공정률(%)', '계획공정률(%)']].concat(
        Array.from({ length: 30 }, (_, i) => {
          const day = (n) => new Date(Date.UTC(2026, 2, 2 + n)).toISOString().slice(0, 10);
          return [i + 1, day(i * 7), day(i * 7 + 6), (i * 3.1).toFixed(1), (i * 3.3).toFixed(1)];
        }),
      ),
    ),
    'dates.txt': '마감\n10/15\n10/22\n10/29\n11/05\n11/12\n11/19',
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.ok(text.length < DATA_FILE_MIN_CHARS, name);
    assert.equal(dataFile(text), null, name);
    const read = await extractBytes(Buffer.from(text, 'utf8'), name.split('.').pop());
    assert.equal(read.status, 'done', name);
    const all = read.excerpts.map((e) => e.text).join('\n');
    // Nothing is lost: the last row is kept, and it goes to the AI.
    const last = text.trim().split('\n').at(-1).split(/[,\t]/)[0];
    assert.ok(all.includes(last), `${name}: ${last}`);
    assert.ok(
      rules(read).every((r) => r === null),
      name,
    );
  }
});

const COORDS = (n) =>
  Array.from({ length: n }, (_, i) => `${i + 1}  ${452100 + i * 1.5}.000  ${193400 + i}.000`).join(
    '\n',
  );

test('a sentence keeps a number excerpt for the AI; a data file keeps its sentences', async () => {
  const survey = chunk(
    '# 측량 협의\n\n대지 경계는 측량성과도 좌표로 확정하고, 북측 인접대지 경계석은 이전하지 않기로 시공사와 합의했다.\n\n점번호  X  Y\n' +
      COORDS(25),
    'body',
  );
  assert.equal(survey.length, 1);
  assert.equal(ruleOf(survey[0].text), null);
  const mail =
    '보 춤은 700으로 확정합니다.\n' +
    Array.from({ length: 12 }, (_, i) => `${i + 1}. ${700 + i * 50} ${i * 3}`).join('\n');
  assert.equal(ruleOf(mail), null);
  // A header of single letters alone is not a sentence.
  assert.equal(isDataFragment('점번호  X  Y\n' + COORDS(25)), true);
  // A .txt number dump past 64K characters with its conclusion at the end.
  const conclusion = '결론: 북측 경계석은 이전하지 않기로 시공사와 합의했다.';
  const text = '점번호  X  Y\n' + COORDS(3000) + '\n\n' + conclusion;
  assert.ok(text.length > 64 * 1024);
  const read = await extractBytes(Buffer.from(text, 'utf8'), 'txt');
  assert.equal(read.status, 'data');
  assert.equal(read.excerpts[0].kind, 'data');
  const kept = read.excerpts.slice(1);
  assert.ok(kept.length >= 1 && kept.length <= 2);
  assert.ok(kept.some((e) => e.text.includes(conclusion)));
  assert.ok(kept.every((e) => ruleOf(e.text) === null));
});

test('excerpt cap keeps the newest part of a log written downward', async () => {
  const day = (n) => new Date(Date.UTC(2020, 0, 6 + n * 7)).toISOString().slice(0, 10);
  const log = Array.from(
    { length: 260 },
    (_, i) =>
      `## ${i + 1}차 회의 (${day(i)})\n\n` +
      `${i + 1}번 샘플 결정: 외벽 마감은 석재로 하고 줄눈 폭은 10mm로 한다. `.repeat(24),
  ).join('\n\n');
  const read = await extractBytes(Buffer.from(log), 'md');
  assert.equal(read.excerpts.length, TEXT_EXCERPT_CAP);
  assert.ok(read.overflow > 0);
  assert.equal(read.excerpts.length + read.overflow, chunk(log, 'body').length);
  assert.match(read.excerpts.at(-1).text, /260번 샘플/);
  assert.doesNotMatch(read.excerpts[0].text, /^## 1차 회의/);
  // Newest first: the first part stays. Without dates: both ends stay.
  const reversed = log.split('\n\n## ').reverse().join('\n\n## ');
  assert.equal(dateOrder(chunk(reversed, 'body')), 'descending');
  const undated = Array.from({ length: 300 }, (_, i) =>
    `${i + 1}번째 문단의 결정 사항은 이것이다. `.repeat(30),
  ).join('\n\n');
  const both = await extractBytes(Buffer.from(undated), 'md');
  assert.equal(both.excerpts.length, TEXT_EXCERPT_CAP);
  assert.match(both.excerpts[0].text, /^1번째/);
  assert.match(both.excerpts.at(-1).text, /300번째/);
});

test('a very wide sheet header does not stop chunking', () => {
  for (const length of [1199, 1200, 1300, 5000]) {
    const head = 'H'.repeat(length);
    const parts = chunk('값 1 | 2 | 3\n\n값 4 | 5 | 6', 'sheet:S', 'sheet', head);
    assert.equal(parts.length, 1, String(length));
    assert.ok(parts[0].text.length <= 1200 + 1);
    assert.ok(parts[0].text.startsWith('H'.repeat(Math.min(length, CHUNK_HEAD_MAX))));
  }
});

/** A collector over `folders()` with a fake runner; `failFilter` makes every filter call fail. */
function collectorFor(data, folders, runner) {
  return new KnowledgeCollector({
    dataDirectory: data,
    folders,
    denied: () => false,
    runner,
    plan: async () => modelPlan(['claude-cli'], []),
    agenda: () => [],
    now: () => new Date(2026, 9, 8, 9, 0),
  });
}

test('survey counts excerpts a stopped run left unfiltered; the next run sends them', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-collect-pending-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, 'data'),
    project = join(directory, '합성 프로젝트');
  await mkdir(join(project, '회의록'), { recursive: true });
  for (let i = 0; i < 120; i++)
    await writeFile(
      join(project, '회의록', `${i + 1}차.md`),
      `${i + 1}차 회의: 기둥 간격은 ${8 + (i % 3)}m로 확정하고 다음 회의에서 다시 본다.`,
    );
  const ok = fakeRunner();
  const failing = {
    calls: [],
    async run(request) {
      if (request.role === 'filter') throw new Error('filter down');
      return ok.run(request);
    },
  };
  const first = collectorFor(data, () => [project], failing);
  await first.start(PROJECT);
  await first.idle(PROJECT);
  assert.equal(first.status(PROJECT).state, 'failed');
  const survey = await first.survey(PROJECT);
  assert.equal(survey.read.files, 0);
  assert.equal(survey.unchanged, 120);
  assert.equal(survey.pending, 120);
  assert.equal(survey.estimate.excerpts, 120);
  assert.equal(survey.estimate.filterCalls, 3);
  assert.deepEqual(
    survey.heavy.map((h) => [h.path, h.excerpts]),
    [['회의록', 120]],
  );
  const second = collectorFor(data, () => [project], ok);
  await second.start(PROJECT);
  await second.idle(PROJECT);
  assert.equal(second.status(PROJECT).state, 'done');
  assert.equal(ok.calls.filter((c) => c.role === 'filter').length, 3);
  assert.equal((await second.survey(PROJECT)).pending, 0);
});

test('a dump read before data files is read again; stale left-out folders do not block', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-collect-reread-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, 'data'),
    root = join(directory, 'P'),
    a = join(root, 'A'),
    b = join(root, 'B');
  await mkdir(join(b, 'sub'), { recursive: true });
  await mkdir(a, { recursive: true });
  await writeFile(join(a, '좌표.txt'), '점번호  X  Y\n' + COORDS(2000));
  await writeFile(join(a, '회의.md'), '외장재는 석재로 바꾸기로 합의했다.');
  let folders = [a, b];
  const runner = fakeRunner();
  const collector = collectorFor(data, () => folders, runner);
  await collector.start(PROJECT);
  await collector.idle(PROJECT);
  assert.equal(collector.status(PROJECT).counts.data, 1);
  // As an older reader left it: read as a document with every slice kept.
  const db = new DatabaseSync(collector.file(PROJECT));
  db.exec("update source set status = 'done', reader = null where ext = 'txt'");
  db.close();
  const stale = await collector.survey(PROJECT);
  assert.equal(stale.skipped.data, 1);
  await collector.start(PROJECT);
  await collector.idle(PROJECT);
  const check = new DatabaseSync(collector.file(PROJECT), { readOnly: true });
  assert.equal(check.prepare("select status from source where ext = 'txt'").get().status, 'data');
  check.close();
  assert.equal(collector.status(PROJECT).counts.data, 1);

  // A folder left out under B stays in the list after B is removed from the project folders.
  collector.setExclusions(PROJECT, ['B/sub']);
  folders = [a];
  assert.deepEqual((await collector.survey(PROJECT)).exclude, []);
  const kept = collector.setExclusions(PROJECT, [join(b, 'sub'), 'x']);
  assert.deepEqual(kept, [join(a, 'x')]);
  // A new path outside the project folders is still refused.
  assert.throws(() => collector.setExclusions(PROJECT, ['..']), { code: 'INVALID_INPUT' });
});
