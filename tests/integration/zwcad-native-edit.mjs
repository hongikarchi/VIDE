// Exercise built-in CAD commands in an owned synthetic editor, without mouse control or AI calls.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { ZwcadEditors } from '../../hosts/zwcad/editor-sessions.ts';
import { inspectDwg, inspectorOptions } from '../../hosts/zwcad/inspector.ts';

const source = JSON.parse(await readFile(process.argv[2], 'utf8')).result;
const directory = resolve('.vide/zwcad-native-edit', randomUUID());
await mkdir(directory, { recursive: true });
const config = inspectorOptions();
const harness = join(directory, 'NativeCommands.dll');
execFileSync(join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
  '/nologo',
  '/target:library',
  '/out:' + harness,
  '/reference:' + join(dirname(config.executable), 'ZwManaged.dll'),
  '/reference:' + join(dirname(config.executable), 'ZwDatabaseMgd.dll'),
  resolve('tests/integration/fixtures/ZwcadNativeCommands.cs'),
]);
const quote = (path) => JSON.stringify(path.replaceAll('\\', '/'));
const evidence = [];
for (const mode of ['move-save', 'save-as', 'close']) {
  const folder = join(directory, mode);
  await mkdir(folder);
  const token = randomBytes(32).toString('hex'),
    sessionId = randomUUID();
  const script = join(folder, 'start.scr'),
    done = join(folder, 'done.txt'),
    renamed = join(folder, 'renamed.dwg');
  const commands =
    mode === 'move-save'
      ? `(command "_MOVE" "_ALL" "" "_non" "0,0,0" "_non" "1000,0,0")\n(command "_QSAVE")`
      : mode === 'save-as'
        ? `(setvar "FILEDIA" 0)\n(command "_SAVEAS" "" ${quote(renamed)})`
        : `(princ)`;
  if (mode === 'close') await writeFile(join(folder, 'close.flag'), '');
  await writeFile(
    join(folder, 'commands.lsp'),
    `${commands}\n(setq videTestFile (open ${quote(done)} "w"))\n(write-line "done" videTestFile)\n(close videTestFile)\n`,
  );
  await writeFile(
    script,
    `(command "_NETLOAD" ${quote(harness)})\n(command "_NETLOAD" ${quote(config.plugin)})\nVIDESdkSession\n`,
  );
  const owner = await launchOwnedHost({
    executable: config.executable,
    args: ['/b', script],
    visible: false,
    environment: {
      ...process.env,
      VIDE_WORKER_DIRECTORY: folder,
      VIDE_WORKER_EDITOR: '1',
      VIDE_WORKER_TOKEN: token,
      VIDE_WORKER_SESSION: sessionId,
      VIDE_WORKER_SOURCE: source.filename,
      VIDE_WORKER_SOURCE_HASH: source.fileHash,
    },
  });
  try {
    const deadline = Date.now() + 90000;
    let ready,
      finished = false;
    while (Date.now() < deadline) {
      try {
        ready = JSON.parse(await readFile(join(folder, 'ready.json'), 'utf8'));
        await readFile(done);
        finished = true;
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(ready && finished, 'Native CAD script did not finish: ' + folder);
    assert.equal(ready.pid, owner.identity.pid);
    assert.equal(ready.startTicks, owner.identity.startTicks);
    await writeFile(
      folder + '.editors.json',
      JSON.stringify([
        { identity: ready, token, directory: folder, executable: config.executable },
      ]),
    );
    const editors = new ZwcadEditors(folder),
      target = { instance: ready.pid + ':' + ready.startTicks, documentId: 1 };
    if (mode === 'move-save') {
      const captured = await editors.capture(target);
      assert.equal(captured.scene[0].area, 240);
      assert.equal(captured.objects[0].points[0][0], source.objects[0].points[0][0] + 1);
      assert.equal(captured.objects[0].nativeId, source.objects[0].nativeId);
      const saved = await inspectDwg(join(folder, 'editing.dwg'), join(folder, 'saved-inspection'));
      assert.equal(saved.scene[0].area, 240);
      assert.equal(saved.objects[0].points[0][0], source.objects[0].points[0][0] + 1);
    } else {
      if (mode === 'close') await new Promise((resolve) => setTimeout(resolve, 1500));
      await assert.rejects(editors.capture(target));
    }
    assert.equal(
      createHash('sha256')
        .update(await readFile(source.filename))
        .digest('hex'),
      source.fileHash,
    );
    evidence.push({ mode, passed: true });
  } finally {
    await owner.stop();
  }
}
await writeFile(join(directory, 'passed.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ passed: true, directory, evidence }));
