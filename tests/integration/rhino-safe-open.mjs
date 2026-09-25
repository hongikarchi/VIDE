// Manual native UI diagnostic: safe mode deliberately cannot run startup Python.
import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';

const source = process.argv[2];
if (!source || extname(source).toLowerCase() !== '.3dm') {
  throw new Error('Usage: node tests/integration/rhino-safe-open.mjs <synthetic.3dm>');
}
if (!(await stat(resolve(source))).isFile()) throw new Error('Source must be a synthetic 3dm file');
const directory = resolve('.vide/rhino-safe-open', randomUUID());
await mkdir(directory, { recursive: true });
const filename = join(directory, 'owned.3dm');
await copyFile(resolve(source), filename);
const host = await launchOwnedHost({
  executable: 'C:/Program Files/Rhino 8/System/Rhino.exe',
  visible: true,
  args: ['/nosplash', '/notemplate', '/safemode', '/scheme=VIDE-Worker-Test', filename],
});
try {
  await writeFile(
    join(directory, 'process.json'),
    JSON.stringify({ ...host.identity, filename }, null, 2),
  );
  console.log(JSON.stringify({ directory, filename, pid: host.identity.pid }));
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    try {
      await stat(join(directory, 'inspection-complete'));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
} finally {
  await host.stop();
}
