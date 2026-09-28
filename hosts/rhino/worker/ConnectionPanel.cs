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
    private static readonly Color Accent = Color.FromArgb(0xD9, 0x76, 0x60);
    private static readonly Color Ok = Color.FromArgb(0x4F, 0x9A, 0x6A);
    private static readonly Color Muted = Color.FromArgb(0x8A, 0x92, 0x94);
    private static readonly Color Danger = Color.FromArgb(0xB5, 0x4A, 0x32);
    private static readonly Color Running = Color.FromArgb(0x3C, 0x6F, 0xD0);
    private readonly uint serial;
    private readonly Label documentName = new() { Font = SystemFonts.Bold(10) };
    private readonly Label status = new();
    private readonly Label viewState = new() { Wrap = WrapMode.Word, TextColor = Muted };
    private readonly Label notice = new() { Wrap = WrapMode.Word, TextColor = Danger };
    private readonly Button connect = new() { Text = "연결" };
    private readonly Button sync = new() { Text = "Sync" };
    private readonly Button live = new() { Text = "Live" };
    private readonly StackLayout history = new() { Orientation = Orientation.Vertical, Spacing = 6, HorizontalContentAlignment = HorizontalAlignment.Stretch };
    private readonly Scrollable scroll;
    private readonly TextArea input = new() { Height = 72, Wrap = true, AcceptsTab = false, SpellCheck = false };
    private readonly DropDown model = new();
    private readonly DropDown effort = new();
    private readonly DropDown permission = new();
    private readonly Button send = new() { Text = "보내기  ⏎" };
    private readonly Label pins = new() { TextColor = Muted };
    private readonly Button pinSelection = new() { Text = "선택 고정" };
    private readonly Button clearPins = new() { Text = "해제" };
    private readonly UITimer timer = new() { Interval = 0.7 };
    private readonly List<Guid> pinned = new();
    private string historySignature = "";
    private string modelSignature = "";
    private AttachedConnection? Connection => AttachedConnection.Current?.DocumentId == serial ? AttachedConnection.Current : null;

    public ConnectionPanel(uint documentSerialNumber)
    {
        serial = documentSerialNumber;
        var open = new Button { Text = "VIDE 열기" };
        connect.Click += (_, _) => Act(() => {
            if (Connection is { } current) { current.Dispose(); AttachedConnection.Current = null; }
            else AttachedConnection.Connect(Document());
        });
        sync.Click += (_, _) => Act(() => Connection?.Sync());
        live.Click += (_, _) => Act(() => Connection?.ToggleLive());
        open.Click += (_, _) => Act(OpenVide);
        pinSelection.Click += (_, _) => Act(() => {
            var selected = Document().Objects.GetSelectedObjects(false, false).Select(o => o.Id).ToList();
            if (selected.Count == 0) throw new InvalidOperationException("Rhino에서 고정할 객체를 먼저 선택하세요.");
            foreach (var id in selected) if (!pinned.Contains(id)) pinned.Add(id);
        });
        clearPins.Click += (_, _) => Act(() => pinned.Clear());
        send.Click += (_, _) => Act(Send);
        input.KeyDown += (_, e) => {
            if (e.Key == Keys.Enter && (e.Control || !e.Shift)) { e.Handled = true; Act(Send); }
        };
        foreach (var (key, text) in new[] { ("apply", "연결 Rhino 수정"), ("candidate", "후보만 만들기"), ("review", "검토만") })
            permission.Items.Add(new ListItem { Key = key, Text = text });
        permission.SelectedKey = "apply";
        model.SelectedIndexChanged += (_, _) => FillEfforts();
        send.BackgroundColor = Accent;
        send.TextColor = Colors.White;

        scroll = new Scrollable { Content = history, Border = BorderType.None, ExpandContentWidth = true, ExpandContentHeight = false, Padding = new Padding(0, 4) };
        var header = new TableLayout
        {
            Spacing = new Size(6, 4),
            Rows = {
                new TableRow(new TableCell(documentName, true), status),
                new TableRow(new TableCell(new StackLayout { Orientation = Orientation.Horizontal, Spacing = 4, Items = { connect, sync, live, open } }, true)),
            }
        };
        var composer = new TableLayout
        {
            Spacing = new Size(4, 6),
            Rows = {
                new TableRow(new StackLayout { Orientation = Orientation.Horizontal, Spacing = 4, VerticalContentAlignment = VerticalAlignment.Center, Items = { pinSelection, clearPins, new StackLayoutItem(pins, true) } }),
                new TableRow(input),
                new TableRow(new TableLayout { Spacing = new Size(4, 0), Rows = { new TableRow(new TableCell(model, true), effort) } }),
                new TableRow(new TableLayout { Spacing = new Size(4, 0), Rows = { new TableRow(new TableCell(permission, true), send) } }),
                new TableRow(notice),
            }
        };
        Content = new TableLayout
        {
            Padding = new Padding(10),
            Spacing = new Size(6, 8),
            Rows = {
                header,
                new TableRow(viewState),
                new TableRow(Separator()),
                new TableRow(new TableCell(scroll, true)) { ScaleHeight = true },
                new TableRow(Separator()),
                composer,
            }
        };
        timer.Elapsed += (_, _) => RefreshState();
        Load += (_, _) => { RefreshState(); timer.Start(); };
        UnLoad += (_, _) => timer.Stop();
        RefreshState();
    }

    private static Control Separator() => new Panel { Height = 1, BackgroundColor = Color.FromArgb(0x80, 0x80, 0x80, 0x40) };
    private RhinoDoc Document() => RhinoDoc.FromRuntimeSerialNumber(serial) ?? throw new InvalidOperationException("문서가 닫혔습니다.");

    private void Send()
    {
        var body = input.Text.Trim();
        if (body.Length == 0 && pinned.Count == 0) throw new InvalidOperationException("요청을 입력하세요.");
        if (model.SelectedKey is not { Length: > 0 } modelId) throw new InvalidOperationException("VIDE 화면을 열어 모델 목록을 받은 뒤 보내세요.");
        if (Connection == null) AttachedConnection.Connect(Document());
        ChatBridge.Enqueue(new ChatBridge.Outgoing(Guid.NewGuid().ToString(), body, modelId, effort.SelectedKey ?? "default",
            permission.SelectedKey ?? "apply", pinned.Select(p => p.ToString()).ToArray(), DateTime.UtcNow.ToString("o")) { DocumentId = serial });
        input.Text = "";
        pinned.Clear();
        historySignature = "";
    }

    private static void OpenVide()
    {
        var filename = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VIDE", "launch.json");
        using var launch = JsonDocument.Parse(File.ReadAllText(filename));
        var uri = new Uri(launch.RootElement.GetProperty("url").GetString()!);
        if (uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.UserInfo.Length != 0)
            throw new InvalidOperationException("VIDE 로컬 실행 주소를 확인할 수 없습니다.");
        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }

    private void Act(Action action)
    {
        try { notice.Text = ""; action(); }
        catch (FileNotFoundException) { notice.Text = "VIDE 로컬 서버를 먼저 실행하세요."; }
        catch (Exception error) { notice.Text = error.Message; }
        RefreshState();
    }

    private void FillEfforts()
    {
        var state = ChatBridge.State;
        var previous = effort.SelectedKey;
        effort.Items.Clear();
        if (state is { } value && value.TryGetProperty("models", out var models))
            foreach (var item in models.EnumerateArray())
                if (item.GetProperty("id").GetString() == model.SelectedKey && item.TryGetProperty("efforts", out var efforts))
                    foreach (var e in efforts.EnumerateArray())
                        effort.Items.Add(new ListItem { Key = e.GetString(), Text = e.GetString() == "default" ? "기본 추론" : e.GetString() });
        if (effort.Items.Count == 0) effort.Items.Add(new ListItem { Key = "default", Text = "기본 추론" });
        effort.SelectedKey = effort.Items.Any(i => i.Key == previous) ? previous : effort.Items[0].Key;
    }

    private void RefreshState()
    {
        var doc = RhinoDoc.FromRuntimeSerialNumber(serial);
        var connection = Connection;
        documentName.Text = doc?.Name ?? "제목 없는 문서";
        status.Text = doc == null ? "● 문서 닫힘" : connection == null ? "● 연결 안 됨" : connection.Live ? "● Live Sync" : "● 연결됨";
        status.TextColor = connection == null ? Muted : Ok;
        connect.Text = connection == null ? "연결" : "연결 해제";
        connect.Enabled = doc != null;
        sync.Enabled = live.Enabled = connection != null && RhinoApp.InCommand == 0;
        live.Text = connection?.Live == true ? "Live 끄기" : "Live 켜기";
        pins.Text = pinned.Count == 0 ? "고정한 객체 없음" : $"고정 {pinned.Count}개 객체 · 변경 대상";
        clearPins.Enabled = pinned.Count > 0;

        var state = ChatBridge.State;
        var fresh = ChatBridge.StateAt is { } at && (DateTime.UtcNow - at).TotalSeconds < 6 && connection != null;
        viewState.Text = connection == null
            ? "연결을 누르면 이 문서가 VIDE와 연결됩니다. 채팅은 VIDE를 통해 AI에 전달됩니다."
            : !fresh
                ? "VIDE 화면이 열려 있지 않거나 이 문서를 선택하지 않았습니다. 보낸 메시지는 VIDE가 연결되면 전달됩니다."
                : $"VIDE 프로젝트 · {Text(state, "project")}" + (Text(state, "basis") is { Length: > 0 } basis ? $" · 기준 {basis}" : " · Sync 기준 없음(보내면 먼저 Sync)");
        send.Enabled = doc != null;

        if (state is { } value && value.TryGetProperty("models", out var models))
        {
            var signature = models.GetRawText();
            if (signature != modelSignature)
            {
                modelSignature = signature;
                var previous = model.SelectedKey ?? Text(state, "model");
                model.Items.Clear();
                foreach (var item in models.EnumerateArray())
                    model.Items.Add(new ListItem { Key = item.GetProperty("id").GetString(), Text = item.GetProperty("name").GetString() });
                model.SelectedKey = model.Items.Any(i => i.Key == previous) ? previous : model.Items.FirstOrDefault()?.Key;
                FillEfforts();
            }
        }
        else if (model.Items.Count == 0) { model.Items.Add(new ListItem { Key = "", Text = "VIDE 연결 대기" }); model.SelectedIndex = 0; }

        RenderHistory(state);
    }

    private static string Text(JsonElement? state, string name) =>
        state is { } value && value.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() ?? "" : "";

    private void RenderHistory(JsonElement? state)
    {
        var pending = ChatBridge.Pending(serial);
        var recent = state is { } value && value.TryGetProperty("recent", out var list) && list.ValueKind == JsonValueKind.Array ? list.GetRawText() : "[]";
        var notices = state is { } v2 && v2.TryGetProperty("notices", out var n) ? n.GetRawText() : "";
        var signature = recent + notices + string.Join(",", pending.Select(p => p.id + p.Delivered));
        if (signature == historySignature) return;
        historySignature = signature;
        history.Items.Clear();
        using var parsed = JsonDocument.Parse(recent);
        var shown = new HashSet<string?>();
        foreach (var item in parsed.RootElement.EnumerateArray())
        {
            shown.Add(Text(item, "id"));
            history.Items.Add(Card(item));
        }
        foreach (var message in pending.Where(p => !shown.Contains(p.id)))
            history.Items.Add(PendingCard(message));
        if (state is { } s && s.TryGetProperty("notices", out var items) && items.ValueKind == JsonValueKind.Array)
            foreach (var item in items.EnumerateArray())
                history.Items.Add(new Label { Text = "⚠ " + Text(item, "text"), Wrap = WrapMode.Word, TextColor = Danger });
        if (history.Items.Count == 0)
            history.Items.Add(new Label { Text = "아직 요청이 없습니다. 아래에 수정할 내용을 입력하세요.\n예) 선택한 벽 높이를 3.2m로 바꿔줘", Wrap = WrapMode.Word, TextColor = Muted });
        Application.Instance.AsyncInvoke(() => scroll.ScrollPosition = new Point(0, Math.Max(0, history.Height)));
    }

    private static Control PendingCard(ChatBridge.Outgoing message) => CardFrame(new StackLayout
    {
        Spacing = 3,
        HorizontalContentAlignment = HorizontalAlignment.Stretch,
        Items = {
            new Label { Text = message.body.Length > 0 ? message.body : "고정 객체 검토", Wrap = WrapMode.Word, Font = SystemFonts.Bold() },
            new Label { Text = message.Delivered ? "VIDE에 전달됨 · 요청 등록 중" : "VIDE 전달 대기", TextColor = Running },
        }
    });

    private static Control Card(JsonElement item)
    {
        var state = Text(item, "state");
        var stack = new StackLayout { Spacing = 3, HorizontalContentAlignment = HorizontalAlignment.Stretch };
        stack.Items.Add(new Label { Text = Text(item, "body") is { Length: > 0 } body ? body : "첨부 문맥 검토", Wrap = WrapMode.Word, Font = SystemFonts.Bold() });
        stack.Items.Add(new Label
        {
            Text = (Text(item, "origin") == "rhino" ? "Rhino에서 보냄 · " : "") + Text(item, "label"),
            TextColor = state is "running" or "queued" ? Running : state == "succeeded" ? Ok : state is "failed" or "unknown" or "interrupted" ? Danger : Muted,
        });
        if (item.TryGetProperty("activity", out var activity) && activity.ValueKind == JsonValueKind.Array)
            foreach (var step in activity.EnumerateArray())
                stack.Items.Add(new Label { Text = "  " + Text(step, "icon") + " " + Text(step, "text"), Wrap = WrapMode.Word, TextColor = Text(step, "kind") == "error" ? Danger : Muted });
        if (Text(item, "text") is { Length: > 0 } text)
            stack.Items.Add(new Label { Text = text, Wrap = WrapMode.Word });
        return CardFrame(stack);
    }

    private static Control CardFrame(Control content) => new Panel
    {
        Padding = new Padding(8, 6),
        BackgroundColor = Color.FromArgb(0x80, 0x80, 0x80, 0x1A),
        Content = content,
    };
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
