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
        var originals = expected.Objects.GetObjectList(ObjectType.AnyObject).ToArray();
        if (actual.Objects.GetObjectList(ObjectType.AnyObject).Count() != originals.Length)
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
        Attributes(obj.Attributes) + "|geometry-data=" + Strings(obj.Geometry.GetUserStrings());

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
