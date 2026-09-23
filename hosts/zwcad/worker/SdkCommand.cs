using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.ApplicationServices;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Geometry;
using ZwSoft.ZwCAD.Runtime;

// Authenticated transport for an owned work-copy session; SDK calls stay on the host thread.
namespace Vide.Zwcad
{
public sealed class SdkCommand
{
    private static TcpListener listener;
    private static readonly ConcurrentQueue<Action> pending = new ConcurrentQueue<Action>();
    private static string token, session, document, ticks, directory;
    private static int pid, commandThread;
    private static SdkSession execution;

    [CommandMethod("VIDESdkSession", CommandFlags.Session)]
    public void Start()
    {
        if (listener != null) return;
        CompilerDependencies.Install();
        directory = Environment.GetEnvironmentVariable("VIDE_WORKER_DIRECTORY");
        token = Environment.GetEnvironmentVariable("VIDE_WORKER_TOKEN");
        session = Environment.GetEnvironmentVariable("VIDE_WORKER_SESSION");
        Guid parsed;
        if (String.IsNullOrEmpty(directory) || !Path.IsPathRooted(directory) || !Directory.Exists(directory) ||
            token == null || token.Length != 64 || !Guid.TryParse(session, out parsed)) return;
        string report = Path.Combine(directory, "ready.json");
        if (File.Exists(report)) return;
        Process process = Process.GetCurrentProcess();
        pid = process.Id; ticks = process.StartTime.ToUniversalTime().Ticks.ToString();
        document = Guid.NewGuid().ToString(); commandThread = Thread.CurrentThread.ManagedThreadId;
        try { execution = new SdkSession(directory, Environment.GetEnvironmentVariable("VIDE_WORKER_SOURCE"), Environment.GetEnvironmentVariable("VIDE_WORKER_SOURCE_HASH")); }
        catch (System.Exception error) {
            File.WriteAllText(report + ".error.json", new JavaScriptSerializer().Serialize(new { code = error is InvalidOperationException ? error.Message : "ZWCAD_EXECUTION_FAILED" }));
            return;
        }
        listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        Application.Idle += OnIdle;
        File.WriteAllText(report + ".tmp", new JavaScriptSerializer().Serialize(new {
            pid, startTicks = ticks, sessionId = session, documentId = document,
            port = ((IPEndPoint)listener.LocalEndpoint).Port, revision = 0
        }));
        File.Move(report + ".tmp", report);
        Task.Run((Action)Listen);
    }

    private static void OnIdle(object sender, EventArgs args)
    {
        Action action;
        // One bounded request per host event. Serial network requests bound the live queue.
        if (pending.TryDequeue(out action)) action();
    }

    private static void Listen()
    {
        while (true)
        {
            TcpClient client;
            try { client = listener.AcceptTcpClient(); } catch { return; }
            // Serial clients preserve document ordering.
            Serve(client);
        }
    }

    private static bool Matches(string supplied)
    {
        if (supplied == null || supplied.Length != token.Length) return false;
        int difference = 0;
        for (int i = 0; i < token.Length; i++) difference |= supplied[i] ^ token[i];
        return difference == 0;
    }

    private static string Value(Dictionary<string, object> request, string key)
    {
        object value; return request.TryGetValue(key, out value) ? Convert.ToString(value) : null;
    }

    private static void Serve(TcpClient client)
    {
        using (client)
        {
            client.ReceiveTimeout = 10000; client.SendTimeout = 10000;
            NetworkStream stream = client.GetStream();
            try
            {
                byte[] header = Read(stream, 4);
                int size = IPAddress.NetworkToHostOrder(BitConverter.ToInt32(header, 0));
                if (size < 1 || size > 1024 * 1024) return;
                var envelope = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(Read(stream, size)));
                var request = (Dictionary<string, object>)envelope["params"];
                if (!Matches(Value(request, "token"))) throw new InvalidOperationException("UNAUTHORIZED");
                if (Value(request, "sessionId") != session || Value(request, "pid") != pid.ToString() || Value(request, "startTicks") != ticks)
                    throw new InvalidOperationException("HOST_OWNERSHIP_MISMATCH");
                if (Value(request, "documentId") != document) throw new InvalidOperationException("DOCUMENT_MISMATCH");
                if (execution == null && Value(request, "revision") != "0") throw new InvalidOperationException("STALE_REVISION");
                if (Value(envelope, "type") != "vide" || (execution == null && Value(request, "method") != "query")) throw new InvalidOperationException("UNSUPPORTED_METHOD");
                if (pending.Count >= 1) throw new InvalidOperationException("HOST_BUSY");
                var completion = new TaskCompletionSource<object>();
                pending.Enqueue(delegate {
                    // A queued request that already timed out must not begin later. An in-flight result may remain unknown.
                    if (completion.Task.IsCompleted) return;
                    try {
                        if (Thread.CurrentThread.ManagedThreadId != commandThread) throw new InvalidOperationException("WRONG_HOST_THREAD");
                        completion.TrySetResult(execution.Dispatch(request));
                    }
                    catch (System.Exception error) { completion.TrySetException(error); }
                });
                if (!completion.Task.Wait(15000)) { completion.TrySetCanceled(); throw new InvalidOperationException("HOST_RESULT_UNKNOWN"); }
                Reply(stream, completion.Task.Result);
            }
            catch (System.Exception error)
            {
                var cause = error is AggregateException ? ((AggregateException)error).GetBaseException() : error;
                string diagnosticId = Guid.NewGuid().ToString();
                try { File.WriteAllText(Path.Combine(directory, diagnosticId + ".diagnostic.txt"), cause.ToString()); } catch { }
                try { Reply(stream, new { ok = false, code = cause is InvalidOperationException ? cause.Message : "HOST_RESULT_UNKNOWN", diagnosticId, exceptionType = cause.GetType().FullName }); } catch { }
            }
        }
    }

    private static byte[] Read(Stream stream, int size)
    {
        byte[] bytes = new byte[size]; int offset = 0;
        while (offset < size) { int count = stream.Read(bytes, offset, size - offset); if (count == 0) throw new EndOfStreamException(); offset += count; }
        return bytes;
    }
    private static void Reply(Stream stream, object result)
    {
        byte[] body = Encoding.UTF8.GetBytes(new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 }.Serialize(new { status = "success", result }));
        if (body.Length > 16 * 1024 * 1024) throw new InvalidOperationException("IMPORT_LIMIT");
        byte[] header = BitConverter.GetBytes(IPAddress.HostToNetworkOrder(body.Length));
        stream.Write(header, 0, header.Length); stream.Write(body, 0, body.Length);
    }
}

}
