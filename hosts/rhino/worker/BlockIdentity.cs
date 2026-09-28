using System.Text.Json;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace Vide.Worker;

internal static class BlockIdentity
{
    internal static RhinoObject[] Objects(RhinoDoc doc) => doc.Objects.GetObjectList(ObjectType.AnyObject)
        .Concat(doc.InstanceDefinitions.Where(definition => !definition.IsDeleted).SelectMany(definition => definition.GetObjects()))
        .DistinctBy(obj => obj.Id).OrderBy(obj => obj.Id).ToArray();

    internal static string Signature(IEnumerable<InstanceDefinitionGeometry> definitions) => JsonSerializer.Serialize(
        definitions.OrderBy(definition => definition.Id).Select(definition => new {
            definition.Id, definition.Name, definition.Description,
            objects = definition.GetObjectIds().Order().ToArray(),
            strings = Strings(definition)
        }));

    internal static string Signature(RhinoDoc doc) => Signature(doc.InstanceDefinitions.Where(definition => !definition.IsDeleted));

    private static object Strings(InstanceDefinitionGeometry definition)
    {
        var strings = definition.GetUserStrings();
        return strings.AllKeys.Where(key => key != null).Order(StringComparer.Ordinal)
            .Select(key => new { key, value = strings[key!] }).ToArray();
    }
}
