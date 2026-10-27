import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer as httpServer,request as httpRequest} from 'node:http';
import {createServer as netServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
async function port(){const socket=netServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const value=socket.address().port;await new Promise(resolve=>socket.close(resolve));return value;}
async function poll(read){for(let i=0;i<100;i++){try{const result=await read();if(result)return result;}catch{}await delay(100);}throw new Error('independent fixture startup timed out');}

test('two independent execution nodes retain separate browser grants and survive the former hub and one node going offline',{timeout:90000},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-independent-nodes-')),children=[];
  let hubRequests=0;
  const hub=httpServer((req,res)=>{hubRequests++;res.writeHead(503);res.end();});await new Promise(resolve=>hub.listen(0,'127.0.0.1',resolve));
  const upstream='http://127.0.0.1:'+hub.address().port;
  t.after(async()=>{
    for(const {child} of children){if(child.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();const timer=setTimeout(()=>child.kill(),3000);await stopped;clearTimeout(timer);}}
    if(hub.listening)await new Promise(resolve=>hub.close(resolve));
    await delay(300);assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});
  });
  const fixture=path.join(directory,'codex-fixture.mjs');
  await fs.writeFile(fixture,String.raw`import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);if(message.id==null)return;
 if(['turn/start','thread/start'].includes(message.method))throw new Error('No model calls allowed in this fixture');
 const result=message.method==='model/list'?{data:[{id:'independent-fixture',model:'independent-fixture',supportedReasoningEfforts:[]}]}:message.method==='thread/list'?{data:[]}:{};
 process.stdout.write(JSON.stringify({id:message.id,result})+'\n');
});`);
  async function start(name){
    const state=path.join(directory,name),localPort=await port(),id='pc-'+crypto.randomUUID();await fs.mkdir(state);
    const config={mode:'independent',id,token:crypto.randomBytes(32).toString('hex'),name,cwd:state,port:localPort,server:upstream};
    await fs.writeFile(path.join(state,'connector.json'),JSON.stringify(config));
    await fs.writeFile(path.join(state,'network.json'),JSON.stringify({externalOrigin:'https://'+name+'.fixture.ts.net'}));
    const child=spawn(process.execPath,['src/connector-runtime.mjs'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,
      CODEX_RELAY_DATA_DIR:state,CODEX_RELAY_RELEASE_ID:'a'.repeat(20),CODEX_BIN:process.execPath,CODEX_ARGS_JSON:JSON.stringify([fixture]),
      CODEX_CLI_PATH:'',CODEX_SESSIONS_DIR:path.join(directory,'empty-sessions'),CODEX_APP_TOOLS_PIPE_PATH:'',CODEX_THREAD_ID:'',CODEX_DESKTOP_BRIDGE_SERVER:'',CODEX_RELAY_NATIVE_ENDPOINT:path.join(state,'no-native.json')
    }});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    const node={child,state,id,base:'http://127.0.0.1:'+localPort,output:()=>output};children.push(node);
    try{await poll(async()=>{const response=await fetch(node.base+'/api/devices');if(!response.ok)return false;return (await response.json()).devices.some(item=>item.id===id && item.online);});}catch(error){throw new Error(error.message+'\n'+output);}
    return node;
  }
  const one=await start('desktop'),two=await start('laptop');
  const remote=(node,endpoint,{body,cookie}={})=>new Promise((resolve,reject)=>{
    const hostname=new URL(node.base).port===new URL(one.base).port ? 'desktop.fixture.ts.net' : 'laptop.fixture.ts.net';
    const req=httpRequest(node.base+endpoint,{method:body ? 'POST' : 'GET',headers:{host:hostname,origin:'https://'+hostname,'x-forwarded-proto':'https',...(cookie ? {cookie} : {}),...(body ? {'content-type':'application/json'} : {})}},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,json:()=>JSON.parse(text)}));
    });req.on('error',reject);req.end(body && JSON.stringify(body));
  });
  async function pair(node,name){
    const info=await (await fetch(node.base+'/api/phone')).json();
    const response=await remote(node,'/api/access/pair',{body:{code:info.code,deviceName:name}});assert.equal(response.status,200);
    return response.headers['set-cookie'][0].split(';')[0];
  }
  const phoneOne=await pair(one,'手机'),phoneTwo=await pair(two,'手机'),companyTwo=await pair(two,'公司浏览器');
  assert.equal((await remote(two,'/api/access/lan',{cookie:phoneTwo})).status,403);
  assert.equal((await remote(two,'/api/access/lan',{cookie:phoneTwo,body:{enabled:true}})).status,403);
  const localLan=await (await fetch(two.base+'/api/access/lan')).json();
  assert.equal(localLan.lanEnabled,false);assert.deepEqual(localLan.urls,[]);
  assert.equal((await fetch(two.base+'/api/access/lan',{method:'POST',headers:{'content-type':'application/json'},body:'{"enabled":false}'})).status,200);
  assert.equal((await remote(two,'/api/devices',{cookie:phoneOne})).status,401);
  assert.equal((await remote(one,'/api/devices',{cookie:phoneTwo})).status,401);
  for(const cookie of [phoneTwo,companyTwo])assert.equal((await remote(two,'/api/devices',{cookie})).status,200);
  assert.equal((await remote(two,'/api/access/devices',{cookie:phoneTwo})).status,403);
  await poll(async()=>{const response=await remote(two,'/api/devices/'+two.id+'/catalog',{cookie:phoneTwo});return response.status===200 && response.json().models?.some(item=>item.id==='independent-fixture');});
  assert.equal((await remote(one,'/api/devices',{cookie:phoneOne})).status,200);
  assert.equal(hubRequests,0,'independent nodes must not contact or upload events to the former hub');
  await new Promise(resolve=>hub.close(resolve));
  const stopped=new Promise(resolve=>one.child.once('exit',resolve));one.child.stdin.end();await stopped;
  // Wait beyond the legacy 45-second upstream lease, rather than only checking immediately after disconnect.
  await delay(47000);
  assert.equal((await remote(two,'/api/devices/'+two.id+'/sync',{cookie:companyTwo,body:{}})).status,202);
  const snapshot=await remote(two,'/api/bootstrap',{cookie:phoneTwo});assert.equal(snapshot.status,200);
  assert.equal(snapshot.json().devices.find(item=>item.id===two.id)?.online,true);
  assert.equal(hubRequests,0);
  const grants=JSON.parse(await fs.readFile(path.join(two.state,'browser-devices.json')));
  assert.equal(grants.devices.length,2);
  await assert.rejects(()=>fetch(one.base+'/api/devices'));
});
