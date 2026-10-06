import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  claudeExecutable,
  codexExecutable,
  launchTarget,
  launchable,
  onPath,
} from '../../src/ai/paths.ts';
import { defaultLogin } from '../../src/ai/account-usage.ts';
import { accountSwitchInfo, accountSwitchPath } from '../../src/ai/account-switch.ts';

// PLAN-38 T-175: VIDE finds the CLIs where AccountSwitch does (the setting, VIDE_*_PATH, the
// official install, the npm global install, then PATH), starts npm's `.cmd` shims on Node, reads
// the login from CLAUDE_CONFIG_DIR / CODEX_HOME when the PC sets them, and sees AccountSwitch.
const touch = async (path, text = '') => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};
async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'vide-cli-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const env = {
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: [join(root, 'path-a'), join(root, 'path-b')].join(delimiter),
  };
  return { root, home, env };
}

test('Claude is found in order: VIDE_CLAUDE_PATH, native, npm, PATH', async (t) => {
  const { root, home, env } = await sandbox(t);
  const native = join(home, '.local', 'bin', 'claude.exe');
  const npm = join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
  // Nothing installed: the native place (so the error names a real location).
  assert.equal(claudeExecutable(env, home), native);
  // PATH: the first folder wins, and `.exe` before `.cmd` within a folder.
  await touch(join(root, 'path-b', 'claude.exe'));
  await touch(join(root, 'path-a', 'claude.cmd'));
  assert.equal(claudeExecutable(env, home), join(root, 'path-a', 'claude.cmd'));
  await touch(join(root, 'path-a', 'claude.exe'));
  assert.equal(claudeExecutable(env, home), join(root, 'path-a', 'claude.exe'));
  // The npm global install beats PATH: its `cli.js`, then its native binary.
  await touch(join(npm, 'cli.js'));
  assert.equal(claudeExecutable(env, home), join(npm, 'cli.js'));
  await touch(join(npm, 'bin', 'claude.exe'));
  assert.equal(claudeExecutable(env, home), join(npm, 'bin', 'claude.exe'));
  // The native install beats npm; VIDE_CLAUDE_PATH beats everything.
  await touch(native);
  assert.equal(claudeExecutable(env, home), native);
  assert.equal(
    claudeExecutable({ ...env, VIDE_CLAUDE_PATH: 'C:\\x\\claude.exe' }, home),
    'C:\\x\\claude.exe',
  );
});

test('Codex is found in order: VIDE_CODEX_PATH, npm native, the Codex app, PATH', async (t) => {
  const { root, home, env } = await sandbox(t);
  assert.equal(codexExecutable(env, home), undefined);
  await touch(join(root, 'path-b', 'codex.cmd'));
  assert.equal(codexExecutable(env, home), join(root, 'path-b', 'codex.cmd'));
  const app = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', '1.0.0', 'codex.exe');
  await touch(app);
  assert.equal(codexExecutable(env, home), app);
  const npm = join(
    env.APPDATA,
    ...'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'.split(
      '/',
    ),
  );
  await touch(npm);
  assert.equal(codexExecutable(env, home), npm);
  assert.equal(codexExecutable({ ...env, VIDE_CODEX_PATH: 'C:\\c.exe' }, home), 'C:\\c.exe');
  assert.equal(onPath(['nothing.exe'], env), undefined);
});

test('npm shims and scripts start on Node; anything else is spawned as it is', async (t) => {
  const { root } = await sandbox(t);
  const bin = join(root, 'npm');
  const script = join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  await touch(script);
  // npm's shim: the optional local node.exe first, then the target script.
  await touch(
    join(bin, 'claude.cmd'),
    '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
  );
  assert.deepEqual(launchTarget(join(bin, 'claude.cmd'), 'NODE'), {
    command: 'NODE',
    prefix: [script],
  });
  assert.deepEqual(launchTarget(script, 'NODE'), { command: 'NODE', prefix: [script] });
  // A shim naming a native program runs that program.
  const native = join(bin, 'node_modules', '@openai', 'codex', 'codex.exe');
  await touch(native);
  await touch(join(bin, 'codex.cmd'), `"%~dp0\\node_modules\\@openai\\codex\\codex.exe" %*`);
  assert.deepEqual(launchTarget(join(bin, 'codex.cmd'), 'NODE'), { command: native, prefix: [] });
  // An unreadable shim goes through the shell.
  await touch(join(bin, 'odd.cmd'), 'echo hi');
  assert.deepEqual(launchTarget(join(bin, 'odd.cmd'), 'NODE'), {
    command: join(bin, 'odd.cmd'),
    prefix: [],
    shell: true,
  });
  assert.deepEqual(launchTarget('C:\\x\\claude.exe', 'NODE'), {
    command: 'C:\\x\\claude.exe',
    prefix: [],
  });
  // The spawn wrapper passes the arguments after the script.
  const calls = [];
  const spawn = launchable((command, args, options) => calls.push({ command, args, options }));
  spawn(join(bin, 'claude.cmd'), ['--version'], { windowsHide: true });
  spawn('C:\\x\\claude.exe', ['-p'], {});
  spawn(join(bin, 'odd.cmd'), ['a'], {});
  assert.deepEqual(calls[0], {
    command: process.execPath,
    args: [script, '--version'],
    options: { windowsHide: true },
  });
  assert.deepEqual(calls[1], { command: 'C:\\x\\claude.exe', args: ['-p'], options: {} });
  assert.equal(calls[2].options.shell, true);
});

test('the login is read from CLAUDE_CONFIG_DIR / CODEX_HOME when the PC sets them', async (t) => {
  const { root, home } = await sandbox(t);
  const credentials = (token) => JSON.stringify({ claudeAiOauth: { accessToken: token } });
  await touch(join(home, '.claude', '.credentials.json'), credentials('home-token'));
  await touch(
    join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'home@x' } }),
  );
  const folder = join(root, 'claude-profile');
  await touch(join(folder, '.credentials.json'), credentials('profile-token'));
  await touch(
    join(folder, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'profile@x' } }),
  );
  assert.equal(defaultLogin('claude-cli', home, {}).email, 'home@x');
  const chosen = defaultLogin('claude-cli', home, { CLAUDE_CONFIG_DIR: folder });
  assert.equal(chosen.email, 'profile@x');
  assert.equal(chosen.token, 'profile-token');
  const codexHome = join(root, 'codex-home');
  const jwt = (claims) =>
    ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'x'].join('.');
  await touch(
    join(codexHome, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: jwt({}),
        account_id: 'acc',
        id_token: jwt({ email: 'codex@x' }),
      },
    }),
  );
  assert.equal(defaultLogin('codex-cli', home, {}).token, undefined);
  assert.equal(defaultLogin('codex-cli', home, { CODEX_HOME: codexHome }).email, 'codex@x');
});

test('AccountSwitch is seen when installed, else its download link is given', async (t) => {
  const { env } = await sandbox(t);
  assert.equal(accountSwitchPath(env), undefined);
  assert.deepEqual(accountSwitchInfo(env), {
    installed: false,
    download: 'https://github.com/hongikarchi/AccountSwitch/releases/latest',
  });
  const program = join(env.LOCALAPPDATA, 'AccountSwitch.App', 'AccountSwitch.exe');
  await touch(program);
  assert.equal(accountSwitchPath(env), program);
  assert.equal(accountSwitchInfo(env).installed, true);
});
