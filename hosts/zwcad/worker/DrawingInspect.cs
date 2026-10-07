// 도면 읽기 (SPEC-14.3 2, PLAN-47 T-227). Started by hosts/zwcad/drawing-inspect.ts in a hidden
// ZWCAD the engine owns (runHiddenZwcad); reads only the engine's copies listed in a manifest
// (VIDE_DRAWING_MANIFEST, `id<TAB>path` lines) in side databases opened read-only, never a document.
// Per drawing one JSON line in VIDE_DRAWING_OUT: DWG version, INSUNITS, layers (colour, linetype,
// lineweight, on/frozen/locked/plot), linetypes, text styles (font files), dimension styles (text
// style and arrowheads from the style record, never from a dimension — SafeRead), named blocks
// (insert count, attributes) and xref block records (name, path as stored, overlay, status).
// Entities are not read. `<out>.done` ends the run; the worker's steps go to VIDE_WORKER_STEP so the
// hidden run's no-progress watch sees each drawing.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Runtime;

namespace Vide.Zwcad
{
public sealed class DrawingInspectCommand
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    static void Step(string name)
    {
        string file = Environment.GetEnvironmentVariable("VIDE_WORKER_STEP");
        if (String.IsNullOrEmpty(file) || !Path.IsPathRooted(file)) return;
        try { File.AppendAllText(file, name + Environment.NewLine, new UTF8Encoding(false)); } catch { /* Diagnostics only. */ }
    }

    static string NameOf(Transaction tr, ObjectId id)
    {
        if (id.IsNull) return null;
        try { return (tr.GetObject(id, OpenMode.ForRead) as SymbolTableRecord)?.Name; }
        catch (System.Exception) { return null; }
    }

    static T Try<T>(Func<T> read, T fallback)
    {
        try { return read(); } catch (System.Exception) { return fallback; }
    }

    static List<object> Layers(Database db, Transaction tr)
    {
        var rows = new List<object>();
        foreach (ObjectId id in (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead))
        {
            var layer = (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead);
            rows.Add(new Dictionary<string, object> {
                { "name", layer.Name },
                { "color", Try(() => (int)layer.Color.ColorIndex, 7) },
                { "linetype", NameOf(tr, layer.LinetypeObjectId) },
                { "lineweight", Try(() => (int)layer.LineWeight, -3) },
                { "off", Try(() => layer.IsOff, false) },
                { "frozen", Try(() => layer.IsFrozen, false) },
                { "locked", Try(() => layer.IsLocked, false) },
                { "plot", Try(() => layer.IsPlottable, true) },
                { "dependent", Try(() => layer.IsDependent, false) } });
        }
        return rows;
    }

    static List<object> Linetypes(Database db, Transaction tr)
    {
        var rows = new List<object>();
        foreach (ObjectId id in (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead))
        {
            var type = (LinetypeTableRecord)tr.GetObject(id, OpenMode.ForRead);
            rows.Add(new Dictionary<string, object> {
                { "name", type.Name }, { "dependent", Try(() => type.IsDependent, false) } });
        }
        return rows;
    }

    static List<object> TextStyles(Database db, Transaction tr)
    {
        var rows = new List<object>();
        foreach (ObjectId id in (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead))
        {
            var style = (TextStyleTableRecord)tr.GetObject(id, OpenMode.ForRead);
            // Shape files (complex linetypes) are text style records without a name.
            if (Try(() => style.IsShapeFile, false) || String.IsNullOrEmpty(style.Name)) continue;
            rows.Add(new Dictionary<string, object> {
                { "name", style.Name }, { "font", Try(() => style.FileName, "") },
                { "bigFont", Try(() => style.BigFontFileName, "") },
                { "dependent", Try(() => style.IsDependent, false) } });
        }
        return rows;
    }

    static List<object> DimStyles(Database db, Transaction tr)
    {
        var rows = new List<object>();
        foreach (ObjectId id in (DimStyleTable)tr.GetObject(db.DimStyleTableId, OpenMode.ForRead))
        {
            var style = (DimStyleTableRecord)tr.GetObject(id, OpenMode.ForRead);
            string[] arrows = SafeRead.DimensionArrows(tr, style);
            rows.Add(new Dictionary<string, object> {
                { "name", style.Name }, { "textStyle", NameOf(tr, style.Dimtxsty) },
                { "arrows", arrows }, { "scale", Try(() => style.Dimscale, 1.0) },
                { "dependent", Try(() => style.IsDependent, false) } });
        }
        return rows;
    }

    static string Status(BlockTableRecord record)
    {
        try { return record.XrefStatus.ToString(); } catch { return "Unknown"; }
    }

    /** Named blocks (no layouts, no anonymous `*` blocks, no xref-dependent `a|b`) and xrefs. */
    static void Blocks(Database db, Transaction tr, List<object> blocks, List<object> xrefs)
    {
        foreach (ObjectId id in (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead))
        {
            var record = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
            if (record.IsLayout || record.IsAnonymous || record.Name.StartsWith("*")) continue;
            int inserts = Try(() => record.GetBlockReferenceIds(true, false).Count, -1);
            if (record.IsFromExternalReference)
                xrefs.Add(new Dictionary<string, object> {
                    { "name", record.Name }, { "path", record.PathName ?? "" },
                    { "overlay", record.IsFromOverlayReference }, { "status", Status(record) },
                    { "inserts", inserts } });
            else if (!record.IsDependent)
                blocks.Add(new Dictionary<string, object> {
                    { "name", record.Name }, { "inserts", inserts },
                    { "attributes", Try(() => record.HasAttributeDefinitions, false) } });
        }
    }

    [CommandMethod("VIDEDRAWINGINSPECT", CommandFlags.Session)]
    public static void Run()
    {
        string manifest = Environment.GetEnvironmentVariable("VIDE_DRAWING_MANIFEST");
        string output = Environment.GetEnvironmentVariable("VIDE_DRAWING_OUT");
        if (String.IsNullOrEmpty(manifest) || !Path.IsPathRooted(manifest) || !File.Exists(manifest) ||
            String.IsNullOrEmpty(output) || !Path.IsPathRooted(output)) return;
        using (var writer = new StreamWriter(output, false, new UTF8Encoding(false)))
        {
            foreach (string line in File.ReadAllLines(manifest, Encoding.UTF8))
            {
                int tab = line.IndexOf('\t');
                if (tab < 0) continue;
                string id = line.Substring(0, tab), path = line.Substring(tab + 1);
                var row = new Dictionary<string, object> { { "id", int.Parse(id, CultureInfo.InvariantCulture) } };
                var watch = Stopwatch.StartNew();
                Step("read " + id);
                try
                {
                    using (var db = new Database(false, true))
                    {
                        db.ReadDwgFile(path, FileOpenMode.OpenForReadAndAllShare, true, null);
                        db.CloseInput(true);
                        row["version"] = OutputGrant.Magic(db.OriginalFileVersion);
                        row["units"] = (int)db.Insunits;
                        Step("tables " + id);
                        using (Transaction tr = db.TransactionManager.StartTransaction())
                        {
                            row["layers"] = Layers(db, tr);
                            row["linetypes"] = Linetypes(db, tr);
                            row["textStyles"] = TextStyles(db, tr);
                            row["dimStyles"] = DimStyles(db, tr);
                            var blocks = new List<object>(); var xrefs = new List<object>();
                            Blocks(db, tr, blocks, xrefs);
                            row["blocks"] = blocks; row["xrefs"] = xrefs;
                            tr.Commit();
                        }
                    }
                    row["error"] = null;
                }
                catch (System.Exception ex) { row["error"] = ex.GetType().Name + ": " + ex.Message; }
                row["ms"] = watch.ElapsedMilliseconds;
                writer.WriteLine(Json.Serialize(row));
                writer.Flush();
            }
        }
        Step("done");
        File.WriteAllText(output + ".done", "ok");
    }
}
}
