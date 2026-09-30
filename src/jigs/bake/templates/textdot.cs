// vide.bake.textdot@1 — text dots (marks) on one output layer (ARCH-03 §9, SPEC-07.12). Fixed
// C# method body owned by VIDE; the only value from a jig is the data block in the one placeholder.
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var pos = 0;
int I32() { var v = BitConverter.ToInt32(data, pos); pos += 4; return v; }
float F32() { var v = BitConverter.ToSingle(data, pos); pos += 4; return v; }
double F64() { var v = BitConverter.ToDouble(data, pos); pos += 8; return v; }
string Str() { var n = I32(); if (n < 0 || pos + n > data.Length) throw new Exception("BAKE_DATA"); var s = System.Text.Encoding.UTF8.GetString(data, pos, n); pos += n; return s; }
if (Str() != "vide.bake.data/1") throw new Exception("BAKE_FORMAT");
if (Str() != "vide.bake.textdot@1") throw new Exception("BAKE_TEMPLATE");
var jigId = Str(); var instanceId = Str(); var bakeId = Str(); var runId = Str(); var layerPath = Str();
var ox = F64(); var oy = F64(); var oz = F64();
var scale = RhinoMath.UnitScale(UnitSystem.Meters, doc.ModelUnitSystem);
Point3d Vec() { var x = F32(); var y = F32(); var z = F32(); return new Point3d((ox + x) * scale, (oy + y) * scale, (oz + z) * scale); }
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
    var text = Str(); var point = Vec();
    attributes.Name = attributes.GetUserString("vide-mark") ?? key;
    var added = doc.Objects.AddTextDot(new TextDot(text, point), attributes);
    if (added == Guid.Empty) failed.Add(key); else { keys.Add(key); ids.Add(added.ToString()); }
}
return new { removed, keys = keys.ToArray(), ids = ids.ToArray(), failed = failed.ToArray() };
