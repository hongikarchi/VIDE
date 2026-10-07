// 역반영 적용 on an OPEN drawing with the real ZWCAD 2023 (PLAN-47 T-233, SPEC-14.11 1, ADR-022,
// H-ZWCAD-16). Skipped when ZWCAD 2023 or the .NET SDK is missing. This test starts its OWN ZWCAD
// with a new synthetic drawing (a line, an arc-segment polyline, an arc, a circle, a block insert
// drawn by the start script) and a test harness (fixtures/ZwcadBackflowActions.cs) built here with
// the shared operations (hosts/zwcad/worker/BackflowOps.cs) the connection plugin's
// `backflow-read`/`backflow-apply` use, run the same way: the apply is one command (one UNDO step)
// that commits only when every op is accepted. Checks: every type changes in place (handle, layer,
// properties kept, origin marks), the preservation check finds nothing but the rows, a refused op
// leaves the drawing as it was, and ZWCAD's U brings every entity and object back. (The installed
// VIDE plugin loads at ZWCAD start, so a newer plugin copy cannot be NETLOADed here.)
// Only the process started here is stopped; the user's own ZWCAD is never touched.
// Run: node tests/integration/zwcad-backflow-attached.mjs
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { inspectorOptions } from '../../hosts/zwcad/inspector.ts';
import { preservation, stateFromRow } from '../../src/core/drawing-backflow-apply.ts';
import { runDirectory } from './run-directory.mjs';

const config = inspectorOptions();
const zwcad = 'C:/Program Files/ZWSOFT/ZWCAD 2023';
try {
  await access(config.executable);
  execFileSync('dotnet', ['--version'], { windowsHide: true });
} catch {
  console.log(JSON.stringify({ skipped: 'ZWCAD 2023 or the .NET SDK is missing' }));
  process.exit(0);
}
const directory = runDirectory('zwcad-backflow-attached');
// The harness: the shared operations and the test actions, in an assembly of its own name.
await mkdir(join(directory, 'harness'));
const project = join(directory, 'harness', 'VIDE.Zwcad.BackflowTest.csproj');
await writeFile(
  project,
  `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net48</TargetFramework><LangVersion>latest</LangVersion><PlatformTarget>x64</PlatformTarget>
  <OutputPath>out/</OutputPath><AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath></PropertyGroup>
  <ItemGroup>
    <Reference Include="System.Web.Extensions" />
    <Reference Include="ZwManaged"><HintPath>${zwcad}/ZwManaged.dll</HintPath><Private>false</Private></Reference>
    <Reference Include="ZwDatabaseMgd"><HintPath>${zwcad}/ZwDatabaseMgd.dll</HintPath><Private>false</Private></Reference>
    <PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies.net48" Version="1.0.3" PrivateAssets="all" />
    <Compile Include="${resolve('hosts/zwcad/worker/BackflowOps.cs')}" />
    <Compile Include="${resolve('tests/integration/fixtures/ZwcadBackflowActions.cs')}" />
  </ItemGroup>
</Project>
`,
);
execFileSync('dotnet', ['build', project, '-nologo', '-v', 'q'], { windowsHide: true });
const harness = join(directory, 'harness', 'out', 'VIDE.Zwcad.BackflowTest.dll');
const script = join(directory, 'start.scr');
const quote = (value) => JSON.stringify(value.replaceAll('\\', '/'));
await writeFile(
  script,
  [
    '(setvar "INSUNITS" 4)',
    '(entmake (list (cons 0 "LINE") (cons 62 5) (cons 10 (list 0.0 0.0 0.0)) (cons 11 (list 4000.0 0.0 0.0))))',
    '(entmake (list (cons 0 "LWPOLYLINE") (cons 100 "AcDbEntity") (cons 100 "AcDbPolyline") (cons 90 3) (cons 70 0) (cons 10 (list 0.0 1000.0)) (cons 42 0.0) (cons 10 (list 2000.0 1000.0)) (cons 42 0.5) (cons 10 (list 3000.0 2000.0)) (cons 42 0.0)))',
    '(entmake (list (cons 0 "ARC") (cons 10 (list 6000.0 0.0 0.0)) (cons 40 1000.0) (cons 50 0.0) (cons 51 1.5707963267948966)))',
    '(entmake (list (cons 0 "CIRCLE") (cons 10 (list 6000.0 3000.0 0.0)) (cons 40 500.0)))',
    '(entmake (list (cons 0 "BLOCK") (cons 2 "VIDECHAIR") (cons 70 0) (cons 10 (list 0.0 0.0 0.0))))',
    '(entmake (list (cons 0 "LINE") (cons 10 (list 0.0 0.0 0.0)) (cons 11 (list 450.0 0.0 0.0))))',
    '(entmake (list (cons 0 "ENDBLK")))',
    '(entmake (list (cons 0 "INSERT") (cons 2 "VIDECHAIR") (cons 10 (list 1000.0 3000.0 0.0))))',
    `(command "_NETLOAD" ${quote(harness)})`,
    'VIDETestBackflow',
    `(setq videTestFile (open ${quote(join(directory, 'ready.txt'))} "w"))`,
    '(write-line "ok" videTestFile)',
    '(close videTestFile)',
    '',
  ].join('\n'),
);
const owner = await launchOwnedHost({
  executable: config.executable,
  args: ['/b', script],
  visible: false,
  environment: { ...process.env, VIDE_BACKFLOW_TEST_ACTIONS: directory },
});
const wait = async (file, ms = 90000) => {
  const deadline = Date.now() + ms;
  while (true) {
    try {
      const text = await readFile(file, 'utf8');
      await rm(file);
      return text;
    } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() > deadline) throw error;
    }
    await new Promise((accept) => setTimeout(accept, 200));
  }
};
const act = async (action, ops) => {
  if (ops) await writeFile(join(directory, 'ops.json'), JSON.stringify(ops));
  await writeFile(join(directory, 'action.txt'), action);
  return JSON.parse(await wait(join(directory, 'result.json')));
};
const timings = {};
try {
  await wait(join(directory, 'ready.txt'));
  let at = Date.now();
  const first = stateFromRow(await act('read'));
  timings.readMs = Date.now() - at;
  const of = (kind) => first.entities.find((e) => e.geometry?.kind === kind);
  const line = of('line'),
    bent = of('polyline'),
    arc = of('arc'),
    circle = of('circle'),
    chair = of('insert');
  assert.deepEqual(bent.geometry.bulges, [0, 0.5, 0]);
  assert.equal(chair.geometry.block, 'VIDECHAIR');
  assert.equal(line.props.color, 5);
  const P = (x, y) => [x, y, 0];
  const ops = [
    {
      id: 'B1',
      op: 'modify',
      handle: line.handle,
      geometry: { kind: 'line', points: [P(0, 0), P(4500, 0)] },
      origin: 'L1:a',
    },
    {
      id: 'B2',
      op: 'modify',
      handle: bent.handle,
      geometry: {
        kind: 'polyline',
        points: [P(0, 1000), P(2500, 1000), P(3000, 2500), P(3500, 2500)],
        bulges: [0, -0.3, 0, 0],
        closed: false,
      },
      origin: 'L1:b',
    },
    {
      id: 'B3',
      op: 'modify',
      handle: arc.handle,
      geometry: { kind: 'arc', center: P(6000, 0), radius: 1200, start: 0, end: Math.PI },
      origin: 'L1:c',
    },
    {
      id: 'B4',
      op: 'modify',
      handle: chair.handle,
      geometry: {
        kind: 'insert',
        block: '',
        position: P(1200, 3000),
        rotation: Math.PI / 2,
        scale: [1, 1, 1],
      },
      origin: 'L1:e',
    },
    {
      id: 'B5',
      op: 'add',
      layer: '0',
      geometry: { kind: 'circle', center: P(0, 6000), radius: 300 },
      origin: 'L1:f',
    },
    { id: 'B6', op: 'delete', handle: circle.handle },
  ];
  // A refused op leaves the drawing as it was.
  const refused = await act('apply', [
    ops[0],
    { id: 'X', op: 'add', layer: '없음', geometry: ops[4].geometry, origin: 'L1:x' },
  ]);
  assert.deepEqual([refused.ok, refused.failed[0].code], [false, 'LAYER_MISSING']);
  const unchanged = stateFromRow(await act('read'));
  assert.deepEqual(unchanged.snapshot.digests, first.snapshot.digests);
  at = Date.now();
  const applied = await act('apply', ops);
  timings.applyMs = Date.now() - at;
  assert.equal(applied.ok, true, JSON.stringify(applied.failed));
  const before = stateFromRow(applied.before),
    after = stateFromRow(applied.after);
  const now = new Map(after.entities.map((e) => [e.handle, e]));
  for (const entity of [line, bent, arc, chair]) {
    const changed = now.get(entity.handle);
    assert.equal(changed.layer, entity.layer);
    assert.deepEqual(changed.props, entity.props);
    assert.equal(changed.origin.handle, entity.handle);
    assert.equal(changed.origin.revision, 7);
  }
  assert.ok(!now.has(circle.handle));
  assert.deepEqual(now.get(bent.handle).geometry.bulges, [0, -0.3, 0, 0]);
  assert.equal(now.get(chair.handle).geometry.block, 'VIDECHAIR');
  assert.deepEqual(now.get(chair.handle).geometry.position, [1200, 3000, 0]);
  const added = applied.results.find((r) => r.id === 'B5').handle;
  assert.equal(now.get(added).origin.handle, added);
  const check = preservation(before, after, {
    modified: [line, bent, arc, chair].map((e) => e.handle),
    added: [added],
    deleted: [circle.handle],
  });
  assert.equal(check.ok, true, JSON.stringify(check));
  // ZWCAD's U reverts the whole apply in one step.
  assert.equal((await act('undo')).ok, true);
  const back = stateFromRow(await act('read'));
  assert.deepEqual(back.snapshot.digests, first.snapshot.digests);
  assert.equal(
    Object.keys(back.snapshot.objects).length,
    Object.keys(first.snapshot.objects).length,
  );
  assert.ok(!back.snapshot.tables.regApps.includes('VIDE_ORIGIN'), 'the mark application undone');
  console.log(JSON.stringify({ ok: true, timings }));
} finally {
  await owner.stop();
}
