using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;
using Rhino;
using Rhino.Commands;
using Rhino.DocObjects;

namespace Vide.Worker;

// Explicit user attachment: never owns, opens or closes this document. Generated code runs here only
// through direct-execute (one undo record per execution, DirectExecution.cs).
internal sealed class AttachedConnection : IDisposable
{
    internal static AttachedConnection? Current;
    private readonly RhinoDoc document;
    private readonly TcpListener listener;
    private readonly string record;
    private readonly string token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private readonly string session = Guid.NewGuid().ToString();
    private readonly EditorExecutor editor;
    private readonly DirectExecutor direct;
    private long generation;
    private long selectionVersion;
    private readonly HashSet<Guid> pinned = new();
    private int readRevision;
    // Last revision at which each object changed (UI thread only); lets a reader fetch only what changed.
    private readonly Dictionary<Guid, int> objectRevisions = new();
    private readonly DisplayScene display = new();
    private bool live, dirty, disposed, saving;
    private DateTime changedAt, savedAt;
    internal uint DocumentId => document.RuntimeSerialNumber;
    internal string Instance { get; }
    internal int Port { get; }
    internal IReadOnlyCollection<Guid> Pinned { get { lock (pinned) return pinned.ToArray(); } }
    internal event Action? PinsChanged;
    /** Pins are shared by every VIDE view of this document (browser and Rhino panel). */
    internal void SetPins(IEnumerable<Guid> ids)
    {
        lock (pinned) { pinned.Clear(); foreach (var id in ids) pinned.Add(id); }
        selectionVersion++;
        PinsChanged?.Invoke();
    }
    internal bool Live => live;
    /** The VIDE project this document was linked to from this window (SPEC-01.11). */
    internal EngineProject? LinkedProject { get; set; }
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
        editor = new EditorExecutor(doc, directory, RevisionHash);
        direct = new DirectExecutor(doc);
        var process = Process.GetCurrentProcess();
        var ticks = process.StartTime.ToUniversalTime().Ticks.ToString();
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        Port = port;
        Instance = process.Id + ":" + ticks + ":" + session;
        try {
            File.WriteAllText(record + ".tmp", JsonSerializer.Serialize(new {
                identity = new { port, pid = process.Id, startTicks = ticks, sessionId = session, documentId = doc.RuntimeSerialNumber, revision = 0 },
                token, executable = process.MainModule!.FileName
            }));
            File.Move(record + ".tmp", record);
        } catch { listener.Stop(); throw; }
        RhinoDoc.AddRhinoObject += ChangedObject;
        RhinoDoc.DeleteRhinoObject += DeletedObject;
        RhinoDoc.UndeleteRhinoObject += ChangedObject;
        RhinoDoc.ReplaceRhinoObject += ReplacedObject;
        RhinoDoc.ModifyObjectAttributes += ChangedAttributes;
        RhinoDoc.LayerTableEvent += ChangedLayer;
        RhinoDoc.InstanceDefinitionTableEvent += ChangedDefinition;
        RhinoDoc.MaterialTableEvent += ChangedMaterial;
        RhinoDoc.DimensionStyleTableEvent += ChangedDimensionStyle;
        RhinoDoc.GroupTableEvent += ChangedGroup;
        RhinoDoc.DocumentPropertiesChanged += ChangedProperties;
        RhinoDoc.CloseDocument += Closed;
        RhinoDoc.BeginSaveDocument += BeginSave;
        RhinoDoc.EndSaveDocument += EndSave;
        RhinoDoc.SelectObjects += SelectionChanged;
        RhinoDoc.DeselectObjects += SelectionChanged;
        RhinoDoc.DeselectAllObjects += SelectionCleared;
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
            return new { ok = true, documentId = DocumentId, name = document.Name ?? "Untitled", path = document.Path ?? "", units = document.ModelUnitSystem.ToString(),
                objectCount = document.Objects.Count, modified = document.Modified, generation, live, busy = RhinoApp.InCommand > 0,
                selectionVersion,
                selectedIds = document.Objects.GetSelectedObjects(false, false).Select(o => o.Id.ToString()).ToArray(),
                pinnedIds = Pinned.Select(id => id.ToString()).ToArray(), linkIds = LinkIdStore.All(document) };
        if (request.GetProperty("method").GetString() == "setPins")
        {
            var ids = request.GetProperty("ids").EnumerateArray().Select(e => Guid.Parse(e.GetString()!)).ToArray();
            SetPins(ids);
            return new { ok = true, pinnedIds = Pinned.Select(id => id.ToString()).ToArray(), selectionVersion };
        }
        // ADR-030: [새 항목으로 분리] in VIDE gives this document a new link id.
        if (request.GetProperty("method").GetString() == "setLinkId")
        {
            var projectId = request.GetProperty("projectId").GetString() ?? "";
            var linkId = request.GetProperty("linkId").GetString() ?? "";
            if (projectId.Length is 0 or > 100 || linkId.Length is 0 or > 100) throw new InvalidOperationException("INVALID_INPUT");
            LinkIdStore.Write(document, projectId, linkId);
            return new { ok = true, linkIds = LinkIdStore.All(document) };
        }
        if (RhinoApp.InCommand > 0) throw new InvalidOperationException("HOST_BUSY");
        var method = request.GetProperty("method").GetString();
        // The display basis is this connection's session and change revision, not a full geometry hash.
        // Candidate capture and native application still verify the full content fingerprint.
        if (method == "inspectEditor")
            return new { ok = true, documentId = DocumentId, name = document.Name ?? "Untitled", units = document.ModelUnitSystem.ToString(),
                objectCount = document.Objects.GetObjectList(ObjectType.AnyObject).Count(), modified = document.Modified, readOnly = document.IsReadOnly,
                documentHash = RevisionHash(), revision = readRevision,
                selectedIds = document.Objects.GetSelectedObjects(false, false).Select(obj => obj.Id.ToString()).ToArray() };
        if (method == "displayPage")
        {
            var offset = request.GetProperty("offset").GetInt32();
            var limit = request.GetProperty("limit").GetInt32();
            if (limit < 1 || limit > DisplayScene.MaxPageObjects) throw new InvalidOperationException("INVALID_PAGE");
            if (request.TryGetProperty("revision", out var basis)) {
                if (basis.GetInt32() != readRevision) throw new InvalidOperationException("SOURCE_CHANGED");
            } else if (offset > 0) throw new InvalidOperationException("STALE_REFERENCE");
            // A layer-limited or hidden-inclusive read (jig input, ARCH-03 §8) uses the same method and revision.
            var scope = ReadScope.From(request);
            LastDisplayRead = DateTime.Now;
            return display.Page(document, offset, limit, readRevision, scope, Binary(request));
        }
        if (method == "displayChanges")
        {
            var since = request.GetProperty("since").GetInt32();
            var cursor = request.GetProperty("cursor").GetInt32();
            if (since < 0 || since > readRevision) throw new InvalidOperationException("RESYNC_REQUIRED");
            if (request.TryGetProperty("revision", out var basis)) {
                if (basis.GetInt32() != readRevision) throw new InvalidOperationException("SOURCE_CHANGED");
            } else if (cursor > 0) throw new InvalidOperationException("STALE_REFERENCE");
            LastDisplayRead = DateTime.Now;
            return display.Changes(document, objectRevisions, since, cursor, readRevision, Binary(request));
        }
        // Direct mode: the AI's code in this document, one undo record per execution.
        if (method == "direct-execute") return direct.Execute(request);
        if (method == "direct-undo") return direct.Undo(request);
        // Grasshopper (ADR-033): the canvas tools of this Rhino process, beside its document.
        if (method != null && method.StartsWith("gh-", StringComparison.Ordinal)) return Gh.GhGate.Dispatch(method, request, document);
        if (method == "fingerprint") return DirectExecutor.Fingerprint(RevisionHash(), readRevision);
        return editor.Dispatch(request);
    }
    /** The engine reads VGT1 display pages (T-128); an older engine never asks and gets JSON. */
    private static bool Binary(JsonElement request) =>
        request.TryGetProperty("geometry", out var format) && format.ValueKind == JsonValueKind.String && format.GetString() == "vgt1";
    private string RevisionHash() => Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(
        session + ":" + readRevision + ":" + document.ModelUnitSystem))).ToLowerInvariant();
    private void SelectionChanged(object? sender, RhinoObjectSelectionEventArgs e) { if (e.Document == document) selectionVersion++; }
    private void SelectionCleared(object? sender, RhinoDeselectAllObjectsEventArgs e) { if (e.Document == document) selectionVersion++; }
    private bool Mark(RhinoDoc doc)
    {
        if (doc != document) return false;
        readRevision++; dirty = true; changedAt = DateTime.UtcNow;
        return true;
    }
    private void MarkObjects(RhinoDoc doc, IEnumerable<Guid> ids) { if (Mark(doc)) foreach (var id in ids) objectRevisions[id] = readRevision; }
    private IEnumerable<RhinoObject> AllObjects(Func<RhinoObject, bool> filter) => document.Objects.GetObjectList(new ObjectEnumeratorSettings
        { NormalObjects = true, LockedObjects = true, HiddenObjects = true, DeletedObjects = false, ReferenceObjects = true }).Where(filter);
    private void ChangedObject(object? sender, RhinoObjectEventArgs e) => MarkObjects(e.TheObject.Document, [e.ObjectId]);
    private void DeletedObject(object? sender, RhinoObjectEventArgs e)
    {
        if (e.TheObject.Document == document) display.Forget(e.ObjectId);
        MarkObjects(e.TheObject.Document, [e.ObjectId]);
    }
    private void ReplacedObject(object? sender, RhinoReplaceObjectEventArgs e) => MarkObjects(e.Document, [e.ObjectId]);
    private void ChangedAttributes(object? sender, RhinoModifyObjectAttributesEventArgs e) => MarkObjects(e.Document, [e.RhinoObject.Id]);
    // Current/sort changes do not alter objects. Other layer edits can change every object on the layer
    // or on its sublayers (visibility, color, full path).
    private void ChangedLayer(object? sender, Rhino.DocObjects.Tables.LayerTableEventArgs e)
    {
        if (e.EventType is Rhino.DocObjects.Tables.LayerTableEventType.Current or Rhino.DocObjects.Tables.LayerTableEventType.Sorted) return;
        if (e.Document != document) return;
        var affected = new HashSet<int>();
        foreach (var layer in document.Layers)
            for (var current = layer; current != null; current = current.ParentLayerId == Guid.Empty ? null : document.Layers.FindId(current.ParentLayerId))
                if (current.Index == e.LayerIndex) { affected.Add(layer.Index); break; }
        affected.Add(e.LayerIndex);
        // Block members on a layer turned on or off are drawn or left out inside every definition.
        var shown = e.EventType == Rhino.DocObjects.Tables.LayerTableEventType.Modified && e.OldState != null && e.NewState != null
            && e.OldState.IsVisible != e.NewState.IsVisible;
        if (shown) display.ClearDefinitions();
        MarkObjects(e.Document, AllObjects(obj => affected.Contains(obj.Attributes.LayerIndex)
            || (shown && obj.ObjectType == ObjectType.InstanceReference)).Select(obj => obj.Id).ToList());
    }
    // Only the edited definition and the definitions that nest it (at any level) change: their instances
    // are sent again, other blocks are not (re-sending every heavy nested block made a Live read slow).
    private void ChangedDefinition(object? sender, Rhino.DocObjects.Tables.InstanceDefinitionTableEventArgs e)
    {
        if (e.Document != document) return;
        var changed = e.InstanceDefinitionIndex >= 0 && e.InstanceDefinitionIndex < document.InstanceDefinitions.Count
            ? document.InstanceDefinitions[e.InstanceDefinitionIndex] : null;
        if (changed == null)
        {
            display.ClearDefinitions();
            MarkObjects(e.Document, AllObjects(obj => obj.ObjectType == ObjectType.InstanceReference).Select(obj => obj.Id).ToList());
            return;
        }
        var affected = new HashSet<Guid> { changed.Id };
        var pending = new Stack<InstanceDefinition>();
        pending.Push(changed);
        while (pending.Count > 0)
            foreach (var container in pending.Pop().GetContainers() ?? [])
                if (container != null && affected.Add(container.Id)) pending.Push(container);
        display.ForgetDefinitions(affected);
        MarkObjects(e.Document, AllObjects(obj => obj.Geometry is Rhino.Geometry.InstanceReferenceGeometry reference
            && affected.Contains(reference.ParentIdefId)).Select(obj => obj.Id).ToList());
    }
    // Dimension styles drive annotation lines and text; definitions may contain annotations too.
    private void ChangedDimensionStyle(object? sender, Rhino.DocObjects.Tables.DimStyleTableEventArgs e)
    {
        if (e.Document != document) return;
        display.ClearDefinitions();
        var affected = AllObjects(obj => obj.Geometry is Rhino.Geometry.AnnotationBase || obj.ObjectType == ObjectType.InstanceReference).Select(obj => obj.Id).ToList();
        foreach (var id in affected) display.Forget(id);
        MarkObjects(e.Document, affected);
    }
    private void ChangedMaterial(object? sender, Rhino.DocObjects.Tables.MaterialTableEventArgs e)
    {
        if (e.Document != document) return;
        MarkObjects(e.Document, AllObjects(_ => true).Select(obj => obj.Id).ToList());
    }
    // Groups do not change display, but they are part of the document state a basis stands for.
    private void ChangedGroup(object? sender, Rhino.DocObjects.Tables.GroupTableEventArgs e) => Mark(e.Document);
    private void ChangedProperties(object? sender, DocumentEventArgs e)
    {
        if (e.Document != document) return;
        // Saving (Save As, a first save) renames the document but changes nothing drawn; VIDE's link
        // follows the new name from attachedStatus (T-095), so no full Live Sync for it.
        if (saving || (DateTime.UtcNow - savedAt).TotalSeconds < 2) return;
        display.Clear();
        MarkObjects(e.Document, AllObjects(_ => true).Select(obj => obj.Id).ToList());
    }
    private void BeginSave(object? sender, DocumentSaveEventArgs e) { if (e.Document == document) saving = true; }
    private void EndSave(object? sender, DocumentSaveEventArgs e) { if (e.Document == document) { saving = false; savedAt = DateTime.UtcNow; } }
    private void Closed(object? sender, DocumentEventArgs e) { if (e.Document == document) { Dispose(); if (Current == this) Current = null; } }
    private void Idle(object? sender, EventArgs e)
    {
        if (live && dirty && RhinoApp.InCommand == 0 && (DateTime.UtcNow - changedAt).TotalSeconds >= 0.5) { generation++; dirty = false; }
    }
    internal void Sync() { generation++; dirty = false; }
    internal bool ToggleLive() { live = !live; if (live) Sync(); return live; }
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        listener.Stop();
        direct.Dispose();
        RhinoDoc.AddRhinoObject -= ChangedObject; RhinoDoc.DeleteRhinoObject -= DeletedObject; RhinoDoc.UndeleteRhinoObject -= ChangedObject;
        RhinoDoc.ReplaceRhinoObject -= ReplacedObject; RhinoDoc.ModifyObjectAttributes -= ChangedAttributes; RhinoDoc.LayerTableEvent -= ChangedLayer;
        RhinoDoc.InstanceDefinitionTableEvent -= ChangedDefinition; RhinoDoc.MaterialTableEvent -= ChangedMaterial;
        RhinoDoc.DimensionStyleTableEvent -= ChangedDimensionStyle;
        RhinoDoc.GroupTableEvent -= ChangedGroup; RhinoDoc.DocumentPropertiesChanged -= ChangedProperties;
        display.Clear();
        RhinoDoc.CloseDocument -= Closed; RhinoApp.Idle -= Idle;
        RhinoDoc.BeginSaveDocument -= BeginSave; RhinoDoc.EndSaveDocument -= EndSave;
        RhinoDoc.SelectObjects -= SelectionChanged; RhinoDoc.DeselectObjects -= SelectionChanged; RhinoDoc.DeselectAllObjects -= SelectionCleared;
        try { File.Delete(record); } catch (IOException) { /* Dead socket and disposed dispatch revoke access even if cleanup fails. */ }
    }
}
/// <summary>Link: connect this document, choose a VIDE project, and VIDE syncs it at once.</summary>
public sealed class LinkCommand : Command
{
    public override string EnglishName => "VIDELink";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        if (doc.IsHeadless) return Result.Failure;
        EngineLink.LinkDocument(doc);
        return Result.Success;
    }
}
/// <summary>Earlier name of Link; the same behaviour.</summary>
public sealed class ConnectCommand : Command
{
    public override string EnglishName => "VIDEConnect";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        if (doc.IsHeadless) return Result.Failure;
        EngineLink.LinkDocument(doc);
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
        if (AttachedConnection.Current?.DocumentId != doc.RuntimeSerialNumber) { RhinoApp.WriteLine("먼저 VIDELink로 이 문서를 VIDE 프로젝트에 연결하세요."); return Result.Failure; }
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
