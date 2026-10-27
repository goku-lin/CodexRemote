using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Drawing;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Text.RegularExpressions;

static class CodexRemoteSetup {
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
  static string InstalledExecutable,InstalledHome;
  static byte[] Resource(string name){using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream(name))using(var output=new MemoryStream()){stream.CopyTo(output);return output.ToArray();}}
  static string Quote(string value){
    var result=new StringBuilder("\"");int slashes=0;
    foreach(char ch in value){if(ch=='\\'){slashes++;continue;}if(ch=='"')result.Append('\\',slashes*2+1);else result.Append('\\',slashes);slashes=0;result.Append(ch);}
    result.Append('\\',slashes*2);return result.Append('"').ToString();
  }
  static bool Installed(string directory){return !String.IsNullOrEmpty(directory)&&File.Exists(Path.Combine(directory,"current.json"))&&File.Exists(Path.Combine(directory,"state","connector.json"));}
  static string InstallationParent(string candidate){
    try{string directory=File.Exists(candidate)?Path.GetDirectoryName(candidate):candidate;for(int i=0;i<5&&!String.IsNullOrEmpty(directory);i++,directory=Path.GetDirectoryName(directory)){if(Installed(directory))return directory;}}catch{}return null;
  }
  static string ExistingHome(){
    string beside=AppDomain.CurrentDomain.BaseDirectory;if(Installed(beside))return beside;
    try{
      object shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
      string link=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Desktop),"Codex远程.lnk");
      if(File.Exists(link)){
        object shortcut=shell.GetType().InvokeMember("CreateShortcut",BindingFlags.InvokeMethod,null,shell,new object[]{link});
        string target=(string)shortcut.GetType().InvokeMember("TargetPath",BindingFlags.GetProperty,null,shortcut,null);
        string arguments=(string)shortcut.GetType().InvokeMember("Arguments",BindingFlags.GetProperty,null,shortcut,null);
        int start=arguments.IndexOf("--home \"",StringComparison.Ordinal);
        if(start>=0){int end=arguments.IndexOf('"',start+8);if(end>start){string home=arguments.Substring(start+8,end-start-8);if(Installed(home))return home;}}
        string folder=InstallationParent(target);if(folder!=null)return folder;
        foreach(Match quoted in Regex.Matches(arguments,"\"([^\"]+)\"")){folder=InstallationParent(quoted.Groups[1].Value);if(folder!=null)return folder;}
      }
    }catch{}
    foreach(string directory in new[]{@"D:\CodexRelayConnector",Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexRelayConnector")})if(Installed(directory))return directory;
    return null;
  }
  static async Task<string> Install(string home,bool noShortcut,bool fresh){
    if(String.IsNullOrWhiteSpace(home))throw new Exception("请选择原安装目录。首次使用请明确选择“首次安装”。");
    if(!fresh&&!Installed(home))throw new Exception("此目录未找到已有安装，未创建任何新目录。请选择原安装目录。");
    if(fresh&&Installed(home))throw new Exception("此目录已有安装，请选择“修复已有安装”。");
    string staging=Path.Combine(Path.GetTempPath(),"CodexRemote-setup-"+Guid.NewGuid().ToString("N"));
    try{
      Directory.CreateDirectory(staging);
      byte[] archive=Resource("Connector.zip"),manifestBytes=Resource("Manifest.json");
      var manifest=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(manifestBytes));
      string digest;using(var hash=SHA256.Create())digest=BitConverter.ToString(hash.ComputeHash(archive)).Replace("-","").ToLowerInvariant();
      if(digest!=(string)manifest["sha256"])throw new Exception("安装包校验失败，未修改已有安装。");
      using(var zip=new ZipArchive(new MemoryStream(archive),ZipArchiveMode.Read)){
        long total=0;if(zip.Entries.Count>320)throw new Exception("安装包文件数异常。");
        string prefix=Path.GetFullPath(staging)+Path.DirectorySeparatorChar;
        foreach(var entry in zip.Entries){
          total+=entry.Length;if(total>250000000||entry.Length>130000000)throw new Exception("安装包大小异常。");
          string target=Path.GetFullPath(Path.Combine(staging,entry.FullName.Replace('/',Path.DirectorySeparatorChar)));
          if(!target.StartsWith(prefix,StringComparison.OrdinalIgnoreCase)||entry.FullName.Contains(".."))throw new Exception("安装包路径异常。");
          Directory.CreateDirectory(Path.GetDirectoryName(target));entry.ExtractToFile(target);
        }
      }
      File.WriteAllBytes(Path.Combine(staging,".setup-manifest.json"),manifestBytes);
      var info=new ProcessStartInfo(Path.Combine(staging,"runtime","node.exe"),Quote(Path.Combine(staging,"app","install-manager-package.mjs"))+" --home "+Quote(Path.GetFullPath(home))+" --package "+Quote(staging)+(noShortcut?" --no-shortcut":"")+(fresh?" --fresh":""));
      info.UseShellExecute=false;info.CreateNoWindow=true;info.RedirectStandardOutput=true;info.RedirectStandardError=true;
      info.StandardOutputEncoding=new UTF8Encoding(false);info.StandardErrorEncoding=new UTF8Encoding(false);
      using(var process=Process.Start(info)){
        var stdout=process.StandardOutput.ReadToEndAsync();var stderr=process.StandardError.ReadToEndAsync();
        await Task.Run(()=>process.WaitForExit());string output=await stdout;await stderr;
        string[] lines=output.Trim().Split(new[]{'\r','\n'},StringSplitOptions.RemoveEmptyEntries);
        if(lines.Length==0)throw new Exception("安装程序未返回结果，已有服务未停止。");
        var result=Json.Deserialize<Dictionary<string,object>>(lines[lines.Length-1]);
        if(process.ExitCode!=0||!result.ContainsKey("ok")||!(bool)result["ok"])throw new Exception(result.ContainsKey("error")?(string)result["error"]:"安装未完成。");
        InstalledExecutable=(string)result["executable"];InstalledHome=Path.GetFullPath(home);return (string)result["message"];
      }
    }finally{
      string full=Path.GetFullPath(staging),prefix=Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
      if(full.StartsWith(prefix,StringComparison.OrdinalIgnoreCase)&&Path.GetFileName(full).StartsWith("CodexRemote-setup-",StringComparison.Ordinal))try{Directory.Delete(full,true);}catch{}
    }
  }
  [STAThread] static int Main(string[] args){
    int verify=Array.IndexOf(args,"--verify-install");
    if(verify>=0){try{if(verify+1>=args.Length)throw new Exception("Missing test directory");string result=Install(args[verify+1],true,Array.IndexOf(args,"--fresh")>=0).GetAwaiter().GetResult();File.WriteAllText(Path.Combine(args[verify+1],"setup-verification.json"),Json.Serialize(new{ok=true,message=result}),new UTF8Encoding(false));return 0;}catch(Exception error){if(verify+1<args.Length&&Directory.Exists(args[verify+1]))File.WriteAllText(Path.Combine(args[verify+1],"setup-verification.json"),Json.Serialize(new{ok=false,error=error.Message}),new UTF8Encoding(false));return 1;}}
    Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
    var window=new Form{Text="Codex Remote · 安装与修复",Width=640,Height=405,MinimumSize=new Size(640,405),StartPosition=FormStartPosition.CenterScreen,BackColor=Color.FromArgb(26,29,34),ForeColor=Color.White,Font=new Font("Microsoft YaHei UI",10)};
    var title=new Label{Text="修复或安装 Codex Remote",Left=24,Top=22,Width=560,Height=36,Font=new Font("Microsoft YaHei UI",18,FontStyle.Bold)};
    var hint=new Label{Text="已有安装直接在原目录修复，保留配置、授权和正在运行的任务。",Left=24,Top=68,Width=570,Height=46};
    var repair=new RadioButton{Text="修复已有安装（默认）",Checked=true,Left=24,Top=117,Width=240,Height=28};
    var fresh=new RadioButton{Text="首次安装",Left=300,Top=117,Width=180,Height=28};
    string detected=ExistingHome();
    var folder=new TextBox{Text=detected??"",Left=24,Top=166,Width=465};
    var browse=new Button{Text="选择目录",Left=500,Top=163,Width=96,Height=32};
    var status=new Label{Text=detected!=null?"已找到原安装目录，将修复同一套程序。":"未找到原安装。请选择原目录；确认从未安装时，才选择“首次安装”。",Left=24,Top=209,Width=570,Height=76};
    var install=new Button{Text="修复已有安装",Left=450,Top=298,Width=146,Height=39,BackColor=Color.FromArgb(98,221,176),ForeColor=Color.FromArgb(16,36,29),FlatStyle=FlatStyle.Flat};
    bool busy=false,done=false;
    fresh.CheckedChanged+=(s,e)=>{if(busy||done)return;install.Text=fresh.Checked?"首次安装":"修复已有安装";folder.Text=fresh.Checked?Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexRelayConnector"):detected??"";status.Text=fresh.Checked?"仅首次使用请选择此项；已有安装请返回“修复已有安装”。":"请选择原安装目录，不会自动另建一套。";};
    browse.Click+=(s,e)=>{using(var dialog=new FolderBrowserDialog{SelectedPath=folder.Text,Description="选择已有 Codex Remote 安装目录，或新的空文件夹"})if(dialog.ShowDialog(window)==DialogResult.OK)folder.Text=dialog.SelectedPath;};
    install.Click+=async(s,e)=>{if(busy)return;if(done){try{Process.Start(new ProcessStartInfo(InstalledExecutable,"--home "+Quote(InstalledHome)){UseShellExecute=true});window.Close();}catch(Exception error){status.Text=error.Message;}return;}busy=true;install.Enabled=false;browse.Enabled=false;folder.Enabled=false;repair.Enabled=false;fresh.Enabled=false;status.Text="正在校验并处理完整管理程序…";try{status.Text=await Install(folder.Text,false,fresh.Checked);done=true;install.Text="打开管理程序";install.Enabled=true;}catch(Exception error){status.Text=error.Message;install.Enabled=true;}finally{busy=false;browse.Enabled=!done;folder.Enabled=!done;repair.Enabled=!done;fresh.Enabled=!done;}};
    window.FormClosing+=(s,e)=>{if(busy){e.Cancel=true;status.Text="正在完成安装，请稍候。Codex 与现有服务保持运行。";}};
    window.Controls.AddRange(new Control[]{title,hint,repair,fresh,folder,browse,status,install});
    if(Array.IndexOf(args,"--preview")>=0){window.Text+="（预览）";install.Enabled=false;var timer=new Timer{Interval=60000};timer.Tick+=(s,e)=>{timer.Stop();window.Close();};timer.Start();}
    Application.Run(window);return 0;
  }
}
