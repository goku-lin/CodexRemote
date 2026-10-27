import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionAttention,attentionLabel,TaskNotices} from '../public/session-attention.js';
import {searchSessions} from '../public/session-search.js';

const question={id:'ask',turnId:'turn',delivery:'async',questions:[{id:'choice',title:'Choose a format'}]};
const session={id:'one',deviceId:'local',status:'running',activeTurnId:'turn',questionItems:new Map([['ask',question]])};
test('async questions stay visible across projects while execution continues and stop after an answer or turn end',()=>{
  assert.equal(attentionLabel(session),'待回答');
  assert.deepEqual(searchSessions([session],{filter:'waiting'}).map(item=>item.id),['one']);
  for(const answerState of ['sending','sent','answered','resolved','forwarded'])assert.deepEqual(sessionAttention({...session,questionItems:new Map([['ask',{...question,answerState}]])}),[]);
  assert.deepEqual(sessionAttention({...session,status:'done'}),[]);
  assert.deepEqual(sessionAttention({...session,activeTurnId:'replacement'}),[]);
  assert.deepEqual(sessionAttention({...session,turns:[{id:'turn',status:'completed'}]}),[]);
  assert.deepEqual(sessionAttention({...session,questionItems:new Map([['ask',{...question,questionAnswers:{choice:'PDF'}}]])}),[]);
});

test('metadata supplies unloaded pending requests and an authoritative empty snapshot removes old cached questions',()=>{
  const metadata={id:'ask',kind:'question',turnId:'turn'};
  assert.deepEqual(sessionAttention({...session,questionItems:undefined,pendingAttention:[metadata]}),[metadata]);
  assert.deepEqual(sessionAttention({...session,pendingAttention:[]},{timeline:[question]}),[]);
  assert.deepEqual(sessionAttention({...session,pendingAttention:[metadata]},{timeline:[{...question,answerState:'answered'}]}),[]);
  const events=[{message:{params:{item:question}}},{type:'question_updated',itemId:'ask',patch:{answerState:'answered'}}];
  assert.deepEqual(sessionAttention({...session,questionItems:undefined,events}),[]);
  assert.equal(question.answerState,undefined,'attention calculation does not mutate history');
});

test('reminders ignore initial and reconnect history, notify new questions once, and distinguish later completions',()=>{
  const memory=new Map(),storage={getItem:key=>memory.get(key),setItem:(key,value)=>memory.set(key,value)};
  const tracker=new TaskNotices(storage),plain={id:'one',status:'running',activeTurnId:'turn',pendingAttention:[]};
  assert.deepEqual(tracker.observe([plain],{baseline:true}),[]);
  const asking={...plain,pendingAttention:[{id:'ask',kind:'question',turnId:'turn'}]};
  assert.deepEqual(tracker.observe([asking]).map(item=>item.kind),['question']);
  assert.deepEqual(tracker.observe([asking]),[]);
  assert.deepEqual(tracker.observe([asking],{baseline:true}),[]);
  const done={...plain,status:'done',activeTurnId:null,completionToken:'first'};
  assert.deepEqual(tracker.observe([done]).map(item=>item.kind),['done']);
  assert.deepEqual(tracker.observe([done]),[]);
  tracker.observe([{...plain,activeTurnId:'second'}]);
  assert.deepEqual(tracker.observe([{...done,completionToken:'second'}]).map(item=>item.kind),['done']);
  const restored=new TaskNotices(storage);assert.deepEqual(restored.observe([asking],{baseline:true}),[]);assert.deepEqual(restored.observe([asking]),[]);
  tracker.observe([{...plain,activeTurnId:'third'}]);
  assert.deepEqual(tracker.observe([{...done,status:'failed',completionToken:'third'}],{baseline:true}),[]);
  assert.deepEqual(tracker.observe([{...done,status:'failed',completionToken:'third'}]),[]);
});

test('initial pending work remains in the list without producing a historical popup; notifications do not write on every token',()=>{
  let writes=0;const tracker=new TaskNotices({getItem:()=>null,setItem:()=>writes++});
  const first={...session,pendingAttention:[{id:'existing',kind:'approval',turnId:'turn'}],questionItems:undefined};
  assert.deepEqual(tracker.observe([first],{baseline:true}),[]);
  assert.equal(attentionLabel(first),'待审批');
  for(let i=0;i<100;i++)assert.deepEqual(tracker.observe([{...first,updatedAt:i}]),[]);
  assert.equal(writes,1);
  assert.equal(attentionLabel({status:'failed',unread:false}),'');
  assert.equal(attentionLabel({status:'failed',unread:true}),'执行失败');
});

test('sending, steering and stale completed metadata never announce the previous reply again',()=>{
  const tracker=new TaskNotices(),old={id:'one',status:'done',completionToken:'old',pendingAttention:[]};
  tracker.observe([old],{baseline:true});
  for(const status of ['starting','running','done','running','done'])assert.deepEqual(tracker.observe([{...old,status,updatedAt:Date.now()}]),[]);
  assert.deepEqual(tracker.observe([{...old,completionToken:'new'}]).map(item=>item.kind),['done']);
  assert.deepEqual(tracker.observe([{...old,completionToken:'new',updatedAt:Date.now()+1}]),[]);
});

test('new completion receipts notify even when polling missed the running state or a token was temporarily absent',()=>{
  const tracker=new TaskNotices(),old={id:'one',status:'done',completionToken:'old',pendingAttention:[]};
  tracker.observe([old],{baseline:true});
  assert.deepEqual(tracker.observe([{...old,completionToken:'new'}]).map(item=>item.kind),['done']);
  assert.deepEqual(tracker.observe([{...old,status:'starting',completionToken:null}]),[]);
  assert.deepEqual(tracker.observe([{...old,completionToken:'new'}]),[]);
  assert.deepEqual(tracker.observe([{...old,completionToken:'third'}]).map(item=>item.kind),['done']);
});

test('interruptions and failures notify once, while transient retry states and answered questions stay quiet',()=>{
  for(const status of ['interrupted','failed']){
    const tracker=new TaskNotices(),token=JSON.stringify(['turn','new']);
    tracker.observe([{id:'one',status:'running',activeTurnId:'new',completionToken:'old',pendingAttention:[]}],{baseline:true});
    assert.deepEqual(tracker.observe([{id:'one',status,completionToken:'old'}]).map(item=>item.kind),[status]);
    assert.deepEqual(tracker.observe([{id:'one',status,completionToken:token}]),[]);
    assert.deepEqual(tracker.observe([{id:'one',status,completionToken:token}]),[]);
  }
});
