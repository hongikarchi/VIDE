using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool noBrowser = Array.IndexOf(args, "--no-browser") >= 0;
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string node = Path.Combine(root, "runtime", "node.exe");
            string main = Path.Combine(root, "app", "src", "server", "main.mjs");
            if (!File.Exists(node) || !File.Exists(main)) throw new IOException("Incomplete package");
            var start = new ProcessStartInfo(node, "\"" + main + "\" --open --quiet" + (noBrowser ? " --no-browser" : ""));
            start.WorkingDirectory = Path.Combine(root, "app");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.EnvironmentVariables.Remove("NODE_OPTIONS");
            start.EnvironmentVariables.Remove("NODE_PATH");
            using (var process = Process.Start(start))
            {
                if (process.WaitForExit(1500) && process.ExitCode != 0) throw new IOException("Startup failed");
            }
            return 0;
        }
        catch
        {
            if (!noBrowser) MessageBox.Show("VIDE를 시작하지 못했습니다. 압축을 모두 풀었는지 확인하고, 사용자 데이터 폴더의 startup-error.json을 확인하세요.", "VIDE", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
