using System.Reflection;
using System.Text.Json;
using Rhino;
using Rhino.Display;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace Vide.Worker;

// The AI's eyes (PLAN-24): a PNG of the model view and measurements of named objects. Fixed methods,
// never agent code. Camera and layer changes made for a capture are undone before it returns; an
// attached (user) document never has its layers changed.
internal static class ViewTools
{
    internal const int MaxSize = 1600;
    internal const int MaxImageBytes = 1_000_000;
    internal const int MaxMeasureIds = 50;
    internal const int MaxDistances = 20;

    // A read never leaves an uncertain host result: other failures become fixed codes.
    internal static object Capture(RhinoDoc document, JsonElement request, bool mayChangeLayers) =>
        Guarded(() => CaptureView(document, request, mayChangeLayers), "CAPTURE_FAILED");
    internal static object Measure(RhinoDoc document, JsonElement request) =>
        Guarded(() => MeasureObjects(document, request), "MEASURE_FAILED");
    private static object Guarded(Func<object> read, string code)
    {
        try { return read(); }
        catch (InvalidOperationException) { throw; }
        catch (Exception error) when (error is KeyNotFoundException or FormatException or JsonException) { throw new InvalidOperationException("INVALID_INPUT"); }
        catch (Exception) { throw new InvalidOperationException(code); }
    }

    private static object CaptureView(RhinoDoc document, JsonElement request, bool mayChangeLayers)
    {
        int Size(string key, int fallback) =>
            request.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number
                ? Math.Clamp(value.GetInt32(), 64, MaxSize) : fallback;
        var width = Size("width", 1200);
        var height = Size("height", 800);
        var view = document.Views.ActiveView ?? document.Views.FirstOrDefault(candidate => candidate is not RhinoPageView)
            ?? throw new InvalidOperationException("NO_VIEW");
        var viewport = view.ActiveViewport;
        var named = request.TryGetProperty("namedView", out var namedValue) && namedValue.ValueKind == JsonValueKind.String ? namedValue.GetString() : null;
        var fitIds = Strings(request, "fitIds", MaxMeasureIds);
        var show = Strings(request, "showLayers", 200);
        var hide = Strings(request, "hideLayers", 200);
        if (!mayChangeLayers && (show.Length > 0 || hide.Length > 0)) throw new InvalidOperationException("LAYER_OPTION_UNAVAILABLE");
        var restoreLayers = new List<(int index, bool visible)>();
        viewport.PushViewProjection();
        try
        {
            if (named != null)
            {
                var index = document.NamedViews.FindByName(named);
                if (index < 0) throw new InvalidOperationException("NOT_FOUND");
                if (!document.NamedViews.Restore(index, viewport)) throw new InvalidOperationException("CAPTURE_FAILED");
            }
            if (fitIds.Length > 0)
            {
                var box = BoundingBox.Empty;
                foreach (var obj in Find(document, fitIds)) box.Union(obj.Geometry.GetBoundingBox(true));
                if (!box.IsValid) throw new InvalidOperationException("NOT_FOUND");
                box.Inflate(Math.Max(box.Diagonal.Length * 0.05, document.ModelAbsoluteTolerance));
                viewport.ZoomBoundingBox(box);
            }
            foreach (var (paths, visible) in new[] { (show, true), (hide, false) })
                foreach (var path in paths)
                {
                    var index = document.Layers.FindByFullPath(path, -1);
                    if (index < 0) throw new InvalidOperationException("NOT_FOUND");
                    var layer = document.Layers[index];
                    if (layer.IsVisible == visible) continue;
                    restoreLayers.Add((index, layer.IsVisible));
                    layer.IsVisible = visible;
                }
            byte[] png = [];
            for (var attempt = 0; attempt < 5; attempt++)
            {
                png = Png(view, width, height);
                if (png.Length <= MaxImageBytes) break;
                width = Math.Max(64, width * 3 / 4);
                height = Math.Max(64, height * 3 / 4);
            }
            if (png.Length > MaxImageBytes) throw new InvalidOperationException("QUERY_RESULT_TOO_LARGE");
            var camera = view.ActiveViewport;
            double[] P(Point3d p) => [p.X, p.Y, p.Z];
            return new
            {
                ok = true, mimeType = "image/png", width, height, data = Convert.ToBase64String(png),
                view = camera.Name, units = document.ModelUnitSystem.ToString(),
                camera = new { location = P(camera.CameraLocation), target = P(camera.CameraTarget), parallel = camera.IsParallelProjection },
            };
        }
        finally
        {
            foreach (var (index, visible) in restoreLayers) document.Layers[index].IsVisible = visible;
            viewport.PopViewProjection();
            view.Redraw();
        }
    }

    // System.Drawing.Common is not referenced at build time (RhinoCommon brings it at run time).
    private static byte[] Png(RhinoView view, int width, int height)
    {
        // The view's own capture (grid and axes off): ViewCapture.CaptureToBitmap(settings) returned a
        // blank white image in a Rhino whose window is hidden (VERIFY-2026-09-30-direct-apply-rhino).
        var capture = typeof(RhinoView).GetMethod("CaptureToBitmap", BindingFlags.Public | BindingFlags.Instance,
            [typeof(System.Drawing.Size), typeof(bool), typeof(bool), typeof(bool)])
            ?? throw new InvalidOperationException("CAPTURE_FAILED");
        var bitmap = capture.Invoke(view, [new System.Drawing.Size(width, height), false, false, false]) ?? throw new InvalidOperationException("CAPTURE_FAILED");
        try
        {
            var type = bitmap.GetType();
            var format = type.Assembly.GetType("System.Drawing.Imaging.ImageFormat")?.GetProperty("Png")?.GetValue(null)
                ?? throw new InvalidOperationException("CAPTURE_FAILED");
            using var stream = new MemoryStream();
            (type.GetMethod("Save", [typeof(Stream), format.GetType()]) ?? throw new InvalidOperationException("CAPTURE_FAILED"))
                .Invoke(bitmap, [stream, format]);
            return stream.ToArray();
        }
        finally { (bitmap as IDisposable)?.Dispose(); }
    }

    private static object MeasureObjects(RhinoDoc document, JsonElement request)
    {
        var ids = Strings(request, "ids", MaxMeasureIds);
        var tolerance = document.ModelAbsoluteTolerance;
        var objects = Lookup(document, ids);
        var rows = ids.Select(id =>
        {
            var geometry = objects[id].Geometry;
            var box = geometry.GetBoundingBox(true);
            var curve = geometry as Curve;
            var brep = AsBrep(geometry);
            var mesh = geometry as Mesh;
            double? area = null, volume = null;
            try
            {
                if (brep != null) { area = AreaMassProperties.Compute(brep)?.Area; if (brep.IsSolid) volume = VolumeMassProperties.Compute(brep)?.Volume; }
                else if (mesh != null) { area = AreaMassProperties.Compute(mesh)?.Area; if (mesh.IsClosed) volume = VolumeMassProperties.Compute(mesh)?.Volume; }
                else if (curve != null && curve.IsClosed && curve.IsPlanar(tolerance)) area = AreaMassProperties.Compute(curve)?.Area;
            }
            catch { /* An unmeasurable shape keeps null values. */ }
            return new
            {
                id, type = objects[id].ObjectType.ToString(),
                bounds = new[] { new[] { box.Min.X, box.Min.Y, box.Min.Z }, new[] { box.Max.X, box.Max.Y, box.Max.Z } },
                size = new[] { box.Max.X - box.Min.X, box.Max.Y - box.Min.Y, box.Max.Z - box.Min.Z },
                length = curve?.GetLength(), area, volume,
            };
        }).ToArray();
        var distances = new List<object>();
        if (request.TryGetProperty("distances", out var pairs) && pairs.ValueKind == JsonValueKind.Array)
        {
            if (pairs.GetArrayLength() > MaxDistances) throw new InvalidOperationException("INVALID_INPUT");
            foreach (var pair in pairs.EnumerateArray())
            {
                var a = End(document, pair.GetProperty("a"));
                var b = End(document, pair.GetProperty("b"));
                var (distance, pa, pb, method) = Closest(a, b, tolerance);
                distances.Add(new { distance, from = new[] { pa.X, pa.Y, pa.Z }, to = new[] { pb.X, pb.Y, pb.Z }, dx = pb.X - pa.X, dy = pb.Y - pa.Y, dz = pb.Z - pa.Z, method });
            }
        }
        return new { ok = true, units = document.ModelUnitSystem.ToString(), objects = rows, distances };
    }

    private static string[] Strings(JsonElement request, string key, int max)
    {
        if (!request.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.Array) return [];
        if (value.GetArrayLength() > max) throw new InvalidOperationException("INVALID_INPUT");
        return value.EnumerateArray().Select(item => item.GetString() ?? throw new InvalidOperationException("INVALID_INPUT")).Distinct().ToArray();
    }
    /** Objects by VIDE id (or native id); every id must exist. */
    private static Dictionary<string, RhinoObject> Lookup(RhinoDoc document, string[] ids)
    {
        var wanted = ids.ToHashSet();
        var found = new Dictionary<string, RhinoObject>();
        foreach (var obj in document.Objects.GetObjectList(ObjectType.AnyObject))
            foreach (var key in new[] { WorkerScene.Id(obj), obj.Id.ToString() })
                if (wanted.Contains(key)) found.TryAdd(key, obj);
        if (found.Count != wanted.Count) throw new InvalidOperationException("NOT_FOUND");
        return found;
    }
    private static IEnumerable<RhinoObject> Find(RhinoDoc document, string[] ids) => Lookup(document, ids).Values.Distinct();
    private static Brep? AsBrep(GeometryBase geometry) => geometry switch
    {
        Brep brep => brep,
        Extrusion extrusion => extrusion.ToBrep(),
        Surface surface => surface.ToBrep(),
        _ => null,
    };
    /** One end of a distance: an object id or a point [x, y, z]. */
    private static GeometryBase End(RhinoDoc document, JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String) return Find(document, [value.GetString()!]).First().Geometry;
        if (value.ValueKind == JsonValueKind.Array && value.GetArrayLength() == 3)
        {
            var p = value.EnumerateArray().Select(n => n.GetDouble()).ToArray();
            if (p.All(double.IsFinite)) return new Rhino.Geometry.Point(new Point3d(p[0], p[1], p[2]));
        }
        throw new InvalidOperationException("INVALID_INPUT");
    }
    private static Point3d? PointOf(GeometryBase geometry) => geometry is Rhino.Geometry.Point point ? point.Location : null;
    /**
     * Closest distance: exact for points, curves and surfaces against points; curve pairs and
     * curve–surface pairs by RhinoCommon; solid pairs from their edges (exact for planar faces).
     */
    private static (double, Point3d, Point3d, string) Closest(GeometryBase a, GeometryBase b, double tolerance)
    {
        (double, Point3d, Point3d, string) Result(Point3d p, Point3d q, string method) => (p.DistanceTo(q), p, q, method);
        Point3d OnGeometry(GeometryBase geometry, Point3d p)
        {
            if (PointOf(geometry) is Point3d own) return own;
            if (geometry is Curve curve && curve.ClosestPoint(p, out var t)) return curve.PointAt(t);
            if (geometry is Mesh mesh) return mesh.ClosestPoint(p);
            if (AsBrep(geometry) is Brep brep) return brep.ClosestPoint(p);
            return geometry.GetBoundingBox(true).ClosestPoint(p);
        }
        if (PointOf(a) is Point3d pa) return Result(pa, OnGeometry(b, pa), "exact");
        if (PointOf(b) is Point3d pb) { var (d, p, q, m) = Closest(b, a, tolerance); return (d, q, p, m); }
        if (a is Curve ca && b is Curve cb && ca.ClosestPoints(cb, out var p1, out var p2)) return Result(p1, p2, "exact");
        if (a is Curve curveA && AsBrep(b) is Brep brepB && curveA.ClosestPoints([brepB], out var q1, out var q2, out _)) return Result(q1, q2, "exact");
        if (b is Curve && AsBrep(a) is Brep) { var (d, p, q, m) = Closest(b, a, tolerance); return (d, q, p, m); }
        var brepA = AsBrep(a);
        var brepOther = AsBrep(b);
        if (brepA != null && brepOther != null)
        {
            if (Rhino.Geometry.Intersect.Intersection.BrepBrep(brepA, brepOther, tolerance, out var curves, out var points) &&
                (curves.Length > 0 || points.Length > 0))
            {
                var touch = curves.Length > 0 ? curves[0].PointAtStart : points[0];
                return (0, touch, touch, "intersecting");
            }
            var best = (double.MaxValue, Point3d.Origin, Point3d.Origin, "edges");
            foreach (var (from, to, swap) in new[] { (brepA, brepOther, false), (brepOther, brepA, true) })
                foreach (var edge in from.Edges)
                    if (edge.ClosestPoints([to], out var e1, out var e2, out _) && e1.DistanceTo(e2) < best.Item1)
                        best = swap ? (e1.DistanceTo(e2), e2, e1, "edges") : (e1.DistanceTo(e2), e1, e2, "edges");
            if (best.Item1 < double.MaxValue) return best;
        }
        // Meshes and other shapes: vertices against the other shape (approximate).
        var bestPair = (double.MaxValue, Point3d.Origin, Point3d.Origin, "vertices");
        foreach (var (from, to, swap) in new[] { (a, b, false), (b, a, true) })
            foreach (var vertex in Vertices(from))
            {
                var on = OnGeometry(to, vertex);
                var d = vertex.DistanceTo(on);
                if (d < bestPair.Item1) bestPair = swap ? (d, on, vertex, "vertices") : (d, vertex, on, "vertices");
            }
        if (bestPair.Item1 < double.MaxValue) return bestPair;
        var boxA = a.GetBoundingBox(true);
        var boxB = b.GetBoundingBox(true);
        return Result(boxA.Center, boxB.Center, "centers");
    }
    private static IEnumerable<Point3d> Vertices(GeometryBase geometry) => geometry switch
    {
        Mesh mesh => mesh.Vertices.Take(20000).Select(v => new Point3d(v)),
        Curve curve => curve.DivideByCount(64, true)?.Select(curve.PointAt) ?? [],
        _ => AsBrep(geometry)?.Vertices.Select(v => v.Location) ?? [],
    };
}
