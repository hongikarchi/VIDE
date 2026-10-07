// ZWCAD 2023 members that end the whole process (a native access violation, no managed
// exception) on some drawings, and the safe way the worker reads the same information instead
// (PLAN-47 T-226, T-225 질문 4 extends the list). Worker and connection code never read the members
// in `Avoided`; tests/core/drawing-output.test.mjs checks the sources for them.
using ZwSoft.ZwCAD.DatabaseServices;

namespace Vide.Zwcad
{
    internal static class SafeRead
    {
        /** Type.Member names the worker does not read (SPIKE-2026-10-07-drawing-export 「한계」). */
        internal static readonly string[] Avoided =
        {
            // Rhino-exported dimensions: access violation in ZwDatabase.dll (0xC0000005).
            "Dimension.TextStyleId",
        };

        /** A dimension's text style name through its dimension style's DIMTXSTY, or null. */
        internal static string DimensionTextStyle(Transaction tr, Dimension dimension)
        {
            try
            {
                var style = tr.GetObject(dimension.DimensionStyle, OpenMode.ForRead) as DimStyleTableRecord;
                if (style == null || style.Dimtxsty.IsNull) return null;
                return (tr.GetObject(style.Dimtxsty, OpenMode.ForRead) as TextStyleTableRecord)?.Name;
            }
            catch (System.Exception) { return null; }
        }
    }
}
