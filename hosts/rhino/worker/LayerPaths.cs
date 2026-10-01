using Rhino;
using Rhino.DocObjects;

namespace Vide.Worker;

/// <summary>
/// Layer paths level by level (ARCH-03 §9.5). A layer is identified by its name under one parent id,
/// never by a full-path string: a layer that is not in a document (File3dm) does not know its
/// parents' names, so its FullPath can read as a bare name and match a root layer elsewhere.
/// The jig bake templates carry the same walk in C# text (they cannot call the plug-in, CodePolicy).
/// </summary>
internal static class LayerPaths
{
    /// <summary>The live child named <paramref name="name"/> directly under <paramref name="parentId"/> (Guid.Empty = root).</summary>
    internal static Layer? Child(RhinoDoc document, Guid parentId, string name) =>
        document.Layers.FirstOrDefault(layer => !layer.IsDeleted && layer.ParentLayerId == parentId &&
            string.Equals(layer.Name, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// A layer's chain from its top-level ancestor down to itself, followed through parent ids in its
    /// own table. A parent id the table does not hold, or a cycle, is refused rather than read as a
    /// top-level layer (that would put objects at the root). Depth is not limited: documents nest freely.
    /// </summary>
    internal static List<Layer> Chain(IEnumerable<Layer> table, Layer layer)
    {
        var byId = new Dictionary<Guid, Layer>();
        foreach (var item in table) byId.TryAdd(item.Id, item);
        var chain = new List<Layer> { layer };
        var seen = new HashSet<Guid> { layer.Id };
        var at = layer;
        while (at.ParentLayerId != Guid.Empty)
        {
            if (!byId.TryGetValue(at.ParentLayerId, out var parent) || !seen.Add(parent.Id)) throw new InvalidOperationException("UNSUPPORTED_APPLICATION");
            chain.Add(parent);
            at = parent;
        }
        chain.Reverse();
        return chain;
    }
}
