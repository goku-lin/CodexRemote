import test from 'node:test';
import assert from 'node:assert/strict';
import {ComputerEntries,computerUrl,entryLink,importedEntries,entryPage} from '../public/computer-entries.js';

test('independent addresses permit LAN and HTTPS but never credentials, script URLs, or token parameters',()=>{
  assert.equal(computerUrl(' http://192.168.1.20:4317/ '),'http://192.168.1.20:4317/');
  assert.equal(computerUrl('https://LAPTOP.tail.ts.net/'),'https://laptop.tail.ts.net/');
  for(const value of ['javascript:alert(1)','file:///C:/fixture','http://public.test/','https://user:password@host.test/','https://host.test/?token=secret','https://host.test/#code=12345678','https://host.test/api/bootstrap'])assert.throws(()=>computerUrl(value));
});
test('switching shares only reviewed endpoint labels and URLs, never device credentials or drafts',()=>{
  const saved=new Map(),storage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)};
  const directory=new ComputerEntries(storage);
  directory.add({name:'本机',url:'https://one.fixture.ts.net',token:'secret',draft:'private'});
  directory.add({name:'笔记本',url:'http://192.168.1.30:4317/'});
  assert.deepEqual(new ComputerEntries(storage).items,directory.items);
  const link=entryLink(directory.items[1].url,directory.items);
  assert.equal(new URL(link).search,'');assert.ok(!link.includes('secret'));assert.ok(!link.includes('private'));
  const imported=importedEntries(new URL(link).hash);assert.deepEqual(imported,directory.items);
  const other=new ComputerEntries();other.add({name:'已核对的本机',url:directory.items[0].url});other.import(imported);
  assert.equal(other.items[0].name,'已核对的本机');assert.equal(other.items.length,2);
  directory.remove(directory.items[0].url);assert.equal(new ComputerEntries(storage).items.length,1);
});
test('a saved standalone entry page works without any host scripts and escapes hostile labels',()=>{
  const html=entryPage([{name:'<script>bad()</script> "笔记本"',url:'https://laptop.fixture.ts.net/'}]);
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('src='));
  assert.ok(html.includes('https://laptop.fixture.ts.net/#codex-computers='));
  assert.equal(importedEntries('#unrelated'),null);
  assert.throws(()=>importedEntries('#codex-computers='+encodeURIComponent(JSON.stringify({version:1,entries:[{name:'伪造',url:'javascript:alert(1)'}]}))));
  assert.throws(()=>importedEntries('#codex-computers='+'a'.repeat(33000)),/过大/);
});
