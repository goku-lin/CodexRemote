export const downloadBytes=384*1024,uploadBytes=128*1024;

// Deliberately bounded: this measures effective transfer speed including waits,
// without saturating the connection or running any background traffic.
export async function measureNetwork({fetcher=fetch,now=()=>performance.now(),random=bytes=>crypto.getRandomValues(bytes),signal,onProgress=()=>{}}={}){
  const controller=new AbortController(),cancel=()=>controller.abort(signal?.reason);
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const timeout=setTimeout(()=>controller.abort(new Error('检测超时，请稍后再试')),40000);
  let transferred=0;
  const request=async(kind,options={})=>{
    const response=await fetcher('/api/network-check/'+kind+'?t='+Date.now(),{cache:'no-store',credentials:'same-origin',...options,signal:controller.signal});
    if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error || (response.status===404 ? '后台尚未加载网速检测功能' : '网络检测失败（'+response.status+'）'));}
    return response;
  };
  try{
    const latency=[];
    for(let i=0;i<3;i++){
      onProgress('正在检测响应延迟…');const start=now();
      const result=await (await request('ping')).json();
      if(result.networkCheck!==1)throw new Error('检测响应无效，请刷新页面后重试');
      latency.push(now()-start);
    }
    onProgress('正在检测服务端 → 本设备…');let start=now();
    const response=await request('download'),received=await response.arrayBuffer();
    const downloadMs=now()-start;transferred+=received.byteLength;
    if(received.byteLength!==downloadBytes)throw new Error('下载测试数据不完整');
    const bytes=new Uint8Array(uploadBytes);
    for(let offset=0;offset<bytes.length;offset+=65536)random(bytes.subarray(offset,offset+65536));
    onProgress('正在检测本设备 → 服务端…');start=now();
    const uploaded=await (await request('upload',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes})).json();
    const uploadMs=now()-start;transferred+=uploadBytes;
    if(uploaded.bytes!==uploadBytes)throw new Error('上传测试数据不完整');
    return {latencyMs:latency.sort((a,b)=>a-b)[1],downloadMbps:downloadBytes*8/Math.max(downloadMs,1)/1000,uploadMbps:uploadBytes*8/Math.max(uploadMs,1)/1000,transferred,checkedAt:Date.now()};
  }finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);}
}

export function setupNetworkCheck(){
  const button=document.getElementById('networkCheckBtn'),cancel=document.getElementById('networkCheckCancelBtn'),output=document.getElementById('networkCheckResult');
  if(!button || !cancel || !output)return;
  let controller;
  const stop=()=>controller?.abort();
  document.getElementById('healthCloseBtn')?.addEventListener('click',stop);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
  cancel.onclick=stop;
  button.onclick=async()=>{
    if(controller)return;
    const active=controller=new AbortController();button.disabled=true;cancel.hidden=false;
    output.textContent='正在检测…';
    try{
      const result=await measureNetwork({signal:active.signal,onProgress:text=>{output.textContent=text;}});
      output.textContent=`响应延迟 ${Math.round(result.latencyMs)} ms · 下载 ${result.downloadMbps.toFixed(2)} Mbps · 上传 ${result.uploadMbps.toFixed(2)} Mbps\n${new Date(result.checkedAt).toLocaleTimeString()} 检测 · 测试数据 ${(result.transferred/1024).toFixed(0)} KiB（不含协议开销）`;
    }catch(error){output.textContent=active.signal.aborted ? '检测已停止' : error.message;}
    finally{controller=null;button.disabled=false;cancel.hidden=true;}
  };
}
