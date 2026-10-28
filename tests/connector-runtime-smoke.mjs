import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {createArchive} from '../src/connector-archive.mjs';
import {applicationArchive} from './application-fixture.mjs';
import {releaseSigningKey,signRelease} from '../src/connector-updates.mjs';

export async function verifyPortableConnector(directory,{setupPath}={}){
  const metadata=JSON.parse(await fs.readFile(path.join(directory,'release.json'),'utf8')),versionDirectory=path.join(directory,'versions',metadata.version);
  const node=path.join(versionDirectory,'runtime','node.exe'),app=path.join(versionDirectory,'app'),state=path.join(directory,'runtime-test-state'),children=[];
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const base='http://127.0.0.1:'+port;
  const poll=async read=>{for(let i=0;i<80;i++){try{const result=await read();if(result)return result;}catch{}await new Promise(resolve=>setTimeout(resolve,150));}throw new Error('portable connector startup timed out');};
  const launch=(entry,env)=>{const child=spawn(node,[path.join(app,entry)],{cwd:app,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,...env}});children.push(child);child.stdout.resume();child.stderr.resume();return child;};
  const post=async(route,body)=>{const response=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error('fixture HTTP '+response.status);return response.json();};
  try{
    const portableHome=path.join(directory,'portable-first-run'),movedHome=path.join(directory,'移动后的解压应用');await fs.mkdir(portableHome);
    for(const part of ['versions','runtime','CodexRemote.exe','release.json','current.json','manager.json','portable.json'])await fs.cp(path.join(directory,part),path.join(portableHome,part),{recursive:true});
    const portableMetadata=path.join(portableHome,'versions',metadata.version,'release.json'),originalMetadata=await fs.readFile(portableMetadata);
    await fs.writeFile(portableMetadata,JSON.stringify({...metadata,version:'invalid'}));
    await promisify(execFile)(path.join(portableHome,'CodexRemote.exe'),['--check-entry','--initialize-only'],{windowsHide:true,timeout:20000}).then(()=>{throw new Error('损坏的应用版本未被拒绝');},error=>{if(error.code!==1)throw error;});
    const startupError=await fs.readFile(path.join(portableHome,'application-error.log'),'utf8');
    if(!startupError.includes('应用版本不匹配') || startupError.includes('\ufffd'))throw new Error('首次启动的中文错误显示不正确');
    await fs.writeFile(portableMetadata,originalMetadata);
    await promisify(execFile)(path.join(portableHome,'CodexRemote.exe'),['--check-entry','--initialize-only'],{windowsHide:true,timeout:20000});
    const portableConfigFile=path.join(portableHome,'state','connector.json'),identity=await fs.readFile(portableConfigFile),portableConfig=JSON.parse(identity);
    if(portableConfig.mode!=='independent')throw new Error('解压版未初始化独立电脑');
    await fs.rename(portableHome,movedHome);
    await promisify(execFile)(path.join(movedHome,'CodexRemote.exe'),['--check-entry','--initialize-only'],{windowsHide:true,timeout:20000});
    if(!(await fs.readFile(path.join(movedHome,'state','connector.json'))).equals(identity))throw new Error('移动解压版后本机身份发生变化');
    if((await fs.readdir(movedHome)).some(name=>/\.(cmd|bat|ps1)$/i.test(name)))throw new Error('解压版包含旧控制台入口');
    console.log('真实解压版 EXE 首次启动及移动整个文件夹后再次启动通过；本机身份保持不变，无安装脚本。');
    launch('server.mjs',{PORT:String(port),HOST:'127.0.0.1',CODEX_RELAY_DATA_DIR:path.join(directory,'hub'),CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_PARENT_PIPE:'1',CODEX_RELAY_TOKEN:'fixture-hub'});
    await poll(async()=>{const response=await fetch(base+'/api/runtime');return response.ok;});
    const code=await post('/api/connectors/code',{}),config=await post('/api/connector/enroll',{code:code.code,nonce:crypto.randomUUID(),name:'便携验证电脑'});
    await fs.mkdir(state,{recursive:true});await fs.writeFile(path.join(state,'connector.json'),JSON.stringify({...config,server:base,cwd:state}));
    const fixture=path.join(directory,'codex-fixture.mjs');
    await fs.writeFile(fixture,`import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);if(msg.id==null)return;if(['turn/start','thread/start'].includes(msg.method))throw new Error('unexpected model request');const result=msg.method==='model/list'?{data:[{id:'portable-fixture',model:'portable-fixture',supportedReasoningEfforts:[]}]}:msg.method==='thread/list'?{data:[]}:{};process.stdout.write(JSON.stringify({id:msg.id,result})+'\\n');});`);
    launch('connector-runtime.cjs',{CODEX_RELAY_DATA_DIR:state,CODEX_RELAY_RELEASE_ID:'fixture',CODEX_BIN:node,CODEX_ARGS_JSON:JSON.stringify([fixture]),CODEX_SESSIONS_DIR:path.join(directory,'sessions'),CODEX_APP_TOOLS_PIPE_PATH:'',CODEX_THREAD_ID:'',CODEX_DESKTOP_BRIDGE_SERVER:'',CODEX_RELAY_NATIVE_ENDPOINT:path.join(directory,'not-running-native.json')});
    await poll(async()=>{const result=await (await fetch(base+'/api/devices')).json();return result.devices.some(item=>item.id===config.id && item.online && item.executionRelay);});
    await poll(async()=>{const response=await fetch(base+'/api/devices/'+config.id+'/catalog');if(!response.ok)return false;const result=await response.json();return result.models?.some(item=>item.id==='portable-fixture');});
    console.log('便携安装包的本地服务、模拟 Runner、主电脑中转完整启动通过；未提交模型请求。');
    const independentState=path.join(directory,'independent-state'),independentId='pc-'+crypto.randomUUID();
    const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const independentPort=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
    await fs.mkdir(independentState);await fs.writeFile(path.join(independentState,'connector.json'),JSON.stringify({mode:'independent',id:independentId,token:crypto.randomBytes(32).toString('hex'),name:'独立便携验证',cwd:independentState,port:independentPort,server:base}));
    launch('connector-runtime.cjs',{CODEX_RELAY_DATA_DIR:independentState,CODEX_RELAY_RELEASE_ID:'fixture',CODEX_BIN:node,CODEX_ARGS_JSON:JSON.stringify([fixture]),CODEX_SESSIONS_DIR:path.join(directory,'sessions'),CODEX_APP_TOOLS_PIPE_PATH:'',CODEX_THREAD_ID:'',CODEX_DESKTOP_BRIDGE_SERVER:'',CODEX_RELAY_NATIVE_ENDPOINT:path.join(directory,'not-running-independent-native.json')});
    const independentBase='http://127.0.0.1:'+independentPort;
    await poll(async()=>{const response=await fetch(independentBase+'/api/devices/'+independentId+'/catalog');if(!response.ok)return false;return (await response.json()).models?.some(item=>item.id==='portable-fixture');});
    const independentDevices=(await (await fetch(independentBase+'/api/devices')).json()).devices;assertIndependent(independentDevices,independentId);
    if((await (await fetch(base+'/api/devices')).json()).devices.some(item=>item.id===independentId))throw new Error('独立连接仍向原主电脑注册');
    const hub=children[0],hubStopped=new Promise(resolve=>hub.once('exit',resolve));hub.stdin.end();await hubStopped;
    if(!(await fetch(independentBase+'/api/bootstrap')).ok)throw new Error('原主电脑停止后独立入口不可用');
    if(!(await fetch(independentBase+'/computer-entries.js')).ok)throw new Error('安装包缺少独立入口网页模块');
    console.log('便携安装包独立模式已完整启动，原主电脑停止后网页仍可访问；未提交模型请求。');
    // Exercise the actual packaged updater, compiler, entry regeneration, control
    // pipe and version readiness check. Only process detachment is replaced so
    // every child can be stopped by this test; Codex RPC uses the fake runner.
    const client=await import(pathToFileURL(path.join(app,'connector-client.mjs')).href);
    const autoHome=path.join(directory,'auto-home'),publisherState=path.join(directory,'auto-publisher');
    const autoSocket=net.createServer();await new Promise(resolve=>autoSocket.listen(0,'127.0.0.1',resolve));const autoPort=autoSocket.address().port;await new Promise(resolve=>autoSocket.close(resolve));
    const sourceSocket=net.createServer();await new Promise(resolve=>sourceSocket.listen(0,'127.0.0.1',resolve));const sourcePort=sourceSocket.address().port;await new Promise(resolve=>sourceSocket.close(resolve));
    const sourceUrl='http://127.0.0.1:'+sourcePort;
    const fakeEnv={CODEX_BIN:node,CODEX_ARGS_JSON:JSON.stringify([fixture]),CODEX_SESSIONS_DIR:path.join(directory,'auto-sessions'),CODEX_APP_TOOLS_PIPE_PATH:'',CODEX_THREAD_ID:'',CODEX_DESKTOP_BRIDGE_SERVER:'',CODEX_RELAY_NATIVE_ENDPOINT:path.join(directory,'not-running-auto-native.json')};
    const launchAuto=async home=>{
      const current=JSON.parse(await fs.readFile(path.join(home,'current.json'),'utf8')),versionRoot=path.join(home,'versions',current.version);
      const child=spawn(path.join(versionRoot,'runtime','node.exe'),[path.join(versionRoot,'app','connector-client.mjs'),'run','--home',home],{cwd:versionRoot,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,...fakeEnv}});
      children.push(child);child.stdout.resume();child.stderr.resume();
    };
    await fs.mkdir(autoHome);
    await client.install({home:autoHome,name:'自动更新验证',workspace:autoHome,port:autoPort,packageRoot:directory},{launchConnector:launchAuto});
    const managerEntry=path.join(autoHome,'runtime','manager.ps1');
    const verifyManager=()=>promisify(execFile)('powershell.exe',['-NoProfile','-STA','-NonInteractive','-ExecutionPolicy','Bypass','-File',managerEntry,'-ValidateOnly'],{windowsHide:true,timeout:15000,cwd:app});
    if(!(await verifyManager()).stdout.includes('Manager WPF loaded'))throw new Error('实际安装入口未加载管理窗口');
    const autoBase='http://127.0.0.1:'+autoPort;
    await poll(async()=>{const response=await fetch(autoBase+'/api/runtime');return response.ok;});
    if(setupPath){
      const beforeCurrent=await fs.readFile(path.join(autoHome,'current.json')),beforeConfig=await fs.readFile(path.join(autoHome,'state/connector.json'));
      await promisify(execFile)(setupPath,['--verify-install',autoHome],{windowsHide:true,timeout:45000});
      const proof=JSON.parse(await fs.readFile(path.join(autoHome,'setup-verification.json'),'utf8'));if(!proof.ok)throw new Error('完整 EXE 修复失败：'+proof.error);
      if(!(await fs.readFile(path.join(autoHome,'current.json'))).equals(beforeCurrent)||!(await fs.readFile(path.join(autoHome,'state/connector.json'))).equals(beforeConfig)||!(await fetch(autoBase+'/api/runtime')).ok)throw new Error('管理程序修复改变了后台或授权');
      if(!(await fs.readFile(path.join(autoHome,'CodexRemote.exe'))).equals(await fs.readFile(path.join(app,'manager-launcher.exe'))))throw new Error('实际安装的 EXE 与发布端预编译版本不同');
      await promisify(execFile)(path.join(autoHome,'CodexRemote.exe'),['--check-entry','--verify-status'],{windowsHide:true,timeout:20000});
      const rendered=JSON.parse(await fs.readFile(path.join(autoHome,'manager-status-verification.json'),'utf8'));
      if(!rendered.verified||rendered.healthRows!==5)throw new Error('EXE 管理窗口未完成真实状态读取和渲染');
      const freshHome=path.join(directory,'setup-fresh');
      await promisify(execFile)(setupPath,['--verify-install',freshHome],{windowsHide:true,timeout:60000});
      if(!JSON.parse(await fs.readFile(path.join(freshHome,'setup-verification.json'),'utf8')).ok)throw new Error('完整 EXE 首次安装失败');
      if(!(await fs.readFile(path.join(freshHome,'CodexRemote.exe'))).equals(await fs.readFile(path.join(autoHome,'CodexRemote.exe'))))throw new Error('首次安装和修复的 EXE 不一致');
      console.log('同一个 EXE 自动安装与原位更新通过；真实窗口状态读取和控件渲染通过，配置与授权保持不变。');
    }
    const oldSelection=JSON.parse(await fs.readFile(path.join(autoHome,'current.json'),'utf8'));
    await promisify(execFile)(node,[path.join(app,'native-desktop-setup.mjs'),'prepare'],{windowsHide:true,timeout:60000,env:{...process.env,CODEX_RELAY_DATA_DIR:path.join(autoHome,'state'),CODEX_RELAY_CONNECTOR_HOME:autoHome,CODEX_RELAY_RELEASE_ID:oldSelection.version}});
    const oldBridge=path.join(autoHome,'state','codex-native-proxy-'+oldSelection.version+'.exe'),oldBridgeBytes=await fs.readFile(oldBridge);
    const browserFile=path.join(autoHome,'state','browser-devices.json'),browserData=JSON.stringify({version:1,acceptLegacy:true,devices:[]});await fs.writeFile(browserFile,browserData);
    const key=await releaseSigningKey(publisherState),nextVersion='9'.repeat(20),updates={schema:1,publicKey:key.publicKey,urls:[sourceUrl],sequence:200};
    const names=(await fs.readdir(versionDirectory,{recursive:true})).filter(name=>/^(?:app[\\/][a-zA-Z0-9_./\\-]+|runtime[\\/](?:node\.exe|LICENSE\.txt))$/.test(name));
    const files=[];
    for(const name of names){const file=path.join(versionDirectory,name);if((await fs.stat(file)).isFile())files.push({name:name.replaceAll('\\','/'),bytes:await fs.readFile(file)});}
    files.push({name:'release.json',bytes:Buffer.from(JSON.stringify({version:nextVersion,updates}))});
    const archive=applicationArchive(files),manifest=signRelease({version:nextVersion,filename:'CodexRemote-Portable-v0.2.1-win-x64.zip',sha256:crypto.createHash('sha256').update(archive).digest('hex'),size:archive.length,sequence:200},key);
    await fs.mkdir(path.join(publisherState,'releases'));await fs.writeFile(path.join(publisherState,'releases',manifest.filename),archive);await fs.writeFile(path.join(publisherState,'releases','latest.json'),JSON.stringify(manifest));
    await fs.writeFile(path.join(autoHome,'state','update-source.json'),JSON.stringify({...updates,sequence:100}));
    launch('server.mjs',{PORT:String(sourcePort),HOST:'127.0.0.1',CODEX_RELAY_DATA_DIR:publisherState,CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_PARENT_PIPE:'1'});
    await poll(async()=>{const response=await fetch(sourceUrl+'/api/connector-updates/manifest');return response.ok;});
    const autoConfig=JSON.parse(await fs.readFile(path.join(autoHome,'state','connector.json'),'utf8'));
    const autoEvent=async body=>{
      const response=await fetch(autoBase+'/api/runner/'+autoConfig.id+'/events',{method:'POST',headers:{'content-type':'application/json','x-codex-relay-token':autoConfig.token},body:JSON.stringify(body)});
      if(response.status!==202)throw new Error('auto-update fixture event rejected');
    };
    await autoEvent({type:'thread_list',threads:[{id:'auto-task-fixture',name:'update task fixture',cwd:autoHome,createdAt:1,updatedAt:2,status:{type:'idle'}}]});
    const session=(await (await fetch(autoBase+'/api/sessions')).json()).sessions.find(item=>item.threadId==='auto-task-fixture');
    await autoEvent({sessionId:session.id,message:{method:'thread/status/changed',params:{threadId:'auto-task-fixture',status:{type:'active'}}}});
    const deferred=await client.autoUpdate(autoHome,{launchConnector:launchAuto});
    if(deferred.status!=='deferred' || (await (await fetch(autoBase+'/api/runtime')).json()).connectorReleaseId!==oldSelection.version)throw new Error('运行中的任务未阻止自动更新');
    await autoEvent({sessionId:session.id,message:{method:'thread/status/changed',params:{threadId:'auto-task-fixture',status:{type:'idle'}}}});
    const updated=await client.autoUpdate(autoHome,{launchConnector:launchAuto});
    if(updated.status!=='updated' || updated.version!==nextVersion)throw new Error('便携自动更新失败：'+JSON.stringify(updated));
    if((await (await fetch(autoBase+'/api/runtime')).json()).connectorReleaseId!==nextVersion)throw new Error('新版便携服务未运行');
    if(await fs.readFile(browserFile,'utf8')!==browserData || !(await fs.readFile(oldBridge)).equals(oldBridgeBytes))throw new Error('更新修改了原授权或旧桥接器');
    if((await fs.readdir(autoHome)).some(name=>/\.(?:cmd|bat|ps1)$/i.test(name)))throw new Error('应用根目录包含旧控制台入口');
    if(!(await verifyManager()).stdout.includes('Manager WPF loaded'))throw new Error('OTA 更新后管理入口未加载新版窗口');
    if(setupPath){
      await promisify(execFile)(path.join(autoHome,'CodexRemote.exe'),['--check-entry','--verify-status'],{windowsHide:true,timeout:20000});
      const rendered=JSON.parse(await fs.readFile(path.join(autoHome,'manager-status-verification.json'),'utf8'));
      if(!rendered.verified||!rendered.versionText.includes(nextVersion))throw new Error('OTA 后 EXE 状态界面未跟随版本');
    }
    await fs.access(path.join(autoHome,'CodexRemote.exe'));
    console.log('安装版更新后的应用入口可直接加载；没有 CMD、修复安装或迁移入口。');
    console.log('便携安装包真实自动下载、签名验证、版本切换和服务重启通过；原授权与旧桥接器保留，未启动桌面或发送模型请求。');
  }finally{
    for(const child of children.reverse())if(child.exitCode===null){
      const stopped=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();const timer=setTimeout(()=>child.kill(),2500);await stopped;clearTimeout(timer);
    }
  }
}
function assertIndependent(devices,id){if(devices.length!==1 || devices[0].id!==id || !devices[0].online)throw new Error('独立设备状态不正确');}
