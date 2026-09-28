using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Geometry;

namespace Vide.Zwcad.Connection
{
    // Read-only display data. This never substitutes tessellated geometry for native DWG data.
    internal static class AttachedDisplay
    {
        internal static double Scale(Database db)
        {
            switch ((int)db.Insunits) {
                case 1: return .0254; case 2: return .3048; case 4: return .001;
                case 5: return .01; case 6: return 1; case 7: return 1000;
                default: throw new InvalidOperationException("UNKNOWN_UNITS");
            }
        }
        internal static object Page(Database db, int offset, int limit, long revision)
        {
            double scale = Scale(db);
            using (var tx = db.TransactionManager.StartTransaction()) {
                var table = (BlockTable)tx.GetObject(db.BlockTableId, OpenMode.ForRead);
                var space = (BlockTableRecord)tx.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                var ids = space.Cast<ObjectId>().ToArray();
                if (offset < 0 || offset > ids.Length || limit < 1 || limit > 250) throw new InvalidOperationException("INVALID_PAGE");
                var objects = new List<object>(); var scene = new List<object>();
                var omitted = new Dictionary<string, int>(); var warnings = new Dictionary<string, int>(); int displayed = 0;
                foreach (var oid in ids.Skip(offset).Take(limit)) {
                    var entity = tx.GetObject(oid, OpenMode.ForRead) as Entity;
                    if (entity == null) continue;
                    var lines = new List<double[]>();
                    var unsupported = new Dictionary<string, int>();
                    Collect(entity, tx, Matrix3d.Identity, scale, new HashSet<ObjectId>(), lines, unsupported);
                    string handle = entity.Handle.ToString();
                    if (lines.Count > 0) {
                        string id = "cad-" + handle;
                        var segments = new List<double>();
                        foreach (var line in lines) for (int p = 3; p < line.Length; p += 3) {
                            for (int axis = 0; axis < 3; axis++) segments.Add(line[p - 3 + axis]);
                            for (int axis = 0; axis < 3; axis++) segments.Add(line[p + axis]);
                        }
                        objects.Add(new { id, nativeId = handle, name = entity.Layer + " / " + handle, kind = "polyline" });
                        scene.Add(new { id, nativeId = handle, nativeType = entity.GetType().Name, segments,
                            layer64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(entity.Layer)), color = entity.ColorIndex, valid = true });
                    }
                    if (lines.Count > 0) displayed++;
                    else Increment(omitted, unsupported.Count == 0 ? "Hidden" : entity.GetType().Name);
                    // Report unsupported children even when a block has some supported curves.
                    foreach (var item in unsupported) Increment(warnings, item.Key, item.Value);
                }
                int read = Math.Min(limit, ids.Length - offset);
                return new { ok = true, offset, total = ids.Length, next = offset + read, revision,
                    objects, scene, displayed, omitted = read - displayed, omittedTypes = omitted, displayWarnings = warnings };
            }
        }
        private static void Increment(Dictionary<string, int> counts, string type, int n = 1)
        { int current; counts.TryGetValue(type, out current); counts[type] = current + n; }
        private static void Collect(Entity e, Transaction tx, Matrix3d transform, double scale, HashSet<ObjectId> parents,
            List<double[]> lines, Dictionary<string, int> unsupported)
        {
            var layer = (LayerTableRecord)tx.GetObject(e.LayerId, OpenMode.ForRead);
            if (!e.Visible || layer.IsOff || layer.IsFrozen) return;
            var block = e as BlockReference;
            if (block != null) {
                if (!parents.Add(block.BlockTableRecord)) { Increment(unsupported, "CyclicBlock"); return; }
                try {
                    var definition = (BlockTableRecord)tx.GetObject(block.BlockTableRecord, OpenMode.ForRead);
                    foreach (ObjectId child in definition) {
                        var item = tx.GetObject(child, OpenMode.ForRead) as Entity;
                        if (item != null) Collect(item, tx, transform * block.BlockTransform, scale, parents, lines, unsupported);
                    }
                } finally { parents.Remove(block.BlockTableRecord); }
                return;
            }
            var curve = e as Curve;
            if (curve != null) {
                try {
                    var points = new List<double>();
                    var poly = curve as Polyline;
                    if (poly != null) {
                        int segments = poly.Closed ? poly.NumberOfVertices : poly.NumberOfVertices - 1;
                        for (int i = 0; i < segments; i++) {
                            int steps = Math.Abs(poly.GetBulgeAt(i)) > 1e-12 ? 24 : 1;
                            for (int j = 0; j < steps; j++) Add(points, curve.GetPointAtParameter(i + (double)j / steps), transform, scale);
                        }
                        Add(points, curve.GetPointAtParameter(curve.EndParam), transform, scale);
                    } else {
                        int steps = curve is Line ? 1 : 72;
                        for (int i = 0; i <= steps; i++) Add(points, curve.GetPointAtParameter(curve.StartParam + (curve.EndParam - curve.StartParam) * i / steps), transform, scale);
                    }
                    if (points.Count >= 6) lines.Add(points.ToArray());
                    return;
                } catch (System.Exception) { Increment(unsupported, e.GetType().Name); return; }
            }
            // Dimensions expose their native generated graphics as temporary entities.
            if (e is Dimension) {
                using (var parts = new DBObjectCollection()) {
                    try {
                        e.Explode(parts);
                        foreach (DBObject part in parts) {
                            using (part) { var item = part as Entity; if (item != null) Collect(item, tx, transform, scale, parents, lines, unsupported); }
                        }
                    } catch (System.Exception) { Increment(unsupported, e.GetType().Name); }
                }
                return;
            }
            Increment(unsupported, e.GetType().Name);
        }
        private static void Add(List<double> points, Point3d p, Matrix3d transform, double scale)
        {
            p = p.TransformBy(transform);
            foreach (double value in new[] { p.X * scale, p.Y * scale, p.Z * scale }) {
                if (Double.IsNaN(value) || Double.IsInfinity(value)) throw new InvalidOperationException("INVALID_GEOMETRY");
                points.Add(value);
            }
        }
    }
}
