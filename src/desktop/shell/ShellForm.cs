using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Vide.Desktop
{
    /// <summary>The program window: the work screen in WebView2, without browser chrome.</summary>
    internal sealed class ShellForm : Form
    {
        private readonly ShellContext context;
        private WebView2 view = new WebView2 { Dock = DockStyle.Fill };
        private readonly Label problem = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 11f),
            ForeColor = Color.FromArgb(98, 107, 110),
            Text = "VIDE 작업 엔진을 시작하는 중…",
        };
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private string origin;
        private string opened;
        private bool ready;
        /// <summary>A folder picker is open (<see cref="PickFolder"/>).</summary>
        private bool picking;
        // The last work page shown, so a recreated WebView comes back to the same project.
        private string lastPage;
        private readonly Queue<DateTime> reloads = new Queue<DateTime>();

        public ShellForm(ShellContext context)
        {
            this.context = context;
            Text = "VIDE";
            Icon = ShellContext.AppIcon;
            BackColor = Color.FromArgb(247, 247, 244);
            MinimumSize = new Size(900, 600);
            StartPosition = FormStartPosition.Manual;
            var saved = context.Settings.Window;
            var bounds = saved != null && saved.Length == 4 ? new Rectangle(saved[0], saved[1], saved[2], saved[3]) : Rectangle.Empty;
            if (bounds.Width >= 900 && bounds.Height >= 600 && Screen.AllScreens is Screen[] screens && Array.Exists(screens, s => s.WorkingArea.IntersectsWith(bounds)))
                Bounds = bounds;
            else
            {
                var area = Screen.PrimaryScreen.WorkingArea;
                Size = new Size(Math.Min(1600, area.Width - 80), Math.Min(1000, area.Height - 80));
                Location = new Point(area.X + (area.Width - Width) / 2, area.Y + (area.Height - Height) / 2);
            }
            if (context.Settings.Maximized) WindowState = FormWindowState.Maximized;
            Controls.Add(view);
            Controls.Add(problem);
            view.Visible = false;
            _ = Initialize();
        }

        private async System.Threading.Tasks.Task Initialize()
        {
            try
            {
                var options = new CoreWebView2EnvironmentOptions();
                var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Paths.Data, "webview"), options);
                await view.EnsureCoreWebView2Async(environment);
            }
            catch (Exception error)
            {
                ShellLog.Error("webview-init-failed", error);
                ShowProblem("창을 표시하지 못했습니다. Microsoft Edge WebView2 런타임을 확인하세요. (" + error.Message + ")");
                return;
            }
            var core = view.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("VIDE_DEVTOOLS") == "1";
            core.Settings.IsZoomControlEnabled = true;
            // The window shows only the local work screen; other pages open in the default browser.
            core.NewWindowRequested += (s, e) =>
            {
                e.Handled = true;
                ShellContext.OpenExternal(e.Uri);
            };
            core.NavigationStarting += (s, e) =>
            {
                if (origin == null || e.Uri.StartsWith(origin + "/", StringComparison.Ordinal) || e.Uri == origin) return;
                // The account site ("모든 프로젝트") opens in this window too; opening a project there
                // comes back to this PC's work screen.
                var site = SiteOrigin();
                if (site != null && (e.Uri == site || e.Uri.StartsWith(site + "/", StringComparison.Ordinal))) return;
                e.Cancel = true;
                ShellContext.OpenExternal(e.Uri);
            };
            core.ProcessFailed += (s, e) => OnProcessFailed(e.ProcessFailedKind);
            core.SourceChanged += (s, e) =>
            {
                if (origin != null && core.Source.StartsWith(origin + "/", StringComparison.Ordinal)) lastPage = core.Source;
            };
            core.DocumentTitleChanged += (s, e) => Text = string.IsNullOrEmpty(core.DocumentTitle) ? "VIDE" : core.DocumentTitle;
            core.WebMessageReceived += (s, e) =>
            {
                if (origin == null || !e.Source.StartsWith(origin, StringComparison.Ordinal)) return;
                try
                {
                    if (json.DeserializeObject(e.WebMessageAsJson) is Dictionary<string, object> message) context.Handle(message);
                }
                catch
                {
                    /* Ignore malformed messages. */
                }
            };
            ready = true;
            if (opened != null) Navigate(opened);
        }

        /// <summary>
        /// A crashed or hung page comes back by itself (2026-09-30 the window stayed on Chrome's
        /// "Out of Memory" page until VIDE was restarted). Drafts survive in the page's storage.
        /// </summary>
        private void OnProcessFailed(CoreWebView2ProcessFailedKind kind)
        {
            ShellLog.Write("webview-failed", new Dictionary<string, object> { ["kind"] = kind.ToString(), ["reloadsInMinute"] = reloads.Count });
            if (kind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
            {
                // The whole WebView is gone: a new control and environment, then the same page.
                BeginInvoke((Action)Recreate);
                return;
            }
            // GPU and utility processes are restarted by WebView2 itself.
            if (kind != CoreWebView2ProcessFailedKind.RenderProcessExited
                && kind != CoreWebView2ProcessFailedKind.RenderProcessUnresponsive
                && kind != CoreWebView2ProcessFailedKind.FrameRenderProcessExited) return;
            while (reloads.Count > 0 && DateTime.UtcNow - reloads.Peek() > TimeSpan.FromMinutes(1)) reloads.Dequeue();
            if (reloads.Count >= 3)
            {
                ShellLog.Write("webview-given-up", new Dictionary<string, object> { ["kind"] = kind.ToString() }, true);
                ShowProblem("화면이 계속 종료됩니다. 트레이의 VIDE를 종료한 뒤 다시 실행하세요.");
                return;
            }
            reloads.Enqueue(DateTime.UtcNow);
            ShellLog.Write("webview-reload", new Dictionary<string, object> { ["kind"] = kind.ToString() });
            try { view.CoreWebView2.Reload(); }
            catch { BeginInvoke((Action)Recreate); }
        }

        private void Recreate()
        {
            ShellLog.Write("webview-recreate");
            ready = false;
            Controls.Remove(view);
            try { view.Dispose(); } catch { /* Already torn down with its browser process. */ }
            view = new WebView2 { Dock = DockStyle.Fill, Visible = false };
            Controls.Add(view);
            if (lastPage != null) opened = lastPage;
            _ = Initialize();
        }

        /// <summary>The account website this PC is signed in to (https only), if any.</summary>
        private static string SiteOrigin()
        {
            try
            {
                var file = Path.Combine(Paths.Data, "remote-host.json");
                if (!File.Exists(file)) return null;
                var match = System.Text.RegularExpressions.Regex.Match(File.ReadAllText(file), @"""workerOrigin""\s*:\s*""(https://[^""/]+)""");
                return match.Success ? match.Groups[1].Value : null;
            }
            catch { return null; }
        }

        /// <summary>Show the work screen (first time: the launch link that signs the window in).</summary>
        public void Open(string url)
        {
            if (opened != null && url == opened && view.Visible) return;
            opened = url;
            if (ready) Navigate(url);
        }

        private void Navigate(string url)
        {
            var uri = new Uri(url);
            origin = uri.GetLeftPart(UriPartial.Authority);
            problem.Visible = false;
            view.Visible = true;
            // After the first sign-in the saved session cookie is enough; keep the current page.
            if (view.Source == null || !view.Source.AbsoluteUri.StartsWith(origin, StringComparison.Ordinal))
                view.CoreWebView2.Navigate(url);
        }

        public void ShowProblem(string text)
        {
            problem.Text = text;
            problem.Visible = true;
            view.Visible = false;
            if (!Visible && !context.Quitting) Show();
        }

        public void PostState()
        {
            if (!ready || view.CoreWebView2 == null || origin == null) return;
            try { view.CoreWebView2.PostWebMessageAsJson(json.Serialize(context.State())); }
            catch { /* Page not ready. */ }
        }

        /// <summary>
        /// The Windows folder picker for 대시보드 › 프로젝트 폴더 (SPEC-01.13); the page gets
        /// <c>{type:'folder:picked', id, path}</c> (path null when cancelled). It is the Explorer-style
        /// dialog with 즐겨찾기 (<see cref="FolderPicker"/>); if that cannot open, the old tree picker;
        /// if neither opens, <c>error</c> says so and the page opens its path field. Shown after the
        /// message handler returns, not inside it. One picker at a time: the dialog's own message loop
        /// still handles page messages, so a second request while one is open (a double click) is
        /// answered at once with path null instead of opening a second dialog on top.
        /// </summary>
        public void PickFolder(string id)
        {
            BeginInvoke((Action)(() =>
            {
                if (picking)
                {
                    ReplyPicked(id, null, null);
                    return;
                }
                picking = true;
                const string title = "VIDE 프로젝트 폴더를 고르세요";
                string path = null;
                string error = null;
                try
                {
                    if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                    Activate();
                    try { path = FolderPicker.Pick(Handle, title); }
                    catch (Exception modern)
                    {
                        ShellLog.Error("folder-picker-failed", modern);
                        try
                        {
                            using (var dialog = new FolderBrowserDialog { Description = title, ShowNewFolderButton = false })
                                if (dialog.ShowDialog(this) == DialogResult.OK) path = dialog.SelectedPath;
                        }
                        catch (Exception old)
                        {
                            ShellLog.Error("folder-browser-failed", old);
                            error = "폴더 선택 창을 열지 못했습니다. 경로를 붙여넣으세요.";
                        }
                    }
                }
                finally { picking = false; }
                ReplyPicked(id, path, error);
            }));
        }

        private void ReplyPicked(string id, string path, string error)
        {
            if (!ready || view.CoreWebView2 == null) return;
            try
            {
                view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new Dictionary<string, object>
                {
                    ["type"] = "folder:picked",
                    ["id"] = id,
                    ["path"] = path,
                    ["error"] = error,
                }));
            }
            catch { /* Page gone. */ }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            context.Settings.Maximized = WindowState == FormWindowState.Maximized;
            var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            context.Settings.Window = new[] { bounds.X, bounds.Y, bounds.Width, bounds.Height };
            try { context.Settings.Save(); } catch { /* Window placement is a convenience. */ }
            if (e.CloseReason == CloseReason.UserClosing && !context.Quitting)
            {
                e.Cancel = true;
                if (context.Settings.Background)
                {
                    Hide();
                    context.Hidden();
                }
                else context.Quit();
                return;
            }
            base.OnFormClosing(e);
        }
    }
}
