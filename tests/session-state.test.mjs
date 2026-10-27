import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionReadState } from '../src/session-read-state.mjs';
import { sessionIndicator, codexSettingsLabel, canMarkSessionRead } from '../public/session-status.js';

function directory(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-session-state-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
  return dir;
}

test('running yellow takes precedence; finished unseen replies are blue; waiting and read states remain distinguishable',()=>{
  for(const status of ['starting','running','interrupting'])assert.equal(sessionIndicator({status,unread:true}).kind,'running');
  for(const status of ['waiting_input','waiting_approval'])assert.equal(sessionIndicator({status,unread:true}).kind,'waiting');
  assert.deepEqual(sessionIndicator({status:'done',unread:true}),{kind:'unread',label:'已完成 · 未读'});
  assert.equal(sessionIndicator({status:'done',unread:false}).kind,'idle');
  assert.equal(sessionIndicator({status:'synced',unread:true}).kind,'idle');
  assert.equal(sessionIndicator({status:'failed',unread:true}).label,'执行失败');
});

test('actual model labels never use draft choices or catalog defaults and do not invent an unknown effort',()=>{
  const catalog={defaultModel:'draft',defaultEffort:'max',models:[{model:'draft',displayName:'Draft model'},{model:'actual',displayName:'GPT-6.1-Sol'}]};
  assert.equal(codexSettingsLabel({model:'draft',effort:'max'},catalog),'模型和强度尚未确认');
  assert.equal(codexSettingsLabel({nativeModel:'actual',nativeEffort:'xhigh',model:'draft',effort:'max'},catalog),'GPT-6.1 Sol · 极高');
  assert.equal(codexSettingsLabel({nativeModel:'gpt-6.1-sol',nativeEffort:'max'}),'GPT-6.1 Sol · Max');
  assert.equal(codexSettingsLabel({nativeModel:'gpt-6-astra'}),'GPT-6 Astra · 强度尚未确认');
});

test('read receipt requires the current completed reply in a visible loaded view at the latest position',()=>{
  const session={status:'done',unread:true,completionToken:'reply',source:'imported',historyVersion:'v1',loadedHistoryVersion:'v1'};
  const view={session,hidden:false,loading:false,atBottom:true,hasContent:true};
  assert.ok(canMarkSessionRead(view));
  for(const patch of [{hidden:true},{focused:false},{covered:true},{loading:true},{atBottom:false},{hasContent:false}])assert.ok(!canMarkSessionRead({...view,...patch}));
  for(const patch of [{status:'running'},{unread:false},{loadedHistoryVersion:'v0'},{completionToken:null}])assert.ok(!canMarkSessionRead({...view,session:{...session,...patch}}));
});

test('read state persists; a new completion remains unread when an older device submits its stale receipt',t=>{
  const dir=directory(t);let state=new SessionReadState(dir);
  const session={id:'shared',source:'imported',historyLoaded:true,status:'running',turns:[{id:'first',status:'inProgress',startedAt:1000}],events:[]};
  state.observe(session);assert.equal(state.status(session.id).unread,false);
  session.status='done';session.turns[0].completedAt=2000;state.observe(session);
  const first=state.status(session.id).completionToken;assert.equal(state.status(session.id).unread,true);
  state=new SessionReadState(dir);assert.equal(state.status(session.id).unread,true);
  assert.ok(state.markRead(session.id,first).changed);
  assert.equal(new SessionReadState(dir).status(session.id).unread,false);
  session.status='running';session.turns.push({id:'second',status:'inProgress',startedAt:3000});state.observe(session);
  session.status='done';session.turns[1].completedAt=4000;state.observe(session);
  assert.equal(state.markRead(session.id,first).matched,false);assert.equal(state.status(session.id).unread,true);
  assert.ok(state.markRead(session.id,state.status(session.id).completionToken).matched);
  session.nativeModel='changed';session.nativeEffort='max';session.updatedAt=9999;state.observe(session);
  assert.equal(state.status(session.id).unread,false);
});

test('existing finished history is a baseline, and restoring metadata before history does not manufacture unread replies',t=>{
  const dir=directory(t),state=new SessionReadState(dir);
  const session={id:'old',source:'imported',historyLoaded:false,status:'done',updatedAt:1000,turns:[]};
  state.observe(session);assert.equal(state.status(session.id).completionToken,null);
  session.historyLoaded=true;session.turns=[{id:'old-turn',completedAt:1000}];state.observe(session);
  assert.equal(state.status(session.id).unread,false);
  const restored=new SessionReadState(dir);restored.observe({...session,historyLoaded:false,turns:[]});
  assert.equal(restored.status(session.id).unread,false);
  const imported={id:'importing',source:'imported',historyLoaded:false,status:'running',updatedAt:2000};
  state.observe(imported);assert.equal(state.entries.importing,undefined);
  state.observe({...imported,historyLoaded:true,status:'done',turns:[{id:'already-done',completedAt:1000}]});
  assert.equal(state.status(imported.id).unread,false);
});

test('read receipts survive timestamp precision changes, history hydration and the old token format',t=>{
  const dir=directory(t);
  // The previous format starts with the actual turn UUID, rather than a format tag.
  const legacy=JSON.stringify(['old-turn',2000,'answer',1900]);
  fs.writeFileSync(path.join(dir,'session-read-state.json'),JSON.stringify({version:1,sessions:{seen:{completion:legacy,read:legacy}}}));
  const state=new SessionReadState(dir),session={id:'seen',source:'imported',historyLoaded:true,status:'done',turns:[{id:'old-turn',completedAt:2001}],events:[{type:'codex',message:{params:{turnId:'old-turn',item:{id:'hydrated-answer',type:'agentMessage',phase:'final_answer'}}},at:1001}]};
  state.observe(session);assert.equal(state.status('seen').unread,false);
  session.turns[0].completedAt=2999;session.events=[];state.observe(session);assert.equal(state.status('seen').unread,false);
  session.turns=[{id:'new-turn',completedAt:4000}];state.observe(session);assert.equal(state.status('seen').unread,true);
});
test('migration drops Desktop overrides, keeps remote receipts and preserves genuinely new unread completions',t=>{
  const dir=directory(t),current=JSON.stringify(['turn','completed']),older=JSON.stringify(['turn','older']);
  const file=path.join(dir,'session-read-state.json');
  fs.writeFileSync(file,JSON.stringify({version:2,sessions:{
    seen:{completion:current,read:current,desktop:{unread:true}},
    unseen:{completion:current,read:older,desktop:{unread:false}},
    waiting:{completion:null,read:null,desktop:{unread:true}}
  }}));
  const state=new SessionReadState(dir);
  assert.equal(state.status('seen').unread,false);assert.equal(state.status('unseen').unread,true);
  assert.equal(state.status('waiting').unread,false);assert.equal(state.status('seen').readSource,'relay');
  const migrated=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(migrated.version,3);
  assert.ok(Object.values(migrated.sessions).every(entry=>!Object.hasOwn(entry,'desktop')));
  assert.equal(state.markRead('unseen',current).matched,true);
  assert.equal(new SessionReadState(dir).status('unseen').unread,false);
  state.observe({id:'seen',source:'imported',historyLoaded:true,status:'done',turns:[{id:'newer',completedAt:4000}]});
  assert.equal(state.status('seen').unread,true);assert.equal(state.markRead('seen',current).matched,false);
});
