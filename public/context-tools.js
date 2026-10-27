import {contextSelections} from './context-state.js';
import {GoalStrip,goalElapsed} from './goal-strip.js';
const escape=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
const labels={skills:'技能',chats:'对话',files:'文件',apps:'应用'};
export const goalStatusLabel=status=>({active:'进行中',paused:'已暂停',blocked:'需要处理',usageLimited:'额度限制',budgetLimited:'预算已用完',complete:'已完成'})[status] || '未设置';

export class ContextTools {
  constructor({api,session,sessions,drafts,save,render,sync}){
    Object.assign(this,{api,session,sessions,drafts,save,changed:render,sync});this.cache=new Map();this.sequence=0;
    document.body.insertAdjacentHTML('beforeend',`<div class="modal hidden" id="contextToolsModal" role="dialog" aria-modal="true" aria-labelledby="contextToolsTitle"><div class="modal-card context-tools-card"><div class="modal-head"><h2 id="contextToolsTitle">技能与引用</h2><button type="button" class="icon-btn" data-context-close aria-label="关闭">×</button></div><div class="context-tools-search"><select id="contextKind" aria-label="引用类型">${Object.entries(labels).map(([kind,label])=>`<option value="${kind}">${label}</option>`).join('')}</select><input id="contextQuery" type="search" maxlength="160" placeholder="搜索技能" aria-label="搜索技能或引用" autocomplete="off"></div><p id="contextPickerStatus" class="muted" role="status"></p><div id="contextResults" class="context-results"></div></div></div>
      <div class="modal hidden" id="goalToolsModal" role="dialog" aria-modal="true" aria-labelledby="goalToolsTitle"><form class="modal-card context-tools-card" id="goalToolsForm"><div class="modal-head"><h2 id="goalToolsTitle">对话目标</h2><button type="button" class="icon-btn" data-context-close aria-label="关闭">×</button></div><p id="goalToolsStatus" role="status"></p><label class="field-label">目标<textarea id="goalObjective" rows="4" maxlength="4000" required placeholder="说明要达成的结果和完成条件"></textarea></label><label class="field-label">token 预算（可选）<input id="goalBudget" type="number" min="1" step="1" max="9007199254740991" placeholder="不填写则不指定预算"></label><p id="goalToolsUsage" class="muted"></p><p class="muted">修改目标内容会重新统计用量。暂停目标后，当前正在执行的回合仍可能继续完成。</p><div class="modal-actions"><button class="btn" id="goalRefresh" type="button">刷新</button><button class="btn" id="goalPause" type="button">暂停</button><button class="btn" id="goalResume" type="button">继续</button><button class="btn" id="goalClear" type="button">移除目标</button><button class="btn primary" id="goalSave" type="submit">保存目标</button></div><p id="goalToolsError" class="compose-error" role="status"></p></form></div>`);
    this.$=id=>document.getElementById(id);
    this.goalStrip=new GoalStrip({api,session,open:()=>this.openGoal(),enabled:()=>this.$('goalToolsModal').classList.contains('hidden'),onData:(id,data)=>{this.goalSession=id;this.goalData=data;this.$('goalToolsBtn').textContent=data.goal?'目标 · '+goalStatusLabel(data.goal.status):'目标';}});
    this.$('contextToolsBtn').onclick=()=>this.open('skills');this.$('goalToolsBtn').onclick=()=>this.openGoal();
    this.$('contextKind').onchange=()=>{this.$('contextQuery').value='';this.search();};
    this.$('contextQuery').oninput=()=>{clearTimeout(this.searchTimer);this.sequence++;this.searchTimer=setTimeout(()=>this.search(),200);};
    this.$('contextResults').onclick=event=>{const button=event.target.closest('[data-context-index]');if(button)this.select(Number(button.dataset.contextIndex));};
    this.$('contextChips').onclick=event=>{const button=event.target.closest('[data-context-remove]');if(!button)return;const id=this.session()?.id;if(!id)return;const draft=this.drafts.get(id);draft.context=(draft.context || []).filter((_,index)=>index!==Number(button.dataset.contextRemove));this.drafts.set(id,draft);this.changed();};
    for(const id of ['contextToolsModal','goalToolsModal'])this.$(id).onclick=event=>{if(event.target===this.$(id) || event.target.closest('[data-context-close]'))this.close(id);};
    document.addEventListener('keydown',event=>{if(event.key==='Escape')for(const id of ['contextToolsModal','goalToolsModal'])if(!this.$(id).classList.contains('hidden')){event.preventDefault();this.close(id);}});
    this.$('goalToolsForm').onsubmit=event=>{event.preventDefault();this.changeGoal('set');};
    this.$('goalRefresh').onclick=()=>this.loadGoal(true);
    for(const action of ['pause','resume','clear'])this.$('goal'+action[0].toUpperCase()+action.slice(1)).onclick=()=>this.changeGoal(action);
    this.$('promptInput').addEventListener('input',event=>{if(event.isComposing)return;const input=event.target;if(input.selectionStart!==input.value.length)return;const match=input.value.match(/(?:^|\s)([$@])$/);if(match)this.open(match[1]==='$' ? 'skills' : 'chats',{start:input.value.length-1,end:input.value.length});});
  }
  render(){
    const session=this.session(),items=this.drafts.get(session?.id).context || [];
    this.sync(this.$('contextChips'),items.map((item,index)=>`<span class="context-chip"><span>${item.kind==='skill' ? '$' : '@'}${escape(item.name)}</span><button type="button" data-context-remove="${index}" aria-label="移除 ${escape(item.name)}">×</button></span>`).join(''));
    this.$('contextToolsBtn').disabled=!session?.threadId;this.$('goalToolsBtn').disabled=!session?.threadId;
    const goal=this.goalSession===session?.id ? this.goalData?.goal : null;
    this.$('goalToolsBtn').textContent=goal ? '目标 · '+goalStatusLabel(goal.status) : '目标';
    if(this.origin && this.origin!==session?.id){this.close('contextToolsModal');this.close('goalToolsModal');this.origin=null;}
    this.goalStrip.render();
  }
  close(id){this.$(id).classList.add('hidden');if(id==='goalToolsModal'){clearInterval(this.goalPoll);this.goalStrip.render();}else this.sequence++;this.$('promptInput').focus();}
  async open(kind='skills',trigger=null){
    this.save();this.origin=this.session()?.id;if(!this.origin)return;
    this.trigger=trigger;this.$('contextKind').value=kind;this.$('contextQuery').value='';
    this.$('contextToolsModal').classList.remove('hidden');this.$('contextQuery').focus();await this.search();
  }
  async search(){
    const session=this.session(),id=this.origin,kind=this.$('contextKind').value,query=this.$('contextQuery').value.trim(),sequence=++this.sequence;
    if(!session || session.id!==id)return;
    this.$('contextQuery').placeholder='搜索'+labels[kind];this.$('contextPickerStatus').textContent='正在读取…';this.$('contextResults').textContent='';
    try{
      let items;
      if(kind==='chats')items=this.sessions().filter(chat=>chat.id!==id && chat.deviceId===session.deviceId && !chat.hidden && !chat.archived).map(chat=>({kind:'chat',id:chat.id,name:chat.title || '未命名对话',description:chat.projectName || chat.cwd || ''}));
      else if(kind==='files' && !query){this.$('contextPickerStatus').textContent='输入文件名搜索当前项目。';return;}
      else{
        const key=id+':'+kind,cached=kind!=='files' && this.cache.get(key);
        if(cached && Date.now()-cached.at<60000)items=cached.items;
        else{const data=await this.api('/api/sessions/'+encodeURIComponent(id)+'/context?kind='+kind+'&q='+encodeURIComponent(query));items=data.items || [];if(kind!=='files'){this.cache.delete(key);this.cache.set(key,{at:Date.now(),items});while(this.cache.size>16)this.cache.delete(this.cache.keys().next().value);}}
      }
      if(sequence!==this.sequence || this.origin!==id || this.session()?.id!==id)return;
      this.items=items.filter(item=>kind==='files' || [item.name,item.description].join(' ').toLowerCase().includes(query.toLowerCase())).slice(0,100);
      this.$('contextPickerStatus').textContent=this.items.length ? '选择后随下一条消息发送，可在输入框上方移除。' : '没有匹配的'+labels[kind]+'。';
      this.$('contextResults').innerHTML=this.items.map((item,index)=>`<button type="button" class="context-result" data-context-index="${index}"><strong>${escape(item.name)}</strong><small>${escape(item.description || item.path || '')}</small></button>`).join('');
    }catch(error){if(sequence===this.sequence)this.$('contextPickerStatus').textContent=error.message;}
  }
  async select(index){
    const item=this.items?.[index],id=this.origin,sequence=this.sequence;if(!item || this.session()?.id!==id)return;
    try{
      if(item.kind==='chat')await this.api('/api/sessions/'+encodeURIComponent(item.id)+'/history?maxTurns=5&sync=1');
      if(this.session()?.id!==id || this.origin!==id || this.sequence!==sequence || this.$('contextToolsModal').classList.contains('hidden'))return;
      const draft=this.drafts.get(id);draft.context=contextSelections([...(draft.context || []),item]);
      if(this.trigger && draft.text?.slice(this.trigger.start,this.trigger.end).match(/^[$@]$/)){
        draft.text=draft.text.slice(0,this.trigger.start)+draft.text.slice(this.trigger.end);this.$('promptInput').value=draft.text;
      }
      this.trigger=null;this.drafts.set(id,draft);this.close('contextToolsModal');this.changed();
    }catch(error){this.$('contextPickerStatus').textContent=error.message;}
  }
  async openGoal(){this.save();this.origin=this.session()?.id;if(!this.origin)return;this.$('goalToolsModal').classList.remove('hidden');this.goalStrip.render();this.$('goalToolsStatus').textContent='正在读取目标…';for(const name of ['Save','Pause','Resume','Clear'])this.$('goal'+name).disabled=true;if(this.goalSession!==this.origin)this.goalData=null;await this.loadGoal(true);clearInterval(this.goalPoll);if(this.origin===this.session()?.id && !this.$('goalToolsModal').classList.contains('hidden'))this.goalPoll=setInterval(()=>this.loadGoal(false),15000);}
  async loadGoal(fill=false){
    const id=this.origin;if(!id || this.goalLoading===id || this.goalBusy || !fill&&(document.hidden || globalThis.navigator?.onLine===false))return;this.goalLoading=id;
    try{
      const data=await this.api('/api/sessions/'+encodeURIComponent(id)+'/goal');
      if(this.session()?.id!==id || this.origin!==id)return;
      this.goalSession=id;this.goalData=data;this.goalStrip.accept(id,data);const goal=data.goal;
      this.$('goalToolsStatus').textContent=data.canControl ? goal ? '目标'+goalStatusLabel(goal.status) : '尚未设置目标' : '当前桌面连接支持查看，尚未开放目标控制。';
      this.$('goalToolsUsage').textContent=goal ? `已用 ${Number(goal.tokensUsed || 0).toLocaleString()} token${goal.tokenBudget!=null ? ' / '+Number(goal.tokenBudget).toLocaleString() : ''} · 累计 ${goalElapsed(goal.timeUsedSeconds)}` : '';
      if(fill){this.$('goalObjective').value=goal?.objective || '';this.$('goalBudget').value=goal?.tokenBudget ?? '';}
      for(const action of ['Save','Pause','Resume','Clear'])this.$('goal'+action).disabled=!data.canControl || this.goalBusy || action!=='Save' && !goal || action==='Pause' && goal?.status!=='active' || action==='Resume' && goal?.status==='active';
      this.$('goalObjective').disabled=!data.canControl;this.$('goalBudget').disabled=!data.canControl;this.$('goalToolsError').textContent='';this.render();
    }catch(error){if(this.origin===id){this.$('goalToolsError').textContent=error.message;for(const action of ['Save','Pause','Resume','Clear'])this.$('goal'+action).disabled=true;}}
    finally{if(this.goalLoading===id)this.goalLoading=null;}
  }
  async changeGoal(action){
    const id=this.origin;if(this.goalBusy || this.goalSession!==id || !this.goalData?.canControl || this.session()?.id!==id)return;
    const body={action};if(action==='set'){body.objective=this.$('goalObjective').value.trim();const budget=this.$('goalBudget').value;if(budget)body.tokenBudget=Number(budget);}
    this.goalBusy=true;for(const name of ['Save','Pause','Resume','Clear'])this.$('goal'+name).disabled=true;
    try{await this.api('/api/sessions/'+encodeURIComponent(id)+'/goal',{method:'POST',body:JSON.stringify(body)});this.goalBusy=false;await this.loadGoal(true);}
    catch(error){if(this.origin===id)this.$('goalToolsError').textContent=error.message+' 请刷新目标状态后核对结果。';}
    finally{this.goalBusy=false;}
  }
}
