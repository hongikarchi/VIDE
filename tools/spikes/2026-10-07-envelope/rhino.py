#! python3
# T-204 spike, inside a hidden Rhino 8 started by rhino.mjs. Reads rhino-input.json (engine
# envelopes as planar polygon lists and the rule operands), then for every synthetic site:
#   A. engine faces -> planar Breps -> JoinBreps -> MergeCoplanarFaces: IsSolid, IsValid,
#      IsManifold, SolidOrientation, volume against the engine volume, time;
#   B. the same envelopes made by Rhino booleans of the operands (box - setbacks - chamfers - sky
#      exposure pieces): success, IsSolid, volume against A, time;
#   C. the inside-out check: a flipped closed Brep;
#   D. the maximum envelope placed at survey coordinates from f64 origin + f32 differences.
# Only synthetic geometry; the document is saved under VIDE_SPIKE_WORK and nothing else is opened.
import os
import json
import time
import traceback
import Rhino
import Rhino.Geometry as rg

work = os.environ["VIDE_SPIKE_WORK"]
suffix = os.environ.get("VIDE_SPIKE_SUFFIX", "")  # "" or "-stress"
TOL = 0.001
ANG = Rhino.RhinoMath.ToRadians(1.0)
out = {"rhino": str(Rhino.RhinoApp.Version), "tolerance": TOL, "cases": []}


def brep_from_polys(polys):
    """Planar Brep per polygon, joined. Returns (breps, ms)."""
    t = time.perf_counter()
    faces = []
    for loop in polys:
        pts = [rg.Point3d(p[0], p[1], p[2]) for p in loop]
        pts.append(pts[0])
        made = rg.Brep.CreatePlanarBreps(rg.PolylineCurve(pts), TOL)
        if made:
            faces.extend(made)
    joined = rg.Brep.JoinBreps(faces, TOL) or []
    for b in joined:
        b.MergeCoplanarFaces(TOL, ANG)
    return list(joined), (time.perf_counter() - t) * 1000.0, len(faces), len(polys)


def mesh_polys(mesh):
    v = mesh["v"]
    return [[v[i] for i in loop] for loop in mesh["f"]]


def describe(b):
    vmp = rg.VolumeMassProperties.Compute(b, True, False, False, False) if b else None
    return {
        "isSolid": b.IsSolid,
        "isValid": b.IsValid,
        "isManifold": b.IsManifold,
        "orientation": str(b.SolidOrientation),
        "faces": b.Faces.Count,
        "nakedEdges": sum(1 for e in b.Edges if e.Valence == rg.EdgeAdjacency.Naked),
        "volume": vmp.Volume if vmp else None,
    }


def solids_of(polys):
    """Closed pieces of one operand (a union of disjoint capsules joins into several)."""
    made, ms, _, _ = brep_from_polys(polys)
    return made if made and all(b.IsSolid for b in made) else [None]


def boolean_envelope(case, which):
    """Envelope by Rhino booleans of the operand solids. Returns (brep list or None, ms, note)."""
    ops = case["operands"]
    t = time.perf_counter()
    site = [rg.Point3d(p[0], p[1], 0) for p in case["site"]]
    site.append(site[0])
    box = rg.Extrusion.Create(rg.PolylineCurve(site), case["heightCap"], True)
    if box is None:
        return None, 0, "box failed"
    box = box.ToBrep()
    if box.SolidOrientation == rg.BrepSolidOrientation.Inward:
        box.Flip()
    cut2d = [b for s in ops["setbacks"] + ops["chamfers"] + ops["sunWall"] for b in solids_of(s)]
    sun = [b for s in ops["sunWall"] + ops["sunSlope"] for b in solids_of(s)]
    if any(x is None for x in cut2d + sun):
        return None, (time.perf_counter() - t) * 1000.0, "operand join failed"
    t_ops = (time.perf_counter() - t) * 1000.0
    t = time.perf_counter()
    if which == "extrude":
        res = rg.Brep.CreateBooleanDifference([box], cut2d, TOL)
    elif which == "sun":
        res = rg.Brep.CreateBooleanDifference([box], sun, TOL)
    else:
        ext = rg.Brep.CreateBooleanDifference([box], cut2d, TOL)
        res = rg.Brep.CreateBooleanDifference(list(ext), sun, TOL) if ext else None
    return (list(res) if res else None), (time.perf_counter() - t) * 1000.0, "operands %.1f ms" % t_ops


def save():
    """Results so far (a slow large case must not lose the finished ones)."""
    with open(os.path.join(work, "rhino-result%s.json" % suffix), "w") as f:
        json.dump(out, f, indent=1)


def main():
    doc = Rhino.RhinoDoc.ActiveDoc
    doc.ModelUnitSystem = Rhino.UnitSystem.Meters
    doc.ModelAbsoluteTolerance = TOL
    with open(os.path.join(work, "rhino-input%s.json" % suffix)) as f:
        cases = json.load(f)
    layer = {}
    for name in ("engine", "boolean", "survey"):
        item = Rhino.DocObjects.Layer()
        item.Name = "T204-" + name
        layer[name] = doc.Layers.Add(item)
    for case in cases:
        row = {"id": case["id"], "engine": {}, "boolean": {}}
        for which in ("extrude", "sun", "max"):
            out["at"] = "%s %s engine-join %.0f" % (case["id"], which, time.time())
            save()
            made, ms, n_faces, n_polys = brep_from_polys(mesh_polys(case["envelopes"][which]))
            info = {"joinedPieces": len(made), "ms": round(ms, 1), "polygons": n_polys, "planarBreps": n_faces}
            if len(made) == 1:
                info.update(describe(made[0]))
                ev = case["engineVolume"][which]
                info["volumeRelDiff"] = (info["volume"] - ev) / ev if info["volume"] else None
                attr = Rhino.DocObjects.ObjectAttributes()
                attr.LayerIndex = layer["engine"]
                attr.Name = case["id"] + "-" + which
                doc.Objects.AddBrep(made[0], attr)
                if which == "max":
                    flipped = made[0].DuplicateBrep()
                    flipped.Flip()
                    row["flipped"] = describe(flipped)
            row["engine"][which] = info
            out["at"] = "%s %s boolean %.0f" % (case["id"], which, time.time())
            save()
            try:
                res, bms, note = boolean_envelope(case, which)
                b = {"ok": bool(res), "pieces": len(res) if res else 0, "ms": round(bms, 1), "note": note}
                if res and len(res) == 1:
                    b.update(describe(res[0]))
                    ev = case["engineVolume"][which]
                    b["volumeRelDiff"] = (b["volume"] - ev) / ev if b["volume"] else None
                    attr = Rhino.DocObjects.ObjectAttributes()
                    attr.LayerIndex = layer["boolean"]
                    attr.Name = case["id"] + "-" + which + "-boolean"
                    doc.Objects.AddBrep(res[0], attr)
                elif res:
                    b["volumes"] = [describe(x)["volume"] for x in res]
            except Exception as e:
                b = {"ok": False, "error": repr(e)}
            row["boolean"][which] = b
            out["partial"] = row
            save()
        # D. survey coordinates from origin + f32 differences
        s = case.get("survey")
        if not s:
            out["cases"].append(row)
            save()
            continue
        o = s["origin"]
        v = [[o[0] + d[0], o[1] + d[1], o[2] + d[2]] for d in s["delta"]]
        made, ms, _, _ = brep_from_polys([[v[i] for i in loop] for loop in s["f"]])
        sv = {"joinedPieces": len(made), "ms": round(ms, 1)}
        if len(made) == 1:
            sv.update(describe(made[0]))
            sv["volumeRelDiff"] = (sv["volume"] - s["volume"]) / s["volume"] if sv["volume"] else None
            attr = Rhino.DocObjects.ObjectAttributes()
            attr.LayerIndex = layer["survey"]
            attr.Name = case["id"] + "-max-survey"
            doc.Objects.AddBrep(made[0], attr)
        row["survey"] = sv
        out["cases"].append(row)
        save()
    doc.WriteFile(os.path.join(work, "rhino-envelope%s.3dm" % suffix), Rhino.FileIO.FileWriteOptions())
    doc.Modified = False


try:
    main()
except Exception:
    out["error"] = traceback.format_exc()
with open(os.path.join(work, "rhino-result%s.json" % suffix), "w") as f:
    json.dump(out, f, indent=1)
with open(os.path.join(work, "rhino.done"), "w") as f:
    f.write("done")
Rhino.RhinoApp.Exit()
