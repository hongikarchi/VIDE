import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../../src/server/server.ts';
const directory = await mkdtemp(join(tmpdir(), 'vide-viewport-')),
  exec = promisify(execFile);
let app;
try {
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    host: { status: async () => ({ available: true }) },
    providerFactory: () => ({ status: async () => ({ available: true }) }),
  });
  const launch = join(directory, 'launch.json');
  await writeFile(launch, JSON.stringify({ url: app.launchUrl }));
  const results = await Promise.allSettled(
    ['browser-large-coordinate-detail.mjs', 'browser-point-selection.mjs'].map((script) =>
      exec(
        process.execPath,
        [join('tests/integration', script), resolve('node_modules/playwright/index.mjs'), launch],
        { windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
      ),
    ),
  );
  for (const result of results) {
    if (result.status === 'fulfilled') console.log(result.value.stdout.trim());
    else {
      console.error(result.reason);
      process.exitCode = 1;
    }
  }
} finally {
  if (app) await app.close();
  if (dirname(resolve(directory)) !== resolve(tmpdir())) throw Error('Unexpected test path');
  await rm(directory, { recursive: true, force: true });
}
