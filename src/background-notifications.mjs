import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {TaskNotices} from '../public/session-attention.js';
import {generateVAPIDKeys,sendNotification} from './push-runtime.mjs';

const labels={done:'本回合已完成',question:'有问题待回答',approval:'需要审批',failed:'任务执行失败',interrupted:'任务已中断'};
const providers=host=>host==='fcm.googleapis.com'||host==='web.push.apple.com'||host.endsWith('.push.services.mozilla.com')||host==='updates.push.services.mozilla.com'||host.endsWith('.notify.windows.com');
export function pushSubscription(value){
  if(!value||typeof value.endpoint!=='string'||value.endpoint.length>4096)throw new Error('推送订阅无效。');
  let url;try{url=new URL(value.endpoint);}catch{throw new Error('推送订阅无效。');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443'||!providers(url.hostname))throw new Error('当前浏览器的推送服务暂未接入，仍可使用页面内提醒。');
  const key=value.keys?.p256dh,auth=value.keys?.auth;
  if(typeof key!=='string'||typeof auth!=='string'||!/^[-_A-Za-z0-9]+=*$/.test(key)||!/^[-_A-Za-z0-9]+=*$/.test(auth)||Buffer.from(key,'base64url').length!==65||Buffer.from(auth,'base64url').length!==16)throw new Error('推送订阅密钥无效。');
  if(value.expirationTime!=null&&(!Number.isFinite(value.expirationTime)||value.expirationTime<=Date.now()))throw new Error('推送订阅已过期，请重新开启。');
  return {endpoint:url.href,expirationTime:value.expirationTime??null,keys:{p256dh:key,auth}};
}

export class BackgroundNotifications{
  constructor({directory,ownerActive=()=>true,subject=()=> 'https://codex-remote.invalid',send=sendNotification,now=Date.now,testDelay=10000,retryDelays=[5000,30000]}){
    Object.assign(this,{ownerActive,subject,send,now,testDelay,retryDelays});this.file=path.join(directory,'background-notifications.json');this.queue=[];this.running=0;
    try{this.data=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{this.data={keys:null,subscriptions:[],seen:[]};}
    if(!Array.isArray(this.data.subscriptions))this.data.subscriptions=[];
    this.tracker=new TaskNotices({getItem:()=>JSON.stringify(this.data.seen||[]),setItem:(_,value)=>{this.data.seen=JSON.parse(value);this.save();}});
  }
  save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
  active(row){return row.expiresAt>this.now()&&this.ownerActive(row.owner)&&(!row.subscription.expirationTime||row.subscription.expirationTime>this.now());}
  prune(){const next=this.data.subscriptions.filter(row=>this.active(row));if(next.length!==this.data.subscriptions.length){this.data.subscriptions=next;this.save();}}
  config(owner){
    this.prune();if(!this.data.keys){this.data.keys=generateVAPIDKeys();this.save();}
    return {revision:1,publicKey:this.data.keys.publicKey,subscriptions:this.data.subscriptions.filter(row=>row.owner===owner).length};
  }
  subscribe(owner,expiresAt,value){
    const subscription=pushSubscription(value);this.config(owner);
    const id=crypto.createHash('sha256').update(subscription.endpoint).digest('hex'),previous=this.data.subscriptions.find(row=>row.id===id);
    if(previous&&previous.owner!==owner&&JSON.stringify(previous.subscription.keys)!==JSON.stringify(subscription.keys))throw new Error('此推送订阅不属于当前浏览器。');
    if(!previous&&this.data.subscriptions.length>=50)throw new Error('后台提醒设备已达到上限，请先关闭不再使用的设备。');
    const row={...previous,id,owner,expiresAt,subscription};this.data.subscriptions=this.data.subscriptions.filter(item=>item.id!==id);this.data.subscriptions.push(row);this.save();return {enabled:true};
  }
  unsubscribe(owner,endpoint){this.data.subscriptions=this.data.subscriptions.filter(row=>!(row.owner===owner&&row.subscription.endpoint===endpoint));this.save();return {enabled:false};}
  row(owner,endpoint){const row=this.data.subscriptions.find(row=>row.owner===owner&&row.subscription.endpoint===endpoint&&this.active(row));if(!row)throw new Error('请先在当前设备开启后台提醒。');return row;}
  status(owner,endpoint){const row=this.data.subscriptions.find(row=>row.owner===owner&&row.subscription.endpoint===endpoint&&this.active(row));return {enabled:Boolean(row),acceptedAt:row?.acceptedAt||null,error:row?.error||null};}
  test(owner,endpoint){
    const row=this.row(owner,endpoint);if(row.lastTestAt&&this.now()-row.lastTestAt<15000)throw new Error('测试提醒已安排，请稍等再试。');
    row.lastTestAt=this.now();this.save();
    const timer=setTimeout(()=>this.enqueue(row,{title:'Codex · 后台提醒测试',body:'收到这条通知，说明测试提醒已送达。',tag:'codex-push-test',kind:'test'}),this.testDelay);timer.unref?.();
    return {scheduled:true,afterSeconds:Math.round(this.testDelay/1000)};
  }
  observe(sessions,{baseline=false}={}){
    const notices=this.tracker.observe(sessions,{baseline:baseline||!this.primed});this.primed=true;
    if(!notices.length)return;this.prune();
    for(const notice of notices){if(!labels[notice.kind])continue;for(const row of this.data.subscriptions)this.enqueue(row,{title:'Codex · '+labels[notice.kind],body:'点击查看对应对话。',tag:'codex-task-'+notice.sessionId,sessionId:notice.sessionId,kind:notice.kind});}
  }
  enqueue(row,payload,attempt=0){if(!this.active(row))return;if(this.queue.length>=200)this.queue.shift();this.queue.push({row,payload,attempt});this.pump();}
  pump(){
    while(this.running<4&&this.queue.length){const job=this.queue.shift();if(!this.data.subscriptions.includes(job.row)||!this.active(job.row))continue;this.running++;
      void this.deliver(job.row,job.payload,job.attempt).finally(()=>{this.running--;this.pump();});}
  }
  async deliver(row,payload,attempt=0){
    try{
      await this.send(row.subscription,JSON.stringify(payload),{TTL:3600,urgency:['question','approval'].includes(payload.kind)?'high':'normal',timeout:5000,vapidDetails:{subject:this.subject(),...this.data.keys}});
      row.acceptedAt=this.now();row.error=null;
    }catch(error){
      if([404,410].includes(error.statusCode))this.data.subscriptions=this.data.subscriptions.filter(item=>item!==row);
      else row.error=error.statusCode?'推送服务暂未接受通知（'+error.statusCode+'）':'推送服务暂时无法连接';
      if((!error.statusCode||error.statusCode===429||error.statusCode>=500)&&attempt<this.retryDelays.length){const retry=setTimeout(()=>this.enqueue(row,payload,attempt+1),this.retryDelays[attempt]);retry.unref?.();}
    }
    try{this.save();}catch{/* A failed status write must not interrupt conversation processing. */}
  }
}
