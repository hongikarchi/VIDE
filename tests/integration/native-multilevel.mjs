import { installBrowserSupport } from './browser-support.mjs';
// Two explicit subscription calls, isolated synthetic candidates, no original document apply.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [playwright, launch, flag, existingProject] = process.argv.slice(2);
if (flag !== '--run-live') throw Error('Pass --run-live');
const { chromium } = await import(pathToFileURL(playwright).href),
  { url } = JSON.parse(await readFile(launch, 'utf8'));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await installBrowserSupport(page);
  await page.goto(url);
  const ready = () => page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await ready();
  const projectId =
    existingProject ||
    (await page.evaluate(async () => {
      const api = window.testApi;
      return (await api('/projects', 'POST', { name: '합성 8층 매스 검수' })).id;
    }));
  console.log(JSON.stringify({ projectId }));
  await page.goto(new URL('/?project=' + projectId, url).href);
  await ready();
  const read = () =>
    page.evaluate(async (id) => {
      const api = window.testApi;
      return api(`/projects/${id}/requests`);
    }, projectId);
  const submit = async (body, count) => {
    const rows = await read();
    if (rows.length < count) {
      await page.locator('#model').selectOption('claude-cli');
      await page.locator('#permission').selectOption('candidate');
      await page.locator('#body').fill(body);
      await page.locator('#request').click();
    }
    const deadline = Date.now() + 210000;
    while (true) {
      const rows = await read();
      if (rows.length >= count && !['queued', 'running'].includes(rows[count - 1].state)) {
        assert.equal(rows[count - 1].state, 'succeeded');
        return rows[count - 1];
      }
      if (Date.now() > deadline) throw Error('Inspect saved project before retry');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  const first = await submit(
    '합성 8층 모델을 만들어. 층 슬래브 8개는 각각 독립 닫힌 XY 돌출체로, ID는 slab-1부터 slab-8, 이름은 L01부터 L08. 각 경계는 (0,0,z),(20,0,z),(20,10,z),(0,10,z),(0,0,z) m이고 z는 순서대로 0,3,6,9,12,15,18,21 m, 돌출 높이는 모두 0.3 m. 코어 하나는 ID core, 이름 Core, 원점 (8,3,0) m, 크기 (4,4,24) m의 박스로 만들어. 이외 객체는 만들지 마. 겹침을 빼거나 법정 면적을 추정하지 마.',
    1,
  );
  assert.equal(first.result.hostExecuted, true);
  assert.equal(first.result.objects.length, 9);
  assert.ok(Math.abs(first.result.scene.reduce((sum, o) => sum + o.volume, 0) - 864) < 0.001);
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent.startsWith('9개 객체'),
  );
  const second = await submit(
    'slab-5, slab-6, slab-7, slab-8 네 객체의 돌출 높이만 각각 0.25 m로 바꿔. 경계 점열과 층 기준 z, 나머지 4개 슬래브와 core는 그대로 유지해.',
    2,
  );
  assert.equal(second.result.hostExecuted, true);
  assert.equal(second.result.baseRequestId, first.id);
  assert.equal(second.result.objects.length, 9);
  for (const before of first.result.objects) {
    const after = second.result.objects.find((o) => o.id === before.id);
    assert.ok(after);
    if (['slab-5', 'slab-6', 'slab-7', 'slab-8'].includes(before.id)) {
      assert.equal(after.height, 0.25);
      assert.deepEqual(after.points, before.points);
    } else assert.deepEqual(after, before);
  }
  const comparison = await page.evaluate(
    async ({ projectId, before, after }) => {
      const api = window.testApi;
      return api(`/projects/${projectId}/comparison?before=${before}&after=${after}`);
    },
    { projectId, before: first.id, after: second.id },
  );
  assert.equal(comparison.rows.filter((row) => row.status === 'changed').length, 4);
  assert.ok(
    Math.abs(comparison.rows.reduce((sum, row) => sum + (row.delta.volume || 0), 0) + 40) < 0.001,
  );
  await page.waitForFunction(() => document.querySelectorAll('#task-list .task-row').length >= 2);
  await page.screenshot({ path: 'docs/assets/native-workspace/multilevel-candidate.png' });
  console.log(
    JSON.stringify({
      projectId,
      first: first.id,
      second: second.id,
      objects: 9,
      changed: 4,
      volumeDelta: -40,
      unchangedObjects: 5,
      originalApplied: false,
    }),
  );
} finally {
  await browser.close();
}
