// ZWCAD 2023 members that end the whole process (a native access violation, no managed
// exception) on some drawings, and the safe way the worker reads the same information instead
// (PLAN-47 T-226; T-225 질문 4 added seven, SPIKE-2026-10-07-drawing-backflow 결과 4). After such a
// read ZWCAD does not exit: it writes CrashReport\CR_*.zip and idles with CPU 0, so the hidden run's
// no-progress watch (hosts/zwcad/hidden-run.ts) stops it. Worker and connection code never read
// the members in `Avoided`; tests/core/drawing-output.test.mjs checks the sources for them.
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
            // ZWCAD-made rotated dimensions (synthetic, every time): arrowheads and centre marks.
            // Arrowheads are read from the dimension style record instead (DimensionArrows).
            "Dimension.Dimblks",
            "Dimension.Dimblk1s",
            "Dimension.Dimblk2s",
            "Dimension.Dimldrblks",
            "Dimension.CenterMarkType",
            "Dimension.CenterMarkSize",
            // A spline of a user drawing.
            "Curve.Spline",
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

        /** Name of an arrowhead block; "" is the default (closed filled), null an unreadable id. */
        static string ArrowName(Transaction tr, ObjectId id)
        {
            if (id.IsNull) return "";
            try { return (tr.GetObject(id, OpenMode.ForRead) as BlockTableRecord)?.Name ?? ""; }
            catch (System.Exception) { return null; }
        }

        /**
         * Arrowheads of a dimension style record: [first, second, leader] — DIMBLK for both ends, or
         * DIMBLK1/DIMBLK2 when DIMSAH is on, and DIMLDRBLK. The safe source of `Dimension.Dimblk*s`.
         */
        internal static string[] DimensionArrows(Transaction tr, DimStyleTableRecord style)
        {
            bool separate = false;
            try { separate = style.Dimsah; } catch (System.Exception) { }
            string both = ArrowName(tr, style.Dimblk);
            return new[]
            {
                separate ? ArrowName(tr, style.Dimblk1) : both,
                separate ? ArrowName(tr, style.Dimblk2) : both,
                ArrowName(tr, style.Dimldrblk),
            };
        }
    }
}
