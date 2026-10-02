#nullable disable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

namespace Vide.HostPanel
{
    /// <summary>
    /// The diagnostic log of a VIDE part outside the engine (T-126, ADR-031 9), shared by the Rhino
    /// plugin, the ZWCAD plugin and the PC program: one JSON line per event in
    /// &lt;data&gt;\logs\&lt;name&gt;-YYYY-MM-DD.jsonl next to the engine's log, with the part's version (v)
    /// and this process's session id (sid). Lines are gathered and appended together once a second
    /// on a pool thread (never on the caller's thread); an exception or the process ending writes
    /// what is gathered at once. A day's file stops at 32 MB with one notice line. Files older than 14
    /// days are removed. Method names, times, sizes, codes and exception stacks only — never document
    /// contents, request text or keys. Logging never throws.
    /// </summary>
    internal sealed class DiagnosticLog
    {
        private const long DayCap = 32L * 1024 * 1024;
        private const int KeepDays = 14;
        private readonly string name;
        private readonly string version;
        private readonly string folder;
        private readonly string session = Guid.NewGuid().ToString("N").Substring(0, 8);
        private readonly object gate = new object();
        private readonly StringBuilder pending = new StringBuilder();
        private readonly Timer timer;
        private string day = "";
        private string pendingDay = "";
        private long size;
        private bool capped;
        private bool scheduled;

        public DiagnosticLog(string name, string version, string folder = null)
        {
            this.name = name;
            this.version = version ?? "unknown";
            this.folder = folder ?? DefaultFolder();
            timer = new Timer(_ => Flush(), null, Timeout.Infinite, Timeout.Infinite);
            AppDomain.CurrentDomain.ProcessExit += (s, e) => Flush();
            AppDomain.CurrentDomain.DomainUnload += (s, e) => Flush();
        }

        /// <summary>&lt;data&gt;\logs: the folder of the engine's logs (VIDE_DATA_DIR, else %LOCALAPPDATA%\VIDE).</summary>
        public static string DefaultFolder()
        {
            string data = Environment.GetEnvironmentVariable("VIDE_DATA_DIR");
            if (string.IsNullOrWhiteSpace(data))
                data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VIDE");
            return Path.Combine(data, "logs");
        }

        /// <summary>Adds one line; `now` writes it (and what is gathered) before returning.</summary>
        public void Write(string evt, IDictionary<string, object> fields = null, bool now = false)
        {
            try
            {
                var utc = DateTime.UtcNow;
                string today = utc.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                var line = new StringBuilder(160);
                line.Append("{\"at\":").Append(Quote(utc.ToString("o", CultureInfo.InvariantCulture)))
                    .Append(",\"v\":").Append(Quote(version))
                    .Append(",\"sid\":").Append(Quote(session))
                    .Append(",\"event\":").Append(Quote(evt));
                if (fields != null)
                    foreach (var field in fields)
                        if (field.Value != null) line.Append(',').Append(Quote(field.Key)).Append(':').Append(Value(field.Value));
                line.Append("}\n");
                lock (gate)
                {
                    if (today != day) StartDay(today, utc);
                    if (size + line.Length > DayCap)
                    {
                        if (!capped)
                        {
                            capped = true;
                            Push(today, "{\"at\":" + Quote(utc.ToString("o", CultureInfo.InvariantCulture)) + ",\"v\":" + Quote(version)
                                + ",\"sid\":" + Quote(session) + ",\"event\":\"log-cap\",\"capBytes\":" + DayCap + "}\n");
                        }
                        return;
                    }
                    size += line.Length;
                    Push(today, line.ToString());
                    if (!now && !scheduled)
                    {
                        scheduled = true;
                        timer.Change(1000, Timeout.Infinite);
                    }
                }
                if (now) Flush();
            }
            catch
            {
                // Diagnostics never break the host.
            }
        }

        /// <summary>An exception with its type, message and a bounded stack (`now`: written at once).</summary>
        public void Error(string evt, Exception error, IDictionary<string, object> fields = null)
        {
            var all = fields != null ? new Dictionary<string, object>(fields) : new Dictionary<string, object>();
            if (error != null)
            {
                all["type"] = error.GetType().FullName;
                all["message"] = Cut(error.Message, 1000);
                all["stack"] = Cut(error.StackTrace ?? "", 4000);
                if (error.InnerException != null)
                    all["inner"] = error.InnerException.GetType().FullName + ": " + Cut(error.InnerException.Message, 500);
            }
            Write(evt, all, true);
        }

        /// <summary>Appends the gathered lines now.</summary>
        public void Flush()
        {
            string text, target;
            lock (gate)
            {
                scheduled = false;
                if (pending.Length == 0) return;
                text = pending.ToString();
                target = pendingDay;
                pending.Clear();
            }
            // The file write (with its brief retries) never holds the caller's lock.
            lock (writeGate) Append(target, text);
        }
        private readonly object writeGate = new object();

        /// <summary>Methods asked many times a second (status polls): summed once a minute unless slow or failed.</summary>
        private readonly HashSet<string> frequent = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<string, long[]> sums = new Dictionary<string, long[]>(StringComparer.Ordinal);
        private DateTime summedSince = DateTime.UtcNow;

        /// <summary>Names methods that are summed per minute instead of one line per call.</summary>
        public void Frequent(params string[] methods)
        {
            lock (gate) foreach (string method in methods) frequent.Add(method);
        }

        /// <summary>
        /// One host call: its method, time, request and answer sizes and, when it failed, the code and
        /// the exception. A frequent method's quick successful calls are only counted.
        /// </summary>
        public void Call(string method, double ms, long bytesIn, long bytesOut, string code = null, Exception error = null)
        {
            try
            {
                method = Cut(method ?? "?", 60);
                bool failed = code != null || error != null;
                Dictionary<string, object> summary = null;
                lock (gate)
                {
                    if (!failed && ms < 500 && frequent.Contains(method))
                    {
                        if (!sums.TryGetValue(method, out long[] sum)) sums[method] = sum = new long[3];
                        sum[0]++;
                        sum[1] += (long)ms;
                        sum[2] = Math.Max(sum[2], (long)ms);
                    }
                    if (sums.Count > 0 && (DateTime.UtcNow - summedSince).TotalSeconds >= 60)
                    {
                        summary = new Dictionary<string, object>();
                        foreach (var entry in sums)
                            summary[entry.Key] = entry.Value[0] + " calls, " + entry.Value[1] + " ms, max " + entry.Value[2] + " ms";
                        sums.Clear();
                        summedSince = DateTime.UtcNow;
                    }
                }
                if (summary != null) Write("calls-summary", summary);
                if (!failed && ms < 500 && frequent.Contains(method)) return;
                var fields = new Dictionary<string, object>
                {
                    ["method"] = method,
                    ["ms"] = Math.Round(ms),
                    ["bytesIn"] = bytesIn,
                    ["bytesOut"] = bytesOut,
                    ["ok"] = !failed,
                };
                if (code != null) fields["code"] = Cut(code, 80);
                if (error != null) Error("call", error, fields);
                else Write("call", fields);
            }
            catch
            {
                // Diagnostics never break the host.
            }
        }

        private void Push(string today, string line)
        {
            if (pendingDay != today && pending.Length > 0)
            {
                // A new day: the earlier lines go to their own day's file first.
                string text = pending.ToString();
                pending.Clear();
                Append(pendingDay, text);
            }
            pendingDay = today;
            pending.Append(line);
        }

        /// <summary>
        /// Appends to the day's file. Several processes (the user's Rhino and work copies) share one
        /// file: a write that finds the file open in another process waits briefly and tries again.
        /// </summary>
        private void Append(string target, string text)
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(text);
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    Directory.CreateDirectory(folder);
                    using (var file = new FileStream(Path.Combine(folder, name + "-" + target + ".jsonl"), FileMode.Append, FileAccess.Write, FileShare.Read))
                        file.Write(bytes, 0, bytes.Length);
                    return;
                }
                catch (IOException)
                {
                    Thread.Sleep(15);
                }
                catch
                {
                    return; // Diagnostics never break the host.
                }
            }
        }

        private void StartDay(string today, DateTime utc)
        {
            day = today;
            capped = false;
            try
            {
                Directory.CreateDirectory(folder);
                string file = Path.Combine(folder, name + "-" + today + ".jsonl");
                size = File.Exists(file) ? new FileInfo(file).Length : 0;
                string oldest = utc.AddDays(-KeepDays).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                foreach (string path in Directory.GetFiles(folder, name + "-*.jsonl"))
                {
                    string stem = Path.GetFileNameWithoutExtension(path);
                    string date = stem.Length >= 10 ? stem.Substring(stem.Length - 10) : "";
                    if (date.Length == 10 && date[4] == '-' && string.CompareOrdinal(date, oldest) < 0)
                        try { File.Delete(path); } catch { /* In use: next day. */ }
                }
            }
            catch
            {
                size = 0;
            }
        }

        private static string Cut(string text, int limit) => text == null ? null : text.Length > limit ? text.Substring(0, limit) : text;

        private static string Value(object value)
        {
            switch (value)
            {
                case bool flag: return flag ? "true" : "false";
                case int or long or short or byte or uint or ulong: return Convert.ToString(value, CultureInfo.InvariantCulture);
                case double number: return double.IsNaN(number) || double.IsInfinity(number) ? "null" : Math.Round(number, 3).ToString(CultureInfo.InvariantCulture);
                case float single: return Value((double)single);
                default: return Quote(Convert.ToString(value, CultureInfo.InvariantCulture));
            }
        }

        private static string Quote(string text)
        {
            var quoted = new StringBuilder((text?.Length ?? 0) + 2);
            quoted.Append('"');
            foreach (char c in text ?? "")
            {
                switch (c)
                {
                    case '"': quoted.Append("\\\""); break;
                    case '\\': quoted.Append("\\\\"); break;
                    case '\n': quoted.Append("\\n"); break;
                    case '\r': quoted.Append("\\r"); break;
                    case '\t': quoted.Append("\\t"); break;
                    default:
                        if (c < 0x20) quoted.Append("\\u").Append(((int)c).ToString("x4"));
                        else quoted.Append(c);
                        break;
                }
            }
            return quoted.Append('"').ToString();
        }
    }
}
