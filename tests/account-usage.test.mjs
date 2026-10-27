import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {AccountUsageMonitor,readFreshAccountUsage,usageIdentity} from '../src/account-usage.mjs';

const limits=usedPercent=>({rateLimits:{primary:{usedPercent,windowDurationMins:10080}}});
test('quota publications omit account identifiers and login credentials',async()=>{
  const published=[];
  const privateFields={email:'private-account@example.invalid',account_id:'private-account-id',access_token:'private-access-token',refresh_token:'private-refresh-token'};
  const monitor=new AccountUsageMonitor({identity:async()=>'',read:async()=>({...privateFields,rateLimits:{...privateFields,primary:{...privateFields,usedPercent:1,windowDurationMins:300}}}),publish:async usage=>{published.push(usage);return true;}});
  await monitor.refresh();const payload=JSON.stringify(published);
  for(const value of Object.values(privateFields))assert.ok(!payload.includes(value));
  assert.equal(published.at(-1).buckets[0].windows[0].remainingPercent,99);
});
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'relay-quota-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));return rm(root,{recursive:true,force:true});});return root;}

test('quota fallback starts fresh after a login change and only initializes and reads rate limits',async t=>{
  const root=await fixture(t),login=path.join(root,'fixture-login'),log=path.join(root,'requests.jsonl'),script=path.join(root,'reader.mjs');
  await writeFile(script,`import readline from 'node:readline';import{readFileSync,appendFileSync}from'node:fs';
    const used=Number(readFileSync(process.env.QUOTA_FIXTURE_LOGIN,'utf8'));
    readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(process.env.QUOTA_FIXTURE_LOG,JSON.stringify({pid:process.pid,method:m.method})+'\\n');if(m.id==null)return;
      process.stdout.write(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{rateLimits:{primary:{usedPercent:used,windowDurationMins:10080}}}})+'\\n');});`);
  const options={command:process.execPath,args:[script],cwd:root,env:{...process.env,QUOTA_FIXTURE_LOGIN:login,QUOTA_FIXTURE_LOG:log}};
  await writeFile(login,'73');assert.equal((await readFreshAccountUsage(options)).rateLimits.primary.usedPercent,73);
  await writeFile(login,'4');assert.equal((await readFreshAccountUsage(options)).rateLimits.primary.usedPercent,4);
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(new Set(calls.map(c=>c.pid)).size,2);
  assert.deepEqual(calls.map(c=>c.method),['initialize','initialized','account/rateLimits/read','initialize','initialized','account/rateLimits/read']);
});

test('short-lived quota readers time out, report RPC errors and never return previous quota',async t=>{
  const root=await fixture(t),script=path.join(root,'reader.mjs');
  await writeFile(script,"setInterval(()=>{},1000)");
  await assert.rejects(readFreshAccountUsage({command:process.execPath,args:[script],timeoutMs:150}),/超时/);
  await writeFile(script,`process.stdin.once('data',()=>process.stdout.write(JSON.stringify({id:1,error:{message:'login required'}})+'\\n'));setInterval(()=>{},1000);`);
  await assert.rejects(readFreshAccountUsage({command:process.execPath,args:[script]}),/login required/);
});

test('login metadata changes invalidate shared quota before reading and discard an in-flight old login reply',async()=>{
  let identity='first',calls=0,finish;const published=[];
  const monitor=new AccountUsageMonitor({identity:async()=>identity,read:async()=>{calls++;if(calls===1)return new Promise(r=>finish=r);return limits(4);},publish:async usage=>{published.push(usage);return true;},now:()=>500});
  const first=monitor.refresh();await new Promise(resolve=>setImmediate(resolve));
  identity='second';const second=monitor.refresh(true);assert.equal(first,second);finish(limits(73));await first;
  assert.equal(calls,2);assert.equal(published.filter(p=>p.refreshing).length,2);
  assert.ok(!published.some(p=>p.buckets[0]?.windows[0]?.remainingPercent===27));
  assert.equal(published.at(-1).buckets[0].windows[0].remainingPercent,96);
  await monitor.check();assert.equal(calls,2,'unchanged metadata never performs another network read');
});

test('new login read failure clears the old quota and a successful manual refresh recovers',async()=>{
  let identity='old',fail=false;const published=[];
  const monitor=new AccountUsageMonitor({identity:async()=>identity,read:async()=>{if(fail)throw new Error('network');return limits(identity==='old'?73:4);},publish:async usage=>{published.push(usage);return true;}});
  await monitor.refresh();identity='new';fail=true;await monitor.check();
  assert.deepEqual(published.at(-1).buckets,[]);assert.equal(published.at(-1).reset,true);assert.match(published.at(-1).error,/network/);
  fail=false;await monitor.refresh(true);assert.equal(published.at(-1).buckets[0].windows[0].remainingPercent,96);
});

test('account detector observes file replacement without reading or returning login contents',async t=>{
  const root=await fixture(t),file=path.join(root,'auth.json');
  const empty=await usageIdentity([file]);await writeFile(file,'PRIVATE LOGIN FIXTURE');const first=await usageIdentity([file]);
  await writeFile(file,'OTHER PRIVATE LOGIN FIXTURE');const next=await usageIdentity([file]);
  assert.notEqual(empty,first);assert.notEqual(first,next);assert.doesNotMatch(next,/PRIVATE|LOGIN/);
});
