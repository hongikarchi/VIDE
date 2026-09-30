# -*- coding: utf-8 -*-
# A/B terminal side (SPIKE-2026-09-30-ai-parity-ab): writes the open document's objects as a small
# scene JSON (id, name, layer, bounds in mm) that tools/ab/terminal.mjs checks like the engine run.
# The user runs it in their own Rhino (RunPythonScript) on the fixture document; nothing is changed.
# Output: VIDE_AB_DUMP, else .vide/ab/terminal/<label>.json where <label> is asked for.
import base64
import json
import os
import Rhino
import rhinoscriptsyntax as rs
import scriptcontext as sc

doc = sc.doc
scale = Rhino.RhinoMath.UnitScale(doc.ModelUnitSystem, Rhino.UnitSystem.Millimeters)


def b64(text):
    return base64.b64encode((text or '').encode('utf-8')).decode('ascii')


rows = []
for obj in doc.Objects.GetObjectList(Rhino.DocObjects.ObjectEnumeratorSettings()):
    box = obj.Geometry.GetBoundingBox(True)
    if not box.IsValid:
        continue
    rows.append({
        'id': str(obj.Id),
        'name64': b64(obj.Attributes.Name),
        'layer64': b64(doc.Layers[obj.Attributes.LayerIndex].FullPath),
        'nativeType': str(obj.ObjectType),
        'origin': [box.Min.X * scale, box.Min.Y * scale, box.Min.Z * scale],
        'boundsSize': [(box.Max.X - box.Min.X) * scale, (box.Max.Y - box.Min.Y) * scale,
                       (box.Max.Z - box.Min.Z) * scale],
    })

path = os.environ.get('VIDE_AB_DUMP')
if not path:
    label = rs.GetString('A/B dump label (fixture, R1..R5)', 'fixture')
    if not label:
        raise Exception('No label')
    try:
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    except NameError:
        root = os.getcwd()
    path = os.path.join(root, '.vide', 'ab', 'terminal', label + '.json')
folder = os.path.dirname(path)
if not os.path.isdir(folder):
    os.makedirs(folder)
with open(path, 'w') as f:
    json.dump({'units': 'mm', 'scene': rows}, f)
print('A/B scene dump: %d objects -> %s' % (len(rows), path))
