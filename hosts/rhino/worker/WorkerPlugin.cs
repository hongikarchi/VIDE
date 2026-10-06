using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Rhino;
using Rhino.Commands;
using Rhino.PlugIns;

[assembly: Guid("6BDE756C-CB1F-45BC-90FA-784C098C2C38")]

namespace Vide.Worker;

[Guid("6BDE756C-CB1F-45BC-90FA-784C098C2C38")]
public sealed class WorkerPlugin : PlugIn
{
    protected override LoadReturnCode OnLoad(ref string errorMessage)
    {
        Rhino.UI.Panels.RegisterPanel(this, typeof(ConnectionPanel), "VIDE", GetType().Assembly, string.Empty, Rhino.UI.PanelType.PerDoc);
        PluginLog.Started();
        return LoadReturnCode.Success;
    }
}

/// <summary>
/// The plugin's diagnostic log, logs\rhino-YYYY-MM-DD.jsonl (T-126): plugin and Rhino versions at
/// load, every host call (method, time, sizes, code) and exceptions with their stack. Never
/// document contents.
/// </summary>
internal static class PluginLog
{
    internal static readonly Vide.HostPanel.DiagnosticLog Log = Create();
    private static Vide.HostPanel.DiagnosticLog Create()
    {
        var assembly = typeof(PluginLog).Assembly;
        string built = "";
        try { built = File.GetLastWriteTimeUtc(assembly.Location).ToString("yyyyMMddHHmm"); } catch { /* Unknown build time. */ }
        var log = new Vide.HostPanel.DiagnosticLog("rhino", assembly.GetName().Version + "+" + built);
        // Polled several times a second by the engine: counted per minute unless slow or failed.
        log.Frequent("attachedStatus", "fingerprint", "displayChanges", "inspectEditor", "status");
        return log;
    }
    private static bool started;
    internal static void Started()
    {
        if (started) return;
        started = true;
        Log.Write("plugin-load", new Dictionary<string, object>
        {
            ["rhino"] = RhinoApp.Version.ToString(),
            ["pid"] = Environment.ProcessId,
            ["worker"] = Environment.GetEnvironmentVariable("VIDE_WORKER_SESSION") != null,
        });
        // Exceptions nobody caught whose stack passes through VIDE code.
        AppDomain.CurrentDomain.UnhandledException += (s, e) =>
        {
            if (e.ExceptionObject is Exception error && (error.StackTrace ?? "").Contains("Vide.")) Log.Error("unhandled", error);
        };
        TaskScheduler.UnobservedTaskException += (s, e) =>
        {
            if ((e.Exception.ToString()).Contains("Vide.")) Log.Error("unobserved-task", e.Exception);
        };
    }
}

public sealed class WorkerCommand : Command
{
    public override string EnglishName => "VIDEWorkHost";
    private static TcpListener? listener;
    protected override Result RunCommand(RhinoDoc ignored, RunMode mode)
    {
        if (listener != null) return Result.Success;
        var token = Environment.GetEnvironmentVariable("VIDE_WORKER_TOKEN") ?? "";
        var session = Environment.GetEnvironmentVariable("VIDE_WORKER_SESSION") ?? "";
        var report = Environment.GetEnvironmentVariable("VIDE_WORKER_REPORT") ?? "";
        if (!Guid.TryParse(session, out _) || token.Length != 64 || !Path.IsPathFullyQualified(report)) return Result.Failure;
        var process = Process.GetCurrentProcess();
        var ticks = process.StartTime.ToUniversalTime().Ticks.ToString();
        var source = Environment.GetEnvironmentVariable("VIDE_WORKER_SOURCE") ?? "";
        var editor = Environment.GetEnvironmentVariable("VIDE_WORKER_MODE") == "editor";
        if (editor && (string.IsNullOrEmpty(source) || ignored.Modified || ignored.Objects.Count != 0))
            return StartupFailure(report, "EDITOR_START_REJECTED", null);
        var doc = editor ? RhinoDoc.Open(source, out _) : string.IsNullOrEmpty(source) ? RhinoDoc.CreateHeadless(null) : RhinoDoc.OpenHeadless(source);
        if (doc == null) return StartupFailure(report, "INVALID_GEOMETRY", null);
        if (string.IsNullOrEmpty(source)) doc.ModelUnitSystem = UnitSystem.Meters;
        if (doc.ModelUnitSystem == UnitSystem.None || doc.ModelUnitSystem == UnitSystem.CustomUnits)
            return StartupFailure(report, "UNKNOWN_UNITS", doc);
        if (doc.ModelUnitSystem != UnitSystem.Meters && Environment.GetEnvironmentVariable("VIDE_WORKER_NORMALIZE_UNITS") == "1")
            doc.AdjustModelUnitSystem(UnitSystem.Meters, true);
        if (doc.ModelUnitSystem != UnitSystem.Meters) return StartupFailure(report, "UNKNOWN_UNITS", doc);
        try { if (!editor) WorkerScene.Validate(doc); }
        catch (InvalidOperationException error) { return StartupFailure(report, error.Message, doc); }
        if (!editor) doc.ModelAbsoluteTolerance = 0.001;
        Func<JsonElement, object> dispatch = editor
            ? new EditorExecutor(doc, Path.GetDirectoryName(report)!).Dispatch
            : new WorkerExecutor(doc, Path.GetDirectoryName(report)!).Dispatch;
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        File.WriteAllText(report + ".tmp", JsonSerializer.Serialize(new { port, pid = process.Id, startTicks = ticks,
            sessionId = session, documentId = doc.RuntimeSerialNumber, revision = 0 }));
        File.Move(report + ".tmp", report);
        _ = Task.Run(async () =>
        {
            while (true)
            {
                TcpClient client;
                try { client = await listener.AcceptTcpClientAsync(); } catch { break; }
                _ = Serve(client, token, session, process.Id, ticks, dispatch);
            }
        });
        RhinoApp.WriteLine("VIDE isolated work host ready.");
        return Result.Success;
    }

    private static Result StartupFailure(string report, string code, RhinoDoc? doc)
    {
        doc?.Dispose();
        File.WriteAllText(report + ".error.tmp", JsonSerializer.Serialize(new { code }));
        File.Move(report + ".error.tmp", report + ".error.json", true);
        return Result.Failure;
    }

    /**
     * The one transport cap kept (ADR-031 7): a frame either way is at most 16 MB, so a corrupt length
     * never allocates gigabytes. Processing time is generous; it only ends a lost call.
     */
    internal const int FrameBytes = 16 * 1024 * 1024;
    internal static readonly TimeSpan CallTime = TimeSpan.FromSeconds(600);

    internal static async Task Serve(TcpClient client, string token, string session, int pid, string ticks, Func<JsonElement, object> dispatch)
    {
        using (client)
        using (var timeout = new CancellationTokenSource(CallTime))
        {
            var stream = client.GetStream();
            // Each call's method, time and sizes for the plugin log (T-126); never its content.
            var clock = Stopwatch.StartNew();
            string method = "?";
            long bytesIn = 0, bytesOut = 0;
            try
            {
                var header = new byte[4];
                await stream.ReadExactlyAsync(header, timeout.Token);
                var length = System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(header);
                if (length < 1) return;
                if (length > FrameBytes) throw new InvalidOperationException("HOST_REQUEST_TOO_LARGE");
                bytesIn = length;
                var data = new byte[length];
                await stream.ReadExactlyAsync(data, timeout.Token);
                using var json = JsonDocument.Parse(data);
                var request = json.RootElement.GetProperty("params").Clone();
                if (request.TryGetProperty("method", out var named) && named.ValueKind == JsonValueKind.String) method = named.GetString() ?? "?";
                var supplied = request.GetProperty("token").GetString() ?? "";
                if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied), Encoding.UTF8.GetBytes(token)))
                    throw new InvalidOperationException("UNAUTHORIZED");
                // This trusted entry runs before compilation/loading of any supplied code.
                if (request.GetProperty("sessionId").GetString() != session || request.GetProperty("pid").GetInt32() != pid ||
                    request.GetProperty("startTicks").GetString() != ticks) throw new InvalidOperationException("HOST_OWNERSHIP_MISMATCH");
                var completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                RhinoApp.InvokeOnUiThread(new Action(() =>
                {
                    if (timeout.IsCancellationRequested) { completion.TrySetCanceled(); return; }
                    try { completion.TrySetResult(dispatch(request)); }
                    catch (Exception error) { completion.TrySetException(error); }
                }));
                var result = await completion.Task.WaitAsync(timeout.Token);
                // Heavy work that no longer touches the document runs off Rhino's UI thread.
                if (result is Func<object> deferred) result = await Task.Run(deferred).WaitAsync(timeout.Token);
                if (result is RawFrame frame)
                {
                    bytesOut = frame.Bytes.Length;
                    await Reply(stream, frame.Bytes, timeout.Token);
                    PluginLog.Log.Call(method, clock.Elapsed.TotalMilliseconds, bytesIn, bytesOut);
                    return;
                }
                if (result is RawJson raw)
                {
                    var body = new byte[SuccessPrefix.Length + raw.Bytes.Length + 1];
                    SuccessPrefix.CopyTo(body, 0); raw.Bytes.CopyTo(body, SuccessPrefix.Length); body[^1] = (byte)'}';
                    bytesOut = body.Length;
                    await Reply(stream, body, timeout.Token);
                    PluginLog.Log.Call(method, clock.Elapsed.TotalMilliseconds, bytesIn, bytesOut);
                    return;
                }
                var encoded = JsonSerializer.SerializeToUtf8Bytes(new { status = "success", result });
                bytesOut = encoded.Length;
                await Reply(stream, encoded, timeout.Token);
                PluginLog.Log.Call(method, clock.Elapsed.TotalMilliseconds, bytesIn, bytesOut);
            }
            catch (Exception error)
            {
                string code = error is InvalidOperationException ? error.Message : "HOST_RESULT_UNKNOWN";
                // A coded refusal is a short line; anything else keeps its type and stack.
                bool coded = error is InvalidOperationException && System.Text.RegularExpressions.Regex.IsMatch(code, "^[A-Z][A-Z0-9_]{1,63}$");
                PluginLog.Log.Call(method, clock.Elapsed.TotalMilliseconds, bytesIn, bytesOut, coded ? code : error.GetType().Name, coded ? null : error);
                try { await Reply(stream, new { status = "success", result = new { ok = false,
                    code } }, timeout.Token); } catch { /* Disconnected caller cannot receive the failure; persisted receipt remains authoritative. */ }
            }
        }
    }

    private static readonly byte[] SuccessPrefix = Encoding.UTF8.GetBytes("{\"status\":\"success\",\"result\":");
    private static Task Reply(NetworkStream stream, object result, CancellationToken cancel) =>
        Reply(stream, JsonSerializer.SerializeToUtf8Bytes(result), cancel);

    private static async Task Reply(NetworkStream stream, byte[] body, CancellationToken cancel)
    {
        if (body.Length > FrameBytes) throw new InvalidOperationException("HOST_RESULT_TOO_LARGE");
        var header = new byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(header, body.Length);
        await stream.WriteAsync(header, cancel); await stream.WriteAsync(body, cancel);
    }
}
