using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.DatabaseServices;

// In-process session experiment. Disk snapshots are candidates, never user originals.
internal sealed class VideSessionProbe
{
    private readonly string directory;
    private readonly Dictionary<string, Receipt> receipts = new Dictionary<string, Receipt>();
    private string current;
    private int revision;
    private bool uncertain;
    private sealed class Receipt { internal string Hash; internal object Result; }

    internal VideSessionProbe(string directory)
    {
        this.directory = directory;
        // Reuse the checked synthetic fixture; this does not open an active CAD document.
        new VideZwcadSdkProbe().Run();
        current = Path.Combine(directory, "sdk-probe.dwg");
        if (!File.Exists(current)) throw new InvalidOperationException("SEED_UNAVAILABLE");
        Snapshot(current);
    }

    internal object Dispatch(Dictionary<string, object> request)
    {
        string method = Convert.ToString(request["method"]);
        if (method == "query") return new { ok = true, revision, uncertain, snapshot = Snapshot(current) };
        if (method != "execute") return new { ok = false, code = "UNSUPPORTED_METHOD" };
        string operation = Value(request, "operationId"), code = Value(request, "code");
        Guid id;
        if (!Guid.TryParseExact(operation, "D", out id) || String.IsNullOrWhiteSpace(code) || code.Length > 65536)
            return new { ok = false, code = "INVALID_OPERATION" };
        string hash = Hash(Encoding.UTF8.GetBytes(code + "\n" + Value(request, "revision")));
        Receipt old;
        if (receipts.TryGetValue(operation, out old))
            return old.Hash == hash ? old.Result : new { ok = false, code = "OPERATION_CONFLICT" };
        if (uncertain) return new { ok = false, code = "HOST_RESULT_UNKNOWN" };
        if (Value(request, "revision") != revision.ToString()) return new { ok = false, code = "STALE_REVISION" };
        string candidate = Path.Combine(directory, operation + ".dwg");
        if (File.Exists(candidate)) { uncertain = true; return new { ok = false, code = "HOST_RESULT_UNKNOWN" }; }
        string sourceHash = Hash(File.ReadAllBytes(current));
        bool saving = false;
        object result;
        try
        {
            object value;
            using (Database database = Open(current))
            {
                value = VideCodeProbe.Run(database, code, directory);
                // Reject non-serializable return values before a candidate is written.
                new JavaScriptSerializer().Serialize(value);
                saving = true;
                database.SaveAs(candidate, DwgVersion.Current);
            }
            object snapshot = Snapshot(candidate);
            if (Hash(File.ReadAllBytes(current)) != sourceHash) throw new InvalidOperationException("SOURCE_CHANGED");
            result = new { ok = true, operationId = operation, revision = revision + 1, snapshot, value,
                filename = candidate, fileHash = Hash(File.ReadAllBytes(candidate)), readbackVerified = true };
            Persist(operation, hash, result);
            current = candidate; revision++;
        }
        catch (System.Exception error)
        {
            System.Exception cause = error is System.Reflection.TargetInvocationException && error.InnerException != null ? error.InnerException : error;
            if (saving || Hash(File.ReadAllBytes(current)) != sourceHash) uncertain = true;
            result = new { ok = false, operationId = operation, revision,
                code = uncertain ? "HOST_RESULT_UNKNOWN" : "CODE_FAILED", diagnostics = cause.Message };
            // This spike has no restart/recovery path. Failure to persist also blocks this session.
            try { Persist(operation, hash, result); } catch { uncertain = true; throw; }
        }
        receipts.Add(operation, new Receipt { Hash = hash, Result = result });
        return result;
    }

    private void Persist(string operation, string hash, object result)
    {
        string path = Path.Combine(directory, operation + ".receipt.json");
        File.WriteAllText(path + ".tmp", new JavaScriptSerializer().Serialize(new { hash, result }));
        File.Move(path + ".tmp", path);
    }
    private static Database Open(string path)
    {
        Database database = new Database(false, true);
        try { database.ReadDwgFile(path, FileOpenMode.OpenForReadAndAllShare, true, null); database.CloseInput(true); return database; }
        catch { database.Dispose(); throw; }
    }
    private static object Snapshot(string path)
    {
        using (Database database = Open(path))
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            if (database.Insunits != UnitsValue.Millimeters) throw new InvalidOperationException("UNKNOWN_UNITS");
            var blocks = (BlockTable)transaction.GetObject(database.BlockTableId, OpenMode.ForRead);
            var space = (BlockTableRecord)transaction.GetObject(blocks[BlockTableRecord.ModelSpace], OpenMode.ForRead);
            var objects = new List<object>();
            foreach (ObjectId id in space)
            {
                Polyline line = transaction.GetObject(id, OpenMode.ForRead) as Polyline;
                if (line == null || !line.Closed || objects.Count >= 500) throw new InvalidOperationException("UNSUPPORTED_GEOMETRY");
                objects.Add(new { handle = line.Handle.ToString(), area = line.Area / 1000000, length = line.Length / 1000, color = line.ColorIndex });
            }
            return new { units = "mm", objects };
        }
    }
    private static string Value(Dictionary<string, object> request, string key) { object value; return request.TryGetValue(key, out value) ? Convert.ToString(value) : null; }
    private static string Hash(byte[] value) { using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(value)).Replace("-", "").ToLowerInvariant(); }
}
