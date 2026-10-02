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
    internal static readonly string[] CommandDeny = ["exit", "quit", "open", "worksession", "revert", "runscript", "loadscript", "readcommandfile", "runpythonscript", "editpythonscript", "scripteditor", "rhinocode", "options", "documentproperties", "units", "pluginmanager", "loadplugin", "packagemanager", "grasshopper", "grasshopperplayer", "readviewsfromfile", "sendmail", "packtextures", "clearundo", "undomultiple", "redomultiple", "undoselected", "pause", "multipause"];
    internal static readonly string[] CommandDenyAtStart = ["new", "close", "undo", "redo", "insert"];
    internal static readonly string[] CommandDenyPrefix = ["import"];
    internal static readonly Dictionary<string, string> CommandConfirm = new() { ["saveas"] = "save-as", ["savesmall"] = "save-as", ["saveastemplate"] = "save-as", ["incrementalsave"] = "save-as", ["viewcapturetofile"] = "export", ["print"] = "publish", ["purge"] = "purge" };
    internal static readonly Dictionary<string, string> CommandConfirmAtStart = new() { ["save"] = "save-as" };
    internal static readonly Dictionary<string, string> CommandConfirmPrefix = new() { ["export"] = "export" };
    internal static readonly string[] PythonDeny =
    [
        @"^[ \t]*(import|from)[ \t]+[^\n#]*\b(os|sys|subprocess|socket|shutil|ctypes|urllib|urllib2|urllib3|http|requests|pathlib|io|glob|tempfile|ftplib|smtplib|multiprocessing|threading|asyncio|winreg|_winreg|importlib|webbrowser|pickle|marshal|zipfile|tarfile|sqlite3|signal|clr)\b",
        @"(?<![\w.])(open|__import__|exec|eval|compile|execfile|input|raw_input|breakpoint)[ \t]*\(",
        @"\bSystem\.(IO|Net|Diagnostics|Reflection|Threading|Runtime|Environment|AppDomain|Activator|Type)\b",
        @"^[ \t]*from[ \t]+System(\.\w+)?[ \t]+import\b[^\n#]*\b(IO|Net|Diagnostics|Reflection|Threading|Runtime|Environment|AppDomain|Activator|Type)\b",
        @"\bMicrosoft\.Win32\b",
        @"\bRhino\.(FileIO|PlugIns|UI|ApplicationSettings|Runtime|Commands)\b",
        @"^[ \t]*from[ \t]+Rhino(\.\w+)?[ \t]+import\b[^\n#]*\b(FileIO|PlugIns|UI|ApplicationSettings|Runtime|Commands|RhinoApp)\b",
        @"\bRhinoApp\b",
        @"\.(Command|Exit|OpenFileName|OpenFileNames|SaveFileName|BrowseForFolder|Write3dmFile|WriteFile|ReadFile|Import|Export|SaveAs|Close|Undo|Redo|BeginUndoRecord|EndUndoRecord|ClearUndoRecords|AddCustomUndoEvent)[ \t]*\(",
    ];
    internal const string PythonPurge = @"\b(Purge\w*|Compact)[ \t]*\(";

    /// <summary>A refusal (diagnostics), a guard to hold (kind, detail) or neither.</summary>
    internal sealed record Verdict(string[]? Denied, string? GuardKind, string? GuardDetail);

    private static readonly HashSet<string> StartBreaks = ["enter", "escape", "cancel"];
    // The macro's words, each with whether it stands where a command starts (engine: commandWords).
    internal static List<(string Word, bool Start)> CommandWords(string script)
    {
        var words = new List<(string, bool)>();
        var tokens = Regex.Split(Regex.Replace(script, "\"[^\"]*\"?", " \"\" "), @"(\s+)");
        var start = true;
        foreach (var token in tokens)
        {
            if (token.Length == 0) continue;
            if (string.IsNullOrWhiteSpace(token)) { if (token.Contains('\n')) start = true; continue; }
            if (token == "\"\"") { start = false; continue; }
            var bang = token.StartsWith('!');
            var word = token.TrimStart('!', '_', '-', '\'', '&', '.').Split('=')[0].ToLowerInvariant();
            if (word.Length > 0) words.Add((word, start || bang));
            start = StartBreaks.Contains(word);
        }
        return words;
    }

    internal static Verdict CheckCommand(string script)
    {
        var denied = new List<string>();
        string? kind = null;
        var held = new List<string>();
        foreach (var (word, start) in CommandWords(script))
        {
            if (CommandDeny.Contains(word) || (start && CommandDenyAtStart.Contains(word)) || CommandDenyPrefix.Any(word.StartsWith))
            { if (!denied.Contains(word)) denied.Add(word); continue; }
            var hit = CommandConfirm.TryGetValue(word, out var k) ? k
                : start && CommandConfirmAtStart.TryGetValue(word, out var s) ? s
                : CommandConfirmPrefix.Where(entry => word.StartsWith(entry.Key)).Select(entry => entry.Value).FirstOrDefault();
            if (hit == null) continue;
            kind ??= hit;
            if (kind == hit) held.Add("_" + word);
        }
        if (denied.Count > 0)
            return new([$"Rhino command not permitted in VIDE: {string.Join(", ", denied.Select(w => "_" + w))}. Opening, closing or quitting documents, reading files or scripts from disk, application options, plug-ins, units and undo stay with the user; use RhinoCommon C# or another command instead."], null, null);
        if (kind != null)
            return new(null, kind, kind == "purge" ? $"사용하지 않는 항목 정리({string.Join(", ", held)})는 되돌릴 수 없습니다." : $"파일을 쓰는 Rhino 명령({string.Join(", ", held)})을 실행합니다.");
        return new(null, null, null);
    }

    internal static Verdict CheckPython(string source)
    {
        var hits = PythonDeny.Select(pattern => Regex.Match(source, pattern, RegexOptions.Multiline)).Where(m => m.Success)
            .Select(m => m.Value.Trim() is var v && v.Length > 80 ? v[..80] : m.Value.Trim()).ToArray();
        if (hits.Length > 0)
            return new([$"Python not permitted in VIDE: {string.Join(" | ", hits)}. No file, network, process, reflection, application, command or undo access; use Rhino, rhinoscriptsyntax and scriptcontext.doc geometry and tables only (Rhino commands go in execute.command)."], null, null);
        if (Regex.IsMatch(source, PythonPurge, RegexOptions.Multiline))
            return new(null, "purge", "사용하지 않는 항목 정리(Purge)는 되돌릴 수 없습니다.");
        return new(null, null, null);
    }

    /// <summary>Whether a command that started during a run is one the policy refuses (an alias may hide it).</summary>
    internal static bool DeniedCommand(string englishName)
    {
        var name = englishName.ToLowerInvariant();
        return CommandDeny.Contains(name) || CommandDenyAtStart.Contains(name) || CommandDenyPrefix.Any(name.StartsWith);
    }
    /// <summary>The guard a command that started during a run trips (save, export, print, purge).</summary>
    internal static string? GuardOfCommand(string englishName)
    {
        var name = englishName.ToLowerInvariant();
        return CommandConfirm.TryGetValue(name, out var kind) ? kind
            : CommandConfirmAtStart.TryGetValue(name, out var start) ? start
            : CommandConfirmPrefix.Where(entry => name.StartsWith(entry.Key)).Select(entry => entry.Value).FirstOrDefault();
    }

    /// <summary>Run a command macro in this document; the started commands and their results go to the log.</summary>
    internal static object? RunCommand(RhinoDoc document, string script, StringBuilder output, bool confirmed)
    {
        var started = new List<string>();
        string? violation = null;
        void Begin(object? sender, Rhino.Commands.CommandEventArgs e)
        {
            started.Add(e.CommandEnglishName);
            if (DeniedCommand(e.CommandEnglishName) || (!confirmed && GuardOfCommand(e.CommandEnglishName) != null))
                violation ??= e.CommandEnglishName;
        }
        void End(object? sender, Rhino.Commands.CommandEventArgs e) => output.AppendLine($"{e.CommandEnglishName}: {e.CommandResult}");
        Rhino.Commands.Command.BeginCommand += Begin;
        Rhino.Commands.Command.EndCommand += End;
        bool ran;
        try { ran = RhinoApp.RunScript(document.RuntimeSerialNumber, script, false); }
        finally
        {
            Rhino.Commands.Command.BeginCommand -= Begin;
            Rhino.Commands.Command.EndCommand -= End;
        }
        if (violation != null) throw new ScriptPolicyException($"Rhino command not permitted in VIDE: {violation} (started through an alias or a nested macro).");
        if (!ran) throw new InvalidOperationException("Rhino did not run the command script (unknown command, or a command needs input the macro did not give).");
        return new { commands = started.Take(50).ToArray() };
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
        try { code.Run(context); }
        finally { output.Append(Encoding.UTF8.GetString(stream.ToArray())); }
        return null;
    }
}

/// <summary>A run that started a refused command: the record is undone and the AI told why.</summary>
internal sealed class ScriptPolicyException(string message) : Exception(message);
