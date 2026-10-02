using System;
using System.Collections.Generic;
using System.IO;
using Vide.HostPanel;

namespace Vide.Desktop
{
    /// <summary>
    /// The PC program's diagnostic log, logs\shell-YYYY-MM-DD.jsonl (T-126): start and quit, tray
    /// actions, update checks and applies, engine starts, exits and restarts, WebView failures and
    /// reloads, crash dumps. States, codes and times only.
    /// </summary>
    internal static class ShellLog
    {
        private static readonly DiagnosticLog Log = new DiagnosticLog("shell", Paths.Version, Path.Combine(Paths.Data, "logs"));

        public static void Write(string evt, Dictionary<string, object> fields = null, bool now = false) => Log.Write(evt, fields, now);

        public static void Error(string evt, Exception error, Dictionary<string, object> fields = null) => Log.Error(evt, error, fields);

        public static void Tray(string action) => Log.Write("tray", new Dictionary<string, object> { ["action"] = action });

        public static void Flush() => Log.Flush();

        /// <summary>Shell exceptions nobody caught, written before the process ends (behaviour unchanged).</summary>
        public static void Watch()
        {
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                if (e.ExceptionObject is Exception error) Log.Error("shell-unhandled", error);
            };
        }
    }
}
