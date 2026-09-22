using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Rhino;
using Rhino.DocObjects;

namespace Vide.Worker;

// Fixed inspect/capture/candidate-application methods for a visible editing copy. Never executes agent code.
internal sealed class EditorExecutor(RhinoDoc document, string directory)
{
    public object Dispatch(JsonElement request)
    {
        if (request.GetProperty("documentId").GetUInt32() != document.RuntimeSerialNumber ||
            RhinoDoc.FromRuntimeSerialNumber(document.RuntimeSerialNumber) != document || document.IsHeadless)
            throw new InvalidOperationException("TARGET_MISMATCH");
        var method = request.GetProperty("method").GetString();
        if (method == "inspectEditor") return Inspect();
        if (method is "previewEditorApplication" or "applyEditorCandidate" or "recoverEditorApplication")
        {
            var application = new EditorApplication(document, directory, Fingerprint);
            var candidateFile = request.GetProperty("filename").GetString()!;
            var hash = request.GetProperty("candidateHash").GetString()!;
            var expected = request.GetProperty("documentHash").GetString()!;
            if (method == "previewEditorApplication") return application.Preview(candidateFile, hash, expected);
            var applicationId = request.GetProperty("operationId").GetString()!;
            return method == "applyEditorCandidate" ? application.Apply(applicationId, candidateFile, hash, expected) : application.Recover(applicationId, candidateFile, hash, expected);
        }
        if (method != "captureEditor" && method != "verifyEditorCapture") throw new InvalidOperationException("UNKNOWN_METHOD");
        var operation = request.GetProperty("operationId").GetString();
        if (!Guid.TryParseExact(operation, "D", out _)) throw new InvalidOperationException("INVALID_OPERATION");
        var filename = Path.Combine(directory, operation + ".3dm");
        if (method == "verifyEditorCapture") return VerifyCapture(filename);
        if (File.Exists(filename)) throw new InvalidOperationException("OPERATION_CONFLICT");
        var fingerprint = Fingerprint();
        var originalPath = document.Path; var originalName = document.Name; var modified = document.Modified;
        var selectedIds = document.Objects.GetSelectedObjects(false, false).Select(obj => obj.Id.ToString()).ToArray();
        var options = new Rhino.FileIO.FileWriteOptions { SuppressAllInput = true, SuppressDialogBoxes = true,
            UpdateDocumentPath = false, WriteSelectedObjectsOnly = false, IncludePreviewImage = false };
        void Stage(string stage) => File.WriteAllText(filename + ".capture.json", JsonSerializer.Serialize(new { operation, stage }));
        Stage("writing");
        using (options) { if (!document.Write3dmFile(filename, options)) throw new InvalidOperationException("CAPTURE_FAILED"); }
        Stage("written");
        if (document.Path != originalPath || document.Name != originalName || document.Modified != modified || Fingerprint() != fingerprint)
            throw new InvalidOperationException("HOST_RESULT_UNKNOWN");
        File.WriteAllText(filename + ".capture.json", JsonSerializer.Serialize(new { operation, stage = "written", documentHash = fingerprint, name = originalName ?? "Untitled", units = document.ModelUnitSystem.ToString(), selectedIds }));
        return new { ok = true, pending = true };
    }

    private object VerifyCapture(string filename)
    {
        using var receipt = JsonDocument.Parse(File.ReadAllText(filename + ".capture.json"));
        var fingerprint = receipt.RootElement.GetProperty("documentHash").GetString();
        if (Fingerprint() != fingerprint) throw new InvalidOperationException("SOURCE_CHANGED");
        using (var copy = Rhino.FileIO.File3dm.Read(filename))
        {
            if (copy == null) throw new InvalidOperationException("CAPTURE_FAILED");
            WorkerReadback.VerifyArchive(document, copy);
        }
        return new { ok = true, filename, fileHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(filename))).ToLowerInvariant(),
            documentHash = fingerprint, documentId = document.RuntimeSerialNumber, name = receipt.RootElement.GetProperty("name").GetString(),
            units = receipt.RootElement.GetProperty("units").GetString(), selectedIds = receipt.RootElement.GetProperty("selectedIds").EnumerateArray().Select(value => value.GetString()).ToArray() };
    }

    private object Inspect() => new { ok = true, documentId = document.RuntimeSerialNumber, name = document.Name ?? "Untitled",
        units = document.ModelUnitSystem.ToString(), objectCount = document.Objects.GetObjectList(ObjectType.AnyObject).Count(),
        modified = document.Modified, documentHash = Fingerprint(),
        selectedIds = document.Objects.GetSelectedObjects(false, false).Select(obj => obj.Id.ToString()).ToArray() };

    private string Fingerprint()
    {
        var objects = document.Objects.GetObjectList(ObjectType.AnyObject).OrderBy(obj => obj.Id).ToArray();
        if (objects.Length > 500) throw new InvalidOperationException("IMPORT_LIMIT");
        var serialization = new Rhino.FileIO.SerializationOptions { WriteUserData = true, WriteRenderMeshes = false, WriteAnalysisMeshes = false };
        var layers = string.Join("\n", document.Layers.Where(layer => !layer.IsDeleted).OrderBy(layer => layer.Id).Select(layer => layer.ToJSON(serialization)));
        var strings = JsonSerializer.Serialize(Enumerable.Range(0, document.Strings.Count).Select(i => new { key = document.Strings.GetKey(i), value = document.Strings.GetValue(i) }).OrderBy(item => item.key, StringComparer.Ordinal));
        var values = strings + "\n" + layers + "\n" + document.ModelAbsoluteTolerance + "\n" + document.ModelUnitSystem.ToString() + "\n" + string.Join("\n", objects.Select(obj => obj.Id + ":" + WorkerScene.Fingerprint(obj)));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(values))).ToLowerInvariant();
    }
}
