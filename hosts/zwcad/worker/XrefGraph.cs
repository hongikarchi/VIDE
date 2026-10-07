// xref relations of project drawings (SPEC-01.11 11, PLAN-43 T-200). Started by
// hosts/zwcad/xref-dwg.ts in a hidden ZWCAD the engine owns; reads only the copies listed in a
// manifest (VIDE_XREF_MANIFEST, `id<TAB>path` lines) in side databases opened read-only; the
// user's drawings and any open document are never touched. VIDE_XREF_MODE:
//  - `graph`: per drawing one JSON line in VIDE_XREF_OUT — its units, its xref block records (name,
//    the path as stored, attach/overlay, status) and every INSERT of them (model or paper space and
//    layout, or the block that holds it; position, rotation, scale, the row-major block transform).
//  - `display`: per drawing the model space display rows of the attached Sync's reader
//    (AttachedDisplay.Page, shared source) written to `<out dir>/<id>.json`, one JSON line each.
// `<out>.done` ends the run. Paths are resolved by the engine against the ORIGINAL drawing's
// folder, not here (the copy sits in another folder).
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
public sealed class XrefGraphCommand
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    static double[] Row(Matrix3d m)
    {
        var values = new double[16];
        for (int r = 0; r < 4; r++) for (int c = 0; c < 4; c++) values[r * 4 + c] = m[r, c];
        return values;
    }

    static string Status(BlockTableRecord record)
    {
        try { return record.XrefStatus.ToString(); } catch { return "Unknown"; }
    }

    /** One drawing's xref records and their INSERTs. */
    static Dictionary<string, object> Graph(Database db, Transaction tr)
    {
        var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
        var xrefs = new List<object>(); var inserts = new List<object>();
        var names = new HashSet<ObjectId>();
        foreach (ObjectId id in table)
        {
            var record = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
            if (!record.IsFromExternalReference) continue;
            names.Add(id);
            xrefs.Add(new Dictionary<string, object> {
                { "name", record.Name }, { "path", record.PathName ?? "" },
                { "overlay", record.IsFromOverlayReference }, { "status", Status(record) } });
        }
        if (names.Count == 0) return new Dictionary<string, object> { { "xrefs", xrefs }, { "inserts", inserts } };
        foreach (ObjectId id in table)
        {
            var owner = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
            if (owner.IsFromExternalReference || owner.IsDependent) continue;
            string space = null, layout = null, block = null;
            if (owner.IsLayout)
            {
                layout = ((Layout)tr.GetObject(owner.LayoutId, OpenMode.ForRead)).LayoutName;
                space = owner.Name.Equals(BlockTableRecord.ModelSpace, StringComparison.OrdinalIgnoreCase) ? "model" : "paper";
            }
            else block = owner.Name;
            foreach (ObjectId entityId in owner)
            {
                if (!entityId.ObjectClass.IsDerivedFrom(RXObject.GetClass(typeof(BlockReference)))) continue;
                var reference = tr.GetObject(entityId, OpenMode.ForRead) as BlockReference;
                if (reference == null || !names.Contains(reference.BlockTableRecord)) continue;
                var record = (BlockTableRecord)tr.GetObject(reference.BlockTableRecord, OpenMode.ForRead);
                var scale = reference.ScaleFactors;
                inserts.Add(new Dictionary<string, object> {
                    { "name", record.Name }, { "handle", reference.Handle.ToString() },
                    { "space", space ?? "block" }, { "layout", layout }, { "block", block },
                    { "nested", block != null },
                    { "position", new[] { reference.Position.X, reference.Position.Y, reference.Position.Z } },
                    { "rotation", reference.Rotation },
                    { "scale", new[] { scale.X, scale.Y, scale.Z } },
                    { "transform", Row(reference.BlockTransform) } });
            }
        }
        return new Dictionary<string, object> { { "xrefs", xrefs }, { "inserts", inserts } };
    }

    /** Model space display rows of the whole drawing, page by page (the attached Sync's reader). */
    static Dictionary<string, object> Display(Database db)
    {
        var objects = new List<object>(); var scene = new List<object>();
        var omittedTypes = new Dictionary<string, int>(); var warnings = new Dictionary<string, int>();
        int offset = 0, total = 0, displayed = 0, omitted = 0;
        do
        {
            int next;
            object page = AttachedDisplay.Page(db, offset, 250, 0, out next, out total);
            Func<string, object> field = name => page.GetType().GetProperty(name).GetValue(page, null);
            objects.AddRange((List<object>)field("objects")); scene.AddRange((List<object>)field("scene"));
            displayed += (int)field("displayed"); omitted += (int)field("omitted");
            foreach (var item in (Dictionary<string, int>)field("omittedTypes")) omittedTypes[item.Key] = (omittedTypes.ContainsKey(item.Key) ? omittedTypes[item.Key] : 0) + item.Value;
            foreach (var item in (Dictionary<string, int>)field("displayWarnings")) warnings[item.Key] = (warnings.ContainsKey(item.Key) ? warnings[item.Key] : 0) + item.Value;
            if (next <= offset) break;
            offset = next;
        } while (offset < total);
        return new Dictionary<string, object> {
            { "objects", objects }, { "scene", scene }, { "displayWarnings", warnings },
            { "displayCoverage", new Dictionary<string, object> { { "total", total }, { "displayed", displayed }, { "omitted", omitted }, { "omittedTypes", omittedTypes } } } };
    }

    [CommandMethod("VIDEXREFGRAPH", CommandFlags.Session)]
    public static void Run()
    {
        string manifest = Environment.GetEnvironmentVariable("VIDE_XREF_MANIFEST");
        string output = Environment.GetEnvironmentVariable("VIDE_XREF_OUT");
        string mode = Environment.GetEnvironmentVariable("VIDE_XREF_MODE") == "display" ? "display" : "graph";
        if (String.IsNullOrEmpty(manifest) || !Path.IsPathRooted(manifest) || !File.Exists(manifest) ||
            String.IsNullOrEmpty(output) || !Path.IsPathRooted(output)) return;
        string folder = Path.GetDirectoryName(output);
        using (var writer = new StreamWriter(output, false, new UTF8Encoding(false)))
        {
            foreach (string line in File.ReadAllLines(manifest, Encoding.UTF8))
            {
                int tab = line.IndexOf('\t');
                if (tab < 0) continue;
                string id = line.Substring(0, tab), path = line.Substring(tab + 1);
                var row = new Dictionary<string, object> { { "id", int.Parse(id, CultureInfo.InvariantCulture) } };
                var watch = Stopwatch.StartNew();
                try
                {
                    using (var db = new Database(false, true))
                    {
                        db.ReadDwgFile(path, FileOpenMode.OpenForReadAndAllShare, true, null);
                        db.CloseInput(true);
                        int units = (int)db.Insunits;
                        // A unitless drawing is read as mm (the usual Korean practice); the copy is
                        // never saved, the engine shows the assumption.
                        bool assumed = false;
                        try { AttachedDisplay.Scale(db); } catch (InvalidOperationException) { db.Insunits = UnitsValue.Millimeters; assumed = true; }
                        row["units"] = units;
                        row["scale"] = AttachedDisplay.Scale(db);
                        row["unitsAssumed"] = assumed;
                        if (mode == "graph")
                            using (Transaction tr = db.TransactionManager.StartTransaction())
                            {
                                foreach (var item in Graph(db, tr)) row[item.Key] = item.Value;
                                tr.Commit();
                            }
                        else
                        {
                            string file = Path.Combine(folder, id + ".json");
                            File.WriteAllText(file, Json.Serialize(Display(db)), new UTF8Encoding(false));
                            row["file"] = file;
                        }
                    }
                    row["error"] = null;
                }
                catch (System.Exception ex) { row["error"] = ex.GetType().Name + ": " + ex.Message; }
                row["ms"] = watch.ElapsedMilliseconds;
                writer.WriteLine(Json.Serialize(row));
                writer.Flush();
            }
        }
        File.WriteAllText(output + ".done", "ok");
    }

    /**
     * Synthetic drawings for the real-ZWCAD test only (tests/integration/zwcad-xref.mjs): writes
     * child.dwg (a square), grand.dwg (a line), parent.dwg (xref child at (1000,0) rotated 90°,
     * scale 2; xref grand by a relative path; xref missing.dwg) and loop-a/loop-b (attached to each
     * other) into VIDE_XREF_FIXTURE, a new folder the caller made. No existing file is opened.
     */
    [CommandMethod("VIDEXREFFIXTURE", CommandFlags.Session)]
    public static void Fixture()
    {
        string folder = Environment.GetEnvironmentVariable("VIDE_XREF_FIXTURE");
        if (String.IsNullOrEmpty(folder) || !Path.IsPathRooted(folder) || !Directory.Exists(folder)) return;
        try
        {
            Directory.CreateDirectory(Path.Combine(folder, "sub"));
            Save(Path.Combine(folder, "child.dwg"), (db, tr, space) => {
                var square = new Polyline();
                square.AddVertexAt(0, new Point2d(0, 0), 0, 0, 0); square.AddVertexAt(1, new Point2d(500, 0), 0, 0, 0);
                square.AddVertexAt(2, new Point2d(500, 500), 0, 0, 0); square.AddVertexAt(3, new Point2d(0, 500), 0, 0, 0);
                square.Closed = true; Add(tr, space, square);
            });
            Save(Path.Combine(folder, "sub", "grand.dwg"), (db, tr, space) => Add(tr, space, new Line(new Point3d(0, 0, 0), new Point3d(100, 0, 0))));
            Save(Path.Combine(folder, "loop-b.dwg"), (db, tr, space) => Add(tr, space, new Line(new Point3d(0, 0, 0), new Point3d(0, 100, 0))));
            Save(Path.Combine(folder, "loop-a.dwg"), (db, tr, space) => Attach(db, tr, space, Path.Combine(folder, "loop-b.dwg"), "loop-b", false, new Point3d(0, 0, 0), 0, 1));
            // loop-b now refers back to loop-a: a cycle.
            Save(Path.Combine(folder, "loop-b.dwg"), (db, tr, space) => {
                Add(tr, space, new Line(new Point3d(0, 0, 0), new Point3d(0, 100, 0)));
                Attach(db, tr, space, Path.Combine(folder, "loop-a.dwg"), "loop-a", true, new Point3d(0, 0, 0), 0, 1);
            });
            // AttachXref opens the file: missing.dwg exists while parent is written, then goes.
            string missing = Path.Combine(folder, "missing.dwg");
            Save(missing, (db, tr, space) => Add(tr, space, new Line(new Point3d(0, 0, 0), new Point3d(1, 0, 0))));
            Save(Path.Combine(folder, "parent.dwg"), (db, tr, space) => {
                Add(tr, space, new Line(new Point3d(0, 0, 0), new Point3d(2000, 0, 0)));
                Attach(db, tr, space, Path.Combine(folder, "child.dwg"), "child", false, new Point3d(1000, 0, 0), Math.PI / 2, 2);
                // Stored as a relative path, as CAD keeps a relative xref.
                ObjectId grand = Attach(db, tr, space, Path.Combine(folder, "sub", "grand.dwg"), "grand", true, new Point3d(0, 500, 0), 0, 1);
                ((BlockTableRecord)tr.GetObject(grand, OpenMode.ForWrite)).PathName = "sub\\grand.dwg";
                Attach(db, tr, space, missing, "missing", false, new Point3d(0, 0, 0), 0, 1);
            });
            File.Delete(missing);
            File.WriteAllText(Path.Combine(folder, "fixture.done"), "ok");
        }
        catch (System.Exception ex) { File.WriteAllText(Path.Combine(folder, "fixture.error"), ex.ToString()); }
    }

    static void Add(Transaction tr, BlockTableRecord space, Entity entity)
    {
        space.AppendEntity(entity); tr.AddNewlyCreatedDBObject(entity, true);
    }
    static ObjectId Attach(Database db, Transaction tr, BlockTableRecord space, string path, string name, bool overlay, Point3d at, double rotation, double scale)
    {
        ObjectId record = overlay ? db.OverlayXref(path, name) : db.AttachXref(path, name);
        var reference = new BlockReference(at, record) { Rotation = rotation, ScaleFactors = new Scale3d(scale) };
        Add(tr, space, reference);
        return record;
    }
    static void Save(string path, Action<Database, Transaction, BlockTableRecord> build)
    {
        using (var db = new Database(true, true))
        {
            db.Insunits = UnitsValue.Millimeters;
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var space = (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
                build(db, tr, space);
                tr.Commit();
            }
            db.SaveAs(path, DwgVersion.Current);
        }
    }
}
}
