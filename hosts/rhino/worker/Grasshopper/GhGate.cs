using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Rhino;

namespace Vide.Worker.Gh;

/// <summary>
/// Grasshopper in VIDE (ADR-033): thin canvas tools over the user's own Grasshopper, on Rhino's UI
/// thread (every host call is dispatched there, WorkerCommand.Serve). This class never names a
/// Grasshopper type, so the plugin loads and runs without Grasshopper; GhTools (which does) is
/// reached only once the Grasshopper plug-in is loaded.
/// </summary>
internal static class GhGate
{
    internal static readonly Guid PlugInId = new("b45a29b1-4343-4035-989e-044e8580d9cf");

    internal static bool Loaded()
    {
        try { return Rhino.PlugIns.PlugIn.PlugInExists(PlugInId, out var loaded, out _) && loaded; }
        catch { return false; }
    }

    /// <summary>The gh-* methods of an attached connection (AttachedConnection.Dispatch).</summary>
    internal static object Dispatch(string method, JsonElement request, RhinoDoc document)
    {
        if (method == "gh-open") return Open(request);
        if (!Loaded())
        {
            // Reading an unloaded Grasshopper is not an error: there is simply no canvas yet.
            if (method == "gh-state") return new { ok = true, loaded = false, documents = Array.Empty<object>(),
                next = "Grasshopper is not running. gh_open starts it (with a .gh file of the project work folder, or a new canvas)." };
            throw new InvalidOperationException("GH_NOT_LOADED");
        }
        return Run(method, request, document);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static object Run(string method, JsonElement request, RhinoDoc document) => GhTools.Dispatch(method, request, document);

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static object Open(JsonElement request)
    {
        if (!Loaded() && !Rhino.PlugIns.PlugIn.LoadPlugIn(PlugInId)) throw new InvalidOperationException("GH_NOT_LOADED");
        return OpenLoaded(request);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static object OpenLoaded(JsonElement request) => GhTools.Open(request);

    /// <summary>`direct-undo` of a Grasshopper record (`gh:&lt;document&gt;:&lt;record&gt;`).</summary>
    internal static object Undo(string undoId)
    {
        if (!Loaded()) return new { ok = false, reason = "unknown" };
        return UndoLoaded(undoId);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static object UndoLoaded(string undoId) => GhTools.Undo(undoId);

    /// <summary>`direct-execute` with language `gh-bake`: runs inside the Rhino undo record DirectExecutor opened.</summary>
    internal static object? Bake(RhinoDoc document, string spec, StringBuilder output)
    {
        if (!Loaded()) throw new InvalidOperationException("GH_NOT_LOADED");
        return BakeLoaded(document, spec, output);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static object? BakeLoaded(RhinoDoc document, string spec, StringBuilder output) => GhBake.Run(document, spec, output);
}
