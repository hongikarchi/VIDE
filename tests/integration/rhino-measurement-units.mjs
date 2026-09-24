import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { SdkExecution } from '../../src/server/sdk-execution.ts';

const directory = resolve('.vide/measurement-units', randomUUID());
await mkdir(directory, { recursive: true });
const script = join(directory, 'fixture.py');
const ready = join(directory, 'ready.json');
await writeFile(
  script,
  `import Rhino, json, os
folder = ${JSON.stringify(directory.replaceAll('\\', '/'))}
try:
    for name, unit, scale in [('metres', Rhino.UnitSystem.Meters, 1), ('millimetres', Rhino.UnitSystem.Millimeters, 1000), ('reinterpreted', Rhino.UnitSystem.Millimeters, 1)]:
        doc = Rhino.RhinoDoc.CreateHeadless(None)
        try:
            doc.ModelUnitSystem = unit
            a = Rhino.DocObjects.ObjectAttributes()
            a.Name = 'unit-box'
            a.SetUserString('vide-id', 'unit-box')
            doc.Objects.AddBox(Rhino.Geometry.Box(Rhino.Geometry.BoundingBox(0,0,0,2*scale,3*scale,4*scale)), a)
            assert doc.Write3dmFile(os.path.join(folder, name+'.3dm'), Rhino.FileIO.FileWriteOptions())
        finally:
            doc.Dispose()
    result = dict(passed=True)
except Exception as error:
    result = dict(passed=False, error=str(error))
with open(os.path.join(folder, 'ready.json'), 'w') as output:
    json.dump(result, output)
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
      fixture = JSON.parse(await readFile(ready, 'utf8'));
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
const baseline = await sdk.importFile(join(directory, 'metres.3dm'), () => {});
const measurements = baseline.scene.map(({ id, geometryHash, area, volume, length }) => ({
  id,
  geometryHash,
  area,
  volume,
  length,
}));
const scaled = await sdk.importFile(join(directory, 'millimetres.3dm'), () => {}, measurements);
assert.ok(Math.abs(scaled.scene[0].volume - 24) < 1e-8);
assert.ok(Math.abs(scaled.scene[0].area - 52) < 1e-8);
const changed = await sdk.importFile(join(directory, 'reinterpreted.3dm'), () => {}, measurements);
assert.deepEqual(changed.measurementStats, { measuredObjects: 1, reusedObjects: 0 });
assert.ok(Math.abs(changed.scene[0].volume - 24e-9) < 1e-14);
assert.ok(Math.abs(changed.scene[0].area - 52e-6) < 1e-12);
const evidence = {
  passed: true,
  directory,
  metreVolume: baseline.scene[0].volume,
  millimetreVolume: scaled.scene[0].volume,
  reinterpretedVolume: changed.scene[0].volume,
  changedUnitsRecomputed: true,
};
await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
