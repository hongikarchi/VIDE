// vide.bake.curves@1 — polylines and three-point arcs on one output layer (ARCH-03 §9, SPEC-07.12).
// This text is a fixed C# method body owned by VIDE; the only value from a jig is the data block
// in the one placeholder below. The worker wraps it as TaskCode.Run(RhinoDoc doc) and CodePolicy
// checks it. Objects are tagged vide-jig/instance/run/bake/key plus the item's own user strings.
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var pos = 0;
int I32() { var v = BitConverter.ToInt32(data, pos); pos += 4; return v; }
float F32() { var v = BitConverter.ToSingle(data, pos); pos += 4; return v; }
double F64() { var v = BitConverter.ToDouble(data, pos); pos += 8; return v; }
string Str() { var n = I32(); if (n < 0 || pos + n > data.Length) throw new Exception("BAKE_DATA"); var s = System.Text.Encoding.UTF8.GetString(data, pos, n); pos += n; return s; }
if (Str() != "vide.bake.data/1") throw new Exception("BAKE_FORMAT");
if (Str() != "vide.bake.curves@1") throw new Exception("BAKE_TEMPLATE");
var jigId = Str(); var instanceId = Str(); var bakeId = Str(); var runId = Str(); var layerPath = Str();
var ox = F64(); var oy = F64(); var oz = F64();
var scale = RhinoMath.UnitScale(UnitSystem.Meters, doc.ModelUnitSystem);
Point3d Vec() { var x = F32(); var y = F32(); var z = F32(); return new Point3d((ox + x) * scale, (oy + y) * scale, (oz + z) * scale); }
var tolerance = doc.ModelAbsoluteTolerance;
// A degenerate curve (collinear arc points, zero length) comes back null and is reported as failed.
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
// The delete list, then the surface guard: a 패널링 make whose face changed makes nothing.
var deleteIds = new System.Collections.Generic.List<string>();
var nDelete = I32();
for (var i = 0; i < nDelete; i++) deleteIds.Add(Str());
//@include face-hash.cs
//@include surface-guard.cs
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
var removed = 0;
foreach (var deleteId in deleteIds)
{
    var id = Guid.Parse(deleteId); var existing = doc.Objects.FindId(id);
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
    var curve = ReadCurve();
    var added = curve == null ? Guid.Empty : doc.Objects.AddCurve(curve, attributes);
    if (added == Guid.Empty) failed.Add(key); else { keys.Add(key); ids.Add(added.ToString()); }
}
return new { removed, keys = keys.ToArray(), ids = ids.ToArray(), failed = failed.ToArray() };
