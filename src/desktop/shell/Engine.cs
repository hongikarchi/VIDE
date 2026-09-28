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
            process.ErrorDataReceived += (s, e) => { };
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
                if (!stopping && ReferenceEquals(own, process)) Exited?.Invoke(code);
            };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            return ready.Task;
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
