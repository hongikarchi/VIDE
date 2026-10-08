// vide.read.curves@1 (ARCH-03 §9.1, SPEC-16.13 3·4, PLAN-49 T-260). A fixed C# method body owned by
// VIDE; the only value from the engine is the data block in the one placeholder below. Reads the
// points and curves a person picked (a tile drawn flat, or attractors): a point as one position, a
// curve as a polyline within the document tolerance (closed ones without the repeated end point),
// with whether all its points lie in one plane parallel to XY. Units: metres out (×toMeters).
// Runs in both wrappers (attached `Run(doc, output)` and worker `Run(doc)`): no `output`, generic
// types written in full. Nothing is added or changed in the document.
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var pos = 0;
int I32() { var v = BitConverter.ToInt32(data, pos); pos += 4; return v; }
string Str() { var n = I32(); if (n < 0 || pos + n > data.Length) throw new Exception("READ_DATA"); var s = System.Text.Encoding.UTF8.GetString(data, pos, n); pos += n; return s; }
if (Str() != "vide.read.curves@1") throw new Exception("READ_TEMPLATE");
var started = DateTime.UtcNow;
var count = I32();
if (count < 1 || count > 200) throw new Exception("CURVE_LIMIT: 점·곡선은 한 번에 1~200개입니다");
if (doc.ModelUnitSystem == UnitSystem.None) throw new Exception("UNKNOWN_UNITS: 문서 단위가 없습니다");
var toM = RhinoMath.UnitScale(doc.ModelUnitSystem, UnitSystem.Meters);
var tol = doc.ModelAbsoluteTolerance;
var items = new System.Collections.Generic.List<object>();
for (var n = 0; n < count; n++)
{
    var text = Str();
    if (!Guid.TryParse(text, out var objectId)) throw new Exception("CURVE_NOT_FOUND: 객체 ID가 아닙니다");
    var obj = doc.Objects.FindId(objectId);
    if (obj == null) throw new Exception("CURVE_NOT_FOUND: 객체를 찾지 못했습니다");
    var geometry = obj.Geometry;
    if (geometry is Rhino.Geometry.Point point)
    {
        var p = point.Location;
        items.Add(new { objectId = text, kind = "point", closed = false, flatXY = true, points = new[] { p.X * toM, p.Y * toM, p.Z * toM } });
        continue;
    }
    var curve = geometry as Curve;
    if (curve == null) throw new Exception("NOT_A_CURVE: 점·곡선이 아닌 객체가 있습니다");
    Polyline polyline;
    if (!curve.TryGetPolyline(out polyline))
    {
        var approx = curve.ToPolyline(tol, doc.ModelAngleToleranceRadians, 0, 0);
        if (approx == null || !approx.TryGetPolyline(out polyline)) throw new Exception("NOT_A_CURVE: 곡선을 꺾은선으로 바꾸지 못했습니다");
    }
    var closed = curve.IsClosed;
    var pts = new System.Collections.Generic.List<Point3d>(polyline);
    if (closed && pts.Count > 1 && pts[0].DistanceTo(pts[pts.Count - 1]) <= tol) pts.RemoveAt(pts.Count - 1);
    if (pts.Count > 4096) throw new Exception("CURVE_POINT_LIMIT: 곡선 하나의 점이 4,096개를 넘습니다");
    var z0 = pts[0].Z;
    var flat = true;
    foreach (var q in pts) if (Math.Abs(q.Z - z0) > tol) { flat = false; break; }
    var xyz = new double[3 * pts.Count];
    for (var k = 0; k < pts.Count; k++) { xyz[3 * k] = pts[k].X * toM; xyz[3 * k + 1] = pts[k].Y * toM; xyz[3 * k + 2] = pts[k].Z * toM; }
    items.Add(new { objectId = text, kind = "polyline", closed, flatXY = flat, points = xyz });
}
return new
{
    schema = "vide.read.curves@1",
    units = doc.ModelUnitSystem.ToString(), toMeters = toM, absTol = tol * toM,
    items, ms = (DateTime.UtcNow - started).TotalMilliseconds,
};
