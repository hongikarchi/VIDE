import { copyPackageSources } from './package-source.mjs';
import { cp, mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { join, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile),
  root = resolve(fileURLToPath(new URL('../..', import.meta.url))),
  source = join(root, 'src', 'desktop');
if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.15.0')
  throw Error('Build requires the verified Windows x64 Node.js v24.15.0 runtime.');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')),
  version = process.argv[2] || pkg.version;
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
await copyFile(
  join(root, '.vide/build/zwcad-worker/VIDE.Zwcad.Worker.dll'),
  join(zwcadRuntime, 'VIDE.Zwcad.Worker.dll'),
);
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
await mkdir(join(directory, 'licenses'));
await copyFile(
  join(source, 'licenses', 'node-v24.15.0.txt'),
  join(directory, 'licenses', 'node.txt'),
);
await copyFile(
  join(root, 'node_modules', 'three', 'LICENSE'),
  join(directory, 'licenses', 'three.txt'),
);
const compiler = join(
  process.env.WINDIR || 'C:\\Windows',
  'Microsoft.NET',
  'Framework64',
  'v4.0.30319',
  'csc.exe',
);
await exec(
  compiler,
  [
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/codepage:65001',
    '/reference:System.Windows.Forms.dll',
    '/out:' + join(directory, 'VIDE.exe'),
    join(source, 'Launcher.cs'),
  ],
  { windowsHide: true },
);
await writeFile(
  join(directory, 'START-HERE.txt'),
  `VIDE ${version} · Windows x64 개발 검수용\n\n압축을 모두 푼 뒤 VIDE.exe를 실행하세요. Node/npm을 별도로 실행할 필요가 없습니다.\n두 번 실행하면 이미 열린 작업 공간을 사용합니다. AI WORK 메뉴의 앱 종료로 종료하세요.\n사용자 데이터: %LOCALAPPDATA%\\VIDE (VIDE_DATA_DIR 환경 변수로 별도 지정 가능).\n이 폴더를 지워도 사용자 데이터는 자동 삭제하지 않습니다.\nRhino/ZWCAD와 공식 Claude Code/Codex CLI는 별도 설치본을 사용합니다. AI 연결 설정에서 경로와 로그인을 확인하세요.\nRhino 후보 생성과 3dm 파일 가져오기는 포함된 VIDE worker를 사용하며 외부 MCP 설치가 필요하지 않습니다. VIDE에서 연 Rhino 편집 사본은 자체 채널의 취득·후보 적용·제어기 재시작 후 재연결을 사용합니다. 별도로 열린 기존 Rhino 문서에는 아직 기존 연결의 mcpstart가 필요합니다. ZWCAD DWG 가져오기와 독립 mm XY LWPolyline 정점 수정은 포함된 자체 SDK 도구를 사용합니다. 일반 DWG 객체 편집·열린 원본 적용은 아직 지원하지 않습니다.\n\n포함 런타임: Node.js ${process.version}, Three.js ${pkg.dependencies.three}. 고지는 licenses 폴더에 있습니다.\n백업(앱 종료 후): runtime\\node.exe app\\src\\desktop\\backup.mjs create <데이터 폴더> <새 백업 폴더>\n백업 확인: runtime\\node.exe app\\src\\desktop\\backup.mjs verify <백업 폴더>\n복원은 자동 덮어쓰기를 제공하지 않습니다. 기존 자료를 보존하고 동일 데이터 경로로 복구해야 합니다.\n\n개발 도구가 없는 별도 Windows PC 검수·서명·설치 프로그램·외부 배포 검수는 아직 완료되지 않았습니다.\n`,
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
await exec('tar.exe', ['-a', '-c', '-f', directory + '.zip', '-C', releases, basename(directory)], {
  windowsHide: true,
  timeout: 180000,
});
console.log(JSON.stringify({ directory, archive: directory + '.zip', files: files.length }));
