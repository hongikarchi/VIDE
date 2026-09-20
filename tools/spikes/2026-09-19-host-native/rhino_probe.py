# -*- coding: utf-8 -*-
import os
import json
import traceback
import Rhino
import System

root = os.environ.get('VIDE_HOST_SPIKE_DIR')
if not root:
    raise Exception('VIDE_HOST_SPIKE_DIR must be explicitly supplied')
if not os.path.isdir(root):
    os.makedirs(root)
report = {'host': 'rhino', 'version': str(Rhino.RhinoApp.Version), 'checks': {}, 'success': False}
doc = None
reopened = None
try:
    doc = Rhino.RhinoDoc.CreateHeadless(None)
    doc.ModelUnitSystem = Rhino.UnitSystem.Millimeters
    points = [Rhino.Geometry.Point3d(0, 0, 0), Rhino.Geometry.Point3d(1000, 0, 0),
              Rhino.Geometry.Point3d(1000, 1000, 0), Rhino.Geometry.Point3d(0, 0, 0)]
    attributes = Rhino.DocObjects.ObjectAttributes()
    attributes.Name = 'VIDE_SYNTHETIC_ORIGINAL'
    attributes.SetUserString('vide-fixture', 'preserve-me')
    original_id = doc.Objects.AddPolyline(points, attributes)
    original = doc.Objects.FindId(original_id)
    before = original.Geometry.GetLength()
    candidate_geometry = original.Geometry.DuplicateCurve()
    candidate_geometry.Transform(Rhino.Geometry.Transform.Translation(2000, 0, 0))
    candidate_attributes = attributes.Duplicate()
    candidate_attributes.Name = 'VIDE_SYNTHETIC_CANDIDATE'
    candidate_id = doc.Objects.AddCurve(candidate_geometry, candidate_attributes)
    report['checks']['candidate_created'] = candidate_id != System.Guid.Empty and doc.Objects.Count == 2
    report['checks']['original_preserved'] = abs(doc.Objects.FindId(original_id).Geometry.GetLength() - before) < 1e-8
    report['checks']['candidate_discard'] = doc.Objects.Delete(candidate_id, True) and doc.Objects.FindId(original_id) is not None
    transformed_id = doc.Objects.Transform(original_id, Rhino.Geometry.Transform.Translation(0, 2000, 0), True)
    edited = doc.Objects.FindId(transformed_id)
    report['checks']['native_edit'] = edited is not None and abs(edited.Geometry.GetBoundingBox(True).Min.Y - 2000) < 1e-8
    report['checks']['attributes_preserved'] = edited.Attributes.GetUserString('vide-fixture') == 'preserve-me'
    output = os.path.join(root, 'rhino-synthetic.3dm')
    options = Rhino.FileIO.FileWriteOptions()
    options.SuppressDialogBoxes = True
    options.SuppressAllInput = True
    report['checks']['save'] = doc.Write3dmFile(output, options)
    doc.Dispose()
    doc = None
    reopened = Rhino.RhinoDoc.OpenHeadless(output)
    restored = reopened.Objects.FindId(transformed_id)
    report['checks']['reopen'] = restored is not None and restored.Attributes.GetUserString('vide-fixture') == 'preserve-me'
    report['checks']['units'] = reopened.ModelUnitSystem == Rhino.UnitSystem.Millimeters
    report['checks']['reopened_geometry'] = restored is not None and abs(restored.Geometry.GetBoundingBox(True).Min.Y - 2000) < 1e-8
    report['success'] = all(report['checks'].values())
except Exception:
    report['error'] = traceback.format_exc()
finally:
    if doc is not None:
        doc.Dispose()
    if reopened is not None:
        reopened.Dispose()
    with open(os.path.join(root, 'rhino-result.json'), 'w') as output:
        json.dump(report, output, indent=2)
