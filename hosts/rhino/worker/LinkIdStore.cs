using Rhino;

namespace Vide.Worker;

// ADR-030: the VIDE link id is kept in the document itself (document user text, section "VIDE",
// entry "link:<projectId>"), so Save As, a moved or renamed file and a restart keep the link. This
// is the one value the plugin writes into a user's document; writing it marks the document
// modified once and the user's next save keeps it.
internal static class LinkIdStore
{
    private const string Section = "VIDE";
    private const string Prefix = "link:";

    internal static string? Read(RhinoDoc doc, string projectId)
    {
        var value = doc.Strings.GetValue(Section, Prefix + projectId);
        return string.IsNullOrEmpty(value) ? null : value;
    }

    /// <summary>Every stored link id (one per VIDE project the document was linked to).</summary>
    internal static string[] All(RhinoDoc doc) =>
        (doc.Strings.GetEntryNames(Section) ?? [])
            .Where(entry => entry.StartsWith(Prefix, StringComparison.Ordinal))
            .Select(entry => doc.Strings.GetValue(Section, entry))
            .Where(value => !string.IsNullOrEmpty(value) && value.Length <= 100)
            .Take(50)
            .ToArray();

    /// <summary>Stores the id; false when the document already holds it (nothing is modified).</summary>
    internal static bool Write(RhinoDoc doc, string projectId, string linkId)
    {
        if (Read(doc, projectId) == linkId) return false;
        doc.Strings.SetString(Section, Prefix + projectId, linkId);
        return true;
    }
}
