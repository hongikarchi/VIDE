using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.ApplicationServices;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Runtime;

// Only loaded into an owned synthetic test process, never the user's CAD instance
// (tests/integration/zwcad-backflow-attached.mjs). It drives the shared backflow operations
// (hosts/zwcad/worker/BackflowOps.cs) on the open drawing the way the connection plugin's
// `backflow-read`/`backflow-apply` do: a read in an aborted transaction, an apply in one command
// (one UNDO step) that commits only when every op is accepted. The installed VIDE plugin of this
// PC loads at ZWCAD start, so the test cannot NETLOAD a newer copy of the plugin itself.
public sealed class ZwcadBackflowActions
{
    private static string folder;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };

    [CommandMethod("VIDETestBackflow", CommandFlags.Session)]
    public void Start()
    {
        folder = Environment.GetEnvironmentVariable("VIDE_BACKFLOW_TEST_ACTIONS");
        if (String.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return;
        Application.Idle += Tick;
    }

    private static Document Doc => Application.DocumentManager.MdiActiveDocument;

    private static void Answer(object value)
    {
        string path = Path.Combine(folder, "result.json");
        File.WriteAllText(path + ".tmp", Json.Serialize(value), new UTF8Encoding(false));
        File.Move(path + ".tmp", path);
    }

    private static Dictionary<string, object> State(Database db, Transaction tr, ICollection<string> only)
    {
        return new Dictionary<string, object> {
            ["entities"] = Vide.Zwcad.BackflowOps.Entities(db, tr, only), ["dims"] = Vide.Zwcad.BackflowOps.Dimensions(db, tr),
            ["layers"] = Vide.Zwcad.BackflowOps.Layers(db, tr), ["snapshot"] = Vide.Zwcad.BackflowOps.Snapshot(db, tr) };
    }

    private static void Tick(object sender, EventArgs args)
    {
        string path = Path.Combine(folder, "action.txt");
        if (!File.Exists(path) || !String.IsNullOrEmpty(Doc.CommandInProgress)) return;
        string action = File.ReadAllText(path).Trim(); File.Delete(path);
        try
        {
            if (action == "read")
                using (Doc.LockDocument())
                using (var tr = Doc.Database.TransactionManager.StartTransaction())
                {
                    var state = State(Doc.Database, tr, null);
                    tr.Abort();
                    Answer(state);
                }
            else if (action == "apply") Doc.SendStringToExecute("_VIDETESTBFAPPLY ", true, false, false);
            else if (action == "undo") Doc.SendStringToExecute("_.U _VIDETESTBFDONE ", true, false, false);
        }
        catch (System.Exception error) { Answer(new { ok = false, code = error.GetType().Name + ": " + error.Message }); }
    }

    [CommandMethod("VIDETESTBFAPPLY", CommandFlags.Modal | CommandFlags.NoHistory)]
    public void Apply()
    {
        try
        {
            var ops = Json.Deserialize<ArrayList>(File.ReadAllText(Path.Combine(folder, "ops.json"), Encoding.UTF8));
            var touched = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Dictionary<string, object> op in ops) if (op.ContainsKey("handle")) touched.Add(Convert.ToString(op["handle"]));
            var db = Doc.Database;
            var result = new Dictionary<string, object>();
            using (var tr = db.TransactionManager.StartTransaction()) { result["before"] = State(db, tr, touched); tr.Abort(); }
            Dictionary<string, object> applied;
            using (var tr = db.TransactionManager.StartTransaction())
            {
                applied = Vide.Zwcad.BackflowOps.Apply(db, tr, ops, 7);
                if (true.Equals(applied["ok"])) tr.Commit(); else tr.Abort();
            }
            result["ok"] = applied["ok"]; result["results"] = applied["results"]; result["failed"] = applied["failed"];
            using (var tr = db.TransactionManager.StartTransaction()) { result["after"] = State(db, tr, null); tr.Abort(); }
            Answer(result);
        }
        catch (System.Exception error) { Answer(new { ok = false, code = error.GetType().Name + ": " + error.Message }); }
    }

    [CommandMethod("VIDETESTBFDONE", CommandFlags.Modal | CommandFlags.NoHistory)]
    public void Done() => Answer(new { ok = true });
}
