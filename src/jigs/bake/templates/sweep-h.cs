// vide.bake.sweep-h@1 — H (or BH) members under their top line, web vertical (ARCH-03 §9,
// SPEC-07.12). The rail is the member's top line; the flange width lies horizontally across it
// and the depth hangs below it. A straight rail is extruded, a curved one is swept with Z as the
// road-like up direction, and both are capped to a closed solid. Fixed C# method body owned by
// VIDE; the only value from a jig is the data block in the one placeholder.
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var pos = 0;
int I32() { var v = BitConverter.ToInt32(data, pos); pos += 4; return v; }
float F32() { var v = BitConverter.ToSingle(data, pos); pos += 4; return v; }
double F64() { var v = BitConverter.ToDouble(data, pos); pos += 8; return v; }
string Str() { var n = I32(); if (n < 0 || pos + n > data.Length) throw new Exception("BAKE_DATA"); var s = System.Text.Encoding.UTF8.GetString(data, pos, n); pos += n; return s; }
if (Str() != "vide.bake.data/1") throw new Exception("BAKE_FORMAT");
if (Str() != "vide.bake.sweep-h@1") throw new Exception("BAKE_TEMPLATE");
var jigId = Str(); var instanceId = Str(); var bakeId = Str(); var runId = Str(); var layerPath = Str();
var ox = F64(); var oy = F64(); var oz = F64();
var scale = RhinoMath.UnitScale(UnitSystem.Meters, doc.ModelUnitSystem);
var tolerance = doc.ModelAbsoluteTolerance;
Point3d Vec() { var x = F32(); var y = F32(); var z = F32(); return new Point3d((ox + x) * scale, (oy + y) * scale, (oz + z) * scale); }
// A degenerate rail (collinear arc points, zero length) comes back null and is reported as failed.
Curve ReadCurve()
{
    var kind = I32(); var n = I32();
    var points = new System.Collections.Generic.List<Point3d>();
    for (var i = 0; i < n; i++) points.Add(Vec());
    if (kind == 1) { if (n != 3) return null; var arc = new Arc(points[0], points[1], points[2]); return arc.IsValid ? new ArcCurve(arc) : null; }
    if (n < 2) return null;
    var polyline = new PolylineCurve(points);
    return polyline.GetLength() > tolerance ? polyline : null;
}
// H profile in the vertical plane through the rail start: u across the flanges, v down from the top.
Brep Member(Curve rail, double H, double B, double tw, double tf)
{
    var origin = rail.PointAtStart; var tangent = rail.TangentAtStart; tangent.Unitize();
    var across = Vector3d.CrossProduct(tangent, Vector3d.ZAxis);
    if (!across.Unitize()) { across = Vector3d.CrossProduct(tangent, Vector3d.YAxis); across.Unitize(); }
    var up = Vector3d.ZAxis;
    Point3d P(double u, double v) => origin + across * u + up * v;
    var profile = new PolylineCurve(new[] {
        P(-B / 2, 0), P(B / 2, 0), P(B / 2, -tf), P(tw / 2, -tf), P(tw / 2, -H + tf), P(B / 2, -H + tf), P(B / 2, -H),
        P(-B / 2, -H), P(-B / 2, -H + tf), P(-tw / 2, -H + tf), P(-tw / 2, -tf), P(-B / 2, -tf), P(-B / 2, 0) });
    Brep open = null;
    if (rail.IsLinear(tolerance))
    {
        var surface = Surface.CreateExtrusion(profile, rail.PointAtEnd - rail.PointAtStart);
        open = surface == null ? null : surface.ToBrep();
    }
    else
    {
        var sweep = new SweepOneRail(); sweep.SetRoadlikeUpDirection(Vector3d.ZAxis); sweep.ClosedSweep = false;
        var swept = sweep.PerformSweep(rail, profile);
        if (swept != null && swept.Length == 1) open = swept[0];
    }
    if (open == null) return null;
    var solid = open.CapPlanarHoles(tolerance);
    // Validity through the Brep's own checks: the worker refuses invalid objects after the run.
    return solid != null && solid.IsSolid && solid.IsValidTopology(out _) && solid.IsValidGeometry(out _) ? solid : null;
}
// The output layer (SPEC-07.12 2, ARCH-03 §9.5): every level of layerPath is found under its own
// parent (never by name elsewhere, never at the root unless it is the first level) and made there,
// on and unlocked, when missing. Existing levels keep their properties. Up to 8 levels.
var layerNames = layerPath.Split(new[] { "::" }, StringSplitOptions.None);
if (layerNames.Length < 2 || layerNames.Length > 8) throw new Exception("BAKE_LAYER");
var layerIndex = -1; var layerParent = Guid.Empty;
foreach (var layerName in layerNames)
{
    if (layerName.Trim().Length == 0 || layerName.Trim() != layerName || layerName.Contains(":")) throw new Exception("BAKE_LAYER");
    var level = doc.Layers.FirstOrDefault(l => !l.IsDeleted && l.ParentLayerId == layerParent && string.Equals(l.Name, layerName, StringComparison.OrdinalIgnoreCase));
    layerIndex = level != null ? level.Index : doc.Layers.Add(new Rhino.DocObjects.Layer { Name = layerName, ParentLayerId = layerParent, IsVisible = true, IsLocked = false });
    if (layerIndex < 0) throw new Exception("BAKE_LAYER_ADD");
    layerParent = doc.Layers[layerIndex].Id;
}
// Delete only the GUIDs VIDE listed, and only when they carry this instance's and bake's tags.
var removed = 0; var nDelete = I32();
for (var i = 0; i < nDelete; i++)
{
    var id = Guid.Parse(Str()); var existing = doc.Objects.FindId(id);
    if (existing == null) continue;
    if (existing.Attributes.GetUserString("vide-instance") != instanceId || existing.Attributes.GetUserString("vide-bake") != bakeId) continue;
    if (doc.Objects.Delete(id, true)) removed++;
}
var keys = new System.Collections.Generic.List<string>(); var ids = new System.Collections.Generic.List<string>(); var failed = new System.Collections.Generic.List<string>();
var nItems = I32();
for (var i = 0; i < nItems; i++)
{
    var key = Str();
    var attributes = new Rhino.DocObjects.ObjectAttributes { LayerIndex = layerIndex };
    attributes.SetUserString("vide-jig", jigId); attributes.SetUserString("vide-instance", instanceId); attributes.SetUserString("vide-run", runId);
    attributes.SetUserString("vide-bake", bakeId); attributes.SetUserString("vide-key", key);
    var nAttr = I32();
    for (var a = 0; a < nAttr; a++) { var name = Str(); var value = Str(); attributes.SetUserString(name, value); }
    var section = Str(); attributes.SetUserString("vide-section", section);
    var H = F32() / 1000.0 * scale; var B = F32() / 1000.0 * scale; var tw = F32() / 1000.0 * scale; var tf = F32() / 1000.0 * scale;
    var rail = ReadCurve();
    attributes.Name = attributes.GetUserString("vide-mark") ?? key;
    var member = rail == null ? null : Member(rail, H, B, tw, tf);
    var added = member == null ? Guid.Empty : doc.Objects.AddBrep(member, attributes);
    if (added == Guid.Empty) failed.Add(key); else { keys.Add(key); ids.Add(added.ToString()); }
}
return new { removed, keys = keys.ToArray(), ids = ids.ToArray(), failed = failed.ToArray() };
