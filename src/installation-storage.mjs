import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const versionPattern=/^[a-f0-9]{20}$/;
const digest=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
// Version runtimes are immutable. Identical runtimes can share disk blocks on
// NTFS; never link the stable service runtime, which has its own update path.
export async function reuseRuntime(home,directory){
  const target=path.join(directory,'runtime/node.exe'),hash=await digest(target);
  const versions=path.join(home,'versions');
  for(const name of await fs.readdir(versions).catch(()=>[])){
    if(!versionPattern.test(name))continue;
    const source=path.join(versions,name,'runtime/node.exe');
    if(path.resolve(source)===path.resolve(target))continue;
    const temporary=target+'.link-'+randomUUID();
    try{
      if(await digest(source)!==hash)continue;
      await fs.link(source,temporary);await fs.rename(temporary,target);
      return {sharedRuntimeBytes:(await fs.stat(target)).size};
    }catch{}finally{await fs.unlink(temporary).catch(()=>{});}
  }
  return {sharedRuntimeBytes:0};
}
async function inventory(directory){
  const result={};
  async function walk(folder){
    for(const entry of await fs.readdir(folder,{withFileTypes:true})){
      if(folder===directory&&entry.name==='.managed-release.json')continue;
      const file=path.join(folder,entry.name),relative=path.relative(directory,file).replaceAll('\\','/');
      if(entry.isSymbolicLink())throw new Error('Linked release files');
      if(entry.isDirectory())await walk(file);
      else if(entry.isFile())result[relative]=await digest(file);
      else throw new Error('Unknown release file');
    }
  }
  await walk(directory);return result;
}
export async function recordManagedRelease(directory){
  const version=path.basename(directory);
  if(!versionPattern.test(version)||(await read(path.join(directory,'release.json'))).version!==version)throw new Error('Release storage identity');
  await fs.writeFile(path.join(directory,'.managed-release.json'),JSON.stringify({schema:1,version,files:await inventory(directory)}));
}
export async function runningInstallationReferences(home){
  if(process.platform!=='win32')throw new Error('Process inventory unavailable');
  // Only return identifiers within this installation, never process arguments
  // (which can contain authentication data).
  const command="$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $root=$env:CODEX_STORAGE_HOME.TrimEnd('\\')+'\\'; $v=@(); foreach($p in Get-CimInstance Win32_Process) { if($p.Name -notmatch '^(node|ChatGPT|CodexRemote|manager-host|codex-native-proxy.*)\\.exe$'){continue}; if(-not $p.ExecutablePath -or -not $p.CommandLine){throw 'Process inventory incomplete'}; $text=([string]$p.ExecutablePath)+' '+([string]$p.CommandLine); foreach($m in [regex]::Matches($text,[regex]::Escape($root)+'versions\\\\([a-f0-9]{20})(?=[\\\\/\"\\s]|$)')){$v+=$m.Groups[1].Value}; foreach($m in [regex]::Matches($text,[regex]::Escape($root)+'state\\\\codex-native-proxy-([a-f0-9]{20})\\.exe')){$v+=$m.Groups[1].Value} }; @{versions=@($v)} | ConvertTo-Json -Compress";
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:15000,env:{...process.env,CODEX_STORAGE_HOME:home}});
  const result=JSON.parse(stdout.replace(/^\ufeff/,''));
  if(!Array.isArray(result.versions))throw new Error('Process inventory invalid');
  return result;
}
export async function cleanupManagedReleases(home,{references=runningInstallationReferences,keep=[]}={}){
  home=await fs.realpath(home);
  const base=path.join(home,'versions'),removed=[],skipped=[];
  if(await fs.realpath(base)!==base)throw new Error('Release cleanup path');
  const protectedVersions=new Set(keep.filter(value=>versionPattern.test(value)));
  for(const name of ['current.json','manager.json']){
    const value=await read(path.join(home,name)).catch(error=>{if(error.code==='ENOENT'&&name==='manager.json')return null;throw error;});
    if(value&&!versionPattern.test(value.version))throw new Error('Release selection invalid');
    if(value)protectedVersions.add(value.version);
  }
  // No process snapshot means no deletion. A later update can retry.
  let active;try{active=await references(home);}catch{return {removed,skipped:['process-inventory-unavailable']};}
  for(const version of active.versions)protectedVersions.add(version);
  const candidates=[];
  for(const entry of await fs.readdir(base,{withFileTypes:true})){
    if(!versionPattern.test(entry.name)||!entry.isDirectory()||entry.isSymbolicLink())continue;
    const directory=path.join(base,entry.name);
    const stat=await fs.stat(path.join(directory,'release.json')).catch(()=>null);
    if(stat)candidates.push({version:entry.name,directory,time:stat.mtimeMs});
  }
  candidates.sort((a,b)=>b.time-a.time);
  // Keep one additional rollback release as well as every selected/active one.
  const rollback=keep.some(value=>versionPattern.test(value))?null:candidates.find(item=>!protectedVersions.has(item.version));
  if(rollback)protectedVersions.add(rollback.version);
  for(const candidate of candidates){
    const {version,directory}=candidate;if(protectedVersions.has(version))continue;
    try{
      if(path.dirname(directory)!==base||await fs.realpath(directory)!==directory)throw new Error('Release cleanup path');
      const receipt=await read(path.join(directory,'.managed-release.json'));
      if(receipt.schema!==1||receipt.version!==version)throw new Error('Unknown release');
      const files=await inventory(directory);
      if(Object.keys(files).length!==Object.keys(receipt.files).length||Object.entries(files).some(([name,hash])=>receipt.files[name]!==hash))throw new Error('Modified release');
      // Refresh process and selection guards immediately before deletion.
      const now=await references(home);
      if(now.versions.includes(version))throw new Error('Release in use');
      for(const name of ['current.json','manager.json'])if((await read(path.join(home,name)).catch(error=>{if(error.code==='ENOENT'&&name==='manager.json')return null;throw error;}))?.version===version)throw new Error('Release selected');
      await fs.rm(directory,{recursive:true,force:false});removed.push(version);
    }catch{skipped.push(version);}
  }
  return {removed,skipped};
}
