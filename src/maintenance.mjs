import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {MaintenanceAuth,writePrivateJson} from './maintenance-auth.mjs';
import {maintenanceLaunchFiles,prepareMaintenance} from './desktop-restart.mjs';
import {sourceDir} from './layout.mjs';

const active=new Set(['queued','restarting_desktop','restarting_service','waiting']);
export const maintenanceId=value=>typeof value==='string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
export const jobPath=(dataDir,id)=>{if(!maintenanceId(id))throw new Error('无效的重启请求编号。');return path.join(dataDir,'maintenance-job-'+id+'.json');};
export function readMaintenanceJob(dataDir,id){try{return JSON.parse(fs.readFileSync(jobPath(dataDir,id),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export function publicMaintenanceJob(job){return job?{id:job.id,scope:job.scope,state:job.state,createdAt:job.createdAt,updatedAt:job.updatedAt,error:job.error || null}:null;}
export function updateMaintenanceJob(dataDir,job,patch){Object.assign(job,patch,{updatedAt:Date.now()});writePrivateJson(jobPath(dataDir,job.id),job);}
export class Maintenance {
  constructor({dataDir,port,supervised=process.env.CODEX_RELAY_PARENT_PIPE==='1',platform=process.platform,prepare=prepareMaintenance,launch,now=Date.now}){
    Object.assign(this,{dataDir,port,supervised,platform,prepare,now});this.auth=new MaintenanceAuth(dataDir,{now});this.busy=false;
    this.launch=launch || (job=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(sourceDir,'maintenance-worker.mjs'),jobPath(dataDir,job.id)],{cwd:sourceDir,windowsHide:true,detached:true,stdio:'ignore',env:{...process.env,CODEX_RELAY_DATA_DIR:dataDir}});
      child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
    }));
  }
  latest(){
    try{const id=JSON.parse(fs.readFileSync(path.join(this.dataDir,'maintenance-latest.json'),'utf8')).id;return readMaintenanceJob(this.dataDir,id);}catch{return null;}
  }
  status(id){
    const job=id?readMaintenanceJob(this.dataDir,id):this.latest();let configured=false,error=null;
    if(job && active.has(job.state) && this.now()-job.createdAt>300_000)updateMaintenanceJob(this.dataDir,job,{state:'failed',error:'恢复进程未及时返回，请先核对电脑状态后再操作。'});
    try{configured=this.auth.configured();}catch(cause){error=cause.message;}
    return {passwordConfigured:configured,serviceSupported:this.supervised&&this.platform==='win32',desktopSupported:this.supervised&&this.platform==='win32'&&Boolean(maintenanceLaunchFiles(this.dataDir)),job:publicMaintenanceJob(job),error};
  }
  async request(body){
    if(!body || !maintenanceId(body.requestId) || !['service','desktop'].includes(body.scope))throw new Error('无效的重启请求。');
    if(body.scope==='desktop' && body.confirmDesktop!==true)throw new Error('请确认强制重启会中断这台电脑全部正在运行的 Codex 任务。');
    if(this.busy){const error=new Error('已有重启请求正在处理，请先查询状态。');error.status=409;throw error;}
    this.busy=true;
    try{
      await this.auth.verify(body.password);
      const old=readMaintenanceJob(this.dataDir,body.requestId);
      if(old){if(old.scope!==body.scope)throw new Error('此请求编号已用于另一种重启操作。');return {job:publicMaintenanceJob(old),duplicate:true};}
      if(!this.supervised || this.platform!=='win32')throw new Error('服务没有由 Windows 后台守护入口启动，暂不能自动重启。');
      const previous=this.latest();
      if(previous && active.has(previous.state) && this.now()-previous.createdAt<300_000){const error=new Error('已有重启任务尚未结束，请先查询状态。');error.status=409;throw error;}
      const plan=await this.prepare({scope:body.scope,dataDir:this.dataDir});
      const job={id:body.requestId,scope:body.scope,state:'queued',createdAt:this.now(),updatedAt:this.now(),port:this.port,plan};
      writePrivateJson(jobPath(this.dataDir,job.id),job);writePrivateJson(path.join(this.dataDir,'maintenance-latest.json'),{id:job.id});
      return {job:publicMaintenanceJob(job),start:async()=>{
        try{await this.launch(job);}catch{updateMaintenanceJob(this.dataDir,job,{state:'failed',error:'未能启动独立恢复进程，尚未执行重启。'});}
      }};
    }finally{this.busy=false;}
  }
}
