import http from 'node:http';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {scriptsDir} from './layout.mjs';

const execute=promisify(execFile);
const helper=path.join(scriptsDir,'lan-access.ps1');
const privateIPv4=value=>typeof value==='string' && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(value) && value.split('.').length===4 && value.split('.').every(part=>/^\d{1,3}$/.test(part)&&Number(part)<=255);
async function windowsAccess(port,configure=false){
  if(process.platform!=='win32')throw new Error('局域网按需开关目前仅支持 Windows。');
  if(configure)try{return await windowsAccess(port);}catch{ /* Configure once when rules do not exist yet. */ }
  const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Port',String(port),'-Program',path.resolve(process.execPath),...(configure?['-Configure']:[])],{windowsHide:true,timeout:120000,maxBuffer:32768});
  const result=JSON.parse(stdout.replace(/^\ufeff/,'').trim());
  if(!Array.isArray(result.addresses) || !result.addresses.length || !result.addresses.every(privateIPv4))throw new Error('未找到已设为专用网络的局域网地址。');
  return [...new Set(result.addresses)];
}

// Separate listeners leave the loopback/Tailscale connection and Runner intact.
// Grants stay in memory: a restart returns to loopback only.
export class LanAccess {
  constructor({port,handler,prepare=()=>windowsAccess(port,true),inspect=()=>windowsAccess(port),createServer=http.createServer,interval=30000}){
    Object.assign(this,{port,handler,prepare,inspect,createServer,interval});
    this.listeners=new Map();this.error=null;this.busy=false;this.generation=0;
  }
  status(){return {lanEnabled:this.listeners.size>0,urls:[...this.listeners.keys()].map(address=>`http://${address}:${this.port}/`),lanError:this.error};}
  async set(enabled){
    if(this.busy)throw new Error('局域网设置正在处理中，请稍候。');
    this.busy=true;
    const generation=this.generation;
    try{
      if(!enabled){this.close();return this.status();}
      if(this.listeners.size)return this.status();
      const addresses=await this.prepare();
      if(this.generation!==generation)throw new Error('局域网操作已取消。');
      if(!Array.isArray(addresses)||!addresses.length||!addresses.every(privateIPv4))throw new Error('局域网地址无效。');
      for(const address of new Set(addresses)){
        const server=this.createServer(this.handler),sockets=new Set();
        server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(this.port,address,()=>{server.removeListener('error',reject);resolve();});});
        this.listeners.set(address,{server,sockets});
        server.on('error',()=>{this.close();this.error='局域网监听失败，入口已关闭。';});
      }
      this.error=null;
      this.monitor=setInterval(()=>void this.refresh(),this.interval);this.monitor.unref();
      return this.status();
    }catch(error){this.close();this.error='局域网未开启：请确认专用网络及防火墙设置，首次开启需同意 Windows 管理员授权。';throw new Error(this.error,{cause:error});}
    finally{this.busy=false;}
  }
  async refresh(){
    if(!this.listeners.size||this.checking)return;
    this.checking=true;
    const generation=this.generation;
    try{
      const addresses=await this.inspect();
      if(generation!==this.generation)return;
      if([...this.listeners.keys()].some(address=>!addresses.includes(address)))this.close();
    }catch{if(generation===this.generation){this.close();this.error='网络或防火墙状态已变化，局域网入口已关闭。';}}
    finally{this.checking=false;}
  }
  close(){
    this.generation++;
    clearInterval(this.monitor);
    for(const {server,sockets} of this.listeners.values()){for(const socket of sockets)socket.destroy();server.close();}
    this.listeners.clear();this.error=null;
  }
}
