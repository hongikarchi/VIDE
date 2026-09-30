import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../src/server/server.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';

// The engine's /route (SPEC-02.17, PLAN-24 T-049): the server builds the jig and link lists itself,
// so Jev sees role labels and jig intents but never a file name or path; the FR-18 switch turns
// every Jev call off; words decided without Jev need no call.
test('/route sends only the fixed items, honours the switch and decides rule words without Jev', async () => {
  const original = globalThis.fetch;
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  const sent = [];
  let answers = {};
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.typesafe.ai/')) {
      sent.push(init.body);
      return Response.json({ answers });
    }
    return original(url, init);
  };
  const app = await startServer({ filename: ':memory:', host: { status: async () => ({}) } });
  try {
    const login = await original(app.origin + '/api/v1/session', {
      method: 'POST',
      headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
    });
    const headers = {
      Origin: app.origin,
      'Content-Type': 'application/json',
      Cookie: login.headers.get('set-cookie').split(';')[0],
    };
    const api = async (path, method = 'GET', data) => {
      const response = await original(app.origin + '/api/v1' + path, {
        method,
        headers,
        body: data ? JSON.stringify(data) : undefined,
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    };
    const project = (await api('/projects', 'POST', { name: 'route' })).json;
    const links = new DocumentLinks(app.store.db);
    links.link(project.id, {
      host: 'zwcad',
      name: 'S06-plan.dwg',
      path: 'C:\\work\\S06\\S06-plan.dwg',
      instance: '1:1',
      documentId: 1,
    });
    links.link(project.id, {
      host: 'rhino',
      name: 'S06-frame.3dm',
      path: 'C:\\work\\S06\\S06-frame.3dm',
      instance: '2:1',
      documentId: 2,
    });
    const route = (data) => api(`/projects/${project.id}/route`, 'POST', data);
    answers = {
      target: { choice: 'view', confidence: 0.95 },
      action: { choice: 'hide', confidence: 0.9 },
      subject: { choice: 's0', confidence: 0.9 },
    };
    const view = await route({
      body: 'A-HATCH 꺼줘',
      subjects: [{ id: 'layer:A-HATCH', label: 'layer "S06-plan.dwg|A-HATCH", 3 objects' }],
      params: [{ key: 'spanMax', title: '경간 상한', help: '거더 경간의 상한' }],
    });
    assert.equal(view.status, 200);
    assert.deepEqual(
      [view.json.target, view.json.by, view.json.action, view.json.subject, view.json.ai],
      ['view', 'jev', 'hide', 'layer:A-HATCH', false],
    );
    assert.equal(sent.length, 1);
    const payload = sent[0];
    // Role labels and jig intents go; names, paths and folders do not.
    for (const item of ['CAD 1', 'Rhino 모델 1', 'Steel frame structural check', '경간 상한'])
      assert.ok(payload.includes(item), item);
    for (const secret of ['S06-plan', 'S06-frame', 'work\\\\', 'C:'])
      assert.ok(!payload.includes(secret), secret);
    // The screen cannot add other items: links and jigs come only from the server.
    const injected = await route({
      body: '숨겨',
      subjects: [],
      links: [{ id: 'x', label: 'C:\\secret\\a.dwg' }],
    });
    assert.ok(injected.status >= 400);
    // Words decided without Jev: no call, no model choice. The project's skill catalog comes
    // first (ADR-026 6): in this checkout the S-06 frame jig takes "구조 검토" before the
    // official structure screen, which stays in the catalog as the fallback.
    const jig = await route({ body: '구조 검토하고 싶어', subjects: [] });
    assert.deepEqual(
      [jig.json.target, jig.json.by, jig.json.jig, jig.json.jigName, jig.json.ai],
      ['jig', 'rules', 'project/s06-frame', 'S-06 골조 배치', false],
    );
    const skills = (await api(`/projects/${project.id}/skills`)).json.skills;
    const ids = skills.map((skill) => skill.id);
    assert.ok(ids.indexOf('project/s06-frame') < ids.indexOf('structure'));
    const s06 = skills.find((skill) => skill.id === 'project/s06-frame');
    assert.deepEqual(
      [s06.kind, s06.invocation, s06.autorun.step],
      ['instance', 'auto', 'confirmAnalysis'],
    );
    assert.ok(s06.examples.includes('구조 분석 해줘'));
    // The open jig's own words change its setting instead of reopening it.
    const own = await route({
      body: '경간 11로',
      subjects: [],
      params: [{ key: 'spanMax', title: '경간 상한' }],
      openJig: 'project/s06-frame',
    });
    assert.deepEqual([own.json.target, own.json.param], ['param', 'spanMax']);
    const account = await route({ body: 'codex 로그인해줘', subjects: [] });
    assert.deepEqual([account.json.app, account.json.provider], ['login', 'codex-cli']);
    assert.equal(sent.length, 1);
    // FR-18: the notice's switch. Off: rules only, no Jev call at all.
    assert.deepEqual((await api('/settings/routing')).json, { jev: true, key: true });
    assert.deepEqual((await api('/settings/routing', 'PUT', { jev: false })).json, {
      jev: false,
      key: true,
    });
    assert.deepEqual((await route({ body: 'A-HATCH 꺼줘', subjects: [] })).json, {
      target: null,
    });
    assert.equal(sent.length, 1);
    assert.equal((await api('/settings/routing', 'PUT', { jev: 'yes' })).status >= 400, true);
    await api('/settings/routing', 'PUT', { jev: true });
    await route({ body: 'A-HATCH 꺼줘', subjects: [] });
    assert.equal(sent.length, 2);
    // 'AI 작업으로 보내기' is counted (diagnostics only).
    const revert = await api(`/projects/${project.id}/route/revert`, 'POST', {
      target: 'view',
      by: 'jev',
    });
    assert.deepEqual([revert.status, revert.json], [200, { ok: true }]);
  } finally {
    await app.close();
    globalThis.fetch = original;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  }
});
