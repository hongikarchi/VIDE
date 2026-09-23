import { inspectDwg } from '../../hosts/zwcad/inspector.ts';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { ZwcadWorkspace } from '../../hosts/zwcad/workspace.ts';
if (process.argv[2] !== '--run-live' || !process.argv[3])
  throw Error('Pass --run-live and a synthetic DWG');
const host = new ZwcadWorkspace('.vide/dwg-edit-check'),
  project = randomUUID(),
  source = process.argv[3];
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const original = await hash(source);
const baseline = await host.importFile(project, randomUUID(), source);
assert.equal(baseline.dwgEditMode, 'polyline-vertices-v1');
const objects = structuredClone(baseline.objects);
assert.equal(objects.length, 1);
objects[0].points = [
  [0, 0, 0],
  [24, 0, 0],
  [24, 10, 0],
  [0, 10, 0],
  [0, 0, 0],
];
const next = await host.build(project, randomUUID(), objects, baseline);
assert.equal(next.scene[0].area, 240);
assert.equal(next.scene[0].length, 68);
assert.equal(next.scene[0].nativeId, baseline.scene[0].nativeId);
assert.equal(next.scene[0].layer64, baseline.scene[0].layer64);
assert.equal(next.scene[0].color, baseline.scene[0].color);
const moved = structuredClone(next.objects);
moved[0].points = moved[0].points.map((p) => [p[0] + 2, p[1], p[2]]);
const third = await host.build(project, randomUUID(), moved, next);
assert.equal(third.scene[0].area, 240);
assert.deepEqual(third.objects[0].points[0], [2, 0, 0]);
assert.equal(await hash(source), original);
assert.equal(await hash(baseline.filename), baseline.fileHash);
assert.equal(await hash(next.filename), next.fileHash);
const invalid = structuredClone(objects);
invalid[0].nativeId = 'FFFFFFFF';
invalid[0].id = 'cad-FFFFFFFF';
const rejected = resolve('.vide/dwg-edit-check', project, 'rejected.dwg');
await assert.rejects(
  inspectDwg(baseline.filename, resolve('.vide/dwg-edit-check/failures'), undefined, {
    output: rejected,
    objects: invalid,
  }),
);
await assert.rejects(access(rejected));
assert.equal(await hash(baseline.filename), baseline.fileHash);
const result = {
  projectId: project,
  areaBefore: 200,
  areaAfter: 240,
  lengthAfter: 68,
  handlePreserved: true,
  attributesPreserved: true,
  repeatedEdit: true,
  sourceUnchanged: true,
  invalidHandleNoCandidate: true,
  editTransport: 'owned-sdk',
};
await writeFile(
  join('.vide/dwg-edit-check', project, 'result.json'),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
