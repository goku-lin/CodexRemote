import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {LanAccess} from '../src/network-mode.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

function fixture(t,options={}){
  const servers=[];
  const access=new LanAccess({port:4317,handler:()=>{},prepare:async()=>['192.168.1.10'],inspect:async()=>['192.168.1.10'],createServer:()=>{
    const server=new EventEmitter();server.listen=(port,address,done)=>{server.address=address;server.port=port;queueMicrotask(done);};server.close=()=>{server.closed=true;};servers.push(server);return server;
  },...options});t.after(()=>access.close());return {access,servers};
}
test('LAN opens only after firewall preparation and stays open until disabled',async t=>{
  let prepared=false;const f=fixture(t,{prepare:async()=>{prepared=true;assert.equal(f.servers.length,0);return ['192.168.1.10'];}});
  assert.equal(f.access.status().lanEnabled,false);
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const status=await f.access.set(true);assert.ok(prepared);assert.deepEqual(status.urls,['http://192.168.1.10:4317/']);
  assert.ok(!('lanExpiresAt' in status));
  t.mock.timers.tick(24*60*60*1000);await f.access.refresh();
  assert.equal(f.access.status().lanEnabled,true,'elapsed time never disables LAN');
  assert.equal(f.servers[0].address,'192.168.1.10');
  let destroyed=false;const socket=new EventEmitter();socket.destroy=()=>{destroyed=true;};f.servers[0].emit('connection',socket);
  await f.access.set(false);assert.ok(destroyed);assert.ok(f.servers[0].closed);assert.equal(f.access.status().lanEnabled,false);
});
test('failed or declined firewall preparation never starts a LAN socket',async t=>{
  const {access,servers}=fixture(t,{prepare:async()=>{throw new Error('declined');}});
  await assert.rejects(access.set(true),/管理员授权/);assert.equal(servers.length,0);assert.equal(access.status().lanEnabled,false);
  for(const address of ['0.0.0.0','8.8.8.8','192.168.1.999','127.0.0.1']){
    access.prepare=async()=>[address];await assert.rejects(access.set(true));assert.equal(servers.length,0);
  }
});
test('LAN shuts down when its private interface or firewall disappears',async t=>{
  let addresses=['192.168.1.10'];const {access,servers}=fixture(t,{inspect:async()=>addresses});
  await access.set(true);await access.refresh();assert.equal(access.status().lanEnabled,true);
  addresses=[];await access.refresh();assert.equal(access.status().lanEnabled,false);assert.ok(servers[0].closed);
  await access.set(true);access.inspect=async()=>{throw new Error('disabled firewall');};await access.refresh();assert.equal(access.status().lanEnabled,false);assert.match(access.status().lanError,/已关闭/);
});
test('simultaneous local requests cannot start competing LAN listeners',async t=>{
  let finish;const {access,servers}=fixture(t,{prepare:()=>new Promise(resolve=>finish=resolve)});
  const pending=access.set(true);await assert.rejects(access.set(true),/正在处理中/);finish(['192.168.1.10']);await pending;assert.equal(servers.length,1);
});
test('Windows helper creates private-only rules without opening public networks',{skip:process.platform!=='win32'},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-lan-rule-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const helper=fileURLToPath(new URL('../scripts/lan-access.ps1',import.meta.url));
  const wrapper=path.join(directory,'check.ps1');
  await fs.writeFile(wrapper,'\ufeff'+String.raw`
param([string]$Helper,[string]$Node)
$ErrorActionPreference='Stop'
$global:created=@()
function Get-NetFirewallRule { param($Name,$ErrorAction) if ($Name -is [array]) { return }; if ($Name.EndsWith('-NonPrivate')) { [pscustomobject]@{Enabled='True';Action='Block';Profile='Domain, Public'} } else { [pscustomobject]@{Enabled='True';Action='Allow';Profile='Private'} } }
function Remove-NetFirewallRule { }
function New-NetFirewallRule { param($Name,$DisplayName,$Direction,$Action,$Profile,$Program,$Protocol,$LocalPort,$RemoteAddress) $global:created+=@{action=$Action;profile=$Profile;remote=$RemoteAddress;program=$Program;port=$LocalPort} }
function Get-NetFirewallProfile { [pscustomobject]@{Enabled=$true} }
function Get-NetConnectionProfile { [pscustomobject]@{NetworkCategory='Private';InterfaceIndex=1};[pscustomobject]@{NetworkCategory='Public';InterfaceIndex=2} }
function Get-NetIPAddress { param($InterfaceIndex,$AddressFamily,$ErrorAction) if ($InterfaceIndex -ne 1) { throw 'public interface queried' }; [pscustomobject]@{AddressState='Preferred';IPAddress='192.168.1.10'} }
& $Helper -Port 4317 -Program $Node -Configure -Elevated
$global:created | ConvertTo-Json -Compress
`);
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-File',wrapper,helper,process.execPath],{windowsHide:true,timeout:10000});
  const rules=JSON.parse(stdout.replace(/^\ufeff/,''));assert.equal(rules.length,2);
  assert.deepEqual(rules[0].profile,['Public','Domain']);assert.equal(rules[0].action,'Block');
  assert.equal(rules[1].profile,'Private');assert.equal(rules[1].remote,'LocalSubnet');assert.equal(rules[1].action,'Allow');
  for(const rule of rules){assert.equal(rule.port,4317);assert.equal(rule.program,process.execPath);}
});
