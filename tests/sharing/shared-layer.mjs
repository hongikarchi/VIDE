// PLAN-35 (ADR-037 1-3, SPEC-04.11): the team's shared project layer on the account site and two
// work PCs. Members only (any role writes, another account 404), the AI instructions' revisions
// with the later edit winning and the overwritten text returned, the knowledge set uploaded by a
// PC (visible only once committed, only known tables, PCs only) and rebuilt on another PC, people's
// reviews and source rules both ways, and the member project list with the PC-off view.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../../src/sharing/', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { Miniflare, Log, LogLevel } = require('miniflare'),
  { build } = require('esbuild');
const directory = resolve(root, '../../.vide/sharing-shared-layer', randomUUID());
await mkdir(directory, { recursive: true });
const bundled = await build({
  entryPoints: [join(root, 'worker.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['node:*', 'cloudflare:*'],
  conditions: ['workerd', 'worker', 'browser'],
});
const origin = 'http://127.0.0.1:8799';
const mf = new Miniflare({
  resourcePersistencePath: join(directory, 'state'),
  telemetry: { enabled: false },
  log: new Log(LogLevel.NONE),
  workers: [
    {
      config: {
        name: 'vide-sharing-shared-layer-test',
        compatibilityDate: '2026-09-22',
        compatibilityFlags: ['nodejs_compat'],
        manifest: {
          mainModule: 'worker.js',
          modules: { 'worker.js': { type: 'esm', contents: bundled.outputFiles[0].text } },
        },
        env: {
          DB: { type: 'd1', id: 'test-db', dev: { remote: false } },
          ASSETS: { type: 'r2', name: 'test-assets', dev: { remote: false } },
          ...Object.fromEntries(
            Object.entries({
              AUTH_MODE: 'manual-approval',
              AUTH_ORIGIN: origin,
              AUTH_SECRET: randomBytes(32).toString('hex'),
              SIGNUP_CODE: 'test-code',
              EMAIL_FROM: '',
            }).map(([key, value]) => [key, { type: 'text', value }]),
          ),
        },
      },
    },
  ],
});
const call = async (path, { method = 'GET', data, cookie, ip, headers = {} } = {}) => {
  const response = await mf.dispatchFetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(ip ? { 'cf-connecting-ip': ip } : {}),
      ...headers,
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return {
    status: response.status,
    value,
    cookie: response.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; '),
  };
};

// A small crawler DB (the tables the 자료 workspace reads, with a trigram excerpt index).
function crawl(file, extra = '') {
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
    create table statement_issue(statement_id integer primary key, issue_id integer, discipline text);
    create virtual table excerpt_fts using fts5(text, content='excerpt', content_rowid='id', tokenize='trigram');
    insert into meta values('root', 'X:/합성/루트');
    insert into run(stage, started) values('issues', '2026-10-05T03:00:00Z');
    insert into source values(1, 'mail/회의록.docx', null), (2, 'mail/구조.pdf', null), (3, 'big/안쓰는 파일.pdf', null);
    insert into excerpt values(1, 1, 'p1', '기둥 스팬은 13m 이하로 한다.'), (2, 2, 'p2', '보 춤은 900으로 한다.'), (3, 3, 'p9', '원본 전문 ${extra}');
    insert into mail values(1), (2);
    insert into statement values
      (1, 1, 'requirement', '건축주', '스팬', '기둥 스팬은 13m 이하', '기둥 스팬은 13m 이하로 한다', '2026-09-04', 1, 0.9),
      (2, 2, 'decision', '구조', '보 춤', '보 춤 900', '보 춤은 900으로 한다', '2026-09-10', 1, 0.8);
    insert into party_alias values('구조사무소', '구조');
    insert into issue values(1, 'structure', '스팬', 'open', '스팬 결정', '{"open":[]}', 2);
    insert into statement_issue values(1, 1, 'structure'), (2, 1, 'structure');`);
  db.exec("insert into excerpt_fts(excerpt_fts) values('rebuild')");
  db.close();
}

try {
  const d1 = await mf.getD1Database('DB');
  for (const name of (await readdir(join(root, 'migrations'))).sort()) {
    const sql = (await readFile(join(root, 'migrations', name), 'utf8')).replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').filter((v) => v.trim()))
      await d1.prepare(statement).run();
  }
  const account = async (username, ip) => {
    const password = randomBytes(20).toString('hex');
    assert.equal(
      (
        await call('/api/account/sign-up', {
          method: 'POST',
          data: { username, password, code: 'test-code' },
          ip,
        })
      ).status,
      201,
    );
    const response = await call('/api/account/sign-in', {
      method: 'POST',
      data: { username, password },
      ip,
    });
    return { cookie: response.cookie, password };
  };
  const alice = await account('alice', '192.0.2.10'),
    bob = await account('bob', '192.0.2.11'),
    eve = await account('eve', '192.0.2.12');
  const userId = async (name) =>
    (
      await d1
        .prepare('SELECT id FROM user WHERE email=?')
        .bind(`${name}@users.vide.invalid`)
        .first()
    ).id;

  const { RemoteAccess } = await import('../../src/server/remote-access.ts');
  const { SharedProjects } = await import('../../src/server/shared-project.ts');
  const { ProjectInstructionStore } = await import('../../src/ai/instructions/project-store.ts');
  const { KnowledgeReviewStore } = await import('../../src/core/knowledge-review-store.ts');
  const { Store } = await import('../../src/core/store.ts');
  const { knowledgeSummary, factSearch, reviewLayer } = await import('../../src/jigs/knowledge.ts');

  // Two PCs: Alice's runs the project (and crawled); Bob's is a member's.
  const project = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Tower' };
  const pcOf = async (name, user, localProjects) => {
    const folder = join(directory, name);
    await mkdir(folder, { recursive: true });
    const store = new Store({ directory: folder });
    for (const p of localProjects) store.ensureProject(p.id, p.name);
    const remote = new RemoteAccess({
      directory: folder,
      port: () => 1234,
      status: async () => ({ version: '0.10.1' }),
      projects: () => store.listProjects(),
      fetcher: (url, init) => mf.dispatchFetch(String(url), init),
      spawnProcess: () => {
        throw new Error('no tunnel in this test');
      },
      heartbeatMs: 600_000,
    });
    await remote.link(user.name, user.password, name, origin);
    const instructions = new ProjectInstructionStore(folder);
    const shared = new SharedProjects({
      remote,
      dataDirectory: folder,
      instructions,
      localProjects: () => store.listProjects(),
      reviews: () => new KnowledgeReviewStore(store),
      knowledgeFile: (id) => join(folder, 'projects', id, 'knowledge.sqlite'),
    });
    return { folder, store, remote, instructions, shared };
  };
  // Alice's PC had instructions before it was linked (migrated up on the first exchange).
  const aliceFolder = join(directory, 'alice-pc');
  await mkdir(join(aliceFolder, 'projects', project.id), { recursive: true });
  new ProjectInstructionStore(aliceFolder).save(project.id, { text: '치수는 mm.' });
  const pcA = await pcOf('alice-pc', { name: 'alice', password: alice.password }, [project]);
  const pcB = await pcOf('bob-pc', { name: 'bob', password: bob.password }, []);
  await pcA.remote.pushProject(project);
  await d1
    .prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'viewer')")
    .bind(project.id, await userId('bob'))
    .run();

  // ── Membership: another account sees nothing; a viewer reads and writes. ─────────────────────
  const path = `/api/projects/${project.id}`;
  for (const route of ['/instructions', '/knowledge', '/knowledge/reviews'])
    assert.equal((await call(path + route, { cookie: eve.cookie })).status, 404, route);
  assert.equal(
    (await call(path + '/instructions', { method: 'PUT', cookie: eve.cookie, data: { text: 'x' } }))
      .status,
    404,
  );
  assert.deepEqual((await call(path + '/instructions', { cookie: bob.cookie })).value, {
    text: '',
    revision: 0,
    updatedAt: null,
    updatedByName: null,
  });

  // ── Instructions: first link moves the PC's text up; revisions; later edit wins. ─────────────
  let state = await pcA.shared.instructions(project.id);
  assert.equal(state.shared, 'synced');
  assert.equal(state.revision, 1);
  assert.equal(
    (await call(path + '/instructions', { cookie: bob.cookie })).value.text,
    '치수는 mm.',
  );
  // Bob edits on the site at revision 1.
  const bobEdit = await call(path + '/instructions', {
    method: 'PUT',
    cookie: bob.cookie,
    data: { text: '치수는 mm. 레이어는 STR::', baseRevision: 1 },
  });
  assert.equal(bobEdit.status, 200);
  assert.equal(bobEdit.value.applied, true);
  assert.equal(bobEdit.value.revision, 2);
  assert.equal(bobEdit.value.updatedByName, 'bob');
  assert.equal(bobEdit.value.conflict, undefined);
  // Alice's PC takes the newer revision; the AI turn reads the copy.
  await pcA.shared.syncInstructions(project.id, 2);
  assert.equal(pcA.instructions.text(project.id), '치수는 mm. 레이어는 STR::');
  // Too large.
  assert.equal(
    (
      await call(path + '/instructions', {
        method: 'PUT',
        cookie: bob.cookie,
        data: { text: 'x'.repeat(8 * 1024 + 1), baseRevision: 2 },
      })
    ).status,
    400,
  );
  // An offline edit on Alice's PC made before Bob's next site edit loses; Bob's later one stays.
  const aliceOffline = pcA.instructions.save(project.id, { text: '오프라인에서 고침' });
  assert.equal(aliceOffline.pending, true);
  await new Promise((done) => setTimeout(done, 5));
  await call(path + '/instructions', {
    method: 'PUT',
    cookie: bob.cookie,
    data: { text: '밥이 나중에 고침', baseRevision: 2 },
  });
  state = await pcA.shared.instructions(project.id);
  assert.equal(state.text, '밥이 나중에 고침');
  assert.equal(state.pending, false);
  assert.equal(state.conflict.text, '오프라인에서 고침');
  assert.equal(pcA.shared.dismissConflict(project.id).conflict, null);
  // A later edit made on a stale copy wins and returns the text it replaced.
  await call(path + '/instructions', {
    method: 'PUT',
    cookie: bob.cookie,
    data: { text: '밥 4판', baseRevision: 3 },
  });
  state = await pcA.shared.saveInstructions(project.id, { text: '앨리스 5판' });
  assert.equal(state.text, '앨리스 5판');
  assert.equal(state.revision, 5);
  assert.equal(state.conflict.text, '밥 4판');
  assert.equal(state.conflict.updatedByName, 'bob');

  // ── Member list and remote project view on Bob's PC. ─────────────────────────────────────────
  await pcA.remote.heartbeat();
  const listed = await pcB.shared.list();
  assert.equal(listed.linked, true);
  assert.equal(listed.online, true);
  assert.equal(listed.projects.length, 1);
  assert.equal(listed.projects[0].id, project.id);
  assert.equal(listed.projects[0].role, 'viewer');
  assert.equal(listed.projects[0].ownerName, 'alice');
  assert.equal(listed.projects[0].hostName, 'alice-pc');
  assert.equal(listed.projects[0].hostOnline, true);
  assert.equal(listed.projects[0].here, false);
  // Alice's own PC does not list its project as a shared one.
  assert.deepEqual((await pcA.shared.list()).projects, []);
  const view = await pcB.shared.view(project.id);
  assert.equal(view.project.name, 'Tower');
  assert.equal(view.instructions.text, '앨리스 5판');
  assert.deepEqual(view.agenda.items, []);
  assert.deepEqual(view.history.items, []);
  assert.deepEqual(view.notes.notes, []);
  assert.equal(view.knowledge.revision, 0);
  // Bob edits the instructions from his PC's remote project page.
  state = await pcB.shared.saveInstructions(project.id, { text: '밥의 PC에서 고침' });
  assert.equal(state.shared, 'synced');
  await pcA.shared.syncInstructions(project.id, state.revision);
  assert.equal(pcA.instructions.text(project.id), '밥의 PC에서 고침');
  // An account that is not a member gets nothing through a PC either.
  assert.equal(
    (await pcB.remote.deviceFetch(`/projects/bbbbbbbb-1111-4111-8111-111111111111/instructions`))
      .status,
    404,
  );

  // ── Knowledge: the crawling PC uploads, the site shows it only once committed. ──────────────
  const fileA = join(pcA.folder, 'projects', project.id, 'knowledge.sqlite');
  crawl(fileA, 'x'.repeat(100));
  // A browser cannot upload a set.
  assert.equal(
    (await call(path + '/knowledge/begin', { method: 'POST', cookie: alice.cookie, data: {} }))
      .status,
    403,
  );
  // Unknown table or column refused.
  const begun = await pcA.remote.deviceFetch(`/projects/${project.id}/knowledge/begin`, 'POST', {});
  const { revision: pending } = await begun.json();
  assert.equal(pending, 1);
  for (const bad of [
    { table: 'secrets', rows: [{ id: 1 }] },
    { table: 'statement', rows: [{ id: 1, password: 'x' }] },
    { table: 'statement', rows: [{ id: 'one' }] },
  ])
    assert.equal(
      (
        await pcA.remote.deviceFetch(`/projects/${project.id}/knowledge/rows`, 'PUT', {
          revision: pending,
          ...bad,
        })
      ).status,
      400,
    );
  // Rows of an uncommitted upload are not visible.
  await pcA.remote.deviceFetch(`/projects/${project.id}/knowledge/rows`, 'PUT', {
    revision: pending,
    table: 'statement',
    rows: [{ id: 9, content: 'half' }],
  });
  assert.deepEqual(
    (await call(path + '/knowledge/rows?table=statement', { cookie: bob.cookie })).value.rows,
    [],
  );
  await pcA.shared.syncKnowledge(project.id);
  const site = (await call(path + '/knowledge', { cookie: bob.cookie })).value;
  assert.equal(site.revision, 1, 'begin again reuses the next revision');
  assert.deepEqual(site.counts, { files: 3, mails: 2, excerpts: 3 });
  const statements = (await call(path + '/knowledge/rows?table=statement', { cookie: bob.cookie }))
    .value.rows;
  assert.deepEqual(
    statements.map((row) => row.id),
    [1, 2],
  );
  // Only the cited excerpts and their sources' paths went up.
  const sources = (await call(path + '/knowledge/rows?table=source', { cookie: bob.cookie })).value
    .rows;
  assert.deepEqual(sources.map((row) => row.rel_path).sort(), [
    'mail/구조.pdf',
    'mail/회의록.docx',
  ]);
  // Unchanged: no new upload.
  await pcA.shared.syncKnowledge(project.id);
  assert.equal((await call(path + '/knowledge', { cookie: bob.cookie })).value.revision, 1);

  // ── Another PC with the project rebuilds a copy the 자료 workspace reads. ────────────────────
  pcB.store.ensureProject(project.id, project.name);
  const fileB = join(pcB.folder, 'projects', project.id, 'knowledge.sqlite');
  await pcB.shared.syncKnowledge(project.id);
  const summary = knowledgeSummary(fileB);
  assert.equal(summary.available, true);
  assert.equal(summary.counts.statements, 2);
  assert.equal(summary.counts.files, 3);
  assert.equal(summary.counts.mails, 2);
  assert.equal(summary.builtAt, '2026-10-05T03:00:00Z');
  const reviewsB = new KnowledgeReviewStore(pcB.store);
  const found = factSearch(fileB, reviewLayer(reviewsB, project.id), '스팬', {});
  assert.equal(found.items[0].id, 1);

  // ── Reviews and source rules both ways; the later edit wins. ────────────────────────────────
  const reviewsA = new KnowledgeReviewStore(pcA.store);
  reviewsA.setReview(project.id, 1, { verdict: 'confirmed', by: 'user' });
  pcA.shared.recordChange(project.id, {
    review: { statementId: 1, verdict: 'confirmed', by: 'user', editedAt: Date.now() },
  });
  pcA.shared.recordChange(project.id, {
    rule: { pattern: 'big/*', reason: '다른 프로젝트', removed: false, editedAt: Date.now() },
  });
  reviewsA.addSourceRule(project.id, 'big/*', '다른 프로젝트');
  await pcA.shared.syncReviews(project.id);
  await pcB.shared.syncReviews(project.id);
  assert.equal(reviewsB.review(project.id, 1).verdict, 'confirmed');
  assert.deepEqual(reviewsB.sourceRules(project.id), [
    { pattern: 'big/*', reason: '다른 프로젝트' },
  ]);
  // Bob rejects it later on the site; Alice's PC follows.
  await call(path + '/knowledge/reviews', {
    method: 'POST',
    cookie: bob.cookie,
    data: {
      reviews: [{ statementId: 1, verdict: 'rejected', reason: '틀림', editedAt: Date.now() + 10 }],
      rules: [{ pattern: 'big/*', removed: true, editedAt: Date.now() + 10 }],
    },
  });
  // An older edit does not replace it.
  await call(path + '/knowledge/reviews', {
    method: 'POST',
    cookie: alice.cookie,
    data: { reviews: [{ statementId: 1, verdict: 'confirmed', editedAt: 1000 }] },
  });
  await pcA.shared.syncReviews(project.id);
  assert.equal(reviewsA.review(project.id, 1).verdict, 'rejected');
  assert.deepEqual(reviewsA.sourceRules(project.id), []);
  // Bad verdicts are refused.
  assert.equal(
    (
      await call(path + '/knowledge/reviews', {
        method: 'POST',
        cookie: bob.cookie,
        data: { reviews: [{ statementId: 1, verdict: 'maybe', editedAt: 1 }] },
      })
    ).status,
    400,
  );

  // ── The member list carries the revisions the PC compares. ─────────────────────────────────
  const members = await (await pcB.remote.deviceFetch('/projects')).json();
  assert.equal(members.projects[0].instructionsRevision, 6);
  assert.equal(members.projects[0].knowledgeRevision, 1);
  assert.ok(members.projects[0].knowledgeChangedAt > 0);
  // A removed member's PC loses the project.
  await d1
    .prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?')
    .bind(project.id, await userId('bob'))
    .run();
  assert.equal((await pcB.remote.deviceFetch(`/projects/${project.id}/instructions`)).status, 404);
  assert.equal(
    (await pcB.shared.members()).projects.some((p) => p.id === project.id),
    false,
  );
  pcA.store.close();
  pcB.store.close();
  await pcA.remote.close();
  await pcB.remote.close();
  console.log(
    JSON.stringify({
      passed: true,
      membership: true,
      instructions: true,
      memberList: true,
      knowledge: true,
      reviews: true,
    }),
  );
} finally {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
