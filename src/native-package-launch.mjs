import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,access,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {sourceDir} from './layout.mjs';

const execute=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const psQuote=value=>"'"+String(value).replaceAll("'","''")+"'";
export function windowsArgument(value){
  let result='"',slashes=0;
  for(const ch of String(value)){if(ch==='\\'){slashes++;continue;}result+='\\'.repeat(ch==='"'?slashes*2+1:slashes)+ch;slashes=0;}
  return result+'\\'.repeat(slashes*2)+'"';
}
export async function preparePackageLauncher(dataDir,{run=execute}={}){
  const source=path.join(sourceDir,'native-package-launch.cs'),bytes=await readFile(source),revision=createHash('sha256').update(bytes).digest('hex').slice(0,16);
  await mkdir(dataDir,{recursive:true});const helper=path.join(dataDir,'codex-package-launch-'+revision+'.exe');
  if(await access(helper).then(()=>true,()=>false))return helper;
  const temporary=helper+'.'+process.pid+'.exe',compiler=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  try{await run(compiler,['/nologo','/target:winexe','/optimize+','/r:System.Web.Extensions.dll','/out:'+temporary,source],{windowsHide:true,timeout:20000,maxBuffer:131072});await rename(temporary,helper);}
  finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  return helper;
}
export async function launchInPackage({packageInfo,executable,arguments:args=[],environment={},dataDir},{run=execute,helper,timeoutMs=10000}={}){
  if(!/^[A-Za-z0-9._-]+$/.test(packageInfo?.familyName||'') || !/^[A-Za-z0-9._-]+$/.test(packageInfo?.fullName||'') || !/^[A-Za-z0-9._-]+$/.test(packageInfo?.appId||''))throw new Error('Windows 应用身份无效。');
  helper ||= await preparePackageLauncher(dataDir,{run});
  const id=randomUUID(),requestFile=path.join(dataDir,'package-launch-'+id+'.json'),receiptFile=path.join(dataDir,'package-launch-'+id+'-result.json');
  await writeFile(requestFile,JSON.stringify({packageFullName:packageInfo.fullName,executable,arguments:args,environment,receiptFile}),{mode:0o600});
  // Do not use -PreventBreakaway: the helper applies identity to the GUI only.
  const command=`$ErrorActionPreference='Stop'; Invoke-CommandInDesktopPackage -PackageFamilyName ${psQuote(packageInfo.familyName)} -AppId ${psQuote(packageInfo.appId)} -Command ${psQuote(helper)} -Args ${psQuote(windowsArgument(requestFile))}`;
  try{
    await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:15000,maxBuffer:131072});
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      let receipt;try{receipt=JSON.parse(await readFile(receiptFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(receipt){if(receipt.version!==1 || !receipt.ok)throw new Error(receipt.error||'Windows 应用身份启动失败。');if(receipt.packageFullName!==packageInfo.fullName || !Number.isInteger(receipt.processId) || receipt.processId<1)throw new Error('未确认新桌面的 Windows 应用身份。');return receipt;}
      await pause(100);
    }
    throw new Error('Windows 应用身份启动未返回确认结果；未回退到普通 EXE 启动。');
  }finally{for(const file of [requestFile,receiptFile])await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
export async function desktopPackageInfo(appRoot,{run=execute}={}){
  appRoot=path.resolve(appRoot);
  const command=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $taskPackage=Get-AppxPackage 'OpenAI.Codex' | Where-Object { $_.InstallLocation -eq ${psQuote(appRoot)} } | Select-Object -First 1; if(-not $taskPackage){throw 'Installed desktop package does not match'}; $taskPackage | Select-Object PackageFamilyName,PackageFullName | ConvertTo-Json -Compress`;
  const value=JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:15000,maxBuffer:65536})).stdout.replace(/^\ufeff/,'').trim());
  const manifest=await readFile(path.join(appRoot,'AppxManifest.xml'),'utf8');
  const tags=manifest.match(/<Application\s[^>]+>/g)||[];
  const application=tags.map(tag=>Object.fromEntries([...tag.matchAll(/([A-Za-z]+)="([^"]*)"/g)].map(match=>[match[1],match[2]]))).find(value=>value.Executable?.replaceAll('\\','/').toLowerCase()==='app/chatgpt.exe');
  if(!application?.Id)throw new Error('无法确定官方桌面的 Windows 应用入口。');
  return {familyName:value.PackageFamilyName,fullName:value.PackageFullName,appId:application.Id};
}
export async function launchPackagedDesktop({appRoot,proxy,dataDir}){
  const packageInfo=await desktopPackageInfo(appRoot);
  return launchInPackage({packageInfo,executable:path.join(appRoot,'app','ChatGPT.exe'),dataDir,environment:{CODEX_CLI_PATH:proxy,CODEX_RELAY_DATA_DIR:dataDir}});
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const flag=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
  try{
    const rawAppRoot=flag('--app-root'),rawProxy=flag('--proxy'),rawDataDir=flag('--data-dir');
    if(!rawAppRoot || !rawProxy || !rawDataDir)throw new Error('请从现有原生连接入口启动桌面。');
    // PowerShell can pass a rooted path with a trailing separator or a
    // connector-relative path. Normalize all three local paths before the
    // package identity check so the launcher does not reject a valid entry.
    const appRoot=path.resolve(rawAppRoot),proxy=path.resolve(rawProxy),dataDir=path.resolve(rawDataDir);
    const result=await launchPackagedDesktop({appRoot,proxy,dataDir});console.log('已保留官方 Windows 应用身份打开桌面，进程 '+result.processId);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
