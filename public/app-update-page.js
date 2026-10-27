import {AppUpdates} from './app-updates.js';
const button=document.getElementById('checkUpdateBtn'),status=document.getElementById('updateStatus');
const updates=new AppUpdates({worker:navigator.serviceWorker,secure:window.isSecureContext,online:()=>navigator.onLine!==false,reload:()=>location.replace('/'),onState:({state,message})=>{
  button.disabled=['checking','updating'].includes(state);
  button.textContent=state==='available'?'更新页面':state==='checking'?'正在检查…':state==='updating'?'正在更新…':state==='unsupported'?'刷新页面':'检查更新';
  status.textContent=message||'点击检查更新。有新版时，再点击更新页面。';
}});
button.onclick=()=>updates.state==='available'||updates.state==='unsupported'?updates.apply():updates.check();
void updates.start().catch(()=>{});
