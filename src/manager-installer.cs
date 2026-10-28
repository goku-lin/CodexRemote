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
    string standard=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexRemote");if(Installed(standard))return standard;
    return null;
  }
  static async Task<string> Install(string home,bool noShortcut){
    if(String.IsNullOrWhiteSpace(home))throw new Exception("请选择应用安装目录。");
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
      string version=(string)manifest["version"];if(!Regex.IsMatch(version,"^[a-f0-9]{20}$"))throw new Exception("应用版本信息无效。");
      string application=Path.Combine(staging,"versions",version);
      var info=new ProcessStartInfo(Path.Combine(application,"runtime","node.exe"),Quote(Path.Combine(application,"app","install-manager-package.mjs"))+" --home "+Quote(Path.GetFullPath(home))+" --package "+Quote(staging)+(noShortcut?" --no-shortcut":""));
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
    if(verify>=0){
      try{
        if(verify+1>=args.Length)throw new Exception("Missing test directory");
        string result=Install(args[verify+1],true).GetAwaiter().GetResult();
        File.WriteAllText(Path.Combine(args[verify+1],"setup-verification.json"),Json.Serialize(new{ok=true,message=result}),new UTF8Encoding(false));return 0;
      }catch(Exception error){
        if(verify+1<args.Length&&Directory.Exists(args[verify+1]))File.WriteAllText(Path.Combine(args[verify+1],"setup-verification.json"),Json.Serialize(new{ok=false,error=error.Message}),new UTF8Encoding(false));return 1;
      }
    }
    Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
    var window=new Form{Text="Codex Remote 安装",Width=640,Height=365,MinimumSize=new Size(640,365),StartPosition=FormStartPosition.CenterScreen,BackColor=Color.FromArgb(26,29,34),ForeColor=Color.White,Font=new Font("Microsoft YaHei UI",10)};
    var title=new Label{Text="Codex Remote",Left=24,Top=22,Width=560,Height=38,Font=new Font("Microsoft YaHei UI",20,FontStyle.Bold)};
    var hint=new Label{Text="安装后，通过桌面应用管理 Codex、连接与更新。",Left=24,Top=72,Width=570,Height=32};
    string detected=ExistingHome();
    var folder=new TextBox{Text=detected??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexRemote"),Left=24,Top=125,Width=465};
    var browse=new Button{Text="更改位置",Left=500,Top=122,Width=96,Height=32};
    var status=new Label{Text=detected!=null?"已找到现有应用，将在原位置更新并保留配置。更新时远程网页会短暂重连，请先完成正在运行的任务。":"准备安装。配置和浏览器配对由此电脑独立保存。",Left=24,Top=174,Width=570,Height=75};
    var install=new Button{Text=detected!=null?"更新":"安装",Left=450,Top=260,Width=146,Height=39,BackColor=Color.FromArgb(98,221,176),ForeColor=Color.FromArgb(16,36,29),FlatStyle=FlatStyle.Flat};
    bool busy=false,done=false;
    folder.TextChanged+=(s,e)=>{if(!busy&&!done)install.Text=Installed(folder.Text)?"更新":"安装";};
    browse.Click+=(s,e)=>{using(var dialog=new FolderBrowserDialog{SelectedPath=folder.Text,Description="选择 Codex Remote 安装位置"})if(dialog.ShowDialog(window)==DialogResult.OK)folder.Text=dialog.SelectedPath;};
    install.Click+=async(s,e)=>{
      if(busy)return;
      if(done){try{Process.Start(new ProcessStartInfo(InstalledExecutable){UseShellExecute=true});window.Close();}catch(Exception error){status.Text=error.Message;}return;}
      busy=true;install.Enabled=false;browse.Enabled=false;folder.Enabled=false;status.Text=Installed(folder.Text)?"正在更新应用…":"正在安装应用…";
      try{status.Text=await Install(folder.Text,false);done=true;install.Text="打开应用";install.Enabled=true;}
      catch(Exception error){status.Text=error.Message;install.Enabled=true;}
      finally{busy=false;browse.Enabled=!done;folder.Enabled=!done;}
    };
    window.FormClosing+=(s,e)=>{if(busy){e.Cancel=true;status.Text="正在完成安装，请稍候。";}};
    window.Controls.AddRange(new Control[]{title,hint,folder,browse,status,install});
    if(Array.IndexOf(args,"--preview")>=0){window.Text+="（预览）";install.Enabled=false;var timer=new Timer{Interval=60000};timer.Tick+=(s,e)=>{timer.Stop();window.Close();};timer.Start();}
    Application.Run(window);return 0;
  }
}
