// The slider range/value order follows Vino (Apache-2.0, Copyright 2026 Vino contributors); see
// THIRD_PARTY_NOTICES. The rest is VIDE's own.

using System.Text.Json;
using Grasshopper;
using Grasshopper.Kernel;
using Grasshopper.Kernel.Special;
using Grasshopper.Kernel.Undo;
using Grasshopper.Kernel.Undo.Actions;

namespace Vide.Worker.Gh;

/// <summary>
/// gh_apply (ADR-033 3·4): a list of canvas edits applied in order as ONE Grasshopper undo record,
/// then one solution. Each op stands alone: an op whose object is gone (the user or another
/// conversation deleted it) or does not fit fails with its code and the others go on. Nothing is
/// locked and nothing the call does not name is moved. Concurrent edits are last-write-wins; the
/// answer says when an object this call changed was changed by someone else after `since`.
/// </summary>
internal static class GhApply
{
    private sealed class Context(GH_Document document, GH_UndoRecord record)
    {
        internal readonly GH_Document Document = document;
        internal readonly GH_UndoRecord Record = record;
        internal readonly Dictionary<string, Guid> Refs = new(StringComparer.Ordinal);
        internal readonly HashSet<Guid> Added = new();
        internal readonly HashSet<Guid> Recorded = new();
        internal readonly HashSet<Guid> Laid = new();
        internal readonly HashSet<IGH_Param> Wired = new(ReferenceEqualityComparer.Instance);
        internal readonly HashSet<Guid> Touched = new();
        internal readonly List<Guid> Removed = new();
        internal int Placed;

        internal IGH_DocumentObject Find(JsonElement op, string key = "id")
        {
            var text = Json.Str(op, key) ?? throw new GhOpException("INVALID_INPUT", $"'{key}' is required.");
            return Find(text);
        }
        internal IGH_DocumentObject Find(string text)
        {
            Guid id;
            if (text.StartsWith('$')) { if (!Refs.TryGetValue(text[1..], out id)) throw new GhOpException("GH_REF_UNKNOWN", $"No earlier op of this call has ref '{text[1..]}'."); }
            else if (!Guid.TryParse(text, out id)) throw new GhOpException("INVALID_INPUT", $"'{text}' is not an object id.");
            return Document.FindObject(id, true)
                ?? throw new GhOpException("GH_OBJECT_NOT_FOUND", $"Object {text} is not on the canvas (deleted, or never there). Read gh_state again.");
        }
        /// <summary>The object's state before this call's first change to it (never for objects it added).</summary>
        internal void Generic(IGH_DocumentObject obj)
        {
            if (Added.Contains(obj.InstanceGuid) || !Recorded.Add(obj.InstanceGuid)) return;
            Record.AddAction(new GH_GenericObjectAction(obj));
        }
        internal void Wire(IGH_Param param)
        {
            var owner = Owner(param);
            if (Added.Contains(owner) || !Wired.Add(param)) return;
            Record.AddAction(new GH_WireAction(param));
        }
        internal void Touch(IGH_DocumentObject obj) => Touched.Add(obj.InstanceGuid);
    }

    private static Guid Owner(IGH_Param param) => param.Attributes?.GetTopLevel?.DocObject?.InstanceGuid ?? param.InstanceGuid;

    internal static object Run(GH_Document document, JsonElement request)
    {
        if (!request.TryGetProperty("ops", out var ops) || ops.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("INVALID_INPUT");
        var label = Json.Str(request, "label") is { Length: > 0 } named ? named : "VIDE";
        var since = Json.Long(request, "since");
        var watch = GhWatch.Of(document);
        var before = watch.Revision;
        var context = new Context(document, new GH_UndoRecord(label.Length > 120 ? label[..120] : label));
        var results = new List<object>();
        var index = 0;
        foreach (var op in ops.EnumerateArray())
        {
            var kind = Json.Str(op, "op") ?? "";
            try
            {
                var outcome = Apply(context, kind, op);
                results.Add(new Dictionary<string, object?>(outcome) { ["index"] = index, ["op"] = kind, ["ok"] = true });
            }
            catch (GhOpException failure)
            {
                results.Add(new { index, op = kind, ok = false, code = failure.Code, message = Short(failure.Message) });
            }
            catch (InvalidOperationException failure) when (System.Text.RegularExpressions.Regex.IsMatch(failure.Message, "^[A-Z][A-Z0-9_]{1,63}$"))
            {
                results.Add(new { index, op = kind, ok = false, code = failure.Message });
            }
            catch (Exception failure)
            {
                results.Add(new { index, op = kind, ok = false, code = "GH_OP_FAILED", message = Short(failure.Message) });
            }
            index++;
        }
        string? undoId = null;
        if (context.Record.ActionCount > 0)
        {
            document.UndoServer.PushUndoRecord(context.Record);
            undoId = $"gh:{document.DocumentID}:{context.Record.Guid}";
        }
        // Others' edits (the user, another conversation) after the caller's read and before this call.
        var others = since is { } after
            ? context.Touched.Where(id => watch.Changed.TryGetValue(id, out var r) && r > after && r <= before)
                .Concat(context.Touched.Where(id => watch.Removed.TryGetValue(id, out var r) && r > after && r <= before))
                .Distinct().Select(id => id.ToString()).ToArray()
            : [];
        var revision = GhWatch.Mark(document, context.Touched);
        Instances.RedrawCanvas();
        object? solution = null;
        var changedAny = context.Touched.Count > 0 || context.Removed.Count > 0;
        if (changedAny && Json.Bool(request, "solve") != false)
        {
            solution = GhTools.RunSolution(document, [], false);
            revision = GhWatch.Of(document).Revision;
        }
        var touched = context.Touched.Select(id => document.FindObject(id, true)).OfType<IGH_DocumentObject>().ToList();
        var notices = new List<object>();
        if (others.Length > 0)
            notices.Add(new { code = "GH_CHANGED_BY_OTHERS", ids = others,
                next = "Someone else (the user or another conversation) changed these objects after your last read; your edit was applied on top (last write wins). Read them again with gh_state ids if your edit depended on their old state." });
        return new
        {
            ok = results.Any(r => r is Dictionary<string, object?> d && d["ok"] is true) || ops.GetArrayLength() == 0,
            undoId,
            revision,
            document = GhTools.DocumentInfo(document),
            results,
            created = context.Refs.ToDictionary(e => e.Key, e => e.Value.ToString()),
            changed = context.Touched.Select(id => id.ToString()).ToArray(),
            removed = context.Removed.Select(id => id.ToString()).ToArray(),
            states = touched.Where(o => o is IGH_ActiveObject).Select(o => new
            {
                id = o.InstanceGuid.ToString(), nickname = o.NickName,
                level = ((IGH_ActiveObject)o).RuntimeMessageLevel.ToString().ToLowerInvariant(),
                messages = GhTools.Describe(o, false).TryGetValue("messages", out var m) ? m : null,
            }).ToArray(),
            solution,
            notices,
        };
    }

    private static string Short(string text) => text.Length > 400 ? text[..400] : text;

    private static Dictionary<string, object?> Apply(Context c, string kind, JsonElement op) => kind switch
    {
        "add" => Add(c, op),
        "delete" => Delete(c, op),
        "move" => Move(c, op),
        "connect" => Connect(c, op),
        "disconnect" => Disconnect(c, op),
        "set" => Set(c, c.Find(op), op),
        "script" => Script(c, c.Find(op), op),
        "group" => Group(c, op),
        "ungroup" => Delete(c, op, mustBeGroup: true),
        "select" => Select(c, op),
        _ => throw new GhOpException("INVALID_INPUT", $"Unknown op '{kind}'. Use add, delete, move, connect, disconnect, set, script, group, ungroup or select."),
    };

    // --- add / delete / move ----------------------------------------------------------------------

    private static IGH_ObjectProxy ByName(string name)
    {
        var proxies = Instances.ComponentServer.ObjectProxies.Where(p => !p.Obsolete &&
            (string.Equals(p.Desc.Name, name, StringComparison.OrdinalIgnoreCase) || string.Equals(p.Desc.NickName, name, StringComparison.OrdinalIgnoreCase))).ToList();
        if (proxies.Count == 1) return proxies[0];
        if (proxies.Count == 0) throw new GhOpException("GH_COMPONENT_NOT_FOUND", $"No installed component is named '{name}'. Search with gh_components and add by guid.");
        throw new GhOpException("GH_COMPONENT_AMBIGUOUS", $"'{name}' names {proxies.Count} components: " +
            string.Join("; ", proxies.Take(8).Select(p => $"{p.Guid} ({p.Desc.Category}/{p.Desc.SubCategory})")) + ". Add by guid.");
    }

    private static Dictionary<string, object?> Add(Context c, JsonElement op)
    {
        IGH_DocumentObject obj;
        var script = Json.Str(op, "script");
        if (script != null) obj = Instances.ComponentServer.EmitObject(GhTools.ScriptGuid(script))
            ?? throw new GhOpException("GH_COMPONENT_NOT_FOUND", $"The {script} script component is not installed.");
        else if (Json.Guid(op, "guid") is { } guid) obj = Instances.ComponentServer.EmitObject(guid)
            ?? throw new GhOpException("GH_COMPONENT_NOT_FOUND", $"No installed component has guid {guid}. Search with gh_components.");
        else if (Json.Str(op, "name") is { } name) obj = ByName(name).CreateInstance()
            ?? throw new GhOpException("GH_COMPONENT_NOT_FOUND", $"'{name}' could not be created.");
        else throw new GhOpException("INVALID_INPUT", "add needs guid, name or script.");
        if (obj.Attributes == null) obj.CreateAttributes();
        var x = Json.Num(op, "x");
        var y = Json.Num(op, "y");
        if (x == null || y == null)
        {
            // Without a position: to the right of everything, one under the other. Nothing else moves.
            var right = c.Document.Objects.Select(o => o.Attributes?.Bounds.Right ?? 0).DefaultIfEmpty(0).Max();
            var top = c.Document.Objects.Select(o => o.Attributes?.Bounds.Top ?? 0).DefaultIfEmpty(0).Min();
            x ??= right + 80;
            y ??= top + 60 * c.Placed++;
        }
        obj.Attributes!.Pivot = new System.Drawing.PointF((float)x.Value, (float)y.Value);
        if (Json.Str(op, "nickname") is { Length: > 0 } nickname) obj.NickName = nickname;
        if (!c.Document.AddObject(obj, false)) throw new GhOpException("GH_OP_FAILED", "Grasshopper did not add the object.");
        c.Record.AddAction(new GH_AddObjectAction(obj));
        c.Added.Add(obj.InstanceGuid);
        c.Touch(obj);
        var row = new Dictionary<string, object?> { ["id"] = obj.InstanceGuid.ToString(), ["name"] = obj.Name };
        if (Json.Str(op, "ref") is { Length: > 0 } reference) { c.Refs[reference] = obj.InstanceGuid; row["ref"] = reference; }
        // Values given with the add (a slider's range, a panel's text) are set at once.
        if (new[] { "value", "min", "max", "decimals", "text", "items", "data", "selected" }.Any(key => op.TryGetProperty(key, out _))) Set(c, obj, op);
        if (obj is IGH_Component && (op.TryGetProperty("source", out _) || op.TryGetProperty("inputs", out _) || op.TryGetProperty("outputs", out _))) Script(c, obj, op);
        return row;
    }

    private static Dictionary<string, object?> Delete(Context c, JsonElement op, bool mustBeGroup = false)
    {
        var obj = c.Find(op);
        if (mustBeGroup && obj is not GH_Group) throw new GhOpException("GH_TYPE_MISMATCH", "ungroup takes a group id.");
        // Wires into other objects go with the object; their sources come back with an undo.
        var outgoing = obj switch
        {
            IGH_Component component => component.Params.Output.SelectMany(p => p.Recipients),
            IGH_Param param => param.Recipients,
            _ => [],
        };
        foreach (var recipient in outgoing.ToList()) { c.Wire(recipient); c.Touched.Add(Owner(recipient)); }
        c.Record.AddAction(new GH_RemoveObjectAction(obj));
        if (!c.Document.RemoveObject(obj, false)) throw new GhOpException("GH_OP_FAILED", "Grasshopper did not remove the object.");
        c.Touched.Remove(obj.InstanceGuid);
        c.Removed.Add(obj.InstanceGuid);
        return new() { ["id"] = obj.InstanceGuid.ToString() };
    }

    private static Dictionary<string, object?> Move(Context c, JsonElement op)
    {
        var obj = c.Find(op);
        var attributes = obj.Attributes ?? throw new GhOpException("GH_OP_FAILED", "The object has no canvas position.");
        var pivot = attributes.Pivot;
        var x = Json.Num(op, "x") ?? pivot.X + (Json.Num(op, "dx") ?? 0);
        var y = Json.Num(op, "y") ?? pivot.Y + (Json.Num(op, "dy") ?? 0);
        if (!c.Added.Contains(obj.InstanceGuid) && c.Laid.Add(obj.InstanceGuid)) c.Record.AddAction(new GH_LayoutAction(obj));
        attributes.Pivot = new System.Drawing.PointF((float)x, (float)y);
        attributes.ExpireLayout();
        c.Touch(obj);
        return new() { ["id"] = obj.InstanceGuid.ToString(), ["x"] = Math.Round(x, 1), ["y"] = Math.Round(y, 1) };
    }

    // --- wires ------------------------------------------------------------------------------------

    private static IGH_Param End(Context c, JsonElement op, string key, bool output)
    {
        if (!op.TryGetProperty(key, out var end) || end.ValueKind != JsonValueKind.Object) throw new GhOpException("INVALID_INPUT", $"'{key}' needs {{id, param}}.");
        var obj = c.Find(end);
        JsonElement? which = end.TryGetProperty("param", out var p) ? p : null;
        return GhTools.Socket(obj, which, output) ?? throw new GhOpException("GH_PARAM_NOT_FOUND",
            $"{(output ? "Output" : "Input")} '{(which?.ToString() ?? "")}' not found on {obj.NickName}. It has: " +
            (obj is IGH_Component component ? string.Join(", ", (output ? component.Params.Output : component.Params.Input).Select((x, i) => $"{i}:{x.NickName}")) : "one socket") + ".");
    }

    private static Dictionary<string, object?> Connect(Context c, JsonElement op)
    {
        var source = End(c, op, "from", output: true);
        var target = End(c, op, "to", output: false);
        if (Json.Bool(op, "replace") == true && target.SourceCount > 0) { c.Wire(target); target.RemoveAllSources(); }
        if (target.Sources.Contains(source)) return new() { ["unchanged"] = true };
        c.Wire(target);
        target.AddSource(source);
        target.ExpireSolution(false);
        c.Touched.Add(Owner(target));
        return new() { ["from"] = GhTools.Ref(source), ["to"] = GhTools.Ref(target) };
    }

    private static Dictionary<string, object?> Disconnect(Context c, JsonElement op)
    {
        var target = End(c, op, "to", output: false);
        c.Wire(target);
        if (op.TryGetProperty("from", out _))
        {
            var source = End(c, op, "from", output: true);
            if (!target.Sources.Contains(source)) return new() { ["unchanged"] = true };
            target.RemoveSource(source);
        }
        else target.RemoveAllSources();
        target.ExpireSolution(false);
        c.Touched.Add(Owner(target));
        return new() { ["to"] = GhTools.Ref(target) };
    }

    // --- values -----------------------------------------------------------------------------------

    private static decimal Dec(JsonElement op, string key, decimal fallback) => Json.Num(op, key) is { } v ? (decimal)v : fallback;

    private static Dictionary<string, object?> Set(Context c, IGH_DocumentObject obj, JsonElement op)
    {
        var target = obj;
        // A component's input value (persistent data) by socket name: {id, param, data}.
        if (obj is IGH_Component && op.TryGetProperty("param", out var which))
            target = GhTools.Socket(obj, which, output: false) ?? throw new GhOpException("GH_PARAM_NOT_FOUND", $"Input '{which}' not found on {obj.NickName}.");
        c.Generic(obj is IGH_Component ? obj : target);
        var changed = new List<string>();
        switch (target)
        {
            case GH_ButtonObject when op.TryGetProperty("value", out _):
                throw new GhOpException("GH_BUTTON_UNSUPPORTED", "A Button is pressed by a person; VIDE does not set it (it can open a dialog). Use a Boolean Toggle.");
            case GH_NumberSlider slider when new[] { "value", "min", "max", "decimals" }.Any(k => op.TryGetProperty(k, out _)):
            {
                var min = Dec(op, "min", slider.Slider.Minimum);
                var max = Dec(op, "max", slider.Slider.Maximum);
                var value = Dec(op, "value", slider.CurrentValue);
                if (min > max) throw new GhOpException("INVALID_INPUT", "min is above max.");
                // Widen first so the new value never clamps against the old range (Vino's order).
                slider.Slider.Minimum = Math.Min(slider.Slider.Minimum, Math.Min(min, value));
                slider.Slider.Maximum = Math.Max(slider.Slider.Maximum, Math.Max(max, value));
                slider.Slider.Minimum = min;
                slider.Slider.Maximum = max;
                if (Json.Int(op, "decimals") is { } decimals) slider.Slider.DecimalPlaces = Math.Clamp(decimals, 0, 12);
                slider.SetSliderValue(Math.Clamp(value, min, max));
                changed.Add("value");
                break;
            }
            case GH_Panel panel when Json.Str(op, "text") is { } text:
                panel.SetUserText(text);
                changed.Add("text");
                break;
            case GH_BooleanToggle toggle when Json.Bool(op, "value") is { } on:
                toggle.Value = on;
                changed.Add("value");
                break;
            case GH_ValueList list when op.TryGetProperty("items", out _) || op.TryGetProperty("selected", out _):
            {
                if (op.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
                {
                    list.ListItems.Clear();
                    foreach (var item in items.EnumerateArray())
                    {
                        var name = Json.Str(item, "name") ?? item.ToString();
                        var expression = Json.Str(item, "expression") ?? (item.ValueKind == JsonValueKind.Object ? name : item.GetRawText());
                        list.ListItems.Add(new GH_ValueListItem(name, expression));
                    }
                    changed.Add("items");
                }
                if (op.TryGetProperty("selected", out var selected) && list.ListItems.Count > 0)
                {
                    var at = selected.ValueKind == JsonValueKind.Number ? selected.GetInt32()
                        : list.ListItems.FindIndex(i => string.Equals(i.Name, selected.GetString(), StringComparison.OrdinalIgnoreCase));
                    if (at < 0 || at >= list.ListItems.Count) throw new GhOpException("INVALID_INPUT", "selected names no item of the list.");
                    list.SelectItem(at);
                    changed.Add("selected");
                }
                else if (changed.Contains("items") && list.ListItems.Count > 0) list.SelectItem(0);
                break;
            }
            case GH_Scribble scribble when Json.Str(op, "text") is { } words:
                scribble.Text = words;
                changed.Add("text");
                break;
        }
        if (op.TryGetProperty("data", out var data) && target is IGH_Param param && target is not (GH_NumberSlider or GH_Panel or GH_BooleanToggle or GH_ValueList or GH_ButtonObject))
        {
            SetData(param, data);
            changed.Add("data");
        }
        if (Json.Str(op, "nickname") is { Length: > 0 } nickname && !op.TryGetProperty("param", out _)) { obj.NickName = nickname; changed.Add("nickname"); }
        if (Json.Bool(op, "preview") is { } preview && obj is IGH_PreviewObject previewable) { previewable.Hidden = !preview; changed.Add("preview"); }
        if (Json.Bool(op, "locked") is { } locked && obj is IGH_ActiveObject active) { active.Locked = locked; changed.Add("locked"); }
        if (changed.Count == 0) throw new GhOpException("GH_TYPE_MISMATCH", $"Nothing to set on {GhTools.Kind(target)} '{obj.NickName}' with these fields.");
        obj.Attributes?.ExpireLayout();
        target.ExpireSolution(false);
        c.Touch(obj);
        return new() { ["id"] = obj.InstanceGuid.ToString(), ["set"] = changed };
    }

    /// <summary>A parameter's own values (what right-click → Set … gives): numbers, text, booleans, points [x,y,z].</summary>
    private static void SetData(IGH_Param param, JsonElement data)
    {
        var values = (data.ValueKind == JsonValueKind.Array ? data.EnumerateArray().ToList() : [data]).Select(Value).ToArray();
        var method = param.GetType().GetMethod("SetPersistentData", [typeof(object[])])
            ?? throw new GhOpException("GH_TYPE_MISMATCH", $"'{param.NickName}' keeps no values of its own.");
        try { method.Invoke(param, [values]); }
        catch (System.Reflection.TargetInvocationException error) when (error.InnerException != null)
        { throw new GhOpException("GH_TYPE_MISMATCH", error.InnerException.Message); }
    }

    private static object Value(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Number => e.GetDouble(),
        JsonValueKind.True or JsonValueKind.False => e.GetBoolean(),
        JsonValueKind.Array when e.GetArrayLength() == 3 && e.EnumerateArray().All(x => x.ValueKind == JsonValueKind.Number) =>
            new Rhino.Geometry.Point3d(e[0].GetDouble(), e[1].GetDouble(), e[2].GetDouble()),
        _ => e.ValueKind == JsonValueKind.String ? e.GetString()! : e.GetRawText(),
    };

    // --- script components ------------------------------------------------------------------------

    private static List<GhScript.Socket>? Sockets(JsonElement op, string key)
    {
        if (!op.TryGetProperty(key, out var list) || list.ValueKind != JsonValueKind.Array) return null;
        return list.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.String
            ? new GhScript.Socket(item.GetString()!, null, null)
            : new GhScript.Socket(Json.Str(item, "name") ?? throw new GhOpException("INVALID_INPUT", "A socket needs a name."),
                Json.Str(item, "typeHint") ?? Json.Str(item, "type"), Json.Str(item, "access"))).ToList();
    }

    private static Dictionary<string, object?> Script(Context c, IGH_DocumentObject obj, JsonElement op)
    {
        var language = GhTools.ScriptLanguage(obj) ?? throw new GhOpException("GH_TYPE_MISMATCH", $"'{obj.NickName}' is not a script component.");
        c.Generic(obj);
        var done = new List<string>();
        if (Sockets(op, "inputs") is { } inputs) { GhScript.SetSockets(obj, GH_ParameterSide.Input, inputs); done.Add("inputs"); }
        if (Sockets(op, "outputs") is { } outputs) { GhScript.SetSockets(obj, GH_ParameterSide.Output, outputs); done.Add("outputs"); }
        if (Json.Str(op, "source") is { } source) { GhScript.SetSource(obj, language, source); done.Add("source"); }
        if (done.Count == 0) throw new GhOpException("INVALID_INPUT", "script needs source, inputs or outputs.");
        obj.ExpireSolution(false);
        c.Touch(obj);
        return new() { ["id"] = obj.InstanceGuid.ToString(), ["language"] = language, ["set"] = done };
    }

    // --- groups and selection ---------------------------------------------------------------------

    private static System.Drawing.Color? Colour(JsonElement op)
    {
        var text = Json.Str(op, "color");
        if (text is not { Length: 7 or 9 } || text[0] != '#') return null;
        var argb = Convert.ToUInt32(text[1..], 16);
        return text.Length == 7 ? System.Drawing.Color.FromArgb(150, (int)(argb >> 16 & 255), (int)(argb >> 8 & 255), (int)(argb & 255))
            : System.Drawing.Color.FromArgb((int)(argb >> 24 & 255), (int)(argb >> 16 & 255), (int)(argb >> 8 & 255), (int)(argb & 255));
    }

    private static IEnumerable<IGH_DocumentObject> Members(Context c, JsonElement op, string key) =>
        op.TryGetProperty(key, out var list) && list.ValueKind == JsonValueKind.Array
            ? list.EnumerateArray().Select(e => c.Find(e.GetString() ?? "")).ToList() : [];

    private static Dictionary<string, object?> Group(Context c, JsonElement op)
    {
        if (Json.Str(op, "id") != null)
        {
            if (c.Find(op) is not GH_Group existing) throw new GhOpException("GH_TYPE_MISMATCH", "id names no group.");
            c.Generic(existing);
            foreach (var member in Members(c, op, "add")) existing.AddObject(member.InstanceGuid);
            foreach (var member in Members(c, op, "remove")) existing.RemoveObject(member.InstanceGuid);
            if (Json.Str(op, "name") is { } rename) existing.NickName = rename;
            if (Colour(op) is { } recolour) existing.Colour = recolour;
            existing.ExpireCaches();
            c.Touch(existing);
            return new() { ["id"] = existing.InstanceGuid.ToString() };
        }
        var group = new GH_Group();
        group.CreateAttributes();
        if (Json.Str(op, "name") is { } name) group.NickName = name;
        if (Colour(op) is { } colour) group.Colour = colour;
        var members = Members(c, op, "ids").ToList();
        if (members.Count == 0) throw new GhOpException("INVALID_INPUT", "group needs ids.");
        foreach (var member in members) group.AddObject(member.InstanceGuid);
        if (!c.Document.AddObject(group, false)) throw new GhOpException("GH_OP_FAILED", "Grasshopper did not add the group.");
        c.Record.AddAction(new GH_AddObjectAction(group));
        c.Added.Add(group.InstanceGuid);
        c.Touch(group);
        var row = new Dictionary<string, object?> { ["id"] = group.InstanceGuid.ToString() };
        if (Json.Str(op, "ref") is { Length: > 0 } reference) { c.Refs[reference] = group.InstanceGuid; row["ref"] = reference; }
        return row;
    }

    // Selection is the user's view, not the definition: no undo action and no change mark.
    private static Dictionary<string, object?> Select(Context c, JsonElement op)
    {
        if (Json.Bool(op, "add") != true) c.Document.DeselectAll();
        var members = Members(c, op, "ids").ToList();
        foreach (var member in members) if (member.Attributes != null) member.Attributes.Selected = true;
        return new() { ["selected"] = members.Count };
    }
}
