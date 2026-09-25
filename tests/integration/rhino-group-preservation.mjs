import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';

const directory = resolve('.vide/rhino-group-preservation', randomUUID());
await mkdir(directory, { recursive: true });
const options = sdkOptions(directory);
let worker, editor;
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'seed') });
  const initial = await worker.execute(
    randomUUID(),
    0,
    'var ids=new System.Collections.Generic.List<Guid>();foreach(var name in new[]{"group-a","group-b","independent"}){var a=new Rhino.DocObjects.ObjectAttributes();a.Name=name;a.SetUserString("vide-id",name);var id=doc.Objects.AddPoint(new Point3d(ids.Count,0,0),a);ids.Add(id);}doc.Groups.Add("Preserved",ids.Take(2));',
  );
  assert.equal(initial.ok, true, JSON.stringify(initial).slice(0, 300));
  await worker.stop();
  worker = undefined;
  editor = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'editor'),
    mode: 'editor',
    visible: false,
    source: initial,
  });
  const captured = await editor.captureEditor(randomUUID());
  const cases = [
    [
      'independent',
      'doc.Objects.Transform(doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(o=>o.Name=="independent").Id,Transform.Translation(0,0,5),true);',
      true,
    ],
    [
      'group-move',
      'doc.Objects.Transform(doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(o=>o.Name=="group-a").Id,Transform.Translation(0,0,5),true);',
      false,
    ],
    [
      'group-rename',
      'doc.Groups.ChangeGroupName(doc.Groups.First(g=>!g.IsDeleted).Index,"Changed");',
      false,
    ],
    [
      'group-unassign',
      'var o=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(o=>o.Name=="group-a");var a=o.Attributes.Duplicate();a.RemoveFromAllGroups();doc.Objects.ModifyAttributes(o.Id,a,true);',
      false,
    ],
  ];
  let candidate;
  for (const [name, code, allowed] of cases) {
    worker = await launchRhinoWorker({
      ...options,
      directory: join(directory, name),
      source: captured,
    });
    const result = await worker.execute(randomUUID(), 0, code);
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
    if (allowed) {
      const preview = await editor.previewEditorApplication(
        result.filename,
        result.fileHash,
        captured.documentHash,
      );
      assert.deepEqual([preview.added, preview.updated, preview.removed], [0, 1, 0]);
      candidate = result;
    } else {
      await assert.rejects(() =>
        editor.previewEditorApplication(result.filename, result.fileHash, captured.documentHash),
      );
      const outcome = await editor.applyEditorCandidate(
        randomUUID(),
        result.filename,
        result.fileHash,
        captured.documentHash,
      );
      assert.equal(outcome.state, 'failed');
      assert.ok(
        ['UNSUPPORTED_APPLICATION', 'UNSUPPORTED_NATIVE_TARGET'].includes(outcome.result.code),
        JSON.stringify(outcome),
      );
      const unchanged = await editor.captureEditor(randomUUID());
      assert.equal(unchanged.documentHash, captured.documentHash);
    }
    await worker.stop();
    worker = undefined;
  }
  const applied = await editor.applyEditorCandidate(
    randomUUID(),
    candidate.filename,
    candidate.fileHash,
    captured.documentHash,
  );
  assert.equal(applied.state, 'succeeded', JSON.stringify(applied));
  const after = await editor.captureEditor(randomUUID());
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'verify'),
    source: after,
  });
  const verified = await worker.execute(
    randomUUID(),
    0,
    'var g=doc.Groups.First(x=>!x.IsDeleted);var members=doc.Groups.GroupMembers(g.Index);if(g.Name!="Preserved"||members.Length!=2||members.Any(o=>o.Geometry.GetBoundingBox(true).Min.Z!=0))throw new Exception("Group changed");if(doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(o=>o.Name=="independent").Geometry.GetBoundingBox(true).Min.Z!=5)throw new Exception("Independent edit missing");return g.Id.ToString();',
  );
  assert.equal(verified.ok, true, JSON.stringify(verified).slice(0, 300));
  const evidence = {
    passed: true,
    independentEdit: true,
    preservedGroupId: verified.value,
    groupMembers: 2,
    rejected: ['group-move', 'group-rename', 'group-unassign'],
    rejectionBeforeWrites: true,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ directory, ...evidence }));
} finally {
  await worker?.stop();
  await editor?.stop();
}
