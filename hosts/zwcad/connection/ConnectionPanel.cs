using System;
using System.Diagnostics;
using System.IO;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Windows.Forms;
using ZwSoft.ZwCAD.Runtime;
using ZwSoft.ZwCAD.Windows;
using Cad = ZwSoft.ZwCAD.ApplicationServices.Application;

namespace Vide.Zwcad.Connection
{
    public sealed class ConnectionCommands
    {
        private static PaletteSet palette;
        [CommandMethod("VIDECADConnect", CommandFlags.Session)]
        public void Connect() { AttachedDocument.Connect(Cad.DocumentManager.MdiActiveDocument); Show(); }
        [CommandMethod("VIDECADDisconnect", CommandFlags.Session)]
        public void Disconnect() { AttachedDocument connection; if (AttachedDocument.Connections.TryGetValue(Cad.DocumentManager.MdiActiveDocument, out connection)) connection.Dispose(); }
        [CommandMethod("VIDECADSync", CommandFlags.Session)]
        public void Sync() { AttachedDocument.Connect(Cad.DocumentManager.MdiActiveDocument).Sync(); }
        [CommandMethod("VIDECADLiveSync", CommandFlags.Session)]
        public void Live() { var connection = AttachedDocument.Connect(Cad.DocumentManager.MdiActiveDocument); connection.Live = !connection.Live; if (connection.Live) connection.Sync(); Show(); }
        [CommandMethod("VIDECADPanel", CommandFlags.Session)]
        public void Show()
        {
            if (palette == null) {
                palette = new PaletteSet("VIDE CAD", new Guid("7393E7C2-156D-46DB-8898-B8DF5F1BBBD6"));
                palette.MinimumSize = new System.Drawing.Size(260, 280);
                palette.Size = new System.Drawing.Size(300, 360);
                palette.Add("연결", new ConnectionView());
            }
            palette.Visible = true;
        }
    }
    internal sealed class ConnectionView : UserControl
    {
        private readonly Label status = new Label { AutoSize = true, MaximumSize = new System.Drawing.Size(270, 0) };
        private readonly Label notice = new Label { AutoSize = true, MaximumSize = new System.Drawing.Size(270, 0) };
        private readonly Button connect, live;
        private readonly Timer timer = new Timer { Interval = 1000 };
        internal ConnectionView()
        {
            Dock = DockStyle.Fill;
            var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(12) };
            layout.Controls.Add(status);
            connect = Add(layout, "연결", () => {
                var doc = Cad.DocumentManager.MdiActiveDocument; AttachedDocument connection;
                if (AttachedDocument.Connections.TryGetValue(doc, out connection)) connection.Dispose(); else AttachedDocument.Connect(doc);
            });
            Add(layout, "지금 Sync", () => { var c = Current(); c.Sync(); notice.Text = "VIDE에서 같은 도면을 선택하면 갱신됩니다."; });
            live = Add(layout, "Live Sync 켜기", () => { var c = Current(); c.Live = !c.Live; if (c.Live) c.Sync(); });
            Add(layout, "VIDE 열기 / 인증 복구", () => {
                var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VIDE", "launch.json");
                var launch = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
                var uri = new Uri(Convert.ToString(launch["url"]));
                if (uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.UserInfo.Length != 0) throw new InvalidOperationException("로컬 VIDE 주소를 확인하세요.");
                Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            });
            notice.Text = "현재 도면의 읽기 연결입니다. 형상·파일 저장을 변경하지 않습니다.";
            layout.Controls.Add(notice); Controls.Add(layout);
            timer.Tick += (_, __) => RefreshState(); timer.Start(); RefreshState();
        }
        private AttachedDocument Current() { var doc = Cad.DocumentManager.MdiActiveDocument; if (doc == null) throw new InvalidOperationException("열린 도면이 없습니다."); return AttachedDocument.Connect(doc); }
        private Button Add(Control layout, string text, Action action) {
            var button = new Button { Text = text, Width = 250, Height = 32 };
            button.Click += (_, __) => { try { action(); RefreshState(); } catch (System.Exception error) { notice.Text = error.Message; } };
            layout.Controls.Add(button); return button;
        }
        private void RefreshState() {
            var doc = Cad.DocumentManager.MdiActiveDocument; AttachedDocument c = null;
            if (doc != null) AttachedDocument.Connections.TryGetValue(doc, out c);
            status.Text = (doc == null ? "열린 도면 없음" : Path.GetFileName(doc.Name)) + "\n" + (c == null ? "연결 안 됨" : "ZWCAD 연결됨") + "\n" + (c?.LastRead == null ? "아직 모델 조회 없음" : "마지막 조회 " + c.LastRead.Value.ToString("HH:mm:ss"));
            connect.Text = c == null ? "연결" : "연결 해제"; live.Text = c != null && c.Live ? "Live Sync 끄기" : "Live Sync 켜기";
        }
        protected override void Dispose(bool disposing) { if (disposing) timer.Dispose(); base.Dispose(disposing); }
    }
}
