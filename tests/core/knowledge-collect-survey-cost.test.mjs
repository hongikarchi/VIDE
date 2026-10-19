// The run estimate by stage (T-363, SPEC-08.9 6): the last run's measured calls per excerpt and
// seconds per call when the knowledge DB has one, first-run constants otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootsOf } from '../../src/knowledge/collect/inventory.ts';
import { openKnowledgeDb } from '../../src/knowledge/collect/schema.ts';
import {
  STAGE_DEFAULTS,
  estimateCost,
  measured,
  surveyFolders,
} from '../../src/knowledge/collect/survey.ts';

/** A knowledge DB with `runs`, each a list of [stage, ms, items, llm_calls]. */
async function dbWith(directory, runs) {
  const file = join(directory, 'knowledge.sqlite');
  const db = openKnowledgeDb(file);
  const put = db.prepare(
    "insert into run(stage, started, ms, items, llm_calls) values(?, '2026-10-16', ?, ?, ?)",
  );
  for (const run of runs) for (const row of run) put.run(...row);
  db.close();
  return file;
}

// The incremental run of round 7: 130 excerpts, 21 statements; issues 62 of its 65 calls.
const INCREMENT = [
  ['inventory', 43_000, 22_258, 0],
  ['extract', 3_000, 130, 0],
  ['dwg', 19_000, 5, 0],
  ['select', 87_000, 130, 1],
  ['statements', 50_000, 130, 1],
  ['issues', 174_000, 21, 62],
  ['proposals', 4_000, 21, 1],
];

test('no measured run: first-run constants cover every AI stage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-survey-cost-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(measured(join(directory, 'none.sqlite')).stages, undefined);
  const cost = estimateCost(6434);
  assert.equal(cost.measured, false);
  assert.deepEqual(cost.stages, {
    select: Math.ceil(6434 * STAGE_DEFAULTS.select.callsPerExcerpt),
    statements: Math.ceil(6434 * STAGE_DEFAULTS.statements.callsPerExcerpt),
    issues: Math.ceil(6434 * STAGE_DEFAULTS.issues.callsPerExcerpt),
    proposals: Math.ceil(6434 * STAGE_DEFAULTS.proposals.callsPerExcerpt),
  });
  // The first real run (6,434 excerpts): 1,728 calls in 103 minutes; within ±50%.
  assert.ok(Math.abs(cost.calls / 1728 - 1) <= 0.5, `calls ${cost.calls}`);
  assert.ok(Math.abs(cost.minutes / 103 - 1) <= 0.5, `minutes ${cost.minutes}`);
  assert.ok(cost.stages.issues > cost.stages.select, 'issues is the costly stage');
  assert.deepEqual(estimateCost(0).stages, { select: 0, statements: 0, issues: 0, proposals: 0 });
});

test('a measured run: the next estimate uses its ratios by stage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-survey-cost-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // An older full run, then the increment, then a run stopped at the filter (no later stages).
  const stopped = INCREMENT.slice(0, 4).map(([stage, ms, items]) => [stage, ms, items, 0]);
  const file = await dbWith(directory, [
    [
      ['inventory', 1, 1, 0],
      ['extract', 1, 6434, 0],
      ['select', 1, 5106, 107],
      ['statements', 1, 2603, 217],
      ['issues', 1, 3282, 1384],
    ],
    INCREMENT,
    stopped,
  ]);
  const { stages } = measured(file);
  assert.ok(stages, 'measured');
  assert.equal(stages.issues.callsPerExcerpt, 62 / 130);
  assert.equal(stages.issues.secondsPerCall, 174 / 62);
  // The same increment again (130 excerpts, 21 statements changed): about 60 issue calls.
  const cost = estimateCost(130, stages);
  assert.equal(cost.measured, true);
  assert.deepEqual(cost.stages, { select: 1, statements: 1, issues: 62, proposals: 1 });
  assert.equal(cost.calls, 65);
  assert.equal(cost.minutes, Math.ceil((87 + 50 + 174 + 4) / 60));
});

test('survey: the estimate carries the stages, measured from the project DB', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-survey-cost-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, '합성 프로젝트');
  await mkdir(join(project, '회의록'), { recursive: true });
  for (let i = 0; i < 3; i++)
    await writeFile(
      join(project, '회의록', `${i + 1}차.md`),
      `${i + 1}차 회의: 기둥 간격은 9m로 확정하고 다음 회의에서 다시 본다.`,
    );
  const roots = rootsOf([project]);
  const first = await surveyFolders(roots, () => false, []);
  assert.equal(first.estimate.excerpts, 3);
  assert.equal(first.estimate.measured, false);
  assert.equal(first.estimate.filterCalls, first.estimate.stages.select);
  assert.ok(first.estimate.stages.issues >= 1 && first.estimate.stages.statements >= 1);

  const file = await dbWith(directory, [INCREMENT]);
  const next = await surveyFolders(roots, () => false, [], file);
  assert.equal(next.estimate.measured, true);
  assert.equal(next.estimate.stages.issues, Math.ceil((3 * 62) / 130));
  assert.equal(
    next.estimate.calls,
    Object.values(next.estimate.stages).reduce((a, b) => a + b, 0),
  );
});

test('bytes per excerpt: a kind read before uses its own ratio', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-survey-cost-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'knowledge.sqlite');
  const db = openKnowledgeDb(file);
  for (let i = 0; i < 3; i++) {
    const { lastInsertRowid } = db
      .prepare("insert into source(rel_path, ext, size, kind) values(?, 'pdf', 30000, 'pdf')")
      .run(`도면/${i}.pdf`);
    for (let j = 0; j < 3; j++)
      db.prepare("insert into excerpt(source_id, text, kind) values(?, '본문', 'text')").run(
        lastInsertRowid,
      );
  }
  db.close();
  assert.deepEqual(measured(file).bytes, { pdf: 10_000 });
});
