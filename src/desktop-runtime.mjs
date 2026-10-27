import {applyThreadStatus} from './thread-sync.mjs';

// A persisted turn can be marked interrupted while Desktop still owns and
// executes it. Verify the existing Desktop child; never load a second writer.
export class DesktopRuntimeReader {
  constructor(native,{now=Date.now,epoch,activeMs=10_000,idleMs=60_000}={}) {
    Object.assign(this,{native,now,epoch,activeMs,idleMs});this.states=new Map();this.pending=new Map();this.revision=0;
  }
  get(threadId){return this.states.get(threadId);}
  save(threadId,status,turnId,observedAt=this.now(),source='event') {
    const state={threadId,status,turnId:status.type==='active' ? turnId || null : null,observedAt,epoch:this.epoch,revision:++this.revision,source};
    this.states.set(threadId,state);return state;
  }
  observe(message) {
    const threadId=message.params?.threadId,previous=this.get(threadId);
    if(message.method==='turn/started')return this.save(threadId,{type:'active',activeFlags:[]},message.params.turn.id);
    if(message.method==='thread/status/changed')return this.save(threadId,message.params.status,this.native.activeTurns.get(threadId) || previous?.turnId);
    if(message.method==='turn/completed') {
      if(previous?.status.type==='active' && previous.turnId && previous.turnId!==message.params.turn.id)return previous;
      return this.save(threadId,{type:'idle'},null);
    }
    if(['thread/reverted','thread/archived'].includes(message.method))return this.save(threadId,{type:'idle'},null);
    return undefined;
  }
  async read(threadId) {
    if(this.pending.has(threadId))return this.pending.get(threadId);
    const previous=this.get(threadId),at=this.now();
    if(previous && at-previous.observedAt < (previous.status.type==='active' ? this.activeMs : this.idleMs))return previous;
    const task=(async()=>{
      try {
        const {thread}=await this.native.request('thread/read',{threadId,includeTurns:false});
        if(!this.native.connected)return;
        if(thread?.id!==threadId || !['active','idle','notLoaded','systemError'].includes(thread.status?.type))return;
        if(this.get(threadId)!==previous)return this.get(threadId); // A lifecycle event won this read.
        const state=this.save(threadId,thread.status,this.native.activeTurns.get(threadId) || (previous?.status.type==='active' ? previous.turnId : null),at,'read');
        if(state.status.type!=='active')this.native.activeTurns.delete(threadId);
        return state;
      } catch {return this.get(threadId);} // A failed read cannot establish that execution stopped.
    })();
    this.pending.set(threadId,task);
    try{return await task;}finally{this.pending.delete(threadId);}
  }
  async refresh(threadIds) {
    if(!this.native.connected)return;
    const ids=[...new Set(threadIds)];let index=0;
    await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{while(index<ids.length)await this.read(ids[index++]);}));
  }
  retain(threadIds){const ids=new Set(threadIds);for(const id of this.states.keys())if(!ids.has(id))this.states.delete(id);}
  clear(){this.states.clear();}
}

export function rememberDesktopRuntime(session,state) {
  if(!state?.status?.type || !Number.isFinite(state.observedAt))return false;
  const previous=session.desktopRuntime;
  if(previous && (state.observedAt<previous.observedAt || state.epoch===previous.epoch && state.revision<previous.revision))return false;
  session.desktopRuntime=state;return true;
}

export function applyDesktopRuntime(session,turns=session.turns || []) {
  const runtime=session.desktopRuntime;
  if(!runtime || session.pendingSend || session.pendingEdit)return;
  if(runtime.status.type==='active') {
    if(!desktopRuntimeIsActive(runtime,turns))return;
    session.executionOwner='desktop';session.threadStatus='active';session.activeTurnId=runtime.turnId;
    const flags=runtime.status.activeFlags || [];
    if(session.status!=='interrupting')session.status=flags.includes('waitingOnApproval') ? 'waiting_approval' : flags.includes('waitingOnUserInput') ? 'waiting_input' : 'running';
    const turn=turns.find(turn=>turn.id===runtime.turnId);
    if(turn){turn.status='inProgress';turn.completedAt=0;}
  }else if(session.executionOwner==='desktop') {
    session.threadStatus=runtime.status.type;
    const snapshot={...session,turns};
    applyThreadStatus(snapshot,runtime.status,runtime.observedAt);
    session.status=snapshot.status;session.activeTurnId=snapshot.activeTurnId;session.liveTurn=snapshot.liveTurn;
  }
}

export function desktopRuntimeIsActive(runtime,turns) {
  if(runtime?.status.type!=='active')return false;
  const turn=turns.find(turn=>turn.id===runtime.turnId);
  return runtime.source!=='event' || !turn?.completedAt || runtime.observedAt>=turn.completedAt;
}
