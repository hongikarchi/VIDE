using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Eto.Drawing;
using Eto.Forms;
using Rhino;

namespace Vide.Worker;

internal sealed record EngineProject(string Id, string Name);

// Link (SPEC-01.11): the plugin asks the local VIDE engine for its projects and links this document to
// the chosen one. The engine's launch address (127.0.0.1) and token come from the user's own
// launch.json; nothing leaves this PC. Calls run off the Rhino UI thread (awaited, never blocking).
internal static class EngineLink
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    private static (Uri Origin, string Token) Launch()
    {
        try
        {
            var filename = Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData), "VIDE", "launch.json");
            using var launch = JsonDocument.Parse(File.ReadAllText(filename));
            var uri = new Uri(launch.RootElement.GetProperty("url").GetString()!);
            var token = uri.Fragment.TrimStart('#');
            if (uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.UserInfo.Length == 0 && Regex.IsMatch(token, "^[a-f0-9]{64}$"))
                return (new Uri(uri.GetLeftPart(UriPartial.Authority)), token);
        }
        catch (Exception error) when (error is IOException or JsonException or UriFormatException or KeyNotFoundException or InvalidOperationException) { }
        throw new InvalidOperationException("VIDE가 실행되고 있지 않습니다. VIDE를 먼저 실행한 뒤 다시 Link 하세요.");
    }

    private static async Task<HttpClient> Session()
    {
        var (origin, token) = Launch();
        var client = new HttpClient(new HttpClientHandler { CookieContainer = new CookieContainer(), UseProxy = false })
        { BaseAddress = origin, Timeout = TimeSpan.FromSeconds(20) };
        client.DefaultRequestHeaders.Add("Origin", origin.GetLeftPart(UriPartial.Authority));
        using var reply = await client.PostAsJsonAsync("/api/v1/session", new { token });
        if (!reply.IsSuccessStatusCode)
        {
            client.Dispose();
            throw new InvalidOperationException("VIDE에 로그인하지 못했습니다. VIDE를 다시 실행한 뒤 Link 하세요.");
        }
        return client;
    }

    private static string Code(string text)
    {
        try { return JsonDocument.Parse(text).RootElement.GetProperty("code").GetString() ?? ""; }
        catch (JsonException) { return ""; }
        catch (KeyNotFoundException) { return ""; }
        catch (InvalidOperationException) { return ""; }
    }

    private static InvalidOperationException Failure(string code, HttpResponseMessage reply) =>
        new(code == "STALE_CONNECTION" ? "VIDE가 이 문서의 연결을 아직 찾지 못했습니다. 잠시 후 다시 Link 하세요." : "VIDE 요청 실패 (" + (code.Length > 0 ? code : ((int)reply.StatusCode).ToString()) + ")");

    private static async Task<T> Read<T>(HttpResponseMessage reply)
    {
        var text = await reply.Content.ReadAsStringAsync();
        if (!reply.IsSuccessStatusCode) throw Failure(Code(text), reply);
        return JsonSerializer.Deserialize<T>(text, Json)!;
    }

    internal static async Task<List<EngineProject>> Projects()
    {
        using var client = await Session();
        return await Read<List<EngineProject>>(await client.GetAsync("/api/v1/projects"));
    }

    internal static async Task<EngineProject> Create(string name)
    {
        using var client = await Session();
        return await Read<EngineProject>(await client.PostAsJsonAsync("/api/v1/projects", new { name }));
    }

    /// <summary>
    /// Link this document (SPEC-01.11 1). With the link id the document stores for the project
    /// (ADR-030) and, after a LINK_CHOICE, the user's answer ("new" or a row id). The engine answers
    /// the linked row, or the choice to ask when it cannot tell which row this document continues.
    /// </summary>
    internal static async Task<(LinkedRow? Linked, LinkChoice? Choice)> Link(string projectId, string instance, uint documentId, string? storedId, string? replace)
    {
        using var client = await Session();
        var body = new Dictionary<string, object> { ["host"] = "rhino", ["instance"] = instance, ["documentId"] = documentId, ["ask"] = true };
        if (storedId != null) body["storedId"] = storedId;
        if (replace != null) body["replace"] = replace;
        using var reply = await client.PostAsJsonAsync($"/api/v1/projects/{Uri.EscapeDataString(projectId)}/links", body);
        var text = await reply.Content.ReadAsStringAsync();
        if (reply.StatusCode == HttpStatusCode.Conflict && Code(text) == "LINK_CHOICE")
            return (null, JsonSerializer.Deserialize<LinkChoice>(text, Json));
        if (!reply.IsSuccessStatusCode) throw Failure(Code(text), reply);
        return (JsonSerializer.Deserialize<LinkedRow>(text, Json), null);
    }

    /// <summary>Runs on Rhino's UI thread (dialogs and document writes) and returns its value.</summary>
    private static Task<T> OnUi<T>(Func<T> work)
    {
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        RhinoApp.InvokeOnUiThread(new Action(() =>
        {
            try { done.SetResult(work()); }
            catch (Exception error) { done.SetException(error); }
        }));
        return done.Task;
    }

    /// <summary>Connect this document, choose a project and link it (VIDE then syncs it at once).</summary>
    internal static async void LinkDocument(RhinoDoc doc)
    {
        var created = false;
        try
        {
            if (doc.IsHeadless) return;
            var name = doc.Name ?? "제목 없는 문서";
            var project = new ProjectDialog(name).ShowModal();
            if (project == null) return;
            created = AttachedConnection.Current?.DocumentId != doc.RuntimeSerialNumber;
            AttachedConnection.Connect(doc);
            var connection = AttachedConnection.Current!;
            var stored = LinkIdStore.Read(doc, project.Id);
            var (linked, choice) = await Link(project.Id, connection.Instance, connection.DocumentId, stored, null);
            if (choice != null)
            {
                // Which row this document continues (SPEC-01.11 1): asked only when it is unclear.
                var answer = await OnUi(() => new LinkChoiceDialog(name, choice).ShowModal());
                if (answer == null)
                {
                    if (created && AttachedConnection.Current == connection) { connection.Dispose(); AttachedConnection.Current = null; }
                    RhinoApp.WriteLine("VIDE: Link를 취소했습니다.");
                    return;
                }
                (linked, _) = await Link(project.Id, connection.Instance, connection.DocumentId, stored, answer);
            }
            connection.LinkedProject = project;
            var wrote = linked != null && await OnUi(() => LinkIdStore.Write(doc, project.Id, linked.Id));
            RhinoApp.WriteLine($"VIDE: '{doc.Name}'을(를) 프로젝트 '{project.Name}'에 연결했습니다. VIDE에 곧 표시됩니다." +
                (wrote ? " 연결 ID를 문서에 저장했습니다. 저장하면 다음에도 이어집니다." : ""));
        }
        catch (Exception error)
        {
            RhinoApp.WriteLine("VIDE Link 실패: " + error.Message);
            MessageBox.Show(error.Message, "VIDE", MessageBoxType.Warning);
        }
    }
}

internal sealed record LinkedRow(string Id, string Name);
internal sealed record LinkChoiceItem(string Id, string Name, string? Path, string Match, int Syncs);
/// <summary>The engine's LINK_CHOICE: "copy" (the stored id is open in another window) or "closed".</summary>
internal sealed record LinkChoice(string Reason, string Default, List<LinkChoiceItem> Choices);

/// <summary>
/// Which linked file this document continues (SPEC-01.11 1, Design SCR-12): an existing row (its
/// Sync history continues) or a new linked file. The default is what VIDE would pick on its own.
/// </summary>
internal sealed class LinkChoiceDialog : Dialog<string?>
{
    internal LinkChoiceDialog(string documentName, LinkChoice choice)
    {
        Title = "VIDE 연결 · " + documentName;
        Padding = new Padding(12);
        Resizable = true;
        var options = new RadioButtonList { Orientation = Orientation.Vertical, Spacing = new Size(0, 6) };
        foreach (var item in choice.Choices)
            options.Items.Add(new ListItem
            {
                Key = item.Id,
                Text = $"기존 '{item.Name}' 대체 (기록 이어짐 · Sync {item.Syncs}회)" + (string.IsNullOrEmpty(item.Path) ? "" : " · " + item.Path),
            });
        options.Items.Add(new ListItem { Key = "new", Text = "새 연결 파일로 추가" });
        options.SelectedKey = choice.Default;
        var ok = new Button { Text = "연결" };
        var cancel = new Button { Text = "취소" };
        ok.Click += (_, _) => Close(options.SelectedKey);
        cancel.Click += (_, _) => Close(null);
        DefaultButton = ok;
        AbortButton = cancel;
        Content = new StackLayout
        {
            Spacing = 10,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Items =
            {
                new Label
                {
                    Wrap = WrapMode.Word,
                    Text = choice.Reason == "copy"
                        ? "이 문서는 다른 창에 열려 있는 연결 파일과 같은 연결 ID를 갖고 있습니다(파일 사본). 어느 쪽으로 연결할까요?"
                        : "이 프로젝트에 이 문서일 수 있는 닫힌 연결 파일이 있습니다. 어느 쪽으로 연결할까요?",
                },
                options,
                new StackLayout { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalContentAlignment = HorizontalAlignment.Right, Items = { null, cancel, ok } },
            },
        };
    }
}

/// <summary>Choose the VIDE project for this document (recent first), or make a new one.</summary>
internal sealed class ProjectDialog : Dialog<EngineProject?>
{
    private readonly ListBox list = new() { Height = 220 };
    private readonly TextBox name = new() { PlaceholderText = "새 프로젝트 이름" };
    private readonly Label status = new() { Text = "VIDE 프로젝트를 불러오는 중…", Wrap = WrapMode.Word };
    private readonly Button link = new() { Text = "Link", Enabled = false };
    private List<EngineProject> projects = new();

    internal ProjectDialog(string documentName)
    {
        Title = "VIDE에 연결 · " + documentName;
        Padding = new Padding(12);
        Resizable = true;
        var create = new Button { Text = "새 프로젝트로 Link" };
        var cancel = new Button { Text = "취소" };
        list.SelectedIndexChanged += (_, _) => link.Enabled = list.SelectedIndex >= 0;
        list.MouseDoubleClick += (_, _) => Choose();
        link.Click += (_, _) => Choose();
        cancel.Click += (_, _) => Close(null);
        create.Click += async (_, _) =>
        {
            var text = name.Text.Trim();
            if (text.Length == 0) { status.Text = "새 프로젝트 이름을 쓰세요."; return; }
            create.Enabled = false;
            try { Close(await EngineLink.Create(text)); }
            catch (Exception error) { status.Text = error.Message; create.Enabled = true; }
        };
        DefaultButton = link;
        AbortButton = cancel;
        Content = new StackLayout
        {
            Spacing = 8,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Items =
            {
                new Label { Text = "이 문서를 연결할 VIDE 프로젝트를 고르세요. 연결하면 바로 Sync됩니다." },
                list,
                new StackLayout { Orientation = Orientation.Horizontal, Spacing = 6, Items = { new StackLayoutItem(name, true), create } },
                status,
                new StackLayout { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalContentAlignment = HorizontalAlignment.Right, Items = { null, cancel, link } },
            },
        };
        Shown += async (_, _) =>
        {
            try
            {
                projects = await EngineLink.Projects();
                list.Items.Clear();
                foreach (var project in projects) list.Items.Add(project.Name);
                if (projects.Count > 0) list.SelectedIndex = 0;
                status.Text = projects.Count > 0 ? "" : "프로젝트가 없습니다. 새 프로젝트 이름을 쓰세요.";
            }
            catch (Exception error) { status.Text = error.Message; }
        };
    }

    private void Choose()
    {
        if (list.SelectedIndex >= 0 && list.SelectedIndex < projects.Count) Close(projects[list.SelectedIndex]);
    }
}
