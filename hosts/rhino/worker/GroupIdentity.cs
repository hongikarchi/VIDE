using System.Text.Json;
using Rhino.DocObjects;

namespace Vide.Worker;

internal static class GroupIdentity
{
    internal static string Signature(IEnumerable<Group> groups) => JsonSerializer.Serialize(
        groups.Where(group => !group.IsDeleted).OrderBy(group => group.Id).Select(group => new
        {
            group.Id, group.Index, group.Name,
            strings = Strings(group)
        }));

    private static object Strings(Group group)
    {
        var values = group.GetUserStrings();
        return values.AllKeys.Where(key => key != null).Order(StringComparer.Ordinal)
            .Select(key => new { key, value = values[key!] }).ToArray();
    }
}
