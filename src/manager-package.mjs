import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
async function iconFile(root,file){
  const png=await fs.readFile(path.join(root,'public/app-icon-192.png')),header=Buffer.alloc(22);
  header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=192;header[7]=192;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
  await fs.writeFile(file,Buffer.concat([header,png]));return file;
}
export async function buildManagerHost(root){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'codex-manager-build-'));
  try{
    const compiler=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const assembly=(await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Management.Automation.PSObject].Assembly.Location'],{windowsHide:true,timeout:10000})).stdout.trim();
    const output=path.join(directory,'manager-host.exe');
    await exec(compiler,['/nologo','/target:winexe','/optimize+','/codepage:65001','/win32icon:'+await iconFile(root,path.join(directory,'app.ico')),'/r:System.Windows.Forms.dll','/r:'+assembly,'/out:'+output,path.join(root,'src/manager-shell.cs')],{windowsHide:true,timeout:15000});
    return await fs.readFile(output);
  }finally{if(path.dirname(directory)!==path.resolve(os.tmpdir()))throw new Error('Build cleanup path');await fs.rm(directory,{recursive:true,force:true});}
}
export async function buildManagerLauncher(root){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'codex-launcher-build-'));
  try{
    const output=path.join(directory,'CodexRemote.exe');
    await exec(path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:winexe','/optimize+','/codepage:65001','/win32icon:'+await iconFile(root,path.join(directory,'app.ico')),'/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll','/out:'+output,path.join(root,'src/manager-launcher.cs')],{windowsHide:true,timeout:15000});
    return await fs.readFile(output);
  }finally{if(path.dirname(directory)!==path.resolve(os.tmpdir()))throw new Error('Build cleanup path');await fs.rm(directory,{recursive:true,force:true});}
}
export async function buildManagerSetup(root,{archive,manifest,publicKey,output}){
  const manifestFile=output+'.manifest.json';
  try{
    await fs.writeFile(manifestFile,JSON.stringify({...manifest,installerPublicKey:publicKey}));
    await exec(path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),[
      '/nologo','/target:winexe','/optimize+','/codepage:65001','/win32icon:'+await iconFile(root,output+'.ico'),'/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll','/r:System.IO.Compression.dll','/r:System.IO.Compression.FileSystem.dll',
      '/resource:'+archive+',Connector.zip','/resource:'+manifestFile+',Manifest.json','/out:'+output,path.join(root,'src/manager-installer.cs')
    ],{windowsHide:true,timeout:30000});
    return output;
  }finally{await fs.unlink(manifestFile).catch(()=>{});await fs.unlink(output+'.ico').catch(()=>{});}
}
