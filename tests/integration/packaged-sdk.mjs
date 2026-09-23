// Real packaged worker startup from a path with spaces using only its bundled Node.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile),
  archive = resolve(process.argv[2]),
  directory = resolve('.vide/packaged-sdk', randomUUID()),
  install = join(directory, 'install space');
await mkdir(install, { recursive: true });
await exec('tar.exe', ['-xf', archive, '-C', install], { windowsHide: true });
const { stdout } = await exec('tar.exe', ['-tf', archive], {
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024,
});
const rootName = stdout.split(/\r?\n/)[0].split('/')[0];
if (!/^VIDE-[a-zA-Z0-9.-]+$/.test(rootName)) throw Error('Invalid archive root');
const root = join(install, rootName),
  script = join(directory, 'check.mjs');
await writeFile(
  script,
  `
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const root=${JSON.stringify(root)},directory=${JSON.stringify(directory)};
const {launchRhinoWorker}=await import(pathToFileURL(join(root,'app/hosts/rhino/worker-client.ts')));
const worker=await launchRhinoWorker({directory:join(directory,'worker'),executable:'C:/Program Files/Rhino 8/System/Rhino.exe',plugin:join(root,'app/hosts/rhino/worker/runtime/VIDE.Worker.rhp'),bootstrap:join(root,'app/hosts/rhino/worker/bootstrap.py')});
try{const result=await worker.execute(randomUUID(),0,'doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,2,3,4)));');assert.equal(result.ok,true,JSON.stringify(result));const model=await worker.exportModel();assert.ok(Math.abs(model.scene[0].volume-24)<1e-8);console.log(JSON.stringify({packagedSdk:true,spaceInPath:true,objects:model.objects.length,volume:model.scene[0].volume,directory}));}finally{await worker.stop();}
const {launchZwcadWorker}=await import(pathToFileURL(join(root,'app/hosts/zwcad/worker-client.ts')));
const cad=await launchZwcadWorker({directory:join(directory,'cad-worker'),plugin:join(root,'app/hosts/zwcad/worker/runtime/VIDE.Zwcad.Worker.dll')});
try{const receipt=await cad.execute(randomUUID(),0,'var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var ms=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForWrite);var p=new Polyline();p.AddVertexAt(0,new Point2d(0,0),0,0,0);p.AddVertexAt(1,new Point2d(20000,0),0,0,0);p.AddVertexAt(2,new Point2d(20000,10000),0,0,0);p.AddVertexAt(3,new Point2d(0,10000),0,0,0);p.Closed=true;ms.AppendEntity(p);tr.AddNewlyCreatedDBObject(p,true);');assert.equal(receipt.ok,true,JSON.stringify(receipt));assert.equal(receipt.model.scene[0].area,200);console.log(JSON.stringify({packagedZwcadSdk:true,area:receipt.model.scene[0].area}));}finally{await cad.stop();}
`,
);
const result = await exec(join(root, 'runtime/node.exe'), [script], {
  windowsHide: true,
  timeout: 240000,
  env: { ...process.env, PATH: process.env.WINDIR + '\\System32' },
});
const evidence = Object.assign(
  {},
  ...result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line)),
);
await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
if (!resolve(install).startsWith(resolve(directory) + '\\'))
  throw Error('Invalid test cleanup path');
await rm(install, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
console.log(JSON.stringify(evidence));
