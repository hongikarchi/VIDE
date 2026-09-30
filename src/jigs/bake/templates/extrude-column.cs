// vide.bake.extrude-column@1 — H columns from base to top with the flanges along the strong
// axis direction (ARCH-03 §9, SPEC-07.12). The profile is centred on the column axis and extruded
// to a closed solid. Fixed C# method body owned by VIDE; the only value from a jig is the data
// block in the one placeholder.
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var pos = 0;
int I32() { var v = BitConverter.ToInt32(data, pos); pos += 4; return v; }
float F32() { var v = BitConverter.ToSingle(data, pos); pos += 4; return v; }
double F64() { var v = BitConverter.ToDouble(data, pos); pos += 8; return v; }
string Str() { var n = I32(); if (n < 0 || pos + n > data.Length) throw new Exception("BAKE_DATA"); var s = System.Text.Encoding.UTF8.GetString(data, pos, n); pos += n; return s; }
if (Str() != "vide.bake.data/1") throw new Exception("BAKE_FORMAT");
if (Str() != "vide.bake.extrude-column@1") throw new Exception("BAKE_TEMPLATE");
var jigId = Str(); var instanceId = Str(); var bakeId = Str(); var runId = Str(); var layerPath = Str();
var ox = F64(); var oy = F64(); var oz = F64();
var scale = RhinoMath.UnitScale(UnitSystem.Meters, doc.ModelUnitSystem);
var tolerance = doc.ModelAbsoluteTolerance;
Point3d Vec() { var x = F32(); var y = F32(); var z = F32(); return new Point3d((ox + x) * scale, (oy + y) * scale, (oz + z) * scale); }
// H profile centred on the base point: u along the flanges (strong axis), v along the web.
Brep Column(Point3d basePoint, Point3d topPoint, Vector3d strongAxis, double H, double B, double tw, double tf)
{
    var axis = topPoint - basePoint;
    if (axis.Length <= tolerance) return null;
    axis.Unitize();
    var along = strongAxis - axis * (strongAxis * axis);
    if (!along.Unitize()) { along = Vector3d.CrossProduct(axis, Vector3d.ZAxis); if (!along.Unitize()) along = Vector3d.XAxis; }
    var web = Vector3d.CrossProduct(axis, along); web.Unitize();
    Point3d P(double u, double v) => basePoint + along * u + web * v;
    var profile = new PolylineCurve(new[] {
        P(-B / 2, H / 2), P(B / 2, H / 2), P(B / 2, H / 2 - tf), P(tw / 2, H / 2 - tf), P(tw / 2, -H / 2 + tf), P(B / 2, -H / 2 + tf), P(B / 2, -H / 2),
        P(-B / 2, -H / 2), P(-B / 2, -H / 2 + tf), P(-tw / 2, -H / 2 + tf), P(-tw / 2, H / 2 - tf), P(-B / 2, H / 2 - tf), P(-B / 2, H / 2) });
    var surface = Surface.CreateExtrusion(profile, topPoint - basePoint);
    if (surface == null) return null;
    var solid = surface.ToBrep().CapPlanarHoles(tolerance);
    // Validity through the Brep's own checks: the worker refuses invalid objects after the run.
    return solid != null && solid.IsSolid && solid.IsValidTopology(out _) && solid.IsValidGeometry(out _) ? solid : null;
}
// The output layer: one level under the fixed parent, on and unlocked (SPEC-07.12 2, ARCH-03 §9.5).
var separator = layerPath.LastIndexOf("::");
if (separator < 0) throw new Exception("BAKE_LAYER");
var layerIndex = doc.Layers.FindByFullPath(layerPath, -1);
if (layerIndex < 0)
{
    var parentIndex = doc.Layers.FindByFullPath(layerPath.Substring(0, separator), -1);
    if (parentIndex < 0) throw new Exception("BAKE_LAYER_ROOT");
    layerIndex = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = layerPath.Substring(separator + 2), ParentLayerId = doc.Layers[parentIndex].Id, IsVisible = true, IsLocked = false });
    if (layerIndex < 0) throw new Exception("BAKE_LAYER_ADD");
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
    var basePoint = Vec(); var topPoint = Vec();
    var ax = F32(); var ay = F32(); var az = F32();
    attributes.Name = attributes.GetUserString("vide-mark") ?? key;
    var column = Column(basePoint, topPoint, new Vector3d(ax, ay, az), H, B, tw, tf);
    var added = column == null ? Guid.Empty : doc.Objects.AddBrep(column, attributes);
    if (added == Guid.Empty) failed.Add(key); else { keys.Add(key); ids.Add(added.ToString()); }
}
return new { removed, keys = keys.ToArray(), ids = ids.ToArray(), failed = failed.ToArray() };
