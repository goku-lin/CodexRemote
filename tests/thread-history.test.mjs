import test from 'node:test';
import assert from 'node:assert/strict';
import {readPaginatedThread} from '../src/thread-history.mjs';
import {questionReplyText,normalizeQuestions} from '../public/questions.js';
import {pruneDesktopHistory} from '../src/live-desktop-events.mjs';

const turns=()=>Array.from({length:12},(_,i)=>({id:'t'+i,startedAt:i+1,completedAt:i+2,status:'completed',itemsView:'full',items:[{id:'u'+i,type:'userMessage',content:[{type:'text',text:'Request '+i}]},{id:'a'+i,type:'agentMessage',text:'Reply '+i}]})).reverse();
function rpcFor(data,calls=[]) {
  return async(method,params)=>{calls.push({method,params});const offset=Number(params.cursor || 0),page=data.slice(offset,offset+params.limit);return {data:page.map(t=>({...t,itemsView:params.itemsView,items:params.itemsView==='full'?t.items:[]})),nextCursor:offset+page.length<data.length ? String(offset+page.length):null};};
}
test('paginated history counts all turns and loads full details only for the requested visible tail',async()=>{
  const calls=[],data=turns();
  const history=await readPaginatedThread(rpcFor(data,calls),'original',5);
  assert.equal(history.turnCount,12);assert.equal(history.messageCount,null);
  assert.deepEqual(history.turns.map(t=>t.id),['t7','t8','t9','t10','t11']);
  assert.equal(history.items.length,10);assert.equal(history.authoritative,true);
  assert.deepEqual(calls.map(c=>[c.params.itemsView,c.params.limit]),[['notLoaded',100],['full',5]]);
  const all=await readPaginatedThread(rpcFor(data),'original','all');assert.equal(all.turns.length,12);assert.equal(all.messageCount,24);
  const paged=await readPaginatedThread(rpcFor(Array.from({length:206},(_,i)=>({...data[0],id:'long'+i}))),'original','all');assert.equal(paged.turnCount,206);
});

test('a smaller performance window reads only the chosen number of complete turns',async()=>{
  const calls=[];const history=await readPaginatedThread(rpcFor(turns(),calls),'original',2);
  assert.deepEqual(history.turns.map(turn=>turn.id),['t10','t11']);
  assert.deepEqual(calls.map(call=>[call.params.itemsView,call.params.limit]),[['notLoaded',100],['full',2]]);
});
test('async question responses in a later turn resolve the original card using its stable native ID',async()=>{
  const questions=normalizeQuestions([{title:'Choose?',options:['Yes']}],'ask');
  const data=[{id:'answer',itemsView:'full',status:'completed',items:[{id:'reply',type:'userMessage',content:[{type:'text',text:questionReplyText(questions,{[questions[0].id]:'Yes'})}]}]},
    {id:'question',itemsView:'full',status:'completed',items:[{id:'ask',type:'agentMessage',delivery:'async',text:'',questions:[{title:'Choose?',options:['Yes']}]}]}];
  const history=await readPaginatedThread(rpcFor(data),'original');
  assert.equal(history.items.length,1);assert.equal(history.items[0].answerState,'answered');
  assert.deepEqual(history.items[0].questionAnswers,{[questions[0].id]:'Yes'});
});
test('incomplete, cyclic or concurrently reverted pages never become a replacement history',async()=>{
  await assert.rejects(readPaginatedThread(async()=>({data:[],nextCursor:'same'}),'original'),/游标重复/);
  await assert.rejects(readPaginatedThread(async()=>({data:null}),'original'),/不完整/);
  await assert.rejects(readPaginatedThread(async(method,p)=>({data:[{...turns()[0],id:p.itemsView==='full'?'edited':'old',itemsView:p.itemsView}],nextCursor:null}),'original'),/历史已变化/);
  await assert.rejects(readPaginatedThread(async(method,p)=>({data:[{...turns()[0],itemsView:'summary'}],nextCursor:null}),'original'),/不完整/);
});
test('authoritative history removes reverted overlays while preserving events newer than the snapshot',()=>{
  const event=(turnId,at)=>({at,message:{params:{turnId,item:{id:turnId}}}});
  const session={liveItems:new Map([['old',event('old',10)],['new',event('new',30)]]),liveNotices:new Map([['old',event('old',10)]]),liveTurn:{id:'old',at:10},questionItems:new Map([['ask',{turnId:'old',at:10}]]),questionResponses:new Map([['ask',{}]])};
  pruneDesktopHistory(session,['retained'],20);
  assert.deepEqual([...session.liveItems.keys()],['new']);assert.equal(session.liveNotices.size,0);assert.equal(session.liveTurn,null);assert.equal(session.questionItems.size,0);assert.equal(session.questionResponses.size,0);
});
