using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.ApplicationServices;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Geometry;

namespace Vide.Zwcad.Connection
{
    // AI work on the user's open drawing: a paged entity query, and C# method bodies (the same
    // compiler and API policy as the work-copy worker). A read runs in a transaction that is always
    // aborted; a write commits one transaction, so the drawing's UNDO reverts it in one step.
    public sealed class AttachedEdit
    {
        private const int MaxPage = 200;

        internal static object Query(Document document, Dictionary<string, object> request)
        {
            int offset = Math.Max(0, Int("offset", request, 0)), limit = Math.Min(MaxPage, Math.Max(1, Int("limit", request, 100)));
            var handles = Strings(request, "handles");
            var layers = Strings(request, "layers");
            var types = Strings(request, "types");
            var db = document.Database;
            using (document.LockDocument())
            using (var tr = db.TransactionManager.StartTransaction())
            {
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var space = (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                var rows = new List<object>();
                int total = 0;
                var layerCounts = new Dictionary<string, int>();
                foreach (ObjectId id in space)
                {
                    var entity = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (entity == null) continue;
                    if (handles != null && !handles.Contains(entity.Handle.ToString())) continue;
                    if (layers != null && !layers.Contains(entity.Layer)) continue;
                    if (types != null && !types.Contains(entity.GetType().Name)) continue;
                    int count; layerCounts.TryGetValue(entity.Layer, out count); layerCounts[entity.Layer] = count + 1;
                    if (total >= offset && rows.Count < limit) rows.Add(Describe(entity, tr));
                    total++;
                }
                tr.Abort();
                return new { ok = true, units = db.Insunits.ToString(), total, offset, nextOffset = offset + rows.Count < total ? (int?)(offset + rows.Count) : null,
                    layers = layerCounts.OrderBy(pair => pair.Key).Select(pair => new { name = pair.Key, count = pair.Value }).ToArray(), objects = rows };
            }
        }

        private static double[] P(Point3d p) => new[] { Math.Round(p.X, 4), Math.Round(p.Y, 4), Math.Round(p.Z, 4) };

        private static object Describe(Entity entity, Transaction tr)
        {
            var row = new Dictionary<string, object> {
                ["handle"] = entity.Handle.ToString(), ["type"] = entity.GetType().Name, ["layer"] = entity.Layer,
                ["color"] = entity.ColorIndex, ["linetype"] = entity.Linetype,
            };
            try { var box = entity.GeometricExtents; row["min"] = P(box.MinPoint); row["max"] = P(box.MaxPoint); } catch { }
            switch (entity)
            {
                case Line line: row["start"] = P(line.StartPoint); row["end"] = P(line.EndPoint); row["length"] = Math.Round(line.Length, 4); break;
                case Polyline poly:
                    row["closed"] = poly.Closed; row["elevation"] = poly.Elevation; row["length"] = Math.Round(poly.Length, 4);
                    row["vertices"] = Enumerable.Range(0, Math.Min(poly.NumberOfVertices, 200)).Select(i => { var v = poly.GetPoint2dAt(i); return new[] { Math.Round(v.X, 4), Math.Round(v.Y, 4), Math.Round(poly.GetBulgeAt(i), 6) }; }).ToArray();
                    if (poly.NumberOfVertices > 200) row["verticesOmitted"] = poly.NumberOfVertices - 200;
                    break;
                case Circle circle: row["center"] = P(circle.Center); row["radius"] = circle.Radius; break;
                case Arc arc: row["center"] = P(arc.Center); row["radius"] = arc.Radius; row["startAngle"] = arc.StartAngle; row["endAngle"] = arc.EndAngle; break;
                case DBText text: row["text"] = text.TextString; row["position"] = P(text.Position); row["height"] = text.Height; row["rotation"] = text.Rotation; break;
                case MText text: row["text"] = text.Contents; row["position"] = P(text.Location); row["height"] = text.TextHeight; row["rotation"] = text.Rotation; break;
                case BlockReference block:
                    row["block"] = block.Name; row["position"] = P(block.Position); row["rotation"] = block.Rotation;
                    row["scale"] = new[] { block.ScaleFactors.X, block.ScaleFactors.Y, block.ScaleFactors.Z };
                    var attributes = new Dictionary<string, string>();
                    foreach (ObjectId id in block.AttributeCollection)
                        if (tr.GetObject(id, OpenMode.ForRead) is AttributeReference attribute) attributes[attribute.Tag] = attribute.TextString;
                    if (attributes.Count > 0) row["attributes"] = attributes;
                    break;
                case Dimension dimension: row["measurement"] = dimension.Measurement; row["dimensionText"] = dimension.DimensionText; break;
                case Hatch hatch: row["pattern"] = hatch.PatternName; try { row["area"] = hatch.Area; } catch { } break;
                case Curve curve: try { row["start"] = P(curve.StartPoint); row["end"] = P(curve.EndPoint); } catch { } break;
            }
            return row;
        }

        private static readonly System.Collections.Concurrent.ConcurrentQueue<Tuple<Document, string, TaskCompletionSource<object>>> writes =
            new System.Collections.Concurrent.ConcurrentQueue<Tuple<Document, string, TaskCompletionSource<object>>>();

        /// <summary>
        /// A write runs inside the VIDEAIRUN command, like any drawing command, so it is one step in
        /// ZWCAD's UNDO history instead of an unlabelled change made between commands.
        /// </summary>
        internal static Task<object> Queue(Document document, string code)
        {
            var job = new TaskCompletionSource<object>();
            writes.Enqueue(Tuple.Create(document, code, job));
            document.SendStringToExecute("_VIDEAIRUN ", true, false, false);
            return job.Task;
        }

        [ZwSoft.ZwCAD.Runtime.CommandMethod("VIDEAIRUN", ZwSoft.ZwCAD.Runtime.CommandFlags.Modal | ZwSoft.ZwCAD.Runtime.CommandFlags.NoHistory)]
        public static void RunQueued()
        {
            Tuple<Document, string, TaskCompletionSource<object>> job;
            while (writes.TryDequeue(out job))
            {
                try { job.Item3.TrySetResult(Run(job.Item1, job.Item2, true)); }
                catch (Exception error) { job.Item3.TrySetException(error); }
            }
        }

        internal static object Run(Document document, string code, bool write)
        {
            Vide.Zwcad.CompilerDependencies.Install();
            string failure; string[] diagnostics;
            var method = Vide.Zwcad.SdkCompiler.Compile(code, out failure, out diagnostics);
            if (method == null) return new { ok = false, code = failure, diagnostics };
            var db = document.Database;
            var added = new HashSet<string>(); var modified = new HashSet<string>(); var erased = new HashSet<string>();
            ObjectEventHandler append = (s, e) => { if (e.DBObject is Entity) added.Add(e.DBObject.Handle.ToString()); };
            ObjectEventHandler change = (s, e) => { if (e.DBObject is Entity) modified.Add(e.DBObject.Handle.ToString()); };
            ObjectErasedEventHandler erase = (s, e) => { if (e.DBObject is Entity) { if (e.Erased) erased.Add(e.DBObject.Handle.ToString()); else erased.Remove(e.DBObject.Handle.ToString()); } };
            object value;
            using (document.LockDocument())
            {
                if (write) { db.ObjectAppended += append; db.ObjectModified += change; db.ObjectErased += erase; }
                try
                {
                    using (var tr = db.TransactionManager.StartTransaction())
                    {
                        try { value = method.Invoke(null, new object[] { db, tr }); }
                        catch (TargetInvocationException error)
                        {
                            tr.Abort();
                            var cause = error.InnerException ?? error;
                            return new { ok = false, code = "EXECUTION_FAILED", diagnostics = new[] { cause.GetType().Name + ": " + cause.Message } };
                        }
                        if (write) tr.Commit(); else tr.Abort();
                    }
                }
                finally { if (write) { db.ObjectAppended -= append; db.ObjectModified -= change; db.ObjectErased -= erase; } }
            }
            if (write) try { document.Editor.Regen(); } catch { }
            modified.ExceptWith(added); modified.ExceptWith(erased); added.ExceptWith(erased);
            return new { ok = true, write, value = Safe(value), changes = new { added = added.ToArray(), modified = modified.ToArray(), erased = erased.ToArray() } };
        }

        /// <summary>Return values reach the AI as JSON; SDK objects and cycles become their text.</summary>
        private static object Safe(object value)
        {
            if (value == null) return null;
            try
            {
                var serializer = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 20 };
                var text = serializer.Serialize(value);
                if (text.Length > 64 * 1024) return new { truncated = true, text = text.Substring(0, 64 * 1024) };
                return serializer.DeserializeObject(text);
            }
            catch { return Convert.ToString(value); }
        }

        private static int Int(string key, Dictionary<string, object> request, int fallback)
        {
            object value; return request.TryGetValue(key, out value) && value != null ? Convert.ToInt32(value) : fallback;
        }
        private static HashSet<string> Strings(Dictionary<string, object> request, string key)
        {
            object value;
            if (!request.TryGetValue(key, out value) || !(value is IEnumerable list) || value is string) return null;
            var result = new HashSet<string>(list.Cast<object>().Select(Convert.ToString));
            return result.Count == 0 ? null : result;
        }
    }
}
