import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {TaskNotices,attentionLabel} from '../public/session-attention.js';
import {pendingSessions} from '../public/unread-navigation.js';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));

test('live summaries announce completion after the raw event; reconnect catches new results without replaying old history',()=>{
  const state={sessions:[],devices:[],views:new Map(),projects:[],activeSessionId:'one',selectedDeviceId:'local',usages:new Map(),historicalUsages:new Map()};
  const tracker=new TaskNotices(),notices=[];
  const context=vm.createContext({state,taskNoticeTracker:tracker,sessionPatchChanged:()=>true,
    activeSession:()=>state.sessions.find(s=>s.id===state.activeSessionId),sessionProjectId:()=>null,deviceSession:()=>null,
    restoreReceiptOwners(){},ensureSessionHistory(){},reconcileDelivery(){},scheduleRender(){},scheduleResumeSave(){},historyPreloader:{schedule(){}},
    viewFor:s=>({status:s.status}),applyRelay:view=>{view.status='done';return true;},
    observeTaskNotices:baseline=>notices.push(...tracker.observe(state.sessions,{baseline}))});
  vm.runInContext(section('function applyEvent(event)', 'function connectStream()'),context);
  const summary={id:'one',deviceId:'local',status:'done',completionToken:'old',pendingAttention:[]};
  context.applyEvent({type:'snapshot',sessions:[summary]});assert.deepEqual(notices,[]);
  context.applyEvent({...summary,type:'session',status:'running',activeTurnId:'new'});
  context.applyEvent({type:'codex',sessionId:'one',message:{method:'turn/completed'}});assert.deepEqual(notices,[]);
  context.applyEvent({...summary,type:'session',completionToken:'new'});assert.deepEqual(notices.map(n=>n.kind),['done']);
  context.applyEvent({type:'snapshot',sessions:[{...summary,completionToken:'offline-finished'}]});
  assert.deepEqual(notices.map(n=>n.kind),['done','done']);
  context.applyEvent({type:'snapshot',sessions:[{...summary,completionToken:'offline-finished'}]});assert.equal(notices.length,2);
});

test('collapsed menu badge shares pending count and clears after reading and answering, without counting running or hidden chats',()=>{
  const nodes=new Map(),node=id=>{
    if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,attributes:{},classList:{toggle(){}},setAttribute(key,value){this.attributes[key]=value;}});
    return nodes.get(id);
  };
  const state={sessions:[
    {id:'unread',deviceId:'local',status:'done',unread:true},
    {id:'question',deviceId:'local',status:'waiting_input'},
    {id:'approval',deviceId:'local',status:'waiting_approval'},
    {id:'running',deviceId:'local',status:'running'},
    {id:'hidden',deviceId:'local',status:'done',unread:true,hidden:true},
    {id:'other',deviceId:'other',status:'done',unread:true}
  ],selectedDeviceId:'local',pendingMode:false};
  const context=vm.createContext({state,$:node,pendingSessions,attentionLabel,sidebarSession:s=>s,activeSession:()=>null,readingSessions:new Set()});
  vm.runInContext(section('function renderPendingNavigation()', 'async function openNextPending()'),context);
  context.renderPendingNavigation();assert.equal(node('sidebarPendingCount').textContent,'3');assert.equal(node('sidebarPendingCount').hidden,false);
  assert.equal(node('attentionCount').textContent,'3');assert.match(node('showSidebarBtn').attributes['aria-label'],/3 条待处理/);
  state.sessions[0].unread=false;state.sessions[1].status='running';state.sessions[2].status='running';
  context.renderPendingNavigation();assert.equal(node('sidebarPendingCount').hidden,true);assert.equal(node('showSidebarBtn').attributes['aria-label'],'显示左侧栏');
  state.sessions=Array.from({length:101},(_,id)=>({id,deviceId:'local',status:'done',unread:true}));
  context.renderPendingNavigation();assert.equal(node('sidebarPendingCount').textContent,'99+');
});

test('popup, sound and background system notices are triggered by outcomes rather than sending',()=>{
  const old={id:'one',status:'done',completionToken:'old',pendingAttention:[]},state={sessions:[old],activeSessionId:'one'},items=new Map(),system=[];
  let sounds=0;
  const audio={state:'running',currentTime:0,destination:{},createOscillator:()=>({connect(){},frequency:{},start(){sounds++;},stop(){}}),createGain:()=>({connect(){},gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}}})};
  const document={hidden:false,hasFocus:()=>!document.hidden};
  const context=vm.createContext({state,document,taskNoticeTracker:new TaskNotices(),taskNoticeItems:items,sidebarSession:s=>s,
    sessionAttention:()=>[],noticeSound:true,noticeAudio:audio,sendSystemNotice:item=>system.push(item),renderTaskNotices(){},setTimeout(){}});
  vm.runInContext(section('function observeTaskNotices(', 'async function notificationWorker()'),context);
  context.observeTaskNotices(true);
  for(const status of ['starting','running','done']){state.sessions=[{...old,status}];context.observeTaskNotices();}
  assert.equal(sounds,0);assert.equal(items.size,0);assert.equal(system.length,0);
  state.sessions=[{...old,completionToken:'new'}];context.observeTaskNotices();
  assert.equal(sounds,1);assert.equal([...items.values()][0].kind,'done');assert.equal(system.length,0);
  document.hidden=true;
  state.sessions=[{...old,status:'running',activeTurnId:'third',completionToken:'new'}];context.observeTaskNotices();
  state.sessions=[{...old,status:'interrupted',completionToken:'third'}];context.observeTaskNotices();
  assert.equal(sounds,2);assert.equal(system[0].kind,'interrupted');
  context.observeTaskNotices();assert.equal(sounds,2);assert.equal(system.length,1);
});

test('failed and interrupted sessions show a useful fallback when the backend omitted an error message',()=>{
  const fragment=section('function renderViewError(view,turns)', 'function renderTurn(turn)');
  assert.match(fragment,/本回合执行失败，暂未取得具体原因/);
  assert.match(fragment,/本回合已中断，未收到完整回复/);
  assert.match(fragment,/view\.status==='failed'/);
});
