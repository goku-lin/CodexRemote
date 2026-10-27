import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaSummary} from '../src/account-privacy.mjs';
test('browser quotas exclude account fields at every level and sanitize upstream error details',()=>{
  const secret={email:'private@example.invalid',account_id:'private-account',access_token:'private-access',refresh_token:'private-refresh'};
  const summary=quotaSummary({...secret,error:JSON.stringify(secret),updatedAt:100,buckets:[{...secret,id:'codex',name:'Codex',planType:'plus',windows:[{...secret,minutes:300,remainingPercent:10,resetsAt:200}],credits:{...secret,balance:'3.5',unlimited:false}}]},'pc');
  const text=JSON.stringify(summary);for(const value of Object.values(secret))assert.ok(!text.includes(value));
  assert.equal(summary.buckets[0].windows[0].remainingPercent,10);assert.equal(summary.buckets[0].credits.balance,'3.5');assert.equal(summary.updatedAt,100);
  const misleading=quotaSummary({buckets:[{id:secret.email,name:secret.email,planType:secret.email,windows:[],credits:{balance:secret.email}}]},'pc');
  assert.ok(!JSON.stringify(misleading).includes(secret.email));
});
