// 역반영 읽기·닫힌 도면 적용 (SPEC-14.8·14.11 2, PLAN-47 T-233). Started by hosts/zwcad/drawing-backflow.ts
// in a hidden ZWCAD the engine owns (runHiddenZwcad); side databases only (ReadDwgFile + CloseInput).
//  - VIDEDRAWINGENTITIES: the engine's copies listed in VIDE_DRAWING_MANIFEST (`id<TAB>path`) → one
//    JSON line per drawing in VIDE_DRAWING_OUT {id, version, units, layers, entities, dims, error, ms},
//    then `<out>.done`. Rows come from BackflowOps (shared with the connection plugin).
//  - VIDEDRAWINGAPPLY: jobs in VIDE_BACKFLOW_JOBS ([{id, source, target, ops, revision}], sources are
//    the engine's copies). Each job reads its copy, takes the before snapshot, applies the ops in one
//    transaction and stages the result through the run's OutputGrant (token path, no overwrite, the
//    source's DWG version). Any refused op or failed job discards every staged file (all or nothing);
//    otherwise the grant commits them all and each new file is read back (snapshot, entities,
//    dimensions). One JSON object in VIDE_DRAWING_RESULT, then `<result>.done`.
//  - VIDEBACKFLOWFIXTURE: synthetic drawings for the real-ZWCAD test only
//    (tests/integration/zwcad-drawing-backflow.mjs) into the empty folder VIDE_BACKFLOW_FIXTURE.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Geometry;
using ZwSoft.ZwCAD.Runtime;

namespace Vide.Zwcad
{
public sealed class DrawingBackflowCommand
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };

    static void Step(string name)
    {
        string file = Environment.GetEnvironmentVariable("VIDE_WORKER_STEP");
        if (String.IsNullOrEmpty(file) || !Path.IsPathRooted(file)) return;
        try { File.AppendAllText(file, name + Environment.NewLine, new UTF8Encoding(false)); } catch { /* Diagnostics only. */ }
    }

    static Database Read(string path)
    {
        var db = new Database(false, true);
        try { db.ReadDwgFile(path, FileOpenMode.OpenForReadAndAllShare, true, null); db.CloseInput(true); }
        catch { db.Dispose(); throw; }
        return db;
    }

    [CommandMethod("VIDEDRAWINGENTITIES", CommandFlags.Session)]
    public static void Entities()
    {
        string manifest = Environment.GetEnvironmentVariable("VIDE_DRAWING_MANIFEST");
        string output = Environment.GetEnvironmentVariable("VIDE_DRAWING_OUT");
        if (String.IsNullOrEmpty(manifest) || !Path.IsPathRooted(manifest) || !File.Exists(manifest) ||
            String.IsNullOrEmpty(output) || !Path.IsPathRooted(output)) return;
        using (var writer = new StreamWriter(output, false, new UTF8Encoding(false)))
        {
            foreach (string line in File.ReadAllLines(manifest, Encoding.UTF8))
            {
                int tab = line.IndexOf('\t');
                if (tab < 0) continue;
                string id = line.Substring(0, tab), path = line.Substring(tab + 1);
                var row = new Dictionary<string, object> { { "id", int.Parse(id, CultureInfo.InvariantCulture) } };
                var watch = Stopwatch.StartNew();
                Step("read " + id);
                try
                {
                    using (var db = Read(path))
                    {
                        row["version"] = OutputGrant.Magic(db.OriginalFileVersion);
                        row["units"] = (int)db.Insunits;
                        Step("entities " + id);
                        using (Transaction tr = db.TransactionManager.StartTransaction())
                        {
                            row["layers"] = BackflowOps.Layers(db, tr);
                            row["entities"] = BackflowOps.Entities(db, tr);
                            row["dims"] = BackflowOps.Dimensions(db, tr);
                            tr.Commit();
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
        Step("done");
        File.WriteAllText(output + ".done", "ok");
    }

    /** Handles the ops name (modified and deleted): their entities before the apply. */
    static HashSet<string> Touched(ArrayList ops)
    {
        var handles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (object item in ops)
            if (item is Dictionary<string, object> op && op.ContainsKey("handle") && op["handle"] != null)
                handles.Add(Convert.ToString(op["handle"], CultureInfo.InvariantCulture).ToUpperInvariant());
        return handles;
    }

    static Dictionary<string, object> State(Database db, ICollection<string> only)
    {
        using (Transaction tr = db.TransactionManager.StartTransaction())
        {
            var state = new Dictionary<string, object> {
                ["snapshot"] = BackflowOps.Snapshot(db, tr), ["entities"] = BackflowOps.Entities(db, tr, only),
                ["dims"] = BackflowOps.Dimensions(db, tr), ["layers"] = BackflowOps.Layers(db, tr) };
            tr.Commit();
            return state;
        }
    }

    [CommandMethod("VIDEDRAWINGAPPLY", CommandFlags.Session)]
    public static void Apply()
    {
        string result = Environment.GetEnvironmentVariable("VIDE_DRAWING_RESULT");
        if (String.IsNullOrEmpty(result) || !Path.IsPathRooted(result)) return;
        var answer = new Dictionary<string, object>();
        var jobs = new List<object>();
        OutputGrant grant = null;
        var open = new List<KeyValuePair<Database, Dictionary<string, object>>>();
        try
        {
            Step("grant");
            grant = OutputGrant.Load(Environment.GetEnvironmentVariable("VIDE_OUTPUT_GRANT"), Environment.GetEnvironmentVariable("VIDE_OUTPUT_TOKEN"));
            string jobsPath = Environment.GetEnvironmentVariable("VIDE_BACKFLOW_JOBS");
            if (String.IsNullOrEmpty(jobsPath) || !Path.IsPathRooted(jobsPath) || !File.Exists(jobsPath)) throw new OutputRefused("INVALID_INPUT");
            var list = Json.Deserialize<ArrayList>(File.ReadAllText(jobsPath, Encoding.UTF8));
            bool failed = false;
            foreach (Dictionary<string, object> job in list)
            {
                string id = Convert.ToString(job["id"], CultureInfo.InvariantCulture);
                string source = Convert.ToString(job["source"]), target = Convert.ToString(job["target"]);
                var ops = (ArrayList)job["ops"];
                int revision = Convert.ToInt32(job["revision"], CultureInfo.InvariantCulture);
                var row = new Dictionary<string, object> { ["id"] = id };
                jobs.Add(row);
                if (failed) { row["ok"] = false; row["code"] = "NOT_RUN"; continue; }
                try
                {
                    if (String.IsNullOrEmpty(source) || !Path.IsPathRooted(source) || !File.Exists(source)) throw new OutputRefused("SOURCE_MISSING");
                    grant.Authorize(target);
                    Step("read " + id);
                    var db = Read(source);
                    open.Add(new KeyValuePair<Database, Dictionary<string, object>>(db, row));
                    Step("before " + id);
                    row["before"] = State(db, Touched(ops));
                    Step("apply " + id);
                    Dictionary<string, object> applied;
                    using (Transaction tr = db.TransactionManager.StartTransaction())
                    {
                        applied = BackflowOps.Apply(db, tr, ops, revision);
                        if (true.Equals(applied["ok"])) tr.Commit(); else tr.Abort();
                    }
                    row["results"] = applied["results"]; row["failed"] = applied["failed"];
                    if (!true.Equals(applied["ok"])) throw new OutputRefused("OP_REFUSED");
                    Step("stage " + id);
                    grant.Stage(db, target);
                    row["ok"] = true; row["path"] = Path.GetFullPath(target);
                }
                catch (OutputRefused refused) { failed = true; row["ok"] = false; row["code"] = refused.Code; Step("refused " + id + " " + refused.Code); }
                catch (System.Exception ex) { failed = true; row["ok"] = false; row["code"] = "WRITE_FAILED"; row["message"] = ex.GetType().Name + ": " + ex.Message; Step("failed " + id); }
            }
            foreach (var pair in open) pair.Key.Dispose();
            open.Clear();
            if (failed)
            {
                grant.Discard();
                answer["ok"] = false; answer["code"] = "APPLY_FAILED";
            }
            else
            {
                Step("commit");
                grant.Commit();
                foreach (Dictionary<string, object> row in jobs)
                {
                    Step("readback " + row["id"]);
                    using (var back = Read((string)row["path"])) row["after"] = State(back, null);
                }
                answer["ok"] = true;
            }
            Step("done");
        }
        catch (OutputRefused refused) { grant?.Discard(); answer["ok"] = false; answer["code"] = refused.Code; Step("refused " + refused.Code); }
        catch (System.Exception ex) { grant?.Discard(); answer["ok"] = false; answer["code"] = "WRITE_FAILED"; answer["message"] = ex.GetType().Name + ": " + ex.Message; Step("failed " + ex.GetType().Name); }
        finally { foreach (var pair in open) pair.Key.Dispose(); }
        answer["jobs"] = jobs;
        File.WriteAllText(result, Json.Serialize(answer), new UTF8Encoding(false));
        File.WriteAllText(result + ".done", "ok");
    }

    /**
     * child.dwg (AC1027): a square polyline and an arc. root.dwg (AC1032), mm: layers 벽 (red),
     * 가구 and 잠금 (locked); on 벽 a line (own colour, lineweight 0.30), a polyline with one arc
     * segment, an arc and a dimension (not associative) on the line's end points; a circle and an
     * INSERT of block 의자 on 가구; a text; a line on 잠금; child.dwg attached by a relative path.
     * Written only into a new empty folder.
     */
    [CommandMethod("VIDEBACKFLOWFIXTURE", CommandFlags.Session)]
    public static void Fixture()
    {
        string folder = Environment.GetEnvironmentVariable("VIDE_BACKFLOW_FIXTURE");
        if (String.IsNullOrEmpty(folder) || !Path.IsPathRooted(folder) || !Directory.Exists(folder)) return;
        try
        {
            Synthetic(Path.Combine(folder, "child.dwg"), DwgVersion.AC1027, (db, tr, space, layers) => {
                var square = new Polyline();
                square.AddVertexAt(0, new Point2d(0, 0), 0, 0, 0); square.AddVertexAt(1, new Point2d(500, 0), 0, 0, 0);
                square.AddVertexAt(2, new Point2d(500, 500), 0, 0, 0); square.AddVertexAt(3, new Point2d(0, 500), 0, 0, 0);
                square.Closed = true; square.LayerId = layers["벽"]; Add(tr, space, square);
                Add(tr, space, new Arc(new Point3d(250, 250, 0), 100, 0, Math.PI) { LayerId = layers["벽"] });
            });
            string child = Path.Combine(folder, "child.dwg");
            Synthetic(Path.Combine(folder, "root.dwg"), DwgVersion.AC1032, (db, tr, space, layers) => {
                var wall = layers["벽"];
                var line = new Line(new Point3d(0, 0, 0), new Point3d(4000, 0, 0)) { LayerId = wall, ColorIndex = 5, LineWeight = LineWeight.LineWeight030 };
                Add(tr, space, line);
                var bent = new Polyline { LayerId = wall };
                bent.AddVertexAt(0, new Point2d(0, 1000), 0, 0, 0); bent.AddVertexAt(1, new Point2d(2000, 1000), 0.5, 0, 0);
                bent.AddVertexAt(2, new Point2d(3000, 2000), 0, 0, 0);
                Add(tr, space, bent);
                Add(tr, space, new Arc(new Point3d(6000, 0, 0), 1000, 0, Math.PI / 2) { LayerId = wall });
                Add(tr, space, new Circle(new Point3d(6000, 3000, 0), Vector3d.ZAxis, 500) { LayerId = layers["가구"] });
                var blocks = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForWrite);
                var chair = new BlockTableRecord { Name = "의자" };
                ObjectId chairId = blocks.Add(chair); tr.AddNewlyCreatedDBObject(chair, true);
                var seat = new Polyline();
                seat.AddVertexAt(0, new Point2d(0, 0), 0, 0, 0); seat.AddVertexAt(1, new Point2d(450, 0), 0, 0, 0);
                seat.AddVertexAt(2, new Point2d(450, 450), 0, 0, 0); seat.Closed = true;
                chair.AppendEntity(seat); tr.AddNewlyCreatedDBObject(seat, true);
                Add(tr, space, new BlockReference(new Point3d(1000, 3000, 0), chairId) { LayerId = layers["가구"] });
                Add(tr, space, new RotatedDimension(0, new Point3d(0, 0, 0), new Point3d(4000, 0, 0), new Point3d(2000, -500, 0), "", db.Dimstyle) { LayerId = wall });
                Add(tr, space, new DBText { Position = new Point3d(100, 200, 0), TextString = "거실", Height = 250, LayerId = wall });
                Add(tr, space, new Line(new Point3d(0, -2000, 0), new Point3d(1000, -2000, 0)) { LayerId = layers["잠금"] });
                ObjectId xref = db.AttachXref(child, "child");
                Add(tr, space, new BlockReference(new Point3d(10000, 0, 0), xref));
                ((BlockTableRecord)tr.GetObject(xref, OpenMode.ForWrite)).PathName = "child.dwg";
            });
            File.WriteAllText(Path.Combine(folder, "fixture.done"), "ok");
        }
        catch (System.Exception ex) { File.WriteAllText(Path.Combine(folder, "fixture.error"), ex.ToString()); }
    }

    static void Add(Transaction tr, BlockTableRecord space, Entity entity)
    {
        space.AppendEntity(entity); tr.AddNewlyCreatedDBObject(entity, true);
    }

    static void Synthetic(string path, DwgVersion version, Action<Database, Transaction, BlockTableRecord, Dictionary<string, ObjectId>> build)
    {
        if (File.Exists(path)) throw new InvalidOperationException("fixture exists");
        using (var db = new Database(true, true))
        {
            db.Insunits = UnitsValue.Millimeters;
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var table = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForWrite);
                var layers = new Dictionary<string, ObjectId>();
                foreach (var name in new[] { "벽", "가구", "잠금" })
                {
                    var layer = new LayerTableRecord { Name = name };
                    if (name == "벽") layer.Color = ZwSoft.ZwCAD.Colors.Color.FromColorIndex(ZwSoft.ZwCAD.Colors.ColorMethod.ByAci, 1);
                    layers[name] = table.Add(layer); tr.AddNewlyCreatedDBObject(layer, true);
                    if (name == "잠금") layer.IsLocked = true;
                }
                var blocks = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var space = (BlockTableRecord)tr.GetObject(blocks[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
                build(db, tr, space, layers);
                tr.Commit();
            }
            db.SaveAs(path, version);
        }
    }
}
}
