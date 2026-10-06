// Account loop through a real Cloudflare quick tunnel and the deployed account site: the PC signs
// in with the account → an emulated iPad signs in → project list → open → model → sketch → send;
// then a browser on the PC itself opens the same project locally (no tunnel).
// Needs VIDE_SHARING_TEST_ORIGIN (e.g. the staging URL) and VIDE_SIGNUP_CODE. Uses a synthetic
// account, an isolated
// local server and a mocked AI provider; the user's workspace is never exposed.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, devices } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { captureInput } from '../../src/server/import-model.ts';
import { runDirectory } from './run-directory.mjs';

const sharing = process.env.VIDE_SHARING_TEST_ORIGIN;
assert.ok(sharing, 'Set VIDE_SHARING_TEST_ORIGIN to the sharing Worker origin.');
const signupCode = process.env.VIDE_SIGNUP_CODE;
assert.ok(signupCode, 'Set VIDE_SIGNUP_CODE to the site sign-up code.');
process.env.VIDE_CLOUDFLARED ||= join(
  process.env.LOCALAPPDATA ?? '',
  'VIDE',
  'bin',
  'cloudflared.exe',
);
assert.ok(existsSync(process.env.VIDE_CLOUDFLARED), 'cloudflared is not installed.');
const directory = runDirectory('remote-loop');
await mkdir(directory, { recursive: true });
const result = { directory, sharing };
const received = [];
const app = await startServer({
  filename: join(directory, 'workspace.sqlite'),
  providerFactory: () => ({
    status: async () => ({ available: true }),
    run: async (context) => {
      received.push(context);
      // Same reply shape as a real review: a message and no model operations.
      return {
        text: JSON.stringify({ message: '아이패드 스케치와 요청을 받았습니다.', operations: [] }),
      };
    },
  }),
});
let browser, cookie, local;
const remoteCall = async (path, { method = 'GET', data } = {}) => {
  const response = await fetch(sharing + path, {
    method,
    headers: {
      Origin: sharing,
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((v) => v.split(';')[0]).join('; ');
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { status: response.status, value };
};
try {
  // A model to open: the real-size display copy from the Sync measurements when present.
  const workspace = new Workspace(app.store);
  const project = app.store.createProject('iPad loop');
  const runs = existsSync('.vide/sync-perf') ? await readdir('.vide/sync-perf') : [];
  const sample = runs
    .map((run) => join('.vide/sync-perf', run, 'display.json'))
    .find((file) => existsSync(file));
  const display = sample ? JSON.parse(await readFile(sample, 'utf8')) : undefined;
  const target = {
    id: randomUUID(),
    instance: '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96',
    documentId: 7,
  };
  workspace.submit(project.id, captureInput(target));
  const { source: _source, ...model } = display ?? {};
  workspace.update(project.id, target.id, 'succeeded', {
    host: 'rhino',
    hostExecuted: true,
    displayOnly: true,
    verified: false,
    executionMode: 'sdk',
    text: 'Sync',
    ...(display
      ? model
      : {
          objects: [
            { id: 'box', nativeId: target.id, kind: 'native', name: 'Box', origin: [0, 0, 0] },
          ],
          scene: [],
        }),
    sourceDocument: {
      instance: target.instance,
      documentId: 7,
      documentHash: 'a'.repeat(64),
      revision: 1,
      connection: 'attached-editor',
      name: 'Sample',
      units: 'Millimeters',
      capturedAt: new Date().toISOString(),
    },
  });
  result.modelObjects = display?.objects.length ?? 1;
  // 1. An ID account on the site (sign-up code), signed in like the website does.
  const username = `rt-${randomBytes(4).toString('hex')}`,
    password = randomBytes(20).toString('hex');
  const signup = await remoteCall('/api/account/sign-up', {
    method: 'POST',
    data: { username, password, code: signupCode },
  });
  assert.equal(signup.status, 201, JSON.stringify(signup));
  const login = await remoteCall('/api/account/sign-in', {
    method: 'POST',
    data: { username, password },
  });
  assert.equal(login.status, 200, JSON.stringify(login));
  // 2. The PC signs in with the same ID (settings → VIDE 계정) and turns remote access on.
  const launch = new URL(app.launchUrl);
  const session = await fetch(launch.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: launch.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: launch.hash.slice(1) }),
  });
  const localCookie = session.headers.getSetCookie()[0].split(';')[0];
  local = async (path, data) => {
    const response = await fetch(launch.origin + '/api/v1' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: launch.origin, 'Content-Type': 'application/json', Cookie: localCookie },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  let began = Date.now();
  await local('/remote/link', { username, password, name: 'Test PC', origin: sharing });
  // Signing in leaves remote access off (ADR-039 3): turn it on as the user does in Settings.
  await local('/remote/remote', { enabled: true });
  let status;
  for (let i = 0; i < 90; i++) {
    status = await local('/remote');
    if (status.running || (!status.starting && status.error)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(status.running, true, JSON.stringify(status));
  result.tunnelStartMs = Date.now() - began;
  result.tunnelHost = new URL(status.url).host;
  // 3. The PC is on (local + remote) and its project is in the account list.
  let hosts;
  for (let i = 0; i < 40; i++) {
    hosts = (await remoteCall('/api/hosts')).value.hosts;
    if (hosts[0]?.remote) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(hosts[0].online, true);
  assert.equal(hosts[0].remote, true);
  const listed = (await remoteCall('/api/projects')).value.projects;
  assert.deepEqual(
    listed.map((p) => p.name),
    ['iPad loop'],
  );
  // 4. An emulated iPad signs in, opens the PC and loads the model through the tunnel.
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  await context.addCookies(
    cookie.split('; ').map((pair) => {
      const [name, ...value] = pair.split('=');
      return { name, value: value.join('='), url: sharing };
    }),
  );
  const page = await context.newPage();
  // The test runs on the PC itself; the iPad cannot reach this PC's loopback address.
  await page.route(/127\.0\.0\.1/, (route) => route.abort());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  let transferred = 0;
  cdp.on('Network.loadingFinished', (event) => (transferred += event.encodedDataLength));
  await page.goto(sharing + '/');
  const card = page.getByRole('button', { name: 'iPad loop 열기' });
  await card.waitFor();
  await page.screenshot({ path: join(directory, 'ipad-projects.png') });
  began = Date.now();
  transferred = 0;
  await card.click();
  // The site's fixed address relays the PC; the page never sees the tunnel address.
  await page.waitForURL((url) => url.href.startsWith(`${sharing}/pc/`), { timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('#body')?.disabled === false, null, {
    timeout: 120_000,
  });
  result.workspaceReadyMs = Date.now() - began;
  const failures = [];
  cdp.on('Network.loadingFailed', (event) => failures.push(event.errorText));
  const responses = [];
  page.on('response', (response) =>
    responses.push(`${response.status()} ${new URL(response.url()).pathname}`),
  );
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('#viewport-empty')?.dataset.state !== 'loading' &&
        /개 객체/.test(document.querySelector('.object-summary')?.textContent ?? ''),
      null,
      { timeout: 300_000 },
    );
  } catch (error) {
    await page.screenshot({ path: join(directory, 'ipad-model-timeout.png') });
    console.log(
      JSON.stringify({
        state: await page.evaluate(() => document.querySelector('#viewport-empty')?.dataset.state),
        summary: await page.evaluate(() => document.querySelector('.object-summary')?.textContent),
        message: await page.evaluate(() => document.querySelector('#message')?.textContent),
        failures,
        responses: responses.slice(-15),
        transferredMB: transferred / 1e6,
        errors,
      }),
    );
    throw error;
  }
  result.modelShownMs = Date.now() - began;
  result.transferredMB = Math.round((transferred / 1e6) * 10) / 10;
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(directory, 'ipad-model.png') });
  // 5. Sketch with touch on the model, attach it, and send a message.
  await page.locator('button[data-tool="sketch"]').tap();
  // Draw on the view plane so the stroke does not depend on hitting a surface.
  await page.locator('#brush-surface').tap();
  const canvas = await page.locator('#canvas canvas').boundingBox();
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
    });
  const cx = canvas.x + canvas.width / 2,
    cy = canvas.y + canvas.height / 2;
  await touch('touchStart', cx - 120, cy);
  for (let i = 1; i <= 20; i++)
    await touch('touchMove', cx - 120 + i * 12, cy + Math.sin(i / 3) * 30);
  await touch('touchEnd');
  assert.equal(await page.locator('#finish-sketch').isDisabled(), false, 'stroke not recorded');
  await page.locator('#finish-sketch').tap();
  await page.waitForFunction(() => /⌁/.test(document.querySelector('#context')?.textContent ?? ''));
  await page.locator('#body').tap();
  await page.keyboard.type('스케치한 선을 따라 난간을 추가해줘');
  began = Date.now();
  await page.screenshot({ path: join(directory, 'ipad-before-send.png') });
  await page.locator('#request').tap();
  try {
    // The outcome travels back to the iPad; the mocked AI's reply content is not under test.
    await page.waitForFunction(
      () =>
        ['succeeded', 'failed'].includes(
          document.querySelector('.work-view .card-state')?.getAttribute('data-state') ?? '',
        ) && document.querySelectorAll('#task-list .task-row').length >= 2,
      null,
      { timeout: 60_000 },
    );
    result.requestState = await page.locator('.work-view .card-state').getAttribute('data-state');
  } catch (error) {
    await page.screenshot({ path: join(directory, 'ipad-send-timeout.png') });
    console.log(
      JSON.stringify({
        received: received.length,
        message: await page.evaluate(() => document.querySelector('#message')?.textContent),
        body: await page.locator('#body').inputValue(),
        errors,
      }),
    );
    throw error;
  }
  result.requestRoundTripMs = Date.now() - began;
  const packet = received.at(-1);
  assert.ok(packet, 'The desktop provider received the request.');
  result.sketchReceived = JSON.stringify(packet).includes('"type":"sketch"');
  assert.equal(result.sketchReceived, true);
  await page.screenshot({ path: join(directory, 'ipad-sent.png') });
  result.errors = errors;
  // cloudflared dies on its own (network change): the PC opens a new tunnel by itself and the
  // same page address keeps working with the same session.
  const before = (await local('/remote')).url;
  const port = new URL(app.launchUrl).port;
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -like '*127.0.0.1:${port}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
  ]);
  let reopened;
  for (let i = 0; i < 120; i++) {
    reopened = await local('/remote');
    if (reopened.running && reopened.url && reopened.url !== before) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.notEqual(reopened.url, before, JSON.stringify(reopened));
  // The relay's waiting page retries by itself until the site hears the new address.
  began = Date.now();
  const reloadResponses = [];
  page.on('response', (response) =>
    reloadResponses.push(`${response.status()} ${new URL(response.url()).pathname}`),
  );
  await page.reload();
  try {
    // Polled across the waiting page's own reloads.
    let ready = false;
    for (const end = Date.now() + 120_000; !ready && Date.now() < end; ) {
      ready = await page
        .evaluate(() => document.querySelector('#body')?.disabled === false)
        .catch(() => false);
      if (!ready) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready) throw Error('Workspace did not reopen after the tunnel restart');
  } catch (error) {
    await page.screenshot({ path: join(directory, 'ipad-reopen-timeout.png') });
    console.log(
      JSON.stringify({
        reopened,
        text: (await page.locator('body').innerText()).slice(0, 600),
        responses: reloadResponses.slice(-20),
      }),
    );
    throw error;
  }
  result.reopenedAfterTunnelRestartMs = Date.now() - began;
  assert.ok(page.url().startsWith(`${sharing}/pc/`));
  // 6. A browser on the PC itself opens the same project locally (no tunnel).
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await desktop.grantPermissions(['local-network-access'], { origin: sharing }).catch(() => {});
  await desktop.addCookies(
    cookie.split('; ').map((pair) => {
      const [name, ...value] = pair.split('=');
      return { name, value: value.join('='), url: sharing };
    }),
  );
  const pc = await desktop.newPage();
  await pc.goto(sharing + '/');
  await pc.getByText('이 PC', { exact: true }).waitFor({ timeout: 15_000 });
  await pc.screenshot({ path: join(directory, 'pc-projects.png') });
  began = Date.now();
  await pc.getByRole('button', { name: 'iPad loop 열기' }).click();
  await pc.waitForURL(/^http:\/\/127\.0\.0\.1/, { timeout: 30_000 });
  await pc.waitForFunction(() => document.querySelector('#body')?.disabled === false, null, {
    timeout: 60_000,
  });
  result.localOpenMs = Date.now() - began;
  result.localOpened = true;
  await pc.screenshot({ path: join(directory, 'pc-workspace.png') });
  // 7. Remote access off: the PC stays on for local use but has no remote link.
  await local('/remote/remote', { enabled: false });
  hosts = (await remoteCall('/api/hosts')).value.hosts;
  result.remoteOffAfterStop = hosts[0].online === true && hosts[0].remote === false;
  assert.equal(result.remoteOffAfterStop, true);
  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  // Sign the test PC out (removes it from the synthetic account).
  if (local) await local('/remote/unlink', {}).catch(() => {});
  await browser?.close();
  await app.close();
}
