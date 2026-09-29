import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../../src/server/server.ts';
import { openKnowledgeSource } from '../../src/jigs/knowledge.ts';

// Project knowledge jig (trial, PLAN-08 K0): read-only views over <data>/knowledge/<project>.sqlite.
function buildDb(file, root) {
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
  db.prepare('insert into meta values(?, ?)').run('root', root);
  db.prepare("insert into run(stage, started) values('issues', '2026-09-29T03:00:00Z')").run();
  db.prepare(
    "insert into source values(1, 'docs/회의록.docx', null), (2, '../outside.txt', null)",
  ).run();
  db.prepare(
    "insert into excerpt values(1, 1, 'body', '기둥 스팬은 13m 이하로 한다. 보 춤은 900으로 한다.')",
  ).run();
  db.prepare(
    `insert into statement values
    (1, 1, 'condition', '구조사', '스팬', '기둥 스팬은 13m 이하', '스팬은 13m 이하', '2026-09-04', 1, 0.9),
    (2, 1, 'decision', '구조사 김', '보 춤', '보 춤 900', '보 춤은 900', '2026-09-05', 1, 0.8),
    (3, 1, 'opinion', '구조사', '기타', '근거 약함', '없는 인용', null, 1, 0.1)`,
  ).run();
  db.prepare("insert into party_alias values('구조사 김', '구조사')").run();
  const note = {
    conclusions: [{ text: '스팬 13m 이하', cite: [1] }],
    conditions: [],
    open: [{ text: '보 춤 확인', cite: [2] }],
    history: [],
  };
  db.prepare(
    "insert into issue values(1, 'structure', '기둥 배치', 'open', '스팬 기준 정리 중', ?, 2)",
  ).run(JSON.stringify(note));
  db.prepare(
    "insert into statement_issue values(1, 1, 'structure'), (2, 1, 'structure'), (3, 1, 'structure')",
  ).run();
  db.close();
}

test('knowledge jig reads one project DB: summary, issue note, search, evidence; no DB is not an error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-knowledge-'));
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
        body: method === 'POST' ? JSON.stringify(data ?? {}) : undefined,
      });
      return { status: reply.status, body: await reply.json() };
    };
    const project = (await api('/projects', 'POST', { name: '지식' })).body;
    assert.deepEqual((await api(`/projects/${project.id}/jigs/knowledge`)).body, {
      available: false,
    });
    const jigs = (await api('/jigs')).body;
    assert.equal(jigs.find((jig) => jig.id === 'knowledge').status, 'available');

    const root = join(directory, 'server');
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(directory, 'knowledge'));
    buildDb(join(directory, 'knowledge', project.id + '.sqlite'), root);

    const summary = (await api(`/projects/${project.id}/jigs/knowledge`)).body;
    assert.equal(summary.available, true);
    assert.equal(summary.counts.statements, 2, 'unsupported statements are not counted');
    assert.equal(summary.disciplines[0].label, '구조');
    assert.equal(summary.disciplines[0].issues[0].open, 1);

    const issue = (await api(`/projects/${project.id}/jigs/knowledge/issues/1`)).body;
    assert.equal(issue.note.conclusions[0].cite[0], 1);
    assert.deepEqual(
      issue.statements.map((s) => s.id),
      [1, 2],
    );
    assert.equal(issue.statements[1].party, '구조사', 'aliases resolve to the merged party');

    const found = (
      await api(`/projects/${project.id}/jigs/knowledge/search?q=${encodeURIComponent('보 춤')}`)
    ).body;
    assert.deepEqual(
      found.map((s) => s.id),
      [2, 1],
      'both words must match; newest first',
    );
    const byKind = (
      await api(
        `/projects/${project.id}/jigs/knowledge/search?q=${encodeURIComponent('스팬')}&kind=decision`,
      )
    ).body;
    assert.deepEqual(
      byKind.map((s) => s.id),
      [2],
    );

    const evidence = (await api(`/projects/${project.id}/jigs/knowledge/statements/1`)).body;
    assert.match(evidence.text, /13m 이하/);
    assert.equal(evidence.path, 'docs/회의록.docx');
    assert.equal((await api(`/projects/${project.id}/jigs/knowledge/issues/99`)).status, 404);
    // The original is on the company server; a missing file is reported, never created.
    assert.equal(
      (await api(`/projects/${project.id}/jigs/knowledge/sources/1/open`, 'POST')).body.code,
      'SOURCE_UNAVAILABLE',
    );
    assert.equal(
      (await api('/projects/00000000-0000-4000-8000-000000000000/jigs/knowledge')).status,
      404,
    );

    // Opening only follows paths recorded under the root.
    const file = join(directory, 'knowledge', project.id + '.sqlite');
    await writeFile(join(root, 'docs', '회의록.docx'), 'x');
    const opened = [];
    assert.deepEqual(
      openKnowledgeSource(file, 1, (path) => opened.push(path)),
      { opened: true },
    );
    assert.equal(opened[0], join(root, 'docs', '회의록.docx'));
    assert.throws(() => openKnowledgeSource(file, 2, () => assert.fail('must not open')), {
      code: 'INVALID_INPUT',
    });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
