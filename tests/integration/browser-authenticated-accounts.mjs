import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { AccountProfiles } from '../../src/ai/account-profiles.ts';
import { CodexCli } from '../../src/ai/codex-cli.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { startServer } from '../../src/server/server.ts';

// Real CLI calls; only the test profile's directory is mapped to an already authenticated
// profile so the live project's database and selection remain untouched. No auth file copy.
const native = process.argv.includes('--host');
const existing = new AccountProfiles(
  join(process.env.LOCALAPPDATA, 'VIDE', 'cli-profiles'),
  () => true,
);
const row = existing
  .list()
  .profiles.find((p) => p.provider === 'codex-cli' && p.label === 'ChatGPT 2');
assert.ok(row, 'SECOND_PROFILE_REQUIRED');
const directory = resolve('.vide/account-roundtrip', randomUUID());
await mkdir(directory, { recursive: true });
const filename = join(directory, 'test.sqlite');
let app, browser;
const invoked = [];
const options = {
  filename,
  ...(native ? { sdkOptions: sdkOptions(directory) } : {}),
  providerFactory: (settings) => {
    if (settings.provider !== 'codex-cli')
      return {
        status: async () => ({ available: false }),
        run: async () => {
          throw Error('UNUSED_PROVIDER');
        },
      };
    const profile = settings.configDirectory ? 'second' : 'default';
    const cli = new CodexCli({
      ...settings,
      configDirectory: profile === 'second' ? existing.directory('codex-cli', row.id) : undefined,
    });
    return {
      status: () => cli.status(),
      run: async (...args) => {
        invoked.push(profile);
        return cli.run(...args);
      },
    };
  },
};
try {
  app = await startServer(options);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  let page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  await page.locator('#model').selectOption('codex-cli');
  await page.locator('#permission').selectOption(native ? 'candidate' : 'review');
  const submit = async (count, profileId) => {
    await page
      .locator('#body')
      .fill(
        native
          ? '원점에 폭 2 m, 깊이 3 m, 높이 4 m 박스 한 개를 만들어 주세요. VIDE 도구로 실제 작업 사본을 만들고 확인해 주세요. 이름은 Account test입니다.'
          : '검토만 합니다. JSON message에는 VIDE_PROFILE_OK를, operations에는 빈 배열을 반환하세요.',
      );
    await page.locator('#request').click();
    let saved;
    const deadline = Date.now() + 200000;
    while (Date.now() < deadline) {
      const rows = await page.evaluate(
        async (id) => await (await fetch(`/api/v1/projects/${id}/requests`)).json(),
        projectId,
      );
      if (
        rows.length === count &&
        ['succeeded', 'failed', 'cancelled', 'unknown', 'interrupted'].includes(rows.at(-1).state)
      ) {
        saved = rows.at(-1);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(saved, 'Request did not finish');
    assert.equal(saved.state, 'succeeded', JSON.stringify(saved.result));
    if (native) {
      assert.equal(saved.result.executionMode, 'sdk');
      assert.equal(saved.result.objects.length, 1);
      assert.deepEqual(saved.result.scene[0].boundsSize, [2, 3, 4]);
      assert.ok(Math.abs(saved.result.scene[0].volume - 24) < 1e-8);
    } else assert.ok(saved.result.text.includes('VIDE_PROFILE_OK'));
    assert.equal(saved.input.accountProfileId, profileId);
    assert.equal(saved.result.hostExecuted, native);
  };
  if (!native) await submit(1, 'default');
  await page.locator('#workspace-settings').click();
  await page.locator('#ai-settings').click();
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Codex · ChatGPT', exact: true }) });
  await section.getByLabel('codex-cli 계정 이름').fill('Verified second');
  await section.getByRole('button', { name: '계정 추가', exact: true }).click();
  await section
    .locator('.account-settings > div')
    .filter({ hasText: 'Verified second' })
    .getByRole('button', { name: '선택', exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector('.ai-settings')?.textContent.includes('Verified second · 선택됨'),
  );
  const accounts = await page.evaluate(async () => await (await fetch('/api/v1/accounts')).json());
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await submit(native ? 1 : 2, accounts.active['codex-cli']);
  await page.close();
  await app.close();
  app = await startServer(options);
  page = await browser.newPage();
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const restored = await page.evaluate(async () => await (await fetch('/api/v1/accounts')).json());
  assert.equal(restored.active['codex-cli'], accounts.active['codex-cli']);
  assert.deepEqual(invoked, native ? ['second'] : ['default', 'second']);
  const result = {
    passed: true,
    directory,
    actualSubscriptionRequests: native ? 1 : 2,
    profileSelectionPersisted: true,
    credentialCopy: false,
    verifiedHostCandidates: native ? 1 : 0,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await app?.close();
}
