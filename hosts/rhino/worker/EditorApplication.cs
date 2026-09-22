using System.Security.Cryptography;
using System.Text.Json;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace Vide.Worker;

// Apply a verified candidate, never newly generated code, to its captured editing document.
internal sealed class EditorApplication(RhinoDoc document, string directory, Func<string> fingerprint)
{
    private sealed record Item(string Id, Guid NativeId, GeometryBase Geometry, ObjectAttributes Attributes, string Metadata) : IDisposable
    {
        public void Dispose() { Geometry.Dispose(); Attributes.Dispose(); }
    }
    private sealed class Plan : IDisposable
    {
        internal Dictionary<string, Item> Items = new();
        internal List<Guid> Removed = new();
        internal HashSet<string> Updated = new();
        internal HashSet<string> Added = new();
        public void Dispose() { foreach (var item in Items.Values) item.Dispose(); }
    }
    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

    private Plan Prepare(string filename, string hash)
    {
        if (Hash(filename) != hash) throw new InvalidOperationException("SOURCE_CHANGED");
        using var candidate = Rhino.FileIO.File3dm.Read(filename);
        if (candidate == null || candidate.Settings.ModelUnitSystem != UnitSystem.Meters ||
            document.ModelUnitSystem is UnitSystem.None or UnitSystem.CustomUnits) throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
        if (candidate.Strings.Count != document.Strings.Count || Enumerable.Range(0, candidate.Strings.Count).Any(i =>
            candidate.Strings.GetValue(i) != document.Strings.GetValue(candidate.Strings.GetKey(i))))
            throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
        var current = document.Objects.GetObjectList(ObjectType.AnyObject).ToDictionary(WorkerScene.Id);
        var plan = new Plan();
        try
        {
            if (candidate.Objects.Count > 500) throw new InvalidOperationException("IMPORT_LIMIT");
            foreach (var obj in candidate.Objects)
            {
                var id = obj.Attributes.GetUserString("vide-id") ?? obj.Attributes.ObjectId.ToString();
                if (plan.Items.ContainsKey(id) || obj.Attributes.GroupCount > 0 || obj.Attributes.MaterialIndex != -1 ||
                    !(obj.Geometry is Brep or Extrusion or Curve or Mesh or Point)) throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
                var layer = candidate.AllLayers.FirstOrDefault(layer => layer.Index == obj.Attributes.LayerIndex);
                var targetLayer = layer == null ? null : document.Layers.FirstOrDefault(item => !item.IsDeleted && item.Id == layer.Id);
                if (targetLayer == null || targetLayer.Name != layer!.Name || targetLayer.ParentLayerId != layer.ParentLayerId || targetLayer.Color != layer.Color || targetLayer.IsVisible != layer.IsVisible || targetLayer.IsLocked != layer.IsLocked || targetLayer.PlotWeight != layer.PlotWeight || targetLayer.PlotColor != layer.PlotColor || targetLayer.LinetypeIndex != layer.LinetypeIndex || targetLayer.RenderMaterialIndex != layer.RenderMaterialIndex)
                    throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
                var geometry = obj.Geometry.Duplicate();
                var attributes = obj.Attributes.Duplicate();
                current.TryGetValue(id, out var original);
                attributes.ObjectId = original?.Id ?? obj.Attributes.ObjectId;
                attributes.LayerIndex = targetLayer.Index;
                var item = new Item(id, attributes.ObjectId, geometry, attributes, WorkerReadback.Metadata(attributes, geometry));
                plan.Items.Add(id, item);
                var scale = RhinoMath.UnitScale(UnitSystem.Meters, document.ModelUnitSystem);
                if (!geometry.Transform(Transform.Scale(Point3d.Origin, scale)) || !geometry.IsValid)
                    throw new InvalidOperationException("INVALID_GEOMETRY");
                if (original == null)
                {
                    if (document.Objects.FindId(item.NativeId) != null) throw new InvalidOperationException("TARGET_MISMATCH");
                    plan.Added.Add(id);
                }
                else if (!GeometryBase.GeometryEquals(original.Geometry, geometry) || WorkerReadback.Metadata(original) != item.Metadata)
                    plan.Updated.Add(id);
            }
            foreach (var entry in current)
            {
                if (!plan.Items.ContainsKey(entry.Key)) plan.Removed.Add(entry.Value.Id);
                if ((!plan.Items.ContainsKey(entry.Key) || plan.Updated.Contains(entry.Key)) &&
                    (entry.Value.IsLocked || entry.Value.IsReference || entry.Value.IsInstanceDefinitionGeometry ||
                     entry.Value.Attributes.GroupCount > 0 || entry.Value.HasHistoryRecord() || entry.Value.HistoryParents().Length > 0 || entry.Value.HistoryChildren().Length > 0))
                    throw new InvalidOperationException("UNSUPPORTED_NATIVE_TARGET");
            }
            return plan;
        }
        catch { plan.Dispose(); throw; }
    }

    private bool Matches(Plan plan)
    {
        var actual = document.Objects.GetObjectList(ObjectType.AnyObject).ToArray();
        return actual.Length == plan.Items.Count && actual.All(obj => plan.Items.TryGetValue(WorkerScene.Id(obj), out var item) &&
            obj.Id == item.NativeId && GeometryBase.GeometryEquals(obj.Geometry, item.Geometry) && WorkerReadback.Metadata(obj) == item.Metadata);
    }

    private string Difference(Plan plan)
    {
        foreach (var item in plan.Items.Values)
        {
            var obj = document.Objects.FindId(item.NativeId);
            if (obj == null) return "Missing target " + item.Id;
            if (!GeometryBase.GeometryEquals(obj.Geometry, item.Geometry)) return "Geometry mismatch " + item.Id;
            var expected = item.Metadata;
            var actual = WorkerReadback.Metadata(obj);
            if (expected != actual) return "Attributes mismatch " + item.Id + ": " + string.Join(",", expected.Split('|').Except(actual.Split('|')).Select(value => value.Split('=')[0]));
        }
        return "Object set mismatch";
    }

    internal object Preview(string filename, string hash, string expected)
    {
        if (fingerprint() != expected) throw new InvalidOperationException("SOURCE_CHANGED");
        using var plan = Prepare(filename, hash);
        return new { documentHash = expected, added = plan.Added.Count, updated = plan.Updated.Count, removed = plan.Removed.Count, mode = "sdk-native" };
    }

    private void Persist(string path, object receipt)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(receipt);
        using (var stream = new FileStream(path + ".tmp", FileMode.Create, FileAccess.Write, FileShare.None)) { stream.Write(bytes); stream.Flush(true); }
        File.Move(path + ".tmp", path, true);
    }

    internal object Apply(string operation, string filename, string hash, string expected)
    {
        if (!Guid.TryParseExact(operation, "D", out _)) throw new InvalidOperationException("INVALID_OPERATION");
        var receiptPath = Path.Combine(directory, operation + ".application.json");
        if (File.Exists(receiptPath)) return Recover(operation, filename, hash, expected);
        var started = false;
        try
        {
            if (fingerprint() != expected) return Outcome("failed", "SOURCE_CHANGED", false);
            using var plan = Prepare(filename, hash);
            Persist(receiptPath, new { operation, filename, hash, before = expected, mapping = plan.Items.ToDictionary(entry => entry.Key, entry => entry.Value.NativeId.ToString()), state = "unknown" });
            var undo = document.BeginUndoRecord("VIDE candidate application");
            try
            {
                started = true;
                foreach (var id in plan.Removed) if (!document.Objects.Delete(id, true)) throw new InvalidOperationException("Delete failed");
                foreach (var id in plan.Updated)
                {
                    var item = plan.Items[id];
                    if (document.Objects.FindId(item.NativeId) == null || !item.Geometry.IsValid) throw new InvalidOperationException("Staged geometry or target missing");
                    if (!document.Objects.ModifyAttributes(item.NativeId, item.Attributes, true)) throw new InvalidOperationException("Attribute replace failed");
                    var replaced = item.Geometry switch
                    {
                        Brep brep => document.Objects.Replace(item.NativeId, brep),
                        Extrusion extrusion => document.Objects.Replace(item.NativeId, extrusion),
                        Curve curve => document.Objects.Replace(item.NativeId, curve),
                        Mesh mesh => document.Objects.Replace(item.NativeId, mesh),
                        Point point => document.Objects.Replace(item.NativeId, point.Location),
                        _ => false
                    };
                    if (!replaced) throw new InvalidOperationException("Geometry replace failed: " + item.Geometry.ObjectType);
                }
                foreach (var id in plan.Added)
                {
                    var item = plan.Items[id];
                    if (document.Objects.Add(item.Geometry, item.Attributes) != item.NativeId) throw new InvalidOperationException("Add identity mismatch");
                }
                if (!Matches(plan)) throw new InvalidOperationException("Application verification failed: " + Difference(plan));
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

    internal object Recover(string operation, string filename, string hash, string expected)
    {
        if (!Guid.TryParseExact(operation, "D", out _)) throw new InvalidOperationException("INVALID_OPERATION");
        try
        {
            using var receipt = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, operation + ".application.json")));
            var value = receipt.RootElement;
            if (value.GetProperty("hash").GetString() != hash || value.GetProperty("before").GetString() != expected || value.GetProperty("filename").GetString() != filename)
                return Outcome("unknown", "OPERATION_CONFLICT", false);
            if (value.GetProperty("state").GetString() == "succeeded") return Outcome("succeeded", "APPLIED", true);
            using var plan = Prepare(filename, hash);
            var mapping = value.GetProperty("mapping");
            if (plan.Items.All(entry => mapping.TryGetProperty(entry.Key, out var nativeId) && nativeId.GetString() == entry.Value.NativeId.ToString()) && Matches(plan)) return Outcome("succeeded", "APPLIED", true);
            if (fingerprint() == expected) return Outcome("failed", "ORIGINAL_UNCHANGED", false);
        }
        catch { }
        return Outcome("unknown", "HOST_RESULT_UNKNOWN", false);
    }

    private object Outcome(string state, string code, bool applied) => new { state, result = new { code, applied, saved = false, documentId = document.RuntimeSerialNumber } };
}
