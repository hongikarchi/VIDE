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

    private static async Task<T> Read<T>(HttpResponseMessage reply)
    {
        var text = await reply.Content.ReadAsStringAsync();
        if (!reply.IsSuccessStatusCode)
        {
            var code = "";
            try { code = JsonDocument.Parse(text).RootElement.GetProperty("code").GetString() ?? ""; } catch (JsonException) { } catch (KeyNotFoundException) { }
            throw new InvalidOperationException(code == "STALE_CONNECTION" ? "VIDE가 이 문서의 연결을 아직 찾지 못했습니다. 잠시 후 다시 Link 하세요." : "VIDE 요청 실패 (" + (code.Length > 0 ? code : ((int)reply.StatusCode).ToString()) + ")");
        }
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

    internal static async Task Link(string projectId, string instance, uint documentId)
    {
        using var client = await Session();
        await Read<JsonElement>(await client.PostAsJsonAsync($"/api/v1/projects/{Uri.EscapeDataString(projectId)}/links", new { host = "rhino", instance, documentId }));
    }

    /// <summary>Connect this document, choose a project and link it (VIDE then syncs it at once).</summary>
    internal static async void LinkDocument(RhinoDoc doc)
    {
        try
        {
            if (doc.IsHeadless) return;
            var project = new ProjectDialog(doc.Name ?? "제목 없는 문서").ShowModal();
            if (project == null) return;
            AttachedConnection.Connect(doc);
            var connection = AttachedConnection.Current!;
            await Link(project.Id, connection.Instance, connection.DocumentId);
            connection.LinkedProject = project;
            RhinoApp.WriteLine($"VIDE: '{doc.Name}'을(를) 프로젝트 '{project.Name}'에 연결했습니다. VIDE에 곧 표시됩니다.");
        }
        catch (Exception error)
        {
            RhinoApp.WriteLine("VIDE Link 실패: " + error.Message);
            MessageBox.Show(error.Message, "VIDE", MessageBoxType.Warning);
        }
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
