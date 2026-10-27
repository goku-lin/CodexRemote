import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AgentRuns, defaultRunsDirectory, displayText, readRunJson, validRunId, writeRunJson, insideDirectory } from './agent-runs.mjs';
import { loadModelRouterConfig, listConfiguredModels } from './model-router.mjs';
import { sourceDir, projectRoot } from './layout.mjs';
import { HtmlPreviewReader, previewHeaders } from './html-preview.mjs';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const types = { '.html': 'text/html', '.htm': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.css': 'text/css', '.json': 'application/json' };

export class AgentTasks {
  constructor({ directory = defaultRunsDirectory(), configFile = process.env.MODEL_DELEGATE_CONFIG || path.join(projectRoot, '.relay-data', 'model-providers.json') } = {}) {
    this.runs = new AgentRuns(directory);
    this.configFile = configFile;
    this.preview = new HtmlPreviewReader();
  }
  async models() {
    try { return listConfiguredModels(await loadModelRouterConfig(this.configFile)).filter(model => model.execution === 'claude-cli').map(({ alias, id, label }) => ({ alias, id, label })); }
    catch { return []; }
  }
  async start({ model = 'cc-deepseek-flash', task, cwd, mode = 'review', sessionId, parentRunId, sourceThreadId, requestId = randomUUID() }) {
    if (typeof task !== 'string' || !task.trim() || task.length > 200_000) throw failure('请输入 1–200000 字符的任务。');
    if (!['review', 'implement'].includes(mode) || !validRunId(requestId)) throw failure('任务模式或请求编号无效。');
    if (sessionId && !validRunId(sessionId)) throw failure('CC 会话编号无效。');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw failure('请选择已存在的绝对工作目录。');
    let config;
    try { config = await loadModelRouterConfig(this.configFile); }
    catch { throw failure('本机 CC 模型配置无法读取，请在本机检查委派配置。'); }
    const entry = listConfiguredModels(config).find(item => item.alias === model && item.execution === 'claude-cli');
    if (!entry) throw failure('这个模型没有配置为 Claude Code 执行器。');
    const job = { requestId, model, task, cwd: path.resolve(cwd), mode, sessionId, parentRunId, sourceThreadId };
    const fingerprint = createHash('sha256').update(JSON.stringify(job)).digest('hex');
    const directory = this.runs.path(requestId);
    fs.mkdirSync(this.runs.directory, { recursive: true });
    try { fs.mkdirSync(directory); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = readRunJson(path.join(directory, 'job.json'));
      if (old?.fingerprint !== fingerprint) throw failure('这个请求编号已经用于另一项任务。', 409);
      return { run: this.runs.get(requestId), duplicate: true };
    }
    // Reserve the ID before launching. The worker alone owns the CC process.
    writeRunJson(path.join(directory, 'job.json'), { ...job, fingerprint, configFile: this.configFile });
    const queued = { id: requestId, alias: model, model: entry.id, execution: 'claude-cli', state: 'queued', cwd: job.cwd, mode, title: displayText(task.trim().split('\n')[0], 100), sessionId: sessionId || null, parentRunId: parentRunId || null, sourceThreadId: sourceThreadId || null, createdAt: Date.now(), activeTools: [], toolCallCount: 0 };
    writeRunJson(path.join(directory, 'status.json'), queued);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(sourceDir, 'agent-task-worker.mjs'), directory], {
        cwd: projectRoot, detached: true, windowsHide: true, stdio: 'ignore',
        env: { ...process.env, MODEL_DELEGATE_RUNS_DIR: this.runs.directory }
      });
      child.once('error', error => {
        writeRunJson(path.join(directory, 'status.json'), { ...queued, state: 'failed', error: displayText(error.message), finishedAt: Date.now() });
        reject(error);
      });
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return { run: this.runs.get(requestId), duplicate: false };
  }
  async continue(id, body) {
    const previous = this.runs.get(id);
    if (!previous?.sessionId) throw failure('这个任务没有可续聊的 CC 会话。');
    const duplicate = validRunId(body.requestId) && readRunJson(path.join(this.runs.path(body.requestId), 'job.json'));
    if (!duplicate && this.runs.list().some(run => run.sessionId === previous.sessionId && (run.active || run.state === 'unknown'))) throw failure('这个 CC 会话仍在执行或状态待核实，请先等待或停止任务。', 409);
    return this.start({ ...body, model: previous.alias, cwd: previous.cwd, mode: previous.mode, sessionId: previous.sessionId, parentRunId: id, sourceThreadId: previous.sourceThreadId });
  }
  async artifact(id, artifactId, resource) {
    const selected = this.runs.files(id).find(file => file.id === artifactId);
    if (!selected) throw failure('产物不存在或不在这个任务的工作目录内。', 404);
    let file = selected.file;
    if (['.html', '.htm'].includes(path.extname(file).toLowerCase())) {
      const manifest = await this.preview.manifest(file);
      if (!manifest.allowed.has(resource)) throw failure('资源没有出现在这个产物中。', 404);
      file = await fs.promises.realpath(path.resolve(manifest.root, resource));
      if (!insideDirectory(manifest.root, file)) throw failure('产物资源超出目录。', 403);
    } else if (resource !== path.basename(file)) throw failure('产物资源不存在。', 404);
    const info = await fs.promises.stat(file);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw failure('产物过大或不是文件。');
    return { body: await fs.promises.readFile(file), mime: types[path.extname(file).toLowerCase()] || 'text/plain', name: path.basename(file), headers: { ...previewHeaders, 'x-content-type-options': 'nosniff' } };
  }
}
