import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeDesktopHost} from '../src/native-desktop-channel.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(read,predicate) {
  for(let i=0;i<300;i++){const value=await read();if(predicate(value))return value;await pause(20);}
  throw new Error('Expected native control state did not arrive');
}

test('browser → Runner → original Desktop supports steer, actual question/approval responses, live progress and interruption',{timeout:25000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-native-controls-'));
  const children=[];let host;
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;}
    await host?.close();
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});
  });
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const base=`http://127.0.0.1:${port}`,endpointFile=path.join(directory,'native-desktop.json'),core=[],desktop=[];
  const notify=(method,params)=>host.fromCore({method,params:{threadId:'original',turnId:'live',...params}});
  let coreStatus='active',goal=null;
  host=new NativeDesktopHost({endpointFile,writeDesktop:message=>desktop.push(message),writeCore:message=>{
    core.push(message);
    if(message.method==='turn/steer')host.fromCore({id:message.id,result:{turnId:'live'}});
    else if(message.method==='turn/interrupt'){
      coreStatus='idle';
      host.fromCore({id:message.id,result:{}});
      notify('turn/completed',{turn:{id:'live',status:'interrupted'}});
    }else if(message.result && message.id!=null)notify('serverRequest/resolved',{requestId:message.id});
    else if(message.method==='thread/read')host.fromCore({id:message.id,result:{thread:{id:'original',status:{type:coreStatus}}}});
    else if(message.method==='thread/goal/get')host.fromCore({id:message.id,result:{goal}});
    else if(message.method==='thread/goal/set'){
      goal={...goal,...message.params,tokensUsed:goal?.tokensUsed || 0};host.fromCore({id:message.id,result:{goal}});
    }else if(message.method==='thread/goal/clear'){goal=null;host.fromCore({id:message.id,result:{}});}
    else if(message.method==='turn/start'){
      coreStatus='active';host.fromCore({id:message.id,result:{turn:{id:'retried',status:'inProgress'}}});
      notify('turn/started',{turn:{id:'retried',status:'inProgress'}});
    }
  }});
  await host.listen();host.fromDesktop({method:'initialized'});notify('turn/started',{turn:{id:'live',status:'inProgress'}});
  const fakeCli=path.join(directory,'codex.mjs');await mkdir(path.join(directory,'sessions'));
  await writeFile(fakeCli,`import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);if(m.id==null)return;
    const thread={id:'original',name:'Desktop fixture',cwd:process.env.CODEX_RELAY_CWD,status:{type:'active'},createdAt:1,updatedAt:2,turns:[{id:'live',status:'inProgress',items:[]}]};
    const result=m.method==='thread/list'?{data:[thread]}:m.method==='thread/read'?{thread}:m.method==='skills/list'?{data:[{skills:[{name:'fixture-skill',path:process.env.CODEX_RELAY_CWD+'/SKILL.md',enabled:true}]}]}:m.method==='model/list'?{data:[{model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[]}]}:{};
    process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`);
  const env={...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_TOKEN:'fixture-token',CODEX_RELAY_DATA_DIR:directory,CODEX_HOME:directory,CODEX_RELAY_PARENT_PIPE:'0',CODEX_APP_TOOLS_PIPE_PATH:'',CODEX_THREAD_ID:'',CODEX_RELAY_NATIVE_ENDPOINT:endpointFile,CODEX_BIN:process.execPath,CODEX_ARGS_JSON:JSON.stringify([fakeCli]),CODEX_SESSIONS_DIR:path.join(directory,'sessions'),CODEX_RELAY_CWD:directory,CODEX_RELAY_SERVER:base};
  const server=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env,windowsHide:true});children.push(server);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Isolated server startup timed out')),5000);server.once('error',reject);server.stdout.on('data',chunk=>{if(String(chunk).includes('listening')){clearTimeout(timer);resolve();}});});
  const runner=spawn(process.execPath,['runner.mjs'],{cwd:new URL('..',import.meta.url),env,windowsHide:true});children.push(runner);
  runner.stderr.on('data',chunk=>t.diagnostic(String(chunk)));
  const get=async url=>(await fetch(base+url)).json();
  const post=(url,body)=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json','x-codex-relay-token':'fixture-token'},body:JSON.stringify(body)});
  const session=await waitFor(async()=>(await get('/api/sessions')).sessions[0],session=>session?.executionOwner==='desktop' && session?.controls?.steer && session?.historyLoaded);
  assert.equal(session.threadId,'original');assert.equal(session.executionOwner,'desktop');assert.equal(session.controls.interrupt,true);
  const url=`/api/sessions/${session.id}/turns`,historyUrl=`/api/sessions/${session.id}/history`;
  const body={text:'只检查原来的问题',mode:'steer',expectedTurnId:'live',model:'do-not-change',permission:'danger-full-access',requestId:'steer0123456789abcdef'};
  const replies=await Promise.all([post(url,body),post(url,body)]);
  assert.deepEqual(replies.map(reply=>reply.status),[202,202]);
  await waitFor(async()=>core.filter(message=>message.method==='turn/steer'),list=>list.length===1);
  await waitFor(()=>get('/api/deliveries/'+body.requestId),receipt=>receipt.state==='accepted');
  assert.deepEqual(core.find(message=>message.method==='turn/steer').params,{threadId:'original',expectedTurnId:'live',input:[{type:'text',text:body.text}]});
  assert.ok(!core.some(message=>['turn/start','thread/start','thread/fork','tools/call'].includes(message.method)));
  assert.equal((await post(url,{text:'stale',mode:'steer',expectedTurnId:'old'})).status,409);

  // Multi-megabyte images must not travel in the bounded command SSE stream.
  const bytes=Buffer.alloc(2*1024*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const dataUrl='data:image/png;base64,'+bytes.toString('base64'),uploadId='12345678-1234-1234-1234-123456789abc';
  const uploadBody={requestId:uploadId,name:'large-fixture.png',dataUrl};
  const firstUpload=await post('/api/uploads',uploadBody);assert.equal(firstUpload.status,201);
  assert.equal((await post('/api/uploads',uploadBody)).status,201);
  assert.equal((await post('/api/uploads',{...uploadBody,name:'changed.png'})).status,409);
  const uploadStatus=await get(`/api/uploads/${uploadId}/status`);assert.equal(uploadStatus.found,true);assert.ok(!uploadStatus.image.dataUrl);
  assert.equal((await get('/api/uploads/00000000-0000-0000-0000-000000000000/status')).found,false);
  assert.equal((await fetch(base+`/api/runner/local/uploads/${uploadId}`)).status,401);
  const imageBody={text:'查看大图片',attachments:[uploadId],mode:'steer',expectedTurnId:'live',requestId:'image0123456789abcdef'};
  assert.equal((await post(url,imageBody)).status,202);
  await waitFor(()=>get('/api/deliveries/'+imageBody.requestId),receipt=>receipt.state==='accepted');
  const imageMessage=core.find(message=>message.method==='turn/steer' && message.params.input.some(part=>part.type==='image'));
  assert.deepEqual(imageMessage.params.input,[{type:'text',text:imageBody.text},{type:'image',url:dataUrl}]);
  assert.equal(core.filter(message=>message.method==='turn/steer' && message.params.input.some(part=>part.type==='image')).length,1);

  notify('item/started',{item:{id:'reply',type:'agentMessage',text:'',phase:'commentary'}});
  notify('item/agentMessage/delta',{itemId:'reply',delta:'正在检查'});
  notify('item/agentMessage/delta',{itemId:'reply',delta:'原问题'});
  notify('item/started',{item:{id:'compact',type:'contextCompaction'}});
  await waitFor(()=>get(historyUrl),history=>history.events.some(event=>event.message?.params?.item?.id==='compact')).catch(async error=>{
    const snapshot=await get(historyUrl);t.diagnostic(JSON.stringify({nativeSubscriptions:[...host.peers].map(peer=>[...peer.threads]),coreReads:core.filter(message=>message.method==='thread/read').length,eventIds:snapshot.events.map(event=>({type:event.type,method:event.message?.method,item:event.message?.params?.item?.id})),session:(await get('/api/sessions')).sessions[0]}));throw error;
  });
  await post('/api/runner/local/events',{type:'thread_history',sessionId:session.id,threadId:'original',items:[{id:'reply',turnId:'live',role:'assistant',text:'正在'}],turns:[{id:'live',status:'inProgress',startedAt:1}]});
  let history=await get(historyUrl);
  assert.equal(history.events.find(event=>event.message?.params?.item?.id==='reply').message.params.item.text,'正在检查原问题');
  assert.ok(history.events.some(event=>event.message?.params?.item?.id==='compact'));

  host.fromCore({id:'question',method:'item/tool/requestUserInput',params:{threadId:'original',turnId:'live',itemId:'ask',isBlocking:true,questions:[{id:'connection',header:'连接',question:'选择连接方式',options:[{label:'Wi-Fi',description:'同一网络'}]}]}});
  await waitFor(async()=>(await get('/api/sessions')).sessions[0],session=>session.status==='waiting_input');
  const answerUrl=`/api/sessions/${session.id}/questions/ask/answers`;
  assert.equal((await post(answerUrl,{answers:{connection:'Wi-Fi'}})).status,202);
  await waitFor(()=>get(historyUrl),history=>history.events.some(event=>event.message?.params?.item?.id==='ask' && event.message.params.item.answerState==='answered'));
  assert.deepEqual(core.find(message=>message.id==='question').result,{answers:{connection:{answers:['Wi-Fi']}}});
  host.fromDesktop({id:'question',result:{answers:{connection:{answers:['桌面迟到回答']}}}});
  assert.equal(core.filter(message=>message.id==='question').length,1);
  assert.equal((await post(answerUrl,{answers:{connection:'重复'}})).status,409);

  host.fromCore({id:42,method:'item/commandExecution/requestApproval',params:{threadId:'original',turnId:'live',itemId:'cmd',command:'fixture check',availableDecisions:['accept','decline']}});
  history=await waitFor(()=>get(historyUrl),history=>history.events.some(event=>event.type==='approval_request' && event.request.id===42));
  const approval=history.events.findLast(event=>event.type==='approval_request').request;
  const approvalUrl='/api/approvals/'+encodeURIComponent(approval.key);
  assert.equal((await post(approvalUrl,{sessionId:session.id,decision:'acceptForSession'})).status,400);
  assert.equal((await post(approvalUrl,{sessionId:session.id,decision:'accept'})).status,202);
  await waitFor(()=>get(historyUrl),history=>history.events.some(event=>event.type==='approval_resolved' && event.requestId===42));
  assert.deepEqual(core.find(message=>message.id===42).result,{decision:'accept'});
  assert.equal((await post(approvalUrl,{decision:'accept'})).status,404);

  host.fromCore({id:'desktop-first',method:'item/tool/requestUserInput',params:{threadId:'original',turnId:'live',itemId:'desktop-ask',isBlocking:true,questions:[{id:'q',question:'选择？'}]}});
  await waitFor(async()=>(await get('/api/sessions')).sessions[0],session=>session.status==='waiting_input');
  host.fromDesktop({id:'desktop-first',result:{answers:{q:{answers:['桌面已答']}}}});
  await waitFor(()=>get(historyUrl),history=>history.events.some(event=>event.message?.params?.item?.id==='desktop-ask' && event.message.params.item.answerState==='resolved'));
  assert.equal((await post(`/api/sessions/${session.id}/questions/desktop-ask/answers`,{answers:{q:'手机迟到'}})).status,409);
  assert.equal(core.filter(message=>message.id==='desktop-first').length,1);

  assert.equal((await post(`/api/sessions/${session.id}/interrupt`,{turnId:'live'})).status,202);
  await waitFor(async()=>(await get('/api/sessions')).sessions[0],session=>session.status==='interrupted');
  assert.deepEqual(core.find(message=>message.method==='turn/interrupt').params,{threadId:'original',turnId:'live'});
  assert.ok(desktop.some(message=>message.method==='item/agentMessage/delta'),'Desktop still receives its unchanged stream');

  await post('/api/runner/local/events',{type:'thread_history',sessionId:session.id,threadId:'original',settings:{permission:'workspace-write'},items:[],turns:[{id:'live',status:'interrupted'}]});
  const full={text:'Use the selected permission',permission:'danger-full-access',requestId:'permissionfull0123456789'};
  assert.equal((await post(url,full)).status,202);
  await waitFor(()=>get('/api/deliveries/'+full.requestId),receipt=>receipt.state==='accepted');
  const fullTurn=core.filter(message=>message.method==='turn/start').at(-1);
  assert.equal(fullTurn.params.threadId,'original');assert.deepEqual(fullTurn.params.sandboxPolicy,{type:'dangerFullAccess'});assert.equal(fullTurn.params.approvalPolicy,'never');
  assert.equal((await get('/api/sessions')).sessions[0].nativePermission,'workspace-write','actual permission waits for a confirmed Desktop context');
  const starts=core.filter(message=>message.method==='turn/start').length;
  const readonly={text:'Use read-only on the next turn',mode:'queue',permission:'read-only',requestId:'permissionread0123456789'};
  assert.equal((await post(url,readonly)).status,202);
  assert.equal(core.filter(message=>message.method==='turn/start').length,starts,'queueing a permission never alters the running turn');
  coreStatus='idle';notify('turn/completed',{turn:{id:'retried',status:'completed'}});
  await waitFor(()=>get('/api/deliveries/'+readonly.requestId),receipt=>receipt.state==='accepted');
  const readTurn=core.filter(message=>message.method==='turn/start').at(-1);
  assert.equal(readTurn.params.threadId,'original');assert.deepEqual(readTurn.params.sandboxPolicy,{type:'readOnly'});assert.equal(readTurn.params.approvalPolicy,'on-request');
  await post('/api/runner/local/events',{type:'catalog',catalog:{requirements:{allowedSandboxModes:['read-only']},models:[{model:'fixture-next',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}});
  assert.equal((await post(url,{text:'Disallowed',mode:'queue',permission:'danger-full-access',requestId:'permissionreject0123456789'})).status,400);
  assert.equal(core.filter(message=>message.method==='turn/start').length,starts+1,'device requirements still reject a forbidden permission');
  assert.ok(!core.some(message=>['thread/start','thread/fork'].includes(message.method)));
  const skills=await get(`/api/sessions/${session.id}/context?kind=skills`);
  assert.equal(skills.items[0].name,'fixture-skill');
  const goalUrl=`/api/sessions/${session.id}/goal`;
  assert.equal((await get(goalUrl)).canControl,true);
  assert.equal((await post(goalUrl,{action:'set',objective:'Fixture goal only',tokenBudget:5000})).status,200);
  assert.equal((await get(goalUrl)).goal.objective,'Fixture goal only');
  assert.equal((await post(goalUrl,{action:'pause'})).status,200);
  assert.equal((await get(goalUrl)).goal.status,'paused');
  assert.equal(core.findLast(message=>message.method==='thread/goal/set').params.origin,'user');
  assert.equal((await post(goalUrl,{action:'clear'})).status,200);assert.equal((await get(goalUrl)).goal,null);
  const selected=skills.items.map(({description,...skill})=>skill);
  host.fromCore({method:'turn/started',params:{threadId:'original',turn:{id:'context-live'}}});
  await waitFor(async()=>(await get('/api/sessions')).sessions[0],value=>value.activeTurnId==='context-live');
  const skillSend={text:'Use this skill',mode:'steer',expectedTurnId:'context-live',context:selected,requestId:'skillcontext0123456789'};
  assert.equal((await post(url,skillSend)).status,202);
  await waitFor(()=>get('/api/deliveries/'+skillSend.requestId),receipt=>receipt.state==='accepted');
  const rich=core.findLast(message=>message.method==='turn/steer').params.input;
  assert.equal(rich[1].type,'skill');assert.equal(rich[1].path,skills.items[0].path);
  assert.match(rich[0].text,/\$fixture-skill/);

  // A browser Fast selection must reach the same Desktop thread through HTTP and Runner.
  await post('/api/runner/local/events',{type:'catalog',catalog:{models:[{model:'fixture-fast',supportedReasoningEfforts:[],serviceTiers:[{id:'priority',name:'Fast'}]}]}});
  coreStatus='idle';notify('turn/completed',{turn:{id:'context-live',status:'completed'}});
  await waitFor(async()=>(await get('/api/sessions')).sessions[0],value=>value.status==='done');
  const fast={text:'Fast next turn',model:'fixture-fast',serviceTier:'priority',requestId:'fastnative0123456789'};
  const fastResponse=await post(url,fast);assert.equal(fastResponse.status,202,await fastResponse.text());
  await waitFor(()=>get('/api/deliveries/'+fast.requestId),receipt=>receipt.state==='accepted');
  assert.equal(core.findLast(message=>message.method==='turn/start').params.serviceTier,'priority');
  assert.equal(core.findLast(message=>message.method==='turn/start').params.threadId,'original');
  coreStatus='idle';notify('turn/completed',{turn:{id:'retried',status:'completed'}});
  await waitFor(async()=>(await get('/api/sessions')).sessions[0],value=>value.status==='done');
  const standard={...fast,text:'Standard next turn',serviceTier:'default',requestId:'standardnative0123456789'};
  assert.equal((await post(url,standard)).status,202);
  await waitFor(()=>get('/api/deliveries/'+standard.requestId),receipt=>receipt.state==='accepted');
  assert.equal(core.findLast(message=>message.method==='turn/start').params.serviceTier,null);
});
