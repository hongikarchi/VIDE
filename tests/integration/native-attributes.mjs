// Creates only an isolated headless synthetic file; never modifies the active document.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { rhinoCommand } from '../../hosts/rhino/transport.ts';
import { RhinoWorkspace } from '../../hosts/rhino/workspace.ts';
import { nativeAttributes } from '../../src/ui/native-attributes.ts';
if (process.argv[2] !== '--run-live') throw Error('Pass --run-live');
const directory = resolve('.vide/attribute-check', randomUUID());
await mkdir(directory, { recursive: true });
const source = join(directory, 'source.3dm');
const code = `using(var work=Rhino.RhinoDoc.CreateHeadless(null)){
work.ModelUnitSystem=Rhino.UnitSystem.Meters;
var a=new Rhino.DocObjects.ObjectAttributes();a.Name="Synthetic attributes";
a.SetUserString("BuildingId","BLDG-TEST-01");a.SetUserString("FloorId","L03");
a.SetUserString("Literal","<script>test</script>");a.SetUserString("Oversized",new string('x',2049));
work.Objects.AddPoint(new Rhino.Geometry.Point3d(1,2,3),a);
var options=new Rhino.FileIO.FileWriteOptions();options.SuppressDialogBoxes=true;options.SuppressAllInput=true;
if(!work.Write3dmFile(@"${source.replaceAll('"', '""')}",options))throw new Exception("Save failed");
}`;
const created = await rhinoCommand(
  'execute_rhinocommon_csharp_code',
  { code },
  { timeoutMs: 60000 },
);
assert.equal(created.success, true, created.message);
const hash = async () =>
  createHash('sha256')
    .update(await readFile(source))
    .digest('hex');
const before = await hash();
const result = await new RhinoWorkspace(join(directory, 'models')).importFile(
  'test',
  'import',
  source,
);
const attributes = nativeAttributes(result.scene[0]);
assert.equal(attributes.known, true);
assert.equal(attributes.complete, false);
assert.deepEqual(
  attributes.entries.map((e) => e.key),
  ['BuildingId', 'FloorId', 'Literal'],
);
assert.equal(attributes.entries[0].value, 'BLDG-TEST-01');
assert.equal(await hash(), before);
console.log(JSON.stringify({ verified: result.verified, attributes, sourceUnchanged: true }));
