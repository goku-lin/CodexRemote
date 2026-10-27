import {DEFAULT_PERFORMANCE_SETTINGS,performanceSettings} from './performance-settings.js';

export function setupPerformanceSettings({api,getDevice,onDevice,closeNavigation=()=>{}}) {
  const $=id=>document.getElementById(id);
  let origin=null,busy=false,sequence=0;
  const fill=settings=>{
    $('preloadEnabled').checked=settings.preloadEnabled;
    $('preloadCount').value=settings.preloadCount;
    $('historyTurns').value=settings.historyTurns;
    $('preloadScope').value=settings.preloadScope;
    $('preloadOptions').disabled=!settings.preloadEnabled;
  };
  const close=()=>{if(busy)return;sequence++;origin=null;$('performanceSettingsModal').classList.add('hidden');$('performanceSettingsBtn').focus();};
  const open=async()=>{
    const target=getDevice();if(!target)return;
    closeNavigation();origin=target.id;const current=++sequence;
    $('performanceComputer').textContent='适用于 '+target.name+'；连接此电脑的所有浏览器共用。';
    fill(performanceSettings(target.performanceSettings));
    $('resetPerformanceSettingsBtn').disabled=false;
    $('performanceSettingsError').textContent='正在读取设置…';$('savePerformanceSettingsBtn').disabled=true;
    $('performanceSettingsModal').classList.remove('hidden');$('closePerformanceSettingsBtn').focus();
    try{
      const result=await api('/api/devices/'+encodeURIComponent(origin)+'/performance');
      if(current!==sequence)return;
      fill(performanceSettings(result.settings));$('performanceSettingsError').textContent='';$('savePerformanceSettingsBtn').disabled=false;
    }catch(error){if(current===sequence)$('performanceSettingsError').textContent=error.message;}
  };
  $('performanceSettingsBtn').onclick=open;
  for(const id of ['closePerformanceSettingsBtn','cancelPerformanceSettingsBtn'])$(id).onclick=close;
  $('performanceSettingsModal').onclick=event=>{if(event.target===$('performanceSettingsModal'))close();};
  $('performanceSettingsModal').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}});
  $('preloadEnabled').onchange=()=>{$('preloadOptions').disabled=!$('preloadEnabled').checked;};
  $('resetPerformanceSettingsBtn').onclick=()=>{if(!busy)fill(DEFAULT_PERFORMANCE_SETTINGS);};
  $('performanceSettingsForm').onsubmit=async event=>{
    event.preventDefault();if(busy || !origin || $('savePerformanceSettingsBtn').disabled)return;
    const id=origin,current=sequence;
    try{
      const settings=performanceSettings({preloadEnabled:$('preloadEnabled').checked,preloadCount:Number($('preloadCount').value),historyTurns:Number($('historyTurns').value),preloadScope:$('preloadScope').value},true);
      busy=true;$('savePerformanceSettingsBtn').disabled=true;$('resetPerformanceSettingsBtn').disabled=true;$('performanceSettingsError').textContent='正在保存…';
      const result=await api('/api/devices/'+encodeURIComponent(id)+'/performance',{method:'PATCH',body:JSON.stringify(settings)});
      if(current!==sequence)return;
      onDevice(result.device);busy=false;close();
    }catch(error){if(current===sequence)$('performanceSettingsError').textContent=error.message;}
    finally{busy=false;$('resetPerformanceSettingsBtn').disabled=false;if(current===sequence)$('savePerformanceSettingsBtn').disabled=false;}
  };
  return {open,close};
}
