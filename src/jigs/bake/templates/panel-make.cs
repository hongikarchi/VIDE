// Shared body of the 패널링 make templates vide.bake.panels-uv@1 and vide.bake.panel-solids@1
// (SPEC-16.9, PLAN-49 T-255, ARCH-03 §9.1). Not a template of its own: `templates.ts` puts this
// text where a template has the line `//@include panel-make.cs`; the template sets `data`,
// `expectedTemplate` and `solid` before it. Panels come as UV outlines on faces of the picked
// object and are cut by Rhino out of the ORIGINAL face (never from the engine's interpolated
// sample). Before anything is made, every listed face's fingerprint is computed again with the
// read template's function (face-hash.cs); a different value makes nothing and returns
// `rejected` (no object, no layer, so no undo record). A UV past the end of a closed direction (by
// at most one period) is made on a copy of the face whose seam lies opposite the panel's middle
// (Brep.ChangeSeam), its corners moved there through their 3D points. A corner outside the trim, an
// invalid face or (members) an offset that is not one valid closed solid fails that panel only: it
// is left on the failure layer as its outline and a number (SPEC-16.9 5), never filled in. A time
// budget makes the body throw, so the attached run undoes the whole body.
var started = DateTime.UtcNow;
var pos = 0;
int I32() { var v = BitConverter.ToInt32(data, pos); pos += 4; return v; }
float F32() { var v = BitConverter.ToSingle(data, pos); pos += 4; return v; }
double F64() { var v = BitConverter.ToDouble(data, pos); pos += 8; return v; }
string Str() { var n = I32(); if (n < 0 || pos + n > data.Length) throw new Exception("BAKE_DATA"); var s = System.Text.Encoding.UTF8.GetString(data, pos, n); pos += n; return s; }
if (Str() != "vide.bake.data/1") throw new Exception("BAKE_FORMAT");
if (Str() != expectedTemplate) throw new Exception("BAKE_TEMPLATE");
var jigId = Str(); var instanceId = Str(); var bakeId = Str(); var runId = Str(); var layerPath = Str();
var ox = F64(); var oy = F64(); var oz = F64();
if (doc.ModelUnitSystem == UnitSystem.None) throw new Exception("UNKNOWN_UNITS: 문서 단위가 없습니다");
var scale = RhinoMath.UnitScale(UnitSystem.Meters, doc.ModelUnitSystem);
var toM = 1 / scale;
var tol = doc.ModelAbsoluteTolerance;
var deleteIds = new System.Collections.Generic.List<string>();
var nDelete = I32();
for (var i = 0; i < nDelete; i++) deleteIds.Add(Str());
// Surface header: the picked object, its faces with the fingerprints they were read with.
var objectId = Guid.Parse(Str());
var faceHashes = new System.Collections.Generic.Dictionary<int, string>();
var nFaceHashes = I32();
for (var i = 0; i < nFaceHashes; i++) { var index = I32(); faceHashes[index] = Str(); }
var keyPrefix = Str(); var offset = F64(); var budgetMs = F64(); var failLayerPath = Str();
var shared = new System.Collections.Generic.List<string[]>();
var nShared = I32();
for (var i = 0; i < nShared; i++) shared.Add(new[] { Str(), Str() });
// Vertex table: each corner once (UV in the face's parameters, the engine's sample point in m).
var nVertices = I32();
var tableUv = new Point2d[nVertices]; var tableExpect = new Point3d[nVertices];
for (var i = 0; i < nVertices; i++)
{
    tableUv[i] = new Point2d(F64(), F64());
    var ex = F32(); var ey = F32(); var ez = F32();
    tableExpect[i] = new Point3d(ox + ex, oy + ey, oz + ez);
}
var none = new string[0];
var source = doc.Objects.FindId(objectId);
Brep brep = source?.Geometry as Brep;
if (brep == null && source?.Geometry is Extrusion extrusion) brep = extrusion.ToBrep();
if (brep == null && source?.Geometry is Surface sourceSurface) brep = sourceSurface.ToBrep();
if (brep == null) return new { removed = 0, keys = none, ids = none, failed = none, rejected = "SURFACE_MISSING" };
foreach (var entry in faceHashes)
    if (entry.Key >= brep.Faces.Count || FaceHash(brep.Faces[entry.Key]) != entry.Value)
        return new { removed = 0, keys = none, ids = none, failed = none, rejected = "SURFACE_CHANGED" };
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
// The failure layer (layerRoot::실패), walked the same way, made only when a panel fails.
var failLayerIndex = -1;
int FailLayer()
{
    if (failLayerIndex >= 0) return failLayerIndex;
    var names = failLayerPath.Split(new[] { "::" }, StringSplitOptions.None);
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
    failLayerIndex = index;
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
// Seam-moved copies by (face, direction, seam parameter), made once per seam position.
var seamCache = new System.Collections.Generic.Dictionary<string, Surface>();
Surface SeamMoved(BrepFace face, int faceIndex, int direction, double at)
{
    var cacheKey = faceIndex + ":" + direction + ":" + at.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
    if (seamCache.TryGetValue(cacheKey, out var cached)) return cached;
    var moved = Brep.ChangeSeam(face, direction, at, tol);
    var result = moved?.Faces[0].UnderlyingSurface();
    seamCache[cacheKey] = result;
    return result;
}
// One open face from a UV polygon on `basis`, oriented like the original face.
Brep PanelFace(BrepFace face, Surface basis, Point2d[] uv)
{
    uv = (Point2d[])uv.Clone();
    double area2 = 0;
    for (var k = 0; k < uv.Length; k++) { var a = uv[k]; var b = uv[(k + 1) % uv.Length]; area2 += a.X * b.Y - b.X * a.Y; }
    if (Math.Abs(area2) < 1e-24) return null;
    if (area2 < 0) Array.Reverse(uv);
    var umin = uv.Min(q => q.X); var umax = uv.Max(q => q.X); var vmin = uv.Min(q => q.Y); var vmax = uv.Max(q => q.Y);
    var bu = basis.Domain(0); var bv = basis.Domain(1);
    var sub = basis.Trim(new Interval(Math.Max(umin, bu.T0), Math.Min(umax, bu.T1)), new Interval(Math.Max(vmin, bv.T0), Math.Min(vmax, bv.T1)));
    if (sub == null) return null;
    var made = new Brep();
    var surfaceIndex = made.AddSurface(sub);
    var madeFace = made.Faces.Add(surfaceIndex);
    var loop = made.Loops.Add(BrepLoopType.Outer, madeFace);
    var n = uv.Length;
    for (var k = 0; k < n; k++) made.Vertices.Add(sub.PointAt(uv[k].X, uv[k].Y), tol);
    for (var k = 0; k < n; k++)
    {
        var c2 = new LineCurve(uv[k], uv[(k + 1) % n]);
        var c3 = sub.Pushup(c2, tol * 0.1);
        if (c3 == null) return null;
        var edge = made.Edges.Add(k, (k + 1) % n, made.AddEdgeCurve(c3), tol);
        var trim = made.Trims.Add(edge, false, loop, made.AddTrimCurve(c2));
        trim.TrimType = BrepTrimType.Boundary;
        trim.SetTolerances(tol, tol);
    }
    made.SetTrimIsoFlags();
    if (face.OrientationIsReversed) made.Flip();
    if (!made.IsValid) made.Repair(tol);
    return made.IsValid ? made : null;
}
var faceBreps = new System.Collections.Generic.Dictionary<int, Brep>();
var snapLimit = Math.Max(tol * 10, 0.01 * scale);
var keys = new System.Collections.Generic.List<string>(); var ids = new System.Collections.Generic.List<string>();
var failed = new System.Collections.Generic.List<string>(); var reasons = new System.Collections.Generic.List<string>();
var dev = new System.Collections.Generic.List<double>();
var nItems = I32();
for (var item = 0; item < nItems; item++)
{
    if ((DateTime.UtcNow - started).TotalMilliseconds > budgetMs) throw new Exception("BAKE_TIMEOUT: 만들기 시간 한도를 넘었습니다");
    var panelId = Str(); var faceIndex = I32(); var status = I32(); var width = F32(); var height = F32(); var reason = Str();
    var key = keyPrefix + panelId;
    var n = I32();
    var uv = new Point2d[n]; var expect = new Point3d[n];
    for (var k = 0; k < n; k++)
    {
        var vertex = I32();
        if (vertex < 0 || vertex >= nVertices) throw new Exception("BAKE_DATA: 꼭짓점 번호");
        uv[k] = tableUv[vertex]; expect[k] = tableExpect[vertex];
    }
    var given = (Point2d[])uv.Clone();
    if (!faceHashes.ContainsKey(faceIndex)) throw new Exception("BAKE_DATA: 머리에 없는 면");
    var face = brep.Faces[faceIndex];
    var srf = face.UnderlyingSurface();
    var du = face.Domain(0); var dv = face.Domain(1);
    var closedU = srf.IsClosed(0); var closedV = srf.IsClosed(1);
    Point2d Wrapped(Point2d q) => new Point2d(
        closedU && q.X > du.T1 ? q.X - du.Length : closedU && q.X < du.T0 ? q.X + du.Length : q.X,
        closedV && q.Y > dv.T1 ? q.Y - dv.Length : closedV && q.Y < dv.T0 ? q.Y + dv.Length : q.Y);
    // Past the end of a closed direction: the seam goes opposite the panel's middle (Rhino places it
    // near, not exactly at, the given parameter, so it must stay far from every corner).
    var basis = srf;
    double Opposite(double low, double high, Interval d) { var at = (low + high) / 2 - d.Length / 2; return at < d.T0 ? at + d.Length : at; }
    if (reason == "" && closedU && uv.Any(q => q.X > du.T1 + 1e-12 || q.X < du.T0 - 1e-12)) basis = SeamMoved(face, faceIndex, 0, Opposite(uv.Min(q => q.X), uv.Max(q => q.X), du));
    if (reason == "" && basis != null && closedV && uv.Any(q => q.Y > dv.T1 + 1e-12 || q.Y < dv.T0 - 1e-12)) basis = SeamMoved(face, faceIndex, 1, Opposite(uv.Min(q => q.Y), uv.Max(q => q.Y), dv));
    if (basis == null) { reason = "SEAM"; basis = srf; }
    // ChangeSeam keeps the shape but not the parameters: corners move to it through their 3D points.
    var on = uv;
    if (reason == "" && !ReferenceEquals(basis, srf))
    {
        on = new Point2d[n];
        for (var k = 0; k < n; k++)
        {
            var w = Wrapped(uv[k]);
            if (!basis.ClosestPoint(srf.PointAt(w.X, w.Y), out var mu, out var mv)) { reason = "SEAM"; break; }
            on[k] = new Point2d(mu, mv);
        }
    }
    // Corners must be inside the trim. The read sends each trim loop as 64 points (T-251), so a
    // corner the layout put on a loop can lie a few mm off the real trim: within snapLimit it moves
    // to the nearest point of the trimmed face (its edge); farther out the panel fails.
    if (reason == "")
        for (var k = 0; k < n; k++)
        {
            var w = Wrapped(uv[k]);
            if (face.IsPointOnFace(w.X, w.Y, tol) != PointFaceRelation.Exterior) continue;
            var outside = srf.PointAt(w.X, w.Y);
            if (!faceBreps.TryGetValue(faceIndex, out var faceBrep)) { faceBrep = face.DuplicateFace(false); faceBreps[faceIndex] = faceBrep; }
            var edge = faceBrep.ClosestPoint(outside);
            if (!ReferenceEquals(basis, srf) || outside.DistanceTo(edge) > snapLimit || !srf.ClosestPoint(edge, out var su, out var sv)) { reason = "UV_OUTSIDE_TRIM"; break; }
            uv[k] = new Point2d(su, sv);
        }
    Brep made = null;
    if (reason == "")
    {
        made = PanelFace(face, basis, on);
        if (made == null) reason = "FACE_INVALID";
    }
    if (reason == "" && solid)
    {
        var solids = Brep.CreateOffsetBrep(made, offset * scale, true, false, tol, out _, out _);
        made = solids != null && solids.Length == 1 && solids[0].IsSolid && solids[0].IsValid ? solids[0] : null;
        if (made == null) reason = "NOT_CLOSED";
        else if (made.SolidOrientation == BrepSolidOrientation.Inward) made.Flip();
    }
    var added = Guid.Empty;
    if (reason == "")
    {
        // The original face against the engine's interpolated sample at the same parameters
        // (SPEC-16.9 7; a corner moved onto the trim is compared where the engine put it).
        double deviation = 0;
        for (var k = 0; k < n; k++)
        {
            var at = Wrapped(given[k]);
            var p = srf.PointAt(at.X, at.Y);
            deviation = Math.Max(deviation, new Point3d(p.X * toM, p.Y * toM, p.Z * toM).DistanceTo(expect[k]));
        }
        var attributes = Attributes(key, layerIndex, panelId);
        attributes.SetUserString("vide-panel-size", Mm(width, "0.#") + "×" + Mm(height, "0.#"));
        attributes.SetUserString("vide-status", status >= 0 && status < statusWords.Length ? statusWords[status] : "ok");
        attributes.SetUserString("vide-deviation-mm", Mm(deviation, "0.0"));
        added = doc.Objects.AddBrep(made, attributes);
        if (added != Guid.Empty) { keys.Add(key); ids.Add(added.ToString()); dev.Add(deviation); continue; }
        reason = "ADD";
    }
    // A failed panel stays visible: its outline on the original surface and its number.
    var outline = new System.Collections.Generic.List<Point3d>();
    for (var k = 0; k < n; k++)
        for (var s = 0; s < 8; s++)
        {
            var a = uv[k]; var b = uv[(k + 1) % n]; var t = s / 8.0;
            var w = Wrapped(new Point2d(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t));
            outline.Add(srf.PointAt(Math.Min(Math.Max(w.X, du.T0), du.T1), Math.Min(Math.Max(w.Y, dv.T0), dv.T1)));
        }
    outline.Add(outline[0]);
    var failAttributes = Attributes(key, FailLayer(), panelId);
    failAttributes.SetUserString("vide-status", "failed:" + reason);
    var curveId = doc.Objects.AddPolyline(outline, failAttributes);
    failed.Add(key); reasons.Add(reason);
    if (curveId != Guid.Empty) { keys.Add(key); ids.Add(curveId.ToString()); dev.Add(-1); }
    var centre = new Point3d(outline.Take(outline.Count - 1).Average(p => p.X), outline.Take(outline.Count - 1).Average(p => p.Y), outline.Take(outline.Count - 1).Average(p => p.Z));
    var dotAttributes = Attributes(key + ":no", FailLayer(), panelId);
    dotAttributes.SetUserString("vide-status", "failed:" + reason);
    var dotId = doc.Objects.AddTextDot(panelId, centre, dotAttributes);
    if (dotId != Guid.Empty) { keys.Add(key + ":no"); ids.Add(dotId.ToString()); dev.Add(-1); }
}
return new { removed, keys = keys.ToArray(), ids = ids.ToArray(), failed = failed.ToArray(), reasons = reasons.ToArray(), dev = dev.ToArray(), ms = (DateTime.UtcNow - started).TotalMilliseconds };
