import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../../src/server/server.ts';
import { ClaudeCli } from '../../src/ai/claude-cli.ts';
import { loadJig } from '../../src/jigs/runtime/loader.ts';
import { ComputeBoxRunner } from '../../src/jigs/runtime/compute-box.ts';
import { MemoryCache, executeSteps } from '../../src/jigs/runtime/runner.ts';
import { initialParams } from '../../src/jigs/runtime/params.ts';
import { assemble } from '../../extensions/jigs/s06-frame/steps/assemble.ts';
import { axes } from '../../extensions/jigs/s06-frame/steps/axes.ts';
import { columns } from '../../extensions/jigs/s06-frame/steps/columns.ts';
import { footprints } from '../../extensions/jigs/s06-frame/steps/footprints.ts';
import { CASES, fixtureFiles } from '../../extensions/jigs/s06-frame/fixtures/cases.ts';

// M5 acceptance replay (PLAN-22 T-064, SPEC-07.16): the make-conversation flow of the real run
// (docs/tdd/VERIFY-2026-09-30-jig-authoring-m5.md) with the Claude CLI replaced by a fake process
// that does what the CLI did — file writes in the `--add-dir` draft folder, the vide MCP tools
// over HTTP with the turn's token, a question card, the answer turn — through the real engine.
// Then pin, run the pinned jig on the S-06 synthetic fixture and compare with S-06 ③.
// Synthetic data only; no provider, no host.

const TWINS = `// 신설 E.J.마다 선 양쪽 기둥의 짝(쌍기둥)과 공통 파일캡을 본다. (inputs, params) => output.
import { blockFootprints } from 'vide/geometry-kit';

type P = [number, number];
interface Row { id?: string; line?: number[]; block?: { definition: string; transform: number[] } }
interface Role { rows: Row[]; definitions?: Record<string, any> }
export interface TwinsInputs { site: { newEJ?: Role; columns?: Role; newFootings?: Role } }
export interface TwinsParams { nearDist: number; spacingMax: number; onLine: string }

function inside(p: P, ring: P[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
export function twins(inputs: TwinsInputs, params: TwinsParams) {
  const foot = inputs.site.newFootings;
  const caps = (foot?.rows ?? []).map((row, i) => ({
    key: 'cap:' + (row.id ?? i),
    hull: blockFootprints(foot!.definitions![row.block!.definition], row.block!.transform).hull as P[],
  }));
  const capOf = (p: P) => caps.find((c) => inside(p, c.hull))?.key ?? '';
  const cols = (inputs.site.columns?.rows ?? []).map((row, i) => ({
    key: 'col:' + (row.id ?? i),
    at: [row.line![0], row.line![1]] as P,
  }));
  const pairs: any[] = [];
  const issues: any[] = [];
  for (const [k, ej] of (inputs.site.newEJ?.rows ?? []).entries()) {
    const name = ej.id ?? 'ej' + k;
    const a: P = [ej.line![0], ej.line![1]], b: P = [ej.line![3], ej.line![4]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u: P = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const near = cols
      .map((c) => {
        const d: P = [c.at[0] - a[0], c.at[1] - a[1]];
        return { ...c, along: d[0] * u[0] + d[1] * u[1], side: d[0] * -u[1] + d[1] * u[0] };
      })
      .filter((c) => Math.abs(c.side) <= params.nearDist && c.along >= -params.nearDist && c.along <= len + params.nearDist);
    if (!near.length) issues.push({ key: 'nocol:' + name, reason: 'no-columns' });
    const left = near.filter((c) => c.side > 1e-3), right = near.filter((c) => c.side < -1e-3);
    for (const c of near.filter((c) => Math.abs(c.side) <= 1e-3))
      issues.push({ key: 'online:' + c.key, reason: params.onLine === 'flag' ? 'on-line' : 'ignored' });
    const used = new Set<string>();
    for (const c of left.sort((p, q) => p.along - q.along)) {
      const mate = right
        .filter((r) => !used.has(r.key))
        .sort((p, q) => Math.abs(p.along - c.along) - Math.abs(q.along - c.along))[0];
      if (!mate) { issues.push({ key: 'unpaired:' + c.key, reason: 'unpaired' }); continue; }
      used.add(mate.key);
      const spacing = Math.round(Math.hypot(c.at[0] - mate.at[0], c.at[1] - mate.at[1]) * 1000) / 1000;
      const capA = capOf(c.at), capB = capOf(mate.at);
      const reasons = [
        ...(spacing > params.spacingMax ? ['spacing'] : []),
        ...(!capA || !capB ? ['no-cap'] : capA !== capB ? ['split-cap'] : []),
      ];
      pairs.push({ key: 'pair:' + name + ':' + (pairs.length + 1), spacing, cap: capA, ok: !reasons.length, reasons });
    }
    for (const r of right) if (!used.has(r.key)) issues.push({ key: 'unpaired:' + r.key, reason: 'unpaired' });
  }
  return { pairs, issues, ok: pairs.filter((p) => p.ok).length, caps: caps.length };
}
`;
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const cap = {
  vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
  indices: [0, 2, 1, 0, 3, 2],
  segments: [0, 1, 1, 2, 2, 3, 3, 0],
};
const caseInput = (capX) => ({
  site: {
    newEJ: { rows: [{ id: 'ej-1', line: [0, 0, 0, 0, 10, 0] }] },
    columns: {
      rows: [
        { id: 'a', line: [-0.5, 2, 0, -0.5, 2, 4] },
        { id: 'b', line: [0.5, 2, 0, 0.5, 2, 4] },
      ],
    },
    newFootings: {
      rows: capX.map((x, i) => ({
        id: `cap-${i + 1}`,
        block: {
          definition: 'cap',
          transform: [x[1], 0, 0, x[0], 0, 2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1],
        },
      })),
      definitions: { cap },
    },
  },
});
/** The files the first make turn writes (what the AI wrote, reduced to one step). */
function draftFiles(manifest) {
  return {
    'jig.json': json({
      ...manifest,
      summary: '신설 E.J.마다 양쪽 기둥과 공통 파일캡이 있는지 본다(합성 시험).',
      inputs: [
        {
          key: 'site',
          title: '신설 E.J.·기둥·파일캡',
          kind: 'assembly',
          roles: [
            ['newEJ', '신설 E.J.', 'line', true],
            ['columns', '기둥', 'line', true],
            ['newFootings', '신설 기초(파일캡)', 'footprint', false],
          ].map(([role, title, shape, required]) => ({
            role,
            title,
            shape,
            many: true,
            required,
            hints: { layers: [`*${title}*`], words: [title] },
            extract: 'rows',
          })),
        },
      ],
      params: [
        {
          key: 'nearDist',
          title: 'E.J.에서 가까운 기둥 범위',
          group: '쌍기둥',
          type: 'length',
          unit: 'm',
          default: 2,
          range: { min: 0.5, max: 5, step: 0.1 },
          basis: { status: 'assumed' },
          affects: ['twins'],
        },
        {
          key: 'spacingMax',
          title: '쌍기둥 간격 상한',
          group: '쌍기둥',
          type: 'length',
          unit: 'm',
          default: 2.5,
          range: { min: 0.5, max: 6, step: 0.1 },
          basis: { status: 'assumed' },
          affects: ['twins'],
        },
        {
          key: 'onLine',
          title: '선 위 기둥',
          group: '쌍기둥',
          type: 'choice',
          choices: [
            { value: 'flag', label: '문제로 표시' },
            { value: 'ignore', label: '판정에서 제외' },
          ],
          default: 'ignore',
          basis: { status: 'assumed' },
          affects: ['twins'],
        },
      ],
      steps: [
        {
          id: 'twins',
          title: '쌍기둥·파일캡 판정',
          kind: 'code',
          entry: 'steps/twins.ts#twins',
          reads: [
            'input.site.newEJ',
            'input.site.columns',
            'input.site.newFootings',
            'param.nearDist',
            'param.spacingMax',
            'param.onLine',
          ],
          writes: 'twins',
          speed: 'live',
          gates: [{ use: 'no-nan' }],
        },
      ],
      capabilities: [{ name: 'sync.read', reason: '신설 E.J.·기둥·파일캡을 읽는다' }],
    }),
    'panel.json': json({
      layout: 'jig-run',
      left: [{ part: 'step-rail' }, { part: 'param-group' }],
      center: {
        views: [],
        kpis: { part: 'kpi-strip', items: [{ label: '정상 쌍', from: 'step.twins.ok' }] },
      },
      drawer: {
        part: 'result-tabs',
        tabs: [
          {
            title: '쌍기둥',
            part: 'table',
            from: 'step.twins.pairs',
            columns: [
              { field: 'key', label: '쌍' },
              { field: 'spacing', label: '간격' },
              { field: 'cap', label: '파일캡' },
            ],
          },
        ],
      },
    }),
    'steps/twins.ts': TWINS,
    // The example's grid steps are replaced: grid and beams go by jig_delete_file (turn 1), the
    // summary step is left empty, which the pin drops.
    'steps/summary.ts': '',
    'fixtures/basic/input.json': json(caseInput([[-1.5, 3]])),
    'fixtures/basic/params.json': json({}),
    'fixtures/basic/expect.json': json({ steps: { twins: { ok: 1, caps: 1 } } }),
    'fixtures/split-cap/input.json': json(
      caseInput([
        [-1.2, 1],
        [0.2, 1],
      ]),
    ),
    'fixtures/split-cap/params.json': json({}),
    'fixtures/split-cap/expect.json': json({ steps: { twins: { ok: 0, caps: 2 } } }),
    'skill.md':
      '---\nname: EJ twin check\nwords: [쌍기둥, 신설 E.J., 파일캡]\nnot_for: []\ntools: []\nlimits: []\n---\n\n# 쌍기둥·공통 파일캡 점검\n',
  };
}

const card = {
  id: 'ej-on-line',
  title: 'E.J. 선 바로 위의 기둥은 어떻게 볼까요?',
  options: [
    { id: 'flag', label: '문제로 표시', recommended: true },
    { id: 'ignore', label: '판정에서 제외', recommended: false },
  ],
};

/** A fake Claude CLI process: `turn(call)` acts like the CLI and returns its stream events. */
function fakeCli(turn) {
  const calls = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      unref: () => {},
    });
    const call = { args, options, input: '' };
    const close = (code = 0) => {
      child.exitCode = code;
      child.emit('exit', code);
      child.emit('close', code);
    };
    const finish = (text) =>
      queueMicrotask(() => {
        child.stdout.write(text);
        close();
      });
    if (args[0] === '--version') finish('2.1.285 (Claude Code)\n');
    else if (args[0] === 'auth')
      finish(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
    else {
      calls.push(call);
      child.stdin.on('data', (data) => (call.input += data));
      child.stdin.on('finish', async () => {
        let events;
        try {
          events = await turn(call, calls.length);
        } catch (error) {
          events = [
            { type: 'result', subtype: 'error', is_error: true, result: String(error?.stack) },
          ];
        }
        for (const event of events) child.stdout.write(JSON.stringify(event) + '\n');
        setTimeout(() => close(0), 5);
      });
    }
    return child;
  };
  return { spawnProcess, calls };
}
const argOf = (args, flag) => args[args.indexOf(flag) + 1];
/** The CLI side of a make turn: the draft folder, the MCP client with the turn's token. */
async function cliSide(call) {
  const draftDir = argOf(call.args, '--add-dir');
  const { url } = JSON.parse(argOf(call.args, '--mcp-config')).mcpServers.vide;
  const client = new Client({ name: 'fake-claude', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${call.options.env.VIDE_AGENT_TOKEN}` } },
    }),
  );
  const tool = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: !!result.isError, data: JSON.parse(result.content[0].text) };
  };
  const events = [
    {
      type: 'system',
      subtype: 'init',
      session_id: argOf(call.args, '--session-id') ?? argOf(call.args, '--resume'),
      // The real CLI lists its structured-output tool with a non-empty --tools list.
      tools: [
        'Edit',
        'Glob',
        'Grep',
        'Read',
        'StructuredOutput',
        'Write',
        ...(await client.listTools()).tools.map((t) => `mcp__vide__${t.name}`),
      ],
      mcp_servers: [{ name: 'vide', status: 'connected' }],
    },
  ];
  const use = (name, input) =>
    events.push({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: `t${events.length}`, name, input }] },
    });
  const write = (path, text) => {
    const file = join(draftDir, ...path.split('/'));
    use('Write', { file_path: file, content: text });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const end = (output) => {
    use('StructuredOutput', output);
    events.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: output.text,
      structured_output: output,
      usage: { input_tokens: 20, output_tokens: 10 },
    });
    return events;
  };
  return { draftDir, client, tool, use, write, end, events };
}

test('M5 replay: a make-conversation writes, checks and asks; the pinned jig matches S-06 ③', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vide-m5-'));
  const seen = {};
  const cli = fakeCli(async (call, n) => {
    const side = await cliSide(call);
    try {
      const packet = JSON.parse(call.input);
      if (n === 1) {
        // Turn 1: the arguments of a make turn, then write the draft and run the three checks.
        seen.args = call.args;
        const manifest = JSON.parse(readFileSync(join(side.draftDir, 'jig.json'), 'utf8'));
        side.use('Read', { file_path: join(side.draftDir, 'jig.json') });
        for (const [path, text] of Object.entries(draftFiles(manifest))) side.write(path, text);
        for (const path of ['steps/grid.ts', 'steps/beams.ts']) {
          side.use('mcp__vide__jig_delete_file', { path });
          seen[path] = await side.tool('jig_delete_file', { path });
        }
        seen.deleteManifest = await side.tool('jig_delete_file', { path: 'jig.json' });
        seen.deleteOutside = await side.tool('jig_delete_file', { path: '../outside.ts' });
        // targetRef is left out: the make tools act on the conversation's draft.
        for (const name of ['jig_validate', 'jig_test', 'jig_preview']) {
          side.use(`mcp__vide__${name}`, {});
          seen[name] = await side.tool(name);
        }
        side.use('mcp__vide__ask_user', { question: card });
        seen.ask = await side.tool('ask_user', { question: card });
        return side.end({
          status: 'question',
          text: '선 위 기둥 처리를 정해 주세요.',
          questions: [card],
        });
      }
      if (n === 2) {
        // Turn 2 (the answer card): the chosen option becomes the setting's default.
        seen.answerPacket = JSON.stringify(packet);
        const file = join(side.draftDir, 'jig.json');
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        manifest.params.find((p) => p.key === 'onLine').default = 'flag';
        side.use('Edit', { file_path: file, old_string: '"ignore"', new_string: '"flag"' });
        writeFileSync(file, json(manifest));
        side.use('mcp__vide__jig_test', {});
        seen.retest = await side.tool('jig_test');
        return side.end({ status: 'done', text: '점검·시험 통과.', questions: [] });
      }
      // Turn 3: a write to an agent instruction file is refused before it lands.
      side.use('Write', { file_path: join(side.draftDir, 'CLAUDE.md'), content: 'x' });
      return side.end({ status: 'done', text: '끝', questions: [] });
    } finally {
      await side.client.close();
    }
  });
  const app = await startServer({
    filename: join(root, 'vide.sqlite'),
    host: { status: async () => ({}) },
    providerFactory: ({ provider, ...options }) =>
      new ClaudeCli({ ...options, spawnProcess: cli.spawnProcess }),
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
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
  const settle = async (projectId, id) => {
    for (let i = 0; i < 400; i++) {
      const row = (await api(`/projects/${projectId}/requests/${id}`)).json;
      if (!['queued', 'running'].includes(row?.state)) return row;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('turn did not settle');
  };

  const project = (await api('/projects', 'POST', { name: 'M5 재현' })).json;
  const base = `/projects/${project.id}/jig-drafts`;
  const draft = (await api(base, 'POST', { name: 'EJ twin check', from: 'example-grid' })).json;
  assert.equal(draft.manifest.id, 'project/ej-twin-check');
  const conversation = (
    await api(`/projects/${project.id}/conversations`, 'POST', {
      mode: 'make',
      draftId: draft.id,
      provider: 'claude-cli',
      model: 'sonnet',
    })
  ).json;
  assert.equal(conversation.kind, 'jig-make');
  const turn = async (id, body) => {
    const posted = await api(`/projects/${project.id}/requests`, 'POST', {
      id,
      body,
      permission: 'review',
      provider: 'claude-cli',
      pins: [],
      sketches: [],
      files: [],
      conversationId: conversation.id,
    });
    assert.equal(posted.status, 202, JSON.stringify(posted.json));
    // The composer sends no hostUse: a make-conversation turn is host-free by itself.
    assert.equal(posted.json.input.hostUse, 'none');
    return settle(project.id, id);
  };

  // Turn 1: file tools on the draft folder, the make tools, a question card.
  const first = await turn(
    '00000000-0000-4000-8000-000000000001',
    '신설 E.J.마다 양쪽 기둥과 공통 파일캡이 있는지 보는 도구를 만들어 줘.',
  );
  assert.equal(first.state, 'succeeded', JSON.stringify(first.result));
  assert.equal(argOf(seen.args, '--add-dir'), draft.path);
  assert.equal(argOf(seen.args, '--tools'), 'Read,Edit,Write,Glob,Grep');
  assert.ok(seen.args.includes('--restricted') && seen.args.includes('--json-schema'));
  assert.deepEqual(seen['steps/grid.ts'], {
    error: false,
    data: { path: 'steps/grid.ts', deleted: true },
  });
  assert.equal(seen['steps/beams.ts'].data.deleted, true);
  assert.equal(existsSync(join(draft.path, 'steps', 'grid.ts')), false);
  assert.deepEqual(seen.deleteManifest, { error: true, data: { code: 'DRAFT_PATH_INVALID' } });
  assert.deepEqual(seen.deleteOutside, { error: true, data: { code: 'DRAFT_OUTSIDE' } });
  assert.equal(seen.jig_validate.error, false);
  assert.equal(seen.jig_validate.data.ok, true, JSON.stringify(seen.jig_validate.data.issues));
  assert.equal(seen.jig_test.data.ok, true, JSON.stringify(seen.jig_test.data.cases));
  assert.deepEqual(
    seen.jig_test.data.cases.map((c) => c.name),
    ['basic', 'split-cap'],
  );
  assert.equal(seen.jig_preview.data.ok, true);
  assert.equal(seen.jig_preview.data.fixture, 'basic');
  assert.equal(seen.ask.error, false);
  assert.equal(first.result.turnOutput.status, 'question');
  assert.equal(first.result.turnOutput.questions[0].id, 'ej-on-line');

  // Turn 2: the answer card goes as the next turn of the same conversation.
  const answered = await api(
    `/projects/${project.id}/conversations/${conversation.id}/answer`,
    'POST',
    {
      requestId: first.id,
      answers: [{ questionId: 'ej-on-line', optionId: 'flag' }],
    },
  );
  assert.equal(answered.status, 201, JSON.stringify(answered.json));
  const second = await settle(project.id, answered.json.request.id);
  assert.equal(second.state, 'succeeded', JSON.stringify(second.result));
  assert.match(seen.answerPacket, /ej-on-line=flag/);
  // The answer turn of a make-conversation runs on the make budgets (SPEC-07.9).
  assert.deepEqual(second.input.executionLimits, {
    maxToolCalls: 100,
    maxHostCommands: 12,
    timeoutSeconds: 600,
  });
  assert.equal(seen.retest.data.ok, true);

  // Turn 3: a forbidden file write stops the turn; nothing lands in the folder.
  const third = await turn('00000000-0000-4000-8000-000000000003', 'CLAUDE.md도 만들어 줘.');
  assert.equal(third.state, 'failed');
  assert.equal(third.result?.code ?? third.error?.code, 'UNEXPECTED_TOOL_CALL');
  assert.equal(existsSync(join(draft.path, 'CLAUDE.md')), false);

  // A forbidden file put there by other means refuses validation and the pin.
  writeFileSync(join(draft.path, 'AGENTS.md'), '# no');
  assert.equal((await api(`${base}/${draft.id}/validate`, 'POST', {})).json.ok, false);
  assert.equal((await api(`${base}/${draft.id}/pin`, 'POST', { confirm: true })).status, 422);
  rmSync(join(draft.path, 'AGENTS.md'));

  // Pin (a confirmed action), then run the pinned package in the compute box on S-06 ③'s layout.
  const pinned = await api(`${base}/${draft.id}/pin`, 'POST', { confirm: true });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.json));
  assert.equal(pinned.json.id, 'project/ej-twin-check');
  // The emptied step file stayed in the draft but not in the pinned package.
  assert.equal(existsSync(join(draft.path, 'steps', 'summary.ts')), true);
  assert.equal(existsSync(join(pinned.json.path, 'steps', 'summary.ts')), false);
  assert.equal(existsSync(join(pinned.json.path, 'steps', 'twins.ts')), true);
  const jig = await loadJig(pinned.json.path, {
    source: 'ai-draft',
    expectDigest: pinned.json.digest,
  });
  const { input, params } = fixtureFiles(CASES.find((c) => c.name === 'grid-rot21'));
  const a = assemble(input, params);
  const x = axes({ ...input, steps: { assemble: a } }, params);
  const c = columns({ ...input, steps: { axes: x, assemble: a } }, params);
  const f = footprints({ ...input, steps: { columns: c, assemble: a } }, params);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const runner = new ComputeBoxRunner();
  try {
    const run = async (site) =>
      (
        await executeSteps({
          jig,
          runner,
          cache: new MemoryCache(),
          mode: 'preview',
          inputs: { site },
          params: initialParams(jig.manifest),
        })
      ).outputs.twins;
    const proposed = await run({
      newEJ: input.site.newEJ,
      columns: {
        rows: c.columns.map((col) => ({ id: col.key, line: [...col.bottom, ...col.top] })),
      },
      newFootings: {
        rows: f.caps.map((k) => ({ id: k.key, block: { definition: k.key, transform: identity } })),
        definitions: f.definitions,
      },
    });
    // Same judgement as the S-06 frame jig ③: two twin pairs 1.1 m apart, each on one common cap.
    assert.equal(c.pairs.length, 2);
    assert.equal(proposed.pairs.length, c.pairs.length);
    assert.equal(proposed.ok, 2);
    for (const pair of proposed.pairs) assert.equal(pair.spacing, c.pairs[0].spacing);
    // The drawn columns of the same fixture have none near the joint: one issue, no pair.
    const drawn = await run({
      newEJ: input.site.newEJ,
      columns: input.site.columns,
      newFootings: input.site.newFootings,
    });
    assert.deepEqual([drawn.pairs.length, drawn.issues.map((i) => i.reason)], [0, ['no-columns']]);
  } finally {
    await runner.close();
  }

  // The draft is pinned: a new turn of its make-conversation is refused.
  const late = await api(`/projects/${project.id}/requests`, 'POST', {
    id: '00000000-0000-4000-8000-000000000004',
    body: '하나 더',
    permission: 'review',
    provider: 'claude-cli',
    pins: [],
    sketches: [],
    files: [],
    conversationId: conversation.id,
  });
  assert.equal(late.status, 409);
  assert.equal(late.json.code, 'DRAFT_NOT_OPEN');

  // DELETE reaches the draft route (the engine allows this one DELETE path).
  const removed = await api(`${base}/${draft.id}`, 'DELETE');
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.equal(existsSync(draft.path), false);
  assert.equal((await api(`/projects/${project.id}/jig-drafts/x/y`, 'DELETE')).status, 405);
});
