import { spawn } from 'node:child_process';
import { writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentRun, defaultRunsDirectory } from './agent-runs.mjs';

const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Run the official CLI's tool loop. Authentication remains in Claude Code's
// user settings/apiKeyHelper; the router does not read or copy credentials.
export async function runClaudeAgent({ resolved, task, system = '', mode, cwd, signal, sessionId, effort, runId: requestedRunId, parentRunId, sourceThreadId }) {
  const provider = resolved.provider;
  const command = provider.command || process.env.CLAUDE_DELEGATE_COMMAND || 'claude';
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    throw new Error('Claude Code 请配置原生 claude.exe 路径，避免通过 shell 转义任务参数。');
  }
  if (sessionId && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(sessionId)) {
    throw new Error('Claude Code session_id 必须是会话 UUID。');
  }
  const effectiveEffort = effort || provider.effort || 'max';
  if (!EFFORTS.includes(effectiveEffort)) throw new Error('无效的 Claude Code effort。');
  signal?.throwIfAborted();
  const effectiveCwd = path.resolve(cwd || provider.cwd || process.env.MODEL_DELEGATE_DEFAULT_CWD || process.cwd());
  const run = new AgentRun({ directory: provider.runsDirectory || defaultRunsDirectory(), id: requestedRunId, request: {
    model: resolved.id, alias: resolved.alias, mode, cwd: effectiveCwd, effort: effectiveEffort,
    task, resumeSessionId: sessionId || null, parentRunId,
    sourceThreadId: sourceThreadId === undefined ? process.env.CODEX_THREAD_ID || null : sourceThreadId
  } });
  const runId = run.state.id;
  const proofDirectory = run.directory;
  const settingsPath = path.join(proofDirectory, 'settings.json');
  // Do not recursively start the parent's MCP servers or run unrelated hooks.
  await writeFile(settingsPath, JSON.stringify({ disableAllHooks: true }));
  const tools = mode === 'implement' ? 'Read,Glob,Grep,Write,Edit,Bash' : 'Read,Glob,Grep';
  const args = [
    ...(provider.args || []), '-p', '--output-format', 'stream-json', '--verbose',
    '--model', resolved.id, '--effort', effectiveEffort,
    '--permission-mode', mode === 'implement' ? 'acceptEdits' : 'dontAsk',
    '--permission-prompts', 'none', '--tools', tools, '--allowedTools', tools,
    '--strict-mcp-config', '--settings', settingsPath,
    ...(sessionId ? ['--resume', sessionId] : []),
    ...(Number.isInteger(provider.maxTurns) && provider.maxTurns > 0 ? ['--max-turns', String(provider.maxTurns)] : [])
  ];
  const state = { actualModel: '', sessionId: '', result: null, toolUses: [] };
  let stderr = '';
  let failure = null;
  let failureState = 'failed';
  let logQueue = Promise.resolve();
  let child;
  let stopping = false;
  let recordedBytes = 0;
  const record = (name, data) => {
    logQueue = logQueue.then(() => appendFile(path.join(proofDirectory, name), data))
      .catch(() => { failure ||= new Error('无法保存 Claude Code 执行记录。'); stop(); });
  };
  const stop = () => {
    if (stopping || !child?.pid || child.exitCode !== null) return;
    stopping = true;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } else child.kill('SIGKILL');
  };
  const parseLine = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { failure ||= new Error('Claude Code 返回了无效 stream-json。'); stop(); return; }
    try { run.consume(event); } catch (error) { failure ||= error; stop(); }
    // Token-count heartbeats can arrive hundreds of times per second. Track
    // their liveness without filling the raw journal with per-token records.
    if (!(event.type === 'system' && event.subtype === 'thinking_tokens')) {
      recordedBytes += Buffer.byteLength(line);
      if (recordedBytes > MAX_STREAM_BYTES) { failure ||= new Error('Claude Code 输出超过 32 MiB。'); stop(); return; }
      record('events.jsonl', line + '\n');
    }
    if (event.type === 'system' && event.subtype === 'init') {
      state.actualModel = event.model || '';
      state.sessionId = event.session_id || '';
    }
    if (event.type === 'assistant') {
      for (const item of event.message?.content || []) {
        if (item.type === 'tool_use') state.toolUses.push({ name: item.name, id: item.id });
      }
    }
    if (event.type === 'result') {
      state.result = event;
      state.sessionId = event.session_id || state.sessionId;
    }
  };
  const timeoutMs = Number.isInteger(provider.timeoutMs) && provider.timeoutMs > 0 ? provider.timeoutMs : 600_000;
  const abort = () => { failure ||= new Error('Claude Code 调用已取消。'); failureState = 'cancelled'; stop(); };
  let timer;
  let heartbeat;
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child = spawn(command, args, { cwd: effectiveCwd, env: { ...process.env, ...(provider.env || {}) }, windowsHide: true, shell: false });
      let buffer = '';
      child.once('spawn', () => { try { run.launched(child.pid); } catch (error) { failure ||= error; stop(); } });
      timer = setTimeout(() => { failure ||= new Error(`Claude Code 超过 ${timeoutMs}ms 未完成。`); failureState = 'timed_out'; stop(); }, timeoutMs);
      timer.unref();
      heartbeat = setInterval(() => {
        try {
          run.heartbeat();
          const cancellation = run.cancelRequest();
          if (cancellation && !stopping) { failure ||= new Error(cancellation.reason || '用户停止了 CC 任务。'); failureState = 'cancelled'; stop(); }
        } catch (error) { failure ||= error; stop(); }
      }, 1000);
      heartbeat.unref();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure ||= error; });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_STREAM_BYTES) { failure ||= new Error('Claude Code 单条输出超过 32 MiB。'); stop(); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          parseLine(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk).slice(-16_000);
      });
      child.once('error', reject);
      child.once('close', code => { if (buffer) parseLine(buffer); resolve(code); });
      const workspaceInstructions = `Working directory (native path): ${effectiveCwd}\nUse relative paths inside this workspace for file tools. Keep edits here unless the task explicitly authorizes another location. Do not translate POSIX shell paths into native file-tool paths. If a tool denies permission, report the denial rather than trying to bypass it. Use code/CLI checks for validation; leave browser and desktop interaction to the parent agent's UI tools.`;
      child.stdin.end(`${workspaceInstructions}\n\n${system ? `${system}\n\n` : ''}任务：\n${task}`);
    });
  } catch (error) {
    failure ||= new Error(`无法启动 Claude Code：${error.message}`);
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', abort);
  }
  await logQueue;
  if (stderr) await writeFile(path.join(proofDirectory, 'stderr.txt'), stderr);
  if (!failure && exitCode !== 0) failure = new Error(state.result?.result || stderr.trim() || `Claude Code 退出（${exitCode}）。`);
  if (!failure && !state.result) failure = new Error('Claude Code 未返回最终 result，不能确认成功。');
  if (!failure && (state.result.is_error !== false || state.result.subtype !== 'success')) {
    failure = new Error(state.result.result || state.result.errors?.join('; ') || 'Claude Code 报告任务失败。');
  }
  if (!failure && !state.sessionId) failure = new Error('Claude Code 未返回 session ID。');
  if (!failure && !state.result.result?.trim()) failure = new Error('Claude Code 返回了空答案。');
  const result = {
    text: state.result?.result || '', rawModel: state.actualModel || resolved.id,
    usage: state.result?.usage || null, sessionId: state.sessionId,
    runId, proofDirectory, toolUses: state.toolUses,
    permissionDenials: state.result?.permission_denials || [],
    durationMs: state.result?.duration_ms ?? null
  };
  await writeFile(path.join(proofDirectory, 'result.json'), JSON.stringify({
    ...result, success: !failure, exitCode, finishedAt: new Date().toISOString(),
    ...(failure ? { error: failure.message } : {})
  }, null, 2));
  run.finish(failure ? failureState : 'completed', failure?.message);
  if (failure) throw new Error(`${failure.message}\n执行记录：${proofDirectory}`);
  return result;
}
