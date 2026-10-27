import path from 'node:path';
import { readRunJson, writeRunJson, displayText } from './agent-runs.mjs';
import { loadModelRouterConfig, delegateToAgent, listConfiguredModels } from './model-router.mjs';

const directory = path.resolve(process.argv[2]);
try {
  const job = readRunJson(path.join(directory, 'job.json'));
  if (!job) throw new Error('子代理任务不存在。');
  const config = await loadModelRouterConfig(job.configFile);
  // The shared store is selected by the caller, even in isolated test configs.
  const entry = listConfiguredModels(config).find(model => model.alias === job.model && model.execution === 'claude-cli');
  if (!entry) throw new Error('这个任务没有有效的 CC 执行器配置。');
  config.providers[entry.provider].runsDirectory = path.dirname(directory);
  await delegateToAgent({ config, model: job.model, task: job.task, cwd: job.cwd, mode: job.mode, sessionId: job.sessionId, runId: job.requestId, parentRunId: job.parentRunId, sourceThreadId: job.sourceThreadId ?? null });
} catch (error) {
  const file = path.join(directory, 'status.json'), status = readRunJson(file);
  if (status && !['completed', 'failed', 'cancelled', 'timed_out'].includes(status.state)) writeRunJson(file, { ...status, state: 'failed', error: displayText(error.message), finishedAt: Date.now() });
  process.exitCode = 1;
}
