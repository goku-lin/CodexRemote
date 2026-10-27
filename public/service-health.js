import {syncHtml} from './dom-sync.js';
import {setupNetworkCheck} from './network-check.js';
let api,poll;
const labels={relay:'后台服务',runner:'执行设备',desktop:'桌面连接',tailscale:'Tailscale',external:'远程入口'};
const escape=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function renderServiceHealth(value){
  const button=document.getElementById('healthOpenBtn');if(!button)return;
  const networkPanel=document.getElementById('networkCheckPanel');if(networkPanel)networkPanel.hidden=value.networkCheckRevision!==1;
  const entries=Object.entries(labels).map(([key,label])=>({label,...value[key]}));
  const bad=entries.some(entry=>['error','offline','unknown','warning'].includes(entry.state));
  button.textContent=bad ? '连接检查 · 需要处理' : value.checking ? '连接检查 · 检查中' : '连接检查';
  button.classList.toggle('health-warning',bad);
  const body=entries.map(entry=>`<div class="health-row" data-node-key="health-${escape(entry.label)}"><span>${escape(entry.label)}</span><strong class="health-${escape(entry.state)}">${escape(entry.message)}</strong></div>`).join('');
  const url=value.external?.url;
  const desktopNote=value.desktop?.state==='offline'?'<p class="muted">桌面接管未连接：可能是原生连接中断、桌面更新或启动入口变化；仅凭此状态不能判断具体原因。关闭管理窗口不应关闭 Codex。</p>':'';
  const observed=value.checkedAt?`<p class="muted">执行电脑检测于 ${escape(new Date(value.checkedAt).toLocaleTimeString())}。公网结果来自执行电脑，不代表当前浏览器所在网络一定能访问。</p>`:'';
  syncHtml(document.getElementById('healthContent'),body+desktopNote+observed+(url ? `<p><a href="${escape(url)}" target="_blank" rel="noopener">打开远程入口</a></p>` : '')+'<p class="muted">恢复连接可能短暂中断公网访问，执行前会请求确认。仅检查状态请点“刷新状态”。桌面卡住时可使用“重启与恢复”；重启密码仅在运行 Codex 的电脑本机管理。</p>');
  document.getElementById('healthRecoverBtn').disabled=Boolean(value.checking);
  if(value.checking && !poll)poll=setTimeout(refresh,1500);
}
async function refresh(){clearTimeout(poll);poll=null;try{renderServiceHealth(await api('/api/health'));document.getElementById('healthError').textContent='';}catch(error){document.getElementById('healthError').textContent=error.message;}}
export function setupServiceHealth(callApi){
  api=callApi;
  setupNetworkCheck();
  document.getElementById('healthOpenBtn').onclick=()=>{document.getElementById('healthModal').classList.remove('hidden');refresh();};
  document.getElementById('healthCloseBtn').onclick=()=>document.getElementById('healthModal').classList.add('hidden');
  document.getElementById('healthRefreshBtn').onclick=async()=>{try{renderServiceHealth(await api('/api/health/check',{method:'POST',body:'{}'}));}catch(error){document.getElementById('healthError').textContent=error.message;}};
  document.getElementById('healthRecoverBtn').onclick=async()=>{if(!window.confirm('恢复连接可能重新连接公网入口，所有通过公网访问的设备会短暂断线。是否现在恢复连接？'))return;try{renderServiceHealth(await api('/api/health/recover',{method:'POST',body:'{}'}));}catch(error){document.getElementById('healthError').textContent=error.message;}};
  if(new URLSearchParams(location.search).get('health')==='1')document.getElementById('healthModal').classList.remove('hidden');
  refresh();
}
