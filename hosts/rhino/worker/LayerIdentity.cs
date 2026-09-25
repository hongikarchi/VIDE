using System.Text.Json;
using Rhino.DocObjects;

namespace Vide.Worker;

internal static class LayerIdentity
{
    internal static string Signature(IEnumerable<Layer> layers) => JsonSerializer.Serialize(
        layers.Where(layer => !layer.IsDeleted).OrderBy(layer => layer.Id).Select(layer => new
        {
            layer.Id, layer.Name, layer.ParentLayerId,
            color = layer.Color.ToArgb(), layer.IsVisible, layer.IsLocked,
            layer.PlotWeight, plotColor = layer.PlotColor.ToArgb(),
            layer.LinetypeIndex, layer.RenderMaterialIndex,
            strings = Strings(layer)
        }));

    private static object Strings(Layer layer)
    {
        var values = layer.GetUserStrings();
        return values.AllKeys.Where(key => key != null).Order(StringComparer.Ordinal)
            .Select(key => new { key, value = values[key!] }).ToArray();
    }
}
