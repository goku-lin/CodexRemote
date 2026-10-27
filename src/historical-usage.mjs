import {Worker} from 'node:worker_threads';
import {normalizeUsageRange} from '../public/usage-range.js';

export class HistoricalUsage {
  constructor({roots,cacheFile,onProgress=()=>{}}) {Object.assign(this,{roots,cacheFile,onProgress});this.worker=null;this.pending=null;this.sequence=0;}
  read() {
    if(this.pending)return this.pending;
    this.pending=this.request('scan').finally(()=>{this.pending=null;});
    return this.pending;
  }
  async query(range) {return this.request('query',normalizeUsageRange(range));}
  request(type,range) {
    this.worker ||= new Worker(new URL('./historical-usage-worker.mjs',import.meta.url),{workerData:{roots:this.roots,cacheFile:this.cacheFile}});
    return new Promise((resolve,reject)=>{
      const worker=this.worker,requestId=++this.sequence;
      const cleanup=()=>{worker.off('message',message);worker.off('error',error);worker.off('exit',exited);};
      const error=err=>{cleanup();if(this.worker===worker)this.worker=null;reject(err);};
      const exited=code=>error(new Error('历史用量统计进程已退出（'+code+'）'));
      const message=result=>{
        if(result.requestId!==requestId)return;
        if(result.type==='progress'){this.onProgress(result.value);return;}
        cleanup();if(result.type==='error')reject(new Error(result.error));else resolve(result.value);
      };
      worker.on('message',message);worker.once('error',error);worker.once('exit',exited);worker.postMessage({type,range,requestId});
    });
  }
  async close(){const worker=this.worker;this.worker=null;if(worker)await worker.terminate();}
}
