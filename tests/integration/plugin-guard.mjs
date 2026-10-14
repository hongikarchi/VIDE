// Guard for real-host tests that LoadPlugIn the DEVELOPMENT Rhino plugin (PLAN-51 T-297).
// `LoadPlugIn` rewrites the person's Rhino registration (HKCU ... Plug-ins\<VIDE id>\PlugIn
// FileName) to `.vide/build/...`; their own Rhino then loads the dev build. Every such script runs
// its body inside `withInstalledPluginRestored(fn)`: the FileName is recorded before, and in
// `finally` the installed engine is asked to put its connector back (POST
// /api/v1/connectors/rhino8/install); when that is unreachable or refused, the recorded FileName is
// written back to the registry. What it did is logged; a registration still on a dev build fails
// the run (exit code 3). `tools/checks/plugin-registration.mjs` checks the same at the end of verify.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { restoreInstalledPlugin } from './installed-connector.mjs';

const exec = promisify(execFile);

export const PLUGIN_KEY =
  'HKCU\\Software\\McNeel\\Rhinoceros\\8.0\\Plug-ins\\6bde756c-cb1f-45bc-90fa-784c098c2c38\\PlugIn';

/** Whether a plugin path is a development build of a checkout (`.vide/build/...`). */
export function isDevBuild(path) {
  return typeof path === 'string' && /(^|[\\/])\.vide[\\/]build[\\/]/i.test(path);
}

const same = (a, b) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/** The registered FileName of the VIDE Rhino plugin; null when absent or not on Windows. */
export async function readRegisteredPlugin() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await exec('reg', ['query', PLUGIN_KEY, '/v', 'FileName'], {
      windowsHide: true,
    });
    return /FileName\s+REG_SZ\s+(.+)/.exec(stdout)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

/** Write the FileName back (registry fallback when the installed engine cannot restore it). */
export async function writeRegisteredPlugin(path) {
  await exec('reg', ['add', PLUGIN_KEY, '/v', 'FileName', '/t', 'REG_SZ', '/d', path, '/f'], {
    windowsHide: true,
  });
}

const defaults = {
  read: readRegisteredPlugin,
  write: writeRegisteredPlugin,
  engineRestore: restoreInstalledPlugin,
  log: (line) => console.log('[plugin-guard] ' + line),
  fail: () => {
    process.exitCode = process.exitCode || 3;
  },
};

/**
 * Put the registration back to `before` (the FileName recorded before the test). Returns
 * `{ action, before, after, now }` where action is `unchanged` | `engine` | `registry` | `failed`.
 */
export async function restorePluginRegistration(before, deps = {}) {
  const { read, write, engineRestore, log, fail } = { ...defaults, ...deps };
  const after = await read().catch(() => null);
  if (same(after, before) && !isDevBuild(after)) {
    log(`registration unchanged: ${after ?? '(none)'}`);
    return { action: 'unchanged', before, after, now: after };
  }
  log(`registration changed: ${before ?? '(none)'} -> ${after ?? '(none)'}`);
  let engine;
  try {
    engine = await engineRestore();
  } catch (error) {
    engine = { restored: false, error: String(error) };
  }
  let now = await read().catch(() => null);
  if (engine?.restored && !isDevBuild(now)) {
    log(`restored by the installed engine (install ${engine.status ?? 'ok'}): ${now}`);
    return { action: 'engine', before, after, now, engine };
  }
  log(`installed engine did not restore it (${JSON.stringify(engine)})`);
  if (before && !isDevBuild(before)) {
    try {
      await write(before);
      now = await read().catch(() => null);
    } catch (error) {
      log(`registry write failed: ${error}`);
    }
    if (same(now, before)) {
      log(`restored the recorded FileName in the registry: ${now}`);
      return { action: 'registry', before, after, now, engine };
    }
  }
  log(
    `NOT restored: FileName=${now ?? '(none)'}. VIDE 설정에서 Rhino 커넥터를 다시 설치하거나 Rhino를 모두 닫고 POST /api/v1/connectors/rhino8/install을 부르세요.`,
  );
  fail();
  return { action: 'failed', before, after, now, engine };
}

/** Run `fn` (a test body that loads the dev plugin) and always put the registration back. */
export async function withInstalledPluginRestored(fn, deps = {}) {
  const { read, log } = { ...defaults, ...deps };
  const before = await read().catch(() => null);
  log(`registration before: ${before ?? '(none)'}`);
  if (isDevBuild(before))
    log('warning: the registration already points at a development build before this run');
  try {
    return await fn();
  } finally {
    await restorePluginRegistration(before, deps);
  }
}
