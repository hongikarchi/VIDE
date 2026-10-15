// 기록 탭 가져오기 (PLAN-53 T-329·T-330, Design SCR-45 「구현 기준」 가져오기): [가져오기]로 합성
// 카카오톡 대화를 고르면 '후보 N건 · 원문은 폴더에 아직 안 씀'이 뜨고, 거르기가 후보·카카오톡으로
// 바뀌며, 질문·결정·부위 단어가 있는 후보가 앞에 오고 작은 글자 '질문'·'결정'·'부위: …'가 붙는다. 같은 파일을
// 다시 들이면 '이미 들인 파일입니다.'와 [처음 기록 보기]가 그 기록의 자세히 칸을 연다. 원격 화면에는 단추가
// 없다. 합성 fixture만 쓴다.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Records } from '../../src/core/records.ts';
import { kakaoPc, mbox } from '../fixtures/records-import/index.mjs';

const FORBIDDEN = /record|candidate|kakao|sourceKey|SPEC-|PLAN-|undefined|null/;
const directory = await mkdtemp(join(tmpdir(), 'vide-records-import-'));
const data = join(directory, 'data');
await mkdir(data);
let app, browser;
try {
  app = await startServer({ filename: join(data, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  for (const [pattern, json] of [
    ['**/api/v1/host', { available: false }],
    ['**/api/v1/providers', [{ id: 'codex-cli', available: true }]],
    [
      '**/api/v1/models',
      [{ id: 'test', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    ],
  ])
    await page.route(pattern, (route) => route.fulfill({ json }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  const records = new Records(app.store);
  records.addPart(projectId, { name: '난간', grp: '신설' });

  await page.locator('.rail [data-workspace-target="records"]').click();
  const tab = page.getByRole('region', { name: '기록', exact: true });
  await tab.waitFor();
  await tab.getByText('아직 기록이 없습니다.').waitFor();

  const chat = kakaoPc(3, 10);
  const file = { name: '현장 대화.txt', mimeType: 'text/plain', buffer: Buffer.from(chat.text) };
  await tab.getByLabel('가져올 파일').setInputFiles(file);
  await tab
    .getByText(`후보 ${chat.messages}건 · 원문은 폴더에 아직 안 씀`, { exact: true })
    .waitFor();
  await page.waitForFunction(
    (n) => document.querySelectorAll('.records-row').length === n,
    chat.messages,
  );
  assert.equal(records.list(projectId, { source: ['kakao'] }).total, chat.messages);
  // Hinted candidates first: the first rows ask, decide or name a part.
  const first = tab.locator('.records-row').first();
  assert.ok((await first.locator('.records-hints').count()) === 1);
  assert.match(await first.locator('.records-hints').innerText(), /질문|결정|부위: 난간/);
  const last = tab.locator('.records-row').last();
  assert.equal(await last.locator('.records-hints').count(), 0);
  assert.ok(await tab.getByText('부위: 난간').first().isVisible());
  assert.doesNotMatch(await tab.innerText(), FORBIDDEN);

  // The same file again: nothing changes; [처음 기록 보기] opens the first record.
  await tab.getByLabel('가져올 파일').setInputFiles(file);
  await tab.getByText('이미 들인 파일입니다.').waitFor();
  assert.equal(records.list(projectId, {}).total, chat.messages);
  await tab.getByRole('button', { name: '처음 기록 보기' }).click();
  const detail = tab.getByRole('complementary', { name: '자세히' });
  await detail.waitFor();
  const firstRecord = records
    .list(projectId, {})
    .records.find((row) => row.sourceKey.endsWith(':6'));
  await detail.getByText(firstRecord.text.split('\n')[0], { exact: false }).first().waitFor();

  // A mail box: the filter turns to 메일.
  await tab.getByLabel('가져올 파일').setInputFiles({
    name: '보관함.mbox',
    mimeType: 'application/mbox',
    buffer: Buffer.from(mbox()),
  });
  await tab.getByText('후보 20건 · 원문은 폴더에 아직 안 씀', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.records-row').length === 20);
  assert.equal(records.list(projectId, { source: ['mail'] }).total, 20);

  assert.deepEqual(errors, []);
  console.log('browser records import: ok');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
