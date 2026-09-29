using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Eto.Drawing;
using Eto.Forms;
using Rhino;
using Rhino.Commands;

namespace Vide.Worker;

// The panel hosts VIDE's own chat column (panel mode) in a WebView, so Rhino and the browser share
// one UI, one request history and one server. Native controls only own the document connection.
[Guid("8DA24AEC-7527-4D6E-9D67-B6F9B8D2C1B8")]
public sealed class ConnectionPanel : Panel
{
    private readonly uint serial;
    private readonly Label status = new() { VerticalAlignment = VerticalAlignment.Center };
    private readonly Button connect = new() { Text = "Link" };
    private readonly Button live = new() { Text = "Live" };
    private readonly Button sync = new() { Text = "Sync", ToolTip = "지금 VIDE로 Sync" };
    private readonly Button reload = new() { Text = "⟳", ToolTip = "VIDE 다시 불러오기" };
    private readonly UITimer timer = new() { Interval = 1 };
    private readonly WebView? web;
    private readonly Label fallback = new() { Wrap = WrapMode.Word };
    private string loaded = "";
    private AttachedConnection? Connection => AttachedConnection.Current?.DocumentId == serial ? AttachedConnection.Current : null;

    public ConnectionPanel(uint documentSerialNumber)
    {
        serial = documentSerialNumber;
        // Link: choose a VIDE project and link this document; Unlink ends this window's connection only.
        connect.Click += (_, _) => Act(() => {
            if (Connection is { } current) { current.Dispose(); AttachedConnection.Current = null; }
            else EngineLink.LinkDocument(RhinoDoc.FromRuntimeSerialNumber(serial) ?? throw new InvalidOperationException("문서가 닫혔습니다."));
        });
        live.Click += (_, _) => Act(() => Connection?.ToggleLive());
        sync.Click += (_, _) => Act(() => Connection?.Sync());
        reload.Click += (_, _) => { loaded = ""; RefreshState(); };
        Control body;
        try
        {
            web = new WebView { BrowserContextMenuEnabled = false };
            body = web;
        }
        catch (Exception error)
        {
            fallback.Text = "이 Rhino에서 웹 패널을 열 수 없습니다(" + error.Message + "). VIDE 브라우저 화면을 사용하세요.";
            body = fallback;
        }
        var bar = new TableLayout
        {
            Padding = new Padding(8, 6),
            Spacing = new Size(4, 0),
            Rows = { new TableRow(new TableCell(status, true), connect, live, sync, reload) },
        };
        Content = new TableLayout { Rows = { bar, new TableRow(new TableCell(body, true)) { ScaleHeight = true } } };
        timer.Elapsed += (_, _) => RefreshState();
        Load += (_, _) => { RefreshState(); timer.Start(); };
        UnLoad += (_, _) => timer.Stop();
        RefreshState();
    }

    private void Act(Action action)
    {
        try { action(); }
        catch (Exception error) { fallback.Text = error.Message; MessageBox.Show(this, error.Message, "VIDE"); }
        RefreshState();
    }

    private static bool Dark()
    {
        var color = SystemColors.ControlBackground;
        return color.R * 0.299 + color.G * 0.587 + color.B * 0.114 < 128;
    }

    private static string? LaunchUrl()
    {
        try
        {
            var filename = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VIDE", "launch.json");
            using var launch = JsonDocument.Parse(File.ReadAllText(filename));
            var uri = new Uri(launch.RootElement.GetProperty("url").GetString()!);
            return uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.UserInfo.Length == 0 ? uri.AbsoluteUri : null;
        }
        catch { return null; }
    }

    private void RefreshState()
    {
        var doc = RhinoDoc.FromRuntimeSerialNumber(serial);
        var connection = Connection;
        status.Text = (doc?.Name ?? "제목 없는 문서") + (connection == null ? "  ○ 연결 안 됨" : (connection.Live ? "  ● Live Sync" : "  ● 연결됨") + (connection.LinkedProject is { } linked ? " · " + linked.Name : ""));
        connect.Text = connection == null ? "Link" : "Unlink";
        connect.Enabled = doc != null;
        live.Enabled = connection != null;
        sync.Enabled = connection != null;
        live.Text = connection?.Live == true ? "Live 끄기" : "Live 켜기";
        if (web == null) return;
        var launch = LaunchUrl();
        string target;
        if (launch == null) target = "about:vide-offline";
        else if (connection == null) target = "about:vide-disconnected";
        else
        {
            var uri = new Uri(launch);
            var project = connection.LinkedProject is { } chosen ? "&project=" + Uri.EscapeDataString(chosen.Id) : "";
            target = $"{uri.GetLeftPart(UriPartial.Path)}?panel=rhino{project}&instance={Uri.EscapeDataString(connection.Instance)}&document={connection.DocumentId}&theme={(Dark() ? "dark" : "light")}{uri.Fragment}";
        }
        if (target == loaded) return;
        loaded = target;
        if (target.StartsWith("about:"))
            web.LoadHtml(Placeholder(target == "about:vide-offline"
                ? "VIDE가 실행되고 있지 않습니다. VIDE를 실행한 뒤 ⟳를 누르세요."
                : "위의 <b>Link</b>를 누르고 VIDE 프로젝트를 고르면 이 문서가 연결되어 바로 Sync되고, VIDE 작업이 여기에 열립니다."));
        else web.Url = new Uri(target);
    }

    private static string Placeholder(string text)
    {
        var dark = Dark();
        return $"<html><body style=\"margin:0;display:grid;place-items:center;height:100vh;font:12px 'Pretendard','Malgun Gothic',sans-serif;background:{(dark ? "#1f2322" : "#ffffff")};color:{(dark ? "#aab3ae" : "#737b7d")}\"><div style=\"text-align:center;padding:24px\"><div style=\"font-size:34px;font-weight:600;color:{(dark ? "#3a4240" : "#cbd1cc")}\">V<span style=\"color:#d97660\">.</span></div><p>{text}</p></div></body></html>";
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
