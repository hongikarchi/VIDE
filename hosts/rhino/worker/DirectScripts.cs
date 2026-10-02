using System.Text;
using System.Text.RegularExpressions;
using Rhino;
using Rhino.Runtime.Code;
using Rhino.Runtime.Code.Execution;
using Rhino.Runtime.Code.Languages;

namespace Vide.Worker;

// Rhino command macros and Python 3 scripts in direct mode (ADR-029, user decision 2026-10-02
// "Rhino 명령, Python은 열어줘야지"). Both run inside the execution's undo record like a C# body.
// The policy lists are the engine's (src/contracts/rhino-script-policy.ts), kept identical and
// compared by tests/server/rhino-script-policy.test.mjs. Defence in depth, not an OS boundary.
internal static class DirectScripts
{
    internal static readonly string[] CommandDeny = ["exit", "quit", "open", "worksession", "revert", "runscript", "loadscript", "readcommandfile", "runpythonscript", "editpythonscript", "scripteditor", "rhinocode", "pluginmanager", "loadplugin", "packagemanager", "grasshopperplayer", "readviewsfromfile", "sendmail", "packtextures", "clearundo", "undomultiple", "redomultiple", "undoselected"];
    // Refused anywhere except as an option right after the command that owns it (CommandOptionOwners).
    internal static readonly string[] CommandDenyUnlessOption = ["new", "close", "undo", "redo", "insert"];
    internal static readonly string[] CommandDenyPrefix = ["import"];
    internal static readonly string[] GuardSeverity = ["save", "save-as", "purge", "export", "publish"];
    internal static readonly Dictionary<string, string> CommandConfirm = new() { ["saveas"] = "save-as", ["savesmall"] = "save-as", ["saveastemplate"] = "save-as", ["incrementalsave"] = "save-as", ["viewcapturetofile"] = "export", ["print"] = "publish", ["purge"] = "purge" };
    internal static readonly Dictionary<string, string> CommandConfirmUnlessOption = new() { ["save"] = "save" };
    internal static readonly Dictionary<string, string[]> CommandOptionOwners = new() { ["new"] = ["layer"], ["close"] = ["polyline", "curve", "interpcrv", "interpcrvonsrf"], ["undo"] = ["polyline", "curve", "interpcrv", "interpcrvonsrf", "lines", "points"], ["save"] = ["namedview", "namedcplane", "namedposition", "snapshots"] };
    internal static readonly Dictionary<string, string> CommandConfirmPrefix = new() { ["export"] = "export" };
    internal static readonly string[] PythonDeny =
    [
        @"^[ \t]*(import|from)[ \t]+[^\n#]*\b(os|sys|subprocess|socket|shutil|ctypes|urllib|urllib2|urllib3|http|requests|pathlib|io|glob|tempfile|ftplib|smtplib|multiprocessing|winreg|_winreg|importlib|webbrowser|pickle|marshal|zipfile|tarfile|sqlite3|signal|clr)\b",
        @"(?<![\w.])(open|__import__|exec|eval|compile|execfile)[ \t]*\(",
        @"\bSystem\.(IO|Net|Diagnostics|Reflection|Runtime|Environment|AppDomain|Activator|Type)\b",
        @"^[ \t]*from[ \t]+System(\.\w+)?[ \t]+import\b[^\n#]*\b(IO|Net|Diagnostics|Reflection|Runtime|Environment|AppDomain|Activator|Type)\b",
        @"\bMicrosoft\.Win32\b",
        @"\bRhino\.(FileIO|PlugIns|Runtime)\b",
        @"^[ \t]*from[ \t]+Rhino(\.\w+)?[ \t]+import\b[^\n#]*\b(FileIO|PlugIns|Runtime)\b",
        @"\bRhinoApp\.(RunScript|RunMenuScript|Exit|ExecuteCommand|SendKeystrokes)\b",
        @"\.(Command|Exit|OpenFileName|OpenFileNames|SaveFileName|BrowseForFolder|Write3dmFile|WriteFile|ReadFile|Import|Export|SaveAs|Close|Undo|Redo|BeginUndoRecord|EndUndoRecord|ClearUndoRecords|AddCustomUndoEvent)\b",
        @"(?<![\w.])(Command|Exit)[ \t]*\(",
        @"\.Save\w*[ \t]*\(",
        @"\b__(builtins|subclasses|globals|code|loader|spec)__\b",
        @"^[ \t]*from[ \t]+(rhinoscriptsyntax|rhinoscript)(\.\w+)?[ \t]+import\b[^\n#]*(\*|\b(Command|Exit)\b)",
    ];
    // Same as PYTHON_PURGE (src/contracts/rhino-script-policy.ts): Compact( counts only on a document table or the
    // document; geometry Mesh/Brep.Compact is not a purge. A table bound to an alias is not recognised.
    internal const string PythonPurge = @"\bPurge\w*[ \t]*\(|(?:\.(?:Layers|Materials|Linetypes|InstanceDefinitions|DimStyles|HatchPatterns|Fonts|Groups|Objects|Views|NamedViews|RenderMaterials|Bitmaps|Textures)|\bdoc)\.Compact[ \t]*\(";

    /// <summary>A refusal (diagnostics), a guard to hold (kind, detail) or neither.</summary>
    internal sealed record Verdict(string[]? Denied, string? GuardKind, string? GuardDetail);

    private static readonly HashSet<string> StartBreaks = ["enter", "escape", "cancel", "close"];
    // The macro's words, each with whether it stands where a command starts and the command it
    // follows (the word at the last command position) (engine: commandWords).
    internal static List<(string Word, bool Start, string Command)> CommandWords(string script)
    {
        var words = new List<(string, bool, string)>();
        var tokens = Regex.Split(Regex.Replace(script, "\"[^\"]*\"?", " \"\" "), @"(\s+)");
        var start = true;
        var command = "";
        foreach (var token in tokens)
        {
            if (token.Length == 0) continue;
            if (string.IsNullOrWhiteSpace(token)) { if (token.Contains('\n')) start = true; continue; }
            if (token == "\"\"") { start = false; continue; }
            var bang = token.StartsWith('!');
            var word = token.TrimStart('!', '_', '-', '\'', '&', '.').Split('=')[0].ToLowerInvariant();
            if (word.Length > 0)
            {
                if (start || bang) command = word;
                words.Add((word, start || bang, command));
            }
            start = StartBreaks.Contains(word);
            if (start) command = "";
        }
        return words;
    }

    internal static Verdict CheckCommand(string script)
    {
        var denied = new List<string>();
        var held = new Dictionary<string, List<string>>();
        foreach (var (word, start, command) in CommandWords(script))
        {
            var option = !start && CommandOptionOwners.TryGetValue(word, out var owners) && owners.Contains(command);
            if (CommandDeny.Contains(word) || (!option && CommandDenyUnlessOption.Contains(word)) || CommandDenyPrefix.Any(word.StartsWith))
            { if (!denied.Contains(word)) denied.Add(word); continue; }
            var hit = CommandConfirm.TryGetValue(word, out var k) ? k
                : !option && CommandConfirmUnlessOption.TryGetValue(word, out var s) ? s
                : CommandConfirmPrefix.Where(entry => word.StartsWith(entry.Key)).Select(entry => entry.Value).FirstOrDefault();
            if (hit == null) continue;
            if (!held.TryGetValue(hit, out var list)) held[hit] = list = [];
            list.Add("_" + word);
        }
        if (denied.Count > 0)
            return new([$"Rhino command not permitted in VIDE: {string.Join(", ", denied.Select(w => "_" + w))}. Opening, closing or quitting documents, reading files or scripts from disk, application options, plug-ins, units and undo stay with the user; use RhinoCommon C# or another command instead. New, Close and Undo pass only as an option right after the command that owns it (-Layer New, Polyline Undo/Close); Redo and Insert are always refused."], null, null);
        var kind = GuardSeverity.FirstOrDefault(held.ContainsKey);
        return kind == null ? new(null, null, null) : new(null, kind, GuardDetail(held));
    }

    // Every held word of every kind (engine: guardDetail): the user confirms all of them at once.
    internal static string GuardDetail(Dictionary<string, List<string>> held)
    {
        string List(params string[] kinds) => string.Join(", ", kinds.SelectMany(kind => held.TryGetValue(kind, out var words) ? words : []));
        var parts = new List<string>();
        if (held.ContainsKey("save")) parts.Add($"열린 원본 파일을 덮어씁니다({List("save")}).");
        if (held.ContainsKey("save-as") || held.ContainsKey("export")) parts.Add($"파일을 쓰는 Rhino 명령({List("save-as", "export")})을 실행합니다.");
        if (held.ContainsKey("publish")) parts.Add($"인쇄 명령({List("publish")})을 실행합니다.");
        if (held.ContainsKey("purge")) parts.Add($"사용하지 않는 항목 정리({List("purge")})는 되돌릴 수 없습니다.");
        return string.Join(" ", parts);
    }

    internal static Verdict CheckPython(string source)
    {
        var hits = PythonDeny.Select(pattern => Regex.Match(source, pattern, RegexOptions.Multiline)).Where(m => m.Success)
            .Select(m => m.Value.Trim() is var v && v.Length > 80 ? v[..80] : m.Value.Trim()).ToArray();
        if (hits.Length > 0)
            return new([$"Python not permitted in VIDE: {string.Join(" | ", hits)}. No file, network, process, reflection (getattr, __builtins__), application, command, save or undo access; use Rhino, rhinoscriptsyntax and scriptcontext.doc geometry and tables only (Rhino commands go in execute.command)."], null, null);
        if (Regex.IsMatch(source, PythonPurge, RegexOptions.Multiline))
            return new(null, "purge", "사용하지 않는 항목 정리(Purge)는 되돌릴 수 없습니다.");
        return new(null, null, null);
    }

    /// <summary>Whether a command that started during a run is one the policy refuses (an alias may hide it).</summary>
    internal static bool DeniedCommand(string englishName)
    {
        var name = englishName.ToLowerInvariant();
        return CommandDeny.Contains(name) || CommandDenyUnlessOption.Contains(name) || CommandDenyPrefix.Any(name.StartsWith);
    }
    /// <summary>The guard a command that started during a run trips (save, export, print, purge).</summary>
    internal static string? GuardOfCommand(string englishName)
    {
        var name = englishName.ToLowerInvariant();
        return CommandConfirm.TryGetValue(name, out var kind) ? kind
            : CommandConfirmUnlessOption.TryGetValue(name, out var start) ? start
            : CommandConfirmPrefix.Where(entry => name.StartsWith(entry.Key)).Select(entry => entry.Value).FirstOrDefault();
    }

    // Watches the Rhino commands that start while a script runs: each is logged, and a refused one
    // (or a guarded one the user did not confirm) is a violation the caller turns into a refusal
    // after the run, so the execution's record is undone. RhinoCommon cannot cancel a command
    // from BeginCommand, so a file it already wrote stays written (ADR-029 remaining risk 2).
    private sealed class CommandMonitor : IDisposable
    {
        internal readonly List<string> Started = [];
        internal string? Violation;
        private readonly StringBuilder output;
        private readonly Func<string, bool> refused;
        internal CommandMonitor(StringBuilder output, Func<string, bool> refused)
        {
            this.output = output;
            this.refused = refused;
            Rhino.Commands.Command.BeginCommand += Begin;
            Rhino.Commands.Command.EndCommand += End;
        }
        private void Begin(object? sender, Rhino.Commands.CommandEventArgs e)
        {
            Started.Add(e.CommandEnglishName);
            if (refused(e.CommandEnglishName)) Violation ??= e.CommandEnglishName;
        }
        private void End(object? sender, Rhino.Commands.CommandEventArgs e) => output.AppendLine($"{e.CommandEnglishName}: {e.CommandResult}");
        public void Dispose()
        {
            Rhino.Commands.Command.BeginCommand -= Begin;
            Rhino.Commands.Command.EndCommand -= End;
        }
    }

    /// <summary>Run a command macro in this document; the started commands and their results go to the log.</summary>
    internal static object? RunCommand(RhinoDoc document, string script, StringBuilder output, bool confirmed)
    {
        bool ran;
        string? violation;
        string[] started;
        using (var monitor = new CommandMonitor(output, name => DeniedCommand(name) || (!confirmed && GuardOfCommand(name) != null)))
        {
            ran = RhinoApp.RunScript(document.RuntimeSerialNumber, script, false);
            violation = monitor.Violation;
            started = monitor.Started.Take(50).ToArray();
        }
        if (violation != null) throw new ScriptPolicyException($"Rhino command not permitted in VIDE: {violation} (started through an alias or a nested macro).");
        if (!ran) throw new InvalidOperationException("Rhino did not run the command script (unknown command, or a command needs input the macro did not give).");
        return new { commands = started };
    }

    /// <summary>Run a Rhino 8 Python 3 script; scriptcontext.doc is the document, print() goes to the log.</summary>
    internal static object? RunPython(RhinoDoc document, string source, StringBuilder output)
    {
        if (RhinoDoc.ActiveDoc != document) throw new InvalidOperationException("DOCUMENT_NOT_ACTIVE");
        RhinoCode.Languages.WaitStatusComplete(LanguageSpec.Python3);
        var language = RhinoCode.Languages.QueryLatest(LanguageSpec.Python3)
            ?? throw new InvalidOperationException("Rhino 8 Python 3 is not available in this Rhino (open ScriptEditor once to set it up).");
        var code = language.CreateCode("#! python3\n" + source);
        using var stream = new MemoryStream();
        var context = new RunContext("VIDE AI", false, false)
        {
            OutputStream = stream,
            ErrorStream = stream,
            // The execution's own record holds the changes (one undo step per call).
            RecordDocumentUndo = false,
            AutoApplyParams = false,
        };
        // Python may reach a Rhino command past the static check (an alias of rs.Command, getattr):
        // a refused or guarded command started during the run undoes the record and refuses
        // (Python's only confirmable guard is purge, so a file-writing command is never confirmed here).
        string? violation;
        Exception? error = null;
        using (var monitor = new CommandMonitor(output, name => DeniedCommand(name) || GuardOfCommand(name) != null))
        {
            try { code.Run(context); }
            catch (Exception failure) { error = failure; }
            finally { output.Append(Encoding.UTF8.GetString(stream.ToArray())); }
            violation = monitor.Violation;
        }
        if (violation != null) throw new ScriptPolicyException($"Rhino command not permitted in VIDE: {violation} (started from Python; Rhino commands go in execute.command).");
        if (error != null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error).Throw();
        return null;
    }
}

/// <summary>A run that started a refused command: the record is undone and the AI told why.</summary>
internal sealed class ScriptPolicyException(string message) : Exception(message);
