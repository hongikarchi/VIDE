import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { Store } from '../../src/core/store.ts';
import { KnowledgeReviewStore } from '../../src/core/knowledge-review-store.ts';
import { reviewLayer } from '../../src/jigs/knowledge.ts';
import { AgentTools, conversationHandlers } from '../../src/server/agent-tools.ts';
import { buildFactsDb } from '../core/knowledge-facts.test.mjs';
import {
  factEvidenceSchema,
  factIssueSchema,
  factRulesSchema,
  factSearchSchema,
  factSummarySchema,
  recordedReviewSchema,
} from '../../src/contracts/facts.ts';

// SPEC-08 routes (/api/v1/projects/:id/facts…) and the project_* conversation tools.
test('facts routes: brief, search, fact window, people-only reviews, source rules, refs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-facts-routes-'));
  const app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  try {
    const login = await fetch(app.origin + '/api/v1/session', {
      method: 'POST',
      headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
    });
    const headers = {
      Origin: app.origin,
      'Content-Type': 'application/json',
      Cookie: login.headers.get('set-cookie').split(';')[0],
    };
    const api = async (path, method = 'GET', data) => {
      const reply = await fetch(app.origin + '/api/v1' + path, {
        method,
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return { status: reply.status, body: await reply.json() };
    };
    const project = (await api('/projects', 'POST', { name: '자료' })).body;
    const other = (await api('/projects', 'POST', { name: '다른' })).body;
    const base = `/projects/${project.id}/facts`;
    assert.deepEqual((await api(base)).body, { available: false }, 'no DB is not an error');
    // Every reply below is parsed with the app's schemas (src/contracts/facts.ts): a field the
    // engine stops sending, or sends in another shape, fails here and not only in the app.
    factSummarySchema.parse((await api(base)).body);

    await mkdir(join(directory, 'knowledge'));
    buildFactsDb(join(directory, 'knowledge', project.id + '.sqlite'));
    const brief = factSummarySchema.parse((await api(base)).body);
    assert.equal(brief.available, true);
    assert.equal(brief.counts.statements, 5);
    assert.equal(brief.reviews.confirmed, 0);

    const search = factSearchSchema.parse(
      (await api(`${base}/search?q=${encodeURIComponent('스팬은')}`)).body,
    );
    assert.deepEqual(
      search.items.map((row) => row.ref),
      ['S5', 'S2', 'S1'],
    );
    assert.equal(search.plan.words[0].via, 'fts');

    // Reviews: recorded as the person using the app; a contamination needs a reason.
    const confirmed = await api(`${base}/statements/1/review`, 'POST', { verdict: 'confirmed' });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.by, 'user');
    recordedReviewSchema.parse(confirmed.body);
    assert.equal(
      (await api(`${base}/statements/3/review`, 'POST', { verdict: 'contaminated' })).status,
      400,
    );
    assert.equal(
      (await api(`${base}/statements/99/review`, 'POST', { verdict: 'confirmed' })).status,
      404,
    );
    assert.equal(
      (
        await api(`${base}/statements/3/review`, 'POST', {
          verdict: 'contaminated',
          reason: '다른 동 자료',
        })
      ).status,
      200,
    );
    const rules = await api(`${base}/rules`, 'POST', { sourceId: 3, reason: '다른 현장' });
    factRulesSchema.parse(rules.body);
    assert.deepEqual(rules.body.rules, [
      { pattern: 'other-project/배치도 메모.txt', reason: '다른 현장' },
    ]);
    const after = (await api(`${base}/search?q=`)).body;
    assert.deepEqual(after.items.map((row) => row.id).sort(), [1, 2, 4]);
    assert.equal(after.items[0].id, 1, 'confirmed first');
    assert.equal(after.excluded, 2);
    const hidden = factSearchSchema.parse((await api(`${base}/search?q=&status=excluded`)).body);
    assert.deepEqual(hidden.items.map((row) => row.state).sort(), [
      'contaminated',
      'excluded-source',
    ]);

    const window = factEvidenceSchema.parse((await api(`${base}/statements/5`)).body);
    assert.equal(window.state, 'excluded-source');
    assert.equal(window.reason, '다른 현장');
    assert.match(window.text, /다른 현장/);
    const issue = factIssueSchema.parse((await api(`${base}/issues/1`)).body);
    assert.equal(factSummarySchema.parse((await api(base)).body).reviews.rules, 1);
    assert.deepEqual(
      issue.statements.map((row) => row.id),
      [1, 2],
    );
    assert.equal(issue.excluded, 1);

    const refs = (await api(`${base}/refs`, 'POST', { factRefs: ['S1', 'S4', 'S3'] })).body;
    assert.deepEqual(
      refs.refs.map((row) => row.validity),
      ['ok', 'warn', 'block'],
    );

    // Removing a verdict or a rule brings the statement back.
    const removed = await api(`${base}/statements/3/review`, 'POST', { verdict: null });
    assert.equal(removed.body.state, 'unconfirmed', JSON.stringify(removed));
    factEvidenceSchema.parse(removed.body);
    await api(`${base}/rules`, 'POST', { pattern: 'other-project/배치도 메모.txt', remove: true });
    assert.equal((await api(`${base}/search?q=`)).body.excluded, 0);

    // Another project has no DB and no reviews; unknown projects are 404.
    assert.deepEqual((await api(`/projects/${other.id}/facts`)).body, { available: false });
    assert.equal((await api('/projects/00000000-0000-4000-8000-000000000000/facts')).status, 404);
    // The original is not on this PC in the test: reported, never created.
    assert.equal((await api(`${base}/sources/1/open`, 'POST', {})).body.code, 'SOURCE_UNAVAILABLE');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('project_* tools: read-only, excluded statements refused, numbers compared by code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-facts-tools-'));
  const store = new Store(':memory:');
  try {
    const file = join(directory, 'kdb.sqlite');
    buildFactsDb(file);
    const project = store.createProject('자료');
    const reviews = new KnowledgeReviewStore(store.db);
    reviews.setReview(project.id, 1, { verdict: 'confirmed', by: 'user' });
    reviews.setReview(project.id, 3, { verdict: 'rejected', reason: '오독', by: 'user' });
    const returned = new Map();
    const params = [
      {
        key: 'span',
        title: '경간',
        displayValue: 12,
        displayUnit: 'm',
        basis: { status: 'confirmed', factRefs: ['S1'] },
      },
      {
        key: 'wall',
        title: '벽 두께',
        displayValue: 300,
        displayUnit: 'mm',
        basis: { statementId: 3 },
      },
    ];
    const handlers = conversationHandlers({
      projectId: project.id,
      conversationId: 'c1',
      openInstanceId: 'i1',
      workspace: { list: () => [], get: () => assert.fail() },
      jigs: {
        view: async (projectId, instanceId) => {
          assert.equal(projectId, project.id);
          return { id: instanceId, params, steps: [] };
        },
      },
      facts: { file, layer: () => reviewLayer(reviews, project.id), returned },
    });
    assert.ok(handlers.project_search && handlers.project_checks);
    for (const name of Object.keys(handlers))
      assert.ok(!/review|rule|open/.test(name), 'no write or open tool');

    const found = await handlers.project_search({ targetRef: 'conversation:c1', query: '' }, {});
    assert.equal(found.items[0].ref, 'S1');
    assert.equal(found.items[0].state, 'confirmed');
    assert.ok(!found.items.some((row) => row.ref === 'S3'));
    assert.equal(found.excluded, 1);
    assert.equal(returned.get(1), 'confirmed');
    await assert.rejects(
      async () => handlers.project_statement({ targetRef: 'x', statementId: 3 }, {}),
      { code: 'FACT_EXCLUDED' },
    );
    const one = await handlers.project_statement({ targetRef: 'x', statementId: 4 }, {});
    assert.equal(one.ref, 'S4');
    assert.match(one.excerpt, /층고/);
    const checks = await handlers.project_checks({ targetRef: 'x' }, {});
    assert.deepEqual(
      checks.checks.map((row) => [row.key, row.verdict]),
      [
        ['span', 'match'],
        ['wall', 'invalid-basis'],
      ],
    );
    const brief = await handlers.project_brief({ targetRef: 'x', discipline: 'structure' }, {});
    assert.equal(brief.reviews.rejected, 1);
    assert.deepEqual(
      brief.disciplines.map((d) => d.key),
      ['structure'],
    );

    // Without a DB the tools are not offered at all.
    const none = conversationHandlers({
      projectId: project.id,
      conversationId: 'c1',
      openInstanceId: null,
      workspace: { list: () => [], get: () => assert.fail() },
      facts: { file: join(directory, 'missing.sqlite'), layer: () => assert.fail() },
    });
    assert.equal(none.project_search, undefined);

    // Through the scoped dispatcher: FACT_EXCLUDED is reported by code.
    const tools = new AgentTools();
    const scope = tools.issue({ targetRef: 'conversation:c1', handlers, isCurrent: () => true });
    const refused = await tools.call(scope.token, 'project_statement', {
      targetRef: 'conversation:c1',
      statementId: 3,
    });
    assert.equal(refused.isError, true);
    assert.equal(JSON.parse(refused.content[0].text).code, 'FACT_EXCLUDED');
    tools.close();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
