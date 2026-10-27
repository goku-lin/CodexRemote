import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {contextSelections,contextInput,contextFromText,referencedMessages} from '../public/context-state.js';
import {ComposerRequests,goalChange,validatedContext,runComposerCommand} from '../src/composer-context.mjs';

test('native skills and apps keep structured input; chat excerpts are bounded and round-trip as reference chips',()=>{
  const selections=[{kind:'skill',name:'review',path:'/skills/review/SKILL.md'},
    {kind:'app',name:'Docs',path:'app://docs'}, {kind:'file',name:'main.js',path:'/project/main.js'},
    {kind:'chat',name:'Other chat',id:'other'}];
  const events=Array.from({length:20},(_,i)=>({id:String(i),type:'user_message',text:'x'.repeat(4000)}));
  events.push({type:'codex',message:{method:'item/completed',params:{item:{id:'last',type:'agentMessage',text:'<script>reference</script>'}}}});
  const input=contextInput('Review these',selections,()=>({title:'Other chat',threadId:'original-other',events}));
  assert.deepEqual(input.slice(1),[{type:'skill',name:'review',path:'/skills/review/SKILL.md'},{type:'mention',name:'Docs',path:'app://docs'}]);
  assert.match(input[0].text,/\$review/);assert.doesNotMatch(input[0].text,/<script>/);
  assert.deepEqual(contextFromText(input[0].text),selections);
  assert.equal(referencedMessages(events).length,6);assert.ok(referencedMessages(events).every(item=>item.text.length<=3000));
  assert.throws(()=>contextInput('x',[{kind:'chat',name:'missing',id:'x'}],()=>null),/不可访问/);
  assert.deepEqual(contextFromText('<relay_context>bad JSON</relay_context>'),[]);
});

test('reference validation rejects hidden/cross-device chats, unlisted skills/apps and file traversal',()=>{
  const session={deviceId:'local',cwd:path.resolve('workspace')},sessions=new Map([['other',{deviceId:'other'}],['hidden',{deviceId:'local',hidden:true}]]);
  for(const id of ['other','hidden','missing'])assert.throws(()=>validatedContext({context:[{kind:'chat',name:'chat',id}]},session,sessions),/不可访问/);
  for(const kind of ['skill','app'])assert.throws(()=>validatedContext({context:[{kind,name:'Fake',path:'/fake'}]},session,sessions,{}),/重新选择/);
  assert.throws(()=>validatedContext({context:[{kind:'file',name:'secret',path:path.resolve('outside.txt')}]},session,sessions),/当前项目/);
  const context=[{kind:'file',name:'main',path:path.resolve('workspace/main.js')}];assert.deepEqual(validatedContext({context},session,sessions),context);
  assert.throws(()=>contextSelections(Array.from({length:9},()=>context[0])),/最多/);
  assert.throws(()=>contextSelections([{kind:'file',name:'x',path:'abc\nsecret'}]),/地址/);
});

test('goal changes require explicit supported actions and never invent or reset budgets for pause/resume',()=>{
  assert.deepEqual(goalChange({action:'pause'}),{method:'thread/goal/set',params:{origin:'user',status:'paused'}});
  assert.deepEqual(goalChange({action:'resume'}),{method:'thread/goal/set',params:{origin:'user',status:'active'}});
  assert.deepEqual(goalChange({action:'set',objective:'Finish tests',tokenBudget:5000}),{method:'thread/goal/set',params:{origin:'user',status:'active',objective:'Finish tests',tokenBudget:5000}});
  assert.throws(()=>goalChange({action:'set',objective:' '}),/目标/);
  for(const budget of [0,-1,1.5,Infinity])assert.throws(()=>goalChange({action:'set',objective:'x',tokenBudget:budget}),/预算/);
  assert.throws(()=>goalChange({action:'complete'}),/未知/);
});

test('old desktop connections expose read-only goals; supported hosts receive actual goal RPCs without starting a turn',async()=>{
  const calls=[],native={capabilities:{},refreshConnection:async()=>{},request:async(method,params)=>{calls.push({native:true,method,params});return {goal:{status:'paused'}};}};
  const rpc=async(session,method,params)=>{calls.push({session,method,params});return {goal:{objective:'Existing goal',tokensUsed:25}};};
  const command={sessionId:'s',threadId:'original',executionOwner:'desktop',operation:'goalGet'};
  const old=await runComposerCommand(command,{rpc,native});assert.equal(old.canControl,false);assert.equal(old.goal.tokensUsed,25);
  await assert.rejects(runComposerCommand({...command,operation:'goalChange',change:goalChange({action:'pause'})},{rpc,native}),/尚未开放/);
  assert.equal(calls.length,1);native.capabilities.goals=true;
  const result=await runComposerCommand({...command,operation:'goalChange',change:goalChange({action:'pause'})},{rpc,native});assert.equal(result.canControl,true);
  assert.deepEqual(calls.at(-1),{native:true,method:'thread/goal/set',params:{threadId:'original',origin:'user',status:'paused'}});
  assert.ok(calls.every(call=>!['turn/start','thread/resume','thread/start'].includes(call.method)));
});

test('catalog operations scope skills and files to the project and filter inaccessible apps',async()=>{
  const calls=[],rpc=async(_s,method,params)=>{calls.push({method,params});return method==='skills/list'?{data:[{skills:[{name:'ok',path:'/skill'},{name:'disabled',path:'/disabled',enabled:false}]}]}:method==='app/installed'?{apps:[{id:'ok',runtimeName:'Ok',enabled:true,callable:true},{id:'no',enabled:false,callable:false}]}:{files:[{root:path.resolve('project'),path:'main.js'}]};};
  const command={sessionId:'s',threadId:'t',cwd:path.resolve('project')};
  assert.equal((await runComposerCommand({...command,operation:'skills'},{rpc})).items.length,1);
  assert.equal((await runComposerCommand({...command,operation:'apps'},{rpc})).items[0].path,'app://ok');
  assert.equal((await runComposerCommand({...command,operation:'files',query:'main'},{rpc})).items[0].path,path.resolve('project/main.js'));
  assert.deepEqual(calls.at(-1).params.roots,[command.cwd]);
});

test('composer request correlation is device scoped, bounded and times out without replay',async()=>{
  const queued=[],broker=new ComposerRequests({queue:(device,command)=>queued.push({device,command}),max:1,timeout:20});
  const waiting=broker.request('a',{operation:'skills'});
  await assert.rejects(broker.request('a',{}),/请求较多/);
  assert.equal(broker.reply('b',{requestId:queued[0].command.requestId,result:{bad:true}}),false);
  broker.reply('a',{requestId:queued[0].command.requestId,result:{items:[]}});assert.deepEqual(await waiting,{items:[]});
  await assert.rejects(broker.request('a',{}),/超时/);assert.equal(broker.pending.size,0);assert.equal(queued.length,2);
});
