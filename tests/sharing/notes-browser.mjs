// SPEC-10 browser check: two members open the same note on the account site and see each other's
// typing (Yjs over the note socket), the journal's 오늘 opens today's entry.
import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyNotesBrowser({ origin, alice, bob, project, directory }) {
  const { chromium } = await import('playwright');
  let chrome;
  try {
    chrome = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return 'skipped (no Chrome)';
  }
  const errors = [];
  const signIn = async (who) => {
    const context = await chrome.newContext({ viewport: { width: 1280, height: 820 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByLabel('아이디').fill(who.username);
    await page.locator('input[autocomplete="current-password"]').fill(who.password);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.getByRole('button', { name: `${project.name} 메뉴` }).waitFor();
    return page;
  };
  try {
    const a = await signIn(alice);
    await a.getByRole('button', { name: `${project.name} 메뉴` }).click();
    await a.getByRole('menuitem', { name: '노트·일지' }).click();
    await a.getByRole('button', { name: '새 노트' }).click();
    await a.getByLabel('노트 제목').fill('현장 회의');
    await a.getByLabel('노트 제목').press('Enter');
    await a.getByText('실시간 연결됨').waitFor();
    const noteUrl = a.url();
    assert.match(noteUrl, /notes=.*&note=/);

    const b = await signIn(bob);
    await b.goto(noteUrl);
    await b.getByText('실시간 연결됨').waitFor();
    await a.getByLabel('노트 본문').click();
    await a.keyboard.type('기둥 위치 확인');
    await b.getByLabel('노트 본문').getByText('기둥 위치 확인').waitFor();
    // Bob types on a new line under Alice's (her caret is still at that line's end). The editor
    // takes a click's caret on the next selection event, so the keys wait a moment.
    await b.getByLabel('노트 본문').getByText('기둥 위치 확인').click();
    await b.waitForTimeout(300);
    await b.keyboard.press('End');
    await b.keyboard.press('Enter');
    await b.keyboard.type('[ ] 구조사무소 회신 받기');
    await a.getByLabel('노트 본문').locator('p', { hasText: '구조사무소 회신 받기' }).waitFor();
    // Enter made a new block: the typed line is its own check item on both sides.
    const lines = (page) =>
      page
        .getByLabel('노트 본문')
        .locator('p')
        .evaluateAll((nodes) =>
          nodes.map((node) =>
            [...node.childNodes]
              .filter((child) => !child.classList?.contains('collaboration-carets__caret'))
              .map((child) => child.textContent)
              .join(''),
          ),
        );
    assert.deepEqual(await lines(a), ['기둥 위치 확인', '구조사무소 회신 받기']);
    assert.equal(await a.getByLabel('노트 본문').locator('li[data-checked]').count(), 1);
    // Each sees the other as present (awareness).
    await a.getByText(/함께 보는 중/).waitFor();
    if (process.env.VIDE_SHOT) await a.screenshot({ path: process.env.VIDE_SHOT });
    else await a.screenshot({ path: join(directory, 'notes-site.png') });

    // 오늘 일지 opens (or makes) today's journal entry.
    await b.getByRole('button', { name: '오늘 일지' }).click();
    await b.getByRole('heading', { name: /일지$/ }).waitFor();
    // The PC-off page lists the notes and opens one (the notes are the site's own).
    await a.goto(`${origin}/?offline=${project.id}`);
    const slot = a.getByRole('region', { name: '노트', exact: true });
    await slot.getByRole('button', { name: /현장 회의/ }).click();
    await a.getByLabel('노트 제목').waitFor();
    assert.equal(await a.getByLabel('노트 제목').inputValue(), '현장 회의');
    assert.deepEqual(errors, []);
    return 'two pages converged';
  } finally {
    await chrome.close();
  }
}
