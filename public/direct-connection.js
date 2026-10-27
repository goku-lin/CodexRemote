import {PeerWire} from './peer-wire.js';

export function requestDevice(path,options,{sessions=[],selectedDeviceId,receiptDevices=new Map()}={}){
  const url=new URL(path,'http://localhost'),p=url.pathname;
  if(p==='/api/bootstrap' || p==='/api/events' || p==='/api/projects' || /\/direct(?:\/|$)/.test(p))return null;
  if(options?.deviceId)return options.deviceId;
  const device=p.match(/^\/api\/devices\/([^/]+)/);if(device)return decodeURIComponent(device[1]);
  const session=p.match(/^\/api\/sessions\/([^/]+)/);if(session)return sessions.find(item=>item.id===decodeURIComponent(session[1]))?.deviceId || null;
  const receipt=p.match(/^\/api\/deliveries\/([^/]+)/);if(receipt)return receiptDevices.get(receipt[1]) || selectedDeviceId;
  let body;try{body=JSON.parse(options?.body || '{}');}catch{}
  if(p==='/api/sessions')return options?.method==='POST' ? body?.deviceId : null;
  if(p.startsWith('/api/uploads'))return selectedDeviceId;
  if(p.startsWith('/api/approvals'))return sessions.find(item=>item.id===body?.sessionId)?.deviceId || null;
  return null;
}

export class DirectConnections {
  constructor({signal,onEvent,onChange,createPeer=()=>new RTCPeerConnection({iceServers:[]})}){
    Object.assign(this,{signal,onEvent,onChange,createPeer});this.peers=new Map();this.failedUntil=new Map();
  }
  ready(id){return this.peers.get(id)?.channel?.readyState==='open';}
  async ensure(device){
    if(!device?.executionRelay || !device.online || typeof RTCPeerConnection==='undefined' || Date.now()<(this.failedUntil.get(device.id) || 0))return;
    const existing=this.peers.get(device.id);if(existing)return existing.connecting;
    const id=device.id,pc=this.createPeer(),channel=pc.createDataChannel('codex-relay');
    const peer={pc,channel,pending:new Map()};this.peers.set(id,peer);this.onChange(id,'connecting');
    const send=async text=>{for(let i=0;channel.bufferedAmount>256_000;i++){if(i>300 || channel.readyState!=='open')throw new Error('直连拥塞');await new Promise(resolve=>setTimeout(resolve,10));}if(channel.readyState!=='open')throw new Error('直连中断');channel.send(text);};
    peer.wire=new PeerWire({send,onMessage:message=>{
      if(message.kind==='event')this.onEvent(id,message.type,message.data);
      if(message.kind==='response'){const request=peer.pending.get(message.id);if(!request)return;peer.pending.delete(message.id);clearTimeout(request.timer);message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);}
    }});
    channel.onmessage=event=>peer.wire.read(event.data);
    channel.onclose=()=>this.drop(id,peer);channel.onerror=()=>this.drop(id,peer);
    pc.onconnectionstatechange=()=>{
      clearTimeout(peer.disconnectedTimer);
      if(['failed','closed'].includes(pc.connectionState))this.drop(id,peer);
      else if(pc.connectionState==='disconnected')peer.disconnectedTimer=setTimeout(()=>this.drop(id,peer),5000);
    };
    peer.connecting=(async()=>{
      try{
        await pc.setLocalDescription(await pc.createOffer());
        if(pc.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pc.removeEventListener('icegatheringstatechange',check);reject(new Error('直连地址收集超时'));},5000);const check=()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',check);resolve();}};pc.addEventListener('icegatheringstatechange',check);check();});
        const result=await this.signal('/api/devices/'+encodeURIComponent(id)+'/direct',{method:'POST',body:JSON.stringify({offer:pc.localDescription})});
        peer.peerId=result.peerId;if(this.peers.get(id)!==peer)throw new Error('直连已取消');
        const opened=new Promise((resolve,reject)=>{peer.openReject=reject;peer.openTimer=setTimeout(()=>reject(new Error('直连超时')),10_000);channel.onopen=()=>{clearTimeout(peer.openTimer);peer.openReject=null;resolve();};});
        await pc.setRemoteDescription(result.answer);await opened;
        if(this.peers.get(id)!==peer)return;
        peer.lease=setInterval(()=>this.signal('/api/devices/'+encodeURIComponent(id)+'/direct/'+peer.peerId+'/lease',{method:'POST',body:'{}'}).catch(()=>this.drop(id,peer)),15_000);
        this.onChange(id,'direct');
      }catch{this.failedUntil.set(id,Date.now()+60_000);this.drop(id,peer);}
    })();return peer.connecting;
  }
  drop(id,peer=this.peers.get(id)){
    if(!peer || this.peers.get(id)!==peer)return;
    this.peers.delete(id);clearInterval(peer.lease);clearTimeout(peer.openTimer);clearTimeout(peer.disconnectedTimer);peer.openReject?.(new Error('直连已关闭'));
    for(const request of peer.pending.values()){clearTimeout(request.timer);request.reject(new Error('直连中断，发送结果待核对；输入已保留。'));}
    peer.pending.clear();peer.pc.close();this.onChange(id,'relay');
    if(peer.peerId)this.signal('/api/devices/'+encodeURIComponent(id)+'/direct/'+peer.peerId+'/close',{method:'POST',body:'{}'}).catch(()=>{});
  }
  stop(){for(const id of this.peers.keys())this.drop(id);}
  async request(id,path,options={}){
    const peer=this.peers.get(id);if(!peer || peer.channel.readyState!=='open')throw new Error('直连尚未就绪');
    const requestId=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{peer.pending.delete(requestId);reject(new Error('直连响应超时，发送结果待核对；输入已保留。'));this.drop(id,peer);},options.timeoutMs || 20_000);
      peer.pending.set(requestId,{resolve,reject,timer});
      peer.wire.write({kind:'request',id:requestId,path,method:options.method || 'GET',body:options.body}).catch(error=>{clearTimeout(timer);peer.pending.delete(requestId);reject(error);});
      // A dispatched write is never silently retried through the other route.
    });
  }
}

export function peerResponse(result){
  const bytes=Uint8Array.from(atob(result.body),char=>char.charCodeAt(0));
  return new Response(bytes,{status:result.status,headers:{'content-type':result.type || 'application/json',...(result.headers || {})}});
}
