// Read-only documents (2026-10-01): Rhino once opened the user's file read-only ("You must use
// SaveAs") and nothing left afterwards could tell why. When an attached Rhino document reports
// `readOnly`, one engine log line per document per Rhino session records what could explain it:
// the file's attributes, whether a Rhino lock file is next to it, the Rhino processes running and
// which processes hold the file right now (Windows Restart Manager). Gathered in the background;
// a Sync never waits for it and a failed query only leaves its field empty. No UI.
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostTarget } from '../contracts/host-documents.ts';

export interface FileEvidence {
  attributes?: string;
  /** Rhino.exe processes: id, start time and the .3dm named on the command line, if any. */
  rhino?: { pid: number; started?: string; file?: string | null }[];
  /** Processes the Restart Manager reports as holding the file. */
  holders?: { pid: number; name?: string; started?: string }[];
  errors?: string[];
}
interface Options {
  write: (event: string, fields: Record<string, unknown>) => void;
  /** The document's name and path as the host reports them now. */
  describe: (target: HostTarget) => Promise<{ name?: string; path?: string }>;
  query?: (path: string | undefined) => Promise<FileEvidence>;
  lockExists?: (path: string) => Promise<boolean>;
}

export class ReadOnlyWatch {
  private seen = new Set<string>();
  private pending = new Set<Promise<void>>();
  private options: Options;
  constructor(options: Options) {
    this.options = options;
  }
  /** Every document snapshot passes here; true when this one starts a log entry. Never throws. */
  note(target: HostTarget, snapshot: { readOnly?: boolean; name?: string }, host = 'rhino') {
    if (snapshot.readOnly !== true) return false;
    const key = [host, target.instance, target.documentId].join('|');
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    const work = this.record(target, snapshot.name, host).catch(() => {});
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return true;
  }
  /** Resolves once the entries started so far are written. */
  async settled() {
    await Promise.allSettled([...this.pending]);
  }
  private async record(target: HostTarget, reported: string | undefined, host: string) {
    let name = reported,
      path: string | undefined;
    const errors: string[] = [];
    try {
      const described = await this.options.describe(target);
      name = described.name ?? name;
      path = described.path || undefined;
    } catch (error) {
      errors.push('describe: ' + message(error));
    }
    const exists = this.options.lockExists ?? fileExists;
    const locks = path
      ? await Promise.all(
          [...new Set([path.replace(/\.3dm$/i, '.rhl'), path + '.rhl'])].map(async (lock) => ({
            path: lock,
            exists: await exists(lock).catch(() => false),
          })),
        )
      : [];
    let evidence: FileEvidence = {};
    try {
      evidence = await (this.options.query ?? queryFileEvidence)(path);
    } catch (error) {
      errors.push('query: ' + message(error));
    }
    this.options.write('document-read-only', {
      host,
      instance: target.instance,
      documentId: target.documentId,
      name,
      path,
      attributes: evidence.attributes,
      lockFiles: locks,
      rhino: evidence.rhino,
      holders: evidence.holders,
      ...(errors.length || evidence.errors?.length
        ? { errors: [...errors, ...(evidence.errors ?? [])] }
        : {}),
    });
  }
}

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);
async function fileExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// One PowerShell run: attributes, Rhino processes and the Restart Manager's holders of the file.
// The path travels in an environment variable, never inside the script text.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$path = $env:VIDE_READONLY_PATH
$out = [ordered]@{ errors = @() }
if ($path) {
  try { $out.attributes = (Get-Item -LiteralPath $path -Force).Attributes.ToString() } catch { $out.errors += 'attributes: ' + $_.Exception.Message }
}
try {
  $out.rhino = @(Get-CimInstance Win32_Process -Filter "Name='Rhino.exe'" | ForEach-Object {
    $file = $null
    if ($_.CommandLine -match '([^\\/"]+\.3dm)') { $file = $Matches[1] }
    [ordered]@{ pid = [int]$_.ProcessId; started = $_.CreationDate.ToUniversalTime().ToString('o'); file = $file }
  })
} catch { $out.errors += 'rhino: ' + $_.Exception.Message }
if ($path) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class VideFileHolder { public int pid { get; set; } public string name { get; set; } public string started { get; set; } }
public static class VideRestartManager {
  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] names, uint apps, RM_UNIQUE_PROCESS[] processes, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  public static VideFileHolder[] Holders(string path) {
    uint handle; var key = new StringBuilder(64);
    int code = RmStartSession(out handle, 0, key);
    if (code != 0) throw new Exception("RmStartSession " + code);
    try {
      code = RmRegisterResources(handle, 1, new[] { path }, 0, null, 0, null);
      if (code != 0) throw new Exception("RmRegisterResources " + code);
      uint needed = 0, count = 0, reasons = 0;
      code = RmGetList(handle, out needed, ref count, null, ref reasons);
      if (code == 0) return new VideFileHolder[0];
      if (code != 234) throw new Exception("RmGetList " + code);
      var info = new RM_PROCESS_INFO[needed]; count = needed;
      code = RmGetList(handle, out needed, ref count, info, ref reasons);
      if (code != 0) throw new Exception("RmGetList " + code);
      var list = new List<VideFileHolder>();
      for (var i = 0; i < count; i++) {
        var time = info[i].Process.ProcessStartTime;
        var ticks = ((long)time.dwHighDateTime << 32) | (uint)time.dwLowDateTime;
        list.Add(new VideFileHolder { pid = info[i].Process.dwProcessId, name = info[i].strAppName, started = DateTime.FromFileTimeUtc(ticks).ToString("o") });
      }
      return list.ToArray();
    } finally { RmEndSession(handle); }
  }
}
'@
    $out.holders = @([VideRestartManager]::Holders($path))
  } catch { $out.errors += 'holders: ' + $_.Exception.Message }
}
$out | ConvertTo-Json -Compress -Depth 4
`;

/** Windows evidence about a document file; empty on other systems. Bounded to 30 s. */
export async function queryFileEvidence(path: string | undefined): Promise<FileEvidence> {
  if (process.platform !== 'win32') return { errors: ['unsupported platform'] };
  const powershell = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(SCRIPT, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        encoding: 'utf8',
        env: { ...process.env, VIDE_READONLY_PATH: path ?? '' },
      },
      (error, out) => (error ? reject(error) : resolve(out)),
    ),
  );
  const parsed = JSON.parse(stdout.trim()) as FileEvidence;
  if (parsed.errors && !parsed.errors.length) delete parsed.errors;
  return parsed;
}
