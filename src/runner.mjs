import readline from 'node:readline';
import {runComposerCommand,composerError} from './composer-context.mjs';
import { watch } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { RolloutReader, compactHistoryItems, messageText } from './rollout.mjs';
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { availablePermissions, threadOptions, turnOptions } from './relay-options.mjs';
import { imageReferences, mediaReferences as attachmentReferences, authorizedMediaSource, mediaDataUrl } from './media.mjs';
import {HtmlPreviewReader} from './html-preview.mjs';
import {mediaKind} from '../public/media-types.js';
import {MediaReader} from './media-reader.mjs';
import {HistoricalUsage} from './historical-usage.mjs';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { DesktopBridge } from './desktop-bridge.mjs';
import { DesktopStatusReader } from './desktop-status.mjs';
import {AccountUsageMonitor,readFreshAccountUsage,usageIdentity} from './account-usage.mjs';
import { EventBuffer } from './event-buffer.mjs';
import {hydrateImageInput} from './input-media.mjs';
import {prepareMessageEdit} from './message-edit.mjs';
import {readThreadList} from './thread-sync.mjs';
import {HistoryPoll, historyIsActive} from './history-poll.mjs';
import {readPaginatedThread,restoreCommandTiming} from './thread-history.mjs';
import {DesktopRuntimeReader} from './desktop-runtime.mjs';
import {ThreadOwnership} from './thread-ownership.mjs';
import {mergeModelCatalog,readDesktopModelCache} from './model-catalog.mjs';

const server = process.env.CODEX_RELAY_SERVER || 'http://127.0.0.1:4317';
const deviceId = process.env.CODEX_RELAY_DEVICE_ID || 'local';
const deviceName = process.env.CODEX_RELAY_DEVICE_NAME || deviceId;
const devicePlatform = process.env.CODEX_RELAY_DEVICE_PLATFORM || process.platform;
const cwd = process.env.CODEX_RELAY_CWD || process.cwd();
const token = process.env.CODEX_RELAY_TOKEN || '';
const pending = new Map();
const threadSessions = new Map();
const rolloutRoot = process.env.CODEX_SESSIONS_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
let historicalUsagePublishing=Promise.resolve();
function publishHistoricalUsage(usage){historicalUsagePublishing=historicalUsagePublishing.catch(()=>{}).then(()=>post(`/api/runner/${encodeURIComponent(deviceId)}/events`,{type:'historical_usage',usage}));return historicalUsagePublishing;}
const historyUsage=new HistoricalUsage({roots:[rolloutRoot,path.join(path.dirname(rolloutRoot),'archived_sessions')],
  cacheFile:path.join(process.env.CODEX_RELAY_DATA_DIR || path.join(cwd,'.relay-data'),'usage-history.sqlite'),
  onProgress:usage=>publishHistoricalUsage(usage).catch(()=>{})});
let rolloutIndexPromise = null;
let rpcId = 1;
let codex;
let runnerGeneration=randomUUID(),readerResetting=false;
const retiringReaders=new WeakSet();
const runnerMutations=new Set(['thread/start','thread/resume','thread/rollback','turn/start','turn/steer','turn/interrupt','thread/goal/set','thread/goal/clear']);
let lastThreadListSignature = '';
let threadListRead = null;
let hiddenCwds = new Set();
const resumedThreads = new Set();
const activeTurns = new Map();
const desktopBridge = new DesktopBridge();
const desktopStatus = new DesktopStatusReader(path.dirname(rolloutRoot));
const desktopThreads = new Set();
const desktopRuntimeStates = new Map();
const threadHistoryModes = new Map();
let nativeSubscriptions = new Set(), nativeSubscriptionSignature = '', nativeStatusSignature = '', nativeSyncing = false;
const nativeEvents = new EventBuffer(), nativeEpoch = randomUUID();
const desktopRuntime=new DesktopRuntimeReader(desktopBridge.native,{epoch:nativeEpoch});
let nativeSequence = 0, nativeFlushTask = null;
desktopBridge.native.on('notification', message => {
  const threadId = message.params?.threadId;
  if (!threadId || !nativeSubscriptions.has(threadId)) return;
  if (message.method === 'thread/status/changed') desktopRuntimeStates.set(threadId, message.params.status?.type);
  if (message.method === 'turn/started') desktopRuntimeStates.set(threadId, 'active');
  if (message.method === 'turn/completed') desktopRuntimeStates.set(threadId, 'idle');
  if (message.params.item) {
    const item = message.params.item;
    if (['agentMessage', 'userMessage', 'imageView'].includes(item.type)) message.params.item = registerHistoryMedia(threadId, [{ ...item, text: item.text || messageText(item.content) }])[0];
  }
  const runtime=desktopRuntime.observe(message);
  nativeEvents.push({ sequence: ++nativeSequence, message, at: Date.now(),...(runtime ? {desktopRuntime:runtime} : {}) });
  if (['turn/started','turn/completed','thread/status/changed','thread/reverted'].includes(message.method)) scheduleHistoryRead(threadId);
});
async function flushNativeEvents() {
  if (nativeFlushTask) return nativeFlushTask;
  if (!nativeEvents.length && !nativeEvents.dropped) return;
  nativeFlushTask = (async () => {
    const events = nativeEvents.take();
    if (await post(`/api/runner/${encodeURIComponent(deviceId)}/events`, { type: 'native_events', epoch: nativeEpoch, events })) {
      nativeEvents.ack(events);
      const gap=nativeEvents.takeGap();
      if(gap){
        // Replay the current pending RPCs and recover omitted output from disk.
        nativeSubscriptionSignature='';
        nativeEvents.push({sequence:++nativeSequence,message:{method:'runner/resyncRequired',params:gap},at:Date.now()});
      }
    }
  })();
  try { await nativeFlushTask; } finally { nativeFlushTask = null; }
}
async function syncNativeDesktop() {
  if (nativeSyncing || !desktopBridge.native.configured) return;
  nativeSyncing = true;
  const native = desktopBridge.native;
  try {
    await native.refreshConnection();
    const signature = JSON.stringify([...nativeSubscriptions].sort());
    if (native.capabilities.events && (signature !== nativeSubscriptionSignature || nativeSubscriptionSignature === '')) {
      await native.subscribe([...nativeSubscriptions]); nativeSubscriptionSignature = signature;
    }
    desktopRuntime.retain(nativeSubscriptions);
    await desktopRuntime.refresh([...new Set([...native.activeTurns.keys(),...historyCommands.keys(),...desktopRuntime.states.keys()])].filter(id=>nativeSubscriptions.has(id)));
  } catch { nativeSubscriptionSignature = ''; }
  finally {
    await flushNativeEvents();
    const states=native.connected ? [...desktopRuntime.states.values()] : [];
    const status = { connected: native.connected, capabilities: native.connected ? native.capabilities : {}, threadIds:[...nativeSubscriptions], threadStates:states,activeTurns:Object.fromEntries(states.filter(state=>state.status.type==='active' && state.turnId).map(state=>[state.threadId,state.turnId])), ...(native.connected && native.capabilities.serverRequests ? {pendingRequests:[...native.serverRequests.values()]} : {}) };
    const signature = JSON.stringify({...status,threadStates:states.map(({observedAt,revision,...state})=>state)});
    if (!nativeEvents.length && signature !== nativeStatusSignature && await post(`/api/runner/${encodeURIComponent(deviceId)}/events`, { type: 'native_status', ...status })) nativeStatusSignature = signature;
    nativeSyncing = false;
  }
}
desktopBridge.native.on('connection', connected => { if (!connected) { nativeSubscriptionSignature = ''; desktopRuntimeStates.clear();desktopRuntime.clear(); } });
const mediaReferences = new Map();
const normalizeCwd = value => String(value || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
const hiddenCommand = command => hiddenCwds.has(normalizeCwd(command.cwd));

function headers() { return { 'content-type': 'application/json', 'x-codex-relay-token': token }; }

async function post(path, payload) {
  try { const response = await fetch(`${server}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) }); return response.ok; } catch { return false; }
}

function sendRpc(sessionId, method, params, completion = null) {
  if(readerResetting)throw new Error('空闲执行器正在释放占用，请稍后重试。');
  const id = rpcId++;
  pending.set(id, { sessionId, method, completion });
  codex.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  return id;
}
function callRpc(sessionId, method, params) {
  return new Promise((resolve, reject) => {
    let id;
    const timer = setTimeout(() => { pending.delete(id); const error=new Error(method + ' 请求超时');error.ambiguous=['thread/start','turn/start','turn/steer','turn/interrupt'].includes(method);reject(error); }, 20000);
    try { id = sendRpc(sessionId, method, params, message => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}
async function readCatalog() {
  try {
    const [models, requirements, configuration] = await Promise.all([
      callRpc(null, 'model/list', { limit: 100, includeHidden: false }),
      callRpc(null, 'configRequirements/read', {}).catch(() => ({ requirements: null })),
      callRpc(null, 'config/read', { includeLayers: false }).catch(() => ({ config: {} }))
    ]);
    const modelCache=await readDesktopModelCache().catch(()=>null);
    await post(`/api/runner/${encodeURIComponent(deviceId)}/events`, { type: 'catalog', catalog: { models: mergeModelCatalog(models.data || [],modelCache), requirements: requirements.requirements,
      permissions: availablePermissions(requirements.requirements).map(({id,label}) => ({id,label})), defaultModel: configuration.config?.model || null,
      defaultEffort: configuration.config?.model_reasoning_effort || null, defaultPermission: configuration.config?.sandbox_mode || null,
      defaultServiceTier:configuration.config?.service_tier || 'default', fastModeEnabled:configuration.config?.features?.fast_mode !== false } });
  } catch (error) { await publish({ method: 'runner/error', params: { message: '模型列表读取失败：' + error.message } }, null); }
}
async function readAccountUsage(force = false) {
  return accountUsage.refresh(force);
}
const accountUsage=new AccountUsageMonitor({
  identity:()=>usageIdentity([path.join(path.dirname(rolloutRoot),'auth.json'),desktopBridge.native.endpointFile]),
  publish:usage=>post(`/api/runner/${encodeURIComponent(deviceId)}/events`,{type:'account_usage',usage}),
  read:async()=>{
    if(desktopBridge.appToolsAvailable){
      try{const data=await desktopBridge.tool('get_usage_limits',{});if(data?.rateLimits || data?.rateLimitsByLimitId)return data;}catch{}
    }
    return readFreshAccountUsage({command:await codexCommand(),
      ...(process.env.CODEX_ARGS_JSON ? {args:JSON.parse(process.env.CODEX_ARGS_JSON)} : {}),cwd,env:codexEnvironment()});
  }
});
const mediaReader=new MediaReader();
const htmlPreviewReader=new HtmlPreviewReader();
function registerHistoryMedia(threadId, items) {
  let refs = mediaReferences.get(threadId);
  if (!refs) { refs = new Map(); mediaReferences.set(threadId, refs); }
  return items.map(item => {
    const imageRefs=new Set([...imageReferences(item.text || '',item.type==='imageView' ? [{type:'image',path:item.path}] : item.content || []),...(item.images || []).map(image=>image.ref)]);
    const references = new Set([...attachmentReferences(item.text || '',item.type==='imageView' ? [{type:'image',path:item.path}] : item.content || []), ...(item.images || []).map(image => image.ref).filter(Boolean),...(item.attachments || []).map(item=>item.ref).filter(Boolean)]);
    const images = [], attachments=[];
    let text = item.text;
    for (const ref of references) {
      if (/^https?:\/\//.test(ref)) { (imageRefs.has(ref) || mediaKind(ref)==='image' ? images : attachments).push({ref}); continue; }
      let key = ref;
      if (ref.startsWith('data:')) {
        key = 'inline:' + createHash('sha256').update(ref).digest('hex');
        refs.set(key, { dataUrl: ref });
        if (text) text = text.replaceAll(ref, key);
      } else refs.set(key, { path: ref });
      (imageRefs.has(ref) || mediaKind(ref)==='image' ? images : attachments).push({ref:key});
    }
    const content = item.content?.filter(part => !['image','input_image','localImage','local_image'].includes(part.type));
    return { ...item, ...(text != null ? { text } : {}), ...(content ? { content } : {}), images, attachments };
  });
}
async function readMedia(command) {
  try {
    const source=authorizedMediaSource(command.ref,mediaReferences.get(command.threadId)?.get(command.ref),command.approvedRef);
    if(command.mediaRevision===1){
      const result=await mediaReader.read(source,command.cwd || historyCommands.get(command.threadId)?.cwd || cwd,command.ref,command);
      await post(`/api/runner/${encodeURIComponent(deviceId)}/events`,{type:'media',requestId:command.requestId,mediaRevision:1,...result});return;
    }
    const dataUrl=await mediaDataUrl(source,command.cwd || historyCommands.get(command.threadId)?.cwd || cwd);
    await post(`/api/runner/${encodeURIComponent(deviceId)}/events`, { type: 'media', requestId: command.requestId, dataUrl });
  } catch (error) { await post(`/api/runner/${encodeURIComponent(deviceId)}/events`, { type: 'media', requestId: command.requestId, error: '无法读取附件：' + error.message }); }
}

function notify(method, params) { codex.stdin.write(`${JSON.stringify({ method, params })}\n`); }

async function listThreads() {
  if (!codex?.stdin?.writable) return;
  if (threadListRead) return threadListRead;
  threadListRead = (async () => {
    const observedAt = Date.now();
    try {
      const threads = await readThreadList(cursor => callRpc(null, 'thread/list', {
        archived:false, limit:100, sortKey:'updated_at', sortDirection:'desc', useStateDbOnly:true, ...(cursor ? {cursor} : {})
      }));
      await publishThreadList({result:{data:threads}}, observedAt);
    } catch (error) { console.error('线程列表同步失败：' + error.message); }
  })();
  try { await threadListRead; } finally { threadListRead = null; }
}

function sessionForMessage(message) {
  if (message.params?.threadId && threadSessions.has(message.params.threadId)) return threadSessions.get(message.params.threadId);
  if (message.id !== undefined && pending.has(message.id)) return pending.get(message.id).sessionId;
  return null;
}

async function publish(message, sessionId = sessionForMessage(message)) {
  return post(`/api/runner/${encodeURIComponent(deviceId)}/events`, { sessionId, message });
}

async function buildRolloutIndex() {
  const index = new Map();
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(fullPath); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const matches = [...entry.name.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)];
      if (!matches.length) continue;
      let modifiedAt = 0;
      try { modifiedAt = (await stat(fullPath)).mtimeMs; } catch { /* ignore disappearing files */ }
      for (const match of matches) {
        const threadId = match[0].toLowerCase();
        const files = index.get(threadId) || [];
        files.push({ path: fullPath, modifiedAt });
        index.set(threadId, files);
      }
    }
  }
  await visit(rolloutRoot);
  for (const [threadId, files] of index) {
    const unique = [...new Map(files.map(file => [file.path, file])).values()];
    unique.sort((a, b) => a.modifiedAt - b.modifiedAt || a.path.localeCompare(b.path));
    index.set(threadId, unique.map(file => file.path));
  }
  return index;
}

async function rolloutPathsFor(threadId) {
  if (!threadId) return [];
  if (!rolloutIndexPromise) rolloutIndexPromise = buildRolloutIndex();
  const index = await rolloutIndexPromise;
  return index.get(String(threadId).toLowerCase()) || [];
}

async function enrichThreadList(threads) {
  return Promise.all((threads || []).map(async thread => {
    if (!thread?.id || thread.path) return thread;
    const paths = await rolloutPathsFor(thread.id);
    return paths.length ? { ...thread, path: paths } : thread;
  }));
}

async function publishThreadList(message, observedAt = Date.now()) {
  const threads = await enrichThreadList(message.result?.data || []);
  for (const thread of threads) if (thread.historyMode) threadHistoryModes.set(thread.id,thread.historyMode);
  const signature = JSON.stringify(threads.map(thread => ({
    id: thread?.id || null,
    name: thread?.name || null,
    preview: thread?.preview || null,
    updatedAt: thread?.updatedAt || null,
    createdAt: thread?.createdAt || null,
    status: thread?.status?.type || null,
    cwd: thread?.cwd || null,
    model: thread?.model || null,
    historyMode:thread?.historyMode || null,
    path: thread?.path || null
  })));
  if (signature === lastThreadListSignature) return;
  if (await post(`/api/runner/${encodeURIComponent(deviceId)}/events`, { type: 'thread_list', threads, complete:true, observedAt })) lastThreadListSignature = signature;
}

const historyReaders = new Map();
const historyCommands = new Map();
const historySignatures = new Map();
const historyTimers = new Map();
const historyReads = new Map();
const queuedHistoryReads = new Map();
const historyPoll = new HistoryPoll();

async function publishRolloutHistory(command) {
  if (hiddenCommand(command)) return;
  const existing = historyReads.get(command.threadId);
  if (existing) {
    const queued = queuedHistoryReads.get(command.threadId);
    queuedHistoryReads.set(command.threadId, {...queued, ...command,
      maxTurns:queued?.maxTurns === 'all' || command.maxTurns === 'all' ? 'all' : Math.max(queued?.maxTurns || 5, command.maxTurns || 5),
      force:Boolean(queued?.force || command.force)});
    return existing;
  }
  historyPoll.checked(command.threadId);
  const read = (async () => {
    try {
      const observedAt=Date.now();
      const paths = (Array.isArray(command.path) ? command.path : [command.path]).filter(Boolean);
      const maxTurns = command.maxTurns === 'all' ? Infinity : Math.max(1, Number(command.maxTurns) || 5);
      let reader = historyReaders.get(command.threadId);
      if (!reader || maxTurns > reader.maxTurns) { reader = new RolloutReader(maxTurns); historyReaders.set(command.threadId, reader); }
      historyCommands.set(command.threadId, { ...command, path: paths, maxTurns: maxTurns === Infinity ? 'all' : maxTurns });
      const paginated=threadHistoryModes.get(command.threadId)==='paginated';
      let rollout={items:[],turns:[],settings:reader.settings,tokenUsage:reader.tokenUsage};
      try {if(paths.length)rollout=await reader.read(paths);} catch(error) {if(!paginated || error.code!=='ENOENT')throw error;}
      const result = paginated
        ? {...rollout,...restoreCommandTiming(await readPaginatedThread((method,params)=>callRpc(null,method,params),command.threadId,command.maxTurns),rollout)} : rollout;
      const aliases=result.authoritative ? new Map(result.visibleTurnIds.map(id=>[id,id])) : reader.aliases;
      const turns=await desktopStatus.read(command.threadId,result.turns,aliases);
      if(nativeSubscriptions.has(command.threadId))await desktopRuntime.refresh([command.threadId]);
      if (hiddenCommand(command)) return;
      const runtime=desktopBridge.native.connected ? desktopRuntime.get(command.threadId) : undefined;
      const data = { type: 'thread_history', sessionId: command.sessionId, threadId: command.threadId, historyRevision:command.historyRevision || 0, ...result, observedAt, ...(runtime ? {desktopRuntime:runtime} : {}), turns, items: compactHistoryItems(registerHistoryMedia(command.threadId, result.items)) };
      const signature = createHash('sha256').update(JSON.stringify({...data,observedAt:undefined,desktopRuntime:runtime ? {...runtime,observedAt:undefined,revision:undefined} : undefined})).digest('hex');
      if (signature === historySignatures.get(command.threadId) && !command.force) return;
      if (await post(`/api/runner/${encodeURIComponent(deviceId)}/events`, data)) historySignatures.set(command.threadId, signature);
    } catch (error) {
      await post(`/api/runner/${encodeURIComponent(deviceId)}/events`, { sessionId: command.sessionId, message: { method: 'runner/error', params: { message: `读取线程历史失败：${error.message}` } } });
    }
  })();
  historyReads.set(command.threadId, read);
  try { await read; } finally {
    historyReads.delete(command.threadId);
    const queued = queuedHistoryReads.get(command.threadId);
    queuedHistoryReads.delete(command.threadId);
    if (queued) publishRolloutHistory(queued).catch(error=>console.error('历史同步失败：'+error.message));
  }
}

function scheduleHistoryRead(threadId) {
  if (historyTimers.has(threadId)) return;
  historyTimers.set(threadId, setTimeout(() => {
    historyTimers.delete(threadId);
    const command = historyCommands.get(threadId);
    if (command) publishRolloutHistory({ ...command, force: false });
  }, 300));
}

function watchRollouts() {
  try {
    // WAL writes carry Desktop lifecycle events even while the rollout is idle.
    const watcher=watch(path.dirname(rolloutRoot),(event,filename)=>{
      if (!/^logs_\d+\.sqlite(?:-wal)?$/.test(String(filename || ''))) return;
      for (const threadId of historyCommands.keys()) {
        const reader=historyReaders.get(threadId);
        if (reader?.turns.get(reader.order.at(-1))?.status === 'inProgress') scheduleHistoryRead(threadId);
      }
    });
    watcher.on('error',()=>watcher.close());
  } catch { /* periodic read below also recovers missed WAL events */ }
  try {
    const watcher = watch(rolloutRoot, { recursive: true }, (event, filename) => {
      if (!filename || !String(filename).endsWith('.jsonl')) return;
      const changedPath = path.resolve(rolloutRoot, String(filename)).toLowerCase();
      for (const [threadId, command] of historyCommands) {
        if (command.path.some(file => path.resolve(file.startsWith('\\\\?\\') ? file.slice(4) : file).toLowerCase() === changedPath)) scheduleHistoryRead(threadId);
      }
      if (event === 'rename') { rolloutIndexPromise = null; listThreads(); }
    });
    watcher.on('error', () => watcher.close());
  } catch { /* size checks below also recover missed filesystem events */ }
}

async function codexCommand() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (process.env.CODEX_CLI_PATH) {
    try { if ((await stat(process.env.CODEX_CLI_PATH)).isFile()) return process.env.CODEX_CLI_PATH; } catch { /* desktop path may be stale */ }
  }
  // Use the desktop runtime when present so models and protocol match Codex.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const bin = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const candidates = await Promise.all((await readdir(bin, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(async entry => {
        const file = path.join(bin, entry.name, 'codex.exe');
        try { return { file, modified: (await stat(file)).mtimeMs }; } catch { return null; }
      }));
      const latest = candidates.filter(Boolean).sort((a,b) => b.modified - a.modified)[0];
      if (latest) return latest.file;
    } catch { /* CLI installations remain supported */ }
  }
  return 'codex';
}

function codexEnvironment() {
  const env = { ...process.env };
  if (process.platform !== 'win32') return env;
  // Rust HTTP clients do not inherit the Windows proxy used by Desktop.
  // Respect explicit proxy environment variables and leave system settings alone.
  try {
    const registry = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide:true, timeout:2000, encoding:'utf8' });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(registry)) return env;
    const value = registry.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1].trim();
    if (!value) return env;
    const configured = scheme => {
      const server = /^(?:http|https|socks)=/i.test(value) ? value.split(';').find(part => part.toLowerCase().startsWith(scheme + '='))?.slice(scheme.length + 1) : value;
      if (!server || /\s/.test(server)) return null;
      return /^[a-z][a-z\d+.-]*:\/\//i.test(server) ? server : 'http://' + server;
    };
    if (!env.HTTPS_PROXY && !env.https_proxy && !env.ALL_PROXY && !env.all_proxy) env.HTTPS_PROXY = configured('https') || configured('http') || undefined;
    if (!env.HTTP_PROXY && !env.http_proxy && !env.ALL_PROXY && !env.all_proxy) env.HTTP_PROXY = configured('http') || undefined;
    if (!env.NO_PROXY && !env.no_proxy) env.NO_PROXY = 'localhost,127.0.0.1,::1';
  } catch { /* explicit proxy configuration remains available */ }
  return env;
}

async function startCodex() {
  const windows = process.platform === 'win32';
  const command = await codexCommand();
  const args = process.env.CODEX_ARGS_JSON ? JSON.parse(process.env.CODEX_ARGS_JSON) : ['app-server', '--listen', 'stdio://'];
  codex = spawn(command, args, { cwd, env: codexEnvironment(), shell: windows && !command.toLowerCase().endsWith('.exe'), windowsHide: windows });
  runnerGeneration=randomUUID();const readerProcess=codex;
  const rl = readline.createInterface({ input: readerProcess.stdout });
  rl.on('line', async line => {
    if(retiringReaders.has(readerProcess))return;
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const context = pending.get(message.id);
        pending.delete(message.id);
        if (context.completion) { context.completion(message); return; }
        if (message.result?.thread?.id) threadSessions.set(message.result.thread.id, context.sessionId);
        if (context.method === 'thread/read' && message.result?.thread) {
          for (const turn of message.result.thread.turns || []) turn.items = registerHistoryMedia(message.result.thread.id, (turn.items || []).map(item => ({ ...item, text:item.text || messageText(item.content), images:imageReferences(item.text || messageText(item.content), item.content).map(ref=>({ref})) })));
        }
        if (context.method === 'thread/list') await publishThreadList(message);
        else await post(`/api/runner/${encodeURIComponent(deviceId)}/events`, { sessionId: context.sessionId, rpcMethod: context.method, message });
      } else {
        if (['account/rateLimits/updated','account/updated'].includes(message.method)) { readAccountUsage(); return; }
        if (message.params?.item?.type==='imageView' && message.params.threadId) message.params.item=registerHistoryMedia(message.params.threadId,[message.params.item])[0];
        if (message.params?.item?.type === 'userMessage') return; // Relay already recorded lightweight user attachments.
        if (message.params?.threadId && message.params?.item?.type === 'agentMessage') {
          message.params.item = registerHistoryMedia(message.params.threadId, [message.params.item])[0];
        }
        if (message.method === 'turn/started') activeTurns.set(message.params.threadId, message.params.turn.id);
        if (message.method === 'turn/completed') activeTurns.delete(message.params.threadId);
        await publish(message);
      }
    } catch (error) { await post(`/api/runner/${encodeURIComponent(deviceId)}/events`, { sessionId: null, message: { method: 'runner/error', params: { message: error.message, line } } }); }
  });
  codex.stderr.on('data', chunk => post(`/api/runner/${encodeURIComponent(deviceId)}/events`, { sessionId: null, message: { method: 'runner/log', params: { text: String(chunk) } } }));
  codex.on('error',error=>{if(!retiringReaders.has(readerProcess)){console.error('Codex 启动失败：'+error.message);shutdown(1);}});
  codex.stdin.on('error',error=>{if(!retiringReaders.has(readerProcess)){console.error('执行器管道已关闭：'+error.message);shutdown(1);}});
  codex.on('exit',code=>{if(!stopping && !retiringReaders.has(readerProcess)){console.error(`Codex 已退出（${code}），正在恢复 Runner`);shutdown(1);}});
  await callRpc(null, 'initialize', { clientInfo: { name: 'codex-relay-runner', title: 'Codex Relay Runner', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  notify('initialized', {});
  listThreads();
}

const ownership=new ThreadOwnership({
  rpc:(method,params)=>callRpc(null,method,params),native:desktopBridge.native,
  identity:()=>({pid:codex?.pid,generation:runnerGeneration}),active:()=>activeTurns.size>0,
  pendingMutation:()=>[...pending.values()].some(request=>runnerMutations.has(request.method)),
  reset:async expected=>{
    if(codex?.pid!==expected.pid || runnerGeneration!==expected.generation || activeTurns.size || [...pending.values()].some(request=>runnerMutations.has(request.method)))throw new Error('执行器状态已变化，未释放。');
    const previous=codex;readerResetting=true;retiringReaders.add(previous);
    for(const [id,request] of pending){pending.delete(id);request.completion?.({error:{message:'空闲执行器已释放，请重新读取状态。'}});}
    try{
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>previous.kill(),3000),deadline=setTimeout(()=>reject(new Error('执行器尚未退出，未启动第二个进程。')),6000);
        previous.once('exit',()=>{clearTimeout(timer);clearTimeout(deadline);resolve();});previous.stdin.end();
      });
      resumedThreads.clear();activeTurns.clear();
      for(const id of expected.threadIds)desktopThreads.add(id);
      await post(`/api/runner/${encodeURIComponent(deviceId)}/events`,{type:'runner_threads_released',threadIds:expected.threadIds});
      readerResetting=false;await startCodex();
    }finally{readerResetting=false;}
  }
});

async function handleCommand(command) {
  if (!codex) await startCodex();
  if (command.type === 'startThread') {
    try {
      const desktop=command.executionMode==='desktop';
      if(desktop){await desktopBridge.native.refreshConnection();if(!desktopBridge.native.capabilities.createThreads)throw new Error('当前桌面代理不支持双端新建，未改用独立执行。请在方便时通过原生入口重新打开 Codex。');}
      const params={cwd:command.cwd,...threadOptions(command),...(command.ephemeral ? {ephemeral:true} : {})};
      const result=desktop ? await desktopBridge.native.request('thread/start',params) : await callRpc(command.sessionId,'thread/start',params);
      if(!result.thread?.id)throw new Error('执行端未返回对话编号，请先刷新核对，不要重复创建。');
      threadSessions.set(result.thread.id,command.sessionId);
      if(desktop){desktopThreads.add(result.thread.id);nativeSubscriptions.add(result.thread.id);nativeSubscriptionSignature='';}else resumedThreads.add(result.thread.id);
      await post(`/api/runner/${encodeURIComponent(deviceId)}/events`, {sessionId:command.sessionId,rpcMethod:'thread/start',...(desktop ? {origin:'desktop'} : {}),message:{id:rpcId++,result}});
      if(desktop)await syncNativeDesktop();
    } catch (error) { await publish({ method:'runner/error', params:{message:error.message,ambiguous:Boolean(error.ambiguous)} }, command.sessionId); }
  } else if(command.type==='editMessage') {
    const recoveryDirectory=path.join(process.env.CODEX_RELAY_DATA_DIR || path.dirname(desktopBridge.native.endpointFile),'edit-recovery');
    try {
      if(command.recoverySourceId) {
        if(!/^[a-zA-Z0-9_-]{16,80}$/.test(command.recoverySourceId))throw new Error('无效的编辑恢复编号。');
        const saved=JSON.parse(await readFile(path.join(recoveryDirectory,command.recoverySourceId+'.json'),'utf8'));
        if(saved.threadId!==command.threadId)throw new Error('编辑恢复记录与当前对话不匹配。');
        command={...command,recoveryInput:[...saved.input.slice(0,saved.prefixLength),...(command.text ? [{type:'text',text:command.text}] : []),...saved.input.slice(saved.prefixLength).filter(part=>part.type!=='text')]};
      }
      const beforeRollback=async plan=>{
        if(!/^[a-zA-Z0-9_-]{16,80}$/.test(command.deliveryId))throw new Error('无效的编辑编号。');
        await mkdir(recoveryDirectory,{recursive:true});
        await writeFile(path.join(recoveryDirectory,command.deliveryId+'.json'),JSON.stringify({threadId:command.threadId,input:plan.input,prefixLength:plan.prefixLength}),{mode:0o600});
      };
      const onRollback=async thread=>{
        const clean={...thread,turns:(thread.turns || []).map(turn=>({...turn,items:registerHistoryMedia(command.threadId,turn.items || [])}))};
        const accepted=await publish({method:'runner/editRolledBack',params:{deliveryId:command.deliveryId,thread:clean}},command.sessionId);
        if(!accepted){const error=new Error('对话已回到编辑位置，但同步结果待确认；编辑内容和图片已保存，请先恢复连接。');error.ambiguous=true;throw error;}
      };
      threadSessions.set(command.threadId,command.sessionId);
      if(command.executionOwner==='desktop' || desktopThreads.has(command.threadId)) {
        const result=await desktopBridge.native.edit(command,{beforeRollback,onRollback});
        await publish({method:'runner/desktopAccepted',params:{threadId:command.threadId,result,deliveryId:command.deliveryId,action:'edit'}},command.sessionId);
      } else {
        let {thread}=await callRpc(command.sessionId,'thread/read',{threadId:command.threadId,includeTurns:true});
        if(!resumedThreads.has(command.threadId)) {
          await callRpc(command.sessionId,'thread/resume',{threadId:command.threadId,excludeTurns:true});resumedThreads.add(command.threadId);
          ({thread}=await callRpc(command.sessionId,'thread/read',{threadId:command.threadId,includeTurns:true}));
        }
        const plan=prepareMessageEdit(thread,command);
        if(plan.numTurns) {await beforeRollback(plan);const result=await callRpc(command.sessionId,'thread/rollback',{threadId:command.threadId,numTurns:plan.numTurns});command.rolledBack=true;await onRollback(result.thread);}
        await callRpc(command.sessionId,'turn/start',{threadId:command.threadId,input:plan.input,...turnOptions(command)});
      }
    } catch(error) {await publish({method:'runner/actionError',params:{action:'edit',message:error.message,ambiguous:Boolean(error.ambiguous),rolledBack:Boolean(error.rolledBack || command.rolledBack)}},command.sessionId);}
  } else if (command.type === 'startTurn') {
    try {
      const input=await hydrateImageInput(command.input || [{type:'text',text:command.text}],async id=>{
        const response=await fetch(`${server}/api/runner/${encodeURIComponent(deviceId)}/uploads/${id}`,{headers:{'x-codex-relay-token':token},signal:AbortSignal.timeout(120000)});
        if(!response.ok)throw new Error('图片读取失败，输入尚未提交，请重试。');
        return (await response.json()).dataUrl;
      });
      command={...command,input};
      threadSessions.set(command.threadId, command.sessionId);
      if (command.executionOwner === 'desktop' || desktopThreads.has(command.threadId)) return await sendThroughDesktop(command);
      if (command.mode === 'steer') {
        const expectedTurnId = command.expectedTurnId || activeTurns.get(command.threadId);
        if (!expectedTurnId) throw new Error('当前回合已经结束，追加内容尚未发送。');
        await callRpc(command.sessionId, 'turn/steer', { threadId: command.threadId, expectedTurnId, input: command.input || [{type:'text',text:command.text}] });
        await publish({method:'runner/steerAccepted',params:{threadId:command.threadId,turnId:expectedTurnId}},command.sessionId);
        return;
      }
      if (!resumedThreads.has(command.threadId)) {
        try { await callRpc(command.sessionId, 'thread/resume', { threadId: command.threadId, cwd: command.cwd, ...threadOptions(command), excludeTurns:true }); }
        catch (error) {
          if (!/already has an active writer/i.test(error.message)) throw error;
          if (!desktopBridge.available) throw new Error('这条对话由桌面 Codex 占用。桌面通信入口未连接，请从桌面任务启动 Relay 后重试；输入内容已保留。');
          return await sendThroughDesktop(command);
        }
        resumedThreads.add(command.threadId);
      }
      const result = await callRpc(command.sessionId, 'turn/start', { threadId: command.threadId, input: command.input || [{ type: 'text', text: command.text }], ...turnOptions(command) });
      activeTurns.set(command.threadId, result.turn.id);
    } catch (error) { await publish({ method:command.mode === 'steer' || command.queuedStart ? 'runner/actionError' : 'runner/error', params:{action:command.queuedStart ? 'queued' : 'steer',message:error.message,ambiguous:Boolean(error.ambiguous),...(error.retryActive ? {retryActive:true,activeTurnId:error.activeTurnId} : {})} }, command.sessionId); }
  } else if (command.type === 'readThread') {
    if (hiddenCommand(command)) return;
    const rolloutPaths = await rolloutPathsFor(command.threadId);
    if (threadHistoryModes.get(command.threadId)==='paginated' || rolloutPaths.length) await publishRolloutHistory({ ...command, path: rolloutPaths });
    else if (command.path) await publishRolloutHistory(command);
    else sendRpc(command.sessionId, 'thread/read', { threadId: command.threadId, includeTurns: true });
  } else if (command.type === 'listThreads') {
    listThreads();
  } else if (command.type === 'interrupt') {
    if ((command.executionOwner === 'desktop' || desktopThreads.has(command.threadId)) && desktopBridge.native.configured) {
      try { await desktopBridge.native.interrupt(command); }
      catch (error) { await publish({ method:'runner/actionError', params:{action:'interrupt',message:error.message,ambiguous:Boolean(error.ambiguous)} }, command.sessionId); }
      return;
    }
    const turnId = command.turnId || activeTurns.get(command.threadId);
    try {
      if (!turnId) throw new Error('当前回合已经结束，无法中断。');
      await callRpc(command.sessionId,'turn/interrupt',{threadId:command.threadId,turnId});
    } catch(error) { await publish({method:'runner/actionError',params:{action:'interrupt',message:error.message,ambiguous:Boolean(error.ambiguous)}},command.sessionId); }
  } else if(command.type==='composerContext'){
    try{const result=command.operation==='ownership' ? await ownership.read(command.threadId) : command.operation==='releaseRunner' ? await ownership.release(command.threadId,command.expected) : await runComposerCommand(command,{rpc:callRpc,native:desktopBridge.native});await post(`/api/runner/${encodeURIComponent(deviceId)}/events`,{type:'composer_context_reply',requestId:command.requestId,result});}
    catch(error){await post(`/api/runner/${encodeURIComponent(deviceId)}/events`,{type:'composer_context_reply',requestId:command.requestId,error:composerError(error)});}
  } else if (command.type === 'readCatalog') {
    await readCatalog();
  } else if (command.type === 'readUsage') {
    await readAccountUsage(true);
  } else if(command.type==='readHistoricalUsage') {
    try{const usage=await historyUsage.read();await publishHistoricalUsage(usage);}
    catch(error){await publishHistoricalUsage({status:'error',error:error.message});}
  } else if(command.type==='queryHistoricalUsage') {
    try{const usage=await historyUsage.query(command.range);await post(`/api/runner/${encodeURIComponent(deviceId)}/events`,{type:'historical_usage_query',requestId:command.requestId,usage});}
    catch(error){await post(`/api/runner/${encodeURIComponent(deviceId)}/events`,{type:'historical_usage_query',requestId:command.requestId,error:error.message});}
  } else if(command.type==='readHtmlPreview'){
    try{const result=await htmlPreviewReader.read(command);await post(`/api/runner/${encodeURIComponent(deviceId)}/events`,{type:'media',requestId:command.requestId,...result});}
    catch(error){await post(`/api/runner/${encodeURIComponent(deviceId)}/events`,{type:'media',requestId:command.requestId,error:'无法打开 HTML 预览：'+error.message});}
  } else if (command.type === 'readMedia') {
    await readMedia(command);
  } else if (command.type === 'projectSubscriptions') {
    hiddenCwds = new Set(command.hiddenCwds.map(normalizeCwd));
    nativeSubscriptions = new Set(command.threadIds || []);
    syncNativeDesktop();
    for (const [threadId, tracked] of historyCommands) if (hiddenCommand(tracked) || !nativeSubscriptions.has(threadId)) {
      clearTimeout(historyTimers.get(threadId)); historyTimers.delete(threadId);
      historyCommands.delete(threadId); historyReaders.delete(threadId); historySignatures.delete(threadId); mediaReferences.delete(threadId);
      queuedHistoryReads.delete(threadId); historyPoll.forget(threadId);
      desktopRuntimeStates.delete(threadId);
      desktopStatus.forget(threadId);
    }
  } else if (command.type === 'answerQuestion') {
    try {
      await desktopBridge.answer(command);
      await publish({method:'runner/questionAnswered',params:{itemId:command.itemId,answers:command.answers,delivery:'question'}},command.sessionId);
      scheduleHistoryRead(command.threadId);
    } catch(error) { await publish({method:'runner/questionAnswerError',params:{itemId:command.itemId,message:error.message}},command.sessionId); }
  } else if (command.type === 'respond') {
    try {
      if (command.executionOwner === 'desktop') await desktopBridge.native.respond(command);
      else codex.stdin.write(`${JSON.stringify({ id: command.requestId, result: command.result })}\n`);
      await publish({method:'runner/responseSubmitted',params:{requestId:command.requestId,itemId:command.itemId}},command.sessionId);
    } catch(error) { await publish({method:'runner/responseError',params:{requestId:command.requestId,itemId:command.itemId,message:error.message,ambiguous:Boolean(error.ambiguous)}},command.sessionId); }
  }
}

async function sendThroughDesktop(command) {
  const paths=await rolloutPathsFor(command.threadId);
  if (command.permission && !historyReaders.get(command.threadId)?.settings?.permission && paths.length) {
    await publishRolloutHistory({type:'readThread',sessionId:command.sessionId,threadId:command.threadId,cwd:command.cwd,path:paths,maxTurns:5});
  }
  const settings=historyReaders.get(command.threadId)?.settings || {};
  const result = await desktopBridge.send(command, settings.permission, settings.serviceTier);
  desktopThreads.add(command.threadId);
  await publish({method:'runner/desktopAccepted',params:{threadId:command.threadId, model:command.model, effort:command.effort, result}},command.sessionId);
  if (paths.length) await publishRolloutHistory({type:'readThread',sessionId:command.sessionId,threadId:command.threadId,cwd:command.cwd,path:paths,maxTurns:command.maxTurns || 5});
}

async function connectCommands() {
  while (true) {
    const abort=new AbortController();let received=Date.now();
    const watchdog=setInterval(()=>{if(Date.now()-received>35_000)abort.abort();},5000);
    try {
    const query = new URLSearchParams({ name: deviceName, platform: devicePlatform, cwd, version:process.env.CODEX_RELAY_RELEASE_ID || '' });
      const response = await fetch(`${server}/api/runner/${encodeURIComponent(deviceId)}/commands?${query}`, { headers: headers(),signal:abort.signal });
      if (!response.ok || !response.body) throw new Error(`command stream ${response.status}`);
      await post(`/api/runner/${encodeURIComponent(deviceId)}/events`,{type:'runtime',runtime:'ready',desktopThreadCreateRevision:1,ownershipRevision:1});
      lastThreadListSignature = '';
      historySignatures.clear();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received=Date.now();
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n'); buffer = frames.pop() || '';
        for (const frame of frames) {
          if(frame.startsWith('event: heartbeat'))continue;
          const data = frame.split('\n').find(line => line.startsWith('data:'))?.slice(5).trim();
          if (data) {
            const command=JSON.parse(data);
            if (['readThread','readCatalog','readUsage','readHistoricalUsage','queryHistoricalUsage','composerContext'].includes(command.type) && command.operation!=='releaseRunner') handleCommand(command).catch(error=>console.error('读取状态失败：'+error.message));
            else await handleCommand(command);
          }
        }
      }
    } catch { /* reconnect below; never repeat a dispatched command */ }
    finally {clearInterval(watchdog);abort.abort();}
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

let stopping=false;
function shutdown(code=0){if(stopping)return;stopping=true;desktopBridge.close();codex?.kill();process.exit(code);}
process.on('SIGINT',()=>shutdown());process.on('SIGTERM',()=>shutdown());
if(process.env.CODEX_RELAY_PARENT_PIPE==='1'){process.stdin.resume();process.stdin.on('end',()=>shutdown());}
await startCodex();
readAccountUsage();
await post(`/api/runner/${encodeURIComponent(deviceId)}/events`,{type:'runtime',runtime:'ready',desktopThreadCreateRevision:1,ownershipRevision:1});
connectCommands();
// Desktop logs trigger updates immediately; list polling is only for discovery.
watchRollouts();
setInterval(flushNativeEvents, 50);
setInterval(syncNativeDesktop, 2000);
syncNativeDesktop();
setInterval(() => { if (codex) listThreads(); }, 15_000);
// Refresh the model directory after Desktop updates or account changes without
// restarting the running Relay or interrupting a Codex task.
setInterval(() => { if (codex) readAccountUsage(); }, 300_000);
setInterval(()=>accountUsage.check().catch(error=>console.error('账号额度状态检查失败：'+error.message)),10000);
setInterval(() => {
  for (const threadId of historyCommands.keys()) {
    const active = historyIsActive(historyReaders.get(threadId), activeTurns.get(threadId) || desktopBridge.native.activeTurns.get(threadId), activeTurns.has(threadId) ? 'active' : desktopRuntime.get(threadId)?.status.type || desktopRuntimeStates.get(threadId));
    if (historyPoll.due(threadId, active)) scheduleHistoryRead(threadId);
  }
}, 1000);
setInterval(() => post(`/api/runner/${encodeURIComponent(deviceId)}/heartbeat`, { at: Date.now() }), 10_000);
