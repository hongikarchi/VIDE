import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// AccountSwitch, the program that adds, signs in and switches AI accounts (ADR-025). VIDE only
// sees whether it is installed and starts it on request (PLAN-38 T-175, SPEC-02.18 1); it never
// reads or changes AccountSwitch's own data.
export const ACCOUNT_SWITCH_DOWNLOAD =
  'https://github.com/hongikarchi/AccountSwitch/releases/latest';
type Env = Record<string, string | undefined>;

/** AccountSwitch's program file when installed (VIDE_ACCOUNTSWITCH_PATH, then its install). */
export function accountSwitchPath(env: Env = process.env, home = homedir()) {
  const candidate =
    env.VIDE_ACCOUNTSWITCH_PATH ||
    join(
      env.LOCALAPPDATA || join(home, 'AppData', 'Local'),
      'AccountSwitch.App',
      'AccountSwitch.exe',
    );
  try {
    return statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function accountSwitchInfo(env: Env = process.env) {
  return { installed: !!accountSwitchPath(env), download: ACCOUNT_SWITCH_DOWNLOAD };
}

/** Start AccountSwitch on its own (not a child that ends with VIDE). False when not installed. */
export function openAccountSwitch(env: Env = process.env, start: typeof spawn = spawn) {
  const path = accountSwitchPath(env);
  if (!path) return false;
  const child = start(path, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
  return true;
}
