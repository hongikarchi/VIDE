using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.DatabaseServices;

namespace Vide.Zwcad
{
    internal sealed class SdkSession
    {
        private readonly string directory;
        private string current;
        private int revision;
        private bool uncertain;
        private readonly Dictionary<string, Receipt> receipts = new Dictionary<string, Receipt>();
        private sealed class Receipt { internal string Hash; internal object Result; }
        internal SdkSession(string directory, string source, string expectedHash)
        {
            this.directory = directory;
            current = Path.Combine(directory, "seed.dwg");
            if (File.Exists(current)) throw new InvalidOperationException("SESSION_EXISTS");
            if (!String.IsNullOrEmpty(source))
            {
                if (Hash(File.ReadAllBytes(source)) != expectedHash) throw new InvalidOperationException("SOURCE_CHANGED");
                File.Copy(source, current, false);
                if (Hash(File.ReadAllBytes(current)) != expectedHash) throw new InvalidOperationException("SOURCE_CHANGED");
                DwgReader.Read(current);
            }
            else using (var db = new Database(true, true)) { db.Insunits = UnitsValue.Millimeters; db.SaveAs(current, DwgVersion.Current); }
        }
        internal object Dispatch(Dictionary<string, object> request)
        {
            string method = Value(request, "method");
            if (method == "query" || method == "export") return new { ok = true, revision, uncertain, model = Snapshot(current) };
            if (method != "execute") return new { ok = false, code = "UNSUPPORTED_METHOD" };
            string operation = Value(request, "operationId"), body = Value(request, "code");
            Guid parsed;
            if (!Guid.TryParseExact(operation, "D", out parsed) || String.IsNullOrWhiteSpace(body) || body.Length > 65536)
                return new { ok = false, code = "INVALID_OPERATION" };
            string hash = Hash(Encoding.UTF8.GetBytes(body + "\n" + Value(request, "revision")));
            Receipt prior;
            if (receipts.TryGetValue(operation, out prior)) return hash == prior.Hash ? prior.Result : new { ok = false, code = "OPERATION_CONFLICT" };
            if (uncertain) return new { ok = false, code = "HOST_RESULT_UNKNOWN" };
            if (Value(request, "revision") != revision.ToString()) return new { ok = false, code = "STALE_REFERENCE" };
            string errorCode; string[] diagnostics;
            MethodInfo compiled = SdkCompiler.Compile(body, out errorCode, out diagnostics);
            if (compiled == null) return new { ok = false, code = errorCode, revision, diagnostics };
            string candidate = Path.Combine(directory, operation + ".dwg");
            if (File.Exists(candidate)) { uncertain = true; return new { ok = false, code = "HOST_RESULT_UNKNOWN" }; }
            string sourceHash = Hash(File.ReadAllBytes(current));
            object result;
            uncertain = true;
            try
            {
                object value;
                using (var db = new Database(false, true))
                {
                    db.ReadDwgFile(current, FileOpenMode.OpenForReadAndAllShare, true, null); db.CloseInput(true);
                    using (var tr = db.TransactionManager.StartTransaction())
                    {
                        value = compiled.Invoke(null, new object[] { db, tr });
                        new JavaScriptSerializer().Serialize(value);
                        tr.Commit();
                    }
                    db.SaveAs(candidate, DwgVersion.Current);
                }
                object model = Snapshot(candidate);
                if (Hash(File.ReadAllBytes(current)) != sourceHash) throw new InvalidOperationException("SOURCE_CHANGED");
                result = new { ok = true, operationId = operation, revision = revision + 1, model, value, filename = candidate,
                    fileHash = Hash(File.ReadAllBytes(candidate)), readbackVerified = true };
                Persist(operation, hash, result);
                current = candidate; revision++; uncertain = false;
            }
            catch (System.Exception error)
            {
                var cause = error is TargetInvocationException && error.InnerException != null ? error.InnerException : error;
                string diagnosticId = Guid.NewGuid().ToString();
                try { File.WriteAllText(Path.Combine(directory, diagnosticId + ".diagnostic.txt"), cause.ToString()); }
                catch { /* Keep unknown even when local diagnostics cannot be saved. */ }
                result = new { ok = false, code = "HOST_RESULT_UNKNOWN", operationId = operation, revision, diagnosticId, exceptionType = cause.GetType().FullName };
                receipts[operation] = new Receipt { Hash = hash, Result = result };
                Persist(operation, hash, result);
                return result;
            }
            receipts[operation] = new Receipt { Hash = hash, Result = result };
            return result;
        }
        private static object Snapshot(string filename)
        {
            try { return DwgReader.Read(filename); }
            catch (InvalidOperationException error)
            {
                if (error.Message != "EMPTY_DWG") throw;
                return new { objects = new object[0], scene = new object[0], sourceUnits = 4, verified = true, importMode = "sdk" };
            }
        }
        private void Persist(string operation, string hash, object result)
        {
            string path = Path.Combine(directory, operation + ".receipt.json");
            var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
            File.WriteAllText(path + ".tmp", serializer.Serialize(new { hash, result }));
            File.Move(path + ".tmp", path);
        }
        private static string Value(Dictionary<string, object> request, string key) { object value; return request.TryGetValue(key, out value) ? Convert.ToString(value) : null; }
        private static string Hash(byte[] value) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(value)).Replace("-", "").ToLowerInvariant(); }
    }
}
