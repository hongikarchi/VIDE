using System;
using System.Collections.Generic;
using System.Text;
using ZwSoft.ZwCAD.DatabaseServices;

namespace Vide.Zwcad
{
    internal static class DwgReader
    {
        internal static object Read(string filename)
        {
            using (Database database = new Database(false, true))
            {
                database.ReadDwgFile(filename, FileOpenMode.OpenForReadAndAllShare, true, null);
                database.CloseInput(true);
                int units = (int)database.Insunits;
                double factor;
                switch (units) { case 4: factor = .001; break; case 5: factor = .01; break; case 6: factor = 1; break; case 1: factor = .0254; break; case 2: factor = .3048; break; default: throw new InvalidOperationException("UNKNOWN_UNITS"); }
                using (Transaction transaction = database.TransactionManager.StartTransaction())
                {
                    var blocks = (BlockTable)transaction.GetObject(database.BlockTableId, OpenMode.ForRead);
                    var space = (BlockTableRecord)transaction.GetObject(blocks[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                    var groups = (DBDictionary)transaction.GetObject(database.GroupDictionaryId, OpenMode.ForRead);
                    bool editable = units == 4 && groups.Count == 0;
                    var objects = new List<object>(); var scene = new List<object>();
                    foreach (ObjectId objectId in space)
                    {
                        if (objects.Count >= 500) throw new InvalidOperationException("IMPORT_LIMIT");
                        var line = transaction.GetObject(objectId, OpenMode.ForRead) as Polyline;
                        if (line == null || Math.Abs(line.Normal.X) > 1e-10 || Math.Abs(line.Normal.Y) > 1e-10 || Math.Abs(line.Normal.Z - 1) > 1e-10)
                            throw new InvalidOperationException("UNSUPPORTED_DWG_CONTENT");
                        if (line.NumberOfVertices < 2 || line.NumberOfVertices > 1000) throw new InvalidOperationException("IMPORT_LIMIT");
                        var layer = (LayerTableRecord)transaction.GetObject(line.LayerId, OpenMode.ForRead);
                        if (!line.ExtensionDictionary.IsNull || layer.IsLocked || line.Thickness != 0) editable = false;
                        using (ResultBuffer data = line.XData) { if (data != null) editable = false; }
                        var points = new List<double[]>(); var display = new List<double>();
                        for (int index = 0; index < line.NumberOfVertices; index++)
                        {
                            if (Math.Abs(line.GetBulgeAt(index)) > 1e-12) throw new InvalidOperationException("UNSUPPORTED_DWG_CONTENT");
                            if (line.GetStartWidthAt(index) != 0 || line.GetEndWidthAt(index) != 0) editable = false;
                            var point = line.GetPoint2dAt(index);
                            var coordinates = new double[] { point.X * factor, point.Y * factor, line.Elevation * factor };
                            foreach (double coordinate in coordinates)
                                if (Double.IsNaN(coordinate) || Double.IsInfinity(coordinate) || Math.Abs(coordinate) > 100000) throw new InvalidOperationException("IMPORT_LIMIT");
                            points.Add(coordinates); display.AddRange(coordinates);
                        }
                        if (line.Closed && (points[0][0] != points[points.Count - 1][0] || points[0][1] != points[points.Count - 1][1]))
                        { points.Add(points[0]); display.AddRange(points[0]); }
                        string handle = line.Handle.ToString(), id = "cad-" + handle;
                        objects.Add(new { id, nativeId = handle, kind = "polyline", name = line.Layer + " / " + handle, points });
                        scene.Add(new { id, nativeId = handle, nativeType = "LWPolyline", line = display, vertices = new double[0], indices = new int[0],
                            area = line.Closed ? (double?)(line.Area * factor * factor) : null, volume = (double?)null, length = line.Length * factor,
                            layer64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(line.Layer)), color = line.ColorIndex, valid = true });
                    }
                    if (objects.Count == 0) throw new InvalidOperationException("EMPTY_DWG");
                    return new { objects, scene, verified = true, referenceOnly = true, scope = "model-space", sourceUnits = units,
                        dwgEditMode = editable ? "polyline-vertices-v1" : null, importMode = "sdk" };
                }
            }
        }
    }
}
