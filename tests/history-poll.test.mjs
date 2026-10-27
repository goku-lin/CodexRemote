import test from 'node:test';
import assert from 'node:assert/strict';
import {HistoryPoll,historyIsActive} from '../src/history-poll.mjs';

test('ended conversations get six times fewer fallback checks; active conversations and new readers stay responsive', () => {
  let now=0;const poll=new HistoryPoll({now:()=>now});
  poll.checked('idle');poll.checked('active');let idle=0,active=0;
  for(now=1000;now<=120000;now+=1000){
    if(poll.due('idle',false)){idle++;poll.checked('idle');}
    if(poll.due('active',true)){active++;poll.checked('active');}
  }
  assert.equal(idle,2);assert.equal(active,12);
  assert.equal(poll.due('new',false),true);
  poll.checked('idle');now+=10000;assert.equal(poll.due('idle',true),true);
  poll.forget('active');assert.equal(poll.checkedAt.has('active'),false);
});

test('real execution stays active, while stale native turn IDs do not keep completed or cancelled histories polling quickly', () => {
  const reader={order:['old'],turns:new Map([['old',{id:'old',status:'completed'}]]),aliases:new Map([['alias','old']])};
  assert.equal(historyIsActive(undefined),true);
  assert.equal(historyIsActive(reader),false);
  assert.equal(historyIsActive(reader,'old'),false);
  assert.equal(historyIsActive(reader,'alias'),false);
  assert.equal(historyIsActive(reader,'new'),true);
  reader.turns.get('old').status='inProgress';assert.equal(historyIsActive(reader),true);
  assert.equal(historyIsActive(reader,'old','idle'),false);
  assert.equal(historyIsActive(reader,'old','active'),true);
  reader.turns.get('old').status='interrupted';assert.equal(historyIsActive(reader,'alias'),false);
});
