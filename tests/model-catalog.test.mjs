import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedModels,mergeModelCatalog} from '../src/model-catalog.mjs';

test('desktop cache contributes listed API models missing from a stale app-server catalog',()=>{
  const cache={models:[
    {slug:'gpt-6.1-terra',display_name:'GPT-6.1 Terra',visibility:'list',supported_in_api:true,default_reasoning_level:'low',supported_reasoning_levels:[{effort:'low'},{effort:'ultra'}],service_tiers:[{id:'priority'}]},
    {slug:'hidden-internal',display_name:'Internal',visibility:'hidden',supported_in_api:true},
    {slug:'not-api',display_name:'Not API',visibility:'list',supported_in_api:false}
  ]};
  const models=mergeModelCatalog([{model:'gpt-6.1-sol',displayName:'GPT-6.1 Sol'}],cache);
  assert.deepEqual(models.map(item=>item.model),['gpt-6.1-sol','gpt-6.1-terra']);
  assert.deepEqual(models[1].supportedReasoningEfforts.map(item=>item.reasoningEffort),['low','ultra']);
  assert.equal(models.some(item=>item.model==='hidden-internal'),false);
  assert.equal(models.some(item=>item.model==='not-api'),false);
});

test('app-server metadata wins when both sources contain a model',()=>{
  const result=mergeModelCatalog([{model:'gpt-6.1-terra',displayName:'fresh desktop response',defaultReasoningEffort:'max'}],{models:[{slug:'gpt-6.1-terra',display_name:'stale cache',visibility:'list',supported_in_api:true}]});
  assert.deepEqual(result,[{model:'gpt-6.1-terra',displayName:'fresh desktop response',defaultReasoningEffort:'max'}]);
});

test('malformed cache contributes no models',()=>{assert.deepEqual(cachedModels(null),[]);assert.deepEqual(cachedModels({models:[null,{}, {slug:'x',visibility:'list',supported_in_api:false}]}),[]);});
