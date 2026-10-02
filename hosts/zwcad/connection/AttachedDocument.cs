using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.ApplicationServices;
using ZwSoft.ZwCAD.DatabaseServices;

namespace Vide.Zwcad.Connection
{
    internal sealed class AttachedDocument : IDisposable
    {
        internal static readonly Dictionary<Document, AttachedDocument> Connections = new Dictionary<Document, AttachedDocument>();
        internal readonly Document Document;
        internal bool Live;
        internal DateTime? LastRead;
        /// <summary>The VIDE project this drawing was linked to from this window (SPEC-01.11).</summary>
        internal EngineProject LinkedProject;
        /// <summary>The engine's key for this connection (process, start time, session).</summary>
        internal string Instance => pid + ":" + ticks + ":" + session;
        private readonly string session = Guid.NewGuid().ToString(), token, ticks, record;
        private readonly int pid;
        private readonly TcpListener listener;
        private readonly ConcurrentQueue<Action> pending = new ConcurrentQueue<Action>();
        private bool disposed, dirty;
        private long revision, generation;
        private DateTime changedAt;
        /// <summary>The last direct execute (undoId) and the drawing revision right after it.</summary>
        private string lastUndo; private long lastUndoRevision;
        private TaskCompletionSource<object> undoing; private long undoingRevision;

        internal static AttachedDocument Connect(Document doc)
        {
            AttachedDocument current;
            if (Connections.TryGetValue(doc, out current)) return current;
            current = new AttachedDocument(doc); Connections.Add(doc, current); return current;
        }
        private AttachedDocument(Document doc)
        {
            Document = doc;
            var process = Process.GetCurrentProcess(); pid = process.Id; ticks = process.StartTime.ToUniversalTime().Ticks.ToString();
            byte[] secret = new byte[32]; using (var random = RandomNumberGenerator.Create()) random.GetBytes(secret);
            token = BitConverter.ToString(secret).Replace("-", "").ToLowerInvariant();
            string root = Environment.GetEnvironmentVariable("VIDE_ZWCAD_CONNECT_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VIDE", "zwcad-connections");
            Directory.CreateDirectory(root);
            record = Path.Combine(root, session + ".json");
            listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
            try {
                File.WriteAllText(record + ".tmp", new JavaScriptSerializer().Serialize(new {
                    identity = new { pid, startTicks = ticks, sessionId = session, documentId = session, port = ((IPEndPoint)listener.LocalEndpoint).Port },
                    token, executable = process.MainModule.FileName, directory = root, attached = true
                }));
                File.Move(record + ".tmp", record);
            } catch { listener.Stop(); throw; }
            doc.Database.ObjectAppended += Changed; doc.Database.ObjectModified += Changed; doc.Database.ObjectErased += Erased;
            doc.Database.ObjectUnappended += Changed; doc.Database.ObjectReappended += Changed;
            Application.DocumentManager.DocumentToBeDestroyed += Closing;
            Application.Idle += Idle;
            Task.Run((Action)Listen);
        }
        private void Changed(object sender, ObjectEventArgs e) { revision++; dirty = true; changedAt = DateTime.UtcNow; }
        private void Erased(object sender, ObjectErasedEventArgs e) { revision++; dirty = true; changedAt = DateTime.UtcNow; }
        private void Closing(object sender, DocumentCollectionEventArgs e) { if (e.Document == Document) Dispose(); }
        internal void Sync() { generation++; dirty = false; }
        private bool Busy => !String.IsNullOrEmpty(Document.CommandInProgress);
        private void Idle(object sender, EventArgs e)
        {
            if (disposed) return;
            if (Live && dirty && !Busy && (DateTime.UtcNow - changedAt).TotalSeconds >= 1) Sync();
            Action action; if (pending.TryDequeue(out action)) action();
        }
        private string Fingerprint()
        {
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(session + ":" + revision + ":" + Document.Database.Insunits))).Replace("-", "").ToLowerInvariant();
        }
        private object Dispatch(Dictionary<string, object> request)
        {
            if (disposed) throw new InvalidOperationException("STALE_CONNECTION");
            string method = Value(request, "method");
            if (method == "attachedStatus") {
                using (Document.LockDocument())
                using (var tx = Document.Database.TransactionManager.StartTransaction()) {
                    var table = (BlockTable)tx.GetObject(Document.Database.BlockTableId, OpenMode.ForRead);
                    var space = (BlockTableRecord)tx.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                    bool? modified = null;
                    if (Application.DocumentManager.MdiActiveDocument == Document) modified = Convert.ToInt32(Application.GetSystemVariable("DBMOD")) != 0;
                    return new { ok = true, name = Path.GetFileName(Document.Name), path = Document.Name, units = Document.Database.Insunits.ToString(),
                        objectCount = space.Cast<ObjectId>().Count(), documentHash = Fingerprint(), revision, generation, live = Live, modified, hostBusy = Busy,
                        linkIds = LinkIdStore.All(Document.Database, tx) };
                }
            }
            if (method == "fingerprint") return new { ok = true, documentHash = Fingerprint(), revision };
            if (Busy) throw new InvalidOperationException("HOST_BUSY");
            // ADR-030: [새 항목으로 분리] in VIDE gives this drawing a new link id.
            if (method == "setLinkId") {
                string projectId = Value(request, "projectId") ?? "", linkId = Value(request, "linkId") ?? "";
                if (projectId.Length == 0 || projectId.Length > 100 || linkId.Length == 0 || linkId.Length > 100) throw new InvalidOperationException("INVALID_INPUT");
                LinkIdStore.Write(Document, projectId, linkId);
                using (Document.LockDocument())
                using (var tx = Document.Database.TransactionManager.StartTransaction())
                    return new { ok = true, linkIds = LinkIdStore.All(Document.Database, tx) };
            }
            if (method == "direct-execute") return DirectExecute(request);
            if (method == "direct-undo") return DirectUndo(Value(request, "undoId"));
            if (method == "displayPage") {
                if (Value(request, "revision") != revision.ToString()) throw new InvalidOperationException("SOURCE_CHANGED");
                using (Document.LockDocument()) {
                    object result = AttachedDisplay.Page(Document.Database, Convert.ToInt32(request["offset"]), Convert.ToInt32(request["limit"]), revision);
                    LastRead = DateTime.Now; return result;
                }
            }
            if (method == "selection") {
                if (Application.DocumentManager.MdiActiveDocument != Document) throw new InvalidOperationException("DOCUMENT_NOT_ACTIVE");
                var selected = Document.Editor.SelectImplied();
                return new { ok = true, documentHash = Fingerprint(), selectedIds = selected.Status == ZwSoft.ZwCAD.EditorInput.PromptStatus.OK
                    ? selected.Value.GetObjectIds().Select(id => "cad-" + id.Handle.ToString()).ToArray() : new string[0] };
            }
            if (method == "queryEntities") { using (Document.LockDocument()) return AttachedEdit.Query(Document, request); }
            if (method == "runCode")
            {
                string code = Value(request, "code") ?? "";
                return String.Equals(Value(request, "write"), "true", StringComparison.OrdinalIgnoreCase)
                    ? (object)AttachedEdit.Queue(Document, () => AttachedEdit.Run(Document, code, true)) : AttachedEdit.Run(Document, code, false);
            }
            throw new InvalidOperationException("UNSUPPORTED_METHOD");
        }
        /// <summary>
        /// Direct mode: the AI code runs in the open drawing as one VIDEAIRUN command (one UNDO step).
        /// A run that changed the drawing gets an undoId; it stays undoable from VIDE while nothing
        /// else has changed the drawing since.
        /// </summary>
        private object DirectExecute(Dictionary<string, object> request)
        {
            string code = Value(request, "code") ?? "", label = Value(request, "label") ?? "VIDE AI", requestId = Value(request, "requestId");
            bool confirmed = false; int maxDeletes = 500; object value;
            if (request.TryGetValue("guard", out value) && value is Dictionary<string, object> guard)
            {
                confirmed = String.Equals(Value(guard, "confirmed"), "true", StringComparison.OrdinalIgnoreCase);
                int limit; if (Int32.TryParse(Value(guard, "maxDeletes"), out limit) && limit >= 0) maxDeletes = limit;
            }
            long before = revision;
            return AttachedEdit.Queue(Document, () => {
                var result = AttachedEdit.Direct(Document, code, label, confirmed, maxDeletes);
                result["requestId"] = requestId;
                string undoId = null;
                if (true.Equals(result["ok"]) && revision != before)
                {
                    undoId = Guid.NewGuid().ToString(); lastUndo = undoId; lastUndoRevision = revision;
                }
                result["undoId"] = undoId; result["documentHash"] = Fingerprint(); result["revision"] = revision;
                return result;
            });
        }
        private object DirectUndo(string undoId)
        {
            if (undoId == null || undoId != lastUndo || revision != lastUndoRevision || undoing != null) return new { ok = false, reason = "not-latest" };
            if (Application.DocumentManager.MdiActiveDocument != Document) return new { ok = false, reason = "document-not-active" };
            undoing = new TaskCompletionSource<object>(); undoingRevision = revision; lastUndo = null;
            var job = undoing.Task;
            // ZWCAD's own U reverts the VIDEAIRUN step; VIDEAIUNDONE reports back once it has run.
            Document.SendStringToExecute("_.U _VIDEAIUNDONE ", true, false, false);
            return job;
        }
        /// <summary>Runs as the VIDEAIUNDONE command right after ZWCAD's U (see AttachedEdit).</summary>
        internal static void UndoDone(Document doc)
        {
            AttachedDocument current;
            if (doc == null || !Connections.TryGetValue(doc, out current) || current.undoing == null) return;
            var job = current.undoing; current.undoing = null;
            job.TrySetResult(current.revision != current.undoingRevision
                ? (object)new { ok = true, documentHash = current.Fingerprint(), revision = current.revision }
                : new { ok = false, reason = "undo-no-change" });
        }
        private void Listen()
        {
            while (!disposed) {
                TcpClient client; try { client = listener.AcceptTcpClient(); } catch { return; }
                using (client) {
                    client.ReceiveTimeout = 10000; client.SendTimeout = 30000;
                    var stream = client.GetStream();
                    try {
                        int size = IPAddress.NetworkToHostOrder(BitConverter.ToInt32(Read(stream, 4), 0));
                        if (size < 1 || size > 1024 * 1024) throw new InvalidOperationException("INVALID_REQUEST");
                        var envelope = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(Read(stream, size)));
                        var request = (Dictionary<string, object>)envelope["params"];
                        string supplied = Value(request, "token"); int difference = 0;
                        if (supplied == null || supplied.Length != token.Length) throw new InvalidOperationException("UNAUTHORIZED");
                        for (int i = 0; i < token.Length; i++) difference |= supplied[i] ^ token[i];
                        if (difference != 0) throw new InvalidOperationException("UNAUTHORIZED");
                        if (Value(request, "pid") != pid.ToString() || Value(request, "startTicks") != ticks || Value(request, "sessionId") != session || Value(request, "documentId") != session)
                            throw new InvalidOperationException("DOCUMENT_MISMATCH");
                        if (Value(envelope, "type") != "vide") throw new InvalidOperationException("UNSUPPORTED_METHOD");
                        var completion = new TaskCompletionSource<object>();
                        pending.Enqueue(delegate {
                            if (completion.Task.IsCompleted) return;
                            try {
                                var result = Dispatch(request);
                                // An AI write runs later as a ZWCAD command (one UNDO step).
                                if (result is Task<object> job)
                                    job.ContinueWith(done => {
                                        if (done.IsFaulted) completion.TrySetException(done.Exception.GetBaseException());
                                        else if (done.IsCanceled) completion.TrySetCanceled();
                                        else completion.TrySetResult(done.Result);
                                    });
                                else completion.TrySetResult(result);
                            } catch (System.Exception error) { completion.TrySetException(error); }
                        });
                        if (!completion.Task.Wait(60000)) { completion.TrySetCanceled(); throw new InvalidOperationException("HOST_BUSY"); }
                        Reply(stream, completion.Task.Result);
                    } catch (System.Exception error) {
                        var cause = error is AggregateException ? ((AggregateException)error).GetBaseException() : error;
                        try { Reply(stream, new { ok = false, code = cause is InvalidOperationException ? cause.Message : "HOST_READ_FAILED", exceptionType = cause.GetType().FullName }); } catch (IOException) { }
                    }
                }
            }
        }
        private static string Value(Dictionary<string, object> request, string key) { object value; return request.TryGetValue(key, out value) ? Convert.ToString(value) : null; }
        private static byte[] Read(Stream stream, int size) { var bytes = new byte[size]; int at = 0; while (at < size) { int n = stream.Read(bytes, at, size - at); if (n == 0) throw new EndOfStreamException(); at += n; } return bytes; }
        private static void Reply(Stream stream, object result) {
            var body = Encoding.UTF8.GetBytes(new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue }.Serialize(new { status = "success", result }));
            var header = BitConverter.GetBytes(IPAddress.HostToNetworkOrder(body.Length)); stream.Write(header, 0, 4); stream.Write(body, 0, body.Length);
        }
        public void Dispose()
        {
            if (disposed) return; disposed = true; listener.Stop();
            Document.Database.ObjectAppended -= Changed; Document.Database.ObjectModified -= Changed; Document.Database.ObjectErased -= Erased;
            Document.Database.ObjectUnappended -= Changed; Document.Database.ObjectReappended -= Changed;
            undoing?.TrySetResult(new { ok = false, reason = "closed" });
            Application.DocumentManager.DocumentToBeDestroyed -= Closing; Application.Idle -= Idle; Connections.Remove(Document);
            try { File.Delete(record); } catch (IOException) { }
        }
    }
}
