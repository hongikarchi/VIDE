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
        return LoadReturnCode.Success;
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
            try
            {
                var header = new byte[4];
                await stream.ReadExactlyAsync(header, timeout.Token);
                var length = System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(header);
                if (length < 1) return;
                if (length > FrameBytes) throw new InvalidOperationException("HOST_REQUEST_TOO_LARGE");
                var data = new byte[length];
                await stream.ReadExactlyAsync(data, timeout.Token);
                using var json = JsonDocument.Parse(data);
                var request = json.RootElement.GetProperty("params").Clone();
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
                if (result is RawJson raw)
                {
                    var body = new byte[SuccessPrefix.Length + raw.Bytes.Length + 1];
                    SuccessPrefix.CopyTo(body, 0); raw.Bytes.CopyTo(body, SuccessPrefix.Length); body[^1] = (byte)'}';
                    await Reply(stream, body, timeout.Token);
                    return;
                }
                await Reply(stream, new { status = "success", result }, timeout.Token);
            }
            catch (Exception error)
            {
                try { await Reply(stream, new { status = "success", result = new { ok = false,
                    code = error is InvalidOperationException ? error.Message : "HOST_RESULT_UNKNOWN" } }, timeout.Token); } catch { /* Disconnected caller cannot receive the failure; persisted receipt remains authoritative. */ }
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
