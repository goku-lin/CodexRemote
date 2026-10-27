using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Collections.Generic;
public static class PackageContextProbe {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetCurrentPackageFullName(ref uint length,StringBuilder name);
    public static int Main(string[] args) {
        uint length=0;int code=GetCurrentPackageFullName(ref length,null);var name=new StringBuilder((int)Math.Max(length,1));
        if(code==122)code=GetCurrentPackageFullName(ref length,name);
        var json=new JavaScriptSerializer();
        var value=new Dictionary<string,object>{{"packageCode",code},{"packageFullName",name.ToString()},{"proxy",Environment.GetEnvironmentVariable("CODEX_CLI_PATH")},{"data",Environment.GetEnvironmentVariable("CODEX_RELAY_DATA_DIR")}};
        if(args.Length>1 && args[1]=="child") {
            var grandchildFile=args[0]+".grandchild.json";
            var info=new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,"\""+grandchildFile+"\" grandchild");info.UseShellExecute=false;info.CreateNoWindow=true;
            using(var child=Process.Start(info)){if(!child.WaitForExit(5000))throw new Exception("Grandchild probe timed out");}
            value["grandchild"]=json.DeserializeObject(File.ReadAllText(grandchildFile));
        }
        File.WriteAllText(args[0],json.Serialize(value),new UTF8Encoding(false));return 0;
    }
}
