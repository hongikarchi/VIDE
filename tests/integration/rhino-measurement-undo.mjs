import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { runDirectory } from './run-directory.mjs';

const directory = runDirectory('measurement-undo');
await mkdir(directory, { recursive: true });
const script = join(directory, 'fixture.py');
await writeFile(
  script,
  `import Rhino, json, os, traceback
folder = ${JSON.stringify(directory.replaceAll('\\', '/'))}
def run(sender, args):
    Rhino.RhinoApp.Idle -= run
    try:
        doc = Rhino.RhinoDoc.ActiveDoc
        assert doc.Objects.Count == 0 and not doc.Modified
        doc.ModelUnitSystem = Rhino.UnitSystem.Meters
        def save(name):
            options = Rhino.FileIO.FileWriteOptions()
            options.UpdateDocumentPath = False
            options.SuppressAllInput = True
            assert doc.Write3dmFile(os.path.join(folder,name+'.3dm'),options)
            options.Dispose()
        ids = []
        for name in ['edit','keep']:
            a = Rhino.DocObjects.ObjectAttributes()
            a.Name = name
            a.SetUserString('vide-id',name)
            a.SetUserString('Level','L01')
            ids.append(doc.Objects.AddBox(Rhino.Geometry.Box(Rhino.Geometry.BoundingBox(0,0,0,2,3,4)),a))
        save('baseline')
        record = doc.BeginUndoRecord('VIDE quantity edit')
        assert record != 0
        assert doc.Objects.Replace(ids[0],Rhino.Geometry.Box(Rhino.Geometry.BoundingBox(0,0,0,2,3,8)).ToBrep())
        a = doc.Objects.FindId(ids[0]).Attributes.Duplicate()
        a.SetUserString('Level','L02')
        assert doc.Objects.ModifyAttributes(ids[0],a,True)
        assert doc.EndUndoRecord(record)
        save('changed')
        assert Rhino.RhinoApp.RunScript('_Undo',False)
        save('undone')
        assert Rhino.RhinoApp.RunScript('_Redo',False)
        save('redone')
        record = doc.BeginUndoRecord('VIDE quantity delete')
        assert record != 0
        assert doc.Objects.Delete(ids[0],True)
        assert doc.EndUndoRecord(record)
        save('deleted')
        assert Rhino.RhinoApp.RunScript('_Undo',False)
        save('restored')
        result = dict(passed=True)
    except Exception as error:
        result = dict(passed=False,error=str(error),trace=traceback.format_exc())
    with open(os.path.join(folder,'ready.json'),'w') as output:
        json.dump(result,output)
Rhino.RhinoApp.Idle += run
`,
);
const executable = 'C:/Program Files/Rhino 8/System/Rhino.exe';
let host;
try {
  host = await launchOwnedHost({
    executable,
    visible: false,
    spawnProcess: (file, args, options) =>
      spawn(file, args, { ...options, windowsVerbatimArguments: true }),
    args: [
      '/nosplash',
      '/notemplate',
      '/scheme=VIDE-Worker-Test',
      `/runscript="_-RunPythonScript (${script})"`,
    ],
  });
  let fixture;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      fixture = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(fixture?.passed, true, JSON.stringify(fixture));
} finally {
  if (host) await host.stop();
}
const sdk = new SdkExecution({
  directory: join(directory, 'imports'),
  executable,
  plugin: resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),
  bootstrap: resolve('hosts/rhino/worker/bootstrap.py'),
  tools: {},
  origin: () => '',
});
let cache = [],
  nativeId;
const stages = [];
for (const [name, volume, level, measured, reused] of [
  ['baseline', 24, 'L01', 2, 0],
  ['changed', 48, 'L02', 1, 1],
  ['undone', 24, 'L01', 1, 1],
  ['redone', 48, 'L02', 1, 1],
  ['deleted', null, null, 0, 1],
  ['restored', 48, 'L02', 1, 1],
]) {
  const model = await sdk.importFile(join(directory, name + '.3dm'), () => {}, cache);
  assert.deepEqual(model.measurementStats, { measuredObjects: measured, reusedObjects: reused });
  const row = model.scene.find((item) => item.id === 'edit');
  if (volume === null) assert.equal(row, undefined);
  else {
    nativeId ??= row.nativeId;
    assert.equal(row.nativeId, nativeId);
    assert.ok(Math.abs(row.volume - volume) < 1e-8);
    assert.ok(
      row.attributes64.some(
        ([k, v]) =>
          Buffer.from(k, 'base64').toString() === 'Level' &&
          Buffer.from(v, 'base64').toString() === level,
      ),
    );
  }
  assert.equal(model.scene.find((item) => item.id === 'keep').volume, 24);
  cache = model.scene.map(({ id, geometryHash, area, volume, length }) => ({
    id,
    geometryHash,
    area,
    volume,
    length,
  }));
  stages.push({ name, volume, level, ...model.measurementStats });
}
const evidence = { passed: true, directory, realDocumentUndoRedo: true, stages };
await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
