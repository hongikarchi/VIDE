// PLAN-35 (ADR-037 1-3, SPEC-04.11) on the work PC with a fake account site: the merged project
// list (this PC's projects left out, the last copy when the site cannot be reached), the remote
// project view, the AI instructions' copy that AI turns read (sent when saved, pending offline,
// the site's newer text taken), and the knowledge copy rebuilt from the site's set and read by the
// 자료 routes without the site. The real site side is tests/sharing/shared-layer.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer } from '../../src/server/server.ts';
import { SharedProjects } from '../../src/server/shared-project.ts';
import { ProjectInstructionStore } from '../../src/ai/instructions/project-store.ts';
import { KnowledgeReviewStore } from '../../src/core/knowledge-review-store.ts';
import { Store } from '../../src/core/store.ts';
import { factSearch, knowledgeSummary, reviewLayer } from '../../src/jigs/knowledge.ts';
import { copyRevision } from '../../src/jigs/knowledge-copy.ts';

const SITE = 'https://sharing.example';
const SHARED = 'bbbbbbbb-2222-4222-8222-222222222222';
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
/** A small in-memory account site: the PC routes this test uses. */
function fakeSite() {
  const site = {
    down: false,
    members: [],
    instructions: new Map(),
    puts: [],
    knowledge: { revision: 0, builtAt: null, counts: {}, tables: {} },
    async fetch(url, init = {}) {
      if (site.down) throw new TypeError('fetch failed');
      const { pathname, searchParams } = new URL(String(url));
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      const path = pathname.replace('/api/hosts/device', '');
      if (path === '/heartbeat')
        return json({ ok: true, projects: [], queue: [], agendaEdits: [] });
      if (path === '/projects' && method === 'POST') return json({ ...body, deleted: false }, 201);
      if (path === '/projects' && method === 'GET') return json({ projects: site.members });
      const match = /^\/projects\/([^/]+)\/(.+)$/.exec(path);
      if (!match) return json({ error: 'NOT_FOUND' }, 404);
      const [, id, rest] = match;
      if (!site.members.some((p) => p.id === id)) return json({ error: 'PROJECT_NOT_FOUND' }, 404);
      const row = site.instructions.get(id) ?? {
        text: '',
        revision: 0,
        updatedAt: null,
        updatedByName: null,
        editedAt: 0,
      };
      if (rest === 'instructions' && method === 'GET') return json(row);
      if (rest === 'instructions' && method === 'PUT') {
        site.puts.push(body);
        const next = {
          text: body.text,
          revision: row.revision + 1,
          updatedAt: Date.now(),
          updatedByName: 'studio',
          editedAt: body.editedAt,
        };
        site.instructions.set(id, next);
        return json({ applied: true, ...next });
      }
      if (rest === 'member/agenda')
        return json({
          sharedAt: 1,
          pending: 0,
          items: [{ id: 'a1', text: '구조 회의', date: '2026-10-07', done: false, pending: false }],
        });
      if (rest === 'member/history')
        return json({
          sharedAt: 1,
          items: [
            {
              id: 'r1',
              body: '기둥 배치',
              answer: '바꿨습니다.',
              state: 'succeeded',
              files: [],
              createdAt: '2026-10-06T01:00:00.000Z',
            },
          ],
        });
      if (rest === 'member/snapshots') return json({ snapshots: [] });
      if (rest === 'notes')
        return json({ notes: [{ id: 'n1', title: '협의', kind: 'discussion' }] });
      if (rest === 'knowledge')
        return json({
          revision: site.knowledge.revision,
          builtAt: site.knowledge.builtAt,
          counts: site.knowledge.counts,
          updatedAt: 1,
          changedAt: null,
        });
      if (rest === 'knowledge/rows') {
        const rows = site.knowledge.tables[searchParams.get('table')] ?? [];
        return json({ revision: site.knowledge.revision, rows, next: null });
      }
      if (rest === 'knowledge/reviews') return json({ reviews: [], rules: [], at: Date.now() });
      return json({ error: 'NOT_FOUND' }, 404);
    },
  };
  return site;
}
const member = (id, name, extra = {}) => ({
  id,
  name,
  role: 'viewer',
  ownerName: 'bob',
  hostId: 'h-bob',
  hostName: 'Bob PC',
  hostOnline: false,
  here: false,
  updatedAt: 1,
  instructionsRevision: 0,
  knowledgeRevision: 0,
  knowledgeChangedAt: null,
  ...extra,
});

test('merged list, remote project view and the instructions copy through the engine', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-shared-'));
  await writeFile(
    join(directory, 'remote-host.json'),
    JSON.stringify({
      workerOrigin: SITE,
      hostId: '356ff01d-b586-460c-8e2b-8c9f3c083e96',
      secret: randomBytes(32).toString('hex'),
      name: 'Studio PC',
      username: 'studio',
      remote: false,
    }),
  );
  const site = fakeSite();
  const app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    remoteOptions: {
      executable: 'cloudflared',
      spawnProcess: () => {
        throw new Error('no tunnel');
      },
      fetcher: (url, init) => site.fetch(url, init),
      heartbeatMs: 600_000,
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (path, method = 'GET', body) => {
    const reply = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers: {
        Origin: app.origin,
        Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: reply.status, value: await reply.json() };
  };
  const local = (await api('/projects', 'POST', { name: '타워' })).value;
  site.members = [
    member(local.id, '타워', { role: 'owner', ownerName: 'studio', here: true }),
    member(SHARED, '공유 현장'),
  ];

  // The shared project shows; this PC's own project does not.
  let listed = (await api('/shared-projects')).value;
  assert.equal(listed.linked, true);
  assert.equal(listed.online, true);
  assert.deepEqual(
    listed.projects.map((p) => [p.id, p.name, p.ownerName, p.hostOnline]),
    [[SHARED, '공유 현장', 'bob', false]],
  );
  // The remote project view: what the site has.
  const view = (await api(`/shared-projects/${SHARED}`)).value;
  assert.equal(view.project.hostName, 'Bob PC');
  assert.equal(view.agenda.items[0].text, '구조 회의');
  assert.equal(view.history.items[0].body, '기둥 배치');
  assert.equal(view.notes.notes[0].title, '협의');
  assert.equal(view.instructions.text, '');
  assert.equal(view.site, SITE);
  // Instructions of the shared project, edited here (any member).
  let saved = (await api(`/shared-projects/${SHARED}/instructions`, 'PUT', { text: '공유 지시' }))
    .value;
  assert.equal(saved.shared, 'synced');
  assert.equal(site.instructions.get(SHARED).text, '공유 지시');
  assert.equal(
    (await api(`/shared-projects/${SHARED}/instructions`, 'PUT', { text: 1 })).status,
    400,
  );

  // This PC's project: a save goes to the site at once; the turn reads the copy.
  saved = (await api(`/projects/${local.id}/ai-instructions`, 'PUT', { text: '치수는 mm.' })).value;
  assert.equal(saved.shared, 'synced');
  assert.equal(saved.revision, 1);
  assert.equal(site.puts.at(-1).baseRevision, 0);
  assert.equal(new ProjectInstructionStore(directory).text(local.id), '치수는 mm.');
  // Another member changed it on the site: the next read brings the copy up to date.
  site.instructions.set(local.id, {
    text: '레이어는 STR::',
    revision: 2,
    updatedAt: Date.now(),
    updatedByName: 'bob',
    editedAt: Date.now(),
  });
  await api(`/projects/${local.id}/ai-instructions`);
  for (
    let i = 0;
    i < 100 && new ProjectInstructionStore(directory).text(local.id) !== '레이어는 STR::';
    i++
  )
    await new Promise((done) => setTimeout(done, 20));
  const copy = (await api(`/projects/${local.id}/ai-instructions`)).value;
  assert.equal(copy.text, '레이어는 STR::');
  assert.equal(copy.updatedByName, 'bob');
  assert.equal(new ProjectInstructionStore(directory).text(local.id), '레이어는 STR::');

  // The site cannot be reached: the list is the last copy, a save waits.
  site.down = true;
  listed = (await api('/shared-projects')).value;
  assert.equal(listed.online, false);
  assert.deepEqual(
    listed.projects.map((p) => p.id),
    [SHARED],
  );
  saved = (await api(`/projects/${local.id}/ai-instructions`, 'PUT', { text: '오프라인 수정' }))
    .value;
  assert.equal(saved.shared, 'pending');
  assert.equal(new ProjectInstructionStore(directory).text(local.id), '오프라인 수정');
  // Back: the waiting edit goes up with the revision it was made on.
  site.down = false;
  saved = (await api(`/shared-projects/${local.id}/instructions`)).value;
  assert.equal(saved.shared, 'synced');
  assert.equal(site.puts.at(-1).text, '오프라인 수정');
  assert.equal(site.puts.at(-1).baseRevision, 2);
  // A dismissed conflict notice; the route is not open to a remote session (checked elsewhere).
  assert.equal(
    (await api(`/projects/${local.id}/ai-instructions/conflict`, 'POST', {})).value.conflict,
    null,
  );
});

test('a PC that did not crawl rebuilds the knowledge copy and reads it offline', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-shared-knowledge-'));
  const store = new Store({ directory });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = store.createProject('타워');
  const site = fakeSite();
  site.members = [member(project.id, '타워', { knowledgeRevision: 3 })];
  site.knowledge = {
    revision: 3,
    builtAt: '2026-10-05T03:00:00Z',
    counts: { files: 12, mails: 4, excerpts: 40 },
    tables: {
      meta: [{ key: 'root', value: 'X:/합성' }],
      source: [{ id: 1, rel_path: 'mail/회의록.docx', skip: null }],
      excerpt: [{ id: 1, source_id: 1, locator: 'p1', text: '기둥 스팬은 13m 이하로 한다.' }],
      statement: [
        {
          id: 1,
          excerpt_id: 1,
          kind: 'requirement',
          party: '건축주',
          subject: '스팬',
          content: '기둥 스팬은 13m 이하',
          said_on: '2026-09-04',
          quote: '기둥 스팬은 13m 이하로 한다',
          quote_ok: 1,
          support_prob: 0.9,
        },
      ],
      issue: [
        {
          id: 1,
          discipline: 'structure',
          title: '스팬',
          status: 'open',
          summary: '스팬',
          statements: 1,
          note: '{"open":[]}',
        },
      ],
      statement_issue: [{ statement_id: 1, issue_id: 1, discipline: 'structure' }],
    },
  };
  const file = join(directory, 'projects', project.id, 'knowledge.sqlite');
  const shared = new SharedProjects({
    remote: {
      site: SITE,
      deviceFetch: (path, method = 'GET', data) =>
        site.fetch(SITE + '/api/hosts/device' + path, {
          method,
          body: data === undefined ? undefined : JSON.stringify(data),
        }),
    },
    dataDirectory: directory,
    instructions: new ProjectInstructionStore(directory),
    localProjects: () => store.listProjects(),
    reviews: () => new KnowledgeReviewStore(store),
    knowledgeFile: () => file,
  });
  await shared.tick(true);
  assert.equal(copyRevision(file), 3);
  // The site goes away: the 자료 workspace and the AI tools read the copy.
  site.down = true;
  const summary = knowledgeSummary(file);
  assert.equal(summary.counts.statements, 1);
  assert.equal(summary.counts.files, 12, 'the crawl’s own counts');
  assert.equal(summary.counts.mails, 4);
  assert.equal(summary.builtAt, '2026-10-05T03:00:00Z');
  const found = factSearch(
    file,
    reviewLayer(new KnowledgeReviewStore(store), project.id),
    '스팬',
    {},
  );
  assert.equal(found.items[0].id, 1);
  // A newer set replaces the copy; the copy is never treated as a crawl to upload.
  site.down = false;
  site.knowledge.revision = 4;
  site.knowledge.tables.statement[0].content = '기둥 스팬은 12m 이하';
  await shared.syncKnowledge(project.id, { revision: 4 });
  assert.equal(copyRevision(file), 4);
  assert.equal(
    factSearch(file, reviewLayer(new KnowledgeReviewStore(store), project.id), '12m', {}).items
      .length,
    1,
  );
  // The same revision is not read again.
  site.down = true;
  await shared.syncKnowledge(project.id, { revision: 4, changedAt: 0 });
  assert.equal(copyRevision(file), 4);
  assert.ok(existsSync(file));
});
