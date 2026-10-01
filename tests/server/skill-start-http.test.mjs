import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../src/server/server.ts';

// The engine side of startSkill (RESEARCH-12 §6.3, ADR-026 4): an instance opened without an
// output layer (asked at Rhino에 만들기), binding a conversation to it, and a Claude turn's own
// questions answered on the question cards while the same run waits. Synthetic data only.
async function session(options = {}) {
  const app = await startServer({
    filename: ':memory:',
    host: { status: async () => ({ available: true }) },
    ...options,
  });
  const login = await fetch(app.origin + '/api/v1/session', {
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
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  return { app, api };
}

test('a request-opened instance has no output layer until Rhino에 만들기 asks; conversations bind to it', async () => {
  const { app, api } = await session();
  try {
    const project = (await api('/projects', 'POST', { name: 'skill' })).json;
    const base = `/projects/${project.id}`;
    const made = await api(`${base}/jig-instances`, 'POST', {
      jig: 'project/example-grid',
      title: '작업본 1',
      layerRootLater: true,
    });
    assert.equal(made.status, 200);
    assert.equal(made.json.body.layerRoot, '');
    // One of the two: a layer or the explicit "later".
    assert.equal(
      (await api(`${base}/jig-instances`, 'POST', { jig: 'project/example-grid', title: 'x' }))
        .status,
      400,
    );
    const instance = made.json.id;
    // Rhino에 만들기 stops first and asks for the layer.
    const bake = await api(`${base}/jig-instances/${instance}/bake`, 'POST', { bake: ['beams'] });
    assert.deepEqual([bake.status, bake.json.code], [422, 'LAYER_ROOT_MISSING']);
    const set = await api(`${base}/jig-instances/${instance}/layer-root`, 'PUT', {
      layerRoot: 'VIDE::격자',
    });
    assert.deepEqual([set.status, set.json.body.layerRoot], [200, 'VIDE::격자']);
    // A set output layer never changes (SPEC-07.4).
    assert.equal(
      (await api(`${base}/jig-instances/${instance}/layer-root`, 'PUT', { layerRoot: 'B' })).status,
      400,
    );

    const conversation = (
      await api(`${base}/conversations`, 'POST', {
        kind: 'jig-run',
        title: '격자',
        provider: 'claude-cli',
        model: 'claude-opus-5-5',
      })
    ).json;
    const bound = await api(`${base}/conversations/${conversation.id}/bind`, 'POST', {
      jigInstanceId: instance,
    });
    assert.deepEqual([bound.status, bound.json.jigInstanceId], [200, instance]);
    // Binding again to the same instance is fine; to another one is refused.
    assert.equal(
      (
        await api(`${base}/conversations/${conversation.id}/bind`, 'POST', {
          jigInstanceId: instance,
        })
      ).status,
      200,
    );
    const other = (
      await api(`${base}/jig-instances`, 'POST', {
        jig: 'project/example-grid',
        title: '작업본 2',
        layerRootLater: true,
      })
    ).json;
    const refused = await api(`${base}/conversations/${conversation.id}/bind`, 'POST', {
      jigInstanceId: other.id,
    });
    assert.deepEqual([refused.status, refused.json.code], [409, 'CONVERSATION_BOUND']);
    // [일반 대화로] unbinds only from the instance it bound; then the turns are ordinary again.
    const wrong = await api(`${base}/conversations/${conversation.id}/unbind`, 'POST', {
      jigInstanceId: other.id,
    });
    assert.deepEqual([wrong.status, wrong.json.code], [409, 'CONVERSATION_BOUND']);
    const unbound = await api(`${base}/conversations/${conversation.id}/unbind`, 'POST', {
      jigInstanceId: instance,
    });
    assert.deepEqual([unbound.status, unbound.json.jigInstanceId], [200, null]);
    assert.equal(
      (await api(`${base}/conversations`)).json.find((row) => row.id === conversation.id)
        .jigInstanceId,
      null,
    );
    // Unbound already: nothing to undo.
    assert.equal(
      (
        await api(`${base}/conversations/${conversation.id}/unbind`, 'POST', {
          jigInstanceId: instance,
        })
      ).status,
      200,
    );
    // It can take a jig again afterwards.
    assert.equal(
      (
        await api(`${base}/conversations/${conversation.id}/bind`, 'POST', {
          jigInstanceId: other.id,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await api(`${base}/conversations/${conversation.id}/bind`, 'POST', {
          jigInstanceId: 'nope',
        })
      ).status,
      404,
    );
    // The skill catalog lists the checkout's jigs before the official screens.
    const skills = (await api(`${base}/skills`)).json.skills;
    assert.equal(skills.at(-1).scope, 'official');
    assert.ok(
      skills.some((skill) => skill.id === 'project/example-grid' && skill.scope === 'project'),
    );
  } finally {
    await app.close();
  }
});

test("a Claude turn's own questions (AskUserQuestion) wait on the cards and go on in the same run", async () => {
  const previous = process.env.VIDE_NATIVE_QUESTIONS;
  process.env.VIDE_NATIVE_QUESTIONS = '1';
  const seen = [];
  const { app, api } = await session({
    providerFactory: (options) => ({
      run: async (_context, { signal }) => {
        assert.equal(typeof options.nativeQuestions, 'function');
        const answers = await options.nativeQuestions(
          [
            {
              id: 'q1',
              title: '슬래브는 S-SLAB-3F 레이어인가요?',
              options: [
                { id: 'o1', label: '맞음' },
                { id: 'o2', label: '다른 레이어' },
              ],
              allowFree: true,
            },
          ],
          signal,
        );
        seen.push(answers);
        return { text: JSON.stringify({ message: '답을 반영했습니다', operations: [] }) };
      },
    }),
  });
  try {
    const project = (await api('/projects', 'POST', { name: 'questions' })).json;
    const base = `/projects/${project.id}`;
    const conversation = (
      await api(`${base}/conversations`, 'POST', {
        kind: 'jig-run',
        title: '구조',
        provider: 'claude-cli',
        model: 'claude-opus-5-5',
      })
    ).json;
    const sent = await api(`${base}/requests`, 'POST', {
      id: 'turn-q',
      body: '구조 분석 해줘',
      provider: 'claude-cli',
      model: 'claude-opus-5-5',
      permission: 'candidate',
      mode: 'auto',
      pins: [],
      sketches: [],
      files: [],
      conversationId: conversation.id,
      hostUse: 'none',
    });
    assert.ok(sent.status < 300, JSON.stringify(sent.json));
    let waiting;
    for (let i = 0; i < 200 && !waiting; i++) {
      const row = (await api(`${base}/requests/turn-q`)).json;
      if (row.state === 'running' && row.result?.phase === 'question') waiting = row;
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(waiting, 'the turn shows its question');
    assert.equal(waiting.result.questions[0].title, '슬래브는 S-SLAB-3F 레이어인가요?');
    assert.equal(
      (await api(`${base}/requests/other/questions`, 'POST', { answers: [] })).status,
      404,
    );
    const answered = await api(`${base}/requests/turn-q/questions`, 'POST', {
      answers: [{ id: 'q1', option: 'o1' }],
    });
    assert.deepEqual([answered.status, answered.json], [200, { ok: true }]);
    let done;
    for (let i = 0; i < 200 && !done; i++) {
      const row = (await api(`${base}/requests/turn-q`)).json;
      if (row.state !== 'running' && row.state !== 'queued') done = row;
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(done.state, 'succeeded');
    assert.deepEqual(seen, [[{ id: 'q1', option: 'o1' }]]);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.VIDE_NATIVE_QUESTIONS;
    else process.env.VIDE_NATIVE_QUESTIONS = previous;
  }
});
