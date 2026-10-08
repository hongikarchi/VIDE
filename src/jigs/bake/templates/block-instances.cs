// vide.bake.block-instances@1 — 패널링 3단계 [타입 만들기] (SPEC-16.9, PLAN-49 T-257, ARCH-03 §9.1):
// one block definition per panel type and one placement (block instance) per typed panel, on
// layerRoot::타입::<type>. Fixed C# method body owned by VIDE; the only value from a jig is the data
// block in the one placeholder. A definition is the type representative's flat outline in its own
// frame (first vertex at the origin, pattern axis +X, front face +Z) pushed by the signed thickness
// along +Z into a closed solid; its name is `vide-panel-<type>-<typing fingerprint 6>` and its
// description names this jig, instance and make, so a renumbered type never mixes with an older
// definition. A definition of that name that VIDE did not make is never touched: its placements
// fail with BLOCK_NAME_TAKEN. A definition of this make whose name has another fingerprint is
// removed once no placement uses it (a person-edited placement kept by the engine keeps it). A
// panel that fails (the engine's failures, a taken name, an invalid solid) is left on the failure
// layer as its outline and number (SPEC-16.9 5). A time budget makes the body throw, so the
// attached run undoes the whole body (definitions included).
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var started = DateTime.UtcNow;
var pos = 0;
int I32() { var v = BitConverter.ToInt32(data, pos); pos += 4; return v; }
float F32() { var v = BitConverter.ToSingle(data, pos); pos += 4; return v; }
double F64() { var v = BitConverter.ToDouble(data, pos); pos += 8; return v; }
string Str() { var n = I32(); if (n < 0 || pos + n > data.Length) throw new Exception("BAKE_DATA"); var s = System.Text.Encoding.UTF8.GetString(data, pos, n); pos += n; return s; }
if (Str() != "vide.bake.data/1") throw new Exception("BAKE_FORMAT");
if (Str() != "vide.bake.block-instances@1") throw new Exception("BAKE_TEMPLATE");
var jigId = Str(); var instanceId = Str(); var bakeId = Str(); var runId = Str(); var layerPath = Str();
var ox = F64(); var oy = F64(); var oz = F64();
if (doc.ModelUnitSystem == UnitSystem.None) throw new Exception("UNKNOWN_UNITS: 문서 단위가 없습니다");
var scale = RhinoMath.UnitScale(UnitSystem.Meters, doc.ModelUnitSystem);
var tol = doc.ModelAbsoluteTolerance;
Point3d Vec() { var x = F32(); var y = F32(); var z = F32(); return new Point3d((ox + x) * scale, (oy + y) * scale, (oz + z) * scale); }
var deleteIds = new System.Collections.Generic.List<string>();
var nDelete = I32();
for (var i = 0; i < nDelete; i++) deleteIds.Add(Str());
// Block header: key prefix, typing fingerprint, budget, failure layer, shared attributes, definitions.
var keyPrefix = Str(); var hash = Str(); var budgetMs = F64(); var failLayerPath = Str();
var shared = new System.Collections.Generic.List<string[]>();
var nShared = I32();
for (var i = 0; i < nShared; i++) shared.Add(new[] { Str(), Str() });
var nDefs = I32();
var defNames = new string[nDefs]; var defTypes = new string[nDefs]; var defThickness = new double[nDefs];
var defOutlines = new Point3d[nDefs][];
for (var i = 0; i < nDefs; i++)
{
    defNames[i] = Str(); defTypes[i] = Str(); defThickness[i] = F64();
    var n = I32();
    if (n < 3 || n > 64) throw new Exception("BAKE_DATA: 블록 윤곽");
    var points = new Point3d[n];
    for (var k = 0; k < n; k++) { var x = F64(); var y = F64(); points[k] = new Point3d(x * scale, y * scale, 0); }
    defOutlines[i] = points;
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
// The type levels (layerPath::T-01 …) and the failure layer are walked the same way, each made only
// when something goes there.
var layerCache = new System.Collections.Generic.Dictionary<string, int>();
layerCache[layerPath] = layerIndex;
int LayerOf(string path)
{
    if (layerCache.TryGetValue(path, out var cached)) return cached;
    var names = path.Split(new[] { "::" }, StringSplitOptions.None);
    if (names.Length < 2 || names.Length > 8) throw new Exception("BAKE_LAYER");
    var parent = Guid.Empty; var index = -1;
    foreach (var name in names)
    {
        if (name.Trim().Length == 0 || name.Trim() != name || name.Contains(":")) throw new Exception("BAKE_LAYER");
        var level = doc.Layers.FirstOrDefault(l => !l.IsDeleted && l.ParentLayerId == parent && string.Equals(l.Name, name, StringComparison.OrdinalIgnoreCase));
        index = level != null ? level.Index : doc.Layers.Add(new Rhino.DocObjects.Layer { Name = name, ParentLayerId = parent, IsVisible = true, IsLocked = false });
        if (index < 0) throw new Exception("BAKE_LAYER_ADD");
        parent = doc.Layers[index].Id;
    }
    layerCache[path] = index;
    return index;
}
// Delete only the GUIDs VIDE listed, and only when they carry this instance's and bake's tags.
var removed = 0;
foreach (var text in deleteIds)
{
    var id = Guid.Parse(text); var existing = doc.Objects.FindId(id);
    if (existing == null) continue;
    if (existing.Attributes.GetUserString("vide-instance") != instanceId || existing.Attributes.GetUserString("vide-bake") != bakeId) continue;
    if (doc.Objects.Delete(id, true)) removed++;
}
// Definitions: reuse VIDE's own of the same name, never one a person made; else make the solid.
var owner = "VIDE " + jigId + " · " + instanceId + " · " + bakeId;
var ownedByJig = "VIDE " + jigId + " · ";
var defIndex = new int[nDefs]; var defFailed = new string[nDefs];
var defsMade = new System.Collections.Generic.List<string>();
for (var i = 0; i < nDefs; i++)
{
    defIndex[i] = -1; defFailed[i] = "";
    var name = defNames[i];
    var existing = doc.InstanceDefinitions.FirstOrDefault(d => d != null && !d.IsDeleted && string.Equals(d.Name, name, StringComparison.OrdinalIgnoreCase));
    if (existing != null)
    {
        if ((existing.Description ?? "").StartsWith(ownedByJig, StringComparison.Ordinal)) defIndex[i] = existing.Index;
        else defFailed[i] = "BLOCK_NAME_TAKEN";
        continue;
    }
    // Corners closer than the tolerance (a cut panel along a trim) are one corner.
    var ring = new System.Collections.Generic.List<Point3d>();
    foreach (var q in defOutlines[i]) if (ring.Count == 0 || ring[ring.Count - 1].DistanceTo(q) > tol) ring.Add(q);
    while (ring.Count > 3 && ring[0].DistanceTo(ring[ring.Count - 1]) <= tol) ring.RemoveAt(ring.Count - 1);
    if (ring.Count < 3) { defFailed[i] = "BLOCK_GEOMETRY"; continue; }
    ring.Add(ring[0]);
    var lift = new Vector3d(0, 0, defThickness[i] * scale);
    var extruded = Surface.CreateExtrusion(new PolylineCurve(ring), lift);
    var solid = extruded == null ? null : Brep.CreateFromSurface(extruded)?.CapPlanarHoles(tol);
    if (solid == null || !solid.IsSolid || !solid.IsValid)
    {
        // Face by face: the two planar caps and a side per edge, joined into one closed solid.
        var parts = new System.Collections.Generic.List<Brep>();
        var caps = Brep.CreatePlanarBreps(new PolylineCurve(ring), tol);
        if (caps != null && caps.Length == 1)
        {
            parts.Add(caps[0]);
            var top = caps[0].DuplicateBrep(); top.Translate(lift); parts.Add(top);
        }
        for (var k = 0; k + 1 < ring.Count; k++)
        {
            var side = Brep.CreateFromCornerPoints(ring[k], ring[k + 1], ring[k + 1] + lift, ring[k] + lift, tol);
            if (side != null) parts.Add(side);
        }
        var joined = parts.Count == ring.Count + 1 ? Brep.JoinBreps(parts, tol) : null;
        solid = joined != null && joined.Length == 1 && joined[0].IsSolid && joined[0].IsValid ? joined[0] : null;
    }
    if (solid == null) { defFailed[i] = "BLOCK_GEOMETRY"; continue; }
    if (solid.SolidOrientation == BrepSolidOrientation.Inward) solid.Flip();
    var geometryAttributes = new Rhino.DocObjects.ObjectAttributes { LayerIndex = LayerOf(layerPath + "::" + defTypes[i]) };
    var added = doc.InstanceDefinitions.Add(name, owner, Point3d.Origin, new GeometryBase[] { solid }, new[] { geometryAttributes });
    if (added < 0) { defFailed[i] = "BLOCK_ADD"; continue; }
    defIndex[i] = added; defsMade.Add(name);
}
string Mm(double m, string format) => (m * 1000).ToString(format, System.Globalization.CultureInfo.InvariantCulture);
var statusWords = new[] { "ok", "boundary", "pole" };
Rhino.DocObjects.ObjectAttributes Attributes(string key, int layer, string name)
{
    var attributes = new Rhino.DocObjects.ObjectAttributes { LayerIndex = layer, Name = name };
    attributes.SetUserString("vide-jig", jigId); attributes.SetUserString("vide-instance", instanceId); attributes.SetUserString("vide-run", runId);
    attributes.SetUserString("vide-bake", bakeId); attributes.SetUserString("vide-key", key);
    foreach (var pair in shared) attributes.SetUserString(pair[0], pair[1]);
    attributes.SetUserString("vide-panel-id", name);
    return attributes;
}
var keys = new System.Collections.Generic.List<string>(); var ids = new System.Collections.Generic.List<string>();
var failed = new System.Collections.Generic.List<string>(); var reasons = new System.Collections.Generic.List<string>();
var nItems = I32();
for (var item = 0; item < nItems; item++)
{
    if ((DateTime.UtcNow - started).TotalMilliseconds > budgetMs) throw new Exception("BAKE_TIMEOUT: 만들기 시간 한도를 넘었습니다");
    var panelId = Str(); var def = I32(); var cls = Str(); var status = I32(); var flatness = F32(); var width = F32(); var height = F32(); var reason = Str();
    var key = keyPrefix + panelId;
    Point3d[] outline = null;
    var xf = Transform.Identity;
    if (def >= 0)
    {
        if (def >= nDefs) throw new Exception("BAKE_DATA: 블록 번호");
        var r = new double[9];
        for (var k = 0; k < 9; k++) r[k] = F32();
        var tx = F32(); var ty = F32(); var tz = F32();
        xf.M00 = r[0]; xf.M01 = r[1]; xf.M02 = r[2]; xf.M03 = (ox + tx) * scale;
        xf.M10 = r[3]; xf.M11 = r[4]; xf.M12 = r[5]; xf.M13 = (oy + ty) * scale;
        xf.M20 = r[6]; xf.M21 = r[7]; xf.M22 = r[8]; xf.M23 = (oz + tz) * scale;
        xf.M30 = 0; xf.M31 = 0; xf.M32 = 0; xf.M33 = 1;
        if (reason == "" && defIndex[def] < 0) reason = defFailed[def];
    }
    else
    {
        var n = I32();
        outline = new Point3d[n];
        for (var k = 0; k < n; k++) outline[k] = Vec();
        if (reason == "") reason = "NO_TYPE";
    }
    if (reason == "")
    {
        var attributes = Attributes(key, LayerOf(layerPath + "::" + defTypes[def]), panelId);
        attributes.SetUserString("vide-panel-type", defTypes[def]);
        attributes.SetUserString("vide-panel-class", cls);
        attributes.SetUserString("vide-panel-size", Mm(width, "0.#") + "×" + Mm(height, "0.#"));
        attributes.SetUserString("vide-flatness-mm", Mm(flatness, "0.0"));
        attributes.SetUserString("vide-status", status >= 0 && status < statusWords.Length ? statusWords[status] : "ok");
        var placed = doc.Objects.AddInstanceObject(defIndex[def], xf, attributes);
        if (placed != Guid.Empty) { keys.Add(key); ids.Add(placed.ToString()); continue; }
        reason = "ADD";
    }
    // A failed panel stays visible: its outline (the type outline where it would have gone) and number.
    if (outline == null)
    {
        outline = new Point3d[defOutlines[def].Length];
        for (var k = 0; k < outline.Length; k++) { var p = defOutlines[def][k]; p.Transform(xf); outline[k] = p; }
    }
    var closed = new System.Collections.Generic.List<Point3d>(outline);
    closed.Add(outline[0]);
    var failLayer = LayerOf(failLayerPath);
    var failAttributes = Attributes(key, failLayer, panelId);
    failAttributes.SetUserString("vide-status", "failed:" + reason);
    var curveId = doc.Objects.AddPolyline(closed, failAttributes);
    failed.Add(key); reasons.Add(reason);
    if (curveId != Guid.Empty) { keys.Add(key); ids.Add(curveId.ToString()); }
    var centre = new Point3d(outline.Average(p => p.X), outline.Average(p => p.Y), outline.Average(p => p.Z));
    var dotAttributes = Attributes(key + ":no", failLayer, panelId);
    dotAttributes.SetUserString("vide-status", "failed:" + reason);
    var dotId = doc.Objects.AddTextDot(panelId, centre, dotAttributes);
    if (dotId != Guid.Empty) { keys.Add(key + ":no"); ids.Add(dotId.ToString()); }
}
// Older definitions of this make (another typing fingerprint) go once no placement uses them.
var purged = 0;
var stale = doc.InstanceDefinitions.Where(d => d != null && !d.IsDeleted && d.Description == owner && !d.Name.EndsWith("-" + hash, StringComparison.Ordinal)).ToList();
foreach (var d in stale)
    if (d.GetReferences(0).Length == 0 && doc.InstanceDefinitions.Delete(d.Index, true, true)) purged++;
return new { removed, keys = keys.ToArray(), ids = ids.ToArray(), failed = failed.ToArray(), reasons = reasons.ToArray(), defs = defsMade.ToArray(), purged, ms = (DateTime.UtcNow - started).TotalMilliseconds };
