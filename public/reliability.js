export function requestId() {
  const bytes=new Uint8Array(16); crypto.getRandomValues(bytes);
  return [...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export class Drafts {
  constructor(storage,key='codex-relay-drafts') {
    this.storage=storage;this.key=key;this.items={};
    try { this.items=JSON.parse(storage.getItem(key)||'{}'); } catch { /* unavailable storage */ }
  }
  get(id){return this.items[id] || {text:'',attachments:[]};}
  set(id,value){if(!id)return;this.items[id]=value;try{this.storage.setItem(this.key,JSON.stringify(this.items));}catch{/* keep in memory */}}
  clearPending(id){const draft=this.get(id);delete draft.pending;this.set(id,draft);}
}

export class LiveConnection {
  constructor({createStream=()=>new EventSource('/api/events'),onEvent,onStatus,onReconnect,now=Date.now,timeout=35_000}) {
    Object.assign(this,{createStream,onEvent,onStatus,onReconnect,now,timeout});this.lastReceived=0;this.stream=null;this.status='idle';
  }
  setStatus(status){this.status=status;this.onStatus(status);}
  connect(){
    if(this.blocked)return;
    this.stream?.close(); const stream=this.createStream();this.stream=stream;this.lastReceived=this.now();
    this.setStatus('connecting');
    for(const type of ['snapshot','device','session','relay','catalog','projects','delivery','account_usage','historical_usage','health']) stream.addEventListener(type,event=>{
      if(this.stream!==stream)return;this.lastReceived=this.now();this.onEvent(type,JSON.parse(event.data));
    });
    stream.addEventListener('heartbeat',()=>{if(this.stream===stream)this.lastReceived=this.now();});
    stream.addEventListener('access_revoked',event=>{
      if(this.stream!==stream)return;
      this.block();this.onEvent('access_revoked',JSON.parse(event.data));
    });
    stream.onopen=()=>{if(this.stream!==stream)return;this.lastReceived=this.now();this.setStatus('connected');this.onReconnect?.();};
    stream.onerror=()=>{if(this.stream===stream)this.setStatus('reconnecting');};
  }
  resume(){
    if(this.blocked)return false;
    // Reuse healthy streams and in-flight handshakes. Visibility/pageshow/online
    // can all fire together; restarting each time downloads duplicate snapshots.
    const fresh=this.now()-this.lastReceived<=this.timeout;
    if(this.stream && this.stream.readyState!==2 && fresh && ['connected','connecting'].includes(this.status))return false;
    this.connect();return true;
  }
  offline(){this.stream?.close();this.stream=null;this.setStatus('offline');}
  block(){this.blocked=true;this.stream?.close();this.stream=null;this.setStatus('unauthorized');}
  check(){if(this.stream && this.now()-this.lastReceived>this.timeout)this.connect();}
}
