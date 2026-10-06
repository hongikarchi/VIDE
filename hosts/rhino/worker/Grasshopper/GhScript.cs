// SPDX-License-Identifier: Apache-2.0
// Ported and reduced from Vino (src/Vino.Grasshopper/GrasshopperPythonFoundationAdapter.cs,
// Copyright 2026 Vino contributors), whose script-component behavior is Wireify-derived
// (Apache-2.0, Copyright Hossein Zargar and Wireify contributors). See THIRD_PARTY_NOTICES.

using System.Collections;
using System.Reflection;
using Grasshopper.Kernel;

namespace Vide.Worker.Gh;

/// <summary>
/// Rhino 8 script components (Python 3, C#; IronPython 2 source only): read and write the source
/// and set the inputs and outputs by name. RhinoCode's implementation assembly is not versioned
/// for plug-ins, so its surface (IScriptComponent.TryGetSource/SetSource, IScriptObject.ReBuild,
/// IScriptParameter.VariableName/PrettyName/Access/Converter) is reached by reflection, as Vino
/// did. Callers record the Grasshopper undo action before calling (GhApply).
/// </summary>
internal static class GhScript
{
    private const string ScriptComponentInterface = "RhinoCodePlatform.GH.IScriptComponent";
    private const string ScriptParameterInterface = "RhinoCodePlatform.GH.IScriptParameter";
    private const string ConverterNamespace = "RhinoCodePlatform.Rhino3D.Languages.GH1.Converters";
    /// <summary>The script components' managed console output (print), kept where it is.</summary>
    private const string ConsoleOutput = "out";

    internal sealed record Socket(string Name, string? TypeHint, string? Access);

    internal static string Source(IGH_DocumentObject component, string language)
    {
        if (language == "ironpython") return component.GetType().GetProperty("Code")?.GetValue(component) as string ?? "";
        foreach (var method in component.GetType().GetMethods())
        {
            if (method.Name != "TryGetSource") continue;
            var parameters = method.GetParameters();
            if (parameters.Length != 1 || !parameters[0].IsOut || parameters[0].ParameterType.GetElementType() != typeof(string)) continue;
            var arguments = new object?[] { null };
            return method.Invoke(component, arguments) is true && arguments[0] is string source ? source : "";
        }
        return "";
    }

    internal static void SetSource(IGH_DocumentObject component, string language, string source)
    {
        try
        {
            if (language == "ironpython")
            {
                (component.GetType().GetProperty("Code") ?? throw new InvalidOperationException("GH_SCRIPT_UNSUPPORTED")).SetValue(component, source);
                return;
            }
            var directive = language == "python" ? "#! python 3" : null;
            var trimmed = source.TrimStart('﻿', ' ', '\t', '\r', '\n');
            if (directive != null && !trimmed.StartsWith("#!", StringComparison.Ordinal)) source = directive + "\n" + source;
            var set = component.GetType().GetMethod("SetSource", [typeof(string)]) ?? throw new InvalidOperationException("GH_SCRIPT_UNSUPPORTED");
            set.Invoke(component, [source]);
            Rebuild(component);
        }
        catch (TargetInvocationException error) when (error.InnerException != null)
        {
            throw new GhOpException("GH_SCRIPT_FAILED", error.InnerException.Message);
        }
    }

    private static void Rebuild(IGH_DocumentObject component)
    {
        var rebuild = component.GetType().GetInterfaces().Where(c => c.Name == "IScriptObject")
            .Select(c => c.GetMethod("ReBuild", Type.EmptyTypes)).FirstOrDefault(m => m != null);
        if (rebuild?.Invoke(component, null) is Task task && !task.Wait(TimeSpan.FromSeconds(30)))
            throw new GhOpException("GH_SCRIPT_FAILED", "The script component did not rebuild within 30 seconds.");
    }

    private static Type? Interface(object target, string name) =>
        target.GetType().GetInterfaces().FirstOrDefault(i => i.FullName == name);

    private static List<(object script, IGH_Param? param)> Sockets(IGH_DocumentObject component, string side)
    {
        var list = Interface(component, ScriptComponentInterface)?.GetProperty(side)?.GetValue(component) as IEnumerable
            ?? throw new GhOpException("GH_SCRIPT_UNSUPPORTED", "This script component does not expose its " + side.ToLowerInvariant() + ".");
        return list.Cast<object?>().Where(x => x != null).Select(x => (x!, x as IGH_Param)).ToList();
    }

    private static string VariableName(object script) =>
        Interface(script, ScriptParameterInterface)?.GetProperty("VariableName")?.GetValue(script) as string ?? (script as IGH_Param)?.Name ?? "";

    private static void Set(object script, string property, object? value)
    {
        var info = Interface(script, ScriptParameterInterface)?.GetProperty(property);
        if (info is not { CanWrite: true }) return;
        try { info.SetValue(script, value); }
        catch (TargetInvocationException error) when (error.InnerException != null) { throw new GhOpException("GH_SCRIPT_FAILED", error.InnerException.Message); }
    }

    // RhinoCode's own converters for geometry hints (registered, so Grasshopper data is cast to the
    // Rhino type); numbers and text stay generic sockets and are cast in the script (as in Vino).
    private static readonly Dictionary<string, string> Converters = new(StringComparer.OrdinalIgnoreCase)
    {
        ["point3d"] = "Point3dConverter", ["point"] = "Point3dConverter", ["vector3d"] = "Vector3dConverter", ["vector"] = "Vector3dConverter",
        ["line"] = "LineConverter", ["curve"] = "CurveConverter", ["circle"] = "CircleConverter", ["arc"] = "ArcConverter",
        ["plane"] = "PlaneConverter", ["polyline"] = "PolylineConverter", ["rectangle3d"] = "Rectangle3dConverter", ["rectangle"] = "Rectangle3dConverter",
        ["box"] = "BoxConverter", ["brep"] = "BrepConverter", ["mesh"] = "MeshConverter", ["surface"] = "SurfaceConverter",
        ["geometry"] = "GeometryBaseConverter", ["geometrybase"] = "GeometryBaseConverter", ["guid"] = "GuidConverter",
        ["interval"] = "IntervalConverter", ["transform"] = "TransformConverter",
    };

    private static object? Converter(string? hint)
    {
        if (string.IsNullOrWhiteSpace(hint) || !Converters.TryGetValue(hint.Trim(), out var name)) return null;
        var assembly = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == "RhinoCodePlatform.Rhino3D");
        var type = assembly?.GetType($"{ConverterNamespace}.{name}");
        try { return type == null ? null : Activator.CreateInstance(type); }
        catch { return null; }
    }

    /// <summary>
    /// Makes one side of the component match `wanted` by name and order: sockets no longer named go
    /// (refused while wired: GH_SOCKET_WIRED), the rest are renamed in order, missing ones are added
    /// at the end. The console output `out` stays as it is.
    /// </summary>
    internal static void SetSockets(IGH_DocumentObject component, GH_ParameterSide side, IReadOnlyList<Socket> wanted)
    {
        if (component is not IGH_Component gh || component is not IGH_VariableParameterComponent variable)
            throw new GhOpException("GH_SCRIPT_UNSUPPORTED", "This component's sockets cannot be changed.");
        var property = side == GH_ParameterSide.Input ? "Inputs" : "Outputs";
        var desired = wanted.Where(s => s.Name != ConsoleOutput).ToList();
        if (desired.Select(s => s.Name).Distinct(StringComparer.Ordinal).Count() != desired.Count)
            throw new GhOpException("INVALID_INPUT", "Socket names must be unique.");
        var live = Sockets(component, property).Where(s => VariableName(s.script) != ConsoleOutput).ToList();
        var names = desired.Select(s => s.Name).ToHashSet(StringComparer.Ordinal);
        var dropped = live.Where(s => !names.Contains(VariableName(s.script))).ToList();
        var wired = dropped.Where(s => s.param is { } p && (p.SourceCount > 0 || p.Recipients.Count > 0)).Select(s => VariableName(s.script)).ToList();
        if (wired.Count > 0)
            throw new GhOpException("GH_SOCKET_WIRED", $"Socket(s) {string.Join(", ", wired)} still carry wires; disconnect them first or keep their names.");
        foreach (var (_, param) in dropped)
            if (param != null && !(side == GH_ParameterSide.Input ? gh.Params.UnregisterInputParameter(param, true) : gh.Params.UnregisterOutputParameter(param, true)))
                throw new GhOpException("GH_SCRIPT_FAILED", "Grasshopper refused to remove a socket.");
        if (dropped.Count > 0) Sync(component);
        // Append what is missing at the end of Grasshopper's own list (the console output may sit first).
        var count = Sockets(component, property).Count(s => VariableName(s.script) != ConsoleOutput);
        for (var index = count; index < desired.Count; index++)
        {
            var list = side == GH_ParameterSide.Input ? gh.Params.Input : gh.Params.Output;
            var position = list.Count;
            if (!variable.CanInsertParameter(side, position)) throw new GhOpException("GH_SCRIPT_FAILED", "The script component refused a new socket.");
            var param = variable.CreateParameter(side, position) ?? throw new GhOpException("GH_SCRIPT_FAILED", "The script component made no socket.");
            var registered = side == GH_ParameterSide.Input ? gh.Params.RegisterInputParam(param, position) : gh.Params.RegisterOutputParam(param, position);
            if (!registered) throw new GhOpException("GH_SCRIPT_FAILED", "Grasshopper did not register the new socket.");
            variable.VariableParameterMaintenance();
            gh.Params.OnParametersChanged();
        }
        var now = Sockets(component, property).Where(s => VariableName(s.script) != ConsoleOutput).ToList();
        for (var i = 0; i < desired.Count && i < now.Count; i++)
        {
            var (script, param) = now[i];
            var want = desired[i];
            Set(script, "VariableName", want.Name);
            Set(script, "PrettyName", want.Name);
            var access = Interface(script, ScriptParameterInterface)?.GetProperty("Access");
            if (access != null && want.Access is { } a)
                Set(script, "Access", Enum.Parse(access.PropertyType, a, ignoreCase: true));
            if (want.TypeHint != null) Set(script, "Converter", Converter(want.TypeHint));
            if (param != null) { param.Name = want.Name; param.NickName = want.Name; }
        }
        Sync(component);
    }

    private static void Sync(IGH_DocumentObject component)
    {
        if (component is IGH_VariableParameterComponent variable) variable.VariableParameterMaintenance();
        if (component is IGH_Component gh) gh.Params.OnParametersChanged();
        component.Attributes?.ExpireLayout();
    }
}

/// <summary>An op that failed with a code the AI can act on; the other ops of the call go on.</summary>
internal sealed class GhOpException(string code, string message) : Exception(message)
{
    internal string Code { get; } = code;
}
