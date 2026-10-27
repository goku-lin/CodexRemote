import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {stat} from 'node:fs/promises';
import {accountLimits} from '../public/usage.js';

// Observe only file metadata. Credentials, tokens and account IDs never enter
// the browser quota cache or the account-change detector.
export async function usageIdentity(files){
  return JSON.stringify(await Promise.all(files.map(async file=>{
    try{const s=await stat(file);return [s.ino,s.size,s.mtimeMs,s.ctimeMs];}
    catch(error){if(error.code==='ENOENT')return null;throw error;}
  })));
}

// A long-lived app-server retains its login after auth.json is replaced. This
// short-lived reader starts with the current login and never loads a thread.
export function readFreshAccountUsage({command,args=['app-server','--listen','stdio://'],env=process.env,cwd,timeoutMs=20000}){
  return new Promise((resolve,reject)=>{
    let child,lines,finished=false,bytes=0;
    const finish=(error,value)=>{
      if(finished)return;finished=true;clearTimeout(timer);lines?.close();
      child?.stdin.end();child?.kill();
      if(error)reject(error);else resolve(value);
    };
    const timer=setTimeout(()=>finish(new Error('当前账号额度读取超时')),timeoutMs);
    try{child=spawn(command,args,{cwd,env,windowsHide:true,shell:process.platform==='win32'&&!command.toLowerCase().endsWith('.exe'),stdio:['pipe','pipe','ignore']});}
    catch(error){finish(error);return;}
    child.on('error',error=>finish(error));child.stdin.on('error',error=>finish(error));
    child.on('exit',()=>finish(new Error('额度读取进程提前退出')));
    lines=readline.createInterface({input:child.stdout});
    const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
    lines.on('line',line=>{
      if(finished)return;
      bytes+=Buffer.byteLength(line);if(bytes>512*1024){finish(new Error('额度响应过大'));return;}
      let message;try{message=JSON.parse(line);}catch{return;}
      if(![1,2].includes(message.id))return;
      if(message.error){finish(new Error(message.error.message || '当前账号额度读取失败'));return;}
      if(message.id===1){
        send({method:'initialized',params:{}});
        send({id:2,method:'account/rateLimits/read',params:{}});
      }else finish(null,message.result);
    });
    child.once('spawn',()=>send({id:1,method:'initialize',params:{clientInfo:{name:'codex-relay-quota',version:'0.1.0'},capabilities:{experimentalApi:true}}}));
  });
}

export class AccountUsageMonitor {
  constructor({read,identity,publish,now=Date.now}){Object.assign(this,{read,identity,publish,now});this.signature='';this.force=false;}
  async check(){if(await this.identity()!==this.currentIdentity)return this.refresh(true);}
  refresh(force=false){
    this.force ||= force;
    if(this.task)return this.task;
    this.task=Promise.resolve().then(async()=>{
      for(;;){
        const identity=await this.identity();
        if(identity!==this.currentIdentity){
          this.currentIdentity=identity;this.signature='';
          await this.publish({buckets:[],error:null,refreshing:true,reset:true,updatedAt:0});
        }
        let data,error;
        try{data=await this.read();}catch(cause){error='额度读取失败：'+cause.message;}
        // A switch during a pending request must never publish the old login.
        if(await this.identity()!==identity)continue;
        const usage={buckets:accountLimits(data),error:error || null,refreshing:false,reset:true};
        const signature=JSON.stringify(usage);
        if(this.force || signature!==this.signature){
          if(await this.publish({...usage,updatedAt:this.now()}))this.signature=signature;
        }
        this.force=false;return;
      }
    }).finally(()=>{this.task=null;});
    return this.task;
  }
}
