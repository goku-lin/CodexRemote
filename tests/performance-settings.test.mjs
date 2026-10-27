import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_PERFORMANCE_SETTINGS,performanceSettings} from '../public/performance-settings.js';
import {setupPerformanceSettings} from '../public/performance-settings-ui.js';

test('performance settings bound the workload and safely default old or malformed saved values',()=>{
  assert.deepEqual(performanceSettings(),DEFAULT_PERFORMANCE_SETTINGS);
  assert.deepEqual(performanceSettings({preloadCount:500,historyTurns:0,preloadEnabled:'false',preloadScope:'unknown'}),DEFAULT_PERFORMANCE_SETTINGS);
  for(const value of [null,[],true,{preloadCount:21},{preloadCount:0},{historyTurns:1.5},{historyTurns:'2'},{preloadEnabled:1},{preloadScope:'secret'},{timeout:0}])assert.throws(()=>performanceSettings(value,true));
  assert.equal(performanceSettings({preloadEnabled:false,preloadCount:20,historyTurns:1,preloadScope:'project'},true).historyTurns,1);
});

test('settings UI saves to the computer captured on opening; cancelling and stale reads cannot affect another opening',async t=>{
  const old=globalThis.document,nodes=new Map();
  const node=id=>{if(!nodes.has(id)){const classes=new Set(['hidden']);nodes.set(id,{value:'',checked:false,disabled:false,textContent:'',focus(){},addEventListener(){},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)}});}return nodes.get(id);};
  globalThis.document={getElementById:node};t.after(()=>globalThis.document=old);
  let selected={id:'one',name:'家里电脑'},pending=null;const calls=[],applied=[];
  const tools=setupPerformanceSettings({getDevice:()=>selected,onDevice:d=>applied.push(d),api:async(url,options)=>{
    calls.push({url,options});if(pending)return pending;
    return options ? {device:{id:url.includes('/one/')?'one':'two',performanceSettings:JSON.parse(options.body)}} : {settings:DEFAULT_PERFORMANCE_SETTINGS};
  }});
  await tools.open();node('preloadCount').value='12';node('historyTurns').value='3';selected={id:'two',name:'办公室电脑'};
  await node('performanceSettingsForm').onsubmit({preventDefault(){}});
  assert.equal(calls.at(-1).url,'/api/devices/one/performance');assert.equal(applied[0].id,'one');assert.equal(applied[0].performanceSettings.preloadCount,12);
  await tools.open();assert.equal(node('resetPerformanceSettingsBtn').disabled,false);node('preloadCount').value='4';tools.close();assert.equal(calls.filter(c=>c.options).length,1);
  let release;pending=new Promise(resolve=>release=resolve);const opening=tools.open();tools.close();pending=null;
  selected={id:'one',name:'家里电脑'};await tools.open();release({settings:{...DEFAULT_PERFORMANCE_SETTINGS,preloadCount:19}});await opening;
  assert.equal(node('preloadCount').value,8);tools.close();
});

test('authenticated computer settings persist, stream across browsers, and control backend history warming',{timeout:20000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-performance-')),children=[],streams=[];
  const stop=async child=>{if(child.exitCode===null && child.signalCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;}};
  t.after(async()=>{for(const stream of streams)stream.destroy();for(const child of children)await stop(child);assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  await writeFile(path.join(directory,'network.json'),JSON.stringify({externalOrigin:'https://performance.test-tail.ts.net'}));
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const base=`http://127.0.0.1:${port}`,remote={host:'performance.test-tail.ts.net','x-forwarded-proto':'https'},token={'x-codex-relay-token':'performance-fixture'};
  const start=async()=>{const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_PARENT_PIPE:'0',CODEX_RELAY_TOKEN:'performance-fixture',CODEX_RELAY_DATA_DIR:directory}});children.push(child);await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',chunk=>{if(String(chunk).includes('listening'))resolve();});});return child;};
  const send=(url,{headers={},body,method=body===undefined?'GET':'POST'}={})=>new Promise((resolve,reject)=>{const req=request(base+url,{method,headers:{'content-type':'application/json',...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,json:JSON.parse(text)}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
  const listen=(url,headers,events)=>new Promise((resolve,reject)=>{const req=request(base+url,{headers},res=>{let buffer='';res.setEncoding('utf8');res.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,i);buffer=buffer.slice(i+2);const kind=block.match(/^event: (.+)$/m)?.[1],data=block.match(/^data: (.+)$/m)?.[1];if(kind&&data)events.push({kind,data:JSON.parse(data)});}});resolve(req);});streams.push(req);req.on('error',reject);req.end();});
  const until=async predicate=>{const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw new Error('fixture event timeout');await new Promise(resolve=>setTimeout(resolve,15));}};
  let child=await start();
  assert.deepEqual((await send('/api/devices/local/performance')).json.settings,DEFAULT_PERFORMANCE_SETTINGS);
  assert.equal((await send('/api/devices/local/performance',{headers:remote,method:'PATCH',body:{preloadCount:2}})).status,401);
  assert.equal((await send('/api/devices/missing/performance')).status,404);
  const info=(await send('/api/phone')).json;const pair=await send('/api/access/pair',{headers:remote,body:{code:info.code,deviceName:'性能测试'}});
  const paired={...remote,cookie:pair.headers['set-cookie'][0].split(';')[0]},events=[],commands=[];
  const browser=await listen('/api/events',paired,events),runner=await listen('/api/runner/local/commands',token,commands);
  for(const body of [{preloadCount:99},{historyTurns:0},{preloadEnabled:'no'},null])assert.equal((await send('/api/devices/local/performance',{headers:paired,method:'PATCH',body})).status,400);
  const settings={preloadEnabled:true,preloadCount:2,historyTurns:2,preloadScope:'all'};
  assert.deepEqual((await send('/api/devices/local/performance',{headers:paired,method:'PATCH',body:settings})).json.settings,settings);
  await until(()=>events.some(e=>e.kind==='device'&&e.data.performanceSettings?.preloadCount===2));
  const threads=Array.from({length:5},(_,i)=>({id:'thread-'+i,name:'Fixture '+i,cwd:path.join(directory,'project-'+i%3),status:{type:i===4?'active':'idle'},updatedAt:100-i}));
  const publish=threads=>send('/api/runner/local/events',{headers:token,body:{type:'thread_list',threads,complete:true}});
  await publish(threads);await until(()=>commands.filter(e=>e.data.type==='readThread').length===3);
  assert.deepEqual(commands.filter(e=>e.data.type==='readThread').map(e=>[e.data.threadId,e.data.maxTurns]),[['thread-0',2],['thread-1',2],['thread-4',2]]);
  assert.equal((await send('/api/bootstrap',{headers:paired})).json.devices[0].performanceSettings.historyTurns,2);
  await send('/api/devices/local/performance',{headers:paired,method:'PATCH',body:{preloadEnabled:false}});
  assert.equal((await send('/api/devices/local/performance')).json.settings.historyTurns,2,'PATCH preserves the remaining fields');
  threads.push({id:'off-idle',name:'not preloaded',cwd:directory,status:{type:'idle'},updatedAt:200});
  await publish(threads);
  await send('/api/devices/local/sync',{body:{}});await until(()=>commands.some(e=>e.data.type==='listThreads'));
  assert.equal(commands.some(e=>e.data.type==='readThread'&&e.data.threadId==='off-idle'),false);
  const session=(await send('/api/sessions')).json.sessions.find(s=>s.threadId==='off-idle');
  await send('/api/sessions/'+session.id+'/history',{body:{maxTurns:1}});await until(()=>commands.some(e=>e.data.type==='readThread'&&e.data.threadId==='off-idle'));
  assert.equal(commands.find(e=>e.data.threadId==='off-idle').data.maxTurns,1);
  browser.destroy();runner.destroy();await stop(child);child=await start();
  assert.deepEqual((await send('/api/devices/local/performance',{headers:paired})).json.settings,{...settings,preloadEnabled:false});
  assert.equal(JSON.parse(await readFile(path.join(directory,'preferences.json'),'utf8')).performance.local.preloadCount,2);
});
