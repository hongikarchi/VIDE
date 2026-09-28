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
    private readonly WorkerChanges modelBasis = new(document);
    private readonly (UnitSystem, double, double, double) initialMeasurementContext = MeasurementContext(document);
    private (UnitSystem, double, double, double) lastMeasurementContext = MeasurementContext(document);
    private Dictionary<string, (string hash, WorkerScene.Measurements value)> lastMeasurements = new();
    private readonly Dictionary<string, (string hash, object result)> receipts = new();

    private static (UnitSystem, double, double, double) MeasurementContext(RhinoDoc doc) =>
        (doc.ModelUnitSystem, doc.ModelAbsoluteTolerance, doc.ModelRelativeTolerance, doc.ModelAngleToleranceRadians);

    public object Dispatch(JsonElement request)
    {
        if (request.GetProperty("documentId").GetUInt32() != document.RuntimeSerialNumber ||
            RhinoDoc.FromRuntimeSerialNumber(document.RuntimeSerialNumber) != document)
            throw new InvalidOperationException("TARGET_MISMATCH");
        var method = request.GetProperty("method").GetString();
        if (method == "query") return Snapshot();
        if (method is "export" or "exportPage")
        {
            if (uncertain) throw new InvalidOperationException("HOST_RESULT_UNKNOWN");
            var offset = method == "exportPage" ? request.GetProperty("offset").GetInt32() : 0;
            var limit = method == "exportPage" ? request.GetProperty("limit").GetInt32() : WorkerScene.MaxObjects;
            if (offset < 0 || limit < 1 || (method == "exportPage" && limit > 1000))
                throw new InvalidOperationException("INVALID_PAGE");
            if (request.TryGetProperty("revision", out var exportRevision)) {
                if (exportRevision.GetInt32() != revision) throw new InvalidOperationException("STALE_REFERENCE");
            } else if (offset > 0) throw new InvalidOperationException("STALE_REFERENCE");
            var cached = new Dictionary<string, WorkerScene.Measurements>();
            if (request.TryGetProperty("measurementCache", out var values))
            {
                if (values.GetArrayLength() > WorkerScene.MaxObjects) throw new InvalidOperationException("INVALID_MEASUREMENT_CACHE");
                foreach (var item in values.EnumerateArray())
                {
                    double? Read(string key) { var value=item.GetProperty(key); if(value.ValueKind==JsonValueKind.Null)return null;
                        var number=value.GetDouble();if(!double.IsFinite(number)||number<0)throw new InvalidOperationException("INVALID_MEASUREMENT_CACHE");return number; }
                    if (!cached.TryAdd(item.GetProperty("id").GetString()!, new(Read("area"), Read("volume"), Read("length"))))
                        throw new InvalidOperationException("INVALID_MEASUREMENT_CACHE");
                }
            }
            var geometryCache = new Dictionary<string, (string hash, WorkerScene.Measurements value)>();
            if (request.TryGetProperty("geometryMeasurementCache", out var geometryValues))
            {
                if (geometryValues.GetArrayLength() > WorkerScene.MaxObjects) throw new InvalidOperationException("INVALID_MEASUREMENT_CACHE");
                foreach (var item in geometryValues.EnumerateArray())
                {
                    double? Read(string key) { var value = item.GetProperty(key); if (value.ValueKind == JsonValueKind.Null) return null;
                        var number = value.GetDouble(); if (!double.IsFinite(number) || number < 0) throw new InvalidOperationException("INVALID_MEASUREMENT_CACHE"); return number; }
                    var geometryKey = item.GetProperty("geometryHash").GetString()!;
                    if (!System.Text.RegularExpressions.Regex.IsMatch(geometryKey, "^[a-f0-9]{64}$") ||
                        !geometryCache.TryAdd(item.GetProperty("id").GetString()!, (geometryKey, new(Read("area"), Read("volume"), Read("length")))))
                        throw new InvalidOperationException("INVALID_MEASUREMENT_CACHE");
                }
            }
            var context = MeasurementContext(document);
            var nextMeasurements = context == lastMeasurementContext
                ? new Dictionary<string, (string hash, WorkerScene.Measurements value)>(lastMeasurements)
                : new Dictionary<string, (string hash, WorkerScene.Measurements value)>();
            var result = WorkerScene.Export(document, (obj, geometryHash) =>
            {
                var id = WorkerScene.Id(obj);
                if (context == lastMeasurementContext && lastMeasurements.TryGetValue(id, out var prior) && prior.hash == geometryHash)
                    return prior.value;
                if (context != initialMeasurementContext) return null;
                return geometryCache.TryGetValue(id, out var match) && match.hash == geometryHash ? match.value :
                    modelBasis.SameMeasurements(obj) && cached.TryGetValue(id, out var value) ? value : null;
            }, (obj, hash, value) => nextMeasurements[WorkerScene.Id(obj)] = (hash, value), offset, limit, revision);
            var currentIds = document.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Select(WorkerScene.Id).ToHashSet();
            foreach (var id in nextMeasurements.Keys.Where(id => !currentIds.Contains(id)).ToArray()) nextMeasurements.Remove(id);
            lastMeasurements = nextMeasurements;
            lastMeasurementContext = context;
            return result;
        }
        if (method != "execute") throw new InvalidOperationException("UNKNOWN_METHOD");
        var operation = request.GetProperty("operationId").GetString()!;
        if (!Guid.TryParseExact(operation, "D", out _)) throw new InvalidOperationException("INVALID_OPERATION");
        var code = request.GetProperty("code").GetString() ?? "";
        if (code.Length is < 1 or > 65536) throw new InvalidOperationException("INVALID_CODE");
        var basis = request.GetProperty("revision").GetInt32();
        var protectedIds = request.TryGetProperty("protectedIds", out var protectedValues)
            ? protectedValues.EnumerateArray().Select(value => value.GetString()!).ToHashSet() : new HashSet<string>();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(basis + "\n" + code + "\n" + string.Join(",", protectedIds.Order()))));
        if (receipts.TryGetValue(operation, out var prior))
        {
            if (prior.hash != hash) throw new InvalidOperationException("OPERATION_CONFLICT");
            return prior.result;
        }
        if (uncertain) throw new InvalidOperationException("HOST_RESULT_UNKNOWN");
        if (basis != revision) throw new InvalidOperationException("STALE_REFERENCE");
        var protectedObjects = document.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject)
            .Where(obj => protectedIds.Contains(WorkerScene.Id(obj))).ToDictionary(WorkerScene.Id, WorkerScene.Fingerprint);
        if (protectedObjects.Count != protectedIds.Count) throw new InvalidOperationException("STALE_REFERENCE");

        // User code is a string until ALL identity/basis checks above succeed.
        var source = "using System; using System.Linq; using Rhino; using Rhino.Geometry; public static class TaskCode { public static object Run(RhinoDoc doc) { " + code + "\nreturn null; } }";
        var references = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location))
            .Select(a => MetadataReference.CreateFromFile(a.Location));
        var compilation = CSharpCompilation.Create("VIDETask_" + operation.Replace("-", ""),
            [CSharpSyntaxTree.ParseText(source)], references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var policyDiagnostics = CodePolicy.Check(compilation);
        if (policyDiagnostics.Length > 0) return new { ok = false, code = "CODE_POLICY_REJECTED", revision, diagnostics = policyDiagnostics };
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
            if (document.ModelUnitSystem != UnitSystem.Meters) throw new Exception("Working units changed");
            WorkerScene.Validate(document);
            var currentObjects = document.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).ToDictionary(WorkerScene.Id);
            foreach (var entry in protectedObjects)
                if (!currentObjects.TryGetValue(entry.Key, out var current) || WorkerScene.Fingerprint(current) != entry.Value)
                    throw new Exception("Protected object changed");
            var filename = Path.Combine(directory, operation + ".3dm");
            if (!document.Write3dmFile(filename, new Rhino.FileIO.FileWriteOptions())) throw new Exception("Save failed");
            using (var reopened = RhinoDoc.OpenHeadless(filename))
            {
                if (reopened == null) throw new Exception("Readback open failed");
                WorkerReadback.Verify(document, reopened);
            }
            var fileHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(filename))).ToLowerInvariant();
            revision++;
            var result = new { ok = true, operationId = operation, revision, value, filename, fileHash, readbackVerified = true, snapshot = Snapshot(false), changes = modelBasis.Compare(document) };
            Persist(operation, hash, result);
            receipts[operation] = (hash, result);
            uncertain = false;
            return result;
        }
        catch (Exception error)
        {
            var cause = error is TargetInvocationException { InnerException: not null } invocation ? invocation.InnerException! : error;
            // Full diagnostic is local only. Never return exception messages containing paths or secrets to the agent.
            var diagnosticId = Guid.NewGuid().ToString("D");
            try { File.WriteAllText(Path.Combine(directory, diagnosticId + ".diagnostic.txt"), cause.ToString()); }
            catch { /* Preserve uncertainty even when local diagnostic storage is unavailable. */ }
            var result = new { ok = false, code = "HOST_RESULT_UNKNOWN", operationId = operation, revision,
                diagnosticId, exceptionType = cause.GetType().FullName };
            receipts[operation] = (hash, result);
            try { Persist(operation, hash, result); }
            catch { throw new InvalidOperationException("HOST_RESULT_UNKNOWN", cause); }
            return result;
        }
    }

    private object Snapshot(bool? uncertainty = null) => new { ok = true, revision, uncertain = uncertainty ?? uncertain, units = document.ModelUnitSystem.ToString(),
        objects = document.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Select(Row).ToArray() };
    // Query rows: identity, layer and bounds; curves add their ends, length and straightness so
    // alignment and comparison (e.g. against a CAD drawing) do not need extra code runs.
    private object Row(Rhino.DocObjects.RhinoObject obj)
    {
        var curve = obj.Geometry as Rhino.Geometry.Curve;
        double[] P(Rhino.Geometry.Point3d p) => [p.X, p.Y, p.Z];
        return new {
            id = WorkerScene.Id(obj), nativeId = obj.Id, name = obj.Name ?? "Object", type = obj.ObjectType.ToString(),
            layer = obj.Attributes.LayerIndex >= 0 && obj.Attributes.LayerIndex < document.Layers.Count ? document.Layers[obj.Attributes.LayerIndex].FullPath : null,
            bounds = Bounds(obj.Geometry.GetBoundingBox(true)),
            start = curve == null ? null : P(curve.PointAtStart), end = curve == null ? null : P(curve.PointAtEnd),
            length = curve?.GetLength(), linear = curve?.IsLinear(document.ModelAbsoluteTolerance), closed = curve?.IsClosed,
        };
    }
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
