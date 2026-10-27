import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {DesktopReadStateReader,desktopReadSnapshot} from '../src/desktop-read-state.mjs';
import {readFixture} from './desktop-read-fixture.mjs';
test('Desktop read state uses the current account and local host without exposing credentials or merging other identities',()=>{
  const f=readFixture(),snapshot=desktopReadSnapshot(f.global,f.auth);
  assert.deepEqual(snapshot.unreadThreadIds,['unread']);assert.match(snapshot.contextKey,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(snapshot).includes('fixture-account'));assert.ok(!JSON.stringify(snapshot).includes(f.auth.tokens.id_token));
  assert.equal(desktopReadSnapshot(f.global,{tokens:{id_token:'bad'}}),null);
  f.global['electron-thread-read-state-v1'].unreadByIdentity[f.identity]['local:ambiguous']=[];
  assert.equal(desktopReadSnapshot(f.global,f.auth),null);
});
test('the reader scopes unread IDs, refreshes atomic file changes, and writes only through the official Desktop tool',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-read-state-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  const f=readFixture(['unread','private-other-project']),calls=[];
  await writeFile(path.join(directory,'auth.json'),JSON.stringify(f.auth));await writeFile(path.join(directory,'.codex-global-state.json'),JSON.stringify(f.global));
  const reader=new DesktopReadStateReader(directory,{tool:async(...args)=>calls.push(args)}),snapshot=await reader.read(['unread','seen']);
  assert.deepEqual(snapshot.unreadThreadIds,['unread']);assert.deepEqual(snapshot.scopeThreadIds,['unread','seen']);
  await assert.rejects(reader.markRead({threadId:'unread',contextKey:'wrong'},async()=>{}),/账号或已读状态/);assert.equal(calls.length,0);
  await assert.rejects(reader.markRead({threadId:'unread',contextKey:snapshot.contextKey},async()=>{throw new Error('New reply');}),/New reply/);assert.equal(calls.length,0);
  const result=await reader.markRead({threadId:'unread',contextKey:snapshot.contextKey},async()=>{});
  assert.equal(result.contextKey,snapshot.contextKey);assert.ok(result.submittedAt>0);
  assert.deepEqual(calls,[['set_thread_read_state',{threadId:'unread',hostId:'local',source:'codex',read:true}]]);
  f.global['electron-thread-read-state-v1'].unreadByIdentity[f.identity]['local:fixture']=[];
  await writeFile(path.join(directory,'.codex-global-state.json'),JSON.stringify(f.global));assert.deepEqual((await reader.read(['unread'])).unreadThreadIds,[]);
});
