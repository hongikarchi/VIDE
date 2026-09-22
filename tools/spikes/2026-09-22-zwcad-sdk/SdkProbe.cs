using System;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Security.Cryptography;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Geometry;
using ZwSoft.ZwCAD.Runtime;

// Loaded only in an explicitly owned test process. No active user document is accessed.
public sealed class VideZwcadSdkProbe
{
    [CommandMethod("VIDESdkProbe", CommandFlags.Session)]
    public void Run()
    {
        string directory = Environment.GetEnvironmentVariable("VIDE_ZWCAD_PROBE_DIR");
        if (String.IsNullOrEmpty(directory) || !Path.IsPathRooted(directory) || !Directory.Exists(directory)) return;
        string model = Path.Combine(directory, "sdk-probe.dwg");
        string report = Path.Combine(directory, "result.json");
        string originalHash = null;
        if (File.Exists(model) || File.Exists(report)) return;
        try
        {
            string handle;
            using (Database database = new Database(true, true))
            {
                database.Insunits = UnitsValue.Millimeters;
                using (Transaction transaction = database.TransactionManager.StartTransaction())
                {
                    BlockTable blocks = (BlockTable)transaction.GetObject(database.BlockTableId, OpenMode.ForRead);
                    BlockTableRecord space = (BlockTableRecord)transaction.GetObject(blocks[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
                    using (Polyline line = new Polyline())
                    {
                        line.AddVertexAt(0, new Point2d(0, 0), 0, 0, 0);
                        line.AddVertexAt(1, new Point2d(20000, 0), 0, 0, 0);
                        line.AddVertexAt(2, new Point2d(20000, 10000), 0, 0, 0);
                        line.AddVertexAt(3, new Point2d(0, 10000), 0, 0, 0);
                        line.Closed = true;
                        line.ColorIndex = 3;
                        space.AppendEntity(line);
                        transaction.AddNewlyCreatedDBObject(line, true);
                        handle = line.Handle.ToString();
                    }
                    transaction.Commit();
                }
                database.SaveAs(model, DwgVersion.Current);
            }
            using (Database reopened = new Database(false, true))
            {
                reopened.ReadDwgFile(model, FileOpenMode.OpenForReadAndAllShare, true, null);
                reopened.CloseInput(true);
                if (reopened.Insunits != UnitsValue.Millimeters) throw new InvalidOperationException("UNIT_MISMATCH");
                using (Transaction transaction = reopened.TransactionManager.StartTransaction())
                {
                    ObjectId id = reopened.GetObjectId(false, new Handle(Convert.ToInt64(handle, 16)), 0);
                    Polyline line = (Polyline)transaction.GetObject(id, OpenMode.ForRead);
                    if (line.NumberOfVertices != 4 || !line.Closed || line.ColorIndex != 3 || Math.Abs(line.Area - 200000000) > 0.01) throw new InvalidOperationException("READBACK_MISMATCH");
                }
            }
            Dictionary<string, object> evidence = new Dictionary<string, object> { {"passed", true}, {"handle", handle}, {"areaSquareMetres", 200}, {"lengthMetres", 60}, {"units", "mm"}, {"activeDocumentAccessed", false} };
            string codeFile = Path.Combine(directory, "code.cs");
            originalHash = Hash(model);
            if (File.Exists(codeFile))
            {
                string before = Hash(model), candidate = Path.Combine(directory, "candidate.dwg");
                if (File.Exists(candidate)) throw new InvalidOperationException("CANDIDATE_EXISTS");
                using (Database copy = new Database(false, true))
                {
                    copy.ReadDwgFile(model, FileOpenMode.OpenForReadAndAllShare, true, null);
                    copy.CloseInput(true);
                    evidence["codeResult"] = VideCodeProbe.Run(copy, File.ReadAllText(codeFile), directory);
                    copy.SaveAs(candidate, DwgVersion.Current);
                }
                if (Hash(model) != before) throw new InvalidOperationException("SOURCE_CHANGED");
                using (Database copy = new Database(false, true))
                {
                    copy.ReadDwgFile(candidate, FileOpenMode.OpenForReadAndAllShare, true, null);
                    copy.CloseInput(true);
                    using (Transaction transaction = copy.TransactionManager.StartTransaction())
                    {
                        Polyline line = (Polyline)transaction.GetObject(copy.GetObjectId(false, new Handle(Convert.ToInt64(handle, 16)), 0), OpenMode.ForRead);
                        if (copy.Insunits != UnitsValue.Millimeters || line.ColorIndex != 3 || Math.Abs(line.Area - 240000000) > 0.01 || Math.Abs(line.Length - 68000) > 0.001) throw new InvalidOperationException("CODE_READBACK_MISMATCH");
                        evidence["candidateAreaSquareMetres"] = line.Area / 1000000;
                        evidence["candidateLengthMetres"] = line.Length / 1000;
                        evidence["sourceHashPreserved"] = true;
                    }
                }
            }
            Write(report, evidence);
        }
        catch (System.Exception error)
        {
            System.Exception cause = error is System.Reflection.TargetInvocationException && error.InnerException != null ? error.InnerException : error;
            Write(report, new Dictionary<string, object> { {"passed", false}, {"error", cause.GetType().FullName}, {"message", cause.Message}, {"sourceHashPreserved", originalHash != null && File.Exists(model) && Hash(model) == originalHash}, {"candidateCreated", File.Exists(Path.Combine(directory, "candidate.dwg"))} });
        }
    }
    private static string Hash(string filename) { using (SHA256 hash = SHA256.Create()) return Convert.ToBase64String(hash.ComputeHash(File.ReadAllBytes(filename))); }
    private static void Write(string filename, object value)
    {
        string temporary = filename + ".tmp";
        File.WriteAllText(temporary, new JavaScriptSerializer().Serialize(value));
        File.Move(temporary, filename);
    }
}
