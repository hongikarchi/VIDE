using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Eto.Drawing;
using Eto.Forms;
using Rhino;
using Rhino.Commands;

namespace Vide.Worker;

[Guid("8DA24AEC-7527-4D6E-9D67-B6F9B8D2C1B8")]
public sealed class ConnectionPanel : Panel
{
    private readonly uint serial;
    private readonly Label documentName = new();
    private readonly Label status = new();
    private readonly Label lastRead = new();
    private readonly Label notice = new() { Wrap = WrapMode.Word };
    private readonly Button connect = new() { Text = "연결" };
    private readonly Button sync = new() { Text = "지금 Sync" };
    private readonly Button live = new() { Text = "Live Sync 켜기" };
    private readonly UITimer timer = new() { Interval = 1 };
    private AttachedConnection? Connection => AttachedConnection.Current?.DocumentId == serial ? AttachedConnection.Current : null;

    public ConnectionPanel(uint documentSerialNumber)
    {
        serial = documentSerialNumber;
        var open = new Button { Text = "VIDE 열기 / 인증 복구" };
        connect.Click += (_, _) => Act(() => {
            if (Connection is { } current) { current.Dispose(); AttachedConnection.Current = null; }
            else AttachedConnection.Connect(RhinoDoc.FromRuntimeSerialNumber(serial) ?? throw new InvalidOperationException("문서가 닫혔습니다."));
        });
        sync.Click += (_, _) => Act(() => {
            Connection?.Sync();
            notice.Text = "Sync를 요청했습니다. VIDE에서 이 문서를 선택한 상태로 열어 두세요.";
        });
        live.Click += (_, _) => Act(() => { Connection?.ToggleLive(); });
        open.Click += (_, _) => Act(() => {
            var filename = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VIDE", "launch.json");
            using var launch = JsonDocument.Parse(File.ReadAllText(filename));
            var uri = new Uri(launch.RootElement.GetProperty("url").GetString()!);
            if (uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.UserInfo.Length != 0)
                throw new InvalidOperationException("VIDE 로컬 실행 주소를 확인할 수 없습니다.");
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            notice.Text = "현재 VIDE 실행 주소로 브라우저를 열었습니다.";
        });
        var layout = new DynamicLayout { Padding = new Padding(12), Spacing = new Size(8, 10) };
        layout.AddRow(new Label { Text = "VIDE · Rhino 연결" });
        layout.AddRow(documentName);
        layout.AddRow(status);
        layout.AddRow(connect);
        layout.AddRow(sync);
        layout.AddRow(live);
        layout.AddRow(lastRead);
        layout.AddRow(open);
        layout.AddRow(notice);
        layout.AddRow(new Label { Text = "프로젝트 선택과 AI 요청은 VIDE에서 진행합니다. Rhino 파일 저장은 별도입니다.", Wrap = WrapMode.Word });
        layout.Add(null);
        Content = layout;
        timer.Elapsed += (_, _) => RefreshState();
        Load += (_, _) => { RefreshState(); timer.Start(); };
        UnLoad += (_, _) => timer.Stop();
        RefreshState();
    }

    private void Act(Action action)
    {
        try { notice.Text = ""; action(); }
        catch (FileNotFoundException) { notice.Text = "VIDE 로컬 서버를 먼저 실행하세요."; }
        catch (Exception error) { notice.Text = error.Message; }
        RefreshState();
    }

    private void RefreshState()
    {
        var doc = RhinoDoc.FromRuntimeSerialNumber(serial);
        var connection = Connection;
        documentName.Text = doc?.Name ?? "제목 없는 문서";
        status.Text = doc == null ? "문서 닫힘" : connection == null ? "연결 안 됨" : "Rhino 연결됨";
        connect.Text = connection == null ? "연결" : "연결 해제";
        connect.Enabled = doc != null;
        sync.Enabled = live.Enabled = connection != null && RhinoApp.InCommand == 0;
        live.Text = connection?.Live == true ? "Live Sync 끄기" : "Live Sync 켜기";
        lastRead.Text = connection?.LastDisplayRead is DateTime time ? "마지막 모델 조회 " + time.ToString("HH:mm:ss") : "아직 모델 조회 없음";
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
