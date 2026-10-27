import net from 'node:net';
import path from 'node:path';
import {RTCPeerConnection} from 'werift';
import {supervise} from './supervisor.mjs';
import {executionPath} from './device-gateway.mjs';
import {PeerWire} from '../public/peer-wire.js';

export async function availablePort(){const socket=net.createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;}
export async function localRequest(base,{path:target,method='GET',body,headers={}}){
  if(!executionPath(target,method) || target==='/api/events')throw new Error('不允许的执行接口');
  const forwarded={'content-type':'application/json'};
  for(const name of ['range','if-range'])if(typeof headers[name]==='string')forwarded[name]=headers[name];
  const response=await fetch(base+target,{method,headers:forwarded,body:body || undefined,signal:AbortSignal.timeout(20_000),redirect:'error'});
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>16_000_000)throw new Error('执行设备响应过大');
  const resultHeaders={};for(const name of ['accept-ranges','content-range','etag','content-disposition','content-security-policy','referrer-policy','x-content-type-options'])if(response.headers.has(name))resultHeaders[name]=response.headers.get(name);
  return {status:response.status,type:response.headers.get('content-type'),body:bytes.toString('base64'),...(Object.keys(resultHeaders).length ? {headers:resultHeaders} : {})};
}
export async function consumeSse(url,headers,onEvent,signal){
  const response=await fetch(url,{headers,signal});if(!response.ok || !response.body)throw new Error('连接失败 '+response.status);
  let buffer='';const decoder=new TextDecoder();
  for await(const bytes of response.body){buffer+=decoder.decode(bytes,{stream:true});if(buffer.length>24_000_000)throw new Error('事件过大');let index;
    while((index=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,index);buffer=buffer.slice(index+2);const type=frame.match(/^event: (.*)$/m)?.[1],data=frame.match(/^data: (.*)$/m)?.[1];if(type && data)await onEvent(type,JSON.parse(data));}
  }
}
export class ConnectorPeers {
  constructor({base,deviceId,leaseMs=45_000}){Object.assign(this,{base,deviceId,leaseMs});this.peers=new Map();this.timer=setInterval(()=>{for(const [id,peer] of this.peers)if(peer.expiresAt<Date.now())this.close(id);},1000);this.timer.unref();}
  async offer({peerId,offer}){
    if(!/^[a-f0-9-]{36}$/.test(peerId) || offer?.type!=='offer' || typeof offer.sdp!=='string' || offer.sdp.length>100_000 || this.peers.size>=8)throw new Error('直连请求无效或连接数量过多');
    this.close(peerId);
    const pc=new RTCPeerConnection({iceServers:[],iceUseIpv6:false});
    const peer={pc,expiresAt:Date.now()+this.leaseMs};this.peers.set(peerId,peer);
    pc.onDataChannel.subscribe(channel=>{
      if(peer.channel || channel.label!=='codex-relay'){channel.close();return;}
      peer.channel=channel;
      const send=async text=>{for(let i=0;channel.bufferedAmount>256_000;i++){if(i>300 || channel.readyState!=='open')throw new Error('直连拥塞');await new Promise(resolve=>setTimeout(resolve,10));}if(channel.readyState!=='open')throw new Error('直连断开');channel.send(text);};
      peer.wire=new PeerWire({send,onMessage:message=>this.request(peerId,message)});
      channel.onMessage.subscribe(data=>peer.wire.read(typeof data==='string' ? data : data.toString()));
      channel.stateChanged.subscribe(state=>{if(state==='open')this.snapshot(peer).catch(()=>this.close(peerId));if(state==='closed')this.close(peerId);});
    });
    try{await pc.setRemoteDescription(offer);await pc.setLocalDescription(await pc.createAnswer());return {peerId,answer:pc.localDescription,leaseMs:this.leaseMs};}
    catch(error){this.close(peerId);throw error;}
  }
  async snapshot(peer){const result=await localRequest(this.base,{path:'/api/bootstrap'});const data=JSON.parse(Buffer.from(result.body,'base64'));await peer.wire.write({kind:'event',type:'snapshot',data});}
  async request(peerId,message){
    const peer=this.peers.get(peerId);if(!peer || peer.expiresAt<Date.now() || !/^[a-f0-9-]{36}$/.test(message?.id) || message.kind!=='request')return;
    peer.pending ||= new Set();if(peer.pending.size>=16 || peer.pending.has(message.id))return;
    peer.pending.add(message.id);
    try{const result=await localRequest(this.base,message);await peer.wire.write({kind:'response',id:message.id,result});}
    catch(error){await peer.wire?.write({kind:'response',id:message.id,error:error.message}).catch(()=>this.close(peerId));}
    finally{peer.pending.delete(message.id);}
  }
  lease(peerId){const peer=this.peers.get(peerId);if(!peer)throw new Error('直连已结束');peer.expiresAt=Date.now()+this.leaseMs;return {ok:true};}
  event(type,data){for(const [id,peer] of this.peers)if(peer.channel?.readyState==='open'){
    peer.outbound=(peer.outbound || 0)+1;
    if(peer.outbound>64){this.close(id);continue;}
    peer.wire.write({kind:'event',type,data}).catch(()=>this.close(id)).finally(()=>peer.outbound--);
  }}
  close(id){const peer=this.peers.get(id);if(!peer)return;this.peers.delete(id);Promise.resolve(peer.pc.close()).catch(()=>{});}
  stop(){clearInterval(this.timer);for(const id of this.peers.keys())this.close(id);}
}

export async function runConnectorNode({app,node,config,state,version}){
  const port=await availablePort(),base='http://127.0.0.1:'+port;
  // A single local Relay owns receipts, queues and Codex. Both routes reach it.
  const service=supervise(node,[path.join(app,'server.mjs')],{cwd:app,windowsHide:true,stdio:['pipe','inherit','inherit'],env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_EXECUTION_NODE:'1',CODEX_RELAY_NO_EMBEDDED:'',CODEX_RELAY_LOCAL_DEVICE_ID:config.id,CODEX_RELAY_LOCAL_DEVICE_NAME:config.name,CODEX_RELAY_DATA_DIR:state,CODEX_WORKSPACE:config.cwd,CODEX_RELAY_TOKEN:config.token,CODEX_RELAY_RELEASE_ID:version,CODEX_RELAY_PARENT_PIPE:'1'}});
  const peers=new ConnectorPeers({base,deviceId:config.id}),abort=new AbortController();let closing=false;
  const headers={'content-type':'application/json','x-codex-relay-token':config.token};
  const post=async payload=>{const response=await fetch(config.server+'/api/runner/'+config.id+'/events',{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(10_000)});if(!response.ok)throw new Error('中转授权失效 '+response.status);};
  const delay=()=>new Promise(resolve=>setTimeout(resolve,1500));
  const replay=async()=>{const result=await localRequest(base,{path:'/api/bootstrap'});if(result.status!==200)throw new Error('本地服务未就绪');await post({type:'device_snapshot',snapshot:JSON.parse(Buffer.from(result.body,'base64'))});};
  const events=(async()=>{while(!closing){try{await consumeSse(base+'/api/events',{},async(type,data)=>{peers.event(type,data);await post(type==='snapshot' ? {type:'device_snapshot',snapshot:data} : {type:'device_event',eventType:type,data});},abort.signal);}catch{/* Reopen with a full snapshot after an upstream gap. */}if(!closing)await delay();}})();
  const commands=(async()=>{while(!closing){try{
    const query=new URLSearchParams({name:config.name,cwd:config.cwd,platform:'Windows · 直连',version,executionRelay:'1'});
    await consumeSse(config.server+'/api/runner/'+config.id+'/commands?'+query,headers,async(type,message)=>{
      if(type==='heartbeat'){await post({type:'heartbeat'});return;}
      if(message.type!=='deviceGateway'){if(message.type==='readCatalog' || message.type==='listThreads')await replay();return;}
      // Do not block the upstream SSE reader while answering a long API request.
      (async()=>{let result,error;try{
        if(message.action==='http')result=await localRequest(base,message.request);
        else if(message.action==='offer')result=await peers.offer(message);
        else if(message.action==='lease')result=peers.lease(message.peerId);
        else if(message.action==='close'){peers.close(message.peerId);result={ok:true};}
        else throw new Error('不支持的连接操作');
      }catch(value){error=value.message;}await post({type:'gateway_reply',requestId:message.requestId,result,error}).catch(()=>{});})().catch(()=>{});
    },abort.signal);
  }catch{}if(!closing)await delay();}})();
  function stop(){if(closing)return;closing=true;abort.abort();peers.stop();service.stop();}
  process.once('SIGINT',stop);process.once('SIGTERM',stop);process.stdin.resume();process.stdin.once('end',stop);
  await Promise.all([events,commands]);stop();
}
