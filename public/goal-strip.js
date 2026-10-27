import {commandElapsed} from './command-timing.js';

export const goalElapsed=seconds=>typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0?commandElapsed(seconds*1000):'用时未知';
export function goalPreview(objective){
  const text=String(objective||'').replace(/\s+/g,' ').trim(),characters=Array.from(text);
  return characters.length>32?characters.slice(0,32).join('')+'…':text;
}
const statuses={active:'进行中的目标',paused:'已暂停的目标',blocked:'目标需要处理',usageLimited:'目标额度限制',budgetLimited:'目标预算已用完',complete:'已完成的目标'};

// Only the open conversation is observed. Native totals are sampled rather than
// extrapolated: a goal can pause or stop while the browser is disconnected.
export class GoalStrip {
  constructor({api,session,open,onData=()=>{},enabled=()=>true}){
    Object.assign(this,{api,session,onData,enabled});this.loading=new Set();this.nextRead=0;this.revision=0;
    this.$=id=>document.getElementById(id);
    this.$('goalStripManage').onclick=open;
    document.addEventListener('visibilitychange',()=>this.render());
    for(const event of ['online','offline'])globalThis.addEventListener?.(event,()=>this.render());
  }
  available(){return !document.hidden&&globalThis.navigator?.onLine!==false&&this.enabled();}
  render(){
    const session=this.session(),id=session?.threadId?session.id:null;
    if(this.id!==id){this.id=id;this.data=null;this.nextRead=0;this.revision++;this.$('goalStrip').open=false;this.paint();}
    if(!id||!this.available()){clearTimeout(this.timer);return;}
    if(Date.now()>=this.nextRead)void this.refresh();
    else this.schedule();
  }
  schedule(){
    clearTimeout(this.timer);
    if(this.id&&this.available()){
      this.timer=setTimeout(()=>this.render(),Math.max(1000,this.nextRead-Date.now()));
      this.timer.unref?.();
    }
  }
  accept(id,data){
    if(this.id!==id||this.session()?.id!==id)return;
    this.revision++;this.data=data;this.nextRead=Date.now()+15000;this.paint();this.onData(id,data);this.schedule();
  }
  paint(){
    const goal=this.data?.goal;
    this.$('goalStrip').classList.toggle('hidden',!goal);
    this.$('goalStripStatus').textContent=goal?(statuses[goal.status]||'对话目标'):'';
    this.$('goalStripObjective').textContent=goalPreview(goal?.objective);
    this.$('goalStripObjective').title='点击展开完整目标';
    this.$('goalStripTime').textContent=goal?goalElapsed(goal.timeUsedSeconds):'';
    this.$('goalStripDetail').textContent=goal?.objective||'';
    this.$('goalStripUsage').textContent=goal?`已用 ${Number(goal.tokensUsed||0).toLocaleString()} token${goal.tokenBudget!=null?' / '+Number(goal.tokenBudget).toLocaleString():''}`:'';
    this.$('goalStripNotice').textContent='累计用时每 15 秒与桌面同步。';
  }
  async refresh(){
    const id=this.id;
    if(!id||this.loading.has(id)||!this.available())return;
    this.loading.add(id);this.nextRead=Date.now()+15000;const revision=this.revision;
    try{const data=await this.api('/api/sessions/'+encodeURIComponent(id)+'/goal');if(this.revision===revision&&this.available())this.accept(id,data);}
    catch{if(this.id===id&&this.session()?.id===id)this.$('goalStripNotice').textContent='目标同步暂不可用，稍后自动重试。';}
    finally{this.loading.delete(id);this.schedule();}
  }
}
