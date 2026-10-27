import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSettings, sessionChoices } from '../public/composer-settings.js';
import { turnInput } from '../public/turn-controls.js';

const catalog = { defaultModel:'default', defaultEffort:'high', models:[
  {model:'default',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},
  {model:'current',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'max'}]},
  {model:'other',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}
] };

test('opening a conversation selects its confirmed model and effort over stale metadata and catalog defaults', () => {
  const session = {model:'default',effort:'low',nativeModel:'current',nativeEffort:'max',executionOwner:'desktop'};
  const settings = effectiveSettings(catalog, session);
  assert.equal(settings.model.model, 'current');
  assert.equal(settings.effort, 'max');
  const input = turnInput(session, 'Continue', [], sessionChoices(session));
  assert.equal(input.model, 'current');
  assert.equal(input.effort, 'max');
  assert.equal(input.permission, '');
});

test('manual model selection takes effect without inheriting a different model’s effort', () => {
  const session = {nativeModel:'current',nativeEffort:'max'};
  const choices = sessionChoices(session, {model:'other'});
  assert.equal(choices.model, 'other');
  assert.equal(choices.effort, '');
  assert.equal(effectiveSettings(catalog, session, choices).effort, 'medium');
  assert.equal(sessionChoices(session, {model:'current',effort:'high'}).effort, 'high');
});

test('inherited settings follow later desktop updates and never pair a confirmed model with stale effort', () => {
  const session = {model:'default',effort:'low',nativeModel:'current',nativeEffort:'max'};
  assert.equal(sessionChoices(session).effort, 'max');
  session.nativeModel = 'other';
  session.nativeEffort = null;
  assert.equal(sessionChoices(session).model, 'other');
  assert.equal(sessionChoices(session).effort, '');
  assert.equal(effectiveSettings(catalog, session).effort, 'medium');
  assert.equal(effectiveSettings(catalog, {model:'default',effort:'low'}).effort, 'low');
  assert.equal(effectiveSettings(catalog).model.model, 'default');
});

test('hidden or unavailable current models are never replaced with the catalog default', () => {
  assert.equal(effectiveSettings({...catalog,hiddenModels:['current']}, {nativeModel:'current',nativeEffort:'max'}).model.model, 'current');
  const session = {nativeModel:'unavailable',nativeEffort:'max',model:'default'};
  assert.equal(effectiveSettings(catalog, session).model, undefined);
  assert.equal(sessionChoices(session).model, 'unavailable');
});

test('an explicit Desktop permission is sent on the next input, while inheritance omits overrides and follows confirmed changes',()=>{
  const session={executionOwner:'desktop',nativePermission:'workspace-write',permission:'danger-full-access'};
  assert.equal(sessionChoices(session).permission,'','stored send metadata cannot override the Desktop implicitly');
  assert.equal(effectiveSettings(catalog,session).permission,'workspace-write');
  const chosen=sessionChoices(session,{permission:'danger-full-access'});
  assert.equal(turnInput(session,'Continue',[],chosen).permission,'danger-full-access');
  assert.equal(effectiveSettings(catalog,session,chosen).permissionPending,true);
  assert.equal(session.nativePermission,'workspace-write');
  session.nativePermission='danger-full-access';assert.equal(effectiveSettings(catalog,session,chosen).permissionPending,false);
  const inherited=sessionChoices(session,{permission:''});assert.equal(inherited.permission,'');
  session.nativePermission='read-only';assert.equal(effectiveSettings(catalog,session,inherited).permission,'read-only');
  assert.equal(effectiveSettings({...catalog,defaultPermission:'danger-full-access'},{executionOwner:'desktop'}).permission,undefined);
});

test('native Desktop Fast can be selected for one conversation and standard speed is an explicit override',()=>{
  const fastCatalog={models:[{model:'fixture',serviceTiers:[{id:'priority',name:'Fast'}]}]};
  const first={id:'first',executionOwner:'desktop',nativeModel:'fixture',nativeServiceTier:'default'};
  const second={id:'second',executionOwner:'desktop',nativeModel:'fixture',nativeServiceTier:'default'};
  const choices=sessionChoices(first,{serviceTier:'priority'});
  assert.equal(choices.serviceTier,'priority');
  const settings=effectiveSettings(fastCatalog,first,choices,{nativeFast:true});
  assert.equal(settings.fast,true);assert.equal(settings.fastReadOnly,false);assert.equal(settings.fastPending,true);
  assert.equal(turnInput(first,'Continue',[],choices).serviceTier,'priority');
  assert.equal(effectiveSettings(fastCatalog,second,{}, {nativeFast:true}).fast,false);
  first.nativeServiceTier='priority';
  assert.equal(effectiveSettings(fastCatalog,first,choices,{nativeFast:true}).fastPending,false);
  const off=effectiveSettings(fastCatalog,first,{serviceTier:'default'},{nativeFast:true});
  assert.equal(off.fast,false);assert.equal(off.fastPending,true);
  const offline=effectiveSettings(fastCatalog,first,{serviceTier:'default'});
  assert.equal(offline.fastReadOnly,true);assert.equal(offline.fast,true);
});
