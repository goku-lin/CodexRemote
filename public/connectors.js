import {syncHtml} from './dom-sync.js';
const escape=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function setupConnectors(api){
  const get=id=>document.getElementById(id);let local=false;
  const refresh=async()=>{
    try{
      const info=await api('/api/connectors');local=info.local;
      get('legacyConnectorControls').classList.toggle('hidden',info.mode==='independent');
      get('connectorUrl').textContent=info.url;get('connectorCodeBtn').disabled=!local;
      get('connectorDownload').classList.toggle('hidden',!info.release);
      get('connectorAccessNote').textContent=local ? '连接码有效 10 分钟，只用于一台电脑；重试安装可恢复同一次授权。' : '请在主电脑本机打开 Relay 生成连接码。此页面可下载安装包。';
      syncHtml(get('connectorComputers'),info.devices.map(item=>`<div class="connector-computer" data-node-key="connector-${escape(item.id)}"><div><strong>${escape(item.name)}</strong><p class="muted">${item.revokedAt ? '已撤销授权' : item.online ? '已连接' : '离线'}${item.version ? ' · '+escape(item.version.slice(0,8)) : ''}</p></div>${local && !item.revokedAt ? `<button class="link-btn" data-revoke-connector="${escape(item.id)}">撤销连接</button>` : ''}</div>`).join('') || '<p class="muted">尚未添加其他电脑。</p>');
      get('connectorComputers').querySelectorAll('[data-revoke-connector]').forEach(button=>button.onclick=async()=>{
        if(!confirm('撤销后，这台电脑需要重新安装配对才能连接。已有对话会保留。'))return;
        try{await api('/api/connectors/'+button.dataset.revokeConnector,{method:'DELETE'});await refresh();}catch(error){get('connectorError').textContent=error.message;}
      });
      get('connectorError').textContent=info.release ? '' : '当前电脑暂无安装器，请从发布电脑下载完整的 EXE 安装器。';
    }catch(error){get('connectorError').textContent=error.message;}
  };
  get('addComputerBtn').onclick=()=>{get('deviceSettingsModal')?.classList.add('hidden');get('connectorModal').classList.remove('hidden');refresh();};
  get('connectorCloseBtn').onclick=()=>get('connectorModal').classList.add('hidden');
  get('connectorRefreshBtn').onclick=refresh;
  get('connectorCodeBtn').onclick=async()=>{
    if(!local)return;
    try{const info=await api('/api/connectors/code',{method:'POST',body:'{}'});get('connectorCode').textContent=info.code;get('connectorAccessNote').textContent='有效至 '+new Date(info.expiresAt).toLocaleTimeString()+'；用于一台电脑，请勿公开。';get('connectorError').textContent='';}
    catch(error){get('connectorError').textContent=error.message;}
  };
}
