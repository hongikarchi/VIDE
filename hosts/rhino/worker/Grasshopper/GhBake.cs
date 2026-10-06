using System.Text;
using System.Text.Json;
using Grasshopper.Kernel;
using Grasshopper.Kernel.Types;
using Rhino;
using Rhino.DocObjects;

namespace Vide.Worker.Gh;

/// <summary>
/// gh_bake (ADR-033 5): the data of chosen Grasshopper outputs becomes Rhino objects in the attached
/// document. It runs as a `direct-execute` body (language `gh-bake`), so it is one Rhino undo record
/// with the same change report, guards and [되돌리기] as any execute, and Live Sync shows it. Each
/// baked object carries the user string `vide-gh-source` = "&lt;document&gt;:&lt;object&gt;:&lt;output&gt;".
/// </summary>
internal static class GhBake
{
    internal const string SourceKey = "vide-gh-source";

    internal static object? Run(RhinoDoc rhino, string spec, StringBuilder output)
    {
        using var json = JsonDocument.Parse(spec);
        var request = json.RootElement;
        var document = GhTools.Document(request);
        var layerPath = (Json.Str(request, "layer") ?? "Grasshopper").Trim();
        if (layerPath.Length == 0) layerPath = "Grasshopper";
        var layer = Layer(rhino, layerPath);
        int baked = 0, skipped = 0;
        var rows = new List<object>();
        foreach (var (param, label) in GhTools.ParamsOf(document, request))
        {
            var owner = param.Attributes?.GetTopLevel?.DocObject ?? param;
            var source = $"{document.DocumentID}:{owner.InstanceGuid}:{param.NickName}";
            int count = 0, missed = 0;
            foreach (var goo in param.VolatileData.AllData(true))
            {
                var attributes = new ObjectAttributes { LayerIndex = layer };
                attributes.SetUserString(SourceKey, source);
                if (Bake(rhino, goo, attributes)) count++; else missed++;
            }
            baked += count; skipped += missed;
            output.AppendLine($"{label}: {count} baked" + (missed > 0 ? $", {missed} not geometry" : ""));
            rows.Add(new { source = GhTools.Ref(param), baked = count, skipped = missed });
        }
        return new { baked, skipped, layer = layerPath, outputs = rows };
    }

    private static bool Bake(RhinoDoc rhino, IGH_Goo? goo, ObjectAttributes attributes)
    {
        if (goo == null) return false;
        if (goo is IGH_BakeAwareData aware && aware.BakeGeometry(rhino, attributes, out var id) && id != Guid.Empty) return true;
        var id2 = goo.ScriptVariable() switch
        {
            Rhino.Geometry.GeometryBase geometry => rhino.Objects.Add(geometry, attributes),
            Rhino.Geometry.Point3d point => rhino.Objects.AddPoint(point, attributes),
            Rhino.Geometry.Line line => rhino.Objects.AddLine(line, attributes),
            Rhino.Geometry.Circle circle => rhino.Objects.AddCircle(circle, attributes),
            Rhino.Geometry.Arc arc => rhino.Objects.AddArc(arc, attributes),
            Rhino.Geometry.Polyline polyline => rhino.Objects.AddPolyline(polyline, attributes),
            Rhino.Geometry.Rectangle3d rectangle => rhino.Objects.AddCurve(rectangle.ToNurbsCurve(), attributes),
            Rhino.Geometry.Box box => rhino.Objects.AddBrep(box.ToBrep(), attributes),
            _ => Guid.Empty,
        };
        return id2 != Guid.Empty;
    }

    /// <summary>The layer by full path ("A::B"), made (inside the execute's undo record) when missing.</summary>
    private static int Layer(RhinoDoc rhino, string path)
    {
        var found = rhino.Layers.FindByFullPath(path, -1);
        if (found >= 0) return found;
        var parent = Guid.Empty;
        var current = "";
        foreach (var name in path.Split("::", StringSplitOptions.RemoveEmptyEntries))
        {
            current = current.Length == 0 ? name : current + "::" + name;
            var index = rhino.Layers.FindByFullPath(current, -1);
            if (index < 0)
            {
                index = rhino.Layers.Add(new Layer { Name = name, ParentLayerId = parent });
                if (index < 0) throw new InvalidOperationException("GH_BAKE_LAYER");
            }
            parent = rhino.Layers[index].Id;
            found = index;
        }
        return found;
    }
}
