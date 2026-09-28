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
        private readonly WebView2 view = new WebView2 { Dock = DockStyle.Fill };
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
                e.Cancel = true;
                ShellContext.OpenExternal(e.Uri);
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
