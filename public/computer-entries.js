const storageKey='codex-relay-computer-entries';
const fragmentPrefix='#codex-computers=';
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function computerUrl(value){
  if(typeof value!=='string' || value.length>1000)throw new Error('电脑入口地址无效或过长');
  const url=new URL(String(value).trim());
  const privateHttp=/^(?:localhost|127\.0\.0\.1|10\.(?:\d+\.){2}\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/.test(url.hostname);
  if(url.hostname.length>253 || url.username || url.password || url.pathname!=='/' || url.search || url.hash || !(url.protocol==='https:' || url.protocol==='http:' && privateHttp))throw new Error('请输入电脑的完整 HTTPS 根地址，或局域网 HTTP 地址；不要包含配对码、用户名或密码');
  return url.origin+'/';
}
function entry(value){
  if(!value || typeof value.name!=='string' || !value.name.trim() || value.name.length>80)throw new Error('电脑名称需要 1–80 个字符');
  return {name:value.name.trim(),url:computerUrl(value.url)};
}
function entries(values){
  if(!Array.isArray(values) || values.length>20)throw new Error('最多保存 20 个电脑入口');
  const result=new Map();for(const value of values){const item=entry(value);result.set(item.url,item);}return [...result.values()];
}
export class ComputerEntries {
  constructor(storage){
    this.storage=storage;this.items=[];
    try{this.items=entries(JSON.parse(storage?.getItem(storageKey) || '[]'));}catch{/* Invalid or unavailable browser storage starts empty. */}
  }
  save(){try{this.storage?.setItem(storageKey,JSON.stringify(this.items));}catch{/* The downloadable entry page remains available. */}}
  add(value){const item=entry(value),next=this.items.filter(old=>old.url!==item.url);if(next.length>=20)throw new Error('最多保存 20 个电脑入口');this.items=[...next,item];this.save();}
  remove(url){this.items=this.items.filter(item=>item.url!==url);this.save();}
  import(values){const next=new Map(this.items.map(item=>[item.url,item]));for(const item of entries(values))if(!next.has(item.url))next.set(item.url,item);if(next.size>20)throw new Error('最多保存 20 个电脑入口');this.items=[...next.values()];this.save();}
}
export function entryLink(url,values){
  return computerUrl(url)+fragmentPrefix+encodeURIComponent(JSON.stringify({version:1,entries:entries(values)}));
}
export function importedEntries(fragment){
  if(!fragment.startsWith(fragmentPrefix))return null;
  if(fragment.length>32000)throw new Error('入口名单过大');
  const data=JSON.parse(decodeURIComponent(fragment.slice(fragmentPrefix.length)));
  if(data.version!==1)throw new Error('入口名单格式无效');return entries(data.entries);
}
export function entryPage(values){
  const items=entries(values);
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex 电脑入口</title><style>body{font:16px system-ui;max-width:640px;margin:40px auto;padding:20px;background:#121822;color:#e7edf6}a{display:block;color:#9ac4ff;padding:18px;border:1px solid #46536b;border-radius:12px;margin:14px 0;overflow-wrap:anywhere}small{display:block;margin-top:8px}p{line-height:1.7}</style><h1>Codex 电脑入口</h1><p>选择正在开机的电脑。各电脑独立连接并单独配对。此入口页保存在本地，任何一台电脑关机都不影响打开它。</p>'+items.map(item=>'<a rel="noreferrer" href="'+escape(entryLink(item.url,items))+'">'+escape(item.name)+'<small>'+escape(item.url)+'</small></a>').join('')+'<p>局域网地址用于设备可以互访的网络；外网使用各电脑的 HTTPS 地址。入口名单不含配对凭据。</p></html>';
}

export function setupComputerEntries({beforeNavigate=()=>{},shareAddress}={}){
  const get=id=>document.getElementById(id);let storage;try{storage=localStorage;}catch{}
  const directory=new ComputerEntries(storage);let imported=null;
  try{
    const incoming=importedEntries(location.hash);
    if(incoming){
      imported=incoming.filter(item=>!directory.items.some(known=>known.url===item.url));
      history.replaceState(null,'',location.pathname+location.search);
    }
  }catch(error){get('computerEntriesError').textContent='入口名单未导入：'+error.message;}
  const row=item=>{
    const element=document.createElement('div');element.className='computer-entry';
    const link=document.createElement('a');link.href=entryLink(item.url,directory.items);link.rel='noreferrer';
    const title=document.createElement('strong');title.textContent=item.name;
    const address=document.createElement('small');address.textContent=item.url;
    link.append(title,address);link.onclick=()=>beforeNavigate();
    const remove=document.createElement('button');remove.type='button';remove.className='link-btn';remove.textContent='移除';
    remove.setAttribute('aria-label','移除 '+item.name);remove.onclick=()=>{directory.remove(item.url);render();};
    element.append(link,remove);return element;
  };
  const render=()=>{
    get('computerEntryList').replaceChildren(...directory.items.map(row));
    get('computerEntrySidebar')?.replaceChildren(...directory.items.map(item=>{
      const link=document.createElement('a');link.className='computer-entry-short';link.textContent=item.name;
      link.href=entryLink(item.url,directory.items);link.rel='noreferrer';link.title=item.url;
      link.onclick=()=>beforeNavigate();return link;
    }));
    get('downloadComputerEntries').disabled=!directory.items.length;
    get('computerEntriesEmpty').classList.toggle('hidden',Boolean(directory.items.length));
    get('computerEntriesImport').classList.toggle('hidden',!imported?.length);
    get('computerEntriesImportList').replaceChildren(...(imported || []).map(item=>{const p=document.createElement('p');p.textContent=item.name+' · '+item.url;return p;}));
  };
  const open=()=>{get('deviceSettingsModal')?.classList.add('hidden');get('computerEntriesModal').classList.remove('hidden');render();};
  for(const id of ['computerEntriesBtn','pairingComputerEntriesBtn'])get(id).onclick=open;
  get('computerEntriesClose').onclick=()=>get('computerEntriesModal').classList.add('hidden');
  get('computerEntriesForm').onsubmit=event=>{
    event.preventDefault();try{directory.add({name:get('computerEntryName').value,url:get('computerEntryUrl').value});get('computerEntriesError').textContent='';render();}catch(error){get('computerEntriesError').textContent=error.message;}
  };
  get('saveCurrentComputer').onclick=async()=>{
    try{
      let url=location.origin+'/';
      if(shareAddress && /^(?:127\.0\.0\.1|localhost)$/.test(location.hostname)){
        const info=await shareAddress();url=info.publicUrl || info.urls[0] || info.externalUrl;
        if(!url)throw new Error('尚未找到可分享的地址，请连接局域网后在「连接手机」中查看');
      }
      get('computerEntryUrl').value=url;get('computerEntryName').focus();get('computerEntriesError').textContent='';
    }catch(error){get('computerEntriesError').textContent=error.message;}
  };
  get('acceptComputerEntries').onclick=()=>{try{directory.import(imported);imported=null;get('computerEntriesError').textContent='';render();}catch(error){get('computerEntriesError').textContent=error.message;}};
  get('discardComputerEntries').onclick=()=>{imported=null;render();};
  get('downloadComputerEntries').onclick=()=>{
    const url=URL.createObjectURL(new Blob([entryPage(directory.items)],{type:'text/html;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='Codex电脑入口.html';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  render();if(imported?.length)open();
}
