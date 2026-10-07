#! python3
# T-204 spike, diagnosis inside a hidden Rhino 8 (rhino.mjs <set> diag). For each engine envelope
# of the chosen input, builds the Brep in several ways to find which step breaks the stress cases:
#   join-only     planar Breps joined at 0.001 m, no face merge
#   join+merge    as rhino.py (JoinBreps 0.001 m + MergeCoplanarFaces)
#   fine+merge    JoinBreps at 1e-5 m + MergeCoplanarFaces at 0.001 m
#   fine-only     planar Breps and JoinBreps at 1e-5 m, no face merge (the T-208 recommendation)
#   mesh          one Rhino Mesh from the polygons (centroid fans): IsClosed, Volume
# Only synthetic geometry; nothing is saved.
import os
import json
import time
import traceback
import Rhino
import Rhino.Geometry as rg

work = os.environ["VIDE_SPIKE_WORK"]
suffix = os.environ.get("VIDE_SPIKE_SUFFIX", "")
only = [s for s in os.environ.get("VIDE_SPIKE_ONLY", "").split(",") if s]
ANG = Rhino.RhinoMath.ToRadians(1.0)
out = {"rhino": str(Rhino.RhinoApp.Version), "cases": []}


def save():
    with open(os.path.join(work, "rhino-diag%s.json" % suffix), "w") as f:
        json.dump(out, f, indent=1)


def planar(polys, tol):
    faces, failed = [], 0
    for loop in polys:
        pts = [rg.Point3d(p[0], p[1], p[2]) for p in loop]
        pts.append(pts[0])
        made = rg.Brep.CreatePlanarBreps(rg.PolylineCurve(pts), tol)
        if made:
            faces.extend(made)
        else:
            failed += 1
    return faces, failed


def info(breps, ms, failed):
    r = {"pieces": len(breps), "ms": round(ms, 1), "planarFailed": failed}
    if len(breps) == 1:
        b = breps[0]
        vmp = rg.VolumeMassProperties.Compute(b, True, False, False, False)
        r.update({
            "isSolid": b.IsSolid, "isValid": b.IsValid, "orientation": str(b.SolidOrientation),
            "faces": b.Faces.Count,
            "nakedEdges": sum(1 for e in b.Edges if e.Valence == rg.EdgeAdjacency.Naked),
            "volume": vmp.Volume if vmp else None,
        })
    return r


def variant(polys, join_tol, merge):
    t = time.perf_counter()
    faces, failed = planar(polys, join_tol)
    joined = list(rg.Brep.JoinBreps(faces, join_tol) or [])
    if merge:
        for b in joined:
            b.MergeCoplanarFaces(0.001, ANG)
    return info(joined, (time.perf_counter() - t) * 1000.0, failed)


def mesh_variant(polys):
    t = time.perf_counter()
    m = rg.Mesh()
    for loop in polys:
        c = [sum(p[i] for p in loop) / len(loop) for i in range(3)]
        base = m.Vertices.Count
        for p in loop:
            m.Vertices.Add(p[0], p[1], p[2])
        ci = m.Vertices.Add(c[0], c[1], c[2])
        for i in range(len(loop)):
            m.Faces.AddFace(base + i, base + (i + 1) % len(loop), ci)
    m.Vertices.CombineIdentical(True, True)
    m.Compact()
    return {"isClosed": m.IsClosed, "isValid": m.IsValid, "volume": m.Volume(),
            "ms": round((time.perf_counter() - t) * 1000.0, 1)}


try:
    with open(os.path.join(work, "rhino-input%s.json" % suffix)) as f:
        cases = json.load(f)
    for case in cases:
        if only and case["id"] not in only:
            continue
        row = {"id": case["id"]}
        for which in ("extrude", "sun", "max"):
            m = case["envelopes"][which]
            polys = [[m["v"][i] for i in loop] for loop in m["f"]]
            row[which] = {
                "engineVolume": case["engineVolume"][which],
                "joinOnly": variant(polys, 0.001, False),
                "joinMerge": variant(polys, 0.001, True),
                "fineMerge": variant(polys, 1e-5, True),
                "fineOnly": variant(polys, 1e-5, False),
                "mesh": mesh_variant(polys),
            }
            save()
        out["cases"].append(row)
        save()
except Exception:
    out["error"] = traceback.format_exc()
save()
with open(os.path.join(work, "rhino.done"), "w") as f:
    f.write("done")
Rhino.RhinoDoc.ActiveDoc.Modified = False
Rhino.RhinoApp.Exit()
