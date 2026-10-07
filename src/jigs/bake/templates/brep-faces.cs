// vide.bake.brep-faces@1 — closed polyhedra from the engine's planar faces (T-208: envelopes,
// SPEC-12.9; ARCH-03 §9; SPIKE-2026-10-07-envelope). Each face is an outer ring wound
// counter-clockwise seen from outside and its holes wound the other way. Faces are made and joined
// at 1e-5 m, not the document tolerance (BSP results have edges shorter than 1 mm), and coplanar
// faces are never merged here (MergeCoplanarFaces changed volumes by 4.7–9.9 % in the spike). A key
// is made only when the faces as wound enclose the engine's volume and the join gives one piece
// that is solid, valid and outward with a volume within 1e-6 relative of the engine's; anything
// else comes back in failed[] — a reversed solid is never flipped (SPEC-12.9 4).
// Fixed C# method body owned by VIDE; the only value from a jig is the data block in the one
// placeholder.
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var pos = 0;
int I32() { var v = BitConverter.ToInt32(data, pos); pos += 4; return v; }
float F32() { var v = BitConverter.ToSingle(data, pos); pos += 4; return v; }
double F64() { var v = BitConverter.ToDouble(data, pos); pos += 8; return v; }
string Str() { var n = I32(); if (n < 0 || pos + n > data.Length) throw new Exception("BAKE_DATA"); var s = System.Text.Encoding.UTF8.GetString(data, pos, n); pos += n; return s; }
if (Str() != "vide.bake.data/1") throw new Exception("BAKE_FORMAT");
if (Str() != "vide.bake.brep-faces@1") throw new Exception("BAKE_TEMPLATE");
var jigId = Str(); var instanceId = Str(); var bakeId = Str(); var runId = Str(); var layerPath = Str();
var ox = F64(); var oy = F64(); var oz = F64();
var scale = RhinoMath.UnitScale(UnitSystem.Meters, doc.ModelUnitSystem);
var fine = 1e-5 * scale;
Point3d Vec() { var x = F32(); var y = F32(); var z = F32(); return new Point3d((ox + x) * scale, (oy + y) * scale, (oz + z) * scale); }
// Rings of points: the outer ring first, then holes; the closing point is not repeated in the data.
System.Collections.Generic.List<System.Collections.Generic.List<Point3d>> ReadRings()
{
    var list = new System.Collections.Generic.List<System.Collections.Generic.List<Point3d>>();
    for (var r = I32(); r > 0; r--) { var ring = new System.Collections.Generic.List<Point3d>(); for (var p = I32(); p > 0; p--) ring.Add(Vec()); list.Add(ring); }
    return list;
}
Curve Closed(System.Collections.Generic.List<Point3d> ring) => new PolylineCurve(new System.Collections.Generic.List<Point3d>(ring) { ring[0] });
// Newell normal of a ring: the side its counter-clockwise winding faces.
Vector3d Newell(System.Collections.Generic.List<Point3d> ring)
{
    var sum = Vector3d.Zero; var o = ring[0];
    for (var k = 0; k < ring.Count; k++)
    {
        var p = ring[k] - o; var q = ring[(k + 1) % ring.Count] - o;
        sum += new Vector3d((p.Y - q.Y) * (p.Z + q.Z), (p.Z - q.Z) * (p.X + q.X), (p.X - q.X) * (p.Y + q.Y));
    }
    return sum;
}
// Signed volume of the faces as wound (fans from each ring's first point, measured from one point
// of the solid): negative for a reversed solid. JoinBreps orients a closed result outward by itself,
// so a reversed solid is caught here, from the data, not by SolidOrientation alone.
double Wound(System.Collections.Generic.List<System.Collections.Generic.List<System.Collections.Generic.List<Point3d>>> faceList)
{
    var sum = 0.0; var o = faceList[0][0][0];
    foreach (var face in faceList)
        foreach (var ring in face)
            for (var k = 1; k + 1 < ring.Count; k++)
            {
                var a = ring[0] - o; var b = ring[k] - o; var c = ring[k + 1] - o;
                sum += a * Vector3d.CrossProduct(b, c);
            }
    return sum / 6;
}
Brep Solid(System.Collections.Generic.List<System.Collections.Generic.List<System.Collections.Generic.List<Point3d>>> faceList, double expected)
{
    if (!(expected > 0) || faceList.Count < 4 || faceList.Any(face => face.Count == 0 || face.Any(ring => ring.Count < 3))) return null;
    if (Math.Abs(Wound(faceList) - expected) > 1e-6 * expected) return null;
    var pieces = new System.Collections.Generic.List<Brep>();
    foreach (var face in faceList)
    {
        var planar = Brep.CreatePlanarBreps(face.Select(Closed).ToArray(), fine);
        if (planar == null || planar.Length != 1 || planar[0].Faces.Count != 1) return null;
        // Each face points the way the engine wound it; the join and the checks keep or refuse that.
        var surface = planar[0].Faces[0];
        var normal = surface.NormalAt(surface.Domain(0).Mid, surface.Domain(1).Mid);
        if (normal * Newell(face[0]) < 0) planar[0].Flip();
        pieces.Add(planar[0]);
    }
    var joined = Brep.JoinBreps(pieces, fine);
    if (joined == null || joined.Length != 1) return null;
    var made = joined[0];
    if (!made.IsSolid || !made.IsValid || made.SolidOrientation != BrepSolidOrientation.Outward) return null;
    var mass = VolumeMassProperties.Compute(made, true, false, false, false);
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
    var volume = F64() * scale * scale * scale;
    var faces = new System.Collections.Generic.List<System.Collections.Generic.List<System.Collections.Generic.List<Point3d>>>();
    for (var f = I32(); f > 0; f--) faces.Add(ReadRings());
    var solid = Solid(faces, volume);
    var added = solid == null ? Guid.Empty : doc.Objects.AddBrep(solid, attributes);
    if (added == Guid.Empty) failed.Add(key); else { keys.Add(key); ids.Add(added.ToString()); }
}
return new { removed, keys = keys.ToArray(), ids = ids.ToArray(), failed = failed.ToArray() };
