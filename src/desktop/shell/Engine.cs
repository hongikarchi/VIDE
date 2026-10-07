using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Vide.Desktop
{
    /// <summary>
    /// The local work engine (Node): started as a child process, stopped by closing its standard
    /// input so it finishes or interrupts running work cleanly and keeps every record.
    /// </summary>
    internal sealed class Engine
    {
        private Process process;
        private bool stopping;
        public string Url { get; private set; }
        /// <summary>True when another engine already served this data folder and we only attached.</summary>
        public bool Attached { get; private set; }
        /// <summary>When the current engine process was started (UTC).</summary>
        public DateTime StartedAt { get; private set; }
        public event Action<int> Exited;

        public Task<string> Start()
        {
            stopping = false;
            Attached = false;
            var ready = new TaskCompletionSource<string>();
            string main = Path.Combine(Paths.App, "src", "server", "main.ts");
            if (!File.Exists(main)) throw new FileNotFoundException("VIDE engine is missing", main);
            var start = new ProcessStartInfo(Paths.Node, "\"" + main + "\" --parent-stdin --no-browser")
            {
                WorkingDirectory = Paths.App,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.EnvironmentVariables.Remove("NODE_OPTIONS");
            start.EnvironmentVariables.Remove("NODE_PATH");
            start.EnvironmentVariables["VIDE_DESKTOP"] = "1";
            start.EnvironmentVariables["VIDE_DESKTOP_VERSION"] = Paths.Version;
            var started = DateTime.UtcNow;
            StartedAt = started;
            process = new Process { StartInfo = start, EnableRaisingEvents = true };
            process.OutputDataReceived += (s, e) =>
            {
                var match = e.Data == null ? null : Regex.Match(e.Data, @"VIDE local workspace: (\S+)");
                if (match != null && match.Success)
                {
                    Url = match.Groups[1].Value;
                    ready.TrySetResult(Url);
                }
            };
            // The engine's error output (warnings, crash traces) goes to the diagnostic logs folder
            // instead of being dropped: logs\engine-stderr-YYYY-MM-DD.log, pruned with the JSON logs.
            process.ErrorDataReceived += (s, e) => AppendError(e.Data);
            var own = process;
            process.Exited += (s, e) =>
            {
                int code = SafeExitCode(own);
                if (!ready.Task.IsCompleted)
                {
                    // Another engine already serves this data folder: use it instead of failing.
                    string error = ReadStartupError(started);
                    string running = error == "CONTROLLER_BUSY" ? ReadLaunchUrl() : null;
                    if (running != null)
                    {
                        Attached = true;
                        Url = running;
                        ready.TrySetResult(running);
                    }
                    else ready.TrySetException(new EngineException(error ?? "STARTUP_FAILED"));
                    return;
                }
                // Every exit with its code: a native crash (0xC0000005…), a kill (1, 0xFFFFFFFF)
                // and a console event (0xC000013A) leave no other trace (RESEARCH-13 §1).
                AppendExit(own, code, started, stopping);
                if (!stopping && ReferenceEquals(own, process)) Exited?.Invoke(code);
            };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            ShellLog.Write("engine-start", new System.Collections.Generic.Dictionary<string, object> { ["pid"] = process.Id });
            CrashDumps.Attach(process.Id);
            return ready.Task;
        }

        /// <summary>Hex form of an exit code as Windows reports it (0xC0000005 for an access violation).</summary>
        public static string Hex(int code) => "0x" + code.ToString("X8");

        private static void AppendExit(Process own, int code, DateTime started, bool asked)
        {
            try
            {
                int pid = -1;
                try { pid = own.Id; } catch { /* Gone before we asked. */ }
                ShellLog.Write("engine-exit", new System.Collections.Generic.Dictionary<string, object>
                {
                    ["pid"] = pid,
                    ["code"] = code,
                    ["hex"] = Hex(code),
                    ["uptimeSec"] = (int)(DateTime.UtcNow - started).TotalSeconds,
                    ["asked"] = asked,
                }, true);
                string line = "{\"at\":\"" + DateTime.UtcNow.ToString("o") + "\",\"event\":\"engine-exit\",\"pid\":" + pid
                    + ",\"code\":" + code + ",\"hex\":\"" + Hex(code) + "\",\"uptimeSec\":"
                    + (int)(DateTime.UtcNow - started).TotalSeconds + ",\"asked\":" + (asked ? "true" : "false") + "}";
                string folder = Path.Combine(Paths.Data, "logs");
                lock (ErrorLock)
                {
                    Directory.CreateDirectory(folder);
                    File.AppendAllText(Path.Combine(folder, "engine-exits.jsonl"), line + Environment.NewLine);
                }
            }
            catch
            {
                // Logging never stops the program.
            }
        }

        private static readonly object ErrorLock = new object();
        private static void AppendError(string line)
        {
            if (string.IsNullOrEmpty(line)) return;
            try
            {
                string folder = Path.Combine(Paths.Data, "logs");
                lock (ErrorLock)
                {
                    Directory.CreateDirectory(folder);
                    File.AppendAllText(
                        Path.Combine(folder, "engine-stderr-" + DateTime.UtcNow.ToString("yyyy-MM-dd") + ".log"),
                        DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine);
                }
            }
            catch
            {
                // Logging never stops the program.
            }
        }

        public void Stop()
        {
            stopping = true;
            var current = process;
            if (current == null) return;
            try
            {
                if (!current.HasExited)
                {
                    current.StandardInput.Close();
                    if (!current.WaitForExit(15000)) current.Kill();
                }
            }
            catch (InvalidOperationException)
            {
                /* Already gone. */
            }
            process = null;
        }

        private static int SafeExitCode(Process value)
        {
            try { return value.ExitCode; } catch { return -1; }
        }

        private static string ReadStartupError(DateTime since)
        {
            string file = Path.Combine(Paths.Data, "startup-error.json");
            try
            {
                if (!File.Exists(file) || File.GetLastWriteTimeUtc(file) < since.AddSeconds(-2)) return null;
                var match = Regex.Match(File.ReadAllText(file), "\"code\"\\s*:\\s*\"([A-Z_]+)\"");
                return match.Success ? match.Groups[1].Value : null;
            }
            catch { return null; }
        }

        private static string ReadLaunchUrl()
        {
            try
            {
                var match = Regex.Match(File.ReadAllText(Path.Combine(Paths.Data, "launch.json")), "\"url\"\\s*:\\s*\"([^\"]+)\"");
                return match.Success ? match.Groups[1].Value : null;
            }
            catch { return null; }
        }
    }

    internal sealed class EngineException : Exception
    {
        public string Code { get; }
        public EngineException(string code) : base(code) { Code = code; }
    }
}
