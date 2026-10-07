// Output tokens and the unchanged AI code policy (PLAN-47 T-226, SPEC-14.7·14.14 1). The real
// ZWCAD write is tests/integration/zwcad-drawing-output.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OutputTokens,
  backflowName,
  dwgVersionOf,
  validOutputName,
} from '../../src/core/drawing-output.ts';
import { writeDrawingCopy } from '../../hosts/zwcad/drawing-output.ts';
import { checkRhinoPython, checkRhinoCommand } from '../../src/contracts/rhino-script-policy.ts';

async function workRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'vide-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'work', 'out'), { recursive: true });
  return root;
}
const dwg = (magic) => Buffer.concat([Buffer.from(magic, 'latin1'), Buffer.alloc(64)]);

test('a token writes only its own new files, once, inside the work root', async (t) => {
  const root = await workRoot(t);
  const work = join(root, 'work'),
    out = join(work, 'out');
  const tokens = new OutputTokens({ workRoot: work });
  const token = tokens.issue({ folder: out, names: ['평면-VIDE반영.dwg'], version: 'AC1027' });
  assert.equal(token.kind, 'work');
  const target = join(out, '평면-VIDE반영.dwg');
  assert.deepEqual(tokens.authorize(token.id, target), { path: target, version: 'AC1027' });
  // Case differences of the same path are the same file on Windows.
  if (process.platform === 'win32')
    assert.equal(tokens.authorize(token.id, target.toUpperCase()).path, target);
  for (const path of [join(out, 'other.dwg'), join(work, '평면-VIDE반영.dwg'), 'relative.dwg'])
    assert.throws(() => tokens.authorize(token.id, path), /OUTPUT_PATH_DENIED/, path);
  assert.throws(
    () => tokens.authorize(token.id, join(out, '..', 'out', '..', '평면-VIDE반영.dwg')),
    /OUTPUT_PATH_DENIED/,
  );
  assert.throws(() => tokens.authorize('forged', target), /OUTPUT_TOKEN_INVALID/);
  // Never overwrite: a file that appeared after the token was issued is refused.
  await writeFile(target, 'user file');
  assert.throws(() => tokens.authorize(token.id, target), /OUTPUT_EXISTS/);
  await rm(target);
  tokens.written(token.id, target);
  assert.throws(() => tokens.authorize(token.id, target), /OUTPUT_PATH_USED/);
  assert.deepEqual(tokens.grant(token.id).files, []);
  tokens.revoke(token.id);
  assert.throws(() => tokens.grant(token.id), /OUTPUT_TOKEN_INVALID/);
});

test('issuing refuses folders outside the work root unless confirmed, bad names and versions', async (t) => {
  const root = await workRoot(t);
  const work = join(root, 'work');
  let now = 1000;
  const tokens = new OutputTokens({ workRoot: work, now: () => now, ttlMs: 60_000 });
  // The user's folder needs the save card's confirmation (SPEC-14.7 4).
  assert.throws(
    () => tokens.issue({ folder: root, names: ['a.dwg'], version: 'AC1027' }),
    /OUTPUT_PATH_DENIED/,
  );
  assert.throws(
    () => tokens.issue({ folder: join(work, '..'), names: ['a.dwg'], version: 'AC1027' }),
    /OUTPUT_PATH_DENIED/,
  );
  const confirmed = tokens.issue({
    folder: root,
    names: ['a.dwg'],
    version: 'AC1032',
    confirmed: true,
  });
  assert.equal(confirmed.kind, 'confirmed');
  await writeFile(join(root, 'taken.dwg'), 'x');
  assert.throws(
    () => tokens.issue({ folder: root, names: ['taken.dwg'], version: 'AC1027', confirmed: true }),
    /OUTPUT_EXISTS/,
  );
  for (const names of [
    [],
    ['a.dxf'],
    ['..\\a.dwg'],
    ['sub/a.dwg'],
    ['CON.dwg'],
    ['a .dwg'],
    ['a.dwg', 'A.DWG'],
    ['~vide-x.dwg'],
  ])
    assert.throws(
      () => tokens.issue({ folder: work, names, version: 'AC1027' }),
      /OUTPUT_NAME_INVALID/,
      JSON.stringify(names),
    );
  for (const version of ['AC1009', 'AC1014', 'ac1027', 'Current', ''])
    assert.throws(
      () => tokens.issue({ folder: work, names: ['a.dwg'], version }),
      /OUTPUT_VERSION_INVALID/,
    );
  // Tokens expire.
  const token = tokens.issue({ folder: work, names: ['b.dwg'], version: 'AC1027' });
  now += 60_001;
  assert.throws(() => tokens.authorize(token.id, join(work, 'b.dwg')), /OUTPUT_TOKEN_INVALID/);
  assert.ok(validOutputName('평면도 1층.dwg') && !validOutputName('a.dwg.bak'));
});

test('the DWG version comes from the header; the copy name follows SPEC-14.7 2', async (t) => {
  const root = await workRoot(t);
  for (const magic of ['AC1027', 'AC1032', 'AC1015']) {
    await writeFile(join(root, magic + '.dwg'), dwg(magic));
    assert.equal(await dwgVersionOf(join(root, magic + '.dwg')), magic);
  }
  await writeFile(join(root, 'old.dwg'), dwg('AC1009'));
  await assert.rejects(dwgVersionOf(join(root, 'old.dwg')), /OUTPUT_VERSION_INVALID/);
  const at = new Date(2026, 9, 7, 9, 5);
  assert.equal(backflowName('C:\\p\\A-101.DWG', at), 'A-101-VIDE반영-20261007-0905.dwg');
  const taken = new Set(['A-101-VIDE반영-20261007-0905.dwg']);
  assert.equal(
    backflowName('A-101.dwg', at, (name) => taken.has(name)),
    'A-101-VIDE반영-20261007-0905-2.dwg',
  );
});

test('the engine refuses before any host starts; a stopped host leaves no file', async (t) => {
  const root = await workRoot(t);
  const work = join(root, 'work'),
    out = join(work, 'out');
  const source = join(work, 'src.dwg');
  await writeFile(source, dwg('AC1032'));
  const tokens = new OutputTokens({ workRoot: work });
  const token = tokens.issue({ folder: out, names: ['a.dwg', 'b.dwg'], version: 'AC1027' });
  let runs = 0;
  const run = async () => {
    runs++;
    throw Object.assign(new Error('HIDDEN_HOST_EXITED'), { code: 'HIDDEN_HOST_EXITED' });
  };
  const write = (target, extra) =>
    writeDrawingCopy({ tokens, token: token.id, source, target, work, run, ...extra });
  // A 2018 source cannot go out as 2013, a path outside the token cannot be written.
  await assert.rejects(write(join(out, 'a.dwg')), /OUTPUT_VERSION_MISMATCH/);
  await assert.rejects(write(join(root, 'a.dwg')), /OUTPUT_PATH_DENIED/);
  assert.equal(runs, 0);
  await writeFile(source, dwg('AC1027'));
  // The grant handed to the worker names the token's files, folder and version only.
  let grant;
  const failing = async (options) => {
    runs++;
    grant = JSON.parse(await readFile(options.environment.VIDE_OUTPUT_GRANT, 'utf8'));
    assert.equal(options.environment.VIDE_OUTPUT_TOKEN, token.id);
    assert.equal(options.command, 'VIDEDRAWINGCOPY');
    return run();
  };
  await assert.rejects(write(join(out, 'a.dwg'), { run: failing }), /HIDDEN_HOST_EXITED/);
  assert.deepEqual(grant.files, [join(out, 'a.dwg'), join(out, 'b.dwg')]);
  assert.equal(grant.version, 'AC1027');
  assert.equal(grant.folder, out);
  assert.deepEqual(await readdir(out), []);
  // The host died after the file appeared: unclear, and the path is not granted again.
  const halfway = async () => {
    await writeFile(join(out, 'b.dwg'), dwg('AC1027'));
    return run();
  };
  await assert.rejects(write(join(out, 'b.dwg'), { run: halfway }), /OUTPUT_UNCLEAR/);
  assert.throws(() => tokens.authorize(token.id, join(out, 'b.dwg')), /OUTPUT_PATH_USED/);
});

// ZWCAD and Rhino cannot run here; these source checks keep the AI code policy as it was
// (SPEC-14.14 1): engine writes go through tokens, generated code still cannot save, export or
// attach xrefs.
const source = (path) => readFile(new URL('../../' + path, import.meta.url), 'utf8');

test('ZWCAD AI code still cannot save, export or attach xrefs', async () => {
  const policy = await source('hosts/zwcad/worker/SdkCompiler.cs');
  const list = (name) =>
    [...new RegExp(`${name} =\\s*\\{([\\s\\S]*?)\\};`).exec(policy)[1].matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    );
  for (const member of ['Save', 'SaveAs', 'AttachXref', 'OverlayXref', 'DxfOut', 'ReadDwgFile'])
    assert.ok(list('DeniedDatabaseMembers').includes(member), member);
  // Plotting/publishing (file export), the application's documents, files and Vide.* (the grant).
  for (const ns of [
    'System.IO',
    'ZwSoft.ZwCAD.ApplicationServices',
    'ZwSoft.ZwCAD.PlottingServices',
    'ZwSoft.ZwCAD.Publishing',
    'Vide',
  ])
    assert.ok(list('DeniedNamespaces').includes(ns), ns);
});

test('Rhino AI code still cannot save or export', async () => {
  const policy = await source('hosts/rhino/worker/CodePolicy.cs');
  assert.match(policy, /"Rhino\.FileIO"/);
  assert.match(policy, /"Export"/);
  assert.ok(policy.includes('symbol.Name.StartsWith("Save", StringComparison.Ordinal)'));
  const scripts = await source('hosts/rhino/worker/DirectScripts.cs');
  assert.match(scripts, /CommandConfirm/);
  // The engine's copies of these lists still hold saves and exports for the card or refuse them.
  for (const code of [
    'import rhinoscriptsyntax as rs\nrs.Command("_-Export x.dwg")',
    'sc.doc.SaveAs("x.3dm")',
  ])
    assert.notDeepEqual(checkRhinoPython(code), { ok: true }, code);
  for (const command of ['_-Export', '_-SaveAs', '_-Save'])
    assert.notDeepEqual(checkRhinoCommand(command), { ok: true }, command);
});

test('worker saves outside the grant are only the listed engine work-copy paths', async () => {
  const folder = new URL('../../hosts/zwcad/worker/', import.meta.url);
  const files = (await readdir(folder)).filter((name) => name.endsWith('.cs'));
  const saving = [];
  for (const name of files) {
    const text = await readFile(new URL(name, folder), 'utf8');
    if (/\.SaveAs\(/.test(text)) saving.push(name);
  }
  // OutputGrant is the token path. The others write only engine-made files in its work folder
  // (candidates, session files) or synthetic test fixtures, never a user folder; new drawing
  // writes must use OutputGrant (PLAN-47 T-226).
  assert.deepEqual(saving.sort(), [
    'DrawingOutput.cs',
    'DrawingSheets.cs',
    'DwgEditor.cs',
    'EditorSession.cs',
    'OutputGrant.cs',
    'SdkSession.cs',
    'XrefGraph.cs',
  ]);
  const output = await readFile(new URL('DrawingOutput.cs', folder), 'utf8');
  // In DrawingOutput.cs only the synthetic fixture saves directly; the copy goes through the grant.
  assert.equal(output.match(/\.SaveAs\(/g).length, 1);
  assert.match(output, /static void Synthetic[\s\S]*db\.SaveAs\(path, version\)/);
  assert.match(output, /grant\.Stage\(db, target\)/);
  // The title block read (T-235) saves only its synthetic fixture.
  const sheets = await readFile(new URL('DrawingSheets.cs', folder), 'utf8');
  assert.equal(sheets.match(/\.SaveAs\(/g).length, 1);
  assert.match(sheets, /static void Save\(string path[\s\S]*db\.SaveAs\(path, version\)/);
  assert.doesNotMatch(sheets.split('VIDEDRAWINGSHEETSFIXTURE')[0], /\.SaveAs\(|\.Save\(/);
});

test('worker and connection code never read the ZWCAD members that crash the host', async () => {
  const safe = await source('hosts/zwcad/worker/SafeRead.cs');
  const avoided = [.../Avoided =\s*\{([\s\S]*?)\};/.exec(safe)[1].matchAll(/"([^"]+)"/g)].map(
    (m) => m[1],
  );
  // T-225 질문 4 (SPIKE-2026-10-07-drawing-backflow 결과 4): seven more, all crash ZWCAD 2023.
  assert.deepEqual(avoided.sort(), [
    'Curve.Spline',
    'Dimension.CenterMarkSize',
    'Dimension.CenterMarkType',
    'Dimension.Dimblk1s',
    'Dimension.Dimblk2s',
    'Dimension.Dimblks',
    'Dimension.Dimldrblks',
    'Dimension.TextStyleId',
  ]);
  // Members only a dimension or a curve has: never read anywhere. Arrowheads come from the
  // dimension style record (SafeRead.DimensionArrows).
  const never = avoided
    .filter((name) => name !== 'Dimension.TextStyleId')
    .map((name) => name.split('.')[1]);
  for (const dir of ['hosts/zwcad/worker/', 'hosts/zwcad/connection/']) {
    const folder = new URL('../../' + dir, import.meta.url);
    for (const name of (await readdir(folder)).filter((n) => n.endsWith('.cs'))) {
      const text = await readFile(new URL(name, folder), 'utf8');
      // Text style ids of DBText/MText are safe; a dimension's is read through its style.
      const code = text
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/"[^"\n]*"/g, '""');
      for (const match of code.matchAll(/(\w+)\.TextStyleId\b/g))
        assert.doesNotMatch(match[1], /^dim/i, `${dir}${name}: ${match[0]}`);
      for (const member of never)
        assert.doesNotMatch(code, new RegExp(`\\.${member}\\b`), `${dir}${name}: ${member}`);
    }
  }
  assert.match(safe, /DimensionArrows[\s\S]*style\.Dimblk[\s\S]*style\.Dimldrblk/);
});
