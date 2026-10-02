# Rhino know-how

## Where code runs
- `execute` `code` is the body of `object Run(RhinoDoc doc)` with `using System; System.Linq; Rhino; Rhino.Geometry`. Use full names for other namespaces (`Rhino.DocObjects`, `Rhino.Render`). Inside C#, commands, `RhinoApp`, file I/O, UI and reflection are rejected.
- In Auto mode on an open Rhino document, `execute` also takes `command` (a Rhino command macro) or `python` (a Rhino 8 Python 3 script); a working copy takes C# only. Each call is one undo step, whatever the form. Pick the form:
  - `command` when a built-in command already does the job (`_-SelDup _Enter`, `_SelLayer "A" _Enter _Join`, `_MergeAllFaces`, `_-Purge`). Dash forms, English names with `_`, every prompt answered, end with `_Enter`; start each command on its own line. `New`, `Close` and `Undo` pass only as options right after the command that owns them (`_-Layer _New`, `_Polyline … _Undo … _Close`); `Redo` and `Insert` are always refused. Save/export/print and purge wait on the user's confirmation; open, import, close, quit, scripts from disk, options, plug-ins, units and undo are refused.
  - `python` for loops and logic that read better in Python, with `rhinoscriptsyntax` and `scriptcontext.doc`. No files, network, processes, `os`/`sys`, `rs.Command`, saving the document, `getattr`/`__builtins__` or undo.
  - `code` (C#) for exact geometry work, in-place `Replace`, attribute edits and anything that must return a checked value.
- Return a small object from `Run` (counts, ids, lengths, areas, problems): it is how you check the result.
- The target is a working copy; the user's file changes only when the user applies the candidate. Never say the file was changed, saved or exported.
- A working copy made by VIDE import is in meters: never change `ModelUnitSystem`. An editing copy of the user's file keeps that file's units: read `units` from `query` and convert. Use `doc.ModelAbsoluteTolerance`. Angles are radians (`ModelAngleToleranceRadians`).
- A working copy has no selection: act on the ids and layers the goal names or `query` returns.
- Identity is the `vide-id` user string. Edit in place with `doc.Objects.Replace(id, geometry)` so the id, layer and attributes stay. If new objects copy a donor's attributes (`Attributes.Duplicate()`), call `DeleteUserString("vide-id")` on the copy: a repeated id fails the whole run with `INVALID_GEOMETRY`. Every object must be `IsValid`. Protected objects must stay unchanged.
- Diagnose read-only first (return counts), then apply. Before deleting many objects, or when the data does not settle the scope, ask with a question card.

## Duplicate curves (beyond SelDup)
- SelDup misses curves on the same path stored as different types (LineCurve, ArcCurve, NurbsCurve, PolylineCurve). Compare by geometry, not by type.
- Find candidates by bounding boxes with a small margin. Test containment: sample about 20 points on the shorter curve; each must be within tolerance of the longer one by `ClosestPoint` (clamped to its domain, so an overhang correctly fails).
- Never use `Curve.GetDistancesBetweenCurves` max distance to decide containment. It reports 0 for a partial overlap where both curves stick out, and deleting on that leaves holes.
- An exact duplicate is mutual containment with equal length. Keep native Line or Arc over NURBS.
- Collinear overlaps: project the curves to 1-D intervals on their line. Split at every overlap boundary and keep one copy of each piece (`[0-10]+[5-15]` becomes `[0-5]+[5-10]+[10-15]`). Delete a fragment that lies fully inside a longer curve, and keep the long curve whole. Keep curves that only touch end to end. Never delete a fragment whose only cover is also being deleted.
- Curved partial overlaps: leave them and report them.
- If none are found, check nearest-neighbour distances: a small nonzero band means drift far from the origin; raise the tolerance and say so.

## T-junctions
- A T-junction is an endpoint of one curve within tolerance of the interior of another curve, not at that curve's own ends. Prefilter by bounding box. Report them. Split with `Curve.Split(t)` and join again only when asked.

## Duplicate solids, meshes and blocks
- Compare a cheap fingerprint: kind, face/edge/vertex counts and bounding-box size and centre. Compare an Extrusion through `ToBrep()`. Compare a mesh by vertex and face counts. Compare a block by definition index and instance transform. Never explode blocks to compare them.
- Same shape in the same place is a duplicate. Same shape in another place is an intentional copy: report it only.
- Mass properties are slow: use volume and centroid only to confirm the few candidates before deleting.

## Curve cleanup (in this order)
1. Simplify: `Curve.Simplify(CurveSimplifyOptions.All, tol, angleRadians)`, then `Replace`.
2. Tidy: fit curves with more than 30 control points to a line, arc, circle or ellipse. Accept a fit only if the deviation is within the fit tolerance and the control-point count drops. Leave real freeform curves alone.
3. Read again, then join: find short curves from a length histogram, and join only clusters that contain a short curve. Never join two long curves just because they meet. Report isolated short curves; do not delete them.
4. Close burst corners: for endpoint gaps where tol < gap ≤ 20×tol, use `Curve.CreateFilletCurves` with radius 0, trim and join. Skip endpoints that already meet.
5. Lines slightly off the X/Y axis: report only (snapping breaks the network).
6. Run the duplicate check again afterwards. New objects take the attributes of the longest donor, without its `vide-id`.

## Solids
- Check `Brep.IsSolid`, and count naked edges (`EdgeAdjacency.Naked`) and their total length. Try `JoinNakedEdges` on a `DuplicateBrep()`. If it closes, it has burst (fix with a tight tolerance or `CapPlanarHoles`); large isolated naked loops are intentionally open.
- A closed brep can become an Extrusion only if it is a right prism: two parallel planar caps and every side normal perpendicular to the sweep. Oblique prisms cannot. Compare volume and centroid before you replace it. Skip breps with more than 400 faces.
- Booleans: check `IsSolid`, orientation and `IsValid`. Treat a null result and an empty result as different failures.

## Document housekeeping
- Purge unused block definitions, empty groups and empty layers, deepest layers first. Skip the current layer and layers that hold block-definition geometry.
- Linetypes, hatch patterns and dimension styles need `_Purge`: in Auto mode send it as a `command` (it waits on the user's confirmation, since purge cannot be undone); in a working copy report them.
- A layer without a material gets a white matte PBR material named after the layer. Create the PBR render content directly (`PhysicallyBasedMaterialType`, base colour white, metallic 0, roughness 1). Not `CreateBasicMaterial` (it drops PBR). Purge before you add materials.

## Preparing exports (the export itself is the user's action)
- Removing by type: check `InstanceReferenceGeometry`, `Point`, `Hatch`, then `AnnotationBase` before `Curve`, since text and dimensions are also curves. Ask which types to remove.
- DWG: flatten to z=0 with `Transform.PlanarProjection(Plane.WorldXY)`, then `ToArcsAndLines(tol, angleTol, 0, 0)`. It can return null: keep the flattened curve then.
- SketchUp has no NURBS or true solids. Report open breps, because they arrive as loose faces. One block per object becomes one component.
- D5: an object has no mapping when `GetTextureChannels()` is empty. Copy an example object's `GetTextureMapping` or use one box mapping of 1 m (1000 in a mm file) on the world origin, the same for every object, then `SetTextureMapping` and `CommitChanges`.
