import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { NativeDesktopHost, NativeDesktopClient } from '../src/native-desktop-channel.mjs';
import { DesktopBridge } from '../src/desktop-bridge.mjs';

async function fixture(t, { timeout = 100, respond, threadStatus = 'idle' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-native-'));
  const endpointFile = path.join(directory, 'endpoint.json');
  const desktop = [], core = [];
  let host;
  host = new NativeDesktopHost({
    endpointFile, writeDesktop: message => desktop.push(message),
    writeCore: message => {
      core.push(message);
      if (message.method === 'thread/read') host.fromCore({ id: message.id, result: { thread: { id: message.params.threadId, status: { type: threadStatus } } } });
      else if (respond) respond(message, host);
      else if (message.method === 'thread/resume') host.fromCore({ id: message.id, result: { thread: { id: message.params.threadId } } });
      else if (message.method === 'turn/start') {
        host.fromCore({ id: message.id, result: { turn: { id: 'native-turn' } } });
        host.fromCore({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: 'native-turn' } } });
      } else if (message.method === 'turn/steer') host.fromCore({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    }
  });
  await host.listen();
  host.fromDesktop({ method: 'initialized' });
  const client = new NativeDesktopClient({ CODEX_RELAY_NATIVE_ENDPOINT: endpointFile }, timeout);
  t.after(async () => {
    client.close(); await host.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, endpointFile, host, client, core, desktop };
}

test('native goal mutation requires an explicit user origin and approved lifecycle transitions',async t=>{
  const {client,core}=await fixture(t,{respond:(message,host)=>host.fromCore({id:message.id,result:{goal:null}})});
  core.length=0;
  await assert.rejects(client.request('thread/goal/set',{threadId:'original',status:'paused'}),/明确的用户操作/);
  await assert.rejects(client.request('thread/goal/set',{threadId:'original',status:'complete',origin:'user'}),/明确的用户操作/);
  await assert.rejects(client.request('thread/goal/clear',{threadId:'original'}),/明确的用户操作/);
  assert.equal(core.length,0);
  await client.request('thread/goal/set',{threadId:'original',origin:'user',status:'paused'});
  assert.equal(core.length,1);assert.equal(core[0].params.origin,'user');
});

test('native sends use ordinary input on the same Desktop thread and steer its current turn', async t => {
  const { client, core } = await fixture(t);
  const result = await client.send({ threadId: 'desktop-thread', text: '继续当前任务', model: 'fixture', effort: 'high' });
  assert.equal(result.delivery, 'native'); assert.equal(result.threadId, 'desktop-thread');
  const started = core.find(message => message.method === 'turn/start');
  assert.deepEqual(started.params.input, [{ type: 'text', text: '继续当前任务' }]);
  assert.equal(started.params.threadId, 'desktop-thread'); assert.equal(started.params.model, 'fixture');
  await client.send({ threadId: 'desktop-thread', text: '只检查原来的问题' });
  const steered = core.find(message => message.method === 'turn/steer');
  assert.deepEqual(steered.params, { threadId: 'desktop-thread', expectedTurnId: 'native-turn', input: [{ type: 'text', text: '只检查原来的问题' }] });
  assert.ok(!core.some(message => ['thread/start', 'thread/fork', 'thread/inject_items', 'tools/call'].includes(message.method)));
});

test('native Fast overrides target only the chosen thread, standard clears it, and steering does not change tiers',async t=>{
  const {client,core,host}=await fixture(t);
  await client.send({threadId:'first',text:'Fast',serviceTier:'priority'});
  assert.equal(core.findLast(message=>message.method==='turn/start').params.serviceTier,'priority');
  await client.send({threadId:'first',text:'Steer',serviceTier:'default'});
  assert.equal(Object.hasOwn(core.findLast(message=>message.method==='turn/steer').params,'serviceTier'),false);
  await client.send({threadId:'second',text:'Other conversation'});
  const other=core.findLast(message=>message.method==='turn/start').params;
  assert.equal(other.threadId,'second');assert.equal(Object.hasOwn(other,'serviceTier'),false);
  host.fromCore({method:'turn/completed',params:{threadId:'first',turn:{id:'native-turn',status:'completed'}}});
  await client.subscribe(['first','second']);
  await client.send({threadId:'first',text:'Standard',serviceTier:'default'});
  assert.equal(core.findLast(message=>message.method==='turn/start').params.serviceTier,null);
  assert.ok(!core.some(message=>message.method==='config/write' || message.method==='config/value/write'));
});

test('desktop idle and archive notifications clear cached active turns in both IPC peers', async t => {
  const {host,client}=await fixture(t);
  await client.subscribe(['original']);
  host.fromCore({method:'turn/started',params:{threadId:'original',turn:{id:'first'}}});
  host.fromCore({method:'thread/status/changed',params:{threadId:'original',status:{type:'idle'}}});
  await client.subscribe(['original']);
  assert.equal(host.activeTurns.has('original'),false);
  assert.equal(client.activeTurns.has('original'),false);
  host.fromCore({method:'turn/started',params:{threadId:'original',turn:{id:'second'}}});
  host.fromCore({method:'thread/archived',params:{threadId:'original'}});
  await client.subscribe(['original']);
  assert.equal(host.activeTurns.has('original'),false);
  assert.equal(client.activeTurns.has('original'),false);
});

test('native IPC preserves Desktop responses and server requests and separates colliding IDs', async t => {
  const { host, client, core, desktop } = await fixture(t);
  host.fromDesktop({ id: 1, method: 'initialize', params: { clientInfo: { name: 'native-desktop' } } });
  host.fromCore({ id: 1, result: { userAgent: 'desktop' } });
  await client.request('thread/read', { threadId: 'original', includeTurns: false });
  host.fromCore({ id: 'server-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'original' } });
  assert.deepEqual(desktop[0], { id: 1, result: { userAgent: 'desktop' } });
  assert.equal(desktop.at(-1).method, 'item/commandExecution/requestApproval');
  assert.equal(desktop.filter(message => message.result?.thread).length, 0);
  assert.ok(core.some(message => message.id === 1 && message.method === 'initialize'));
  assert.ok(core.some(message => typeof message.id === 'string' && message.id.startsWith('relay-native-')));
});

test('native IPC rejects unauthenticated peers and RPCs outside the thread/turn allowlist', async t => {
  const { endpointFile, client, core } = await fixture(t);
  const record = JSON.parse(await readFile(endpointFile, 'utf8'));
  const socket = net.createConnection(record.pipe);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Unauthenticated socket remained open')), 1000);
    socket.on('error', () => {}); socket.once('close', () => { clearTimeout(timer); resolve(); });
    socket.once('connect', () => socket.write(JSON.stringify({ type: 'hello', token: 'wrong-token' }) + '\n'));
  });
  await assert.rejects(client.request('thread/delete', { threadId: 'original' }), /Unsupported/);
  await assert.rejects(client.request('thread/goal/set', { threadId: 'original', objective: 'unwanted' }), /明确的用户操作/);
  assert.ok(!core.some(message => message.method === 'thread/goal/set'));
});

test('native readiness requires a successful matching Desktop initialize response', async t => {
  const { host, client, core, desktop } = await fixture(t);
  host.initialized = false;
  host.fromDesktop({ id: 0, method: 'initialize', params: { clientInfo: { name: 'desktop' } } });
  host.fromCore({ id: 99, result: {} });
  assert.equal(host.initialized, false);
  host.fromCore({ id: 0, error: { message: 'initialization failed' } });
  assert.equal(host.initialized, false);
  host.fromCore({ id: 0, result: {} });
  assert.equal(host.initialized, false, 'a later unrelated reply must not enable the channel');
  host.fromDesktop({ id: 'retry-initialize', method: 'initialize', params: { clientInfo: { name: 'desktop' } } });
  host.fromCore({ id: 'retry-initialize', result: { userAgent: 'desktop' } });
  assert.equal(host.initialized, true);
  await client.request('thread/read', { threadId: 'original', includeTurns: false });
  assert.equal(core.filter(x => x.method === 'initialize').length, 2);
  assert.deepEqual(desktop.at(-1), { id: 'retry-initialize', result: { userAgent: 'desktop' } });
});

test('uncertain native delivery never falls back to a second send or leaks late replies to Desktop', async t => {
  const { host, client, core, desktop } = await fixture(t, { timeout: 30, respond: () => {} });
  await assert.rejects(client.send({ threadId: 'original', text: '只发送一次' }), error => error.ambiguous === true);
  assert.equal(core.filter(message => message.method === 'turn/start').length, 1);
  const request = core.find(message => message.method === 'turn/start');
  client.close();
  await new Promise(resolve => setImmediate(resolve));
  host.fromCore({ id: request.id, result: { turn: { id: 'late-turn' } } });
  assert.equal(desktop.filter(message => message.result?.turn).length, 0);
});

test('DesktopBridge prefers native input with image parts, without invoking the forwarding tool', async t => {
  const { endpointFile, core } = await fixture(t);
  const bridge = new DesktopBridge({ CODEX_RELAY_NATIVE_ENDPOINT: endpointFile });
  bridge.tool = () => { throw new Error('Forwarding must not be used'); };
  t.after(() => bridge.close());
  const input = [{ type: 'text', text: '查看图片后继续' }, { type: 'image', url: 'data:image/png;base64,AA==' }];
  assert.equal((await bridge.send({ threadId: 'original', input }, 'workspace-write')).delivery, 'native');
  assert.deepEqual(core.find(message => message.method === 'turn/start').params.input, input);
});

test('a configured but stopped native connection fails clearly instead of reverting to forwarding', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-native-required-'));
  const endpointFile = path.join(directory, 'native-desktop.json');
  await writeFile(path.join(directory, 'native-desktop-required.json'), '{"version":1}');
  const bridge = new DesktopBridge({ CODEX_RELAY_NATIVE_ENDPOINT: endpointFile, CODEX_APP_TOOLS_PIPE_PATH: 'fixture', CODEX_THREAD_ID: 'fixture' });
  bridge.tool = () => { throw new Error('Forwarding must not be used'); };
  t.after(async () => { bridge.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(bridge.send({ threadId: 'original', text: '继续' }), /原生入口尚未启动/);
});

test('unloaded native threads resume their original ID before sending, without creating another conversation', async t => {
  const { client, core } = await fixture(t, { threadStatus: 'notLoaded' });
  await client.send({ threadId: 'existing-thread', text: '继续', cwd: 'C:/workspace' });
  assert.deepEqual(core.filter(x => x.method !== 'initialized').map(x => x.method), ['thread/read', 'thread/resume', 'turn/start']);
  assert.ok(core.filter(x => x.params).every(x => x.params.threadId === 'existing-thread'));
});

test('only an explicitly unaccepted stale steer can start one new turn', async t => {
  const { client, core, host } = await fixture(t, { respond: (message, channel) => {
    if (message.method === 'turn/steer') channel.fromCore({ id: message.id, error: { message: 'no active turn' } });
    if (message.method === 'turn/start') channel.fromCore({ id: message.id, result: { turn: { id: 'next-turn' } } });
  } });
  host.fromCore({ method: 'turn/started', params: { threadId: 'existing-thread', turn: { id: 'finished-turn' } } });
  assert.equal((await client.send({ threadId: 'existing-thread', text: '下一步' })).turn.id, 'next-turn');
  assert.equal(core.filter(x => x.method === 'turn/steer').length, 1);
  assert.equal(core.filter(x => x.method === 'turn/start').length, 1);
});

test('preparing a launcher does not activate native delivery before Desktop has connected', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-native-prepared-'));
  await writeFile(path.join(directory, 'native-desktop-launch.json'), '{"cliPath":"fixture"}');
  const client = new NativeDesktopClient({ CODEX_RELAY_NATIVE_ENDPOINT: path.join(directory, 'native-desktop.json') });
  t.after(async () => { client.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true }); });
  assert.equal(client.configured, false);
});

test('subscribed Desktop events and pending requests replay after reconnect; other threads and credentials stay private', async t => {
  const {host,client,endpointFile}=await fixture(t);
  const events=[];client.on('notification',message=>events.push(message));
  host.fromCore({id:'pending',method:'item/tool/requestUserInput',params:{threadId:'original',turnId:'t',itemId:'ask',questions:[{id:'q',question:'选择？'}]}});
  await client.subscribe(['original']);
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(events.filter(event=>event.id==='pending').length,1);
  host.fromCore({method:'item/agentMessage/delta',params:{threadId:'other',itemId:'secret',delta:'private'}});
  host.fromCore({id:'credential',method:'account/chatgptAuthTokens/refresh',params:{threadId:'original'}});
  host.fromCore({method:'item/agentMessage/delta',params:{threadId:'original',itemId:'reply',delta:'新输出'}});
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.ok(events.some(event=>event.params?.delta==='新输出'));
  assert.ok(!events.some(event=>event.id==='credential' || event.params?.itemId==='secret'));
  client.close();
  const second=new NativeDesktopClient({CODEX_RELAY_NATIVE_ENDPOINT:endpointFile});t.after(()=>second.close());
  const replay=[];second.on('notification',message=>replay.push(message));
  await second.subscribe(['original']);await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(replay.filter(event=>event.id==='pending').length,1);
});

test('remote and Desktop compete for one real response; stale and malformed replies never reach core', async t => {
  const {host,client,core}=await fixture(t);
  await client.subscribe(['original']);
  const question=id=>({id,method:'item/tool/requestUserInput',params:{threadId:'original',turnId:'t',itemId:'ask',questions:[{id:'q',question:'选择？'}]}});
  host.fromCore(question(7));
  await assert.rejects(client.respond({threadId:'original',requestId:7,result:{decision:'accept'}}),/回答格式/);
  await client.respond({threadId:'original',requestId:7,result:{answers:{q:{answers:['手机回答']}}}});
  host.fromDesktop({id:7,result:{answers:{q:{answers:['桌面回答']}}}});
  await assert.rejects(client.respond({threadId:'original',requestId:7,result:{answers:{q:{answers:['重复']}}}}),/已回答或已过期/);
  assert.equal(core.filter(message=>message.id===7 && message.result).length,1);
  assert.deepEqual(core.find(message=>message.id===7).result,{answers:{q:{answers:['手机回答']}}});
  host.fromCore(question('7'));
  host.fromDesktop({id:'7',result:{answers:{q:{answers:['桌面先回答']}}}});
  await assert.rejects(client.respond({threadId:'original',requestId:'7',result:{answers:{q:{answers:['手机后回答']}}}}),/已回答或已过期/);
  assert.equal(core.filter(message=>message.id==='7').length,1,'numeric and string request IDs are distinct');
  host.fromCore(question('expire'));
  host.fromCore({method:'serverRequest/resolved',params:{threadId:'original',requestId:'expire'}});
  await assert.rejects(client.respond({threadId:'original',requestId:'expire',result:{answers:{q:{answers:['迟到']}}}}),/已回答或已过期/);
  assert.ok(!core.some(message=>message.id==='expire'));
});

test('explicit steering rejects a finished turn without starting another conversation or turn',async t=>{
  const {host,client,core}=await fixture(t,{respond:(message,channel)=>{
    if(message.method==='turn/steer')channel.fromCore({id:message.id,error:{message:'no active turn'}});
  }});
  await client.connect();
  await assert.rejects(client.send({threadId:'original',mode:'steer',expectedTurnId:'ended',text:'追加',model:'unwanted'}),/no active turn/);
  assert.equal(core.filter(message=>message.method==='turn/start').length,0);
  assert.deepEqual(core.find(message=>message.method==='turn/steer').params,{threadId:'original',expectedTurnId:'ended',input:[{type:'text',text:'追加'}]});
});

test('client follows a restarted Desktop endpoint even when the old proxy is still alive',async t=>{
  const {client,host,endpointFile}=await fixture(t);
  await client.subscribe(['original']);
  const messages=[];client.on('notification',message=>messages.push(message));
  const replacement=new NativeDesktopHost({endpointFile,writeDesktop:()=>{},writeCore:()=>{}});
  await replacement.listen();replacement.fromDesktop({method:'initialized'});
  try {
    await client.refreshConnection();await client.subscribe(['original']);
    host.fromCore({method:'item/agentMessage/delta',params:{threadId:'original',itemId:'old',delta:'旧代理'}});
    replacement.fromCore({method:'item/agentMessage/delta',params:{threadId:'original',itemId:'new',delta:'新代理'}});
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(messages.some(message=>message.params?.delta==='新代理'));
    assert.ok(!messages.some(message=>message.params?.delta==='旧代理'));
  } finally {client.close();await replacement.close();}
});
