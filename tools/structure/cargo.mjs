// Runs cargo for the structure core, finding it on PATH or in the default rustup location.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const local = join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const cargo = existsSync(local) ? local : 'cargo';
const manifest = join(import.meta.dirname, '..', '..', 'src', 'native', 'structure', 'Cargo.toml');
const result = spawnSync(cargo, [...process.argv.slice(2), '--manifest-path', manifest], { stdio: 'inherit' });
if (result.error) {
  console.error(`cargo not found (${result.error.message}). Install Rust with rustup: https://rustup.rs`);
  process.exit(1);
}
process.exit(result.status ?? 1);
