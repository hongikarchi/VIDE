import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
const failure = code => Object.assign(new Error(code), { code });

/** Read-only OS evidence. Strings preserve .NET ticks beyond JS integer precision. */
export async function inspectWindowsProcess(pid, port) {
  if (process.platform !== 'win32') throw failure('HOST_PLATFORM_UNSUPPORTED');
  if (!Number.isSafeInteger(pid) || pid <= 0 ||
      (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))) {
    throw failure('INVALID_HOST_IDENTITY');
  }
  const script = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid}; ` +
    `$owners=@(${port === undefined ? '' : `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::','::ffff:127.0.0.1') } | Select-Object -ExpandProperty OwningProcess -Unique`}); ` +
    `[pscustomobject]@{pid=$p.Id;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=$p.Path;listeners=$owners}|ConvertTo-Json -Compress`;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10000, maxBuffer: 16384, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch { throw failure('HOST_IDENTITY_UNAVAILABLE'); }
}

/** Only a process created here receives a lease; existing user processes cannot be adopted. */
export async function launchOwnedRhino({ executable, args = [], environment = process.env, visible = false, spawnProcess = spawn,
  inspect = inspectWindowsProcess } = {}) {
  if (typeof executable !== 'string' || !isAbsolute(executable) || !Array.isArray(args) ||
      args.some(value => typeof value !== 'string')) throw failure('INVALID_HOST_LAUNCH');
  const child = spawnProcess(executable, args, { env: environment, shell: false, windowsHide: !visible, stdio: 'ignore' });
  let exited = false;
  child.once('exit', () => { exited = true; });
  // Keep an error listener after spawn too; no automatic relaunch or process adoption.
  child.on('error', () => { exited = true; });
  await new Promise((accept, reject) => {
    child.once('spawn', accept);
    child.once('error', () => reject(failure('HOST_LAUNCH_FAILED')));
  });
  const identity = await inspect(child.pid);
  const pathKey = value => typeof value === 'string' ? resolve(value).toLowerCase() : '';
  if (identity.pid !== child.pid || !/^\d+$/.test(identity.startTicks) ||
      pathKey(identity.executable) !== pathKey(executable) || exited) throw failure('HOST_OWNERSHIP_MISMATCH');
  const expected = Object.freeze({ pid: identity.pid, startTicks: identity.startTicks,
    executable: identity.executable, sessionId: randomUUID() });
  let revoked = false;
  return Object.freeze({
    identity: expected,
    revoke() { revoked = true; },
    async stop() {
      revoked = true;
      if (exited) return;
      const observed = await inspect(expected.pid);
      if (observed.pid !== expected.pid || observed.startTicks !== expected.startTicks ||
          pathKey(observed.executable) !== pathKey(expected.executable)) throw failure('HOST_OWNERSHIP_MISMATCH');
      if (exited) return;
      await new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(failure('HOST_STOP_UNCONFIRMED')), 5000);
        child.once('exit', () => { clearTimeout(timer); accept(); });
        if (!child.kill()) { clearTimeout(timer); reject(failure('HOST_STOP_UNCONFIRMED')); }
      });
    },
    async verify(port) {
      if (revoked || exited) throw failure('HOST_LEASE_EXPIRED');
      const observed = await inspect(expected.pid, port);
      if (revoked || exited) throw failure('HOST_LEASE_EXPIRED');
      if (observed.pid !== expected.pid || observed.startTicks !== expected.startTicks ||
          pathKey(observed.executable) !== pathKey(expected.executable) ||
          !Array.isArray(observed.listeners) || observed.listeners.length !== 1 ||
          observed.listeners[0] !== expected.pid) throw failure('HOST_OWNERSHIP_MISMATCH');
      return expected;
    },
  });
}
