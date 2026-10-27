import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const cliFixture=`const fs=require('node:fs');const path=require('node:path');
const file=process.env.FIXTURE_STATE;const data=JSON.parse(fs.readFileSync(file));
const command=path.basename(process.argv[1]),args=process.argv.slice(2);
data.calls.push([command,...args]);fs.writeFileSync(file,JSON.stringify(data));
if(command==='status'){console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'relay.test-tail.ts.net.'}}));process.exit(0);}
if(args[0]==='status'){console.log(JSON.stringify(data.config));process.exit(0);}
if(command==='funnel' && data.failFunnel && !args.includes('off')){console.error('fixture funnel failed');process.exit(1);}
const port=args.find(arg=>arg.startsWith('--https=')).split('=')[1],key='relay.test-tail.ts.net:'+port;
data.config.Web??={};data.config.TCP??={};data.config.AllowFunnel??={};
if(args.includes('off')){delete data.config.Web[key];delete data.config.TCP[port];delete data.config.AllowFunnel[key];}
else{data.config.Web[key]={Handlers:{'/':{Proxy:args.at(-1)}}};data.config.TCP[port]={HTTPS:true};data.config.AllowFunnel[key]=command==='funnel';}
fs.writeFileSync(file,JSON.stringify(data));`;

for(const failure of [false,true])test(failure ? 'failed Funnel setup restores the previous private entry and preserves other services' : 'hybrid setup verifies auth before creating separate private and public ports',{timeout:10_000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-tailscale-setup-'));
  const server=createServer((req,res)=>{
    const status=req.url==='/api/access' ? 200 : 403;
    res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(status===200 ? {required:true,local:false} : {error:'local only'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
  for(const command of ['status','serve','funnel'])fs.writeFileSync(path.join(dir,command),cliFixture);
  const target='http://127.0.0.1:'+port,origin='https://relay.test-tail.ts.net';
  const original={Web:{'other.test-tail.ts.net:9000':{Handlers:{'/':{Proxy:'http://127.0.0.1:9000'}}}},TCP:{9000:{HTTPS:true}}};
  if(failure){original.Web['relay.test-tail.ts.net:443']={Handlers:{'/':{Proxy:target}}};original.TCP[443]={HTTPS:true};}
  const stateFile=path.join(dir,'cli.json');fs.writeFileSync(stateFile,JSON.stringify({config:original,calls:[],failFunnel:failure}));
  const settings={externalOrigin:origin,accessMode:'private'};fs.writeFileSync(path.join(dir,'network.json'),JSON.stringify(settings));
  const run=()=>promisify(execFile)(process.execPath,[fileURLToPath(new URL('../src/private-access.mjs',import.meta.url)),'--hybrid'],{cwd:dir,windowsHide:true,timeout:8000,env:{...process.env,CODEX_RELAY_DATA_DIR:dir,PORT:String(port),TAILSCALE_BIN:process.execPath,FIXTURE_STATE:stateFile}});
  if(failure)await assert.rejects(run,/fixture funnel failed/);else await run();
  const active=JSON.parse(fs.readFileSync(stateFile));const saved=JSON.parse(fs.readFileSync(path.join(dir,'network.json')));
  assert.deepEqual(active.config.Web['other.test-tail.ts.net:9000'],original.Web['other.test-tail.ts.net:9000']);
  assert.ok(!active.calls.some(call=>call.includes('reset')));
  if(failure){assert.deepEqual(saved,settings);assert.equal(active.config.Web['relay.test-tail.ts.net:8443'],undefined);assert.equal(active.config.AllowFunnel['relay.test-tail.ts.net:443'],false);}
  else{assert.equal(saved.accessMode,'hybrid');assert.equal(saved.privateOrigin,origin+':8443');assert.equal(active.config.AllowFunnel['relay.test-tail.ts.net:443'],true);assert.equal(active.config.AllowFunnel['relay.test-tail.ts.net:8443'],false);}
});
