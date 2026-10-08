// The installed VIDE's Rhino connector after a real-host test (PLAN-48 T-241, AI.md §8): a test
// that registered the development build puts the installed engine's registration back
// (`POST /api/v1/connectors/rhino8/install`, then `GET /api/v1/connectors` must say `current`).
// While any Rhino runs the engine refuses (409 HOST_RUNNING) — the user's Rhino is never closed by a
// test — so the restore is then reported as pending with what to do, and the run ends with a
// non-zero exit code instead of passing quietly with the development build left registered.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** The installed engine's address and a session cookie (launch.json token); null when absent. */
async function installedSession() {
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
  return session.ok && cookie ? { origin, cookie } : { status: session.status };
}

/** The installed engine's rhino8 connector state (`current` = the installed build). */
async function rhinoPlugin({ origin, cookie }) {
  const list = await fetch(new URL('/api/v1/connectors', origin), {
    headers: { Origin: origin, Cookie: cookie },
    signal: AbortSignal.timeout(10000),
  });
  if (!list.ok) return null;
  const connectors = await list.json();
  return (
    (Array.isArray(connectors) ? connectors : []).find((c) => c.id === 'rhino8')?.plugin ?? null
  );
}

/**
 * Put the installed VIDE's Rhino plugin registration back. `restored` only when the engine then
 * says `current`; `pending` when a Rhino was running (the engine refused, nothing was closed).
 */
export async function restoreInstalledPlugin() {
  try {
    const session = await installedSession();
    if (!session.cookie) return { restored: false, status: session.status };
    const install = await fetch(new URL('/api/v1/connectors/rhino8/install', session.origin), {
      method: 'POST',
      headers: { Origin: session.origin, Cookie: session.cookie },
      signal: AbortSignal.timeout(60000),
    });
    const plugin = await rhinoPlugin(session).catch(() => null);
    if (install.status === 409)
      return {
        restored: plugin === 'current',
        pending: plugin !== 'current',
        status: 409,
        plugin,
        reason:
          'HOST_RUNNING — Rhino가 실행 중이라 설치 엔진이 커넥터를 되돌리지 않았습니다. Rhino를 모두 닫은 뒤 VIDE 설정의 커넥터 설치를 누르거나 POST /api/v1/connectors/rhino8/install을 부르세요(테스트는 사용자 Rhino를 끄지 않음).',
      };
    return { restored: install.ok && plugin === 'current', status: install.status, plugin };
  } catch (error) {
    return { restored: false, error: String(error) };
  }
}

/** Print the outcome; a registration not put back fails the run (exit code 3). */
export function reportRestore(result) {
  console.log('installed plugin registration: ' + JSON.stringify(result));
  if (result.restored) return;
  console.error(
    result.pending
      ? `설치 엔진의 Rhino 커넥터 되돌림 보류: ${result.reason}`
      : `설치 엔진의 Rhino 커넥터를 되돌리지 못했습니다(${result.plugin ?? result.status ?? result.error}). VIDE 설정에서 커넥터를 다시 설치하세요.`,
  );
  process.exitCode = process.exitCode || 3;
}

/** Whether a Rhino is running before the test starts its own (the restore will then be pending). */
export async function warnIfRhinoRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await exec(
      'tasklist',
      ['/FI', 'IMAGENAME eq Rhino.exe', '/FO', 'CSV', '/NH'],
      {
        windowsHide: true,
      },
    );
    const running = /"Rhino\.exe"/i.test(stdout);
    if (running)
      console.warn(
        '경고: Rhino가 이미 실행 중입니다. 이 시험은 그 Rhino에 붙거나 끄지 않지만, 끝난 뒤 설치 엔진의 커넥터 되돌림이 보류될 수 있습니다.',
      );
    return running;
  } catch {
    return false;
  }
}
