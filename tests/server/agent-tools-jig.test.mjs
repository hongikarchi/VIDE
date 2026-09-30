import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentTools, conversationHandlers } from '../../src/server/agent-tools.ts';
import {
  agentConnection,
  agentToolNames,
  configureAgentArguments,
  conversationToolInstruction,
  turnRules,
} from '../../src/ai/agent-connection.ts';
import { DomainError } from '../../src/core/store.ts';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const summary = (mode) => ({
  schema: 'vide.structure.summary/1',
  mode,
  label: mode === 'preview' ? '미확정 미리보기' : '확정 결과',
  status: 'ok',
  modelHash: 'h',
  coreVersion: '0.1.0',
  ms: 12,
  combos: [{ id: 'C1', limitState: 'strength', terms: { D: 1.2, L: 1.6 } }],
  statusCodes: ['ok', 'warn', 'ng', 'na', 'err'],
  colorBands: [0.8, 1],
  clauses: ['KDS 14 31 10 휨'],
  members: [
    ['G1', 0, 0.42, 0, null, null, []],
    ['G2', 2, 1.13, 0, 18.5, 30, [[2, 1.13]]],
    ['C1', 1, 0.86, null, null, null, []],
  ],
  reactions: {
    sumZ_kN: { C1: 812 },
    lateral_kN: { C1: [0, 0] },
    perColumn: [['C1', 0, 0, 1, 2]],
    maxLateral_kN: 2,
  },
  maxRatio: 1.13,
  steel_t: 14.2,
  counts: { ok: 1, warn: 1, ng: 1, na: 0, err: 0 },
  margin: { name: '중력 조합 부재 검정 여유', value: -0.13 },
  issues: [],
  assumptions: ['합성 가정'],
  unchecked: ['상단선 기준 편심'],
  disclaimer: '탐색용 예비값',
});

function fakeSources({ openInstanceId = 'inst-1', projectId = 'p1' } = {}) {
  const params = new Map([
    ['span', { key: 'span', title: '경간', displayValue: 9, displayUnit: 'm', by: 'default' }],
    [
      'grid',
      {
        key: 'grid',
        title: '기준 격자',
        displayValue: 'A',
        displayUnit: '',
        by: 'default',
        fixedAtPin: true,
      },
    ],
  ]);
  const calls = { set: [], run: [], ledger: [] };
  const instances = {
    'inst-1': { steps: ['assemble', 'analysis'] },
    'inst-2': { steps: ['assemble'] },
  };
  const jigs = {
    list: (pid) =>
      pid === projectId
        ? Object.keys(instances).map((id) => ({ id, jigId: 'vide/s06-frame', title: id }))
        : [],
    view: async (pid, instanceId) => {
      if (pid !== projectId || !instances[instanceId]) throw new DomainError('NOT_FOUND');
      return {
        id: instanceId,
        jig: { id: 'vide/s06-frame', version: '0.1.0', name: '골조' },
        title: instanceId,
        status: 'computed',
        steps: instances[instanceId].steps.map((id) => ({
          id,
          title: id,
          kind: 'code',
          status: 'done',
          hasOutput: true,
        })),
        params: [...params.values()],
      };
    },
    output: (pid, instanceId, stepId) => {
      if (pid !== projectId) throw new DomainError('NOT_FOUND');
      if (stepId === 'analysis') return { summary: summary('preview') };
      return { columns: Array.from({ length: 30 }, (_, i) => ({ id: `C${i}`, x: i })), count: 30 };
    },
    setParams: async (pid, instanceId, input) => {
      calls.set.push({ pid, instanceId, input });
      for (const change of input.values) {
        const param = params.get(change.key);
        if (!param) throw new DomainError('NOT_FOUND');
        if (param.fixedAtPin) throw new DomainError('PARAM_FIXED');
        params.set(change.key, { ...param, displayValue: change.value, by: input.by });
      }
      return {
        seqs: [7],
        affected: ['analysis'],
        changed: input.values.map((v) => v.key),
        instance: await jigs.view(pid, instanceId),
      };
    },
    run: async (pid, instanceId, input) => {
      calls.run.push({ pid, instanceId, input });
      return { status: 'computed', steps: [{ id: 'analysis', status: 'done', ms: 5 }] };
    },
  };
  const scene = [
    ...Array.from({ length: 70 }, (_, i) => ({
      id: `g${i}`,
      layer64: b64('구조::거더'),
      type: 'curve',
      length: 6 + i,
      bounds: [
        [0, 0, 0],
        [6, 0, 0],
      ],
      mesh: { vertices: [1, 2, 3] },
    })),
    { id: 'c1', layer64: b64('구조::기둥'), type: 'brep', volume: 1.2 },
  ];
  const rows = [
    { id: 'sync-old', state: 'succeeded', input: { linkId: 'L1' } },
    { id: 'sync-1', state: 'succeeded', input: { linkId: 'L1' } },
    { id: 'edit', state: 'succeeded', input: {} },
  ];
  const workspace = {
    list: (pid) => (pid === projectId ? rows : []),
    get: (pid, id) => ({ id, result: { scene: id === 'sync-1' ? scene : [] } }),
  };
  const links = {
    list: () => [{ id: 'L1', host: 'rhino', name: '합성 모델' }],
    get: (pid, id) => {
      if (pid !== projectId || id !== 'L1') throw new DomainError('NOT_FOUND');
      return { id: 'L1', host: 'rhino', name: '합성 모델' };
    },
  };
  return {
    calls,
    sources: {
      projectId,
      conversationId: 'conv-1',
      openInstanceId,
      requestId: 'req-1',
      workspace,
      jigs,
      links,
      ledger: (item) => calls.ledger.push(item),
    },
  };
}
const T = 'conversation:conv-1';
const body = (result) => JSON.parse(result.content[0].text);

function scoped(options) {
  const tools = new AgentTools({ origin: 'http://127.0.0.1:47999' });
  const { sources, calls } = fakeSources(options);
  const scope = tools.issueConversation(sources);
  return {
    tools,
    scope,
    calls,
    call: (name, args) => tools.call(scope.connection.token, name, args),
  };
}

test('one registry: connection allowlist equals the defined tools, conversation connection validates', () => {
  const { scope } = scoped();
  assert.ok(agentToolNames.includes('jig_set') && agentToolNames.includes('sync_sample'));
  const connection = agentConnection({ ...scope.connection, tools: [...scope.connection.tools] });
  assert.deepEqual(
    [...connection.tools].sort(),
    [
      'jig_list',
      'jig_output',
      'jig_run',
      'jig_set',
      'jig_state',
      'links_layers',
      'structure_checks',
      'structure_summary',
      'sync_sample',
    ].sort(),
  );
  assert.equal(connection.url, 'http://127.0.0.1:47999/mcp');
  assert.ok(!connection.tools.includes('execute') && !connection.tools.includes('query'));
  assert.match(turnRules(connection), /quote only numbers a tool returned/);
  const args = configureAgentArguments(
    ['--safe-mode', '--mcp-config', '{}', '--system-prompt', 'x'],
    'claude',
    connection,
  );
  assert.ok(args[args.indexOf('--system-prompt') + 1].startsWith(conversationToolInstruction));
  assert.match(args.at(-1), /mcp__vide__jig_state/);
  assert.throws(
    () => agentConnection({ ...scope.connection, tools: ['jig_delete'] }),
    /INVALID_AGENT_CONNECTION/,
  );
});

test('without a known origin no conversation scope is issued', () => {
  const tools = new AgentTools();
  assert.equal(tools.issueConversation(fakeSources().sources), undefined);
});

test('read tools: list, state, paged output, structure summary and checks', async () => {
  const { call } = scoped();
  const list = body(await call('jig_list', { targetRef: T }));
  assert.deepEqual(
    list.instances.map((row) => [row.id, row.open === true]),
    [
      ['inst-1', true],
      ['inst-2', false],
    ],
  );
  const state = body(await call('jig_state', { targetRef: T, instanceId: 'inst-1' }));
  assert.equal(state.open, true);
  assert.equal(state.params.find((p) => p.key === 'grid').fixedAtPin, true);
  const outline = body(
    await call('jig_output', { targetRef: T, instanceId: 'inst-1', stepId: 'assemble' }),
  );
  assert.equal(outline.value.count, 30);
  const paged = body(
    await call('jig_output', {
      targetRef: T,
      instanceId: 'inst-1',
      stepId: 'assemble',
      path: 'columns',
      offset: 20,
      limit: 20,
    }),
  );
  assert.deepEqual([paged.total, paged.items.length, paged.nextOffset], [30, 10, null]);
  const missing = await call('jig_output', {
    targetRef: T,
    instanceId: 'inst-1',
    stepId: 'assemble',
    path: 'nothing',
  });
  assert.equal(body(missing).code, 'NOT_FOUND');
  const head = body(await call('structure_summary', { targetRef: T, instanceId: 'inst-1' }));
  assert.equal(head.label, '미확정 미리보기');
  assert.equal(head.maxRatio, 1.13);
  assert.equal(head.members, 3);
  const worst = body(
    await call('structure_checks', {
      targetRef: T,
      instanceId: 'inst-1',
      order: 'worst',
      limit: 2,
    }),
  );
  assert.equal(worst.label, '미확정 미리보기');
  assert.deepEqual(
    worst.items.map((row) => [row.member, row.status]),
    [
      ['G2', 'ng'],
      ['C1', 'warn'],
    ],
  );
  assert.equal(worst.nextOffset, 2);
  const ng = body(
    await call('structure_checks', { targetRef: T, instanceId: 'inst-1', status: 'ng' }),
  );
  assert.deepEqual(
    ng.items.map((row) => [row.member, row.clause, row.referenceDeflection_mm]),
    [['G2', 'KDS 14 31 10 휨', 18.5]],
  );
  assert.equal(
    body(await call('structure_summary', { targetRef: T, instanceId: 'inst-2' })).code,
    'STRUCTURE_NOT_COMPUTED',
  );
});

test('links_layers and sync_sample read the latest stored Sync only, bounded, without geometry payloads', async () => {
  const { call } = scoped();
  const layers = body(await call('links_layers', { targetRef: T }));
  assert.equal(layers.links[0].syncId, 'sync-1');
  assert.deepEqual(layers.links[0].layers, [
    { fullPath: '구조::거더', objectCount: 70 },
    { fullPath: '구조::기둥', objectCount: 1 },
  ]);
  const sample = body(
    await call('sync_sample', { targetRef: T, linkId: 'L1', layer: '구조::거더' }),
  );
  assert.deepEqual([sample.total, sample.items.length, sample.nextOffset], [70, 20, 20]);
  assert.equal(sample.items[0].layer, '구조::거더');
  assert.equal(sample.items[0].length, 6);
  assert.ok(!('mesh' in sample.items[0]) && !('layer64' in sample.items[0]));
  assert.equal(
    (await call('sync_sample', { targetRef: T, linkId: 'L1', layer: 'x', limit: 51 })).isError,
    true,
  );
  assert.equal(
    body(await call('sync_sample', { targetRef: T, linkId: 'L9', layer: '구조::거더' })).code,
    'NOT_FOUND',
  );
});

test('jig_set and jig_run act only on the open instance; changes are recorded, fixedAtPin refused', async () => {
  const { call, calls } = scoped();
  const set = body(
    await call('jig_set', {
      targetRef: T,
      instanceId: 'inst-1',
      values: [{ key: 'span', value: 11 }],
      reason: '경간 11로',
    }),
  );
  assert.deepEqual(set.changes, [{ key: 'span', title: '경간', from: 9, to: 11, unit: 'm' }]);
  assert.deepEqual(set.staleSteps, ['analysis']);
  assert.equal(calls.set[0].input.by, 'ai');
  assert.equal(calls.set[0].input.requestId, 'req-1');
  assert.equal(calls.ledger.length, 1);
  assert.equal(calls.ledger[0].kind, 'param-change');
  assert.deepEqual(calls.ledger[0].body.seqs, [7]);
  assert.equal(calls.ledger[0].requestId, 'req-1');
  assert.equal(
    body(
      await call('jig_set', {
        targetRef: T,
        instanceId: 'inst-1',
        values: [{ key: 'grid', value: 'B' }],
      }),
    ).code,
    'PARAM_FIXED',
  );
  assert.equal(calls.ledger.length, 1);
  assert.equal(
    body(
      await call('jig_set', {
        targetRef: T,
        instanceId: 'inst-2',
        values: [{ key: 'span', value: 12 }],
      }),
    ).code,
    'JIG_NOT_OPEN',
  );
  assert.equal(
    body(await call('jig_run', { targetRef: T, instanceId: 'inst-2' })).code,
    'JIG_NOT_OPEN',
  );
  const run = body(
    await call('jig_run', { targetRef: T, instanceId: 'inst-1', until: 'analysis' }),
  );
  assert.equal(run.status, 'computed');
  assert.deepEqual(calls.run[0].input, { until: 'analysis', mode: 'geometry' });
  // The AI cannot confirm an analysis (a person's step).
  assert.equal(
    (await call('jig_run', { targetRef: T, instanceId: 'inst-1', mode: 'confirmed' })).isError,
    true,
  );
  assert.equal(calls.run.length, 1);
});

test('scope: other conversation target refused, no write tools without an open jig, host tools absent', async () => {
  const { call } = scoped();
  assert.equal(
    body(await call('jig_list', { targetRef: 'conversation:other' })).code,
    'TARGET_MISMATCH',
  );
  assert.equal(
    body(await call('execute', { targetRef: T, code: 'doc.Objects.Clear()' })).code,
    'AGENT_TOOL_UNAVAILABLE',
  );
  const closed = scoped({ openInstanceId: null });
  assert.ok(!closed.scope.connection.tools.includes('jig_set'));
  assert.ok(!closed.scope.connection.tools.includes('jig_run'));
  assert.equal(
    body(
      await closed.call('jig_set', {
        targetRef: T,
        instanceId: 'inst-1',
        values: [{ key: 'span', value: 1 }],
      }),
    ).code,
    'AGENT_TOOL_UNAVAILABLE',
  );
  // Another project's instances are not reachable through this scope.
  const other = fakeSources().sources;
  const handlers = conversationHandlers({ ...other, projectId: 'p2' });
  assert.deepEqual(handlers.jig_list({ targetRef: T }, {}).instances, []);
  closed.scope.revoke();
  assert.equal(body(await closed.call('jig_list', { targetRef: T })).code, 'AGENT_UNAUTHORIZED');
});

test('large outputs come as an outline; an oversized page is refused, not cut', async () => {
  const tools = new AgentTools({ origin: 'http://127.0.0.1:47999' });
  const { sources } = fakeSources();
  sources.jigs.output = () => ({ big: 'x'.repeat(60_000), rows: Array(20).fill('y'.repeat(5000)) });
  const scope = tools.issueConversation(sources);
  const outline = body(
    await tools.call(scope.connection.token, 'jig_output', {
      targetRef: T,
      instanceId: 'inst-1',
      stepId: 'assemble',
    }),
  );
  assert.equal(outline.outline.big.length, 201);
  const direct = await tools.call(scope.connection.token, 'jig_output', {
    targetRef: T,
    instanceId: 'inst-1',
    stepId: 'assemble',
    path: 'rows',
  });
  assert.equal(body(direct).code, 'QUERY_RESULT_TOO_LARGE');
});

test('the turn rules name the target, the open jig and the linked files; tools take them left out', async () => {
  const { scope, call, calls, tools } = scoped();
  // The values travel with the connection (ids and hosts only; no file names).
  assert.deepEqual(scope.connection.scope, {
    targetRef: T,
    openInstanceId: 'inst-1',
    links: [{ id: 'L1', host: 'rhino' }],
  });
  const connection = agentConnection({ ...scope.connection, tools: [...scope.connection.tools] });
  const rules = turnRules(connection);
  assert.match(rules, /targetRef is "conversation:conv-1", the only target/);
  assert.match(rules, /instanceId "inst-1"; leave instanceId out/);
  assert.match(rules, /"linkId":"L1","host":"rhino"/);
  assert.doesNotMatch(rules, /합성 모델/);
  // targetRef and instanceId left out: the scope's only target and the open jig.
  assert.equal(body(await call('jig_list', {})).instances.length, 2);
  assert.equal(body(await call('jig_state', {})).id, 'inst-1');
  assert.equal(body(await call('structure_summary', {})).maxRatio, 1.13);
  assert.equal(body(await call('links_layers', {})).links[0].syncId, 'sync-1');
  const set = body(await call('jig_set', { values: [{ key: 'span', value: 10 }] }));
  assert.deepEqual(set.changes[0].to, 10);
  assert.equal(calls.set.at(-1).instanceId, 'inst-1');
  assert.equal(body(await call('jig_run', {})).status, 'computed');
  // Without an open jig instanceId must be given; the rules say so.
  const closed = scoped({ openInstanceId: null });
  assert.equal(body(await closed.call('jig_state', {})).code, 'JIG_NOT_OPEN');
  assert.equal(body(await closed.call('jig_state', { instanceId: 'inst-2' })).id, 'inst-2');
  assert.match(turnRules(closed.scope.connection), /No jig is open/);
  // A scope with several targets still needs targetRef named.
  const many = tools.issue({
    targetRef: [T, 'conversation:conv-2'],
    handlers: conversationHandlers(fakeSources().sources),
    isCurrent: () => true,
  });
  assert.equal(body(await tools.call(many.token, 'jig_list', {})).code, 'TARGET_MISMATCH');
  assert.equal(
    body(await tools.call(many.token, 'jig_list', { targetRef: T })).instances.length,
    2,
  );
  // Scope values are checked like the rest of the connection.
  assert.throws(
    () => agentConnection({ ...scope.connection, scope: { targetRef: '' } }),
    /INVALID_AGENT_CONNECTION/,
  );
});
