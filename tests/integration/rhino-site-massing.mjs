// 규모검토 통합 검수 in a VIDE-owned hidden Rhino 8 (PLAN-45 T-214, PLAN-46 T-220): the whole chain
// in one engine on a synthetic document under .vide/ — `vide/site-model` (synthetic public data, or
// with `--live` this PC's keys on 서울특별시청, a non-project public parcel) made in Rhino through
// the jig route; the legal profile read from it and the fake cLAWde's 일조 answer, whose 대지 chip
// resolves to the objects Rhino holds and that a fresh Sync shows (the chip highlight's ids);
// `vide/buildable-mass` assembled from the layers read back from Rhino with `legal.constraints` as
// its legal input, its 고른 대안 confirmed and its floor masses made and measured (closed, valid,
// outward, engine volume); `vide/building-summary` reading both results, its page and CSVs.
// Prints timings per stage. With `--live` it prints key names only (never values), counts and
// computed values; nothing from the services is written to the repository (the run folder under
// .vide/ is removed on success). No user document is opened; only the Rhino this test launched is
// closed; the installed VIDE's plugin registration is restored afterwards.
// Usage: node tests/integration/rhino-site-massing.mjs [--live]
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { Execution } from '../../src/server/execution.ts';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { PublicDataKeyStore } from '../../src/server/public-data-keys.ts';
import { toCsv } from '../../src/ui/jig-panel/bindings.ts';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { runDirectory } from './run-directory.mjs';
import { soleDb } from '../fixtures/store.mjs';
import { KEYS, fakeSiteData } from '../fixtures/site-data.mjs';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';
import {
  askConfirmed,
  buildableMass,
  buildingSummary,
  chainEngine,
  siteModel,
  statusOf,
} from '../fixtures/site-massing-chain.mjs';

const live = process.argv.includes('--live');
const probe = sdkOptions('.');
const plugin = process.env.VIDE_TEST_RHINO_PLUGIN
  ? resolve(process.env.VIDE_TEST_RHINO_PLUGIN)
  : probe.plugin;
if (!existsSync(probe.executable) || !existsSync(plugin)) {
  console.log(
    `skipped: Rhino 8 (${probe.executable}) or the worker plugin (${plugin}) is not available`,
  );
  process.exit(0);
}
let keys = KEYS,
  fetchImpl = fakeSiteData().fetch,
  query = '합성시 가나구 가나동 1';
if (live) {
  const store = new PublicDataKeyStore(
    process.env.VIDE_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'VIDE'),
  );
  for (const key of store.view().keys)
    console.log(`${key.name}: ${key.present ? `present (${key.from})` : 'absent'}`);
  keys = store.read();
  if (!keys.VWORLD_KEY) {
    console.log('skipped: no VWORLD_KEY on this PC');
    process.exit(0);
  }
  fetchImpl = (...args) => fetch(...args);
  query = '서울특별시 중구 태평로1가 31';
}

const directory = runDirectory(live ? 'rhino-site-massing-live' : 'rhino-site-massing');
const options = sdkOptions(directory),
  connectionDirectory = join(directory, 'rhino-connections');
options.plugin = plugin;
const SITE_ROOT = 'VIDE::대지';
const MASS_ROOT = 'VIDE::매스';
const SITE_BAKES = ['targets', 'outline', 'parcels', 'roads', 'buildings', 'siteInfo'];
const build = `
var iOther = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "기타" });
{ var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = iOther }; doc.Objects.AddBox(new Box(new BoundingBox(-900, -900, 0, -899, -899, 1)), a); }
return doc.Objects.Count;`;

const wait = async (fn, ms = 180000) => {
  const end = Date.now() + ms;
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

/** After the test: put the installed VIDE's Rhino plugin registration back (launch.json token). */
async function restoreInstalledPlugin() {
  try {
    const launch = JSON.parse(
      await readFile(join(process.env.LOCALAPPDATA ?? '', 'VIDE', 'launch.json'), 'utf8'),
    );
    const url = new URL(launch.url);
    const origin = url.origin;
    const session = await fetch(new URL('/api/v1/session', origin), {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: url.hash.slice(1) }),
      signal: AbortSignal.timeout(5000),
    });
    const cookie = session.headers.get('set-cookie')?.split(';')[0];
    if (!session.ok || !cookie) return { restored: false, status: session.status };
    const install = await fetch(new URL('/api/v1/connectors/rhino8/install', origin), {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie },
      signal: AbortSignal.timeout(60000),
    });
    return { restored: install.ok, status: install.status };
  } catch (error) {
    return { restored: false, error: String(error) };
  }
}

const decode = (value) => Buffer.from(value, 'base64').toString('utf8');
const attrsOf = (row) =>
  Object.fromEntries((row.attributes64 ?? []).map(([k, v]) => [decode(k), decode(v)]));
const timed = async (timings, name, fn) => {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = Math.round(performance.now() - started);
  }
};

let worker, host, f, clawde;
const result = { directory, live, timings: {} };
const T = result.timings;
try {
  // 1. A synthetic document, saved by a work copy, then open in a VIDE-owned hidden Rhino.
  await timed(T, 'rhinoStartMs', async () => {
    worker = await launchRhinoWorker({ ...options, directory: join(directory, 'create') });
    const receipt = await worker.execute(randomUUID(), 0, build);
    assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 400));
    await worker.stop();
    worker = undefined;
    result.documentSource = receipt.filename;
  });
  const attachedDirectory = join(directory, 'attached');
  await mkdir(attachedDirectory);
  const source = join(attachedDirectory, 'synthetic-site-massing.3dm');
  await copyFile(result.documentSource, source);
  const script = join(attachedDirectory, 'fixture.py');
  await writeFile(
    script,
    `import Rhino, System, json, os, traceback
folder=${JSON.stringify(attachedDirectory.replaceAll('\\', '/'))}
plugin=${JSON.stringify(options.plugin.replaceAll('\\', '/'))}
source=${JSON.stringify(source.replaceAll('\\', '/'))}
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
        last=action['id']
        scope={'doc':Rhino.RhinoDoc.ActiveDoc,'Rhino':Rhino,'System':System,'result':None}
        exec(action['code'],scope)
        report('action-'+str(last),dict(ok=True,value=scope.get('result')))
    except Exception as e: report('action-'+str(last),dict(ok=False,error=str(e),trace=traceback.format_exc()))
try:
    opened,already=Rhino.RhinoDoc.Open(source)
    doc=Rhino.RhinoDoc.ActiveDoc
    assert doc.Path and doc.Path.lower().replace('\\\\','/')==source.lower(), doc.Path
    loaded,pid=Rhino.PlugIns.PlugIn.LoadPlugIn(plugin)
    assembly=[a for a in System.AppDomain.CurrentDomain.GetAssemblies() if a.GetName().Name=='VIDE.Worker'][0]
    connect=assembly.GetType('Vide.Worker.AttachedConnection').GetMethod('Connect',System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic)
    connect.Invoke(None,System.Array[System.Object]([doc]))
    Rhino.RhinoApp.Idle+=idle
    report('ready',dict(ok=True,objects=int(doc.Objects.Count),units=str(doc.ModelUnitSystem),rhino=str(Rhino.RhinoApp.Version)))
except Exception as e: report('ready',dict(ok=False,error=str(e),trace=traceback.format_exc()))
`,
  );
  const ready = await timed(T, 'rhinoOpenMs', async () => {
    host = await launchOwnedHost({
      executable: options.executable,
      environment: { ...process.env, VIDE_CONNECT_DIR: connectionDirectory },
      visible: false,
      spawnProcess: (file, args, o) => spawn(file, args, { ...o, windowsVerbatimArguments: true }),
      args: [
        '/nosplash',
        '/notemplate',
        '/scheme=VIDE-Worker-Test',
        `/runscript="_-RunPythonScript (${script})"`,
      ],
    });
    return wait(async () =>
      JSON.parse(await readFile(join(attachedDirectory, 'ready.json'), 'utf8')),
    );
  });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  result.rhino = ready.rhino;
  let step = 0;
  const action = async (code) => {
    step++;
    await writeFile(join(attachedDirectory, 'action.tmp'), JSON.stringify({ id: step, code }));
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(join(attachedDirectory, 'action.tmp'), join(attachedDirectory, 'action.json'));
        break;
      } catch (error) {
        if (error.code !== 'EPERM' || attempt === 19) throw error;
        await new Promise((accept) => setTimeout(accept, 50));
      }
    }
    const r = await wait(async () =>
      JSON.parse(await readFile(join(attachedDirectory, 'action-' + step + '.json'), 'utf8')),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.value;
  };
  const sessions = new EditorSessions({ ...options, connectionDirectory });
  const sdk = new SdkExecution({ ...options, connectionDirectory, tools: {}, origin: () => '' });
  const catalog = await sessions.list(true);
  assert.equal(catalog.documents.length, 1);
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };

  // 2. The engine: project, link and Sync, the chain's services (fake cLAWde, public data).
  clawde = await startFakeClawde();
  let links, execution;
  f = await chainEngine({
    root: join(directory, 'engine'),
    keys,
    fetch: fetchImpl,
    clawde,
    jigContext: {
      get links() {
        return links;
      },
      sdk,
      get execution() {
        return execution;
      },
    },
  });
  links = new DocumentLinks(f.store);
  execution = new Execution(f.workspace, { sdk });
  const link = links.link(f.project.id, {
    host: 'rhino',
    name: 'synthetic-site-massing.3dm',
    path: source,
    instance: target.instance,
    documentId: target.documentId,
  });
  const syncRecord = async (id) => {
    const display = await sdk.syncEditor(target, () => {});
    soleDb(f.store)
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        id,
        f.project.id,
        JSON.stringify({
          id,
          body: 'Sync',
          permission: 'review',
          provider: 'claude-cli',
          pins: [],
          sketches: [],
          files: [],
          host: 'rhino',
          source: 'document',
          linkId: link.id,
          sourceDocument: target,
        }),
        'succeeded',
        JSON.stringify({ ...display, hostExecuted: true }),
        new Date().toISOString(),
      );
    return display;
  };
  await syncRecord('sync-1');
  await f.client.meta();

  // 3. 사이트 모델링: address → lot → collect → compute → the person confirms.
  const site = await timed(T, 'siteModelMs', () =>
    siteModel(f, { query, ...(live ? { radius: 100 } : {}) }),
  );
  Object.assign(T, {
    lookupMs: site.timings.lookupMs,
    collectMs: site.timings.collectMs,
    siteComputeMs: site.timings.computeMs,
  });
  assert.equal(site.found, undefined, JSON.stringify(site.found));
  for (const id of ['collect', 'frame', 'roads', 'buildings', 'summary'])
    assert.equal(statusOf(site.report, id), 'done', id);
  const so = site.report.outputs;
  result.site = {
    pnus: so.summary.pnus.length,
    officialArea_m2: so.summary.officialArea_m2,
    computedArea_m2: so.summary.computedArea_m2,
    areaGap_pct: so.summary.areaGap_pct,
    parcels: so.frame.parcels.length,
    roads: so.roads.curves.length,
    buildings: so.buildings.buildings.length,
    convergenceDeg: so.frame.convergenceDeg,
    sources: so.collect.sources.map((s) => `${s.key}=${s.status}:${s.count}`).join(' '),
  };

  // 4. Rhino에 만들기 of the site model.
  const siteBake = await timed(T, 'siteBakeMs', () =>
    f.jig('POST', `${f.base}/${site.id}/bake`, { bake: SITE_BAKES, linkId: link.id }),
  );
  assert.equal(siteBake.status, 200, JSON.stringify(siteBake.data).slice(0, 800));
  assert.deepEqual(
    siteBake.data.bake.bakes.flatMap((b) => b.failed),
    [],
  );
  result.siteBakeTotals = siteBake.data.bake.totals;

  // 5. 법규: profile from the model, the 일조 answer, its chips resolve to Rhino's objects.
  const legalStarted = performance.now();
  const read = await f.legal.syncModel(f.project.id);
  assert.ok(read.includes('site.pnu') && read.includes('site.area'));
  const sun = await askConfirmed(f.legal, f.project.id, '일조 사선 제한을 받나요?');
  await askConfirmed(f.legal, f.project.id, '조경 기준을 받나요?');
  T.legalMs = Math.round(performance.now() - legalStarted);
  const answer = await f.legal.get(f.project.id, sun.number);
  const siteChip = answer.targets.find((c) => c.kind === 'site');
  assert.equal(siteChip.found, true, JSON.stringify(answer.targets));
  const chipIds = siteChip.objects.flatMap((o) => o.nativeIds);
  assert.ok(siteChip.objects.every((o) => o.linkId === link.id));
  assert.ok(chipIds.length >= 1);
  const inRhino = await action(
    `result=[i for i in ${JSON.stringify(chipIds)} if doc.Objects.FindId(System.Guid(i)) is not None]`,
  );
  assert.deepEqual(inRhino.sort(), [...chipIds].sort(), 'every chip object is in Rhino');
  // The viewport selects by the Sync's display ids (sourceId = Rhino object id, ui/layers.ts).
  const display = await syncRecord('sync-2');
  const shown = new Set(
    (display.objects ?? []).map((o) => (typeof o.sourceId === 'string' ? o.sourceId : o.id)),
  );
  const highlighted = chipIds.filter((id) => shown.has(id));
  assert.deepEqual(highlighted.sort(), [...chipIds].sort(), 'the chip objects are in the Sync');
  result.chip = {
    label: siteChip.label,
    objects: chipIds.length,
    inRhino: inRhino.length,
    inSync: highlighted.length,
    adjacent: answer.targets.find((c) => c.kind === 'adjacent')?.found ?? null,
  };

  // 6. 가능 매스 from the layers read back from Rhino, with the legal constraints.
  const boundary = so.frame.targets.length > 1 ? '대지 경계' : '대상 필지';
  const massWith = (params, title) =>
    buildableMass(f, {
      boundary,
      title,
      // The site model's 진북 correction, typed by the person (the mass jig does not read it).
      params: { convergenceDeg: so.frame.convergenceDeg ?? 0, northBasis: 'true', ...params },
      layerRoot: MASS_ROOT,
      readFrom: async (instanceId, layers) => {
        const started = performance.now();
        const r = await f.jig('POST', `${f.base}/${instanceId}/reads`, {
          linkId: link.id,
          layers,
          purpose: 'assembly',
        });
        T.massReadMs = Math.round(performance.now() - started);
        assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 400));
        result.massRead = { objects: r.data.objectCount };
        return r.data.readId;
      },
    });
  let mass = await timed(T, 'massMs', () => massWith({}, '매스 검토'));
  const envelopeStep = mass.report.steps.find((s) => s.id === 'envelope');
  if (live && envelopeStep.status === 'failed') {
    // VERIFY-2026-10-08-site-massing 발견: the 3D 돌출 외피 of a real lot with many road segments
    // fails its closed-solid check. Recorded, then the chain goes on with the road setback off
    // (a test variant, not a reading) so the rest of the chain still reaches Rhino.
    result.massFirstAttempt = {
      envelope: envelopeStep.error?.message,
      segments: mass.report.outputs.site?.segments.length,
      buildableArea_m2: mass.report.outputs.buildable?.area,
    };
    mass = await timed(T, 'massRetryMs', () =>
      massWith({ roadSetbackState: 'none' }, '매스 검토(건축선 후퇴 끔)'),
    );
  }
  T.massComputeMs = mass.computeMs;
  const mo = mass.report.outputs;
  for (const id of ['site', 'regulations', 'buildable', 'envelope', 'alternatives', 'handoff'])
    assert.equal(
      statusOf(mass.report, id),
      'done',
      `${id}: ${JSON.stringify(mass.report.steps.find((s) => s.id === id)?.error)}`,
    );
  const sunItem = mo.regulations.items.find((i) => i.id === 'sunNearDistance');
  assert.deepEqual([sunItem.value, sunItem.origin], [1.5, '서비스 확정']);
  result.mass = {
    siteArea_m2: mo.site.area_m2,
    segments: mo.site.segments.map((s) => s.kind).join(','),
    alternatives: mo.alternatives.rows.map((r) => `${r.id} ${r.floorsAbove}F ${r.farArea}`),
    unresolved: mo.limits.unresolved.length,
  };

  // 7. Rhino에 만들기 of the masses: closed outward solids with the engine's volumes.
  const massBake = await timed(T, 'massBakeMs', () =>
    f.jig('POST', `${f.base}/${mass.id}/bake`, {
      bake: ['limitLines', 'alternativeMasses'],
      linkId: link.id,
    }),
  );
  assert.equal(massBake.status, 200, JSON.stringify(massBake.data).slice(0, 800));
  assert.deepEqual(
    massBake.data.bake.bakes.flatMap((b) => b.failed),
    [],
  );
  const rows = (await sdk.readLayers(target, { includeHidden: true })).scene.filter(
    (row) => attrsOf(row)['vide-instance'] === mass.id,
  );
  const solids = rows.filter((row) => decode(row.layer64).endsWith('::대안 매스'));
  assert.ok(solids.length > 0);
  const measured = await action(
    `out={}
for i in ${JSON.stringify(solids.map((row) => row.nativeId))}:
    b=doc.Objects.FindId(System.Guid(i)).Geometry
    if isinstance(b, Rhino.Geometry.Extrusion): b=b.ToBrep()
    m=Rhino.Geometry.VolumeMassProperties.Compute(b,True,False,False,False)
    out[i]=[b.IsSolid,b.IsValid,str(b.SolidOrientation),m.Volume if m else None]
result=out`,
  );
  let bad = 0;
  for (const row of solids) {
    const [solid, valid, orientation, volume] = measured[row.nativeId];
    if (!(solid && valid && orientation === 'Outward' && volume > 0)) bad++;
  }
  assert.equal(bad, 0, 'every floor mass is a closed outward solid');
  result.massBake = { solids: solids.length, totals: massBake.data.bake.totals };

  // 8. 건축개요: both earlier results, the page and the two CSVs.
  const summary = await timed(T, 'summaryMs', () => buildingSummary(f));
  for (const id of ['sources', 'summary', 'check'])
    assert.equal(statusOf(summary.report, id), 'done', id);
  const ss = summary.report.outputs.summary;
  assert.equal(summary.report.outputs.check.ok, true);
  assert.equal(summary.report.outputs.sources.site.title, '대지');
  assert.ok(summary.page.html.length > 0, JSON.stringify(summary.page.model.exportRefused));
  const panel = JSON.parse(
    await readFile('src/jigs/official/jigs/building-summary/panel.json', 'utf8'),
  );
  const tab = (title) => panel.drawer.tabs.find((t) => t.title === title);
  const csv = {
    overview: toCsv(summary.report.outputs.check.overview, tab('건축개요').columns),
    floors: toCsv(summary.report.outputs.check.floors, tab('층별 면적표').columns),
  };
  await writeFile(join(directory, 'summary.html'), summary.page.html);
  await writeFile(join(directory, 'overview.csv'), csv.overview);
  await writeFile(join(directory, 'floors.csv'), csv.floors);
  result.summary = {
    alternative: ss.alternative,
    gfaTotal: ss.gfaTotal,
    unconfirmed: ss.unconfirmedCount,
    needsInput: ss.needsInputCount,
    htmlBytes: summary.page.html.length,
    csvLines: [csv.overview.split('\r\n').length - 1, csv.floors.split('\r\n').length - 1],
  };
  for (const value of Object.values(keys))
    if (value)
      assert.ok(
        !JSON.stringify([so, mo.handoff, ss, summary.page.html]).includes(value),
        'no key in the chain',
      );

  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  try {
    await f?.close();
  } catch (error) {
    console.error('engine close: ' + String(error));
  }
  await clawde?.close();
  await worker?.stop();
  await host?.stop();
  if (process.env.VIDE_TEST_KEEP_REGISTRATION !== '1') {
    const restored = await restoreInstalledPlugin();
    console.log('installed plugin registration: ' + JSON.stringify(restored));
  }
}
