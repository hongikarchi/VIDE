import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountUsageService } from '../../src/ai/account-usage.ts';
import { codexLoginKey } from '../../src/ai/codex-app-server.ts';
import { USAGE_LIMIT } from '../../src/ai/claude-cli.ts';

// The current account of each CLI's default login (ADR-025): VIDE reads who it is and, with the
// opt-in lookup, its usage; AccountSwitch changes the login and VIDE follows.
const jwt = (payload) =>
  ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
const codexAuth = (token, email, plan) =>
  JSON.stringify({
    tokens: {
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, token }),
      account_id: 'acct-' + token,
      id_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: plan } }),
    },
  });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vide-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(
    join(home, '.claude', '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'claude-a',
        expiresAt: Date.now() + 3600_000,
        subscriptionType: 'max',
      },
    }),
  );
  await writeFile(
    join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }),
  );
  await writeFile(join(home, '.codex', 'auth.json'), codexAuth('one', 'one@example.com', 'pro'));
  const calls = [];
  const usage = { one: 95, two: 10 };
  const service = new AccountUsageService({
    file: join(root, 'usage-settings.json'),
    home,
    fetch: async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      if (url.includes('anthropic'))
        return Response.json({
          five_hour: { utilization: 12, resets_at: '2026-09-29T05:00:00Z' },
          seven_day: { utilization: 40, resets_at: '2026-10-01T00:00:00Z' },
        });
      const who = JSON.parse(
        Buffer.from(init.headers.Authorization.split(' ')[1].split('.')[1], 'base64url'),
      ).token;
      return Response.json({
        email: who + '@example.com',
        plan_type: who === 'one' ? 'pro' : 'plus',
        rate_limit: {
          limit_reached: false,
          primary_window: {
            used_percent: usage[who],
            limit_window_seconds: 604800,
            reset_at: 1791066305,
          },
          secondary_window: null,
        },
      });
    },
  });
  return { service, calls, home, root };
}

test('the default logins show who is signed in without any network call until usage lookup is on', async (t) => {
  const { service, calls } = await fixture(t);
  const rows = await service.all();
  assert.equal(calls.length, 0);
  assert.deepEqual(
    rows.map((row) => [row.provider, row.email, row.plan, row.state]),
    [
      ['claude-cli', 'a@example.com', 'max', 'off'],
      ['codex-cli', 'one@example.com', 'pro', 'off'],
    ],
  );
  assert.deepEqual(service.account('codex-cli'), {
    provider: 'codex-cli',
    signedIn: true,
    email: 'one@example.com',
    plan: 'pro',
  });
  assert.ok(!JSON.stringify(rows).includes('claude-a'), 'tokens are never returned');
});

test('usage lookup reads each login once per interval and follows an account changed in AccountSwitch', async (t) => {
  const { service, calls, home } = await fixture(t);
  service.setSettings({ usageLookup: true });
  const [claude, codex] = await service.all();
  assert.deepEqual(claude.session, { percent: 12, resetsAt: '2026-09-29T05:00:00.000Z' });
  assert.equal(claude.weekly.percent, 40);
  assert.equal(codex.weekly.percent, 95);
  assert.equal(calls.length, 2);
  await service.all();
  assert.equal(calls.length, 2, 'cached within the interval');
  // A request stopped on the login's limit marks it, for this account only.
  service.markLimited('codex-cli');
  assert.ok((await service.get('codex-cli')).limitedUntil);
  // AccountSwitch puts another ChatGPT account in place: its own usage, not the old one's limit.
  const before = codexLoginKey(home);
  await writeFile(join(home, '.codex', 'auth.json'), codexAuth('two', 'two@example.com', 'plus'));
  assert.notEqual(codexLoginKey(home), before);
  const switched = await service.get('codex-cli');
  assert.equal(switched.email, 'two@example.com');
  assert.equal(switched.weekly.percent, 10);
  assert.equal(switched.limitedUntil, undefined);
  assert.equal(calls.length, 3);
});

test('the lookup setting is kept in its file; an older file next to the former profiles is read', async (t) => {
  const { root } = await fixture(t);
  const legacyFile = join(root, 'cli-profiles', 'usage-settings.json');
  await mkdir(join(root, 'cli-profiles'));
  await writeFile(
    legacyFile,
    JSON.stringify({ usageLookup: true, autoSwitch: true, threshold: 90 }),
  );
  const file = join(root, 'data', 'usage-settings.json');
  const service = new AccountUsageService({ file, legacyFile, home: join(root, 'home') });
  assert.deepEqual(service.settings(), { usageLookup: true });
  service.setSettings({ usageLookup: false });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { usageLookup: false });
  assert.equal(
    JSON.parse(await readFile(legacyFile, 'utf8')).autoSwitch,
    true,
    'the older file is left as it was',
  );
  // Without a file (an in-memory engine) the setting lives in memory only.
  const memory = new AccountUsageService({ home: join(root, 'home') });
  assert.deepEqual(memory.setSettings({ usageLookup: true }), { usageLookup: true });
  assert.deepEqual(memory.settings(), { usageLookup: true });
});

test('subscription limit messages of both CLIs are recognised', () => {
  for (const text of [
    'Claude AI usage limit reached|1791066305',
    "You've hit your usage limit. Upgrade to Pro",
    '5-hour limit reached ∙ resets 3pm',
    'usage_limit_reached',
    'Rate limit exceeded (429)',
  ])
    assert.match(text, USAGE_LIMIT);
  assert.doesNotMatch('Compilation failed: unexpected token', USAGE_LIMIT);
});
