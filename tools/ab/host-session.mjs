#!/usr/bin/env node
// L1' host session (PLAN-51 T-267): a run-only dev engine + an agent-launched Rhino with the DEV
// plugin, the given .3dm copy linked to a loop project, kept up until <dir>/stop exists (or SIGINT).
// Then the engine and Rhino are closed and the installed plugin registration is checked/restored.
//
//   node tools/ab/host-session.mjs --document <abs .3dm copy under .vide/> [--dir .vide/loop/<stamp>]
//     [--project-name '검증 루프 dev'] [--plugin <rhp>] [--visible]
//   node tools/ab/host-session.mjs --no-host [--dir …] [--project-name …]
//     engine only (route-only L0): the per-run data dir + keys, the project and launch.json; no
//     Rhino, no Link, no first Sync.
//
// Prints LAUNCH (launch.json for tools/ab/run.mjs --launch-file), LOGS (the engine's logs dir: the
// data dir is dirname(vide.sqlite), so <dir>/data/logs) and PROJECT. While up, writing
// <dir>/action.json {"id":N,"command":"reopen"} reopens the document in Rhino (R1-RECONNECT);
// the result lands in <dir>/action-N.json.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { startServer } from '../../src/server/server.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { connectScriptLines } from './rhino-connect.mjs';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..', '..');
const { values: args } = parseArgs({
  options: {
    document: { type: 'string' },
    dir: { type: 'string' },
    'project-name': { type: 'string', default: '검증 루프 dev' },
    plugin: {
      type: 'string',
      default: '.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp',
    },
    visible: { type: 'boolean', default: false },
    'no-host': { type: 'boolean', default: false },
  },
});
const noHost = args['no-host'];
const document = resolve(args.document ?? '');
const inVide = relative(join(root, '.vide'), document);
if (
  !noHost &&
  (!args.document ||
    !existsSync(document) ||
    !inVide ||
    inVide.startsWith('..') ||
    isAbsolute(inVide))
)
  throw new Error('--document must be an existing .3dm copy under .vide/ (never a user original).');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = resolve(args.dir ?? join(root, '.vide', 'loop', stamp));
const data = join(dir, 'data');
const plugin = resolve(args.plugin);
const slash = (p) => p.replaceAll('\\', '/');
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().replace('Z', '+09:00');
const log = (line) => console.log(`[${kst()}] ${line}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const REG =
  'HKCU\\Software\\McNeel\\Rhinoceros\\8.0\\Plug-ins\\6bde756c-cb1f-45bc-90fa-784c098c2c38\\PlugIn';
const INSTALLED = join(
  process.env.LOCALAPPDATA ?? '',
  'VIDE',
  'plugins',
  'rhino',
  '0.2.31-9d050376',
  'VIDE.Worker.rhp',
);
async function registered() {
  const { stdout } = await exec('reg', ['query', REG, '/v', 'FileName'], { windowsHide: true });
  return /FileName\s+REG_SZ\s+(.+)/.exec(stdout)?.[1].trim() ?? null;
}

// Refuse when a Rhino or ZWCAD already runs: the person may be working.
const { stdout: tasks } = await exec('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true });
if (!noHost && /"(Rhino|ZWCAD)\.exe"/i.test(tasks))
  throw new Error('A Rhino/ZWCAD is running; stop (the user may be working).');

await mkdir(data, { recursive: true });
for (const file of ['typesafe.env', 'public-data.env'])
  await copyFile(join(root, '.vide', 'dev-data', file), join(data, file));
const options = sdkOptions(dir);
options.plugin = plugin;
const connections = join(dir, 'rhino-connections');
const script = join(dir, 'startup.py');
await writeFile(
  script,
  `import Rhino, System, json, os, traceback
folder=${JSON.stringify(slash(dir))}
path=${JSON.stringify(slash(document))}
state=dict(last=0)
def report(name,value):
    with open(os.path.join(folder,name+'.tmp'),'w') as f: json.dump(value,f)
    os.rename(os.path.join(folder,name+'.tmp'),os.path.join(folder,name+'.json'))
def openDoc():
    # RhinoDoc.Open (not a nested _-Open command, which fails while a script runs).
    if Rhino.RhinoDoc.ActiveDoc: Rhino.RhinoDoc.ActiveDoc.Modified=False
    doc,was=Rhino.RhinoDoc.Open(path)
    return dict(ok=doc is not None,was=was,path=Rhino.RhinoDoc.ActiveDoc.Path if Rhino.RhinoDoc.ActiveDoc else None,count=Rhino.RhinoDoc.OpenDocuments().Length)
def idle(sender,e):
    try:
        p=os.path.join(folder,'action.json')
        if not os.path.exists(p):return
        with open(p) as f: action=json.load(f)
        if action['id']==state['last']:return
        state['last']=action['id']
        if action['command']=='reopen': report('reopen-'+str(state['last']),openDoc())
        report('action-'+str(state['last']),dict(ok=True,objects=Rhino.RhinoDoc.ActiveDoc.Objects.Count,path=Rhino.RhinoDoc.ActiveDoc.Path))
    except Exception as x: report('action-'+str(state['last']),dict(ok=False,error=str(x)))
try:
    report('opened',openDoc())
    doc=Rhino.RhinoDoc.ActiveDoc
    Rhino.PlugIns.PlugIn.LoadPlugIn(${JSON.stringify(slash(plugin))})
    # Attach without the Link dialog (VIDEConnect = VIDELink now shows a modal project picker):
    # the engine links it through POST /links, as rhino-direct-apply.mjs does.
${connectScriptLines({ doc: 'doc' })}
    Rhino.RhinoApp.Idle+=idle
    report('ready',dict(ok=True,objects=doc.Objects.Count,path=doc.Path))
except Exception as x: report('ready',dict(ok=False,error=str(x),trace=traceback.format_exc()))
`,
);

let host, app, stopping;
async function stop(reason) {
  if (stopping) return;
  stopping = true;
  log('STOP ' + reason);
  await app?.close().catch((e) => log('engine close: ' + e));
  await host?.stop().catch((e) => log('host stop: ' + e));
  let name = await registered().catch(() => null);
  if (name && name.toLowerCase() !== INSTALLED.toLowerCase()) {
    log(`registry points at ${name}; restoring the installed plugin`);
    await exec('reg', ['add', REG, '/v', 'FileName', '/t', 'REG_SZ', '/d', INSTALLED, '/f'], {
      windowsHide: true,
    });
    name = await registered().catch(() => null);
  }
  log(
    `REGISTRY FileName=${name} ${name?.toLowerCase() === INSTALLED.toLowerCase() ? 'OK' : 'MISMATCH'}`,
  );
  const { stdout } = await exec('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true });
  log('RHINO ' + (/"Rhino\.exe"/i.test(stdout) ? 'still running' : 'none'));
}
process.on('SIGINT', () => stop('SIGINT').then(() => process.exit(0)));

try {
  log(
    noHost
      ? `dir ${dir}; engine only (--no-host)`
      : `dir ${dir}; document ${document}; plugin ${plugin}`,
  );
  if (!noHost) {
    host = await launchOwnedHost({
      executable: options.executable,
      environment: { ...process.env, VIDE_CONNECT_DIR: connections },
      visible: args.visible,
      spawnProcess: (f, a, o) => spawn(f, a, { ...o, windowsVerbatimArguments: true }),
      args: [
        '/nosplash',
        '/notemplate',
        '/scheme=VIDE-Worker-Test',
        `/runscript="_-RunPythonScript (${script})"`,
      ],
    });
    let ready;
    for (const end = Date.now() + 120000; !ready && Date.now() < end; await wait(500))
      ready = await readFile(join(dir, 'ready.json'), 'utf8').then(JSON.parse, () => null);
    if (!ready?.ok) throw new Error('Rhino not ready: ' + JSON.stringify(ready));
    log(`rhino ready: ${ready.objects} objects, ${ready.path}`);
  }

  app = await startServer({ filename: join(data, 'vide.sqlite'), sdkOptions: options });
  const origin = app.origin;
  const token = new URL(app.launchUrl).hash.slice(1);
  const session = await fetch(origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const cookie = session.headers.getSetCookie()[0]?.split(';')[0];
  const call = async (path, body) => {
    const r = await fetch(origin + '/api/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const v = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(v)}`);
    return v;
  };
  const project = await call('/projects', { name: args['project-name'] });
  let sync;
  if (!noHost) {
    let attached;
    for (const end = Date.now() + 60000; !attached && Date.now() < end; await wait(1000))
      attached = (await call('/host/attached-documents').catch(() => ({}))).documents?.find(
        (d) => d.host !== 'zwcad',
      );
    if (!attached) throw new Error('No attached Rhino document');
    const began = Date.now();
    const link = await call(`/projects/${project.id}/links`, {
      host: 'rhino',
      instance: attached.instance,
      documentId: attached.id,
    });
    for (const end = Date.now() + 180000; !sync && Date.now() < end; await wait(1000))
      sync = (await call(`/projects/${project.id}/requests`)).find(
        (r) => r.state === 'succeeded' && r.result?.sceneOmitted,
      );
    if (!sync) throw new Error('First Sync did not succeed in 180 s');
    log(`linked ${link.id}; first Sync ${sync.id} in ${Date.now() - began} ms`);
  }
  await writeFile(
    join(dir, 'launch.json'),
    JSON.stringify({ url: `${origin}/#${token}` }, null, 2),
  );
  console.log('LAUNCH ' + join(dir, 'launch.json'));
  console.log('LOGS ' + join(data, 'logs'));
  console.log('PROJECT ' + project.id);
  if (sync) console.log('SYNC ' + sync.id);
  while (!existsSync(join(dir, 'stop'))) await wait(1000);
  await stop('stop file');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await stop('error');
}
process.exit(process.exitCode ?? 0);
