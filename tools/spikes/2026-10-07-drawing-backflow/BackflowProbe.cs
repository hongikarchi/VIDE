// T-225 spike probe (PLAN-47): command VIDEBACKFLOW runs the jobs listed in VIDE_BF_JOBS (one job per
// line, fields split by TAB) in a hidden ZWCAD started by run.mjs and appends one JSON line per job to
// VIDE_BF_OUT; `<out>.done` ends the run. Every job opens drawings as side databases
// (ReadDwgFile + CloseInput); writes go only to NEW paths (SaveAs refuses an existing file). The
// current step is kept in a memory-mapped file (VIDE_BF_TRACE) so that a native crash inside one
// property getter still names the getter afterwards.
//   fixture  <folder>                    synthetic drawings (2007/2013/2018, title block, 2 layouts, xref)
//   dump     <dwg> <json>                version, handle map, entity digests, tables, layouts, title blocks
//   sweep    <dwg> <limit>               read every public property of up to <limit> entities per type
//   edit     <dwg> <out.dwg> <origin>    move one model curve, add a line marked with xdata, SaveAs (orig. version)
//   xdataops <dwg> <folder>              COPY (deep clone) / MOVE / WBLOCK of the marked line, xdata after each
//   resolve  <dwg> <from> <to> [keep]    xref status via a path-mapped temporary root (<from> → <to>) opened as a
//                                        document; keep = "*" all xrefs, "-" none, or the one file name to load
//   open     <dwg>                       open as a read-only document (the normal open path), count, xrefs, close
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.ApplicationServices;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Geometry;
using ZwSoft.ZwCAD.Runtime;

namespace Vide.Spike
{
public sealed class BackflowProbe
{
    const string App = "VIDE_ORIGIN";
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static MemoryMappedViewAccessor trace;
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    static string lastStep = "";
    static void Step(string what)
    {
        lastStep = what;
        if (trace == null) return;
        var bytes = Encoding.UTF8.GetBytes(what.Length > 500 ? what.Substring(0, 500) : what);
        trace.Write(0, bytes.Length);
        trace.WriteArray(4, bytes, 0, bytes.Length);
    }

    static Database Open(string path)
    {
        var db = new Database(false, true);
        db.ReadDwgFile(path, FileOpenMode.OpenForReadAndAllShare, true, null);
        db.CloseInput(true);
        return db;
    }

    static string Hash(string text)
    {
        using (var sha = SHA1.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").Substring(0, 16);
    }
    static string P(Point3d p) { return Math.Round(p.X, 4).ToString(Inv) + "," + Math.Round(p.Y, 4).ToString(Inv); }

    // ---- dump -------------------------------------------------------------------------------------
    static string Digest(Transaction tr, Entity e)
    {
        var s = new StringBuilder(e.GetType().Name).Append('|').Append(e.Layer).Append('|').Append(e.ColorIndex);
        var curve = e as Curve;
        if (curve != null && !(e is Polyline3d) ) { try { s.Append('|').Append(P(curve.StartPoint)).Append('|').Append(P(curve.EndPoint)); } catch { s.Append("|?"); } }
        var br = e as BlockReference;
        if (br != null) s.Append('|').Append(P(br.Position)).Append('|').Append(br.Name);
        var text = e as DBText; if (text != null) s.Append('|').Append(text.TextString);
        var mtext = e as MText; if (mtext != null) s.Append('|').Append(mtext.Contents);
        return s.ToString();
    }

    static List<string> XdataOf(DBObject o)
    {
        var values = new List<string>();
        using (ResultBuffer rb = o.GetXDataForApplication(App))
        {
            if (rb == null) return null;
            foreach (TypedValue v in rb) values.Add(v.TypeCode + "=" + Convert.ToString(v.Value, Inv));
        }
        return values;
    }

    static object Dump(string path, string jsonOut)
    {
        var r = new Dictionary<string, object>();
        using (var db = Open(path))
        {
            r["version"] = db.OriginalFileVersion.ToString();
            r["handseed"] = db.Handseed.ToString();
            Step("dump handles");
            // Handle map 1..HANDSEED: class name of every live object (tables, dictionaries, entities...).
            var handles = new Dictionary<string, string>();
            long seed = Convert.ToInt64(db.Handseed.ToString(), 16);
            for (long h = 1; h < seed; h++)
            {
                ObjectId id;
                if (!db.TryGetObjectId(new Handle(h), out id) || id.IsNull || id.IsErased) continue;
                handles[h.ToString("X")] = id.ObjectClass.Name;
            }
            r["handles"] = handles;
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                Func<ObjectId, List<string>> names = tableId => {
                    var list = new List<string>();
                    foreach (ObjectId id in (SymbolTable)tr.GetObject(tableId, OpenMode.ForRead)) list.Add(((SymbolTableRecord)tr.GetObject(id, OpenMode.ForRead)).Name);
                    list.Sort(StringComparer.Ordinal); return list;
                };
                r["layers"] = names(db.LayerTableId); r["textStyles"] = names(db.TextStyleTableId); r["dimStyles"] = names(db.DimStyleTableId);
                r["linetypes"] = names(db.LinetypeTableId); r["regApps"] = names(db.RegAppTableId);
                var digests = new Dictionary<string, string>(); var marked = new Dictionary<string, object>();
                var blocks = new List<object>(); var layouts = new List<object>(); var titleBlocks = new List<object>();
                var plain = new Dictionary<string, int[]>();
                var entityErrors = new Dictionary<string, int>();
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                foreach (ObjectId recordId in table)
                {
                    var rec = (BlockTableRecord)tr.GetObject(recordId, OpenMode.ForRead);
                    Step("dump block " + rec.Handle);
                    string layoutName = null; double paperW = 0, paperH = 0;
                    if (rec.IsLayout)
                    {
                        var lay = (Layout)tr.GetObject(rec.LayoutId, OpenMode.ForRead);
                        layoutName = lay.LayoutName; paperW = lay.PlotPaperSize.X; paperH = lay.PlotPaperSize.Y;
                        Step("dump layout " + lay.Handle);
                        var lo = new Dictionary<string, object> {
                            { "name", lay.LayoutName }, { "tab", lay.TabOrder }, { "model", lay.ModelType },
                            { "media", lay.CanonicalMediaName }, { "device", lay.PlotConfigurationName },
                            { "paper", new[] { lay.PlotPaperSize.X, lay.PlotPaperSize.Y } }, { "units", lay.PlotPaperUnits.ToString() },
                            { "plotType", lay.PlotType.ToString() }, { "rotation", lay.PlotRotation.ToString() },
                            { "window", new[] { lay.PlotWindowArea.MinPoint.X, lay.PlotWindowArea.MinPoint.Y, lay.PlotWindowArea.MaxPoint.X, lay.PlotWindowArea.MaxPoint.Y } },
                            { "origin", new[] { lay.PlotOrigin.X, lay.PlotOrigin.Y } }, { "centered", lay.PlotCentered },
                            { "styleSheet", lay.CurrentStyleSheet }, { "plotStyles", lay.PlotPlotStyles },
                            { "standardScale", lay.UseStandardScale ? lay.StdScaleType.ToString() : null },
                            { "customScale", new[] { lay.CustomPrintScale.Numerator, lay.CustomPrintScale.Denominator } },
                            { "margins", new[] { lay.PlotPaperMargins.MinPoint.X, lay.PlotPaperMargins.MinPoint.Y, lay.PlotPaperMargins.MaxPoint.X, lay.PlotPaperMargins.MaxPoint.Y } },
                            { "viewName", lay.PlotViewName } };
                        try { var ext = lay.Extents; lo["extents"] = new[] { ext.MinPoint.X, ext.MinPoint.Y, ext.MaxPoint.X, ext.MaxPoint.Y }; } catch { }
                        layouts.Add(lo);
                    }
                    blocks.Add(new Dictionary<string, object> { { "name", rec.Name }, { "xref", rec.IsFromExternalReference }, { "overlay", rec.IsFromOverlayReference },
                        { "path", rec.PathName }, { "layout", rec.IsLayout }, { "dependent", rec.IsDependent }, { "attdefs", rec.HasAttributeDefinitions } });
                    if (rec.IsFromExternalReference || rec.IsDependent) continue;
                    foreach (ObjectId eid in rec)
                    {
                        var e = tr.GetObject(eid, OpenMode.ForRead) as Entity;
                        if (e == null) continue;
                        Step("dump entity " + e.Handle + " " + e.GetType().Name);
                        try { DumpEntity(tr, rec, e, layoutName, paperW, paperH, digests, marked, plain, titleBlocks); }
                        catch (System.Exception ex)
                        {
                            // Keep going; the failing step (property) is counted per type.
                            string key = e.GetType().Name + " @ " + lastStep.Split(' ')[0] + " " + (lastStep.Contains("#") ? lastStep.Substring(lastStep.IndexOf('#')) : "") + " : " + ex.Message;
                            int n; entityErrors.TryGetValue(key, out n); entityErrors[key] = n + 1;
                        }
                    }
                }
                r["entityErrors"] = entityErrors;
                var plainOut = new Dictionary<string, object>();
                foreach (var kv in plain) plainOut[kv.Key] = new Dictionary<string, object> { { "count", kv.Value[0] }, { "isoRatio", kv.Value[1] } };
                r["plainInserts"] = plainOut;
                r["digests"] = digests; r["marked"] = marked; r["blocks"] = blocks; r["layouts"] = layouts; r["titleBlocks"] = titleBlocks;
                tr.Commit();
            }
        }
        File.WriteAllText(jsonOut, Json.Serialize(r), new UTF8Encoding(false));
        return new Dictionary<string, object> { { "version", r["version"] }, { "handles", ((Dictionary<string, string>)r["handles"]).Count }, { "entityErrors", ((Dictionary<string, int>)r["entityErrors"]).Count }, { "json", jsonOut } };
    }

    static void DumpEntity(Transaction tr, BlockTableRecord rec, Entity e, string layoutName, double paperW, double paperH,
        Dictionary<string, string> digests, Dictionary<string, object> marked, Dictionary<string, int[]> plain, List<object> titleBlocks)
    {
                        Step("dump #digest");
                        digests[e.Handle.ToString()] = Hash(Digest(tr, e));
                        Step("dump #xdata");
                        var x = XdataOf(e);
                        if (x != null) marked[e.Handle.ToString()] = x;
                        Step("dump #insert");
                        var br = e as BlockReference;
                        if (br != null && rec.IsLayout && br.AttributeCollection.Count == 0)
                        {
                            // Frame candidates without attributes: per block, inserts whose extents have an
                            // A-series ratio (1.414 ± 3%).
                            string bn = ((BlockTableRecord)tr.GetObject(br.DynamicBlockTableRecord, OpenMode.ForRead)).Name;
                            int[] c; if (!plain.TryGetValue(bn, out c)) plain[bn] = c = new int[2];
                            c[0]++;
                            try
                            {
                                var ext = br.GeometricExtents; double w = ext.MaxPoint.X - ext.MinPoint.X, h = ext.MaxPoint.Y - ext.MinPoint.Y;
                                double ratio = Math.Max(w, h) / Math.Min(w, h);
                                if (Math.Abs(ratio - Math.Sqrt(2)) / Math.Sqrt(2) < 0.03) c[1]++;
                            }
                            catch { }
                        }
                        if (br == null || br.AttributeCollection.Count == 0) return;
                        // Title block candidates: every INSERT that carries ATTRIBs (in any space).
                        var attrs = new List<object>();
                        foreach (ObjectId aid in br.AttributeCollection)
                        {
                            Step("dump #attrib");
                            var a = (AttributeReference)tr.GetObject(aid, OpenMode.ForRead);
                            attrs.Add(new Dictionary<string, object> { { "tag", a.Tag }, { "value", a.IsMTextAttribute ? a.MTextAttribute.Contents : a.TextString }, { "invisible", a.Invisible }, { "mtext", a.IsMTextAttribute } });
                        }
                        double[] box = null;
                        try { var ext = br.GeometricExtents; box = new[] { ext.MinPoint.X, ext.MinPoint.Y, ext.MaxPoint.X, ext.MaxPoint.Y }; } catch { }
                        Step("dump #blockname");
                        var block = (BlockTableRecord)tr.GetObject(br.DynamicBlockTableRecord, OpenMode.ForRead);
                        titleBlocks.Add(new Dictionary<string, object> { { "block", block.Name }, { "space", rec.IsLayout ? (layoutName ?? rec.Name) : "block:" + rec.Name },
                            { "paperSpace", rec.IsLayout && !rec.Name.Equals(BlockTableRecord.ModelSpace, StringComparison.OrdinalIgnoreCase) },
                            { "paper", new[] { paperW, paperH } }, { "extents", box }, { "scale", new[] { br.ScaleFactors.X, br.ScaleFactors.Y } },
                            { "rotation", br.Rotation }, { "dynamic", br.IsDynamicBlock }, { "attributes", attrs } });
    }

    // ---- sweep ------------------------------------------------------------------------------------
    static readonly HashSet<string> NeverRead = new HashSet<string>(StringComparer.Ordinal) {
        "AcadObject", "ZcadObject", "UnmanagedObject", "Dimension.TextStyleId" };

    static object Sweep(string path, int limit, HashSet<string> skip)
    {
        var ok = new SortedDictionary<string, int>(StringComparer.Ordinal);
        var failed = new SortedDictionary<string, string>(StringComparer.Ordinal);
        var perType = new SortedDictionary<string, int>(StringComparer.Ordinal);
        int read = 0;
        using (var db = Open(path))
        using (Transaction tr = db.TransactionManager.StartTransaction())
        {
            var visit = new List<Entity>();
            foreach (ObjectId recordId in (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead))
            {
                var rec = (BlockTableRecord)tr.GetObject(recordId, OpenMode.ForRead);
                if (rec.IsFromExternalReference || rec.IsDependent) continue;
                foreach (ObjectId eid in rec)
                {
                    var e = tr.GetObject(eid, OpenMode.ForRead) as Entity;
                    if (e == null) continue;
                    visit.Add(e);
                    var br = e as BlockReference;
                    if (br != null) foreach (ObjectId aid in br.AttributeCollection) visit.Add((Entity)tr.GetObject(aid, OpenMode.ForRead));
                }
            }
            foreach (var e in visit)
            {
                string type = e.GetType().Name;
                int n; perType.TryGetValue(type, out n);
                if (n >= limit) continue;
                perType[type] = n + 1; read++;
                foreach (PropertyInfo p in e.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (!p.CanRead || p.GetIndexParameters().Length > 0) continue;
                    string key = p.DeclaringType.Name + "." + p.Name;
                    if (NeverRead.Contains(p.Name) || NeverRead.Contains(key) || skip.Contains(key)) continue;
                    Step("sweep " + key + " " + type + " " + e.Handle);
                    try
                    {
                        object v = p.GetValue(e, null);
                        var en = v as IEnumerable; // touch collections (e.g. AttributeCollection, Cells)
                        if (en != null && !(v is string)) { int c = 0; foreach (object item in en) if (++c > 50) break; }
                        int k; ok.TryGetValue(key, out k); ok[key] = k + 1;
                    }
                    catch (System.Exception ex)
                    {
                        var inner = ex is TargetInvocationException && ex.InnerException != null ? ex.InnerException : ex;
                        string m = inner.GetType().Name + ": " + inner.Message;
                        if (!failed.ContainsKey(key)) failed[key] = m;
                    }
                }
                // Methods the readers use that properties do not cover.
                var hatch = e as Hatch;
                if (hatch != null && !skip.Contains("Hatch.GetLoopAt"))
                {
                    Step("sweep Hatch.GetLoopAt " + e.Handle);
                    try { for (int i = 0; i < hatch.NumberOfLoops; i++) { var loop = hatch.GetLoopAt(i); if (loop.IsPolyline) { var v = loop.Polyline.Count; } else { var c = loop.Curves.Count; } } Count(ok, "Hatch.GetLoopAt"); }
                    catch (System.Exception ex) { if (!failed.ContainsKey("Hatch.GetLoopAt")) failed["Hatch.GetLoopAt"] = ex.GetType().Name + ": " + ex.Message; }
                }
                var mtext = e as MText;
                if (mtext != null && !skip.Contains("MText.ExplodeFragments"))
                {
                    Step("sweep MText.ExplodeFragments " + e.Handle);
                    try { int c = 0; mtext.ExplodeFragments((f, o) => { c++; return MTextFragmentCallbackStatus.Continue; }); Count(ok, "MText.ExplodeFragments"); }
                    catch (System.Exception ex) { if (!failed.ContainsKey("MText.ExplodeFragments")) failed["MText.ExplodeFragments"] = ex.GetType().Name + ": " + ex.Message; }
                }
            }
            tr.Commit();
        }
        return new Dictionary<string, object> { { "entities", read }, { "types", perType }, { "properties", ok.Count }, { "ok", ok }, { "failed", failed } };
    }
    static void Count(IDictionary<string, int> m, string k) { int v; m.TryGetValue(k, out v); m[k] = v + 1; }

    // ---- edit -------------------------------------------------------------------------------------
    static void EnsureApp(Database db, Transaction tr)
    {
        var apps = (RegAppTable)tr.GetObject(db.RegAppTableId, OpenMode.ForRead);
        if (apps.Has(App)) return;
        apps.UpgradeOpen();
        var app = new RegAppTableRecord { Name = App };
        apps.Add(app); tr.AddNewlyCreatedDBObject(app, true);
    }

    static object Edit(string source, string output, string origin)
    {
        if (File.Exists(output)) throw new InvalidOperationException("OUTPUT_EXISTS");
        var r = new Dictionary<string, object>();
        using (var db = Open(source))
        {
            DwgVersion version = db.OriginalFileVersion;
            r["originalVersion"] = version.ToString();
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var model = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForWrite);
                foreach (ObjectId id in model)
                {
                    if (!id.ObjectClass.IsDerivedFrom(RXObject.GetClass(typeof(Line))) && !id.ObjectClass.IsDerivedFrom(RXObject.GetClass(typeof(Polyline)))) continue;
                    var curve = (Entity)tr.GetObject(id, OpenMode.ForRead);
                    var layer = (LayerTableRecord)tr.GetObject(curve.LayerId, OpenMode.ForRead);
                    if (layer.IsLocked) continue;
                    curve.UpgradeOpen();
                    curve.TransformBy(Matrix3d.Displacement(new Vector3d(100, 0, 0)));
                    r["moved"] = curve.Handle.ToString();
                    break;
                }
                EnsureApp(db, tr);
                var line = new Line(new Point3d(0, 0, 0), new Point3d(1000, 1000, 0));
                line.SetDatabaseDefaults(db);
                model.AppendEntity(line); tr.AddNewlyCreatedDBObject(line, true);
                // Origin mark: source id (string), revision (int32), own handle as a 1005 handle reference
                // (translated on deep clone, so a copy can be told apart from the original).
                line.XData = new ResultBuffer(new TypedValue(1001, App), new TypedValue(1000, origin), new TypedValue(1071, 1),
                    new TypedValue(1005, line.Handle.ToString()));
                r["added"] = line.Handle.ToString();
                tr.Commit();
            }
            Step("edit saveas " + output);
            db.SaveAs(output, version);
        }
        using (var check = Open(output)) r["savedVersion"] = check.OriginalFileVersion.ToString();
        return r;
    }

    // ---- xdata operations ------------------------------------------------------------------------
    static object XdataOps(string source, string folder)
    {
        var r = new Dictionary<string, object>();
        using (var db = Open(source))
        {
            ObjectId marked = ObjectId.Null;
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                foreach (ObjectId id in (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForRead))
                    if (XdataOf(tr.GetObject(id, OpenMode.ForRead)) != null) { marked = id; break; }
                tr.Commit();
            }
            if (marked.IsNull) throw new InvalidOperationException("NO_MARKED_ENTITY");
            var ids = new ObjectIdCollection(new[] { marked });
            // COPY = deep clone into the same space.
            var map = new IdMapping();
            db.DeepCloneObjects(ids, SymbolUtilityServices.GetBlockModelSpaceId(db), map, false);
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var original = (Entity)tr.GetObject(marked, OpenMode.ForWrite);
                r["original"] = new Dictionary<string, object> { { "handle", original.Handle.ToString() }, { "xdata", XdataOf(original) } };
                var copy = (Entity)tr.GetObject(map[marked].Value, OpenMode.ForRead);
                r["copy"] = new Dictionary<string, object> { { "handle", copy.Handle.ToString() }, { "xdata", XdataOf(copy) } };
                // MOVE / ROTATE = TransformBy.
                original.TransformBy(Matrix3d.Displacement(new Vector3d(50, 50, 0)) * Matrix3d.Rotation(0.3, Vector3d.ZAxis, Point3d.Origin));
                r["moved"] = XdataOf(original);
                // EXPLODE of a block that holds a marked entity is not tried here (needs a block).
                tr.Commit();
            }
            // WBLOCK of the marked entity into a new drawing.
            string wblock = Path.Combine(folder, "wblock.dwg");
            if (File.Exists(wblock)) throw new InvalidOperationException("OUTPUT_EXISTS");
            using (Database target = db.Wblock(ids, Point3d.Origin))
            {
                target.SaveAs(wblock, db.OriginalFileVersion);
            }
            using (var w = Open(wblock))
            using (Transaction tr = w.TransactionManager.StartTransaction())
            {
                var found = new List<object>();
                foreach (ObjectId id in (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(w), OpenMode.ForRead))
                {
                    var e = tr.GetObject(id, OpenMode.ForRead);
                    found.Add(new Dictionary<string, object> { { "handle", e.Handle.ToString() }, { "xdata", XdataOf(e) } });
                }
                r["wblock"] = found;
                tr.Commit();
            }
            // Copy into another drawing (INSERT of a WBLOCK / paste): WblockCloneObjects into a fresh db.
            string paste = Path.Combine(folder, "paste.dwg");
            using (var other = new Database(true, true))
            {
                var map2 = new IdMapping();
                db.WblockCloneObjects(ids, SymbolUtilityServices.GetBlockModelSpaceId(other), map2, DuplicateRecordCloning.Ignore, false);
                using (Transaction tr = other.TransactionManager.StartTransaction())
                {
                    var e = tr.GetObject(map2[marked].Value, OpenMode.ForRead);
                    r["paste"] = new Dictionary<string, object> { { "handle", e.Handle.ToString() }, { "xdata", XdataOf(e) } };
                    tr.Commit();
                }
                other.SaveAs(paste, db.OriginalFileVersion);
            }
        }
        return r;
    }

    // ---- resolve -----------------------------------------------------------------------------------
    static string EmptyDrawing(string folder)
    {
        string path = Path.Combine(folder, "__vide_empty__.dwg");
        if (!File.Exists(path)) using (var db = new Database(true, true)) db.SaveAs(path, DwgVersion.AC1032);
        return path;
    }

    static object Resolve(string root, string from, string to, string keep)
    {
        string mapped = Path.Combine(Path.GetDirectoryName(root), Path.GetFileNameWithoutExtension(root) + "-resolve.dwg");
        if (File.Exists(mapped)) throw new InvalidOperationException("OUTPUT_EXISTS");
        using (var db = Open(root))
        {
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                foreach (ObjectId id in (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead))
                {
                    var rec = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    if (!rec.IsFromExternalReference) continue;
                    // Never let the resolver reach the user's originals: absolute paths under <from> are
                    // mapped to the copy folder <to>. An absolute path that exists elsewhere is pointed at the copy with the same file name
                    // (XREF\<name> first, then the root folder); a missing absolute path stays as stored.
                    string stored = rec.PathName ?? "";
                    // <keep>: "*" loads every xref, "-" none, else only the xref with that file name; the
                    // others point at a missing name inside the copy so nested real paths (server
                    // shares) are never followed.
                    // They point at an empty drawing: a missing xref makes the document open stop on
                    // ZWCAD's modal "unresolved reference files" dialog, even when hidden.
                    if (keep != "*" && !Path.GetFileName(stored).Equals(keep, StringComparison.OrdinalIgnoreCase))
                    { rec.UpgradeOpen(); rec.PathName = EmptyDrawing(to); continue; }
                    if (from.Length > 0 && stored.StartsWith(from, StringComparison.OrdinalIgnoreCase)) { rec.UpgradeOpen(); rec.PathName = to + stored.Substring(from.Length); }
                    else if (Path.IsPathRooted(stored) && !stored.StartsWith(to, StringComparison.OrdinalIgnoreCase) && File.Exists(stored))
                    {
                        string name = Path.GetFileName(stored), sub = Path.Combine(to, "XREF", name);
                        rec.UpgradeOpen(); rec.PathName = File.Exists(sub) ? sub : Path.Combine(to, name);
                    }
                }
                tr.Commit();
            }
            // Side-DB ResolveXrefs is eNotImplementedYet in ZWCAD 2023: save the path-mapped root as a
            // NEW file next to the root (same folder, so relative paths resolve alike) and open that as
            // a read-only document, which resolves xrefs the normal way.
            Step("resolve " + root);
            db.SaveAs(mapped, db.OriginalFileVersion);
        }
        try { return OpenDocument(mapped); }
        finally { try { File.Delete(mapped); } catch { } }
    }

    static object OpenDocument(string path)
    {
        // A document open resolves xrefs the way the user's ZWCAD does (side-DB ResolveXrefs is
        // eNotImplementedYet in ZWCAD 2023), so xref status and the marked entities of each xref
        // block are reported here too. Only call this on drawings whose xref paths stay in the copy.
        Document doc = Application.DocumentManager.Open(path, true);
        int count = 0;
        var xrefs = new List<object>();
        try
        {
            using (doc.LockDocument())
            using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
            {
                foreach (ObjectId recordId in (BlockTable)tr.GetObject(doc.Database.BlockTableId, OpenMode.ForRead))
                {
                    var rec = (BlockTableRecord)tr.GetObject(recordId, OpenMode.ForRead);
                    int inside = 0, marked = 0;
                    foreach (ObjectId eid in rec)
                    {
                        count++; inside++;
                        if (rec.IsFromExternalReference && XdataOf(tr.GetObject(eid, OpenMode.ForRead)) != null) marked++;
                    }
                    if (!rec.IsFromExternalReference) continue;
                    string status; try { status = rec.XrefStatus.ToString(); } catch { status = "?"; }
                    xrefs.Add(new Dictionary<string, object> { { "name", rec.Name }, { "path", rec.PathName }, { "status", status }, { "entities", inside }, { "marked", marked } });
                }
                tr.Commit();
            }
            return new Dictionary<string, object> { { "opened", true }, { "version", doc.Database.OriginalFileVersion.ToString() }, { "objects", count }, { "xrefs", xrefs } };
        }
        finally { doc.CloseAndDiscard(); }
    }

    // ---- fixture ------------------------------------------------------------------------------------
    static void Fixture(string folder)
    {
        Directory.CreateDirectory(Path.Combine(folder, "xref"));
        var versions = new Dictionary<string, DwgVersion> { { "2007", DwgVersion.AC1021 }, { "2013", DwgVersion.AC1027 }, { "2018", DwgVersion.AC1032 } };
        foreach (var v in versions)
        {
            string child = Path.Combine(folder, "xref", "child-" + v.Key + ".dwg");
            using (var db = new Database(true, true))
            {
                db.Insunits = UnitsValue.Millimeters;
                using (Transaction tr = db.TransactionManager.StartTransaction())
                {
                    var model = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForWrite);
                    var square = new Polyline();
                    square.AddVertexAt(0, new Point2d(0, 0), 0, 0, 0); square.AddVertexAt(1, new Point2d(5000, 0), 0, 0, 0);
                    square.AddVertexAt(2, new Point2d(5000, 5000), 0, 0, 0); square.AddVertexAt(3, new Point2d(0, 5000), 0, 0, 0); square.Closed = true;
                    model.AppendEntity(square); tr.AddNewlyCreatedDBObject(square, true);
                    tr.Commit();
                }
                db.SaveAs(child, v.Value);
            }
            string root = Path.Combine(folder, "root-" + v.Key + ".dwg");
            using (var db = new Database(true, true))
            {
                db.Insunits = UnitsValue.Millimeters;
                using (Transaction tr = db.TransactionManager.StartTransaction())
                {
                    var layers = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForWrite);
                    var wall = new LayerTableRecord { Name = "A-WALL", Color = ZwSoft.ZwCAD.Colors.Color.FromColorIndex(ZwSoft.ZwCAD.Colors.ColorMethod.ByAci, 1) };
                    layers.Add(wall); tr.AddNewlyCreatedDBObject(wall, true);
                    var model = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForWrite);
                    for (int i = 0; i < 5; i++) { var l = new Line(new Point3d(i * 1000, 0, 0), new Point3d(i * 1000, 8000, 0)) { LayerId = wall.ObjectId }; model.AppendEntity(l); tr.AddNewlyCreatedDBObject(l, true); }
                    var dim = new RotatedDimension(0, new Point3d(0, 0, 0), new Point3d(4000, 0, 0), new Point3d(0, -1000, 0), "", db.Dimstyle);
                    model.AppendEntity(dim); tr.AddNewlyCreatedDBObject(dim, true);
                    var note = new MText { Contents = "PLAN NOTE", TextHeight = 300, Location = new Point3d(0, 9000, 0) };
                    model.AppendEntity(note); tr.AddNewlyCreatedDBObject(note, true);
                    // Attributed title block (A3 frame 420x297 in paper units).
                    var blocks = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForWrite);
                    var tb = new BlockTableRecord { Name = "TB-A3" };
                    ObjectId tbId = blocks.Add(tb); tr.AddNewlyCreatedDBObject(tb, true);
                    var frame = new Polyline();
                    frame.AddVertexAt(0, new Point2d(0, 0), 0, 0, 0); frame.AddVertexAt(1, new Point2d(420, 0), 0, 0, 0);
                    frame.AddVertexAt(2, new Point2d(420, 297), 0, 0, 0); frame.AddVertexAt(3, new Point2d(0, 297), 0, 0, 0); frame.Closed = true;
                    tb.AppendEntity(frame); tr.AddNewlyCreatedDBObject(frame, true);
                    string[] tags = { "TITLE", "SHEET_NO", "SCALE" };
                    for (int i = 0; i < tags.Length; i++)
                    {
                        var ad = new AttributeDefinition(new Point3d(330, 30 - i * 8, 0), "", tags[i], tags[i], db.Textstyle) { Height = 3 };
                        tb.AppendEntity(ad); tr.AddNewlyCreatedDBObject(ad, true);
                    }
                    var dicts = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
                    int sheet = 0;
                    foreach (DBDictionaryEntry entry in dicts)
                    {
                        var lay = (Layout)tr.GetObject(entry.Value, OpenMode.ForRead);
                        if (lay.ModelType) continue;
                        sheet++;
                        var paper = (BlockTableRecord)tr.GetObject(lay.BlockTableRecordId, OpenMode.ForWrite);
                        var insert = new BlockReference(Point3d.Origin, tbId);
                        paper.AppendEntity(insert); tr.AddNewlyCreatedDBObject(insert, true);
                        foreach (ObjectId aid in tb)
                        {
                            var ad = tr.GetObject(aid, OpenMode.ForRead) as AttributeDefinition;
                            if (ad == null) continue;
                            var ar = new AttributeReference();
                            ar.SetAttributeFromBlock(ad, insert.BlockTransform);
                            ar.TextString = ad.Tag == "TITLE" ? "SYNTH PLAN " + sheet : ad.Tag == "SHEET_NO" ? "A-10" + sheet : "1/100";
                            insert.AttributeCollection.AppendAttribute(ar); tr.AddNewlyCreatedDBObject(ar, true);
                        }
                    }
                    ObjectId x = db.AttachXref(child, "child-" + v.Key);
                    ((BlockTableRecord)tr.GetObject(x, OpenMode.ForWrite)).PathName = "xref\\child-" + v.Key + ".dwg";
                    var xr = new BlockReference(new Point3d(10000, 0, 0), x);
                    model.AppendEntity(xr); tr.AddNewlyCreatedDBObject(xr, true);
                    tr.Commit();
                }
                db.SaveAs(root, v.Value);
            }
        }
    }

    [CommandMethod("VIDEBACKFLOW", CommandFlags.Session)]
    public static void Run()
    {
        string jobs = Environment.GetEnvironmentVariable("VIDE_BF_JOBS");
        string output = Environment.GetEnvironmentVariable("VIDE_BF_OUT");
        string tracePath = Environment.GetEnvironmentVariable("VIDE_BF_TRACE");
        string skipPath = Environment.GetEnvironmentVariable("VIDE_BF_SKIP");
        if (String.IsNullOrEmpty(jobs) || !File.Exists(jobs) || String.IsNullOrEmpty(output)) return;
        var skip = new HashSet<string>(StringComparer.Ordinal);
        if (!String.IsNullOrEmpty(skipPath) && File.Exists(skipPath)) foreach (string s in File.ReadAllLines(skipPath)) if (s.Trim().Length > 0) skip.Add(s.Trim());
        MemoryMappedFile map = null;
        if (!String.IsNullOrEmpty(tracePath))
        {
            // Shared so that the driver can read the step while ZWCAD is alive (hang detection).
            var stream = new FileStream(tracePath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite);
            stream.SetLength(1024);
            map = MemoryMappedFile.CreateFromFile(stream, null, 1024, MemoryMappedFileAccess.ReadWrite, null, HandleInheritability.None, false);
            trace = map.CreateViewAccessor(0, 1024);
        }
        try
        {
            foreach (string line in File.ReadAllLines(jobs, Encoding.UTF8))
            {
                if (line.Trim().Length == 0) continue;
                string[] a = line.Split('\t');
                var row = new Dictionary<string, object> { { "job", a[0] }, { "op", a[1] } };
                Step("job " + a[0] + " " + a[1]);
                var watch = System.Diagnostics.Stopwatch.StartNew();
                try
                {
                    switch (a[1])
                    {
                        case "fixture": Fixture(a[2]); row["result"] = "ok"; break;
                        case "dump": row["result"] = Dump(a[2], a[3]); break;
                        case "sweep": row["result"] = Sweep(a[2], int.Parse(a[3], Inv), skip); break;
                        case "edit": row["result"] = Edit(a[2], a[3], a[4]); break;
                        case "xdataops": row["result"] = XdataOps(a[2], a[3]); break;
                        case "resolve": row["result"] = Resolve(a[2], a[3], a[4], a.Length > 5 ? a[5] : "*"); break;
                        case "open": row["result"] = OpenDocument(a[2]); break;
                        default: row["error"] = "unknown op"; break;
                    }
                }
                catch (System.Exception ex) { row["error"] = ex.GetType().Name + ": " + ex.Message; row["step"] = lastStep; }
                row["ms"] = watch.ElapsedMilliseconds;
                File.AppendAllText(output, Json.Serialize(row) + "\n", new UTF8Encoding(false));
            }
            Step("done");
        }
        finally { if (trace != null) trace.Dispose(); if (map != null) map.Dispose(); trace = null; }
        File.WriteAllText(output + ".done", "ok");
    }
}
}
