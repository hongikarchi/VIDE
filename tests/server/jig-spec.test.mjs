import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { draftsFor, makeRoutes, makeTurnResult } from '../../src/server/make-routes.ts';
import { closeJigRuntime, jigRoutes } from '../../src/server/jig-routes.ts';
import { skillCatalog } from '../../src/server/skill-catalog.ts';
import { loadJig } from '../../src/jigs/runtime/loader.ts';
import { EngineRunner, MemoryCache, executeSteps } from '../../src/jigs/runtime/runner.ts';
import { initialParams } from '../../src/jigs/runtime/params.ts';
import { parseSpecReadme, skillFieldsOf } from '../../src/jigs/spec-readme.ts';
import { briefReadme, emptyBrief } from '../../src/ui/make-brief.ts';

// PLAN-54 T-353: the 명세 (README.md) of a draft — saved from the start form, kept in step after a
// make turn (a person's sections kept), [명세 고치기], and the pin refused without it or when it
// differs (SPEC-07.2·07.14·07.16 0·4·7). Synthetic drafts only; no provider, no host.

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'vide-spec-'));
  const store = new Store(join(root, 'vide.sqlite'));
  const workspace = new Workspace(store);
  const project = store.createProject('명세 시험');
  const call = async (method, path, payload) => {
    let last;
    const request = Object.assign(Readable.from([]), { method, headers: {} });
    const handled = await makeRoutes(new URL(path, 'http://127.0.0.1'), request, {
      workspace,
      body: async () => payload ?? {},
      send: (status, data) => (last = { status, data }),
      dataDirectory: root,
    });
    return handled ? last : { status: 0 };
  };
  const jigs = async (path) => {
    let last;
    const request = Object.assign(Readable.from([]), { method: 'GET', headers: {} });
    await jigRoutes(new URL(path, 'http://127.0.0.1'), request, {
      workspace,
      body: async () => ({}),
      send: (status, data) => (last = { status, data }),
      dataDirectory: root,
    });
    return last;
  };
  t.after(() => {
    closeJigRuntime(workspace);
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return {
    root,
    workspace,
    project,
    call,
    jigs,
    base: `/api/v1/projects/${project.id}/jig-drafts`,
  };
}
const section = (text, mark) => parseSpecReadme(text).sections[mark]?.body ?? '';

test('[계획 받기] saves the form as the draft 명세; skill.md follows its ②', async (t) => {
  const { call, base } = setup(t);
  const brief = {
    ...emptyBrief(),
    purpose: '보를 격자로 놓는다',
    when: '보 배치를 빨리 볼 때',
    notWhen: '구조 계산서',
  };
  const created = await call('POST', base, {
    name: brief.purpose,
    from: 'blank',
    readme: briefReadme(brief, '2026-10-15'),
  });
  assert.equal(created.status, 201);
  const draft = created.data;
  const readme = readFileSync(join(draft.path, 'README.md'), 'utf8');
  assert.equal(parseSpecReadme(readme).complete, true);
  assert.equal(section(readme, '①'), '보를 격자로 놓는다');
  assert.equal(section(readme, '④'), '아직 적지 않음');
  assert.equal(draft.spec.purpose, '보를 격자로 놓는다');
  assert.equal(draft.spec.editedBy, 'vide');
  // The form's spec is not the blank jig: 명세와 다름 until the AI writes the jig from it.
  assert.equal(draft.spec.state, 'mismatch');
  assert.deepEqual(skillFieldsOf(draft.skill), {
    examples: ['보 배치를 빨리 볼 때'],
    words: [],
    notFor: ['구조 계산서'],
  });
  // Saving the form's spec is not writing: every file is as old as the draft.
  const made = Date.parse(draft.createdAt);
  assert.ok(draft.files.every((file) => Date.parse(file.updatedAt) <= made + 5000));
  // A spec over 64 KB is refused.
  await assert.rejects(
    call('POST', base, { name: 'big', from: 'blank', readme: 'x'.repeat(70 * 1024) }),
  );
});

test('the pin is refused without a 명세 (SPEC_MISSING) and while it differs (SPEC_MISMATCH)', async (t) => {
  const { call, base } = setup(t);
  const draft = (await call('POST', base, { name: 'no spec', from: 'blank' })).data;
  assert.equal(draft.spec, null);
  const missing = await call('POST', `${base}/${draft.id}/pin`, { confirm: true });
  assert.equal(missing.status, 409);
  assert.equal(missing.data.code, 'SPEC_MISSING');
  assert.deepEqual(
    missing.data.choices.map((c) => c.id),
    ['fix-spec'],
  );
  // [명세 고치기] writes one from jig.json: it matches, and the pin goes through.
  const fixed = await call('POST', `${base}/${draft.id}/spec/regenerate`);
  assert.equal(fixed.status, 200);
  assert.equal(fixed.data.draft.spec.state, 'ok');
  assert.deepEqual(fixed.data.kept, []);
  // The README's setting default changed by hand: 명세와 다름 refuses the pin with the differences.
  const file = join(draft.path, 'README.md');
  const readme = readFileSync(file, 'utf8');
  writeFileSync(file, readme.replace('| 개수 (`count`) | EA | 3 |', '| 개수 (`count`) | EA | 4 |'));
  const differs = await call('POST', `${base}/${draft.id}/pin`, { confirm: true });
  assert.equal(differs.status, 409);
  assert.equal(differs.data.code, 'SPEC_MISMATCH');
  assert.deepEqual(differs.data.differences, [
    { section: '④', item: '개수', field: 'default', spec: '4', jig: '3 EA' },
  ]);
  assert.deepEqual(
    differs.data.choices.map((c) => c.label),
    ['명세대로 다시 만들기', '명세 고치기'],
  );
  const view = (await call('GET', `${base}/${draft.id}`)).data;
  assert.equal(view.spec.state, 'mismatch');
  assert.equal(view.spec.editedBy, 'person');
  assert.ok(view.spec.personAt);
  writeFileSync(file, readme);
  const pinned = await call('POST', `${base}/${draft.id}/pin`, { confirm: true });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.data));
  // The installed copy carries the spec; the JIG list reads its ① and no 명세 없음 badge.
  assert.ok(existsSync(join(pinned.data.path, 'README.md')));
});

test('[명세 고치기] rewrites ③~⑦ from jig.json and keeps a section a person changed', async (t) => {
  const { call, base } = setup(t);
  const draft = (await call('POST', base, { name: 'grid spec', from: 'example-grid' })).data;
  assert.equal(draft.spec.state, 'ok');
  const file = join(draft.path, 'README.md');
  const before = readFileSync(file, 'utf8');
  // A person changes ④ in the folder (a default the jig does not have) and ⑧.
  const edited = before
    .replace(/\| 8 \|/, '| 9 |')
    .replace('## ⑧ 한계·가정\n', '## ⑧ 한계·가정\n\n- 사람이 적은 한계.\n');
  assert.notEqual(edited, before);
  writeFileSync(file, edited);
  const fixed = await call('POST', `${base}/${draft.id}/spec/regenerate`);
  assert.equal(fixed.status, 200);
  assert.deepEqual(fixed.data.kept, ['④']);
  const after = readFileSync(file, 'utf8');
  assert.equal(section(after, '④'), section(edited, '④'), "the person's ④ stays");
  assert.match(section(after, '⑧'), /사람이 적은 한계/, '⑧ is not rewritten');
  assert.match(section(after, '⑦'), /^1\. .+ — inputs-present/m, '⑦ follows jig.json');
  assert.match(section(after, '⑨'), /지금 jig에 맞춰 명세 고침\(사람이 고친 ④ 절은 그대로\)/);
  // ④ still differs: the pin stays refused until the person picks a way.
  assert.equal(fixed.data.draft.spec.state, 'mismatch');
});

test('a make turn keeps the sections a person changed and updates skill.md from ②', async (t) => {
  const { call, base, workspace, root, project } = setup(t);
  const draft = (await call('POST', base, { name: 'turn spec', from: 'example-grid' })).data;
  const drafts = draftsFor(workspace, root);
  const file = join(draft.path, 'README.md');
  const original = readFileSync(file, 'utf8');
  // Between turns a person rewrites ① in the folder.
  const personal = original.replace(
    section(original, '①'),
    '사람이 고친 목적: 격자 기둥과 보를 놓고 경간을 본다.',
  );
  writeFileSync(file, personal);
  // The turn starts: the person's ① is noted.
  assert.deepEqual(drafts.specTurnStart(project.id, draft.id), ['①']);
  // The AI puts ① back to what it was and adds a word to ② (판정 낱말) and one ⑨ row.
  // (⑨ of the example is a list: the turn adds one item.)
  const aiText =
    original.replace('### 판정 낱말\n', '### 판정 낱말\n\n- 새 낱말\n').trimEnd() +
    '\n- v0.1.1 · 2026-10-15 · 판정 낱말 추가\n';
  writeFileSync(file, aiText);
  const result = await makeTurnResult(project.id, { draftId: draft.id, drafts }, {}, {});
  assert.deepEqual(result.makeSpec, {
    changed: true,
    history: '판정 낱말 추가',
    restored: ['①'],
  });
  const after = readFileSync(file, 'utf8');
  assert.equal(section(after, '①'), '사람이 고친 목적: 격자 기둥과 보를 놓고 경간을 본다.');
  assert.match(section(after, '②'), /- 새 낱말/);
  const skill = readFileSync(join(draft.path, 'skill.md'), 'utf8');
  assert.ok(skillFieldsOf(skill).words.includes('새 낱말'));
  const view = (await call('GET', `${base}/${draft.id}`)).data;
  assert.equal(view.spec.editedBy, 'ai');
  assert.equal(view.spec.history, '판정 낱말 추가');
  // A turn that leaves the spec alone reports nothing.
  drafts.specTurnStart(project.id, draft.id);
  assert.equal(
    (await makeTurnResult(project.id, { draftId: draft.id, drafts }, {}, {})).makeSpec,
    undefined,
  );
});

test('a working copy warns 명세와 다름 on its first step; the catalog reads ② and ①', async (t) => {
  const { workspace, root, project, jigs } = setup(t);
  const dir = join(root, 'grid-copy');
  cpSync(new URL('../../extensions/jigs/example-grid', import.meta.url), dir, { recursive: true });
  const fine = await loadJig(dir, { source: 'dev-source' });
  assert.equal(fine.spec.state, 'ok');
  const file = join(dir, 'README.md');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(/^\| 기둥 금지 구역 \|/m, '| 금지 구역 |'),
  );
  const jig = await loadJig(dir, { source: 'dev-source' });
  assert.equal(jig.spec.state, 'mismatch');
  const report = await executeSteps({
    jig,
    runner: new EngineRunner(),
    cache: new MemoryCache(),
    mode: 'preview',
    inputs: {},
    params: initialParams(jig.manifest),
  });
  const gates = report.steps.flatMap((step) => step.gates ?? []);
  const warned = gates.filter((gate) => gate.name === 'spec-match');
  assert.equal(warned.length, 1, 'once, on the first step');
  assert.equal(warned[0].level, 'warn');
  assert.equal(warned[0].ok, false);
  assert.match(warned[0].message, /^명세와 다름: /);
  // Without a difference no spec-match row is added.
  const okReport = await executeSteps({
    jig: fine,
    runner: new EngineRunner(),
    cache: new MemoryCache(),
    mode: 'preview',
    inputs: {},
    params: initialParams(fine.manifest),
  });
  assert.ok(
    !okReport.steps.some((step) => (step.gates ?? []).some((g) => g.name === 'spec-match')),
  );

  // The JIG list: ① for the card, no 명세 없음 on the official jigs, the built-in specs listed.
  const listed = (await jigs('/api/v1/jigs/packages')).data;
  const summary = listed.jigs.find((entry) => entry.id === 'vide/building-summary');
  assert.equal(summary.specMissing, false);
  assert.match(summary.purpose, /^건축 가능 영역·매스 jig에서 사람이 확정한/);
  assert.deepEqual(Object.keys(listed.builtin).sort(), ['knowledge', 'structure', 'sync']);
  assert.ok(Object.values(listed.builtin).every((entry) => entry.specMissing === false));
  // The skill catalog: an official jig's examples come from its ② (skill.md has none of its own).
  const catalog = await skillCatalog(workspace, root, project.id);
  const mass = catalog.find((entry) => entry.id === 'vide/buildable-mass');
  assert.deepEqual(mass.examples, ['이 대지 건축 가능 영역 보여 줘', '일조 사선 외피 만들어 줘']);
  const sync = catalog.find((entry) => entry.id === 'sync');
  assert.ok(sync.examples.length && sync.notFor.length);
  assert.ok(sync.words.includes('정합 검토'));
});
