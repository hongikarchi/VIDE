// Real ZWCAD (owned synthetic process): display styles, text, hatches and clipped xrefs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { inspectorOptions } from '../../hosts/zwcad/inspector.ts';
import { AttachedZwcadDocuments } from '../../hosts/zwcad/attached-documents.ts';

const directory = resolve('.vide/zwcad-display-styles', randomUUID());
const registry = join(directory, 'zwcad-connections');
await mkdir(registry, { recursive: true });
const config = inspectorOptions(),
  script = join(directory, 'start.scr');
const quote = (value) => JSON.stringify(value.replaceAll('\\', '/'));
const harness = join(directory, 'AttachedActions.dll');
execFileSync(
  join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  [
    '/nologo',
    '/target:library',
    '/out:' + harness,
    '/reference:C:/Program Files/ZWSOFT/ZWCAD 2023/ZwManaged.dll',
    '/reference:C:/Program Files/ZWSOFT/ZWCAD 2023/ZwDatabaseMgd.dll',
    resolve('tests/integration/fixtures/ZwcadAttachedActions.cs'),
  ],
  { windowsHide: true },
);
await writeFile(
  script,
  [
    '(setvar "INSUNITS" 4)',
    `(command "_NETLOAD" ${quote(resolve(process.env.VIDE_TEST_ZWCAD_CONNECTION || '.vide/build/zwcad-connection/VIDE.Zwcad.Connection.dll'))})`,
    `(command "_NETLOAD" ${quote(harness)})`,
    'VIDETestAttachedActions',
    'VIDECADConnect',
    `(setq videTestFile (open ${quote(join(directory, 'ready.txt'))} "w"))`,
    '(write-line "ready" videTestFile)',
    '(close videTestFile)',
    '',
  ].join('\n'),
);
const owner = await launchOwnedHost({
  executable: config.executable,
  args: ['/b', script],
  visible: false,
  environment: {
    ...process.env,
    VIDE_ZWCAD_CONNECT_DIR: registry,
    VIDE_ATTACHED_TEST_ACTIONS: directory,
  },
});
const waitFor = async (name, seconds = 90) => {
  const deadline = Date.now() + seconds * 1000;
  while (true) {
    try {
      return await readFile(join(directory, name), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        throw Error(await readFile(join(directory, 'error.txt'), 'utf8'));
      } catch (inner) {
        if (inner.code !== 'ENOENT') throw inner;
      }
      if (Date.now() > deadline) throw Error('Timed out waiting for ' + name);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
};
try {
  await waitFor('ready.txt');
  await writeFile(join(directory, 'action.txt'), 'styles');
  await waitFor('done.txt');
  const adapter = new AttachedZwcadDocuments(registry);
  const [doc] = await adapter.list();
  const model = await adapter.capture({ instance: doc.instance, documentId: 1 });
  const byType = (type) => model.scene.filter((item) => item.nativeType === type);
  // Layer colour and lineweight resolve through ByLayer.
  const wall = byType('Line').find((item) => item.segments[1] === 30);
  assert.equal(wall.colorIndex, 1);
  assert.equal(wall.lineWeight, 0.5);
  assert.deepEqual(
    wall.segmentStyles.map((run) => [run.n, run.ci, run.lw]),
    [[1, 1, 0.5]],
  );
  // Block: the layer-0 child follows the insert's layer (B-FURN, ACI 5); the A-WALL child stays red.
  const chair = byType('BlockReference').find((item) => item.segments[1] === 32);
  assert.deepEqual(
    chair.segmentStyles.map((run) => [run.n, run.ci, run.lw]),
    [
      [1, 5, 0.18],
      [1, 1, 0.5],
    ],
  );
  // MText: Hangul, multi-line, top-left anchor.
  const label = byType('MText')[0];
  assert.equal(label.texts[0].s, '평면도\n2층');
  assert.deepEqual([label.texts[0].ax, label.texts[0].ay], [0, 3]);
  assert.ok(Math.abs(label.texts[0].h - 0.3) < 1e-9);
  // Solid hatch keeps its hole; pattern hatch becomes lines.
  const hatches = byType('Hatch');
  const solid = hatches.find((item) => item.fills);
  assert.equal(solid.fills[0].loops.length, 2);
  assert.equal(solid.fills[0].ci, 3);
  const pattern = hatches.find((item) => !item.fills);
  assert.ok(pattern.segments.length > 6, 'pattern hatch lines');
  // Xref line (0..10 m) is clipped to the XCLIP rectangle (x ≤ 5 m).
  const xref = byType('BlockReference').find((item) => item.segments[1] === 42);
  const xs = xref.segments.filter((_, index) => index % 3 === 0);
  assert.ok(Math.max(...xs) <= 5 + 1e-9 && Math.max(...xs) > 4.9, 'clipped xref ' + xs);
  assert.equal(model.displayCoverage.omittedTypes.Hatch ?? 0, 0);
  // XCLIP command on a rotated insert: line runs along +Y from (20,50) and is cut at y = 53 m.
  await writeFile(join(directory, 'action.txt'), 'xclip');
  let rotated;
  for (let i = 0; i < 60 && !rotated; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const next = await adapter.capture({ instance: doc.instance, documentId: 1 });
    rotated = next.scene.find(
      (item) =>
        item.nativeType === 'BlockReference' &&
        Math.abs(item.segments[0] - 20) < 1e-6 &&
        Math.abs(item.segments[1] - 50) < 1e-6 &&
        Math.max(...item.segments.filter((_, k) => k % 3 === 1)) < 55,
    );
  }
  assert.ok(rotated, 'XCLIP command boundary applied');
  const ys = rotated.segments.filter((_, k) => k % 3 === 1);
  assert.ok(Math.abs(Math.max(...ys) - 53) < 1e-6, 'rotated clip ' + ys);
  console.log(
    JSON.stringify({
      passed: true,
      layerStyles: true,
      layerZeroInBlocks: true,
      mtext: true,
      solidHatchWithHole: true,
      patternHatch: true,
      clippedXref: true,
      xclipCommand: true,
      coverage: model.displayCoverage,
      directory,
    }),
  );
} finally {
  await owner.stop();
}
