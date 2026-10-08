// SPIKE T-259 (PLAN-49, SPEC-16.7 6): accuracy and time of Rhino `Unroller` on panels cut from
// synthetic faces (metres, no project data), run as a hidden Rhino 8 worker body. Nothing is added
// to the document. run-unroll.mjs puts the parameters in front of this text:
//   var FAMILY = "cylinder"|"cone"|"sphere"|"hypar"; var NU = 100; var NV = 50; var TRI = false;
//   var RELTOL = 0.01; (Unroller.RelativeTolerance)
// Faces:
//   cylinder — R 8 m, 120°, 6 m high (rational arc extruded): single curved, developable
//   cone     — revolved line from r 4 m (z 0) to r 2 m (z 6 m), 120°: single curved, developable
//   sphere   — R 5 m, latitude −30°…60°, 120°: double curved (synclastic)
//   hypar    — the T-250 saddle 30 × 20 m (cubic NURBS through 13 × 9 points): double curved
// Panels: an NU × NV grid of parameter cells; with TRI each cell is cut along a diagonal into two
// trimmed triangles (made like the panel-make template's open faces). Per panel: 3D area and edge
// lengths, `Unroller.PerformUnroll` (one face, not exploded), the flat area, edge lengths, z span, and
// how far each flat edge bows away from the straight line between its ends (what a straight-edged cut
// outline would miss).
doc.AdjustModelUnitSystem(UnitSystem.Meters, false);
var tol = doc.ModelAbsoluteTolerance;
Surface surface;
if (FAMILY == "cylinder")
{
    var arc = new ArcCurve(new Arc(new Circle(Plane.WorldXY, 8), new Interval(0, 2 * Math.PI / 3)));
    surface = Surface.CreateExtrusion(arc.ToNurbsCurve(), new Vector3d(0, 0, 6)).ToNurbsSurface();
}
else if (FAMILY == "cone")
    surface = RevSurface.Create(new LineCurve(new Point3d(4, 0, 0), new Point3d(2, 0, 6)), new Line(Point3d.Origin, new Point3d(0, 0, 1)), 0, 2 * Math.PI / 3).ToNurbsSurface();
else if (FAMILY == "sphere")
{
    var meridian = new Circle(new Plane(Point3d.Origin, Vector3d.XAxis, Vector3d.ZAxis), 5);
    surface = RevSurface.Create(new ArcCurve(new Arc(meridian, new Interval(-Math.PI / 6, Math.PI / 3))), new Line(Point3d.Origin, new Point3d(0, 0, 1)), 0, 2 * Math.PI / 3).ToNurbsSurface();
}
else
{
    var pts = new System.Collections.Generic.List<Point3d>();
    for (var i = 0; i < 13; i++) for (var j = 0; j < 9; j++) { double x = 30.0 * i / 12, y = 20.0 * j / 8; pts.Add(new Point3d(x, y, (x - 15) * (x - 15) / 60 - (y - 10) * (y - 10) / 40 + 5)); }
    surface = NurbsSurface.CreateThroughPoints(pts, 13, 9, 3, 3, false, false);
}
if (surface == null) throw new Exception("surface " + FAMILY);

// One open face from a UV polygon (as the panel-make template does).
Brep PanelFace(Surface basis, Point2d[] uv)
{
    var umin = uv.Min(q => q.X); var umax = uv.Max(q => q.X); var vmin = uv.Min(q => q.Y); var vmax = uv.Max(q => q.Y);
    var sub = basis.Trim(new Interval(umin, umax), new Interval(vmin, vmax));
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
    if (!made.IsValid) made.Repair(tol);
    return made.IsValid ? made : null;
}

var du = surface.Domain(0); var dv = surface.Domain(1);
var panels = new System.Collections.Generic.List<Brep>();
var started = DateTime.UtcNow;
for (var i = 0; i < NU; i++)
    for (var j = 0; j < NV; j++)
    {
        double ua = du.ParameterAt((double)i / NU), ub = du.ParameterAt((double)(i + 1) / NU);
        double va = dv.ParameterAt((double)j / NV), vb = dv.ParameterAt((double)(j + 1) / NV);
        if (!TRI) { panels.Add(surface.Trim(new Interval(ua, ub), new Interval(va, vb)).ToBrep()); continue; }
        panels.Add(PanelFace(surface, new[] { new Point2d(ua, va), new Point2d(ub, va), new Point2d(ub, vb) }));
        panels.Add(PanelFace(surface, new[] { new Point2d(ua, va), new Point2d(ub, vb), new Point2d(ua, vb) }));
    }
var buildMs = (DateTime.UtcNow - started).TotalMilliseconds;

int ok = 0, failed = 0, edgeMismatch = 0;
double areaRelMax = 0, edgeErrMax = 0, zSpanMax = 0, bowMax = 0, bowSum = 0, area3Sum = 0, areaFlatSum = 0;
var errors = new System.Collections.Generic.List<string>();
started = DateTime.UtcNow;
foreach (var b in panels)
{
    if (b == null) { failed++; if (errors.Count < 5) errors.Add("panel build"); continue; }
    var a3 = AreaMassProperties.Compute(b).Area;
    var un = new Unroller(b) { ExplodeOutput = false, AbsoluteTolerance = tol, RelativeTolerance = RELTOL };
    Brep[] flat;
    try { flat = un.PerformUnroll(out _, out _, out _); }
    catch (Exception e) { failed++; if (errors.Count < 5) errors.Add(e.Message); continue; }
    if (flat == null || flat.Length != 1) { failed++; if (errors.Count < 5) errors.Add("unrolled pieces " + (flat?.Length ?? 0)); continue; }
    var f = flat[0];
    var af = AreaMassProperties.Compute(f).Area;
    area3Sum += a3; areaFlatSum += af;
    areaRelMax = Math.Max(areaRelMax, Math.Abs(af - a3) / a3);
    var box = f.GetBoundingBox(true);
    zSpanMax = Math.Max(zSpanMax, box.Max.Z - box.Min.Z);
    if (f.Edges.Count != b.Edges.Count) edgeMismatch++;
    else
    {
        var l3 = b.Edges.Select(e => e.GetLength()).OrderBy(x => x).ToArray();
        var lf = f.Edges.Select(e => e.GetLength()).OrderBy(x => x).ToArray();
        for (var k = 0; k < l3.Length; k++) edgeErrMax = Math.Max(edgeErrMax, Math.Abs(l3[k] - lf[k]));
    }
    double bow = 0;
    foreach (var e in f.Edges)
    {
        var chord = new Line(e.PointAtStart, e.PointAtEnd);
        for (var k = 1; k < 8; k++) bow = Math.Max(bow, chord.DistanceTo(e.PointAt(e.Domain.ParameterAt(k / 8.0)), true));
    }
    bowMax = Math.Max(bowMax, bow); bowSum += bow;
    ok++;
}
var ms = (DateTime.UtcNow - started).TotalMilliseconds;
return new System.Collections.Generic.Dictionary<string, object>
{
    ["family"] = FAMILY, ["tri"] = TRI, ["relTol"] = RELTOL, ["panels"] = panels.Count, ["ok"] = ok, ["failed"] = failed,
    ["edgeCountMismatch"] = edgeMismatch, ["buildMs"] = Math.Round(buildMs), ["unrollMs"] = Math.Round(ms),
    ["msPerPanel"] = Math.Round(ms / Math.Max(1, panels.Count), 2),
    ["areaRelErrMax"] = areaRelMax, ["areaSum3"] = area3Sum, ["areaSumFlat"] = areaFlatSum,
    ["edgeErrMaxMm"] = edgeErrMax * 1000, ["zSpanMaxMm"] = zSpanMax * 1000,
    ["bowMaxMm"] = bowMax * 1000, ["bowMeanMm"] = ok > 0 ? bowSum / ok * 1000 : 0,
    ["errors"] = errors.ToArray(), ["rhino"] = RhinoApp.Version.ToString(),
};
