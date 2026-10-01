// Isolate native SaveAs from VIDE's plugin and capture channel on a synthetic document.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { runDirectory } from './run-directory.mjs';

const directory = runDirectory('rhino-saveas-control');
await mkdir(directory, { recursive: true });
const saveDirectory = process.argv.includes('--save-in-temp')
  ? join(tmpdir(), 'vide-saveas-' + randomUUID())
  : directory;
await mkdir(saveDirectory, { recursive: true });
const scheme = process.argv.includes('--fresh-scheme')
  ? 'VIDE-SaveAs-Control-' + randomUUID()
  : 'VIDE-Worker-Test';
const script = join(directory, 'control.py');
const result = join(directory, 'result.json');
await writeFile(
  script,
  `import Rhino, json, os
folder = ${JSON.stringify(directory.replaceAll('\\', '/'))}
def run(sender, args):
    Rhino.RhinoApp.Idle -= run
    try:
        doc = Rhino.RhinoDoc.ActiveDoc
        assert doc.Objects.Count == 0 and not doc.Modified
        doc.ModelUnitSystem = Rhino.UnitSystem.Meters
        doc.Objects.AddBox(Rhino.Geometry.Box(Rhino.Geometry.BoundingBox(0,0,0,2,3,4)))
        before = doc.IsReadOnly
        with open(os.path.join(folder, 'before.json'), 'w') as output:
            json.dump(dict(before=before), output)
        filename = ${JSON.stringify(join(saveDirectory, 'saved.3dm').replaceAll('\\', '/'))}
    
        historyBefore = Rhino.RhinoApp.CommandHistoryWindowText
        ok = False
        if not ${process.argv.includes('--settings') ? 'True' : 'False'}:
            ok = Rhino.RhinoApp.RunScript('_-SaveAs "' + filename + '" _Enter', False) if ${process.argv.includes('--command') ? 'True' : 'False'} else doc.SaveAs(filename)
        result = dict(saved=ok, before=before, after=doc.IsReadOnly, modified=doc.Modified, path=doc.Path, fileWritable=os.access(filename, os.W_OK), history=Rhino.RhinoApp.CommandHistoryWindowText[len(historyBefore):], commandResult=str(Rhino.Commands.Command.LastCommandResult), fileLocking=Rhino.ApplicationSettings.FileSettings.FileLockingEnabled, lockWarning=Rhino.ApplicationSettings.FileSettings.FileLockingOpenWarning)
    except Exception as error:
        result = dict(error=str(error))
    with open(os.path.join(folder, 'result.json'), 'w') as output:
        json.dump(result, output)
Rhino.RhinoApp.Idle += run
`,
);
const inspectScript = join(directory, 'inspect.py');
if (process.argv.includes('--macro')) {
  assert.ok(!/\s/.test(saveDirectory), 'Macro diagnostic requires a path without whitespace');
  await writeFile(
    script,
    `import Rhino, json, os
folder = ${JSON.stringify(directory.replaceAll('\\', '/'))}
doc = Rhino.RhinoDoc.ActiveDoc
assert doc.Objects.Count == 0 and not doc.Modified
doc.ModelUnitSystem = Rhino.UnitSystem.Meters
doc.Objects.AddBox(Rhino.Geometry.Box(Rhino.Geometry.BoundingBox(0,0,0,2,3,4)))
with open(os.path.join(folder, 'before.json'), 'w') as output:
    json.dump(dict(before=doc.IsReadOnly), output)
`,
  );
  await writeFile(
    inspectScript,
    `import Rhino, json, os
folder = ${JSON.stringify(directory.replaceAll('\\', '/'))}
filename = ${JSON.stringify(join(saveDirectory, 'saved.3dm').replaceAll('\\', '/'))}
doc = Rhino.RhinoDoc.ActiveDoc
with open(os.path.join(folder, 'before.json')) as input:
    before = json.load(input)['before']
with open(os.path.join(folder, 'result.json'), 'w') as output:
    json.dump(dict(saved=os.path.isfile(filename), before=before, after=doc.IsReadOnly, modified=doc.Modified, path=doc.Path, fileWritable=os.access(filename, os.W_OK), commandResult=str(Rhino.Commands.Command.LastCommandResult), fileLocking=Rhino.ApplicationSettings.FileSettings.FileLockingEnabled, lockWarning=Rhino.ApplicationSettings.FileSettings.FileLockingOpenWarning), output)
`,
  );
}
let host;
try {
  host = await launchOwnedHost({
    executable: 'C:/Program Files/Rhino 8/System/Rhino.exe',
    visible: true,
    spawnProcess: (file, args, options) =>
      spawn(file, args, { ...options, windowsVerbatimArguments: true }),
    args: [
      '/nosplash',
      '/notemplate',
      '/scheme=' + scheme,
      process.argv.includes('--macro')
        ? `/runscript="_-RunPythonScript (${script}) _-SaveAs ${join(saveDirectory, 'saved.3dm')} _Enter _-RunPythonScript (${inspectScript})"`
        : `/runscript="_-RunPythonScript (${script})"`,
    ],
  });
  const deadline = Date.now() + (process.argv.includes('--macro') ? 180000 : 90000);
  let evidence;
  while (Date.now() < deadline) {
    try {
      evidence = JSON.parse(await readFile(result, 'utf8'));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(evidence, 'Native SaveAs control did not finish');
  evidence = { ...evidence, scheme };
  await writeFile(result, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ directory, ...evidence }));
  if (process.argv.includes('--inspect')) {
    console.log('Owned SaveAs inspection window remains open for 120 seconds.');
    await new Promise((resolve) => setTimeout(resolve, 120000));
  }
  if (!process.argv.includes('--settings')) assert.equal(evidence.saved, true);
} finally {
  if (host) await host.stop();
}
