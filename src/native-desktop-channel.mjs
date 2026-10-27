import net from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './layout.mjs';
import { threadOptions, turnOptions } from './relay-options.mjs';
import { EventEmitter } from 'node:events';
import { nativeRequestMethods, validateNativeResponse } from '../public/native-requests.js';
import {prepareMessageEdit} from './message-edit.mjs';

const MAX_FRAME = 80 * 1024 * 1024;
const ALLOWED = new Set(['thread/start','thread/read', 'thread/resume', 'thread/rollback', 'turn/start', 'turn/steer', 'turn/interrupt','thread/goal/get','thread/goal/set','thread/goal/clear']);
const MUTATING = new Set(['thread/start','thread/resume','thread/rollback', 'turn/start', 'turn/steer', 'turn/interrupt', 'relay/respond','thread/goal/set','thread/goal/clear']);
const CAPABILITIES = { steer: true, interrupt: true, events: true, serverRequests: true, edit: true,goals:true,createThreads:true };
const key = id => typeof id + ':' + String(id);
const send = (stream, message) => stream.write(JSON.stringify(message) + '\n');

export const nativeEndpointFile = env => env.CODEX_RELAY_NATIVE_ENDPOINT ||
  path.join(env.CODEX_RELAY_DATA_DIR || path.join(projectRoot, '.relay-data'), 'native-desktop.json');

function readFrames(stream, receive, failed) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(frame) > MAX_FRAME) { failed(new Error('Native frame too large')); return; }
      if (!frame.trim()) continue;
      try { receive(JSON.parse(frame)); } catch (error) { failed(error); return; }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME) failed(new Error('Native frame too large'));
  });
}

// This proxy owns the existing Desktop child, not a second writer. Desktop's
// initialize, server requests and responses remain on its original stdio path.
// Relay may submit only the documented thread/turn RPCs listed above.
export class NativeDesktopHost {
  constructor({ endpointFile, writeCore, writeDesktop, pid = process.pid }) {
    this.endpointFile = endpointFile; this.writeCore = writeCore; this.writeDesktop = writeDesktop;
    this.pid = pid; this.token = randomBytes(32).toString('hex');
    this.prefix = 'relay-native-' + randomUUID() + ':';
    this.nextId = 1; this.pending = new Map(); this.peers = new Set();
    this.activeTurns = new Map(); this.initialized = false; this.initializationIds = new Set();
    this.serverRequests = new Map(); this.resolvedRequests = new Set();
  }
  async listen() {
    await mkdir(path.dirname(this.endpointFile), { recursive: true });
    this.pipe = process.platform === 'win32' ? '\\\\.\\pipe\\codex-relay-native-' + randomUUID() :
      path.join(path.dirname(this.endpointFile), 'native-' + randomUUID() + '.sock');
    this.server = net.createServer(socket => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject); this.server.listen(this.pipe, resolve);
    });
    const temporary = this.endpointFile + '.' + this.pid + '.tmp';
    await writeFile(temporary, JSON.stringify({ version: 1, pid: this.pid, pipe: this.pipe, token: this.token }), { mode: 0o600 });
    await rename(temporary, this.endpointFile);
  }
  accept(socket) {
    socket.on('error', () => {});
    const peer = { socket, authenticated: false, threads: new Set() };
    this.peers.add(peer);
    const authTimer = setTimeout(() => socket.destroy(), 3000);
    socket.on('close', () => {
      clearTimeout(authTimer); this.peers.delete(peer);
      // Keep response tombstones so a late Relay reply never reaches Desktop.
      for (const request of this.pending.values()) if (request.peer === peer) request.peer = null;
    });
    readFrames(socket, message => {
      if (!peer.authenticated) {
        const supplied = typeof message.token === 'string' ? Buffer.from(message.token) : Buffer.alloc(0);
        const expected = Buffer.from(this.token);
        if (message.type !== 'hello' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          socket.destroy(); return;
        }
        peer.authenticated = true; clearTimeout(authTimer);
        send(socket, { type: 'ready', version: 1, initialized: this.initialized, capabilities: CAPABILITIES, activeTurns: Object.fromEntries(this.activeTurns) });
        return;
      }
      if (message.id != null && message.method === 'relay/subscribe') {
        const ids = message.params?.threadIds;
        if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id.trim())) {
          send(socket, { id: message.id, error: { message: 'Invalid native subscriptions' } }); return;
        }
        peer.threads = new Set(ids);
        send(socket, { id: message.id, result: { activeTurns: Object.fromEntries([...this.activeTurns].filter(([id]) => peer.threads.has(id))), pendingRequests: [...this.serverRequests.values()].filter(request => peer.threads.has(request.params.threadId)).map(request => ({threadId:request.params.threadId,requestId:request.id})) } });
        for (const request of this.serverRequests.values()) if (peer.threads.has(request.params.threadId)) send(socket, request);
        return;
      }
      if (message.id != null && message.method === 'relay/respond') {
        const params = message.params || {}, request = this.serverRequests.get(key(params.requestId));
        try {
          if (!request || request.params.threadId !== params.threadId || !peer.threads.has(params.threadId)) throw new Error('这个请求已回答或已过期，请查看最新状态。');
          validateNativeResponse(request, params.result);
          this.claimRequest(request.id, 'relay');
          this.writeCore({ id: request.id, result: params.result });
          send(socket, { id: message.id, result: { submitted: true } });
        } catch (error) { send(socket, { id: message.id, error: { message: error.message } }); }
        return;
      }
      if (message.id == null || !ALLOWED.has(message.method) || !message.params ||
          (message.method==='thread/start' ? typeof message.params.cwd!=='string' || !message.params.cwd.trim() : typeof message.params.threadId !== 'string' || !message.params.threadId.trim())) {
        send(socket, { id: message.id, error: { message: 'Unsupported native Desktop request' } }); return;
      }
      if (!this.initialized) {
        send(socket, { id: message.id, error: { message: '桌面 Codex 尚未初始化，请稍后重试。' } }); return;
      }
      if(message.method==='thread/rollback' && (!Number.isInteger(message.params.numTurns) || message.params.numTurns<1 || this.activeTurns.has(message.params.threadId))) {
        send(socket,{id:message.id,error:{message:'原回合仍在运行或编辑参数无效，未修改对话。'}});return;
      }
      if(message.method==='thread/goal/set' && (message.params.origin!=='user' || !['active','paused'].includes(message.params.status)) || message.method==='thread/goal/clear' && message.params.origin!=='user'){
        send(socket,{id:message.id,error:{message:'目标控制需要明确的用户操作。'}});return;
      }
      if (this.pending.size >= 2048) {
        send(socket, { id: message.id, error: { message: '桌面连接繁忙，请稍后重试。' } }); return;
      }
      const id = this.prefix + this.nextId++;
      this.pending.set(key(id), { peer, id: message.id, method: message.method, threadId: message.params.threadId });
      try { this.writeCore({ id, method: message.method, params: message.params }); }
      catch (error) { this.pending.delete(key(id)); send(socket, { id: message.id, error: { message: error.message } }); }
    }, () => socket.destroy());
  }
  fromDesktop(message) {
    if (message.method === 'initialize' && message.id != null) this.initializationIds.add(key(message.id));
    if (!message.method && message.id != null) {
      if (this.resolvedRequests.has(key(message.id))) return;
      if (this.serverRequests.has(key(message.id))) this.claimRequest(message.id, 'desktop');
    }
    this.writeCore(message);
    if (message.method === 'initialized') this.initialized = true;
  }
  fromCore(message) {
    // Desktop builds may start RPCs after initialize succeeds without sending
    // a separate initialized notification. Observe its actual handshake reply.
    if (message.id != null && this.initializationIds.delete(key(message.id)) &&
        !message.error && Object.hasOwn(message, 'result')) this.initialized = true;
    if (message.method === 'turn/started') this.activeTurns.set(message.params.threadId, message.params.turn.id);
    if (message.method === 'thread/archived' || message.method === 'thread/status/changed' && ['idle','notLoaded','systemError'].includes(message.params.status?.type)) this.activeTurns.delete(message.params.threadId);
    if (message.method === 'turn/completed') {
      this.activeTurns.delete(message.params.threadId);
      for (const request of this.serverRequests.values()) if (request.params.threadId === message.params.threadId) this.claimRequest(request.id);
    }
    if (message.method === 'serverRequest/resolved') this.claimRequest(message.params.requestId);
    const request = message.id == null ? null : this.pending.get(key(message.id));
    if (request) {
      this.pending.delete(key(message.id));
      if(request.method==='thread/start' && !message.error && message.result?.thread?.id && request.peer)request.peer.threads.add(message.result.thread.id);
      if (request.method === 'turn/start' && message.result?.turn?.id) this.activeTurns.set(request.threadId, message.result.turn.id);
      if (request.peer && !request.peer.socket.destroyed) send(request.peer.socket, { ...message, id: request.id });
      return;
    }
    // Ignore expired Relay replies, including after a disconnect.
    if (typeof message.id === 'string' && message.id.startsWith(this.prefix)) return;
    if (message.id != null && nativeRequestMethods.has(message.method) && message.params?.threadId) {
      this.resolvedRequests.delete(key(message.id)); this.serverRequests.set(key(message.id), message);
    }
    this.writeDesktop(message);
    const lifecycle = ['turn/started', 'turn/completed', 'thread/status/changed', 'thread/archived'].includes(message.method);
    const notification = message.id == null && /^(thread\/|turn\/|item\/|serverRequest\/|error$)/.test(message.method || '');
    const serverRequest = message.id != null && nativeRequestMethods.has(message.method);
    if (notification || serverRequest) this.broadcast(message, lifecycle);
  }
  broadcast(message, lifecycle = false) {
    for (const peer of this.peers) if (peer.authenticated && !peer.socket.destroyed && (lifecycle || peer.threads.has(message.params?.threadId))) {
      if (peer.socket.writableLength > 1024 * 1024) peer.socket.destroy();
      else send(peer.socket,message);
    }
  }
  claimRequest(id, winner) {
    const request = this.serverRequests.get(key(id));
    this.serverRequests.delete(key(id)); this.resolvedRequests.add(key(id));
    if (request && winner) this.broadcast({method:'relay/requestClaimed',params:{threadId:request.params.threadId,requestId:id,winner}});
    if (this.resolvedRequests.size > 4096) this.resolvedRequests.delete(this.resolvedRequests.values().next().value);
  }
  async close() {
    for (const peer of this.peers) peer.socket.destroy();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
    this.pending.clear(); this.initializationIds.clear();
    try {
      const record = JSON.parse(await readFile(this.endpointFile, 'utf8'));
      if (record.token === this.token) await unlink(this.endpointFile);
    } catch { /* a newer Desktop process may already own the endpoint */ }
    if (process.platform !== 'win32' && this.pipe) await unlink(this.pipe).catch(() => {});
  }
}

export class NativeDesktopClient extends EventEmitter {
  constructor(env = process.env, timeout = 20_000) {
    super();
    this.endpointFile = nativeEndpointFile(env); this.timeout = timeout;
    this.pending = new Map(); this.nextId = 1; this.activeTurns = new Map();
    this.capabilities = {}; this.threadIds = new Set(); this.serverRequests = new Map(); this.connected = false;
  }
  get configured() { return existsSync(this.endpointFile) || existsSync(path.join(path.dirname(this.endpointFile), 'native-desktop-required.json')); }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.open().catch(error => { this.close(); throw error; });
    return this.ready;
  }
  async open() {
    let record;
    try { record = JSON.parse(await readFile(this.endpointFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('桌面原生入口尚未启动。请结束当前桌面回合，关闭 Codex 后使用 Relay 桌面入口重新打开；输入已保留。');
      throw error;
    }
    const validPipe = typeof record.pipe === 'string' && (process.platform === 'win32' ?
      record.pipe.startsWith('\\\\.\\pipe\\codex-relay-native-') :
      path.dirname(path.resolve(record.pipe)) === path.dirname(path.resolve(this.endpointFile)));
    if (record.version !== 1 || !validPipe || !/^[a-f0-9]{64}$/.test(record.token)) throw new Error('桌面原生连接记录无效，请重新启动原生连接入口。');
    this.endpointToken = record.token;
    await new Promise((resolve, reject) => {
      const socket = this.socket = net.createConnection(record.pipe);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('桌面原生连接超时，请从 Relay 桌面入口重新启动 Codex。')); }, 5000);
      const fail = error => { clearTimeout(timer); reject(error); if (this.socket === socket) this.disconnect(error); };
      socket.on('error', fail);
      socket.on('close', () => fail(new Error('桌面原生连接已关闭。请确认是否收到消息，避免重复发送。')));
      readFrames(socket, message => {
        if (message.type === 'ready') {
          clearTimeout(timer);
          if (message.version !== 1 || !message.initialized) { fail(new Error('桌面 Codex 尚未初始化，请稍后重试。')); socket.destroy(); return; }
          this.activeTurns = new Map(Object.entries(message.activeTurns || {}));
          this.capabilities = message.capabilities || { steer: true, interrupt: true };
          this.serverRequests.clear();
          this.connected = true; this.emit('connection', true); resolve(); return;
        }
        if (message.method === 'turn/started') this.activeTurns.set(message.params.threadId, message.params.turn.id);
        if (message.method === 'thread/archived' || message.method === 'thread/status/changed' && ['idle','notLoaded','systemError'].includes(message.params.status?.type)) this.activeTurns.delete(message.params.threadId);
        if (message.method === 'turn/completed' && this.activeTurns.get(message.params.threadId)===message.params.turn.id) this.activeTurns.delete(message.params.threadId);
        if (message.method) {
          if (message.id != null && nativeRequestMethods.has(message.method)) this.serverRequests.set(key(message.id), {threadId:message.params.threadId,requestId:message.id});
          if (message.method === 'serverRequest/resolved') this.serverRequests.delete(key(message.params.requestId));
          if (message.method === 'turn/completed') for (const [id, request] of this.serverRequests) if (request.threadId === message.params.threadId) this.serverRequests.delete(id);
          this.emit('notification', message); return;
        }
        const request = this.pending.get(message.id); if (!request) return;
        if (request.method === 'relay/subscribe' && !message.error) {
          for (const threadId of this.threadIds) this.activeTurns.delete(threadId);
          for (const [threadId, turnId] of Object.entries(message.result.activeTurns || {})) this.activeTurns.set(threadId, turnId);
          this.serverRequests = new Map((message.result.pendingRequests || []).map(request => [key(request.requestId),request]));
        }
        clearTimeout(request.timer); this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }, fail);
      socket.once('connect', () => send(socket, { type: 'hello', token: record.token }));
    });
  }
  async subscribe(threadIds) {
    await this.connect();
    this.threadIds = new Set(threadIds);
    if (!this.capabilities.events) return;
    await this.request('relay/subscribe', { threadIds: [...this.threadIds] });
  }
  async refreshConnection() {
    if (this.connected) {
      try {
        const record = JSON.parse(await readFile(this.endpointFile,'utf8'));
        if (record.token !== this.endpointToken) this.close();
      } catch { this.close(); }
    }
    return this.connect();
  }
  async respond(command) {
    await this.connect();
    if (!this.capabilities.serverRequests) throw new Error('桌面代理尚未加载提问和审批支持，请使用原生入口重新打开桌面。');
    return this.request('relay/respond', { threadId: command.threadId, requestId: command.requestId, result: command.result });
  }
  async request(method, params) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error('桌面原生请求超时，请先确认对话是否收到，避免重复发送。');
        error.ambiguous = MUTATING.has(method); reject(error);
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { send(this.socket, { id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async edit(command,{beforeRollback=async()=>{},onRollback=async()=>{}}={}) {
    await this.connect();
    if(!this.capabilities.edit)throw new Error('当前桌面代理尚未加载消息编辑支持；请在方便时用现有原生入口重新打开桌面。');
    let {thread}=await this.request('thread/read',{threadId:command.threadId,includeTurns:true});
    if(thread?.status?.type==='notLoaded') {
      await this.request('thread/resume',{threadId:command.threadId,excludeTurns:true});
      ({thread}=await this.request('thread/read',{threadId:command.threadId,includeTurns:true}));
    }
    const plan=prepareMessageEdit(thread,command);
    let rolledBack=false;
    try {
      if(plan.numTurns) {
        await beforeRollback(plan);
        const result=await this.request('thread/rollback',{threadId:command.threadId,numTurns:plan.numTurns});
        rolledBack=true;this.activeTurns.delete(command.threadId);
        await onRollback(result.thread);
      }
      const result=await this.request('turn/start',{threadId:command.threadId,input:plan.input,...turnOptions(command)});
      if(result.turn?.id)this.activeTurns.set(command.threadId,result.turn.id);
      return result;
    } catch(error) {error.rolledBack=rolledBack || Boolean(command.recoveryInput);throw error;}
  }
  async send(command) {
    const { threadId } = command;
    if (command.mode === 'steer') {
      await this.connect();
      const expectedTurnId = command.expectedTurnId || this.activeTurns.get(threadId);
      if (!expectedTurnId) throw new Error('当前回合已经结束，追加内容尚未发送。');
      const result = await this.request('turn/steer', { threadId, expectedTurnId, input: command.input || [{ type: 'text', text: command.text }] });
      return { threadId, delivery: 'native', status: 'sent', ...result };
    }
    const { thread } = await this.request('thread/read', { threadId, includeTurns: false });
    if (!thread || thread.id !== threadId) throw new Error('桌面没有返回原对话，请重新选择对话。');
    if(command.queuedStart && thread.status?.type==='active') {
      const error=new Error('桌面已经开始新的回合，消息仍保留在待发送列表。');
      error.retryActive=true;error.activeTurnId=this.activeTurns.get(threadId);throw error;
    }
    if(command.queuedStart)this.activeTurns.delete(threadId);
    if (thread.status?.type === 'notLoaded') await this.request('thread/resume', {
      threadId, ...(command.cwd ? { cwd: command.cwd } : {}), ...threadOptions(command), excludeTurns: true
    });
    const input = command.input || [{ type: 'text', text: command.text }];
    const active = this.activeTurns.get(threadId);
    if (active) {
      try {
        const result = await this.request('turn/steer', { threadId, expectedTurnId: active, input });
        return { threadId, delivery: 'native', status: 'sent', ...result };
      } catch (error) {
        // Retry only an explicit, unaccepted stale-turn error; never an uncertain delivery.
        if (error.ambiguous || !/no active turn|no turn in progress/i.test(error.message)) throw error;
        this.activeTurns.delete(threadId);
      }
    }
    const result = await this.request('turn/start', { threadId, input, ...turnOptions(command) });
    if (result.turn?.id) this.activeTurns.set(threadId, result.turn.id);
    return { threadId, delivery: 'native', status: 'sent', ...result };
  }
  async interrupt(command) {
    await this.connect();
    const turnId = command.turnId || this.activeTurns.get(command.threadId);
    if (!turnId) throw new Error('这条桌面对话当前没有运行中的回合。');
    return this.request('turn/interrupt', { threadId: command.threadId, turnId });
  }
  disconnect(cause) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      const error = new Error(cause.message); error.ambiguous = MUTATING.has(request.method);
      request.reject(error);
    }
    this.pending.clear(); this.ready = null;
    if (this.connected) { this.connected = false; this.emit('connection', false); }
  }
  close() {
    const socket = this.socket; this.socket = null;
    this.disconnect(new Error('桌面原生连接已关闭。')); socket?.destroy();
  }
}

export { readFrames };
