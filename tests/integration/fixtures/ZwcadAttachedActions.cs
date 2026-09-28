using System;
using System.IO;
using ZwSoft.ZwCAD.ApplicationServices;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Geometry;
using ZwSoft.ZwCAD.Runtime;

// Only loaded into an owned synthetic test process, never the user's CAD instance.
public sealed class ZwcadAttachedActions
{
    private static Document first, second;
    private static string folder;
    [CommandMethod("VIDETestAttachedActions", CommandFlags.Session)]
    public void Start()
    {
        folder = Environment.GetEnvironmentVariable("VIDE_ATTACHED_TEST_ACTIONS");
        if (String.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return;
        first = Application.DocumentManager.MdiActiveDocument;
        Application.Idle += Tick;
    }
    private static void Tick(object sender, EventArgs args)
    {
        string path = Path.Combine(folder, "action.txt");
        if (!File.Exists(path) || !String.IsNullOrEmpty(Application.DocumentManager.MdiActiveDocument.CommandInProgress)) return;
        string action = File.ReadAllText(path); File.Delete(path);
        try {
            if (action == "move") {
                using (first.LockDocument())
                using (var tx = first.Database.TransactionManager.StartTransaction()) {
                    var table = (BlockTable)tx.GetObject(first.Database.BlockTableId, OpenMode.ForRead);
                    var space = (BlockTableRecord)tx.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                    foreach (ObjectId id in space) {
                        var e = (Entity)tx.GetObject(id, OpenMode.ForWrite);
                        e.TransformBy(Matrix3d.Displacement(new Vector3d(1000, 0, 0)));
                    }
                    tx.Commit();
                }
            } else if (action == "large") {
                using (first.LockDocument())
                using (var tx = first.Database.TransactionManager.StartTransaction()) {
                    var table = (BlockTable)tx.GetObject(first.Database.BlockTableId, OpenMode.ForWrite);
                    var definition = new BlockTableRecord { Name = "VIDE_LARGE_TEST" };
                    var definitionId = table.Add(definition); tx.AddNewlyCreatedDBObject(definition, true);
                    for (int i = 0; i < 5000; i++) {
                        var circle = new Circle(new Point3d(i * 10, 0, 0), Vector3d.ZAxis, 5);
                        definition.AppendEntity(circle); tx.AddNewlyCreatedDBObject(circle, true);
                    }
                    var space = (BlockTableRecord)tx.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
                    var block = new BlockReference(Point3d.Origin, definitionId);
                    space.AppendEntity(block); tx.AddNewlyCreatedDBObject(block, true);
                    var line = new Line(new Point3d(0, 10000, 0), new Point3d(5000, 10000, 0));
                    space.AppendEntity(line); tx.AddNewlyCreatedDBObject(line, true);
                    tx.Commit();
                }
            } else if (action == "second") {
                second = Application.DocumentManager.Add("");
                second.Database.Insunits = UnitsValue.Millimeters;
                second.SendStringToExecute("VIDECADConnect\n", true, false, false);
            } else if (action == "disconnect") {
                Application.DocumentManager.MdiActiveDocument = first;
                first.SendStringToExecute("VIDECADDisconnect\n", true, false, false);
            } else if (action == "close-second") {
                second.CloseAndDiscard();
            }
            File.WriteAllText(Path.Combine(folder, "done.txt"), action);
        } catch (System.Exception error) { File.WriteAllText(Path.Combine(folder, "error.txt"), error.ToString()); }
    }
}
