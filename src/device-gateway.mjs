import crypto from 'node:crypto';

// Only execution APIs may cross the peer link. Administrative APIs stay on the hub.
export function executionPath(value,method='GET') {
  if(typeof value!=='string' || value.length>8000 || !value.startsWith('/api/') || value.includes('\\'))return false;
  const url=new URL(value,'http://localhost');
  if(url.origin!=='http://localhost' || /%(?:2f|5c|2e)/i.test(url.pathname))return false;
  const p=url.pathname;
  return /^(?:GET|HEAD|POST|PATCH)$/.test(method) && (
    /^\/api\/(?:bootstrap|events|projects|sessions|uploads)$/.test(p) ||
    /^\/api\/deliveries\/[a-zA-Z0-9_-]{16,80}$/.test(p) ||
    /^\/api\/uploads\/[a-f0-9-]{36}(?:\/status)?$/.test(p) ||
    /^\/api\/devices\/[^/]+\/(?:catalog(?:\/refresh)?|performance|usage|history-usage|sync|uploads\/[a-f0-9-]{36}(?:\/status)?)$/.test(p) ||
    /^\/api\/sessions\/[^/]+\/(?:history|read|media|turns|retry|interrupt|questions\/[^/]+\/answers|messages\/[^/]+\/edit|queued\/[^/]+\/(?:delete|withdraw|steer|send))$/.test(p) ||
    /^\/api\/sessions\/[^/]+\/preview\/[A-Za-z0-9_-]+\/.+$/.test(p) ||
    /^\/api\/approvals\/[^/]+$/.test(p));
}

export class DeviceGateway {
  constructor({send,timeout=25_000}){this.send=send;this.timeout=timeout;this.pending=new Map();this.peers=new Map();}
  call(deviceId,action,payload={}){
    const requestId=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('执行设备响应超时；发送结果需核对，输入已保留。'));},this.timeout);
      this.pending.set(requestId,{deviceId,resolve,reject,timer});
      try{this.send(deviceId,{type:'deviceGateway',requestId,action,...payload});}
      catch(error){clearTimeout(timer);this.pending.delete(requestId);reject(error);}
    });
  }
  reply(deviceId,payload){
    const request=this.pending.get(payload.requestId);
    if(!request || request.deviceId!==deviceId)return false;
    this.pending.delete(payload.requestId);clearTimeout(request.timer);
    payload.error ? request.reject(new Error(payload.error)) : request.resolve(payload.result);return true;
  }
  disconnect(deviceId){
    for(const [id,item] of this.pending)if(item.deviceId===deviceId){clearTimeout(item.timer);this.pending.delete(id);item.reject(new Error('执行设备连接中断；发送结果需核对，输入已保留。'));}
  }
  close(){for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('控制服务已停止'));}this.pending.clear();}
}
