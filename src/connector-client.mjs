import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {extractArchive} from './connector-archive.mjs';
import {supervise} from './supervisor.mjs';
import {independentPort} from './independent-node.mjs';
import {updateSource,availableRelease,downloadRelease} from './connector-updates.mjs';
import {reuseRuntime,recordManagedRelease,cleanupManagedReleases} from './installation-storage.mjs';
import {applicationEntries} from './application-entries.mjs';
import {initializeApplication} from './portable-start.mjs';

const exec=promisify(execFile);
const versionPattern=/^[a-f0-9]{20}$/;
async function jsonFile(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function save(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(value,null,2),{mode:0o600});await fs.rename(file+'.tmp',file);}
export async function installation(home){
  const current=await jsonFile(path.join(home,'current.json'));
  if(!versionPattern.test(current.version))throw new Error('安装版本记录无效');
  const directory=path.join(home,'versions',current.version);
  return {current,directory,node:path.join(directory,'runtime','node.exe'),app:path.join(directory,'app'),config:await jsonFile(path.join(home,'state','connector.json'))};
}
export async function ensureStableRuntime(home,versionDirectory){
  const source=path.join(versionDirectory,'runtime','node.exe'),stable=path.join(home,'runtime','node.exe');
  await fs.access(source);await fs.mkdir(path.dirname(stable),{recursive:true});
  const temporary=stable+'.'+process.pid+'.tmp';
  try{await fs.copyFile(source,temporary);await fs.rename(temporary,stable);}finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  return stable;
}
const controlPipe=config=>'\\\\.\\pipe\\codex-relay-connector-'+config.id;
async function control(config,action){
  return new Promise(resolve=>{
    const socket=net.createConnection(controlPipe(config));let text='',finished=false;
    const done=value=>{if(finished)return;finished=true;clearTimeout(timer);socket.destroy();resolve(value);};
    const timer=setTimeout(()=>done(null),3000);
    socket.on('error',()=>done(null));socket.on('connect',()=>socket.write(JSON.stringify({token:config.token,action})+'\n'));
    socket.on('data',chunk=>{text+=chunk;if(text.includes('\n')){try{done(JSON.parse(text));}catch{done(null);}}});
  });
}
export const connectorRunning=async config=>Boolean(await control(config,'status'));
export async function entries(home,{managerVersion,noShortcut=process.env.CODEX_RELAY_NO_DESKTOP_SHORTCUT==='1'}={}){
  noShortcut ||= await fs.access(path.join(home,'portable.json')).then(()=>true,()=>false);
  const selected=managerVersion || (await jsonFile(path.join(home,'current.json'))).version;
  if(!versionPattern.test(selected))throw new Error('应用版本记录无效。');
  for(const [name,text] of Object.entries(applicationEntries())){
    const file=path.join(home,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);
  }
  const app=path.join(home,'versions',selected,'app');
  await save(path.join(home,'manager.json'),{version:selected});
  await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(app,'install-manager.ps1'),'-HomeDirectory',home,'-SourceDirectory',app,...(noShortcut?['-NoShortcut']:[])],{windowsHide:true,timeout:20000});
}
async function launch(home){await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(home,'runtime','service.ps1'),'start'],{windowsHide:true});}
export async function install({home,name,workspace,port=4317,packageRoot},{launchConnector=launch,managerOptions}={}){
  home=path.resolve(home);
  if(home===path.parse(home).root)throw new Error('请选择单独的应用目录。');
  if((await fs.readdir(home).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).length)throw new Error('此目录不是空目录，请选择应用目录或在现有应用中更新。');
  const metadata=await jsonFile(path.join(packageRoot,'release.json'));
  if(!versionPattern.test(metadata.version))throw new Error('应用版本记录无效。');
  await fs.mkdir(home,{recursive:true});
  for(const part of ['versions','runtime','CodexRemote.exe','current.json','manager.json','release.json'])await fs.cp(path.join(packageRoot,part),path.join(home,part),{recursive:true,errorOnExist:true,force:false});
  await initializeApplication(home,{...(name?{name}:{}),...(workspace?{workspace}:{})});
  if(independentPort(port)!==4317){const file=path.join(home,'state','connector.json');await save(file,{...await jsonFile(file),port:independentPort(port)});}
  await entries(home,managerOptions);await launchConnector(home);
}
export async function applyUpdate(home,manifest,bytes,{prepareVersion=async()=>{}}={}){
  if(!versionPattern.test(manifest.version) || !/^[a-f0-9]{64}$/.test(manifest.sha256) || bytes.length!==manifest.size || crypto.createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw new Error('下载的安装包校验失败，原版本保持不变');
  const directory=path.join(home,'versions',manifest.version);
  const staging=path.join(home,'versions','.stage-'+crypto.randomUUID());
  let created=false;
  try{
    await extractArchive(bytes,staging);const release=await jsonFile(path.join(staging,'release.json'));
    if(release.version!==manifest.version)throw new Error('安装包版本与发布信息不符');
    const content=path.join(staging,'versions',release.version);
    await fs.access(path.join(content,'runtime','node.exe'));await fs.access(path.join(content,'app','connector-client.mjs'));
    // A failed/partial earlier download cannot occupy the final version directory.
    try{await fs.rename(content,directory);created=true;}catch(error){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code))throw error;const old=await jsonFile(path.join(directory,'release.json'));if(old.version!==manifest.version)throw error;}
    await reuseRuntime(home,directory);
    await prepareVersion(directory,home,manifest.version);
    if(created)await recordManagedRelease(directory);
    await save(path.join(home,'current.json'),{version:manifest.version});return directory;
  }finally{
    if(path.dirname(path.resolve(staging))!==path.resolve(home,'versions'))throw new Error('清理目录越界');
    await fs.rm(staging,{recursive:true,force:true});
  }
}
export async function stopConnector(config){
  const stopped=await control(config,'stop');
  if(stopped){
    for(let i=0;i<20;i++){if(!await control(config,'status'))return;await new Promise(resolve=>setTimeout(resolve,150));}
    throw new Error('旧连接器尚未停止，未启动第二个连接器。请稍后重试');
  }
}
async function refreshEntries(home){
  const installed=await installation(home);
  await exec(installed.node,[path.join(installed.app,'connector-client.mjs'),'entries','--home',home],{windowsHide:true,timeout:15000});
}
export async function verifyRunning(home,version){
  const {config}=await installation(home),base='http://127.0.0.1:'+independentPort(config.port);
  const deadline=Date.now()+20000;
  do{
    try{
      const result=await fetch(base+'/api/runtime',{signal:AbortSignal.timeout(1500)});
      if(result.ok && (await result.json()).connectorReleaseId===version)return;
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }while(Date.now()<deadline);
  throw new Error('新版控制服务未能启动，恢复原版本');
}
export async function activeWork(config){
  if(!await control(config,'status'))return false;
  const response=await fetch('http://127.0.0.1:'+independentPort(config.port)+'/api/bootstrap',{signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error('当前控制服务尚未就绪，暂缓更新');
  const value=await response.json();
  if(!value.devices?.some(device=>device.id===config.id))throw new Error('当前端口不是此电脑的控制服务，暂缓更新');
  return value.sessions?.some(session=>session.deviceId===config.id && (session.activeTurnId || ['starting','running','waiting_input','waiting_approval','interrupting'].includes(session.status))) || false;
}
export async function withUpdateLock(home,operation){
  const filename=path.join(home,'state','connector-update.lock');
  let handle;
  for(let attempt=0;attempt<2;attempt++){
    try{handle=await fs.open(filename,'wx');break;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const owner=await jsonFile(filename).catch(()=>null);
      if(!owner?.pid)throw new Error('另一个更新检查正在进行');
      try{process.kill(owner.pid,0);throw new Error('另一个更新检查正在进行');}
      catch(error){if(error.code!=='ESRCH')throw error;}
      await fs.unlink(filename);
    }
  }
  if(!handle)throw new Error('另一个更新检查正在进行');
  try{await handle.writeFile(JSON.stringify({pid:process.pid}));return await operation();}
  finally{await handle.close();await fs.unlink(filename).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
export async function activateUpdate(home,before,apply,{refresh=refreshEntries,stopRunning=stopConnector,launchConnector=launch,verify=verifyRunning,activeWork:busy}={}){
  try{
    await apply();
    if(busy && await busy(before.config)){await save(path.join(home,'current.json'),before.current);return false;}
    await refresh(home);await stopRunning(before.config);await launchConnector(home);
    if(before.config.mode==='independent')await verify(home,(await installation(home)).current.version);
    await cleanupManagedReleases(home,{keep:[before.current.version]}).catch(()=>{});
    return true;
  }catch(error){
    const current=await jsonFile(path.join(home,'current.json'));
    if(current.version!==before.current.version){
      await save(path.join(home,'current.json'),before.current);
      try{await stopRunning(before.config);try{await refresh(home);}catch{await entries(home);}await launchConnector(home);}
      catch(rollbackError){throw new Error(error.message+'；原版本已选回，但后台需重新启动：'+rollbackError.message);}
    }
    throw error;
  }
}
export async function initializeUpdateSource(home){
  if(await fs.access(path.join(home,'state','update-source.json')).then(()=>true,()=>false))return;
  const installed=await installation(home),metadata=await jsonFile(path.join(installed.directory,'release.json'));
  if(metadata.updates)await save(path.join(home,'state','update-source.json'),updateSource(metadata.updates));
}
export async function autoUpdate(home,options={}){
  try{
    await initializeUpdateSource(home);
    const settings=await jsonFile(path.join(home,'state','update-source.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(!settings)return {status:'disabled'};
    return await withUpdateLock(home,async()=>{
      const before=await installation(home);
      if(before.config.mode!=='independent')return {status:'disabled'};
      const source=updateSource(await jsonFile(path.join(home,'state','update-source.json')));
      const release=await availableRelease(source,options),{url,manifest}=release;
      if(release.status==='empty')return {status:'empty'};
      // Remember the highest signed publication even if its download fails.
      await save(path.join(home,'state','update-source.json'),{...source,sequence:manifest.sequence});
      if(manifest.version===before.current.version)return {status:'current',version:manifest.version};
      if(source.kind==='github' && options.install!==true)return {status:'available',version:manifest.version,release:release.release};
      const busy=options.activeWork || activeWork;
      if(await busy(before.config))return {status:'deferred',version:manifest.version};
      options.onProgress?.('发现新版，正在下载并校验…');
      const bytes=await downloadRelease(url,manifest,options);
      options.onProgress?.('安装包校验通过，正在更新控制服务…');
      const activated=await activateUpdate(home,before,()=>applyUpdate(home,manifest,bytes,options),{...options,activeWork:busy});
      if(!activated)return {status:'deferred',version:manifest.version};
      return {status:'updated',version:manifest.version};
    });
  }catch(error){return {status:'unavailable',message:error.message};}
}
async function run(home){
  const installed=await installation(home),{config,current,app,node}=installed;
  // Also bootstraps an existing installation updated by an older ZIP updater.
  await initializeUpdateSource(home);await entries(home);
  if(await control(config,'status'))return;
  const log=await fs.open(path.join(home,'state','connector.log'),'a');
  let service;
  const server=net.createServer(socket=>{
    let frame='';socket.setTimeout(3000,()=>socket.destroy());socket.on('error',()=>{});
    socket.on('data',bytes=>{frame+=bytes;if(frame.length>4096)return socket.destroy();if(!frame.includes('\n'))return;
      try{const value=JSON.parse(frame);if(value.token!==config.token)return socket.destroy();
        socket.end(JSON.stringify({version:current.version})+'\n');if(value.action==='stop')setTimeout(shutdown,100);
      }catch{socket.destroy();}
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(controlPipe(config),resolve);});
  const runtime=path.join(app,'connector-runtime.cjs');
  // Keep the inbound firewall identity stable across versioned OTA folders.
  // The versioned runtime remains available for rollback and maintenance;
  // only the long-lived Relay service uses this fixed path.
  const serviceNode=await ensureStableRuntime(home,installed.directory);
  service=supervise(serviceNode,[runtime],{cwd:config.cwd,windowsHide:true,stdio:['pipe',log.fd,log.fd],env:{...process.env,CODEX_RELAY_PARENT_PIPE:'1',CODEX_RELAY_DATA_DIR:path.join(home,'state'),CODEX_RELAY_RELEASE_ID:current.version}},{onState:state=>log.write(JSON.stringify({at:Date.now(),...state})+'\n').catch(()=>{})});
  let closing=false;
  function shutdown(){if(closing)return;closing=true;service?.stop();server.close();setTimeout(()=>process.exit(0),700);}
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const action=process.argv[2],home=process.argv[process.argv.indexOf('--home')+1];
    if(action==='entries')await entries(home);
    else if(action==='auto-update'){
      console.log('正在检查连接器更新…');
      const result=await autoUpdate(home,{install:process.argv.includes('--install'),onProgress:message=>console.log(message)});
      console.log(result.status==='updated' ? '已更新到 '+result.version+'。Codex 桌面保持运行，桌面代理在下次正常启动时更新。' : result.status==='available' ? '发现 '+result.release.name+'，请在管理程序「版本与更新」查看说明并选择安装。' : result.status==='deferred' ? '发现新版，当前仍有任务运行或等待处理。请在空闲时点击安装更新。' : result.status==='current' ? '连接器已经是最新发布版本。' : result.status==='empty' ? '暂无支持自动更新的发布版本。' : result.status==='disabled' ? '尚未配置更新来源。' : '更新暂不可用，继续使用已安装版本：'+result.message);
      if(result.status==='unavailable')process.exitCode=1;
    }
    else if(action==='run')await run(home);
    else if(action==='stop'){await control((await installation(home)).config,'stop');console.log('连接器已停止，Codex 桌面继续运行。');}
    else throw new Error('连接器操作无效');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
