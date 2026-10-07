// The worker side of the engine's output tokens (PLAN-47 T-226, SPEC-14.7·14.14 1; engine side
// src/core/drawing-output.ts). A drawing command that writes a file loads the grant the engine put
// in its run folder (VIDE_OUTPUT_GRANT) and must present the token id the engine passed in
// VIDE_OUTPUT_TOKEN. Then, and only through this class:
//  - Stage(db, path) saves db next to `path` under a temporary name, in the grant's DWG version,
//    which must be the version db was read in (no up- or down-conversion);
//  - Commit() moves every staged file to its name; a move never replaces an existing file, so a
//    file that appeared meanwhile makes the write fail instead of being overwritten;
//  - AttachXref(db, path, name) attaches only a file this grant has already written.
// A path outside the grant's files, an existing file, a second write of the same file, an expired
// or mismatched token and a version mismatch are refused (OutputRefused). AI code never reaches
// this class: SdkCompiler denies Vide.* and Database.Save/SaveAs/AttachXref.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.DatabaseServices;

namespace Vide.Zwcad
{
    internal sealed class OutputRefused : Exception
    {
        internal OutputRefused(string code) : base(code) { Code = code; }
        internal string Code { get; }
    }

    internal sealed class OutputGrant
    {
        private readonly HashSet<string> files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private readonly List<KeyValuePair<string, string>> staged = new List<KeyValuePair<string, string>>();
        private readonly long expiresAt;

        internal string Folder { get; }
        internal DwgVersion Version { get; }

        private OutputGrant(string folder, IEnumerable<string> paths, DwgVersion version, long expiresAt)
        {
            Folder = folder; Version = version; this.expiresAt = expiresAt;
            foreach (string path in paths) files.Add(path);
        }

        /** The grant of this run, or OutputRefused("OUTPUT_TOKEN_INVALID"). */
        internal static OutputGrant Load(string grantPath, string token)
        {
            try
            {
                if (String.IsNullOrEmpty(grantPath) || String.IsNullOrEmpty(token) || !Path.IsPathRooted(grantPath)) throw new OutputRefused("OUTPUT_TOKEN_INVALID");
                var json = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(grantPath));
                if (!String.Equals(Convert.ToString(json["token"]), token, StringComparison.Ordinal)) throw new OutputRefused("OUTPUT_TOKEN_INVALID");
                long expires = Convert.ToInt64(json["expiresAt"]);
                string folder = Path.GetFullPath(Convert.ToString(json["folder"]));
                var paths = new List<string>();
                foreach (object item in (ArrayList)json["files"])
                {
                    string path = Path.GetFullPath(Convert.ToString(item));
                    if (!String.Equals(Path.GetDirectoryName(path), folder.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) ||
                        !path.EndsWith(".dwg", StringComparison.OrdinalIgnoreCase)) throw new OutputRefused("OUTPUT_TOKEN_INVALID");
                    paths.Add(path);
                }
                return new OutputGrant(folder, paths, ParseVersion(Convert.ToString(json["version"])), expires);
            }
            catch (OutputRefused) { throw; }
            catch (Exception) { throw new OutputRefused("OUTPUT_TOKEN_INVALID"); }
        }

        /** AC1015 … AC1032 (the DWG header magic); anything else is refused. */
        internal static DwgVersion ParseVersion(string magic)
        {
            switch (magic)
            {
                case "AC1015": return DwgVersion.AC1015;
                case "AC1018": return DwgVersion.AC1800;
                case "AC1021": return DwgVersion.AC1021;
                case "AC1024": return DwgVersion.AC1024;
                case "AC1027": return DwgVersion.AC1027;
                case "AC1032": return DwgVersion.AC1032;
                default: throw new OutputRefused("OUTPUT_VERSION_INVALID");
            }
        }

        /** The header magic of a DWG version (BackflowOps.Version, shared with the connection plugin). */
        internal static string Magic(DwgVersion version) => BackflowOps.Version(version);

        /** The full path when `path` may be written now; OutputRefused otherwise. */
        internal string Authorize(string path)
        {
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > expiresAt) throw new OutputRefused("OUTPUT_TOKEN_INVALID");
            if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path)) throw new OutputRefused("OUTPUT_PATH_DENIED");
            string full = Path.GetFullPath(path);
            if (!files.Contains(full)) throw new OutputRefused("OUTPUT_PATH_DENIED");
            if (written.Contains(full) || staged.Exists(item => String.Equals(item.Key, full, StringComparison.OrdinalIgnoreCase))) throw new OutputRefused("OUTPUT_PATH_USED");
            if (File.Exists(full) || Directory.Exists(full)) throw new OutputRefused("OUTPUT_EXISTS");
            return full;
        }

        /** Saves db under a temporary name beside `path`; Commit() gives it its name. */
        internal void Stage(Database db, string path)
        {
            string full = Authorize(path);
            // Keep the source's version: a drawing read as 2013 is written as 2013.
            if (db.OriginalFileVersion != Version) throw new OutputRefused("OUTPUT_VERSION_MISMATCH");
            string temp = Path.Combine(Path.GetDirectoryName(full), "~vide-" + Guid.NewGuid().ToString("N") + ".dwg");
            try { db.SaveAs(temp, Version); }
            catch { TryDelete(temp); throw; }
            staged.Add(new KeyValuePair<string, string>(full, temp));
        }

        /** Moves the staged files to their names (no overwrite); on any failure removes them all. */
        internal void Commit()
        {
            var done = new List<string>();
            try
            {
                foreach (var item in staged)
                {
                    if (File.Exists(item.Key)) throw new OutputRefused("OUTPUT_EXISTS");
                    File.Move(item.Value, item.Key); // throws when the target exists
                    done.Add(item.Key);
                    written.Add(item.Key);
                }
            }
            catch (IOException)
            {
                Discard(done);
                throw new OutputRefused("OUTPUT_EXISTS");
            }
            catch
            {
                Discard(done);
                throw;
            }
            staged.Clear();
        }

        /** Removes staged temporaries (and files this Commit moved before it failed). */
        internal void Discard(IEnumerable<string> moved = null)
        {
            foreach (var item in staged) TryDelete(item.Value);
            if (moved != null) foreach (string path in moved) { TryDelete(path); written.Remove(path); }
            staged.Clear();
        }

        /** Attaches a drawing this grant wrote; any other path is refused. */
        internal ObjectId AttachXref(Database db, string path, string name)
        {
            string full = Path.IsPathRooted(path ?? "") ? Path.GetFullPath(path) : null;
            if (full == null || !written.Contains(full)) throw new OutputRefused("OUTPUT_PATH_DENIED");
            return db.AttachXref(full, name);
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { /* Left in the run's folder. */ }
        }
    }
}
