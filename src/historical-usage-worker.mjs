import {parentPort,workerData} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readdir,stat,open,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {normalizeUsageRange} from '../public/usage-range.js';

await mkdir(path.dirname(workerData.cacheFile),{recursive:true});
const db=new DatabaseSync(workerData.cacheFile);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
 CREATE TABLE IF NOT EXISTS usage_files(path TEXT PRIMARY KEY, size INTEGER, mtime REAL, offset INTEGER, tail TEXT, state TEXT);
 CREATE TABLE IF NOT EXISTS usage_calls(key TEXT PRIMARY KEY, model TEXT, total INTEGER, input INTEGER, cached INTEGER, output INTEGER, reasoning INTEGER, at INTEGER, duration INTEGER);
 CREATE TABLE IF NOT EXISTS usage_file_calls(file TEXT, key TEXT, PRIMARY KEY(file,key));
 CREATE INDEX IF NOT EXISTS usage_call_files ON usage_file_calls(key);
 CREATE INDEX IF NOT EXISTS usage_call_time ON usage_calls(at);`);
if(db.prepare('PRAGMA user_version').get().user_version!==3)db.exec('BEGIN; DELETE FROM usage_file_calls; DELETE FROM usage_calls; DELETE FROM usage_files; PRAGMA user_version=3; COMMIT;');
const findFile=db.prepare('SELECT * FROM usage_files WHERE path=?');
const saveFile=db.prepare('INSERT OR REPLACE INTO usage_files VALUES(?,?,?,?,?,?)');
const saveCall=db.prepare(`INSERT INTO usage_calls VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET model=CASE WHEN usage_calls.model='unknown' THEN excluded.model ELSE usage_calls.model END`);
const linkCall=db.prepare('INSERT OR IGNORE INTO usage_file_calls VALUES(?,?)');
const removeLinks=db.prepare('DELETE FROM usage_file_calls WHERE file=?');
const removeFile=db.prepare('DELETE FROM usage_files WHERE path=?');
const valid=value=>Number.isSafeInteger(value)&&value>=0 ? value : null;
function counts(value) {
  if(!value || typeof value!=='object')return null;
  const total=valid(value.total_tokens ?? value.totalTokens);if(total==null)return null;
  const output=valid(value.output_tokens ?? value.outputTokens);
  // Some providers report cache input separately; total minus output gives a
  // consistent inclusive input count without adding cached tokens twice.
  return {total,output:output ?? 0,input:output!=null && output<=total ? total-output : 0,
    cached:valid(value.cached_input_tokens ?? value.cachedInputTokens) ?? 0,
    reasoning:valid(value.reasoning_output_tokens ?? value.reasoningOutputTokens) ?? 0};
}
function consume(entry,state,file) {
  const p=entry.payload || {};
  if(entry.type==='turn_context') {state.model=typeof p.model==='string' ? p.model.trim().toLowerCase() : state.model;state.turn=p.turn_id || state.turn;return;}
  if(entry.type==='event_msg' && p.type==='task_started'){state.turn=p.turn_id || state.turn;return;}
  if(entry.type!=='event_msg' || p.type!=='token_count' || !p.info)return;
  const current=counts(p.info.total_token_usage || p.info.total),last=counts(p.info.last_token_usage || p.info.last);
  if(!last && !current)return;
  const at=Date.parse(entry.timestamp) || 0,model=state.model || 'unknown';
  // Model/context changes can replay or recalculate the last-call breakdown.
  // An unchanged cumulative total is not additional consumption.
  if(current && state.total && current.total===state.total.total)return;
  const delta=current && state.total ? current.total-state.total.total : null;
  // Only per-call usage is counted here. A cumulative counter can
  // include inherited fork history or records located in another rollout.
  const amount=last;
  if(amount?.total>0) {
    // Forks copy old token_count records. The original timestamp and counters
    // identify the same accounting event even when its log is copied or moved.
    const key=createHash('sha256').update(JSON.stringify([entry.timestamp,current,last])).digest('hex');
    const duration=last && state.at && state.turn && state.previousTurn===state.turn && state.previousModel===model
      && at-state.at>=500 && delta===last.total ? at-state.at : null;
    const add=(suffix,value,label,elapsed)=>{
      saveCall.run(key+suffix,label,value.total,value.input,value.cached,value.output,value.reasoning,at,elapsed);
      linkCall.run(file,key+suffix);
    };
    add('',amount,model,duration);
  }
  state.total=current;state.last=last;state.at=at;state.previousTurn=state.turn;state.previousModel=model;
}
async function filesIn(roots) {
  const files=[],directories=[...roots];
  while(directories.length){const directory=directories.pop();let entries;
    try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
    for(const entry of entries){const file=path.join(directory,entry.name);if(entry.isDirectory())directories.push(file);else if(entry.isFile() && entry.name.endsWith('.jsonl'))files.push(file);}
  }
  return files.sort();
}
async function tailAt(file,offset) {
  if(!offset)return '';
  const handle=await open(file,'r');
  try{const bytes=Buffer.alloc(Math.min(64,offset));const {bytesRead}=await handle.read(bytes,0,bytes.length,offset-bytes.length);return bytes.subarray(0,bytesRead).toString('base64');}
  finally{await handle.close();}
}
let lastProgress=0,activeRequest=0,indexUpdatedAt=0;
function progress(value,force=false){if(force || Date.now()-lastProgress>700){lastProgress=Date.now();parentPort.postMessage({requestId:activeRequest,type:'progress',value:{...value,status:'indexing'}});}}
function summarize(range=null) {
  if(range)range=normalizeUsageRange(range);
  const where=range ? 'WHERE at>=? AND at<?' : '',args=range ? [range.from,range.to] : [];
  const models=db.prepare(`SELECT model,SUM(total) totalTokens,SUM(input) inputTokens,SUM(cached) cachedInputTokens,SUM(output) outputTokens,SUM(reasoning) reasoningTokens,COUNT(*) calls,
   SUM(CASE WHEN duration>0 THEN output ELSE 0 END)*1000.0/NULLIF(SUM(duration),0) averageTokensPerSecond FROM usage_calls ${where} GROUP BY model ORDER BY totalTokens DESC`).all(...args);
  const bounds=db.prepare(`SELECT MIN(at) firstAt,MAX(at) lastAt,COUNT(*) calls FROM usage_calls ${where}`).get(...args);
  return {...bounds,models,totalTokens:models.reduce((sum,model)=>sum+model.totalTokens,0),updatedAt:indexUpdatedAt,
    status:'ready',scope:'local-history',...(range ? {range} : {})};
}
async function scan() {
  const files=await filesIn(workerData.roots),seen=new Set(files),status={files:files.length,scannedFiles:0,bytesRead:0,cachedFiles:0,unreadableFiles:0};
  progress(status,true);
  for(const file of files) {
    let info;try{info=await stat(file);}catch{status.unreadableFiles++;continue;}
    let previous=findFile.get(file),state={},offset=0;
    if(previous?.size===info.size && previous.mtime===info.mtimeMs){status.scannedFiles++;status.cachedFiles++;progress(status);continue;}
    if(previous && info.size>=previous.offset && previous.tail===await tailAt(file,previous.offset)){state=JSON.parse(previous.state);offset=previous.offset;}
    db.exec('BEGIN');
    try {
      if(!offset)removeLinks.run(file);
      let carry=Buffer.alloc(0),skipping=false,complete=offset;
      for await(const chunk of createReadStream(file,{start:offset,end:Math.max(offset,info.size-1),highWaterMark:256*1024})) {
        status.bytesRead+=chunk.length;let start=0,newline;
        while((newline=chunk.indexOf(10,start))>=0){
          const part=chunk.subarray(start,newline);complete+=part.length+1+carry.length;
          if(!skipping && carry.length+part.length<=2*1024*1024) {
            const line=carry.length ? Buffer.concat([carry,part]) : part;
            // Skip prompts, image bytes and tool output without parsing them.
            const prefix=line.subarray(0,256).toString('utf8');
            if(prefix.includes('"turn_context"') || prefix.includes('"event_msg"') && (prefix.includes('"token_count"') || prefix.includes('"task_started"'))) {
              try{consume(JSON.parse(line.toString('utf8')),state,file);}catch(error){if(error.code)throw error;}
            }
          }
          carry=Buffer.alloc(0);skipping=false;start=newline+1;
        }
        if(start<chunk.length){const part=chunk.subarray(start);if(skipping || carry.length+part.length>2*1024*1024){complete+=carry.length+part.length;carry=Buffer.alloc(0);skipping=true;}else carry=carry.length ? Buffer.concat([carry,part]) : Buffer.from(part);}
        progress(status);
      }
      // An unfinished final record is read again once Codex appends its newline.
      const tail=await tailAt(file,complete);
      saveFile.run(file,info.size,info.mtimeMs,complete,tail,JSON.stringify(state));db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');status.unreadableFiles++;}
    status.scannedFiles++;progress(status);
  }
  db.exec('BEGIN');
  for(const {path:file} of db.prepare('SELECT path FROM usage_files').all())if(!seen.has(file)){removeLinks.run(file);removeFile.run(file);}
  db.exec('DELETE FROM usage_calls WHERE NOT EXISTS(SELECT 1 FROM usage_file_calls WHERE usage_file_calls.key=usage_calls.key); COMMIT;');
  indexUpdatedAt=Date.now();
  return {...status,...summarize()};
}
// Queue queries behind a scan so no result can observe half-indexed files.
let work=Promise.resolve();
parentPort.on('message',message=>{
  work=work.then(async()=>{
    activeRequest=message.requestId;
    try{const value=message.type==='scan' ? await scan() : message.type==='query' ? summarize(message.range) : null;
      parentPort.postMessage({requestId:message.requestId,type:'result',value});}
    catch(error){parentPort.postMessage({requestId:message.requestId,type:'error',error:error.message});}
  });
});
