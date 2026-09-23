using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using ZwSoft.ZwCAD.Runtime;

namespace Vide.Zwcad
{
    // One launch-time operation per owned process. Network only returns immutable results; no ActiveDocument lookup.
    public sealed class InspectorCommand
    {
        private static TcpListener listener;
        [CommandMethod("VIDEInspectDwg", CommandFlags.Session)]
        public void Run()
        {
            if (listener != null) return;
            string report = Environment.GetEnvironmentVariable("VIDE_WORKER_REPORT"), source = Environment.GetEnvironmentVariable("VIDE_WORKER_SOURCE");
            string token = Environment.GetEnvironmentVariable("VIDE_WORKER_TOKEN"), session = Environment.GetEnvironmentVariable("VIDE_WORKER_SESSION");
            Guid parsed;
            if (String.IsNullOrEmpty(report) || !Path.IsPathRooted(report) || File.Exists(report) || String.IsNullOrEmpty(source) || !Path.IsPathRooted(source) ||
                token == null || token.Length != 64 || !Guid.TryParse(session, out parsed)) return;
            try
            {
                // The host invokes this command on its command thread. Network threads only return immutable data.
                string output = Environment.GetEnvironmentVariable("VIDE_WORKER_OUTPUT");
                if (!String.IsNullOrEmpty(output)) DwgEditor.Edit(source, output, Environment.GetEnvironmentVariable("VIDE_WORKER_EDITS"));
                object model = DwgReader.Read(String.IsNullOrEmpty(output) ? source : output);
                Process process = Process.GetCurrentProcess();
                int pid = process.Id; string ticks = process.StartTime.ToUniversalTime().Ticks.ToString(), document = Guid.NewGuid().ToString();
                byte[] reply = Encode(new { ok = true, model });
                listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
                Write(report, new { pid, startTicks = ticks, sessionId = session, documentId = document, revision = 0, port = ((IPEndPoint)listener.LocalEndpoint).Port });
                Task.Run(delegate {
                    while (true)
                    {
                        TcpClient client; try { client = listener.AcceptTcpClient(); } catch { return; }
                        Serve(client, token, session, pid, ticks, document, reply);
                    }
                });
            }
            catch (System.Exception error)
            {
                string code = error is InvalidOperationException ? error.Message : "ZWCAD_EXECUTION_FAILED";
                Write(report + ".error.json", new { code });
            }
        }
        private static void Serve(TcpClient client, string token, string session, int pid, string ticks, string document, byte[] reply)
        {
            using (client)
            {
                client.ReceiveTimeout = 10000; client.SendTimeout = 10000;
                NetworkStream stream = client.GetStream();
                try
                {
                    byte[] header = Read(stream, 4); int size = IPAddress.NetworkToHostOrder(BitConverter.ToInt32(header, 0));
                    if (size < 1 || size > 65536) return;
                    var envelope = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(Read(stream, size)));
                    var request = (Dictionary<string, object>)envelope["params"];
                    string supplied = Value(request, "token");
                    int difference = 0;
                    if (supplied == null || supplied.Length != token.Length) throw new InvalidOperationException("UNAUTHORIZED");
                    for (int i = 0; i < token.Length; i++) difference |= token[i] ^ supplied[i];
                    if (difference != 0) throw new InvalidOperationException("UNAUTHORIZED");
                    if (Value(request, "sessionId") != session || Value(request, "pid") != pid.ToString() || Value(request, "startTicks") != ticks)
                        throw new InvalidOperationException("HOST_OWNERSHIP_MISMATCH");
                    if (Value(request, "documentId") != document) throw new InvalidOperationException("DOCUMENT_MISMATCH");
                    if (Value(envelope, "type") != "vide" || Value(request, "method") != "query") throw new InvalidOperationException("UNSUPPORTED_METHOD");
                    Reply(stream, reply);
                }
                catch (System.Exception error)
                {
                    try { Reply(stream, Encode(new { ok = false, code = error is InvalidOperationException ? error.Message : "HOST_INVALID_RESPONSE" })); } catch { /* Broken transport cannot accept a second reply; caller keeps unknown outcome. */ }
                }
            }
        }
        private static string Value(Dictionary<string, object> request, string key) { object value; return request.TryGetValue(key, out value) ? Convert.ToString(value) : null; }
        private static byte[] Read(Stream stream, int size)
        {
            byte[] bytes = new byte[size]; int offset = 0;
            while (offset < size) { int count = stream.Read(bytes, offset, size - offset); if (count == 0) throw new EndOfStreamException(); offset += count; }
            return bytes;
        }
        private static byte[] Encode(object result)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
            byte[] bytes = Encoding.UTF8.GetBytes(serializer.Serialize(new { status = "success", result }));
            if (bytes.Length > 16 * 1024 * 1024) throw new InvalidOperationException("IMPORT_LIMIT");
            return bytes;
        }
        private static void Reply(Stream stream, byte[] bytes)
        {
            byte[] header = BitConverter.GetBytes(IPAddress.HostToNetworkOrder(bytes.Length));
            stream.Write(header, 0, header.Length); stream.Write(bytes, 0, bytes.Length);
        }
        private static void Write(string path, object result)
        {
            File.WriteAllText(path + ".tmp", new JavaScriptSerializer().Serialize(result)); File.Move(path + ".tmp", path);
        }
    }
}
