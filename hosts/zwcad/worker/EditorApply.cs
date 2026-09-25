using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.DatabaseServices;

namespace Vide.Zwcad
{
    internal static class EditorApply
    {
        internal static object Apply(Database target, string candidate, bool commit)
        {
            using (var source = new Database(false, true))
            {
                source.ReadDwgFile(candidate, FileOpenMode.OpenForReadAndAllShare, true, null); source.CloseInput(true);
                using (var from = source.TransactionManager.StartTransaction())
                using (var to = target.TransactionManager.StartTransaction())
                {
                    var sourceObjects = Objects(source, from);
                    var targetObjects = Objects(target, to);
                    var blocks = (BlockTable)to.GetObject(target.BlockTableId, OpenMode.ForRead);
                    var space = (BlockTableRecord)to.GetObject(blocks[BlockTableRecord.ModelSpace], commit ? OpenMode.ForWrite : OpenMode.ForRead);
                    int added = 0, updated = 0, removed = 0;
                    var mapping = new Dictionary<string, string>();
                    foreach (var entry in sourceObjects)
                    {
                        var line = (Entity)from.GetObject(entry.Value, OpenMode.ForRead);
                        ValidateProperties(line, target, to);
                        ObjectId existing;
                        if (targetObjects.TryGetValue(entry.Key, out existing))
                        {
                            var current = (Entity)to.GetObject(existing, OpenMode.ForRead);
                            if (line.GetType() != current.GetType()) throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
                            if (!Same(line, current))
                            {
                                updated++;
                                if (commit) { current.UpgradeOpen(); Copy(line, current, target, to); }
                            }
                            mapping[entry.Key] = entry.Key;
                        }
                        else
                        {
                            added++;
                            if (commit)
                            {
                                Entity copy = line is Line ? (Entity)new Line() : new Polyline();
                                Copy(line, copy, target, to);
                                space.AppendEntity(copy); to.AddNewlyCreatedDBObject(copy, true);
                                mapping[entry.Key] = copy.Handle.ToString();
                            }
                        }
                    }
                    foreach (var entry in targetObjects)
                        if (!sourceObjects.ContainsKey(entry.Key)) { removed++; if (commit) to.GetObject(entry.Value, OpenMode.ForWrite).Erase(); }
                    if (commit) to.Commit();
                    return new { added, updated, removed, mapping };
                }
            }
        }
        private static void ValidateProperties(Entity source, Database db, Transaction tr)
        {
            var layers = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
            var types = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead);
            if (!layers.Has(source.Layer) || !types.Has(source.Linetype)) throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
        }
        private static bool Same(Entity a, Entity b)
        {
            if (a.GetType() != b.GetType() || a.Layer != b.Layer || a.Linetype != b.Linetype ||
                !a.Color.Equals(b.Color) || a.LineWeight != b.LineWeight || a.LinetypeScale != b.LinetypeScale) return false;
            if (a is Line)
            {
                var first = (Line)a; var second = (Line)b;
                return first.StartPoint == second.StartPoint && first.EndPoint == second.EndPoint && first.Normal == second.Normal;
            }
            var pa = (Polyline)a; var pb = (Polyline)b;
            if (pa.NumberOfVertices != pb.NumberOfVertices || pa.Normal != pb.Normal || pa.Elevation != pb.Elevation || pa.Closed != pb.Closed) return false;
            for (int i = 0; i < pa.NumberOfVertices; i++)
                if (pa.GetPoint2dAt(i) != pb.GetPoint2dAt(i) || pa.GetBulgeAt(i) != pb.GetBulgeAt(i) ||
                    pa.GetStartWidthAt(i) != pb.GetStartWidthAt(i) || pa.GetEndWidthAt(i) != pb.GetEndWidthAt(i)) return false;
            return true;
        }
        private static void Copy(Entity source, Entity target, Database db, Transaction tr)
        {
            if (source.GetType() != target.GetType()) throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
            var layers = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
            var types = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead);
            if (!layers.Has(source.Layer) || !types.Has(source.Linetype)) throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
            if (source is Line)
            {
                var from = (Line)source; var to = (Line)target;
                to.Normal = from.Normal; to.StartPoint = from.StartPoint; to.EndPoint = from.EndPoint;
            }
            else CopyPolyline((Polyline)source, (Polyline)target);
            target.LayerId = layers[source.Layer]; target.LinetypeId = types[source.Linetype];
            target.Color = source.Color; target.LineWeight = source.LineWeight; target.LinetypeScale = source.LinetypeScale;
        }
        private static void CopyPolyline(Polyline source, Polyline target)
        {
            while (target.NumberOfVertices > source.NumberOfVertices) target.RemoveVertexAt(target.NumberOfVertices - 1);
            for (int i = 0; i < source.NumberOfVertices; i++)
            {
                if (i >= target.NumberOfVertices) target.AddVertexAt(i, source.GetPoint2dAt(i), source.GetBulgeAt(i), source.GetStartWidthAt(i), source.GetEndWidthAt(i));
                else { target.SetPointAt(i, source.GetPoint2dAt(i)); target.SetBulgeAt(i, source.GetBulgeAt(i)); target.SetStartWidthAt(i, source.GetStartWidthAt(i)); target.SetEndWidthAt(i, source.GetEndWidthAt(i)); }
            }
            target.Normal = source.Normal; target.Elevation = source.Elevation; target.Closed = source.Closed;
        }
        private static Dictionary<string, ObjectId> Objects(Database db, Transaction tr)
        {
            var blocks = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var space = (BlockTableRecord)tr.GetObject(blocks[BlockTableRecord.ModelSpace], OpenMode.ForRead);
            var result = new Dictionary<string, ObjectId>();
            foreach (ObjectId id in space) { if (!(tr.GetObject(id, OpenMode.ForRead) is Polyline) && !(tr.GetObject(id, OpenMode.ForRead) is Line)) throw new InvalidOperationException("UNSUPPORTED_APPLICATION"); result.Add(id.Handle.ToString(), id); }
            return result;
        }
        internal static void Validate(string path)
        {
            var serializer = new JavaScriptSerializer();
            var model = serializer.Deserialize<Dictionary<string, object>>(serializer.Serialize(DwgReader.Read(path)));
            if (Convert.ToString(model["dwgEditMode"]) != "polyline-vertices-v1" && Convert.ToString(model["dwgEditMode"]) != "linear-entities-v1") throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
        }
        internal static void Verify(string candidate, string actual, IDictionary<string, object> mapping)
        {
            var serializer = new JavaScriptSerializer();
            var before = serializer.Deserialize<Dictionary<string, object>>(serializer.Serialize(DwgReader.Read(candidate)));
            var after = serializer.Deserialize<Dictionary<string, object>>(serializer.Serialize(DwgReader.Read(actual)));
            foreach (string group in new[] { "objects", "scene" })
            {
                var expected = ((IEnumerable)before[group]).Cast<Dictionary<string, object>>().ToArray();
                var observed = ((IEnumerable)after[group]).Cast<Dictionary<string, object>>().ToArray();
                if (expected.Length != observed.Length) throw new InvalidOperationException("HOST_VERIFICATION_FAILED");
                foreach (var item in expected)
                {
                    string handle = Convert.ToString(mapping[Convert.ToString(item["nativeId"])]);
                    var match = observed.SingleOrDefault(row => Convert.ToString(row["nativeId"]) == handle);
                    if (match == null) throw new InvalidOperationException("HOST_VERIFICATION_FAILED");
                    foreach (var entry in item)
                        if (entry.Key != "id" && entry.Key != "nativeId" && entry.Key != "name" && serializer.Serialize(entry.Value) != serializer.Serialize(match[entry.Key]))
                            throw new InvalidOperationException("HOST_VERIFICATION_FAILED");
                }
            }
        }
        internal static string Hash(string path) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(File.ReadAllBytes(path))).Replace("-", "").ToLowerInvariant(); }
    }
}
