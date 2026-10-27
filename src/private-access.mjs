import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {projectRoot} from './layout.mjs';
import {request as httpRequest} from 'node:http';
import {privateOrigin} from './browser-access.mjs';

const root=projectRoot;
const dataDir=process.env.CODEX_RELAY_DATA_DIR || path.join(root,'.relay-data');
const cli=process.env.TAILSCALE_BIN || (process.platform==='win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files','Tailscale','tailscale.exe') : 'tailscale');
const run=async (...args)=>(await promisify(execFile)(cli,args,{windowsHide:true,timeout:45_000})).stdout;
const hybrid=process.argv.includes('--hybrid');
const probeRequest=(url,headers)=>new Promise((resolve,reject)=>{
  const req=httpRequest(url,{headers},res=>{
    let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);
    res.on('end',()=>resolve({status:res.statusCode,json:()=>JSON.parse(text)}));res.on('error',reject);
  });req.setTimeout(5000,()=>req.destroy(new Error('Relay 验证超时。')));req.on('error',reject);req.end();
});

try {
  const status=JSON.parse(await run('status','--json'));
  if(status.BackendState!=='Running')throw new Error(`请先在电脑登录 Tailscale。电脑状态：${status.BackendState}${status.AuthURL ? '\n'+status.AuthURL : ''}`);
  const origin=privateOrigin('https://'+String(status.Self?.DNSName || '').replace(/\.$/,''));
  const port=Number(process.env.PORT || 4317);
  if(!Number.isInteger(port) || port<1 || port>65535)throw new Error('Relay 端口无效。');
  const target=`http://127.0.0.1:${port}`;
  const configFile=path.join(dataDir,'network.json');
  const config=JSON.parse(await run('serve','status','--json'));
  const hostname=new URL(origin).host;
  // Ports belonging to another app must never be replaced.
  if(!hybrid && Object.values(config.AllowFunnel || {}).some(Boolean))throw new Error('已有公开 Funnel 配置，请先核对并关闭它，再配置私有 Relay。');
  for(const tlsPort of hybrid ? [443,8443] : [443]){
    const web=config.Web?.[hostname+':'+tlsPort];
    if((web || config.TCP?.[tlsPort]) && (!web || Object.keys(web.Handlers || {}).length!==1 || web.Handlers?.['/']?.Proxy!==target))throw new Error(`Tailscale 的 ${tlsPort} 端口已有其他服务，未覆盖其配置。`);
    if(tlsPort===8443 && config.AllowFunnel?.[hostname+':8443'])throw new Error('8443 已作为公开入口，请先核对其用途，未覆盖配置。');
  }
  const access=(await probeRequest(target+'/api/access',{'x-forwarded-for':'100.64.0.2'})).json();
  if(!access.required || access.local!==false)throw new Error('请先更新并重启 Relay，使代理请求经过配对，再开启外网入口。');
  fs.mkdirSync(dataDir,{recursive:true});
  let settings={};try{settings=JSON.parse(fs.readFileSync(configFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=configFile+'.tmp';
  const privateUrl=hybrid ? privateOrigin(origin+':8443') : '';
  const nextSettings={...settings,externalOrigin:origin,privateOrigin:privateUrl,accessMode:hybrid ? 'hybrid' : 'private'};
  fs.writeFileSync(temporary,JSON.stringify(nextSettings),{mode:0o600});fs.renameSync(temporary,configFile);
  let startedPrivate=false,startedPublic=false;
  try {
    for(const entry of hybrid ? [origin,privateUrl] : [origin]){
      const probeHeaders={host:new URL(entry).host,'x-forwarded-proto':'https',origin:entry};
      const probe=await probeRequest(target+'/api/access',probeHeaders);
      if(probe.status!==200 || !probe.json().required || probe.json().local!==false)throw new Error('Relay 尚未正确识别 HTTPS 入口，未开启代理。');
      for(const endpoint of ['/api/phone','/api/access/devices'])if((await probeRequest(target+endpoint,probeHeaders)).status!==403)throw new Error('远程入口仍可读取本机配对码或管理设备，未开启代理。');
    }
    if(hybrid){
      startedPrivate=true;process.stdout.write(await run('serve','--bg','--yes','--https=8443',target));
      startedPublic=true;process.stdout.write(await run('funnel','--bg','--yes','--https=443',target));
      const active=JSON.parse(await run('serve','status','--json'));
      if(active.AllowFunnel?.[hostname+':443']!==true || active.AllowFunnel?.[hostname+':8443'])throw new Error('混合入口配置尚未生效。');
    }else process.stdout.write(await run('serve','--bg','--yes','--https=443',target));
  }
  catch(error) {
    // Undo only this app's newly changed ports, preserving pre-existing services.
    try {
      const current=JSON.parse(await run('serve','status','--json'));
      if(startedPublic && !config.AllowFunnel?.[hostname+':443'] && current.Web?.[hostname+':443']?.Handlers?.['/']?.Proxy===target){
        if(config.Web?.[hostname+':443'])await run('serve','--bg','--yes','--https=443',target);
        else await run('funnel','--https=443','off');
      }
      if(startedPrivate && !config.Web?.[hostname+':8443'] && current.Web?.[hostname+':8443']?.Handlers?.['/']?.Proxy===target)await run('serve','--https=8443','off');
    } catch(rollbackError){console.error('入口回退未完成，请检查 tailscale serve status：'+rollbackError.message);}
    fs.writeFileSync(temporary,JSON.stringify(settings),{mode:0o600});fs.renameSync(temporary,configFile);
    throw error;
  }
  console.log(hybrid
    ? `浏览器直接访问：${origin}/\n已安装 Tailscale 的设备：${privateUrl}/\n两种入口均需配对，在电脑 Relay 的“连接手机”中管理设备授权。`
    : `手机和笔记本连接 Tailscale 后打开：${origin}/\n在电脑 Relay 左下角“连接手机”取得配对码。`);
} catch(error) {
  console.error([error.stdout,error.stderr,error.message].filter(Boolean).join('\n'));process.exitCode=1;
}
