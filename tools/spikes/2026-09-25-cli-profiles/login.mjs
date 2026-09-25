import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AccountProfiles } from '../../../src/ai/account-profiles.ts';
import { installedCodex } from '../../../src/ai/paths.ts';
import { codexEnvironment } from '../../../src/ai/codex-cli.ts';
if (!process.env.LOCALAPPDATA) throw Error('LOCAL_APP_DATA_REQUIRED');
const profiles = new AccountProfiles(
  join(process.env.LOCALAPPDATA, 'VIDE', 'cli-profiles'),
  () => false,
);
const row =
  profiles.list().profiles.find((p) => p.provider === 'codex-cli' && p.label === 'ChatGPT 2') ??
  profiles.add('codex-cli', 'ChatGPT 2');
const directory = profiles.directory('codex-cli', row.id);
const executable = installedCodex();
if (!executable) throw Error('CLI_UNAVAILABLE');
const child = spawn(
  executable,
  ['login', '-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"'],
  {
    env: { ...codexEnvironment(), CODEX_HOME: directory },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let reported = false;
const receive = () => {
  if (!reported) {
    reported = true;
    console.log('Official Codex login started. Complete the second account login in the browser.');
  }
};
child.stdout.on('data', receive);
child.stderr.on('data', receive);
const timer = setTimeout(() => {
  child.kill();
  console.log('Login timed out; account is not selected.');
}, 300000);
child.on('error', () => {
  clearTimeout(timer);
  process.exitCode = 1;
  console.log('LOGIN_START_FAILED');
});
child.on('close', (code) => {
  clearTimeout(timer);
  console.log(code === 0 ? 'LOGIN_COMPLETED' : 'LOGIN_NOT_COMPLETED');
  process.exitCode = code === 0 ? 0 : 1;
});
