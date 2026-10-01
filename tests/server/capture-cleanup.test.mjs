import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, symlink, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CopyFiles, sweepCopies } from '../../src/server/capture-cleanup.ts';

const DAY = 86_400_000;
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
async function file(path, age = 0, text = 'x') {
  await writeFile(path, text);
  const at = new Date(Date.now() - age);
  await utimes(path, at, at);
}
async function aged(path, age) {
  const at = new Date(Date.now() - age);
  await utimes(path, at, at);
}

// PLAN-27 T-087 (2026-10-01): VIDE's own copies go when stale; nothing outside its folders,
// nothing through a link or junction, nothing unfinished work or an open editor still uses.
test('engine start removes stale captures, ended sessions and work folders only', async () => {
  const data = await mkdtemp(join(tmpdir(), 'vide-sweep-'));
  const outside = await mkdtemp(join(tmpdir(), 'vide-outside-'));
  try {
    const connections = join(data, 'rhino-connections'),
      models = join(data, 'sdk-models');
    await mkdir(connections);
    await mkdir(models);
    // A running session (its .json is there): old copies go, a fresh one and a used one stay.
    const live = randomUUID();
    await mkdir(join(connections, live));
    await file(join(connections, live + '.json'));
    const old = join(connections, live, randomUUID() + '.3dm');
    await file(old, 2 * DAY);
    await file(old + '.capture.json', 2 * DAY);
    const fresh = join(connections, live, randomUUID() + '.3dm');
    await file(fresh, 1000);
    const used = join(connections, live, randomUUID() + '.3dm');
    await file(used + '.capture.json', 2 * DAY);
    await file(join(connections, live, 'notes.txt'), 2 * DAY);
    // Ended sessions: an empty old folder goes; one created a moment ago stays.
    const ended = randomUUID(),
      starting = randomUUID(),
      endedWithCopy = randomUUID();
    await mkdir(join(connections, ended));
    await aged(join(connections, ended), 2 * DAY);
    await mkdir(join(connections, starting));
    await mkdir(join(connections, endedWithCopy));
    await file(join(connections, endedWithCopy, randomUUID() + '.3dm'), 2 * DAY);
    await aged(join(connections, endedWithCopy), 2 * DAY);
    // A junction posing as a session folder points outside: never followed.
    const outsideCopy = join(outside, randomUUID() + '.3dm');
    await file(outsideCopy, 2 * DAY);
    const junction = randomUUID();
    await symlink(outside, join(connections, junction), 'junction');
    // Work folders.
    const stale = join(models, randomUUID()),
      recent = join(models, randomUUID()),
      editor = join(models, randomUUID()),
      running = join(models, randomUUID()),
      unsettled = join(models, randomUUID());
    for (const folder of [stale, recent, editor, running, unsettled]) await mkdir(folder);
    await file(join(stale, 'source.3dm'), 2 * DAY);
    await file(join(stale, 'ready.json'), 2 * DAY, JSON.stringify({ pid: 999001 }));
    await aged(stale, 2 * DAY);
    await file(join(recent, 'source.3dm'), 1000);
    const editorSession = randomUUID();
    await file(
      join(editor, 'ready.json'),
      2 * DAY,
      JSON.stringify({ pid: 999002, sessionId: editorSession }),
    );
    await aged(editor, 2 * DAY);
    await writeFile(
      models + '.editors.json',
      JSON.stringify([{ identity: { sessionId: editorSession } }]),
    );
    await file(join(running, 'ready.json'), 2 * DAY, JSON.stringify({ pid: 999003 }));
    await aged(running, 2 * DAY);
    await file(join(unsettled, 'op.3dm'), 2 * DAY);
    await aged(unsettled, 2 * DAY);
    const outsideFolder = randomUUID();
    await symlink(outside, join(models, outsideFolder), 'junction');

    const swept = await sweepCopies({
      connections,
      models,
      keep: [used, join(unsettled, 'op.3dm')],
      alive: (pid) => pid === 999003,
    });

    assert.equal(await exists(old), false);
    assert.equal(await exists(old + '.capture.json'), false);
    assert.equal(await exists(fresh), true);
    assert.equal(await exists(used + '.capture.json'), true);
    assert.equal(await exists(join(connections, live, 'notes.txt')), true);
    assert.equal(await exists(join(connections, live)), true);
    assert.equal(await exists(join(connections, ended)), false);
    assert.equal(await exists(join(connections, starting)), true);
    assert.equal(await exists(join(connections, endedWithCopy)), false);
    assert.equal(await exists(outsideCopy), true);
    assert.equal(await exists(join(connections, junction)), true);
    assert.equal(await exists(stale), false);
    for (const folder of [recent, editor, running, unsettled])
      assert.equal(await exists(folder), true);
    assert.equal(await exists(join(models, outsideFolder)), true);
    assert.deepEqual(await readdir(outside), [outsideCopy.split(/[\\/]/).at(-1)]);
    assert.equal(swept.captures, 3);
    assert.equal(swept.directories, 1);
    assert.equal(swept.sessions, 2);
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a single copy is deleted only inside the roots and never through a junction', async () => {
  const data = await mkdtemp(join(tmpdir(), 'vide-copies-'));
  const outside = await mkdtemp(join(tmpdir(), 'vide-outside-'));
  try {
    const connections = join(data, 'rhino-connections');
    await mkdir(join(connections, 'session'), { recursive: true });
    const copies = new CopyFiles([connections, join(data, 'sdk-models')]);
    const capture = join(connections, 'session', randomUUID() + '.3dm');
    await file(capture);
    await file(capture + '.capture.json');
    // The copy goes after the import; the receipt stays until the application settles.
    assert.equal(await copies.removeCapture(capture, { copy: true }), 1);
    assert.equal(await exists(capture), false);
    assert.equal(await exists(capture + '.capture.json'), true);
    assert.equal(await copies.removeCapture(capture, { copy: true, receipt: true }), 1);
    assert.equal(await exists(capture + '.capture.json'), false);
    // Outside the roots, a name that is not a capture, or through a junction: refused.
    const foreign = join(outside, randomUUID() + '.3dm');
    await file(foreign);
    assert.equal(await copies.removeCapture(foreign, { copy: true }), 0);
    const named = join(connections, 'session', 'model.3dm');
    await file(named);
    assert.equal(await copies.removeCapture(named, { copy: true }), 0);
    await symlink(outside, join(connections, 'linked'), 'junction');
    assert.equal(
      await copies.removeCapture(join(connections, 'linked', foreign.split(/[\\/]/).at(-1)), {
        copy: true,
      }),
      0,
    );
    assert.equal(await exists(foreign), true);
    assert.equal(await exists(named), true);
    assert.equal(await copies.removeDirectory(outside), false);
    assert.equal(await copies.removeDirectory(join(data, 'sdk-models')), false);
    const work = join(data, 'sdk-models', randomUUID());
    await mkdir(work, { recursive: true });
    await file(join(work, 'source.3dm'));
    assert.equal(await copies.removeDirectory(work), true);
    assert.equal(await exists(work), false);
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
