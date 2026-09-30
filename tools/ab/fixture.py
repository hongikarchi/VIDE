# -*- coding: utf-8 -*-
# Synthetic A/B fixture (SPIKE-2026-09-30-ai-parity-ab): builds the model that tools/ab/requests.json
# checks, in a NEW empty millimetre document, and saves it as .vide/ab/ab-fixture.3dm.
# The user runs it (RunPythonScript) in a Rhino window they started; agents never launch Rhino.
# Optional: set VIDE_AB_FIXTURE to another .3dm path.
import os
import Rhino
import scriptcontext as sc
import System.Drawing as D
from Rhino.Geometry import Point3d, Line, Box, Plane, Interval, Arc

doc = sc.doc
if doc.Objects.Count:
    raise Exception('Run this in a new empty document (File > New, no template).')
doc.ModelUnitSystem = Rhino.UnitSystem.Millimeters


def layer(name, color):
    index = doc.Layers.FindByFullPath(name, -1)
    if index >= 0:
        return index
    item = Rhino.DocObjects.Layer()
    item.Name = name
    item.Color = color
    return doc.Layers.Add(item)


def attrs(layer_index, name):
    a = Rhino.DocObjects.ObjectAttributes()
    a.LayerIndex = layer_index
    a.Name = name
    return a


grid = layer('S-GRID', D.Color.FromArgb(200, 60, 60))
beam = layer('S-BEAM', D.Color.FromArgb(40, 90, 200))
slab = layer('S-SLAB', D.Color.FromArgb(150, 150, 150))
level = layer('LEVEL', D.Color.FromArgb(0, 140, 90))
rail = layer('A-RAIL-GUIDE', D.Color.FromArgb(230, 140, 0))

xs = [0, 6000, 12000, 18000]
ys = [0, 6000, 12000]
# Axis lines: four along Y named A..D, three along X named 1..3 (to be renamed X/Y by R5).
for i, x in enumerate(xs):
    doc.Objects.AddLine(Line(Point3d(x, -1500, 0), Point3d(x, 13500, 0)), attrs(grid, 'ABCD'[i]))
for j, y in enumerate(ys):
    doc.Objects.AddLine(Line(Point3d(-1500, y, 0), Point3d(19500, y, 0)), attrs(grid, str(j + 1)))

# Three beams on grid line y = 0 at 2F: 300 wide, 500 deep, top at z = 3600.
for i in range(3):
    box = Box(Plane.WorldXY, Interval(xs[i], xs[i + 1]), Interval(-150, 150), Interval(3100, 3600))
    doc.Objects.AddBrep(box.ToBrep(), attrs(beam, 'B%d' % (i + 1)))

# 2F slab: 18000 x 12000 x 200, top at 3600.
doc.Objects.AddBrep(
    Box(Plane.WorldXY, Interval(0, 18000), Interval(0, 12000), Interval(3400, 3600)).ToBrep(),
    attrs(slab, '2F SLAB'),
)

# Floor levels as named points.
for name, z in (('1F FL+0', 0), ('2F FL+3600', 3600), ('3F FL+7200', 7200)):
    doc.Objects.AddPoint(Point3d(-3000, -3000, z), attrs(level, name))

# The railing guide: an open arc along the north slab edge, on the 2F top.
arc = Arc(Point3d(0, 12000, 3600), Point3d(9000, 13500, 3600), Point3d(18000, 12000, 3600))
doc.Objects.AddArc(arc, attrs(rail, 'RAIL GUIDE'))

doc.Views.Redraw()
try:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
except NameError:  # some script runners define no __file__: use the working folder
    root = os.getcwd()
path = os.environ.get('VIDE_AB_FIXTURE') or os.path.join(root, '.vide', 'ab', 'ab-fixture.3dm')
folder = os.path.dirname(path)
if not os.path.isdir(folder):
    os.makedirs(folder)
# Save As, so the open document IS the fixture (the engine links and syncs this file).
if not Rhino.RhinoApp.RunScript('_-SaveAs "{}" _Enter'.format(path), False):
    raise Exception('Could not save ' + path)
print('A/B fixture saved: ' + path)
