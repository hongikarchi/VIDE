import { z } from 'zod';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readdir, lstat, realpath, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, dirname, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { checkDatabase } from './database-check.ts';
import { schemaVersion } from './migrations.ts';

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel);
};
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

async function files(root: string, path = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const filename = join(path, entry.name),
      info = await lstat(filename);
    if (info.isSymbolicLink()) fail('BACKUP_LINK_UNSUPPORTED');
    if (info.isDirectory()) result.push(...(await files(root, filename)));
    else if (info.isFile()) result.push(filename);
    else fail('BACKUP_FILE_UNSUPPORTED');
  }
  return result;
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );
/** A project's knowledge DB (its own schema, not the workspace's). */
const knowledge = (path: string) => /[\\/]knowledge\.sqlite$/.test(path);
/** app.sqlite and each project's DBs, relative to the data folder. */
async function splitDatabases(source: string) {
  const list = ['app.sqlite'];
  const root = join(source, 'projects');
  if (!(await exists(root))) return list;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of ['project.sqlite', 'knowledge.sqlite'])
      if (await exists(join(root, entry.name, name))) list.push(join('projects', entry.name, name));
  }
  return list;
}

/** Stopped local workspace only. Never opens Store or changes interrupted job states. */
export async function backupWorkspace(source: string, destination: string) {
  source = await realpath(resolve(source));
  destination = join(
    await realpath(dirname(resolve(destination))),
    resolve(destination).split(/[\\/]/).at(-1)!,
  );
  if (source === destination || inside(source, destination) || inside(destination, source))
    fail('BACKUP_LOCATION_INVALID');
  // The engine's lock is the same file in both layouts (see Store).
  const filename = join(source, 'vide.sqlite');
  const split = await exists(join(source, 'app.sqlite'));
  let controller: DatabaseSync | undefined;
  try {
    controller = new DatabaseSync(filename + '.controller');
    try {
      controller.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    } catch {
      fail('CONTROLLER_BUSY');
    }
    // Single layout: vide.sqlite. Split layout (ADR-032): app.sqlite and every project's DBs.
    const databases = split ? await splitDatabases(source) : ['vide.sqlite'];
    let schema = 0;
    for (const path of databases) {
      if (!(await lstat(join(source, path))).isFile()) fail('BACKUP_FILE_UNSUPPORTED');
      if (!knowledge(path)) schema = checkDatabase(join(source, path));
    }
    await mkdir(destination); // Existing backups are never overwritten.
    const entries: { path: string; sha256: string }[] = [];
    for (const path of databases) {
      const target = join(destination, path);
      await mkdir(dirname(target), { recursive: true });
      const db = new DatabaseSync(join(source, path), { readOnly: true });
      try {
        await backup(db, target);
      } finally {
        db.close();
      }
      if (!knowledge(path)) checkDatabase(target);
      entries.push({ path: path.split(sep).join('/'), sha256: await hash(target) });
    }
    for (const folder of ['models', 'cad-models', 'sdk-models']) {
      const directory = join(source, folder);
      try {
        if ((await lstat(directory)).isSymbolicLink()) fail('BACKUP_LINK_UNSUPPORTED');
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
          continue;
        throw error;
      }
      for (const file of await files(directory)) {
        const path = relative(source, file),
          target = join(destination, path),
          before = await hash(file);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(file, target);
        if ((await hash(target)) !== before || (await hash(file)) !== before)
          fail('BACKUP_SOURCE_CHANGED');
        entries.push({ path: path.replaceAll('\\', '/'), sha256: before });
      }
    }
    const manifest = {
      format: 1,
      schema,
      source,
      createdAt: new Date().toISOString(),
      files: entries,
    };
    // Written last. A partial folder without this manifest is not a complete backup.
    await writeFile(
      join(destination, 'backup-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx' },
    );
    return manifest;
  } finally {
    controller?.close();
  }
}

export async function verifyBackup(directory: string) {
  directory = await realpath(resolve(directory));
  const parsed = z
    .object({
      format: z.literal(1),
      schema: z.number().int().min(1).max(schemaVersion),
      source: z.string(),
      createdAt: z.string(),
      files: z
        .array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }))
        .min(1),
    })
    .safeParse(JSON.parse(await readFile(join(directory, 'backup-manifest.json'), 'utf8')));
  if (!parsed.success) fail('BACKUP_INVALID');
  const manifest = parsed.data;
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length)
    fail('BACKUP_INVALID');
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256))
      fail('BACKUP_INVALID');
    const target = resolve(directory, file.path);
    if (!inside(directory, target) || seen.has(target)) fail('BACKUP_INVALID');
    seen.add(target);
    if (!inside(directory, await realpath(target)) || (await hash(target)) !== file.sha256)
      fail('BACKUP_INVALID');
  }
  // The single DB, or app.sqlite with the project DBs of the split layout.
  const main = seen.has(join(directory, 'app.sqlite')) ? 'app.sqlite' : 'vide.sqlite';
  if (!seen.has(join(directory, main))) fail('BACKUP_INVALID');
  for (const file of manifest.files)
    if (file.path === main || /^projects\/[^/]+\/project\.sqlite$/.test(file.path))
      if (checkDatabase(join(directory, file.path)) !== manifest.schema) fail('BACKUP_INVALID');
  return manifest;
}
