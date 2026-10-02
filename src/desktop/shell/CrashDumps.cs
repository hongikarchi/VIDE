using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

namespace Vide.Desktop
{
    /// <summary>
    /// Crash dumps of the engine for diagnosis (PLAN-27 §0): engine deaths with 0xC0000409 leave no
    /// Windows error report, so when the user placed Sysinternals ProcDump in &lt;data&gt;\tools it is
    /// attached to every engine process. It writes a dump on an unhandled exception (a fail-fast
    /// included) and on termination (a kill from outside). Dumps of exits VIDE asked for are removed
    /// on the next start; the newest five dumps are kept. Without the tool nothing happens.
    /// </summary>
    internal static class CrashDumps
    {
        private const int Keep = 5;
        private static string Folder => Path.Combine(Paths.Data, "crashdumps");
        private static string AskedFile => Path.Combine(Folder, "asked-stop.txt");

        public static void Attach(int pid)
        {
            try
            {
                string tool = Path.Combine(Paths.Data, "tools", Environment.Is64BitOperatingSystem ? "procdump64.exe" : "procdump.exe");
                if (!File.Exists(tool)) return;
                Directory.CreateDirectory(Folder);
                Prune();
                var start = new ProcessStartInfo(tool, "-accepteula -e -t -mp " + pid + " \"" + Folder + "\"")
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
            }
            catch (Exception error)
            {
                Log("attach failed: " + error.Message);
            }
        }

        /// <summary>VIDE is stopping the engine itself: the termination dump that follows is not a crash.</summary>
        public static void MarkAskedStop()
        {
            try
            {
                if (Directory.Exists(Folder)) File.WriteAllText(AskedFile, DateTime.UtcNow.ToString("o"));
            }
            catch
            {
                // Diagnostics never stop the program.
            }
        }

        private static void Prune()
        {
            var dumps = new DirectoryInfo(Folder).GetFiles("*.dmp").OrderByDescending(f => f.LastWriteTimeUtc).ToList();
            if (File.Exists(AskedFile) && DateTime.TryParse(File.ReadAllText(AskedFile).Trim(), null,
                System.Globalization.DateTimeStyles.RoundtripKind, out DateTime asked))
            {
                foreach (var dump in dumps.Where(f => f.LastWriteTimeUtc >= asked.AddSeconds(-2) && f.LastWriteTimeUtc <= asked.AddSeconds(60)).ToList())
                {
                    try { dump.Delete(); dumps.Remove(dump); } catch { /* In use: next time. */ }
                }
                File.Delete(AskedFile);
            }
            foreach (var old in dumps.Skip(Keep))
            {
                try { old.Delete(); } catch { /* In use: next time. */ }
            }
        }

        private static void Log(string line)
        {
            if (string.IsNullOrWhiteSpace(line)) return;
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
