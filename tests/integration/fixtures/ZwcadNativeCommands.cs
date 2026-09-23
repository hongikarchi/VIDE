using System;
using System.IO;
using ZwSoft.ZwCAD.ApplicationServices;
using ZwSoft.ZwCAD.Runtime;

// Test-only assembly, never included in the desktop package.
public sealed class ZwcadNativeCommands : IExtensionApplication
{
    private bool started;
    private DateTime readyAt = DateTime.MinValue;
    public void Initialize() { Application.Idle += Run; }
    public void Terminate() { Application.Idle -= Run; }
    private void Run(object sender, EventArgs args)
    {
        string folder = Environment.GetEnvironmentVariable("VIDE_WORKER_DIRECTORY");
        if (String.IsNullOrEmpty(folder) || !File.Exists(Path.Combine(folder, "ready.json"))) return;
        var doc = Application.DocumentManager.MdiActiveDocument;
        if (doc == null || !String.Equals(doc.Name, Path.Combine(folder, "editing.dwg"), StringComparison.OrdinalIgnoreCase)) return;
        if (readyAt == DateTime.MinValue) readyAt = DateTime.UtcNow;
        if (!started && (DateTime.UtcNow - readyAt).TotalSeconds < 3) return;
        if (started)
        {
            if (!File.Exists(Path.Combine(folder, "undo.flag"))) return;
            Application.Idle -= Run;
            string marker = Path.Combine(folder, "undo.done").Replace('\\', '/');
            doc.SendStringToExecute("_UNDO\n_BACK\n(setq f (open \"" + marker + "\" \"w\"))(close f)\n", true, false, false);
            return;
        }
        started = true;
        string suffix = File.Exists(Path.Combine(folder, "close.flag")) ? "_CLOSE\n" : "";
        doc.SendStringToExecute(File.ReadAllText(Path.Combine(folder, "commands.scr")) + suffix, true, false, false);
    }
}
