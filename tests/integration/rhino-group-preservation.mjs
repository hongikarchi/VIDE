import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { runDirectory } from './run-directory.mjs';

const directory = runDirectory('rhino-group-preservation');
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
      'var o=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(o=>o.Name=="group-a");doc.Objects.Transform(o.Id,Transform.Translation(0,0,5),true);var a=o.Attributes.Duplicate();a.SetUserString("Level","L02");doc.Objects.ModifyAttributes(o.Id,a,true);',
      true,
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
    [
      'group-delete',
      'doc.Objects.Delete(doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(o=>o.Name=="group-a").Id,true);',
      false,
    ],
    [
      'group-add',
      'var a=new Rhino.DocObjects.ObjectAttributes();a.AddToGroup(doc.Groups.First(g=>!g.IsDeleted).Index);doc.Objects.AddPoint(new Point3d(9,0,0),a);',
      false,
    ],
  ];
  const candidates = [];
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
      candidates.push({ name, result });
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
  await editor.stop();
  editor = undefined;
  for (const { name, result: candidate } of candidates) {
    editor = await launchRhinoWorker({
      ...options,
      directory: join(directory, name + '-apply'),
      mode: 'editor',
      visible: false,
      source: initial,
    });
    const basis = await editor.captureEditor(randomUUID());
    const applied = await editor.applyEditorCandidate(
      randomUUID(),
      candidate.filename,
      candidate.fileHash,
      basis.documentHash,
    );
    assert.equal(applied.state, 'succeeded', JSON.stringify(applied));
    const after = await editor.captureEditor(randomUUID());
    worker = await launchRhinoWorker({
      ...options,
      directory: join(directory, name + '-verify'),
      source: after,
    });
    const grouped = name === 'group-move';
    const verified = await worker.execute(
      randomUUID(),
      0,
      `var g=doc.Groups.First(x=>!x.IsDeleted);var members=doc.Groups.GroupMembers(g.Index);
      if(g.Name!="Preserved"||members.Length!=2)throw new Exception("Group changed");
      var a=members.Single(o=>o.Name=="group-a");var b=members.Single(o=>o.Name=="group-b");
      if(a.Geometry.GetBoundingBox(true).Min.Z!=${grouped ? 5 : 0}||b.Geometry.GetBoundingBox(true).Min.Z!=0)throw new Exception("Member geometry mismatch");
      ${grouped ? 'if(a.Attributes.GetUserString("Level")!="L02")throw new Exception("Attribute missing");' : ''}
      if(doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(o=>o.Name=="independent").Geometry.GetBoundingBox(true).Min.Z!=${grouped ? 0 : 5})throw new Exception("Independent edit mismatch");
      return g.Id.ToString();`,
    );
    assert.equal(verified.ok, true, JSON.stringify(verified).slice(0, 300));
    const objects = await worker.query();
    assert.deepEqual(
      objects.objects.map((o) => o.nativeId).sort(),
      initial.snapshot.objects.map((o) => o.nativeId).sort(),
    );
    await worker.stop();
    worker = undefined;
    await editor.stop();
    editor = undefined;
  }
  const evidence = {
    passed: true,
    independentEdit: true,
    groupedGeometryAndAttributes: true,
    groupMembers: 2,
    rejected: ['group-rename', 'group-unassign', 'group-delete', 'group-add'],
    rejectionBeforeWrites: true,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ directory, ...evidence }));
} finally {
  await worker?.stop();
  await editor?.stop();
}
