using System.Security.Cryptography;
using System.Text.Json;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace Vide.Worker;

/// <summary>
/// What the AI changed in its working copy (ids as WorkerScene.Id), and the per-object hashes of the
/// live document when that copy was captured.
/// </summary>
internal sealed record ChangeSet(string[] Added, string[] Modified, string[] Removed, IReadOnlyDictionary<string, string> Captured)
{
    internal IEnumerable<string> Written => Added.Concat(Modified);

    internal static ChangeSet Read(JsonElement request, string directory)
    {
        if (!request.TryGetProperty("changes", out var changes) || changes.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
        string[] Ids(string name) => changes.TryGetProperty(name, out var list) && list.ValueKind == JsonValueKind.Array
            ? list.EnumerateArray().Select(value => value.GetString() ?? throw new InvalidOperationException("INVALID_INPUT")).Distinct().ToArray() : [];
        var capture = request.GetProperty("capture").GetString() ?? "";
        var full = Path.GetFullPath(capture);
        if (!full.StartsWith(Path.GetFullPath(directory) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("INVALID_ARTIFACT");
        using var receipt = JsonDocument.Parse(File.ReadAllText(full + ".capture.json"));
        if (!receipt.RootElement.TryGetProperty("objects", out var objects))
            throw new InvalidOperationException("RESYNC_REQUIRED");
        var captured = objects.EnumerateObject().ToDictionary(entry => entry.Name, entry => entry.Value.GetString() ?? "");
        return new ChangeSet(Ids("added"), Ids("modified"), Ids("removed"), captured);
    }
}

// Apply a verified candidate, never newly generated code, to its captured editing document. Only
// the objects the AI added, modified or removed are written; every other object is left alone.
internal sealed class EditorApplication(RhinoDoc document, string directory, Func<string> fingerprint)
{
    private sealed record Item(string Id, Guid NativeId, GeometryBase Geometry, ObjectAttributes Attributes) : IDisposable
    {
        public void Dispose() { Geometry.Dispose(); Attributes.Dispose(); }
    }
    private sealed class Plan : IDisposable
    {
        internal Dictionary<string, Item> Items = new();
        internal List<Guid> Removed = new();
        internal HashSet<string> Updated = new();
        internal HashSet<string> Added = new();
        /** Layers to add in order; Parent is the staged index of a new parent, or -1 (live parent or root). */
        internal List<(Layer Layer, int Parent)> NewLayers = new();
        public void Dispose() { foreach (var item in Items.Values) item.Dispose(); }
    }
    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

    private RhinoObject? Live(string id)
    {
        if (Guid.TryParse(id, out var guid) && document.Objects.FindId(guid) is { } direct && WorkerScene.Id(direct) == id) return direct;
        return document.Objects.GetObjectList(new ObjectEnumeratorSettings { HiddenObjects = true, LockedObjects = true })
            .FirstOrDefault(obj => WorkerScene.Id(obj) == id);
    }

    /// <summary>An object the application overwrites or removes must still be as it was captured.</summary>
    private static void Unchanged(RhinoObject obj, string id, ChangeSet changes)
    {
        if (!changes.Captured.TryGetValue(id, out var before) || before != WorkerScene.Fingerprint(obj))
            throw new InvalidOperationException("SOURCE_CHANGED");
        if (obj.IsLocked || obj.IsReference || obj.IsInstanceDefinitionGeometry)
            throw new InvalidOperationException("UNSUPPORTED_NATIVE_TARGET");
    }

    /// <summary>
    /// The live layer for a candidate layer: same id, else same full path, else a new one (index -1-n into
    /// the staged list). A new layer's parent is found the same way, recursively, so a new sublayer of a
    /// new parent is staged after its parent and never lands in the root.
    /// </summary>
    private int TargetLayer(Rhino.FileIO.File3dm candidate, int index, Plan plan)
    {
        var layer = candidate.AllLayers.FirstOrDefault(item => item.Index == index) ?? throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
        var existing = document.Layers.FirstOrDefault(item => !item.IsDeleted && item.Id == layer.Id) ??
            document.Layers.FirstOrDefault(item => !item.IsDeleted && item.FullPath == layer.FullPath);
        if (existing != null) return existing.Index;
        var stagedAt = plan.NewLayers.FindIndex(item => item.Layer.Id == layer.Id);
        if (stagedAt >= 0) return -1 - stagedAt;
        var staged = new Layer { Name = layer.Name, Color = layer.Color, Id = layer.Id };
        var stagedParent = -1;
        var parent = layer.ParentLayerId == Guid.Empty ? null : candidate.AllLayers.FirstOrDefault(item => item.Id == layer.ParentLayerId);
        if (parent != null)
        {
            var target = TargetLayer(candidate, parent.Index, plan);
            if (target >= 0) staged.ParentLayerId = document.Layers[target].Id;
            else stagedParent = -1 - target;
        }
        plan.NewLayers.Add((staged, stagedParent));
        return -1 - (plan.NewLayers.Count - 1);
    }

    private Plan Prepare(string filename, string hash, ChangeSet changes)
    {
        if (Hash(filename) != hash) throw new InvalidOperationException("SOURCE_CHANGED");
        using var candidate = Rhino.FileIO.File3dm.Read(filename);
        if (candidate == null || candidate.Settings.ModelUnitSystem != UnitSystem.Meters ||
            document.ModelUnitSystem is UnitSystem.None or UnitSystem.CustomUnits) throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
        var written = candidate.Objects.GroupBy(obj => obj.Attributes.GetUserString("vide-id") ?? obj.Attributes.ObjectId.ToString())
            .ToDictionary(group => group.Key, group => group.First());
        var scale = RhinoMath.UnitScale(UnitSystem.Meters, document.ModelUnitSystem);
        var plan = new Plan();
        try
        {
            foreach (var id in changes.Written)
            {
                if (!written.TryGetValue(id, out var obj)) throw new InvalidOperationException("INVALID_ARTIFACT");
                if (obj.Geometry is InstanceReferenceGeometry) throw new InvalidOperationException("UNSUPPORTED_NATIVE_TARGET");
                var geometry = obj.Geometry.Duplicate();
                if (!geometry.Transform(Transform.Scale(Point3d.Origin, scale)) || !geometry.IsValid)
                    throw new InvalidOperationException("INVALID_GEOMETRY");
                var attributes = obj.Attributes.Duplicate();
                attributes.LayerIndex = TargetLayer(candidate, obj.Attributes.LayerIndex, plan);
                attributes.RemoveFromAllGroups();
                var original = Live(id);
                if (original != null)
                {
                    Unchanged(original, id, changes);
                    // Materials and groups live in document tables the copy does not map; keep the live ones.
                    attributes.ObjectId = original.Id;
                    attributes.MaterialSource = original.Attributes.MaterialSource;
                    attributes.MaterialIndex = original.Attributes.MaterialIndex;
                    foreach (var group in original.Attributes.GetGroupList() ?? []) attributes.AddToGroup(group);
                    plan.Updated.Add(id);
                }
                else
                {
                    if (document.Objects.FindId(obj.Attributes.ObjectId) != null) attributes.ObjectId = Guid.NewGuid();
                    attributes.MaterialSource = ObjectMaterialSource.MaterialFromLayer;
                    attributes.MaterialIndex = -1;
                    plan.Added.Add(id);
                }
                plan.Items.Add(id, new Item(id, attributes.ObjectId, geometry, attributes));
            }
            foreach (var id in changes.Removed)
            {
                var original = Live(id);
                if (original == null) continue;
                Unchanged(original, id, changes);
                plan.Removed.Add(original.Id);
            }
            return plan;
        }
        catch { plan.Dispose(); throw; }
    }

    private string? Difference(Plan plan)
    {
        foreach (var item in plan.Items.Values)
        {
            var obj = document.Objects.FindId(item.NativeId);
            if (obj == null) return "Missing target " + item.Id;
            if (!GeometryBase.GeometryEquals(obj.Geometry, item.Geometry)) return "Geometry mismatch " + item.Id;
        }
        foreach (var id in plan.Removed) if (document.Objects.FindId(id) != null) return "Not removed " + id;
        return null;
    }

    internal object Preview(string filename, string hash, string expected, ChangeSet changes)
    {
        using var plan = Prepare(filename, hash, changes);
        return new { documentHash = expected, added = plan.Added.Count, updated = plan.Updated.Count, removed = plan.Removed.Count, mode = "sdk-native" };
    }

    private void Persist(string path, object receipt)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(receipt);
        using (var stream = new FileStream(path + ".tmp", FileMode.Create, FileAccess.Write, FileShare.None)) { stream.Write(bytes); stream.Flush(true); }
        File.Move(path + ".tmp", path, true);
    }

    internal object Apply(string operation, string filename, string hash, string expected, ChangeSet changes)
    {
        if (!Guid.TryParseExact(operation, "D", out _)) throw new InvalidOperationException("INVALID_OPERATION");
        var receiptPath = Path.Combine(directory, operation + ".application.json");
        if (File.Exists(receiptPath)) return Recover(operation, filename, hash, expected, changes);
        var started = false;
        try
        {
            using var plan = Prepare(filename, hash, changes);
            Persist(receiptPath, new { operation, filename, hash, before = expected, mapping = plan.Items.ToDictionary(entry => entry.Key, entry => entry.Value.NativeId.ToString()), removed = plan.Removed, state = "unknown" });
            var undo = document.BeginUndoRecord("VIDE AI 편집");
            try
            {
                started = true;
                var layers = new List<int>();
                foreach (var (layer, parent) in plan.NewLayers)
                {
                    // Parents are staged before their sublayers, so a staged parent already has its live index.
                    if (parent >= 0) layer.ParentLayerId = document.Layers[layers[parent]].Id;
                    var index = document.Layers.Add(layer);
                    if (index < 0) throw new InvalidOperationException("Layer add failed: " + layer.Name);
                    layers.Add(index);
                }
                foreach (var item in plan.Items.Values)
                    if (item.Attributes.LayerIndex < 0) item.Attributes.LayerIndex = layers[-1 - item.Attributes.LayerIndex];
                foreach (var id in plan.Removed) if (!document.Objects.Delete(id, true)) throw new InvalidOperationException("Delete failed");
                foreach (var id in plan.Updated)
                {
                    var item = plan.Items[id];
                    if (document.Objects.FindId(item.NativeId) == null || !item.Geometry.IsValid) throw new InvalidOperationException("Staged geometry or target missing");
                    if (!document.Objects.ModifyAttributes(item.NativeId, item.Attributes, true)) throw new InvalidOperationException("Attribute replace failed");
                    if (!document.Objects.Replace(item.NativeId, item.Geometry, true)) throw new InvalidOperationException("Geometry replace failed: " + item.Geometry.ObjectType);
                }
                foreach (var id in plan.Added)
                {
                    var item = plan.Items[id];
                    if (document.Objects.Add(item.Geometry, item.Attributes) != item.NativeId) throw new InvalidOperationException("Add identity mismatch");
                }
                if (Difference(plan) is { } difference) throw new InvalidOperationException("Application verification failed: " + difference);
                document.Views.Redraw();
                Persist(receiptPath, new { operation, filename, hash, before = expected, after = fingerprint(), state = "succeeded" });
                return Outcome("succeeded", "APPLIED", true);
            }
            finally { if (undo != 0) document.EndUndoRecord(undo); }
        }
        catch (Exception error) {
            return new { state = started ? "unknown" : "failed", result = new { code = started ? "HOST_RESULT_UNKNOWN" : error is InvalidOperationException ? error.Message : "HOST_REJECTED", applied = false, saved = false, documentId = document.RuntimeSerialNumber, detail = error.Message } };
        }
    }

    internal object Recover(string operation, string filename, string hash, string expected, ChangeSet changes)
    {
        if (!Guid.TryParseExact(operation, "D", out _)) throw new InvalidOperationException("INVALID_OPERATION");
        try
        {
            using var receipt = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, operation + ".application.json")));
            var value = receipt.RootElement;
            if (value.GetProperty("hash").GetString() != hash || value.GetProperty("before").GetString() != expected || value.GetProperty("filename").GetString() != filename)
                return Outcome("unknown", "OPERATION_CONFLICT", false);
            if (value.GetProperty("state").GetString() == "succeeded") return Outcome("succeeded", "APPLIED", true);
            if (fingerprint() == expected) return Outcome("failed", "ORIGINAL_UNCHANGED", false);
            // Every written object present and every removed one gone means the application completed.
            var mapping = value.GetProperty("mapping");
            var written = mapping.EnumerateObject().All(entry => Guid.TryParse(entry.Value.GetString(), out var id) && document.Objects.FindId(id) != null);
            var removed = value.TryGetProperty("removed", out var gone) && gone.EnumerateArray().All(entry => document.Objects.FindId(entry.GetGuid()) == null);
            if (written && removed && changes.Written.All(id => mapping.TryGetProperty(id, out _))) return Outcome("succeeded", "APPLIED", true);
        }
        catch { /* Unreadable receipt is not proof of success; report unknown below. */ }
        return Outcome("unknown", "HOST_RESULT_UNKNOWN", false);
    }

    private object Outcome(string state, string code, bool applied) => new { state, result = new { code, applied, saved = false, documentId = document.RuntimeSerialNumber } };
}
