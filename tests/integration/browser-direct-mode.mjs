// Direct mode in the work view (ADR-022, user decision 2026-09-30) against mocked request routes
// (no host, no CLI): the 계획 / 자동 toggle, per-execution change rows with [되돌리기]
// (…/undo {executionId}, including the host's 'not-latest' refusal), the guard card whose [진행]
// posts …/confirm, and the plan card whose [진행] posts …/continue and opens the continued work.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-direct-mode-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'test', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route(/\/route$/, (route) => route.fulfill({ json: { target: null } }));

  // The mocked engine: each posted request gets a scripted result by its words.
  const requests = new Map();
  const calls = [];
  const added = (id, layer = '기둥') => ({ nativeId: id, hash: 'h-' + id, layer });
  const scripted = (input) => {
    if (input.body.startsWith('기둥 추가'))
      return {
        state: 'succeeded',
        result: {
          mode: 'auto',
          text: '기둥 두 개를 추가했습니다.',
          executions: [
            {
              executionId: 'undo-1',
              undoId: 'undo-1',
              label: '기둥 추가',
              changes: { added: [added('c-1'), added('c-2')], changed: [], removed: [] },
            },
            {
              executionId: 'undo-2',
              undoId: 'undo-2',
              label: '기둥 이름 붙이기',
              changes: { added: [], changed: [added('c-1')], removed: [] },
            },
          ],
        },
      };
    if (input.body.startsWith('옛 벽 지우기'))
      return {
        state: 'needs-confirmation',
        result: {
          mode: 'auto',
          executions: [],
          guarded: { kind: 'bulk-delete', detail: '객체 120개 삭제' },
        },
      };
    // The engine's own shape: the held execution is a row (state guarded, no undo record).
    if (input.body.startsWith('옛 레이어 지우기'))
      return {
        state: 'needs-confirmation',
        result: {
          mode: 'auto',
          executionMode: 'direct',
          appliedDirectly: false,
          executions: [
            {
              executionId: 'held-1',
              state: 'guarded',
              undoId: null,
              label: 'VIDE AI 1: 옛 레이어 지우기',
              guarded: { kind: 'layer-delete', detail: '레이어 1개 삭제: 옛 벽' },
            },
          ],
          guarded: {
            executionId: 'held-1',
            kind: 'layer-delete',
            detail: '레이어 1개 삭제: 옛 벽',
          },
        },
      };
    return {
      state: 'succeeded',
      result: {
        mode: 'plan',
        text: '계획을 세웠습니다.',
        plan: {
          steps: [
            { title: '기둥 위치 확인', objects: ['c-1', 'c-2'] },
            { title: '보 높이 맞추기', risk: '보 레이어 이름이 둘입니다' },
          ],
          questions: ['기둥 크기는 500 × 500으로 할까요?'],
        },
      },
    };
  };
  await page.route(/\/requests$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const input = route.request().postDataJSON();
    const request = { id: input.id, input, ...scripted(input) };
    requests.set(input.id, request);
    await route.fulfill({ json: request });
  });
  await page.route(/\/requests\/[^/?]+$/, (route) => {
    const request = requests.get(route.request().url().split('/').at(-1));
    return request ? route.fulfill({ json: request }) : route.continue();
  });
  await page.route(/\/requests\/[^/]+\/(undo|confirm|continue)$/, async (route) => {
    const parts = route.request().url().split('/');
    const [id, action] = parts.slice(-2);
    const body = route.request().postDataJSON() ?? {};
    calls.push({ id, action, body });
    const request = requests.get(id);
    if (action === 'undo') {
      // Only the latest record can be undone here (the host answers 'not-latest' otherwise).
      const latest = request.result.executions.filter((row) => row.state !== 'undone').at(-1);
      if (latest?.executionId !== body.executionId)
        return route.fulfill({ json: { ok: false, reason: 'not-latest' } });
      latest.state = 'undone';
      return route.fulfill({ json: { ok: true } });
    }
    if (action === 'confirm' && body.executionId === 'held-1') {
      // As execution.confirm answers: the held row turns 'confirmed', the re-run is a new row.
      request.state = 'succeeded';
      request.result = {
        ...request.result,
        guarded: undefined,
        appliedDirectly: true,
        executions: [
          { ...request.result.executions[0], state: 'confirmed', guarded: undefined },
          {
            executionId: 'run-2',
            state: 'applied',
            undoId: '52',
            label: 'VIDE AI 1: 옛 레이어 지우기',
            confirms: 'held-1',
            changes: { added: [], changed: [], removed: [added('w-1', '옛 벽')] },
          },
        ],
      };
      return route.fulfill({ json: request });
    }
    if (action === 'confirm') {
      request.state = 'succeeded';
      request.result = {
        mode: 'auto',
        text: '확인 후 지웠습니다.',
        executions: [
          {
            executionId: 'undo-3',
            undoId: 'undo-3',
            label: '옛 벽 지우기',
            confirmedGuard: { kind: 'bulk-delete' },
            changes: {
              added: [],
              changed: [],
              removed: Array.from({ length: 120 }, (_, i) => ({ nativeId: 'w-' + i, layer: '벽' })),
            },
          },
        ],
      };
      return route.fulfill({ json: { ok: true } });
    }
    // continue: the same conversation goes on in 자동 as a new request.
    // The engine answers with the continued request itself (execution.continuePlan), which names
    // its plan by `continuesPlanId`; the plan's own result is not rewritten.
    const next = {
      id: 'continued-1',
      input: { ...request.input, id: 'continued-1', mode: 'auto', continuesPlanId: id },
      state: 'running',
      result: null,
    };
    requests.set(next.id, next);
    return route.fulfill({ json: next });
  });

  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.locator('#model').selectOption('test');
  assert.equal(await page.locator('#permission').count(), 0);
  const modeButton = (value) => page.locator(`#mode-toggle [data-mode="${value}"]`);
  assert.equal(await modeButton('auto').getAttribute('aria-checked'), 'true');
  const send = async (text) => {
    await page.locator('#body').fill(text);
    await page.locator('#request').click();
    await page.waitForFunction(() => document.querySelector('#body').value === '');
  };
  const work = () => page.locator('.work-view');

  // 자동: one row per execution with its counts and [되돌리기].
  await send('기둥 추가해줘');
  await page.locator('.direct-execution').first().waitFor();
  const rows = work().locator('.direct-execution');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).textContent(), /기둥 추가.*추가 2 · 변경 0 · 삭제 0.*적용됨/);
  assert.match(await work().locator('.work-conditions').textContent(), /모드자동/);
  assert.equal(await work().getByText('이 후보 보기', { exact: true }).count(), 0);
  assert.equal(await work().getByText('문서에 적용', { exact: true }).count(), 0);
  // An older record is refused by the host: the notice says to use Ctrl+Z in order.
  await rows.nth(0).getByRole('button', { name: '되돌리기', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('#message')?.textContent.includes('Ctrl+Z'),
  );
  // The latest one is undone and the row says so.
  await rows.nth(1).getByRole('button', { name: '되돌리기', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.direct-execution')[1]?.dataset.state === 'undone' &&
      document.querySelectorAll('.direct-execution')[1]?.textContent.includes('되돌림'),
  );
  assert.equal(await rows.nth(1).getByRole('button', { name: '되돌리기', exact: true }).count(), 0);
  assert.deepEqual(
    calls.map(({ action, body }) => [action, body.executionId]),
    [
      ['undo', 'undo-1'],
      ['undo', 'undo-2'],
    ],
  );

  // A guarded effect: the host undid it; [진행] confirms and the result shows the deletion.
  await send('옛 벽 지우기');
  const guard = work().locator('.guard-card');
  await guard.waitFor();
  assert.match(await guard.textContent(), /대량 삭제 · 객체 120개 삭제/);
  assert.match(await work().locator('.card-state').textContent(), /진행 확인 필요/);
  await guard.getByRole('button', { name: '진행', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.direct-execution')?.textContent.includes('삭제 120'),
  );
  assert.equal(await work().locator('.guard-card').count(), 0);
  assert.equal(calls.at(-1).action, 'confirm');

  // The engine's shape: the guard sits on the held row; [진행] posts its executionId. The held
  // row then reads 'confirmed' without [되돌리기] (it has no undo record); the re-run has one.
  await send('옛 레이어 지우기');
  const heldRow = work().locator('.direct-execution[data-state="guarded"]');
  await heldRow.waitFor();
  assert.match(
    await heldRow.locator('.guard-card').textContent(),
    /레이어 삭제 · 레이어 1개 삭제: 옛 벽/,
  );
  assert.equal(await work().locator('.guard-card').count(), 1);
  await heldRow.getByRole('button', { name: '진행', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.work-view .direct-execution').length === 2,
  );
  assert.deepEqual(calls.at(-1), {
    id: calls.at(-1).id,
    action: 'confirm',
    body: { executionId: 'held-1' },
  });
  const confirmedRows = work().locator('.direct-execution');
  assert.equal(await confirmedRows.nth(0).getAttribute('data-state'), 'confirmed');
  assert.equal(
    await confirmedRows.nth(0).getByRole('button', { name: '되돌리기', exact: true }).count(),
    0,
  );
  assert.equal(
    await confirmedRows.nth(1).getByRole('button', { name: '되돌리기', exact: true }).count(),
    1,
  );

  // 계획: the AI plans without writing; [진행] continues in 자동 and opens that work.
  await modeButton('plan').click();
  assert.match(await page.locator('#mode-status').textContent(), /계획/);
  await send('보 높이 정리 계획');
  const plan = work().locator('.plan-card');
  await plan.waitFor();
  const posted = [...requests.values()].at(-1).input;
  assert.deepEqual([posted.mode, posted.permission], ['plan', 'review']);
  assert.match(await plan.textContent(), /기둥 위치 확인 · 객체 2개/);
  assert.match(await plan.textContent(), /주의: 보 레이어 이름이 둘입니다/);
  assert.match(await plan.textContent(), /기둥 크기는 500 × 500으로 할까요\?/);
  await plan.getByRole('button', { name: '진행', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.work-view')?.dataset.requestId === 'continued-1',
  );
  assert.equal(calls.at(-1).action, 'continue');
  assert.match(await work().locator('.work-conditions').textContent(), /모드자동/);
  // The old candidate / apply controls are gone from the composer.
  assert.equal(await page.locator('#permission, #apply-to-source').count(), 0);
  assert.equal(await page.getByRole('button', { name: '문서에 적용', exact: true }).count(), 0);
  // The toggle is the user's: continuing a plan does not switch it.
  assert.equal(await modeButton('plan').getAttribute('aria-checked'), 'true');
  assert.deepEqual(pageErrors, []);
  console.log(
    'Browser direct mode: mode toggle, execution rows with undo and not-latest, guard confirmation and plan continuation passed.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
