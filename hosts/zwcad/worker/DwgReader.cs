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
                    bool editable = units == 4 && groups.Count == 0, hasLine = false;
                    var objects = new List<object>(); var scene = new List<object>();
                    foreach (ObjectId objectId in space)
                    {
                        if (objects.Count >= 500) throw new InvalidOperationException("IMPORT_LIMIT");
                        var entity = transaction.GetObject(objectId, OpenMode.ForRead) as Entity;
                        var line = entity as Polyline;
                        var segment = entity as Line;
                        if (line == null && segment == null) throw new InvalidOperationException("UNSUPPORTED_DWG_CONTENT");
                        if (line != null && (Math.Abs(line.Normal.X) > 1e-10 || Math.Abs(line.Normal.Y) > 1e-10 || Math.Abs(line.Normal.Z - 1) > 1e-10))
                            throw new InvalidOperationException("UNSUPPORTED_DWG_CONTENT");
                        if (segment != null && Math.Abs(segment.StartPoint.Z - segment.EndPoint.Z) > 1e-10)
                            throw new InvalidOperationException("UNSUPPORTED_DWG_CONTENT");
                        if (line != null && (line.NumberOfVertices < 2 || line.NumberOfVertices > 1000)) throw new InvalidOperationException("IMPORT_LIMIT");
                        var layer = (LayerTableRecord)transaction.GetObject(entity.LayerId, OpenMode.ForRead);
                        if (!entity.ExtensionDictionary.IsNull || layer.IsLocked || (line != null ? line.Thickness : segment.Thickness) != 0) editable = false;
                        using (ResultBuffer data = entity.XData) { if (data != null) editable = false; }
                        var points = new List<double[]>(); var display = new List<double>();
                        if (segment != null)
                        {
                            hasLine = true;
                            foreach (var point in new[] { segment.StartPoint, segment.EndPoint })
                                AddPoint(points, display, point.X * factor, point.Y * factor, point.Z * factor);
                        }
                        else for (int index = 0; index < line.NumberOfVertices; index++)
                        {
                            if (Math.Abs(line.GetBulgeAt(index)) > 1e-12) throw new InvalidOperationException("UNSUPPORTED_DWG_CONTENT");
                            if (line.GetStartWidthAt(index) != 0 || line.GetEndWidthAt(index) != 0) editable = false;
                            var point = line.GetPoint2dAt(index);
                            AddPoint(points, display, point.X * factor, point.Y * factor, line.Elevation * factor);
                        }
                        if (line != null && line.Closed && (points[0][0] != points[points.Count - 1][0] || points[0][1] != points[points.Count - 1][1]))
                        { points.Add(points[0]); display.AddRange(points[0]); }
                        string handle = entity.Handle.ToString(), id = "cad-" + handle;
                        objects.Add(new { id, nativeId = handle, kind = "polyline", name = entity.Layer + " / " + handle, points });
                        scene.Add(new { id, nativeId = handle, nativeType = line != null ? "LWPolyline" : "Line", line = display, vertices = new double[0], indices = new int[0],
                            area = line != null && line.Closed ? (double?)(line.Area * factor * factor) : null, volume = (double?)null, length = (line != null ? line.Length : segment.Length) * factor,
                            layer64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(entity.Layer)), color = entity.ColorIndex, valid = true });
                    }
                    if (objects.Count == 0) throw new InvalidOperationException("EMPTY_DWG");
                    return new { objects, scene, verified = true, referenceOnly = true, scope = "model-space", sourceUnits = units,
                        dwgEditMode = editable ? (hasLine ? "linear-entities-v1" : "polyline-vertices-v1") : null, importMode = "sdk" };
                }
            }
        }
        private static void AddPoint(List<double[]> points, List<double> display, double x, double y, double z)
        {
            var coordinates = new[] { x, y, z };
            foreach (double coordinate in coordinates)
                if (Double.IsNaN(coordinate) || Double.IsInfinity(coordinate) || Math.Abs(coordinate) > 100000) throw new InvalidOperationException("IMPORT_LIMIT");
            points.Add(coordinates); display.AddRange(coordinates);
        }
    }
}
