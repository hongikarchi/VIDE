import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { launchProbe } from '../../tools/spikes/2026-09-22-zwcad-sdk/channel-client.mjs';
import { ZwcadWorkspace } from '../../hosts/zwcad/workspace.ts';
import { runDirectory } from './run-directory.mjs';

const directory = runDirectory('dwg-sdk-cases');
await mkdir(directory, { recursive: true });
const literal = (value) => '@"' + value.replaceAll('"', '""') + '"';
let fixture;
try {
  fixture = await launchProbe(directory, 'fixture', true);
  const source = join(fixture.folder, 'sdk-probe.dwg');
  const modifications = {
    unknown: 'copy.Insunits=(UnitsValue)0;',
    curved: 'line.SetBulgeAt(0,0.2);',
    locked:
      'var layer=(LayerTableRecord)edit.GetObject(line.LayerId,OpenMode.ForWrite);layer.IsLocked=true;',
    metres:
      'copy.Insunits=UnitsValue.Meters;for(int i=0;i<line.NumberOfVertices;i++){var point=line.GetPoint2dAt(i);line.SetPointAt(i,new Point2d(point.X/1000,point.Y/1000));}',
  };
  const code = Object.entries(modifications)
    .map(
      ([name, body]) => `using(var copy=new Database(false,true)){
 copy.ReadDwgFile(${literal(source)},FileOpenMode.OpenForReadAndAllShare,true,null);copy.CloseInput(true);
 using(var edit=copy.TransactionManager.StartTransaction()){
 var blocks=(BlockTable)edit.GetObject(copy.BlockTableId,OpenMode.ForRead);var space=(BlockTableRecord)edit.GetObject(blocks[BlockTableRecord.ModelSpace],OpenMode.ForRead);
 foreach(ObjectId id in space){var line=(Polyline)edit.GetObject(id,OpenMode.ForWrite);${body}}edit.Commit();}
 copy.SaveAs(${literal(join(directory, name + '.dwg'))},DwgVersion.Current);
}`,
    )
    .join('\n');
  const created = await fixture.call({
    method: 'execute',
    operationId: randomUUID(),
    revision: 0,
    code,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  await fixture.owner.stop();
  fixture = undefined;
  const workspace = new ZwcadWorkspace(join(directory, 'imports'));
  const result = {};
  for (const [name, error] of [
    ['unknown', 'UNKNOWN_UNITS'],
    ['curved', 'UNSUPPORTED_DWG_CONTENT'],
    ['locked', null],
    ['metres', null],
  ]) {
    const path = join(directory, name + '.dwg'),
      before = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    if (error) {
      await assert.rejects(workspace.importFile(randomUUID(), randomUUID(), path), { code: error });
      result[name] = { rejected: error };
    } else {
      const model = await workspace.importFile(randomUUID(), randomUUID(), path);
      assert.equal(model.importMode, 'sdk');
      assert.equal(model.dwgEditMode, null);
      assert.equal(model.scene[0].area, 200);
      assert.equal(model.scene[0].length, 60);
      assert.deepEqual(model.objects[0].points, [
        [0, 0, 0],
        [20, 0, 0],
        [20, 10, 0],
        [0, 10, 0],
        [0, 0, 0],
      ]);
      result[name] = { referenceOnly: true, sourceUnits: model.sourceUnits, area: 200, length: 60 };
    }
    assert.equal(
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
      before,
    );
  }
  const evidence = { passed: true, directory, cases: result, sourceHashesPreserved: true };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} catch (error) {
  await writeFile(
    join(directory, 'failure.json'),
    JSON.stringify({ directory, error: error.message }, null, 2),
  );
  throw error;
} finally {
  if (fixture) await fixture.owner.stop();
}
