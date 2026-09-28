const errorCode = (value: unknown) =>
  value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
    ? value.code
    : undefined;
import { resolve, join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { startServer } from './server.ts';
import { liveLaunch } from './lifecycle.ts';
import { sdkOptions } from './sdk-options.ts';
const DEFAULT_PORT = 47821;
const directory = resolve(
  process.env.VIDE_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'VIDE'),
);
let app: Awaited<ReturnType<typeof startServer>> | undefined,
  closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  if (app) await app.close();
  process.exit(0);
};
function open(url: string) {
  if (process.argv.includes('--no-browser')) return;
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  browser.on('error', () => console.error('BROWSER_OPEN_FAILED'));
  browser.unref();
}
try {
  await mkdir(directory, { recursive: true });
  // A fixed port keeps this PC's address (and the browser's login cookie) across restarts, so
  // the account website can open it and an open page reconnects. Busy port: any free port.
  const options = {
    filename: join(directory, 'vide.sqlite'),
    onShutdown: () => void close(),
    sdkOptions: sdkOptions(directory),
  };
  try {
    try {
      app = await startServer({ ...options, port: Number(process.env.VIDE_PORT ?? DEFAULT_PORT) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      app = await startServer({ ...options, port: 0 });
    }
  } catch (error) {
    if (errorCode(error) !== 'CONTROLLER_BUSY' || !process.argv.includes('--open')) throw error;
    const url = await liveLaunch(directory);
    if (!url) throw error;
    open(url);
  }
  if (app) {
    await writeFile(join(directory, 'launch.json'), JSON.stringify({ url: app.launchUrl }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (!process.argv.includes('--quiet')) console.log('VIDE local workspace: ' + app.launchUrl);
    if (process.argv.includes('--open')) open(app.launchUrl);
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  }
} catch (error) {
  if (app) await app.close().catch(() => {});
  const code = errorCode(error) || 'STARTUP_FAILED';
  await writeFile(
    join(directory, 'startup-error.json'),
    JSON.stringify({ code, at: new Date().toISOString() }),
  ).catch(() => {});
  console.error('VIDE_STARTUP_FAILED ' + code);
  process.exitCode = 1;
}
