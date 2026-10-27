import { readFile } from 'node:fs/promises';
import { delegateToAgent, loadModelRouterConfig } from '../src/model-router.mjs';

// Standalone entry point for an already-running Codex conversation. No MCP or
// desktop restart is needed. Task text goes through a file and then stdin.
try {
  const args = process.argv.slice(2);
  const options = {};
  const allowed = new Set(['model', 'task-file', 'mode', 'cwd', 'session-id', 'effort', 'config']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.has(key) || !args[i + 1]) throw new Error(`无效参数：${args[i]}`);
    options[key] = args[i + 1];
  }
  if (!options.model || !options['task-file']) throw new Error('需要 --model 和 --task-file。可选 --mode review|implement --cwd 目录 --session-id UUID --effort max');
  const config = await loadModelRouterConfig(options.config);
  const result = await delegateToAgent({
    config, model: options.model, task: await readFile(options['task-file'], 'utf8'),
    mode: options.mode || 'review', cwd: options.cwd, sessionId: options['session-id'], effort: options.effort
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
