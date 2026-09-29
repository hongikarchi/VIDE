using System.Runtime.InteropServices;
using Eto.Drawing;
using Eto.Forms;
using Rhino;
using Rhino.Commands;

namespace Vide.Worker;

// The panel shows VIDE's panel page (Design SCR-12) in a web view: document, connection, Sync and
// Live Sync, the work and the composer are all on that page. The page asks for plugin actions with
// "vide://<action>" navigations (Link dialog, Unlink, Live, reload, open VIDE), handled here.
[Guid("8DA24AEC-7527-4D6E-9D67-B6F9B8D2C1B8")]
public sealed class ConnectionPanel : Panel
{
    private readonly uint serial;
    private readonly UITimer timer = new() { Interval = 1 };
    private readonly WebView? web;
    private readonly Label fallback = new() { Wrap = WrapMode.Word };
    private string loaded = "";
    private AttachedConnection? Connection => AttachedConnection.Current?.DocumentId == serial ? AttachedConnection.Current : null;

    public ConnectionPanel(uint documentSerialNumber)
    {
        serial = documentSerialNumber;
        try
        {
            web = new WebView { BrowserContextMenuEnabled = false };
            web.DocumentLoading += (_, e) =>
            {
                var action = Vide.HostPanel.PanelPage.Action(e.Uri);
                if (action == null) return;
                e.Cancel = true;
                Application.Instance.AsyncInvoke(() => Run(action));
            };
            Content = web;
        }
        catch (Exception error)
        {
            fallback.Text = "이 Rhino에서 웹 패널을 열 수 없습니다(" + error.Message + "). 명령 VIDELink로 연결하고 VIDE 창에서 작업하세요.";
            Content = new Scrollable { Content = fallback, Padding = new Padding(12) };
        }
        timer.Elapsed += (_, _) => RefreshState();
        Load += (_, _) => { RefreshState(); timer.Start(); };
        UnLoad += (_, _) => timer.Stop();
        RefreshState();
    }

    /// <summary>An action the panel page asked for.</summary>
    private void Run(string action)
    {
        try
        {
            var doc = RhinoDoc.FromRuntimeSerialNumber(serial) ?? throw new InvalidOperationException("문서가 닫혔습니다.");
            switch (action)
            {
                case "link": EngineLink.LinkDocument(doc); break;
                case "unlink":
                    if (Connection is { } current) { current.Dispose(); AttachedConnection.Current = null; }
                    break;
                case "live": Connection?.ToggleLive(); break;
                case "open-vide": Vide.HostPanel.PanelPage.OpenVide(); break;
                case "reload": break;
            }
        }
        catch (Exception error) { MessageBox.Show(this, error.Message, "VIDE"); }
        // Link, Unlink and reload change which page the panel shows.
        if (action is "link" or "unlink" or "reload") loaded = "";
        RefreshState();
    }

    private static bool Dark()
    {
        var color = SystemColors.ControlBackground;
        return color.R * 0.299 + color.G * 0.587 + color.B * 0.114 < 128;
    }

    private void RefreshState()
    {
        if (web == null) return;
        var doc = RhinoDoc.FromRuntimeSerialNumber(serial);
        var connection = Connection;
        var launch = Vide.HostPanel.PanelPage.LaunchUrl();
        var dark = Dark();
        var target = launch == null
            ? "about:vide-offline"
            : Vide.HostPanel.PanelPage.Url(launch, "rhino", doc?.Name ?? "", connection?.Instance, connection?.DocumentId ?? 0, connection?.LinkedProject?.Id, dark);
        if (target == loaded) return;
        loaded = target;
        if (launch == null) web.LoadHtml(Vide.HostPanel.PanelPage.Offline(dark));
        else web.Url = new Uri(target);
    }
}

public sealed class PanelCommand : Rhino.Commands.Command
{
    public override string EnglishName => "VIDEPanel";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        Rhino.UI.Panels.OpenPanel(typeof(ConnectionPanel), true);
        return Result.Success;
    }
}
