#nullable disable
using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;

namespace Vide.HostPanel
{
    /// <summary>
    /// The host panel page (Design SCR-12), shared by the Rhino panel and the ZWCAD palette: both
    /// show VIDE's panel mode in a web view. The page asks the plugin to act through "vide://action"
    /// navigations, which the plugin cancels and runs. Only the "VIDE is not running" page is local.
    /// </summary>
    internal static class PanelPage
    {
        internal const string Scheme = "vide";

        /// <summary>The running VIDE's local address from launch.json, or null.</summary>
        internal static string LaunchUrl()
        {
            try
            {
                var file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VIDE", "launch.json");
                var match = Regex.Match(File.ReadAllText(file), "\"url\"\\s*:\\s*\"([^\"]+)\"");
                if (!match.Success) return null;
                var uri = new Uri(match.Groups[1].Value);
                return uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.UserInfo.Length == 0 ? uri.AbsoluteUri : null;
            }
            catch { return null; }
        }

        /// <summary>The panel page for one document: linked (instance/document) or not yet (name only).</summary>
        internal static string Url(string launch, string host, string name, string instance, uint documentId, string projectId, bool dark)
        {
            var uri = new Uri(launch);
            var query = "?panel=" + host + "&name=" + Uri.EscapeDataString(name ?? "");
            if (instance != null)
                query += (projectId != null ? "&project=" + Uri.EscapeDataString(projectId) : "")
                    + "&instance=" + Uri.EscapeDataString(instance) + "&document=" + documentId;
            return uri.GetLeftPart(UriPartial.Path) + query + "&theme=" + (dark ? "dark" : "light") + uri.Fragment;
        }

        /// <summary>The action of a "vide://action" navigation, or null for ordinary pages.</summary>
        internal static string Action(Uri uri)
        {
            return uri != null && uri.Scheme == Scheme ? uri.Host.ToLowerInvariant() : null;
        }

        /// <summary>Show the VIDE window (starting VIDE when it is not running).</summary>
        internal static void OpenVide()
        {
            var app = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VIDE.App", "VIDE.exe");
            if (File.Exists(app)) { Process.Start(new ProcessStartInfo(app) { UseShellExecute = true }); return; }
            var launch = LaunchUrl();
            if (launch != null) Process.Start(new ProcessStartInfo(launch) { UseShellExecute = true });
        }

        /// <summary>Shown while VIDE is not running; the panel moves on by itself once it starts.</summary>
        internal static string Offline(bool dark)
        {
            var background = dark ? "#1f2322" : "#ffffff";
            var text = dark ? "#dde3df" : "#292c2d";
            var muted = dark ? "#8d9793" : "#737b7d";
            var card = dark ? "#262c2b" : "#f6f7f4";
            var line = dark ? "#333a38" : "#dde1de";
            return "<!doctype html><html><head><meta charset=\"utf-8\"></head><body style=\"margin:0;background:" + background + ";color:" + text
                + ";font:12px/1.55 'Pretendard','Malgun Gothic',sans-serif\"><section style=\"margin:16px 12px;padding:16px;border:1px solid " + line
                + ";border-radius:8px;background:" + card + ";display:grid;gap:8px;justify-items:start\"><strong style=\"font-size:14px\">VIDE가 실행되고 있지 않습니다</strong>"
                + "<p style=\"margin:0;color:" + muted + "\">VIDE를 실행하면 이 패널이 스스로 이어지고, 이 파일을 연결해 AI에게 작업을 맡길 수 있습니다.</p>"
                + "<a href=\"vide://open-vide\" style=\"padding:8px 14px;border-radius:6px;background:#2f5aa8;color:#fff;font-weight:600;text-decoration:none\">VIDE 실행</a>"
                + "</section></body></html>";
        }
    }
}
