// The installed VIDE engine's connector status (GET /api/v1/connectors) through the launch.json
// session, as tests/integration/rhino-site-bake.mjs does. `--install` also calls
// POST /api/v1/connectors/rhino8/install (the engine refuses while any Rhino runs). The session
// token is never printed.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function installedConnectors({ install = false } = {}) {
  const launch = JSON.parse(
    await readFile(join(process.env.LOCALAPPDATA ?? '', 'VIDE', 'launch.json'), 'utf8'),
  );
  const url = new URL(launch.url);
  const origin = url.origin;
  const session = await fetch(new URL('/api/v1/session', origin), {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: url.hash.slice(1) }),
    signal: AbortSignal.timeout(5000),
  });
  const cookie = session.headers.get('set-cookie')?.split(';')[0];
  if (!session.ok || !cookie) return { ok: false, status: session.status };
  const headers = { Origin: origin, Cookie: cookie };
  let installed;
  if (install) {
    const r = await fetch(new URL('/api/v1/connectors/rhino8/install', origin), {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(60000),
    });
    installed = { status: r.status, body: r.ok ? 'ok' : await r.text() };
  }
  const list = await fetch(new URL('/api/v1/connectors', origin), {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  const body = await list.json();
  const connectors = (body.connectors ?? body).map((c) => ({
    id: c.id,
    plugin: c.plugin,
    running: c.running,
    version: c.version,
    path: c.path,
  }));
  return { ok: list.ok, installed, connectors };
}

if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/')}`)
  console.log(
    JSON.stringify(await installedConnectors({ install: process.argv.includes('--install') })),
  );
