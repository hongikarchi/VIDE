// 부위×시간 차트 (PLAN-53 T-328, Design SCR-45): the 기록 tab's [차트] draws one glyph per 남김
// record (candidates hollow when the state chips ask for them), the type toggles change the glyphs
// drawn, pressing a glyph keeps its chain dark and opens 자세히, the three row modes, labels that do
// not overlap on screen, the print sheet (A3, index in four columns), no internal words, and the
// first draw of 1,000 records under a second. Every sentence below is made up for this test.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Records } from '../../src/core/records.ts';

const shot = process.env.VIDE_SHOT_DIR;
const FORBIDDEN =
  /record|candidate|kept|dropped|chain|\bpart\b|JSON|세션|토큰|이벤트|타임스탬프|노드|그래프|매핑|스키마|SPEC-|PLAN-|undefined|null|NaN/;
const PARTS = [
  ['지붕 트러스', '신설'],
  ['북측 계단실', '신설'],
  ['남측 창호', '신설'],
  ['2층 슬래브', '신설'],
  ['동측 옹벽', '기존'],
  ['기초', '기존'],
  ['서측 외벽', '기존'],
  ['지하 기계실', '기존'],
];
const TYPES = ['R', 'I', 'K', 'E', 'D'];
const CHAPTERS = ['계획', '설계', '시공'];
const two = (n) => String(n).padStart(2, '0');
const dateOf = (i, span) => {
  const at = new Date(Date.UTC(2026, 3, 1) + Math.floor((i * span) / 80) * 86_400_000);
  return at.toISOString().slice(0, 10);
};

const directory = await mkdtemp(join(tmpdir(), 'vide-records-chart-'));
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
  await page.route('**/api/v1/projects/*/parts/status', (route) =>
    route.fulfill({ json: { parts: [] } }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();

  // 80 made-up records on eight parts over five months: 72 남김, 8 후보; six stories of five.
  const records = new Records(app.store);
  const parts = PARTS.map(([name, grp]) => records.addPart(projectId, { name, grp }).id);
  for (const [label, date] of [
    ['당선', '2026-04-20'],
    ['납품', '2026-06-30'],
    ['착공', '2026-08-15'],
  ])
    records.addMilestone(projectId, { label, date });
  const ids = [];
  const members = new Set(
    [0, 1, 2, 3, 4, 5].flatMap((s) => [0, 1, 2, 3, 4].map((k) => s * 3 + 1 + k * 8)),
  );
  const stateOf = (i) => (i % 7 === 5 && !members.has(i) ? 'candidate' : 'kept');
  for (let i = 0; i < 80; i++)
    ids.push(
      records.add(
        projectId,
        {
          date: dateOf(i, 150),
          time: `${two(9 + (i % 8))}:${two((i * 7) % 60)}`,
          type: TYPES[i % 5],
          text: `${PARTS[i % 8][0]} 검토 ${i + 1} — 두께 다시 보기`,
          parts: [parts[i % 8]],
          chapter: CHAPTERS[Math.floor(i / 27)],
        },
        { by: '설계자', state: stateOf(i), source: 'note' },
      ).id,
    );
  const stories = [];
  for (let s = 0; s < 6; s++) {
    const members = [0, 1, 2, 3, 4].map((k) => ids[s * 3 + 1 + k * 8]);
    for (let k = 0; k + 1 < members.length; k++)
      records.link(projectId, members[k], members[k + 1]);
    stories.push(members);
  }
  const kept = [...Array(80).keys()].filter((i) => stateOf(i) === 'kept');
  const candidates = 80 - kept.length;
  const keptOfType = (type) => kept.filter((i) => TYPES[i % 5] === type).length;

  await page.locator('.rail [data-workspace-target="records"]').click();
  const tab = page.getByRole('region', { name: '기록', exact: true });
  await tab.waitFor();
  await tab.getByRole('tablist', { name: '기록 보기' }).getByRole('tab', { name: '차트' }).click();
  const glyphs = tab.locator('.records-chart-item');
  const countIs = (n) =>
    page.waitForFunction((n) => document.querySelectorAll('.records-chart-item').length === n, n);
  // Default chips (후보 + 남김): 남김 only, filled.
  await countIs(kept.length);
  assert.equal(await tab.locator('.records-chart-item[data-hollow="1"]').count(), 0);
  assert.equal(await tab.locator('.records-chart-row-label').count(), 8);
  assert.equal(await tab.locator('.records-chart-milestone').count(), 3);
  assert.equal(await tab.locator('.records-chart-known').count(), 4);
  assert.equal(await tab.locator('.records-glyph-root').count(), 6);

  // Labels do not overlap on screen (measured boxes).
  const overlaps = () =>
    page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.records-chart .chart-label')].map((text) =>
        text.getBoundingClientRect(),
      );
      let count = 0;
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i],
            b = boxes[j];
          if (
            a.left < b.right - 0.5 &&
            b.left < a.right - 0.5 &&
            a.top < b.bottom - 0.5 &&
            b.top < a.bottom - 0.5
          )
            count++;
        }
      return { count, labels: boxes.length };
    });
  const first = await overlaps();
  assert.equal(first.count, 0, JSON.stringify(first));
  assert.ok(first.labels > 0);

  // Type toggles: the glyphs drawn follow each one; the last one cannot be turned off.
  await tab.getByText('보기와 범례').click();
  const box = tab.locator('.records-chart-switch-box');
  await box.waitFor();
  let expected = kept.length;
  const names = { R: '요구', I: '의도', K: '앎', E: '근거', D: '결정' };
  for (const type of ['D', 'E', 'K', 'I']) {
    await box.getByRole('checkbox', { name: `${names[type]} ${type}` }).uncheck();
    expected -= keptOfType(type);
    await countIs(expected);
    assert.equal(await tab.locator(`.records-chart-item[data-type="${type}"]`).count(), 0);
  }
  assert.ok(await box.getByRole('checkbox', { name: '요구 R' }).isDisabled());
  for (const type of ['D', 'E', 'K', 'I'])
    await box.getByRole('checkbox', { name: `${names[type]} ${type}` }).check();
  await countIs(kept.length);
  assert.ok((await box.innerText()).includes(String(keptOfType('D'))));

  if (shot) await page.screenshot({ path: join(shot, 'records-chart-first.png') });
  // A story: its five glyphs stay dark, its four lines are on, 자세히 opens; Esc lets go.
  await tab.getByText('보기와 범례').click();
  const story = stories[2];
  await tab.locator(`.records-chart-item[data-record-id="${story[0]}"] .chart-hit`).first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('.records-chart-item.chart-faded').length > 0,
  );
  assert.equal(await tab.locator('.records-chart-item:not(.chart-faded)').count(), 5);
  assert.equal(await tab.locator('.chart-link-on').count(), 4);
  await tab.locator('.records-detail').waitFor();
  // The chart narrows by the 자세히 column (no wider than its frame, over the 320px floor).
  await page.waitForFunction(() => {
    const frame = document.querySelector('.records-chart');
    const svg = document.querySelector('.records-chart-svg');
    return svg.clientWidth <= Math.max(320, frame.clientWidth - 196);
  });
  if (shot) await page.screenshot({ path: join(shot, 'records-chart-chain.png') });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.records-chart-item.chart-faded'));

  // Candidates on (the chips): hollow glyphs.
  await tab.getByRole('button', { name: '후보 모두 보기' }).click();
  await countIs(candidates);
  assert.equal(await tab.locator('.records-chart-item[data-hollow="1"]').count(), candidates);
  await tab.getByRole('button', { name: '남긴 것만' }).click();
  await countIs(kept.length);

  // Row modes: 유형 (five rows), 장 (three rows); every glyph stays.
  const modes = tab.getByRole('group', { name: '행 기준' });
  await modes.getByRole('button', { name: '유형' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.records-chart-row-label').length === 5,
  );
  assert.equal(await glyphs.count(), kept.length);
  await modes.getByRole('button', { name: '장' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.records-chart-row-label').length === 3,
  );
  assert.equal((await overlaps()).count, 0);
  // 번호와 색인: numbers as labels, the index lists every glyph.
  await tab.getByText('보기와 범례').click();
  await box.getByRole('radio', { name: '번호와 색인' }).check();
  await page.waitForFunction(
    (n) =>
      [...document.querySelectorAll('.records-chart-index li')].filter(
        (li) => getComputedStyle(li).display !== 'none',
      ).length === n,
    kept.length,
  );
  assert.equal((await overlaps()).count, 0);
  await box.getByRole('radio', { name: '본문' }).check();
  await tab.getByText('보기와 범례').click();
  await modes.getByRole('button', { name: '부위' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.records-chart-row-label').length === 8,
  );
  assert.doesNotMatch(await tab.innerText(), FORBIDDEN);
  if (shot) await page.screenshot({ path: join(shot, 'records-chart.png') });

  // Print: the copied sheet only, A3; index in four columns with every record; nothing faded.
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => {
    window.print = () => {
      const root = document.querySelector('.records-print-root');
      const index = root?.querySelector('.records-chart-index');
      const rect = root?.getBoundingClientRect();
      window.__printed = {
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        columns: index ? getComputedStyle(index).columnCount : '',
        listed: [...(index?.querySelectorAll('li') ?? [])].filter(
          (li) => getComputedStyle(li).display !== 'none',
        ).length,
        glyphs: root?.querySelectorAll('.records-chart-item').length ?? 0,
        others: [...document.body.children].filter(
          (child) => child !== root && getComputedStyle(child).display !== 'none',
        ).length,
      };
    };
  });
  await tab.getByRole('button', { name: '인쇄', exact: true }).click();
  const printed = await page.evaluate(() => window.__printed);
  await page.emulateMedia({ media: 'screen' });
  console.log('print sheet', JSON.stringify(printed));
  assert.equal(printed.columns, '4');
  assert.equal(printed.listed, kept.length);
  assert.equal(printed.glyphs, kept.length);
  assert.equal(printed.others, 0);
  assert.ok(printed.width > 600 && printed.height > 300, JSON.stringify(printed));
  await page.waitForFunction(() => !document.querySelector('.records-print-root'));

  // 1,000 records: the first draw of the chart within a second.
  // 남김 only (the chips say so): 1,000 drawn in all.
  for (let i = 80; i < 80 + 1000 - kept.length; i++)
    records.add(
      projectId,
      {
        date: dateOf(i, 30),
        time: `${two(8 + (i % 10))}:${two(i % 60)}`,
        type: TYPES[i % 5],
        text: `${PARTS[i % 8][0]} 추가 메모 ${i + 1}`,
        parts: [parts[i % 8]],
      },
      { by: '설계자', state: 'kept', source: 'note' },
    );
  await tab.getByRole('tab', { name: '목록' }).click();
  await tab.getByRole('button', { name: '다시 읽기' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.records-row').length === 1000);
  const ms = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now();
        [...document.querySelectorAll('.records-view-chip')]
          .find((chip) => chip.textContent === '차트')
          .click();
        const check = () => {
          if (document.querySelectorAll('.records-chart-item').length >= 1000)
            resolve(performance.now() - start);
          else requestAnimationFrame(check);
        };
        check();
      }),
  );
  console.log(`records chart: first draw of 1,000 records ${Math.round(ms)} ms`);
  assert.ok(ms <= 1000, `${ms} ms`);
  if (shot) {
    await page.screenshot({ path: join(shot, 'records-chart-1000.png') });
    await writeFile(join(shot, 'records-chart-1000.txt'), `${Math.round(ms)} ms\n`);
  }

  assert.deepEqual(errors, []);
  console.log('browser records chart: ok');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
