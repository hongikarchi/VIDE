using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Geometry;

namespace Vide.Zwcad
{
    internal static class DwgEditor
    {
        internal static void Edit(string source, string output, string requestPath)
        {
            if (!Path.IsPathRooted(output) || File.Exists(output) || String.Equals(source, output, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("UNSUPPORTED_DWG_EDIT");
            var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
            var input = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(requestPath));
            var shapes = (ArrayList)input["objects"];
            // Reuse the reader's complete capability check before opening anything for write.
            var baseline = serializer.Deserialize<Dictionary<string, object>>(serializer.Serialize(DwgReader.Read(source)));
            if (Convert.ToString(baseline["dwgEditMode"]) != "polyline-vertices-v1" || shapes.Count != ((ArrayList)baseline["objects"]).Count) throw new InvalidOperationException("UNSUPPORTED_DWG_EDIT");
            using (Database database = new Database(false, true))
            {
                database.ReadDwgFile(source, FileOpenMode.OpenForReadAndAllShare, true, null); database.CloseInput(true);
                using (Transaction transaction = database.TransactionManager.StartTransaction())
                {
                    var blocks = (BlockTable)transaction.GetObject(database.BlockTableId, OpenMode.ForRead);
                    ObjectId model = blocks[BlockTableRecord.ModelSpace];
                    var seen = new HashSet<string>();
                    foreach (Dictionary<string, object> shape in shapes)
                    {
                        string handle = Convert.ToString(shape["nativeId"]);
                        if (!seen.Add(handle) || Convert.ToString(shape["id"]) != "cad-" + handle || Convert.ToString(shape["kind"]) != "polyline") throw new InvalidOperationException("UNSUPPORTED_DWG_EDIT");
                        var id = database.GetObjectId(false, new Handle(Convert.ToInt64(handle, 16)), 0);
                        var line = transaction.GetObject(id, OpenMode.ForWrite) as Polyline;
                        if (line == null || line.OwnerId != model || Convert.ToString(shape["name"]) != line.Layer + " / " + handle) throw new InvalidOperationException("UNSUPPORTED_DWG_EDIT");
                        var points = (ArrayList)shape["points"];
                        if (points.Count < 2 || points.Count > 1000) throw new InvalidOperationException("UNSUPPORTED_DWG_EDIT");
                        var coordinates = new List<double[]>();
                        foreach (ArrayList point in points)
                        {
                            if (point.Count != 3) throw new InvalidOperationException("UNSUPPORTED_DWG_EDIT");
                            double[] p = { Convert.ToDouble(point[0]), Convert.ToDouble(point[1]), Convert.ToDouble(point[2]) };
                            foreach (double n in p) if (Double.IsNaN(n) || Double.IsInfinity(n) || Math.Abs(n) > 100000) throw new InvalidOperationException("UNSUPPORTED_DWG_EDIT");
                            if (coordinates.Count > 0 && p[2] != coordinates[0][2]) throw new InvalidOperationException("UNSUPPORTED_DWG_EDIT");
                            coordinates.Add(p);
                        }
                        double[] first = coordinates[0], last = coordinates[coordinates.Count - 1];
                        bool closed = first[0] == last[0] && first[1] == last[1];
                        int count = coordinates.Count - (closed ? 1 : 0);
                        if (count < 2) throw new InvalidOperationException("UNSUPPORTED_DWG_EDIT");
                        while (line.NumberOfVertices > count) line.RemoveVertexAt(line.NumberOfVertices - 1);
                        for (int i = 0; i < count; i++)
                        {
                            var point = new Point2d(coordinates[i][0] * 1000, coordinates[i][1] * 1000);
                            if (i < line.NumberOfVertices) line.SetPointAt(i, point); else line.AddVertexAt(i, point, 0, 0, 0);
                        }
                        line.Closed = closed; line.Elevation = first[2] * 1000;
                    }
                    transaction.Commit();
                }
                // Only the new candidate is saved. Source is never saved or opened as a UI document.
                if (File.Exists(output)) throw new InvalidOperationException("UNSUPPORTED_DWG_EDIT");
                database.SaveAs(output, DwgVersion.Current);
            }
        }
    }
}
