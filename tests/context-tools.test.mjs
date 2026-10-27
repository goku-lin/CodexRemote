import test from 'node:test';
import assert from 'node:assert/strict';
import {ContextTools} from '../public/context-tools.js';
import {Drafts} from '../public/reliability.js';

function fixture(t,api){
  const saved=globalThis.document,nodes=new Map();
  const node=id=>{if(!nodes.has(id)){const classes=new Set(id.endsWith('Modal')?['hidden']:[]);nodes.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,focus(){},addEventListener(){},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)}});}return nodes.get(id);};
  globalThis.document={body:{insertAdjacentHTML(){}},getElementById:node,addEventListener(){}};
  let session={id:'one',threadId:'thread-one',deviceId:'local'};
  const drafts=new Drafts({getItem:()=>null,setItem(){}});drafts.set('one',{text:'Review @',attachments:[]});
  const tools=new ContextTools({api,session:()=>session,sessions:()=>[session],drafts,save(){},render:()=>tools.render(),sync:(element,html)=>element.innerHTML=html});
  t.after(()=>{clearInterval(tools.goalPoll);clearTimeout(tools.goalStrip.timer);clearTimeout(tools.searchTimer);globalThis.document=saved;});
  return {tools,drafts,node,switchSession:id=>session={id,threadId:'thread-'+id,deviceId:'local'}};
}

test('skill selection persists a removable draft chip and removes only the triggering marker',async t=>{
  const {tools,drafts,node}=fixture(t,async()=>({items:[{kind:'skill',name:'Review <safe>',path:'/skills/review'}]}));
  await tools.open('skills',{start:7,end:8});await tools.select(0);
  assert.equal(drafts.get('one').text,'Review ');assert.equal(drafts.get('one').context[0].kind,'skill');
  assert.match(node('contextChips').innerHTML,/Review &lt;safe&gt;/);assert.doesNotMatch(node('contextChips').innerHTML,/<safe>/);
  assert.equal(node('contextToolsModal').classList.contains('hidden'),true);
});

test('stale picker and goal responses cannot populate another conversation',async t=>{
  let release;const pending=new Promise(resolve=>release=resolve);
  const {tools,node,switchSession}=fixture(t,()=>pending);
  const opening=tools.open('skills');switchSession('two');tools.render();release({items:[{kind:'skill',name:'Wrong chat',path:'/wrong'}]});await opening;
  assert.doesNotMatch(node('contextResults').innerHTML,/Wrong chat/);
  tools.goalData={canControl:true,goal:{objective:'Old'}};tools.goalSession='one';tools.origin='two';
  await tools.changeGoal('set');assert.equal(tools.goalBusy,undefined,'a previous conversation capability must never authorize a new goal');
});

test('read-only goals show actual state and disable every mutation control',async t=>{
  let mutations=0;
  const {tools,node}=fixture(t,async(_url,options)=>{if(options)mutations++;return {goal:{objective:'Existing',status:'active',tokensUsed:123,tokenBudget:1000},canControl:false};});
  await tools.openGoal();assert.equal(node('goalObjective').value,'Existing');
  assert.match(node('goalToolsUsage').textContent,/123/);
  for(const name of ['Save','Pause','Resume','Clear'])assert.equal(node('goal'+name).disabled,true);
  await tools.changeGoal('pause');assert.equal(mutations,0);
});
