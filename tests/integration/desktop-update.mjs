// Self-update of the installed PC program through its own settings screen: the installed version
// finds the newer release in its update source, downloads it, restarts into it, and the user's
// data (projects) is unchanged. Needs an installed VIDE (Velopack, %LOCALAPPDATA%\VIDE.App) whose
// update source (desktop.json UpdateSource) holds a newer release. Uses the installed data folder.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const root = join(process.env.LOCALAPPDATA, 'VIDE.App');
const stub = join(root, 'VIDE.exe');
assert.ok(existsSync(stub), 'VIDE is not installed.');
const data = join(process.env.LOCALAPPDATA, 'VIDE');
const version = () =>
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `(Get-Item '${join(root, 'current', 'VIDE.exe')}').VersionInfo.ProductVersion`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
    .trim()
    .split('+')[0];
const running = () =>
  execFileSync('tasklist', ['/FI', 'IMAGENAME eq VIDE.exe', '/NH'], { encoding: 'utf8' }).includes(
    'VIDE.exe',
  );
const waitFor = async (check, label, ms = 120_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {
      /* Not yet. */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error('Timed out: ' + label);
};
const debugPort = 9700 + Math.floor(Math.random() * 200);
const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
};
const result = { before: version() };
// Restart the installed program with a debugging port on its window.
if (running()) {
  spawn(stub, ['--quit'], { stdio: 'ignore' });
  await waitFor(() => !running(), 'program quit', 60_000);
}
spawn(stub, [], { env, stdio: 'ignore', detached: true }).unref();
const connect = async () => {
  let browser, page;
  await waitFor(async () => {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().startsWith('http://127.0.0.1:'));
    if (!page) await browser.close();
    return !!page;
  }, 'window');
  await page.waitForFunction(() => document.querySelector('#body')?.disabled === false, null, {
    timeout: 120_000,
  });
  return { browser, page };
};
let { browser, page } = await connect();
const projects = await page.evaluate(async () => (await fetch('/api/v1/projects')).json());
result.projects = projects.length;
await page.locator('#workspace-settings').click();
const settings = page.getByRole('dialog', { name: '상태 및 설정', exact: true });
await settings.getByRole('button', { name: 'PC 프로그램', exact: true }).click();
await settings.getByRole('heading', { name: 'PC 프로그램' }).waitFor();
assert.match(
  await settings.textContent(),
  new RegExp(`VIDE ${result.before.replaceAll('.', '\\.')}`),
);
await settings.getByRole('button', { name: '업데이트 확인' }).click();
await settings.getByText('재시작하면 설치됩니다').waitFor({ timeout: 180_000 });
result.found = (await settings.textContent()).match(/새 버전 (\S+)이 준비/)?.[1];
await page.screenshot({ path: resolve('.vide/desktop-update-ready.png') });
const began = Date.now();
await settings.getByRole('button', { name: '재시작하여 업데이트' }).click();
await browser.close().catch(() => {});
await waitFor(() => version() === result.found, 'new version installed', 180_000);
await waitFor(() => running(), 'restarted', 60_000);
({ browser, page } = await connect());
result.restartMs = Date.now() - began;
result.after = version();
const after = await page.evaluate(async () => (await fetch('/api/v1/projects')).json());
assert.equal(after.length, result.projects, 'projects kept');
await page.locator('#workspace-settings').click();
await page.locator('[data-tab="desktop"]').click();
await page
  .getByRole('dialog', { name: '상태 및 설정', exact: true })
  .getByText(`VIDE ${result.after}`, { exact: true })
  .waitFor();
await page.screenshot({ path: resolve('.vide/desktop-update-after.png') });
await browser.close();
result.launch = JSON.parse(await readFile(join(data, 'launch.json'), 'utf8')).url.split('#')[0];
result.passed = result.after === result.found && result.after !== result.before;
console.log(JSON.stringify(result));
assert.ok(result.passed);
