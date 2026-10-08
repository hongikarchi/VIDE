import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { closeJigRuntime, jigRoutes } from '../../src/server/jig-routes.ts';
import { panelingRoutes } from '../../src/server/paneling-routes.ts';
import { curvesReadBlock, curvesReadBody } from '../../src/server/paneling-curves.ts';
import { loadTemplate, renderTemplate } from '../../src/jigs/bake/templates.ts';
import { importPack, packJig } from '../../src/jigs/runtime/pack.ts';

// PLAN-49 T-260 (SPEC-16.13 3·4): '타일 고르기' and '어트랙터 고르기' with a fake Rhino — the official
// read template `vide.read.curves@1` (only the data block substituted), its answer kept as the
// `host-curves` input a step reads, a tile checked by the kit's own rule (open or tilted curves
// refused, the earlier copy kept), [지우기], and remote sessions refused. No host, no user data.

const INSTANCE = '100:200:' + randomUUID();
const DOCUMENT = 3;
const TILE_A = randomUUID();
const TILE_B = randomUUID();
const POINT = randomUUID();
const OPEN = randomUUID();

/** Decode the object ids a body carries (what the C# template reads). */
function idsOf(code) {
  const base64 = /Convert\.FromBase64String\("([A-Za-z0-9+/=]+)"\)/.exec(code)[1];
  const data = Buffer.from(base64, 'base64');
  let pos = 0;
  const i32 = () => ((pos += 4), data.readInt32LE(pos - 4));
  const str = () => {
    const n = i32();
    pos += n;
    return data.subarray(pos - n, pos).toString('utf8');
  };
  const schema = str();
  const count = i32();
  return { schema, ids: Array.from({ length: count }, str) };
}

/** Rhino objects the fake answers with, like read-curves.cs (millimetre document). */
const OBJECTS = {
  [TILE_A]: {
    kind: 'polyline',
    closed: true,
    flatXY: true,
    mm: [0, 0, 0, 400, 0, 0, 400, 400, 0, 0, 400, 0],
  },
  [TILE_B]: {
    kind: 'polyline',
    closed: true,
    flatXY: true,
    mm: [500, 0, 0, 900, 0, 0, 900, 400, 0, 500, 400, 0],
  },
  [POINT]: { kind: 'point', closed: false, flatXY: true, mm: [1000, 2000, 3000] },
  [OPEN]: { kind: 'polyline', closed: false, flatXY: true, mm: [0, 0, 0, 1000, 0, 0] },
};

function fakeRhino() {
  const host = { selection: [TILE_A, TILE_B], calls: [] };
  const sdk = {
    selection: async (target) => {
      assert.equal(target.instance, INSTANCE);
      return host.selection;
    },
    fingerprint: async () => ({ ok: true, documentHash: 'c'.repeat(64), revision: 7 }),
    readDirect: async (target, code) => {
      assert.equal(target.instance, INSTANCE);
      const block = idsOf(code);
      host.calls.push(block);
      const missing = block.ids.find((id) => !OBJECTS[id]);
      if (missing)
        return {
          ok: false,
          code: 'EXECUTION_FAILED',
          message: 'CURVE_NOT_FOUND: 객체를 찾지 못했습니다',
        };
      return {
        ok: true,
        value: {
          schema: block.schema,
          units: 'Millimeters',
          toMeters: 0.001,
          absTol: 0.00001,
          items: block.ids.map((id) => ({
            objectId: id.toUpperCase(),
            kind: OBJECTS[id].kind,
            closed: OBJECTS[id].closed,
            flatXY: OBJECTS[id].flatXY,
            points: OBJECTS[id].mm.map((v) => v * 0.001),
          })),
          ms: 3,
        },
      };
    },
  };
  return { host, sdk };
}

/** A project jig with the two `host-curves` inputs; its step reports what it was given. */
function curvesTestJig(root) {
  const dir = join(root, 'jigs', 'paneling-curves-test');
  mkdirSync(join(dir, 'steps'), { recursive: true });
  writeFileSync(
    join(dir, 'jig.json'),
    JSON.stringify({
      contractVersion: 3,
      id: 'project/paneling-curves-test',
      version: '0.1.0',
      kind: 'tool',
      name: '타일·어트랙터 읽기 시험',
      summary: '고른 점·곡선을 받는지 보는 시험용 jig(합성 자료용).',
      icon: 'grid',
      inputs: [
        { key: 'tile', title: '타일 곡선', kind: 'host-curves', host: 'rhino', accept: 'tile' },
        {
          key: 'attractors',
          title: '어트랙터',
          kind: 'host-curves',
          host: 'rhino',
          accept: 'attractor',
        },
      ],
      params: [],
      steps: [
        {
          id: 'look',
          title: '보기',
          kind: 'code',
          entry: 'steps/look.ts#look',
          reads: ['input.tile', 'input.attractors'],
          writes: 'look',
          speed: 'live',
        },
      ],
      capabilities: [{ name: 'sync.read', reason: '연결 Rhino 문서의 점·곡선을 읽습니다' }],
      panel: 'panel.json',
      selftest: { fixtures: 'fixtures', requiresHost: false },
      skill: 'skill.md',
    }),
  );
  writeFileSync(
    join(dir, 'steps', 'look.ts'),
    `export function look(inputs: { tile: { items: unknown[] } | null; attractors: { items: unknown[] } | null }) {
  return { tile: inputs.tile ? inputs.tile.items.length : 0, attractors: inputs.attractors ? inputs.attractors.items.length : 0 };
}
`,
  );
  writeFileSync(
    join(dir, 'panel.json'),
    JSON.stringify({ layout: 'jig-run', left: [{ part: 'step-rail' }], center: { views: [] } }),
  );
  mkdirSync(join(dir, 'fixtures', 'empty'), { recursive: true });
  writeFileSync(
    join(dir, 'fixtures', 'empty', 'input.json'),
    JSON.stringify({ tile: null, attractors: null }),
  );
  writeFileSync(join(dir, 'fixtures', 'empty', 'params.json'), '{}');
  writeFileSync(
    join(dir, 'fixtures', 'empty', 'expect.json'),
    JSON.stringify({ steps: { look: { tile: 0, attractors: 0 } } }),
  );
  writeFileSync(
    join(dir, 'skill.md'),
    '---\nname: 타일 읽기 시험\nintent_en: read picked curves\nwords: [시험]\nnot_for: [실제 패널링]\ntools: []\nlimits: [시험용]\n---\n\n# 시험\n\n합성 자료만 읽는다.\n',
  );
  return dir;
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vide-paneling-curves-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(root, 'workspace.sqlite'));
  const workspace = new Workspace(store);
  const links = new DocumentLinks(store);
  const project = store.createProject('타일 시험');
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
  const packed = await packJig(curvesTestJig(root), { dataDir, bundle: false, skipTests: true });
  await importPack(packed.bytes, { store: new JigStore(store), dataDir });
  links.link(project.id, {
    host: 'rhino',
    name: 'synthetic.3dm',
    instance: INSTANCE,
    documentId: DOCUMENT,
  });
  const base = `/api/v1/projects/${project.id}`;
  const created = await call('POST', `${base}/jig-instances`, {
    jig: 'project/paneling-curves-test',
    version: '0.1.0',
    title: '타일 시험 작업본',
    layerRoot: 'VIDE::패널링',
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  return { ...rhino, call, base, iid: created.data.id };
}

test('the curves read template body: only the data block changes', () => {
  const template = loadTemplate('vide.read.curves@1');
  assert.match(template.text, /Nothing is added or changed in the document/);
  const ids = [TILE_A, POINT];
  const body = curvesReadBody(ids);
  assert.equal(body, renderTemplate('vide.read.curves@1', curvesReadBlock(ids)).code);
  assert.deepEqual(idsOf(body), { schema: 'vide.read.curves@1', ids });
});

test('[고른 곡선 쓰기] keeps the tile as the host-curves input; the step reads it; [지우기] clears it', async (t) => {
  const f = await fixture(t);
  const empty = await f.call('GET', `${f.base}/paneling/curves?instanceId=${f.iid}`);
  assert.equal(empty.status, 200);
  assert.deepEqual(
    empty.data.inputs.map((i) => [i.key, i.accept, i.picked]),
    [
      ['tile', 'tile', null],
      ['attractors', 'attractor', null],
    ],
  );
  const read = await f.call('POST', `${f.base}/paneling/curves/read`, {
    instanceId: f.iid,
    key: 'tile',
  });
  assert.equal(read.status, 200, JSON.stringify(read));
  assert.equal(read.data.ok, true, JSON.stringify(read.data));
  assert.equal(read.data.picked.count, 2);
  assert.deepEqual(read.data.picked.objectIds, [TILE_A, TILE_B]);
  const run = await f.call('POST', `${f.base}/jig-instances/${f.iid}/run`, { mode: 'confirmed' });
  assert.equal(run.status, 200, JSON.stringify(run));
  assert.deepEqual(run.data.outputs.look, { tile: 2, attractors: 0 });

  // Points and open curves are not a tile: refused with the reason, the kept tile stays.
  f.host.selection = [OPEN];
  const refused = await f.call('POST', `${f.base}/paneling/curves/read`, {
    instanceId: f.iid,
    key: 'tile',
  });
  assert.equal(refused.data.ok, false);
  assert.equal(refused.data.code, 'NOT_TILE');
  assert.match(refused.data.message, /닫힌 곡선/);
  const kept = await f.call('GET', `${f.base}/paneling/curves?instanceId=${f.iid}&key=tile`);
  assert.equal(kept.data.inputs[0].picked.count, 2);

  // Attractors take points and open curves.
  f.host.selection = [POINT, OPEN];
  const att = await f.call('POST', `${f.base}/paneling/curves/read`, {
    instanceId: f.iid,
    key: 'attractors',
  });
  assert.equal(att.data.ok, true, JSON.stringify(att.data));
  assert.equal(att.data.picked.count, 2);

  const cleared = await f.call('POST', `${f.base}/paneling/curves/read`, {
    instanceId: f.iid,
    key: 'tile',
    mode: 'clear',
  });
  assert.deepEqual(cleared.data, { ok: true, key: 'tile', picked: null });
  const after = await f.call('GET', `${f.base}/paneling/curves?instanceId=${f.iid}&key=tile`);
  assert.equal(after.data.inputs[0].picked, null);
});

test('curves read failures: nothing selected, an unknown object, remote sessions', async (t) => {
  const f = await fixture(t);
  f.host.selection = [];
  const none = await f.call('POST', `${f.base}/paneling/curves/read`, {
    instanceId: f.iid,
    key: 'attractors',
  });
  assert.equal(none.data.ok, false);
  assert.equal(none.data.code, 'PICK_NONE');
  f.host.selection = [randomUUID()];
  const missing = await f.call('POST', `${f.base}/paneling/curves/read`, {
    instanceId: f.iid,
    key: 'attractors',
  });
  assert.equal(missing.data.code, 'CURVE_NOT_FOUND');
  const remote = await f.call(
    'POST',
    `${f.base}/paneling/curves/read`,
    { instanceId: f.iid, key: 'tile' },
    { remote: true },
  );
  assert.equal(remote.status, 'error');
  assert.equal(remote.code, 'FORBIDDEN');
  const unknown = await f.call('GET', `${f.base}/paneling/curves?instanceId=${f.iid}&key=nope`);
  assert.equal(unknown.code, 'NOT_FOUND');
});
