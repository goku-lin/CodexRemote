import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberDesktopEvent,mergeDesktopHistory} from '../src/live-desktop-events.mjs';
import {approvalResult,validateNativeResponse} from '../public/native-requests.js';
import {turnControls,turnInput} from '../public/turn-controls.js';

test('after a queue overflow, partial deltas cannot replace the complete history or final item',()=>{
  const session={events:[],liveResyncIds:new Set(['reply'])};
  const event=(method,params,at)=>({type:'codex',message:{method,params:{threadId:'original',turnId:'t',...params}},at});
  rememberDesktopEvent(session,event('item/agentMessage/delta',{itemId:'reply',delta:'只有后半段'},3));
  assert.equal(session.liveItems.size,0);
  const incoming=[event('item/completed',{item:{id:'reply',type:'agentMessage',text:'完整的历史内容'}},2)];
  mergeDesktopHistory(session,incoming,[{id:'t',status:'inProgress'}]);
  assert.equal(incoming[0].message.params.item.text,'完整的历史内容');
  assert.ok(session.liveResyncIds.has('reply'));
  rememberDesktopEvent(session,event('item/completed',{item:{id:'reply',type:'agentMessage',text:'完整的最终回答'}},4));
  assert.ok(!session.liveResyncIds.has('reply'));
  assert.equal(session.liveItems.get('reply').message.params.item.text,'完整的最终回答');
});

test('lagging history cannot erase streamed text; completed history replaces the overlay without duplicated deltas',()=>{
  const session={events:[],liveTurn:{id:'t',status:'inProgress',startedAt:1,at:1}};
  const event=(method,params,at)=>({type:'codex',message:{method,params:{threadId:'original',turnId:'t',...params}},at});
  rememberDesktopEvent(session,event('item/started',{item:{id:'reply',type:'agentMessage',text:''}},2));
  rememberDesktopEvent(session,event('item/agentMessage/delta',{itemId:'reply',delta:'你好'},3));
  rememberDesktopEvent(session,event('item/agentMessage/delta',{itemId:'reply',delta:'，继续'},4));
  const incoming=[event('item/completed',{item:{id:'reply',type:'agentMessage',text:'你好'}},3)],turns=[{id:'t',status:'inProgress'}];
  mergeDesktopHistory(session,incoming,turns);
  assert.equal(incoming.length,1);assert.equal(incoming[0].message.params.item.text,'你好，继续');
  rememberDesktopEvent(session,event('item/completed',{item:{id:'reply',type:'agentMessage',text:'你好，继续',phase:'final_answer'}},5));
  const caughtUp=[event('item/completed',{item:{id:'reply',type:'agentMessage',text:'你好，继续'}},5)];
  mergeDesktopHistory(session,caughtUp,[{id:'t',status:'completed'}]);
  assert.equal(session.liveItems.size,0);assert.equal(caughtUp.length,1);
});

test('live updates preserve authoritative history positions instead of replacing them with notification times',()=>{
  const session={events:[]};
  const event=(id,at,text)=>({type:'codex',at,message:{method:'item/completed',params:{turnId:'t',item:{id,type:'agentMessage',text,at}}}});
  rememberDesktopEvent(session,event('ask',90000,'Live question'));
  const incoming=[event('ask',1001,'Question'),event('reply',1002,'After answer')];
  mergeDesktopHistory(session,incoming,[{id:'t',status:'inProgress'}]);
  incoming.sort((a,b)=>a.at-b.at);
  assert.deepEqual(incoming.map(value=>value.message.params.item.id),['ask','reply']);
  assert.equal(incoming[0].message.params.item.at,1001);
  assert.equal(incoming[0].message.params.item.text,'Live question');
});

test('snapshot reload keeps image groups between their surrounding streamed assistant messages',()=>{
  const session={events:[]};
  const event=(id,type,at,extra={})=>({type:'codex',at,message:{method:'item/completed',params:{turnId:'images',item:{id,type,at,...extra}}}});
  const incoming=[event('text-a','agentMessage',1001,{text:'First'}),
    event('image-a','imageView',1002,{images:[{ref:'D:/a.png'}]}),
    event('text-b','agentMessage',1003,{text:'Second'}),
    event('image-b','imageView',1004,{images:[{ref:'D:/b.png'}]}),
    event('text-c','agentMessage',1005,{text:'Third'})];
  for(const [index,entry] of incoming.entries())rememberDesktopEvent(session,{...entry,at:90000+index,message:{...entry.message,params:{...entry.message.params,item:{...entry.message.params.item,at:90000+index,...(entry.message.params.item.type==='agentMessage'?{text:'Updated '+index}:{images:[{ref:'D:/updated-'+index+'.png'}]})}}}});
  mergeDesktopHistory(session,incoming,[{id:'images',status:'inProgress'}]);
  incoming.sort((a,b)=>a.at-b.at);
  assert.deepEqual(incoming.map(entry=>entry.message.params.item.id),['text-a','image-a','text-b','image-b','text-c']);
  assert.deepEqual(incoming.map(entry=>entry.message.params.item.at),[1001,1002,1003,1004,1005]);
  assert.equal(incoming[1].message.params.item.images[0].ref,'D:/updated-1.png');
});

test('reload before history catches up keeps an image at its first observed position',()=>{
  const session={events:[]};
  const event=(method,id,type,at,extra={})=>({type:'codex',at,message:{method,params:{turnId:'lagging',item:{id,type,...extra}}}});
  rememberDesktopEvent(session,event('item/started','picture','imageView',2000,{images:[{ref:'D:/a.png'}]}));
  rememberDesktopEvent(session,event('item/completed','after','agentMessage',3000,{text:'图片之后的说明'}));
  rememberDesktopEvent(session,event('item/completed','picture','imageView',4000,{images:[{ref:'D:/a.png'}]}));
  const incoming=[event('item/completed','before','agentMessage',1000,{text:'图片之前的说明'})];
  mergeDesktopHistory(session,incoming,[{id:'lagging',status:'inProgress'}]);
  incoming.sort((a,b)=>a.at-b.at);
  assert.deepEqual(incoming.map(entry=>entry.message.params.item.id),['before','picture','after']);
  assert.equal(incoming[1].message.params.item.at,2000);
  assert.equal(session.liveItems.get('picture').at,4000,'snapshot freshness still uses the latest notification time');
});

test('persisted command completion retires a stale running overlay even while the turn keeps executing',()=>{
  const event=(method,item,at)=>({type:'codex',message:{method,params:{threadId:'thread',turnId:'t',item}},at});
  for(const status of ['completed','failed','interrupted']){
    const session={events:[]};
    rememberDesktopEvent(session,event('item/started',{id:'cmd',type:'commandExecution',command:'check'},1000));
    rememberDesktopEvent(session,{type:'codex',message:{method:'item/commandExecution/outputDelta',params:{threadId:'thread',turnId:'t',itemId:'cmd',delta:'partial'}},at:1500});
    const complete=event('item/completed',{id:'cmd',type:'commandExecution',status,startedAt:1000,completedAt:2500,durationMs:1500,aggregatedOutput:'final result'},2500);
    const incoming=[complete],turns=[{id:'t',status:'inProgress',activity:{id:'cmd',kind:'commandExecution',status:'inProgress'}}];
    mergeDesktopHistory(session,incoming,turns);
    assert.equal(incoming[0],complete);assert.equal(incoming[0].message.params.item.status,status);
    assert.equal(session.liveItems.size,0);assert.equal(turns[0].status,'inProgress');assert.equal(turns[0].activity.status,status);
    assert.equal(turns[0].activity.durationMs,1500);
  }
});

test('a history snapshot that still marks the command running keeps newer streamed output',()=>{
  const session={events:[]};
  rememberDesktopEvent(session,{at:2000,message:{method:'item/commandExecution/outputDelta',params:{threadId:'thread',turnId:'t',itemId:'cmd',delta:'new output'}}});
  const incoming=[{at:1000,message:{method:'item/completed',params:{turnId:'t',item:{id:'cmd',type:'commandExecution',status:'inProgress',aggregatedOutput:''}}}}];
  mergeDesktopHistory(session,incoming,[{id:'t',status:'inProgress'}]);
  assert.equal(incoming[0].message.params.item.status,'inProgress');assert.equal(incoming[0].message.params.item.aggregatedOutput,'new output');assert.equal(session.liveItems.size,1);
});

test('permissions grant exactly requested access; approval choices and form answers are validated',()=>{
  const request={method:'item/permissions/requestApproval',params:{permissions:{network:{enabled:true}}}};
  const granted=approvalResult(request,'accept');
  validateNativeResponse(request,granted);
  assert.deepEqual(granted,{permissions:{network:{enabled:true}},scope:'turn'});
  assert.throws(()=>validateNativeResponse(request,{permissions:{fileSystem:{write:['C:/']}},scope:'session'}));
  const command={method:'item/commandExecution/requestApproval',params:{availableDecisions:['accept','decline']}};
  assert.throws(()=>approvalResult(command,'acceptForSession'));
  assert.throws(()=>validateNativeResponse(command,{decision:'accept',extra:'injected'}));
  const form={method:'mcpServer/elicitation/request',params:{mode:'form',requestedSchema:{type:'object',required:['confirm'],properties:{confirm:{type:'boolean'}}}}};
  assert.deepEqual(approvalResult(form,'accept',{confirm:true}),{action:'accept',content:{confirm:true}});
  assert.throws(()=>approvalResult(form,'accept',{confirm:'yes'}));
  assert.deepEqual(approvalResult(form,'cancel'),{action:'cancel'});
});

test('running input enters a waiting queue with settings reserved for its next turn',()=>{
  const session={status:'running',activeTurnId:'t',executionOwner:'desktop',controls:{steer:true,interrupt:true}};
  assert.deepEqual(turnControls(session),{steer:true,interrupt:true});
  assert.deepEqual(turnInput(session,'追加',['image'],{model:'different',permission:'danger-full-access'}),{text:'追加',attachments:['image'],mode:'queue',expectedTurnId:'t',model:'different',permission:'danger-full-access'});
  assert.deepEqual(turnControls(session,false),{steer:false,interrupt:false});
  assert.deepEqual(turnControls({...session,status:'interrupting'}),{steer:false,interrupt:false});
});
