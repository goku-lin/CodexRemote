import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { projectRoot } from './layout.mjs';

export const terminalRunStates = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);
export const validRunId = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
export const defaultRunsDirectory = () => process.env.MODEL_DELEGATE_RUNS_DIR || path.join(process.env.CODEX_RELAY_DATA_DIR || path.join(projectRoot, '.relay-data'), 'agent-runs');
export const insideDirectory = (root, file) => {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};
export function readRunJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function writeRunJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
export function displayText(value, limit = 6000) {
  const text = String(value ?? '').replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[密钥已隐藏]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]{12,}/gi, '$1[凭据已隐藏]');
  return text.length > limit ? text.slice(0, limit) + '\n…（已截断）' : text;
}
const alive = pid => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const textContent = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(item => item.type === 'text').map(item => item.text || '').join('\n') : '';
const artifactTypes = new Set(['.html', '.htm', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.txt', '.md', '.js', '.mjs', '.cjs', '.css', '.json']);

export class AgentRun {
  constructor({ directory, id = randomUUID(), request }) {
    if (!validRunId(id)) throw new Error('无效的子代理任务编号。');
    this.directory = path.join(directory, id);
    fs.mkdirSync(this.directory, { recursive: true });
    const previous = readRunJson(path.join(this.directory, 'status.json'));
    if (!previous && readRunJson(path.join(this.directory, 'request.json'))) throw new Error('任务编号已使用。');
    if (previous && previous.state !== 'queued') throw new Error('任务编号已使用。');
    const lock = fs.openSync(path.join(this.directory, 'owner.lock'), 'wx', 0o600);
    fs.closeSync(lock);
    this.request = { ...request, runId: id, startedAt: new Date().toISOString() };
    writeRunJson(path.join(this.directory, 'request.json'), this.request);
    this.sequence = 0;
    this.lastFlush = 0;
    this.state = {
      id, execution: 'claude-cli', model: request.model, alias: request.alias,
      cwd: request.cwd, mode: request.mode, effort: request.effort,
      title: displayText(request.task?.trim().split('\n')[0] || 'CC 任务', 100),
      parentRunId: request.parentRunId || null, sourceThreadId: request.sourceThreadId || null,
      state: 'starting', createdAt: previous?.createdAt || Date.now(),
      ownerPid: process.pid, childPid: null, sessionId: request.resumeSessionId || null,
      heartbeatAt: Date.now(), lastEventAt: null, lastModelAt: null,
      toolCallCount: 0, activeTools: [], files: [], sequence: 0
    };
    if (request.resumeSessionId) this.lockSession(request.resumeSessionId);
    this.event({ kind: 'task', text: displayText(request.task, 16000) });
    this.flush(true);
  }
  flush(force = false) {
    const now = Date.now();
    if (!force && now - this.lastFlush < 700) return;
    writeRunJson(path.join(this.directory, 'status.json'), { ...this.state, updatedAt: now });
    this.lastFlush = now;
  }
  patch(values, force = false) { Object.assign(this.state, values); this.flush(force); }
  event(values) {
    const event = { ...values, sequence: ++this.sequence, at: Date.now() };
    this.state.sequence = this.sequence;
    this.state.lastEventAt = event.at;
    fs.appendFileSync(path.join(this.directory, 'timeline.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
    this.flush();
  }
  launched(pid) { this.patch({ childPid: pid, state: 'connecting' }, true); }
  heartbeat() { this.patch({ heartbeatAt: Date.now() }, true); }
  cancelRequest() { return readRunJson(path.join(this.directory, 'cancel.json')); }
  lockSession(sessionId) {
    if (!validRunId(sessionId) || this.sessionLock) return;
    const file = path.join(path.dirname(this.directory), `session-${sessionId}.lock`);
    try {
      const old = readRunJson(file);
      if (old) {
        const status = readRunJson(path.join(path.dirname(this.directory), old.runId, 'status.json'));
        if (alive(old.pid) && status && !terminalRunStates.has(status.state)) throw new Error('同一 CC 会话仍在执行，请等待或停止原任务。');
        fs.unlinkSync(file);
      }
      const handle = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, runId: this.state.id }));
      fs.closeSync(handle);
      this.sessionLock = file;
    } catch (error) { if (error.code === 'EEXIST') throw new Error('同一 CC 会话刚刚开始执行，请先查询任务状态。'); throw error; }
  }
  consume(event) {
    if (event.type === 'system' && event.subtype === 'init') {
      this.lockSession(event.session_id);
      this.patch({ sessionId: event.session_id || this.state.sessionId, model: event.model || this.state.model }, true);
      this.event({ kind: 'connected', text: 'CC 已启动，等待模型回应。' });
    }
    if (event.type === 'system' && event.subtype === 'thinking_tokens') {
      this.patch({ lastModelAt: Date.now(), state: this.state.activeTools.length ? 'tools' : 'responding' });
      return;
    }
    if (event.type === 'assistant') {
      this.patch({ lastModelAt: Date.now(), state: 'responding' });
      for (const item of event.message?.content || []) {
        if (item.type === 'text' && item.text?.trim()) this.event({ kind: 'assistant', text: displayText(item.text, 16000) });
        if (item.type !== 'tool_use') continue;
        const file = item.input?.file_path;
        if (['Write', 'Edit'].includes(item.name) && typeof file === 'string') {
          const absolute = path.resolve(this.state.cwd, file);
          if (insideDirectory(this.state.cwd, absolute) && !this.state.files.includes(absolute)) this.state.files.push(absolute);
        }
        const operation = { id: item.id, name: item.name, description: displayText(item.input?.description || file || item.input?.pattern || item.name, 500) };
        this.state.activeTools.push(operation);
        this.state.toolCallCount++;
        this.state.state = 'tools';
        this.event({ kind: 'tool_start', ...operation, command: item.name === 'Bash' ? displayText(item.input?.command, 3000) : undefined });
      }
    }
    if (event.type === 'user') for (const item of event.message?.content || []) {
      if (item.type !== 'tool_result') continue;
      const operation = this.state.activeTools.find(tool => tool.id === item.tool_use_id);
      this.state.activeTools = this.state.activeTools.filter(tool => tool.id !== item.tool_use_id);
      this.state.state = this.state.activeTools.length ? 'tools' : 'waiting_model';
      this.event({ kind: 'tool_result', id: item.tool_use_id, name: operation?.name || '工具', isError: Boolean(item.is_error), text: displayText(textContent(item.content)) });
    }
    if (event.type === 'result') {
      this.patch({ state: 'finishing', sessionId: event.session_id || this.state.sessionId, usage: event.usage || null }, true);
      this.event({ kind: 'result', isError: event.is_error, text: displayText(event.result, 16000) });
    }
  }
  finish(state, error = null) {
    // Release the session before publishing a terminal state. Otherwise an
    // immediate follow-up can race the old worker's lock-file cleanup.
    if (this.sessionLock) { try { if (readRunJson(this.sessionLock)?.runId === this.state.id) fs.unlinkSync(this.sessionLock); } catch {} this.sessionLock = null; }
    this.patch({ state, error: error ? displayText(error) : null, finishedAt: Date.now(), heartbeatAt: Date.now(), activeTools: [] }, true);
    this.event({ kind: 'finished', state, text: error ? displayText(error) : 'CC 任务已完成。' });
    this.flush(true);
  }
}

export class AgentRuns {
  constructor(directory = defaultRunsDirectory()) { this.directory = directory; this.legacyCache = new Map(); }
  path(id) { if (!validRunId(id)) throw new Error('无效的子代理任务编号。'); return path.join(this.directory, id); }
  get(id) {
    const dir = this.path(id), request = readRunJson(path.join(dir, 'request.json'));
    let status = readRunJson(path.join(dir, 'status.json'));
    if (!status && request) {
      const result = readRunJson(path.join(dir, 'result.json'));
      const verification = readRunJson(path.join(dir, 'parent-verification.json'));
      status = {
        id, execution: 'claude-cli', alias: 'cc-deepseek-flash', model: result?.rawModel || request.model,
        cwd: request.cwd, mode: request.mode, effort: request.effort, legacy: true,
        title: path.basename(request.cwd || '') || '历史 CC 任务', createdAt: Date.parse(request.startedAt),
        finishedAt: result?.finishedAt ? Date.parse(result.finishedAt) : null,
        sessionId: result?.sessionId || null, toolCallCount: result?.toolUses?.length || 0,
        state: verification?.cliStatus === 'stopped_by_parent_after_artifact_generation' ? 'cancelled' : result ? result.success ? 'completed' : 'failed' : 'unknown',
        error: verification?.cliStatus === 'stopped_by_parent_after_artifact_generation' ? '主代理已停止后续自查，生成的产物已保留。' : displayText(result?.error || ''),
        usage: result?.usage || null, activeTools: [], sequence: 0
      };
    }
    if (!status) return null;
    const now = Date.now(), terminal = terminalRunStates.has(status.state);
    const ownerAlive = !terminal && alive(status.ownerPid);
    if (!terminal && status.ownerPid && !ownerAlive) status = { ...status, state: 'interrupted', error: '执行器进程已经退出，没有收到最终完成结果。' };
    return {
      ...status, ownerAlive, active: status.state !== 'unknown' && !terminalRunStates.has(status.state),
      stopRequested: !terminal && fs.existsSync(path.join(dir, 'cancel.json')),
      heartbeatStale: !terminal && now - (status.heartbeatAt || status.createdAt) > 15_000,
      waitingLong: !terminal && ['connecting', 'waiting_model', 'responding'].includes(status.state) && now - (status.lastModelAt || status.createdAt) > 30_000,
      elapsedMs: Math.max(0, (status.finishedAt || now) - status.createdAt)
    };
  }
  list() {
    let ids; try { ids = fs.readdirSync(this.directory).filter(validRunId); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return ids.map(id => { try { return this.get(id); } catch { return null; } }).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  }
  legacyEvents(id) {
    const file = path.join(this.path(id), 'events.jsonl');
    let info; try { info = fs.statSync(file); } catch { return []; }
    const signature = `${info.size}:${info.mtimeMs}`, previous = this.legacyCache.get(id);
    if (previous?.signature === signature) return previous.events;
    if (info.size > 40 * 1024 * 1024) return [];
    const events = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant') for (const item of event.message?.content || []) {
          if (item.type === 'text') events.push({ kind: 'assistant', text: displayText(item.text, 16000) });
          if (item.type === 'tool_use') events.push({ kind: 'tool_start', id: item.id, name: item.name, file: item.input?.file_path, description: displayText(item.input?.description || item.input?.file_path || item.name, 500), command: item.name === 'Bash' ? displayText(item.input?.command, 3000) : undefined });
        }
        if (event.type === 'user') for (const item of event.message?.content || []) if (item.type === 'tool_result') events.push({ kind: 'tool_result', id: item.tool_use_id, isError: Boolean(item.is_error), text: displayText(textContent(item.content)) });
        if (event.type === 'result') events.push({ kind: 'result', isError: Boolean(event.is_error), text: displayText(event.result, 16000) });
      } catch {}
    }
    this.legacyCache.set(id, { signature, events });
    while (this.legacyCache.size > 10) this.legacyCache.delete(this.legacyCache.keys().next().value);
    return events;
  }
  files(id) {
    const status = this.get(id); if (!status?.cwd) return [];
    let root; try { root = fs.realpathSync(status.cwd); } catch { return []; }
    const candidates = new Set(status.files || []);
    if (status.legacy) for (const event of this.legacyEvents(id)) if (event.file && ['Write', 'Edit'].includes(event.name)) candidates.add(path.resolve(status.cwd, event.file));
    const recorded = new Set([...candidates].map(file => { try { return fs.realpathSync(file); } catch { return file; } }));
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true }).slice(0, 500)) {
        if (!entry.isFile() || !artifactTypes.has(path.extname(entry.name).toLowerCase())) continue;
        const file = path.join(root, entry.name), info = fs.statSync(file);
        if (info.mtimeMs >= status.createdAt - 2000 && !['task.txt', 'received.json'].includes(entry.name)) candidates.add(file);
      }
    } catch {}
    const files = [];
    for (const candidate of candidates) {
      try {
        const file = fs.realpathSync(candidate), relative = path.relative(root, file), info = fs.statSync(file);
        if (!insideDirectory(root, file) || !info.isFile() || !artifactTypes.has(path.extname(file).toLowerCase()) || /(^|[\\/])\.|(?:credentials|api.?key|secret)/i.test(relative) || info.size > 16 * 1024 * 1024) continue;
        files.push({ id: createHash('sha256').update(relative).digest('hex').slice(0, 24), name: relative.replaceAll(path.sep, '/'), size: info.size, updatedAt: info.mtimeMs, source: recorded.has(file) ? 'tool_record' : 'recent_file', file });
      } catch {}
    }
    return files.slice(0, 100);
  }
  details(id) {
    const status = this.get(id); if (!status) return null;
    const request = readRunJson(path.join(this.path(id), 'request.json'));
    const timeline = path.join(this.path(id), 'timeline.jsonl');
    let events = [];
    if (fs.existsSync(timeline)) {
      const size = fs.statSync(timeline).size;
      const handle = fs.openSync(timeline, 'r');
      try {
        const offset = Math.max(0, size - 2 * 1024 * 1024), buffer = Buffer.alloc(size - offset);
        fs.readSync(handle, buffer, 0, buffer.length, offset);
        events = buffer.toString('utf8').split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).slice(-200);
      } finally { fs.closeSync(handle); }
    } else events = this.legacyEvents(id).slice(-200);
    let task = request?.task;
    if (!task && status.legacy) { try { const file = path.join(status.cwd, 'task.txt'); if (fs.statSync(file).size <= 200_000) task = fs.readFileSync(file, 'utf8'); } catch {} }
    return { status, task: displayText(task || '', 16000), events, files: this.files(id).map(({ file, ...item }) => item) };
  }
  stop(id, reason = '用户从任务面板停止了此任务。') {
    const status = this.get(id); if (!status) throw new Error('任务不存在。');
    if (!status.active) return status;
    writeRunJson(path.join(this.path(id), 'cancel.json'), { at: Date.now(), reason: displayText(reason, 500) });
    return { ...status, stopRequested: true };
  }
}
