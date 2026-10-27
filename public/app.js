import { syncHtml, syncHtmlParts } from './dom-sync.js';
import { TextRenderCache } from './render-cache.js';
import {MediaCards} from './media-cards.js';
import {mediaKind} from './media-types.js';
import {searchSessions,sessionSearchActive,sessionFilterLabels} from './session-search.js';
import {sessionAttention,attentionLabel,TaskNotices} from './session-attention.js';
import {ProjectOrder} from './project-order.js';
import {ProjectManagement} from './project-management.js';
import {ProjectSorter} from './project-sort.js';
import {deviceName as validateComputerName} from './device-names.js';
import {pendingSessions,nextPendingSession} from './unread-navigation.js';
import {isLocalHtml,isLocalDocument,htmlPreviewUrl,htmlLinkMatches} from './html-links.js';
import { effectiveSettings, effortLabels, projectsForDevice, sessionChoices } from './composer-settings.js';
import {selectableModels,preferredModel} from './model-preferences.js';
import { runtimeNotice, composerModelLabel } from './runtime-status.js';
import { checkAccess, setupAccess, showAccessRequired } from './access.js';
import { normalizeQuestions } from './questions.js';
import { Drafts, LiveConnection, requestId } from './reliability.js';
import { sessionIndicator, codexSettingsLabel, canMarkSessionRead } from './session-status.js';
import { projectCounts, quotaWindowName,compactTokens,TokenRateTracker } from './usage.js';
import {usagePeriod,usageRangeKey} from './usage-range.js';
import { TimelineViewport } from './timeline-scroll.js';
import { approvalChoices } from './native-requests.js';
import { turnControls, turnInput } from './turn-controls.js';
import {setupServiceHealth,renderServiceHealth} from './service-health.js';
import {setupThreadOwnership} from './thread-ownership.js';
import {ImageUploads} from './uploads.js';
import {setupConnectors} from './connectors.js';
import {deviceSession} from './device-selection.js';
import {DirectConnections,requestDevice,peerResponse} from './direct-connection.js';
import {applyHistoryUpdate} from './history-sync.js';
import {HistoryPreloader} from './history-preload.js';
import {setupComputerEntries} from './computer-entries.js';
import {ContextTools} from './context-tools.js';
import {contextFromText} from './context-state.js';
import {performanceSettings} from './performance-settings.js';
import {setupPerformanceSettings} from './performance-settings-ui.js';
import {setupMaintenance} from './maintenance.js';
import {itemTiming,commandTiming} from './command-timing.js';
import {setupChatGptMode} from './chatgpt-mode.js';
import {ResumeCache,resumeSnapshot} from './resume-cache.js';
import {connectionExperience} from './connection-state.js';
import {setupMobileLayout} from './mobile-layout.js';
import {setupAppInstall} from './app-install.js';
import {setupBackgroundNotices} from './background-notices.js';
import {appIconThemes,resolveAppIcon} from './app-icon-themes.js';
import {LatestNavigation} from './latest-navigation.js';

const state = { devices: [], sessions: [], projects: [], catalogs: new Map(), catalogLoads: new Set(), attachments: [], uploading: 0, sending: false, sessionsChoices: {}, activeSessionId: null, activeProjectId: null, sessionListLimits: new Map(), selectedDeviceId: 'local', views: new Map(), timelineLimits: new Map(), historyLoads: new Set(), historyReloads: new Set(), openDetailKeys: new Set(), stream: null };
let contextTools=null;
state.sessionQuery='';state.sessionFilter='all';state.sessionResultLimit=5;
state.pendingMode=false;state.pendingSwitching=false;state.unreadVisit=null;
state.collapsedProjects=new Set();
try{state.collapsedProjects=new Set(JSON.parse(localStorage.getItem('codex-relay-collapsed-projects') || '[]'));state.sessionListLimits=new Map(Object.entries(JSON.parse(localStorage.getItem('codex-relay-project-limits') || '{}')));}catch{}
state.usages = new Map();
state.historicalUsages=new Map();
const tokenRates=new TokenRateTracker(),historyUsageLoads=new Set();
const historicalRangeUsages=new Map(),historyRangeLoads=new Set();
const defaultUsagePeriod=usagePeriod('month');
state.historyUsageFilter={preset:'month',start:defaultUsagePeriod.fromDate,end:defaultUsagePeriod.toDate};
state.processLimits = new Map();
state.deviceSessions={};
try{state.deviceSessions=JSON.parse(localStorage.getItem('codex-relay-device-sessions') || '{}');}catch{}
try { state.sessionsChoices = JSON.parse(localStorage.getItem('codex-relay-send-options') || '{}'); } catch { /* first use */ }
// Fast is conversation-scoped; discard the old device-wide flag from earlier builds.
for (const key of Object.keys(state.sessionsChoices)) if (key.startsWith('device:')) delete state.sessionsChoices[key].serviceTier;
try { state.activeSessionId = localStorage.getItem('codex-relay-active-session'); state.restoreSessionId = state.activeSessionId; } catch { /* first use */ }
let renderTimer = null;
const pendingSends = new Map();
let draftStorage;try{draftStorage=localStorage;}catch{/* memory fallback */}
const drafts=new Drafts(draftStorage);
const resumeCache=new ResumeCache();let resumeSaveTimer=null,latestNavigation=null,restoredPreview=null;
let backgroundNotices=null;
function saveResumePreview(){
  if(state.accessRequired || state.restoringPreview)return;
  const positions=Object.fromEntries(timelineViewport.positions);
  if(timelineViewport.sessionId)positions[timelineViewport.sessionId]={top:$('messages')?.scrollTop || 0,inputId:timelineViewport.inputId};
  resumeCache.write(resumeSnapshot(state.sessions,state.activeSessionId,positions)).catch(()=>{});
}
function scheduleResumeSave(){if(typeof window==='undefined')return;clearTimeout(resumeSaveTimer);resumeSaveTimer=setTimeout(saveResumePreview,1200);}
function currentPerformance(deviceId=state.selectedDeviceId){return performanceSettings(device(deviceId)?.performanceSettings);}
function initialHistoryLimit(session=activeSession()){return currentPerformance(session?.deviceId).historyTurns;}
function requestedHistoryLimit(session){return state.timelineLimits.get(session?.id) || initialHistoryLimit(session);}
const historyPreloader=new HistoryPreloader({storage:draftStorage,
  getState:()=>({sessions:state.sessions,activeId:state.activeSessionId,deviceId:state.selectedDeviceId,
    enabled:currentPerformance().preloadEnabled,limit:currentPerformance().preloadCount,scope:currentPerformance().preloadScope,projectId:state.activeProjectId,historyTurns:currentPerformance().historyTurns,
    paused:typeof document==='undefined' || document.hidden || state.accessRequired || !device(state.selectedDeviceId)?.online
      || state.historyLoads.has(state.activeSessionId) || Boolean(activeSession()?.historyRequested && !activeSession()?.historyLoaded)}),
  isCached:session=>state.historyLoads.has(session.id) || session.historyRequested && !session.historyLoaded || session.loadedHistoryVersion!=null
    && (!session.historyVersion || session.loadedHistoryVersion===session.historyVersion)
    && (session.loadedHistoryLimit==='all' || requestedHistoryLimit(session)!=='all' && session.loadedHistoryLimit>=requestedHistoryLimit(session)),
  load:session=>ensureSessionHistory(session,{background:true})});
const projectOrder=new ProjectOrder(draftStorage);
let projectManager=null,projectManagerRequest=0,projectSorter=null,projectSaving=false;
const taskNoticeTracker=new TaskNotices(draftStorage);
const taskNoticeItems=new Map();
let noticeSound=false,noticeSystem=false,noticeAudio=null;
try{noticeSound=localStorage.getItem('codex-relay-notice-sound')==='true';}catch{}
try{noticeSystem=localStorage.getItem('codex-relay-notice-system')==='true';}catch{}
const imageUploads=new ImageUploads({api:(...args)=>api(...args),drafts,onChange:scope=>{
  state.uploading=imageUploads.busy;
  if(scope===(composerSessionId || '$new-task'))state.attachments=[...(drafts.get(scope).attachments || [])];
  renderComposer();
}});
let composerSessionId=null;
const deliveryChecks=new Set();
const editSubmissions=new Set(),editChecks=new Set(),queueSubmissions=new Set(),queueChecks=new Set();
let modelManagementDeviceId=null;
const readingSessions=new Set();
const questionDrafts = new Map();
const questionSubmissions = new Set();
const $ = id => document.getElementById(id);
const paneStorageKey = 'codex-relay-pane-layout';
const paneState = (() => { try { return { sidebarWidth: 252, inspectorWidth: 286, sidebarCollapsed: false, inspectorCollapsed: false, ...JSON.parse(localStorage.getItem(paneStorageKey) || '{}') }; } catch { return { sidebarWidth:252, inspectorWidth:286, sidebarCollapsed:false, inspectorCollapsed:false }; } })();

function savePaneLayout() { try { localStorage.setItem(paneStorageKey, JSON.stringify(paneState)); } catch { /* storage may be unavailable */ } }
function applyPaneLayout() {
  const app = $('app');
  app.style.setProperty('--sidebar-width', `${paneState.sidebarWidth}px`); app.style.setProperty('--inspector-width', `${paneState.inspectorWidth}px`);
  app.classList.toggle('sidebar-hidden', paneState.sidebarCollapsed); app.classList.toggle('right-hidden', paneState.inspectorCollapsed);
}
function togglePane(side, collapsed) { paneState[side === 'left' ? 'sidebarCollapsed' : 'inspectorCollapsed'] = collapsed; applyPaneLayout(); savePaneLayout(); }
function isMobileLayout() { return window.matchMedia('(max-width:650px)').matches; }
function toggleMobileNavigation(open) {
  $('app').classList.toggle('mobile-nav-open',open);
  $('mobileNavBackdrop').classList.toggle('hidden',!open);
  $('showSidebarBtn').setAttribute('aria-expanded',String(open));
  if (open) closeComposerPopovers();
  else maybeMarkSessionRead();
}
function closeMobileNavigation() { toggleMobileNavigation(false); }
function setupPaneLayout() {
  applyPaneLayout();
  $('hideSidebarBtn').onclick = () => isMobileLayout() ? closeMobileNavigation() : togglePane('left', true);
  $('showSidebarBtn').onclick = () => isMobileLayout() ? toggleMobileNavigation(!$('app').classList.contains('mobile-nav-open')) : togglePane('left', false);
  $('mobileNavBackdrop').onclick=closeMobileNavigation;
  $('hideInspectorBtn').onclick = () => togglePane('right', true); $('showInspectorBtn').onclick = () => togglePane('right', false);
  const contextSection = document.querySelector('.inspector-section'); $('inspectorSectionToggle').onclick = () => { contextSection.classList.toggle('collapsed'); $('inspectorSectionToggle').textContent = contextSection.classList.contains('collapsed') ? '+' : '−'; };
  for (const [id, side] of [['leftResize','left'], ['rightResize','right']]) {
    const handle = $(id); let dragging = false; let startX = 0; let startWidth = 0;
    handle.addEventListener('pointerdown', event => { if (side === 'left' ? paneState.sidebarCollapsed : paneState.inspectorCollapsed) return; dragging = true; startX = event.clientX; startWidth = side === 'left' ? paneState.sidebarWidth : paneState.inspectorWidth; handle.classList.add('dragging'); document.body.classList.add('is-resizing'); handle.setPointerCapture?.(event.pointerId); event.preventDefault(); });
    handle.addEventListener('pointermove', event => { if (!dragging) return; const delta = event.clientX - startX; const next = side === 'left' ? startWidth + delta : startWidth - delta; paneState[side === 'left' ? 'sidebarWidth' : 'inspectorWidth'] = Math.max(side === 'left' ? 190 : 220, Math.min(side === 'left' ? 420 : 460, next)); applyPaneLayout(); });
    const stop = () => { if (!dragging) return; dragging = false; handle.classList.remove('dragging'); document.body.classList.remove('is-resizing'); savePaneLayout(); };
    handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop); handle.addEventListener('dblclick', () => { paneState[side === 'left' ? 'sidebarWidth' : 'inspectorWidth'] = side === 'left' ? 252 : 286; applyPaneLayout(); savePaneLayout(); });
  }
}

async function hubApi(path, options = {}) {
  const {timeoutMs=20000,deviceId,networkMessage='连接中断或响应超时，输入已保留。',...requestOptions}=options;
  const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),timeoutMs);
  try {
    const response = await fetch(path, { ...requestOptions,signal:requestOptions.signal || abort.signal,headers: { 'content-type': 'application/json', ...(requestOptions.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {const error=new Error(body.error || `请求失败（${response.status}）`);error.status=response.status;if(response.status===401)requirePairing();throw error;}
    return body;
  }catch(error){if(error.status)throw error;throw new Error(networkMessage);}
  finally{clearTimeout(timer);}
}

const receiptDevices=new Map();
const directConnections=new DirectConnections({signal:hubApi,onEvent:(id,type,data)=>{
  if(type==='snapshot'){
    applyEvent({type:'snapshot',devices:[...state.devices.filter(item=>item.id!==id),...data.devices.map(item=>({...item,executionRelay:true}))],sessions:[...state.sessions.filter(item=>item.deviceId!==id),...data.sessions],projects:[...state.projects.filter(item=>item.deviceId!==id),...data.projects],usages:[...[...state.usages.values()].filter(item=>item.deviceId!==id),...(data.usages || [])]});
  }else if(type==='projects'){
    applyEvent({type:'projects',projects:[...state.projects.filter(item=>item.deviceId!==id),...data.projects]});
  }else if(type==='device')applyEvent({type,...data,executionRelay:true});
  else if(['session','relay','delivery','catalog','account_usage','historical_usage'].includes(type))applyEvent(type==='relay' ? data : {type,...data});
},onChange:(id,mode)=>{
  if(mode==='relay' && !state.accessRequired)hubApi('/api/bootstrap').then(data=>{if(data.devices)applyEvent({type:'snapshot',...data});}).catch(()=>{});
  if(id===state.selectedDeviceId)renderDevices();
}});
function restoreReceiptOwners(){for(const [scope,draft] of Object.entries(drafts.items)){
  const owner=scope==='$new-task' ? draft.pending?.body.deviceId : state.sessions.find(item=>item.id===scope)?.deviceId;
  if(owner)for(const job of [draft.pending,draft.edit?.submission,draft.queueAction])if(job?.id)receiptDevices.set(job.id,owner);
}}
async function api(path,options={}){
  const id=requestDevice(path,options,{sessions:state.sessions,selectedDeviceId:$('newTaskModal')?.classList.contains('hidden') ? state.selectedDeviceId : $('newTaskDevice')?.value,receiptDevices});
  if(id){try{const body=JSON.parse(options.body || '{}');if(body.requestId)receiptDevices.set(body.requestId,id);}catch{}}
  let response;
  if(id && directConnections.ready(id))response=peerResponse(await directConnections.request(id,path,options));
  else return hubApi(path,{...options,headers:{...(options.headers || {}),...(id ? {'x-codex-device':id} : {})}});
  const body=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(body.error || '执行设备请求失败');error.status=response.status;throw error;}return body;
}
function saveDraft(){if(composerSessionId)drafts.set(composerSessionId,{...drafts.get(composerSessionId),text:$('promptInput').value,attachments:[...state.attachments]});}
function restoreDraft(id){
  if(composerSessionId===id)return;
  saveDraft();composerSessionId=id;
  const draft=drafts.get(id);$('promptInput').value=draft.text || '';state.attachments=[...(draft.attachments || [])];
  if(draft.pending)reconcileDelivery(id);
  if(draft.edit?.submission)reconcileEdit(id);
  if(draft.queueAction)reconcileQueueAction(id);
}
function applyEditDelivery(receipt) {
  const draft=drafts.get(receipt.sessionId),edit=draft.edit;
  if(edit?.submission?.id!==receipt.id)return;
  edit.submission.state=receipt.state;
  if(receipt.state==='accepted')delete draft.edit;
  else if(receipt.state==='failed') {edit.error=receipt.error || '编辑发送失败，内容已保留。';delete edit.submission;}
  drafts.set(receipt.sessionId,draft);scheduleRender();
}
async function reconcileEdit(id) {
  const edit=drafts.get(id).edit;if(!edit?.submission || editChecks.has(id))return;
  editChecks.add(id);
  try {const receipt=await api('/api/deliveries/'+edit.submission.id);if(receipt.found)applyEditDelivery(receipt);else {edit.submission.state='not-found';drafts.set(id,drafts.get(id));}}
  catch {/* Preserve the original edit request until its outcome is known. */}
  finally {editChecks.delete(id);scheduleRender();}
}
function beginMessageEdit(id) {
  const session=activeSession(),draft=drafts.get(session?.id);
  if(!session || draft.edit)return;
  const item=state.views.get(session.id)?.timeline.find(item=>item.type==='userMessage' && item.id===id);
  const source=session.editableMessages?.find(message=>message.id===id);
  if(!item || !source)return;
  draft.edit={messageId:id,text:item.text || '',images:item.images || [],expectedToken:source.token,expectedLastTurnId:source.lastTurnId};
  drafts.set(session.id,draft);render();
  $('messages').querySelector('[data-edit-input]')?.focus();
}
async function submitMessageEdit(id) {
  const session=state.sessions.find(session=>session.id===id),draft=drafts.get(id),edit=draft.edit;
  if(!session || !edit || editSubmissions.has(id))return;
  editSubmissions.add(id);edit.error='';
  if(!edit.submission) {
    const recovery=session.editRecovery?.messageId===edit.messageId ? session.editRecovery : null;
    edit.submission={id:requestId(),state:'unknown',body:{text:edit.text,expectedToken:edit.expectedToken,expectedLastTurnId:edit.expectedLastTurnId,...choicesFor(id),...(recovery ? {recoveryToken:recovery.token} : {})}};
  }
  const submission=edit.submission;drafts.set(id,draft);scheduleRender();
  try {const result=await api(`/api/sessions/${encodeURIComponent(id)}/messages/${encodeURIComponent(edit.messageId)}/edit`,{method:'POST',body:JSON.stringify({...submission.body,requestId:submission.id})});if(result.delivery)applyEditDelivery(result.delivery);await reconcileEdit(id);}
  catch(error) {
    edit.error=error.message;
    if(error.status && error.status<500)delete edit.submission;
    drafts.set(id,drafts.get(id));await reconcileEdit(id);
  } finally {editSubmissions.delete(id);scheduleRender();}
}
function renderMessageEditor(session,edit,key) {
  const pending=edit.submission,waiting=pending && pending.state!=='not-found';
  const enabled=session.controls?.edit && device(session.deviceId)?.online && state.connection==='connected' && !editSubmissions.has(session.id) && !waiting;
  const note=pending ? pending.state==='not-found' ? '未找到发送记录，可用原编号重新发送。' : '正在核对编辑结果，内容已保留。' : session.controls?.editNeedsRestart ? '桌面代理更新将在下次从原生入口打开桌面时加载。' : !session.controls?.edit ? '请等待当前回合结束或先中断，再发送编辑内容。' : session.editRecovery?.messageId===edit.messageId ? '对话已回到编辑位置，发送会继续生成。' : '发送后，将从这条消息重新生成；后续对话记录会被替换，已修改的文件不会自动撤销。';
  return `<div class="message you inline-edit" data-node-key="${escapeHtml(key)}"><div class="message-edit-card">${renderImages(edit.images)}<textarea data-edit-input aria-label="编辑已发送消息" rows="${Math.min(12,Math.max(3,edit.text.split('\n').length))}"${waiting ? ' disabled' : ''}>${escapeHtml(edit.text)}</textarea><p class="edit-note" role="status">${escapeHtml(edit.error || note)}</p><div class="edit-actions">${waiting ? '<button class="btn" type="button" data-check-edit>重新检查</button>' : '<button class="btn" type="button" data-cancel-edit>取消</button>'}<button class="btn edit-send" type="button" data-send-edit${enabled ? '' : ' disabled'}>发送</button></div></div></div>`;
}
function bindMessageEditors(messages,session) {
  for(const button of messages.querySelectorAll('[data-edit-message]'))button.onclick=()=>beginMessageEdit(button.dataset.editMessage);
  for(const button of messages.querySelectorAll('[data-copy-message]'))button.onclick=()=>copyMessageText(session,button.dataset.copyMessage,button);
  const textarea=messages.querySelector('[data-edit-input]');
  if(textarea)textarea.oninput=()=>{const draft=drafts.get(session.id);if(draft.edit){draft.edit.text=textarea.value;drafts.set(session.id,draft);}};
  for(const button of messages.querySelectorAll('[data-cancel-edit]'))button.onclick=()=>{const draft=drafts.get(session.id);delete draft.edit;drafts.set(session.id,draft);render();};
  for(const button of messages.querySelectorAll('[data-send-edit]'))button.onclick=()=>submitMessageEdit(session.id);
  for(const button of messages.querySelectorAll('[data-check-edit]'))button.onclick=()=>reconcileEdit(session.id);
}
async function copyMessageText(session,itemId,button){
  const item=state.views.get(session?.id)?.timeline.find(entry=>entry.id===itemId)
    || (session?.events || []).find(event=>event.id===itemId)?.message?.params?.item;
  if(!item)return;
  const context=(item.context || []).map(ref=>`${ref.kind==='skill' ? '$' : '@'}${ref.name || ref.id || ''}`).filter(Boolean);
  const text=[...context,item.text || (item.images?.length || item.attachments?.length ? '图片或附件消息' : '')].filter(Boolean).join(context.length && item.text ? '\n\n' : '');
  if(!text)return;
  try{
    if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);
    else {const input=document.createElement('textarea');input.value=text;input.style.position='fixed';input.style.opacity='0';document.body.appendChild(input);input.select();document.execCommand('copy');input.remove();}
    const original=button.textContent;button.textContent='✓';button.classList.add('copied');button.title='已复制';setTimeout(()=>{if(button.isConnected){button.textContent=original;button.classList.remove('copied');button.title=button.getAttribute('aria-label') || '复制';}},1200);
  }catch{button.title='复制失败，请重试';}
}
function applyQueueDelivery(receipt) {
  const draft=drafts.get(receipt.sessionId),job=draft.queueAction;
  if(job?.id!==receipt.id)return;
  job.state=receipt.state;
  if(receipt.state==='accepted') {
    if(job.action==='withdraw') {
      const item=receipt.response?.item || job.item;
      draft.text=[draft.text,item.text].filter(Boolean).join('\n\n');
      draft.attachments=[...new Map([...(draft.attachments || []),...(item.attachments || [])].map(image=>[image.id,image])).values()];
      draft.context=[...new Map([...(draft.context || []),...(item.context || [])].map(ref=>[ref.kind+':'+(ref.id || ref.path),ref])).values()];
      if(composerSessionId===receipt.sessionId){$('promptInput').value=draft.text;state.attachments=[...draft.attachments];}
    }
    delete draft.queueAction;
  } else if(receipt.state==='failed') {delete draft.queueAction;draft.queueError=receipt.error;}
  drafts.set(receipt.sessionId,draft);scheduleRender();
}
async function reconcileQueueAction(id) {
  const draft=drafts.get(id),job=draft.queueAction;if(!job || queueChecks.has(id))return;
  queueChecks.add(id);
  try {const receipt=await api('/api/deliveries/'+job.id);if(receipt.found)applyQueueDelivery(receipt);else {job.state='not-found';drafts.set(id,drafts.get(id));}}
  catch {/* Keep the withdrawal or steer identifier after a lost response. */}
  finally {queueChecks.delete(id);scheduleRender();}
}
async function queuedInputAction(sessionId,itemId,action) {
  const session=state.sessions.find(session=>session.id===sessionId),draft=drafts.get(sessionId);
  if(!session || queueSubmissions.has(sessionId))return;
  const item=session.queuedInputs?.find(item=>item.id===itemId);
  if(!item)return;
  if(draft.queueAction && (draft.queueAction.item.id!==itemId || draft.queueAction.action!==action)){await reconcileQueueAction(sessionId);return;}
  if(!draft.queueAction)draft.queueAction={id:requestId(),item:{...item},action,body:{revision:item.revision,expectedTurnId:session.activeTurnId},state:'unknown'};
  const job=draft.queueAction;draft.queueError='';drafts.set(sessionId,draft);queueSubmissions.add(sessionId);scheduleRender();
  try {const result=await api(`/api/sessions/${encodeURIComponent(sessionId)}/queued/${encodeURIComponent(itemId)}/${action}`,{method:'POST',body:JSON.stringify({...job.body,requestId:job.id})});if(result.delivery)applyQueueDelivery(result.delivery);await reconcileQueueAction(sessionId);}
  catch(error) {const current=drafts.get(sessionId);current.queueError=error.message;if(error.status && error.status<500)delete current.queueAction;drafts.set(sessionId,current);await reconcileQueueAction(sessionId);}
  finally {queueSubmissions.delete(sessionId);scheduleRender();}
}
function renderQueuedInputs(session) {
  if(state.restoringPreview || session?.cachedPreview){syncHtml($('queuedInputs'),'');$('queuedInputs').classList.add('hidden');return;}
  const items=session?.queuedInputs || [],draft=drafts.get(session?.id),job=draft.queueAction;
  const connected=state.connection==='connected',busy=queueSubmissions.has(session?.id) || job && job.state!=='not-found';
  const html=items.map(item=>{
    const locked=item.state!=='waiting' || busy || !connected;
    const steer=session.controls?.steer && device(session.deviceId)?.online;
    const idle=!['running','starting','waiting_input','waiting_approval','interrupting'].includes(session.status);
    return `<div class="queued-input" data-node-key="queued-${escapeHtml(item.id)}"><div class="queued-input-main"><span aria-hidden="true">↳</span><div class="queued-input-text">${escapeHtml(item.text || '图片消息')}${item.attachments.length ? `<small>${item.attachments.length} 张图片</small>` : ''}</div><div class="queued-input-actions"><button class="link-btn" type="button" data-queue-id="${escapeHtml(item.id)}" data-queue-action="${steer ? 'steer' : 'send'}"${locked || !steer && (!idle || !device(session.deviceId)?.online) ? ' disabled' : ''}>${steer ? '↪ 引导' : '发送'}</button><button class="queue-icon" type="button" data-queue-id="${escapeHtml(item.id)}" data-queue-action="withdraw" aria-label="撤回编辑待发送消息" title="撤回编辑"${locked ? ' disabled' : ''}>↶</button><details data-detail-key="queue-menu-${escapeHtml(item.id)}"><summary aria-label="待发送消息更多操作">···</summary><button class="btn" type="button" data-queue-id="${escapeHtml(item.id)}" data-queue-action="delete"${locked ? ' disabled' : ''}>删除消息</button></details></div></div>${item.state!=='waiting' || item.error ? `<small class="queued-input-status" role="status">${escapeHtml(item.error || (item.state==='uncertain' ? '发送结果待确认，暂不能撤回。' : '正在发送…'))}</small>` : ''}</div>`;
  }).join('') + (job ? `<p class="edit-note" role="status">正在确认待发送消息的操作… <button class="link-btn" type="button" id="checkQueueActionBtn">重新检查</button>${job.state==='not-found' ? '<button class="link-btn" type="button" id="repeatQueueActionBtn">重试原操作</button>' : ''}</p>` : '') + (draft.queueError ? `<p class="compose-error" role="status">${escapeHtml(draft.queueError)}</p>` : '');
  syncHtml($('queuedInputs'),html);$('queuedInputs').classList.toggle('hidden',!html);
  for(const button of $('queuedInputs').querySelectorAll('[data-queue-action]'))button.onclick=()=>queuedInputAction(session.id,button.dataset.queueId,button.dataset.queueAction);
  if($('checkQueueActionBtn'))$('checkQueueActionBtn').onclick=()=>reconcileQueueAction(session.id);
  if($('repeatQueueActionBtn'))$('repeatQueueActionBtn').onclick=()=>queuedInputAction(session.id,job.item.id,job.action);
}
async function openModelManagement() {
  modelManagementDeviceId=activeSession()?.deviceId || state.selectedDeviceId;
  closeComposerPopovers();$('modelManagementModal').classList.remove('hidden');$('modelManagementError').textContent='';
  try {
    const catalog=await api(`/api/devices/${encodeURIComponent(modelManagementDeviceId)}/catalog`);
    state.catalogs.set(modelManagementDeviceId,catalog);
    const hidden=new Set(catalog.hiddenModels || []);
    syncHtml($('modelChoices'),(catalog.models || []).map(model=>`<label class="project-choice"><input type="checkbox" value="${escapeHtml(model.model)}"${hidden.has(model.model) ? '' : ' checked'}><span><strong>${escapeHtml(model.displayName || model.model)}</strong><small>${escapeHtml(model.model)}</small></span></label>`).join(''));
  } catch(error) {$('modelManagementError').textContent=error.message;}
}
async function saveModelManagement() {
  $('saveModelsBtn').disabled=true;
  try {
    const hiddenModels=[...$('modelChoices').querySelectorAll('input')].filter(input=>!input.checked).map(input=>input.value);
    const catalog=await api(`/api/devices/${encodeURIComponent(modelManagementDeviceId)}/catalog`,{method:'PATCH',body:JSON.stringify({hiddenModels})});
    state.catalogs.set(modelManagementDeviceId,catalog);$('modelManagementModal').classList.add('hidden');render();
  } catch(error) {$('modelManagementError').textContent=error.message;}
  finally {$('saveModelsBtn').disabled=false;}
}
async function refreshCatalog(deviceId) {
  await api(`/api/devices/${encodeURIComponent(deviceId)}/catalog/refresh`,{method:'POST'});
  let catalog;
  for(let attempt=0;attempt<16;attempt++){
    await new Promise(resolve=>setTimeout(resolve,500));
    catalog=await api(`/api/devices/${encodeURIComponent(deviceId)}/catalog`);
    if(!catalog.pending)break;
  }
  return catalog;
}
async function refreshModelManagement() {
  const button=$('refreshModelsBtn');button.disabled=true;$('modelManagementError').textContent='正在向桌面读取模型列表…';
  try {
    const catalog=await refreshCatalog(modelManagementDeviceId);
    state.catalogs.set(modelManagementDeviceId,catalog);
    const hidden=new Set(catalog.hiddenModels || []);
    syncHtml($('modelChoices'),(catalog.models || []).map(model=>`<label class="project-choice"><input type="checkbox" value="${escapeHtml(model.model)}"${hidden.has(model.model) ? '' : ' checked'}><span><strong>${escapeHtml(model.displayName || model.model)}</strong><small>${escapeHtml(model.model)}</small></span></label>`).join(''));
    $('modelManagementError').textContent=catalog.pending?'桌面尚未返回模型列表，请稍后再刷新。':'模型列表已刷新。';
  } catch(error) {$('modelManagementError').textContent=error.message;}
  finally {button.disabled=false;}
}
function applyDelivery(receipt){
  applyEditDelivery(receipt);applyQueueDelivery(receipt);
  const draft=drafts.get(receipt.sessionId);const pending=draft.pending;
  if(!pending || pending.id!==receipt.id)return;
  pending.state=receipt.state;pending.error=receipt.error;
  if(['accepted','waiting','consumed'].includes(receipt.state)){
    const sending=pendingSends.get(receipt.sessionId);if(sending)sending.confirmed=true;
    if(draft.text.trim()===pending.body.text && JSON.stringify(draft.attachments.map(image=>image.id))===JSON.stringify(pending.body.attachments) && JSON.stringify(draft.context || [])===JSON.stringify(pending.body.context || [])){
      draft.text='';draft.attachments=[];draft.context=[];
      if(composerSessionId===receipt.sessionId){$('promptInput').value='';state.attachments=[];}
    }
    delete draft.pending;pendingSends.delete(receipt.sessionId);if(composerSessionId===receipt.sessionId)$('composeError').textContent='';
  }else if(receipt.state==='failed'){delete draft.pending;pendingSends.delete(receipt.sessionId);if(composerSessionId===receipt.sessionId)$('composeError').textContent=receipt.error || '发送失败，输入已保留。';}
  drafts.set(receipt.sessionId,draft);if(composerSessionId===receipt.sessionId)renderComposer();
}
async function reconcileDelivery(id){
  const pending=drafts.get(id).pending;if(!pending || deliveryChecks.has(id))return;
  deliveryChecks.add(id);
  try{const receipt=await api('/api/deliveries/'+pending.id);if(receipt.found)applyDelivery(receipt);else{pending.state='not-found';drafts.set(id,drafts.get(id));}}
  catch{/* retain both the draft and the original request ID */}
  finally{deliveryChecks.delete(id);if(composerSessionId===id)renderComposer();}
}
function connectionStatus(){
  const selected=device(activeSession()?.deviceId || state.selectedDeviceId);
  const session=activeSession(),needsDesktop=session?.executionOwner==='desktop'||session?.source==='imported'&&session.executionOwner!=='runner';
  const result=connectionExperience({connection:state.connection,device:selected,cached:state.restoringPreview || session?.cachedPreview,accessRequired:state.accessRequired,needsDesktop});
  $('connectionBanner').textContent=result.text;$('connectionBanner').classList.toggle('hidden',!result.show);
  $('connectionBanner').dataset.kind=result.kind;
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[c])); }
const mediaCards=new MediaCards({sessionId:()=>state.activeSessionId,path:ref=>mediaUrl(ref),request:(...args)=>api(...args),onChange:()=>render()});
function inlineMarkdown(value) {
  const images = [];
  value=String(value);
  // Parse native visualization markers and balanced Windows path parentheses before Markdown.
  for(const link of htmlLinkMatches(value).reverse()){
    const url=htmlPreviewUrl(state.activeSessionId,link.ref,{interactive:link.interactive}) || '#';
    const document=isLocalDocument(link.ref);
    const alternate=link.interactive || document ? '' : ` <a class="html-preview-link" href="${escapeHtml(htmlPreviewUrl(state.activeSessionId,link.ref,{interactive:true}) || '#')}" target="_blank" rel="noopener noreferrer"><small>交互预览 ↗</small></a>`;
    images.push(`<a class="html-preview-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} <small>${document ? '阅读文档' : link.interactive ? '播放／切换效果' : '打开 HTML 预览'} ↗</small></a>${alternate}`);
    value=value.slice(0,link.start)+`\u0000IMG${images.length-1}\u0000`+value.slice(link.end);
  }
  value = value.replace(/!\[([^\]]*)\]\((?:<([^>]+)>|([^\n)]+))\)/g, (_, alt, angle, plain) => {
    const ref = angle || plain;
    const kind=mediaKind(ref) || 'image';
    images.push(kind==='image' ? renderImages([{ref,name:alt}]) : mediaCards.render(ref,alt,kind));
    return `\u0000IMG${images.length - 1}\u0000`;
  });
  value = value.replace(/\[([^\]]+)\]\((?:<([^>]+)>|([^\n)]+))\)/g, (original,label,angle,plain)=>{
    const ref=angle || plain;
    if(isLocalHtml(ref)){
      images.push(`<a class="html-preview-link" href="${escapeHtml(htmlPreviewUrl(state.activeSessionId,ref) || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} <small>打开 HTML 预览 ↗</small></a>`);
      return `\u0000IMG${images.length-1}\u0000`;
    }
    if (!mediaKind(ref)) return original;
    images.push(mediaKind(ref)==='image' ? renderImages([{ref,name:label}]) : mediaCards.render(ref,label));
    return `\u0000IMG${images.length-1}\u0000`;
  });
  let html = escapeHtml(value);
  html = html.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|\/)[^)]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return html.replace(/\u0000IMG(\d+)\u0000/g, (_, index) => images[Number(index)]);
}
function mediaUrl(ref) {
  if (/^https?:\/\//i.test(ref)) return ref;
  if(/^\/api\/(uploads|sessions|devices)\//.test(ref))return ref;
  if (!state.activeSessionId || !ref || /^(?!file:|[a-z]:[\\/])[a-z][a-z0-9+.-]*:/i.test(ref) && !/^inline:/i.test(ref)) return null;
  return `/api/sessions/${encodeURIComponent(state.activeSessionId)}/media?ref=${encodeURIComponent(ref)}`;
}
function imageDisclosureKey(images,keyPrefix='') {
  return 'images:'+encodeURIComponent(JSON.stringify([state.activeSessionId,keyPrefix || images.map(image=>image.url || image.ref)]));
}
function resetImageVisibility() {
  for(const key of state.openDetailKeys)if(key.startsWith('images:'))state.openDetailKeys.delete(key);
}
function toggleImages(key) {
  if(!key?.startsWith('images:'))return;
  if(state.openDetailKeys.has(key))state.openDetailKeys.delete(key);else state.openDetailKeys.add(key);
  scheduleRender();
}
function renderImages(images = [],keyPrefix='') {
  images=images.filter(image=>image.url || image.ref);
  if(!images.length)return '';
  const key=imageDisclosureKey(images,keyPrefix),open=state.openDetailKeys.has(key);
  // Keep image elements and their URLs out of the DOM until explicitly opened.
  // A span/button disclosure also remains valid inside Markdown paragraphs.
  const body=open ? `<span class="message-images">${images.map(image=>mediaCards.render(image.url || image.ref,image.name,'image')).join('')}</span>` : '';
  return `<span class="image-disclosure" data-node-key="${escapeHtml(key)}"><button type="button" class="image-disclosure-toggle" data-images-toggle="${escapeHtml(key)}" aria-expanded="${open}"><span aria-hidden="true">▧</span><span>图片 · ${images.length} 张</span><span class="image-disclosure-action">${open ? '收起' : '展开'}</span><span class="image-disclosure-arrow" aria-hidden="true">›</span></button>${body}</span>`;
}
function renderAttachments(attachments=[],text='') {
  return attachments.filter(item=>!text.includes(item.ref || item.url)).map(item=>mediaKind(item.ref || item.url)==='image' ? renderImages([item]) : mediaCards.render(item.ref || item.url,item.name)).join('');
}
function markdownCells(line) {
  const text = line.trim(); const cells = []; let cell = ''; let ticks = 0; let pipe = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && text[i+1] === '|') { cell += '|'; i++; continue; }
    if (char === '`') {
      let length = 1; while (text[i+length] === '`') length++;
      if (!ticks) ticks = length; else if (ticks === length) ticks = 0;
      cell += '`'.repeat(length); i += length-1; continue;
    }
    if (char === '|' && !ticks) { cells.push(cell.trim()); cell = ''; pipe = true; }
    else cell += char;
  }
  cells.push(cell.trim());
  if (text.startsWith('|')) cells.shift();
  if (text.endsWith('|') && !text.endsWith('\\|')) cells.pop();
  return pipe ? cells : null;
}
const markdownCache = new TextRenderCache();
function renderMarkdown(value) {
  const text = String(value ?? '');
  // Image routes may change on session switch or when an asynchronous direct
  // image fetch supplies a blob URL. Resolve them again on every render.
  if (/!\[|\.(?:html?|png|jpe?g|gif|webp|mp3|wav|m4a|ogg|oga|mp4|webm)(?:[?#][^\n)]*)?>?\)/i.test(text)) return renderMarkdownText(text);
  return markdownCache.render(text, renderMarkdownText);
}
function markdownListItem(line) {
  const expanded = line.replace(/^[ \t]+/, indent => indent.replace(/\t/g, '    '));
  const match = expanded.match(/^( *)(?:(\d{1,9})([.)])|([-*+]))([ \t]+)(.+)$/);
  if (!match) return null;
  return { indent: match[1].length, contentIndent: expanded.length - match[6].length,
    type: match[2] ? 'ol' : 'ul', marker: match[3] || match[4], start: Number(match[2]), text: match[6] };
}
function renderMarkdownList(lines, index) {
  const first = markdownListItem(lines[index]);
  const sameList = item => item && item.indent === first.indent && item.type === first.type && item.marker === first.marker;
  const indentWidth = line => (line.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '    ').length;
  const items = []; let item = null; let loose = false;
  while (index < lines.length) {
    const line = lines[index], marker = markdownListItem(line);
    if (sameList(marker)) {
      item = { lines: [marker.text], indent: marker.contentIndent }; items.push(item); index++; continue;
    }
    if (!line.trim()) {
      let next = index + 1; while (next < lines.length && !lines[next].trim()) next++;
      if (next === lines.length || !(sameList(markdownListItem(lines[next])) || indentWidth(lines[next]) >= item.indent)) break;
      loose = true; item.lines.push(''); index = next; continue;
    }
    if (indentWidth(line) < item.indent) break;
    item.lines.push(line.replace(/^[ \t]+/, indent => indent.replace(/\t/g, '    ')).slice(item.indent)); index++;
  }
  const start = first.type === 'ol' && first.start !== 1 ? ` start="${first.start}"` : '';
  const html = items.map(item => {
    while (item.lines.length && !item.lines.at(-1).trim()) item.lines.pop();
    let body = renderMarkdownText(item.lines.join('\n'));
    if (!loose && body.startsWith('<p>') && body.indexOf('</p>') === body.length - 4) body = body.slice(3, -4);
    return `<li>${body}</li>`;
  }).join('');
  return { html: `<${first.type}${start}>${html}</${first.type}>`, next: index };
}
function renderMarkdownText(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = []; const paragraph = []; let code = null;
  const flushParagraph = () => { if (paragraph.length) { html.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`); paragraph.length = 0; } };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.match(/^\s*```(?:[\w+-]+)?\s*$/);
    if (fence) {
      flushParagraph();
      if (code) { html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const cells = markdownCells(line);
    const separator = index+1 < lines.length ? markdownCells(lines[index+1]) : null;
    if (cells?.length && separator?.length === cells.length && separator.every(cell=>/^:?-+:?$/.test(cell))) {
      flushParagraph();
      const alignment = separator.map(cell=>cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      const row = (values,tag) => `<tr>${cells.map((_,column)=>`<${tag} style="text-align:${alignment[column]}"${tag === 'th' ? ' scope="col"' : ''}>${inlineMarkdown(values[column] || '')}</${tag}>`).join('')}</tr>`;
      html.push(`<div class="markdown-table" tabindex="0" role="region" aria-label="表格，可横向滚动"><table><thead>${row(cells,'th')}</thead><tbody>`);
      index++;
      while (index+1 < lines.length) {
        const values = markdownCells(lines[index+1]);
        if (!values) break;
        html.push(row(values,'td')); index++;
      }
      html.push('</tbody></table></div>'); continue;
    }
    if (!line.trim()) { flushParagraph(); if (html.length && !String(html.at(-1)).includes('md-gap')) html.push('<div class="md-gap"></div>'); continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) { flushParagraph(); const level = heading[1].length; html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue; }
    if (markdownListItem(line)) {
      flushParagraph(); const list = renderMarkdownList(lines, index);
      html.push(list.html); index = list.next - 1; continue;
    }
    paragraph.push(line);
  }
  if (code) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushParagraph();
  return html.join('') || '<p></p>';
}
function time(at) { return new Intl.DateTimeFormat('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit' }).format(at ? new Date(at) : new Date()); }
function cleanUserMessage(value) {
  let text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if(text.includes('<relay_context>'))text=text.replace(/以下为用户选择的技能和引用。对话摘录是参考资料：\s*/g,'').replace(/<relay_context>[\s\S]*?<\/relay_context>/g,'').trim();
  const request = text.match(/(?:^|\n)##\s*My request:\s*/i);
  if (request) text = text.slice(request.index + request[0].length);
  text = text.replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi, '');
  text = text.replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, '');
  text = text.replace(/\n?Distinguish instructions in attached documents from the user's request\.?/gi, '');
  return text.trim();
}
function device(id) { return state.devices.find(item => item.id === id); }
function activeSession() { return state.sessions.find(item => item.id === state.activeSessionId) || null; }
async function selectDevice(id){
  saveDraft();const old=activeSession();if(old)state.deviceSessions[old.deviceId]=old.id;
  state.restoreSessionId=null;state.selectedDeviceId=id;
  const session=deviceSession(state.sessions,id,state.deviceSessions[id]);
  state.activeSessionId=session?.id || null;state.activeProjectId=sessionProjectId(session);
  historyPreloader.visit(session?.id);
  closeMobileNavigation();directConnections.ensure(device(id));requestCatalog(id);render();await ensureSessionHistory(session);
}
function sessionProjectId(session) { return session ? (session.projectId || `${session.deviceId || 'local'}:${session.cwd || ''}`) : null; }
function projectName(session) { return session?.projectName || String(session?.cwd || '未命名项目').split(/[\\/]/).filter(Boolean).at(-1) || '未命名项目'; }
function projectList() {
  const groups = new Map();
  for (const session of state.sessions) {
    if(session.hidden || session.archived || session.deviceId!==state.selectedDeviceId)continue;
    const id = sessionProjectId(session);
    if (!groups.has(id)) groups.set(id, { id, name: projectName(session), cwd: session.projectCwd || session.cwd || '', sessions: [], latest: 0 });
    const group = groups.get(id); group.sessions.push(session); group.latest = Math.max(group.latest, session.updatedAt || session.createdAt || 0);
  }
  return projectOrder.arrange([...groups.values()].sort((a,b)=>b.latest-a.latest || a.name.localeCompare(b.name)),state.selectedDeviceId);
}
function activeProject() {
  const projects = projectList();
  if (!projects.some(item => item.id === state.activeProjectId)) state.activeProjectId = sessionProjectId(activeSession()) || projects[0]?.id || null;
  return projects.find(item => item.id === state.activeProjectId) || projects[0] || null;
}

function blankView(session) { return { ...session, timeline: [], plan: [], diff: '', approval: null, approvals:new Map(), error: null, fileChanges: [], appliedEvents: new Set(), appliedEventBytes:0 }; }
function upsert(view, id, patch) {
  let item = view.timeline.find(entry => entry.id === id);
  if (!item) { item = { id, type: patch.type || 'unknown' }; view.timeline.push(item); }
  Object.assign(item, patch);
  return item;
}

function appendStreamText(item,field,delta,limit){
  if(item.streamTruncated?.[field])return;
  const text=(item[field] || '')+(delta || '');
  if(text.length<=limit){item[field]=text;return;}
  let cut=limit;
  if(/[\uD800-\uDBFF]/.test(text[cut-1]))cut--;
  item[field]=text.slice(0,cut)+'\n…（内容已截断）';
  item.streamTruncated={...item.streamTruncated,[field]:true};
}

function applyCodex(view, message, at) {
  const method = message.method;
  const params = message.params || {};
  const eventTurnId = params.turnId || params.turn_id || params.turn?.id || view.activeTurnId || null;
  const notice=runtimeNotice(method,params,at);
  if (notice) {
    view.activity=notice;
    if (notice.kind === 'reconnect') {
      upsert(view,params.id || `retry-${eventTurnId}-${at}`,{...notice,type:'reconnect',turnId:eventTurnId});
      view.retrying=true;
    }
  }
  if (method === 'item/agentMessage/delta') {
    view.activity=null; view.error=null; view.retrying=false;
    const item = upsert(view, params.itemId, { type:'agentMessage', ...(eventTurnId ? { turnId:eventTurnId } : {}) });
    appendStreamText(item,'text',params.delta,80000); item.at = at;
  } else if (method === 'item/plan/delta') {
    const item = upsert(view, params.itemId, { type:'plan', ...(eventTurnId ? { turnId:eventTurnId } : {}) });
    appendStreamText(item,'text',params.delta,80000); item.at = at;
  } else if (method === 'item/commandExecution/outputDelta') {
    const item = upsert(view, params.itemId, { type:'commandExecution', ...(eventTurnId ? { turnId:eventTurnId } : {}) });
    appendStreamText(item,'aggregatedOutput',params.delta,24000); item.at = at;
  } else if (method === 'item/started' || method === 'item/completed') {
    const raw = {...params.item};
    if (raw.questions?.length) raw.questions=normalizeQuestions(raw.questions,raw.id,raw.delivery);
    if (raw.type === 'userMessage') return;
    const id=raw.id || params.itemId,previous=view.timeline.find(item=>item.id===id);
    const status=raw.status?(['inProgress','running'].includes(raw.status)?'inProgress':'completed'):method==='item/started'?'inProgress':'completed';
    const timing=processKind(raw)==='command'?itemTiming({...raw,status},previous,{at,phase:method==='item/started'?'started':'completed'}):{};
    const item = upsert(view, id, { ...raw,...timing,status, at: raw.at || at, ...(eventTurnId ? { turnId:eventTurnId } : {}) });
    if (raw.type === 'fileChange' && raw.changes) view.fileChanges = raw.changes;
    if (raw.type === 'agentMessage' && raw.text) item.text = raw.text;
    if (!['agentMessage','reasoning'].includes(raw.type)) view.activity = { ...item };
    else if (view.activity?.kind === 'reconnect') view.activity=null;
    // Commands already launched by a failed turn can finish afterwards.
    // Their output does not mean the model request recovered.
    if (!(view.status==='failed' && eventTurnId===view.activeTurnId)) view.error=null;
    view.retrying=false;
  } else if (method === 'turn/plan/updated') {
    view.plan = params.plan || [];
  } else if (method === 'turn/diff/updated') {
    view.diff = params.diff || '';
  } else if (method === 'turn/started') {
    view.activeTurnId = params.turnId || params.turn_id || params.turn?.id || view.activeTurnId || null;
    view.status = 'running';
    view.error = null; view.retrying = false; view.activity = null;
    pendingSends.delete(view.id);
  } else if (method === 'runner/desktopAccepted' || method === 'runner/steerAccepted') {
    view.status = 'running'; view.error = null; view.retrying = false;
    pendingSends.delete(view.id);
  } else if (method === 'turn/completed') {
    view.activity=null; view.retrying=false; view.error=null;
    view.activeTurnId = params.turnId || params.turn_id || params.turn?.id || view.activeTurnId || null;
    view.status = params.turn?.status === 'failed' ? 'failed' : params.turn?.status === 'interrupted' ? 'interrupted' : 'done';
    if (params.turn?.error?.message) view.error = params.turn.error.message;
  } else if (method === 'runner/log') {
    const text = String(params.text || '').trim();
    if (text) upsert(view, `runner-log-${at}-${view.timeline.length}`, { type:'system', text, at });
  } else if (method === 'runner/exited') {
    upsert(view, `runner-exit-${at}-${view.timeline.length}`, { type:'system', text:`Runner 已退出（代码 ${params.code ?? '未知'}）`, at });
  } else if (method === 'error' || method === 'runner/error') {
    view.error = params.error?.message || params.message || 'Codex 返回错误';
    view.retrying = Boolean(notice);
    view.status = notice ? 'running' : 'failed';
    const draft = pendingSends.get(view.id);
    if (draft && !notice) draft.failed = true;
    if (draft && !notice && view.id === state.activeSessionId && !$('promptInput').value) {
      $('promptInput').value = draft.text; state.attachments = draft.attachments;
      pendingSends.delete(view.id);
    }
  }
}

function viewFor(session) {
  if (state.views.has(session.id)) {const view=state.views.get(session.id);state.views.delete(session.id);state.views.set(session.id,view);return view;}
  const view = blankView(session);
  for (const event of session.events || []) applyRelay(view, event);
  view.status = session.status;
  state.views.set(session.id, view);
  while(state.views.size>Math.max(8,currentPerformance().preloadEnabled ? currentPerformance().preloadCount : 1)){
    const warm=new Set(historyPreloader.candidates().map(item=>item.id));
    const removable=[...state.views.keys()].filter(id=>id!==state.activeSessionId);
    const id=removable.find(id=>!warm.has(id)) || removable.find(id=>id!==session.id);
    if(!id)break;
    state.views.delete(id);
    const old=state.sessions.find(value=>value.id===id);
    if(old){old.events=[];old.loadedHistoryVersion=null;old.loadedHistoryLimit=null;old.loadedHistoryCursor=null;old.loadedHistoryKeys=null;}
  }
  return view;
}

function relayEventKey(event) {
  return JSON.stringify(event);
}

function applyRelay(view, event) {
  const at = event.at || Date.now();
  const eventKey = relayEventKey(event);
  if (eventKey && view.appliedEvents?.has(eventKey)) return false;
  view.appliedEvents?.add(eventKey);
  if(view.appliedEvents){
    view.appliedEventBytes=(view.appliedEventBytes || 0)+eventKey.length*2;
    while(view.appliedEvents.size>4096 || view.appliedEventBytes>1024*1024){
      const oldest=view.appliedEvents.values().next().value;
      view.appliedEvents.delete(oldest);view.appliedEventBytes-=oldest.length*2;
    }
  }
  if (event.type === 'user_message') {
    const text = cleanUserMessage(event.text);
    const context=event.context || contextFromText(event.text);
    const turnId = event.turnId || event.turn_id || null;
    if (text || context.length || event.images?.length || event.attachments?.length) upsert(view, event.id || `user-${turnId || at}`, { type:'userMessage', turnId, text, ...(context.length ? {context} : {}),images:event.images || [],attachments:event.attachments || [], at });
  }
  else if (event.type === 'thread_ready') { view.threadId = event.threadId; view.status = 'ready'; }
  else if (event.type === 'approval_request') { view.approvals.set(event.request.key || String(event.request.id),event.request); view.approval = view.approvals.values().next().value || null; }
  else if (event.type === 'approval_resolved') { for (const [key, request] of view.approvals) if (event.approvalKey ? key === event.approvalKey : request.id === event.requestId) view.approvals.delete(key); view.approval = view.approvals.values().next().value || null; }
  else if (event.type === 'action_error') { if (view.id === state.activeSessionId) $('composeError').textContent=event.text; }
  else if (event.type === 'question_updated') upsert(view,event.itemId,{type:'agentMessage',...event.patch});
  else if (event.type === 'system') view.timeline.push({ id:`system-${event.id || at}`, type:'system', text:event.text, at });
  else if (event.type === 'codex') applyCodex(view, event.message, at);
  else if (event.type === 'session_created') view.status = 'starting';
  return true;
}

function sessionPatchChanged(previous,patch){
  if(!previous)return true;
  // Session SSE messages omit cached history. Compare only fields supplied by
  // the patch, so a small status update never serializes megabytes of events.
  return Object.keys(patch).some(key=>{
    if(!Object.hasOwn(previous,key))return true;
    const before=previous[key],after=patch[key];
    if(before===after)return false;
    return before==null||after==null||typeof before!=='object'||typeof after!=='object'
      || JSON.stringify(before)!==JSON.stringify(after);
  });
}
function applyEvent(event) {
  let changed = false;
  if(event.type==='health'){renderServiceHealth(event);return;}
  if(event.type==='delivery'){applyDelivery(event);return;}
  if(event.type==='account_usage'){state.usages.set(event.deviceId,event);renderUsage();return;}
  if(event.type==='historical_usage'){state.historicalUsages.set(event.deviceId,event);renderUsage();if(event.status==='ready')refreshHistoricalRange(event.deviceId);return;}
  if (event.type === 'catalog') {
    state.catalogs.set(event.deviceId, event); changed = true;
  } else if (event.type === 'projects') { state.projects = event.projects; changed = true; }
  else if (event.type === 'device') {
    const index = state.devices.findIndex(item => item.id === event.id);
    const previous = index >= 0 ? state.devices[index] : null;
    changed = !previous || JSON.stringify(previous) !== JSON.stringify(event);
    if (index >= 0) state.devices[index] = event; else state.devices.push(event);
    if (!state.selectedDeviceId) state.selectedDeviceId = event.id;
    if(event.id===activeSession()?.deviceId && JSON.stringify(previous?.performanceSettings)!==JSON.stringify(event.performanceSettings))ensureSessionHistory(activeSession());
  } else if (event.type === 'snapshot') {
    state.restoringPreview=false;
    if (event.usages) state.usages = new Map(event.usages.map(usage=>[usage.deviceId,usage]));
    if(event.historicalUsages)state.historicalUsages=new Map(event.historicalUsages.map(usage=>[usage.deviceId,usage]));
    const previous = new Map(state.sessions.map(session => [session.id, session]));
    state.devices = event.devices || [];
    state.projects = event.projects || state.projects;
    state.sessions = (event.sessions || []).map(session => {
      const old = previous.get(session.id);
      return old && old.events?.length && !Object.prototype.hasOwnProperty.call(session, 'events') ? { ...old, ...session } : session;
    });
    restoreReceiptOwners();
    const visibleIds = new Set(state.sessions.map(session => session.id));
    if (visibleIds.has(state.restoreSessionId)) { state.activeSessionId=state.restoreSessionId; state.activeProjectId=sessionProjectId(activeSession()); state.selectedDeviceId=activeSession().deviceId; state.restoreSessionId=null; }
    for (const id of state.views.keys()) if (!visibleIds.has(id)) state.views.delete(id);
    if (!visibleIds.has(state.activeSessionId)) { state.activeSessionId = deviceSession(state.sessions,state.selectedDeviceId,state.deviceSessions[state.selectedDeviceId])?.id || null; state.activeProjectId = sessionProjectId(activeSession()); }
    if (!state.selectedDeviceId && state.devices[0]) state.selectedDeviceId = state.devices[0].id;
    const active = activeSession();
    if (active) {ensureSessionHistory(active);reconcileDelivery(active.id);}
    changed = true;
  } else if (event.type === 'session') {
    if (event.id === state.restoreSessionId) { state.activeSessionId=event.id; state.activeProjectId=sessionProjectId(event); state.selectedDeviceId=event.deviceId; state.restoreSessionId=null; }
    const index = state.sessions.findIndex(item => item.id === event.id);
    const previous = index >= 0 ? state.sessions[index] : null;
    const imported = (previous?.source || event.source) === 'imported';
    const historyRefresh = imported && event.historyLoaded && (!previous?.events?.length
      || (event.historyVersion ? event.historyVersion !== previous?.loadedHistoryVersion : event.updatedAt !== previous?.updatedAt));
    const next = { ...(previous || {}), ...event };
    changed = sessionPatchChanged(previous,event);
    if (index >= 0) state.sessions[index] = next;
    else state.sessions.unshift(next);
    if (!state.activeSessionId && event.deviceId===state.selectedDeviceId) { state.activeSessionId = event.id; state.activeProjectId = sessionProjectId(event); }
    const session = state.sessions.find(item => item.id === event.id);
    if (session.id === state.activeSessionId && historyRefresh) loadSessionHistory(session);
  } else if (event.sessionId) {
    const session = state.sessions.find(item => item.id === event.sessionId);
    if (session) {
      const view = viewFor(session);
      const previousStatus = session.status;
      changed = applyRelay(view, event) || previousStatus !== view.status;
      session.status = view.status;
    }
  }
  if (changed) {
    // Session summaries carry authoritative completion receipts and pending work.
    // Raw history events can still contain the previous turn during a new send.
    if(['snapshot','session'].includes(event.type))observeTaskNotices(event.type==='snapshot' && taskNoticeTracker.previous.size===0);
    scheduleRender();
    historyPreloader.schedule();
    scheduleResumeSave();
  }
}

function connectStream() {
  liveConnection.connect();state.stream=liveConnection.stream;
}
function resumeStream() {
  const reconnecting=liveConnection.resume();state.stream=liveConnection.stream;
  if(!reconnecting && liveConnection.status==='connected')reconcilePendingInputs();
}
function reconcilePendingInputs() {
  if(activeSession()){const id=activeSession().id;reconcileDelivery(id);reconcileEdit(id);reconcileQueueAction(id);}imageUploads.reconcile();
}
function requirePairing(message='此浏览器的授权已撤销或过期，请重新配对。') {
  saveDraft();state.accessRequired=true;clearTimeout(resumeSaveTimer);restoredPreview=null;resumeCache.clear();directConnections.stop();liveConnection.block();showAccessRequired(message);renderComposer();
}
let accessCheck=null;
function verifyBrowserAccess() {
  if(state.accessRequired || accessCheck)return;
  accessCheck=checkAccess().then(allowed=>{if(!allowed)requirePairing();}).catch(()=>{}).finally(()=>accessCheck=null);
}
const liveConnection=new LiveConnection({
  onEvent:(type,data)=>{
    if(type==='access_revoked'){requirePairing(data.message);return;}
    const owner=type==='device' ? data.id : data.deviceId || state.sessions.find(item=>item.id===data.sessionId)?.deviceId;
    if(type==='device' && (!data.online || data.runtime==='revoked'))directConnections.drop(data.id);
    if(type==='snapshot'){
      for(const item of data.devices || []){if(!item.online || item.runtime==='revoked')directConnections.drop(item.id);else directConnections.ensure(item);}
      data={...data,devices:(data.devices || []).map(item=>directConnections.ready(item.id) ? {...item,online:true} : item),sessions:[...(data.sessions || []).filter(item=>!directConnections.ready(item.deviceId)),...state.sessions.filter(item=>directConnections.ready(item.deviceId))],projects:[...(data.projects || []).filter(item=>!directConnections.ready(item.deviceId)),...state.projects.filter(item=>directConnections.ready(item.deviceId))]};
    }else if(owner && directConnections.ready(owner))return;
    if(type==='projects')data={projects:[...data.projects.filter(item=>!directConnections.ready(item.deviceId)),...state.projects.filter(item=>directConnections.ready(item.deviceId))]};
    applyEvent(type==='relay' ? data : {type,...data});if(type==='snapshot')requestCatalog(state.selectedDeviceId);
  },
  onStatus:status=>{state.connection=status;const connected=status==='connected';$('connectionNote').textContent=connected ? '控制服务已连接 · 实时同步' : status==='unauthorized' ? '需要重新配对' : status==='offline' ? '网络已断开，等待恢复' : '控制服务连接中断，正在重试…';$('connectionNote').style.color=connected ? 'var(--green)' : 'var(--red)';connectionStatus();if(status==='reconnecting')verifyBrowserAccess();},
  onReconnect:reconcilePendingInputs
});

function renderDevices() {
  const newDevice = $('newTaskModal').classList.contains('hidden') ? state.selectedDeviceId : $('newTaskDevice').value;
  syncHtml($('newTaskDevice'), state.devices.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${item.online ? '在线' : '离线'}</option>`).join(''));
  $('newTaskDevice').value = state.devices.some(item=>item.id === newDevice) ? newDevice : state.devices[0]?.id || '';
  const selected = device(state.selectedDeviceId);
  if(selected)document.title=selected.name+' · Codex Relay';
  $('sidebarDot').classList.toggle('offline', !selected?.online); $('sidebarRunner').textContent = selected ? `${selected.name} · ${directConnections.ready(selected.id) ? '直连' : selected.online ? selected.executionRelay ? '主电脑中转' : '已连接' : '等待恢复'}` : '等待 Runner 连接';
}

function renderProjects() {
  const projects = projectList();
  syncHtml($('projectList'), projects.length ? projects.map(item => {
    const counts=projectCounts(item.sessions);
    const pending=item.sessions.filter(session=>attentionLabel(sidebarSession(session))).length;
    const collapsed=state.collapsedProjects.has(item.id);
    const sessions=searchSessions(item.sessions),requested=state.sessionListLimits.get(item.id) || 5;
    const limit=requested==='all' ? sessions.length : Math.min(Math.max(requested,sessions.filter(session=>session.pinned).length),sessions.length),remaining=sessions.length-limit;
    const panel='project-chats-'+encodeURIComponent(item.id);
    const more=remaining ? `<button class="more-sessions" data-project-more="${escapeHtml(item.id)}">再显示 ${Math.min(5,remaining)} 条</button><button class="more-sessions" data-project-all="${escapeHtml(item.id)}">显示全部 ${sessions.length} 条</button>` : '';
    const fewer=limit>5 ? `<button class="more-sessions" data-project-recent="${escapeHtml(item.id)}">收起到 5 条</button>` : '';
    return `<section class="project-group" data-node-key="project-group-${escapeHtml(item.id)}"><button class="project project-group-heading" data-project="${escapeHtml(item.id)}" aria-expanded="${!collapsed}" aria-controls="${escapeHtml(panel)}" title="${escapeHtml(item.cwd)}"><div class="project-heading"><span class="project-chevron">${collapsed ? '›' : '⌄'}</span><strong>${escapeHtml(item.name)}</strong>${pending ? `<b class="project-count waiting">${pending} 待处理</b>` : counts.running ? `<b class="project-count running">${counts.running} 运行中</b>` : ''}</div><span>${sessions.length} 条对话${counts.unread ? ` · ${counts.unread} 未读` : ''}</span></button><div class="project-chats${collapsed ? ' hidden' : ''}" id="${escapeHtml(panel)}">${sessions.slice(0,limit).map(session=>sessionRow(session)).join('')}<div class="session-list-actions">${more}${fewer}</div></div></section>`;
  }).join('') : '<div class="muted" style="padding:8px">等待同步项目</div>');
  document.querySelectorAll('[data-project]').forEach(button=>button.onclick=()=>{const id=button.dataset.project;if(state.collapsedProjects.has(id))state.collapsedProjects.delete(id);else state.collapsedProjects.add(id);saveProjectLayout();renderSessions();});
  for(const [attribute,kind] of [['projectMore','more'],['projectAll','all'],['projectRecent','recent']])document.querySelectorAll(`[data-${attribute.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase())}]`).forEach(button=>button.onclick=()=>{
    const id=button.dataset[attribute],current=state.sessionListLimits.get(id) || 5;
    state.sessionListLimits.set(id,kind==='all' ? 'all' : kind==='recent' ? 5 : current+5);saveProjectLayout();renderSessions();
  });
}

function saveProjectLayout(){try{localStorage.setItem('codex-relay-collapsed-projects',JSON.stringify([...state.collapsedProjects]));localStorage.setItem('codex-relay-project-limits',JSON.stringify(Object.fromEntries(state.sessionListLimits)));}catch{}}
function sidebarSession(session){return {...session,pendingAttention:sessionAttention(session,state.views.get(session.id))};}
function sessionRow(session,showProject=false){
  const indicator=sessionIndicator(sidebarSession(session));
  const settings=session.nativeModel ? codexSettingsLabel(session,state.catalogs.get(session.deviceId)) : device(session.deviceId)?.name || session.deviceId;
  const label=session.pinned?'取消置顶':'置顶对话';
  return `<div class="session-row${session.pinned?' is-pinned':''}" data-node-key="session-${escapeHtml(session.id)}"><button class="session ${session.id===state.activeSessionId ? 'active' : ''}" data-session="${escapeHtml(session.id)}"><div class="session-heading"><strong>${escapeHtml(session.title)}</strong><i class="session-indicator ${indicator.kind}" title="${escapeHtml(indicator.label)}" aria-label="${escapeHtml(indicator.label)}"></i></div>${showProject ? `<span class="session-project-label">${escapeHtml(projectName(session))}</span>` : ''}<span>${session.pinned?'置顶 · ':''}${escapeHtml(indicator.label)} · ${escapeHtml(settings)}</span></button><button class="session-pin" type="button"${state.connection!=='connected'||session.cachedPreview?' disabled':''} data-session-pin="${escapeHtml(session.id)}" aria-pressed="${Boolean(session.pinned)}" aria-label="${label}：${escapeHtml(session.title)}" title="${label}"><svg width="16" height="18" viewBox="0 0 20 22" fill="none" aria-hidden="true"><path d="M7 2h7l-1 6 4 4v2H4v-2l4-4-1-6ZM10 14v6" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button><span class="session-pin-status" data-pin-status role="status" hidden></span></div>`;
}
async function openSession(id,{attention=false,unread=false}={}){
  const session=state.sessions.find(item=>item.id===id);if(!session)return;
  saveDraft();state.unreadVisit=unread ? {id,positioned:false,token:session.completionToken} : null;
  state.restoreSessionId=null;state.activeSessionId=id;state.activeProjectId=sessionProjectId(session);state.selectedDeviceId=session.deviceId;
  historyPreloader.visit(id);
  state.attentionFocus=attention ? id : null;
  const project=projectList().find(item=>item.id===state.activeProjectId),position=searchSessions(project?.sessions || []).findIndex(item=>item.id===id),limit=state.sessionListLimits.get(state.activeProjectId) || 5;
  if(limit!=='all' && position>=limit)state.sessionListLimits.set(state.activeProjectId,Math.ceil((position+1)/5)*5);
  state.collapsedProjects.delete(state.activeProjectId);saveProjectLayout();requestCatalog(session.deviceId);closeMobileNavigation();render();await ensureSessionHistory(session);render();
}
function renderPendingNavigation(){
  const pending=pendingSessions(state.sessions.map(sidebarSession),state.selectedDeviceId),count=pending.length;
  const session=activeSession();
  if(state.unreadVisit && (state.unreadVisit.id!==session?.id || !session?.unread))state.unreadVisit=null;
  const reading=Boolean(session && readingSessions.has(session.id+':'+session.completionToken));
  const busy=state.pendingSwitching || reading && state.unreadVisit?.id===session?.id;
  for(const id of ['nextPendingSidebar','nextPendingBtn'])if($(id)){$(id).disabled=busy || !count;$(id).title=count ? `打开下一个待处理对话，还有 ${count} 条` : '没有待处理对话';}
  if($('attentionCount')){$('attentionCount').textContent=count>99 ? '99+' : String(count);$('attentionCount').hidden=!count;}
  if($('sidebarPendingCount')){$('sidebarPendingCount').textContent=count>99 ? '99+' : String(count);$('sidebarPendingCount').hidden=!count;}
  const menuLabel=count ? `显示左侧栏，还有 ${count} 条待处理` : '显示左侧栏';
  $('showSidebarBtn')?.setAttribute('aria-label',menuLabel);
  if($('showSidebarBtn'))$('showSidebarBtn').title=menuLabel;
  $('attentionBtn')?.setAttribute('aria-label',`筛选待处理对话，共 ${count} 条，包含未读回复和待回答、审批`);
  $('attentionBtn')?.classList.toggle('has-attention',pending.some(session=>attentionLabel(session)));
  $('pendingNavigation')?.classList.toggle('hidden',!state.pendingMode);
  $('exitPendingModeBtn')?.classList.toggle('hidden',!state.pendingMode);
  const status=busy ? '正在打开待处理…' : state.unreadVisit?.error ? '已读保存失败，仍保留未读' : count ? `还有 ${count} 条待处理` : '待处理已看完';
  if($('pendingNavigationStatus') && $('pendingNavigationStatus').textContent!==status)$('pendingNavigationStatus').textContent=status;
}
async function openNextPending(){
  const session=activeSession();
  if(state.pendingSwitching || state.unreadVisit?.id===session?.id && session && readingSessions.has(session.id+':'+session.completionToken))return;
  const target=nextPendingSession(state.sessions.map(sidebarSession),{deviceId:state.selectedDeviceId,activeSessionId:state.activeSessionId});
  if(!target){renderPendingNavigation();return;}
  state.pendingMode=true;state.pendingSwitching=true;renderPendingNavigation();
  const attention=sessionAttention(target).length>0;
  try{await openSession(target.id,{unread:!attention,attention});}
  finally{state.pendingSwitching=false;renderPendingNavigation();}
}
function positionUnreadVisit(session){
  const visit=state.unreadVisit;
  if(!visit || visit.id!==session?.id || state.activeSessionId!==visit.id || visit.positioned || state.historyLoads.has(visit.id)
    || renderedSessionId!==visit.id || !session.completionToken || !session.events?.length || session.source==='imported' && session.loadedHistoryVersion!==session.historyVersion)return;
  const messages=$('messages'),turn=[...messages.querySelectorAll('[data-turn-id]')].at(-1);
  if(!turn)return;
  const target=turn.querySelector('.turn-result') || turn;
  messages.scrollTop+=target.getBoundingClientRect().top-messages.getBoundingClientRect().top-12;
  // Lazy history hydration can establish or replace the list's completion token.
  // Bind the explicit read intent once the current reply is actually displayed.
  visit.token=session.completionToken;
  visit.positioned=true;
}
function focusAttentionRequest(){
  if(!state.attentionFocus || state.activeSessionId!==state.attentionFocus)return;
  const id=state.attentionFocus,session=activeSession(),view=state.views.get(id),pending=sessionAttention(session,view);
  const target=[...document.querySelectorAll('[data-question-item]')].find(node=>pending.some(item=>item.id===node.dataset.questionItem)) || (view?.approval ? $('approvalSlot') : null);
  if(!target)return;
  state.attentionFocus=null;
  requestAnimationFrame(()=>{if(state.activeSessionId===id){target.scrollIntoView({block:'center',behavior:'smooth'});target.querySelector('button:not(:disabled),input:not(:disabled)')?.focus({preventScroll:true});}});
}

function resetSessionSearch({focus=true}={}) {
  state.sessionQuery='';state.sessionFilter='all';state.sessionResultLimit=5;
  const input=$('sessionSearch');if(input)input.value='';
  renderSessions();if(focus)input?.focus();
}

function setupSessionSearch() {
  const input=$('sessionSearch');
  input.oninput=()=>{state.sessionQuery=input.value;state.sessionResultLimit=5;renderSessions();};
  input.onkeydown=event=>{if(event.key==='Escape' && !event.isComposing){event.preventDefault();resetSessionSearch();}};
  $('resetSessionSearch').onclick=()=>resetSessionSearch();
  for(const button of document.querySelectorAll('[data-session-filter]'))button.onclick=()=>{
    state.sessionFilter=button.dataset.sessionFilter;state.sessionResultLimit=5;renderSessions();
  };
}

function renderSessions() {
  const filtering=sessionSearchActive(state.sessionQuery,state.sessionFilter);
  renderProjects();
  renderPendingNavigation();
  const summaries=state.sessions.map(sidebarSession);
  const sessions=searchSessions(summaries,{query:state.sessionQuery,filter:state.sessionFilter,deviceId:state.selectedDeviceId});
  if($('conversationListTitle'))$('conversationListTitle').textContent=filtering ? state.sessionQuery.trim() ? '搜索结果' : sessionFilterLabels[state.sessionFilter]+'的对话' : '最近对话';
  if($('conversationScope'))$('conversationScope').textContent=(filtering ? '全部项目 · ' : '')+sessions.length+' 条';
  $('resetSessionSearch')?.classList.toggle('hidden',!filtering);
  for(const id of ['projectNav','projectList'])$(id)?.classList.toggle('hidden',filtering);
  $('conversationNav')?.classList.toggle('hidden',!filtering);$('sessionList').classList.toggle('hidden',!filtering);
  for(const button of document.querySelectorAll('[data-session-filter]'))button.setAttribute('aria-pressed',String(button.dataset.sessionFilter===state.sessionFilter));
  if(!filtering){syncHtml($('sessionList'),'');bindSessionRows();return;}
  if (!sessions.length) {
    syncHtml($('sessionList'),filtering ? '<div class="session-empty" role="status"><span>没有匹配的对话</span><button class="link-btn" id="emptySessionSearchReset" type="button">清除搜索与筛选</button></div>' : '<div class="muted" style="padding:8px">这个项目还没有同步对话</div>');
    if($('emptySessionSearchReset'))$('emptySessionSearchReset').onclick=()=>resetSessionSearch();return;
  }
  const requested = state.sessionResultLimit;
  const limit = requested === 'all' ? sessions.length : Math.min(requested, sessions.length);
  const visible = sessions.slice(0, limit);
  const remaining = sessions.length - visible.length;
  const actions = remaining > 0 ? `<button class="more-sessions" id="moreSessions" type="button">再显示 ${Math.min(5,remaining)} 条</button><button class="more-sessions" id="allSessions" type="button">显示全部 ${sessions.length} 条</button>` : '';
  const collapse = visible.length > 5 ? '<button class="more-sessions" id="recentSessions" type="button">只看最近 5 条</button>' : '';
  const more = actions || collapse ? `<div class="session-list-actions" data-node-key="session-pagination">${actions}${collapse}</div>` : '';
  syncHtml($('sessionList'),visible.map(session=>sessionRow(session,true)).join('')+more);
  bindSessionRows();
  const expand = next => {state.sessionResultLimit=next;renderSessions();};
  if ($('moreSessions')) $('moreSessions').onclick = () => expand(Math.min(sessions.length, limit + 5));
  if ($('allSessions')) $('allSessions').onclick = () => expand('all');
  if ($('recentSessions')) $('recentSessions').onclick = () => expand(5);
}
function bindSessionRows(){
  document.querySelectorAll('[data-session]').forEach(button=>button.onclick=()=>openSession(button.dataset.session,{attention:state.sessionFilter==='waiting'}));
  document.querySelectorAll('[data-session-pin]').forEach(button=>button.onclick=async()=>{
    const session=state.sessions.find(item=>item.id===button.dataset.sessionPin);if(!session)return;
    button.disabled=true;const status=button.closest('.session-row')?.querySelector('[data-pin-status]');if(status)status.hidden=true;
    try{const result=await api('/api/sessions/'+encodeURIComponent(session.id)+'/pin',{method:'PATCH',body:JSON.stringify({pinned:!session.pinned})});applyEvent({type:'session',...result.session});renderSessions();}
    catch(error){button.title='保存失败，点此重试：'+error.message;button.setAttribute('aria-label',button.title);if(status){status.textContent='置顶未保存：'+error.message;status.hidden=false;}}
    finally{button.disabled=false;}
  });
}

function renderTaskNotices(){
  syncHtml($('taskNotices'),[...taskNoticeItems.values()].map(item=>`<div class="task-notice ${['failed','interrupted'].includes(item.kind) ? 'notice-error' : ''}" data-node-key="${escapeHtml(item.key)}"><button class="task-notice-open" data-notice-open="${escapeHtml(item.key)}"><strong>${escapeHtml(({question:'有问题需要你回答',approval:'需要你的审批',done:'本回合已完成',failed:'任务执行失败',interrupted:'任务已中断'})[item.kind])}</strong><span>${escapeHtml(item.projectName || '')}${item.projectName ? ' · ' : ''}${escapeHtml(item.title || '对话')}</span></button><button class="task-notice-close" data-notice-close="${escapeHtml(item.key)}" aria-label="关闭提醒">×</button></div>`).join(''));
  for(const button of document.querySelectorAll('[data-notice-open]'))button.onclick=()=>{const item=taskNoticeItems.get(button.dataset.noticeOpen);if(item)openSession(item.sessionId,{attention:true});taskNoticeItems.delete(button.dataset.noticeOpen);renderTaskNotices();};
  for(const button of document.querySelectorAll('[data-notice-close]'))button.onclick=()=>{taskNoticeItems.delete(button.dataset.noticeClose);renderTaskNotices();};
}
function observeTaskNotices(baseline=false){
  const summaries=state.sessions.filter(session=>!session.hidden && !session.archived).map(sidebarSession);
  for(const [key,item] of taskNoticeItems){const session=summaries.find(session=>session.id===item.sessionId);if(!session || ['question','approval'].includes(item.kind) && !sessionAttention(session).some(pending=>pending.kind===item.kind && pending.id===item.itemId))taskNoticeItems.delete(key);}
  const notices=taskNoticeTracker.observe(summaries,{baseline});
  for(const item of notices){
    taskNoticeItems.set(item.key,item);
    while(taskNoticeItems.size>4)taskNoticeItems.delete(taskNoticeItems.keys().next().value);
    setTimeout(()=>{taskNoticeItems.delete(item.key);renderTaskNotices();},15000);
    if(document.hidden || !document.hasFocus())sendSystemNotice(item);
  }
  if(notices.length && noticeSound && noticeAudio?.state==='running'){
    const oscillator=noticeAudio.createOscillator(),gain=noticeAudio.createGain();oscillator.connect(gain);gain.connect(noticeAudio.destination);oscillator.frequency.value=660;gain.gain.setValueAtTime(.05,noticeAudio.currentTime);gain.gain.exponentialRampToValueAtTime(.001,noticeAudio.currentTime+.18);oscillator.start();oscillator.stop(noticeAudio.currentTime+.18);
  }
  renderTaskNotices();
}
async function notificationWorker(){return navigator.serviceWorker?.register('/notification-worker.js',{scope:'/',updateViaCache:'none'});}
async function sendSystemNotice(item){
  if(backgroundNotices?.enabled || !noticeSystem || !('Notification' in window) || Notification.permission!=='granted')return;
  try{
    const registration=await notificationWorker();if(!registration)return;
    await navigator.serviceWorker.ready;
    await registration.showNotification('Codex Relay · '+({question:'待回答',approval:'待审批',done:'本回合已完成',failed:'执行失败',interrupted:'任务已中断'})[item.kind],{body:item.title || '点击查看对话',tag:item.key,data:{sessionId:item.sessionId}});
  }catch{/* Page reminders remain available when the browser cannot notify. */}
}
function setupTaskNotices(){
  $('noticeSettingsBtn').onclick=()=>{const hidden=$('noticeSettings').classList.toggle('hidden');$('noticeSettingsBtn').setAttribute('aria-expanded',String(!hidden));};
  $('noticeSound').checked=noticeSound;
  $('noticeSound').onchange=async()=>{noticeSound=$('noticeSound').checked;try{localStorage.setItem('codex-relay-notice-sound',String(noticeSound));}catch{}if(noticeSound){const Audio=window.AudioContext || window.webkitAudioContext;if(Audio){noticeAudio ||= new Audio();await noticeAudio.resume();}}};
  const refreshPermission=()=>{$('enableNotifications').textContent=!('Notification' in window) ? '此浏览器不支持系统通知' : Notification.permission==='denied' ? '通知已被浏览器阻止' : noticeSystem && Notification.permission==='granted' ? '关闭页面通知' : '开启页面通知';$('enableNotifications').disabled=!('Notification' in window) || Notification.permission==='denied';$('notificationHint').textContent='页面通知需要网页保持活动；后台提醒请使用下方开关。';};
  refreshPermission();
  $('enableNotifications').onclick=async()=>{if(Notification.permission==='default')await Notification.requestPermission();if(Notification.permission==='granted'){noticeSystem=!noticeSystem;try{localStorage.setItem('codex-relay-notice-system',String(noticeSystem));}catch{}if(noticeSystem)try{await notificationWorker();}catch{}}refreshPermission();};
  document.addEventListener('pointerdown',()=>{if(noticeSound){const Audio=window.AudioContext || window.webkitAudioContext;if(Audio){noticeAudio ||= new Audio();noticeAudio.resume().catch(()=>{});}}},{once:true});
  const requested=new URL(location.href).searchParams.get('noticeSession');if(requested)state.restoreSessionId=requested;
  navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='open_notice_session')openSession(event.data.sessionId,{attention:true});});
}

async function requestSessionHistory(session, maxTurns = null,options={}) {
  if (!session || session.source !== 'imported') return;
  if (session.historyLoaded && maxTurns == null) return loadSessionHistory(session,options);
  if (session.historyRequested) return;
  session.historyRequested = true;
  try { await api(`/api/sessions/${encodeURIComponent(session.id)}/history`, { method: 'POST', body: JSON.stringify({ maxTurns: maxTurns || requestedHistoryLimit(session) }) }); }
  catch { session.historyRequested = false; }
  // Another browser may have already loaded these older turns on the server.
  if (session.historyLoaded && maxTurns != null) await loadSessionHistory(session,options);
}

async function ensureSessionHistory(session,options={}) {
  if (!session) return;
  if(session.source!=='imported')return loadSessionHistory(session,options);
  const limit=requestedHistoryLimit(session),available=session.historyLimit || 5;
  if (session.historyLoaded && (available==='all' || limit!=='all' && available>=limit)) return loadSessionHistory(session,options);
  return requestSessionHistory(session,limit,options);
}

async function loadSessionHistory(session,{background=false}={}) {
  if (!session) return;
  const limit = session.source === 'imported' ? requestedHistoryLimit(session) : 'all';
  if (session.source === 'imported' && session.loadedHistoryVersion!=null && session.historyLoaded
    && session.loadedHistoryVersion === session.historyVersion && session.loadedHistoryLimit === limit) return;
  if (state.historyLoads.has(session.id)) { state.historyReloads.add(session.id); return; }
  state.historyLoads.add(session.id);
  try {
    const endpoint = `/api/sessions/${encodeURIComponent(session.id)}/history?maxTurns=${limit}&sync=1`;
    const previous = {events:session.events || [], keys:session.loadedHistoryKeys, cursor:session.loadedHistoryLimit === limit ? session.loadedHistoryCursor : null};
    let result = await api(endpoint + (previous.cursor ? `&cursor=${encodeURIComponent(previous.cursor)}` : ''));
    if (!result.historyLoaded && !result.events?.length) return;
    session = state.sessions.find(item => item.id === session.id) || session;
    let update;
    try {
      if (result.historySync?.kind === 'delta' && session.loadedHistoryCursor !== previous.cursor) throw new Error('历史缓存已改变');
      update = applyHistoryUpdate(previous, result);
    } catch {
      // An evicted cache or expired cursor recovers with one read-only full snapshot.
      result = await api(endpoint); update = applyHistoryUpdate({}, result);
    }
    const nextSignature = result.historyVersion || JSON.stringify(update.events);
    const changed = (update.cursor ? update.cursor !== session.loadedHistoryCursor : nextSignature !== session.loadedHistoryVersion) || limit !== session.loadedHistoryLimit;
    if (changed) session.events = update.events;
    session.loadedHistoryCursor = update.cursor;
    session.loadedHistoryKeys = update.keys;
    session.loadedHistoryVersion = nextSignature;
    session.loadedHistoryLimit = limit;
    session.turns = result.turns || [];
    session.turnCount = result.turnCount ?? session.turnCount;
    session.historyLoaded = Boolean(result.historyLoaded || result.events?.length);
    if (Number.isFinite(result.messageCount)) session.messageCount = result.messageCount;
    session.historyRequested = false;
    session.cachedPreview=false;
    scheduleResumeSave();
    if (changed) { state.views.delete(session.id); viewFor(session); if(session.id===state.activeSessionId)render(); }
  } catch { /* the next session event will retry */ }
  finally {
    state.historyLoads.delete(session.id);
    if (state.historyReloads.delete(session.id)) loadSessionHistory(state.sessions.find(item => item.id === session.id));
    maybeMarkSessionRead();
    historyPreloader.schedule();
  }
}

async function maybeMarkSessionRead() {
  const session=activeSession(), messages=$('messages');
  if(state.restoringPreview || session?.cachedPreview)return;
  positionUnreadVisit(session);
  const visit=state.unreadVisit?.id===session?.id ? state.unreadVisit : null;
  if(visit && (visit.error || visit.token!==session.completionToken))return;
  if (!canMarkSessionRead({session,hidden:document.hidden,focused:document.hasFocus(),
    covered:state.accessRequired || $('app').classList.contains('mobile-nav-open') || Boolean(document.querySelector('.modal:not(.hidden)')),
    loading:state.historyLoads.has(session?.id),atBottom:messages.scrollHeight-messages.scrollTop-messages.clientHeight<96,
    hasContent:Boolean(session?.events?.length) && renderedSessionId===session.id,requestedRead:Boolean(visit?.positioned)})) return;
  const key=session.id+':'+session.completionToken;
  if (readingSessions.has(key)) return;
  readingSessions.add(key);
  renderPendingNavigation();
  try {
    const result=await api(`/api/sessions/${encodeURIComponent(session.id)}/read`,{method:'POST',body:JSON.stringify({completionToken:session.completionToken})});
    applyEvent({type:'session',...result.session});
    if(state.unreadVisit===visit)state.unreadVisit=null;
  } catch {if(state.unreadVisit===visit && visit)visit.error=true;/* Keep the marker until the receipt is confirmed. */}
  finally {readingSessions.delete(key);renderPendingNavigation();}
}

function statusLabel(status) { return ({ starting:'启动中', ready:'待开始', synced:'已同步', running:'执行中', waiting_approval:'等待审批', waiting_input:'等待回答', done:'已完成', failed:'失败', interrupted:'已中断' })[status] || status || '待开始'; }

function processItemLabel(item) {
  const type = item.type || 'system';
  if (processKind(item)==='command') return `${['inProgress','running'].includes(item.status)?'正在运行':'已运行'} ${shortCommand(item.command || item.input || '命令')}`;
  if (type === 'toolCall') {
    const input = String(item.input || '');
    if (/apply_patch/i.test(input)) return '已编辑文件';
    if (/exec_command|Get-Content|Set-Content|apply_patch|git\s+/i.test(input)) return `已运行 ${shortCommand(input)}`;
    if (/browser|cua|playwright|computer/i.test(input)) return '已使用浏览器操作';
    return item.name ? `已调用 ${item.name}` : '已调用工具';
  }
  if (type === 'toolOutput') return '已收到命令输出';
  if (type === 'imageView') return `已查看 ${item.images?.length || 1} 张图像`;
  if (type === 'fileChange') {
    const changes = item.changes || [];
    if (changes.length === 1) {
      const change = changes[0];
      const name = String(change.path || '文件').split(/[\\/]/).at(-1);
      return `已编辑 ${name}${change.additions != null ? ` +${change.additions} -${change.deletions || 0}` : ''}`;
    }
    return `已编辑 ${changes.length || 1} 个文件`;
  }
  if (type === 'plan') return '已更新执行计划';
  if (type === 'contextCompaction' || type === 'context_compaction') return item.status === 'inProgress' ? '正在压缩上下文…' : '上下文已自动压缩';
  if (type === 'mcpToolCall' || type === 'mcp_tool_call') return item.title || `已调用 ${item.server ? `${item.server} · ` : ''}${item.name || '工具'}`;
  if (type === 'webSearch') return item.title || '已使用网络搜索';
  if (type === 'reconnect') return item.text || '正在重新连接';
  if (type === 'computerScreenshot' || type === 'computer') return '已使用浏览器操作';
  if (type === 'reasoning') return '已完成分析';
  return item.text || item.summary || '已记录过程';
}
function shortCommand(value) {
  let text = extractCommand(value);
  text = String(text).replace(/\s+/g, ' ');
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}
function extractCommand(value) {
  let text = String(value || '').trim();
  try {
    const parsed = JSON.parse(text);
    text = parsed.command || parsed.cmd || parsed.input || text;
  } catch { /* keep the original tool input */ }
  if (/tools\.exec_command\s*\(/i.test(text)) {
    const match = text.match(/tools\.exec_command\(\s*\{\s*cmd\s*:\s*"((?:\\.|[^"\\])*)"/is)
      || text.match(/tools\.exec_command\(\s*\{\s*cmd\s*:\s*'((?:\\.|[^'\\])*)'/is);
    if (match) {
      try { text = JSON.parse(`"${match[1]}"`); }
      catch { text = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
    }
  }
  return String(text).trim();
}
function processInput(item) {
  if (item.type === 'commandExecution') return String(item.command || item.input || '').trim();
  return String(item.input || item.command || '').trim();
}
function processKind(item) {
  const type = item?.type || '';
  if (['contextCompaction', 'context_compaction'].includes(type)) return 'context';
  if (type === 'reconnect') return 'reconnect';
  if (type === 'fileChange') return 'edit';
  if (type === 'commandExecution') return 'command';
  if (type === 'imageView') return 'image';
  if (['computerScreenshot', 'computer', 'webSearch'].includes(type) || /browser|computer|playwright|cua|chrome/i.test(`${item.server || ''} ${item.name || ''}`)) return 'browser';
  if (type === 'toolCall' && /(?:^|\.)apply_patch$/.test(item.name || '')) return 'edit';
  if (['toolCall','mcpToolCall','mcp_tool_call'].includes(type) && /(?:^|\.)(exec_command|shell_command|shell)$/.test(item.name || '')) return 'command';
  if (type === 'toolCall' && /(?:tools\.)?apply_patch\s*\(/i.test(processInput(item))) return 'edit';
  if (type === 'toolCall' && /(?:tools\.)?exec_command\s*\(/i.test(processInput(item))) return 'command';
  return 'other';
}
function processCategory(item) {
  const kind = processKind(item);
  return ['context', 'image'].includes(kind) ? kind : 'tools';
}
function processCommandCount(items) {return items.filter(item=>processKind(item)==='command').length;}
function turnHistoryLabel(items) {
  const messages=items.filter(item=>['userMessage','agentMessage'].includes(item.type) || item.questions?.length).length,commands=processCommandCount(items);
  return [messages ? `上 ${messages} 条消息` : '',commands ? `${commands} 条命令` : ''].filter(Boolean).join(' · ') || '过程记录';
}
function processGroupLabel(items) {
  const categories = new Set(items.map(processKind));
  const has = category => categories.has(category);
  if (has('context') && categories.size === 1) return '上下文已自动压缩';
  if (has('reconnect') && categories.size === 1) return '网络重连记录';
  if (has('image') && categories.size === 1) return `已查看 ${items.reduce((count,item)=>count+(item.images?.length || 1),0)} 张图像`;
  const parts = [];
  const commands=processCommandCount(items);
  if(commands)parts.push(`已执行 ${commands} 条命令`);
  if (has('browser')) parts.push('已使用浏览器');
  if (has('edit')) parts.push(items.filter(item => processKind(item) === 'edit').length > 1 ? '已编辑多个文件' : '已编辑文件');
  if (parts.length) return parts.join(' · ');
  if (items.some(item => /blender/i.test(item.server || ''))) return '已使用 Blender 集成';
  return '过程记录';
}
function processItemDetails(item) {
  if (item.type === 'imageView') return renderImages(item.images);
  if (item.type === 'commandExecution') {
    const output = item.aggregatedOutput || item.output || '';
    return `<div class="process-detail-label">命令${item.cwd ? ` · ${escapeHtml(item.cwd)}` : ''}</div><pre>${escapeHtml(extractCommand(item.command || item.input || '命令未提供'))}</pre>${output ? `<div class="process-detail-label">输出${item.exitCode != null ? ` · 退出码 ${escapeHtml(item.exitCode)}` : ''}</div><pre>${escapeHtml(output)}</pre>` : ''}`;
  }
  if (item.type === 'toolCall') return `<div class="process-detail-label">输入</div><pre>${escapeHtml(extractCommand(item.input || '调用参数未提供'))}${item.output ? `\n\n${escapeHtml(item.output)}` : ''}</pre>`;
  if (item.type === 'toolOutput') return `<div class="process-detail-label">输出</div><pre>${escapeHtml(item.output || '命令输出为空')}</pre>`;
  if (item.type === 'fileChange') return (item.changes || []).map(change => `<div class="process-detail-label">${escapeHtml(change.path || '')}</div><pre class="file-diff">${escapeHtml(change.diff || '未提供差异内容')}</pre>`).join('') || '<p>未提供文件明细</p>';
  if (['mcpToolCall', 'webSearch'].includes(item.type)) return `${item.input ? `<div class="process-detail-label">输入 · ${escapeHtml(item.server || '')} ${escapeHtml(item.name || '')}</div><pre>${escapeHtml(item.input)}</pre>` : ''}${item.output ? `<div class="process-detail-label">输出</div><pre>${escapeHtml(item.output)}</pre>` : ''}${item.error ? `<p>${escapeHtml(typeof item.error === 'string' ? item.error : JSON.stringify(item.error))}</p>` : ''}` || '<p>此操作没有文本输出</p>';
  if (item.type === 'reconnect') return `<p>${escapeHtml(item.detail || item.text || '连接中断，正在重试')}</p>`;
  if (item.type === 'plan') return `<div class="markdown">${renderMarkdown(item.text || '')}</div>`;
  if (item.type === 'system') return `<p>${escapeHtml(item.text || '')}</p>`;
  const details = Object.entries(item).filter(([key, value]) => !['id','type','at','text','summary'].includes(key) && value != null).map(([key, value]) => `<div><b>${escapeHtml(key)}</b><span>${escapeHtml(typeof value === 'string' ? value : JSON.stringify(value))}</span></div>`).join('');
  return details ? `<div class="process-kv">${details}</div>` : `<p>${escapeHtml(item.text || item.summary || '已完成')}</p>`;
}
function renderProcessItem(item, index, keyPrefix = 'process') {
  const key = `${keyPrefix}:${item.id || `${item.type || 'item'}:${item.at || index}`}`;
  const category = processKind(item);
  const icon = category === 'command' ? '›_' : category === 'edit' ? '✎' : category === 'browser' ? '◎' : category === 'image' ? '▧' : category === 'reconnect' ? '⌁' : category === 'context' ? '↻' : '·';
  return `<details class="process-item" data-detail-key="${escapeHtml(key)}"><summary><span class="process-item-icon">${icon}</span><span>${escapeHtml(processItemLabel(item))}</span>${category==='command'?renderCommandClock(item):''}</summary><div class="process-item-detail">${state.openDetailKeys.has(key) ? processItemDetails(item) : ''}</div></details>`;
}
function renderCommandClock(item,current=false){
  const clock=commandTiming(item);
  const label=current&&clock.running?clock.label.replace(/^已运行/,'命令已执行'):clock.label;
  return `<span aria-live="off" class="command-elapsed${clock.longRunning?' is-long-running':''}"${current?' data-command-current="true"':''}${clock.running&&clock.startedAt?` data-command-since="${clock.startedAt}"`:''} title="${clock.running?'这条命令从开始到现在的执行时间；运行较久不一定代表卡死。':'命令执行用时，不包含后续等待。'}">${escapeHtml(label)}</span>`;
}
function renderProcessGroup(items, keyPrefix = 'process') {
  if (items.length === 1 && processKind(items[0]) === 'context') return `<div class="process-notice" data-node-key="${escapeHtml(`${keyPrefix}:notice`)}"><span>↻</span>上下文已自动压缩</div>`;
  if (items.length === 1 && processKind(items[0]) === 'reconnect') return renderProcessItem(items[0], 0, keyPrefix);
  const label = processGroupLabel(items);
  const icon = processCommandCount(items) ? '›_' : processKind(items[0]) === 'context' ? '↻' : processKind(items[0]) === 'reconnect' ? '⌁' : processKind(items[0])==='image' ? '▧' : '◎';
  const key = `${keyPrefix}:group`;
  const imageGroup=items.every(item=>processKind(item)==='image');
  if(imageGroup)return renderImages(items.flatMap(item=>item.images || []),keyPrefix);
  const body=state.openDetailKeys.has(key) ? renderProcessList(items,keyPrefix) : '';
  return `<details class="process-group${imageGroup ? ' process-image-group' : ''}" data-detail-key="${escapeHtml(key)}"><summary><span class="process-icon">${icon}</span><span>${escapeHtml(label)}</span></summary><div class="process-group-body">${body}</div></details>`;
}
function renderLiveProcessGroup(items,keyPrefix) {
  return renderProcessGroup(items,keyPrefix);
}
function renderProcessList(items,keyPrefix){
  const limit=state.processLimits.get(keyPrefix) || 200,hidden=Math.max(0,items.length-limit);
  const more=hidden ? `<button class="timeline-btn" type="button" data-more-process="${escapeHtml(keyPrefix)}">显示较早的 ${hidden} 项操作</button>` : '';
  return more+items.slice(-limit).map((item,index)=>renderProcessItem(item,index+hidden,keyPrefix)).join('');
}
function renderIntermediateMessage(item, key) {
  return `<div class="process-note markdown" data-node-key="${escapeHtml(key)}">${renderAttachments(item.attachments,item.text || '')}${renderMarkdown(item.text || '')}<button class="message-copy-action" type="button" data-copy-message="${escapeHtml(item.id)}" aria-label="复制回答" title="复制回答">⧉</button></div>`;
}
function displayTimelineRows(timeline) {
  const rows = []; let process = []; let category = null;
  const flush = () => { if (process.length) { rows.push({ type:'processGroup', items:process, category }); process = []; category = null; } };
  for (const item of timeline) {
    if (item.type === 'userMessage' || item.type === 'agentMessage' || item.questions?.length) { flush(); rows.push(item); }
    else {
      const nextCategory = processCategory(item);
      if (process.length && nextCategory !== category) flush();
      category = nextCategory;
      process.push(item);
    }
  }
  flush();
  return rows;
}

function turnResult(turn) {
  const replies=(turn.segments?.at(-1)?.items || turn.items).filter(item=>item.type === 'agentMessage' && !item.questions?.length);
  const result=replies.findLast(item=>['final_answer','final'].includes(item.phase))
    || (turn.status === 'completed' ? replies.findLast(item=>!item.phase) : null);
  if (!result) return null;
  if (['inProgress','running','waiting_input'].includes(turn.status)
    && (turn.items.slice(turn.items.indexOf(result)+1).some(item=>item.type !== 'reasoning') || (turn.activity?.at || 0) > (result.at || Infinity))) return null;
  return result;
}

function renderQuestion(item, key, closed = false) {
  const questions=normalizeQuestions(item.questions,item.id,item.delivery);
  const answers=item.questionAnswers || {};
  const answered=questions.every(question=>typeof answers[question.id] === 'string');
  const submitting=item.answerState === 'sending' || questionSubmissions.has(item.id);
  const supported=item.delivery === 'async' || item.delivery === 'rpc';
  const resolved=item.answerState === 'resolved';
  const editable=!answered && !closed && !resolved && supported && !submitting;
  const drafts=questionDrafts.get(item.id) || {};
  const body=questions.map(question=>{
    if (answered) return `<div class="question-answer"><p>${escapeHtml(question.title)}</p><strong>${escapeHtml(answers[question.id])}</strong></div>`;
    const chosen=drafts[question.id] || '';
    return `<fieldset><legend>${escapeHtml(question.title)}</legend><div class="question-options">${question.options.map(option=>`<button type="button" class="question-option${chosen === option.label ? ' selected' : ''}" data-question-id="${escapeHtml(question.id)}" data-answer="${escapeHtml(option.label)}" aria-pressed="${chosen === option.label}"${editable ? '' : ' disabled'}><span>${escapeHtml(option.label)}</span>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</button>`).join('')}</div><input ${question.isSecret ? 'type="password" autocomplete="off"' : 'type="text"'} class="question-free-text" data-question-id="${escapeHtml(question.id)}" aria-label="${escapeHtml(question.title)}：输入回答" placeholder="输入回答…" value="${escapeHtml(chosen)}"${editable ? '' : ' disabled'} /></fieldset>`;
  }).join('');
  const forwarded=answered && ['forwarded','sent'].includes(item.answerState);
  const label=answered ? (forwarded ? '回答已送到对话' : '已回答') : resolved ? '提问已结束' : submitting ? '正在发送回答…' : closed ? '本回合已结束' : supported ? '请回答' : '请在桌面 Codex 回答';
  const note=item.delivery==='async' ? item.answerState==='forwarded' ? '回答已作为普通消息送到对话；桌面的原生提问卡不会自动提交。' : !answered && !closed ? '提交后，回答会同步到同一条桌面对话。' : '' : '';
  return `<div class="question-card" data-node-key="${escapeHtml(key)}" data-question-item="${escapeHtml(item.id)}"><div class="question-status">${label}</div>${body}${editable ? '<button type="button" class="btn primary question-submit">提交回答</button>' : ''}${note ? `<small class="question-note">${note}</small>` : ''}${item.questionError ? `<div class="question-error" role="alert">${escapeHtml(item.questionError)}</div>` : ''}</div>`;
}

function bindQuestions(messages) {
  for (const card of messages.querySelectorAll('[data-question-item]')) {
    const itemId=card.dataset.questionItem;
    const save=(id,value)=>{const draft=questionDrafts.get(itemId) || {};draft[id]=value;questionDrafts.set(itemId,draft);};
    card.querySelectorAll('.question-option').forEach(button=>button.onclick=()=>{
      save(button.dataset.questionId,button.dataset.answer);
      for (const sibling of button.parentElement.querySelectorAll('button')) {const selected=sibling === button;sibling.classList.toggle('selected',selected);sibling.setAttribute('aria-pressed',String(selected));}
      button.closest('fieldset').querySelector('input').value=button.dataset.answer;
    });
    card.querySelectorAll('.question-free-text').forEach(input=>input.oninput=()=>{
      save(input.dataset.questionId,input.value);
      for (const button of input.closest('fieldset').querySelectorAll('.question-option')) {const selected=button.dataset.answer === input.value;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));}
    });
    const submit=card.querySelector('.question-submit');
    if (submit) submit.onclick=async()=>{
      if (questionSubmissions.has(itemId)) return;
      const view=state.views.get(state.activeSessionId), item=view?.timeline.find(entry=>entry.id === itemId);
      if (!item) return;
      questionSubmissions.add(itemId); item.questionError=null; scheduleRender();
      try {
        await api(`/api/sessions/${encodeURIComponent(view.id)}/questions/${encodeURIComponent(itemId)}/answers`,{method:'POST',body:JSON.stringify({answers:questionDrafts.get(itemId) || {}})});
        if (!item.questionAnswers) item.answerState='sending';
      } catch(error) {item.questionError=error.message;}
      finally {questionSubmissions.delete(itemId);scheduleRender();}
    };
  }
}

function turnStartedAt(turn) {
  const userAt = turn.items.find(item => item.type === 'userMessage')?.at;
  const times = turn.items.map(item => item.at).filter(at => Number.isFinite(at) && at > 0);
  return userAt || turn.startedAt || (times.length ? Math.min(...times) : 0);
}
function turnIsProcessing(turn) {
  return ['inProgress', 'running', 'waiting_input'].includes(turn.status) && !turnResult(turn);
}
function processingTimeLabel(startedAt, now = Date.now()) {
  return startedAt ? `已处理 ${elapsedTime(startedAt, now)}` : '';
}
function elapsedTime(startedAt, endedAt) {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${seconds % 60} 秒`;
}
function turnDuration(turn, now = Date.now()) {
  if(turn.segments) {
    if(!turn.segments.some(segment=>turnStartedAt(segment)))return '';
    const elapsed=combinedTurnElapsed(turn,now);
    return `${turnIsProcessing(turn) ? '已处理' : '用时'} ${elapsedTime(0,elapsed)}`;
  }
  const startedAt = turnStartedAt(turn);
  if (!startedAt) return '';
  if (turnIsProcessing(turn)) return processingTimeLabel(startedAt, now);
  const final = turnResult(turn);
  const endedAt = Math.max(turn.completedAt || 0, final?.at || 0) || Math.max(startedAt, ...turn.items.map(item => item.at).filter(Number.isFinite));
  return `用时 ${elapsedTime(startedAt, endedAt)}`;
}
function combinedTurnElapsed(turn,now) {
  return turn.segments.reduce((total,segment,index)=>{
    const start=turnStartedAt(segment);if(!start)return total;
    const processing=index===turn.segments.length-1 && turnIsProcessing(turn);
    const end=processing ? now : Math.max(segment.completedAt || 0,turnResult(segment)?.at || 0)
      || Math.max(start,...segment.items.map(item=>item.at).filter(Number.isFinite));
    return total+Math.max(0,end-start);
  },0);
}
function turnProcessingSince(turn,now=Date.now()) {
  return turn.segments ? now-combinedTurnElapsed(turn,now) : turnStartedAt(turn);
}
function liveActivityLabel(activity) {
  if (!activity) return '正在处理…';
  const item = { ...activity, type:activity.type || activity.kind };
  const running = ['inProgress','running'].includes(activity.status);
  const kind = processKind(item);
  if (kind === 'reconnect') return item.text || '正在重新连接';
  if (kind === 'command') return `${running ? '正在运行' : '上一条命令已结束'} ${shortCommand(item.command || item.input)}`;
  if (kind === 'edit') {
    const files = (item.changes || []).map(change => String(change.path || '').split(/[\\/]/).at(-1)).filter(Boolean);
    return `${running ? '正在编辑' : '刚编辑了'} ${files.join('、') || '文件'}`;
  }
  if (kind === 'browser') return `${running ? '正在使用浏览器' : '刚使用了浏览器'}${item.title ? '：' + item.title : ''}`;
  if (kind === 'context') return running ? '正在压缩上下文…' : '上下文已自动压缩，继续处理…';
  return `${running ? '正在调用' : '刚调用了'} ${item.title || item.name || item.server || '工具'}`;
}

function refreshProcessingTimes(now = Date.now()) {
  for (const node of document.querySelectorAll('[data-processing-since]')) {
    const raw=processingTimeLabel(Number(node.dataset.processingSince), now);
    const label=node.dataset.processingKind==='live'?raw.replace(/^已处理/,'本轮已执行'):raw;
    if (node.textContent !== label) node.textContent=label;
  }
  for(const node of document.querySelectorAll('[data-command-since]')){
    const timing=commandTiming({status:'inProgress',startedAt:Number(node.dataset.commandSince)},now);
    const label=node.dataset.commandCurrent==='true'?timing.label.replace(/^已运行/,'命令已执行'):timing.label;
    if(node.textContent!==label)node.textContent=label;
    if(node.classList.contains('is-long-running')!==timing.longRunning)node.classList.toggle('is-long-running',timing.longRunning);
  }
}

function currentCommand(turn){
  // Parallel calls can finish out of order. A newer completed operation must
  // not hide another command that is still executing in the current segment.
  const segment=turn.segments?.at(-1)||turn,commands=new Map();
  for(const item of segment.items)if(processKind(item)==='command')commands.set(item.id,item);
  const activity=segment.activity;
  if(activity&&processKind({...activity,type:activity.type||activity.kind})==='command'){
    const item=commands.get(activity.id),merged={...activity,...item,startedAt:item?.startedAt||activity.startedAt};
    if(item?.status==='completed'||activity.status==='completed')merged.status='completed';
    commands.set(activity.id,merged);
  }
  return [...commands.values()].filter(item=>['inProgress','running'].includes(item.status))
    .sort((a,b)=>(b.startedAt||b.at||0)-(a.startedAt||a.at||0))[0]||null;
}

function renderCurrentTurnClock(turn,now=Date.now()){
  if(!turnStartedAt(turn))return '<span class="command-elapsed">本轮起始时间未知</span>';
  const since=turnProcessingSince(turn,now),label=processingTimeLabel(since,now).replace(/^已处理/,'本轮已执行');
  return `<span class="command-elapsed" aria-live="off" data-processing-kind="live" data-processing-since="${since}" title="本轮请求已进行的总时间；当前没有命令正在执行。">${escapeHtml(label)}</span>`;
}

function renderExecutionAlert(alert,key,label='执行遇到问题'){
  const capacity=/selected model is at capacity/i.test(alert.message || '');
  return `<div class="turn-alert" role="alert" data-node-key="${escapeHtml(key)}"><strong>${alert.retrying ? '正在重试' : capacity ? '模型暂时繁忙' : label}</strong><span>${escapeHtml(alert.message)}</span>${capacity ? '<small>这次请求未完成。</small>' : ''}</div>`;
}
function renderViewError(view,turns){
  const error=String(view.error || '').trim();
  const turnError=String(turns.at(-1)?.alert?.message || '').trim();
  if(view.retrying)return '';
  if(turnError && (!error || error===turnError))return '';
  if(!error && view.status==='failed') return renderExecutionAlert({message:'本回合执行失败，暂未取得具体原因。可以展开历史查看最后收到的消息和命令。'},'view-error','执行失败');
  if(!error && view.status==='interrupted') return renderExecutionAlert({message:'本回合已中断，未收到完整回复。可以展开历史查看已完成的过程；编辑上一条提示词后可以继续发送。'},'view-error','已中断');
  if(!error)return '';
  return renderExecutionAlert({message:error},'view-error','Codex 错误');
}
function renderTurn(turn) {
  const user = turn.items.find(item => item.type === 'userMessage');
  const result = turnResult(turn);
  const pendingQuestions=(turn.segments?.at(-1)?.items || turn.items).filter(item=>item.questions?.length && !item.questions.every(question=>typeof item.questionAnswers?.[question.id] === 'string') && ['inProgress','running','waiting_input'].includes(turn.status));
  const history = turn.items.filter(item => item !== user && item !== result && item.type !== 'reasoning' && !pendingQuestions.includes(item));
  for (const notice of turn.notices || []) if (!history.some(item=>item.id === notice.id)) history.push({...notice,type:notice.kind});
  history.sort((a,b)=>(a.at || 0)-(b.at || 0));
  const rows = displayTimelineRows(history);
  const turnKey = String(turn.turnId || turn.id || 'turn');
  const html = [];
  if (user) html.push(renderTimelineItem(user, `${turnKey}:user`));
  const duration = turnDuration(turn);
  const timing = `<span class="turn-history-duration"${turnIsProcessing(turn) && turnStartedAt(turn) ? ` data-processing-since="${turnProcessingSince(turn)}"` : ''}>${escapeHtml(duration)}</span>`;
  // Keep replies and current activity visible; consecutive process records use
  // the same disclosure keys while running and after completion.
  if (turnIsProcessing(turn)) {
    if (duration) html.push(`<div class="turn-timing" data-node-key="${escapeHtml(`${turnKey}:timing`)}">${timing}</div>`);
    const activeItems=turn.items.filter(item=>item!==user && item.type!=='reasoning');
    for (const notice of turn.notices || []) if (!activeItems.some(item=>item.id===notice.id)) activeItems.push({...notice,type:notice.kind});
    activeItems.sort((a,b)=>(a.at || 0)-(b.at || 0));
    for (const row of displayTimelineRows(activeItems)) html.push(row.type==='processGroup'
      ? renderLiveProcessGroup(row.items,`${turnKey}:process:${row.items[0].id}`)
      : row.questions?.length ? renderQuestion(row,`${turnKey}:question:${row.id}`,!pendingQuestions.includes(row))
      : renderTimelineItem(row,`${turnKey}:item:${row.id}`));
    if (!result) {
      const activity=(turn.status!=='waiting_input'&&currentCommand(turn))||turn.activity,reconnect=activity?.kind==='reconnect';
      const command=activity&&turn.status!=='waiting_input'&&processKind({...activity,type:activity.type||activity.kind})==='command';
      const running=command&&['inProgress','running'].includes(activity.status);
      const badge=running?renderCommandClock(activity,true):renderCurrentTurnClock(turn);
      const label=turn.status==='waiting_input'?'等待你回答…':command&&!running?'正在继续处理 · 上一条命令已结束':liveActivityLabel(activity);
      const live=`${reconnect ? '<span class="status-icon" aria-hidden="true">⌁</span>' : '<i class="activity-dot"></i>'}<span class="turn-live-label">${escapeHtml(label)}</span>${badge}`;
      if(command){
        const key=`${turnKey}:activity:${activity.id || 'command'}`,item={...activity,...turn.items.find(item=>item.id===activity.id),type:activity.type || activity.kind};
        const detail=state.openDetailKeys.has(key)?`${!running?`<div class="process-detail-label">上一条命令已结束 · ${renderCommandClock(item)}</div>`:''}${processItemDetails(item)}`:'';
        html.push(`<details class="turn-live-command" data-detail-key="${escapeHtml(key)}"><summary class="turn-live has-command-clock">${live}<span class="disclosure-arrow" aria-hidden="true">›</span></summary><div class="process-item-detail">${detail}</div></details>`);
      }else html.push(`<div class="turn-live has-command-clock${reconnect ? ' is-reconnecting' : ''}" role="status" data-node-key="${escapeHtml(`${turnKey}:live`)}">${live}</div>`);
      if (reconnect && activity.detail) html.push(`<div class="runtime-detail" data-node-key="${escapeHtml(`${turnKey}:retry-detail`)}">${escapeHtml(activity.detail)}</div>`);
    }
    if (turn.alert && (!turn.alert.retrying || turn.activity?.kind!=='reconnect')) html.push(renderExecutionAlert(turn.alert,`${turnKey}:alert`));
    return `<section class="turn" data-turn-id="${escapeHtml(turn.turnId || turn.id)}">${html.join('')}</section>`;
  }
  if (history.length) {
    const historyKey = `${turnKey}:history`;
    const body = state.openDetailKeys.has(historyKey) ? rows.map(row => row.type === 'processGroup'
      ? renderProcessGroup(row.items, `${turnKey}:process:${row.items[0].id}`)
      : row.questions?.length ? renderQuestion(row,`${turnKey}:question:${row.id}`,!turnIsProcessing(turn))
      : row.type === 'agentMessage' ? renderIntermediateMessage(row, `${turnKey}:reply:${row.id}`)
      : renderTimelineItem(row, `${turnKey}:item:${row.id}`)).join('') : '';
    html.push(`<details class="turn-history" data-detail-key="${escapeHtml(historyKey)}"><summary><span>${escapeHtml(turnHistoryLabel(history))}</span>${timing}<span class="disclosure-arrow">›</span></summary><div class="turn-history-body">${body}</div></details>`);
  } else if (duration) {
    html.push(`<div class="turn-timing" data-node-key="${escapeHtml(`${turnKey}:timing`)}">${timing}</div>`);
  }
  if (result) html.push(`<div class="turn-result" data-node-key="${escapeHtml(`${turnKey}:result`)}">${renderTimelineItem(result, `${turnKey}:result-message`)}</div>`);
  for (const question of pendingQuestions) html.push(renderQuestion(question,`${turnKey}:question:${question.id}`));
  if (turn.alert && (!turn.alert.retrying || turn.activity?.kind !== 'reconnect')) html.push(renderExecutionAlert(turn.alert,`${turnKey}:alert`));
  if (!result && !history.length && turn.status === 'completed') html.push('<div class="system-row">本回合没有文本回复</div>');
  return `<section class="turn" data-turn-id="${escapeHtml(turn.turnId || turn.id)}">${html.join('')}</section>`;
}

function timelineTurns(timeline) {
  const turns = [];
  const byId = new Map();
  let current = null;
  let sequence = 0;
  const createTurn = (turnId, item) => {
    const turn = { id: turnId || `turn-${sequence}`, turnId: turnId || null, items: [], order: sequence++, at: item?.at || 0 };
    turns.push(turn);
    if (turnId) byId.set(turnId, turn);
    return turn;
  };
  const add = (turn, item) => {
    turn.items.push(item);
    if (!turn.at || (item.at && item.at < turn.at)) turn.at = item.at;
    current = turn;
  };
  for (const item of timeline) {
    const turnId = item.turnId || item.turn_id || null;
    if (item.type === 'userMessage') {
      let turn = turnId ? byId.get(turnId) : null;
      if (!turn) turn = createTurn(turnId, item);
      if (turnId) { turn.turnId = turnId; byId.set(turnId, turn); }
      add(turn, item);
      continue;
    }
    let turn = turnId ? byId.get(turnId) : null;
    if (!turn && turnId && current && !current.turnId) {
      current.turnId = turnId;
      byId.set(turnId, current);
      turn = current;
    }
    if (!turn) turn = turnId ? createTurn(turnId, item) : current || createTurn(null, item);
    if (turnId && !turn.turnId) { turn.turnId = turnId; byId.set(turnId, turn); }
    add(turn, item);
  }
  return turns.sort((a, b) => a.order - b.order);
}

function conversationTurns(turns) {
  const groups=[];
  for(const turn of turns) {
    const previous=groups.at(-1);
    if(!previous || turn.items.some(item=>item.type==='userMessage')) {groups.push(turn);continue;}
    // Continued segments without another user input belong to the same
    // visible round. Keep its first identity stable as later segments arrive.
    groups[groups.length-1]={...turn,id:previous.id,turnId:previous.turnId,order:previous.order,at:previous.at,
      startedAt:previous.startedAt,completedAt:turn.completedAt || null,
      items:[...previous.items,...turn.items],segments:[...(previous.segments || [previous]),turn],
      activity:turn.activity || null,alert:turn.alert || null,
      notices:[...(previous.notices || []),...(turn.notices || [])]};
  }
  return groups;
}

function renderTimelineItem(item, keyPrefix = 'process') {
  if (item.type === 'userMessage') {
    const session=activeSession(),edit=drafts.get(session?.id).edit;
    if(edit?.messageId===item.id)return renderMessageEditor(session,edit,keyPrefix);
    const editable=!state.restoringPreview && !session?.cachedPreview && session?.editableMessages?.some(message=>message.id===item.id);
    const context=item.context?.length ? `<span class="message-context">${item.context.map(ref=>`<span class="context-chip">${ref.kind==='skill' ? '$' : '@'}${escapeHtml(ref.name)}</span>`).join('')}</span>` : '';
    const copy=`<button class="message-copy-action" type="button" data-copy-message="${escapeHtml(item.id)}" aria-label="复制问题" title="复制问题">⧉</button>`;
    const editAction=editable ? `<button class="queue-icon" type="button" data-edit-message="${escapeHtml(item.id)}" aria-label="编辑消息" title="编辑消息"${edit ? ' disabled' : ''}>✎</button>` : '';
    return `<div class="message you user-message" data-message-id="${escapeHtml(item.id || `user-${item.at || 0}`)}" data-node-key="${escapeHtml(keyPrefix)}"><div class="bubble markdown">${context}${renderImages(item.images,keyPrefix+':images')}${renderAttachments(item.attachments,item.text || '')}${item.text ? renderMarkdown(item.text) : ''}</div><div class="user-message-actions">${copy}${editAction}</div></div>`;
  }
  if (item.type === 'agentMessage') return `<div class="message assistant" data-node-key="${escapeHtml(keyPrefix)}"><div class="bubble markdown">${renderImages((item.images || []).filter(image=>!(item.text || '').includes(image.ref || image.url)),keyPrefix+':images')}${renderAttachments(item.attachments,item.text || '')}${renderMarkdown(item.text || (item.images?.length || item.attachments?.length ? '' : '正在生成输出…'))}</div><button class="message-copy-action" type="button" data-copy-message="${escapeHtml(item.id)}" aria-label="复制回答" title="复制回答">⧉</button></div>`;
  if (item.type === 'processGroup') return renderProcessGroup(item.items, keyPrefix);
  if (item.type === 'plan') return `<div class="plan-card"><strong>Codex 计划</strong><div class="markdown">${renderMarkdown(item.text || '')}</div></div>`;
  if (item.type === 'system') return `<div class="system-row">${escapeHtml(item.text)}</div>`;
  return '';
}

let renderedSessionId = null;
const initializedDetails = new WeakSet();
const timelineViewport = new TimelineViewport();

function renderTimeline(view, session = null) {
  const messages = $('messages');
  const key = session?.id || 'empty';
  if(renderedSessionId!==key)resetImageVisibility();
  const latestUser = (view.timeline || []).filter(item => item.type === 'userMessage').at(-1);
  const scroll = timelineViewport.capture(messages, key, latestUser ? String(latestUser.id || `user-${latestUser.at || 0}`) : null);
  latestNavigation?.before(key,JSON.stringify((view.timeline || []).map(item=>[item.id,item.text?.length,item.status,item.aggregatedOutput?.length])),scroll);
  const turns = timelineTurns(view.timeline || []);
  const metadata = new Map((session?.turns || []).map(turn => [turn.id, turn]));
  for (const turn of turns) {
    Object.assign(turn, metadata.get(turn.turnId) || {});
    if (!turn.status) turn.status = turn === turns.at(-1)
      ? ({ done: 'completed', running: 'inProgress', starting: 'inProgress', waiting_approval: 'inProgress', waiting_input:'waiting_input', failed: 'failed' })[view.status] || 'completed'
      : 'completed';
  }
  const latestTurn = turns.at(-1);
  if (latestTurn && view.status === 'waiting_input' && ['inProgress','running'].includes(latestTurn.status)) latestTurn.status='waiting_input';
  if (latestTurn && ['inProgress','running'].includes(latestTurn.status) && view.activity && (view.activity.at || 0) >= (latestTurn.activity?.at || 0)) latestTurn.activity=view.activity;
  const total = Math.max(session?.turnCount || 0, turns.length);
  const initialLimit=initialHistoryLimit(session);
  const requestedLimit = state.timelineLimits.get(key) || initialLimit;
  const currentLimit = requestedLimit === 'all' ? total : Math.min(requestedLimit, total || initialLimit);
  const visibleTurns = conversationTurns(turns).slice(-currentLimit);
  const loadingHistory = session && !session.events?.length && (session.historyLoaded || session.historyRequested);
  const rows = [];
  if (total > initialLimit) {
    const all = currentLimit >= total;
    const busy = loadingHistory || session?.historyRequested && turns.length < currentLimit;
    const controls = all ? '<button class="timeline-btn" id="recentTimeline" type="button">只看最近 ' + initialLimit + ' 个回合</button>'
      : '<button class="timeline-btn" id="expandTimelineMore" type="button">展开更多 5 个回合</button><button class="timeline-btn" id="showAllTimeline" type="button">查看全部</button>';
    rows.push({key:'pagination',html:'<div class="history-divider" data-node-key="turn-pagination"><span>最近 ' + visibleTurns.length + ' 个回合</span><div>' + (busy ? '<span class="muted">正在加载…</span>' : controls) + '</div></div>'});
  }
  if (loadingHistory) rows.push({key:'loading',html:'<div class="system-row" role="status" data-node-key="history-loading">正在加载对话…</div>'});
  for (const turn of visibleTurns) rows.push({key:'turn:'+turn.id,html:renderTurn(turn)});
  const edit=drafts.get(session?.id).edit;
  if(edit && !(view.timeline || []).some(item=>item.type==='userMessage' && item.id===edit.messageId))rows.push({key:'edit-recovery',html:renderMessageEditor(session,edit,'edit-recovery-'+edit.messageId)});
  rows.push({key:'error',html:renderViewError(view,visibleTurns)});
  if(!rows.some(row=>row.html))rows.push({key:'empty',html:'<div class="system-row">' + (session?.historyRequested ? '正在读取对话…' : '选择一个对话开始') + '</div>'});
  const changed = syncHtmlParts(messages, rows);
  renderedSessionId = key;
  if (!changed) {
    if (scroll.switched || scroll.positionInput) timelineViewport.restore(messages, scroll);
    latestNavigation?.after();
    return;
  }
  bindMessageEditors(messages,session);
  mediaCards.bind(messages);
  messages.dataset.renderRevision = String(Number(messages.dataset.renderRevision || 0) + 1);
  for (const detail of messages.querySelectorAll('details[data-detail-key]')) {
    if (initializedDetails.has(detail)) continue;
    initializedDetails.add(detail);
    if (state.openDetailKeys.has(detail.dataset.detailKey)) detail.open = true;
  }
  const expand = async limit => {
    state.timelineLimits.set(key, limit);
    if (session?.source === 'imported' && (limit === 'all' ? turns.length < total : limit > turns.length)) {
      await requestSessionHistory(session, limit);
    }
    renderTimeline(view, session);
  };
  if ($('expandTimelineMore')) $('expandTimelineMore').onclick = () => expand(Math.min(total, currentLimit + 5));
  if ($('showAllTimeline')) $('showAllTimeline').onclick = () => expand('all');
  if ($('recentTimeline')) $('recentTimeline').onclick = () => expand(initialLimit);
  bindQuestions(messages);
  timelineViewport.restore(messages, scroll);
  latestNavigation?.after();
}

function renderInspector(session, view) {
  const selected = device(session?.deviceId || state.selectedDeviceId);
  $('contextDevice').textContent = selected?.name || '—'; $('contextCwd').textContent = session?.cwd || selected?.cwd || '—'; $('contextModel').textContent = codexSettingsLabel(session || {}, state.catalogs.get(session?.deviceId)); $('contextThread').textContent = view?.threadId || session?.threadId || '等待创建';
  syncHtml($('planList'), view?.plan?.length ? view.plan.map(step => `<div class="plan-row ${step.status}">${step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '→' : '•'} ${escapeHtml(step.step)}</div>`).join('') : '<div class="muted">等待 Codex 提供计划</div>');
  syncHtml($('fileList'), view?.fileChanges?.length ? view.fileChanges.map(change => `<div class="file-entry">${escapeHtml(change.path || '')} <b>${escapeHtml(change.kind || '修改')}</b></div>`).join('') : '<div class="muted">尚未收到文件变更</div>');
  $('diffBtn').disabled = !view?.diff; $('diffBtn').onclick = () => view?.diff && showDiff(view.diff);
  const checks = session?.status === 'done' ? [['✓','Codex turn 完成','done'],['✓','事件已同步','done']] : session?.status === 'failed' ? [['!','任务失败','failed']] : [['•','等待 turn 完成','pending']];
  syncHtml($('checks'), checks.map(([icon,text,kind]) => `<div class="check ${kind === 'pending' ? 'pending' : ''}"><i>${icon}</i><span>${text}</span></div>`).join(''));
}

function usageDate(seconds) {
  return seconds > 0 ? new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(seconds*1000)) : '暂未提供';
}
function renderHistoricalUsage(history) {
  const progress=history?.status==='indexing' ? `<p class="muted" role="status">正在后台统计历史用量${history.files ? ` · ${history.scannedFiles || 0} / ${history.files} 个文件` : '…'}</p>` : '';
  if(!history?.models)return `<section class="usage-history">${progress || `<p class="muted">${history?.error ? escapeHtml(history.error) : '等待读取本机历史用量。'}</p>`}</section>`;
  const numbers=value=>new Intl.NumberFormat('zh-CN').format(value);
  const rows=history.models.map(model=>{
    const label=model.model==='unknown' ? '未知模型' : model.model.replace(/^gpt-/,'GPT-').replace(/-(sol|astra|luna|terra)$/i,(_,name)=>' '+name[0].toUpperCase()+name.slice(1));
    const share=history.totalTokens ? model.totalTokens/history.totalTokens*100 : 0;
    return `<div class="usage-model"><div><strong>${escapeHtml(label)}</strong><span title="${numbers(model.totalTokens)} token">${compactTokens(model.totalTokens)} token · ${share.toFixed(1)}%</span></div><progress max="100" value="${share}" aria-label="${escapeHtml(label)}用量占比"></progress><small>输入 ${numbers(model.inputTokens)}（其中缓存 ${numbers(model.cachedInputTokens)}） · 输出 ${numbers(model.outputTokens)}${model.reasoningTokens ? `（其中推理 ${numbers(model.reasoningTokens)}）` : ''}</small></div>`;
  }).join('');
  return `<section class="usage-history"><p class="usage-history-total">${numbers(history.totalTokens)} <small>token</small></p>${progress}${rows || '<p class="muted">所选时间范围没有可统计的 token 记录。</p>'}<p class="muted">统计本机已保存的全部项目和归档历史；按每次调用计数，复制的分支记录去重。缓存输入包含在输入内，推理包含在输出内。${history.unreadableFiles ? `有 ${history.unreadableFiles} 个文件暂不可读。` : ''}</p>${history.error ? `<p class="media-error">${escapeHtml(history.error)}</p>` : ''}</section>`;
}
function selectedUsagePeriod() {const {preset,start,end}=state.historyUsageFilter;return usagePeriod(preset,start,end);}
async function refreshHistoricalRange(id=activeSession()?.deviceId || state.selectedDeviceId,force=false) {
  if(!id || id!==(activeSession()?.deviceId || state.selectedDeviceId) || $('historyUsageModal').classList.contains('hidden'))return;
  const {range}=selectedUsagePeriod();if(!range)return;
  const key=usageRangeKey(id,range),cached=historicalRangeUsages.get(key),version=state.historicalUsages.get(id)?.updatedAt || 0;
  if(historyRangeLoads.has(key) || !force && cached?.status==='ready' && cached.updatedAt>=version)return;
  historyRangeLoads.add(key);renderUsage();
  let failed=false;
  try{
    const result=await api(`/api/devices/${encodeURIComponent(id)}/history-usage?from=${range.from}&to=${range.to}`,{method:'POST',body:'{}',timeoutMs:15000,timeoutMessage:'历史统计超时，请稍后重试。'});
    if(result.usage && usageRangeKey(id,result.usage.range)!==key)throw new Error('后台暂未支持时间筛选，请更新 Relay 后台。');
    if(result.usage){historicalRangeUsages.delete(key);historicalRangeUsages.set(key,result.usage);}
  }catch(error){failed=true;historicalRangeUsages.set(key,{...cached,status:'error',range,error:error.message});}
  finally{
    historyRangeLoads.delete(key);
    while(historicalRangeUsages.size>32)historicalRangeUsages.delete(historicalRangeUsages.keys().next().value);
    renderUsage();
    // A newer scan may have finished while this query was in flight.
    const latest=state.historicalUsages.get(id)?.updatedAt || 0;
    if(!failed && latest>version && (historicalRangeUsages.get(key)?.updatedAt || 0)<latest)refreshHistoricalRange(id);
  }
}
function selectHistoricalPreset() {
  const preset=$('historyUsagePreset').value;
  $('historyUsageCustom').hidden=preset!=='custom';$('historyUsageRangeError').textContent='';
  if(preset==='custom')return;
  state.historyUsageFilter.preset=preset;renderUsage();refreshHistoricalRange();
}
function applyHistoricalDates(event) {
  event.preventDefault();
  const start=$('historyUsageStart').value,end=$('historyUsageEnd').value;
  try{usagePeriod('custom',start,end);}
  catch(error){$('historyUsageRangeError').textContent=error.message;return;}
  state.historyUsageFilter={preset:'custom',start,end};$('historyUsageRangeError').textContent='';renderUsage();refreshHistoricalRange();
}
async function refreshHistoryPanel() {await refreshHistoricalUsage();await refreshHistoricalRange(undefined,true);}
async function refreshHistoricalUsage(id=activeSession()?.deviceId || state.selectedDeviceId) {
  if(!id || historyUsageLoads.has(id))return;
  historyUsageLoads.add(id);
  renderUsage();
  try{const result=await api(`/api/devices/${encodeURIComponent(id)}/history-usage`,{method:'POST',body:'{}'});if(result.usage)state.historicalUsages.set(id,result.usage);}
  catch(error){state.historicalUsages.set(id,{...state.historicalUsages.get(id),status:'error',error:error.message});}
  finally{historyUsageLoads.delete(id);renderUsage();}
}
function renderUsage() {
  const session = activeSession(); const id=session?.deviceId || state.selectedDeviceId;
  const usage = state.usages.get(id); const context = session?.tokenUsage;
  const percent = context?.usedPercent == null ? null : Math.round(context.usedPercent);
  syncHtml($('composerActivity'),`<span class="usage-context-label">上下文 </span>${percent == null ? '—' : percent+'%'}`);
  $('composerActivity').title = '查看额度、重置时间和上下文用量';
  $('composerActivity').ariaLabel=`上下文${percent == null ? '用量暂未提供' : '已使用 '+percent+'%'}，查看用量详情`;
  const buckets = usage?.buckets || [];
  const main = buckets.find(bucket=>bucket.id === 'codex') || buckets[0];
  const summary = (main?.windows || []).filter(window=>[300,10080].includes(window.minutes) && window.remainingPercent != null)
    .map(window=>`${window.minutes === 300 ? '5 小时' : '周'}剩余 ${Math.round(window.remainingPercent)}%`).join(' · ');
  const history=state.historicalUsages.get(id),measured=tokenRates.observe(session);
  const sampled=history?.models?.find(model=>model.model===session?.nativeModel?.toLowerCase())?.averageTokensPerSecond;
  const rate=measured ?? sampled;
  const speedLabel=measured!=null?'任务均速':'历史均速';
  $('usageQuotaSummary').textContent=summary ? `额度余量 · ${summary.replace('5 小时','5h').replaceAll('剩余 ','')}` : usage?.refreshing ? '额度更新中…' : '额度';
  $('usageTokenSummary').textContent=`累计 ${history?.totalTokens!=null ? compactTokens(history.totalTokens)+' token' : history?.status==='indexing' ? '统计中…' : '—'}`;
  $('usageSpeedSummary').textContent=rate!=null ? `${speedLabel} ≈${rate.toFixed(1)} token/s` : '任务均速 —';
  $('usageSpeedSummary').ariaLabel=`${$('usageSpeedSummary').textContent}，查看速度说明`;
  $('usageSpeedSummary').title=`${measured!=null ? '当前回合最近两次用量报告之间的任务均速' : '当前模型历史采样均速，并非当前运行速度'}；包含思考、工具执行、重试和等待，并非模型连续生成时的 token/s。点击查看说明。`;
  $('usageOpenBtn').title='查看额度余量、重置时间和当前上下文用量';
  const period=selectedUsagePeriod(),rangeKey=usageRangeKey(id,period.range);
  $('refreshHistoryUsageBtn').disabled=historyUsageLoads.has(id) || historyRangeLoads.has(rangeKey);
  if(!$('historyUsageModal').classList.contains('hidden')){
    const filtered=period.range ? historicalRangeUsages.get(rangeKey) : history;
    const data=filtered ? {...filtered,unreadableFiles:history?.unreadableFiles} : period.range ? {status:history?.status==='error' ? 'error' : 'indexing',error:history?.error,files:history?.files,scannedFiles:history?.scannedFiles} : null;
    const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    syncHtml($('historyUsageContent'),`<p class="muted">${escapeHtml(device(id)?.name || id || '当前电脑')} · ${period.label}<br>按本设备日期（${escapeHtml(zone)}）统计，结束日期包含当天。</p>${renderHistoricalUsage(data)}`);
  }
  if ($('usageModal').classList.contains('hidden')) return;
  const numbers = value=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(value);
  const quotaRow = window=>`<div class="usage-quota"><div class="usage-quota-head"><strong>${quotaWindowName(window.minutes)}</strong><span>${window.remainingPercent == null ? '暂未提供' : `剩余 ${numbers(window.remainingPercent)}%`}</span></div>${window.remainingPercent == null ? '' : `<progress max="100" value="${window.remainingPercent}" aria-label="${quotaWindowName(window.minutes)}剩余 ${numbers(window.remainingPercent)}%"></progress>`}<small>下次重置：${usageDate(window.resetsAt)}</small></div>`;
  const quota = buckets.length ? buckets.map(bucket=>{
    const windows = [...bucket.windows];
    windows.sort((a,b)=>(a.minutes || Infinity)-(b.minutes || Infinity));
    const balance=Number(bucket.credits?.balance);
    const credits=bucket.credits ? `<p class="usage-credits">积分余额：${bucket.credits.unlimited ? '不限量' : bucket.credits.balance != null && Number.isFinite(balance) ? numbers(balance) : '暂未提供'}</p>` : '';
    return `<section class="usage-bucket">${buckets.length > 1 ? `<h3>${escapeHtml(bucket.name)}</h3>` : ''}${windows.map(quotaRow).join('')}${credits}</section>`;
  }).join('') : `<p class="muted">${usage?.error ? '暂时无法读取额度，可刷新重试。' : usage ? '当前账号暂未提供额度。' : device(id)?.online ? '正在读取 Codex 额度…' : '等待执行设备连接后读取额度。'}</p>`;
  const details = context ? `<p><strong>${percent == null ? '百分比暂未提供' : `约 ${percent}% 已使用`}</strong></p><p>${numbers(context.usedTokens)} / ${context.windowTokens == null ? '窗口大小暂未提供' : numbers(context.windowTokens)} tokens</p>${percent == null ? '' : `<progress max="100" value="${context.usedPercent}" aria-label="上下文已使用 ${percent}%"></progress>`}<small>根据 Codex 最近一次模型调用的 token 用量。${context.updatedAt ? `更新于 ${usageDate(context.updatedAt/1000)}。` : ''}压缩后随新用量更新。</small>` : '<p class="muted">当前对话暂未提供上下文用量。</p>';
  syncHtml($('usageContent'), `<p class="muted">${escapeHtml(device(id)?.name || id)} · 同一账号的额度由所有任务共用</p>${quota}${usage?.updatedAt ? `<p class="muted usage-updated">额度更新于 ${usageDate(usage.updatedAt/1000)}${usage.error && buckets.length ? ' · 本次刷新失败，保留上次数据' : ''}（本设备时间）</p>` : ''}<section class="usage-context"><h3>速度与当前上下文</h3><p>${rate!=null ? `${measured!=null ? '任务区间均速' : '当前模型历史采样均速'}：约 ${rate.toFixed(1)} token/s` : '任务均速：暂未取得可比较的两次用量报告。'}</p><small>新增输出 token ÷ 两次用量报告间的时间；包含思考、工具执行、重试和等待，并非逐 token 解码速度。</small><p>模型生成速率：当前接口未提供，无法由任务均速推算。</p>${details}</section>`);
}
function openUsage() {
  closeComposerPopovers();$('historyUsageModal').classList.add('hidden');$('usageModal').classList.remove('hidden');renderUsage();refreshUsage();
}
function openHistoryUsage() {
  closeComposerPopovers();$('usageModal').classList.add('hidden');$('historyUsageModal').classList.remove('hidden');renderUsage();refreshHistoricalUsage();refreshHistoricalRange();
}
async function refreshUsage() {
  const id=activeSession()?.deviceId || state.selectedDeviceId;
  $('refreshUsageBtn').disabled=true;$('usageError').textContent='';
  try { const result=await api(`/api/devices/${encodeURIComponent(id)}/usage`,{method:'POST',body:'{}'});if(result.usage)state.usages.set(id,result.usage);renderUsage(); }
  catch(error){$('usageError').textContent=error.message;}
  finally{$('refreshUsageBtn').disabled=false;}
}
function render() {
  renderUsage();
  try { if (state.activeSessionId && !state.restoreSessionId) localStorage.setItem('codex-relay-active-session', state.activeSessionId); } catch { /* optional preference */ }
  renderDevices(); renderSessions();
  const session = activeSession(); const view = session ? viewFor(session) : null;
  if(session){state.deviceSessions[session.deviceId]=session.id;try{localStorage.setItem('codex-relay-device-sessions',JSON.stringify(state.deviceSessions));}catch{}}
  $('sessionTitle').textContent = session?.title || '选择或新建任务'; $('repoName').textContent = 'Codex Relay';
  const indicator=sessionIndicator(session || {});
  $('sessionRuntime').classList.toggle('hidden',!session);
  const preview=state.restoringPreview || session?.cachedPreview;
  syncHtml($('sessionRuntimeStatus'),`<i class="session-indicator ${preview?'idle':indicator.kind}" aria-hidden="true"></i><span>${escapeHtml(preview?'上次保存的文字 · 状态待核对':indicator.label)}</span>`);
  $('sessionRuntimeModel').textContent='Codex 当前：'+codexSettingsLabel(session || {},state.catalogs.get(session?.deviceId));
  renderTimeline(view || { timeline:[] }, session); renderInspector(session, view || {});
  const selected = device(session?.deviceId || state.selectedDeviceId); const offline = !selected?.online; const label = preview ? '状态待核对' : offline ? '执行电脑未连接' : statusLabel(session?.status || 'ready'); const pill = $('statusPill'); pill.className = `status-pill ${preview?'waiting':offline ? 'offline' : session?.status === 'waiting_approval' ? 'waiting' : ['done','synced'].includes(session?.status) ? session.status : session?.status === 'failed' ? 'failed' : ''}`; syncHtml(pill, `<i class="${offline ? 'dot offline' : 'session-indicator '+indicator.kind}" aria-hidden="true"></i><span>${label}</span>`);
  $('interruptBtn').disabled = preview || !turnControls(session,!offline).interrupt;
  if (view?.approval) renderApproval(view.approval); else syncHtml($('approvalSlot'), '');
  renderComposer();
  maybeMarkSessionRead();
  focusAttentionRequest();
}

function scheduleRender() {
  if (renderTimer !== null) return;
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    render();
  }, 60);
}

function renderApproval(request) {
  const params = request.params || {}; const command = params.command || params.networkApprovalContext?.host || ''; const reason = params.reason || 'Codex 请求执行一项需要你确认的操作。';
  const elicitation=request.method === 'mcpServer/elicitation/request';
  const permissions=request.method === 'item/permissions/requestApproval';
  const labels={accept:elicitation ? '提交' : '批准这一次',acceptForSession:'本次会话都批准',decline:'拒绝',cancel:'取消'};
  const url=elicitation && params.mode === 'url' && /^https?:\/\//i.test(params.url || '') ? `<a href="${escapeHtml(params.url)}" target="_blank" rel="noopener noreferrer">打开授权页面</a>` : '';
  const form=elicitation && params.mode !== 'url' ? `<details><summary>表单字段</summary><pre>${escapeHtml(JSON.stringify(params.requestedSchema,null,2))}</pre></details><textarea data-approval-content aria-label="表单 JSON 回答" placeholder="填写 JSON 对象，例如 {&quot;name&quot;:&quot;值&quot;}"></textarea>` : '';
  const details=permissions ? JSON.stringify(params.permissions,null,2) : params.changes ? JSON.stringify(params.changes,null,2) : command;
  syncHtml($('approvalSlot'), `<div class="approval" data-node-key="approval-${escapeHtml(request.key || String(request.id))}"><strong>${request.submitting ? '正在提交审批…' : elicitation ? '需要你提供信息' : '需要你的审批'}</strong><p>${escapeHtml(params.message || reason)}</p>${details ? `<pre>${escapeHtml(details)}</pre>` : ''}${url}${form}${request.error ? `<p role="alert">${escapeHtml(request.error)}</p>` : ''}<div class="action-row">${approvalChoices(request).map(decision=>`<button class="btn${decision === 'decline' ? ' danger' : ''}" data-approval="${decision}"${request.submitting ? ' disabled' : ''}>${labels[decision]}</button>`).join('')}</div></div>`);
  document.querySelectorAll('[data-approval]').forEach(button => button.onclick = async () => {
    const buttons=$('approvalSlot').querySelectorAll('[data-approval]');buttons.forEach(item=>item.disabled=true);
    try {
      const field=$('approvalSlot').querySelector('[data-approval-content]');
      const content=field && button.dataset.approval === 'accept' ? JSON.parse(field.value) : undefined;
      await api(`/api/approvals/${encodeURIComponent(request.key || request.id)}`, { method:'POST', body:JSON.stringify({sessionId:request.sessionId,decision:button.dataset.approval,content}) });
    } catch(error) { $('composeError').textContent=error.message; buttons.forEach(item=>item.disabled=false); }
  });
}

function showDiff(diff) { const win = window.open('', '_blank', 'noopener,noreferrer'); if (win) win.document.write(`<pre style="white-space:pre-wrap;background:#0b1016;color:#e8eef6;padding:24px;font:13px/1.6 ui-monospace,monospace">${escapeHtml(diff)}</pre>`); }
async function requestCatalog(deviceId) {
  if (!deviceId || state.catalogLoads.has(deviceId) || state.catalogs.has(deviceId)) return;
  state.catalogLoads.add(deviceId);
  try { const catalog = await api(`/api/devices/${encodeURIComponent(deviceId)}/catalog`); if (!catalog.pending) state.catalogs.set(deviceId, catalog); }
  catch (error) { $('composeError').textContent = error.message; }
  finally { state.catalogLoads.delete(deviceId); renderComposer(); }
}
function settingsKey() { return state.activeSessionId || `device:${state.selectedDeviceId}`; }
function choicesFor(id=state.activeSessionId) {
  const session = state.sessions.find(session=>session.id===id);
  return sessionChoices(session, state.sessionsChoices[id || settingsKey()] || {});
}
function renderSelectors(prefix, deviceId, choices) {
  const catalog = state.catalogs.get(deviceId);
  const models = selectableModels(catalog || {});
  const modelSelect = $(prefix ? prefix + 'ModelSelect' : 'modelSelect'); const effortSelect = $(prefix ? prefix + 'EffortSelect' : 'effortSelect'); const permissionSelect = $(prefix ? prefix + 'PermissionSelect' : 'permissionSelect');
  const inheritedModel = prefix ? preferredModel(catalog)?.model : activeSession()?.nativeModel || activeSession()?.model || catalog?.defaultModel;
  const defaultName = ((catalog?.models || []).find(model => model.model === inheritedModel) || preferredModel(catalog))?.displayName;
  const modelValue = choices.model || '';
  const model = models.find(item => item.model === modelValue);
  const unknown = modelValue && !model ? `<option value="${escapeHtml(modelValue)}" disabled>${escapeHtml(modelValue)}（不可选）</option>` : '';
  syncHtml(modelSelect, `<option value="">${catalog ? `${prefix ? '默认模型' : '沿用当前模型'}${defaultName ? ' · ' + escapeHtml(defaultName) : ''}` : '正在读取模型…'}</option>` + unknown + models.map(item => `<option value="${escapeHtml(item.model)}">${escapeHtml(item.displayName || item.model)}</option>`).join(''));
  modelSelect.value = modelValue; modelSelect.disabled = !catalog;
  syncHtml(effortSelect, '<option value="">默认强度</option>' + (model?.supportedReasoningEfforts || []).map(item => `<option value="${escapeHtml(item.reasoningEffort)}">${escapeHtml(effortLabels[item.reasoningEffort] || item.reasoningEffort)}</option>`).join(''));
  effortSelect.value = choices.effort || ''; effortSelect.disabled = !model;
  syncHtml(permissionSelect, '<option value="">沿用当前权限</option>' + (catalog?.permissions || []).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join(''));
  permissionSelect.value = choices.permission || ''; permissionSelect.disabled = !catalog;
}
function renderComposer() {
  const session = activeSession(); const deviceId = session?.deviceId || state.selectedDeviceId;
  if (session && composerSessionId !== session.id) {
    // Opening a conversation follows its current model, including older saved send choices.
    const {model, effort, ...otherChoices} = state.sessionsChoices[session.id] || {};
    if(session.executionOwner==='desktop')delete otherChoices.permission;
    state.sessionsChoices[session.id] = otherChoices;
    closeComposerPopovers();
  }
  restoreDraft(session?.id || null);connectionStatus();
  contextTools?.render();
  renderQueuedInputs(session);
  const choices = choicesFor();
  // Main controls share the same implementation as the new-task selectors.
  renderSelectors('', deviceId, choices);
  renderComposerSettings(deviceId, session, choices);
  renderSelectors('new', $('newTaskDevice').value || deviceId, { model:$('newModelSelect').value || '', effort:$('newEffortSelect').value || '', permission:$('newPermissionSelect').value || '' });
  const busy = ['running','starting','waiting_approval','waiting_input','interrupting'].includes(session?.status);
  const draft=drafts.get(session?.id);
  const pending=draft.pending;
  const awaiting=pending && ['queued','dispatched','uncertain','unknown'].includes(pending.state);
  const uploadTasks=imageUploads.list(composerSessionId || '$new-task');
  const uploadsBlocked=uploadTasks.some(task=>task.state==='loading' || task.state==='checking' || task.state==='uploading' || task.state==='error' && !task.dataUrl);
  $('sendBtn').disabled = Boolean(state.restoringPreview || session?.cachedPreview || !session || !device(deviceId)?.online || state.sending || state.uploading > 0 || uploadsBlocked || state.connection!=='connected' || awaiting);
  $('attachBtn').disabled = state.uploading > 0;
  $('sendBtn').title = busy ? '加入待发送消息' : '发送';
  $('sendBtn').setAttribute('aria-label',$('sendBtn').title);
  $('promptInput').placeholder=busy ? (isMobileLayout() ? '继续说，可引导…' : '写下一条消息，发送后可选择引导…') : '与 Codex 协作…';
  syncHtml($('attachmentTray'), state.attachments.map(image => `<div class="attachment-preview" data-node-key="${escapeHtml(image.id)}"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name)}"><small>已上传，待发送</small><button type="button" data-remove-attachment="${escapeHtml(image.id)}" aria-label="移除 ${escapeHtml(image.name)}">×</button></div>`).join('') + uploadTasks.map(task=>`<div class="upload-task" role="status" data-node-key="upload-${escapeHtml(task.id)}">${task.dataUrl ? `<img src="${escapeHtml(task.dataUrl)}" alt="${escapeHtml(task.name)}">` : ''}<span>${escapeHtml(task.name)}</span><small>${escapeHtml(task.state==='selected' ? '本地图片，发送时上传' : task.state==='loading' ? '正在本地检查图片…' : task.state==='uploading' ? '正在上传图片…' : task.state==='checking' ? '正在核对上传结果…' : task.error)}</small>${['selected','error'].includes(task.state) ? `<button class="link-btn" type="button" data-remove-upload="${escapeHtml(task.id)}">移除</button>` : ''}</div>`).join(''));
  $('attachmentTray').querySelectorAll('[data-remove-attachment]').forEach(button => button.onclick = () => { state.attachments = state.attachments.filter(image => image.id !== button.dataset.removeAttachment);saveDraft(); renderComposer(); });
  $('attachmentTray').querySelectorAll('[data-remove-upload]').forEach(button=>button.onclick=()=>imageUploads.remove(button.dataset.removeUpload));
  const label=pending?.state==='uncertain' ? '发送结果待确认。输入已保留，请先核对最新对话。' : awaiting ? '正在确认发送结果，输入已保留…' : '';
  $('sendStatus').textContent=label;$('sendStatusActions').classList.toggle('hidden',!awaiting);
  $('releaseSendBtn').classList.toggle('hidden',pending?.state!=='uncertain');
}
function renderComposerSettings(deviceId, session, choices) {
  const catalog = state.catalogs.get(deviceId);
  const settings = effectiveSettings(catalog, session || {}, choices, {nativeFast:Boolean(device(deviceId)?.nativeDesktop?.connected)});
  const name = settings.model?.displayName?.replace(/-(Sol|Astra|Luna|Terra)$/, ' $1') || choices.model || '正在读取模型…';
  const desktop=session?.executionOwner==='desktop';
  const permissionEditable=!desktop || Boolean(device(deviceId)?.nativeDesktop?.connected);
  $('permissionLabel').textContent = desktop ? `${settings.permissionPending ? '下次' : '桌面'} · ${settings.permissionLabel}` : settings.permissionLabel;
  $('permissionBtn').title = desktop ? permissionEditable ? '选择下一条新回合使用的权限，当前运行中的回合不变' : '当前连接暂不支持从网页切换权限' : '选择权限';
  $('permissionBtn').disabled = !catalog;
  $('modelBtn').disabled = !catalog;
  $('modelTriggerLabel').textContent=composerModelLabel(settings);
  $('modelBtn').title = composerModelLabel(settings);
  $('fastIndicator').classList.toggle('hidden',!settings.fast);
  $('fastModeBtn').setAttribute('aria-pressed',String(settings.fast));
  $('fastModeBtn').disabled=!settings.fastAvailable || settings.fastReadOnly;
  $('fastNativeNote').classList.toggle('hidden',!settings.fastReadOnly);
  const speed=settings.fastTier?.description?.match(/([\d.]+)x speed/i)?.[1];
  const fastHint=settings.fastReadOnly ? '桌面原生连接未接通，请恢复连接后切换 Fast' : !settings.fastAvailable ? '当前模型不支持 Fast 模式' : `${speed ? speed + ' 倍速度 · ' : ''}用量更多 · ${settings.fast ? '点击关闭 Fast' : '点击开启 Fast'} · 仅当前对话，下一条新回合生效${settings.fastPending ? '（待生效）' : ''}`;
  $('fastModeHint').textContent=fastHint; $('fastModeBtn').title=fastHint;
  $('strengthLabel').textContent = effortLabels[settings.effort] || '默认强度';
  $('modelLabel').textContent = name;
  const slider = $('effortSlider');
  slider.max = String(Math.max(0, settings.efforts.length - 1));
  slider.value = String(settings.effortIndex);
  slider.disabled = settings.efforts.length < 2;
  slider.setAttribute('aria-valuetext', effortLabels[settings.effort] || '默认强度');
  slider.style.setProperty('--effort-fill', `${settings.efforts.length > 1 ? settings.effortIndex / (settings.efforts.length - 1) * 100 : 0}%`);
  syncHtml($('effortDots'), settings.efforts.map(() => '<i></i>').join(''));
  syncHtml($('modelOptions'), selectableModels(catalog || {}).map(model => `<button type="button" role="menuitemradio" aria-checked="${settings.model?.model === model.model}" data-model="${escapeHtml(model.model)}"><span>${escapeHtml((model.displayName || model.model).replace(/-(Sol|Astra|Luna|Terra)$/, ' $1'))}</span><span aria-hidden="true">${settings.model?.model === model.model ? '✓' : ''}</span></button>`).join(''));
  $('modelOptions').querySelectorAll('[data-model]').forEach(button => button.onclick = () => {
    const model = catalog.models.find(item => item.model === button.dataset.model);
    renderSelectors('', deviceId, { ...choicesFor(), model:model.model, effort:model.defaultReasoningEffort || model.supportedReasoningEfforts?.[0]?.reasoningEffort || '' });
    const previous=state.sessionsChoices[settingsKey()];
    if (previous?.serviceTier && previous.serviceTier !== 'default' && !model.serviceTiers?.some(tier=>tier.id === previous.serviceTier)) previous.serviceTier='default';
    saveChoices(); showModelList(false); renderComposer(); $('modelListBtn').focus();
  });
  const currentPermission=effectiveSettings(catalog,session || {},{}).permissionLabel;
  const permissionNote=desktop ? `<p class="permission-note">当前：${escapeHtml(currentPermission)}。${permissionEditable ? '选择后随下一条新回合生效，正在运行的回合不变。' : '当前连接暂不支持从网页切换权限，请先恢复桌面原生连接。'}</p>` : '';
  syncHtml($('permissionMenu'), permissionNote+`<button type="button" role="menuitemradio" aria-checked="${!choices.permission}" data-permission=""><span>沿用当前权限</span><small>${escapeHtml(currentPermission)}</small></button>` + (catalog?.permissions || []).map(mode => `<button type="button" role="menuitemradio" aria-checked="${choices.permission === mode.id}" data-permission="${escapeHtml(mode.id)}"><span>${escapeHtml(mode.label)}</span><small>${escapeHtml(({ 'read-only':'查看文件，需要修改时请求批准', 'workspace-write':'可编辑项目文件，额外访问请求批准', 'danger-full-access':'允许文件、命令与网络访问' })[mode.id] || '')}</small></button>`).join(''));
  $('permissionMenu').querySelectorAll('[data-permission]').forEach(button => { button.disabled=Boolean(!permissionEditable && button.dataset.permission && button.dataset.permission !== session.nativePermission); button.onclick = () => { $('permissionSelect').value = button.dataset.permission; saveChoices(); closeComposerPopovers(); renderComposer(); $('permissionBtn').focus(); }; });
  renderUsage();
}
function showModelList(show) {
  $('strengthPanel').classList.toggle('hidden', show); $('modelPanel').classList.toggle('hidden', !show);
  $('modelListBtn').setAttribute('aria-expanded', String(show));
}
function closeComposerPopovers() {
  $('modelPopover').classList.add('hidden'); $('permissionMenu').classList.add('hidden');
  $('modelBtn').setAttribute('aria-expanded', 'false'); $('permissionBtn').setAttribute('aria-expanded', 'false');
}
function toggleComposerPopover(kind) {
  const panel = $(kind === 'model' ? 'modelPopover' : 'permissionMenu');
  const opening = panel.classList.contains('hidden'); closeComposerPopovers();
  if (!opening) return;
  panel.classList.remove('hidden'); $(kind === 'model' ? 'modelBtn' : 'permissionBtn').setAttribute('aria-expanded', 'true');
  if (kind === 'model') { showModelList(false); $('effortSlider').focus(); }
  else panel.querySelector('button[aria-checked="true"]')?.focus();
}
function saveChoices() {
  const session=activeSession(), key=session?.id || settingsKey();
  state.sessionsChoices[key] = { ...state.sessionsChoices[key], model:$('modelSelect').value, effort:$('effortSelect').value, permission:$('permissionSelect').value };
  // Fast is a conversation setting. Never retain a stale device-wide Fast flag.
  if (!session) {
    const deviceKey=`device:${state.selectedDeviceId}`;
    if (Object.hasOwn(state.sessionsChoices[deviceKey] || {},'serviceTier')) delete state.sessionsChoices[deviceKey].serviceTier;
  }
  try { localStorage.setItem('codex-relay-send-options', JSON.stringify(state.sessionsChoices)); } catch { /* session still works */ }
}
async function addImages(files) {
  $('composeError').textContent = '';saveDraft();const scope=composerSessionId || '$new-task';
  try {
    for (const file of files) {
      await imageUploads.add(scope,file,activeSession()?.deviceId || state.selectedDeviceId);
    }
  } catch (error) { $('composeError').textContent = error.message; }
  finally { $('imageInput').value = ''; renderComposer(); }
}
async function openProjects() {
  projectSorter?.cancel();projectSaving=false;
  closeMobileNavigation();
  const request=++projectManagerRequest,deviceId=state.selectedDeviceId;projectManager=null;
  $('projectModal').classList.remove('hidden'); $('projectError').textContent = '';$('projectSortStatus').textContent='';$('projectChoices').inert=false;
  $('saveProjectsBtn').disabled=true;syncHtml($('projectChoices'),'<p class="muted">正在读取项目…</p>');
  try {
    const { projects } = await api('/api/projects'); state.projects = projects;
    if(request!==projectManagerRequest || $('projectModal').classList.contains('hidden'))return;
    projectManager=new ProjectManagement(projects,projectOrder,deviceId);renderProjectManagement();$('saveProjectsBtn').disabled=false;
  } catch (error) { $('projectError').textContent = error.message; }
}
function renderProjectManagement(){
  if(!projectManager)return;
  const rows=projectManager.rows();
  syncHtml($('projectChoices'),rows.map((project,index)=>`<div class="managed-project" role="listitem" data-project-row="${escapeHtml(project.id)}" data-node-key="managed-${escapeHtml(project.id)}"><label class="project-choice"><input type="checkbox" data-project-enabled="${escapeHtml(project.id)}"${projectManager.enabled.has(project.id) ? ' checked' : ''}><span><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.cwd)} · ${project.sessionCount || 0} 条对话</small></span></label><button type="button" class="project-drag-handle" data-project-drag="${escapeHtml(project.id)}" aria-label="调整${escapeHtml(project.name)}顺序，当前第 ${index+1} 位" aria-describedby="projectSortHint" title="拖动排序，也可用上下方向键"><svg width="16" height="22" viewBox="0 0 16 22" fill="currentColor" aria-hidden="true"><circle cx="5" cy="5" r="1.5"/><circle cx="11" cy="5" r="1.5"/><circle cx="5" cy="11" r="1.5"/><circle cx="11" cy="11" r="1.5"/><circle cx="5" cy="17" r="1.5"/><circle cx="11" cy="17" r="1.5"/></svg></button></div>`).join('') || '<p class="muted">这台电脑还没有项目。</p>');
  for(const input of $('projectChoices').querySelectorAll('[data-project-enabled]')){input.checked=projectManager.enabled.has(input.dataset.projectEnabled);input.onchange=()=>projectManager.setEnabled(input.dataset.projectEnabled,input.checked);}
  if(projectSorter && projectSorter.container!==$('projectChoices')){projectSorter.destroy();projectSorter=null;}
  if(!projectSorter)projectSorter=new ProjectSorter({container:$('projectChoices'),
    canStart:()=>Boolean(projectManager) && !projectSaving,
    onBusy:busy=>{if($('saveProjectsBtn'))$('saveProjectsBtn').disabled=busy || projectSaving;},
    onMove:(id,index)=>{
      if(!projectManager?.move(id,index))return;
      const name=projectManager.rows().find(project=>project.id===id)?.name;
      renderProjectManagement();
      if($('projectSortStatus'))$('projectSortStatus').textContent=`${name} 已移至第 ${index+1} 位`;
      [...$('projectChoices').querySelectorAll('[data-project-drag]')].find(handle=>handle.dataset.projectDrag===id)?.focus({preventScroll:true});
    }});
}
function closeProjects(){projectSorter?.cancel();projectManagerRequest++;projectManager=null;$('projectModal').classList.add('hidden');}
async function saveProjects() {
  if(!projectManager)return;
  projectSorter?.cancel();projectSaving=true;$('projectChoices').inert=true;
  const draft=projectManager;
  $('saveProjectsBtn').disabled = true;
  try {
    const hiddenProjects = draft.hiddenProjects();
    const result = await api('/api/projects', { method:'PATCH', body:JSON.stringify({ hiddenProjects }) });
    draft.commit(projectOrder);
    state.restoreSessionId=null;
    applyEvent({ type:'snapshot', devices:state.devices, sessions:result.sessions, projects:result.projects });
    closeProjects();render(); await ensureSessionHistory(activeSession());
  } catch (error) { $('projectError').textContent = error.message; }
  finally { projectSaving=false;$('projectChoices').inert=false;$('saveProjectsBtn').disabled = false; }
}
function openDeviceSettings(){
  const selected=device(state.selectedDeviceId);if(!selected)return;
  closeMobileNavigation();state.deviceSettingsId=selected.id;$('computerNameInput').value=selected.name || '';
  syncHtml($('computerIconTheme'),'<option value="auto">自动识别</option>'+appIconThemes.map(theme=>`<option value="${theme.id}">${theme.name}</option>`).join(''));
  $('computerIconTheme').value=selected.iconTheme||'auto';$('computerIconField').hidden=selected.kind!=='local';
  $('computerIconTheme').disabled=typeof selected.iconTheme!=='string';
  $('computerIconHelp').textContent=typeof selected.iconTheme==='string'?'用于此电脑网址的手机桌面图标。已安装图标可能需要浏览器更新后才变化。':'后台更新后可选择图标样式。';
  $('computerIconTheme').onchange=renderComputerIconPreview;renderComputerIconPreview();
  $('computerIdentity').textContent='当前电脑 · '+(selected.online ? '已连接' : '离线')+' · '+selected.id;
  $('deviceSettingsError').textContent='';$('deviceSettingsModal').classList.remove('hidden');$('computerNameInput').focus();
}
function renderComputerIconPreview(){
  const selected=device(state.deviceSettingsId),choice=$('computerIconTheme').value||'auto';
  const style=choice==='auto'?(selected?.appIconStyle||resolveAppIcon(selected?.name).id):choice;
  $('computerIconPreview').src='/app-icon-'+style+'-icon.svg';
}
async function saveDeviceSettings(event){
  event.preventDefault();$('saveDeviceSettingsBtn').disabled=true;$('deviceSettingsError').textContent='';
  try{const name=validateComputerName($('computerNameInput').value),selected=device(state.deviceSettingsId);const result=await api('/api/devices/'+encodeURIComponent(state.deviceSettingsId)+'/name',{method:'PATCH',body:JSON.stringify({name,...(selected?.kind==='local'&&!$('computerIconTheme').disabled?{iconTheme:$('computerIconTheme').value}:{})})});applyEvent({type:'device',...result.device});renderDevices();$('deviceSettingsModal').classList.add('hidden');}
  catch(error){$('deviceSettingsError').textContent=error.message;}
  finally{$('saveDeviceSettingsBtn').disabled=false;}
}
function renderNewTaskProjects(preferredId = $('newTaskProject').value) {
  const deviceId = $('newTaskDevice').value;
  const projects = projectsForDevice(state.projects, deviceId);
  syncHtml($('newTaskProject'), '<option value="" disabled>选择项目</option>' + projects.map(project => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('') + '<option value="device-default">设备默认目录</option>');
  $('newTaskProject').value = projects.some(project => project.id === preferredId) ? preferredId : projects.length ? '' : 'device-default';
  renderNewTaskDirectory();
}
function renderNewTaskDirectory() {
  const selected = state.projects.find(project => project.id === $('newTaskProject').value);
  const cwd = selected?.cwd || ($('newTaskProject').value === 'device-default' ? device($('newTaskDevice').value)?.cwd : null);
  $('newTaskDirectory').textContent = cwd ? '工作目录：' + cwd : '请选择这次任务所在的项目。';
  renderNewTaskExecution();
}
function renderNewTaskExecution(){
  const native=device($('newTaskDevice').value)?.nativeDesktop;
  $('newTaskExecutionHint').textContent=$('newTaskExecutionMode').value==='runner' ? '独立执行会占用此对话；Codex 桌面同时打开时可能无法编辑。' : native?.connected && native.capabilities?.createThreads ? '手机网页与 Codex 桌面共用执行器，可以继续同一条对话。' : '桌面连接暂未支持双端新建。创建时会提示原因，不会改走独立执行。';
}
function openModal() { closeComposerPopovers(); const pending=drafts.get('$new-task').pending;$('newTaskExecutionMode').value=pending?.body.executionMode || 'desktop';$('newTaskDevice').value=pending?.body.deviceId || activeSession()?.deviceId || state.selectedDeviceId; renderNewTaskProjects(pending?.body.projectId || state.activeProjectId);if(pending){$('newTaskPrompt').value=pending.body.prompt;state.attachments=[...drafts.get('$new-task').attachments];} $('newTaskModal').classList.remove('hidden'); $('newTaskPrompt').focus(); $('modalError').textContent = ''; requestCatalog($('newTaskDevice').value); const choices=pending?.body || choicesFor(); renderSelectors('new', $('newTaskDevice').value, choices); }
function closeModal() { $('newTaskModal').classList.add('hidden'); }

async function createTask() {
  const prompt = $('newTaskPrompt').value.trim(); if (!prompt) return ($('modalError').textContent = '请先输入任务目标。');
  const projectId = $('newTaskProject').value;
  if (!projectId) return ($('modalError').textContent = '请选择项目。');
  const project = projectsForDevice(state.projects, $('newTaskDevice').value).find(item => item.id === projectId);
  const cwd = project?.cwd || (projectId === 'device-default' ? device($('newTaskDevice').value)?.cwd : null);
  if (!cwd) return ($('modalError').textContent = '项目已不可用，请重新选择。');
  state.restoreSessionId=null;
  $('createTaskBtn').disabled = true;
  if($('newTaskExecutionMode').value==='desktop'){
    try{const runtime=await api('/api/runtime');if(runtime.threadOwnershipRevision!==1)throw new Error('该电脑后台尚未加载双端新建修复，请先更新远程服务。');}
    catch(error){$('modalError').textContent=error.message;$('createTaskBtn').disabled=false;return;}
  }
  try { await imageUploads.upload(composerSessionId || '$new-task'); const title = prompt.length > 42 ? `${prompt.slice(0,42)}…` : prompt; const deviceId=$('newTaskDevice').value;const body={deviceId,title,prompt,cwd,executionMode:$('newTaskExecutionMode').value,projectId:project?.id,model:$('newModelSelect').value,effort:$('newEffortSelect').value,permission:$('newPermissionSelect').value,attachments:state.attachments.map(image=>image.id)};const previous=drafts.get('$new-task').pending;const id=previous && JSON.stringify(previous.body)===JSON.stringify(body) ? previous.id : requestId();drafts.set('$new-task',{text:prompt,attachments:[...state.attachments],pending:{id,body}}); const result = await api('/api/sessions', { method:'POST', body:JSON.stringify({...body,requestId:id}) }); drafts.set('$new-task',{text:'',attachments:[]});state.attachments=[];state.sessions=state.sessions.filter(item=>item.id!==result.session.id); state.sessions.unshift(result.session); state.activeSessionId = result.session.id; state.activeProjectId=sessionProjectId(result.session); state.selectedDeviceId = result.session.deviceId; closeModal(); render(); }
  catch (error) { $('modalError').textContent = error.message; }
  finally { $('createTaskBtn').disabled = false; }
}

async function sendTurn() {
  const session = activeSession(); const text = $('promptInput').value.trim();
  const selected=imageUploads.list(session?.id);
  const context=[...(drafts.get(session?.id).context || [])];
  if (!session || (!text && !context.length && !state.attachments.length && !selected.length) || state.sending || $('sendBtn').disabled) return;
  const imageIds=[...state.attachments.map(image=>image.id),...selected.map(task=>task.id)],choices=choicesFor(),target={...session};
  state.sending = true; $('composeError').textContent = ''; renderComposer();
  saveDraft();let draft;
  try {
    await imageUploads.upload(session.id,selected.map(task=>task.id));
    const saved=drafts.get(session.id);
    if(imageIds.some(id=>!saved.attachments.some(image=>image.id===id)))throw new Error('附件已改变，消息尚未发送，请检查后重试。');
    const body={...turnInput(target,text,imageIds,choices),...(context.length ? {context} : {})},previous=saved.pending;
    const id=previous && JSON.stringify(previous.body)===JSON.stringify(body) ? previous.id : requestId();
    saved.pending={id,body,state:'unknown'};drafts.set(session.id,saved);
    draft={text,attachments:saved.attachments.filter(image=>imageIds.includes(image.id))};pendingSends.set(session.id,draft);
    const result=await api(`/api/sessions/${session.id}/turns`, { method:'POST', body:JSON.stringify({ ...body,requestId:id }) });
    if(result.delivery)applyDelivery(result.delivery);await reconcileDelivery(session.id);
  }
  catch (error) {if(draft && error.status && error.status<500)drafts.clearPending(session.id);if(!draft?.confirmed && composerSessionId===session.id)$('composeError').textContent=error.message;if(draft)await reconcileDelivery(session.id);}
  finally { state.sending=false; renderComposer(); }
}

$('newTaskBtn').onclick = () => { closeMobileNavigation(); openModal(); }; $('closeModalBtn').onclick = closeModal; $('cancelTaskBtn').onclick = closeModal; $('createTaskBtn').onclick = createTask; $('sendBtn').onclick = sendTurn;
contextTools=new ContextTools({api,session:activeSession,sessions:()=>state.sessions,drafts,save:saveDraft,render:renderComposer,sync:syncHtml});
setupPerformanceSettings({api,getDevice:()=>device(state.selectedDeviceId),onDevice:item=>applyEvent({type:'device',...item}),closeNavigation:closeMobileNavigation});
setupMaintenance({api,onRecovered:()=>{connectStream();ensureSessionHistory(activeSession());}});
setupSessionSearch();
$('nextPendingSidebar').onclick=$('nextPendingBtn').onclick=openNextPending;
$('exitPendingModeBtn').onclick=()=>{state.pendingMode=false;state.unreadVisit=null;renderPendingNavigation();};
setupTaskNotices();
backgroundNotices=setupBackgroundNotices({api});
$('manageModelsBtn').onclick=openModelManagement;
for(const id of ['closeModelManagementBtn','cancelModelsBtn'])$(id).onclick=()=>$('modelManagementModal').classList.add('hidden');
$('saveModelsBtn').onclick=saveModelManagement;
$('refreshModelsBtn').onclick=refreshModelManagement;
$('composerActivity').onclick = openUsage;
$('usageSpeedSummary').onclick = openUsage;
$('usageOpenBtn').onclick = openUsage;
$('closeUsageBtn').onclick = ()=>$('usageModal').classList.add('hidden');
$('refreshUsageBtn').onclick = refreshUsage;
$('usageModal').onclick = event=>{if(event.target === $('usageModal'))$('usageModal').classList.add('hidden');};
$('historyUsageOpenBtn').onclick = openHistoryUsage;
$('closeHistoryUsageBtn').onclick = ()=>$('historyUsageModal').classList.add('hidden');
$('refreshHistoryUsageBtn').onclick = refreshHistoryPanel;
$('historyUsagePreset').onchange=selectHistoricalPreset;
$('historyUsageStart').value=state.historyUsageFilter.start;$('historyUsageEnd').value=state.historyUsageFilter.end;
$('historyUsageFilters').onsubmit=applyHistoricalDates;
$('historyUsageModal').onclick = event=>{if(event.target === $('historyUsageModal'))$('historyUsageModal').classList.add('hidden');};
$('syncBtn').onclick = async () => { const deviceId = state.selectedDeviceId || 'local'; const button = $('syncBtn'); button.disabled = true; button.textContent = '同步中…'; try { await api(`/api/devices/${encodeURIComponent(deviceId)}/sync`, { method:'POST', body:'{}' }); $('connectionNote').textContent = '正在同步 Codex 线程…'; } catch (error) { $('connectionNote').textContent = error.message; $('connectionNote').style.color = 'var(--red)'; } finally { setTimeout(() => { button.disabled = false; button.textContent = '同步'; }, 1200); } };
$('promptInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !isMobileLayout() && !event.isComposing) { event.preventDefault(); sendTurn(); } });
$('promptInput').addEventListener('input',saveDraft);
$('checkSendBtn').onclick=()=>reconcileDelivery(composerSessionId);
$('releaseSendBtn').onclick=()=>{drafts.clearPending(composerSessionId);pendingSends.delete(composerSessionId);$('composeError').textContent='输入已保留，可重新发送。';renderComposer();};
$('interruptBtn').onclick = async () => { const session = activeSession(); if (!session) return; $('interruptBtn').disabled=true; try {await api(`/api/sessions/${session.id}/interrupt`, { method:'POST', body:JSON.stringify({turnId:session.activeTurnId}) });} catch(error){$('composeError').textContent=error.message;render();} };
$('manageProjectsBtn').onclick = openProjects; $('closeProjectsBtn').onclick = $('cancelProjectsBtn').onclick = closeProjects; $('saveProjectsBtn').onclick = saveProjects;
$('deviceSettingsBtn').onclick=openDeviceSettings;$('deviceSettingsForm').onsubmit=saveDeviceSettings;
for(const id of ['closeDeviceSettingsBtn','cancelDeviceSettingsBtn'])$(id).onclick=()=>$('deviceSettingsModal').classList.add('hidden');
$('modelSelect').onchange = () => { $('effortSelect').value=''; saveChoices(); renderComposer(); };
$('effortSelect').onchange = $('permissionSelect').onchange = saveChoices;
$('newTaskDevice').onchange = () => { requestCatalog($('newTaskDevice').value); renderSelectors('new',$('newTaskDevice').value,{}); renderNewTaskProjects(); };
$('newTaskProject').onchange = renderNewTaskDirectory;
$('modelBtn').onclick = () => toggleComposerPopover('model'); $('permissionBtn').onclick = () => toggleComposerPopover('permission');
$('fastModeBtn').onclick = () => {
  const session=activeSession();
  // Do not turn Fast into a device default while the active conversation is changing.
  if (!session) return;
  const deviceId=session.deviceId;
  const current=effectiveSettings(state.catalogs.get(deviceId),session,choicesFor(session.id),{nativeFast:Boolean(device(deviceId)?.nativeDesktop?.connected)});
  if (!current.fastAvailable || current.fastReadOnly) return;
  const choices={...choicesFor(),model:current.model.model,effort:current.effort,serviceTier:current.fast ? 'default' : current.fastTier.id};
  state.sessionsChoices[session.id]=choices; renderSelectors('',deviceId,choices); saveChoices(); renderComposer();
};
$('modelListBtn').onclick = () => { showModelList(true); $('modelOptions').querySelector('button[aria-checked="true"]')?.focus(); };
$('modelBackBtn').onclick = () => { showModelList(false); $('modelListBtn').focus(); };
$('resetModelBtn').onclick = () => { const deviceId=activeSession()?.deviceId || state.selectedDeviceId; const current=effectiveSettings(state.catalogs.get(deviceId), activeSession() || {}, choicesFor()); renderSelectors('',deviceId,{...choicesFor(), model:current.model?.model || '', effort:current.model?.defaultReasoningEffort || ''}); saveChoices(); renderComposer(); };
$('effortSlider').oninput = event => { const deviceId=activeSession()?.deviceId || state.selectedDeviceId; const current=effectiveSettings(state.catalogs.get(deviceId),activeSession() || {},choicesFor()); const effort=current.efforts[Number(event.target.value)]?.reasoningEffort; if (!current.model || !effort) return; renderSelectors('',deviceId,{...choicesFor(),model:current.model.model,effort}); saveChoices(); renderComposer(); };
document.addEventListener('pointerdown', event => { if (!event.target.closest('.composer-control')) closeComposerPopovers(); });
for (const menu of [$('modelOptions'),$('permissionMenu')]) menu.addEventListener('keydown', event => { const buttons=[...menu.querySelectorAll('button')]; const index=buttons.indexOf(document.activeElement); const next=event.key==='ArrowDown' ? (index+1)%buttons.length : event.key==='ArrowUp' ? (index-1+buttons.length)%buttons.length : event.key==='Home' ? 0 : event.key==='End' ? buttons.length-1 : -1; if (next>=0) { event.preventDefault(); buttons[next]?.focus(); } });
$('newModelSelect').onchange = () => renderSelectors('new',$('newTaskDevice').value,{model:$('newModelSelect').value,permission:$('newPermissionSelect').value});
$('attachBtn').onclick = () => $('imageInput').click(); $('imageInput').onchange = () => addImages([...$('imageInput').files]);
$('promptInput').addEventListener('paste', event => { const files = [...event.clipboardData.items].filter(item=>item.kind==='file' && item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean); if (files.length) { event.preventDefault(); addImages(files); } });
$('composer').addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); $('composer').classList.add('drag-over'); } });
$('composer').addEventListener('dragleave', () => $('composer').classList.remove('drag-over'));
$('composer').addEventListener('drop', event => { event.preventDefault(); $('composer').classList.remove('drag-over'); addImages([...event.dataTransfer.files]); });
window.addEventListener('keydown', event => { if (event.key === 'Escape') { const trigger=!$('modelPopover').classList.contains('hidden') ? $('modelBtn') : !$('permissionMenu').classList.contains('hidden') ? $('permissionBtn') : null; closeComposerPopovers(); trigger?.focus(); closeModal(); $('projectModal').classList.add('hidden'); $('usageModal').classList.add('hidden'); $('historyUsageModal').classList.add('hidden'); $('healthModal').classList.add('hidden'); } });

async function boot() {
  if(!state.resumeAttempted){
    state.resumeAttempted=true;
    try{
      restoredPreview=await Promise.race([resumeCache.read(),new Promise(resolve=>setTimeout(()=>resolve(null),350))]);
      if(restoredPreview?.sessions?.length){
        state.restoringPreview=true;state.sessions=restoredPreview.sessions;
        state.activeSessionId=state.sessions.some(s=>s.id===state.restoreSessionId)?state.restoreSessionId:restoredPreview.activeId;
        if(!activeSession())state.activeSessionId=state.sessions[0].id;
        state.selectedDeviceId=activeSession().deviceId;
        state.devices=[...new Set(state.sessions.map(s=>s.deviceId))].map(id=>({id,name:'执行电脑',online:false,nativeDesktop:{connected:false}}));
        timelineViewport.positions=new Map(Object.entries(restoredPreview.positions || {}));state.activeProjectId=sessionProjectId(activeSession());render();
      }
    }catch{/* Local previews never prevent a normal online launch. */}
  }
  try {
    const initial = await api('/api/bootstrap');
    if (!await checkAccess(initial.access)) { state.accessRequired=true;restoredPreview=null;resumeCache.clear();liveConnection.block();return; }
    state.accessRequired=false;liveConnection.blocked=false;
    const previews=new Map((restoredPreview?.sessions || []).map(s=>[s.id,s]));
    state.devices=initial.devices;state.sessions=initial.sessions.map(session=>{
      const preview=previews.get(session.id);return preview?{...session,events:preview.events,cachedPreview:true,historyLoaded:false,loadedHistoryVersion:null}:session;
    });state.projects=initial.projects;state.restoringPreview=false;restoredPreview=null;restoreReceiptOwners();
    state.usages=new Map((initial.usages || []).map(usage=>[usage.deviceId,usage]));state.historicalUsages=new Map((initial.historicalUsages || []).map(usage=>[usage.deviceId,usage]));
    if (activeSession()) state.restoreSessionId=null; else state.activeSessionId=state.sessions[0]?.id || null;
    state.selectedDeviceId=activeSession()?.deviceId || state.devices[0]?.id || '';
    state.activeProjectId=sessionProjectId(activeSession());render();
    connectStream();for(const item of state.devices)directConnections.ensure(item);ensureSessionHistory(activeSession());requestCatalog(state.selectedDeviceId);historyPreloader.visit(state.activeSessionId);refreshHistoricalUsage();
  }
  catch (error) { $('connectionNote').textContent = error.message; $('connectionNote').style.color = 'var(--red)';connectStream(); }
}
setInterval(()=>{if(!state.accessRequired)for(const item of state.devices)directConnections.ensure(item);},30_000);
setInterval(()=>{if(!state.accessRequired && !document.hidden && navigator.onLine)refreshHistoricalUsage();},60_000);
$('messages').addEventListener('toggle', event => {
  const detail = event.target;
  const key = detail.dataset?.detailKey;
  if (!key || !detail.isConnected) return;
  if (detail.open) state.openDetailKeys.add(key); else state.openDetailKeys.delete(key);
  scheduleRender();
}, true);
$('messages').addEventListener('scroll',maybeMarkSessionRead,{passive:true});
$('messages').addEventListener('click',event=>{
  const imageToggle=event.target.closest('[data-images-toggle]');
  if(imageToggle){toggleImages(imageToggle.dataset.imagesToggle);return;}
  const mediaButton=event.target.closest('[data-media-action]');
  if(mediaButton){const card=mediaButton.closest('[data-media-key]');mediaCards.activate(card.dataset.mediaKey,mediaButton.dataset.mediaAction,card);return;}
  const button=event.target.closest('[data-more-process]');if(!button)return;
  const key=button.dataset.moreProcess;state.processLimits.set(key,(state.processLimits.get(key) || 200)+200);
  while(state.processLimits.size>1000)state.processLimits.delete(state.processLimits.keys().next().value);
  scheduleRender();
});
document.addEventListener('click',maybeMarkSessionRead);
window.addEventListener('focus',maybeMarkSessionRead);
window.addEventListener('keydown',event=>{if(event.key==='Escape')$('modelManagementModal').classList.add('hidden');});
setupAccess(boot);
setupPaneLayout();
function syncViewportHeight() {
  const viewport=window.visualViewport;
  if (isMobileLayout() && viewport) document.documentElement.style.setProperty('--app-height',`${Math.round(viewport.height)}px`);
  else document.documentElement.style.removeProperty('--app-height');
}
window.visualViewport?.addEventListener('resize',syncViewportHeight);
window.addEventListener('resize',()=>{syncViewportHeight();if(!isMobileLayout())closeMobileNavigation();});
document.addEventListener('visibilitychange',()=>{saveDraft();if(!document.hidden && navigator.onLine){resumeStream();maybeMarkSessionRead();historyPreloader.schedule();}});
window.addEventListener('pageshow',event=>{if(event.persisted && navigator.onLine)resumeStream();});
window.addEventListener('online',resumeStream);
window.addEventListener('offline',()=>{saveDraft();liveConnection.offline();});
window.addEventListener('pagehide',saveDraft);
window.addEventListener('pagehide',saveResumePreview);
setInterval(()=>{if(!document.hidden && navigator.onLine)liveConnection.check();},5000);
syncViewportHeight();
latestNavigation=new LatestNavigation($('messages'),$('jumpLatestBtn'));
setupMobileLayout();
setupAppInstall({saveDraft});
$('clearResumeBtn').onclick=async()=>{clearTimeout(resumeSaveTimer);await resumeCache.clear();$('installHint').textContent='已清除本机文字预览。之后使用时会重新保存最近对话。';};
document.addEventListener('visibilitychange',()=>{if(document.hidden)saveResumePreview();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')$('installModal').classList.add('hidden');});
setInterval(refreshProcessingTimes,1000);
setupServiceHealth(api);
setupThreadOwnership({api,session:activeSession});
$('newTaskExecutionMode').onchange=renderNewTaskExecution;
setupConnectors(api);
setupComputerEntries({beforeNavigate:saveDraft,shareAddress:()=>api('/api/phone')});
setupChatGptMode({api:hubApi});
boot();
