// vide.bake.mesh@1 — meshes from vertices and triangle or quad faces (T-208: terrain, SPEC-12.6;
// ARCH-03 §9). Vertices keep double precision so survey-sized coordinates stay put. A mesh with a
// face index out of range, a dropped face or an invalid result comes back in failed[]. A terrain
// larger than one worker body is split into several items by the jig (`splitMesh`). Fixed C#
// method body owned by VIDE; the only value from a jig is the data block in the one placeholder.
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var pos = 0;
int I32() { var v = BitConverter.ToInt32(data, pos); pos += 4; return v; }
float F32() { var v = BitConverter.ToSingle(data, pos); pos += 4; return v; }
double F64() { var v = BitConverter.ToDouble(data, pos); pos += 8; return v; }
string Str() { var n = I32(); if (n < 0 || pos + n > data.Length) throw new Exception("BAKE_DATA"); var s = System.Text.Encoding.UTF8.GetString(data, pos, n); pos += n; return s; }
if (Str() != "vide.bake.data/1") throw new Exception("BAKE_FORMAT");
if (Str() != "vide.bake.mesh@1") throw new Exception("BAKE_TEMPLATE");
var jigId = Str(); var instanceId = Str(); var bakeId = Str(); var runId = Str(); var layerPath = Str();
var ox = F64(); var oy = F64(); var oz = F64();
var scale = RhinoMath.UnitScale(UnitSystem.Meters, doc.ModelUnitSystem);
Point3d Vec() { var x = F32(); var y = F32(); var z = F32(); return new Point3d((ox + x) * scale, (oy + y) * scale, (oz + z) * scale); }
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
    var mesh = new Mesh();
    mesh.Vertices.UseDoublePrecisionVertices = true;
    var nVertices = I32();
    for (var v = 0; v < nVertices; v++) mesh.Vertices.Add(Vec());
    var nFaces = I32(); var bad = false;
    for (var f = 0; f < nFaces; f++)
    {
        var fa = I32(); var fb = I32(); var fc = I32(); var fd = I32();
        if (fa < 0 || fb < 0 || fc < 0 || fa >= nVertices || fb >= nVertices || fc >= nVertices || fd >= nVertices) { bad = true; continue; }
        if (fd < 0) mesh.Faces.AddFace(fa, fb, fc); else mesh.Faces.AddFace(fa, fb, fc, fd);
    }
    var made = !bad && nFaces > 0 && mesh.Faces.Count == nFaces;
    if (made) { mesh.Normals.ComputeNormals(); made = mesh.IsValid; }
    var added = made ? doc.Objects.AddMesh(mesh, attributes) : Guid.Empty;
    if (added == Guid.Empty) failed.Add(key); else { keys.Add(key); ids.Add(added.ToString()); }
}
return new { removed, keys = keys.ToArray(), ids = ids.ToArray(), failed = failed.ToArray() };
