// Python lines that attach the open Rhino document to VIDE without the Link dialog (PLAN-51 T-277).
// `_VIDEConnect` now opens the project-pick modal (AttachedConnection → EngineLink.LinkDocument →
// ProjectDialog), which blocks an unattended test Rhino. This calls the plugin's internal
// AttachedConnection.Connect(doc) by reflection instead: it writes the connection record only; an
// engine links the document itself through POST /links when it needs one.
// Used by tools/ab/host-session.mjs and tests/integration/rhino-sync-perf.mjs, rhino-attached.mjs,
// rhino-attached-ai.mjs and linked-open-compare.mjs.

/**
 * The IronPython lines (no trailing newline). `doc` is the variable holding the RhinoDoc, `indent`
 * the prefix of every line (the caller's block level). The script must `import System`.
 */
export function connectScriptLines({ doc = 'doc', indent = '    ' } = {}) {
  return [
    "assembly=[a for a in System.AppDomain.CurrentDomain.GetAssemblies() if a.GetName().Name=='VIDE.Worker'][0]",
    "connect=assembly.GetType('Vide.Worker.AttachedConnection').GetMethod('Connect',System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic)",
    `connect.Invoke(None,System.Array[System.Object]([${doc}]))`,
  ]
    .map((line) => indent + line)
    .join('\n');
}
