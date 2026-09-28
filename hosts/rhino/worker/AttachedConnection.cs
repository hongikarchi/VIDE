using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;
using Rhino;
using Rhino.Commands;
using Rhino.DocObjects;

namespace Vide.Worker;

// Explicit user attachment: never owns, opens, closes, or executes generated code in this document.
internal sealed class AttachedConnection : IDisposable
{
    internal static AttachedConnection? Current;
    private readonly RhinoDoc document;
    private readonly TcpListener listener;
    private readonly string record;
    private readonly string token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private readonly string session = Guid.NewGuid().ToString();
    private readonly EditorExecutor editor;
    private long generation;
    private int readRevision;
    private bool live, dirty, disposed;
    private DateTime changedAt;
    internal uint DocumentId => document.RuntimeSerialNumber;
    internal bool Live => live;
    internal DateTime? LastDisplayRead { get; private set; }
    internal static void Connect(RhinoDoc doc)
    {
        if (doc.IsHeadless) throw new InvalidOperationException("A visible Rhino document is required.");
        if (Current?.DocumentId == doc.RuntimeSerialNumber) return;
        Current?.Dispose(); Current = null;
        Current = new AttachedConnection(doc);
    }
    internal AttachedConnection(RhinoDoc doc)
    {
        document = doc;
        var root = System.Environment.GetEnvironmentVariable("VIDE_CONNECT_DIR") ?? Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData), "VIDE", "rhino-connections");
        root = Path.GetFullPath(root);
        Directory.CreateDirectory(root);
        var directory = Path.Combine(root, session);
        Directory.CreateDirectory(directory);
        record = Path.Combine(root, session + ".json");
        editor = new EditorExecutor(doc, directory);
        var process = Process.GetCurrentProcess();
        var ticks = process.StartTime.ToUniversalTime().Ticks.ToString();
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        try {
            File.WriteAllText(record + ".tmp", JsonSerializer.Serialize(new {
                identity = new { port, pid = process.Id, startTicks = ticks, sessionId = session, documentId = doc.RuntimeSerialNumber, revision = 0 },
                token, executable = process.MainModule!.FileName
            }));
            File.Move(record + ".tmp", record);
        } catch { listener.Stop(); throw; }
        RhinoDoc.AddRhinoObject += ChangedObject;
        RhinoDoc.DeleteRhinoObject += ChangedObject;
        RhinoDoc.UndeleteRhinoObject += ChangedObject;
        RhinoDoc.ReplaceRhinoObject += ReplacedObject;
        RhinoDoc.ModifyObjectAttributes += ChangedAttributes;
        RhinoDoc.LayerTableEvent += ChangedLayer;
        RhinoDoc.InstanceDefinitionTableEvent += ChangedDefinition;
        RhinoDoc.CloseDocument += Closed;
        RhinoApp.Idle += Idle;
        _ = Task.Run(async () => {
            while (!disposed) {
                TcpClient client;
                try { client = await listener.AcceptTcpClientAsync(); } catch { break; }
                _ = WorkerCommand.Serve(client, token, session, process.Id, ticks, Dispatch);
            }
        });
    }
    private object Dispatch(JsonElement request)
    {
        if (disposed || RhinoDoc.FromRuntimeSerialNumber(DocumentId) != document || request.GetProperty("documentId").GetUInt32() != DocumentId)
            throw new InvalidOperationException("TARGET_MISMATCH");
        if (request.GetProperty("method").GetString() == "attachedStatus")
            return new { ok = true, documentId = DocumentId, name = document.Name ?? "Untitled", units = document.ModelUnitSystem.ToString(),
                objectCount = document.Objects.Count, modified = document.Modified, generation, live, busy = RhinoApp.InCommand > 0 };
        if (request.GetProperty("method").GetString() == "chatBridge") return ChatBridge.Exchange(DocumentId, request);
        if (RhinoApp.InCommand > 0) throw new InvalidOperationException("HOST_BUSY");
        if (request.GetProperty("method").GetString() == "displayPage")
        {
            var offset = request.GetProperty("offset").GetInt32();
            var limit = request.GetProperty("limit").GetInt32();
            if (limit < 1 || limit > 1000) throw new InvalidOperationException("INVALID_PAGE");
            if (request.TryGetProperty("revision", out var basis)) {
                if (basis.GetInt32() != readRevision) throw new InvalidOperationException("SOURCE_CHANGED");
            } else if (offset > 0) throw new InvalidOperationException("STALE_REFERENCE");
            var result = WorkerScene.Export(document, offset: offset, limit: limit, revision: readRevision, displayOnly: true);
            LastDisplayRead = DateTime.Now;
            return result;
        }
        return editor.Dispatch(request);
    }
    private void Mark(RhinoDoc doc) { if (doc == document) { readRevision++; dirty = true; changedAt = DateTime.UtcNow; } }
    private void ChangedObject(object? sender, RhinoObjectEventArgs e) => Mark(e.TheObject.Document);
    private void ReplacedObject(object? sender, RhinoReplaceObjectEventArgs e) => Mark(e.Document);
    private void ChangedAttributes(object? sender, RhinoModifyObjectAttributesEventArgs e) => Mark(e.Document);
    private void ChangedLayer(object? sender, Rhino.DocObjects.Tables.LayerTableEventArgs e) => Mark(e.Document);
    private void ChangedDefinition(object? sender, Rhino.DocObjects.Tables.InstanceDefinitionTableEventArgs e) => Mark(e.Document);
    private void Closed(object? sender, DocumentEventArgs e) { if (e.Document == document) { Dispose(); if (Current == this) Current = null; } }
    private void Idle(object? sender, EventArgs e)
    {
        if (live && dirty && RhinoApp.InCommand == 0 && (DateTime.UtcNow - changedAt).TotalSeconds >= 1) { generation++; dirty = false; }
    }
    internal void Sync() { generation++; dirty = false; }
    internal bool ToggleLive() { live = !live; if (live) Sync(); return live; }
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        listener.Stop();
        RhinoDoc.AddRhinoObject -= ChangedObject; RhinoDoc.DeleteRhinoObject -= ChangedObject; RhinoDoc.UndeleteRhinoObject -= ChangedObject;
        RhinoDoc.ReplaceRhinoObject -= ReplacedObject; RhinoDoc.ModifyObjectAttributes -= ChangedAttributes; RhinoDoc.LayerTableEvent -= ChangedLayer;
        RhinoDoc.InstanceDefinitionTableEvent -= ChangedDefinition;
        RhinoDoc.CloseDocument -= Closed; RhinoApp.Idle -= Idle;
        try { File.Delete(record); } catch (IOException) { /* Dead socket and disposed dispatch revoke access even if cleanup fails. */ }
    }
}
public sealed class ConnectCommand : Command
{
    public override string EnglishName => "VIDEConnect";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        if (doc.IsHeadless) return Result.Failure;
        AttachedConnection.Connect(doc);
        RhinoApp.WriteLine("VIDE connected to this document. In VIDE, select this document and Sync. VIDE never saves or closes this Rhino window.");
        return Result.Success;
    }
}
public sealed class DisconnectCommand : Command
{
    public override string EnglishName => "VIDEDisconnect";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode) { AttachedConnection.Current?.Dispose(); AttachedConnection.Current = null; RhinoApp.WriteLine("VIDE disconnected."); return Result.Success; }
}
public sealed class SyncCommand : Command
{
    public override string EnglishName => "VIDESync";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode) {
        if (AttachedConnection.Current?.DocumentId != doc.RuntimeSerialNumber) { RhinoApp.WriteLine("Run VIDEConnect first."); return Result.Failure; }
        AttachedConnection.Current.Sync(); RhinoApp.WriteLine("VIDE Sync requested. Keep the connected document selected in VIDE."); return Result.Success;
    }
}
public sealed class LiveSyncCommand : Command
{
    public override string EnglishName => "VIDELiveSync";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode) {
        if (AttachedConnection.Current?.DocumentId != doc.RuntimeSerialNumber) return Result.Failure;
        RhinoApp.WriteLine(AttachedConnection.Current.ToggleLive() ? "VIDE Live Sync ON" : "VIDE Live Sync OFF"); return Result.Success;
    }
}
