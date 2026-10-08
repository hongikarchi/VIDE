// SPIKE (T-250) vide.bake.panels-uv@1 — panels given as UV polygons on one face are cut out of the
// ORIGINAL face by Rhino (not from the engine's interpolated sample): kind 0 an open trimmed face
// per panel, kind 1 a closed member (CreateOffsetBrep, solid) per panel. Before anything is made the
// face fingerprint is recomputed with face-hash.cs; a different value refuses the whole body
// (nothing made, no undo record). A UV past the end of a closed direction (by at most one period)
// is made on a copy of the face whose seam is moved to the panel (Brep.ChangeSeam). A panel whose
// corner is outside the trim, or whose result is not valid / not one closed solid, comes back in
// failed[] with its reason. A time budget (ms) makes the body throw, so the attached run undoes
// everything it made. Returns the made keys and ids, failed[] and the actual corner points (m) for
// the engine to compare with its interpolation.
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var pos = 0;
int I32() { var v = BitConverter.ToInt32(data, pos); pos += 4; return v; }
double F64() { var v = BitConverter.ToDouble(data, pos); pos += 8; return v; }
string Str() { var n = I32(); if (n < 0 || pos + n > data.Length) throw new Exception("BAKE_DATA"); var s = System.Text.Encoding.UTF8.GetString(data, pos, n); pos += n; return s; }
if (Str() != "vide.bake.panels-uv@1") throw new Exception("BAKE_TEMPLATE");
var started = DateTime.UtcNow;
var objectId = Guid.Parse(Str());
var faceIndex = I32();
var expected = Str();
var kind = I32();
var thickness = F64();
var budgetMs = F64();
var layerPath = Str();
if (doc.ModelUnitSystem == UnitSystem.None) throw new Exception("UNKNOWN_UNITS");
var scale = RhinoMath.UnitScale(UnitSystem.Meters, doc.ModelUnitSystem);
var toM = 1 / scale;
var tol = doc.ModelAbsoluteTolerance;
var obj = doc.Objects.FindId(objectId);
Brep brep = obj?.Geometry as Brep;
if (brep == null && obj?.Geometry is Extrusion extrusion) brep = extrusion.ToBrep();
if (brep == null && obj?.Geometry is Surface surface) brep = surface.ToBrep();
if (brep == null || faceIndex < 0 || faceIndex >= brep.Faces.Count) return new { rejected = "FACE_NOT_FOUND" };
var face = brep.Faces[faceIndex];

//@include face-hash.cs

if (FaceHash(face) != expected) return new { rejected = "SURFACE_CHANGED" };

var layerNames = layerPath.Split(new[] { "::" }, StringSplitOptions.None);
int LayerOf(string[] names)
{
    var index = -1; var parent = Guid.Empty;
    foreach (var name in names)
    {
        var level = doc.Layers.FirstOrDefault(l => !l.IsDeleted && l.ParentLayerId == parent && string.Equals(l.Name, name, StringComparison.OrdinalIgnoreCase));
        index = level != null ? level.Index : doc.Layers.Add(new Rhino.DocObjects.Layer { Name = name, ParentLayerId = parent, IsVisible = true, IsLocked = false });
        if (index < 0) throw new Exception("BAKE_LAYER_ADD");
        parent = doc.Layers[index].Id;
    }
    return index;
}
var layerIndex = LayerOf(layerNames);

var srf = face.UnderlyingSurface();
var du = face.Domain(0); var dv = face.Domain(1);
var closedU = srf.IsClosed(0); var closedV = srf.IsClosed(1);
// Seam-moved copies by (direction, seam parameter), made once per seam position.
var seamCache = new System.Collections.Generic.Dictionary<string, Surface>();
var seamDomains = new System.Collections.Generic.List<double[]>();
string invalidLog = null;
Surface SeamMoved(int direction, double at)
{
    var key = direction + ":" + at.ToString("R");
    if (seamCache.TryGetValue(key, out var cached)) return cached;
    var moved = Brep.ChangeSeam(face, direction, at, tol);
    var result = moved?.Faces[0].UnderlyingSurface();
    seamCache[key] = result;
    if (result != null) seamDomains.Add(new[] { direction, at, result.Domain(direction).T0, result.Domain(direction).T1 });
    return result;
}

// One open face from a UV polygon on `basis` (corners counter-clockwise in UV after the fix below).
Brep PanelFace(Surface basis, Point2d[] uv)
{
    uv = (Point2d[])uv.Clone();
    double area2 = 0;
    for (var k = 0; k < uv.Length; k++) { var a = uv[k]; var b = uv[(k + 1) % uv.Length]; area2 += a.X * b.Y - b.X * a.Y; }
    if (area2 < 0) Array.Reverse(uv);
    var umin = uv.Min(q => q.X); var umax = uv.Max(q => q.X); var vmin = uv.Min(q => q.Y); var vmax = uv.Max(q => q.Y);
    var bu = basis.Domain(0); var bv = basis.Domain(1);
    var sub = basis.Trim(new Interval(Math.Max(umin, bu.T0), Math.Min(umax, bu.T1)), new Interval(Math.Max(vmin, bv.T0), Math.Min(vmax, bv.T1)));
    if (sub == null) { invalidLog ??= $"TRIM {umin:R}..{umax:R} x {vmin:R}..{vmax:R} on {bu.T0:R}..{bu.T1:R}"; return null; }
    var b3 = new Brep();
    var si = b3.AddSurface(sub);
    var bf = b3.Faces.Add(si);
    var loop = b3.Loops.Add(BrepLoopType.Outer, bf);
    var n = uv.Length;
    for (var k = 0; k < n; k++) b3.Vertices.Add(sub.PointAt(uv[k].X, uv[k].Y), tol);
    for (var k = 0; k < n; k++)
    {
        var c2 = new LineCurve(uv[k], uv[(k + 1) % n]);
        var c3 = sub.Pushup(c2, tol * 0.1);
        if (c3 == null) { invalidLog ??= $"PUSHUP {uv[k]} {uv[(k + 1) % n]}"; return null; }
        var e = b3.Edges.Add(k, (k + 1) % n, b3.AddEdgeCurve(c3), tol);
        var t = b3.Trims.Add(e, false, loop, b3.AddTrimCurve(c2));
        t.TrimType = BrepTrimType.Boundary;
        t.SetTolerances(tol, tol);
    }
    b3.SetTrimIsoFlags();
    if (face.OrientationIsReversed) b3.Flip();
    if (!b3.IsValid) b3.Repair(tol);
    if (!b3.IsValid && invalidLog == null) { b3.IsValidWithLog(out var why); invalidLog = why.Length > 400 ? why[..400] : why; }
    return b3.IsValid ? b3 : null;
}

var keys = new System.Collections.Generic.List<string>(); var ids = new System.Collections.Generic.List<string>();
var failed = new System.Collections.Generic.List<string>();
var corners = new System.Collections.Generic.List<double>();
var nItems = I32();
for (var item = 0; item < nItems; item++)
{
    if ((DateTime.UtcNow - started).TotalMilliseconds > budgetMs) throw new Exception("BAKE_TIMEOUT: 만들기 시간 한도를 넘었습니다");
    var key = Str();
    var n = I32();
    var uv = new Point2d[n];
    for (var k = 0; k < n; k++) uv[k] = new Point2d(F64(), F64());
    // Past the end of a closed direction: move the seam to the panel's lower edge.
    var basis = srf; var reason = "";
    // The seam goes opposite the panel's middle: Rhino places it near, not exactly at, the given
    // parameter (measured: 4 cm off on a rational circle), so it must stay far from every corner.
    double Opposite(double low, double high, Interval d) { var at = (low + high) / 2 - d.Length / 2; return at < d.T0 ? at + d.Length : at; }
    if (closedU && uv.Any(q => q.X > du.T1 + 1e-12)) basis = SeamMoved(0, Opposite(uv.Min(q => q.X), uv.Max(q => q.X), du));
    if (basis != null && closedV && uv.Any(q => q.Y > dv.T1 + 1e-12)) basis = SeamMoved(1, Opposite(uv.Min(q => q.Y), uv.Max(q => q.Y), dv));
    if (basis == null) reason = "SEAM";
    // ChangeSeam keeps the shape but not the parameters (a rational circle is re-parameterised):
    // map each corner to the moved surface through its 3D point (the seam is far away).
    var made3 = uv;
    if (reason == "" && !ReferenceEquals(basis, srf))
    {
        made3 = new Point2d[n];
        for (var k = 0; k < n; k++)
        {
            var qu = closedU && uv[k].X > du.T1 ? uv[k].X - du.Length : uv[k].X; var qv = closedV && uv[k].Y > dv.T1 ? uv[k].Y - dv.Length : uv[k].Y;
            if (!basis.ClosestPoint(srf.PointAt(qu, qv), out var mu, out var mv)) { reason = "SEAM"; break; }
            made3[k] = new Point2d(mu, mv);
        }
    }
    // Corners must be inside the trim (wrapped back into the face domain for the test).
    if (reason == "")
        foreach (var q in uv)
        {
            var qu = closedU && q.X > du.T1 ? q.X - du.Length : q.X; var qv = closedV && q.Y > dv.T1 ? q.Y - dv.Length : q.Y;
            if (face.IsPointOnFace(qu, qv, tol) == PointFaceRelation.Exterior) { reason = "UV_OUTSIDE_TRIM"; break; }
        }
    Brep made = null;
    if (reason == "")
    {
        made = PanelFace(basis, made3);
        if (made == null) reason = "FACE_INVALID";
    }
    if (reason == "" && kind == 1)
    {
        var solids = Brep.CreateOffsetBrep(made, thickness * scale, true, false, tol, out _, out _);
        made = solids != null && solids.Length == 1 && solids[0].IsSolid && solids[0].IsValid ? solids[0] : null;
        if (made == null) reason = "NOT_CLOSED";
        else if (made.SolidOrientation == BrepSolidOrientation.Inward) made.Flip();
    }
    if (reason != "") { failed.Add(key + ":" + reason); continue; }
    var attributes = new Rhino.DocObjects.ObjectAttributes { LayerIndex = layerIndex, Name = key };
    attributes.SetUserString("vide-key", key);
    var id = doc.Objects.AddBrep(made, attributes);
    if (id == Guid.Empty) { failed.Add(key + ":ADD"); continue; }
    keys.Add(key); ids.Add(id.ToString());
    foreach (var q in made3) { var p = basis.PointAt(q.X, q.Y); corners.Add(p.X * toM); corners.Add(p.Y * toM); corners.Add(p.Z * toM); }
}
return new { keys = keys.ToArray(), ids = ids.ToArray(), failed = failed.ToArray(), corners = corners.ToArray(), seams = seamDomains, invalidLog, ms = (DateTime.UtcNow - started).TotalMilliseconds };
