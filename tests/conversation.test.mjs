import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {contextFromText} from '../public/context-state.js';
import {performanceSettings} from '../public/performance-settings.js';
import {itemTiming,commandTiming} from '../public/command-timing.js';
import { readFile } from 'node:fs/promises';
import { runtimeNotice, composerModelLabel } from '../public/runtime-status.js';
import { normalizeQuestions } from '../public/questions.js';
import {Drafts,LiveConnection} from '../public/reliability.js';
import { sessionIndicator, codexSettingsLabel, canMarkSessionRead } from '../public/session-status.js';
import {projectCounts,quotaWindowName,compactTokens,TokenRateTracker} from '../public/usage.js';
import {usagePeriod,usageRangeKey} from '../public/usage-range.js';
import {TimelineViewport} from '../public/timeline-scroll.js';
import {turnControls,turnInput} from '../public/turn-controls.js';
import {approvalChoices} from '../public/native-requests.js';
import {ImageUploads} from '../public/uploads.js';
import {selectableModels,preferredModel} from '../public/model-preferences.js';
import {DirectConnections,requestDevice,peerResponse} from '../public/direct-connection.js';
import {sessionChoices,effectiveSettings,effortLabels,projectsForDevice} from '../public/composer-settings.js';
import {applyHistoryUpdate} from '../public/history-sync.js';
import {HistoryPreloader} from '../public/history-preload.js';
import {HistorySync} from '../src/history-sync.mjs';
import {TextRenderCache} from '../public/render-cache.js';
import {MediaCards} from '../public/media-cards.js';
import {mediaKind} from '../public/media-types.js';
import {searchSessions,sessionSearchActive,sessionFilterLabels} from '../public/session-search.js';
import {sessionAttention,attentionLabel,TaskNotices} from '../public/session-attention.js';
import {ProjectOrder} from '../public/project-order.js';
import {ProjectManagement} from '../public/project-management.js';
import {ProjectSorter} from '../public/project-sort.js';
import {deviceName as validateComputerName} from '../public/device-names.js';
import {unreadSessions,nextUnreadSession,pendingSessions,nextPendingSession} from '../public/unread-navigation.js';
import {isLocalHtml,isLocalDocument,htmlPreviewUrl,htmlLinkMatches} from '../public/html-links.js';
import {ResumeCache,resumeSnapshot} from '../public/resume-cache.js';
import {connectionExperience} from '../public/connection-state.js';

const fullSource = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/gm, '');
const source = fullSource.split("$('newTaskBtn').onclick")[0];
const ui = vm.createContext({ localStorage: { getItem: () => null }, console, runtimeNotice, composerModelLabel, normalizeQuestions, Drafts, LiveConnection, sessionIndicator, codexSettingsLabel, canMarkSessionRead,projectCounts,quotaWindowName,compactTokens,TokenRateTracker,usagePeriod,usageRangeKey,TimelineViewport,turnControls,turnInput,approvalChoices,ImageUploads,selectableModels,preferredModel,DirectConnections,requestDevice,peerResponse,sessionChoices,effectiveSettings,effortLabels,projectsForDevice,applyHistoryUpdate,HistoryPreloader,TextRenderCache,MediaCards,mediaKind,searchSessions,sessionSearchActive,sessionFilterLabels,sessionAttention,attentionLabel,TaskNotices,ProjectOrder,ProjectManagement,ProjectSorter,validateComputerName,unreadSessions,nextUnreadSession,pendingSessions,nextPendingSession,isLocalHtml,isLocalDocument,htmlPreviewUrl,htmlLinkMatches,contextFromText,performanceSettings,itemTiming,commandTiming,ResumeCache,resumeSnapshot,connectionExperience });
vm.runInContext(source, ui);
const invoke = (name, ...args) => ui[name](...args);

test('a lost inline edit response retains its request, edited text, images and separate composer draft',async()=>{
  const names=['api','scheduleRender','requestId','choicesFor'],old=new Map(names.map(name=>[name,ui[name]])),calls=[];
  vm.runInContext("var editTestSaved=state.sessions;state.sessions=[...state.sessions,{id:'edit-test',deviceId:'local'}];drafts.set('edit-test',{text:'底部草稿',attachments:[{id:'draft-image'}],edit:{messageId:'user',text:'编辑后的内容',images:[{ref:'original-image'}],expectedToken:'token',expectedLastTurnId:'last'}})",ui);
  ui.scheduleRender=()=>{};ui.requestId=()=> 'editclient0123456789';ui.choicesFor=()=>({model:'fixture'});
  ui.api=async(url,options)=>{calls.push({url,body:options ? JSON.parse(options.body) : null});if(options)throw new Error('lost response');return {found:false};};
  try {
    await invoke('submitMessageEdit','edit-test');assert.equal(vm.runInContext("drafts.get('edit-test').edit.submission.state",ui),'not-found');
    ui.api=async(url,options)=>{calls.push({url,body:options ? JSON.parse(options.body) : null});return {delivery:{id:'editclient0123456789',sessionId:'edit-test',state:'accepted'}};};
    await invoke('submitMessageEdit','edit-test');const posts=calls.filter(call=>call.body);assert.deepEqual(posts[0].body,posts[1].body);
    const draft=vm.runInContext("drafts.get('edit-test')",ui);assert.equal(draft.text,'底部草稿');assert.equal(draft.attachments[0].id,'draft-image');assert.ok(!draft.edit);
  } finally {for(const [name,value] of old)ui[name]=value;vm.runInContext("state.sessions=editTestSaved;delete drafts.items['edit-test']",ui);}
});

test('Fast mode is scoped to the active conversation and never written as a device default',()=>{
  assert.match(fullSource,/if \(!session\) return;/);
  assert.match(fullSource,/state\.sessionsChoices\[session\.id\]=choices/);
  assert.match(source,/const session=activeSession\(\), key=session\?\.id \|\| settingsKey\(\);/);
  assert.match(fullSource,/Never retain a stale device-wide Fast flag/);
});

test('foreground resume keeps the existing stream while still checking unresolved inputs',()=>{
  const connection=vm.runInContext('liveConnection',ui),saved={stream:connection.stream,status:connection.status,lastReceived:connection.lastReceived,blocked:connection.blocked};
  const previousReconcile=ui.reconcilePendingInputs;let checks=0;
  const stream={readyState:1,close(){throw new Error('Healthy connection must not close');}};
  ui.reconcilePendingInputs=()=>checks++;
  vm.runInContext('var resumeUiSavedStream=state.stream',ui);
  try{
    connection.stream=stream;connection.status='connected';connection.lastReceived=Date.now();connection.blocked=false;
    invoke('resumeStream');
    assert.equal(connection.stream,stream);assert.equal(checks,1);
    assert.equal(vm.runInContext('state.stream',ui),stream);
  }finally{Object.assign(connection,saved);ui.reconcilePendingInputs=previousReconcile;vm.runInContext('state.stream=resumeUiSavedStream',ui);}
});

test('native visualization cards render an on-demand interactive link including Windows directory parentheses',()=>{
  const ref='D:/Program Files (x86)/Steam/Mods/[MTK]Core/Preview/ability-effects.html';
  const html=invoke('inlineMarkdown','visualize'+JSON.stringify({path:ref})+'');
  // No active conversation must not invent a file URL or eagerly load the HTML.
  assert.doesNotMatch(html,/<iframe|<script|<img|visualize/);
  vm.runInContext("var visualizeSavedSession=state.activeSessionId;state.activeSessionId='visualize-chat'",ui);
  try{
    const link=invoke('inlineMarkdown','visualize'+JSON.stringify({path:ref})+'');
    assert.match(link,/\/api\/sessions\/visualize-chat\/preview\//);
    assert.match(link,/ability-effects\.html\?interactive=1/);
    assert.match(link,/播放／切换效果/);assert.doesNotMatch(link,/<iframe|<script|<img/);
    const markdown=invoke('inlineMarkdown','[看效果]('+ref+')');
    assert.match(markdown,/打开 HTML 预览/);assert.match(markdown,/交互预览/);assert.doesNotMatch(markdown,/\)\/Steam/);
  }finally{vm.runInContext('state.activeSessionId=visualizeSavedSession',ui);}
});
test('a lost withdrawal response is reconciled once and retains both existing draft and withdrawn images',async()=>{
  const names=['api','scheduleRender','requestId'],old=new Map(names.map(name=>[name,ui[name]]));
  const item={id:'queue-test',revision:1,state:'waiting',text:'撤回内容',attachments:[{id:'image'}]};ui.queueTestItem=item;
  vm.runInContext("var queueTestSaved=state.sessions;state.sessions=[...state.sessions,{id:'queue-test-session',queuedInputs:[queueTestItem]}];drafts.set('queue-test-session',{text:'原草稿',attachments:[]})",ui);
  ui.scheduleRender=()=>{};ui.requestId=()=> 'withdrawclient012345';
  ui.api=async(url,options)=>{if(options)throw new Error('lost response');return {found:true,id:'withdrawclient012345',sessionId:'queue-test-session',state:'accepted',response:{item}};};
  try {await invoke('queuedInputAction','queue-test-session',item.id,'withdraw');const draft=vm.runInContext("drafts.get('queue-test-session')",ui);assert.equal(draft.text,'原草稿\n\n撤回内容');assert.equal(draft.attachments[0].id,'image');assert.ok(!draft.queueAction);}
  finally {for(const [name,value] of old)ui[name]=value;vm.runInContext("state.sessions=queueTestSaved;delete drafts.items['queue-test-session']",ui);}
});

test('Send waits for upload confirmation before submitting text and images; failed uploads submit no message',async()=>{
  const names=['api','renderComposer','choicesFor','reconcileDelivery','requestId'],saved=new Map(names.map(name=>[name,ui[name]])),oldDocument=ui.document;
  const uploads=vm.runInContext('imageUploads',ui),oldRead=uploads.read,oldNewId=uploads.newId;
  const nodes=new Map([['promptInput',{value:'文字和图片一起发送'}],['sendBtn',{disabled:false}],['composeError',{textContent:''}]]);
  ui.document={getElementById:id=>nodes.get(id)};ui.renderComposer=()=>{};ui.choicesFor=()=>({});ui.reconcileDelivery=async()=>{};ui.requestId=()=> 'send-picture-message';
  vm.runInContext("var uploadSaved={sessions:state.sessions,active:state.activeSessionId,attachments:state.attachments,composer:composerSessionId};state.sessions=[{id:'send-picture',status:'done',threadId:'thread'}];state.activeSessionId='send-picture';composerSessionId='send-picture';state.attachments=[];drafts.set('send-picture',{text:'文字和图片一起发送',attachments:[]})",ui);
  const pictureId='12345678-1234-1234-1234-123456789abc',image={id:pictureId,name:'local.png',url:'/api/uploads/'+pictureId};
  uploads.read=async()=> 'data:image/png;base64,iVBORw0KGgo=';uploads.newId=()=>pictureId;
  const file={name:image.name,type:'image/png',size:8},calls=[];let release,started;
  const gate=new Promise(resolve=>release=resolve),uploadStarted=new Promise(resolve=>started=resolve);
  ui.api=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});if(url==='/api/uploads'){started();await gate;return image;}return {};};
  try{
    await uploads.add('send-picture',file);assert.equal(calls.length,0);
    const sending=invoke('sendTurn');await uploadStarted;assert.deepEqual(calls.map(value=>value.url),['/api/uploads']);
    release();await sending;
    assert.deepEqual(calls.map(value=>value.url),['/api/uploads','/api/sessions/send-picture/turns']);
    assert.equal(calls[1].body.text,'文字和图片一起发送');assert.deepEqual(calls[1].body.attachments,[pictureId]);
    calls.length=0;
    vm.runInContext("state.attachments=[];drafts.set('send-picture',{text:'文字和图片一起发送',attachments:[]})",ui);
    ui.api=async(url)=>{calls.push({url});if(url==='/api/uploads')throw new Error('timeout');return {found:false};};
    await uploads.add('send-picture',file);await invoke('sendTurn');
    assert.ok(!calls.some(value=>value.url.includes('/turns')));assert.match(nodes.get('composeError').textContent,/尚未上传完成/);
    assert.equal(nodes.get('promptInput').value,'文字和图片一起发送');assert.equal(uploads.list('send-picture').length,1);
  }finally{
    uploads.tasks.clear();uploads.read=oldRead;uploads.newId=oldNewId;
    vm.runInContext("state.sessions=uploadSaved.sessions;state.activeSessionId=uploadSaved.active;state.attachments=uploadSaved.attachments;composerSessionId=uploadSaved.composer;state.sending=false;state.uploading=0;delete drafts.items['send-picture'];pendingSends.delete('send-picture')",ui);
    ui.document=oldDocument;for(const [name,value] of saved)ui[name]=value;
  }
});

test('a capacity error is displayed once with useful recovery guidance; a different error remains visible',()=>{
  const error='Selected model is at capacity. Please try a different model.';
  const turn={id:'capacity',status:'failed',items:[{id:'user',type:'userMessage',text:'继续'}],alert:{message:error}};
  const html=invoke('renderTurn',turn)+invoke('renderViewError',{error},[turn]);
  assert.equal((html.match(/Selected model is at capacity/g) || []).length,1);
  assert.match(html,/模型暂时繁忙/);assert.match(html,/这次请求未完成/);
  assert.match(invoke('renderViewError',{error:'另一个连接错误'},[turn]),/另一个连接错误/);
});

test('long running process groups render the newest window and earlier operations remain accessible',()=>{
  const items=Array.from({length:600},(_,index)=>({id:'operation-'+index,type:'commandExecution',command:'echo operation-'+index}));
  let html=invoke('renderLiveProcessGroup',items,'resource-test');
  assert.match(html,/已执行 600 条命令/);assert.equal((html.match(/class="process-item"/g) || []).length,0);
  vm.runInContext("state.openDetailKeys.add('resource-test:group')",ui);
  html=invoke('renderLiveProcessGroup',items,'resource-test');
  assert.equal((html.match(/class="process-item"/g) || []).length,200);
  assert.match(html,/显示较早的 400 项操作/);
  assert.doesNotMatch(html,/echo operation-0</);
  assert.match(html,/echo operation-599/);
  vm.runInContext("state.processLimits.set('resource-test',400)",ui);
  html=invoke('renderLiveProcessGroup',items,'resource-test');
  assert.equal((html.match(/class="process-item"/g) || []).length,400);
  assert.match(html,/显示较早的 200 项操作/);
  vm.runInContext("state.processLimits.delete('resource-test');state.openDetailKeys.delete('resource-test:group')",ui);
});

test('view cache keeps the active conversation, reloads evicted history and preserves drafts',()=>{
  vm.runInContext("var cacheSaved={views:state.views,sessions:state.sessions,active:state.activeSessionId};state.views=new Map();state.sessions=[];state.activeSessionId='cache-0';drafts.set('cache-1',{text:'未发送的草稿',attachments:[]})",ui);
  try{
    for(let n=0;n<12;n++){
      const session={id:'cache-'+n,source:'imported',status:'done',historyLoaded:true,historyVersion:'v1',loadedHistoryVersion:'v1',loadedHistoryLimit:5,events:[{type:'user_message',text:'历史',at:1}]};
      ui.cacheSession=session;vm.runInContext('state.sessions.push(cacheSession)',ui);invoke('viewFor',session);
    }
    assert.equal(vm.runInContext('state.views.size',ui),8);
    assert.ok(vm.runInContext("state.views.has('cache-0')",ui));
    assert.equal(vm.runInContext("state.sessions.find(value=>value.id==='cache-1').events.length",ui),0);
    assert.equal(vm.runInContext("state.sessions.find(value=>value.id==='cache-1').loadedHistoryVersion",ui),null);
    assert.equal(vm.runInContext("drafts.get('cache-1').text",ui),'未发送的草稿');
  }finally{
    vm.runInContext("state.views=cacheSaved.views;state.sessions=cacheSaved.sessions;state.activeSessionId=cacheSaved.active;delete drafts.items['cache-1']",ui);
    delete ui.cacheSession;
  }
});

test('sidebar conversations expand by five or all, collapse, and remember each project independently',()=>{
  const saved=new Map(['projectList','syncHtml'].map(name=>[name,ui[name]])),previousDocument=ui.document;
  const list={innerHTML:''},buttons=new Map();
  ui.document={getElementById:id=>id==='projectList' ? list : null,querySelectorAll:selector=>buttons.get(selector) || []};
  ui.syncHtml=(node,html)=>{
    node.innerHTML=html;buttons.clear();
    for(const attribute of ['project','project-more','project-all','project-recent']){
      const key=attribute.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
      buttons.set(`[data-${attribute}]`,[...html.matchAll(new RegExp(`data-${attribute}="([^"]+)"`,'g'))].map(match=>({dataset:{[key]:match[1]},focus(){}})));
    }
  };
  const sessions=(id,count)=>Array.from({length:count},(_,i)=>({id:id+'-'+i,title:'Conversation '+i,deviceId:'local',status:'done',updatedAt:count-i}));
  ui.paginationProjects=[{id:'alpha',name:'Alpha',sessions:sessions('a',13)},{id:'beta',name:'Beta',sessions:sessions('b',7)}];
  ui.projectList=()=>ui.paginationProjects;
  vm.runInContext('var paginationSaved={limits:state.sessionListLimits,collapsed:state.collapsedProjects};state.sessionListLimits=new Map();state.collapsedProjects=new Set()',ui);
  const count=()=> (list.innerHTML.match(/data-session=/g) || []).length;
  const click=(attribute,id)=>buttons.get(`[data-${attribute}]`).find(button=>Object.values(button.dataset).includes(id)).onclick();
  try{
    const previousRender=ui.renderSessions;ui.renderSessions=()=>invoke('renderProjects');
    try{
      invoke('renderProjects');assert.equal(count(),10);assert.ok(list.innerHTML.indexOf('data-session="a-0"')<list.innerHTML.indexOf('Beta'));
      click('project-more','alpha');assert.equal(count(),15);assert.match(list.innerHTML,/再显示 3 条/);
      click('project-all','alpha');assert.equal(count(),18);
      click('project-more','beta');assert.equal(count(),20);assert.equal(vm.runInContext("state.sessionListLimits.get('alpha')",ui),'all');
      click('project','alpha');assert.match(list.innerHTML,/data-project="alpha" aria-expanded="false"/);assert.match(list.innerHTML,/class="project-chats hidden"/);
      click('project','alpha');assert.match(list.innerHTML,/data-project="alpha" aria-expanded="true"/);
      click('project-recent','alpha');assert.equal(count(),12);assert.equal(vm.runInContext("state.sessionListLimits.get('beta')",ui),10);
    }finally{ui.renderSessions=previousRender;}
  }finally{
    ui.document=previousDocument;for(const [name,value] of saved)ui[name]=value;
    vm.runInContext('state.sessionListLimits=paginationSaved.limits;state.collapsedProjects=paginationSaved.collapsed',ui);delete ui.paginationProjects;
  }
});

test('combined project management preserves display choices while sorting and leaves the current chat and disclosures intact',()=>{
  const saved=new Map(['syncHtml','renderSessions','api'].map(name=>[name,ui[name]])),previousDocument=ui.document;
  const list={innerHTML:'',querySelectorAll:selector=>buttons.get(selector) || []},sidebar={innerHTML:''},buttons=new Map();
  ui.document={getElementById:id=>id==='projectChoices' ? list : id==='projectList' ? sidebar : null,querySelectorAll:()=>[]};
  ui.syncHtml=(node,html)=>{
    node.innerHTML=html;if(node!==list)return;buttons.clear();
    for(const attribute of ['project-enabled','project-drag']){
      const key=attribute.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
      buttons.set(`[data-${attribute}]`,[...html.matchAll(new RegExp(`data-${attribute}="([^"]+)"`,'g'))].map(match=>({dataset:{[key]:match[1]},focus(){}})));
    }
  };
  ui.renderSessions=()=>invoke('renderProjects');ui.api=()=>assert.fail('sorting must not request history or send a command');
  vm.runInContext("var orderUiSaved={sessions:state.sessions,selected:state.selectedDeviceId,active:state.activeSessionId,collapsed:state.collapsedProjects,manager:projectManager,sorter:projectSorter,orders:projectOrder.devices};state.sessions=['a','b','c'].map((id,i)=>({id,projectId:'p:'+id,projectName:id,deviceId:'local',status:'done',updatedAt:30-i}));state.selectedDeviceId='local';state.activeSessionId='a';state.collapsedProjects=new Set(['p:b']);projectOrder.devices=new Map()",ui);
  const ids=()=>[...sidebar.innerHTML.matchAll(/data-project="([^"]+)"/g)].map(match=>match[1]);
  const draftIds=()=>[...list.innerHTML.matchAll(/data-project-enabled="([^"]+)"/g)].map(match=>match[1]);
  try{
    invoke('renderProjects');assert.deepEqual(ids(),['p:a','p:b','p:c']);
    vm.runInContext('state.sessions[1].updatedAt=1000',ui);invoke('renderProjects');assert.deepEqual(ids(),['p:a','p:b','p:c']);
    vm.runInContext("projectManager=new ProjectManagement(projectList().map(project=>({...project,deviceId:'local'})),projectOrder,'local')",ui);invoke('renderProjectManagement');
    const enabled=buttons.get('[data-project-enabled]').find(item=>item.dataset.projectEnabled==='p:a');enabled.checked=false;enabled.onchange();
    const sorter=vm.runInContext('projectSorter',ui);sorter.onMove('p:c',0);assert.deepEqual(draftIds(),['p:c','p:a','p:b']);
    assert.equal(buttons.get('[data-project-drag]').length,3);assert.doesNotMatch(list.innerHTML,/<select|data-project-up|data-project-down/);
    assert.equal(buttons.get('[data-project-enabled]').find(item=>item.dataset.projectEnabled==='p:a').checked,false);
    sorter.onMove('p:a',0);assert.deepEqual(draftIds(),['p:a','p:c','p:b']);
    sorter.onMove('p:a',1);assert.deepEqual(draftIds(),['p:c','p:a','p:b']);
    invoke('renderProjects');assert.deepEqual(ids(),['p:a','p:b','p:c'],'sorting is a draft until Save');
    vm.runInContext('projectManager.commit(projectOrder)',ui);invoke('renderProjects');assert.deepEqual(ids(),['p:c','p:a','p:b']);
    assert.match(sidebar.innerHTML,/data-project="p:b" aria-expanded="false"/);assert.match(sidebar.innerHTML,/data-project="p:a" aria-expanded="true"/);
    assert.equal(vm.runInContext('state.activeSessionId',ui),'a');
  }finally{
    vm.runInContext('state.sessions=orderUiSaved.sessions;state.selectedDeviceId=orderUiSaved.selected;state.activeSessionId=orderUiSaved.active;state.collapsedProjects=orderUiSaved.collapsed;projectManager=orderUiSaved.manager;projectSorter=orderUiSaved.sorter;projectOrder.devices=orderUiSaved.orders',ui);
    ui.document=previousDocument;for(const [name,value] of saved)ui[name]=value;
  }
});

test('next unread handles repeated taps once and waits for navigation without clearing unseen markers',async()=>{
  const saved=new Map(['openSession','renderPendingNavigation'].map(name=>[name,ui[name]])),calls=[];
  let release;const gate=new Promise(resolve=>release=resolve);
  vm.runInContext("var unreadTapSaved={sessions:state.sessions,selected:state.selectedDeviceId,active:state.activeSessionId,mode:state.pendingMode,switching:state.pendingSwitching,visit:state.unreadVisit};state.sessions=[{id:'tap-a',deviceId:'local',status:'done',unread:true,updatedAt:2},{id:'tap-b',deviceId:'local',status:'done',unread:true,updatedAt:1}];state.selectedDeviceId='local';state.activeSessionId='tap-a';state.pendingSwitching=false;state.unreadVisit=null",ui);
  ui.renderPendingNavigation=()=>{};ui.openSession=async(id,options)=>{calls.push({id,options});await gate;};
  try{
    const first=invoke('openNextPending');await invoke('openNextPending');assert.equal(calls.length,1);assert.equal(calls[0].id,'tap-b');assert.equal(calls[0].options.unread,true);
    assert.ok(vm.runInContext('state.sessions.every(session=>session.unread)',ui));release();await first;assert.equal(vm.runInContext('state.pendingSwitching',ui),false);
  }finally{release();for(const [name,value] of saved)ui[name]=value;vm.runInContext('state.sessions=unreadTapSaved.sessions;state.selectedDeviceId=unreadTapSaved.selected;state.activeSessionId=unreadTapSaved.active;state.pendingMode=unreadTapSaved.mode;state.pendingSwitching=unreadTapSaved.switching;state.unreadVisit=unreadTapSaved.visit',ui);}
});

test('next handling cycles through all unread replies, live questions and approvals without treating questions as read',async()=>{
  const names=['openSession','renderPendingNavigation'],saved=new Map(names.map(name=>[name,ui[name]])),calls=[];
  vm.runInContext("var pendingCycleSaved={sessions:state.sessions,active:state.activeSessionId,selected:state.selectedDeviceId,mode:state.pendingMode,switching:state.pendingSwitching};state.sessions=[{id:'reply',deviceId:'local',status:'done',unread:true,updatedAt:30},{id:'question',deviceId:'local',status:'running',updatedAt:20,pendingAttention:[{id:'ask',kind:'question'}]},{id:'approval',deviceId:'local',status:'waiting_approval',updatedAt:10}];state.activeSessionId='reply';state.selectedDeviceId='local';state.pendingSwitching=false;",ui);
  ui.renderPendingNavigation=()=>{};ui.openSession=async(id,options)=>{calls.push({id,options});ui.pendingCycleId=id;vm.runInContext('state.activeSessionId=pendingCycleId',ui);};
  try{
    await invoke('openNextPending');await invoke('openNextPending');await invoke('openNextPending');
    assert.deepEqual(calls.map(call=>call.id),['question','approval','reply']);
    assert.equal(calls[0].options.attention,true);assert.equal(calls[0].options.unread,false);
    assert.equal(calls[1].options.attention,true);assert.equal(calls[2].options.unread,true);
    assert.equal(vm.runInContext("state.sessions[1].pendingAttention.length",ui),1,'visiting a question does not answer or dismiss it');
  }finally{
    vm.runInContext('state.sessions=pendingCycleSaved.sessions;state.activeSessionId=pendingCycleSaved.active;state.selectedDeviceId=pendingCycleSaved.selected;state.pendingMode=pendingCycleSaved.mode;state.pendingSwitching=pendingCycleSaved.switching;',ui);
    for(const [name,value] of saved)ui[name]=value;delete ui.pendingCycleId;
  }
});

test('unread navigation preserves voice input and pictures and restores the next conversation draft',async()=>{
  const previousDocument=ui.document,saved=new Map(['render','requestCatalog','closeMobileNavigation','ensureSessionHistory'].map(name=>[name,ui[name]]));
  const prompt={value:'手机语音输入还没有发送'};ui.document={getElementById:id=>id==='promptInput' ? prompt : null};
  vm.runInContext("var unreadDraftSaved={sessions:state.sessions,selected:state.selectedDeviceId,active:state.activeSessionId,project:state.activeProjectId,attachments:state.attachments,composer:composerSessionId,visit:state.unreadVisit,focus:state.attentionFocus,orders:projectOrder.devices,collapsed:new Set(state.collapsedProjects),limits:new Map(state.sessionListLimits)};state.sessions=[{id:'voice-a',deviceId:'local',projectId:'voice-project-a',status:'done'},{id:'voice-b',deviceId:'local',projectId:'voice-project-b',status:'done',unread:true}];state.activeSessionId='voice-a';state.selectedDeviceId='local';composerSessionId='voice-a';state.attachments=[{id:'voice-picture'}];drafts.set('voice-b',{text:'下一条自己的草稿',attachments:[]});projectOrder.devices=new Map()",ui);
  ui.render=()=>invoke('restoreDraft',vm.runInContext('state.activeSessionId',ui));ui.requestCatalog=()=>{};ui.closeMobileNavigation=()=>{};ui.ensureSessionHistory=async()=>{};
  try{
    await invoke('openSession','voice-b',{unread:true});
    const previous=vm.runInContext("drafts.get('voice-a')",ui);assert.equal(previous.text,'手机语音输入还没有发送');assert.equal(previous.attachments[0].id,'voice-picture');
    assert.equal(prompt.value,'下一条自己的草稿');assert.equal(vm.runInContext('state.unreadVisit.id',ui),'voice-b');
  }finally{
    vm.runInContext('state.sessions=unreadDraftSaved.sessions;state.selectedDeviceId=unreadDraftSaved.selected;state.activeSessionId=unreadDraftSaved.active;state.activeProjectId=unreadDraftSaved.project;state.attachments=unreadDraftSaved.attachments;composerSessionId=unreadDraftSaved.composer;state.unreadVisit=unreadDraftSaved.visit;state.attentionFocus=unreadDraftSaved.focus;projectOrder.devices=unreadDraftSaved.orders;state.collapsedProjects=unreadDraftSaved.collapsed;state.sessionListLimits=unreadDraftSaved.limits;delete drafts.items["voice-a"];delete drafts.items["voice-b"]',ui);
    ui.document=previousDocument;for(const [name,value] of saved)ui[name]=value;
  }
});

test('unread receipt waits for loaded history and server confirmation; failed receipts keep the marker without repeated writes',async()=>{
  const previousDocument=ui.document,saved=new Map(['api','applyEvent','renderPendingNavigation'].map(name=>[name,ui[name]]));
  const messages={scrollTop:0,scrollHeight:1000,clientHeight:200};
  ui.document={hidden:false,hasFocus:()=>true,getElementById:id=>id==='messages' ? messages : {classList:{contains:()=>false}},querySelector:()=>null};
  vm.runInContext("var unreadReceiptSaved={sessions:state.sessions,active:state.activeSessionId,visit:state.unreadVisit,rendered:renderedSessionId};state.sessions=[{id:'unread-receipt',status:'done',source:'imported',unread:true,completionToken:'reply',historyVersion:'v1',loadedHistoryVersion:'older',events:[{type:'thread_ready'}]}];state.activeSessionId='unread-receipt';state.unreadVisit={id:'unread-receipt',positioned:true,token:'reply'};renderedSessionId='unread-receipt'",ui);
  const calls=[];let release;ui.renderPendingNavigation=()=>{};
  ui.api=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Promise(resolve=>release=resolve);};
  ui.applyEvent=event=>{ui.readReceiptEvent=event;vm.runInContext('Object.assign(state.sessions[0],readReceiptEvent)',ui);};
  try{
    await invoke('maybeMarkSessionRead');assert.equal(calls.length,0);
    vm.runInContext("state.sessions[0].loadedHistoryVersion='v1'",ui);
    const reading=invoke('maybeMarkSessionRead');await invoke('maybeMarkSessionRead');assert.equal(calls.length,1);assert.equal(calls[0].body.completionToken,'reply');
    assert.equal(vm.runInContext('state.sessions[0].unread',ui),true);
    release({session:{id:'unread-receipt',unread:false}});await reading;assert.equal(vm.runInContext('state.sessions[0].unread',ui),false);
    vm.runInContext("state.sessions[0].unread=true;state.unreadVisit={id:'unread-receipt',positioned:true,token:'reply'}",ui);
    ui.api=async()=>{calls.push('failure');throw new Error('offline');};await invoke('maybeMarkSessionRead');await invoke('maybeMarkSessionRead');
    assert.equal(calls.length,2);assert.equal(vm.runInContext('state.sessions[0].unread',ui),true);assert.equal(vm.runInContext('state.unreadVisit.error',ui),true);
    vm.runInContext("state.unreadVisit={id:'unread-receipt',positioned:true,token:'older-reply'}",ui);await invoke('maybeMarkSessionRead');assert.equal(calls.length,2,'a navigation intent cannot acknowledge a later completion');
  }finally{vm.runInContext("state.sessions=unreadReceiptSaved.sessions;state.activeSessionId=unreadReceiptSaved.active;state.unreadVisit=unreadReceiptSaved.visit;renderedSessionId=unreadReceiptSaved.rendered;readingSessions.delete('unread-receipt:reply')",ui);ui.document=previousDocument;for(const [name,value] of saved)ui[name]=value;delete ui.readReceiptEvent;}
});

test('first unread history load binds the receipt to the reply that becomes visible, rather than its missing initial token',async()=>{
  const previousDocument=ui.document,saved=new Map(['api','applyEvent','renderPendingNavigation'].map(name=>[name,ui[name]])),calls=[];
  const result={getBoundingClientRect:()=>({top:320})},turn={querySelector:()=>result};
  const messages={scrollTop:0,scrollHeight:1000,clientHeight:200,getBoundingClientRect:()=>({top:100}),querySelectorAll:()=>[turn]};
  ui.document={hidden:false,hasFocus:()=>true,getElementById:id=>id==='messages' ? messages : {classList:{contains:()=>false}},querySelector:()=>null};
  vm.runInContext("var firstUnreadSaved={sessions:state.sessions,active:state.activeSessionId,visit:state.unreadVisit,rendered:renderedSessionId};state.sessions=[{id:'first-unread',status:'done',source:'imported',unread:true,completionToken:null,historyLoaded:false,events:[]}];state.activeSessionId='first-unread';state.unreadVisit={id:'first-unread',positioned:false,token:null};renderedSessionId='first-unread'",ui);
  ui.renderPendingNavigation=()=>{};ui.applyEvent=()=>{};ui.api=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {session:{id:'first-unread',unread:false}};};
  try{
    await invoke('maybeMarkSessionRead');assert.equal(calls.length,0);
    vm.runInContext("Object.assign(state.sessions[0],{historyLoaded:true,historyVersion:'loaded',loadedHistoryVersion:'loaded',completionToken:'loaded-reply',events:[{type:'thread_ready'}]})",ui);
    await invoke('maybeMarkSessionRead');assert.equal(calls.length,1);assert.equal(calls[0].body.completionToken,'loaded-reply');assert.equal(messages.scrollTop,208);
  }finally{vm.runInContext("state.sessions=firstUnreadSaved.sessions;state.activeSessionId=firstUnreadSaved.active;state.unreadVisit=firstUnreadSaved.visit;renderedSessionId=firstUnreadSaved.rendered;readingSessions.delete('first-unread:loaded-reply')",ui);ui.document=previousDocument;for(const [name,value] of saved)ui[name]=value;}
});

test('local HTML links open an on-demand preview and cached messages keep the correct conversation scope',()=>{
  const previous=vm.runInContext('state.activeSessionId',ui);
  const text='[查看新版对比与开合动图](D:/工程/脸部/review.html)';
  try{
    vm.runInContext("state.activeSessionId='html-chat-a'",ui);const first=invoke('renderMarkdown',text);
    assert.match(first,/打开 HTML 预览/);assert.match(first,/\/api\/sessions\/html-chat-a\/preview\//);assert.doesNotMatch(first,/<iframe|<img/);
    vm.runInContext("state.activeSessionId='html-chat-b'",ui);assert.match(invoke('renderMarkdown',text),/\/api\/sessions\/html-chat-b\/preview\//);
    assert.doesNotMatch(invoke('renderMarkdown','[危险](javascript:example.html)'),/href=/);
  }finally{ui.htmlPreviousSession=previous;vm.runInContext('state.activeSessionId=htmlPreviousSession',ui);delete ui.htmlPreviousSession;}
});

test('sidebar search spans projects without loading history, preserves project pagination and leaves the current chat selected',()=>{
  const previousDocument=ui.document,saved=new Map(['activeProject','syncHtml','api','renderProjects'].map(name=>[name,ui[name]]));
  const list={innerHTML:'',classList:{toggle(){}}},nodes=new Map(),input={value:'',focus(){this.focused=true;}},filters=['all','running','unread','waiting'].map(value=>({dataset:{sessionFilter:value},attributes:{},setAttribute(name,text){this.attributes[name]=text;}}));
  const element=()=>({textContent:'',setAttribute(){},classList:{toggle(name,value){this[name]=value;}}});
  for(const id of ['projectNav','projectList','resetSessionSearch','conversationListTitle','conversationScope','conversationNav','attentionCount','attentionBtn'])nodes.set(id,element());
  nodes.set('sessionSearch',input);
  ui.document={getElementById:id=>id==='sessionList' ? list : nodes.get(id),querySelectorAll:selector=>selector==='[data-session-filter]' ? filters : []};
  ui.syncHtml=(node,html)=>{node.innerHTML=html;for(const id of ['moreSessions','allSessions','recentSessions','emptySessionSearchReset']){nodes.delete(id);if(html.includes(`id="${id}"`))nodes.set(id,{});}};
  ui.searchFixtureSessions=Array.from({length:13},(_,i)=>({id:'search-'+i,title:'Conversation '+i,projectName:i<7 ? 'Alpha' : 'Beta',deviceId:'local',status:i===0 ? 'running' : i===8 ? 'waiting_input' : i===9 ? 'waiting_approval' : 'done',unread:i===1,updatedAt:13-i}));
  ui.searchFixtureProject={id:'search-project',sessions:ui.searchFixtureSessions.slice(0,7)};ui.activeProject=()=>ui.searchFixtureProject;
  ui.api=()=>assert.fail('search/filtering must not request history');
  ui.renderProjects=()=>{};
  vm.runInContext("var searchUiSaved={sessions:state.sessions,selected:state.selectedDeviceId,active:state.activeSessionId,query:state.sessionQuery,filter:state.sessionFilter,limit:state.sessionResultLimit,limits:state.sessionListLimits};state.sessions=searchFixtureSessions;state.selectedDeviceId='local';state.activeSessionId='search-open';state.sessionQuery='';state.sessionFilter='all';state.sessionResultLimit=5;state.sessionListLimits=new Map([['search-project','all']])",ui);
  const count=()=> (list.innerHTML.match(/data-session=/g) || []).length;
  try {
    invoke('setupSessionSearch');invoke('renderSessions');assert.equal(count(),0);assert.equal(nodes.get('attentionCount').textContent,'3');
    input.value='Conversation';input.oninput();assert.equal(count(),5);assert.equal(nodes.get('conversationScope').textContent,'全部项目 · 13 条');assert.ok(nodes.get('projectList').classList.hidden);
    nodes.get('moreSessions').onclick();assert.equal(count(),10);nodes.get('allSessions').onclick();assert.equal(count(),13);
    input.value='Beta';input.oninput();assert.equal(count(),5);assert.match(list.innerHTML,/Beta/);assert.doesNotMatch(list.innerHTML,/Conversation 0</);
    filters[3].onclick();assert.equal(count(),2);assert.equal(filters[3].attributes['aria-pressed'],'true');
    input.value='no matching title';input.oninput();assert.equal(count(),0);assert.match(list.innerHTML,/没有匹配的对话/);
    assert.equal(vm.runInContext('state.activeSessionId',ui),'search-open');
    input.onkeydown({key:'Escape',isComposing:true});assert.equal(input.value,'no matching title');
    input.onkeydown({key:'Escape',isComposing:false,preventDefault(){}});assert.equal(input.value,'');assert.equal(count(),0);assert.ok(!nodes.get('projectList').classList.hidden);
    assert.equal(vm.runInContext("state.sessionListLimits.get('search-project')",ui),'all');assert.equal(vm.runInContext('state.activeSessionId',ui),'search-open');
  } finally {
    vm.runInContext('state.sessions=searchUiSaved.sessions;state.selectedDeviceId=searchUiSaved.selected;state.activeSessionId=searchUiSaved.active;state.sessionQuery=searchUiSaved.query;state.sessionFilter=searchUiSaved.filter;state.sessionResultLimit=searchUiSaved.limit;state.sessionListLimits=searchUiSaved.limits',ui);
    ui.document=previousDocument;for(const [name,value] of saved)ui[name]=value;delete ui.searchFixtureSessions;delete ui.searchFixtureProject;
  }
});

test('active stream deduplication stays bounded by both event count and bytes',()=>{
  const view=invoke('blankView',{id:'large-stream'});
  for(let n=0;n<15000;n++)invoke('applyRelay',view,{type:'codex',message:{method:'turn/plan/updated',params:{plan:[{step:'操作 '+n+' '+ 'x'.repeat(500)}]}},at:n+1});
  assert.ok(view.appliedEvents.size<=4096);assert.ok(view.appliedEventBytes<=1024*1024);
  const latest={type:'codex',message:{method:'turn/plan/updated',params:{plan:[{step:'最新计划'}]}},at:20000};
  assert.equal(invoke('applyRelay',view,latest),true);assert.equal(invoke('applyRelay',view,latest),false);
  assert.equal(view.plan[0].step,'最新计划');
});

test('an unlimited live command stream is clipped once without breaking Unicode; completion still replaces it',()=>{
  const view=invoke('blankView',{id:'unlimited-output'});
  for(let n=0;n<1000;n++)invoke('applyRelay',view,{type:'codex',message:{method:'item/commandExecution/outputDelta',params:{itemId:'cmd',delta:'😀'.repeat(500)}},at:n+1});
  const item=view.timeline[0];assert.ok(item.aggregatedOutput.length<24100);
  assert.equal((item.aggregatedOutput.match(/内容已截断/g) || []).length,1);
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(item.aggregatedOutput));
  invoke('applyRelay',view,{type:'codex',message:{method:'item/completed',params:{item:{id:'cmd',type:'commandExecution',aggregatedOutput:'最终输出',exitCode:0}}},at:2000});
  assert.equal(item.aggregatedOutput,'最终输出');
});
test('running composer queues messages without closing the active turn; native replies close pending question controls',()=>{
  const replaced=['restoreDraft','connectionStatus','renderSelectors','renderComposerSettings','syncHtml','isMobileLayout'];
  const old=new Map(replaced.map(name=>[name,ui[name]])),previousDocument=ui.document;
  const nodes=new Map();
  ui.document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,{value:'',classList:{toggle:()=>{},add:()=>{},remove:()=>{}},setAttribute(name,value){this[name]=value;},querySelectorAll:()=>[]});return nodes.get(id);}};
  for(const name of replaced)ui[name]=()=>{};
  vm.runInContext("var controlsSaved={sessions:state.sessions,active:state.activeSessionId,devices:state.devices,connection:state.connection};state.sessions=[{id:'controls',deviceId:'local',status:'running',activeTurnId:'t',executionOwner:'desktop',controls:{steer:true,interrupt:true}}];state.activeSessionId='controls';state.devices=[{id:'local',online:true}];state.connection='connected';",ui);
  try {
    invoke('renderComposer');assert.equal(nodes.get('sendBtn').disabled,false);assert.equal(nodes.get('sendBtn').title,'加入待发送消息');
    assert.equal(nodes.get('promptInput').placeholder,'写下一条消息，发送后可选择引导…');
    ui.isMobileLayout=()=>true;invoke('renderComposer');assert.equal(nodes.get('promptInput').placeholder,'继续说，可引导…');
    vm.runInContext("state.sessions[0].status='interrupting'",ui);invoke('renderComposer');assert.equal(nodes.get('sendBtn').disabled,false);
    const item={id:'q',delivery:'rpc',answerState:'resolved',questions:[{id:'choice',title:'选择？',options:['一','二']}]};
    const html=invoke('renderQuestion',item,'q',false);assert.match(html,/提问已结束/);assert.doesNotMatch(html,/question-submit/);
    assert.match(html,/data-answer="一"[^>]* disabled/);
  } finally {
    ui.document=previousDocument;for(const [name,value] of old)ui[name]=value;
    vm.runInContext('state.sessions=controlsSaved.sessions;state.activeSessionId=controlsSaved.active;state.devices=controlsSaved.devices;state.connection=controlsSaved.connection',ui);
  }
});

test('native Desktop permission menu accepts a pending choice and distinguishes it from confirmed permission',()=>{
  const previousDocument=ui.document,names=['renderUsage','renderComposer','closeComposerPopovers','syncHtml'],saved=new Map(names.map(name=>[name,ui[name]])),nodes=new Map();
  const buttons=['','read-only','workspace-write','danger-full-access'].map(permission=>({dataset:{permission}}));
  ui.document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,{value:'',style:{setProperty(){}},classList:{toggle(){}},setAttribute(){},focus(){},querySelectorAll:()=>id==='permissionMenu' ? buttons : []});return nodes.get(id);}};
  ui.syncHtml=(node,html)=>node.html=html;ui.renderUsage=()=>{};ui.renderComposer=()=>{};ui.closeComposerPopovers=()=>{};
  vm.runInContext("var permissionUiSaved={devices:state.devices,sessions:state.sessions,active:state.activeSessionId,catalogs:state.catalogs,choices:state.sessionsChoices};state.devices=[{id:'perm-device',nativeDesktop:{connected:true}}];state.sessions=[{id:'perm-chat',deviceId:'perm-device',executionOwner:'desktop',nativePermission:'workspace-write'}];state.activeSessionId='perm-chat';state.sessionsChoices={};state.catalogs=new Map([['perm-device',{models:[],permissions:[{id:'read-only',label:'只读'},{id:'workspace-write',label:'工作区访问'},{id:'danger-full-access',label:'完全访问'}]}]]);",ui);
  const render=()=>invoke('renderComposerSettings','perm-device',vm.runInContext('state.sessions[0]',ui),invoke('choicesFor'));
  try{
    render();assert.equal(buttons[1].disabled,false);assert.equal(buttons[3].disabled,false);
    buttons[3].onclick();assert.equal(invoke('choicesFor').permission,'danger-full-access');render();
    assert.equal(nodes.get('permissionLabel').textContent,'下次 · 完全访问');assert.match(nodes.get('permissionMenu').html,/当前：工作区访问/);assert.match(nodes.get('permissionMenu').html,/下一条新回合生效/);
    assert.equal(vm.runInContext('state.sessions[0].nativePermission',ui),'workspace-write');
    vm.runInContext("state.sessions[0].nativePermission='danger-full-access'",ui);render();assert.equal(nodes.get('permissionLabel').textContent,'桌面 · 完全访问');
    buttons[0].onclick();assert.equal(invoke('choicesFor').permission,'');
    vm.runInContext("state.devices[0].nativeDesktop.connected=false;state.sessions[0].nativePermission='workspace-write'",ui);render();
    assert.equal(buttons[3].disabled,true);assert.match(nodes.get('permissionMenu').html,/恢复桌面原生连接/);
  }finally{
    vm.runInContext('state.devices=permissionUiSaved.devices;state.sessions=permissionUiSaved.sessions;state.activeSessionId=permissionUiSaved.active;state.catalogs=permissionUiSaved.catalogs;state.sessionsChoices=permissionUiSaved.choices;',ui);
    ui.document=previousDocument;for(const [name,value] of saved)ui[name]=value;
  }
});
test('multiple approvals remain visible in order and resolving one cannot dismiss another',()=>{
  const view=invoke('blankView',{id:'approvals'});
  invoke('applyRelay',view,{type:'approval_request',request:{id:1,key:'first'},at:1});
  invoke('applyRelay',view,{type:'approval_request',request:{id:'1',key:'second'},at:2});
  assert.equal(view.approval.key,'first');
  invoke('applyRelay',view,{type:'approval_resolved',requestId:1,approvalKey:'first',at:3});
  assert.equal(view.approval.key,'second');assert.equal(view.approvals.size,1);
});
test('the usage panel shows only returned quota windows and exposes the current conversation context',()=>{
  const previousDocument=ui.document,previousSync=ui.syncHtml;
  const nodes=new Map();
  ui.document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,{classList:{contains:()=>false}});return nodes.get(id);}};
  ui.syncHtml=(node,html)=>{node.html=html;};
  vm.runInContext("var savedUsageState={sessions:state.sessions,active:state.activeSessionId,devices:state.devices,usages:state.usages};state.sessions=[{id:'quota',deviceId:'local',tokenUsage:{usedPercent:12,usedTokens:120,windowTokens:1000}}];state.activeSessionId='quota';state.devices=[{id:'local',name:'Runner',online:true}];state.usages=new Map([['local',{deviceId:'local',buckets:[{id:'codex',planType:'pro',windows:[{minutes:10080,remainingPercent:20,resetsAt:1792295913}]}]}]])",ui);
  try {
    invoke('renderUsage');let html=nodes.get('usageContent').html;
    assert.match(html,/周额度/);assert.match(html,/剩余 20%/);assert.doesNotMatch(html,/5 小时额度/);
    assert.match(html,/约 12% 已使用/);assert.match(html,/120 \/ 1,000 tokens/);
    vm.runInContext("state.usages.get('local').buckets[0].windows.push({minutes:300,remainingPercent:65,resetsAt:1792290000})",ui);
    invoke('renderUsage');assert.match(nodes.get('usageContent').html,/5 小时额度/);assert.match(nodes.get('usageContent').html,/剩余 65%/);
  } finally {
    ui.document=previousDocument;ui.syncHtml=previousSync;
    vm.runInContext('state.sessions=savedUsageState.sessions;state.activeSessionId=savedUsageState.active;state.devices=savedUsageState.devices;state.usages=savedUsageState.usages',ui);
  }
});

test('independent history and quota panels render only their own details while keeping summary metrics updated',()=>{
  const previousDocument=ui.document,previousSync=ui.syncHtml,nodes=new Map();
  let visible='historyUsageModal';
  ui.document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,{classList:{contains:()=>id!==visible}});return nodes.get(id);}};
  ui.syncHtml=(node,html)=>node.html=html;
  vm.runInContext("var historyUsageUiSaved={sessions:state.sessions,active:state.activeSessionId,historical:state.historicalUsages,filter:state.historyUsageFilter};state.historyUsageFilter={preset:'all'};state.sessions=[{id:'history-models',deviceId:'local',nativeModel:'gpt-6.1-sol',tokenUsage:{usedTokens:120,usedPercent:12,windowTokens:1000}}];state.activeSessionId='history-models';state.historicalUsages=new Map([['local',{status:'ready',totalTokens:300000,models:[{model:'gpt-6.1-sol',totalTokens:200000,inputTokens:180000,cachedInputTokens:100000,outputTokens:20000,reasoningTokens:10000,averageTokensPerSecond:20},{model:'gpt-6-astra',totalTokens:100000,inputTokens:90000,cachedInputTokens:80000,outputTokens:10000,reasoningTokens:5000}]}]]);",ui);
  try{
    invoke('renderUsage');const historyHtml=nodes.get('historyUsageContent').html;
    assert.equal(nodes.get('usageTokenSummary').textContent,'累计 30万 token');
    assert.match(nodes.get('usageSpeedSummary').textContent,/^历史均速 ≈20\.0 token\/s/);
    assert.match(nodes.get('usageSpeedSummary').title,/历史采样均速/);
    assert.match(historyHtml,/300,000/);assert.match(historyHtml,/GPT-6\.1 Sol/);assert.match(historyHtml,/GPT-6 Astra/);
    assert.match(historyHtml,/其中缓存 100,000/);assert.doesNotMatch(historyHtml,/120 \/ 1,000 tokens/);
    assert.equal(nodes.has('usageContent'),false,'a closed quota panel does not render its details');
    visible='usageModal';invoke('renderUsage');const html=nodes.get('usageContent').html;
    assert.match(html,/120 \/ 1,000 tokens/);assert.doesNotMatch(html,/300,000|GPT-6\.1 Sol|其中缓存/);
    assert.match(html,/并非逐 token 解码速度/);
    assert.match(html,/模型生成速率：当前接口未提供/);
    assert.equal(nodes.get('historyUsageContent').html,historyHtml,'a hidden history panel keeps its existing contents');
  }finally{
    vm.runInContext('state.sessions=historyUsageUiSaved.sessions;state.activeSessionId=historyUsageUiSaved.active;state.historicalUsages=historyUsageUiSaved.historical;state.historyUsageFilter=historyUsageUiSaved.filter;',ui);ui.document=previousDocument;ui.syncHtml=previousSync;
  }
});
test('opening either usage dialog closes the other and refreshes only its own data source',()=>{
  const previousDocument=ui.document,names=['closeComposerPopovers','renderUsage','refreshUsage','refreshHistoricalUsage','refreshHistoricalRange'],saved=new Map(names.map(name=>[name,ui[name]]));
  const hidden=new Map([['usageModal',false],['historyUsageModal',true]]),calls=[];
  ui.document={getElementById:id=>({classList:{add:()=>hidden.set(id,true),remove:()=>hidden.set(id,false)}})};
  ui.closeComposerPopovers=()=>{};ui.renderUsage=()=>{};
  ui.refreshUsage=()=>calls.push('quota');ui.refreshHistoricalUsage=()=>calls.push('history');
  ui.refreshHistoricalRange=()=>calls.push('range');
  try{
    invoke('openHistoryUsage');assert.equal(hidden.get('usageModal'),true);assert.equal(hidden.get('historyUsageModal'),false);assert.deepEqual(calls,['history','range']);
    calls.length=0;invoke('openUsage');assert.equal(hidden.get('historyUsageModal'),true);assert.equal(hidden.get('usageModal'),false);assert.deepEqual(calls,['quota']);
  }finally{ui.document=previousDocument;for(const [name,value] of saved)ui[name]=value;}
});
test('late date-query responses cannot replace another selected range or the all-history footer; cached ranges are reused',async()=>{
  const previousDocument=ui.document,names=['api','syncHtml'],saved=new Map(names.map(name=>[name,ui[name]])),nodes=new Map(),requests=[];
  ui.document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,{classList:{contains:()=>id!=='historyUsageModal'}});return nodes.get(id);}};
  ui.syncHtml=(node,html)=>node.html=html;
  ui.api=(path)=>new Promise(resolve=>requests.push({url:new URL(path,'http://fixture'),resolve}));
  vm.runInContext("var rangeUiSaved={sessions:state.sessions,active:state.activeSessionId,historical:state.historicalUsages,filter:state.historyUsageFilter};state.sessions=[{id:'ranges',deviceId:'range-fixture'}];state.activeSessionId='ranges';state.historicalUsages=new Map([['range-fixture',{status:'ready',updatedAt:1000,totalTokens:999999,models:[]}]]);state.historyUsageFilter={preset:'custom',start:'2026-10-14',end:'2026-10-14'};",ui);
  const finish=(request,total)=>request.resolve({usage:{range:{from:Number(request.url.searchParams.get('from')),to:Number(request.url.searchParams.get('to'))},updatedAt:1000,status:'ready',totalTokens:total,models:[]}});
  try{
    const older=invoke('refreshHistoricalRange');
    vm.runInContext("state.historyUsageFilter={preset:'custom',start:'2026-10-15',end:'2026-10-15'}",ui);
    const newer=invoke('refreshHistoricalRange');assert.equal(requests.length,2);
    finish(requests[1],222);await newer;assert.match(nodes.get('historyUsageContent').html,/222 <small>token/);
    finish(requests[0],111);await older;
    assert.match(nodes.get('historyUsageContent').html,/222 <small>token/);assert.doesNotMatch(nodes.get('historyUsageContent').html,/111 <small>token/);
    assert.equal(nodes.get('usageTokenSummary').textContent,'累计 100万 token');
    await invoke('refreshHistoricalRange');assert.equal(requests.length,2);
    vm.runInContext("state.historyUsageFilter={preset:'custom',start:'2026-10-14',end:'2026-10-14'}",ui);
    invoke('renderUsage');await invoke('refreshHistoricalRange');assert.equal(requests.length,2);assert.match(nodes.get('historyUsageContent').html,/111 <small>token/);
  }finally{
    vm.runInContext('state.sessions=rangeUiSaved.sessions;state.activeSessionId=rangeUiSaved.active;state.historicalUsages=rangeUiSaved.historical;state.historyUsageFilter=rangeUiSaved.filter;historicalRangeUsages.clear();historyRangeLoads.clear();',ui);
    ui.document=previousDocument;for(const [name,value] of saved)ui[name]=value;
  }
});
test('numbered steps retain their explanations and continue across blank lines',()=>{
  const text='具体按这个顺序推进：\n\n'+[
    '1. **确定下一批完整边界。**  \n   核对剩余耗时和依赖。',
    '2. **迁移决策数据与连续计算。**  \n   一起迁入 C#。',
    '3. **收拢身体状态与移动模块。**  \n   清理对应桥接和旧实现。',
    '4. **继续世界模拟及其他运行模块。**  \n   按依赖推进。'
  ].join('\n\n')+'\n\n每批交付都要回答三件事。';
  const html=invoke('renderMarkdown',text);
  assert.equal((html.match(/<ol>/g) || []).length,1);
  assert.equal((html.match(/<li>/g) || []).length,4);
  assert.match(html,/<li><p><strong>确定下一批完整边界。<\/strong>  <br>核对剩余耗时和依赖。<\/p><\/li>/);
  assert.match(html,/<li><p><strong>继续世界模拟及其他运行模块。<\/strong>  <br>按依赖推进。<\/p><\/li><\/ol>.*<p>每批交付都要回答三件事。<\/p>/);
  assert.match(invoke('renderMarkdown','1. 甲\n\n1. 乙\n\n1. 丙'),/^<ol><li><p>甲<\/p><\/li><li><p>乙<\/p><\/li><li><p>丙<\/p><\/li><\/ol>$/);
});

test('lists preserve starting numbers, nested content, and boundaries with other blocks',()=>{
  assert.equal(invoke('renderMarkdown','7) 甲\n8) 乙'),'<ol start="7"><li>甲</li><li>乙</li></ol>');
  const separate=invoke('renderMarkdown','1. 甲\n\n独立段落。\n\n2. 乙\n\n## 新章节\n\n1. 丙');
  assert.match(separate,/<ol><li>甲<\/li><\/ol>.*<p>独立段落。<\/p>.*<ol start="2"><li>乙<\/li><\/ol>.*<h2>新章节<\/h2>.*<ol><li>丙<\/li><\/ol>/);
  const nested=invoke('renderMarkdown','1. 外层\n   - **子项**\n   - `<script>`\n2. 下一项');
  assert.match(nested,/<li><p>外层<\/p><ul><li><strong>子项<\/strong><\/li><li><code>&lt;script&gt;<\/code><\/li><\/ul><\/li><li>下一项<\/li>/);
  assert.doesNotMatch(invoke('renderMarkdown','```\n2. 代码文本\n```'),/<ol|<li/);
});

test('Markdown tables render headers, align columns and preserve formatted cells safely',()=>{
  const html=invoke('renderMarkdown','| 生物 | **总数** | 现场 |\n|:---|---:|:---:|\n| 兔 | 60 | `12` |\n| 鹿 | 30 | 6 |\n\n普通消息');
  assert.match(html,/<table><thead><tr><th style="text-align:left" scope="col">生物<\/th>/);
  assert.match(html,/<th style="text-align:right" scope="col"><strong>总数<\/strong>/);
  assert.match(html,/<td style="text-align:center"><code>12<\/code>/);
  assert.match(html,/<\/table><\/div>.*<p>普通消息<\/p>/);
  const escaped=invoke('renderMarkdown','名称 | 值\n--- | ---\n甲\\|乙 | <script>alert(1)</script>\n`a|b` | 2');
  assert.match(escaped,/甲\|乙/);assert.match(escaped,/&lt;script&gt;/);assert.doesNotMatch(escaped,/<script>/);
  assert.match(escaped,/<code>a\|b<\/code>/);
  assert.doesNotMatch(invoke('renderMarkdown','```\n| a | b |\n|---|---|\n```'),/<table>/);
  assert.doesNotMatch(invoke('renderMarkdown','a | b\nwrong | ---'),/<table>/);
});

test('history downloads deduplicate unchanged snapshots but expand windows and new versions still load', async () => {
  const originalApi = ui.api, originalRender = ui.render, originalMarkRead = ui.maybeMarkSessionRead;
  const session = { id: 'loading', source: 'imported', historyLoaded: true, historyVersion: 'v1' };
  ui.loadingSession = session;
  vm.runInContext('state.sessions.push(loadingSession)', ui);
  const requests = []; let release;
  ui.api = async endpoint => {
    requests.push(endpoint);
    if (requests.length === 1) await new Promise(resolve => { release = resolve; });
    return { historyLoaded: true, historyVersion: session.historyVersion, events: [{ type: 'thread_ready' }], turns: [] };
  };
  ui.render = () => {};
  ui.maybeMarkSessionRead = () => {};
  try {
    const loading = invoke('loadSessionHistory', session);
    await invoke('loadSessionHistory', session); release(); await loading;
    await invoke('loadSessionHistory', session);
    assert.deepEqual(requests, ['/api/sessions/loading/history?maxTurns=5&sync=1']);
    vm.runInContext("state.timelineLimits.set('loading',10)", ui);
    await invoke('loadSessionHistory', session);
    assert.equal(requests.at(-1), '/api/sessions/loading/history?maxTurns=10&sync=1');
    await invoke('loadSessionHistory', session); assert.equal(requests.length, 2);
    session.historyVersion = 'v2'; await invoke('loadSessionHistory', session); assert.equal(requests.length, 3);
    vm.runInContext("state.timelineLimits.set('loading','all')", ui);
    await invoke('loadSessionHistory', session);
    assert.equal(requests.at(-1), '/api/sessions/loading/history?maxTurns=all&sync=1');
  } finally {
    ui.api = originalApi; ui.render = originalRender; ui.maybeMarkSessionRead = originalMarkRead;
    vm.runInContext("state.timelineLimits.delete('loading');state.sessions=state.sessions.filter(session=>session.id!=='loading')", ui);
    delete ui.loadingSession;
  }
});

test('preloading an unopened project waits for server history, fetches five turns and reuses them on selection without reading it',async()=>{
  const names=['api','render','maybeMarkSessionRead','scheduleRender','observeTaskNotices'];
  const saved=new Map(names.map(name=>[name,ui[name]])),oldDocument=ui.document;
  vm.runInContext("var warmSaved={sessions:state.sessions,devices:state.devices,active:state.activeSessionId,selected:state.selectedDeviceId,views:state.views,limits:state.timelineLimits};state.sessions=[{id:'warm-active',deviceId:'local',projectId:'one',historyLoaded:true},{id:'warm-other',deviceId:'local',projectId:'two',source:'imported',historyLoaded:false,unread:true}];state.devices=[{id:'local',online:true}];state.activeSessionId='warm-active';state.selectedDeviceId='local';state.views=new Map();state.timelineLimits=new Map();",ui);
  const preloader=vm.runInContext('historyPreloader',ui),calls=[];
  const oldAttempts=preloader.attempts;preloader.attempts=new Map();
  let renders=0;
  ui.document={hidden:false};ui.render=()=>renders++;ui.maybeMarkSessionRead=()=>{};ui.scheduleRender=()=>{};ui.observeTaskNotices=()=>{};
  ui.api=async(url,options)=>{calls.push({url,method:options?.method || 'GET'});return options ? {queued:true,historyLoaded:false} : {historyLoaded:true,historyVersion:'ready-v1',events:[{type:'user_message',text:'另一个项目的历史',at:1}],turns:[]};};
  try{
    await preloader.run();assert.deepEqual(calls,[{url:'/api/sessions/warm-other/history',method:'POST'}]);
    assert.equal(vm.runInContext("state.sessions[1].historyRequested",ui),true);
    invoke('applyEvent',{type:'session',id:'warm-other',deviceId:'local',historyLoaded:true,historyVersion:'ready-v1'});
    await preloader.run();assert.equal(calls.length,2);assert.equal(calls[1].url,'/api/sessions/warm-other/history?maxTurns=5&sync=1');
    assert.equal(vm.runInContext("state.sessions[1].unread",ui),true);
    assert.equal(vm.runInContext("state.views.has('warm-other')",ui),true);
    assert.equal(renders,0,'warming another conversation must not rebuild the visible conversation');
    vm.runInContext("state.activeSessionId='warm-other'",ui);
    await invoke('ensureSessionHistory',vm.runInContext('state.sessions[1]',ui));
    assert.equal(calls.length,2);assert.equal(vm.runInContext("state.sessions[1].events[0].text",ui),'另一个项目的历史');
    ui.api=async()=>({historyLoaded:true,historyVersion:'ready-v2',events:[{type:'user_message',text:'更新后的历史',at:2}],turns:[]});
    vm.runInContext("state.sessions[1].historyVersion='ready-v2'",ui);await invoke('ensureSessionHistory',vm.runInContext('state.sessions[1]',ui));
    assert.equal(renders,1,'updated foreground history must still render immediately');
  }finally{
    clearTimeout(preloader.timer);preloader.timer=null;preloader.again=false;preloader.attempts=oldAttempts;
    vm.runInContext('state.sessions=warmSaved.sessions;state.devices=warmSaved.devices;state.activeSessionId=warmSaved.active;state.selectedDeviceId=warmSaved.selected;state.views=warmSaved.views;state.timelineLimits=warmSaved.limits;',ui);
    ui.document=oldDocument;for(const [name,value] of saved)ui[name]=value;
  }
});

test('small session patches compare supplied metadata without reading or serializing cached history',()=>{
  let historyReads=0;const previous={id:'same',status:'running',turns:[{id:'turn',status:'inProgress'}]};
  Object.defineProperty(previous,'events',{enumerable:true,get(){historyReads++;throw new Error('cached history must not be compared for a metadata patch');}});
  assert.equal(invoke('sessionPatchChanged',previous,{id:'same',status:'running',turns:[{id:'turn',status:'inProgress'}]}),false);
  assert.equal(invoke('sessionPatchChanged',previous,{id:'same',status:'done'}),true);
  assert.equal(invoke('sessionPatchChanged',previous,{turns:[{id:'turn',status:'completed'}]}),true);
  assert.equal(historyReads,0);
  assert.equal(invoke('sessionPatchChanged',{id:'same',events:[{text:'old'}]},{events:[{text:'new'}]}),true,'explicit history changes must not be missed');
  assert.equal(invoke('sessionPatchChanged',null,{id:'new'}),true);
});

test('live events from a cold conversation do not evict the eight warm histories or the current draft',()=>{
  vm.runInContext("var warmCacheSaved={sessions:state.sessions,active:state.activeSessionId,selected:state.selectedDeviceId,views:state.views};state.sessions=[];state.activeSessionId='hot-0';state.selectedDeviceId='local';state.views=new Map();",ui);
  try{
    for(let i=0;i<9;i++){
      ui.warmCacheSession={id:'hot-'+i,deviceId:'local',updatedAt:20-i,events:[{type:'user_message',text:'缓存 '+i}],loadedHistoryVersion:'v1'};
      vm.runInContext('state.sessions.push(warmCacheSession)',ui);invoke('viewFor',ui.warmCacheSession);
    }
    assert.equal(vm.runInContext('state.views.size',ui),8);
    assert.ok(vm.runInContext("state.sessions.slice(0,8).every(session=>state.views.has(session.id) && session.events.length===1)",ui));
    assert.equal(vm.runInContext("state.views.has('hot-8')",ui),false);
  }finally{
    vm.runInContext('state.sessions=warmCacheSaved.sessions;state.activeSessionId=warmCacheSaved.active;state.selectedDeviceId=warmCacheSaved.selected;state.views=warmCacheSaved.views;',ui);delete ui.warmCacheSession;
  }
});

test('browser history requests use cursors, remove rolled-back rows and recover an invalid delta with one full read', async()=>{
  const originalApi=ui.api,originalRender=ui.render,originalMarkRead=ui.maybeMarkSessionRead;
  const session={id:'incremental-ui',source:'imported',status:'done',historyLoaded:true,historyVersion:'v1'};
  ui.incrementalSession=session;vm.runInContext('state.sessions.push(incrementalSession)',ui);
  let sync=new HistorySync(),invalid=false;
  let events=[{type:'user_message',id:'old',text:'Older message '.repeat(1000),at:1},{type:'user_message',id:'new',text:'New message',at:2}];
  const requests=[];
  ui.api=async endpoint=>{
    requests.push(endpoint);const url=new URL(endpoint,'http://fixture');
    const cursor=url.searchParams.get('cursor');
    if(invalid && cursor)return {historyLoaded:true,historySync:{kind:'delta',baseCursor:cursor,cursor:'broken',keys:['missing'],order:['unknown']},events:[]};
    return sync.response({sessionId:session.id,historyLoaded:true,historyVersion:session.historyVersion,events,turns:[],turnCount:events.length ? 1 : 0,messageCount:events.length},url.searchParams.get('maxTurns'),cursor);
  };
  ui.render=()=>{};ui.maybeMarkSessionRead=()=>{};
  try{
    await invoke('loadSessionHistory',session);const firstCursor=session.loadedHistoryCursor;
    events=[events[0],{...events[1],text:'Updated message'}];session.historyVersion='v2';
    await invoke('loadSessionHistory',session);
    assert.match(requests.at(-1),new RegExp('&cursor='+firstCursor+'$'));
    assert.equal(session.events[1].text,'Updated message');
    events=events.slice(0,1);session.historyVersion='v3';await invoke('loadSessionHistory',session);
    assert.equal(session.events.length,1);
    assert.equal(vm.runInContext("state.views.get('incremental-ui').timeline.length",ui),1);
    invalid=true;session.historyVersion='v4';const before=requests.length;
    await invoke('loadSessionHistory',session);
    assert.equal(requests.length,before+2);assert.ok(!requests.at(-1).includes('&cursor='));
    assert.equal(session.loadedHistoryVersion,'v4');assert.equal(session.events.length,1);
    invalid=false;sync=new HistorySync();session.historyVersion='v5';await invoke('loadSessionHistory',session);
    assert.equal(session.loadedHistoryVersion,'v5');
    events=[];session.historyVersion='v6';await invoke('loadSessionHistory',session);
    assert.equal(session.events.length,0);assert.equal(session.turnCount,0);assert.equal(session.messageCount,0);
  }finally{
    ui.api=originalApi;ui.render=originalRender;ui.maybeMarkSessionRead=originalMarkRead;
    vm.runInContext("state.sessions=state.sessions.filter(session=>session.id!=='incremental-ui');state.views.delete('incremental-ui')",ui);delete ui.incrementalSession;
  }
});

test('active turns show progress in order until completion; completed history starts collapsed',()=>{
  const turn={id:'visible',status:'inProgress',items:[{id:'u',type:'userMessage',text:'开始检查',at:1000},
    {id:'c1',type:'agentMessage',phase:'commentary',text:'先读文件',at:2000},
    {id:'cmd',type:'commandExecution',command:'node --check app.js',at:3000},
    {id:'c2',type:'agentMessage',phase:'commentary',text:'再验证图片',at:4000},
    {id:'v1',type:'imageView',images:[{ref:'file:///C:/test/a.png'}],at:5000},
    {id:'v2',type:'imageView',images:[{ref:'file:///C:/test/b.png'}],at:6000}]};
  const active=invoke('renderTurn',turn);
  assert.ok(!active.includes('class="turn-history"'));
  assert.ok(active.indexOf('先读文件') < active.indexOf('已执行 1 条命令'));
  assert.ok(active.indexOf('已执行 1 条命令') < active.indexOf('再验证图片'));
  assert.doesNotMatch(active,/已运行 node --check/);
  vm.runInContext("state.openDetailKeys.add('visible:process:cmd:group')",ui);
  assert.match(invoke('renderTurn',turn),/已运行 node --check/);
  vm.runInContext("state.openDetailKeys.delete('visible:process:cmd:group')",ui);
  assert.match(active,/图片 · 2 张/);
  assert.doesNotMatch(active,/<img\b/);
  turn.items.push({id:'final',type:'agentMessage',phase:'final_answer',text:'完成检查',at:7000});
  const finalBeforeStatus=invoke('renderTurn',turn);
  assert.match(finalBeforeStatus,/class="turn-history"/);
  assert.match(finalBeforeStatus,/完成检查/);
  assert.doesNotMatch(finalBeforeStatus,/先读文件|再验证图片|turn-live|data-processing-since/);
  turn.status='completed';turn.completedAt=8000;
  const finished=invoke('renderTurn',turn);
  assert.match(finished,/上 2 条消息 · 1 条命令/);assert.match(finished,/完成检查/);
  assert.ok(!finished.includes('先读文件') && !finished.includes('node --check'));
});

test('ended turns fold their last commentary instead of presenting it as a final result',()=>{
  for(const status of ['completed','interrupted','failed']){
    const id='ended-'+status;
    const turn={id,status,items:[{id:'u',type:'userMessage',text:'好的继续'},
      {id:'cmd',type:'commandExecution',command:'run-check'},
      {id:'comment',type:'agentMessage',phase:'commentary',text:'C# 编译已通过，接下来验证退出'}],
      ...(status==='failed' ? {alert:{message:'模型请求超时'}} : {})};
    const closed=invoke('renderTurn',turn);
    assert.match(closed,/class="turn-history"/);
    assert.match(closed,/上 1 条消息 · 1 条命令/);
    assert.doesNotMatch(closed,/C# 编译已通过|class="turn-result"|class="process-note/);
    if(status==='failed')assert.match(closed,/模型请求超时/);
    vm.runInContext(`state.openDetailKeys.add('${id}:history')`,ui);
    try{assert.match(invoke('renderTurn',turn),/C# 编译已通过/);}
    finally{vm.runInContext(`state.openDetailKeys.delete('${id}:history')`,ui);}
  }
  // Older transcripts without phases still retain their completed answer.
  const legacy=invoke('renderTurn',{id:'legacy-completed',status:'completed',items:[
    {id:'old-progress',type:'agentMessage',text:'旧版中间记录'},
    {id:'old-final',type:'agentMessage',text:'旧版最终结果'}]});
  assert.match(legacy,/旧版最终结果/);assert.doesNotMatch(legacy,/旧版中间记录/);
});

test('interrupted attempts followed by a completed continuation leave only the final answer visible',()=>{
  const attempts=[
    {id:'attempt-one',status:'interrupted',items:[{id:'u',type:'userMessage',text:'好的继续'},
      {id:'c1',type:'commandExecution',command:'first-check'},
      {id:'p1',type:'agentMessage',phase:'commentary',text:'C# 编译已通过，仍在测试'}]},
    {id:'attempt-two',status:'interrupted',items:[{id:'c2',type:'commandExecution',command:'second-check'},
      {id:'p2',type:'agentMessage',phase:'commentary',text:'102 项检查通过，组合退出仍有问题'}]},
    {id:'attempt-final',status:'completed',items:[{id:'c3',type:'commandExecution',command:'final-check'},
      {id:'p3',type:'agentMessage',phase:'commentary',text:'正在完成短测'},
      {id:'answer',type:'agentMessage',phase:'final_answer',text:'这批已切换到 C#，验证完成'}]}];
  const html=attempts.map(turn=>invoke('renderTurn',turn)).join('');
  assert.equal((html.match(/class="turn-history"/g) || []).length,3);
  assert.equal((html.match(/class="turn-result"/g) || []).length,1);
  assert.match(html,/这批已切换到 C#，验证完成/);
  assert.doesNotMatch(html,/C# 编译已通过|102 项检查通过|正在完成短测|已运行/);
});

test('continuations share one history with combined counts and execution time, retaining their original items',()=>{
  const first={id:'merge-first',turnId:'merge-first',status:'interrupted',startedAt:1000,completedAt:2262000,
    items:[{id:'u',type:'userMessage',text:'继续',at:1000},
      ...Array.from({length:5},(_,i)=>({id:'progress-a-'+i,type:'agentMessage',phase:'commentary',text:'前段过程 '+i})),
      ...Array.from({length:56},(_,i)=>({id:'command-a-'+i,type:'commandExecution',command:'first-command '+i}))]};
  const last={id:'merge-last',turnId:'merge-last',status:'completed',startedAt:2400000,completedAt:5052000,
    items:[...Array.from({length:7},(_,i)=>({id:'progress-b-'+i,type:'agentMessage',phase:'commentary',text:'续跑过程 '+i})),
      ...Array.from({length:23},(_,i)=>({id:'command-b-'+i,type:'commandExecution',command:'last-command '+i})),
      {id:'answer',type:'agentMessage',phase:'final_answer',text:'新版已接入游戏',at:5052000}]};
  const groups=invoke('conversationTurns',[first,last]);assert.equal(groups.length,1);
  const merged=groups[0];assert.equal(merged.turnId,first.turnId);assert.equal(merged.status,'completed');
  assert.deepEqual(Array.from(merged.items,item=>item.id),[...first.items,...last.items].map(item=>item.id));
  assert.equal(first.items.length,62);assert.equal(first.status,'interrupted');assert.equal(last.items.length,31);
  assert.equal(invoke('turnDuration',merged),'用时 1 小时 21 分 53 秒');
  const closed=invoke('renderTurn',merged);
  assert.equal((closed.match(/class="turn-history"/g) || []).length,1);
  assert.match(closed,/上 12 条消息 · 79 条命令/);assert.match(closed,/新版已接入游戏/);
  assert.doesNotMatch(closed,/前段过程|续跑过程|first-command|last-command/);
  vm.runInContext("state.openDetailKeys.add('merge-first:history')",ui);
  try{const expanded=invoke('renderTurn',merged);assert.match(expanded,/前段过程 0/);assert.match(expanded,/续跑过程 6/);}
  finally{vm.runInContext("state.openDetailKeys.delete('merge-first:history')",ui);}
});

test('new user inputs separate rounds while resumed segments keep the first disclosure identity',()=>{
  const input={id:'one',turnId:'one',status:'interrupted',items:[{id:'u1',type:'userMessage',text:'第一个请求'}]};
  const continuation={id:'two',turnId:'two',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'第一个结果'}]};
  const next={id:'three',turnId:'three',status:'completed',items:[{id:'u2',type:'userMessage',text:'第二个请求'},{id:'second',type:'agentMessage',phase:'final_answer',text:'第二个结果'}]};
  const groups=invoke('conversationTurns',[input,continuation,next]);
  assert.equal(groups.length,2);assert.equal(groups[0].turnId,'one');assert.equal(groups[1].turnId,'three');
  assert.deepEqual(Array.from(groups[0].items,item=>item.id),['u1','answer']);
  assert.deepEqual(Array.from(groups[1].items,item=>item.id),['u2','second']);
  const tail=invoke('conversationTurns',[{...input,items:[]},continuation]);
  assert.equal(tail.length,1,'a history page beginning mid-request may also join its continuation');
});

test('merged active rounds use the latest segment result, questions, error state and ticking clock',()=>{
  const question=id=>({id,type:'agentMessage',delivery:'rpc',questions:[{id:id+'-choice',title:id,options:['继续']}]});
  const first={id:'clock-first',turnId:'clock-first',status:'completed',startedAt:1000,completedAt:4000,
    items:[{id:'u',type:'userMessage',text:'开始',at:1000},question('old-question'),{id:'old-final',type:'agentMessage',phase:'final_answer',text:'此前结果',at:3000}],
    alert:{message:'旧的错误'}};
  const last={id:'clock-last',turnId:'clock-last',status:'inProgress',startedAt:10000,
    items:[{id:'progress',type:'agentMessage',phase:'commentary',text:'继续执行',at:11000},question('new-question')]};
  let merged=invoke('conversationTurns',[first,last])[0];
  assert.equal(invoke('turnResult',merged),null);assert.equal(merged.alert,null);
  assert.equal(invoke('turnDuration',merged,20000),'已处理 13 秒');
  assert.equal(invoke('turnProcessingSince',merged,20000),7000);
  const active=invoke('renderTurn',merged);
  assert.match(active,/data-processing-since="7000"/);assert.match(active,/继续执行/);
  assert.equal((active.match(/question-submit/g) || []).length,1,'only the latest segment question is answerable');
  assert.match(active,/本回合已结束/);assert.doesNotMatch(active,/旧的错误/);
  last.items.push({id:'new-final',type:'agentMessage',phase:'final_answer',text:'最终完成',at:22000});
  merged=invoke('conversationTurns',[first,last])[0];
  assert.equal(invoke('turnDuration',merged,90000),'用时 15 秒');
  const completed=invoke('renderTurn',merged);assert.match(completed,/最终完成/);
  assert.doesNotMatch(completed,/此前结果|继续执行|data-processing-since/);
  last.status='interrupted';last.items.pop();
  assert.equal(invoke('turnResult',invoke('conversationTurns',[first,last])[0]),null,'an earlier result must not be promoted after a later interruption');
});

test('timeline rendering applies native metadata before combining continuation segments',()=>{
  const savedDocument=ui.document,savedSync=ui.syncHtmlParts;
  let rows;
  ui.document={getElementById:()=>({scrollHeight:500,scrollTop:500,clientHeight:300,getBoundingClientRect:()=>({top:0,bottom:300}),querySelectorAll:()=>[],style:{setProperty:()=>{}}})};
  ui.syncHtmlParts=(_node,parts)=>{rows=parts;return false;};
  try{
    invoke('renderTimeline',{timeline:[{id:'u',type:'userMessage',turnId:'native-first',text:'继续'},
      {id:'p',type:'agentMessage',phase:'commentary',turnId:'native-first',text:'旧段的过程'},
      {id:'cmd',type:'commandExecution',turnId:'native-last',command:'run-check'},
      {id:'f',type:'agentMessage',phase:'final_answer',turnId:'native-last',text:'续跑后的最终结果'}]},
    {id:'combined-timeline',turnCount:2,turns:[{id:'native-first',status:'interrupted'},{id:'native-last',status:'completed'}]});
    const turns=rows.filter(row=>row.key.startsWith('turn:'));assert.equal(turns.length,1);
    assert.equal(turns[0].key,'turn:native-first');
    assert.match(turns[0].html,/上 1 条消息 · 1 条命令/);assert.match(turns[0].html,/续跑后的最终结果/);
    assert.doesNotMatch(turns[0].html,/旧段的过程|已运行/);
  }finally{ui.document=savedDocument;ui.syncHtmlParts=savedSync;}
});

test('all chat images start hidden and load thumbnails only after an explicit expansion',()=>{
  const savedSession=vm.runInContext('state.activeSessionId',ui),savedSchedule=ui.scheduleRender;
  ui.scheduleRender=()=>{};
  vm.runInContext("state.activeSessionId='image-session'",ui);
  const markdown='- [奥黛塔](D:/path with spaces/odetta.png)\n- ![当前版本](file:///D:/current.png)';
  const images=[{ref:'file:///D:/current.png'},{ref:'D:/reference.png'}];
  const tools=images.map((image,index)=>({id:'view-'+index,type:'imageView',images:[image]}));
  const closed=html=>{assert.match(html,/aria-expanded="false"/);assert.doesNotMatch(html,/<img\b|\bsrc=|class="media-card"|打开原图/);};
  const open=html=>{assert.match(html,/aria-expanded="true"/);assert.match(html,/<img[^>]+preview=1/);assert.match(html,/loading="lazy"/);assert.match(html,/打开原图/);};
  try{
    closed(invoke('renderMarkdown',markdown));
    closed(invoke('processItemDetails',tools[0]));
    closed(invoke('renderProcessGroup',tools,'pictures'));
    for(const type of ['agentMessage','userMessage'])closed(invoke('renderTimelineItem',{id:type,type,images},type));
    closed(invoke('renderAttachments',[{ref:'D:/attachment.png',name:'附件'}]));
    // Rendering a closed group must never ask the media renderer to resolve or load it.
    const cards=vm.runInContext('mediaCards',ui),render=cards.render;
    cards.render=()=>{throw new Error('closed images must not render media');};
    try{closed(invoke('renderMarkdown',markdown));closed(invoke('renderProcessGroup',tools,'pictures'));}
    finally{cards.render=render;}
    const key=invoke('imageDisclosureKey',images,'pictures');
    invoke('toggleImages',key);
    const group=invoke('renderProcessGroup',tools,'pictures');open(group);
    assert.equal((group.match(/class="media-card"/g) || []).length,2);
    // Incoming tool records retain the explicit expansion, including new images.
    open(invoke('renderProcessGroup',[...tools,{type:'imageView',images:[{ref:'D:/new.png'}]}],'pictures'));
    invoke('toggleImages',key);closed(invoke('renderProcessGroup',tools,'pictures'));
    invoke('toggleImages',invoke('imageDisclosureKey',[{ref:'D:/path with spaces/odetta.png'}]));
    const reply=invoke('renderMarkdown',markdown);open(reply);
    assert.match(reply,/\/api\/sessions\/image-session\/media\?ref=D%3A%2Fpath%20with%20spaces%2Fodetta.png/);
    assert.ok(!reply.includes('[奥黛塔]'));
    for(const type of ['agentMessage','userMessage']){
      invoke('toggleImages',invoke('imageDisclosureKey',images,type+':images'));
      open(invoke('renderTimelineItem',{id:type,type,images},type));
    }
    invoke('toggleImages',invoke('imageDisclosureKey',[{ref:'D:/attachment.png'}]));
    open(invoke('renderAttachments',[{ref:'D:/attachment.png'}]));
    const audio=invoke('renderMarkdown','[声音](D:/result.mp3)');assert.match(audio,/播放/);assert.doesNotMatch(audio,/<audio|src=/);
    const unsafe=[{ref:'javascript:alert.png'}];invoke('toggleImages',invoke('imageDisclosureKey',unsafe));
    assert.doesNotMatch(invoke('renderImages',unsafe),/href=|<img\b/);
  }finally{invoke('resetImageVisibility');ui.scheduleRender=savedSchedule;ui.savedImageSession=savedSession;vm.runInContext('state.activeSessionId=savedImageSession',ui);delete ui.savedImageSession;}
});

test('forwarded question answers never claim the desktop question card was submitted',()=>{
  const questions=normalizeQuestions([{title:'如何测试？',options:['Wi-Fi']}],'forwarded');
  const html=invoke('renderQuestion',{id:'forwarded',delivery:'async',questions,answerState:'forwarded',questionAnswers:{[questions[0].id]:'Wi-Fi'}},'forwarded');
  assert.match(html,/回答已送到对话/);assert.match(html,/原生提问卡不会自动提交/);
  assert.ok(!html.includes('提交回答'));
});

test('retry counts and network waits stay visible, and compaction has separate start and completion states', () => {
  const view={timeline:[]};
  invoke('applyCodex',view,{method:'error',params:{turnId:'t',willRetry:true,error:{message:'Reconnecting... waiting for network'},attempt:2,maxAttempts:5}},1000);
  let html=invoke('renderTurn',{id:'t',status:'inProgress',items:[{id:'u',type:'userMessage',text:'继续'}],activity:view.activity});
  assert.match(html,/正在重新连接 2\/5 · 等待网络/);
  assert.ok(!html.includes('正在处理'));
  invoke('applyCodex',view,{method:'item/started',params:{turnId:'t',item:{id:'compact',type:'contextCompaction'}}},2000);
  html=invoke('renderTurn',{id:'t',status:'inProgress',items:[{id:'u',type:'userMessage',text:'继续'}],activity:view.activity});
  assert.match(html,/正在压缩上下文/);
  assert.ok(!html.includes('正在重新连接'));
  invoke('applyCodex',view,{method:'item/completed',params:{turnId:'t',item:{id:'compact',type:'contextCompaction'}}},3000);
  assert.match(invoke('liveActivityLabel',view.activity),/上下文已自动压缩/);
  invoke('applyCodex',view,{method:'turn/completed',params:{turn:{id:'t',status:'completed'}}},4000);
  assert.equal(view.activity,null);
  assert.equal(view.retrying,false);
});

test('processing time starts with user input, survives new activity, and stops at the reply', () => {
  const user = { id:'u', type:'userMessage', text:'继续', at:10000 };
  const turn = { id:'timer', status:'inProgress', startedAt:9000, items:[user], activity:{kind:'reconnect',at:30000,text:'正在重新连接 2/5'} };
  assert.equal(invoke('turnDuration',turn,39000),'已处理 29 秒');
  turn.activity={kind:'contextCompaction',status:'inProgress',at:40000};
  assert.equal(invoke('turnDuration',turn,75000),'已处理 1 分 5 秒');
  let html=invoke('renderTurn',turn);
  assert.match(html,/data-processing-since="10000"/);
  assert.ok(html.indexOf('继续') < html.indexOf('已处理'));
  assert.ok(html.indexOf('已处理') < html.indexOf('正在压缩上下文'));
  assert.ok(!html.includes('没有新状态') && !html.includes('刚收到状态'));
  turn.items.push({id:'reply',type:'agentMessage',phase:'final_answer',text:'完成',at:80000});
  assert.equal(invoke('turnDuration',turn,96000),'用时 1 分 10 秒');
  html=invoke('renderTurn',turn);
  assert.ok(!html.includes('data-processing-since'));
  turn.status='completed'; turn.completedAt=82000;
  assert.equal(invoke('turnDuration',turn,196000),'用时 1 分 12 秒');
  assert.equal(invoke('turnDuration',{items:[],status:'inProgress'},96000),'');
});

test('the ticking clock changes only its label, and unchanged seconds do not write to the DOM', () => {
  const previous=ui.document;
  let writes=0, label='已处理 28 秒';
  const node={dataset:{processingSince:'10000'},get textContent(){return label;},set textContent(value){writes++;label=value;}};
  ui.document={querySelectorAll(selector){return selector==='[data-command-since]'?[]:[node];}};
  try {
    invoke('refreshProcessingTimes',39000);
    assert.equal(label,'已处理 29 秒'); assert.equal(writes,1);
    invoke('refreshProcessingTimes',39500);
    assert.equal(writes,1);
    invoke('refreshProcessingTimes',75000);
    assert.equal(label,'已处理 1 分 5 秒'); assert.equal(writes,2);
  } finally { ui.document=previous; }
});

test('the latest command shows its own clock, retains start across output, and stops when completed',()=>{
  const view={timeline:[]};
  invoke('applyCodex',view,{method:'item/started',params:{turnId:'t',item:{id:'cmd',type:'commandExecution',command:'check'}}},1000);
  invoke('applyCodex',view,{method:'item/commandExecution/outputDelta',params:{turnId:'t',itemId:'cmd',delta:'progress'}},5000);
  assert.equal(view.activity.startedAt,1000);
  const turn={id:'t',status:'inProgress',items:[{id:'u',type:'userMessage',text:'检查',at:1}],activity:view.activity};
  assert.match(invoke('renderTurn',turn),/data-command-since="1000"/);
  invoke('applyCodex',view,{method:'item/completed',params:{turnId:'t',item:{id:'cmd',type:'commandExecution',command:'check'}}},8000);
  turn.activity=view.activity;const html=invoke('renderTurn',turn);
  assert.match(html,/上一条命令已结束/);assert.match(html,/本轮已执行/);assert.doesNotMatch(html,/用时 7 秒|data-command-since/);
  const restored={timeline:[]};invoke('applyCodex',restored,{method:'item/completed',params:{turnId:'t',item:{id:'active',type:'commandExecution',command:'ongoing',status:'inProgress',startedAt:2000}}},9000);
  assert.equal(restored.activity.status,'inProgress');assert.equal(restored.activity.startedAt,2000);
  invoke('applyCodex',restored,{method:'item/started',params:{turnId:'t',item:{id:'active',type:'commandExecution',status:'completed',durationMs:7000}}},10000);
  assert.equal(restored.activity.status,'completed','a reconstructed output overlay cannot restart an ended command');
});

test('the live footer follows a running command even when a parallel command completed more recently',()=>{
  const running={id:'long',turnId:'parallel',type:'commandExecution',command:'long check',status:'inProgress',startedAt:1000,at:1000};
  const completed={id:'short',turnId:'parallel',type:'commandExecution',command:'short check',status:'completed',startedAt:8000,completedAt:9000,durationMs:1000,at:9000};
  const turn={id:'parallel',status:'inProgress',items:[{id:'u',type:'userMessage',at:1},running,completed],activity:completed};
  const html=invoke('renderTurn',turn);
  assert.equal(invoke('currentCommand',turn).id,'long');assert.match(html,/命令已执行/);assert.match(html,/data-command-since="1000"/);
  assert.doesNotMatch(html,/上一条命令已结束|本轮已执行/);
  const resumed={...turn,activity:null,segments:[turn,{id:'next',status:'inProgress',items:[],activity:null}]};
  assert.equal(invoke('currentCommand',resumed),null,'unfinished commands in an earlier interrupted segment cannot restart their clocks');
});

test('after a command ends the live footer times the ongoing request, with the finished duration available only on expansion',()=>{
  const turn={id:'post-command',status:'inProgress',items:[{id:'u',type:'userMessage',at:1000}],activity:{id:'ended',type:'commandExecution',status:'completed',durationMs:0,command:'finished'}};
  const closed=invoke('renderTurn',turn);assert.match(closed,/本轮已执行/);assert.doesNotMatch(closed,/用时 0 秒/);
  vm.runInContext("state.openDetailKeys.add('post-command:activity:ended')",ui);
  try{assert.match(invoke('renderTurn',turn),/用时 0 秒/);}finally{vm.runInContext("state.openDetailKeys.delete('post-command:activity:ended')",ui);}
  const old=ui.document,classes=new Set();let commandLabel='',requestLabel='';
  const command={dataset:{commandSince:'1000',commandCurrent:'true'},get textContent(){return commandLabel;},set textContent(value){commandLabel=value;},classList:{contains:name=>classes.has(name),toggle:(name,on)=>on?classes.add(name):classes.delete(name)}};
  const request={dataset:{processingSince:'1000',processingKind:'live'},get textContent(){return requestLabel;},set textContent(value){requestLabel=value;}};
  ui.document={querySelectorAll:selector=>selector==='[data-command-since]'?[command]:[request]};
  try{invoke('refreshProcessingTimes',121000);assert.equal(commandLabel,'命令已执行 2 分 0 秒');assert.equal(requestLabel,'本轮已执行 2 分 0 秒');invoke('refreshProcessingTimes',181000);assert.equal(commandLabel,'命令已执行 3 分 0 秒');assert.equal(requestLabel,'本轮已执行 3 分 0 秒');}finally{ui.document=old;}
});

test('command clocks update only their text and warning threshold, without rerendering messages',()=>{
  const old=ui.document,classes=new Set();let label='',writes=0,toggles=0;
  const node={dataset:{commandSince:'1000'},get textContent(){return label;},set textContent(value){writes++;label=value;},classList:{contains:name=>classes.has(name),toggle(name,on){toggles++;on?classes.add(name):classes.delete(name);}}};
  ui.document={querySelectorAll:selector=>selector==='[data-command-since]'?[node]:[]};
  try{
    invoke('refreshProcessingTimes',5000);assert.equal(label,'已运行 4 秒');assert.equal(writes,1);assert.equal(toggles,0);
    invoke('refreshProcessingTimes',5500);assert.equal(writes,1);
    invoke('refreshProcessingTimes',601000);assert.match(label,/运行较久/);assert.equal(toggles,1);
    invoke('refreshProcessingTimes',601500);assert.equal(toggles,1);
  }finally{ui.document=old;}
});

test('each command row has its own duration and lazily expanded command output',()=>{
  const item={id:'duration-row',type:'commandExecution',command:'node check.mjs',status:'completed',startedAt:1000,completedAt:15000,output:'private output'};
  const closed=invoke('renderProcessItem',item,0,'duration-test');
  assert.match(closed,/用时 14 秒/);assert.match(closed,/<details class="process-item"/);assert.doesNotMatch(closed,/private output|data-command-since/);
  vm.runInContext("state.openDetailKeys.add('duration-test:duration-row')",ui);
  try{assert.match(invoke('renderProcessItem',item,0,'duration-test'),/private output/);}finally{vm.runInContext("state.openDetailKeys.delete('duration-test:duration-row')",ui);}
  const running=invoke('renderProcessItem',{...item,status:'inProgress'},0,'duration-test');
  assert.match(running,/正在运行 node check.mjs/);assert.match(running,/data-command-since="1000"/);
  assert.doesNotMatch(invoke('renderProcessItem',{id:'retry',type:'reconnect',text:'Retry'},0),/command-elapsed/);
});

test('latest command outside the folded process group has an expandable detail and resets for the next command',()=>{
  const turn={id:'live-expand',status:'inProgress',items:[{id:'u',type:'userMessage',text:'Run'}],activity:{id:'cmd-a',type:'commandExecution',status:'inProgress',command:'check',output:'live output',startedAt:1000}};
  const closed=invoke('renderTurn',turn);assert.match(closed,/<details class="turn-live-command"/);assert.doesNotMatch(closed,/live output/);
  vm.runInContext("state.openDetailKeys.add('live-expand:activity:cmd-a')",ui);
  try{
    assert.match(invoke('renderTurn',turn),/live output/);
    turn.items.push({...turn.activity,aggregatedOutput:'fresh streamed output'});assert.match(invoke('renderTurn',turn),/fresh streamed output/);
    turn.activity={...turn.activity,id:'cmd-b'};assert.doesNotMatch(invoke('renderTurn',turn),/live output/);
  }finally{vm.runInContext("state.openDetailKeys.delete('live-expand:activity:cmd-a')",ui);}
});

test('async questions keep the timer running, preserve selected drafts, and release the latest progress after an answer', () => {
  const questions=normalizeQuestions([{title:'如何连接手机？',options:['同一 Wi-Fi','外网']}],'ask','async');
  const turn={id:'q-turn',status:'inProgress',items:[{id:'u',type:'userMessage',text:'开始',at:10000},
    {id:'ask',type:'agentMessage',phase:'final_answer',delivery:'async',questions,at:20000}]};
  let html=invoke('renderTurn',turn);
  assert.match(html,/data-processing-since="10000"/);
  assert.match(html,/question-option/); assert.match(html,/提交回答/);
  assert.equal(invoke('turnDuration',turn,39000),'已处理 29 秒');
  vm.runInContext(`questionDrafts.set('ask',{[${JSON.stringify(questions[0].id)}]:'同一 Wi-Fi'})`,ui);
  html=invoke('renderTurn',turn);
  assert.match(html,/aria-pressed="true"/);
  turn.items[1].questionAnswers={[questions[0].id]:'同一 Wi-Fi'};
  turn.items[1].answerState='answered';
  turn.items.push({id:'progress',type:'agentMessage',phase:'commentary',text:'继续配置手机连接',at:40000});
  html=invoke('renderTurn',turn);
  assert.match(html,/继续配置手机连接/);
  assert.match(html,/data-processing-since/);
  assert.ok(!html.includes('提交回答'));
  turn.items.push({id:'final',type:'agentMessage',phase:'final_answer',text:'配置完成',at:90000});
  assert.equal(invoke('turnDuration',turn,190000),'用时 1 分 20 秒');
  assert.ok(!invoke('renderTurn',turn).includes('data-processing-since'));
});

test('a continued turn resumes after an earlier final answer, and steering user input remains present', () => {
  const items=[{id:'u',type:'userMessage',text:'开始',turnId:'t',at:10000},
    {id:'f',type:'agentMessage',phase:'final_answer',text:'之前的回答',turnId:'t',at:20000},
    {id:'u2',type:'userMessage',text:'继续并修复',turnId:'t',at:30000},
    {id:'c',type:'agentMessage',phase:'commentary',text:'新的进度',turnId:'t',at:40000}];
  const turn=invoke('timelineTurns',items)[0];turn.status='inProgress';
  assert.equal(turn.items.filter(item=>item.type === 'userMessage').length,2);
  assert.equal(invoke('turnDuration',turn,49000),'已处理 39 秒');
  const html=invoke('renderTurn',turn);
  assert.match(html,/新的进度/);assert.match(html,/data-processing-since/);
});

test('completed history separates real messages from commands without counting compaction or process records as messages', () => {
  const user = { id: 'u', type: 'userMessage', text: '我的请求', turnId: 'turn' };
  const comment = { id: 'c', type: 'agentMessage', phase: 'commentary', text: '检查数据', turnId: 'turn' };
  const commands = Array.from({ length: 161 }, (_, i) => ({ id: `cmd-${i}`, type: 'commandExecution', command: 'node --check app.js', turnId: 'turn' }));
  const compact = { id: 'compact', type: 'contextCompaction', turnId: 'turn' };
  const final = { id: 'final', type: 'agentMessage', phase: 'final_answer', text: '最终结果', turnId: 'turn' };
  const turn = { id: 'turn', turnId: 'turn', status: 'completed', items: [user, comment, ...commands, compact, final] };
  const html = invoke('renderTurn', turn);
  assert.match(html, /上 1 条消息 · 161 条命令/);
  assert.ok(html.indexOf('我的请求') < html.indexOf('上 1 条消息'));
  assert.ok(html.indexOf('上 1 条消息') < html.indexOf('最终结果'));
  assert.ok(!html.includes('检查数据') && !html.includes('node --check'));
  assert.ok(!html.includes('Codex</strong>') && !html.includes('163 条命令'));
  assert.ok(!/<details[^>]+\sopen(?:\s|>)/.test(html));
  vm.runInContext("state.openDetailKeys.add('turn:history')", ui);
  const expanded = invoke('renderTurn', turn);
  assert.ok(expanded.indexOf('检查数据') < expanded.indexOf('上下文已自动压缩'));
  assert.match(expanded, /已执行 161 条命令/);
  assert.ok(!expanded.includes('已运行 node --check'));
  vm.runInContext("state.openDetailKeys.add('turn:process:cmd-0:group')", ui);
  assert.match(invoke('renderTurn', turn), /已运行 node --check/);
  vm.runInContext('state.openDetailKeys.clear()', ui);
});

test('command text does not create fake compaction or reconnection notices', () => {
  const command = { type: 'commandExecution', command: 'rg -n "reconnect|contextCompaction|browser" public/app.js' };
  assert.equal(invoke('processKind', command), 'command');
  assert.equal(invoke('processGroupLabel', [command]), '已执行 1 条命令');
  const browser = { type: 'mcpToolCall', server: 'cua_repl', name: 'js', title: '读取当前界面' };
  assert.equal(invoke('processItemLabel', browser), '读取当前界面');
  assert.equal(invoke('processGroupLabel', [browser, command]), '已执行 1 条命令 · 已使用浏览器');
  const edit = { type: 'fileChange', changes: [{ path: 'C:/project/app.js', additions: 11, deletions: 3, diff: '+new\n-old' }] };
  assert.equal(invoke('processItemLabel', edit), '已编辑 app.js +11 -3');
  assert.match(invoke('processItemDetails', edit), /\+new\n-old/);
});

test('commands, process records and reconnect attempts share a collapsed group with only real commands counted',()=>{
  const items=[{id:'record',type:'system',text:'已记录过程'},
    {id:'first-command',type:'commandExecution',command:'npm test'},
    {id:'reconnect-1',type:'reconnect',text:'正在重新连接 1/5'},
    {id:'record-2',type:'unknown'},
    {id:'second-command',type:'toolCall',name:'functions.exec_command',input:'{"cmd":"node --check public/app.js"}'},
    {id:'output',type:'toolOutput',output:'passed'},
    {id:'reconnect-2',type:'reconnect',text:'正在重新连接 2/5'}];
  const rows=invoke('displayTimelineRows',items);assert.equal(rows.length,1);assert.equal(rows[0].items.length,7);
  assert.equal(invoke('processCommandCount',items),2);
  assert.equal(invoke('turnHistoryLabel',items),'2 条命令');
  const prefix='mixed-process',closed=invoke('renderLiveProcessGroup',items,prefix);
  assert.match(closed,/已执行 2 条命令/);assert.doesNotMatch(closed,/正在重新连接|已记录过程|npm test|class="process-item"/);
  items.push({id:'reconnect-3',type:'reconnect',text:'正在重新连接 3/5'});
  assert.equal(invoke('renderLiveProcessGroup',items,prefix),closed,'closed groups do not repaint for non-command records');
  vm.runInContext("state.openDetailKeys.add('mixed-process:group')",ui);
  try{
    const open=invoke('renderLiveProcessGroup',items,prefix);
    assert.match(open,/已执行 2 条命令/);assert.match(open,/已记录过程/);assert.match(open,/正在重新连接 1\/5/);assert.match(open,/正在重新连接 3\/5/);assert.match(open,/已运行 npm test/);
    assert.equal((open.match(/class="process-item"/g) || []).length,8);
    items.push({id:'third-command',type:'commandExecution',command:'git status'});
    const updated=invoke('renderLiveProcessGroup',items,prefix);
    assert.match(updated,/已执行 3 条命令/);assert.match(updated,/已运行 git status/);assert.match(updated,/data-detail-key="mixed-process:group"/);
    assert.equal(vm.runInContext("state.openDetailKeys.has('mixed-process:group')",ui),true);
  }finally{vm.runInContext("state.openDetailKeys.delete('mixed-process:group')",ui);}
});

test('process-only histories have no fake command or message count and generic tool output never becomes a command',()=>{
  const records=[{type:'unknown'},{type:'toolOutput',output:'exec_command reconnect'},{type:'reconnect',text:'正在重新连接 1/5'},{type:'system',text:'已记录过程'}];
  assert.equal(invoke('processGroupLabel',records),'过程记录');assert.equal(invoke('turnHistoryLabel',records),'过程记录');
  assert.equal(invoke('processCommandCount',[...records,{type:'fileChange'},{type:'contextCompaction'},{type:'mcpToolCall',server:'cua_repl',name:'js'}]),0);
  assert.equal(invoke('processCommandCount',[{type:'mcpToolCall',server:'shell',name:'exec_command',input:'{"cmd":"echo ok"}'}]),1);
  const html=invoke('renderTurn',{id:'records-only',status:'completed',items:[{id:'u',type:'userMessage',text:'开始'},...records,{id:'final',type:'agentMessage',phase:'final_answer',text:'已完成'}]});
  assert.match(html,/过程记录/);assert.doesNotMatch(html,/\d+ 条命令|\d+ 条消息/);
});

test('questions interrupt a folded process group and remain answerable while command details are collapsed',()=>{
  const question={id:'fold-question',type:'mcpToolCall',delivery:'rpc',questions:[{id:'choice',title:'下一步怎么处理？',options:['继续','等待']}]};
  const commands=[{id:'before',type:'commandExecution',command:'echo before'},question,{id:'after',type:'commandExecution',command:'echo after'}];
  assert.deepEqual(Array.from(invoke('displayTimelineRows',commands),row=>row.type),['processGroup','mcpToolCall','processGroup']);
  const html=invoke('renderTurn',{id:'question-between-commands',status:'inProgress',items:[{id:'u',type:'userMessage',text:'开始'},...commands]});
  assert.match(html,/下一步怎么处理/);assert.match(html,/question-submit/);
  assert.equal((html.match(/已执行 1 条命令/g) || []).length,2);assert.doesNotMatch(html,/已运行 echo before|已运行 echo after/);
});

test('user turns stay complete; phase distinguishes interim messages from a final answer', () => {
  const turns = invoke('timelineTurns', [
    { id: 'u1', type: 'userMessage', turnId: 'a', text: '一' },
    { id: 'c1', type: 'agentMessage', turnId: 'a', phase: 'commentary', text: '检查一' },
    { id: 'c2', type: 'agentMessage', turnId: 'a', phase: 'commentary', text: '检查二' },
    { id: 'f1', type: 'agentMessage', turnId: 'a', phase: 'final_answer', text: '完成' },
    { id: 'u2', type: 'userMessage', turnId: 'b', text: '二' }
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].items.length, 4);
  const html = invoke('renderTurn', { ...turns[0], status: 'completed' });
  assert.match(html, /上 2 条消息/);
  const active = invoke('renderTurn', { ...turns[0], status: 'inProgress', items: turns[0].items.slice(0, 3) });
  assert.ok(!active.includes('turn-history'));
  assert.match(active, /检查一/); assert.match(active, /检查二/);
  assert.match(active, /正在处理/);
});

test('initial render can position an empty or new conversation at the latest content', () => {
  ui.document = { getElementById: () => ({ scrollHeight: 500, scrollTop: 500, clientHeight: 300, getBoundingClientRect: () => ({ top: 0, bottom: 300 }), querySelectorAll: () => [] }) };
  ui.syncHtmlParts = () => false;
  assert.doesNotThrow(() => invoke('renderTimeline', { timeline: [] }, { id: 'initial' }));
});

test('cached Markdown refreshes edited text and image visibility stays scoped to the conversation', () => {
  const original = ui.mediaUrl;
  const savedSession=vm.runInContext('state.activeSessionId',ui);
  let route = '/api/sessions/first/media';
  ui.mediaUrl = () => route;
  try {
    const markdown = '![附图](D:/result.png)\n[打开图片](<D:/result.webp>)';
    vm.runInContext("state.activeSessionId='first'",ui);
    assert.doesNotMatch(invoke('renderMarkdown',markdown),/<img\b/);
    for(const ref of ['D:/result.png','D:/result.webp'])vm.runInContext(`state.openDetailKeys.add(${JSON.stringify(invoke('imageDisclosureKey',[{ref}]))})`,ui);
    assert.match(invoke('renderMarkdown', markdown), /sessions\/first/);
    vm.runInContext("state.activeSessionId='second'",ui);
    route = '/api/sessions/second/media';
    assert.doesNotMatch(invoke('renderMarkdown',markdown),/<img\b/);
    for(const ref of ['D:/result.png','D:/result.webp'])vm.runInContext(`state.openDetailKeys.add(${JSON.stringify(invoke('imageDisclosureKey',[{ref}]))})`,ui);
    assert.match(invoke('renderMarkdown', markdown), /sessions\/second/);
    assert.match(invoke('renderMarkdown', '**old text**'), /<strong>old text<\/strong>/);
    assert.match(invoke('renderMarkdown', '**edited text**'), /<strong>edited text<\/strong>/);
  } finally {ui.mediaUrl=original;invoke('resetImageVisibility');ui.savedImageSession=savedSession;vm.runInContext('state.activeSessionId=savedImageSession',ui);delete ui.savedImageSession;}
});

test('switching conversations hides previously expanded images but preserves command disclosures',()=>{
  const originalDocument=ui.document,originalSync=ui.syncHtmlParts;
  const savedSession=vm.runInContext('state.activeSessionId',ui),savedRendered=vm.runInContext('renderedSessionId',ui);
  ui.document={getElementById:()=>({scrollHeight:500,scrollTop:500,clientHeight:300,getBoundingClientRect:()=>({top:0,bottom:300}),querySelectorAll:()=>[]})};
  ui.syncHtmlParts=()=>false;
  try{
    vm.runInContext("state.activeSessionId='privacy-first';renderedSessionId='privacy-first';state.openDetailKeys.add('keep-command:group')",ui);
    const images=[{ref:'D:/private.png'}],key=invoke('imageDisclosureKey',images);
    vm.runInContext(`state.openDetailKeys.add(${JSON.stringify(key)})`,ui);
    invoke('renderTimeline',{timeline:[]},{id:'privacy-first'});
    assert.match(invoke('renderImages',images),/<img\b/);
    vm.runInContext("state.activeSessionId='privacy-second'",ui);
    invoke('renderTimeline',{timeline:[]},{id:'privacy-second'});
    vm.runInContext("state.activeSessionId='privacy-first'",ui);
    invoke('renderTimeline',{timeline:[]},{id:'privacy-first'});
    assert.doesNotMatch(invoke('renderImages',images),/<img\b/);
    assert.equal(vm.runInContext("state.openDetailKeys.has('keep-command:group')",ui),true);
  }finally{
    ui.document=originalDocument;ui.syncHtmlParts=originalSync;ui.savedImageSession=savedSession;ui.savedRenderedSession=savedRendered;
    vm.runInContext("state.activeSessionId=savedImageSession;renderedSessionId=savedRenderedSession;state.openDetailKeys.delete('keep-command:group')",ui);
    delete ui.savedImageSession;delete ui.savedRenderedSession;invoke('resetImageVisibility');
  }
});

test('live activity and model-capacity errors stay visible outside collapsed history', () => {
  const html=invoke('renderTurn',{id:'live',status:'inProgress',items:[{id:'u',type:'userMessage',text:'继续'},{id:'cmd',type:'commandExecution',command:'npm test'}],activity:{kind:'commandExecution',command:'npm test',status:'inProgress'},alert:{message:'Selected model is at capacity. Please try a different model.',retrying:true}});
  assert.match(html,/正在运行 npm test/);
  assert.match(html,/Selected model is at capacity/);
  assert.match(html,/role="alert"/);
  assert.ok(html.indexOf('Selected model')>html.indexOf('</details>'));
});

test('a command finishing after model capacity failure preserves the actual failure until a new turn starts',()=>{
  const view=invoke('blankView',{id:'capacity-fixture'}),message='Selected model is at capacity. Please try a different model.';
  invoke('applyCodex',view,{method:'turn/started',params:{turn:{id:'failed-turn'}}},100);
  invoke('applyCodex',view,{method:'error',params:{threadId:'thread',turnId:'failed-turn',error:{message},willRetry:false}},200);
  invoke('applyCodex',view,{method:'turn/completed',params:{turn:{id:'failed-turn',status:'failed',error:{message}}}},201);
  invoke('applyCodex',view,{method:'item/completed',params:{turnId:'failed-turn',item:{id:'late-command',type:'commandExecution',status:'completed',command:'run test',exitCode:0}}},300);
  assert.equal(view.status,'failed');assert.equal(view.error,message);
  const html=invoke('renderViewError',view,[]);
  assert.match(html,/模型暂时繁忙/);assert.match(html,/Selected model is at capacity/);assert.doesNotMatch(html,/没有返回具体错误/);
  invoke('applyCodex',view,{method:'turn/started',params:{turn:{id:'next-turn'}}},400);
  assert.equal(view.error,null);assert.equal(view.status,'running');assert.equal(invoke('renderViewError',view,[]),'');
});

test('a failed history turn with a known error never also claims the device returned no error',()=>{
  const alert={message:'Selected model is at capacity. Please try a different model.',retrying:false};
  const turn={id:'failed-turn',status:'failed',alert,items:[]};
  assert.match(invoke('renderTurn',turn),/模型暂时繁忙/);
  assert.equal(invoke('renderViewError',{status:'failed',error:null},[turn]),'');
  assert.equal(invoke('renderViewError',{status:'failed',error:alert.message},[turn]),'');
  assert.match(invoke('renderViewError',{status:'failed'},[]),/暂未取得具体原因/);
  assert.match(invoke('renderViewError',{status:'failed',error:'Different failure'},[turn]),/Different failure/);
});

test('consecutive image-only sends remain separate user messages', () => {
  const view=invoke('blankView',{});
  invoke('applyRelay',view,{id:'u1',type:'user_message',text:'',images:[{url:'/api/uploads/a'}],at:1});
  invoke('applyRelay',view,{id:'u2',type:'user_message',text:'',images:[{url:'/api/uploads/b'}],at:2});
  assert.equal(view.timeline.length,2);
  assert.equal(invoke('timelineTurns',view.timeline).length,2);
});
