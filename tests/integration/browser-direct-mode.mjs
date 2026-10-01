// Direct mode in the work view (ADR-022, user decision 2026-09-30) against mocked request routes
// (no host, no CLI): the 계획 / 자동 toggle, per-execution change rows with [되돌리기]
// (…/undo {executionId}, including the host's 'not-latest' refusal), the guard card whose [진행]
// posts …/confirm, and the plan card whose [진행] posts …/continue and opens the continued work.
// A multi-file request (ADR-027) groups its rows by file with one [되돌리기] (…/undo {all: true})
// and shows a partial undo and an automatic rollback per file.
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
    // Two linked files in one request (ADR-027): rows carry their file; one undo for the request.
    const file = (name, instance) => ({
      host: 'rhino',
      target: { instance, documentId: 7 },
      file: { linkId: 'link-' + name, name },
    });
    if (input.body.startsWith('두 파일 맞추기'))
      return {
        state: 'succeeded',
        result: {
          mode: 'auto',
          executionMode: 'direct',
          appliedDirectly: true,
          multiFile: true,
          text: '두 파일을 맞췄습니다.',
          executions: [
            {
              executionId: 'm-1',
              undoId: 'a-1',
              state: 'applied',
              label: '구조 기둥 옮기기',
              ...file('구조.3dm', 'win-a'),
              changes: { added: [], changed: [added('c-1'), added('c-2')], removed: [] },
            },
            {
              executionId: 'm-2',
              undoId: 'b-1',
              state: 'applied',
              label: '평면 기둥 맞추기',
              ...file('평면.3dm', 'win-b'),
              changes: { added: [added('p-1', '평면')], changed: [], removed: [] },
            },
            {
              executionId: 'm-3',
              undoId: 'a-2',
              state: 'applied',
              label: '구조 보 맞추기',
              ...file('구조.3dm', 'win-a'),
              changes: { added: [added('g-1', '보')], changed: [], removed: [] },
            },
          ],
        },
      };
    if (input.body.startsWith('실패한 두 파일 작업'))
      return {
        state: 'failed',
        result: {
          mode: 'auto',
          executionMode: 'direct',
          appliedDirectly: true,
          multiFile: true,
          code: 'PROVIDER_TIMEOUT',
          executions: [
            {
              executionId: 'f-1',
              undoId: 'a-9',
              state: 'undone',
              label: '구조 기둥 옮기기',
              ...file('구조.3dm', 'win-a'),
              changes: { added: [], changed: [added('c-1')], removed: [] },
            },
            {
              executionId: 'f-2',
              undoId: 'b-9',
              state: 'undone',
              label: '평면 기둥 맞추기',
              ...file('평면.3dm', 'win-b'),
              changes: { added: [added('p-9', '평면')], changed: [], removed: [] },
            },
          ],
          rollback: {
            at: '2026-10-01T00:00:00.000Z',
            reason: 'failed',
            files: [
              {
                name: '구조.3dm',
                ...file('구조.3dm', 'win-a'),
                state: 'undone',
                undone: 1,
                kept: 0,
              },
              {
                name: '평면.3dm',
                ...file('평면.3dm', 'win-b'),
                state: 'undone',
                undone: 1,
                kept: 0,
              },
            ],
          },
        },
      };
    // The host refused before running (a read-only document): nothing ran, the reason is shown.
    if (input.body.startsWith('읽기 전용 문서에 벽'))
      return {
        state: 'succeeded',
        result: {
          mode: 'auto',
          executionMode: 'direct',
          appliedDirectly: false,
          text: '문서가 읽기 전용이라 실행하지 않았습니다.',
          executions: [],
          refused: {
            code: 'DOCUMENT_READ_ONLY',
            reason:
              '읽기 전용으로 열린 문서라 실행하지 않았습니다. Rhino에서 다른 이름으로 저장(같은 이름에 덮어쓰기)한 뒤 다시 요청하세요.',
          },
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
    if (action === 'undo' && body.all === true) {
      // The whole request: the first press finds 평면.3dm edited after it (not-latest), the
      // second undoes what is left.
      const left = request.result.executions.filter((row) => row.state === 'applied');
      const blocked = !request.undoTried;
      request.undoTried = true;
      for (const row of left) if (!blocked || row.file.name !== '평면.3dm') row.state = 'undone';
      const files = ['구조.3dm', '평면.3dm'].map((name) => ({
        name,
        host: 'rhino',
        target: left.find((row) => row.file.name === name)?.target,
        state: blocked && name === '평면.3dm' ? 'refused' : 'undone',
        ...(blocked && name === '평면.3dm' ? { reason: 'not-latest' } : {}),
      }));
      request.result = { ...request.result, undo: { at: 'now', files } };
      return route.fulfill({ json: { ok: !blocked, files, request } });
    }
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

  // Two files in one request: rows grouped by file, one [되돌리기] for the whole request.
  await send('두 파일 맞추기');
  const groups = work().locator('.direct-file');
  await groups.first().waitFor();
  assert.equal(await groups.count(), 2);
  assert.match(
    await groups.nth(0).locator('.direct-file-head').textContent(),
    /구조\.3dm.*Rhino · 추가 1 · 변경 2 · 삭제 0/,
  );
  assert.match(
    await groups.nth(1).locator('.direct-file-head').textContent(),
    /평면\.3dm.*추가 1 · 변경 0 · 삭제 0/,
  );
  assert.equal(await groups.nth(0).locator('.direct-execution').count(), 2);
  // No [되돌리기] per row: one for the request.
  assert.equal(await groups.getByRole('button', { name: '되돌리기', exact: true }).count(), 0);
  const requestUndo = work().locator('.direct-request-undo');
  assert.match(await requestUndo.textContent(), /파일 2개의 실행 3개를 되돌립니다/);
  await requestUndo.getByRole('button', { name: '되돌리기', exact: true }).click();
  // 평면.3dm was edited after it: that file stays and is named; 구조.3dm is undone.
  await page.waitForFunction(() =>
    document.querySelector('.work-view .direct-rollback')?.textContent.includes('평면.3dm'),
  );
  assert.match(
    await work().locator('.direct-rollback').textContent(),
    /되돌리지 못한 파일: 평면\.3dm\(되돌리지 못함 · 그 뒤에 문서가 더 바뀜\)/,
  );
  await page.waitForFunction(() =>
    document.querySelector('#message')?.textContent.includes('일부 파일은 되돌리지 못했습니다'),
  );
  assert.match(await groups.nth(0).locator('.direct-file-head').textContent(), /되돌림/);
  assert.equal(
    await groups.nth(1).locator('.direct-execution').first().getAttribute('data-state'),
    'applied',
  );
  assert.match(await requestUndo.textContent(), /파일 1개의 실행 1개를 되돌립니다/);
  await requestUndo.getByRole('button', { name: '되돌리기', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.work-view .direct-request-undo'));
  assert.equal(await work().locator('.direct-execution[data-state="applied"]').count(), 0);
  assert.deepEqual(
    calls.slice(-2).map(({ action, body }) => [action, body.all]),
    [
      ['undo', true],
      ['undo', true],
    ],
  );

  // A failed multi-file request was rolled back automatically: the result says so per file.
  await send('실패한 두 파일 작업');
  const rolled = work().locator('.direct-rollback');
  await rolled.waitFor();
  assert.match(
    await rolled.textContent(),
    /요청이 실패해서 모든 파일의 변경을 자동으로 되돌렸습니다/,
  );
  assert.equal(await work().locator('.direct-file').count(), 2);
  assert.equal(await work().locator('.direct-request-undo').count(), 0);

  // A refusal before execution reads as not run with the reason, never as an unknown result.
  await send('읽기 전용 문서에 벽 추가');
  const refusedNote = work().locator('.direct-refused');
  await refusedNote.waitFor();
  assert.match(
    await refusedNote.textContent(),
    /^실행하지 않음 · 읽기 전용으로 열린 문서라 실행하지 않았습니다\. Rhino에서 다른 이름으로 저장/,
  );
  assert.doesNotMatch(await work().textContent(), /호스트 결과 확인 필요|확인되지 않았습니다/);
  assert.equal(await work().locator('.direct-execution').count(), 0);

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
    'Browser direct mode: mode toggle, execution rows with undo and not-latest, guard confirmation, multi-file groups with request undo and rollback, refusal before execution and plan continuation passed.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
