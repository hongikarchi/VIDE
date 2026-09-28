import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Applications } from '../../src/server/application.ts';
import { applyAttachedCandidate } from '../../src/server/attached-application.ts';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { sendHostCommand } from '../../hosts/common/transport.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
const directory = resolve('.vide/rhino-attached', randomUUID());
await mkdir(directory, { recursive: true });
const options = sdkOptions(directory),
  connectionDirectory = join(directory, 'rhino-connections');
if (process.env.VIDE_TEST_RHINO_PLUGIN)
  options.plugin = resolve(process.env.VIDE_TEST_RHINO_PLUGIN);
const script = join(directory, 'fixture.py');
await writeFile(
  script,
  `import Rhino, System, json, os, traceback
from System.Collections.Generic import List
folder=${JSON.stringify(directory.replaceAll('\\', '/'))}
plugin=${JSON.stringify(options.plugin.replaceAll('\\', '/'))}
last=0
def report(name,value):
    with open(os.path.join(folder,name+'.tmp'),'w') as f: json.dump(value,f)
    os.rename(os.path.join(folder,name+'.tmp'),os.path.join(folder,name+'.json'))
def idle(sender,args):
    global last
    try:
        path=os.path.join(folder,'action.json')
        if not os.path.exists(path):return
        with open(path) as f: action=json.load(f)
        if action['id']==last:return
        last=action['id']; command=action['command'];doc=Rhino.RhinoDoc.ActiveDoc
        if command=='move':
            obj=list(doc.Objects)[0]
            Rhino.RhinoApp.RunScript('_SelAll',False)
            assert Rhino.RhinoApp.RunScript('_Move 0,0,0 1000,0,0',False)
        elif command=='addBlock' or command=='changeBlock':
            geometry=List[Rhino.Geometry.GeometryBase]()
            geometry.Add(Rhino.Geometry.Box(Rhino.Geometry.BoundingBox(0,0,0,1000,2000,3000 if command=='addBlock' else 5000)).ToBrep())
            attributes=List[Rhino.DocObjects.ObjectAttributes]();attributes.Add(Rhino.DocObjects.ObjectAttributes())
            if command=='addBlock':
                idx=doc.InstanceDefinitions.Add('Test block','definition',Rhino.Geometry.Point3d.Origin,geometry,attributes)
                assert idx>=0
                doc.Objects.AddInstanceObject(idx,Rhino.Geometry.Transform.Identity)
            else: assert doc.InstanceDefinitions.ModifyGeometry(doc.InstanceDefinitions.Find('Test block').Index,geometry,attributes)
        elif command=='damageCapture':
            copy=Rhino.FileIO.File3dm.Read(action['filename'])
            definition=list(copy.AllInstanceDefinitions)[0]
            copy.Objects.Delete(definition.GetObjectIds()[0])
            assert copy.Write(action['filename'],8)
            copy.Dispose()
        elif command=='undo': assert Rhino.RhinoApp.RunScript('_Undo',False)
        else: assert Rhino.RhinoApp.RunScript('_'+command,False)
        report('action-'+str(last),dict(ok=True))
    except Exception as e: report('action-'+str(last),dict(ok=False,error=str(e)))
try:
    doc=Rhino.RhinoDoc.ActiveDoc
    assert doc.Objects.Count==0
    doc.ModelUnitSystem=Rhino.UnitSystem.Millimeters
    a=Rhino.DocObjects.ObjectAttributes();a.Name='Existing model';a.SetUserString('Role','Mass')
    native=doc.Objects.AddBox(Rhino.Geometry.Box(Rhino.Geometry.BoundingBox(0,0,0,2000,3000,4000)),a)
    before=doc.Modified
    loaded,pid=Rhino.PlugIns.PlugIn.LoadPlugIn(plugin)
    assert Rhino.RhinoApp.RunScript('_VIDEConnect',False)
    assert doc.Modified==before and doc.ModelUnitSystem==Rhino.UnitSystem.Millimeters
    assert doc.Objects.FindId(native).Attributes.GetUserString('vide-id') is None
    Rhino.RhinoApp.Idle+=idle
    report('ready',dict(ok=True,nativeId=str(native)))
except Exception as e: report('ready',dict(ok=False,error=str(e),trace=traceback.format_exc()))
`,
);
const wait = async (fn) => {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw Error('Timed out');
};
let host,
  worker,
  step = 0;
try {
  host = await launchOwnedHost({
    executable: options.executable,
    environment: { ...process.env, VIDE_CONNECT_DIR: connectionDirectory },
    visible: false,
    spawnProcess: (f, a, o) => spawn(f, a, { ...o, windowsVerbatimArguments: true }),
    args: [
      '/nosplash',
      '/notemplate',
      '/scheme=VIDE-Worker-Test',
      `/runscript="_-RunPythonScript (${script})"`,
    ],
  });
  const ready = await wait(async () =>
    JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')),
  );
  assert.equal(ready.ok, true, JSON.stringify(ready));
  const action = async (command, extra = {}) => {
    step++;
    await writeFile(join(directory, 'action.tmp'), JSON.stringify({ id: step, command, ...extra }));
    // Rhino may still hold the preceding file for its brief read. The action ID prevents replay.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(join(directory, 'action.tmp'), join(directory, 'action.json'));
        break;
      } catch (error) {
        if (error.code !== 'EPERM' || attempt === 19) throw error;
        await new Promise((accept) => setTimeout(accept, 50));
      }
    }
    const r = await wait(async () =>
      JSON.parse(await readFile(join(directory, 'action-' + step + '.json'), 'utf8')),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
  };
  const sessions = new EditorSessions({ ...options, connectionDirectory });
  const catalog = await sessions.list(true);
  assert.equal(catalog.documents.length, 1);
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };
  assert.equal(catalog.documents[0].connection, 'attached-editor');
  assert.equal(catalog.documents[0].units, 'Millimeters');
  // Shared pins round-trip through the attached connection without touching the model.
  const noPins = await sessions.list(true);
  assert.deepEqual(noPins.documents[0].pinnedIds, []);
  const firstId = (await sessions.list(true)).documents[0];
  assert.ok(Array.isArray(firstId.selectedIds));
  const pinId = randomUUID();
  assert.deepEqual((await sessions.setPins(target, [pinId])).pinnedIds, [pinId]);
  assert.deepEqual((await sessions.list(true)).documents[0].pinnedIds, [pinId]);
  await sessions.setPins(target, []);
  const record = JSON.parse(
    await readFile(
      join(
        connectionDirectory,
        (await readdir(connectionDirectory)).find((n) => n.endsWith('.json')),
      ),
      'utf8',
    ),
  );
  const call = (method, extra = {}) =>
    sendHostCommand(
      'vide',
      { ...record.identity, token: record.token, method, ...extra },
      { port: record.identity.port },
    );
  assert.equal(
    (
      await call('execute', {
        operationId: randomUUID(),
        revision: 0,
        code: 'throw new Exception();',
      })
    ).code,
    'UNKNOWN_METHOD',
  );
  assert.equal((await call('inspectEditor', { token: '0'.repeat(64) })).code, 'UNAUTHORIZED');
  assert.equal(
    (await call('inspectEditor', { documentId: target.documentId + 1 })).code,
    'TARGET_MISMATCH',
  );
  const sdk = new SdkExecution({ ...options, tools: {}, origin: () => '' });
  const direct = await sdk.syncEditor(target, () => {});
  assert.equal(direct.displayOnly, true);
  assert.equal(direct.verified, false);
  assert.equal(direct.filename, undefined);
  assert.equal(direct.scene[0].nativeId, ready.nativeId);
  assert.deepEqual(direct.scene[0].boundsSize, [2, 3, 4]);
  assert.equal(direct.scene[0].volume, null);
  const originalFiles = await readdir(join(connectionDirectory, record.identity.sessionId));
  assert.equal(originalFiles.filter((file) => file.endsWith('.3dm')).length, 0);
  const basis = await sdk.captureEditor(target, () => {});
  assert.equal(basis.sourceDocument.connection, 'attached-editor');
  assert.ok(Math.abs(basis.scene[0].volume - 24) < 1e-7);
  worker = await launchRhinoWorker({
    ...options,
    directory: join(options.directory, 'candidate'),
    source: basis,
  });
  const receipt = await worker.execute(
    randomUUID(),
    0,
    'var obj=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single();var id=obj.Id;var a=obj.Attributes.Duplicate();a.SetUserString("Height","8");if(!doc.Objects.ModifyAttributes(id,a,true))throw new Exception();using var box=new Box(new BoundingBox(0,0,0,2,3,8)).ToBrep();if(!doc.Objects.Replace(id,box))throw new Exception();',
  );
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  await worker.stop();
  worker = undefined;
  const candidate = {
    ...basis,
    ...receipt,
    sourceDocument: basis.sourceDocument,
    hostExecuted: true,
    host: 'rhino',
    executionMode: 'sdk',
  };
  const preview = await sessions.preview(target, candidate);
  assert.equal(preview.updated, 1);
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('Attached native test');
  const input = {
    id: 'basis',
    body: 'Sync',
    permission: 'candidate',
    provider: 'codex-cli',
    pins: [],
    sketches: [],
    files: [],
    host: 'rhino',
  };
  workspace.submit(project.id, input);
  workspace.update(project.id, 'basis', 'succeeded', {
    ...basis,
    hostExecuted: true,
    host: 'rhino',
  });
  const request = workspace.submit(project.id, {
    ...input,
    id: 'edit',
    body: 'Change height to 8m',
    baseRequestId: 'basis',
    applyToSource: true,
  }).request;
  const application = new Applications(store, workspace, { sdk: sessions });
  const applied = await applyAttachedCandidate(
    workspace,
    application,
    sdk,
    request,
    candidate,
    new AbortController().signal,
  );
  assert.equal(applied.state, 'succeeded', JSON.stringify(applied.result));
  assert.equal(applied.result.applicationState, 'succeeded');
  assert.equal(applied.result.syncState, 'succeeded');
  const after = applied.result;
  store.close();
  assert.ok(Math.abs(after.scene[0].volume - 48) < 1e-7);
  assert.equal(after.scene[0].nativeId, ready.nativeId);
  assert.equal(after.sourceDocument.units, 'Millimeters');
  await action('undo');
  const undone = await sdk.captureEditor(target, () => {});
  assert.ok(Math.abs(undone.scene[0].volume - 24) < 1e-7);
  await action('VIDELiveSync');
  const beforeGeneration = (await sessions.list(true)).documents[0].generation;
  await action('move');
  await wait(async () => {
    const c = await sessions.list(true);
    return c.documents[0].generation > beforeGeneration;
  });
  const moved = await sdk.captureEditor(target, () => {});
  assert.ok(Math.abs(moved.scene[0].origin[0] - 1) < 1e-7);
  await assert.rejects(() => sessions.preview(target, candidate), { code: 'SOURCE_CHANGED' });
  await action('VIDEDisconnect');
  assert.equal(await sessions.has(target.instance), false);
  await assert.rejects(() => sessions.capture(target), { code: 'STALE_CONNECTION' });
  await action('VIDEConnect');
  const reconnected = await sessions.list(true);
  assert.notEqual(reconnected.documents[0].instance, target.instance);
  await assert.rejects(() => sessions.capture(target), { code: 'STALE_CONNECTION' });
  const blockTarget = {
    instance: reconnected.documents[0].instance,
    documentId: reconnected.documents[0].id,
  };
  await action('addBlock');
  const blockCapture = await sessions.capture(blockTarget);
  // Attached basis identity is the connection revision token recorded at capture time.
  assert.match(blockCapture.revisionHash, /^[a-f0-9]{64}$/);
  assert.equal((await sessions.inspect(blockTarget)).documentHash, blockCapture.revisionHash);
  await action('VIDELiveSync');
  const blockGeneration = (await sessions.list(true)).documents[0].generation;
  await action('changeBlock');
  assert.notEqual((await sessions.inspect(blockTarget)).documentHash, blockCapture.revisionHash);
  await wait(async () => (await sessions.list(true)).documents[0].generation > blockGeneration);
  const updatedBlock = await sessions.capture(blockTarget);
  await action('damageCapture', { filename: updatedBlock.filename });
  const blockRecord = JSON.parse(
    await readFile(
      join(
        connectionDirectory,
        (await readdir(connectionDirectory)).find((n) => n.endsWith('.json')),
      ),
      'utf8',
    ),
  );
  const damaged = await sendHostCommand(
    'vide',
    {
      ...blockRecord.identity,
      token: blockRecord.token,
      method: 'verifyEditorCapture',
      operationId: updatedBlock.filename.split(/[\\/]/).at(-1).replace('.3dm', ''),
    },
    { port: blockRecord.identity.port },
  );
  assert.equal(damaged.ok, false);
  const result = {
    passed: true,
    directory,
    existingDocumentAttached: true,
    directDisplayWithoutNativeSave: true,
    unitsPreserved: true,
    applyUndoAndSync: true,
    authorizedApplicationAndReadback: true,
    liveNativeMoveObserved: true,
    generatedCodeRefused: true,
    wrongTokenAndDocumentRefused: true,
    reconnectInvalidatesTarget: true,
    blockCapturePreserved: true,
    definitionOnlyChangeInvalidatesBasis: true,
    blockDefinitionLiveSync: true,
    missingDefinitionGeometryRejected: true,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await worker?.stop();
  await host?.stop();
}
