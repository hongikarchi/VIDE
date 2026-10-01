// UI preview snapshot (VERIFY 기록 없이 쓰는 미리보기 도구, AI.md §2 tools/mockups).
// Starts the real engine on a temporary database, opens the built UI (dist/ui, run
// `npm run build:web` first), seeds an example project, visits each rail destination (and one
// open jig instance, which shows the row of open tabs) and saves
// one static HTML page per screen state into a single preview file: the DOM as rendered, the
// stylesheets inlined, the 3D view as a picture. The page has no app logic; a small switcher
// changes screens. Usage: node tools/mockups/ui-preview/snapshot.mjs [out.html]
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../../src/server/server.ts';
import { injectProposal, proposalPayload } from './proposal-reference.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, 'index.html'));
const directory = await mkdtemp(join(tmpdir(), 'vide-ui-preview-'));
const app = await startServer({ filename: join(directory, 'preview.sqlite') });
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({
      json: [
        { id: 'claude-cli', available: true },
        { id: 'codex-cli', available: true },
      ],
    }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [
        {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          provider: 'claude-cli',
          efforts: ['default', 'medium', 'high'],
        },
      ],
    }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();

  // Example data (not user data): two linked files and one Sync with a small frame.
  const db = app.store.db;
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run('S-06 예시 프로젝트', projectId);
  const now = Date.now();
  const at = (s) => new Date(now - s * 1000).toISOString();
  const link = (id, host, name, s) =>
    db
      .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
      .run(id, projectId, host, name, 'C:\\예시\\' + name, '1:2', 1, at(s), at(s));
  link('link-rhino', 'rhino', 'S-06_구조.3dm', 120);
  link('link-cad', 'zwcad', 'S-06_평면.dwg', 300);
  const b64 = (text) => Buffer.from(text).toString('base64');
  const scene = [];
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 4; j++) {
      const x = i * 12,
        y = j * 8.4;
      scene.push({
        id: `c-${i}-${j}`,
        nativeId: `c-${i}-${j}`,
        nativeType: 'Curve',
        segments: [x, y, 0, x, y, 6.2],
        layer64: b64('S-COL'),
      });
      if (i < 5)
        scene.push({
          id: `gx-${i}-${j}`,
          nativeId: `gx-${i}-${j}`,
          nativeType: 'Curve',
          segments: [x, y, 6.2, x + 12, y, 6.2],
          layer64: b64('S-GIRDER'),
        });
      if (j < 3)
        scene.push({
          id: `gy-${i}-${j}`,
          nativeId: `gy-${i}-${j}`,
          nativeType: 'Curve',
          segments: [x, y, 6.2, x, y + 8.4, 6.2],
          layer64: b64('S-GIRDER'),
        });
    }
  const requestId = 'preview-sync-1';
  db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
    requestId,
    projectId,
    JSON.stringify({
      id: requestId,
      linkId: 'link-rhino',
      provider: 'codex-cli',
      host: 'rhino',
      source: 'document',
      permission: 'candidate',
      body: 'S-06_구조.3dm 가져오기',
      pins: [],
      sketches: [],
      files: [],
    }),
    'succeeded',
    JSON.stringify({
      hostExecuted: true,
      executionMode: 'sdk',
      host: 'rhino',
      displayOnly: true,
      objects: scene.map((item) => ({
        id: item.id,
        name: item.nativeId,
        kind: 'native',
        nativeId: item.nativeId,
      })),
      scene,
      sourceDocument: {
        name: 'S-06_구조.3dm',
        capturedAt: at(120),
        instance: '1:2',
        documentId: 1,
      },
    }),
    at(120),
  );
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.waitForTimeout(1500);

  const styles = await page.evaluate(() =>
    [...document.styleSheets]
      .map((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
        } catch {
          return '';
        }
      })
      .join('\n')
      // Bundled font files are not published with the preview; Google Fonts stands in.
      .replace(/@font-face\s*\{[^}]*\}/g, ''),
  );

  const states = [];
  const capture = async (id, label) => {
    await page.waitForTimeout(700);
    const canvases = await page.locator('canvas:visible').all();
    const pictures = [];
    for (const canvas of canvases) {
      const box = await canvas.boundingBox();
      if (!box || box.width < 40 || box.height < 40) {
        pictures.push('');
        continue;
      }
      const png = await canvas.screenshot({ type: 'jpeg', quality: 82 });
      pictures.push('data:image/jpeg;base64,' + png.toString('base64'));
    }
    const snap = await page.evaluate((pictures) => {
      const clone = document.body.cloneNode(true);
      const live = [...document.querySelectorAll('canvas')].filter((c) => c.offsetParent);
      const copies = [...clone.querySelectorAll('canvas')];
      const all = [...document.querySelectorAll('canvas')];
      copies.forEach((copy, i) => {
        const index = live.indexOf(all[i]);
        const src = index >= 0 ? pictures[index] : '';
        if (!src) return copy.remove();
        const img = document.createElement('img');
        img.src = src;
        img.alt = '3D 화면';
        img.className = copy.className;
        img.setAttribute(
          'style',
          (copy.getAttribute('style') || '') +
            ';width:100%;height:100%;object-fit:cover;display:block',
        );
        copy.replaceWith(img);
      });
      clone.querySelectorAll('script, noscript').forEach((node) => node.remove());
      clone.querySelectorAll('input, textarea').forEach((node) => {
        if (node.value) node.setAttribute('value', node.value);
      });
      return {
        html: [...document.documentElement.attributes].map((a) => [a.name, a.value]),
        body: [...document.body.attributes].map((a) => [a.name, a.value]),
        // No real account address in a shared preview.
        content: clone.innerHTML.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'account@example.com'),
      };
    }, pictures);
    states.push({ id, label, ...snap });
  };
  // The rail's fixed destinations (src/ui/index.html `data-workspace-target`).
  const tab = (id) => page.locator(`.rail [data-workspace-target="${id}"]`).click();

  await tab('dashboard');
  await capture('dashboard', '대시보드');
  await tab('model');
  await capture('model', '모델');
  await tab('data');
  await capture('data', '자료');
  await tab('jig');
  await capture('jig', 'JIG');
  await tab('make');
  await capture('make', '만들기');
  await tab('output');
  for (const sub of ['도면', '보고서', '렌더링']) {
    const button = page
      .getByRole('tab', { name: sub })
      .or(page.getByRole('button', { name: sub }))
      .first();
    if (await button.count()) await button.click();
    await capture('output-' + sub, '산출물 · ' + sub);
  }
  // An open jig instance (the example grid jig, a new 작업본): the row of open tabs shows.
  await tab('jig');
  const grid = page.locator('.jig-card', { hasText: '격자 골조 배치 예제' }).first();
  try {
    await grid.waitFor({ timeout: 5000 });
    await grid.getByRole('button', { name: '새로 열기', exact: true }).click();
    await grid.getByLabel('출력 레이어').fill('VIDE 출력');
    await grid.getByRole('button', { name: '열기', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.workspace === 'context');
    await page.waitForFunction(
      () => document.querySelector('.jig-dialog h2')?.textContent === '격자 골조 배치 예제',
    );
    await capture('jig-instance', 'JIG · 열린 작업본');
    await page.locator('.workspace-tablist .workspace-tab-close').first().click();
  } catch (error) {
    console.warn('jig instance state skipped:', error.message.split('\n')[0]);
  }
  await tab('model');
  await page.locator('#rail-theme').click();
  await capture('model-dark', '모델 · 다크');
  await page.locator('#rail-theme').click();

  // The reference-image tab as built (SPEC-09, PLAN-26 T-090 phase (a)): an example image drawn
  // in the page is attached, two regions are drawn and the board's frame is opened. Engine images
  // are made data URLs so the static preview shows them.
  try {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 560;
      const g = canvas.getContext('2d');
      const sky = g.createLinearGradient(0, 0, 0, 560);
      sky.addColorStop(0, 'rgb(217 226 231)');
      sky.addColorStop(1, 'rgb(241 239 233)');
      g.fillStyle = sky;
      g.fillRect(0, 0, 800, 560);
      g.fillStyle = 'rgb(205 200 190)';
      g.fillRect(0, 470, 800, 90);
      g.fillStyle = 'rgb(230 224 212)';
      g.fillRect(120, 70, 560, 400);
      g.fillStyle = 'rgb(86 100 108)';
      for (const y of [76, 156, 236, 316]) g.fillRect(140, y, 520, 70);
      g.fillStyle = 'rgb(192 138 86)';
      for (let x = 146; x <= 650; x += 18) g.fillRect(x, 74, 6, 314);
      g.fillStyle = 'rgb(63 76 83)';
      g.fillRect(140, 398, 520, 72);
      g.fillStyle = 'rgb(43 43 43)';
      g.fillRect(318, 390, 164, 7);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#files').setInputFiles({
      name: 'facade.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    const chip = page.locator('#context .chip').filter({ hasText: 'facade.png' });
    await chip.getByRole('button', { name: '영역 표시' }).click();
    await page.locator('.reference-stage img').waitFor();
    await page.waitForTimeout(300);
    const box = await page.locator('.reference-stage img').boundingBox();
    const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
    await page.locator('.reference-tools input[type="range"]').fill('60');
    await page.mouse.move(...at(0.56, 0.2));
    await page.mouse.down();
    for (let k = 1; k <= 12; k++) await page.mouse.move(...at(0.56 + k * 0.02, 0.2 + k * 0.04));
    await page.mouse.up();
    await page.getByLabel('영역 A 메모').fill('루버 간격과 깊이 느낌만');
    await page.getByLabel('영역 A 메모').press('Enter');
    await page.getByRole('button', { name: '+ 새 영역' }).click();
    await page.getByRole('button', { name: '사각형', exact: true }).click();
    await page.mouse.move(...at(0.39, 0.68));
    await page.mouse.down();
    await page.mouse.move(...at(0.61, 0.74));
    await page.mouse.up();
    await page.getByLabel('영역 B 메모').fill('형태만, 색은 빼고');
    await page.getByLabel('영역 B 메모').press('Enter');
    const inline = () =>
      page.evaluate(async () => {
        for (const img of document.querySelectorAll('.reference-workspace img, img.chip-thumb')) {
          if (img.src.startsWith('data:')) continue;
          await img.decode().catch(() => {});
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext('2d').drawImage(img, 0, 0);
          img.src = canvas.toDataURL('image/jpeg', 0.85);
        }
      });
    await inline();
    await capture('reference-mask', '참고 이미지 · 영역 표시 (구현)');
    await page.getByRole('button', { name: '이해 확인' }).click();
    await page.locator('.reference-board').waitFor();
    await inline();
    await capture('reference-board', '이해 확인 · 틀 (구현)');
    await page.locator('.workspace-tablist .workspace-tab-close').first().click();
  } catch (error) {
    console.warn('reference image state skipped:', error.message.split('\n')[0]);
  }

  // Proposals (SPEC-09, PLAN-26 T-090), not implemented: injected into the real DOM after every
  // real screen is captured, so the real states above stay as they are. The board's right image
  // stands on the model view captured here; the left panel is folded as a user would.
  await tab('model');
  await page.waitForTimeout(700);
  const view = page.locator('#canvas canvas').first();
  const viewCapture = (await view.count())
    ? 'data:image/jpeg;base64,' +
      (await view.screenshot({ type: 'jpeg', quality: 70 })).toString('base64')
    : '';
  await page.locator('#toggle-left').click();
  await page.evaluate(injectProposal, proposalPayload('mask'));
  await capture('proposal-mask', '제안 · 마스킹 편집기');
  await page.evaluate(injectProposal, proposalPayload('board', viewCapture));
  await capture('proposal-board', '제안 · 이해 확인');

  const data = JSON.stringify(states).replace(/</g, '\\u003c');
  const html = `<title>VIDE 화면 미리보기</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
${styles}
:root { --font-sans: 'Inter', 'Noto Sans KR', 'Malgun Gothic', sans-serif; --font-mono: 'JetBrains Mono', ui-monospace, Consolas, monospace; }
#vide-preview-switch { position: fixed; right: 12px; bottom: 36px; z-index: 2147483647; display: flex; flex-wrap: wrap; gap: 4px; max-width: min(560px, calc(100vw - 24px)); padding: 6px; border-radius: 10px; background: #121212e6; color: #fff; font: 12px 'Inter', 'Noto Sans KR', sans-serif; box-shadow: 0 4px 16px #00000040; }
#vide-preview-switch b { width: 100%; font-weight: 600; padding: 0 4px 2px; opacity: .7; font-size: 11px; }
#vide-preview-switch button { all: unset; cursor: pointer; padding: 3px 8px; border-radius: 6px; }
#vide-preview-switch button[aria-pressed="true"] { background: #ffffff2e; font-weight: 600; }
#vide-preview-switch .hide { margin-left: auto; opacity: .7; }
</style>
<div id="vide-preview-root"></div>
<div id="vide-preview-switch" role="group" aria-label="화면 고르기"><b>VIDE 실제 화면 미리보기 · 예시 데이터 · ${new Date(now).toISOString().slice(0, 10)}</b></div>
<script>
(() => {
  const states = ${data};
  const root = document.getElementById('vide-preview-root');
  const bar = document.getElementById('vide-preview-switch');
  const show = (state) => {
    for (const [name, value] of state.html) if (name !== 'style') document.documentElement.setAttribute(name, value);
    if (!state.html.some(([n]) => n === 'data-theme')) document.documentElement.removeAttribute('data-theme');
    for (const a of [...document.body.attributes]) if (a.name !== 'style') document.body.removeAttribute(a.name);
    for (const [name, value] of state.body) document.body.setAttribute(name, value);
    root.innerHTML = state.content;
    bar.querySelectorAll('button[data-id]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === state.id)));
    try { localStorage.setItem('vide-preview-state', state.id); } catch {}
  };
  for (const state of states) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = state.id; b.textContent = state.label;
    b.onclick = () => show(state);
    bar.appendChild(b);
  }
  const hide = document.createElement('button');
  hide.type = 'button'; hide.className = 'hide'; hide.textContent = '접기';
  hide.onclick = () => { const on = hide.textContent === '접기'; bar.querySelectorAll('button[data-id]').forEach((b) => (b.hidden = on)); hide.textContent = on ? '화면' : '접기'; };
  bar.appendChild(hide);
  let first = states[0];
  try { first = states.find((s) => s.id === localStorage.getItem('vide-preview-state')) || first; } catch {}
  show(first);
})();
</script>
`;
  await writeFile(out, html);
  console.log(
    `preview: ${out} · ${states.length} screens · ${(html.length / 1024 / 1024).toFixed(2)} MB`,
  );
} finally {
  await browser.close();
  await app.close?.();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
process.exit(0);
