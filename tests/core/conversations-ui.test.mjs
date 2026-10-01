// Pure parts of the conversation chips (src/ui/conversations.tsx, PLAN-24 T-061): chip states,
// labels, the hand-over card and the conversation filter. The TSX module is bundled with
// rolldown (Vite's bundler) into a temporary file; its CSS import is stubbed.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import { rolldown } from 'rolldown';

const directory = mkdtempSync(join(tmpdir(), 'vide-conversations-ui-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const bundle = await rolldown({
  input: fileURLToPath(new URL('../../src/ui/conversations.tsx', import.meta.url)),
  platform: 'node',
  logLevel: 'silent',
  transform: { jsx: 'react-jsx' },
  plugins: [
    {
      name: 'stub-css',
      resolveId: (source) => (source.endsWith('.css') ? '\0css' : null),
      load: (id) => (id === '\0css' ? 'export default {}' : null),
    },
  ],
});
const { output } = await bundle.generate({ format: 'esm' });
const file = join(directory, 'conversations.mjs');
writeFileSync(file, output[0].code);
const ui = await import(pathToFileURL(file).href);

const entry = (id, patch = {}) => ({
  id,
  kind: 'general',
  title: id ? `대화 ${id}` : '기본 대화',
  provider: id ? 'claude-cli' : null,
  model: id ? 'sonnet' : null,
  effort: null,
  accountProfileId: id ? 'default' : null,
  mode: id ? 'session' : 'ledger',
  targets: null,
  state: 'open',
  requests: 0,
  session: null,
  ...patch,
});
const request = (id, conversationId, state, result = null, extra = {}) => ({
  id,
  request: { state, input: conversationId ? { conversationId } : {}, result, ...extra },
});

test('requests without a conversation belong to the default one; undefined filters nothing', () => {
  assert.equal(ui.conversationOf(request('r1', undefined, 'succeeded')), null);
  assert.equal(ui.conversationOf(request('r2', 'c1', 'succeeded')), 'c1');
  // The default conversation's row (made at its first turn) is still the default one.
  assert.equal(ui.conversationOf(request('r3', 'default-p1', 'succeeded')), null);
  assert.equal(ui.inConversation(request('r3', 'default-p1', 'running'), null), true);
  assert.equal(ui.inConversation(request('r1', undefined, 'running'), null), true);
  assert.equal(ui.inConversation(request('r1', undefined, 'running'), 'c1'), false);
  assert.equal(ui.inConversation(request('r2', 'c1', 'running'), undefined), true);
});

test('chip states: running, waiting count, unread after the chip was looked at, closed hidden', () => {
  const list = [entry(null), entry('c1'), entry('c2'), entry('c3', { state: 'closed' })];
  const messages = [
    request('a', 'c1', 'running'),
    request('b', 'c1', 'queued', { phase: 'waiting' }),
    request('c', 'c1', 'queued', { phase: 'waiting' }),
    request('d', 'c2', 'succeeded'),
    request('e', 'c2', 'succeeded'),
    request('f', undefined, 'failed'),
    {
      id: 'g',
      request: { state: 'running', input: { conversationId: 'c2', parentRequestId: 'd' } },
    },
  ];
  const seen = new Map([
    ['default', new Set(['f'])],
    ['c2', new Set(['d'])],
  ]);
  const chips = ui.chipStates(list, messages, seen);
  // c2: request e finished after the chip was looked at; the child request g is not counted.
  assert.deepEqual(
    chips.map((chip) => [chip.id, chip.running, chip.waiting, chip.unread]),
    [
      [null, false, 0, false],
      ['c1', true, 2, false],
      ['c2', false, 0, true],
    ],
  );
  const waitingOnly = ui.chipStates(
    [entry('c1')],
    [request('b', 'c1', 'queued', { phase: 'waiting' })],
    new Map(),
  );
  assert.equal(waitingOnly[0].running, false);
  assert.equal(waitingOnly[0].waiting, 1);
});

test('a jig conversation chip shows its jig icon, the default until it is known (PLAN-26 T-100)', () => {
  const known = { i1: 'columns', 'draft:d1': 'grid' };
  const lookup = (key) => (key ? known[key] : undefined);
  assert.equal(
    ui.chipIcon(entry('c1', { kind: 'jig-run', jigInstanceId: 'i1' }), lookup),
    'columns',
  );
  assert.equal(ui.chipIcon(entry('c1', { kind: 'jig-make', draftId: 'd1' }), lookup), 'grid');
  assert.equal(ui.chipIcon(entry('c1', { kind: 'jig-run', jigInstanceId: 'i2' }), lookup), 'jig');
  assert.equal(
    ui.chipIcon(entry('c1', { kind: 'general', jigInstanceId: 'i1' }), lookup),
    'columns',
  );
  assert.equal(ui.chipIcon(entry('c1'), lookup), undefined);
  const [chip] = ui.chipStates([entry('c1', { kind: 'jig-run' })], [], new Map());
  assert.equal(chip.icon, 'jig');
  assert.equal('icon' in ui.chipStates([entry('c2')], [], new Map())[0], false);
});

test('chip and AI labels', () => {
  assert.equal(ui.chipLabel(entry(null)), '기본 대화');
  assert.equal(ui.chipLabel(entry('c1', { kind: 'ask', title: '주차 대수' })), '질문 · 주차 대수');
  assert.equal(ui.chipLabel(entry('c1', { kind: 'cad-edit', title: 'CAD 편집' })), 'CAD 편집');
  // A tab [+] opened reads '새 대화' until its first request names it (T-097); an older general
  // conversation that kept the default name with requests in it stays '대화'.
  assert.equal(ui.chipLabel(entry('c1', { title: '대화' })), '새 대화');
  assert.equal(ui.titleOf(entry('c1', { title: '대화' })), '새 대화');
  assert.equal(ui.chipLabel(entry('c1', { title: '대화', requests: 2 })), '대화');
  assert.equal(ui.chipLabel(entry('c1', { title: '구조 검토 부탁' })), '구조 검토 부탁');
  const models = [{ id: 'sonnet', name: 'Sonnet', provider: 'claude-cli' }];
  // Every conversation fixes its AI at its first turn; until then the label says so.
  assert.equal(ui.providerLabel(entry(null), models), '첫 요청 때 AI를 정합니다');
  assert.equal(
    ui.providerLabel(entry('c1', { pending: true }), models),
    '첫 요청 때 AI를 정합니다',
  );
  assert.equal(
    ui.providerLabel(entry(null, { provider: 'claude-cli', model: 'sonnet' }), models),
    'Claude · Sonnet',
  );
  assert.equal(ui.providerLabel(entry('c1'), models), 'Claude · Sonnet');
  // The account is the CLI's current login (ADR-025): an older conversation's profile is not shown.
  assert.equal(
    ui.providerLabel(entry('c1', { accountProfileId: 'p2', model: null }), models),
    'Claude · 기본 모델',
  );
});

test('hand-over card: the limit stop (no resend, AccountSwitch), then the recorded hand-over', () => {
  const detail = { id: 'c1', ledger: [] };
  const stopped = [
    request('a', 'c1', 'succeeded'),
    request('b', 'c1', 'failed', { code: 'PROVIDER_LIMIT' }, { updatedAt: '2026-09-30T10:00:00Z' }),
  ];
  const limit = ui.handoverCard(detail, stopped);
  assert.equal(limit.kind, 'limit');
  assert.equal(limit.requestId, 'b');
  assert.match(limit.text, /자동으로 다시 보내지 않습니다.*AccountSwitch/);
  const answered = ui.handoverCard(
    {
      id: 'c1',
      ledger: [
        {
          id: 'l1',
          kind: 'handoff',
          createdAt: '2026-09-30T10:05:00Z',
          body: {
            reason: 'provider',
            from: { provider: 'claude-cli', model: 'sonnet' },
            to: { provider: 'codex-cli', model: 'gpt-5' },
          },
        },
      ],
    },
    stopped,
  );
  assert.equal(answered.kind, 'record');
  assert.equal(answered.from, 'Claude · sonnet');
  assert.equal(answered.to, 'Codex · gpt-5');
  const first = {
    id: 'c1',
    ledger: [{ id: 'l0', kind: 'handoff', createdAt: 'x', body: { reason: 'first' } }],
  };
  assert.equal(ui.handoverCard(first, []), undefined);
  assert.equal(ui.handoverCard({ id: null, ledger: [] }, stopped), undefined);
  // Another model took a request to a new conversation: one line in both.
  const moved = (reason, side) => ({
    id: 'c1',
    ledger: [{ id: 'l2', kind: 'handoff', createdAt: 'y', body: { reason, ...side } }],
  });
  assert.equal(
    ui.handoverCard(moved('moved', { to: { provider: 'codex-cli', model: 'gpt-5' } }), []).text,
    '모델이 달라 새 대화로 이어서 보냈습니다 · Codex · gpt-5',
  );
  assert.equal(
    ui.handoverCard(moved('model', { from: { provider: 'claude-cli', model: 'sonnet' } }), []).text,
    '모델이 달라 새 대화로 이어서 보냈습니다 · Claude · sonnet',
  );
  const elsewhere = [request('z', 'c2', 'failed', { code: 'PROVIDER_LIMIT' })];
  assert.equal(ui.handoverCard(detail, elsewhere), undefined);
});

test('the filter is undefined until chips mount; listeners can unsubscribe', () => {
  assert.equal(ui.conversationFilter(), undefined);
  let heard = 0;
  const stop = ui.onConversationFilter(() => heard++);
  stop();
  assert.equal(heard, 0);
});

test('server response schemas accept the default conversation and a detail', () => {
  const session = {
    sessionId: 's',
    provider: 'claude-cli',
    accountProfileId: 'default',
    turns: 2,
    inputTokens: 10,
    state: 'active',
    lastTurnAt: null,
  };
  for (const value of [entry(null), entry('c1', { session })])
    assert.ok(ui.conversationSchema.parse({ ...value, projectId: 'p' }));
  const detail = ui.conversationDetailSchema.parse({ ...entry('c1'), ledger: [], sessions: [] });
  assert.deepEqual(detail.ledger, []);
});
