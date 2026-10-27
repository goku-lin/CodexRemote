const $ = id => document.getElementById(id);
let running = false, timer = null, screenshotBusy = false;
const quality = { low:{value:35,interval:2000,label:'低流量'}, balanced:{value:55,interval:1200,label:'平衡'}, high:{value:75,interval:700,label:'高画质'} };
async function api(path, options) {
  const response = await fetch(path, { ...options, headers:{'content-type':'application/json', ...(options?.headers || {})} });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
  return value;
}
function status(text) { $('remoteBrowserStatus').textContent = text; }
async function screenshot() {
  if (!running || document.hidden || screenshotBusy) return;
  screenshotBusy = true;
  try {
    const selected = quality[$('remoteBrowserQuality').value] || quality.balanced;
    const response = await fetch('/api/remote-browser/screenshot?quality='+selected.value+'&at='+Date.now(), { cache:'no-store' });
    if (!response.ok) { status('远程浏览器暂时不可用。'); return; }
    const old = $('remoteBrowserScreen').src; $('remoteBrowserScreen').src = URL.createObjectURL(await response.blob()); if (old) URL.revokeObjectURL(old);
  } catch (error) { status(error.message || '远程浏览器暂时不可用。'); }
  finally { screenshotBusy = false; }
}
function schedule() { clearInterval(timer); timer = setInterval(screenshot, (quality[$('remoteBrowserQuality').value] || quality.balanced).interval); }
async function start() {
  $('remoteBrowserStart').disabled = true; status('正在启动家里的远程浏览器…');
  try { await api('/api/remote-browser/start',{method:'POST',body:JSON.stringify({url:'https://chatgpt.com/'})}); running=true; $('remoteBrowserEmpty').hidden=true; status('远程浏览器已连接；首次使用请在家里电脑完成登录。'); schedule(); await screenshot(); }
  catch (error) { status(error.message); }
  finally { $('remoteBrowserStart').disabled=false; }
}
async function input(body) { if (!running) return; try { await api('/api/remote-browser/input',{method:'POST',body:JSON.stringify(body)}); await screenshot(); } catch (error) { status(error.message); } }
$('remoteBrowserStart').onclick = start;
$('remoteBrowserQuality').onchange = () => { schedule(); if (running) screenshot(); };
$('remoteBrowserInput').onsubmit = event => { event.preventDefault(); const text=$('remoteBrowserText').value; if(text){input({type:'type',text});$('remoteBrowserText').value='';} };
$('remoteBrowserEnter').onclick = () => input({type:'key',key:'Enter'});
$('remoteBrowserScreen').onclick = event => { const image=event.currentTarget; const rect=image.getBoundingClientRect(); input({type:'click',x:(event.clientX-rect.left)*image.naturalWidth/rect.width,y:(event.clientY-rect.top)*image.naturalHeight/rect.height}); };
$('remoteBrowserScreen').onwheel = event => { event.preventDefault(); const image=event.currentTarget,rect=image.getBoundingClientRect(); input({type:'scroll',x:(event.clientX-rect.left)*image.naturalWidth/rect.width,y:(event.clientY-rect.top)*image.naturalHeight/rect.height,deltaY:event.deltaY,deltaX:event.deltaX}); };
document.addEventListener('visibilitychange',()=>{if(!document.hidden)screenshot();});
