const key='recent-text',MAX_BYTES=1024*1024;
const text=value=>typeof value==='string'?value.slice(0,30000):'';
export function textPreview(session){
  const events=(session.events || []).flatMap(event=>{
    if(event.type==='user_message')return [{type:'user_message',id:event.id,turnId:event.turnId,text:text(event.text),at:event.at}];
    const message=event.message,item=message?.params?.item;
    if(event.type==='codex' && message.method==='item/completed' && item?.type==='agentMessage' && item.text && !item.questions?.length)
      return [{type:'codex',at:event.at,message:{method:'item/completed',params:{turnId:message.params.turnId,item:{id:item.id,type:'agentMessage',text:text(item.text),status:'completed'}}}}];
    return [];
  }).slice(-16);
  if(!events.length)return null;
  const fields=['id','title','threadId','deviceId','projectId','projectName','cwd','source','pinned','pinOrder'];
  return {...Object.fromEntries(fields.map(k=>[k,session[k]])),events,status:'synced',cachedPreview:true,historyLoaded:false,
    controls:{},unread:false,pendingAttention:[],turns:[],turnCount:session.turnCount};
}
export function resumeSnapshot(sessions,activeId,positions={},now=Date.now()){
  const ordered=[sessions.find(s=>s.id===activeId),...sessions].filter(Boolean);
  const selected=[],ids=new Set();let bytes=0;
  for(const session of ordered){
    if(ids.has(session.id)||session.cachedPreview)continue;
    const preview=textPreview(session);if(!preview)continue;
    const size=JSON.stringify(preview).length*2;if(bytes+size>MAX_BYTES)continue;
    ids.add(session.id);selected.push(preview);bytes+=size;if(selected.length>=5)break;
  }
  return {schema:1,savedAt:now,activeId,sessions:selected,positions:Object.fromEntries(selected.map(s=>[s.id,{top:Math.max(0,Number(positions[s.id]?.top)||0),inputId:positions[s.id]?.inputId || null}]))};
}
export class ResumeCache {
  constructor({indexedDB=globalThis.indexedDB,now=Date.now}={}){Object.assign(this,{indexedDB,now});this.generation=0;}
  async database(){
    if(!this.indexedDB)return null;
    if(!this.opening)this.opening=new Promise(resolve=>{
      const request=this.indexedDB.open('codex-relay-resume',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('preview');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve(null);request.onblocked=()=>resolve(null);
    });
    return this.opening;
  }
  async read(){
    const db=await this.database();if(!db)return null;
    return new Promise(resolve=>{const req=db.transaction('preview').objectStore('preview').get(key);req.onerror=()=>resolve(null);req.onsuccess=()=>{const value=req.result;if(value?.schema===1&&Array.isArray(value.sessions)&&this.now()-value.savedAt>=0&&this.now()-value.savedAt<7*86400000)resolve(value);else this.clear().finally(()=>resolve(null));};});
  }
  async write(snapshot){
    const generation=this.generation,db=await this.database();if(!db||generation!==this.generation)return;
    await new Promise(resolve=>{const tx=db.transaction('preview','readwrite');tx.objectStore('preview').put(snapshot,key);tx.oncomplete=tx.onerror=tx.onabort=()=>resolve();});
  }
  async clear(){this.generation++;const db=await this.database();if(!db)return;await new Promise(resolve=>{const tx=db.transaction('preview','readwrite');tx.objectStore('preview').clear();tx.oncomplete=tx.onerror=tx.onabort=()=>resolve();});}
}
