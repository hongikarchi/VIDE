using System;
using System.Threading;
using System.Windows.Forms;
using Velopack;

namespace Vide.Desktop
{
    // VIDE PC program: runs the local work engine and shows it in its own window, stays in the
    // tray (optional), starts with Windows (optional) and updates itself (Velopack).
    internal static class Program
    {
        private const string MutexName = @"Local\VIDE.Desktop";
        internal const string ShowEventName = @"Local\VIDE.Desktop.Show";
        internal const string QuitEventName = @"Local\VIDE.Desktop.Quit";

        [STAThread]
        private static int Main(string[] args)
        {
            // Install/uninstall/update hooks run here and exit before the app starts. A downloaded
            // update is applied at startup only when no VIDE is running: applying it kills the
            // running VIDE and its engine without a clean stop (RESEARCH-13 §1.3). The running
            // one applies it from the tray or when it exits.
            bool running = Mutex.TryOpenExisting(MutexName, out Mutex existing);
            existing?.Dispose();
            VelopackApp.Build().SetAutoApplyOnStartup(!running).Run();
            bool background = Array.IndexOf(args, "--background") >= 0;
            using (var mutex = new Mutex(true, MutexName, out bool first))
            {
                if (!first)
                {
                    // Already running: bring its window forward (or ask it to quit) instead of a
                    // second engine.
                    try
                    {
                        string name = Array.IndexOf(args, "--quit") >= 0 ? QuitEventName : ShowEventName;
                        using (var signal = EventWaitHandle.OpenExisting(name)) signal.Set();
                    }
                    catch (WaitHandleCannotBeOpenedException)
                    {
                        /* The first instance is still starting. */
                    }
                    return 0;
                }
                if (Array.IndexOf(args, "--quit") >= 0) return 0;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var context = new ShellContext(background))
                    Application.Run(context);
                GC.KeepAlive(mutex);
                return 0;
            }
        }
    }
}
