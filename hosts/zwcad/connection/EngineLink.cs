using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using ZwSoft.ZwCAD.ApplicationServices;
using Cad = ZwSoft.ZwCAD.ApplicationServices.Application;

namespace Vide.Zwcad.Connection
{
    internal sealed class EngineProject
    {
        public string Id { get; set; }
        public string Name { get; set; }
    }

    /// <summary>
    /// Link (SPEC-01.11): ask the local VIDE engine for its projects and link this drawing to the chosen
    /// one. The engine address (127.0.0.1) and token come from the user's own launch.json; nothing leaves
    /// this PC. Calls are awaited so ZWCAD's UI thread never blocks while the engine reads the drawing.
    /// </summary>
    internal static class EngineLink
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        private static Tuple<Uri, string> Launch()
        {
            try
            {
                var filename = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VIDE", "launch.json");
                var launch = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(filename));
                var uri = new Uri(Convert.ToString(launch["url"]));
                var token = uri.Fragment.TrimStart('#');
                if (uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.UserInfo.Length == 0 && Regex.IsMatch(token, "^[a-f0-9]{64}$"))
                    return Tuple.Create(new Uri(uri.GetLeftPart(UriPartial.Authority)), token);
            }
            catch (IOException) { }
            catch (ArgumentException) { }
            catch (KeyNotFoundException) { }
            catch (UriFormatException) { }
            catch (InvalidOperationException) { }
            throw new InvalidOperationException("VIDE가 실행되고 있지 않습니다. VIDE를 먼저 실행한 뒤 다시 Link 하세요.");
        }

        /// <summary>The session request carries the launch token read from launch.json above.</summary>
        private static Dictionary<string, string> SessionBody(string value)
        {
            var body = new Dictionary<string, string>();
            body.Add("token", value);
            return body;
        }

        private static StringContent Body(object value) => new StringContent(Json.Serialize(value), Encoding.UTF8, "application/json");

        private static async Task<HttpClient> Session()
        {
            var launch = Launch();
            var client = new HttpClient(new HttpClientHandler { CookieContainer = new CookieContainer(), UseProxy = false })
            { BaseAddress = launch.Item1, Timeout = TimeSpan.FromSeconds(20) };
            client.DefaultRequestHeaders.Add("Origin", launch.Item1.GetLeftPart(UriPartial.Authority));
            using (var reply = await client.PostAsync("/api/v1/session", Body(SessionBody(launch.Item2))))
                if (!reply.IsSuccessStatusCode)
                {
                    client.Dispose();
                    throw new InvalidOperationException("VIDE에 로그인하지 못했습니다. VIDE를 다시 실행한 뒤 Link 하세요.");
                }
            return client;
        }

        private static async Task<string> Read(HttpResponseMessage reply)
        {
            var text = await reply.Content.ReadAsStringAsync();
            if (reply.IsSuccessStatusCode) return text;
            string code = "";
            try { code = Convert.ToString(Json.Deserialize<Dictionary<string, object>>(text)["code"]); } catch (ArgumentException) { } catch (KeyNotFoundException) { } catch (InvalidOperationException) { }
            throw new InvalidOperationException(code == "STALE_CONNECTION" ? "VIDE가 이 도면의 연결을 아직 찾지 못했습니다. 잠시 후 다시 Link 하세요." : "VIDE 요청 실패 (" + (code.Length > 0 ? code : ((int)reply.StatusCode).ToString()) + ")");
        }

        private static EngineProject Project(Dictionary<string, object> row) =>
            new EngineProject { Id = Convert.ToString(row["id"]), Name = Convert.ToString(row["name"]) };

        internal static async Task<List<EngineProject>> Projects()
        {
            using (var client = await Session())
                return Json.Deserialize<List<Dictionary<string, object>>>(await Read(await client.GetAsync("/api/v1/projects"))).Select(Project).ToList();
        }

        internal static async Task<EngineProject> Create(string name)
        {
            using (var client = await Session())
                return Project(Json.Deserialize<Dictionary<string, object>>(await Read(await client.PostAsync("/api/v1/projects", Body(new { name })))));
        }

        private static string Code(string text)
        {
            try { return Convert.ToString(Json.Deserialize<Dictionary<string, object>>(text)["code"]); }
            catch (ArgumentException) { return ""; }
            catch (KeyNotFoundException) { return ""; }
            catch (InvalidOperationException) { return ""; }
        }

        /// <summary>
        /// Link this drawing (SPEC-01.11 1) with the link id it stores for the project (ADR-030) and,
        /// after a LINK_CHOICE, the user's answer ("new" or a row id). Returns the linked row's id, or
        /// the choice to ask when VIDE cannot tell which row this drawing continues.
        /// </summary>
        internal static async Task<Tuple<string, LinkChoice>> Link(string projectId, string instance, string storedId, string replace)
        {
            var body = new Dictionary<string, object> { { "host", "zwcad" }, { "instance", instance }, { "documentId", 1 }, { "ask", true } };
            if (storedId != null) body["storedId"] = storedId;
            if (replace != null) body["replace"] = replace;
            using (var client = await Session())
            using (var reply = await client.PostAsync("/api/v1/projects/" + Uri.EscapeDataString(projectId) + "/links", Body(body)))
            {
                var text = await reply.Content.ReadAsStringAsync();
                if (reply.StatusCode == HttpStatusCode.Conflict && Code(text) == "LINK_CHOICE")
                    return Tuple.Create((string)null, LinkChoice.From(Json.Deserialize<Dictionary<string, object>>(text)));
                if (!reply.IsSuccessStatusCode) { await Read(reply); return null; }
                return Tuple.Create(Convert.ToString(Json.Deserialize<Dictionary<string, object>>(text)["id"]), (LinkChoice)null);
            }
        }

        /// <summary>Connect the drawing, choose a project and link it (VIDE then syncs it at once).</summary>
        internal static async void LinkDocument(Document doc, Action done)
        {
            try
            {
                if (doc == null) throw new InvalidOperationException("열린 도면이 없습니다.");
                EngineProject project;
                using (var dialog = new ProjectDialog(Path.GetFileName(doc.Name)))
                {
                    if (dialog.ShowDialog() != DialogResult.OK || dialog.Chosen == null) return;
                    project = dialog.Chosen;
                }
                var created = !AttachedDocument.Connections.ContainsKey(doc);
                var connection = AttachedDocument.Connect(doc);
                var stored = LinkIdStore.Read(doc, project.Id);
                var linked = await Link(project.Id, connection.Instance, stored, null);
                if (linked.Item2 != null)
                {
                    // Which row this drawing continues (SPEC-01.11 1): asked only when it is unclear.
                    string answer;
                    using (var dialog = new LinkChoiceDialog(Path.GetFileName(doc.Name), linked.Item2))
                    {
                        if (dialog.ShowDialog() != DialogResult.OK || dialog.Chosen == null)
                        {
                            if (created) connection.Dispose();
                            doc.Editor.WriteMessage("\nVIDE: Link를 취소했습니다.\n");
                            return;
                        }
                        answer = dialog.Chosen;
                    }
                    linked = await Link(project.Id, connection.Instance, stored, answer);
                }
                connection.LinkedProject = project;
                var wrote = linked.Item1 != null && LinkIdStore.Write(doc, project.Id, linked.Item1);
                doc.Editor.WriteMessage("\nVIDE: '" + Path.GetFileName(doc.Name) + "'을(를) 프로젝트 '" + project.Name + "'에 연결했습니다. VIDE에 곧 표시됩니다." +
                    (wrote ? " 연결 ID를 문서에 저장했습니다. 저장하면 다음에도 이어집니다." : "") + "\n");
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "VIDE", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally { done?.Invoke(); }
        }
    }

    /// <summary>The engine's LINK_CHOICE: "copy" (the stored id is open in another window) or "closed".</summary>
    internal sealed class LinkChoice
    {
        internal string Reason;
        internal string Default;
        internal List<Tuple<string, string>> Choices = new List<Tuple<string, string>>();

        internal static LinkChoice From(Dictionary<string, object> value)
        {
            var choice = new LinkChoice { Reason = Convert.ToString(value["reason"]), Default = Convert.ToString(value["default"]) };
            foreach (var item in ((System.Collections.ArrayList)value["choices"]).Cast<Dictionary<string, object>>())
            {
                object path; item.TryGetValue("path", out path);
                var text = "기존 '" + Convert.ToString(item["name"]) + "' 대체 (기록 이어짐 · Sync " + Convert.ToString(item["syncs"]) + "회)" +
                    (path == null || Convert.ToString(path).Length == 0 ? "" : " · " + Convert.ToString(path));
                choice.Choices.Add(Tuple.Create(Convert.ToString(item["id"]), text));
            }
            return choice;
        }
    }

    /// <summary>
    /// Which linked file this drawing continues (SPEC-01.11 1, Design SCR-12): an existing row (its
    /// Sync history continues) or a new linked file. The default is what VIDE would pick on its own.
    /// </summary>
    internal sealed class LinkChoiceDialog : Form
    {
        internal string Chosen { get; private set; }

        internal LinkChoiceDialog(string documentName, LinkChoice choice)
        {
            Text = "VIDE 연결 · " + documentName;
            Width = 480; Height = 320; StartPosition = FormStartPosition.CenterScreen; MinimizeBox = false; MaximizeBox = false;
            var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(12) };
            layout.Controls.Add(new Label
            {
                AutoSize = true, MaximumSize = new System.Drawing.Size(430, 0),
                Text = choice.Reason == "copy"
                    ? "이 도면은 다른 창에 열려 있는 연결 파일과 같은 연결 ID를 갖고 있습니다(파일 사본). 어느 쪽으로 연결할까요?"
                    : "이 프로젝트에 이 도면일 수 있는 닫힌 연결 파일이 있습니다. 어느 쪽으로 연결할까요?",
            });
            var options = new List<Tuple<string, RadioButton>>();
            foreach (var item in choice.Choices.Concat(new[] { Tuple.Create("new", "새 연결 파일로 추가") }))
            {
                var button = new RadioButton { Text = item.Item2, AutoSize = true, MaximumSize = new System.Drawing.Size(430, 0), Checked = item.Item1 == choice.Default };
                options.Add(Tuple.Create(item.Item1, button));
                layout.Controls.Add(button);
            }
            var ok = new Button { Text = "연결", Width = 90 };
            var cancel = new Button { Text = "취소", Width = 90, DialogResult = DialogResult.Cancel };
            ok.Click += (_, __) =>
            {
                Chosen = options.Where(option => option.Item2.Checked).Select(option => option.Item1).FirstOrDefault();
                if (Chosen == null) return;
                DialogResult = DialogResult.OK;
                Close();
            };
            var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Bottom, AutoSize = true, Padding = new Padding(12, 0, 12, 12) };
            buttons.Controls.Add(ok); buttons.Controls.Add(cancel);
            Controls.Add(layout);
            Controls.Add(buttons);
            AcceptButton = ok; CancelButton = cancel;
        }
    }

    /// <summary>Choose the VIDE project for this drawing, or make a new one.</summary>
    internal sealed class ProjectDialog : Form
    {
        private readonly ListBox list = new ListBox { Dock = DockStyle.Fill, IntegralHeight = false };
        private readonly TextBox name = new TextBox { Dock = DockStyle.Fill };
        private readonly Label status = new Label { Dock = DockStyle.Fill, AutoSize = false, Height = 36, Text = "VIDE 프로젝트를 불러오는 중…" };
        private readonly Button link = new Button { Text = "Link", Enabled = false, Width = 90 };
        private List<EngineProject> projects = new List<EngineProject>();
        internal EngineProject Chosen { get; private set; }

        internal ProjectDialog(string documentName)
        {
            Text = "VIDE에 연결 · " + documentName;
            Width = 420; Height = 420; StartPosition = FormStartPosition.CenterScreen; MinimizeBox = false; MaximizeBox = false;
            var create = new Button { Text = "새 프로젝트로 Link", Width = 130 };
            var cancel = new Button { Text = "취소", Width = 90, DialogResult = DialogResult.Cancel };
            list.SelectedIndexChanged += (_, __) => link.Enabled = list.SelectedIndex >= 0;
            list.DoubleClick += (_, __) => Choose();
            link.Click += (_, __) => Choose();
            create.Click += async (_, __) =>
            {
                var text = name.Text.Trim();
                if (text.Length == 0) { status.Text = "새 프로젝트 이름을 쓰세요."; return; }
                create.Enabled = false;
                try { Chosen = await EngineLink.Create(text); DialogResult = DialogResult.OK; Close(); }
                catch (Exception error) { status.Text = error.Message; create.Enabled = true; }
            };
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(12), ColumnCount = 2, RowCount = 5 };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            var intro = new Label { Text = "이 도면을 연결할 VIDE 프로젝트를 고르세요. 연결하면 바로 Sync됩니다.", AutoSize = true, MaximumSize = new System.Drawing.Size(380, 0) };
            layout.Controls.Add(intro, 0, 0); layout.SetColumnSpan(intro, 2);
            layout.Controls.Add(list, 0, 1); layout.SetColumnSpan(list, 2);
            layout.Controls.Add(name, 0, 2); layout.Controls.Add(create, 1, 2);
            layout.Controls.Add(status, 0, 3); layout.SetColumnSpan(status, 2);
            var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, AutoSize = true };
            buttons.Controls.Add(link); buttons.Controls.Add(cancel);
            layout.Controls.Add(buttons, 0, 4); layout.SetColumnSpan(buttons, 2);
            Controls.Add(layout);
            AcceptButton = link; CancelButton = cancel;
            Shown += async (_, __) =>
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
            if (list.SelectedIndex < 0 || list.SelectedIndex >= projects.Count) return;
            Chosen = projects[list.SelectedIndex];
            DialogResult = DialogResult.OK;
            Close();
        }
    }
}
