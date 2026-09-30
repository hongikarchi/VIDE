import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/core/store.ts';
import { KnowledgeReviewStore } from '../../src/core/knowledge-review-store.ts';
import {
  citationGate,
  excludeFactSource,
  factBrief,
  factChecks,
  factIssue,
  factNumbers,
  factRefIds,
  factSearch,
  factStatement,
  factValidity,
  knowledgeSearch,
  recordFactReview,
  reviewLayer,
  sourceRuleTest,
} from '../../src/jigs/knowledge.ts';

// SPEC-08 over a small synthetic crawler DB (same tables as the K0 crawler, trigram excerpt index).
export function buildFactsDb(file, { fts = true } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    create table meta(key text primary key, value text);
    create table run(id integer primary key, stage text, started text);
    create table source(id integer primary key, rel_path text, skip text);
    create table excerpt(id integer primary key, source_id integer, locator text, text text);
    create table mail(source_id integer primary key);
    create table statement(id integer primary key, excerpt_id integer, kind text, party text, subject text,
      content text, quote text, said_on text, quote_ok integer, support_prob real);
    create table party_alias(alias text primary key, party text);
    create table issue(id integer primary key, discipline text, title text, status text, summary text, note text, statements integer);
    create table statement_issue(statement_id integer primary key, issue_id integer, discipline text);`);
  if (fts)
    db.exec(
      "create virtual table excerpt_fts using fts5(text, content='excerpt', content_rowid='id', tokenize='trigram')",
    );
  db.prepare('insert into meta values(?, ?)').run('root', 'X:/합성/루트');
  db.prepare("insert into run(stage, started) values('issues', '2026-09-29T03:00:00Z')").run();
  db.exec(`insert into source values
    (1, 'mail/2026-09-04 회의록.docx', null),
    (2, 'mail/2026-09-10 구조 검토.pdf', null),
    (3, 'other-project/배치도 메모.txt', null)`);
  db.exec(`insert into excerpt values
    (1, 1, 'p1', '기둥 스팬은 13m 이하로 한다. 보 춤은 900으로 한다.'),
    (2, 2, 'p2', '코어 벽체 두께는 300mm로 검토한다. 층고는 4,500mm이다.'),
    (3, 3, 'p1', '다른 현장의 기둥 스팬은 9m로 정했다.')`);
  if (fts) db.exec("insert into excerpt_fts(excerpt_fts) values('rebuild')");
  db.exec(`insert into statement values
    (1, 1, 'condition', '구조사', '스팬', '기둥 스팬 13m 이하', '기둥 스팬은 13m 이하', '2026-09-04', 1, 0.9),
    (2, 1, 'decision', '구조사 김', '보 춤', '보 춤 900', '보 춤은 900', '2026-09-05', 1, 0.8),
    (3, 2, 'opinion', '설계사', '벽체', '코어 벽체 두께 300mm 검토', '벽체 두께는 300mm', '2026-09-10', 1, 0.9),
    (4, 2, 'decision', '설계사', '층고', '층고 4,500mm', '층고는 4,500mm', '2026-09-10', 1, 0.9),
    (5, 3, 'decision', '다른 현장', '스팬', '기둥 스팬 9m', '기둥 스팬은 9m', '2026-09-12', 1, 0.9),
    (6, 1, 'opinion', '구조사', '기타', '검증 안 된 문장', '없는 인용', null, 0, 0.1)`);
  db.prepare("insert into party_alias values('구조사 김', '구조사')").run();
  const note = { conclusions: [{ text: '스팬 13m 이하', cite: [1] }], open: [], conditions: [] };
  db.prepare(
    "insert into issue values(1, 'structure', '기둥 배치', 'open', '스팬 기준 정리 중', ?, 3)",
  ).run(JSON.stringify(note));
  db.exec(
    "insert into statement_issue values(1, 1, 'structure'), (2, 1, 'structure'), (5, 1, 'structure')",
  );
  db.close();
}

async function setup(options) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-facts-'));
  const file = join(directory, 'kdb.sqlite');
  buildFactsDb(file, options);
  const store = new Store(':memory:');
  const project = store.createProject('자료');
  const other = store.createProject('다른');
  const reviews = new KnowledgeReviewStore(store.db);
  return {
    file,
    reviews,
    projectId: project.id,
    otherId: other.id,
    layer: (id = project.id) => reviewLayer(reviews, id),
    done: async () => {
      store.close?.();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const ids = (rows) => rows.map((row) => row.id);

test('search: 3+ character words use the trigram index, 2-character words LIKE, all words must match', async () => {
  const t = await setup();
  try {
    const three = factSearch(t.file, t.layer(), '스팬은');
    assert.equal(three.plan.fts, true);
    assert.deepEqual(three.plan.words, [{ word: '스팬은', via: 'fts' }]);
    // Found only through the excerpt text (the statements say '스팬'); newest first.
    assert.deepEqual(ids(three.items), [5, 2, 1]);
    const two = factSearch(t.file, t.layer(), '층고');
    assert.deepEqual(two.plan.words, [{ word: '층고', via: 'like' }]);
    assert.deepEqual(ids(two.items), [4, 3]);
    assert.deepEqual(ids(factSearch(t.file, t.layer(), '벽체 두께는').items), [3, 4]);
    assert.deepEqual(ids(factSearch(t.file, t.layer(), '스팬 없는낱말').items), []);
    // Statements that fail the quote check never come back.
    assert.ok(!ids(factSearch(t.file, t.layer(), '').items).includes(6));
    // Without the index the same words give the same statements (LIKE only).
    const plain = await setup({ fts: false });
    try {
      const found = factSearch(plain.file, plain.layer(), '스팬은');
      assert.equal(found.plan.fts, false);
      assert.deepEqual(found.plan.words, [{ word: '스팬은', via: 'like' }]);
      assert.deepEqual(ids(found.items).sort(), [1, 2, 5]);
    } finally {
      await plain.done();
    }
    // The legacy jig search keeps returning an array.
    assert.deepEqual(ids(knowledgeSearch(t.file, '보 춤')), [2, 1]);
  } finally {
    await t.done();
  }
});

test('reviews: people confirm, reject, contaminate; excluded statements leave search and are counted', async () => {
  const t = await setup();
  try {
    const by = 'user';
    recordFactReview(t.reviews, t.file, t.projectId, 1, { verdict: 'confirmed' }, by);
    recordFactReview(
      t.reviews,
      t.file,
      t.projectId,
      3,
      { verdict: 'rejected', reason: '오독' },
      by,
    );
    assert.throws(
      () => recordFactReview(t.reviews, t.file, t.projectId, 2, { verdict: 'contaminated' }, by),
      { code: 'INVALID_INPUT' },
      'contamination needs a reason',
    );
    assert.throws(
      () => recordFactReview(t.reviews, t.file, t.projectId, 99, { verdict: 'confirmed' }, by),
      { code: 'NOT_FOUND' },
    );
    for (const agent of ['ai', 'agent:claude', 'codex'])
      assert.throws(
        () => recordFactReview(t.reviews, t.file, t.projectId, 2, { verdict: 'confirmed' }, agent),
        { code: 'FORBIDDEN' },
        'only people confirm',
      );
    recordFactReview(
      t.reviews,
      t.file,
      t.projectId,
      2,
      { verdict: 'corrected', correction: '구조 자문' },
      by,
    );

    const found = factSearch(t.file, t.layer(), '');
    assert.deepEqual(ids(found.items).slice(0, 2).sort(), [1, 2], 'confirmed first');
    assert.equal(found.items.find((row) => row.id === 2).party, '구조 자문');
    assert.equal(found.items.find((row) => row.id === 2).originalParty, '구조사');
    assert.ok(!ids(found.items).includes(3));
    assert.equal(found.excluded, 1);
    const shown = factSearch(t.file, t.layer(), '', { status: 'excluded' });
    assert.deepEqual(ids(shown.items), [3]);
    assert.equal(shown.items[0].reason, '오독');
    assert.deepEqual(
      ids(factSearch(t.file, t.layer(), '', { status: 'confirmed' }).items).sort(),
      [1, 2],
    );

    // A contaminated source: every statement from it leaves, unless a person confirmed that one.
    assert.deepEqual(
      excludeFactSource(t.reviews, t.file, t.projectId, { sourceId: 3 }, '다른 현장 자료', by),
      [{ pattern: 'other-project/배치도 메모.txt', reason: '다른 현장 자료' }],
    );
    const afterRule = factSearch(t.file, t.layer(), '스팬');
    assert.ok(!ids(afterRule.items).includes(5));
    assert.equal(afterRule.excluded, 1);
    const issue = factIssue(t.file, t.layer(), 1);
    assert.deepEqual(ids(issue.statements), [1, 2]);
    assert.equal(issue.excluded, 1);

    // Reviews belong to one project: another project sees none of them.
    assert.equal(factSearch(t.file, t.layer(t.otherId), '').excluded, 0);

    const brief = factBrief(t.file, t.layer());
    assert.equal(brief.available, true);
    assert.deepEqual(
      { ...brief.reviews },
      { confirmed: 1, rejected: 1, contaminated: 0, superseded: 0, corrected: 1, rules: 1 },
    );

    // The fact window: people see excluded statements with their reason; tools are refused.
    const window = factStatement(t.file, t.layer(), 5);
    assert.equal(window.state, 'excluded-source');
    assert.match(window.text, /다른 현장/);
    assert.throws(() => factStatement(t.file, t.layer(), 5, { people: false }), {
      code: 'FACT_EXCLUDED',
    });
  } finally {
    await t.done();
  }
});

test('basis: refs, validity and number checks of settings against their statements', async () => {
  const t = await setup();
  try {
    assert.deepEqual(factRefIds({ statementId: 4, factRefs: ['S1', '2', 'x', 'S1'] }), [4, 1, 2]);
    assert.deepEqual(factRefIds(undefined), []);
    recordFactReview(t.reviews, t.file, t.projectId, 1, { verdict: 'confirmed' }, 'user');
    recordFactReview(
      t.reviews,
      t.file,
      t.projectId,
      3,
      { verdict: 'contaminated', reason: '다른 동' },
      'user',
    );
    assert.deepEqual(
      factValidity(t.file, t.layer(), [1, 4, 3, 404]).map((row) => [
        row.ref,
        row.state,
        row.validity,
      ]),
      [
        ['S1', 'confirmed', 'ok'],
        ['S4', 'unconfirmed', 'warn'],
        ['S3', 'contaminated', 'block'],
        ['S404', 'missing', 'block'],
      ],
    );
    assert.deepEqual(
      factNumbers('기둥 스팬은 13m 이하, 층고 4,500mm').map((n) => [n.value, n.unit, n.bound]),
      [
        [13, 'm', 'max'],
        [4500, 'mm', null],
      ],
    );
    const checks = factChecks(t.file, t.layer(), [
      { key: 'span', value: 12, unit: 'm', basis: { statementId: 1 } },
      { key: 'spanTooLong', value: 14, unit: 'm', basis: { factRefs: ['S1'] } },
      { key: 'storey', value: 4.5, unit: 'm', basis: { statementId: 4 } },
      { key: 'depth', value: 900, unit: 'mm', basis: { statementId: 2 } },
      { key: 'wall', value: 300, unit: 'mm', basis: { statementId: 3 } },
      { key: 'load', value: 5, unit: 'kN/㎡' },
      { key: 'layer', value: 'S-06', basis: { statementId: 1 } },
    ]);
    assert.deepEqual(
      checks.map((row) => [row.key, row.verdict]),
      [
        ['span', 'match'],
        ['spanTooLong', 'conflict'],
        ['storey', 'match'],
        ['depth', 'match'],
        ['wall', 'invalid-basis'],
        ['load', 'no-basis'],
        ['layer', 'no-number'],
      ],
    );
  } finally {
    await t.done();
  }
});

test('source rules and the citation gate', () => {
  const exact = sourceRuleTest('Other-Project\\메모.txt');
  assert.equal(exact('other-project/메모.txt'), true);
  assert.equal(exact('other-project/메모.txt.bak'), false);
  const folder = sourceRuleTest('other-project/*');
  assert.equal(folder('other-project/a/b.pdf'), true);
  assert.equal(folder('mail/other-project/b.pdf'), false);
  assert.equal(sourceRuleTest('a.b(1)*')('a.b(1) 사본'), true);

  const returned = new Map([
    [1, 'confirmed'],
    [4, 'unconfirmed'],
    [5, 'excluded-source'],
  ]);
  assert.deepEqual(citationGate('스팬은 13m 이하 [S1], 층고 [S4].', returned), {
    ok: true,
    cited: [1, 4],
    unknown: [],
    excluded: [],
    unconfirmed: [4],
  });
  const bad = citationGate('[S1] [S7] [S5]', returned);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknown, [7]);
  assert.deepEqual(bad.excluded, [5]);
});
