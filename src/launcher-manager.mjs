import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {projectRoot} from './layout.mjs';
import {availableRelease,updateSource} from './connector-updates.mjs';
import {setMaintenancePassword} from './maintenance-auth.mjs';
import {accountSwitcherStatus,openAccountSwitcher} from './account-switcher.mjs';
import {initializeUpdateSource} from './connector-client.mjs';

const execute=promisify(execFile);
const json=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\ufeff/,''));
const exists=file=>fs.access(file).then(()=>true,()=>false);
export async function readManagerRequest(stream){
  stream.setEncoding('utf8');let bytes=0,input='';
  for await(const chunk of stream){bytes+=Buffer.byteLength(chunk,'utf8');if(bytes>65536)throw new Error('管理请求过大。');input+=chunk;}
  let request;try{request=JSON.parse(input.replace(/^\ufeff/,''));}catch{throw new Error('管理窗口请求格式无效，请更新启动器后重试。');}
  if(!request || Array.isArray(request) || typeof request!=='object' || typeof request.action!=='string')throw new Error('管理窗口请求缺少操作类型。');
  return request;
}
export function managerContext({root=projectRoot,home}={}){
  root=path.resolve(root);home=home?path.resolve(home):null;
  return {root,home,dataDir:path.join(home||root,home?'state':'.relay-data'),app:home?path.join(root,'app'):path.join(root,'src')};
}
async function localRequest(context,route,body,{fetcher=fetch}={}){
  let port=4317;
  if(context.home)port=Number((await json(path.join(context.dataDir,'connector.json'))).port || 4317);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('本机服务端口无效。');
  const response=await fetcher('http://127.0.0.1:'+port+route,{signal:AbortSignal.timeout(5000),redirect:'error',...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
  const value=await response.json();if(!response.ok)throw new Error(value.error || '本机服务请求失败（'+response.status+'）');return value;
}
export async function executorInventory(context){
  const file=path.join(context.dataDir,'model-providers.json');
  if(!await exists(file))return {configured:false,file,providers:[]};
  const config=await json(file);
  const providers=await Promise.all(Object.entries(config.providers || {}).map(async([id,provider])=>{
    const execution=provider.execution || 'api',command=typeof provider.command==='string'?provider.command:null;
    const installed=execution==='api'?null:command&&path.isAbsolute(command)?await exists(command):null;
    return {id,name:provider.name || id,execution,command,installed,enabled:provider.enabled!==false,models:Object.keys(provider.models || {}).join('、'),state:provider.enabled===false?'已停用':installed===false?'程序路径失效':execution==='api'?'已配置 API':installed?'已配置 CLI':'需检查 CLI 路径'};
  }));
  // Deliberately omit environment values, keys and all provider authentication.
  return {configured:true,file,providers};
}
export async function toggleExecutor(context,id,enabled){
  if(typeof id!=='string'||typeof enabled!=='boolean')throw new Error('执行器参数无效。');
  const file=path.join(context.dataDir,'model-providers.json'),original=await fs.readFile(file),config=JSON.parse(original.toString('utf8').replace(/^\ufeff/,''));
  if(!Object.hasOwn(config.providers || {},id))throw new Error('执行器不存在，请刷新列表。');
  const backup=file+'.manager-backup';
  await fs.writeFile(backup,original,{mode:0o600});
  config.providers[id].enabled=enabled;
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600});if(!(await fs.readFile(file)).equals(original))throw new Error('模型配置已被其他程序修改，请刷新后重试。');await fs.rename(temporary,file);}
  finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  return {message:(enabled?'已启用':'已停用')+'执行器配置。新版委派工具在下次调用读取；首次升级前已运行的旧委派进程需重新连接插件，当前任务不会被终止。'};
}
export async function managerStatus(context,options={}){
  const queries=await Promise.allSettled(['/api/health','/api/runtime','/api/maintenance'].map(route=>localRequest(context,route,null,options)));
  const values=queries.map(value=>value.status==='fulfilled'?value.value:null);
  const launch=await json(path.join(context.dataDir,'native-desktop-launch.json')).catch(()=>null);
  const current=context.home?await json(path.join(context.home,'current.json')).catch(()=>null):null;
  const manager=context.home?await json(path.join(context.home,'manager.json')).catch(()=>null):null;
  return {health:values[0],runtime:values[1],maintenance:values[2],online:Boolean(values[1]),cliVersion:launch?.cliVersion || null,
    version:current?.version || '本机开发目录',managerVersion:manager?.version || current?.version || '本机开发目录',executors:await executorInventory(context),accountSwitcher:await accountSwitcherStatus(context,options),
    job:values[2]?.job || null,localError:values[1]?null:'本机后台未响应；可点“仅启动服务”。'};
}
async function runScript(file,args,context,run){
  const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
  // PowerShell 5.1 defaults to the Windows code page for redirected output.
  // Establish UTF-8 inside the child before it emits output or error records.
  const parameters=args.map(value=>/^-[a-z][a-z0-9]*$/i.test(value)?value:quote(value)).join(' ');
  const command="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; try { & "+quote(file)+' '+parameters+"; if ($LASTEXITCODE) { exit $LASTEXITCODE } } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }";
  try{
    const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{cwd:context.home || context.root,windowsHide:true,encoding:'utf8',timeout:90000,maxBuffer:262144});
    return {message:result.stdout.trim() || '操作已完成。'};
  }catch(error){
    throw new Error(String(error.stderr || error.stdout || error.message).trim(),{cause:error});
  }
}
export async function managerAction(request,context,options={}){
  const run=options.run || execute;
  switch(request?.action){
    case 'status':return managerStatus(context,options);
    case 'toggle-executor':return toggleExecutor(context,request.id,request.enabled);
    case 'open-account-switcher':return openAccountSwitcher(context,options);
    case 'set-password':{
      if(typeof request.password!=='string' || typeof request.confirmation!=='string')throw new Error('请输入两次重启密码。');
      if(request.password!==request.confirmation)throw new Error('两次密码不一致，密码没有修改。');
      await setMaintenancePassword(context.dataDir,request.password);
      return {message:'重启密码已在本机保存，刷新状态后即可使用。'};
    }
    case 'check-update':{
      if(!context.home){const release=await json(path.join(context.dataDir,'releases','latest.json')).catch(()=>null);return {message:'本机使用工作目录中的代码。'+(release?'已发布连接器版本：'+release.version:'尚未发布连接器更新。')+'\n“刷新后台代码”会加载本机现有代码，不会自动拉取 Git 或重启 Codex。'};}
      await initializeUpdateSource(context.home);
      const source=updateSource(await json(path.join(context.dataDir,'update-source.json'))),release=await availableRelease(source,options),current=await json(path.join(context.home,'current.json'));
      if(release.status==='empty')return {message:'暂无支持自动更新的发布版本。',update:{status:'empty'}};
      const currentVersion=release.manifest.version===current.version;
      return {message:currentVersion?'连接器已是最新发布版本。':'发现新版：'+(release.release?.name || release.manifest.version)+'。点击“安装连接器更新”，有运行任务时会暂缓。',
        update:{status:currentVersion?'current':'available',version:release.manifest.version,release:release.release || null}};
    }
    case 'update':{
      if(!context.home)throw new Error('本机工作目录请使用“刷新后台代码”。');
      if(request.confirmNetwork!==true)throw new Error('更新可能让远程网页短暂重连，请先确认。');
      const client=path.join(context.app,'connector-client.mjs');
      const result=await run(process.execPath,[client,'auto-update','--home',context.home,'--install'],{cwd:context.home,windowsHide:true,timeout:180000,maxBuffer:262144});return {message:result.stdout.trim()};
    }
    case 'restart':{
      if(request.confirmNetwork!==true)throw new Error('重启服务会短暂断开网页连接，请先确认。');
      if(!['service','desktop'].includes(request.scope))throw new Error('重启范围无效。');
      if(request.scope==='desktop'&&request.confirmDesktop!==true)throw new Error('请先确认中断这台电脑所有 Codex 任务。');
      const result=await localRequest(context,'/api/maintenance/restart',{requestId:randomUUID(),scope:request.scope,password:request.password,confirmDesktop:request.confirmDesktop===true},options);
      return {message:'重启请求已提交。窗口会继续核对恢复状态；后台断开期间不会重复提交。',job:result.job};
    }
    case 'recover':{
      if(request.confirmNetwork!==true)throw new Error('恢复入口可能短暂断开公网，请先确认。');
      await localRequest(context,'/api/health/recover',{},options);return {message:'已请求恢复远程入口，请稍后刷新状态。'};
    }
    case 'start-service':{
      // A reachable old service still needs a restart when its runtime lacks a required feature revision.
      try{
        const runtime=await localRequest(context,'/api/runtime',null,options);
        if(Number(runtime.chatgptRevision || 0)>=2 && Number(runtime.remoteBrowserRevision || 0)>=3)return {message:'后台已在运行，无需重复启动。'};
      }catch{}
      return context.home?runScript(path.join(context.home,'connector-entry.ps1'),['start'],context,run):runScript(path.join(context.root,'scripts','启动远程服务.ps1'),['-NoBrowser','-Quiet'],context,run);
    }
    case 'start-desktop':{
      // Refuse to launch an unverified existing desktop rather than terminate it.
      const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe' }).Count"],{windowsHide:true,timeout:8000});
      if(Number(result.stdout.trim())>0)return {message:'Codex 已打开，保留当前任务。若桌面尚未接管，请等任务结束后正常关闭，再点此按钮启动。'};
      if(request.confirmNetwork!==true)throw new Error('启动入口准备远程连接时可能短暂重连公网，请先确认。');
      const file=context.home?path.join(context.app,'打开原生桌面连接.ps1'):path.join(context.root,'scripts','打开原生桌面连接.ps1');
      return runScript(file,[],context,run);
    }
    default:throw new Error('不支持的管理操作。');
  }
}
if(process.argv[1]&&await fs.realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url)){
  try{
    const flag=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
    const context=managerContext({root:flag('--root'),home:flag('--home')});
    const request=await readManagerRequest(process.stdin);console.log(JSON.stringify({ok:true,result:await managerAction(request,context)}));
  }catch(error){console.log(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
}
