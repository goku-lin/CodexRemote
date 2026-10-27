// Inspect ownership without resuming a thread or acquiring another writer.
export const usesDesktop=session=>session?.executionMode==='desktop' || session?.executionOwner==='desktop' || session?.source==='imported' && session.executionOwner!=='runner';
export function creationMode(body,device){
  const mode=body.executionMode ?? 'desktop';
  if(!['desktop','runner'].includes(mode))throw new Error('未知执行方式。');
  if(mode==='desktop' && !device.nativeDesktop?.connected)throw new Error('桌面连接未接通，尚未创建对话。请恢复桌面连接，或明确选择“独立执行”。');
  if(mode==='desktop' && !device.nativeDesktop.capabilities?.createThreads)throw new Error('当前桌面代理尚未支持双端新建，尚未创建对话。请在任务结束、方便时通过原生入口重新打开 Codex；也可明确选择“独立执行”。');
  if(mode==='desktop' && device.desktopThreadCreateRevision!==1)throw new Error('执行设备尚未加载双端新建修复，尚未创建对话。请先更新该电脑的远程服务。');
  return mode;
}

export class ThreadOwnership {
  constructor({rpc,native,identity,active,pendingMutation,reset}){Object.assign(this,{rpc,native,identity,active,pendingMutation,reset});}
  async loaded(){
    const result=await this.rpc('thread/loaded/list',{});
    if(!Array.isArray(result.data) || result.data.some(id=>typeof id!=='string'))throw new Error('执行器未返回可靠的占用列表，未更改任何进程。');
    return [...new Set(result.data)];
  }
  async read(threadId){
    const loaded=await this.loaded();
    const runnerLoaded=loaded.includes(threadId);let runnerStatus=null,desktopStatus=null,desktopConnected=false;
    if(runnerLoaded)runnerStatus=(await this.rpc('thread/read',{threadId,includeTurns:false})).thread?.status?.type || 'unknown';
    try{await this.native.refreshConnection();desktopConnected=true;desktopStatus=(await this.native.request('thread/read',{threadId,includeTurns:false})).thread?.status?.type || 'unknown';}catch{}
    return {...this.identity(),runnerLoaded,runnerStatus,desktopConnected,desktopStatus,
      owner:runnerLoaded ? 'runner' : desktopConnected && desktopStatus && !['notLoaded','unknown'].includes(desktopStatus) ? 'desktop' : 'unknown',
      canRelease:runnerLoaded && runnerStatus==='idle' && !this.active() && !this.pendingMutation()};
  }
  async release(threadId,expected){
    const identity=this.identity();
    if(expected?.generation!==identity.generation || expected?.pid!==identity.pid)throw new Error('执行器已变化，请重新诊断后操作。');
    const ids=await this.loaded();
    if(!ids.includes(threadId))throw new Error('本项目的独立执行器未持有这条对话，未结束任何进程。');
    if(ids.length>200)throw new Error('占用对话过多，无法安全确认状态，未释放。');
    for(const id of ids){
      const thread=(await this.rpc('thread/read',{threadId:id,includeTurns:false})).thread;
      if(thread?.id!==id || !['idle','notLoaded'].includes(thread.status?.type))throw new Error('独立执行器仍有任务、提问或状态未确认，未释放。请等待完成后重试。');
      const result=await this.rpc('thread/goal/get',{threadId:id});
      if(!Object.hasOwn(result,'goal') || result.goal?.status==='active')throw new Error('独立执行器仍有进行中的目标，或目标状态无法确认，未释放。');
    }
    if(this.active() || this.pendingMutation())throw new Error('执行器刚收到任务，未释放。请稍后重新诊断。');
    await this.reset({...identity,threadIds:ids});
    return {released:true,threadIds:ids,message:'空闲独立执行器的占用已释放。请回 Codex 桌面点“重试”；网页后续通过桌面继续。'};
  }
}
