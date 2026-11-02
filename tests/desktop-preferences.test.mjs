import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {desktopNewChatPermission,readDesktopNewChatPermission} from '../src/desktop-preferences.mjs';

const state=agentMode=>({'electron-persisted-atom-state':{'permission-selection-by-host-id:local':{kind:'agent-mode',agentMode},'heartbeat-thread-permissions-by-id':{other:{sandboxPolicy:{type:'dangerFullAccess'}}},privateAccount:'fixture-private-account'}});
test('new-chat permissions use the local Desktop selection rather than another thread or account fields',()=>{
  for(const [mode,permission] of [['full-access','danger-full-access'],['auto','workspace-write'],['read-only','read-only']])assert.equal(desktopNewChatPermission(state(mode)),permission);
  for(const mode of ['custom','granular','guardian-approvals','unknown'])assert.equal(desktopNewChatPermission(state(mode)),null);
  assert.equal(desktopNewChatPermission({}),null);
  assert.equal(desktopNewChatPermission({'electron-persisted-atom-state':{'permission-selection-by-host-id:remote':{kind:'agent-mode',agentMode:'full-access'}}}),null);
});
test('new-chat selection is read afresh and malformed or missing preferences never become full access',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-desktop-preference-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  const file=path.join(directory,'.codex-global-state.json');
  assert.equal(await readDesktopNewChatPermission(directory),null);
  await writeFile(file,'\ufeff'+JSON.stringify(state('full-access')));assert.equal(await readDesktopNewChatPermission(directory),'danger-full-access');
  await writeFile(file,JSON.stringify(state('read-only')));assert.equal(await readDesktopNewChatPermission(directory),'read-only');
  await writeFile(file,'{');assert.equal(await readDesktopNewChatPermission(directory),null);
});
