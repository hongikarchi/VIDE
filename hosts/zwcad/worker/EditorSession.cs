using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Linq;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.ApplicationServices;
using ZwSoft.ZwCAD.DatabaseServices;

namespace Vide.Zwcad
{
    // Fixed editor operations only; generated code is never executed in a user editing session.
    internal sealed class EditorSession
    {
        private readonly Document document;
        private readonly string filename, directory;
        private bool applicationUnknown;
        internal EditorSession(string directory, string source, string expectedHash)
        {
            this.directory = directory;
            filename = Path.Combine(directory, "editing.dwg");
            if (Hash(File.ReadAllBytes(source)) != expectedHash) throw new InvalidOperationException("SOURCE_CHANGED");
            File.Copy(source, filename, false);
            if (Hash(File.ReadAllBytes(filename)) != expectedHash) throw new InvalidOperationException("SOURCE_CHANGED");
            DwgReader.Read(filename);
            document = Application.DocumentManager.Open(filename, false);
            Application.DocumentManager.MdiActiveDocument = document;
        }
        internal object Dispatch(Dictionary<string, object> request)
        {
            object raw; string method = request.TryGetValue("method", out raw) ? Convert.ToString(raw) : "";
            if (method != "query" && method != "capture" && method != "selection" && method != "preview" && method != "apply" && method != "reconcile") return new { ok = false, code = "UNSUPPORTED_METHOD" };
            if (!String.Equals(Path.GetFullPath(document.Name), filename, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("DOCUMENT_MISMATCH");
            using (document.LockDocument())
            {
                string snapshot = Path.Combine(directory, Guid.NewGuid().ToString() + ".dwg");
                // Save a copy without renaming the editor document; Wblock would change native Handles.
                Snapshot(snapshot);
                if (!String.Equals(Path.GetFullPath(document.Name), filename, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("DOCUMENT_MISMATCH");
                object model;
                try { model = DwgReader.Read(snapshot); }
                catch { File.Delete(snapshot); throw; }
                string fingerprint = Hash(Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(model)));
                if (method == "preview" || method == "apply" || method == "reconcile")
                {
                    try { return Apply(request, method, snapshot, fingerprint); }
                    finally { File.Delete(snapshot); }
                }
                bool? modified = null;
                if (Object.ReferenceEquals(Application.DocumentManager.MdiActiveDocument, document)) modified = Convert.ToInt32(Application.GetSystemVariable("DBMOD")) != 0;
                if (method == "selection")
                {
                    File.Delete(snapshot);
                    if (!Object.ReferenceEquals(Application.DocumentManager.MdiActiveDocument, document)) throw new InvalidOperationException("DOCUMENT_NOT_ACTIVE");
                    var selection = document.Editor.SelectImplied();
                    string[] selectedIds = selection.Status == ZwSoft.ZwCAD.EditorInput.PromptStatus.OK ? selection.Value.GetObjectIds().Select(id => "cad-" + id.Handle.ToString()).ToArray() : new string[0];
                    return new { ok = true, documentHash = fingerprint, selectedIds };
                }
                if (method == "query")
                {
                    File.Delete(snapshot);
                    return new { ok = true, editor = true, documentId = 1, name = Path.GetFileName(filename), units = document.Database.Insunits.ToString(), modified, documentHash = fingerprint, model };
                }
                return new { ok = true, editor = true, documentId = 1, name = Path.GetFileName(filename), units = document.Database.Insunits.ToString(), modified, documentHash = fingerprint,
                    filename = snapshot, fileHash = Hash(File.ReadAllBytes(snapshot)), model };
            }
        }
        private object Apply(Dictionary<string, object> request, string method, string snapshot, string fingerprint)
        {
            var serializer = new JavaScriptSerializer();
            string operation = Value(request, "operationId"), candidate = Value(request, "filename"), candidateHash = Value(request, "candidateHash"), expected = Value(request, "documentHash");
            Guid id;
            if (method != "preview" && !Guid.TryParseExact(operation, "D", out id)) throw new InvalidOperationException("INVALID_OPERATION");
            string receipt = method == "preview" ? null : Path.Combine(directory, "apply-" + operation + ".json");
            string requestHash = Hash(Encoding.UTF8.GetBytes(candidate + "|" + candidateHash + "|" + expected));
            if (receipt != null && File.Exists(receipt))
            {
                var saved = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(receipt));
                if (Convert.ToString(saved["requestHash"]) != requestHash) throw new InvalidOperationException("OPERATION_CONFLICT");
                return saved["outcome"];
            }
            if (method == "reconcile") return new { state = "unknown", result = new { code = "HOST_RESULT_UNKNOWN" } };
            if (applicationUnknown) return new { state = "unknown", result = new { code = "HOST_RESULT_UNKNOWN" } };
            if (fingerprint != expected) throw new InvalidOperationException("STALE_REFERENCE");
            if (String.IsNullOrEmpty(candidate) || !Path.IsPathRooted(candidate) || EditorApply.Hash(candidate) != candidateHash) throw new InvalidOperationException("SOURCE_CHANGED");
            EditorApply.Validate(snapshot); EditorApply.Validate(candidate);
            var effect = serializer.Deserialize<Dictionary<string, object>>(serializer.Serialize(EditorApply.Apply(document.Database, candidate, false)));
            effect["documentHash"] = fingerprint;
            if (method == "preview") return effect;
            object outcome = new { state = "unknown", result = new { code = "HOST_RESULT_UNKNOWN" } };
            applicationUnknown = true;
            SaveReceipt(receipt, new { requestHash, outcome });
            try
            {
                effect = serializer.Deserialize<Dictionary<string, object>>(serializer.Serialize(EditorApply.Apply(document.Database, candidate, true)));
                Snapshot(snapshot);
                EditorApply.Verify(candidate, snapshot, (Dictionary<string, object>)effect["mapping"]);
                var resultModel = DwgReader.Read(snapshot);
                effect["documentHash"] = Hash(Encoding.UTF8.GetBytes(serializer.Serialize(resultModel)));
                outcome = new { state = "succeeded", result = effect };
                SaveReceipt(receipt, new { requestHash, outcome });
                applicationUnknown = false;
            }
            catch (System.Exception error)
            {
                string diagnosticId = Guid.NewGuid().ToString();
                try { File.WriteAllText(Path.Combine(directory, diagnosticId + ".diagnostic.txt"), error.ToString()); } catch { }
                outcome = new { state = "unknown", result = new { code = "HOST_RESULT_UNKNOWN", diagnosticId } };
                SaveReceipt(receipt, new { requestHash, outcome });
            }
            return outcome;
        }
        private void Snapshot(string path)
        {
            // Save a copy without changing the editor's pre-existing modification flag.
            document.PushDbmod();
            try { document.Database.SaveAs(path, false, DwgVersion.Current, document.Database.SecurityParameters); }
            finally { document.PopDbmod(); }
        }
        private static void SaveReceipt(string path, object value)
        {
            File.WriteAllText(path + ".tmp", new JavaScriptSerializer().Serialize(value));
            if (File.Exists(path)) File.Replace(path + ".tmp", path, null); else File.Move(path + ".tmp", path);
        }
        private static string Value(Dictionary<string, object> request, string key) { object value; return request.TryGetValue(key, out value) ? Convert.ToString(value) : null; }
        private static string Hash(byte[] value) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(value)).Replace("-", "").ToLowerInvariant(); }
    }
}
