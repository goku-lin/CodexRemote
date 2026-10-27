import crypto from 'node:crypto';
import path from 'node:path';
import {contextSelections,contextInput} from '../public/context-state.js';

export class ComposerRequests {
  constructor({queue,timeout=22000,max=32}){Object.assign(this,{queue,timeout,max});this.pending=new Map();}
  request(deviceId,command){
    if(this.pending.size>=this.max)return Promise.reject(new Error('请求较多，请稍后重试。'));
    return new Promise((resolve,reject)=>{
      const requestId=crypto.randomUUID(),timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('读取或操作超时，请刷新状态后核对结果。'));},this.timeout);
      this.pending.set(requestId,{deviceId,timer,resolve,reject});
      try{this.queue(deviceId,{...command,type:'composerContext',requestId});}catch(error){clearTimeout(timer);this.pending.delete(requestId);reject(error);}
    });
  }
  reply(deviceId,payload){const request=this.pending.get(payload.requestId);if(!request || request.deviceId!==deviceId)return false;
    this.pending.delete(payload.requestId);clearTimeout(request.timer);payload.error ? request.reject(new Error(payload.error)) : request.resolve(payload.result);return true;}
}
export function goalChange(body) {
  if(!['set','pause','resume','clear'].includes(body.action))throw new Error('未知目标操作。');
  if(body.action==='clear')return {method:'thread/goal/clear',params:{origin:'user'}};
  const params={origin:'user',status:body.action==='pause' ? 'paused' : 'active'};
  if(body.action==='set'){
    if(typeof body.objective!=='string' || !body.objective.trim() || body.objective.trim().length>4000)throw new Error('目标请输入 1～4000 个字符。');
    params.objective=body.objective.trim();
    if(body.tokenBudget!=null){if(!Number.isSafeInteger(body.tokenBudget) || body.tokenBudget<=0)throw new Error('token 预算须为正整数。');params.tokenBudget=body.tokenBudget;}
  }
  return {method:'thread/goal/set',params};
}
export function validatedContext(body,session,sessions,catalog) {
  const selected=contextSelections(body.context || []);
  for(const item of selected){
    if(item.kind==='chat'){const chat=sessions.get(item.id);if(!chat || chat.hidden || chat.archived || chat.deviceId!==session.deviceId)throw new Error('引用对话不可访问。');}
    if(item.kind==='skill' && !catalog?.skills?.some(skill=>skill.path===item.path && skill.name===item.name))throw new Error('请从当前项目的技能列表重新选择技能。');
    if(item.kind==='app' && !catalog?.apps?.some(app=>app.path===item.path && app.name===item.name))throw new Error('请从当前可用应用中重新选择引用。');
    if(item.kind==='file'){
      const relative=path.relative(path.resolve(session.cwd),path.resolve(item.path));
      if(!relative || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))throw new Error('只能引用当前项目内的文件。');
    }
  }
  return selected;
}
export const selectedContextInput=(text,selected,sessions)=>contextInput(text,selected,id=>sessions.get(id));
export function composerError(error){const message=String(error?.message || '读取失败');if(/403|<html|<!doctype/i.test(message))return '应用或服务暂时拒绝访问，请稍后重试。';return message.length>600 ? '输入辅助接口暂不可用，请稍后重试。' : message;}

export async function runComposerCommand(command,{rpc,native}) {
  const call=(method,params)=>rpc(command.sessionId,method,params);
  if(command.operation==='skills'){
    const result=await call('skills/list',{cwds:[command.cwd],forceReload:false});
    return {items:(result.data || []).flatMap(group=>group.skills || []).filter(skill=>skill.enabled!==false).map(skill=>({kind:'skill',name:skill.name,path:skill.path,description:String(skill.interface?.shortDescription || skill.description || '').slice(0,500)})).filter(skill=>skill.path).slice(0,300)};
  }
  if(command.operation==='files'){
    if(!command.query?.trim())return {items:[]};
    const result=await call('fuzzyFileSearch',{query:command.query.slice(0,160),roots:[command.cwd]});
    return {items:(result.files || []).slice(0,60).map(file=>({kind:'file',name:path.basename(file.path),path:path.resolve(file.root || command.cwd,file.path),description:file.path}))};
  }
  if(command.operation==='apps'){
    // The auxiliary reader must not resume/acquire a Desktop-owned thread just
    // to discover apps. Read global access; the destination enforces its policy.
    const result=await call('app/installed',{forceRefresh:false});
    return {items:(result.apps || []).filter(app=>app.enabled && app.callable).map(app=>({kind:'app',name:app.runtimeName || app.id,path:'app://'+app.id,description:'已启用的应用'}))};
  }
  const owned=command.executionOwner==='desktop';
  if(command.operation==='goalGet'){
    if(owned){await native.refreshConnection();if(native.capabilities.goals){const result=await native.request('thread/goal/get',{threadId:command.threadId});return {...result,canControl:true};}}
    const result=await call('thread/goal/get',{threadId:command.threadId});return {...result,canControl:!owned};
  }
  if(command.operation==='goalChange'){
    if(owned){await native.refreshConnection();if(!native.capabilities.goals)throw new Error('当前桌面连接尚未开放目标控制，可以查看目标状态。');return {...await native.request(command.change.method,{...command.change.params,threadId:command.threadId}),canControl:true};}
    return {...await call(command.change.method,{...command.change.params,threadId:command.threadId}),canControl:true};
  }
  throw new Error('不支持的输入辅助操作。');
}
