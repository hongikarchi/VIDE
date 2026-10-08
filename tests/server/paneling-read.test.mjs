import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { closeJigRuntime, jigRoutes } from '../../src/server/jig-routes.ts';
import { panelingRoutes } from '../../src/server/paneling-routes.ts';
import {
  DEFAULT_GRID,
  gridFor,
  surfaceReadBlock,
  surfaceReadBody,
} from '../../src/server/paneling-read.ts';
import { loadTemplate, renderTemplate } from '../../src/jigs/bake/templates.ts';
import { surfaceSampleSchema } from '../../src/contracts/paneling.ts';
import { importPack, packJig } from '../../src/jigs/runtime/pack.ts';
import { soleDb } from '../fixtures/store.mjs';
import { surfaceTestJig } from '../fixtures/paneling-jig.mjs';

// PLAN-49 T-251: the 패널링 '기준 면 고르기' read with a fake Rhino — the official read template body
// (only the data block substituted, the face fingerprint text included), the template's base64
// answer decoded into a `SurfaceSample` that passes the contract, kept as the `host-surface` input a
// step reads, failures that keep the earlier sample with their reason, '기준 면이 바뀜' from the
// Live Sync row, and remote sessions refused. No host, no user data.

const INSTANCE = '100:200:' + randomUUID();
const DOCUMENT = 3;
const OBJECT = randomUUID();
const f64 = (values) => {
  const b = Buffer.alloc(8 * values.length);
  values.forEach((v, k) => b.writeDoubleLE(v, 8 * k));
  return b.toString('base64');
};

/** Decode the data block a body carries (what the C# template reads). */
function blockOf(code) {
  const base64 = /Convert\.FromBase64String\("([A-Za-z0-9+/=]+)"\)/.exec(code)[1];
  const data = Buffer.from(base64, 'base64');
  let pos = 0;
  const i32 = () => ((pos += 4), data.readInt32LE(pos - 4));
  const str = () => {
    const n = i32();
    pos += n;
    return data.subarray(pos - n, pos).toString('utf8');
  };
  return {
    schema: str(),
    mode: i32(),
    objectId: str(),
    face: i32(),
    nu: i32(),
    nv: i32(),
    enc: i32(),
  };
}

/** A fake attached Rhino: one flat 2.4 × 1.2 m face (or several), answers like read-surface-grid.cs. */
function fakeRhino() {
  const host = {
    selection: [OBJECT],
    faces: 1,
    hash: 'a'.repeat(64),
    fail: null,
    calls: [],
  };
  const face = (faceIndex, n) => {
    const points = [];
    const normals = [];
    const curvatures = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        points.push((2.4 * i) / (n - 1) + 10 * faceIndex, (1.2 * j) / (n - 1), 0);
        normals.push(0, 0, 1);
        curvatures.push(0, 0);
      }
    return {
      faceIndex,
      domainU: [0, 2.4],
      domainV: [0, 1.2],
      nu: n,
      nv: n,
      closedU: false,
      closedV: false,
      singular: { uMin: false, uMax: false, vMin: false, vMax: false },
      points: f64(points),
      normals: f64(normals),
      curvatures: f64(curvatures),
      inside: Array(n * n).fill(1),
      trimLoops: [],
      geometryHash: host.hash,
    };
  };
  const sdk = {
    selection: async (target) => {
      assert.equal(target.instance, INSTANCE);
      return host.selection;
    },
    fingerprint: async () => ({ ok: true, documentHash: 'c'.repeat(64), revision: 7 }),
    readDirect: async (target, code) => {
      assert.equal(target.instance, INSTANCE);
      const block = blockOf(code);
      host.calls.push(block);
      if (host.fail) return host.fail;
      if (block.objectId !== OBJECT)
        return {
          ok: false,
          code: 'EXECUTION_FAILED',
          message: 'FACE_NOT_FOUND: 객체를 찾지 못했습니다',
        };
      if (block.mode === 2)
        return {
          ok: true,
          value: {
            schema: block.schema,
            mode: 2,
            hashes: Array.from({ length: host.faces }, () => host.hash),
          },
        };
      const indexes = block.face < 0 ? [...Array(host.faces).keys()] : [block.face];
      return {
        ok: true,
        value: {
          schema: block.schema,
          mode: 0,
          enc: 1,
          units: 'Meters',
          toMeters: 1,
          absTol: 0.001,
          nonFinite: 0,
          faces: indexes.map((k) => face(k, block.nu)),
          ms: 12,
        },
      };
    },
  };
  return { host, sdk };
}

async function fixture(t, { link: withLink = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vide-paneling-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(root, 'workspace.sqlite'));
  const workspace = new Workspace(store);
  const links = new DocumentLinks(store);
  const project = store.createProject('패널링 시험');
  const rhino = fakeRhino();
  const call = async (method, path, payload, { remote = false } = {}) => {
    let last;
    const url = new URL(path, 'http://127.0.0.1');
    const send = (status, data) => (last = { status, data });
    try {
      const handled =
        (await panelingRoutes(url, method, {
          workspace,
          dataDirectory: dataDir,
          body: async () => payload ?? {},
          send,
          remote,
          links,
          sdk: rhino.sdk,
          now: () => new Date('2026-10-08T03:00:00.000Z'),
        })) ||
        (await jigRoutes(url, Object.assign(Readable.from([]), { method, headers: {} }), {
          workspace,
          body: async () => payload ?? {},
          send,
          dataDirectory: dataDir,
          links,
          remote,
        }));
      return handled ? last : { status: 0 };
    } catch (error) {
      return { status: 'error', code: error.code ?? error.message };
    }
  };
  t.after(async () => {
    await closeJigRuntime(workspace);
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const packed = await packJig(surfaceTestJig(root), { dataDir, bundle: false, skipTests: true });
  await importPack(packed.bytes, { store: new JigStore(store), dataDir });
  const link = withLink
    ? links.link(project.id, {
        host: 'rhino',
        name: 'synthetic.3dm',
        instance: INSTANCE,
        documentId: DOCUMENT,
      })
    : null;
  const base = `/api/v1/projects/${project.id}`;
  const created = await call('POST', `${base}/jig-instances`, {
    jig: 'project/paneling-read-test',
    version: '0.1.0',
    title: '패널링 시험 작업본',
    layerRoot: 'VIDE::패널링',
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  /** A stored (Live) Sync of the link whose row for the face has this display hash. */
  let syncs = 0;
  const sync = (geometryHash) => {
    const id = `sync-${++syncs}`;
    const input = {
      id,
      body: 'Sync',
      permission: 'review',
      provider: 'claude-cli',
      pins: [],
      sketches: [],
      files: [],
      host: 'rhino',
      source: 'document',
      linkId: link.id,
    };
    const rows = geometryHash
      ? [
          {
            id: OBJECT,
            nativeId: OBJECT,
            nativeType: 'Brep',
            geometryHash,
            vertices: [],
            indices: [],
            line: [],
          },
        ]
      : [];
    soleDb(store)
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        id,
        project.id,
        JSON.stringify(input),
        'succeeded',
        JSON.stringify({
          objects: rows.map((r) => ({
            id: r.id,
            nativeId: r.nativeId,
            kind: 'native',
            name: 'f',
            origin: [0, 0, 0],
          })),
          scene: rows,
          displayOnly: true,
          hostExecuted: true,
          host: 'rhino',
          sourceDocument: {
            connection: 'attached-editor',
            instance: INSTANCE,
            documentId: DOCUMENT,
            revision: syncs,
          },
        }),
        new Date(Date.UTC(2026, 9, 8, 0, syncs)).toISOString(),
      );
  };
  return { ...rhino, call, base, iid: created.data.id, link, sync, workspace, project };
}

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

test('the read template body: only the data block changes, the fingerprint text is included once', () => {
  const template = loadTemplate('vide.read.surface-grid@1');
  assert.doesNotMatch(template.text, /^\/\/@include/m);
  assert.equal(template.text.split('string FaceHash(BrepFace hashFace)').length, 2);
  const block = surfaceReadBlock({ mode: 'grid', objectId: OBJECT, faceIndex: 0 });
  const body = surfaceReadBody({ mode: 'grid', objectId: OBJECT, faceIndex: 0 });
  assert.equal(body, renderTemplate('vide.read.surface-grid@1', block).code);
  assert.deepEqual(blockOf(body), {
    schema: 'vide.read.surface-grid@1',
    mode: 0,
    objectId: OBJECT,
    face: 0,
    nu: DEFAULT_GRID,
    nv: DEFAULT_GRID,
    enc: 1,
  });
  assert.throws(
    () => surfaceReadBlock({ mode: 'grid', objectId: 'x"); Delete();', faceIndex: 0 }),
    {
      code: 'FACE_NOT_FOUND',
    },
  );
  assert.throws(
    () => surfaceReadBlock({ mode: 'grid', objectId: OBJECT, faceIndex: 0, grid: 513 }),
    {
      code: 'READ_GRID',
    },
  );
  // Grid per face: 128² for up to four faces, less beyond; an asked grid over the limit is refused.
  assert.equal(gridFor(1), 128);
  assert.equal(gridFor(4), 128);
  assert.equal(gridFor(5), 114);
  assert.throws(() => gridFor(1, 512), { code: 'SAMPLE_LIMIT' });
  assert.throws(() => gridFor(65), { code: 'FACE_LIMIT' });
});

test('[고른 면 쓰기] reads the Rhino selection, keeps a contract sample and the step reads it', async (t) => {
  const f = await fixture(t);
  f.sync(H1);
  const empty = await f.call('GET', `${f.base}/paneling/surface?instanceId=${f.iid}`);
  assert.equal(empty.status, 200);
  assert.equal(empty.data.picked, null);

  const read = await f.call('POST', `${f.base}/paneling/surface/read`, { instanceId: f.iid });
  assert.equal(read.status, 200, JSON.stringify(read));
  assert.equal(read.data.ok, true, JSON.stringify(read.data));
  // One hashes read to count faces, then one grid read of the single face.
  assert.deepEqual(
    f.host.calls.map((c) => [c.mode, c.face, c.nu]),
    [
      [2, -1, 2],
      [0, 0, 128],
    ],
  );
  assert.equal(read.data.picked.objectId, OBJECT);
  assert.deepEqual(read.data.picked.faces, [0]);
  assert.deepEqual(read.data.picked.faceHashes, ['a'.repeat(64)]);
  assert.equal(read.data.picked.syncHash, H1);
  assert.equal(read.data.picked.revisionKey, `${INSTANCE}|${DOCUMENT}|7`);
  assert.equal(read.data.summary.points, 128 * 128);
  assert.ok(Math.abs(read.data.summary.faces[0].spacing - 2.4 / 127) < 1e-9);

  // The step's input is the kept sample, and it passes the contract.
  const run = await f.call('POST', `${f.base}/jig-instances/${f.iid}/run`, { mode: 'confirmed' });
  assert.equal(run.status, 200, JSON.stringify(run));
  assert.deepEqual(run.data.outputs.look, { read: true, objectId: OBJECT, points: 128 * 128 });

  const state = await f.call('GET', `${f.base}/paneling/surface?instanceId=${f.iid}`);
  assert.equal(state.data.picked.objectId, OBJECT);
  assert.equal(state.data.watching, true);
  assert.equal(state.data.changed, null);

  // [다시 읽기] of the unchanged face: the same input copy, the step stays done.
  const again = await f.call('POST', `${f.base}/paneling/surface/read`, {
    instanceId: f.iid,
    mode: 'reread',
  });
  assert.equal(again.data.ok, true);
  assert.equal(f.host.calls.at(-1).face, 0, 're-read reads the kept face without counting again');
  const view = await f.call('GET', `${f.base}/jig-instances/${f.iid}`);
  assert.equal(view.status, 200);
  assert.notEqual(view.data.status, 'stale');

  // A finer re-read is another input copy: the step needs computing again.
  const fine = await f.call('POST', `${f.base}/paneling/surface/read`, {
    instanceId: f.iid,
    mode: 'reread',
    grid: 256,
  });
  assert.equal(fine.data.ok, true);
  assert.equal(fine.data.summary.points, 256 * 256);
  const stale = await f.call('GET', `${f.base}/jig-instances/${f.iid}`);
  assert.equal(stale.data.status, 'stale');
});

test('the stored sample passes surfaceSampleSchema with every face of a polysurface', async (t) => {
  const f = await fixture(t);
  f.host.faces = 5;
  const read = await f.call('POST', `${f.base}/paneling/surface/read`, { instanceId: f.iid });
  assert.equal(read.data.ok, true, JSON.stringify(read.data));
  // Five faces do not fit 128² each: one read of every face on a smaller grid.
  assert.deepEqual(f.host.calls.at(-1), { ...f.host.calls.at(-1), mode: 0, face: -1, nu: 114 });
  assert.deepEqual(read.data.picked.faces, [0, 1, 2, 3, 4]);
  assert.equal(read.data.picked.syncHash, null, 'no Live Sync row at read time');
  const run = await f.call('POST', `${f.base}/jig-instances/${f.iid}/run`, { mode: 'confirmed' });
  assert.equal(run.data.outputs.look.points, 5 * 114 * 114);
  // Picked faces only (asked): one read per face.
  const two = await f.call('POST', `${f.base}/paneling/surface/read`, {
    instanceId: f.iid,
    faces: [3, 1],
  });
  assert.equal(two.data.ok, true);
  assert.deepEqual(two.data.picked.faces, [1, 3]);
  assert.deepEqual(
    f.host.calls.slice(-2).map((c) => c.face),
    [1, 3],
  );
  const state = await f.call('GET', `${f.base}/paneling/surface?instanceId=${f.iid}`);
  assert.equal(state.data.watching, false);
  assert.equal(state.data.summary.faces.length, 2);
});

test('Live Sync: another geometry hash for the face shows 기준 면이 바뀜 and never re-reads', async (t) => {
  const f = await fixture(t);
  f.sync(H1);
  const read = await f.call('POST', `${f.base}/paneling/surface/read`, { instanceId: f.iid });
  assert.equal(read.data.ok, true);
  const calls = f.host.calls.length;
  f.sync(H1);
  assert.equal(
    (await f.call('GET', `${f.base}/paneling/surface?instanceId=${f.iid}`)).data.changed,
    null,
  );
  f.sync(H2);
  const changed = await f.call('GET', `${f.base}/paneling/surface?instanceId=${f.iid}`);
  assert.deepEqual(changed.data.changed, {
    reason: 'geometry',
    message: '기준 면이 바뀜 · 다시 읽기',
  });
  f.sync(null);
  const gone = await f.call('GET', `${f.base}/paneling/surface?instanceId=${f.iid}`);
  assert.equal(gone.data.changed.reason, 'missing');
  assert.equal(f.host.calls.length, calls, 'the state never calls Rhino');
  // The kept sample is still the step input until the person re-reads.
  const run = await f.call('POST', `${f.base}/jig-instances/${f.iid}/run`, { mode: 'confirmed' });
  assert.equal(run.data.outputs.look.read, true);
});

test('failures keep the earlier sample and give their reason; remote sessions cannot read', async (t) => {
  const f = await fixture(t);
  const ok = await f.call('POST', `${f.base}/paneling/surface/read`, { instanceId: f.iid });
  assert.equal(ok.data.ok, true);
  const kept = ok.data.picked;
  const refuse = async (payload, expected) => {
    const r = await f.call('POST', `${f.base}/paneling/surface/read`, {
      instanceId: f.iid,
      ...payload,
    });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.data.ok, false);
    assert.equal(r.data.code, expected.code);
    if (expected.message) assert.equal(r.data.message, expected.message);
    const state = await f.call('GET', `${f.base}/paneling/surface?instanceId=${f.iid}`);
    assert.deepEqual(state.data.picked, kept, 'the earlier sample is kept');
    return r.data;
  };
  f.host.fail = {
    ok: false,
    code: 'EXECUTION_FAILED',
    message: 'MESH_NOT_ACCEPTED: 메쉬 기준 면은 아직 받지 않습니다 · Rhino에서 서피스로 바꾸세요',
  };
  await refuse(
    {},
    {
      code: 'MESH_NOT_ACCEPTED',
      message: '메쉬 기준 면은 아직 받지 않습니다 · Rhino에서 서피스로 바꾸세요',
    },
  );
  f.host.fail = {
    ok: false,
    code: 'EXECUTION_FAILED',
    message: 'UNKNOWN_UNITS: 문서 단위가 없습니다',
  };
  await refuse({}, { code: 'UNKNOWN_UNITS' });
  f.host.fail = {
    ok: false,
    code: 'EXECUTION_FAILED',
    message: 'NO_SAMPLE_INSIDE: 트림 안에 든 표본이 없습니다',
  };
  await refuse({ mode: 'reread', grid: 8 }, { code: 'NO_SAMPLE_INSIDE' });
  f.host.fail = { ok: false, code: 'READ_CHANGED_DOCUMENT', reverted: true };
  await refuse({}, { code: 'READ_CHANGED_DOCUMENT' });
  f.host.fail = { ok: false, code: 'EXECUTION_FAILED', message: 'System.Exception: boom' };
  const odd = await refuse({}, { code: 'READ_FAILED' });
  assert.match(odd.message, /boom/);
  f.host.fail = null;
  await refuse({ objectId: randomUUID() }, { code: 'FACE_NOT_FOUND' });
  await refuse({ mode: 'reread', grid: 512 }, { code: 'SAMPLE_LIMIT' });
  f.host.selection = [];
  await refuse({}, { code: 'PICK_NONE' });
  f.host.selection = [OBJECT, randomUUID()];
  await refuse({}, { code: 'PICK_MANY' });
  // A host error (busy) is a refusal with its reason too.
  f.host.selection = [OBJECT];
  const busy = f.sdk.readDirect;
  f.sdk.readDirect = async () => {
    throw Object.assign(new Error('HOST_BUSY'), { code: 'HOST_BUSY' });
  };
  await refuse({}, { code: 'HOST_BUSY' });
  f.sdk.readDirect = busy;

  const remote = await f.call(
    'POST',
    `${f.base}/paneling/surface/read`,
    { instanceId: f.iid },
    { remote: true },
  );
  assert.deepEqual(remote, { status: 'error', code: 'FORBIDDEN' });
  // Reading the state is allowed remotely (it never calls Rhino).
  const view = await f.call('GET', `${f.base}/paneling/surface?instanceId=${f.iid}`, null, {
    remote: true,
  });
  assert.equal(view.status, 200);
});

test('no linked Rhino document: 연결 안내, nothing kept', async (t) => {
  const f = await fixture(t, { link: false });
  const r = await f.call('POST', `${f.base}/paneling/surface/read`, { instanceId: f.iid });
  assert.equal(r.data.ok, false);
  assert.equal(r.data.code, 'HOST_NOT_CONNECTED');
  const reread = await f.call('POST', `${f.base}/paneling/surface/read`, {
    instanceId: f.iid,
    mode: 'reread',
  });
  assert.equal(reread.data.code, 'NOT_PICKED');
  assert.equal(f.host.calls.length, 0);
});

test('decoded samples pass the shared contract', async () => {
  const { decodeSurfaceSample, parseGrid } = await import('../../src/server/paneling-read.ts');
  const { sdk } = fakeRhino();
  const body = surfaceReadBody({ mode: 'grid', objectId: OBJECT, faceIndex: 0, grid: 16 });
  const answer = parseGrid((await sdk.readDirect({ instance: INSTANCE }, body)).value);
  const sample = decodeSurfaceSample([answer], {
    linkId: 'link-1',
    documentKey: 'link-1',
    objectId: OBJECT.toUpperCase(),
    revisionKey: 'r',
    readAt: '2026-10-08T03:00:00.000Z',
    path: 'attached-template',
  });
  assert.equal(surfaceSampleSchema.safeParse(sample).success, true);
  assert.equal(sample.source.objectId, OBJECT);
  assert.equal(sample.faces[0].points.length, 3 * 16 * 16);
  assert.deepEqual(sample.faces[0].points.slice(0, 6), [0, 0, 0, 2.4 / 15, 0, 0]);
  // A broken block is READ_INVALID, never a sample with garbage.
  assert.throws(
    () =>
      decodeSurfaceSample([{ ...answer, faces: [{ ...answer.faces[0], points: 'AAAA' }] }], {
        linkId: 'l',
        documentKey: 'l',
        objectId: OBJECT,
        revisionKey: 'r',
        readAt: '2026-10-08T03:00:00.000Z',
        path: 'attached-template',
      }),
    { code: 'READ_INVALID' },
  );
});
