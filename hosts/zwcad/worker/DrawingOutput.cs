// Drawing writes of the backflow (PLAN-47 T-226; used by T-230·T-233). Started by
// hosts/zwcad/drawing-output.ts in a hidden ZWCAD the engine owns (runHiddenZwcad).
//  - VIDEDRAWINGCOPY: reads VIDE_DRAWING_SOURCE (a copy in the engine's work folder) in a side
//    database and writes it to VIDE_DRAWING_TARGET through the run's OutputGrant (token path only,
//    no overwrite, the source's DWG version), then reads the new file back. One JSON object in
//    VIDE_DRAWING_RESULT, then `<result>.done`. The worker's steps go to VIDE_WORKER_STEP.
//  - VIDEDRAWINGFIXTURE: synthetic drawings for the real-ZWCAD test only
//    (tests/integration/zwcad-drawing-output.mjs, zwcad-drawing-inspect.mjs) into the empty folder
//    VIDE_DRAWING_FIXTURE.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Geometry;
using ZwSoft.ZwCAD.Runtime;

namespace Vide.Zwcad
{
public sealed class DrawingOutputCommand
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    static void Step(string name)
    {
        string file = Environment.GetEnvironmentVariable("VIDE_WORKER_STEP");
        if (String.IsNullOrEmpty(file) || !Path.IsPathRooted(file)) return;
        try { File.AppendAllText(file, name + Environment.NewLine, new UTF8Encoding(false)); } catch { /* Diagnostics only. */ }
    }

    /** Version, units and the model space handles (sorted) of a side database. */
    static Dictionary<string, object> Summary(Database db)
    {
        var handles = new List<string>(); var layers = new List<string>();
        using (Transaction tr = db.TransactionManager.StartTransaction())
        {
            var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            foreach (ObjectId id in (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead))
                handles.Add(id.Handle.ToString());
            foreach (ObjectId id in (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead))
                layers.Add(((LayerTableRecord)tr.GetObject(id, OpenMode.ForRead)).Name);
            tr.Commit();
        }
        handles.Sort(StringComparer.Ordinal); layers.Sort(StringComparer.Ordinal);
        return new Dictionary<string, object> {
            { "version", OutputGrant.Magic(db.OriginalFileVersion) }, { "units", (int)db.Insunits },
            { "handles", handles }, { "layers", layers } };
    }

    [CommandMethod("VIDEDRAWINGCOPY", CommandFlags.Session)]
    public static void Copy()
    {
        string result = Environment.GetEnvironmentVariable("VIDE_DRAWING_RESULT");
        if (String.IsNullOrEmpty(result) || !Path.IsPathRooted(result)) return;
        var row = new Dictionary<string, object>();
        OutputGrant grant = null;
        try
        {
            Step("grant");
            grant = OutputGrant.Load(Environment.GetEnvironmentVariable("VIDE_OUTPUT_GRANT"), Environment.GetEnvironmentVariable("VIDE_OUTPUT_TOKEN"));
            string source = Environment.GetEnvironmentVariable("VIDE_DRAWING_SOURCE"), target = Environment.GetEnvironmentVariable("VIDE_DRAWING_TARGET");
            if (String.IsNullOrEmpty(source) || !Path.IsPathRooted(source) || !File.Exists(source)) throw new OutputRefused("SOURCE_MISSING");
            grant.Authorize(target);
            using (var db = new Database(false, true))
            {
                Step("read");
                db.ReadDwgFile(source, FileOpenMode.OpenForReadAndAllShare, true, null);
                db.CloseInput(true);
                row["source"] = Summary(db);
                Step("stage");
                grant.Stage(db, target);
            }
            Step("commit");
            grant.Commit();
            Step("readback");
            using (var back = new Database(false, true))
            {
                back.ReadDwgFile(target, FileOpenMode.OpenForReadAndAllShare, true, null);
                back.CloseInput(true);
                row["written"] = Summary(back);
            }
            row["ok"] = true; row["path"] = Path.GetFullPath(target);
            Step("done");
        }
        catch (OutputRefused refused) { grant?.Discard(); row["ok"] = false; row["code"] = refused.Code; Step("refused " + refused.Code); }
        catch (System.Exception ex) { grant?.Discard(); row["ok"] = false; row["code"] = "WRITE_FAILED"; row["message"] = ex.GetType().Name + ": " + ex.Message; Step("failed " + ex.GetType().Name); }
        File.WriteAllText(result, Json.Serialize(row), new UTF8Encoding(false));
        File.WriteAllText(result + ".done", "ok");
    }

    /**
     * v2013.dwg (AC1027) and v2018.dwg (AC1032): mm, a layer "벽" (linetype "VIDE점선"), a closed
     * polyline, a text, a text style "VIDE문자", a dimension style "VIDE치수" (that text style, arrow
     * block "VIDE틱") with one ZWCAD-made rotated dimension (its Dimblk*s would crash ZWCAD, T-225) and
     * a block "도곽" with one attribute, inserted once; inch.dwg (AC1032) the same in inches (T-227).
     * Written only into a new empty folder.
     */
    [CommandMethod("VIDEDRAWINGFIXTURE", CommandFlags.Session)]
    public static void Fixture()
    {
        string folder = Environment.GetEnvironmentVariable("VIDE_DRAWING_FIXTURE");
        if (String.IsNullOrEmpty(folder) || !Path.IsPathRooted(folder) || !Directory.Exists(folder)) return;
        try
        {
            Synthetic(Path.Combine(folder, "v2013.dwg"), DwgVersion.AC1027);
            Synthetic(Path.Combine(folder, "v2018.dwg"), DwgVersion.AC1032);
            Synthetic(Path.Combine(folder, "inch.dwg"), DwgVersion.AC1032, UnitsValue.Inches);
            File.WriteAllText(Path.Combine(folder, "fixture.done"), "ok");
        }
        catch (System.Exception ex) { File.WriteAllText(Path.Combine(folder, "fixture.error"), ex.ToString()); }
    }

    static void Synthetic(string path, DwgVersion version, UnitsValue units = UnitsValue.Millimeters)
    {
        if (File.Exists(path)) throw new InvalidOperationException("fixture exists");
        using (var db = new Database(true, true))
        {
            db.Insunits = units;
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var types = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForWrite);
                var dashed = new LinetypeTableRecord { Name = "VIDE점선", AsciiDescription = "__ __", PatternLength = 10, NumDashes = 2 };
                dashed.SetDashLengthAt(0, 5); dashed.SetDashLengthAt(1, -5);
                types.Add(dashed); tr.AddNewlyCreatedDBObject(dashed, true);
                var layers = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForWrite);
                var wall = new LayerTableRecord { Name = "벽", LinetypeObjectId = dashed.ObjectId };
                layers.Add(wall); tr.AddNewlyCreatedDBObject(wall, true);
                var styles = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForWrite);
                var font = new TextStyleTableRecord { Name = "VIDE문자", FileName = "txt.shx" };
                styles.Add(font); tr.AddNewlyCreatedDBObject(font, true);
                var blocks = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForWrite);
                var tick = new BlockTableRecord { Name = "VIDE틱" };
                blocks.Add(tick); tr.AddNewlyCreatedDBObject(tick, true);
                var stroke = new Line(new Point3d(-0.5, -0.5, 0), new Point3d(0.5, 0.5, 0));
                tick.AppendEntity(stroke); tr.AddNewlyCreatedDBObject(stroke, true);
                var dims = (DimStyleTable)tr.GetObject(db.DimStyleTableId, OpenMode.ForWrite);
                var dimStyle = new DimStyleTableRecord { Name = "VIDE치수", Dimtxsty = font.ObjectId, Dimblk = tick.ObjectId, Dimscale = 100 };
                dims.Add(dimStyle); tr.AddNewlyCreatedDBObject(dimStyle, true);
                var frame = new BlockTableRecord { Name = "도곽" };
                ObjectId frameId = blocks.Add(frame); tr.AddNewlyCreatedDBObject(frame, true);
                var border = new Polyline();
                border.AddVertexAt(0, new Point2d(0, 0), 0, 0, 0); border.AddVertexAt(1, new Point2d(841, 0), 0, 0, 0);
                border.AddVertexAt(2, new Point2d(841, 594), 0, 0, 0); border.AddVertexAt(3, new Point2d(0, 594), 0, 0, 0);
                border.Closed = true; frame.AppendEntity(border); tr.AddNewlyCreatedDBObject(border, true);
                var number = new AttributeDefinition(new Point3d(700, 20, 0), "A-101", "도면번호", "도면번호", ObjectId.Null) { Height = 5 };
                frame.AppendEntity(number); tr.AddNewlyCreatedDBObject(number, true);
                var space = (BlockTableRecord)tr.GetObject(blocks[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
                var room = new Polyline { LayerId = wall.ObjectId };
                room.AddVertexAt(0, new Point2d(1000, 1000), 0, 0, 0); room.AddVertexAt(1, new Point2d(5000, 1000), 0, 0, 0);
                room.AddVertexAt(2, new Point2d(5000, 4000), 0, 0, 0); room.Closed = true;
                space.AppendEntity(room); tr.AddNewlyCreatedDBObject(room, true);
                var text = new DBText { Position = new Point3d(1200, 1200, 0), TextString = "거실", Height = 250, LayerId = wall.ObjectId };
                space.AppendEntity(text); tr.AddNewlyCreatedDBObject(text, true);
                var dimension = new RotatedDimension(0, new Point3d(1000, 1000, 0), new Point3d(5000, 1000, 0), new Point3d(3000, 500, 0), "", dimStyle.ObjectId) { LayerId = wall.ObjectId };
                space.AppendEntity(dimension); tr.AddNewlyCreatedDBObject(dimension, true);
                var insert = new BlockReference(new Point3d(0, 0, 0), frameId) { ScaleFactors = new Scale3d(10) };
                space.AppendEntity(insert); tr.AddNewlyCreatedDBObject(insert, true);
                var attribute = new AttributeReference();
                attribute.SetAttributeFromBlock(number, insert.BlockTransform);
                attribute.TextString = "A-101";
                insert.AttributeCollection.AppendAttribute(attribute); tr.AddNewlyCreatedDBObject(attribute, true);
                tr.Commit();
            }
            db.SaveAs(path, version);
        }
    }
}
}
