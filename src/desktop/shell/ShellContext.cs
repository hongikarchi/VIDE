using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Vide.Desktop
{
    /// <summary>Tray icon, engine, window and updates for one running VIDE program.</summary>
    internal sealed class ShellContext : ApplicationContext
    {
        public const string DefaultSite = "https://vide-sharing-staging.archivibe.workers.dev";
        private readonly NotifyIcon tray;
        private readonly ToolStripMenuItem updateItem;
        private readonly Engine engine = new Engine();
        private readonly EventWaitHandle showSignal;
        private readonly EventWaitHandle quitSignal;
        private readonly SynchronizationContext ui;
        private readonly System.Windows.Forms.Timer updateTimer = new System.Windows.Forms.Timer();
        private ShellForm form;
        private int restarts;
        public DesktopSettings Settings { get; }
        public Updater Updater { get; }
        public bool Quitting { get; private set; }
        public static readonly Icon AppIcon = LoadIcon();

        public ShellContext(bool background)
        {
            WindowsFormsSynchronizationContext.AutoInstall = true;
            ui = new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(ui);
            Settings = DesktopSettings.Load();
            try { Settings.ApplyAutostart(Paths.Launcher); } catch { /* Policy may block the Run key. */ }
            string source = Environment.GetEnvironmentVariable("VIDE_UPDATE_SOURCE");
            Updater = new Updater(string.IsNullOrWhiteSpace(source) ? Settings.UpdateSource : source);
            Updater.Changed += () => ui.Post(_ => OnUpdateChanged(), null);

            var menu = new ContextMenuStrip();
            var open = menu.Items.Add("VIDE 열기", null, (s, e) => ShowWindow());
            open.Font = new Font(open.Font, FontStyle.Bold);
            menu.Items.Add("웹사이트에서 모든 프로젝트", null, (s, e) => OpenExternal(Site()));
            menu.Items.Add(new ToolStripSeparator());
            updateItem = new ToolStripMenuItem("업데이트 확인", null, (s, e) => OnUpdateClick());
            menu.Items.Add(updateItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("종료", null, (s, e) => Quit());
            tray = new NotifyIcon { Icon = AppIcon, Text = "VIDE", ContextMenuStrip = menu, Visible = true };
            tray.DoubleClick += (s, e) => ShowWindow();
            OnUpdateChanged();

            showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowEventName);
            var waiter = new Thread(() =>
            {
                while (showSignal.WaitOne())
                {
                    if (Quitting) return;
                    ui.Post(_ => ShowWindow(), null);
                }
            }) { IsBackground = true };
            waiter.Start();
            quitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.QuitEventName);
            new Thread(() =>
            {
                if (quitSignal.WaitOne() && !Quitting) ui.Post(_ => Quit(), null);
            }) { IsBackground = true }.Start();

            engine.Exited += code => ui.Post(_ => OnEngineExited(code), null);
            form = new ShellForm(this);
            if (!background) form.Show();
            _ = StartEngine();
            // Check for updates shortly after start and every six hours.
            updateTimer.Interval = 60_000;
            updateTimer.Tick += (s, e) =>
            {
                updateTimer.Interval = 6 * 60 * 60_000;
                _ = Updater.Check();
            };
            updateTimer.Start();
        }

        private async Task StartEngine()
        {
            try
            {
                string url = await engine.Start();
                form.Open(url);
            }
            catch (EngineException error)
            {
                form.ShowProblem(error.Code == "CONTROLLER_BUSY"
                    ? "이미 다른 VIDE 작업 엔진이 이 사용자 데이터를 쓰고 있습니다. 개발용 서버를 종료한 뒤 다시 실행하세요."
                    : "작업 엔진을 시작하지 못했습니다 (" + error.Code + "). 사용자 데이터 폴더의 startup-error.json을 확인하세요.");
            }
            catch (Exception error)
            {
                form.ShowProblem("작업 엔진을 시작하지 못했습니다: " + error.Message);
            }
        }

        private void OnEngineExited(int code)
        {
            if (Quitting) return;
            // Restart a crashed engine a few times; its records survive restarts. An engine that
            // ran ten minutes earns the budget back: VIDE lives for days in the tray.
            if (DateTime.UtcNow - engine.StartedAt > TimeSpan.FromMinutes(10)) restarts = 0;
            if (++restarts <= 3)
            {
                form.ShowProblem("작업 엔진이 종료되어 다시 시작하는 중입니다… (코드 " + Engine.Hex(code) + ")");
                _ = StartEngine();
                return;
            }
            form.ShowProblem("작업 엔진이 계속 종료됩니다 (코드 " + Engine.Hex(code) + "). VIDE를 다시 실행하세요.");
        }

        public void ShowWindow()
        {
            if (Quitting) return;
            if (form.IsDisposed) form = new ShellForm(this);
            if (!form.Visible) form.Show();
            if (form.WindowState == FormWindowState.Minimized) form.WindowState = Settings.Maximized ? FormWindowState.Maximized : FormWindowState.Normal;
            form.Activate();
            if (engine.Url != null) form.Open(engine.Url);
        }

        /// <summary>The window closed with background mode on: keep running in the tray.</summary>
        public void Hidden()
        {
            if (Settings.TrayHintShown) return;
            Settings.TrayHintShown = true;
            Settings.Save();
            tray.ShowBalloonTip(5000, "VIDE", "창을 닫아도 트레이에서 계속 실행됩니다. 다른 기기에서도 열 수 있습니다.", ToolTipIcon.Info);
        }

        public void Quit(bool applyUpdate = false)
        {
            if (Quitting) return;
            Quitting = true;
            updateTimer.Stop();
            tray.Visible = false;
            try { form?.Close(); } catch { /* Closing anyway. */ }
            if (!engine.Attached) engine.Stop();
            showSignal.Set();
            if (applyUpdate) Updater.ApplyAndRestart();
            else Updater.ApplyAtExit();
            ExitThread();
        }

        private void OnUpdateClick()
        {
            if (Updater.State == "ready") Quit(true);
            else _ = Updater.Check();
        }

        private void OnUpdateChanged()
        {
            switch (Updater.State)
            {
                case "ready":
                    updateItem.Text = "재시작하여 업데이트 (" + Updater.Available + ")";
                    updateItem.Enabled = true;
                    tray.ShowBalloonTip(5000, "VIDE 업데이트 준비됨", Updater.Available + " 버전을 설치할 수 있습니다.", ToolTipIcon.Info);
                    break;
                case "checking": updateItem.Text = "업데이트 확인 중…"; updateItem.Enabled = false; break;
                case "downloading": updateItem.Text = "업데이트 내려받는 중 (" + Updater.Available + ")…"; updateItem.Enabled = false; break;
                case "current": updateItem.Text = "최신 버전 " + Paths.Version; updateItem.Enabled = true; break;
                case "unavailable": updateItem.Text = "업데이트 없음 (설치본 아님)"; updateItem.Enabled = false; break;
                case "error": updateItem.Text = "업데이트 확인 실패 · 다시 시도"; updateItem.Enabled = true; break;
                default: updateItem.Text = "업데이트 확인"; updateItem.Enabled = true; break;
            }
            form?.PostState();
        }

        /// <summary>Messages from the settings screen inside the window.</summary>
        public void Handle(Dictionary<string, object> message)
        {
            string type = message.TryGetValue("type", out var value) ? value as string : null;
            if (type == "desktop:set")
            {
                if (message.TryGetValue("autostart", out var autostart) && autostart is bool a) Settings.Autostart = a;
                if (message.TryGetValue("background", out var background) && background is bool b) Settings.Background = b;
                Settings.Save();
                try { Settings.ApplyAutostart(Paths.Launcher); } catch { /* Reported by state. */ }
            }
            else if (type == "update:check") _ = Updater.Check();
            else if (type == "update:apply" && Updater.State == "ready")
            {
                Quit(true);
                return;
            }
            else if (type == "folder:pick")
            {
                // 대시보드 › 프로젝트 폴더 (SPEC-01.13): the engine checks the chosen path.
                form?.PickFolder(message.TryGetValue("id", out var id) ? id as string : null);
                return;
            }
            form?.PostState();
        }

        public Dictionary<string, object> State() => new Dictionary<string, object>
        {
            ["type"] = "desktop:state",
            ["version"] = Paths.Version,
            ["settings"] = Settings.ToMessage(),
            ["update"] = Updater.ToMessage(),
            // This shell answers `folder:pick` with the Windows folder picker.
            ["folderPick"] = true,
        };

        /// <summary>The account website this PC is signed in to (for tray links).</summary>
        public static string Site()
        {
            try
            {
                var match = Regex.Match(File.ReadAllText(Path.Combine(Paths.Data, "remote-host.json")), "\"workerOrigin\"\\s*:\\s*\"(https://[^\"]+)\"");
                if (match.Success) return match.Groups[1].Value;
            }
            catch { /* Not signed in. */ }
            return DefaultSite;
        }

        public static void OpenExternal(string url)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != "https" && uri.Scheme != "http")) return;
            try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); } catch { /* No browser. */ }
        }

        private static Icon LoadIcon()
        {
            try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application; }
            catch { return SystemIcons.Application; }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                tray.Dispose();
                showSignal.Dispose();
                quitSignal.Dispose();
                updateTimer.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
