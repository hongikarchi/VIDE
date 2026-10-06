using System.Text.Json;
using Grasshopper;
using Grasshopper.Kernel;
using Grasshopper.Kernel.Special;
using Rhino;

namespace Vide.Worker.Gh;

/// <summary>
/// The Grasshopper methods (ADR-033): read the canvas, search the component catalog, apply a batch
/// of edits as one Grasshopper undo record (GhApply), solve, read output data, capture the canvas,
/// open or save a definition and undo VIDE's own record. Fixed methods, never agent code; nothing
/// here locks the canvas or rearranges objects the call did not name.
/// </summary>
internal static class GhTools
{
    internal const int DefaultLimit = 200;
    internal const int TextChars = 2000;

    internal static object Dispatch(string method, JsonElement request, RhinoDoc rhino) => method switch
    {
        "gh-state" => State(request),
        "gh-components" => Components(request),
        "gh-apply" => GhApply.Run(Document(request), request),
        "gh-solve" => Solve(request),
        "gh-outputs" => Outputs(request),
        "gh-capture" => Capture(request),
        "gh-save" => Save(request),
        _ => throw new InvalidOperationException("UNKNOWN_METHOD"),
    };

    // --- documents ------------------------------------------------------------------------------

    internal static IEnumerable<GH_Document> Documents()
    {
        var server = Instances.DocumentServer;
        if (server == null) yield break;
        for (var i = 0; i < server.DocumentCount; i++)
            if (server[i] is { } document) yield return document;
    }

    /// <summary>The document a call names (`ghDocument`), else the one on the canvas, else the only one.</summary>
    internal static GH_Document Document(JsonElement request)
    {
        var named = Json.Str(request, "ghDocument");
        if (named != null)
        {
            if (!Guid.TryParse(named, out var id)) throw new InvalidOperationException("INVALID_INPUT");
            return Documents().FirstOrDefault(d => d.DocumentID == id) ?? throw new InvalidOperationException("GH_DOCUMENT_NOT_FOUND");
        }
        return Instances.ActiveCanvas?.Document ?? Documents().FirstOrDefault() ?? throw new InvalidOperationException("GH_NO_DOCUMENT");
    }

    internal static object DocumentInfo(GH_Document document) => new
    {
        id = document.DocumentID.ToString(),
        name = document.DisplayName,
        path = document.FilePath ?? "",
        modified = document.IsModified,
        active = Instances.ActiveCanvas?.Document == document,
        objects = document.ObjectCount,
    };

    // --- reading --------------------------------------------------------------------------------

    private static readonly Guid Python3 = new("719467e6-7cf5-4848-99b0-c5dd57e5442c");
    private static readonly Guid IronPython2 = new("410755b1-224a-4c1e-a407-bf32fb45ea7e");
    private static readonly Guid CSharpScript = new("b6ba1144-02d6-4a2d-b53c-ec62e290eeb7");

    internal static string? ScriptLanguage(IGH_DocumentObject obj) =>
        obj.ComponentGuid == Python3 ? "python" : obj.ComponentGuid == CSharpScript ? "csharp" : obj.ComponentGuid == IronPython2 ? "ironpython" : null;
    internal static Guid ScriptGuid(string language) => language switch
    {
        "python" => Python3,
        "csharp" => CSharpScript,
        _ => throw new InvalidOperationException("INVALID_INPUT"),
    };

    internal static string Kind(IGH_DocumentObject obj) => obj switch
    {
        GH_NumberSlider => "slider",
        GH_Panel => "panel",
        GH_BooleanToggle => "toggle",
        GH_ValueList => "valueList",
        GH_ButtonObject => "button",
        GH_Group => "group",
        GH_Scribble => "scribble",
        IGH_Component when ScriptLanguage(obj) != null => "script",
        IGH_Component => "component",
        IGH_Param => "param",
        _ => "other",
    };

    private static string Trim(string? text, int max) => text == null ? "" : text.Length > max ? text[..max] + "…" : text;
    private static double R(float value) => Math.Round(value, 1);

    /// <summary>A wire end: the owning object's id and, for a component's socket, its name and index.</summary>
    internal static object Ref(IGH_Param param)
    {
        var owner = param.Attributes?.GetTopLevel?.DocObject;
        if (owner is IGH_Component component)
        {
            var output = component.Params.Output.IndexOf(param);
            var index = output >= 0 ? output : component.Params.Input.IndexOf(param);
            return new { id = component.InstanceGuid.ToString(), param = param.NickName, index };
        }
        return new { id = (owner ?? param).InstanceGuid.ToString() };
    }

    private static object[] Messages(IGH_DocumentObject obj)
    {
        if (obj is not IGH_ActiveObject active) return [];
        return new[] { GH_RuntimeMessageLevel.Error, GH_RuntimeMessageLevel.Warning, GH_RuntimeMessageLevel.Remark }
            .SelectMany(level => active.RuntimeMessages(level).Take(10).Select(text => (object)new { level = level.ToString().ToLowerInvariant(), text = Trim(text, 300) }))
            .ToArray();
    }

    internal static Dictionary<string, object?> Describe(IGH_DocumentObject obj, bool full)
    {
        var row = new Dictionary<string, object?>
        {
            ["id"] = obj.InstanceGuid.ToString(),
            ["kind"] = Kind(obj),
            ["guid"] = obj.ComponentGuid.ToString(),
            ["name"] = obj.Name,
            ["nickname"] = obj.NickName,
        };
        if (full) { row["category"] = obj.Category; row["subcategory"] = obj.SubCategory; }
        if (obj.Attributes is { } attributes)
        {
            var bounds = attributes.Bounds;
            row["x"] = R(attributes.Pivot.X); row["y"] = R(attributes.Pivot.Y);
            row["bounds"] = new[] { R(bounds.Left), R(bounds.Top), R(bounds.Width), R(bounds.Height) };
            if (attributes.Selected) row["selected"] = true;
        }
        if (obj is IGH_PreviewObject { IsPreviewCapable: true } preview) row["preview"] = !preview.Hidden;
        if (obj is IGH_ActiveObject active)
        {
            if (active.Locked) row["locked"] = true;
            if (active.RuntimeMessageLevel != GH_RuntimeMessageLevel.Blank)
            {
                row["level"] = active.RuntimeMessageLevel.ToString().ToLowerInvariant();
                row["messages"] = Messages(obj);
            }
        }
        switch (obj)
        {
            case GH_NumberSlider slider:
                row["value"] = new { value = (double)slider.CurrentValue, min = (double)slider.Slider.Minimum, max = (double)slider.Slider.Maximum, decimals = slider.Slider.DecimalPlaces };
                break;
            case GH_Panel panel:
                row["value"] = new { text = Trim(panel.UserText, full ? 20000 : TextChars) };
                break;
            case GH_BooleanToggle toggle:
                row["value"] = new { value = toggle.Value };
                break;
            case GH_ValueList list:
                row["value"] = new { items = list.ListItems.Take(full ? 500 : 50).Select(item => new { name = item.Name, expression = item.Expression, selected = item.Selected }).ToArray(), count = list.ListItems.Count };
                break;
        }
        if (obj is IGH_Component component)
        {
            row["inputs"] = component.Params.Input.Select(p => new
            {
                name = p.Name, nickname = p.NickName, type = p.TypeName, access = p.Access.ToString().ToLowerInvariant(),
                optional = p.Optional, count = p.VolatileDataCount, sources = p.Sources.Select(Ref).ToArray(),
            }).ToArray();
            row["outputs"] = component.Params.Output.Select(p => new
            {
                name = p.Name, nickname = p.NickName, type = p.TypeName, count = p.VolatileDataCount, recipients = p.Recipients.Count,
            }).ToArray();
            var language = ScriptLanguage(obj);
            if (language != null)
            {
                row["language"] = language;
                if (full) row["source"] = Trim(GhScript.Source(obj, language), 60000);
            }
        }
        else if (obj is IGH_Param param && obj is not GH_Group)
        {
            row["type"] = param.TypeName;
            row["count"] = param.VolatileDataCount;
            if (param.SourceCount > 0) row["sources"] = param.Sources.Select(Ref).ToArray();
        }
        return row;
    }

    private static object State(JsonElement request)
    {
        var docs = Documents().ToList();
        if (docs.Count == 0)
            return new { ok = true, loaded = true, documents = Array.Empty<object>(),
                next = "Grasshopper is running without a document. gh_open opens a .gh of the project work folder or a new canvas." };
        var document = Document(request);
        var watch = GhWatch.Of(document);
        var ids = Json.Ids(request, "ids");
        var area = Json.Numbers(request, "area");
        var since = Json.Long(request, "since");
        var offset = Math.Max(0, Json.Int(request, "offset") ?? 0);
        var limit = Math.Clamp(Json.Int(request, "limit") ?? DefaultLimit, 1, 1000);
        // `since` older than VIDE's first look cannot list changes: everything is read again.
        var resync = since is { } s && s < watch.Start;
        var changedOnly = since is { } after && !resync ? watch.Changed.Where(e => e.Value > after).Select(e => e.Key).ToHashSet() : null;
        bool Wanted(IGH_DocumentObject obj)
        {
            if (ids != null && !ids.Contains(obj.InstanceGuid)) return false;
            if (changedOnly != null && !changedOnly.Contains(obj.InstanceGuid)) return false;
            if (area is { Length: 4 } && obj.Attributes is { } a)
            {
                var b = a.Bounds;
                if (b.Right < area[0] || b.Left > area[2] || b.Bottom < area[1] || b.Top > area[3]) return false;
            }
            return true;
        }
        var all = document.Objects.Where(Wanted).ToList();
        var groups = all.OfType<GH_Group>().Select(g => new
        {
            id = g.InstanceGuid.ToString(), name = g.NickName, color = $"#{g.Colour.A:x2}{g.Colour.R:x2}{g.Colour.G:x2}{g.Colour.B:x2}",
            members = g.ObjectIDs.Select(m => m.ToString()).ToArray(),
        }).ToArray();
        var scribbles = all.OfType<GH_Scribble>().Select(s => new
        {
            id = s.InstanceGuid.ToString(), text = Trim(s.Text, 500), x = R(s.Attributes?.Pivot.X ?? 0), y = R(s.Attributes?.Pivot.Y ?? 0),
        }).ToArray();
        var objects = all.Where(o => o is not GH_Group and not GH_Scribble).ToList();
        var page = objects.Skip(offset).Take(limit).Select(o => Describe(o, ids != null)).ToArray();
        var result = new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["loaded"] = true,
            ["document"] = DocumentInfo(document),
            ["revision"] = watch.Revision,
            ["solver"] = GH_Document.EnableSolutions,
            ["total"] = objects.Count,
            ["offset"] = offset,
            // The objects come first among the lists: the engine trims a large answer at its first list.
            ["objects"] = page,
            ["groups"] = groups,
            ["scribbles"] = scribbles,
            ["documents"] = docs.Select(DocumentInfo).ToArray(),
        };
        if (offset + page.Length < objects.Count) result["nextOffset"] = offset + page.Length;
        if (since != null && !resync)
            result["removed"] = watch.Removed.Where(e => e.Value > since).Select(e => e.Key.ToString()).ToArray();
        if (resync) result["resync"] = true;
        return result;
    }

    private static object Components(JsonElement request)
    {
        var query = (Json.Str(request, "query") ?? "").Trim();
        var words = query.ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var category = Json.Str(request, "category");
        var obsolete = Json.Bool(request, "obsolete") ?? false;
        var limit = Math.Clamp(Json.Int(request, "limit") ?? 20, 1, 100);
        var server = Instances.ComponentServer ?? throw new InvalidOperationException("GH_NOT_LOADED");
        int Score(IGH_ObjectProxy proxy)
        {
            var name = (proxy.Desc.Name ?? "").ToLowerInvariant();
            var nick = (proxy.Desc.NickName ?? "").ToLowerInvariant();
            var hay = $"{name} {nick} {proxy.Desc.Category} {proxy.Desc.SubCategory} {proxy.Desc.Description}".ToLowerInvariant();
            if (words.Any(w => !hay.Contains(w))) return -1;
            var phrase = string.Join(' ', words);
            return (name == phrase || nick == phrase ? 100 : 0) + (name.StartsWith(phrase) ? 30 : 0) + words.Count(w => name.Contains(w) || nick.Contains(w)) * 10;
        }
        var matches = server.ObjectProxies
            .Where(p => p.Guid != Guid.Empty && (obsolete || !p.Obsolete) && (category == null || string.Equals(p.Desc.Category, category, StringComparison.OrdinalIgnoreCase)))
            .Select(p => (proxy: p, score: Score(p)))
            .Where(m => m.score >= 0)
            .OrderByDescending(m => m.score).ThenBy(m => m.proxy.Desc.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var rows = matches.Take(limit).Select(m =>
        {
            var p = m.proxy;
            object? inputs = null, outputs = null;
            try
            {
                if (p.CreateInstance() is IGH_Component instance)
                {
                    inputs = instance.Params.Input.Select(x => new { name = x.Name, nickname = x.NickName, type = x.TypeName, access = x.Access.ToString().ToLowerInvariant(), optional = x.Optional }).ToArray();
                    outputs = instance.Params.Output.Select(x => new { name = x.Name, nickname = x.NickName, type = x.TypeName }).ToArray();
                }
            }
            catch { /* A component that cannot be made outside a document still lists its name. */ }
            return new
            {
                guid = p.Guid.ToString(), name = p.Desc.Name, nickname = p.Desc.NickName, category = p.Desc.Category, subcategory = p.Desc.SubCategory,
                description = Trim(p.Desc.Description, 300), kind = p.Kind.ToString(), obsolete = p.Obsolete, inputs, outputs,
            };
        }).ToArray();
        return new { ok = true, query, total = matches.Count, components = rows };
    }

    // --- solving and output data ------------------------------------------------------------------

    internal static object[] Problems(GH_Document document, int max = 100) => document.Objects
        .OfType<IGH_ActiveObject>()
        .Where(o => o.RuntimeMessageLevel is GH_RuntimeMessageLevel.Error or GH_RuntimeMessageLevel.Warning)
        .Take(max)
        .Select(o => (object)new { id = o.InstanceGuid.ToString(), nickname = o.NickName, level = o.RuntimeMessageLevel.ToString().ToLowerInvariant(), messages = Messages(o) })
        .ToArray();

    /// <summary>One solution now. A solver the user switched off stays off and is reported.</summary>
    internal static object RunSolution(GH_Document document, IEnumerable<Guid> expire, bool all)
    {
        if (!GH_Document.EnableSolutions)
            return new { solved = false, reason = "solver-disabled", next = "Grasshopper's solver is switched off (Solution > Disable Solver). Tell the user; VIDE does not switch it on." };
        foreach (var id in expire) document.FindObject(id, true)?.ExpireSolution(false);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        document.NewSolution(all);
        return new { solved = true, ms = clock.ElapsedMilliseconds, problems = Problems(document) };
    }

    private static object Solve(JsonElement request)
    {
        var document = Document(request);
        var watch = GhWatch.Of(document);
        var solution = RunSolution(document, Json.Ids(request, "expire") ?? [], Json.Bool(request, "all") ?? false);
        return new { ok = true, document = DocumentInfo(document), revision = watch.Revision, solution };
    }

    /// <summary>An object's socket by name, nickname or index; a standalone parameter is its own socket.</summary>
    internal static IGH_Param? Socket(IGH_DocumentObject obj, JsonElement? which, bool output)
    {
        if (obj is IGH_Param standalone && obj is not IGH_Component) return standalone;
        if (obj is not IGH_Component component) return null;
        var list = output ? component.Params.Output : component.Params.Input;
        if (which is not { } value || value.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
            return list.Count == 1 ? list[0] : null;
        if (value.ValueKind == JsonValueKind.Number) { var i = value.GetInt32(); return i >= 0 && i < list.Count ? list[i] : null; }
        var name = value.GetString() ?? "";
        return list.FirstOrDefault(p => string.Equals(p.NickName, name, StringComparison.Ordinal))
            ?? list.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.Ordinal))
            ?? list.FirstOrDefault(p => string.Equals(p.NickName, name, StringComparison.OrdinalIgnoreCase) || string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));
    }

    internal static IEnumerable<(IGH_Param param, string label)> ParamsOf(GH_Document document, JsonElement request)
    {
        if (!request.TryGetProperty("params", out var list) || list.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("INVALID_INPUT");
        foreach (var entry in list.EnumerateArray())
        {
            var id = Json.Guid(entry, "id") ?? throw new InvalidOperationException("INVALID_INPUT");
            var obj = document.FindObject(id, false) ?? throw new InvalidOperationException("GH_OBJECT_NOT_FOUND");
            JsonElement? which = entry.TryGetProperty("param", out var p) ? p : null;
            var input = Json.Str(entry, "side") == "input";
            var param = Socket(obj, which, !input) ?? throw new InvalidOperationException("GH_PARAM_NOT_FOUND");
            yield return (param, $"{obj.NickName}.{param.NickName}");
        }
    }

    private static object Outputs(JsonElement request)
    {
        var document = Document(request);
        var items = Math.Clamp(Json.Int(request, "items") ?? 10, 0, 500);
        var offset = Math.Max(0, Json.Int(request, "offset") ?? 0);
        var rows = ParamsOf(document, request).Select(entry =>
        {
            var (param, label) = entry;
            var data = param.VolatileData;
            var all = new List<(string path, Grasshopper.Kernel.Types.IGH_Goo? goo)>();
            foreach (var path in data.Paths)
                foreach (var goo in data.get_Branch(path).Cast<Grasshopper.Kernel.Types.IGH_Goo?>())
                    all.Add((path.ToString(), goo));
            var types = all.Select(x => x.goo?.TypeName ?? "null").Distinct().Take(20).ToArray();
            var bounds = Rhino.Geometry.BoundingBox.Empty;
            foreach (var (_, goo) in all)
                if (goo?.ScriptVariable() is Rhino.Geometry.GeometryBase geometry) bounds.Union(geometry.GetBoundingBox(false));
                else if (goo?.ScriptVariable() is Rhino.Geometry.Point3d point) bounds.Union(point);
            var shown = all.Skip(offset).Take(items).Select(x => new { path = x.path, value = Trim(x.goo?.ToString(), 200), type = x.goo?.TypeName }).ToArray();
            return new
            {
                @ref = Ref(param), label, type = param.TypeName, paths = data.PathCount, count = all.Count, types, items = shown,
                nextOffset = offset + shown.Length < all.Count ? offset + shown.Length : (int?)null,
                bounds = bounds.IsValid ? new[] { bounds.Min.X, bounds.Min.Y, bounds.Min.Z, bounds.Max.X, bounds.Max.Y, bounds.Max.Z } : null,
                level = (param.Attributes?.GetTopLevel?.DocObject as IGH_ActiveObject)?.RuntimeMessageLevel.ToString().ToLowerInvariant(),
            };
        }).ToArray();
        return new { ok = true, document = DocumentInfo(document), units = RhinoDoc.ActiveDoc?.ModelUnitSystem.ToString(), outputs = rows };
    }

    // --- canvas image -----------------------------------------------------------------------------

    private static object Capture(JsonElement request)
    {
        var document = Document(request);
        var canvas = Instances.ActiveCanvas ?? throw new InvalidOperationException("GH_NO_CANVAS");
        // The image is of the canvas the user sees; VIDE never switches the user's canvas to another document.
        if (canvas.Document != document) throw new InvalidOperationException("GH_DOCUMENT_NOT_ACTIVE");
        var width = Math.Clamp(Json.Int(request, "width") ?? 1200, 64, 2400);
        var height = Math.Clamp(Json.Int(request, "height") ?? 800, 64, 2400);
        var ids = Json.Ids(request, "ids");
        var area = Json.Numbers(request, "area");
        System.Drawing.RectangleF box;
        if (area is { Length: 4 }) box = System.Drawing.RectangleF.FromLTRB((float)area[0], (float)area[1], (float)area[2], (float)area[3]);
        else
        {
            var shown = document.Objects.Where(o => ids == null || ids.Contains(o.InstanceGuid)).Select(o => o.Attributes?.Bounds).OfType<System.Drawing.RectangleF>().ToList();
            if (shown.Count == 0) throw new InvalidOperationException(ids == null ? "GH_EMPTY_CANVAS" : "GH_OBJECT_NOT_FOUND");
            box = shown.Aggregate(System.Drawing.RectangleF.Union);
        }
        box.Inflate(Math.Max(20, box.Width * 0.04f), Math.Max(20, box.Height * 0.04f));
        var viewport = new Grasshopper.GUI.Canvas.GH_Viewport(canvas.Viewport) { Width = width, Height = height };
        viewport.Zoom = Math.Clamp(Math.Min(width / box.Width, height / box.Height), Grasshopper.GUI.Canvas.GH_Viewport.ZoomMinimum, 2f);
        viewport.Focus(new System.Drawing.PointF(box.X + box.Width / 2, box.Y + box.Height / 2));
        using var bitmap = canvas.GenerateHiResImageTile(viewport, System.Drawing.Color.White) ?? throw new InvalidOperationException("CAPTURE_FAILED");
        using var stream = new MemoryStream();
        bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
        return new
        {
            ok = true, mimeType = "image/png", width = bitmap.Width, height = bitmap.Height, data = Convert.ToBase64String(stream.ToArray()),
            document = DocumentInfo(document), area = new[] { R(box.Left), R(box.Top), R(box.Right), R(box.Bottom) },
        };
    }

    // --- files ------------------------------------------------------------------------------------

    private static string DefinitionPath(JsonElement request, bool mustExist)
    {
        var path = Json.Str(request, "path") ?? throw new InvalidOperationException("INVALID_INPUT");
        if (!Path.IsPathFullyQualified(path)) throw new InvalidOperationException("INVALID_INPUT");
        var extension = Path.GetExtension(path).ToLowerInvariant();
        if (extension is not (".gh" or ".ghx")) throw new InvalidOperationException("GH_NOT_A_DEFINITION");
        if (mustExist && !File.Exists(path)) throw new InvalidOperationException("NOT_FOUND");
        return Path.GetFullPath(path);
    }

    /// <summary>
    /// Shows Grasshopper and opens a definition (the engine checked it is inside the project work
    /// folder), or with no path makes sure a canvas exists (a new one when none is open).
    /// </summary>
    internal static object Open(JsonElement request)
    {
        var script = new Grasshopper.Plugin.GH_RhinoScriptInterface();
        script.LoadEditor();
        script.ShowEditor();
        GH_Document? document;
        if (Json.Str(request, "path") != null)
        {
            var path = DefinitionPath(request, mustExist: true);
            document = Documents().FirstOrDefault(d => string.Equals(d.FilePath, path, StringComparison.OrdinalIgnoreCase));
            if (document == null)
            {
                if (!script.OpenDocument(path)) throw new InvalidOperationException("GH_OPEN_FAILED");
                document = Documents().FirstOrDefault(d => string.Equals(d.FilePath, path, StringComparison.OrdinalIgnoreCase))
                    ?? throw new InvalidOperationException("GH_OPEN_FAILED");
            }
            else if (Instances.ActiveCanvas is { } canvas && canvas.Document != document) canvas.Document = document;
        }
        else
        {
            document = Instances.ActiveCanvas?.Document;
            if (document == null)
            {
                document = Instances.DocumentServer.AddNewDocument();
                if (Instances.ActiveCanvas is { } canvas) canvas.Document = document;
            }
        }
        var watch = GhWatch.Of(document);
        return new { ok = true, document = DocumentInfo(document), revision = watch.Revision };
    }

    private static object Save(JsonElement request)
    {
        var document = Document(request);
        var path = DefinitionPath(request, mustExist: false);
        if (!new GH_DocumentIO(document).SaveQuiet(path)) throw new InvalidOperationException("GH_SAVE_FAILED");
        return new { ok = true, path, document = DocumentInfo(document) };
    }

    // --- undo ---------------------------------------------------------------------------------------

    /// <summary>
    /// VIDE [되돌리기] of a gh_apply record: only while it is the newest record of that Grasshopper
    /// document's undo list (`gh-not-latest` otherwise: Ctrl+Z in Grasshopper, or undo the later ones first).
    /// </summary>
    internal static object Undo(string undoId)
    {
        var parts = undoId.Split(':');
        if (parts.Length != 3 || !Guid.TryParse(parts[1], out var documentId) || !Guid.TryParse(parts[2], out var recordId))
            return new { ok = false, reason = "unknown" };
        var document = Documents().FirstOrDefault(d => d.DocumentID == documentId);
        if (document == null) return new { ok = false, reason = "unknown" };
        var server = document.UndoServer;
        if (server.RedoGuids.Contains(recordId)) return new { ok = true, already = true };
        // The undo list's first entry is the newest record (PushUndoRecord inserts at 0, PerformUndo pops it).
        var undo = server.UndoGuids;
        if (!undo.Contains(recordId)) return new { ok = false, reason = "unknown" };
        if (undo[0] != recordId) return new { ok = false, reason = "gh-not-latest" };
        try { server.PerformUndo(); }
        catch { return new { ok = false, reason = "undo-failed" }; }
        Instances.RedrawCanvas();
        return server.RedoGuids.Contains(recordId) ? new { ok = true } : new { ok = false, reason = "undo-failed" };
    }
}

/// <summary>Small readers for the request JSON (missing or mistyped fields read as absent).</summary>
internal static class Json
{
    internal static string? Str(JsonElement e, string key) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    internal static int? Int(JsonElement e, string key) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;
    internal static long? Long(JsonElement e, string key) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var i) ? i : null;
    internal static double? Num(JsonElement e, string key) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;
    internal static bool? Bool(JsonElement e, string key) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;
    internal static Guid? Guid(JsonElement e, string key) => Str(e, key) is { } s && System.Guid.TryParse(s, out var g) ? g : null;
    internal static HashSet<Guid>? Ids(JsonElement e, string key)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(key, out var v) || v.ValueKind != JsonValueKind.Array) return null;
        var set = new HashSet<Guid>();
        foreach (var item in v.EnumerateArray())
            if (item.ValueKind == JsonValueKind.String && System.Guid.TryParse(item.GetString(), out var g)) set.Add(g);
        return set;
    }
    internal static double[]? Numbers(JsonElement e, string key)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(key, out var v) || v.ValueKind != JsonValueKind.Array) return null;
        return v.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.Number).Select(x => x.GetDouble()).ToArray();
    }
}
