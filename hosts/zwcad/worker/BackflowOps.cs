// 역반영 읽기·적용 (SPEC-14.6·14.8·14.11, PLAN-47 T-233, ARCH-01 「도면 역반영(PLAN-47)」). Shared by the
// hidden worker (DrawingBackflow.cs, side databases) and the connection plugin (the user's open
// drawing, one UNDO step), so both read and write a drawing the same way:
//  - Entities(db, tr): model space entities with the geometry a backflow compares (LINE, LWPOLYLINE
//    with bulges, ARC, CIRCLE, block INSERT; other types and non +Z normals carry no geometry), the
//    kept properties and the VIDE_ORIGIN xdata;
//  - Dimensions(db, tr): model space dimensions with their definition points and whether they are
//    associative (the dimension's own points only: never its text style or arrowheads, SafeRead);
//  - Snapshot(db, tr): what the preservation check compares (SPEC-14.6): every live handle and its
//    class, an entity digest per handle, symbol table names, layouts and xref paths;
//  - Apply(db, tr, ops, revision): modify/add/delete in place. Modify keeps the entity (handle,
//    layer, colour, linetype, lineweight, block membership, dimension style); an INSERT only gets
//    its position and rotation. Add uses an existing layer only. New and modified entities get the
//    origin mark (1000 link:object, 1000 handle at write, 1071 revision). One failing op fails all
//    (the caller aborts the transaction). This is the engine's write, not AI code: SdkCompiler still
//    denies Vide.* to generated code.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Geometry;

namespace Vide.Zwcad
{
    internal sealed class BackflowRefused : Exception
    {
        internal BackflowRefused(string code) : base(code) { Code = code; }
        internal string Code { get; }
    }

    internal static class BackflowOps
    {
        internal const string App = "VIDE_ORIGIN";
        /** Coordinates beyond this (drawing units) are refused as input. */
        const double Far = 1e9;
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        /** AC1015 … AC1032 (the DWG header magic) of a version; another version by its name. */
        internal static string Version(DwgVersion version)
        {
            switch (version)
            {
                case DwgVersion.AC1015: return "AC1015";
                case DwgVersion.AC1800: return "AC1018";
                case DwgVersion.AC1021: return "AC1021";
                case DwgVersion.AC1024: return "AC1024";
                case DwgVersion.AC1027: return "AC1027";
                case DwgVersion.AC1032: return "AC1032";
                default: return version.ToString();
            }
        }

        static double R(double value) => Math.Round(value, 6);
        static double[] P(Point3d p) => new[] { R(p.X), R(p.Y), R(p.Z) };
        static bool PlusZ(Vector3d normal) => Math.Abs(normal.X) < 1e-9 && Math.Abs(normal.Y) < 1e-9 && normal.Z > 0;
        static T Try<T>(Func<T> read, T fallback) { try { return read(); } catch (System.Exception) { return fallback; } }

        // ---- reading ---------------------------------------------------------------------------

        /** The backflow geometry of an entity, or null for a type a backflow does not write. */
        internal static Dictionary<string, object> Geometry(Entity entity, Transaction tr)
        {
            switch (entity)
            {
                case Line line:
                    return new Dictionary<string, object> { ["kind"] = "line", ["points"] = new[] { P(line.StartPoint), P(line.EndPoint) } };
                case Polyline poly:
                    {
                        if (!PlusZ(poly.Normal)) return null;
                        int n = poly.NumberOfVertices;
                        var points = new List<double[]>(); var bulges = new List<double>();
                        for (int i = 0; i < n; i++)
                        {
                            var v = poly.GetPoint2dAt(i);
                            points.Add(new[] { R(v.X), R(v.Y), R(poly.Elevation) });
                            bulges.Add(Math.Round(poly.GetBulgeAt(i), 9));
                        }
                        var row = new Dictionary<string, object> { ["kind"] = "polyline", ["points"] = points, ["closed"] = poly.Closed };
                        if (bulges.Exists(b => Math.Abs(b) > 1e-12)) row["bulges"] = bulges;
                        return row;
                    }
                case Arc arc:
                    if (!PlusZ(arc.Normal)) return null;
                    return new Dictionary<string, object> { ["kind"] = "arc", ["center"] = P(arc.Center), ["radius"] = R(arc.Radius), ["start"] = arc.StartAngle, ["end"] = arc.EndAngle };
                case Circle circle:
                    if (!PlusZ(circle.Normal)) return null;
                    return new Dictionary<string, object> { ["kind"] = "circle", ["center"] = P(circle.Center), ["radius"] = R(circle.Radius) };
                case BlockReference insert:
                    {
                        if (!PlusZ(insert.Normal)) return null;
                        var scale = insert.ScaleFactors;
                        return new Dictionary<string, object> {
                            ["kind"] = "insert", ["block"] = BlockName(insert, tr), ["position"] = P(insert.Position),
                            ["rotation"] = insert.Rotation, ["scale"] = new[] { R(scale.X), R(scale.Y), R(scale.Z) } };
                    }
            }
            return null;
        }

        static string BlockName(BlockReference insert, Transaction tr)
        {
            // The dynamic block's own name, not its anonymous representation (*U…).
            var id = Try(() => insert.DynamicBlockTableRecord, ObjectId.Null);
            if (id.IsNull) id = insert.BlockTableRecord;
            return Try(() => ((BlockTableRecord)tr.GetObject(id, OpenMode.ForRead)).Name, insert.Name);
        }

        /** `[code, value]` pairs of the VIDE_ORIGIN xdata after the application name, or null. */
        internal static List<object[]> Origin(DBObject entity)
        {
            using (ResultBuffer buffer = Try(() => entity.GetXDataForApplication(App), (ResultBuffer)null))
            {
                if (buffer == null) return null;
                var values = new List<object[]>();
                foreach (TypedValue value in buffer)
                    if (value.TypeCode != 1001) values.Add(new object[] { (int)value.TypeCode, value.Value is string ? value.Value : Convert.ToDouble(value.Value, Inv) });
                return values;
            }
        }

        static Dictionary<string, object> Props(Entity entity)
        {
            return new Dictionary<string, object> {
                ["color"] = Try(() => entity.Color.IsByAci || entity.Color.IsByLayer || entity.Color.IsByBlock ? (object)(int)entity.ColorIndex : entity.Color.ColorValue.ToArgb(), (object)256),
                ["linetype"] = Try(() => entity.Linetype, ""),
                ["lineweight"] = Try(() => (int)entity.LineWeight, -1),
            };
        }

        /** One entity as the engine reads it (src/core/drawing-backflow.ts `entityFromRow`). */
        internal static Dictionary<string, object> Row(Entity entity, Transaction tr, string owner)
        {
            var row = new Dictionary<string, object> {
                ["h"] = entity.Handle.ToString(), ["t"] = entity.GetType().Name, ["l"] = Try(() => entity.Layer, ""),
                ["o"] = owner, ["g"] = Try(() => Geometry(entity, tr), (Dictionary<string, object>)null), ["p"] = Props(entity),
            };
            if (entity is BlockReference insert)
            {
                if (Try(() => insert.IsDynamicBlock, false)) row["dyn"] = true;
                var record = Try(() => (BlockTableRecord)tr.GetObject(insert.BlockTableRecord, OpenMode.ForRead), (BlockTableRecord)null);
                if (record != null && Try(() => record.IsFromExternalReference, false)) row["xr"] = true;
            }
            var origin = Origin(entity);
            if (origin != null) row["x"] = origin;
            return row;
        }

        static BlockTableRecord Model(Database db, Transaction tr, OpenMode mode = OpenMode.ForRead)
        {
            var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            return (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], mode);
        }

        /** Model space entities (rows), optionally only some handles. */
        internal static List<object> Entities(Database db, Transaction tr, ICollection<string> only = null)
        {
            var rows = new List<object>();
            foreach (ObjectId id in Model(db, tr))
            {
                if (only != null && !only.Contains(id.Handle.ToString())) continue;
                var entity = Try(() => tr.GetObject(id, OpenMode.ForRead) as Entity, null);
                if (entity == null || entity is Dimension) continue;
                rows.Add(Row(entity, tr, "model"));
            }
            return rows;
        }

        /** Layer names of the drawing (an added entity may use only these). */
        internal static List<string> Layers(Database db, Transaction tr)
        {
            var names = new List<string>();
            foreach (ObjectId id in (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead))
                names.Add(((LayerTableRecord)tr.GetObject(id, OpenMode.ForRead)).Name);
            return names;
        }

        static bool Associative(Dimension dimension, Transaction tr)
        {
            try
            {
                var extension = dimension.ExtensionDictionary;
                if (!extension.IsNull && tr.GetObject(extension, OpenMode.ForRead) is DBDictionary dictionary)
                    foreach (DBDictionaryEntry entry in dictionary)
                        if (entry.Key.IndexOf("DIMASSOC", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }
            catch (System.Exception) { }
            try
            {
                var reactors = dimension.GetPersistentReactorIds();
                if (reactors != null)
                    foreach (ObjectId id in reactors)
                        if (!id.IsNull && id.ObjectClass.Name.IndexOf("DimAssoc", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }
            catch (System.Exception) { }
            return false;
        }

        /** The points a dimension measures between (its own definition points only). */
        static List<double[]> DefinitionPoints(Dimension dimension)
        {
            var points = new List<double[]>();
            Action<Func<Point3d>> add = read => { try { points.Add(P(read())); } catch (System.Exception) { } };
            switch (dimension)
            {
                case RotatedDimension d: add(() => d.XLine1Point); add(() => d.XLine2Point); break;
                case AlignedDimension d: add(() => d.XLine1Point); add(() => d.XLine2Point); break;
                case RadialDimension d: add(() => d.Center); add(() => d.ChordPoint); break;
                case DiametricDimension d: add(() => d.ChordPoint); add(() => d.FarChordPoint); break;
                case ArcDimension d: add(() => d.XLine1Point); add(() => d.XLine2Point); add(() => d.ArcPoint); break;
                case Point3AngularDimension d: add(() => d.CenterPoint); add(() => d.XLine1Point); add(() => d.XLine2Point); break;
                case LineAngularDimension2 d: add(() => d.XLine1Start); add(() => d.XLine1End); add(() => d.XLine2Start); add(() => d.XLine2End); break;
            }
            return points;
        }

        /** Model space dimensions: handle, type, layer, associative, definition points. */
        internal static List<object> Dimensions(Database db, Transaction tr)
        {
            var rows = new List<object>();
            foreach (ObjectId id in Model(db, tr))
            {
                var dimension = Try(() => tr.GetObject(id, OpenMode.ForRead) as Dimension, null);
                if (dimension == null) continue;
                rows.Add(new Dictionary<string, object> {
                    ["h"] = dimension.Handle.ToString(), ["t"] = dimension.GetType().Name, ["l"] = Try(() => dimension.Layer, ""),
                    ["assoc"] = Associative(dimension, tr), ["pts"] = DefinitionPoints(dimension),
                    ["m"] = Try(() => (object)R(dimension.Measurement), null) });
            }
            return rows;
        }

        // ---- snapshot (SPEC-14.6) ----------------------------------------------------------------

        static string Hash(string text)
        {
            using (var sha = SHA1.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").Substring(0, 16);
        }

        /** What an untouched entity must keep: type, owner, layer, properties, geometry, text. */
        static string Digest(Entity entity, Transaction tr, string owner)
        {
            var s = new StringBuilder(entity.GetType().Name).Append('|').Append(owner).Append('|').Append(Try(() => entity.Layer, ""));
            foreach (var pair in Props(entity)) s.Append('|').Append(Convert.ToString(pair.Value, Inv));
            var geometry = Try(() => Geometry(entity, tr), (Dictionary<string, object>)null);
            if (geometry != null) s.Append('|').Append(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(geometry));
            else
            {
                switch (entity)
                {
                    case DBText text: s.Append('|').Append(Try(() => text.TextString, "")).Append('|').Append(string.Join(",", P(text.Position))); break;
                    case MText text: s.Append('|').Append(Try(() => text.Contents, "")).Append('|').Append(string.Join(",", P(text.Location))); break;
                    case Dimension dimension:
                        foreach (var p in DefinitionPoints(dimension)) s.Append('|').Append(string.Join(",", p));
                        s.Append('|').Append(Try(() => dimension.DimensionText, ""));
                        break;
                    case Curve curve:
                        try { s.Append('|').Append(string.Join(",", P(curve.StartPoint))).Append('|').Append(string.Join(",", P(curve.EndPoint))); } catch (System.Exception) { s.Append("|?"); }
                        break;
                }
            }
            var origin = Origin(entity);
            if (origin != null) foreach (var value in origin) s.Append('|').Append(Convert.ToString(value[1], Inv));
            return Hash(s.ToString());
        }

        static List<string> Names(Transaction tr, ObjectId table)
        {
            var names = new List<string>();
            foreach (ObjectId id in (SymbolTable)tr.GetObject(table, OpenMode.ForRead))
                names.Add(Try(() => ((SymbolTableRecord)tr.GetObject(id, OpenMode.ForRead)).Name, id.Handle.ToString()));
            names.Sort(StringComparer.Ordinal);
            return names;
        }

        /**
         * Where each object of the named object dictionary sits (`KEY/SUBKEY…`, handle → path, at most
         * 6 levels and 20000 entries): a save adds some of these by itself (SAVE_CHURN_PATHS).
         */
        static Dictionary<string, object> Named(Database db, Transaction tr)
        {
            var named = new Dictionary<string, object>();
            var queue = new Queue<KeyValuePair<ObjectId, string>>();
            queue.Enqueue(new KeyValuePair<ObjectId, string>(db.NamedObjectsDictionaryId, ""));
            while (queue.Count > 0 && named.Count < 20000)
            {
                var item = queue.Dequeue();
                var dictionary = Try(() => tr.GetObject(item.Key, OpenMode.ForRead) as DBDictionary, null);
                if (dictionary == null) continue;
                foreach (DBDictionaryEntry entry in dictionary)
                {
                    string path = item.Value.Length == 0 ? entry.Key : item.Value + "/" + entry.Key;
                    named[entry.Value.Handle.ToString()] = path;
                    if (path.Split('/').Length < 6 && Try(() => entry.Value.ObjectClass.Name, "") == "AcDbDictionary")
                        queue.Enqueue(new KeyValuePair<ObjectId, string>(entry.Value, path));
                }
            }
            return named;
        }

        /**
         * Handles 1..HANDSEED with their class, entity digests of every space and block definition
         * (not xrefs), symbol table names, layouts and xref paths. The engine compares two of these
         * (src/core/drawing-backflow-apply.ts `preservation`).
         */
        internal static Dictionary<string, object> Snapshot(Database db, Transaction tr)
        {
            var objects = new Dictionary<string, object>();
            long seed = Try(() => Convert.ToInt64(db.Handseed.ToString(), 16), 0L);
            for (long h = 1; h < seed; h++)
            {
                ObjectId id;
                if (!db.TryGetObjectId(new Handle(h), out id) || id.IsNull || id.IsErased) continue;
                objects[h.ToString("X")] = Try(() => id.ObjectClass.Name, "?");
            }
            // Dictionaries and xrecords outside the named object dictionary: whose they are (owner class).
            var named = Named(db, tr);
            var owners = new Dictionary<string, object>();
            foreach (var pair in objects)
            {
                string kind = (string)pair.Value;
                if ((kind != "AcDbDictionary" && kind != "AcDbXrecord") || named.ContainsKey(pair.Key) || owners.Count >= 20000) continue;
                ObjectId id;
                if (!db.TryGetObjectId(new Handle(Convert.ToInt64(pair.Key, 16)), out id)) continue;
                var owner = Try(() => tr.GetObject(id, OpenMode.ForRead).OwnerId, ObjectId.Null);
                owners[pair.Key] = owner.IsNull ? "" : Try(() => owner.ObjectClass.Name + ":" + owner.Handle.ToString(), "?");
            }
            var digests = new Dictionary<string, object>();
            var blocks = new List<object>(); var layouts = new List<object>(); var xrefs = new List<object>();
            foreach (ObjectId recordId in (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead))
            {
                var record = (BlockTableRecord)tr.GetObject(recordId, OpenMode.ForRead);
                bool xref = Try(() => record.IsFromExternalReference, false);
                blocks.Add(record.Name);
                if (xref) xrefs.Add(new Dictionary<string, object> { ["name"] = record.Name, ["path"] = Try(() => record.PathName ?? "", "") });
                string owner = "block:" + record.Name;
                if (record.IsLayout)
                {
                    var layout = Try(() => (Layout)tr.GetObject(record.LayoutId, OpenMode.ForRead), (Layout)null);
                    owner = String.Equals(record.Name, BlockTableRecord.ModelSpace, StringComparison.OrdinalIgnoreCase) ? "model" : "paper";
                    if (layout != null)
                        layouts.Add(new Dictionary<string, object> {
                            ["name"] = Try(() => layout.LayoutName, ""), ["tab"] = Try(() => layout.TabOrder, -1),
                            ["media"] = Try(() => layout.CanonicalMediaName, ""), ["device"] = Try(() => layout.PlotConfigurationName, ""),
                            ["styleSheet"] = Try(() => layout.CurrentStyleSheet, ""), ["plotType"] = Try(() => layout.PlotType.ToString(), "") });
                }
                if (xref || Try(() => record.IsDependent, false)) continue;
                foreach (ObjectId id in record)
                {
                    var entity = Try(() => tr.GetObject(id, OpenMode.ForRead) as Entity, null);
                    if (entity != null) digests[entity.Handle.ToString()] = Try(() => Digest(entity, tr, owner), "?");
                }
            }
            blocks.Sort((a, b) => String.CompareOrdinal((string)a, (string)b));
            return new Dictionary<string, object> {
                ["version"] = Version(db.OriginalFileVersion), ["units"] = (int)db.Insunits,
                ["objects"] = objects, ["digests"] = digests,
                ["tables"] = new Dictionary<string, object> {
                    ["layers"] = Names(tr, db.LayerTableId), ["linetypes"] = Names(tr, db.LinetypeTableId),
                    ["textStyles"] = Names(tr, db.TextStyleTableId), ["dimStyles"] = Names(tr, db.DimStyleTableId),
                    ["regApps"] = Names(tr, db.RegAppTableId), ["blocks"] = blocks },
                ["layouts"] = layouts, ["xrefs"] = xrefs, ["named"] = named, ["owners"] = owners };
        }

        // ---- applying ----------------------------------------------------------------------------

        static double Num(object value)
        {
            double n = Convert.ToDouble(value, Inv);
            if (Double.IsNaN(n) || Double.IsInfinity(n) || Math.Abs(n) > Far) throw new BackflowRefused("INVALID_GEOMETRY");
            return n;
        }
        static Point3d Pt(object value)
        {
            var list = value as ArrayList;
            if (list == null || list.Count != 3) throw new BackflowRefused("INVALID_GEOMETRY");
            return new Point3d(Num(list[0]), Num(list[1]), Num(list[2]));
        }
        static string Str(Dictionary<string, object> map, string key)
        {
            object value; return map.TryGetValue(key, out value) && value != null ? Convert.ToString(value, Inv) : null;
        }

        sealed class Shape
        {
            internal string Kind; internal List<Point3d> Points = new List<Point3d>(); internal List<double> Bulges = new List<double>();
            internal bool Closed; internal Point3d Center; internal double Radius, Start, End, Rotation;
        }

        static Shape Parse(object value)
        {
            var map = value as Dictionary<string, object>;
            if (map == null) throw new BackflowRefused("INVALID_GEOMETRY");
            var shape = new Shape { Kind = Str(map, "kind") };
            switch (shape.Kind)
            {
                case "line":
                case "polyline":
                    {
                        var points = map["points"] as ArrayList;
                        if (points == null || points.Count < 2 || points.Count > 100000) throw new BackflowRefused("INVALID_GEOMETRY");
                        foreach (object p in points) shape.Points.Add(Pt(p));
                        object bulges;
                        if (map.TryGetValue("bulges", out bulges) && bulges is ArrayList list)
                            foreach (object b in list) shape.Bulges.Add(Num(b));
                        object closed; shape.Closed = map.TryGetValue("closed", out closed) && Convert.ToBoolean(closed, Inv);
                        if (shape.Kind == "line" && shape.Points.Count != 2) throw new BackflowRefused("INVALID_GEOMETRY");
                        break;
                    }
                case "arc":
                case "circle":
                    shape.Center = Pt(map["center"]); shape.Radius = Num(map["radius"]);
                    if (!(shape.Radius > 0)) throw new BackflowRefused("INVALID_GEOMETRY");
                    if (shape.Kind == "arc") { shape.Start = Num(map["start"]); shape.End = Num(map["end"]); }
                    break;
                case "insert":
                    shape.Center = Pt(map["position"]); shape.Rotation = Num(map["rotation"]);
                    break;
                default: throw new BackflowRefused("INVALID_GEOMETRY");
            }
            return shape;
        }

        static double Bulge(Shape shape, int i) => i < shape.Bulges.Count ? shape.Bulges[i] : 0;

        /** A planar polyline (one elevation) of the shape's points; the closing point dropped. */
        static void SetPolyline(Polyline poly, Shape shape)
        {
            var points = new List<Point3d>(shape.Points);
            bool closed = shape.Closed;
            if (points.Count > 2 && points[0].DistanceTo(points[points.Count - 1]) < 1e-9) { points.RemoveAt(points.Count - 1); closed = true; }
            double z = points[0].Z;
            foreach (var p in points) if (Math.Abs(p.Z - z) > 1e-6) throw new BackflowRefused("NOT_PLANAR");
            if (points.Count < 2) throw new BackflowRefused("INVALID_GEOMETRY");
            while (poly.NumberOfVertices > points.Count) poly.RemoveVertexAt(poly.NumberOfVertices - 1);
            for (int i = 0; i < points.Count; i++)
            {
                var point = new Point2d(points[i].X, points[i].Y);
                if (i < poly.NumberOfVertices) { poly.SetPointAt(i, point); poly.SetBulgeAt(i, Bulge(shape, i)); }
                else poly.AddVertexAt(i, point, Bulge(shape, i), 0, 0);
            }
            poly.Closed = closed; poly.Elevation = z;
        }

        static void Modify(Entity entity, Shape shape)
        {
            switch (entity)
            {
                case Line line when shape.Kind == "line" || (shape.Kind == "polyline" && shape.Points.Count == 2 && !shape.Closed && Math.Abs(Bulge(shape, 0)) < 1e-12):
                    line.StartPoint = shape.Points[0]; line.EndPoint = shape.Points[1];
                    return;
                case Polyline poly when (shape.Kind == "line" || shape.Kind == "polyline") && PlusZ(poly.Normal):
                    SetPolyline(poly, shape);
                    return;
                case Arc arc when shape.Kind == "arc" && PlusZ(arc.Normal):
                    arc.Center = shape.Center; arc.Radius = shape.Radius; arc.StartAngle = shape.Start; arc.EndAngle = shape.End;
                    return;
                case Circle circle when shape.Kind == "circle" && PlusZ(circle.Normal):
                    circle.Center = shape.Center; circle.Radius = shape.Radius;
                    return;
                case BlockReference insert when shape.Kind == "insert" && PlusZ(insert.Normal):
                    // Position and rotation only: the block, its scale and attributes stay.
                    insert.Position = shape.Center; insert.Rotation = shape.Rotation;
                    return;
            }
            throw new BackflowRefused("TYPE_CHANGED");
        }

        static Entity Create(Shape shape)
        {
            switch (shape.Kind)
            {
                case "line": return new Line(shape.Points[0], shape.Points[1]);
                case "polyline": { var poly = new Polyline(); SetPolyline(poly, shape); return poly; }
                case "arc": return new Arc(shape.Center, shape.Radius, shape.Start, shape.End);
                case "circle": return new Circle(shape.Center, Vector3d.ZAxis, shape.Radius);
            }
            throw new BackflowRefused("SOURCE_TYPE");
        }

        static void EnsureApp(Database db, Transaction tr)
        {
            var apps = (RegAppTable)tr.GetObject(db.RegAppTableId, OpenMode.ForRead);
            if (apps.Has(App)) return;
            apps.UpgradeOpen();
            var app = new RegAppTableRecord { Name = App };
            apps.Add(app); tr.AddNewlyCreatedDBObject(app, true);
        }

        static void Mark(Entity entity, string origin, int revision)
        {
            if (String.IsNullOrEmpty(origin)) return;
            entity.XData = new ResultBuffer(new TypedValue(1001, App), new TypedValue(1000, origin),
                new TypedValue(1000, entity.Handle.ToString()), new TypedValue(1071, revision));
        }

        static bool Locked(Transaction tr, ObjectId layer) =>
            Try(() => ((LayerTableRecord)tr.GetObject(layer, OpenMode.ForRead)).IsLocked, false);

        /**
         * Applies the ops in this transaction. Every op answers {id, ok, handle | code}; the first
         * refusal makes the whole result `ok: false` and the caller must abort the transaction.
         */
        internal static Dictionary<string, object> Apply(Database db, Transaction tr, ArrayList ops, int revision)
        {
            var results = new List<object>(); var failed = new List<object>();
            var changed = new List<string>(); var added = new List<string>(); var erased = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            bool marked = false;
            foreach (object item in ops)
            {
                var op = item as Dictionary<string, object>;
                string id = op == null ? "?" : Str(op, "id") ?? "?";
                try
                {
                    if (op == null) throw new BackflowRefused("INVALID_INPUT");
                    string kind = Str(op, "op"), origin = Str(op, "origin");
                    if (origin != null && origin.Length > 300) throw new BackflowRefused("INVALID_INPUT");
                    if (kind == "add")
                    {
                        var shape = Parse(op["geometry"]);
                        string layerName = Str(op, "layer");
                        var layers = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                        // Never a new layer (SPEC-14.8 3), never an xref-dependent one.
                        if (String.IsNullOrEmpty(layerName) || layerName.Contains("|") || !layers.Has(layerName)) throw new BackflowRefused("LAYER_MISSING");
                        if (Locked(tr, layers[layerName])) throw new BackflowRefused("LAYER_LOCKED");
                        var entity = Create(shape);
                        entity.SetDatabaseDefaults(db);
                        entity.LayerId = layers[layerName];
                        Model(db, tr, OpenMode.ForWrite).AppendEntity(entity); tr.AddNewlyCreatedDBObject(entity, true);
                        if (!marked) { EnsureApp(db, tr); marked = true; }
                        Mark(entity, origin, revision);
                        added.Add(entity.Handle.ToString());
                        results.Add(new Dictionary<string, object> { ["id"] = id, ["ok"] = true, ["handle"] = entity.Handle.ToString() });
                        continue;
                    }
                    string handle = Str(op, "handle");
                    long value;
                    if (String.IsNullOrEmpty(handle) || !Int64.TryParse(handle, NumberStyles.HexNumber, Inv, out value) || !seen.Add(handle)) throw new BackflowRefused("INVALID_INPUT");
                    ObjectId target;
                    if (!db.TryGetObjectId(new Handle(value), out target) || target.IsNull || target.IsErased) throw new BackflowRefused("ENTITY_MISSING");
                    var current = tr.GetObject(target, OpenMode.ForRead) as Entity;
                    // Only model space entities of this file (never inside a block or an xref).
                    if (current == null || current.OwnerId != Model(db, tr).ObjectId) throw new BackflowRefused("ENTITY_MISSING");
                    if (Locked(tr, current.LayerId)) throw new BackflowRefused("LAYER_LOCKED");
                    if (kind == "delete")
                    {
                        current.UpgradeOpen(); current.Erase();
                        erased.Add(handle.ToUpperInvariant());
                    }
                    else if (kind == "modify")
                    {
                        var shape = Parse(op["geometry"]);
                        if (current is BlockReference insert && (Try(() => insert.IsDynamicBlock, false) ||
                            Try(() => ((BlockTableRecord)tr.GetObject(insert.BlockTableRecord, OpenMode.ForRead)).IsFromExternalReference, false)))
                            throw new BackflowRefused("TYPE_CHANGED");
                        current.UpgradeOpen();
                        Modify(current, shape);
                        if (origin != null)
                        {
                            if (!marked) { EnsureApp(db, tr); marked = true; }
                            Mark(current, origin, revision);
                        }
                        changed.Add(current.Handle.ToString());
                    }
                    else throw new BackflowRefused("INVALID_INPUT");
                    results.Add(new Dictionary<string, object> { ["id"] = id, ["ok"] = true, ["handle"] = handle.ToUpperInvariant() });
                }
                catch (BackflowRefused refused) { failed.Add(new Dictionary<string, object> { ["id"] = id, ["code"] = refused.Code }); }
                catch (System.Exception error) { failed.Add(new Dictionary<string, object> { ["id"] = id, ["code"] = "WRITE_FAILED", ["message"] = error.GetType().Name + ": " + error.Message }); }
            }
            return new Dictionary<string, object> {
                ["ok"] = failed.Count == 0, ["results"] = results, ["failed"] = failed,
                ["changed"] = changed, ["added"] = added, ["erased"] = erased };
        }
    }
}
