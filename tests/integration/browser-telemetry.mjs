// ADR-036, SPEC-05.9, PLAN-34 T-159: the first-run card asks once (nothing sent before it is
// answered), the switch in Settings › 상태 · 오류 changes the choice, and after an engine crash the
// [진단 묶음을 보낼까요?] card sends the bundle only on [보내기] (the site may have it switched off).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { runDirectory } from './run-directory.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vide-telemetry-ui-'));
const sent = [];
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'vide.sqlite'),
    telemetryOptions: {
      prompt: true,
      site: () => 'https://site.test',
      fetcher: async (url) => {
        sent.push(String(url));
        return new Response('{"error":"BUNDLES_DISABLED"}', { status: 503 });
      },
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.goto(app.launchUrl);
  const card = page.getByRole('dialog', { name: '오류·성능 정보 보내기', exact: true });
  await card.waitFor();
  assert.match(await card.textContent(), /오류·성능 정보를 자동으로 보내 VIDE 개선에 도움 주기/);
  // The list of what is sent opens on demand; Escape does not answer the card.
  await card.getByText('무엇을 보내나요', { exact: true }).click();
  assert.match(await card.textContent(), /요청 글, AI의 답과 대화 내용/);
  assert.equal(
    await card.getByRole('link', { name: '개인정보 처리 안내' }).getAttribute('href'),
    'https://site.test/privacy',
  );
  await page.keyboard.press('Escape');
  assert.equal(await card.isVisible(), true);
  const evidence = runDirectory('ui-telemetry');
  await page.screenshot({ path: join(evidence, 'consent-1440.png') });
  assert.equal(sent.length, 0, 'nothing sent before an answer');
  await card.getByRole('button', { name: '동의', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  assert.equal(
    JSON.parse(await readFile(join(directory, 'telemetry.json'), 'utf8')).consent,
    'granted',
  );
  // Settings › 상태 · 오류: the switch is next to [진단 묶음 내보내기].
  await page.locator('#workspace-settings').click();
  const settings = page.getByRole('dialog', { name: '상태 및 설정', exact: true });
  await settings.getByRole('button', { name: '상태 · 오류', exact: true }).click();
  const toggle = settings.locator('#telemetry-consent');
  await page.waitForFunction(() => document.querySelector('#telemetry-consent')?.checked === true);
  assert.equal(await settings.locator('#diagnostic-bundle').isVisible(), true);
  assert.match(await settings.locator('.settings-telemetry').textContent(), /보내는 중/);
  await settings.locator('#telemetry-preview').click();
  const preview = await settings.locator('.telemetry-preview').textContent();
  assert.match(preview, /"kind": "summary"/);
  await page.screenshot({ path: join(evidence, 'settings-telemetry-1440.png') });
  // The switch follows the engine's answer (a controlled checkbox).
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('#telemetry-consent')?.checked === false);
  assert.match(await settings.locator('.settings-telemetry').textContent(), /보내지 않습니다/);
  assert.equal(
    JSON.parse(await readFile(join(directory, 'telemetry.json'), 'utf8')).consent,
    'denied',
  );
  await settings.getByRole('button', { name: '닫기', exact: true }).click();
  // Answered: no card on the next start.
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.telemetry-dialog').count(), 0);
  // An engine crash the PC program recorded: asked once.
  await mkdir(join(directory, 'logs'), { recursive: true });
  await writeFile(
    join(directory, 'logs', 'engine-exits.jsonl'),
    JSON.stringify({
      at: new Date().toISOString(),
      event: 'engine-exit',
      pid: 1,
      code: -1073740791,
      hex: '0xC0000409',
      uptimeSec: 40,
      asked: false,
    }) + '\n',
  );
  await page.reload();
  const crash = page.getByRole('dialog', { name: '진단 묶음 보내기', exact: true });
  await crash.waitFor();
  assert.match(await crash.textContent(), /0xC0000409/);
  assert.match(await crash.textContent(), /최근 3일의 진단 기록/);
  assert.equal(await crash.getByRole('checkbox').isChecked(), false, 'dumps only when ticked');
  await page.screenshot({ path: join(evidence, 'crash-1440.png') });
  await crash.getByRole('button', { name: '보내기', exact: true }).click();
  await crash.getByText(/지금은 사이트가 진단 묶음을 받지 않습니다/).waitFor();
  assert.match(await crash.locator('code').textContent(), /vide-diagnostics-.*\.zip$/);
  assert.deepEqual(sent, ['https://site.test/api/telemetry/bundles']);
  await crash.getByRole('button', { name: '닫기', exact: true }).click();
  await crash.waitFor({ state: 'detached' });
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.telemetry-dialog').count(), 0, 'a crash is asked once');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ consentCard: true, settingsSwitch: true, crashCard: true }));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
