import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDevBuild,
  restorePluginRegistration,
  withInstalledPluginRestored,
} from '../integration/plugin-guard.mjs';

const INSTALLED =
  'C:\\Users\\u\\AppData\\Local\\VIDE\\plugins\\rhino\\0.2.35-cfa0ac11\\VIDE.Worker.rhp';
const DEV =
  'C:\\Users\\u\\Desktop\\Vino-IDE\\.vide\\build\\rhino-worker\\bin\\net8.0-windows\\VIDE.Worker.rhp';

/** A fake registry plus engine; `engine` decides what the installed engine's install does. */
function fake(initial, engine = () => ({ restored: false, status: 'unreachable' })) {
  const state = { value: initial, writes: [], engineCalls: 0, failed: 0, lines: [] };
  const deps = {
    read: async () => state.value,
    write: async (path) => {
      state.writes.push(path);
      state.value = path;
    },
    engineRestore: async () => {
      state.engineCalls++;
      return engine(state);
    },
    log: (line) => state.lines.push(line),
    fail: () => state.failed++,
  };
  return { state, deps };
}

test('isDevBuild matches .vide/build paths only', () => {
  assert.equal(isDevBuild(DEV), true);
  assert.equal(isDevBuild('C:/repo/.vide/build/rhino-panel/bin/VIDE.Worker.rhp'), true);
  assert.equal(isDevBuild(INSTALLED), false);
  assert.equal(isDevBuild(null), false);
});

test('unchanged registration: no engine call, no write', async () => {
  const { state, deps } = fake(INSTALLED);
  const result = await withInstalledPluginRestored(async () => 7, deps);
  assert.equal(result, 7);
  assert.equal(state.engineCalls, 0);
  assert.deepEqual(state.writes, []);
  assert.equal(state.failed, 0);
  assert.ok(state.lines.some((l) => l.includes('unchanged')));
});

test('dev load restored by the installed engine', async () => {
  const { state, deps } = fake(INSTALLED, (s) => {
    s.value = INSTALLED;
    return { restored: true, status: 200, plugin: 'current' };
  });
  await withInstalledPluginRestored(async () => {
    state.value = DEV; // LoadPlugIn of the dev build
  }, deps);
  assert.equal(state.engineCalls, 1);
  assert.deepEqual(state.writes, []);
  assert.equal(state.value, INSTALLED);
  assert.equal(state.failed, 0);
});

test('engine unreachable or refused (409): the recorded FileName is written back', async () => {
  const { state, deps } = fake(INSTALLED, () => ({ restored: false, pending: true, status: 409 }));
  await withInstalledPluginRestored(async () => {
    state.value = DEV;
  }, deps);
  assert.equal(state.engineCalls, 1);
  assert.deepEqual(state.writes, [INSTALLED]);
  assert.equal(state.value, INSTALLED);
  assert.equal(state.failed, 0);
  assert.ok(state.lines.some((l) => l.includes('registry')));
});

test('restores even when the body throws, and rethrows', async () => {
  const { state, deps } = fake(INSTALLED, () => {
    throw new Error('ECONNREFUSED');
  });
  await assert.rejects(
    withInstalledPluginRestored(async () => {
      state.value = DEV;
      throw new Error('test failed');
    }, deps),
    /test failed/,
  );
  assert.equal(state.value, INSTALLED);
  assert.equal(state.failed, 0);
});

test('engine says restored but registry still on dev: falls back to the registry', async () => {
  const { state, deps } = fake(INSTALLED, () => ({ restored: true, status: 200 }));
  await withInstalledPluginRestored(async () => {
    state.value = DEV;
  }, deps);
  assert.deepEqual(state.writes, [INSTALLED]);
  assert.equal(state.value, INSTALLED);
});

test('nothing installed to go back to: reported as failed', async () => {
  const { state, deps } = fake(null);
  await withInstalledPluginRestored(async () => {
    state.value = DEV;
  }, deps);
  assert.deepEqual(state.writes, []);
  assert.equal(state.failed, 1);
  const again = await restorePluginRegistration(DEV, deps);
  assert.equal(again.action, 'failed');
});
