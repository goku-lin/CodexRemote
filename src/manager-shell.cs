using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using System.Management.Automation;
using System.Management.Automation.Runspaces;
using System.Threading;
using System.Security.Cryptography;
using System.Text;

static class CodexRemoteManager {
  [STAThread] static int Main(string[] args) {
    string root=AppDomain.CurrentDomain.BaseDirectory;
    bool check=Array.IndexOf(args,"--check-entry")>=0;
    try {
      int homeIndex=Array.IndexOf(args,"--home");
      if(homeIndex>=0){if(homeIndex+1>=args.Length)throw new Exception("缺少安装目录。");root=Path.GetFullPath(args[homeIndex+1]);}
      root=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar)+Path.DirectorySeparatorChar;
      string identity;
      using(var hash=SHA256.Create())identity=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()))).Replace("-","");
      using(var mutex=new Mutex(false,"Local\\CodexRemoteManager_"+identity)) {
      bool owned;try{owned=mutex.WaitOne(0);}catch(AbandonedMutexException){owned=true;}
      if(!owned){if(!check)MessageBox.Show("管理窗口已经打开，请在任务栏中切回。","Codex Remote");return 0;}
      try {
      string entry=Path.Combine(root,"manager-bootstrap.ps1");
      if(!File.Exists(entry))entry=Path.Combine(root,"scripts","manager-ui.ps1");
      if(!File.Exists(entry))entry=Path.Combine(root,"管理应用入口.ps1");
      if(!File.Exists(entry))throw new Exception("找不到管理应用入口，请保留启动程序与项目/连接器目录放在一起。");
      var initial=InitialSessionState.CreateDefault();
      initial.ExecutionPolicy=Microsoft.PowerShell.ExecutionPolicy.Bypass;
      using(var runspace=RunspaceFactory.CreateRunspace(initial)) {
        runspace.ApartmentState=ApartmentState.STA;runspace.ThreadOptions=PSThreadOptions.UseCurrentThread;runspace.Open();
        using(var shell=PowerShell.Create()) {
          shell.Runspace=runspace;shell.AddCommand(entry);
          bool verify=Array.IndexOf(args,"--verify-status")>=0;
          if(verify)shell.AddParameter("VerifyStatusOnly",true);
          var output=shell.Invoke();
          if(shell.HadErrors)throw new Exception(shell.Streams.Error[0].ToString());
          if(verify){if(output.Count!=1)throw new Exception("管理窗口状态验证未返回结果。");File.WriteAllText(Path.Combine(root,"manager-status-verification.json"),output[0].ToString(),new UTF8Encoding(false));}
        }
      }
      }finally{mutex.ReleaseMutex();}
      }
      return 0;
    } catch(Exception error) {
      try{File.WriteAllText(Path.Combine(root,"manager-launch-error.log"),error.ToString(),new UTF8Encoding(false));}catch{}
      if(check)Console.Error.WriteLine(error.Message);
      else MessageBox.Show(error.Message,"Codex Remote 启动失败",MessageBoxButtons.OK,MessageBoxIcon.Error);
      return 1;
    }
  }
}
