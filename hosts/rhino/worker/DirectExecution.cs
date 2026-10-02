using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Rhino;
using Rhino.DocObjects;

namespace Vide.Worker;

// Direct mode (user decision 2026-09-30, "바로 적용"): the AI's C# body runs in the user's attached
// document inside ONE undo record. Rhino Ctrl+Z and VIDE [되돌리기] (direct-undo) are the safety net.
// Effects undo cannot easily repair are guarded: bulk deletion and layer deletion are detected after
// the run and the record is undone; purge is found before the run because it is not undoable.
internal sealed class DirectExecutor : IDisposable
{
    internal const int MaxListed = 2000;
    private readonly RhinoDoc document;
    // Applied executions by request id (same request re-sent returns the same result, never re-runs).
    private readonly Dictionary<string, (string hash, object result)> receipts = new();
    // Undo records this connection made, and whether each is currently undone (Ctrl+Z / Redo tracked).
    private readonly Dictionary<uint, bool> records = new();
    // Records undone while UndoRecord runs (null otherwise).
    private List<uint>? watching;
    // Every record of this document currently undone (any origin), and this connection's empty
    // records Rhino discarded: serials that no longer stand between a record and the undo top.
    private readonly HashSet<uint> undone = new(), discarded = new();
    // Executions whose commands left records of their own: first serial -> last serial.
    private readonly Dictionary<uint, uint> groups = new();
    internal DirectExecutor(RhinoDoc doc)
    {
        document = doc;
        Rhino.Commands.Command.UndoRedo += UndoRedo;
    }
    public void Dispose() => Rhino.Commands.Command.UndoRedo -= UndoRedo;

    private void UndoRedo(object? sender, Rhino.Commands.UndoRedoEventArgs e)
    {
        if (e.IsBeginUndo)
        {
            watching?.Add(e.UndoSerialNumber); undone.Add(e.UndoSerialNumber); if (records.ContainsKey(e.UndoSerialNumber)) records[e.UndoSerialNumber] = true;
            // Ctrl+Z on any record of a group leaves the execution (partly) undone: VIDE does not undo it again.
            foreach (var group in groups)
                if (e.UndoSerialNumber > group.Key && e.UndoSerialNumber <= group.Value && records.ContainsKey(group.Key)) records[group.Key] = true;
        }
        if (e.IsBeginRedo) { undone.Remove(e.UndoSerialNumber); if (records.ContainsKey(e.UndoSerialNumber)) records[e.UndoSerialNumber] = false; }
    }

    internal sealed record GuardOptions(bool Confirmed, int MaxDeletes)
    {
        internal static GuardOptions From(JsonElement request)
        {
            if (!request.TryGetProperty("guard", out var guard) || guard.ValueKind != JsonValueKind.Object) return new(false, 50);
            var confirmed = guard.TryGetProperty("confirmed", out var c) && c.ValueKind == JsonValueKind.True;
            var max = guard.TryGetProperty("maxDeletes", out var m) && m.ValueKind == JsonValueKind.Number ? Math.Clamp(m.GetInt32(), 0, 100000) : 50;
            return new(confirmed, max);
        }
    }

    private sealed record Before(Dictionary<Guid, string> Objects, Dictionary<Guid, string> Layers);

    private IEnumerable<RhinoObject> Objects() => document.Objects.GetObjectList(new ObjectEnumeratorSettings
        { NormalObjects = true, LockedObjects = true, HiddenObjects = true, DeletedObjects = false, ReferenceObjects = true });
    private string LayerPath(int index) => index >= 0 && index < document.Layers.Count ? document.Layers[index].FullPath : "";
    private Dictionary<Guid, string> LiveLayers() => document.Layers.Where(layer => !layer.IsDeleted).ToDictionary(layer => layer.Id, layer => layer.FullPath);
    private Before Snapshot() => new(Objects().ToDictionary(obj => obj.Id, obj => LayerPath(obj.Attributes.LayerIndex)), LiveLayers());
    private static string Hash(RhinoObject obj) => WorkerScene.Fingerprint(obj).ToLowerInvariant();

    /// <summary>`direct-execute`: compile, run in one undo record, report changes, trip guards.</summary>
    internal object Execute(JsonElement request)
    {
        var requestId = request.GetProperty("requestId").GetString() ?? "";
        if (requestId.Length is < 1 or > 100) throw new InvalidOperationException("INVALID_INPUT");
        var code = request.GetProperty("code").GetString() ?? "";
        if (code.Length is < 1 or > 65536) throw new InvalidOperationException("INVALID_CODE");
        var label = request.TryGetProperty("label", out var l) && l.ValueKind == JsonValueKind.String ? l.GetString()! : "VIDE AI 편집";
        label = label.Length > 80 ? label[..80] : label.Length == 0 ? "VIDE AI 편집" : label;
        var guard = GuardOptions.From(request);
        // ADR-029: a C# body (default), a Rhino command macro or a Python 3 script.
        var language = request.TryGetProperty("language", out var lang) && lang.ValueKind == JsonValueKind.String ? lang.GetString() : "csharp";
        if (language is not ("csharp" or "command" or "python")) throw new InvalidOperationException("INVALID_INPUT");
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(language + "\n" + code + "\n" + label))).ToLowerInvariant();
        if (receipts.TryGetValue(requestId, out var prior))
            return prior.hash == hash ? prior.result : throw new InvalidOperationException("OPERATION_CONFLICT");
        if (document.IsReadOnly) throw new InvalidOperationException("DOCUMENT_READ_ONLY");

        Func<StringBuilder, object?> run;
        if (language == "csharp")
        {
            var compiled = Compile(code, requestId);
            if (compiled.Failure != null) return compiled.Failure;
            if (compiled.Purges && !guard.Confirmed)
                return Guarded("purge", "사용하지 않는 항목 정리(Purge)는 되돌릴 수 없습니다.", "");
            run = output => Assembly.Load(compiled.Bytes!).GetType("TaskCode")!.GetMethod("Run")!.Invoke(null, [document, output]);
        }
        else
        {
            var verdict = language == "command" ? DirectScripts.CheckCommand(code) : DirectScripts.CheckPython(code);
            if (verdict.Denied != null) return new { ok = false, code = "CODE_POLICY_REJECTED", diagnostics = verdict.Denied };
            if (verdict.GuardKind != null && !guard.Confirmed) return Guarded(verdict.GuardKind, verdict.GuardDetail!, "");
            // Commands and scriptcontext act on Rhino's active document only.
            if (RhinoDoc.ActiveDoc != document) throw new InvalidOperationException("DOCUMENT_NOT_ACTIVE");
            run = language == "command"
                ? output => DirectScripts.RunCommand(document, code, output, guard.Confirmed)
                : output => DirectScripts.RunPython(document, code, output);
        }

        var before = Snapshot();
        var touched = new HashSet<Guid>();
        void Replaced(object? s, RhinoReplaceObjectEventArgs e) { if (e.Document == document) touched.Add(e.ObjectId); }
        void Modified(object? s, RhinoModifyObjectAttributesEventArgs e) { if (e.Document == document) touched.Add(e.RhinoObject.Id); }
        // Layer property edits (colour, visibility, name) change no object but still leave an undo record.
        var layersEdited = false;
        void Layer(object? s, Rhino.DocObjects.Tables.LayerTableEventArgs e)
        { if (e.Document == document && e.EventType is not (Rhino.DocObjects.Tables.LayerTableEventType.Current or Rhino.DocObjects.Tables.LayerTableEventType.Sorted)) layersEdited = true; }
        var output = new StringBuilder();
        object? value = null;
        Exception? failure = null;
        var serial = document.BeginUndoRecord(label);
        if (serial == 0) throw new InvalidOperationException("UNDO_UNAVAILABLE");
        RhinoDoc.ReplaceRhinoObject += Replaced;
        RhinoDoc.ModifyObjectAttributes += Modified;
        RhinoDoc.LayerTableEvent += Layer;
        try { value = run(output); }
        catch (Exception error) { failure = error is TargetInvocationException { InnerException: not null } inner ? inner.InnerException! : error; }
        finally
        {
            RhinoDoc.ReplaceRhinoObject -= Replaced;
            RhinoDoc.ModifyObjectAttributes -= Modified;
            RhinoDoc.LayerTableEvent -= Layer;
            document.EndUndoRecord(serial);
        }
        // Commands may leave records of their own beside this one (if Rhino does not fold them
        // into the open record): the execution is then all of them, undone together.
        var last = document.NextUndoRecordSerialNumber - 1;
        for (var later = serial + 1; later <= last; later++)
            if (!discarded.Contains(later)) { groups[serial] = last; break; }
        var changes = Changes(before, touched);
        var log = Log(output);
        var any = changes.Any || layersEdited;
        if (failure != null)
        {
            // A failed run leaves nothing half done: its record is undone when it changed anything.
            if (!any) { discarded.Add(serial); groups.Remove(serial); }
            var reverted = !any || UndoExecution(serial);
            document.Views.Redraw();
            // A refused command started during the run (an alias): the AI corrects it like a policy refusal.
            if (failure is ScriptPolicyException && reverted)
                return new { ok = false, code = "CODE_POLICY_REJECTED", reverted, log, diagnostics = new[] { Short(failure.Message) } };
            return new { ok = false, code = reverted ? "EXECUTION_FAILED" : "HOST_RESULT_UNKNOWN", reverted, log,
                exceptionType = failure.GetType().FullName, message = Short(failure.Message) };
        }
        if (!guard.Confirmed)
        {
            var kind = changes.RemovedCount > guard.MaxDeletes ? "bulk-delete" : changes.LayersRemoved.Count > 0 ? "layer-delete" : null;
            if (kind != null)
            {
                var detail = kind == "bulk-delete" ? $"객체 {changes.RemovedCount}개를 지웁니다 (기준 {guard.MaxDeletes}개)."
                    : $"레이어 {changes.LayersRemoved.Count}개를 지웁니다: " + string.Join(", ", changes.LayersRemoved.Take(10));
                if (!UndoExecution(serial)) return new { ok = false, code = "HOST_RESULT_UNKNOWN", reverted = false, log };
                document.Views.Redraw();
                return Guarded(kind, detail, log, changes.RemovedCount, changes.LayersRemoved.Count);
            }
        }
        document.Views.Redraw();
        string? undoId = null;
        if (any) { records[serial] = false; undoId = serial.ToString(System.Globalization.CultureInfo.InvariantCulture); }
        else { discarded.Add(serial); groups.Remove(serial); }
        var result = new { ok = true, undoId, changes = changes.Report(), log, value = Value(value), units = document.ModelUnitSystem.ToString() };
        receipts[requestId] = (hash, result);
        return result;
    }

    private static object Guarded(string kind, string detail, string log, int deletes = 0, int layers = 0) =>
        new { ok = false, reverted = true, guarded = new { kind, detail, deletes, layers }, log };

    /// <summary>`direct-undo`: host undo of this connection's record, only while it is the latest one.</summary>
    internal object Undo(JsonElement request)
    {
        var text = request.GetProperty("undoId").GetString() ?? "";
        if (!uint.TryParse(text, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var serial) ||
            !records.TryGetValue(serial, out var isUndone)) return new { ok = false, reason = "unknown" };
        if (isUndone) return new { ok = true, already = true };
        // Latest: every record made after it is undone or was an empty record of ours (a run of
        // several bodies is undone newest first, so the next-newest becomes the latest).
        for (var later = (groups.TryGetValue(serial, out var end) ? end : serial) + 1; later < document.NextUndoRecordSerialNumber; later++)
            if (!undone.Contains(later) && !discarded.Contains(later)) return new { ok = false, reason = "not-latest" };
        if (!UndoExecution(serial)) return new { ok = false, reason = "undo-failed" };
        document.Views.Redraw();
        return new { ok = true };
    }

    /// <summary>`fingerprint`: the connection's cheap change token (same basis as inspect).</summary>
    internal static object Fingerprint(string documentHash, int revision) => new { ok = true, documentHash, revision };

    // An execution whose commands left several records (groups): undo newest first until a record
    // before the execution comes up, which is redone. Otherwise exactly its one record.
    private bool UndoExecution(uint serial)
    {
        if (!groups.TryGetValue(serial, out var last)) return UndoRecord(serial);
        var undid = false;
        for (var step = 0; step <= last - serial + 1; step++)
        {
            var seen = watching = new List<uint>();
            try
            {
                var next = document.NextUndoRecordSerialNumber;
                var ok = document.Undo();
                CloseOwnRecord(next);
                if (!ok || seen.Count == 0) break;
                if (seen.Any(s => s < serial))
                {
                    next = document.NextUndoRecordSerialNumber;
                    document.Redo();
                    CloseOwnRecord(next);
                    break;
                }
                undid = true;
                if (seen.Contains(serial)) break;
            }
            finally { watching = null; }
        }
        if (!undid) return false;
        for (var s = serial; s <= last; s++) undone.Add(s);
        if (records.ContainsKey(serial)) records[serial] = true;
        return true;
    }

    // Undo exactly `serial`. If Rhino undid a different record (ours was empty or already gone), redo it.
    private bool UndoRecord(uint serial)
    {
        var seen = watching = new List<uint>();
        try
        {
            var next = document.NextUndoRecordSerialNumber;
            var ok = document.Undo();
            CloseOwnRecord(next);
            if (!ok) return false;
            if (seen.Count > 0 && !seen.Contains(serial))
            {
                next = document.NextUndoRecordSerialNumber;
                document.Redo();
                CloseOwnRecord(next);
                return false;
            }
        }
        finally { watching = null; }
        undone.Add(serial);
        if (records.ContainsKey(serial)) records[serial] = true;
        return true;
    }

    // RhinoDoc.Undo/Redo outside a command open a record of their own and leave it open (seen on
    // Rhino 8: the next Undo, Redo or BeginUndoRecord then fails). Close it; its serial is no
    // record standing above ours.
    private void CloseOwnRecord(uint next)
    {
        if (document.UndoRecordingIsActive && document.CurrentUndoRecordSerialNumber >= next)
            document.EndUndoRecord(document.CurrentUndoRecordSerialNumber);
        for (var own = next; own < document.NextUndoRecordSerialNumber; own++) discarded.Add(own);
    }

    private sealed record ChangeReport(List<RhinoObject> Added, List<RhinoObject> Changed, List<(Guid Id, string Layer)> Removed,
        List<string> LayersAdded, List<string> LayersRemoved, DirectExecutor Owner)
    {
        internal int RemovedCount => Removed.Count;
        internal bool Any => Added.Count + Changed.Count + Removed.Count + LayersAdded.Count + LayersRemoved.Count > 0;
        internal object Report() => new
        {
            added = Added.Take(MaxListed).Select(obj => new { nativeId = obj.Id.ToString(), hash = Hash(obj), layer = Owner.LayerPath(obj.Attributes.LayerIndex) }).ToArray(),
            changed = Changed.Take(MaxListed).Select(obj => new { nativeId = obj.Id.ToString(), hash = Hash(obj), layer = Owner.LayerPath(obj.Attributes.LayerIndex) }).ToArray(),
            removed = Removed.Take(MaxListed).Select(item => new { nativeId = item.Id.ToString(), layer = item.Layer }).ToArray(),
            counts = new { added = Added.Count, changed = Changed.Count, removed = Removed.Count },
            layers = new { added = LayersAdded, removed = LayersRemoved },
        };
    }

    private ChangeReport Changes(Before before, HashSet<Guid> touched)
    {
        var current = Objects().ToDictionary(obj => obj.Id);
        var added = current.Values.Where(obj => !before.Objects.ContainsKey(obj.Id)).ToList();
        var changed = touched.Where(id => before.Objects.ContainsKey(id) && current.ContainsKey(id)).Select(id => current[id]).ToList();
        var removed = before.Objects.Where(entry => !current.ContainsKey(entry.Key)).Select(entry => (entry.Key, entry.Value)).ToList();
        var layers = LiveLayers();
        return new ChangeReport(added, changed, removed,
            layers.Where(entry => !before.Layers.ContainsKey(entry.Key)).Select(entry => entry.Value).ToList(),
            before.Layers.Where(entry => !layers.ContainsKey(entry.Key)).Select(entry => entry.Value).ToList(), this);
    }

    private static string Log(StringBuilder output) { var text = output.ToString(); return text.Length > 65536 ? text[..65536] : text; }
    private static string Short(string text) => text.Length > 500 ? text[..500] : text;
    private static object? Value(object? value)
    {
        if (value is null or string or bool or int or long or double or float or decimal) return value;
        try { return JsonSerializer.SerializeToElement(value, new JsonSerializerOptions { MaxDepth = 8 }); }
        catch { return Short(value.ToString() ?? ""); }
    }

    private sealed record Compiled(byte[]? Bytes, bool Purges, object? Failure);

    // The body gets `doc` (this document, its own units) and `output` (a StringBuilder log).
    private static Compiled Compile(string code, string requestId)
    {
        var source = "using System; using System.Linq; using System.Collections.Generic; using Rhino; using Rhino.Geometry; public static class TaskCode { public static object Run(RhinoDoc doc, System.Text.StringBuilder output) { " + code + "\nreturn null; } }";
        var references = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location))
            .Select(a => MetadataReference.CreateFromFile(a.Location));
        var compilation = CSharpCompilation.Create("VIDEDirect_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(requestId)))[..24],
            [CSharpSyntaxTree.ParseText(source)], references, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var policy = CodePolicy.Check(compilation);
        if (policy.Length > 0) return new(null, false, new { ok = false, code = "CODE_POLICY_REJECTED", diagnostics = policy });
        using var bytes = new MemoryStream();
        var emitted = compilation.Emit(bytes);
        if (!emitted.Success) return new(null, false, new { ok = false, code = "COMPILE_ERROR",
            diagnostics = emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(12).Select(d => d.ToString()).ToArray() });
        return new(bytes.ToArray(), CodePolicy.Purges(compilation), null);
    }
}
