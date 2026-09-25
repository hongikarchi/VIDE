// Isolate native SaveAs from VIDE's plugin and capture channel on a synthetic document.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';

const directory = resolve('.vide/rhino-saveas-control', randomUUID());
await mkdir(directory, { recursive: true });
const saveDirectory = process.argv.includes('--save-in-temp')
  ? join(tmpdir(), 'vide-saveas-' + randomUUID())
  : directory;
await mkdir(saveDirectory, { recursive: true });
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
        ok = Rhino.RhinoApp.RunScript('_-SaveAs "' + filename + '" _Enter', False) if ${process.argv.includes('--command') ? 'True' : 'False'} else doc.SaveAs(filename)
        result = dict(saved=ok, before=before, after=doc.IsReadOnly, modified=doc.Modified, path=doc.Path, fileWritable=os.access(filename, os.W_OK), history=Rhino.RhinoApp.CommandHistoryWindowText[len(historyBefore):], commandResult=str(Rhino.Commands.Command.LastCommandResult))
    except Exception as error:
        result = dict(error=str(error))
    with open(os.path.join(folder, 'result.json'), 'w') as output:
        json.dump(result, output)
Rhino.RhinoApp.Idle += run
`,
);
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
      '/scheme=VIDE-Worker-Test',
      `/runscript="_-RunPythonScript (${script})"`,
    ],
  });
  const deadline = Date.now() + 90000;
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
  console.log(JSON.stringify({ directory, ...evidence }));
  if (process.argv.includes('--inspect')) {
    console.log('Owned SaveAs inspection window remains open for 120 seconds.');
    await new Promise((resolve) => setTimeout(resolve, 120000));
  }
  assert.equal(evidence.saved, true);
} finally {
  if (host) await host.stop();
}
