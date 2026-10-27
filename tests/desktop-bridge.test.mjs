import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopBridge } from '../src/desktop-bridge.mjs';
import { effectiveSettings, projectsForDevice } from '../public/composer-settings.js';
import { RolloutReader } from '../src/rollout.mjs';
import { questionReplies } from '../public/questions.js';

test('model defaults follow selection and a pending permission override stays separate from confirmed Desktop permission', () => {
  const catalog={defaultModel:'first',defaultEffort:'high',defaultPermission:'danger-full-access',models:[
    {model:'first',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},
    {model:'second',defaultReasoningEffort:'max',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'max'}]}],permissions:[{id:'workspace-write',label:'工作区访问'}]};
  const current=effectiveSettings(catalog,{model:'first',effort:'low',nativePermission:'workspace-write'},{});
  assert.equal(current.effort,'low');assert.equal(current.permission,'workspace-write');
  const changed=effectiveSettings(catalog,{model:'first',effort:'low'},{model:'second'});
  assert.equal(changed.model.model,'second');assert.equal(changed.effort,'max');
  assert.equal(effectiveSettings(catalog,{}, {model:'unavailable'}).model,undefined);
  const override=effectiveSettings(catalog,{executionOwner:'desktop',nativePermission:'workspace-write'},{permission:'danger-full-access'});
  assert.equal(override.permission,'danger-full-access');assert.equal(override.permissionPending,true);
  assert.deepEqual(projectsForDevice([{id:'a',deviceId:'one'},{id:'b',deviceId:'one',hidden:true},{id:'c',deviceId:'two'}],'one').map(item=>item.id),['a']);
});

test('rollout context reports the actual inherited permission independently of messages', async () => {
  const reader=new RolloutReader();
  reader.consume({type:'turn_context',payload:{model:'first',effort:'xhigh',sandbox_policy:{type:'workspace-write'}}});
  const history=await reader.read([]);
  assert.deepEqual(history.settings,{model:'first',effort:'xhigh',permission:'workspace-write'});
  assert.equal(history.messageCount,0);
});

test('desktop continuation targets the same thread, forwards model and strength, and surfaces native failures', async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'codex-relay-desktop-'));
  const script=path.join(directory,'mcp-fixture.mjs');const calls=path.join(directory,'calls.jsonl');
  await writeFile(script,`import readline from 'node:readline';import {appendFileSync} from 'node:fs';
    readline.createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);if(msg.id==null)return;
      let result={};if(msg.method==='tools/list')result={tools:[{name:'send_message_to_thread'}]};
      if(msg.method==='tools/call'){appendFileSync(process.env.RELAY_FIXTURE_CALLS,JSON.stringify(msg.params)+'\\n');
        result={content:[{type:'text',text:JSON.stringify({threadId:msg.params.arguments.threadId,status:'sent'})}],isError:false};
        if(msg.params.arguments.prompt==='fail')result={content:[{type:'text',text:'Selected model is at capacity.'}],isError:true};}
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');});`);
  const bridge=new DesktopBridge({...process.env,CODEX_APP_TOOLS_PIPE_PATH:'fixture',CODEX_THREAD_ID:'caller-fixture',CODEX_DESKTOP_BRIDGE_SERVER:script,CODEX_RELAY_CWD:directory,CODEX_RELAY_NATIVE_ENDPOINT:path.join(directory,'native-desktop.json'),RELAY_FIXTURE_CALLS:calls});
  t.after(async()=>{const child=bridge.child;const stopped=child ? new Promise(resolve=>child.once('exit',resolve)) : Promise.resolve();bridge.close();await stopped;
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});});
  assert.equal((await bridge.send({threadId:'original-thread',text:'你好',model:'first',effort:'max'},'workspace-write')).threadId,'original-thread');
  let requests=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.length,1);assert.equal(requests[0].name,'send_message_to_thread');
  assert.deepEqual(requests[0].arguments,{threadId:'original-thread',hostId:'local',prompt:'你好',model:'first',thinking:'max'});
  await assert.rejects(bridge.send({threadId:'original-thread',text:'ignored',permission:'danger-full-access'},'workspace-write'),/权限须沿用/);
  await assert.rejects(bridge.send({threadId:'original-thread',text:'ignored',serviceTier:'priority'},'workspace-write','default'),/Fast 模式须沿用/);
  assert.equal((await readFile(calls,'utf8')).trim().split('\n').length,1);
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8\/x8AAwMCAO+cMKcAAAAASUVORK5CYII=';
  await bridge.send({threadId:'original-thread',input:[{type:'text',text:'查看图片'},{type:'image',url:png}]},'workspace-write');
  requests=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.match(requests[1].arguments.prompt,/查看图片/);const filename=requests[1].arguments.prompt.match(/<image path="([^"]+)"/)[1];
  assert.equal(path.dirname(path.dirname(path.dirname(path.resolve(filename)))),path.resolve(directory));
  assert.deepEqual(await readFile(filename),Buffer.from(png.split(',')[1],'base64'));
  await assert.rejects(bridge.send({threadId:'original-thread',text:'fail'},'workspace-write'),/at capacity/);
  await bridge.answer({threadId:'original-thread',questions:[{id:'["request_user_input_async","ask",0]',title:'选择连接方式'}],answers:{'["request_user_input_async","ask",0]':'Wi-Fi'}});
  const latest=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(latest.name,'send_message_to_thread');assert.equal(latest.arguments.threadId,'original-thread');
  assert.deepEqual(questionReplies(latest.arguments.prompt),[{questionItemId:'["request_user_input_async","ask",0]',question:'选择连接方式',answer:'Wi-Fi'}]);
});
