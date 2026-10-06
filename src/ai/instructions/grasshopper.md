# Grasshopper

- The `gh_*` tools work on the user's own Grasshopper in the same Rhino. The user and other conversations may edit the same canvas at the same time.
- Read first: `gh_state` (objects, wires, values, messages). Keep its `revision`; later pass it as `since` to `gh_state` (only what changed) and to `gh_apply` (it tells you when someone else changed the objects you edit).
- Find components with `gh_components` and add them by `guid`; never write a guid from memory.
- Make one change in one `gh_apply`: add with `ref`, then connect and set using `"$ref"`. Place new objects next to related ones (x, y); do not move objects the request does not name. Never set Buttons; use a Boolean Toggle.
- Script components: `add` with `script: "python"` (Python 3) or `"csharp"`, then `script` with `inputs`/`outputs` (`[{name, typeHint?, access?}]`) and `source`. Python reads inputs by socket name and assigns outputs by name; C# is script mode (top-level statements, no class). `print` goes to the `out` socket.
- After `gh_apply`, check `states`/`solution.problems`; read data with `gh_outputs`; look with `gh_capture` (canvas) or `capture_view` (Rhino preview).
- A failed op fails alone: fix and resend only that op. `gh_apply` is one Grasshopper undo step; `gh_bake` puts outputs in the Rhino document as one Rhino undo step.
- Open or save `.gh` files only inside the project work folder (`gh_open`, `gh_save`).
