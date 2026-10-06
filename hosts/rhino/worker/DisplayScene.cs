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
/** A whole reply frame body sent as it is (a VGT1 display page, T-128): the engine reads it by its magic. */
internal sealed record RawFrame(byte[] Bytes);

/**
 * What one read lists (ARCH-03 §8): only the layers named (exact full paths), and hidden objects or
 * objects on hidden layers when asked. The display Sync lists every visible object on every layer.
 */
internal sealed record ReadScope(HashSet<string>? Layers, bool IncludeHidden)
{
    internal static readonly ReadScope Display = new(null, false);
    internal static ReadScope From(JsonElement request)
    {
        HashSet<string>? layers = null;
        if (request.TryGetProperty("layers", out var list) && list.ValueKind != JsonValueKind.Null)
        {
            if (list.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("INVALID_INPUT");
            layers = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in list.EnumerateArray())
            {
                var path = item.ValueKind == JsonValueKind.String ? item.GetString() : null;
                if (string.IsNullOrEmpty(path) || path.Length > 1000) throw new InvalidOperationException("INVALID_INPUT");
                layers.Add(path);
            }
        }
        var hidden = request.TryGetProperty("includeHidden", out var flag) && flag.ValueKind == JsonValueKind.True;
        return new ReadScope(layers, hidden);
    }
}

/**
 * Document survey of a read: how many objects it lists, how many it leaves out and why (hidden, on a
 * hidden layer, outside the layer filter, inside a block definition), and the layer table with the
 * top-level object count per layer. Serialized as `coverage` and `layers` on every page.
 */
internal sealed class ReadSurvey
{
    internal object Coverage { get; }
    internal object Layers { get; }
    private ReadSurvey(object coverage, object layers) { Coverage = coverage; Layers = layers; }

    internal static ReadSurvey Of(RhinoDoc doc, RhinoObject[] listed, ReadScope scope)
    {
        var ids = listed.Select(obj => obj.Id).ToHashSet();
        // Top-level objects, hidden ones and those on hidden layers included (the enumerator's
        // IdefObjects flag lists nothing here; definition geometry is counted from the definitions).
        var everything = doc.Objects.GetObjectList(new ObjectEnumeratorSettings { HiddenObjects = true, ObjectTypeFilter = ObjectType.AnyObject });
        var blockInternal = doc.InstanceDefinitions.Where(definition => !definition.IsDeleted)
            .SelectMany(definition => definition.GetObjectIds()).Distinct().Count();
        var perLayer = new Dictionary<int, int>();
        var hiddenPerLayer = new Dictionary<int, int>();
        int total = 0, hidden = 0, filtered = 0;
        foreach (var obj in everything)
        {
            if (obj.IsInstanceDefinitionGeometry) continue;
            total++;
            var layerIndex = obj.Attributes.LayerIndex;
            perLayer[layerIndex] = perLayer.GetValueOrDefault(layerIndex) + 1;
            if (ids.Contains(obj.Id)) continue;
            // Not listed: either outside the layer filter, or hidden (the only other reason).
            if (scope.Layers != null && !scope.Layers.Contains(doc.Layers[layerIndex].FullPath)) filtered++;
            else { hidden++; hiddenPerLayer[layerIndex] = hiddenPerLayer.GetValueOrDefault(layerIndex) + 1; }
        }
        var layers = new List<object>();
        var hiddenLayers = new List<object>();
        foreach (var layer in doc.Layers)
        {
            if (layer.IsDeleted) continue;
            layers.Add(new
            {
                id = layer.Id.ToString(), parentId = layer.ParentLayerId == Guid.Empty ? null : layer.ParentLayerId.ToString(),
                fullPath = layer.FullPath, visible = layer.IsVisible, locked = layer.IsLocked, color = Hex(layer.Color),
                order = layer.SortIndex >= 0 ? layer.SortIndex : layer.Index, objectCount = perLayer.GetValueOrDefault(layer.Index),
            });
            if (!layer.IsVisible && hiddenPerLayer.TryGetValue(layer.Index, out var count))
                hiddenLayers.Add(new { path = layer.FullPath, count });
        }
        return new ReadSurvey(new
        {
            total, displayed = listed.Length, omittedHidden = hidden, omittedFiltered = filtered,
            omittedBlockInternal = blockInternal, hiddenLayers,
        }, layers);
    }

    private static string Hex(System.Drawing.Color color) => "#" + color.R.ToString("x2") + color.G.ToString("x2") + color.B.ToString("x2");
}

// Display-only reads of an attached document. Meshes are cached per object until Rhino replaces it; the UI
// thread only snapshots attributes and duplicates uncached geometry, meshing runs in parallel off it.
//
// Wire format (ARCH-01 §5 「호스트 표시 페이지의 바이너리 형상」, T-128): when the engine asks with
// `geometry: "vgt1"` the reply frame is one VGT1 container — "VGT1" | u32 LE header length | header JSON
// ({"status":"success","result":page}) | pad to 4 | buffers — in which every coordinate array of 3+ values
// is {"$bin":[offset, count, "f", ox, oy, oz]} (float32 offsets from its first point) and every index array
// is {"$bin":[offset, count, "u16"|"u32", 0, 0, 0]}: the bytes the engine's ModelStore stores for the same
// item. Without the flag (an older engine) the page is JSON text as before. Both carry the same coordinates
// (meters rounded to 1 µm) and the same geometryHash.
internal sealed class DisplayScene
{
    internal const int MaxPageObjects = 1000;
    // Below the 16 MiB reply cap, so a page never has to be discarded and recomputed.
    private const int PageBytes = 12 * 1024 * 1024;
    private static readonly byte[] EmptyArray = "[]"u8.ToArray();
    private static readonly double[] NoNumbers = [];
    private static readonly int[] NoIndices = [];
    // Block instances carry only their definition and transform; annotations and hatches carry wire
    // segments and text labels. Coordinates are display meters rounded to 1 µm.
    private sealed record Shape(uint Serial, string NativeType, bool Valid, double[] Origin, double[] BoundsSize,
        double[] Vertices, int[] Indices, double[] Line, string Hash, double[]? Segments = null, byte[]? Texts = null,
        Guid? Definition = null, string? DefinitionHash = null, double[]? Transform = null);
    /** Flattened block definition geometry in definition space (meters), shared by its instances. */
    private sealed record Definition(string Hash, double[] Vertices, int[] Indices, double[] Segments, byte[] Texts)
    {
        internal long Size(bool binary) => Bytes(Vertices, binary) + Bytes(Indices, binary) + Bytes(Segments, binary) + Texts.Length + 256;
    }
    private readonly Dictionary<Guid, Definition> definitions = new();
    private sealed class Item
    {
        internal Guid NativeId;
        internal uint Serial;
        internal string Id = "", Name = "", Layer = "", NativeType = "", DisplayColor = "", LayerColor = "";
        internal string? MaterialColor;
        internal List<string[]> Attributes = [];
        internal bool AttributesComplete = true;
        internal Shape? Shape;
        /** Larger than a host reply on its own: sent as its bounding box (ADR-031 7). */
        internal bool Oversized;
        internal GeometryBase? Work;
    }
    private readonly Dictionary<Guid, Shape> shapes = new();

    internal void Forget(Guid id) { lock (shapes) shapes.Remove(id); }
    internal void Clear() { lock (shapes) shapes.Clear(); ClearDefinitions(); }
    /** Any definition edit may change nested content; all definitions are rebuilt on demand. */
    internal void ClearDefinitions() { lock (definitions) definitions.Clear(); }

    internal static RhinoObject[] Visible(RhinoDoc doc) => Listed(doc, ReadScope.Display);

    /** The objects a read lists, in GUID order: visible ones (hidden too when asked), on the named layers only. */
    internal static RhinoObject[] Listed(RhinoDoc doc, ReadScope scope)
    {
        IEnumerable<RhinoObject> objects = scope.IncludeHidden
            ? doc.Objects.GetObjectList(new ObjectEnumeratorSettings { HiddenObjects = true, ObjectTypeFilter = ObjectType.AnyObject })
            : doc.Objects.GetObjectList(ObjectType.AnyObject);
        if (scope.Layers is { } layers)
            objects = objects.Where(obj => layers.Contains(doc.Layers[obj.Attributes.LayerIndex].FullPath));
        // No object count cap (ADR-031 7): reads are paged.
        return objects.OrderBy(obj => obj.Id).ToArray();
    }

    /** Row-major 4x4 in display meters: the linear part is unit-free, the translation is scaled. */
    internal static double[] TransformOf(Transform x, double scale)
    {
        var transform = new double[16];
        for (var row = 0; row < 4; row++)
            for (var column = 0; column < 4; column++)
                transform[row * 4 + column] = x[row, column] * (column == 3 && row < 3 ? scale : 1);
        return transform;
    }

    private static double Scale(RhinoDoc doc)
    {
        var scale = RhinoMath.UnitScale(doc.ModelUnitSystem, UnitSystem.Meters);
        if (!double.IsFinite(scale) || scale <= 0 || doc.ModelUnitSystem is UnitSystem.None or UnitSystem.CustomUnits)
            throw new InvalidOperationException("UNKNOWN_UNITS");
        return scale;
    }

    /**
     * UI thread: page of the listed objects (the display Sync, or a layer-limited read). The returned work runs
     * on a pool thread. `binary`: the reply is a VGT1 frame (see the class comment).
     */
    internal Func<object> Page(RhinoDoc doc, int offset, int limit, int revision, ReadScope scope, bool binary = false)
    {
        var scale = Scale(doc);
        var ordered = Listed(doc, scope);
        if (offset < 0 || offset > ordered.Length || limit < 1 || limit > MaxPageObjects)
            throw new InvalidOperationException("INVALID_PAGE");
        var budget = 262144;
        var items = ordered.Skip(offset).Take(limit).Select(obj => Snapshot(doc, obj, scale, ref budget)).ToList();
        var total = ordered.Length;
        var survey = ReadSurvey.Of(doc, ordered, scope);
        return () =>
        {
            Build(items, scale);
            var count = Fit(items.Select(item => (Item?)item), binary);
            return Write(items.Take(count), [], survey, binary, writer =>
            {
                writer.WriteStartObject("page");
                writer.WriteNumber("offset", offset); writer.WriteNumber("nextOffset", offset + count);
                writer.WriteNumber("total", total); writer.WriteNumber("revision", revision);
                writer.WriteEndObject();
            });
        };
    }

    /** UI thread: objects changed after a revision, in GUID order; absent ones are reported as removed. */
    internal Func<object> Changes(RhinoDoc doc, IReadOnlyDictionary<Guid, int> changedAt, int since, int cursor, int revision, bool binary = false)
    {
        var scale = Scale(doc);
        var listed = Visible(doc);
        var visible = listed.ToDictionary(obj => obj.Id);
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
                entries.Add((id, Snapshot(doc, obj, scale, ref budget)));
            }
            else entries.Add((id, null));
        }
        var total = visible.Count;
        var survey = ReadSurvey.Of(doc, listed, ReadScope.Display);
        return () =>
        {
            Build(entries.Where(entry => entry.Item != null).Select(entry => entry.Item!).ToList(), scale);
            var consumed = Fit(entries.Select(entry => entry.Item), binary);
            var taken = entries.Take(consumed).ToList();
            return Write(taken.Where(entry => entry.Item != null).Select(entry => entry.Item!),
                taken.Where(entry => entry.Item == null).Select(entry => entry.Id), survey, binary, writer =>
                {
                    writer.WriteStartObject("page");
                    writer.WriteNumber("cursor", cursor); writer.WriteNumber("nextCursor", cursor + consumed);
                    writer.WriteNumber("changes", ids.Length); writer.WriteNumber("total", total);
                    writer.WriteNumber("revision", revision);
                    writer.WriteEndObject();
                });
        };
    }

    private Item Snapshot(RhinoDoc doc, RhinoObject obj, double scale, ref int remainingAttributes)
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
        var geometry = obj.Geometry;
        var definition = geometry is InstanceReferenceGeometry reference ? doc.InstanceDefinitions.FindId(reference.ParentIdefId) : null;
        var definitionHash = definition == null || definition.IsDeleted ? null : DefinitionOf(doc, definition, scale).Hash;
        lock (shapes)
            if (shapes.TryGetValue(obj.Id, out var cached) && cached.Serial == item.Serial && cached.DefinitionHash == definitionHash)
                item.Shape = cached;
        if (item.Shape != null) return item;
        // Instances, annotations and hatches are cheap to build and need document tables: UI thread.
        if (geometry is InstanceReferenceGeometry instance) item.Shape = Instance(obj, instance, definition, definitionHash, scale);
        else if (geometry is AnnotationBase or Hatch) item.Shape = Annotation(doc, obj, scale);
        else item.Work = geometry.Duplicate();
        if (item.Shape != null) lock (shapes) shapes[obj.Id] = item.Shape;
        return item;
    }

    private Definition DefinitionOf(RhinoDoc doc, InstanceDefinition definition, double scale)
    {
        lock (definitions) if (definitions.TryGetValue(definition.Id, out var cached)) return cached;
        var parts = new DisplayParts(doc, scale);
        parts.AddDefinition(definition, Transform.Identity, 0, [definition.Id]);
        var vertices = Round(parts.Vertices, 1); var indices = parts.Indices.ToArray();
        var segments = Round(parts.Segments, 1); var texts = TextsJson(parts.Texts);
        var result = new Definition(Hash(definition.Id.ToString(), Json(vertices), Json(indices), Json(segments), texts), vertices, indices, segments, texts);
        lock (definitions) definitions[definition.Id] = result;
        return result;
    }

    private static Shape Instance(RhinoObject obj, InstanceReferenceGeometry instance, InstanceDefinition? definition, string? definitionHash, double scale)
    {
        var bounds = instance.GetBoundingBox(true);
        var valid = definitionHash != null && bounds.IsValid && instance.IsValid;
        var transform = TransformOf(instance.Xform, scale);
        var origin = bounds.IsValid ? new[] { bounds.Min.X * scale, bounds.Min.Y * scale, bounds.Min.Z * scale } : new[] { 0.0, 0, 0 };
        var size = bounds.IsValid ? new[] { (bounds.Max.X - bounds.Min.X) * scale, (bounds.Max.Y - bounds.Min.Y) * scale, (bounds.Max.Z - bounds.Min.Z) * scale } : new[] { 0.0, 0, 0 };
        var hash = Hash(definitionHash ?? "missing", Encoding.UTF8.GetBytes(string.Join(",", transform.Select(v => v.ToString("R", System.Globalization.CultureInfo.InvariantCulture)))));
        return new Shape(obj.RuntimeSerialNumber, "InstanceReference", valid, origin, size, NoNumbers, NoIndices, NoNumbers, hash,
            Definition: valid ? definition!.Id : null, DefinitionHash: definitionHash, Transform: valid ? transform : null);
    }

    private static Shape Annotation(RhinoDoc doc, RhinoObject obj, double scale)
    {
        var geometry = obj.Geometry;
        var bounds = geometry.GetBoundingBox(true);
        if (!bounds.IsValid) throw new InvalidOperationException("INVALID_GEOMETRY");
        var parts = new DisplayParts(doc, scale);
        if (geometry.IsValid) parts.Add(geometry, Transform.Identity);
        var vertices = Round(parts.Vertices, 1); var indices = parts.Indices.ToArray();
        var segments = Round(parts.Segments, 1); var texts = TextsJson(parts.Texts);
        var type = geometry.ObjectType.ToString();
        return new Shape(obj.RuntimeSerialNumber, type, geometry.IsValid,
            [bounds.Min.X * scale, bounds.Min.Y * scale, bounds.Min.Z * scale],
            [(bounds.Max.X - bounds.Min.X) * scale, (bounds.Max.Y - bounds.Min.Y) * scale, (bounds.Max.Z - bounds.Min.Z) * scale],
            vertices, indices, NoNumbers, Hash(type, Json(vertices), Json(indices), Json(segments), texts), Segments: segments, Texts: texts);
    }

    private static string Hash(string kind, params byte[][] parts)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(Encoding.UTF8.GetBytes(kind));
        foreach (var part in parts) hash.AppendData(part);
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static byte[] TextsJson(List<DisplayText> texts)
    {
        var buffer = new ArrayBufferWriter<byte>(64 + texts.Count * 96);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            foreach (var text in texts)
            {
                writer.WriteStartObject();
                writer.WriteString("s", text.S);
                Point(writer, "p", [Math.Round(text.P[0], 6), Math.Round(text.P[1], 6), Math.Round(text.P[2], 6)]);
                writer.WriteNumber("h", Math.Round(text.H, 6)); writer.WriteNumber("r", Math.Round(text.R, 6));
                writer.WriteNumber("ax", text.Ax); writer.WriteNumber("ay", text.Ay);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        return buffer.WrittenSpan.ToArray();
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
            var rounded = Round(vertices, scale); var faces = indices.ToArray(); var wire = Round(line, scale);
            // The hash is taken over the JSON number text, as before the binary pages: a Sync read either
            // way gives every object the same geometryHash (review comparison, measurement reuse).
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(Encoding.UTF8.GetBytes(item.NativeType)); hash.AppendData(Json(rounded)); hash.AppendData(Json(faces)); hash.AppendData(Json(wire));
            return new Shape(item.Serial, item.NativeType, valid,
                [bounds.Min.X * scale, bounds.Min.Y * scale, bounds.Min.Z * scale],
                [(bounds.Max.X - bounds.Min.X) * scale, (bounds.Max.Y - bounds.Min.Y) * scale, (bounds.Max.Z - bounds.Min.Z) * scale],
                rounded, faces, wire, Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant());
        }
        finally { geometry.Dispose(); item.Work = null; }
    }

    // Count of leading entries that fit the byte budget; always at least one.
    private int Fit(IEnumerable<Item?> entries, bool binary)
    {
        var bytes = 0L; var count = 0;
        var included = new HashSet<Guid>();
        foreach (var item in entries)
        {
            var size = SizeOf(item, included, binary);
            // One object larger than a whole page (so than a 16 MB reply): its bounding box stands in
            // for it and the row is marked, and the Sync continues (ADR-031 7).
            if (item?.Shape is { } large && size > PageBytes)
            {
                item.Shape = Box(large);
                item.Oversized = true;
                size = SizeOf(item, included, binary);
            }
            var shape = item?.Shape;
            if (count > 0 && bytes + size > PageBytes) break;
            if (shape?.Definition is { } used) included.Add(used);
            bytes += size; count++;
        }
        return count;
    }

    // Upper bounds of an array's reply bytes: float32/uint32 binary, or JSON number text.
    private static long Bytes(double[] values, bool binary) => binary ? values.Length * 4L + 64 : values.Length * 18L + 2;
    private static long Bytes(int[] values, bool binary) => binary ? values.Length * 4L + 64 : values.Length * 11L + 2;

    private long SizeOf(Item? item, HashSet<Guid> included, bool binary)
    {
        var shape = item?.Shape;
        long size = shape == null ? 64 : Bytes(shape.Vertices, binary) + Bytes(shape.Indices, binary) + Bytes(shape.Line, binary)
            + (shape.Segments == null ? 0 : Bytes(shape.Segments, binary)) + (shape.Texts?.Length ?? 0)
            + 2 * (item!.Name.Length + item.Layer.Length) + item.Attributes.Sum(pair => pair[0].Length + pair[1].Length + 8) + 1024;
        // A definition travels once per page with the first instance that needs it.
        if (shape?.Definition is { } id && !included.Contains(id))
            lock (definitions) if (definitions.TryGetValue(id, out var definition)) size += definition.Size(binary);
        return size;
    }

    /** The shape's bounding box as a mesh (display meters), without segments, labels or block. */
    private static Shape Box(Shape shape)
    {
        var o = shape.Origin; var d = shape.BoundsSize;
        var bounds = new BoundingBox(o[0], o[1], o[2], o[0] + d[0], o[1] + d[1], o[2] + d[2]);
        var vertices = new List<double>(); var indices = new List<int>();
        WorkerScene.BoxMesh(bounds, vertices, indices);
        return new Shape(shape.Serial, shape.NativeType, shape.Valid, shape.Origin, shape.BoundsSize, Round(vertices, 1), indices.ToArray(), NoNumbers,
            Hash("oversized", Encoding.UTF8.GetBytes(shape.Hash)));
    }

    /** The binary section of a VGT1 reply: 4-byte aligned buffers the header's $bin entries point into. */
    private sealed class Region
    {
        internal readonly ArrayBufferWriter<byte> Bytes = new(1 << 20);
        internal int Add(ReadOnlySpan<byte> data)
        {
            var at = Bytes.WrittenCount;
            data.CopyTo(Bytes.GetSpan(data.Length)); Bytes.Advance(data.Length);
            var pad = (4 - data.Length % 4) % 4;
            if (pad > 0) { Bytes.GetSpan(pad)[..pad].Clear(); Bytes.Advance(pad); }
            return at;
        }
    }

    /** A coordinate array: binary float32 offsets from its first point, or JSON numbers (also when empty). */
    private static void Positions(Utf8JsonWriter writer, string name, double[] values, Region? region)
    {
        if (region == null || values.Length < 3 || values.Length % 3 != 0) { Numbers(writer, name, values); return; }
        double ox = values[0], oy = values[1], oz = values[2];
        var local = new float[values.Length];
        for (var i = 0; i < values.Length; i += 3)
        {
            local[i] = (float)(values[i] - ox); local[i + 1] = (float)(values[i + 1] - oy); local[i + 2] = (float)(values[i + 2] - oz);
        }
        var at = region.Add(System.Runtime.InteropServices.MemoryMarshal.AsBytes(local.AsSpan()));
        Reference(writer, name, at, values.Length, "f", ox, oy, oz);
    }
    /** An index array: binary uint16 when every index fits, else uint32 (the engine's choice too), or JSON. */
    private static void Indices(Utf8JsonWriter writer, string name, int[] values, Region? region)
    {
        if (region == null || values.Length == 0 || values.Any(value => value < 0)) { Integers(writer, name, values); return; }
        var small = values.Max() < 0x10000;
        int at;
        if (small)
        {
            var array = new ushort[values.Length];
            for (var i = 0; i < values.Length; i++) array[i] = (ushort)values[i];
            at = region.Add(System.Runtime.InteropServices.MemoryMarshal.AsBytes(array.AsSpan()));
        }
        else at = region.Add(System.Runtime.InteropServices.MemoryMarshal.AsBytes(values.AsSpan()));
        Reference(writer, name, at, values.Length, small ? "u16" : "u32", 0, 0, 0);
    }
    private static void Reference(Utf8JsonWriter writer, string name, int offset, int count, string type, double ox, double oy, double oz)
    {
        writer.WriteStartObject(name);
        writer.WriteStartArray("$bin");
        writer.WriteNumberValue(offset); writer.WriteNumberValue(count); writer.WriteStringValue(type);
        writer.WriteNumberValue(ox); writer.WriteNumberValue(oy); writer.WriteNumberValue(oz);
        writer.WriteEndArray();
        writer.WriteEndObject();
    }

    private object Write(IEnumerable<Item> items, IEnumerable<Guid> removed, ReadSurvey survey, bool binary, Action<Utf8JsonWriter> page)
    {
        var list = items.ToList();
        var region = binary ? new Region() : null;
        var buffer = new ArrayBufferWriter<byte>(1 << 20);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            if (binary) { writer.WriteStartObject(); writer.WriteString("status", "success"); writer.WritePropertyName("result"); }
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
                Positions(writer, "vertices", shape.Vertices, region);
                Indices(writer, "indices", shape.Indices, region);
                Positions(writer, "line", shape.Line, region);
                if (shape.Segments != null) Positions(writer, "segments", shape.Segments, region);
                if (shape.Texts != null && shape.Texts.Length > 2) { writer.WritePropertyName("texts"); writer.WriteRawValue(shape.Texts, true); }
                if (shape.Definition is { } definition && shape.Transform != null)
                {
                    writer.WriteStartObject("block");
                    writer.WriteString("definition", definition.ToString());
                    writer.WriteStartArray("transform");
                    foreach (var value in shape.Transform) writer.WriteNumberValue(value);
                    writer.WriteEndArray();
                    writer.WriteEndObject();
                }
                writer.WriteNull("area"); writer.WriteNull("volume"); writer.WriteNull("length");
                writer.WriteString("layer64", Encode(item.Layer));
                writer.WriteStartArray("attributes64");
                foreach (var pair in item.Attributes) { writer.WriteStartArray(); writer.WriteStringValue(pair[0]); writer.WriteStringValue(pair[1]); writer.WriteEndArray(); }
                writer.WriteEndArray();
                writer.WriteBoolean("attributesComplete", item.AttributesComplete); writer.WriteBoolean("valid", shape.Valid);
                writer.WriteString("displayColor", item.DisplayColor); writer.WriteString("layerColor", item.LayerColor);
                if (item.MaterialColor == null) writer.WriteNull("materialColor"); else writer.WriteString("materialColor", item.MaterialColor);
                if (item.Oversized) writer.WriteBoolean("oversized", true);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteStartObject("definitions");
            foreach (var id in list.Select(item => item.Shape!.Definition).OfType<Guid>().Distinct())
            {
                Definition? definition;
                lock (definitions) definitions.TryGetValue(id, out definition);
                if (definition == null) continue;
                writer.WriteStartObject(id.ToString());
                writer.WriteString("hash", definition.Hash);
                Positions(writer, "vertices", definition.Vertices, region);
                Indices(writer, "indices", definition.Indices, region);
                Positions(writer, "segments", definition.Segments, region);
                writer.WritePropertyName("texts"); writer.WriteRawValue(definition.Texts, true);
                writer.WriteEndObject();
            }
            writer.WriteEndObject();
            writer.WriteStartArray("removed");
            foreach (var id in removed) writer.WriteStringValue(id.ToString());
            writer.WriteEndArray();
            writer.WriteNumber("measurementVersion", 1);
            writer.WriteStartObject("measurementStats"); writer.WriteNumber("measuredObjects", 0); writer.WriteNumber("reusedObjects", 0); writer.WriteEndObject();
            writer.WritePropertyName("coverage"); writer.WriteRawValue(JsonSerializer.SerializeToUtf8Bytes(survey.Coverage), true);
            writer.WritePropertyName("layers"); writer.WriteRawValue(JsonSerializer.SerializeToUtf8Bytes(survey.Layers), true);
            page(writer);
            writer.WriteEndObject();
            if (binary) writer.WriteEndObject();
        }
        if (region == null) return new RawJson(buffer.WrittenSpan.ToArray());
        // "VGT1" | u32 LE header length | header JSON | pad to 4 | buffers.
        var header = buffer.WrittenSpan;
        var start = (8 + header.Length + 3) & ~3;
        var frame = new byte[start + region.Bytes.WrittenCount];
        "VGT1"u8.CopyTo(frame);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(4), (uint)header.Length);
        header.CopyTo(frame.AsSpan(8));
        region.Bytes.WrittenSpan.CopyTo(frame.AsSpan(start));
        return new RawFrame(frame);
    }

    private static void Point(Utf8JsonWriter writer, string name, double[] values)
    {
        writer.WriteStartArray(name);
        foreach (var value in values) writer.WriteNumberValue(value);
        writer.WriteEndArray();
    }
    // Display coordinates in meters, rounded to 1 µm: far below display precision, ~40% fewer JSON bytes.
    private static double[] Round(List<double> values, double scale)
    {
        var rounded = new double[values.Count];
        for (var i = 0; i < rounded.Length; i++)
        {
            var scaled = Math.Round(values[i] * scale, 6);
            if (!double.IsFinite(scaled)) throw new InvalidOperationException("INVALID_GEOMETRY");
            rounded[i] = scaled;
        }
        return rounded;
    }
    private static void Numbers(Utf8JsonWriter writer, string name, double[] values)
    {
        writer.WriteStartArray(name);
        foreach (var value in values) writer.WriteNumberValue(value);
        writer.WriteEndArray();
    }
    private static void Integers(Utf8JsonWriter writer, string name, int[] values)
    {
        writer.WriteStartArray(name);
        foreach (var value in values) writer.WriteNumberValue(value);
        writer.WriteEndArray();
    }
    /** The JSON array text of the values (what geometryHash is taken over). */
    private static byte[] Json(double[] values)
    {
        var buffer = new ArrayBufferWriter<byte>(values.Length * 12 + 2);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            foreach (var value in values) writer.WriteNumberValue(value);
            writer.WriteEndArray();
        }
        return buffer.WrittenSpan.ToArray();
    }
    private static byte[] Json(int[] values)
    {
        var buffer = new ArrayBufferWriter<byte>(values.Length * 6 + 2);
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
