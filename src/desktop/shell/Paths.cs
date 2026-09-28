using System;
using System.IO;
using System.Reflection;

namespace Vide.Desktop
{
    internal static class Paths
    {
        /// <summary>Installed program folder (Velopack "current"): VIDE.exe, runtime\, app\.</summary>
        public static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;

        /// <summary>
        /// What Windows should start (autostart): the installation's fixed launcher stub
        /// (VIDE.App\VIDE.exe, stable across updates), else this executable.
        /// </summary>
        public static string Launcher
        {
            get
            {
                string current = Root.TrimEnd(Path.DirectorySeparatorChar);
                string stub = Path.Combine(Path.GetDirectoryName(current) ?? current, "VIDE.exe");
                return Path.GetFileName(current).Equals("current", StringComparison.OrdinalIgnoreCase) && File.Exists(stub)
                    ? stub
                    : System.Windows.Forms.Application.ExecutablePath;
            }
        }

        /// <summary>User data; never touched by install, update or uninstall.</summary>
        public static readonly string Data = Environment.GetEnvironmentVariable("VIDE_DATA_DIR") is string custom && custom.Length > 0
            ? Path.GetFullPath(custom)
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VIDE");

        /// <summary>Bundled Node runtime; a build run from source uses node on PATH.</summary>
        public static string Node => File.Exists(Path.Combine(Root, "runtime", "node.exe")) ? Path.Combine(Root, "runtime", "node.exe") : "node";

        /// <summary>The engine sources: bundled app\, or VIDE_DESKTOP_APP (a repository checkout) in development.</summary>
        public static string App => Environment.GetEnvironmentVariable("VIDE_DESKTOP_APP") is string app && app.Length > 0 ? app : Path.Combine(Root, "app");

        public static string Version
        {
            get
            {
                var info = Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>();
                string value = info?.InformationalVersion ?? "0.0.0";
                int plus = value.IndexOf('+');
                return plus >= 0 ? value.Substring(0, plus) : value;
            }
        }
    }
}
