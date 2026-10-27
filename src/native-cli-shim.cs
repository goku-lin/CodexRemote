using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

// Only a process launcher: it never reads or edits Codex conversation history.
public static class RelayNativeCli {
    static void Pump(Stream input, Stream output) {
        var buffer = new byte[81920];
        int count;
        while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
            output.Write(buffer, 0, count);
            output.Flush();
        }
    }
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            slashes = 0;
            result.Append(ch);
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }
    public static int Main(string[] args) {
        try {
            var arguments = new StringBuilder();
            arguments.Append(Quote(__PROXY_PATH__)).Append(' ').Append(Quote(__CONFIG_PATH__));
            foreach (string arg in args) arguments.Append(' ').Append(Quote(arg));
            var info = new ProcessStartInfo(__NODE_PATH__, arguments.ToString());
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            using (var child = Process.Start(info)) {
                // Copy bytes, preserving JSONL, UTF-8 and image payloads unchanged.
                Task.Factory.StartNew(() => {
                    try { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
                    catch (Exception) { }
                    finally { try { child.StandardInput.Close(); } catch (Exception) { } }
                });
                var output = Task.Factory.StartNew(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
                var errors = Task.Factory.StartNew(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError()));
                child.WaitForExit();
                Task.WaitAll(output, errors);
                return child.ExitCode;
            }
        } catch (Exception error) {
            Console.Error.WriteLine("Relay CLI launcher: " + error.Message);
            return 1;
        }
    }
}
