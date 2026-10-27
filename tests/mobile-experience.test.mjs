import test from 'node:test';import assert from 'node:assert/strict';import {readFile,mkdtemp,writeFile,rm}from'node:fs/promises';import vm from'node:vm';import path from'node:path';import os from'node:os';
import {applicationWorker}from'../src/app-shell.mjs';
import {textPreview,resumeSnapshot,ResumeCache}from'../public/resume-cache.js';
import {connectionExperience}from'../public/connection-state.js';
import {keyboardLayout}from'../public/mobile-layout.js';
import {LatestNavigation}from'../public/latest-navigation.js';

test('resume previews include only bounded conversation text, never live requests, credentials, media or command output',()=>{
  const session={id:'a',title:'Preview',status:'running',nativeModel:'old',pendingAttention:[{id:'pending'}],controls:{steer:true},tokenUsage:{usedPercent:99},events:[
    {type:'user_message',id:'u',text:'Question',images:[{url:'private-image'}]},
    {type:'codex',message:{method:'item/completed',params:{item:{id:'cmd',type:'commandExecution',aggregatedOutput:'PRIVATE OUTPUT'}}}},
    {type:'codex',message:{method:'item/completed',params:{item:{id:'a',type:'agentMessage',text:'Answer'}}}},
    {type:'codex',message:{method:'item/completed',params:{item:{id:'q',type:'agentMessage',text:'old pending',questions:[{}]}}}}
  ]};
  const preview=textPreview(session),json=JSON.stringify(preview);
  assert.equal(preview.events.length,2);assert.equal(preview.cachedPreview,true);assert.equal(preview.historyLoaded,false);assert.equal(preview.status,'synced');
  assert.deepEqual(preview.controls,{});assert.doesNotMatch(json,/PRIVATE OUTPUT|private-image|old pending|tokenUsage|nativeModel|steer/);
  const snapshot=resumeSnapshot(Array.from({length:30},(_,i)=>({...session,id:String(i)})),'12',{},100);
  assert.equal(snapshot.sessions.length,5);assert.equal(snapshot.sessions[0].id,'12');assert.equal(snapshot.savedAt,100);
  assert.ok(resumeSnapshot(Array.from({length:20},(_,i)=>({...session,id:String(i),events:Array.from({length:16},()=>({type:'user_message',text:'x'.repeat(100000)}))})),'0').sessions.length<=2);
});

test('storage absence never prevents startup and revoke invalidates an outstanding cache write',async()=>{
  const cache=new ResumeCache({indexedDB:null});assert.equal(await cache.read(),null);await cache.write({});await cache.clear();
  let resolve,transactions=0;cache.database=()=>new Promise(r=>resolve=r);const pending=cache.write({});cache.generation++;resolve({transaction(){transactions++;}});await pending;assert.equal(transactions,0);
});

test('connection messages separate cached text, browser connectivity, runner and native desktop availability',()=>{
  assert.match(connectionExperience({connection:'offline',cached:true}).text,/本机保存/);
  assert.match(connectionExperience({connection:'connecting',cached:true}).text,/核对最新/);
  assert.match(connectionExperience({connection:'connected',device:{online:false}}).text,/暂不能发送/);
  assert.match(connectionExperience({connection:'connected',device:{online:true,nativeDesktop:{connected:false}}}).text,/接管未连接/);
  assert.match(connectionExperience({accessRequired:true}).text,/配对/);
  assert.equal(connectionExperience({connection:'connected',device:{online:true,nativeDesktop:{connected:true}}}).show,false);
});

test('compact mode requires a focused composer and significant viewport loss, not browser bars or pinch zoom',()=>{
  const sample={mobile:true,focused:true,height:430,baseline:820};assert.equal(keyboardLayout(sample),true);
  assert.equal(keyboardLayout({...sample,height:760}),false);assert.equal(keyboardLayout({...sample,focused:false}),false);
  assert.equal(keyboardLayout({...sample,scale:1.8}),false);assert.equal(keyboardLayout({...sample,mobile:false}),false);
});

test('new output preserves reading position; explicit latest follows until the user scrolls back',()=>{
  const scrollHandlers=[],messages={scrollHeight:1500,clientHeight:400,scrollTop:0,addEventListener:(_,f)=>scrollHandlers.push(f)},button={};
  const oldRAF=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;let frame;
  globalThis.requestAnimationFrame=f=>(frame=f,1);globalThis.cancelAnimationFrame=()=>{};
  try{
    const nav=new LatestNavigation(messages,button);nav.before('a','one');nav.after();frame();
    nav.before('a','two');nav.after();frame();assert.equal(messages.scrollTop,0);assert.match(button.textContent,/有新内容/);
    button.onclick();assert.equal(messages.scrollTop,1500);messages.scrollHeight=2000;
    nav.before('a','three');nav.after();frame();assert.equal(messages.scrollTop,2000);assert.equal(button.hidden,true);
    messages.scrollTop=50;scrollHandlers[0]();nav.before('a','four');nav.after();frame();assert.equal(messages.scrollTop,50);assert.match(button.textContent,/有新内容/);
  }finally{globalThis.requestAnimationFrame=oldRAF;globalThis.cancelAnimationFrame=oldCancel;}
});

test('application service worker intercepts only same-origin public shell and keeps API and attachments uncached',async()=>{
  const handlers={},source=await readFile(new URL('../public/notification-worker.js',import.meta.url),'utf8');
  const sandbox={self:{location:{origin:'https://relay.test'},addEventListener:(name,fn)=>handlers[name]=fn},URL,Request};vm.runInNewContext(source,sandbox);
  const blocked=['/api/bootstrap','/api/events','/api/uploads/private','/api/sessions/id/history','/api/sessions/id/preview/a.html','/remote-browser.html','/manifest.webmanifest'];
  for(const pathname of blocked){let handled=false;handlers.fetch({request:{url:'https://relay.test'+pathname,method:'GET'},respondWith(){handled=true;}});assert.equal(handled,false,pathname);}
  let handled=false;sandbox.caches={open:async()=>({match:async key=>({publicKey:key})})};
  handlers.fetch({request:{url:'https://relay.test/?noticeSession=123',method:'GET'},respondWith(promise){handled=true;assert.doesNotReject(promise);}});assert.equal(handled,true);
  handled=false;handlers.fetch({request:{url:'https://third-party.test/app.js',method:'GET'},respondWith(){handled=true;}});assert.equal(handled,false);
  assert.equal(typeof handlers.push,'function');
});

test('manifest, icons and precached files exist and the complete mobile shell can be installed atomically',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../public/manifest.webmanifest',import.meta.url),'utf8'));
  assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/');
  for(const icon of manifest.icons){const png=await readFile(new URL('../public'+icon.src,import.meta.url));assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),parseInt(icon.sizes));}
  const source=await readFile(new URL('../public/notification-worker.js',import.meta.url),'utf8'),assets=JSON.parse(source.match(/const SHELL_ASSETS=(\[[^;]+\]);/)[1]);
  for(const asset of assets)await readFile(new URL('../public'+asset,import.meta.url));
  assert.ok(assets.includes('/resume-cache.js'));assert.ok(!assets.some(p=>p.startsWith('/api/')));
});

test('installed shell revision changes with frontend updates and automatically includes new public modules',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-app-shell-'));t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));return rm(directory,{recursive:true,force:true});});
  const worker=await readFile(new URL('../public/notification-worker.js',import.meta.url),'utf8');
  await writeFile(path.join(directory,'notification-worker.js'),worker);
  for(const name of ['index.html','styles.css','manifest.webmanifest','app-icon.svg','app-icon-192.png','app-icon-512.png','app.js'])await writeFile(path.join(directory,name),'fixture');
  const first=applicationWorker(directory);await writeFile(path.join(directory,'app.js'),'changed frontend');const second=applicationWorker(directory);
  assert.notEqual(first.match(/SHELL_CACHE='([^']+)'/)[1],second.match(/SHELL_CACHE='([^']+)'/)[1]);
  await writeFile(path.join(directory,'new-module.js'),'new module');assert.match(applicationWorker(directory),/\/new-module\.js/);
});
