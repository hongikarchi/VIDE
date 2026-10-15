// 연결 폴더 스키마 제안 카드 (Design SCR-36, SPEC-01.13 8, PLAN-52 T-309) in the browser: a project
// with a VIDE work folder connects a share-like folder in the dashboard → the composer sends the
// proposal request by itself → a synthetic AI calls workspace_schema_propose and ends with the card
// → the rows show guessed chips (dashed, '추정'), the competing row asks '둘 중 고르세요' and holds
// the main button until the person picks → the answer stores only the confirmed roles in the
// manifest and the card says what was remembered. Synthetic folders, no real CLI or host.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../../src/server/server.ts';
import { agentConnection } from '../../src/ai/agent-connection.ts';

const turns = [];
/** A synthetic AI: the proposal request calls workspace_schema_propose and ends with its card. */
const proposingProvider = (options) => ({
  status: async () => ({ available: true }),
  run: async (context) => {
    const goal = String(context?.goal ?? '');
    turns.push(goal);
    const done = (text, questions = []) => ({
      text: JSON.stringify({ status: questions.length ? 'question' : 'done', text, questions }),
    });
    if (goal.includes('질문 카드 답변')) return done('폴더 역할을 기억했습니다.');
    const agent = options.agent && agentConnection(options.agent);
    if (!agent?.tools.includes('workspace_schema_propose')) return done('도구가 없습니다.');
    const client = new Client({ name: 'synthetic-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(agent.url), {
        requestInit: { headers: { Authorization: `Bearer ${agent.token}` } },
      }),
    );
    const result = JSON.parse(
      (await client.callTool({ name: 'workspace_schema_propose', arguments: {} })).content[0].text,
    );
    await client.close();
    if (!result.question) return done(result.message ?? '제안할 폴더가 없습니다.');
    return done('폴더 역할을 제안합니다.', [result.question]);
  },
});

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-folder-roles-'));
const work = join(directory, '로컬 2601-작업');
const server = join(directory, 'fileserver', '2601-나진상가');
await mkdir(work, { recursive: true });
for (const file of [
  '05 도면/A-101.dwg',
  '05 도면/A-102.dwg',
  '05 도면/A-103.dwg',
  '05 도면/xref/X-base.dwg',
  '04 라이노/매스.3dm',
  '03 참고/a.jpg',
  '02 자료/법규.pdf',
  '06 도면 모델/메모.txt',
]) {
  await mkdir(join(server, ...file.split('/').slice(0, -1)), { recursive: true });
  await writeFile(join(server, ...file.split('/')), 'x');
}
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'data', 'test.sqlite'),
    providerFactory: proposingProvider,
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'codex-cli', available: true }] }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  // The project's work folder: a VIDE manifest naming this project.
  const manifest = join(work, 'project.config.json');
  await writeFile(
    manifest,
    JSON.stringify({
      schema: 'vide-workspace/1',
      title: '나진상가',
      paths: { ops: '01_운영', rhino: '03_모델', cad: '04_도면' },
      vide: { projectId },
    }),
  );
  const before = await readFile(manifest, 'utf8');
  await page.evaluate(
    async ({ id, path }) => {
      const response = await fetch(`/api/v1/projects/${id}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!response.ok) throw new Error(`folders ${response.status}`);
    },
    { id: projectId, path: work },
  );

  // The dashboard: connecting the server folder starts the proposal by itself.
  await page.locator('.rail [data-workspace-target="dashboard"]').click();
  const section = page
    .getByRole('region', { name: '대시보드', exact: true })
    .getByRole('region', { name: '프로젝트 폴더' });
  await section.getByRole('button', { name: '폴더 추가' }).click();
  await section.getByRole('textbox', { name: '폴더 경로' }).fill(server);
  await section.getByRole('button', { name: '추가', exact: true }).click();
  await section.getByRole('list', { name: '프로젝트 폴더 목록' }).getByText(server).waitFor();

  // The card is in the conversation (beside the model view; the dashboard has no chat column).
  await page.locator('.rail [data-workspace-target="model"]').click();
  const card = page.getByLabel('폴더 역할 제안', { exact: true });
  await card.waitFor();
  assert.ok(turns.some((goal) => goal.includes('연결한 폴더의 역할을 제안해 주세요')));
  // Guesses: dashed chips with '추정'; the evidence under each folder.
  const chips = card.locator('.wschema-chip');
  assert.equal(await card.locator('.wschema-chip[data-state="guess"]').count(), 4);
  const drawing = card.locator('.wschema-row', { hasText: '05 도면' });
  assert.match(await drawing.locator('.wschema-chip').innerText(), /도면\s*추정/);
  assert.equal(await drawing.locator('.wschema-reason').innerText(), 'DWG 4개 · xref 1');
  assert.equal(
    await drawing.locator('.wschema-chip').evaluate((node) => getComputedStyle(node).borderStyle),
    'dashed',
  );
  await card
    .getByText('보고서를 둘 곳이 보이지 않습니다 — 반영할 때 물어보고 기억합니다.')
    .waitFor();
  // The competing row holds [이 답으로 진행] until the person picks.
  const both = card.locator('.wschema-row', { hasText: '06 도면 모델' });
  assert.match(await both.locator('.wschema-chip').innerText(), /둘 중 고르세요/);
  const proceed = page.getByRole('button', { name: '이 답으로 진행' });
  assert.equal(await proceed.isDisabled(), true);
  // Nothing written while the card waits.
  assert.equal(await readFile(manifest, 'utf8'), before);
  if (shot) await page.screenshot({ path: join(shot, 'workspace-schema-card.png') });
  await both.getByRole('button', { name: '06 도면 모델 역할 고르기' }).click();
  await both.getByRole('combobox', { name: '06 도면 모델 역할' }).selectOption('rhino');
  // A picked chip is solid without '추정'.
  const picked = both.locator('.wschema-chip[data-state="chosen"]');
  assert.equal(await picked.innerText(), '모델');
  assert.equal(await picked.evaluate((node) => getComputedStyle(node).borderStyle), 'solid');
  assert.equal(await chips.filter({ hasText: '둘 중' }).count(), 0);
  // No internal words on the card.
  const words = await card.innerText();
  assert.doesNotMatch(words, /workspace|schema|PLAN-|SPEC-|undefined|null/);
  await proceed.click();
  // The answer turn shows what was remembered (the person's message of the next turn).
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.task-title, .qcard-note')].some((node) =>
      /폴더 역할 기억 · 자료=02 자료/.test(node.textContent ?? ''),
    ),
  );
  const saved = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(saved.server.root.toLowerCase(), server.toLowerCase());
  assert.deepEqual(saved.server.paths, {
    raw: '02 자료',
    rhino: '06 도면 모델',
    cad: '05 도면',
    references: '03 참고',
  });
  // 04 라이노 was also a model folder: one folder per role, the first one the person kept.
  assert.deepEqual(saved.paths, { ops: '01_운영', rhino: '03_모델', cad: '04_도면' });
  if (shot) await page.screenshot({ path: join(shot, 'workspace-schema-remembered.png') });
  assert.deepEqual(errors, []);
  console.log('workspace schema card browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
