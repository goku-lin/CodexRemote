export const RECENT_HISTORY_COUNT=8;

export function recentHistorySessions(sessions,{activeId,deviceId,visited=[],limit=RECENT_HISTORY_COUNT,enabled=true,scope='all',projectId}={}) {
  const active=sessions.find(session=>session.id===activeId);
  const project=projectId ?? active?.projectId;
  const available=sessions.filter(session=>session.deviceId===deviceId && !session.hidden && !session.archived
    && (session.id===activeId || scope!=='project' || project!=null && session.projectId===project));
  const byId=new Map(available.map(session=>[session.id,session]));
  const recent=[...available].sort((a,b)=>(b.updatedAt || b.createdAt || 0)-(a.updatedAt || a.createdAt || 0));
  return [...new Set([activeId,...visited,...recent.map(session=>session.id)])]
    .map(id=>byId.get(id)).filter(Boolean).slice(0,enabled ? limit : 1).filter(item=>enabled || item.id===activeId);
}

// Preload text history only. No rendering, media resolution or read-state writes.
export class HistoryPreloader {
  constructor({storage,getState,isCached,load,now=Date.now,delay=350,retryMs=15000}) {
    Object.assign(this,{storage,getState,isCached,load,now,delay,retryMs});
    this.visited=[];this.attempts=new Map();this.timer=null;this.running=false;this.again=false;
    try{const saved=JSON.parse(storage?.getItem('codex-relay-recent-conversations') || '[]');if(Array.isArray(saved))this.visited=saved.filter(id=>typeof id==='string').slice(0,40);}catch{}
  }

  visit(id) {
    if(!id)return;
    this.visited=[id,...this.visited.filter(value=>value!==id)].slice(0,40);
    try{this.storage?.setItem('codex-relay-recent-conversations',JSON.stringify(this.visited));}catch{}
    this.schedule();
  }

  candidates() {
    const state=this.getState();
    return recentHistorySessions(state.sessions,{...state,visited:this.visited});
  }

  schedule() {
    if(this.running){this.again=true;return;}
    if(this.timer!==null)return;
    this.timer=setTimeout(()=>{this.timer=null;this.run();},this.delay);
    this.timer.unref?.();
  }

  async run() {
    if(this.running || this.getState().paused)return;
    this.running=true;this.again=false;
    try {
      for(const candidate of this.candidates()) {
        // A foreground switch, disconnection or hidden page takes precedence.
        const state=this.getState();if(state.paused)break;
        const session=this.candidates().find(item=>item.id===candidate.id);
        if(!session || session.id===state.activeId || this.isCached(session))continue;
        const stamp=JSON.stringify([session.historyLoaded,session.historyVersion,session.historyRequested,state.historyTurns]);
        const previous=this.attempts.get(session.id);
        if(previous?.stamp===stamp && this.now()-previous.at<this.retryMs)continue;
        this.attempts.delete(session.id);this.attempts.set(session.id,{stamp,at:this.now()});
        while(this.attempts.size>40)this.attempts.delete(this.attempts.keys().next().value);
        try{await this.load(session);}catch{/* Retry on a later activity event. */}
      }
    } finally {
      this.running=false;
      if(this.again)this.schedule();
    }
  }
}
