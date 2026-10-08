// Nested Rhino blocks (2026-10-08 report: blocks inside blocks came as boxes after Sync). The plugin
// sends each definition once with `children` references; the engine expands them per page so the
// stored model, the screen and jigs keep reading one flat definition (ARCH-01 「Rhino 네이티브 취득의
// 블록 보존」).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expandNestedDefinitions } from '../../hosts/rhino/block-nesting.ts';
import { readScenePages } from '../../hosts/rhino/scene-pages.ts';
import { editorMethods } from '../../hosts/rhino/editor-channel.ts';
import { sendHostCommand } from '../../hosts/common/transport.ts';
import {
  coordinate,
  decodeGeometry,
  encodeGeometry,
  isPacked,
} from '../../src/contracts/geometry-transfer.ts';
import { displayCoverage, PARTIAL_BLOCK_TYPE_SUFFIX } from '../../src/core/display-delta.ts';
import { changesPage, displayPage, fakePlugin } from '../fixtures/host-pages.mjs';

const hash = (c) => c.repeat(64);
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const move = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
// 90° about Z, then moved.
const turn = (x, y, z) => [0, -1, 0, x, 1, 0, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const scale2 = () => [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
const at = (values, i) => [0, 1, 2].map((k) => coordinate(values, i * 3 + k));
const near = (a, b, message) =>
  a.forEach((v, k) => assert.ok(Math.abs(v - b[k]) < 1e-5, `${message}: ${a} ≈ ${b}`));

/** inner: one triangle, one segment, one label. mid: its own triangle and two inner copies. outer: two mids. */
function nestedDefinitions() {
  const inner = randomUUID(),
    mid = randomUUID(),
    outer = randomUUID();
  return {
    ids: { inner, mid, outer },
    definitions: {
      [inner]: {
        hash: hash('a'),
        vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
        segments: [0, 0, 0, 0, 0, 1],
        texts: [{ s: 'A', p: [1, 0, 0], h: 0.5, r: 0, ax: 0, ay: 1 }],
      },
      [mid]: {
        hash: hash('b'),
        vertices: [0, 0, 5, 1, 0, 5, 0, 1, 5],
        indices: [0, 1, 2],
        segments: [],
        texts: [],
        children: [
          { definition: inner, transform: move(10, 0, 0) },
          { definition: inner, transform: turn(0, 5, 0) },
        ],
      },
      [outer]: {
        hash: hash('c'),
        vertices: [],
        indices: [],
        segments: [],
        texts: [],
        children: [
          { definition: mid, transform: identity() },
          { definition: mid, transform: scale2() },
        ],
      },
    },
  };
}

test('nested definitions expand once each, with composed transforms', () => {
  const { ids, definitions } = nestedDefinitions();
  const page = expandNestedDefinitions({ definitions });
  const outer = page.definitions[ids.outer],
    mid = page.definitions[ids.mid],
    inner = page.definitions[ids.inner];
  // Leaves are left as they came; expanded definitions keep the plugin's hash and lose `children`.
  assert.deepEqual(inner.vertices, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.equal(mid.hash, hash('b'));
  assert.equal(mid.children, undefined);
  assert.equal(outer.partial, undefined);
  // mid: own triangle + 2 inner triangles; outer: 2 mids.
  assert.equal(mid.vertices.length, 9 * 3);
  assert.equal(outer.vertices.length, 9 * 3 * 2);
  assert.equal(outer.indices.length, 3 * 3 * 2);
  assert.ok(outer.indices.every((index) => index < outer.vertices.length / 3));
  // Inner copy 2 in mid: turned 90° about Z then moved to (0,5,0): (1,0,0) → (0,6,0).
  near(at(mid.vertices, 7), [0, 6, 0], 'turned inner vertex');
  // Second mid in outer is scaled by 2: mid's inner copy 1 vertex (1,0,0)+(10,0,0) → (22,0,0).
  near(at(outer.vertices, 9 + 4), [22, 0, 0], 'scaled nested vertex');
  near(at(outer.vertices, 9), [0, 0, 10], 'scaled own vertex of the second mid');
  // Segments and labels follow: 2 inner copies × 2 mids.
  assert.equal(outer.segments.length, 6 * 4);
  assert.equal(outer.texts.length, 4);
  const turned = mid.texts[1];
  near(turned.p, [0, 6, 0], 'turned label point');
  assert.ok(Math.abs(turned.r - Math.PI / 2) < 1e-9);
  const scaled = outer.texts[3];
  assert.ok(Math.abs(scaled.h - 1) < 1e-9, 'label height follows the scale');
  // Each instance of the outer block sees the whole nested content.
  assert.deepEqual(
    displayCoverage(
      [
        {
          id: 'x',
          nativeType: 'InstanceReference',
          vertices: [],
          indices: [],
          line: [],
          valid: true,
          block: { definition: ids.outer },
        },
      ],
      page.definitions,
    ).omitted,
    0,
  );
});

test('an edited nested definition changes the expanded outer geometry', () => {
  const before = nestedDefinitions();
  // Same IDs, the inner definition edited (the plugin then sends new hashes up the chain).
  const edited = {
    ...structuredClone(before.definitions),
  };
  edited[before.ids.inner].vertices = [0, 0, 0, 3, 0, 0, 0, 3, 0];
  edited[before.ids.mid].hash = hash('d');
  edited[before.ids.outer].hash = hash('e');
  const a = expandNestedDefinitions({ definitions: structuredClone(before.definitions) });
  const b = expandNestedDefinitions({ definitions: edited });
  assert.notEqual(b.definitions[before.ids.outer].hash, a.definitions[before.ids.outer].hash);
  near(at(b.definitions[before.ids.outer].vertices, 4), [13, 0, 0], 'edited inner vertex');
  near(at(a.definitions[before.ids.outer].vertices, 4), [11, 0, 0], 'original inner vertex');
});

test('a missing nested definition or the size limit is marked partial and counted', () => {
  const { ids, definitions } = nestedDefinitions();
  delete definitions[ids.inner];
  const page = expandNestedDefinitions({ definitions });
  assert.equal(page.definitions[ids.mid].partial, true);
  assert.equal(page.definitions[ids.outer].partial, true);
  // The mid's own triangle is still there.
  assert.equal(page.definitions[ids.outer].vertices.length, 9 * 2);
  const row = {
    id: 'x',
    nativeType: 'InstanceReference',
    vertices: [],
    indices: [],
    line: [],
    valid: true,
    block: { definition: ids.outer },
  };
  assert.deepEqual(displayCoverage([row], page.definitions).omittedTypes, {
    [`InstanceReference${PARTIAL_BLOCK_TYPE_SUFFIX}`]: 1,
  });

  const limited = nestedDefinitions();
  const small = expandNestedDefinitions({ definitions: limited.definitions }, { limit: 40 });
  const outer = small.definitions[limited.ids.outer];
  assert.equal(outer.partial, true);
  assert.ok(outer.vertices.length + outer.segments.length <= 40);
});

test('typed pages expand to packed arrays that JSON-serialize as numbers', () => {
  const { ids, definitions } = nestedDefinitions();
  const page = expandNestedDefinitions({ definitions }, { typed: true });
  const outer = page.definitions[ids.outer];
  assert.ok(isPacked(outer.vertices) && isPacked(outer.segments));
  assert.ok(outer.indices instanceof Uint16Array);
  near(at(outer.vertices, 9 + 4), [22, 0, 0], 'packed nested vertex');
  const text = JSON.parse(JSON.stringify(outer));
  assert.ok(Array.isArray(text.vertices) && Array.isArray(text.indices));
});

/** A page with one outer block instance (the fixture's objects plus a nested block). */
function blockPage(definitions, outer) {
  const id = randomUUID();
  const page = displayPage([], 0, 1000);
  const object = { id, nativeId: id, kind: 'native', name: 'outer', origin: [0, 0, 0] };
  const row = {
    id,
    nativeId: id,
    nativeType: 'InstanceReference',
    geometryHash: hash('f'),
    name64: Buffer.from('outer').toString('base64'),
    origin: [0, 0, 0],
    boundsSize: [1, 1, 1],
    vertices: [],
    indices: [],
    line: [],
    area: null,
    volume: null,
    length: null,
    layer64: Buffer.from('Layer 01').toString('base64'),
    attributes64: [],
    attributesComplete: true,
    valid: true,
    block: { definition: outer, transform: move(100, 0, 0) },
  };
  return { object, row, page: { ...page, objects: [object], scene: [row], definitions } };
}

test('a binary display Sync of a nested block stores it expanded, not as a box', async () => {
  const { ids, definitions } = nestedDefinitions();
  const { page } = blockPage(definitions, ids.outer);
  page.coverage.total = page.coverage.displayed = 1;
  page.page = { offset: 0, nextOffset: 1, total: 1, revision: 7 };
  const plugin = await fakePlugin({ binary: true, answer: () => structuredClone(page) });
  try {
    for (const typed of [true, false]) {
      const model = await readScenePages(
        (params) => sendHostCommand('vide', params, { port: plugin.port, timeoutMs: 30000 }),
        {},
        Infinity,
        true,
        {},
        { binary: true, typed },
      );
      const outer = model.definitions[ids.outer];
      assert.equal(outer.vertices.length, 9 * 3 * 2);
      assert.equal(typed, isPacked(outer.vertices));
      assert.equal(model.scene[0].oversized, undefined);
      assert.equal(model.displayCoverage.omitted, 0);
      near(at(outer.vertices, 9 + 4), [22, 0, 0], 'stored nested vertex');
    }
  } finally {
    await plugin.close();
  }
});

test('a Live change page expands nested definitions too', async () => {
  const { ids, definitions } = nestedDefinitions();
  const { object, row } = blockPage(definitions, ids.outer);
  const methods = editorMethods(async (method, params = {}) => {
    if (method === 'inspectEditor')
      return {
        ok: true,
        documentId: 1,
        name: 'a.3dm',
        units: 'Meters',
        objectCount: 1,
        modified: false,
        documentHash: 'a'.repeat(64),
        revision: 8,
        selectedIds: [],
      };
    const result = {
      ...changesPage([{ object, scene: row }], [], 1),
      definitions: structuredClone(definitions),
    };
    return params.geometry === 'vgt1'
      ? decodeGeometry(encodeGeometry({ status: 'success', result }), { typed: true }).result
      : result;
  });
  const delta = await methods.displayChanges(7);
  const outer = delta.definitions[ids.outer];
  assert.ok(Array.isArray(outer.vertices));
  assert.equal(outer.vertices.length, 9 * 3 * 2);
  assert.equal(outer.children, undefined);
  near(at(outer.vertices, 9 + 4), [22, 0, 0], 'changed nested vertex');
});
