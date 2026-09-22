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

// Read-only transport/host-thread experiment. No caller code or user document is accessed.
public sealed class VideChannelProbe
{
    private static TcpListener listener;
    private static readonly ConcurrentQueue<Action> pending = new ConcurrentQueue<Action>();
    private static string token, session, document, ticks;
    private static int pid, commandThread;

    [CommandMethod("VIDEChannelProbe", CommandFlags.Session)]
    public void Start()
    {
        if (listener != null) return;
        string directory = Environment.GetEnvironmentVariable("VIDE_ZWCAD_PROBE_DIR");
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
        // Bounded work per host event; production cancellation/queue limits are separate work.
        if (pending.TryDequeue(out action)) action();
    }

    private static void Listen()
    {
        while (true)
        {
            TcpClient client;
            try { client = listener.AcceptTcpClient(); } catch { return; }
            // Serial clients suffice for this bounded read-only spike.
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
                if (Value(request, "revision") != "0") throw new InvalidOperationException("STALE_REVISION");
                if (Value(envelope, "type") != "vide" || Value(request, "method") != "query") throw new InvalidOperationException("UNSUPPORTED_METHOD");
                var completion = new TaskCompletionSource<object>();
                pending.Enqueue(delegate {
                    // A timed-out query must not run later. No mutation is exposed by this spike.
                    if (completion.Task.IsCompleted) return;
                    try { completion.TrySetResult(Query()); }
                    catch (System.Exception error) { completion.TrySetException(error); }
                });
                if (!completion.Task.Wait(15000)) { completion.TrySetCanceled(); throw new InvalidOperationException("HOST_RESULT_UNKNOWN"); }
                Reply(stream, completion.Task.Result);
            }
            catch (System.Exception error)
            {
                try { Reply(stream, new { ok = false, code = error is InvalidOperationException ? error.Message : "HOST_RESULT_UNKNOWN" }); } catch { }
            }
        }
    }

    private static object Query()
    {
        if (Thread.CurrentThread.ManagedThreadId != commandThread) throw new InvalidOperationException("WRONG_HOST_THREAD");
        using (Database database = new Database(true, true))
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        using (Polyline line = new Polyline())
        {
            var blocks = (BlockTable)transaction.GetObject(database.BlockTableId, OpenMode.ForRead);
            var space = (BlockTableRecord)transaction.GetObject(blocks[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
            line.AddVertexAt(0, new Point2d(0, 0), 0, 0, 0);
            line.AddVertexAt(1, new Point2d(20000, 0), 0, 0, 0);
            line.AddVertexAt(2, new Point2d(20000, 10000), 0, 0, 0);
            line.AddVertexAt(3, new Point2d(0, 10000), 0, 0, 0); line.Closed = true;
            space.AppendEntity(line); transaction.AddNewlyCreatedDBObject(line, true);
            return new { ok = true, pid, documentId = document, revision = 0, areaSquareMetres = line.Area / 1000000,
                hostThreadVerified = true, activeDocumentAccessed = false };
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
        byte[] body = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new { status = "success", result }));
        byte[] header = BitConverter.GetBytes(IPAddress.HostToNetworkOrder(body.Length));
        stream.Write(header, 0, header.Length); stream.Write(body, 0, body.Length);
    }
}
