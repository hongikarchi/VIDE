using System.Buffers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace Vide.Worker;

/** Pre-serialized JSON sent as the reply result without re-serialization. */
internal sealed record RawJson(byte[] Bytes);

// Display-only reads of an attached document. Meshes are cached per object until Rhino replaces it; the UI
// thread only snapshots attributes and duplicates uncached geometry, meshing runs in parallel off it.
internal sealed class DisplayScene
{
    internal const int MaxPageObjects = 1000;
    // Below the 16 MiB reply cap, so a page never has to be discarded and recomputed.
    private const int PageBytes = 12 * 1024 * 1024;
    private sealed record Shape(uint Serial, string NativeType, bool Valid, double[] Origin, double[] BoundsSize,
        byte[] Vertices, byte[] Indices, byte[] Line, string Hash);
    private sealed class Item
    {
        internal Guid NativeId;
        internal uint Serial;
        internal string Id = "", Name = "", Layer = "", NativeType = "", DisplayColor = "", LayerColor = "";
        internal string? MaterialColor;
        internal List<string[]> Attributes = [];
        internal bool AttributesComplete = true;
        internal Shape? Shape;
        internal GeometryBase? Work;
    }
    private readonly Dictionary<Guid, Shape> shapes = new();

    internal void Forget(Guid id) { lock (shapes) shapes.Remove(id); }
    internal void Clear() { lock (shapes) shapes.Clear(); }

    internal static RhinoObject[] Visible(RhinoDoc doc)
    {
        var ordered = doc.Objects.GetObjectList(ObjectType.AnyObject).OrderBy(obj => obj.Id).ToArray();
        if (ordered.Length > WorkerScene.MaxObjects) throw new InvalidOperationException("IMPORT_LIMIT");
        return ordered;
    }

    private static double Scale(RhinoDoc doc)
    {
        var scale = RhinoMath.UnitScale(doc.ModelUnitSystem, UnitSystem.Meters);
        if (!double.IsFinite(scale) || scale <= 0 || doc.ModelUnitSystem is UnitSystem.None or UnitSystem.CustomUnits)
            throw new InvalidOperationException("UNKNOWN_UNITS");
        return scale;
    }

    /** UI thread: page of the full visible list. The returned work runs on a pool thread. */
    internal Func<object> Page(RhinoDoc doc, int offset, int limit, int revision)
    {
        var scale = Scale(doc);
        var ordered = Visible(doc);
        if (offset < 0 || offset > ordered.Length || limit < 1 || limit > MaxPageObjects)
            throw new InvalidOperationException("INVALID_PAGE");
        var budget = 262144;
        var items = ordered.Skip(offset).Take(limit).Select(obj => Snapshot(doc, obj, ref budget)).ToList();
        var total = ordered.Length;
        return () =>
        {
            Build(items, scale);
            var count = Fit(items.Select(item => (Item?)item));
            return new RawJson(Write(items.Take(count), [], writer =>
            {
                writer.WriteStartObject("page");
                writer.WriteNumber("offset", offset); writer.WriteNumber("nextOffset", offset + count);
                writer.WriteNumber("total", total); writer.WriteNumber("revision", revision);
                writer.WriteEndObject();
            }));
        };
    }

    /** UI thread: objects changed after a revision, in GUID order; absent ones are reported as removed. */
    internal Func<object> Changes(RhinoDoc doc, IReadOnlyDictionary<Guid, int> changedAt, int since, int cursor, int revision)
    {
        var scale = Scale(doc);
        var visible = Visible(doc).ToDictionary(obj => obj.Id);
        var ids = changedAt.Where(entry => entry.Value > since).Select(entry => entry.Key).OrderBy(id => id).ToArray();
        if (cursor < 0 || cursor > ids.Length) throw new InvalidOperationException("INVALID_PAGE");
        var budget = 262144;
        var entries = new List<(Guid Id, Item? Item)>();
        var upserts = 0;
        foreach (var id in ids.Skip(cursor))
        {
            if (visible.TryGetValue(id, out var obj))
            {
                if (upserts == MaxPageObjects) break;
                upserts++;
                entries.Add((id, Snapshot(doc, obj, ref budget)));
            }
            else entries.Add((id, null));
        }
        var total = visible.Count;
        return () =>
        {
            Build(entries.Where(entry => entry.Item != null).Select(entry => entry.Item!).ToList(), scale);
            var consumed = Fit(entries.Select(entry => entry.Item));
            var taken = entries.Take(consumed).ToList();
            return new RawJson(Write(taken.Where(entry => entry.Item != null).Select(entry => entry.Item!),
                taken.Where(entry => entry.Item == null).Select(entry => entry.Id), writer =>
                {
                    writer.WriteStartObject("page");
                    writer.WriteNumber("cursor", cursor); writer.WriteNumber("nextCursor", cursor + consumed);
                    writer.WriteNumber("changes", ids.Length); writer.WriteNumber("total", total);
                    writer.WriteNumber("revision", revision);
                    writer.WriteEndObject();
                }));
        };
    }

    private Item Snapshot(RhinoDoc doc, RhinoObject obj, ref int remainingAttributes)
    {
        var layer = doc.Layers[obj.Attributes.LayerIndex];
        var item = new Item
        {
            NativeId = obj.Id, Serial = obj.RuntimeSerialNumber, Id = WorkerScene.Id(obj), Name = obj.Name ?? "Object",
            Layer = layer.FullPath, NativeType = obj.Geometry.ObjectType.ToString(),
            DisplayColor = Hex(obj.Attributes.DrawColor(doc)), LayerColor = Hex(layer.Color), MaterialColor = MaterialColor(obj),
        };
        var bytes = 0;
        var strings = obj.Attributes.GetUserStrings();
        foreach (var key in strings.AllKeys)
        {
            if (key == null) continue;
            var value = strings[key] ?? ""; var size = Encoding.UTF8.GetByteCount(key) + Encoding.UTF8.GetByteCount(value);
            if (item.Attributes.Count >= 32 || bytes + size > 4096 || remainingAttributes < size || key.Length > 200 || value.Length > 4000) { item.AttributesComplete = false; continue; }
            item.Attributes.Add([Encode(key), Encode(value)]); bytes += size; remainingAttributes -= size;
        }
        lock (shapes)
            if (shapes.TryGetValue(obj.Id, out var cached) && cached.Serial == item.Serial) item.Shape = cached;
        if (item.Shape == null) item.Work = obj.Geometry.Duplicate();
        return item;
    }

    private void Build(List<Item> items, double scale)
    {
        var work = items.Where(item => item.Shape == null).ToList();
        if (work.Count == 0) return;
        try
        {
            Parallel.ForEach(work, new ParallelOptions { MaxDegreeOfParallelism = Math.Max(1, System.Environment.ProcessorCount - 1) }, item =>
            {
                var shape = Mesh(item, scale);
                item.Shape = shape;
                lock (shapes) shapes[item.NativeId] = shape;
            });
        }
        catch (AggregateException error) when (error.InnerExceptions.OfType<InvalidOperationException>().FirstOrDefault() is { } first)
        {
            throw first;
        }
        finally { foreach (var item in work) { item.Work?.Dispose(); item.Work = null; } }
    }

    // Same tessellation as WorkerScene.Export's display path, on a private duplicate.
    private static Shape Mesh(Item item, double scale)
    {
        var geometry = item.Work!;
        try
        {
            var valid = geometry.IsValid;
            var bounds = geometry.GetBoundingBox(true);
            if (!bounds.IsValid) throw new InvalidOperationException("INVALID_GEOMETRY");
            var vertices = new List<double>(); var indices = new List<int>(); var line = new List<double>();
            using var converted = geometry is Extrusion extrusion ? extrusion.ToBrep() : null;
            var brep = geometry as Brep ?? converted;
            if (brep != null && valid)
            {
                var center = bounds.Center;
                brep.Transform(Transform.Translation(-center.X, -center.Y, -center.Z));
                foreach (var mesh in Rhino.Geometry.Mesh.CreateFromBrep(brep, MeshingParameters.FastRenderMesh) ?? [])
                { AddMesh(mesh, center, vertices, indices); mesh.Dispose(); }
            }
            else if (geometry is Mesh nativeMesh && valid) AddMesh(nativeMesh, Point3d.Origin, vertices, indices);
            if (geometry is Curve curve && valid)
            {
                if (curve.TryGetPolyline(out var polyline)) foreach (var point in polyline) AddPoint(point, line);
                else foreach (var parameter in curve.DivideByCount(128, true) ?? []) AddPoint(curve.PointAt(parameter), line);
            }
            var vertexJson = Numbers(vertices, scale); var indexJson = Integers(indices); var lineJson = Numbers(line, scale);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(Encoding.UTF8.GetBytes(item.NativeType)); hash.AppendData(vertexJson); hash.AppendData(indexJson); hash.AppendData(lineJson);
            return new Shape(item.Serial, item.NativeType, valid,
                [bounds.Min.X * scale, bounds.Min.Y * scale, bounds.Min.Z * scale],
                [(bounds.Max.X - bounds.Min.X) * scale, (bounds.Max.Y - bounds.Min.Y) * scale, (bounds.Max.Z - bounds.Min.Z) * scale],
                vertexJson, indexJson, lineJson, Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant());
        }
        finally { geometry.Dispose(); item.Work = null; }
    }

    // Count of leading entries that fit the byte budget; always at least one.
    private static int Fit(IEnumerable<Item?> entries)
    {
        var bytes = 0L; var count = 0;
        foreach (var item in entries)
        {
            var size = item?.Shape == null ? 64 : item.Shape.Vertices.Length + item.Shape.Indices.Length + item.Shape.Line.Length
                + 2 * (item.Name.Length + item.Layer.Length) + item.Attributes.Sum(pair => pair[0].Length + pair[1].Length + 8) + 1024;
            if (count > 0 && bytes + size > PageBytes) break;
            bytes += size; count++;
        }
        return count;
    }

    private static byte[] Write(IEnumerable<Item> items, IEnumerable<Guid> removed, Action<Utf8JsonWriter> page)
    {
        var list = items.ToList();
        var buffer = new ArrayBufferWriter<byte>(1 << 20);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteStartArray("objects");
            foreach (var item in list)
            {
                writer.WriteStartObject();
                writer.WriteString("id", item.Id); writer.WriteString("nativeId", item.NativeId.ToString());
                writer.WriteString("kind", "native"); writer.WriteString("name", item.Name);
                Point(writer, "origin", item.Shape!.Origin);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteStartArray("scene");
            foreach (var item in list)
            {
                var shape = item.Shape!;
                writer.WriteStartObject();
                writer.WriteString("id", item.Id); writer.WriteString("nativeId", item.NativeId.ToString());
                writer.WriteString("nativeType", shape.NativeType); writer.WriteString("geometryHash", shape.Hash);
                writer.WriteString("name64", Encode(item.Name));
                Point(writer, "origin", shape.Origin); Point(writer, "boundsSize", shape.BoundsSize);
                writer.WritePropertyName("vertices"); writer.WriteRawValue(shape.Vertices, true);
                writer.WritePropertyName("indices"); writer.WriteRawValue(shape.Indices, true);
                writer.WritePropertyName("line"); writer.WriteRawValue(shape.Line, true);
                writer.WriteNull("area"); writer.WriteNull("volume"); writer.WriteNull("length");
                writer.WriteString("layer64", Encode(item.Layer));
                writer.WriteStartArray("attributes64");
                foreach (var pair in item.Attributes) { writer.WriteStartArray(); writer.WriteStringValue(pair[0]); writer.WriteStringValue(pair[1]); writer.WriteEndArray(); }
                writer.WriteEndArray();
                writer.WriteBoolean("attributesComplete", item.AttributesComplete); writer.WriteBoolean("valid", shape.Valid);
                writer.WriteString("displayColor", item.DisplayColor); writer.WriteString("layerColor", item.LayerColor);
                if (item.MaterialColor == null) writer.WriteNull("materialColor"); else writer.WriteString("materialColor", item.MaterialColor);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteStartArray("removed");
            foreach (var id in removed) writer.WriteStringValue(id.ToString());
            writer.WriteEndArray();
            writer.WriteNumber("measurementVersion", 1);
            writer.WriteStartObject("measurementStats"); writer.WriteNumber("measuredObjects", 0); writer.WriteNumber("reusedObjects", 0); writer.WriteEndObject();
            page(writer);
            writer.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }

    private static void Point(Utf8JsonWriter writer, string name, double[] values)
    {
        writer.WriteStartArray(name);
        foreach (var value in values) writer.WriteNumberValue(value);
        writer.WriteEndArray();
    }
    // Display coordinates in meters, rounded to 1 µm: far below display precision, ~40% fewer bytes.
    private static byte[] Numbers(List<double> values, double scale)
    {
        var buffer = new ArrayBufferWriter<byte>(values.Count * 12 + 2);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            foreach (var value in values)
            {
                var scaled = Math.Round(value * scale, 6);
                if (!double.IsFinite(scaled)) throw new InvalidOperationException("INVALID_GEOMETRY");
                writer.WriteNumberValue(scaled);
            }
            writer.WriteEndArray();
        }
        return buffer.WrittenSpan.ToArray();
    }
    private static byte[] Integers(List<int> values)
    {
        var buffer = new ArrayBufferWriter<byte>(values.Count * 6 + 2);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            foreach (var value in values) writer.WriteNumberValue(value);
            writer.WriteEndArray();
        }
        return buffer.WrittenSpan.ToArray();
    }
    private static string Encode(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
    private static string Hex(System.Drawing.Color color) => "#" + color.R.ToString("x2") + color.G.ToString("x2") + color.B.ToString("x2");
    private static string? MaterialColor(RhinoObject obj)
    {
        try { var material = obj.GetMaterial(true); return material == null ? null : Hex(material.DiffuseColor); }
        catch (Exception) { return null; }
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
