import { z } from 'zod';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readdir, lstat, realpath, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, dirname, isAbsolute } from 'node:path';
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

/** Stopped local workspace only. Never opens Store or changes interrupted job states. */
export async function backupWorkspace(source: string, destination: string) {
  source = await realpath(resolve(source));
  destination = join(
    await realpath(dirname(resolve(destination))),
    resolve(destination).split(/[\\/]/).at(-1)!,
  );
  if (source === destination || inside(source, destination) || inside(destination, source))
    fail('BACKUP_LOCATION_INVALID');
  const filename = join(source, 'vide.sqlite');
  if (!(await lstat(filename)).isFile()) fail('BACKUP_FILE_UNSUPPORTED');
  let controller: DatabaseSync | undefined, db: DatabaseSync | undefined;
  try {
    controller = new DatabaseSync(filename + '.controller');
    try {
      controller.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    } catch {
      fail('CONTROLLER_BUSY');
    }
    const schema = checkDatabase(filename);
    db = new DatabaseSync(filename, { readOnly: true });
    await mkdir(destination); // Existing backups are never overwritten.
    await backup(db, join(destination, 'vide.sqlite'));
    checkDatabase(join(destination, 'vide.sqlite'));
    const entries = [{ path: 'vide.sqlite', sha256: await hash(join(destination, 'vide.sqlite')) }];
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
    db?.close();
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
  if (!seen.has(join(directory, 'vide.sqlite'))) fail('BACKUP_INVALID');
  if (checkDatabase(join(directory, 'vide.sqlite')) !== manifest.schema) fail('BACKUP_INVALID');
  return manifest;
}
