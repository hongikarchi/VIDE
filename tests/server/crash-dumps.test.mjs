// T-191: ProcDump dumps crashes only (no termination dump on a normal quit), a diagnostic bundle
// holds the newest dump only and only when asked, and a dump over the site's limit is never sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDumps, writeDiagnosticBundle } from '../../src/server/diagnostic-bundle.ts';
import {
  BUNDLE_MAX_BYTES,
  BUNDLE_WITH_DUMP_MAX_BYTES,
  dumpSendable,
  Telemetry,
} from '../../src/server/telemetry.ts';
import { startServer } from '../../src/server/server.ts';

const SITE = 'https://site.test';
const source = (name) =>
  readFile(new URL(`../../src/desktop/shell/${name}`, import.meta.url), 'utf8');

// The desktop shell cannot run here; these source checks keep ProcDump's arguments in place.
test('ProcDump watches unhandled exceptions with full dumps and no termination monitor', async () => {
  const dumps = await source('CrashDumps.cs');
  const args = /Arguments\(int pid, string folder\) =>\s*"([^"]*)"/.exec(dumps)?.[1];
  assert.ok(args, 'one Arguments() builds the command line');
  const flags = args.trim().split(/\s+/);
  assert.ok(flags.includes('-e'), 'unhandled exceptions, the 0xC0000409 fail-fast included');
  assert.ok(flags.includes('-ma'), 'full dumps');
  assert.ok(!flags.includes('-t'), 'no dump on a normal quit');
  assert.ok(!/"-accepteula[^"]*-t\b/.test(dumps), 'no other command line with -t');
  assert.ok(dumps.includes('new ProcessStartInfo(tool, Arguments(pid, Folder))'));
  assert.ok(dumps.includes('private const int Keep = 3;'));
  // The asked-stop marker served termination dumps only; nothing writes it any more.
  assert.ok(!(await source('Engine.cs')).includes('MarkAskedStop'));
});

async function dataFolder(dumps) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-dumps-'));
  await mkdir(join(directory, 'logs'));
  await mkdir(join(directory, 'crashdumps'));
  await writeFile(join(directory, 'logs', 'procdump.log'), 'Unhandled: C0000409\n');
  for (const [name, bytes, minutes] of dumps) {
    const file = join(directory, 'crashdumps', name);
    const handle = await open(file, 'w');
    await handle.truncate(bytes);
    await handle.close();
    const at = new Date(Date.UTC(2026, 9, 6, 0, minutes));
    await utimes(file, at, at);
  }
  return directory;
}

test('a bundle holds no dump unless asked, and then only the newest one', async (t) => {
  const directory = await dataFolder([
    ['node.exe_old.dmp', 3000, 1],
    ['node.exe_new.dmp', 2000, 30],
    ['node.exe_mid.dmp', 1000, 10],
  ]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(
    (await listDumps(directory)).map((dump) => dump.name),
    ['node.exe_new.dmp', 'node.exe_mid.dmp', 'node.exe_old.dmp'],
  );
  const without = await writeDiagnosticBundle({ directory });
  assert.ok(!without.files.some((name) => name.startsWith('crashdumps/')));
  const withDump = await writeDiagnosticBundle({ directory, dumps: true });
  assert.deepEqual(
    withDump.files.filter((name) => name.startsWith('crashdumps/')),
    ['crashdumps/node.exe_new.dmp'],
  );
  assert.ok(withDump.files.includes('logs/procdump.log'));
});

test('a dump over the site limit stays on the PC; the logs are still sent', async (t) => {
  assert.equal(dumpSendable(BUNDLE_WITH_DUMP_MAX_BYTES - BUNDLE_MAX_BYTES), true);
  assert.equal(dumpSendable(BUNDLE_WITH_DUMP_MAX_BYTES - BUNDLE_MAX_BYTES + 1), false);
  const directory = await dataFolder([['node.exe_big.dmp', 230 * 1024 * 1024, 5]]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sent = [];
  const telemetry = new Telemetry({
    directory,
    prompt: false,
    site: () => SITE,
    version: () => '0.2.28',
    fetcher: async (url, init) => {
      sent.push({ url: String(url), init });
      return new Response('{"id":"b"}', { status: 201 });
    },
    startDelayMs: 60_000,
  });
  await telemetry.set('granted');
  const result = await telemetry.answerCrash(true, true);
  assert.equal(result.sent, true);
  assert.equal(result.dumpSkipped, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.headers['X-Vide-Dumps'], '0');
  assert.ok(sent[0].init.body.length < BUNDLE_MAX_BYTES);
});

test('GET /diagnostics/bundle tells the newest dump size and whether it can be sent', async (t) => {
  const directory = await dataFolder([
    ['node.exe_a.dmp', 1000, 1],
    ['node.exe_b.dmp', 120 * 1024 * 1024, 2],
  ]);
  const app = await startServer({
    filename: join(directory, 'vide.sqlite'),
    telemetryOptions: { prompt: false, site: () => SITE, fetcher: async () => new Response('{}') },
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
  const headers = { Origin: app.origin, Cookie: login.headers.get('set-cookie').split(';')[0] };
  const { dump } = await (
    await fetch(app.origin + '/api/v1/diagnostics/bundle', { headers })
  ).json();
  assert.equal(dump.bytes, 120 * 1024 * 1024);
  assert.equal(dump.sendable, false);
});
