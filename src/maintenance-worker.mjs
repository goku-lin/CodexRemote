import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {runMaintenanceProcess} from './desktop-restart.mjs';
import {jobPath,readMaintenanceJob,updateMaintenanceJob} from './maintenance.mjs';

export async function runMaintenanceJob(dataDir,id,{run=runMaintenanceProcess,sleep=delay,health=async port=>{
  const response=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(2000)});if(!response.ok)throw new Error('服务正在启动');return response.json();
},nativePid=file=>JSON.parse(fs.readFileSync(file,'utf8')).pid,now=Date.now}={}){
  const job=readMaintenanceJob(dataDir,id);if(!job || job.state!=='queued')return;
  // A duplicate worker or a lost HTTP response must never execute a second restart.
  try{fs.closeSync(fs.openSync(jobPath(dataDir,id)+'.claimed','wx'));}catch(error){if(error.code==='EEXIST')return;throw error;}
  const update=patch=>updateMaintenanceJob(dataDir,job,patch);
  const check=()=>{if(readMaintenanceJob(dataDir,id)?.state==='failed' || now()-job.createdAt>300_000)throw new Error('重启请求已过期，未继续执行。');};
  try{
    await sleep(1000); // Let the initiating response reach the browser first.
    check();
    if(job.scope==='desktop'){
      update({state:'restarting_desktop'});
      await run('desktop',{plan:job.plan,desktopExe:job.plan.desktopExe,proxyExe:job.plan.proxyExe});
    }
    check();update({state:'restarting_service'});await run('service',{plan:job.plan});update({state:'waiting'});
    const deadline=now()+120_000;
    while(now()<deadline){
      await sleep(1500);
      try{
        const report=await health(job.port);
        const desktopReady=job.scope!=='desktop' || report.desktop?.state==='ready' && nativePid(job.plan.endpointFile)!==job.plan.oldNativePid;
        if(report.relay?.state==='ready' && report.runner?.state==='ready' && desktopReady){update({state:'complete',error:null});return;}
      }catch{}
    }
    throw new Error('重启后尚未确认连接恢复，请查看连接检查或在电脑本机检查。');
  }catch(error){update({state:'failed',error:error.message});}
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const file=path.resolve(process.argv[2] || ''),dataDir=path.resolve(process.env.CODEX_RELAY_DATA_DIR || '');
    const match=path.basename(file).match(/^maintenance-job-([a-zA-Z0-9_-]{16,80})\.json$/);
    if(!match || file!==jobPath(dataDir,match[1]))throw new Error('无效的本机恢复任务。');
    await runMaintenanceJob(dataDir,match[1]);
  }catch{process.exitCode=1;}
}
