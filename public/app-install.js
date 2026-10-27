import {AppUpdates} from './app-updates.js';

export function setupAppInstall({saveDraft=()=>{}}={}){
  const $=id=>document.getElementById(id),button=$('installAppBtn');if(!button)return;
  let promptEvent;
  const updates=new AppUpdates({worker:navigator.serviceWorker,secure:window.isSecureContext,online:()=>navigator.onLine!==false,saveDraft,reload:()=>location.reload(),onState:({state,message})=>{
    const sidebar=$('checkAppUpdateBtn'),busy=['checking','updating'].includes(state),available=state==='available';
    if(sidebar){sidebar.disabled=busy;sidebar.classList.toggle('update-available',available);sidebar.textContent=available?'有新版 · 更新页面':state==='checking'?'正在检查…':state==='updating'?'正在更新…':state==='current'?'已是最新 · 再检查':state==='unsupported'?'刷新页面':state==='error'||state==='offline'?'重试检查更新':'检查更新';sidebar.title=message||'检查网页界面更新，不重启 Codex 或后台';}
    const status=$('appUpdateStatus');if(status){status.textContent=message;status.hidden=!message;}
    $('updateAppBtn').hidden=!available;$('updateAppBtn').disabled=busy;
    if($('checkInstallUpdateBtn'))$('checkInstallUpdateBtn').disabled=busy;
    if(message)$('installHint').textContent=message;
  }});
  const installed=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  const render=()=>{button.textContent=installed()?'应用与本机缓存':'添加到手机桌面';};
  render();window.addEventListener('appinstalled',render);
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();promptEvent=event;render();});
  button.onclick=()=>{$('installModal').classList.remove('hidden');$('installNowBtn').hidden=!promptEvent;};
  $('closeInstallBtn').onclick=()=>$('installModal').classList.add('hidden');
  $('installModal').onclick=event=>{if(event.target===$('installModal'))$('installModal').classList.add('hidden');};
  $('installNowBtn').onclick=async()=>{if(!promptEvent)return;await promptEvent.prompt();await promptEvent.userChoice;promptEvent=null;$('installNowBtn').hidden=true;};
  $('fullscreenAppBtn').hidden=!document.documentElement.requestFullscreen;
  $('fullscreenAppBtn').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();$('installModal').classList.add('hidden');}catch{$('installHint').textContent='当前浏览器未允许全屏，可尝试添加至桌面。';}};
  void updates.start().catch(()=>{});
  $('updateAppBtn').onclick=()=>updates.apply();
  if($('checkAppUpdateBtn'))$('checkAppUpdateBtn').onclick=()=>updates.state==='available'||updates.state==='unsupported'?updates.apply():updates.check();
  if($('checkInstallUpdateBtn'))$('checkInstallUpdateBtn').onclick=()=>updates.check();
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void updates.check({automatic:true});});
  window.addEventListener('online',()=>{if(!document.hidden)void updates.check({automatic:true});});
  return updates;
}
