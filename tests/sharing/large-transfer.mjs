import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

export async function verifyLargeTransfer({ call, current, origin, alice, projectId }) {
  const base = `/api/projects/${projectId}/publications`,
    cookie = alice.cookie,
    results = [];
  const bytesFor = (total, index) =>
    Buffer.alloc(
      Math.min(8 * 1024 * 1024, total - index * 8 * 1024 * 1024),
      (index * 17 + total / 1048576) % 256,
    );
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  for (const mib of [100, 500]) {
    const total = mib * 1024 * 1024,
      parts = Array.from({ length: Math.ceil(mib / 8) }, (_, index) => {
        const bytes = bytesFor(total, index);
        return { size: bytes.length, sha256: hash(bytes) };
      });
    const prepared = await call(base, {
      method: 'POST',
      cookie,
      data: {
        requestId: randomUUID(),
        manifest: {
          title: mib + ' MiB transport fixture',
          objectIds: [],
          assets: [{ id: 'binary', parts }],
        },
      },
    });
    assert.equal(prepared.status, 201);
    const id = prepared.value.id;
    const started = performance.now();
    for (let index = 0; index < parts.length; index++) {
      const bytes = bytesFor(total, index),
        response = await current().dispatchFetch(
          origin + base + '/' + id + '/assets/binary/' + index,
          {
            method: 'PUT',
            headers: { Origin: origin, Cookie: cookie, 'Content-Length': String(bytes.length) },
            body: bytes,
          },
        );
      assert.equal(response.status, 200, await response.text());
    }
    const uploaded = performance.now(),
      published = await call(base + '/' + id + '/finalize', { method: 'POST', cookie, data: {} });
    assert.equal(published.status, 200, JSON.stringify(published));
    const finalized = performance.now();
    for (let index = 0; index < parts.length; index++) {
      const response = await current().dispatchFetch(
        origin + base + '/' + id + '/assets/binary/' + index,
        { headers: { Cookie: cookie } },
      );
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, parts[index].size);
      assert.equal(hash(bytes), parts[index].sha256);
    }
    results.push({
      mib,
      chunks: parts.length,
      uploadMs: Math.round(uploaded - started),
      finalizeMs: Math.round(finalized - uploaded),
      readAndHashMs: Math.round(performance.now() - finalized),
      errors: 0,
    });
  }
  return {
    largeTransfer: results,
    largeTransferScope:
      'synthetic binary assets over loopback, not 3D rendering or remote performance',
  };
}
