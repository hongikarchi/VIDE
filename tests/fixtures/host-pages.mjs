// A synthetic Rhino document and a fake attached plugin that answers `displayPage` and
// `displayChanges` over the real framed loopback transport (T-128). `binary: true` plays the
// current plugin (a VGT1 frame when the engine asks with `geometry: 'vgt1'`); `binary: false`
// plays an older plugin that ignores the flag and answers JSON text.
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { encodeGeometry } from '../../src/contracts/geometry-transfer.ts';

// Coordinates as the plugin sends them: display meters rounded to 1 µm.
const round = (value) => Math.round(value * 1e6) / 1e6;
const hash = () => randomUUID().replaceAll('-', '').repeat(2);

/**
 * Of every five objects: three box meshes (24 vertices, 12 triangles), one 32-sided cylinder mesh
 * (132 vertices, 128 triangles) and one 129-point curve, at kilometre-scale coordinates.
 */
export function syntheticObject(i) {
  const id = randomUUID();
  const x = 1000 + (i % 100) * 7.3,
    y = 2000 + Math.floor(i / 100) * 5.1,
    z = (i % 7) * 3.2;
  const curve = i % 5 === 4;
  const vertices = [],
    indices = [],
    line = [];
  if (curve)
    for (let k = 0; k <= 128; k++)
      line.push(round(x + k * 0.031), round(y + Math.sin(k / 9) * 0.7), round(z + k * 0.0017));
  else if (i % 5 === 3) {
    // Side quads (2 rings of 33) and two caps (centre + ring of 32).
    for (const h of [0, 3.1])
      for (let k = 0; k <= 32; k++)
        vertices.push(
          round(x + 0.25 * Math.cos((k * Math.PI) / 16)),
          round(y + 0.25 * Math.sin((k * Math.PI) / 16)),
          round(z + h),
        );
    for (let k = 0; k < 32; k++) indices.push(k, k + 1, k + 34, k, k + 34, k + 33);
    for (const h of [0, 3.1]) {
      const centre = vertices.length / 3;
      vertices.push(round(x), round(y), round(z + h));
      for (let k = 0; k < 32; k++)
        vertices.push(
          round(x + 0.25 * Math.cos((k * Math.PI) / 16)),
          round(y + 0.25 * Math.sin((k * Math.PI) / 16)),
          round(z + h),
        );
      for (let k = 0; k < 32; k++)
        indices.push(centre, centre + 1 + k, centre + 1 + ((k + 1) % 32));
    }
  } else {
    for (let face = 0; face < 6; face++)
      for (let corner = 0; corner < 4; corner++)
        vertices.push(
          round(x + (corner & 1) * 0.613 + face * 0.0001),
          round(y + ((corner >> 1) & 1) * 0.457),
          round(z + (face % 2) * 2.95 + corner * 0.000123),
        );
    for (let face = 0; face < 6; face++) {
      const at = face * 4;
      indices.push(at, at + 1, at + 2, at, at + 2, at + 3);
    }
  }
  return {
    object: { id, nativeId: id, kind: 'native', name: `o${i}`, origin: [x, y, z] },
    scene: {
      id,
      nativeId: id,
      nativeType: curve ? 'Curve' : 'Brep',
      geometryHash: hash(),
      name64: Buffer.from(`o${i}`).toString('base64'),
      origin: [x, y, z],
      boundsSize: [0.613, 0.457, 2.95],
      vertices,
      indices,
      line,
      area: null,
      volume: null,
      length: null,
      layer64: Buffer.from('Layer 01').toString('base64'),
      attributes64: [],
      attributesComplete: true,
      valid: true,
      displayColor: '#000000',
      layerColor: '#000000',
      materialColor: null,
    },
  };
}

export function syntheticDocument(count) {
  return Array.from({ length: count }, (_, i) => syntheticObject(i));
}

const survey = (total) => ({
  coverage: {
    total,
    displayed: total,
    omittedHidden: 0,
    omittedFiltered: 0,
    omittedBlockInternal: 0,
    hiddenLayers: [],
  },
  layers: [],
});

/** One `displayPage` reply body (the page object the plugin writes). */
export function displayPage(items, offset, limit, revision = 7) {
  const slice = items.slice(offset, offset + limit);
  return {
    objects: slice.map((item) => item.object),
    scene: slice.map((item) => item.scene),
    definitions: {},
    removed: [],
    measurementVersion: 1,
    measurementStats: { measuredObjects: 0, reusedObjects: 0 },
    ...survey(items.length),
    page: { offset, nextOffset: offset + slice.length, total: items.length, revision },
  };
}

/** One `displayChanges` reply body. */
export function changesPage(changed, removed, total, revision = 8) {
  return {
    objects: changed.map((item) => item.object),
    scene: changed.map((item) => item.scene),
    definitions: {},
    removed,
    measurementVersion: 1,
    measurementStats: { measuredObjects: 0, reusedObjects: 0 },
    ...survey(total),
    page: {
      cursor: 0,
      nextCursor: changed.length + removed.length,
      changes: changed.length + removed.length,
      total,
      revision,
    },
  };
}

/** The reply frame body: VGT1 when the plugin is binary and the engine asked, else JSON text. */
export function replyBody(result, binary, params) {
  if (binary && params.geometry === 'vgt1')
    return Buffer.from(encodeGeometry({ status: 'success', result }));
  return Buffer.from(JSON.stringify({ status: 'success', result }));
}

/**
 * A loopback plugin answering framed requests with `answer(params)` → result object. Returns the
 * port, the bytes of every reply body and `close()`.
 */
export async function fakePlugin({ binary, answer, cache = false }) {
  const replies = [];
  // `cache`: each distinct request's reply is built once, so a second read times the engine only.
  const built = new Map();
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) return;
      const { params } = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      const key = JSON.stringify(params);
      const body = (cache && built.get(key)) || replyBody(answer(params), binary, params);
      if (cache) built.set(key, body);
      replies.push(body.length);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      socket.end(Buffer.concat([header, body]));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    replies,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
