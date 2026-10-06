import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Where the AI CLIs are (PLAN-38 T-175, ARCH-01 §7): the same order AccountSwitch uses, so a PC
// whose CLI AccountSwitch finds is found here too: the setting, VIDE_*_PATH, the official native
// install, the npm global install, then PATH.
type Env = Record<string, string | undefined>;
const roaming = (env: Env, home: string) => env.APPDATA || join(home, 'AppData', 'Roaming');
const local = (env: Env, home: string) => env.LOCALAPPDATA || join(home, 'AppData', 'Local');
const file = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The first of `names` in a PATH folder (folders in order, then names in order per folder). */
export function onPath(names: readonly string[], env: Env = process.env) {
  const value = env.PATH ?? env.Path ?? env.path ?? '';
  for (const folder of value.split(delimiter)) {
    const directory = folder.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (file(candidate)) return resolve(candidate);
    }
  }
  return undefined;
}

export function installedCodex(env: Env = process.env, home = homedir()) {
  const npm = join(
    roaming(env, home),
    'npm',
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe',
  );
  if (existsSync(npm)) return npm;
  const directory = join(local(env, home), 'OpenAI', 'Codex', 'bin');
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9._-]+$/.test(entry.name))
      .slice(0, 200)
      .map((entry) => join(directory, entry.name, 'codex.exe'))
      .filter(existsSync)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

/** Claude Code's native install, then its npm global install (native binary, then `cli.js`). */
export function installedClaude(env: Env = process.env, home = homedir()) {
  const npm = join(roaming(env, home), 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
  return [
    join(home, '.local', 'bin', 'claude.exe'),
    join(npm, 'bin', 'claude.exe'),
    join(npm, 'cli.js'),
  ].find(file);
}

/** Claude Code's executable: VIDE_CLAUDE_PATH, the installs, then PATH (`claude.exe`, `.cmd`). */
export function claudeExecutable(env: Env = process.env, home = homedir()) {
  return (
    env.VIDE_CLAUDE_PATH ||
    installedClaude(env, home) ||
    onPath(['claude.exe', 'claude.cmd'], env) ||
    // Nothing found: the native place, so the error names a real install location.
    join(home, '.local', 'bin', 'claude.exe')
  );
}

/** Codex CLI's executable: VIDE_CODEX_PATH, the installs, then PATH (`codex.exe`, `.cmd`). */
export function codexExecutable(env: Env = process.env, home = homedir()) {
  return (
    env.VIDE_CODEX_PATH || installedCodex(env, home) || onPath(['codex.exe', 'codex.cmd'], env)
  );
}

/**
 * How to start an executable that may be a Node script or an npm `.cmd` shim (Node cannot spawn a
 * `.cmd` without a shell): a `.js` runs on this Node; a shim runs the script it names on this Node;
 * an unreadable shim runs through the shell.
 */
export function launchTarget(
  executable: string,
  nodePath = process.execPath,
): { command: string; prefix: string[]; shell?: boolean } {
  const extension = extname(executable).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(extension))
    return { command: nodePath, prefix: [executable] };
  if (extension === '.cmd' || extension === '.bat') {
    try {
      const text = readFileSync(executable, 'utf8');
      // npm's shim names its target after %dp0% (the shim's folder); `"%dp0%\node.exe"` is
      // the optional local Node, not the target.
      for (const match of text.matchAll(/"%~?dp0%?\\?([^"%]+\.(?:c|m)?js|[^"%]+\.exe)"/gi)) {
        const target = join(dirname(executable), match[1]);
        if (/(^|\\)node\.exe$/i.test(match[1]) || !file(target)) continue;
        return /\.exe$/i.test(target)
          ? { command: target, prefix: [] }
          : { command: nodePath, prefix: [target] };
      }
    } catch {
      /* Unreadable: the shell runs it. */
    }
    return { command: executable, prefix: [], shell: true };
  }
  return { command: executable, prefix: [] };
}

/** A spawn function that starts `.js` and `.cmd` executables as `launchTarget` says. */
export function launchable<T extends (...values: never[]) => unknown>(base: T): T {
  return ((command: string, args: readonly string[] = [], options: object = {}) => {
    const target = launchTarget(command);
    if (target.command === command && !target.shell)
      return (base as unknown as (...values: unknown[]) => unknown)(command, args, options);
    return (base as unknown as (...values: unknown[]) => unknown)(
      target.command,
      [...target.prefix, ...args],
      target.shell ? { ...options, shell: true } : options,
    );
  }) as unknown as T;
}
