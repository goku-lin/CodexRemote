import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {install,entries,installation,withUpdateLock,activateUpdate,activeWork,connectorRunning} from './connector-client.mjs';
import {verifyRelease,updateSource} from './connector-updates.mjs';
import {reuseRuntime,recordManagedRelease} from './installation-storage.mjs';

const json=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\ufeff/,''));
async function setup({home,packageRoot,name,workspace,noShortcut=false},{installFresh=install,writeEntries=entries,busy=activeWork,activate=activateUpdate,serviceRunning=connectorRunning}={}){
  home=path.resolve(home);packageRoot=path.resolve(packageRoot);
  if(home===path.parse(home).root)throw new Error('请选择单独的应用文件夹。');
  const manifest=await json(path.join(packageRoot,'.setup-manifest.json')),metadata=await json(path.join(packageRoot,'release.json'));
  const source=await json(path.join(home,'state/update-source.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  verifyRelease(manifest,{publicKey:source?.publicKey || manifest.installerPublicKey,sequence:source?.sequence || 0});
  if(metadata.version!==manifest.version)throw new Error('安装包版本不匹配。');
  const next=metadata.updates?updateSource(metadata.updates):null;
  if(next && (next.publicKey!==manifest.installerPublicKey || next.sequence!==manifest.sequence))throw new Error('安装包更新来源与发布签名不一致。');
  const previous=await json(path.join(home,'current.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!previous){
    await installFresh({home,name,workspace,packageRoot},{launchConnector:async()=>{},managerOptions:{noShortcut}});
    return {installed:true,version:metadata.version,executable:path.join(home,'CodexRemote.exe'),message:'安装完成。打开 Codex Remote 即可开始使用。'};
  }
  const before=await installation(home);
  if(await busy(before.config))throw new Error('当前仍有任务运行或等待处理，请在任务结束后更新。');
  const resume=await serviceRunning(before.config);
  const destination=path.join(home,'versions',metadata.version),staging=path.join(home,'versions','.install-'+process.pid+'-'+Date.now());
  try{
    await fs.cp(path.join(packageRoot,'versions',metadata.version),staging,{recursive:true,errorOnExist:true,force:false});
    await reuseRuntime(home,staging);
    try{await fs.rename(staging,destination);await recordManagedRelease(destination);}
    catch(error){
      if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code))throw error;
      const old=await json(path.join(destination,'release.json'));if(old.version!==metadata.version)throw error;
      for(const name of await fs.readdir(staging,{recursive:true})){
        const file=path.join(staging,name);if((await fs.stat(file)).isFile() && !(await fs.readFile(file)).equals(await fs.readFile(path.join(destination,name))))throw new Error('应用文件已被修改，请选择新的应用目录。');
      }
    }
    const activated=await activate(home,before,async()=>{
      await fs.writeFile(path.join(home,'current.json'),JSON.stringify({version:metadata.version}));
    },{refresh:()=>writeEntries(home,{noShortcut}),activeWork:busy,...(!resume?{stopRunning:async()=>{},launchConnector:async()=>{},verify:async()=>{}}:{})});
    if(!activated)throw new Error('任务已开始，更新已暂缓，请在任务结束后重试。');
    if(next){
      const filename=path.join(home,'state/update-source.json');
      await fs.writeFile(filename+'.tmp',JSON.stringify(next),{mode:0o600});await fs.rename(filename+'.tmp',filename);
    }
    return {installed:false,upgraded:true,version:metadata.version,executable:path.join(home,'CodexRemote.exe'),message:'更新完成，配置和浏览器配对已保留。'};
  }finally{
    if(path.dirname(staging)!==path.resolve(home,'versions'))throw new Error('Install cleanup path');
    await fs.rm(staging,{recursive:true,force:true});
  }
}
export async function installManagerPackage(options,dependencies){
  if(await fs.access(path.join(path.resolve(options.home),'state/connector.json')).then(()=>true,()=>false))return withUpdateLock(path.resolve(options.home),()=>setup(options,dependencies));
  return setup(options,dependencies);
}
if(process.argv[1] && await fs.realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url)){
  try{const flag=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};console.log(JSON.stringify({ok:true,...await installManagerPackage({home:flag('--home'),packageRoot:flag('--package'),noShortcut:process.argv.includes('--no-shortcut')})}));}
  catch(error){console.log(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
}
