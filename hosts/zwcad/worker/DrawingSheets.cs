// Title blocks and plot ranges for the title block preview (SPEC-14.15, PLAN-47 T-235). Started by
// hosts/zwcad/drawing-sheets.ts in a hidden ZWCAD the engine owns (runHiddenZwcad); reads only the
// copies listed in VIDE_SHEETS_MANIFEST (`id<TAB>path<TAB>root` lines) in side databases opened
// read-only. Nothing is saved and no document is opened. Per drawing one JSON line in
// VIDE_SHEETS_OUT:
//  - units/scale (a unitless drawing is read as mm) and the xref records and INSERTs (XrefGraph);
//  - `layouts`: every layout's plot settings — plot type, window, paper, media, plot style table
//    name, limits, extents (metres), and the paper space entity count (viewports not counted);
//  - `frames`: top-level block INSERTs of model space and of every paper layout (no xrefs) that
//    carry attributes, are on the title block list (VIDE_SHEETS_BLOCKS, one name a line), or have an
//    ISO A-series outer frame (long/short within 3 % of √2): name, handle, space, layout, box, ATTRIBs.
// The display rows (AttachedDisplay) go to `<out dir>/<id>.json`: `{model, paper: {layout: …}}`
// (paper spaces only for the root). `<out>.done` ends the run. Members in SafeRead.Avoided are
// never read; a dynamic block's name is read in a try (eInvalidObjectId on real drawings).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using Vide.Zwcad.Connection;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Geometry;
using ZwSoft.ZwCAD.Runtime;

namespace Vide.Zwcad
{
public sealed class DrawingSheetsCommand
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    static string lastStep = "";
    static void Step(string name)
    {
        lastStep = name;
        string file = Environment.GetEnvironmentVariable("VIDE_WORKER_STEP");
        if (String.IsNullOrEmpty(file) || !Path.IsPathRooted(file)) return;
        try { File.AppendAllText(file, name + Environment.NewLine, new UTF8Encoding(false)); } catch { /* Diagnostics only. */ }
    }

    static double[] Box(double x0, double y0, double x1, double y1, double scale) =>
        new[] { Math.Min(x0, x1) * scale, Math.Min(y0, y1) * scale, Math.Max(x0, x1) * scale, Math.Max(y0, y1) * scale };

    static bool IsoRatio(double w, double h)
    {
        double longSide = Math.Max(w, h), shortSide = Math.Min(w, h);
        return shortSide > 0 && Math.Abs(longSide / shortSide - Math.Sqrt(2)) / Math.Sqrt(2) < 0.03;
    }

    static List<object> Layouts(Database db, Transaction tr, double scale, Dictionary<string, ObjectId> paperSpaces)
    {
        var layouts = new List<object>();
        var dictionary = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
        var viewport = RXObject.GetClass(typeof(Viewport));
        foreach (DBDictionaryEntry entry in dictionary)
        {
            var layout = tr.GetObject(entry.Value, OpenMode.ForRead) as Layout;
            if (layout == null) continue;
            Step("layout " + layout.Handle);
            var row = new Dictionary<string, object> {
                { "name", layout.LayoutName }, { "model", layout.ModelType }, { "tab", layout.TabOrder } };
            try { row["plotType"] = layout.PlotType.ToString(); } catch { row["plotType"] = "Unknown"; }
            try { var w = layout.PlotWindowArea; row["window"] = Box(w.MinPoint.X, w.MinPoint.Y, w.MaxPoint.X, w.MaxPoint.Y, scale); } catch { row["window"] = null; }
            try { row["paper"] = new[] { layout.PlotPaperSize.X, layout.PlotPaperSize.Y }; } catch { row["paper"] = null; }
            try { row["media"] = layout.CanonicalMediaName; } catch { row["media"] = null; }
            try { row["styleSheet"] = layout.CurrentStyleSheet; } catch { row["styleSheet"] = null; }
            try { var l = layout.Limits; row["limits"] = Box(l.MinPoint.X, l.MinPoint.Y, l.MaxPoint.X, l.MaxPoint.Y, scale); } catch { row["limits"] = null; }
            try { var e = layout.Extents; row["extents"] = Box(e.MinPoint.X, e.MinPoint.Y, e.MaxPoint.X, e.MaxPoint.Y, scale); } catch { row["extents"] = null; }
            int entities = 0;
            if (!layout.ModelType)
            {
                foreach (ObjectId id in (BlockTableRecord)tr.GetObject(layout.BlockTableRecordId, OpenMode.ForRead))
                    if (!id.ObjectClass.IsDerivedFrom(viewport)) entities++;
                paperSpaces[layout.LayoutName] = layout.BlockTableRecordId;
            }
            row["entities"] = entities;
            layouts.Add(row);
        }
        return layouts;
    }

    static List<object> Frames(Database db, Transaction tr, double scale, HashSet<string> listed, out int skipped)
    {
        skipped = 0;
        var frames = new List<object>();
        var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
        var reference = RXObject.GetClass(typeof(BlockReference));
        foreach (ObjectId spaceId in table)
        {
            var space = (BlockTableRecord)tr.GetObject(spaceId, OpenMode.ForRead);
            if (!space.IsLayout) continue;
            bool model = space.Name.Equals(BlockTableRecord.ModelSpace, StringComparison.OrdinalIgnoreCase);
            string layoutName = model ? null : ((Layout)tr.GetObject(space.LayoutId, OpenMode.ForRead)).LayoutName;
            foreach (ObjectId id in space)
            {
                if (!id.ObjectClass.IsDerivedFrom(reference)) continue;
                // One damaged insert (eInvalidObjectId on a real drawing) is skipped, not the drawing.
                try { Frame(tr, id, model, layoutName, scale, listed, frames); }
                catch (ZwSoft.ZwCAD.Runtime.Exception) { skipped++; }
            }
        }
        return frames;
    }

    static void Frame(Transaction tr, ObjectId id, bool model, string layoutName, double scale, HashSet<string> listed, List<object> frames)
    {
        var insert = tr.GetObject(id, OpenMode.ForRead) as BlockReference;
        if (insert == null) return;
        Step("frame " + insert.Handle);
        var record = (BlockTableRecord)tr.GetObject(insert.BlockTableRecord, OpenMode.ForRead);
        if (record.IsFromExternalReference || record.IsDependent || record.IsLayout) return;
        string name = record.Name;
        if (record.IsAnonymous)
            try { name = ((BlockTableRecord)tr.GetObject(insert.DynamicBlockTableRecord, OpenMode.ForRead)).Name; }
            catch (System.Exception) { /* Keep the anonymous name. */ }
        Extents3d extents;
        try { extents = insert.GeometricExtents; } catch (System.Exception) { return; }
        double w = extents.MaxPoint.X - extents.MinPoint.X, h = extents.MaxPoint.Y - extents.MinPoint.Y;
        int count = insert.AttributeCollection.Count;
        if (count == 0 && !listed.Contains(name) && !IsoRatio(w, h)) return;
        var attributes = new List<object>();
        foreach (ObjectId attributeId in insert.AttributeCollection)
        {
            var attribute = tr.GetObject(attributeId, OpenMode.ForRead) as AttributeReference;
            if (attribute == null) continue;
            attributes.Add(new Dictionary<string, object> {
                { "tag", attribute.Tag }, { "value", attribute.TextString ?? "" }, { "invisible", attribute.Invisible } });
        }
        frames.Add(new Dictionary<string, object> {
            { "name", name }, { "handle", insert.Handle.ToString() },
            { "space", model ? "model" : "paper" }, { "layout", layoutName },
            { "box", Box(extents.MinPoint.X, extents.MinPoint.Y, extents.MaxPoint.X, extents.MaxPoint.Y, scale) },
            { "attributes", attributes } });
    }

    [CommandMethod("VIDEDRAWINGSHEETS", CommandFlags.Session)]
    public static void Run()
    {
        string manifest = Environment.GetEnvironmentVariable("VIDE_SHEETS_MANIFEST");
        string output = Environment.GetEnvironmentVariable("VIDE_SHEETS_OUT");
        string blocks = Environment.GetEnvironmentVariable("VIDE_SHEETS_BLOCKS");
        if (String.IsNullOrEmpty(manifest) || !Path.IsPathRooted(manifest) || !File.Exists(manifest) ||
            String.IsNullOrEmpty(output) || !Path.IsPathRooted(output)) return;
        var listed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (!String.IsNullOrEmpty(blocks) && Path.IsPathRooted(blocks) && File.Exists(blocks))
            foreach (string name in File.ReadAllLines(blocks, Encoding.UTF8)) if (name.Trim().Length > 0) listed.Add(name.Trim());
        string folder = Path.GetDirectoryName(output);
        using (var writer = new StreamWriter(output, false, new UTF8Encoding(false)))
        {
            foreach (string line in File.ReadAllLines(manifest, Encoding.UTF8))
            {
                string[] parts = line.Split('\t');
                if (parts.Length < 3) continue;
                string id = parts[0], path = parts[1];
                bool root = parts[2] == "1";
                var row = new Dictionary<string, object> { { "id", int.Parse(id, CultureInfo.InvariantCulture) } };
                var watch = Stopwatch.StartNew();
                try
                {
                    Step("read " + id);
                    using (var db = new Database(false, true))
                    {
                        db.ReadDwgFile(path, FileOpenMode.OpenForReadAndAllShare, true, null);
                        db.CloseInput(true);
                        int units = (int)db.Insunits;
                        bool assumed = false;
                        try { AttachedDisplay.Scale(db); } catch (InvalidOperationException) { db.Insunits = UnitsValue.Millimeters; assumed = true; }
                        double scale = AttachedDisplay.Scale(db);
                        row["units"] = units; row["scale"] = scale; row["unitsAssumed"] = assumed;
                        var paperSpaces = new Dictionary<string, ObjectId>();
                        using (Transaction tr = db.TransactionManager.StartTransaction())
                        {
                            foreach (var item in XrefGraphCommand.Graph(db, tr)) row[item.Key] = item.Value;
                            row["layouts"] = Layouts(db, tr, scale, paperSpaces);
                            int skipped;
                            row["frames"] = Frames(db, tr, scale, listed, out skipped);
                            row["skippedInserts"] = skipped;
                            tr.Commit();
                        }
                        Step("display " + id);
                        var paper = new Dictionary<string, object>();
                        if (root)
                            foreach (var space in paperSpaces)
                            {
                                Step("display paper " + id);
                                paper[space.Key] = XrefGraphCommand.Display(db, space.Value);
                            }
                        string file = Path.Combine(folder, id + ".json");
                        File.WriteAllText(file, Json.Serialize(new Dictionary<string, object> {
                            { "model", XrefGraphCommand.Display(db) }, { "paper", paper } }), new UTF8Encoding(false));
                        row["file"] = file;
                    }
                    row["error"] = null;
                }
                catch (System.Exception ex) { row["error"] = ex.GetType().Name + ": " + ex.Message; row["step"] = lastStep; }
                row["ms"] = watch.ElapsedMilliseconds;
                writer.WriteLine(Json.Serialize(row));
                writer.Flush();
            }
        }
        Step("done");
        File.WriteAllText(output + ".done", "ok");
    }

    /**
     * Synthetic drawings for the real-ZWCAD test only (tests/integration/zwcad-drawing-sheets.mjs),
     * into VIDE_SHEETS_FIXTURE (a new folder the caller made):
     *  - xref\frames.dwg: an attribute-less A3 frame block FRAME-A3 at 1/100 with the sheet number and
     *    title as plain text inside it (label + value);
     *  - sheets.dwg (2018): three attributed A1 frames TB-A1 at 1/100 (DWG_NO, DWG_TITLE, SCALE), a
     *    small attributed NOTE-BOX (not an A ratio), the model tab plotted by window around a plain
     *    border with text, Layout1 with a border and text (Layout2 empty), xref\frames.dwg below the
     *    frames (stored relative) and an xref gone.dwg inside the second frame whose file is removed.
     * `fixture.json` tells whether the plot windows could be set in a side database.
     */
    [CommandMethod("VIDEDRAWINGSHEETSFIXTURE", CommandFlags.Session)]
    public static void Fixture()
    {
        string folder = Environment.GetEnvironmentVariable("VIDE_SHEETS_FIXTURE");
        if (String.IsNullOrEmpty(folder) || !Path.IsPathRooted(folder) || !Directory.Exists(folder)) return;
        try
        {
            Directory.CreateDirectory(Path.Combine(folder, "xref"));
            string frames = Path.Combine(folder, "xref", "frames.dwg"), gone = Path.Combine(folder, "gone.dwg");
            Save(frames, (db, tr, model) => {
                ObjectId block = Block(db, tr, "FRAME-A3", 420, 297, new string[0]);
                Add(tr, model, new BlockReference(Point3d.Origin, block) { ScaleFactors = new Scale3d(100) });
                Text(tr, model, "도면명", 30000, 2000, 300); Text(tr, model, "단면도", 34000, 2000, 500);
                Text(tr, model, "도면번호", 30000, 800, 300); Text(tr, model, "A-201", 34000, 800, 400);
            });
            Save(gone, (db, tr, model) => Add(tr, model, new Line(Point3d.Origin, new Point3d(100, 0, 0))));
            var result = new Dictionary<string, object>();
            Save(Path.Combine(folder, "sheets.dwg"), (db, tr, model) => {
                ObjectId tb = Block(db, tr, "TB-A1", 841, 594, new[] { "DWG_NO", "DWG_TITLE", "SCALE" });
                for (int i = 0; i < 3; i++)
                    Insert(tr, model, tb, new Point3d(i * 100000, 0, 0), 100,
                        new Dictionary<string, string> { { "DWG_NO", "A-10" + (i + 1) }, { "DWG_TITLE", "평면도 " + (i + 1) }, { "SCALE", "1/100" } });
                ObjectId note = Block(db, tr, "NOTE-BOX", 500, 100, new[] { "NOTE" });
                Insert(tr, model, note, new Point3d(0, 70000, 0), 10, new Dictionary<string, string> { { "NOTE", "합성 메모" } });
                // A plain border plotted by window from the model tab.
                Add(tr, model, Rectangle(300000, 0, 84100, 59400));
                Text(tr, model, "도면번호", 370000, 3000, 300); Text(tr, model, "A-401", 374000, 3000, 400);
                Text(tr, model, "도면명", 370000, 6000, 300); Text(tr, model, "창 범위 시트", 374000, 6000, 500);
                ObjectId frameXref = db.AttachXref(frames, "frames");
                ((BlockTableRecord)tr.GetObject(frameXref, OpenMode.ForWrite)).PathName = "xref\\frames.dwg";
                Add(tr, model, new BlockReference(new Point3d(0, -100000, 0), frameXref));
                ObjectId goneXref = db.AttachXref(gone, "gone");
                Add(tr, model, new BlockReference(new Point3d(150000, 30000, 0), goneXref));
                var layouts = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
                foreach (DBDictionaryEntry entry in layouts)
                {
                    var layout = (Layout)tr.GetObject(entry.Value, OpenMode.ForWrite);
                    if (layout.ModelType)
                        result["modelWindow"] = PlotWindow(layout, 300000, 0, 384100, 59400);
                    else if (layout.TabOrder == 1)
                    {
                        var paper = (BlockTableRecord)tr.GetObject(layout.BlockTableRecordId, OpenMode.ForWrite);
                        Add(tr, paper, Rectangle(0, 0, 420, 297));
                        Text(tr, paper, "도면번호", 330, 10, 3); Text(tr, paper, "A-501", 370, 10, 4);
                        Text(tr, paper, "도면명", 330, 20, 3); Text(tr, paper, "배치 시트", 370, 20, 5);
                        result["layoutWindow"] = PlotWindow(layout, 0, 0, 420, 297);
                        result["layout"] = layout.LayoutName;
                    }
                }
            }, DwgVersion.AC1032);
            File.Delete(gone);
            File.WriteAllText(Path.Combine(folder, "fixture.json"), Json.Serialize(result), new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(folder, "fixture.done"), "ok");
        }
        catch (System.Exception ex) { File.WriteAllText(Path.Combine(folder, "fixture.error"), ex.ToString()); }
    }

    static bool PlotWindow(Layout layout, double x0, double y0, double x1, double y1)
    {
        try
        {
            var validator = PlotSettingsValidator.Current;
            validator.SetPlotWindowArea(layout, new Extents2d(x0, y0, x1, y1));
            validator.SetPlotType(layout, ZwSoft.ZwCAD.DatabaseServices.PlotType.Window);
            return true;
        }
        catch (System.Exception) { return false; }
    }
    static Polyline Rectangle(double x, double y, double w, double h)
    {
        var border = new Polyline();
        border.AddVertexAt(0, new Point2d(x, y), 0, 0, 0); border.AddVertexAt(1, new Point2d(x + w, y), 0, 0, 0);
        border.AddVertexAt(2, new Point2d(x + w, y + h), 0, 0, 0); border.AddVertexAt(3, new Point2d(x, y + h), 0, 0, 0);
        border.Closed = true;
        return border;
    }
    static ObjectId Block(Database db, Transaction tr, string name, double w, double h, string[] tags)
    {
        var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForWrite);
        var record = new BlockTableRecord { Name = name };
        ObjectId id = table.Add(record); tr.AddNewlyCreatedDBObject(record, true);
        Add(tr, record, Rectangle(0, 0, w, h));
        for (int i = 0; i < tags.Length; i++)
            Add(tr, record, new AttributeDefinition(new Point3d(w * 0.8, 10 + i * 8, 0), "", tags[i], tags[i], db.Textstyle) { Height = 4 });
        return id;
    }
    static void Insert(Transaction tr, BlockTableRecord space, ObjectId block, Point3d at, double scale, Dictionary<string, string> values)
    {
        var insert = new BlockReference(at, block) { ScaleFactors = new Scale3d(scale) };
        Add(tr, space, insert);
        foreach (ObjectId id in (BlockTableRecord)tr.GetObject(block, OpenMode.ForRead))
        {
            var definition = tr.GetObject(id, OpenMode.ForRead) as AttributeDefinition;
            if (definition == null) continue;
            var attribute = new AttributeReference();
            attribute.SetAttributeFromBlock(definition, insert.BlockTransform);
            attribute.TextString = values.ContainsKey(definition.Tag) ? values[definition.Tag] : "";
            insert.AttributeCollection.AppendAttribute(attribute); tr.AddNewlyCreatedDBObject(attribute, true);
        }
    }
    static void Text(Transaction tr, BlockTableRecord space, string value, double x, double y, double height) =>
        Add(tr, space, new DBText { Position = new Point3d(x, y, 0), TextString = value, Height = height });
    static void Add(Transaction tr, BlockTableRecord space, Entity entity)
    {
        space.AppendEntity(entity); tr.AddNewlyCreatedDBObject(entity, true);
    }
    static void Save(string path, Action<Database, Transaction, BlockTableRecord> build, DwgVersion version = DwgVersion.Current)
    {
        if (File.Exists(path)) throw new InvalidOperationException("fixture exists");
        using (var db = new Database(true, true))
        {
            db.Insunits = UnitsValue.Millimeters;
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var model = (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
                build(db, tr, model);
                tr.Commit();
            }
            db.SaveAs(path, version);
        }
    }
}
}
