using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.DatabaseServices.Filters;
using ZwSoft.ZwCAD.Geometry;

namespace Vide.Zwcad.Connection
{
    // Read-only display data. This never substitutes tessellated geometry for native DWG data.
    // Styles are resolved like CAD draws them: ByLayer/ByBlock, layer 0 inside blocks, lineweights.
    internal static class AttachedDisplay
    {
        private sealed class DisplayLimitException : System.Exception { }
        private sealed class Style
        {
            internal int Aci = 7;
            internal string Rgb;
            internal double Lw = 0.25;
            internal string LayerName = "0";
            internal string LayerHex;
            internal string Key { get { return Aci + "|" + Rgb + "|" + Lw + "|" + LayerHex; } }
            internal Dictionary<string, object> Fields()
            {
                var fields = new Dictionary<string, object> { { "ci", Aci }, { "lw", Lw } };
                if (Rgb != null) fields["rgb"] = Rgb;
                if (LayerHex != null) fields["layer"] = LayerHex;
                return fields;
            }
        }
        private sealed class Display
        {
            internal readonly List<double[]> Lines = new List<double[]>();
            internal readonly List<Dictionary<string, object>> Runs = new List<Dictionary<string, object>>();
            internal readonly List<Dictionary<string, object>> Fills = new List<Dictionary<string, object>>();
            internal readonly List<Dictionary<string, object>> Texts = new List<Dictionary<string, object>>();
            internal int CoordinateCount;
            private string lastKey;
            private void Count(int coordinates)
            {
                CoordinateCount += coordinates;
                if (CoordinateCount > 2000000) throw new DisplayLimitException();
            }
            internal void AddLine(double[] line, Style style)
            {
                int segments = line.Length / 3 - 1;
                if (segments < 1) return;
                Count(2 * (line.Length - 3));
                Lines.Add(line);
                if (Runs.Count > 0 && lastKey == style.Key) Runs[Runs.Count - 1]["n"] = (int)Runs[Runs.Count - 1]["n"] + segments;
                else { var run = style.Fields(); run["n"] = segments; Runs.Add(run); lastKey = style.Key; }
            }
            internal void AddFill(List<double[]> loops, Style style)
            {
                Count(loops.Sum(l => l.Length));
                var fill = style.Fields(); fill.Remove("lw"); fill["loops"] = loops; Fills.Add(fill);
            }
            internal void AddText(Dictionary<string, object> text, Style style)
            {
                Count(50);
                foreach (var item in style.Fields()) if (item.Key != "lw") text[item.Key] = item.Value;
                Texts.Add(text);
            }
            internal bool Empty { get { return Lines.Count == 0 && Fills.Count == 0 && Texts.Count == 0; } }
        }
        private sealed class Context
        {
            internal Transaction Tx;
            internal double Scale;
            internal LayerTable Layers;
            internal readonly Dictionary<string, LayerTableRecord> LayerCache = new Dictionary<string, LayerTableRecord>();
            internal Dictionary<string, int> Unsupported;
            internal LayerTableRecord Layer(string name)
            {
                LayerTableRecord record;
                if (!LayerCache.TryGetValue(name, out record)) {
                    record = Layers.Has(name) ? (LayerTableRecord)Tx.GetObject(Layers[name], OpenMode.ForRead) : null;
                    LayerCache[name] = record;
                }
                return record;
            }
        }

        internal static double Scale(Database db)
        {
            switch ((int)db.Insunits) {
                case 1: return .0254; case 2: return .3048; case 4: return .001;
                case 5: return .01; case 6: return 1; case 7: return 1000;
                default: throw new InvalidOperationException("UNKNOWN_UNITS");
            }
        }
        /**
         * One model space entity read for display: its object row and scene item, or the omission type
         * when nothing of it is shown; the unsupported children it reported either way.
         */
        internal sealed class EntityRead
        {
            internal string Handle;
            internal object Object;
            internal Dictionary<string, object> Item;
            internal string Omitted;
            internal readonly Dictionary<string, int> Warnings = new Dictionary<string, int>();
            internal int Coordinates;
        }
        private static EntityRead Read(Transaction tx, ObjectId oid, Context context)
        {
            var read = new EntityRead { Handle = oid.Handle.ToString() };
            try {
                var entity = tx.GetObject(oid, OpenMode.ForRead) as Entity;
                if (entity == null) return null;
                var display = new Display();
                context.Unsupported = new Dictionary<string, int>();
                var own = Resolve(entity, null, context);
                Collect(entity, context, Matrix3d.Identity, null, new HashSet<ObjectId>(), new List<Point2d[]>(), display);
                string handle = entity.Handle.ToString();
                read.Handle = handle;
                if (!display.Empty) {
                    string id = "cad-" + handle;
                    var segments = new List<double>();
                    foreach (var line in display.Lines) for (int p = 3; p < line.Length; p += 3) {
                        for (int axis = 0; axis < 3; axis++) segments.Add(line[p - 3 + axis]);
                        for (int axis = 0; axis < 3; axis++) segments.Add(line[p + axis]);
                    }
                    read.Object = new { id, nativeId = handle, name = entity.Layer + " / " + handle, kind = "polyline" };
                    var item = new Dictionary<string, object> {
                        { "id", id }, { "nativeId", handle }, { "nativeType", entity.GetType().Name }, { "segments", segments },
                        { "layer64", Convert.ToBase64String(Encoding.UTF8.GetBytes(entity.Layer)) }, { "color", entity.ColorIndex },
                        { "colorIndex", own.Aci }, { "lineWeight", own.Lw }, { "valid", true },
                    };
                    if (own.Rgb != null) item["displayColor"] = own.Rgb;
                    if (own.LayerHex != null) item["layerColor"] = own.LayerHex;
                    if (display.Runs.Count > 0) item["segmentStyles"] = display.Runs;
                    if (display.Fills.Count > 0) item["fills"] = display.Fills;
                    if (display.Texts.Count > 0) item["texts"] = display.Texts;
                    read.Item = item;
                    read.Coordinates = display.CoordinateCount;
                }
                else read.Omitted = context.Unsupported.Count == 0 ? "Hidden" : entity.GetType().Name;
                // Report unsupported children even when a block has some supported content.
                foreach (var item in context.Unsupported) Increment(read.Warnings, item.Key, item.Value);
            } catch (DisplayLimitException) {
                read.Item = null; read.Object = null; read.Omitted = "OversizedDisplay"; read.Warnings.Clear(); Increment(read.Warnings, "OversizedDisplay");
            } catch (ZwSoft.ZwCAD.Runtime.Exception) {
                read.Item = null; read.Object = null; read.Omitted = "UnreadableObject"; read.Warnings.Clear(); Increment(read.Warnings, "UnreadableObject");
            }
            return read;
        }
        private static Context ContextOf(Transaction tx, Database db) =>
            new Context { Tx = tx, Scale = Scale(db), Layers = (LayerTable)tx.GetObject(db.LayerTableId, OpenMode.ForRead) };

        /**
         * A page of model space (or of the layout block `spaceId`: a paper space of the title block
         * preview, PLAN-47 T-235); `seen` receives every entity read (Live Sync's display state).
         */
        internal static object Page(Database db, int offset, int limit, long revision, out int next, out int total, Action<EntityRead> seen = null, ObjectId spaceId = default(ObjectId))
        {
            using (var tx = db.TransactionManager.StartTransaction()) {
                var table = (BlockTable)tx.GetObject(db.BlockTableId, OpenMode.ForRead);
                var space = (BlockTableRecord)tx.GetObject(spaceId.IsNull ? table[BlockTableRecord.ModelSpace] : spaceId, OpenMode.ForRead);
                var ids = space.Cast<ObjectId>().ToArray();
                if (offset < 0 || offset > ids.Length || limit < 1 || limit > 250) throw new InvalidOperationException("INVALID_PAGE");
                var context = ContextOf(tx, db);
                var objects = new List<object>(); var scene = new List<object>();
                var omitted = new Dictionary<string, int>(); var warnings = new Dictionary<string, int>(); int displayed = 0, read = 0, pageCoordinates = 0;
                foreach (var oid in ids.Skip(offset).Take(limit)) {
                    read++;
                    var entity = Read(tx, oid, context);
                    if (entity == null) continue;
                    seen?.Invoke(entity);
                    if (entity.Item != null) { objects.Add(entity.Object); scene.Add(entity.Item); displayed++; pageCoordinates += entity.Coordinates; }
                    else Increment(omitted, entity.Omitted);
                    foreach (var item in entity.Warnings) Increment(warnings, item.Key, item.Value);
                    if (pageCoordinates > 2000000) break;
                }
                next = offset + read; total = ids.Length;
                return new { ok = true, offset, total = ids.Length, next = offset + read, revision,
                    objects, scene, displayed, omitted = read - displayed, omittedTypes = omitted, displayWarnings = warnings };
            }
        }

        /**
         * Live Sync (T-128): the model space entities among `changed` (in handle order, from `cursor`),
         * read like a page; those no longer in model space are `removed`. Any change that alters how
         * other entities draw (a layer, a block definition or its content, a text or dimension style,
         * an XCLIP boundary) asks for a full read (RESYNC_REQUIRED). Paper space edits are ignored.
         */
        internal static object Changes(Database db, IEnumerable<ObjectId> changed, int cursor, long revision,
            Action<EntityRead> seen, Action<string> gone, Func<object> coverage)
        {
            using (var tx = db.TransactionManager.StartTransaction()) {
                var table = (BlockTable)tx.GetObject(db.BlockTableId, OpenMode.ForRead);
                var model = table[BlockTableRecord.ModelSpace];
                // Handle order → the model space entity a change stands for, and whether it is gone.
                var effective = new SortedDictionary<long, KeyValuePair<ObjectId, bool>>();
                foreach (var id in changed) {
                    var entity = ModelSpaceEntity(tx, id, model, out bool resync, out bool removed);
                    if (resync) throw new InvalidOperationException("RESYNC_REQUIRED");
                    if (!entity.IsNull) effective[entity.Handle.Value] = new KeyValuePair<ObjectId, bool>(entity, removed);
                }
                var list = effective.Values.ToArray();
                if (cursor < 0 || cursor > list.Length) throw new InvalidOperationException("INVALID_PAGE");
                var context = ContextOf(tx, db);
                var objects = new List<object>(); var scene = new List<object>(); var removedHandles = new List<string>();
                int consumed = 0, upserts = 0, pageCoordinates = 0;
                foreach (var entry in list.Skip(cursor)) {
                    if (upserts == 250 || pageCoordinates > 2000000) break;
                    consumed++;
                    var handle = entry.Key.Handle.ToString();
                    if (entry.Value) { removedHandles.Add(handle); gone(handle); continue; }
                    upserts++;
                    var read = Read(tx, entry.Key, context);
                    if (read == null) { removedHandles.Add(handle); gone(handle); continue; }
                    seen(read);
                    if (read.Item != null) { objects.Add(read.Object); scene.Add(read.Item); pageCoordinates += read.Coordinates; }
                    // Still in model space but not shown any more: its row leaves the display.
                    else removedHandles.Add(handle);
                }
                return new { ok = true, cursor, next = cursor + consumed, changes = list.Length, revision,
                    objects, scene, removed = removedHandles, coverage = cursor + consumed >= list.Length ? coverage() : null };
            }
        }

        /**
         * The model space entity a changed object stands for: itself, or the entity that owns it (an
         * attribute, a polyline vertex); ObjectId.Null when the change shows nowhere (paper space, a
         * dictionary, a viewport). `removed`: that entity is gone (erased, or no longer readable).
         * `resync`: the change alters other entities' display.
         */
        private static ObjectId ModelSpaceEntity(Transaction tx, ObjectId id, ObjectId model, out bool resync, out bool removed)
        {
            resync = false; removed = false;
            DBObject obj;
            try { obj = tx.GetObject(id, OpenMode.ForRead, true); }
            // Unreadable (an undone append): if it was a shown row, its row leaves the display.
            catch (ZwSoft.ZwCAD.Runtime.Exception) { removed = true; return id; }
            if (obj is LayerTableRecord || obj is TextStyleTableRecord || obj is DimStyleTableRecord || obj is SpatialFilter) { resync = true; return ObjectId.Null; }
            var record = obj as BlockTableRecord;
            if (record != null) { resync = !record.IsLayout && !Dimensional(record); return ObjectId.Null; }
            var entity = obj as Entity;
            if (entity == null) return ObjectId.Null;
            for (int depth = 0; depth < 4; depth++) {
                if (entity.OwnerId == model) {
                    removed = entity.IsErased;
                    return entity.ObjectId;
                }
                DBObject owner;
                try { owner = tx.GetObject(entity.OwnerId, OpenMode.ForRead, true); }
                catch (ZwSoft.ZwCAD.Runtime.Exception) { return ObjectId.Null; }
                var space = owner as BlockTableRecord;
                // Paper space never shows; a block definition's content draws in every insert.
                if (space != null) { resync = !space.IsLayout && !Dimensional(space); return ObjectId.Null; }
                var parent = owner as Entity;
                if (parent == null) return ObjectId.Null;
                // An erased attribute or vertex changes its owner, which is read again.
                entity = parent;
            }
            resync = true;
            return ObjectId.Null;
        }
        // A dimension's own anonymous block (*D…): dimensions draw from their native graphics instead.
        private static bool Dimensional(BlockTableRecord record) =>
            record.IsAnonymous && record.Name.StartsWith("*D", StringComparison.OrdinalIgnoreCase);
        private static void Increment(Dictionary<string, int> counts, string type, int n = 1)
        { int current; counts.TryGetValue(type, out current); counts[type] = current + n; }

        private static string Hex(System.Drawing.Color color) { return "#" + color.R.ToString("x2") + color.G.ToString("x2") + color.B.ToString("x2"); }

        /** Resolve colour, lineweight and effective layer. Inside blocks, layer 0 follows the insert. */
        private static Style Resolve(Entity e, Style parent, Context context)
        {
            var style = new Style();
            style.LayerName = parent != null && e.Layer == "0" ? parent.LayerName : e.Layer;
            var layer = context.Layer(style.LayerName) ?? context.Layer(e.Layer);
            int layerAci = 7; string layerRgb = null; double layerLw = 0.25;
            if (layer != null) {
                try {
                    style.LayerHex = Hex(layer.Color.ColorValue);
                    if (layer.Color.IsByColor) layerRgb = style.LayerHex; else layerAci = Math.Max(1, Math.Min(255, (int)layer.Color.ColorIndex));
                } catch (System.Exception) { }
                layerLw = Weight((int)layer.LineWeight, 0.25);
            }
            var color = e.Color;
            if (color.IsByLayer) { style.Aci = layerAci; style.Rgb = layerRgb; }
            else if (color.IsByBlock) { style.Aci = parent != null ? parent.Aci : 7; style.Rgb = parent != null ? parent.Rgb : null; }
            else if (color.IsByColor) { style.Rgb = Hex(color.ColorValue); style.Aci = 7; }
            else style.Aci = Math.Max(1, Math.Min(255, (int)color.ColorIndex));
            int weight = (int)e.LineWeight;
            style.Lw = weight == -1 ? layerLw : weight == -2 ? (parent != null ? parent.Lw : 0.25) : Weight(weight, 0.25);
            return style;
        }
        private static double Weight(int hundredths, double fallback) { return hundredths > 0 ? hundredths / 100.0 : fallback; }

        private static void Collect(Entity e, Context context, Matrix3d transform, Style parent, HashSet<ObjectId> parents,
            List<Point2d[]> clips, Display display)
        {
            var tx = context.Tx;
            var ownLayer = (LayerTableRecord)tx.GetObject(e.LayerId, OpenMode.ForRead);
            if (!e.Visible || ownLayer.IsOff || ownLayer.IsFrozen) return;
            var style = Resolve(e, parent, context);
            var block = e as BlockReference;
            if (block != null) {
                if (!parents.Add(block.BlockTableRecord)) { Increment(context.Unsupported, "CyclicBlock"); return; }
                try {
                    var definition = (BlockTableRecord)tx.GetObject(block.BlockTableRecord, OpenMode.ForRead);
                    if (definition.IsFromExternalReference && !definition.IsResolved) { Increment(context.Unsupported, "UnloadedXref"); return; }
                    var nested = clips;
                    var clip = ClipPolygon(block, tx, transform, context.Scale);
                    if (clip != null) nested = new List<Point2d[]>(clips) { clip };
                    foreach (ObjectId child in definition) {
                        var item = tx.GetObject(child, OpenMode.ForRead) as Entity;
                        if (item != null && !(item is AttributeDefinition)) Collect(item, context, transform * block.BlockTransform, style, parents, nested, display);
                    }
                    // Attribute references are stored in the owner space, outside the block transform.
                    foreach (ObjectId attributeId in block.AttributeCollection) {
                        var attribute = tx.GetObject(attributeId, OpenMode.ForRead) as AttributeReference;
                        if (attribute != null && !attribute.Invisible) Collect(attribute, context, transform, style, parents, clips, display);
                    }
                } finally { parents.Remove(block.BlockTableRecord); }
                return;
            }
            var text = e as DBText;
            if (text != null) {
                if (String.IsNullOrWhiteSpace(text.TextString)) return;
                int horizontal = (int)text.HorizontalMode, vertical = (int)text.VerticalMode;
                int ax = horizontal == 0 ? 0 : horizontal == 2 ? 2 : 1;
                int ay = horizontal == 4 ? 2 : vertical;
                AddText(text.TextString, text.IsDefaultAlignment ? text.Position : text.AlignmentPoint, text.Height, text.Rotation,
                    text.WidthFactor, ax, ay, style, transform, context.Scale, clips, display);
                return;
            }
            var mtext = e as MText;
            if (mtext != null) {
                string value = (mtext.Text ?? "").Replace("\r\n", "\n").Replace("\\P", "\n");
                if (String.IsNullOrWhiteSpace(value)) return;
                int attachment = Math.Max(1, Math.Min(9, (int)mtext.Attachment));
                int row = (attachment - 1) / 3;
                AddText(value, mtext.Location, mtext.TextHeight, mtext.Rotation, 1, (attachment - 1) % 3, row == 0 ? 3 : row == 1 ? 2 : 1,
                    style, transform, context.Scale, clips, display);
                return;
            }
            var hatch = e as Hatch;
            if (hatch != null) { CollectHatch(hatch, context, transform, style, parents, clips, display); return; }
            var curve = e as Curve;
            if (curve != null) {
                try {
                    var points = new List<Point3d>();
                    var poly = curve as Polyline;
                    if (poly != null) {
                        int segments = poly.Closed ? poly.NumberOfVertices : poly.NumberOfVertices - 1;
                        for (int i = 0; i < segments; i++) {
                            int steps = Math.Abs(poly.GetBulgeAt(i)) > 1e-12 ? 24 : 1;
                            for (int j = 0; j < steps; j++) points.Add(curve.GetPointAtParameter(i + (double)j / steps));
                        }
                        points.Add(curve.GetPointAtParameter(curve.EndParam));
                    } else {
                        int steps = curve is Line ? 1 : 72;
                        for (int i = 0; i <= steps; i++) points.Add(curve.GetPointAtParameter(curve.StartParam + (curve.EndParam - curve.StartParam) * i / steps));
                    }
                    AddPolyline(points, transform, context.Scale, clips, style, display);
                    return;
                } catch (DisplayLimitException) { throw; } catch (System.Exception) { Increment(context.Unsupported, e.GetType().Name); return; }
            }
            // Dimensions and leaders expose their native generated graphics as temporary entities.
            if (e is Dimension || e is Leader || e is MLeader) { CollectExploded(e, context, transform, style, parents, clips, display); return; }
            Increment(context.Unsupported, e.GetType().Name);
        }

        private static void CollectExploded(Entity e, Context context, Matrix3d transform, Style style, HashSet<ObjectId> parents,
            List<Point2d[]> clips, Display display)
        {
            using (var parts = new DBObjectCollection()) {
                try {
                    e.Explode(parts);
                    foreach (DBObject part in parts) {
                        using (part) { var item = part as Entity; if (item != null) CollectPart(item, context, transform, style, parents, clips, display); }
                    }
                } catch (DisplayLimitException) { throw; } catch (System.Exception) { Increment(context.Unsupported, e.GetType().Name); }
            }
        }
        // Exploded parts are not database-resident; resolve their style from the parent without a layer lookup by id.
        private static void CollectPart(Entity part, Context context, Matrix3d transform, Style parent, HashSet<ObjectId> parents,
            List<Point2d[]> clips, Display display)
        {
            if (part.LayerId.IsNull || part.LayerId.IsErased) { Increment(context.Unsupported, part.GetType().Name); return; }
            Collect(part, context, transform, parent, parents, clips, display);
        }

        private static void CollectHatch(Hatch hatch, Context context, Matrix3d transform, Style style, HashSet<ObjectId> parents,
            List<Point2d[]> clips, Display display)
        {
            try {
                if (hatch.IsSolidFill || hatch.IsGradient) {
                    var plane = Matrix3d.PlaneToWorld(hatch.Normal);
                    var loops = new List<double[]>();
                    for (int i = 0; i < hatch.NumberOfLoops; i++) {
                        var loop = hatch.GetLoopAt(i);
                        var points = new List<Point2d>();
                        if (loop.IsPolyline) {
                            var vertices = loop.Polyline.Cast<BulgeVertex>().ToList();
                            for (int v = 0; v < vertices.Count; v++) {
                                var a = vertices[v].Vertex; var b = vertices[(v + 1) % vertices.Count].Vertex;
                                double bulge = vertices[v].Bulge;
                                if (Math.Abs(bulge) < 1e-12) { points.Add(a); continue; }
                                // Bulge = tan(angle/4): the arc passes through the chord midpoint offset by the sagitta.
                                double chord = a.GetDistanceTo(b), sagitta = bulge * chord / 2;
                                var mid = new Point2d((a.X + b.X) / 2, (a.Y + b.Y) / 2);
                                var normal = new Vector2d(-(b.Y - a.Y), b.X - a.X).GetNormal();
                                var arc = new CircularArc2d(a, mid + normal * -sagitta, b);
                                foreach (var p in arc.GetSamplePoints(16).Take(15)) points.Add(p);
                            }
                        } else {
                            foreach (Curve2d segment in loop.Curves) {
                                var samples = segment.GetSamplePoints(segment is LineSegment2d ? 2 : 24);
                                foreach (var p in samples.Take(samples.Length - 1)) points.Add(p);
                            }
                        }
                        if (points.Count < 3) continue;
                        var flat = new List<double>();
                        foreach (var p in points) {
                            var world = new Point3d(p.X, p.Y, hatch.Elevation).TransformBy(plane).TransformBy(transform);
                            flat.Add(world.X * context.Scale); flat.Add(world.Y * context.Scale); flat.Add(world.Z * context.Scale);
                        }
                        loops.Add(flat.ToArray());
                    }
                    if (loops.Count > 0 && Inside(loops[0], clips)) display.AddFill(loops, style);
                    return;
                }
                if (hatch.NumberOfHatchLines > 20000) { Increment(context.Unsupported, "DenseHatch"); return; }
                CollectExploded(hatch, context, transform, style, parents, clips, display);
            } catch (DisplayLimitException) { throw; } catch (System.Exception) { Increment(context.Unsupported, "Hatch"); }
        }

        private static void AddText(string value, Point3d position, double height, double rotation, double widthFactor, int ax, int ay,
            Style style, Matrix3d transform, double scale, List<Point2d[]> clips, Display display)
        {
            var p = position.TransformBy(transform);
            var direction = new Vector3d(Math.Cos(rotation), Math.Sin(rotation), 0).TransformBy(transform);
            var up = new Vector3d(-Math.Sin(rotation), Math.Cos(rotation), 0).TransformBy(transform);
            if (direction.Length < 1e-12 || height <= 0) return;
            var world = new Point2d(p.X * scale, p.Y * scale);
            foreach (var clip in clips) if (!Contains(clip, world)) return;
            var text = new Dictionary<string, object> {
                { "s", value.Length > 2000 ? value.Substring(0, 2000) : value },
                { "p", new[] { p.X * scale, p.Y * scale, p.Z * scale } },
                { "h", height * up.Length * scale },
                { "r", Math.Atan2(direction.Y, direction.X) },
                { "ax", ax }, { "ay", Math.Max(0, Math.Min(3, ay)) },
            };
            double factor = widthFactor * direction.Length / Math.Max(up.Length, 1e-12);
            if (Math.Abs(factor - 1) > 1e-6) text["wf"] = factor;
            display.AddText(text, style);
        }

        private static void AddPolyline(List<Point3d> points, Matrix3d transform, double scale, List<Point2d[]> clips, Style style, Display display)
        {
            var world = points.Select(p => { var q = p.TransformBy(transform); return new[] { q.X * scale, q.Y * scale, q.Z * scale }; }).ToList();
            foreach (var value in world.SelectMany(v => v))
                if (Double.IsNaN(value) || Double.IsInfinity(value)) throw new InvalidOperationException("INVALID_GEOMETRY");
            if (clips.Count == 0) { display.AddLine(world.SelectMany(v => v).ToArray(), style); return; }
            // Clip each segment by every boundary (xref/block XCLIP), keeping inside pieces.
            for (int i = 1; i < world.Count; i++) {
                var pieces = new List<double[]> { new[] { 0.0, 1.0 } };
                var a = world[i - 1]; var b = world[i];
                foreach (var clip in clips) pieces = Clip(pieces, a, b, clip);
                foreach (var piece in pieces) {
                    Func<double, double[]> at = t => new[] { a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t };
                    display.AddLine(at(piece[0]).Concat(at(piece[1])).ToArray(), style);
                }
            }
        }
        private static List<double[]> Clip(List<double[]> intervals, double[] a, double[] b, Point2d[] polygon)
        {
            var cuts = new List<double> { 0, 1 };
            for (int i = 0; i < polygon.Length; i++) {
                var c = polygon[i]; var d = polygon[(i + 1) % polygon.Length];
                double rx = b[0] - a[0], ry = b[1] - a[1], sx = d.X - c.X, sy = d.Y - c.Y;
                double denominator = rx * sy - ry * sx;
                if (Math.Abs(denominator) < 1e-15) continue;
                double t = ((c.X - a[0]) * sy - (c.Y - a[1]) * sx) / denominator;
                double u = ((c.X - a[0]) * ry - (c.Y - a[1]) * rx) / denominator;
                if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.Add(t);
            }
            cuts.Sort();
            var result = new List<double[]>();
            foreach (var interval in intervals)
                for (int i = 1; i < cuts.Count; i++) {
                    double t0 = Math.Max(interval[0], cuts[i - 1]), t1 = Math.Min(interval[1], cuts[i]);
                    if (t1 - t0 < 1e-12) continue;
                    double mid = (t0 + t1) / 2;
                    if (Contains(polygon, new Point2d(a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid))) result.Add(new[] { t0, t1 });
                }
            return result;
        }
        private static bool Inside(double[] loop, List<Point2d[]> clips)
        {
            if (clips.Count == 0) return true;
            double x = 0, y = 0; int n = loop.Length / 3;
            for (int i = 0; i < n; i++) { x += loop[i * 3]; y += loop[i * 3 + 1]; }
            var centre = new Point2d(x / n, y / n);
            return clips.All(clip => Contains(clip, centre));
        }
        private static bool Contains(Point2d[] polygon, Point2d p)
        {
            bool inside = false;
            for (int i = 0, j = polygon.Length - 1; i < polygon.Length; j = i++) {
                var a = polygon[i]; var b = polygon[j];
                if ((a.Y > p.Y) != (b.Y > p.Y) && p.X < (b.X - a.X) * (p.Y - a.Y) / (b.Y - a.Y) + a.X) inside = !inside;
            }
            return inside;
        }
        /** XCLIP boundary of a block/xref insert in world metres, or null when unclipped. */
        private static Point2d[] ClipPolygon(BlockReference block, Transaction tx, Matrix3d transform, double scale)
        {
            if (block.ExtensionDictionary.IsNull) return null;
            var dictionary = (DBDictionary)tx.GetObject(block.ExtensionDictionary, OpenMode.ForRead);
            if (!dictionary.Contains("ACAD_FILTER")) return null;
            var filters = (DBDictionary)tx.GetObject(dictionary.GetAt("ACAD_FILTER"), OpenMode.ForRead);
            if (!filters.Contains("SPATIAL")) return null;
            var filter = tx.GetObject(filters.GetAt("SPATIAL"), OpenMode.ForRead) as SpatialFilter;
            if (filter == null || !filter.Definition.Enabled) return null;
            var points = filter.Definition.GetPoints().Cast<Point2d>().ToList();
            if (points.Count == 2)
                points = new List<Point2d> { points[0], new Point2d(points[1].X, points[0].Y), points[1], new Point2d(points[0].X, points[1].Y) };
            if (points.Count < 3) return null;
            // Clip space → WCS at clip time → block definition space → current insert → outer blocks.
            var toWorld = transform * block.BlockTransform * filter.OriginalInverseBlockTransform * filter.ClipSpaceToWorldCoordinateSystemTransform;
            return points.Select(p => { var q = new Point3d(p.X, p.Y, 0).TransformBy(toWorld); return new Point2d(q.X * scale, q.Y * scale); }).ToArray();
        }
    }
}
