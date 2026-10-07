// vide.bake.extrude-polygon@1 — closed polygons (an outline and its holes) extruded up from their
// level to closed polysurfaces (T-208: site buildings, SPEC-12.6; ARCH-03 §9). The order follows
// S-19's polygon extrusion: winding fixed (outline counter-clockwise, holes clockwise seen from
// above), one planar face, extrusion with caps, then the checks. A key is made only as one closed,
// valid, outward solid from its level up to level + height whose volume is the rings' area ×
// height within 1e-6 relative; anything else comes back in failed[]. Faces are made at 1e-5 m,
// not the document tolerance (SPIKE-2026-10-07-envelope). Fixed C# method body owned by VIDE; the
// only value from a jig is the data block in the one placeholder.
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var pos = 0;
int I32() { var v = BitConverter.ToInt32(data, pos); pos += 4; return v; }
float F32() { var v = BitConverter.ToSingle(data, pos); pos += 4; return v; }
double F64() { var v = BitConverter.ToDouble(data, pos); pos += 8; return v; }
string Str() { var n = I32(); if (n < 0 || pos + n > data.Length) throw new Exception("BAKE_DATA"); var s = System.Text.Encoding.UTF8.GetString(data, pos, n); pos += n; return s; }
if (Str() != "vide.bake.data/1") throw new Exception("BAKE_FORMAT");
if (Str() != "vide.bake.extrude-polygon@1") throw new Exception("BAKE_TEMPLATE");
var jigId = Str(); var instanceId = Str(); var bakeId = Str(); var runId = Str(); var layerPath = Str();
var ox = F64(); var oy = F64(); var oz = F64();
var scale = RhinoMath.UnitScale(UnitSystem.Meters, doc.ModelUnitSystem);
var fine = 1e-5 * scale;
Point3d Vec() { var x = F32(); var y = F32(); var z = F32(); return new Point3d((ox + x) * scale, (oy + y) * scale, (oz + z) * scale); }
// Rings of points: the outline first, then holes; the closing point is not repeated in the data.
System.Collections.Generic.List<System.Collections.Generic.List<Point3d>> ReadRings()
{
    var list = new System.Collections.Generic.List<System.Collections.Generic.List<Point3d>>();
    for (var r = I32(); r > 0; r--) { var ring = new System.Collections.Generic.List<Point3d>(); for (var p = I32(); p > 0; p--) ring.Add(Vec()); list.Add(ring); }
    return list;
}
Curve Closed(System.Collections.Generic.List<Point3d> ring) => new PolylineCurve(new System.Collections.Generic.List<Point3d>(ring) { ring[0] });
// Signed area seen from above, measured from the first point so survey coordinates keep precision.
double Signed(System.Collections.Generic.List<Point3d> ring)
{
    var sum = 0.0; var o = ring[0];
    for (var k = 1; k + 1 < ring.Count; k++) sum += (ring[k].X - o.X) * (ring[k + 1].Y - o.Y) - (ring[k + 1].X - o.X) * (ring[k].Y - o.Y);
    return sum / 2;
}
Brep Extrude(System.Collections.Generic.List<System.Collections.Generic.List<Point3d>> outline, double up)
{
    if (!(up > 0) || outline.Count == 0) return null;
    var curves = new System.Collections.Generic.List<Curve>(); var area = 0.0;
    for (var r = 0; r < outline.Count; r++)
    {
        var ring = outline[r];
        if (ring.Count < 3) return null;
        var signed = Signed(ring);
        if (Math.Abs(signed) <= fine * fine) return null;
        if ((r == 0) != (signed > 0)) ring.Reverse();
        area += r == 0 ? Math.Abs(signed) : -Math.Abs(signed);
        curves.Add(Closed(ring));
    }
    var bottom = outline[0][0].Z;
    var planar = Brep.CreatePlanarBreps(curves, fine);
    if (!(area > 0) || planar == null || planar.Length != 1 || planar[0].Faces.Count != 1) return null;
    var made = planar[0].Faces[0].CreateExtrusion(new LineCurve(outline[0][0], outline[0][0] + Vector3d.ZAxis * up), true);
    if (made == null || !made.IsSolid || !made.IsValid) return null;
    // The extrusion's own orientation follows the face normal; that is construction, not data.
    if (made.SolidOrientation == BrepSolidOrientation.Inward) made.Flip();
    if (made.SolidOrientation != BrepSolidOrientation.Outward) return null;
    var box = made.GetBoundingBox(true);
    if (Math.Abs(box.Min.Z - bottom) > fine || Math.Abs(box.Max.Z - bottom - up) > fine) return null;
    var mass = VolumeMassProperties.Compute(made, true, false, false, false);
    var expected = area * up;
    return mass != null && Math.Abs(mass.Volume - expected) <= 1e-6 * expected ? made : null;
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
    attributes.Name = attributes.GetUserString("vide-mark") ?? key;
    var height = F32() * scale;
    var rings = ReadRings();
    var solid = Extrude(rings, height);
    var added = solid == null ? Guid.Empty : doc.Objects.AddBrep(solid, attributes);
    if (added == Guid.Empty) failed.Add(key); else { keys.Add(key); ids.Add(added.ToString()); }
}
return new { removed, keys = keys.ToArray(), ids = ids.ToArray(), failed = failed.ToArray() };
