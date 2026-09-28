import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connectors, RHINO_PLUGIN_ID } from '../../src/server/connectors.ts';

const key = `HKCU\\Software\\McNeel\\Rhinoceros\\8.0\\Plug-ins\\${RHINO_PLUGIN_ID}`;
function fakeRegistry(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async (k, name) => values.get(`${k}|${name}`),
    set: async (k, name, value) => void values.set(`${k}|${name}`, value),
  };
}

test('Rhino plugin installs to the data folder and replaces a development registration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-connectors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const program = join(directory, 'program');
  await mkdir(program, { recursive: true });
  const bundled = join(program, 'VIDE.Worker.rhp');
  await writeFile(bundled, 'plugin v1');
  await writeFile(join(program, 'VIDE.Worker.deps.json'), '{}');
  const registry = fakeRegistry({
    'HKLM\\SOFTWARE\\McNeel\\Rhinoceros\\8.0\\Install|ExePath': 'C:\\Rhino\\Rhino.exe',
    // A development build registered by dragging it into Rhino.
    [`${key}\\PlugIn|FileName`]: 'C:\\dev\\VIDE.Worker.rhp',
    [`${key}|Name`]: 'VIDE.Worker',
  });
  let rhinoRunning = true;
  const data = join(directory, 'data');
  const connectors = new Connectors({
    directory: data,
    bundledRhino: bundled,
    version: '0.2.0',
    registry,
    running: async () => rhinoRunning,
  });
  let [rhino] = await connectors.list();
  assert.equal(rhino.available, true);
  assert.equal(rhino.running, true);
  assert.equal(rhino.plugin, 'other');
  // Not while Rhino runs: it rewrites its registration when it exits.
  await assert.rejects(() => connectors.installRhino(), { code: 'HOST_RUNNING' });
  assert.equal(registry.values.get(`${key}\\PlugIn|FileName`), 'C:\\dev\\VIDE.Worker.rhp');
  rhinoRunning = false;
  [rhino] = await connectors.installRhino();
  assert.equal(rhino.plugin, 'current');
  assert.match(rhino.version, /^0\.2\.0-[0-9a-f]{8}$/);
  const installed = registry.values.get(`${key}\\PlugIn|FileName`);
  assert.ok(installed.startsWith(join(data, 'plugins', 'rhino')));
  assert.ok(existsSync(installed));
  assert.ok(existsSync(join(installed, '..', 'VIDE.Worker.deps.json')));
  assert.equal(registry.values.get(`${key}|LoadMode`), 2);
  // A new program version with a changed plugin shows as an update, installs to a new folder
  // and removes the old copy.
  await writeFile(bundled, 'plugin v2');
  const next = new Connectors({
    directory: data,
    bundledRhino: bundled,
    version: '0.2.1',
    registry,
    running: async () => false,
  });
  [rhino] = await next.list();
  assert.equal(rhino.plugin, 'outdated');
  [rhino] = await next.installRhino();
  assert.equal(rhino.plugin, 'current');
  assert.match(rhino.version, /^0\.2\.1-/);
  assert.equal((await readdir(join(data, 'plugins', 'rhino'))).length, 1);
});

test('fresh PC: registers the plugin the way Rhino does for a dragged-in plugin', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-connectors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundled = join(directory, 'VIDE.Worker.rhp');
  await writeFile(bundled, 'plugin');
  const registry = fakeRegistry({
    'HKLM\\SOFTWARE\\McNeel\\Rhinoceros\\8.0\\Install|ExePath': 'C:\\Rhino\\Rhino.exe',
  });
  const connectors = new Connectors({
    directory: join(directory, 'data'),
    bundledRhino: bundled,
    version: '0.2.0',
    registry,
    running: async () => false,
  });
  assert.equal((await connectors.list())[0].plugin, 'none');
  await connectors.installRhino();
  for (const [name, value] of [
    ['Name', 'VIDE.Worker'],
    ['Type', 16],
    ['IsDotNETPlugIn', 1],
    ['LoadMode', 2],
  ])
    assert.equal(registry.values.get(`${key}|${name}`), value, name);
  // Rhino missing: nothing to install into.
  const none = new Connectors({
    directory: join(directory, 'data'),
    bundledRhino: bundled,
    version: '0.2.0',
    registry: fakeRegistry(),
    running: async () => false,
  });
  assert.equal((await none.list())[0].available, false);
  await assert.rejects(() => none.installRhino(), { code: 'HOST_NOT_INSTALLED' });
});

test('ZWCAD connection plugin installs with its compiler assemblies and loads at startup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-connectors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const program = join(directory, 'program');
  await mkdir(program, { recursive: true });
  const bundled = join(program, 'VIDE.Zwcad.Connection.dll');
  await writeFile(bundled, 'cad plugin v1');
  await writeFile(join(program, 'Microsoft.CodeAnalysis.dll'), 'roslyn');
  const install = String.raw`HKLM\SOFTWARE\ZWSOFT\ZWCAD\2023`;
  const registry = fakeRegistry({ [`${install}|ZWCAD.ko-KR.Version`]: '23.20.3.11' });
  registry.names = async (k) =>
    [...registry.values.keys()]
      .filter((entry) => entry.startsWith(k + '|'))
      .map((e) => e.split('|')[1]);
  const data = join(directory, 'data');
  const connectors = new Connectors({
    directory: data,
    bundledRhino: join(program, 'missing.rhp'),
    bundledZwcad: bundled,
    version: '0.2.3',
    registry,
    // A running ZWCAD does not block it: the copy goes to a new folder, loaded at next start.
    running: async () => true,
  });
  let cad = (await connectors.list()).find((row) => row.id === 'zwcad2023');
  assert.equal(cad.available, true);
  assert.equal(cad.plugin, 'none');
  cad = (await connectors.installZwcad()).find((row) => row.id === 'zwcad2023');
  assert.equal(cad.plugin, 'current');
  const app = String.raw`HKCU\Software\ZWSOFT\ZWCAD\2023\ko-KR\Applications\VIDE`;
  const loader = registry.values.get(`${app}|LOADER`);
  assert.ok(loader.startsWith(join(data, 'plugins', 'zwcad')));
  assert.ok(existsSync(join(loader, '..', 'Microsoft.CodeAnalysis.dll')));
  assert.equal(registry.values.get(`${app}|LOADCTRLS`), 2);
  assert.equal(registry.values.get(`${app}|MANAGED`), 1);
  // Without ZWCAD on the PC there is nothing to install.
  const none = new Connectors({
    directory: data,
    bundledRhino: bundled,
    bundledZwcad: bundled,
    version: '0.2.3',
    registry: { ...fakeRegistry(), names: async () => [] },
    running: async () => false,
  });
  await assert.rejects(() => none.installZwcad(), { code: 'HOST_NOT_INSTALLED' });
});
