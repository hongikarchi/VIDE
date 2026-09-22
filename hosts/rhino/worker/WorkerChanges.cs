using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace Vide.Worker;

// Net changes against the input copy. Query calls never recompute this summary.
internal sealed class WorkerChanges : IDisposable
{
    private sealed record Entry(Guid NativeId, GeometryBase Geometry, string Metadata);
    private readonly Dictionary<string, Entry> basis;
    internal WorkerChanges(RhinoDoc document)
    {
        basis = document.Objects.GetObjectList(ObjectType.AnyObject).ToDictionary(WorkerScene.Id,
            obj => new Entry(obj.Id, obj.Geometry.Duplicate(), WorkerReadback.Metadata(obj)));
    }

    internal object Compare(RhinoDoc document)
    {
        var current = document.Objects.GetObjectList(ObjectType.AnyObject).ToDictionary(WorkerScene.Id);
        var added = current.Keys.Except(basis.Keys).Order(StringComparer.Ordinal).ToArray();
        var removed = basis.Keys.Except(current.Keys).Order(StringComparer.Ordinal).ToArray();
        var modified = current.Keys.Intersect(basis.Keys).Order(StringComparer.Ordinal).Select(id => new
        {
            id,
            geometry = !GeometryBase.GeometryEquals(basis[id].Geometry, current[id].Geometry),
            attributes = basis[id].Metadata != WorkerReadback.Metadata(current[id]),
            nativeIdentity = basis[id].NativeId != current[id].Id
        }).Where(change => change.geometry || change.attributes || change.nativeIdentity).ToArray();
        return new { added, removed, modified };
    }

    internal bool SameGeometry(RhinoObject obj) => basis.TryGetValue(WorkerScene.Id(obj), out var entry) &&
        GeometryBase.GeometryEquals(entry.Geometry, obj.Geometry);

    public void Dispose() { foreach (var entry in basis.Values) entry.Geometry.Dispose(); }
}
