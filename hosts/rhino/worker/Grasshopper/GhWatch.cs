using Grasshopper.Kernel;

namespace Vide.Worker.Gh;

/// <summary>
/// A change counter per Grasshopper document (ADR-033 4): every add, delete, wire, value, layout or
/// expiry of a top-level object bumps the document's revision and stamps that object with it, so
/// gh_state `since` returns only what changed and gh_apply can tell a caller that someone else (the
/// user, another conversation) touched the same object after the caller last read it. Revisions
/// count from when VIDE first looked at the document; an older `since` reads everything again.
/// UI thread only (Grasshopper raises these events there).
/// </summary>
internal static class GhWatch
{
    internal sealed class State
    {
        internal long Revision = 1;
        internal readonly long Start = 1;
        internal readonly Dictionary<Guid, long> Changed = new();
        internal readonly Dictionary<Guid, long> Removed = new();
        internal readonly HashSet<IGH_DocumentObject> Subscribed = new(ReferenceEqualityComparer.Instance);
    }

    private static readonly Dictionary<Guid, State> states = new();
    private static readonly Dictionary<GH_Document, Guid> owners = new(ReferenceEqualityComparer.Instance);

    /// <summary>The document's state, watching it from now on; newly added objects are picked up.</summary>
    internal static State Of(GH_Document document)
    {
        if (!states.TryGetValue(document.DocumentID, out var state))
        {
            state = new State();
            states[document.DocumentID] = state;
            owners[document] = document.DocumentID;
            document.ObjectsAdded += Added;
            document.ObjectsDeleted += Deleted;
            document.SolutionEnd += Solved;
        }
        foreach (var obj in document.Objects) Subscribe(state, obj);
        return state;
    }

    /// <summary>Marks objects as changed now (an apply's own edits) and returns the new revision.</summary>
    internal static long Mark(GH_Document document, IEnumerable<Guid> ids)
    {
        var state = Of(document);
        state.Revision++;
        foreach (var id in ids) state.Changed[id] = state.Revision;
        return state.Revision;
    }

    internal static void Forget(GH_Document document)
    {
        if (!owners.Remove(document, out var id)) return;
        states.Remove(id);
        document.ObjectsAdded -= Added;
        document.ObjectsDeleted -= Deleted;
        document.SolutionEnd -= Solved;
    }

    private static void Subscribe(State state, IGH_DocumentObject obj)
    {
        if (!state.Subscribed.Add(obj)) return;
        obj.ObjectChanged += ObjectChanged;
        obj.SolutionExpired += Expired;
        if (obj is IGH_Component component)
            foreach (var param in component.Params.Input.Concat(component.Params.Output))
                if (state.Subscribed.Add(param)) { param.ObjectChanged += ObjectChanged; }
    }

    private static State? StateOf(GH_Document? document) =>
        document != null && owners.TryGetValue(document, out var id) && states.TryGetValue(id, out var state) ? state : null;

    private static Guid TopLevel(IGH_DocumentObject obj) => obj.Attributes?.GetTopLevel?.DocObject?.InstanceGuid ?? obj.InstanceGuid;

    private static void Stamp(GH_Document? document, IGH_DocumentObject obj)
    {
        var state = StateOf(document);
        if (state == null) return;
        state.Revision++;
        state.Changed[TopLevel(obj)] = state.Revision;
    }

    private static void ObjectChanged(IGH_DocumentObject sender, GH_ObjectChangedEventArgs e) => Stamp(sender.OnPingDocument(), sender);
    private static void Expired(IGH_DocumentObject sender, GH_SolutionExpiredEventArgs e) => Stamp(sender.OnPingDocument(), sender);

    private static void Added(object sender, GH_DocObjectEventArgs e)
    {
        var state = StateOf(e.Document);
        if (state == null) return;
        state.Revision++;
        foreach (var obj in e.Objects)
        {
            state.Changed[obj.InstanceGuid] = state.Revision;
            state.Removed.Remove(obj.InstanceGuid);
            Subscribe(state, obj);
        }
    }

    private static void Deleted(object sender, GH_DocObjectEventArgs e)
    {
        var state = StateOf(e.Document);
        if (state == null) return;
        state.Revision++;
        foreach (var obj in e.Objects)
        {
            state.Changed.Remove(obj.InstanceGuid);
            state.Removed[obj.InstanceGuid] = state.Revision;
            state.Subscribed.Remove(obj);
            obj.ObjectChanged -= ObjectChanged;
            obj.SolutionExpired -= Expired;
        }
    }

    // A solution changes runtime messages and data; the objects it ran were stamped when they expired.
    private static void Solved(object sender, GH_SolutionEventArgs e)
    {
        var state = StateOf(sender as GH_Document);
        if (state != null) state.Revision++;
    }
}
