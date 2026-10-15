// 체크아웃 · 서버에 반영 · 작업 중 · 도면 보호 (SPEC-01.13 9, PLAN-52 T-310~T-312): a model file of
// the remembered server folder is copied into the work folder and recorded; [서버에 반영] keeps the
// previous server version in the archive, then writes; the target folder comes from memory or is
// asked once and remembered; a server version changed since the checkout is not overwritten
// unseen; drawings kept on the server get one backup a day before AI edits. The "server" is a
// second mkdtemp folder (no other drive here); no host, no real share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { ProjectFolders } from '../../src/core/project-folders.ts';
import { Checkouts } from '../../src/core/checkouts.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { OfflineView } from '../../src/server/offline-view.ts';
import {
  changesFromRequests,
  checkoutRoutes,
  folderHolds,
  localDay,
  serverFailure,
  WorkspaceCheckouts,
} from '../../src/server/workspace-checkout.ts';

const sha = (text) => createHash('sha256').update(text).digest('hex');

async function fixture(t, { cad = 'server', targets = {}, site } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-checkout-'));
  const store = new Store(join(directory, 'data.sqlite'));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = store.createProject('나진상가');
  const work = join(directory, 'work');
  const server = join(directory, 'server', '2601-나진상가');
  for (const [file, text] of [
    ['04 모델/A-동.3dm', 'server v1'],
    ['04 모델/old/B-동.3dm', 'b v1'],
    ['04 모델/메모.txt', 'not a model'],
    ['05 도면/A-101.dwg', 'dwg v1'],
    ['05 도면/xref/X-base.dwg', 'xref v1'],
    ['02 자료/법규.pdf', 'pdf'],
  ]) {
    const path = join(server, ...file.split('/'));
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
  await mkdir(work, { recursive: true });
  const root = realpathSync.native(server);
  await writeFile(
    join(work, 'project.config.json'),
    JSON.stringify({
      schema: 'vide-workspace/1',
      title: '나진상가',
      paths: { rhino: '03_모델', cad: '04_도면', archive: '10_아카이브' },
      server: {
        root,
        paths: { rhino: '04 모델', cad: '05 도면', raw: '02 자료' },
        targets,
        checkout: { rhino: 'local', cad },
      },
      vide: { projectId: project.id },
    }),
  );
  const folders = new ProjectFolders(store);
  folders.add(project.id, work, 'project');
  folders.add(project.id, server, 'project');
  let clock = new Date('2026-10-15T01:20:00Z');
  const changed = [];
  const logs = [];
  const service = new WorkspaceCheckouts({
    folders,
    isProject: (id) => id === project.id,
    checkouts: new Checkouts(store),
    pcId: () => 'PC-1',
    actor: () => '홍길동',
    site,
    onChange: (id) => changed.push(id),
    log: (event, fields) => logs.push({ event, fields }),
    now: () => clock,
  });
  return {
    store,
    project,
    work,
    server: root,
    service,
    changed,
    logs,
    setClock: (value) => (clock = new Date(value)),
    manifest: async () => JSON.parse(await readFile(join(work, 'project.config.json'), 'utf8')),
  };
}

test('checkout copies the model and records it; the listing shows 작업 중 and the local row', async (t) => {
  const f = await fixture(t);
  const serverFile = join(f.server, '04 모델', 'A-동.3dm');
  const taken = await f.service.checkout(f.project.id, { serverPath: serverFile });
  assert.equal(taken.existing, false);
  const row = taken.checkout;
  assert.equal(row.role, 'rhino');
  assert.equal(row.localPath, join(f.work, '03_모델', 'A-동.3dm'));
  assert.equal(await readFile(row.localPath, 'utf8'), 'server v1');
  assert.equal(row.serverHash, sha('server v1'));
  assert.equal(row.userId, '홍길동');
  assert.equal(row.pcId, 'PC-1');
  assert.equal(row.releasedAt, null);
  assert.deepEqual(f.changed, [f.project.id]);
  // The same file again on this PC is the open checkout.
  const again = await f.service.checkout(f.project.id, { serverPath: serverFile });
  assert.equal(again.existing, true);
  assert.equal(again.checkout.id, row.id);

  const listing = await f.service.serverFiles(f.project.id);
  assert.equal(listing.server.root, f.server);
  const models = listing.roles.find((role) => role.role === 'rhino');
  assert.equal(models.mode, 'local');
  assert.deepEqual(
    models.files.map((file) => file.relative),
    ['04 모델\\A-동.3dm', '04 모델\\old\\B-동.3dm'],
  );
  const mine = models.files[0].mine;
  assert.equal(mine.id, row.id);
  assert.equal(mine.localExists, true);
  const drawings = listing.roles.find((role) => role.role === 'cad');
  assert.equal(drawings.mode, 'server');
  assert.equal(drawings.files.length, 2);
  assert.equal(drawings.files[0].backup, null);
});

test('publish asks where once, remembers it, archives the previous server version and writes', async (t) => {
  const f = await fixture(t);
  const serverFile = join(f.server, '04 모델', 'A-동.3dm');
  const { checkout } = await f.service.checkout(f.project.id, { serverPath: serverFile });
  await writeFile(checkout.localPath, 'local edit 1');
  const summary = await f.service.publishSummary(f.project.id, checkout.id);
  assert.equal(summary.remembered, false);
  assert.equal(summary.target, null);
  assert.equal(summary.suggestion, '04 모델');
  assert.equal(summary.server.changedSinceCheckout, false);
  assert.equal(summary.syncMismatch, null);
  // No memory: NEEDS_TARGET with the folder it came from, and nothing written.
  await assert.rejects(f.service.publish(f.project.id, { checkoutId: checkout.id }), (error) => {
    assert.equal(error.code, 'NEEDS_TARGET');
    assert.equal(error.details.suggestion, '04 모델');
    return true;
  });
  assert.equal(await readFile(serverFile, 'utf8'), 'server v1');
  // Given a target (absolute, inside the server folder): remembered, archived, written.
  f.setClock('2026-10-15T01:35:00Z');
  const done = await f.service.publish(f.project.id, {
    checkoutId: checkout.id,
    target: join(f.server, '04 모델'),
    keepCheckout: true,
  });
  assert.equal(done.target, '04 모델');
  assert.equal(done.remembered, true);
  assert.equal(done.released, false);
  assert.equal(await readFile(serverFile, 'utf8'), 'local edit 1');
  assert.equal(done.hash, sha('local edit 1'));
  const stamp = (() => {
    const at = new Date('2026-10-15T01:35:00Z');
    const p = (n) => String(n).padStart(2, '0');
    return `${localDay(at)}-${p(at.getHours())}${p(at.getMinutes())}`;
  })();
  assert.equal(
    done.archived,
    join(f.work, '10_아카이브', '서버반영', stamp, '04 모델', 'A-동.3dm'),
  );
  assert.equal(await readFile(done.archived, 'utf8'), 'server v1');
  assert.equal((await f.manifest()).server.targets.rhino, '04 모델');
  // Still 작업 중, now matching the server version it wrote.
  assert.equal(done.checkout.releasedAt, null);
  assert.equal(done.checkout.serverHash, sha('local edit 1'));
  // Next time the remembered target is used; the same minute gets a second archive folder.
  await writeFile(checkout.localPath, 'local edit 2');
  const next = await f.service.publish(f.project.id, { checkoutId: checkout.id });
  assert.equal(next.remembered, false);
  assert.equal(next.released, true);
  assert.equal(await readFile(serverFile, 'utf8'), 'local edit 2');
  assert.match(next.archived, /서버반영\\[^\\]+-2\\04 모델\\A-동\.3dm$/);
  assert.equal(await readFile(next.archived, 'utf8'), 'local edit 1');
  assert.ok(next.checkout.releasedAt);
  // Released: no longer listed as mine, the local copy stays.
  const listing = await f.service.serverFiles(f.project.id, 'rhino');
  assert.equal(listing.roles[0].files[0].mine, null);
  assert.equal(await readFile(checkout.localPath, 'utf8'), 'local edit 2');
  await assert.rejects(f.service.publish(f.project.id, { checkoutId: checkout.id }), {
    code: 'CHECKOUT_RELEASED',
  });
  assert.ok(f.logs.some((entry) => entry.event === 'workspace-publish'));
});

test('a server version changed since the checkout is not overwritten until the person saw it', async (t) => {
  const f = await fixture(t, { targets: { rhino: '04 모델' } });
  const serverFile = join(f.server, '04 모델', 'A-동.3dm');
  const { checkout } = await f.service.checkout(f.project.id, { serverPath: serverFile });
  await writeFile(checkout.localPath, 'mine');
  await writeFile(serverFile, 'someone else');
  await utimes(serverFile, new Date(), new Date(Date.now() + 60_000));
  const summary = await f.service.publishSummary(f.project.id, checkout.id);
  assert.equal(summary.server.changedSinceCheckout, true);
  assert.equal(summary.remembered, true);
  let seen;
  await assert.rejects(f.service.publish(f.project.id, { checkoutId: checkout.id }), (error) => {
    assert.equal(error.code, 'SERVER_CHANGED_SINCE_CHECKOUT');
    seen = error.details.server.hash;
    return true;
  });
  assert.equal(await readFile(serverFile, 'utf8'), 'someone else');
  assert.equal(seen, sha('someone else'));
  // No archive folder was left behind by the refusal.
  await assert.rejects(stat(join(f.work, '10_아카이브', '서버반영')));
  const done = await f.service.publish(f.project.id, {
    checkoutId: checkout.id,
    seenServerHash: seen,
  });
  assert.equal(await readFile(serverFile, 'utf8'), 'mine');
  assert.equal(await readFile(done.archived, 'utf8'), 'someone else');
});

test('same local name asks before replacing; another PC holding it gives only a read-only copy', async (t) => {
  let rows = [];
  const f = await fixture(t, { site: async () => rows });
  const serverFile = join(f.server, '04 모델', 'A-동.3dm');
  await mkdir(join(f.work, '03_모델'), { recursive: true });
  await writeFile(join(f.work, '03_모델', 'A-동.3dm'), 'old local');
  await assert.rejects(f.service.checkout(f.project.id, { serverPath: serverFile }), (error) => {
    assert.equal(error.code, 'LOCAL_COPY_EXISTS');
    return true;
  });
  assert.equal(await readFile(join(f.work, '03_모델', 'A-동.3dm'), 'utf8'), 'old local');
  // Another PC has the old/B file: warned, and only a read-only copy, not recorded.
  const other = join(f.server, '04 모델', 'old', 'B-동.3dm');
  rows = [
    {
      fileKey: other.toLowerCase(),
      role: 'rhino',
      serverPath: other,
      userName: '김철수',
      checkedOutAt: '2026-10-14T23:00:00Z',
      mine: false,
    },
  ];
  await assert.rejects(f.service.checkout(f.project.id, { serverPath: other }), (error) => {
    assert.equal(error.code, 'CHECKED_OUT_ELSEWHERE');
    assert.equal(error.details.holders[0].user, '김철수');
    return true;
  });
  const copy = await f.service.checkout(f.project.id, { serverPath: other, readOnly: true });
  assert.equal(copy.readOnly, true);
  assert.equal(copy.checkout, null);
  assert.equal(copy.localPath, join(f.work, '03_모델', 'B-동 (읽기 전용).3dm'));
  assert.equal(await readFile(copy.localPath, 'utf8'), 'b v1');
  assert.equal(new Checkouts(f.store).active(f.project.id).length, 0);
  const listing = await f.service.serverFiles(f.project.id, 'rhino');
  assert.equal(listing.siteChecked, true);
  assert.deepEqual(listing.roles[0].files[1].others, [
    { user: '김철수', at: '2026-10-14T23:00:00Z', here: false },
  ]);
  // [덮어쓰기] for the A file.
  const taken = await f.service.checkout(f.project.id, { serverPath: serverFile, overwrite: true });
  assert.equal(await readFile(taken.checkout.localPath, 'utf8'), 'server v1');
});

test('refusals: outside the connected folders, a non-model file, drawings on the server, no workspace', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.checkout(f.project.id, { serverPath: join(tmpdir(), 'elsewhere.3dm') }),
    { code: 'NOT_A_SERVER_FILE' },
  );
  await assert.rejects(
    f.service.checkout(f.project.id, { serverPath: join(f.server, '04 모델', '메모.txt') }),
    { code: 'NOT_A_SERVER_FILE' },
  );
  await assert.rejects(
    f.service.checkout(f.project.id, { serverPath: join(f.server, '05 도면', 'A-101.dwg') }),
    { code: 'CAD_SERVER_DIRECT' },
  );
  await assert.rejects(f.service.checkout(f.project.id, { serverPath: 'relative.3dm' }), {
    code: 'INVALID_INPUT',
  });
  const empty = f.store.createProject('빈 프로젝트');
  await assert.rejects(f.service.serverFiles(empty.id), { code: 'NO_WORKSPACE' });
});

test('drawings on the server: one backup a day before AI edits, nothing for other files', async (t) => {
  const f = await fixture(t);
  const drawing = join(f.server, '05 도면', 'xref', 'X-base.dwg');
  const first = await f.service.beforeDwgEdit(f.project.id, drawing);
  assert.equal(first.made, true);
  const day = localDay(new Date('2026-10-15T01:20:00Z'));
  assert.equal(
    first.backup,
    join(f.work, '10_아카이브', '서버백업', day, '05 도면', 'xref', 'X-base.dwg'),
  );
  assert.equal(await readFile(first.backup, 'utf8'), 'xref v1');
  await writeFile(drawing, 'xref v2');
  const second = await f.service.beforeDwgEdit(f.project.id, drawing);
  assert.equal(second.made, false);
  assert.equal(await readFile(first.backup, 'utf8'), 'xref v1');
  // The next day takes a new copy.
  f.setClock('2026-10-16T01:20:00Z');
  const next = await f.service.beforeDwgEdit(f.project.id, drawing);
  assert.equal(next.made, true);
  assert.equal(await readFile(next.backup, 'utf8'), 'xref v2');
  // A drawing outside the remembered drawing folder, or a model file: nothing.
  assert.deepEqual(
    await f.service.beforeDwgEdit(f.project.id, join(f.server, '02 자료', 'x.dwg')),
    {
      backup: null,
    },
  );
  // The listing shows today's backup.
  const listing = await f.service.serverFiles(f.project.id, 'cad');
  const row = listing.roles[0].files.find((file) => file.name === 'X-base.dwg');
  assert.ok(row.backup?.at);
  // A project without a work folder: never throws.
  const other = f.store.createProject('다른');
  const none = await f.service.beforeDwgEdit(other.id, drawing);
  assert.equal(none.backup, null);
  assert.equal(none.error, 'NO_WORKSPACE');
});

test('a drawing opened through another spelling (mapped-drive-like junction) still gets its backup', async (t) => {
  const f = await fixture(t);
  // A junction stands in for a mapped drive letter pointing at the share.
  const mapped = join(f.work, '..', 'Z-drive');
  await symlink(join(f.server, '..'), mapped, 'junction');
  const drawing = join(mapped, '2601-나진상가', '05 도면', 'A-101.dwg');
  assert.equal(folderHolds(f.server, drawing), true);
  // Folder boundaries are whole names: C:\proj does not hold C:\proj2\a.dwg.
  assert.equal(folderHolds('C:\\proj', 'C:\\proj2\\a.dwg'), false);
  assert.equal(folderHolds('C:\\proj', 'C:\\PROJ\\a.dwg'), true);
  const made = await f.service.beforeDwgEdit(f.project.id, drawing);
  assert.equal(made.made, true, JSON.stringify(made));
  assert.equal(await readFile(made.backup, 'utf8'), 'dwg v1');
});

test('local copies never leave the work folder through a junction', async (t) => {
  const f = await fixture(t);
  const outside = join(f.work, '..', 'elsewhere');
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(f.work, '10_아카이브'), 'junction');
  const drawing = join(f.server, '05 도면', 'A-101.dwg');
  const refused = await f.service.beforeDwgEdit(f.project.id, drawing);
  // The archive role leaving the folder is dropped (or refused): nothing written outside.
  assert.equal(refused.backup, null);
  assert.deepEqual(await readdir(outside), []);
});

test('drawings checked out locally when the project says so; no daily backup then', async (t) => {
  const f = await fixture(t, { cad: 'local', targets: { cad: '05 도면' } });
  const drawing = join(f.server, '05 도면', 'A-101.dwg');
  const { checkout } = await f.service.checkout(f.project.id, { serverPath: drawing });
  assert.equal(checkout.role, 'cad');
  assert.equal(checkout.localPath, join(f.work, '04_도면', 'A-101.dwg'));
  assert.deepEqual(await f.service.beforeDwgEdit(f.project.id, drawing), { backup: null });
  const listing = await f.service.serverFiles(f.project.id, 'cad');
  assert.equal(listing.roles[0].mode, 'local');
  assert.equal(listing.roles[0].files[0].backup, undefined);
  await writeFile(checkout.localPath, 'dwg local');
  const done = await f.service.publish(f.project.id, { checkoutId: checkout.id });
  assert.equal(await readFile(drawing, 'utf8'), 'dwg local');
  assert.ok(done.archived.includes('서버반영'));
  // Released by the publish already; [체크아웃 풀기] again answers the same row.
  assert.ok(f.service.release(f.project.id, checkout.id).checkout.releasedAt);
});

test('routes answer refusals with their details; a remote session cannot copy', async (t) => {
  const f = await fixture(t);
  const serverFile = join(f.server, '04 모델', 'A-동.3dm');
  const call = async (path, method, body, remote = false) => {
    let sent;
    const handled = await checkoutRoutes(
      new URL('http://x/api/v1/projects/' + f.project.id + '/workspace/' + path),
      method,
      () => undefined,
      (status, value) => (sent = { status, value }),
      { service: f.service, body: async () => body ?? {}, remote },
    );
    assert.equal(handled, true);
    return sent;
  };
  await assert.rejects(call('checkout', 'POST', { serverPath: serverFile }, true), {
    code: 'FORBIDDEN',
  });
  const taken = await call('checkout', 'POST', { serverPath: serverFile });
  assert.equal(taken.status, 200);
  const id = taken.value.checkout.id;
  const asked = await call('publish', 'POST', { checkoutId: id });
  assert.equal(asked.status, 409);
  assert.deepEqual(asked.value, { code: 'NEEDS_TARGET', role: 'rhino', suggestion: '04 모델' });
  const listing = await call('server-files?role=rhino', 'GET');
  assert.equal(listing.status, 200);
  const summary = await call(`publish-summary?checkoutId=${id}`, 'GET');
  assert.equal(summary.value.suggestion, '04 모델');
  const released = await call('release', 'POST', { checkoutId: id });
  assert.ok(released.value.checkout.releasedAt);
  assert.equal(
    await checkoutRoutes(
      new URL('http://x/api/v1/projects/p/workspace'),
      'GET',
      () => undefined,
      () => undefined,
      { service: f.service, body: async () => ({}), remote: false },
    ),
    false,
  );
});

test('changed objects come from applied executions on the local copy since the checkout', () => {
  const links = [
    { id: 'L1', path: 'C:\\work\\03_모델\\A-동.3dm' },
    { id: 'L2', path: 'C:\\work\\03_모델\\B.3dm' },
  ];
  const requests = [
    {
      result: {
        executions: [
          {
            state: 'applied',
            at: '2026-10-15T02:00:00Z',
            file: { linkId: 'L1', name: 'A-동.3dm' },
            changes: { added: ['a', 'b'], changed: ['c'], removed: [] },
          },
          {
            state: 'undone',
            at: '2026-10-15T02:01:00Z',
            file: { linkId: 'L1', name: 'A-동.3dm' },
            changes: { added: ['x'], changed: [], removed: [] },
          },
          {
            state: 'applied',
            at: '2026-10-14T02:00:00Z',
            file: { linkId: 'L1', name: 'A-동.3dm' },
            changes: { added: ['old'], changed: [], removed: [] },
          },
          {
            state: 'applied',
            at: '2026-10-15T02:00:00Z',
            file: { linkId: 'L2', name: 'B.3dm' },
            changes: { added: ['y'], changed: [], removed: ['z'] },
          },
        ],
      },
    },
    { result: null },
  ];
  assert.deepEqual(
    changesFromRequests(links, requests, 'c:\\WORK\\03_모델\\A-동.3dm', '2026-10-15T00:00:00Z'),
    { added: 2, modified: 1, removed: 0 },
  );
  assert.equal(changesFromRequests(links, requests, 'C:\\other.3dm', '2026'), null);
});

test('server failures map to the codes the screen explains', () => {
  assert.equal(serverFailure({ code: 'EBUSY' }), 'SERVER_FILE_LOCKED');
  assert.equal(serverFailure({ code: 'EPERM' }), 'SERVER_ACCESS_DENIED');
  assert.equal(serverFailure({ code: 'EPERM' }, true), 'SERVER_FILE_LOCKED');
  assert.equal(serverFailure({ code: 'EACCES' }), 'SERVER_ACCESS_DENIED');
  assert.equal(serverFailure({ code: 'ENOENT' }), 'SERVER_UNREACHABLE');
  assert.equal(serverFailure({ code: 'UNKNOWN' }), 'SERVER_UNREACHABLE');
});

test('an unreachable server folder shows as such; this PC\u2019s open checkouts go to the site', async (t) => {
  const f = await fixture(t);
  const serverFile = join(f.server, '04 모델', 'A-동.3dm');
  await f.service.checkout(f.project.id, { serverPath: serverFile });
  assert.deepEqual(f.service.siteItems(f.project.id), [
    {
      fileKey: serverFile.toLowerCase(),
      role: 'rhino',
      serverPath: serverFile,
      userName: '홍길동',
      checkedOutAt: '2026-10-15T01:20:00.000Z',
    },
  ]);
  const uploads = [];
  const offline = new OfflineView({
    store: f.store,
    workspace: new Workspace(f.store),
    links: new DocumentLinks(f.store),
    checkouts: (id) => f.service.siteItems(id),
    remote: {
      hostId: 'host-1',
      uploadSnapshot: async () => 'off',
      deleteSnapshot: async () => true,
      uploadSummary: async (projectId, part, items) => {
        uploads.push({ projectId, part, items });
        return undefined;
      },
      deleteSummary: async () => true,
    },
  });
  await offline.tick(true);
  const sent = uploads.filter((u) => u.part === 'checkouts');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].items[0].userName, '홍길동');
  // Unchanged: not sent again.
  await offline.tick(true);
  assert.equal(uploads.filter((u) => u.part === 'checkouts').length, 1);
  await offline.close();
  // The server folder goes away.
  await rm(join(f.server, '04 모델'), { recursive: true, force: true });
  const listing = await f.service.serverFiles(f.project.id, 'rhino');
  assert.equal(listing.roles[0].status, 'unreachable');
  assert.deepEqual(listing.roles[0].files, []);
});
