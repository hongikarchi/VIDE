#! python3
# T-199 spike: builds a synthetic drawing model in a hidden Rhino 8 started by run.mjs, saves it
# under VIDE_SPIKE_WORK and exports it to DWG once per scheme listed in VIDE_SPIKE_SCHEMES.
# Never opens user files; everything is created here.
import os
import json
import traceback
import System
import Rhino
import Rhino.DocObjects as rdo
from Rhino.Geometry import (Point2d, Point3d, Vector3d, Plane, LineCurve, Circle, ArcCurve, Arc,
                            Polyline, PolylineCurve, Transform, LinearDimension, AngularDimension,
                            RadialDimension, AnnotationType, TextEntity, Hatch)

work = os.environ["VIDE_SPIKE_WORK"]
schemes = [s for s in os.environ.get("VIDE_SPIKE_SCHEMES", "").split("|") if s]
mode = os.environ.get("VIDE_SPIKE_MODE", "full")
log = []
summary = {}


def note(*parts):
    log.append(" ".join(str(p) for p in parts))


def flush_history(label):
    text = Rhino.RhinoApp.CommandHistoryWindowText
    log.append("---- history: " + label + " ----\n" + (text or ""))
    Rhino.RhinoApp.ClearCommandHistoryWindow()


def color(r, g, b):
    return System.Drawing.Color.FromArgb(r, g, b)


def main():
    doc = Rhino.RhinoDoc.ActiveDoc
    doc.ModelUnitSystem = Rhino.UnitSystem.Millimeters
    doc.PageUnitSystem = Rhino.UnitSystem.Millimeters

    # Linetype
    lt = rdo.Linetype()
    lt.Name = "VIDE-DASHED"
    lt.AppendSegment(6.0, True)
    lt.AppendSegment(3.0, False)
    lt_index = doc.Linetypes.Add(lt)

    def layer(name, rgb, plot_weight, linetype=-1):
        item = rdo.Layer()
        item.Name = name
        item.Color = color(*rgb)
        item.PlotWeight = plot_weight
        if linetype >= 0:
            item.LinetypeIndex = linetype
        return doc.Layers.Add(item)

    layers = {
        "A-WALL": layer("A-WALL", (255, 0, 0), 0.5),
        "A-GRID": layer("A-GRID", (0, 0, 255), 0.13, lt_index),
        "A-DIM": layer("A-DIM", (0, 255, 0), 0.18),
        "A-TEXT": layer("A-TEXT", (128, 64, 32), 0.25),
        "A-HATCH": layer("A-HATCH", (128, 128, 128), 0.09),
        "A-BLOCK": layer("A-BLOCK", (255, 0, 255), 0.35),
        "치수-한글": layer("치수-한글", (0, 255, 255), 0.7),
    }

    def attrs(name):
        a = rdo.ObjectAttributes()
        a.LayerIndex = layers[name]
        return a

    # Geometry: a 10 x 6 m room, a slanted wall, a circular column, an arc, a grid line
    rect = PolylineCurve(Polyline([Point3d(0, 0, 0), Point3d(10000, 0, 0), Point3d(10000, 6000, 0),
                                   Point3d(0, 6000, 0), Point3d(0, 0, 0)]))
    doc.Objects.AddCurve(rect, attrs("A-WALL"))
    doc.Objects.AddLine(Point3d(0, 0, 0), Point3d(3000, 4000, 0), attrs("A-WALL"))
    circle = Circle(Point3d(14000, 3000, 0), 1500)
    doc.Objects.AddCircle(circle, attrs("A-WALL"))
    doc.Objects.AddArc(Arc(Point3d(0, 6000, 0), Point3d(2000, 7500, 0), Point3d(4000, 6000, 0)), attrs("A-WALL"))
    doc.Objects.AddLine(Point3d(-1000, 3000, 0), Point3d(17000, 3000, 0), attrs("A-GRID"))
    # A line on the Korean-named layer: unused layers are not exported at all.
    doc.Objects.AddLine(Point3d(-1000, -3000, 0), Point3d(17000, -3000, 0), attrs("치수-한글"))

    # Dimension style (1:100, Arial 2.5, closed filled arrow 2.5) and a text style (Malgun Gothic 3.5)
    def style(name, font, height, arrow, scale):
        index = doc.DimStyles.Add(name)
        ds = doc.DimStyles[index].Duplicate()
        ds.Name = name
        ds.Font = rdo.Font(font)
        ds.TextHeight = height
        ds.ArrowLength = arrow
        ds.ArrowType1 = rdo.DimensionStyle.ArrowType.SolidTriangle
        ds.ArrowType2 = rdo.DimensionStyle.ArrowType.SolidTriangle
        ds.DimensionScale = scale
        ds.LengthResolution = 0
        doc.DimStyles.Modify(ds, index, True)
        return doc.DimStyles[index]

    dim_style = style("VIDE-DIM-100", "Arial", 2.5, 2.5, 100.0)
    text_style = style("VIDE-TEXT-35", "Malgun Gothic", 3.5, 3.0, 100.0)
    tick_style = style("VIDE-DIM-TICK", "Arial", 2.0, 1.5, 100.0)
    t = tick_style.Duplicate()
    t.ArrowType1 = rdo.DimensionStyle.ArrowType.Tick
    t.ArrowType2 = rdo.DimensionStyle.ArrowType.Tick
    doc.DimStyles.Modify(t, tick_style.Index, True)
    tick_style = doc.DimStyles[tick_style.Index]
    doc.DimStyles.SetCurrent(dim_style.Index, True)
    summary["modelSpaceAnnotationScaling"] = doc.ModelSpaceAnnotationScalingEnabled

    plane = Plane.WorldXY
    dims = []
    lin = LinearDimension.Create(AnnotationType.Rotated, dim_style, plane, Vector3d.XAxis,
                                 Point3d(0, 0, 0), Point3d(10000, 0, 0), Point3d(5000, -1500, 0), 0.0)
    dims.append(("linear 10000", doc.Objects.Add(lin, attrs("A-DIM"))))
    lin2 = LinearDimension.Create(AnnotationType.Rotated, tick_style, plane, Vector3d.XAxis,
                                  Point3d(10000, 0, 0), Point3d(10000, 6000, 0), Point3d(11500, 3000, 0), 1.5707963267948966)
    dims.append(("linear tick 6000", doc.Objects.Add(lin2, attrs("A-DIM"))))
    # Aligned: the dimension plane's X axis must run along the measured points, otherwise Rhino
    # measures the horizontal projection (3000) instead of the true length (5000).
    slanted = Plane(Point3d(0, 0, 0), Vector3d(3000, 4000, 0), Vector3d(-4000, 3000, 0))
    ali = LinearDimension.Create(AnnotationType.Aligned, dim_style, slanted, Vector3d(3000, 4000, 0),
                                 Point3d(0, 0, 0), Point3d(3000, 4000, 0), Point3d(800, 2900, 0), 0.0)
    dims.append(("aligned 5000", doc.Objects.Add(ali, attrs("A-DIM"))))
    ang = AngularDimension.Create(dim_style, plane, Vector3d.XAxis, Point3d(0, 0, 0),
                                  Point3d(3000, 0, 0), Point3d(1800, 2400, 0), Point3d(2500, 1200, 0))
    dims.append(("angular 53.13", doc.Objects.Add(ang, attrs("A-DIM"))))
    rad = RadialDimension.Create(dim_style, AnnotationType.Radius, plane, Point3d(14000, 3000, 0),
                                 Point3d(15500, 3000, 0), Point3d(16500, 4000, 0))
    dims.append(("radius 1500", doc.Objects.Add(rad, attrs("A-DIM"))))
    dia = RadialDimension.Create(dim_style, AnnotationType.Diameter, plane, Point3d(14000, 3000, 0),
                                 Point3d(14000, 4500, 0), Point3d(13000, 5500, 0))
    dims.append(("diameter 3000", doc.Objects.Add(dia, attrs("A-DIM"))))
    def shown(oid):
        g = doc.Objects.FindId(oid).Geometry
        return {"value": getattr(g, "NumericValue", None), "text": g.PlainText, "type": g.GetType().Name}
    summary["dims"] = [dict(shown(i), name=n) for n, i in dims]

    # Text with the text style (Latin + Korean)
    te = TextEntity.Create("ROOM 101", Plane(Point3d(4000, 3000, 0), Vector3d.ZAxis), text_style, False, 0, 0)
    doc.Objects.Add(te, attrs("A-TEXT"))
    tk = TextEntity.Create("거실 LIVING", Plane(Point3d(4000, 2000, 0), Vector3d.ZAxis), text_style, False, 0, 0)
    doc.Objects.Add(tk, attrs("A-TEXT"))

    # Embedded block
    geo = [LineCurve(Point3d(-300, -300, 0), Point3d(300, 300, 0)),
           LineCurve(Point3d(-300, 300, 0), Point3d(300, -300, 0)),
           PolylineCurve(Polyline([Point3d(-300, -300, 0), Point3d(300, -300, 0), Point3d(300, 300, 0),
                                   Point3d(-300, 300, 0), Point3d(-300, -300, 0)]))]
    block_attrs = [attrs("A-BLOCK") for _ in geo]
    idef = doc.InstanceDefinitions.Add("VIDE-COLUMN", "synthetic column", Point3d.Origin, geo, block_attrs)
    for x in (0, 10000):
        for y in (0, 6000):
            doc.Objects.AddInstanceObject(idef, Transform.Translation(Vector3d(x, y, 0)), attrs("A-BLOCK"))

    # Linked block: a second synthetic 3dm
    linked_path = os.path.join(work, "linked-part.3dm")
    part = Rhino.FileIO.File3dm()
    part.Settings.ModelUnitSystem = Rhino.UnitSystem.Millimeters
    part.Objects.AddCircle(Circle(Point3d(0, 0, 0), 400))
    part.Objects.AddLine(Point3d(-600, 0, 0), Point3d(600, 0, 0))
    part.Write(linked_path, 8)
    linked_ok = False
    try:
        li = doc.InstanceDefinitions.Add("linked-part", "linked", Point3d.Origin,
                                         [LineCurve(Point3d(0, 0, 0), Point3d(1, 0, 0))], [attrs("A-BLOCK")])
        ref = Rhino.FileIO.FileReference.CreateFromFullPath(linked_path)
        linked_ok = doc.InstanceDefinitions.ModifySourceArchive(li, ref, rdo.InstanceDefinitionUpdateType.Linked, True)
        doc.InstanceDefinitions.UpdateLinkedInstanceDefinition(li, linked_path, True, True)
        doc.Objects.AddInstanceObject(li, Transform.Translation(Vector3d(14000, 3000, 0)), attrs("A-BLOCK"))
    except Exception as error:
        note("linked block API failed", error)
    summary["linkedBlockApi"] = linked_ok
    summary["idefs"] = [{"name": d.Name, "updateType": str(d.UpdateType), "source": d.SourceArchive,
                         "objects": len(d.GetObjects())}
                        for d in doc.InstanceDefinitions if d is not None and not d.IsDeleted]

    # Hatches: pattern + solid
    hatch1 = doc.HatchPatterns.Add(rdo.HatchPattern.Defaults.Hatch1)
    if hatch1 < 0:
        hatch1 = doc.HatchPatterns.FindName("Hatch1").Index
    solid = doc.HatchPatterns.Add(rdo.HatchPattern.Defaults.Solid)
    if solid < 0:
        solid = doc.HatchPatterns.FindName("Solid").Index
    for h in Hatch.Create(rect, hatch1, 0.0, 100.0, doc.ModelAbsoluteTolerance):
        doc.Objects.AddHatch(h, attrs("A-HATCH"))
    for h in Hatch.Create(circle.ToNurbsCurve(), solid, 0.0, 1.0, doc.ModelAbsoluteTolerance):
        doc.Objects.AddHatch(h, attrs("A-HATCH"))

    # Layouts with details: A3 1:100 (locked) and A3 1:50 Korean name
    pages = []
    for name, scale in (("A3-PLAN", 100.0), ("A3-상세", 50.0)):
        page = doc.Views.AddPageView(name, 420.0, 297.0)
        detail = page.AddDetailView("D-" + str(int(scale)), Point2d(20, 20), Point2d(400, 277),
                                    Rhino.Display.DefinedViewportProjection.Top)
        page.SetActiveDetail(detail.Id)
        detail.Viewport.ZoomExtents()
        detail.DetailGeometry.IsProjectionLocked = True
        detail.DetailGeometry.SetScale(scale, doc.ModelUnitSystem, 1.0, doc.PageUnitSystem)
        detail.CommitChanges()
        page.SetPageAsActive()
        # page-space border and title text
        pa = attrs("A-TEXT")
        pa.Space = rdo.ActiveSpace.PageSpace
        pa.ViewportId = page.MainViewport.Id
        doc.Objects.AddCurve(PolylineCurve(Polyline([Point3d(10, 10, 0), Point3d(410, 10, 0), Point3d(410, 287, 0),
                                                     Point3d(10, 287, 0), Point3d(10, 10, 0)])), pa)
        title = TextEntity.Create("TITLE " + name + " 1:" + str(int(scale)), Plane(Point3d(300, 14, 0), Vector3d.ZAxis),
                                  text_style, False, 0, 0)
        doc.Objects.Add(title, pa)
        d2 = doc.Objects.FindId(detail.Id)
        pages.append({"name": name, "detail": d2.Name if d2 else None,
                      "pageToModel": d2.DetailGeometry.PageToModelRatio if d2 else None,
                      "locked": d2.DetailGeometry.IsProjectionLocked if d2 else None})
    summary["pages"] = pages
    doc.Views.ActiveView = doc.Views.Find("Top", False) or doc.Views.ActiveView

    counts = {}
    for o in doc.Objects:
        key = str(o.ObjectType) + ("@page" if o.Attributes.Space == rdo.ActiveSpace.PageSpace else "")
        counts[key] = counts.get(key, 0) + 1
    summary["objectCounts"] = counts
    summary["layers"] = [{"name": l.Name, "color": [l.Color.R, l.Color.G, l.Color.B],
                          "plotWeight": l.PlotWeight, "linetype": doc.Linetypes[l.LinetypeIndex].Name
                          if l.LinetypeIndex >= 0 else None} for l in doc.Layers if not l.IsDeleted]
    summary["dimStyles"] = [{"name": d.Name, "font": d.Font.FamilyName if d.Font else None, "textHeight": d.TextHeight,
                             "arrow": str(d.ArrowType1), "arrowLength": d.ArrowLength, "scale": d.DimensionScale}
                            for d in doc.DimStyles if not d.IsDeleted]

    model = os.path.join(work, "synthetic.3dm")
    summary["saved"] = doc.SaveAs(model)
    flush_history("build")

    if mode == "discover":
        out = os.path.join(work, "discover.3dm")
        Rhino.RhinoApp.RunScript('_-SaveAs "' + out + '" _Scheme _Enter _Enter _Enter _Enter', True)
        flush_history("discover")
    for scheme in schemes:
        out = os.path.join(work, "export-" + scheme.replace(" ", "_") + ".dwg")
        ok = Rhino.RhinoApp.RunScript('_-SaveAs "' + out + '" _Scheme "' + scheme + '" _Enter _Enter', True)
        summary.setdefault("exports", []).append({"scheme": scheme, "file": out, "ok": ok, "exists": os.path.isfile(out)})
        flush_history("export " + scheme)
    # -Export writes only the selected (model-space) objects; compare once with the Default scheme.
    out = os.path.join(work, "export-SelAll-Default.dwg")
    ok = Rhino.RhinoApp.RunScript('_SelAll _-Export "' + out + '" _Scheme "Default" _Enter _Enter', True)
    summary.setdefault("exports", []).append({"scheme": "SelAll+Export Default", "file": out, "ok": ok, "exists": os.path.isfile(out)})
    flush_history("selall export")
    doc.Modified = False


try:
    main()
except Exception:
    log.append(traceback.format_exc())
with open(os.path.join(work, "rhino-log.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(log))
with open(os.path.join(work, "rhino-summary.json"), "w", encoding="utf-8") as f:
    json.dump(summary, f, ensure_ascii=False, indent=1, default=str)
with open(os.path.join(work, "rhino.done"), "w") as f:
    f.write("ok")
Rhino.RhinoApp.Exit()
