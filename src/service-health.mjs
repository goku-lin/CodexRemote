import {sourceDir} from './layout.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { privateOrigin } from './browser-access.mjs';

const execute=promisify(execFile);
function publicIPv4(address){
  const parts=String(address).split('.').map(Number);
  if(parts.length!==4 || parts.some(value=>!Number.isInteger(value) || value<0 || value>255))return false;
  const [a,b]=parts;
  return a>0 && a<224 && ![10,127].includes(a) && !(a===100 && b>=64 && b<=127) && !(a===169 && b===254) && !(a===172 && b>=16 && b<=31) && !(a===192 && [0,168].includes(b)) && !(a===198 && [18,19].includes(b));
}
async function publicAddresses(hostname){
  // OS DNS resolves our own ts.net name to the tailnet IP and bypasses Funnel.
  const resolver=new Resolver({timeout:2000,tries:1});
  resolver.setServers(['1.1.1.1','8.8.8.8']);
  return resolver.resolve4(hostname);
}
function addressAccess(url,address){
  return new Promise((resolve,reject)=>{
    const req=request(new URL('/api/access',url),{agent:false,servername:new URL(url).hostname,
      // Funnel TLS setup can take 6–8 seconds on the current public routes.
      signal:AbortSignal.timeout(12000),lookup:(_hostname,options,done)=>done(null,options.all ? [{address,family:4}] : address,4)},res=>{
      let body='';res.setEncoding('utf8');
      res.on('data',chunk=>{body+=chunk;if(body.length>16384)req.destroy(new Error('入口响应过大'));});
      res.on('error',reject);
      res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('入口没有返回正常响应');resolve(JSON.parse(body));}catch(error){reject(error);}});
    });
    req.on('error',reject);req.end();
  });
}
function pairedAccess(access){return access?.required===true && access.local===false;}
export async function probeAccess(url,{publicIngress=false,resolve=publicAddresses,connect=addressAccess}={}){
  if(!publicIngress){
    const response=await fetch(new URL('/api/access',url),{signal:AbortSignal.timeout(6000),redirect:'error'});
    if(!response.ok)throw new Error('入口没有返回正常响应');
    if(!pairedAccess(await response.json()))throw new Error('入口没有正确启用配对保护');
    return {state:'ready'};
  }
  if(!privateOrigin(url) || !new URL(url).hostname.endsWith('.ts.net') || new URL(url).port)throw new Error('公网入口配置无效');
  const addresses=[...new Set((await resolve(new URL(url).hostname)).filter(publicIPv4))].slice(0,8);
  if(!addresses.length)throw new Error('未取得公网入口地址，未使用内网结果代替');
  const results=await Promise.allSettled(addresses.map(async address=>{
    if(!pairedAccess(await connect(url,address)))throw new Error('入口没有正确启用配对保护');
  }));
  const ready=results.filter(result=>result.status==='fulfilled').length;
  if(!ready)throw new Error('公网线路无法建立 HTTPS 连接');
  return {state:ready===results.length ? 'ready' : 'warning'};
}

export function networkConfig(value){
  if(!value?.externalOrigin)return null;
  const externalOrigin=privateOrigin(value.externalOrigin);
  if(!externalOrigin)throw new Error('外网地址配置无效');
  const url=new URL(externalOrigin);
  if(!url.hostname.endsWith('.ts.net') || url.port)throw new Error('仅恢复已配置的 Tailscale 入口');
  const hybrid=value.accessMode==='hybrid';
  const privateUrl=hybrid ? privateOrigin(value.privateOrigin) : externalOrigin;
  if(!privateUrl || new URL(privateUrl).hostname!==url.hostname || hybrid && new URL(privateUrl).port!=='8443')throw new Error('私有入口配置不匹配');
  return {externalOrigin,privateUrl,hybrid,hostname:url.hostname};
}

export function forwardingState(config,network,port){
  const target=`http://127.0.0.1:${port}`;
  const ports=network.hybrid ? [443,8443] : [443];
  let missing=false;
  for(const tlsPort of ports){
    const web=config.Web?.[network.hostname+':'+tlsPort],tcp=config.TCP?.[tlsPort];
    if(!web && !tcp){missing=true;continue;}
    if(!web || Object.keys(web.Handlers || {}).length!==1 || web.Handlers?.['/']?.Proxy!==target || tcp && tcp.HTTPS!==true)return 'conflict';
    const funnel=Boolean(config.AllowFunnel?.[network.hostname+':'+tlsPort]);
    if(network.hybrid && tlsPort===443 && !funnel)missing=true;
    else if(funnel!==(network.hybrid && tlsPort===443))return 'conflict';
  }
  return missing ? 'missing' : 'ready';
}

export class ServiceHealth {
  constructor({root,dataDir,port,platform=process.platform,run,startService,probe=probeAccess,now=Date.now,onChange=()=>{}}){
    Object.assign(this,{root,dataDir,port,platform,probe,now,onChange});
    const cli=process.env.TAILSCALE_BIN || (platform==='win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files','Tailscale','tailscale.exe') : 'tailscale');
    this.run=run || (async(args)=> (await execute(cli,args,{windowsHide:true,timeout:15000,maxBuffer:1024*1024})).stdout);
    this.startService=startService || (async()=>{if(platform!=='win32')throw new Error('需要手动启动服务');await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command','Start-Service -Name Tailscale -ErrorAction Stop'],{windowsHide:true,timeout:10000,maxBuffer:65536});});
    this.setup=async network=>{await execute(process.execPath,[path.join(sourceDir,'private-access.mjs'),...(network.hybrid ? ['--hybrid'] : [])],{cwd:root,env:{...process.env,PORT:String(port),CODEX_RELAY_DATA_DIR:dataDir},windowsHide:true,timeout:30000,maxBuffer:1024*1024});};
    this.restartIngress=async network=>{
      const config=JSON.parse(await this.run(['serve','status','--json']));
      if(!network.hybrid || forwardingState(config,network,this.port)!=='ready')throw new Error('入口配置已改变，未重新连接');
      try{await this.run(['funnel','--https=443','off']);}
      finally{await this.run(['funnel','--bg','--yes','--https=443',`http://127.0.0.1:${this.port}`]);}
    };
    this.report={tailscale:{state:'checking',message:'正在检查连接'},external:{state:'checking',message:'正在检查入口'}};
    this.lastRecovery=-Infinity;this.busy=null;this.stopped=false;
  }
  async config(){try{return networkConfig(JSON.parse(await readFile(path.join(this.dataDir,'network.json'),'utf8')));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
  async check({recover=false,manual=false}={}){
    if(this.busy)return this.busy;
    this.busy=this.inspect({recover,manual}).catch(()=>this.update({tailscale:{state:'error',message:'连接检查失败，请检查 Tailscale 服务'},external:{state:'unknown',message:'外网入口尚未确认'}}));
    try{return await this.busy;}finally{this.busy=null;}
  }
  update(report){
    const changed=JSON.stringify(this.report)!==JSON.stringify(report);
    this.report=report;this.checkedAt=this.now();if(changed)this.onChange(report);return report;
  }
  async inspect({recover,manual}){
    let network;
    try{network=await this.config();}catch{return this.update({tailscale:{state:'error',message:'连接配置无效，请在本机核对'},external:{state:'error',message:'未自动修改入口'}});}
    if(!network)return this.update({tailscale:{state:'disabled',message:'尚未配置外网连接'},external:{state:'disabled',message:'可使用本机或局域网地址'}});
    const mayRecover=recover && (manual || this.now()-this.lastRecovery>=60000);
    let status;
    try{status=JSON.parse(await this.run(['status','--json']));}catch{
      if(mayRecover){
        this.lastRecovery=this.now();
        try{await this.startService();status=JSON.parse(await this.run(['status','--json']));}catch{}
      }
      if(!status)return this.update({tailscale:{state:'error',message:'Tailscale 服务无法响应，请在本机启动服务'},external:{state:'offline',message:'外网入口不可用',url:network.externalOrigin}});
    }
    if(status.BackendState!=='Running' && mayRecover && status.HaveNodeKey && !['NeedsLogin','NeedsMachineAuth'].includes(status.BackendState)){
      const prefs=JSON.parse(await this.run(['debug','prefs']));
      if(!prefs.LoggedOut && (manual || prefs.WantRunning!==false)){
        this.lastRecovery=this.now();
        this.update({tailscale:{state:'recovering',message:'正在恢复原连接'},external:{state:'checking',message:'等待连接恢复',url:network.externalOrigin}});
        if(this.platform==='win32')await this.run(['set','--unattended=true']);
        await this.run(['up','--timeout=10s']);
        status=JSON.parse(await this.run(['status','--json']));
      }
    }
    if(status.BackendState!=='Running')return this.update({tailscale:{state:'offline',message:['NeedsLogin','NeedsMachineAuth'].includes(status.BackendState) ? '需要在电脑登录或授权 Tailscale' : 'Tailscale 尚未连接'},external:{state:'offline',message:'外网入口不可用',url:network.externalOrigin}});
    if(String(status.Self?.DNSName || '').replace(/\.$/,'')!==network.hostname)return this.update({tailscale:{state:'error',message:'当前账号或设备与原网址不匹配'},external:{state:'error',message:'保留原入口，未自动改换网址',url:network.externalOrigin}});
    const config=JSON.parse(await this.run(['serve','status','--json']));
    let forwarding=forwardingState(config,network,this.port);
    if(forwarding==='missing' && mayRecover){
      this.lastRecovery=this.now();
      this.update({tailscale:{state:'ready',message:'Tailscale 已连接'},external:{state:'recovering',message:'正在恢复原入口',url:network.externalOrigin}});
      await this.setup(network);
      forwarding=forwardingState(JSON.parse(await this.run(['serve','status','--json'])),network,this.port);
    }
    if(forwarding!=='ready')return this.update({tailscale:{state:'ready',message:'Tailscale 已连接'},external:{state:'error',message:forwarding==='conflict' ? '转发配置与原服务冲突，未覆盖其他服务' : '转发入口尚未开启',url:network.externalOrigin}});
    const externalUrl=network.hybrid ? network.externalOrigin : network.privateUrl;
    const probeExternal=async()=>{
      try{
        const result=await this.probe(externalUrl,{publicIngress:network.hybrid});
        return {state:result?.state==='warning' ? 'warning' : 'ready',message:result?.state==='warning' ? '公网入口部分线路不可用，可能间歇超时' : network.hybrid ? '公网 HTTPS 访问正常' : 'Tailscale 私有入口正常',url:externalUrl};
      }catch{return {state:'error',message:network.hybrid ? '公网入口连接失败；本机服务仍运行' : '私有入口 HTTPS 访问检查失败',url:externalUrl};}
    };
    let external=await probeExternal();
    if(network.hybrid && external.state!=='ready' && recover && manual){
      this.lastRecovery=this.now();
      this.update({tailscale:{state:'ready',message:'Tailscale 已连接'},external:{state:'recovering',message:'正在重新连接原公网入口',url:externalUrl}});
      try{await this.restartIngress(network);external=await probeExternal();}
      catch{external={state:'error',message:'公网入口重连失败，请在本机检查',url:externalUrl};}
    }
    return this.update({tailscale:{state:'ready',message:'Tailscale 已连接'},external});
  }
  start(){this.check({recover:true});this.timer=setInterval(()=>this.check({recover:true}),30000);this.timer.unref?.();}
  stop(){this.stopped=true;clearInterval(this.timer);}
}
