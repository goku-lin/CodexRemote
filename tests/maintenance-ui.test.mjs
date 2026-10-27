import test from 'node:test';
import assert from 'node:assert/strict';
import {setupMaintenance} from '../public/maintenance.js';

test('remote maintenance has no password management, requires desktop confirmation and retries an ambiguous request with the same ID',async t=>{
  const saved={document:globalThis.document,sessionStorage:globalThis.sessionStorage},nodes=new Map(),stored=new Map();
  const node=id=>{if(!nodes.has(id)){const classes=new Set(['hidden']);nodes.set(id,{value:id==='maintenanceScope'?'service':'',checked:false,disabled:false,textContent:'',addEventListener(){},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)}});}return nodes.get(id);};
  let markup='';globalThis.document={body:{insertAdjacentHTML:(_,html)=>markup=html},getElementById:node,addEventListener(){}};
  globalThis.sessionStorage={getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)};
  const calls=[];let fail=true,job=null,recovered=0;
  const tools=setupMaintenance({onRecovered:()=>recovered++,api:async(url,options)=>{
    calls.push({url,options});if(options){if(fail)throw new Error('connection lost');job={id:JSON.parse(options.body).requestId,scope:'desktop',state:'queued'};return {job};}
    return {passwordConfigured:true,serviceSupported:true,desktopSupported:true,passwordSetupPath:'D:\\Fixture\\设置重启密码.cmd',job};
  }});
  t.after(()=>{tools.close();Object.assign(globalThis,saved);});
  node('healthModal').classList.remove('hidden');
  await tools.open();assert.doesNotMatch(markup,/设置密码|修改密码|新密码/);assert.match(markup,/type="password"/);
  assert.match(markup,/minlength="6" maxlength="128"/);
  assert.equal(node('healthModal').classList.contains('hidden'),true,'connection check must not cover the recovery form');
  assert.equal(node('maintenanceModal').classList.contains('hidden'),false);
  assert.equal(node('maintenanceSetupPath').textContent,'D:\\Fixture\\设置重启密码.cmd');
  tools.close();assert.equal(node('healthModal').classList.contains('hidden'),false,'closing recovery returns to connection check');
  await tools.open();
  node('maintenanceScope').value='desktop';node('maintenanceScope').onchange();assert.equal(node('maintenanceSubmit').disabled,true);
  node('maintenanceConfirm').checked=true;node('maintenanceConfirm').onchange();node('maintenancePassword').value='test-private-password';
  await node('maintenanceForm').onsubmit({preventDefault(){}});assert.equal(node('maintenancePassword').value,'');assert.equal(stored.size,1);assert.ok(![...stored.values()].join('').includes('test-private-password'));
  const first=JSON.parse(calls.find(c=>c.options).options.body);
  await tools.refresh();fail=false;node('maintenancePassword').value='test-private-password';await node('maintenanceForm').onsubmit({preventDefault(){}});
  const posts=calls.filter(c=>c.options);assert.equal(posts.length,2);assert.equal(JSON.parse(posts[1].options.body).requestId,first.requestId);
  assert.equal(node('maintenanceSubmit').disabled,true);job.state='complete';await tools.refresh();await tools.refresh();assert.equal(recovered,1);assert.equal(stored.size,0);
  assert.ok(calls.every(c=>!c.url.includes('/password')));
});
