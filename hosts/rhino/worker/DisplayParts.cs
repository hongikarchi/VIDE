using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace Vide.Worker;

/** Display-only text label: world point, height and XY rotation in display meters (CAD `texts` format). */
internal sealed record DisplayText(string S, double[] P, double H, double R, int Ax, int Ay);

// Collects display parts (surface mesh, wire segments, text labels) of annotations, hatches and block
// definitions. Coordinates are model units transformed by `xform`, then scaled to meters by the caller.
internal sealed class DisplayParts
{
    // Per shape caps keep one dense hatch or huge block from dominating a Sync.
    private const int MaxSegmentValues = 600000;
    private const int MaxTexts = 2000;
    private const int MaxDepth = 8;
    internal readonly List<double> Vertices = [];
    internal readonly List<int> Indices = [];
    internal readonly List<double> Segments = [];
    internal readonly List<DisplayText> Texts = [];
    internal bool Truncated;
    private readonly RhinoDoc doc;
    private readonly double scale;
    internal DisplayParts(RhinoDoc doc, double scale) { this.doc = doc; this.scale = scale; }
    internal bool Empty => Vertices.Count == 0 && Segments.Count == 0 && Texts.Count == 0;

    /** Flattened block definition, nested references included, in definition space. */
    internal void AddDefinition(InstanceDefinition definition, Transform xform, int depth, HashSet<Guid> path)
    {
        foreach (var member in definition.GetObjects())
        {
            if (member.Geometry is InstanceReferenceGeometry nested)
            {
                var child = doc.InstanceDefinitions.FindId(nested.ParentIdefId);
                if (child == null || child.IsDeleted || depth >= MaxDepth || !path.Add(child.Id)) { Truncated = true; continue; }
                AddDefinition(child, xform * nested.Xform, depth + 1, path);
                path.Remove(child.Id);
            }
            else Add(member.Geometry, xform);
        }
    }

    internal void Add(GeometryBase geometry, Transform xform)
    {
        switch (geometry)
        {
            case Brep or Extrusion:
                using (var brep = geometry is Extrusion extrusion ? extrusion.ToBrep() : ((Brep)geometry).DuplicateBrep())
                {
                    if (brep == null || !brep.IsValid) return;
                    brep.Transform(xform);
                    // Mesh near the origin for float precision, then restore the offset in doubles.
                    var center = brep.GetBoundingBox(false).Center;
                    brep.Transform(Transform.Translation(-center.X, -center.Y, -center.Z));
                    foreach (var mesh in Mesh.CreateFromBrep(brep, MeshingParameters.FastRenderMesh) ?? []) { AddMesh(mesh, center); mesh.Dispose(); }
                }
                return;
            case Mesh nativeMesh:
                using (var mesh = nativeMesh.DuplicateMesh()) { mesh.Transform(xform); AddMesh(mesh, Point3d.Origin); }
                return;
            case Curve curve:
                using (var copy = curve.DuplicateCurve()) { copy.Transform(xform); AddCurve(copy); }
                return;
            case TextEntity text:
                AddText(text, xform);
                return;
            case Dimension dimension:
                AddDimension(dimension, xform);
                return;
            case Hatch hatch:
                AddHatch(hatch, xform);
                return;
        }
    }

    private void AddMesh(Mesh mesh, Point3d offset)
    {
        var start = Vertices.Count / 3;
        for (var i = 0; i < mesh.Vertices.Count; i++)
        {
            var point = mesh.Vertices.Point3dAt(i);
            Vertices.Add((point.X + offset.X) * scale); Vertices.Add((point.Y + offset.Y) * scale); Vertices.Add((point.Z + offset.Z) * scale);
        }
        foreach (var face in mesh.Faces)
        {
            Indices.Add(start + face.A); Indices.Add(start + face.B); Indices.Add(start + face.C);
            if (face.IsQuad) { Indices.Add(start + face.A); Indices.Add(start + face.C); Indices.Add(start + face.D); }
        }
    }

    private void AddCurve(Curve curve)
    {
        var points = curve.TryGetPolyline(out var polyline) ? polyline.ToArray()
            : (curve.DivideByCount(64, true) ?? []).Select(curve.PointAt).ToArray();
        for (var i = 1; i < points.Length; i++) AddSegment(points[i - 1], points[i]);
    }

    private void AddSegment(Point3d a, Point3d b)
    {
        if (Segments.Count + 6 > MaxSegmentValues) { Truncated = true; return; }
        Segments.Add(a.X * scale); Segments.Add(a.Y * scale); Segments.Add(a.Z * scale);
        Segments.Add(b.X * scale); Segments.Add(b.Y * scale); Segments.Add(b.Z * scale);
    }

    private static double Scale(Transform xform)
    {
        var axis = new Vector3d(1, 0, 0);
        axis.Transform(xform);
        return axis.Length;
    }

    // Labels are drawn flat in XY at the insertion height; rotation follows the text direction.
    private void AddLabel(string value, Point3d point, Vector3d direction, double height, int ax, int ay, bool upright)
    {
        value = value.Trim();
        if (value.Length == 0 || !(height > 0) || !point.IsValid) return;
        if (Texts.Count >= MaxTexts) { Truncated = true; return; }
        var rotation = Math.Atan2(direction.Y, direction.X);
        if (upright && (rotation > Math.PI / 2 + 1e-9 || rotation <= -Math.PI / 2 + 1e-9)) rotation += rotation > 0 ? -Math.PI : Math.PI;
        Texts.Add(new DisplayText(value.Length > 2000 ? value[..2000] : value,
            [point.X * scale, point.Y * scale, point.Z * scale], height * scale, rotation, ax, ay));
    }

    private void AddText(TextEntity text, Transform xform)
    {
        var plane = text.Plane;
        plane.Transform(xform);
        var ax = text.TextHorizontalAlignment switch { TextHorizontalAlignment.Center => 1, TextHorizontalAlignment.Right => 2, _ => 0 };
        var ay = text.TextVerticalAlignment switch
        {
            TextVerticalAlignment.Top or TextVerticalAlignment.MiddleOfTop or TextVerticalAlignment.BottomOfTop => 3,
            TextVerticalAlignment.Middle => 2,
            TextVerticalAlignment.Bottom => 0,
            _ => 1,
        };
        AddLabel(text.PlainText, plane.Origin, plane.XAxis, text.TextHeight * text.DimensionScale * Scale(xform), ax, ay, false);
    }

    private void AddDimension(Dimension dimension, Transform xform)
    {
        var parent = doc.DimStyles.FindId(dimension.DimensionStyleId) ?? doc.DimStyles.Current;
        var style = dimension.GetDimensionStyle(parent);
        var dimScale = dimension.DimensionScale;
        IEnumerable<Line>? lines = null;
        switch (dimension)
        {
            case LinearDimension linear: linear.GetDisplayLines(style, dimScale, out lines); break;
            case RadialDimension radial: radial.GetDisplayLines(style, dimScale, out lines); break;
            case OrdinateDimension ordinate: ordinate.GetDisplayLines(style, dimScale, out lines); break;
            case AngularDimension angular:
                if (angular.GetDisplayLines(style, dimScale, out var angularLines, out var arcs))
                {
                    lines = angularLines;
                    foreach (var arc in arcs ?? []) { using var curve = new ArcCurve(arc); curve.Transform(xform); AddCurve(curve); }
                }
                break;
        }
        // Rhino can return a dimension line whose far end sits near the world origin (seen on linear
        // dimensions with a dimension-line extension), which drew long stray lines. The dimension's own
        // bounding box is right, so only the part of each line inside it is kept.
        var box = dimension.GetBoundingBox(true);
        box.Inflate(Math.Max(box.Diagonal.Length * 0.01, doc.ModelAbsoluteTolerance));
        foreach (var line in lines ?? [])
        {
            if (!box.IsValid || !Rhino.Geometry.Intersect.Intersection.LineBox(line, box, 0, out var inside)) continue;
            double from = Math.Max(0, inside.Min), to = Math.Min(1, inside.Max);
            if (from >= to) continue;
            var a = line.PointAt(from); var b = line.PointAt(to);
            a.Transform(xform); b.Transform(xform);
            AddSegment(a, b);
        }
        var plane = dimension.Plane;
        var point = plane.PointAt(dimension.TextPosition.X, dimension.TextPosition.Y);
        point.Transform(xform);
        var direction = plane.XAxis;
        direction.Transform(xform);
        var value = dimension.PlainText;
        if (string.IsNullOrWhiteSpace(value) || value.Contains("<>"))
        {
            // Measured value in the dimension style's length factor and precision.
            var measured = (dimension.NumericValue * style.LengthFactor).ToString(
                "F" + Math.Clamp(style.LengthResolution, 0, 8), System.Globalization.CultureInfo.InvariantCulture);
            value = string.IsNullOrWhiteSpace(value) ? measured : value.Replace("<>", measured);
        }
        AddLabel(value, point, direction, style.TextHeight * dimScale * Scale(xform), 1, 1, true);
    }

    private void AddHatch(Hatch hatch, Transform xform)
    {
        using var copy = (Hatch)hatch.Duplicate();
        copy.Transform(xform);
        var pattern = doc.HatchPatterns[copy.PatternIndex];
        copy.CreateDisplayGeometry(pattern, copy.PatternScale, out var bounds, out var lines, out var solid);
        foreach (var curve in bounds ?? []) { AddCurve(curve); curve.Dispose(); }
        foreach (var line in lines ?? []) AddSegment(line.From, line.To);
        if (solid != null)
        {
            foreach (var mesh in Mesh.CreateFromBrep(solid, MeshingParameters.FastRenderMesh) ?? []) { AddMesh(mesh, Point3d.Origin); mesh.Dispose(); }
            solid.Dispose();
        }
    }
}
