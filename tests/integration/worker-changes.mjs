import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { runDirectory } from './run-directory.mjs';
const directory = runDirectory('worker-changes');
await mkdir(directory, { recursive: true });
const options = {
  executable: 'C:/Program Files/Rhino 8/System/Rhino.exe',
  plugin: resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),
  bootstrap: resolve('hosts/rhino/worker/bootstrap.py'),
};
let worker;
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'baseline') });
  const first = await worker.execute(
    randomUUID(),
    0,
    `foreach(var name in new[]{"keep","metadata","remove"}){var a=new Rhino.DocObjects.ObjectAttributes();a.Name=name;a.SetUserString("vide-id",name);doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,2,3,4)),a);}`,
  );
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.changes, {
    added: ['keep', 'metadata', 'remove'],
    removed: [],
    modified: [],
  });
  await worker.stop();
  worker = undefined;
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'edit'),
    source: { filename: first.filename, fileHash: first.fileHash },
  });
  const edit = await worker.execute(
    randomUUID(),
    0,
    `
 var objects=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).ToArray();
 var item=objects.Single(o=>o.Name=="metadata");var a=item.Attributes.Duplicate();a.SetUserString("Level","L02");doc.Objects.ModifyAttributes(item.Id,a,true);
 doc.Objects.Delete(objects.Single(o=>o.Name=="remove").Id,true);
 var fresh=new Rhino.DocObjects.ObjectAttributes();fresh.SetUserString("vide-id","added");doc.Objects.AddPoint(new Point3d(10,0,0),fresh);
 `,
    ['keep'],
  );
  assert.equal(edit.ok, true, JSON.stringify(edit));
  assert.deepEqual(edit.changes, {
    added: ['added'],
    removed: ['remove'],
    modified: [{ id: 'metadata', geometry: false, attributes: true, nativeIdentity: false }],
  });
  const again = await worker.execute(
    randomUUID(),
    1,
    `var item=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(o=>o.Name=="metadata");var a=item.Attributes.Duplicate();a.DeleteUserString("Level");doc.Objects.ModifyAttributes(item.Id,a,true);`,
    ['keep'],
  );
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(again.changes, { added: ['added'], removed: ['remove'], modified: [] });
  const evidence = {
    passed: true,
    directory,
    additionDeletion: true,
    attributesWithoutGeometry: true,
    unchangedOmitted: true,
    netAgainstInput: true,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (worker) await worker.stop();
}
