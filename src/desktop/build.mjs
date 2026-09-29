import { copyZwcadNotices } from './package-licenses.mjs';
import { copyPackageSources } from './package-source.mjs';
import { cp, mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { join, resolve, relative, basename, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile),
  root = resolve(fileURLToPath(new URL('../..', import.meta.url))),
  source = join(root, 'src', 'desktop');
if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.15.0')
  throw Error('Build requires the verified Windows x64 Node.js v24.15.0 runtime.');
const args = process.argv.slice(2),
  installer = args.includes('--installer'),
  pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')),
  version = args.find((arg) => !arg.startsWith('--')) || pkg.version;
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) throw Error('Invalid package version');
const releases = join(root, '.vide', 'releases'),
  directory = join(releases, 'VIDE-' + version + '-windows-x64');
await mkdir(releases, { recursive: true });
await mkdir(directory); // Never overwrite an existing reviewable artifact.
const { stdout: tracked } = await exec('git', ['ls-files', '-z'], {
  cwd: root,
  maxBuffer: 16 * 1024 * 1024,
});
await copyPackageSources(root, join(directory, 'app'), tracked.split('\0').filter(Boolean), [
  'src/ai',
  'src/core',
  'src/server',
  'src/ui',
  'src/contracts',
  'src/jigs',
  'hosts',
  'extensions',
]);
await cp(join(root, 'dist', 'ui'), join(directory, 'app', 'dist', 'ui'), { recursive: true });
await mkdir(join(directory, 'app', 'src', 'desktop'), { recursive: true });
await copyFile(join(source, 'backup.mjs'), join(directory, 'app', 'src', 'desktop', 'backup.mjs'));

await exec(
  'dotnet',
  ['build', join(root, 'hosts/rhino/worker/VIDE.Worker.csproj'), '--no-restore'],
  { windowsHide: true },
);
const workerRuntime = join(directory, 'app', 'hosts', 'rhino', 'worker', 'runtime');
await mkdir(workerRuntime, { recursive: true });
for (const file of ['VIDE.Worker.rhp', 'VIDE.Worker.deps.json'])
  await copyFile(
    join(root, '.vide/build/rhino-worker/bin/net8.0-windows', file),
    join(workerRuntime, file),
  );
await exec(
  join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'RemoteSigned',
    '-File',
    join(root, 'hosts/zwcad/worker/build.ps1'),
  ],
  { windowsHide: true },
);
const zwcadRuntime = join(directory, 'app', 'hosts', 'zwcad', 'worker', 'runtime');
await mkdir(zwcadRuntime, { recursive: true });
// Explicit runtime dependencies only; installed ZWCAD SDK assemblies are never bundled.
const zwcadAssemblies = [
  'VIDE.Zwcad.Worker.dll',
  'Microsoft.CodeAnalysis.dll',
  'Microsoft.CodeAnalysis.CSharp.dll',
  'System.Buffers.dll',
  'System.Collections.Immutable.dll',
  'System.Memory.dll',
  'System.Numerics.Vectors.dll',
  'System.Reflection.Metadata.dll',
  'System.Runtime.CompilerServices.Unsafe.dll',
  'System.Text.Encoding.CodePages.dll',
  'System.Threading.Tasks.Extensions.dll',
];
for (const file of zwcadAssemblies)
  await copyFile(join(root, '.vide/build/zwcad-worker', file), join(zwcadRuntime, file));
await exec(
  'dotnet',
  ['build', join(root, 'hosts/zwcad/connection/VIDE.Zwcad.Connection.csproj'), '--no-restore'],
  { windowsHide: true },
);
const cadConnectionRuntime = join(directory, 'app', 'hosts', 'zwcad', 'connection', 'runtime');
await mkdir(cadConnectionRuntime, { recursive: true });
// The connection plugin compiles AI code on the open drawing: it ships with the same compiler
// assemblies as the worker (installed next to it by "연결 프로그램").
for (const file of [
  'VIDE.Zwcad.Connection.dll',
  ...zwcadAssemblies.filter((name) => name !== 'VIDE.Zwcad.Worker.dll'),
  // The palette's web view (Design SCR-12).
  'Microsoft.Web.WebView2.Core.dll',
  'Microsoft.Web.WebView2.WinForms.dll',
])
  await copyFile(
    join(root, '.vide/build/zwcad-connection', file),
    join(cadConnectionRuntime, file),
  );
// The native WebView2 loader sits next to the plugin ("연결 프로그램" copies the folder's DLLs only).
await copyFile(
  join(root, '.vide/build/zwcad-connection/runtimes/win-x64/native/WebView2Loader.dll'),
  join(cadConnectionRuntime, 'WebView2Loader.dll'),
);
// Structure analysis core (Rust Node-API addon, PLAN-17 T-039): ship only the built library and the
// licence texts of the crates compiled into it.
const cargo = existsSync(join(homedir(), '.cargo', 'bin', 'cargo.exe'))
  ? join(homedir(), '.cargo', 'bin', 'cargo.exe')
  : 'cargo';
const structureManifest = join(root, 'src', 'native', 'structure', 'Cargo.toml');
await exec(cargo, ['build', '--release', '--lib', '--manifest-path', structureManifest], {
  windowsHide: true,
});
const structureRuntime = join(directory, 'app', 'src', 'native', 'structure');
await mkdir(structureRuntime, { recursive: true });
await copyFile(
  join(root, 'src', 'native', 'structure', 'target', 'release', 'vide_structure.dll'),
  join(structureRuntime, 'vide_structure.node'),
);
const { stdout: cargoMetadata } = await exec(
  cargo,
  ['metadata', '--format-version', '1', '--manifest-path', structureManifest],
  { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
);
const crateNotices = join(directory, 'licenses', 'structure-core');
await mkdir(crateNotices, { recursive: true });
const crateList = [];
for (const crate of JSON.parse(cargoMetadata).packages) {
  if (crate.name === 'vide-structure') continue;
  crateList.push(`${crate.name} ${crate.version} — ${crate.license ?? 'see files'}`);
  const folder = dirname(crate.manifest_path);
  for (const entry of await readdir(folder))
    if (/^(licen[cs]e|copying|notice)/i.test(entry))
      await copyFile(
        join(folder, entry),
        join(crateNotices, `${crate.name}-${crate.version}-${entry}`),
      );
}
await writeFile(join(crateNotices, 'CRATES.txt'), crateList.sort().join('\n') + '\n');
await writeFile(
  join(directory, 'app', 'package.json'),
  JSON.stringify({ ...pkg, version }, null, 2) + '\n',
);
// Include the locked production dependency tree, including SDK transitive imports and licenses.
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
await copyFile(join(root, 'package-lock.json'), join(directory, 'app', 'package-lock.json'));
for (const [packagePath, metadata] of Object.entries(lock.packages)) {
  if (!packagePath || metadata.dev) continue;
  if (
    !packagePath.startsWith('node_modules/') ||
    packagePath.split('/').includes('..') ||
    metadata.link
  )
    throw Error('Unsupported runtime dependency path');
  await cp(join(root, packagePath), join(directory, 'app', packagePath), { recursive: true });
}
await mkdir(join(directory, 'runtime'));
await copyFile(process.execPath, join(directory, 'runtime', 'node.exe'));
// The packaged engine must resolve all of its modules (a source folder missing from the list
// above would only fail when the installed app starts).
await exec(
  join(directory, 'runtime', 'node.exe'),
  ['--input-type=module', '-e', "await import('./src/server/server.ts')"],
  { cwd: join(directory, 'app'), windowsHide: true },
);
await mkdir(join(directory, 'licenses'), { recursive: true });
await copyZwcadNotices(
  root,
  join(directory, 'licenses', 'zwcad-runtime'),
  zwcadAssemblies.slice(1),
);
await copyFile(
  join(source, 'licenses', 'node-v24.15.0.txt'),
  join(directory, 'licenses', 'node.txt'),
);
await copyFile(
  join(root, 'node_modules', 'three', 'LICENSE'),
  join(directory, 'licenses', 'three.txt'),
);
// PC program shell (own window, tray, autostart, updates); see src/desktop/shell.
await exec(
  'dotnet',
  ['build', join(source, 'shell', 'VIDE.Desktop.csproj'), '-c', 'Release', '-p:Version=' + version],
  { windowsHide: true },
);
const shellOutput = join(root, '.vide', 'build', 'desktop-shell', 'bin');
for (const entry of await readdir(shellOutput, { withFileTypes: true }))
  if (!entry.name.endsWith('.pdb'))
    await cp(join(shellOutput, entry.name), join(directory, entry.name), { recursive: true });
await writeFile(
  join(directory, 'START-HERE.txt'),
  `VIDE ${version} · Windows x64

설치본(VIDE.App-win-Setup.exe)으로 설치하면 시작 메뉴·바탕화면에 VIDE가 생기고 자동 업데이트를 받습니다. 이 폴더(ZIP)는 설치 없이 VIDE.exe를 바로 실행하는 검수용입니다.
창을 닫으면 설정에 따라 트레이에 남거나 종료합니다. 트레이 메뉴의 종료로 끝냅니다.
사용자 데이터: %LOCALAPPDATA%\VIDE (설치·업데이트·제거가 지우지 않습니다).
Rhino·ZWCAD와 공식 Claude Code/Codex CLI는 별도 설치본을 사용합니다. Rhino 플러그인은 VIDE 설정 → 연결 프로그램에서 설치합니다.

포함 런타임: Node.js ${process.version}, Three.js ${pkg.dependencies.three}. 고지는 licenses 폴더에 있습니다.
백업(앱 종료 후): runtime\node.exe app\src\desktop\backup.mjs create <데이터 폴더> <새 백업 폴더>

실행 파일은 아직 코드 서명 전입니다. Windows 경고가 뜨면 \"추가 정보 → 실행\"을 누르세요.
`,
  'utf8',
);
async function inventory(folder) {
  let result = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const filename = join(folder, entry.name);
    if (entry.isDirectory()) result.push(...(await inventory(filename)));
    else
      result.push({
        path: relative(directory, filename).replaceAll('\\', '/'),
        sha256: createHash('sha256')
          .update(await readFile(filename))
          .digest('hex'),
      });
  }
  return result;
}
const files = (await inventory(directory)).sort((a, b) => a.path.localeCompare(b.path));
await writeFile(
  join(directory, 'package-manifest.json'),
  JSON.stringify({ version, runtime: process.version, platform: 'windows-x64', files }, null, 2) +
    '\n',
);
// Windows' own tar (bsdtar); a Git Bash tar on PATH treats "C:" as a remote host.
await exec(
  join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
  ['-a', '-c', '-f', directory + '.zip', '-C', releases, basename(directory)],
  {
    windowsHide: true,
    timeout: 180000,
  },
);
// Installer and update packages (Velopack): per-user install, no administrator rights.
let installerOutput;
if (installer) {
  installerOutput = join(releases, 'installer');
  await exec(
    'dotnet',
    [
      'vpk',
      'pack',
      '--packId',
      'VIDE.App',
      '--packVersion',
      version,
      '--packDir',
      directory,
      '--mainExe',
      'VIDE.exe',
      '--packTitle',
      'VIDE',
      '--packAuthors',
      'VIDE',
      '--icon',
      join(source, 'shell', 'vide.ico'),
      '--outputDir',
      installerOutput,
    ],
    { cwd: root, windowsHide: true, timeout: 600000, maxBuffer: 64 * 1024 * 1024 },
  );
}
console.log(
  JSON.stringify({
    directory,
    archive: directory + '.zip',
    installer: installerOutput,
    files: files.length,
  }),
);
