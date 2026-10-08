// PLAN-49 T-260: the read template `vide.read.curves@1` (타일 곡선·어트랙터, SPEC-16.13) against a
// real hidden Rhino 8 — a VIDE-owned worker makes synthetic points and curves in a new millimetre
// document under .vide/tests/paneling-curves/ and runs the read body on it. Never a user document,
// never the user's Rhino; only this script's process is stopped. Afterwards the installed engine's
// connector status is read (the plugin re-installed only when it is not current and no Rhino runs).
//
//   node tests/integration/rhino-paneling-curves.mjs
//
// Checks: the body compiles and runs in the worker wrapper; points and polylines come back in
// metres (× the document's toMeters), closed curves without the repeated end point, an arc as a polyline within the
// tolerance, `flatXY` false for a tilted curve; the answer decodes into a `CurveSet` the tile rule
// takes (two flat closed curves) or refuses (open, tilted); a surface is refused `NOT_A_CURVE`.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { curvesReadBody, decodeCurveSet } from '../../src/server/paneling-curves.ts';
import { tileFromCurves } from '../../src/jigs/official/paneling-kit/tile.ts';

const options0 = sdkOptions('.');
if (!existsSync(options0.executable) || !existsSync(options0.plugin)) {
  console.log(
    `skipped: Rhino 8 (${options0.executable}) or the plugin (${options0.plugin}) is not available`,
  );
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = resolve('.vide/tests/paneling-curves', stamp);
await mkdir(directory, { recursive: true });
const options = sdkOptions(directory);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Synthetic objects in the worker's new document (its own units; the read scales by toMeters): two 400 mm squares (a tile), a point, an open line, a
// circle (closed, not a polyline), a tilted square and a plane surface. No project data.
const BUILD = `var ids = new System.Collections.Generic.Dictionary<string, string>();
Polyline Square(double x, double y, double s, double z) { return new Polyline(new[] { new Point3d(x, y, z), new Point3d(x + s, y, z), new Point3d(x + s, y + s, z), new Point3d(x, y + s, z), new Point3d(x, y, z) }); }
ids["a"] = doc.Objects.AddPolyline(Square(0, 0, 400, 100)).ToString();
ids["b"] = doc.Objects.AddPolyline(Square(500, 0, 400, 100)).ToString();
ids["point"] = doc.Objects.AddPoint(new Point3d(1000, 2000, 3000)).ToString();
ids["line"] = doc.Objects.AddLine(new Line(new Point3d(0, 0, 0), new Point3d(1000, 0, 0))).ToString();
ids["circle"] = doc.Objects.AddCircle(new Circle(new Point3d(0, 0, 0), 300)).ToString();
var tilted = new Polyline(new[] { new Point3d(0, 0, 0), new Point3d(400, 0, 0), new Point3d(400, 400, 200), new Point3d(0, 400, 200), new Point3d(0, 0, 0) });
ids["tilted"] = doc.Objects.AddPolyline(tilted).ToString();
ids["surface"] = doc.Objects.AddSurface(new PlaneSurface(Plane.WorldXY, new Interval(0, 100), new Interval(0, 100))).ToString();
return ids;`;

async function installedConnectors({ install = false } = {}) {
  const launch = JSON.parse(
    await readFile(join(process.env.LOCALAPPDATA ?? '', 'VIDE', 'launch.json'), 'utf8'),
  );
  const url = new URL(launch.url);
  const origin = url.origin;
  const session = await fetch(new URL('/api/v1/session', origin), {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: url.hash.slice(1) }),
    signal: AbortSignal.timeout(5000),
  });
  const cookie = session.headers.get('set-cookie')?.split(';')[0];
  if (!session.ok || !cookie) return { ok: false, status: session.status };
  const headers = { Origin: origin, Cookie: cookie };
  let installed;
  if (install) {
    const r = await fetch(new URL('/api/v1/connectors/rhino8/install', origin), {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(60000),
    });
    installed = { status: r.status };
  }
  const list = await fetch(new URL('/api/v1/connectors', origin), {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  const body = await list.json();
  return {
    installed,
    rhino8: (body.connectors ?? body).find((c) => c.id === 'rhino8')?.plugin ?? null,
  };
}

let worker;
const result = { directory };
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'worker') });
  const built = await worker.execute(randomUUID(), 0, BUILD);
  assert.equal(built.ok, true, JSON.stringify(built).slice(0, 1500));
  const ids = built.value;
  // The worker counts every execute as a revision; each read goes on from the last one.
  let revision = built.revision;
  const read = async (keys) => {
    const t = performance.now();
    const answer = await worker.execute(
      randomUUID(),
      revision,
      curvesReadBody(keys.map((k) => ids[k])),
    );
    if (typeof answer.revision === 'number') revision = answer.revision;
    log('read', keys.join(','), Math.round(performance.now() - t), 'ms');
    return answer;
  };
  const source = { linkId: 'worker', documentKey: 'worker', readAt: new Date().toISOString() };

  // 1. The tile: two flat closed squares, metres, no repeated end point.
  const tileAnswer = await read(['a', 'b']);
  assert.equal(tileAnswer.ok, true, JSON.stringify(tileAnswer).slice(0, 1500));
  const tileSet = decodeCurveSet(tileAnswer.value, source);
  const k = tileSet.source.toMeters;
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9 * Math.max(1, Math.abs(b[i])));
  assert.deepEqual(
    tileSet.items.map((i) => [i.kind, i.closed, i.flatXY, i.points.length]),
    [
      ['polyline', true, true, 4],
      ['polyline', true, true, 4],
    ],
  );
  assert.ok(near(tileSet.items[0].points[2], [400 * k, 400 * k, 100 * k]));
  const tile = tileFromCurves(tileSet);
  assert.ok(near(tile.size, [900 * k, 400 * k]));
  result.tile = { pieces: tile.pieces.length, size: tile.size };

  // 2. Attractors: a point, an open line, a circle as a polyline within the tolerance.
  const att = await read(['point', 'line', 'circle']);
  assert.equal(att.ok, true, JSON.stringify(att).slice(0, 1500));
  const attSet = decodeCurveSet(att.value, source);
  assert.ok(near(attSet.items[0].points[0], [1000 * k, 2000 * k, 3000 * k]));
  assert.equal(attSet.items[1].closed, false);
  assert.equal(attSet.items[2].closed, true);
  const circle = attSet.items[2].points;
  assert.ok(circle.length >= 16, `circle points ${circle.length}`);
  for (const p of circle) assert.ok(Math.abs(Math.hypot(p[0], p[1]) - 300 * k) < 1e-6 * 300 * k);
  result.attractors = attSet.items.map((i) => [i.kind, i.closed, i.points.length]);

  // 3. Not a tile: open, tilted. Not a curve: a surface.
  assert.throws(() => tileFromCurves(attSet), /닫힌 곡선/);
  const tiltedAnswer = await read(['tilted']);
  assert.equal(decodeCurveSet(tiltedAnswer.value, source).items[0].flatXY, false);
  assert.throws(() => tileFromCurves(decodeCurveSet(tiltedAnswer.value, source)), /평면 XY/);
  const surface = await read(['surface']);
  assert.equal(surface.ok, false);
  // The worker keeps the exception text in its diagnostic file (the attached path returns it).
  const why =
    surface.message ??
    (await readFile(join(directory, 'worker', `${surface.diagnosticId}.diagnostic.txt`), 'utf8'));
  assert.match(why, /NOT_A_CURVE: /);
  result.passed = true;
  log('passed');
} finally {
  await worker?.stop().catch(() => {});
  try {
    let status = await installedConnectors();
    let running = false;
    try {
      running = /Rhino\.exe/i.test(
        execSync('tasklist /FI "IMAGENAME eq Rhino.exe" /NH', { encoding: 'utf8' }),
      );
    } catch {}
    if (status.rhino8 && status.rhino8 !== 'current' && !running)
      status = await installedConnectors({ install: true });
    result.connectors = { ...status, rhinoRunning: running };
  } catch (error) {
    result.connectors = { error: String(error) };
  }
  console.log('installed connectors: ' + JSON.stringify(result.connectors));
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
}
