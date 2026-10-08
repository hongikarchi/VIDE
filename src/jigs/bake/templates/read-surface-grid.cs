// vide.read.surface-grid@1 (ARCH-03 §9.1, SPEC-16.3, PLAN-49 T-251; prototype T-250
// tools/spikes/2026-10-08-paneling/). A fixed C# method body owned by VIDE; the only value from the
// engine is the data block in the one placeholder below. Reads one face (or every face) of a Brep / Surface /
// Extrusion on an nu × nv grid at equal parameter steps: points, unit normals (after the face
// orientation), signed principal curvatures, inside-trim flags, trim loops in UV, closed / singular
// sides, and the face fingerprint (face-hash.cs). Units: metres out (points ×toMeters, curvature
// ÷toMeters). Index k = j·nu + i (i along U fastest), as `surfaceFaceSampleSchema`.
// Modes: 0 grid, 1 probe points at given UVs (interpolation error), 2 fingerprint only.
// Encoding: 0 JSON number arrays, 1 base64 little-endian float64 blocks.
// Runs in both wrappers (attached `Run(doc, output)` and worker `Run(doc)`): no `output`, generic
// types written in full. Nothing is added or changed in the document.
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var pos = 0;
int I32() { var v = BitConverter.ToInt32(data, pos); pos += 4; return v; }
double F64() { var v = BitConverter.ToDouble(data, pos); pos += 8; return v; }
string Str() { var n = I32(); if (n < 0 || pos + n > data.Length) throw new Exception("READ_DATA"); var s = System.Text.Encoding.UTF8.GetString(data, pos, n); pos += n; return s; }
if (Str() != "vide.read.surface-grid@1") throw new Exception("READ_TEMPLATE");
var started = DateTime.UtcNow;
var mode = I32();
var objectText = Str();
var faceIndex = I32();
var nu = I32(); var nv = I32(); var enc = I32();
var nProbe = I32();
var probes = new double[2 * nProbe];
for (var k = 0; k < probes.Length; k++) probes[k] = F64();
if (nu < 2 || nv < 2 || nu > 512 || nv > 512) throw new Exception("READ_GRID: 표본 격자는 2~512입니다");
if (doc.ModelUnitSystem == UnitSystem.None) throw new Exception("UNKNOWN_UNITS: 문서 단위가 없습니다");
var toM = RhinoMath.UnitScale(doc.ModelUnitSystem, UnitSystem.Meters);
if (!Guid.TryParse(objectText, out var objectId)) throw new Exception("FACE_NOT_FOUND: 객체 ID가 아닙니다");
var obj = doc.Objects.FindId(objectId);
if (obj == null) throw new Exception("FACE_NOT_FOUND: 객체를 찾지 못했습니다");
var geometry = obj.Geometry;
if (geometry is Mesh || geometry is SubD) throw new Exception("MESH_NOT_ACCEPTED: 메쉬 기준 면은 아직 받지 않습니다 · Rhino에서 서피스로 바꾸세요");
Brep brep = geometry as Brep;
if (brep == null && geometry is Extrusion extrusion) brep = extrusion.ToBrep();
if (brep == null && geometry is Surface surface) brep = surface.ToBrep();
if (brep == null) throw new Exception("NOT_A_SURFACE: 서피스·폴리서피스가 아닙니다");
if (faceIndex >= brep.Faces.Count || faceIndex < -1) throw new Exception("FACE_NOT_FOUND: 면 번호가 범위 밖입니다");

//@include face-hash.cs

string Block(double[] values)
{
    var raw = new byte[values.Length * 8];
    Buffer.BlockCopy(values, 0, raw, 0, raw.Length);
    return Convert.ToBase64String(raw);
}

if (mode == 2)
{
    var hashes = new string[brep.Faces.Count];
    for (var f = 0; f < brep.Faces.Count; f++) hashes[f] = FaceHash(brep.Faces[f]);
    return new { schema = "vide.read.surface-grid@1", mode, hashes, ms = (DateTime.UtcNow - started).TotalMilliseconds };
}
if (mode == 1)
{
    var probeFace = brep.Faces[Math.Max(faceIndex, 0)];
    var probeSurface = probeFace.UnderlyingSurface();
    var xyz = new double[3 * nProbe];
    for (var k = 0; k < nProbe; k++)
    {
        var p = probeSurface.PointAt(probes[2 * k], probes[2 * k + 1]);
        xyz[3 * k] = p.X * toM; xyz[3 * k + 1] = p.Y * toM; xyz[3 * k + 2] = p.Z * toM;
    }
    return new { schema = "vide.read.surface-grid@1", mode, points = Block(xyz), ms = (DateTime.UtcNow - started).TotalMilliseconds };
}

var first = faceIndex < 0 ? 0 : faceIndex;
var last = faceIndex < 0 ? brep.Faces.Count - 1 : faceIndex;
if ((long)(last - first + 1) * nu * nv > 65536) throw new Exception("SAMPLE_LIMIT: 표본 점이 65,536개를 넘습니다");
var faces = new System.Collections.Generic.List<object>();
var nonFinite = 0;
for (var f = first; f <= last; f++)
{
    var face = brep.Faces[f];
    var srf = face.UnderlyingSurface();
    var du = face.Domain(0); var dv = face.Domain(1);
    var flip = face.OrientationIsReversed ? -1.0 : 1.0;
    var n = nu * nv;
    var points = new double[3 * n]; var normals = new double[3 * n]; var curvatures = new double[2 * n];
    var inside = new int[n];
    var insideCount = 0;
    var nudgeU = du.Length * 1e-6; var nudgeV = dv.Length * 1e-6;
    for (var j = 0; j < nv; j++)
        for (var i = 0; i < nu; i++)
        {
            var k = j * nu + i;
            var u = du.ParameterAt((double)i / (nu - 1)); var v = dv.ParameterAt((double)j / (nv - 1));
            var p = srf.PointAt(u, v);
            points[3 * k] = p.X * toM; points[3 * k + 1] = p.Y * toM; points[3 * k + 2] = p.Z * toM;
            // A pole or a degenerate edge has no normal at the exact parameter: step a hair inward.
            var c = srf.CurvatureAt(u, v);
            if (c == null || !c.Normal.IsValid || c.Normal.IsTiny())
            {
                var uu = i == 0 ? u + nudgeU : i == nu - 1 ? u - nudgeU : u;
                var vv = j == 0 ? v + nudgeV : j == nv - 1 ? v - nudgeV : v;
                c = srf.CurvatureAt(uu, vv);
            }
            if (c == null || !c.Normal.IsValid) { nonFinite++; normals[3 * k + 2] = 1; }
            else
            {
                var nn = c.Normal; nn.Unitize();
                normals[3 * k] = flip * nn.X; normals[3 * k + 1] = flip * nn.Y; normals[3 * k + 2] = flip * nn.Z;
                // Rhino's kappa is signed against c.Normal; the contract signs it against the oriented
                // normal (+ = centre on the normal side). Sign convention measured in the spike.
                var a = flip * c.Kappa(0) / toM; var b = flip * c.Kappa(1) / toM;
                if (!double.IsFinite(a) || !double.IsFinite(b)) { nonFinite++; a = 0; b = 0; }
                curvatures[2 * k] = Math.Max(a, b); curvatures[2 * k + 1] = Math.Min(a, b);
            }
            var inFace = face.IsPointOnFace(u, v) != PointFaceRelation.Exterior;
            inside[k] = inFace ? 1 : 0;
            if (inFace) insideCount++;
        }
    if (insideCount == 0) throw new Exception("NO_SAMPLE_INSIDE: 트림 안에 든 표본이 없습니다 · 촘촘하게 다시 읽기");
    var loops = new System.Collections.Generic.List<double[][]>();
    if (!face.IsSurface)
        foreach (var loop in face.Loops.OrderBy(l => l.LoopType == BrepLoopType.Outer ? 0 : 1))
        {
            var c2 = loop.To2dCurve();
            var ts = c2.DivideByCount(64, false);
            loops.Add(ts.Select(t => { var q = c2.PointAt(t); return new[] { q.X, q.Y }; }).ToArray());
        }
    faces.Add(new
    {
        faceIndex = f,
        domainU = new[] { du.T0, du.T1 }, domainV = new[] { dv.T0, dv.T1 },
        nu, nv,
        closedU = srf.IsClosed(0), closedV = srf.IsClosed(1),
        // Surface sides: 0 south (v min), 1 east (u max), 2 north (v max), 3 west (u min).
        singular = new { uMin = srf.IsSingular(3), uMax = srf.IsSingular(1), vMin = srf.IsSingular(0), vMax = srf.IsSingular(2) },
        points = enc == 1 ? (object)Block(points) : points,
        normals = enc == 1 ? (object)Block(normals) : normals,
        curvatures = enc == 1 ? (object)Block(curvatures) : curvatures,
        inside,
        trimLoops = loops,
        geometryHash = FaceHash(face),
    });
}
return new
{
    schema = "vide.read.surface-grid@1", mode, enc,
    units = doc.ModelUnitSystem.ToString(), toMeters = toM, absTol = doc.ModelAbsoluteTolerance * toM,
    nonFinite, faces, ms = (DateTime.UtcNow - started).TotalMilliseconds,
};
