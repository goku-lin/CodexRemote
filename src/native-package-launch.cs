using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

// Run by Windows in the installed app's package context. Only the GUI keeps
// that context; its children retain Windows' normal breakaway behavior.
public static class RelayPackageLaunch {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct StartupInfo {
        public int cb; public string reserved,desktop,title;
        public int x,y,xSize,ySize,xChars,yChars,fill,flags;
        public short show,reservedBytes; public IntPtr reservedData,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx { public StartupInfo startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process,thread; public int processId,threadId; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]
    static extern int GetCurrentPackageFullName(ref uint length,StringBuilder name);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]
    static extern int GetPackageFullName(IntPtr process,ref uint length,StringBuilder name);
    [DllImport("kernel32.dll",SetLastError=true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern bool CreateProcess(string file,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx startup,out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static string PackageName(IntPtr process) {
        uint length=0;
        int code=process==IntPtr.Zero ? GetCurrentPackageFullName(ref length,null) : GetPackageFullName(process,ref length,null);
        if(code!=122)throw new Win32Exception(code,"Windows application identity is unavailable");
        var name=new StringBuilder((int)length);
        code=process==IntPtr.Zero ? GetCurrentPackageFullName(ref length,name) : GetPackageFullName(process,ref length,name);
        if(code!=0)throw new Win32Exception(code,"Cannot verify Windows application identity");
        return name.ToString();
    }
    static string Quote(string value) {
        var result=new StringBuilder("\"");int slashes=0;
        foreach(char ch in value) {
            if(ch=='\\'){slashes++;continue;}
            result.Append('\\',ch=='"' ? slashes*2+1 : slashes);slashes=0;result.Append(ch);
        }
        return result.Append('\\',slashes*2).Append('"').ToString();
    }
    static IntPtr EnvironmentBlock(IDictionary<string,object> additions) {
        var values=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        foreach(DictionaryEntry entry in Environment.GetEnvironmentVariables())values[(string)entry.Key]=(string)entry.Value;
        foreach(var entry in additions) {
            if(entry.Key.IndexOf('=')>=0 || entry.Key.IndexOf('\0')>=0)throw new Exception("Invalid environment name");
            if(entry.Value==null)values.Remove(entry.Key);
            else { var value=Convert.ToString(entry.Value);if(value.IndexOf('\0')>=0)throw new Exception("Invalid environment value");values[entry.Key]=value; }
        }
        var block=new StringBuilder();foreach(var entry in values)block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }
    public static int Main(string[] args) {
        string receipt=null;var json=new JavaScriptSerializer();var result=new Dictionary<string,object>{{"version",1},{"ok",false}};
        IntPtr list=IntPtr.Zero,policy=IntPtr.Zero,environment=IntPtr.Zero;bool initialized=false;var process=new ProcessInfo();
        try {
            if(args.Length!=1)throw new Exception("Expected a launch request file");
            var text=File.ReadAllText(args[0]);if(text.Length>65536)throw new Exception("Launch request is too large");
            var request=json.Deserialize<Dictionary<string,object>>(text);
            receipt=(string)request["receiptFile"];
            var expected=(string)request["packageFullName"];
            var identity=PackageName(IntPtr.Zero);
            if(identity!=expected)throw new Exception("Windows application identity does not match the selected package");
            var file=(string)request["executable"];
            if(!Path.IsPathRooted(file)||!File.Exists(file))throw new Exception("Desktop executable is unavailable");
            var command=new StringBuilder(Quote(file));
            foreach(var argument in (IEnumerable)request["arguments"])command.Append(' ').Append(Quote((string)argument));
            environment=EnvironmentBlock((Dictionary<string,object>)request["environment"]);
            IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            if(size==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
            list=Marshal.AllocHGlobal(size);
            if(!InitializeProcThreadAttributeList(list,1,0,ref size))throw new Win32Exception(Marshal.GetLastWin32Error());
            initialized=true;policy=Marshal.AllocHGlobal(4);
            // DESKTOP_APP_BREAKAWAY_OVERRIDE applies package identity to this
            // process only. Do not force the entire command/tool process tree
            // into the packaged filesystem/registry environment.
            Marshal.WriteInt32(policy,4);
            if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x20012),policy,new IntPtr(4),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
            var startup=new StartupInfoEx();startup.startup.cb=Marshal.SizeOf(typeof(StartupInfoEx));startup.startup.flags=1;startup.startup.show=1;startup.attributes=list;
            if(!CreateProcess(file,command,IntPtr.Zero,IntPtr.Zero,false,0x00080000|0x00000400,environment,Path.GetDirectoryName(file),ref startup,out process))throw new Win32Exception(Marshal.GetLastWin32Error());
            var childIdentity=PackageName(process.process);
            if(childIdentity!=expected)throw new Exception("The launched desktop did not retain its Windows application identity");
            result["ok"]=true;result["processId"]=process.processId;result["packageFullName"]=childIdentity;
            return 0;
        } catch(Exception error) {
            result["error"]=error.Message;return 1;
        } finally {
            if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);
            if(process.process!=IntPtr.Zero)CloseHandle(process.process);
            if(initialized)DeleteProcThreadAttributeList(list);
            if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);
            if(policy!=IntPtr.Zero)Marshal.FreeHGlobal(policy);
            if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);
            if(receipt!=null)File.WriteAllText(receipt,json.Serialize(result),new UTF8Encoding(false));
        }
    }
}
