import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('recovery requires confirmation before any request; refreshing status does not reconnect',async()=>{
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false,classList:{toggle(){},add(){},remove(){}}});return nodes.get(id);};
  const calls=[],prompts=[];let allow=false;
  const context=vm.createContext({document:{getElementById:node},location:{search:''},URLSearchParams,setTimeout,clearTimeout,syncHtml(){},setupNetworkCheck(){},window:{confirm:message=>{prompts.push(message);return allow;}}});
  const source=(await readFile(new URL('../public/service-health.js',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
  vm.runInContext(source,context);
  context.setupServiceHealth(async(path,options)=>{calls.push({path,options});return {checking:false};});
  await node('healthRecoverBtn').onclick();assert.equal(prompts.length,1);assert.match(prompts[0],/公网.*短暂断线/);
  assert.ok(!calls.some(call=>call.path==='/api/health/recover'));
  await node('healthRefreshBtn').onclick();assert.equal(prompts.length,1);assert.equal(calls.at(-1).path,'/api/health/check');
  allow=true;await node('healthRecoverBtn').onclick();assert.equal(calls.filter(call=>call.path==='/api/health/recover').length,1);
});
