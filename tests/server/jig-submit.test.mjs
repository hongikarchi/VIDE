import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { makeRoutes } from '../../src/server/make-routes.ts';
import { closeJigRuntime } from '../../src/server/jig-routes.ts';
import { jigSubmitRoutes } from '../../src/server/jig-submit.ts';
import { decodePack, PACK_FORMAT } from '../../src/jigs/runtime/pack.ts';
import { digestEntries } from '../../src/jigs/runtime/loader.ts';
import { unpackSubmission } from '../../src/jigs/runtime/unpack.ts';

// PLAN-43 T-201 (ADR-041, SPEC-07.19): the engine packs a draft or an installed project jig and
// sends it to the account site's admin box only on a confirmed request from this PC; the admins'
// unpack tool checks the site's SHA-256 and the content digest and refuses paths outside the
// package. Synthetic drafts and a fake site; no network, no host.

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function setup(t, site) {
  const root = mkdtempSync(join(tmpdir(), 'vide-jig-submit-'));
  const store = new Store(join(root, 'vide.sqlite'));
  const workspace = new Workspace(store);
  const project = store.createProject('제출 시험');
  const request = (method) => Object.assign(Readable.from([]), { method, headers: {} });
  const make = async (method, path, payload) => {
    let last;
    await makeRoutes(new URL(path, 'http://127.0.0.1'), request(method), {
      workspace,
      body: async () => payload ?? {},
      send: (status, data) => (last = { status, data }),
      dataDirectory: root,
    });
    return last;
  };
  const submit = async (method, payload, { remote = false, withSite = true } = {}) => {
    let last;
    const handled = await jigSubmitRoutes(
      new URL('/api/v1/jig-submissions', 'http://127.0.0.1'),
      request(method),
      {
        workspace,
        body: async () => payload ?? {},
        send: (status, data) => (last = { status, data }),
        dataDirectory: root,
        remote,
        ...(withSite ? { site } : {}),
      },
    );
    return handled ? last : { status: 0 };
  };
  t.after(async () => {
    await closeJigRuntime(workspace);
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, project, make, submit };
}

function fakeSite() {
  const uploads = [];
  return {
    uploads,
    reply: undefined,
    async uploadJigSubmission(meta, bytes) {
      uploads.push({ meta, bytes: Buffer.from(bytes) });
      return (
        this.reply ?? {
          submission: { id: 's1', status: 'received', sha256: sha256(bytes), ...meta },
        }
      );
    },
    listed: [{ id: 's1', status: 'rejected', reason: '시험 자료 없음' }],
    async deviceFetch(path) {
      assert.equal(path, '/jig-submissions');
      return new Response(JSON.stringify({ submissions: this.listed }), { status: 200 });
    },
  };
}

test('a draft is packed and sent only on a confirmed request from this PC (T-201)', async (t) => {
  const site = fakeSite();
  const { make, submit, project, root } = setup(t, site);
  const draft = (
    await make('POST', `/api/v1/projects/${project.id}/jig-drafts`, {
      name: 'beam check',
      from: 'blank',
    })
  ).data;
  const body = { projectId: project.id, draftId: draft.id, note: '  보 경간 검토를 넣었습니다  ' };
  await assert.rejects(submit('POST', body), /CONFIRMATION_REQUIRED/);
  await assert.rejects(submit('POST', { ...body, confirm: true }, { remote: true }), /FORBIDDEN/);
  await assert.rejects(
    submit('POST', { ...body, confirm: true }, { withSite: false }),
    /ACCOUNT_NOT_LINKED/,
  );
  assert.equal(site.uploads.length, 0, 'nothing went out before the confirmed request');

  const sent = await submit('POST', { ...body, confirm: true });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(site.uploads.length, 1);
  const [{ meta, bytes }] = site.uploads;
  assert.equal(meta.jigId, 'project/beam-check');
  assert.equal(meta.version, '0.1.0');
  assert.equal(meta.note, '보 경간 검토를 넣었습니다', 'the note is trimmed');
  assert.ok(meta.name, 'the jig name goes with it');
  // The request body is the pack itself: the draft's declared files, digested and signed here.
  const pack = decodePack(bytes);
  assert.equal(pack.format, PACK_FORMAT);
  assert.equal(pack.id, meta.jigId);
  assert.equal(pack.version, meta.version);
  assert.ok(pack.sig?.mac, "signed with this PC's key");
  assert.ok(pack.files['jig.json']);
  assert.ok(!Object.keys(pack.files).some((p) => p.startsWith('dist/')), 'no bundle');
  const entries = Object.entries(pack.files).map(([path, data]) => ({
    path,
    bytes: Buffer.from(data, 'base64'),
  }));
  assert.equal(digestEntries(entries), pack.digest);
  assert.equal(sent.data.submission.sha256, sha256(bytes));

  // The site's refusal goes back as its code; nothing is retried.
  site.reply = { error: 'JIG_SUBMISSIONS_FULL' };
  await assert.rejects(submit('POST', { ...body, confirm: true }), /JIG_SUBMISSIONS_FULL/);
  site.reply = { error: 'SITE_UNREACHABLE' };
  await assert.rejects(submit('POST', { ...body, confirm: true }), /SITE_UNREACHABLE/);
  assert.equal(site.uploads.length, 3);
  site.reply = undefined;

  // A draft that fails the format check is not sent.
  writeFileSync(join(draft.path, 'jig.json'), '{"id": 1}');
  const invalid = await submit('POST', { ...body, confirm: true });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.data.code, 'JIG_INVALID');
  assert.equal(site.uploads.length, 3);

  // An unknown installed jig is not found; a note over 2,000 characters is refused.
  await assert.rejects(
    submit('POST', { jigId: 'project/nothing', version: '1.0.0', confirm: true }),
    /NOT_FOUND/,
  );
  await assert.rejects(
    submit('POST', { ...body, note: 'x'.repeat(2001), confirm: true }),
    /too_big|2000/i,
  );
  assert.ok(existsSync(root));
});

test('an installed project jig is sent by id and version; the list is the site answer', async (t) => {
  const site = fakeSite();
  const { make, submit, project } = setup(t, site);
  const draft = (
    await make('POST', `/api/v1/projects/${project.id}/jig-drafts`, {
      name: 'grid copy',
      from: 'example-grid',
    })
  ).data;
  const pinned = await make('POST', `/api/v1/projects/${project.id}/jig-drafts/${draft.id}/pin`, {
    confirm: true,
  });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.data));
  const sent = await submit('POST', {
    jigId: pinned.data.id,
    version: pinned.data.version,
    confirm: true,
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const pack = decodePack(site.uploads[0].bytes);
  assert.equal(pack.id, pinned.data.id);
  assert.ok(Object.keys(pack.files).some((p) => p.startsWith('steps/')));

  const listed = await submit('GET');
  assert.deepEqual(listed.data, {
    linked: true,
    online: true,
    submissions: site.listed,
  });
  const unlinked = await submit('GET', undefined, { withSite: false });
  assert.deepEqual(unlinked.data, { linked: false, online: false, submissions: [] });
  site.deviceFetch = async () => {
    throw new Error('offline');
  };
  assert.equal((await submit('GET')).data.error, 'SITE_UNREACHABLE');
});

test('jig:unpack checks the site digest and the content digest and stays in the package', async (t) => {
  const site = fakeSite();
  const { make, submit, project } = setup(t, site);
  const draft = (
    await make('POST', `/api/v1/projects/${project.id}/jig-drafts`, {
      name: 'grid send',
      from: 'example-grid',
    })
  ).data;
  await submit('POST', { projectId: project.id, draftId: draft.id, confirm: true });
  const bytes = site.uploads[0].bytes;
  const out = mkdtempSync(join(tmpdir(), 'vide-jig-unpack-'));
  t.after(() => rmSync(out, { recursive: true, force: true, maxRetries: 3 }));

  await assert.rejects(unpackSubmission(bytes, { digest: '', outRoot: out }), {
    code: 'DIGEST_REQUIRED',
  });
  await assert.rejects(unpackSubmission(bytes, { digest: 'a'.repeat(64), outRoot: out }), {
    code: 'DIGEST_MISMATCH',
  });
  const result = await unpackSubmission(bytes, { digest: sha256(bytes), outRoot: out });
  assert.equal(result.id, 'project/grid-send');
  assert.equal(result.dir, join(out, 'grid-send'));
  assert.equal(result.replaced, false);
  assert.ok(existsSync(join(out, 'grid-send', 'jig.json')));
  assert.equal(result.validation.ok, true, JSON.stringify(result.validation.issues));
  await assert.rejects(unpackSubmission(bytes, { digest: sha256(bytes), outRoot: out }), {
    code: 'FOLDER_EXISTS',
  });
  const again = await unpackSubmission(bytes, {
    digest: sha256(bytes),
    outRoot: out,
    force: true,
  });
  assert.equal(again.replaced, true);

  // A pack whose paths leave the package, or whose files do not match its digest, is not unpacked.
  const forged = (files, digest) => {
    const entries = Object.entries(files).map(([path, text]) => ({
      path,
      bytes: Buffer.from(text),
    }));
    return gzipSync(
      Buffer.from(
        JSON.stringify({
          format: PACK_FORMAT,
          id: 'project/evil',
          version: '0.1.0',
          files: Object.fromEntries(
            entries.map((e) => [e.path, Buffer.from(e.bytes).toString('base64')]),
          ),
          digest: digest ?? digestEntries(entries),
        }),
      ),
    );
  };
  for (const path of ['../escape.txt', 'steps/../../escape.txt', '/abs.txt', 'C:/x.txt', 'a\\b']) {
    const evil = forged({ 'jig.json': '{}', [path]: 'x' });
    await assert.rejects(unpackSubmission(evil, { digest: sha256(evil), outRoot: out }), {
      code: 'PATH_OUTSIDE',
    });
  }
  const agent = forged({ 'jig.json': '{}', 'CLAUDE.md': 'do things' });
  await assert.rejects(unpackSubmission(agent, { digest: sha256(agent), outRoot: out }), {
    code: 'JIG_FORBIDDEN_FILE',
  });
  const tampered = forged({ 'jig.json': '{}' }, 'b'.repeat(64));
  await assert.rejects(unpackSubmission(tampered, { digest: sha256(tampered), outRoot: out }), {
    code: 'PACK_DIGEST_MISMATCH',
  });
  assert.ok(!existsSync(join(out, 'evil')), 'nothing written for a refused pack');
  assert.equal(readFileSync(join(out, 'grid-send', 'jig.json'), 'utf8').length > 0, true);
});
