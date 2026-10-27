import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentTasks } from '../src/agent-tasks.mjs';
import { AgentRun, AgentRuns, readRunJson, writeRunJson } from '../src/agent-runs.mjs';
import { activityMessage } from '../public/agent-tasks.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(100); }
  throw new Error('Timed out waiting for test worker.');
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-tasks-test-'));
  const cwd = path.join(root, 'workspace'); await fs.mkdir(cwd);
  const script = path.join(root, 'fake-cc.cjs'), session = randomUUID();
  await fs.writeFile(script, `
    const fs = require('node:fs');
    const args = process.argv.slice(2); let prompt = '';
    process.stdin.setEncoding('utf8').on('data', chunk => prompt += chunk);
    const emit = event => process.stdout.write(JSON.stringify(event)+'\\n');
    process.stdin.on('end', () => {
      const session = args.includes('--resume') ? args[args.indexOf('--resume')+1] : '${session}';
      emit({ type:'system', subtype:'init', model:'mock-deepseek', session_id:session });
      emit({ type:'system', subtype:'thinking_tokens', tokens:12 });
      if (prompt.includes('HANG')) { setInterval(() => emit({ type:'system', subtype:'thinking_tokens', tokens:20 }), 200); return; }
      emit({ type:'assistant', message:{ content:[{ type:'tool_use', id:'write-1', name:'Write', input:{ file_path:'drawing.svg', content:'test' } }] } });
      fs.writeFileSync('drawing.svg', '<svg xmlns="http://www.w3.org/2000/svg"><circle r="20"/></svg>');
      emit({ type:'user', message:{ content:[{ type:'tool_result', tool_use_id:'write-1', content:'Written', is_error:false }] } });
      setTimeout(() => {
        emit({ type:'assistant', message:{ content:[{ type:'text', text:'Created drawing.svg' }] } });
        emit({ type:'result', subtype:'success', is_error:false, session_id:session, result:'Completed', usage:{ input_tokens:10, output_tokens:12 } });
      }, 250);
    });
  `);
  const configFile = path.join(root, 'providers.json');
  await fs.writeFile(configFile, JSON.stringify({ providers: { cc: { execution: 'claude-cli', command: process.execPath, args: [script], timeoutMs: 20000, models: { 'cc-deepseek-flash': { id: 'mock-deepseek', label: 'Mock CC' } } } } }));
  const tasks = new AgentTasks({ directory: path.join(root, 'runs'), configFile });
  t.after(async () => {
    for (const run of tasks.runs.list()) if (run.active) tasks.runs.stop(run.id);
    await until(() => !tasks.runs.list().some(run => run.active));
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, cwd, tasks, session, configFile };
}

test('background CC jobs produce live state, tool results, artifacts, and resumable native sessions', async t => {
  const { tasks, cwd, session } = await fixture(t);
  const requestId = randomUUID(), body = { requestId, task: 'Draw a test', cwd, mode: 'implement' };
  const started = await tasks.start(body);
  assert.equal(started.run.id, requestId);
  const duplicate = await tasks.start(body);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(tasks.start({ ...body, task: 'different task' }), { status: 409 });
  const done = await until(() => { const run = tasks.runs.get(requestId); return run?.state === 'completed' && run; });
  assert.equal(done.sessionId, session);
  assert.equal(done.active, false);
  assert.equal(done.toolCallCount, 1);
  assert.ok(done.lastModelAt);
  const detail = tasks.runs.details(requestId);
  assert.equal(detail.events.find(event => event.kind === 'tool_result').text, 'Written');
  assert.equal(detail.files[0].name, 'drawing.svg');
  const artifact = await tasks.artifact(requestId, detail.files[0].id, 'drawing.svg');
  assert.equal(artifact.mime, 'image/svg+xml');
  assert.match(artifact.headers['content-security-policy'], /script-src 'none'/);
  await assert.rejects(tasks.artifact(requestId, detail.files[0].id, '../providers.json'));
  const continued = await tasks.continue(requestId, { requestId: randomUUID(), task: 'Continue this drawing' });
  const resumed = await until(() => { const run = tasks.runs.get(continued.run.id); if (run && !run.active && run.state !== 'completed') throw new Error(JSON.stringify(run)); return run?.state === 'completed' && run; });
  assert.equal(resumed.sessionId, session);
  assert.equal(resumed.parentRunId, requestId);
});

test('stop requests are acknowledged by the owning worker and active sessions cannot resume twice', async t => {
  const { tasks, cwd, session } = await fixture(t);
  const started = await tasks.start({ task: 'HANG until cancelled', cwd });
  const running = await until(() => { const run = tasks.runs.get(started.run.id); return run?.state === 'responding' && run; });
  assert.equal(running.sessionId, session);
  assert.equal(running.ownerAlive, true);
  assert.equal(running.heartbeatStale, false);
  await assert.rejects(tasks.continue(running.id, { requestId: randomUUID(), task: 'resume while active' }), { status: 409 });
  const request = tasks.runs.stop(running.id);
  assert.equal(request.stopRequested, true);
  const cancelled = await until(() => { const run = tasks.runs.get(running.id); return run?.state === 'cancelled' && run; });
  assert.equal(cancelled.active, false);
  assert.match(cancelled.error, /停止/);
  assert.equal(readRunJson(path.join(tasks.runs.path(running.id), 'result.json')).success, false);
});

test('status distinguishes long waits from dead owners and preserves stopped legacy artifacts', async t => {
  const { tasks, cwd } = await fixture(t);
  const id = randomUUID(), dir = tasks.runs.path(id); await fs.mkdir(dir, { recursive: true });
  writeRunJson(path.join(dir, 'status.json'), { id, ownerPid: process.pid, state: 'waiting_model', createdAt: Date.now() - 100000, heartbeatAt: Date.now(), lastModelAt: Date.now() - 45000, activeTools: [] });
  let status = tasks.runs.get(id);
  assert.equal(status.active, true); assert.equal(status.waitingLong, true); assert.equal(status.heartbeatStale, false);
  assert.match(activityMessage(status), /不能据此判断/);
  writeRunJson(path.join(dir, 'status.json'), { ...status, ownerPid: 2147483647 });
  status = tasks.runs.get(id); assert.equal(status.state, 'interrupted'); assert.equal(status.active, false);
  const legacyId = randomUUID(), legacy = tasks.runs.path(legacyId); await fs.mkdir(legacy);
  writeRunJson(path.join(legacy, 'request.json'), { model: 'mock-deepseek', cwd, startedAt: new Date().toISOString() });
  writeRunJson(path.join(legacy, 'result.json'), { success: false, error: 'misleading CLI stderr', finishedAt: new Date().toISOString() });
  writeRunJson(path.join(legacy, 'parent-verification.json'), { cliStatus: 'stopped_by_parent_after_artifact_generation' });
  assert.equal(tasks.runs.get(legacyId).state, 'cancelled');
  assert.match(tasks.runs.get(legacyId).error, /产物已保留/);
});

test('session locks protect direct CLI callers and release after completion', async t => {
  const { tasks, cwd, session } = await fixture(t), request = { task: 'test', cwd, model: 'mock', resumeSessionId: session };
  const one = new AgentRun({ directory: tasks.runs.directory, request });
  assert.throws(() => new AgentRun({ directory: tasks.runs.directory, request }), /同一 CC 会话/);
  one.finish('cancelled', 'test done');
  const two = new AgentRun({ directory: tasks.runs.directory, request });
  two.finish('completed');
});

test('artifact access excludes symlink escapes and sensitive files; UI text is redacted', async t => {
  const { tasks, cwd, root } = await fixture(t);
  const run = new AgentRun({ directory: tasks.runs.directory, request: { task: 'key sk-12345678901234567890', cwd, model: 'mock' } });
  await fs.writeFile(path.join(cwd, 'secret-api-key.json'), 'private');
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside');
  try { await fs.symlink(root, path.join(cwd, 'outside'), process.platform === 'win32' ? 'junction' : 'dir'); } catch {}
  run.state.files.push(path.join(cwd, 'secret-api-key.json'), path.join(cwd, 'outside', 'outside.txt'));
  run.finish('completed');
  assert.equal(tasks.runs.files(run.state.id).length, 0);
  assert.ok(!tasks.runs.details(run.state.id).task.includes('sk-12345678901234567890'));
});
