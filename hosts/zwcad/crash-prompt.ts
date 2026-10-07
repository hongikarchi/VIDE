// ZWCAD's "previous run crashed — send diagnostic info?" prompt (PLAN-43 T-200 후속): after any
// ZWCAD crash a dump waits under %APPDATA%\ZWSOFT\ZWCAD\2023\<locale>\CrashReport and the next ZWCAD
// start shows a modal dialog (#32770) before any plugin loads. A hidden `/b` run then waits forever.
// For ZWCAD processes VIDE itself launched hidden, a watcher answers [아니오] in dialogs of that PID
// only — the user's own ZWCAD and every other process are never touched. Dumps are left alone.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { launchOwnedHost } from '../common/owned-process.ts';
import { diagnostic } from '../../src/core/breadcrumbs.ts';

export interface PromptButton {
  hwnd: string;
  text: string;
}
export interface PromptWindow {
  hwnd: string;
  pid: number;
  className: string;
  buttons: PromptButton[];
}
/** Window access for one watch; the Windows one is a PowerShell helper, tests inject their own. */
export interface WindowAccess {
  /** Top-level dialogs of `pid` with their buttons (read only). */
  scan(pid: number): Promise<PromptWindow[]>;
  /** Clicks `button` only when it still belongs to a dialog of `pid`; true when clicked. */
  click(button: string, pid: number): Promise<boolean>;
  close(): void;
}
export interface CrashPromptWatch {
  /** Ends the watch (the host is ready, stopped or detached). */
  stop(): void;
  /** Resolves with the number of prompts answered when the watch ends. */
  done: Promise<number>;
}

/** 아니오 (ZWCAD) or 아니요 (Windows message boxes); a mnemonic such as `아니오(&N)` is accepted. */
const NO = ['아니오', '아니요'];
export const isNoButton = (text: string) =>
  NO.includes(
    text
      .replace(/\(&?[A-Za-z]\)\s*$/, '')
      .replaceAll('&', '')
      .trim(),
  );
export const DISMISSED_NOTE = 'ZWCAD 이전 충돌 안내를 닫음';

export function watchCrashPrompt(
  pid: number,
  {
    access,
    intervalMs = 500,
    durationMs = 90_000,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((accept) => setTimeout(accept, ms).unref?.()),
    log = (fields: Record<string, unknown>) => diagnostic('zwcad-crash-prompt', fields),
  }: {
    access?: () => WindowAccess;
    intervalMs?: number;
    durationMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log?: (fields: Record<string, unknown>) => void;
  } = {},
): CrashPromptWatch {
  if (!Number.isSafeInteger(pid) || pid <= 0 || (!access && process.platform !== 'win32'))
    return { stop() {}, done: Promise.resolve(0) };
  let stopped = false,
    dismissed = 0;
  const deadline = now() + durationMs;
  const done = (async () => {
    let windows: WindowAccess | undefined;
    try {
      windows = (access ?? powershellAccess)();
      while (!stopped && now() < deadline) {
        for (const dialog of await windows.scan(pid)) {
          if (stopped || dialog.pid !== pid || dialog.className !== '#32770') continue;
          for (const button of dialog.buttons) {
            if (!isNoButton(button.text) || !(await windows.click(button.hwnd, pid))) continue;
            if (!dismissed) log({ pid, note: DISMISSED_NOTE });
            dismissed++;
            break;
          }
        }
        if (!stopped) await sleep(intervalMs);
      }
    } catch {
      /* The watch never breaks a launch; a stuck start still ends at the caller's timeout. */
    } finally {
      windows?.close();
    }
    return dismissed;
  })();
  return {
    stop() {
      stopped = true;
    },
    done,
  };
}

/**
 * A hidden ZWCAD launch (`/b` script run) with the crash-prompt watch. `settled()` ends the watch
 * once the worker answered (ready/out file seen); `stop()` and `detach()` end it too.
 */
export async function launchHiddenZwcad(
  options: Parameters<typeof launchOwnedHost>[0],
  watch: typeof watchCrashPrompt = watchCrashPrompt,
) {
  const owner = await launchOwnedHost(options);
  const prompt = options.visible ? undefined : watch(owner.identity.pid);
  return Object.freeze({
    ...owner,
    settled() {
      prompt?.stop();
    },
    detach() {
      prompt?.stop();
      owner.detach();
    },
    async stop() {
      prompt?.stop();
      return owner.stop();
    },
  });
}

// --- Windows helper -------------------------------------------------------------------------------
// One PowerShell process per watch, driven over stdin: `scan <pid>` → one JSON line, `click <hwnd>
// <pid>` → `1`/`0`. ASCII only (sent as -EncodedCommand; no script file on disk). Text is escaped
// to \uXXXX so the Korean button label survives any console code page.
const helperSource = String.raw`
$ErrorActionPreference='Stop'
Add-Type @"
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class VideZwPrompt{
public delegate bool P(IntPtr h,IntPtr l);
[DllImport("user32.dll")]static extern bool EnumWindows(P p,IntPtr l);
[DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr w,P p,IntPtr l);
[DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder s,int n);
[DllImport("user32.dll")]static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint f);
[DllImport("user32.dll")]static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,IntPtr l,uint f,uint t,out IntPtr r);
static string Cls(IntPtr h){var c=new StringBuilder(64);GetClassName(h,c,64);return c.ToString();}
static uint Pid(IntPtr h){uint p;GetWindowThreadProcessId(h,out p);return p;}
static string Esc(string s){var b=new StringBuilder();foreach(char ch in s){if(ch<32||ch>126||ch=='"'||ch=='\\')b.Append("\\u"+((int)ch).ToString("x4"));else b.Append(ch);}return b.ToString();}
public static string Scan(uint target){var o=new List<string>();EnumWindows((h,l)=>{if(Pid(h)==target&&Cls(h)=="#32770"){var bs=new List<string>();
EnumChildWindows(h,(k,m)=>{if(Cls(k)=="Button"){var s=new StringBuilder(256);GetWindowText(k,s,256);bs.Add("{\"hwnd\":\""+k.ToInt64()+"\",\"text\":\""+Esc(s.ToString())+"\"}");}return true;},IntPtr.Zero);
o.Add("{\"hwnd\":\""+h.ToInt64()+"\",\"pid\":"+target+",\"className\":\"#32770\",\"buttons\":["+string.Join(",",bs)+"]}");}return true;},IntPtr.Zero);return "["+string.Join(",",o)+"]";}
public static bool Click(long button,uint target){var k=new IntPtr(button);if(!IsWindow(k)||Pid(k)!=target)return false;var root=GetAncestor(k,2);
if(Pid(root)!=target||Cls(root)!="#32770")return false;IntPtr r;SendMessageTimeout(k,0x00F5,IntPtr.Zero,IntPtr.Zero,2,2000,out r);return true;}}
"@
[Console]::Out.WriteLine('ready')
while($null -ne ($line=[Console]::In.ReadLine())){
 $a=$line.Split(' ')
 try{ if($a[0] -eq 'scan'){[Console]::Out.WriteLine([VideZwPrompt]::Scan([uint32]$a[1]))}
 elseif($a[0] -eq 'click'){ if([VideZwPrompt]::Click([int64]$a[1],[uint32]$a[2])){[Console]::Out.WriteLine('1')}else{[Console]::Out.WriteLine('0')} }
 else{[Console]::Out.WriteLine('0')} }catch{[Console]::Out.WriteLine('0')}
}
`;

function powershellAccess(): WindowAccess {
  const executable = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const child: ChildProcess = spawn(
    executable,
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      Buffer.from(helperSource, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], shell: false },
  );
  child.unref();
  const lines: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;
  const finish = () => {
    ended = true;
    for (const next of waiting.splice(0)) next(undefined);
  };
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  child.once('exit', finish);
  child.once('error', finish);
  const nextLine = (timeoutMs = 15_000) =>
    new Promise<string>((accept, reject) => {
      if (lines.length) return accept(lines.shift()!);
      if (ended) return reject(new Error('HELPER_ENDED'));
      const timer = setTimeout(() => {
        const at = waiting.indexOf(take);
        if (at >= 0) waiting.splice(at, 1);
        reject(new Error('HELPER_TIMEOUT'));
      }, timeoutMs);
      timer.unref?.();
      const take = (line: string | undefined) => {
        clearTimeout(timer);
        if (line === undefined) reject(new Error('HELPER_ENDED'));
        else accept(line);
      };
      waiting.push(take);
    });
  let started: Promise<void> | undefined;
  const ask = async (command: string) => {
    started ??= nextLine(30_000).then((line) => {
      if (line !== 'ready') throw new Error('HELPER_FAILED');
    });
    await started;
    child.stdin!.write(command + '\n');
    return nextLine();
  };
  return {
    async scan(pid) {
      return JSON.parse(await ask(`scan ${pid}`)) as PromptWindow[];
    },
    async click(button, pid) {
      if (!/^-?\d+$/.test(button)) return false;
      return (await ask(`click ${button} ${pid}`)) === '1';
    },
    close() {
      try {
        child.stdin!.end();
      } catch {
        /* Already gone. */
      }
      if (!ended) child.kill();
    },
  };
}
