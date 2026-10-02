using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;
using System.Text;
using System.Text.RegularExpressions;
using System.Security.Cryptography;

namespace Vide.Worker;

internal static class WorkerScene
{
    internal sealed record Measurements(double? Area, double? Volume, double? Length);
    internal static string Id(RhinoObject obj) => obj.Attributes.GetUserString("vide-id") ?? obj.Id.ToString();
    internal static string Fingerprint(RhinoObject obj)
    {
        var options = new Rhino.FileIO.SerializationOptions { WriteUserData = true, WriteRenderMeshes = false, WriteAnalysisMeshes = false };
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(obj.Geometry.ToJSON(options) + "\n" + obj.Attributes.ToJSON(options))));
    }

    internal static void Validate(RhinoDoc doc)
    {
        // No document object count cap (ADR-031 7): reads are paged.
        var objects = doc.Objects.GetObjectList(ObjectType.AnyObject).ToArray();
        var ids = new HashSet<string>();
        foreach (var obj in objects)
        {
            var id = Id(obj);
            if (!Regex.IsMatch(id, "^[a-zA-Z0-9_-]{1,100}$") || !ids.Add(id) || !obj.Geometry.IsValid)
                throw new InvalidOperationException("INVALID_GEOMETRY");
            if (obj.Attributes.GetUserString("vide-id") == null)
            {
                var attributes = obj.Attributes.Duplicate();
                attributes.SetUserString("vide-id", id);
                if (!doc.Objects.ModifyAttributes(obj, attributes, true)) throw new InvalidOperationException("INVALID_GEOMETRY");
            }
        }
    }

    // Detailed meshes/measurements are exported once for the candidate, not on every AI query.
    // Block instances carry their definition (flattened, in definition space) once per page and a
    // row-major transform, the same shape as DisplayScene; `scope` limits the read to layers and
    // includes hidden objects when asked (files opened in VIDE, ARCH-03 §8).
    internal static object Export(RhinoDoc doc, Func<RhinoObject, string, Measurements?>? cached = null,
        Action<RhinoObject, string, Measurements>? observed = null, int offset = 0, int limit = int.MaxValue, int revision = 0, bool displayOnly = false,
        ReadScope? scope = null, bool boxOnly = false)
    {
        var scale = displayOnly ? RhinoMath.UnitScale(doc.ModelUnitSystem, UnitSystem.Meters) : 1.0;
        if (!double.IsFinite(scale) || scale <= 0 || (displayOnly && doc.ModelUnitSystem is UnitSystem.None or UnitSystem.CustomUnits))
            throw new InvalidOperationException("UNKNOWN_UNITS");
        scope ??= ReadScope.Display;
        var ordered = DisplayScene.Listed(doc, scope);
        if (offset < 0 || offset > ordered.Length || limit < 1)
            throw new InvalidOperationException("INVALID_PAGE");
        var survey = ReadSurvey.Of(doc, ordered, scope);
        var objects = new List<object>();
        var scene = new List<object>();
        var definitions = new Dictionary<string, object>();
        var remainingAttributes = 262144;
        var measuredObjects = 0;
        var reusedObjects = 0;
        foreach (var obj in ordered.Skip(offset).Take(limit))
        {
            var geometry = obj.Geometry;
            var bounds = geometry.GetBoundingBox(true);
            if (!bounds.IsValid) throw new InvalidOperationException("INVALID_GEOMETRY");
            var origin = new[] { bounds.Min.X * scale, bounds.Min.Y * scale, bounds.Min.Z * scale };
            var vertices = new List<double>(); var indices = new List<int>(); var line = new List<double>();
            using var converted = geometry is Extrusion extrusion ? extrusion.ToBrep() : null;
            var brep = geometry as Brep ?? converted;
            var curve = geometry as Curve;
            object? block = null;
            if (!boxOnly && geometry is InstanceReferenceGeometry reference && doc.InstanceDefinitions.FindId(reference.ParentIdefId) is { IsDeleted: false } definition)
            {
                var key = definition.Id.ToString();
                if (!definitions.ContainsKey(key)) definitions[key] = DefinitionJson(doc, definition, scale);
                block = new { definition = key, transform = DisplayScene.TransformOf(reference.Xform, scale) };
            }
            if (!boxOnly && brep != null && geometry.IsValid)
            {
                using var local = brep.DuplicateBrep();
                var center = bounds.Center;
                local.Transform(Transform.Translation(-center.X, -center.Y, -center.Z));
                var meshes = Mesh.CreateFromBrep(local, MeshingParameters.FastRenderMesh) ?? [];
                foreach (var mesh in meshes) { AddMesh(mesh, center, vertices, indices); mesh.Dispose(); }
            }
            else if (!boxOnly && geometry is Mesh nativeMesh && geometry.IsValid) AddMesh(nativeMesh, Point3d.Origin, vertices, indices);
            if (!boxOnly && curve != null && geometry.IsValid)
            {
                if (curve.TryGetPolyline(out var polyline)) foreach (var point in polyline) AddPoint(point, line);
                else foreach (var parameter in curve.DivideByCount(128, true) ?? []) AddPoint(curve.PointAt(parameter), line);
            }
            // One object larger than a host reply (16 MB, ADR-031 7): its bounding box stands in for it
            // and the row says so; the Sync continues.
            if (boxOnly) BoxMesh(bounds, vertices, indices);
            var geometryOptions = new Rhino.FileIO.SerializationOptions { WriteUserData = true, WriteRenderMeshes = false, WriteAnalysisMeshes = false };
            var geometryHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(geometry.ToJSON(geometryOptions)))).ToLowerInvariant();
            var measurements = displayOnly ? new Measurements(null, null, null) : cached?.Invoke(obj, geometryHash);
            if (measurements != null) { if (!displayOnly) reusedObjects++; }
            else
            {
                using var area = brep != null ? AreaMassProperties.Compute(brep) : geometry is Mesh areaMesh ? AreaMassProperties.Compute(areaMesh) : curve?.IsClosed == true ? AreaMassProperties.Compute(curve) : null;
                using var volume = brep?.IsSolid == true ? VolumeMassProperties.Compute(brep) : geometry is Mesh volumeMesh && volumeMesh.IsClosed ? VolumeMassProperties.Compute(volumeMesh) : null;
                measurements = new Measurements(area?.Area, volume?.Volume, curve?.GetLength());
                measuredObjects++;
            }
            observed?.Invoke(obj, geometryHash, measurements);
            var attributes = new List<string[]>(); var complete = true; var bytes = 0;
            var strings = obj.Attributes.GetUserStrings();
            foreach (var key in strings.AllKeys)
            {
                if (key == null) continue;
                var value = strings[key] ?? ""; var size = Encoding.UTF8.GetByteCount(key) + Encoding.UTF8.GetByteCount(value);
                if (attributes.Count >= 32 || bytes + size > 4096 || remainingAttributes < size || key.Length > 200 || value.Length > 4000) { complete = false; continue; }
                attributes.Add([Encode(key), Encode(value)]); bytes += size; remainingAttributes -= size;
            }
            var id = Id(obj); var name = obj.Name ?? "Object";
            objects.Add(new { id, nativeId = obj.Id.ToString(), kind = "native", name, origin });
            var row = new Dictionary<string, object?>
            {
                ["id"] = id, ["nativeId"] = obj.Id.ToString(), ["nativeType"] = geometry.ObjectType.ToString(), ["geometryHash"] = geometryHash,
                ["name64"] = Encode(name), ["origin"] = origin,
                ["boundsSize"] = new[] { (bounds.Max.X - bounds.Min.X) * scale, (bounds.Max.Y - bounds.Min.Y) * scale, (bounds.Max.Z - bounds.Min.Z) * scale },
                ["vertices"] = vertices.Select(value => value * scale).ToArray(), ["indices"] = indices, ["line"] = line.Select(value => value * scale).ToArray(),
                ["area"] = measurements.Area, ["volume"] = measurements.Volume, ["length"] = measurements.Length,
                ["layer64"] = Encode(doc.Layers[obj.Attributes.LayerIndex].FullPath), ["attributes64"] = attributes, ["attributesComplete"] = complete, ["valid"] = geometry.IsValid,
                ["displayColor"] = Hex(obj.Attributes.DrawColor(doc)), ["layerColor"] = Hex(doc.Layers[obj.Attributes.LayerIndex].Color), ["materialColor"] = MaterialColor(obj),
            };
            if (block != null) row["block"] = block;
            if (boxOnly) row["oversized"] = true;
            scene.Add(row);
        }
        return new { objects, scene, definitions, coverage = survey.Coverage, layers = survey.Layers, measurementVersion = 1,
            measurementStats = new { measuredObjects, reusedObjects },
            page = new { offset, nextOffset = offset + objects.Count, total = ordered.Length, revision } };
    }

    /** Flattened block definition (nested references included) in definition space, hashed like DisplayScene's. */
    private static object DefinitionJson(RhinoDoc doc, InstanceDefinition definition, double scale)
    {
        var parts = new DisplayParts(doc, scale);
        parts.AddDefinition(definition, Transform.Identity, 0, [definition.Id]);
        var texts = parts.Texts.Select(text => new { s = text.S, p = text.P, h = text.H, r = text.R, ax = text.Ax, ay = text.Ay }).ToArray();
        var options = new System.Text.Json.JsonSerializerOptions();
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(Encoding.UTF8.GetBytes(definition.Id.ToString()));
        hash.AppendData(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(parts.Vertices, options));
        hash.AppendData(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(parts.Indices, options));
        hash.AppendData(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(parts.Segments, options));
        hash.AppendData(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(texts, options));
        return new { hash = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant(),
            vertices = parts.Vertices, indices = parts.Indices, segments = parts.Segments, texts };
    }

    private static string Encode(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
    // Display colors resolve Rhino's ColorSource (layer/object/material/parent); render material diffuse is optional.
    private static string Hex(System.Drawing.Color color) => "#" + color.R.ToString("x2") + color.G.ToString("x2") + color.B.ToString("x2");
    private static string? MaterialColor(RhinoObject obj)
    {
        try { var material = obj.GetMaterial(true); return material == null ? null : Hex(material.DiffuseColor); }
        catch (Exception) { return null; }
    }
    /** The 8 corners and 12 triangles of a bounding box, in the same coordinates as AddMesh. */
    internal static void BoxMesh(BoundingBox bounds, List<double> vertices, List<int> indices)
    {
        var offset = vertices.Count / 3;
        foreach (var corner in bounds.GetCorners()) AddPoint(corner, vertices);
        // GetCorners: 0-3 bottom (min Z) counter-clockwise, 4-7 top in the same order.
        int[] faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
        foreach (var index in faces) indices.Add(offset + index);
    }
    private static void AddPoint(Point3d point, List<double> vertices) { vertices.Add(point.X); vertices.Add(point.Y); vertices.Add(point.Z); }
    private static void AddMesh(Mesh mesh, Point3d origin, List<double> vertices, List<int> indices)
    {
        var offset = vertices.Count / 3;
        for (var i = 0; i < mesh.Vertices.Count; i++) { var point = mesh.Vertices.Point3dAt(i); AddPoint(new Point3d(point.X + origin.X, point.Y + origin.Y, point.Z + origin.Z), vertices); }
        foreach (var face in mesh.Faces)
        {
            indices.Add(offset + face.A); indices.Add(offset + face.B); indices.Add(offset + face.C);
            if (face.IsQuad) { indices.Add(offset + face.A); indices.Add(offset + face.C); indices.Add(offset + face.D); }
        }
    }
}
