// Remote loop through a real Cloudflare quick tunnel and the deployed sharing Worker:
// sign in on an emulated iPad → host list → open the PC → load the model → sketch → send.
// Needs VIDE_SHARING_TEST_ORIGIN (e.g. the staging URL). Uses a synthetic account, an isolated
// local server and a mocked AI provider; the user's workspace is never exposed.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { chromium, devices } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { captureInput } from '../../src/server/import-model.ts';

const sharing = process.env.VIDE_SHARING_TEST_ORIGIN;
assert.ok(sharing, 'Set VIDE_SHARING_TEST_ORIGIN to the sharing Worker origin.');
process.env.VIDE_CLOUDFLARED ||= join(
  process.env.LOCALAPPDATA ?? '',
  'VIDE',
  'bin',
  'cloudflared.exe',
);
assert.ok(existsSync(process.env.VIDE_CLOUDFLARED), 'cloudflared is not installed.');
const directory = resolve('.vide/remote-loop', randomUUID());
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
let browser, hostId, cookie;
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
  // 1. Owner account on the sharing site and a pairing code.
  const email = `vide-remote-${randomUUID()}@example.com`,
    password = randomBytes(20).toString('hex');
  await remoteCall('/api/auth/sign-up/email', {
    method: 'POST',
    data: { name: 'Remote test', email, password },
  });
  const login = await remoteCall('/api/auth/sign-in/email', {
    method: 'POST',
    data: { email, password },
  });
  assert.equal(login.status, 200, JSON.stringify(login));
  const pairing = await remoteCall('/api/hosts/pairings', { method: 'POST', data: {} });
  assert.equal(pairing.status, 201, JSON.stringify(pairing));
  // 2. The desktop pairs and turns remote access on (as the settings panel does).
  const launch = new URL(app.launchUrl);
  const local = async (path, data) => {
    const response = await fetch(launch.origin + '/api/v1' + path, {
      method: 'POST',
      headers: { Origin: launch.origin, 'Content-Type': 'application/json', Cookie: localCookie },
      body: JSON.stringify(data),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const session = await fetch(launch.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: launch.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: launch.hash.slice(1) }),
  });
  const localCookie = session.headers.getSetCookie()[0].split(';')[0];
  await local('/remote/pair', { code: pairing.value.code, name: 'Test PC', origin: sharing });
  let began = Date.now();
  const started = await local('/remote/start', {});
  result.tunnelStartMs = Date.now() - began;
  result.tunnelHost = new URL(started.url).host;
  // 3. The host shows online in the owner's list.
  let hosts;
  for (let i = 0; i < 40; i++) {
    hosts = (await remoteCall('/api/hosts')).value.hosts;
    if (hosts[0]?.online) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(hosts[0].online, true);
  hostId = hosts[0].id;
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
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  let transferred = 0;
  cdp.on('Network.loadingFinished', (event) => (transferred += event.encodedDataLength));
  await page.goto(sharing + '/');
  await page.getByRole('button', { name: '열기' }).first().waitFor();
  await page.screenshot({ path: join(directory, 'ipad-hosts.png') });
  began = Date.now();
  transferred = 0;
  await page.getByRole('button', { name: '열기' }).first().click();
  await page.waitForURL(/trycloudflare\.com/, { timeout: 60_000 });
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
  // Draw on the screen plane so the stroke does not depend on hitting a surface.
  await page.locator('#placement').selectOption('view');
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
        [...document.querySelectorAll('.chat-message .card-state')].some((node) =>
          ['succeeded', 'failed'].includes(node.getAttribute('data-state') ?? ''),
        ) && document.querySelectorAll('.chat-message').length >= 2,
      null,
      { timeout: 60_000 },
    );
    result.requestState = await page
      .locator('.chat-message .card-state')
      .last()
      .getAttribute('data-state');
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
  // 6. Turning remote access off reports the PC offline and ends the tunnel session.
  await local('/remote/stop', {});
  hosts = (await remoteCall('/api/hosts')).value.hosts;
  result.offlineAfterStop = hosts[0].online === false;
  assert.equal(result.offlineAfterStop, true);
  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (hostId) await remoteCall(`/api/hosts/${hostId}`, { method: 'DELETE' }).catch(() => {});
  await browser?.close();
  await app.close();
}
