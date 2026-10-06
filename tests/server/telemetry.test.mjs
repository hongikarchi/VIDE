// ADR-036, PLAN-34 T-156: nothing leaves the PC before the user agrees or after they decline;
// agreed reports cover lines after the agreement only, wait in the outbox while the site cannot be
// reached and go on the next round; a crash asks once and a bundle goes only when asked to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Telemetry } from '../../src/server/telemetry.ts';
import { startServer } from '../../src/server/server.ts';

const SITE = 'https://site.test';
function harness(directory, { prompt = true } = {}) {
  let now = new Date('2026-10-06T00:00:00.000Z');
  const sent = [];
  let answer = () => new Response('{"id":"x"}', { status: 201 });
  const telemetry = new Telemetry({
    directory,
    prompt,
    site: () => SITE,
    version: () => '0.2.21',
    now: () => now,
    fetcher: async (url, init) => {
      sent.push({ url: String(url), init });
      return answer(url, init);
    },
    startDelayMs: 60_000,
    everyMs: 3_600_000,
  });
  return {
    telemetry,
    sent,
    advance: (ms) => (now = new Date(now.getTime() + ms)),
    at: () => now.toISOString(),
    answer: (next) => (answer = next),
  };
}
const logLine = async (directory, at, fields) => {
  await mkdir(join(directory, 'logs'), { recursive: true });
  await writeFile(
    join(directory, 'logs', `engine-${at.slice(0, 10)}.jsonl`),
    JSON.stringify({ at, v: '0.2.21', sid: 's', ...fields }) + '\n',
    { flag: 'a' },
  );
};

test('nothing is sent before the user answers, and the first-run card asks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-telemetry-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = harness(directory);
  await logLine(directory, h.at(), { event: 'server-error', code: 'X' });
  const view = await h.telemetry.view();
  assert.equal(view.consent, null);
  assert.equal(view.prompt, true);
  h.advance(2 * 86_400_000);
  await h.telemetry.tick(true);
  await h.telemetry.tick(false);
  assert.equal(await h.telemetry.batch(), undefined);
  assert.deepEqual(await h.telemetry.flushOutbox(), { sent: 0 });
  assert.equal(h.sent.length, 0);
  assert.equal(existsSync(join(directory, 'telemetry-outbox')), false);
  // A remote device never sees the card; a non-desktop engine neither.
  assert.equal((await h.telemetry.view(false)).prompt, false);
  assert.equal((await harness(directory, { prompt: false }).telemetry.view()).prompt, false);
});

test('agreeing sends only what happened after it; declining stops and removes what waits', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-telemetry-send-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = harness(directory);
  await logLine(directory, h.at(), { event: 'server-error', code: 'BEFORE_CONSENT' });
  h.advance(1000);
  const granted = await h.telemetry.set('granted');
  assert.equal(granted.consent, 'granted');
  assert.equal(granted.prompt, false);
  assert.match(granted.installId, /^[0-9a-f-]{36}$/);
  await h.telemetry.close(); // the test drives rounds itself
  h.advance(1000);
  await logLine(directory, h.at(), { event: 'server-error', code: 'AFTER_CONSENT' });
  // Not due yet (the start round needs an hour since the agreement).
  await h.telemetry.tick(true);
  assert.equal(h.sent.length, 0);
  h.advance(2 * 3_600_000);
  await h.telemetry.tick(true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].url, `${SITE}/api/telemetry/reports`);
  assert.equal(h.sent[0].init.headers['Content-Type'], 'application/json');
  assert.equal(h.sent[0].init.headers.Cookie, undefined);
  const report = JSON.parse(h.sent[0].init.body);
  assert.equal(report.installId, granted.installId);
  assert.equal(report.version, '0.2.21');
  assert.equal(report.kind, 'summary');
  const codes = report.payload.errors.map((error) => error.fields.code);
  assert.deepEqual(codes, ['AFTER_CONSENT']);
  assert.ok(report.payload.os && report.payload.memoryGB >= 0);
  assert.equal((await h.telemetry.view()).lastSentAt, h.at());
  // The next daily round: nothing new is due within the day.
  h.advance(3_600_000);
  await h.telemetry.tick(false);
  assert.equal(h.sent.length, 1);
  // Declining: a batch made while offline is removed and nothing goes.
  h.answer(() => {
    throw new TypeError('fetch failed');
  });
  h.advance(86_400_000);
  await logLine(directory, h.at(), { event: 'server-error', code: 'LATER' });
  await h.telemetry.tick(false);
  assert.equal((await readdir(join(directory, 'telemetry-outbox'))).length, 1);
  await h.telemetry.set('denied');
  assert.equal(existsSync(join(directory, 'telemetry-outbox')), false);
  h.answer(() => new Response('{}', { status: 201 }));
  const before = h.sent.length;
  h.advance(3 * 86_400_000);
  await h.telemetry.tick(true);
  await h.telemetry.tick(false);
  assert.equal(await h.telemetry.batch(), undefined);
  assert.equal(h.sent.length, before);
  await h.telemetry.close();
});

test('offline batches wait and go together later; a refused one is dropped, a limited one kept', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-telemetry-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = harness(directory);
  await h.telemetry.set('granted');
  await h.telemetry.close();
  let calls = 0;
  h.answer(() => {
    calls++;
    throw new TypeError('fetch failed');
  });
  for (let day = 0; day < 3; day++) {
    h.advance(86_400_000);
    await logLine(directory, h.at(), { event: 'api-error', code: `DAY_${day}`, status: 500 });
    await h.telemetry.tick(false);
  }
  assert.equal((await readdir(join(directory, 'telemetry-outbox'))).length, 3);
  assert.equal(calls, 3, 'one try a round, stopping at the first failure');
  assert.match((await h.telemetry.view()).lastError, /NETWORK/);
  // Rate limited: kept for later.
  h.answer(() => new Response('{"error":"RATE_LIMITED"}', { status: 429 }));
  await h.telemetry.flushOutbox();
  assert.equal((await readdir(join(directory, 'telemetry-outbox'))).length, 3);
  // Back online: every waiting batch goes, oldest first.
  const order = [];
  h.answer((url, init) => {
    order.push(JSON.parse(init.body).payload.errors[0].fields.code);
    return new Response('{}', { status: 201 });
  });
  assert.deepEqual(await h.telemetry.flushOutbox(), { sent: 3 });
  assert.deepEqual(order, ['DAY_0', 'DAY_1', 'DAY_2']);
  assert.equal((await readdir(join(directory, 'telemetry-outbox'))).length, 0);
  // A batch the site refuses for its content is dropped instead of being retried forever.
  h.advance(86_400_000);
  await logLine(directory, h.at(), { event: 'api-error', code: 'REFUSED', status: 500 });
  h.answer(() => new Response('{"error":"REPORT_REJECTED"}', { status: 422 }));
  await h.telemetry.tick(false);
  assert.equal((await readdir(join(directory, 'telemetry-outbox'))).length, 0);
  assert.equal((await h.telemetry.view()).lastError, 'HTTP 422');
});

test('a crash asks once; a bundle goes only when asked, and the site switch can refuse it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-telemetry-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = harness(directory);
  await mkdir(join(directory, 'logs'), { recursive: true });
  const exit = (at, code, asked) =>
    JSON.stringify({
      at,
      event: 'engine-exit',
      pid: 1,
      code,
      hex: '0xC0000409',
      uptimeSec: 30,
      asked,
    });
  await writeFile(
    join(directory, 'logs', 'engine-exits.jsonl'),
    [
      exit('2026-10-05T23:00:00.000Z', -1073740791, false),
      exit('2026-10-05T23:30:00.000Z', 0, true),
    ].join('\n') + '\n',
  );
  await logLine(directory, '2026-10-05T23:00:00.000Z', { event: 'engine-start' });
  // Not before the first-run card is answered (one card at a time).
  assert.equal((await h.telemetry.view()).crash, undefined);
  await h.telemetry.set('denied');
  const view = await h.telemetry.view();
  assert.deepEqual(view.crash, {
    at: '2026-10-05T23:00:00.000Z',
    code: -1073740791,
    hex: '0xC0000409',
  });
  // [보내지 않음]: answered, nothing sent, not asked again.
  assert.deepEqual(await h.telemetry.answerCrash(false), { sent: false, reason: 'DECLINED' });
  assert.equal((await h.telemetry.view()).crash, undefined);
  assert.equal(h.sent.length, 0);
  // A new crash: [보내기] with the site switch off makes the bundle and says so.
  await writeFile(
    join(directory, 'logs', 'engine-exits.jsonl'),
    exit('2026-10-06T00:00:00.000Z', -1073741819, false) + '\n',
    { flag: 'a' },
  );
  assert.ok((await h.telemetry.view()).crash);
  h.answer(() => new Response('{"error":"BUNDLES_DISABLED"}', { status: 503 }));
  const result = await h.telemetry.answerCrash(true);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'BUNDLES_DISABLED');
  assert.ok(existsSync(result.file));
  const call = h.sent.at(-1);
  assert.equal(call.url, `${SITE}/api/telemetry/bundles`);
  assert.equal(call.init.headers['Content-Type'], 'application/zip');
  assert.equal(call.init.headers['X-Vide-Dumps'], '0');
  assert.equal((await h.telemetry.view()).crash, undefined);
  // Switch on: sent.
  await writeFile(
    join(directory, 'logs', 'engine-exits.jsonl'),
    exit('2026-10-06T00:00:01.000Z', 1, false) + '\n',
    { flag: 'a' },
  );
  h.answer(() => new Response('{"id":"b"}', { status: 201 }));
  assert.equal((await h.telemetry.answerCrash(true)).sent, true);
  // Exits VIDE asked for, clean ends and kills are not crashes.
  await writeFile(
    join(directory, 'logs', 'engine-exits.jsonl'),
    [
      exit('2026-10-06T00:00:02.000Z', -1, false),
      exit('2026-10-06T00:00:03.000Z', -1073741510, false),
    ].join('\n') + '\n',
    { flag: 'a' },
  );
  assert.equal((await h.telemetry.view()).crash, undefined);
});

test('the engine routes: state for any page, the choice and the preview only on this PC', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-telemetry-http-'));
  const sent = [];
  const app = await startServer({
    filename: join(directory, 'vide.sqlite'),
    telemetryOptions: {
      prompt: true,
      site: () => SITE,
      fetcher: async (url, init) => {
        sent.push(String(url));
        return new Response('{}', { status: 201 });
      },
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
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
  const state = await (await fetch(app.origin + '/api/v1/telemetry', { headers })).json();
  assert.equal(state.consent, null);
  assert.equal(state.prompt, true);
  assert.equal(state.site, SITE);
  const bad = await fetch(app.origin + '/api/v1/telemetry', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ consent: 'yes' }),
  });
  assert.equal(bad.status, 400);
  const agreed = await (
    await fetch(app.origin + '/api/v1/telemetry', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ consent: 'granted' }),
    })
  ).json();
  assert.equal(agreed.consent, 'granted');
  const stored = JSON.parse(await readFile(join(directory, 'telemetry.json'), 'utf8'));
  assert.equal(stored.consent, 'granted');
  assert.equal(stored.installId, agreed.installId);
  const preview = await (await fetch(app.origin + '/api/v1/telemetry/preview', { headers })).json();
  assert.equal(preview.kind, 'summary');
  assert.equal(preview.installId, agreed.installId);
  assert.ok(preview.payload.counts);
  assert.equal(sent.length, 0, 'the preview is never sent');
  const declined = await (
    await fetch(app.origin + '/api/v1/telemetry', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ consent: 'denied' }),
    })
  ).json();
  assert.equal(declined.consent, 'denied');
  assert.equal(declined.prompt, false);
});
