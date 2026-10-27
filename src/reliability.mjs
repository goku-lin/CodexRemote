import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function save(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temporary=file+'.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value), {mode:0o600});
  fs.renameSync(temporary,file);
}

export function persistentToken(directory) {
  const file=path.join(directory,'runner-token');
  fs.mkdirSync(directory,{recursive:true});
  try { return fs.readFileSync(file,'utf8').trim(); }
  catch(error) {
    if(error.code !== 'ENOENT') throw error;
    const token=crypto.randomBytes(24).toString('hex');
    try { fs.writeFileSync(file,token,{flag:'wx',mode:0o600}); return token; }
    catch(writeError) { if(writeError.code !== 'EEXIST') throw writeError; return fs.readFileSync(file,'utf8').trim(); }
  }
}

// Persist before dispatch. After an interrupted dispatch, never replay a model request.
export class DeliveryStore {
  constructor(directory) {
    this.file=path.join(directory,'deliveries.json'); this.data={requests:{},sessions:{}};
    try { this.data=JSON.parse(fs.readFileSync(this.file,'utf8')); }
    catch(error) { if(error.code !== 'ENOENT') throw error; }
    for(const receipt of Object.values(this.data.requests)) if(receipt.state==='dispatched') receipt.state='uncertain';
    if(Object.keys(this.data.requests).length) this.flush();
  }
  flush() { save(this.file,this.data); }
  get(id) { return this.data.requests[id]; }
  check(id,scope,body) {
    if(!id) return null;
    if(!/^[a-zA-Z0-9_-]{16,80}$/.test(id)) throw new Error('无效的发送编号。');
    const fingerprint=crypto.createHash('sha256').update(scope+JSON.stringify(body)).digest('hex');
    const old=this.get(id);
    if(old && (old.scope!==scope || old.fingerprint!==fingerprint)) throw new Error('这次发送的内容已改变，请重新发送。');
    return {id,scope,fingerprint,old};
  }
  add(check,session,response,command) {
    if(!check) return;
    this.data.requests[check.id]={id:check.id,scope:check.scope,fingerprint:check.fingerprint,sessionId:session.id,deviceId:session.deviceId,state:'queued',at:Date.now(),response,command};
    this.remember(session); this.flush();
  }
  remember(session) {
    if(!this.data.sessions[session.id] && !Object.values(this.data.requests).some(item=>item.sessionId===session.id)) return;
    const {events,turns,questionItems,questionResponses,liveItems,liveNotices,liveTurn,liveResyncIds,...metadata}=session;
    this.data.sessions[session.id]={...metadata,historyRequested:false,historyLoaded:false};
  }
  sessionChanged(session) { this.remember(session); if(this.data.sessions[session.id]) this.flush(); }
  update(id,state,error=null) {
    const item=this.get(id); if(!item || item.state===state && item.error===error) return;
    item.state=state; item.error=error; if(state!=='queued') delete item.command; this.flush();
  }
  forSession(id,state,error) {
    for(const item of Object.values(this.data.requests)) if(item.sessionId===id && (state==='uncertain' ? item.state==='dispatched' : ['queued','dispatched','uncertain'].includes(item.state))) this.update(item.id,state,error);
  }
  queued() { return Object.values(this.data.requests).filter(item=>item.state==='queued' && item.command); }
  dispatch(id,command) {
    const item=this.get(id);
    if(!item || item.state!=='waiting')throw new Error('待发送消息的状态已改变。');
    item.command=command;item.state='queued';item.error=null;this.flush();
  }
}
