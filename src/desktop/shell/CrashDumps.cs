using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

namespace Vide.Desktop
{
    /// <summary>
    /// Crash dumps of the engine for diagnosis (PLAN-27 §0): engine deaths with 0xC0000409 leave no
    /// Windows error report, so when the user placed Sysinternals ProcDump in &lt;data&gt;\tools it is
    /// attached to every engine process. It writes a dump on an unhandled exception only (-e). Dumps
    /// are full (-ma: threads, modules and memory, T-125 — the -mp dumps of 2026-10-02 had empty
    /// thread and module lists), so only the newest three are kept. Each written dump's path goes to
    /// the shell log. Without the tool nothing happens.
    ///
    /// No termination monitor (-t, T-191): it dumped every normal quit (230–785 MB, exit code 0) and
    /// those pushed the real crash dumps out of the three kept. -e alone still catches the libuv
    /// fail-fast: a __fastfail / stack-buffer-overrun reaches an attached debugger as a second-chance
    /// 0xC0000409, and procdump.log of 2026-10-02..06 shows every one of those crashes as
    /// "Unhandled: C0000409" from the exception monitor (the dumps kept are those), never from -t.
    /// A kill from outside leaves no dump; its exit code is in engine-exits.jsonl.
    /// </summary>
    internal static class CrashDumps
    {
        private const int Keep = 3;
        private static string Folder => Path.Combine(Paths.Data, "crashdumps");
        /// <summary>Left by versions before T-191, which dumped every exit too.</summary>
        private static string AskedFile => Path.Combine(Folder, "asked-stop.txt");

        /// <summary>ProcDump's arguments: full dump on an unhandled exception, no termination dump.</summary>
        internal static string Arguments(int pid, string folder) =>
            "-accepteula -e -ma " + pid + " \"" + folder + "\"";

        public static void Attach(int pid)
        {
            try
            {
                string tool = Path.Combine(Paths.Data, "tools", Environment.Is64BitOperatingSystem ? "procdump64.exe" : "procdump.exe");
                if (!File.Exists(tool)) return;
                Directory.CreateDirectory(Folder);
                Prune();
                var start = new ProcessStartInfo(tool, Arguments(pid, Folder))
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    // ProcDump writes its console text as UTF-16.
                    StandardOutputEncoding = System.Text.Encoding.Unicode,
                    StandardErrorEncoding = System.Text.Encoding.Unicode,
                };
                var dumper = new Process { StartInfo = start };
                dumper.OutputDataReceived += (s, e) => Log(e.Data);
                dumper.ErrorDataReceived += (s, e) => Log(e.Data);
                dumper.Start();
                dumper.BeginOutputReadLine();
                dumper.BeginErrorReadLine();
                Log("attached to engine pid " + pid);
                ShellLog.Write("procdump-attach", new System.Collections.Generic.Dictionary<string, object> { ["pid"] = pid, ["mode"] = "ma", ["keep"] = Keep });
            }
            catch (Exception error)
            {
                Log("attach failed: " + error.Message);
                ShellLog.Error("procdump-attach-failed", error);
            }
        }

        private static void Prune()
        {
            var dumps = new DirectoryInfo(Folder).GetFiles("*.dmp").OrderByDescending(f => f.LastWriteTimeUtc).ToList();
            try { if (File.Exists(AskedFile)) File.Delete(AskedFile); } catch { /* Next time. */ }
            foreach (var old in dumps.Skip(Keep))
            {
                try { old.Delete(); } catch { /* In use: next time. */ }
            }
        }

        private static void Log(string line)
        {
            if (string.IsNullOrWhiteSpace(line)) return;
            // ProcDump names each dump it starts ("Dump 1 initiated: C:\…\node.exe_….dmp") and then
            // reports it complete ("Dump 1 complete: 812 MB written in 3.1 seconds").
            var dump = System.Text.RegularExpressions.Regex.Match(line, @"([A-Za-z]:\\[^""]*?\.dmp)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (dump.Success)
                ShellLog.Write("crash-dump", new System.Collections.Generic.Dictionary<string, object> { ["path"] = dump.Groups[1].Value }, true);
            else if (System.Text.RegularExpressions.Regex.IsMatch(line, @"Dump \d+ complete", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                ShellLog.Write("crash-dump-complete", new System.Collections.Generic.Dictionary<string, object> { ["report"] = line.Trim() }, true);
            try
            {
                string folder = Path.Combine(Paths.Data, "logs");
                Directory.CreateDirectory(folder);
                File.AppendAllText(Path.Combine(folder, "procdump.log"),
                    DateTime.UtcNow.ToString("o") + " " + line.Trim() + Environment.NewLine);
            }
            catch
            {
                // Diagnostics never stop the program.
            }
        }
    }
}
