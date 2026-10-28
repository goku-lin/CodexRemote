import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {install,entries,withUpdateLock} from './connector-client.mjs';
import {verifyRelease,updateSource} from './connector-updates.mjs';
import {reuseRuntime,recordManagedRelease,cleanupManagedReleases} from './installation-storage.mjs';

const json=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\ufeff/,''));
const executable=async(home,root)=>path.join(home,'manager-hosts',createHash('sha256').update(await fs.readFile(path.join(root,'app/manager-host.exe'))).digest('hex').slice(0,20),'CodexRemote.exe');
async function installManagerPackageUnlocked({home,packageRoot,name,workspace,noShortcut=false,mode='repair'},{installFresh=install,writeEntries=entries,cleanup=cleanupManagedReleases}={}){
  home=path.resolve(home);packageRoot=path.resolve(packageRoot);
  if(home===path.parse(home).root)throw new Error('请选择单独的安装文件夹。');
  if(!['repair','fresh'].includes(mode))throw new Error('安装方式无效。');
  const manifest=await json(path.join(packageRoot,'.setup-manifest.json')),metadata=await json(path.join(packageRoot,'release.json'));
  const previous=await json(path.join(home,'current.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const source=await json(path.join(home,'state/update-source.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  verifyRelease(manifest,{publicKey:source?.publicKey || manifest.installerPublicKey,sequence:source?.sequence || 0});
  if(metadata.version!==manifest.version)throw new Error('安装包版本不匹配。');
  const next=metadata.updates?updateSource(metadata.updates):null;
  if(next && (next.publicKey!==manifest.installerPublicKey || next.sequence!==manifest.sequence))throw new Error('安装包更新来源与发布签名不一致。');
  if(!previous){
    if(mode!=='fresh')throw new Error('未找到已有安装，未创建新目录。请选择原安装目录；确实首次使用时，再选择“首次安装”。');
    await installFresh({home,name:name || '此电脑',workspace:workspace || process.env.USERPROFILE || home,packageRoot,mode:'independent'},{launchConnector:async()=>{},managerOptions:{noShortcut}});
    return {installed:true,version:metadata.version,executable:await executable(home,packageRoot),message:'已安装完整 EXE 管理程序。桌面“Codex远程”可直接打开，服务由窗口里的启动按钮开启。'};
  }
  if(mode==='fresh')throw new Error('此目录已有安装，请选择“修复已有安装”，无需重新安装。');
  if(!/^[a-f0-9]{20}$/.test(previous.version))throw new Error('已有安装记录无效，未改动配置。');
  await fs.access(path.join(home,'state/connector.json'));
  const destination=path.join(home,'versions',metadata.version),staging=path.join(home,'versions','.manager-install-'+process.pid+'-'+Date.now());
  let created=false;
  try{
    await fs.mkdir(staging,{recursive:true});
    for(const part of ['app','runtime','release.json'])await fs.cp(path.join(packageRoot,part),path.join(staging,part),{recursive:true,errorOnExist:true,force:false});
    const storage=await reuseRuntime(home,staging);
    try{await fs.rename(staging,destination);created=true;}catch(error){
      if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code))throw error;
      for(const part of ['app','runtime','release.json'])for(const relative of part==='release.json'?['release.json']:(await fs.readdir(path.join(staging,part),{recursive:true})).map(name=>path.join(part,name))){
        const file=path.join(staging,relative);if(!(await fs.stat(file)).isFile())continue;
        if(!(await fs.readFile(file)).equals(await fs.readFile(path.join(destination,relative))))throw new Error('已存在的版本文件不完整，未覆盖运行中的文件。');
      }
    }
    await writeEntries(home,{managerVersion:metadata.version,noShortcut});
    if(next){
      const filename=path.join(home,'state/update-source.json');
      await fs.writeFile(filename+'.tmp',JSON.stringify({...next,sequence:Math.max(next.sequence,source?.sequence || 0)}),{mode:0o600});await fs.rename(filename+'.tmp',filename);
    }
    // Do not claim ownership of pre-existing files: only new version folders
    // receive a receipt that allows later automatic cleanup.
    if(created)await recordManagedRelease(destination);
    const cleaned=await cleanup(home).catch(()=>({removed:[],skipped:['cleanup-deferred']}));
    return {installed:false,repaired:true,managerVersion:metadata.version,serviceVersion:previous.version,executable:await executable(home,packageRoot),storage:{...storage,...cleaned},message:'已在原目录修复完整 EXE 管理程序，未另装一套。配置和授权已保留，Codex 与远程服务保持运行；后台版本可在管理窗口内更新。'};
  }finally{if(path.dirname(staging)!==path.resolve(home,'versions'))throw new Error('Install cleanup path');await fs.rm(staging,{recursive:true,force:true});}
}
export async function installManagerPackage(options,dependencies){
  if(options.mode!=='fresh'&&await fs.access(path.join(path.resolve(options.home),'state/connector.json')).then(()=>true,()=>false))return withUpdateLock(path.resolve(options.home),()=>installManagerPackageUnlocked(options,dependencies));
  return installManagerPackageUnlocked(options,dependencies);
}
if(process.argv[1]&&await fs.realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url)){
  try{const flag=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];},result=await installManagerPackage({home:flag('--home'),packageRoot:flag('--package'),name:flag('--name'),mode:process.argv.includes('--fresh')?'fresh':'repair',noShortcut:process.argv.includes('--no-shortcut')});console.log(JSON.stringify({ok:true,...result}));}
  catch(error){console.log(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
}
