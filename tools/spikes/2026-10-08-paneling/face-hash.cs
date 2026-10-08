// Shape fingerprint of one Brep face (SPEC-16.3 2, T-250 ⑥). The read template and the make
// template carry this exact text, so both compute the hash with the same host function: the
// NURBS form of the underlying surface (degrees, knots, control points, weights), the face
// orientation, every trim curve in UV (NURBS form) with its loop type, and the document unit.
// Exact doubles, no rounding: reading the same face twice gives the same value; moving it 1 mm
// (or any edit) gives another.
string FaceHash(BrepFace hashFace)
{
    var bytes = new System.Collections.Generic.List<byte>();
    void HD(double d) { bytes.AddRange(BitConverter.GetBytes(d)); }
    void HI(int i) { bytes.AddRange(BitConverter.GetBytes(i)); }
    var ns = hashFace.UnderlyingSurface().ToNurbsSurface();
    HI(ns.Degree(0)); HI(ns.Degree(1)); HI(ns.Points.CountU); HI(ns.Points.CountV);
    HI(ns.IsRational ? 1 : 0); HI(hashFace.OrientationIsReversed ? 1 : 0);
    for (var k = 0; k < ns.KnotsU.Count; k++) HD(ns.KnotsU[k]);
    for (var k = 0; k < ns.KnotsV.Count; k++) HD(ns.KnotsV[k]);
    for (var a = 0; a < ns.Points.CountU; a++)
        for (var b = 0; b < ns.Points.CountV; b++)
        {
            var cp = ns.Points.GetControlPoint(a, b);
            HD(cp.Location.X); HD(cp.Location.Y); HD(cp.Location.Z); HD(cp.Weight);
        }
    foreach (var loop in hashFace.Loops)
    {
        HI((int)loop.LoopType); HI(loop.Trims.Count);
        foreach (var trim in loop.Trims)
        {
            var nc = trim.ToNurbsCurve();
            HI(nc.Degree); HI(nc.Points.Count);
            for (var k = 0; k < nc.Knots.Count; k++) HD(nc.Knots[k]);
            for (var k = 0; k < nc.Points.Count; k++) { var p = nc.Points[k]; HD(p.Location.X); HD(p.Location.Y); HD(p.Weight); }
        }
    }
    HD(RhinoMath.UnitScale(doc.ModelUnitSystem, UnitSystem.Meters));
    return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes.ToArray())).ToLowerInvariant();
}
