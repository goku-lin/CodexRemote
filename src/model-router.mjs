import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { projectRoot } from './layout.mjs';
import { runClaudeAgent } from './claude-agent.mjs';

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const MAX_TASK_CHARS = 200_000;

function defaultWorkingDirectory() {
  return process.env.MODEL_DELEGATE_DEFAULT_CWD || process.cwd();
}

function childLaunch(command) {
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  return {
    command: shell && /\s/.test(command) ? `"${command.replaceAll('"', '\\"')}"` : command,
    shell
  };
}

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function configPath() {
  return process.env.MODEL_DELEGATE_CONFIG || path.join(
    process.env.CODEX_RELAY_DATA_DIR || path.join(projectRoot, '.relay-data'),
    'model-providers.json'
  );
}

export async function loadModelRouterConfig(file = configPath()) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`模型路由配置不存在：${file}。请复制 model-providers.example.json 并填写 Provider 配置。`);
    }
    throw new Error(`模型路由配置无法读取：${error.message}`);
  }
  if (!raw || typeof raw !== 'object' || !raw.providers || typeof raw.providers !== 'object') {
    throw new Error('模型路由配置必须包含 providers 对象。');
  }
  return { ...raw, file };
}

function modelEntries(config) {
  const entries = [];
  for (const [providerName, provider] of Object.entries(config.providers || {})) {
    if (!provider || typeof provider !== 'object' || provider.enabled===false) continue;
    for (const [alias, model] of Object.entries(provider.models || {})) {
      const descriptor = typeof model === 'string' ? { id: model } : model;
      if (!descriptor?.id) continue;
      entries.push({
        alias,
        id: descriptor.id,
        provider: providerName,
        label: descriptor.label || alias,
        protocol: descriptor.protocol || provider.protocol || 'openai-chat',
        execution: descriptor.execution || provider.execution || 'api',
        contextWindow: descriptor.contextWindow,
        maxOutputTokens: descriptor.maxOutputTokens,
        route: descriptor.route || descriptor.modelRoute || provider.route || provider.modelRoute
      });
    }
  }
  return entries;
}

export function listConfiguredModels(config) {
  return modelEntries(config);
}

export function resolveModel(config, requested) {
  const name = typeof requested === 'string' ? requested.trim() : '';
  if (!name) throw new Error('必须提供要调用的模型名。');
  const match = modelEntries(config).find(item => item.alias === name || item.id === name);
  if (!match) throw new Error(`未配置模型“${name}”。可用模型：${modelEntries(config).map(item => item.alias).join(', ') || '无'}`);
  const provider = config.providers[match.provider];
  const apiKeyEnv = provider.apiKeyEnv || (match.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : null);
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : null;
  if (match.execution === 'api' && !apiKey) throw new Error(`模型“${name}”需要环境变量 ${apiKeyEnv || '对应的 API key'}。`);
  return { ...match, provider: { ...provider, apiKey } };
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(item => item?.type === 'text' || item?.type === 'output_text')
    .map(item => item.text || '').join('');
}

async function requestJson(url, init, providerName) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(120_000) });
  } catch (error) {
    throw new Error(`${providerName} 请求失败：${error.message}`);
  }
  const body = await response.text();
  let data;
  try { data = body ? JSON.parse(body) : {}; }
  catch { throw new Error(`${providerName} 返回了无效 JSON（HTTP ${response.status}）。`); }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
    throw new Error(`${providerName} 请求被拒绝：${message}`);
  }
  return data;
}

async function callOpenAIChat(resolved, task, system, maxOutputTokens, signal) {
  const base = cleanBaseUrl(resolved.provider.baseUrl || 'https://api.openai.com/v1');
  const data = await requestJson(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${resolved.provider.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: resolved.id,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: task }
      ],
      max_tokens: maxOutputTokens
    })
  }, resolved.providerName || resolved.provider.name || 'OpenAI-compatible Provider');
  const text = textFromContent(data.choices?.[0]?.message?.content);
  if (!text.trim()) throw new Error('Provider 返回了空答案。');
  return { text, usage: data.usage || null, rawModel: data.model || resolved.id };
}

async function callAnthropic(resolved, task, system, maxOutputTokens, signal) {
  const base = cleanBaseUrl(resolved.provider.baseUrl || 'https://api.anthropic.com');
  const data = await requestJson(`${base}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': resolved.provider.apiKey,
      'anthropic-version': resolved.provider.anthropicVersion || '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: resolved.id,
      max_tokens: maxOutputTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: task }]
    })
  }, resolved.providerName || 'Anthropic');
  const text = textFromContent(data.content);
  if (!text.trim()) throw new Error('Provider 返回了空答案。');
  return { text, usage: data.usage || null, rawModel: data.model || resolved.id };
}

export async function delegateToModel({ config, model, task, system = '', maxOutputTokens, signal }) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('task 必须是非空文本。');
  if (task.length > MAX_TASK_CHARS) throw new Error(`task 太长，最多支持 ${MAX_TASK_CHARS} 个字符。`);
  const resolved = resolveModel(config, model);
  if (resolved.execution !== 'api') throw new Error(`模型“${model}”是外部执行器，请使用对应的 Agent 工具。`);
  resolved.providerName = resolved.provider.name || resolved.provider;
  const limit = Number.isInteger(maxOutputTokens) && maxOutputTokens > 0
    ? Math.min(maxOutputTokens, resolved.maxOutputTokens || 65_536)
    : Math.min(resolved.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS, 65_536);
  const protocol = resolved.protocol.toLowerCase();
  if (protocol === 'anthropic') return callAnthropic(resolved, task, system, limit, signal);
  if (protocol === 'openai-chat' || protocol === 'openai-compatible') {
    return callOpenAIChat(resolved, task, system, limit, signal);
  }
  throw new Error(`暂不支持 Provider 协议“${resolved.protocol}”。`);
}

function parseCodexLine(line, state) {
  if (!line.trim()) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
    state.answer = event.item.text;
  }
  if (event.type === 'turn.completed' && event.usage) state.usage = event.usage;
  if (event.type === 'item.completed' && event.item?.type === 'error') state.error = event.item.message || state.error;
}

async function runCodexAgent(resolved, task, system, mode, signal, cwd) {
  const provider = resolved.provider;
  const command = provider.command || process.env.CODEX_DELEGATE_COMMAND || 'codex';
  const sandbox = mode === 'implement' ? (provider.implementSandbox || 'workspace-write') : (provider.reviewSandbox || 'read-only');
  const prompt = system ? `${system}\n\n任务：\n${task}` : task;
  const sandboxArgs = mode === 'implement' && provider.allowDangerousSandboxBypass
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['-s', sandbox];
  const args = [
    ...(provider.args || []), 'exec', '--json', '--ephemeral', '--skip-git-repo-check',
    ...sandboxArgs, '-m', resolved.id, '-'
  ];
  const state = { answer: '', usage: null, error: '' };
  const timeoutMs = Number.isInteger(provider.timeoutMs) && provider.timeoutMs > 0 ? provider.timeoutMs : 600_000;
  let isolatedHome = null;
  if (provider.modelProvider) {
    if (!resolved.provider.apiKey) throw new Error(`模型“${resolved.alias}”需要 API key 才能启动独立 Codex 子代理。`);
    isolatedHome = await mkdtemp(path.join(tmpdir(), 'codex-delegator-'));
    const baseUrl = provider.baseUrl || 'https://api.deepseek.com/';
    const wireApi = provider.wireApi || 'responses';
    const effort = provider.modelReasoningEffort || 'high';
    const toml = [
      `model = ${JSON.stringify(resolved.id)}`,
      `model_provider = ${JSON.stringify(provider.modelProvider)}`,
      `model_reasoning_effort = ${JSON.stringify(effort)}`,
      'approval_policy = "never"',
      '',
      `[model_providers.${provider.modelProvider}]`,
      `name = ${JSON.stringify(provider.name || provider.modelProvider)}`,
      `base_url = ${JSON.stringify(baseUrl)}`,
      `wire_api = ${JSON.stringify(wireApi)}`,
      `experimental_bearer_token = ${JSON.stringify(resolved.provider.apiKey)}`,
      ''
    ].join('\n');
    await writeFile(path.join(isolatedHome, 'config.toml'), toml, { mode: 0o600 });
  }
  return await new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...(provider.env || {}) };
    // A child must use its own app-server, not the Relay's native proxy or
    // endpoint. Otherwise a nested Codex invocation can attach to the parent
    // Desktop process and never produce an independent turn.
    for (const key of ['CODEX_CLI_PATH', 'CODEX_RELAY_DATA_DIR', 'CODEX_RELAY_NATIVE_ENDPOINT', 'CODEX_RELAY_PARENT_PIPE']) delete childEnv[key];
    if (isolatedHome) childEnv.CODEX_HOME = isolatedHome;
    const launch = childLaunch(command);
    const child = spawn(launch.command, args, {
      cwd: cwd || provider.cwd || defaultWorkingDirectory(),
      env: childEnv,
      windowsHide: true,
      shell: launch.shell
    });
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (isolatedHome) void rm(isolatedHome, { recursive: true, force: true });
      if (error) reject(error); else resolve(result);
    };
    const abort = () => { child.kill(); finish(new Error('子代理调用已取消。')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`子代理超过 ${timeoutMs}ms 未完成。`)); }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(prompt);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        parseCodexLine(buffer.slice(0, end), state);
        buffer = buffer.slice(end + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 12_000) stderr = stderr.slice(-12_000); });
    child.on('error', error => finish(new Error(`无法启动子代理：${error.message}`)));
    child.on('close', code => {
      if (buffer) parseCodexLine(buffer, state);
      if (code !== 0) return finish(new Error(state.error || stderr.trim() || `子代理退出（${code}）。`));
      if (!state.answer.trim()) return finish(new Error(state.error || '子代理没有返回最终答案。'));
      finish(null, { text: state.answer, usage: state.usage, rawModel: resolved.id });
    });
  });
}

function dshRoute(resolved) {
  const route = String(resolved.route || '').trim();
  if (!route) return null;
  const slash = route.indexOf('/');
  if (slash < 1 || slash === route.length - 1) throw new Error(`DSH 模型路由必须使用 provider/model 格式：${route}`);
  return { provider: route.slice(0, slash), model: route.slice(slash + 1) };
}

function dshPatch(route, reuseCredentials) {
  if (!route && !reuseCredentials) return '';
  const rows = [];
  if (route) rows.push(`- id: agent-default-model\n  config:\n    provider: ${JSON.stringify(route.provider)}\n    model: ${JSON.stringify(route.model)}`);
  if (reuseCredentials) {
    // The headless profile disables these rows. Enabling them in a temporary
    // overlay lets DSH reuse its own saved account/key without modifying the
    // user's persistent profile.
    rows.push('- id: authorization\n  disabled: false');
    rows.push('- id: credentials\n  disabled: false');
    if (route?.provider === 'deepseek-account') rows.push('- id: deepseek-account\n  disabled: false');
  }
  return `${rows.join('\n')}\n`;
}

async function runDshAgent(resolved, task, system, mode, signal, cwd) {
  const provider = resolved.provider;
  const command = provider.command || process.env.DSH_COMMAND || 'dsh';
  const profile = provider.profile || 'headless';
  const prompt = system ? `${system}\n\n任务：\n${task}` : task;
  const route = dshRoute(resolved);
  const reuseCredentials = provider.reuseCredentials !== false;
  const patchText = dshPatch(route, reuseCredentials);
  let overlayDir = null;
  let overlayPath = null;
  if (patchText) {
    overlayDir = await mkdtemp(path.join(tmpdir(), 'dsh-delegator-'));
    overlayPath = path.join(overlayDir, 'route.cordis.yml');
    await writeFile(overlayPath, patchText, { encoding: 'utf8', mode: 0o600 });
  }
  const args = [
    ...(provider.args || []),
    '--profile', profile,
    ...(overlayPath ? ['--patch', overlayPath] : [])
  ];
  const state = { stdout: '', stderr: '' };
  const timeoutMs = Number.isInteger(provider.timeoutMs) && provider.timeoutMs > 0 ? provider.timeoutMs : 600_000;
  const effectiveCwd = cwd || provider.cwd || defaultWorkingDirectory();
  return await new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...(provider.env || {}) };
    childEnv.DSH_PERMISSION_MODE = mode === 'implement'
      ? (provider.implementPermissionMode || 'workspace-write')
      : (provider.reviewPermissionMode || 'read-only');
    const launch = childLaunch(command);
    const child = spawn(launch.command, args, {
      cwd: effectiveCwd,
      env: childEnv,
      windowsHide: true,
      shell: launch.shell
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (overlayDir) void rm(overlayDir, { recursive: true, force: true });
      if (error) reject(error); else resolve(result);
    };
    const abort = () => { child.kill(); finish(new Error('DSH 子代理调用已取消。')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`DSH 子代理超过 ${timeoutMs}ms 未完成。`)); }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(prompt);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      state.stdout += chunk;
      if (state.stdout.length > 256_000) state.stdout = state.stdout.slice(-256_000);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      state.stderr += chunk;
      if (state.stderr.length > 16_000) state.stderr = state.stderr.slice(-16_000);
    });
    child.on('error', error => finish(new Error(`无法启动 DSH 子代理：${error.message}`)));
    child.on('close', code => {
      const text = state.stdout.trim();
      if (code !== 0) return finish(new Error(state.stderr.trim() || `DSH 子代理退出（${code}）。`));
      if (!text) return finish(new Error(state.stderr.trim() || 'DSH 子代理没有返回最终答案。'));
      finish(null, { text, usage: null, rawModel: route ? `${route.provider}/${route.model}` : resolved.id });
    });
  });
}

export async function delegateToAgent({ config, model, task, system = '', mode = 'review', cwd, signal, sessionId, effort, runId, parentRunId, sourceThreadId }) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('task 必须是非空文本。');
  if (task.length > MAX_TASK_CHARS) throw new Error(`task 太长，最多支持 ${MAX_TASK_CHARS} 个字符。`);
  if (!['review', 'implement'].includes(mode)) throw new Error('mode 只能是 review 或 implement。');
  const resolved = resolveModel(config, model);
  if (resolved.execution === 'claude-cli') return runClaudeAgent({ resolved, task, system, mode, signal, cwd, sessionId, effort, runId, parentRunId, sourceThreadId });
  if (sessionId || effort) throw new Error('session_id 和 effort 当前仅支持 Claude Code 执行器。');
  if (resolved.execution === 'dsh-cli') return runDshAgent(resolved, task, system, mode, signal, cwd);
  if (resolved.execution !== 'codex-cli') throw new Error(`模型“${model}”没有配置为完整编码子代理。`);
  return runCodexAgent(resolved, task, system, mode, signal, cwd);
}
