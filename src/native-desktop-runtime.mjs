import {open, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);

// An arbitrary relocated cache can belong to an older desktop build. Resolve
// the CLI from the app package that we are actually about to launch instead.
export async function desktopRuntimePath(appRoot){
  if(typeof appRoot!=='string' || !path.isAbsolute(appRoot))throw new Error('Codex 桌面安装路径无效。');
  for(const relative of ['resources/codex.exe','resources/app.asar.unpacked/codex.exe']){
    const file=path.join(appRoot,'app',relative);
    let handle;
    try{
      handle=await open(file,'r');
      const header=Buffer.alloc(2);
      if((await handle.read(header,0,2,0)).bytesRead===2 && header.toString()==='MZ')return file;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    finally{await handle?.close();}
  }
  throw new Error('当前 Codex 桌面的运行程序缺失或无效，请先正常打开 Codex 并完成应用更新。');
}

export async function installedDesktopRoot(){
  const command="$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $desktopPackage = Get-AppxPackage 'OpenAI.Codex' | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1; if (-not $desktopPackage) { throw '未找到 Codex 桌面应用。' }; Write-Output $desktopPackage.InstallLocation";
  const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:20_000});
  return stdout.trim();
}

export async function refreshDesktopRuntime(configFile,appRoot,{run=execute}={}){
  const previous=JSON.parse(await readFile(configFile,'utf8'));
  const cliPath=await desktopRuntimePath(appRoot);
  const {stdout}=await run(cliPath,['--version'],{windowsHide:true,timeout:15_000,maxBuffer:131072});
  const cliVersion=stdout.trim();
  if(!/^codex(?:-cli)? /m.test(cliVersion))throw new Error('当前 Codex 桌面的运行程序验证失败。');
  const configuration={...previous,cliPath,cliVersion,desktopRoot:appRoot};
  if(JSON.stringify(configuration)!==JSON.stringify(previous)){
    const temporary=configFile+'.'+process.pid+'.tmp';
    try{
      await writeFile(temporary,JSON.stringify(configuration,null,2),{mode:0o600});
      await rename(temporary,configFile);
    }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  return configuration;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const value=flag=>{const index=process.argv.indexOf(flag);return index<0?undefined:process.argv[index+1];};
  try{
    const config=value('--config'),appRoot=value('--app-root');
    if(!config || !appRoot)throw new Error('请通过 Codex Relay 的启动入口核对桌面运行程序。');
    const configuration=await refreshDesktopRuntime(config,appRoot);
    console.log('已核对当前桌面运行程序：'+configuration.cliVersion);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
