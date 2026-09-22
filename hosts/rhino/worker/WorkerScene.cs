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
        var objects = doc.Objects.GetObjectList(ObjectType.AnyObject).ToArray();
        if (objects.Length > 500) throw new InvalidOperationException("IMPORT_LIMIT");
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
    internal static object Export(RhinoDoc doc, Func<RhinoObject, Measurements?>? cached = null)
    {
        var objects = new List<object>();
        var scene = new List<object>();
        var remainingAttributes = 262144;
        var measuredObjects = 0;
        var reusedObjects = 0;
        foreach (var obj in doc.Objects.GetObjectList(ObjectType.AnyObject))
        {
            var geometry = obj.Geometry;
            var bounds = geometry.GetBoundingBox(true);
            if (!bounds.IsValid) throw new InvalidOperationException("INVALID_GEOMETRY");
            var origin = new[] { bounds.Min.X, bounds.Min.Y, bounds.Min.Z };
            var vertices = new List<double>(); var indices = new List<int>(); var line = new List<double>();
            using var converted = geometry is Extrusion extrusion ? extrusion.ToBrep() : null;
            var brep = geometry as Brep ?? converted;
            var curve = geometry as Curve;
            if (brep != null)
            {
                using var local = brep.DuplicateBrep();
                var center = bounds.Center;
                local.Transform(Transform.Translation(-center.X, -center.Y, -center.Z));
                var meshes = Mesh.CreateFromBrep(local, MeshingParameters.FastRenderMesh) ?? [];
                foreach (var mesh in meshes) { AddMesh(mesh, center, vertices, indices); mesh.Dispose(); }
            }
            else if (geometry is Mesh nativeMesh) AddMesh(nativeMesh, Point3d.Origin, vertices, indices);
            if (curve != null)
            {
                if (curve.TryGetPolyline(out var polyline)) foreach (var point in polyline) AddPoint(point, line);
                else foreach (var parameter in curve.DivideByCount(128, true) ?? []) AddPoint(curve.PointAt(parameter), line);
            }
            var measurements = cached?.Invoke(obj);
            if (measurements != null) reusedObjects++;
            else
            {
                using var area = brep != null ? AreaMassProperties.Compute(brep) : geometry is Mesh areaMesh ? AreaMassProperties.Compute(areaMesh) : curve?.IsClosed == true ? AreaMassProperties.Compute(curve) : null;
                using var volume = brep?.IsSolid == true ? VolumeMassProperties.Compute(brep) : geometry is Mesh volumeMesh && volumeMesh.IsClosed ? VolumeMassProperties.Compute(volumeMesh) : null;
                measurements = new Measurements(area?.Area, volume?.Volume, curve?.GetLength());
                measuredObjects++;
            }
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
            scene.Add(new { id, nativeId = obj.Id.ToString(), nativeType = geometry.ObjectType.ToString(), name64 = Encode(name), origin,
                boundsSize = new[] { bounds.Max.X - bounds.Min.X, bounds.Max.Y - bounds.Min.Y, bounds.Max.Z - bounds.Min.Z },
                vertices, indices, line, area = measurements.Area, volume = measurements.Volume, length = measurements.Length,
                layer64 = Encode(doc.Layers[obj.Attributes.LayerIndex].FullPath), attributes64 = attributes, attributesComplete = complete, valid = geometry.IsValid });
        }
        return new { objects, scene, measurementVersion = 1, measurementStats = new { measuredObjects, reusedObjects } };
    }

    private static string Encode(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
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
