// SPEC-10 end to end on the PC: VIDE's 노트·일지 screen (engine replica ↔ site Durable Object
// through a real WebSocket) and the account site edit the same note, and the engine writes the
// Markdown copy the AI reads.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyNotesPc({
  origin,
  mf,
  db,
  alice,
  project,
  noteId,
  hostDirectory,
  directory,
}) {
  const { chromium } = await import('playwright');
  const { startServer } = await import('../../src/server/server.ts');
  let chrome;
  try {
    chrome = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return 'skipped (no Chrome)';
  }
  const data = join(directory, 'pc-app');
  await mkdir(data, { recursive: true });
  // The engine reuses the PC link made earlier in the test (its host key file).
  await copyFile(join(hostDirectory, 'remote-host.json'), join(data, 'remote-host.json'));
  const host = JSON.parse(await readFile(join(data, 'remote-host.json'), 'utf8'));
  await db.prepare('UPDATE projects SET host_id=? WHERE id=?').bind(host.hostId, project.id).run();
  await db.prepare("UPDATE notes SET kind='discussion' WHERE id=?").bind(noteId).run();
  const app = await startServer({
    filename: join(data, 'test.sqlite'),
    host: { status: async () => ({ available: true }) },
    remoteOptions: {
      fetcher: (url, init) =>
        mf.dispatchFetch(String(url), {
          ...init,
          headers: { ...init?.headers, 'cf-connecting-ip': '192.0.2.51' },
        }),
      spawnProcess: () => {
        throw new Error('no tunnel in this test');
      },
      heartbeatMs: 60_000,
    },
  });
  const errors = [];
  try {
    const pc = await (
      await chrome.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    pc.setDefaultTimeout(15000);
    pc.on('pageerror', (error) => errors.push(error.message));
    await pc.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
    // The heartbeat brings the site's project to this PC.
    for (let i = 0; !app.store.listProjects().some((p) => p.id === project.id); i++) {
      if (i > 100) assert.fail('the project did not reach the PC');
      await new Promise((done) => setTimeout(done, 100));
    }
    const launch = new URL(app.launchUrl);
    launch.searchParams.set('project', project.id);
    await pc.goto(launch.href);
    await pc.waitForFunction(() => document.querySelector('#project-picker')?.value);
    await pc.locator('.rail [data-workspace-target="notes"]').click();
    const screen = pc.getByRole('region', { name: '노트·일지', exact: true });
    await screen.getByRole('button', { name: /^구조 협의/ }).click();
    await screen.getByText('실시간 연결됨').waitFor();
    // One kind on screen (T-184): a 협의 사항 row is a plain note, with no kind shown or picked.
    assert.equal(await screen.getByText('협의 사항', { exact: true }).count(), 0);
    assert.equal(await screen.getByRole('combobox', { name: '종류' }).count(), 0);
    assert.equal(await screen.getByRole('button', { name: '새 협의 사항' }).count(), 0);
    const body = (page) => page.getByLabel('노트 본문');
    const line = (page, text) => body(page).locator('p', { hasText: text }).first();
    // The whole note is there before the caret is placed.
    await line(pc, '구조사무소에 경간 12 m 확인 요청').waitFor();
    await line(pc, 'PC에서 오프라인으로 쓴 줄').click();
    await pc.waitForTimeout(300); // the click's caret reaches the editor
    await pc.keyboard.press('End');
    await pc.keyboard.press('Enter');
    await pc.keyboard.type('PC에서 적은 협의 메모');

    // The same note on the site shows the PC's line.
    const site = await (
      await chrome.newContext({ viewport: { width: 1280, height: 820 } })
    ).newPage();
    site.setDefaultTimeout(15000);
    site.on('pageerror', (error) => errors.push(error.message));
    await site.goto(origin);
    await site.getByLabel('아이디').fill(alice.username);
    await site.locator('input[autocomplete="current-password"]').fill(alice.password);
    await site.getByRole('button', { name: '로그인', exact: true }).click();
    await site.getByRole('button', { name: `${project.name} 메뉴` }).waitFor();
    await site.goto(`${origin}/?notes=${project.id}&note=${noteId}`);
    await line(site, 'PC에서 적은 협의 메모').waitFor();
    // …and the site's line reaches VIDE.
    await line(site, 'PC에서 적은 협의 메모').click();
    await site.waitForTimeout(300); // the click's caret reaches the editor
    await site.keyboard.press('End');
    await site.keyboard.press('Enter');
    await site.keyboard.type('사이트에서 답함');
    await line(pc, '사이트에서 답함').waitFor();
    // Each line stays its own paragraph on both sides.
    assert.equal(await line(pc, 'PC에서 적은 협의 메모').innerText(), 'PC에서 적은 협의 메모');
    if (process.env.VIDE_SHOT_PC) await pc.screenshot({ path: process.env.VIDE_SHOT_PC });

    // 할 일로 보내기 on a 협의 사항: its open check-list items become the project's 할 일.
    await screen.getByRole('button', { name: '할 일로 보내기' }).click();
    await screen.getByText(/할 일 \d+개를 보냈습니다|보낼 새 할 일이 없습니다/).waitFor();
    const { Agenda } = await import('../../src/core/agenda.ts');
    assert.ok(
      new Agenda(app.store)
        .list(project.id)
        .some((item) => item.text === '구조사무소에 경간 12 m 확인 요청'),
      'the 협의 사항 item is a 할 일 on the PC',
    );

    // The engine's Markdown copy for the AI follows the live note.
    const file = join(data, 'projects', project.id, 'notes', `${noteId}.md`);
    for (let i = 0; i < 50; i++) {
      const text = await readFile(file, 'utf8').catch(() => '');
      if (text.includes('사이트에서 답함') && text.includes('PC에서 적은 협의 메모')) break;
      if (i === 49) assert.fail('the PC copy did not follow the note');
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.deepEqual(errors, []);
    return 'PC and site converged';
  } finally {
    await chrome.close();
    await app.close();
  }
}
