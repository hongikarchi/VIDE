# CAD (ZWCAD) know-how

## Where code runs
- `execute` code is the body of `object Run(Database db, Transaction tr)` with `using System; System.Linq; ZwSoft.ZwCAD.DatabaseServices; ZwSoft.ZwCAD.Geometry`. Only `System`, `System.Linq`, `System.Collections*` and `ZwSoft.ZwCAD.DatabaseServices`, `.Geometry` and `.Colors` are allowed. There is no Editor, no commands, no `SendStringToExecute`, and no file I/O.
- Never call `tr.Commit()`, `tr.Abort()` or `Dispose()`, and never call `db.SaveAs`, `ReadDwgFile` or DXF in/out. VIDE commits or aborts the transaction: a read run is always aborted, and a write run in an open drawing is committed as one undo step.
- Model space: `var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead); var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForWrite);`. A new entity needs `ms.AppendEntity(e)` and then `tr.AddNewlyCreatedDBObject(e, true)`. Open an existing entity `ForWrite` only when you change it.
- Return plain values (numbers, strings, arrays, anonymous objects) of at most 64 KB. SDK objects come back as text. A write run also reports the handles it added, modified and erased: read those handles back to check the result.
- Identity is the entity handle (hex string). Do not keep an `ObjectId` between runs.

## Units and coordinates
- `query` on an open drawing returns coordinates in drawing units, rounded to 4 decimals, and `units` is the `INSUNITS` name. Convert explicitly. Korean drawings are normally in millimetres (mm = m × 1000).
- A drawing that VIDE imported is shown in metres. VIDE reads `INSUNITS` 4 (mm), 5 (cm), 6 (m), 1 (inch) and 2 (foot); any other value is `UNKNOWN_UNITS`, so ask the user which unit applies instead of guessing.
- Plan geometry is 2D: z = 0 and normal +Z. A polyline has one elevation, and all of its vertices share that z.

## What VIDE reads and writes
- Rows from `query` on an open drawing carry handle, type, layer, colour index, linetype and extents, plus per type: Line start/end/length; Polyline closed/elevation/length and up to 200 vertices as [x, y, bulge]; Circle centre/radius; Arc centre/radius/angles in radians; DBText and MText text/position/height/rotation; BlockReference name/position/rotation/scale/attributes; Dimension measurement/text; Hatch pattern/area. Filter by handles, layers or types, and page through with `nextOffset` (at most 200 rows per page). One page is never the whole drawing.
- An imported DWG working copy supports only model-space `Line` and `LWPolyline` without bulges (arcs), with at most 500 entities, 1000 vertices each, and coordinates within 100 km. Anything else is `UNSUPPORTED_DWG_CONTENT`, so it is shown for reference only.
- A candidate can be edited only when the drawing is in mm, has no groups, and its entities have no XData or extension dictionaries, sit on unlocked layers, and have zero thickness and width. An edit keeps each entity's id `cad-<handle>` and its name `<layer> / <handle>`. A polyline is closed when its first and last points are equal.
- When a candidate is applied, only Line and Polyline in model space are compared by handle. Entities missing from the candidate are erased. The candidate's layers and linetypes must already exist in the drawing, so reuse existing layer names exactly and do not invent new layers or linetypes. Layer, linetype, colour, lineweight and linetype scale are copied.

## Drawing conventions
- Put new entities on an existing layer that matches their role (walls, columns, grid, dimensions). Layer names are often Korean: copy them exactly from `query`. Leave colour and linetype ByLayer (`ColorIndex` 256) unless the goal asks otherwise.
- Use `Polyline` with `Closed = true` for closed outlines rather than repeating the first vertex. Use `Line` for single segments. Keep bulges out of anything that goes back through a working copy.
- Geometry that comes from Rhino should be flattened to z = 0 and turned into lines and arcs, so the drawing does not get dense splines.
- Blocks, text, dimensions and hatches can be read on an open drawing. Change them only in an open drawing whose goal allows writing, and never through a working copy.
- Before you erase or redraw many entities, report the counts by layer and ask with a question card if the scope is unclear.

## Checking your work
- After a write, query the returned handles and compare the counts, lengths, closed flags and layers with what you meant to do. Report what differs and fix it in a new run. Never report success from the code alone.
