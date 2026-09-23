import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const version = '8.30.1';
const folder = resolve('.vide/tools/gitleaks');
const executable = resolve(folder, process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
const assets = {
  win32: ['windows_x64.zip', 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e'],
  linux: ['linux_x64.tar.gz', '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'],
};
const mode = process.argv[2] || 'staged';
if (mode === 'install') {
  const asset = assets[process.platform];
  if (!asset || process.arch !== 'x64') throw Error('Unsupported scanner platform');
  mkdirSync(folder, {recursive:true});
  const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${asset[0]}`);
  if (!response.ok) throw Error('Scanner download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== asset[1]) throw Error('Scanner checksum mismatch');
  const archive = resolve(folder, asset[0]); writeFileSync(archive, bytes);
  const unpack = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${folder.replaceAll("'", "''")}' -Force`], {stdio:'inherit',windowsHide:true})
    : spawnSync('tar', ['-xzf',archive,'-C',folder], {stdio:'inherit'});
  if (unpack.status !== 0) throw Error('Scanner extraction failed');
} else {
  if (!['staged','history','selftest'].includes(mode)) throw Error('Unknown scanner mode');
  if (!existsSync(executable)) throw Error('Run npm run security:install first');
  const detected = spawnSync(executable,['version'],{encoding:'utf8',windowsHide:true});
  if (detected.status !== 0 || detected.stdout.trim() !== version) throw Error('Scanner version mismatch');
  const args = ['--config',resolve('.gitleaks.toml'),'--redact=100','--no-banner','--no-color','--ignore-gitleaks-allow'];
  const input = mode === 'selftest' ? 'github_token = "ghp_' + randomBytes(27).toString('base64').replaceAll('+','A').replaceAll('/','B') + '"' : undefined;
  const command = mode === 'selftest' ? ['stdin'] : ['git', ...(mode === 'history' ? ['--log-opts=--all'] : ['--pre-commit','--staged'])];
  const result = spawnSync(executable,[...command,...args],{input,encoding:'utf8',windowsHide:true});
  // Scanner output stays redacted; never print supplied input or credential lines ourselves.
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error || result.status !== (mode === 'selftest' ? 1 : 0)) process.exit(1);
}
