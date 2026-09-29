// ZWCAD command for the knowledge crawl spike: reads DWG copies listed in a manifest and writes
// their text-like content (text, mtext, attributes, dimension overrides, leaders, clouds, xrefs)
// as JSON lines. Opens files read-only in side databases; never touches the open document.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Runtime;

[assembly: CommandClass(typeof(VideKnowledgeDwg))]

public class VideKnowledgeDwg
{
    static string Json(string value)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in value ?? "")
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static void Item(StringBuilder sb, ref int count, string kind, string layout, string block, string layer, string handle, double x, double y, string text)
    {
        if (text == null) return;
        text = text.Trim();
        if (text.Length == 0 && kind != "cloud") return;
        if (count++ > 0) sb.Append(',');
        sb.Append("{\"k\":").Append(Json(kind)).Append(",\"l\":").Append(Json(layout)).Append(",\"b\":").Append(Json(block))
          .Append(",\"y\":").Append(Json(layer)).Append(",\"h\":").Append(Json(handle))
          .Append(",\"x\":").Append(x.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture))
          .Append(",\"v\":").Append(y.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture))
          .Append(",\"t\":").Append(Json(text)).Append('}');
    }

    // Revision cloud: closed polyline whose segments are all arcs bulging the same way.
    static bool IsCloud(Polyline line)
    {
        if (!line.Closed || line.NumberOfVertices < 8) return false;
        int sign = 0;
        for (int i = 0; i < line.NumberOfVertices; i++)
        {
            double bulge = line.GetBulgeAt(i);
            if (Math.Abs(bulge) < 1e-6) return false;
            int s = Math.Sign(bulge);
            if (sign == 0) sign = s; else if (s != sign) return false;
        }
        return true;
    }

    [CommandMethod("VIDEKNOWLEDGEDWG", CommandFlags.Session)]
    public static void Run()
    {
        string manifest = Environment.GetEnvironmentVariable("VIDE_KNOWLEDGE_MANIFEST");
        string output = Environment.GetEnvironmentVariable("VIDE_KNOWLEDGE_OUT");
        using (var writer = new StreamWriter(output, false, new UTF8Encoding(false)))
        {
            foreach (string line in File.ReadAllLines(manifest, Encoding.UTF8))
            {
                int tab = line.IndexOf('\t');
                if (tab < 0) continue;
                string id = line.Substring(0, tab), path = line.Substring(tab + 1);
                var sb = new StringBuilder();
                int count = 0; string error = null;
                var watch = Stopwatch.StartNew();
                try
                {
                    using (var db = new Database(false, true))
                    {
                        db.ReadDwgFile(path, FileOpenMode.OpenForReadAndAllShare, true, null);
                        db.CloseInput(true);
                        using (Transaction tr = db.TransactionManager.StartTransaction())
                        {
                            var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                            foreach (ObjectId recordId in table)
                            {
                                var record = (BlockTableRecord)tr.GetObject(recordId, OpenMode.ForRead);
                                if (record.IsFromExternalReference) { Item(sb, ref count, "xref", null, record.Name, null, null, 0, 0, record.PathName); continue; }
                                if (record.IsDependent || (record.IsAnonymous && !record.IsLayout)) continue;
                                string layout = null, block = null;
                                if (record.IsLayout) layout = ((Layout)tr.GetObject(record.LayoutId, OpenMode.ForRead)).LayoutName;
                                else block = record.Name;
                                foreach (ObjectId entityId in record)
                                {
                                    var entity = tr.GetObject(entityId, OpenMode.ForRead) as Entity;
                                    if (entity == null) continue;
                                    string handle = entity.Handle.ToString(), layer = entity.Layer;
                                    var text = entity as DBText; var mtext = entity as MText; var dimension = entity as Dimension;
                                    var leader = entity as MLeader; var reference = entity as BlockReference; var polyline = entity as Polyline;
                                    if (text != null) Item(sb, ref count, "text", layout, block, layer, handle, text.Position.X, text.Position.Y, text.TextString);
                                    else if (mtext != null) Item(sb, ref count, "mtext", layout, block, layer, handle, mtext.Location.X, mtext.Location.Y, mtext.Text);
                                    else if (dimension != null && !String.IsNullOrEmpty(dimension.DimensionText) && dimension.DimensionText != "<>")
                                        Item(sb, ref count, "dimtext", layout, block, layer, handle, dimension.TextPosition.X, dimension.TextPosition.Y, dimension.DimensionText);
                                    else if (leader != null && leader.ContentType == ContentType.MTextContent && leader.MText != null)
                                        Item(sb, ref count, "leader", layout, block, layer, handle, leader.MText.Location.X, leader.MText.Location.Y, leader.MText.Text);
                                    else if (reference != null)
                                        foreach (ObjectId attributeId in reference.AttributeCollection)
                                        {
                                            var attribute = tr.GetObject(attributeId, OpenMode.ForRead) as AttributeReference;
                                            if (attribute != null && !attribute.Invisible)
                                                Item(sb, ref count, "attribute", layout, block, layer, handle, attribute.Position.X, attribute.Position.Y, attribute.Tag + "=" + attribute.TextString);
                                        }
                                    else if (polyline != null && IsCloud(polyline))
                                    {
                                        var box = polyline.GeometricExtents;
                                        Item(sb, ref count, "cloud", layout, block, layer, handle, (box.MinPoint.X + box.MaxPoint.X) / 2, (box.MinPoint.Y + box.MaxPoint.Y) / 2,
                                            String.Format(System.Globalization.CultureInfo.InvariantCulture, "cloud {0:0}x{1:0}", box.MaxPoint.X - box.MinPoint.X, box.MaxPoint.Y - box.MinPoint.Y));
                                    }
                                }
                            }
                            tr.Commit();
                        }
                    }
                }
                catch (System.Exception ex) { error = ex.GetType().Name + ": " + ex.Message; }
                writer.WriteLine("{\"id\":" + id + ",\"ms\":" + watch.ElapsedMilliseconds + ",\"error\":" + (error == null ? "null" : Json(error)) + ",\"items\":[" + sb + "]}");
                writer.Flush();
            }
        }
        File.WriteAllText(output + ".done", "ok");
    }
}
