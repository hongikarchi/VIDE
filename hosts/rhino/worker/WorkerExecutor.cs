using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Rhino;

namespace Vide.Worker;

internal sealed class WorkerExecutor(RhinoDoc document, string directory)
{
    private int revision;
    private bool uncertain;
    private readonly Dictionary<string, (string hash, object result)> receipts = new();

    public object Dispatch(JsonElement request)
    {
        if (request.GetProperty("documentId").GetUInt32() != document.RuntimeSerialNumber ||
            RhinoDoc.FromRuntimeSerialNumber(document.RuntimeSerialNumber) != document)
            throw new InvalidOperationException("TARGET_MISMATCH");
        var method = request.GetProperty("method").GetString();
        if (method == "query") return Snapshot();
        if (method != "execute") throw new InvalidOperationException("UNKNOWN_METHOD");
        var operation = request.GetProperty("operationId").GetString()!;
        if (!Guid.TryParseExact(operation, "D", out _)) throw new InvalidOperationException("INVALID_OPERATION");
        var code = request.GetProperty("code").GetString() ?? "";
        if (code.Length is < 1 or > 65536) throw new InvalidOperationException("INVALID_CODE");
        var basis = request.GetProperty("revision").GetInt32();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(basis + "\n" + code)));
        if (receipts.TryGetValue(operation, out var prior))
        {
            if (prior.hash != hash) throw new InvalidOperationException("OPERATION_CONFLICT");
            return prior.result;
        }
        if (uncertain) throw new InvalidOperationException("HOST_RESULT_UNKNOWN");
        if (basis != revision) throw new InvalidOperationException("STALE_REFERENCE");

        // User code is a string until ALL identity/basis checks above succeed.
        var source = "using System; using System.Linq; using Rhino; using Rhino.Geometry; public static class TaskCode { public static object Run(RhinoDoc doc) { " + code + "\nreturn null; } }";
        var references = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location))
            .Select(a => MetadataReference.CreateFromFile(a.Location));
        var compilation = CSharpCompilation.Create("VIDETask_" + operation.Replace("-", ""),
            [CSharpSyntaxTree.ParseText(source)], references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var bytes = new MemoryStream();
        var compiled = compilation.Emit(bytes);
        if (!compiled.Success) return new { ok = false, code = "COMPILE_ERROR", revision,
            diagnostics = compiled.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(12).Select(d => d.ToString()).ToArray() };

        var pending = new { ok = false, code = "HOST_RESULT_UNKNOWN", operationId = operation };
        receipts[operation] = (hash, pending);
        Persist(operation, hash, pending); // Write intent before loading/evaluating generated code.
        uncertain = true;
        try
        {
            var assembly = Assembly.Load(bytes.ToArray());
            var value = assembly.GetType("TaskCode")!.GetMethod("Run")!.Invoke(null, [document]);
            var filename = Path.Combine(directory, operation + ".3dm");
            if (!document.Write3dmFile(filename, new Rhino.FileIO.FileWriteOptions())) throw new Exception("Save failed");
            using (var reopened = RhinoDoc.OpenHeadless(filename))
            {
                if (reopened == null || reopened.ModelUnitSystem != document.ModelUnitSystem)
                    throw new Exception("Readback units mismatch");
                var originals = document.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).ToArray();
                if (reopened.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Count() != originals.Length)
                    throw new Exception("Readback count mismatch");
                foreach (var original in originals)
                {
                    var restored = reopened.Objects.FindId(original.Id);
                    if (restored == null || restored.ObjectType != original.ObjectType || !restored.Geometry.IsValid)
                        throw new Exception("Readback identity mismatch");
                    var expected = original.Geometry.GetBoundingBox(true);
                    var actual = restored.Geometry.GetBoundingBox(true);
                    if (actual.Min.DistanceTo(expected.Min) > document.ModelAbsoluteTolerance ||
                        actual.Max.DistanceTo(expected.Max) > document.ModelAbsoluteTolerance)
                        throw new Exception("Readback bounds mismatch");
                }
            }
            var fileHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(filename))).ToLowerInvariant();
            revision++;
            var result = new { ok = true, operationId = operation, revision, value, filename, fileHash, readbackVerified = true, snapshot = Snapshot() };
            Persist(operation, hash, result);
            receipts[operation] = (hash, result);
            uncertain = false;
            return result;
        }
        catch { throw new InvalidOperationException("HOST_RESULT_UNKNOWN"); }
    }

    private object Snapshot() => new { ok = true, revision, uncertain, units = document.ModelUnitSystem.ToString(),
        objects = document.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Select(obj => new {
            id = obj.Id, type = obj.ObjectType.ToString(), bounds = Bounds(obj.Geometry.GetBoundingBox(true)) }).ToArray() };
    private static double[][] Bounds(Rhino.Geometry.BoundingBox bounds) =>
        [[bounds.Min.X, bounds.Min.Y, bounds.Min.Z], [bounds.Max.X, bounds.Max.Y, bounds.Max.Z]];
    private void Persist(string operation, string hash, object result)
    {
        var data = JsonSerializer.SerializeToUtf8Bytes(new { operation, hash, result });
        var destination = Path.Combine(directory, operation + ".json");
        var temporary = destination + ".tmp";
        using (var file = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            file.Write(data); file.Flush(true);
        }
        File.Move(temporary, destination, true);
    }
}
