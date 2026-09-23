using System;
using System.IO;
using ZwSoft.ZwCAD.ApplicationServices;
using ZwSoft.ZwCAD.Runtime;

// Test-only assembly, never included in the desktop package.
public sealed class ZwcadNativeCommands : IExtensionApplication
{
    public void Initialize() { Application.Idle += Run; }
    public void Terminate() { Application.Idle -= Run; }
    private void Run(object sender, EventArgs args)
    {
        string folder = Environment.GetEnvironmentVariable("VIDE_WORKER_DIRECTORY");
        if (String.IsNullOrEmpty(folder) || !File.Exists(Path.Combine(folder, "ready.json"))) return;
        var doc = Application.DocumentManager.MdiActiveDocument;
        if (doc == null || !String.Equals(doc.Name, Path.Combine(folder, "editing.dwg"), StringComparison.OrdinalIgnoreCase)) return;
        Application.Idle -= Run;
        string script = Path.Combine(folder, "commands.lsp").Replace('\\', '/');
        string suffix = File.Exists(Path.Combine(folder, "close.flag")) ? "_CLOSE\n" : "";
        doc.SendStringToExecute("(load \"" + script + "\")\n" + suffix, true, false, false);
    }
}
