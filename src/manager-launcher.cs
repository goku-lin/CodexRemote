using System;
using System.IO;
using System.Diagnostics;
using System.Text;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Text.RegularExpressions;

static class CodexRemoteLauncher {
  static string Quote(string value) {
    var text=new StringBuilder("\"");int slashes=0;
    foreach(char c in value){if(c=='\\'){slashes++;continue;}text.Append('\\',c=='"'?slashes*2+1:slashes);slashes=0;text.Append(c);}
    text.Append('\\',slashes*2);return text.Append('"').ToString();
  }
  [STAThread] static int Main(string[] args) {
    string home=AppDomain.CurrentDomain.BaseDirectory;
    bool verify=Array.IndexOf(args,"--check-entry")>=0;
    try {
      int at=Array.IndexOf(args,"--home");if(at>=0){if(at+1>=args.Length)throw new Exception("缺少应用目录。");home=Path.GetFullPath(args[at+1]);}
      var json=new JavaScriptSerializer();
      var selection=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(home,"manager.json")));
      string version=(string)selection["version"];if(!Regex.IsMatch(version,"^[a-f0-9]{20}$"))throw new Exception("应用版本记录无效。");
      string root=Path.Combine(home,"versions",version),node=Path.Combine(root,"runtime","node.exe");
      if(!File.Exists(Path.Combine(home,"state","connector.json"))) {
        var initialize=new ProcessStartInfo(node,Quote(Path.Combine(root,"app","portable-start.mjs"))+" --home "+Quote(home));
        initialize.UseShellExecute=false;initialize.CreateNoWindow=true;initialize.RedirectStandardOutput=true;initialize.RedirectStandardError=true;
        initialize.StandardOutputEncoding=new UTF8Encoding(false);initialize.StandardErrorEncoding=new UTF8Encoding(false);
        using(var child=Process.Start(initialize)){
          var output=child.StandardOutput.ReadToEndAsync();var error=child.StandardError.ReadToEndAsync();
          if(!child.WaitForExit(60000)){child.Kill();throw new Exception("首次启动准备超时，请重新打开应用。");}
          if(child.ExitCode!=0)throw new Exception(error.Result.Trim());
          var ignored=output.Result;
        }
      }
      if(verify && Array.IndexOf(args,"--initialize-only")>=0)return 0;
      var info=new ProcessStartInfo(Path.Combine(root,"app","manager-host.exe"),"--home "+Quote(home)+(verify?" --check-entry":"")+(Array.IndexOf(args,"--verify-status")>=0?" --verify-status":""));
      info.UseShellExecute=false;info.CreateNoWindow=true;info.WorkingDirectory=home;
      using(var child=Process.Start(info)){if(verify){child.WaitForExit();return child.ExitCode;}}
      return 0;
    } catch(Exception error) {
      try{File.WriteAllText(Path.Combine(home,"application-error.log"),error.ToString(),new UTF8Encoding(false));}catch{}
      if(verify)Console.Error.WriteLine(error.Message);else MessageBox.Show(error.Message,"Codex Remote",MessageBoxButtons.OK,MessageBoxIcon.Error);
      return 1;
    }
  }
}
