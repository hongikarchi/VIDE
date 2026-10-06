import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { realpathSync, symlinkSync } from 'node:fs';
import { Writable } from 'node:stream';
import { startServer } from '../../src/server/server.ts';
import { factRoutes } from '../../src/server/facts-routes.ts';
import { Store } from '../../src/core/store.ts';
import { openKnowledgeSource, SOURCE_FILE_MAX_BYTES } from '../../src/jigs/knowledge.ts';

// Project knowledge (PLAN-08 K0, SPEC-08): the facts routes read <data>/knowledge/<project>.sqlite
// only; the old trial routes (/jigs/knowledge…) are gone, the app reads /facts.
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
    assert.deepEqual((await api(`/projects/${project.id}/facts`)).body, {
      available: false,
    });
    const jigs = (await api('/jigs')).body;
    assert.equal(jigs.find((jig) => jig.id === 'knowledge').status, 'available');

    const root = join(directory, 'server');
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(directory, 'knowledge'));
    buildDb(join(directory, 'projects', project.id, 'knowledge.sqlite'), root);

    const summary = (await api(`/projects/${project.id}/facts`)).body;
    assert.equal(summary.available, true);
    assert.equal(summary.counts.statements, 2, 'unsupported statements are not counted');
    assert.equal(summary.disciplines[0].label, '구조');
    assert.equal(summary.disciplines[0].issues[0].open, 1);
    assert.equal(summary.brief, null, 'a DB without the status brief shows the issue list only');
    assert.equal(summary.disciplines[0].brief, null);
    const writable = new DatabaseSync(join(directory, 'projects', project.id, 'knowledge.sqlite'));
    writable.exec('create table brief(scope text primary key, body text, built_at text)');
    const decided = { text: '스팬 13m 이하', issue: 1, cite: [1], discipline: 'structure' };
    writable.prepare('insert into brief values(?, ?, ?), (?, ?, ?)').run(
      'project',
      JSON.stringify({ overview: '개요', decided: [decided], blocked: [], changed: [] }),
      'now',
      'structure',
      JSON.stringify({
        label: '구조',
        state: '정리 중',
        decided: [decided],
        blocked: [],
        changed: [],
      }),
      'now',
    );
    writable.close();
    const briefed = (await api(`/projects/${project.id}/facts`)).body;
    assert.equal(briefed.brief.overview, '개요');
    assert.equal(briefed.brief.decided[0].issue, 1);
    assert.equal(briefed.disciplines[0].brief.state, '정리 중');

    const issue = (await api(`/projects/${project.id}/facts/issues/1`)).body;
    assert.equal(issue.note.conclusions[0].cite[0], 1);
    assert.deepEqual(
      issue.statements.map((s) => s.id),
      [1, 2],
    );
    assert.equal(issue.statements[1].party, '구조사', 'aliases resolve to the merged party');

    const found = (
      await api(`/projects/${project.id}/facts/search?q=${encodeURIComponent('보 춤')}`)
    ).body;
    assert.deepEqual(
      found.items.map((s) => s.id),
      [2, 1],
      'both words must match; newest first',
    );
    const byKind = (
      await api(
        `/projects/${project.id}/facts/search?q=${encodeURIComponent('스팬')}&kind=decision`,
      )
    ).body;
    assert.deepEqual(
      byKind.items.map((s) => s.id),
      [2],
    );

    const evidence = (await api(`/projects/${project.id}/facts/statements/1`)).body;
    assert.match(evidence.text, /13m 이하/);
    assert.equal(evidence.path, 'docs/회의록.docx');
    assert.equal((await api(`/projects/${project.id}/facts/issues/99`)).status, 404);
    // The original is on the company server; a missing file is reported, never created.
    assert.equal(
      (await api(`/projects/${project.id}/facts/sources/1/open`, 'POST')).body.code,
      'SOURCE_UNAVAILABLE',
    );
    assert.equal((await api('/projects/00000000-0000-4000-8000-000000000000/facts')).status, 404);

    // Opening only follows paths recorded under the root.
    const file = join(directory, 'projects', project.id, 'knowledge.sqlite');
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

// SPEC-08.4 (2026-10-01): [원본 열기] opens the file with this PC's program at the PC; a remote
// screen (iPad) gets the bytes in a new tab instead, and nothing runs on the PC. Both follow the
// same root checks: `..` and links that leave the root are refused.
test('originals: local opens on the PC, a remote screen gets the bytes, escapes are refused', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-knowledge-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'server');
  const outside = join(directory, 'outside');
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, 'docs', '회의록.docx'), 'docx-bytes');
  await writeFile(join(root, 'docs', '도면 설명.pdf'), '%PDF-1.4 test');
  await writeFile(join(root, 'docs', 'note.txt'), '스팬 13m');
  await writeFile(join(root, 'docs', 'page.html'), '<script>alert(1)</script>');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  // A junction inside the root that points outside it (no admin rights needed on Windows).
  symlinkSync(outside, join(root, 'docs', 'link'), 'junction');
  await mkdir(join(directory, 'knowledge'));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const project = store.createProject('원본');
  const file = join(directory, 'knowledge', project.id + '.sqlite');
  buildDb(file, root);
  const db = new DatabaseSync(file);
  db.prepare(
    `insert into source values(3, 'docs/도면 설명.pdf', null), (4, 'docs/note.txt', null),
      (5, 'docs/link/secret.txt', null), (6, 'docs/page.html', null), (7, 'docs/없음.pdf', null)`,
  ).run();
  db.close();
  const call = async (method, path, remote) => {
    const chunks = [];
    const response = Object.assign(
      new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
      }),
      {
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
      },
    );
    const finished = new Promise((resolve) => response.on('finish', resolve));
    let sent;
    await factRoutes(
      new URL(`http://127.0.0.1/api/v1/projects/${project.id}/facts/sources/${path}`),
      { method },
      {
        workspace: { store },
        dataDirectory: directory,
        body: async () => ({}),
        send: (status, data) => (sent = { status, data }),
        remote,
        response,
      },
    );
    if (sent) return sent;
    await finished;
    return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) };
  };
  // At the PC: the default program opens it; a remote screen may not run anything here.
  await assert.rejects(call('POST', '1/open', true), { code: 'FORBIDDEN' });
  const opened = [];
  assert.deepEqual(
    openKnowledgeSource(file, 1, (path) => opened.push(path)),
    { opened: true },
  );
  assert.equal(opened[0], realpathSync(join(root, 'docs', '회의록.docx')));
  // A remote screen gets the file: PDF and text shown, others downloaded.
  const pdf = await call('GET', '3/file', true);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['Content-Type'], 'application/pdf');
  assert.match(pdf.headers['Content-Disposition'], /^inline; /);
  assert.ok(
    pdf.headers['Content-Disposition'].endsWith(
      `filename*=UTF-8''${encodeURIComponent('도면 설명.pdf')}`,
    ),
  );
  assert.equal(pdf.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(pdf.body.toString(), '%PDF-1.4 test');
  assert.equal(pdf.headers['Content-Length'], String(pdf.body.length));
  const text = await call('GET', '4/file', true);
  assert.equal(text.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(text.body.toString(), '스팬 13m');
  const docx = await call('GET', '1/file', true);
  assert.equal(docx.headers['Content-Type'], 'application/octet-stream');
  assert.match(docx.headers['Content-Disposition'], /^attachment; /);
  const html = await call('GET', '6/file', true);
  assert.equal(html.headers['Content-Type'], 'application/octet-stream', 'never rendered here');
  assert.match(html.headers['Content-Disposition'], /^attachment; /);
  // The same file at the PC, too.
  assert.equal((await call('GET', '4/file', false)).body.toString(), '스팬 13m');
  // `..` and a junction out of the root are refused; a missing original is a sentence.
  await assert.rejects(call('GET', '2/file', true), { code: 'INVALID_INPUT' });
  await assert.rejects(call('GET', '5/file', true), { code: 'INVALID_INPUT' });
  assert.throws(() => openKnowledgeSource(file, 5, () => assert.fail('must not open')), {
    code: 'INVALID_INPUT',
  });
  const missing = await call('GET', '7/file', true);
  assert.equal(missing.status, 404);
  assert.match(missing.body.toString(), /원본 파일을 찾을 수 없습니다/);
  await assert.rejects(call('GET', '99/file', true), { code: 'NOT_FOUND' });
  assert.equal(SOURCE_FILE_MAX_BYTES, 200 * 1024 * 1024);
});
