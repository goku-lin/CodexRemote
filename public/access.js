const element = id => document.getElementById(id);
async function request(url, options={}) {
  const {timeout=15_000,...fetchOptions}=options;
  const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),timeout);
  try {
    const response=await fetch(url,{...fetchOptions,signal:abort.signal,headers:{'content-type':'application/json',...fetchOptions.headers}});
    const body=await response.json();
    if (!response.ok) throw new Error(body.error || '连接失败，请重试。');
    return body;
  } finally {clearTimeout(timer);}
}

export function showAccessRequired(message) {
  element('pairingGate').classList.remove('hidden');element('pairingError').textContent=message;
  element('pairingCodeInput').focus();
}

export async function checkAccess(access = null) {
  access ||= await request('/api/access');
  element('phoneConnectBtn').classList.toggle('hidden',!access.local);
  element('pairingGate').classList.toggle('hidden',!access.required);
  if (access.required) element('pairingCodeInput').focus();
  return !access.required;
}

const date=value=>new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
export function setupAccess(onPaired) {
  let lanEnabled=false;
  const showInfo=info=>{
    lanEnabled=info.lanEnabled===true;
    element('toggleLanBtn').textContent=lanEnabled?'关闭局域网':'开启局域网';
    element('lanStatus').textContent=info.lanError || (lanEnabled ? '局域网已开启，可手动关闭，不会按时间自动关闭。关闭后不影响公网连接。' : '局域网默认关闭。需要同一 Wi-Fi 访问或向另一台电脑提供更新时开启；首次开启需 Windows 管理员授权，仅限专用网络。');
    element('lanAddressField').classList.toggle('hidden',!lanEnabled);
    element('lanAddress').value=info.urls[0]||'';
    element('phoneAddress').value=info.publicUrl || info.externalUrl || info.urls[0] || '';
    element('phoneAddressLabel').textContent=info.publicUrl ? '浏览器直接访问（无需安装）' : info.externalUrl ? 'Tailscale 私有访问地址' : '同一 Wi-Fi 访问地址';
    element('privateAddressField').classList.toggle('hidden',!info.privateUrl);
    element('privateAddress').value=info.privateUrl || '';
    element('phoneInstructions').textContent=info.accessMode==='hybrid'
      ? '已安装 Tailscale 的设备使用私有地址；未安装的设备用浏览器直接打开公开地址。两种方式都需要首次配对，授权统一在下方管理。'
      : info.externalUrl ? '手机和笔记本连接 Tailscale 后打开下面的地址，再输入配对码。'
      : '连接同一 Wi-Fi，在手机浏览器打开下面的地址，再输入配对码。外网入口尚未配置。';
    element('phoneCode').textContent=info.code.slice(0,4)+' '+info.code.slice(4);
    element('phoneExpiry').textContent=`配对码有效至 ${new Date(info.expiresAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}，使用一次后失效。`;
    if (!info.enabled) element('phoneError').textContent='请开启局域网或配置外网入口，再连接其他设备。';
    else if (!info.externalUrl && !info.urls.length) element('phoneError').textContent='没有找到局域网地址，请连接 Wi-Fi 后重试。';
  };
  const renderDevices=devices=>{
    const list=element('browserDeviceList');list.replaceChildren();
    element('revokeAllDevicesBtn').disabled=!devices.some(device=>device.status==='authorized');
    if(!devices.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='还没有设备配对。已有设备下次连接时会自动加入列表。';list.append(empty);return;}
    for(const device of devices){
      const row=document.createElement('div');row.className='browser-device';
      const field=document.createElement('label');field.className='field-label';
      const name=document.createElement('input');name.type='text';name.maxLength=80;name.value=device.name;name.setAttribute('aria-label','设备名称：'+device.name);field.append(name);
      const details=document.createElement('p');details.className='muted browser-device-meta';
      const status={authorized:'已授权',revoked:'已撤销',expired:'已过期'}[device.status];
      details.textContent=`${status} · 最近访问 ${date(device.lastSeen)} · ${device.status==='revoked' ? '撤销于 '+date(device.revokedAt) : '有效至 '+date(device.expiresAt)}`;
      const actions=document.createElement('div');actions.className='browser-device-actions';
      const save=document.createElement('button');save.type='button';save.className='btn';save.textContent='保存名称';
      save.onclick=()=>perform(save,async()=>renderDevices((await request('/api/access/devices/'+device.id,{method:'PATCH',body:JSON.stringify({name:name.value})})).devices));
      const revoke=document.createElement('button');revoke.type='button';revoke.className='btn danger';revoke.textContent=device.status==='authorized' ? '撤销访问' : status;revoke.disabled=device.status!=='authorized';
      revoke.onclick=()=>perform(revoke,async()=>renderDevices((await request('/api/access/devices/'+device.id,{method:'DELETE'})).devices));
      actions.append(save,revoke);row.append(field,details,actions);list.append(row);
    }
  };
  const perform=async(button,action)=>{
    button.disabled=true;element('phoneError').textContent='';
    let succeeded=false;
    try {await action();succeeded=true;} catch(error){element('phoneError').textContent=error.name==='AbortError' ? '连接超时，请重试。' : error.message;}
    finally {if(button.isConnected && (!succeeded || button.id!=='revokeAllDevicesBtn'))button.disabled=false;}
  };
  const loadDevices=async()=>renderDevices((await request('/api/access/devices')).devices);
  const openPhone=async()=>{
    element('phoneModal').classList.remove('hidden');element('phoneError').textContent='';
    try {const [info,devices]=await Promise.all([request('/api/phone'),request('/api/access/devices')]);showInfo(info);renderDevices(devices.devices);}
    catch(error){element('phoneError').textContent=error.message;}
  };
  element('phoneConnectBtn').onclick=openPhone;
  element('toggleLanBtn').onclick=()=>perform(element('toggleLanBtn'),async()=>{
    await request('/api/access/lan',{method:'POST',body:JSON.stringify({enabled:!lanEnabled}),timeout:125000});
    showInfo(await request('/api/phone'));
  });
  element('refreshPhoneBtn').onclick=()=>perform(element('refreshPhoneBtn'),async()=>showInfo(await request('/api/access/code',{method:'POST',body:'{}'})));
  element('refreshBrowserDevicesBtn').onclick=()=>perform(element('refreshBrowserDevicesBtn'),loadDevices);
  element('revokeAllDevicesBtn').onclick=()=>perform(element('revokeAllDevicesBtn'),async()=>{
    renderDevices((await request('/api/access/devices',{method:'DELETE'})).devices);showInfo(await request('/api/phone'));
  });
  element('closePhoneBtn').onclick=()=>element('phoneModal').classList.add('hidden');
  for(const [button,input] of [['copyPhoneAddressBtn','phoneAddress'],['copyPrivateAddressBtn','privateAddress'],['copyLanAddressBtn','lanAddress']])element(button).onclick=async()=>{
    try {await navigator.clipboard.writeText(element(input).value);element(button).textContent='已复制';}
    catch {element(input).focus();element(input).select();}
  };
  element('pairingForm').onsubmit=async event=>{
    event.preventDefault(); element('pairingSubmitBtn').disabled=true; element('pairingError').textContent='';
    try { await request('/api/access/pair',{method:'POST',body:JSON.stringify({code:element('pairingCodeInput').value,deviceName:element('pairingDeviceName').value,computerName:element('pairingComputerName').value.trim()})}); element('pairingCodeInput').value=''; await onPaired(); }
    catch(error) { element('pairingError').textContent=error.message; }
    finally { element('pairingSubmitBtn').disabled=false; }
  };
  window.addEventListener('keydown',event=>{if(event.key==='Escape')element('phoneModal').classList.add('hidden');});
}
