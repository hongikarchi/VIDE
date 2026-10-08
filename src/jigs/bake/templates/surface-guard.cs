// Surface guard of the line, mark and block templates (SPEC-16.9 2, ARCH-03 §9.1). Not a template
// of its own: `templates.ts` puts this text where a template has the line
// `//@include surface-guard.cs`, after `face-hash.cs` and right after the template has read its
// delete list. The data carry the picked object and the fingerprint of each face a 패널링 make was
// computed from (an empty object id: no guard, every other jig). A face that differs makes
// nothing: the template returns `rejected` before any layer, delete or object, as the panel
// templates do, so [타입 만들기] after the face moved is refused like [부재 만들기].
var guardId = Str();
var guardFaces = new System.Collections.Generic.Dictionary<int, string>();
var nGuardFaces = I32();
for (var i = 0; i < nGuardFaces; i++) { var guardIndex = I32(); guardFaces[guardIndex] = Str(); }
string GuardRejection()
{
    if (guardId.Length == 0) return null;
    var guardSource = doc.Objects.FindId(Guid.Parse(guardId));
    Brep guardBrep = guardSource?.Geometry as Brep;
    if (guardBrep == null && guardSource?.Geometry is Extrusion guardExtrusion) guardBrep = guardExtrusion.ToBrep();
    if (guardBrep == null && guardSource?.Geometry is Surface guardSurface) guardBrep = guardSurface.ToBrep();
    if (guardBrep == null) return "SURFACE_MISSING";
    foreach (var entry in guardFaces)
        if (entry.Key >= guardBrep.Faces.Count || FaceHash(guardBrep.Faces[entry.Key]) != entry.Value)
            return "SURFACE_CHANGED";
    return null;
}
var guardRejected = GuardRejection();
if (guardRejected != null) return new { removed = 0, keys = new string[0], ids = new string[0], failed = new string[0], rejected = guardRejected };
