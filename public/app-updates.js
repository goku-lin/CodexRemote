export class AppUpdates {
  constructor({worker,secure=true,online=()=>true,saveDraft=()=>{},reload=()=>{},onState=()=>{},timeout=45000}){
    Object.assign(this,{worker,secure,online,saveDraft,reload,onState,timeout});this.state='idle';this.lastCheck=0;this.watched=new WeakSet();this.hadController=Boolean(worker?.controller);
    worker?.addEventListener('controllerchange',()=>{
      if(this.requested&&!this.reloaded){this.reloaded=true;clearTimeout(this.activationTimer);this.reload();}
      else{this.reloadAvailable=this.hadController;this.hadController=true;this.ready();}
    });
  }
  emit(state,message=''){this.state=state;this.message=message;this.onState({state,message,available:Boolean(this.registration?.waiting||this.reloadAvailable)});}
  ready(){
    if(this.requested)return;
    if(this.registration?.waiting||this.reloadAvailable)this.emit('available','新版已下载，更新前会保存草稿。');
    else if(!this.checking)this.emit('idle');
  }
  watch(){
    const installing=this.registration?.installing;
    if(!installing||this.watched.has(installing))return;this.watched.add(installing);
    installing.addEventListener('statechange',()=>{if(['installed','activated'].includes(installing.state))this.ready();});
  }
  async start(){
    if(!this.worker||!this.secure){this.emit('unsupported','当前浏览器使用普通页面刷新。');return null;}
    if(!this.starting)this.starting=this.worker.register('/notification-worker.js',{scope:'/',updateViaCache:'none'}).then(registration=>{
      this.registration=registration;registration.addEventListener('updatefound',()=>this.watch());this.watch();this.ready();return registration;
    }).catch(error=>{this.starting=null;this.emit('error','暂时无法检查更新，请联网后重试。');throw error;});
    return this.starting;
  }
  async check({automatic=false}={}){
    if(this.requested||this.checking)return this.checking;
    if(automatic&&Date.now()-this.lastCheck<60000)return;
    if(!this.online()){this.emit(this.registration?.waiting?'available':'offline','当前离线，联网后可检查更新。');return;}
    this.lastCheck=Date.now();this.emit('checking','正在检查并下载页面更新…');
    const bounded=promise=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Update timed out')),this.timeout);Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
    const operation=(async()=>{
      try{
        const registration=await bounded(this.start());if(!registration)return;
        await bounded(registration.update());this.watch();
        const installing=registration.installing;
        if(installing&&!['installed','activated','redundant'].includes(installing.state))await new Promise((resolve,reject)=>{
          const finish=()=>{if(!['installed','activated','redundant'].includes(installing.state))return;cleanup();installing.state==='redundant'?reject(new Error('Install failed')):resolve();};
          const cleanup=()=>{clearTimeout(timer);installing.removeEventListener('statechange',finish);};
          const timer=setTimeout(()=>{cleanup();reject(new Error('Update timed out'));},this.timeout);installing.addEventListener('statechange',finish);finish();
        });
        if(installing?.state==='redundant')throw new Error('Install failed');
        const available=registration.waiting||this.reloadAvailable;
        this.emit(available?'available':'current',available?'新版已下载，更新前会保存草稿。':'已检查，当前页面已是最新版本。');
      }catch{if(!this.registration)this.starting=null;this.emit(this.registration?.waiting||this.reloadAvailable?'available':'error','更新检查未完成，请稍后重试；当前页面和草稿保留。');}
    })();
    this.checking=operation;try{await operation;}finally{this.checking=null;}
  }
  apply(){
    if(this.requested)return;
    if(!this.worker||!this.secure){this.saveDraft();this.reload();return;}
    if(this.reloadAvailable&&!this.registration?.waiting){try{this.saveDraft();this.requested=true;this.emit('updating','草稿已保存，正在更新页面…');this.reload();}catch{this.requested=false;this.emit('error','草稿保存未完成，当前页面保留，请重试。');}return;}
    if(!this.registration?.waiting)return this.check();
    try{this.saveDraft();this.requested=true;this.emit('updating','草稿已保存，正在更新页面…');this.registration.waiting.postMessage({type:'activate_app_update'});}
    catch{this.requested=false;this.emit('error','更新未完成，请重试；当前页面保留。');return;}
    if(!this.reloaded)this.activationTimer=setTimeout(()=>{
      if(this.reloaded)return;this.requested=false;this.emit('error','页面暂未完成更新，可重试；草稿已保存。');
    },15000);
  }
}
