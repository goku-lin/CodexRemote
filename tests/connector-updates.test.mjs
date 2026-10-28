import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createArchive} from '../src/connector-archive.mjs';
import {buildRelease} from '../src/connector-release.mjs';
import {autoUpdate,entries,install,ensureStableRuntime} from '../src/connector-client.mjs';
import {releaseSigningKey,signRelease,verifyRelease,updateSource,updateUrl,lanUpdateRequest,availableRelease,downloadRelease} from '../src/connector-updates.mjs';

async function folder(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-auto-update-'));
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));return fs.rm(directory,{recursive:true,force:true});});
  return directory;
}
const json=async filename=>JSON.parse(await fs.readFile(filename,'utf8'));
const save=(filename,value)=>fs.writeFile(filename,JSON.stringify(value));
async function fixture(t){
  const directory=await folder(t),home=path.join(directory,'home'),state=path.join(home,'state'),old='1'.repeat(20),version='2'.repeat(20);
  await fs.mkdir(state,{recursive:true});await fs.mkdir(path.join(home,'versions',old,'app'),{recursive:true});await fs.mkdir(path.join(home,'versions',old,'runtime'));
  await save(path.join(home,'current.json'),{version:old});
  const stable={'connector.json':{mode:'independent',id:'fixture-local',token:'local-secret',port:4317,cwd:directory},'browser-devices.json':{phone:'browser-grant'},'deliveries.json':{queued:{state:'waiting'}},'network.json':{externalOrigin:'https://pc.fixture.ts.net'}};
  for(const [name,value] of Object.entries(stable))await save(path.join(state,name),value);
  await fs.writeFile(path.join(state,'old-native-proxy.exe'),'running bridge sentinel');
  const key=await releaseSigningKey(path.join(directory,'publisher'));
  const bytes=createArchive([{name:'release.json',bytes:Buffer.from(JSON.stringify({version}))},{name:'runtime/node.exe',bytes:Buffer.from('MZfixture')},{name:'app/connector-client.mjs',bytes:Buffer.from('//fixture')}]);
  let manifest=signRelease({version,filename:'connector-'+version+'.zip',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length,sequence:2},key),corrupt=false,downloads=0;
  const server=createServer((req,res)=>{
    if(req.url.endsWith('/manifest')){res.setHeader('content-type','application/json');res.end(JSON.stringify(manifest));return;}
    downloads++;const payload=corrupt ? Buffer.from('corrupt package') : bytes;res.setHeader('content-length',String(payload.length));res.end(payload);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url='http://127.0.0.1:'+server.address().port;
  await save(path.join(state,'update-source.json'),{schema:1,publicKey:key.publicKey,urls:[url],sequence:1});
  const calls=[],options={prepareVersion:async()=>calls.push('prepare'),refresh:async()=>calls.push('entries'),stopRunning:async()=>calls.push('stop'),launchConnector:async()=>calls.push('launch'),verify:async(_home,newVersion)=>{assert.equal(newVersion,version);calls.push('ready');}};
  return {directory,home,state,old,version,key,bytes,url,stable,calls,options,server,get downloads(){return downloads;},set manifest(value){manifest=value;},set corrupt(value){corrupt=value;},pointer:()=>json(path.join(home,'current.json'))};
}

test('release signatures survive publisher restart, reject foreign publishers, tampering and replay',async t=>{
  const directory=await folder(t),key=await releaseSigningKey(directory),again=await releaseSigningKey(directory);
  assert.equal(key.publicKey,again.publicKey);
  const source={schema:1,publicKey:key.publicKey,urls:['http://192.168.1.10:4317'],sequence:4};
  const manifest=signRelease({version:'a'.repeat(20),filename:'connector-'+ 'a'.repeat(20)+'.zip',size:100,sha256:'b'.repeat(64),sequence:4},key);
  assert.equal(verifyRelease(manifest,source).version,manifest.version);
  assert.throws(()=>verifyRelease({...manifest,sha256:'c'.repeat(64)},source),/签名/);
  const other=await releaseSigningKey(path.join(directory,'other'));
  assert.throws(()=>verifyRelease(signRelease(manifest,other),source),/签名/);
  assert.throws(()=>verifyRelease(manifest,{...source,sequence:5}),/较旧/);
  assert.deepEqual(updateSource(source),source);
  for(const url of ['http://public.example/','http://192.168.1.10/path','http://user:pass@192.168.1.10','http://192.168.1.10/?token=secret','http://999.1.1.1'])assert.throws(()=>updateUrl(url));
  assert.equal(updateUrl('http://100.85.104.65:4317'),'http://100.85.104.65:4317');
  assert.equal(updateUrl('http://MY-LAPTOP:4317/'),'http://my-laptop:4317');
  assert.ok(lanUpdateRequest({socket:{remoteAddress:'192.168.1.20'},headers:{}}));
  for(const req of [{socket:{remoteAddress:'8.8.8.8'},headers:{}},{socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':'192.168.1.20'}}])assert.equal(lanUpdateRequest(req),false);
  assert.ok(lanUpdateRequest({socket:{remoteAddress:'100.98.250.84'},headers:{}}));
});

test('automatic LAN update keeps authorization, queued work, address and the running bridge; same-version check does not restart',async t=>{
  const f=await fixture(t),result=await autoUpdate(f.home,f.options);
  assert.deepEqual(result,{status:'updated',version:f.version});assert.equal((await f.pointer()).version,f.version);
  assert.deepEqual(f.calls,['prepare','entries','stop','launch','ready']);
  for(const [name,value] of Object.entries(f.stable))assert.deepEqual(await json(path.join(f.state,name)),value);
  assert.equal(await fs.readFile(path.join(f.state,'old-native-proxy.exe'),'utf8'),'running bridge sentinel');
  f.calls.length=0;assert.equal((await autoUpdate(f.home,f.options)).status,'current');assert.deepEqual(f.calls,[]);assert.equal(f.downloads,1);
  assert.equal((await json(path.join(f.state,'update-source.json'))).sequence,2);
});

test('corrupt package and compilation failure leave the old version and do not stop its backend',async t=>{
  const f=await fixture(t);f.corrupt=true;
  assert.equal((await autoUpdate(f.home,f.options)).status,'unavailable');assert.equal((await f.pointer()).version,f.old);assert.deepEqual(f.calls,[]);
  f.corrupt=false;
  const result=await autoUpdate(f.home,{...f.options,prepareVersion:async()=>{throw new Error('fixture compilation failed');}});
  assert.match(result.message,/compilation/);assert.equal((await f.pointer()).version,f.old);assert.deepEqual(f.calls,[]);
});

test('failed new backend startup rolls back the selected version and launches the old backend',async t=>{
  const f=await fixture(t),result=await autoUpdate(f.home,{...f.options,verify:async()=>{throw new Error('fixture service failed');}});
  assert.equal(result.status,'unavailable');assert.match(result.message,/service failed/);assert.equal((await f.pointer()).version,f.old);
  assert.deepEqual(f.calls,['prepare','entries','stop','launch','stop','entries','launch']);
  for(const [name,value] of Object.entries(f.stable))assert.deepEqual(await json(path.join(f.state,name)),value);
});

test('active tasks defer installation, including a task that starts while the package is being prepared',async t=>{
  const f=await fixture(t);
  assert.equal((await autoUpdate(f.home,{...f.options,activeWork:async()=>true})).status,'deferred');
  assert.equal(f.downloads,0);assert.equal((await f.pointer()).version,f.old);assert.deepEqual(f.calls,[]);
  let checks=0;
  assert.equal((await autoUpdate(f.home,{...f.options,activeWork:async()=>++checks>1})).status,'deferred');
  assert.equal((await f.pointer()).version,f.old);assert.deepEqual(f.calls,['prepare']);
  f.calls.length=0;
  assert.equal((await autoUpdate(f.home,{...f.options,activeWork:async()=>false})).status,'updated');
  assert.equal((await f.pointer()).version,f.version);
});

test('an offline source is bounded and concurrent startup checks never install twice',async t=>{
  const f=await fixture(t);
  const began=Date.now(),offline=await autoUpdate(f.home,{...f.options,fetcher:async()=>{throw new Error('source offline');}});
  assert.equal(offline.status,'unavailable');assert.ok(Date.now()-began<1000);assert.equal((await f.pointer()).version,f.old);
  let prepared,release;const entered=new Promise(resolve=>prepared=resolve),pause=new Promise(resolve=>release=resolve);
  const first=autoUpdate(f.home,{...f.options,prepareVersion:async()=>{prepared();await pause;}});
  await entered;
  const second=await autoUpdate(f.home,f.options);assert.equal(second.status,'unavailable');assert.match(second.message,/正在进行/);
  release();assert.equal((await first).status,'updated');assert.equal(f.downloads,1);
});

test('manifest probes have a timeout, accept only the pinned key, and remember newer publications despite failed downloads',async t=>{
  const f=await fixture(t),source=await json(path.join(f.state,'update-source.json'));
  const silent=createServer(()=>{});await new Promise(resolve=>silent.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{silent.closeAllConnections();await new Promise(resolve=>silent.close(resolve));});
  const began=Date.now();await assert.rejects(()=>availableRelease({...source,urls:['http://127.0.0.1:'+silent.address().port]},{timeout:60}));assert.ok(Date.now()-began<1000);
  f.corrupt=true;await autoUpdate(f.home,f.options);
  f.manifest=signRelease({version:f.old,filename:'connector-'+f.old+'.zip',size:1,sha256:'a'.repeat(64),sequence:1},f.key);
  const result=await autoUpdate(f.home,f.options);assert.equal(result.status,'unavailable');assert.equal(f.downloads,1);assert.equal((await f.pointer()).version,f.old);
});

test('fresh installation remembers the packaged update source without an extra pairing step',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),packageRoot=path.join(f.directory,'package'),home=path.join(f.directory,'new-home');
  await fs.mkdir(path.join(packageRoot,'runtime'),{recursive:true});await fs.mkdir(path.join(packageRoot,'app'));
  await fs.writeFile(path.join(packageRoot,'runtime','node.exe'),'MZfixture');
  const updates=await json(path.join(f.state,'update-source.json'));
  await save(path.join(packageRoot,'release.json'),{version:f.version,updates});
  await install({home,name:'个人笔记本',workspace:f.directory,packageRoot},{prepareVersion:async()=>{},launchConnector:async()=>{}});
  assert.deepEqual(await json(path.join(home,'state','update-source.json')),updates);
  await fs.access(path.join(home,'从安装包更新.cmd'));
  assert.match(await fs.readFile(path.join(home,'connector-entry.ps1'),'utf8'),/auto-update --home/);
});

test('the long-lived Relay service uses one stable Node path across versioned updates',async t=>{
  const directory=await folder(t),old=path.join(directory,'versions','old'),next=path.join(directory,'versions','next');
  await fs.mkdir(path.join(old,'runtime'),{recursive:true});await fs.mkdir(path.join(next,'runtime'),{recursive:true});
  await fs.writeFile(path.join(old,'runtime','node.exe'),Buffer.from('MZ-old'));await fs.writeFile(path.join(next,'runtime','node.exe'),Buffer.from('MZ-next'));
  const stable=await ensureStableRuntime(directory,old);assert.equal(stable,path.join(directory,'runtime','node.exe'));assert.equal((await fs.readFile(stable)).toString(),'MZ-old');
  await ensureStableRuntime(directory,next);assert.equal((await fs.readFile(stable)).toString(),'MZ-next');
});

test('computer-name updates fall back to private IPv4 while retaining the pinned signature',async t=>{
  const f=await fixture(t),source=await json(path.join(f.state,'update-source.json'));
  const manifest=await (await fetch(f.url+'/api/connector-updates/manifest')).json(),seen=[];
  const result=await availableRelease({...source,urls:['http://publisher-pc:4317']},{
    resolve:async(name,options)=>{assert.equal(name,'publisher-pc');assert.equal(options.family,4);return [{address:'100.85.104.65',family:4},{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4},{address:'192.168.0.213',family:4}];},
    fetcher:async url=>{seen.push(url);return url.includes('publisher-pc') ? new Response('',{status:403}) : Response.json(manifest);}
  });
  assert.equal(result.url,'http://100.85.104.65:4317');assert.equal(result.manifest.version,f.version);
  assert.deepEqual(seen,['http://publisher-pc:4317/api/connector-updates/manifest','http://100.85.104.65:4317/api/connector-updates/manifest','http://192.168.0.213:4317/api/connector-updates/manifest']);
  await assert.rejects(()=>availableRelease({...source,urls:['http://publisher-pc:4317']},{resolve:async()=>[{address:'192.168.0.213',family:4}],fetcher:async()=>Response.json({...manifest,sha256:'a'.repeat(64)})}),/签名校验失败/);
});

test('unreachable updates report address and actual failure; name resolution is bounded',async t=>{
  const f=await fixture(t),source=await json(path.join(f.state,'update-source.json'));
  await assert.rejects(()=>availableRelease({...source,urls:['http://192.168.0.213:4317']},{fetcher:async()=>{throw new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}});}}),/192\.168\.0\.213:4317：连接被拒绝/);
  const began=Date.now();
  await assert.rejects(()=>availableRelease({...source,urls:['http://publisher-pc:4317']},{timeout:30,resolve:()=>new Promise(()=>{}),fetcher:async()=>new Response('',{status:403})}),/HTTP 403.*电脑名解析超时/);
  assert.ok(Date.now()-began<1000);
});

async function githubFixture(t){
  const f=await fixture(t),repository='example/remote',tag='v0.1.1',base='https://github.com/'+repository+'/releases/download/'+tag+'/';
  const source={schema:1,kind:'github',repository,channel:'preview',publicKey:f.key.publicKey,sequence:1};
  await save(path.join(f.state,'update-source.json'),source);
  const manifest=signRelease({version:f.version,filename:'connector-'+f.version+'.zip',size:f.bytes.length,sha256:crypto.createHash('sha256').update(f.bytes).digest('hex'),sequence:2},f.key);
  const release={tag_name:tag,name:'版本 0.1.1',body:'更新说明\n保留配置',draft:false,prerelease:true,assets:[
    {name:'update-manifest.json',state:'uploaded',browser_download_url:base+'update-manifest.json'},
    {name:manifest.filename,state:'uploaded',size:f.bytes.length,browser_download_url:base+manifest.filename}
  ]};
  let downloads=0;const requests=[];
  const fetcher=async(url,options)=>{
    requests.push({url,options});assert.equal(options.headers.Authorization,undefined);assert.equal(options.redirect,'manual');
    if(url.startsWith('https://api.github.com/'))return Response.json([release]);
    if(url.endsWith('/update-manifest.json'))return Response.json(manifest);
    if(url.endsWith('.zip')){downloads++;return new Response(f.bytes);}
    throw new Error('Unexpected URL '+url);
  };
  return {...f,source,manifest,release,requests,fetcher,get archiveDownloads(){return downloads;}};
}

test('GitHub check exposes release notes without downloading or restarting; installation keeps local data',async t=>{
  const f=await githubFixture(t),options={...f.options,fetcher:f.fetcher};
  const checked=await autoUpdate(f.home,options);
  assert.equal(checked.status,'available');assert.equal(checked.release.name,'版本 0.1.1');assert.match(checked.release.notes,/保留配置/);
  assert.equal(f.archiveDownloads,0);assert.deepEqual(f.calls,[]);assert.equal((await f.pointer()).version,f.old);
  assert.equal((await autoUpdate(f.home,{...options,install:true,activeWork:async()=>true})).status,'deferred');assert.equal(f.archiveDownloads,0);
  assert.equal((await autoUpdate(f.home,{...options,install:true,activeWork:async()=>false})).status,'updated');assert.equal(f.archiveDownloads,1);
  assert.deepEqual(f.calls,['prepare','entries','stop','launch','ready']);
  for(const [name,value] of Object.entries(f.stable))assert.deepEqual(await json(path.join(f.state,name)),value);
  assert.equal((await autoUpdate(f.home,options)).status,'current');assert.equal(f.archiveDownloads,1);
});

test('GitHub rejects mismatched keys, rollbacks, external assets and unsafe redirects',async t=>{
  const f=await githubFixture(t),other=await releaseSigningKey(path.join(f.directory,'foreign'));
  await assert.rejects(availableRelease({...f.source,publicKey:other.publicKey},{fetcher:f.fetcher}),/签名/);
  await assert.rejects(availableRelease({...f.source,sequence:3},{fetcher:f.fetcher}),/较旧/);
  f.release.assets[0].browser_download_url='https://evil.example/update-manifest.json';
  await assert.rejects(availableRelease(f.source,{fetcher:f.fetcher}),/地址无效/);
  f.release.assets[0].browser_download_url='https://github.com/example/remote/releases/download/v0.0.1/update-manifest.json';
  await assert.rejects(availableRelease(f.source,{fetcher:f.fetcher}),/同一发布版本/);
  const target={kind:'github',repository:f.source.repository,url:f.release.assets[1].browser_download_url};
  for(const location of ['http://release-assets.githubusercontent.com/data','https://evil.example/data','https://127.0.0.1/data','https://user:pass@github.com/data']){
    await assert.rejects(downloadRelease(target,f.manifest,{fetcher:async()=>new Response(null,{status:302,headers:{location}})}),/重定向地址无效/);
  }
});

test('GitHub handles a signed asset CDN redirect, rejects corrupted downloads and remains usable offline',async t=>{
  const f=await githubFixture(t),target={kind:'github',repository:f.source.repository,url:f.release.assets[1].browser_download_url};
  const fetched=await downloadRelease(target,f.manifest,{fetcher:async url=>url.startsWith('https://github.com/')?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/file?signature=fixture'}}):new Response(f.bytes)});
  assert.deepEqual(fetched,f.bytes);
  await assert.rejects(downloadRelease(target,f.manifest,{fetcher:async()=>new Response('corrupt')}),/校验失败/);
  const failed=await autoUpdate(f.home,{...f.options,install:true,fetcher:async()=>{throw new Error('offline');}});
  assert.equal(failed.status,'unavailable');assert.equal((await f.pointer()).version,f.old);assert.deepEqual(f.calls,[]);
  await assert.rejects(availableRelease(f.source,{fetcher:async()=>new Response('',{status:403})}),/受限/);
});

test('GitHub stable channel excludes preview and draft releases; old releases without manifests need no update',async t=>{
  const f=await githubFixture(t);
  assert.deepEqual(await availableRelease({...f.source,channel:'stable'},{fetcher:f.fetcher}),{status:'empty'});
  f.release.draft=true;assert.deepEqual(await availableRelease(f.source,{fetcher:f.fetcher}),{status:'empty'});
  f.release.draft=false;f.release.assets=[];assert.equal((await autoUpdate(f.home,{fetcher:f.fetcher})).status,'empty');
  for(const repository of ['../remote','example/remote/path','example/remote?token=x'])assert.throws(()=>updateSource({...f.source,repository}));
});

test('public build signing can use a persistent CI secret without writing it to the working directory',async t=>{
  const directory=await folder(t),key=await releaseSigningKey(path.join(directory,'publisher'));
  const keyJson=await fs.readFile(path.join(directory,'publisher','release-signing-key.json'),'utf8');
  const isolated=path.join(directory,'ci'),loaded=await releaseSigningKey(isolated,{keyJson});
  assert.equal(loaded.publicKey,key.publicKey);assert.deepEqual(await fs.readdir(isolated),[]);
  await assert.rejects(releaseSigningKey(isolated,{keyJson:'invalid'}));
});

test('an unverified bundled Node version stops release construction before creating signing state or an installer',async t=>{
  const directory=await folder(t);await fs.writeFile(path.join(directory,'.node-version'),'0.0.0\n');
  await assert.rejects(buildRelease(directory,{publish:false,publicBuild:true}),/已验证的 Node\.js 0\.0\.0/);
  assert.deepEqual(await fs.readdir(directory),['.node-version']);
});

test('the live publisher serves signed releases without a browser grant and rejects Funnel/proxy access',async t=>{
  const directory=await folder(t),reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_PARENT_PIPE:'1',CODEX_RELAY_DATA_DIR:directory}});
  t.after(async()=>{if(child.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();const timer=setTimeout(()=>child.kill(),3000);await ended;clearTimeout(timer);}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('publisher startup timeout')),8000);child.on('error',reject);child.stdout.on('data',data=>{if(String(data).includes('listening')){clearTimeout(timer);resolve();}});child.stderr.resume();});
  const version='a'.repeat(20),bytes=Buffer.from('fixture package'),key=await releaseSigningKey(directory);
  const manifest=signRelease({version,filename:'connector-'+version+'.zip',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length,sequence:1},key);
  await fs.mkdir(path.join(directory,'releases'));await fs.writeFile(path.join(directory,'releases',manifest.filename),bytes);await save(path.join(directory,'releases','latest.json'),manifest);
  const base='http://127.0.0.1:'+port,source={schema:1,publicKey:key.publicKey,urls:[base],sequence:1};
  assert.equal((await availableRelease(source)).manifest.version,version);
  const response=await fetch(base+'/api/connector-updates/manifest',{headers:{host:'publisher-local'}});assert.equal(response.status,200);assert.equal((await response.json()).path,undefined);
  assert.deepEqual(Buffer.from(await (await fetch(base+'/api/connector-updates/package/'+version)).arrayBuffer()),bytes);
  assert.equal((await fetch(base+'/api/connector-updates/package/'+'b'.repeat(20))).status,409);
  for(const headers of [{'x-forwarded-for':'192.168.1.20'},{'tailscale-user-login':'fixture'},{forwarded:'for=192.168.1.20'}])assert.equal((await fetch(base+'/api/connector-updates/manifest',{headers})).status,403);
  assert.equal((await fetch(base+'/api/connector-updates/manifest',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/api/sessions',{headers:{'x-forwarded-for':'192.168.1.20'}})).status,401);
  assert.equal((await fetch(base+'/api/sessions',{headers:{origin:'http://untrusted.fixture'}})).status,403);
  const runtime=await (await fetch(base+'/api/runtime')).json();assert.equal(runtime.connectorUpdateRevision,1);
});
