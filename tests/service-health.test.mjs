import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ServiceHealth,networkConfig,forwardingState,probeAccess} from '../src/service-health.mjs';

const settings={externalOrigin:'https://relay.tail-test.ts.net',privateOrigin:'https://relay.tail-test.ts.net:8443',accessMode:'hybrid'};
const config=()=>({TCP:{443:{HTTPS:true},8443:{HTTPS:true}},Web:{'relay.tail-test.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:4317'}}},'relay.tail-test.ts.net:8443':{Handlers:{'/':{Proxy:'http://127.0.0.1:4317'}}}},AllowFunnel:{'relay.tail-test.ts.net:443':true}});
async function fixture(t,{state='Running',configured=true,prefs={WantRunning:true,LoggedOut:false},serve=config(),hostname='relay.tail-test.ts.net.'}={}){
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'relay-health-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(os.tmpdir()));return rm(dataDir,{recursive:true,force:true});});
  if(configured)await writeFile(path.join(dataDir,'network.json'),JSON.stringify(settings));
  const calls=[],probes=[],changes=[];
  const health=new ServiceHealth({root:process.cwd(),dataDir,port:4317,platform:'win32',onChange:value=>changes.push(value),probe:async url=>probes.push(url),run:async args=>{
    calls.push(args);
    if(args[0]==='status')return JSON.stringify({BackendState:state,HaveNodeKey:true,Self:{DNSName:hostname}});
    if(args[0]==='debug')return JSON.stringify(prefs);
    if(args[0]==='serve')return JSON.stringify(serve);
    if(args[0]==='up')state='Running';
    return '';
  }});
  health.setup=async()=>{calls.push(['setup']);serve=config();};return {health,calls,probes,changes};
}
test('an unconfigured installation never publishes an external service',async t=>{
  const {health,calls}=await fixture(t,{configured:false});assert.equal((await health.check({recover:true})).external.state,'disabled');assert.equal(calls.length,0);
});
test('existing Windows identity recovers from NoState and restores only the saved ports',async t=>{
  const {health,calls,probes}=await fixture(t,{state:'NoState',serve:{}});
  assert.equal((await health.check({recover:true})).external.state,'ready');
  assert.ok(calls.some(args=>args.join(' ')==='set --unattended=true'));assert.ok(calls.some(args=>args.join(' ')==='up --timeout=10s'));assert.ok(calls.some(args=>args[0]==='setup'));
  assert.deepEqual(probes,[settings.externalOrigin]);assert.ok(!calls.some(args=>args.includes('--force-reauth') || args[0]==='logout'));
});
test('manual suspension stays suspended until the user requests recovery',async t=>{
  const {health,calls}=await fixture(t,{state:'Stopped',prefs:{WantRunning:false,LoggedOut:false}});
  await health.check({recover:true});assert.ok(!calls.some(args=>args[0]==='up'));
  await health.check({recover:true,manual:true});assert.ok(calls.some(args=>args[0]==='up'));
});
test('configured Windows services can recover an unavailable daemon without changing account credentials',async t=>{
  const {health}=await fixture(t);let started=0;const run=health.run;
  health.run=async args=>{if(!started)throw new Error('Daemon unavailable');return run(args);};
  health.startService=async()=>{started++;};
  assert.equal((await health.check({recover:true})).external.state,'ready');assert.equal(started,1);
});
test('login-required and switched identities never trigger login or republish another address',async t=>{
  for(const options of [{state:'NeedsLogin'},{hostname:'another.tail-test.ts.net.'}]){
    const {health,calls,probes}=await fixture(t,options);const result=await health.check({recover:true,manual:true});
    assert.ok(['offline','error'].includes(result.external.state));assert.equal(result.external.url,settings.externalOrigin);assert.equal(probes.length,0);assert.ok(!calls.some(args=>args[0]==='up' || args[0]==='setup'));
  }
});
test('other applications and public 8443 mappings cannot be overwritten',async t=>{
  for(const serve of [{...config(),Web:{...config().Web,'relay.tail-test.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:9999'}}}}},{...config(),AllowFunnel:{'relay.tail-test.ts.net:443':true,'relay.tail-test.ts.net:8443':true}}]){
    const {health,calls}=await fixture(t,{serve});assert.equal((await health.check({recover:true})).external.state,'error');assert.ok(!calls.some(args=>args[0]==='setup'));
  }
});
test('an enabled proxy must also pass HTTPS and pairing checks; repeated unchanged checks stay quiet',async t=>{
  const {health,changes,calls}=await fixture(t);
  await health.check();await health.check();assert.equal(changes.length,1);assert.ok(!calls.some(args=>args[0]==='setup'));
  health.probe=async()=>{throw new Error('TLS timeout');};assert.equal((await health.check()).external.state,'error');assert.equal(health.report.tailscale.state,'ready');
});
test('simultaneous checks share one operation',async t=>{
  const {health,calls}=await fixture(t);const original=health.run;let release;
  const gate=new Promise(resolve=>release=resolve);health.run=async args=>{await gate;return original(args);};
  const first=health.check(),second=health.check();release();await Promise.all([first,second]);assert.equal(calls.filter(args=>args[0]==='status').length,1);
});
test('unsafe network configuration is rejected and a missing owned Funnel can be restored',()=>{
  assert.throws(()=>networkConfig({...settings,externalOrigin:'http://127.0.0.1:9999'}));
  assert.throws(()=>networkConfig({...settings,privateOrigin:'https://different.ts.net:8443'}));
  const owned=config();delete owned.AllowFunnel['relay.tail-test.ts.net:443'];assert.equal(forwardingState(owned,networkConfig(settings),4317),'missing');
});

test('public checks use public relay addresses even when OS DNS would take the working private route',async()=>{
  const connections=[];
  const options={publicIngress:true,resolve:async hostname=>{assert.equal(hostname,'relay.tail-test.ts.net');return ['100.64.0.1','127.0.0.1','208.111.34.11','208.111.35.209'];},connect:async(url,address)=>{connections.push(address);assert.equal(url,settings.externalOrigin);throw new Error('TLS reset');}};
  await assert.rejects(probeAccess(settings.externalOrigin,options),/公网线路/);
  assert.deepEqual(connections,['208.111.34.11','208.111.35.209']);
  await assert.rejects(probeAccess(settings.externalOrigin,{...options,resolve:async()=>['100.64.0.1','192.168.0.213']}),/未取得公网入口地址/);
});

test('a healthy edge cannot hide another broken public edge or unprotected access',async()=>{
  const options={publicIngress:true,resolve:async()=>['208.111.34.11','208.111.35.209'],connect:async(url,address)=>{
    if(address==='208.111.34.11')throw new Error('TLS reset');return {required:true,local:false};
  }};
  assert.equal((await probeAccess(settings.externalOrigin,options)).state,'warning');
  assert.equal((await probeAccess(settings.externalOrigin,{...options,connect:async()=>({required:true,local:false})})).state,'ready');
  await assert.rejects(probeAccess(settings.externalOrigin,{...options,connect:async()=>({required:false,local:true})}),/公网线路/);
});

test('manual recovery reconnects only the owned public port and verifies the public route again',async t=>{
  const {health,calls}=await fixture(t);let attempts=0;
  health.probe=async(url,options)=>{assert.equal(options.publicIngress,true);if(attempts++===0)throw new Error('TLS reset');return {state:'ready'};};
  const result=await health.check({recover:true,manual:true});
  assert.equal(result.external.state,'ready');assert.equal(attempts,2);
  assert.deepEqual(calls.filter(args=>args[0]==='funnel'),[['funnel','--https=443','off'],['funnel','--bg','--yes','--https=443','http://127.0.0.1:4317']]);
  assert.ok(!calls.some(args=>args.includes('reset') || args.includes('--https=8443') || args[0]==='down'));
});

test('public partial failure is visible and a changed mapping cannot be overwritten during recovery',async t=>{
  const {health,calls}=await fixture(t);
  health.probe=async()=>({state:'warning'});assert.equal((await health.check()).external.state,'warning');
  const original=health.run;let serveReads=0;
  health.run=async args=>{if(args[0]==='serve' && ++serveReads===2)return JSON.stringify({...config(),Web:{...config().Web,'relay.tail-test.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:9999'}}}}});return original(args);};
  assert.equal((await health.check({recover:true,manual:true})).external.state,'error');
  assert.ok(!calls.some(args=>args[0]==='funnel'));
});

test('a lost disable response still attempts to re-enable the same public mapping',async t=>{
  const {health,calls}=await fixture(t),original=health.run;
  health.run=async args=>{const result=await original(args);if(args[0]==='funnel' && args.includes('off'))throw new Error('response lost');return result;};
  await assert.rejects(health.restartIngress(networkConfig(settings)),/response lost/);
  assert.deepEqual(calls.filter(args=>args[0]==='funnel'),[['funnel','--https=443','off'],['funnel','--bg','--yes','--https=443','http://127.0.0.1:4317']]);
});
