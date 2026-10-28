import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectRoot } from './layout.mjs';
import { supervise } from './supervisor.mjs';
import { DeliveryStore, persistentToken } from './reliability.mjs';
import { validateOptions } from './relay-options.mjs';
import {ComposerRequests,goalChange,validatedContext,selectedContextInput} from './composer-context.mjs';
import { decodeImage, imageReferences, mediaReferences } from './media.mjs';
import {serveMedia,serveImageBytes} from './media-http.mjs';
import {htmlReferences,isLocalPreview} from '../public/html-links.js';
import {previewMimes,previewHeaders,interactivePreviewHeaders} from './html-preview.mjs';
import { BrowserAccess, isLocalBrowser } from './browser-access.mjs';
import { sendText } from './http-response.mjs';
import { SessionReadState } from './session-read-state.mjs';
import { contextUsage } from '../public/usage.js';
import { normalizeQuestions, validateQuestionAnswers, questionReplies, questionCallId } from '../public/questions.js';
import {sessionAttention} from '../public/session-attention.js';
import { approvalMethods, approvalChoices, approvalResult, requestKey } from '../public/native-requests.js';
import { rememberDesktopEvent, mergeDesktopHistory, pruneDesktopHistory } from './live-desktop-events.mjs';
import { SseWriter } from './sse-writer.mjs';
import { ServiceHealth } from './service-health.mjs';
import {createNetworkCheck} from './network-check.mjs';
import {validateHiddenModels,preferredModel} from '../public/model-preferences.js';
import {performanceSettings} from '../public/performance-settings.js';
import {Maintenance,maintenanceId} from './maintenance.mjs';
import {editableMessages,messageKey,messageToken} from './message-edit.mjs';
import {ConnectorAccess} from './connector-access.mjs';
import {readRelease} from './connector-release.mjs';
import {creationMode,usesDesktop} from './thread-ownership.mjs';
import {lanUpdateRequest,updateManifestPath} from './connector-updates.mjs';
import {DeviceGateway,executionPath} from './device-gateway.mjs';
import {applyThreadStatus} from './thread-sync.mjs';
import {rememberDesktopRuntime,applyDesktopRuntime as applyRuntime} from './desktop-runtime.mjs';
import {HistorySync} from './history-sync.mjs';
import {deviceName} from '../public/device-names.js';
import {normalizeUsageRange} from '../public/usage-range.js';
import {AgentTasks} from './agent-tasks.mjs';
import {agentTasksHttp} from './agent-tasks-http.mjs';
import {ChatGptRelay} from './chatgpt-relay.mjs';
import {applicationWorker,applicationManifest,applicationIcon,applicationIconStyle} from './app-shell.mjs';
import {appIconTheme} from '../public/app-icon-themes.js';
import {RemoteBrowser} from './remote-browser.mjs';
import {sessionPin,setSessionPinned} from './session-pins.mjs';
import {BackgroundNotifications} from './background-notifications.mjs';
import {LanAccess} from './network-mode.mjs';
import {quotaSummary} from './account-privacy.mjs';

const root = projectRoot;
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 4317);
const defaultCwd = process.env.CODEX_WORKSPACE || root;
const dataDir = process.env.CODEX_RELAY_DATA_DIR || path.join(root, '.relay-data');
const host = process.env.HOST || '127.0.0.1';
const maintenance=new Maintenance({dataDir,port});
const localDeviceId=process.env.CODEX_RELAY_LOCAL_DEVICE_ID || 'local';
const executionNode=process.env.CODEX_RELAY_EXECUTION_NODE==='1';
const remoteProjects=new Map();
const gateway=new DeviceGateway({send:(id,command)=>queueCommand(id,command)});
const relayToken = process.env.CODEX_RELAY_TOKEN || persistentToken(dataDir);
const deliveries = new DeliveryStore(dataDir);
const preferencesPath = path.join(dataDir, 'preferences.json');
const browserAccess = new BrowserAccess(dataDir);
const backgroundNotifications=new BackgroundNotifications({directory:dataDir,subject:()=>browserAccess.externalOrigin()||'https://codex-remote.invalid',ownerActive:owner=>owner==='$local'||browserAccess.listDevices().some(device=>device.id===owner&&device.status==='authorized')});
let notificationBatch=null;
const chatgptRelay = new ChatGptRelay();
const remoteBrowser = new RemoteBrowser({ dataDir });
const agentTasks = new AgentTasks({directory:path.join(dataDir,'agent-runs')});
const connectorAccess = new ConnectorAccess(dataDir,relayToken);
const sessionReadState = new SessionReadState(dataDir);
let preferences = { hiddenProjects: [], hiddenModels: {}, deviceNames:{} };
try { preferences = { ...preferences, ...JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) }; } catch { /* first run */ }
const catalogs = new Map();
const accountUsages = new Map();
const historicalUsages=new Map(),historyUsageRequestedAt=new Map();
const historyRangeRequests=new Map();
const composerRequests=new ComposerRequests({queue:queueCommand});
const composerCatalogs=new Map();
const usageRequestedAt = new Map();
const mediaRequests = new Map();

const devices = new Map();
const sessions = new Map();
const runnerStreams = new Map();
const runnerQueues = new Map();
const ownershipReleases=new Set();
const runnerThreadSignatures = new Map();
const pendingApprovals = new Map();
const pendingQuestions = new Map();
const nativeSequences = new Map();
const subscribers = new Map();
const sseWriter = new SseWriter();
const historySync = new HistorySync();
const serviceHealth = new ServiceHealth({root,dataDir,port,onChange:()=>broadcast('health',healthReport())});
const networkCheck=createNetworkCheck();

function healthReport(){
  const local=devices.get(localDeviceId),native=local?.nativeDesktop;
  return {networkCheckRevision:1,checkedAt:serviceHealth.checkedAt || null,checking:Boolean(serviceHealth.busy),
    relay:{state:'ready',message:'Relay 后台运行正常'},
    runner:{state:local?.online ? 'ready' : 'offline',message:local?.online ? 'Runner 已连接' : local?.runtime==='restarting' ? 'Runner 正在自动恢复' : '等待 Runner 连接'},
    desktop:{state:local?.online && native?.connected ? 'ready' : fs.existsSync(path.join(dataDir,'native-desktop-required.json')) ? 'offline' : 'disabled',message:local?.online && native?.connected ? '桌面原生连接正常' : '需要从原生入口打开 Codex 桌面'},
    ...serviceHealth.report,
    resources:{browserConnections:subscribers.size,bufferedBytes:[...subscribers.keys(),...runnerStreams.values()].reduce((sum,res)=>sum+(res.writableLength || 0),0),historySync:historySync.stats()}};
}
const MAX_SESSION_EVENTS = 2400;
const MAX_EVENT_TEXT = 80_000;
const MAX_EVENT_OUTPUT = 24_000;

function clipEventText(value, limit) {
  if (value == null) return value;
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}\n…（内容已截断）` : text;
}

function compactLiveEvent(value) {
  if (!value || value.type !== 'codex' || !value.message) return value;
  const message = { ...value.message };
  const params = message.params && { ...message.params };
  const item = params?.item && { ...params.item };
  if (item) {
    for (const key of ['text', 'input', 'command']) if (item[key] != null) item[key] = clipEventText(item[key], MAX_EVENT_TEXT);
    for (const key of ['output', 'aggregatedOutput']) if (item[key] != null) item[key] = clipEventText(item[key], MAX_EVENT_OUTPUT);
    params.item = item;
  }
  if (params?.delta != null) params.delta = clipEventText(params.delta, 12_000);
  if (params) message.params = params;
  return { ...value, message };
}

function addDevice(device) {
  devices.set(device.id, { online: false, capabilities: [], ...device });
  if (!runnerQueues.has(device.id)) runnerQueues.set(device.id, []);
}

addDevice({ id: localDeviceId, name: process.env.CODEX_RELAY_LOCAL_DEVICE_NAME || '本机 Runner', platform: `${process.platform} · 本地`, cwd: defaultCwd, kind: 'local' });
for(const connector of connectorAccess.list())addDevice({id:connector.id,name:connector.name,platform:'Windows · 远程',kind:'remote',runtime:connector.revokedAt ? 'revoked' : 'offline'});
for (const metadata of Object.values(deliveries.data.sessions)) {
  sessions.set(metadata.id,{...metadata,source:metadata.threadId ? 'imported' : metadata.source,hidden:preferences.hiddenProjects.includes(metadata.projectId),events:[],historyVersion:null,historyLoaded:false,historyRequested:false});
  if (!devices.has(metadata.deviceId)) addDevice({id:metadata.deviceId,name:metadata.deviceId,cwd:metadata.cwd,kind:'remote'});
}
for (const receipt of deliveries.queued()) runnerQueues.get(receipt.deviceId)?.push(receipt.command);

function sendJson(res, status, value) {
  return sendText(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function sendError(res, status, message) { return sendJson(res, status, { error: message }); }
async function sendConnectorPackage(res,release){
  release ||= await readRelease(root,dataDir);if(!release)return sendError(res,404,'此电脑尚未发布更新包。');
  const stream=fs.createReadStream(release.path);
  stream.on('error',()=>{if(!res.headersSent)sendError(res,500,'安装包无法读取');else res.destroy();});
  res.writeHead(200,{'content-type':'application/zip','content-length':release.size,'content-disposition':'attachment; filename="CodexRelayConnector-'+release.version+'.zip"','cache-control':'no-store'});
  res.on('close',()=>stream.destroy());stream.pipe(res);
}

function isRunnerAuthorized(req,deviceId) {
  const token=req.headers['x-codex-relay-token'] || req.headers.authorization?.replace(/^Bearer /,'');
  return token===relayToken || connectorAccess.authorized(deviceId,token);
}

function parseBody(req) {
  if(req.relayBody)return req.relayBody;
  return req.relayBody=new Promise((resolve, reject) => {
    // A Chinese character or emoji can span multiple HTTP data chunks.
    req.setEncoding('utf8');
    let text = '', bytes = 0;
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16_000_000) { text = ''; reject(new Error('request body too large')); return; }
      text += chunk;
    });
    req.on('end', () => {
      if (bytes > 16_000_000) return;
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serializeDevice(device) {
  const { id, name, platform, cwd, online, kind, capabilities, runtime, nativeDesktop, connectorVersion,executionRelay } = device;
  const displayName=Object.hasOwn(preferences.deviceNames || {},id)?preferences.deviceNames[id]:name,iconTheme=preferences.deviceIconThemes?.[id]||'auto';
  return { id, name:displayName, iconTheme,appIconStyle:id===localDeviceId?applicationIconStyle(displayName,iconTheme):null, platform, cwd, online, kind, capabilities, runtime, nativeDesktop,desktopThreadCreateRevision:device.desktopThreadCreateRevision || 0,ownershipRevision:device.ownershipRevision || 0, connectorVersion,executionRelay:Boolean(executionRelay),performanceSettings:performanceSettings(executionRelay ? device.performanceSettings : preferences.performance?.[id]) };
}
function renameComputer(id,value,iconTheme){
  const name=deviceName(value),theme=iconTheme==null?null:appIconTheme(iconTheme);
  if(theme!=null&&id!==localDeviceId)throw new Error('请打开对应电脑的独立网址设置桌面图标。');
  preferences.deviceNames={...preferences.deviceNames,[id]:name};
  if(theme!=null)preferences.deviceIconThemes={...preferences.deviceIconThemes,[id]:theme};savePreferences();
  const device=serializeDevice(devices.get(id));broadcast('device',device);return device;
}

function sessionControls(session) {
  const native = devices.get(session.deviceId)?.nativeDesktop;
  const desktop = usesDesktop(session);
  const active = Boolean(session.activeTurnId) && ['running', 'waiting_input', 'waiting_approval'].includes(session.status);
  return { steer: active && (!desktop || Boolean(native?.connected && native.capabilities?.steer)),
    interrupt: active && (!desktop || Boolean(native?.connected && native.capabilities?.interrupt)),
    nativeEvents: Boolean(native?.connected && native.capabilities?.events),
    edit: Boolean(!session.hidden && !session.pendingSend && !session.pendingEdit && !['running','starting','waiting_input','waiting_approval','interrupting'].includes(session.status) && devices.get(session.deviceId)?.online && (!desktop || native?.connected && native.capabilities?.edit)),
    editNeedsRestart: Boolean(desktop && native?.connected && !native.capabilities?.edit) };
}

function catalogFor(deviceId) {
  return {...(catalogs.get(deviceId) || {models:[],permissions:[],pending:true}),hiddenModels:preferences.hiddenModels[deviceId] || []};
}
function savePreferences() {
  fs.mkdirSync(dataDir,{recursive:true});
  const temporary=preferencesPath+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(preferences));fs.renameSync(temporary,preferencesPath);
}

function serializeSession(session, includeEvents = true) {
  if(session.relayMetadata)return {...session.relayMetadata,...sessionPin(preferences,session.id)};
  const result = {
    id: session.id,
    ...sessionPin(preferences,session.id),
    title: session.title,
    deviceId: session.deviceId,
    threadId: session.threadId,
    activeTurnId: session.activeTurnId || null,
    pendingAttention: sessionAttention(session).filter(item=>item.kind==='question').concat([...pendingApprovals.values()].filter(item=>item.sessionId===session.id).map(item=>({id:item.key,kind:'approval',turnId:item.params?.turnId || null}))),
    controls: sessionControls(session),
    queuedInputs:session.queuedInputs || [],
    editableMessages:editableMessages(session),
    editRecovery:session.editRecovery || null,
    historyLoaded: Boolean(session.historyLoaded),
    historyLimit: session.historyLimit || null,
    cwd: session.cwd,
    projectId: session.projectId || null,
    projectName: session.projectName || null,
    projectCwd: session.projectCwd || session.cwd || null,
    model: session.model,
    effort: session.effort || null,
    nativeModel: session.nativeModel || null,
    nativeEffort: session.nativeEffort || null,
    nativeSettingsAt: session.nativeSettingsAt || null,
    tokenUsage:session.tokenUsage || null,
    ...sessionReadState.status(session.id),
    permission: session.permission || null,
    nativePermission: session.nativePermission || null,
    serviceTier:session.serviceTier || null,
    nativeServiceTier:session.nativeServiceTier || 'default',
    executionOwner: session.executionOwner || (session.source === 'imported' ? 'external' : 'runner'),executionMode:session.executionMode || null,
    hidden: Boolean(session.hidden),
    archived: Boolean(session.archived),
    status: session.status,
    source: session.source || 'relay',
    threadStatus: session.threadStatus || null,
    messageCount: Number.isFinite(session.messageCount) ? session.messageCount : null,
    turnCount: session.turnCount || null,
    historyVersion: session.historyVersion || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt || session.createdAt
  };
  if (includeEvents) result.events = session.events || [];
  return result;
}

function writeSse(res, event, value) {
  return sseWriter.send(res,event,value);
}

function broadcast(event, value) {
  if((event==='session'||event==='snapshot')&&!notificationBatch){notificationBatch=setTimeout(()=>{notificationBatch=null;try{backgroundNotifications.observe(visibleSessions());}catch{}},150);notificationBatch.unref?.();}
  removeUnauthorizedSubscribers();
  for (const res of subscribers.keys()) {
    if(!writeSse(res,event,value))subscribers.delete(res);
  }
  if(event==='device')publishHealth();
}

let lastHealthSignature='';
function publishHealth(){
  const report=healthReport(),signature=JSON.stringify({...report,checkedAt:null,resources:null});
  if(signature===lastHealthSignature)return;
  lastHealthSignature=signature;broadcast('health',report);
}

function removeUnauthorizedSubscribers() {
  for(const [res,req] of subscribers)if(!browserAccess.authorized(req,{touch:false})){
    subscribers.delete(res);
    try {writeSse(res,'access_revoked',{message:'此浏览器的授权已撤销或过期，请重新配对。'});res.end();} catch {res.destroy();}
  }
}

function record(session, value) {
  let event = value;
  if (session) {
    event = compactLiveEvent(value);
    if (!session.events) session.events = [];
    session.events.push(event);
    if (session.events.length > MAX_SESSION_EVENTS) session.events.splice(0, session.events.length - MAX_SESSION_EVENTS);
  }
  broadcast('relay', event);
}

function queueCommand(deviceId, command) {
  const stream = runnerStreams.get(deviceId);
  if (stream && !stream.destroyed && !stream.writableEnded) {
    if(writeSse(stream,'command',command)){
      if(command.deliveryId)deliveries.update(command.deliveryId,'dispatched');
    }else{runnerStreams.delete(deviceId);runnerQueues.get(deviceId)?.push(command);}
  }
  else runnerQueues.get(deviceId)?.push(command);
}

function flushQueue(deviceId, res) {
  const queue = runnerQueues.get(deviceId) || [];
  runnerQueues.set(deviceId, []);
  for (const command of queue) queueCommand(deviceId,command);
}

function findSession(deviceId, sessionId, message) {
  if (sessionId && sessions.get(sessionId)?.deviceId===deviceId) return sessions.get(sessionId);
  const threadId = message?.params?.threadId || message?.result?.thread?.id;
  if (!threadId) return null;
  return [...sessions.values()].find(session => session.deviceId === deviceId && session.threadId === threadId) || null;
}

function importedSessionId(deviceId, threadId) { return `thread-${deviceId}-${threadId}`; }

function projectFor(deviceId, cwd) {
  const normalized = String(cwd || defaultCwd).replace(/[\\/]+$/, '') || defaultCwd;
  const name = normalized.split(/[\\/]/).filter(Boolean).at(-1) || '未命名项目';
  return { id: `project-${deviceId}:${normalized.toLowerCase()}`, name, cwd: normalized };
}

function threadStatus(thread) {
  const type = thread.status?.type;
  if (type === 'active') return 'running';
  if (type === 'systemError') return 'failed';
  if (type === 'idle') return 'done';
  return 'synced';
}

function threadTitle(thread) {
  const title = thread.name || thread.preview || '';
  return title.trim() || `Codex 线程 ${String(thread.id).slice(0, 8)}`;
}

function publishSession(session) { sessionReadState.observe(session); deliveries.sessionChanged(session); if (!session.hidden) broadcast('session', serializeSession(session, false)); }
function deliveryResult(receipt) { return {id:receipt.id,sessionId:receipt.sessionId,state:receipt.state,error:receipt.error || null,...(receipt.scope?.startsWith('queued:') ? {response:receipt.response} : {})}; }
function updateDelivery(session,state,error=null) {
  deliveries.forSession(session.id,state,error);
  for(const item of [...(session.queuedInputs || [])]) {
    if(!['dispatching','uncertain'].includes(item.state))continue;
    const receipt=deliveries.get(item.deliveryId || item.id);
    if(receipt?.state==='accepted') {
      const turnId=item.mode==='steer' ? item.expectedTurnId : session.activeTurnId;
      if(!(session.events || []).some(event=>event.type==='user_message' && event.text===item.text && event.at>=item.dispatchedAt && (!turnId || event.turnId===turnId)))
        record(session,{type:'user_message',id:item.id,sessionId:session.id,turnId,text:item.text,images:item.attachments,at:item.dispatchedAt});
      session.queuedInputs=session.queuedInputs.filter(value=>value.id!==item.id);
    } else if(receipt?.state==='failed') {item.state='waiting';item.error=receipt.error;item.autoBlocked=true;item.revision++;}
    else if(receipt?.state==='uncertain') {item.state='uncertain';item.error=receipt.error;}
  }
  for (const receipt of Object.values(deliveries.data.requests)) if(receipt.sessionId===session.id) broadcast('delivery',deliveryResult(receipt));
}

function dispatchQueuedInput(session,item,mode,check=null) {
  if(session.pendingSend || session.pendingEdit || session.hidden || !devices.get(session.deviceId)?.online)throw new Error('当前暂时无法发送，消息仍保留在待发送列表。');
  const busy=['running','starting','waiting_input','waiting_approval','interrupting'].includes(session.status);
  if(mode==='steer' ? !sessionControls(session).steer : busy)throw new Error(mode==='steer' ? '当前回合已结束，请改为发送。' : '当前回合仍在运行，可以使用引导。');
  const desktop=usesDesktop(session);
  if(desktop && !devices.get(session.deviceId)?.nativeDesktop?.connected)throw new Error('桌面连接尚未恢复，消息仍保留在待发送列表。');
  if(mode!=='steer')Object.assign(session,sessionOptions(item.options,session,session.deviceId));
  const deliveryId=check?.id || item.id;
  const command={...turnCommand(session,item.text,item.attachments,item.context),deliveryId,...(mode==='steer' ? {mode,expectedTurnId:session.activeTurnId} : {queuedStart:true}),...(desktop ? {executionOwner:'desktop'} : {})};
  if(mode==='steer')for(const key of ['model','effort','permission','serviceTier'])delete command[key];
  Object.assign(item,{state:'dispatching',deliveryId,mode,expectedTurnId:session.activeTurnId,dispatchedAt:Date.now(),error:null});
  session.pendingSend={at:item.dispatchedAt,previousTurnId:session.turns?.at(-1)?.id};
  if(mode!=='steer')session.status='starting';
  if(check) {deliveries.add(check,session,{queued:true},command);deliveries.update(item.id,'consumed');}
  else {deliveries.dispatch(item.id,command);deliveries.sessionChanged(session);}
  queueCommand(session.deviceId,command);publishSession(session);
}
function releaseQueuedInput(session) {
  const item=session.queuedInputs?.[0];
  if(!item || item.state!=='waiting' || item.autoBlocked || session.status!=='done' || session.pendingSend || session.pendingEdit || session.editRecovery || session.hidden || !devices.get(session.deviceId)?.online)return;
  try {dispatchQueuedInput(session,item,'start');} catch {/* A reconnect or another Desktop turn can delay delivery. */}
}

function updateQuestion(session, itemId, patch) {
  session.questionResponses ||= new Map();
  const confirmed=session.questionResponses.get(itemId)?.answerState==='answered'
    || session.questionItems?.get(itemId)?.answerState==='answered'
    || session.events.some(event=>event.message?.params?.item?.id===itemId && event.message.params.item.answerState==='answered');
  if(confirmed && patch.answerState==='sent')patch={...patch,answerState:'answered'};
  session.questionResponses.set(itemId,{...session.questionResponses.get(itemId),...patch});
  for (const event of session.events) {
    const item=event.message?.params?.item;
    if (item?.id === itemId && item.questions?.length) Object.assign(item,patch);
  }
  const definition=session.questionItems?.get(itemId);
  if (definition) Object.assign(definition,patch);
  const live=session.liveItems?.get(itemId)?.message.params.item;
  if(live?.questions?.length)Object.assign(live,patch);
  record(session,{type:'question_updated',sessionId:session.id,itemId,patch,at:Date.now()});
  publishSession(session);
}

function projectCatalog() {
  const projects = new Map();
  for (const session of sessions.values()) {
    if(session.relayMetadata || session.archived)continue;
    const project = projectFor(session.deviceId, session.cwd);
    if (!projects.has(project.id)) projects.set(project.id, { ...project, deviceId: session.deviceId, sessionCount: 0, hidden: preferences.hiddenProjects.includes(project.id) });
    projects.get(project.id).sessionCount++;
  }
  return [...projects.values(),...[...remoteProjects.values()].flat()].sort((a,b) => a.name.localeCompare(b.name));
}
function visibleSessions() { return [...sessions.values()].filter(session => !session.hidden).map(session => serializeSession(session, false)); }
function updateProjectSubscriptions(deviceId) {
  const hiddenCwds = projectCatalog().filter(project => project.deviceId === deviceId && project.hidden).map(project => project.cwd);
  const threadIds = [...sessions.values()].filter(session => session.deviceId === deviceId && !session.hidden && session.threadId).map(session => session.threadId);
  queueCommand(deviceId, { type: 'projectSubscriptions', hiddenCwds, threadIds });
}
function sessionOptions(body, session, deviceId) {
  const selected = validateOptions(body, catalogs.get(deviceId) || {});
  const desktop=usesDesktop(session);
  if (session?.executionOwner==='desktop' && selected.permission && selected.permission !== session.nativePermission && !devices.get(deviceId)?.nativeDesktop?.connected) throw new Error('桌面原生连接暂不可用，权限未更改，请恢复连接后重试。');
  if (desktop && selected.serviceTier && selected.serviceTier !== (session.nativeServiceTier || 'default') && !devices.get(deviceId)?.nativeDesktop?.connected) throw new Error('桌面原生连接暂不可用，Fast 未更改，请恢复连接后重试。');
  return { model: selected.model || session?.model || (preferences.hiddenModels[deviceId]?.length ? preferredModel(catalogFor(deviceId))?.model : undefined),
    effort: selected.effort || (selected.model && selected.model !== session?.model ? undefined : session?.effort),
    serviceTier:desktop ? selected.serviceTier : selected.serviceTier || (selected.model && selected.model !== session?.model ? undefined : session?.serviceTier),
    // No override follows the live Desktop setting instead of replaying a stale snapshot.
    permission: desktop ? selected.permission : Object.hasOwn(body, 'permission') && !body.permission ? undefined : selected.permission || session?.permission };
}
function attachmentsFor(body) {
  if (!Array.isArray(body.attachments)) return [];
  if (body.attachments.length > 5) throw new Error('每次最多发送 5 张图片。');
  return body.attachments.map(id => {
    if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error('无效的附件。');
    const file = path.join(dataDir, 'uploads', id + '.json');
    const image = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { id, name: image.name, url: uploadUrl(id) };
  });
}
function uploadUrl(id){return executionNode ? '/api/devices/'+encodeURIComponent(localDeviceId)+'/uploads/'+id : '/api/uploads/'+id;}
function turnCommand(session, text, attachments = [], context = []) {
  return { type: 'startTurn', sessionId: session.id, threadId: session.threadId, cwd: session.cwd, model: session.model, effort: session.effort, permission: session.permission, serviceTier:session.serviceTier,
    text, input: [...(context.length ? selectedContextInput(text,context,sessions) : text ? [{ type: 'text', text }] : []), ...attachments.map(image => ({ type: 'image', uploadId: image.id }))] };
}

function textFromUserItem(item) {
  if (item.text) return item.text;
  return (item.content || []).map(part => part.text || '').join('').trim();
}

function textFromTurnInput(turn) {
  const input = turn?.input;
  if (typeof input === 'string') return input.trim();
  const parts = Array.isArray(input) ? input : input ? [input] : [];
  return parts.map(part => {
    if (typeof part === 'string') return part;
    if (part?.text) return part.text;
    if (part?.content) return textFromUserItem(part);
    return '';
  }).join('').trim();
}

function importThreadHistory(session, thread) {
  if (!thread || !session) return;
  session.threadId = thread.id || session.threadId;
  session.cwd = thread.cwd || session.cwd;
  const project = projectFor(session.deviceId, session.cwd);
  session.projectId = project.id; session.projectName = project.name; session.projectCwd = project.cwd;
  session.threadStatus = thread.status?.type || null;
  const allTurns = Array.isArray(thread.turns) ? thread.turns : [];
  const selected = session.historyLimit === 'all' ? allTurns : allTurns.slice(-(Number(session.historyLimit) || 5));
  const turns = selected.map(turn => ({ id: turn.id, status: turn.status || 'completed', startedAt: (turn.startedAt || thread.createdAt || 0) * 1000, completedAt: (turn.completedAt || 0) * 1000, itemCount: (turn.items || []).filter(item => item.type !== 'reasoning').length,
    ...(turn.error ? { alert:{ message:typeof turn.error === 'string' ? turn.error : turn.error.message || 'Codex 返回错误', retrying:false } } : {}) }));
  const items = [];
  for (const turn of selected) {
    const at = (turn.startedAt || thread.updatedAt || thread.createdAt || 0) * 1000;
    let hasUser = false;
    for (const [index, raw] of (turn.items || []).entries()) {
      if (raw.type === 'reasoning') continue;
      if (raw.type === 'userMessage') {
        const text = textFromUserItem(raw);
        const images = raw.images || imageReferences(text, raw.content).map(ref => ({ ref }));
        if (text || images.length) { items.push({ ...raw, id: raw.id || turn.id + '-user', role: 'user', text, images, turnId: turn.id, at: at + index }); hasUser = true; }
      } else items.push({ ...raw, id: raw.id || turn.id + '-' + index, role: ['agentMessage', 'assistantMessage'].includes(raw.type) ? 'assistant' : 'process', kind: raw.type, turnId: turn.id, at: at + index });
    }
    if (!hasUser) {
      const text = textFromTurnInput(turn);
      if (text) items.push({ id: turn.id + '-user', role: 'user', text, turnId: turn.id, at });
    }
  }
  importRolloutHistory(session, { items, turns, turnCount: allTurns.length, messageCount: allTurns.reduce((sum, turn) => sum + (turn.items || []).filter(item => item.type !== 'reasoning').length, 0) });
}

function importRolloutHistory(session, history) {
  if (!session) return;
  if(history.historyRevision != null && history.historyRevision !== (session.historyRevision || 0)) return;
  if(session.editExcludedTurns?.some(id=>history.turns?.some(turn=>turn.id===id))) {session.historyRequested=false;return;}
  if(history.authoritative && Array.isArray(history.visibleTurnIds))pruneDesktopHistory(session,history.visibleTurnIds,history.observedAt);
  const previousUsage = JSON.stringify(session.tokenUsage || null);
  if (history.tokenUsage && history.tokenUsage.updatedAt >= (session.tokenUsage?.updatedAt || 0)) session.tokenUsage = history.tokenUsage;
  const usageChanged = previousUsage !== JSON.stringify(session.tokenUsage || null);
  const permissionChanged = history.settings?.permission && history.settings.permission !== session.nativePermission;
  const previousSettings = JSON.stringify([session.nativeModel, session.nativeEffort, session.nativeSettingsAt, session.nativePermission, session.nativeServiceTier]);
  if (history.settings?.model) session.nativeModel = history.settings.model;
  if (history.settings && Object.hasOwn(history.settings, 'effort')) session.nativeEffort = history.settings.effort || null;
  if (history.settings?.at) session.nativeSettingsAt = history.settings.at;
  if (history.settings?.permission) session.nativePermission = history.settings.permission;
  if (history.settings?.serviceTier) session.nativeServiceTier=history.settings.serviceTier;
  const settingsChanged = previousSettings !== JSON.stringify([session.nativeModel, session.nativeEffort, session.nativeSettingsAt, session.nativePermission, session.nativeServiceTier]);
  const { items = [], messageCount = null, turnCount = history.turns?.length || 0 } = history;
  const turns = (history.turns || []).map(turn => ({...turn}));
  rememberDesktopRuntime(session,history.desktopRuntime);
  session.historyRequested = false;
  const latest = turns.at(-1);
  if (session.pendingSend) {
    if (latest?.startedAt >= session.pendingSend.at - 1000 && latest.id !== session.pendingSend.previousTurnId) { session.pendingSend = null; updateDelivery(session,'accepted'); }
    else if (Object.values(deliveries.data.requests).some(item=>item.sessionId===session.id && item.state==='uncertain')) session.pendingSend=null;
    else { if (permissionChanged || settingsChanged || usageChanged) publishSession(session); return; }
  }
  const incoming = [];
  for (const item of items) {
    const at = item.at || session.createdAt;
    const turnId = item.turnId || item.turn_id || null;
    if (item.role === 'user') incoming.push({ type: 'user_message', id: item.id, sessionId: session.id, turnId, text: item.text, images: item.images || [],attachments:item.attachments || [], at });
    else {
      const { role, kind, ...fields } = item;
      const raw = { ...fields, type: role === 'assistant' ? 'agentMessage' : kind || 'toolCall' };
      if (raw.questions?.length && !raw.questionAnswers) Object.assign(raw,session.questionResponses?.get(raw.id) || {});
      incoming.push({ type: 'codex', sessionId: session.id, deviceId: session.deviceId, turnId, message: { method: 'item/completed', params: { item: raw, threadId: session.threadId, turnId } }, at });
    }
  }
  for (const question of session.questionItems?.values() || []) {
    if (!turns.some(turn=>turn.id === question.turnId)) continue;
    const existing=incoming.find(event=>event.message?.params?.item.id === question.id);
    if (existing) Object.assign(existing.message.params.item,question);
    else incoming.push({type:'codex',sessionId:session.id,deviceId:session.deviceId,message:{method:'item/completed',params:{item:question,threadId:session.threadId,turnId:question.turnId}},at:question.at});
  }
  applyDesktopRuntime(session,turns);
  mergeDesktopHistory(session, incoming, turns);
  incoming.sort((a,b)=>a.at-b.at);
  const version = crypto.createHash('sha256').update(JSON.stringify({ incoming, turns, messageCount, turnCount, nativePermission:session.nativePermission, nativeServiceTier:session.nativeServiceTier })).digest('hex');
  if (session.historyVersion === version) { if (settingsChanged || usageChanged) publishSession(session); return; }
  session.events = [{ type: 'thread_ready', sessionId: session.id, threadId: session.threadId, at: session.createdAt }, ...incoming];
  session.turns = turns;
  session.turnCount = turnCount;
  session.messageCount = messageCount;
  session.historyVersion = version;
  session.historyLoaded = true;
  const current = turns.at(-1);
  if (current) {
    session.status = ({ inProgress: 'running', completed: 'done', failed: 'failed', interrupted: 'interrupted', stopped:'synced' })[current.status] || session.status;
    if (['inProgress', 'running'].includes(current.status)) session.activeTurnId = current.id;
    else if (['completed','failed','interrupted','stopped'].includes(current.status)) session.activeTurnId = null;
  }
  else if (items.length) session.status = 'done';
  else if(history.authoritative && !session.pendingSend){session.status='ready';session.activeTurnId=null;}
  applyDesktopRuntime(session,turns);
  if ([...pendingQuestions.values()].some(request=>request.sessionId === session.id && request.question.isBlocking)) session.status='waiting_input';
  if ([...pendingApprovals.values()].some(request=>request.sessionId === session.id)) session.status='waiting_approval';
  session.updatedAt = Math.max(session.updatedAt || 0, ...items.map(item => item.completedAt || item.at || 0));
  publishSession(session);
  releaseQueuedInput(session);
}

function setSessionArchived(session, archived, at = Date.now()) {
  session.archived = archived;
  session.archiveChangedAt = at;
  session.hidden = archived || preferences.hiddenProjects.includes(session.projectId);
}

function publishSnapshot() {
  broadcast('snapshot', {devices:[...devices.values()].map(serializeDevice),sessions:visibleSessions(),projects:projectCatalog(),usages:[...accountUsages.values()],historicalUsages:[...historicalUsages.values()]});
}

function syncThreadList(deviceId, threads, {complete = false, observedAt = Date.now()} = {}) {
  if (!Array.isArray(threads)) return;
  const list = Array.isArray(threads) ? threads : [];
  const signature = JSON.stringify({complete, threads:list.map(thread => ({
    id: thread?.id || null,
    name: thread?.name || null,
    preview: thread?.preview || null,
    updatedAt: thread?.updatedAt || null,
    createdAt: thread?.createdAt || null,
    status: thread?.status?.type || null,
    cwd: thread?.cwd || null,
    model: thread?.model || null,
    path: thread?.path || null
  }))});
  if (runnerThreadSignatures.get(deviceId) === signature) return;
  runnerThreadSignatures.set(deviceId, signature);
  let visibilityChanged = false;
  const present = new Set(list.map(thread=>thread?.id).filter(Boolean));
  if (complete) for (const session of sessions.values()) {
    if (session.deviceId !== deviceId || !session.threadId || session.archived || present.has(session.threadId)
      || session.archiveChangedAt > observedAt
      || session.source !== 'imported' && !session.listedThread) continue;
    setSessionArchived(session, true, observedAt); visibilityChanged = true;
  }
  const performance=performanceSettings(preferences.performance?.[deviceId]);
  // Project-scoped warming is requested by the browser, which knows its current project.
  const recentHistoryThreads = new Set((performance.preloadEnabled && performance.preloadScope==='all' ? list.filter(thread=>thread?.id && !preferences.hiddenProjects.includes(projectFor(deviceId,thread.cwd || devices.get(deviceId)?.cwd || defaultCwd).id)).slice(0,performance.preloadCount) : []).map(thread=>thread?.id).filter(Boolean));
  list.forEach((thread, index) => {
    if (!thread?.id) return;
    let session = [...sessions.values()].find(item => item.deviceId === deviceId && item.threadId === thread.id);
    if (session?.archiveChangedAt > observedAt) return;
    if (session?.archived) { setSessionArchived(session, false, observedAt); visibilityChanged = true; }
    const previousMetadata = session ? serializeSession(session, false) : null;
    const created = !session;
    const updatedAt = (thread.updatedAt || thread.createdAt || Date.now() / 1000) * 1000;
    let historyChanged = created || !session?.historyLoaded;
    if (!session) {
      const project = projectFor(deviceId, thread.cwd || devices.get(deviceId)?.cwd || defaultCwd);
      session = {
        id: importedSessionId(deviceId, thread.id),
        title: threadTitle(thread),
        deviceId,
        threadId: thread.id,
        cwd: thread.cwd || devices.get(deviceId)?.cwd || defaultCwd,
        projectId: project.id,
        projectName: project.name,
        projectCwd: project.cwd,
        model: thread.model || null,
        status: threadStatus(thread),
        threadStatus: thread.status?.type || null,
        createdAt: (thread.createdAt || Date.now() / 1000) * 1000,
        updatedAt,
        events: [],
        initialPrompt: '',
        source: 'imported',
        threadPath: thread.path || null,
        messageCount: null,
        historyRequested: false,
        historyLoaded: false
      };
      sessions.set(session.id, session);
    } else if (session.source === 'imported') {
      const previousUpdatedAt = session.updatedAt || 0;
      const previousThreadStatus = session.threadStatus || null;
      const project = projectFor(deviceId, thread.cwd || session.cwd);
      session.title = threadTitle(thread);
      session.cwd = thread.cwd || session.cwd;
      session.projectId = project.id; session.projectName = project.name; session.projectCwd = project.cwd;
      if (!session.historyLoaded) session.status = threadStatus(thread);
      session.threadStatus = session.executionOwner==='desktop' && session.desktopRuntime ? session.desktopRuntime.status.type : thread.status?.type || null;
      session.threadPath = thread.path || session.threadPath || null;
      session.updatedAt = Math.max(updatedAt, session.updatedAt || 0);
      const statusChanged = previousThreadStatus !== session.threadStatus;
      historyChanged = updatedAt > previousUpdatedAt || statusChanged;
    }
    session.listedThread = true;
    session.hidden = Boolean(session.archived) || preferences.hiddenProjects.includes(session.projectId);
    const shouldRead = session.source === 'imported' && !session.historyRequested && (!session.historyLoaded || historyChanged) && (recentHistoryThreads.has(thread.id) || thread.status?.type === 'active');
    if (shouldRead && !session.hidden) {
      session.historyRequested = true;
      session.historyLimit ||= performance.historyTurns;
      queueCommand(deviceId, { type: 'readThread', sessionId: session.id, threadId: thread.id, cwd: session.cwd, path: session.threadPath, maxTurns: session.historyLimit,historyRevision:session.historyRevision || 0 });
    }
    const nextMetadata = serializeSession(session, false);
    if (!session.hidden && (created || JSON.stringify(previousMetadata) !== JSON.stringify(nextMetadata))) publishSession(session);
  });
  broadcast('projects', { projects: projectCatalog() });
  updateProjectSubscriptions(deviceId);
  if (visibilityChanged) publishSnapshot();
}

function historyWindow(session){return session.historyLimit || performanceSettings(preferences.performance?.[session.deviceId]).historyTurns;}

function requestSessionHistory(session, force = false, maxTurns = null) {
  if (!session || session.hidden || session.source !== 'imported' || !session.threadId) return false;
  maxTurns ??= historyWindow(session);
  if (session.historyRequested && !force) return false;
  if (session.historyLoaded && !force) return false;
  session.historyRequested = true;
  session.historyLimit = maxTurns === 'all' ? 'all' : Math.max(1, Math.min(500, Number(maxTurns) || 5));
  queueCommand(session.deviceId, { type: 'readThread', sessionId: session.id, threadId: session.threadId, cwd: session.cwd, path: session.threadPath, force, maxTurns: session.historyLimit,historyRevision:session.historyRevision || 0 });
  return true;
}

function applyDesktopRuntime(session,turns) {
  applyRuntime(session,turns);
  if(session.desktopRuntime?.status.type!=='active')return;
  if([...pendingQuestions.values()].some(request=>request.sessionId===session.id && request.question.isBlocking))session.status='waiting_input';
  if([...pendingApprovals.values()].some(request=>request.sessionId===session.id))session.status='waiting_approval';
}

const approvalKey = (deviceId, origin, id) => `${deviceId}:${origin || 'runner'}:${requestKey(id)}`;
function resolveServerRequest(session, requestId, patch = {}) {
  for (const [key, pending] of pendingQuestions) if (pending.sessionId === session.id && requestKey(pending.requestId) === requestKey(requestId)) {
    pendingQuestions.delete(key);
    const answered = pending.answers && (pending.origin !== 'desktop' || pending.submitted);
    updateQuestion(session, pending.question.id, { answerState: answered ? 'answered' : 'resolved', ...(answered ? {questionAnswers:pending.answers} : {}), questionError:null, ...patch });
  }
  for (const [key, pending] of pendingApprovals) if (pending.sessionId === session.id && requestKey(pending.id) === requestKey(requestId)) {
    pendingApprovals.delete(key);
    record(session, {type:'approval_resolved', sessionId:session.id, requestId, approvalKey:pending.key, turnId:pending.params.turnId, at:Date.now()});
  }
  if (['waiting_input','waiting_approval'].includes(session.status)) {
    session.status = [...pendingApprovals.values()].some(pending => pending.sessionId === session.id) ? 'waiting_approval'
      : [...pendingQuestions.values()].some(pending => pending.sessionId === session.id && pending.question.isBlocking) ? 'waiting_input' : 'running';
  }
}

function handleRunnerMessage(deviceId, payload) {
  if(payload.type==='composer_context_reply')return composerRequests.reply(deviceId,payload);
  if(payload.type==='gateway_reply')return gateway.reply(deviceId,payload);
  if(payload.type==='heartbeat'){const device=devices.get(deviceId);if(device)device.lastSeen=Date.now();return;}
  if(payload.type==='device_snapshot'){
    if(!devices.get(deviceId)?.executionRelay)throw new Error('设备尚未启用本地执行服务');
    const snapshot=payload.snapshot;
    if(!snapshot || !Array.isArray(snapshot.sessions) || !Array.isArray(snapshot.projects) || snapshot.sessions.some(item=>item.deviceId!==deviceId || sessions.has(item.id) && sessions.get(item.id).deviceId!==deviceId) || snapshot.projects.some(item=>item.deviceId!==deviceId))throw new Error('设备快照不属于这台电脑');
    for(const [id,session] of sessions)if(session.deviceId===deviceId)sessions.delete(id);
    for(const item of snapshot.sessions)sessions.set(item.id,{...item,relayMetadata:item});
    remoteProjects.set(deviceId,snapshot.projects);
    const info=snapshot.devices?.find(item=>item.id===deviceId);
    if(info)Object.assign(devices.get(deviceId),{nativeDesktop:info.nativeDesktop,capabilities:info.capabilities,cwd:info.cwd});
    for(const usage of snapshot.usages || [])if(usage.deviceId===deviceId)accountUsages.set(deviceId,quotaSummary(usage,deviceId));
    broadcast('snapshot',{devices:[...devices.values()].map(serializeDevice),sessions:visibleSessions(),projects:projectCatalog(),usages:[...accountUsages.values()],historicalUsages:[...historicalUsages.values()]});return;
  }
  if(payload.type==='device_event'){
    if(!devices.get(deviceId)?.executionRelay)throw new Error('设备尚未启用本地执行服务');
    const {eventType,data}=payload;
    if(eventType==='session'){
      if(data?.deviceId!==deviceId || sessions.has(data.id) && sessions.get(data.id).deviceId!==deviceId)throw new Error('对话不属于这台电脑');
      sessions.set(data.id,{...data,relayMetadata:data});broadcast('session',serializeSession(sessions.get(data.id),false));
    }else if(eventType==='device'){
      if(data?.id!==deviceId)throw new Error('设备不匹配');Object.assign(devices.get(deviceId),{nativeDesktop:data.nativeDesktop,capabilities:data.capabilities,cwd:data.cwd,performanceSettings:data.performanceSettings});broadcast('device',serializeDevice(devices.get(deviceId)));
    }else if(eventType==='catalog' || eventType==='account_usage' || eventType==='historical_usage'){
      if(data?.deviceId!==deviceId)throw new Error('设备不匹配');if(eventType==='catalog')catalogs.set(deviceId,data);else if(eventType==='account_usage'){const usage=quotaSummary(data,deviceId);accountUsages.set(deviceId,usage);broadcast(eventType,usage);return;}else historicalUsages.set(deviceId,data);broadcast(eventType,data);
    }else if(eventType==='projects'){
      if(!Array.isArray(data?.projects) || data.projects.some(item=>item.deviceId!==deviceId))throw new Error('设备不匹配');remoteProjects.set(deviceId,data.projects);broadcast('projects',{projects:projectCatalog()});
    }else if(eventType==='relay' || eventType==='delivery'){
      const owner=sessions.get(data?.sessionId)?.deviceId;if(owner!==deviceId)throw new Error('对话不属于这台电脑');broadcast(eventType,data);
    }
    return;
  }
  if(payload.sessionId && sessions.has(payload.sessionId) && sessions.get(payload.sessionId).deviceId!==deviceId)throw new Error('对话不属于这台执行电脑');
  if (payload.type === 'native_status') {
    const device = devices.get(deviceId); if (!device) return;
    device.nativeDesktop = {connected:Boolean(payload.connected),capabilities:payload.capabilities || {}};
    broadcast('device', serializeDevice(device));
    if (payload.connected && Array.isArray(payload.pendingRequests)) {
      for (const pending of [...pendingQuestions.values(),...pendingApprovals.values()]) if (pending.origin === 'desktop' && pending.deviceId === deviceId) {
        const session = sessions.get(pending.sessionId), requestId = pending.requestId ?? pending.id;
        if (session && !payload.pendingRequests.some(request => request.threadId === session.threadId && requestKey(request.requestId) === requestKey(requestId))) resolveServerRequest(session,requestId);
      }
    }
    for (const session of sessions.values()) if (session.deviceId === deviceId && !session.hidden) {
      if(Array.isArray(payload.threadStates)) {
        const state=payload.connected && payload.threadStates.find(state=>state.threadId===session.threadId);
        if(!state)continue;
        const before=JSON.stringify(serializeSession(session,false)),previous=session.desktopRuntime;
        if(!rememberDesktopRuntime(session,state))continue;
        applyDesktopRuntime(session);
        if((session.historyLoaded || state.status.type==='active') && (previous?.status.type!==state.status.type || previous?.turnId!==state.turnId))requestSessionHistory(session,true,historyWindow(session));
        if(before!==JSON.stringify(serializeSession(session,false)))publishSession(session);
        continue;
      }
      const turnId = payload.activeTurns?.[session.threadId];
      const ended = session.turns?.some(turn=>turn.id === turnId && ['completed','failed','interrupted'].includes(turn.status));
      if (turnId && !ended && session.executionOwner !== 'runner') { session.activeTurnId = turnId; session.executionOwner = 'desktop'; if (!['waiting_input','waiting_approval','interrupting'].includes(session.status)) session.status = 'running'; requestSessionHistory(session); }
      else if (!turnId && payload.connected && payload.capabilities?.events && payload.threadIds?.includes(session.threadId) && session.executionOwner === 'desktop') {
        rememberDesktopRuntime(session,{status:{type:'idle'},turnId:null,observedAt:Date.now(),epoch:'legacy-status',revision:0,source:'cache'});
        applyThreadStatus(session, {type:'idle'});
      }
      publishSession(session);
    }
    return;
  }
  if (payload.type === 'native_events') {
    const sequenceKey = `${deviceId}:${payload.epoch}`;
    for (const event of payload.events || []) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= (nativeSequences.get(sequenceKey) || 0)) continue;
      if(event.message?.method==='runner/resyncRequired'){
        const gap=event.message.params;
        for(const threadId of gap.threadIds || []){
          const session=[...sessions.values()].find(value=>value.deviceId===deviceId && value.threadId===threadId && !value.hidden);
          if(!session)continue;
          session.liveResyncIds ||= new Set();
          for(const item of gap.items || [])if(item.threadId===threadId){session.liveResyncIds.add(item.itemId);session.liveItems?.delete(item.itemId);}
          while(session.liveResyncIds.size>2000)session.liveResyncIds.delete(session.liveResyncIds.values().next().value);
          session.liveTurn=null;session.liveNotices?.clear();
          requestSessionHistory(session,true,historyWindow(session));
        }
      }else handleRunnerMessage(deviceId, {message:event.message, origin:'desktop', at:event.at,desktopRuntime:event.desktopRuntime});
      nativeSequences.set(sequenceKey,event.sequence);
    }
    while (nativeSequences.size > 100) nativeSequences.delete(nativeSequences.keys().next().value);
    return;
  }
  if (payload.type === 'account_usage') {
    const previous = accountUsages.get(deviceId);
    const usage = payload.usage || {};
    const next = quotaSummary({...usage, ...(usage.error && !usage.reset && previous?.buckets?.length ? {buckets:previous.buckets,updatedAt:previous.updatedAt} : {})},deviceId);
    if (JSON.stringify(previous) !== JSON.stringify(next)) { accountUsages.set(deviceId,next);broadcast('account_usage',next); }
    return;
  }
  if(payload.type==='historical_usage') {
    const previous=historicalUsages.get(deviceId),usage=payload.usage || {};
    const next={...previous,...usage,deviceId};historicalUsages.set(deviceId,next);broadcast('historical_usage',next);return;
  }
  if(payload.type==='historical_usage_query') {
    const request=historyRangeRequests.get(payload.requestId);
    if(request?.deviceId===deviceId)request.finish(payload);
    return;
  }
  if (payload.type === 'runtime') {
    const device=devices.get(deviceId);if(device){device.runtime=payload.runtime;device.desktopThreadCreateRevision=payload.desktopThreadCreateRevision===1?1:0;device.ownershipRevision=payload.ownershipRevision===1?1:0;broadcast('device',serializeDevice(device));}return;
  }
  if(payload.type==='runner_threads_released'){
    if(!Array.isArray(payload.threadIds) || payload.threadIds.length>200 || payload.threadIds.some(id=>typeof id!=='string'))return;
    const released=new Set(payload.threadIds);
    for(const session of sessions.values())if(session.deviceId===deviceId && released.has(session.threadId)){
      session.executionMode='desktop';session.executionOwner='external';publishSession(session);
    }
    return;
  }
  if (payload.type === 'catalog') {
    catalogs.set(deviceId, payload.catalog);
    broadcast('catalog', { deviceId, ...catalogFor(deviceId) });
    return;
  }
  if (payload.type === 'media') {
    const request = mediaRequests.get(payload.requestId);
    if (request && request.deviceId === deviceId) { mediaRequests.delete(payload.requestId); clearTimeout(request.timer); request.resolve(payload); }
    return;
  }
  if (payload.type === 'thread_list') return syncThreadList(deviceId, payload.threads, payload);
  // Older connected Runners may still send these. Read state belongs to Relay.
  if(payload.type==='desktop_read_state' || payload.message?.method==='runner/readStateSubmitted')return;
  if (payload.type === 'thread_history') {
    const session = sessions.get(payload.sessionId) || [...sessions.values()].find(item => item.deviceId === deviceId && item.threadId === payload.threadId);
    if (session && !session.hidden) return importRolloutHistory(session, payload);
    return;
  }
  const session = findSession(deviceId, payload.sessionId, payload.message);
  const message = payload.message || {};
  if (['thread/archived','thread/unarchived'].includes(message.method)) {
    if (session) setSessionArchived(session, message.method === 'thread/archived', payload.at || Date.now());
    runnerThreadSignatures.delete(deviceId);
    updateProjectSubscriptions(deviceId);
    queueCommand(deviceId, {type:'listThreads'});
    publishSnapshot(); return;
  }
  if (session?.hidden && session.source === 'imported') return;
  if (!session) {
    broadcast('relay', { type: 'runner_message', deviceId, message });
    return;
  }
  if(payload.origin==='desktop') {
    if(message.method==='turn/completed' && session.desktopRuntime?.status.type==='active' && session.desktopRuntime.turnId && session.desktopRuntime.turnId!==message.params.turn.id && !payload.desktopRuntime)return;
    if(!payload.desktopRuntime && ['turn/started','turn/completed','thread/status/changed'].includes(message.method)) {
      const status=message.method==='turn/started' ? {type:'active',activeFlags:[]} : message.method==='turn/completed' ? {type:'idle'} : message.params.status;
      rememberDesktopRuntime(session,{threadId:session.threadId,status,turnId:message.params.turn?.id || session.activeTurnId,observedAt:payload.at || Date.now(),epoch:'desktop-event',revision:(session.desktopRuntime?.revision || 0)+1,source:'event'});
    }
    rememberDesktopRuntime(session,payload.desktopRuntime);
    if(message.method==='turn/completed' && session.desktopRuntime?.status.type==='active' && session.desktopRuntime.turnId && session.desktopRuntime.turnId!==message.params.turn.id)return;
  }
  if(message.method==='thread/reverted') {
    session.historyRevision=(session.historyRevision || 0)+1;
    session.liveItems?.clear();session.liveNotices?.clear();session.liveResyncIds?.clear();session.liveTurn=null;
    for(const pending of [...pendingQuestions.values(),...pendingApprovals.values()]) if(pending.sessionId===session.id)resolveServerRequest(session,pending.requestId ?? pending.id);
    session.questionItems?.clear();session.questionResponses?.clear();session.editExcludedTurns=[];
    session.historyVersion=null;session.activeTurnId=null;
    if(!session.pendingEdit){session.pendingSend=null;session.status='synced';}
    requestSessionHistory(session,true,historyWindow(session));
    publishSession(session);return;
  }
  if (message.method === 'thread/status/changed') {
    if (payload.origin === 'desktop') session.executionOwner = 'desktop';
    applyThreadStatus(session, message.params?.status, payload.at || Date.now());
    applyDesktopRuntime(session);
    if (['idle','notLoaded','systemError'].includes(message.params?.status?.type)) {
      for (const request of [...pendingQuestions.values(),...pendingApprovals.values()]) if (request.sessionId === session.id) resolveServerRequest(session,request.requestId ?? request.id);
      applyThreadStatus(session, message.params.status, payload.at || Date.now());
      applyDesktopRuntime(session);
      requestSessionHistory(session,true,historyWindow(session));
    }
    publishSession(session); return;
  }
  const previousNativeMetadata = payload.origin === 'desktop' ? JSON.stringify(serializeSession(session,false)) : null;
  if (payload.origin === 'desktop') session.executionOwner = 'desktop';
  if (payload.origin === 'desktop' && message.method === 'relay/requestClaimed') {
    for (const pending of [...pendingQuestions.values(),...pendingApprovals.values()]) if (pending.sessionId === session.id && requestKey(pending.requestId ?? pending.id) === requestKey(message.params.requestId)) {
      pending.submitted = message.params.winner === 'relay';
      if (!pending.submitted) pending.answers = null;
    }
    return;
  }
  if (message.method === 'thread/tokenUsage/updated') {
    const usage = contextUsage(message.params?.tokenUsage, Date.now(),{turnId:message.params?.turnId || session.activeTurnId,model:session.nativeModel});
    if (usage && JSON.stringify(session.tokenUsage) !== JSON.stringify(usage)) {session.tokenUsage=usage;publishSession(session);}
    return;
  }
  if (message.result?.model) {
    session.nativeModel = message.result.model;
    session.nativeEffort = message.result.reasoningEffort || session.nativeEffort || null;
    session.nativeSettingsAt = Date.now();
  }
  if (message.method === 'runner/actionError') {
    const params = message.params || {};
    if (params.action === 'steer') { if (!params.ambiguous) session.pendingSend = null; updateDelivery(session, params.ambiguous ? 'uncertain' : 'failed', params.message); }
    if(params.action==='queued') {
      if(!params.ambiguous)session.pendingSend=null;
      session.status=params.retryActive ? 'running' : 'done';
      if(params.activeTurnId)session.activeTurnId=params.activeTurnId;
      updateDelivery(session,params.ambiguous ? 'uncertain' : 'failed',params.message);
    }
    if(params.action==='edit') {
      if(!params.ambiguous) {
        session.pendingSend=null;session.status=session.editRecovery ? 'failed' : session.pendingEdit?.previousStatus || 'done';session.pendingEdit=null;
      }
      updateDelivery(session,params.ambiguous ? 'uncertain' : 'failed',params.message);
    }
    if (params.action === 'interrupt' && session.status === 'interrupting') session.status = 'running';
    record(session, {type:'action_error', sessionId:session.id, text:params.message, at:Date.now()}); publishSession(session); return;
  }
  if(message.method==='runner/editRolledBack') {
    const pending=session.pendingEdit;
    if(!pending || pending.deliveryId!==message.params.deliveryId)return;
    const retained=new Set((message.params.thread?.turns || []).map(turn=>turn.id));
    session.editExcludedTurns=[...(session.turns || []),...(session.liveTurn ? [session.liveTurn] : [])].map(turn=>turn.id).filter(id=>!retained.has(id));
    session.liveItems=new Map();session.liveNotices=new Map();session.liveTurn=null;session.liveResyncIds=new Set();
    session.pendingSend=null;session.historyVersion=null;
    session.editRecovery={messageId:pending.messageId,sourceDeliveryId:pending.deliveryId,token:crypto.randomUUID(),lastTurnId:message.params.thread?.turns?.at(-1)?.id || null};
    importThreadHistory(session,message.params.thread);
    session.pendingSend={at:pending.at,previousTurnId:session.editRecovery.lastTurnId};session.status='starting';publishSession(session);return;
  }
  if (['runner/responseSubmitted','runner/responseError'].includes(message.method)) {
    const params = message.params || {};
    const question = [...pendingQuestions.values()].find(pending => pending.sessionId === session.id && requestKey(pending.requestId) === requestKey(params.requestId));
    const approval = [...pendingApprovals.values()].find(pending => pending.sessionId === session.id && requestKey(pending.id) === requestKey(params.requestId));
    if (message.method === 'runner/responseError') {
      if (/已回答或已过期/.test(params.message)) resolveServerRequest(session, params.requestId, {questionError:params.message});
      else {
        if (question) { question.submitting = Boolean(params.ambiguous); updateQuestion(session,question.question.id,{answerState:params.ambiguous ? 'sending' : null,questionError:params.message}); }
        if (approval) { approval.submitting = Boolean(params.ambiguous); approval.error = params.message; record(session,{type:'approval_request',sessionId:session.id,request:approval,at:Date.now()}); }
      }
      record(session,{type:'action_error',sessionId:session.id,text:params.message,at:Date.now()});
    } else if ((question || approval)?.origin !== 'desktop') resolveServerRequest(session,params.requestId);
    publishSession(session); return;
  }
  if (message.method === 'serverRequest/resolved') resolveServerRequest(session, message.params.requestId);
  if (payload.rpcMethod === 'turn/start' && message.result?.turn) {
    session.nativeModel = session.model || session.nativeModel;
    session.nativeEffort = session.effort || session.nativeEffort;
    session.nativeSettingsAt = Date.now();
  }

  if (message.method === 'runner/questionAnswered' || message.method === 'runner/questionAnswerError') {
    const params=message.params || {};
    updateQuestion(session,params.itemId,message.method === 'runner/questionAnswered'
      ? {answerState:params.delivery==='message' ? 'forwarded' : 'sent',questionAnswers:params.answers,answeredAt:Date.now(),questionError:null}
      : {answerState:null,questionError:params.message});
    return;
  }

  if (payload.rpcMethod === 'thread/read' && message.result?.thread) {
    importThreadHistory(session, message.result.thread);
    return;
  }

  if (message.id !== undefined && message.result?.thread?.id && !session.threadId) {
    session.threadId = message.result.thread.id;
    session.status = 'ready';
    record(session, { type: 'thread_ready', sessionId: session.id, threadId: session.threadId, at: Date.now() });
    if (session.initialPrompt || session.initialAttachments?.length) {
      const text = session.initialPrompt;
      session.initialPrompt = '';
      const receipt=Object.values(deliveries.data.requests).find(item=>item.sessionId===session.id && ['queued','dispatched'].includes(item.state));
      queueCommand(deviceId,{...turnCommand(session,text,session.initialAttachments),...(session.executionMode==='desktop' ? {executionOwner:'desktop'} : {}),...(receipt ? {deliveryId:receipt.id} : {})});
      session.status = 'running';
      record(session, { type: 'user_message', sessionId: session.id, text, images: (session.initialAttachments || []).map(({ dataUrl, ...image }) => image), at: Date.now() });
      session.initialAttachments = [];
    }
  }

  if (message.method && message.id !== undefined && message.params?.threadId) {
    if (message.method === 'item/tool/requestUserInput') {
      const params=message.params;
      const itemId=params.itemId || `question-${message.id}`;
      const question={id:itemId,type:'agentMessage',turnId:params.turnId,delivery:'rpc',phase:'question',questions:normalizeQuestions(params.questions,itemId,'rpc'),requestId:message.id,isBlocking:params.isBlocking !== false,at:Date.now()};
      const existing = pendingQuestions.get(`${session.id}:${itemId}`);
      if (existing && requestKey(existing.requestId) === requestKey(message.id)) return;
      Object.assign(question,session.questionResponses?.get(itemId) || {});
      (session.questionItems ||= new Map()).set(itemId,question);
      pendingQuestions.set(`${session.id}:${itemId}`,{deviceId,sessionId:session.id,requestId:message.id,question,origin:payload.origin});
      if (params.isBlocking !== false) session.status='waiting_input';
      record(session,{type:'codex',sessionId:session.id,deviceId,message:{method:'item/completed',params:{item:question,threadId:session.threadId,turnId:params.turnId}},at:Date.now()});
      publishSession(session);
      return;
    }
    if (!approvalMethods.has(message.method)) return;
    const key = approvalKey(deviceId,payload.origin,message.id);
    if (pendingApprovals.has(key)) return;
    const approval = { id: message.id, key, sessionId: session.id, deviceId, origin:payload.origin, method: message.method, params: message.params };
    pendingApprovals.set(key, approval);
    session.status = 'waiting_approval';
    record(session, { type: 'approval_request', sessionId: session.id, request: approval, at: Date.now() });
  }

  if (message.method === 'turn/started') { session.activeTurnId=message.params?.turn?.id;session.status = 'running'; session.pendingSend = null;session.pendingEdit=null;session.editRecovery=null; session.executionOwner = payload.origin === 'desktop' ? 'desktop' : 'runner'; updateDelivery(session,'accepted'); }
  if (message.method === 'runner/desktopAccepted') { session.executionOwner = 'desktop'; session.pendingSend = null; if(message.params?.action==='edit' && session.pendingEdit?.deliveryId===message.params.deliveryId){session.pendingEdit=null;session.editRecovery=null;if(message.params.result?.turn?.id)session.activeTurnId=message.params.result.turn.id;} if (!['waiting_input','waiting_approval'].includes(session.status)) session.status = 'running'; updateDelivery(session,'accepted'); }
  if (message.method === 'runner/steerAccepted') { session.pendingSend = null; updateDelivery(session,'accepted'); }
  if (message.method === 'turn/started') session.activeTurnId = message.params?.turn?.id;
  if (message.method === 'turn/completed') {
    session.status = message.params?.turn?.status === 'failed' ? 'failed' : message.params?.turn?.status === 'interrupted' ? 'interrupted' : 'done';
    session.completedAt = Date.now();
    for (const request of [...pendingQuestions.values(),...pendingApprovals.values()]) if (request.sessionId === session.id) resolveServerRequest(session,request.requestId ?? request.id);
    session.activeTurnId = null;
  }
  if (message.method === 'error' || message.method === 'runner/error') { session.status = message.params?.willRetry ? 'running' : 'failed'; if (session.status === 'failed') session.completedAt = Date.now(); }
  if (message.method === 'runner/error') { if(!message.params?.ambiguous)session.pendingSend = null; updateDelivery(session,message.params?.ambiguous ? 'uncertain' : 'failed',message.params?.message); }
  if (message.method === 'turn/interrupt') { session.status = 'interrupted'; session.completedAt = Date.now(); }

  const at = payload.at || Date.now();
  if (payload.origin === 'desktop') {
    session.executionOwner = 'desktop';
    if (message.method === 'turn/started') session.liveTurn = {...session.turns?.find(turn=>turn.id===message.params.turn.id),id:message.params.turn.id,status:'inProgress',startedAt:at,at};
    if (message.method === 'turn/completed') session.liveTurn = {...session.liveTurn,id:message.params.turn.id,status:message.params.turn.status,completedAt:at,at};
    if (message.params?.item?.type === 'userMessage') {
      if (message.method === 'item/started') return;
      const item = message.params.item;
      const replies=questionReplies(item.text);
      if(replies.length) {
        for(const reply of replies) {
          const id=questionCallId(reply.questionItemId);if(!id)continue;
          const previous=session.questionResponses?.get(id)?.questionAnswers || {};
          updateQuestion(session,id,{answerState:'answered',questionAnswers:{...previous,[reply.questionItemId]:reply.answer},answeredAt:at,questionError:null});
        }
        return;
      }
      const old = session.events.findLast(event => event.type === 'user_message' && event.text === item.text && (!event.turnId || event.turnId === message.params.turnId) && (event.id === item.id || Math.abs(event.at-at) < 30000));
      if (old) { old.id = item.id; old.turnId = message.params.turnId; }
      else record(session,{type:'user_message',sessionId:session.id,id:item.id,turnId:message.params.turnId,text:item.text,images:item.images,at});
      publishSession(session); return;
    }
    if(message.params?.item?.questions?.length) {
      const item=message.params.item;
      item.questions=normalizeQuestions(item.questions,item.id,item.delivery || 'async');item.delivery ||= 'async';
      Object.assign(item,session.questionResponses?.get(item.id) || {});
      (session.questionItems ||= new Map()).set(item.id,{...item,turnId:message.params.turnId,at});
    }
    rememberDesktopEvent(session,compactLiveEvent({type:'codex',sessionId:session.id,deviceId,message,at}));
  }
  record(session, { type: 'codex', sessionId: session.id, deviceId, message, at });
  applyDesktopRuntime(session);
  if (previousNativeMetadata === null || previousNativeMetadata !== JSON.stringify(serializeSession(session,false))) publishSession(session);
  if(message.method==='turn/completed')releaseQueuedInput(session);
}

function runnerConnect(req, res, deviceId) {
  if (!isRunnerAuthorized(req,deviceId)) return sendError(res, 401, 'runner authentication failed');
  const query = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
  const device = devices.get(deviceId) || { id: deviceId, name: deviceId, platform: 'remote', cwd: root, kind: 'remote' };
  device.name = query.get('name') || device.name;
  device.platform = query.get('platform') || device.platform;
  device.cwd = query.get('cwd') || device.cwd;
  device.connectorVersion = query.get('version') || null;
  device.executionRelay=query.get('executionRelay')==='1';
  device.online = true;
  device.lastSeen=Date.now();device.runtime='ready';
  devices.set(deviceId, device);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': runner connected\n\n');
  const old=runnerStreams.get(deviceId);runnerStreams.set(deviceId, res);old?.end();
  updateProjectSubscriptions(deviceId);
  queueCommand(deviceId, { type: 'readCatalog' });
  if (!accountUsages.has(deviceId)) queueCommand(deviceId, {type:'readUsage'});
  flushQueue(deviceId, res);
  // A recovered Runner has empty rollout subscriptions and media references.
  // Restore only histories that were already loaded; hidden projects stay idle.
  for (const session of sessions.values()) if (session.deviceId===deviceId && session.historyLoaded && !session.hidden) requestSessionHistory(session,true,historyWindow(session));
  broadcast('device', serializeDevice(device));
  const close = () => {
    if (runnerStreams.get(deviceId) !== res) return;
    runnerStreams.delete(deviceId);
    runnerThreadSignatures.delete(deviceId);
    device.online = false;
    gateway.disconnect(deviceId);
    if(device.runtime!=='revoked')device.runtime='reconnecting';
    for(const session of sessions.values()) if(session.deviceId===deviceId) updateDelivery(session,'uncertain','执行设备连接中断，发送结果待确认。');
    broadcast('device', serializeDevice(device));
  };
  req.on('close', close);
  res.on('close', close);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = url.pathname;
  const updatePackage=pathname.match(/^\/api\/connector-updates\/package\/([a-f0-9]{20})$/);
  if(pathname===updateManifestPath || updatePackage){
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='GET')return sendError(res,405,'更新来源只提供读取');
    if(!lanUpdateRequest(req))return sendError(res,403,'自动更新来源仅在局域网提供');
    const release=await readRelease(root,dataDir);
    if(!release?.signature)return sendError(res,404,'尚未发布支持签名验证的安装包');
    if(updatePackage){
      if(updatePackage[1]!==release.version)return sendError(res,409,'已发布更新版本，请重新检查');
      return sendConnectorPackage(res,release);
    }
    const {path:filename,...manifest}=release;
    return sendJson(res,200,manifest);
  }
  const scopedUpload=pathname.match(/^\/api\/devices\/([^/]+)\/(uploads\/.*)$/);
  if(executionNode && scopedUpload && decodeURIComponent(scopedUpload[1])===localDeviceId)pathname='/api/'+scopedUpload[2];

  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/runner/')) {
    res.setHeader('Cache-Control','no-store');
    if (!browserAccess.sameOrigin(req)) return sendError(res,403,'访问来源不匹配，请使用电脑上显示的 Relay 地址。');
    if (pathname === '/api/access' && req.method === 'GET') return sendJson(res,200,{ required:!browserAccess.authorized(req), local:isLocalBrowser(req) });
    if(pathname==='/api/access/lan' && ['GET','POST'].includes(req.method)){
      if(!isLocalBrowser(req))return sendError(res,403,'局域网开关只能在电脑本机操作。');
      if(req.method==='GET')return sendJson(res,200,lanAccess.status());
      const body=await parseBody(req);if(typeof body.enabled!=='boolean')return sendError(res,400,'局域网开关无效。');
      if(!['127.0.0.1','::1','localhost'].includes(host))return sendError(res,409,'当前 HOST 显式开放了网络监听，请先移除该设置并重启服务，再使用局域网开关。');
      try{return sendJson(res,200,await lanAccess.set(body.enabled));}catch(error){return sendError(res,409,error.message);}
    }
    if(pathname==='/api/connector/enroll' && req.method==='POST'){
      try{const enrolled=connectorAccess.enroll(await parseBody(req),req.socket.remoteAddress);if(!devices.has(enrolled.id))addDevice({id:enrolled.id,name:enrolled.name,platform:'Windows · 远程',kind:'remote'});broadcast('device',serializeDevice(devices.get(enrolled.id)));return sendJson(res,201,enrolled);}
      catch(error){return sendError(res,error.status || 400,error.message);}
    }
    if (pathname === '/api/bootstrap' && req.method === 'GET') {
      const access = { required: !browserAccess.authorized(req), local: isLocalBrowser(req) };
      return sendJson(res, 200, access.required ? { access } : {
        access, devices: [...devices.values()].map(serializeDevice), sessions: visibleSessions(), projects: projectCatalog(), usages:[...accountUsages.values()],historicalUsages:[...historicalUsages.values()]
      });
    }
    if (pathname === '/api/access/pair' && req.method === 'POST') {
      const body=await parseBody(req);
      if(body.deviceName!=null && (typeof body.deviceName!=='string' || body.deviceName.length>80))return sendError(res,400,'设备名称最多 80 个字符。');
      let computerName;
      if(body.computerName!=null && body.computerName!=='')try{computerName=deviceName(body.computerName);}catch(error){return sendError(res,400,error.message);}
      const result = browserAccess.pair(req,body.code,body.deviceName);
      if (result.error) return sendError(res,result.status,result.error);
      if(computerName)renameComputer(localDeviceId,computerName);
      res.setHeader('Set-Cookie',result.cookie); res.setHeader('Cache-Control','no-store');
      return sendJson(res,200,{ok:true});
    }
    if (pathname === '/api/phone' && req.method === 'GET' || pathname === '/api/access/code' && req.method === 'POST') {
      if (!isLocalBrowser(req)) return sendError(res,403,'请在电脑本机查看手机配对码。');
      res.setHeader('Cache-Control','no-store');
      const lan=lanAccess.status();
      return sendJson(res,200,{...browserAccess.pairingInfo(port,lan.lanEnabled,{rotate:pathname==='/api/access/code'}),...lan});
    }
    const browserDeviceRoute=pathname.match(/^\/api\/access\/devices(?:\/([a-f0-9-]{36}))?$/);
    if(browserDeviceRoute){
      if(!isLocalBrowser(req))return sendError(res,403,'设备授权只能在电脑本机管理。');
      const id=browserDeviceRoute[1];
      if(req.method==='GET' && !id)return sendJson(res,200,{devices:browserAccess.listDevices()});
      if(req.method==='PATCH' && id){
        try {if(!browserAccess.renameDevice(id,(await parseBody(req)).name))return sendError(res,404,'设备授权不存在。');}
        catch(error){return sendError(res,400,error.message);}
      }else if(req.method==='DELETE'){
        if(id){if(!browserAccess.revokeDevice(id))return sendError(res,404,'设备授权不存在。');}
        else browserAccess.revokeAll();
        removeUnauthorizedSubscribers();
      }else return sendError(res,405,'不支持的设备管理操作。');
      return sendJson(res,200,{devices:browserAccess.listDevices()});
    }
    if (!browserAccess.authorized(req)) return sendError(res,401,'请先使用电脑上的配对码连接。');
    if(['/api/notifications/push','/api/notifications/push/test','/api/notifications/push/status'].includes(pathname)){
      const grant=browserAccess.deviceFor(req,{touch:false}),owner=grant?.id||'$local';
      try{
        if(pathname.endsWith('/test')&&req.method==='POST')return sendJson(res,202,backgroundNotifications.test(owner,(await parseBody(req)).endpoint));
        if(pathname.endsWith('/status')&&req.method==='POST')return sendJson(res,200,backgroundNotifications.status(owner,(await parseBody(req)).endpoint));
        if(req.method==='GET')return sendJson(res,200,backgroundNotifications.config(owner));
        if(req.method==='POST')return sendJson(res,200,backgroundNotifications.subscribe(owner,grant?.expiresAt||Date.now()+14*86400000,(await parseBody(req)).subscription));
        if(req.method==='DELETE')return sendJson(res,200,backgroundNotifications.unsubscribe(owner,(await parseBody(req)).endpoint));
        return sendError(res,405,'不支持此提醒操作。');
      }catch(error){return sendError(res,400,error.message);}
    }
    if (pathname === '/api/remote-browser/state' && req.method === 'GET') {
      try { return sendJson(res, 200, await remoteBrowser.state()); }
      catch (error) { return sendError(res, 503, error.message); }
    }
    if (pathname === '/api/remote-browser/start' && req.method === 'POST') {
      try { const body = await parseBody(req); return sendJson(res, 200, await remoteBrowser.start(body.url || 'https://chatgpt.com/')); }
      catch (error) { return sendError(res, 503, error.message); }
    }
    if (pathname === '/api/remote-browser/screenshot' && req.method === 'GET') {
      try {
        const image = await remoteBrowser.screenshot(Number(url.searchParams.get('quality')) || 55);
        res.writeHead(200, {'cache-control':'no-store','content-type':'image/webp','content-length':image.length});
        return res.end(image);
      } catch (error) { return sendError(res, 503, error.message); }
    }
    if (pathname === '/api/remote-browser/input' && req.method === 'POST') {
      try { return sendJson(res, 200, await remoteBrowser.input(await parseBody(req))); }
      catch (error) { return sendError(res, 400, error.message); }
    }
    if (pathname === '/api/chatgpt/threads' && req.method === 'GET') {
      try { return sendJson(res, 200, await chatgptRelay.listThreads()); }
      catch (error) { return sendJson(res, 503, { available: false, threads: [], error: error.message }); }
    }
    const chatgptThreadRoute = pathname.match(/^\/api\/chatgpt\/threads\/([^/]+)$/);
    if (chatgptThreadRoute) {
      const threadId = decodeURIComponent(chatgptThreadRoute[1]);
      if (req.method === 'GET') {
        try {
          const turnLimit = Number(url.searchParams.get('turnLimit')) || 3;
          const cursor = url.searchParams.get('cursor') || undefined;
          return sendJson(res, 200, await chatgptRelay.readThread(threadId, { turnLimit, cursor }));
        }
        catch (error) { return sendError(res, error.message.includes('不存在') ? 404 : 503, error.message); }
      }
      if (req.method === 'POST') {
        try {
          const body = await parseBody(req);
          const result = await chatgptRelay.send(threadId, body.prompt);
          return sendJson(res, 202, result);
        } catch (error) {
          const status = /请输入|过长/.test(error.message) ? 400 : /正在发送/.test(error.message) ? 409 : /不存在/.test(error.message) ? 404 : 503;
          return sendError(res, status, error.message);
        }
      }
      return sendError(res, 405, '不支持的 ChatGPT 对话操作。');
    }
  }
  if(await agentTasksHttp(req,res,pathname,{tasks:agentTasks,parseBody,sendJson,sendError}))return;
  if(pathname.startsWith('/api/network-check/') && await networkCheck(req,res,pathname))return;
  if(pathname==='/api/maintenance' && req.method==='GET'){
    const id=url.searchParams.get('requestId');if(id&&!maintenanceId(id))return sendError(res,400,'无效的重启请求编号。');
    const passwordSetupPath=isLocalBrowser(req)?path.join(fs.existsSync(path.join(dataDir,'connector.json'))?path.dirname(dataDir):root,'CodexRemote.exe'):undefined;
    return sendJson(res,200,{...maintenance.status(id),passwordSetupPath});
  }
  if(pathname==='/api/maintenance/restart' && req.method==='POST'){
    try{
      const result=await maintenance.request(await parseBody(req));
      if(result.start){let dispatched=false;const dispatch=()=>{if(!dispatched){dispatched=true;void result.start();}};res.once('finish',dispatch);res.once('close',dispatch);}
      return sendJson(res,202,{job:result.job,duplicate:Boolean(result.duplicate)});
    }catch(error){return sendError(res,error.status || 400,error.message);}
  }
  if(pathname==='/api/connectors' && req.method==='GET'){
    const release=await readRelease(root,dataDir);
    return sendJson(res,200,{local:isLocalBrowser(req),mode:process.env.CODEX_RELAY_CONNECTION_MODE || 'local',url:browserAccess.externalOrigin() || browserAccess.pairingInfo(port,true).urls[0] || 'http://127.0.0.1:'+port,release:release ? {version:release.version,size:release.size} : null,devices:connectorAccess.list().map(item=>({...item,online:Boolean(devices.get(item.id)?.online),version:devices.get(item.id)?.connectorVersion}))});
  }
  if(pathname==='/api/connectors/code' && req.method==='POST'){
    if(!isLocalBrowser(req))return sendError(res,403,'请在主电脑本机生成电脑连接码');
    return sendJson(res,201,connectorAccess.code());
  }
  const revokeConnector=pathname.match(/^\/api\/connectors\/(pc-[a-f0-9-]{36})$/);
  if(revokeConnector && req.method==='DELETE'){
    if(!isLocalBrowser(req))return sendError(res,403,'请在主电脑本机管理电脑连接授权');
    const id=revokeConnector[1];if(!connectorAccess.revoke(id))return sendError(res,404,'电脑授权不存在');
    runnerStreams.get(id)?.end();const device=devices.get(id);if(device){device.online=false;device.runtime='revoked';broadcast('device',serializeDevice(device));}
    return sendJson(res,200,{ok:true});
  }
  if(pathname==='/api/connectors/download' && req.method==='GET')return sendConnectorPackage(res);
  const directRoute=pathname.match(/^\/api\/devices\/([^/]+)\/direct(?:\/([a-f0-9-]{36})\/(lease|close))?$/);
  if(directRoute && req.method==='POST'){
    const id=decodeURIComponent(directRoute[1]),device=devices.get(id);
    if(!device?.online || !device.executionRelay)return sendError(res,409,'这台电脑尚未启用直连连接器');
    if(!directRoute[2]){
      const {offer}=await parseBody(req);if(offer?.type!=='offer' || typeof offer.sdp!=='string' || offer.sdp.length>100_000)return sendError(res,400,'直连请求无效');
      const active=[...gateway.peers.values()].filter(peer=>peer.deviceId===id && peer.expiresAt>Date.now());if(active.length>=8)return sendError(res,429,'直连连接过多');
      const peerId=crypto.randomUUID();gateway.peers.set(peerId,{deviceId:id,req,expiresAt:Date.now()+45_000});
      try{return sendJson(res,200,await gateway.call(id,'offer',{peerId,offer}));}catch(error){gateway.peers.delete(peerId);return sendError(res,503,error.message);}
    }
    const peerId=directRoute[2],peer=gateway.peers.get(peerId);
    const identity=value=>isLocalBrowser(value) ? 'local' : value.headers.cookie;
    if(!peer || peer.deviceId!==id || identity(peer.req)!==identity(req) || peer.expiresAt<Date.now())return sendError(res,403,'直连授权已过期');
    if(directRoute[3]==='close'){gateway.peers.delete(peerId);return sendJson(res,200,await gateway.call(id,'close',{peerId}));}
    peer.expiresAt=Date.now()+45_000;return sendJson(res,200,await gateway.call(id,'lease',{peerId}));
  }
  // Hub requests and direct requests reach the SAME device Relay and receipt store.
  const sessionTarget=pathname.match(/^\/api\/sessions\/([^/]+)/),deviceTarget=pathname.match(/^\/api\/devices\/([^/]+)/);
  let forwardId=sessionTarget ? sessions.get(decodeURIComponent(sessionTarget[1]))?.deviceId : deviceTarget ? decodeURIComponent(deviceTarget[1]) : req.headers['x-codex-device'];
  if(pathname==='/api/sessions' && req.method==='POST')forwardId=(await parseBody(req)).deviceId || localDeviceId;
  const forwardable=executionPath(req.url,req.method) && (!['/api/bootstrap','/api/events','/api/projects','/api/sessions'].includes(pathname) || pathname==='/api/sessions' && req.method==='POST');
  if(!executionNode && devices.get(forwardId)?.executionRelay && forwardable){
    if(!devices.get(forwardId).online)return sendError(res,409,'执行设备离线，输入已保留。');
    const body=['POST','PATCH'].includes(req.method) ? JSON.stringify(await parseBody(req)) : undefined;
    try{const result=await gateway.call(forwardId,'http',{request:{path:req.url,method:req.method,body,headers:{range:req.headers.range,'if-range':req.headers['if-range']}}});const bytes=Buffer.from(result.body,'base64'),responseHeaders={};for(const name of ['accept-ranges','content-range','etag','content-disposition','content-security-policy','referrer-policy','x-content-type-options'])if(typeof result.headers?.[name]==='string')responseHeaders[name]=result.headers[name];res.writeHead(result.status,{'content-type':result.type || 'application/json',...responseHeaders,'content-length':bytes.length,'cache-control':'no-store'});return res.end(bytes);}
    catch(error){return sendError(res,503,error.message);}
  }
  if (pathname === '/api/runtime' && req.method === 'GET') return sendJson(res,200,{maintenanceRevision:1,pushNotificationsRevision:1,sessionPinsRevision:1,performanceSettingsRevision:1,composerContextRevision:1,nativeControlsRevision:3,connectorRevision:2,connectorUpdateRevision:1,chatgptRevision:2,remoteBrowserRevision:3,chatgptAvailable:chatgptRelay.available,chatgptAppToolsAvailable:chatgptRelay.bridge?.appToolsAvailable === true,connectorReleaseId:process.env.CODEX_RELAY_RELEASE_ID || null,directConnectionRevision:1,threadSyncRevision:1,historySyncRevision:3,mediaRevision:1,desktopReadSyncRevision:0,readStateRevision:3,readStateMode:'remote',attentionRevision:1,deviceSettingsRevision:1,htmlPreviewRevision:1,documentPreviewRevision:1,threadOwnershipRevision:1,historicalUsageRevision:2});
  if (pathname === '/api/health' && req.method === 'GET') return sendJson(res,200,healthReport());
  if (pathname === '/api/health/check' && req.method === 'POST') {
    serviceHealth.check();
    return sendJson(res,202,{...healthReport(),checking:true});
  }
  if (pathname === '/api/health/recover' && req.method === 'POST') {
    serviceHealth.check({recover:true,manual:true});
    return sendJson(res,202,{...healthReport(),checking:true});
  }

  if (pathname.startsWith('/api/runner/')) {
    const parts = pathname.split('/').filter(Boolean);
    const deviceId = parts[2];
    if (!deviceId) return sendError(res, 400, 'missing device id');
    if (parts[3] === 'commands' && req.method === 'GET') return runnerConnect(req, res, deviceId);
    if (!isRunnerAuthorized(req,deviceId)) return sendError(res, 401, 'runner authentication failed');
    if(parts[3]==='release' && req.method==='GET'){
      const release=await readRelease(root,dataDir);if(!release)return sendError(res,404,'主电脑尚未发布连接器安装包');
      if(parts[4]){if(parts[4]!==release.version)return sendError(res,409,'版本已更新，请重新点击更新');return sendConnectorPackage(res,release);}
      const {path:filename,...manifest}=release;return sendJson(res,200,manifest);
    }
    if(parts[3]==='uploads' && req.method==='GET' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(parts[4] || '')){
      try{return sendJson(res,200,JSON.parse(fs.readFileSync(path.join(dataDir,'uploads',parts[4]+'.json'),'utf8')));}
      catch{return sendError(res,404,'图片尚未上传完成，输入尚未提交。');}
    }
    if (parts[3] === 'events' && req.method === 'POST') {
      try { handleRunnerMessage(deviceId, await parseBody(req)); return sendJson(res, 202, { ok: true }); }
      catch (error) { return sendError(res, 400, error.message); }
    }
    if (parts[3] === 'heartbeat' && req.method === 'POST') {
      const device = devices.get(deviceId);
      if (device) device.lastSeen=Date.now();
      return sendJson(res, 200, { ok: true });
    }
    return sendError(res, 404, 'unknown runner route');
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
    res.write(': connected\n\n');
    writeSse(res, 'snapshot', { devices: [...devices.values()].map(serializeDevice), sessions: visibleSessions(), projects: projectCatalog(), usages:[...accountUsages.values()],historicalUsages:[...historicalUsages.values()] });
    subscribers.set(res,req);
    const close = () => subscribers.delete(res);
    req.on('close', close); res.on('close', close);
    return;
  }

  const deliveryRoute=pathname.match(/^\/api\/deliveries\/([a-zA-Z0-9_-]{16,80})$/);
  if(deliveryRoute && req.method==='GET') {
    const receipt=deliveries.get(deliveryRoute[1]);
    return sendJson(res,200,receipt ? {found:true,...deliveryResult(receipt)} : {found:false});
  }
  if (pathname === '/api/devices' && req.method === 'GET') return sendJson(res, 200, { devices: [...devices.values()].map(serializeDevice) });
  if (pathname === '/api/sessions' && req.method === 'GET') return sendJson(res, 200, { sessions: visibleSessions() });
  const pinRoute=pathname.match(/^\/api\/sessions\/([^/]+)\/pin$/);
  if(pinRoute&&req.method==='PATCH'){
    const session=sessions.get(decodeURIComponent(pinRoute[1]));
    if(!session||session.hidden||session.archived)return sendError(res,404,'对话不可访问。');
    try{
      setSessionPinned(preferences,session.id,(await parseBody(req)).pinned);savePreferences();
      for(const id of new Set([session.id,...preferences.pinnedSessions])){const item=sessions.get(id);if(item&&!item.hidden)broadcast('session',serializeSession(item,false));}
      return sendJson(res,200,{session:serializeSession(session,false)});
    }catch(error){return sendError(res,400,error.message);}
  }
  if (pathname === '/api/projects' && req.method === 'GET') return sendJson(res, 200, { projects: projectCatalog() });
  const usageDevice = pathname.match(/^\/api\/devices\/([^/]+)\/usage$/);
  const historyUsageDevice=pathname.match(/^\/api\/devices\/([^/]+)\/history-usage$/);
  if(historyUsageDevice && ['GET','POST'].includes(req.method)) {
    const id=decodeURIComponent(historyUsageDevice[1]),target=devices.get(id);
    if(!target)return sendError(res,404,'执行设备不存在。');
    const filtered=url.searchParams.has('from') || url.searchParams.has('to');
    let range;
    if(filtered) {
      try{
        const from=url.searchParams.get('from'),to=url.searchParams.get('to');
        if(!/^\d+$/.test(from || '') || !/^\d+$/.test(to || ''))throw new Error();
        range=normalizeUsageRange({from:Number(from),to:Number(to)});
      }catch{return sendError(res,400,'请选择有效的统计时间范围。');}
      if(!target.online)return sendError(res,503,'执行设备离线，暂时无法筛选历史用量。');
      if(historicalUsages.get(id)?.models) {
        if(historyRangeRequests.size>=32)return sendError(res,429,'历史统计繁忙，请稍后重试。');
        const result=await new Promise(resolve=>{
          const requestId=crypto.randomUUID();
          const finish=value=>{historyRangeRequests.delete(requestId);clearTimeout(timer);res.off('close',cancel);resolve(value);};
          const cancel=()=>finish({error:'历史统计请求已取消。'});
          const timer=setTimeout(()=>finish({error:'历史统计超时，请稍后重试。'}),12000);
          historyRangeRequests.set(requestId,{deviceId:id,finish});res.once('close',cancel);
          queueCommand(id,{type:'queryHistoricalUsage',requestId,range});
        });
        if(result.error)return sendError(res,503,result.error);
        return sendJson(res,200,{usage:{...result.usage,deviceId:id},online:true});
      }
    }
    if(req.method==='POST' && target.online && Date.now()-(historyUsageRequestedAt.get(id) || 0)>10000) {
      historyUsageRequestedAt.set(id,Date.now());historicalUsages.set(id,{...historicalUsages.get(id),deviceId:id,status:'indexing'});queueCommand(id,{type:'readHistoricalUsage'});
    }
    if(filtered)return sendJson(res,200,{usage:{range,status:historicalUsages.get(id)?.status || 'indexing',error:historicalUsages.get(id)?.error},online:true});
    return sendJson(res,200,{usage:historicalUsages.get(id) || null,online:target.online});
  }
  if (usageDevice && ['GET','POST'].includes(req.method)) {
    const id = decodeURIComponent(usageDevice[1]);
    const target = devices.get(id);
    if (!target) return sendError(res,404,'执行设备不存在。');
    if (req.method === 'POST' && target.online && Date.now()-(usageRequestedAt.get(id) || 0)>10_000) {
      usageRequestedAt.set(id,Date.now());queueCommand(id,{type:'readUsage'});
    }
    return sendJson(res,200,{usage:accountUsages.get(id) || null,online:target.online});
  }
  if (pathname === '/api/projects' && req.method === 'PATCH') {
    const body = await parseBody(req);
    if (!Array.isArray(body.hiddenProjects) || body.hiddenProjects.some(id => typeof id !== 'string')) return sendError(res, 400, '无效的项目选择');
    if(!executionNode)for(const device of devices.values())if(device.executionRelay){
      if(!device.online)return sendError(res,409,'请先恢复 '+device.name+' 的连接再保存项目选择');
      const result=await gateway.call(device.id,'http',{request:{path:'/api/projects',method:'PATCH',body:JSON.stringify({hiddenProjects:body.hiddenProjects.filter(id=>remoteProjects.get(device.id)?.some(project=>project.id===id))})}});
      if(result.status!==200)return sendError(res,503,'执行设备项目设置未保存');
    }
    preferences.hiddenProjects = [...new Set(body.hiddenProjects)];
    savePreferences();
    for (const session of sessions.values()) {
      const hidden = preferences.hiddenProjects.includes(session.projectId);
      if (hidden && !session.hidden && session.source === 'imported') {
        session.events = []; session.turns = []; session.historyLoaded = false; session.historyRequested = false; session.historyVersion = null;
      }
      session.hidden = hidden || Boolean(session.archived);
    }
    for (const deviceId of devices.keys()) { updateProjectSubscriptions(deviceId); queueCommand(deviceId, { type: 'listThreads' }); }
    broadcast('snapshot', { devices: [...devices.values()].map(serializeDevice), sessions: visibleSessions(), projects: projectCatalog() });
    return sendJson(res, 200, { projects: projectCatalog(), sessions: visibleSessions() });
  }
  const computerNameRoute=pathname.match(/^\/api\/devices\/([^/]+)\/name$/);
  if(computerNameRoute && req.method==='PATCH'){
    const id=decodeURIComponent(computerNameRoute[1]);if(!devices.has(id))return sendError(res,404,'电脑不存在。');
    try{const body=await parseBody(req);return sendJson(res,200,{device:renameComputer(id,body.name,body.iconTheme)});}catch(error){return sendError(res,400,error.message);}
  }
  const composerRoute=pathname.match(/^\/api\/sessions\/([^/]+)\/(context|goal)$/);
  const busySession=pathname.match(/^\/api\/sessions\/([^/]+)(?:\/|$)/);
  if(busySession && ['POST','PATCH','DELETE'].includes(req.method) && ownershipReleases.has(sessions.get(decodeURIComponent(busySession[1]))?.deviceId))return sendError(res,409,'正在交接空闲执行器，输入未发送，请稍后重试。');
  const ownershipRoute=pathname.match(/^\/api\/sessions\/([^/]+)\/ownership$/);
  if(ownershipRoute && ['GET','POST'].includes(req.method)){
    const session=sessions.get(decodeURIComponent(ownershipRoute[1]));
    if(!session || session.hidden || session.archived)return sendError(res,404,'对话不可访问。');
    if(!session.threadId || !devices.get(session.deviceId)?.online)return sendError(res,409,'请先恢复执行设备连接。');
    if(devices.get(session.deviceId)?.ownershipRevision!==1)return sendError(res,409,'该电脑的执行器尚未加载占用诊断，请先更新远程服务。');
    let releasing=false;
    try{
      const command={sessionId:session.id,threadId:session.threadId,operation:'ownership'};
      if(req.method==='POST'){
        const body=await parseBody(req);
        if(body.confirm!==true || !Number.isSafeInteger(body.expected?.pid) || typeof body.expected?.generation!=='string')return sendError(res,400,'请先诊断并确认释放。');
        if(ownershipReleases.has(session.deviceId))return sendError(res,409,'已有交接正在处理，请稍后诊断。');
        if([...sessions.values()].some(item=>item.deviceId===session.deviceId && (item.pendingSend || item.pendingEdit || item.status==='starting' || (item.executionOwner==='runner' || item.executionMode==='runner') && ['running','waiting_input','waiting_approval','interrupting'].includes(item.status))) || (runnerQueues.get(session.deviceId)||[]).some(item=>['startThread','startTurn','editMessage','respond'].includes(item.type)))return sendError(res,409,'仍有任务或待发送消息，未释放。');
        ownershipReleases.add(session.deviceId);releasing=true;command.operation='releaseRunner';command.expected={pid:body.expected.pid,generation:body.expected.generation};
      }
      const result=await composerRequests.request(session.deviceId,command);
      if(result.released){
        for(const item of sessions.values())if(item.deviceId===session.deviceId && result.threadIds?.includes(item.threadId)){item.executionMode='desktop';item.executionOwner='external';publishSession(item);}
      }
      return sendJson(res,200,result);
    }catch(error){return sendError(res,409,error.message);}
    finally{if(releasing)ownershipReleases.delete(session.deviceId);}
  }
  if(composerRoute && ['GET','POST'].includes(req.method)){
    const session=sessions.get(decodeURIComponent(composerRoute[1]));
    if(!session || session.hidden || session.archived)return sendError(res,404,'对话不可访问。');
    if(!session.threadId || !devices.get(session.deviceId)?.online)return sendError(res,409,'请先恢复执行设备连接。');
    try{
      const kind=composerRoute[2];
      const command={sessionId:session.id,threadId:session.threadId,cwd:session.cwd,executionOwner:usesDesktop(session) ? 'desktop' : 'runner'};
      if(kind==='context'){
        if(req.method!=='GET')return sendError(res,405,'只支持读取列表。');
        command.operation=url.searchParams.get('kind') || 'skills';
        if(!['skills','files','apps'].includes(command.operation))return sendError(res,400,'未知引用列表。');
        command.query=(url.searchParams.get('q') || '').slice(0,160);
      }else if(req.method==='POST'){
        command.operation='goalChange';command.change=goalChange(await parseBody(req));
      }else command.operation='goalGet';
      const result=await composerRequests.request(session.deviceId,command);
      if(kind==='context' && ['skills','apps'].includes(command.operation)){
        const catalog=composerCatalogs.get(session.id) || {};catalog[command.operation]=result.items;composerCatalogs.delete(session.id);composerCatalogs.set(session.id,catalog);
        while(composerCatalogs.size>64)composerCatalogs.delete(composerCatalogs.keys().next().value);
      }
      res.setHeader('Cache-Control','no-store');return sendJson(res,200,result);
    }catch(error){return sendError(res,400,error.message);}
  }
  const performanceRoute=pathname.match(/^\/api\/devices\/([^/]+)\/performance$/);
  if(performanceRoute && ['GET','PATCH'].includes(req.method)) {
    const id=decodeURIComponent(performanceRoute[1]);
    if(!devices.has(id))return sendError(res,404,'电脑不存在。');
    if(req.method==='PATCH') {
      let settings;
      try{const patch=await parseBody(req);performanceSettings(patch,true);settings=performanceSettings({...performanceSettings(preferences.performance?.[id]),...patch},true);}catch(error){return sendError(res,400,error.message);}
      preferences.performance={...preferences.performance,[id]:settings};savePreferences();
      broadcast('device',serializeDevice(devices.get(id)));
    }
    const device=serializeDevice(devices.get(id));
    return sendJson(res,200,{device,settings:device.performanceSettings});
  }
  const catalogRoute = pathname.match(/^\/api\/devices\/([^/]+)\/catalog(?:\/(refresh))?$/);
  if (catalogRoute && req.method === 'GET') {
    const deviceId = decodeURIComponent(catalogRoute[1]);
    const catalog = catalogs.get(deviceId);
    if (!catalog) queueCommand(deviceId, { type: 'readCatalog' });
    return sendJson(res, 200, catalogFor(deviceId));
  }
  if (catalogRoute && catalogRoute[2]==='refresh' && req.method === 'POST') {
    const deviceId = decodeURIComponent(catalogRoute[1]);
    if(!devices.has(deviceId))return sendError(res,404,'电脑不存在。');
    queueCommand(deviceId,{type:'readCatalog'});
    return sendJson(res,202,{queued:true});
  }
  if (catalogRoute && !catalogRoute[2] && req.method === 'PATCH') {
    const deviceId=decodeURIComponent(catalogRoute[1]),catalog=catalogs.get(deviceId);
    if(!catalog)return sendError(res,409,'模型列表尚未读取完成，请稍后再试。');
    try {
      const body=await parseBody(req);
      preferences.hiddenModels[deviceId]=validateHiddenModels(catalog,body.hiddenModels);
      savePreferences();
      broadcast('catalog',{deviceId,...catalogFor(deviceId)});
      return sendJson(res,200,catalogFor(deviceId));
    } catch(error) { return sendError(res,400,error.message); }
  }
  if (pathname === '/api/uploads' && req.method === 'POST') {
    try {
      const body = await parseBody(req); const decoded = decodeImage(body.dataUrl);
      const id = body.requestId || crypto.randomUUID(); const name = String(body.name || '图片').slice(0, 150);
      if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))return sendError(res,400,'无效的图片上传编号。');
      const dataUrl=`data:${decoded.mime};base64,${decoded.bytes.toString('base64')}`;
      const file=path.join(dataDir,'uploads',id+'.json');
      fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
      if(fs.existsSync(file)){
        const existing=JSON.parse(fs.readFileSync(file,'utf8'));
        if(existing.name!==name || existing.dataUrl!==dataUrl)return sendError(res,409,'这个上传编号的图片内容已改变，请重新选择图片。');
      }else fs.writeFileSync(file,JSON.stringify({name,dataUrl}));
      return sendJson(res, 201, { id, name, url: uploadUrl(id) });
    } catch (error) { return sendError(res, 400, error.message); }
  }
  const uploadStatus=pathname.match(/^\/api\/uploads\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/status$/);
  if(uploadStatus && req.method==='GET'){
    try{
      const id=uploadStatus[1],stored=JSON.parse(fs.readFileSync(path.join(dataDir,'uploads',id+'.json'),'utf8'));
      return sendJson(res,200,{found:true,image:{id,name:stored.name,url:uploadUrl(id)}});
    }catch(error){if(error.code==='ENOENT')return sendJson(res,200,{found:false});throw error;}
  }
  const uploadRoute = pathname.match(/^\/api\/uploads\/([a-f0-9-]{36})$/);
  if (uploadRoute && ['GET','HEAD'].includes(req.method)) {
    try {
      const image = JSON.parse(fs.readFileSync(path.join(dataDir, 'uploads', uploadRoute[1] + '.json'), 'utf8'));
      const { bytes, mime } = decodeImage(image.dataUrl);
      return serveImageBytes(req,res,url,{bytes,mime,name:image.name || '附图'});
    } catch { return sendError(res, 404, '图片不存在'); }
  }
  const htmlRoute=pathname.match(/^\/api\/sessions\/([^/]+)\/preview\/([A-Za-z0-9_-]{1,8192})\/(.+)$/);
  if(htmlRoute && ['GET','HEAD'].includes(req.method)){
    const session=sessions.get(decodeURIComponent(htmlRoute[1]));if(!session || session.hidden)return sendError(res,404,'对话不存在');
    let ref,resource;
    try{ref=decodeURIComponent(Buffer.from(htmlRoute[2],'base64url').toString('utf8'));resource=decodeURIComponent(htmlRoute[3]);}catch{return sendError(res,400,'预览地址无效');}
    const references=new Set([...(session.events || []),...(session.liveItems?.values() || [])].flatMap(event=>htmlReferences((event.message?.params?.item || event).text || '')));
    if(!isLocalPreview(ref) || !references.has(ref))return sendError(res,403,'预览文件不属于这条对话');
    const read=options=>new Promise((resolve,reject)=>{
      if(mediaRequests.size>=128)return reject(new Error('附件读取繁忙，请稍后重试。'));
      const requestId=crypto.randomUUID();
      const cancel=()=>{const pending=mediaRequests.get(requestId);if(!pending)return;mediaRequests.delete(requestId);clearTimeout(pending.timer);reject(new Error('预览读取已取消。'));};
      const timer=setTimeout(()=>{mediaRequests.delete(requestId);res.off('close',cancel);reject(new Error('预览读取超时，请检查 Runner 连接。'));},15000);
      res.once('close',cancel);
      mediaRequests.set(requestId,{deviceId:session.deviceId,timer,resolve:result=>{res.off('close',cancel);result.error ? reject(new Error(result.error)) : resolve(result);}});
      queueCommand(session.deviceId,{type:'readHtmlPreview',requestId,ref,approvedRef:ref,threadId:session.threadId,cwd:session.cwd,resource,...options});
    });
    const interactive=url.searchParams.get('interactive')==='1' && /\.html?$/i.test(resource);
    return serveMedia(req,res,url,read,{allowedMimes:previewMimes,extraHeaders:interactive ? interactivePreviewHeaders : previewHeaders});
  }
  const mediaRoute = pathname.match(/^\/api\/sessions\/([^/]+)\/media$/);
  if (mediaRoute && ['GET','HEAD'].includes(req.method)) {
    const session = sessions.get(decodeURIComponent(mediaRoute[1])); const ref = url.searchParams.get('ref');
    if (!session || session.hidden) return sendError(res, 404, '对话不存在');
    const references = new Set([...(session.events || []),...(session.liveItems?.values() || [])].flatMap(event => {
      const item = event.message?.params?.item || event;
      return [...mediaReferences(item.text || ''), ...(item.images || []).map(image => image.ref || image.url),...(item.attachments || []).map(item=>item.ref || item.url)];
    }));
    if (!references.has(ref)) return sendError(res, 403, '附件不属于这条对话');
    const read=options=>new Promise((resolve,reject)=>{
      const requestId=crypto.randomUUID();
      const cancel=()=>{const pending=mediaRequests.get(requestId);if(!pending)return;mediaRequests.delete(requestId);clearTimeout(pending.timer);reject(new Error('附件读取已取消。'));};
      const timer=setTimeout(()=>{mediaRequests.delete(requestId);res.off('close',cancel);reject(new Error('附件读取超时，请检查 Runner 连接。'));},15000);
      res.once('close',cancel);
      mediaRequests.set(requestId,{deviceId:session.deviceId,timer,resolve:result=>{res.off('close',cancel);result.error ? reject(new Error(result.error)) : resolve(result);}});
      queueCommand(session.deviceId,{type:'readMedia',mediaRevision:1,requestId,threadId:session.threadId,ref,approvedRef:ref,cwd:session.cwd,...options});
    });
    return serveMedia(req,res,url,read);
  }

  const sessionRead = pathname.match(/^\/api\/sessions\/([^/]+)\/read$/);
  if (sessionRead && req.method === 'POST') {
    const session = sessions.get(decodeURIComponent(sessionRead[1]));
    if (!session || session.hidden) return sendError(res, 404, '对话不存在');
    const { completionToken } = await parseBody(req);
    if (typeof completionToken !== 'string' || completionToken.length > 1000) return sendError(res, 400, '无效的已读标记');
    if(!sessionReadState.matches(session.id,completionToken))return sendError(res,409,'对话已有新的完成回复，请加载后再标为已读。');
    const result = sessionReadState.markRead(session.id, completionToken);
    if (!result.matched) return sendError(res, 409, '对话已有新的完成回复，请加载后再标为已读。');
    if (result.changed) publishSession(session);
    return sendJson(res, 200, { session:serializeSession(session, false) });
  }

  const sessionHistory = pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
  if (sessionHistory && req.method === 'GET') {
    const session = sessions.get(decodeURIComponent(sessionHistory[1]));
    if (!session || session.hidden) return sendError(res, 404, 'session not found');
    let turns = session.turns || [], events = session.events || [];
    const maxTurns = url.searchParams.get('maxTurns');
    if (session.source === 'imported' && maxTurns && maxTurns !== 'all' && turns.length) {
      const limit = Number(maxTurns);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return sendError(res, 400, '无效的回合数量');
      turns = turns.slice(-limit);
      const ids = new Set(turns.map(turn => turn.id));
      // Unassigned legacy/system events remain available instead of being lost.
      events = events.filter(event => {
        const turnId = event.turnId || event.message?.params?.turnId;
        return !turnId || ids.has(turnId);
      });
    }
    const result = { sessionId: session.id, historyLoaded: Boolean(session.historyLoaded), historyVersion: session.historyVersion || null, messageCount: session.messageCount ?? null, turns, turnCount: session.turnCount || null, events };
    if (url.searchParams.get('sync') === '1') {
      const cursor = url.searchParams.get('cursor');
      if (cursor && !/^[a-f0-9]{64}$/.test(cursor)) return sendError(res,400,'无效的历史游标');
      const window = session.source === 'imported' ? maxTurns || 'all' : 'all';
      return sendJson(res,200,historySync.response(result,window,cursor));
    }
    return sendJson(res,200,result);
  }
  if (sessionHistory && req.method === 'POST') {
    const session = sessions.get(decodeURIComponent(sessionHistory[1]));
    if (!session) return sendError(res, 404, 'session not found');
    const body = await parseBody(req);
    const queued = requestSessionHistory(session, true, body.maxTurns || historyWindow(session));
    return sendJson(res, 202, { queued, historyLoaded: Boolean(session.historyLoaded) });
  }

  const syncDevice = pathname.match(/^\/api\/devices\/([^/]+)\/sync$/);
  if (syncDevice && req.method === 'POST') {
    const deviceId = decodeURIComponent(syncDevice[1]);
    if (!devices.has(deviceId)) return sendError(res, 404, 'device not found');
    queueCommand(deviceId, { type: 'listThreads' });
    return sendJson(res, 202, { queued: true });
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const check=deliveries.check(body.requestId,'create',body);
      if(check?.old)return sendJson(res,201,{...check.old.response,session:serializeSession(sessions.get(check.old.sessionId)),delivery:deliveryResult(check.old)});
      const deviceId = body.deviceId || localDeviceId;
      const device = devices.get(deviceId);
      if (!device) return sendError(res, 404, 'device not found');
      if(ownershipReleases.has(deviceId))return sendError(res,409,'正在交接空闲执行器，请稍后创建。');
      const executionMode=creationMode(body,device);
      const id = crypto.randomUUID();
      const options = sessionOptions(body, null, deviceId);
      const attachments = attachmentsFor(body);
      const selectedProject = body.projectId ? projectCatalog().find(project => project.id === body.projectId && project.deviceId === deviceId && !project.hidden) : null;
      if (body.projectId && !selectedProject) return sendError(res, 400, '项目已不可用，请重新选择。');
      const cwd = selectedProject?.cwd || body.cwd || device.cwd || defaultCwd;
      const project = projectFor(deviceId, cwd);
      const session = { id, title: body.title || '新的 Codex 任务', deviceId, executionMode, threadId: null, cwd, projectId: project.id, projectName: project.name, projectCwd: project.cwd, ...options, status: 'starting', createdAt: Date.now(), updatedAt: Date.now(), events: [], initialPrompt: body.prompt || (attachments.length ? '请查看附图。' : ''), initialAttachments: attachments };
      sessions.set(id, session);
      const command={type:'startThread',sessionId:id,cwd:session.cwd,executionMode,...options,...(check ? {deliveryId:check.id} : {})};
      const response={session:serializeSession(session)};
      deliveries.add(check,session,response,command);
      record(session, { type: 'session_created', sessionId: id, at: Date.now() });
      queueCommand(deviceId, command);
      return sendJson(res, 201, {...response,...(check ? {delivery:deliveryResult(deliveries.get(check.id))} : {})});
    } catch (error) { return sendError(res, 400, error.message); }
  }

  const queuedAction=pathname.match(/^\/api\/sessions\/([^/]+)\/queued\/([^/]+)\/(steer|send|withdraw|delete)$/);
  if(queuedAction && req.method==='POST') {
    const session=sessions.get(decodeURIComponent(queuedAction[1]));
    if(!session || session.hidden)return sendError(res,404,'对话不可用。');
    try {
      const body=await parseBody(req),action=queuedAction[3],check=deliveries.check(body.requestId,`queued:${session.id}:${queuedAction[2]}:${action}`,body);
      if(!check)return sendError(res,400,'操作缺少发送编号。');
      if(check.old)return sendJson(res,['steer','send'].includes(action) ? 202 : 200,{...check.old.response,delivery:deliveryResult(check.old)});
      const item=session.queuedInputs?.find(item=>item.id===queuedAction[2]);
      if(!item || item.state!=='waiting' || item.revision!==body.revision)return sendError(res,409,'消息已发送或被其他设备修改，请查看最新状态。');
      if(action==='steer' || action==='send') {
        if(action==='steer' && session.activeTurnId!==body.expectedTurnId)return sendError(res,409,'原回合已结束，消息仍在待发送列表。');
        dispatchQueuedInput(session,item,action==='steer' ? 'steer' : 'start',check);
        return sendJson(res,202,{queued:true,delivery:deliveryResult(deliveries.get(check.id))});
      }
      const response={removed:true,...(action==='withdraw' ? {item} : {})};
      session.queuedInputs=session.queuedInputs.filter(value=>value.id!==item.id);
      deliveries.add(check,session,response,null);deliveries.update(check.id,'accepted');deliveries.update(item.id,'cancelled');publishSession(session);
      return sendJson(res,200,{...response,delivery:deliveryResult(deliveries.get(check.id))});
    } catch(error){return sendError(res,409,error.message);}
  }
  const editMessage=pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/edit$/);
  if(editMessage && req.method==='POST') {
    const session=sessions.get(decodeURIComponent(editMessage[1]));
    if(!session || session.hidden)return sendError(res,404,'对话不可用。');
    try {
      const body=await parseBody(req),check=deliveries.check(body.requestId,`edit:${session.id}:${editMessage[2]}`,body);
      if(!check)return sendError(res,400,'编辑缺少发送编号。');
      if(check.old)return sendJson(res,202,{...check.old.response,delivery:deliveryResult(check.old)});
      if(!sessionControls(session).edit)return sendError(res,409,sessionControls(session).editNeedsRestart ? '当前桌面代理尚未加载消息编辑支持，请在方便时用现有原生入口重新打开桌面。' : '请等待当前回合结束或先中断，再发送编辑内容。');
      const id=decodeURIComponent(editMessage[2]),target=(session.events || []).find(event=>event.type==='user_message' && messageKey(event)===id);
      const recovery=session.editRecovery?.messageId===id && session.editRecovery.token===body.recoveryToken ? session.editRecovery : null;
      if(!recovery && (!target || messageToken(target)!==body.expectedToken || !editableMessages(session).some(value=>value.id===id && value.lastTurnId===body.expectedLastTurnId)))return sendError(res,409,'对话内容已经改变，请同步后重新编辑。');
      const text=String(body.text || '').trim();
      if(!text && !target?.images?.length && !recovery)return sendError(res,400,'请输入消息或保留原图片。');
      const options=sessionOptions(body,session,session.deviceId),desktop=usesDesktop(session);
      const command={type:'editMessage',sessionId:session.id,threadId:session.threadId,messageId:target?.id || id,editTurnId:target?.turnId,originalText:target?.text,text,expectedLastTurnId:recovery ? recovery.lastTurnId : body.expectedLastTurnId,...options,deliveryId:check.id,...(recovery ? {recoverySourceId:recovery.sourceDeliveryId} : {}),...(desktop ? {executionOwner:'desktop'} : {})};
      session.pendingEdit={deliveryId:check.id,messageId:id,at:Date.now(),previousStatus:session.status};
      session.pendingSend={at:session.pendingEdit.at,previousTurnId:body.expectedLastTurnId};session.status='starting';
      deliveries.add(check,session,{queued:true},command);queueCommand(session.deviceId,command);publishSession(session);
      return sendJson(res,202,{queued:true,delivery:deliveryResult(deliveries.get(check.id))});
    } catch(error){return sendError(res,400,error.message);}
  }
  const sessionTurn = pathname.match(/^\/api\/sessions\/([^/]+)\/turns$/);
  if (sessionTurn && req.method === 'POST') {
    const session = sessions.get(sessionTurn[1]);
    if (!session) return sendError(res, 404, 'session not found');
    try {
      const body = await parseBody(req);
      const check=deliveries.check(body.requestId,'turn:'+session.id,body);
      if(check?.old)return sendJson(res,202,{...check.old.response,delivery:deliveryResult(check.old)});
      if (session.hidden) return sendError(res, 400, '请先恢复这个项目。');
      const context=validatedContext(body,session,sessions,composerCatalogs.get(session.id));
      if(body.mode==='queue') {
        if(!check || !session.threadId)return sendError(res,400,'对话尚未就绪或缺少发送编号。');
        const attachments=attachmentsFor(body),text=String(body.text || '').trim();
        if(!text && !attachments.length && !context.length)return sendError(res,400,'请输入消息或添加图片。');
        if((session.queuedInputs || []).length>=20)return sendError(res,400,'待发送消息最多保留 20 条。');
        const options=sessionOptions(body,session,session.deviceId);
        (session.queuedInputs ||= []).push({id:check.id,text,attachments,context,options,at:Date.now(),revision:1,state:'waiting'});
        deliveries.add(check,session,{queued:true,waiting:true},null);deliveries.update(check.id,'waiting');publishSession(session);releaseQueuedInput(session);
        return sendJson(res,202,{queued:true,waiting:true,delivery:deliveryResult(deliveries.get(check.id))});
      }
      if(session.pendingEdit)return sendError(res,409,'正在确认消息编辑结果，输入已保留。');
      if (session.pendingSend) return sendError(res,409,'上一条消息还在确认发送结果，请稍后重试。');
      const busy = ['running','starting','waiting_approval','waiting_input','interrupting'].includes(session.status);
      const steer = body.mode === 'steer' || busy;
      if (steer && !devices.get(session.deviceId)?.online) return sendError(res,409,'执行设备离线，输入已保留。');
      if (steer && (!sessionControls(session).steer || body.expectedTurnId && body.expectedTurnId !== session.activeTurnId)) return sendError(res,409,'当前回合已结束或暂时无法追加，输入已保留。');
      const attachments = attachmentsFor(body);
      const text = String(body.text || '').trim();
      if (!text && !attachments.length && !context.length) return sendError(res, 400, '请输入消息或添加图片。');
      if (!steer) Object.assign(session, sessionOptions(body, session, session.deviceId));
      if (!session.threadId) return sendError(res,409,'对话尚未就绪，输入已保留，请稍后重试。');
      if (!steer) session.status = 'running';
      session.pendingSend = { at:Date.now(), previousTurnId:session.turns?.at(-1)?.id };
      const native = devices.get(session.deviceId)?.nativeDesktop;
      const desktop = usesDesktop(session);
      const command={...turnCommand(session,text,attachments,context),...(steer ? {mode:'steer',expectedTurnId:session.activeTurnId} : {}),...(desktop ? {executionOwner:'desktop'} : {}),...(check ? {deliveryId:check.id} : {})};
      if (steer) for (const key of ['model','effort','permission','serviceTier']) delete command[key];
      deliveries.add(check,session,{queued:true},command);
      queueCommand(session.deviceId, command);
      record(session, { type: 'user_message', sessionId: session.id, ...(steer ? {turnId:session.activeTurnId} : {}), text, context, images: attachments.map(({dataUrl, ...image}) => image), at: Date.now() });
      publishSession(session);
      return sendJson(res, 202, { queued: true,...(check ? {delivery:deliveryResult(deliveries.get(check.id))} : {}) });
    } catch (error) { return sendError(res, 400, error.message); }
  }

  const questionAnswer=pathname.match(/^\/api\/sessions\/([^/]+)\/questions\/([^/]+)\/answers$/);
  if (questionAnswer && req.method === 'POST') {
    const session=sessions.get(decodeURIComponent(questionAnswer[1]));
    if (!session || session.hidden) return sendError(res,404,'对话不可用。');
    if (!devices.get(session.deviceId)?.online) return sendError(res,409,'设备离线，回答尚未发送。');
    const itemId=decodeURIComponent(questionAnswer[2]);
    const question=session.events.map(event=>event.message?.params?.item).findLast(item=>item?.id === itemId && item.questions?.length);
    if (!question) return sendError(res,404,'没有找到这个问题。');
    if (['done','failed','interrupted'].includes(session.status)) return sendError(res,409,'本回合已结束，不能再次回答。');
    if (question.answerState === 'resolved') return sendError(res,409,'这个提问已在桌面处理或已经结束。');
    if (question.answerState === 'sending' || question.questionAnswers) return sendError(res,409,'这个问题已提交，请等待同步。');
    const turn=session.turns?.find(turn=>turn.id === question.turnId);
    if (turn && !['inProgress','running'].includes(turn.status)) return sendError(res,409,'本回合已结束，不能再次回答。');
    try {
      const {answers:input}=await parseBody(req);
      const questions=normalizeQuestions(question.questions,itemId,question.delivery);
      if (!questions.length) throw new Error('问题内容不可用，请刷新后重试。');
      const answers=validateQuestionAnswers(questions,input);
      if (question.answerState === 'sending' || question.questionAnswers) return sendError(res,409,'这个问题已提交，请等待同步。');
      const pending=pendingQuestions.get(`${session.id}:${itemId}`);
      if (pending) {
        if (pending.submitting) return sendError(res,409,'这个问题已提交，请等待同步。');
        if (pending.origin === 'desktop' && (!devices.get(session.deviceId)?.nativeDesktop?.connected || !devices.get(session.deviceId)?.nativeDesktop?.capabilities?.serverRequests)) return sendError(res,409,'桌面的提问连接尚未就绪。');
        pending.submitting=true; pending.answers=answers;
        queueCommand(session.deviceId,{type:'respond',sessionId:session.id,threadId:session.threadId,itemId,executionOwner:pending.origin,requestId:pending.requestId,result:{answers:Object.fromEntries(Object.entries(answers).map(([id,answer])=>[id,{answers:[answer]}]))}});
        updateQuestion(session,itemId,{answerState:'sending',questionError:null});
      } else {
        if (question.delivery !== 'async') return sendError(res,409,'这个提问需要在桌面 Codex 回答。');
        updateQuestion(session,itemId,{answerState:'sending',questionError:null});
        queueCommand(session.deviceId,{type:'answerQuestion',sessionId:session.id,threadId:session.threadId,itemId,questions,answers});
      }
      return sendJson(res,202,{queued:true});
    } catch(error) { return sendError(res,400,error.message); }
  }

  const interrupt = pathname.match(/^\/api\/sessions\/([^/]+)\/interrupt$/);
  if (interrupt && req.method === 'POST') {
    const session = sessions.get(interrupt[1]);
    if (!session) return sendError(res, 404, 'session not found');
    if (!devices.get(session.deviceId)?.online) return sendError(res,409,'执行设备离线。');
    if (!sessionControls(session).interrupt) return sendError(res, 400, '当前回合无法远程中断，请确认桌面连接与运行状态。');
    const body = await parseBody(req);
    if (body.turnId && body.turnId !== session.activeTurnId) return sendError(res,409,'当前回合已经变化，请查看最新状态。');
    queueCommand(session.deviceId, { type: 'interrupt', sessionId: session.id, threadId: session.threadId, turnId: session.activeTurnId,executionOwner:usesDesktop(session) ? 'desktop' : 'runner' });
    session.status = 'interrupting';
    record(session, { type: 'system', sessionId: session.id, text: '已请求中断当前 turn', at: Date.now() });
    publishSession(session);
    return sendJson(res, 202, { queued: true });
  }

  const approval = pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (approval && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const requested = decodeURIComponent(approval[1]);
      const candidates = [...pendingApprovals.values()].filter(item => (item.key === requested || String(item.id) === requested) && (!body.sessionId || item.sessionId === body.sessionId));
      const pending = candidates.length === 1 ? candidates[0] : null;
      if (!pending) return sendError(res, 404, 'approval request not found');
      if (!devices.get(pending.deviceId)?.online) return sendError(res,409,'执行设备离线，审批尚未发送。');
      if (pending.origin === 'desktop' && !devices.get(pending.deviceId)?.nativeDesktop?.connected) return sendError(res,409,'桌面连接已断开，审批尚未发送。');
      if (pending.submitting) return sendError(res,409,'审批已提交，请等待同步。');
      const decision = body.decision || 'decline';
      const result = approvalResult(pending,decision,body.content);
      pending.submitting = true; pending.error = null;
      queueCommand(pending.deviceId, { type: 'respond', sessionId: pending.sessionId, threadId:pending.params.threadId,executionOwner:pending.origin,requestId: pending.id, result });
      record(sessions.get(pending.sessionId), {type:'approval_request',sessionId:pending.sessionId,request:pending,at:Date.now()});
      return sendJson(res, 202, { ok: true });
    } catch (error) { return sendError(res, 400, error.message); }
  }

  return serveStatic(pathname, res);
}

function serveStatic(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(requested).replace(/^([.][.][\\/])+/, '');
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendError(res, 404, 'not found');
  const ext = path.extname(filePath);
  const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png' };
  const computerName=preferences.deviceNames?.[localDeviceId] || process.env.CODEX_RELAY_LOCAL_DEVICE_NAME;
  const iconTheme=preferences.deviceIconThemes?.[localDeviceId]||'auto';
  let body;
  if(requested==='/notification-worker.js'){const icon=applicationIcon(publicDir,computerName,iconTheme);body=applicationWorker(publicDir,computerName+':'+icon.version,icon.small);}
  else if(requested==='/manifest.webmanifest')body=JSON.stringify(applicationManifest(publicDir,computerName,iconTheme));
  else if(requested==='/index.html'){const icon=applicationIcon(publicDir,computerName,iconTheme);body=fs.readFileSync(filePath,'utf8').replace('href="/app-icon-192.png"',`href="${icon.small}"`).replace('href="/app-icon.svg"',`href="${icon.svg}"`);}
  else body=fs.readFileSync(filePath);
  return sendText(res, 200, body, types[ext] || 'application/octet-stream', { cacheControl: 'no-cache', validate: true });
}

const handler=(req,res)=>route(req,res).catch(error=>sendError(res,500,error.message));
const server = http.createServer(handler);
const lanAccess=new LanAccess({port,handler});
let embeddedRunner;
const pulse=setInterval(()=>{
  for(const [id,peer] of gateway.peers)if(peer.expiresAt<Date.now() || !browserAccess.authorized(peer.req,{touch:false}) || !devices.get(peer.deviceId)?.online){
    gateway.peers.delete(id);if(devices.get(peer.deviceId)?.online)gateway.call(peer.deviceId,'close',{peerId:id}).catch(()=>{});
  }
  broadcast('heartbeat',{at:Date.now()});
  for(const stream of runnerStreams.values())if(!stream.destroyed)writeSse(stream,'heartbeat',{at:Date.now()});
  for(const device of devices.values()) if(device.online && Date.now()-(device.lastSeen || 0)>35_000){device.online=false;device.runtime='reconnecting';runnerStreams.get(device.id)?.end();broadcast('device',serializeDevice(device));}
},10_000);
pulse.unref();
server.listen(port, host, () => {
  console.log(`Codex Relay listening on http://${host}:${port}`);
  console.log('Runner authentication configured');
  serviceHealth.start();
  if (process.env.CODEX_RELAY_NO_EMBEDDED !== '1') {
    embeddedRunner = supervise(process.execPath, [path.join(root, 'runner.mjs')], {
      cwd: root,
      env: { ...process.env, CODEX_RELAY_PARENT_PIPE:'1', CODEX_RELAY_SERVER: `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`, CODEX_RELAY_DEVICE_ID: localDeviceId, CODEX_RELAY_DEVICE_NAME: process.env.CODEX_RELAY_LOCAL_DEVICE_NAME || '本机 Runner', CODEX_RELAY_DEVICE_PLATFORM: `${process.platform} · 本地`, CODEX_RELAY_CWD: defaultCwd, CODEX_RELAY_TOKEN: relayToken },
      stdio: ['pipe','inherit','inherit'],windowsHide:true
    },{onState:status=>{
      const device=devices.get(localDeviceId);device.runtime=status.state;device.online=false;broadcast('device',serializeDevice(device));
      if(status.state==='restarting')console.error(`Runner 已退出，${status.delay}ms 后恢复`);
    }});
  }
});

function shutdown() {
  lanAccess.close();
  clearInterval(pulse);serviceHealth.stop();embeddedRunner?.stop();gateway.close();chatgptRelay.close();void remoteBrowser.close();
  for (const stream of runnerStreams.values()) stream.end();
  for (const res of subscribers.keys()) res.end();
  server.close(() => process.exit(0));
  setTimeout(()=>process.exit(0),1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if(process.env.CODEX_RELAY_PARENT_PIPE==='1'){process.stdin.resume();process.stdin.on('end',shutdown);}
