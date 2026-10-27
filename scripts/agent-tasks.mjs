import { readFile } from 'node:fs/promises';
import { AgentTasks } from '../src/agent-tasks.mjs';

try {
  const [command, ...args] = process.argv.slice(2), options = {};
  let id;
  const allowed = new Set(['model', 'task-file', 'cwd', 'mode', 'source-thread', 'request-id', 'config', 'runs-dir']);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--') && !id) { id = args[i]; continue; }
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || !allowed.has(key) || !args[i + 1]) throw new Error(`无效参数：${args[i]}`);
    options[key] = args[++i];
  }
  const tasks = new AgentTasks({ directory: options['runs-dir'], configFile: options.config });
  let result;
  if (command === 'list') result = { runs: tasks.runs.list(), models: await tasks.models() };
  else if (command === 'status') result = tasks.runs.get(id);
  else if (command === 'show') result = tasks.runs.details(id);
  else if (command === 'stop') result = tasks.runs.stop(id, '主代理通过委派入口停止了此 CC 任务。');
  else if (command === 'start' || command === 'continue') {
    if (!options['task-file']) throw new Error('需要 --task-file，任务文本通过 UTF-8 文件传递。');
    const task = await readFile(options['task-file'], 'utf8');
    const body = { task, requestId: options['request-id'], sourceThreadId: options['source-thread'] || process.env.CODEX_THREAD_ID };
    result = command === 'continue' ? await tasks.continue(id, body) : await tasks.start({ ...body, model: options.model || 'cc-deepseek-flash', cwd: options.cwd, mode: options.mode || 'review' });
  } else throw new Error('用法：agent-tasks.mjs start --task-file 文件 --cwd 目录 [--mode implement] | status UUID | show UUID | stop UUID | continue UUID --task-file 文件 | list');
  if (!result) throw new Error('任务不存在。');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
