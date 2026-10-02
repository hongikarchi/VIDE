// Rhino command scripts and Python in direct mode (ADR-029, user decision 2026-10-02 "Rhino 명령,
// Python은 열어줘야지"). The AI's `execute` may send a Rhino command macro or a Python 3 script
// besides a C# body. This is the policy both the engine (before calling the host) and the Rhino
// plugin (DirectScripts.cs, the same lists) apply: commands that open, close or quit, read files
// or scripts from disk, change application options or plug-ins, or control undo are refused;
// commands that write files (save, export, print) and purge wait on the guard card. Like
// CodePolicy it is defence in depth, not an OS security boundary.

/** The direct-mode guard kinds a script can trip before it runs (a subset of directGuardKinds). */
export type DirectGuardKind = 'save-as' | 'export' | 'publish' | 'purge';

export const executeLanguages = ['csharp', 'command', 'python'] as const;
export type ExecuteLanguage = (typeof executeLanguages)[number];

// Lists kept identical in hosts/rhino/worker/DirectScripts.cs (tests/server/rhino-script-policy).
/** Refused wherever they appear in a macro (none is a common option name). */
export const COMMAND_DENY = [
  'exit',
  'quit',
  'open',
  'worksession',
  'revert',
  'runscript',
  'loadscript',
  'readcommandfile',
  'runpythonscript',
  'editpythonscript',
  'scripteditor',
  'rhinocode',
  'options',
  'documentproperties',
  'units',
  'pluginmanager',
  'loadplugin',
  'packagemanager',
  'grasshopper',
  'grasshopperplayer',
  'readviewsfromfile',
  'sendmail',
  'packtextures',
  'clearundo',
  'undomultiple',
  'redomultiple',
  'undoselected',
  'pause',
  'multipause',
];
/** Refused at a command position only (they are also option names inside other commands). */
export const COMMAND_DENY_AT_START = ['new', 'close', 'undo', 'redo', 'insert'];
/** Every token starting with these is refused (Import, ImportLayouts, ImportNamedViews, …). */
export const COMMAND_DENY_PREFIX = ['import'];
/** Held for the user's confirmation wherever they appear. */
export const COMMAND_CONFIRM: Record<string, DirectGuardKind> = {
  saveas: 'save-as',
  savesmall: 'save-as',
  saveastemplate: 'save-as',
  incrementalsave: 'save-as',
  viewcapturetofile: 'export',
  print: 'publish',
  purge: 'purge',
};
/** Held for confirmation at a command position only (NamedView has a Save option). */
export const COMMAND_CONFIRM_AT_START: Record<string, DirectGuardKind> = { save: 'save-as' };
/** Every token starting with these is held for confirmation (Export, ExportWithOrigin, …). */
export const COMMAND_CONFIRM_PREFIX: Record<string, DirectGuardKind> = { export: 'export' };

/** Python source patterns refused (file, network, process, reflection, application, undo). */
export const PYTHON_DENY = [
  String.raw`^[ \t]*(import|from)[ \t]+[^\n#]*\b(os|sys|subprocess|socket|shutil|ctypes|urllib|urllib2|urllib3|http|requests|pathlib|io|glob|tempfile|ftplib|smtplib|multiprocessing|threading|asyncio|winreg|_winreg|importlib|webbrowser|pickle|marshal|zipfile|tarfile|sqlite3|signal|clr)\b`,
  String.raw`(?<![\w.])(open|__import__|exec|eval|compile|execfile|input|raw_input|breakpoint)[ \t]*\(`,
  String.raw`\bSystem\.(IO|Net|Diagnostics|Reflection|Threading|Runtime|Environment|AppDomain|Activator|Type)\b`,
  String.raw`^[ \t]*from[ \t]+System(\.\w+)?[ \t]+import\b[^\n#]*\b(IO|Net|Diagnostics|Reflection|Threading|Runtime|Environment|AppDomain|Activator|Type)\b`,
  String.raw`\bMicrosoft\.Win32\b`,
  String.raw`\bRhino\.(FileIO|PlugIns|UI|ApplicationSettings|Runtime|Commands)\b`,
  String.raw`^[ \t]*from[ \t]+Rhino(\.\w+)?[ \t]+import\b[^\n#]*\b(FileIO|PlugIns|UI|ApplicationSettings|Runtime|Commands|RhinoApp)\b`,
  String.raw`\bRhinoApp\b`,
  String.raw`\.(Command|Exit|OpenFileName|OpenFileNames|SaveFileName|BrowseForFolder|Write3dmFile|WriteFile|ReadFile|Import|Export|SaveAs|Close|Undo|Redo|BeginUndoRecord|EndUndoRecord|ClearUndoRecords|AddCustomUndoEvent)[ \t]*\(`,
];
/** Python that purges (not undoable): held for confirmation like the C# purge. */
export const PYTHON_PURGE = String.raw`\b(Purge\w*|Compact)[ \t]*\(`;

export type ScriptVerdict =
  | { ok: true; guard?: { kind: DirectGuardKind; detail: string } }
  | { ok: false; diagnostics: string[] };

const START_BREAKS = new Set(['enter', 'escape', 'cancel']);
/** The command words of a macro: each with whether it stands where a command starts. */
export function commandWords(script: string) {
  const words: { word: string; start: boolean }[] = [];
  // A quoted string is a value (a name, a path), never a command.
  const tokens = script.replace(/"[^"]*"?/g, ' "" ').split(/(\s+)/);
  let start = true;
  for (const token of tokens) {
    if (!token) continue;
    if (/^\s+$/.test(token)) {
      if (token.includes('\n')) start = true;
      continue;
    }
    if (token === '""') {
      start = false;
      continue;
    }
    const bang = token.startsWith('!');
    const word = token
      .replace(/^[!_\-'&.]+/, '')
      .split('=')[0]!
      .toLowerCase();
    if (word) words.push({ word, start: start || bang });
    start = START_BREAKS.has(word);
  }
  return words;
}
const shown = (word: string) => '_' + word;
/** The policy verdict of a Rhino command macro (before it runs). */
export function checkRhinoCommand(script: string): ScriptVerdict {
  const denied = new Set<string>();
  let guard: { kind: DirectGuardKind; words: string[] } | undefined;
  const hold = (kind: DirectGuardKind, word: string) => {
    if (!guard) guard = { kind, words: [] };
    if (guard.kind === kind) guard.words.push(shown(word));
  };
  for (const { word, start } of commandWords(script)) {
    if (
      COMMAND_DENY.includes(word) ||
      (start && COMMAND_DENY_AT_START.includes(word)) ||
      COMMAND_DENY_PREFIX.some((prefix) => word.startsWith(prefix))
    ) {
      denied.add(word);
      continue;
    }
    const kind =
      COMMAND_CONFIRM[word] ??
      (start ? COMMAND_CONFIRM_AT_START[word] : undefined) ??
      Object.entries(COMMAND_CONFIRM_PREFIX).find(([prefix]) => word.startsWith(prefix))?.[1];
    if (kind) hold(kind, word);
  }
  if (denied.size)
    return {
      ok: false,
      diagnostics: [
        `Rhino command not permitted in VIDE: ${[...denied].map(shown).join(', ')}. Opening, closing or quitting documents, reading files or scripts from disk, application options, plug-ins, units and undo stay with the user; use RhinoCommon C# or another command instead.`,
      ],
    };
  if (guard)
    return {
      ok: true,
      guard: {
        kind: guard.kind,
        detail:
          guard.kind === 'purge'
            ? `사용하지 않는 항목 정리(${guard.words.join(', ')})는 되돌릴 수 없습니다.`
            : `파일을 쓰는 Rhino 명령(${guard.words.join(', ')})을 실행합니다.`,
      },
    };
  return { ok: true };
}
/** The policy verdict of a Python script (before it runs). */
export function checkRhinoPython(source: string): ScriptVerdict {
  const hits = PYTHON_DENY.flatMap((pattern) => {
    const match = new RegExp(pattern, 'm').exec(source);
    return match ? [match[0].trim().slice(0, 80)] : [];
  });
  if (hits.length)
    return {
      ok: false,
      diagnostics: [
        `Python not permitted in VIDE: ${hits.join(' | ')}. No file, network, process, reflection, application, command or undo access; use Rhino, rhinoscriptsyntax and scriptcontext.doc geometry and tables only (Rhino commands go in execute.command).`,
      ],
    };
  if (new RegExp(PYTHON_PURGE, 'm').test(source))
    return {
      ok: true,
      guard: { kind: 'purge', detail: '사용하지 않는 항목 정리(Purge)는 되돌릴 수 없습니다.' },
    };
  return { ok: true };
}
/** The verdict for any execute form (C# is checked by the host's CodePolicy only). */
export function checkExecuteScript(language: ExecuteLanguage, body: string): ScriptVerdict {
  if (language === 'command') return checkRhinoCommand(body);
  if (language === 'python') return checkRhinoPython(body);
  return { ok: true };
}
