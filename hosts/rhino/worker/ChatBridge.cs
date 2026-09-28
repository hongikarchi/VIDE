using System.Text.Json;

namespace Vide.Worker;

// Rhino panel chat. Messages stay in this Rhino process until the open VIDE workspace collects them
// through the authenticated attached connection; VIDE then submits them as ordinary chat requests.
internal static class ChatBridge
{
    internal sealed record Outgoing(string id, string body, string model, string effort, string permission, string[] pinIds, string createdAt)
    {
        internal uint DocumentId { get; init; }
        internal bool Delivered { get; set; }
    }
    private static readonly object gate = new();
    private static readonly List<Outgoing> outbox = new();
    private static JsonElement? state;
    internal static DateTime? StateAt { get; private set; }
    internal static int Version { get; private set; }

    internal static void Enqueue(Outgoing message)
    {
        lock (gate) { outbox.Add(message); if (outbox.Count > 50) outbox.RemoveAt(0); Version++; }
    }
    internal static Outgoing[] Pending(uint documentId)
    {
        lock (gate) return outbox.Where(m => m.DocumentId == documentId).ToArray();
    }
    internal static JsonElement? State { get { lock (gate) return state; } }

    internal static object Exchange(uint documentId, JsonElement request)
    {
        lock (gate)
        {
            if (request.TryGetProperty("ack", out var ack) && ack.ValueKind == JsonValueKind.Array)
            {
                var ids = ack.EnumerateArray().Select(a => a.GetString()).ToHashSet();
                // Keep delivered messages until VIDE's history shows them, then the panel stops echoing.
                foreach (var message in outbox.Where(m => ids.Contains(m.id))) message.Delivered = true;
                outbox.RemoveAll(m => m.Delivered && Recent().Contains(m.id));
            }
            if (request.TryGetProperty("state", out var next) && next.ValueKind == JsonValueKind.Object)
            {
                state = next.Clone();
                StateAt = DateTime.UtcNow;
                outbox.RemoveAll(m => m.Delivered && Recent().Contains(m.id));
            }
            Version++;
            return new
            {
                ok = true,
                outbox = outbox.Where(m => m.DocumentId == documentId && !m.Delivered)
                    .Select(m => new { m.id, m.body, m.model, m.effort, m.permission, m.pinIds, m.createdAt }).ToArray()
            };
        }
    }
    private static HashSet<string?> Recent()
    {
        var ids = new HashSet<string?>();
        if (state is { } value && value.TryGetProperty("recent", out var recent) && recent.ValueKind == JsonValueKind.Array)
            foreach (var item in recent.EnumerateArray())
                if (item.TryGetProperty("id", out var id)) ids.Add(id.GetString());
        return ids;
    }
}
