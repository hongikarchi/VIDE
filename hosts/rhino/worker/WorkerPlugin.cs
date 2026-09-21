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

namespace Vide.Worker;

[Guid("6BDE756C-CB1F-45BC-90FA-784C098C2C38")]
public sealed class WorkerPlugin : PlugIn { }

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
        var doc = string.IsNullOrEmpty(source) ? RhinoDoc.CreateHeadless(null) : RhinoDoc.OpenHeadless(source);
        if (doc == null) return Result.Failure;
        if (string.IsNullOrEmpty(source)) doc.ModelUnitSystem = UnitSystem.Meters;
        if (doc.ModelUnitSystem != UnitSystem.Meters) { doc.Dispose(); return Result.Failure; }
        WorkerScene.Validate(doc);
        doc.ModelAbsoluteTolerance = 0.001;
        var executor = new WorkerExecutor(doc, Path.GetDirectoryName(report)!);
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
                _ = Serve(client, token, session, process.Id, ticks, executor);
            }
        });
        RhinoApp.WriteLine("VIDE isolated work host ready.");
        return Result.Success;
    }

    private static async Task Serve(TcpClient client, string token, string session, int pid, string ticks, WorkerExecutor executor)
    {
        using (client)
        using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60)))
        {
            var stream = client.GetStream();
            try
            {
                var header = new byte[4];
                await stream.ReadExactlyAsync(header, timeout.Token);
                var length = System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(header);
                if (length < 1 || length > 1024 * 1024) return;
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
                    try { completion.TrySetResult(executor.Dispatch(request)); }
                    catch (Exception error) { completion.TrySetException(error); }
                }));
                var result = await completion.Task.WaitAsync(timeout.Token);
                await Reply(stream, new { status = "success", result }, timeout.Token);
            }
            catch (Exception error)
            {
                try { await Reply(stream, new { status = "success", result = new { ok = false,
                    code = error is InvalidOperationException ? error.Message : "HOST_RESULT_UNKNOWN" } }, timeout.Token); } catch { }
            }
        }
    }

    private static async Task Reply(NetworkStream stream, object result, CancellationToken cancel)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(result);
        if (body.Length > 16 * 1024 * 1024) throw new InvalidOperationException("HOST_RESULT_TOO_LARGE");
        var header = new byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(header, body.Length);
        await stream.WriteAsync(header, cancel); await stream.WriteAsync(body, cancel);
    }
}
