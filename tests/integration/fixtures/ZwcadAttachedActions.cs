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
            } else if (action == "styles") {
                Styles(first, folder);
            } else if (action == "xclip") {
                // A clipped insert made by the XCLIP command itself (different clip-space transforms).
                using (first.LockDocument())
                using (var tx = first.Database.TransactionManager.StartTransaction()) {
                    var table = (BlockTable)tx.GetObject(first.Database.BlockTableId, OpenMode.ForRead);
                    var space = (BlockTableRecord)tx.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
                    var block = new BlockReference(new Point3d(20000, 50000, 0), table["VIDE_XREF_PART"]) { Rotation = Math.PI / 2 };
                    space.AppendEntity(block); tx.AddNewlyCreatedDBObject(block, true);
                    tx.Commit();
                }
                first.SendStringToExecute("_XCLIP\n(entlast)\n\n_N\n_R\n19000,49000\n21000,53000\n", true, false, false);
                return;
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
    // Display-style fixture: layer colour/weight, layer-0 block children, MText, hatches, clipped xref.
    private static void Styles(Document document, string folder)
    {
        string xrefPath = Path.Combine(folder, "xref-part.dwg");
        using (var part = new Database(true, true)) {
            part.Insunits = UnitsValue.Millimeters;
            using (var tx = part.TransactionManager.StartTransaction()) {
                var table = (BlockTable)tx.GetObject(part.BlockTableId, OpenMode.ForRead);
                var space = (BlockTableRecord)tx.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
                var line = new Line(new Point3d(0, 0, 0), new Point3d(10000, 0, 0));
                space.AppendEntity(line); tx.AddNewlyCreatedDBObject(line, true);
                tx.Commit();
            }
            part.SaveAs(xrefPath, DwgVersion.Current);
        }
        var db = document.Database;
        using (document.LockDocument())
        using (var tx = db.TransactionManager.StartTransaction()) {
            var layers = (LayerTable)tx.GetObject(db.LayerTableId, OpenMode.ForWrite);
            foreach (var spec in new[] { Tuple.Create("A-WALL", (short)1, LineWeight.LineWeight050), Tuple.Create("B-FURN", (short)5, LineWeight.LineWeight018) }) {
                var layer = new LayerTableRecord { Name = spec.Item1, LineWeight = spec.Item3 };
                layer.Color = ZwSoft.ZwCAD.Colors.Color.FromColorIndex(ZwSoft.ZwCAD.Colors.ColorMethod.ByAci, spec.Item2);
                layers.Add(layer); tx.AddNewlyCreatedDBObject(layer, true);
            }
            var table = (BlockTable)tx.GetObject(db.BlockTableId, OpenMode.ForWrite);
            var space = (BlockTableRecord)tx.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
            Func<Entity, ObjectId> add = entity => { var id = space.AppendEntity(entity); tx.AddNewlyCreatedDBObject(entity, true); return id; };
            add(new Line(new Point3d(0, 30000, 0), new Point3d(4000, 30000, 0)) { Layer = "A-WALL" });
            var chair = new BlockTableRecord { Name = "VIDE_STYLE_CHAIR" };
            var chairId = table.Add(chair); tx.AddNewlyCreatedDBObject(chair, true);
            var seat = new Line(new Point3d(0, 0, 0), new Point3d(500, 0, 0)) { Layer = "0" };
            chair.AppendEntity(seat); tx.AddNewlyCreatedDBObject(seat, true);
            var back = new Line(new Point3d(0, 0, 0), new Point3d(0, 500, 0)) { Layer = "A-WALL" };
            chair.AppendEntity(back); tx.AddNewlyCreatedDBObject(back, true);
            add(new BlockReference(new Point3d(0, 32000, 0), chairId) { Layer = "B-FURN" });
            add(new MText { Location = new Point3d(0, 34000, 0), TextHeight = 300, Contents = "평면도\\P2층", Attachment = AttachmentPoint.TopLeft });
            var outer = new Polyline(); outer.AddVertexAt(0, new Point2d(0, 36000), 0, 0, 0); outer.AddVertexAt(1, new Point2d(4000, 36000), 0, 0, 0);
            outer.AddVertexAt(2, new Point2d(4000, 40000), 0, 0, 0); outer.AddVertexAt(3, new Point2d(0, 40000), 0, 0, 0); outer.Closed = true;
            var hole = new Polyline(); hole.AddVertexAt(0, new Point2d(1000, 37000), 0, 0, 0); hole.AddVertexAt(1, new Point2d(3000, 37000), 0, 0, 0);
            hole.AddVertexAt(2, new Point2d(3000, 39000), 0, 0, 0); hole.AddVertexAt(3, new Point2d(1000, 39000), 0, 0, 0); hole.Closed = true;
            var outerId = add(outer); var holeId = add(hole);
            var solid = new Hatch(); add(solid);
            solid.SetHatchPattern(HatchPatternType.PreDefined, "SOLID"); solid.ColorIndex = 3;
            solid.AppendLoop(HatchLoopTypes.Outermost, new ObjectIdCollection(new[] { outerId }));
            solid.AppendLoop(HatchLoopTypes.Default, new ObjectIdCollection(new[] { holeId }));
            solid.EvaluateHatch(true);
            var pattern = new Hatch(); add(pattern);
            pattern.SetHatchPattern(HatchPatternType.PreDefined, "ANSI31"); pattern.PatternScale = 100;
            pattern.AppendLoop(HatchLoopTypes.Outermost, new ObjectIdCollection(new[] { holeId }));
            pattern.EvaluateHatch(true);
            var xrefId = db.AttachXref(xrefPath, "VIDE_XREF_PART");
            var xref = new BlockReference(new Point3d(0, 42000, 0), xrefId);
            add(xref);
            xref.CreateExtensionDictionary();
            var extension = (DBDictionary)tx.GetObject(xref.ExtensionDictionary, OpenMode.ForWrite);
            var filters = new DBDictionary();
            extension.SetAt("ACAD_FILTER", filters); tx.AddNewlyCreatedDBObject(filters, true);
            var clip = new ZwSoft.ZwCAD.DatabaseServices.Filters.SpatialFilter();
            var corners = new Point2dCollection(new[] { new Point2d(-1000, -1000), new Point2d(5000, 1000) });
            clip.Definition = new ZwSoft.ZwCAD.DatabaseServices.Filters.SpatialFilterDefinition(corners, Vector3d.ZAxis, 0, 0, 0, true);
            filters.SetAt("SPATIAL", clip); tx.AddNewlyCreatedDBObject(clip, true);
            tx.Commit();
        }
    }
}
