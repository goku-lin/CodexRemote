const activeStates=new Set(['queued','restarting_desktop','restarting_service','waiting']);
const labels={queued:'重启请求已接受',restarting_desktop:'正在重启 Codex 桌面…',restarting_service:'正在重启远程服务…',waiting:'正在等待桌面与服务恢复…',complete:'重启完成，连接已恢复。',failed:'重启未完成，请查看下面的原因。'};
const storageKey='codex-relay-maintenance-request';

export function setupMaintenance({api,onRecovered=()=>{}}){
  document.body.insertAdjacentHTML('beforeend',`<div class="modal hidden" id="maintenanceModal" role="dialog" aria-modal="true" aria-labelledby="maintenanceTitle"><form class="modal-card" id="maintenanceForm">
    <div class="modal-head"><h2 id="maintenanceTitle">重启与恢复</h2><button class="icon-btn" id="maintenanceClose" type="button" aria-label="关闭重启与恢复">×</button></div>
    <p class="muted" id="maintenancePasswordHint">密码只能在运行 Codex 的电脑本机管理。</p>
    <div class="hidden" id="maintenanceLocalSetup"><p class="muted">在 Windows 文件资源管理器中打开下面的文件，按提示输入两次密码，再回来点“刷新状态”。127.0.0.1 也是网页入口，密码仍通过本机文件设置。</p><code id="maintenanceSetupPath"></code></div>
    <label class="field-label" for="maintenanceScope">重启范围<select id="maintenanceScope"><option value="service">仅重启远程服务</option><option value="desktop">重启 Codex＋远程服务</option></select></label>
    <p class="muted" id="maintenanceScopeHint"></p>
    <label class="performance-toggle hidden" id="maintenanceConfirmRow"><input id="maintenanceConfirm" type="checkbox">我确认中断这台电脑所有正在运行的 Codex 任务</label>
    <label class="field-label" for="maintenancePassword">重启密码<input id="maintenancePassword" type="password" minlength="6" maxlength="128" autocomplete="current-password" required></label>
    <p class="muted">此入口需要远程服务仍能响应。电脑休眠、断网或服务完全无响应时，需要本机处理。</p>
    <div class="modal-error" id="maintenanceError" role="status" aria-live="polite"></div><p id="maintenanceStatus" role="status" aria-live="polite"></p>
    <div class="modal-actions"><button class="btn" id="maintenanceRefresh" type="button">刷新状态</button><button class="btn primary" id="maintenanceSubmit" type="submit" disabled>重启远程服务</button></div>
  </form></div>`);
  const $=id=>document.getElementById(id);
  let info=null,pending=null,timer=null,busy=false,reading=false,visible=false,recovered=null,returnToHealth=false;
  try{const saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(saved?.id && ['service','desktop'].includes(saved.scope))pending=saved;}catch{}
  const save=()=>{try{pending?sessionStorage.setItem(storageKey,JSON.stringify(pending)):sessionStorage.removeItem(storageKey);}catch{}};
  const render=()=>{
    const running=activeStates.has(info?.job?.state),scope=$('maintenanceScope').value;
    $('maintenanceConfirmRow').classList.toggle('hidden',scope!=='desktop');
    $('maintenanceScopeHint').textContent=scope==='desktop'?'强制关闭 Codex 及其子进程，再通过原生入口打开。这台电脑所有对话的运行任务都会中断，未完成的命令需要核对后继续。':'网页会短暂断线；Codex 桌面保持运行。由远程服务自身启动的任务可能中断。';
    $('maintenancePasswordHint').textContent=info?.passwordConfigured?'密码只能在 Codex 电脑本机修改；网页仅校验密码。':'请先在运行 Codex 的电脑双击「设置重启密码.cmd」，设置后点“刷新状态”。';
    $('maintenanceLocalSetup').classList.toggle('hidden',!info?.passwordSetupPath);
    $('maintenanceSetupPath').textContent=info?.passwordSetupPath || '';
    $('maintenanceScope').disabled=busy||running||Boolean(pending);
    $('maintenanceConfirm').disabled=busy||running;
    $('maintenancePassword').disabled=busy||running||!info?.passwordConfigured;
    $('maintenanceSubmit').disabled=busy||reading||running||!info?.passwordConfigured||!info?.serviceSupported||scope==='desktop'&&(!info.desktopSupported||!$('maintenanceConfirm').checked);
    $('maintenanceSubmit').textContent=busy?'正在提交…':!info?.passwordConfigured?'先设置重启密码':pending&&!running?'核对并重试同一请求':scope==='desktop'?'确认重启 Codex＋服务':'重启远程服务';
    $('maintenanceStatus').textContent=labels[info?.job?.state] || (pending?'上次请求结果待确认；刷新状态或输入密码重试同一请求。':'');
  };
  const schedule=()=>{clearTimeout(timer);if(visible&&(pending||activeStates.has(info?.job?.state)))timer=setTimeout(refresh,2000);};
  const refresh=async()=>{
    if(reading)return;reading=true;render();
    try{
      info=await api('/api/maintenance'+(pending?'?requestId='+encodeURIComponent(pending.id):''));
      $('maintenanceError').textContent=info.error || info.job?.error || (!info.serviceSupported?'当前服务未通过支持重启的 Windows 后台入口运行。':'');
      if(info.job && !activeStates.has(info.job.state)){
        pending=null;save();
        if(info.job.state==='complete'&&recovered!==info.job.id){recovered=info.job.id;onRecovered();}
      }
    }catch{$('maintenanceError').textContent=pending?'正在等待服务恢复，请保持此窗口打开。':'无法读取重启状态，请检查网络连接。';}
    finally{reading=false;render();schedule();}
  };
  const close=()=>{visible=false;clearTimeout(timer);$('maintenancePassword').value='';$('maintenanceModal').classList.add('hidden');if(returnToHealth)$('healthModal').classList.remove('hidden');returnToHealth=false;};
  const open=()=>{if(!visible){returnToHealth=!$('healthModal').classList.contains('hidden');$('healthModal').classList.add('hidden');}visible=true;$('maintenanceModal').classList.remove('hidden');if(pending)$('maintenanceScope').value=pending.scope;return refresh();};
  $('healthRestartBtn').onclick=open;$('maintenanceClose').onclick=close;$('maintenanceRefresh').onclick=refresh;
  $('maintenanceScope').onchange=()=>{$('maintenanceConfirm').checked=false;render();};$('maintenanceConfirm').onchange=render;
  $('maintenanceModal').onclick=event=>{if(event.target===$('maintenanceModal'))close();};
  $('maintenanceModal').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}});
  $('maintenanceForm').onsubmit=async event=>{
    event.preventDefault();if($('maintenanceSubmit').disabled)return;
    const scope=pending?.scope || $('maintenanceScope').value;
    pending ||= {id:crypto.randomUUID(),scope};save();busy=true;
    const body=JSON.stringify({requestId:pending.id,scope,password:$('maintenancePassword').value,confirmDesktop:$('maintenanceConfirm').checked});$('maintenancePassword').value='';render();
    try{const result=await api('/api/maintenance/restart',{method:'POST',body});info={...info,job:result.job};$('maintenanceError').textContent='';}
    catch(error){$('maintenanceError').textContent=error.message;if([400,403,429].includes(error.status)){pending=null;save();}}
    finally{busy=false;render();schedule();}
  };
  document.addEventListener('visibilitychange',()=>{if(visible&&!document.hidden)refresh();});
  return {open,close,refresh};
}
