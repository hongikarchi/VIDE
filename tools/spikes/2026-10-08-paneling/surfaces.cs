// SPIKE (T-250) synthetic reference surfaces (metres, no project data), made in a VIDE-owned hidden
// Rhino 8 worker and saved under .vide/spikes/paneling/:
//   hypar     — double-curved saddle 30 × 20 m, z = (x−15)²/60 − (y−10)²/40 + 5, cubic NURBS through
//               a 13 × 9 point grid, with one trimmed circular hole (R 2.5 m at x 20, y 12)
//   strip     — cylinder strip R 8 m, 120°, 6 m high (extrusion of an arc)
//   cylinder  — closed cylinder R 4 m, 6 m high (seam)
//   sphere    — sphere band R 5 m from −30° latitude up to the pole (one singular side)
//   plane     — flat 20 × 10 m (control)
//   smalltrim — 10 × 10 m plane trimmed to a 0.6 m disk in its middle (no grid corner inside)
//   mesh      — a box mesh (not accepted as a reference face)
doc.AdjustModelUnitSystem(UnitSystem.Meters, false);
var tol = doc.ModelAbsoluteTolerance;
var layer = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "패널링 시험 면" });
var ids = new System.Collections.Generic.Dictionary<string, string>();
void Add(string name, Brep b)
{
    if (b == null || !b.IsValid) throw new Exception("build " + name);
    var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = layer, Name = name };
    ids[name] = doc.Objects.AddBrep(b, a).ToString();
}
Brep CutHole(Brep b, Point3d centre, double r, bool keepDisk)
{
    var circle = new Circle(new Plane(new Point3d(centre.X, centre.Y, 100), Vector3d.ZAxis), r).ToNurbsCurve();
    var projected = Curve.ProjectToBrep(circle, b, -Vector3d.ZAxis, tol);
    if (projected == null || projected.Length != 1) throw new Exception("project");
    var split = b.Faces[0].Split(projected, tol);
    if (split == null || split.Faces.Count != 2) throw new Exception("split");
    var a0 = AreaMassProperties.Compute(split.Faces[0].DuplicateFace(false)).Area;
    var a1 = AreaMassProperties.Compute(split.Faces[1].DuplicateFace(false)).Area;
    var small = a0 < a1 ? 0 : 1;
    if (keepDisk) return split.Faces[small].DuplicateFace(false);
    return split.Faces[1 - small].DuplicateFace(false);
}

var pts = new System.Collections.Generic.List<Point3d>();
for (var i = 0; i < 13; i++)
    for (var j = 0; j < 9; j++)
    {
        double x = 30.0 * i / 12, y = 20.0 * j / 8;
        pts.Add(new Point3d(x, y, (x - 15) * (x - 15) / 60 - (y - 10) * (y - 10) / 40 + 5));
    }
var hypar = NurbsSurface.CreateThroughPoints(pts, 13, 9, 3, 3, false, false);
Add("hypar", CutHole(hypar.ToBrep(), new Point3d(20, 12, 0), 2.5, false));

var arc = new Arc(new Plane(new Point3d(50, 0, 0), Vector3d.ZAxis), 8, 2 * Math.PI / 3);
Add("strip", Surface.CreateExtrusion(new ArcCurve(arc), new Vector3d(0, 0, 6)).ToBrep());

Add("cylinder", new Cylinder(new Circle(new Plane(new Point3d(80, 0, 0), Vector3d.ZAxis), 4), 6).ToBrep(false, false));

var meridian = new Circle(new Plane(new Point3d(110, 0, 0), Vector3d.XAxis, Vector3d.ZAxis), 5);
var profile = new Arc(meridian, new Interval(-Math.PI / 6, Math.PI / 2));
Add("sphere", RevSurface.Create(new ArcCurve(profile), new Line(new Point3d(110, 0, 0), new Point3d(110, 0, 1))).ToBrep());

Add("plane", new PlaneSurface(new Plane(new Point3d(130, 0, 0), Vector3d.ZAxis), new Interval(0, 20), new Interval(0, 10)).ToBrep());

var big = new PlaneSurface(new Plane(new Point3d(160, 0, 0), Vector3d.ZAxis), new Interval(0, 10), new Interval(0, 10)).ToBrep();
Add("smalltrim", CutHole(big, new Point3d(165, 5, 0), 0.3, true));

var meshAttrs = new Rhino.DocObjects.ObjectAttributes { LayerIndex = layer, Name = "mesh" };
ids["mesh"] = doc.Objects.AddMesh(Mesh.CreateFromBox(new BoundingBox(190, 0, 0, 192, 2, 2), 1, 1, 1), meshAttrs).ToString();
return ids;
