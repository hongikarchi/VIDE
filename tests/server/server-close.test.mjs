import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import {
  analysisWorkerStats,
  analyzeSummary,
  buildFrameModel,
} from '../../src/jigs/official/structure-analysis/index.ts';
import { gridPlan } from '../structure/frame-fixtures.mjs';

// Closing an engine stops what it started: the structure analysis worker (per process) and the
// jig runtime's runners, so a test process never exits with a worker or child still running.
// Synthetic frame only.

const engine = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-close-'));
  const app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    host: { status: async () => ({ available: true }) },
  });
  return { app, directory };
};

const analyse = async () => {
  const { model, map } = buildFrameModel(gridPlan({ nx: 3, ny: 3 }));
  try {
    return await analyzeSummary(model, map, { mode: 'preview', key: 'close', stability: false });
  } catch (error) {
    if (error.code === 'STRUCTURE_CORE_MISSING') return undefined;
    throw error;
  }
};

test('closing the engine stops an idle structure worker; a later analysis starts a new one', async (t) => {
  const { app, directory } = await engine();
  try {
    const first = await analyse();
    if (!first) return t.skip('structure core is not built');
    assert.equal(first.summary.status, 'ok');
    assert.equal(analysisWorkerStats().alive, true);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
  const after = analysisWorkerStats();
  assert.equal(after.alive, false, 'the worker is stopped with the engine');
  assert.equal(after.closing, 0);
  const again = await analyse();
  assert.equal(again.summary.status, 'ok');
  // A second engine closing without analysis work of its own still leaves nothing running.
  const second = await engine();
  await second.app.close();
  await rm(second.directory, { recursive: true, force: true });
  assert.equal(analysisWorkerStats().alive, false);
});

test("closing one engine leaves another engine's running analysis alone", async (t) => {
  const a = await engine();
  const b = await engine();
  try {
    const { model, map } = buildFrameModel(gridPlan({ nx: 6, ny: 6 }));
    const running = analyzeSummary(model, map, {
      mode: 'preview',
      key: 'other-engine',
      stability: false,
    }).catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    const busy = analysisWorkerStats().running;
    await a.app.close();
    const out = await running;
    if (out instanceof Error && out.code === 'STRUCTURE_CORE_MISSING')
      return t.skip('structure core is not built');
    if (busy) assert.equal(out.summary?.status, 'ok', 'the running analysis is not cancelled');
  } finally {
    await b.app.close();
    await rm(a.directory, { recursive: true, force: true });
    await rm(b.directory, { recursive: true, force: true });
  }
  assert.equal(analysisWorkerStats().alive, false);
});
