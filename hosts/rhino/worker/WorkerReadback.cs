using System.Globalization;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace Vide.Worker;

// A bounding box alone cannot prove that a saved candidate retained its shape or data.
internal static class WorkerReadback
{
    internal static void Verify(RhinoDoc expected, RhinoDoc actual)
    {
        if (actual.ModelUnitSystem != expected.ModelUnitSystem)
            throw new InvalidOperationException("Readback units mismatch");
        var originals = BlockIdentity.Objects(expected);
        if (BlockIdentity.Objects(actual).Length != originals.Length || BlockIdentity.Signature(expected) != BlockIdentity.Signature(actual))
            throw new InvalidOperationException("Readback count mismatch");
        foreach (var original in originals)
        {
            var restored = actual.Objects.FindId(original.Id);
            if (restored == null || restored.ObjectType != original.ObjectType || !restored.Geometry.IsValid)
                throw new InvalidOperationException("Readback identity mismatch");
            if (!GeometryBase.GeometryEquals(original.Geometry, restored.Geometry))
                throw new InvalidOperationException("Readback geometry mismatch");
            if (Metadata(original) != Metadata(restored) ||
                expected.Layers[original.Attributes.LayerIndex].FullPath != actual.Layers[restored.Attributes.LayerIndex].FullPath)
                throw new InvalidOperationException("Readback attributes mismatch");
        }
    }

    internal static string Metadata(RhinoObject obj) =>
        Metadata(obj.Attributes, obj.Geometry);
    internal static string Metadata(ObjectAttributes attributes, GeometryBase geometry) =>
        Attributes(attributes) + "|geometry-data=" + Strings(geometry.GetUserStrings());

    internal static void VerifyArchive(RhinoDoc expected, Rhino.FileIO.File3dm actual)
    {
        if (actual.Settings.ModelUnitSystem != expected.ModelUnitSystem) throw new InvalidOperationException("Readback units mismatch");
        var originals = BlockIdentity.Objects(expected);
        if (BlockIdentity.Signature(expected) != BlockIdentity.Signature(actual.AllInstanceDefinitions))
            throw new InvalidOperationException("Readback block definition mismatch");
        var restored = actual.Objects.ToDictionary(obj => obj.Attributes.ObjectId);
        if (restored.Count != originals.Length) throw new InvalidOperationException("Readback count mismatch");
        foreach (var obj in originals)
        {
            if (!restored.TryGetValue(obj.Id, out var saved) || !saved.Geometry.IsValid || !GeometryBase.GeometryEquals(obj.Geometry, saved.Geometry))
                throw new InvalidOperationException("Readback geometry mismatch");
            if (Metadata(obj) != Metadata(saved.Attributes, saved.Geometry)) throw new InvalidOperationException("Readback attributes mismatch");
            var layer = actual.AllLayers.FirstOrDefault(layer => layer.Index == saved.Attributes.LayerIndex);
            if (layer == null || layer.Id != expected.Layers[obj.Attributes.LayerIndex].Id || layer.Name != expected.Layers[obj.Attributes.LayerIndex].Name)
                throw new InvalidOperationException("Readback layer mismatch");
        }
    }

    private static string Attributes(ObjectAttributes attributes)
    {
        // Archive bookkeeping bytes differ after reopen; compare public values instead.
        var values = typeof(ObjectAttributes).GetProperties().OrderBy(p => p.Name)
            .Where(p => p.GetIndexParameters().Length == 0 && p.Name != "IsDocumentControlled" &&
                (p.PropertyType.IsValueType || p.PropertyType == typeof(string)))
            .Select(p => p.Name + "=" + Encode(Convert.ToString(p.GetValue(attributes), CultureInfo.InvariantCulture) ?? ""));
        return string.Join("|", values) + "|" + Strings(attributes.GetUserStrings()) +
            "|groups=" + string.Join(",", attributes.GetGroupList() ?? []);
    }

    private static string Strings(System.Collections.Specialized.NameValueCollection strings) =>
        string.Join("|", strings.AllKeys.Where(key => key != null).OrderBy(key => key, StringComparer.Ordinal)
            .Select(key => Encode(key!) + "=" + Encode(strings[key!] ?? "")));
    private static string Encode(string text) => Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(text));
}
