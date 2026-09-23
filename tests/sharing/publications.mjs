import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPublicationBundle } from '../../src/core/publication.ts';

export async function verifyPublications({
  call,
  mf,
  db,
  alice,
  bob,
  eve,
  projectId,
  invite,
  accept,
  origin,
}) {
  await accept(bob, await invite(bob.email, 'viewer'));
  const bundle = createPublicationBundle(
    {
      id: 'local-work',
      state: 'succeeded',
      input: { body: 'PRIVATE instructions' },
      result: {
        verified: true,
        sourceDocument: {
          name: 'PRIVATE.3dm',
          instance: 'PRIVATE',
          documentId: 1,
          capturedAt: 'today',
          path: 'C:/PRIVATE/model.3dm',
        },
        objects: [{ id: 'object-1', name: 'PRIVATE name', kind: 'Brep', nativeId: 'PRIVATE-guid' }],
        scene: [
          {
            id: 'object-1',
            vertices: [0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0, 0, 0, 5, 4, 0, 5, 4, 3, 5, 0, 3, 5],
            indices: [
              0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7,
              6, 3, 0, 4, 3, 4, 7,
            ],
            nativeId: 'PRIVATE-guid',
          },
        ],
      },
    },
    { title: 'Public model', objectIds: ['object-1'] },
  );
  const bytes = Buffer.concat(bundle.chunks);
  assert.doesNotMatch(bytes.toString(), /PRIVATE/);
  const base = `/api/projects/${projectId}/publications`;
  const manifest = bundle.manifest;
  const prepare = async (requestId = randomUUID(), payload = manifest) =>
    call(base, { method: 'POST', cookie: alice.cookie, data: { requestId, manifest: payload } });
  const requestId = randomUUID(),
    first = await prepare(requestId);
  assert.equal(first.status, 201, JSON.stringify(first));
  const id = first.value.id;
  const again = await prepare(requestId);
  assert.equal(again.value.id, id);
  assert.equal((await prepare(requestId, { ...manifest, title: 'Other' })).status, 409);
  assert.equal((await prepare(randomUUID(), { ...manifest, localPath: 'private' })).status, 400);
  assert.equal((await call(base + '/' + id, { cookie: bob.cookie })).status, 404);
  const finish = (id) =>
    call(base + '/' + id + '/finalize', { method: 'POST', cookie: alice.cookie, data: {} });
  const upload = async (id, data = bytes, cookie = alice.cookie) => {
    const r = await mf.dispatchFetch(origin + base + '/' + id + '/assets/scene/0', {
      method: 'PUT',
      body: data,
      headers: { Origin: origin, Cookie: cookie, 'Content-Length': String(data.length) },
    });
    return { status: r.status, value: await r.json() };
  };
  assert.equal((await finish(id)).status, 409);
  assert.equal((await call(base + '/current', { cookie: alice.cookie })).status, 404);
  assert.equal((await upload(id, Buffer.alloc(bytes.length, 120))).status, 422);
  assert.equal((await upload(id)).status, 200);
  assert.equal((await upload(id)).status, 200);
  assert.equal((await finish(id)).status, 200);
  assert.equal((await finish(id)).status, 200);
  assert.equal((await call(base + '/current', { cookie: bob.cookie })).value.id, id);
  const commentId = randomUUID(),
    comment = { submissionId: commentId, body: 'Keep this object', objectId: 'object-1' };
  const submit = (publication, payload = comment, cookie = bob.cookie) =>
    call(base + '/' + publication + '/comments', { method: 'POST', cookie, data: payload });
  assert.equal((await submit(id)).status, 403);
  await call(`/api/projects/${projectId}/members/${bob.id}`, {
    method: 'PATCH',
    cookie: alice.cookie,
    data: { role: 'commenter' },
  });
  const comments = await Promise.all([submit(id), submit(id)]);
  for (const comment of comments) assert.equal(comment.status, 201, JSON.stringify(comment));
  assert.equal(comments[0].value.id, comments[1].value.id);
  const exportPath = base + '/' + id + '/comments/' + comments[0].value.id + '/export';
  assert.equal((await call(exportPath, { cookie: bob.cookie })).status, 403);
  const exportedComment = await call(exportPath, { cookie: alice.cookie });
  assert.equal(exportedComment.status, 200);
  assert.equal(exportedComment.value.exportId, requestId);
  assert.deepEqual(exportedComment.value.comment.input, {
    body: comment.body,
    objectId: comment.objectId,
  });
  assert.equal((await submit(id, { ...comment, body: 'Changed' })).status, 409);
  assert.equal(
    (await submit(id, { ...comment, submissionId: randomUUID(), objectId: 'hidden-object' }))
      .status,
    400,
  );
  const spatial = {
    submissionId: randomUUID(),
    body: '',
    objectId: 'object-1',
    pin: { unit: 'm', position: [1, 2, 3] },
    sketches: [
      {
        plane: 'XZ',
        unit: 'm',
        role: 'direction',
        points: [
          [1, 3],
          [4, 5],
        ],
      },
    ],
  };
  const spatialResult = await submit(id, spatial);
  assert.equal(spatialResult.status, 201, JSON.stringify(spatialResult));
  assert.deepEqual(spatialResult.value.input.pin, spatial.pin);
  assert.deepEqual(spatialResult.value.input.sketches, spatial.sketches);
  assert.equal(
    (
      await submit(id, {
        ...spatial,
        submissionId: randomUUID(),
        pin: { unit: 'px', position: [1, 2, 3] },
      })
    ).status,
    400,
  );
  let r = await mf.dispatchFetch(origin + base + '/' + id + '/assets/scene/0', {
    headers: { Cookie: bob.cookie },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.equal(
    (await call(base + '/' + id + '/assets/scene/0', { cookie: eve.cookie })).status,
    404,
  );
  assert.equal((await upload(id)).status, 409);
  const second = (await prepare()).value.id,
    stale = (await prepare()).value.id;
  assert.equal((await finish(second)).status, 409);
  assert.equal((await call(base + '/current', { cookie: bob.cookie })).value.id, id);
  await upload(second);
  assert.equal((await finish(second)).status, 200);
  await upload(stale);
  assert.equal((await finish(stale)).value.error, 'PUBLICATION_BASE_CHANGED');
  assert.equal((await call(base + '/current', { cookie: bob.cookie })).value.id, second);
  assert.equal((await call(base + '/' + id, { cookie: bob.cookie })).status, 404);
  assert.equal((await call(base + '/' + id + '/comments', { cookie: bob.cookie })).status, 404);
  assert.equal(
    (await call(base + '/' + id + '/assets/scene/0', { cookie: bob.cookie })).status,
    404,
  );
  assert.equal(
    (
      await call(base + '/' + id + '/history-access', {
        method: 'PATCH',
        cookie: alice.cookie,
        data: { shared: true },
      })
    ).status,
    200,
  );
  assert.equal((await call(base + '/' + id, { cookie: bob.cookie })).status, 200);
  const original = await call(base + '/' + id + '/comments', { cookie: bob.cookie });
  assert.equal(original.value.comments.length, 2);
  assert.equal(original.value.comments[0].publicationId, id);
  assert.equal((await submit(second)).status, 409);
  // A lost finalization response can be retried without reverting the newer publication.
  assert.equal((await finish(id)).status, 200);
  assert.equal((await call(base + '/current', { cookie: bob.cookie })).value.id, second);
  await call(`/api/projects/${projectId}/members/${bob.id}`, {
    method: 'DELETE',
    cookie: alice.cookie,
  });
  assert.equal(
    (await call(base + '/' + second + '/assets/scene/0', { cookie: bob.cookie })).status,
    404,
  );
  assert.equal(
    (
      await db
        .prepare('SELECT count(*) n FROM publications WHERE project_id=? AND state=?')
        .bind(projectId, 'published')
        .first()
    ).n,
    2,
  );
  assert.equal((await submit(second, { ...comment, submissionId: randomUUID() })).status, 404);
  return {
    r2VerifiedUpload: true,
    incompletePublishPreservesPrevious: true,
    stalePublishRejected: true,
    explicitHistoryAccess: true,
    fileAccessRevoked: true,
    commentsIdempotent: true,
    commentPublicationPreserved: true,
  };
}
