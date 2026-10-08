// 자료 정리 without number dumps (SPEC-08.9 2·3·5, PLAN-42 T-261): rule verdicts for data fragments
// (and documents with tables that must stay), data files kept as their first lines, the per-file
// excerpt cap, chunking without half-length slices, environment and generated folders, folders
// left out, and the survey before a run. Synthetic fixtures only; no user files, no real CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fakeRunner } from '../fixtures/documents.mjs';
import {
  DATA_FILE_HEAD_LINES,
  DATA_FILE_LONG_LINE,
  DATA_MIN_LABELLED_LINES,
  DATA_MIN_LETTER_RATIO,
  DOCUMENT_EXCERPT_CAP,
  RULE_DATA,
  RULE_SHORT,
  TEXT_EXCERPT_CAP,
  dataFile,
  dataHead,
  isDataFragment,
  ruleOf,
  textShape,
} from '../../src/knowledge/collect/filters.ts';
import { chunk, extractBytes } from '../../src/knowledge/collect/documents.ts';
import {
  isEnvironment,
  listFiles,
  rootsOf,
  skipDir,
} from '../../src/knowledge/collect/inventory.ts';
import { surveyFolders } from '../../src/knowledge/collect/survey.ts';
import { KnowledgeCollector } from '../../src/knowledge/collect/collector.ts';
import { modelPlan } from '../../src/knowledge/collect/ai.ts';

const PROJECT = '11111111-2222-4333-8444-555555555555';

// --- Synthetic fixtures -------------------------------------------------------------------------
const MINUTES = `구조 협의 회의록 (2026-10-06)
참석: 건축 김 소장, 구조 이 대리, 설비 박 과장
1. 기둥 간격은 9m로 확정한다.
2. 옥상 조경 하중은 5kN/m2를 적용하기로 합의했다.
3. 지하 2층 기계실 바닥 레벨은 -8.40m로 한다.
4. 다음 회의는 10월 15일 오후 2시 현장 사무실.`;
const AREA_TABLE = `층 | 용도 | 전용면적(㎡) | 공용면적(㎡) | 계약면적(㎡)
지하2층 | 주차장 | 1,234.56 | 234.56 | 1,469.12
지하1층 | 기계실 | 987.65 | 123.45 | 1,111.10
1층 | 근린생활시설 | 456.78 | 45.67 | 502.45
2층 | 업무시설 | 812.30 | 98.12 | 910.42
3층 | 업무시설 | 812.30 | 98.12 | 910.42
옥탑 | 계단실 | 32.10 | 0.00 | 32.10
합계 | | 5,135.99 | 600.04 | 5,736.03`;
/** A coordinate dump: x y z triples on one line, no letters. */
const coordinates = (n, seed = 1) =>
  Array.from(
    { length: n },
    (_, i) =>
      `${(seed * 1000 + i * 0.731).toFixed(3)} ${(2000 - i * 0.417).toFixed(3)} ${(i % 17).toFixed(2)}`,
  ).join(' ');
/** A CSV of numbers whose only text is its header. */
const numericCsv = (rows) =>
  ['x,y,z,load']
    .concat(
      Array.from({ length: rows }, (_, i) => `${i * 1.5},${i * 2.25},${(i % 9) * 0.1},${i % 13}`),
    )
    .join('\n');

test('rule thresholds: data fragments go without AI, documents with tables stay', () => {
  assert.equal(DATA_MIN_LETTER_RATIO, 0.12);
  assert.equal(DATA_MIN_LABELLED_LINES, 0.5);
  // Minutes and an area schedule with Korean labels on every row are documents.
  assert.equal(isDataFragment(MINUTES), false);
  assert.equal(ruleOf(MINUTES), null);
  assert.equal(isDataFragment(AREA_TABLE), false);
  const area = textShape(AREA_TABLE);
  assert.ok(area.labelledLines / area.lines >= DATA_MIN_LABELLED_LINES);
  // Even a number-heavy table stays when its rows are labelled.
  const heavy = AREA_TABLE.replace(/\| (\S+) \|/g, '| $1 1,234.567 2,345.678 |');
  assert.ok(textShape(heavy).letters / textShape(heavy).chars < 0.3);
  assert.equal(isDataFragment(heavy), false);
  // A coordinate dump and the body of a number CSV are data.
  assert.equal(isDataFragment(coordinates(80)), true);
  assert.equal(ruleOf(coordinates(80)), RULE_DATA);
  assert.equal(isDataFragment(numericCsv(60)), true);
  // A dump that repeats one label is data too; short text keeps the short rule.
  const points = Array.from({ length: 10 }, (_, i) => `POINT ${i} ${i * 2} ${i * 3}`).join('\n');
  assert.equal(isDataFragment(points), true);
  assert.equal(ruleOf('12 34'), RULE_SHORT);
  assert.equal(ruleOf('기둥 9m 확정'), RULE_SHORT);
});

test('data files: number dumps keep only their first lines; documents are chunked as before', async () => {
  // A multi-MB-like single line (here just past the long-line limit).
  const dump = coordinates(Math.ceil(DATA_FILE_LONG_LINE / 20) + 10);
  assert.ok(dump.length > DATA_FILE_LONG_LINE);
  assert.equal(dataFile(dump), 'long-line');
  const csv = numericCsv(500);
  assert.equal(dataFile(csv), 'numeric');
  const head = dataHead(csv);
  assert.equal(head.text.split('\n').length, DATA_FILE_HEAD_LINES);
  assert.match(head.text, /^x,y,z,load\n0,0,0,0/);
  // A long line of prose is not a data file; minutes and an area table are documents.
  assert.equal(dataFile('기둥 간격은 9m로 확정한다 '.repeat(3000)), null);
  assert.equal(dataFile(MINUTES), null);
  assert.equal(dataFile(AREA_TABLE.replaceAll(' | ', ',')), null);

  const read = await extractBytes(Buffer.from(dump), 'txt');
  assert.equal(read.status, 'data');
  assert.equal(read.excerpts.length, 1);
  assert.equal(read.excerpts[0].kind, 'data');
  assert.equal((await extractBytes(Buffer.from(csv), 'csv')).status, 'data');
  // .md is never a data file; a minutes .txt is read as text.
  assert.equal((await extractBytes(Buffer.from(MINUTES), 'txt')).status, 'done');
  assert.equal((await extractBytes(Buffer.from(AREA_TABLE), 'csv')).status, 'done');
});

test('chunking: no half-length slices of break-less text; sentence cuts unchanged', () => {
  const dump = '0123456789'.repeat(1200); // 12,000 characters, no break at all
  const parts = chunk(dump, 'body');
  assert.equal(parts.length, 10); // was 20 (cut every 600)
  assert.ok(parts.every((p) => p.text.length === 1200));
  // Spaces in the second half are used before a hard cut.
  const spaced = Array.from({ length: 2000 }, (_, i) => `${i}`).join(' ');
  assert.ok(
    chunk(spaced, 'body')
      .slice(0, -1)
      .every((p) => p.text.length > 600 && p.text.length <= 1200),
  );
  // Sentences still end an excerpt at '. '.
  const prose = '이 문장은 시험용이다. '.repeat(150);
  const cut = chunk(prose, 'body');
  assert.ok(cut.length >= 2);
  assert.ok(cut.slice(0, -1).every((p) => p.text.endsWith('.')));
});

test('per-file excerpt cap: the rest is counted as overflow', async () => {
  const text = Array.from({ length: 300 }, (_, i) =>
    `${i}번째 문단의 결정 사항은 이것이다.`.repeat(30),
  ).join('\n\n');
  const read = await extractBytes(Buffer.from(text), 'md');
  assert.equal(read.status, 'done');
  assert.equal(read.excerpts.length, TEXT_EXCERPT_CAP);
  assert.ok(read.overflow > 0);
  assert.equal(DOCUMENT_EXCERPT_CAP, 1000);
});

test('environment, generated and left-out folders are not walked', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-collect-skip-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, '프로젝트');
  const files = {
    '회의록/회의.md': MINUTES,
    '도구/.venv/pyvenv.cfg': 'home = C:\\Python',
    '도구/.venv/Lib/site-packages/pkg/LICENSE.txt': 'MIT License',
    '도구/myenv/pyvenv.cfg': 'home = C:\\Python',
    '도구/myenv/Lib/site-packages/pkg/METADATA.txt': 'Name: pkg',
    '도구/python/python.exe': 'MZ',
    '도구/python/Lib/os.py': '#',
    '도구/python/LICENSE.txt': 'PSF',
    '도구/src/__pycache__/x.txt': 'cache',
    '도구/src/pkg-1.0.dist-info/METADATA.txt': 'Name',
    '도구/src/.pytest_cache/README.md': 'cache',
    '도구/node_modules/a/README.md': 'x',
    '도구/conda/conda-meta/history.txt': 'x',
    // A person's folder named 'venv' or 'env' without pyvenv.cfg is walked.
    'env/메모.md': '환경 영향 평가 메모',
    '참고/긴 문서.md': MINUTES,
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(project, rel, '..'), { recursive: true });
    await writeFile(join(project, rel), text);
  }
  assert.equal(skipDir('site-packages'), 'env');
  assert.equal(skipDir('foo.egg-info'), 'env');
  assert.equal(skipDir('node_modules'), 'generated');
  assert.equal(skipDir('venv'), null);
  assert.equal(isEnvironment(['Lib', 'Scripts', 'pyvenv.cfg']), true);
  assert.equal(isEnvironment(['python.exe', 'Lib']), true);
  assert.equal(isEnvironment(['Lib', 'readme.md']), false);
  const roots = rootsOf([project]);
  const walked = await listFiles(roots, () => false, [join(project, '참고')]);
  assert.deepEqual(walked.files.map((f) => f.rel).sort(), ['env/메모.md', '회의록/회의.md']);
  assert.deepEqual(walked.skipped.excluded, ['참고']);
  assert.equal(walked.skipped.env.length, 7); // .venv, myenv, python, __pycache__, dist-info, .pytest_cache, conda
  assert.deepEqual(walked.skipped.generated, ['도구/node_modules']);
});

/** A folder like the 2026-10-08 run, scaled down: dumps, a numeric CSV, a tool venv, real documents. */
async function findingsFolder(project) {
  const write = async (rel, text) => {
    await mkdir(join(project, rel, '..'), { recursive: true });
    await writeFile(join(project, rel), text);
  };
  for (let i = 0; i < 3; i++) await write(`측량/좌표 ${i + 1}.txt`, coordinates(40_000, i + 1));
  await write('구조/하중 데이터.csv', numericCsv(20_000));
  for (let i = 0; i < 40; i++)
    await write(
      `도구/.venv/Lib/site-packages/pkg${i}/LICENSE.txt`,
      'Permission is hereby granted. '.repeat(200),
    );
  await write('도구/.venv/pyvenv.cfg', 'home = C:\\Python');
  await write('회의록/261006 구조 회의록.md', MINUTES);
  await write('면적표/면적표.csv', AREA_TABLE.replaceAll(' | ', ','));
  await write('사진/현장.jpg', 'JPEG');
  await write('모델/매스.3dm', '3DM');
}

test('survey: data files, environments and media are skipped; the estimate is small', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-collect-survey-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, '2601 합성 프로젝트');
  await findingsFolder(project);
  const roots = rootsOf([project]);
  const survey = await surveyFolders(roots, () => false, []);
  assert.deepEqual(survey.read, { files: 2, byKind: { text: 2 } });
  assert.equal(survey.skipped.data, 4);
  assert.equal(survey.skipped.env, 1);
  assert.equal(survey.skipped.media, 2);
  assert.equal(survey.estimate.excerpts, 2);
  assert.equal(survey.estimate.filterCalls, 1);
  assert.deepEqual(
    survey.heavy.map((h) => h.path),
    ['면적표', '회의록'],
  );
  const left = await surveyFolders(roots, () => false, [join(project, '회의록')]);
  assert.equal(left.read.files, 1);
  assert.equal(left.skipped.excluded, 1);
});

test('a run: data files and fragments never reach the AI; reasons and counts are kept', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-collect-rules-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, 'data'),
    project = join(directory, '2601 합성 프로젝트');
  await mkdir(data, { recursive: true });
  await findingsFolder(project);
  // A document with one data paragraph among its text: that excerpt is ruled out.
  await mkdir(join(project, '보고'), { recursive: true });
  await writeFile(
    join(project, '보고', '검토 보고.md'),
    `구조 검토 결과 보는 처짐 기준을 만족한다.\n\n${coordinates(60)}\n\n지하 외벽 두께는 400mm로 한다.`,
  );
  const runner = fakeRunner();
  const collector = new KnowledgeCollector({
    dataDirectory: data,
    folders: () => [project],
    denied: () => false,
    runner,
    plan: async () => modelPlan(['claude-cli'], []),
    agenda: () => [],
    now: () => new Date(2026, 9, 8, 9, 0),
  });
  // Left-out folders are kept beside the DB and must lie inside a project folder.
  assert.deepEqual(collector.exclusions(PROJECT), []);
  assert.throws(() => collector.setExclusions(PROJECT, ['..']), { code: 'INVALID_INPUT' });
  // The project folder itself (the root here) cannot be left out; remove it from the folders instead.
  assert.throws(() => collector.setExclusions(PROJECT, ['.']), { code: 'INVALID_INPUT' });
  collector.setExclusions(PROJECT, ['면적표']);
  assert.deepEqual((await collector.survey(PROJECT)).exclude, ['면적표']);

  await collector.start(PROJECT);
  await collector.idle(PROJECT);
  const state = collector.status(PROJECT);
  assert.equal(state.state, 'done', state.error ?? '');
  assert.equal(state.survey.skipped.data, 4);
  assert.equal(state.survey.skipped.excluded, 1);
  assert.equal(state.counts.data, 4);
  assert.equal(state.counts.files, 2);
  assert.equal(state.counts.read, 2);
  const filter = runner.calls.filter((c) => c.role === 'filter');
  assert.equal(filter.length, 1);
  const sent = runner.calls.map((c) => c.prompt).join('\n');
  assert.doesNotMatch(sent, /Permission is hereby granted|x,y,z,load|1000\.000 2000\.000/);
  assert.match(sent, /처짐 기준/);
  const db = new DatabaseSync(collector.file(PROJECT), { readOnly: true });
  const reasons = db
    .prepare("select reason, count(*) as n from selection where route = 'rule' group by reason")
    .all()
    .map((r) => [r.reason, Number(r.n)]);
  assert.deepEqual(reasons, [[RULE_DATA, 1]]);
  assert.equal(db.prepare("select count(*) as n from source where status = 'data'").get().n, 4);
  db.close();
  // A second survey: nothing changed, nothing to read.
  const again = await collector.survey(PROJECT);
  assert.equal(again.read.files, 0);
  assert.equal(again.unchanged, 2);
  assert.equal(again.skipped.data, 4);
});
