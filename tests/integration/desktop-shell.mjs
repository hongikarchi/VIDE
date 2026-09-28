// PC program shell (built, not installed): own window with the work screen, "PC 프로그램" settings,
// autostart entry, closing to the tray, a second launch reusing the first, and a clean quit that
// stops the engine. Drives the real WebView2 window through its debugging port. Uses a separate
// data folder; the user's data and work engine are not touched.
// Needs `npm run desktop:build` and `npm run build:web`.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

// VIDE_DESKTOP_EXE runs a packaged program (bundled Node and app) instead of the shell build.
const packaged = process.env.VIDE_DESKTOP_EXE;
const exe = resolve(packaged || '.vide/build/desktop-shell/bin/VIDE.exe');
assert.ok(existsSync(exe), 'Run npm run desktop:build first.');
const directory = resolve('.vide/desktop-shell', randomUUID());
const data = join(directory, 'data');
await mkdir(data, { recursive: true });
const debugPort = 9300 + Math.floor(Math.random() * 400);
const env = {
  ...process.env,
  VIDE_DATA_DIR: data,
  ...(packaged ? {} : { VIDE_DESKTOP_APP: resolve('.') }),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
};
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const runValue = () => {
  try {
    return execFileSync('reg', ['query', runKey, '/v', 'VIDE'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
};
const hadRunValue = runValue();
assert.equal(hadRunValue.includes(exe), false);
const launch = (...args) => spawn(exe, args, { env, stdio: 'ignore' });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check, label, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error('Timed out: ' + label);
};
const result = { directory };
let shell, browser;
try {
  const started = Date.now();
  shell = launch();
  await waitFor(() => existsSync(join(data, 'launch.json')), 'engine launch');
  const engineUrl = new URL(JSON.parse(await readFile(join(data, 'launch.json'), 'utf8')).url);
  await waitFor(async () => {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      return true;
    } catch {
      return false;
    }
  }, 'window debugging port');
  let page;
  await waitFor(() => {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().startsWith(engineUrl.origin));
    return !!page;
  }, 'work screen in the window');
  await page.waitForFunction(() => document.querySelector('#body')?.disabled === false, null, {
    timeout: 60_000,
  });
  result.windowReadyMs = Date.now() - started;
  // Settings: the "PC 프로그램" section exists only inside the program window.
  await page.locator('#workspace-settings').click();
  const settings = page.getByRole('dialog', { name: '상태 및 설정', exact: true });
  await settings.getByRole('button', { name: 'PC 프로그램', exact: true }).click();
  await settings.getByRole('heading', { name: 'PC 프로그램' }).waitFor();
  assert.match(await settings.textContent(), /VIDE \d+\.\d+\.\d+/);
  assert.match(await settings.textContent(), /설치된 프로그램이 아니어서/);
  await settings.getByLabel('Windows 시작 시 자동 실행').check();
  await waitFor(() => runValue().includes(exe.replaceAll('/', '\\')), 'autostart entry');
  assert.match(runValue(), /--background/);
  await settings.getByLabel('Windows 시작 시 자동 실행').uncheck();
  await waitFor(() => !runValue().includes(exe), 'autostart removed');
  const saved = JSON.parse(await readFile(join(data, 'desktop.json'), 'utf8'));
  assert.equal(saved.Autostart, false);
  assert.equal(saved.Background, true);
  result.autostartToggled = true;
  await page.screenshot({ path: join(directory, 'window-settings.png') });
  // Closing the window keeps VIDE running in the tray (background on by default).
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `$p = Get-Process -Id ${shell.pid}; Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'; [U.W]::PostMessage($p.MainWindowHandle, 0x10, [System.IntPtr]::Zero, [System.IntPtr]::Zero) | Out-Null`,
  ]);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(alive(shell.pid), true, 'still running after closing the window');
  const health = await fetch(engineUrl.origin + '/', { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  result.closeToTray = true;
  // A second launch reuses the running program (no second engine) and shows its window.
  const second = launch();
  await new Promise((resolve) => second.once('exit', resolve));
  assert.equal(alive(shell.pid), true);
  result.singleInstance = true;
  // Quit: the program and its engine stop.
  await browser.close();
  browser = undefined;
  const quit = launch('--quit');
  await new Promise((resolve) => quit.once('exit', resolve));
  await waitFor(() => !alive(shell.pid), 'program exit', 30_000);
  await waitFor(
    async () => {
      try {
        await fetch(engineUrl.origin + '/', { signal: AbortSignal.timeout(1000) });
        return false;
      } catch {
        return true;
      }
    },
    'engine stop',
    30_000,
  );
  result.quitStopsEngine = true;
  result.passed = true;
  console.log(JSON.stringify(result));
} finally {
  await browser?.close().catch(() => {});
  if (shell && alive(shell.pid)) launch('--quit');
  if (!hadRunValue && runValue().includes(exe))
    execFileSync('reg', ['delete', runKey, '/v', 'VIDE', '/f']);
  await new Promise((r) => setTimeout(r, 2000));
  await rm(join(data, 'webview'), { recursive: true, force: true }).catch(() => {});
}
