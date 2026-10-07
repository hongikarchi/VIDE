// 도면 반영 jig on the real engine with the real ZWCAD 2023 (PLAN-47 T-234 검수 계획, SPEC-14,
// Design SCR-31). Not part of a suite: run by hand after `npm run build:web` (skipped when ZWCAD 2023
// or the built worker is missing). Hidden ZWCADs this test starts write SYNTHETIC drawings
// (VIDEBACKFLOWFIXTURE: a 2018 root with a line, an arc-segment polyline, an arc, a circle, a block
// insert, a hand dimension and a 2013 xref child) under .vide/. Everything after that goes through
// the engine's routes and the screen in a headless browser; only the Rhino side is a stand-in: the
// source snapshot (the reader's `source`) and the two calls the screen makes for it (`…/links`,
// `…/jigs/sync`, an identity relation). The drawing reads, layer table, pairs, rows, save card,
// [저장], xref read and the sheet search are the engine's, with hidden ZWCADs.
//  1. [도면 읽기] → [짝 기록] → the model moves a line, enlarges an arc, deletes a circle, adds an arc
//     on a paired layer and a circle on a layer the drawing lacks ('레이어 지정 필요' → the table maps
//     it), and changes an arc of the xref child → rows → the delete chosen by hand → [반영] → the save
//     card (nothing written yet) → [저장] → a new root (2018) and a new child (2013) beside the
//     originals; handles, layers and DWG versions kept, the hand dimension listed, originals unchanged.
//  2. A hand edit of the root (the arc changed, the polyline deleted) → 충돌 and 끊김; [모델로 덮기] →
//     the card → [취소] writes nothing.
//  3. With VIDE_BACKFLOW_COPIES=<a folder under .vide/ of drawing copies>: through the routes, for each
//     mm root up to 100 supported model entities are paired, moved 10 mm in the model and applied
//     (rows refused by the drawing, e.g. on locked layers, are left out and the rest applied), new
//     files written beside the copies; counts and times only (no names). The copies' hashes stay.
// Only the processes started here are stopped; the user's own ZWCAD is never touched.
// Run: npm run build:web && node tests/integration/zwcad-drawing-backflow-screen.mjs
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { inspectorOptions } from '../../hosts/zwcad/inspector.ts';
import { applyDrawingCopies, writeBackflowFixture } from '../../hosts/zwcad/drawing-backflow.ts';
import { zwcadCrashDumps } from '../../hosts/zwcad/hidden-run.ts';
import { OutputTokens, dwgVersionOf } from '../../src/core/drawing-output.ts';
import { ZwcadBackflowHost } from '../../src/server/drawing-backflow-host.ts';
import { startServer } from '../../src/server/server.ts';
import { runDirectory } from './run-directory.mjs';

const options = inspectorOptions();
try {
  await Promise.all([access(options.executable), access(options.plugin)]);
} catch {
  console.log(JSON.stringify({ skipped: 'ZWCAD 2023 or the built worker is not available' }));
  process.exit(0);
}
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const run = runDirectory('zwcad-drawing-backflow-screen');
const fixtures = join(run, 'fixtures'),
  work = join(run, 'work');
await mkdir(fixtures, { recursive: true });
await mkdir(work, { recursive: true });
const dumps = new Set(await zwcadCrashDumps());
const timings = {};
let at = Date.now();
await writeBackflowFixture(fixtures, options);
timings.fixtureMs = Date.now() - at;
const root = join(fixtures, 'root.dwg'),
  child = join(fixtures, 'child.dwg');
const originals = { root: await hash(root), child: await hash(child) };

const host = new ZwcadBackflowHost({
  attached: undefined,
  workspace: { list: () => [], lazy: () => ({}) },
  workRoot: join(work, 'host'),
  options,
});
// The Rhino side: a snapshot in metres that the test changes between steps.
let source = { linkId: 'L1', revision: 'r1', objects: [] };
const reader = {
  available: () => host.available(),
  source: async () => source,
  drawings: (projectId, paths) => host.drawings(projectId, paths),
  fingerprints: (projectId, paths) => host.fingerprints(projectId, paths),
};
const P = (x, y) => [x, y, 0];
const m = (p) => [p[0] / 1000, p[1] / 1000, p[2] / 1000];
const metres = (g, dx = 0) => {
  const at = (p) => m([p[0] + dx, p[1], p[2]]);
  switch (g.kind) {
    case 'line':
    case 'polyline':
      return { ...g, points: g.points.map(at) };
    case 'insert':
      return { ...g, position: at(g.position) };
    default:
      return { ...g, center: at(g.center), radius: g.radius / 1000 };
  }
};

let app, browser;
try {
  app = await startServer({
    filename: join(run, 'data', 'test.sqlite'),
    backflowReader: reader,
    backflowWriter: host,
  });
  const origin = new URL(app.launchUrl).origin;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (
    await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  ).newPage();
  page.setDefaultTimeout(120_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  const call = (path, method = 'GET', body) =>
    page.evaluate(
      async ({ url, method, body }) => {
        const response = await fetch(url, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: response.status, json: await response.json() };
      },
      { url: `${origin}/api/v1/projects/${projectId}${path}`, method, body },
    );
  const until = async (path, done) => {
    for (let i = 0; i < 600; i++) {
      const value = (await call(path)).json;
      if (done(value)) return value;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('TIMEOUT ' + path);
  };
  // The project folder and 도면 관계 (the xref graph the rows use for the child).
  assert.equal((await call('/folders', 'POST', { path: fixtures })).status < 300, true);
  at = Date.now();
  await call('/xref/read', 'POST', {});
  await until('/xref', (s) => s.state !== 'reading');
  timings.xrefReadMs = Date.now() - at;

  // The drawings as the engine reads them (handles of the entities paired below).
  const reads = await host.drawings(projectId, [root, child]);
  const r = reads.get(root),
    c = reads.get(child);
  const of = (read, kind, layer) =>
    read.entities.find((e) => e.geometry?.kind === kind && (!layer || e.layer === layer));
  const line = of(r, 'line', '벽'),
    bent = of(r, 'polyline', '벽'),
    arc = of(r, 'arc', '벽'),
    circle = of(r, 'circle', '가구'),
    chair = of(r, 'insert', '가구'),
    childArc = of(c, 'arc');
  for (const e of [line, bent, arc, circle, chair, childArc]) assert.ok(e, 'fixture entity');
  // The child is attached at (10000, 0): its arc in root coordinates.
  const childInRoot = {
    ...childArc.geometry,
    center: P(childArc.geometry.center[0] + 10000, childArc.geometry.center[1]),
  };
  const object = (id, layer, g) => ({ id, layer, type: 'Curve', geometry: g });
  source = {
    linkId: 'L1',
    revision: 'r1',
    objects: [
      object('a', '벽', metres(line.geometry)),
      object('b', '벽', metres(bent.geometry)),
      object('c', '벽', metres(arc.geometry)),
      object('d', '가구', metres(circle.geometry)),
      object('e', 'Rhino::가구장', metres(chair.geometry)),
      object('h', '코어', metres(childInRoot)),
    ],
  };
  // The child's pair is recorded through the route (the Sync jig pairs only the root's entities).
  assert.equal(
    (
      await call('/drawing/backflow/pairs', 'POST', {
        root,
        link: 'L1',
        pairs: [{ sourceId: 'h', path: child, handle: childArc.handle }],
      })
    ).status,
    409,
    'the root must be read first',
  );

  // The screen: the Rhino link and its Sync jig relation are stand-ins.
  await page.route('**/api/v1/projects/*/links', (route) =>
    route.fulfill({
      json: [
        {
          id: 'link-cad',
          host: 'zwcad',
          name: 'root.dwg',
          path: root,
          kind: 'host',
          connection: null,
          lastSync: { requestId: 'sync-cad', at: '2026-10-08T00:00:00.000Z' },
          display: null,
        },
        {
          id: 'L1',
          host: 'rhino',
          name: 'model.3dm',
          path: null,
          kind: 'host',
          connection: null,
          lastSync: { requestId: 'sync-rhino', at: '2026-10-08T00:00:00.000Z' },
          display: null,
        },
      ],
    }),
  );
  const match = (id, entity) => ({
    id: 'R' + id,
    state: 'match',
    rhino: { id, nativeId: id },
    cad: { id: entity.handle, nativeId: entity.handle },
  });
  await page.route('**/api/v1/projects/*/jigs/sync', (route) =>
    route.fulfill({
      json: {
        alignment: {
          rotation: 0,
          translation: [0, 0],
          dz: 0,
          pairs: 5,
          residual: { max: 0, rms: 0 },
          ambiguous: false,
        },
        rows: [
          match('a', line),
          match('b', bent),
          match('c', arc),
          match('d', circle),
          match('e', chair),
        ],
      },
    }),
  );
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'JIG', exact: true })
    .locator('.jig-card', { hasText: '도면 반영' })
    .getByRole('button', { name: '열기' })
    .click();
  const jig = page.locator('.drawing-jig');
  // [도면 읽기]: T-227 with a hidden ZWCAD.
  at = Date.now();
  await jig.getByRole('button', { name: '도면 읽기' }).click();
  await jig.getByText('DWG 2018 · mm').waitFor();
  timings.layersReadMs = Date.now() - at;
  // [짝 기록]: the Sync jig's matched rows become the baseline; the child's through the route.
  await jig.getByRole('button', { name: '짝 기록' }).click();
  await jig.getByText(/반영 기준 5짝/).waitFor();
  assert.equal(
    (
      await call('/drawing/backflow/pairs', 'POST', {
        root,
        link: 'L1',
        pairs: [{ sourceId: 'h', path: child, handle: childArc.handle }],
      })
    ).status,
    200,
  );

  // 1. The model changes.
  const changed = (id, g) => ({ ...source.objects.find((o) => o.id === id), geometry: g });
  source = {
    linkId: 'L1',
    revision: 'r2',
    objects: [
      changed('a', { kind: 'line', points: [P(0, 0), P(4.25, 0)] }),
      source.objects.find((o) => o.id === 'b'),
      changed('c', { ...metres(arc.geometry), radius: arc.geometry.radius / 1000 + 0.2 }),
      source.objects.find((o) => o.id === 'e'),
      changed('h', { ...metres(childInRoot), radius: childArc.geometry.radius / 1000 + 0.05 }),
      object('x', '벽', { kind: 'arc', center: P(0, 6), radius: 0.3, start: 0, end: Math.PI / 2 }),
      object('y', 'Rhino::가구장', { kind: 'circle', center: P(2, 6), radius: 0.4 }),
    ],
  };
  at = Date.now();
  await jig.getByRole('button', { name: '차이 계산' }).click();
  const list = jig.getByRole('list', { name: '행 목록' });
  await list.locator('> li').first().waitFor();
  timings.diffMs = Date.now() - at;
  const rowsNow = async () =>
    (await call('/drawing/backflow?path=' + encodeURIComponent(root))).json;
  void rowsNow;
  const kinds = async () =>
    list
      .locator('.bf-kind')
      .allTextContents()
      .then((t) => t.sort());
  assert.deepEqual(await kinds(), ['삭제', '수정', '수정', '수정', '추가', '추가'].sort());
  await list.getByText('레이어 지정 필요').waitFor();
  await list.locator('.bf-tag', { hasText: 'xref' }).waitFor();
  // '레이어 지정 필요': the table maps the source layer to a layer the drawing has.
  await jig.getByRole('combobox', { name: 'Rhino::가구장 도면 레이어' }).selectOption('가구');
  await jig.locator('details.bf-layers').getByRole('button', { name: '표 저장' }).click();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('.bf-rows .bf-layer')].some((e) =>
        e.textContent.includes('레이어 지정 필요'),
      ),
  );
  // The delete waits for a hand choice.
  const deleteBox = list.locator('li', { has: page.locator('.bf-kind[data-kind="delete"]') });
  assert.equal(await deleteBox.getByRole('checkbox').isChecked(), false);
  await deleteBox.getByRole('checkbox').check();
  await jig.getByText('선택 6행 · 파일 2개').waitFor();
  at = Date.now();
  await jig.getByRole('button', { name: '반영', exact: true }).click();
  const card = jig.getByRole('dialog', { name: '저장 확인' });
  await card.getByText('새 파일로 저장할까요?').waitFor();
  timings.computeMs = Date.now() - at;
  const before = (await readdir(fixtures)).sort();
  assert.ok(!before.some((n) => n.includes('VIDE반영')), 'nothing beside the drawings yet');
  await card.getByText('DWG 2018').waitFor();
  await card.getByText('DWG 2013').waitFor();
  at = Date.now();
  await card.getByRole('button', { name: '저장' }).click();
  const result = jig.getByLabel('반영 결과');
  await result.getByText('새 파일을 썼습니다').waitFor();
  timings.saveMs = Date.now() - at;
  await page.screenshot({ path: join(run, 'result.png'), fullPage: true });
  if (process.env.VIDE_DEBUG_SCREEN) console.error(await result.innerText());
  assert.equal(await result.getByText('형식 보존 확인 — 차이 없음').count(), 2);
  await result.getByText('치수 확인 필요 1').waitFor();
  await page.screenshot({ path: join(run, 'result.png') });
  const written = (await readdir(fixtures)).filter((n) => n.includes('VIDE반영'));
  assert.equal(written.length, 2);
  const newRoot = join(
    fixtures,
    written.find((n) => n.startsWith('root')),
  );
  const newChild = join(
    fixtures,
    written.find((n) => n.startsWith('child')),
  );
  assert.equal(await dwgVersionOf(newRoot), 'AC1032');
  assert.equal(await dwgVersionOf(newChild), 'AC1027');
  assert.equal(await hash(root), originals.root, 'the original root is never written');
  assert.equal(await hash(child), originals.child, 'the original child is never written');
  const after = await host.drawings(projectId, [newRoot, newChild]);
  const nr = after.get(newRoot);
  const kept = (e) => nr.entities.find((x) => x.handle === e.handle);
  assert.deepEqual(kept(line).geometry.points[1], [4250, 0, 0]);
  assert.equal(kept(line).layer, '벽');
  assert.deepEqual(kept(line).props, line.props);
  assert.equal(kept(arc).geometry.radius, arc.geometry.radius + 200);
  assert.equal(kept(circle), undefined, 'the chosen delete');
  assert.ok(nr.entities.some((e) => e.origin?.id === 'L1:y' && e.layer === '가구'));
  assert.ok(nr.entities.some((e) => e.origin?.id === 'L1:x' && e.layer === '벽'));
  const nc = after.get(newChild).entities.find((e) => e.handle === childArc.handle);
  assert.equal(nc.geometry.radius, childArc.geometry.radius + 50);
  const scenario1 = {
    rows: 6,
    files: 2,
    versions: ['AC1032', 'AC1027'],
    preserved: 2,
    dimensionsToCheck: 1,
  };

  // 2. A hand edit of the root (synthetic file): the arc changed, the polyline deleted.
  const edit = join(work, 'edit');
  await mkdir(join(edit, 'src'), { recursive: true });
  await copyFile(root, join(edit, 'src', 'root.dwg'));
  const tokens = new OutputTokens({ workRoot: edit });
  const token = tokens.issue({ folder: edit, names: ['edited.dwg'], version: 'AC1032' });
  await applyDrawingCopies({
    tokens,
    token: token.id,
    jobs: [
      {
        id: 'hand',
        source: join(edit, 'src', 'root.dwg'),
        target: join(edit, 'edited.dwg'),
        ops: [
          {
            id: 'H1',
            op: 'modify',
            handle: arc.handle,
            geometry: { ...arc.geometry, radius: 900 },
            origin: 'hand:1',
          },
          { id: 'H2', op: 'delete', handle: bent.handle },
        ],
        revision: 1,
      },
    ],
    work: edit,
    options,
  });
  await copyFile(join(edit, 'edited.dwg'), root);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'JIG', exact: true })
    .locator('.jig-card', { hasText: '도면 반영' })
    .getByRole('button', { name: '열기' })
    .click();
  await jig.getByRole('button', { name: '도면 읽기' }).click();
  await jig.getByText('DWG 2018 · mm').waitFor();
  await jig.getByRole('button', { name: '차이 계산' }).click();
  await list.locator('> li').first().waitFor();
  const conflict = list.locator('li', { has: page.locator('.bf-kind[data-kind="conflict"]') });
  await conflict.getByText('모델과 도면이 둘 다 바뀜').waitFor();
  await list.getByText('도면에서 지워짐').waitFor();
  assert.equal(await conflict.getByRole('checkbox').isDisabled(), true);
  await conflict.getByRole('button', { name: '모델로 덮기' }).click();
  await list.getByText('충돌 → 모델로 덮음').waitFor();
  const files = (await readdir(fixtures)).sort();
  await jig.getByRole('button', { name: '반영', exact: true }).click();
  await card.getByText('새 파일로 저장할까요?').waitFor();
  await card.getByRole('button', { name: '취소' }).click();
  await jig.getByText('저장하지 않았습니다. 쓴 파일이 없습니다.').waitFor();
  assert.deepEqual((await readdir(fixtures)).sort(), files, '[취소] writes nothing');
  const scenario2 = { conflict: 1, broken: 1, cancelledWrites: 0 };

  // 3. Copies of real drawings (counts only).
  let copies = null;
  const folder = process.env.VIDE_BACKFLOW_COPIES && resolve(process.env.VIDE_BACKFLOW_COPIES);
  if (folder && folder.includes(resolve('.vide'))) {
    const all = [];
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true }))
        if (entry.isDirectory()) await walk(join(dir, entry.name));
        else if (/\.dwg$/i.test(entry.name) && !entry.name.includes('VIDE반영'))
          all.push(join(dir, entry.name));
    };
    await walk(folder);
    const hashes = await Promise.all(all.map(hash));
    copies = {
      drawings: all.length,
      roots: 0,
      rowsComputed: 0,
      modifyRows: 0,
      otherRows: 0,
      refusedRows: {},
      applied: 0,
      files: 0,
      preserved: 0,
      versionKept: 0,
      dimensionsToCheck: 0,
      failed: {},
      times: [],
    };
    assert.ok((await call('/folders', 'POST', { path: folder })).status < 300);
    at = Date.now();
    await call('/xref/read', 'POST', {});
    const xref = await until('/xref', (s) => s.state !== 'reading');
    copies.xrefReadMs = Date.now() - at;
    const roots = xref.roots
      .filter(
        (n) => !n.error && !n.outside && all.some((p) => p.toLowerCase() === n.path.toLowerCase()),
      )
      .map((n) => n.path);
    at = Date.now();
    await call('/drawing/layers/read', 'POST', { paths: roots });
    const layers = await until('/drawing/layers', (s) => s.state !== 'reading');
    copies.layersReadMs = Date.now() - at;
    for (const [index, path] of roots.entries()) {
      const summary = layers.drawings.find((d) => d.path.toLowerCase() === path.toLowerCase());
      if (!summary?.eligible) {
        copies.failed[summary?.reason ?? 'NOT_READ'] =
          (copies.failed[summary?.reason ?? 'NOT_READ'] ?? 0) + 1;
        continue;
      }
      copies.roots++;
      const read = (await host.drawings(projectId, [path])).get(path);
      const supported = read.entities.filter(
        (e) => e.geometry && !e.dynamic && !e.xref && e.owner === 'model',
      );
      const step = Math.max(1, Math.ceil(supported.length / 100));
      const chosen = supported.filter((_, i) => i % step === 0).slice(0, 100);
      if (!chosen.length) continue;
      const link = 'C' + index;
      source = {
        linkId: link,
        revision: 'c1',
        objects: chosen.map((e) => object('h' + e.handle, e.layer, metres(e.geometry))),
      };
      const paired = await call('/drawing/backflow/pairs', 'POST', {
        root: path,
        link,
        pairs: chosen.map((e) => ({ sourceId: 'h' + e.handle, path, handle: e.handle })),
      });
      if (paired.status !== 200) {
        copies.failed[paired.json.code] = (copies.failed[paired.json.code] ?? 0) + 1;
        continue;
      }
      source = {
        linkId: link,
        revision: 'c2',
        objects: chosen.map((e) => object('h' + e.handle, e.layer, metres(e.geometry, 10))),
      };
      const time = { rows: 0 };
      let t = Date.now();
      const diff = (
        await call('/drawing/backflow', 'POST', {
          root: path,
          link,
          relation: { rotation: 0, translation: [0, 0], dz: 0 },
        })
      ).json;
      time.diffMs = Date.now() - t;
      if (!diff.rows) {
        copies.failed[diff.code] = (copies.failed[diff.code] ?? 0) + 1;
        continue;
      }
      copies.rowsComputed += diff.rows.length;
      copies.modifyRows += diff.rows.filter((row) => row.kind === 'modify').length;
      copies.otherRows += diff.rows.filter((row) => row.kind !== 'modify').length;
      let rows = diff.rows
        .filter((row) => row.selectable && row.kind === 'modify')
        .map((row) => row.id);
      let answer;
      t = Date.now();
      for (let attempt = 0; attempt < 3 && rows.length; attempt++) {
        answer = (await call('/drawing/backflow/apply', 'POST', { diff: diff.id, rows })).json;
        if (answer.state !== 'failed' || answer.code !== 'OP_REFUSED') break;
        const refused = new Set(answer.failed.map((f) => f.id));
        for (const f of answer.failed)
          copies.refusedRows[f.code] = (copies.refusedRows[f.code] ?? 0) + 1;
        rows = rows.filter((id) => !refused.has(id));
      }
      time.computeMs = Date.now() - t;
      time.rows = rows.length;
      if (answer?.state !== 'confirm') {
        const code = answer?.code ?? answer?.state ?? 'NO_ROWS';
        copies.failed[code] = (copies.failed[code] ?? 0) + 1;
        continue;
      }
      t = Date.now();
      const saved = (await call(`/drawing/backflow/apply/${answer.id}/confirm`, 'POST', {})).json;
      time.saveMs = Date.now() - t;
      copies.times.push(time);
      if (saved.state !== 'applied') {
        copies.failed[saved.code ?? saved.state] =
          (copies.failed[saved.code ?? saved.state] ?? 0) + 1;
        continue;
      }
      copies.applied++;
      for (const file of saved.files) {
        copies.files++;
        if (file.check?.ok) copies.preserved++;
        if (
          file.check?.version.same &&
          (await dwgVersionOf(file.written)) === file.check.version.before
        )
          copies.versionKept++;
        copies.dimensionsToCheck += file.dimensions.length;
      }
    }
    const now = await Promise.all(all.map(hash));
    copies.copiesUnchanged = now.every((h, i) => h === hashes[i]);
    assert.equal(copies.copiesUnchanged, true, 'the copies are never written');
  }

  assert.deepEqual(errors, []);
  const newDumps = (await zwcadCrashDumps()).filter((name) => !dumps.has(name));
  assert.deepEqual(newDumps, [], 'no ZWCAD crash report');
  console.log(JSON.stringify({ ok: true, scenario1, scenario2, copies, timings }, null, 1));
} finally {
  await browser?.close();
  await app?.close();
}
