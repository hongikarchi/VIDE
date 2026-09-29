using System;
using System.Diagnostics;
using System.IO;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Windows.Forms;
using ZwSoft.ZwCAD.Runtime;
using ZwSoft.ZwCAD.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Vide.HostPanel;
using Cad = ZwSoft.ZwCAD.ApplicationServices.Application;

[assembly: ExtensionApplication(typeof(Vide.Zwcad.Connection.ConnectionStartup))]
namespace Vide.Zwcad.Connection
{
    /// <summary>Loaded at ZWCAD startup ("연결 프로그램" install): open the VIDE CAD panel once.</summary>
    public sealed class ConnectionStartup : IExtensionApplication
    {
        public void Initialize() { Cad.Idle += ShowOnce; }
        private static void ShowOnce(object sender, EventArgs e)
        {
            Cad.Idle -= ShowOnce;
            try { new ConnectionCommands().Show(); } catch { /* No UI yet; VIDECADPANEL opens it. */ }
        }
        public void Terminate() { }
    }

    public sealed class ConnectionCommands
    {
        private static PaletteSet palette;
        /// <summary>Link: connect this drawing, choose a VIDE project, and VIDE syncs it at once.</summary>
        [CommandMethod("VIDECADLink", CommandFlags.Session)]
        public void Link() { Show(); EngineLink.LinkDocument(Cad.DocumentManager.MdiActiveDocument, null); }
        /// <summary>Earlier name of Link; the same behaviour.</summary>
        [CommandMethod("VIDECADConnect", CommandFlags.Session)]
        public void Connect() => Link();
        [CommandMethod("VIDECADDisconnect", CommandFlags.Session)]
        public void Disconnect() { AttachedDocument connection; if (AttachedDocument.Connections.TryGetValue(Cad.DocumentManager.MdiActiveDocument, out connection)) connection.Dispose(); }
        [CommandMethod("VIDECADSync", CommandFlags.Session)]
        public void Sync() { AttachedDocument.Connect(Cad.DocumentManager.MdiActiveDocument).Sync(); }
        [CommandMethod("VIDECADLiveSync", CommandFlags.Session)]
        public void Live() { var connection = AttachedDocument.Connect(Cad.DocumentManager.MdiActiveDocument); connection.Live = !connection.Live; if (connection.Live) connection.Sync(); Show(); }
        [CommandMethod("VIDECADPanel", CommandFlags.Session)]
        public void Show()
        {
            if (palette == null) {
                palette = new PaletteSet("VIDE CAD", new Guid("7393E7C2-156D-46DB-8898-B8DF5F1BBBD6"));
                palette.MinimumSize = new System.Drawing.Size(300, 420);
                palette.Size = new System.Drawing.Size(380, 760);
                palette.Add("연결", new ConnectionView());
            }
            palette.Visible = true;
        }
    }
    /// <summary>
    /// The palette shows VIDE's panel page (Design SCR-12) for the active drawing in WebView2: the
    /// drawing, its connection, Sync, Live Sync, the work and the composer are on that page. The page
    /// asks for plugin actions with "vide://action" navigations (Link dialog, Unlink, Live, reload,
    /// open VIDE), handled here.
    /// </summary>
    internal sealed class ConnectionView : UserControl
    {
        private readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        private readonly Label fallback = new Label { Dock = DockStyle.Fill, Padding = new Padding(12), Visible = false };
        private readonly Timer timer = new Timer { Interval = 1000 };
        private bool ready;
        private string loaded = "";
        internal ConnectionView()
        {
            Dock = DockStyle.Fill;
            Controls.Add(web);
            Controls.Add(fallback);
            timer.Tick += (_, __) => RefreshState();
            Start();
        }
        private async void Start()
        {
            try
            {
                // The WebView2 loader ships next to this plugin; its data stays in VIDE's folder.
                var folder = Path.GetDirectoryName(typeof(ConnectionView).Assembly.Location);
                var native = Path.Combine(folder, "runtimes", "win-x64", "native");
                CoreWebView2Environment.SetLoaderDllFolderPath(
                    File.Exists(Path.Combine(folder, "WebView2Loader.dll")) ? folder : native);
                var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VIDE", "webview-zwcad");
                var environment = await CoreWebView2Environment.CreateAsync(null, data);
                await web.EnsureCoreWebView2Async(environment);
                web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                web.CoreWebView2.NavigationStarting += (_, e) =>
                {
                    Uri uri;
                    var action = Uri.TryCreate(e.Uri, UriKind.Absolute, out uri) ? PanelPage.Action(uri) : null;
                    if (action == null) return;
                    e.Cancel = true;
                    BeginInvoke((Action)(() => Run(action)));
                };
                ready = true;
                RefreshState();
                timer.Start();
            }
            catch (System.Exception error)
            {
                web.Visible = false;
                fallback.Visible = true;
                fallback.Text = "이 PC에서 웹 패널을 열 수 없습니다(" + error.Message + "). 명령 VIDECADLink로 연결하고 VIDE 창에서 작업하세요.";
            }
        }
        /// <summary>An action the panel page asked for.</summary>
        private void Run(string action)
        {
            try
            {
                var doc = Cad.DocumentManager.MdiActiveDocument;
                AttachedDocument connection = null;
                if (doc != null) AttachedDocument.Connections.TryGetValue(doc, out connection);
                switch (action)
                {
                    case "link":
                        if (doc == null) throw new InvalidOperationException("열린 도면이 없습니다.");
                        EngineLink.LinkDocument(doc, () => { loaded = ""; RefreshState(); });
                        break;
                    case "unlink": if (connection != null) connection.Dispose(); break;
                    case "live":
                        if (connection != null) { connection.Live = !connection.Live; if (connection.Live) connection.Sync(); }
                        break;
                    case "open-vide": PanelPage.OpenVide(); break;
                }
            }
            catch (System.Exception error) { MessageBox.Show(this, error.Message, "VIDE"); }
            if (action == "link" || action == "unlink" || action == "reload") loaded = "";
            RefreshState();
        }
        private bool Dark()
        {
            var color = BackColor;
            return color.R * 0.299 + color.G * 0.587 + color.B * 0.114 < 128;
        }
        private void RefreshState()
        {
            if (!ready) return;
            var doc = Cad.DocumentManager.MdiActiveDocument;
            AttachedDocument connection = null;
            if (doc != null) AttachedDocument.Connections.TryGetValue(doc, out connection);
            var launch = PanelPage.LaunchUrl();
            var dark = Dark();
            var target = launch == null
                ? "about:vide-offline"
                : PanelPage.Url(launch, "zwcad", doc == null ? "" : Path.GetFileName(doc.Name), connection?.Instance, 1, connection?.LinkedProject?.Id, dark);
            if (target == loaded) return;
            loaded = target;
            if (launch == null) web.CoreWebView2.NavigateToString(PanelPage.Offline(dark));
            else web.CoreWebView2.Navigate(target);
        }
        protected override void Dispose(bool disposing) { if (disposing) { timer.Dispose(); web.Dispose(); } base.Dispose(disposing); }
    }
}
