// [진단 묶음 내보내기] (T-126, ADR-031 9): one zip the user can send for a bug report — the dated
// logs of every VIDE part, the engine exit records, versions and a settings summary. It never
// holds keys or logins (launch.json, local-session.key, remote-host.json, typesafe.env, public-data.env,
// cli-profiles), the workspace DB, models or request text: only the files named here go in.
// Crash dumps go in only when asked (`dumps`), the newest one, stored uncompressed.
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { arch, platform, release, totalmem } from 'node:os';
import { basename, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { scrub } from '../core/breadcrumbs.ts';
import { appVersion } from './sdk-options.ts';

export interface BundleOptions {
  /** The VIDE data folder (logs in its `logs`, dumps in its `crashdumps`). */
  directory: string;
  /** Logs of this many recent days (default 14: all that are kept). */
  days?: number;
  /** Add the newest crash dump (large). */
  dumps?: boolean;
  /** Where the zip goes (default <data>/diagnostics). */
  output?: string;
  now?: () => Date;
}

/** Log files the bundle takes from <data>/logs: dated logs of every part and the fixed records. */
const DATED = /^(?:engine|engine-stderr|rhino|zwcad|shell)-(\d{4}-\d{2}-\d{2})\.(?:jsonl|log)$/;
const FIXED_LOGS = new Set(['engine-exits.jsonl', 'procdump.log', 'model-routing.jsonl']);
/** Settings files whose content is a summary of choices (no keys); paths in them are cleaned. */
const SETTINGS = [
  'desktop.json',
  'question-settings.json',
  'web-settings.json',
  'usage-settings.json',
  'route-settings.json',
];
/** Never in a bundle, whatever else changes (checked again on every entry). */
const FORBIDDEN =
  /(^|[\\/])(launch\.json|local-session\.key|remote-host\.json|typesafe\.env|public-data\.env|[^\\/]*\.sqlite[^\\/]*|cli-profiles)([\\/]|$)/i;
const KEEP_BUNDLES = 3;

export interface DumpInfo {
  name: string;
  bytes: number;
  modified: string;
}

/** The crash dumps in <data>/crashdumps, newest first (ProcDump keeps three, T-191). */
export async function listDumps(directory: string): Promise<DumpInfo[]> {
  const folder = join(directory, 'crashdumps');
  const dumps = await Promise.all(
    (await readdir(folder).catch(() => []))
      .filter((name) => name.toLowerCase().endsWith('.dmp'))
      .map(async (name) => {
        const info = await stat(join(folder, name)).catch(() => undefined);
        return info && { name, bytes: info.size, modified: info.mtime.toISOString() };
      }),
  );
  return dumps
    .filter((dump): dump is DumpInfo => !!dump)
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

interface Entry {
  name: string;
  data?: Buffer;
  file?: string;
}

export async function writeDiagnosticBundle(options: BundleOptions) {
  const now = (options.now ?? (() => new Date()))();
  const logs = join(options.directory, 'logs');
  const oldest = new Date(now.getTime() - (options.days ?? 14) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const entries: Entry[] = [];
  for (const name of (await readdir(logs).catch(() => [])).sort()) {
    const day = DATED.exec(name)?.[1];
    if ((day && day >= oldest) || FIXED_LOGS.has(name))
      entries.push({ name: `logs/${name}`, file: join(logs, name) });
  }
  // Settings: the whitelisted files, user paths cleaned; the data folder's other files by name only.
  const settings: Record<string, unknown> = {};
  for (const name of SETTINGS) {
    const text = await readFile(join(options.directory, name), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    try {
      settings[name] = JSON.parse(scrub(text, 20_000));
    } catch {
      settings[name] = 'unreadable';
    }
  }
  const files: { name: string; bytes?: number; modified?: string; folder?: boolean }[] = [];
  for (const name of (await readdir(options.directory).catch(() => [])).sort()) {
    const info = await stat(join(options.directory, name)).catch(() => undefined);
    if (!info) continue;
    files.push(
      info.isDirectory()
        ? { name, folder: true }
        : { name, bytes: info.size, modified: info.mtime.toISOString() },
    );
  }
  // Only the newest dump, and only when asked (T-191): one full dump is hundreds of MB.
  const dumps = await listDumps(options.directory);
  if (options.dumps && dumps[0])
    entries.push({
      name: `crashdumps/${dumps[0].name}`,
      file: join(options.directory, 'crashdumps', dumps[0].name),
    });
  const plugins = await listTree(join(options.directory, 'plugins'), 2);
  const about = {
    createdAt: now.toISOString(),
    vide: appVersion(),
    node: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    memoryMB: Math.round(totalmem() / 1_048_576),
    days: options.days ?? 14,
    dumpsIncluded: !!options.dumps && !!dumps[0],
    dumps,
    plugins,
    dataFiles: files,
    note: 'IDs, codes, timings and sizes only. No request text, file contents, keys or the workspace DB.',
  };
  entries.unshift(
    { name: 'about.json', data: Buffer.from(JSON.stringify(about, null, 2)) },
    { name: 'settings.json', data: Buffer.from(JSON.stringify(settings, null, 2)) },
  );
  for (const entry of entries)
    if (FORBIDDEN.test(entry.name) || (entry.file && FORBIDDEN.test(basename(entry.file))))
      throw Object.assign(new Error('BUNDLE_FORBIDDEN_FILE'), { code: 'BUNDLE_FORBIDDEN_FILE' });
  const output = options.output ?? join(options.directory, 'diagnostics');
  await mkdir(output, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = join(output, `vide-diagnostics-${stamp}.zip`);
  const bytes = await writeZip(file, entries);
  // Only the newest few bundles stay.
  const old = (await readdir(output))
    .filter((name) => /^vide-diagnostics-.*\.zip$/.test(name))
    .sort()
    .reverse()
    .slice(KEEP_BUNDLES);
  for (const name of old) await unlink(join(output, name)).catch(() => {});
  return { file, bytes, files: entries.map((entry) => entry.name) };
}

async function listTree(folder: string, depth: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const name of (await readdir(folder).catch(() => [])).sort()) {
    const path = join(folder, name);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory())
      out.push({ name, entries: depth > 1 ? await listTree(path, depth - 1) : undefined });
    else if (/\.(dll|rhp|zrx|json|txt)$/i.test(name))
      out.push({ name, bytes: info.size, modified: info.mtime.toISOString() });
  }
  return out;
}

// --- a small ZIP writer: deflated entries for text, stored ones for large files ---------------------

const SMALL = 32 * 1024 * 1024;
function dosTime(date: Date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function writeZip(file: string, entries: Entry[]) {
  const handle = await open(file, 'w');
  const central: Buffer[] = [];
  let offset = 0;
  const put = async (data: Buffer) => {
    await handle.write(data);
    offset += data.length;
  };
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const info = entry.file ? await stat(entry.file).catch(() => undefined) : undefined;
      if (entry.file && !info) continue;
      const when = dosTime(info?.mtime ?? new Date());
      let method = 8,
        crc = 0,
        size = 0,
        packed: Buffer | undefined;
      if (entry.data || (info && info.size <= SMALL)) {
        const data = entry.data ?? (await readFile(entry.file!));
        crc = crc32(data);
        size = data.length;
        packed = deflateRawSync(data, { level: 6 });
      } else {
        // Large (a dump): stored, its CRC read first in chunks.
        method = 0;
        size = info!.size;
        for await (const chunk of createReadStream(entry.file!)) crc = crc32(chunk as Buffer, crc);
      }
      const compressed = packed ? packed.length : size;
      if (size > 0xfffffffe || offset > 0xfffffffe) break; // No ZIP64: a bundle stays under 4 GB.
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(when.time, 10);
      local.writeUInt16LE(when.date, 12);
      local.writeUInt32LE(crc >>> 0, 14);
      local.writeUInt32LE(compressed, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const at = offset;
      await put(Buffer.concat([local, name]));
      if (packed) await put(packed);
      else for await (const chunk of createReadStream(entry.file!)) await put(chunk as Buffer);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(method, 10);
      record.writeUInt16LE(when.time, 12);
      record.writeUInt16LE(when.date, 14);
      record.writeUInt32LE(crc >>> 0, 16);
      record.writeUInt32LE(compressed, 20);
      record.writeUInt32LE(size, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(at, 42);
      central.push(Buffer.concat([record, name]));
    }
    const start = offset;
    const directory = Buffer.concat(central);
    await put(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(start, 16);
    await put(end);
  } finally {
    await handle.close();
  }
  return offset;
}
