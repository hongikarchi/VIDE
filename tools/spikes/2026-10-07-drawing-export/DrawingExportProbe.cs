// T-199 spike probe: VIDEDRAWINGPROBE reads every DWG listed in VIDE_PROBE_MANIFEST (one path per
// line) into a side database (read-only) and writes one JSON line per drawing to VIDE_PROBE_OUT:
// version, layers, linetypes, text styles, dim styles, blocks (xref/layout), layouts + viewports
// (scale, lock), entity counts per space, and every dimension/text/hatch/insert. Then `<out>.done`.
// Run only in a hidden ZWCAD started by run.mjs.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Runtime;

namespace Vide.Spike
{
public sealed class DrawingExportProbe
{
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    static string tracePath;
    // Breadcrumbs: if ZWCAD dies inside a native call, the last line names the step.
    static void Step(string what) { if (tracePath != null) File.AppendAllText(tracePath, what + Environment.NewLine); }

    static string S(string v)
    {
        if (v == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in v)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
    static string N(double v) { return double.IsNaN(v) || double.IsInfinity(v) ? "null" : v.ToString("0.######", Inv); }
    static string B(bool v) { return v ? "true" : "false"; }

    sealed class Obj
    {
        readonly StringBuilder sb = new StringBuilder("{"); bool first = true;
        public Obj Raw(string k, string json) { if (!first) sb.Append(','); first = false; sb.Append(S(k)).Append(':').Append(json); return this; }
        public Obj Str(string k, string v) { return Raw(k, S(v)); }
        public Obj Num(string k, double v) { return Raw(k, N(v)); }
        public Obj Bool(string k, bool v) { return Raw(k, B(v)); }
        public override string ToString() { return sb.ToString() + "}"; }
    }
    static string Arr(List<string> items) { return "[" + String.Join(",", items) + "]"; }

    static string Name(Transaction tr, ObjectId id)
    {
        if (id.IsNull || !id.IsValid) return null;
        try
        {
            var o = tr.GetObject(id, OpenMode.ForRead);
            var r = o as SymbolTableRecord;
            return r != null ? r.Name : o.GetType().Name;
        }
        catch { return "?"; }
    }

    static string Color(ZwSoft.ZwCAD.Colors.Color c)
    {
        return new Obj().Str("method", c.ColorMethod.ToString()).Num("index", c.ColorIndex)
            .Raw("rgb", "[" + c.Red + "," + c.Green + "," + c.Blue + "]").ToString();
    }

    static string Read(string path)
    {
        var o = new Obj().Str("file", Path.GetFileName(path));
        using (var db = new Database(false, true))
        {
            db.ReadDwgFile(path, FileOpenMode.OpenForReadAndAllShare, true, null);
            db.CloseInput(true);
            o.Str("version", db.OriginalFileVersion.ToString()).Num("insunits", (int)db.Insunits)
             .Num("dimscale", db.Dimscale).Num("ltscale", db.Ltscale).Bool("lwdisplay", db.LineWeightDisplay);
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                Step("layers");
                var layers = new List<string>();
                foreach (ObjectId id in (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead))
                {
                    var l = (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    layers.Add(new Obj().Str("name", l.Name).Raw("color", Color(l.Color)).Str("linetype", Name(tr, l.LinetypeObjectId))
                        .Str("lineweight", l.LineWeight.ToString()).Str("plotStyle", l.PlotStyleName).Bool("plot", l.IsPlottable).ToString());
                }
                o.Raw("layers", Arr(layers));

                Step("linetypes");
                var linetypes = new List<string>();
                foreach (ObjectId id in (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead))
                {
                    var l = (LinetypeTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    linetypes.Add(new Obj().Str("name", l.Name).Num("dashes", l.NumDashes).Num("length", l.PatternLength).ToString());
                }
                o.Raw("linetypes", Arr(linetypes));

                Step("textStyles");
                var styles = new List<string>();
                foreach (ObjectId id in (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead))
                {
                    var t = (TextStyleTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    styles.Add(new Obj().Str("name", t.Name).Str("file", t.FileName).Str("bigFont", t.BigFontFileName)
                        .Str("typeface", t.Font.TypeFace).Num("height", t.TextSize).Num("width", t.XScale).ToString());
                }
                o.Raw("textStyles", Arr(styles));

                Step("dimStyles");
                var dimStyles = new List<string>();
                foreach (ObjectId id in (DimStyleTable)tr.GetObject(db.DimStyleTableId, OpenMode.ForRead))
                {
                    var d = (DimStyleTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    dimStyles.Add(new Obj().Str("name", d.Name).Num("dimtxt", d.Dimtxt).Num("dimasz", d.Dimasz).Num("dimscale", d.Dimscale)
                        .Num("dimlfac", d.Dimlfac).Str("dimblk", Name(tr, d.Dimblk)).Str("dimblk1", Name(tr, d.Dimblk1)).Num("dimtsz", d.Dimtsz)
                        .Str("dimtxsty", Name(tr, d.Dimtxsty)).Num("dimdec", d.Dimdec).Bool("annotative", d.Annotative == AnnotativeStates.True).ToString());
                }
                o.Raw("dimStyles", Arr(dimStyles));

                var blocks = new List<string>();
                var entities = new List<string>();
                var counts = new List<string>();
                var layouts = new List<string>();
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                foreach (ObjectId recordId in table)
                {
                    var r = (BlockTableRecord)tr.GetObject(recordId, OpenMode.ForRead);
                    string space = r.Name;
                    Step("block " + r.Name);
                    if (r.IsLayout)
                    {
                        var lay = (Layout)tr.GetObject(r.LayoutId, OpenMode.ForRead);
                        space = "layout:" + lay.LayoutName;
                        var vps = new List<string>();
                        foreach (ObjectId eid in r)
                        {
                            var vp = tr.GetObject(eid, OpenMode.ForRead) as Viewport;
                            if (vp == null) continue;
                            vps.Add(new Obj().Num("number", vp.Number).Num("customScale", vp.CustomScale).Str("standardScale", vp.StandardScale.ToString())
                                .Bool("locked", vp.Locked).Num("width", vp.Width).Num("height", vp.Height).Num("viewHeight", vp.ViewHeight).Str("target", N(vp.ViewTarget.X) + "," + N(vp.ViewTarget.Y))
                                .Str("center", N(vp.ViewCenter.X) + "," + N(vp.ViewCenter.Y)).Str("layer", vp.Layer).Bool("on", vp.On).ToString());
                        }
                        layouts.Add(new Obj().Str("name", lay.LayoutName).Num("tab", lay.TabOrder).Str("media", lay.CanonicalMediaName)
                            .Str("paper", N(lay.PlotPaperSize.X) + "x" + N(lay.PlotPaperSize.Y)).Str("plotUnits", lay.PlotPaperUnits.ToString())
                            .Raw("viewports", Arr(vps)).ToString());
                    }
                    blocks.Add(new Obj().Str("name", r.Name).Bool("layout", r.IsLayout).Bool("xref", r.IsFromExternalReference)
                        .Bool("overlay", r.IsFromOverlayReference).Str("path", r.PathName).Bool("anonymous", r.IsAnonymous)
                        .Bool("dependent", r.IsDependent).ToString());
                    var perType = new SortedDictionary<string, int>();
                    foreach (ObjectId eid in r)
                    {
                        var e = tr.GetObject(eid, OpenMode.ForRead) as Entity;
                        if (e == null) continue;
                        string type = e.GetType().Name;
                        Step("  entity " + type + " " + e.Handle);
                        perType[type] = perType.ContainsKey(type) ? perType[type] + 1 : 1;
                        var eo = new Obj().Str("space", space).Str("type", type);
                        Step("    layer"); eo.Str("layer", e.Layer);
                        Step("    color"); eo.Raw("color", Color(e.Color));
                        Step("    lineweight"); eo.Str("lineweight", e.LineWeight.ToString());
                        Step("    linetype"); eo.Str("linetype", e.Linetype);
                        Step("    cast");
                        var dim = e as Dimension; var text = e as DBText; var mtext = e as MText; var hatch = e as Hatch; var br = e as BlockReference;
                        if (dim != null)
                        {
                            // One step per property: a native access violation in a dimension property is
                            // traced to its name (see README) instead of only to the entity.
                            Step("    measurement"); eo.Num("measurement", dim.Measurement);
                            Step("    text"); eo.Str("text", dim.DimensionText);
                            Step("    style"); eo.Str("style", dim.DimensionStyleName);
                            Step("    dimtxt"); eo.Num("dimtxt", dim.Dimtxt);
                            Step("    dimasz"); eo.Num("dimasz", dim.Dimasz);
                            Step("    dimscale"); eo.Num("dimscale", dim.Dimscale);
                            Step("    dimlfac"); eo.Num("dimlfac", dim.Dimlfac);
                            Step("    dimblk"); eo.Str("dimblk", Name(tr, dim.Dimblk));
                            Step("    dimtsz"); eo.Num("dimtsz", dim.Dimtsz);
                            // Dimension.TextStyleId crashed ZWCAD 2023 (access violation in ZwDatabase.dll) on
                            // every Rhino-exported dimension; the style's DIMTXSTY is read from dimStyles instead.
                            Step("    ok");
                            entities.Add(eo.ToString());
                        }
                        else if (text != null) { entities.Add(eo.Str("text", text.TextString).Str("style", text.TextStyleName).Num("height", text.Height).ToString()); }
                        else if (mtext != null) { entities.Add(eo.Str("text", mtext.Contents).Str("style", Name(tr, mtext.TextStyleId)).Num("height", mtext.TextHeight).ToString()); }
                        else if (hatch != null) { entities.Add(eo.Str("pattern", hatch.PatternName).Str("patternType", hatch.PatternType.ToString()).Num("scale", hatch.PatternScale).Num("loops", hatch.NumberOfLoops).Bool("solid", hatch.IsSolidFill).ToString()); }
                        else if (br != null) { entities.Add(eo.Str("block", Name(tr, br.BlockTableRecord)).Str("pos", N(br.Position.X) + "," + N(br.Position.Y)).ToString()); }
                        else if (e is Viewport) { }
                        else if (perType[type] <= 3) entities.Add(eo.ToString()); // first few of other types
                    }
                    var co = new Obj();
                    foreach (var kv in perType) co.Num(kv.Key, kv.Value);
                    counts.Add(new Obj().Str("space", space).Raw("types", co.ToString()).ToString());
                }
                o.Raw("layouts", Arr(layouts)).Raw("blocks", Arr(blocks)).Raw("counts", Arr(counts)).Raw("entities", Arr(entities));
                tr.Commit();
            }
        }
        return o.ToString();
    }

    // Control drawing written by ZWCAD itself (Korean layer, text, text style font) so that a
    // garbled read of the Rhino exports can be told apart from a reader-side encoding problem.
    static void WriteControl(string path)
    {
        Step("control " + path);
        using (var db = new Database(true, true))
        using (Transaction tr = db.TransactionManager.StartTransaction())
        {
            var layers = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForWrite);
            var layer = new LayerTableRecord { Name = "치수-한글" };
            layers.Add(layer); tr.AddNewlyCreatedDBObject(layer, true);
            var styles = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForWrite);
            var style = new TextStyleTableRecord { Name = "한글-문자" };
            style.Font = new ZwSoft.ZwCAD.GraphicsInterface.FontDescriptor("맑은 고딕", false, false, 0, 0);
            styles.Add(style); tr.AddNewlyCreatedDBObject(style, true);
            var model = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForWrite);
            var text = new MText();
            text.SetDatabaseDefaults(db);
            text.Contents = "거실 LIVING"; text.TextHeight = 350; text.LayerId = layer.ObjectId; text.TextStyleId = style.ObjectId;
            model.AppendEntity(text); tr.AddNewlyCreatedDBObject(text, true);
            tr.Commit();
            db.SaveAs(path, DwgVersion.AC1032);
        }
    }

    [CommandMethod("VIDEDRAWINGPROBE", CommandFlags.Session)]
    public static void Run()
    {
        string manifest = Environment.GetEnvironmentVariable("VIDE_PROBE_MANIFEST");
        string output = Environment.GetEnvironmentVariable("VIDE_PROBE_OUT");
        if (String.IsNullOrEmpty(manifest) || !File.Exists(manifest) || String.IsNullOrEmpty(output)) return;
        tracePath = output + ".trace";
        File.WriteAllText(tracePath, "");
        string control = Environment.GetEnvironmentVariable("VIDE_PROBE_CONTROL");
        if (!String.IsNullOrEmpty(control))
            try { WriteControl(control); } catch (System.Exception ex) { Step("control failed: " + ex); }
        using (var writer = new StreamWriter(output, false, new UTF8Encoding(false)))
        {
            foreach (string line in File.ReadAllLines(manifest, Encoding.UTF8))
            {
                string path = line.Trim();
                if (path.Length == 0) continue;
                Step("file " + path);
                try { writer.WriteLine(Read(path)); }
                catch (System.Exception ex) { writer.WriteLine(new Obj().Str("file", Path.GetFileName(path)).Str("error", ex.ToString()).ToString()); }
                writer.Flush();
            }
        }
        File.WriteAllText(output + ".done", "ok");
    }
}
}
