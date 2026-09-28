using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Rhino;
using Rhino.DocObjects;

namespace Vide.Worker;

// Fixed inspect/capture/candidate-application methods for a visible editing copy. Never executes agent code.
// An attached connection passes its revision token so a capture can be matched to the display basis.
internal sealed class EditorExecutor(RhinoDoc document, string directory, Func<string>? revisionHash = null)
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
            var changes = ChangeSet.Read(request, directory);
            if (method == "previewEditorApplication") return application.Preview(candidateFile, hash, expected, changes);
            var applicationId = request.GetProperty("operationId").GetString()!;
            return method == "applyEditorCandidate" ? application.Apply(applicationId, candidateFile, hash, expected, changes) : application.Recover(applicationId, candidateFile, hash, expected, changes);
        }
        if (method != "captureEditor" && method != "verifyEditorCapture") throw new InvalidOperationException("UNKNOWN_METHOD");
        var operation = request.GetProperty("operationId").GetString();
        if (!Guid.TryParseExact(operation, "D", out _)) throw new InvalidOperationException("INVALID_OPERATION");
        var filename = Path.Combine(directory, operation + ".3dm");
        if (method == "verifyEditorCapture") return VerifyCapture(filename);
        if (File.Exists(filename)) throw new InvalidOperationException("OPERATION_CONFLICT");
        var objectHashes = new Dictionary<string, string>();
        var fingerprint = Fingerprint(objectHashes);
        var originalPath = document.Path; var originalName = document.Name; var modified = document.Modified; var readOnly = document.IsReadOnly;
        var selectedIds = document.Objects.GetSelectedObjects(false, false).Select(obj => obj.Id.ToString()).ToArray();
        var options = new Rhino.FileIO.FileWriteOptions { SuppressAllInput = true, SuppressDialogBoxes = true,
            UpdateDocumentPath = false, WriteSelectedObjectsOnly = false, IncludePreviewImage = false };
        void Stage(string stage) => File.WriteAllText(filename + ".capture.json", JsonSerializer.Serialize(new { operation, stage }));
        Stage("writing");
        using (options) { if (!document.Write3dmFile(filename, options)) throw new InvalidOperationException("CAPTURE_FAILED"); }
        Stage("written");
        if (document.Path != originalPath || document.Name != originalName || document.Modified != modified || document.IsReadOnly != readOnly || Fingerprint() != fingerprint)
            throw new InvalidOperationException("HOST_RESULT_UNKNOWN");
        // Per-object hashes let an application check only the objects it changes for edits made
        // in Rhino after this capture, instead of requiring the whole document to be untouched.
        File.WriteAllText(filename + ".capture.json", JsonSerializer.Serialize(new { operation, stage = "written", documentHash = fingerprint, revisionHash = revisionHash?.Invoke(), name = originalName ?? "Untitled", units = document.ModelUnitSystem.ToString(), selectedIds, objects = objectHashes }));
        return new { ok = true, pending = true };
    }

    private object VerifyCapture(string filename)
    {
        using var receipt = JsonDocument.Parse(File.ReadAllText(filename + ".capture.json"));
        var fingerprint = receipt.RootElement.GetProperty("documentHash").GetString();
        if (Fingerprint() != fingerprint) throw new InvalidOperationException("SOURCE_CHANGED");
        // The copy only needs to open. Objects that do not round-trip exactly (or are not written,
        // e.g. worksession references) are simply not editable in it; application touches only the
        // objects the AI changed, so they are never overwritten or removed.
        using (var copy = Rhino.FileIO.File3dm.Read(filename))
            if (copy == null) throw new InvalidOperationException("CAPTURE_FAILED");
        var revision = receipt.RootElement.TryGetProperty("revisionHash", out var token) && token.ValueKind == JsonValueKind.String ? token.GetString() : null;
        return new { ok = true, filename, fileHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(filename))).ToLowerInvariant(),
            documentHash = fingerprint, revisionHash = revision, documentId = document.RuntimeSerialNumber, name = receipt.RootElement.GetProperty("name").GetString(),
            units = receipt.RootElement.GetProperty("units").GetString(), selectedIds = receipt.RootElement.GetProperty("selectedIds").EnumerateArray().Select(value => value.GetString()).ToArray() };
    }

    private object Inspect() => new { ok = true, documentId = document.RuntimeSerialNumber, name = document.Name ?? "Untitled",
        units = document.ModelUnitSystem.ToString(), objectCount = document.Objects.GetObjectList(ObjectType.AnyObject).Count(),
        modified = document.Modified, readOnly = document.IsReadOnly, documentHash = Fingerprint(),
        selectedIds = document.Objects.GetSelectedObjects(false, false).Select(obj => obj.Id.ToString()).ToArray() };

    private string Fingerprint() => Fingerprint(null);

    private string Fingerprint(Dictionary<string, string>? objectHashes)
    {
        var objects = BlockIdentity.Objects(document);
        var serialization = new Rhino.FileIO.SerializationOptions { WriteUserData = true, WriteRenderMeshes = false, WriteAnalysisMeshes = false };
        var layers = string.Join("\n", document.Layers.Where(layer => !layer.IsDeleted).OrderBy(layer => layer.Id).Select(layer => layer.ToJSON(serialization)));
        var strings = JsonSerializer.Serialize(Enumerable.Range(0, document.Strings.Count).Select(i => new { key = document.Strings.GetKey(i), value = document.Strings.GetValue(i) }).OrderBy(item => item.key, StringComparer.Ordinal));
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        void Add(string value) { hash.AppendData(Encoding.UTF8.GetBytes(value)); hash.AppendData([10]); }
        Add(strings); Add(layers); Add(GroupIdentity.Signature(document.Groups)); Add(BlockIdentity.Signature(document));
        Add(document.ModelAbsoluteTolerance.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Add(document.ModelUnitSystem.ToString());
        foreach (var obj in objects)
        {
            var value = WorkerScene.Fingerprint(obj);
            if (objectHashes != null) objectHashes[WorkerScene.Id(obj)] = value;
            Add(obj.Id + ":" + value);
        }
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }
}
